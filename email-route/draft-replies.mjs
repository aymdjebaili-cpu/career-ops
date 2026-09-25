// Create reply drafts INSIDE the original thread, never sent.
//
// Standing order (2026-09-16): applications go out unattended, but replies to employers are
// left as drafts — a reply commits to a date, a wage or a shift, and that is his call.
//
// Input: output/email-route/reply-plan.json — an array of
//   { threadId, inReplyTo, to, subject, body, note }
// where threadId/inReplyTo/to/subject come from read-replies.mjs output, so a draft always
// lands in the employer's own thread rather than as a fresh mail they cannot place.
//
// Usage:
//   node email-route/draft-replies.mjs --dry-run
//   node email-route/draft-replies.mjs
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { google } from 'googleapis';

const DRY = process.argv.includes('--dry-run');
const PLAN = 'output/email-route/reply-plan.json';
const DONE = 'output/email-route/reply-drafts.json';

if (!existsSync(PLAN)) { console.log(`no reply plan at ${PLAN}`); process.exit(1); }
const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
const creds = JSON.parse(readFileSync('config/gmail-credentials.json', 'utf8'));
const token = JSON.parse(readFileSync('config/gmail-token.json', 'utf8'));
const { client_id, client_secret } = creds.installed || creds.web;
const auth = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:53682/callback');
auth.setCredentials(token);
const gmail = google.gmail({ version: 'v1', auth });

const profile = JSON.parse(JSON.stringify(
  (await import('js-yaml')).default.load(readFileSync('config/profile.yml', 'utf8')),
));
const me = profile.candidate || {};
// profile.yml's key is `full_name`, not `name`, so this always fell through to
// the literal and the From: header ignored the profile entirely.
const FROM_NAME = (me.full_name || 'Armin Djebaili')
  .trim().split(/\s+/)
  .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  .join(' ');

const CRLF = '\r\n';

// RFC 2047 for non-ASCII subjects (Bewerbung lines carry umlauts), and CRLF line endings.
const encodeHeader = (s) => (/[^\x20-\x7E]/.test(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s);

const done = existsSync(DONE) ? JSON.parse(readFileSync(DONE, 'utf8')) : {};
let made = 0, skipped = 0;
for (const r of plan) {
  const key = `${r.threadId}:${r.inReplyTo || ''}`;
  if (done[key]) { console.log(`already drafted  ${r.to}`); skipped++; continue; }
  const subject = r.subject.startsWith('Re:') ? r.subject : `Re: ${r.subject}`;
  // The blank line between headers and body is part of the MIME grammar, not an empty
  // entry to be tidied away. .filter(Boolean) removed it, so Gmail parsed the payload as
  // a broken header and stored four replies with no text at all (2026-09-16). Filter the
  // OPTIONAL HEADERS only, then attach the separator and the body explicitly.
  const headers = [
    `From: ${encodeHeader(FROM_NAME)} <${me.email}>`,
    `To: ${r.to}`,
    `Subject: ${encodeHeader(subject)}`,
    r.inReplyTo ? `In-Reply-To: ${r.inReplyTo}` : '',
    r.inReplyTo ? `References: ${r.inReplyTo}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean).join(CRLF);
  const mime = headers + CRLF + CRLF + Buffer.from(r.body, 'utf8').toString('base64');

  console.log(`${DRY ? '[dry] ' : ''}reply → ${r.to.padEnd(36)} ${subject.slice(0, 52)}`);
  if (r.note) console.log(`        (${r.note})`);
  if (DRY) { made++; continue; }
  try {
    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { threadId: r.threadId, raw: Buffer.from(mime, 'utf8').toString('base64url') } },
    });
    // Read it back before calling it written. Gmail accepts a draft and can still store
    // nothing; reporting that as a written reply is the failure that actually matters, so
    // an empty body is deleted and counted as a failure instead of recorded.
    const back = await gmail.users.drafts.get({ userId: 'me', id: res.data.id, format: 'full' });
    const size = back.data.message?.payload?.body?.size || 0;
    if (!size) {
      await gmail.users.drafts.delete({ userId: 'me', id: res.data.id }).catch(() => {});
      console.log('        FAILED: Gmail stored an empty body — draft deleted, nothing recorded');
      continue;
    }
    done[key] = { to: r.to, subject, draftId: res.data.id, bytes: size, at: new Date().toISOString() };
    made++;
    console.log(`        draft ${res.data.id} created in the employer's thread (${size} bytes)`);
  } catch (e) {
    console.log(`        FAILED: ${String(e.message).slice(0, 90)}`);
  }
}
if (!DRY) writeFileSync(DONE, JSON.stringify(done, null, 2));
console.log(`\n${made} reply draft(s) ${DRY ? 'would be ' : ''}created, ${skipped} already existed — nothing was sent`);
