/**
 * survey-types.mjs — find out which AIRCRAFT TYPES actually come and go at these
 * airports, instead of guessing.
 *
 * George, 20 Sep 2026: *"can you gather a list of airplanes that frequestly come
 * and go? airpplane type, not tail numbers"*. The honest answer is not a list
 * anybody remembers — it is a list this script measured. It polls a 40 nautical
 * mile circle around each airport (wide enough to catch aircraft on approach and
 * on climb-out, which is what coming and going looks like), tallies the feed's own
 * `t` field, and writes site/types.json.
 *
 * A 40 nm circle rather than the fence the page watches, on purpose: an aircraft
 * on the ground is nearly invisible, so a survey of what is ON the ground would
 * under-count everything. What is overhead, arriving and departing, is the honest
 * proxy for what uses the airport.
 *
 * 🔴 NOTHING HERE IS HARD-CODED, INCLUDING THE AIRPORT POSITIONS. They are fetched
 * from the feed's own airport endpoint, the same way the page does it — a typed
 * latitude is a fact that goes wrong silently.
 *
 * Usage:  node tools/survey-types.mjs [rounds] [radiusNm]
 *         node tools/survey-types.mjs 4 40
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = 'https://api.adsb.lol';

/** Same seven the page offers. Only the identifier is written down. */
const AIRPORTS = ['CYHM', 'CYKF', 'CYYZ', 'CYTZ', 'KBUF', 'CYUL', 'CYVR'];

const ROUNDS = Number(process.argv[2] || 3);
const RADIUS_NM = Number(process.argv[3] || 40);
const PAUSE_MS = 15_000;

/**
 * 🔴 THE FREE ENDPOINT RATE-LIMITS, AND IT SAYS SO WITH HTTP 429. The first run of
 * this survey fired seven airports back to back and had **five of seven refused** in
 * round 3 and **six of seven** in round 4 — measured 20 Sep 2026. A volunteer-funded
 * service is entitled to say no, so the survey now waits between requests and backs
 * off when asked. The page needs the same manners, and the same 429 message.
 */
const BETWEEN_REQUESTS_MS = 1_600;

/** A surface vehicle is not an aeroplane. The feed uses category 16/17 for them. */
const SURFACE_CATEGORIES = new Set(['16', '17']);
const NOT_AN_AIRCRAFT_TYPE = new Set(['SERV', 'GRND', 'TWR', '']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many aircraft we managed to look at, so the sample size is stated. */
let inspected = 0;

/** type code -> { count, airports:Set, callsigns:Set, categories:Set, regs:Map } */
const tally = new Map();

async function json(path) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(UPSTREAM + path, {
      headers: { accept: 'application/json', 'user-agent': 'airplane-watch type survey' },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429) {
      // Asked to slow down. Wait, and say so rather than silently dropping the
      // airport — a survey that quietly samples less than it claims is a survey
      // nobody can rely on.
      const wait = 4_000 * attempt;
      console.log(`    429 from the feed, waiting ${wait / 1000}s (attempt ${attempt})`);
      await sleep(wait);
      continue;
    }
    if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
    return response.json();
  }
  throw new Error(`${path} → still rate-limited after 4 attempts`);
}

async function locate(icao) {
  const payload = await json(`/api/0/airport/${icao}`);
  const lat = Number(payload.lat);
  const lon = Number(payload.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`${icao}: no position`);
  return { icao, lat, lon, name: payload.name };
}

/**
 * 🔴 THIS FILE RECORDS ONE LOOK AT THE SKY. IT DOES NOT KEEP THE HISTORY.
 *
 * It used to. There was a `mergeHistory()` here that read the previous `types.json`,
 * carried every unseen type forward with its old date, and incremented a `runsSeen`
 * counter — so the file was a running summary that each run had to remember to update.
 *
 * George, 20 Sep 2026: *"Last seen is a view, not a column somebody must remember to
 * update."* He was right, and the file proved it: the second run wrote **28 sightings
 * rows for types it never saw**, because the merge had put them back into the file and
 * the loader wrote a row for every entry it found. `runs_seen` was counting runs that
 * had copied a row along rather than runs that had seen the aircraft.
 *
 * So the merge is gone. What is written here is a record of ONE run: the types this look
 * saw, the time it saw each of them, and nothing else. A type that was seen yesterday and
 * not today is simply ABSENT from this file — which is the truth about today — and its
 * history is untouched, because history is not stored here. It lives in the `sightings`
 * rows already in the database, and `type_last_seen` reads it back with a `max()`.
 *
 * The consequence worth naming: **nothing has to remember anything.** A run that fails,
 * a run that is skipped, a machine that is off for a week — none of them can corrupt a
 * last-seen, because none of them are what last-seen is computed from.
 */

