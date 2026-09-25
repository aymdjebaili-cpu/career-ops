#!/usr/bin/env node
/**
 * build-agency-targets.mjs — Munich recruiting agencies that place COMMERCIAL staff.
 *
 * WHY A CURATED LIST AND NOT A MAP QUERY
 * OpenStreetMap knows 21 "employment agencies" in Munich and a third of those are Jobcenter
 * counters. The firms that actually place Sachbearbeiter, Customer Service and Operations
 * people are national Personaldienstleister with a Munich branch, and they are invisible to
 * a map query. So the list is named, and each address is then resolved from the agency's own
 * site by find-application-email.mjs, which only ever reports an address written on a page
 * it fetched. Nothing is constructed, and an agency that publishes none is skipped.
 *
 * SEGMENT
 * Two groups, deliberately: specialists in kaufmännische Positionen (Amadeus Fire, DIS,
 * Office People) and professional-search firms (Hays, Michael Page, Robert Half), plus the
 * large generalists that run commercial desks alongside industrial ones. Pure industrial
 * and logistics staffers are left out — from 2026-09-22 he wants full-time commercial work,
 * not warehouse, and writing to a Lager-only desk would invite exactly what he asked to stop.
 *
 * Usage:
 *   node email-route/build-agency-targets.mjs output/email-route [--resolve=60]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { findApplicationEmail } from '../find-application-email.mjs';

const S = process.argv[2] || 'output/email-route';
const RESOLVE = Number((process.argv.find(a => a.startsWith('--resolve=')) || '--resolve=60').split('=')[1]);
const OUT = `${S}/agency-targets.json`;

// name, domain, what they are. Domain is the hint find-application-email starts from.
const AGENCIES = [
  ['Amadeus Fire', 'amadeus-fire.de', 'kaufmännisch specialist'],
  ['DIS AG', 'dis-ag.com', 'kaufmännisch specialist'],
  ['Office People', 'office-people.de', 'kaufmännisch specialist'],
  ['Hays', 'hays.de', 'professional search'],
  ['Michael Page', 'michaelpage.de', 'professional search'],
  ['Page Personnel', 'pagepersonnel.de', 'professional search'],
  ['Robert Half', 'roberthalf.de', 'professional search'],
  ['Robert Walters', 'robertwalters.de', 'professional search'],
  ['Hofmann Personal', 'hofmann.info', 'generalist, commercial desk'],
  ['Randstad Deutschland', 'randstad.de', 'generalist, commercial desk'],
  ['Adecco', 'adecco.de', 'generalist, commercial desk'],
  ['Manpower', 'manpower.de', 'generalist, commercial desk'],
  ['Orizon', 'orizon.de', 'generalist, commercial desk'],
  ['Piening Personal', 'piening-personal.de', 'generalist, commercial desk'],
  ['Tempton', 'tempton.de', 'generalist, commercial desk'],
  ['persona service', 'persona.de', 'generalist, commercial desk'],
  ['Trenkwalder', 'trenkwalder.com', 'generalist, commercial desk'],
  ['Zeitconcept', 'zeitconcept.de', 'generalist, commercial desk'],
  ['Argo Personal', 'argo-personal.de', 'generalist'],
  ['Univativ', 'univativ.de', 'graduate + project staffing'],
  ['Brunel', 'brunel.de', 'engineering + commercial'],
  ['GULP', 'gulp.de', 'project staffing'],
  ['Bertrandt', 'bertrandt.com', 'engineering + commercial'],
  ['Sthree', 'sthree.com', 'professional search'],
  ['Nash Direct', 'nashdirect.de', 'professional search'],
  ['Pacura', 'pacura.de', 'generalist'],
  ['Aventa Personal', 'aventa-personal.de', 'generalist'],
  ['Talentscoutry', 'talentscoutry.de', 'Munich recruiter (OSM)'],
  ['Insight Recruitment', 'insight-recruitment.de', 'Munich recruiter (OSM)'],
  ['Yakabuna', 'yakabuna.de', 'Munich recruiter (OSM)'],
  ['Solid People', 'solidpeople.de', 'Munich recruiter (OSM)'],
  ['ahead personal', 'ahead-personal.com', 'Munich recruiter (OSM)'],
  ['GoTalent Munich', 'go-talent-munich.de', 'Munich recruiter (OSM)'],
];

const TLD = /\.(de|com|net|org|eu|at|ch|info|biz|io|jobs|group)$/i;
const looksReal = (e) => TLD.test(String(e).split('@')[1] || '');
const BAD_LOCAL = /^(no-?reply|noreply|donotreply|press|presse|newsletter|abuse|postmaster|webmaster|datenschutz|privacy|marketing|vertrieb|sales)/i;

mkdirSync(S, { recursive: true });

// Never write to an inbox this system has already written to, in any campaign.
const alreadyMailed = new Set();
for (const f of readdirSync('output')) {
  if (!/^email-.*\.md$/.test(f)) continue;
  const to = readFileSync(`output/${f}`, 'utf8').match(/^TO:\s*(\S+)/m);
  if (to) alreadyMailed.add(to[1].toLowerCase());
}

/**
 * find-application-email only accepts an address that scores as an APPLICATION inbox
 * (bewerbung@, karriere@, a "Bewerbung an …" sentence). That is right for an employer and
 * wrong for a recruiting agency: an agency's whole business is receiving CVs, so its
 * published general inbox is the front door, and most publish nothing more specific
 * because they want you in their portal. So when the scorer finds nothing, read the
 * agency's own Kontakt/Impressum page and take the address it prints there — still
 * published by them, never constructed.
 */
