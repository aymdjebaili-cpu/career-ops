#!/usr/bin/env node
/**
 * test-choice-groups.mjs — regression test for the form choice-group filler
 *
 * The rule-based pass in auto-apply.mjs used to require a <select> or an
 * input[type="radio"] inside a <fieldset>. Real ATS render Yes/No questions as
 * plain <button>s, ARIA [role="radio"] divs, bare radios and styled label pills,
 * all of which were silently left blank. This exercises every shape against a
 * synthetic form, plus the things that must NOT be clicked.
 *
 * Usage: node test-choice-groups.mjs
 */

import { chromium } from 'playwright';
import { tagChoiceGroups, decideChoice, clickChoice } from './auto-apply.mjs';

const FIXTURE = `
<style>.q{margin:14px 0} button{margin:4px} .pill{margin:4px;display:inline-block}</style>

<!-- 1. plain buttons that record state via aria-pressed — the shape the user reported -->
<div class="q" id="stateful">
  <p>Are you legally eligible to work within the region/country this job is based?</p>
  <button type="button" aria-pressed="false">Yes</button>
  <button type="button" aria-pressed="false">No</button>
</div>

<!-- 2. ARIA radios -->
<div class="q">
  <p>Are you able to work from the required office at least 3 days per week?</p>
  <div role="radiogroup">
    <div role="radio" aria-checked="false" tabindex="0">Yes</div>
    <div role="radio" aria-checked="false" tabindex="0">No</div>
  </div>
</div>

<!-- 3. bare native radios, no fieldset wrapper -->
<div class="q">
  <p>Are you able to dedicate 40 hours per week for this position?</p>
  <label><input type="radio" name="hrs" value="Yes"> Yes</label>
  <label><input type="radio" name="hrs" value="No"> No</label>
</div>

<!-- 4. styled pills with a visually hidden radio -->
<div class="q">
  <p>Are you willing to relocate within Germany?</p>
  <label class="pill"><input type="radio" name="rel" value="yes" hidden>Yes</label>
  <label class="pill"><input type="radio" name="rel" value="no" hidden>No</label>
</div>

<!-- 5. worst case: buttons that expose NO state at all. The click must still be
     attempted, and the run must flag that it could not be verified. -->
<div class="q" id="stateless">
  <p>Will you now or in the future require visa sponsorship for employment?</p>
  <button type="button">Yes</button>
  <button type="button">No</button>
</div>

<!-- 6. MUST be left alone — sensitive -->
<div class="q">
  <p>Have you ever been convicted of a criminal offence?</p>
  <button type="button">Yes</button>
  <button type="button">No</button>
</div>

<!-- 7. MUST be left alone — unknowable from the profile -->
<div class="q">
  <p>Do you hold a category B driving licence?</p>
  <button type="button">Yes</button>
  <button type="button">No</button>
</div>

<!-- 8. MUST NOT be treated as a question -->
<div class="q">
  <button type="submit">Submit application</button>
  <button type="button">Cancel</button>
</div>
`;

// label fragment → expected answer ('' = must stay unanswered)
// `stateless: true` — widget exposes no selected state, so the DOM check is
// skipped; the click is still required to be attempted and to succeed.
const EXPECTED = [
  // Legally resident in Germany with work rights (part-time/internships), so
  // "eligible" is Yes; the restriction is captured by the sponsorship question.
  ['legally eligible to work', 'Yes'],
  ['required office at least 3 days', 'Yes'],
  ['40 hours per week', 'Yes'],
  ['willing to relocate', 'Yes'],
  ['require visa sponsorship', 'Yes', { stateless: true }],
  ['convicted of a criminal offence', ''],
  ['category B driving licence', ''],
];

const pass = (m) => { console.log(`  ✓ ${m}`); return true; };
const fail = (m) => { console.log(`  ✗ ${m}`); return false; };

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(FIXTURE);

  // Real widgets flip their own state on click; wire that up for the two that
  // model stateful controls. #stateless deliberately gets no handler.
  await page.evaluate(() => {
    for (const g of document.querySelectorAll('[role="radiogroup"]')) {
      for (const r of g.querySelectorAll('[role="radio"]')) {
        r.addEventListener('click', () => {
          g.querySelectorAll('[role="radio"]').forEach(o => o.setAttribute('aria-checked', 'false'));
          r.setAttribute('aria-checked', 'true');
        });
      }
    }
    const sf = document.getElementById('stateful');
    for (const b of sf.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        sf.querySelectorAll('button').forEach(o => o.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
      });
    }
  });

  let ok = true;
  const groups = await tagChoiceGroups(page);
  console.log(`\ndetected ${groups.length} choice group(s)\n`);

  console.log('detection:');
  for (const [frag] of EXPECTED) {
    const g = groups.find(x => x.label.toLowerCase().includes(frag.toLowerCase()));
    ok = (g ? pass(`found "${frag}" → [${g.options.join(' | ')}]`)
            : fail(`MISSED "${frag}" — question would be left blank`)) && ok;
  }
  if (groups.some(g => /submit|cancel/i.test(g.options.join(' ')))) {
    ok = fail('Submit/Cancel buttons were treated as a question');
  } else {
    ok = pass('Submit/Cancel not treated as a question') && ok;
  }

  console.log('\nanswers:');
  for (const [frag, want] of EXPECTED) {
    const g = groups.find(x => x.label.toLowerCase().includes(frag.toLowerCase()));
    if (!g) { ok = false; continue; }
    const idx = decideChoice(g.label, g.options, {});
    const got = idx === null || idx === undefined ? '' : g.options[idx];
    ok = (got === want
      ? pass(`"${frag}" → ${want || '(left for the user)'}`)
      : fail(`"${frag}" → expected ${want || '(left for the user)'}, got ${got || '(left for the user)'}`)) && ok;
    if (idx !== null && idx !== undefined) {
      const hit = await clickChoice(page, g.gi, idx, g.kind);
      if (!hit) ok = fail(`"${frag}" → click threw`);
    }
  }

  console.log('\nclicks registered in the DOM:');
  const after = await tagChoiceGroups(page);
  for (const [frag, want, opts = {}] of EXPECTED) {
    const g = after.find(x => x.label.toLowerCase().includes(frag.toLowerCase()));
    if (!g) { ok = false; continue; }
    if (want && opts.stateless) {
      ok = (!g.answered ? pass(`"${frag}" stateless widget — clicked, flagged as unverifiable`)
                        : pass(`"${frag}" stateless widget reported a selection`)) && ok;
    } else if (want) {
      ok = (g.answered ? pass(`"${frag}" is answered`)
                       : fail(`"${frag}" click did NOT register — still blank on the page`)) && ok;
    } else {
      ok = (!g.answered ? pass(`"${frag}" left blank, as intended`)
                        : fail(`"${frag}" was answered but must not be`)) && ok;
    }
  }

  await browser.close();
  console.log(ok ? '\n✅ all choice-group checks passed\n' : '\n❌ choice-group checks FAILED\n');
  return ok ? 0 : 1;
}

run().then(c => process.exit(c)).catch(e => { console.error('Fatal:', e); process.exit(1); });
