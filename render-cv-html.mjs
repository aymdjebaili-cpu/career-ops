#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function renderParagraphs(lines) {
  const blocks = [];
  let current = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
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
  const [header, ...body] = rows;
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

  summaryText = renderParagraphs(sections['Professional Profile'] || sections['Summary'] || []);

  const experienceHtml = renderExperienceSections(sections);
  const educationHtml = renderEducationSection(sections['Education'] || []);
  const skillsHtml = renderSkillsSection(sections['Skills'] || []);
  const competenciesHtml = renderCompetencyTags(sections['Skills'] || []);
  const projectsHtml = renderProjectsSection(sections['Projects'] || []);
  const certificationsHtml = renderCertificationsSection(sections['Certifications'] || []);

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
  };
}

function renderExperienceSections(sections) {
  const keys = ['Professional Experience', 'Entrepreneurial Experience', 'Experience', 'Work Experience'];
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
  const [rolePart, companyPart] = item.title.split('–').map((part) => part.trim());
  let company = companyPart || '';
  let role = rolePart || item.title;

  const metaLine = item.meta.find((line) => line.startsWith('**') && line.endsWith('**')) || '';
  const metaText = metaLine.replace(/\*\*/g, '').trim();
  const [location = '', period = ''] = metaText.split('|').map((part) => part.trim());

  const bulletsHtml = item.bullets.length ? `<ul>${item.bullets.map((bullet) => `<li>${inlineMd(bullet)}</li>`).join('')}</ul>` : '';

  return `
    <div class="job avoid-break">
      <div class="job-header">
        <div>
          <div class="job-role">${escapeHtml(role)}</div>
          <div class="job-company">${escapeHtml(company)}</div>
        </div>
        <div class="job-period">${escapeHtml(period)}</div>
      </div>
      ${location ? `<div class="job-location">${escapeHtml(location)}</div>` : ''}
      ${bulletsHtml}
    </div>
  `;
}

function renderEducationSection(lines) {
  const items = [];
  let current = null;

  for (const line of lines) {
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
    .map((item) => {
      const title = escapeHtml(item.title);
      const institutionMeta = item.meta.map((meta) => meta.replace(/\*\*/g, '').trim()).join(' | ');
      const bulletsHtml = item.bullets.length
        ? `<ul>${item.bullets.map((bullet) => `<li>${inlineMd(bullet)}</li>`).join('')}</ul>`
        : '';
      return `
        <div class="edu-item avoid-break">
          <div class="job-header">
            <div>
              <div class="job-role">${title}</div>
              <div class="job-company">${escapeHtml(institutionMeta)}</div>
            </div>
          </div>
          ${bulletsHtml}
        </div>
      `;
    })
    .join('\n');
}

function renderSkillsSection(lines) {
  const tags = lines
    .filter((line) => line.trim().startsWith('- '))
    .map((line) => `<span class="competency-tag">${escapeHtml(line.trim().slice(2).trim())}</span>`);
  return tags.length ? `<div class="competencies-grid">${tags.join('')}</div>` : renderParagraphs(lines);
}

function renderCompetencyTags(lines) {
  const tags = lines
    .filter((line) => line.trim().startsWith('- '))
    .map((line) => `<span class="competency-tag">${escapeHtml(line.trim().slice(2).trim())}</span>`);
  return tags.join('') || '<p>No skill tags found.</p>';
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

async function main() {
  const args = process.argv.slice(2);
  const cvPath = resolve(args[0] || 'cv.md');
  const outputPath = resolve(args[1] || 'output/cv.html');
  const templatePath = resolve(args[2] || 'templates/cv-template.html');

  const [cvRaw, template] = await Promise.all([
    readFile(cvPath, 'utf8'),
    readFile(templatePath, 'utf8'),
  ]);

  const parsed = parseCv(cvRaw);

  const html = template
    .replace(/{{LANG}}/g, 'en')
    .replace(/{{PAGE_WIDTH}}/g, '840px')
    .replace(/{{NAME}}/g, escapeHtml(parsed.name || ''))
    .replace(/{{EMAIL}}/g, escapeHtml(parsed.email || ''))
    .replace(/{{LINKEDIN_URL}}/g, escapeHtml(parsed.linkedinUrl || '#'))
    .replace(/{{LINKEDIN_DISPLAY}}/g, escapeHtml(parsed.linkedinDisplay || 'LinkedIn'))
    .replace(/{{PORTFOLIO_URL}}/g, escapeHtml(parsed.portfolioUrl || '#'))
    .replace(/{{PORTFOLIO_DISPLAY}}/g, escapeHtml(parsed.portfolioDisplay || 'Portfolio'))
    .replace(/{{LOCATION}}/g, escapeHtml(parsed.location || ''))
    .replace(/{{SECTION_SUMMARY}}/g, 'Professional Summary')
    .replace(/{{SUMMARY_TEXT}}/g, parsed.summaryText || '<p>No profile summary found.</p>')
    .replace(/{{SECTION_COMPETENCIES}}/g, 'Core Competencies')
    .replace(/{{COMPETENCIES}}/g, parsed.competenciesHtml)
    .replace(/{{SECTION_EXPERIENCE}}/g, 'Work Experience')
    .replace(/{{EXPERIENCE}}/g, parsed.experienceHtml || '<p>No work experience found.</p>')
    .replace(/{{SECTION_PROJECTS}}/g, 'Projects')
    .replace(/{{PROJECTS}}/g, parsed.projectsHtml || '<p>No projects found.</p>')
    .replace(/{{SECTION_EDUCATION}}/g, 'Education')
    .replace(/{{EDUCATION}}/g, parsed.educationHtml || '<p>No education found.</p>')
    .replace(/{{SECTION_CERTIFICATIONS}}/g, 'Certifications')
    .replace(/{{CERTIFICATIONS}}/g, parsed.certificationsHtml || '<p>No certifications yet.</p>')
    .replace(/{{SECTION_SKILLS}}/g, 'Skills')
    .replace(/{{SKILLS}}/g, parsed.skillsHtml || '<p>No skills found.</p>');

  await ensureDirectoryExists(outputPath);
  await writeFile(outputPath, html, 'utf8');

  console.log(`✅ HTML generated: ${outputPath}`);
  console.log('Next step: node generate-pdf.mjs', outputPath, outputPath.replace(/\.html$/, '.pdf'));
}

main().catch((error) => {
  console.error('❌ Failed to render CV HTML:', error.message);
  process.exit(1);
});
