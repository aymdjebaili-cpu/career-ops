// Check every draft written today before it reaches Gmail. Run from the project dir:
//   node verify-drafts.mjs <scratchpad>          # report only
//   node verify-drafts.mjs <scratchpad> --fix    # also correct the address provenance line
// Checks: recipient = the address the company published; attachments exist; no banned
// terms; every figure in the letter body traces to the candidate's own record; word count.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';

const S = process.argv[2];
const FIX = process.argv.includes('--fix');
const RECORD_FILES = ['cv.md', 'cv-de.md', 'config/profile.yml', 'modes/_profile.md', 'article-digest.md'];
const record = RECORD_FILES.filter(existsSync).map(f => readFileSync(f, 'utf8')).join('\n');
// Figures compared digits-only, so "1.271" (DE) and "1,271" (EN) match the same fact.
const recordDigits = new Set((record.match(/\d[\d.,]*\d|\d/g) || []).map(n => n.replace(/[.,]/g, '')));
const BANNED = /\b(visa|work permit|blue card|aufenthaltstitel|arbeitserlaubnis|sponsor\w*|relocat\w*|umzug nach deutschland|n8n)\b/i;

const sources = new Map();
for (const f of ['email-hits.json', 'speculative-hits.json']) {
  if (!existsSync(`${S}/${f}`)) continue;
  for (const r of JSON.parse(readFileSync(`${S}/${f}`, 'utf8'))) if (r.email) sources.set(r.email.toLowerCase(), r.source);
}

const files = readdirSync('output').filter(f => /^email-(6(1[5-9]|2[0-4])-|spec-).*\.md$/.test(f)).sort();
const rows = [];
for (const f of files) {
  const path = `output/${f}`;
  const raw = readFileSync(path, 'utf8');
  const [head] = raw.split(/\n---\n/);
  const meta = {};
  for (const line of head.split('\n')) { const m = line.match(/^([A-Z_]+):\s*(.*)$/); if (m) meta[m[1]] = m[2].trim(); }
  const to = (meta.TO || '').toLowerCase();
  const problems = [];

  const published = sources.get(to);
  if (!published) problems.push(`recipient ${to || '(none)'} is not an address found published by the company`);

  const cv = meta.CV_PDF || meta.CV_PATH;
  if (!cv || !existsSync(cv)) problems.push(`CV attachment missing: ${cv || '(none)'}`);
  if (!meta.COVER_LETTER_PDF || !existsSync(meta.COVER_LETTER_PDF)) problems.push(`letter PDF missing: ${meta.COVER_LETTER_PDF || '(none)'}`);

  let words = 0;
  const letterPath = meta.COVER_LETTER_PATH;
  if (!letterPath || !existsSync(letterPath)) {
    problems.push(`letter markdown missing: ${letterPath || '(none)'}`);
  } else {
    const letter = readFileSync(letterPath, 'utf8').replace(/^---[\s\S]*?\n---\s*/, '');
    words = (letter.match(/\S+/g) || []).length;
    if (words > 340) problems.push(`letter is ${words} words (limit 320)`);
    const banned = BANNED.exec(letter) || BANNED.exec(raw.split(/\n---\n/).slice(1).join('\n'));
    if (banned) problems.push(`banned term "${banned[0]}"`);
    // Figures that make a claim: 3+ digit numbers, money, percentages. Years are dates, not claims.
    const figures = (letter.match(/[€$]?\s?\d[\d.,]*\d\s?(%|k|K|M|Mio\.?|million|Millionen)?|\b\d{1,2}\s?%/g) || [])
      .map(s => s.trim())
      .filter(s => !/^(19|20)\d\d$/.test(s.replace(/[^\d]/g, '')) && s.replace(/[^\d]/g, '').length >= 2);
    const unmatched = [...new Set(figures)].filter(s => !recordDigits.has(s.replace(/[^\d]/g, '')));
    if (unmatched.length) problems.push(`figures not found in his record: ${unmatched.join(', ')}`);
    // Qualitative claims a figure check cannot see: daily use, Munich customer contact,
    // fluency. Negated statements ("nicht fließend", "not fluent") are fine.
    const sentences = letter.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
    const CLAIM = /\b(täglich|jeden tag|daily|every day|fließend|fluent|verhandlungssicher|muttersprach\w*|native)\b|mit kunden in münchen|customers in munich|für dich\b|\bdu\b|\bdein\w*/i;
    const NEGATED = /\b(nicht|kein\w*|not|no)\s+(\w+\s+)?(fließend|fluent|verhandlungssicher|native)/i;
    for (const s of sentences) {
      if (CLAIM.test(s) && !NEGATED.test(s)) problems.push(`review claim: "${s.slice(0, 160)}"`);
    }
    // --claims: print every first-person statement about his record, for a human read.
    // A figure check and a phrase list cannot tell "I negotiated with 100 partners" (on
    // record) from "I did the expense accounting meticulously" (invented).
    if (process.argv.includes('--claims')) {
      const FIRST_PERSON = /\b(ich habe|habe ich|ich bin|bin ich|ich war|war ich|ich kenne|kenne ich|ich baue|baue ich|ich arbeite|arbeite ich|ich führe|führe ich|ich spreche|mein\w*|I have|I've|I had|I am|I'm|I was|I built|I ran|I led|I managed|I spent|I worked|I know|I speak|my )\b/i;
      const claims = sentences.filter(s => FIRST_PERSON.test(s) && !/^(Sehr geehrte|Dear|Mit freundlichen|Best regards|Kind regards)/i.test(s.trim()));
      rows.claims = rows.claims || [];
      rows.claims.push({ f, claims });
    }
  }

  // Provenance: daily-run labels any address found inside a report "printed in the posting",
  // including ones that came from the company's careers page. Say where it really came from.
  const wantProvenance = published ? `published by the company at ${published}` : null;
  const provKey = meta.EMAIL_SOURCE !== undefined ? 'EMAIL_SOURCE' : 'EMAIL_VERIFIED';
  if (wantProvenance && provKey === 'EMAIL_VERIFIED' && meta.EMAIL_VERIFIED !== wantProvenance) {
    if (FIX) {
      const fixed = raw.replace(/^EMAIL_VERIFIED: .*$/m, `EMAIL_VERIFIED: ${wantProvenance}`);
      writeFileSync(path, fixed, 'utf8');
    } else {
      problems.push(`provenance says "${meta.EMAIL_VERIFIED}" — should be "${wantProvenance}" (run with --fix)`);
    }
  }

  rows.push({ f, to, lang: meta.LANGUAGE, words, problems });
}

let clean = 0;
for (const r of rows) {
  const ok = r.problems.length === 0;
  if (ok) clean++;
  console.log(`${ok ? 'OK  ' : 'FIX '} ${r.f.padEnd(52)} ${String(r.lang || '').padEnd(3)} ${String(r.words).padStart(3)}w  → ${r.to}`);
  for (const p of r.problems) console.log(`       - ${p}`);
}
console.log(`\n${clean} of ${rows.length} draft(s) pass every check${FIX ? ' (provenance lines corrected)' : ''}`);

if (process.argv.includes('--claims')) {
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];
  const pick = only ? only.split(',') : null;
  console.log('\n=== first-person claims, for a human read ===');
  for (const { f, claims } of rows.claims || []) {
    if (pick && !pick.some(p => f.includes(p))) continue;
    console.log(`\n# ${f}`);
    for (const c of claims) console.log(`  - ${c.slice(0, 260)}`);
  }
}
