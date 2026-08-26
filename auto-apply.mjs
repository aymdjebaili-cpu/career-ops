#!/usr/bin/env node
/**
 * auto-apply.mjs — Playwright-based auto-application script
 *
 * For each qualified report (score ≥ threshold):
 *   1. Open JD URL in headed Chromium
 *   2. Detect ATS (Greenhouse, Ashby, Lever)
 *   3. Auto-fill form: name, email, phone, LinkedIn
 *   4. Upload CV PDF + Cover Letter PDF
 *   5. Check for CAPTCHA
 *      - If CAPTCHA present: PAUSE for manual completion
 *      - If no CAPTCHA: auto-submit
 *   6. Log result to applications-index.md
 *
 * Usage:
 *   node auto-apply.mjs                    # process all reports, score ≥ 2.5
 *   node auto-apply.mjs --score=3.0       # custom threshold
 *   node auto-apply.mjs --report=011      # one job
 *   node auto-apply.mjs --report=021,029  # a hand-picked shortlist, in this order
 *   node auto-apply.mjs --no-submit       # fill but never submit (always pause)
 *   node auto-apply.mjs --headless        # run headless (no browser window)
 *   node auto-apply.mjs --skip-seen       # ignore every job the apply log has touched
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from 'playwright';
import yaml from 'js-yaml';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const REPORTS_DIR = join(PROJECT_DIR, 'reports');
const COVER_DIR = join(PROJECT_DIR, 'output', 'cover-letters');
// CV path comes from config/profile.yml → documents.cv_pdf (absolute or
// project-relative). Falls back to the historical default.
function resolveCvPdf() {
  try {
    const p = yaml.load(readFileSync(PROFILE_FILE, 'utf-8'))?.documents?.cv_pdf;
    if (p) return /^([A-Za-z]:[\\/]|\/)/.test(p) ? p : join(PROJECT_DIR, p);
  } catch { /* fall through */ }
  return join(PROJECT_DIR, 'output', 'cv-updated.pdf');
}
const CV_PDF = resolveCvPdf();

// The CV actually uploaded for the job in flight. daily-run.mjs writes a
// per-posting CV (same facts, bullets reordered for that employer -- see
// tailor-cv.mjs); when one exists it should be what the form receives, not the
// generic file. Falls back to the standard CV, and is reset for every job.
let activeCvPdf = resolveCvPdf();
function cvForReport(num) {
  const dir = join(PROJECT_DIR, 'output', 'cv-tailored');
  if (!num || !existsSync(dir)) return CV_PDF;
  const hit = readdirSync(dir).find(f => f.startsWith(`${num}-`) && f.endsWith('.pdf'));
  return hit ? join(dir, hit) : CV_PDF;
}
const PROFILE_FILE = join(PROJECT_DIR, 'config', 'profile.yml');
const INDEX_FILE = join(PROJECT_DIR, 'output', 'applications-index.md');
const APPLY_LOG_FILE = join(PROJECT_DIR, 'output', '.apply-log.json');

const args = process.argv.slice(2);
const THRESHOLD = parseFloat(args.find(a => a.startsWith('--score='))?.split('=')[1] || '2.5');
// --report=459 or --report=021,029,402 — a hand-picked run. The date window
// below is the right default for a daily pass, but choosing the exact jobs to
// open matters as soon as the shortlist is curated rather than chronological.
const PICKED_REPORTS = (args.find(a => a.startsWith('--report='))?.split('=')[1] || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_JOBS = parseInt(args.find(a => a.startsWith('--max='))?.split('=')[1] || '9999', 10);
// DEFAULT: review-first (AGENTS.md "Ethical Use" — never submit without the user
// reviewing). Forms get fully filled, then the script PAUSES so you check and click
// Submit yourself. Pass --auto-submit to restore unattended submission on
// CAPTCHA-free forms (not recommended).
const AUTO_SUBMIT = args.includes('--auto-submit');
const NO_SUBMIT = !AUTO_SUBMIT;
const HEADLESS = args.includes('--headless');
// Only `submitted` is skipped normally, so a job the script filled but left for
// you to send gets re-opened on the next run. When you can't remember whether
// you pressed Submit, --skip-seen leaves every already-touched job alone and
// works through the genuinely new ones instead.
const SKIP_SEEN = args.includes('--skip-seen');
// Visible mode default: fill EVERY job, leave all windows open at the end so the
// user walks through them clicking Submit. --sequential restores one-at-a-time.
const KEEP_OPEN = !HEADLESS && !args.includes('--sequential');
// AI drafts answers for questions the pattern-matching can't handle (one headless
// haiku call per job). Disable with --no-ai-answers. Sensitive fields are never sent.
const AI_ANSWERS = !args.includes('--no-ai-answers');
const AI_MODEL = args.find(a => a.startsWith('--ai-model='))?.split('=')[1] || 'claude-haiku-4-5-20251001';
const ATS_FILTER = args.find(a => a.startsWith('--ats='))?.split('=')[1] || null;
const PAUSE_SECONDS = parseInt(args.find(a => a.startsWith('--pause='))?.split('=')[1] || '60', 10);

// ─────────────────────────────────────────────
// Profile data (used to fill forms)
// ─────────────────────────────────────────────
function loadProfile() {
  if (!existsSync(PROFILE_FILE)) {
    console.error('❌ config/profile.yml not found');
    process.exit(1);
  }
  const profile = yaml.load(readFileSync(PROFILE_FILE, 'utf-8'));
  const candidate = profile.candidate || {};
  return {
    firstName: 'Aimene',
    lastName: 'Djebaili',
    email: candidate.email || 'Aym.djebaili@gmail.com',
    phone: candidate.phone || '+49 1521 8473921',
    linkedin: candidate.linkedin
      ? (candidate.linkedin.startsWith('http') ? candidate.linkedin : `https://www.${candidate.linkedin}`)
      : 'https://www.linkedin.com/in/aimene-djebaili-b064141b8/',
    website: candidate.portfolio_url || '',
    github: candidate.github || '',
    // Read the city from the profile instead of hardcoding it — a stale literal
    // here types the wrong home city into every application form.
    city: (profile.location && profile.location.current_city) || (candidate.location || '').split(',')[0].trim() || 'Mannheim',
    country: 'Germany',
    currentLocation: candidate.location || 'Mannheim, Germany',
    // Default answers for common application questions.
    // Work rights: legally resident and permitted to work TODAY (part-time /
    // internships), but a full-time permanent contract needs the permit
    // converted — hence eligible=yes AND sponsorship=yes. See
    // config/profile.yml → location.work_authorization.
    workAuth: 'yes',
    visaSponsorship: 'yes',
    eu_citizen: 'no',
    relocation: 'yes',
    noticePeriod: (profile.availability && profile.availability.notice_period) || '1 month',
    earliestStart: 'Immediately',
    earliestStartDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), // for literal date-picker fields
    salary: '40000',          // €40K target (mid of €35-50K range)
  };
}

// ─────────────────────────────────────────────
// Parse report metadata
// ─────────────────────────────────────────────
function parseReport(filename) {
  const content = readFileSync(join(REPORTS_DIR, filename), 'utf-8');
  const lines = content.split('\n').slice(0, 20);
  const meta = {};

  for (const line of lines) {
    const m = line.match(/^\*\*([^:]+):\*\*\s*(.+)/);
    if (!m) continue;
    meta[m[1].toLowerCase().replace(/\s+/g, '_')] = m[2].trim();
  }

  const num = filename.match(/^(\d{3})-/)?.[1];
  return {
    num,
    fname: filename,
    company: meta.company,
    role: meta.role,
    score: parseFloat(meta.score?.split('/')[0] || '0'),
    url: meta.url,
    language: meta.language || 'EN',
    isGerman: meta.language === 'DE' || /praktikum|werkstudent/i.test(meta.role || ''),
  };
}

// ─────────────────────────────────────────────
// Apply log tracking
// ─────────────────────────────────────────────
function loadApplyLog() {
  if (!existsSync(APPLY_LOG_FILE)) return {};
  try { return JSON.parse(readFileSync(APPLY_LOG_FILE, 'utf-8')); }
  catch { return {}; }
}

function saveApplyLog(log) {
  writeFileSync(APPLY_LOG_FILE, JSON.stringify(log, null, 2));
}

