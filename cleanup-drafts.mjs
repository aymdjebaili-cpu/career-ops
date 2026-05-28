#!/usr/bin/env node
/**
 * cleanup-drafts.mjs — delete previously-saved Gmail drafts
 *
 * Reads output/.draft-log.json, deletes each draft from Gmail by ID,
 * then resets the log so new drafts can be created.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const CREDENTIALS_FILE = join(PROJECT_DIR, 'config', 'gmail-credentials.json');
const TOKEN_FILE = join(PROJECT_DIR, 'config', 'gmail-token.json');
const DRAFT_LOG_FILE = join(PROJECT_DIR, 'output', '.draft-log.json');
const OUTPUT_DIR = join(PROJECT_DIR, 'output');

async function getGmailClient() {
  const credentials = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
  const { client_secret, client_id } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3000/callback');
  oAuth2Client.setCredentials(JSON.parse(readFileSync(TOKEN_FILE, 'utf8')));
  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

async function main() {
  console.log('\n=== Gmail Draft Cleanup ===\n');

  if (!existsSync(DRAFT_LOG_FILE)) {
    console.log('No draft log found — nothing to clean up');
    return;
  }

  const log = JSON.parse(readFileSync(DRAFT_LOG_FILE, 'utf8'));
  const entries = Object.entries(log);

  if (entries.length === 0) {
    console.log('Draft log is empty');
    return;
  }

  console.log(`Found ${entries.length} drafts to delete from Gmail\n`);

  const gmail = await getGmailClient();
  let deleted = 0;
  let failed = 0;

  for (const [filename, draft] of entries) {
    process.stdout.write(`  ${draft.company} | ${draft.role}`);
    try {
      await gmail.users.drafts.delete({ userId: 'me', id: draft.draftId });
      console.log(' ✅');
      deleted++;
    } catch (e) {
      console.log(` ❌ ${e.message}`);
      failed++;
    }
  }

  // Reset the log
  writeFileSync(DRAFT_LOG_FILE, '{}');

  // Also delete email-*.md files so batch-drafts regenerates fresh
  const emailFiles = readdirSync(OUTPUT_DIR).filter(f => f.startsWith('email-') && f.endsWith('.md'));
  for (const f of emailFiles) {
    try { unlinkSync(join(OUTPUT_DIR, f)); } catch {}
  }

  console.log(`\n✅  Deleted ${deleted} drafts (${failed} failed)`);
  console.log(`✅  Removed ${emailFiles.length} local email draft files`);
  console.log(`✅  Reset draft log\n`);
  console.log('Now run: node batch-drafts.mjs --force --score=2.5');
  console.log('Then:    node save-drafts.mjs --score=2.5\n');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
