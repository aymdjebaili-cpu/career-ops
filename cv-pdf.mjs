/**
 * cv-pdf.mjs — which CV PDF goes out with an application.
 *
 * WHY THIS EXISTS
 * The answer used to be four different answers. auto-apply.mjs read
 * `documents.cv_pdf` from config/profile.yml, the part-time email route hardcoded
 * output/cv-de.pdf, and batch-drafts.mjs / initiativ-drafts.mjs hardcoded the
 * English output/cv-updated.pdf — so the CV a company received depended on which
 * script happened to write the mail. On 2026-09-16 Aimene asked for the German
 * Lebenslauf everywhere, "anywhere even with emails", and that instruction had to
 * be applied in four places at once. Now there is one place: the profile.
 *
 * Change the CV for every route by editing `documents.cv_pdf` in
 * config/profile.yml. `documents.cv_pdf_en` stays available for a caller that
 * deliberately wants the English one — it is never the default.
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const PROJECT_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(PROJECT_DIR, 'config', 'profile.yml');

/** Absolute path to the CV PDF for an application. `lang: 'en'` asks for the English one. */
export function resolveCvPdf({ lang = 'de', relative = false } = {}) {
  let configured = null;
  try {
    const docs = yaml.load(readFileSync(PROFILE, 'utf8'))?.documents || {};
    configured = lang === 'en' ? (docs.cv_pdf_en || docs.cv_pdf) : docs.cv_pdf;
  } catch { /* profile unreadable — fall through to the German default */ }

  // The fallback is the German CV, not the English one: an application that
  // silently shipped the wrong language is the failure this module exists to stop.
  const picked = configured || 'output/cv-de.pdf';
  const abs = isAbsolute(picked) ? picked : join(PROJECT_DIR, picked);
  if (relative) return picked.replace(/\\/g, '/');
  return abs;
}

/** True when the configured CV actually exists on disk — callers warn rather than attach nothing. */
export function cvPdfExists(opts) {
  return existsSync(resolveCvPdf(opts));
}
