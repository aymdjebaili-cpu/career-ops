// Part-time / minijob applications BY EMAIL, for the Munich area.
//
// WHY THIS EXISTS
// The form-filling agent cannot serve this segment: of 399 Munich part-time postings,
// 344 had no reachable application form, and heyjobs (11 attempts, 0 applications) routes
// through a Google sign-in that refuses an automated browser. Measured on 2026-09-16,
// 36% of Munich part-time Bundesagentur postings publish an application address in their
// own job-detail API — no scraping, no key beyond the public one the agency's app uses.
//
// Output: output/email-route/parttime-targets.json
// Usage:  node email-route/build-parttime-targets.mjs output/email-route [--limit=150] [--per-inbox=2]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { findApplicationEmail } from '../find-application-email.mjs';

const S = process.argv[2] || 'output/email-route';
const arg = (n, d) => Number((process.argv.find(a => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1]);
const LIMIT = arg('limit', 150);
const PER_INBOX = arg('per-inbox', 2);
// How many no-address postings may be chased to the employer's own website in one run.
// Each lookup costs several page fetches, so it is budgeted rather than unlimited.
const RESOLVE = arg('resolve', 80);
// How many job details to fetch per run. The backlog is thousands of postings, so a run
// walks a slice of it and remembers the verdicts; the next run starts where this one left off.
const DETAILS = arg('details', 700);
const CACHE = 'output/email-route/.ba-details.json';
const CACHE_DAYS = 21;
const H = { 'X-API-Key': 'jobboerse-jobsuche', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };

// The WORK must be doable at B1 German — physical or routine. Same distinction
// build-minijob-queue.mjs draws: judge the job, not the language of the advert.
// Widened 2026-09-16: the original list admitted 439 of 13,135 scanned postings, and the
// email channel ran dry within a day. Every word added below describes work whose DOING is
// physical or routine — production, assembly, packing, grounds, laundry, banqueting — the
// same test as before, just applied to the vocabulary the postings actually use.
const KEEP = /lager|kommission|warenver|sortier|reinig|geb[äa]udereinig|k[üu]che|sp[üu]l|housekeep|zimmerm[äa]dchen|hausmeister|w[äa]scherei|helfer|aushilfe|minijob|packer|picker|kurier|zusteller|servicekraft|abf[üu]ller|produktionsmitarbeiter|fertigung|montage|verpack|bestück|etikett|kommissionier|inventur|hauswirtschaft|gr[üu]npflege|gartenpflege|catering|bankett|gastronomie|hilfskraft|einr[äa]um|regalauff[üu]ll|wareneingang|warenausgang|umzugs|logistikmitarbeiter|stewarding|geschirr|raumpflege|unterhaltsreinigung|glasreinig/i;
// Licence, German qualification, student-only contracts, or talking to German customers all day.
// `praktikum` and `fahrer` added 2026-09-16: the widened KEEP list pulled in an unpaid
// Praktikumsplatz and an airline-catering driver post, and no driving licence is claimed
// anywhere in his profile — an application that assumes one would be a false statement.
const DROP = /pflege|examen|ausbildung|umschulung|meister|elektriker|schlosser|staplerschein|f[üu]hrerschein|klasse c|lkw|kraftfahrer|berufskraft|erzieher|kita|lehrer|azubi|werkstudent|praktikant|praktikum|fahrer|chauffeur|telefonie|call ?center|kundenberat|schreiner|mechatronik|mechatroniker|monteur|[üu]bungsleiter|kinderg/i;
const MUNICH = /m[üu]nchen|munich|garching|dachau|eching|erding|olching|unterschlei[ßs]heim|ismaning|freising|feldkirchen|poing|haar|neubiberg|bergkirchen|unterf[öo]hring|aschheim|martinsried|planegg|karlsfeld|gr[äa]felfing|oberschlei[ßs]heim|gr[öo]benzell|puchheim|germering|oberhaching|taufkirchen|unterhaching|ottobrunn|kirchheim|vaterstetten|gauting|f[üu]rstenfeldbruck|hallbergmoos|neufahrn|pullach|gr[üu]nwald|hohenbrunn|markt schwaben|maisach|gilching|starnberg|dornach|kirchheim bei m[üu]nchen/i;

// Job adverts are written as prose, and the address is often glued to the next word:
// "…@daimlertruck.comzudem senden Sie…" got extracted whole on 2026-09-16 and would have
// bounced. A real address ends in a real TLD, so anything else is dropped rather than
// trimmed — guessing where the address stops would invent a mailbox.
const TLD = /\.(de|com|net|org|eu|at|ch|info|biz|io|jobs|online|shop|bayern|gmbh|email|social|group|systems|services|solutions|company|center|haus|immo|club|team|live|life|world|berlin|koeln|hamburg|ruhr|tirol|co\.uk)$/i;
const looksReal = (e) => TLD.test(e.split('@')[1] || '');

const emailsIn = (v, out = new Set()) => {
  if (typeof v === 'string') for (const m of v.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) out.add(m[0]);
  else if (Array.isArray(v)) v.forEach(x => emailsIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => emailsIn(x, out));
  return out;
};
const textIn = (v, out = []) => {
  if (typeof v === 'string' && v.length > 40) out.push(v);
  else if (Array.isArray(v)) v.forEach(x => textIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => textIn(x, out));
  return out;
};

// Never write to an employer twice, and never apply to one already applied to.
const applied = new Set();
if (existsSync('data/agent/applications.json')) {
  for (const r of JSON.parse(readFileSync('data/agent/applications.json', 'utf8'))) {
    if (['SUBMITTED', 'NEEDS_CHECK'].includes(r.status)) applied.add(String(r.url || '').toLowerCase());
  }
}
const alreadyMailed = new Set();
if (existsSync('output')) {
  const { readdirSync } = await import('fs');
  for (const f of readdirSync('output')) {
    if (!/^email-.*\.md$/.test(f)) continue;
    const to = readFileSync(`output/${f}`, 'utf8').match(/^TO:\s*(\S+)/m);
    if (to) alreadyMailed.add(to[1].toLowerCase());
  }
}

// A pipeline row is `URL | Company | Title | status | score | pdf | report | note` — it
// carries NO location. Requiring MUNICH to match that text therefore kept only postings
// whose title happened to spell the city out ("Reinigungskräfte 80538 München") and threw
// away every plainly-titled Munich job. Measured on 2026-09-16: 4,996 rows were the right
// kind of work, 533 named a city, and 4,463 were never fetched at all. The location now
// comes from the job detail itself (below), which is the only place it actually exists.
const seen = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const fresh = (r) => r && (Date.now() - new Date(r.at).getTime()) / 86400000 < CACHE_DAYS;

const candidates = [];
for (const line of readFileSync('data/pipeline.md', 'utf8').split(/\r?\n/)) {
  const m = line.match(/arbeitsagentur\.de\/jobsuche\/jobdetail\/([^\s)|]+)/);
  if (!m) continue;
  if (!KEEP.test(line) || DROP.test(line)) continue;
  const url = (line.match(/https?:\/\/[^\s)|]+/) || [])[0];
  if (applied.has(String(url).toLowerCase())) continue;
  const ref = decodeURIComponent(m[1]);
  const cached = seen[ref];
  // Skipping what a previous run already settled is what lets an hourly run reach NEW
  // ground instead of re-walking the same first few hundred postings: the advert is gone,
  // the job is not in the area, the employer publishes no address, or their inbox has
  // already had its mail. Everything else is fetched again.
  if (fresh(cached)) {
    if (cached.status === 'dead' || cached.status === 'outside' || cached.status === 'no-email') continue;
    if (cached.status === 'has-email' && cached.email && alreadyMailed.has(cached.email)) continue;
  }
  candidates.push({ ref, url, hintsCity: MUNICH.test(line) });
  if (candidates.length >= LIMIT) break;
}
// Postings whose title names a Munich town are the surest bets, so they go first and the
// per-run detail budget is never spent entirely on long shots.
candidates.sort((a, b) => Number(b.hintsCity) - Number(a.hintsCity));
const batch = candidates.slice(0, DETAILS);
console.log(`${candidates.length} posting(s) of the right kind not yet ruled out; checking ${batch.length} this run`);

