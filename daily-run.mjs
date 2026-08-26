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
 *   node daily-run.mjs --no-lang-priority  # stop evaluating German-marked postings last
 *
 * Exit codes:
 *   0  success (with summary of what was done)
 *   1  fatal error
 *   2  partial failure (some steps ok, some failed)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { findRecruiterEmail } from './find-recruiter-email.mjs';
import { findApplicationEmail, isApplicationInbox } from './find-application-email.mjs';
import { buildEmailBody, languageSlug, loadCandidate } from './email-body-core.mjs';
import { renderLetterPdf, withBrowser } from './letter-pdf-core.mjs';
import { reportContext, writeTailoredCv } from './tailor-cv.mjs';

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
const SKIP_LIVENESS = flag('skip-liveness');
// German-marked postings are evaluated last (see pickAcrossSources). Pass
// --no-lang-priority to treat every language equally — worth doing if the
// candidate's German reaches B1/B2 and the A2 blocker stops applying.
const NO_LANG_PRIORITY = flag('no-lang-priority');
const THRESHOLD  = parseFloat(arg('score', '3.5'));  // keep in sync with scheduler/daily-run.ps1 and npm run apply
const MAX_EVAL   = parseInt(arg('max', '25'), 10);  // per-day eval budget (each eval = one headless haiku session)
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
    // The 4th field (location) is optional: entries scanned before 2026-08-17
    // don't have one, and a role title may itself contain a pipe.
    const m = ln.match(/^-\s*\[\s*\]\s*(\S+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|\s*([^|]+?)\s*)?$/);
    if (m) out.push({ url: m[1].trim(), company: m[2].trim(), role: m[3].trim(), location: (m[4] || '').trim() });
  }
  return out;
}

function readPipelineText() {
  if (!existsSync(PIPELINE_FILE)) return '';
  let raw = readFileSync(PIPELINE_FILE);
  if (raw[0] === 0xFF && raw[1] === 0xFE) raw = Buffer.from(raw.toString('utf16le'));
  return raw.toString('utf8');
}

// Move a URL out of "## Pendientes" into "## Procesadas" (used when the worker
// can't do it itself: expired links, repeated eval failures).
function movePendingToProcesadas(url, status, note) {
  const text = readPipelineText();
  if (!text) return false;
  const lines = text.split('\n');
  const idx = lines.findIndex(l => /^-\s*\[\s*\]/.test(l) && l.includes(url));
  if (idx === -1) return false;
  const m = lines[idx].match(/^-\s*\[\s*\]\s*(\S+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|\s*([^|]+?)\s*)?$/);
  const company = m ? m[2].trim() : '?';
  const role = m ? m[3].trim() : '?';
  lines.splice(idx, 1);
  const entry = `- [x] ${url} | ${company} | ${role} | ${status} | - | ❌ | - | ${note}`;
  const procIdx = lines.findIndex(l => /^##\s+Procesadas/i.test(l));
  if (procIdx === -1) lines.push('', '## Procesadas', '', entry);
  else lines.splice(procIdx + 1, 0, entry);
  writeFileSync(PIPELINE_FILE, lines.join('\n'), 'utf8');
  return true;
}

function existingReportsSet() {
  if (!existsSync(REPORTS_DIR)) return new Set();
  return new Set(readdirSync(REPORTS_DIR).filter(f => /^\d{3}-.+\.md$/.test(f)));
}

// Job boards and ATS vendors. A posting hosted here tells us nothing about the
// employer's own domain, so it is useless as a scraping seed — worse than
// useless, in fact: findApplicationEmail() derives its fallback paths from the
// seed's host, so seeding it with a board sends it to arbeitnow.com/karriere and
// lets the BOARD's own recruiting inbox win as if it were the employer's.
// Every source scan-boards.mjs pulls from belongs in this list.
const ATS_HOSTS = /(greenhouse\.io|ashbyhq\.com|lever\.co|personio\.(de|com)|join\.com|workday|myworkdayjobs\.com|smartrecruiters\.com|recruitee\.com|softgarden\.\w+|jobvite\.com|bamboohr\.com|teamtailor\.com|breezy\.hr|workable\.com|linkedin\.com|indeed\.\w+|stepstone\.\w+|xing\.com|glassdoor\.\w+|welcometothejungle\.com|kununu\.com|arbeitsagentur\.de|arbeitnow\.com|germantechjobs\.de|englishjobsgermany\.com|berlinstartupjobs\.com|jobs\.ch|monster\.\w+)/i;

/** The posting URL, but only when it is on the employer's own site. */
function ownSiteUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    return ATS_HOSTS.test(new URL(url).hostname) ? null : url;
  } catch {
    return null;
  }
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

  // Look for an email address anywhere in the body (Block G usually surfaces it if
  // present). Anything in a report is fair game for this regex, including the
  // data-protection officer and press contacts, so it still has to look like an
  // inbox that accepts applications before we address a draft to it.
  const emailMatch = content.match(/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i);
  const recruiterEmail = emailMatch
    && !emailMatch[1].toLowerCase().includes('aym.djebaili')
    && isApplicationInbox(emailMatch[1])
      ? emailMatch[1] : null;

  // When the posting lives on the company's own site rather than an ATS, that page
  // is the single best place to look for "Bewerbung an ..." — hand it to the
  // scraper as a seed instead of making it guess /karriere and friends.
  const companyDomain = ownSiteUrl(url);

  return {
    num, company, role, url, score,
    language: language || 'EN',
    recruiterEmail,
    emailSource: recruiterEmail ? `printed in the posting (report ${num})` : null,
    companyDomain,
    fname,
  };
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
  // De-dup on the full cover-letter filename (number AND company slug), not the
  // number alone. Headless workers frequently reuse a report number — there are
  // 30+ distinct reports numbered 247 — so a number-only check silently dropped
  // every later company that happened to collide.
  const reportToken = `cover-letters/${basename(row.coverPath)}`;
  if (md.includes(reportToken)) {
    log(`     ↪ index already has row for ${basename(row.coverPath)}, skipping`);
    return;
  }
  const line = `| ${row.date} | ${row.company} | ${row.role} | ${row.score}/5 | [link](${row.url}) | [${basename(row.coverPath)}](cover-letters/${basename(row.coverPath)}) | ${row.applyVia} | ${row.status} |\n`;
  appendFileSync(INDEX_FILE, line, 'utf8');
}

