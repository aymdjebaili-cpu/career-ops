#!/usr/bin/env node
/**
 * daily-run.mjs — end-to-end orchestrator for the career-ops daily job search.
 *
 * Pipeline:
 *   1. node scan.mjs                    → populate data/pipeline.md with new junior+DE postings
 *   2. node check-liveness.mjs          → drop dead links from "## Pendientes"
 *   3. for each new pending URL:
 *        claude -p "auto-pipeline …"    → produces reports/{num}-{slug}.md + tracker TSV
 *   4. node merge-tracker.mjs           → consolidate applications.md
 *   5. for each fresh report with score ≥ threshold:
 *        node generate-cover-letter.mjs → output/cover-letters/{num}-{slug}-{lang}.md
 *        if recruiter email exists      → write output/email-{num}-{slug}.md (metadata for save-drafts.mjs)
 *        append a row to output/applications-index.md (always)
 *   6. node save-drafts.mjs --score=N   → push email-*.md files to Gmail drafts (skipped if no OAuth)
 *
 * Usage:
 *   node daily-run.mjs                  # full run
 *   node daily-run.mjs --dry-run        # do everything except invoke claude and save Gmail drafts
 *   node daily-run.mjs --skip-scan      # skip step 1 (use existing pipeline)
 *   node daily-run.mjs --skip-eval      # skip steps 2-4 (only post-process existing reports)
 *   node daily-run.mjs --score=3.5      # threshold for cover letter + draft (default 3.5)
 *   node daily-run.mjs --max=10         # cap how many pending URLs to evaluate this run
 *   node daily-run.mjs --cli=claude     # which AI CLI to call (default: claude)
 *
 * Exit codes:
 *   0  success (with summary of what was done)
 *   1  fatal error
 *   2  partial failure (some steps ok, some failed)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const REPORTS_DIR = join(PROJECT_DIR, 'reports');
const OUTPUT_DIR = join(PROJECT_DIR, 'output');
const COVER_DIR = join(OUTPUT_DIR, 'cover-letters');
const PIPELINE_FILE = join(PROJECT_DIR, 'data', 'pipeline.md');
const INDEX_FILE = join(OUTPUT_DIR, 'applications-index.md');
const LAST_RUN_FILE = join(OUTPUT_DIR, '.last-run.json');

// ─────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name, def) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
};

const IS_DRY_RUN = flag('dry-run');
const SKIP_SCAN  = flag('skip-scan');
const SKIP_EVAL  = flag('skip-eval');
const THRESHOLD  = parseFloat(arg('score', '2.5'));
const MAX_EVAL   = parseInt(arg('max', '10'), 10);  // lowered to 10 for daily token budget
const CLI        = arg('cli', 'claude');
const MODEL      = arg('model', 'claude-haiku-4-5-20251001');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function log(msg)  { console.log(msg); }
function step(n, msg) { console.log(`\n=== Step ${n}: ${msg} ===`); }
function ok(msg)   { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function err(msg)  { console.log(`  ❌ ${msg}`); }

function run(cmd, argsArr, { allowFail = false } = {}) {
  if (IS_DRY_RUN) {
    log(`  [DRY] ${cmd} ${argsArr.join(' ')}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  const res = spawnSync(cmd, argsArr, { cwd: PROJECT_DIR, encoding: 'utf8', shell: true });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${argsArr.join(' ')} → exit ${res.status}`);
  }
  return res;
}

function readPipelinePendientes() {
  if (!existsSync(PIPELINE_FILE)) return [];
  let raw = readFileSync(PIPELINE_FILE);
  // Handle UTF-16 BOM (the file may have been created in PowerShell)
  if (raw[0] === 0xFF && raw[1] === 0xFE) raw = Buffer.from(raw.toString('utf16le'));
  const text = raw.toString('utf8');
  const lines = text.split('\n');
  const out = [];
  let inSection = false;
  for (const ln of lines) {
    if (/^##\s+Pendientes/i.test(ln)) { inSection = true; continue; }
    if (/^##\s+/.test(ln) && inSection) break;
    if (!inSection) continue;
    const m = ln.match(/^-\s*\[\s*\]\s*(\S+)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/);
    if (m) out.push({ url: m[1].trim(), company: m[2].trim(), role: m[3].trim() });
  }
  return out;
}

function existingReportsSet() {
  if (!existsSync(REPORTS_DIR)) return new Set();
  return new Set(readdirSync(REPORTS_DIR).filter(f => /^\d{3}-.+\.md$/.test(f)));
}

function parseReportHeader(reportPath) {
  const content = readFileSync(reportPath, 'utf8');
  const head = content.split('\n').slice(0, 60).join('\n');
  const grab = (label) => {
    const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i');
    const m = head.match(re);
    return m ? m[1].trim() : '';
  };
  const fname = basename(reportPath, '.md');
  const numMatch = fname.match(/^(\d{3})-/);
  const num = numMatch ? numMatch[1] : '000';

  // Title-line fallback: "# Evaluation: COMPANY — ROLE"
  let titleCompany = '', titleRole = '';
  const titleLine = head.split('\n').find(l => /^#\s+/.test(l)) || '';
  const titleStripped = titleLine.replace(/^#\s+(Evaluation|Evaluación|Bewertung|Évaluation):\s*/i, '').replace(/^#\s+/, '');
  const titleParts = titleStripped.split(/\s+[—–-]\s+/);
  if (titleParts.length >= 2) {
    titleCompany = titleParts[0].trim();
    titleRole = titleParts.slice(1).join(' — ').trim();
  }

  const company = grab('Company') || grab('Empresa') || grab('Unternehmen') || titleCompany || 'Unknown';
  const role    = grab('Role')    || grab('Puesto')  || grab('Position')   || titleRole    || 'Unknown';
  const url     = grab('URL');
  const scoreRaw = grab('Score')  || grab('Puntuación') || grab('Punktzahl');
  const score = parseFloat(scoreRaw.match(/([\d.]+)/)?.[1] || '0');
  let language  = (grab('Language') || grab('Idioma') || grab('Sprache') || '').toUpperCase();

  // Look for an email address anywhere in the body (Block G usually surfaces it if present)
  const emailMatch = content.match(/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i);
  const recruiterEmail = emailMatch && !emailMatch[1].toLowerCase().includes('aym.djebaili')
    ? emailMatch[1] : null;

  return { num, company, role, url, score, language: language || 'EN', recruiterEmail, fname };
}

