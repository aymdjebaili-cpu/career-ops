#!/usr/bin/env node
/**
 * find-recruiter-email.mjs — looks up a recruiter/HR contact email for a company via Hunter.io
 *
 * Setup: sign up free at hunter.io, then write your API key to config/hunter-api-key.json:
 *   {"apiKey": "..."}
 *
 * CLI usage (manual test):
 *   node find-recruiter-email.mjs "Company Name"
 *
 * Library usage:
 *   import { findRecruiterEmail } from './find-recruiter-email.mjs';
 *   const hit = await findRecruiterEmail('Finmid');
 *   // -> { email, confidence, name, position, domain } | null
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const KEY_FILE = join(PROJECT_DIR, 'config', 'hunter-api-key.json');
const CACHE_FILE = join(PROJECT_DIR, 'output', '.hunter-cache.json');
const CACHE_TTL_DAYS = 30;

function loadApiKey() {
  if (!existsSync(KEY_FILE)) return null;
  try { return JSON.parse(readFileSync(KEY_FILE, 'utf8')).apiKey || null; }
  catch { return null; }
}

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

function cacheKey(company) {
  return company.trim().toLowerCase();
}

// Recruiting/HR titles score highest; hiring-manager-ish titles are a fallback signal.
function priorityOf(entry) {
  const text = `${entry.position || ''} ${entry.department || ''}`.toLowerCase();
  if (/recruit|talent\s*acquisition|people\s*(ops|operations|team)|\bhr\b|human\s*resources/.test(text)) return 3;
  if (/hiring\s*manager|head\s*of|director|founder|ceo|coo|cto/.test(text)) return 1;
  return 0;
}

/**
 * @param {string} companyName
 * @returns {Promise<{email:string, confidence:number, name:string, position:string, domain:string, cached?:boolean} | null>}
 */
export async function findRecruiterEmail(companyName) {
  if (!companyName || companyName === 'Unknown') return null;

  const apiKey = loadApiKey();
  if (!apiKey) return null; // not configured — caller should fall back silently

  const key = cacheKey(companyName);
  const cache = loadCache();
  const hit = cache[key];
  if (hit) {
    const ageDays = (Date.now() - new Date(hit.checkedAt).getTime()) / 86_400_000;
    if (ageDays < CACHE_TTL_DAYS) {
      return hit.result ? { ...hit.result, cached: true } : null;
    }
  }

  let result = null;
  try {
    const url = `https://api.hunter.io/v2/domain-search?company=${encodeURIComponent(companyName)}&api_key=${apiKey}&limit=20`;
    const res = await fetch(url);
    const json = await res.json();

    if (json?.errors?.length) {
      const id = json.errors[0].id || '';
      if (id === 'insufficient_credits' || res.status === 429) {
        console.warn(`   ⚠️ Hunter.io quota exhausted — skipping recruiter-email lookups until it resets`);
      }
      // Cache the miss briefly so a bad company name doesn't get retried every run this month
      cache[key] = { checkedAt: new Date().toISOString(), result: null };
      saveCache(cache);
      return null;
    }

    const emails = (json?.data?.emails || []).filter(e => e.value && e.confidence >= 50);
    emails.sort((a, b) => priorityOf(b) - priorityOf(a) || b.confidence - a.confidence);

    if (emails.length) {
      const best = emails[0];
      result = {
        email: best.value,
        confidence: best.confidence,
        name: [best.first_name, best.last_name].filter(Boolean).join(' ') || null,
        position: best.position || null,
        domain: json?.data?.domain || null,
      };
    }
  } catch (e) {
    console.warn(`   ⚠️ Hunter.io lookup failed for "${companyName}": ${e.message}`);
    return null;
  }

  cache[key] = { checkedAt: new Date().toISOString(), result };
  saveCache(cache);
  return result;
}

// ─────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const company = process.argv.slice(2).join(' ');
  if (!company) {
    console.error('Usage: node find-recruiter-email.mjs "Company Name"');
    process.exit(1);
  }
  if (!loadApiKey()) {
    console.error('❌ config/hunter-api-key.json missing. Sign up free at hunter.io, then write {"apiKey": "..."} there.');
    process.exit(1);
  }
  const hit = await findRecruiterEmail(company);
  console.log(hit ? JSON.stringify(hit, null, 2) : 'no match found');
}
