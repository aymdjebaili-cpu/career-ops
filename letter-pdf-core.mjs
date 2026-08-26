#!/usr/bin/env node
/**
 * letter-pdf-core.mjs — render a markdown cover letter to a PDF.
 *
 * WHY
 * The same renderer existed inline in auto-apply.mjs (ensureCoverPdf) and
 * initiativ-drafts.mjs (renderPdf), while daily-run.mjs had none — so its Gmail
 * drafts went out with the CV alone, even though the body promised "a tailored
 * cover letter" as well. One implementation, so every path produces the same look
 * and no path silently skips the letter.
 *
 * Markdown emphasis is converted rather than passed through: nothing downstream
 * parses markdown, so a stray **bold** would print as literal asterisks in the
 * document an employer reads.
 */

import { readFileSync, existsSync } from 'fs';

const CSS = `
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.55; color: #1a1a1a; max-width: 17cm; margin: 0 auto; }
  p { margin: 0 0 0.9em 0; text-align: justify; }
`;

export function letterMarkdownToHtml(raw) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = esc(String(raw).replace(/^---[\s\S]*?---\s*/, '').trim())
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    // Closing marker just must not be followed by a word character: the earlier
    // "whitespace or punctuation" rule left `*prise en charge*-Verfahren` as
    // literal asterisks in a PDF an employer reads.
    .replace(/(^|[\s(])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/gs, '$1<em>$2</em>')
    .replace(/^#{1,6}\s+/gm, '');
  const paras = body.split(/\n\s*\n/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
  return `<html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${paras}</body></html>`;
}

/**
 * @param {import('playwright').Browser} browser
 * @param {string} mdPath  path to the letter markdown
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<string>} path to the PDF
 */
export async function renderLetterPdf(browser, mdPath, opts = {}) {
  const pdfPath = mdPath.replace(/\.md$/i, '.pdf');
  if (existsSync(pdfPath) && !opts.force) return pdfPath;

  const page = await browser.newPage();
  try {
    await page.setContent(letterMarkdownToHtml(readFileSync(mdPath, 'utf8')), { waitUntil: 'load' });
    await page.pdf({ path: pdfPath, format: 'A4', margin: { top: '2.2cm', bottom: '2.2cm', left: '2cm', right: '2cm' } });
  } finally {
    await page.close();
  }
  return pdfPath;
}

/** Launch chromium, run fn, always close. Playwright is imported lazily. */
export async function withBrowser(fn) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try { return await fn(browser); }
  finally { await browser.close(); }
}
