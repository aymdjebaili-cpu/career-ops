// Batch 1: compact, honest reports for the email-route jobs whose postings require
// German above B1. Aimene chose on 2026-09-15 to apply to them by email anyway.
// The report is what generate-cover-letter.mjs and daily-run.mjs step 5 read, so it
// carries the verified application address FIRST (parseReportHeader takes the first
// application-type address in the file) and masks every other address in the JD.
// Run from the project dir: node write-light-reports.mjs <scratchpad> [--dry-run]
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';

const P = 'file:///C:/Users/PC/Downloads/career-ops-main/career-ops-main/';
const { prefilter } = await import(P + 'prefilter-core.mjs');

const S = process.argv[2];
const DRY = process.argv.includes('--dry-run');
const DATE = new Date().toISOString().slice(0, 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PIPELINE = 'data/pipeline.md';

const slugify = (s) => (s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const htmlToText = (html) => html
  .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();

async function fetchWithTimeout(url, opts = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 20_000);
  try { return await fetch(url, { ...opts, signal: c.signal }); } finally { clearTimeout(t); }
}
async function fetchJob(url) {
  const m = url.match(/jobsuche\/jobdetail\/([^/?#]+)/);
  if (m) {
    try {
      const id = Buffer.from(decodeURIComponent(m[1])).toString('base64');
      const res = await fetchWithTimeout(`https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/${id}`,
        { headers: { 'X-API-Key': 'jobboerse-jobsuche', Accept: 'application/json', 'User-Agent': UA } });
      if (res.ok) {
        const j = await res.json();
        const strings = [];
        const walk = (v) => {
          if (typeof v === 'string' && v.trim().length > 2 && !/^https?:|^\d{4}-\d\d-\d\d/.test(v)) strings.push(v.trim());
          else if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(j);
        const text = strings.join('\n');
        if (text.length > 400) return text;
      }
    } catch { /* fall through */ }
  }
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } });
    return res.ok ? htmlToText(await res.text()) : null;
  } catch { return null; }
}

// Language of the posting, from function words. Letter language follows the JD.
function detectLanguage(text) {
  const words = String(text).toLowerCase().match(/[a-zäöüß]+/g) || [];
  const de = new Set(['und', 'der', 'die', 'das', 'mit', 'für', 'wir', 'sie', 'ist', 'ihre', 'bei', 'eine', 'auf', 'zu', 'von', 'dich', 'du', 'unser', 'unsere']);
  const en = new Set(['and', 'the', 'with', 'for', 'we', 'you', 'is', 'your', 'our', 'to', 'of', 'in', 'will', 'are', 'a']);
  let d = 0, e = 0;
  for (const w of words) { if (de.has(w)) d++; if (en.has(w)) e++; }
  return d > e ? 'DE' : 'EN';
}

// Cut the page down to the posting itself where possible, and never let a second
// address reach the report body ahead of, or instead of, the verified one.
function excerpt(text, email) {
  let t = String(text || '');
  const anchors = /(ihre aufgaben|deine aufgaben|aufgaben|your tasks|responsibilities|what you.?ll do|about the role|das bringst du mit|ihr profil|dein profil|requirements|qualifications)/i;
  const at = t.search(anchors);
  if (at > 200) t = t.slice(Math.max(0, at - 400));
  t = t.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (m) => (m.toLowerCase() === email.toLowerCase() ? m : '[address removed]'));
  return t.slice(0, 2800);
}

function nextReportNumber() {
  const n = readdirSync('reports').map(f => +(f.match(/^(\d{3})-/) || [])[1]).filter(Number.isFinite);
  return String(Math.max(0, ...n) + 1).padStart(3, '0');
}

