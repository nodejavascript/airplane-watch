/**
 * survey-years.mjs — what year was each of these aircraft types first flown?
 *
 * 🔴 WHY THIS IS A SEPARATE FILE AND NOT IN THE TYPE TABLE. George, 20 Sep 2026:
 * *"i want you to know the year each aircraft was made so it helps you filter
 * more"*. A year is a MEASURED fact from outside this site, so it is fetched and
 * written to a data file, exactly like the sightings (`types.json`), the
 * photographs (`photos.json`) and the airports (`airports.json`). A year typed
 * into `typeinfo.ts` by hand would be a fact nobody could check and nobody could
 * refresh.
 *
 * 🔴 THE SOURCE IS WIKIDATA, WHICH IS CC0 AND NEEDS NO KEY. It carries an
 * aircraft-model item for almost every type that transmits ADS-B, and that item
 * records `P606` (first flight) and `P729` (service entry) as dated facts with
 * their own citations. Measured 20 Sep 2026 on the eight types tried by hand:
 * seven resolved, including *Cessna 172* → 1955, *Boeing 737-800* → 1997, *Avro
 * Lancaster* → 1941, *Robinson R44* → 1990.
 *
 * 🔴 AND THE HONEST LIMIT, WHICH THE PAGE REPEATS: THIS IS THE YEAR THE **TYPE**
 * WAS FIRST FLOWN, NOT THE YEAR THE INDIVIDUAL AIRFRAME WAS BUILT. Nothing free
 * publishes a build year per airframe. Checked rather than assumed, 20 Sep 2026:
 * the feed's own airframe database (`tar1090-db/aircraft.csv.gz`, 617,361 rows)
 * has eight fields — hex, registration, type code, flags, name, and **three empty
 * ones** — and no year anywhere; `hexdb.io` returns the owner and the type but no
 * year; the planespotters photo API returns photographs and no year. So a 1965
 * Cessna 172 and a 2015 Cessna 172 both read 1955 here, and the page says so
 * rather than implying the airframe in front of you is that old.
 *
 * 🔴 ONLY `P606` AND `P729` ARE ACCEPTED. `P571` (inception) is deliberately NOT
 * used: it is a property that appears on companies, airlines, airports and
 * articles, so accepting it would let a wrong item hand the page a confident wrong
 * year. A type with neither property gets NO year, and no year is drawn — an
 * absent fact is honest and a guessed one is not.
 *
 * Usage: node tools/survey-years.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describeType } from '../site/typeinfo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site', 'years.json');

/** Type codes whose page name is not a name Wikidata knows. See the file's own note. */
const ALIAS_FILE = join(ROOT, 'tools', 'year-aliases.json');
const aliases = existsSync(ALIAS_FILE)
  ? (JSON.parse(readFileSync(ALIAS_FILE, 'utf8')).aliases ?? {})
  : {};

/**
 * Wikidata asks to be told who is calling, the same courtesy the tile server asks
 * for. A request with no user agent is refused by some of their edges.
 */
