# The database

The site reads its four data files from **PostgreSQL on the DigitalOcean droplet
`dvs-sites`**, not from this repo's working directory and not from the browser.
`tools/serve.mjs` composes `/airports.json`, `/types.json`, `/years.json` and
`/photos.json` from it and hands them to the page. The files under `site/` are the
fallback, and the response says which of the two you got in `x-data-source`.

## Why it moved (George, 20 Sep 2026)

*"should be be using postgres so we can reli less on the api unless we want to fetch
current data, and we can associate the images and last seen in the db too."*

And then, when a local container was used instead: *"you were supposed to use postgres
on digital ocean."*

Both parts matter. The feed is volunteer-funded and refuses bursts — so the answers it
gives are collected once, kept, and re-read from the database rather than re-asked on
every page load. And the two things that only make sense with history — which
photograph belongs to which type, and when each type was last seen — are columns with
a query behind them, not a file rewritten wholesale.

## Where it lives

| | |
|---|---|
| Server | `dvs-sites` (178.128.225.32), container `postgres`, **postgres:17-alpine** |
| Listening | `127.0.0.1:5432` **on the droplet only** — never exposed |
| Database | `aircraft` |
| Role | `aircraft` (owner of every table) |
| Reached from here | SSH tunnel, `127.0.0.1:5433` → droplet `127.0.0.1:5432` |
| Password | `db/.env` (gitignored, `chmod 600`) and `~/Documents/secrets/.aircraft_db_password` |

The tunnel is a systemd user service, `aircraft-db-tunnel.service`, enabled at boot:

```bash
systemctl --user status aircraft-db-tunnel.service
npm run db:tunnel            # start it if it is down
```

It is deliberately a tunnel rather than an open port. The database holds no personal
data, but there is no reason for a database to answer on the public internet, and the
droplet already runs three of these (`datavisionstudios/mongodb-backups` keeps the same
shape).

## What is in it

| Table | What it holds |
|---|---|
| `airports` | 76 airports — ICAO code, name, place, position. Positions were confirmed **once** by asking the feed where each airport is; after that they are read from here. |
| `types` | Aircraft type codes, plus the airports and operators each has been seen at, and the categories those operators fly. |
| `registrations` | Tail numbers seen per type. |
| `type_years` | First-flown or in-service year per type, from Wikidata (CC0). |
| `photos` | The Wikimedia Commons photograph and its licence for each type. |
| `survey_runs` | One row per round of watching, `started_at` UNIQUE. |
| `sightings` | One row per type per round. Primary key `(run_id, code)`. |
| `type_last_seen` (**view**) | `last_seen`, `runs_seen`, `seen_in_all_runs` per type — the whole of the "last seen" filter. |
| `historic_sites` | Places where historic aircraft are based and flown. One row today: the Canadian Warplane Heritage Museum at **CYHM**. |
| `historic_aircraft` | The aircraft each site flies, named as the operator names them, with the feed's type code **only where a source was found** — see `type_code` / `code_source` below. |
| `historic_flights` | One row per scheduled flight the operator publishes, keyed on **their** event id so re-reading a day cannot duplicate it. |
| `historic_next` (**view**) | The next day something historic flies at each site, how many flights are still to come, and how many days are published. A view for the same reason `type_last_seen` is one. |

### Why the historic tables exist at all

George, 20 Sep 2026: **"thats the whole point actually, to watch these old aircraft fly past your
home location"** — and, of the first draft that had this as a README note instead,
**"shoudnt these be in the api?"**. It is data, so it lives here and the API composes it
(`tools/historic-document.mjs`, served at `/historic.json` and written to `site/historic.json`).

```bash
node tools/load-historic.mjs            # read the operator's next 28 days and load them
node tools/load-historic.mjs --days 7   # a shorter window
node tools/load-historic.mjs --check    # say what is already here
```

**🔴 THE ONE MEASUREMENT THAT MATTERS: the endpoint's `date` parameter is ONE DAY AHEAD of the day it
returns.** Ten pairs, measured 20 Sep 2026 — asked `2026-09-26`, every event stamped `2026-09-25`; the
same for nine more dates. The loader therefore requests `day + 1` **and checks every event against the
day it wanted**, so a change in that behaviour produces an empty day rather than the wrong day next to
somebody's home airport.

**🔴 `type_code` IS NULL UNLESS A SOURCE WAS FOUND, AND THAT IS THE POINT.** `hexdb.io` answers for hex
`C07DD7`: Registration `C-GVRA`, ICAOTypeCode `LANC`, **RegisteredOwners "Canadian Warplane Heritage
Museum"** — a source that ties the museum to the code, so `LANC` is stored. The other aircraft have a
name and no code, because giving the Harvard a code on the grounds that a Harvard is probably a T-6 is
the kind of guess that puts the wrong aeroplane in front of a reader. The trap that makes this
concrete: the survey's own 129 types include **`LNC4`, which is a Lancair, not a Lancaster**.

**🟢 THE TIMER IS INSTALLED, AND GEORGE RULED THE CADENCE: ONCE A DAY.** His words, 20 Sep 2026:
**"one day is fine"**. So `aircraft-historic.timer` reads the operator's window **once a day at
07:40** — after the 07:20 survey round, so the two do not queue behind each other while both want the
database. `Persistent=true`, so a machine that was asleep still catches up; and unlike the survey
there is only ever one run to catch up, so there is no burst to worry about.

