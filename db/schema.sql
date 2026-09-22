-- ---------------------------------------------------------------------------
-- planewatch — what this site knows, kept in one place.
--
-- 🔴 WHY A DATABASE AT ALL, IN GEORGE'S WORDS. 20 Sep 2026: *"as for last seen can
-- yuo know fix that? should be be using postgres so we can reli less on the api
-- unless we want to fetch current data, and we can associate the images and last
-- seen in the db too"*.
--
-- That is exactly the split this schema draws:
--
--   · THE FEED IS FOR THE PRESENT. Aircraft in the air right now come from
--     api.adsb.lol on every poll, because nobody else has them.
--   · EVERYTHING ELSE IS OURS. The airports, the types, which type was seen at
--     which airport, the tail numbers, the years, the photographs and — the reason
--     for all of it — WHEN EACH TYPE WAS LAST SEEN. None of that changes minute to
--     minute, and asking a volunteer feed for it again on every page load is both
--     wasteful and the thing that got this page rate-limited earlier the same day.
--
-- 🔴 `last_seen` IS A VIEW, NOT A COLUMN SOMEBODY HAS TO REMEMBER TO UPDATE. Every
-- survey run inserts its own rows into `sightings`, and the answer is a query over
-- them. That is what makes the number get BETTER the more often the survey is run,
-- which is the whole request: *"something that is never going to fly soon is a
-- useless selection"* cannot be answered from one look at the sky.
-- ---------------------------------------------------------------------------

-- The airports this site knows, with the positions the feed confirmed for them.
CREATE TABLE IF NOT EXISTS airports (
  icao         text PRIMARY KEY,
  name         text NOT NULL,
  location     text,
  iata         text,
  lat          double precision NOT NULL,
  lon          double precision NOT NULL,
  elevation_ft integer
);