const UA = {
  'user-agent': 'planewatch/1.0 (+https://planewatch.nodejavascript.com)',
  accept: 'application/json',
};
const API = 'https://www.wikidata.org/w/api.php';
const PAUSE_MS = 180;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url) {
  const response = await fetch(url, { headers: UA });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

/** The codes this site can actually name, from both measured files. */
function codes() {
  const list = new Set();
  const read = (file, pick) => {
    if (!existsSync(file)) return;
    try {
      pick(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      console.warn(`could not read ${file}: ${error.message}`);
    }
  };
  read(join(ROOT, 'site', 'types.json'), (doc) => {
    for (const row of doc.types ?? []) if (row.code) list.add(String(row.code).toUpperCase());
  });
  read(join(ROOT, 'site', 'military.json'), (doc) => {
    // The file has been written as a bare array, as an object holding a `codes`
    // list, and as a `codes` list OF OBJECTS (`{ code, seen, examples }`) — accept
    // all three rather than failing on a shape change.
    const raw = Array.isArray(doc) ? doc : doc.codes ?? [];
    for (const item of raw) {
      const code = typeof item === 'string' ? item : item?.code;
      if (typeof code === 'string') list.add(code.toUpperCase());
    }
  });
  return [...list].sort();
}

/**
 * The strings to ask Wikidata for, best first.
 *
 * 🔴 ONLY SHORTENINGS THAT CANNOT LAND ON A DIFFERENT AIRCRAFT ARE ALLOWED HERE,
 * and that is a correction rather than a precaution. The first version of this file
 * also tried "the first three words" and "the first two words", and measured on the
 * real run it produced three confident wrong years:
 *
 *   DHC-6 Twin Otter  → 1983 from "de Havilland Canada DHC-8"   (the Twin Otter is 1965)
 *   DHC-3 Turbo Otter → 1983, the same DHC-8 item
 *   Sikorsky S-76     → 1979 from "Sikorsky SH-60 Seahawk"      (the S-76 is 1977)
 *
 * Every one of those shared enough words to pass a "do they have a word in common"
 * test — "de Havilland Canada" and "Sikorsky" are exactly the words they share. A
 * wrong year is worse than no year: it is a fact the page would print with
 * confidence and the reader could check nowhere.
 *
 * So there are now exactly two shortenings, and both keep the model number:
 *   · drop a trailing parenthetical   — `Dash 8-100/200/300/400 (Q400)`
 *   · drop the VARIANT half of the last word — `737-700` → `737`, `A330-300` → `A330`
 * The second only fires when what remains is at least two characters AND CONTAINS A
 * DIGIT, which is what stops `Sikorsky S-76` becoming `Sikorsky S` and `DHC-8`
 * becoming `DHC`. A name that needs a longer step back than that gets NO year.
 */
function searchStrings(code) {
  const info = describeType(code);
  const name = String(info.name ?? code).trim();
  const out = [];
  const push = (value) => {
    const clean = String(value ?? '').trim();
    if (clean && !out.includes(clean)) out.push(clean);
  };
  // 🔴 AN ALIAS, WHEN THE PAGE'S OWN NAME IS WRITTEN FOR A READER. `Dash 8-400
  // (Q400)` is the right label on a row and matches nothing on Wikidata, so
  // `tools/year-aliases.json` names the aircraft instead. It is deliberately tiny
  // and every entry still has to pass both guards below.
  push(aliases[String(code).toUpperCase()]);
  push(name);
  push(name.split('(')[0]);
  const last = name.split(/\s+/).pop() ?? '';
  const stem = last.split(/[-‑]/)[0];
  if (last !== stem && stem.length >= 2 && /\d/.test(stem)) {
    push(name.slice(0, name.length - last.length) + stem);
  }
  return out;
}

/** Lowercase, punctuation to spaces, one space between words. */
function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * 🔴 TWO GUARDS, AND BOTH ARE NEEDED.
 *
 * 1 · THE ITEM'S LABEL MUST BE EXACTLY WHAT WE ASKED FOR — not merely begin with
 *     it. The weaker "begins with" test was measured, and it handed out these:
 *
 *       `A319` asked for "Airbus A319" and was given **the A319neo, 2017**
 *       `A332` asked for "Airbus A330" and was given **the A330neo, 2017**
 *       `B738` asked for "Boeing 737-800" and was given **an AIRFRAME —
 *              "Boeing 737-8FE(WL)", 2010**
 *
 *     Every one of those labels BEGINS with the name asked for, and every one is a
 *     different aircraft from it. Equality is the only test that cannot drift, and
 *     the names that genuinely differ are handled by `year-aliases.json` instead.
 *
 * 2 · THE ITEM MUST CARRY A FIRST FLIGHT (`P606`) AND MUST BE AN AIRCRAFT. `P606`
 *     alone throws out the airframe above, which carries a service-entry date and no
 *     first-flight date — an individual aeroplane is delivered, not first flown.
 *
 * 3 · AND "AN AIRCRAFT" IS A WALK UP `P279` (`subclass of`), NOT A HAND-WRITTEN
 *     LIST OF CLASSES. The list came first: it held the three classes that nine
 *     known aircraft items happened to share, and it cut the accepted set by a
 *     third, because a Citation, a King Air, an Embraer 170 and a CRJ900 each carry
 *     a `P31` of their own kind. A list of classes always lacks the class you have
 *     not met yet; the walk answers the actual question. The first attempt at this
 *     guard asked for a manufacturer or an operator instead, and it let through
 *     **Q10689321, "T38", a Swedish motor torpedo boat built in 1951**, which
 *     handed the page a 1952 first flight for the T-38 Talon.
 */
/**
 * 🔴 THREE ROOTS, NOT ONE, AND THE SINGLE ROOT WAS A MEASURED MISTAKE. `aircraft
 * family (Q15056993)` is NOT a subclass of `aircraft (Q11436)` — a family of aircraft
 * is not itself an aircraft, it is a class of them — so a walk to `aircraft` alone
 * rejected nearly every model on the list and cut the accepted set from 29 to FOUR.
 * The question being asked is "is this a kind of aircraft", so all three of the
 * classes that answer yes are roots here, and a thing that reaches none of them — a
 * Swedish motor torpedo boat, an airframe's own model — is not one.
 */
const AIRCRAFT_ROOTS = new Set([
  'Q11436', //    aircraft
  'Q15056993', // aircraft family
  'Q45296117', // aircraft type
]);

/** `qid -> [parent qid]` for `P279` (subclass of), filled in by `prefetchParents`. */
const classParents = new Map();
/** `qid -> is it a kind of aircraft`, memoised so the walk runs once per class. */
const classIsAircraft = new Map();

function claimIds(claims, property) {
  return (claims?.[property] ?? [])
    .map((claim) => claim?.mainsnak?.datavalue?.value?.id)
    .filter((id) => typeof id === 'string');
}

/**
 * 🔴 FETCH THE PARENTS LEVEL BY LEVEL, IN BATCHES, BEFORE ANY YEAR IS JUDGED.
 * Walking on demand would work and would cost one round trip per class per level; a
 * breadth-first prefetch costs one round trip per LEVEL, because fifty identifiers
 * go in a single call. Six levels is far more than any aircraft class needs —
 * measured, most reach `aircraft` in two or three — and the bound is there so a
 * cycle or a deep branch cannot run forever.
 */
async function prefetchParents(starts) {
  let frontier = [...new Set(starts)].filter((id) => !classParents.has(id));
  for (let depth = 0; depth < 6 && frontier.length > 0; depth += 1) {
    const discovered = new Set();
    for (let index = 0; index < frontier.length; index += 50) {
      const batch = frontier.slice(index, index + 50);
      try {
        const doc = await json(
          `${API}?action=wbgetentities&ids=${batch.join('|')}&props=claims&format=json`
        );
        for (const qid of batch) {
          const parents = claimIds(doc.entities?.[qid]?.claims, 'P279');
          classParents.set(qid, parents);
          for (const parent of parents) if (!classParents.has(parent)) discovered.add(parent);
        }
      } catch (error) {
        console.warn(`  class batch failed: ${error.message}`);
        for (const qid of batch) if (!classParents.has(qid)) classParents.set(qid, []);
      }
      await sleep(PAUSE_MS);
    }
    frontier = [...discovered];
  }
  console.log(`walked the class chain over ${classParents.size} classes`);
}

function isAircraftClass(qid) {
  if (AIRCRAFT_ROOTS.has(qid)) return true;
  const cached = classIsAircraft.get(qid);
  if (cached !== undefined) return cached;
  // Set to false BEFORE the walk, so a cycle in the data returns rather than hangs.
  classIsAircraft.set(qid, false);
  for (const parent of classParents.get(qid) ?? []) {
    if (isAircraftClass(parent)) {
      classIsAircraft.set(qid, true);
      return true;
    }
  }
  return false;
}

/** The item's label, normalised, is exactly the name that was asked about. */
function labelIsExactly(label, term) {
  const a = normalise(label);
  const b = normalise(term);
  return a !== '' && a === b;
}

function isAircraft(claims) {
  return claimIds(claims, 'P31').some((qid) => isAircraftClass(qid));
}

function yearFrom(claims, property) {
  const time = claims?.[property]?.[0]?.mainsnak?.datavalue?.value?.time;
  if (typeof time !== 'string') return null;
  const match = /^[+-](\d{4})/.exec(time);
  return match ? Number(match[1]) : null;
}

async function main() {
  const wanted = codes();
  console.log(`${wanted.length} type codes to look up`);

  // ── Phase 1: search every name variant, in order, and keep all the hits ────
  const candidates = new Map(); // code -> [{ term, hits }, ...]
  for (const code of wanted) {
    const tried = [];
    for (const term of searchStrings(code)) {
      let hits = [];
      try {
        const found = await json(
          `${API}?action=wbsearchentities&search=${encodeURIComponent(term)}` +
            `&language=en&uselang=en&format=json&limit=5&type=item`
        );
        hits = (found.search ?? []).map((hit) => hit.id).filter(Boolean);
      } catch (error) {
        console.warn(`  ${code}: search failed (${error.message})`);
      }
      tried.push({ term, hits });
      await sleep(PAUSE_MS);
    }
    candidates.set(code, tried);
  }
  const withHits = [...candidates.values()].filter((tried) => tried.some((entry) => entry.hits.length > 0)).length;
  console.log(`${withHits} codes matched something to inspect`);

  // ── Phase 2: fetch the candidate items, fifty at a time ────────────────────
  const unique = [...new Set([...candidates.values()].flat().flatMap((entry) => entry.hits))];
  const entities = {};
  for (let index = 0; index < unique.length; index += 50) {
    const batch = unique.slice(index, index + 50);
    try {
      const doc = await json(
        `${API}?action=wbgetentities&ids=${batch.join('|')}&props=claims|labels&languages=en&format=json`
      );
      Object.assign(entities, doc.entities ?? {});
    } catch (error) {
      console.warn(`  batch ${index / 50} failed: ${error.message}`);
    }
    await sleep(PAUSE_MS);
  }

  // ── Phase 3: is any of it an aircraft, then walk the chain to a year ───────
  const everyClass = [...candidates.values()]
    .flat()
    .flatMap((entry) => entry.hits)
    .flatMap((qid) => claimIds(entities[qid]?.claims, 'P31'));
  await prefetchParents(everyClass);

  const years = {};
  const unmatched = [];
  for (const code of wanted) {
    const wantedName = String(describeType(code).name ?? code);
    let best = null;
    for (const { term, hits } of candidates.get(code) ?? []) {
      for (const qid of hits) {
        const claims = entities[qid]?.claims;
        const label = entities[qid]?.labels?.en?.value ?? '';
        const firstFlight = yearFrom(claims, 'P606');
        // 🔴 ALL THREE GUARDS, AND NOTHING PAST THEM — see the notes above. A type
        // with no acceptable item gets NO year, and no year is drawn. An absent
        // fact is honest; a guessed one is a fact the reader can check nowhere.
        if (firstFlight === null) continue;
        if (!labelIsExactly(label, term)) continue;
        if (!isAircraft(claims)) continue;
        best = {
          year: firstFlight,
          basis: 'first flight',
          item: qid,
          name: label,
          asked: term,
          exact: term.trim().toLowerCase() === wantedName.trim().toLowerCase(),
        };
        break;
      }
      if (best) break;
    }
    if (best) years[code] = best;
    else unmatched.push(code);
  }

  const doc = {
    generated: new Date().toISOString(),
    source: 'Wikidata (CC0) — https://www.wikidata.org',
    method: 'searched Wikidata for each type name, then read P606 (first flight), else P729 (service entry)',
    // 🔴 What it takes for a year to be believed, written here so the data file
    // cannot travel without it.
    acceptance:
      'Three guards, all measured against real failures. The item\'s label must be EXACTLY the name asked about — a ' +
      '"begins with" test gave the A319 the A319neo, the A330 the A330neo, and the 737-800 an individual airframe. ' +
      'The item must carry a first-flight date. And the item must be a kind of aircraft, checked by walking its ' +
      'instance-of up the subclass chain to aircraft, aircraft family or aircraft type (Q11436 / Q15056993 / ' +
      'Q45296117) — the earlier manufacturer-and-operator test let through a Swedish motor torpedo boat, a ' +
      'hand-written list of classes threw away a third of the good years, and walking to `aircraft` ALONE threw ' +
      'away all but four, because a family of aircraft is not itself an aircraft. A type that fails any guard ' +
      'gets NO year rather than a guessed one.',
    // 🔴 The sentence the page repeats, written here so the data file cannot
    // travel without it.
    scope:
      'The year the TYPE was first flown, not the year the individual airframe was built. No free source ' +
      'publishes a build year per airframe — the feed\'s own 617,361-row airframe database has no year field.',
    asked: wanted.length,
    resolved: Object.keys(years).length,
    unmatched,
    years,
  };

  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
  console.log(`  ${doc.resolved} of ${doc.asked} types have a year`);
  if (unmatched.length > 0) console.log(`  no year found for: ${unmatched.join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
