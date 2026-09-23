/**
 * load-db.mjs — put what this site knows into its own Postgres.
 *
 * 🔴 WHY THIS EXISTS. George, 20 Sep 2026: *"should be be using postgres so we can
 * reli less on the api unless we want to fetch current data, and we can associate the
 * images and last seen in the db too"*.
 *
 * So the split is: **the feed answers for the present** — what is in the air right
 * now, which nobody else has — and **everything else lives here**. The airports, the
 * types, which type was seen at which airport, the tail numbers, the first-flown
 * years, the photographs with the credit their licence requires, and the thing that
 * prompted all of it: WHEN EACH TYPE WAS LAST SEEN.
 *
 * 🔴 AND LAST SEEN IS THE POINT — AND IT IS A VIEW, NOT A FIELD.
 *
 * George, 20 Sep 2026: *"Last seen is a view, not a column somebody must remember to
 * update"* — and he was right, and the measured proof was that the SECOND run wrote
 * **28 sightings rows for types it never saw**, because a file was still carrying them
 * forward. `runs_seen` was counting runs that had copied a row along, not runs that had
 * seen the aircraft.
 *
 * So there is now exactly one place a sighting is recorded, and it is a row: **one row
 * in `sightings` per (run, type) that the run actually saw.** Everything the page shows
 * about last-seen comes from the `type_last_seen` view over those rows. Nothing carries
 * a date forward, no tool has to remember to refresh a field, and a run that saw nothing
 * adds nothing to the history — because it did not see anything.
 *
 * The file the survey writes therefore describes **one run** and nothing else
 * (`.survey/latest-run.json`). It is a record of what was seen, not a running summary.
 * The running summary is a `max()` in the database, where it cannot go stale.
 *
 * 🔴 AND `site/types.json` IS WRITTEN FROM THE VIEW, after the load. It stops being a
 * parallel truth maintained by hand and becomes a rendering of the database — the same
 * shape as a status file generated from a database rather than edited. If the two ever
 * disagree, the file is wrong, and it is rebuilt in one command.
 *
 * 🔴 IT IS IDEMPOTENT, AND THE RUN'S OWN TIMESTAMP IS THE KEY. `survey_runs.started_at`
 * is unique, so loading the same run twice cannot invent a second run and double every
 * count — which would quietly double `seen` and make `runs_seen` a lie.
 *
 * Usage:
 *   node tools/load-db.mjs            load every file it finds
 *   node tools/load-db.mjs --check    connect and print what is in there
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import pg from 'pg';

import { unnamedCodes } from './nameable.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');

/**
 * The connection settings come from `db/.env`, which is gitignored, with the ordinary
 * `PG*` environment variables winning if they are already set — so the same tool works
 * against a different database without editing anything.
 */
function settings() {
  const file = join(ROOT, 'db', '.env');
  const fromFile = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match) fromFile[match[1]] = match[2];
    }
  }
  return {
    host: process.env.PGHOST ?? fromFile.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? fromFile.PGPORT ?? 5433),
    database: process.env.PGDATABASE ?? fromFile.PGDATABASE ?? 'aircraft',
    user: process.env.PGUSER ?? fromFile.PGUSER ?? 'aircraft',
    password: process.env.PGPASSWORD ?? fromFile.AIRCRAFT_DB_PASSWORD,
    max: 4,
  };
}

function readJson(name) {
  const file = join(SITE, name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.warn(`  ${name}: could not be read (${error.message})`);
    return null;
  }
}

/** Turn an empty string into null, so a column means "not known" rather than "". */
const orNull = (value) => (value === '' || value === undefined ? null : value);

