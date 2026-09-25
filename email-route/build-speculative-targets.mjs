// Batch 2: Munich-area companies that post ENGLISH-language roles, with the application
// address they publish. For unsolicited (speculative) applications. Read-only except
// for its own JSON output. Run from the project dir: node build-speculative-targets.mjs <scratchpad>
import { readFileSync, writeFileSync, existsSync } from 'fs';

const P = 'file:///C:/Users/PC/Downloads/career-ops-main/career-ops-main/';
const { loadProfile } = await import(P + 'agent/profile.mjs');
const { findApplicationEmail } = await import(P + 'find-application-email.mjs');

const S = process.argv[2];
const DAYS = Number((process.argv.find(a => a.startsWith('--days=')) || '--days=60').split('=')[1]);
const CONCURRENCY = 8;
const profile = loadProfile();

const loc = (profile.raw && profile.raw.location) || {};
const cities = [...(loc.preferred_cities || []), ...(loc.commutable_cities || []), 'munich', 'münchen', 'muenchen']
  .map(c => String(c).toLowerCase());
const stems = [...new Set(cities.flatMap(c => [c, c.replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ä/g, 'a').replace(/ß/g, 'ss')]))];
const cityRe = new RegExp(`(^|[^a-z])(${stems.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})([^a-z]|$)`, 'i');

// Same German-title markers daily-run.mjs uses to spot German-language postings.
const GERMAN_TITLE = new RegExp([
  '\\((?:m|w|d|x|i|g)\\s*[/|]\\s*(?:m|w|d|x|i|n)(?:\\s*[/|]\\s*(?:m|w|d|x|i|n))?\\)',
  '[äöüßÄÖÜ]',
  '\\b(mitarbeiter|sachbearbeit\\w*|kaufmann|kauffrau|kaufleute|fachkraft|fachwirt|betreuer\\w*|berater\\w*|referent\\w*|' +
  'assistenz|vertrieb\\w*|einkauf\\w*|buchhalt\\w*|personal\\w*|verwaltung\\w*|innendienst|aussendienst|geschäftsführ\\w*|' +
  'abteilung\\w*|bereich\\w*|schwerpunkt|quereinsteiger|werkstudent\\w*|praktikum|ausbildung|leiter\\w*)\\b',
].join('|'), 'i');
// Intermediaries: a speculative letter to a staffing agency is not an application to an employer.
const AGENCY = /personal|zeitarbeit|recruit|staffing|talent|hays|randstad|adecco|manpower|dis ag|engineering people|ferchau|robert half|michael page|jobster|instaffo|headhunt|gulp|amadeus fire|brunel|orizon|piening|job ?ag|arbeitnow|stepstone|indeed|linkedin/i;
// Roles that say nothing about what the company needs from an operations candidate.
const NOISE_ROLE = /engineer|developer|software|scientist|physician|nurse|driver|mechanic|electrician|technician|chef|cook/i;

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
const seen = new Map();
if (existsSync('data/scan-history.tsv')) {
  for (const line of readFileSync('data/scan-history.tsv', 'utf8').split(/\r?\n/)) {
    const url = line.split('\t').find(c => /^https?:\/\//.test(c));
    const date = (line.match(/\b(20\d\d-\d\d-\d\d)\b/) || [])[1];
    if (url && date) { const k = norm(url); if (!seen.has(k) || seen.get(k) < date) seen.set(k, date); }
  }
}
const cutoff = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);

const STOP = /\b(gmbh|ag|se|kg|co|mbh|inc|ltd|group|gruppe|deutschland|germany|holding|international|&)\b/gi;
const core = (c) => String(c).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(STOP, ' ').replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');

// Companies already applied to, or already covered by batch 1.
const history = JSON.parse(readFileSync('data/agent/applications.json', 'utf8'));
const exclude = new Set();
for (const r of history.filter(r => ['SUBMITTED', 'NEEDS_CHECK'].includes(r.status))) {
  const slug = (String(r.url).match(/companies\/([^/]+)\//) || [])[1];
  if (slug) exclude.add(core(slug.replace(/-/g, ' ')));
  const host = (String(r.final_url || r.url).match(/https?:\/\/(?:www\.)?(?:jobs\.ashbyhq\.com\/|job-boards\.(?:eu\.)?greenhouse\.io\/)?([a-z0-9-]+)/i) || [])[1];
  if (host) exclude.add(core(host.replace(/-/g, ' ')));
}
if (existsSync(`${S}/email-hits.json`)) for (const r of JSON.parse(readFileSync(`${S}/email-hits.json`, 'utf8')).filter(r => r.email)) exclude.add(core(r.company));

const companies = new Map();
for (const line of readFileSync('data/pipeline.md', 'utf8').split(/\r?\n/)) {
  if (!/^\s*[-*]\s*\[( |x|X)\]\s*https?:\/\//.test(line)) continue;
  const url = (line.match(/https?:\/\/[^\s)\]|]+/) || [])[0];
  const rest = line.replace(/^\s*[-*]\s*\[( |x|X)\]\s*/, '').replace(url, '').replace(/^[\s—–\-|]+/, '');
  const [company = '', role = ''] = rest.split(/\s*\|\s*/).map(s => s.trim());
  if (!company || /^(unknown|\?)$/i.test(company) || AGENCY.test(company)) continue;
  const date = seen.get(norm(url));
  if (date && date < cutoff) continue;
  if (!cityRe.test(`${url} ${company} ${role} ${rest}`.replace(/[-_/]/g, ' '))) continue;
  if (GERMAN_TITLE.test(role) || NOISE_ROLE.test(role)) continue;
  const key = core(company);
  if (!key || exclude.has(key)) continue;
  const c = companies.get(key) || { company, roles: new Set(), urls: [], latest: '' };
  c.roles.add(role);
  if (c.urls.length < 3) c.urls.push(url);
  if ((date || '') > c.latest) c.latest = date || c.latest;
  companies.set(key, c);
}
const list = [...companies.values()].map(c => ({ ...c, roles: [...c.roles].slice(0, 6) }))
  .sort((a, b) => b.roles.length - a.roles.length || String(b.latest).localeCompare(String(a.latest)));
console.log(`${list.length} English-posting Munich-area companies (last ${DAYS} days, agencies and already-applied excluded); looking up addresses`);

const results = [];
let done = 0;
async function worker(queue) {
  while (queue.length) {
    const c = queue.shift();
    let hit = null;
    try { hit = await findApplicationEmail(c.company, null, c.urls[0]); } catch { /* keep going */ }
    results.push({ ...c, email: hit?.email || null, source: hit?.source || null, context: hit?.context || null, emailScore: hit?.score ?? null });
    done++;
    if (hit) console.log(`  ✉  ${c.company.slice(0, 32).padEnd(32)} ${hit.email.padEnd(32)} ← ${String(hit.source).replace(/^https?:\/\/(www\.)?/, '').slice(0, 55)}`);
    if (done % 25 === 0) console.log(`  … ${done}/${list.length}`);
  }
}
const q = [...list];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(q)));
results.sort((a, b) => (b.email ? 1 : 0) - (a.email ? 1 : 0) || b.roles.length - a.roles.length);
writeFileSync(`${S}/speculative-hits.json`, JSON.stringify(results, null, 1));
const hits = results.filter(r => r.email);
console.log(`\n${hits.length} of ${results.length} companies publish an application address`);
for (const h of hits) console.log(`  ${h.company.slice(0, 30).padEnd(30)} ${h.email.padEnd(32)} roles: ${h.roles.slice(0, 3).join(' / ').slice(0, 90)}`);
