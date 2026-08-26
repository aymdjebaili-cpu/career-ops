#!/usr/bin/env node
/**
 * scan-boards.mjs — aggregator job-board scanner (RSS/JSON, zero LLM cost)
 *
 * Complements scan.mjs (which hits company ATS APIs) with public job boards:
 *   - germantechjobs      → https://germantechjobs.de/rss            (RSS)
 *   - englishjobsgermany  → https://englishjobsgermany.com/api/jobs  (JSON API, paginated)
 *   - berlinstartupjobs   → https://berlinstartupjobs.com/feed/      (RSS, Cloudflare → Playwright fallback)
 *   - arbeitnow           → https://www.arbeitnow.com/api/job-board-api (JSON API, paginated)
 *   - arbeitsagentur      → official Bundesagentur für Arbeit job search API (JSON, one fetch per query term — see portals.yml)
 *
 * Boards are configured under `boards:` in portals.yml (user layer). Title and
 * location filters are the same `title_filter` / `location_filter` sections
 * scan.mjs uses. New offers land in data/pipeline.md "## Pendientes" and
 * data/scan-history.tsv, identical to scan.mjs.
 *
 * Usage:
 *   node scan-boards.mjs             # scan all enabled boards
 *   node scan-boards.mjs --dry-run   # show what would be added, write nothing
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { namesAPlace } from './location-core.mjs';
import yaml from 'js-yaml';

const PORTALS_PATH = 'portals.yml';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';

const DRY_RUN = process.argv.includes('--dry-run');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const DEFAULT_BOARDS = {
  germantechjobs: { enabled: true, rss: 'https://germantechjobs.de/rss', max_items: 300 },
  englishjobsgermany: { enabled: true, api: 'https://englishjobsgermany.com/api/jobs', max_pages: 3 },
  berlinstartupjobs: { enabled: true, rss: 'https://berlinstartupjobs.com/feed/' },
  arbeitnow: { enabled: true, api: 'https://www.arbeitnow.com/api/job-board-api', max_pages: 3 },
  arbeitsagentur: {
    enabled: true,
    api: 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs',
    size: 100,
    queries: ['Junior', 'Werkstudent', 'Trainee', 'Praktikum', 'Operations', 'Customer Support', 'Account Manager', 'Business Development'],
  },
};

// Senior-and-above levels the EJG API labels explicitly — junior-only policy skips them for free
const SKIP_LEVELS = ['senior', 'lead', 'principal', 'staff', 'head', 'director'];

// ── Filters (same semantics as scan.mjs) ────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const excludeCountries = (locationFilter.exclude_countries || []).map(s => s.toLowerCase());
  const excludeCities    = (locationFilter.exclude_cities || []).map(s => s.toLowerCase());
  const allowedCountries = (locationFilter.allowed_countries || []).map(s => s.toLowerCase());
  const allowedCities    = (locationFilter.allowed_cities || []).map(s => s.toLowerCase());
  const allowedRemote    = (locationFilter.allowed_remote || []).map(s => s.toLowerCase());

  const looksHeadquarter = (s) => /\b(headquarter|hq)\b/.test(s);
  const matchesWord = (lower, kw) => {
    if (lower.includes(kw)) {
      const re = new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
      return re.test(lower);
    }
    return false;
  };
  // Word-boundary matched — see scan.mjs: substring matching lets the allowed
  // country "DE" whitelist "Copenhagen, DEnmark" and "BelgraDE, Serbia".
  const hasAllowedHit = (lower) =>
    allowedCountries.some(k => matchesWord(lower, k)) ||
    allowedCities.some(k => matchesWord(lower, k)) ||
    allowedRemote.some(k => matchesWord(lower, k));

  return (location) => {
    if (!location) return true;
    const lower = location.toLowerCase().trim();
    if (lower === '' || lower === 'remote' || lower === 'n/a') return true;
    if (looksHeadquarter(lower)) return true;
    if (hasAllowedHit(lower)) return true;
    if (excludeCountries.some(k => matchesWord(lower, k))) return false;
    if (excludeCities.some(k => matchesWord(lower, k))) return false;

    // Strict allowlist — see the same block in scan.mjs. Without it the default is
    // "keep", so any country absent from exclude_countries leaks through.
    if (locationFilter.strict_allowlist && (allowedCountries.length || allowedCities.length)) {
      if (namesAPlace(lower)) return false;
    }

    return true;
  };
}

// ── Dedup (same sources as scan.mjs) ────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) seen.add(match[1]);
  }
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) seen.add(match[0]);
  }
  return seen;
}

// ── Fetch helpers ───────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// Cloudflare-protected feeds (berlinstartupjobs) need a real browser
async function fetchTextViaPlaywright(url) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: UA });
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000); // let a Cloudflare JS challenge settle
    if (resp && resp.status() < 400) {
      try { return await resp.text(); } catch { /* body consumed — fall through */ }
    }
    return await page.content();
  } finally {
    await browser.close();
  }
}

