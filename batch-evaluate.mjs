#!/usr/bin/env node
/**
 * batch-evaluate.mjs — fully automated batch job evaluation
 *
 * Reads all pending URLs from pipeline.md, evaluates each one,
 * generates reports, and creates email drafts ready for Gmail.
 *
 * Usage:
 *   node batch-evaluate.mjs                # evaluate all pending
 *   node batch-evaluate.mjs --max=5        # evaluate first 5
 *   node batch-evaluate.mjs --dry-run      # preview only
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const PIPELINE_FILE = join(PROJECT_DIR, 'data', 'pipeline.md');
const REPORTS_DIR = join(PROJECT_DIR, 'reports');
const OUTPUT_DIR = join(PROJECT_DIR, 'output');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MAX_JOBS = parseInt(args.find(a => a.startsWith('--max='))?.split('=')[1] || '999', 10);
const THRESHOLD = 2.5;

function log(msg) { console.log(msg); }
function ok(msg) { console.log(`  ✅ ${msg}`); }
function err(msg) { console.log(`  ❌ ${msg}`); }

function readPipelinePendientes() {
  if (!existsSync(PIPELINE_FILE)) return [];
  const text = readFileSync(PIPELINE_FILE, 'utf-8');
  const pendientesIdx = text.indexOf('## Pendientes');
  if (pendientesIdx === -1) return [];
  const afterPendientes = text.slice(pendientesIdx);
  const procesadasIdx = afterPendientes.indexOf('## Procesadas');
  const section = procesadasIdx === -1 ? afterPendientes : afterPendientes.slice(0, procesadasIdx);

  const pending = [];
  for (const match of section.matchAll(/- \[ \] (https?:\/\/\S+) \| ([^|]+) \| (.+)/g)) {
    pending.push({
      url: match[1],
      company: match[2].trim(),
      role: match[3].trim(),
    });
  }
  return pending;
}

function getNextReportNumber() {
  if (!existsSync(REPORTS_DIR)) return 1;
  const existing = readdirSync(REPORTS_DIR)
    .filter(f => /^\d{3}-/.test(f))
    .map(f => parseInt(f.slice(0, 3), 10));
  return existing.length > 0 ? Math.max(...existing) + 1 : 1;
}

async function fetchAndEvaluate(url, company, role) {
  try {
    // Fetch the JD
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const jdContent = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000);

    // Evaluate using Claude
    const evaluationPrompt = `You are a career evaluation expert. Evaluate this job posting for a junior operations professional targeting Germany, scoring 1-5.

JD Content:
${jdContent}

Respond with ONLY a JSON object (no markdown, no extra text):
{
  "score": <1-5 decimal>,
  "location": "<extracted location or 'unknown'>",
  "language": "<DE or EN>",
  "recruiter_email": "<email if found or null>",
  "summary": "<1 sentence: why this score>",
  "good_fit": <true/false>
}`;

    const res2 = spawnSync('node', ['-e', `
      (async () => {
        const result = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-opus-4-7',
            max_tokens: 500,
            messages: [{
              role: 'user',
              content: \`${evaluationPrompt.replace(/`/g, '\\`')}\`
            }]
          })
        });
        const data = await result.json();
        const text = data.content[0].text;
        console.log(text);
      })();
    `], {
      env: { ...process.env },
      encoding: 'utf-8',
      timeout: 30000,
    });

    if (res2.status !== 0) throw new Error('Claude eval failed');

    const evalJson = JSON.parse(res2.stdout.trim());
    return {
      success: true,
      ...evalJson,
    };
  } catch (e) {
    return {
      success: false,
      error: e.message,
      score: 1.0,
    };
  }
}

function generateReportMarkdown(num, url, company, role, eval_result, date) {
  const lang = eval_result.language || 'EN';
  const score = eval_result.score || 1.0;

  return `# Evaluation: ${company} — ${role}

**Company:** ${company}
**Role:** ${role}
**Date:** ${date}
**Score:** ${score}/5
**URL:** ${url}
**PDF:** ❌
**Language:** ${lang}
**Legitimacy:** Auto-evaluated

---

## Summary

${eval_result.summary || 'Evaluation could not be completed.'}

**Location:** ${eval_result.location || 'Unknown'}
**Good Fit:** ${eval_result.good_fit ? '✅ Yes' : '❌ No'}

---
`;
}

async function main() {
  log('\n=== Batch Job Evaluator ===\n');

  const pending = readPipelinePendientes();
  const toEval = pending.slice(0, MAX_JOBS);

  log(`Found ${pending.length} pending jobs; evaluating ${toEval.length}`);
  if (DRY_RUN) log('(dry-run mode)\n');

  let reportCount = 0;
  let draftCount = 0;
  let errors = 0;
  const date = new Date().toISOString().slice(0, 10);
  let num = getNextReportNumber();

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const job of toEval) {
    log(`\n→ ${job.company} | ${job.role}`);

    if (DRY_RUN) {
      log('  [DRY] would evaluate');
      continue;
    }

    const evalResult = await fetchAndEvaluate(job.url, job.company, job.role);

    if (!evalResult.success) {
      err(`  eval failed: ${evalResult.error}`);
      errors++;
      continue;
    }

    log(`  score: ${evalResult.score}/5`);

    // Create report
    const reportPath = join(REPORTS_DIR, `${String(num).padStart(3, '0')}-${job.company.toLowerCase().replace(/[^a-z0-9]/g, '')}-${date}.md`);
    const reportContent = generateReportMarkdown(num, job.url, job.company, job.role, evalResult, date);

    if (!DRY_RUN) {
      writeFileSync(reportPath, reportContent, 'utf-8');
      reportCount++;
    }

    // Create email draft if score >= threshold
    if (evalResult.score >= THRESHOLD && evalResult.recruiter_email) {
      const draftPath = join(OUTPUT_DIR, `email-${String(num).padStart(3, '0')}-${job.company.toLowerCase().replace(/[^a-z0-9]/g, '')}.md`);
      const draftContent = `TO: ${evalResult.recruiter_email}
SUBJECT: Application: ${job.role}
COMPANY: ${job.company}
ROLE: ${job.role}
SCORE: ${evalResult.score}
EMAIL_VERIFIED: unverified
LANGUAGE: ${evalResult.language}
---

Dear Hiring Team,

I am writing to express my interest in the ${job.role} position at ${job.company}.

[Cover letter will be generated]

Best regards,
AIMENE DJEBAILI
Aym.djebaili@gmail.com
`;

      if (!DRY_RUN) {
        writeFileSync(draftPath, draftContent, 'utf-8');
        draftCount++;
        log(`  📧 draft queued`);
      }
    }

    num++;
  }

  log(`\n=== Summary ===`);
  log(`Reports created: ${reportCount}`);
  log(`Email drafts: ${draftCount}`);
  log(`Errors: ${errors}`);
  log(`\nNext: node daily-run.mjs --skip-scan --skip-eval\n`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
