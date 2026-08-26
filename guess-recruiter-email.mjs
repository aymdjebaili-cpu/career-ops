#!/usr/bin/env node
/**
 * guess-recruiter-email.mjs — free, no-signup fallback for finding a company contact email.
 *
 * No API, no login. Guesses the company's real domain (tries common TLDs, verifies the
 * domain actually resolves) then guesses a plausible inbox at that domain:
 *   - a generic role inbox (careers@, jobs@, hr@, ...) when no contact name is known
 *   - firstname@domain / firstname.lastname@domain when a name IS known
 *
 * This is never verified against a real mailbox — no SMTP probing (unreliable, easily
 * mistaken for abuse). Every result is marked unverified; treat it as a starting guess
 * to sanity-check before sending, not a confirmed address.
 *
 * CLI usage (manual test):
 *   node guess-recruiter-email.mjs "Company Name" [FirstName] [LastName]
 *
 * Library usage:
 *   import { guessRecruiterEmail } from './guess-recruiter-email.mjs';
 *   const hit = await guessRecruiterEmail('Finmid');
 *   // -> { email, allCandidates, domain, confidence: 'guessed-generic'|'guessed-personal', verified: false } | null
 *
 * ⚠️ NOT WIRED INTO THE PIPELINE — DO NOT RE-ADD IT.
 * daily-run.mjs used to fall back to this when no real address was found, so job
 * applications went to Gmail drafts addressed to `careers@{domain}` inboxes that
 * were never confirmed to exist. In the draft they looked identical to verified
 * ones. Use findApplicationEmail() from find-application-email.mjs instead: it
 * only returns addresses a company actually publishes, with the page and sentence
 * as evidence, and returns null — meaning "apply through the portal" — otherwise.
 *
 * resolveCompanyDomain() below is still used and is fine: it resolves a real
 * domain via DNS, it does not invent a mailbox.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const CACHE_FILE = join(PROJECT_DIR, 'output', '.email-guess-cache.json');
const CACHE_TTL_DAYS = 30;

const GENERIC_INBOXES = ['careers', 'jobs', 'hr', 'talent', 'recruiting', 'people'];
const TLDS = ['com', 'io', 'de', 'co'];
const STOPWORDS = /\b(gmbh|co\s*kg|inc|ltd|llc|ag|corp|corporation|company|group|technologies|technology|labs|holding|se)\b/g;

function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveCache(cache) {
  const outDir = dirname(CACHE_FILE);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function slugCompany(name) {
  return name
    .toLowerCase()
    .replace(STOPWORDS, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

async function domainResolves(domain) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://${domain}`, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    // Any response (even 403/404) means something real is listening — only hard
    // failures (DNS/connection errors, caught below) mean "doesn't exist".
    return res.status < 500;
  } catch {
    return false;
  }
}

/** @param {string} companyName @returns {Promise<string|null>} */
export async function resolveCompanyDomain(companyName) {
  const slug = slugCompany(companyName);
  if (!slug) return null;
  for (const tld of TLDS) {
    const domain = `${slug}.${tld}`;
    if (await domainResolves(domain)) return domain;
  }
  return null;
}

/**
 * @param {string} companyName
 * @param {{firstName?: string, lastName?: string}} contact
 * @returns {Promise<{email:string, allCandidates:string[], domain:string, confidence:string, verified:false, cached?:boolean}|null>}
 */
export async function guessRecruiterEmail(companyName, contact = {}) {
  if (!companyName || companyName === 'Unknown') return null;

  const cacheKey = `${companyName.trim().toLowerCase()}::${(contact.firstName || '').toLowerCase()}::${(contact.lastName || '').toLowerCase()}`;
  const cache = loadCache();
  const hit = cache[cacheKey];
  if (hit) {
    const ageDays = (Date.now() - new Date(hit.checkedAt).getTime()) / 86_400_000;
    if (ageDays < CACHE_TTL_DAYS) return hit.result ? { ...hit.result, cached: true } : null;
  }

  const domain = await resolveCompanyDomain(companyName);
  let result = null;

  if (domain) {
    if (contact.firstName) {
      const fn = contact.firstName.toLowerCase().replace(/[^a-z]/g, '');
      const ln = (contact.lastName || '').toLowerCase().replace(/[^a-z]/g, '');
      const candidates = ln
        ? [`${fn}.${ln}@${domain}`, `${fn}@${domain}`, `${fn[0]}${ln}@${domain}`]
        : [`${fn}@${domain}`];
      result = { email: candidates[0], allCandidates: candidates, domain, confidence: 'guessed-personal', verified: false };
    } else {
      const candidates = GENERIC_INBOXES.map(g => `${g}@${domain}`);
      result = { email: candidates[0], allCandidates: candidates, domain, confidence: 'guessed-generic', verified: false };
    }
  }

  cache[cacheKey] = { checkedAt: new Date().toISOString(), result };
  saveCache(cache);
  return result;
}

// ─────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [company, firstName, lastName] = process.argv.slice(2);
  if (!company) {
    console.error('Usage: node guess-recruiter-email.mjs "Company Name" [FirstName] [LastName]');
    process.exit(1);
  }
  const hit = await guessRecruiterEmail(company, { firstName, lastName });
  console.log(hit ? JSON.stringify(hit, null, 2) : 'no domain found — could not guess an email');
}
