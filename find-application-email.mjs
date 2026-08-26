#!/usr/bin/env node
/**
 * find-application-email.mjs — find the address a company PUBLISHES for job
 * applications, by reading their own pages.
 *
 * WHY THIS EXISTS
 * guess-recruiter-email.mjs invents `careers@{domain}` and says so honestly in its
 * own docstring: "This is never verified against a real mailbox." daily-run.mjs
 * then wrote that guess into a Gmail draft anyway, so applications were addressed
 * to inboxes nobody had ever confirmed existed. An application sent to a guessed
 * address is not a long shot, it is a bounce.
 *
 * This module does the opposite: it never constructs an address. It fetches the
 * company's careers / contact / Impressum pages and extracts addresses that are
 * actually written there, keeping the page and the surrounding sentence as
 * evidence. If a company publishes nothing, the answer is null — which is the
 * true answer, and the caller should route to the application portal instead.
 *
 * German sites are the best case here: the Impressum is legally required and
 * usually carries a real address, and careers pages say "Bewerbung an ...".
 *
 * CLI:
 *   node find-application-email.mjs "Company Name" [domain-or-url]
 *
 * Library:
 *   import { findApplicationEmail } from './find-application-email.mjs';
 *   const hit = await findApplicationEmail('Ikarus Tours');
 *   // → { email, source, context, score, verified: true } | null
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolveCompanyDomain } from './guess-recruiter-email.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, 'output', '.application-email-cache.json');
const CACHE_TTL_DAYS = 30;
const FETCH_TIMEOUT_MS = 12_000;

// Paths worth trying, best-evidence first. German spellings included because the
// target market is DACH and those pages are where the address usually lives.
const PATHS = [
  '/karriere', '/jobs', '/careers', '/career',
  '/stellenangebote', '/ueber-uns/jobs', '/unternehmen/karriere',
  '/kontakt', '/contact', '/impressum',
];

// Local parts that indicate an address meant for applications, most specific first.
const LOCAL_PART_SCORE = [
  [/^bewerbung(en)?$/i, 100],
  [/^jobs?$/i, 90],
  [/^karriere$/i, 90],
  [/^personal$/i, 85],
  [/^recruit(ing|ment)$/i, 85],
  [/^hr$/i, 80],
  [/^talent$/i, 80],
  [/^people$/i, 70],
  [/^career[s]?$/i, 70],
  [/^apply$/i, 70],
];

// Never treat these as an application address even if they appear on the page.
const REJECT_LOCAL = /^(no-?reply|noreply|newsletter|presse|press|marketing|sales|info|kontakt|contact|datenschutz|privacy|support|service|buchung|booking|abo)$/i;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Would this address plausibly accept an application? Used to sanity-check
 * addresses harvested elsewhere (e.g. the first email found in a report body,
 * which is just as likely to be the data-protection officer or a press contact).
 */
export function isApplicationInbox(email) {
  const local = String(email ?? '').toLowerCase().split('@')[0];
  if (!local || REJECT_LOCAL.test(local)) return false;
  return LOCAL_PART_SCORE.some(([re]) => re.test(local)) || /bewerb|job|karriere|recruit|hr|talent|people/i.test(local);
}