async function main() {
  console.log(`surveying ${AIRPORTS.length} airports, ${ROUNDS} rounds, ${RADIUS_NM} nm, ${PAUSE_MS / 1000}s apart\n`);

  const airports = [];
  for (const icao of AIRPORTS) {
    try {
      const airport = await locate(icao);
      airports.push(airport);
      console.log(`  located ${airport.icao}  ${airport.name}`);
    } catch (error) {
      console.log(`  SKIPPED ${icao}: ${error.message}`);
    }
    await sleep(BETWEEN_REQUESTS_MS);
  }
  if (airports.length === 0) throw new Error('no airports could be located');

  let refused = 0;

  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const airport of airports) {
      // Stamped before the request, so a type's `lastSeen` is the time of the look
      // that saw it rather than the time the answer happened to be parsed.
      const readingAt = new Date().toISOString();
      let payload;
      try {
        payload = await json(`/v2/point/${airport.lat}/${airport.lon}/${RADIUS_NM}`);
      } catch (error) {
        refused += 1;
        console.log(`  round ${round} ${airport.icao}: ${error.message}`);
        continue;
      }
      const rows = Array.isArray(payload.ac) ? payload.ac : [];
      let types = 0;
      for (const row of rows) {
        inspected += 1;
        // A vehicle on the apron is not an aeroplane, and neither is a tower.
        // Counting them would put "SERV" near the top of a list of aircraft.
        if (SURFACE_CATEGORIES.has(String(row.category ?? ''))) continue;
        const type = String(row.t || '').trim().toUpperCase();
        // 🔴 An aircraft with no type code is NOT counted as the type "-". A
        // survey that invents a type out of missing data is worse than a survey
        // that reports what it could not identify.
        if (NOT_AN_AIRCRAFT_TYPE.has(type) || type.length > 6) continue;
        types += 1;
        if (!tally.has(type)) {
          tally.set(type, {
            count: 0,
            airports: new Set(),
            callsigns: new Set(),
            categories: new Set(),
            // 🔴 TAIL NUMBERS, WHICH THE PAGE CAN THEN OFFER. George, 20 Sep 2026:
            // *"inside the type, maybe list the tail numbers and i can select
            // those too"*. A registration is only recorded when the feed actually
            // sent one — an aircraft that never transmits its registration is not
            // given a made-up one.
            regs: new Map(),
            // 🔴 WHEN IT WAS LAST SEEN, WHICH IS THE MOST USEFUL THING ON THE ROW.
            // George, 20 Sep 2026: *"the list should also by filtered by last seen.
            // ... something that is never going to fly soon is a useless
            // selection"*. A survey is one look at the sky, so the answer is the
            // time of the last round that saw it — carried forward across runs by
            // mergeHistory() so it gets better the more often this is run.
            lastSeenAt: null,
          });
        }
        const entry = tally.get(type);
        entry.count += 1;
        entry.lastSeenAt = readingAt;
        entry.airports.add(airport.icao);
        const registration = String(row.r || '').trim().toUpperCase();
        if (/^[A-Z0-9-]{4,10}$/.test(registration)) {
          if (!entry.regs.has(registration)) entry.regs.set(registration, new Set());
          entry.regs.get(registration).add(airport.icao);
        }
        const callsign = String(row.flight || '').trim().toUpperCase();
        // Only a three-letter airline prefix. Some callsigns are registrations or
        // addresses, and "@@@" is not an operator.
        if (/^[A-Z]{3}/.test(callsign)) entry.callsigns.add(callsign.slice(0, 3));
        if (row.category) entry.categories.add(String(row.category));
      }
      console.log(`  round ${round} ${airport.icao}: ${rows.length} aircraft, ${types} with a type code`);
      await sleep(BETWEEN_REQUESTS_MS);
    }
    if (round < ROUNDS) await sleep(PAUSE_MS);
  }

  const types = [...tally.entries()]
    .map(([code, entry]) => ({
      code,
      seen: entry.count,
      airports: [...entry.airports].sort(),
      operators: [...entry.callsigns].sort().slice(0, 12),
      categories: [...entry.categories].sort(),
      // 🔴 THE TIME OF THE LOOK THAT SAW IT — this run's clock, never a value read in
      // from anywhere. It is named `seenAt` rather than `lastSeen` on purpose: `lastSeen`
      // is the answer the page shows, and it comes from the view. This is an input to it.
      seenAt: entry.lastSeenAt,
      // Most-seen first, so the page can show the handful that matter and keep
      // the long tail behind a count rather than in a wall of buttons.
      registrations: [...entry.regs.entries()]
        .map(([reg, airports]) => ({ reg, airports: [...airports].sort() }))
        .sort((a, b) => b.airports.length - a.airports.length || a.reg.localeCompare(b.reg))
        .slice(0, 40),
    }))
    .sort((a, b) => b.seen - a.seen || a.code.localeCompare(b.code));

  const generated = new Date().toISOString();

  const document = {
    // What this is, for anyone who opens the file: ONE run. Not a summary, and not the
    // place last-seen is kept.
    kind: 'survey-run',
    generated,
    // Stated so nobody has to guess how much weight the list carries: this is a
    // sample of what the feed showed over a few minutes, not a schedule.
    //
    // 🔴 IN KILOMETRES, BECAUSE THE READER NEVER MEETS A NAUTICAL MILE. The feed is
    // asked in nautical miles — that is the unit its endpoint takes — but the page's own
    // test asserts that the word never reaches the screen, and this sentence is printed
    // on the page. It was written in the unit of the wire rather than the unit of the
    // reader, and the test caught it: *"the page shows the reader 'nm'"*.
    method: `${ROUNDS} rounds of ${Math.round(RADIUS_NM * 1.852)} km around ${airports.length} airports, ${PAUSE_MS / 1000}s apart`,
    aircraftInspected: inspected,
    // A reading counted once per round it appeared in, so a busy airliner seen in
    // every round scores four. This is a FREQUENCY of sightings over a short
    // sample, not a count of airframes and not a timetable — say so where it is
    // shown, or the number means something it should not.
    counted: 'sightings (one per aircraft per round)',
    roundsRefusedByRateLimit: refused,
    // Said out loud, because a page that showed eight tail numbers and implied
    // they were all of them would be wrong in a way nobody could see.
    registrationsNote:
      'Up to 40 registrations per type, from aircraft that actually transmitted one. Many transponders never send a registration, so this is a sample of what identifies itself, not a fleet list.',
    // 🔴 THE SENTENCE THAT USED TO BE HERE SAID `lastSeen` WAS CARRIED FORWARD ACROSS
    // EVERY RUN. It was true, and it was the defect. This file has no `lastSeen` at all
    // now, and saying so is more useful than saying nothing.
    historyNote:
      'This file is one run and nothing else. Every type listed was seen by it, and nothing here is carried forward from an earlier run. Last seen across runs is a view over the sightings table in the database — ask the database, not this file.',
    airports: airports.map((airport) => ({ icao: airport.icao, name: airport.name })),
    types,
  };

  // 🔴 WRITTEN OUTSIDE `site/`, because it is not something the site serves — it is an
  // input to the load, and a run file sitting in the served directory is a second copy of
  // the truth waiting to be read by mistake.
  const outDir = join(ROOT, '.survey');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'latest-run.json');
  writeFileSync(out, JSON.stringify(document, null, 2) + '\n', 'utf8');

  console.log(`\ninspected ${inspected} aircraft readings, ${types.length} distinct types\n`);
  console.log('  seen  type   airports                         operators');
  for (const entry of types.slice(0, 30)) {
    console.log(
      `  ${String(entry.seen).padStart(4)}  ${entry.code.padEnd(6)} ${entry.airports.join(',').padEnd(32)} ${entry.operators.slice(0, 5).join(' ')}`
    );
  }
  console.log(`\nwrote ${out} — one run.`);
  console.log('next: node tools/load-db.mjs   (records the run, then rewrites site/types.json from the view)');
}

main().catch((error) => {
  console.error(`survey failed: ${error.message}`);
  process.exit(1);
});
