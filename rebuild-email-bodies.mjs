#!/usr/bin/env node
/**
 * rebuild-email-bodies.mjs — rewrite the body of existing output/email-*.md files
 * from their tailored cover letter.
 *
 * WHY
 * Every email file written before email-body-core.mjs existed carries a two-line
 * stub ("Please find attached my CV...") and hides the entire pitch in the
 * attachment. daily-run.mjs will not fix them on its own: writeEmailDraftFile()
 * returns early when the file already exists, by design, so hand edits survive.
 * This script is the deliberate opt-in repair.
 *
 * It also repairs COVER_LETTER_PATH when the recorded path resolves to nothing —
 * a language field of `EN/DE` used to write the letter to a *directory*
 * (432-wolt-en/de.md) and record the basename `de.md`, so the draft went to Gmail
 * with no letter attached at all.
 *
 * Usage:
 *   node rebuild-email-bodies.mjs --dry-run     # show what would change
 *   node rebuild-email-bodies.mjs               # rewrite the bodies
 *   node rebuild-email-bodies.mjs --only=432    # one file (matches the number or slug)
 *   node rebuild-email-bodies.mjs --include-init  # also rewrite email-init-*.md
 *
 * email-init-*.md files are SKIPPED by default: initiativ-drafts.mjs already
 * writes a full speculative pitch there, and it is hand-tuned.
 *
 * Nothing is sent. Push the rewritten files to Gmail with `npm run drafts`,
 * which now updates a draft in place when its body has changed.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { buildEmailBody, loadCandidate, htmlLetterToText } from './email-body-core.mjs';
import { renderLetterPdf, withBrowser } from './letter-pdf-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const OUTPUT_DIR = join(PROJECT_DIR, 'output');
const COVER_DIR = join(OUTPUT_DIR, 'cover-letters');

const args = process.argv.slice(2);
const IS_DRY_RUN = args.includes('--dry-run');
const INCLUDE_INIT = args.includes('--include-init');
const NO_PDF = args.includes('--no-pdf');
const ONLY = args.find(a => a.startsWith('--only='))?.split('=')[1] ?? '';

const log = (m) => console.log(m);
const ok = (m) => console.log(`  ✅ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);

// ─────────────────────────────────────────────
// Email file I/O — headers above a bare `---`, body below (save-drafts.mjs format)
// ─────────────────────────────────────────────
function parseEmailFile(text) {
  const lines = text.split(/\r?\n/);
  const headers = [];
  const meta = {};
  let bodyStart = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') { bodyStart = i + 1; break; }
    headers.push(lines[i]);
    const idx = lines[i].indexOf(':');
    if (idx > -1) meta[lines[i].slice(0, idx).trim().toUpperCase()] = lines[i].slice(idx + 1).trim();
  }
  if (bodyStart === -1) return null;
  return { headers, meta, body: lines.slice(bodyStart).join('\n').trim() };
}

/**
 * Every letter under output/cover-letters (.md preferred, .html as fallback),
 * including one level of subdirectories — a language field of `EN/DE` used to
 * write letters into `{num}-{slug}-en/de.md`.
 */
function allLetters() {
  if (!existsSync(COVER_DIR)) return [];
  const out = [];
  const take = (p) => { if (/\.(md|html)$/i.test(p)) out.push(p); };
  for (const entry of readdirSync(COVER_DIR)) {
    const full = join(COVER_DIR, entry);
    if (statSync(full).isDirectory()) {
      for (const sub of readdirSync(full)) take(join(full, sub));
    } else {
      take(full);
    }
  }
  return out;
}

const toRel = (p) => p.replace(PROJECT_DIR, '').replace(/^[\\/]/, '').replace(/\\/g, '/');