function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  const dir = dirname(CACHE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

async function fetchText(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-ops/1.7; job application research)' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain/.test(type)) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Strip tags but keep mailto targets, which are the strongest signal on a page. */
function pageToText(html) {
  const mailtos = [...html.matchAll(/mailto:([^"'?>\s]+)/gi)].map(m => decodeURIComponent(m[1]));
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&auml;/gi, 'ä').replace(/&ouml;/gi, 'ö').replace(/&uuml;/gi, 'ü')
    .replace(/&szlig;/gi, 'ß').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ');
  return { text, mailtos };
}

function scoreCandidate(email, { text, mailtos }, domain) {
  const [local, host] = email.toLowerCase().split('@');
  if (REJECT_LOCAL.test(local)) return null;

  const match = LOCAL_PART_SCORE.find(([re]) => re.test(local));
  let score = match ? match[1] : 0;
  if (score === 0) return null;

  const inMailto = mailtos.some(m => m.toLowerCase().startsWith(email.toLowerCase()));

  // Prefer the company's own domain: a third-party address on a careers page is
  // usually an agency, a footer or someone else's tracking. But sibling domains
  // are real — Wikinger Reisen publishes jobs@wikinger.de on wikinger-reisen.de —
  // so allow an off-domain address only when the company links it themselves in a
  // mailto, and make it earn the extra confidence.
  // Compare the registrable name, not the whole host. resolveCompanyDomain()
  // guesses a TLD in a fixed order (.com before .de), so a German employer whose
  // site answers on both is just as likely to be resolved as homaris.com — and
  // then their real karriere@homaris.de looked like a stranger's address and
  // took the off-domain penalty. Same name, different TLD, same company.
  const label = (h) => h.replace(/^www\./, '').split('.').slice(-2, -1)[0] ?? h;
  const bare = domain ? domain.replace(/^www\./, '') : '';
  const ownDomain = !domain || host.endsWith(bare) || label(host) === label(bare);
  if (!ownDomain && !inMailto) return null;
  if (!ownDomain) score -= 20;

  if (inMailto) score += 15;

  // A nearby application verb is what separates "the HR inbox" from "an address
  // that happens to sit in the footer".
  const idx = text.toLowerCase().indexOf(email.toLowerCase());
  const context = idx > -1 ? text.slice(Math.max(0, idx - 220), idx + 120).trim() : '';
  if (/bewerb|initiativ|lebenslauf|unterlagen|applicat|apply|cv\b|resume|anschreiben/i.test(context)) score += 25;

  return { email: email.toLowerCase(), score, context };
}

/**
 * @param {string} companyName
 * @param {string} [domainHint] domain or URL to search instead of guessing one
 * @returns {Promise<{email:string, source:string, context:string, score:number, verified:true}|null>}
 */
export async function findApplicationEmail(companyName, domainHint, postingUrl) {
  if (!companyName && !domainHint && !postingUrl) return null;

  const cacheKey = `${(companyName ?? '').trim().toLowerCase()}::${(domainHint ?? '').toLowerCase()}::${(postingUrl ?? '').toLowerCase()}`;
  const cache = loadCache();
  const hit = cache[cacheKey];
  if (hit && (Date.now() - new Date(hit.checkedAt).getTime()) / 86_400_000 < CACHE_TTL_DAYS) {
    return hit.result ? { ...hit.result, cached: true } : null;
  }

  // A hint may be a bare domain or a full careers URL. When it carries a path,
  // that exact page is tried first — configs already hold the real careers_url,
  // and guessing /jobs when the site uses /ueberuns/jobs.php just wastes fetches.
  let domain = null;
  let seedUrl = null;
  if (domainHint) {
    const hasScheme = /^https?:\/\//i.test(domainHint);
    const stripped = domainHint.replace(/^https?:\/\//i, '');
    domain = stripped.replace(/\/.*$/, '').replace(/^www\./, '');
    const path = stripped.slice(stripped.indexOf('/'));
    if (stripped.includes('/') && path.length > 1) seedUrl = hasScheme ? domainHint : `https://${stripped}`;
  } else {
    domain = await resolveCompanyDomain(companyName);
  }

  // `postingUrl` is a page to READ, never a statement about who the employer is.
  // Most postings here live on job boards, and employers routinely print their
  // own bewerbung@ inside the ad — that address is genuinely published and worth
  // having. But the board's domain must not become `domain`, or the sibling-
  // domain rule inverts: the board's own recruiting inbox would score as
  // "company's own domain" while the employer's real address gets the -20
  // penalty. Scraped as a page and scored against the employer's domain, the
  // employer's address wins and the board's cannot clear the threshold.
  const pages = [...new Set([
    ...(seedUrl ? [seedUrl] : []),
    ...(postingUrl && /^https?:\/\//i.test(postingUrl) ? [postingUrl] : []),
    ...(domain ? PATHS.map(p => `https://${domain}${p}`) : []),
  ])];

  let best = null;
  for (const url of pages) {
      const html = await fetchText(url);
      if (!html) continue;

      const page = pageToText(html);
      // A mailto href is not an address. It can carry trailing markup, an escape
      // character or a display suffix, and the old code only TESTED the href
      // before adding the raw string to the set — which is how
      // `karriere@homaris.de\` reached a To header and Gmail answered
      // "Invalid To header". Extract the address out of the href instead of
      // trusting its shape. (EMAIL_RE is /g, so .test() also advanced lastIndex
      // between hrefs and silently skipped every other one; String.match resets
      // it, so this fixes that too.)
      const found = new Set([
        ...(page.text.match(EMAIL_RE) ?? []),
        ...page.mailtos.flatMap(m => m.match(EMAIL_RE) ?? []),
      ]);

      for (const raw of found) {
        const cand = scoreCandidate(raw.replace(/[.,;:]$/, ''), page, domain);
        if (cand && (!best || cand.score > best.score)) best = { ...cand, source: url };
      }
    // A high-confidence hit on a careers page is as good as it gets; stop early
    // rather than hammering seven more URLs.
    if (best && best.score >= 115) break;
  }

  const result = best && best.score >= 85
    ? { email: best.email, source: best.source, context: best.context.slice(0, 240), score: best.score, verified: true }
    : null;

  cache[cacheKey] = { checkedAt: new Date().toISOString(), result };
  saveCache(cache);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [company, hint, posting] = process.argv.slice(2);
  if (!company) {
    console.error('Usage: node find-application-email.mjs "Company Name" [domain-or-careers-url] [posting-url]');
    process.exit(1);
  }
  const hit = await findApplicationEmail(company, hint, posting);
  console.log(hit ? JSON.stringify(hit, null, 2) : 'NO PUBLISHED APPLICATION ADDRESS — apply through their portal');
}