-- Aircraft types the feed has actually been seen showing.
CREATE TABLE IF NOT EXISTS types (
  code         text PRIMARY KEY,
  airports     text[] NOT NULL DEFAULT '{}',
  operators    text[] NOT NULL DEFAULT '{}',
  categories   text[] NOT NULL DEFAULT '{}',
  -- Sightings within the MOST RECENT run. The frequency over a short sample, and
  -- deliberately not a running total across runs — those are two different facts and
  -- adding them together would mean neither.
  sightings    integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Tail numbers, and which airports each one was seen at. A registration is only in
-- here when the feed actually transmitted one.
CREATE TABLE IF NOT EXISTS registrations (
  code       text NOT NULL REFERENCES types(code) ON DELETE CASCADE,
  reg        text NOT NULL,
  airports   text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (code, reg)
);

-- When each type first flew, and where that answer came from. Every column is kept
-- so a wrong match can be traced to the item that produced it.
CREATE TABLE IF NOT EXISTS type_years (
  code         text PRIMARY KEY,
  year         integer NOT NULL,
  basis        text NOT NULL,
  item         text,
  matched_name text,
  asked        text,
  exact        boolean NOT NULL DEFAULT false
);

-- Photographs and the credit their licence requires. `artist` and `licence` are not
-- decoration: an uncredited image is a licence breach, so they are columns and not a
-- comment. The column names are the FILE's own names rather than prettier ones, so
-- nothing has to be translated on the way in or out.
CREATE TABLE IF NOT EXISTS photos (
  code       text PRIMARY KEY,
  name       text,
  title      text NOT NULL,
  src        text NOT NULL,
  artist     text,
  licence    text,
  reason     text,
  confident  boolean NOT NULL DEFAULT true
);

-- One row per survey run. `started_at` is the natural key, so re-loading the same
-- file twice cannot invent a second run and double every count.
CREATE TABLE IF NOT EXISTS survey_runs (
  id                  bigserial PRIMARY KEY,
  started_at          timestamptz NOT NULL UNIQUE,
  method              text,
  aircraft_inspected  integer,
  source              text
);

-- One row per (run, type). THIS is the table that makes last-seen real: each run
-- adds its own rows and the answer is a max() over all of them.
CREATE TABLE IF NOT EXISTS sightings (
  run_id      bigint NOT NULL REFERENCES survey_runs(id) ON DELETE CASCADE,
  code        text NOT NULL,
  sighted_at  timestamptz NOT NULL,
  seen        integer NOT NULL,
  PRIMARY KEY (run_id, code)
);

CREATE INDEX IF NOT EXISTS sightings_code_idx ON sightings (code, sighted_at DESC);
CREATE INDEX IF NOT EXISTS registrations_reg_idx ON registrations (reg);

-- 🔴 THE ANSWER TO "IS THIS ONE WORTH WATCHING", COMPUTED RATHER THAN STORED.
CREATE OR REPLACE VIEW type_last_seen AS
  SELECT code,
         max(sighted_at)              AS last_seen,
         count(*)::int                AS runs_seen,
         coalesce(sum(seen), 0)::int  AS seen_in_all_runs
    FROM sightings
   GROUP BY code;

-- ---------------------------------------------------------------------------
-- HISTORIC AIRCRAFT, AND THE DAYS THEY FLY.
--
-- 🔴 THIS IS THE POINT OF THE PAGE, IN GEORGE'S WORDS. 20 Sep 2026: *"thats the whole
-- point actually, to watch these old aircraft fly past your home location"*. A reader is
-- not at this page to count 737s past their window. They are there for the rare one — and
-- the rare one is rare BY SCHEDULE: it flies from a named airfield, on named days.
--
-- So the schedule is TABLES, not a paragraph in a README. It was written as a README note
-- first and George asked the question that fixes it — *"shoudnt these be in the api?"* —
-- which is the same instruction the rest of this file follows: if it is data, it lives
-- here and the API composes it.
--
-- ⚠️ WHAT THIS IS NOT. It is not a promise that the feed will report these aircraft. A
-- museum tour flight is a real flight, so an equipped airframe that transmits will appear
-- in `sightings` like anything else — but a reader must not be told to expect one. The
-- truth about whether a type has ever been reported is a JOIN against `types` at read
-- time (see `historic_aircraft.feed_seen` below), never a column somebody asserts.
-- ---------------------------------------------------------------------------

-- A place where historic aircraft are based and flown. Keyed on the airport the site
-- already knows, so "is this near me" is the same distance question as everything else.
CREATE TABLE IF NOT EXISTS historic_sites (
  id       bigserial PRIMARY KEY,
  icao     text NOT NULL REFERENCES airports(icao),
  name     text NOT NULL,
  url      text NOT NULL,
  note     text,
  -- What was read and when, so a stale claim can be told from a fresh one.
  source   text NOT NULL,
  read_at  timestamptz NOT NULL,
  UNIQUE (icao, name)
);

-- The aircraft a site flies, as the site itself names them. `their_id` is the museum's own
-- identifier for the aircraft: it is what the schedule's own pages branch on, so keeping it
-- means a row here can always be traced back to the thing that produced it.
CREATE TABLE IF NOT EXISTS historic_aircraft (
  site_id           bigint NOT NULL REFERENCES historic_sites(id) ON DELETE CASCADE,
  their_id          integer NOT NULL,
  -- The aircraft's name on its own, and the label the schedule prints, kept separately
  -- because one is a name and the other is a sentence.
  name              text NOT NULL,
  event_label       text NOT NULL,
  -- The feed's ICAO type designator, and where that came from — NULL where no source has
  -- been found rather than a code chosen because it looks right. `LNC4` is a Lancair and
  -- `LANC` is a Lancaster; a name-shaped guess is how a page ends up announcing the wrong
  -- aeroplane.
  type_code         text,
  code_source       text,
  PRIMARY KEY (site_id, their_id)
);

-- One row per flight the site publishes. Keyed on THEIR event id, so re-reading the same
-- day twice cannot invent a second flight.
CREATE TABLE IF NOT EXISTS historic_flights (
  site_id     bigint NOT NULL REFERENCES historic_sites(id) ON DELETE CASCADE,
  their_id    bigint NOT NULL,
  their_aircraft_id integer NOT NULL,
  begins_at   timestamptz NOT NULL,
  seats       text,
  url         text NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, their_id)
);

CREATE INDEX IF NOT EXISTS historic_flights_begins_idx ON historic_flights (site_id, begins_at);
CREATE INDEX IF NOT EXISTS historic_sites_icao_idx ON historic_sites (icao);

-- The next day something historic is flying at each site, and how much is still to come.
-- A view for the same reason `type_last_seen` is one: it is a question about the rows, and
-- a stored copy would be a column somebody has to remember to update.
CREATE OR REPLACE VIEW historic_next AS
  SELECT site_id,
         min(begins_at) FILTER (WHERE begins_at > now())                      AS next_at,
         count(*) FILTER (WHERE begins_at > now())::int                       AS upcoming,
         count(DISTINCT date_trunc('day', begins_at))::int                    AS days_published
    FROM historic_flights
   GROUP BY site_id;
