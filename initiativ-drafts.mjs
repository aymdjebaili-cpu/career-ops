#!/usr/bin/env node
/**
 * initiativ-drafts.mjs — speculative applications (Initiativbewerbung) to German
 * travel agencies and tour operators, built on the Algeria market-development pitch.
 *
 * WHY THIS EXISTS SEPARATELY FROM daily-run.mjs
 * daily-run.mjs starts from a job posting: scan → evaluate → letter → draft. These
 * companies have no scannable posting (they are Mittelstand on their own careers
 * pages, invisible to scan.mjs) and, more fundamentally, no posted job description
 * will ever ask for "someone who can open the Algerian market". The pitch creates
 * the role, so the pipeline has to start from the target list instead.
 *
 * Pipeline:
 *   1. read config/initiativ-targets.yml
 *   2. per target: claude -p (headless) + batch/initiativ-worker-prompt.md
 *                  → output/cover-letters/init-{slug}-de.md
 *   3. render that letter to PDF via Playwright  → init-{slug}-de.pdf
 *   4. if the target has a VERIFIED email:       → output/email-init-{slug}.md
 *      (which `npm run drafts` then pushes to Gmail as a reviewable draft)
 *      if not: letter only, and the run tells you to use the careers page by hand.
 *
 * Nothing here sends anything. save-drafts.mjs creates Gmail *drafts*; you press send.
 *
 * Usage:
 *   node initiativ-drafts.mjs                  # verified-email targets only (default)
 *   node initiativ-drafts.mjs --all            # every target; unverified ones get a letter only
 *   node initiativ-drafts.mjs --only=ikarus-tours,gebeco
 *   node initiativ-drafts.mjs --list           # show the target table and exit
 *   node initiativ-drafts.mjs --dry-run        # resolve + report, never invoke claude
 *   node initiativ-drafts.mjs --force          # regenerate letters that already exist
 *   node initiativ-drafts.mjs --pdf-only       # after hand-editing a letter: re-render
 *                                              # its PDF + email file, keep your edits
 *
 * Exit codes:
 *   0  success   1  fatal error   2  partial failure
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';
import { buildEmailBody, loadCandidate, BODY_WORDS } from './email-body-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const TARGETS_FILE = join(PROJECT_DIR, 'config', 'initiativ-targets.yml');
const OUTPUT_DIR = join(PROJECT_DIR, 'output');
const COVER_DIR = join(OUTPUT_DIR, 'cover-letters');
const CONTEXT_FILE = join(PROJECT_DIR, 'batch', '.initiativ-context.md');
const CV_PDF = join(OUTPUT_DIR, 'cv-updated.pdf');

// ─────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const arg = (n, def) => args.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? def;

const IS_DRY_RUN = flag('dry-run');
const IS_FORCE = flag('force');
// These letters get hand-edited before they go out — --pdf-only re-renders the PDF
// and rewrites the email file from the letter ON DISK, without asking the model to
// write a new one over your corrections (which is what --force does).
const PDF_ONLY = flag('pdf-only');
const IS_LIST = flag('list');
const DO_ALL = flag('all');
const ONLY = arg('only', '').split(',').map(s => s.trim()).filter(Boolean);
const CLI = arg('cli', 'claude');
const MODEL = arg('model', 'claude-haiku-4-5-20251001');
// save-drafts.mjs gates on SCORE >= 3.5. A speculative letter has no evaluation
// behind it, so this is a self-assessed fit, recorded honestly as such in the
// email file's SCORE_SOURCE line rather than dressed up as a report score.
const SCORE = arg('score', '4.5');

function log(m)  { console.log(m); }
function ok(m)   { console.log(`  ✅ ${m}`); }
function warn(m) { console.log(`  ⚠️  ${m}`); }
function err(m)  { console.log(`  ❌ ${m}`); }

// ─────────────────────────────────────────────
// Targets
// ─────────────────────────────────────────────
function loadTargets() {
  if (!existsSync(TARGETS_FILE)) {
    throw new Error(`Missing ${TARGETS_FILE}. It ships with the repo — restore it from git.`);
  }
  const cfg = yaml.load(readFileSync(TARGETS_FILE, 'utf8'));
  const targets = cfg?.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('config/initiativ-targets.yml has no `targets:` list.');
  }
  return targets.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
}

function selectTargets(all) {
  if (ONLY.length) {
    const picked = all.filter(t => ONLY.includes(t.slug));
    const missing = ONLY.filter(s => !all.some(t => t.slug === s));
    missing.forEach(s => warn(`--only=${s} matches no target in config/initiativ-targets.yml`));
    return picked;
  }
  if (DO_ALL) return all;
  return all.filter(t => t.verified === true && t.email);
}

function printTable(targets) {
  log('\n  #  Company                              Base                 Email');
  log('  ─  ───────────────────────────────────  ───────────────────  ─────────────────────────');
  for (const t of targets) {
    const p = String(t.priority ?? '?').padStart(2);
    const c = String(t.company).padEnd(35).slice(0, 35);
    const b = String(t.base ?? '').padEnd(19).slice(0, 19);
    const e = t.verified && t.email ? `✅ ${t.email}` : '— no verified address';
    log(`  ${p}  ${c}  ${b}  ${e}`);
  }
}

// ─────────────────────────────────────────────
// Step 1 — generate the letter (headless worker)
// ─────────────────────────────────────────────
function generateLetter(target) {
  const outFile = join(COVER_DIR, `init-${target.slug}-de.md`);

  if (PDF_ONLY) {
    if (!existsSync(outFile)) { err(`--pdf-only but no letter at ${outFile}`); return null; }
    ok(`using letter on disk: ${outFile.split(/[\\/]/).pop()}`);
    return outFile;
  }
  if (existsSync(outFile) && !IS_FORCE) {
    ok(`letter exists — skip (use --force to regenerate): ${outFile.split(/[\\/]/).pop()}`);
    return outFile;
  }
  if (!existsSync(COVER_DIR)) mkdirSync(COVER_DIR, { recursive: true });

  if (IS_DRY_RUN) {
    // Return the path the real run would write, so the caller reports accurate
    // counts. Every downstream write is separately guarded by IS_DRY_RUN.
    log(`  [DRY] would invoke ${CLI} with batch/initiativ-worker-prompt.md → ${outFile}`);
    return outFile;
  }

  writeFileSync(CONTEXT_FILE, [
    `COMPANY: ${target.company}`,
    `BASE: ${target.base ?? ''}`,
    `CAREERS_URL: ${target.careers_url ?? ''}`,
    `ANGLE: ${(target.angle ?? '').trim()}`,
    `TARGET_ROLES: ${(target.target_roles ?? []).join(', ')}`,
    `EMPLOYER_NOTES: ${(target.notes ?? '').trim()}`,
    `LANGUAGE: DE`,
    `OUTPUT_PATH: ${outFile}`,
    '',
  ].join('\n'), 'utf8');

  // Proven headless pattern (see batch/daily-worker-prompt.md and
  // feedback-claude-headless-pattern): instructions live in a system-prompt file
  // and the user message stays short. A long inline prompt lets CLAUDE.md
  // onboarding hijack the turn ("How can I help you today?") and nothing is written.
  log(`  → ${CLI} -p --append-system-prompt-file batch/initiativ-worker-prompt.md --model ${MODEL}`);
  const res = spawnSync(CLI, [
    '-p',
    '--dangerously-skip-permissions',
    '--append-system-prompt-file', 'batch/initiativ-worker-prompt.md',
    '--model', MODEL,
    '"Write the Initiativbewerbung described in batch/.initiativ-context.md. Follow your system instructions exactly. Output only the LETTER_PATH line."',
  ], { cwd: PROJECT_DIR, stdio: 'inherit', shell: true, timeout: 420_000 });

  if (res.status !== 0) { err(`${CLI} exited with status ${res.status}`); return null; }
  if (!existsSync(outFile)) { err(`expected letter at ${outFile}, nothing was written`); return null; }

  ok(`letter written: ${outFile.split(/[\\/]/).pop()}`);
  return outFile;
}

// ─────────────────────────────────────────────
// Step 2 — render the letter to PDF
// Mirrors ensureCoverPdf() in auto-apply.mjs so both paths produce the same look.
// ─────────────────────────────────────────────
async function renderPdf(browser, mdPath) {
  const pdfPath = mdPath.replace(/\.md$/, '.pdf');
  if (existsSync(pdfPath) && !IS_FORCE && !PDF_ONLY) return pdfPath;

  const raw = readFileSync(mdPath, 'utf8');
  // Markdown emphasis has to be converted, not passed through: the renderer below
  // does no markdown parsing, so a stray **bold** in the letter prints as literal
  // asterisks in the PDF that goes to the employer.
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = esc(raw.replace(/^---[\s\S]*?---\s*/, '').trim())
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*(?!\s)(.+?)(?<!\s)\*(?=[\s.,;:)!?]|$)/gs, '$1<em>$2</em>')
    .replace(/^#{1,6}\s+/gm, '');
  const html = `<html><head><meta charset="utf-8"><style>
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.55; color: #1a1a1a; max-width: 17cm; margin: 0 auto; }
    p { margin: 0 0 0.9em 0; text-align: justify; }
  </style></head><body>${body.split(/\n\s*\n/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n')}</body></html>`;

  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: pdfPath, format: 'A4', margin: { top: '2.2cm', bottom: '2.2cm', left: '2cm', right: '2cm' } });
  } finally {
    await page.close();
  }
  ok(`PDF rendered: ${pdfPath.split(/[\\/]/).pop()}`);
  return pdfPath;
}

