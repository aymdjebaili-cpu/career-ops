#!/usr/bin/env node
/**
 * save-drafts.mjs — saves email drafts to Gmail automatically
 *
 * First-time setup:
 *   node save-drafts.mjs --setup
 *
 * Normal run (after batch completes):
 *   node save-drafts.mjs
 *
 * Options:
 *   --setup       Run OAuth flow to authenticate with Gmail
 *   --dry-run     Show what would be saved without creating drafts
 *   --score N     Only save drafts for jobs scored >= N (default: 3.5)
 *   --folder DIR  Folder to scan for email files (default: output/)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { exec } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;

// Config paths
const CREDENTIALS_FILE = join(PROJECT_DIR, 'config', 'gmail-credentials.json');
const TOKEN_FILE = join(PROJECT_DIR, 'config', 'gmail-token.json');
const DRAFT_LOG_FILE = join(PROJECT_DIR, 'output', '.draft-log.json');
const OUTPUT_DIR = join(PROJECT_DIR, 'output');

// Parse CLI args
const args = process.argv.slice(2);
const IS_SETUP = args.includes('--setup');
const IS_DRY_RUN = args.includes('--dry-run');
const SCORE_THRESHOLD = parseFloat(args.find(a => a.startsWith('--score='))?.split('=')[1] ?? '3.5');

// ─────────────────────────────────────────────
// Gmail API scope
// ─────────────────────────────────────────────
const SCOPES = ['https://www.googleapis.com/auth/gmail.compose'];

// ─────────────────────────────────────────────
// Lazy-load googleapis (install check)
// ─────────────────────────────────────────────
async function loadGoogleApis() {
  try {
    const { google } = await import('googleapis');
    return google;
  } catch {
    console.error('❌  googleapis not installed. Run: npm install googleapis');
    console.error('   Then re-run: node save-drafts.mjs --setup');
    process.exit(1);
  }
}

// ─────────────────────────────────────────────
// OAuth2 setup flow
// ─────────────────────────────────────────────
async function runSetup() {
  console.log('\n=== Gmail OAuth Setup ===\n');

  if (!existsSync(CREDENTIALS_FILE)) {
    console.log('📋  STEP 1: Create Gmail API credentials\n');
    console.log('  1. Go to: https://console.cloud.google.com/');
    console.log('  2. Create a new project (or select existing)');
    console.log('  3. Enable the Gmail API: APIs & Services → Enable APIs → search "Gmail API"');
    console.log('  4. Create credentials: APIs & Services → Credentials → Create Credentials → OAuth client ID');
    console.log('  5. Application type: "Desktop app"');
    console.log('  6. Download the JSON file');
    console.log(`  7. Save it as: config/gmail-credentials.json\n`);
    console.log('Then re-run: node save-drafts.mjs --setup\n');
    process.exit(0);
  }

  const google = await loadGoogleApis();
  const credentials = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3000/callback');

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('📋  STEP 2: Authorize access to your Gmail\n');
  console.log('Opening browser for authorization...');
  console.log('If it does not open, visit this URL manually:\n');
  console.log(authUrl + '\n');

  // Open browser
  const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${opener} "${authUrl}"`);

  // Local server to capture the OAuth callback
  await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost:3000');
      const code = url.searchParams.get('code');

      if (!code) {
        res.end('No authorization code received. Please try again.');
        server.close();
        reject(new Error('No authorization code'));
        return;
      }

      try {
        const { tokens } = await oAuth2Client.getToken(code);
        writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
        console.log(`✅  Token saved to config/gmail-token.json`);
        res.end('<h2>Authorization successful! You can close this tab.</h2><script>window.close()</script>');
        server.close();
        resolve();
      } catch (err) {
        res.end('Authorization failed: ' + err.message);
        server.close();
        reject(err);
      }
    });

    server.listen(3000, () => {
      console.log('Waiting for authorization callback on http://localhost:3000 ...\n');
    });

    server.on('error', reject);
  });

  console.log('\n✅  Setup complete! Run: node save-drafts.mjs\n');
}

// ─────────────────────────────────────────────
// Build authenticated Gmail client
// ─────────────────────────────────────────────
async function getGmailClient() {
  const google = await loadGoogleApis();

  if (!existsSync(CREDENTIALS_FILE)) {
    console.error('❌  Gmail credentials not found. Run: node save-drafts.mjs --setup');
    process.exit(1);
  }
  if (!existsSync(TOKEN_FILE)) {
    console.error('❌  Gmail token not found. Run: node save-drafts.mjs --setup');
    process.exit(1);
  }

  const credentials = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
  const { client_secret, client_id } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3000/callback');
  oAuth2Client.setCredentials(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')));

  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

// ─────────────────────────────────────────────
// Parse email draft files
// ─────────────────────────────────────────────
function parseEmailFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  const meta = {};
  let bodyStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '---') { bodyStart = i + 1; break; }
    const colonIdx = line.indexOf(':');
    if (colonIdx > -1) {
      const key = line.slice(0, colonIdx).trim().toUpperCase();
      const val = line.slice(colonIdx + 1).trim();
      meta[key] = val;
    }
  }

  const body = bodyStart > -1 ? lines.slice(bodyStart).join('\n').trim() : '';

  return {
    to: meta['TO'] || null,
    subject: meta['SUBJECT'] || null,
    body,
    score: parseFloat(meta['SCORE'] || '0'),
    company: meta['COMPANY'] || '',
    role: meta['ROLE'] || '',
    emailVerified: meta['EMAIL_VERIFIED'] || 'unverified',
    language: meta['LANGUAGE'] || 'EN',
    coverLetterPath: meta['COVER_LETTER_PATH'] || null,
    cvPath: meta['CV_PATH'] || null,
  };
}

// ─────────────────────────────────────────────
// Read cover letter content
// ─────────────────────────────────────────────
function readCoverLetter(path) {
  if (!path) return null;
  const fullPath = join(PROJECT_DIR, path);
  if (!existsSync(fullPath)) return null;
  const content = readFileSync(fullPath, 'utf8');
  // Strip the markdown header block, return just the letter text
  const parts = content.split('---\n');
  return parts.length >= 2 ? parts.slice(1, -1).join('---\n').trim() : content.trim();
}

// ─────────────────────────────────────────────
// Build MIME email message (with cover letter in body)
// ─────────────────────────────────────────────
function buildMimeMessage({ to, subject, emailBody, coverLetterText, language }) {
  const separator = language === 'FR'
    ? '\n\n— Lettre de motivation —\n\n'
    : language === 'DE'
    ? '\n\n— Anschreiben —\n\n'
    : '\n\n— Cover Letter —\n\n';

  const fullBody = coverLetterText
    ? emailBody + separator + coverLetterText
    : emailBody;

  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    fullBody,
  ].join('\r\n');

  // Base64url encode
  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─────────────────────────────────────────────
// Load / save draft log (tracks already-saved drafts)
// ─────────────────────────────────────────────
function loadDraftLog() {
  if (!existsSync(DRAFT_LOG_FILE)) return {};
  try { return JSON.parse(readFileSync(DRAFT_LOG_FILE, 'utf8')); }
  catch { return {}; }
}

function saveDraftLog(log) {
  writeFileSync(DRAFT_LOG_FILE, JSON.stringify(log, null, 2));
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  if (IS_SETUP) {
    await runSetup();
    return;
  }

  console.log('\n=== career-ops Gmail Draft Saver ===');
  console.log(`Score threshold: ${SCORE_THRESHOLD}/5`);
  console.log(`Dry run: ${IS_DRY_RUN}\n`);

  // Find all email draft files
  const allFiles = readdirSync(OUTPUT_DIR);
  const emailFiles = allFiles
    .filter(f => f.startsWith('email-') && f.endsWith('.md'))
    .map(f => join(OUTPUT_DIR, f));

  if (emailFiles.length === 0) {
    console.log('No email draft files found in output/');
    console.log('Run the batch evaluator first: bash batch/batch-runner.sh\n');
    return;
  }

  const draftLog = loadDraftLog();
  const gmail = IS_DRY_RUN ? null : await getGmailClient();

  let saved = 0, skipped = 0, alreadyDone = 0, errors = 0;

  for (const filePath of emailFiles) {
    const fileName = filePath.split(/[\\/]/).pop();

    // Skip already-saved drafts
    if (draftLog[fileName]) {
      console.log(`⏭️   ${fileName} — already saved (Gmail draft ID: ${draftLog[fileName].draftId})`);
      alreadyDone++;
      continue;
    }

    let parsed;
    try {
      parsed = parseEmailFile(filePath);
    } catch (err) {
      console.error(`❌  ${fileName} — parse error: ${err.message}`);
      errors++;
      continue;
    }

    // Score gate
    if (parsed.score < SCORE_THRESHOLD) {
      console.log(`⏭️   ${fileName} — score ${parsed.score}/5 below threshold (${SCORE_THRESHOLD}), skipping`);
      skipped++;
      continue;
    }

    // No recipient
    if (!parsed.to || parsed.to.includes('[') || parsed.to.includes('placeholder')) {
      console.log(`⚠️   ${fileName} — no verified email address. Add recipient manually.`);
      console.log(`    Company: ${parsed.company} | Role: ${parsed.role}`);
      skipped++;
      continue;
    }

    const coverLetterText = readCoverLetter(parsed.coverLetterPath);
    const mimeRaw = buildMimeMessage({
      to: parsed.to,
      subject: parsed.subject,
      emailBody: parsed.body,
      coverLetterText,
      language: parsed.language,
    });

    console.log(`📧  ${parsed.company} — ${parsed.role}`);
    console.log(`    To: ${parsed.to} ${parsed.emailVerified !== 'yes' ? '(⚠️ unverified)' : '(✅ verified)'}`);
    console.log(`    Subject: ${parsed.subject}`);
    console.log(`    Score: ${parsed.score}/5 | Cover letter: ${coverLetterText ? 'included' : 'not found'}`);

    if (IS_DRY_RUN) {
      console.log(`    [DRY RUN] Would save as Gmail draft\n`);
      saved++;
      continue;
    }

    try {
      const res = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: { message: { raw: mimeRaw } },
      });

      const draftId = res.data.id;
      draftLog[fileName] = {
        draftId,
        company: parsed.company,
        role: parsed.role,
        to: parsed.to,
        score: parsed.score,
        savedAt: new Date().toISOString(),
      };
      saveDraftLog(draftLog);

      console.log(`    ✅  Draft saved (ID: ${draftId})\n`);
      saved++;
    } catch (err) {
      console.error(`    ❌  Failed to save draft: ${err.message}\n`);
      errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Saved: ${saved} | Already done: ${alreadyDone} | Skipped: ${skipped} | Errors: ${errors}`);

  if (saved > 0 && !IS_DRY_RUN) {
    console.log('\n✅  Drafts are in your Gmail. Review, attach your CV PDF, and send when ready.');
    console.log('   Gmail → Drafts folder\n');
  }

  if (skipped > 0) {
    console.log(`ℹ️   ${skipped} job(s) skipped (score below ${SCORE_THRESHOLD} or no verified email).`);
    console.log('   Check the output/ folder and add email addresses manually where needed.\n');
  }
}

main().catch(err => {
  console.error('\n❌  Unexpected error:', err.message);
  process.exit(1);
});
