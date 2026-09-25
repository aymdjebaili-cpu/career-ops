#!/usr/bin/env node
/**
 * lidl-apply.mjs — applications to Lidl Munich through their own Easy Apply form.
 *
 * WHY THIS EXISTS
 * Lidl posts more Munich jobs than any other employer in the pool (39 in the Bundesagentur
 * scan alone, 310 on their own site) and publishes no application address anywhere — every
 * one of those postings was unreachable by the email route. The generic form agent could
 * not reach them either: it chases "Apply" links across unknown markup and has failed 167
 * times. This file does the opposite. It targets ONE portal whose shape was measured on
 * 2026-09-16: a JSON job API, and an SAP Easy Apply form with no account wall, no captcha,
 * four required fields and three file slots.
 *
 * WHAT IT WILL NOT DO
 * - invent an answer to a question it does not have a truthful answer for (it skips the job)
 * - report a submission it cannot see confirmed (verdict NEEDS_CHECK, never SUBMITTED)
 * - apply to the same requisition twice (chains/.lidl-applied.json)
 *
 * Usage:
 *   node chains/lidl-apply.mjs --dry-run           # list what it would apply to
 *   node chains/lidl-apply.mjs --limit=8           # apply (default 8 per run)
 *   node chains/lidl-apply.mjs --headed            # watch it work
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { chromium } from 'playwright';
import { resolveCvPdf } from '../cv-pdf.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const LOG = join(HERE, '.lidl-applied.json');

const arg = (n, d) => (process.argv.find(a => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1];
const LIMIT = Number(arg('limit', 8));
const DRY = process.argv.includes('--dry-run');
const HEADED = process.argv.includes('--headed');

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'de-DE,de;q=0.9',
  Accept: 'application/json',
};

// ── who is applying ────────────────────────────────────────────────────────────
const profile = yaml.load(readFileSync(join(PROJECT, 'config', 'profile.yml'), 'utf8'));
const c = profile.candidate || {};
const nameParts = String(c.full_name || '').trim().split(/\s+/);
const ME = {
  first: nameParts[0] ? nameParts[0][0] + nameParts[0].slice(1).toLowerCase() : 'Armin',
  last: nameParts.slice(1).map(p => p[0] + p.slice(1).toLowerCase()).join(' ') || 'Djebaili',
  email: c.email || '',
  // The form states the rule itself: "stelle sicher, dass deine Telefonnummer mit dem
  // Ländercode startet". Spaces in the profile's copy would fail that check.
  phone: String(c.phone || '').replace(/[^\d+]/g, ''),
  // Read from config/profile.yml, never hardcoded: this repo is public, and a home
  // address does not belong in a tracked file. The profile is gitignored, so the address
  // lives in exactly one place. Falls back to the form_answers entry that already holds it.
  ...addressFromProfile(profile),
};

/**
 * The address is kept as a single "Straße Hausnummer, PLZ Ort" answer in profile.yml's
 * form_answers, because that is the shape a form asks for. Lidl's form wants it in four
 * boxes, so split it here rather than storing it twice and letting the copies drift.
 */
function addressFromProfile(p) {
  const explicit = p.candidate?.address;
  if (explicit?.street) {
    return {
      street: explicit.street, houseNo: explicit.houseNo || '', zip: explicit.zip || '',
      city: explicit.city || 'München', country: explicit.country || 'Deutschland',
    };
  }
  const answer = (p.form_answers || []).find(a => /wohnanschrift|postanschrift|street address/i.test(a.match || ''))?.answer || '';
  const m = String(answer).match(/^\s*(.+?)\s+(\d+\s*[A-Za-z]?)\s*,\s*(\d{5})\s+(.+?)\s*$/);
  if (!m) return { street: '', houseNo: '', zip: '', city: 'München', country: 'Deutschland' };
  return { street: m[1], houseNo: m[2], zip: m[3], city: m[4].split('-')[0], country: 'Deutschland' };
}
const CV = resolveCvPdf();

