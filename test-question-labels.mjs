#!/usr/bin/env node
/**
 * test-question-labels.mjs — regression test for open-question detection
 *
 * The old label extractor ended with `return node.placeholder`, so an Ashby
 * custom question whose prompt sits in a sibling <div> (not a <label for=…>)
 * was handed to the AI worker as the question "Type here..." — unanswerable,
 * so the field silently stayed blank on every application.
 *
 * These are the real shapes those questions come in.
 *
 * Usage: node test-question-labels.mjs
 */

import { chromium } from 'playwright';
import { questionLabelInPage } from './auto-apply.mjs';

const FIXTURE = `
<!-- Ashby: prompt in a sibling div, textarea carries only a placeholder -->
<div class="_container">
  <div class="_fieldEntry">
    <div class="_label_y2cw4_33">What is the most impressive thing you've done?</div>
    <div class="_inputWrapper"><textarea id="a1" placeholder="Type here..."></textarea></div>
  </div>
  <div class="_fieldEntry">
    <div class="_label_y2cw4_33">What's something you recently changed your mind about?</div>
    <div class="_inputWrapper"><textarea id="a2" placeholder="Type here..."></textarea></div>
  </div>
  <div class="_fieldEntry">
    <div class="_label_y2cw4_33">What's the most unfair advantage you have?</div>
    <div class="_inputWrapper"><textarea id="a3" placeholder="Type here..."></textarea></div>
  </div>
</div>

<!-- Greenhouse: proper label[for] -->
<div>
  <label for="b1">Describe a large-scale project you have led from inception to completion. What was the outcome, and how did you ensure alignment with strategic goals?</label>
  <textarea id="b1"></textarea>
</div>

<!-- aria-labelledby -->
<div>
  <span id="lbl-c1">Can you share an example of how you have used AI tools in your studies / in your current job?</span>
  <textarea id="c1" aria-labelledby="lbl-c1" placeholder="Type here..."></textarea>
</div>

<!-- contenteditable rich-text editor -->
<div>
  <h4>Why do you want to work here?</h4>
  <div id="d1" contenteditable="true" role="textbox" data-placeholder="Type here..."></div>
</div>

<!-- heading-above-field, no label element at all -->
<div>
  <p>What motivates you outside of work?</p>
  <textarea id="e1"></textarea>
</div>

<!-- a field with genuinely nothing to go on: must return '' -->
<div><textarea id="f1" placeholder="Type here..."></textarea></div>
`;

const EXPECTED = [
  ['#a1', "What is the most impressive thing you've done?"],
  ['#a2', "What's something you recently changed your mind about?"],
  ['#a3', "What's the most unfair advantage you have?"],
  ['#b1', 'Describe a large-scale project you have led from inception to completion. What was the outcome, and how did you ensure alignment with strategic goals?'],
  ['#c1', 'Can you share an example of how you have used AI tools in your studies / in your current job?'],
  ['#d1', 'Why do you want to work here?'],
  ['#e1', 'What motivates you outside of work?'],
  ['#f1', ''],
];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(FIXTURE);

  let ok = true;
  for (const [sel, want] of EXPECTED) {
    const el = await page.$(sel);
    const got = await el.evaluate(questionLabelInPage);
    if (got === want) {
      console.log(`  ✓ ${sel} → ${want ? `"${got.slice(0, 60)}${got.length > 60 ? '…' : ''}"` : '(correctly no label)'}`);
    } else {
      ok = false;
      console.log(`  ✗ ${sel}\n      expected: "${want}"\n      got:      "${got}"`);
    }
  }

  // The specific regression: no field may ever be described by its placeholder.
  for (const [sel] of EXPECTED) {
    const got = await (await page.$(sel)).evaluate(questionLabelInPage);
    if (/^type here/i.test(got)) {
      ok = false;
      console.log(`  ✗ ${sel} → placeholder leaked back in as the question text`);
    }
  }

  await browser.close();
  console.log(ok ? '\n✅ all question-label checks passed\n' : '\n❌ question-label checks FAILED\n');
  return ok ? 0 : 1;
}

run().then(c => process.exit(c)).catch(e => { console.error('Fatal:', e); process.exit(1); });