// ─────────────────────────────────────────────
// Step 3 — email file for save-drafts.mjs
// Format must match parseEmailFile() in save-drafts.mjs: "KEY: value" lines,
// a bare "---", then the body.
// ─────────────────────────────────────────────
function writeEmailFile(target, letterMd, letterPdf) {
  const emailPath = join(OUTPUT_DIR, `email-init-${target.slug}.md`);
  const rel = (p) => p ? p.replace(PROJECT_DIR, '').replace(/^[\\/]/, '').replace(/\\/g, '/') : '';

  const subject = `Initiativbewerbung: Marktentwicklung Algerien — Produkt- und Zielgebietsmanagement`;

  // The body carries the company-specific letter, not a fixed summary: these
  // letters are written per target (each one names that operator's own gap in
  // North Africa), and six identical mails would throw all of that away.
  const { body } = buildEmailBody({
    letterMarkdown: existsSync(letterMd) ? readFileSync(letterMd, 'utf8') : null,
    role: (target.target_roles ?? ['Produktmanagement Touristik'])[0],
    company: target.company,
    language: 'DE',
    candidate: loadCandidate(PROJECT_DIR),
    attachments: { cv: existsSync(CV_PDF), letter: Boolean(letterPdf) },
    // No posted vacancy exists here, so "I am applying for the X position" would
    // be false. State what the mail actually is.
    intentLine: `hiermit sende ich Ihnen meine Initiativbewerbung für ${target.company}.`,
    // A speculative mail has to explain why it exists before the pitch lands —
    // there is no posting the reader can look up. Slightly longer than a reply
    // to an advertised role, still one screen.
    maxWords: BODY_WORDS.standard,
  });

  const content = [
    `TO: ${target.email}`,
    `SUBJECT: ${subject}`,
    `COMPANY: ${target.company}`,
    `ROLE: Initiativbewerbung — ${(target.target_roles ?? ['Produktmanagement Touristik'])[0]}`,
    `SCORE: ${SCORE}`,
    `SCORE_SOURCE: speculative — self-assessed fit, NOT an evaluation report`,
    // save-drafts.mjs tests this against the literal string 'yes' to decide whether
    // to print the ⚠️ unverified warning — any suffix here turns a verified address
    // into a warning. Keep the value bare; the provenance goes on its own line.
    `EMAIL_VERIFIED: yes`,
    `EMAIL_SOURCE: ${target.email_source ?? 'address marked verified in config/initiativ-targets.yml'}`,
    `LANGUAGE: DE`,
    `COVER_LETTER_PATH: ${rel(letterMd)}`,
    letterPdf ? `COVER_LETTER_PDF: ${rel(letterPdf)}` : '',
    `CV_PDF: ${rel(CV_PDF)}`,
    `CAREERS_URL: ${target.careers_url ?? ''}`,
    '---',
    body,
    '',
  ].filter(Boolean).join('\n');

  writeFileSync(emailPath, content, 'utf8');
  ok(`email file: ${emailPath.split(/[\\/]/).pop()}  → run \`npm run drafts\` to push to Gmail`);
  return emailPath;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  const all = loadTargets();

  if (IS_LIST) {
    log(`\n=== Initiativbewerbung targets (${all.length}) ===`);
    printTable(all);
    log('\n  Default run drafts only the ✅ rows. Use --all to write letters for the rest.');
    return 0;
  }

  const targets = selectTargets(all);
  if (targets.length === 0) {
    warn('No targets selected.');
    log('  Default is verified-email targets only. Use --all, or --only=slug1,slug2.');
    log('  See the table with: node initiativ-drafts.mjs --list');
    return 0;
  }

  log(`\n=== Initiativbewerbung run — ${targets.length} target(s) ===`);
  if (IS_DRY_RUN) log('  (dry run — claude is never invoked, no files are written)');
  if (!existsSync(CV_PDF)) warn(`CV PDF not found at ${CV_PDF} — drafts will go out without a CV attached.`);

  // Playwright is only needed if we actually produced letters to render.
  let browser = null;
  const openBrowser = async () => {
    if (browser || IS_DRY_RUN) return browser;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    return browser;
  };

  const done = [];
  const manual = [];
  let failed = 0;

  try {
    for (const t of targets) {
      log(`\n→ ${t.company} (${t.base ?? '?'})`);

      const letterMd = generateLetter(t);
      if (!letterMd) { failed++; continue; }

      let letterPdf = null;
      if (!IS_DRY_RUN) {
        try {
          letterPdf = await renderPdf(await openBrowser(), letterMd);
        } catch (e) {
          warn(`PDF render failed (${e.message}) — email will carry the CV only.`);
        }
      }

      if (t.verified === true && t.email) {
        if (!IS_DRY_RUN) writeEmailFile(t, letterMd, letterPdf);
        else log(`  [DRY] would write output/email-init-${t.slug}.md → ${t.email}`);
        done.push(t);
      } else {
        warn(`no verified address — letter only. Send via ${t.careers_url ?? 'their careers page'}`);
        manual.push(t);
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  // ── Summary ──
  log('\n=== Summary ===');
  log(`  Letters generated:     ${done.length + manual.length}`);
  log(`  Gmail-draft ready:     ${done.length}`);
  log(`  Manual send required:  ${manual.length}`);
  if (failed) log(`  Failed:                ${failed}`);

  if (done.length) {
    log('\n  Next: npm run drafts        (pushes them to Gmail as drafts — review, then send)');
    done.forEach(t => log(`    • ${t.company} → ${t.email}`));
  }
  if (manual.length) {
    log('\n  These have no verified address. Paste the letter into their form by hand:');
    manual.forEach(t => log(`    • ${t.company.padEnd(34)} ${t.careers_url ?? ''}`));
    log('\n  Found a real address? Set `email:` and `verified: true` in');
    log('  config/initiativ-targets.yml, then re-run with --only=<slug>.');
  }

  log('\n  Nothing was sent. Every application waits for you to press send.');
  return failed ? 2 : 0;
}

// On Windows `import.meta.url === \`file://${process.argv[1]}\`` never matches
// (backslash path vs file:// URL) and the script silently no-ops. Use pathToFileURL.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(code => process.exit(code))
    .catch(e => { console.error(`❌  ${e.message}`); process.exit(1); });
}

export { loadTargets, selectTargets };