const GENERAL_OK = /^(info|kontakt|contact|office|mail|muenchen|münchen|munich|bewerbung|karriere|jobs|hello|hallo)@/i;
async function publishedContact(domain) {
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept-Language': 'de-DE,de;q=0.9' };
  for (const path of ['/impressum', '/kontakt', '/contact', '/']) {
    for (const host of [`https://www.${domain}`, `https://${domain}`]) {
      try {
        const r = await fetch(host + path, { headers: UA, redirect: 'follow' });
        if (!r.ok) continue;
        const text = await r.text();
        const found = [...new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/gi) || [])]
          .map(e => e.toLowerCase())
          .filter(e => e.endsWith(domain.replace(/^www\./, '')) && !BAD_LOCAL.test(e) && looksReal(e));
        const pick = found.find(e => GENERAL_OK.test(e)) || found[0];
        if (pick) return { email: pick, source: host + path };
      } catch { /* try the next one */ }
    }
  }
  return null;
}

const targets = [];
let resolved = 0, none = 0, mailed = 0, viaContact = 0;
for (const [name, domain, kind] of AGENCIES) {
  if (resolved >= RESOLVE) break;
  resolved++;
  let hit = await findApplicationEmail(name, domain, null).catch(() => null);
  if (!hit?.email) { hit = await publishedContact(domain); if (hit) viaContact++; }
  const email = hit?.email?.toLowerCase();
  if (!email || !looksReal(email) || BAD_LOCAL.test(email)) {
    none++;
    console.log(`   —  ${name.padEnd(24)} publishes no usable address`);
    continue;
  }
  if (alreadyMailed.has(email)) { mailed++; console.log(`   ↪  ${name.padEnd(24)} already written to (${email})`); continue; }
  targets.push({ name, domain, kind, email, source: hit.source || domain });
  console.log(`   ✓  ${name.padEnd(24)} ${email}`);
}

writeFileSync(OUT, JSON.stringify(targets, null, 1));
console.log(`\n${targets.length} agency target(s) → ${OUT}`);
console.log(`${none} publish nothing usable, ${mailed} already written to, ${resolved} looked up (${viaContact} from a Kontakt/Impressum page)`);
