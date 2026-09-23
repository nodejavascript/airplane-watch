/**
 * load-historic.mjs — read the days the museum flies, and keep them in our database.
 *
 * 🔴 WHY THIS EXISTS AT ALL. George, 20 Sep 2026: *"thats the whole point actually, to
 * watch these old aircraft fly past your home location"*. Everything else on this site
 * answers "what is in the air"; this answers the question a reader actually has about a
 * rare aeroplane, which is **when to look up**. A Lancaster flies a handful of times a
 * year from a named airfield, and a handful of times a year is not something anybody
 * notices by chance.
 *
 * ─── THE TWO THINGS MEASURED BEFORE ANY OF THIS WAS WRITTEN ────────────────────
 *
 * 1 · THE `date` PARAMETER IS ONE DAY AHEAD. This is not a guess and it is not a quirk we
 *     could have reasoned our way to. Ten pairs, measured 20 Sep 2026:
 *
 *         asked 2026-09-26  →  every event stamped 2026-09-25
 *         asked 2026-09-27  →  every event stamped 2026-09-26
 *         asked 2026-10-24  →  every event stamped 2026-10-23
 *         (and seven more, all the same)
 *
 *     So THE DAY IS ASKED FOR AS `day + 1`, and every event is then checked against the
 *     day it claims to be. A page that trusted the parameter would print the wrong day
 *     beside somebody's home airport, which is worse than printing nothing — so `want()`
 *     below asks for the offset day and only accepts what comes back stamped for the day
 *     we actually wanted.
 *
 * 2 · THE MUSEUM IDENTIFIES ITS AIRCRAFT BY ITS OWN ID, AND ITS OWN PAGE PROVES IT. Their
 *     schedule branches on `item.AircraftFlightId === 12` with the comment
 *     *"temporarily hide this years dates for Lancaster"* — and id 12 is the aircraft
 *     called "Lancaster Member Ride" in every response. That is two independent sources
 *     agreeing (their markup and their data), which is why `their_id` is kept.
 *
 * ⚠️ POLITE BY CONSTRUCTION. This is somebody else's server and one request per day is
 * exactly what a person clicking through their calendar does. Two seconds between
 * requests, a window of `--days` (28 by default), and no retry storm: a day that fails is
 * reported and skipped, and the next run picks it up.
 *
 * Usage:
 *   node tools/load-historic.mjs              read the next 28 days and load them
 *   node tools/load-historic.mjs --days 14    a shorter window
 *   node tools/load-historic.mjs --check      say what is already in the database
 *   node tools/load-historic.mjs --quiet      no per-day output
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { composeHistoric } from './historic-document.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');

/** The museum's own flight-day handler, the one its schedule page calls per day. */
const HANDLER = 'https://www.warplane.com/Warplane/DesktopModules/FlightPurchaseHandler.ashx';
/** Named for the same reason the feed's requests are named: an anonymous caller is refused. */
const UA = 'airplane-watch.nodejavascript.com';
const PAUSE_MS = 2_000;

/**
 * The one historic site this site knows, with the evidence for it.
 *
 * 🔴 THE AIRPORT IS THE POINT. Their directions page says, verbatim: *"We are located at
 * 9280 Airport Road in Mount Hope, Ontario right at the Hamilton International Airport"* —
 * and Hamilton International is **CYHM**, which the page already watches and already
 * measures a distance to. So "is this near me" needs no new machinery at all.
 */
const SITE_ROW = {
  icao: 'CYHM',
  name: 'Canadian Warplane Heritage Museum',
  url: 'https://www.warplane.com/aircraft/flights.aspx',
  note:
    'Their own words: "THE ONLY PLACE IN THE WORLD YOU CAN FLY IN A LANCASTER and many more ' +
    'including the Tiger Moth biplane, B-25 Mitchell bomber, D-Day veteran Dakota and PBY Canso."',
  source: 'warplane.com/aircraft/flights.aspx and /visit/directions-to-museum.aspx',
  readAt: '2026-09-20',
};

