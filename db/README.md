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

## The rounds, and why there is a timer

`types.json` once held a single reading, so every type carried the same timestamp and
"in the last day", "in the last week" and "in the last month" were the same set. That
is not a bug in the filter — it is what one reading can support. **Last-seen works by
rounds accumulating.**

```bash
tools/run-survey.sh              # one round: survey, then load
tools/run-survey.sh --check      # say what is in the database, ask the feed nothing
npm run survey                   # the survey alone, writing site/types.json
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
