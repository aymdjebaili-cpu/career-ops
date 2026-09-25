// Send the application drafts this system created. Standing order from Aimene,
// 2026-09-16: "send always i dont wanna review anything".
//
// SAFETY: the only drafts ever touched are those whose Gmail draft id appears in
// output/.draft-log.json — i.e. written by save-drafts.mjs from an output/email-*.md file.
// The mailbox holds 200+ unrelated drafts (personal mail, half-written replies); none of
// them is enumerated, matched or sent here. A draft already sent is skipped, not re-sent.
//
// Usage:
//   node email-route/send-drafts.mjs --dry-run           # list what would go
//   node email-route/send-drafts.mjs                     # send them
//   node email-route/send-drafts.mjs --only=parttime     # only email-parttime-*.md drafts
//   node email-route/send-drafts.mjs --limit=10
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { google } from 'googleapis';

const DRY = process.argv.includes('--dry-run');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '--only=').split('=')[1];
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) || '--limit=500').split('=')[1]);
const LOG = 'output/.draft-log.json';
const SENT_LOG = 'output/.sent-log.json';

if (!existsSync(LOG)) { console.log('no draft log — nothing this system created to send'); process.exit(0); }
const log = JSON.parse(readFileSync(LOG, 'utf8'));
const rows = Object.entries(log)
  .map(([file, v]) => ({ file, ...(typeof v === 'object' ? v : { draftId: v }) }))
  .filter(r => r.draftId && /^email-.*\.md$/.test(r.file))
  .filter(r => !ONLY || r.file.includes(ONLY));

const creds = JSON.parse(readFileSync('config/gmail-credentials.json', 'utf8'));
const token = JSON.parse(readFileSync('config/gmail-token.json', 'utf8'));
const { client_id, client_secret } = creds.installed || creds.web;
const auth = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:53682/callback');
auth.setCredentials(token);
const gmail = google.gmail({ version: 'v1', auth });

const hdr = (m, n) => (m?.payload?.headers || []).find(h => h.name.toLowerCase() === n)?.value || '';
const sentLog = existsSync(SENT_LOG) ? JSON.parse(readFileSync(SENT_LOG, 'utf8')) : {};

const pending = [];
for (const r of rows) {
  try {
    const d = await gmail.users.drafts.get({ userId: 'me', id: r.draftId, format: 'metadata' });
    const labels = (d.data.message?.labelIds || []).join(',');
    const to = hdr(d.data.message, 'to');
    const subject = hdr(d.data.message, 'subject');
    if (labels.includes('SENT')) { console.log(`already sent  ${to.padEnd(38)} ${subject.slice(0, 44)}`); continue; }
    pending.push({ ...r, to, subject });
  } catch (e) {
    // A draft that was sent no longer exists as a draft, so drafts.get answers 404. That is
    // the normal end state, not a failure — printing "gone from Gmail" for every successful
    // send made a clean run read like a wall of errors. Only say "gone" when this system has
    // no record of having sent it.
    const prior = sentLog[r.file];
    if (prior) console.log(`already sent  ${String(prior.to).padEnd(38)} ${String(prior.sentAt).slice(0, 16).replace('T', ' ')}`);
    else console.log(`gone from Gmail  ${r.file} (${String(e.message).slice(0, 40)})`);
  }
}

const batch = pending.slice(0, LIMIT);
console.log(`\n${batch.length} draft(s) to send${DRY ? ' (dry run)' : ''}`);
for (const b of batch) console.log(`   ${b.to.padEnd(38)} ${b.subject.slice(0, 50)}`);
if (DRY || !batch.length) { console.log(DRY ? '\ndry run: nothing sent' : '\nnothing to send'); process.exit(0); }

let sent = 0, failed = 0;
for (const b of batch) {
  try {
    const res = await gmail.users.drafts.send({ userId: 'me', requestBody: { id: b.draftId } });
    sentLog[b.file] = { to: b.to, subject: b.subject, messageId: res.data.id, sentAt: new Date().toISOString() };
    sent++;
    console.log(`SENT  ${b.to.padEnd(38)} ${b.subject.slice(0, 44)}`);
  } catch (e) {
    failed++;
    console.log(`FAILED ${b.to.padEnd(38)} ${String(e.message).slice(0, 70)}`);
  }
}
writeFileSync(SENT_LOG, JSON.stringify(sentLog, null, 2));
console.log(`\nsent ${sent}, failed ${failed} — record in ${SENT_LOG}`);
