// Find what employers replied to the applications this system sent.
//
// Needs the token minted by `node check-applied.mjs --setup` (gmail.compose + gmail.readonly).
// Reads only threads that contain a message WE sent — every thread is located from a message
// id in output/.sent-log.json, so the rest of the mailbox is never enumerated or read.
//
// Usage:
//   node email-route/read-replies.mjs                 # summarise replies
//   node email-route/read-replies.mjs --days=14       # how far back to look (default 30)
//   node email-route/read-replies.mjs --full          # print the reply text, not just a snippet
//   node email-route/read-replies.mjs --json          # machine-readable, for the reply drafter
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { google } from 'googleapis';

const arg = (n, d) => (process.argv.find(a => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1];
const DAYS = Number(arg('days', '30'));
const FULL = process.argv.includes('--full');
const AS_JSON = process.argv.includes('--json');
const SENT_LOG = 'output/.sent-log.json';
const OUT = 'output/email-route/replies.json';

if (!existsSync(SENT_LOG)) { console.log('no send log — nothing to follow up'); process.exit(0); }
const sent = JSON.parse(readFileSync(SENT_LOG, 'utf8'));
const rows = Object.entries(sent).map(([file, v]) => ({ file, ...v }))
  .filter(r => r.messageId && (Date.now() - new Date(r.sentAt || 0).getTime()) / 86400000 <= DAYS);

const creds = JSON.parse(readFileSync('config/gmail-credentials.json', 'utf8'));
const token = JSON.parse(readFileSync('config/gmail-token.json', 'utf8'));
if (!/gmail\.readonly/.test(token.scope || '')) {
  console.log('This token cannot read mail (scope: ' + (token.scope || 'unknown') + ').');
  console.log('Run:  node check-applied.mjs --setup    — it keeps draft access and adds read access.');
  process.exit(1);
}
const { client_id, client_secret } = creds.installed || creds.web;
const auth = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:53682/callback');
auth.setCredentials(token);
const gmail = google.gmail({ version: 'v1', auth });

// Prove the token works before walking anything. Every Gmail call below is wrapped in a
// catch-and-continue, so an expired token produced "replies found: 0" — a silent blind
// spot that reads exactly like a quiet inbox. On 2026-09-23 that nearly got reported as
// "nothing new" while four real replies sat unread. A monitor that cannot see must say so.
try {
  await gmail.users.getProfile({ userId: 'me' });
} catch (e) {
  const dead = /invalid_grant|invalid_credentials|unauthorized|401/i.test(String(e.message));
  console.error(`\n❌ Gmail is not readable: ${String(e.message).slice(0, 120)}`);
  if (dead) {
    console.error('   The token has expired — this OAuth app is in Testing mode, so it dies every 7 days.');
    console.error('   Fix:  node check-applied.mjs --setup     (keeps compose access, re-adds read access)');
  }
  console.error('   NOTHING was checked. Do not read this run as "no new replies".\n');
  process.exit(2);
}

const hdr = (m, n) => (m?.payload?.headers || []).find(h => h.name.toLowerCase() === n)?.value || '';
const decode = (d) => Buffer.from(String(d).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
/**
 * HTML mail carries its stylesheet inline, and stripping only the tags left the CSS behind
 * as "text" — Helmes' interview invitation read as a wall of @font-face rules, and the
 * classifier was judging mails on their font stacks (2026-09-17). Drop style and script
 * blocks, and any leading at-rules, before the tags come off.
 */
const htmlToText = (html) => String(html)
  .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/@(import|font-face|media|charset)[^;{]*[;{][\s\S]*?(\}|;)/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

const bodyOf = (p) => {
  if (!p) return '';
  if (p.mimeType === 'text/plain' && p.body?.data) return decode(p.body.data);
  for (const c of p.parts || []) { const t = bodyOf(c); if (t) return t; }
  if (p.mimeType === 'text/html' && p.body?.data) return htmlToText(decode(p.body.data));
  return '';
};

// What kind of answer is this? Deliberately conservative: anything unclear is "needs reading",
// because a wrong label on a rejection or an interview invitation is worse than no label.
function classify(text, subject, from) {
  const t = `${subject}\n${text}`.toLowerCase();
  // Office 365 sends its non-delivery report from postmaster@ with the wording "couldn't
  // be delivered" and "Recipient Unknown" — none of which matched, so a dead address at
  // Insight Recruitment was filed as a question to answer (2026-09-22).
  if (/mailer-daemon|postmaster@|delivery status notification|undelivered|couldn.?t be delivered|could not be delivered|recipient unknown|wasn.?t found at|zustellung fehlgeschlagen|nicht zugestellt|unzustellbar|undeliverable/.test(`${from} ${t}`)) return 'BOUNCE';
  if (/abwesen|out of office|urlaub|automatische antwort|automatic reply/.test(t)) return 'AUTOREPLY';
  // A consent link is the one kind of reply no draft can answer: the agency cannot look at
  // the application until he clicks it himself, and nobody else may click it for him.
  // Hofmann, PASIT and PAMEC all stalled on this on 2026-09-16.
  if (/einwilligung|zustimmung zum verarbeiten|zustimmung zur verarbeitung|datenschutz.{0,30}(bestätigen|zustimmen)|consent/.test(t)) return 'CONSENT NEEDED';
  // A recruiter who tried to phone and missed him writes "leider konnten wir Sie
  // telefonisch nicht erreichen" — and the old rule, which fired on a bare "leider",
  // filed two firms chasing him by phone as rejections (Isarland and ISD, 2026-09-18).
  // Anything that asks for a callback, a time window or his availability is the opposite
  // of a rejection, so it is checked first.
  // An invitation with a day or a clock time outranks everything below: a mail that both
  // proposes a meeting AND names when is an invitation, even when it also says "rufen Sie
  // uns an" in the signature (which is what demoted Personell Service's invitation to a
  // question on the first pass).
  // "Wir laden Sie herzlich ein, sich über unser Portal zu bewerben" is a redirect, not an
  // invitation — Adecco's autoresponder was read as an interview on 2026-09-22. A mail that
  // points at a portal or says the inbox does not process applications is never an invite.
  // `t` is lowercased before every test, so an alternative containing a capital letter can
  // never match — "bewerben Sie sich" let Trenkwalder's redirect through as an interview
  // minutes after the same rule caught Adecco's (2026-09-22). All lowercase from here.
  const portalRedirect = /bewerben sie sich (bitte )?(direkt )?(über|unter|auf)|karriereseite|karriereplattform|bewerberportal|stellenportal|talentprofil|talentpool|online.?bewerbung|ausschließlich über (unsere|das)|nicht für die bearbeitung von bewerbungen|über diesen weg (leider )?nicht|per e-?mail .{0,30}(nicht|leider nicht) (berücksichtigen|bearbeiten)/.test(t);
  if (portalRedirect) return 'QUESTION';

  const meeting = /kennenlernen|gespräch|termin|vorstellungsgespräch|bewerbungsgespräch|probearbeiten|probetag|interview/.test(t);
  const whenProposed = /\b\d{1,2}[:.]\d{2}\s*(uhr)?\b|\b\d{1,2}\s*uhr\b|\b(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b|\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(t);
  if (meeting && whenProposed) return 'INTERVIEW';

  if (/nicht erreichen|nicht erreicht|telefonisch versucht|rufen sie|rückruf|zeitfenster|wann (sind sie|bist du) erreichbar|teile? (uns|mir) mit|welche(s|n)? (zeitmodell|wochentage|tage)/.test(t)) return 'QUESTION';
  // A real rejection says so outright. "leider" alone appears in half of all German mail.
  if (/absage|nicht berücksichtigen|nicht weiter berücksichtigen|anderweitig vergeben|kein passendes|keine passende|entschieden, ihre bewerbung|für eine weiterführende auswahl nicht|leider (keine?|kein) (freie |passende |vakante )?(stelle|position|möglichkeit)|keine (freie |passende |vakante )?(position|stelle) (zu vergeben|frei|anzubieten)|derzeit (leider )?(keine|nichts)|unfortunately|not moving forward|regret to/.test(t)) return 'REJECTION';
  // Receipts before invitations. "Eingangsbestätigung" from a hotel's reservations desk was
  // read as an interview invitation, because the old rule accepted a bare "termin" or
  // "call" — words that appear in every hotel autoresponder on earth.
  if (/eingangsbestätigung|confirmation of receipt|eingegangen|erhalten und|received your application|vielen dank für ihre bewerbung|werden uns .{0,20}melden/.test(t)) return 'ACK';
  if (/vorstellungsgespräch|bewerbungsgespräch|probearbeiten|probetag|zum kennenlernen|gespräch vereinbaren|termin vereinbaren|einladen möchten|laden wir sie ein|invite you to|schedule (a|an) (call|interview)/.test(t)) return 'INTERVIEW';
  if (/\?|bitte senden|benötigen wir|könnten sie|rückfrage|zeugnis|lebenslauf fehlt/.test(t)) return 'QUESTION';
  return 'NEEDS READING';
}

const found = [];
const seenMsg = new Set();

/** Where Gmail filed a message. A reply in Spam is one he will never see on his own. */
const placeOf = (m) => {
  const l = m.labelIds || [];
  if (l.includes('SPAM')) return 'SPAM';
  if (l.includes('TRASH')) return 'TRASH';
  if (l.includes('INBOX')) return 'INBOX';
  return 'ARCHIVE';
};

/** The raw HTML part, kept only to dig a consent link out of a button that has no text. */
const htmlOf = (p) => {
  if (!p) return '';
  if (p.mimeType === 'text/html' && p.body?.data) return decode(p.body.data);
  for (const c of p.parts || []) { const t = htmlOf(c); if (t) return t; }
  return '';
};

/**
 * Consent mails put the link behind a button ("Jetzt Einwilligung bestätigen"), so the
 * plain-text part says only "Hier klicken" and the URL never reaches the report. He needs
 * the actual address to click, so pull it out of the markup.
 */
function consentLinks(html) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const [, href, label] = m;
    const text = label.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/^https?:/i.test(href)) continue;
    if (/einwillig|zustimm|consent|datenschutz|dsgvo|best[äa]tig/i.test(`${href} ${text}`)) out.push(href);
  }
  return [...new Set(out)].slice(0, 3);
}

function record(m, { to, appliedAt, threadId }) {
  if (seenMsg.has(m.id)) return;
  const from = hdr(m, 'from');
  if (/aym\.djebaili@gmail\.com/i.test(from)) return;        // anything he sent himself
  seenMsg.add(m.id);
  const text = bodyOf(m.payload).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const kind = classify(text, hdr(m, 'subject'), from);
  found.push({
    to, appliedAt, subject: hdr(m, 'subject'), from,
    receivedAt: new Date(Number(m.internalDate)).toISOString(),
    kind,
    links: kind === 'CONSENT NEEDED' ? consentLinks(htmlOf(m.payload)) : [],
    where: placeOf(m),
    threadId: threadId || m.threadId, messageId: m.id, inReplyTo: hdr(m, 'message-id'),
    text: text.slice(0, 4000),
  });
}

// ── 1. the threads our applications live in ───────────────────────────────────
for (const r of rows) {
  let threadId;
  try { threadId = (await gmail.users.messages.get({ userId: 'me', id: r.messageId, format: 'minimal' })).data.threadId; }
  catch { continue; }
  let thread;
  try { thread = (await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' })).data; }
  catch { continue; }
  for (const m of thread.messages || []) {
    if (m.id === r.messageId) continue;                     // our own application
    record(m, { to: r.to, appliedAt: r.sentAt, threadId });
  }
}

// ── 2. anything from those employers that never joined the thread ─────────────
// A reply only threads when the employer's client keeps our Message-ID in References.
// Plenty do not — they compose a fresh mail — and Gmail then files it on its own, often
// in Spam, where it is invisible to the walk above. So ask directly: mail FROM the
// domains we wrote to, spam and trash included. Nothing else in the mailbox is read.
// Some employers apply from a free-mail address (alterwirt.karcher@t-online.de,
// bautenschutz.holz@gmail.com). Searching those as DOMAINS asks Gmail for every mail
// from gmail.com or t-online.de — which on 2026-09-19 dragged a private account
// statement for his travel agency into a job-reply sweep. For free-mail providers,
// match the exact address we wrote to and nothing else.
const FREEMAIL = /^(gmail|googlemail|t-online|web|gmx|freenet|yahoo|outlook|hotmail|live|icloud|aol|mail)\.(com|de|net|co\.uk|fr)$/i;
const needles = [...new Set(rows.map((r) => {
  const addr = String(r.to).toLowerCase();
  const domain = addr.split('@')[1] || '';
  return FREEMAIL.test(domain) ? addr : domain;
}).filter(Boolean))];
const CHUNK = 20;
for (let i = 0; i < needles.length; i += CHUNK) {
  const q = `newer_than:${Math.max(1, Math.ceil(DAYS))}d from:{${needles.slice(i, i + CHUNK).join(' ')}}`;
  let ids = [];
  try {
    const res = await gmail.users.messages.list({ userId: 'me', q, includeSpamTrash: true, maxResults: 100 });
    ids = (res.data.messages || []).map(m => m.id);
  } catch { continue; }
  for (const id of ids) {
    if (seenMsg.has(id)) continue;
    try {
      const m = (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
      const from = hdr(m, 'from').toLowerCase();
      const match = rows.find(r => from.includes(String(r.to).split('@')[1].toLowerCase()));
      record(m, { to: match?.to || hdr(m, 'from'), appliedAt: match?.sentAt, threadId: m.threadId });
    } catch { /* skip */ }
  }
}

// MERGE, never overwrite. This file is the only record of what employers have said, and a
// run with a shorter --days window (or, on 2026-09-23, an expired token) rewrote it with
// fewer entries — silently erasing the history the tracker is built on. Old entries are
// kept and matched by Gmail message id; a re-read of the same message updates it.
const prior = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : [];
const merged = new Map(prior.map(r => [r.messageId, r]));
for (const r of found) merged.set(r.messageId, { ...merged.get(r.messageId), ...r });
const all = [...merged.values()].sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
writeFileSync(OUT, JSON.stringify(all, null, 1));
if (AS_JSON) { console.log(JSON.stringify(found, null, 1)); process.exit(0); }

const counts = {};
for (const f of found) counts[f.kind] = (counts[f.kind] || 0) + 1;
console.log(`checked ${rows.length} sent application(s) from the last ${DAYS} days`);
console.log(`replies found: ${found.length} ${JSON.stringify(counts)}\n`);
const consent = found.filter(f => f.kind === 'CONSENT NEEDED');
if (consent.length) {
  console.log(`⚠ ${consent.length} application(s) are STALLED until he clicks a consent link himself — nobody else may click it:`);
  for (const f of consent) {
    const link = f.links?.[0] || (f.text.match(/https?:\/\/\S{10,}/) || [])[0] || '(link is inside the mail)';
    console.log(`   ${f.from.slice(0, 42).padEnd(44)} ${link.replace(/[>"']+$/, '').slice(0, 110)}`);
  }
  console.log('');
}

const inSpam = found.filter(f => f.where === 'SPAM');
if (inSpam.length) {
  console.log(`⚠ ${inSpam.length} repl${inSpam.length === 1 ? 'y is' : 'ies are'} sitting in SPAM — he would never have seen ${inSpam.length === 1 ? 'it' : 'them'}:`);
  for (const f of inSpam) console.log(`   ${f.kind.padEnd(12)} ${f.from.slice(0, 46)}  ${f.subject.slice(0, 50)}`);
  console.log('');
}
for (const f of found) {
  console.log(`${f.kind.padEnd(14)} ${f.where === 'SPAM' ? '[SPAM] ' : ''}${f.receivedAt.slice(0, 16).replace('T', ' ')}  ${f.from.slice(0, 44)}`);
  console.log(`               re: ${f.subject.slice(0, 70)}`);
  console.log(`               ${FULL ? '\n' + f.text : f.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  console.log('');
}
console.log(`saved to ${OUT}`);
