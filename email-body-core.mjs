#!/usr/bin/env node
/**
 * email-body-core.mjs — builds the text of the application email itself.
 *
 * WHY THIS EXISTS
 * daily-run.mjs and batch-drafts.mjs both used to write a two-line body
 * ("Please find attached my CV and a tailored cover letter for {role}") and leave
 * the entire pitch inside the attached PDF. That is the wrong way round: a
 * recruiter opening the mail sees no statement of intent, no evidence of fit and
 * no offer, so nothing gives them a reason to open the attachment at all.
 *
 * generate-cover-letter.mjs has already written a tailored letter that says all
 * three things. So the body is built FROM that letter rather than ignoring it:
 *   greeting (the letter's own)
 *   + one explicit "I am applying for {role}" line
 *   + the letter's argument paragraphs
 *   + a line pointing at the attachments
 *   + signature (the letter's own)
 * Reusing the letter's greeting and signature keeps the mail and the attached PDF
 * from disagreeing about how they open and sign off.
 *
 * ALSO HERE: languageSlug(). A report whose `**Language:**` reads `EN/DE` used to
 * be interpolated raw into the cover-letter path, and the slash turned
 * `output/cover-letters/432-wolt-en.md` into a *directory* `432-wolt-en/de.md`.
 * basename() then recorded COVER_LETTER_PATH as `output/cover-letters/de.md`,
 * which resolves to nothing — so that draft went to Gmail with no letter attached.
 * Every path that embeds a language must go through languageSlug().
 *
 * Pure string functions; the only I/O is the optional profile read at the bottom.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ─────────────────────────────────────────────
// Language handling
// ─────────────────────────────────────────────
const SUPPORTED = ['DE', 'FR', 'EN'];

/** 'EN/DE' → 'EN'; 'de' → 'DE'; junk → 'EN'. */
export function normalizeLanguage(raw) {
  const first = String(raw ?? '').trim().split(/[/,|\s]+/)[0].toUpperCase();
  return SUPPORTED.includes(first) ? first : 'EN';
}

/** Filename-safe language token. NEVER interpolate a raw language into a path. */
export function languageSlug(raw) {
  return normalizeLanguage(raw).toLowerCase();
}

// ─────────────────────────────────────────────
// Letter parsing
// ─────────────────────────────────────────────
const GREETING = {
  DE: /^(sehr geehrte|sehr geehrter|guten tag|hallo|liebe)/i,
  FR: /^(madame|monsieur|bonjour|chère|cher)\b/i,
  EN: /^(dear|hello|hi)\b/i,
};

const SIGNOFF = {
  DE: /^(mit freundlichen gr[üu]ßen|freundliche gr[üu]ße|beste gr[üu]ße|herzliche gr[üu]ße|viele gr[üu]ße)/i,
  FR: /^(cordialement|bien cordialement|sinc[èe]res salutations|veuillez agr[ée]er|respectueusement)/i,
  EN: /^(best regards|kind regards|warm regards|yours sincerely|yours faithfully|sincerely|regards|best)\b[,.]?$/i,
};

const anyMatch = (line, table) => SUPPORTED.some(l => table[l].test(line));

function stripFrontmatter(md) {
  const text = String(md ?? '').replace(/^﻿/, '');
  // Leading `---\n ... \n---` only. A `---` further down is a horizontal rule.
  const m = text.match(/^\s*---\r?\n[\s\S]*?\r?\n---\s*\r?\n/);
  return (m ? text.slice(m[0].length) : text).trim();
}

const paragraphs = (text) => text.split(/\r?\n\s*\r?\n/).map(p => p.trim()).filter(Boolean);

/**
 * The mail goes out as text/plain, so markdown emphasis would reach the employer
 * as literal asterisks — `*prise en charge*` really does appear in these letters.
 * The PDF renderer converts the same markup to <em>/<strong>; here it is dropped.
 */
