#!/usr/bin/env node
/**
 * build-hospitality-targets.mjs — every hotel, hostel, guest house and travel agency in
 * the Munich area, with the address they publish for contact.
 *
 * WHY THIS EXISTS
 * The posting-driven routes are bounded by what employers happen to advertise this week.
 * Hospitality is the one sector where Aimene has real standing — hospitality operations
 * since December 2024, and his own travel agency in Algiers — and Munich has hundreds of
 * hotels and agencies that never post on a job board at all. Asking them directly is the
 * only way to reach them, and it is the classic German Initiativbewerbung.
 *
 * WHERE THE DATA COMES FROM
 * OpenStreetMap via the Overpass API — open data, no scraping of anyone's site, no key.
 * An address comes either from the place's own OSM contact tag or from its website's
 * Impressum (legally required in Germany) via find-application-email.mjs, which only ever
 * reports an address literally written on a page it fetched. Nothing is ever constructed.
 *
 * Usage:
 *   node email-route/build-hospitality-targets.mjs output/email-route
 *   node email-route/build-hospitality-targets.mjs output/email-route --resolve=150
 *   node email-route/build-hospitality-targets.mjs output/email-route --refresh   # re-query OSM
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { findApplicationEmail } from '../find-application-email.mjs';

const S = process.argv[2] || 'output/email-route';
const arg = (n, d) => Number((process.argv.find(a => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1]);
const RESOLVE = arg('resolve', 120);
const REFRESH = process.argv.includes('--refresh');
const RAW = `${S}/.osm-hospitality.json`;
const OUT = `${S}/hospitality-targets.json`;

// Munich and the ring of suburbs he can reach by S-Bahn.
const BBOX = '48.03,11.30,48.28,11.78';
const QUERY = `[out:json][timeout:180];
(
  nwr["tourism"~"^(hotel|hostel|guest_house)$"](${BBOX});
  nwr["shop"="travel_agency"](${BBOX});
  nwr["office"="travel_agent"](${BBOX});
);
out tags center;`;

async function overpass() {
  const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'career-ops personal job search' },
        body: 'data=' + encodeURIComponent(QUERY),
      });
      const text = await r.text();
      if (!text.trim().startsWith('{')) { console.log(`   ${new URL(ep).host}: ${r.status} — ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120)}`); continue; }
      return JSON.parse(text).elements || [];
    } catch (e) { console.log(`   ${new URL(ep).host}: ${String(e.message).slice(0, 80)}`); }
  }
  return [];
}

mkdirSync(S, { recursive: true });
let elements;
if (!REFRESH && existsSync(RAW)) {
  elements = JSON.parse(readFileSync(RAW, 'utf8'));
  console.log(`${elements.length} places from the cached OSM extract (--refresh to re-query)`);
} else {
  console.log('querying OpenStreetMap…');
  elements = await overpass();
  writeFileSync(RAW, JSON.stringify(elements));
  console.log(`${elements.length} places`);
}

// Addresses that bounced are worse than unknown: the business is unreachable AND counted
// as already contacted, so it would never be tried again. Three Munich hotels bounced on
// 2026-09-16 because their OpenStreetMap address was stale. Treat a bounced address as if
// the place published none, which sends the builder to the Impressum for a working one.
const bounced = new Set();
const REPLIES = `${S}/replies.json`;
if (existsSync(REPLIES)) {
  for (const r of JSON.parse(readFileSync(REPLIES, 'utf8'))) {
    if (r.kind !== 'BOUNCE') continue;
    for (const m of String(r.text).match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []) {
      if (!/djebaili|gmail\.com|googlemail/i.test(m)) bounced.add(m.toLowerCase());
    }
  }
}

// Never write to an inbox this system has already written to, for any campaign.
const alreadyMailed = new Set();
for (const f of readdirSync('output')) {
  if (!/^email-.*\.md$/.test(f)) continue;
  const to = readFileSync(`output/${f}`, 'utf8').match(/^TO:\s*(\S+)/m);
  if (to) alreadyMailed.add(to[1].toLowerCase());
}

const TLD = /\.(de|com|net|org|eu|at|ch|info|biz|io|jobs|online|shop|bayern|hotel|reisen|gmbh|email|travel|muenchen|berlin)$/i;
const looksReal = (e) => TLD.test(String(e).split('@')[1] || '');
// A reservations desk is a real mailbox and the only one most small hotels publish; a
// no-reply or a press address is not somewhere an application should land.
// A reservations desk answers with a booking autoresponder and never forwards an
// application — Hotel Vier Jahreszeiten replied to one with its room-booking hours on
// 2026-09-16. Those mailboxes are worse than useless here: the letter is burned and the
// business is then marked as already written to.
const BAD_LOCAL = /^(no-?reply|noreply|donotreply|press|presse|newsletter|abuse|postmaster|webmaster|datenschutz|privacy|marketing|reservation|reservierung|booking|buchung|bankett|veranstaltung|event|spa|restaurant|frontoffice|rezeption)/i;
// If a business publishes a careers mailbox, that is the one to write to.
const CAREERS_LOCAL = /^(job|jobs|bewerbung|bewerbungen|karriere|career|careers|hr|personal|recruiting|ausbildung|team)/i;

const seen = new Map();
const targets = [];
let fromOsm = 0, fromSite = 0, noSite = 0, resolved = 0, dup = 0, mailed = 0;

// Places with their own email cost nothing; do them first so a budgeted run always
// produces targets even if every website lookup fails.
const ranked = [...elements].sort((a, b) => {
  const has = (e) => Number(Boolean(e.tags?.email || e.tags?.['contact:email']));
  return has(b) - has(a);
});

for (const el of ranked) {
  const t = el.tags || {};
  const name = (t.name || '').trim();
  if (!name) continue;
  const kind = t.shop === 'travel_agency' || t.office === 'travel_agent' ? 'agency' : (t.tourism || 'hotel');
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (seen.has(key)) { dup++; continue; }
  seen.set(key, true);

  const website = t.website || t['contact:website'] || t.url || '';
  let email = (t.email || t['contact:email'] || '').split(';')[0].trim();
  let via = 'osm';

  if (email && (!looksReal(email) || BAD_LOCAL.test(email) || bounced.has(email.toLowerCase()))) email = '';
  if (email) fromOsm++;

  // An info@ address reaches someone, but a careers mailbox reaches the right someone, so
  // the website is still worth a look when OSM only gave us the general one.
  const generic = email && !CAREERS_LOCAL.test(email);
  if (!email || generic) {
    if (!website) { if (!email) { noSite++; continue; } }
    else if (resolved < RESOLVE) {
      resolved++;
      const hit = await findApplicationEmail(name, website, null).catch(() => null);
      const better = hit?.email && looksReal(hit.email) && !BAD_LOCAL.test(hit.email)
        && !bounced.has(hit.email.toLowerCase())
        && (!email || CAREERS_LOCAL.test(hit.email));
      if (better) { email = hit.email; via = 'impressum'; fromSite++; }
    }
    if (!email) continue;
  }

  if (alreadyMailed.has(email.toLowerCase())) { mailed++; continue; }

  targets.push({
    name, kind, email, via, website,
    street: [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' '),
    city: t['addr:city'] || 'München',
    district: t['addr:suburb'] || t['addr:city'] || '',
    stars: t.stars || '',
    lat: el.lat || el.center?.lat, lon: el.lon || el.center?.lon,
  });
}

writeFileSync(OUT, JSON.stringify(targets, null, 1));
const byKind = {};
for (const t of targets) byKind[t.kind] = (byKind[t.kind] || 0) + 1;

console.log(`\naddress from OSM        : ${fromOsm}`);
console.log(`address from Impressum  : ${fromSite}  (${resolved} website lookups spent of ${RESOLVE})`);
console.log(`no website, no address  : ${noSite}`);
console.log(`duplicate names skipped : ${dup}`);
console.log(`already written to      : ${mailed}`);
console.log(`\n${targets.length} target(s) → ${OUT}   ${JSON.stringify(byKind)}`);
for (const t of targets.slice(0, 12)) {
  console.log(`  ${t.kind === 'agency' ? 'RB' : 'HO'} ${t.name.slice(0, 34).padEnd(36)} ${t.email.slice(0, 34).padEnd(36)} ${t.via}`);
}
if (targets.length > 12) console.log(`  … ${targets.length - 12} more`);
