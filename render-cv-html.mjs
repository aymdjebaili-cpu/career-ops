#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Fields the CV markdown does not carry (phone, headshot) come from
 * config/profile.yml. generate-pdf.mjs rewrites "./assets/..." to an absolute
 * file:// URL at PDF time, so the photo must stay a relative ./assets/ path here.
 */
async function loadProfileExtras() {
  const profilePath = resolve(__dirname, 'config', 'profile.yml');
  if (!existsSync(profilePath)) return { phone: '', photoTag: '' };
  try {
    const cfg = yaml.load(await readFile(profilePath, 'utf8'));
    const candidate = cfg?.candidate || {};
    const phone = candidate.phone ? String(candidate.phone).replace(/\s*#.*$/, '').trim() : '';

    let photoTag = '';
    const photo = candidate.photo ? String(candidate.photo).trim() : '';
    if (photo) {
      const onDisk = resolve(__dirname, photo.replace(/^\.\//, ''));
      if (existsSync(onDisk)) {
        photoTag = `<img class="header-photo" src="./${photo.replace(/^\.\//, '')}" alt="${escapeHtml(candidate.full_name || 'Profile photo')}">`;
      } else {
        console.warn(`⚠️  photo listed in profile.yml not found on disk: ${onDisk} — rendering without it`);
      }
    }
    return { phone, photoTag, legalName: candidate.legal_name || '' };
  } catch (error) {
    console.warn(`⚠️  could not read config/profile.yml (${error.message}) — rendering without phone/photo`);
    return { phone: '', photoTag: '', legalName: '' };
  }
}

/**
 * The legal name, in the smallest type on the page.
 *
 * He applies as Armin Djebaili; the passport, both degree certificates and the
 * IELTS result read Aimene Djebaili. Printing the legal name once, quietly,
 * costs nothing and answers the question a careful reader would otherwise have
 * to put to him — this CV claims credentials that are not in the name at the
 * top of it. Returns '' when profile.yml sets no legal_name, so the block
 * disappears entirely rather than printing a bare rule.
 */
function legalNoteHtml(legalName, lang) {
  if (!legalName) return '';
  const text = lang === 'de'
    ? `Zeugnisse und Zertifikate lauten auf meinen amtlichen Namen: ${legalName}.`
    : `Certificates and official documents are issued in my legal name: ${legalName}.`;
  return `<div class="legal-note">${escapeHtml(text)}</div>`;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineMd(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
}

// Markdown horizontal rules (---, ***, ___) are section separators in cv.md.
// They carry no meaning in the rendered CV and used to print as a literal "---".
const isHorizontalRule = (line) => /^\s*([-*_])\1{2,}\s*$/.test(line);

function renderParagraphs(lines) {
  const blocks = [];
  let current = [];
  for (const rawLine of lines) {
    const line = isHorizontalRule(rawLine) ? '' : rawLine.trim();
    if (!line) {
      if (current.length) {
        blocks.push(current.join(' '));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join(' '));
  return blocks.map((block) => `<p>${inlineMd(block)}</p>`).join('\n');
}

function renderList(lines) {
  const items = lines
    .filter((line) => line.trim().startsWith('- '))
    .map((line) => `<li>${inlineMd(line.trim().slice(2).trim())}</li>`);
  if (!items.length) return '';
  return `<ul>${items.join('')}</ul>`;
}

function renderTable(lines) {
  const rows = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .map((line) => line.replace(/(^\||\|$)/g, '').split('|').map((cell) => cell.trim()));

  if (rows.length < 2) return '';
  const [header, ...rest] = rows;
  // Markdown's |---|---| alignment row is not a record. It was rendered as one,
  // so every CV this project produced printed a line of dashes between the
  // language table's header and its first language — and pdftotext, which is
  // what an ATS runs, reads that line as data.
  const body = rest.filter(row => !row.every(cell => /^:?-{2,}:?$/.test(cell)));
  return `
    <table class="data-table">
      <thead><tr>${header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead>
      <tbody>${body
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`
        )
        .join('')}</tbody>
    </table>
  `;
}

function normalizeSectionName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseCv(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const sections = {};
  let section = 'header';
  sections[section] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const headingMatch = line.match(/^##\s+(.*)$/);
    if (headingMatch) {
      section = headingMatch[1].trim();
      sections[section] = [];
      continue;
    }
    sections[section].push(line);
  }

  const headerLines = sections.header.filter((line) => line.trim() !== '');
  const nameLine = headerLines.shift() || '';
  const name = nameLine.replace(/^#\s+/, '').trim();

  let email = '';
  let location = '';
  let linkedinUrl = '';
  let linkedinDisplay = '';
  let portfolioUrl = '';
  let portfolioDisplay = '';
  let summaryText = '';

  // The bold line under the name ("**Finanzwesen und Digitale Ökonomie ...**").
  // It has always been in cv.md and the template had nowhere to put it, so every
  // CV this project produced opened with a name and a phone number and no
  // statement of what the person does. tailor-cv.mjs rewrites this one line to
  // the title of the role being applied for.
  const taglineLine = headerLines.find((line) => /^\*\*.+\*\*$/.test(line.trim()) && !line.includes('@'));
  const tagline = taglineLine ? taglineLine.trim().replace(/^\*\*|\*\*$/g, '').trim() : '';

  const contactLine = headerLines.find((line) => line.includes('@') || line.includes('linkedin.com') || line.includes('http')) || '';
  if (contactLine) {
    const parts = contactLine.split('|').map((part) => part.trim());
    for (const part of parts) {
      if (part.includes('@')) {
        email = part;
      } else if (part.match(/\[(.+?)\]\((https?:\/\/[^)]+)\)/)) {
        const [, label, url] = part.match(/\[(.+?)\]\((https?:\/\/[^)]+)\)/) || [];
        if (url.includes('linkedin.com')) {
          linkedinUrl = url;
          linkedinDisplay = label;
        } else {
          portfolioUrl = url;
          portfolioDisplay = label;
        }
      } else if (part.startsWith('http')) {
        if (part.includes('linkedin.com')) {
          linkedinUrl = part;
          linkedinDisplay = part.replace(/^https?:\/\//, '');
        } else {
          portfolioUrl = part;
          portfolioDisplay = part.replace(/^https?:\/\//, '');
        }
      } else if (!location) {
        location = part;
      }
    }
  }

  if (!linkedinDisplay && linkedinUrl) {
    linkedinDisplay = linkedinUrl.replace(/^https?:\/\//, '');
  }

  if (!portfolioDisplay && portfolioUrl) {
    portfolioDisplay = portfolioUrl.replace(/^https?:\/\//, '');
  }

  summaryText = renderParagraphs(
    sections['Professional Profile'] || sections['Summary']
    || sections['Kurzprofil'] || sections['Profil'] || []);

  // Section headings differ by language. Take the first heading that exists so
  // one renderer serves both cv.md and cv-de.md — otherwise the German
  // "Kenntnisse" block is silently dropped, because the key is 'Skills'.
  const pick = (...names) => {
    for (const n of names) if (sections[n]) return sections[n];
    return [];
  };

  const experienceHtml = renderExperienceSections(sections);
  const educationHtml = renderEducationSection(pick('Education', 'Ausbildung'));
  // Competencies and Skills both read the same source, so rendering both prints
  // the identical list twice and eats half a page. Keep the tag cloud, which
  // scans better, and drop the plain repeat of it.
  const skillsSource = pick('Skills', 'Kenntnisse', 'Fähigkeiten');
  const competenciesHtml = renderCompetencyTags(skillsSource);
  const skillsHtml = competenciesHtml ? '' : renderSkillsSection(skillsSource);
  const projectsHtml = renderProjectsSection(pick('Projects', 'Projekte'));
  const certificationsHtml = renderCertificationsSection(pick('Certifications', 'Zertifikate'));
  const languageRows = pick('Languages', 'Sprachen');
  const languagesHtml = renderLanguagesSection(languageRows);
  const headerLanguagesHtml = renderHeaderLanguages(languageRows);

  return {
    name,
    email,
    location,
    linkedinUrl,
    linkedinDisplay,
    portfolioUrl,
    portfolioDisplay,
    summaryText,
    competenciesHtml,
    experienceHtml,
    educationHtml,
    projectsHtml,
    certificationsHtml,
    skillsHtml,
    languagesHtml,
    tagline,
    headerLanguagesHtml,
  };
}

/**
 * The language levels, repeated as chips in the header.
 *
 * The table at the foot of the CV is the record; this is the one a recruiter
 * actually sees. On a German application the German level decides whether the
 * CV is read at all, and it was sitting below Ausbildung on page two — found,
 * if at all, after the decision had been taken. The German chip is emphasised
 * for that reason.
 */
function renderHeaderLanguages(lines) {
  const rows = [];
  for (const raw of lines || []) {
    const line = String(raw).trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    cells.shift();                                   // empty text before the leading pipe
    if (cells[cells.length - 1] === '') cells.pop(); // and after the trailing one
    if (cells.length < 2) continue;
    // Skip the markdown header row and its |---|---| separator.
    if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
    if (/^(sprache|language)$/i.test(cells[0])) continue;
    rows.push({ language: cells[0], level: cells[1] });
  }
  if (!rows.length) return '';
  const chips = rows.map(({ language, level }) => {
    const primary = /^(deutsch|german)/i.test(language) ? ' lang-primary' : '';
    return `<span class="lang-chip${primary}">${escapeHtml(language)} ${escapeHtml(level)}</span>`;
  });
  return `<div class="header-langs">${chips.join('')}</div>`;
}

/**
 * The languages table. cv.md has always carried one and the renderer had no
 * placeholder for it, so no CV this project produced has ever stated a language
 * level — the one thing a German recruiter checks first.
 */
function renderLanguagesSection(lines) {
  const table = renderTable(lines);
  if (table.trim()) return table;
  const list = renderList(lines);
  if (list.trim()) return list;
  const text = renderParagraphs(lines);
  return text.trim() ? text : '';
}

function renderExperienceSections(sections) {
  // German headings included, otherwise a German CV renders "No work
  // experience found." over an otherwise complete Lebenslauf — which is worse
  // than no CV at all.
  const keys = [
    'Professional Experience', 'Entrepreneurial Experience', 'Experience', 'Work Experience',
    'Berufserfahrung', 'Unternehmerische Erfahrung', 'Berufliche Erfahrung', 'Praktische Erfahrung',
  ];
  const blocks = [];

  for (const key of keys) {
    if (!sections[key]) continue;
    blocks.push(renderExperienceItems(sections[key]));
  }

  return blocks.filter(Boolean).join('\n');
}

function renderExperienceItems(lines) {
  const items = [];
  let current = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = line.match(/^###\s+(.*)$/);
    if (heading) {
      if (current) items.push(current);
      current = { title: heading[1].trim(), meta: [], bullets: [] };
      continue;
    }
    if (!current) continue;
    if (line.trim().startsWith('- ')) {
      current.bullets.push(line.trim().slice(2).trim());
    } else if (line.trim()) {
      current.meta.push(line.trim());
    }
  }
  if (current) items.push(current);

  return items
    .map((item) => renderJobItem(item))
    .join('\n');
}

function renderJobItem(item) {
  // Both dashes: the CV was rewritten with em dashes in 2026-09, and splitting on
  // the en dash alone put the whole "Role — Company" string into the role line.
  const [rolePart, companyPart] = item.title.split(/\s[–—]\s/).map((part) => part.trim());
  let company = companyPart || '';
  let role = rolePart || item.title;

  const metaLine = item.meta.find((line) => line.startsWith('**') && line.endsWith('**')) || '';
  const metaText = metaLine.replace(/\*\*/g, '').trim();
  let [location = '', period = ''] = metaText.split('|').map((part) => part.trim());

  // The CV no longer uses bullet lists; each job is prose. An italic line under
  // the heading carries the context and the dates ("*Wholesale company · Dec 2024
  // – 16 Aug 2026*"), and every other line is a paragraph. Before this, those
  // paragraphs landed in `meta`, were never rendered, and the PDF shipped with
  // job titles and no descriptions at all (caught by reading the PDF back).
  const subtitleLine = item.meta.find((line) => /^\*[^*].*\*$/.test(line.trim()));
  if (subtitleLine && !period) {
    const inner = subtitleLine.trim().replace(/^\*|\*$/g, '');
    const parts = inner.split('·').map((p) => p.trim()).filter(Boolean);
    const dateIdx = parts.findIndex((p) => /\d{4}|heute|present/i.test(p));
    if (dateIdx >= 0) {
      period = parts[dateIdx];
      location = parts.filter((_, i) => i !== dateIdx).join(' · ');
    } else {
      location = inner;
    }
  }

  const paragraphs = item.meta
    .filter((line) => line !== metaLine && line !== subtitleLine && !isHorizontalRule(line))
    .map((line) => `<p>${inlineMd(line)}</p>`)
    .join('');

  const bulletsHtml = paragraphs
    || (item.bullets.length ? `<ul>${item.bullets.map((bullet) => `<li>${inlineMd(bullet)}</li>`).join('')}</ul>` : '');

  // inlineMd, not escapeHtml: headings carry markdown emphasis such as
  // "iPro Booking *(Hospitality Wholesale Technology Company)*", which would
  // otherwise print with the asterisks visible.
  return `
    <div class="job avoid-break">
      <div class="job-header">
        <div>
          <div class="job-role">${inlineMd(role)}</div>
          <div class="job-company">${inlineMd(company)}</div>
        </div>
        <div class="job-period">${escapeHtml(period)}</div>
      </div>
      ${location ? `<div class="job-location">${inlineMd(location)}</div>` : ''}
      ${bulletsHtml}
    </div>
  `;
}

function renderEducationSection(lines) {
  const items = [];
  let current = null;
  // Text placed under "## Education" BEFORE the first degree was silently
  // dropped — `if (!current) continue` threw it away. That is where a statement
  // about the degrees as a whole belongs, and it is why the anabin recognition
  // note has never appeared on a single rendered CV despite sitting in cv.md.
  const lead = [];

  for (const line of lines) {
    const heading = line.match(/^###\s+(.*)$/);
    if (heading) {
      if (current) items.push(current);
      current = { title: heading[1].trim(), meta: [], bullets: [] };
      continue;
    }
    if (!current) {
      if (line.trim() && !isHorizontalRule(line.trim())) lead.push(line.trim());
      continue;
    }
    if (line.trim().startsWith('- ')) {
      current.bullets.push(line.trim().slice(2).trim());
    } else if (line.trim()) {
      current.meta.push(line.trim());
    }
  }
  if (current) items.push(current);

  // A German employer checks whether a foreign degree counts before reading
  // anything else, so this sits at the top of the section rather than in a
  // footnote.
  const leadHtml = lead.length
    ? `<p class="edu-note">${lead.map(l => inlineMd(l)).join(' ')}</p>`
    : '';

  return leadHtml + items
    .map((item) => {
      const title = inlineMd(item.title);
      const lines = item.meta.filter((meta) => !isHorizontalRule(meta));
      // The institution sits in italics directly under the degree; the bold line
      // is the anabin recognition note, which must stay bold and on its own line
      // beside the degree. Joining everything with " | " printed the raw asterisks
      // and buried the recognition note mid-sentence.
      const institution = lines.find((l) => /^\*[^*].*\*$/.test(l.trim())) || '';
      const recognition = lines.find((l) => /^\*\*.*\*\*$/.test(l.trim())) || '';
      const rest = lines.filter((l) => l !== institution && l !== recognition);
      const bulletsHtml = rest.length
        ? rest.map((l) => `<p>${inlineMd(l)}</p>`).join('')
        : (item.bullets.length ? `<ul>${item.bullets.map((bullet) => `<li>${inlineMd(bullet)}</li>`).join('')}</ul>` : '');
      return `
        <div class="edu-item avoid-break">
          <div class="job-header">
            <div>
              <div class="job-role">${title}</div>
              ${institution ? `<div class="job-company">${inlineMd(institution.replace(/^\*|\*$/g, ''))}</div>` : ''}
            </div>
          </div>
          ${recognition ? `<p class="edu-recognition">${inlineMd(recognition)}</p>` : ''}
          ${bulletsHtml}
        </div>
      `;
    })
    .join('\n');
}

function renderSkillsSection(lines) {
  // Skills are now one middot-separated sentence rather than a bullet list, so
  // split on the separator; the old bullet form still works for any CV that
  // keeps it.
  const inline = lines
    .filter((line) => line.trim() && !line.trim().startsWith('- ') && !isHorizontalRule(line.trim()))
    .join(' ')
    .split(/\s*·\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const tags = lines
    .filter((line) => line.trim().startsWith('- '))
    .map((line) => `<span class="competency-tag">${escapeHtml(line.trim().slice(2).trim())}</span>`)
    .concat(inline.map((s) => `<span class="competency-tag">${escapeHtml(s)}</span>`));
  return tags.length ? `<div class="competencies-grid">${tags.join('')}</div>` : renderParagraphs(lines);
}

function renderCompetencyTags(lines) {
  const tags = lines
    .filter((line) => line.trim().startsWith('- '))
    .map((line) => `<span class="competency-tag">${escapeHtml(line.trim().slice(2).trim())}</span>`);
  return tags.join('');
}

function renderProjectsSection(lines) {
  return renderParagraphs(lines);
}

function renderCertificationsSection(lines) {
  return renderParagraphs(lines);
}

function ensureDirectoryExists(filePath) {
  return mkdir(resolve(dirname(filePath)), { recursive: true });
}

/**
 * Remove a whole <div class="section"> block when the CV has nothing to put in it.
 * Printing "No projects found." / "No certifications yet." on a CV that is emailed
 * to employers reads as an unfinished document.
 */
function removeSectionBlock(template, placeholder) {
  // Spans the nested <div class="section-title">…</div> to reach the placeholder,
  // but the (?!<div class="section) guard stops the lazy match from running past
  // this block into a later one and deleting everything in between.
  const re = new RegExp(
    `\\n?[ \\t]*(?:<!--[^>]*-->\\s*)?<div class="section[^"]*">` +
    `(?:(?!<div class="section)[\\s\\S])*?` +
    `\\{\\{${placeholder}\\}\\}\\s*</div>`,
    ''
  );
  if (!re.test(template)) {
    console.warn(`⚠️  could not locate the {{${placeholder}}} section block to remove`);
    return template;
  }
  return template.replace(re, '');
}

/**
 * Drop contact entries that resolved to nothing (no phone, no portfolio URL) and
 * then fix up the "|" separators around them. Without this the CV ships an empty
 * <span> and a dead <a href="#">Portfolio</a> link.
 */
function tidyContactRow(html) {
  return html.replace(
    /(<div class="contact-row">)([\s\S]*?)(<\/div>)/,
    (match, open, inner, close) => {
      const cleaned = inner
        .replace(/<span>\s*<\/span>/g, '')
        .replace(/<a href="#">[^<]*<\/a>/g, '');

      const parts = cleaned
        .split(/<span class="separator">\|<\/span>/)
        .map((part) => part.trim())
        .filter(Boolean);

      const rebuilt = parts.join('\n        <span class="separator">|</span>\n        ');
      return `${open}\n        ${rebuilt}\n      ${close}`;
    }
  );
}

/**
 * Section headings printed on the rendered CV. A German CV under English
 * headings reads as a machine translation, which is the exact impression to
 * avoid on a German-language application.
 */
const LABELS = {
  en: {
    summary: 'Professional Summary',
    competencies: 'Core Competencies',
    experience: 'Work Experience',
    projects: 'Projects',
    education: 'Education',
    certifications: 'Certifications',
    skills: 'Skills',
    languages: 'Languages',
  },
  de: {
    summary: 'Kurzprofil',
    competencies: 'Kernkompetenzen',
    experience: 'Berufserfahrung',
    projects: 'Projekte',
    education: 'Ausbildung',
    certifications: 'Zertifikate',
    skills: 'Kenntnisse',
    languages: 'Sprachen',
  },
};

async function main() {
  const args = process.argv.slice(2);
  const cvPath = resolve(args.find(a => !a.startsWith('--')) || 'cv.md');
  const positional = args.filter(a => !a.startsWith('--'));
  const outputPath = resolve(positional[1] || 'output/cv.html');
  const templatePath = resolve(positional[2] || 'templates/cv-template.html');
  // --lang=de, or inferred from a "-de" in the filename, so
  // `node render-cv-html.mjs cv-de.md` simply does the right thing.
  const langFlag = args.find(a => a.startsWith('--lang='))?.split('=')[1];
  const base = cvPath.split(/[\\/]/).pop();
  const lang = langFlag || (/(^|[-_.])de([-_.]|$)/i.test(base) ? 'de' : 'en');
  const L = LABELS[lang] || LABELS.en;
  if (lang !== 'en') console.log(`ℹ️  rendering with ${lang} section headings`);

  const [cvRaw, template] = await Promise.all([
    readFile(cvPath, 'utf8'),
    readFile(templatePath, 'utf8'),
  ]);

  const parsed = parseCv(cvRaw);
  const extras = await loadProfileExtras();

  // Sections the CV may legitimately not have — drop the block rather than
  // rendering a "None found" placeholder.
  let template2 = template;
  for (const [placeholder, content] of [
    ['PROJECTS', parsed.projectsHtml],
    ['CERTIFICATIONS', parsed.certificationsHtml],
    ['COMPETENCIES', parsed.competenciesHtml],
    ['SKILLS', parsed.skillsHtml],
  ]) {
    if (!content || !content.trim()) {
      template2 = removeSectionBlock(template2, placeholder);
      console.log(`ℹ️  no ${placeholder.toLowerCase()} in cv.md — section omitted`);
    }
  }

  const html = template2
    // Was hardcoded to 'en', which told the PDF renderer and any screen reader
    // that a German Lebenslauf was English.
    .replace(/{{LANG}}/g, lang)
    .replace(/{{PAGE_WIDTH}}/g, '840px')
    .replace(/{{LEGAL_NOTE_BLOCK}}/g, legalNoteHtml(extras.legalName, lang))
    .replace(/{{NAME}}/g, escapeHtml(parsed.name || ''))
    .replace(/{{TAGLINE_BLOCK}}/g, parsed.tagline
      ? `<div class="header-tagline">${escapeHtml(parsed.tagline)}</div>`
      : '')
    .replace(/{{HEADER_LANGUAGES}}/g, parsed.headerLanguagesHtml || '')
    .replace(/{{PHONE}}/g, escapeHtml(extras.phone || ''))
    .replace(/{{PHOTO_IMG}}/g, extras.photoTag || '')
    .replace(/{{EMAIL}}/g, escapeHtml(parsed.email || ''))
    .replace(/{{LINKEDIN_URL}}/g, escapeHtml(parsed.linkedinUrl || '#'))
    .replace(/{{LINKEDIN_DISPLAY}}/g, escapeHtml(parsed.linkedinDisplay || 'LinkedIn'))
    .replace(/{{PORTFOLIO_URL}}/g, escapeHtml(parsed.portfolioUrl || '#'))
    .replace(/{{PORTFOLIO_DISPLAY}}/g, escapeHtml(parsed.portfolioDisplay || 'Portfolio'))
    .replace(/{{LOCATION}}/g, escapeHtml(parsed.location || ''))
    .replace(/{{SECTION_SUMMARY}}/g, L.summary)
    .replace(/{{SUMMARY_TEXT}}/g, parsed.summaryText || '<p>No profile summary found.</p>')
    .replace(/{{SECTION_COMPETENCIES}}/g, L.competencies)
    .replace(/{{COMPETENCIES}}/g, parsed.competenciesHtml)
    .replace(/{{SECTION_EXPERIENCE}}/g, L.experience)
    .replace(/{{EXPERIENCE}}/g, parsed.experienceHtml || '<p>No work experience found.</p>')
    .replace(/{{SECTION_PROJECTS}}/g, L.projects)
    .replace(/{{PROJECTS}}/g, parsed.projectsHtml || '')
    .replace(/{{SECTION_EDUCATION}}/g, L.education)
    .replace(/{{EDUCATION}}/g, parsed.educationHtml || '<p>No education found.</p>')
    .replace(/{{SECTION_CERTIFICATIONS}}/g, L.certifications)
    .replace(/{{CERTIFICATIONS}}/g, parsed.certificationsHtml || '')
    .replace(/{{SECTION_SKILLS}}/g, L.skills)
    .replace(/{{SKILLS}}/g, parsed.skillsHtml || '<p>No skills found.</p>')
    .replace(/{{LANGUAGES_BLOCK}}/g, parsed.languagesHtml
      ? `<div class="section avoid-break"><div class="section-title">${L.languages}</div>${parsed.languagesHtml}</div>`
      : '');

  await ensureDirectoryExists(outputPath);
  await writeFile(outputPath, tidyContactRow(html), 'utf8');

  console.log(`✅ HTML generated: ${outputPath}`);
  console.log('Next step: node generate-pdf.mjs', outputPath, outputPath.replace(/\.html$/, '.pdf'));
}

main().catch((error) => {
  console.error('❌ Failed to render CV HTML:', error.message);
  process.exit(1);
});
