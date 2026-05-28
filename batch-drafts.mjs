#!/usr/bin/env node
/**
 * batch-drafts.mjs — generate PDF cover letters + email drafts
 *
 * For each report from today with score ≥ threshold:
 *   1. Generate a well-designed HTML cover letter (German for DE jobs, English otherwise)
 *   2. Convert HTML → PDF using Playwright
 *   3. Create email draft metadata file pointing to the PDF + CV PDF
 *
 * Usage:
 *   node batch-drafts.mjs                 # score ≥ 2.5 (default)
 *   node batch-drafts.mjs --score=3.0     # custom threshold
 *   node batch-drafts.mjs --force         # regenerate even if exists
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const REPORTS_DIR = join(PROJECT_DIR, 'reports');
const OUTPUT_DIR = join(PROJECT_DIR, 'output');
const COVER_DIR = join(OUTPUT_DIR, 'cover-letters');
const CV_PDF_PATH = join(OUTPUT_DIR, 'cv-updated.pdf');

const args = process.argv.slice(2);
const THRESHOLD = parseFloat(args.find(a => a.startsWith('--score='))?.split('=')[1] || '2.5');
const FORCE = args.includes('--force');

function log(msg) { console.log(msg); }
function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function err(msg) { console.log(`  ❌ ${msg}`); }

function parseReportHeader(reportPath) {
  const content = readFileSync(reportPath, 'utf-8');
  const lines = content.split('\n').slice(0, 20);
  const meta = {};

  for (const line of lines) {
    const match = line.match(/^\*\*([^:]+):\*\*\s*(.+)/);
    if (!match) continue;
    const key = match[1].toLowerCase().replace(/\s+/g, '_');
    meta[key] = match[2].trim();
  }

  return {
    num: basename(reportPath).match(/^(\d{3})-/)?.[1] || '000',
    company: meta.company,
    role: meta.role,
    score: parseFloat(meta.score?.split('/')[0] || '0'),
    url: meta.url,
    language: meta.language || 'EN',
    recruiter_email: content.match(/\*\*Recruiter Email:\*\*\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i)?.[1] || null,
  };
}

function generateCoverLetterHTML(meta) {
  const { company, role, language } = meta;
  const today = new Date().toLocaleDateString(language === 'DE' ? 'de-DE' : 'en-DE', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  // Auto-detect German jobs from common German keywords in role title
  const isGerman = language === 'DE' ||
    /praktikum|werkstudent|berufseinstieg|einsteiger|ausbildung|sehr geehrt/i.test(role);

  const lang = isGerman ? 'DE' : 'EN';

  // Shared CSS for professional design
  const css = `
    @page { size: A4; margin: 2cm 2.5cm; }
    body {
      font-family: 'Calibri', 'Helvetica Neue', Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.55;
      color: #2c3e50;
      margin: 0;
      padding: 0;
    }
    .sender {
      text-align: right;
      font-size: 10pt;
      color: #555;
      margin-bottom: 30px;
      line-height: 1.4;
    }
    .sender strong {
      font-size: 11pt;
      color: #1a1a1a;
      display: block;
      margin-bottom: 4px;
    }
    .recipient {
      margin-bottom: 30px;
      font-size: 10.5pt;
    }
    .date {
      text-align: right;
      color: #555;
      margin-bottom: 20px;
      font-size: 10.5pt;
    }
    .subject {
      font-weight: bold;
      font-size: 12pt;
      margin-bottom: 25px;
      color: #1a1a1a;
    }
    .greeting {
      margin-bottom: 18px;
      font-size: 11.5pt;
    }
    p {
      margin: 0 0 14px 0;
      text-align: justify;
      text-justify: inter-word;
    }
    .closing {
      margin-top: 25px;
    }
    .signature {
      margin-top: 35px;
      font-weight: bold;
      color: #1a1a1a;
    }
    .signature-contact {
      font-weight: normal;
      color: #555;
      font-size: 10pt;
      margin-top: 4px;
    }
    strong {
      color: #1a1a1a;
    }
  `;

  if (lang === 'DE') {
    return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Anschreiben — ${company}</title>
<style>${css}</style>
</head>
<body>

<div class="sender">
  <strong>Aimene Djebaili</strong>
  E-Mail: Aym.djebaili@gmail.com<br>
  LinkedIn: linkedin.com/in/aimene-djebaili-b064141b8<br>
  Aktuell: Algerien | Umzug nach Deutschland: 2026 (EU Blue Card)
</div>

<div class="recipient">
  <strong>${company}</strong><br>
  Personalabteilung
</div>

<div class="date">${today}</div>

<div class="subject">Bewerbung: ${role}</div>

<div class="greeting">Sehr geehrte Damen und Herren,</div>

<p>
mit großem Interesse habe ich die Stellenausschreibung als <strong>${role}</strong> bei <strong>${company}</strong>
gelesen und bewerbe mich hiermit auf diese Position. Als Absolvent eines Masterstudiums in Digital Economics
mit fundierter Erfahrung im operativen Bereich der Hospitality-Technology-Branche bringe ich genau die Mischung
aus analytischen Fähigkeiten, Kundenorientierung und unternehmerischem Denken mit, die für diese Rolle
entscheidend ist.
</p>

<p>
Aktuell verantworte ich als <strong>Head of Customer Operations bei iPro Booking</strong>, einem
Hospitality-Wholesale-Technology-Unternehmen mit Aktivitäten in Algerien und Tunesien, das gesamte
B2C-Buchungsgeschäft. In dieser Funktion habe ich <strong>345 verifizierte Buchungen aus 1.271 qualifizierten
Leads</strong> umgesetzt und ein Buchungsvolumen von rund <strong>205.000 EUR</strong> generiert. Parallel
dazu leitete ich umfangreiche B2B-Inkasso-Aktivitäten und holte Forderungen in Höhe von rund
<strong>1,59 Mio. EUR</strong> durch strukturierte Verhandlungen mit über 100 Reisebüros und sauberer
OTA-Finanzabstimmung zurück. Ein vierköpfiges Customer-Operations-Team habe ich rekrutiert, eingearbeitet
und kontinuierlich weiterentwickelt.
</p>

<p>
Was mich besonders an ${company} reizt, ist die Möglichkeit, meine operative und analytische Expertise in
einem technologiegetriebenen Umfeld einzubringen, das auf Skalierung, Datenqualität und Kundenerfolg setzt.
Mein Hintergrund in OTA-Workflows, Buchungssystemen und prozessorientiertem Stakeholder-Management lässt sich
direkt auf die Anforderungen Ihrer Position übertragen. Zusätzlich gründe ich aktuell mit <strong>SafiNest</strong>
ein eigenes Hospitality-Tech-Startup im Pre-MVP-Stadium, was mir ein tiefes Verständnis für Produktentwicklung,
Pricing-Logik und Onboarding-Prozesse vermittelt hat.
</p>

<p>
Mein Umzug nach Deutschland im Jahr 2026 erfolgt über die <strong>EU Blue Card</strong>, was eine langfristige
Stabilität und volle Arbeitserlaubnis sicherstellt. Ich spreche fließend Englisch (C1), gut Französisch (B2)
und verbessere mein Deutsch aktiv (aktuell A2, Ziel B1 bis Mitte 2026). Ich bin bereit, ab dem ersten Tag
einen messbaren Beitrag zu leisten und freue mich darauf, meine Erfahrungen und Energie bei ${company}
einzubringen.
</p>

<p>
Über die Möglichkeit eines persönlichen Gesprächs würde ich mich sehr freuen. Gerne stehe ich für ein Telefon-
oder Videointerview zur Verfügung und beantworte Ihre Fragen ausführlich.
</p>

<div class="closing">Mit freundlichen Grüßen,</div>

<div class="signature">
  Aimene Djebaili
  <div class="signature-contact">
    Aym.djebaili@gmail.com<br>
    linkedin.com/in/aimene-djebaili-b064141b8
  </div>
</div>

</body>
</html>`;
  }

  // English version
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Cover Letter — ${company}</title>
<style>${css}</style>
</head>
<body>

<div class="sender">
  <strong>Aimene Djebaili</strong>
  Email: Aym.djebaili@gmail.com<br>
  LinkedIn: linkedin.com/in/aimene-djebaili-b064141b8<br>
  Currently: Algeria | Relocating to Germany: 2026 (EU Blue Card)
</div>

<div class="recipient">
  <strong>${company}</strong><br>
  Hiring Team
</div>

<div class="date">${today}</div>

<div class="subject">Application: ${role}</div>

<div class="greeting">Dear Hiring Team,</div>

<p>
I am writing to express my strong interest in the <strong>${role}</strong> position at <strong>${company}</strong>.
As a Master's graduate in Digital Economics with substantial operational and financial experience in the
hospitality technology sector, I bring exactly the combination of analytical capability, customer focus, and
entrepreneurial drive that this role demands.
</p>

<p>
In my current role as <strong>Head of Customer Operations at iPro Booking</strong>, a wholesale hospitality
technology company operating in Algeria and Tunisia, I lead the end-to-end B2C booking operation. To date,
I have converted <strong>345 verified bookings from 1,271 qualified leads</strong>, generating approximately
<strong>EUR 205,000 in booking value</strong>. In parallel, I led B2B revenue recovery activities, recovering
roughly <strong>EUR 1.59 million</strong> through structured negotiations with more than 100 travel agencies
and clean OTA financial reconciliation. I also recruited, onboarded, and continuously developed a four-person
customer operations team while reducing operational costs and refining internal processes.
</p>

<p>
What particularly draws me to ${company} is the opportunity to bring my operational and analytical expertise
to a technology-driven environment focused on scale, data quality, and customer success. My background in OTA
workflows, booking systems, and process-oriented stakeholder management translates directly to the requirements
of your role. I am also currently building <strong>SafiNest</strong>, an early-stage hospitality technology
startup in the pre-MVP phase, which has given me deep practical understanding of product design, pricing logic,
and host onboarding processes.
</p>

<p>
My relocation to Germany in 2026 will be supported by the <strong>EU Blue Card</strong>, ensuring long-term
stability and full work authorization. I am fluent in English (C1), proficient in French (B2), and actively
improving my German (currently A2, targeting B1 by mid-2026). I am ready to contribute meaningfully from
day one and would be delighted to bring my experience and energy to ${company}.
</p>

<p>
I would welcome the opportunity to discuss my candidacy in a personal conversation. I am readily available for
a phone or video interview and happy to elaborate on any aspect of my background.
</p>

<div class="closing">Best regards,</div>

<div class="signature">
  Aimene Djebaili
  <div class="signature-contact">
    Aym.djebaili@gmail.com<br>
    linkedin.com/in/aimene-djebaili-b064141b8
  </div>
</div>

</body>
</html>`;
}

function htmlToPdf(htmlPath, pdfPath) {
  const res = spawnSync('node', ['generate-pdf.mjs', htmlPath, pdfPath], {
    cwd: PROJECT_DIR,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  if (res.status !== 0) {
    err(`     PDF generation failed: ${res.stderr || res.stdout}`);
    return false;
  }
  return existsSync(pdfPath);
}

function createEmailDraft(num, meta, pdfPath) {
  const slug = meta.company.toLowerCase().replace(/[^a-z0-9]/g, '');
  const draftPath = join(OUTPUT_DIR, `email-${String(num).padStart(3, '0')}-${slug}.md`);

  // Use German subject line for German jobs
  const isGerman = meta.language === 'DE' ||
    /praktikum|werkstudent|berufseinstieg/i.test(meta.role);

  const subject = isGerman
    ? `Bewerbung: ${meta.role}`
    : `Application: ${meta.role}`;

  const bodyGreeting = isGerman ? 'Sehr geehrte Damen und Herren,' : 'Dear Hiring Team,';
  const bodyText = isGerman
    ? `anbei finden Sie meinen Lebenslauf sowie ein auf die Position zugeschnittenes Anschreiben für die Stelle als ${meta.role}.

Über die Möglichkeit eines persönlichen Gesprächs würde ich mich sehr freuen.`
    : `Please find attached my CV and a tailored cover letter for the ${meta.role} position.

I would be delighted to discuss my candidacy in a personal conversation.`;

  const closing = isGerman ? 'Mit freundlichen Grüßen,' : 'Best regards,';

  const content = `TO: ${meta.recruiter_email || ''}
SUBJECT: ${subject}
COMPANY: ${meta.company}
ROLE: ${meta.role}
SCORE: ${meta.score}
EMAIL_VERIFIED: unverified
LANGUAGE: ${isGerman ? 'DE' : meta.language}
COVER_LETTER_PDF: ${pdfPath ? 'output/cover-letters/' + basename(pdfPath) : ''}
CV_PDF: output/cv-updated.pdf
JD_URL: ${meta.url}
---
${bodyGreeting}

${bodyText}

${closing}
Aimene Djebaili
Aym.djebaili@gmail.com
`;

  writeFileSync(draftPath, content, 'utf-8');
  return draftPath;
}

async function main() {
  log('\n=== Batch PDF Cover Letter + Email Draft Generator ===\n');

  if (!existsSync(CV_PDF_PATH)) {
    err(`CV PDF not found at: ${CV_PDF_PATH}`);
    log(`Please save your CV PDF to: output/cv-updated.pdf`);
    process.exit(1);
  }
  ok(`CV PDF found: ${basename(CV_PDF_PATH)}`);

  if (!existsSync(REPORTS_DIR)) {
    err('No reports/ directory found');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const reportFiles = readdirSync(REPORTS_DIR)
    .filter(f => f.endsWith('.md') && f.includes(today))
    .sort();

  if (reportFiles.length === 0) {
    warn(`No reports from today (${today})`);
    return;
  }

  log(`Found ${reportFiles.length} reports from today\n`);

  if (!existsSync(COVER_DIR)) mkdirSync(COVER_DIR, { recursive: true });

  // Clean up old HTML cover letters and email drafts if forcing
  if (FORCE) {
    log('Force mode: cleaning existing drafts and cover letters...\n');
    readdirSync(COVER_DIR).filter(f => f.endsWith('.html') || f.endsWith('.pdf')).forEach(f => {
      try { unlinkSync(join(COVER_DIR, f)); } catch {}
    });
    readdirSync(OUTPUT_DIR).filter(f => f.startsWith('email-') && f.endsWith('.md')).forEach(f => {
      try { unlinkSync(join(OUTPUT_DIR, f)); } catch {}
    });
    // Also reset the draft log
    const draftLog = join(OUTPUT_DIR, '.draft-log.json');
    if (existsSync(draftLog)) {
      try { unlinkSync(draftLog); } catch {}
    }
  }

  let pdfCount = 0;
  let draftCount = 0;
  let skipped = 0;
  let noEmail = 0;

  for (const file of reportFiles) {
    const reportPath = join(REPORTS_DIR, file);
    const meta = parseReportHeader(reportPath);

    log(`→ ${meta.company} | ${meta.role} (score ${meta.score}/5)`);

    if (meta.score < THRESHOLD) {
      log(`     ⏭️  below threshold (${THRESHOLD})`);
      skipped++;
      continue;
    }

    // Always generate PDF cover letter for qualified jobs (needed for web-form apply)
    // Email draft is only created if recruiter_email is present

    // Generate HTML cover letter
    const num = meta.num;
    const slug = meta.company.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isGerman = meta.language === 'DE' ||
      /praktikum|werkstudent|berufseinstieg/i.test(meta.role);
    const langSlug = isGerman ? 'de' : 'en';

    const htmlPath = join(COVER_DIR, `${num}-${slug}-${langSlug}.html`);
    const pdfPath = join(COVER_DIR, `${num}-${slug}-${langSlug}.pdf`);

    const html = generateCoverLetterHTML(meta);
    writeFileSync(htmlPath, html, 'utf-8');

    // Convert to PDF
    const pdfOk = htmlToPdf(htmlPath, pdfPath);
    if (!pdfOk) {
      err(`     PDF generation failed`);
      continue;
    }
    ok(`PDF cover letter: ${basename(pdfPath)}`);
    pdfCount++;

    // Create email draft ONLY if we have a recruiter email
    if (meta.recruiter_email) {
      const draftPath = createEmailDraft(num, meta, pdfPath);
      ok(`email draft: ${basename(draftPath)}`);
      draftCount++;
    } else {
      log(`     ℹ️  no email — will apply via web form (auto-apply.mjs)`);
      noEmail++;
    }
  }

  log(`\n=== Summary ===`);
  log(`PDF cover letters: ${pdfCount}`);
  log(`Email drafts: ${draftCount}`);
  log(`Skipped (low score): ${skipped}`);
  log(`Skipped (no email): ${noEmail}`);

  if (draftCount > 0) {
    log(`\nNext: node save-drafts.mjs --score=${THRESHOLD}`);
    log(`(will attach both CV PDF and cover letter PDF to each Gmail draft)\n`);
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