async function main() {
  const checkOnly = process.argv.includes('--check');
  const client = new pg.Client(settings());
  await client.connect();
  const { rows: who } = await client.query('select current_database() as db, version() as v');
  console.log(`connected to ${who[0].db} — ${who[0].v.split(',')[0]}`);

  if (checkOnly) {
    const tables = await client.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`
    );
    for (const { table_name: name } of tables.rows) {
      const { rows } = await client.query(`select count(*)::int as n from ${name}`);
      console.log(`  ${name.padEnd(16)} ${rows[0].n}`);
    }
    const seen = await client.query(
      `select count(*)::int as types, min(last_seen) as oldest, max(last_seen) as newest
         from type_last_seen`
    );
    console.log('  type_last_seen  ', JSON.stringify(seen.rows[0]));
    await client.end();
    return;
  }

  // ── airports ──────────────────────────────────────────────────────────────
  const airports = readJson('airports.json');
  if (airports) {
    let n = 0;
    for (const airport of airports.airports ?? []) {
      await client.query(
        `insert into airports (icao, name, location, iata, lat, lon, elevation_ft)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (icao) do update set
           name = excluded.name, location = excluded.location, iata = excluded.iata,
           lat = excluded.lat, lon = excluded.lon, elevation_ft = excluded.elevation_ft`,
        [
          airport.icao,
          airport.name,
          orNull(airport.location),
          orNull(airport.iata),
          airport.lat,
          airport.lon,
          airport.elevationFt ?? null,
        ]
      );
      n += 1;
    }
    console.log(`airports        ${n} upserted`);
  } else {
    console.log('airports        (site/airports.json not found)');
  }

  // ── the run: what one look at the sky actually saw ─────────────────────────
  //
  // The file is `.survey/latest-run.json`, written by the survey, and it contains ONLY
  // the types that look saw. A type that was in a previous run and not in this one is
  // ABSENT — not present with an old date on it. That absence is the whole fix: a run
  // can no longer write a sighting for an aircraft it did not see.
  const runFile = join(ROOT, '.survey', 'latest-run.json');
  let types = null;
  if (existsSync(runFile)) {
    try {
      types = JSON.parse(readFileSync(runFile, 'utf8'));
    } catch (error) {
      console.warn(`  the run file could not be read (${error.message})`);
    }
  } else {
    console.log('the run file is missing — run `npm run survey` first');
  }

  if (types) {
    let runId = null;
    if (types.generated) {
      const { rows } = await client.query(
        `insert into survey_runs (started_at, method, aircraft_inspected, source)
         values ($1, $2, $3, $4)
         on conflict (started_at) do update set method = excluded.method
         returning id`,
        [types.generated, types.method ?? null, types.aircraftInspected ?? null, '.survey/latest-run.json']
      );
      runId = rows[0].id;
    }

    let n = 0;
    let recorded = 0;
    for (const row of types.types ?? []) {
      await client.query(
        `insert into types (code, airports, operators, categories, sightings, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (code) do update set
           airports = excluded.airports, operators = excluded.operators,
           categories = excluded.categories, updated_at = now()`,
        [row.code, row.airports ?? [], row.operators ?? [], row.categories ?? [], row.seen ?? 0]
      );
      // The tail numbers are replaced rather than merged: a registration the feed no
      // longer shows for a type should leave the list, or the list becomes a record of
      // everything ever seen and stops describing the present.
      await client.query('delete from registrations where code = $1', [row.code]);
      for (const item of row.registrations ?? []) {
        await client.query(
          `insert into registrations (code, reg, airports) values ($1, $2, $3)
           on conflict (code, reg) do update set airports = excluded.airports`,
          [row.code, item.reg, item.airports ?? []]
        );
      }
      // 🔴 A SIGHTING IS WRITTEN ONLY WHEN THERE WAS ONE. `seen > 0` is the guard, and
      // the date is the time of THIS look — never a date carried in from anywhere. The
      // old code took `row.lastSeen ?? types.generated`, which is how 28 types that run 2
      // never saw ended up with sightings rows dated to run 1.
      if (runId !== null && (row.seen ?? 0) > 0) {
        await client.query(
          `insert into sightings (run_id, code, sighted_at, seen) values ($1, $2, $3, $4)
           on conflict (run_id, code) do update set sighted_at = excluded.sighted_at, seen = excluded.seen`,
          [runId, row.code, row.seenAt ?? types.generated, row.seen]
        );
        recorded += 1;
      }
      n += 1;
    }
    console.log(
      `types           ${n} in the run, ${recorded} with a sighting recorded, at ${types.generated}`
    );
    if (n !== recorded) {
      console.log(`                ${n - recorded} carried no sighting — a run only records what it saw`);
    }
  } else {
    console.log('types           (no run to load — run `npm run survey` first)');
  }

  // ── first-flown years ─────────────────────────────────────────────────────
  const years = readJson('years.json');
  if (years) {
    let n = 0;
    for (const [code, entry] of Object.entries(years.years ?? {})) {
      await client.query(
        `insert into type_years (code, year, basis, item, matched_name, asked, exact)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (code) do update set
           year = excluded.year, basis = excluded.basis, item = excluded.item,
           matched_name = excluded.matched_name, asked = excluded.asked, exact = excluded.exact`,
        [code, entry.year, entry.basis ?? 'first flight', orNull(entry.item), orNull(entry.name), orNull(entry.asked), Boolean(entry.exact)]
      );
      n += 1;
    }
    console.log(`type_years      ${n} upserted`);
  } else {
    console.log('type_years      (site/years.json not found)');
  }

  // ── photographs, with the credit the licence requires ─────────────────────
  const photos = readJson('photos.json');
  if (photos) {
    let n = 0;
    for (const [code, entry] of Object.entries(photos.found ?? {})) {
      await client.query(
        `insert into photos (code, name, title, src, artist, licence, reason, confident)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (code) do update set
           name = excluded.name, title = excluded.title, src = excluded.src,
           artist = excluded.artist, licence = excluded.licence,
           reason = excluded.reason, confident = excluded.confident`,
        [
          code,
          orNull(entry.name),
          entry.title ?? entry.name ?? code,
          entry.src,
          orNull(entry.artist),
          orNull(entry.licence),
          orNull(entry.reason),
          entry.confident !== false,
        ]
      );
      n += 1;
    }
    // 🔴 AND A PHOTOGRAPH THE FILE NO LONGER CARRIES IS REMOVED, NOT LEFT BEHIND.
    //
    // An upsert alone was not enough, and the failure was invisible from the file. Measured 22 Sep 2026:
    // `site/photos.json` held **193** photographs while the page served **198**, because five rows the
    // survey had freshly REFUSED — the Kaman K-MAX's wrong helicopter, the TBM 900 and the Turbo
    // Commander matched to family articles, and code removed in the same pass — were still in the table
    // from an earlier run and were being served to the reader. So the page showed the very photographs
    // the survey had just decided against, and the JSON said otherwise.
    //
    // The file is the whole set: it covers every code the page can render, and a code with no entry is a
    // code that keeps its drawing. So anything in the table that is not in this file is stale by
    // definition, and it goes. `deleted` is reported rather than silent, because a prune that removes
    // more than the diff expected is worth seeing.
    const codes = Object.keys(photos.found ?? {});
    const pruned = await client.query(
      codes.length > 0 ? `delete from photos where code <> all($1::text[])` : 'delete from photos',
      codes.length > 0 ? [codes] : []
    );
    console.log(`photos          ${n} upserted, ${pruned.rowCount ?? 0} withdrawn (no longer in the file)`);
  } else {
    console.log('photos          (site/photos.json not found)');
  }

  // ── and the file the site serves is written FROM the view ──────────────────
  //
  // 🔴 THIS IS THE PART THAT MAKES "A VIEW, NOT A COLUMN" TRUE IN PRACTICE. If
  // `site/types.json` were still assembled by the survey, then last-seen would be a
  // field something has to remember to write — which is exactly what George named. It
  // is now read back out of the database in one query, so the file cannot disagree with
  // the view: it IS the view, formatted.
  // 🔴 A WITHHELD PUBLISH IS NOT A FAILED ROUND, AND IT MUST NOT BE REPORTED AS ONE. The
  // data loaded; only the publish was held back. Exit 3 says exactly that, so
  // `tools/run-survey.sh` reports the real reason instead of blaming the tunnel — which is
  // what it would say for any other non-zero code, and would send the next reader to
  // check a service that is working perfectly.
  const published = await writeTypesFile(client);
  if (published === false) process.exitCode = 3;
  await client.end();
  console.log('\nloaded. Run `node tools/load-db.mjs --check` to see the counts, including last-seen.');
}

/**
 * A run note with any nautical-mile radius spelled out in kilometres.
 *
 * `"3 rounds of 40 nm around 7 airports"` becomes `"3 rounds of 74 km around 7 airports"`.
 * The survey is asked in nautical miles and the page is read in kilometres, and the reader
 * is the one who has to make sense of the sentence — so the conversion happens where the
 * note leaves the database, not only where the survey writes it. That also fixes the rows
 * that already exist: the string lives in a row, so editing the survey alone would leave
 * every run recorded so far still reading in the unit of the wire.
 */
function readerUnits(note) {
  return String(note ?? '').replace(/\b(\d+(?:\.\d+)?)\s*nm\b/g, (_all, nm) => `${Math.round(Number(nm) * 1.852)} km`);
}

/**
 * Rebuild `site/types.json` from the database.
 *
 * The site reads this file when the database is unreachable, and it is the deploy
 * artefact — so it has to be right, and the only way to keep it right is to stop it
 * being maintained by hand.
 */
async function writeTypesFile(client) {
  const run = await client.query(
    'select started_at, method, aircraft_inspected from survey_runs order by started_at desc limit 1'
  );
  if (run.rows.length === 0) return;
  const latest = run.rows[0];

  const types = await client.query(
    `select t.code, t.airports, t.operators, t.categories,
            l.last_seen, l.runs_seen, l.seen_in_all_runs,
            s.seen as seen_this_run
       from types t
       left join type_last_seen l on l.code = t.code
       left join survey_runs r on r.started_at = $1
       left join sightings s on s.code = t.code and s.run_id = r.id
      order by coalesce(s.seen, 0) desc, t.code`,
    [latest.started_at]
  );
  const regs = await client.query('select code, reg, airports from registrations order by code, reg');
  const byCode = new Map();
  for (const row of regs.rows) {
    if (!byCode.has(row.code)) byCode.set(row.code, []);
    byCode.get(row.code).push({ reg: row.reg, airports: row.airports ?? [] });
  }
  const runs = await client.query(
    'select count(*)::int as n, min(started_at) as first, max(started_at) as last from survey_runs'
  );

  const document = {
    generated: new Date(latest.started_at).toISOString(),
    // 🔴 THE RUN'S OWN NOTE, READ IN THE READER'S UNIT. Rows written before 20 Sep 2026
    // carry the radius in nautical miles — the unit the feed takes — and the page prints
    // this sentence as written. Converting on the way out fixes the rows that already
    // exist as well as the ones the survey writes from here on, which editing the survey
    // alone would not: the string lives in a row, not in the code.
    method: readerUnits(latest.method),
    aircraftInspected: latest.aircraft_inspected ?? 0,
    counted: 'sightings (one per aircraft per round)',
    registrationsNote:
      'Up to 40 registrations per type, from aircraft that actually transmitted one. Many transponders never send a registration, so this is a sample of what identifies itself, not a fleet list.',
    // 🔴 THIS SENTENCE HAS TO MATCH THE QUERY ABOVE IT. It described a carried-forward
    // field while the field was being carried; now it describes a view, and says how many
    // runs the view is built from, because a last-seen from two runs and a last-seen from
    // two hundred are different claims.
    historyNote:
      `lastSeen and runsSeen are read from the type_last_seen view — the most recent time each type was seen, and how many runs have seen it, over ${runs.rows[0].n} survey run${runs.rows[0].n === 1 ? '' : 's'} so far. Nothing carries a date forward: a run records what it saw and nothing else. seen is this run's frequency.`,
    runsRecorded: runs.rows[0].n,
    historyFrom: new Date(runs.rows[0].first).toISOString(),
    historyTo: new Date(runs.rows[0].last).toISOString(),
    airports: [...new Set(types.rows.flatMap((row) => row.airports ?? []))].sort(),
    types: types.rows.map((row) => ({
      code: row.code,
      seen: row.seen_this_run ?? 0,
      airports: row.airports ?? [],
      operators: row.operators ?? [],
      categories: row.categories ?? [],
      registrations: byCode.get(row.code) ?? [],
      lastSeen: row.last_seen === null ? null : new Date(row.last_seen).toISOString(),
      runsSeen: row.runs_seen ?? 0,
      seenInAllRuns: row.seen_in_all_runs ?? 0,
    })),
  };

  // 🔴 IT REFUSES TO PUBLISH A LIST THE SITE CANNOT NAME, AND THAT IS THE POINT OF THIS GUARD.
  //
  // This function is the only thing that writes the served file, and it is called by a
  // round that runs on a **timer** — `aircraft-survey.timer`, every four hours. So a type
  // code the table has never heard of used to travel out of the feed and into the deploy
  // artefact by itself, and `npm test` then failed on a file nobody had touched.
  // **Measured 23 September 2026:** the 12:24 round published eight such codes —
  // `C700 EC20 RV4 DH2T A306 C525 G2CA GA5C` — and the next deploy stopped at step 2 until
  // they were found and set aside by hand. Twice.
  //
  // 🔴 AND THE RULE IS ASKED OF THE SAME MODULE THE SUITE ASKS IT OF, so the two cannot
  // disagree about what "nameable" means. Withholding is not failing: the round's data is
  // kept, the file the site serves is left exactly as it was, and the reason is printed
  // where a person will read it instead of being left in a dirty working tree.
  // 🔴 AND THE GUARD MAY NOT BECOME THE REASON A ROUND FAILS. If the check itself cannot
  // answer — the table missing, unreadable, unbuilt — it says so and PUBLISHES ANYWAY,
  // which is exactly the behaviour this file had before the guard existed. **An instrument
  // that cannot answer must never be worse than no instrument.** A withheld publish is a
  // known, benign condition that leaves a dirty file; a round that dies is a round that
  // stops recording what flew.
  let unnamed = [];
  try {
    unnamed = unnamedCodes(document.types.map((type) => type.code));
  } catch (error) {
    console.log(`types.json      the naming check could not run (${error.message}) — publishing anyway`);
  }

  if (unnamed.length > 0) {
    const stamp = new Date(latest.started_at).toISOString().slice(0, 10);
    const aside = join(ROOT, '.survey', `types-${stamp}-needs-${unnamed.length}-names.json`);
    mkdirSync(join(ROOT, '.survey'), { recursive: true });
    writeFileSync(aside, JSON.stringify(document, null, 2) + '\n');
    console.log(
      `types.json      NOT rewritten — ${unnamed.length} code(s) this site cannot name: ${unnamed.join(', ')}`
    );
    console.log(`                kept at .survey/${basename(aside)}; site/types.json is untouched`);
    return false;
  }

  writeFileSync(join(SITE, 'types.json'), JSON.stringify(document, null, 2) + '\n');
  console.log(
    `types.json      rewritten from the view — ${document.types.length} types, ` +
      `${document.runsRecorded} run${document.runsRecorded === 1 ? '' : 's'} of history`
  );
  return true;
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  if (/ECONNREFUSED/.test(error.message)) {
    console.error('Is the tunnel up?  systemctl --user status aircraft-db-tunnel.service');
  }
  process.exitCode = 1;
});
