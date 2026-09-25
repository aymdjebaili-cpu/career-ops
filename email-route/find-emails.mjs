// For each email-route candidate: dedupe, attach an existing report if one exists,
// and look up the application address the company itself publishes.
// Run from the project dir: node find-emails.mjs <scratchpad>. Never guesses an address.
import { readFileSync, writeFileSync, readdirSync } from 'fs';

const P = 'file:///C:/Users/PC/Downloads/career-ops-main/career-ops-main/';
const { findApplicationEmail } = await import(P + 'find-application-email.mjs');

const S = process.argv[2];
const CONCURRENCY = 6;
const rows = JSON.parse(readFileSync(`${S}/email-candidates.json`, 'utf8'));

// ── dedupe: same company core + same role, keep the first (best fit, newest) ──
const STOP = /\b(gmbh|ag|se|kg|co|mbh|inc|ltd|group|gruppe|deutschland|germany|holding|hotels?|resorts?|international|&)\b/gi;
const coreCompany = (c) => String(c).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(STOP, ' ').replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
const coreRole = (r) => String(r).toLowerCase().replace(/\((m|w|d|f|x|all genders|w\/m\/d|m\/w\/d|m\/f\/d|f\/m\/d)[^)]*\)/g, '')
  .replace(/[^a-z0-9äöüß ]+/g, ' ').replace(/\s+/g, ' ').trim();
const uniq = new Map();
for (const r of rows) {
  if (!r.company || /^unknown$/i.test(r.company)) continue;
  const k = coreCompany(r.company) + '|' + coreRole(r.role);
  if (!uniq.has(k)) uniq.set(k, r);
}
const jobs = [...uniq.values()];

// ── existing reports, by posting URL ────────────────────────────────────────
// Keep the query string: some boards identify a posting ONLY by `?externalId=...`,
// so stripping it merges distinct jobs into one (32 compleet jobs collapsed to 1 on
// 2026-09-16). Only the fragment and tracking parameters are dropped.
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
const reportByUrl = new Map();
for (const f of readdirSync('reports').filter(f => /^\d{3}-.+\.md$/.test(f))) {
  const head = readFileSync('reports/' + f, 'utf8').slice(0, 1500);
  const url = (head.match(/\*\*URL:\*\*\s*(\S+)/) || [])[1];
  const score = parseFloat((head.match(/\*\*Score:\*\*\s*([\d.]+)/) || [])[1]);
  if (url) reportByUrl.set(norm(url), { file: f, score: Number.isFinite(score) ? score : null });
}

console.log(`${rows.length} candidates → ${jobs.length} after dedupe; looking up published application addresses (${CONCURRENCY} at a time)`);
const results = [];
let done = 0;
async function worker(queue) {
  while (queue.length) {
    const job = queue.shift();
    let hit = null, error = null;
    try { hit = await findApplicationEmail(job.company, null, job.url); }
    catch (e) { error = e.message; }
    const rep = reportByUrl.get(norm(job.url)) || null;
    results.push({ ...job, email: hit?.email || null, source: hit?.source || null, context: hit?.context || null, emailScore: hit?.score ?? null, report: rep?.file || null, reportScore: rep?.score ?? null, error });
    done++;
    if (hit) console.log(`  ✉  ${job.company.slice(0, 30).padEnd(30)} ${hit.email.padEnd(34)} ← ${String(hit.source).replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}`);
    if (done % 10 === 0) console.log(`  … ${done}/${jobs.length} checked`);
  }
}
const queue = [...jobs];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

results.sort((a, b) => (b.email ? 1 : 0) - (a.email ? 1 : 0) || b.fit - a.fit);
writeFileSync(`${S}/email-hits.json`, JSON.stringify(results, null, 1));
const hits = results.filter(r => r.email);
console.log(`\n${hits.length} of ${results.length} jobs have a published application address`);
for (const r of hits) {
  console.log(`${String(r.fit).padStart(4)} ${r.walled ? 'WALL' : '    '} ${r.report ? 'REPORT ' + r.report.slice(0, 3) + ' (' + r.reportScore + ')' : 'no report   '}  ${r.company.slice(0, 26).padEnd(26)} ${r.role.slice(0, 44).padEnd(44)} ${r.email}`);
}
