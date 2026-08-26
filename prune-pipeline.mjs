#!/usr/bin/env node
/**
 * prune-pipeline.mjs — re-apply the current filters to data/pipeline.md.
 *
 * The scanners filter at discovery time, so entries queued under older, looser
 * filters stay in "## Pendientes" forever and keep consuming the daily eval
 * budget. This re-tests every pending row against portals.yml as it stands now
 * and moves the failures to "## Procesadas" with status Discarded.
 *
 * Two passes:
 *   title    — the row's role against title_filter (positive/negative keywords)
 *   location — the row's HOST and URL slug against the country policy. A pending
 *              row records only "url | company | role", so there is no location
 *              field to test; the slug is the only signal available. It is used
 *              conservatively: a row is dropped only on positive evidence of
 *              being non-German (a UK board, or a foreign place name in the
 *              slug), never merely because nothing matched.
 *
 * Usage:
 *   node prune-pipeline.mjs --dry-run   # report only, write nothing (default)
 *   node prune-pipeline.mjs --apply     # actually move the failures
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';

const PORTALS_PATH = 'portals.yml';
const PIPELINE_PATH = 'data/pipeline.md';

const APPLY = process.argv.includes('--apply');

function readPipelineText() {
  let raw = readFileSync(PIPELINE_PATH);
  if (raw[0] === 0xFF && raw[1] === 0xFE) raw = Buffer.from(raw.toString('utf16le'));
  return raw.toString('utf8');
}

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const lower = (title || '').toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// Job boards that only ever list one country. arbeitnow runs a .co.uk sibling
// whose postings (Brighton, Rainham, Manchester) sat in the queue for weeks.
const FOREIGN_HOSTS = /(^|\.)(arbeitnow\.co\.uk|.*\.co\.uk|.*\.fr|.*\.es|.*\.it|.*\.nl|.*\.be|.*\.pl|.*\.dk|.*\.se|.*\.no|.*\.fi|.*\.ie|.*\.pt|.*\.ch|.*\.at)$/i;

// Non-German places that keep turning up in slugs. Only unambiguous ones — a
// name shared with a German town would cause real jobs to be discarded.
const FOREIGN_PLACES = new RegExp('\\b(' + [
  'london', 'manchester', 'birmingham', 'leeds', 'liverpool', 'bristol', 'brighton',
  'sheffield', 'nottingham', 'newcastle', 'glasgow', 'edinburgh', 'cardiff', 'belfast',
  'rainham', 'winnersh', 'slough', 'reading', 'oxford', 'cambridge', 'milton-keynes',
  'dublin', 'cork', 'amsterdam', 'rotterdam', 'utrecht', 'eindhoven', 'the-hague',
  'brussels', 'antwerp', 'ghent', 'paris', 'lyon', 'marseille', 'toulouse', 'bordeaux',
  'lille', 'nantes', 'madrid', 'barcelona', 'valencia', 'seville', 'malaga', 'bilbao',
  'lisbon', 'porto', 'milan', 'rome', 'turin', 'naples', 'bologna', 'florence',
  'vienna', 'graz', 'salzburg', 'innsbruck', 'zurich', 'geneva', 'basel', 'lausanne',
  'bern', 'lugano', 'copenhagen', 'aarhus', 'stockholm', 'gothenburg', 'malmo',
  'oslo', 'bergen', 'helsinki', 'tallinn', 'riga', 'vilnius', 'warsaw', 'krakow',
  'wroclaw', 'gdansk', 'poznan', 'prague', 'brno', 'bratislava', 'budapest',
  'bucharest', 'sofia', 'belgrade', 'zagreb', 'ljubljana', 'athens', 'thessaloniki',
  'istanbul', 'ankara', 'kyiv', 'moscow', 'dubai', 'tel-aviv', 'cairo',
  'bangalore', 'bengaluru', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai',
  'singapore', 'hong-kong', 'tokyo', 'seoul', 'shanghai', 'beijing', 'sydney',
  'melbourne', 'auckland', 'toronto', 'vancouver', 'montreal', 'new-york',
  'san-francisco', 'boston', 'chicago', 'austin', 'seattle', 'denver', 'atlanta',
  'los-angeles', 'miami', 'dallas', 'houston', 'sao-paulo', 'mexico-city',
].join('|') + ')\\b', 'i');

// The slug tail is where arbeitnow-style URLs put the city:
//   /jobs/companies/{co}/{role-words}-{city}-{id}
// Matching the whole path is fine because a role word is never a foreign city.
function looksForeign(url) {
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.host.replace(/^www\./, '');
    path = decodeURIComponent(u.pathname).toLowerCase().replace(/[_\s]+/g, '-');
  } catch { return false; }

  if (FOREIGN_HOSTS.test(host)) return { reason: `foreign board: ${host}` };
  const hit = path.match(FOREIGN_PLACES);
  if (hit) return { reason: `foreign location in URL: ${hit[1]}` };
  return false;
}

if (!existsSync(PORTALS_PATH) || !existsSync(PIPELINE_PATH)) {
  console.error('portals.yml or data/pipeline.md missing — nothing to do.');
  process.exit(1);
}

const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf8'));
const passesTitle = buildTitleFilter(cfg.title_filter);

const text = readPipelineText();
const lines = text.split('\n');

const today = new Date().toISOString().slice(0, 10);
const kept = [];
const dropped = [];

let inPending = false;
const outLines = [];
for (const ln of lines) {
  if (/^##\s+Pendientes/i.test(ln)) { inPending = true; outLines.push(ln); continue; }
  if (/^##\s+/.test(ln) && inPending) { inPending = false; outLines.push(ln); continue; }

  if (inPending) {
    const m = ln.match(/^-\s*\[\s*\]\s*(\S+)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/);
    if (m) {
      const [, url, company, role] = m;
      const foreign = looksForeign(url);
      if (foreign) { dropped.push({ url, company, role, why: foreign.reason }); }
      else if (!passesTitle(role)) { dropped.push({ url, company, role, why: null }); }
      else { kept.push({ url, company, role }); outLines.push(ln); }
      continue;
    }
  }
  outLines.push(ln);
}

console.log(`Pending before: ${kept.length + dropped.length}`);
console.log(`  keep:  ${kept.length}`);
console.log(`  drop:  ${dropped.length}  (fail the current title_filter or the country policy)`);

const reasons = {};
for (const d of dropped) {
  let key;
  if (d.why) {
    key = d.why;
  } else {
    const l = d.role.toLowerCase();
    const hit = (cfg.title_filter.negative || []).find(k => l.includes(k.toLowerCase()));
    key = hit ? `negative: ${hit}` : 'no positive keyword';
  }
  reasons[key] = (reasons[key] || 0) + 1;
}
console.log('\nTop drop reasons:');
Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(4)} × ${k}`));

if (!APPLY) {
  console.log('\n(dry run — pass --apply to write)');
  process.exit(0);
}

const procIdx = outLines.findIndex(l => /^##\s+Procesadas/i.test(l));
const entries = dropped.map(d =>
  `- [x] ${d.url} | ${d.company} | ${d.role} | Discarded | - | ❌ | - | pruned ${today}: ${d.why || 'fails current title_filter'}`
);
if (procIdx === -1) outLines.push('', '## Procesadas', '', ...entries);
else outLines.splice(procIdx + 1, 0, ...entries);

writeFileSync(PIPELINE_PATH, outLines.join('\n'), 'utf8');
console.log(`\n✅ moved ${dropped.length} entries to ## Procesadas`);