// ── which jobs ─────────────────────────────────────────────────────────────────
// He said "any job is suitable", but an application still has to be true. These are the
// contracts he cannot hold (student enrolment, apprenticeship) or roles whose entry
// requirement is a German qualification he does not have — applying would waste a real
// recruiter's time on a candidate their own rules must reject.
// `student` in any compound — Studentenjob slipped through on the first run (2026-09-16)
// and those contracts require university enrolment he does not have.
const UNSUITABLE = /ausbildung|azubi|schülerpraktikum|schüler|abiturienten|duales? studium|student|werkstudent|praktikum|praktikant|studium|bachelor|master|trainee|meister|elektroniker|mechatroniker|kfz|berufskraftfahrer|lkw|fahrer/i;

async function fetchMunichJobs() {
  const jobs = [];
  for (let page = 1; page <= 6; page++) {
    const general = encodeURIComponent(JSON.stringify({ page, resultsPerPage: 100, sortField: '', sortOrder: '' }));
    const res = await fetch(`https://jobs.lidl.de/api/v1/search?term=M%C3%BCnchen&general=${general}`, { headers: UA });
    if (!res.ok) break;
    const batch = (await res.json()).jobs || [];
    jobs.push(...batch);
    if (batch.length < 100) break;
  }
  return jobs;
}

const placeOf = (j) => {
  const l = j.location;
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object') return l.city || l.value || l.name || Object.values(l).find(v => typeof v === 'string') || '';
  return j.company || '';
};

// ── filling ────────────────────────────────────────────────────────────────────
/** Fill by the visible label the form itself shows, so a renamed field fails loudly. */
async function fillByLabel(page, labelRe, value) {
  const handle = await page.evaluateHandle(({ src, val }) => {
    const re = new RegExp(src, 'i');
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const labelOf = (e) => {
      const forId = e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
      return (e.getAttribute('aria-label') || e.placeholder || (forId && forId.innerText) || e.name || '').replace(/\s+/g, ' ').trim();
    };
    const hit = [...document.querySelectorAll('input, textarea')].filter(vis).find(e => re.test(labelOf(e)));
    if (hit) { hit.focus(); hit.value = ''; }
    return hit || null;
  }, { src: labelRe.source, val: value });
  const el = handle.asElement();
  if (!el) return false;
  await el.type(String(value), { delay: 15 });
  await el.evaluate((n) => { n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); });
  return true;
}

/** The address row renders as four unlabelled boxes; the captions sit beside them. */
async function fillAddressRow(page) {
  return page.evaluate((me) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const labelOf = (e) => {
      const forId = e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
      return (e.getAttribute('aria-label') || e.placeholder || (forId && forId.innerText) || e.name || '').replace(/\s+/g, ' ').trim();
    };
    const blanks = [...document.querySelectorAll('input[type=text]')].filter(e => vis(e) && !labelOf(e));
    const order = [me.street, me.houseNo, me.zip, me.city];
    let n = 0;
    for (let i = 0; i < Math.min(blanks.length, 4); i++) {
      blanks[i].focus();
      blanks[i].value = order[i];
      blanks[i].dispatchEvent(new Event('input', { bubbles: true }));
      blanks[i].dispatchEvent(new Event('change', { bubbles: true }));
      n++;
    }
    return n;
  }, ME);
}

/** Any required field still empty after filling — the reason to skip rather than guess. */
async function unansweredRequired(page) {
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const labelOf = (e) => {
      const forId = e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
      return (e.getAttribute('aria-label') || e.placeholder || (forId && forId.innerText) || e.name || '').replace(/\s+/g, ' ').trim();
    };
    return [...document.querySelectorAll('input, select, textarea')]
      .filter(e => vis(e) && e.type !== 'file' && (e.required || e.getAttribute('aria-required') === 'true') && !String(e.value).trim())
      .map(e => labelOf(e).slice(0, 70));
  });
}

const CONFIRMED = /vielen dank|erfolgreich|bewerbung .*(erhalten|eingegangen|übermittelt)|thank you|received your application/i;