async function writeEmailDraftFile(report, coverPath) {
  const file = join(OUTPUT_DIR, `email-${report.num}-${slugify(report.company)}.md`);
  if (existsSync(file)) { log(`     ↪ email draft file already exists: ${basename(file)}`); return file; }

  // The mail body is built from the tailored letter, not from a template — see
  // the header of email-body-core.mjs for why the old two-line stub was wrong.
  const letterMarkdown = existsSync(coverPath) ? readFileSync(coverPath, 'utf8') : null;

  // The letter has to exist as a PDF, not just as markdown. save-drafts.mjs can
  // only attach a PDF, so leaving the .md meant every draft went out carrying
  // the CV alone while its own text said "CV and cover letter attached" — the
  // precise mismatch the attachmentLine() comment warns about, shipped daily.
  let coverPdf = null;
  if (letterMarkdown) {
    try {
      coverPdf = await withBrowser(browser => renderLetterPdf(browser, coverPath));
    } catch (e) {
      warn(`     cover letter PDF failed (${e.message}) — mail will offer the CV only`);
    }
  }

  const { body: emailText, language } = buildEmailBody({
    letterMarkdown,
    role: report.role,
    company: report.company,
    language: report.language,
    candidate: loadCandidate(PROJECT_DIR),
    // Describe what will really be on the message, never what we hoped for.
    attachments: { cv: existsSync(join(OUTPUT_DIR, 'cv-updated.pdf')), letter: Boolean(coverPdf) },
  });
  if (!letterMarkdown) warn(`     no letter at ${coverPath} — email body falls back to a generic one`);

  // Per-application CV. Same facts, same dates, same words as cv.md — bullets are
  // only reordered so the evidence that matters to THIS employer is what gets
  // read first (see tailor-cv.mjs, which refuses to write if content changed).
  // Any failure falls back to the standard CV: an application carrying the
  // generic CV beats one carrying none.
  let cvRel = 'output/cv-updated.pdf';
  try {
    const { pdfPath, moves } = writeTailoredCv(reportContext(report.num), { pdf: true });
    if (pdfPath) {
      cvRel = toRelPath(pdfPath);
      log(`     📄 tailored CV: ${basename(pdfPath)} (${moves.length} block(s) reordered, 0 words changed)`);
    }
  } catch (e) {
    warn(`     CV tailoring failed (${e.message}) — attaching the standard CV`);
  }

  const langSubject = language === 'DE'
    ? `Bewerbung: ${report.role}`
    : language === 'FR'
      ? `Candidature : ${report.role}`
      : `Application: ${report.role}`;

  const body = `TO: ${report.recruiterEmail}
SUBJECT: ${langSubject}
COMPANY: ${report.company}
ROLE: ${report.role}
SCORE: ${report.score}
EMAIL_VERIFIED: ${report.emailSource || 'unverified'}
LANGUAGE: ${language}
COVER_LETTER_PATH: ${toRelPath(coverPath)}${coverPdf ? `\nCOVER_LETTER_PDF: ${toRelPath(coverPdf)}` : ''}
CV_PATH: ${cvRel}
JD_URL: ${report.url}
---
${emailText}`;
  writeFileSync(file, body, 'utf8');
  return file;
}

