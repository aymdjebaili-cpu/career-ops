#!/usr/bin/env node
/**
 * tailor-cv.mjs — per-application CV, built by REORDERING cv.md. Never by rewriting it.
 *
 * WHY REORDER AND NOTHING ELSE
 * A recruiter reads the first bullet or two under each role and the first line of
 * the skills list. Which bullet sits there is worth a lot; the words in it are not
 * ours to change. Letting a model re-word a CV against a job description is how a
 * CV starts claiming things the CV never said — and this project has already sent
 * one letter claiming "drei Jahre" against a CV showing twenty months. So the
 * tailoring here is purely an ordering operation:
 *
 *   - bullets move within their own block; their text is copied byte-for-byte
 *   - roles never move (a CV that reorders jobs reads as concealment)
 *   - nothing is dropped, so every fact still ships
 *   - the job description influences ORDER ONLY; not one word comes from it
 *
 * The result is provably the same document, arranged so the relevant evidence is
 * what gets read first. tailorCvMarkdown() asserts the multiset of lines is
 * unchanged and throws rather than write a CV that gained or lost anything.
 *
 * Usage:
 *   node tailor-cv.mjs --report=470                 # score against that report
 *   node tailor-cv.mjs --role="Ops Manager" --company="X"
 *   node tailor-cv.mjs --report=470 --explain       # show the reordering, write nothing
 *   node tailor-cv.mjs --report=470 --pdf           # also render html + pdf
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const CV_FILE = join(PROJECT_DIR, 'cv.md');
const REPORTS_DIR = join(PROJECT_DIR, 'reports');
const OUT_DIR = join(PROJECT_DIR, 'output', 'cv-tailored');

// Words that appear in every posting and therefore separate nothing.
const STOP = new Set(`
a an and are as at be by for from has have in is it its of on or that the to with your you we our us
able about across all also any been being both can could do does each else etc get give great high
into just like make more most much need needs new not now off only other over same so some such than
then there these they this those through under up use used using very via want well what when where which
while who will within work working years year role roles job jobs team teams company companies
und oder der die das den dem des ein eine einer einem einen als auch aus bei bis fuer für hat haben ist sind
im in mit nach nicht sie sich von vor wir zu zum zur ueber über unser unsere ihre ihr wird werden kann koennen
können sowie durch dass wenn was mehr viele alle diese dieser dieses gute guten stelle stellen aufgaben profil
`.trim().split(/\s+/));

/**
 * Crude stem: the first five characters.
 *
 * Without it the matching is literal, and literal matching is useless here — a
 * posting saying "finance" and "analyst" scored zero against a bullet saying
 * "financial" and "analysis", so the finance-analyst CV led with team
 * management instead of the €1.59M receivables recovery. Five characters folds
 * finance/financial, analyst/analysis/analytics, report/reporting,
 * manage/management, and is short enough to bridge English and German stems
 * (analyse/Analyse, operation/Operationen) without a stemmer per language.
 */
const stem = (w) => (w.length > 5 ? w.slice(0, 5) : w);

const words = (s) => String(s ?? '')
  .toLowerCase()
  .split(/[^a-zà-ÿ0-9+]+/i)
  .filter(w => w.length >= 3 && !STOP.has(w))
  .map(stem);

/**
 * Terms worth matching on, weighted by how often the posting repeats them.
 * A word the posting uses five times is what the posting is about.
 */
export function targetTerms({ role = '', company = '', jdText = '' }) {
  const weights = new Map();
  const add = (text, factor) => {
    for (const w of words(text)) weights.set(w, (weights.get(w) ?? 0) + factor);
  };
  // The title is the densest statement of what the job is, so it counts heavily.
  add(role, 4);
  add(jdText, 1);
  // The employer's own name says nothing about the work.
  for (const w of words(company)) weights.delete(w);
  return weights;
}

/**
 * How much a term distinguishes one bullet from another, measured across the CV
 * itself (classic inverse document frequency).
 *
 * Without this, the words the CV repeats everywhere — "operations", "tourism" —
 * decide the ranking, because the postings repeat them too. The first version
 * put "Recruited, interviewed, and managed a team of four" at the top of a
 * finance-analyst CV for exactly that reason, and led the Tax Inspector role
 * with "Chose to transition back to the private sector". A term common to most
 * bullets cannot separate them; a rare one ("receivables", "econometrics") can.
 */
