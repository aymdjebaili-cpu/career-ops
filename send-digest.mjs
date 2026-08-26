#!/usr/bin/env node
/**
 * send-digest.mjs — daily pipeline digest: file + Gmail self-notification
 *
 * Summarizes what the daily run produced (new reports, cover letters, Gmail
 * drafts awaiting review, queue depth) into output/daily-digest.md and emails
 * it to the candidate's own address so the daily routine is: read one email,
 * review the drafts it points to, click send.
 *
 * Uses the existing gmail.compose OAuth token (config/gmail-token.json) via
 * drafts.create + drafts.send — same auth as save-drafts.mjs. Sends ONLY to
 * the candidate's own email from config/profile.yml; application drafts are
 * never sent by this script.
 *
 * Usage:
 *   node send-digest.mjs             # write digest + email it to yourself
 *   node send-digest.mjs --no-email  # write output/daily-digest.md only
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const OUTPUT_DIR = join(PROJECT_DIR, 'output');
const REPORTS_DIR = join(PROJECT_DIR, 'reports');
const DIGEST_FILE = join(OUTPUT_DIR, 'daily-digest.md');
const LAST_RUN_FILE = join(OUTPUT_DIR, '.last-run.json');
const PIPELINE_FILE = join(PROJECT_DIR, 'data', 'pipeline.md');
const PROFILE_FILE = join(PROJECT_DIR, 'config', 'profile.yml');
const CREDENTIALS_FILE = join(PROJECT_DIR, 'config', 'gmail-credentials.json');
const TOKEN_FILE = join(PROJECT_DIR, 'config', 'gmail-token.json');

const NO_EMAIL = process.argv.includes('--no-email');
const today = new Date().toISOString().slice(0, 10);

function pendingCount() {
  if (!existsSync(PIPELINE_FILE)) return 0;
  let raw = readFileSync(PIPELINE_FILE);
  if (raw[0] === 0xFF && raw[1] === 0xFE) raw = Buffer.from(raw.toString('utf16le'));
  const text = raw.toString('utf8');
  const section = text.split(/^##\s+Pendientes/im)[1] || '';
  return (section.split(/^##\s+/m)[0].match(/^-\s*\[\s*\]/gm) || []).length;
}

function todaysReports() {
  if (!existsSync(REPORTS_DIR)) return [];
  return readdirSync(REPORTS_DIR)
    .filter(f => /^\d{3}-.+\.md$/.test(f) && f.endsWith(`${today}.md`))
    .map(f => {
      const head = readFileSync(join(REPORTS_DIR, f), 'utf8').split('\n').slice(0, 40).join('\n');
      const grab = (label) => (head.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i')) || [])[1]?.trim() || '';
      return {
        file: f,
        company: grab('Company') || '?',
        role: grab('Role') || '?',
        score: parseFloat((grab('Score').match(/([\d.]+)/) || [])[1] || '0'),
        url: grab('URL'),
      };
    })
    .sort((a, b) => b.score - a.score);
}

function buildDigest() {
  let lastRun = {};
  try { lastRun = JSON.parse(readFileSync(LAST_RUN_FILE, 'utf8')); } catch { /* first run */ }
  const reports = todaysReports();
  const threshold = lastRun.threshold ?? 3.5;
  const ready = reports.filter(r => r.score >= threshold);
  const queue = pendingCount();

  const lines = [];
  lines.push(`# career-ops daily digest — ${today}`);
  lines.push('');
  if (reports.length === 0) {
    lines.push('No new evaluations today.');
  } else {
    lines.push(`Evaluated today: ${reports.length} | ready to apply (score ≥ ${threshold}): ${ready.length}`);
    lines.push('');
    for (const r of reports) {
      const flag = r.score >= threshold ? '🟢' : '⚪';
      lines.push(`- ${flag} **${r.score}/5** ${r.company} — ${r.role}${r.url ? ` ([posting](${r.url}))` : ''}`);
    }
  }
  lines.push('');
  lines.push(`Pipeline queue: ${queue} pending URL(s)`);
  if (lastRun.emailDrafts > 0 || (lastRun.gmailPushed && ready.length > 0)) {
    lines.push('');
    lines.push('## Your 5 minutes today');
    lines.push('1. Open Gmail → **Drafts** — review the application email(s), then click Send.');
    lines.push('2. For form-based applications: run `npm run apply` — forms get pre-filled, you review and click Submit.');
  } else if (ready.length > 0) {
    lines.push('');
    lines.push('## Your 5 minutes today');
    lines.push('1. Run `npm run apply` — forms get pre-filled, you review and click Submit.');
  }
  lines.push('');
  lines.push('_Sent by career-ops daily-run. Cover letters live in output/cover-letters/, full index in output/applications-index.md._');
  return lines.join('\n');
}

async function sendToSelf(digest) {
  if (!existsSync(CREDENTIALS_FILE) || !existsSync(TOKEN_FILE)) {
    console.log('⚠️  Gmail OAuth not set up — digest written to file only.');
    return false;
  }
  const profile = yaml.load(readFileSync(PROFILE_FILE, 'utf8'));
  const selfEmail = profile?.candidate?.email;
  if (!selfEmail) {
    console.log('⚠️  candidate.email missing in config/profile.yml — skipping email.');
    return false;
  }

  const { google } = await import('googleapis');
  const credentials = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
  const { client_secret, client_id } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:53682/callback');
  oAuth2Client.setCredentials(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')));
  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  const mime = [
    `To: ${selfEmail}`,
    `Subject: career-ops digest ${today}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    digest,
  ].join('\r\n');
  const raw = Buffer.from(mime, 'utf8').toString('base64url');

  // gmail.compose scope: create the draft, then send that draft (self-notification only)
  const draft = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draft.data.id } });
  return true;
}

async function main() {
  const digest = buildDigest();
  writeFileSync(DIGEST_FILE, digest, 'utf8');
  console.log(`📄 digest written: output/daily-digest.md`);
  if (NO_EMAIL) return;
  try {
    if (await sendToSelf(digest)) console.log('📬 digest emailed to you');
  } catch (e) {
    console.log(`⚠️  digest email failed (${e.message}) — file is still there`);
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
