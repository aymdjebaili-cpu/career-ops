#!/usr/bin/env node
/**
 * generate-cover-letter.mjs — produces a tailored cover letter for one evaluated job.
 *
 * Usage:
 *   node generate-cover-letter.mjs <report-path>
 *   node generate-cover-letter.mjs reports/011-getyourguide-2026-05-15.md
 *
 * Or by report number (resolves to reports/{NNN}-*.md):
 *   node generate-cover-letter.mjs --num=11
 *
 * Behavior:
 *   1. Reads the report → extracts company, role, JD URL, score, language
 *   2. Invokes Claude Code in headless mode with modes/cover-letter.md as the system prompt
 *   3. Claude reads cv.md + profile.yml + report + writes output/cover-letters/{num}-{slug}-{lang}.md
 *   4. Returns the cover-letter file path on stdout (one line, for the orchestrator to capture)
 *
 * Options:
 *   --dry-run    Skip the claude invocation; only resolve the report and print what would happen
 *   --force      Regenerate even if output file already exists
 *   --cli=NAME   Override CLI (default: claude). Supports: claude, codex, gemini, opencode, qwen, copilot
 */

import { readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const REPORTS_DIR = join(PROJECT_DIR, 'reports');
const OUTPUT_DIR = join(PROJECT_DIR, 'output', 'cover-letters');

const args = process.argv.slice(2);
const IS_DRY_RUN = args.includes('--dry-run');
const IS_FORCE = args.includes('--force');
const CLI = (args.find(a => a.startsWith('--cli='))?.split('=')[1]) || 'claude';
const NUM_FLAG = args.find(a => a.startsWith('--num='))?.split('=')[1];
const MODEL = (args.find(a => a.startsWith('--model='))?.split('=')[1]) || 'claude-haiku-4-5-20251001';
const POSITIONAL = args.find(a => !a.startsWith('--') && !a.startsWith('--model'));

// ─────────────────────────────────────────────
// Resolve the report path
// ─────────────────────────────────────────────
function resolveReportPath() {
  if (NUM_FLAG) {
    const padded = String(NUM_FLAG).padStart(3, '0');
    const match = readdirSync(REPORTS_DIR).find(f => f.startsWith(padded + '-') && f.endsWith('.md'));
    if (!match) throw new Error(`No report found with number ${padded} in reports/`);
    return join(REPORTS_DIR, match);
  }
  if (!POSITIONAL) {
    throw new Error('Pass a report path or --num=N. Example: node generate-cover-letter.mjs reports/011-foo.md');
  }
  const p = POSITIONAL.startsWith('/') || /^[A-Z]:\\/.test(POSITIONAL)
    ? POSITIONAL
    : join(PROJECT_DIR, POSITIONAL);
  if (!existsSync(p)) throw new Error(`Report not found: ${p}`);
  return p;
}

// ─────────────────────────────────────────────
// Parse report header (front matter style: "**Field:** value")
// ─────────────────────────────────────────────
function parseReportHeader(reportPath) {
  const content = readFileSync(reportPath, 'utf8');
  const head = content.split('\n').slice(0, 40).join('\n');

  const grab = (label) => {
    const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i');
    const m = head.match(re);
    return m ? m[1].trim() : '';
  };

  const fileName = basename(reportPath, '.md');
  const numMatch = fileName.match(/^(\d{3})-/);
  const num = numMatch ? numMatch[1] : '000';

  // Title line fallback: "# Evaluation: COMPANY — ROLE" (the system's actual format)
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

  if (!language) {
    const body = content.toLowerCase();
    const deTokens = ['über', 'unsere', 'stelle', 'bewerbung', 'praktikum', 'werkstudent', 'anschreiben', 'mitarbeiter', 'erfahrung'];
    const frTokens = ['nous', 'postuler', 'candidature', 'alternance', 'entreprise', 'stage', 'expérience'];
    const deHits = deTokens.filter(t => body.includes(t)).length;
    const frHits = frTokens.filter(t => body.includes(t)).length;
    if (deHits >= 3 && deHits > frHits) language = 'DE';
    else if (frHits >= 3 && frHits > deHits) language = 'FR';
    else language = 'EN';
  }

  return { num, company, role, url, score, language };
}

function slugify(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
function main() {
  const reportPath = resolveReportPath();
  const meta = parseReportHeader(reportPath);
  const slug = slugify(meta.company);
  const outFile = join(OUTPUT_DIR, `${meta.num}-${slug}-${meta.language.toLowerCase()}.md`);

  console.log(`📝 Cover letter target: ${meta.num} | ${meta.company} | ${meta.role} | score ${meta.score}/5 | lang ${meta.language}`);
  console.log(`   Report:  ${reportPath}`);
  console.log(`   Output:  ${outFile}`);

  if (existsSync(outFile) && !IS_FORCE) {
    console.log(`   ⏭️  Exists — skip (use --force to overwrite).`);
    process.stdout.write(outFile + '\n');
    return;
  }

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  if (IS_DRY_RUN) {
    console.log(`   [DRY RUN] Would invoke ${CLI} with modes/cover-letter.md against ${reportPath}`);
    process.stdout.write(outFile + '\n');
    return;
  }

  // Build prompt for the headless CLI
  const prompt = [
    `You are running in headless mode. Load and follow modes/cover-letter.md strictly.`,
    ``,
    `Generate a tailored cover letter for this evaluated job:`,
    `  Report:   ${reportPath}`,
    `  Company:  ${meta.company}`,
    `  Role:     ${meta.role}`,
    `  Language: ${meta.language}`,
    `  Score:    ${meta.score}/5`,
    ``,
    `Write the cover letter EXACTLY to this path:`,
    `  ${outFile}`,
    ``,
    `Use cv.md, config/profile.yml, modes/_profile.md, and the report above.`,
    `Enforce all quality gates from modes/cover-letter.md (word count 350-450, 2+ quantified proof points, company named ≥2 times, Blue Card + 2026 relocation in §4).`,
    `When done, print exactly: COVER_LETTER_PATH=${outFile}`,
  ].join('\n');

  const cliFlag = CLI === 'codex' ? 'exec' : (CLI === 'opencode' ? 'run' : '-p');

  console.log(`   → invoking: ${CLI} ${cliFlag} --model ${MODEL} "<prompt>"  (cwd=${PROJECT_DIR})`);

  const res = spawnSync(CLI, [cliFlag, '--model', MODEL, prompt], {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
    shell: true,
  });

  if (res.status !== 0) {
    console.error(`   ❌  ${CLI} exited with status ${res.status}`);
    process.exit(res.status || 1);
  }

  if (!existsSync(outFile)) {
    console.error(`   ⚠️  Expected cover letter at ${outFile} but it was not created. Check the model's output.`);
    process.exit(2);
  }

  console.log(`   ✅  Cover letter written.`);
  process.stdout.write(outFile + '\n');
}

try { main(); }
catch (err) { console.error(`❌  ${err.message}`); process.exit(1); }