**What a run costs, measured rather than estimated:** **exactly 60 seconds** for the default 28-day
window — about 28 requests to the museum and 27 two-second pauses — and it left **151 flights across
15 days** in the database. That is the whole reason the cadence is daily and not hourly: an impatient
reader of somebody else's calendar is how a free page gets closed.

```bash
systemctl --user list-timers 'aircraft-*'      # both timers, and when they next fire
systemctl --user status aircraft-historic.service
journalctl --user -u aircraft-historic.service -n 20
```

⚠️ **The service needs `node_modules/` — it runs `node tools/load-historic.mjs`, which imports `pg`.**
A checkout without `npm install` is a unit that fails every morning at 07:40.

## The rounds, and why there is a timer

**Last seen is a VIEW, not a field anybody maintains.** That sentence is George's, from
20 Sep 2026 — *"Last seen is a view, not a column somebody must remember to update"* —
and the first version of this got it wrong in a way worth writing down, because the code
looked fine.

The survey used to read the previous `site/types.json`, carry every type it had not seen
forward with its old date, and increment a counter. The loader then wrote a `sightings`
row for **every entry in the file**. So a run that saw 72 types wrote **100** rows — and the
next run's `runs_seen` counted runs that had copied a row along rather than runs that had
seen the aircraft. Measured, run 2: **28 rows for types it never saw**, and `runs_seen > 1`
for **62 types when only 34 had actually been seen twice**.

That is what "a column somebody must remember to update" looks like when it goes stale:
nothing crashes, the numbers just get quietly bigger.

**Now there is exactly one place a sighting is recorded, and it is a row.**

1. `tools/survey-types.mjs` writes **`.survey/latest-run.json`** — one run, only the types
   that run saw, each with the time of the look. Nothing is carried; the file has no
   `lastSeen` and no `runsSeen` at all.
2. `tools/load-db.mjs` records a `sightings` row **only when `seen > 0`**.
3. `type_last_seen` derives `last_seen`, `runs_seen` and `seen_in_all_runs` from those rows.
4. The loader then **rewrites `site/types.json` from the view**, so the fallback the site
   serves is a rendering of the database rather than a second copy of the truth.

A run that failed, was skipped, or could not reach the database therefore cannot corrupt a
last-seen — it is simply not what last-seen is computed from. Three runs in, the view reads
**59 types seen once, 30 twice, 31 three times**, which is a real distinction and the thing
that makes the day/week/month filter mean something.

```bash
tools/run-survey.sh              # one round: survey, then load and rebuild the file
tools/run-survey.sh --check      # say what is in the database, ask the feed nothing
npm run survey                   # the survey alone, writing .survey/latest-run.json
```

`aircraft-survey.timer` runs a round **four times a day** (07:20, 12:20, 17:20, 22:20,
`Persistent=true`, a random delay up to five minutes). A round takes about three
minutes and makes roughly **21 requests** to the feed with pauses between them. The
log is `~/.local/state/aircraft-survey.log`.

**Do not shorten those pauses and do not raise the frequency.** Measured 20 September
2026: ten requests 3 s apart, ten 1 s apart and eight 2 s apart were **all refused with
HTTP 429** from the third or fourth request onward. An impatient scraper is how a free
feed gets closed to everybody, and this site would have nothing left to read.

A round is skipped rather than doubled if one is already running (`flock`), and a round
whose database load fails says so and exits non-zero — the file is still written, so a
tunnel outage costs the database an update rather than costing the survey its work.

## Setting it up again from nothing

```bash
# 1 · role and database, on the droplet
ssh dvs-sites "docker exec postgres psql -U postgres -c \"CREATE ROLE aircraft LOGIN PASSWORD '…'\""
ssh dvs-sites "docker exec postgres psql -U postgres -c 'CREATE DATABASE aircraft OWNER aircraft'"

# 2 · the schema
ssh dvs-sites "docker exec -i postgres psql -U aircraft -d aircraft" < db/schema.sql

# 3 · a password on this machine, and the tunnel
printf 'PGHOST=127.0.0.1\nPGPORT=5433\nPGDATABASE=aircraft\nPGUSER=aircraft\nAIRCRAFT_DB_PASSWORD=…\n' > db/.env
chmod 600 db/.env
systemctl --user enable --now aircraft-db-tunnel.service

# 4 · the data, then check it
npm run db:load
npm run db:check
```

There is **no Docker Compose file for this database** and there should not be one. A
container on this machine was the wrong answer: the point of moving the data was to
stop it living next to the code that reads it, and a local container puts it straight
back — while adding a second set of tables to keep in step. `docker-compose.yml` was
deleted for that reason.

## The part that is still true and still awkward

**The Cloudflare Worker cannot reach this database.** `worker/index.js` keeps the old
behaviour of caching the four JSON files at the edge, and the files remain the deploy
artefact. The database is where the site *reads* and where its answers are composed;
it is not yet where the deployed Worker reads from. Doing that properly needs either a
Hyperdrive binding (Cloudflare's connection pooler for Postgres) or an HTTP endpoint on
the droplet that the Worker can call — neither is built, and the Worker has not been
updated for any of this.
