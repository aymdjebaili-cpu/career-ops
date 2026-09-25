// Build the candidate list for email applications. Run from the project dir.
// Same rules as discover.mjs (Munich area or remote, prefilter, fit >= min), plus the
// junior-only rule, BUT login-walled postings are kept: an email application does not
// need the portal. Read-only: writes one JSON file to the scratchpad.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';

const P = 'file:///C:/Users/PC/Downloads/career-ops-main/career-ops-main/';
const { loadProfile } = await import(P + 'agent/profile.mjs');
const { prefilter } = await import(P + 'prefilter-core.mjs');
const { scoreTitle, blockedSource } = await import(P + 'agent/fit.mjs');

const S = process.argv[2];
const DAYS = Number((process.argv.find(a => a.startsWith('--days=')) || '--days=21').split('=')[1]);
const MIN_FIT = Number((process.argv.find(a => a.startsWith('--min-fit=')) || '--min-fit=2.5').split('=')[1]);
const profile = loadProfile();

// ── location: Munich area or remote (same as discover.mjs) ─────────────────
const loc = (profile.raw && profile.raw.location) || {};
const cities = [...(loc.preferred_cities || []), ...(loc.commutable_cities || []), 'munich', 'münchen', 'muenchen', 'bavaria', 'bayern']
  .map(c => String(c).toLowerCase());
const stems = [...new Set(cities.flatMap(c => [c, c.replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ä/g, 'a').replace(/ß/g, 'ss')]))];
const cityRe = new RegExp(`(^|[^a-z])(${stems.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})([^a-z]|$)`, 'i');
const remoteRe = /\bremote\b|home[\s-]?office|homeoffice|\bhybrid\b|ortsunabh/i;

// ── first-seen dates from scan-history.tsv (any column that is a URL / a date) ──
// Keep the query string: some boards identify a posting ONLY by `?externalId=...`,
// so stripping it merges distinct jobs into one (32 compleet jobs collapsed to 1 on
// 2026-09-16). Only the fragment and tracking parameters are dropped. Defined here,
// above its first use: the scan-history map below must be keyed the same way as the
// lookups, or every date reads as unknown and the recency window stops working.
const TRACKING_PARAM = /^(utm_|ref$|referrer$|source$|fbclid$|gclid$|mc_cid$|mc_eid$)/i;
const norm = (u) => {
  try {
    const x = new URL(String(u));
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (TRACKING_PARAM.test(k)) x.searchParams.delete(k);
    x.hostname = x.hostname.replace(/^www\./, '');
    return x.toString().toLowerCase().replace(/\/$/, '');
  } catch {
    return String(u || '').replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
  }
};

const seen = new Map();
if (existsSync('data/scan-history.tsv')) {
  for (const line of readFileSync('data/scan-history.tsv', 'utf8').split(/\r?\n/)) {
    const cols = line.split('\t');
    const url = cols.find(c => /^https?:\/\//.test(c));
    const date = (line.match(/\b(20\d\d-\d\d-\d\d)\b/) || [])[1];
    if (url && date) {
      const k = norm(url);
      if (!seen.has(k) || seen.get(k) < date) seen.set(k, date);
    }
  }
}
const cutoff = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);

// ── history: never email a job already applied to ─────────────────────────
const history = JSON.parse(readFileSync('data/agent/applications.json', 'utf8'));
const applied = new Set(history.filter(r => ['SUBMITTED', 'NEEDS_CHECK'].includes(r.status)).flatMap(r => [norm(r.url), norm(r.final_url)]));

// ── companies that already have an email draft file ────────────────────────
const drafted = new Set();
for (const f of readdirSync('output').filter(f => /^email-.*\.md$/.test(f))) {
  const head = readFileSync('output/' + f, 'utf8').split(/\n---\n/)[0];
  const m = head.match(/^COMPANY:\s*(.+)$/m);
  if (m) drafted.add(m[1].trim().toLowerCase());
}

// ── walk pipeline.md (both pending and processed lines) ────────────────────
const out = new Map();
const counts = { lines: 0, old: 0, location: 0, prefilter: 0, fit: 0, junior: 0, applied: 0, drafted: 0, kept: 0 };
for (const line of readFileSync('data/pipeline.md', 'utf8').split(/\r?\n/)) {
  if (!/^\s*[-*]\s*\[( |x|X)\]\s*https?:\/\//.test(line)) continue;
  counts.lines++;
  const url = (line.match(/https?:\/\/[^\s)\]|]+/) || [])[0];
  const rest = line.replace(/^\s*[-*]\s*\[( |x|X)\]\s*/, '').replace(url, '').replace(/^[\s—–\-|]+/, '');
  const [company = '', role = ''] = rest.split(/\s*\|\s*/);
  const date = seen.get(norm(url)) || null;
  if (date && date < cutoff) { counts.old++; continue; }

  const hay = `${url} ${company} ${role} ${rest}`.replace(/[-_/]/g, ' ');
  if (!(cityRe.test(hay) || remoteRe.test(hay))) { counts.location++; continue; }
  const pf = prefilter({ title: role, company });
  if (pf.skip) { counts.prefilter++; continue; }
  const fit = scoreTitle(role, company, profile);
  if (fit.score < MIN_FIT) { counts.fit++; continue; }
  if (/\blead(er)?\b|\bprincipal\b|\bhead of\b|\bsenior\b|\bsr\.?\b/i.test(role)) { counts.junior++; continue; }
  if (/\bmanager/i.test(role) && !/\b(junior|associate|project|trainee|all levels|einstieg|berufseinst|werkstudent)/i.test(role)) { counts.junior++; continue; }
  if (applied.has(norm(url))) { counts.applied++; continue; }
  if (drafted.has(company.trim().toLowerCase())) { counts.drafted++; continue; }

  const key = `${company.trim().toLowerCase()}|${role.trim().toLowerCase().replace(/\s*\((m|w|d|f|x|all genders)[^)]*\)\s*/g, '')}`;
  const row = { url, company: company.trim(), role: role.trim(), fit: fit.score, reasons: fit.reasons, date, walled: !!blockedSource(url), processed: /\[(x|X)\]/.test(line) };
  const prev = out.get(key);
  if (!prev || (row.date || '') > (prev.date || '')) out.set(key, row);
}
const rows = [...out.values()].sort((a, b) => b.fit - a.fit || String(b.date).localeCompare(String(a.date)));
counts.kept = rows.length;
writeFileSync(`${S}/email-candidates.json`, JSON.stringify(rows, null, 1));
console.log(`window: first seen on/after ${cutoff} (${DAYS} days), fit >= ${MIN_FIT}`);
console.log(JSON.stringify(counts));
for (const r of rows.slice(0, 60)) {
  console.log(`${String(r.fit).padStart(4)}  ${String(r.date || '????-??-??')}  ${r.walled ? 'WALL' : '    '}  ${r.company.slice(0, 26).padEnd(26)}  ${r.role.slice(0, 60)}`);
}
if (rows.length > 60) console.log(`… ${rows.length - 60} more in email-candidates.json`);
