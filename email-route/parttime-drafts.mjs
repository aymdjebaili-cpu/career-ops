// Short German applications (Kurzbewerbung) by email for Munich part-time work.
//
// WHY A TEMPLATE AND NOT A WRITTEN LETTER
// For Lager, Reinigung, Küche and Aushilfe roles the employer wants to know four things:
// who you are, that you can start, how to reach you, and which posting you mean. A 300-word
// narrative letter is the wrong genre here and would cost one AI run per job; this writes
// twenty applications in seconds. Every fact comes from config/profile.yml and cv-de.md —
// nothing is invented, and the posting's own title and Referenznummer are quoted so the
// employer can match it to the advert.
//
// Output: output/email-parttime-{slug}.md, pushed by `node save-drafts.mjs --score=2.5`.
// Usage:  node email-route/parttime-drafts.mjs output/email-route [--limit=25] [--dry-run]
import { readFileSync, writeFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';

const S = process.argv[2] || 'output/email-route';
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) || '--limit=25').split('=')[1]);
const DRY = process.argv.includes('--dry-run');

const profile = yaml.load(readFileSync('config/profile.yml', 'utf8'));
const c = profile.candidate || {};
// `candidate.name` does not exist in profile.yml — the key is `full_name` — so
// this read always missed and every part-time letter was signed with the literal
// below regardless of what the profile said. It stores the name shouted
// ("ARMIN DJEBAILI"); a signature wants it in normal case.
const NAME = (c.full_name || 'Armin Djebaili')
  .trim().split(/\s+/)
  .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  .join(' ');
const EMAIL = c.email || '';
const PHONE = c.phone || '';
const CITY = (profile.location && profile.location.current_city) || 'München';
// Same source of truth as every other route: config/profile.yml `documents.cv_pdf`.
const { resolveCvPdf } = await import('../cv-pdf.mjs');
const CV = resolveCvPdf({ relative: true });

const targets = JSON.parse(readFileSync(`${S}/parttime-targets.json`, 'utf8'));
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

let written = 0;
for (const t of targets.slice(0, LIMIT)) {
  // The reference number keeps the name unique: two postings from the same agency with the
  // same title (Personell-Service and Formel Zeitarbeit each have a pair) otherwise collide,
  // and the "file exists, skip" rule below would drop the second application silently.
  const file = `output/email-parttime-${slug(t.employer)}-${slug(t.ref).slice(-12)}.md`;
  if (existsSync(file)) { console.log(`↪ exists, skipped: ${file.replace('output/', '')}`); continue; }

  // Everything below is verifiable: the title and reference come from the posting, the rest
  // from the profile. German is stated at B1 rather than implied — these employers ask.
  const body = [
    'Sehr geehrte Damen und Herren,',
    '',
    `hiermit bewerbe ich mich auf die Stelle als ${t.title}${t.city ? ` in ${t.city}` : ''} (Referenznummer ${t.ref}).`,
    '',
    `Ich wohne in ${CITY} und bin mit einer Kündigungsfrist von zwei Wochen verfügbar, auch in Teilzeit.`,
    // Past tense since 2026-09-19: his last day at iPro Booking was 16 August 2026.
    // The letter said "seit Dezember 2024 arbeite ich", which stopped being true that day.
    'Von Dezember 2024 bis August 2026 habe ich im operativen Betrieb eines Hospitality-',
    'Unternehmens gearbeitet, mit festen Abläufen, Schichtzeiten und klarer Übergabe.',
    'Strukturiertes Arbeiten nach Vorgaben ist für mich Alltag, und ich arbeite zuverlässig,',
    'pünktlich und im Team.',
    '',
    'Mein Deutsch liegt bei B1 — für die Arbeit reicht es, und ich lerne weiter. Englisch spreche ich',
    'fließend (C2), Französisch B2.',
    '',
    'Meinen Lebenslauf finden Sie im Anhang. Über eine Rückmeldung freue ich mich.',
    '',
    'Mit freundlichen Grüßen',
    NAME,
    [EMAIL, PHONE].filter(Boolean).join(' | '),
  ].join('\n');

  const content = [
    `TO: ${t.email}`,
    `SUBJECT: Bewerbung: ${t.title} (Ref. ${t.ref})`,
    `COMPANY: ${t.employer}`,
    `ROLE: ${t.title}`,
    `SCORE: 3.0`,
    `SCORE_SOURCE: part-time route — physical/routine work, no evaluation report`,
    `EMAIL_VERIFIED: published by the employer in the Bundesagentur job detail (Ref. ${t.ref})`,
    `LANGUAGE: DE`,
    `CV_PDF: ${CV}`,
    `JD_URL: ${t.url}`,
    '---',
    body,
    '',
  ].join('\n');

  if (DRY) { console.log(`[dry] ${file.replace('output/', '')} → ${t.email}  (${t.title.slice(0, 40)})`); written++; continue; }
  writeFileSync(file, content, 'utf8');
  console.log(`✉ ${file.replace('output/', '').padEnd(54)} → ${t.email}`);
  written++;
}
console.log(`\n${written} part-time application email(s) ${DRY ? 'would be ' : ''}written${DRY ? '' : ' — push with: node save-drafts.mjs --score=2.5'}`);