const isCloudflareChallenge = (text) =>
  text.includes('Attention Required! | Cloudflare') || text.includes('cf-challenge') || text.includes('Just a moment');

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#0?38;/g, '&').replace(/&#8211;/g, '–').replace(/&#8217;/g, "'")
    .trim();
}

function parseRssItems(xml) {
  const items = [];
  for (const chunk of xml.split('<item>').slice(1)) {
    const body = chunk.split('</item>')[0];
    const grab = (tag) => {
      const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? decodeXml(m[1]) : '';
    };
    items.push({ title: grab('title'), link: grab('link'), description: grab('description'), pubDate: grab('pubDate') });
  }
  return items;
}

// ── Board scanners → each returns [{ url, company, title, location, source }] ──

async function scanGermanTechJobs(cfg) {
  const xml = await fetchText(cfg.rss);
  const items = parseRssItems(xml).slice(0, cfg.max_items || 300);
  return items.map(it => {
    // Title format: "Role @ Company [60.000 - 90.000 €]"
    const m = it.title.match(/^(.*?)\s+@\s+(.*?)(?:\s+\[[^\]]*\])?$/);
    return {
      url: it.link.split('?')[0],
      company: m ? m[2].trim() : 'GermanTechJobs',
      title: m ? m[1].trim() : it.title,
      location: '', // not in the feed — Germany-wide board, worker verifies city
      source: 'gtj-rss',
    };
  }).filter(o => o.url);
}

async function scanEnglishJobsGermany(cfg) {
  const out = [];
  const maxPages = cfg.max_pages || 3;
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? cfg.api : `${cfg.api}?page=${page}`;
    const json = JSON.parse(await fetchText(url));
    for (const j of json.jobs || []) {
      const level = (j.ExperienceLevel || '').toLowerCase();
      if (SKIP_LEVELS.some(l => level.includes(l))) continue; // junior-only: skip labeled senior+
      out.push({
        url: `https://englishjobsgermany.com/jobs/${j.JobID}`,
        company: j.Company || 'Unknown',
        title: j.JobTitle || 'Unknown',
        location: [j.Location, j.Country].filter(Boolean).join(', '),
        source: 'ejg-api',
      });
    }
    if (!json.jobs || json.jobs.length === 0) break;
  }
  return out;
}

async function scanBerlinStartupJobs(cfg) {
  let xml;
  try {
    xml = await fetchText(cfg.rss);
    if (isCloudflareChallenge(xml)) throw new Error('Cloudflare challenge');
  } catch {
    console.log('   (fetch blocked — retrying via Playwright)');
    xml = await fetchTextViaPlaywright(cfg.rss);
  }
  if (isCloudflareChallenge(xml)) throw new Error('Cloudflare challenge not passed');
  return parseRssItems(xml).map(it => {
    // BSJ titles: "Role // Company" (older posts sometimes "Company: Role")
    let title = it.title, company = 'Berlin Startup Jobs';
    const slashes = it.title.split(/\s+\/\/\s+/);
    if (slashes.length === 2) { title = slashes[0].trim(); company = slashes[1].trim(); }
    else {
      const colon = it.title.match(/^([^:]{2,40}):\s+(.+)$/);
      if (colon) { company = colon[1].trim(); title = colon[2].trim(); }
    }
    return { url: it.link.split('?')[0], company, title, location: 'Berlin, Germany', source: 'bsj-rss' };
  }).filter(o => o.url);
}

async function scanArbeitnow(cfg) {
  const out = [];
  let url = cfg.api;
  for (let page = 1; page <= (cfg.max_pages || 3) && url; page++) {
    const json = JSON.parse(await fetchText(url));
    for (const j of json.data || []) {
      out.push({
        url: j.url,
        company: j.company_name || 'Unknown',
        title: j.title || 'Unknown',
        location: j.location || (j.remote ? 'Remote' : ''),
        source: 'arbeitnow-api',
      });
    }
    url = json.links?.next || null;
  }
  return out;
}