/**
 * The feed's ICAO type designator for an aircraft here, and WHERE THAT CAME FROM.
 *
 * 🔴 ONLY WHAT CAN BE SOURCED, WHICH IS WHY THIS HAS ONE ROW IN IT. `hexdb.io` returns, for
 * hex `C07DD7`:
 *
 *   {"ModeS":"C07DD7","Registration":"C-GVRA","Manufacturer":"Avro","ICAOTypeCode":"LANC",
 *    "Type":"Lancaster B.X","RegisteredOwners":"Canadian Warplane Heritage Museum",
 *    "OperatorFlagCode":"LANC"}
 *
 * The registered owner IS this museum, so the museum's Lancaster and the code `LANC` are
 * tied together by a source. The other aircraft are NOT in here: giving the Harvard a code
 * because a Harvard is probably a T-6 is exactly the guess that puts the wrong aeroplane in
 * front of a reader. They go in with a name and no code, and the page says what it knows.
 *
 * ⚠️ AND A TRAP WORTH RECORDING, BECAUSE IT LOOKS RIGHT AND IS WRONG: the survey's own 129
 * types include `LNC4`. That is a **Lancair IV**, a kit-built light aircraft, not a
 * Lancaster. A name-shaped match would have announced a Lancaster on the strength of a
 * Lancair. `LANC` is the Lancaster; `LNC4` is not.
 */
const FLEET_CODES = {
  12: { code: 'LANC', source: 'hexdb.io hex C07DD7: ICAOTypeCode LANC, RegisteredOwners Canadian Warplane Heritage Museum' },
};

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A day, as `YYYY-MM-DD`, in UTC — the unit the handler's parameter is expressed in. */
function ymd(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * The day's events, or a refusal that says why.
 *
 * The offset lives here and nowhere else, so there is one place to correct if the museum
 * ever changes it.
 */
async function flightsOn(day) {
  const wanted = ymd(day);
  const asked = new Date(day.getTime() + 86_400_000); // 🔴 MEASURED: the parameter is a day ahead
  const url = `${HANDLER}?action=getAircraftFlightsDay&date=${encodeURIComponent(`${ymd(asked)}T00:00:00.000Z`)}`;

  const response = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      referer: 'https://www.warplane.com/aircraft/flights/schedule.aspx',
    },
  });
  if (!response.ok) throw new Error(`the museum answered ${response.status}`);

  const text = await response.text();
  let events;
  try {
    events = JSON.parse(text);
  } catch {
    throw new Error(`the museum did not answer JSON: ${text.slice(0, 80)}`);
  }
  if (!Array.isArray(events)) throw new Error('the museum answered something that is not a list');

  // 🔴 EVERY EVENT IS CHECKED AGAINST THE DAY WE ASKED FOR, not the day we asked about. If
  // the offset ever changes, this returns nothing for that day rather than the wrong day's
  // flights — a silent wrong answer is the one failure this page cannot afford, because the
  // reader's whole reason for being here is to know when to go outside.
  return events.filter((event) => String(event.TimeBegin ?? '').startsWith(wanted));
}

/** `"Lancaster Member Ride"` → `"Lancaster"`. Anything unexpected is kept whole. */
function aircraftNameOf(label) {
  return String(label)
    .replace(/\s+(Member\s+)?(Ride|Flight)\s*$/i, '')
    .trim() || String(label);
}