function markPipeline(url, note) {
  if (!existsSync(PIPELINE)) return false;
  const lines = readFileSync(PIPELINE, 'utf8').split('\n');
  const idx = lines.findIndex(l => /^-\s*\[\s*\]/.test(l) && l.includes(url));
  if (idx === -1) return false;
  const m = lines[idx].match(/^-\s*\[\s*\]\s*(\S+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|\s*([^|]+?)\s*)?$/);
  const entry = `- [x] ${url} | ${m ? m[2].trim() : '?'} | ${m ? m[3].trim() : '?'} | Evaluated | - | ❌ | - | ${note}`;
  lines.splice(idx, 1);
  const procIdx = lines.findIndex(l => /^##\s+Procesadas/i.test(l));
  if (procIdx === -1) lines.push('', '## Procesadas', '', entry); else lines.splice(procIdx + 1, 0, entry);
  writeFileSync(PIPELINE, lines.join('\n'), 'utf8');
  return true;
}

const jobs = JSON.parse(readFileSync(`${S}/email-hits.json`, 'utf8')).filter(r => r.email && !r.report);
const written = [];
for (const job of jobs) {
  const company = job.company.replace(/\s+/g, ' ').trim();
  const role = job.role.replace(/â€“/g, '–').replace(/^[^:]{2,40}:\s+(?=\S)/, (p) => (company && p.toLowerCase().startsWith(company.toLowerCase().slice(0, 6)) ? '' : p)).trim();
  const jd = await fetchJob(job.url);
  if (!jd || jd.length < 400) { console.log(`SKIP ${company}: no readable job description`); continue; }
  const verdict = prefilter({ title: role, company, description: jd });
  const language = detectLanguage(jd);
  const gap = verdict.skip ? verdict.reason : 'German requirement not stated explicitly';
  const num = DRY ? 'NNN' : nextReportNumber();
  const file = `${num}-${slugify(company)}-${DATE}.md`;

  const report = `# Evaluation: ${company} — ${role}

**Company:** ${company}
**Role:** ${role}
**Date:** ${DATE}
**Score:** ${Number(job.fit).toFixed(1)}/5
**URL:** ${job.url}
**PDF:** ❌
**Language:** ${language}
**Legitimacy:** Proceed with Caution

**Application address (published by the company):** ${job.email}
**Address source:** ${job.source}

---

## A) Role Summary

| Dimension | Finding |
|-----------|---------|
| **Route** | Email application — the employer publishes an application address |
| **Title fit** | ${Number(job.fit).toFixed(1)}/5 on the role title (${(job.reasons || []).join(', ') || 'operations-adjacent'}) |
| **Posting language** | ${language === 'DE' ? 'German' : 'English'} |
| **Language requirement** | ${gap} |
| **Decision** | Aimene chose on ${DATE} to apply by email despite the German requirement |

This is a compact report written for the email route, not a full A–G evaluation. The score above is
the title fit only. The posting's German requirement is above the candidate's level (B1, see cv-de.md);
the automatic evaluator would have skipped it for that reason alone.

---

## B) What the posting asks for (verbatim excerpt)

${excerpt(jd, job.email)}

---

## C) Honest gaps for the letter

- **German:** the posting asks for ${gap.replace(/^JD (demands|is written in) /i, '').replace(/^needs /i, '')}. The candidate's German is B1.
  Say this plainly and briefly; do not overstate it, and do not hide it.
- Everything else must come from cv.md / cv-de.md only. No invented numbers, tenure or tools.

---

## G) Posting legitimacy and application channel

- The application address above is printed by the employer (source recorded above), not guessed.
- Posting reached via: ${job.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}${job.walled ? ' (portal requires a login; email is the practical route)' : ''}.
`;

  const tsv = [num, DATE, company, role, 'Evaluated', `${Number(job.fit).toFixed(1)}/5`, '❌', `[${num}](reports/${file})`, 'email route; posting requires German above B1 (applying by user decision)'].join('\t');
  if (DRY) {
    console.log(`[dry] ${file} | ${language} | ${job.email} | gap: ${gap} | JD ${jd.length} chars`);
  } else {
    writeFileSync(`reports/${file}`, report, 'utf8');
    mkdirSync('batch/tracker-additions', { recursive: true });
    writeFileSync(`batch/tracker-additions/${num}-${slugify(company)}.tsv`, tsv + '\n', 'utf8');
    const moved = markPipeline(job.url, `email-route light report ${num} (${DATE})`);
    console.log(`wrote reports/${file} | ${language} | ${job.email} | pipeline line moved: ${moved}`);
  }
  written.push({ num, file, company, role, language, email: job.email, url: job.url });
}
writeFileSync(`${S}/light-reports.json`, JSON.stringify(written, null, 1));
console.log(`\n${written.length} report(s) ${DRY ? 'would be ' : ''}written`);
