-- ---------------------------------------------------------------------------
-- aircraft-demo — what this site knows, kept in one place.
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
