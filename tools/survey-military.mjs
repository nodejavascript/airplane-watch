/**
 * survey-military.mjs — which aircraft the feed itself marks as military.
 *
 * 🔴 WHY THIS MAKES A NETWORK CALL AND THE TYPE TABLE DOES NOT. The page needs to
 * know which type codes are military, and there are two honest ways to know it:
 * read the historic ones out of the type database (that is `typeinfo.ts`, done by
 * hand once), or ASK THE FEED which of its own aircraft carry the military flag.
 * This tool does the second, because the military set changes — airframes are
 * re-registered, retired and added — and a list frozen in a source file would be
 * quietly wrong within a year.
 *
 * The flag is `dbFlags`, and bit 1 is the military bit. Measured 20 Sep 2026:
 * `/v2/mil` answered with 162 aircraft worldwide, every one of them `dbFlags: 1`.
 *
 * 🔴 THE HONEST LIMIT, AND THE PAGE REPEATS IT. This is "what the feed's own
 * database marks as military", which is NOT "every military aircraft". Many do
 * not transmit ADS-B at all, and some transmit without the flag. So this file
 * makes a filter POSSIBLE and never makes it COMPLETE, and anything that presents
 * the result as a complete picture of military traffic would be lying.
 *
 * 🔴 AND IT IS A GLOBAL QUERY, NOT A LOCAL ONE. `/v2/mil` has no point filter, so
 * the codes harvested are worldwide. That is the right shape for the job — a type
 * is military wherever it flies — but it means the list is long-tailed: it will
 * contain types that will never come near Hamilton, and the page will simply never
 * show them.
 *
 * Usage: node tools/survey-military.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site', 'military.json');
const FEED = 'https://api.adsb.lol';

/**
 * 🔴 THE FEED REFUSES NODE'S DEFAULT USER AGENT — measured 20 Sep 2026, not
 * guessed. Fetched five ways from the same machine, same second:
 *
 *   no user-agent header      → 403 Forbidden
 *   `accept: application/json` only → 403 Forbidden
 *   `user-agent: curl/8.5.0`  → 200 OK
 *   `user-agent: airplane-watch/1.0 (+https://…)` → 200 OK
 *   a browser user agent      → 200 OK
 *
 * So a request with no user agent at all is refused, which is exactly what Node
 * sends, and the failure looks like the feed being down rather than the request
 * being turned away. Every fetch in this repository therefore names itself.
 */
const HEADERS = {
  accept: 'application/json',
  'user-agent': 'planewatch/1.0 (+https://airplane-watch.nodejavascript.com; tools/survey-military.mjs)',
};

/** The feed is volunteer-funded and rate-limits. Measured: 429 after a handful. */
async function get(url, attempt = 1) {
  const response = await fetch(url, { headers: HEADERS });
  if (response.status === 429 && attempt <= 3) {
    const wait = attempt * 5000;
    console.log(`  429 from the feed — waiting ${wait / 1000}s and trying again`);
    await new Promise((resolve) => setTimeout(resolve, wait));
    return get(url, attempt + 1);
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return { response, body: await response.json() };
}

const { body } = await get(`${FEED}/v2/mil`);
const aircraft = Array.isArray(body.ac) ? body.ac : [];

console.log(`military feed: ${aircraft.length} aircraft`);

/**
 * 🔴 NOT EVERYTHING THE FEED FLAGS IS AN AEROPLANE, AND THE FLAG IS NOT A
 * PROMISE. The harvest on 20 Sep 2026 included `TWR` — a control tower or ground
 * station, which has no altitude and cannot take off — and `C172`, a light
 * training aircraft, because military flying clubs fly them. Both are real
 * entries in a database that flags what it flags. So the tower is dropped as not
 * an aircraft, and the light aeroplane is kept, because it genuinely is one and
 * quietly editing it out would be this tool deciding what a military aircraft is.
 */
const NOT_AN_AIRCRAFT = new Set(['TWR', 'GRND', 'GND', 'SERV', 'GROUND', '']);

/** code -> { seen, examples:Set } */
const tally = new Map();
let withType = 0;
let withoutType = 0;

for (const row of aircraft) {
  const code = String(row.t ?? '').trim().toUpperCase();
  if (NOT_AN_AIRCRAFT.has(code) || code === '-' || code.length > 6) {
    // Said out loud rather than folded into the total: an aircraft the feed
    // flags as military but cannot name is a real category, and hiding it would
    // make the harvest look more complete than it is.
    withoutType += 1;
    continue;
  }
  withType += 1;
  if (!tally.has(code)) tally.set(code, { seen: 0, examples: new Set() });
  const entry = tally.get(code);
  entry.seen += 1;
  const label = String(row.flight || row.r || row.hex || '').trim();
  if (label && entry.examples.size < 3) entry.examples.add(label);
}

const codes = [...tally.entries()]
  .map(([code, entry]) => ({ code, seen: entry.seen, examples: [...entry.examples].sort() }))
  .sort((a, b) => b.seen - a.seen || a.code.localeCompare(b.code));

mkdirSync(join(ROOT, 'site'), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      source: `${FEED}/v2/mil`,
      flag: 'dbFlags bit 1',
      method:
        'Aircraft the feed itself marks as military, asked once of its global military feed. A type is listed when at least one aircraft carrying it was flagged.',
      covers:
        'The whole world for one moment. This is a global query — the military feed takes no point or radius — so it can include types that will never come near any single airport.',
      note:
        'This is what the public database FLAGS as military, which is not the same as every military aircraft. Many do not transmit ADS-B at all and some transmit without the flag, so a filter built on this can find something and can never promise to find everything.',
      aircraftFlagged: aircraft.length,
      withType,
      withoutType,
      dropped: [...NOT_AN_AIRCRAFT].filter((code) => code !== ''),
      codeCount: codes.length,
      codes,
    },
    null,
    1
  ) + '\n'
);

console.log(`wrote site/military.json — ${codes.length} type codes`);
console.log(`  named: ${withType}   flagged but with no type code: ${withoutType}`);
console.log(`  most common: ${codes.slice(0, 8).map((row) => `${row.code}(${row.seen})`).join(' ')}`);
