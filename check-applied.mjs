#!/usr/bin/env node
/**
 * check-applied.mjs — work out which paused applications were actually sent.
 *
 * auto-apply.mjs never submits: it fills the form and stops, writing
 * `paused-for-review` to output/.apply-log.json. Whether the human then pressed
 * Submit is invisible to the pipeline — which means the next `npm run apply`
 * re-opens jobs that may already have been applied to.
 *
 * The ATS tells us, though. Ashby, Greenhouse, Lever and most in-house systems
 * send a confirmation the moment an application lands. This reads the inbox,
 * matches those confirmations against the paused entries, and (with --mark)
 * promotes the matches to `submitted` so auto-apply skips them for good.
 *
 * Usage:
 *   node check-applied.mjs --setup     one-time OAuth (adds gmail.readonly)
 *   node check-applied.mjs             report only, changes nothing
 *   node check-applied.mjs --mark      also write `submitted` to the apply log
 *   node check-applied.mjs --days=30   how far back to search (default 14)
 *
 * The token this writes keeps gmail.compose as well, so save-drafts.mjs
 * continues to work against the same file.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createServer } from 'http';
import { exec } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const CREDENTIALS_FILE = join(PROJECT_DIR, 'config', 'gmail-credentials.json');
const TOKEN_FILE = join(PROJECT_DIR, 'config', 'gmail-token.json');
const APPLY_LOG_FILE = join(PROJECT_DIR, 'output', '.apply-log.json');
const REPORTS_DIR = join(PROJECT_DIR, 'reports');

const args = process.argv.slice(2);
const IS_SETUP = args.includes('--setup');
const IS_MARK = args.includes('--mark');
const DAYS = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1] ?? '14', 10);

// gmail.compose is kept so the existing draft flow keeps working off this token.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.readonly',
];

async function loadGoogleApis() {
  try {
    const { google } = await import('googleapis');
    return google;
  } catch {
    console.error('❌  googleapis not installed. Run: npm install googleapis');
    process.exit(1);
  }
}

// ─────────────────────────────────────────────
// OAuth
// ─────────────────────────────────────────────
async function runSetup() {
  console.log('\n=== Gmail read access ===\n');
  if (!existsSync(CREDENTIALS_FILE)) {
    console.error('❌  config/gmail-credentials.json missing. See: node save-drafts.mjs --setup');
    process.exit(1);
  }

  const google = await loadGoogleApis();
  const credentials = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
  const { client_secret, client_id } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:53682/callback');

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('This asks for read access so the pipeline can see application');
  console.log('confirmations. It reads only — nothing is sent or deleted.\n');
  console.log('Opening browser. If it does not open, visit:\n');
  console.log(authUrl + '\n');

  const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${opener} "${authUrl}"`);

  await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost:53682');
      const code = url.searchParams.get('code');
      if (!code) {
        res.end('No authorization code received.');
        server.close();
        reject(new Error('No authorization code'));
        return;
      }
      try {
        const { tokens } = await oAuth2Client.getToken(code);
        // Keep the old refresh_token if Google omits it on re-consent.
        const prev = existsSync(TOKEN_FILE) ? JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) : {};
        writeFileSync(TOKEN_FILE, JSON.stringify({ ...prev, ...tokens }, null, 2));
        console.log('✅  Token updated: config/gmail-token.json');
        res.end('<h2>Done. You can close this tab.</h2><script>window.close()</script>');
        server.close();
        resolve();
      } catch (err) {
        res.end('Authorization failed: ' + err.message);
        server.close();
        reject(err);
      }
    });
    server.listen(53682, () => console.log('Waiting for callback on http://localhost:53682 ...\n'));
    server.on('error', reject);
  });

  console.log('\n✅  Now run: node check-applied.mjs\n');
}

async function getGmailClient() {
  const google = await loadGoogleApis();
  if (!existsSync(CREDENTIALS_FILE) || !existsSync(TOKEN_FILE)) {
    console.error('❌  Gmail not set up. Run: node check-applied.mjs --setup');
    process.exit(1);
  }
  const credentials = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
  const { client_secret, client_id } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:53682/callback');
  oAuth2Client.setCredentials(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')));
  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

// ─────────────────────────────────────────────
// Which jobs are we asking about
// ─────────────────────────────────────────────
function reportHeader(num) {
  const file = readdirSync(REPORTS_DIR).find(f => f.startsWith(`${num}-`) && f.endsWith('.md'));
  if (!file) return null;
  const text = readFileSync(join(REPORTS_DIR, file), 'utf8').slice(0, 1200);
  const grab = (k) => (text.match(new RegExp(`\\*\\*${k}:\\*\\*\\s*(.+)`)) || [])[1]?.trim() || '';
  return { company: grab('Company'), role: grab('Role'), file };
}

// "Finmid.com" → ["finmid"], "Peec AI" → ["peec"], "Berge & Meer" → ["berge","meer"].
// Short/common words are dropped so "AI" or "Group" can't match half the inbox.
const STOPWORDS = new Set([
  'gmbh', 'ag', 'se', 'kg', 'inc', 'ltd', 'llc', 'bv', 'nv', 'co', 'com', 'de',
  'group', 'the', 'and', 'und', 'ai', 'io', 'tech', 'labs', 'gruppe', 'holding',
]);
function tokensFor(company) {
  return company
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s&.-]/g, ' ')
    .split(/[\s&.\-]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 4 && !STOPWORDS.has(t));
}

function pausedEntries(applyLog) {
  const out = [];
  for (const [key, val] of Object.entries(applyLog)) {
    if (!String(val.status || '').startsWith('paused')) continue;
    const num = key.split('-')[0];
    const hdr = reportHeader(num);
    if (!hdr || !hdr.company) continue;
    const tokens = tokensFor(hdr.company);
    if (!tokens.length) continue;
    out.push({ key, num, company: hdr.company, role: hdr.role, url: val.url, tokens });
  }
  return out;
}

// ─────────────────────────────────────────────
// Inbox
// ─────────────────────────────────────────────
const CONFIRM_SUBJECT = /(applica|applying|applied|bewerbung|candidatur|thank you for|vielen dank|received your|eingang|wir haben ihre)/i;

async function fetchCandidateMessages(gmail, days) {
  // Wide net on purpose: subject keywords in DE/EN plus the big ATS senders.
  // Precision comes from the per-company token match afterwards.
  const q = [
    `newer_than:${days}d`,
    '-in:chats',
    '(subject:(application OR applying OR applied OR Bewerbung OR candidature OR "thank you")',
    'OR from:(ashbyhq.com OR greenhouse.io OR lever.co OR myworkday.com OR successfactors.com OR personio.de OR smartrecruiters.com))',
  ].join(' ');

  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 200 });
  const ids = (list.data.messages || []).map(m => m.id);
  const msgs = [];
  for (const id of ids) {
    const m = await gmail.users.messages.get({
      userId: 'me', id, format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });
    const h = {};
    for (const { name, value } of m.data.payload.headers || []) h[name.toLowerCase()] = value;
    msgs.push({
      id,
      from: h.from || '',
      subject: h.subject || '',
      date: h.date || '',
      snippet: m.data.snippet || '',
    });
  }
  return msgs;
}

function matchMessages(job, messages) {
  return messages.filter(m => {
    const hay = `${m.from} ${m.subject} ${m.snippet}`.toLowerCase();
    if (!job.tokens.some(t => hay.includes(t))) return false;
    // A company token alone isn't proof — a newsletter would match. Require the
    // mail to also look like an application acknowledgement.
    return CONFIRM_SUBJECT.test(`${m.subject} ${m.snippet}`);
  });
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  if (IS_SETUP) return runSetup();

  if (!existsSync(APPLY_LOG_FILE)) {
    console.log('No output/.apply-log.json — nothing to check.');
    return;
  }
  const applyLog = JSON.parse(readFileSync(APPLY_LOG_FILE, 'utf8'));
  const jobs = pausedEntries(applyLog);

  if (!jobs.length) {
    console.log('No paused applications in the log. Nothing to check.');
    return;
  }

  console.log(`\n=== Checking ${jobs.length} paused application(s) against the last ${DAYS} days of mail ===\n`);

  const gmail = await getGmailClient();
  let messages;
  try {
    messages = await fetchCandidateMessages(gmail, DAYS);
  } catch (e) {
    if (/insufficient|scope|forbidden|403/i.test(e.message)) {
      console.error('❌  The saved token cannot read mail (it only has compose access).');
      console.error('   Run once: node check-applied.mjs --setup');
      process.exit(1);
    }
    throw e;
  }
  console.log(`  scanned ${messages.length} candidate message(s)\n`);

  const confirmed = [];
  const unconfirmed = [];

  for (const job of jobs) {
    const hits = matchMessages(job, messages);
    if (hits.length) {
      confirmed.push({ job, hits });
      console.log(`  ✅ ${job.company} — ${job.role}`);
      for (const h of hits.slice(0, 2)) {
        console.log(`       "${h.subject.slice(0, 78)}"`);
        console.log(`       ${h.from.slice(0, 78)} · ${h.date.slice(0, 25)}`);
      }
    } else {
      unconfirmed.push(job);
    }
  }

  if (unconfirmed.length) {
    console.log('\n  No confirmation found for:');
    for (const j of unconfirmed) console.log(`    ·  ${j.company} — ${j.role}`);
  }

  console.log('\n=== Summary ===');
  console.log(`  Confirmed sent:   ${confirmed.length}`);
  console.log(`  No evidence:      ${unconfirmed.length}`);

  if (!IS_MARK) {
    console.log('\n  Nothing written. Re-run with --mark to record the confirmed ones');
    console.log('  as submitted so auto-apply stops re-opening them.\n');
    return;
  }

  for (const { job, hits } of confirmed) {
    applyLog[job.key] = {
      status: 'submitted',
      url: job.url,
      confirmation: 'gmail',
      evidence: hits[0].subject.slice(0, 120),
      timestamp: new Date().toISOString(),
    };
  }
  writeFileSync(APPLY_LOG_FILE, JSON.stringify(applyLog, null, 2));
  console.log(`\n  ✅ marked ${confirmed.length} as submitted in output/.apply-log.json`);
  console.log('     Set their tracker status to Applied in data/applications.md too.\n');
}

export { tokensFor, matchMessages, CONFIRM_SUBJECT };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
