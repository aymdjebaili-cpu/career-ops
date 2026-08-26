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
 *   --no-update   Leave drafts already in Gmail alone, even if the file changed
 *
 * A draft whose source file has changed is UPDATED IN PLACE (same draft id), not
 * duplicated and not skipped. Without this, rebuild-email-bodies.mjs could fix a
 * body on disk and the stub would sit in Gmail forever — the log said "done".
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
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
const NO_UPDATE = args.includes('--no-update');
const SCORE_THRESHOLD = parseFloat(args.find(a => a.startsWith('--score='))?.split('=')[1] ?? '3.5');

// ─────────────────────────────────────────────
// Gmail API scope
// ─────────────────────────────────────────────
const SCOPES = ['https://www.googleapis.com/auth/gmail.compose'];

// Bump when buildMimeMessage changes shape. It is mixed into each draft's
// fingerprint, so a builder fix re-pushes every draft even though no source file
// changed — otherwise drafts written by a broken builder stay broken forever,
// because the log says they match. v2 = the empty-body MIME fix.
const MIME_BUILDER_VERSION = 'v2';

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

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:53682/callback');

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
      const url = new URL(req.url, 'http://localhost:53682');
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

    server.listen(53682, () => {
      console.log('Waiting for authorization callback on http://localhost:53682 ...\n');
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
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:53682/callback');
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
    coverLetterPdf: meta['COVER_LETTER_PDF'] || null,
    cvPath: meta['CV_PATH'] || null,
    cvPdf: meta['CV_PDF'] || null,
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
// Build MIME email message with PDF attachments
// ─────────────────────────────────────────────
function buildMimeMessage({ to, subject, emailBody, attachments }) {
  // Generate a unique boundary string
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const headers = [
    `To: ${to}`,
    `Subject: ${encodeMimeWord(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  const parts = [];

  // Body part.
  //
  // TWO BUGS LIVED HERE, and together they silently deleted the message text —
  // Gmail accepted every draft, attached both PDFs, and showed an empty body:
  //
  //   1. The header block was terminated by ONE CRLF before the first boundary
  //      instead of a blank line (CRLF CRLF). RFC 5322 ends headers at the first
  //      empty line, so Gmail kept parsing `--boundary` and the part headers as
  //      message headers and the real body was consumed as header junk.
  //   2. `Content-Transfer-Encoding: 7bit` was declared over UTF-8 text. These
  //      letters are full of 8-bit bytes — ä, ü, €, —, é — so the declaration was
  //      a lie even once the framing was right.
  //
  // Body is base64 now: legal for any byte, and immune to line-length limits.
  const bodyB64 = Buffer.from(emailBody ?? '', 'utf8').toString('base64');
  parts.push([
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    (bodyB64.match(/.{1,76}/g) ?? []).join('\r\n'),
    '',
  ].join('\r\n'));

  // Attachment parts
  for (const att of attachments) {
    if (!att.path || !existsSync(att.path)) {
      console.log(`     ⚠️  attachment not found: ${att.path}`);
      continue;
    }
    const pdfBytes = readFileSync(att.path);
    const b64 = pdfBytes.toString('base64');
    // Split base64 into 76-char lines (RFC 2045)
    const b64Lines = b64.match(/.{1,76}/g).join('\r\n');

    parts.push([
      `--${boundary}`,
      `Content-Type: application/pdf; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      b64Lines,
      '',
    ].join('\r\n'));
  }

  // Closing boundary
  parts.push(`--${boundary}--`);

  // The '\r\n\r\n' is the header/body separator that was missing.
  const message = headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');

  // Base64url encode for Gmail API
  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Read the draft back out of Gmail and confirm the text part survived.
 *
 * The MIME framing bug above was invisible from this side: create() returned a
 * draft id, the log said "saved", and the body was gone. An application mail with
 * no text is worse than none at all, so every write is now verified against what
 * Gmail actually stored rather than against what we hoped we sent.
 */
async function verifyDraftBody(gmail, draftId, expectedChars) {
  const res = await gmail.users.drafts.get({ userId: 'me', id: draftId, format: 'full' });
  let found = 0;
  const walk = (part) => {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      found = Math.max(found, Buffer.from(part.body.data, 'base64').toString('utf8').trim().length);
    }
    (part.parts ?? []).forEach(walk);
  };
  walk(res.data.message.payload);
  // Encoding can shift the count a little; anything near the source is fine.
  return { ok: found >= Math.min(50, expectedChars * 0.5), found };
}

