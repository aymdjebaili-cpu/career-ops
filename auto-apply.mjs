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
 *   node auto-apply.mjs --report=011      # single report only
 *   node auto-apply.mjs --no-submit       # fill but never submit (always pause)
 *   node auto-apply.mjs --headless        # run headless (no browser window)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const REPORTS_DIR = join(PROJECT_DIR, 'reports');
const COVER_DIR = join(PROJECT_DIR, 'output', 'cover-letters');
const CV_PDF = join(PROJECT_DIR, 'output', 'cv-updated.pdf');
const PROFILE_FILE = join(PROJECT_DIR, 'config', 'profile.yml');
const INDEX_FILE = join(PROJECT_DIR, 'output', 'applications-index.md');
const APPLY_LOG_FILE = join(PROJECT_DIR, 'output', '.apply-log.json');

const args = process.argv.slice(2);
const THRESHOLD = parseFloat(args.find(a => a.startsWith('--score='))?.split('=')[1] || '2.5');
const SINGLE_REPORT = args.find(a => a.startsWith('--report='))?.split('=')[1] || null;
const MAX_JOBS = parseInt(args.find(a => a.startsWith('--max='))?.split('=')[1] || '9999', 10);
// DEFAULT: try to auto-submit when all required fields are filled, no CAPTCHA
// --no-submit: pause for manual review instead
const NO_SUBMIT = args.includes('--no-submit');
const AUTO_SUBMIT = !NO_SUBMIT;
const HEADLESS = args.includes('--headless');
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
    city: 'Berlin',
    country: 'Germany',
    // Default answers for common application questions
    workAuth: 'no',           // not yet authorized to work (Blue Card pending)
    visaSponsorship: 'yes',   // need visa sponsorship (Blue Card)
    eu_citizen: 'no',
    relocation: 'yes',
    earliestStart: 'January 2026',
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
      if (/visa|sponsor|work\s*permit|require.*visa/.test(context)) answer = 'Yes';
      else if (/authoriz|legally.*work|right\s*to\s*work|eligible.*work/.test(context)) answer = 'No';
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
// Fill custom open-text fields (textarea questions)
// AGGRESSIVE: fills EVERY visible empty textarea with the best matching response
// ─────────────────────────────────────────────
async function fillCustomTextareas(page, profile) {
  const textareas = await page.$$('textarea');
  let filled = 0;

  const genericResponse = `I bring a strong background in operations and customer success from the hospitality technology sector. As Head of Customer Operations, I converted 345 bookings from 1,271 leads, recovered €1.6M in B2B revenue, and led a four-person team. I am relocating to Germany in 2026 under the EU Blue Card, am highly motivated, and would love to contribute to your team. I am happy to elaborate further in an interview.`;

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

      const labelText = await ta.evaluate(el => {
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

      const context = labelText.toLowerCase();
      let answer = null;

      if (/salary|compensat|gehalt|verdienst|expected\s*comp/.test(context)) {
        answer = '€38,000 - €45,000 (negotiable based on role scope and benefits package)';
      } else if (/why.*you|why.*interested|motivation|interesse|why.*role|why.*position|warum/.test(context)) {
        answer = 'This role aligns directly with my background in operations and customer success in hospitality technology. My experience leading a four-person team and recovering €1.6M in revenue has prepared me to add immediate value. I am excited about the opportunity to grow with your team in Germany.';
      } else if (/why\s*us|why.*company|warum.*uns/.test(context)) {
        answer = 'Your company\'s mission and growth trajectory in Germany align with the kind of impactful, scalable work environment where I can apply my operational expertise and contribute meaningfully from day one.';
      } else if (/strength|stärke|biggest\s*achievement/.test(context)) {
        answer = 'My greatest strength is combining analytical rigor with operational execution — I built systematic processes that converted 345 bookings from 1,271 leads and recovered €1.6M in B2B receivables.';
      } else if (/notice\s*period|kündigung/.test(context)) {
        answer = '1 month';
      } else if (/availability|available|verfügbar|start\s*date|earliest/.test(context)) {
        answer = 'Available from January 2026 (EU Blue Card relocation to Germany).';
      } else if (/comment|additional|sonstig|anything\s*else|further\s*info/.test(context)) {
        answer = 'I am happy to provide any additional information needed and look forward to discussing the role in detail in an interview.';
      } else {
        // AGGRESSIVE FALLBACK: any visible empty textarea gets the generic response
        answer = genericResponse;
      }

      if (answer) {
        await ta.fill(answer);
        console.log(`      ✓ textarea "${labelText.slice(0, 40) || name || id || '(no label)'}" → ${answer.slice(0, 50)}...`);
        filled++;
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
      if (/visa|sponsor|work\s*permit|need.*visa|require.*visa/.test(context)) {
        chosenValue = pickOption(options, ['yes', 'ja', 'true']);
      } else if (/authoriz|work\s*authoriz|legally.*work|right\s*to\s*work|eligible.*work/.test(context)) {
        chosenValue = pickOption(options, ['no', 'nein', 'false']);
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

      // ULTIMATE FALLBACK: pick the FIRST non-empty option (skip placeholders like "Select...")
      if (!chosenValue && options.length > 1) {
        const firstValid = options.find(o => {
          const t = o.text.toLowerCase();
          return o.value && o.value !== '' && o.value !== '0' &&
                 !t.includes('select') && !t.includes('please choose') &&
                 !t.includes('-- select') && !t.includes('bitte wählen');
        });
        if (firstValid) chosenValue = firstValid.value;
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
      if (/visa|sponsor|work\s*permit|require.*visa/.test(context)) targetValue = 'yes';
      else if (/authoriz|legally.*work|right\s*to\s*work|allowed.*work/.test(context)) targetValue = 'no';
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
async function fillGreenhouse(page, profile, coverPdf) {
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

  // Resume upload (CV PDF)
  try {
    const resumeInput = await page.$('input[type="file"][name*="resume"], input[type="file"][id*="resume"], input[type="file"][name="candidate_resume"]');
    if (resumeInput) {
      await resumeInput.setInputFiles(CV_PDF);
      console.log('      ✓ uploaded CV PDF');
    }
  } catch (e) {
    console.log(`      ⚠️ CV upload failed: ${e.message}`);
  }

  // Cover letter upload (if file input) or text area
  try {
    const coverInput = await page.$('input[type="file"][name*="cover"], input[type="file"][id*="cover_letter"]');
    if (coverInput && coverPdf && existsSync(coverPdf)) {
      await coverInput.setInputFiles(coverPdf);
      console.log('      ✓ uploaded cover letter PDF');
    } else {
      // Fallback: paste text into cover letter textarea
      const coverTextarea = await page.$('textarea[name*="cover"], textarea[id*="cover"]');
      if (coverTextarea) {
        const coverText = 'Please see attached cover letter PDF and CV.';
        await coverTextarea.fill(coverText);
        console.log('      ✓ filled cover letter textarea (text fallback)');
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
  const taFilled = await fillCustomTextareas(page, profile);
  if (taFilled > 0) console.log(`      ✓ ${taFilled} open-text questions answered`);
  // Check required consent checkboxes (terms, privacy)
  const cbChecked = await checkRequiredCheckboxes(page);
  if (cbChecked > 0) console.log(`      ✓ ${cbChecked} required checkbox(es) checked`);
}

// ─────────────────────────────────────────────
// Ashby form filler
// ─────────────────────────────────────────────
async function fillAshby(page, profile, coverPdf) {
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

  // Resume upload
  try {
    const resumeInput = await page.$('input[type="file"]');
    if (resumeInput) {
      await resumeInput.setInputFiles(CV_PDF);
      console.log('      ✓ uploaded CV PDF');
    }
  } catch (e) {
    console.log(`      ⚠️ CV upload failed: ${e.message}`);
  }

  await fillDropdownsAndRadios(page, profile);
}

// ─────────────────────────────────────────────
// Lever form filler
// ─────────────────────────────────────────────
async function fillLever(page, profile, coverPdf) {
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

  try {
    const resumeInput = await page.$('input[type="file"][name="resume"]');
    if (resumeInput) {
      await resumeInput.setInputFiles(CV_PDF);
      console.log('      ✓ uploaded CV PDF');
    }
  } catch (e) { /* ignore */ }

  await fillDropdownsAndRadios(page, profile);
}

// ─────────────────────────────────────────────
// Process single job
// ─────────────────────────────────────────────
async function processJob(browser, profile, report, applyLog) {
  const slug = report.company.toLowerCase().replace(/[^a-z0-9]/g, '');
  const langSlug = report.isGerman ? 'de' : 'en';
  const coverPdf = join(COVER_DIR, `${report.num}-${slug}-${langSlug}.pdf`);

  const logKey = `${report.num}-${slug}`;
  if (applyLog[logKey]?.status === 'submitted') {
    console.log(`⏭️  Already submitted: ${report.company} | ${report.role}`);
    return { skipped: true };
  }

  console.log(`\n→ ${report.company} | ${report.role} (score ${report.score}/5)`);
  console.log(`   URL: ${report.url}`);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000); // let JS render

    // Accept cookies FIRST so form values aren't reset later
    await acceptCookies(page);

    const ats = detectATS(report.url);
    console.log(`   🔍 ATS: ${ats}`);

    // Some pages have a "View Application Form" or "Apply Now" button that links to actual form
    // Try to detect and click those before filling
    const formFieldsBefore = await page.$$('input[type="text"], input[type="email"], input[type="tel"]');
    if (formFieldsBefore.length < 2) {
      // No form fields visible — try to navigate to form by clicking Apply
      console.log('   📂 no form fields detected — looking for Apply button to navigate to form...');
      const applyLinks = [
        'a:has-text("Apply for this Job")',
        'a:has-text("Apply for this position")',
        'a:has-text("Apply Now")',
        'a:has-text("Apply")',
        'button:has-text("Apply")',
      ];
      for (const sel of applyLinks) {
        try {
          const btn = await page.$(sel);
          if (btn && await btn.isVisible()) {
            await btn.click();
            await page.waitForTimeout(3000);
            console.log(`      ✓ clicked: ${sel}`);
            break;
          }
        } catch (e) { /* try next */ }
      }
    }

    // Fill form based on ATS
    if (ats === 'greenhouse') {
      await fillGreenhouse(page, profile, coverPdf);
    } else if (ats === 'ashby') {
      await fillAshby(page, profile, coverPdf);
    } else if (ats === 'lever') {
      await fillLever(page, profile, coverPdf);
    } else {
      console.log(`   ⚠️ unknown ATS — manual completion required`);
      applyLog[logKey] = { status: 'manual-required', url: report.url, timestamp: new Date().toISOString() };
      appendToIndex(report, 'Unknown ATS — manual');
      return { manual: true };
    }

    // Verify form was filled — trust the fill function's counter
    const filledCount = page._fillStats?.filled || 0;
    if (filledCount < 2) {
      console.log(`   ⚠️  Only ${filledCount} field(s) filled — form likely not detected. PAUSING.`);
      applyLog[logKey] = { status: 'paused', reason: 'form not detected', url: report.url, timestamp: new Date().toISOString() };
      appendToIndex(report, 'Paused (form not detected)');
      await page.waitForTimeout(30000);
      await context.close();
      return { paused: true };
    }

    // Wait for any uploads/scripts to settle
    await page.waitForTimeout(2000);

    // Check for CAPTCHA
    const captchaPresent = await hasCaptcha(page);

    if (captchaPresent || NO_SUBMIT) {
      const reason = NO_SUBMIT ? 'Smart Semi-Auto (you submit)' : 'CAPTCHA detected';
      console.log(`   ⏸️  PAUSING for ${PAUSE_SECONDS}s — ${reason}`);
      console.log(`   👉 Review the form, fill any missing fields, click SUBMIT yourself`);
      console.log(`   👉 Close the window when done (or wait ${PAUSE_SECONDS}s to auto-continue)`);
      applyLog[logKey] = { status: 'paused-for-review', reason, url: report.url, timestamp: new Date().toISOString() };
      appendToIndex(report, `Form pre-filled (${reason}) — review + submit`);

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
  if (SINGLE_REPORT) {
    const files = readdirSync(REPORTS_DIR).filter(f => f.startsWith(`${SINGLE_REPORT}-`));
    reports = files.map(f => parseReport(f));
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
      .filter(r => r.score >= THRESHOLD);

    // Sort by score descending — apply to best matches first
    reports.sort((a, b) => b.score - a.score);

    // ATS filter (e.g., --ats=greenhouse to skip Ashby/Lever during test)
    if (ATS_FILTER) {
      reports = reports.filter(r => detectATS(r.url) === ATS_FILTER);
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
  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 200,
  });

  const applyLog = loadApplyLog();
  const stats = { submitted: 0, paused: 0, error: 0, skipped: 0, manual: 0 };

  for (const report of reports) {
    const result = await processJob(browser, profile, report, applyLog);
    if (result.submitted) stats.submitted++;
    else if (result.paused) stats.paused++;
    else if (result.error) stats.error++;
    else if (result.skipped) stats.skipped++;
    else if (result.manual) stats.manual++;

    saveApplyLog(applyLog);

    // Brief pause between jobs to be polite
    await new Promise(r => setTimeout(r, 2000));
  }

  await browser.close();

  console.log(`\n=== Summary ===`);
  console.log(`Submitted:        ${stats.submitted}`);
  console.log(`Paused (CAPTCHA): ${stats.paused}`);
  console.log(`Manual required: ${stats.manual}`);
  console.log(`Errors:           ${stats.error}`);
  console.log(`Already done:     ${stats.skipped}`);
  console.log(`\nReview applications-index.md for full results\n`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