function slugify(s) {
  return (s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function ensureIndexHeader() {
  if (existsSync(INDEX_FILE)) return;
  const header = `# Applications Index

Auto-maintained by \`daily-run.mjs\`. One row per job evaluated with score ≥ threshold.

| Date | Company | Role | Score | JD URL | Cover Letter | Apply via | Status |
|------|---------|------|-------|--------|--------------|-----------|--------|
`;
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, header, 'utf8');
}

function appendToIndex(row) {
  ensureIndexHeader();
  const md = readFileSync(INDEX_FILE, 'utf8');
  // De-dup by report number
  const reportToken = `cover-letters/${row.num}-`;
  if (md.includes(reportToken)) {
    log(`     ↪ index already has row for report ${row.num}, skipping`);
    return;
  }
  const line = `| ${row.date} | ${row.company} | ${row.role} | ${row.score}/5 | [link](${row.url}) | [${basename(row.coverPath)}](cover-letters/${basename(row.coverPath)}) | ${row.applyVia} | ${row.status} |\n`;
  appendFileSync(INDEX_FILE, line, 'utf8');
}

function writeEmailDraftFile(report, coverPath) {
  const file = join(OUTPUT_DIR, `email-${report.num}-${slugify(report.company)}.md`);
  if (existsSync(file)) { log(`     ↪ email draft file already exists: ${basename(file)}`); return file; }
  const langSubject = report.language === 'DE'
    ? `Bewerbung: ${report.role}`
    : report.language === 'FR'
      ? `Candidature : ${report.role}`
      : `Application: ${report.role}`;
  const greeting = report.language === 'DE' ? 'Sehr geehrte Damen und Herren,'
                : report.language === 'FR' ? 'Madame, Monsieur,'
                : 'Dear Hiring Team,';
  const sign = report.language === 'DE' ? 'Mit freundlichen Grüßen,'
             : report.language === 'FR' ? 'Cordialement,'
             : 'Best regards,';
  const body = `TO: ${report.recruiterEmail}
SUBJECT: ${langSubject}
COMPANY: ${report.company}
ROLE: ${report.role}
SCORE: ${report.score}
EMAIL_VERIFIED: unverified
LANGUAGE: ${report.language}
COVER_LETTER_PATH: output/cover-letters/${basename(coverPath)}
CV_PATH: output/cv-updated.pdf
JD_URL: ${report.url}
---
${greeting}

Please find attached my CV and a tailored cover letter for the ${report.role} position.

${sign}
AIMENE DJEBAILI
Aym.djebaili@gmail.com
`;
  writeFileSync(file, body, 'utf8');
  return file;
}

// ─────────────────────────────────────────────
// Step runners
// ─────────────────────────────────────────────
function stepScan() {
  step(1, 'Scan portals for new junior+DE postings');
  if (SKIP_SCAN) { warn('skipped via --skip-scan'); return; }
  run('node', ['scan.mjs']);
  ok('scan complete');
}

function stepLiveness() {
  step(2, 'Liveness check on pending URLs');
  if (SKIP_EVAL) { warn('skipped via --skip-eval'); return; }

  const pending = readPipelinePendientes();
  if (pending.length === 0) { log('  no pending URLs'); return; }

  const urls = pending.map(p => p.url);
  run('node', ['check-liveness.mjs', ...urls], { allowFail: true });
  ok('liveness check done (errors tolerated)');
}

async function fetchJobContent(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000); // 15s timeout
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Extract text from HTML (simple: strip tags, take first 3000 chars of content)
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);
    return text;
  } catch (e) {
    return null;
  }
}

