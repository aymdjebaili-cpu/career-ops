#!/usr/bin/env node
/**
 * test-location-filter.mjs — regression test for the Germany-only location gate.
 *
 * The strict allowlist treated "office", "onsite" and "hybrid" as signs that a
 * location was ambiguous. They are not — they sit next to a real city name, so
 * "Manchester Office" was read as unknowable and kept, and UK/US postings ate
 * eval budget in a Germany-only pipeline.
 *
 * Usage: node test-location-filter.mjs
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { namesAPlace } from './location-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  if (got === want) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} — got ${got}, want ${want}`); }
};

// ── 1. namesAPlace in isolation ───────────────────────────────────────
console.log('\nnamesAPlace — does the string name a concrete place?');

// These name somewhere real. Under a strict allowlist they must be droppable.
for (const s of [
  'Manchester Office',        // the posting that leaked
  'Manchester',
  'London Office (Hybrid)',
  'Paris',
  'Remote - Warsaw',
  'Onsite Amsterdam',
  'Zurich office, hybrid',
  'Bangalore',
  'New York, NY',
]) check(`names a place: "${s}"`, namesAPlace(s), true);

// These name nowhere in particular and must survive for the evaluator to judge.
for (const s of [
  'Remote',
  'Hybrid',
  'EMEA',
  'Europe',
  'Multiple locations',
  'Various offices',
  'Anywhere in Europe',
  'Global — remote',
  'Flexible / Remote',
  'Headquarters',
  'International',
  '',
]) check(`names no place: "${s}"`, namesAPlace(s), false);

// ── 2. The real portals.yml, end to end ───────────────────────────────
// Mirrors buildLocationFilter's ordering: allow-hits win, then excludes, then
// the strict allowlist. Kept in step with scan.mjs / scan-boards.mjs.
console.log('\nportals.yml — full filter behaviour');

const cfg = yaml.load(readFileSync(join(__dirname, 'portals.yml'), 'utf8'));
const lf = cfg.location_filter;
const allowed = [
  ...(lf.allowed_countries || []),
  ...(lf.allowed_cities || []),
  ...(lf.allowed_remote || []),
].map(s => s.toLowerCase());
const excluded = [
  ...(lf.exclude_countries || []),
  ...(lf.exclude_cities || []),
].map(s => s.toLowerCase());

const word = (hay, kw) =>
  new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(hay);

function keeps(location) {
  const lower = (location || '').toLowerCase().trim();
  if (!lower || lower === 'remote' || lower === 'n/a') return true;
  if (/\b(headquarter|hq)\b/.test(lower)) return true;
  if (allowed.some(k => word(lower, k))) return true;
  if (excluded.some(k => word(lower, k))) return false;
  if (lf.strict_allowlist && namesAPlace(lower)) return false;
  return true;
}

console.log('  German postings must be kept:');
for (const s of [
  'Berlin',
  'Berlin, Germany',
  'Munich Office',
  'München',
  'Hybrid - Hamburg',
  'Duisburg',          // was silently dropped: not in the old 22-city list
  'Kiel Office',       // was wrongly KEPT before, for the wrong reason
  'Hagen',
  'Rengsdorf',
  'Königstein im Taunus',
  'Remote, Germany',
  'Frankfurt am Main',
  'Deutschland',
]) check(`keep "${s}"`, keeps(s), true);

console.log('  Non-German postings must be dropped:');
for (const s of [
  'Manchester Office',   // the leak this test exists for
  'London',
  'Paris, France',
  'Amsterdam',
  'Vienna, Austria',
  'Zurich',
  'Madrid Office',
  'Warsaw, Poland',
  'Lisbon',
  'Copenhagen',
]) check(`drop "${s}"`, keeps(s), false);

console.log('  Ambiguous postings stay in for the evaluator:');
for (const s of [
  'Remote',
  'EMEA',
  'Europe',
  'Multiple locations',
  'Headquarters',
]) check(`keep "${s}"`, keeps(s), true);

console.log(`\n📊 ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
