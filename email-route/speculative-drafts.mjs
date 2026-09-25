// Batch 2: English speculative applications to Munich companies that publish an
// application address. Per company: letter (headless worker) → letter PDF → English CV
// reordered against the roles they are hiring for → email file for save-drafts.mjs.
// Nothing is sent. Run from the project dir: node speculative-drafts.mjs <scratchpad> [--dry-run]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';

const PROJECT = 'C:/Users/PC/Downloads/career-ops-main/career-ops-main';
const P = 'file:///' + PROJECT + '/';
const { buildEmailBody, loadCandidate, BODY_WORDS } = await import(P + 'email-body-core.mjs');
const { renderLetterPdf, withBrowser } = await import(P + 'letter-pdf-core.mjs');
const { writeTailoredCv } = await import(P + 'tailor-cv.mjs');
const { resolveCvPdf } = await import(P + 'cv-pdf.mjs');

const S = process.argv[2];
const DRY = process.argv.includes('--dry-run');
const EXCLUDE = /raumpflege|reinigung|cleaning|gebäudereinigung/i;
const slugify = (s) => (s || 'unknown').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const fixText = (s) => String(s || '').replace(/â€“/g, '–').replace(/Mأ¼/g, 'Mü').replace(/\s+/g, ' ').trim();
const rel = (p) => String(p || '').replace(/\\/g, '/').replace(PROJECT + '/', '').replace(/^[A-Za-z]:\/Users\/PC\/Downloads\/career-ops-main\/career-ops-main\//, '');

const targets = JSON.parse(readFileSync(`${S}/speculative-hits.json`, 'utf8'))
  .filter(t => t.email && !EXCLUDE.test(t.company));
console.log(`${targets.length} speculative target(s)${DRY ? ' (dry run)' : ''}`);

mkdirSync('output/cover-letters', { recursive: true });
const done = [];
for (const t of targets) {
  const company = fixText(t.company);
  const roles = t.roles.map(fixText);
  const slug = slugify(company);
  const letterMd = `${PROJECT}/output/cover-letters/spec-${slug}-en.md`;
  const emailFile = `output/email-spec-${slug}.md`;
  console.log(`\n→ ${company} (${t.email}) — hiring for: ${roles.join(' / ')}`);
  if (existsSync(emailFile)) { console.log('   ↪ email file already exists — skipped'); continue; }
  if (DRY) { console.log(`   [dry] letter → ${rel(letterMd)}; CV → output/cv-tailored/spec-${slug}-en.pdf; email → ${emailFile}`); continue; }

  // 1. letter
  if (!existsSync(letterMd)) {
    writeFileSync('batch/.speculative-context.md', [
      `COMPANY: ${company}`,
      `BASE: München`,
      `ROLES_THEY_ARE_HIRING_FOR: ${roles.join(' | ')}`,
      `POSTING_URLS: ${t.urls.join(' | ')}`,
      `APPLICATION_ADDRESS_SOURCE: ${t.source}`,
      `LANGUAGE: EN`,
      `OUTPUT_PATH: ${letterMd}`,
      '',
    ].join('\n'), 'utf8');
    const res = spawnSync('claude', [
      '-p', '--dangerously-skip-permissions',
      '--append-system-prompt-file', 'batch/speculative-en-worker-prompt.md',
      '--model', 'claude-haiku-4-5-20251001',
      '"Write the speculative application described in batch/.speculative-context.md. Follow your system instructions exactly. Output only the LETTER_PATH line."',
    ], { encoding: 'utf8', shell: true, timeout: 420_000 });
    if (!existsSync(letterMd)) { console.log(`   ❌ no letter written (exit ${res.status ?? 'timeout'}) — skipped`); continue; }
  }
  const letter = readFileSync(letterMd, 'utf8');
  const words = (letter.replace(/^---[\s\S]*?---\s*/, '').match(/\S+/g) || []).length;
  const banned = /visa|work permit|blue card|sponsorship|relocat|n8n/i.exec(letter);
  if (banned) { console.log(`   ⛔ letter contains "${banned[0]}" — not drafted; fix the letter first`); continue; }
  console.log(`   ✍  letter: ${rel(letterMd)} (${words} words)`);

  // 2. letter PDF
  let letterPdf = null;
  try { letterPdf = await withBrowser(browser => renderLetterPdf(browser, letterMd)); console.log(`   📄 letter PDF: ${rel(letterPdf)}`); }
  catch (e) { console.log(`   ⚠️  letter PDF failed (${e.message}) — the mail will carry the CV only`); }

  // 3. CV, bullets reordered against the roles they hire for (no words changed).
  // German Lebenslauf everywhere, including English-language letters — his instruction
  // on 2026-09-16 ("the deutsch version of my cv from now on ... anywhere even with
  // emails"). The letter stays English; only the attachment is German.
  let cvPdf = resolveCvPdf({ relative: true });
  try {
    const r = await writeTailoredCv({ role: 'Operations', company, jdText: roles.join('\n'), slug, num: 'spec' }, { pdf: true, lang: 'de' });
    if (r.pdfPath) { cvPdf = rel(r.pdfPath); console.log(`   📄 tailored CV: ${cvPdf} (${r.moves.length} block(s) reordered, 0 words changed)`); }
  } catch (e) { console.log(`   ⚠️  CV tailoring failed (${e.message}) — attaching the standard German CV`); }

  // 4. email file
  const { body } = buildEmailBody({
    letterMarkdown: letter,
    role: 'Operations',
    company,
    language: 'EN',
    candidate: loadCandidate(PROJECT),
    attachments: { cv: existsSync(cvPdf), letter: Boolean(letterPdf) },
    intentLine: `I am writing to you with a speculative application for an operations role at ${company}.`,
    maxWords: BODY_WORDS.standard,
  });
  writeFileSync(emailFile, [
    `TO: ${t.email}`,
    `SUBJECT: Speculative application — Operations (Munich)`,
    `COMPANY: ${company}`,
    `ROLE: Speculative application — Operations`,
    `SCORE: 3.0`,
    `SCORE_SOURCE: speculative — no posting; company publishes an application address and hires in Munich`,
    `EMAIL_VERIFIED: yes`,
    `EMAIL_SOURCE: published by the company at ${t.source}`,
    `LANGUAGE: EN`,
    `COVER_LETTER_PATH: ${rel(letterMd)}`,
    letterPdf ? `COVER_LETTER_PDF: ${rel(letterPdf)}` : '',
    `CV_PDF: ${cvPdf}`,
    `CAREERS_URL: ${t.source}`,
    '---',
    body,
    '',
  ].filter(Boolean).join('\n'), 'utf8');
  console.log(`   📧 email file: ${emailFile}`);
  done.push({ company, email: t.email, emailFile, words });
}
console.log(`\n${done.length} speculative email file(s) written`);
for (const d of done) console.log(`  ${d.company.padEnd(40)} ${d.email.padEnd(28)} ${d.words} words`);