async function stepEvaluate() {
  step(3, 'Evaluate pending URLs via headless worker');
  if (SKIP_EVAL) { warn('skipped via --skip-eval'); return []; }

  const pending = readPipelinePendientes();
  if (pending.length === 0) { log('  no pending URLs'); return []; }
  log(`  found ${pending.length} pending URLs (will evaluate up to ${MAX_EVAL})`);

  const before = existingReportsSet();
  const toEval = pending.slice(0, MAX_EVAL);
  const workerPromptFile = join(PROJECT_DIR, 'batch', 'daily-worker-prompt.md');

  // Fetch JD content for each URL, then evaluate
  for (const item of toEval) {
    log(`  → ${item.company} | ${item.role}`);

    if (IS_DRY_RUN) {
      log(`  [DRY] would fetch and evaluate ${item.url}`);
      continue;
    }

    // Fetch job posting content
    const jobContent = await fetchJobContent(item.url);
    if (!jobContent) {
      warn(`     fetch failed, skipping`);
      continue;
    }
    if (!IS_DRY_RUN) {
      log(`     fetched ${jobContent.length} chars of JD content`);
    }

    // For now, skip automation — it's not reliable in headless mode
    // User should evaluate using interactive /career-ops {URL} command
    warn(`     automated headless eval not working reliably; use: /career-ops ${item.url}`);
  }

  const after = existingReportsSet();
  const fresh = [...after].filter(f => !before.has(f));
  ok(`evaluated ${toEval.length} URL(s); ${fresh.length} new report(s) produced`);
  return fresh;
}

function stepMergeTracker() {
  step(4, 'Merge tracker additions into applications.md');
  if (SKIP_EVAL) { warn('skipped'); return; }
  run('node', ['merge-tracker.mjs'], { allowFail: true });
  ok('merge done');
}

function stepCoverLettersAndDrafts(freshReports) {
  step(5, `Generate cover letters + email drafts (threshold ≥ ${THRESHOLD}/5)`);

  // If --skip-eval, scan all reports created today as candidates
  let candidates = freshReports;
  if (candidates.length === 0) {
    const allReports = existsSync(REPORTS_DIR) ? readdirSync(REPORTS_DIR).filter(f => /^\d{3}-.+\.md$/.test(f)) : [];
    const today = new Date().toISOString().slice(0, 10);
    candidates = allReports.filter(f => f.endsWith(`${today}.md`));
    if (candidates.length) log(`  no fresh-this-step reports — falling back to ${candidates.length} reports dated ${today}`);
  }

  if (!existsSync(COVER_DIR)) mkdirSync(COVER_DIR, { recursive: true });
  ensureIndexHeader();

  const results = { qualified: 0, coverLetters: 0, emailDrafts: 0, indexed: 0, skippedLowScore: 0 };

  for (const fname of candidates) {
    const reportPath = join(REPORTS_DIR, fname);
    let meta;
    try { meta = parseReportHeader(reportPath); }
    catch (e) { warn(`could not parse ${fname}: ${e.message}`); continue; }

    log(`  • ${meta.num} | ${meta.company} | ${meta.role} | score ${meta.score}/5 | ${meta.language}`);

    if (meta.score < THRESHOLD) {
      log(`     ⏭️  below threshold (${THRESHOLD}) → no cover letter, no draft, not indexed`);
      results.skippedLowScore++;
      continue;
    }
    results.qualified++;

    // Cover letter
    const coverRes = run('node', ['generate-cover-letter.mjs', `reports/${fname}`], { allowFail: true });
    const coverPath = join(COVER_DIR, `${meta.num}-${slugify(meta.company)}-${meta.language.toLowerCase()}.md`);
    if (!existsSync(coverPath) && !IS_DRY_RUN) {
      warn(`     cover letter not found at ${coverPath} — skipping draft + index`);
      continue;
    }
    results.coverLetters++;

    // Email draft file (only if we have a recruiter email)
    let applyVia;
    if (meta.recruiterEmail) {
      const emailFile = writeEmailDraftFile(meta, coverPath);
      log(`     📧 email-draft file: ${basename(emailFile)} (to ${meta.recruiterEmail})`);
      applyVia = 'Email draft (review in Gmail)';
      results.emailDrafts++;
    } else {
      applyVia = 'Form (no email — paste cover letter manually)';
    }

    // Index row
    appendToIndex({
      date: new Date().toISOString().slice(0, 10),
      company: meta.company,
      role: meta.role,
      score: meta.score,
      url: meta.url || '(no URL)',
      coverPath,
      num: meta.num,
      applyVia,
      status: 'Awaiting review',
    });
    results.indexed++;
  }

  ok(`qualified: ${results.qualified}, cover letters: ${results.coverLetters}, email drafts: ${results.emailDrafts}, indexed: ${results.indexed}, skipped (low score): ${results.skippedLowScore}`);
  return results;
}

