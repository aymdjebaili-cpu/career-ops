#!/usr/bin/env node
/**
 * hospitality-drafts.mjs — one Initiativbewerbung per Munich hotel, hostel, guest house
 * or travel agency, written for the kind of business it is.
 *
 * TAILORING, AND ITS LIMIT
 * Aimene asked for "a designed tailored text telling each what they want to hear". What a
 * hotel wants to read and what a travel agency wants to read are genuinely different, and
 * both are said here — but only out of things that are TRUE. A hotel hears about shift
 * work, reliability and the languages he can use at the desk; an agency hears about the
 * travel agency he runs in Algiers and the booking, cancellation and OTA settlement work.
 * Neither hears that he has worked a hotel floor, because he has not. An invented claim is
 * found out at the interview and costs him the job he might have had.
 *
 * Every sentence traces to config/profile.yml, cv-de.md or a fact he has confirmed:
 * hospitality operations from December 2024 to 16 August 2026 for an employer abroad, his
 * own agency since May 2026, German B1 / English C2 / French B2, lives in Munich-Trudering,
 * two weeks' notice, no driving licence, degrees recognised by anabin as equivalent.
 * Arabic was removed from the CV on 2026-09-19 at his request, so the letters do not claim
 * it either — a letter that lists a language the attached Lebenslauf omits invites doubt.
 *
 * Usage:
 *   node email-route/hospitality-drafts.mjs output/email-route --limit=40
 *   node email-route/hospitality-drafts.mjs output/email-route --dry-run
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { resolveCvPdf } from '../cv-pdf.mjs';

const S = process.argv[2] || 'output/email-route';
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) || '--limit=40').split('=')[1]);
const DRY = process.argv.includes('--dry-run');

const profile = yaml.load(readFileSync('config/profile.yml', 'utf8'));
const c = profile.candidate || {};
// Was a bare literal, so it survived every profile edit. Reads the profile now.
const NAME = (c.full_name || 'Armin Djebaili')
  .trim().split(/\s+/)
  .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  .join(' ');
const EMAIL = c.email || '';
const PHONE = c.phone || '';
const CV = resolveCvPdf({ relative: true });

const targets = JSON.parse(readFileSync(`${S}/hospitality-targets.json`, 'utf8'));
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 44);

// A stable number per business, so the wording varies between employers but never between
// two runs for the same one — a business that gets a second letter would otherwise see a
// different story from the same person.
const pick = (name, arr) => {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return arr[h % arr.length];
};

// "Ihr Haus in Domagkstraße 26, München" is not how anyone writes German, and a street
// name needs a case-correct article ("in DER Domagkstraße", "AM Marienplatz") that cannot
// be derived reliably. The district is both safer and more natural, and it still shows the
// letter was written to this business and not to a list.
const where = (t) => {
  const d = (t.district || '').trim();
  if (d && d.toLowerCase() !== 'münchen' && d !== t.city) return `München-${d}`;
  const city = (t.city || '').trim();
  return city && city.toLowerCase() !== 'münchen' ? city : 'München';
};

function hotelLetter(t) {
  const opener = pick(t.name, [
    `ich suche eine feste Mitarbeit im Hotelbetrieb in München und schreibe Ihnen deshalb direkt.`,
    `ich möchte in München im Hotel arbeiten und bewerbe mich initiativ bei Ihnen.`,
    `ich suche Arbeit im Hotelbetrieb in München und wende mich direkt an Sie.`,
  ]);
  const roles = pick(t.name, [
    'Housekeeping, Frühstücksservice, Spülküche, Wäscherei oder Empfang',
    'Zimmerreinigung, Frühstück, Service oder Unterstützung an der Rezeption',
    'Housekeeping, Service, Frühstücksdienst oder allgemeine Aushilfe im Haus',
  ]);
  return [
    'Sehr geehrte Damen und Herren,',
    '',
    `${opener} Ihr Haus in ${where(t)} erreiche ich gut — ich wohne in München-Trudering.`,
    '',
    // Past tense: iPro Booking ended on 16 August 2026 (updated 2026-09-19).
    'Von Dezember 2024 bis August 2026 habe ich im operativen Betrieb eines Hospitality-',
    'Unternehmens gearbeitet: Buchungen, Gästeanfragen, Abstimmung mit Partnern, feste',
    'Abläufe und Schichtzeiten.',
    'Zusätzlich führe ich seit Mai 2026 ein eigenes Reisebüro in Algier. Im Hotel selbst habe',
    'ich noch nicht gearbeitet — ich bringe die Arbeitshaltung mit, nicht die Routine, und',
    'lerne die Abläufe schnell.',
    '',
    `Ich bin für jede Position offen: ${roles}.`,
    'Teilzeit, Vollzeit oder auf Abruf, auch früh, abends und am Wochenende. Kündigungsfrist: zwei Wochen.',
    '',
    'Deutsch spreche ich auf B1 und lerne weiter, Englisch fließend (C2), Französisch B2 —',
    'im Gästekontakt ist das oft nützlich.',
    '',
    'Meinen Lebenslauf finden Sie im Anhang. Auch wenn gerade nichts frei ist, freue ich mich',
    'über eine kurze Rückmeldung — gerne mit einem Hinweis, wann sich das ändert.',
    '',
    'Mit freundlichen Grüßen',
    NAME,
    [EMAIL, PHONE].filter(Boolean).join(' | '),
  ].join('\n');
}

function agencyLetter(t) {
  const opener = pick(t.name, [
    `ich suche eine Mitarbeit im Reisebüro in München und schreibe Ihnen deshalb direkt.`,
    `ich möchte in München im Reisevertrieb arbeiten und bewerbe mich initiativ bei Ihnen.`,
    `ich suche Arbeit in einem Münchner Reisebüro und wende mich direkt an Sie.`,
  ]);
  return [
    'Sehr geehrte Damen und Herren,',
    '',
    `${opener} Ihr Büro in ${where(t)} erreiche ich gut — ich wohne in München-Trudering.`,
    '',
    'Reisen ist nicht nur mein Wunschbereich, sondern meine tägliche Arbeit: Von Dezember 2024',
    'bis August 2026 habe ich im operativen Betrieb eines Hospitality-Wholesale-Unternehmens',
    'gearbeitet — Buchungen, Stornierungen, Abstimmung mit Veranstaltern und Online-Portalen,',
    'Abrechnung und Kundenanfragen. Seit Mai 2026 führe ich ein eigenes Reisebüro in Algier und',
    'arbeite dort mit einem Netz von über 100 Agenturen zusammen.',
    '',
    'Ich bin für jede Position offen: Verkauf, Backoffice, Buchungsabwicklung, Nachbearbeitung',
    'oder Aushilfe. Teilzeit oder Vollzeit, Kündigungsfrist zwei Wochen.',
    '',
    'Deutsch spreche ich auf B1 und lerne weiter, Englisch fließend (C2), Französisch B2.',
    'Für Reisen nach Nordafrika und für französischsprachige Kundschaft ist das ein',
    'praktischer Vorteil.',
    '',
    'Meinen Lebenslauf finden Sie im Anhang. Über eine kurze Rückmeldung freue ich mich, auch',
    'wenn derzeit keine Stelle frei ist.',
    '',
    'Mit freundlichen Grüßen',
    NAME,
    [EMAIL, PHONE].filter(Boolean).join(' | '),
  ].join('\n');
}

let written = 0;
for (const t of targets) {
  if (written >= LIMIT) break;
  const file = `output/email-hosp-${slug(t.name)}.md`;
  if (existsSync(file)) continue;

  const isAgency = t.kind === 'agency';
  const body = isAgency ? agencyLetter(t) : hotelLetter(t);
  const subject = isAgency
    ? 'Initiativbewerbung: Mitarbeit im Reisebüro (Teilzeit oder Vollzeit)'
    : 'Initiativbewerbung: Mitarbeit im Hotelbetrieb (Teilzeit oder Vollzeit)';

  const content = [
    `TO: ${t.email}`,
    `SUBJECT: ${subject}`,
    `COMPANY: ${t.name}`,
    `ROLE: ${isAgency ? 'Initiativbewerbung Reisebüro' : 'Initiativbewerbung Hotelbetrieb'}`,
    'SCORE: 3.0',
    `SCORE_SOURCE: hospitality initiative campaign — ${t.kind}, no posting`,
    `EMAIL_VERIFIED: ${t.via === 'osm' ? 'published by the business in OpenStreetMap contact data' : 'published on the business’s own Impressum/contact page'}`,
    'LANGUAGE: DE',
    `CV_PDF: ${CV}`,
    `JD_URL: ${t.website || 'n/a'}`,
    '---',
    body,
    '',
  ].join('\n');

  if (DRY) { console.log(`[dry] ${file.replace('output/', '').padEnd(52)} → ${t.email}  (${t.kind})`); written++; continue; }
  writeFileSync(file, content, 'utf8');
  console.log(`✉ ${file.replace('output/', '').padEnd(52)} → ${t.email}`);
  written++;
}
console.log(`\n${written} initiative letter(s) ${DRY ? 'would be ' : ''}written${DRY ? '' : ' — push with: node save-drafts.mjs --score=2.5'}`);