function bulletIdf(bullets) {
  const df = new Map();
  for (const b of bullets) {
    for (const w of new Set(words(b))) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const n = Math.max(1, bullets.length);
  return (w) => Math.log(n / (1 + (df.get(w) ?? 0))) + 1;
}

/**
 * Relevance of one bullet. Ties keep the CV's original order.
 *
 * Normalised by length: a long bullet should not win by containing more words,
 * only by containing better ones.
 */
export function scoreBullet(bullet, weights, idf = () => 1) {
  const terms = new Set(words(bullet));
  if (!terms.size) return 0;
  let score = 0;
  for (const w of terms) score += (weights.get(w) ?? 0) * idf(w);
  score /= Math.sqrt(terms.size);
  // Quantified evidence beats the same claim unquantified, and this CV's numbers
  // are its strongest asset — but it stays a tiebreaker, never a reordering on
  // its own.
  if (/\d/.test(bullet)) score += 0.75;
  return score;
}

const BULLET = /^\s*-\s+\S/;
const HEADING = /^#{2,4}\s+/;

/**
 * Reorder the bullets of every bullet block, leaving every other line untouched.
 * A block is a run of consecutive bullet lines, so bullets can never cross out of
 * one role and into another.
 */
export function tailorCvMarkdown(cvRaw, context) {
  const weights = targetTerms(context);
  const lines = cvRaw.split('\n');
  const out = [...lines];
  const moves = [];
  const idf = bulletIdf(lines.filter(l => BULLET.test(l)));

  let section = '';
  let i = 0;
  while (i < lines.length) {
    if (HEADING.test(lines[i])) section = lines[i].replace(/^#+\s*/, '').replace(/\*/g, '').trim();
    if (!BULLET.test(lines[i])) { i++; continue; }

    let end = i;
    while (end + 1 < lines.length && BULLET.test(lines[end + 1])) end++;

    // A single bullet has no order to change.
    if (end > i) {
      const block = lines.slice(i, end + 1);
      const scored = block.map((text, idx) => ({ text, idx, score: scoreBullet(text, weights, idf) }));

      // Reorder on evidence, not on noise. Scores are quantised into bands, and
      // bullets in the same band keep the CV's own order. Without this, a block
      // where every bullet is irrelevant still gets shuffled — the Tax Inspector
      // role was being led by "Chose to transition back to the private sector"
      // on a score of 0.7 against 0.0, which is a rounding error deciding what a
      // recruiter reads first.
      const top = Math.max(...scored.map(s => s.score));
      const band = Math.max(0.75, top * 0.15);
      // Below this, nothing in the block is really about this job, and the CV's
      // own order — which puts the strongest achievement first — beats anything
      // a weak signal would pick. This is what stops "Chose to transition back
      // to the private sector" leading a role just because it out-scored a 0.
      const ranked = top < 1.5
        ? scored.map(s => ({ ...s, rank: 0 }))
        : [...scored]
          .map(s => ({ ...s, rank: Math.round(s.score / band) }))
          .sort((a, b) => (b.rank - a.rank) || (a.idx - b.idx));

      if (ranked.some((r, pos) => r.idx !== pos)) {
        moves.push({
          section,
          order: ranked.map(r => r.idx),
          scores: ranked.map(r => Number(r.score.toFixed(1))),
          top: ranked[0].text.replace(/^\s*-\s*/, '').slice(0, 70),
        });
      }
      ranked.forEach((r, pos) => { out[i + pos] = r.text; });
    }
    i = end + 1;
  }

  // Same lines, same count — only the reading order differs. If that is not true,
  // something rewrote content and the file must not be written.
  const fingerprint = (a) => JSON.stringify([...a].sort());
  if (fingerprint(lines) !== fingerprint(out)) {
    throw new Error('tailoring altered CV content — refusing to write');
  }

  return { markdown: out.join('\n'), moves };
}

// ─────────────────────────────────────────────
// Report lookup
// ─────────────────────────────────────────────
export function reportContext(num) {
  const file = readdirSync(REPORTS_DIR).find(f => f.startsWith(`${num}-`) && f.endsWith('.md'));
  if (!file) throw new Error(`no report found for ${num}`);
  const text = readFileSync(join(REPORTS_DIR, file), 'utf8');
  // Reports are written in the language of the posting, so the header keys vary:
  // Role/Rolle/Puesto/Poste. Missing the German ones made every DE report look
  // like it had no role at all.
  const grab = (...keys) => {
    for (const k of keys) {
      const m = text.match(new RegExp(`\\*\\*${k}:\\*\\*\\s*(.+)`, 'i'));
      if (m?.[1]?.trim()) return m[1].trim();
    }
    return '';
  };
  // Only the parts of the report that describe the JOB. The rest is our own
  // analysis OF THE CANDIDATE — gaps, comp benchmarks, interview prep, a "Top 5
  // CV changes" list — and feeding that back in scores his CV against a summary
  // of itself, which is how "managed a team of four" ended up leading a
  // finance-analyst CV.
  const JOB_SECTION = new RegExp(
    // Only the role summary. The "Anforderungen → CV-Mapping" section pairs each
    // requirement with evidence FROM HIS CV, so including it fed his own
    // employer names (ipro, safinest, booking) back in as if the employer had
    // asked for them.
    String.raw`^#{2,4}[^\n]*(?:Rollen-Zusammenfassung|Role Summary|Resumen del Puesto|Job Description)[^\n]*$([\s\S]*?)(?=^#{2,4}|$(?![\s\S]))`,
    'gmi',
  );
  const jobSections = [...text.matchAll(JOB_SECTION)].map(m => m[1]).join('\n');

  return {
    role: grab('Role', 'Rolle', 'Puesto', 'Poste', 'Position'),
    company: grab('Company', 'Unternehmen', 'Empresa', 'Entreprise'),
    jdText: jobSections.trim() || text,
    slug: file.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, ''),
    num,
  };
}

/**
 * Write the tailored markdown and, with `pdf`, render it through the normal CV
 * pipeline (render-cv-html.mjs → generate-pdf.mjs) so it is identical to the
 * standard CV in every respect except bullet order.
 */
export function writeTailoredCv(context, { pdf = false } = {}) {
  const cvRaw = readFileSync(CV_FILE, 'utf8');
  const { markdown, moves } = tailorCvMarkdown(cvRaw, context);
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const base = join(OUT_DIR, `${context.num ?? 'cv'}-${context.slug ?? 'tailored'}`);
  const mdPath = `${base}.md`;
  writeFileSync(mdPath, markdown, 'utf8');
  if (!pdf) return { mdPath, pdfPath: null, moves };

  const htmlPath = `${base}.html`;
  const pdfPath = `${base}.pdf`;
  const run = (args) => spawnSync('node', args, { cwd: PROJECT_DIR, encoding: 'utf8', shell: true });

  const r1 = run(['render-cv-html.mjs', `"${mdPath}"`, `"${htmlPath}"`]);
  if (r1.status !== 0) throw new Error(`render-cv-html failed: ${(r1.stderr || r1.stdout || '').trim().slice(0, 200)}`);
  const r2 = run(['generate-pdf.mjs', `"${htmlPath}"`, `"${pdfPath}"`]);
  if (r2.status !== 0) throw new Error(`generate-pdf failed: ${(r2.stderr || r2.stdout || '').trim().slice(0, 200)}`);

  return { mdPath, pdfPath, moves };
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (n) => args.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
  const num = arg('report');

  const context = num
    ? reportContext(num)
    : { role: arg('role') ?? '', company: arg('company') ?? '', jdText: arg('role') ?? '', slug: 'manual' };

  if (!context.role) {
    console.error('Usage: node tailor-cv.mjs --report=470   |   --role="..." [--company="..."]');
    process.exit(1);
  }

  if (args.includes('--explain')) {
    const { moves } = tailorCvMarkdown(readFileSync(CV_FILE, 'utf8'), context);
    console.log(`\nTailoring CV for: ${context.role}${context.company ? ` @ ${context.company}` : ''}`);
    if (!moves.length) console.log('  no reordering — the CV already leads with the most relevant evidence');
    for (const m of moves) {
      console.log(`\n  ${m.section}`);
      console.log(`    order ${m.order.join(' -> ')}   scores ${m.scores.join(', ')}`);
      console.log(`    now leads: ${m.top}...`);
    }
    console.log('\n  (nothing written — drop --explain to write the file)');
  } else {
    const { mdPath, pdfPath, moves } = writeTailoredCv(context, { pdf: args.includes('--pdf') });
    console.log(`✅ tailored CV: ${mdPath}${pdfPath ? `\n✅ PDF: ${pdfPath}` : ''}`);
    console.log(`   ${moves.length} block(s) reordered, 0 words changed`);
  }
}