function stepSaveDrafts() {
  step(6, 'Push email-draft files to Gmail');
  const tokenFile = join(PROJECT_DIR, 'config', 'gmail-token.json');
  if (!existsSync(tokenFile)) {
    warn('Gmail OAuth not set up (config/gmail-token.json missing) — skipping. Run `node save-drafts.mjs --setup` once.');
    return { skipped: true };
  }
  const res = run('node', ['save-drafts.mjs', `--score=${THRESHOLD}`], { allowFail: true });
  if (res.status === 0) ok('Gmail drafts pushed');
  else warn(`save-drafts.mjs exit ${res.status} (continuing)`);
  return { skipped: false, status: res.status };
}

function writeLastRun(summary) {
  if (IS_DRY_RUN) return;
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(LAST_RUN_FILE, JSON.stringify({ at: new Date().toISOString(), ...summary }, null, 2));
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  log(`\n=== career-ops daily run — ${new Date().toISOString()} ===`);
  log(`  threshold:    ${THRESHOLD}/5`);
  log(`  max evaluate: ${MAX_EVAL}`);
  log(`  cli:          ${CLI}`);
  log(`  dry-run:      ${IS_DRY_RUN}`);
  log(`  skip-scan:    ${SKIP_SCAN}`);
  log(`  skip-eval:    ${SKIP_EVAL}`);

  const summary = { threshold: THRESHOLD, errors: [] };

  try { stepScan(); }
  catch (e) { err(`scan failed: ${e.message}`); summary.errors.push(`scan: ${e.message}`); }

  try { stepLiveness(); }
  catch (e) { err(`liveness failed: ${e.message}`); summary.errors.push(`liveness: ${e.message}`); }

  let freshReports = [];
  try { freshReports = await stepEvaluate(); }
  catch (e) { err(`evaluate failed: ${e.message}`); summary.errors.push(`evaluate: ${e.message}`); }

  try { stepMergeTracker(); }
  catch (e) { err(`merge failed: ${e.message}`); summary.errors.push(`merge: ${e.message}`); }

  let postResults = {};
  try { postResults = stepCoverLettersAndDrafts(freshReports); }
  catch (e) { err(`cover-letter step failed: ${e.message}`); summary.errors.push(`cover-letter: ${e.message}`); }

  let draftRes = {};
  try { draftRes = stepSaveDrafts(); }
  catch (e) { err(`save-drafts failed: ${e.message}`); summary.errors.push(`save-drafts: ${e.message}`); }

  summary.freshReports = freshReports.length;
  summary.coverLetters = postResults.coverLetters || 0;
  summary.emailDrafts  = postResults.emailDrafts  || 0;
  summary.indexed      = postResults.indexed      || 0;
  summary.gmailPushed  = !draftRes.skipped;

  writeLastRun(summary);

  log('\n=== Summary ===');
  log(`  fresh reports:     ${summary.freshReports}`);
  log(`  cover letters:     ${summary.coverLetters}`);
  log(`  email draft files: ${summary.emailDrafts}`);
  log(`  indexed in applications-index.md: ${summary.indexed}`);
  log(`  Gmail drafts pushed: ${summary.gmailPushed ? 'yes' : 'no (OAuth not set up)'}`);
  if (summary.errors.length) {
    log(`  ⚠️  errors: ${summary.errors.length}`);
    for (const e of summary.errors) log(`     - ${e}`);
    process.exit(2);
  }
  log('\n✅ daily run complete\n');
}

main().catch(e => { console.error('\n❌ fatal:', e.message); process.exit(1); });