// Encode subject line for non-ASCII characters (UTF-8 → MIME encoded-word)
function encodeMimeWord(text) {
  if (!text) return '';
  if (/^[\x00-\x7F]*$/.test(text)) return text; // pure ASCII, no encoding needed
  return '=?UTF-8?B?' + Buffer.from(text, 'utf-8').toString('base64') + '?=';
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

  let updated = 0;

  for (const filePath of emailFiles) {
    const fileName = filePath.split(/[\\/]/).pop();
    const prior = draftLog[fileName];

    // Content fingerprint decides skip vs. update. Older log entries predate the
    // hash, so treat a missing one as "unknown" and refresh the draft once.
    const fingerprint = createHash('sha256')
      .update(MIME_BUILDER_VERSION)
      .update(readFileSync(filePath))
      .digest('hex').slice(0, 16);

    if (prior && (prior.fingerprint === fingerprint || NO_UPDATE)) {
      console.log(`⏭️   ${fileName} — already saved (Gmail draft ID: ${prior.draftId})`);
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

    // Provenance gate. daily-run.mjs no longer invents addresses, but drafts
    // written before that change are still on disk and they record their own
    // origin honestly: `EMAIL_VERIFIED: guessed, unverified (...)`. Pushing one
    // puts a job application in the mailbox addressed to an inbox nobody
    // confirmed exists — and in Gmail it sits next to the verified drafts
    // looking exactly as trustworthy. A generic careers@ guess is a bounce, not
    // a long shot, so it never reaches the outbox.
    if (/^(guessed|unverified|unknown|none)\b/i.test(String(parsed.emailVerified).trim())) {
      console.log(`⏭️   ${fileName} — ${parsed.to} has no published source, not drafting.`);
      console.log(`    ${parsed.company} | ${parsed.role} — apply through their portal instead.`);
      skipped++;
      continue;
    }

    // Build attachments list: cover letter PDF + CV PDF
    const attachments = [];
    if (parsed.coverLetterPdf) {
      const coverPath = join(PROJECT_DIR, parsed.coverLetterPdf);
      attachments.push({
        path: coverPath,
        filename: parsed.language === 'DE'
          ? `Anschreiben_Aimene_Djebaili.pdf`
          : `Cover_Letter_Aimene_Djebaili.pdf`,
      });
    }
    if (parsed.cvPdf) {
      const cvPath = join(PROJECT_DIR, parsed.cvPdf);
      attachments.push({
        path: cvPath,
        filename: `CV_Aimene_Djebaili.pdf`,
      });
    } else if (parsed.cvPath) {
      // Legacy: CV_PATH (text), use the configured PDF
      const cvPath = join(PROJECT_DIR, 'output', 'cv-updated.pdf');
      if (existsSync(cvPath)) {
        attachments.push({ path: cvPath, filename: `CV_Aimene_Djebaili.pdf` });
      }
    }

    const mimeRaw = buildMimeMessage({
      to: parsed.to,
      subject: parsed.subject,
      emailBody: parsed.body,
      attachments,
    });

    console.log(`📧  ${parsed.company} — ${parsed.role}`);
    // EMAIL_VERIFIED holds either the literal 'yes' (initiativ targets, where the
    // provenance sits on its own EMAIL_SOURCE line) or a sentence naming where
    // the address was published. Only the first form used to count as verified,
    // so every scraped-with-a-source address was labelled "⚠️ unverified" — the
    // same warning shown for a pure guess, which makes the warning worthless.
    const traceable = !/^(guessed|unverified|unknown|none)\b/i.test(String(parsed.emailVerified).trim());
    console.log(`    To: ${parsed.to} ${traceable ? '(✅ verified)' : '(⚠️ unverified)'}`);
    if (traceable && parsed.emailVerified !== 'yes') console.log(`    Source: ${parsed.emailVerified}`);
    console.log(`    Subject: ${parsed.subject}`);
    console.log(`    Score: ${parsed.score}/5 | Attachments: ${attachments.length} PDF${attachments.length !== 1 ? 's' : ''}`);

    if (IS_DRY_RUN) {
      console.log(`    [DRY RUN] Would ${prior ? 'update existing' : 'save as'} Gmail draft\n`);
      if (prior) updated++; else saved++;
      continue;
    }

    try {
      // update() keeps the draft id, so a revised body replaces the old one
      // instead of leaving two near-identical drafts to pick between.
      const create = () => gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: mimeRaw } } });
      let res;
      if (prior) {
        try {
          res = await gmail.users.drafts.update({ userId: 'me', id: prior.draftId, requestBody: { message: { raw: mimeRaw } } });
        } catch (e) {
          // The logged draft is gone — deleted by hand, or already sent. Recreate
          // rather than fail: the log is our record, Gmail is the truth.
          if (!/not a draft|not found|notFound/i.test(e.message)) throw e;
          console.log(`    ↪ logged draft no longer exists in Gmail — creating a fresh one`);
          res = await create();
        }
      } else {
        res = await create();
      }

      const draftId = res.data.id;

      const check = await verifyDraftBody(gmail, draftId, parsed.body.trim().length);
      if (!check.ok) {
        console.error(`    ❌  Gmail stored this draft with an empty/short body (${check.found} chars) — not recording it as done\n`);
        errors++;
        continue;
      }

      draftLog[fileName] = {
        draftId,
        company: parsed.company,
        role: parsed.role,
        to: parsed.to,
        score: parsed.score,
        fingerprint,
        savedAt: prior?.savedAt ?? new Date().toISOString(),
        ...(prior ? { updatedAt: new Date().toISOString() } : {}),
      };
      saveDraftLog(draftLog);

      console.log(`    ✅  Draft ${prior ? 'updated' : 'saved'} (ID: ${draftId}, body ${check.found} chars verified in Gmail)\n`);
      if (prior) updated++; else saved++;
    } catch (err) {
      console.error(`    ❌  Failed to ${prior ? 'update' : 'save'} draft: ${err.message}\n`);
      errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Saved: ${saved} | Updated: ${updated} | Already done: ${alreadyDone} | Skipped: ${skipped} | Errors: ${errors}`);

  if ((saved > 0 || updated > 0) && !IS_DRY_RUN) {
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
