#!/usr/bin/env node
/**
 * build-dashboard.mjs — render tracker.json into a single self-contained page.
 *
 * The ledger is inlined at build time rather than fetched, so the page works offline, on a
 * phone, and as a published artifact with no backend. Re-run after build-tracker.mjs and
 * republish to update it.
 *
 * Usage:  node tracker/build-tracker.mjs && node tracker/build-dashboard.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ledger = JSON.parse(readFileSync(join(HERE, 'tracker.json'), 'utf8'));
const DATA = JSON.stringify(ledger).replace(/</g, '\\u003c');

const html = `<title>Bewerbungsregister</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root {
    --paper: #f4f6f8;
    --surface: #ffffff;
    --raised: #fbfcfd;
    --ink: #14181d;
    --muted: #5f6d80;
    --faint: #8a97a8;
    --line: #dfe4ec;
    --accent: #1d4e89;
    --accent-soft: #e8eef7;
    --go: #146848;
    --go-soft: #e2f1ea;
    --warn: #8a5300;
    --warn-soft: #fbeeda;
    --stop: #9d2b20;
    --stop-soft: #f9e6e3;
    --sans: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
    --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
  }
  :root:not([data-theme="light"]) { }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper: #0e1116;
      --surface: #161a21;
      --raised: #1c212a;
      --ink: #e7ebf1;
      --muted: #9aa7b8;
      --faint: #74818f;
      --line: #252c36;
      --accent: #8ab2e8;
      --accent-soft: #1a2434;
      --go: #5cc294;
      --go-soft: #14251f;
      --warn: #e2ab55;
      --warn-soft: #2a2213;
      --stop: #e8867a;
      --stop-soft: #2c1a18;
    }
  }
  :root[data-theme="dark"] {
    --paper: #0e1116;
    --surface: #161a21;
    --raised: #1c212a;
    --ink: #e7ebf1;
    --muted: #9aa7b8;
    --faint: #74818f;
    --line: #252c36;
    --accent: #8ab2e8;
    --accent-soft: #1a2434;
    --go: #5cc294;
    --go-soft: #14251f;
    --warn: #e2ab55;
    --warn-soft: #2a2213;
    --stop: #e8867a;
    --stop-soft: #2c1a18;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 20px 16px 72px; }
  h1, h2, h3 { margin: 0; text-wrap: balance; }

  header.masthead { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: baseline; justify-content: space-between; padding-bottom: 14px; border-bottom: 2px solid var(--ink); }
  h1 { font-size: 21px; font-weight: 600; letter-spacing: -0.01em; }
  .built { font-family: var(--mono); font-size: 11.5px; color: var(--faint); }

  .notice { margin-top: 16px; display: flex; gap: 10px; padding: 12px 14px; background: var(--warn-soft); border-left: 3px solid var(--warn); border-radius: 0 4px 4px 0; font-size: 13.5px; }
  .notice strong { color: var(--warn); font-weight: 600; }

  section { margin-top: 30px; }
  .eyebrow { font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint); margin-bottom: 10px; display: flex; gap: 8px; align-items: baseline; }
  .eyebrow .count { color: var(--accent); }

  .stack { display: flex; flex-direction: column; gap: 10px; }

  .appt { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px; display: grid; grid-template-columns: 92px 1fr; gap: 4px 16px; }
  .appt.today { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
  .appt.past { opacity: 0.62; }
  .appt .when { font-family: var(--mono); font-size: 13px; font-weight: 600; color: var(--accent); line-height: 1.35; }
  .appt.past .when { color: var(--faint); }
  .appt .co { font-weight: 600; font-size: 15.5px; }
  .appt .meta { grid-column: 2; color: var(--muted); font-size: 13.5px; }
  .appt .note { grid-column: 2; margin-top: 6px; font-size: 13px; color: var(--muted); border-top: 1px dashed var(--line); padding-top: 6px; }
  .appt .tbd { font-family: var(--mono); font-size: 11.5px; color: var(--faint); }

  .task { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; justify-content: space-between; }
  .task .who { font-weight: 600; }
  .task .what { color: var(--muted); font-size: 13.5px; width: 100%; }
  .task a { font-family: var(--mono); font-size: 12px; color: var(--accent); word-break: break-all; }
  .task .why { width: 100%; font-size: 12.5px; color: var(--faint); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 10px; }
  .tile { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; }
  .tile .n { font-family: var(--mono); font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .tile .l { font-size: 12.5px; color: var(--muted); margin-top: 2px; }

  .controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
  input[type="search"] { flex: 1 1 180px; min-width: 0; font-family: var(--sans); font-size: 14px; padding: 8px 11px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--ink); }
  input[type="search"]:focus-visible, .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .chip { font-family: var(--mono); font-size: 11.5px; font-weight: 500; padding: 6px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--muted); cursor: pointer; }
  .chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  :root[data-theme="dark"] .chip[aria-pressed="true"], :root:not([data-theme="light"]) .chip[aria-pressed="true"] { color: #0e1116; }

  ol.register { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  ol.register li { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 11px 2px; border-bottom: 1px solid var(--line); }
  ol.register .role { font-size: 14.5px; font-weight: 500; }
  ol.register .sub { font-family: var(--mono); font-size: 11.5px; color: var(--faint); grid-column: 1; word-break: break-word; }
  .pill { font-family: var(--mono); font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 3px 8px; border-radius: 3px; white-space: nowrap; align-self: start; }
  .pill.wait { background: var(--raised); color: var(--faint); border: 1px solid var(--line); }
  .pill.act { background: var(--warn-soft); color: var(--warn); }
  .pill.good { background: var(--go-soft); color: var(--go); }
  .pill.bad { background: var(--stop-soft); color: var(--stop); }
  .empty { padding: 24px 2px; color: var(--faint); font-size: 14px; }
  footer { margin-top: 36px; padding-top: 14px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--faint); }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>

<div class="wrap">
  <header class="masthead">
    <h1>Bewerbungsregister</h1>
    <div class="built" id="built"></div>
  </header>

  <div class="notice" id="freshness"></div>

  <section>
    <div class="eyebrow">Appointments <span class="count" id="apptCount"></span></div>
    <div class="stack" id="appts"></div>
  </section>

  <section>
    <div class="eyebrow">Only you can do these <span class="count" id="taskCount"></span></div>
    <div class="stack" id="tasks"></div>
  </section>

  <section>
    <div class="eyebrow">Where it stands</div>
    <div class="tiles" id="tiles"></div>
  </section>

  <section>
    <div class="eyebrow">Register <span class="count" id="regCount"></span></div>
    <div class="controls">
      <input type="search" id="q" placeholder="Search employer or role" aria-label="Search applications">
      <button class="chip" id="f-all" data-filter="all" aria-pressed="true">all</button>
      <button class="chip" id="f-act" data-filter="act" aria-pressed="false">needs you</button>
      <button class="chip" id="f-wait" data-filter="wait" aria-pressed="false">awaiting</button>
      <button class="chip" id="f-closed" data-filter="closed" aria-pressed="false">closed</button>
    </div>
    <ol class="register" id="rows"></ol>
  </section>

  <footer id="foot"></footer>
</div>

<script>
const L = ${DATA};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const day = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—';
const TODAY = new Date().toISOString().slice(0, 10);

$('built').textContent = 'built ' + new Date(L.builtAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

$('freshness').innerHTML = L.totals.repliesSeen === 0
  ? '<div><strong>Reply history unavailable.</strong> Gmail access expired, so what employers wrote cannot be read right now. Applications, drafts and appointments below are complete; reply status is inferred from the drafts. Run <code>node check-applied.mjs --setup</code>, then rebuild.</div>'
  : '<div><strong>' + L.totals.repliesSeen + ' replies on file.</strong> Rebuild after each inbox check to refresh.</div>';

// ── appointments ──────────────────────────────────────────────────────────────
const appts = (L.appointments || []).slice().sort((a, b) => String(b.when).localeCompare(String(a.when)));
$('apptCount').textContent = appts.length;
$('appts').innerHTML = appts.map((a) => {
  const d = a.when ? new Date(a.when) : null;
  const isToday = a.when && a.when.slice(0, 10) === TODAY;
  const isPast = d && d < new Date() && !isToday;
  const when = d
    ? '<div class="when">' + d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }) + '<br>' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</div>'
    : '<div class="when tbd">no date<br>agreed</div>';
  return '<article class="appt' + (isToday ? ' today' : isPast ? ' past' : '') + '">' + when +
    '<div class="co">' + esc(a.company) + (isToday ? ' — today' : '') + '</div>' +
    '<div class="meta">' + esc(a.what) + '<br>' + esc(a.where) +
    (a.contact ? '<br>' + esc(a.contact) + (a.phone ? ' · ' + esc(a.phone) : '') : '') + '</div>' +
    (a.status || a.note ? '<div class="note">' + esc([a.status, a.note].filter(Boolean).join(' — ')) + '</div>' : '') +
    '</article>';
}).join('') || '<div class="empty">No appointments recorded.</div>';

// ── things only he can do ─────────────────────────────────────────────────────
const drafts = L.applications.filter((r) => r.draftExists);
const tasks = (L.actions || []).map((a) =>
  '<div class="task"><span class="who">' + esc(a.employer) + '</span>' +
  '<span class="what">' + esc(a.what) + '</span>' +
  '<a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.url) + '</a>' +
  '<span class="why">' + esc(a.why) + '</span></div>'
).concat(drafts.length
  ? ['<div class="task"><span class="who">' + drafts.length + ' reply drafts waiting in Gmail</span>' +
     '<span class="what">Written and sitting in the employer\\'s own thread — they only go out when you press send.</span>' +
     '<span class="why">' + esc(drafts.slice(0, 6).map((d) => d.to).join(', ')) + (drafts.length > 6 ? ' and ' + (drafts.length - 6) + ' more' : '') + '</span></div>']
  : []);
$('taskCount').textContent = tasks.length;
$('tasks').innerHTML = tasks.join('') || '<div class="empty">Nothing waiting on you.</div>';

// ── totals ────────────────────────────────────────────────────────────────────
const t = L.totals;
$('tiles').innerHTML = [
  [t.applications, 'applications sent'],
  [t.employers, 'distinct employers'],
  [t.draftsWaiting, 'replies drafted'],
  [(L.actions || []).length, 'actions on you'],
].map(([n, l]) => '<div class="tile"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>').join('');

// ── register ──────────────────────────────────────────────────────────────────
const CLOSED = new Set(['rejected', 'undeliverable']);
const klass = (r) => CLOSED.has(r.status) ? 'bad' : r.needsYou ? 'act' : r.status === 'awaiting reply' ? 'wait' : 'good';
let filter = 'all', query = '';

function draw() {
  const q = query.trim().toLowerCase();
  const list = L.applications.filter((r) => {
    if (q && !(r.role + ' ' + r.to + ' ' + r.channel).toLowerCase().includes(q)) return false;
    if (filter === 'act') return Boolean(r.needsYou);
    if (filter === 'wait') return r.status === 'awaiting reply';
    if (filter === 'closed') return CLOSED.has(r.status);
    return true;
  });
  $('regCount').textContent = list.length === L.applications.length ? list.length : list.length + ' of ' + L.applications.length;
  $('rows').innerHTML = list.map((r) =>
    '<li><span class="role">' + esc(r.role) + '</span>' +
    '<span class="pill ' + klass(r) + '">' + esc(r.needsYou || r.status) + '</span>' +
    '<span class="sub">' + day(r.sentAt) + ' · ' + esc(r.channel) + ' · ' + esc(r.to) + '</span></li>'
  ).join('') || '<div class="empty">Nothing matches that.</div>';
}

$('q').addEventListener('input', (e) => { query = e.target.value; draw(); });
for (const b of document.querySelectorAll('.chip')) {
  b.addEventListener('click', () => {
    filter = b.dataset.filter;
    for (const o of document.querySelectorAll('.chip')) o.setAttribute('aria-pressed', String(o === b));
    draw();
  });
}
draw();

$('foot').textContent = 'Rebuild with: node tracker/build-tracker.mjs && node tracker/build-dashboard.mjs — then republish.';
</script>
`;

writeFileSync(join(HERE, 'dashboard.html'), html, 'utf8');
console.log(`dashboard written — ${ledger.applications.length} applications, ${(ledger.appointments || []).length} appointments, ${(ledger.actions || []).length} actions`);
