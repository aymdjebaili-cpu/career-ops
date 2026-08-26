#!/usr/bin/env node
/**
 * test-queue-order.mjs — regression test for the evaluation queue.
 *
 * Two properties matter and they pull against each other:
 *   1. no single job board may eat the daily budget (round-robin across sources)
 *   2. German-marked postings go last, because ~3% of them clear the bar
 *
 * The second must never turn into "German postings are dropped", and must never
 * misfire on an English title that merely comes from a German company.
 *
 * Usage: node test-queue-order.mjs
 */

import { looksGerman, pickAcrossSources } from './daily-run.mjs';

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  if (got === want) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// ── 1. Language detection ─────────────────────────────────────────────
console.log('\nlooksGerman — real titles from the run log');

// These wasted the 2026-08-11 budget: 24 of 29 worker failures were (m/w/d).
for (const role of [
  'Operations Manager (m/w/d)',
  'Account Manager (m/w/d) Automotive',
  'Trainee (m/w/d) für Quereinsteiger',
  'Junior Datenschutzkoordinator (m/w/d)',
  'Digital Forensic Analyst (m/w/x)',
  'Customer Service Agent — Fraud Management (w/m/x)',
  'Tourismusfachkraft - Amerika-Spezialist (w/m/d)',
  'Vertriebsmitarbeiter / Account Manager (m/w/d)',
  'Sachbearbeitung Tourismus / Wirtschaftsförderung (m/w/d)',
  'Mitarbeiter Vertrieb / Business Development',
  '(Junior) Firmenkundenbetreuer (m/w/d)',
]) check(`German: "${role}"`, looksGerman({ role }), true);

// These are the ones that actually score — they must not be pushed to the back.
for (const role of [
  'Commercial Operations Coordinator',
  'Business Development Representative - SMB',
  'Strategy & Operations Intern - Ops Focus',
  'Sales Development Representative Outbound (d/f/m)',
  'Quality Assurance Specialist (m/f/d)',
  'Growth Associate - Bank & Lending',
  'Indirect Procurement Manager – Operations (All genders)',
  'Deployment Specialist',
  "Founder's Associate",
  'Junior Account Executive',
]) check(`not German: "${role}"`, looksGerman({ role }), false);

// ── 2. Queue order ────────────────────────────────────────────────────
console.log('\npickAcrossSources — budget allocation');

const mk = (host, role, n) =>
  Array.from({ length: n }, (_, i) => ({ url: `https://${host}/job/${role}-${i}`, role, company: host }));

// The shape of the real backlog: one huge German board plus a few English ones.
const backlog = [
  ...mk('arbeitsagentur.de', 'Account Manager (m/w/d)', 300),
  ...mk('arbeitnow.com', 'Operations Associate', 40),
  ...mk('jobs.ashbyhq.com', 'Business Development Representative', 20),
  ...mk('job-boards.greenhouse.io', 'Customer Operations Specialist', 15),
];

const picked = pickAcrossSources(backlog, 25);
check('fills the whole budget', picked.length, 25);
check('no German-marked job while English ones remain', picked.filter(looksGerman).length, 0);

const hosts = new Set(picked.map(p => new URL(p.url).host));
check('spreads across every English source', hosts.size, 3);
const counts = [...hosts].map(h => picked.filter(p => new URL(p.url).host === h).length);
check('no source takes more than half the budget', Math.max(...counts) <= 13, true);

// Budget larger than the English pool: German ones must fill the remainder
// rather than the run coming up short.
const englishOnly = 40 + 20 + 15;
const wide = pickAcrossSources(backlog, englishOnly + 10);
check('German-marked jobs are used once English runs out', wide.length, englishOnly + 10);
check('and exactly the shortfall is German', wide.filter(looksGerman).length, 10);

// Nothing may be invented or lost.
const small = pickAcrossSources(mk('a.de', 'Ops Associate', 3), 25);
check('never returns more than exists', small.length, 3);

console.log(`\n📊 ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