// basename() alone loses the folder when a path has an unexpected shape, which is
// how COVER_LETTER_PATH once ended up as `output/cover-letters/de.md`.
function toRelPath(p) {
  return p.replace(PROJECT_DIR, '').replace(/^[\\/]/, '').replace(/\\/g, '/');
}

// ─────────────────────────────────────────────
// Step runners
// ─────────────────────────────────────────────
function stepScan() {
  step(1, 'Scan portals for new junior+DE postings');
  if (SKIP_SCAN) { warn('skipped via --skip-scan'); return; }
  run('node', ['scan.mjs']);
  // Aggregator boards (germantechjobs, englishjobsgermany, berlinstartupjobs)
  run('node', ['scan-boards.mjs'], { allowFail: true });
  ok('scan complete');
}

const MAX_LIVENESS = 60; // ~17s per URL in Playwright; cap keeps the nightly run bounded

function stepLiveness() {
  step(2, 'Liveness check on pending URLs');
  if (SKIP_EVAL) { warn('skipped via --skip-eval'); return; }
  if (SKIP_LIVENESS) { warn('skipped via --skip-liveness'); return; }

  const pending = readPipelinePendientes();
  if (pending.length === 0) { log('  no pending URLs'); return; }

  const batch = pending.slice(0, MAX_LIVENESS);
  if (pending.length > batch.length) log(`  checking first ${batch.length} of ${pending.length} pending URLs`);

  // URLs go through a file — passing 100+ URLs as argv exceeds the Windows command-line limit
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const urlsFile = join(OUTPUT_DIR, '.pending-urls.txt');
  writeFileSync(urlsFile, batch.map(p => p.url).join('\n'), 'utf8');

  const res = run('node', ['check-liveness.mjs', '--file', urlsFile], { allowFail: true });

  // Prune expired postings from the pipeline so they stop eating the daily eval budget
  const expired = [];
  for (const ln of (res.stdout || '').split('\n')) {
    const m = ln.match(/\bexpired\s+(https?:\/\/\S+)/);
    if (m) expired.push(m[1]);
  }
  let pruned = 0;
  if (!IS_DRY_RUN) {
    const today = new Date().toISOString().slice(0, 10);
    for (const u of expired) {
      if (movePendingToProcesadas(u, 'Discarded', `expired (liveness ${today})`)) pruned++;
    }
  }
  ok(`liveness done — ${expired.length} expired, ${pruned} pruned from pipeline`);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const JD_CHAR_BUDGET = 6000;

function htmlToText(html) {
  return html
    // Drop non-content blocks FIRST. Without this, stripping tags leaves the raw
    // CSS and JS behind — on an Angular SPA like arbeitsagentur.de the first few
    // thousand characters are then stylesheet noise and the worker sees no JD.
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bundesagentur für Arbeit postings are an Angular SPA — the job description is
 * not in the served HTML at all. Their public detail API returns it as clean
 * text, plus the structured contract fields we actually filter on
 * (Vollzeit/Teilzeit, befristet/unbefristet). Same public key as the search API.
 */
async function fetchArbeitsagenturDetail(url) {
  const m = url.match(/jobsuche\/jobdetail\/([^/?#]+)/);
  if (!m) return null;
  const refnr = decodeURIComponent(m[1]);
  const id = Buffer.from(refnr).toString('base64');
  const api = `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/${id}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(api, {
      signal: controller.signal,
      headers: { 'X-API-Key': 'jobboerse-jobsuche', Accept: 'application/json', 'User-Agent': UA },
    });
    if (!res.ok) return null;
    const j = await res.json();

    const loc = (j.stellenlokationen || [])
      .map(l => [l.adresse?.ort, l.adresse?.region, l.adresse?.land].filter(Boolean).join(', '))
      .join(' | ');

    const workTime = [
      j.arbeitszeitVollzeit ? 'Vollzeit (full-time)' : null,
      (j.arbeitszeitTeilzeitFlexibel || j.arbeitszeitTeilzeitVormittag ||
       j.arbeitszeitTeilzeitNachmittag || j.arbeitszeitTeilzeitAbend) ? 'Teilzeit (part-time)' : null,
    ].filter(Boolean).join(' + ') || 'not stated';

    const body = htmlToText(j.stellenangebotsBeschreibung || '');
    if (!body) return null;

    return [
      `TITLE: ${j.stellenangebotsTitel || ''}`,
      `LOCATION: ${loc || 'not stated'}`,
      `WORKING TIME: ${workTime}`,
      `CONTRACT: ${j.vertragsdauer || 'not stated'}`,
      `PAY: ${j.verguetungsangabe || 'not stated'}`,
      `HOME OFFICE: ${j.homeofficemoeglich ? (j.homeofficetyp || 'yes') : 'no/not stated'}`,
      `TEMP AGENCY (Arbeitnehmerüberlassung): ${j.istArbeitnehmerUeberlassung ? 'YES' : 'no'}`,
      '',
      body.slice(0, JD_CHAR_BUDGET),
    ].join('\n');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJobContent(url) {
  if (/arbeitsagentur\.de\/jobsuche\/jobdetail\//.test(url)) {
    const detail = await fetchArbeitsagenturDetail(url);
    if (detail) return detail;
    // fall through to the generic path if the API is unavailable
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = htmlToText(await res.text());
    return text ? text.slice(0, JD_CHAR_BUDGET) : null;
  } catch (e) {
    return null;
  }
}

const ATTEMPTS_FILE = join(OUTPUT_DIR, '.eval-attempts.json');
function loadAttempts() { try { return JSON.parse(readFileSync(ATTEMPTS_FILE, 'utf8')); } catch { return {}; } }
function saveAttempts(a) {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(ATTEMPTS_FILE, JSON.stringify(a, null, 2));
}

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return 'other'; }
}

// German-language postings, detected from the title alone.
//
// "(m/w/d)" and friends are the German gender markers (männlich/weiblich/divers);
// the English postings use (m/f/d), (d/f/m) or (all genders). Umlauts and a few
// unmistakably German title words catch the rest.
const GERMAN_TITLE = new RegExp([
  '\\((?:m|w|d|x|i|g)\\s*[/|]\\s*(?:m|w|d|x|i|n)(?:\\s*[/|]\\s*(?:m|w|d|x|i|n))?\\)', // (m/w/d), (w/m/x), (gn)…
  '[äöüßÄÖÜ]',
  '\\b(mitarbeiter|sachbearbeit\\w*|kaufmann|kauffrau|kaufleute|fachkraft|fachwirt|' +
  'betreuer\\w*|berater\\w*|referent\\w*|assistenz|vertrieb\\w*|einkauf\\w*|' +
  'buchhalt\\w*|personal\\w*|verwaltung\\w*|innendienst|aussendienst|' +
  'geschäftsführ\\w*|abteilung\\w*|bereich\\w*|schwerpunkt|quereinsteiger)\\b',
].join('|'), 'i');

function looksGerman(item) {
  return GERMAN_TITLE.test(`${item.role || ''}`);
}

// Spreads a fixed evaluation budget over every source that has pending URLs,
// newest first within each source, so no single board can starve the rest.
//
// Within that, English-language postings go first. German-marked titles are not
// dropped — they are simply served last, because the evidence says they almost
// never clear the bar: of 31 evaluated, exactly one reached 3.5/5 (3%) against
// 11% for everything else, and the A2-German blocker is what sinks them. Spending
// the budget on them first meant a 60-eval run produced zero qualified roles.
// Home base is Mannheim (config/profile.yml → location.current_city). These
// mirror the Tier 1 / Tier 2 lists in modes/_profile.md — keep them in sync.
const TIER1_CITIES = /\b(Mannheim|Ludwigshafen|Heidelberg|Walldorf|Weinheim|Viernheim|Schwetzingen|Speyer|Worms|Hockenheim|Sinsheim|St\.? ?Leon-Rot|Bensheim|Heppenheim|Frankenthal|Ketsch|Lorsch|Heddesheim|Hirschberg)\b/i;
const TIER2_CITIES = /\b(Karlsruhe|Darmstadt|Bruchsal|Kaiserslautern|Mainz|Wiesbaden|Heilbronn|Germersheim|Zwingenberg|Griesheim|Stockstadt|Mühltal|Maikammer|Neustadt an der Weinstraße)\b/i;

// Entries scanned before the location column existed (the large majority of the
// backlog) carry no city at all, so tiering by location alone silently ignores
// them. The corridor's large employers are a small, stable set and their name IS
// the location — Roche Diagnostics is Mannheim, BASF is Ludwigshafen, SAP is
// Walldorf. Matching them recovers the legacy entries that matter most.
const TIER1_COMPANIES = /\b(Roche Diagnostics|BASF|John Deere|SAP SE|SAP Deutschland|Fuchs (Petrolub|Lubricants)|Pepperl\+?Fuchs|Bilfinger|Südzucker|MVV|Springer Nature|SNP (SE|Schneider)|HeidelbergCement|Heidelberger Druckmaschinen|Verifone|Caterpillar Energy|Daimler Truck Mannheim)\b/i;

function pickAcrossSources(pending, max) {
  const roundRobin = (items, budget) => {
    const buckets = new Map();
    for (const item of items) {
      const h = hostOf(item.url);
      if (!buckets.has(h)) buckets.set(h, []);
      buckets.get(h).push(item);
    }
    for (const list of buckets.values()) list.reverse(); // newest first

    const picked = [];
    const queues = [...buckets.values()];
    while (picked.length < budget && queues.some(q => q.length > 0)) {
      for (const q of queues) {
        if (picked.length >= budget) break;
        if (q.length > 0) picked.push(q.shift());
      }
    }
    return picked;
  };

  // Location tiers, mirroring modes/_profile.md. Scoring a Mannheim role higher
  // is useless if it never gets evaluated: the queue is >1200 deep and the daily
  // budget is 25, so what the picker chooses IS the search. Commutable roles go
  // first, then everything else.
  //
  // Matched against the whole entry, not just the location field, because
  // entries scanned before the location column existed have none — and German
  // staffing branches helpfully name the city in the company ("FERCHAU GmbH
  // Niederlassung Mannheim").
  const near = (i) => TIER1_CITIES.test(`${i.location} ${i.company} ${i.role}`)
    || TIER1_COMPANIES.test(i.company);
  const commutable = (i) => TIER2_CITIES.test(`${i.location} ${i.company} ${i.role}`);

  const byDistance = (items, budget) => {
    const picked = roundRobin(items.filter(near), budget);
    if (picked.length < budget) picked.push(...roundRobin(items.filter(commutable), budget - picked.length));
    if (picked.length < budget) {
      const rest = items.filter(i => !near(i) && !commutable(i));
      picked.push(...roundRobin(rest, budget - picked.length));
    }
    return picked;
  };

  if (NO_LANG_PRIORITY) return byDistance(pending, max);

  const preferred = pending.filter(i => !looksGerman(i));
  const deferred  = pending.filter(i => looksGerman(i));

  const picked = byDistance(preferred, max);
  if (picked.length < max) picked.push(...byDistance(deferred, max - picked.length));
  return picked;
}

async function stepEvaluate() {
  step(3, 'Evaluate pending URLs via headless worker');
  if (SKIP_EVAL) { warn('skipped via --skip-eval'); return []; }

  const pending = readPipelinePendientes();
  if (pending.length === 0) { log('  no pending URLs'); return []; }
  log(`  found ${pending.length} pending URLs (will evaluate up to ${MAX_EVAL})`);

  const before = existingReportsSet();
  // Newest first, but ROUND-ROBIN ACROSS SOURCES.
  //
  // Taking a flat slice off the tail meant whichever scanner appended last owned
  // the whole daily budget: arbeitnow was contributing 121 of 132 evaluations
  // while ~500 arbeitsagentur and ~130 greenhouse URLs sat in the backlog and
  // were never reached. Interleaving by host spends the same budget across every
  // source that has anything pending.
  const toEval = pickAcrossSources(pending, MAX_EVAL);
  const mix = {};
  for (const it of toEval) { const h = hostOf(it.url); mix[h] = (mix[h] || 0) + 1; }
  const deTaken = toEval.filter(looksGerman).length;
  const dePool = pending.filter(looksGerman).length;
  log(`  evaluating ${toEval.length}: ${Object.entries(mix).map(([h, c]) => `${h} ${c}`).join(', ')}`);
  log(`  language mix: ${toEval.length - deTaken} EN-style, ${deTaken} German-marked (${dePool} German-marked in backlog, served last)`);
  const contextFile = join(PROJECT_DIR, 'batch', '.job-context.md');
  const attempts = loadAttempts();

  for (const item of toEval) {
    log(`  → ${item.company} | ${item.role}`);

    if (IS_DRY_RUN) {
      log(`  [DRY] would evaluate ${item.url}`);
      continue;
    }

    // URLs that failed twice get parked as SKIP so they stop blocking the queue head
    const fails = attempts[item.url] || 0;
    if (fails >= 2) {
      if (movePendingToProcesadas(item.url, 'SKIP', 'headless eval failed twice')) {
        warn('     failed twice before — moved to Procesadas as SKIP');
      }
      delete attempts[item.url];
      saveAttempts(attempts);
      continue;
    }

    const jobContent = await fetchJobContent(item.url);
    writeFileSync(contextFile, [
      `URL: ${item.url}`,
      `COMPANY: ${item.company}`,
      `ROLE: ${item.role}`,
      '',
      '## JD content (pre-fetched, first 3000 chars)',
      '',
      jobContent || '(fetch failed — pre-screen on title/company only; when in doubt, SKIP)',
      '',
    ].join('\n'), 'utf8');

    // Headless pattern that survives Windows: the long instructions live in the
    // system prompt file, the JD travels via batch/.job-context.md, and the user
    // message stays short. A long inline prompt exceeds the command-line limit
    // and lets CLAUDE.md onboarding hijack the response.
    const res = spawnSync(CLI, [
      '-p',
      '--dangerously-skip-permissions',
      '--append-system-prompt-file', 'batch/daily-worker-prompt.md',
      '--model', MODEL,
      '"Evaluate the job described in batch/.job-context.md. Follow your system instructions exactly. Output only the REPORT_PATH line."',
    ], { cwd: PROJECT_DIR, encoding: 'utf8', shell: true, timeout: 420_000 });

    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    // Workers sometimes wrap the value in backticks/quotes — strip them
    const rp = out.match(/REPORT_PATH=[`'"]?([^\s`'"]+)/);
    if (res.status === 0 && rp) {
      log(rp[1] === 'none' ? '     ⏭️  worker SKIPped (below bar — no report)' : `     ✅ report: ${rp[1]}`);
      delete attempts[item.url];
      // The worker is supposed to move the URL to Procesadas itself (prompt Step 6).
      // If it didn't, park it here so it doesn't get re-evaluated tomorrow.
      if (readPipelinePendientes().some(p => p.url === item.url)) {
        const status = rp[1] === 'none' ? 'SKIP' : 'Evaluated';
        movePendingToProcesadas(item.url, status, 'moved by daily-run (worker did not update pipeline)');
      }
    } else {
      warn(`     worker failed (exit ${res.status ?? 'timeout'}) — will retry next run`);
      attempts[item.url] = fails + 1;
    }
    saveAttempts(attempts);
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

async function stepCoverLettersAndDrafts(freshReports) {
  step(5, `Generate cover letters + email drafts (threshold ≥ ${THRESHOLD}/5)`);

  // With --skip-eval there are no fresh reports, so fall back to recent ones.
  //
  // This used to match on the date IN THE FILENAME being exactly today, which
  // quietly did nothing in the two cases you most need it: a run that crosses
  // midnight, and a re-run the next morning to repair a draft. Both left
  // "cover letters: 0" as if there were no work. Modification time over a
  // window is what "recent" actually means, and re-processing is safe — letters
  // and email files that already exist are skipped individually.
  let candidates = freshReports;
  if (candidates.length === 0) {
    const allReports = existsSync(REPORTS_DIR) ? readdirSync(REPORTS_DIR).filter(f => /^\d{3}-.+\.md$/.test(f)) : [];
    const cutoff = Date.now() - 48 * 3600_000;
    candidates = allReports.filter(f => {
      try { return statSync(join(REPORTS_DIR, f)).mtimeMs >= cutoff; } catch { return false; }
    });
    if (candidates.length) log(`  no fresh-this-step reports — falling back to ${candidates.length} report(s) from the last 48h`);
  }

  if (!existsSync(COVER_DIR)) mkdirSync(COVER_DIR, { recursive: true });
  ensureIndexHeader();

  const results = { qualified: 0, coverLetters: 0, emailDrafts: 0, portalOnly: 0, indexed: 0, skippedLowScore: 0 };

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
    // languageSlug, not raw language: a report reading `EN/DE` turns the slash
    // into a directory and the letter goes missing from the draft.
    const coverPath = join(COVER_DIR, `${meta.num}-${slugify(meta.company)}-${languageSlug(meta.language)}.md`);
    if (!existsSync(coverPath) && !IS_DRY_RUN) {
      warn(`     cover letter not found at ${coverPath} — skipping draft + index`);
      continue;
    }
    results.coverLetters++;

    // Email draft file — only ever addressed to an email we can point at a source.
    // Order: the address printed in the posting itself → Hunter.io (a real mailbox
    // lookup, silent no-op until config/hunter-api-key.json exists) → the company's
    // own careers/Impressum pages. Guessing `careers@{domain}` was removed on
    // purpose: an address nobody published is a bounce, not a long shot, and it
    // used to reach Gmail looking exactly as trustworthy as a real one.
    if (!meta.recruiterEmail && !IS_DRY_RUN) {
      const found = await findRecruiterEmail(meta.company);
      if (found) {
        meta.recruiterEmail = found.email;
        meta.emailSource = `hunter.io, confidence ${found.confidence}%${found.position ? ` (${found.name || 'contact'}, ${found.position})` : ''}`;
        log(`     🔎 recruiter email found via Hunter.io: ${found.email} (confidence ${found.confidence}%)`);
      } else {
        // companyDomain is the employer's own site (null when the posting lives
        // on a board); meta.url is the posting itself, read for an address the
        // employer printed in the ad but nowhere else.
        const published = await findApplicationEmail(meta.company, meta.companyDomain, meta.url);
        if (published) {
          meta.recruiterEmail = published.email;
          meta.emailSource = `published by the company at ${published.source}`;
          log(`     🔎 published application address: ${published.email} (${published.source})`);
        } else {
          log(`     🔎 no published application address — routing to the portal instead of guessing one`);
        }
      }
    }

    let applyVia;
    if (meta.recruiterEmail) {
      const emailFile = await writeEmailDraftFile(meta, coverPath);
      log(`     📧 email-draft file: ${basename(emailFile)} (to ${meta.recruiterEmail})`);
      applyVia = 'Email draft (review in Gmail)';
      results.emailDrafts++;
    } else {
      // No draft on purpose. The letter is still written and indexed, so applying
      // through the portal is a copy-paste away.
      applyVia = meta.url
        ? `Portal (no published email — apply at ${meta.url})`
        : 'Portal (no published email — paste cover letter manually)';
      results.portalOnly++;
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

  ok(`qualified: ${results.qualified}, cover letters: ${results.coverLetters}, email drafts: ${results.emailDrafts}, portal-only (no published email): ${results.portalOnly}, indexed: ${results.indexed}, skipped (low score): ${results.skippedLowScore}`);
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

function stepDigest() {
  step(7, 'Daily digest (file + self-email)');
  const res = run('node', ['send-digest.mjs', ...(IS_DRY_RUN ? ['--no-email'] : [])], { allowFail: true });
  if (res.status === 0) ok('digest done');
  else warn(`send-digest.mjs exit ${res.status} (continuing)`);
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

  // MUST be awaited: without it postResults is a pending Promise, so every count in
  // the summary reads undefined→0, and step 6 pushes Gmail drafts before the
  // email-*.md files this step writes actually exist.
  let postResults = {};
  try { postResults = await stepCoverLettersAndDrafts(freshReports); }
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

  try { stepDigest(); }
  catch (e) { err(`digest failed: ${e.message}`); summary.errors.push(`digest: ${e.message}`); }

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

// Exported for test-queue-order.mjs; the CLI still runs only as entrypoint.
export { looksGerman, pickAcrossSources, hostOf };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('\n❌ fatal:', e.message); process.exit(1); });
}