function toPlainText(s) {
  return s
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    // The closing marker only has to not be followed by a word character —
    // requiring whitespace or punctuation missed `*prise en charge*-Verfahren`,
    // which is exactly the construction these German letters use.
    .replace(/(^|[\s(])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/gs, '$1$2')
    .replace(/(^|[\s(])_(?!\s)(.+?)(?<!\s)_(?!\w)/gs, '$1$2')
    .replace(/^#{1,6}\s+/gm, '');
}

/**
 * Split a letter into { greeting, argument, signature }.
 * `argument` is what actually makes the case — the part worth putting in the mail.
 */
export function splitLetter(letterMarkdown) {
  const paras = paragraphs(stripFrontmatter(letterMarkdown));
  if (paras.length === 0) return { greeting: null, argument: [], signature: null };

  let greeting = null;
  if (anyMatch(paras[0].split('\n')[0], GREETING) && paras[0].split('\n').length <= 2) {
    greeting = paras.shift();
  }

  // The sign-off paragraph is usually "Best regards,\nNAME\nemail" as one block.
  // Cut from the first paragraph whose opening line is a sign-off; everything
  // after it is contact detail, never argument.
  let signature = null;
  const sigIdx = paras.findIndex(p => anyMatch(p.split('\n')[0].trim(), SIGNOFF));
  if (sigIdx > -1) {
    signature = paras.slice(sigIdx).join('\n');
    paras.length = sigIdx;
  } else {
    // No recognised sign-off: drop a trailing bare contact block if there is one.
    const last = paras[paras.length - 1];
    if (last && last.length < 140 && /@/.test(last) && last.split('\n').length <= 4) {
      signature = paras.pop();
    }
  }

  return { greeting, argument: paras, signature };
}

/** Trust the letter's own greeting over a report field that may say "EN/DE". */
export function detectLanguage(letterMarkdown, declared) {
  const { greeting } = splitLetter(letterMarkdown ?? '');
  if (greeting) {
    const head = greeting.split('\n')[0];
    for (const lang of SUPPORTED) if (GREETING[lang].test(head)) return lang;
  }
  return normalizeLanguage(declared);
}

// ─────────────────────────────────────────────
// Phrasing
// ─────────────────────────────────────────────
const PHRASES = {
  EN: {
    greeting: 'Dear Hiring Team,',
    // German convention continues the sentence after the comma, so DE/FR stay
    // lowercase here on purpose.
    intent: (role, company) => `I am writing to apply for the ${role} position${company ? ` at ${company}` : ''}.`,
    attachments: { both: 'My CV and full cover letter are attached as PDFs.', cv: 'My CV is attached as a PDF.', letter: 'My full cover letter is attached as a PDF.' },
    signoff: 'Best regards,',
  },
  DE: {
    greeting: 'Sehr geehrte Damen und Herren,',
    intent: (role, company) => `hiermit bewerbe ich mich auf die Position als ${role}${company ? ` bei ${company}` : ''}.`,
    attachments: { both: 'Meinen Lebenslauf sowie das vollständige Anschreiben finden Sie im Anhang.', cv: 'Meinen Lebenslauf finden Sie im Anhang.', letter: 'Das vollständige Anschreiben finden Sie im Anhang.' },
    signoff: 'Mit freundlichen Grüßen',
  },
  FR: {
    greeting: 'Madame, Monsieur,',
    intent: (role, company) => `je vous écris afin de poser ma candidature au poste de ${role}${company ? ` chez ${company}` : ''}.`,
    attachments: { both: 'Vous trouverez mon CV et ma lettre de motivation complète en pièces jointes.', cv: 'Vous trouverez mon CV en pièce jointe.', letter: 'Vous trouverez ma lettre de motivation complète en pièce jointe.' },
    signoff: 'Cordialement,',
  },
};

// ─────────────────────────────────────────────
// Brevity
// ─────────────────────────────────────────────
/**
 * Word budget for the argument section of the mail.
 *
 * The mail used to carry the whole letter, so it arrived as four or five dense
 * paragraphs — and the attached PDF then said the same thing again. That is the
 * wrong division of labour. The full case belongs in the attachment; the mail's
 * only job is to make an HR reader open it, and they decide that on the first
 * screen. So: state the role, make the two strongest points, name the
 * attachments, sign off.
 *
 * `standard` is for speculative applications, which have to explain an
 * unsolicited proposition before any of it makes sense — that costs a few more
 * words than replying to a posting the reader already knows.
 */
export const BODY_WORDS = { short: 110, standard: 150, full: Infinity };

/**
 * Paragraphs that are manners rather than argument. They belong in the letter,
 * where there is room to be gracious; in a four-paragraph mail they push the
 * evidence below the fold.
 */
const CLOSING_FILLER = /^(über eine einladung|ich freue mich|gerne stehe ich|für rückfragen|selbstverständlich|sehr gerne stelle ich|i (would |'d )?(welcome|look forward|am available|am happy)|happy to|please (feel free|do not hesitate)|je me tiens|dans l'attente|n'hésitez pas)/i;

/** The letter's own opening claim of intent — ours would then say it twice. */
const INTENT_ECHO = /^(hiermit bewerbe ich mich|ich bewerbe mich|mit gro(ß|ss)em interesse|ihre (stellen)?ausschreibung|i am writing to apply|i am applying|i would like to apply|je vous écris|je souhaite poser)/i;

const wordCount = (s) => String(s).split(/\s+/).filter(Boolean).length;

/**
 * Does this text already name the job? Used to decide whether the letter's own
 * opener can stand in for the generated "I am applying for {role}" line. Gender
 * tags and seniority noise are stripped first, so "(Junior) Project Manager
 * (x/f/m)" is matched on `project` + `manager`.
 */
function mentionsRole(text, role) {
  const words = String(role ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .split(/[^a-zà-ÿ]+/i)
    .filter(w => w.length >= 4);
  if (!words.length) return false;
  const hay = String(text).toLowerCase();
  return words.filter(w => hay.includes(w)).length >= Math.ceil(words.length / 2);
}

/**
 * Trim the letter's argument down to the word budget, keeping whole paragraphs.
 *
 * Order is preserved rather than re-ranked: these letters are written hook-first
 * (why this employer), evidence-second, so the front of the letter is already
 * the part worth mailing. One paragraph always survives, even if it is over
 * budget on its own — a body cut to nothing would be worse than a long one.
 */
function condense(argument, maxWords) {
  if (!Number.isFinite(maxWords)) return argument;
  const pool = argument.filter(p => !CLOSING_FILLER.test(p.trim()));
  const paras = pool.length ? pool : argument;

  const kept = [];
  let used = 0;
  for (const p of paras) {
    const n = wordCount(p);
    if (kept.length && used + n > maxWords) break;
    kept.push(p);
    used += n;
    if (used >= maxWords) break;
  }
  return kept;
}

/**
 * The attachment sentence must describe what save-drafts.mjs will actually
 * attach. Promising a cover letter that is not on the message is the kind of
 * detail a recruiter notices — and daily-run.mjs drafts really did carry the CV
 * alone while the body claimed otherwise.
 */
function attachmentLine(lang, attachments) {
  const { cv = true, letter = true } = attachments ?? {};
  if (cv && letter) return PHRASES[lang].attachments.both;
  if (cv) return PHRASES[lang].attachments.cv;
  if (letter) return PHRASES[lang].attachments.letter;
  return '';
}

/**
 * Fallback body, used only when no usable letter exists. Still states intent and
 * points at the attachments — it just cannot make a tailored case.
 */
function fallbackBody({ role, company, language, signature, attachments }) {
  const p = PHRASES[language];
  return [p.greeting, '', p.intent(role, company), '', attachmentLine(language, attachments), '', signature]
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────
/**
 * @param {object}  o
 * @param {string} [o.letterMarkdown]   contents of output/cover-letters/{...}.md
 * @param {string}  o.role
 * @param {string} [o.company]
 * @param {string} [o.language]         declared language, e.g. 'DE' or 'EN/DE'
 * @param {{name: string, email: string}} [o.candidate]  signature fallback
 * @param {{cv?: boolean, letter?: boolean}} [o.attachments]  what will really be attached
 * @param {string|null} [o.intentLine]  replaces the "applying for {role}" opener —
 *        pass a custom one for a speculative application, where no posted role
 *        exists to apply for, or null to drop the opener entirely.
 * @param {number} [o.maxWords]         argument budget; see BODY_WORDS
 * @returns {{ body: string, language: string, source: 'cover-letter'|'fallback', words: number }}
 */
export function buildEmailBody({ letterMarkdown, role, company, language, candidate, attachments, intentLine, maxWords = BODY_WORDS.short }) {
  const who = candidate ?? { name: '', email: '' };
  const lang = detectLanguage(letterMarkdown, language);
  const p = PHRASES[lang];

  const defaultSignature = [p.signoff, who.name, who.email].filter(Boolean).join('\n');

  if (!letterMarkdown || !letterMarkdown.trim()) {
    const body = fallbackBody({ role, company, language: lang, signature: defaultSignature, attachments });
    return { body, language: lang, source: 'fallback', words: wordCount(body) };
  }

  // `undefined` means "use the default opener"; an explicit null suppresses it.
  let opener = intentLine === undefined ? p.intent(role, company) : (intentLine ?? '');

  const { greeting, argument, signature } = splitLetter(letterMarkdown);

  // A letter that parsed down to almost nothing means the format was unexpected;
  // sending its fragments would be worse than the honest fallback.
  if (wordCount(argument.join(' ')) < 40) {
    const body = fallbackBody({ role, company, language: lang, signature: signature || defaultSignature, attachments });
    return { body, language: lang, source: 'fallback', words: wordCount(body) };
  }

  // If the letter opens by applying for this same named role, the generated
  // opener would be the same sentence twice — two lines apart, in a mail whose
  // whole point is brevity. The letter's version is the tailored one, so it wins.
  const kept = condense(argument, maxWords);
  if (opener && kept.length && INTENT_ECHO.test(kept[0].trim()) && mentionsRole(kept[0], role)) {
    opener = '';
  }

  const body = [
    greeting || p.greeting,
    '',
    opener,
    '',
    kept.map(toPlainText).join('\n\n'),
    '',
    attachmentLine(lang, attachments),
    '',
    toPlainText(signature || defaultSignature),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  return { body, language: lang, source: 'cover-letter', words: wordCount(body) };
}

/**
 * Recover letter text from a generated HTML letter (batch-drafts.mjs writes these
 * instead of markdown, and some older runs left only the .html + .pdf on disk).
 * The markup is ours, so its shape is known: greeting div, <p> paragraphs,
 * closing div, signature div.
 */
export function htmlLetterToText(html) {
  if (!html) return null;
  const blocks = [...html.matchAll(/<(p|div)\b[^>]*class="(?:greeting|closing|signature)"[^>]*>([\s\S]*?)<\/\1>|<p>([\s\S]*?)<\/p>/g)]
    .map(m => (m[2] ?? m[3] ?? ''))
    .map(t => t
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .split('\n').map(l => l.trim()).filter(Boolean).join('\n')
      .trim())
    .filter(Boolean);
  return blocks.length ? blocks.join('\n\n') : null;
}

/** Read the letter for an email file, tolerating a missing/renamed path. */
export function readLetter(projectDir, relPath) {
  if (!relPath) return null;
  const full = join(projectDir, relPath);
  if (!existsSync(full)) return null;
  try { return readFileSync(full, 'utf8'); } catch { return null; }
}

/** name/email for the signature fallback, from config/profile.yml. */
export function loadCandidate(projectDir) {
  const fallback = { name: '', email: '' };
  const file = join(projectDir, 'config', 'profile.yml');
  if (!existsSync(file)) return fallback;
  try {
    const raw = readFileSync(file, 'utf8');
    const grab = (key) => raw.match(new RegExp(`^\\s*${key}:\\s*["']?([^"'#\\n]+)`, 'm'))?.[1]?.trim() ?? '';
    return { name: grab('full_name') || fallback.name, email: grab('email') || fallback.email };
  } catch {
    return fallback;
  }
}
