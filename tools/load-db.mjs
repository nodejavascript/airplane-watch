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
 * 🔴 AND LAST SEEN IS THE POINT. One survey is one look at the sky, so a single file
 * can only ever say "seen in this run". This tool inserts a `survey_runs` row and a
 * `sightings` row per type for every run it loads, and `type_last_seen` answers from
 * all of them. The number improves every time the survey is re-run, which is the only
 * way the question *"is this one worth watching?"* can be answered at all.
 *
 * 🔴 IT IS IDEMPOTENT, AND THE RUN'S OWN TIMESTAMP IS THE KEY. `survey_runs.started_at`
 * is unique, so loading the same `types.json` twice cannot invent a second run and
 * double every count — which would quietly double `seen` and make `runs_seen` a lie.
 *
 * 🔴 AND IT DOES NOT REPLACE THE JSON FILES. They stay the deploy artefact, because
 * the Cloudflare Worker cannot reach a database on this machine. The database is where
 * the site reads from in development and where the answers are computed; the files are
 * what gets shipped. Saying that plainly is better than implying the database is
 * somehow serving production.
 *
 * Usage:
 *   node tools/load-db.mjs            load every file it finds
 *   node tools/load-db.mjs --check    connect and print what is in there
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

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

  // ── types, their tail numbers, and the run that recorded them ──────────────
  const types = readJson('types.json');
  if (types) {
    let runId = null;
    if (types.generated) {
      const { rows } = await client.query(
        `insert into survey_runs (started_at, method, aircraft_inspected, source)
         values ($1, $2, $3, $4)
         on conflict (started_at) do update set method = excluded.method
         returning id`,
        [types.generated, types.method ?? null, types.aircraftInspected ?? null, 'site/types.json']
      );
      runId = rows[0].id;
    }

    let n = 0;
    for (const row of types.types ?? []) {
      await client.query(
        `insert into types (code, airports, operators, categories, sightings, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (code) do update set
           airports = excluded.airports, operators = excluded.operators,
           categories = excluded.categories, sightings = excluded.sightings,
           updated_at = now()`,
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
      if (runId !== null) {
        // `lastSeen` is preferred, because it is the time of the look that actually saw
        // it; `generated` is the honest fallback for a file written before that field.
        await client.query(
          `insert into sightings (run_id, code, sighted_at, seen) values ($1, $2, $3, $4)
           on conflict (run_id, code) do update set sighted_at = excluded.sighted_at, seen = excluded.seen`,
          [runId, row.code, row.lastSeen ?? types.generated, row.seen ?? 0]
        );
      }
      n += 1;
    }
    console.log(`types           ${n} upserted, plus a survey run at ${types.generated}`);
  } else {
    console.log('types           (site/types.json not found)');
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
    console.log(`photos          ${n} upserted`);
  } else {
    console.log('photos          (site/photos.json not found)');
  }

  await client.end();
  console.log('\nloaded. Run `node tools/load-db.mjs --check` to see the counts, including last-seen.');
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  if (/ECONNREFUSED/.test(error.message)) {
    console.error('Is the database up?  docker compose --env-file db/.env up -d');
  }
  process.exitCode = 1;
});