// The company half of an apply-log key. Used by processJob() and by --skip-seen.
function applyLogSlug(company) {
  return company.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function appendToIndex(report, status) {
  const row = `| ${new Date().toISOString().slice(0, 10)} | ${report.company} | ${report.role} | ${report.score}/5 | [link](${report.url}) | auto-apply | ${status} |\n`;
  appendFileSync(INDEX_FILE, row);
}

// ─────────────────────────────────────────────
// ATS detection from URL
// ─────────────────────────────────────────────
function detectATS(url) {
  if (url.includes('greenhouse.io')) return 'greenhouse';
  if (url.includes('ashbyhq.com')) return 'ashby';
  if (url.includes('lever.co')) return 'lever';
  if (url.includes('?gh_jid=')) return 'greenhouse';
  return 'unknown';
}

// ─────────────────────────────────────────────
// Accept cookies / dismiss banners FIRST
// Aggressive: also check inside iframes
// ─────────────────────────────────────────────
async function acceptCookies(page) {
  const cookieButtons = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept all cookies")',
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Alle Cookies akzeptieren")',
    'button:has-text("Akzeptieren")',
    'button:has-text("Accepter tout")',
    'button:has-text("I accept")',
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    'button:has-text("Got it")',
    'button:has-text("Allow all")',
    'button:has-text("Allow")',
    'button[id*="cookie" i][id*="accept" i]',
    'button[class*="cookie" i][class*="accept" i]',
    'button[id*="onetrust-accept"]',
    '#onetrust-accept-btn-handler',
    '.cookie-accept',
    '[data-testid*="cookie"][data-testid*="accept"]',
    '[aria-label*="accept" i]',
  ];

  // Try main page
  for (const sel of cookieButtons) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible({ timeout: 300 })) {
        await btn.click();
        console.log(`      🍪 accepted cookies: ${sel.slice(0, 50)}`);
        await page.waitForTimeout(1500);
        return true;
      }
    } catch (e) { /* try next */ }
  }

  // Try iframes (common for cookie consent providers)
  for (const frame of page.frames()) {
    for (const sel of cookieButtons.slice(0, 8)) { // just the most common
      try {
        const btn = await frame.$(sel);
        if (btn && await btn.isVisible({ timeout: 300 })) {
          await btn.click();
          console.log(`      🍪 accepted cookies in iframe`);
          await page.waitForTimeout(1500);
          return true;
        }
      } catch (e) { /* try next */ }
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// Handle React-Select dropdowns (modern Greenhouse, Ashby)
// These look like dropdowns but are <div> containers with combobox role
// ─────────────────────────────────────────────
async function fillReactSelectDropdowns(page, profile) {
  let filled = 0;
  // Look for React-Select containers
  const containers = await page.$$('.select__control, [class*="select-control"], [role="combobox"], div[class*="Select"][class*="container"]');

  for (const container of containers) {
    try {
      // Get the label/question for this dropdown
      const labelText = await container.evaluate(el => {
        // Walk up to find the label
        let current = el;
        for (let i = 0; i < 4; i++) {
          current = current.parentElement;
          if (!current) break;
          const lbl = current.querySelector('label, legend, .label');
          if (lbl) return lbl.textContent.trim();
        }
        return '';
      });

      if (!labelText) continue;
      const context = labelText.toLowerCase();

      // Determine answer based on common patterns
      let answer = null;
      if (/(possess|hold|already\s+have|do\s+you\s+have).*?(work\s*permit|visa)/.test(context)) answer = 'No';
      else if (/authoriz|legally.*work|right\s*to\s*work|eligible.*work/.test(context)) answer = 'No';
      else if (/visa|sponsor|require.*visa|need.*visa/.test(context)) answer = 'Yes';
      else if (/relocat|move\s*to|umziehen/.test(context)) answer = 'Yes';
      else if (/eu\s*citizen|eu.*national/.test(context)) answer = 'No';
      else if (/gender|geschlecht/.test(context)) answer = 'Prefer not to say';
      else if (/race|ethnic/.test(context)) answer = 'Prefer not to say';
      else if (/veteran/.test(context)) answer = 'I am not a veteran';
      else if (/disab|behinderung/.test(context)) answer = 'I don\'t wish to answer';
      else if (/source|how.*hear/.test(context)) answer = 'LinkedIn';
      else if (/country|nation/.test(context) && !/origin/.test(context)) answer = 'Germany';
      else if (/notice\s*period/.test(context)) answer = '1 month';
      else if (/start\s*date|earliest/.test(context)) answer = profile.earliestStart;

      if (!answer) continue;

      // Click the dropdown to open it
      await container.click();
      await page.waitForTimeout(400);

      // Find a matching option in the dropdown menu
      const options = await page.$$('.select__option, [class*="select-option"], [role="option"]');
      let matched = false;
      for (const opt of options) {
        const optText = (await opt.textContent() || '').trim();
        if (optText.toLowerCase().includes(answer.toLowerCase()) ||
            answer.toLowerCase().includes(optText.toLowerCase())) {
          await opt.click();
          console.log(`      ✓ react-dropdown "${labelText.slice(0, 40)}" → ${optText.slice(0, 30)}`);
          filled++;
          matched = true;
          break;
        }
      }

      if (!matched) {
        // Close the dropdown by pressing Escape
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(300);
    } catch (e) { /* try next */ }
  }
  return filled;
}

// ─────────────────────────────────────────────
// Shared label → answer matching, used by both the textarea filler and the
// short-text-input filler below. Returns a string answer, the sentinel
// '__OPTIONAL_EMPTY__' (recognized but nothing to put — skip silently, no
// "needs your answer" flag), or null (unrecognized — leave for AI/user).
// ─────────────────────────────────────────────
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function matchCustomAnswer(context, profile, companyName) {
  const companyFirstWord = companyName ? companyName.trim().split(/\s+/)[0] : '';
  const whyCompanyRe = companyFirstWord
    ? new RegExp(`^why\\s+${escapeRegex(companyFirstWord)}`, 'i')
    : null;

  if (/salary|compensat|gehalt|verdienst|expected\s*comp/.test(context)) {
    return '€38,000 - €45,000 (negotiable based on role scope and benefits package)';
  }
  if (whyCompanyRe && whyCompanyRe.test(context)) {
    return `Your company's mission and growth trajectory in Germany align with the kind of impactful, scalable work environment where I can apply my operational expertise and contribute meaningfully from day one.`;
  }
  if (/why.*you|why.*interested|motivation|interesse|why.*role|why.*position|warum/.test(context)) {
    return 'This role aligns directly with my background in operations and customer success in hospitality technology. My experience leading a four-person team and recovering €1.6M in revenue has prepared me to add immediate value. I am excited about the opportunity to grow with your team in Germany.';
  }
  if (/why\s*us|why.*company|warum.*uns/.test(context)) {
    return `Your company's mission and growth trajectory in Germany align with the kind of impactful, scalable work environment where I can apply my operational expertise and contribute meaningfully from day one.`;
  }
  if (/strength|stärke|biggest\s*achievement/.test(context)) {
    return 'My greatest strength is combining analytical rigor with operational execution — I built systematic processes that converted 345 bookings from 1,271 leads and recovered €1.6M in B2B receivables.';
  }
  if (/notice\s*period|kündigung/.test(context)) {
    return profile.noticePeriod;
  }
  if (/availability|available|verfügbar|start\s*date|earliest|when\s*could\s*you\s*join/.test(context)) {
    return `Available with ${profile.noticePeriod} notice period.`;
  }
  if (/pre.?arranged\s*holiday|planned\s*absence|commitments?\s*we\s*should\s*be\s*aware/.test(context)) {
    return "None that I'm aware of at this time.";
  }
  if (/where.*(currently|you).*(located|based)|current\s*location|city.*(you|currently).*(located|based)/.test(context)) {
    return profile.currentLocation;
  }
  if (/contact\s*number|phone\s*number|telefon|mobile\s*number/.test(context)) {
    return profile.phone;
  }
  if (/linkedin/.test(context)) {
    return profile.linkedin;
  }
  if (/github/.test(context)) {
    return profile.github || '__OPTIONAL_EMPTY__';
  }
  if (/portfolio|personal\s*website/.test(context)) {
    return profile.website || '__OPTIONAL_EMPTY__';
  }
  if (/comment|additional|sonstig|anything\s*else|further\s*info/.test(context)) {
    return 'I am happy to provide any additional information needed and look forward to discussing the role in detail in an interview.';
  }
  return null;
}

// ─────────────────────────────────────────────
// Fill custom open-text fields (textarea questions)
// AGGRESSIVE: fills EVERY visible empty textarea with the best matching response
// ─────────────────────────────────────────────
async function fillCustomTextareas(page, profile, companyName) {
  const textareas = await page.$$('textarea');
  let filled = 0;

  for (const ta of textareas) {
    try {
      const isVisible = await ta.isVisible().catch(() => false);
      if (!isVisible) continue;

      const value = await ta.inputValue();
      if (value && value.trim().length > 0) continue;

      // Skip cover letter field — we already attached PDF
      const name = (await ta.getAttribute('name') || '').toLowerCase();
      const id = (await ta.getAttribute('id') || '').toLowerCase();
      if (name.includes('cover') || id.includes('cover')) continue;

      const labelText = await ta.evaluate(questionLabelInPage);

      const context = labelText.toLowerCase();
      const answer = matchCustomAnswer(context, profile, companyName);

      if (answer === null) {
        // Unknown question — leave it for the AI pass / user. Canned text in a custom
        // question ("describe a time you failed...") reads as copy-paste and kills the application.
        console.log(`      ✋ textarea "${labelText.slice(0, 60) || name || id}" → NEEDS YOUR ANSWER (left blank)`);
        noteGap(page, labelText || name || id, 'text');
        continue;
      }
      if (answer === '__OPTIONAL_EMPTY__') continue; // recognized, nothing to put, optional field

      await ta.fill(answer);
      console.log(`      ✓ textarea "${labelText.slice(0, 40) || name || id || '(no label)'}" → ${answer.slice(0, 50)}...`);
      filled++;
    } catch (e) { /* try next */ }
  }
  return filled;
}

// ─────────────────────────────────────────────
// Fill custom short-text/url/tel inputs (LinkedIn, GitHub, portfolio, current
// location, contact number, etc.). Ashby/Greenhouse render these as plain
// <input> custom questions — a different DOM shape than the textareas above,
// which fillCustomTextareas (and the AI fallback) never looked at, so they
// silently stayed blank no matter how well-known the answer was.
// ─────────────────────────────────────────────
async function fillCustomTextInputs(page, profile, companyName) {
  const inputs = await page.$$('input[type="text"], input[type="url"], input[type="tel"]:not([id*="phone" i]), input:not([type])');
  let filled = 0;

  for (const input of inputs) {
    try {
      const isVisible = await input.isVisible().catch(() => false);
      if (!isVisible) continue;

      const value = await input.inputValue();
      if (value && value.trim().length > 0) continue;

      const name = (await input.getAttribute('name') || '').toLowerCase();
      const id = (await input.getAttribute('id') || '').toLowerCase();
      if (name.includes('cover') || id.includes('cover')) continue;
      // Already handled by the fixed name/email/phone selectors upstream
      if (/^(_systemfield_name|_systemfield_email|first_name|last_name|email)$/.test(name) || /email/.test(id)) continue;

      const labelText = await input.evaluate(questionLabelInPage);
      if (!labelText) continue; // no way to identify an unlabeled short input safely

      const context = labelText.toLowerCase();
      if (SENSITIVE_QUESTION.test(context)) continue; // never auto-fill references/passport/etc.

      const answer = matchCustomAnswer(context, profile, companyName);
      if (answer === null) {
        console.log(`      ✋ input "${labelText.slice(0, 60)}" → NEEDS YOUR ANSWER (left blank)`);
        noteGap(page, labelText, 'text');
        continue;
      }
      if (answer === '__OPTIONAL_EMPTY__') continue;

      await input.fill(answer);
      console.log(`      ✓ input "${labelText.slice(0, 40)}" → ${answer.slice(0, 50)}`);
      filled++;
    } catch (e) { /* try next */ }
  }
  return filled;
}

// ─────────────────────────────────────────────
// Fill date-picker fields (e.g. "Start date — When could you join us?").
// Native <input type="date"> takes a direct value. Custom JS calendar widgets
// (react-datepicker-style) need a click to open + a day cell clicked inside
// the popup — best-effort, always falls back to a clear "needs your answer" log
// rather than silently leaving it blank with no trace.
// ─────────────────────────────────────────────
async function fillDateFields(page, profile) {
  let filled = 0;

  // Native date inputs
  for (const input of await page.$$('input[type="date"]')) {
    try {
      const isVisible = await input.isVisible().catch(() => false);
      if (!isVisible) continue;
      const value = await input.inputValue();
      if (value && value.trim().length > 0) continue;
      await input.fill(profile.earliestStartDate);
      console.log(`      ✓ date field → ${profile.earliestStartDate}`);
      filled++;
    } catch (e) { /* try next */ }
  }

  // Custom calendar-widget triggers: text inputs/buttons with a "pick a date"-style placeholder
  const triggers = await page.$$('input[placeholder*="date" i], button:has-text("Pick date")');
  for (const trigger of triggers) {
    try {
      const isVisible = await trigger.isVisible().catch(() => false);
      if (!isVisible) continue;
      const value = await trigger.inputValue?.().catch(() => '') || '';
      if (value && value.trim().length > 0) continue;

      const labelText = await trigger.evaluate(el => {
        const id = el.id;
        if (id) {
          const lbl = document.querySelector(`label[for="${id}"]`);
          if (lbl) return lbl.textContent.trim();
        }
        const parent = el.closest('div,fieldset,li');
        if (parent) {
          const lbl = parent.querySelector('label, legend');
          if (lbl) return lbl.textContent.trim();
        }
        return el.placeholder || '';
      });

      await trigger.click();
      await page.waitForTimeout(400);

      const popup = await page.$('[role="dialog"], .react-datepicker, [class*="datepicker" i], [class*="calendar" i]');
      let picked = false;
      if (popup) {
        const todayCell = await popup.$('[aria-label*="Today" i], button:has-text("Today"), [class*="--today"], [aria-selected="true"]');
        const cell = todayCell || await popup.$('button:not([disabled]):not([aria-disabled="true"])');
        if (cell) {
          await cell.click();
          picked = true;
        }
      }

      if (picked) {
        await page.waitForTimeout(200);
        console.log(`      ✓ date picker "${labelText.slice(0, 40)}" → nearest available date`);
        filled++;
      } else {
        await page.keyboard.press('Escape').catch(() => {});
        console.log(`      ✋ date picker "${labelText.slice(0, 40)}" → NEEDS YOUR ANSWER (left blank)`);
        noteGap(page, labelText, 'date');
      }
    } catch (e) { /* try next */ }
  }

  return filled;
}

// ─────────────────────────────────────────────
// Check required checkboxes (terms, privacy, GDPR consent)
// ─────────────────────────────────────────────
async function checkRequiredCheckboxes(page) {
  let checked = 0;
  const checkboxes = await page.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    try {
      const isVisible = await cb.isVisible().catch(() => false);
      if (!isVisible) continue;

      const isChecked = await cb.isChecked();
      if (isChecked) continue;

      const labelText = await cb.evaluate(el => {
        const id = el.id;
        if (id) {
          const lbl = document.querySelector(`label[for="${id}"]`);
          if (lbl) return lbl.textContent.trim();
        }
        const parent = el.closest('label, div, fieldset, li');
        return parent ? parent.textContent.trim() : '';
      });

      const context = labelText.toLowerCase();
      const required = await cb.evaluate(el => el.required || el.getAttribute('aria-required') === 'true');

      // Only check terms/privacy/consent boxes if required
      if (required && /terms|privacy|consent|datenschutz|einwilligung|agree|akzeptieren|i\s*confirm|i\s*understand|bestätige/.test(context)) {
        await cb.check();
        console.log(`      ✓ checked required: "${labelText.slice(0, 50)}"`);
        checked++;
      }
    } catch (e) { /* try next */ }
  }
  return checked;
}

// ─────────────────────────────────────────────
// Handle dropdowns + radio buttons for common questions
// AGGRESSIVE: fills every dropdown, falls back to first non-empty option
// ─────────────────────────────────────────────
async function fillDropdownsAndRadios(page, profile) {
  // Get all <select> elements with their labels
  const selects = await page.$$('select');
  let filled = 0;

  for (const select of selects) {
    try {
      const isVisible = await select.isVisible().catch(() => false);
      if (!isVisible) continue;

      // Get label/name for this select
      const id = await select.getAttribute('id') || '';
      const name = await select.getAttribute('name') || '';
      const labelText = await select.evaluate(el => {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) return label.textContent.trim();
        const parent = el.closest('div,fieldset,li');
        if (parent) {
          const lbl = parent.querySelector('label, legend, .label');
          if (lbl) return lbl.textContent.trim();
        }
        return '';
      });
      const context = `${id} ${name} ${labelText}`.toLowerCase();

      // Skip if already filled
      const currentValue = await select.evaluate(el => el.value);
      if (currentValue && currentValue !== '' && currentValue !== '0') continue;

      // Get all options
      const options = await select.$$eval('option', opts =>
        opts.map(o => ({ value: o.value, text: o.textContent.trim() }))
      );

      let chosenValue = null;

      // Match by question pattern
      if (/(possess|hold|already\s+have|do\s+you\s+have).*?(work\s*permit|visa)/.test(context)) {
        chosenValue = pickOption(options, ['no', 'nein', 'false']);
      } else if (/authoriz|work\s*authoriz|legally.*work|right\s*to\s*work|eligible.*work/.test(context)) {
        // Legally resident and permitted to work today (part-time/internships);
        // the full-time restriction is captured by the sponsorship question below.
        // Kept in step with decideChoice() — see config/profile.yml work_authorization.
        chosenValue = pickOption(options, ['yes', 'ja', 'true']);
      } else if (/visa|sponsor|need.*visa|require.*visa/.test(context)) {
        chosenValue = pickOption(options, ['yes', 'ja', 'true']);
      } else if (/eu\s*citizen|eu.*national|european.*citizen/.test(context)) {
        chosenValue = pickOption(options, ['no', 'nein', 'false']);
      } else if (/relocat|umziehen|umzug|move\s*to/.test(context)) {
        chosenValue = pickOption(options, ['yes', 'ja', 'true']);
      } else if (/gender|geschlecht|sex/.test(context)) {
        chosenValue = pickOption(options, ['decline', 'prefer not', 'rather not', 'i\'d rather not say', 'keine angabe', 'male', 'männlich']);
      } else if (/race|ethnicity|ethnic|herkunft/.test(context)) {
        chosenValue = pickOption(options, ['decline', 'prefer not', 'rather not', 'keine angabe']);
      } else if (/veteran|veteran\s*status/.test(context)) {
        chosenValue = pickOption(options, ['no', 'nein', 'not a veteran']);
      } else if (/disability|disabled|behinderung/.test(context)) {
        chosenValue = pickOption(options, ['decline', 'prefer not', 'no, i do not', 'nein']);
      } else if (/source|how.*hear|referral|wie.*erfahren/.test(context)) {
        chosenValue = pickOption(options, ['linkedin', 'job board', 'company website', 'other']);
      } else if (/country|land/.test(context) && !/origin/.test(context)) {
        chosenValue = pickOption(options, ['germany', 'deutschland']);
      } else if (/language|sprache/.test(context)) {
        chosenValue = pickOption(options, profile.language === 'DE' ? ['deutsch', 'german'] : ['english', 'englisch']);
      } else if (/level|education|degree|abschluss/.test(context)) {
        chosenValue = pickOption(options, ['master', 'msc', 'm.sc', 'bachelor']);
      } else if (/years.*experience|jahre.*erfahrung|experience/.test(context)) {
        chosenValue = pickOption(options, ['1-3', '0-2', '1-2', 'less than', 'weniger als']);
      }

      // AGGRESSIVE FALLBACK: if no match, pick "Decline" / "Prefer not to say" / first valid option
      if (!chosenValue) {
        chosenValue = pickOption(options, [
          'decline', 'prefer not', 'rather not say', 'keine angabe',
          'no answer', 'unspecified',
        ]);
      }

      // No pattern match and no safe "prefer not to say" option: leave it for the
      // user during the review pause. Picking the first option can silently answer
      // a factual question wrong (salary band, notice period, security clearance...).
      if (!chosenValue) {
        console.log(`      ✋ dropdown "${labelText.slice(0, 60) || name || id}" → NEEDS YOUR ANSWER (left unselected)`);
        noteGap(page, labelText || name || id, 'dropdown');
        continue;
      }

      if (chosenValue) {
        await select.selectOption(chosenValue);
        const chosenText = options.find(o => o.value === chosenValue)?.text || chosenValue;
        console.log(`      ✓ dropdown "${labelText.slice(0, 40) || name || id}" → ${chosenText.slice(0, 30)}`);
        filled++;
      }
    } catch (e) { /* try next */ }
  }

  // Radio buttons & checkboxes for yes/no questions
  const fieldsets = await page.$$('fieldset, div[role="radiogroup"]');
  for (const fs of fieldsets) {
    try {
      const labelText = await fs.evaluate(el => {
        const legend = el.querySelector('legend, label, .label, h4, .question');
        return legend ? legend.textContent.trim() : '';
      });
      const context = labelText.toLowerCase();
      if (!context) continue;

      let targetValue = null;
      if (/(possess|hold|already\s+have|do\s+you\s+have).*?(work\s*permit|visa)/.test(context)) targetValue = 'no';
      else if (/authoriz|legally.*work|right\s*to\s*work|allowed.*work/.test(context)) targetValue = 'yes';
      else if (/visa|sponsor|require.*visa/.test(context)) targetValue = 'yes';
      else if (/relocat|move\s*to/.test(context)) targetValue = 'yes';
      else if (/eu\s*citizen|eu.*national/.test(context)) targetValue = 'no';

      if (!targetValue) continue;

      // Find the radio button matching targetValue
      const radio = await fs.$(`input[type="radio"][value*="${targetValue}" i], input[type="radio"][value*="Yes" i], input[type="radio"][value*="No" i]`);
      if (radio) {
        // Match value loosely
        const val = await radio.getAttribute('value');
        if (val && val.toLowerCase().includes(targetValue)) {
          await radio.check();
          console.log(`      ✓ radio "${labelText.slice(0, 40)}" → ${targetValue}`);
          filled++;
        }
      } else {
        // Try all radio buttons in this fieldset, pick by label
        const radios = await fs.$$('input[type="radio"]');
        for (const r of radios) {
          const rVal = (await r.getAttribute('value') || '').toLowerCase();
          if (rVal === targetValue || rVal.includes(targetValue)) {
            await r.check();
            console.log(`      ✓ radio "${labelText.slice(0, 40)}" → ${targetValue}`);
            filled++;
            break;
          }
        }
      }
    } catch (e) { /* try next */ }
  }

  if (filled > 0) {
    console.log(`      ✓ answered ${filled} dropdown/radio question(s)`);
  }

  // Everything above needs a <select> or a radio input inside a fieldset. Button
  // and ARIA-based Yes/No widgets are handled here.
  await answerChoiceGroups(page, profile);
}

function pickOption(options, preferences) {
  for (const pref of preferences) {
    const match = options.find(o =>
      o.text.toLowerCase().includes(pref.toLowerCase()) ||
      o.value.toLowerCase().includes(pref.toLowerCase())
    );
    if (match) return match.value;
  }
  return null;
}

// ─────────────────────────────────────────────
// Generic choice-group handling
//
// fillDropdownsAndRadios() above only sees <select> and native
// input[type="radio"] wrapped in a <fieldset>/[role="radiogroup"]. A lot of
// ATS render "Are you legally eligible to work…? [Yes] [No]" as plain
// <button>s, ARIA [role="radio"] divs, or <label> pills — none of which have a
// radio input to .check(). Those questions were silently left blank.
//
// tagChoiceGroups() walks the DOM, groups option elements of ANY of those
// shapes into questions, stamps data-co-group / data-co-opt on them so Node can
// address them, and reports which are already answered.
// ─────────────────────────────────────────────
async function tagChoiceGroups(page) {
  return await page.evaluate(() => {
    document.querySelectorAll('[data-co-group]').forEach((el) => {
      el.removeAttribute('data-co-group');
      el.removeAttribute('data-co-opt');
    });

    // Buttons that navigate or act — never answers to a question.
    const NOISE = /^(submit|apply|send|next|continue|weiter|back|zurück|previous|cancel|abbrechen|close|schließen|upload|hochladen|browse|choose file|datei|attach|add|remove|delete|save|speichern|search|suchen|clear|reset|sign ?in|log ?in|register|accept|akzeptieren|ablehnen|reject|settings|einstellungen|menu|more|show|hide|edit|copy|share|print|help|\+|-|×|x)\b/i;

    const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };

    // ── candidate option elements ──────────────────────────────────────────
    const cands = [];

    for (const r of document.querySelectorAll('input[type="radio"]')) {
      // radios are often visually hidden behind a styled label — don't require
      // the input itself to be visible, only that its label/container is.
      const host = r.closest('label') || r.parentElement;
      if (host && !visible(host) && !visible(r)) continue;
      cands.push({ el: r, kind: 'radio' });
    }

    for (const el of document.querySelectorAll('[role="radio"], [role="option"]')) {
      if (el.querySelector('input[type="radio"]')) continue; // native pass owns it
      if (!visible(el)) continue;
      cands.push({ el, kind: 'aria' });
    }

    const CLICKABLE = 'button, [role="button"], label, a[role="button"], div[class*="option" i], span[class*="option" i], li[class*="option" i], div[class*="toggle" i], div[class*="choice" i]';
    for (const el of document.querySelectorAll(CLICKABLE)) {
      if (el.querySelector('input[type="radio"], input[type="checkbox"], input[type="file"]')) continue;
      if (el.closest('[role="radio"], [role="option"]')) continue;
      if (el.matches('[type="submit"], [type="reset"]')) continue;
      if (el.querySelector('button, [role="button"]')) continue; // container, not a leaf option
      if (el.tagName === 'LABEL') {
        const f = el.getAttribute('for');
        const target = f ? document.getElementById(f) : null;
        if (target && /^(radio|checkbox)$/i.test(target.type || '')) continue; // native pass owns it
      }
      if (!visible(el)) continue;
      const t = txt(el);
      if (!t || t.length > 60 || NOISE.test(t)) continue;
      cands.push({ el, kind: 'click' });
    }

    // Drop wrappers that contain another candidate of the same kind — otherwise
    // a div.option and the label inside it both count as options, and we click
    // the wrapper as well as the real control.
    const nested = new Set();
    for (const a of cands) {
      for (const b of cands) {
        if (a === b || a.kind !== b.kind) continue;
        if (a.el !== b.el && a.el.contains(b.el)) { nested.add(a); break; }
      }
    }
    const options = cands.filter((c) => !nested.has(c));
    cands.length = 0;
    cands.push(...options);

    // ── group candidates into questions ────────────────────────────────────
    const groupOf = new Map(); // container -> {kind, options:[]}
    const containerFor = (c) => {
      if (c.kind === 'radio') {
        const scope = c.el.closest('fieldset, [role="radiogroup"]');
        if (scope) return scope;
        const name = c.el.name;
        if (!name) return c.el.parentElement;
        let p = c.el.parentElement;
        for (let i = 0; p && i < 8; i++, p = p.parentElement) {
          if (p.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`).length >= 2) return p;
        }
        return c.el.parentElement;
      }
      const sameKind = cands.filter((o) => o.kind === c.kind);
      let p = c.el.parentElement;
      for (let i = 0; p && i < 6; i++, p = p.parentElement) {
        if (sameKind.filter((o) => p.contains(o.el)).length >= 2) return p;
      }
      return null;
    };

    for (const c of cands) {
      const container = containerFor(c);
      if (!container) continue;
      if (!groupOf.has(container)) groupOf.set(container, { kind: c.kind, options: [] });
      const g = groupOf.get(container);
      if (g.kind === c.kind) g.options.push(c);
    }

    // ── label + state, then tag ────────────────────────────────────────────
    const optText = (c) => {
      if (c.kind === 'radio') {
        if (c.el.id) {
          const l = document.querySelector(`label[for="${CSS.escape(c.el.id)}"]`);
          if (l && txt(l)) return txt(l);
        }
        const wrap = c.el.closest('label');
        if (wrap && txt(wrap)) return txt(wrap);
        return c.el.value || '';
      }
      return txt(c.el) || c.el.getAttribute('aria-label') || '';
    };

    const labelFor = (container, opts) => {
      const strip = (s) => {
        for (const o of opts) if (o) s = s.split(o).join(' ');
        return s.replace(/\s+/g, ' ').trim();
      };
      let own = strip(txt(container));
      if (own.length >= 8 && own.length <= 300) return own;
      const containerText = txt(container);
      let p = container.parentElement;
      for (let i = 0; p && i < 4; i++, p = p.parentElement) {
        let up = txt(p);
        if (containerText) up = up.split(containerText).join(' ');
        up = strip(up);
        if (up.length >= 8 && up.length <= 300) return up;
      }
      for (let s = container.previousElementSibling, i = 0; s && i < 3; s = s.previousElementSibling, i++) {
        const st = txt(s);
        if (st.length >= 8 && st.length <= 300) return st;
      }
      return own.slice(0, 300);
    };

    const isAnswered = (c) => {
      if (c.kind === 'radio') return c.el.checked;
      const el = c.el;
      if (el.getAttribute('aria-checked') === 'true') return true;
      if (el.getAttribute('aria-selected') === 'true') return true;
      if (el.getAttribute('aria-pressed') === 'true') return true;
      if (el.getAttribute('data-state') === 'checked' || el.getAttribute('data-state') === 'on') return true;
      return /\b(selected|active|checked|is-on|chosen)\b/i.test(el.className || '');
    };

    const out = [];
    let gi = 0;
    for (const [container, g] of groupOf) {
      if (g.options.length < 2 || g.options.length > 12) continue;
      const opts = g.options.map(optText);
      if (opts.filter(Boolean).length < 2) continue;
      if (new Set(opts).size < 2) continue; // identical texts — not a question
      const label = labelFor(container, opts);
      if (!label) continue;
      const answered = g.options.some(isAnswered);
      g.options.forEach((c, oi) => {
        c.el.setAttribute('data-co-group', String(gi));
        c.el.setAttribute('data-co-opt', String(oi));
      });
      out.push({ gi, kind: g.kind, label, options: opts, answered });
      gi++;
    }
    return out;
  });
}

// Truthful answer for a choice question, or null to leave it to the user.
//
// Work authorisation, from config/profile.yml → location.work_authorization:
//   legally permitted to work in Germany TODAY  → "legally eligible?"  = Yes
//   but the permit covers part-time/internships → "need sponsorship?"  = Yes
//   does NOT hold an unrestricted permit/Blue Card yet → "do you hold…?" = No
// Answering "eligible = No" (the previous behaviour) was both untrue and an
// instant filter-out; "eligible = Yes, sponsorship = Yes" is the honest pair.
function decideChoice(label, options, profile) {
  const q = label.toLowerCase();
  const yes = () => matchOption(options, ['yes', 'ja', 'oui', 'true', 'i am', 'i do', 'i can', 'agree']);
  const no = () => matchOption(options, ['no', 'nein', 'non', 'false', 'i am not', 'i do not']);

  if (SENSITIVE_QUESTION.test(q)) return null;

  // Does he already hold an unrestricted permit? No.
  if (/(possess|hold|currently\s+have|already\s+have|do\s+you\s+have)[^?]*?(work\s*permit|arbeitserlaubnis|residence\s*permit|aufenthaltstitel|blue\s*card)/.test(q)) return no();
  // Is he legally allowed to work here? Yes — resident with work rights.
  if (/authoriz|authoris|legally\s+(eligible|entitled|allowed|able)|right\s*to\s*work|eligible\s+to\s+work|permitted\s+to\s+work|arbeitsberechtigt/.test(q)) return yes();
  // Will a full-time contract need sponsorship? Yes.
  if (/(require|need|benötig)[^?]*?(visa|sponsor|sponsorship|work\s*permit)|visa\s*sponsor|sponsorship\s*(is\s*)?(required|needed)/.test(q)) return yes();
  if (/eu\s*citizen|eu\/eea|eea\s*citizen|european\s*citizen|staatsangehörig|eu\s*national/.test(q)) return no();

  // Logistics — Germany-only, relocation-willing, full-time only.
  if (/relocat|umzieh|umzug|willing\s+to\s+move|move\s+to/.test(q)) return yes();
  if (/(work|arbeiten)[^?]*(from|in|at)[^?]*(office|büro)|on-?site|onsite|hybrid|days?\s*(per|a|\/)\s*week\s*(in|at|from)?\s*(the\s*)?(office|büro)?|präsenz|vor\s*ort/.test(q)) return yes();
  if (/\d+\s*(hours?|stunden|std)\s*(per|a|\/|pro)\s*(week|woche)|full[\s-]?time|vollzeit|40\s*h/.test(q)) return yes();
  if (/willing.*travel|reisebereit|travel\s*(requirement|up\s*to)/.test(q)) return yes();
  if (/(18|eighteen)\s*(years|jahre)|of\s*legal\s*age|volljährig/.test(q)) return yes();

  // Prior relationship with the employer.
  if (/(worked|employed|applied)[^?]*(here|for\s+us|at\s+(this|our)|previously|before)|ehemalige|frühere?\s*bewerbung/.test(q)) return no();
  if (/relat(ed|ive)[^?]*(employee|staff|mitarbeiter)|verwandt/.test(q)) return no();
  if (/non-?compete|wettbewerbsverbot/.test(q)) return no();

  return null;
}

// Exact-ish match first (whole word at the start), then substring.
// `\bno\b` deliberately does not match "Not sure" / "Nothing".
function matchOption(options, preferences) {
  for (const pref of preferences) {
    const rx = new RegExp(`^\\s*${escapeRegex(pref)}\\b`, 'i');
    const i = options.findIndex((o) => rx.test(o));
    if (i !== -1) return i;
  }
  for (const pref of preferences) {
    const i = options.findIndex((o) => o.toLowerCase().includes(pref.toLowerCase()));
    if (i !== -1) return i;
  }
  return null;
}

async function clickChoice(page, gi, oi, kind) {
  const el = await page.$(`[data-co-group="${gi}"][data-co-opt="${oi}"]`);
  if (!el) return false;
  if (kind === 'radio') {
    // The input is often visually hidden behind a styled label; check() fails on
    // those, so fall back to clicking whatever the user would actually click.
    try {
      await el.check({ timeout: 3000 });
      return true;
    } catch {
      const host = await el.evaluateHandle((n) => n.closest('label') || n.parentElement);
      try { await host.asElement().click({ timeout: 3000 }); return true; } catch { /* fall through */ }
      try { await el.evaluate((n) => { n.click(); n.dispatchEvent(new Event('change', { bubbles: true })); }); return true; } catch { return false; }
    }
  }
  try {
    await el.click({ timeout: 3000 });
    return true;
  } catch {
    try { await el.evaluate((n) => n.click()); return true; } catch { return false; }
  }
}

// Answers Yes/No and multiple-choice questions built from buttons, ARIA radios
// or bare radio inputs — everything fillDropdownsAndRadios() structurally misses.
async function answerChoiceGroups(page, profile) {
  let groups;
  try { groups = await tagChoiceGroups(page); } catch { return 0; }
  const open = groups.filter((g) => !g.answered);
  if (open.length === 0) return 0;

  let filled = 0;
  const clicked = new Set();
  for (const g of open) {
    const idx = decideChoice(g.label, g.options, profile);
    const short = g.label.slice(0, 60);
    if (idx === null || idx === undefined) {
      console.log(`      ✋ choice "${short}" → NEEDS YOUR ANSWER (${g.options.join(' / ')})`);
      noteGap(page, g.label, 'choice');
      continue;
    }
    if (await clickChoice(page, g.gi, idx, g.kind)) {
      console.log(`      ✓ choice "${short}" → ${g.options[idx]}`);
      clicked.add(g.label);
      filled++;
    } else {
      console.log(`      ✋ choice "${short}" → click failed, NEEDS YOUR ANSWER`);
      noteGap(page, g.label, 'choice');
    }
  }

  // Did the clicks actually take? Custom widgets can swallow a synthetic click,
  // and some plain buttons expose no state at all — say which is which rather
  // than reporting a clicked-but-stateless question as unanswered.
  try {
    const after = await tagChoiceGroups(page);
    const stale = after.filter((g) => !g.answered && clicked.has(g.label));
    const untouched = after.filter((g) => !g.answered && !clicked.has(g.label)).length;
    for (const g of stale) {
      console.log(`      ⚠️ choice "${g.label.slice(0, 60)}" → clicked, but the page shows no selection — CHECK THIS ONE`);
      noteGap(page, g.label, 'choice');
    }
    if (filled > 0) {
      console.log(`      ✓ answered ${filled} choice question(s)${untouched ? `, ${untouched} left for you` : ''}`);
    }
  } catch { /* verification is best-effort */ }

  return filled;
}

// ─────────────────────────────────────────────
// CAPTCHA detection
// ─────────────────────────────────────────────
async function hasCaptcha(page) {
  const captchaSelectors = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="turnstile"]',
    'div.g-recaptcha',
    'div.h-captcha',
    'div[class*="cf-turnstile"]',
    'input[name*="captcha"]',
  ];

  for (const sel of captchaSelectors) {
    const el = await page.$(sel);
    if (el) {
      const visible = await el.isVisible().catch(() => false);
      if (visible) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// Greenhouse form filler
// Returns: number of fields successfully filled
// ─────────────────────────────────────────────
async function fillGreenhouse(page, profile, coverPdf, companyName) {
  console.log('   📝 detected Greenhouse — filling form...');

  // Wait for form to be present
  await page.waitForSelector('input, textarea', { timeout: 15000 }).catch(() => {});

  let filledCount = 0;

  // Common Greenhouse field names (modern Greenhouse uses candidate[*] or specific names)
  const fields = [
    { selector: 'input[name="first_name"], input[id="first_name"], input[autocomplete="given-name"]', value: profile.firstName },
    { selector: 'input[name="last_name"], input[id="last_name"], input[autocomplete="family-name"]', value: profile.lastName },
    { selector: 'input[name="email"], input[id="email"], input[type="email"], input[autocomplete="email"], input[name*="email"]', value: profile.email },
    { selector: 'input[name="phone"], input[id="phone"], input[type="tel"], input[autocomplete="tel"]', value: profile.phone },
    { selector: 'input[name*="linkedin"], input[id*="linkedin"], input[placeholder*="LinkedIn"], input[placeholder*="linkedin"]', value: profile.linkedin },
    { selector: 'input[name*="website"], input[id*="website"], input[name*="portfolio"]', value: profile.website },
  ];

  for (const { selector, value } of fields) {
    if (!value) continue;
    try {
      const input = await page.$(selector);
      if (input) {
        await input.fill(value);
        console.log(`      ✓ filled ${selector.split(',')[0]}`);
        filledCount++;
      }
    } catch (e) { /* ignore */ }
  }

  // Store result for verification
  page._fillStats = page._fillStats || {};
  page._fillStats.filled = filledCount;

  // Documents: generic uploader (handles unlabeled inputs + German field names)
  const uploadedCover = await uploadDocuments(page, coverPdf);

  // Cover letter text fallback — only when no cover file input accepted the PDF
  try {
    if (!uploadedCover) {
      // Fallback: paste the real letter text into the cover letter textarea
      const coverTextarea = await page.$('textarea[name*="cover"], textarea[id*="cover"]');
      if (coverTextarea) {
        let coverText = 'Please see attached cover letter PDF and CV.';
        const coverMd = coverPdf ? coverPdf.replace(/\.pdf$/, '.md') : null;
        if (coverMd && existsSync(coverMd)) {
          coverText = readFileSync(coverMd, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim();
        }
        await coverTextarea.fill(coverText);
        console.log(`      ✓ filled cover letter textarea (${coverText.length > 100 ? 'full letter text' : 'reference note'})`);
      }
    }
  } catch (e) {
    console.log(`      ⚠️ cover letter upload failed: ${e.message}`);
  }

  // Scroll through the form so React-Select dropdowns render
  await page.evaluate(() => window.scrollBy(0, window.innerHeight));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollBy(0, window.innerHeight));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  // Handle native <select> dropdowns + radio buttons
  await fillDropdownsAndRadios(page, profile);
  // Handle React-Select dropdowns (modern Greenhouse)
  const reactFilled = await fillReactSelectDropdowns(page, profile);
  if (reactFilled > 0) console.log(`      ✓ ${reactFilled} React-Select dropdowns answered`);
  // Fill custom textareas (motivation, salary, etc.)
  const taFilled = await fillCustomTextareas(page, profile, companyName);
  if (taFilled > 0) console.log(`      ✓ ${taFilled} open-text questions answered`);
  // Fill custom short-text inputs (LinkedIn, GitHub, current location, contact number, etc.)
  const tiFilled = await fillCustomTextInputs(page, profile, companyName);
  if (tiFilled > 0) console.log(`      ✓ ${tiFilled} short-answer field(s) answered`);
  // Fill date-picker fields (start date)
  const dateFilled = await fillDateFields(page, profile);
  if (dateFilled > 0) console.log(`      ✓ ${dateFilled} date field(s) answered`);
  // Check required consent checkboxes (terms, privacy)
  const cbChecked = await checkRequiredCheckboxes(page);
  if (cbChecked > 0) console.log(`      ✓ ${cbChecked} required checkbox(es) checked`);
}

// ─────────────────────────────────────────────
// Ashby form filler
// ─────────────────────────────────────────────
async function fillAshby(page, profile, coverPdf, companyName) {
  console.log('   📝 detected Ashby — filling form...');
  let filledCount = 0;

  // Click "Apply" button if there's one
  try {
    const applyBtn = await page.$('button:has-text("Apply"), a:has-text("Apply")');
    if (applyBtn) {
      await applyBtn.click();
      await page.waitForTimeout(1500);
    }
  } catch (e) { /* ignore */ }

  // Ashby uses _systemfield prefix
  const fields = [
    { selector: 'input[id*="_systemfield_name"], input[name="_systemfield_name"]', value: `${profile.firstName} ${profile.lastName}` },
    { selector: 'input[id*="name"][name*="name"]:not([name*="last"])', value: profile.firstName + ' ' + profile.lastName },
    { selector: 'input[id*="_systemfield_email"], input[type="email"]', value: profile.email },
    { selector: 'input[type="tel"], input[id*="phone"]', value: profile.phone },
    { selector: 'input[id*="linkedin"], input[name*="linkedin"]', value: profile.linkedin },
  ];

  for (const { selector, value } of fields) {
    if (!value) continue;
    try {
      const input = await page.$(selector);
      if (input) {
        await input.fill(value);
        console.log(`      ✓ filled ${selector.split(',')[0]}`);
        filledCount++;
      }
    } catch (e) { /* ignore */ }
  }
  page._fillStats = { filled: filledCount };

  // Documents: CV + cover letter (Ashby splits these across separate inputs)
  await uploadDocuments(page, coverPdf);

  // Scroll so lazily-mounted custom questions (React-Select, open-text) render
  // before we scan for them — Ashby forms load these below the fold.
  await page.evaluate(() => window.scrollBy(0, window.innerHeight));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // Same generic fillers as Greenhouse — Ashby forms use the same custom-question
  // patterns (React-Select dropdowns, open-text textareas, consent checkboxes)
  // that this filler was previously skipping entirely.
  await fillDropdownsAndRadios(page, profile);
  const reactFilled = await fillReactSelectDropdowns(page, profile);
  if (reactFilled > 0) console.log(`      ✓ ${reactFilled} React-Select dropdowns answered`);
  const taFilled = await fillCustomTextareas(page, profile, companyName);
  if (taFilled > 0) console.log(`      ✓ ${taFilled} open-text questions answered`);
  const tiFilled = await fillCustomTextInputs(page, profile, companyName);
  if (tiFilled > 0) console.log(`      ✓ ${tiFilled} short-answer field(s) answered`);
  const dateFilled = await fillDateFields(page, profile);
  if (dateFilled > 0) console.log(`      ✓ ${dateFilled} date field(s) answered`);
  const cbChecked = await checkRequiredCheckboxes(page);
  if (cbChecked > 0) console.log(`      ✓ ${cbChecked} required checkbox(es) checked`);
}

// ─────────────────────────────────────────────
// Lever form filler
// ─────────────────────────────────────────────
async function fillLever(page, profile, coverPdf, companyName) {
  console.log('   📝 detected Lever — filling form...');
  let filledCount = 0;

  // Click "Apply" if needed
  try {
    const applyBtn = await page.$('a:has-text("Apply for this job"), button:has-text("Apply")');
    if (applyBtn) {
      await applyBtn.click();
      await page.waitForTimeout(1500);
    }
  } catch (e) { /* ignore */ }

  const fields = [
    { selector: 'input[name="name"]', value: `${profile.firstName} ${profile.lastName}` },
    { selector: 'input[name="email"]', value: profile.email },
    { selector: 'input[name="phone"]', value: profile.phone },
    { selector: 'input[name="urls[LinkedIn]"]', value: profile.linkedin },
  ];

  for (const { selector, value } of fields) {
    if (!value) continue;
    try {
      const input = await page.$(selector);
      if (input) {
        await input.fill(value);
        console.log(`      ✓ filled ${selector}`);
        filledCount++;
      }
    } catch (e) { /* ignore */ }
  }
  page._fillStats = { filled: filledCount };

  await uploadDocuments(page, coverPdf);

  await fillDropdownsAndRadios(page, profile);
  const taFilled = await fillCustomTextareas(page, profile, companyName);
  if (taFilled > 0) console.log(`      ✓ ${taFilled} open-text questions answered`);
  const tiFilled = await fillCustomTextInputs(page, profile, companyName);
  if (tiFilled > 0) console.log(`      ✓ ${tiFilled} short-answer field(s) answered`);
  const dateFilled = await fillDateFields(page, profile);
  if (dateFilled > 0) console.log(`      ✓ ${dateFilled} date field(s) answered`);
}

// ─────────────────────────────────────────────
// Generic document uploader.
// File inputs are frequently unlabeled, renamed per-ATS, or German ("Lebenslauf",
// "Anschreiben"), and are often visually hidden behind a styled button — so match
// on every attribute we can see and fall back to positional assignment
// (first input = CV, second = cover letter). setInputFiles works on hidden inputs.
// Returns true if the cover letter PDF was attached.
// ─────────────────────────────────────────────
const CV_WORDS = /resume|cv\b|lebenslauf|curriculum/i;
const COVER_WORDS = /cover|letter|anschreiben|motivation|bewerbungsschreiben/i;

// Finds every file input on the page, including inside iframes (embedded
// Greenhouse boards live in #grnhse_iframe — page.$$ never saw them, so those
// applications went out with no CV attached at all) and including inputs that
// only get created after clicking an "Attach"/"Upload" button.
async function findFileInputs(page) {
  const collect = async () => {
    const found = [];
    for (const frame of page.frames()) {
      try { found.push(...await frame.$$('input[type="file"]')); } catch { /* detached */ }
    }
    return found;
  };

  let inputs = await collect();
  if (inputs.length > 0) return inputs;

  // Nothing yet — some forms render the input only once the upload UI is opened.
  const REVEAL = /attach|upload|hochladen|datei|lebenslauf|anschreiben|resume|cv\b|add file|choose file/i;
  // Never click something that might send the application while hunting for a
  // file field — this runs unattended and submission is the user's decision.
  const SUBMITTY = /submit|send|absenden|bewerbung abschicken|apply now|jetzt bewerben|finish|complete application/i;
  for (const frame of page.frames()) {
    let buttons = [];
    try { buttons = await frame.$$('button, [role="button"], label, a'); } catch { continue; }
    for (const b of buttons) {
      try {
        if (!(await b.isVisible().catch(() => false))) continue;
        if (await b.evaluate(n => n.type === 'submit' || n.closest('[type="submit"]') !== null).catch(() => false)) continue;
        const t = (await b.textContent().catch(() => '')) || '';
        if (!REVEAL.test(t) || SUBMITTY.test(t)) continue;
        await b.click({ timeout: 2000 });
        await page.waitForTimeout(300);
        inputs = await collect();
        if (inputs.length > 0) {
          console.log(`      ℹ️ upload field appeared after clicking "${t.trim().slice(0, 30)}"`);
          return inputs;
        }
      } catch { /* try next */ }
    }
  }
  return inputs;
}

// Confirms the browser actually holds the file — setInputFiles can be silently
// undone by a form that re-renders, and a "✓ uploaded" log with no attachment
// is worse than no log at all.
async function fileAttached(el) {
  return await el.evaluate(n => n.files && n.files.length > 0).catch(() => false);
}

async function uploadDocuments(page, coverPdf) {
  let uploadedCv = false, uploadedCover = false;
  const cvElements = [];
  try {
    const inputs = await findFileInputs(page);
    if (inputs.length === 0) {
      console.log('      ⚠️ no file upload field found anywhere on the page (incl. iframes) — ATTACH CV MANUALLY');
      return false;
    }

    // Describe each input from its own attributes plus nearby label text
    const described = [];
    for (const el of inputs) {
      const desc = await el.evaluate(node => {
        const near = node.closest('div,label,fieldset,li');
        return [
          node.name, node.id, node.getAttribute('aria-label'),
          node.getAttribute('data-testid'), node.getAttribute('accept'),
          near ? (near.textContent || '').slice(0, 120) : '',
        ].filter(Boolean).join(' ');
      }).catch(() => '');
      described.push({ el, desc });
    }

    // Pass 1: explicit matches.
    // CV goes into EVERY resume-ish input: forms often pair an optional
    // "autofill from resume" widget with the actual required resume field, and
    // filling only the first leaves the required one empty (seen on Ashby).
    for (const { el, desc } of described) {
      if (CV_WORDS.test(desc) && !COVER_WORDS.test(desc)) {
        await el.setInputFiles(activeCvPdf);
        if (await fileAttached(el)) {
          console.log(`      ✓ uploaded CV PDF${uploadedCv ? ' (additional resume field)' : ''}`);
          uploadedCv = true;
          cvElements.push(el);
        } else {
          console.log('      ⚠️ CV upload did not stick on a resume field — retrying');
          await el.setInputFiles(activeCvPdf).catch(() => {});
          if (await fileAttached(el)) { uploadedCv = true; cvElements.push(el); console.log('      ✓ uploaded CV PDF (on retry)'); }
        }
      } else if (!uploadedCover && COVER_WORDS.test(desc) && coverPdf && existsSync(coverPdf)) {
        await el.setInputFiles(coverPdf);
        if (await fileAttached(el)) {
          console.log('      ✓ uploaded cover letter PDF');
          uploadedCover = true;
        }
      }
    }

    // Pass 2: positional fallback for inputs that named nothing useful
    const unmatched = described.filter(d => !CV_WORDS.test(d.desc) && !COVER_WORDS.test(d.desc));
    for (const { el } of unmatched) {
      if (!uploadedCv) {
        await el.setInputFiles(activeCvPdf);
        if (await fileAttached(el)) {
          console.log('      ✓ uploaded CV PDF (unlabeled field)');
          uploadedCv = true;
          cvElements.push(el);
        }
      } else if (!uploadedCover && coverPdf && existsSync(coverPdf)) {
        await el.setInputFiles(coverPdf);
        if (await fileAttached(el)) {
          console.log('      ✓ uploaded cover letter PDF (unlabeled field)');
          uploadedCover = true;
        }
      }
    }

    // Pass 3: some ATSes (Ashby single-upload forms) offer only one resume
    // slot and no separate cover-letter field at all. If that slot accepts
    // multiple files, attach the cover letter alongside the CV there instead
    // of dropping it silently.
    if (!uploadedCover && coverPdf && existsSync(coverPdf)) {
      for (const el of cvElements) {
        const allowsMultiple = await el.evaluate(node => node.multiple).catch(() => false);
        if (allowsMultiple) {
          await el.setInputFiles([activeCvPdf, coverPdf]);
          console.log('      ✓ uploaded cover letter PDF (combined with CV in multi-file field)');
          uploadedCover = true;
          break;
        }
      }
    }

    // Loud, unambiguous final state — a missing CV is an application-killer and
    // must not be buried among the ✓ lines.
    if (!uploadedCv) console.log('      🚨 CV NOT ATTACHED — attach it by hand before submitting');
    else console.log('      ✅ CV attached');
    if (!uploadedCover) {
      if (!coverPdf || !existsSync(coverPdf)) console.log('      ⚠️ no cover letter PDF was generated for this job — nothing to attach');
      else console.log('      ℹ️ no cover letter upload field — will try text field / attach manually');
    }
  } catch (e) {
    console.log(`      ⚠️ document upload failed: ${e.message}`);
  }
  return uploadedCover;
}

// ─────────────────────────────────────────────
// AI answer pass — draft tailored answers for questions the pattern rules missed.
// Runs AFTER the rule-based fill: rescans for still-empty visible textareas and
// unselected dropdowns, sends them (with the report for context) to one headless
// haiku call, fills what comes back. Truly sensitive fields are never sent and
// stay flagged for the user; everything is reviewed at the pause before submit.
// ─────────────────────────────────────────────
const SENSITIVE_QUESTION = /reference|referee|clearance|criminal|convict|background\s*check|ssn|social\s*security|passport|ausweis|id\s*number|salary\s*history|straf/i;

// Recovers the actual question text for a form field.
//
// The old version fell back to node.placeholder, so an Ashby custom question
// whose label lives in a sibling <div> (not a <label for=…>) was reported to the
// AI worker as the question "Type here..." — which is unanswerable, so every
// genuinely open question ("What's the most impressive thing you've done?")
// came back SKIP or nonsense and the field stayed empty.
//
// Runs in page context via el.evaluate(), so it must be self-contained.
function questionLabelInPage(node) {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // Placeholder chrome that is not a question.
  const GENERIC = /^(type here|type your answer|your answer|answer|antwort|response|enter (your )?answer|hier tippen|deine antwort|optional|required|pflichtfeld|text|write here|e\.?g\.?|select|choose)[.…:\s]*$/i;
  const good = (s) => {
    s = clean(s);
    return s.length >= 8 && s.length <= 400 && !GENERIC.test(s);
  };

  const byRef = node.getAttribute('aria-labelledby');
  if (byRef) {
    const t = byRef.split(/\s+/)
      .map((id) => { const e = document.getElementById(id); return e ? clean(e.textContent) : ''; })
      .filter(Boolean).join(' ');
    if (good(t)) return clean(t);
  }
  if (good(node.getAttribute('aria-label'))) return clean(node.getAttribute('aria-label'));

  if (node.id) {
    const l = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
    if (l && good(l.textContent)) return clean(l.textContent);
  }
  const wrap = node.closest('label');
  if (wrap && good(wrap.textContent)) return clean(wrap.textContent);

  // Walk outward for a label-ish sibling, but STOP as soon as the ancestor
  // covers more than one field: a container holding two questions can't tell us
  // which one this field belongs to, and grabbing the wrong neighbour's prompt
  // is worse than returning nothing.
  const FIELDS = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, select, [contenteditable="true"], [role="textbox"]';
  const LABELISH = ['label', 'legend', '[class*="label" i]', '[class*="question" i]', '[class*="title" i]', '[class*="prompt" i]', 'h2', 'h3', 'h4', 'h5', 'p'];
  let p = node.parentElement;
  for (let i = 0; p && i < 6 && p !== document.body; i++, p = p.parentElement) {
    if (p.querySelectorAll(FIELDS).length > 1) break;
    for (const sel of LABELISH) {
      for (const c of p.querySelectorAll(sel)) {
        if (c.contains(node) || c.querySelector(FIELDS)) continue;
        if (good(c.textContent)) return clean(c.textContent);
      }
    }
    if (good(p.textContent)) return clean(p.textContent);
  }

  for (let s = node.previousElementSibling, i = 0; s && i < 4; s = s.previousElementSibling, i++) {
    if (s.querySelector(FIELDS) || s.matches(FIELDS)) break; // that's another question's field
    if (good(s.textContent)) return clean(s.textContent);
  }

  // Only trust a placeholder if it actually says something.
  const ph = node.getAttribute('placeholder');
  return good(ph) ? clean(ph) : '';
}

async function aiAnswerUnknowns(page, report) {
  if (!AI_ANSWERS) return 0;

  const getLabel = (el) => el.evaluate(questionLabelInPage);

  // Collect still-open questions
  const items = [];
  const seen = new Set();

  for (const ta of await page.$$('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')) {
    try {
      if (!(await ta.isVisible().catch(() => false))) continue;
      const current = await ta.evaluate(n =>
        (n.tagName === 'TEXTAREA' || n.tagName === 'INPUT' ? n.value : n.innerText || n.textContent) || ''
      ).catch(() => '');
      if (current.trim()) continue;
      const name = ((await ta.getAttribute('name')) || '').toLowerCase();
      if (name.includes('cover')) continue;
      const label = (await getLabel(ta)).replace(/\s+/g, ' ').trim();
      if (!label || SENSITIVE_QUESTION.test(label)) continue;
      if (seen.has(label)) continue;
      seen.add(label);
      items.push({ type: 'TEXT', label, el: ta, long: true });
    } catch { /* next */ }
  }
  // Short-text/url custom inputs the deterministic pass didn't recognize
  // (fillCustomTextInputs already handled anything matchable from profile data).
  for (const input of await page.$$('input[type="text"], input[type="url"]')) {
    try {
      if (!(await input.isVisible().catch(() => false))) continue;
      if ((await input.inputValue()).trim()) continue;
      const name = ((await input.getAttribute('name')) || '').toLowerCase();
      const id = ((await input.getAttribute('id')) || '').toLowerCase();
      if (name.includes('cover') || id.includes('cover')) continue;
      const label = (await getLabel(input)).replace(/\s+/g, ' ').trim();
      if (!label || SENSITIVE_QUESTION.test(label)) continue;
      if (seen.has(label)) continue;
      seen.add(label);
      items.push({ type: 'TEXT', label, el: input, long: false });
    } catch { /* next */ }
  }
  for (const sel of await page.$$('select')) {
    try {
      if (!(await sel.isVisible().catch(() => false))) continue;
      const val = await sel.evaluate(el => el.value);
      if (val && val !== '' && val !== '0') continue;
      const label = (await getLabel(sel)).replace(/\s+/g, ' ').trim();
      if (!label || SENSITIVE_QUESTION.test(label)) continue;
      const options = (await sel.$$eval('option', opts => opts.map(o => o.textContent.trim())))
        .filter(t => t && !/select|choose|wählen|bitte/i.test(t));
      if (options.length === 0) continue;
      items.push({ type: 'CHOICE', label, options, el: sel });
    } catch { /* next */ }
  }
  // Choice groups still unanswered after the rule-based pass — radios, ARIA
  // radios and button/label pills alike. decideChoice() only knows a handful of
  // phrasings; the AI worker handles the rest.
  try {
    for (const g of await tagChoiceGroups(page)) {
      if (g.answered) continue;
      const label = g.label.replace(/\s+/g, ' ').trim();
      if (!label || SENSITIVE_QUESTION.test(label)) continue;
      const options = g.options.filter(Boolean);
      if (options.length < 2) continue;
      items.push({ type: 'CHOICE', label, options: g.options, choice: g });
    }
  } catch { /* choice detection is best-effort */ }
  if (items.length === 0) return 0;

  console.log(`   🤖 asking AI to draft ${items.length} open answer(s)...`);
  const contextFile = join(PROJECT_DIR, 'batch', '.qa-context.md');
  writeFileSync(contextFile, [
    `COMPANY: ${report.company}`,
    `ROLE: ${report.role}`,
    `REPORT: reports/${report.fname || ''}`,
    '',
    '## Questions',
    '',
    ...items.map((q, i) => q.type === 'CHOICE'
      ? `${i}. CHOICE: ${q.label}\n   OPTIONS: ${q.options.join(' | ')}`
      : `${i}. ${q.long ? 'TEXT_LONG' : 'TEXT_SHORT'}: ${q.label}`),
    '',
  ].join('\n'), 'utf8');

  const res = spawnSync('claude', [
    '-p',
    '--dangerously-skip-permissions',
    '--append-system-prompt-file', 'batch/qa-worker-prompt.md',
    '--model', AI_MODEL,
    '"Answer the application questions in batch/.qa-context.md. Follow your system instructions exactly. Output only the JSON object."',
  ], { cwd: PROJECT_DIR, encoding: 'utf8', shell: true, timeout: 240_000 });

  let answers = [];
  try {
    const json = (res.stdout || '').match(/\{[\s\S]*\}/);
    answers = JSON.parse(json[0]).answers || [];
  } catch {
    // Say why — a silent "left for you" hid worker crashes (bad model name,
    // missing prompt file, timeout) behind what looked like a normal skip.
    const why = res.error ? res.error.message
      : res.status !== 0 ? `worker exited ${res.status}: ${(res.stderr || '').trim().slice(0, 200)}`
      : `no JSON in output: ${(res.stdout || '').trim().slice(0, 200)}`;
    console.log(`   ⚠️ AI answer pass produced nothing (${why})`);
    console.log(`   ✋ ${items.length} question(s) left for you: ${items.map(q => q.label.slice(0, 40)).join(' | ')}`);
    return 0;
  }

  let filled = 0;
  for (const a of answers) {
    const q = items[a.i];
    if (!q || !a.answer || a.answer === 'SKIP') {
      if (q) console.log(`      ✋ "${q.label.slice(0, 60)}" → AI skipped, NEEDS YOUR ANSWER`);
      noteGap(page, q.label, 'question');
      continue;
    }
    try {
      if (q.type === 'TEXT') {
        await q.el.fill(a.answer);
        // Rich-text editors sometimes ignore fill(); confirm the text landed.
        const got = await q.el.evaluate(n =>
          (n.tagName === 'TEXTAREA' || n.tagName === 'INPUT' ? n.value : n.innerText || n.textContent) || ''
        ).catch(() => '');
        if (!got.trim()) {
          await q.el.click().catch(() => {});
          await q.el.type(a.answer, { delay: 0 }).catch(() => {});
        }
        console.log(`      🤖 "${q.label.slice(0, 50)}" → ${a.answer.slice(0, 60)}...`);
        filled++;
      } else if (q.choice) {
        const want = a.answer.toLowerCase().trim();
        let i = q.options.findIndex(o => o.toLowerCase().trim() === want);
        if (i === -1) i = q.options.findIndex(o => o && (o.toLowerCase().includes(want) || want.includes(o.toLowerCase())));
        if (i !== -1 && await clickChoice(page, q.choice.gi, i, q.choice.kind)) {
          console.log(`      🤖 choice "${q.label.slice(0, 50)}" → ${q.options[i]}`);
          filled++;
        } else if (i === -1) {
          console.log(`      ✋ choice "${q.label.slice(0, 50)}" → AI chose unlisted option, NEEDS YOUR ANSWER`);
          noteGap(page, q.label, 'choice');
        } else {
          console.log(`      ✋ choice "${q.label.slice(0, 50)}" → click failed, NEEDS YOUR ANSWER`);
          noteGap(page, q.label, 'choice');
        }
      } else {
        const match = await q.el.$$eval('option', (opts, want) => {
          const hit = opts.find(o => o.textContent.trim().toLowerCase() === want.toLowerCase())
                   || opts.find(o => o.textContent.trim().toLowerCase().includes(want.toLowerCase()));
          return hit ? hit.value : null;
        }, a.answer);
        if (match !== null) {
          await q.el.selectOption(match);
          console.log(`      🤖 dropdown "${q.label.slice(0, 50)}" → ${a.answer.slice(0, 40)}`);
          filled++;
        } else {
          console.log(`      ✋ dropdown "${q.label.slice(0, 50)}" → AI chose unlisted option, NEEDS YOUR ANSWER`);
          noteGap(page, q.label, 'dropdown');
        }
      }
    } catch { /* element went stale — user handles it at the pause */ }
  }
  return filled;
}

// ─────────────────────────────────────────────
// Final gap check — what none of the fillers could answer
//
// Every filler already logs the fields it gives up on (✋), but by the time you
// look at the browser window that output has scrolled past, and the page itself
// gives no clue which of forty inputs is still blank. So the last act before
// handing over is to find every REQUIRED field that is still empty, outline it
// in red, and pin a checklist to the corner of the page. The window then carries
// its own to-do list, and "review and submit" is a job you can actually finish.
//
// Deliberately conservative about what counts as empty: a false "you must fill
// this" costs you a hunt for a field that is already fine, so combobox widgets
// that park their value outside the <input> are treated as filled.
// ─────────────────────────────────────────────
async function auditRequiredFields(page) {
  try {
    const fieldGaps = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return false;
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
      };

      const lab = (el) => {
        const by = el.getAttribute('aria-labelledby');
        if (by) {
          const t = by.split(/\s+/).map(id => clean(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
          if (t) return t;
        }
        if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
        if (el.id) {
          const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (l) return clean(l.textContent);
        }
        const wrap = el.closest('label');
        if (wrap) return clean(wrap.textContent);
        let p = el.parentElement;
        for (let i = 0; p && i < 4 && p !== document.body; i++, p = p.parentElement) {
          const t = clean(p.querySelector('label, legend, [class*="label" i], [class*="question" i]')?.textContent);
          if (t) return t;
        }
        return clean(el.getAttribute('placeholder')) || clean(el.name) || clean(el.id) || 'unnamed field';
      };

      // The asterisk usually lives in the label, not on the input — Greenhouse
      // and Ashby both mark required fields that way and set no `required` attr.
      const required = (el, label) =>
        el.required ||
        el.getAttribute('aria-required') === 'true' ||
        /\*\s*$|\(required\)|\(pflichtfeld\)|erforderlich|obligatoire/i.test(label);

      const gaps = [];
      const seenGroup = new Set();
      const controls = [...document.querySelectorAll(
        'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select, [contenteditable="true"]'
      )];

      for (const el of controls) {
        if (!visible(el) || el.disabled || el.readOnly) continue;

        const type = (el.type || el.tagName).toLowerCase();
        let empty = false;
        let kind = 'text';
        let label = null;

        if (type === 'file') {
          empty = !el.files || el.files.length === 0;
          kind = 'upload';
          // Ashby puts a second, permanently-empty input behind the "Replace"
          // button of an upload that already holds a file. Its own .files is
          // empty by design, so reporting it sends you hunting for a CV that is
          // already attached. If the widget right around it is displaying a
          // filename, the file is there. Bounded to 3 ancestors and a short
          // block of text so this cannot swallow a genuinely missing upload.
          if (empty) {
            let box = el.parentElement;
            for (let i = 0; box && i < 5; i++, box = box.parentElement) {
              const t = clean(box.textContent);
              if (t.length < 800 && /\.(pdf|docx?|rtf|odt)\b/i.test(t)) { empty = false; break; }
            }
          }
        } else if (type === 'radio' || type === 'checkbox') {
          kind = 'choice';
          const name = el.name;
          if (name) {
            if (seenGroup.has(name)) continue;
            seenGroup.add(name);
            const group = [...document.querySelectorAll(`input[type="${type}"][name="${CSS.escape(name)}"]`)];
            empty = !group.some(g => g.checked);
          } else {
            empty = !el.checked;
          }
          // For a choice group the input's own label is one OPTION ("Yes"), not
          // the question. The legend is what you actually need to read.
          const legend = el.closest('fieldset')?.querySelector('legend');
          if (legend) label = clean(legend.textContent);
        } else if (el.tagName === 'SELECT') {
          kind = 'dropdown';
          empty = !el.value || /^(select|choose|please|bitte|--)/i.test(el.value.trim());
        } else if (el.isContentEditable) {
          empty = !clean(el.textContent);
        } else {
          empty = !clean(el.value);
        }

        if (!empty) continue;

        // react-select / Ashby comboboxes keep the chosen value in a sibling
        // node and leave the real <input> blank, so blank is not proof of empty.
        if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete')) {
          const box = el.closest('[class*="select" i], [class*="Select" i]');
          if (box?.querySelector('[class*="singleValue" i], [class*="single-value" i], [class*="multiValue" i], [class*="multi-value" i]')) continue;
        }

        label = label || lab(el);
        if (!required(el, label)) continue;

        gaps.push({ label: label.replace(/\s*\*\s*$/, '').slice(0, 90), kind });
        try {
          el.style.outline = '2px solid #d93025';
          el.style.outlineOffset = '1px';
        } catch { /* some widgets refuse inline styles */ }
      }

      return gaps;
    });

    // Ashby and friends build their choice questions out of buttons and divs,
    // not <input type=radio>, so the scan above cannot see them — the first
    // version of this audit announced "every required field is filled" on a form
    // with three unanswered questions, which is worse than saying nothing.
    // tagChoiceGroups() already knows how to find those widgets and whether one
    // is answered, so ask it rather than re-deriving it here.
    let choiceGaps = [];
    let answeredNow = new Set();
    try {
      // Upload widgets get grouped as pseudo-questions ("cv-updated.pdf or drag
      // and drop here"); they are not questions and must not reach the checklist.
      // A second kind of non-question reaches the grouper: containers whose
      // label is a run of OTHER fields' labels ("Vorname* Nachname* E-Mail*
      // Telefon*..."). Two or more required-markers in one label is the tell —
      // no real question carries them.
      // Also drop calendar innards: an OPEN date picker exposes its day cells as
      // a choice group, so the checklist fills up with "2 3 4 5 6 7 8 9 0 2 3".
      // A label with almost no letters is never a question.
      const JUNK = (t) => /drag and drop|\.pdf\b|^replace\b/i.test(t)
        || (t.match(/\*/g) ?? []).length >= 2
        || (t.replace(/[^a-zà-ÿ]/gi, '').length < Math.max(4, t.length * 0.3));
      const groups = await tagChoiceGroups(page);
      if (process.env.CO_DEBUG_GAPS) console.log(`   [debug] tagChoiceGroups → ${groups.length}: ${JSON.stringify(groups.map(g => [g.label.slice(0, 40), g.answered]))}`);
      choiceGaps = groups
        .filter(g => !g.answered && !JUNK(g.label))
        .map(g => ({ label: g.label.slice(0, 90), kind: 'choice', gi: g.gi }));
      // A question the fill phase gave up on may have taken the answer anyway
      // (the click lands, the widget reports it a beat later). If the page says
      // it is answered now, the page is right and the old complaint is stale.
      answeredNow = new Set(groups.filter(g => g.answered).map(g => g.label.slice(0, 90).toLowerCase()));

      for (const g of choiceGaps) {
        for (const el of await page.$$(`[data-co-group="${g.gi}"]`)) {
          await el.evaluate(n => { n.style.outline = '2px solid #d93025'; }).catch(() => {});
        }
      }
    } catch { /* choice tagging is best-effort */ }

    // Merge in what the fillers already told us they could not answer. A widget
    // the audit can no longer see is not a widget that got answered, and the
    // fill phase is the only place that knows the difference — so its record
    // wins over the re-scan finding nothing.
    const JUNK_LABEL = (t) => /drag and drop|\.pdf\b|^replace\b/i.test(t)
      || (t.match(/\*/g) ?? []).length >= 2
      || (t.replace(/[^a-zà-ÿ]/gi, '').length < Math.max(4, t.length * 0.3));
    const detected = [...fieldGaps, ...choiceGaps.map(({ label, kind }) => ({ label, kind }))];
    const seen = new Set(detected.map(g => g.label.toLowerCase()));
    const remembered = [...(page._openQuestions ?? new Map())]
      .filter(([label]) => !seen.has(label.toLowerCase())
        && !answeredNow.has(label.toLowerCase())
        && !JUNK_LABEL(label))
      .map(([label, kind]) => ({ label, kind }));
    const gaps = [...detected, ...remembered];

    await page.evaluate((list) => {
      const esc = (s) => s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      document.getElementById('career-ops-gaps')?.remove();
      if (!list.length) return;
      const panel = document.createElement('div');
      panel.id = 'career-ops-gaps';
      panel.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;max-width:340px;' +
        'max-height:70vh;overflow:auto;background:#fff;color:#111;border:2px solid #d93025;' +
        'border-radius:8px;padding:12px 14px;font:13px/1.45 system-ui,sans-serif;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.25)';
      panel.innerHTML =
        `<div style="font-weight:700;margin-bottom:6px">${list.length} field(s) still need you</div>` +
        `<ol style="margin:0;padding-left:18px">${list.map(g =>
          `<li style="margin:3px 0">${esc(g.label)} <span style="opacity:.6">(${g.kind})</span></li>`).join('')}</ol>` +
        `<div style="margin-top:8px;opacity:.7">Red outline = still needs you. Fill these, then Submit.</div>`;
      document.body.appendChild(panel);
    }, gaps).catch(() => {});

    return gaps;
  } catch (e) {
    // A page that blocks evaluation still gets handed over — just without the
    // checklist. Never let the audit be the reason an application dies. But say
    // so out loud: a silent catch here reports "every required field is filled"
    // on a form it never managed to read, which is the one answer that must
    // never be guessed.
    console.log(`   ⚠️ gap audit failed (${e.message}) — check the form yourself`);
    return [];
  }
}

// SPA application forms (Ashby, Greenhouse's React board) render AFTER the
// document is ready. Counting fields on domcontentloaded therefore finds zero,
// the run gives up with "form likely not detected", and the window is handed
// over blank — for a form that appeared a second later. Waiting for a real
// control to exist is the difference between a filled application and an empty
// one, and costs nothing when the form is already there.
async function waitForForm(page, timeout = 15000) {
  await page.waitForSelector(
    'input[type="text"], input[type="email"], input[type="tel"], textarea, input[type="file"]',
    { timeout, state: 'attached' },
  ).catch(() => {});
}

// Questions the fillers gave up on, remembered on the page object (same
// convention as page._fillStats) so the final audit can still report them.
//
// Necessary because the audit cannot always re-find the widget: Ashby re-renders
// its custom choice controls after the AI pass types into a field, so a re-scan
// returns nothing at all. The questions are still unanswered, and "I could not
// detect anything" must never be printed as "nothing is missing".
function noteGap(page, label, kind = 'question') {
  const text = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!page || !text) return;
  if (!page._openQuestions) page._openQuestions = new Map();
  page._openQuestions.set(text.slice(0, 90), kind);
}

// ─────────────────────────────────────────────
// Cover letter PDF resolution
// Letters are generated as .md by the daily pipeline; filenames use a different
// slugifier than this script, so match by report number prefix — never rebuild
// the exact name. Render md → pdf on the fly when only the .md exists.
// ─────────────────────────────────────────────
async function ensureCoverPdf(browser, num, langSlug) {
  if (!existsSync(COVER_DIR)) return null;
  const files = readdirSync(COVER_DIR).filter(f => f.startsWith(`${num}-`));
  const pick = (ext) =>
    files.find(f => f.endsWith(`-${langSlug}${ext}`)) || files.find(f => f.endsWith(ext));
  const pdf = pick('.pdf');
  if (pdf) return join(COVER_DIR, pdf);
  const md = pick('.md');
  if (!md) return null;

  // Strip the metadata frontmatter block, keep the letter body
  const raw = readFileSync(join(COVER_DIR, md), 'utf8');
  const body = raw.replace(/^---[\s\S]*?---\s*/, '').trim();
  const html = `<html><head><meta charset="utf-8"><style>
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.55; color: #1a1a1a; max-width: 17cm; margin: 0 auto; }
    p { margin: 0 0 0.9em 0; text-align: justify; }
  </style></head><body>${body.split(/\n\s*\n/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n')}</body></html>`;

  const pdfPath = join(COVER_DIR, md.replace(/\.md$/, '.pdf'));
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: pdfPath, format: 'A4', margin: { top: '2.2cm', bottom: '2.2cm', left: '2cm', right: '2cm' } });
    console.log(`   📄 rendered cover letter PDF: ${pdfPath.split(/[\\/]/).pop()}`);
  } finally {
    await page.close();
  }
  return pdfPath;
}

// ─────────────────────────────────────────────
// Process single job
// ─────────────────────────────────────────────
async function processJob(browser, profile, report, applyLog) {
  const slug = applyLogSlug(report.company);
  const langSlug = report.isGerman ? 'de' : 'en';

  // Pick this posting's CV before anything can upload one.
  activeCvPdf = cvForReport(report.num);
  if (activeCvPdf !== CV_PDF) console.log(`   📄 using tailored CV: ${basename(activeCvPdf)}`);
  let coverPdf = null;
  try { coverPdf = await ensureCoverPdf(browser, report.num, langSlug); }
  catch (e) { console.log(`   ⚠️ cover letter PDF render failed: ${e.message}`); }
  if (!coverPdf) console.log(`   ⚠️ no cover letter found for report ${report.num} — applying with CV only`);

  const logKey = `${report.num}-${slug}`;
  if (applyLog[logKey]?.status === 'submitted') {
    console.log(`⏭️  Already submitted: ${report.company} | ${report.role}`);
    return { skipped: true };
  }

  console.log(`\n→ ${report.company} | ${report.role} (score ${report.score}/5)`);
  console.log(`   URL: ${report.url}`);

  const context = await browser.newContext({
    // viewport: null in visible mode → page fills the real (maximized) window and
    // resizes with it. A fixed viewport taller than the screen (was 1280x900 on a
    // 1280x720 display) pushes the Submit button permanently off-screen.
    viewport: HEADLESS ? { width: 1280, height: 900 } : null,
    locale: 'en-US',   // makes Chrome offer to translate German pages
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  });
  let page = await context.newPage();

  try {
    await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000); // let JS render

    // Accept cookies FIRST so form values aren't reset later
    await acceptCookies(page);

    // Some pages have a "View Application Form" or "Apply Now" button that links to actual form.
    // Aggregator boards (berlinstartupjobs, englishjobsgermany, germantechjobs) ALWAYS link out
    // to the company's real ATS — follow the link, then detect the ATS from where we land.
    // Walk toward the actual application form, up to 2 hops:
    // hop 1: aggregator page (BSJ/EJG/GTJ) → outbound Apply link → company ATS
    // hop 2: ATS landing page → "Apply"/"Jetzt bewerben" → the real form
    // Aggregator pages ALWAYS get the hop — their search/newsletter inputs
    // otherwise fool the "form already here" heuristic.
    const applyLinks = [
      'a:has-text("Apply for this Job")',
      'a:has-text("Apply for this position")',
      'a:has-text("Apply Now")',
      'a:has-text("Jetzt bewerben")',
      'a:has-text("Apply")',
      'button:has-text("Jetzt bewerben")',
      'button:has-text("Apply")',
      'button:has-text("Bewerben")',
    ];
    for (let hop = 0; hop < 2; hop++) {
      const onAggregator = /berlinstartupjobs\.com|englishjobsgermany\.com|germantechjobs\.de/.test(page.url());
      // Let the form render before deciding there isn't one.
      await waitForForm(page, hop === 0 ? 5000 : 15000);
      const fieldCount = (await page.$$('input[type="text"], input[type="email"], input[type="tel"]')).length;
      if (fieldCount >= 3 && !onAggregator) break;
      console.log(`   📂 hop ${hop + 1}: ${fieldCount} form field(s) here — looking for Apply link...`);
      let clicked = false;
      for (const sel of applyLinks) {
        try {
          const btn = await page.$(sel);
          if (btn && await btn.isVisible()) {
            // The link may open a new tab (target=_blank on aggregator boards)
            const newPagePromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
            await btn.click();
            const newPage = await newPagePromise;
            await page.waitForTimeout(3000);
            const openedNewTab = !!newPage;
            const landedPage = openedNewTab ? newPage : page;
            if (openedNewTab) {
              await landedPage.waitForLoadState('domcontentloaded').catch(() => {});
              await landedPage.waitForTimeout(2000);
            }
            // arbeitnow.com (and similar aggregators) serve display ads on the same
            // page as the real listing; a generic "Apply" text selector sometimes
            // matches an ad creative instead. Google Ads click-tracking params on
            // the landing URL are a reliable tell that this was an ad, not the
            // real outbound apply link — bail out and try the next selector.
            if (/[?&](gad_source|gad_campaignid|gclid|dclid|utm_source=google)=/i.test(landedPage.url())) {
              console.log(`      ✗ ${sel} → ad click (${landedPage.url().slice(0, 60)}), trying next selector`);
              if (openedNewTab) await landedPage.close().catch(() => {});
              else await page.goBack().catch(() => {});
              continue;
            }
            if (openedNewTab) {
              page = landedPage;
              console.log(`      ✓ clicked: ${sel} → new tab: ${page.url().slice(0, 80)}`);
              await acceptCookies(page);
            } else {
              console.log(`      ✓ clicked: ${sel} → ${page.url().slice(0, 80)}`);
            }
            clicked = true;
            break;
          }
        } catch (e) { /* try next */ }
      }
      if (!clicked) break;
    }

    // Login/registration walls (join.com's /apply/authentication and similar):
    // nothing can be pre-filled behind these — flag honestly instead of "filled"
    if (/authentication|login|sign[-_]?in|register/i.test(page.url())) {
      console.log('   🔐 application requires an account/login — pre-fill not possible past this point');
      console.log(`   👉 Complete it here: ${page.url()}`);
    }

    // One last wait on the page we will actually fill: the final hop may have
    // landed on an ATS that is still booting its form.
    await waitForForm(page, 15000);

    // Detect the ATS from where we actually landed (not the report URL — aggregator
    // links redirect to greenhouse/ashby/lever more often than not)
    let ats = detectATS(page.url());
    if (ats === 'unknown') ats = detectATS(report.url);
    // Embedded Greenhouse boards live in an iframe on the company site
    if (ats === 'unknown' && await page.$('#grnhse_iframe, iframe[src*="greenhouse.io"]')) ats = 'greenhouse';
    console.log(`   🔍 ATS: ${ats} (${page.url().slice(0, 80)})`);

    // Fill form based on ATS
    if (ats === 'greenhouse') {
      await fillGreenhouse(page, profile, coverPdf, report.company);
    } else if (ats === 'ashby') {
      await fillAshby(page, profile, coverPdf, report.company);
    } else if (ats === 'lever') {
      await fillLever(page, profile, coverPdf, report.company);
    } else {
      // join.com, Personio, SmartRecruiters, Workable... — the Greenhouse filler's
      // selectors are generic (autocomplete attrs, email/tel types, file inputs),
      // so use it as a best-effort pass; the review pause catches whatever it missed.
      console.log(`   🧪 unknown ATS — trying generic filler (review carefully at the pause)`);
      await fillGreenhouse(page, profile, coverPdf, report.company);
    }

    // AI pass: draft answers for whatever the rule-based fill left open
    try { await aiAnswerUnknowns(page, report); }
    catch (e) { console.log(`   ⚠️ AI answer pass failed (${e.message}) — open questions left for you`); }

    // Verify form was filled — trust the fill function's counter
    const filledCount = page._fillStats?.filled || 0;
    if (filledCount < 2) {
      console.log(`   ⚠️  Only ${filledCount} field(s) filled — form likely not detected (login wall or unusual markup).`);
      applyLog[logKey] = { status: 'paused', reason: 'form not detected', url: report.url, timestamp: new Date().toISOString() };
      appendToIndex(report, 'Paused (form not detected)');
      if (KEEP_OPEN) {
        console.log('   🪟 window stays OPEN — finish this one by hand, then close it');
        return { paused: true, kept: true };
      }
      await page.waitForTimeout(30000);
      await context.close();
      return { paused: true };
    }

    // Wait for any uploads/scripts to settle
    await page.waitForTimeout(2000);

    // Check for CAPTCHA
    const captchaPresent = await hasCaptcha(page);

    // What is still missing, said once, on the page and in the log.
    const gaps = await auditRequiredFields(page);
    if (gaps.length) {
      console.log(`   ✋ ${gaps.length} required field(s) still empty — outlined red, checklist pinned top-right:`);
      for (const g of gaps) console.log(`        • ${g.label} (${g.kind})`);
    } else {
      console.log(`   ✅ every required field is filled — review and hit Submit`);
    }

    if (captchaPresent || NO_SUBMIT) {
      const reason = NO_SUBMIT ? 'Smart Semi-Auto (you submit)' : 'CAPTCHA detected';
      applyLog[logKey] = {
        status: 'paused-for-review',
        reason,
        url: report.url,
        gaps: gaps.map(g => g.label),
        timestamp: new Date().toISOString(),
      };
      appendToIndex(report, `Form pre-filled (${reason}) — ${gaps.length ? `${gaps.length} field(s) to complete` : 'ready to submit'}`);

      if (KEEP_OPEN) {
        // Park the view on the submit button so it's on screen when you take over
        try {
          const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Bewerbung absenden"), button:has-text("Absenden")');
          if (submitBtn) await submitBtn.scrollIntoViewIfNeeded({ timeout: 3000 });
        } catch { /* not critical */ }
        console.log(`   🪟 window stays OPEN — review, tick the CAPTCHA, click SUBMIT, then close it`);
        return { paused: true, kept: true };
      }

      console.log(`   ⏸️  PAUSING for ${PAUSE_SECONDS}s — ${reason}`);
      console.log(`   👉 Review the form — especially 🤖 AI-drafted answers — fill ✋ flagged fields, click SUBMIT yourself`);
      console.log(`   👉 Close the window when done (or wait ${PAUSE_SECONDS}s to auto-continue)`);

      // Wait PAUSE_SECONDS for user, OR exit early if user closes the page
      const startTime = Date.now();
      const maxWait = PAUSE_SECONDS * 1000;
      while (Date.now() - startTime < maxWait) {
        if (page.isClosed()) {
          console.log(`   ✓ Window closed — moving to next job`);
          break;
        }
        await page.waitForTimeout(2000);
      }
      try { await context.close(); } catch {}
      return { paused: true };
    }

    // No CAPTCHA — auto-submit
    console.log('   🚀 No CAPTCHA detected — submitting...');

    const urlBefore = page.url();

    // Find SUBMIT button (not just "Apply" which often links elsewhere)
    // Order matters — prefer explicit submit types over generic buttons
    const submitSelectors = [
      'button[type="submit"]:not([disabled])',
      'input[type="submit"]:not([disabled])',
      'button:has-text("Submit Application")',
      'button:has-text("Send Application")',
      'button:has-text("Bewerbung absenden")',
      'button:has-text("Bewerbung abschicken")',
      'button:has-text("Submit")',
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click();
          submitted = true;
          console.log(`      ✓ clicked: ${sel}`);
          break;
        }
      } catch (e) { /* try next */ }
    }

    if (!submitted) {
      console.log('   ⚠️  Could not find Submit button — PAUSING for manual submit');
      applyLog[logKey] = { status: 'paused', reason: 'no submit button', url: report.url };
      appendToIndex(report, 'Paused (no submit button)');
      await page.waitForTimeout(60000);
      await context.close();
      return { paused: true };
    }

    // Wait for navigation/confirmation (up to 10s)
    await page.waitForTimeout(7000);

    // Verify submission: look for STRONG confirmation indicators
    // 1. URL changed (often redirects to thank-you page)
    // 2. Specific confirmation phrases (not just generic "submit" word)
    const urlAfter = page.url();
    const urlChanged = urlAfter !== urlBefore;

    const pageText = await page.textContent('body').catch(() => '');
    const txt = pageText.toLowerCase();
    const strongSuccessKeywords = [
      'thank you for applying',
      'thank you for your application',
      'application received',
      'application has been received',
      'we have received your application',
      'successfully submitted',
      'wir haben ihre bewerbung',
      'vielen dank für ihre bewerbung',
      'bewerbung wurde erfolgreich',
      'thank you for your interest',
    ];
    const strongSuccess = strongSuccessKeywords.some(k => txt.includes(k));

    if (strongSuccess) {
      console.log('   ✅ SUBMITTED successfully (confirmation page detected)');
      applyLog[logKey] = { status: 'submitted', url: report.url, confirmation: 'page-text', timestamp: new Date().toISOString() };
      appendToIndex(report, 'Auto-submitted ✅');
    } else if (urlChanged) {
      console.log(`   ✅ Likely submitted (URL changed to: ${urlAfter.slice(0, 80)})`);
      applyLog[logKey] = { status: 'submitted', url: report.url, confirmation: 'url-change', timestamp: new Date().toISOString() };
      appendToIndex(report, 'Auto-submitted (URL changed)');
    } else {
      // Check for validation errors
      const errorElements = await page.$$('[class*="error"], [class*="invalid"], [role="alert"], .field-error');
      const hasErrors = errorElements.length > 0;
      if (hasErrors) {
        console.log('   ❌  Form has validation errors — PAUSING for manual fix');
        applyLog[logKey] = { status: 'errors', url: report.url, timestamp: new Date().toISOString() };
        appendToIndex(report, 'Paused (validation errors)');
      } else {
        console.log('   ⚠️  Submitted but no clear confirmation — PAUSING for manual review');
        applyLog[logKey] = { status: 'submitted-unconfirmed', url: report.url, timestamp: new Date().toISOString() };
        appendToIndex(report, 'Submitted (unconfirmed) — review manually');
      }
      await page.waitForTimeout(20000);
    }

    await context.close();
    return { submitted: true };

  } catch (e) {
    console.log(`   ❌ ERROR: ${e.message}`);
    applyLog[logKey] = { status: 'error', error: e.message, url: report.url, timestamp: new Date().toISOString() };
    appendToIndex(report, `Error: ${e.message.slice(0, 50)}`);
    await context.close();
    return { error: true };
  }
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  console.log('\n=== Auto-Apply (Playwright) ===\n');

  if (!existsSync(CV_PDF)) {
    console.error(`❌ CV PDF not found: ${CV_PDF}`);
    process.exit(1);
  }

  const profile = loadProfile();
  console.log(`Profile: ${profile.firstName} ${profile.lastName} <${profile.email}>`);
  console.log(`Phone:   ${profile.phone}`);
  console.log(`Mode:    ${AUTO_SUBMIT ? '⚡ AUTO-SUBMIT when no CAPTCHA' : '🔒 Smart Semi-Auto (fill + pause for you to submit)'}`);
  console.log(`Pause:   ${PAUSE_SECONDS}s per job for review`);
  console.log(`Browser: ${HEADLESS ? 'headless' : 'visible'}\n`);

  // Collect reports
  const today = new Date().toISOString().slice(0, 10);
  let reports;
  const dropUnparseable = (r) => {
    if (!r.company || !r.role) {
      console.log(`   ⚠️ skipping ${r.fname} — missing Company/Role header (non-English mode report?)`);
      return false;
    }
    return true;
  };

  if (PICKED_REPORTS.length) {
    // Keep the order the user asked for, not readdir order — the first window
    // opened is the one they most want to finish.
    reports = PICKED_REPORTS
      .flatMap(num => readdirSync(REPORTS_DIR).filter(f => f.startsWith(`${num}-`)))
      .map(f => parseReport(f)).filter(dropUnparseable);
  } else {
    // Accept reports from the last 7 days (date in filename: YYYY-MM-DD)
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    reports = readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.md') && /\d{4}-\d{2}-\d{2}/.test(f))
      .filter(f => {
        const m = f.match(/(\d{4}-\d{2}-\d{2})/);
        return m && m[1] >= cutoff;
      })
      .map(f => parseReport(f))
      .filter(dropUnparseable)
      .filter(r => r.score >= THRESHOLD);

    // Sort by score descending — apply to best matches first
    reports.sort((a, b) => b.score - a.score);

    // ATS filter (e.g., --ats=greenhouse to skip Ashby/Lever during test)
    if (ATS_FILTER) {
      reports = reports.filter(r => detectATS(r.url) === ATS_FILTER);
    }

    if (SKIP_SEEN) {
      const seen = loadApplyLog();
      const before = reports.length;
      // Same key processJob() writes, so the two can never drift apart.
      reports = reports.filter(r => !seen[`${r.num}-${applyLogSlug(r.company)}`]);
      const held = before - reports.length;
      if (held) console.log(`--skip-seen: leaving ${held} already-opened job(s) alone`);
    }

    // Cap to MAX_JOBS
    reports = reports.slice(0, MAX_JOBS);
  }

  if (reports.length === 0) {
    console.log('No qualifying reports found');
    return;
  }

  console.log(`Found ${reports.length} jobs to apply to\n`);

  // Launch browser
  // Visible mode: prefer the user's real Google Chrome. Playwright's bundled
  // Chromium has no Google API keys, so its built-in translate never works —
  // which matters for German job ads. --start-maximized + viewport:null makes
  // the form fill the actual screen so the Submit button is reachable.
  const launchOpts = {
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 200,
    args: HEADLESS ? [] : ['--start-maximized', '--lang=en-US'],
  };
  let browser;
  if (!HEADLESS) {
    try {
      browser = await chromium.launch({ ...launchOpts, channel: 'chrome' });
      console.log('Browser: Google Chrome (translate available)\n');
    } catch {
      console.log('Browser: bundled Chromium (Chrome not found — translate unavailable)\n');
    }
  }
  if (!browser) browser = await chromium.launch(launchOpts);

  const applyLog = loadApplyLog();
  const stats = { submitted: 0, paused: 0, error: 0, skipped: 0, manual: 0, kept: 0 };

  for (const report of reports) {
    const result = await processJob(browser, profile, report, applyLog);
    if (result.submitted) stats.submitted++;
    else if (result.paused) stats.paused++;
    else if (result.error) stats.error++;
    else if (result.skipped) stats.skipped++;
    else if (result.manual) stats.manual++;
    if (result.kept) stats.kept++;

    saveApplyLog(applyLog);

    // Brief pause between jobs to be polite
    await new Promise(r => setTimeout(r, 2000));
  }

  // Keep-open mode: every filled window is still on screen — hand over to the user
  // and exit only when they've closed them all (or after 60 minutes).
  if (KEEP_OPEN && stats.kept > 0) {
    console.log(`\n🪟 ${stats.kept} window(s) open and filled — your turn:`);
    console.log('   For each window: review the fields (🤖 = AI-drafted), tick the CAPTCHA, click SUBMIT, close the window.');
    console.log('   This command finishes when all windows are closed (max 60 min).\n');
    const deadline = Date.now() + 60 * 60 * 1000;
    while (Date.now() < deadline) {
      let open = 0;
      try { open = browser.contexts().reduce((n, c) => n + c.pages().length, 0); }
      catch { break; } // browser closed entirely
      if (open === 0) break;
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  try { await browser.close(); } catch {}

  console.log(`\n=== Summary ===`);
  console.log(`Submitted:        ${stats.submitted}`);
  console.log(`Paused (CAPTCHA): ${stats.paused}`);
  console.log(`Manual required: ${stats.manual}`);
  console.log(`Errors:           ${stats.error}`);
  console.log(`Already done:     ${stats.skipped}`);
  console.log(`\nReview applications-index.md for full results\n`);
}

// Exported for test-choice-groups.mjs; the CLI still runs only as entrypoint.
export { tagChoiceGroups, decideChoice, matchOption, clickChoice, answerChoiceGroups, questionLabelInPage, findFileInputs, fileAttached };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error('Fatal:', e.message);
    process.exit(1);
  });
}