/** The report number a letter path belongs to, from its own name or its parent's. */
function letterNumber(path) {
  const parts = path.split(/[\\/]/);
  for (const seg of [parts[parts.length - 1], parts[parts.length - 2] ?? '']) {
    const m = seg.match(/^(\d+)-/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Resolve the letter for an email file.
 *
 * Matching is strict on BOTH the report number and the company slug. An earlier
 * version fell back to slug alone and confidently paired report 014 with report
 * 011's letter — a wrong-role pitch is far worse than no repair, so an ambiguous
 * match now yields nothing.
 */
function resolveLetter(meta, fileName) {
  const recorded = meta['COVER_LETTER_PATH'];
  if (recorded && existsSync(join(PROJECT_DIR, recorded))) {
    return { path: join(PROJECT_DIR, recorded), repaired: false };
  }

  // A .md sibling of the recorded PDF is the same letter, so it is safe.
  const pdf = meta['COVER_LETTER_PDF'];
  if (pdf) {
    for (const ext of ['.md', '.html']) {
      const sibling = join(PROJECT_DIR, pdf.replace(/\.pdf$/i, ext));
      if (existsSync(sibling)) return { path: sibling, repaired: true };
    }
  }

  const m = fileName.match(/^email-(\d+)-(.+)\.md$/);
  if (!m) return { path: null, repaired: false };
  const [, num, slug] = m;

  const sameJob = allLetters().filter(p => letterNumber(p) === Number(num) && p.toLowerCase().includes(slug.toLowerCase()));
  if (sameJob.length === 0) return { path: null, repaired: false };

  // Prefer markdown; it is the letter as written, not a render of it.
  const pick = sameJob.find(p => p.endsWith('.md')) ?? sameJob[0];
  return { path: pick, repaired: true };
}

function readLetterText(path) {
  const raw = readFileSync(path, 'utf8');
  return path.toLowerCase().endsWith('.html') ? htmlLetterToText(raw) : raw;
}

async function main() {
  const files = readdirSync(OUTPUT_DIR)
    .filter(f => f.startsWith('email-') && f.endsWith('.md'))
    .filter(f => INCLUDE_INIT || !f.startsWith('email-init-'))
    .filter(f => !ONLY || f.includes(ONLY))
    .sort();

  if (files.length === 0) { log('No email files matched.'); return 0; }

  log(`\n=== Rebuild email bodies — ${files.length} file(s) ===`);
  if (IS_DRY_RUN) log('  (dry run — nothing is written)');

  const candidate = loadCandidate(PROJECT_DIR);
  let rewritten = 0, unchanged = 0, noLetter = 0, repairedPaths = 0, pdfsMade = 0;

  // One browser for the whole run, opened only if a letter PDF is actually missing.
  let browser = null;
  const ensurePdf = async (letterPath) => {
    if (NO_PDF || IS_DRY_RUN || !letterPath.endsWith('.md')) return null;
    const expected = letterPath.replace(/\.md$/i, '.pdf');
    if (existsSync(expected)) return expected;
    try {
      if (!browser) browser = await (await import('playwright')).chromium.launch({ headless: true });
      const made = await renderLetterPdf(browser, letterPath);
      pdfsMade++;
      return made;
    } catch (e) {
      warn(`could not render ${toRel(expected)} (${e.message}) — the body still carries the letter text`);
      return null;
    }
  };

  try {
  for (const fileName of files) {
    const full = join(OUTPUT_DIR, fileName);
    const parsed = parseEmailFile(readFileSync(full, 'utf8'));
    if (!parsed) { warn(`${fileName} — no \`---\` separator, skipped`); continue; }

    const { path: letterPath, repaired } = resolveLetter(parsed.meta, fileName);
    if (!letterPath) {
      warn(`${fileName} — no cover letter found, left as is`);
      noLetter++;
      continue;
    }

    // Render the letter PDF before writing the body: the attachment sentence has
    // to describe what save-drafts.mjs will really attach, not what we hope for.
    const existingPdf = parsed.meta['COVER_LETTER_PDF'] && existsSync(join(PROJECT_DIR, parsed.meta['COVER_LETTER_PDF']))
      ? join(PROJECT_DIR, parsed.meta['COVER_LETTER_PDF'])
      : await ensurePdf(letterPath);
    const cvAttached = ['CV_PDF', 'CV_PATH'].some(k => {
      const v = parsed.meta[k];
      return v && existsSync(join(PROJECT_DIR, v.replace(/\.md$/i, '.pdf')));
    });

    const { body, language, source } = buildEmailBody({
      letterMarkdown: readLetterText(letterPath),
      role: parsed.meta['ROLE'] ?? '',
      company: parsed.meta['COMPANY'] ?? '',
      language: parsed.meta['LANGUAGE'],
      candidate,
      attachments: { cv: cvAttached, letter: Boolean(existingPdf) },
    });

    if (source === 'fallback') warn(`${fileName} — letter did not parse into paragraphs, wrote generic body`);

    // Rewrite headers: point COVER_LETTER_PATH at the letter we actually used and
    // record the language we actually wrote in.
    const headers = parsed.headers.map(line => {
      if (/^COVER_LETTER_PATH:/i.test(line)) return `COVER_LETTER_PATH: ${toRel(letterPath)}`;
      if (/^COVER_LETTER_PDF:/i.test(line)) return existingPdf ? `COVER_LETTER_PDF: ${toRel(existingPdf)}` : line;
      if (/^LANGUAGE:/i.test(line)) return `LANGUAGE: ${language}`;
      return line;
    });
    if (!headers.some(l => /^COVER_LETTER_PATH:/i.test(l))) {
      headers.push(`COVER_LETTER_PATH: ${toRel(letterPath)}`);
    }
    if (existingPdf && !headers.some(l => /^COVER_LETTER_PDF:/i.test(l))) {
      headers.push(`COVER_LETTER_PDF: ${toRel(existingPdf)}`);
    }

    const next = `${headers.join('\n')}\n---\n${body}`;
    const prev = readFileSync(full, 'utf8');
    if (next.trim() === prev.trim()) { unchanged++; continue; }

    const words = parsed.body.split(/\s+/).filter(Boolean).length;
    log(`\n📧 ${fileName}  [${language}]`);
    log(`   letter: ${toRel(letterPath)}${repaired ? '  (path repaired)' : ''}`);
    log(`   body:   ${words} words → ${body.split(/\s+/).filter(Boolean).length} words`);
    log(`   attach: ${[cvAttached && 'CV', existingPdf && 'cover letter'].filter(Boolean).join(' + ') || 'none'}`);
    if (repaired) repairedPaths++;

    if (!IS_DRY_RUN) writeFileSync(full, next, 'utf8');
    rewritten++;
  }
  } finally {
    if (browser) await browser.close();
  }

  log('\n=== Summary ===');
  log(`  Rewritten:        ${rewritten}`);
  log(`  Already current:  ${unchanged}`);
  log(`  Paths repaired:   ${repairedPaths}`);
  log(`  Letter PDFs made: ${pdfsMade}`);
  if (noLetter) log(`  No letter found:  ${noLetter}`);

  if (rewritten && !IS_DRY_RUN) {
    log('\n  Next: npm run drafts   (updates the matching Gmail drafts in place)');
  }
  if (rewritten && IS_DRY_RUN) log('\n  Re-run without --dry-run to write these.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(code => process.exit(code))
    .catch(e => { console.error(`❌  ${e.message}`); process.exit(1); });
}
