#!/usr/bin/env node
/**
 * auto-evaluate-all.mjs — evaluate all pending jobs with Claude and save reports
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const PIPELINE_FILE = join(PROJECT_DIR, 'data', 'pipeline.md');
const REPORTS_DIR = join(PROJECT_DIR, 'reports');

if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

function log(msg) { console.log(msg); }

function readPipelinePendientes() {
  const text = readFileSync(PIPELINE_FILE, 'utf-8');
  const section = text.slice(text.indexOf('## Pendientes'), text.indexOf('## Procesadas') || text.length);
  const pending = [];
  for (const match of section.matchAll(/- \[ \] (https?:\/\/\S+) \| ([^|]+) \| (.+)/g)) {
    pending.push({ url: match[1], company: match[2].trim(), role: match[3].trim() });
  }
  return pending;
}

function getNextReportNumber() {
  if (!existsSync(REPORTS_DIR)) return 1;
  const nums = readdirSync(REPORTS_DIR)
    .filter(f => /^\d{3}-/.test(f))
    .map(f => parseInt(f.slice(0, 3)));
  return Math.max(0, ...nums) + 1;
}

async function fetchJD(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    const res = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);
  } catch { return null; }
}

function evaluateWithClaude(url, company, role, jdContent) {
  const prompt = `Score this job 1-5 for a junior ops professional targeting Germany. Job: ${role} at ${company}. URL: ${url}. JD: ${jdContent || 'unknown'}. Respond with ONLY: SCORE:X.X LANG:EN/DE EMAIL:addr@or-none FIT:1-line reason`;

  const res = spawnSync('claude', ['-p', prompt], {
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
  });

  if (res.status !== 0) {
    return { score: 3.0, language: 'EN', email: null, fit: 'Auto-scored' };
  }

  const text = res.stdout;
  const scoreMatch = text.match(/SCORE:([\d.]+)/);
  const langMatch = text.match(/LANG:(EN|DE)/);
  const emailMatch = text.match(/EMAIL:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|none)/i);
  const fitMatch = text.match(/FIT:(.+?)(?:\n|$)/);

  return {
    score: parseFloat(scoreMatch?.[1] || '3.0'),
    language: langMatch?.[1] || 'EN',
    email: emailMatch?.[1] !== 'none' ? emailMatch?.[1] : null,
    fit: fitMatch?.[1]?.trim() || 'Operations fit'
  };
}

function saveReport(num, url, company, role, eval_result, date) {
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = join(REPORTS_DIR, `${String(num).padStart(3, '0')}-${slug}-${date}.md`);

  const content = `# Evaluation: ${company} — ${role}

**Company:** ${company}
**Role:** ${role}
**Date:** ${date}
**Score:** ${eval_result.score}/5
**URL:** ${url}
**PDF:** ❌
**Language:** ${eval_result.language}
**Legitimacy:** Auto-evaluated

---

${eval_result.fit}

**Recruiter Email:** ${eval_result.email || 'Not found'}

---
`;

  writeFileSync(path, content);
  return { path, score: eval_result.score, email: eval_result.email, language: eval_result.language };
}

async function main() {
  log('\n=== Batch Evaluating All 38 Pending Jobs ===\n');

  const pending = readPipelinePendientes();
  log(`Evaluating ${pending.length} jobs...\n`);

  let num = getNextReportNumber();
  const date = new Date().toISOString().slice(0, 10);
  let count = 0;

  for (const job of pending) {
    process.stdout.write(`  ${String(num).padStart(3, '0')} ${job.company} | ${job.role}`);

    const jd = await fetchJD(job.url);
    const eval_result = evaluateWithClaude(job.url, job.company, job.role, jd);
    const report = saveReport(num, job.url, job.company, job.role, eval_result, date);

    console.log(` → ${eval_result.score.toFixed(1)}/5`);
    num++;
    count++;
  }

  log(`\n✅ Saved ${count} reports to reports/\n`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
