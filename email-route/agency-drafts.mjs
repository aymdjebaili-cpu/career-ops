#!/usr/bin/env node
/**
 * agency-drafts.mjs — one letter per Munich recruiting agency, registering him for
 * FULL-TIME COMMERCIAL work.
 *
 * WHY THIS LETTER IS DIFFERENT FROM EVERY OTHER ONE IN THIS REPO
 * The part-time and hotel letters sell availability: shifts, weekends, start tomorrow. This
 * one sells the qualification, because on 2026-09-22 he said "ask for a full time job not a
 * warehouse or anything like that from now on". An agency files a candidate under whatever
 * the first letter implies, so this one states the floor explicitly — operations, customer
 * service, order processing, Sachbearbeitung, inside sales — AND names what he does not
 * want. Without that sentence they will offer Lager, because that is what pays their desk
 * fastest and what his earlier applications looked like.
 *
 * Every fact traces to cv-de.md: master's in data science and digital economics (anabin H+),
 * Head of Customer Operations to 16 August 2026, €1.59M recovered across 100+ partners, 345
 * bookings from 1,271 leads, a team of four, German B1 / English C2 / French B2, Munich.
 * Availability is deliberately left open rather than claimed — see the note below.
 *
 * Usage:
 *   node email-route/agency-drafts.mjs output/email-route [--limit=40] [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { resolveCvPdf } from '../cv-pdf.mjs';

const S = process.argv[2] || 'output/email-route';
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) || '--limit=40').split('=')[1]);
const DRY = process.argv.includes('--dry-run');

const profile = yaml.load(readFileSync('config/profile.yml', 'utf8'));
const c = profile.candidate || {};
const NAME = (c.full_name || 'Armin Djebaili').trim().split(/\s+/)
  .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
const EMAIL = c.email || '';
const PHONE = c.phone || '';
const CV = resolveCvPdf({ relative: true });

const targets = JSON.parse(readFileSync(`${S}/agency-targets.json`, 'utf8'));
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 44);

const letter = () => [
  'Sehr geehrte Damen und Herren,',
  '',
  'ich suche eine Vollzeitstelle im kaufmännischen Bereich in München und möchte mich',
  'deshalb in Ihrer Kartei registrieren lassen.',
  '',
  'Zu meinem Hintergrund: Ich habe einen Master of Science in Data Science und Digitaler',
  'Ökonomie — in Deutschland vollständig anerkannt und einem deutschen Masterabschluss',
  'gleichwertig (anabin-Status H+). Zuletzt war ich Head of Customer Operations bei einem',
  'Großhandelsunternehmen für Hospitality-Technologie. Dort habe ich den gesamten',
  'Buchungsprozess verantwortet (345 bestätigte Buchungen aus 1.271 Leads), das',
  'Forderungsmanagement geleitet — rund 1,59 Mio. EUR wurden in Verhandlungen mit über 100',
  'Partnern zurückgeführt — und ein vierköpfiges Team aufgebaut und geführt.',
  '',
  'Passende Positionen wären für mich: Operations, Customer Service und Kundenbetreuung,',
  'Auftragsabwicklung, Sachbearbeitung, Vertriebsinnendienst oder Customer Success. Damit',
  'Sie nicht unnötig suchen: Lager-, Produktions- und Reinigungstätigkeiten kommen für mich',
  'nicht in Frage.',
  '',
  'Deutsch spreche ich auf B1-Niveau und lerne weiter, Englisch fließend (C2), Französisch',
  'B2. Ich wohne in München-Trudering. Über den möglichen Eintrittstermin stimme ich mich',
  'gerne direkt mit Ihnen ab.',
  '',
  'Meinen Lebenslauf finden Sie im Anhang. Über eine Rückmeldung freue ich mich — gerne',
  'auch mit einem Hinweis, welche Unterlagen Sie für eine Aufnahme in Ihre Kartei benötigen.',
  '',
  'Mit freundlichen Grüßen',
  NAME,
  [EMAIL, PHONE].filter(Boolean).join(' | '),
].join('\n');

let written = 0;
for (const t of targets) {
  if (written >= LIMIT) break;
  const file = `output/email-agency-${slug(t.name)}.md`;
  if (existsSync(file)) continue;

  const content = [
    `TO: ${t.email}`,
    'SUBJECT: Initiativbewerbung: Vollzeitstelle im kaufmännischen Bereich (Operations / Customer Service)',
    `COMPANY: ${t.name}`,
    'ROLE: Initiativbewerbung kaufmännisch (Vollzeit)',
    'SCORE: 3.5',
    `SCORE_SOURCE: agency registration — ${t.kind}, no posting`,
    `EMAIL_VERIFIED: published by the agency at ${t.source}`,
    'LANGUAGE: DE',
    `CV_PDF: ${CV}`,
    `JD_URL: https://${t.domain}`,
    '---',
    letter(),
    '',
  ].join('\n');

  if (DRY) { console.log(`[dry] ${file.replace('output/', '').padEnd(44)} → ${t.email}`); written++; continue; }
  writeFileSync(file, content, 'utf8');
  console.log(`✉ ${file.replace('output/', '').padEnd(44)} → ${t.email}`);
  written++;
}
console.log(`\n${written} agency letter(s) ${DRY ? 'would be ' : ''}written${DRY ? '' : ' — push with: node save-drafts.mjs --score=2.5'}`);