const byInbox = new Map();
const targets = [];
let failed = 0, noEmail = 0, capped = 0, resolved = 0, outside = 0;
const queue = [...batch];
async function worker() {
  while (queue.length) {
    const c = queue.shift();
    try {
      const res = await fetch(`https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/${Buffer.from(c.ref).toString('base64')}`, { headers: H });
      // 404 means the posting is gone, not that the fetch failed — remember it so the
      // next run does not spend a request rediscovering the same expired advert.
      if (res.status === 404) { failed++; seen[c.ref] = { status: 'dead', at: new Date().toISOString() }; continue; }
      if (!res.ok) { failed++; continue; }
      const j = await res.json();

      const city = j.arbeitsorte?.[0]?.ort || j.stellenlokationen?.[0]?.adresse?.ort || '';
      if (!MUNICH.test(city)) {
        outside++;
        seen[c.ref] = { status: 'outside', city, at: new Date().toISOString() };
        continue;
      }
      let email = [...emailsIn(j)].find(e => !/@arbeitsagentur|@example|\.png$|\.jpg$/i.test(e) && looksReal(e));
      let via = 'posting';
      // Two thirds of these postings publish no address in the API (222 of 439 on
      // 2026-09-16), which used to end the road. The employer's own site usually does
      // publish one — an Impressum is legally required in Germany and careers pages say
      // "Bewerbung an …". findApplicationEmail only ever reports an address literally
      // written on a page it fetched, so a null answer here means they really publish
      // none, and the posting is dropped rather than written to a guessed inbox.
      const employerName = j.arbeitgeber || j.firma || '';
      if (!email && employerName && resolved < RESOLVE) {
        resolved++;
        const hit = await findApplicationEmail(employerName, null, c.url).catch(() => null);
        if (hit?.email) { email = hit.email; via = `site:${hit.source || 'published'}`; }
      }
      if (!email) {
        noEmail++;
        // In the Munich area but publishing nothing: remember it so an hourly run does
        // not keep paying to re-learn that Lidl and Aldi apply through their portals.
        seen[c.ref] = { status: 'no-email', city, employer: employerName, at: new Date().toISOString() };
        continue;
      }
      const key = email.toLowerCase();
      seen[c.ref] = { status: 'has-email', city, employer: employerName, email: key, at: new Date().toISOString() };
      if (alreadyMailed.has(key)) { capped++; continue; }
      const used = byInbox.get(key) || 0;
      if (used >= PER_INBOX) { capped++; continue; }
      byInbox.set(key, used + 1);
      const text = textIn(j).join('\n').replace(/\s+/g, ' ').slice(0, 1800);
      targets.push({
        ref: c.ref, url: c.url, email, via,
        title: j.titel || j.stellenangebotsTitel || 'Stelle',
        employer: j.arbeitgeber || j.firma || 'Unbekannt',
        city: j.arbeitsorte?.[0]?.ort || j.stellenlokationen?.[0]?.adresse?.ort || 'München',
        partTime: /teilzeit|minijob|gering|aushilfe|stundenweise/i.test(JSON.stringify(j)),
        text,
      });
    } catch { failed++; }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

mkdirSync(S, { recursive: true });
writeFileSync(`${S}/parttime-targets.json`, JSON.stringify(targets, null, 1));
writeFileSync(CACHE, JSON.stringify(seen, null, 0));
console.log(`\noutside the Munich area: ${outside}`);
console.log(`publish an address : ${targets.length}`);
console.log(`no address         : ${noEmail}`);
console.log(`capped (same inbox or already mailed): ${capped}`);
console.log(`unreadable         : ${failed}`);
for (const t of targets.slice(0, 15)) {
  console.log(`  ${t.partTime ? 'TZ' : '  '} ${String(t.employer).slice(0, 26).padEnd(26)} ${String(t.title).slice(0, 40).padEnd(40)} ${t.email}`);
}
if (targets.length > 15) console.log(`  … ${targets.length - 15} more in ${S}/parttime-targets.json`);