async function applyToJob(page, job) {
  const url = job.recruitingUrlEasyApply;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  for (const sel of ['#onetrust-accept-btn-handler', 'button:has-text("Alle akzeptieren")', 'button:has-text("Akzeptieren")']) {
    const b = page.locator(sel).first();
    if (await b.count() && await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(2500); break; }
  }

  const filled = {
    first: await fillByLabel(page, /vorname|first ?name/, ME.first),
    last: await fillByLabel(page, /nachname|last ?name|surname/, ME.last),
    email: await fillByLabel(page, /e-?mail/, ME.email),
    phone: await fillByLabel(page, /handy|telefon|phone|mobil/, ME.phone),
  };
  const addr = await fillAddressRow(page);

  const fileInput = page.locator('input[type=file]').first();
  let cvAttached = false;
  if (await fileInput.count()) {
    await fileInput.setInputFiles(CV).then(() => { cvAttached = true; }).catch(() => {});
    await page.waitForTimeout(4000);
  }

  const missing = await unansweredRequired(page);
  const core = filled.first && filled.last && filled.email && filled.phone;
  if (!core || missing.length) {
    return { verdict: 'SKIPPED', detail: !core ? `core fields not found (${JSON.stringify(filled)})` : `unanswered required: ${missing.join('; ')}` };
  }
  if (DRY) return { verdict: 'DRY', detail: `would submit — address boxes filled: ${addr}, CV ${cvAttached ? 'attached' : 'NOT attached'}` };

  const submit = page.locator('button:has-text("Bewerben"), button:has-text("Absenden")').last();
  if (!await submit.count()) return { verdict: 'FAILED', detail: 'no submit button' };
  await submit.click({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(9000);

  const after = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 600));
  if (CONFIRMED.test(after)) return { verdict: 'SUBMITTED', detail: after.match(CONFIRMED)[0], cvAttached };
  // A click is not proof. Anything unconfirmed is flagged for a human to check, never
  // recorded as an application — see the standing rule in the project's AGENTS notes.
  return { verdict: 'NEEDS_CHECK', detail: after.slice(0, 160), cvAttached };
}

// ── run ────────────────────────────────────────────────────────────────────────
if (!existsSync(CV)) { console.log(`CV not found: ${CV}`); process.exit(1); }
mkdirSync(HERE, { recursive: true });
const done = existsSync(LOG) ? JSON.parse(readFileSync(LOG, 'utf8')) : {};

const all = await fetchMunichJobs();
const open = all.filter(j => j.recruitingUrlEasyApply && !j.noEasyApply && !UNSUITABLE.test(j.title || '') && !done[j.requisitionId || j.postingId]);
// Part-time and minijob first — that is the segment he asked for; full-time physical work
// in the same stores follows behind it rather than crowding it out.
open.sort((a, b) => {
  const rank = (j) => (/minijob/i.test(j.contractType) ? 0 : /teilzeit/i.test(j.contractType) ? 1 : 2);
  return rank(a) - rank(b);
});
const batch = open.slice(0, LIMIT);

console.log(`Lidl Munich: ${all.length} jobs, ${open.length} suitable and not yet applied to, taking ${batch.length}`);
console.log(`CV: ${CV}\n`);

const browser = await chromium.launch({ headless: !HEADED });
const page = await browser.newPage({ locale: 'de-DE', userAgent: UA['User-Agent'] });
let submitted = 0, needsCheck = 0, skipped = 0, failed = 0;

for (const job of batch) {
  const id = job.requisitionId || job.postingId;
  console.log(`→ ${String(job.title).slice(0, 52).padEnd(54)} ${String(placeOf(job)).slice(0, 18).padEnd(20)} ${job.contractType || ''}`);
  let r;
  try { r = await applyToJob(page, job); }
  catch (e) { r = { verdict: 'FAILED', detail: String(e.message).slice(0, 120) }; }
  console.log(`   ${r.verdict}: ${r.detail}`);

  if (r.verdict === 'SUBMITTED') { submitted++; done[id] = { title: job.title, location: placeOf(job), url: job.jobDetailUrl, at: new Date().toISOString(), verdict: r.verdict, evidence: r.detail }; }
  else if (r.verdict === 'NEEDS_CHECK') { needsCheck++; done[id] = { title: job.title, location: placeOf(job), url: job.jobDetailUrl, at: new Date().toISOString(), verdict: r.verdict, evidence: r.detail }; }
  else if (r.verdict === 'SKIPPED') skipped++;
  else if (r.verdict === 'FAILED') failed++;
  await page.waitForTimeout(2500);
}

await browser.close();
if (!DRY) writeFileSync(LOG, JSON.stringify(done, null, 1));
console.log(`\nsubmitted ${submitted}, needs check ${needsCheck}, skipped ${skipped}, failed ${failed}`);
if (!DRY) console.log(`record: ${LOG}`);
