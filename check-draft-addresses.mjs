#!/usr/bin/env node
/**
 * check-draft-addresses.mjs — audit every email draft file against a real source.
 *
 * Answers one question per draft: can the address it is sent to be traced to
 * something the company actually published? Drafts written before the gate in
 * daily-run.mjs existed were addressed to `careers@{domain}` guesses, and in Gmail
 * those look exactly like verified ones. This tells them apart.
 *
 *   node check-draft-addresses.mjs           # audit
 *   node check-draft-addresses.mjs --json    # machine-readable
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { findApplicationEmail } from './find-application-email.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'output');
const TARGETS_FILE = join(__dirname, 'config', 'initiativ-targets.yml');
const AS_JSON = process.argv.includes('--json');

// The Initiativbewerbung targets carry their own provenance: an address only gets
// `verified: true` after someone read the careers page, and `email_source` records
// which page. Re-scraping is still the check — the config is just where the right
// page to scrape is written down, since these addresses hide at URLs like
// /ueberuns/jobs.php that no path-guessing would find.
function initiativTargets() {
  if (!existsSync(TARGETS_FILE)) return [];
  try {
    return yaml.load(readFileSync(TARGETS_FILE, 'utf8'))?.targets ?? [];
  } catch {
    return [];
  }
}
const TARGETS = initiativTargets();

function meta(file) {
  const head = readFileSync(file, 'utf8').split(/\n---\n/)[0];
  const out = {};
  for (const line of head.split('\n')) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const files = readdirSync(OUTPUT_DIR).filter(f => /^email-.*\.md$/.test(f)).sort();
const rows = [];

for (const f of files) {
  const m = meta(join(OUTPUT_DIR, f));
  const to = (m.TO ?? '').toLowerCase();
  const company = m.COMPANY ?? '';
  const source = m.EMAIL_VERIFIED ?? '';
  if (!to) continue;

  // Scrape the best page we know of: the careers URL from the Initiativbewerbung
  // config when this is a speculative draft, the posting's own domain otherwise.
  const target = TARGETS.find(t => f === `email-init-${t.slug}.md` || t.email?.toLowerCase() === to);
  const hint = target?.careers_url ?? m.COMPANY_DOMAIN;
  const hit = await findApplicationEmail(company, hint);
  const published = hit?.email?.toLowerCase() ?? null;

  let verdict, evidence;
  if (published && published === to) {
    verdict = 'VERIFIED';
    evidence = `re-scraped just now at ${hit.source}`;
  } else if (published) {
    verdict = 'WRONG';
    evidence = `company publishes ${published} (${hit.source})`;
  } else if (target?.verified && target.email_source) {
    // The scraper missed it, but a human read the page and wrote down where.
    verdict = 'ON RECORD';
    evidence = `${target.email_source.trim().replace(/\s+/g, ' ')}`;
  } else if (/^(careers|jobs|hr|info|apply|talent)@/.test(to) && !/published/i.test(source)) {
    verdict = 'UNVERIFIED';
    evidence = 'generic inbox with no published source — this is the guessed pattern';
  } else {
    verdict = 'FROM POSTING';
    evidence = source || 'address came from the posting itself';
  }
  rows.push({ file: f, company, to, verdict, evidence });
}

if (AS_JSON) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const icon = { VERIFIED: '✅', 'ON RECORD': '📋', 'FROM POSTING': '📄', UNVERIFIED: '❌', WRONG: '⚠️ ' };
  for (const r of rows) {
    console.log(`${icon[r.verdict]} ${r.verdict.padEnd(12)} ${r.to.padEnd(34)} ${r.company}`);
    console.log(`   ${r.evidence}`);
  }
  const bad = rows.filter(r => r.verdict === 'UNVERIFIED' || r.verdict === 'WRONG');
  console.log(`\n${rows.length} drafts | ${rows.length - bad.length} traceable | ${bad.length} NOT traceable to a published address`);
}
