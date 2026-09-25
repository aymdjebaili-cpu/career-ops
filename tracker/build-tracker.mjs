#!/usr/bin/env node
/**
 * build-tracker.mjs — one ledger for the whole job search.
 *
 * WHY THIS EXISTS
 * The state was spread across six files that each answer a different question: what was
 * sent (.sent-log.json), what was submitted through a portal (chains/.lidl-applied.json),
 * what employers said (email-route/replies.json), what has been drafted in answer
 * (reply-drafts.json), what is planned (reply-plan.json). Nobody could answer the only
 * questions that matter — has this employer replied, does my answer exist yet, and where
 * do I have to be on Thursday — without opening all six. Worse, replies.json was being
 * OVERWRITTEN on every run, so the history could vanish (it did, on 2026-09-23).
 *
 * This merges them into tracker/tracker.json and never drops a row: an application that
 * disappears from a source stays in the ledger with its last known state. Appointments are
 * kept by hand in tracker/appointments.json because a date agreed in a mail thread is not
 * machine-readable with any accuracy worth trusting.
 *
 * Usage:  node tracker/build-tracker.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(HERE, 'tracker.json');

const read = (p, fallback) => {
  try { return JSON.parse(readFileSync(join(ROOT, p), 'utf8')); } catch { return fallback; }
};

const sent = read('output/.sent-log.json', {});
const lidl = read('chains/.lidl-applied.json', {});
const replies = read('output/email-route/replies.json', []);
const drafts = read('output/email-route/reply-drafts.json', {});
const plan = read('output/email-route/reply-plan.json', []);
const appointments = read('tracker/appointments.json', []);
// Consent links and portal re-applications: things only he can do, kept by hand because
// they come out of mail bodies and outlive any single inbox sweep.
const actions = read('tracker/actions.json', []);

const norm = (e) => String(e || '').trim().toLowerCase();
const company = (subject, file) => {
  const s = String(subject || '');
  const m = s.match(/^(?:Bewerbung|Initiativbewerbung):\s*(.+?)(?:\s*\(Ref\.|$)/i);
  if (m) return m[1].trim();
  return String(file || '').replace(/^email-(parttime|hosp|agency|init|spec)-/, '').replace(/\.md$/, '').replace(/-/g, ' ');
};

// ── applications ───────────────────────────────────────────────────────────────
const rows = [];
for (const [file, v] of Object.entries(sent)) {
  const channel = /^email-parttime-/.test(file) ? 'part-time posting'
    : /^email-hosp-/.test(file) ? 'hotel / agency speculative'
    : /^email-agency-/.test(file) ? 'recruiting agency'
    : /^email-init-/.test(file) ? 'Initiativbewerbung'
    : /^email-spec-/.test(file) ? 'speculative' : 'email';
  rows.push({
    id: file,
    channel,
    to: norm(v.to),
    role: company(v.subject, file),
    subject: v.subject || '',
    sentAt: v.sentAt || null,
    messageId: v.messageId || null,
    route: 'email',
  });
}
for (const [reqId, v] of Object.entries(lidl)) {
  rows.push({
    id: `lidl-${reqId}`,
    channel: 'Lidl portal',
    to: 'jobs.lidl.de',
    role: v.title || 'Lidl',
    subject: v.title || '',
    sentAt: v.at || null,
    messageId: null,
    route: 'portal',
    verdict: v.verdict || null,
    url: v.url || null,
  });
}

// ── what came back ─────────────────────────────────────────────────────────────
const byAddress = new Map();
for (const r of replies) {
  const key = norm(r.to) || norm((r.from.match(/<([^>]+)>/) || [])[1] || r.from);
  if (!byAddress.has(key)) byAddress.set(key, []);
  byAddress.get(key).push(r);
}

// ── what has been answered ─────────────────────────────────────────────────────
const draftedTo = new Map();
for (const d of Object.values(drafts)) draftedTo.set(norm(d.to), d);
const plannedTo = new Set(plan.map(p => norm(p.to)));

const ACTIONABLE = new Set(['QUESTION', 'INTERVIEW', 'CONSENT NEEDED', 'NEEDS READING']);

for (const row of rows) {
  const got = byAddress.get(row.to) || [];
  const latest = got.slice().sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt))).pop();
  row.replies = got.length;
  row.lastReplyAt = latest?.receivedAt || null;
  row.replyKind = latest?.kind || null;
  row.inSpam = got.some(r => r.where === 'SPAM');
  row.consentLink = got.map(r => (r.links || [])[0]).find(Boolean) || null;

  const draft = draftedTo.get(row.to);
  row.draftExists = Boolean(draft);
  row.draftBytes = draft?.bytes || null;
  row.draftAt = draft?.at || null;
  row.replyPlanned = plannedTo.has(row.to);

  // A draft in an employer's thread is itself proof that the employer wrote: nothing drafts
  // a reply to silence. replies.json was wiped on 2026-09-23 and refills only when Gmail is
  // readable again, so until then the drafts carry the history — better than showing an
  // employer who invited him to interview as "awaiting reply".
  if (!got.length && draft) {
    row.status = 'replied — answer drafted';
    row.needsYou = 'draft ready — send it';
    row.replyEvidence = 'inferred from the draft; the reply text is unreadable until Gmail is reconnected';
    continue;
  }

  // The one column that decides what to do next.
  row.status = !got.length ? 'awaiting reply'
    : latest.kind === 'BOUNCE' ? 'undeliverable'
    : latest.kind === 'REJECTION' ? 'rejected'
    : latest.kind === 'CONSENT NEEDED' ? 'needs your consent click'
    : latest.kind === 'INTERVIEW' ? 'invitation'
    : ACTIONABLE.has(latest.kind) ? 'needs an answer'
    : 'acknowledged';

  row.needsYou = (row.status === 'invitation' || row.status === 'needs an answer')
    ? (row.draftExists ? 'draft ready — send it' : 'no draft yet')
    : row.status === 'needs your consent click' ? 'click the consent link'
    : null;
}

rows.sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));

const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
const ledger = {
  builtAt: new Date().toISOString(),
  totals: {
    applications: rows.length,
    byRoute: rows.reduce((a, r) => { a[r.route] = (a[r.route] || 0) + 1; return a; }, {}),
    byChannel: rows.reduce((a, r) => { a[r.channel] = (a[r.channel] || 0) + 1; return a; }, {}),
    byStatus: counts,
    employers: new Set(rows.map(r => r.to)).size,
    repliesSeen: replies.length,
    draftsWaiting: Object.keys(drafts).length,
  },
  appointments,
  actions,
  applications: rows,
};

mkdirSync(HERE, { recursive: true });
writeFileSync(OUT, JSON.stringify(ledger, null, 1));
console.log(`${rows.length} applications, ${replies.length} replies on file, ${Object.keys(drafts).length} drafts, ${appointments.length} appointments`);
console.log(JSON.stringify(counts, null, 0));
console.log(`→ ${OUT}`);
