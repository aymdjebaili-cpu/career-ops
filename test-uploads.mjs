#!/usr/bin/env node
/**
 * test-uploads.mjs — regression test for document attachment
 *
 * uploadDocuments() used page.$$('input[type="file"]'), which only searches the
 * MAIN frame. Embedded Greenhouse boards render the whole form inside
 * #grnhse_iframe, so those applications were filled and submitted with no CV
 * attached — and the log said nothing was wrong. Some ATS also create the file
 * input only after an "Attach"/"Upload" button is clicked.
 *
 * Usage: node test-uploads.mjs
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findFileInputs, fileAttached } from './auto-apply.mjs';

const dir = mkdtempSync(join(tmpdir(), 'co-upload-'));
const FAKE_PDF = join(dir, 'cv.pdf');
writeFileSync(FAKE_PDF, '%PDF-1.4\n%fake\n');

const pass = (m) => { console.log(`  ✓ ${m}`); return true; };
const fail = (m) => { console.log(`  ✗ ${m}`); return false; };

async function run() {
  const browser = await chromium.launch({ headless: true });
  let ok = true;

  // 1. plain file input in the main frame
  {
    const page = await browser.newPage();
    await page.setContent('<label>Resume<input type="file" name="resume"></label>');
    const found = await findFileInputs(page);
    ok = (found.length === 1 ? pass('main-frame file input found') : fail(`main-frame: expected 1 input, got ${found.length}`)) && ok;
    if (found.length) {
      await found[0].setInputFiles(FAKE_PDF);
      ok = (await fileAttached(found[0]) ? pass('attachment verified via files.length') : fail('fileAttached() did not see the file')) && ok;
    }
    await page.close();
  }

  // 2. THE REGRESSION: form inside an iframe (embedded Greenhouse)
  {
    const page = await browser.newPage();
    await page.setContent(`
      <h1>Careers at Example</h1>
      <iframe id="grnhse_iframe" srcdoc="
        <label>Resume/CV<input type='file' name='resume'></label>
        <label>Cover Letter<input type='file' name='cover_letter'></label>
      "></iframe>
    `);
    await page.waitForTimeout(300);
    const found = await findFileInputs(page);
    ok = (found.length === 2
      ? pass('file inputs inside #grnhse_iframe found (was 0 before the fix)')
      : fail(`iframe: expected 2 inputs, got ${found.length} — CV would not be attached`)) && ok;
    if (found.length) {
      await found[0].setInputFiles(FAKE_PDF);
      ok = (await fileAttached(found[0]) ? pass('iframe attachment verified') : fail('iframe attachment did not stick')) && ok;
    }
    await page.close();
  }

  // 3. input created only after clicking an upload button
  {
    const page = await browser.newPage();
    await page.setContent(`
      <button type="button" id="att">Attach resume</button>
      <div id="slot"></div>
      <script>
        document.getElementById('att').addEventListener('click', () => {
          document.getElementById('slot').innerHTML = '<input type="file" name="resume">';
        });
      </script>
    `);
    const found = await findFileInputs(page);
    ok = (found.length === 1
      ? pass('lazily-created file input found after clicking Attach')
      : fail(`lazy input: expected 1, got ${found.length}`)) && ok;
    await page.close();
  }

  // 4. no upload field anywhere — must report none, not throw
  {
    const page = await browser.newPage();
    await page.setContent('<form><input type="text" name="name"><button type="submit">Submit</button></form>');
    const found = await findFileInputs(page);
    ok = (found.length === 0 ? pass('no-upload page correctly reports none') : fail(`expected 0 inputs, got ${found.length}`)) && ok;
    await page.close();
  }

  await browser.close();
  console.log(ok ? '\n✅ all upload checks passed\n' : '\n❌ upload checks FAILED\n');
  return ok ? 0 : 1;
}

run().then(c => process.exit(c)).catch(e => { console.error('Fatal:', e); process.exit(1); });