/** Their `TimeBegin` is `YYYY-MM-DD-HH-MM`, which is not a timestamp until it is one. */
function beginsAt(timeBegin) {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(String(timeBegin));
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  // Their museum is in Ontario and the times are local to it, so they are stored as such
  // rather than silently shifted to UTC — the page prints the museum's own clock.
  return `${y}-${mo}-${d}T${h}:${mi}:00-04:00`;
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const quiet = process.argv.includes('--quiet');
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 28;

  const client = new pg.Client(settings());
  await client.connect();

  if (checkOnly) {
    const sites = await client.query(
      `select s.icao, s.name, n.next_at, n.upcoming, n.days_published
         from historic_sites s left join historic_next n on n.site_id = s.id order by s.icao`
    );
    for (const row of sites.rows) {
      console.log(`  ${row.icao}  ${row.name}`);
      console.log(
        `    next ${row.next_at ? new Date(row.next_at).toISOString().slice(0, 16) : 'nothing scheduled'}` +
          ` · ${row.upcoming ?? 0} upcoming · ${row.days_published ?? 0} day(s) published`
      );
    }
    const aircraft = await client.query(
      `select a.name, a.type_code, count(f.their_id)::int as flights
         from historic_aircraft a
         left join historic_flights f on f.site_id = a.site_id and f.their_aircraft_id = a.their_id
        group by a.name, a.type_code order by flights desc, a.name`
    );
    for (const row of aircraft.rows) {
      console.log(`    ${row.flights.toString().padStart(3)}  ${row.name}${row.type_code ? ` (${row.type_code})` : ''}`);
    }
    await client.end();
    return;
  }

  // ── the site ──────────────────────────────────────────────────────────────
  const site = await client.query(
    `insert into historic_sites (icao, name, url, note, source, read_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (icao, name) do update
       set url = excluded.url, note = excluded.note,
           source = excluded.source, read_at = excluded.read_at
     returning id`,
    [SITE_ROW.icao, SITE_ROW.name, SITE_ROW.url, SITE_ROW.note, SITE_ROW.source, SITE_ROW.readAt]
  );
  const siteId = site.rows[0].id;
  console.log(`${SITE_ROW.name} at ${SITE_ROW.icao} — site ${siteId}`);

  // ── the days ──────────────────────────────────────────────────────────────
  const today = new Date(`${ymd(new Date())}T00:00:00Z`);
  let flights = 0;
  let daysWithFlights = 0;
  const failed = [];

  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(today.getTime() + offset * 86_400_000);
    let events;
    try {
      events = await flightsOn(day);
    } catch (error) {
      failed.push(`${ymd(day)} (${error.message})`);
      await sleep(PAUSE_MS);
      continue;
    }

    for (const event of events) {
      const begins = beginsAt(event.TimeBegin);
      const aircraftId = Number(event.AircraftFlightId);
      if (begins === null || !Number.isFinite(aircraftId)) continue;

      const label = String(event.EventName ?? 'A historic aircraft');
      const flown = FLEET_CODES[aircraftId];
      // 🔴 `type_code` IS NOT SET WHEN THE AIRCRAFT IS FIRST SEEN AND THEN FORGOTTEN: the
      // upsert keeps whatever code is known, and a NULL on this run never erases a code
      // from an earlier one.
      await client.query(
        `insert into historic_aircraft (site_id, their_id, name, event_label, type_code, code_source)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (site_id, their_id) do update
           set name = excluded.name,
               event_label = excluded.event_label,
               type_code = coalesce(excluded.type_code, historic_aircraft.type_code),
               code_source = coalesce(excluded.code_source, historic_aircraft.code_source)`,
        [siteId, aircraftId, aircraftNameOf(label), label, flown?.code ?? null, flown?.source ?? null]
      );

      await client.query(
        `insert into historic_flights (site_id, their_id, their_aircraft_id, begins_at, seats, url)
         values ($1, $2, $3, $4::timestamptz, $5, $6)
         on conflict (site_id, their_id) do update
           set begins_at = excluded.begins_at,
               seats = excluded.seats,
               url = excluded.url,
               fetched_at = now()`,
        [siteId, Number(event.Id), aircraftId, begins, event.Seats ?? null,
          `https://www.warplane.com/${String(event.Url ?? '').replace(/^\//, '')}`]
      );
      flights += 1;
    }

    if (events.length > 0) daysWithFlights += 1;
    if (!quiet) {
      console.log(`  ${ymd(day)}  ${events.length === 0 ? 'nothing scheduled' : `${events.length} flight(s)`}`);
    }
    await sleep(PAUSE_MS);
  }

  // ── the file the deploy carries ───────────────────────────────────────────
  await writeHistoricFile(client);

  const { rows: total } = await client.query(
    'select count(*)::int as n, count(distinct date_trunc(\'day\', begins_at))::int as d from historic_flights where site_id = $1',
    [siteId]
  );
  console.log(
    `\n${flights} flight(s) over ${daysWithFlights} day(s) in this window · ` +
      `${total[0].n} on file across ${total[0].d} day(s)`
  );
  if (failed.length) {
    console.log(`\n${failed.length} day(s) could not be read — the next run picks them up:`);
    for (const line of failed) console.log(`  ${line}`);
  }

  await client.end();
}

/**
 * Rebuild `site/historic.json` from the database.
 *
 * The same rule as `types.json`: a Cloudflare Worker cannot reach Postgres, so the file is
 * what gets deployed and the database is what it is rendered from. Hand-maintaining the
 * two would be two answers to one question.
 *
 * 🔴 THE COMPOSITION ITSELF LIVES IN ONE MODULE, shared with the dev server, so the file
 * and the live route cannot drift apart.
 */
async function writeHistoricFile(client) {
  const query = (text, values) => client.query(text, values);
  const document = await composeHistoric(query);

  writeFileSync(join(SITE, 'historic.json'), JSON.stringify(document, null, 2) + '\n');
  console.log(
    `historic.json   rewritten from the database — ${document.sites.length} site(s), ` +
      `${document.sites.reduce((n, s) => n + s.aircraft.length, 0)} aircraft, ` +
      `${document.sites.reduce((n, s) => n + s.flights.length, 0)} upcoming flight(s)`
  );
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  if (/ECONNREFUSED/.test(error.message)) {
    console.error('Is the tunnel up?  systemctl --user status aircraft-db-tunnel.service');
  }
  process.exitCode = 1;
});