// Bundesagentur für Arbeit (official German federal job board) — search-based
// public API, not a full listing. X-API-Key is a public shared client ID used
// by the agency's own app (no signup). One fetch per configured query term.
async function scanArbeitsagentur(cfg) {
  const out = [];
  const queries = cfg.queries || ['Junior'];
  const size = cfg.size || 100;
  // Each query is capped at `size` results, so a national pass alone buries local
  // jobs: "Junior" across Germany returns 100 Berlin/Munich hits and the Mannheim
  // ones never make the page. Running the same queries again centred on the home
  // city with a radius guarantees the commutable roles actually get seen.
  // `locations` defaults to the old national-only behaviour.
  const locations = cfg.locations?.length ? cfg.locations : ['Deutschland'];
  const radius = cfg.radius_km;
  for (const [q, wo] of queries.flatMap(q => locations.map(wo => [q, wo]))) {
    const local = wo !== 'Deutschland' && radius ? `&umkreis=${radius}` : '';
    const url = `${cfg.api}?was=${encodeURIComponent(q)}&wo=${encodeURIComponent(wo)}${local}&size=${size}&page=1`;
    let json;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'X-API-Key': 'jobboerse-jobsuche', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } catch (e) {
      console.log(`   (query "${q}" @ ${wo} failed: ${e.message})`);
      continue;
    }
    for (const j of json.ergebnisliste || []) {
      const ref = j.referenznummer;
      if (!ref) continue;
      const addr = j.stellenlokationen?.[0]?.adresse || {};
      out.push({
        url: j.externeURL || `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(ref)}`,
        company: j.firma || 'Unknown',
        title: j.stellenangebotsTitel || 'Unknown',
        location: [addr.ort, addr.land].filter(Boolean).join(', '),
        source: 'arbeitsagentur-api',
      });
    }
  }
  return out;
}

// ── Pipeline writers (same format as scan.mjs) ──────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;
  let text = readFileSync(PIPELINE_PATH, 'utf-8');
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}${o.location ? ` | ${o.location}` : ''}`).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    const block = '\n' + offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}${o.location ? ` | ${o.location}` : ''}`).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }
  const lines = offers.map(o => `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const portals = existsSync(PORTALS_PATH) ? yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) : {};
  const boards = { ...DEFAULT_BOARDS, ...(portals.boards || {}) };
  const titleOk = buildTitleFilter(portals.title_filter);
  const locationOk = buildLocationFilter(portals.location_filter);
  const seen = loadSeenUrls();
  const date = new Date().toISOString().slice(0, 10);

  const scanners = {
    germantechjobs: scanGermanTechJobs,
    englishjobsgermany: scanEnglishJobsGermany,
    berlinstartupjobs: scanBerlinStartupJobs,
    arbeitnow: scanArbeitnow,
    arbeitsagentur: scanArbeitsagentur,
  };

  let totalFound = 0, titleDrops = 0, locationDrops = 0, dupes = 0;
  const fresh = [];
  const seenCompanyTitle = new Set(); // boards repost the same role under different URLs

  for (const [name, cfg] of Object.entries(boards)) {
    if (!cfg || cfg.enabled === false) continue;
    const scanner = scanners[name];
    if (!scanner) { console.log(`⚠️  no scanner for board "${name}" — skipping`); continue; }
    process.stdout.write(`→ ${name} ... `);
    try {
      const offers = await scanner(cfg);
      console.log(`${offers.length} jobs`);
      totalFound += offers.length;
      for (const o of offers) {
        if (!titleOk(o.title)) { titleDrops++; continue; }
        if (!locationOk(o.location)) { locationDrops++; continue; }
        if (seen.has(o.url)) { dupes++; continue; }
        const ctKey = `${o.company}::${o.title}`.toLowerCase();
        if (seenCompanyTitle.has(ctKey)) { dupes++; continue; }
        seen.add(o.url); // also dedups within this run
        seenCompanyTitle.add(ctKey);
        fresh.push(o);
      }
    } catch (e) {
      console.log(`❌ ${e.message}`);
    }
  }

  console.log('\n───────────────────────────────────────');
  console.log(`Board Scan — ${date}`);
  console.log('───────────────────────────────────────');
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${titleDrops} removed`);
  console.log(`Filtered by location:  ${locationDrops} removed`);
  console.log(`Duplicates:            ${dupes} skipped`);
  console.log(`New offers added:      ${fresh.length}`);

  if (fresh.length) {
    console.log('\nNew offers:');
    for (const o of fresh) console.log(`  + ${o.company} | ${o.title}${o.location ? ' | ' + o.location : ''}`);
  }

  if (DRY_RUN) { console.log('\n[DRY RUN] nothing written'); return; }
  appendToPipeline(fresh);
  appendToScanHistory(fresh, date);
  if (fresh.length) console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
