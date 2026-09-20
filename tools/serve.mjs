/**
 * serve.mjs — the local development server, and the second half of the note in
 * src/app.ts about why a proxy exists at all.
 *
 * `npm run serve` (default port 4340) does two jobs:
 *
 *   1. serves `site/` as static files, so the page is reached at
 *      http://127.0.0.1:4340/ — a port, not a hostname. That is deliberate and
 *      it is house rule part 7a: DNS is created at deployment, never before, so
 *      a demo in development has no subdomain and must not have one.
 *
 *   2. proxies `/api/*` to the real feed and ADDS the cross-origin header the
 *      feed does not send, and strips its `cache-control: no-store` so a burst of
 *      polls does not hammer a volunteer-funded service.
 *
 * 🔴 WHY THE PROXY IS NOT OPTIONAL — measured 20 Sep 2026, not assumed.
 * `api.adsb.lol` answers a plain GET with NO `Access-Control-Allow-Origin` header
 * at all, and answers an OPTIONS preflight with 405. A browser therefore sends
 * the request, receives a 200 with real data, and then throws the answer away
 * because the page is not allowed to read it. Nothing in the page's own code is
 * wrong, which is exactly what makes it hard to diagnose.
 *
 * The production equivalent of this file is `worker/index.js`, a Cloudflare
 * Worker on the same `/api/*` path. Two implementations of one small contract is
 * a cost worth naming: the alternative is a Node process holding memory on a
 * droplet that has about 320 MB free and serves nine other sites.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../site', import.meta.url)));
const PORT = Number(process.env.PORT || 4340);
const UPSTREAM = 'https://api.adsb.lol';
/** The feed is run on donations. A dozen visitors polling at once is enough. */
/**
 * 🔴 ONE REQUEST TO THE FEED PER WINDOW, NO MATTER HOW MANY TABS.
 *
 * Measured 20 Sep 2026, against the live feed with a named user agent: ten requests
 * three seconds apart, ten one second apart, and eight two seconds apart were ALL
 * refused with 429 from the third or fourth request onward. The allowance is small
 * and the recovery is slow, so the page must stop treating the feed as free.
 *
 * This cache is the structural half of that. The page may ask every twenty seconds
 * and a reader may have three tabs open, and every one of those asks arrives here —
 * but only ONE of them reaches the feed per window. In local development there is no
 * CDN in front of this server, so without it each tab is its own request.
 */
const FEED_CACHE_MS = 25_000;
/** How long a last-good answer may still be served once the feed starts refusing. */
const FEED_STALE_MS = 15 * 60 * 1000;
/** Bounded, because the key is a latitude and a radius and a reader can roam. */
const FEED_CACHE_MAX = 24;
const feedCache = new Map();

function rememberFeed(target, entry) {
  feedCache.set(target, entry);
  while (feedCache.size > FEED_CACHE_MAX) feedCache.delete(feedCache.keys().next().value);
}

/**
 * 🔴 THE FEED'S OWN PATHS ARE INCONSISTENT, AND THAT IS NOT OURS TO FIX.
 *
 *   https://api.adsb.lol/v2/point/…          the aircraft endpoints — no /api
 *   https://api.adsb.lol/api/0/airport/…     the airport endpoint — its OWN /api
 *
 * So the page calls `/api/v2/…` and `/api/0/…` on this origin, and the upstream
 * path is whatever follows — EXCEPT that the `/0/` group needs the feed's own
 * `/api` put back. Getting this wrong is quiet: the aircraft endpoints keep
 * working perfectly while the airport lookup answers `{"detail":"Not Found"}`,
 * which is exactly what this file did until the curl below in the README was run.
 */
/** The postal-code lookup. Free, no key, and it sends `access-control-allow-origin: *`. */
const GEO = 'https://api.zippopotam.us';

/**
 * 🔴 EVERY REQUEST TO THE FEED MUST NAME ITSELF — measured 20 Sep 2026, five ways
 * from one machine in one second: no user-agent header → 403, `accept` alone →
 * 403, `curl/8.5.0` → 200, an honest tool name → 200, a browser user agent →
 * 200. Node sends no user agent by default, so a proxy that forgets this gets a
 * 403 that looks like the feed being down.
 */
const USER_AGENT = 'aircraft-demo (local development)';

function upstreamPath(requestUrl) {
  const url = new URL(requestUrl, 'http://localhost');
  const rest = url.pathname.replace(/^\/api/, '');
  return (rest.startsWith('/0/') ? `/api${rest}` : rest) + (url.search || '');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 🔴 NO URL THAT A VISITOR SEES ENDS IN `.html` — house rule part 1b. `/` and
 * `/index.html` are the same document, so `index.html` is a fine FILE and a bad
 * URL, and the local server behaves the way Caddy does in production rather than
 * the way a naive file server would. Otherwise a link that works here would 404
 * or bounce once deployed, which is the class of difference that only shows up
 * after a deploy.
 */
function resolvePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  if (clean !== '/' && /\.html?$/i.test(clean)) {
    return { redirect: clean.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '') };
  }
  const relative = normalize(clean).replace(/^(\.\.[/\\])+/, '');
  return { file: join(ROOT, relative === '/' ? 'index.html' : relative.replace(/^\//, '')) };
}

/**
 * 🔴 THE SITE'S OWN DATA NOW COMES FROM ITS OWN DATABASE.
 *
 * George, 20 Sep 2026: *"should be be using postgres so we can reli less on the api
 * unless we want to fetch current data, and we can associate the images and last seen
 * in the db too"*.
 *
 * So the four files this page reads — the airports, the types, the years and the
 * photographs — are answered from Postgres when it is there, and from the files when it
 * is not. The page does not change at all: it still asks for `/types.json` and gets the
 * same document. What changed is where the answer is composed, and the fact that
 * `lastSeen` is now a `max()` over every survey run rather than a field somebody has to
 * remember to carry forward.
 *
 * 🔴 AND THE FALLBACK IS NOT DECORATION. The database is a container on this machine;
 * the files are what gets deployed, because a Cloudflare Worker cannot reach it. A site
 * that breaks when a local container is down would be a worse site, so the file path
 * stays and the header says which one answered.
 */
const DATA_PATHS = new Set(['/airports.json', '/types.json', '/years.json', '/photos.json']);
/** Assembled documents are held briefly, so a poll storm cannot hammer the database. */
const CATALOGUE_MS = 30_000;
const catalogueCache = new Map();

function settings() {
  // 🔴 ROOT IS `site/`, AND THE ENV FILE IS NOT IN IT. Reading ROOT/db/.env looked for
  // `site/db/.env`, the catch below swallowed the miss, the password arrived undefined,
  // and Postgres answered `SASL: client password must be a string` — a message about
  // SASL for a fault in a path. Every fallback in this file was reached for that reason.
  const file = resolve(fileURLToPath(new URL('../db/.env', import.meta.url)));
  const fromFile = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match) fromFile[match[1]] = match[2];
    }
  } catch {
    // No db/.env is a normal state — it means Postgres was never set up here.
  }
  return {
    host: process.env.PGHOST ?? fromFile.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? fromFile.PGPORT ?? 5433),
    database: process.env.PGDATABASE ?? fromFile.PGDATABASE ?? 'aircraft',
    user: process.env.PGUSER ?? fromFile.PGUSER ?? 'aircraft',
    password: process.env.PGPASSWORD ?? fromFile.AIRCRAFT_DB_PASSWORD,
    max: 4,
    // 🔴 A DATABASE THAT IS NOT THERE MUST NOT HANG THE PAGE. Five seconds, then the
    // files answer, which is the whole point of having a fallback.
    connectionTimeoutMillis: 5_000,
  };
}

let pool = null;
async function db() {
  if (pool === null) {
    const module = await import('pg');
    pool = new module.default.Pool(settings());
    // A pool that has lost its connection must not take the server down with it.
    pool.on('error', () => {});
  }
  return pool;
}

async function buildAirports() {
  const { rows } = await db().then((p) =>
    p.query(
      `select icao, name, location, iata, lat, lon, elevation_ft
         from airports order by icao`
    )
  );
  return {
    generated: new Date().toISOString(),
    source: 'the site\'s own database',
    method: 'positions confirmed by asking the feed, then kept here',
    kept: rows.length,
    dropped: [],
    airports: rows.map((row) => ({
      icao: row.icao,
      name: row.name,
      location: row.location ?? '',
      iata: row.iata ?? '',
      lat: row.lat,
      lon: row.lon,
      elevationFt: row.elevation_ft,
    })),
  };
}

async function buildTypes() {
  const p = await db();
  const run = await p.query('select id, started_at, method, aircraft_inspected from survey_runs order by started_at desc limit 1');
  if (run.rows.length === 0) throw new Error('no survey run has been loaded');
  const latest = run.rows[0];
  // 🔴 LAST SEEN COMES FROM THE VIEW AND THIS RUN'S FREQUENCY COMES FROM THE RUN'S OWN
  // ROWS. It used to read `t.sightings`, a column on `types` that the loader overwrote
  // with whatever the file said — so a type nobody had seen for a week could still be
  // carrying last week's number. `seen` is now `sightings.seen` for the LATEST RUN only,
  // which is a fact about one look rather than a leftover.
  const types = await p.query(
    `select t.code, t.airports, t.operators, t.categories,
            l.last_seen, l.runs_seen, l.seen_in_all_runs,
            coalesce(s.seen, 0) as seen_this_run
       from types t
       left join type_last_seen l on l.code = t.code
       left join sightings s on s.code = t.code and s.run_id = $1
      order by coalesce(s.seen, 0) desc, t.code`,
    [latest.id]
  );
  const regs = await p.query('select code, reg, airports from registrations order by code, reg');
  const byCode = new Map();
  for (const row of regs.rows) {
    if (!byCode.has(row.code)) byCode.set(row.code, []);
    byCode.get(row.code).push({ reg: row.reg, airports: row.airports ?? [] });
  }
  // How much history the last-seen number actually rests on — two runs and two hundred
  // are different claims, and the page should not have to guess which it is showing.
  const runs = await p.query(
    'select count(*)::int as n, min(started_at) as first, max(started_at) as last from survey_runs'
  );
  return {
    generated: new Date(latest.started_at).toISOString(),
    method: latest.method ?? '',
    aircraftInspected: latest.aircraft_inspected ?? 0,
    counted: 'sightings (one per aircraft per round)',
    registrationsNote:
      'Up to 40 registrations per type, from aircraft that actually transmitted one. Many transponders never send a registration, so this is a sample of what identifies itself, not a fleet list.',
    // 🔴 THIS SENTENCE DESCRIBED A CARRIED-FORWARD FIELD. It now describes a view, and
    // says how many runs the view is built from.
    historyNote:
      `lastSeen and runsSeen are read from the type_last_seen view — the most recent time each type was seen, and how many runs have seen it, over ${runs.rows[0].n} survey run${runs.rows[0].n === 1 ? '' : 's'} so far. Nothing carries a date forward: a run records what it saw and nothing else. seen is this run's frequency.`,
    runsRecorded: runs.rows[0].n,
    historyFrom: new Date(runs.rows[0].first).toISOString(),
    historyTo: new Date(runs.rows[0].last).toISOString(),
    airports: [...new Set(types.rows.flatMap((row) => row.airports ?? []))].sort().map((icao) => ({ icao })),
    types: types.rows.map((row) => ({
      code: row.code,
      seen: row.seen_this_run,
      airports: row.airports ?? [],
      operators: row.operators ?? [],
      categories: row.categories ?? [],
      registrations: byCode.get(row.code) ?? [],
      lastSeen: row.last_seen === null ? null : new Date(row.last_seen).toISOString(),
      runsSeen: row.runs_seen ?? 0,
      seenInAllRuns: row.seen_in_all_runs ?? 0,
    })),
  };
}

async function buildYears() {
  const p = await db();
  const { rows } = await p.query(
    `select code, year, basis, item, matched_name, asked, exact from type_years order by code`
  );
  const years = {};
  for (const row of rows) {
    years[row.code] = {
      year: row.year,
      basis: row.basis,
      item: row.item ?? '',
      name: row.matched_name ?? '',
      asked: row.asked ?? '',
      exact: row.exact,
    };
  }
  return {
    generated: new Date().toISOString(),
    source: 'Wikidata (CC0) — https://www.wikidata.org',
    method: 'searched Wikidata for each type name, then read P606 (first flight), else P729 (service entry)',
    acceptance:
      "Three guards, measured against real failures: the item's label must be EXACTLY the name asked about, it " +
      'must carry a first-flight date, and it must be a kind of aircraft (checked by walking its instance-of up the ' +
      'subclass chain). A type that fails any of them gets no year rather than a guessed one.',
    scope:
      "The year the TYPE was first flown, not the year the individual airframe was built. No free source publishes " +
      'a build year per airframe.',
    asked: rows.length,
    resolved: rows.length,
    unmatched: [],
    years,
  };
}

async function buildPhotos() {
  const { rows } = await db().then((p) =>
    p.query(`select code, name, title, src, artist, licence, reason, confident from photos order by code`)
  );
  const found = {};
  for (const row of rows) {
    found[row.code] = {
      code: row.code,
      name: row.name ?? '',
      title: row.title,
      src: row.src,
      artist: row.artist ?? '',
      licence: row.licence ?? '',
      reason: row.reason ?? '',
      confident: row.confident,
    };
  }
  return {
    generated: new Date().toISOString(),
    source: 'Wikimedia Commons (free licences, credit printed on every row)',
    found,
    missing: [],
  };
}

const BUILDERS = {
  '/airports.json': buildAirports,
  '/types.json': buildTypes,
  '/years.json': buildYears,
  '/photos.json': buildPhotos,
};

/**
 * Answer one of the four data paths — from the database when it can, from the file when
 * it cannot, and SAY WHICH in `x-data-source` so a wrong answer is never silent.
 */
async function serveData(path, response) {
  const cached = catalogueCache.get(path);
  if (cached && Date.now() - cached.at < CATALOGUE_MS) {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-data-source': 'database-cached',
    });
    response.end(cached.body);
    return;
  }

  try {
    const document = await BUILDERS[path]();
    const body = JSON.stringify(document, null, 2) + '\n';
    catalogueCache.set(path, { at: Date.now(), body });
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-data-source': 'database',
    });
    response.end(body);
    return;
  } catch (error) {
    // The file path, which is also the deploy artefact. A reader must not see a broken
    // page because a container on somebody's laptop is stopped.
    //
    // 🔴 ROOT IS ALREADY `site/`, so the path is joined to it directly. The first
    // version joined `site` on again and every fallback looked for
    // `site/site/types.json` — which turned a working database into a 503 that named
    // the FILE's error and hid the database's.
    try {
      const body = await readFile(join(ROOT, path.replace(/^\//, '')));
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-data-source': 'file',
        'x-data-warning': String(error.message).slice(0, 120),
      });
      response.end(body);
    } catch (fileError) {
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({
          ok: false,
          // 🔴 BOTH ERRORS, OR THE ONE THAT MATTERS IS THE ONE YOU CANNOT SEE.
          error:
            `Neither the database nor the file answered for ${path}. ` +
            `Database: ${error.message} File: ${fileError.message}`,
        })
      );
    }
  }
}

async function serveStatic(request, response) {
  const resolved = resolvePath(new URL(request.url, 'http://localhost').pathname);
  if (resolved.redirect) {
    response.writeHead(301, { location: resolved.redirect });
    response.end();
    return;
  }

  let file = resolved.file;
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(ROOT, 'index.html'); // the app shell, exactly as production does
  }

  try {
    const body = await readFile(file);
    // 🔴 THE SHELL IS `no-store`, OR A DEPLOY IS INVISIBLE. A browser holding the
    // old shell paints the old page without ever asking the server, so a correct
    // deploy looks exactly like no deploy. House rule part 7.
    const headers = {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    };
    response.writeHead(200, headers);
    response.end(body);
  } catch (error) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`Not found: ${error.message}\n`);
  }
}

/**
 * 🔴 A CANADIAN POSTAL CODE RESOLVES ON ITS FIRST THREE CHARACTERS, AND THAT IS
 * THE SERVICE'S RULE, NOT A SHORTCUT WE TOOK. Measured 20 Sep 2026:
 *
 *   /ca/L8E     → 200, "Hamilton (Confederation Park / Nashdale / East Kentley /
 *                 Riverdale / Lakely / Grayside / North Stoney Creek)", 43.2318, -79.7696
 *   /ca/[redacted]  → 404, {}
 *   /us/14201   → 200, Buffalo, 42.8967, -78.8846
 *
 * So a reader who types the whole six characters gets the right place, and is
 * never told they typed it wrong — the truncation happens here, where the reason
 * for it can be written down.
 */
function postalTarget(raw) {
  const clean = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(clean)) return { country: 'ca', code: clean.slice(0, 3) };
  if (/^[A-Z]\d[A-Z]$/.test(clean)) return { country: 'ca', code: clean };
  if (/^\d{5}$/.test(clean)) return { country: 'us', code: clean };
  return null;
}

async function servePostal(raw, response) {
  const json = (status, body) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(body));
  };

  const target = postalTarget(raw);
  if (!target) {
    json(400, {
      ok: false,
      error:
        'That is not a Canadian postal code or a five-digit ZIP code. A Canadian one looks like [redacted] ' +
        '(and the first three characters are enough), and an American one is five digits.',
    });
    return;
  }

  try {
    const upstream = await fetch(`${GEO}/${target.country}/${target.code}`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
    if (upstream.status === 404) {
      json(404, { ok: false, error: `Nothing is listed for ${target.code}.` });
      return;
    }
    if (!upstream.ok) throw new Error(`${upstream.status}`);
    const body = await upstream.json();
    const place = Array.isArray(body.places) ? body.places[0] : null;
    if (!place) {
      json(404, { ok: false, error: `Nothing is listed for ${target.code}.` });
      return;
    }
    json(200, {
      ok: true,
      lookedUp: target.code,
      country: body.country,
      region: place.state,
      place: place['place name'],
      lat: Number(place.latitude),
      lon: Number(place.longitude),
      note:
        'A postal code covers a whole delivery area, so this is the centre of an area and not a street address. ' +
        'Airports are then listed by distance from it.',
    });
  } catch (error) {
    json(503, {
      ok: false,
      error: `The postal code lookup could not be reached (${error instanceof Error ? error.message : error}).`,
    });
  }
}

/**
 * 🔴 THE MAP IS A FREE SERVICE, AND THE VISITOR NEVER TALKS TO IT.
 *
 * George, 20 Sep 2026: *"instead of ggoogle maps, use a free service"*. Measured
 * before choosing, from this machine, with no key: `tile.openstreetmap.org` 200
 * (39861 bytes of PNG), CARTO's `basemaps.cartocdn.com` 200, OpenTopoMap 200, and
 * Stadia **401 — it wants a key**. OpenStreetMap is the canonical free one, it is
 * ODbL-licensed, and it asks in its own tile policy to be cached and to be told
 * who is asking.
 *
 * 🔴 SO THE BROWSER ASKS *US*, NOT THEM. The page requests
 * `/api/tiles/{z}/{x}/{y}.png` on its own origin and this route fetches the tile
 * and passes it back. That is the same shape as the flight feed, and it is what
 * keeps two promises at once: the map is a free third-party service, and no
 * visitor's browser has to make a request to a third party before they have
 * answered the cookie question. The alternative — an `<img>` pointing straight at
 * the tile server — would put every reader's IP address in a stranger's log on
 * page load, on a site whose first section says it does not do that.
 *
 * Attribution is required by the licence and is printed on the map itself.
 */
const TILES = 'https://tile.openstreetmap.org';

/** Only these shapes are proxied, and only within the zoom range the page uses. */
function tilePath(path) {
  const match = /^\/api\/tiles\/(\d{1,2})\/(\d+)\/(\d+)\.png$/.exec(path);
  if (!match) return null;
  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!Number.isInteger(z) || z < 3 || z > 16) return null;
  const span = 2 ** z;
  if (!Number.isInteger(x) || x < 0 || x >= span) return null;
  if (!Number.isInteger(y) || y < 0 || y >= span) return null;
  return { z, x, y };
}

/**
 * 🔴 A PHOTOGRAPH, FROM A FREE SOURCE, FETCHED BY US AND NOT BY THE READER.
 *
 * Same shape as the map tiles and for the same reason: an `<img>` pointed at
 * Wikimedia would hand every visitor's address to a third party on page load. So
 * the page asks its own origin and this route fetches the file.
 *
 * 🔴 AND IT IS A CLOSED LIST, NOT AN OPEN RELAY. `/api/photo?src=…` will fetch
 * from Wikimedia's two media hosts and nowhere else — a proxy that fetches
 * whatever URL it is handed is a service for other people's traffic, and the
 * first person to notice would be somebody using it to hide their own.
 */
const PHOTO_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org'];

function photoTarget(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!PHOTO_HOSTS.includes(url.hostname)) return null;
  // Every Commons file lives under these two paths; anything else on the host is
  // not a photograph and has no business coming through here.
  if (!url.pathname.startsWith('/wikipedia/commons/')) return null;
  return url;
}

async function servePhoto(raw, response) {
  const url = photoTarget(raw);
  if (!url) {
    response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    response.end(
      JSON.stringify({ ok: false, error: 'Only photographs from Wikimedia Commons are served here.' })
    );
    return;
  }
  try {
    const upstream = await fetch(url.toString(), {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
    if (!upstream.ok) throw new Error(`the image host answered ${upstream.status}`);
    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(200, {
      'content-type': upstream.headers.get('content-type') || 'image/jpeg',
      // A Commons file at a given name never changes either.
      'cache-control': 'public, max-age=2592000, immutable',
    });
    response.end(body);
  } catch (error) {
    response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: false, error: `A photograph could not be fetched. ${error.message}` }));
  }
}

async function serveTile(path, response) {
  const tile = tilePath(path);
  if (!tile) {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: false, error: 'Not a tile this proxy serves.' }));
    return;
  }
  try {
    const upstream = await fetch(`${TILES}/${tile.z}/${tile.x}/${tile.y}.png`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
    if (!upstream.ok) throw new Error(`the tile server answered ${upstream.status}`);
    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(200, {
      'content-type': upstream.headers.get('content-type') || 'image/png',
      // A tile at a given z/x/y never changes, so this is cached hard at both
      // ends. The tile server's own policy asks for exactly this.
      'cache-control': 'public, max-age=2592000, immutable',
    });
    response.end(body);
  } catch (error) {
    // 503, never 502 — see the note above `serveApi`.
    response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: false, error: `A map tile could not be fetched. ${error.message}` }));
  }
}

async function serveApi(request, response) {
  const path = new URL(request.url, 'http://localhost').pathname;
  // The postal lookup is a DIFFERENT upstream with a different answer shape, so
  // it is normalised here rather than passed through — the page must not depend
  // on the field names of a service that is free and owes us nothing.
  if (path.startsWith('/api/photo')) {
    await servePhoto(new URL(request.url, 'http://localhost').searchParams.get('src'), response);
    return;
  }
  if (path.startsWith('/api/tiles/')) {
    await serveTile(path, response);
    return;
  }
  if (path.startsWith('/api/geo/postal/')) {
    await servePostal(decodeURIComponent(path.slice('/api/geo/postal/'.length)), response);
    return;
  }

  const target = UPSTREAM + upstreamPath(request.url);
  const now = Date.now();
  const cached = feedCache.get(target);

  if (cached && now - cached.at < FEED_CACHE_MS) {
    response.writeHead(200, {
      'content-type': cached.type,
      'access-control-allow-origin': '*',
      // Not cached by the browser on purpose: the page polls this, and a browser
      // holding its own copy makes the page's idea of "when was this read" wrong.
      'cache-control': 'no-store',
      'x-feed-cache': 'fresh',
      'x-feed-age-ms': String(now - cached.at),
    });
    response.end(cached.body);
    return;
  }

  try {
    const upstream = await fetch(target, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
    const text = await upstream.text();

    if (upstream.ok) {
      const type = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
      rememberFeed(target, { at: now, body: text, type });
      response.writeHead(200, {
        'content-type': type,
        // The header the feed does not send, and the only reason this proxy exists.
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'x-feed-cache': 'miss',
        'x-feed-age-ms': '0',
      });
      response.end(text);
      return;
    }

    // 🔴 REFUSED — SO SERVE THE LAST THING WE HEARD, AND SAY HOW OLD IT IS. George,
    // 20 Sep 2026, was shown the 429 message over a table that had data in it, which
    // is the worst of both: the page told him it had failed and then showed him a
    // reading with no indication it was old. The upstream status travels in
    // `x-feed-status` instead, so the page keeps its data, can still back off, and
    // can date what it is showing.
    if (cached && now - cached.at < FEED_STALE_MS) {
      response.writeHead(200, {
        'content-type': cached.type,
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'x-feed-cache': 'stale',
        'x-feed-age-ms': String(now - cached.at),
        'x-feed-status': String(upstream.status),
      });
      response.end(cached.body);
      return;
    }

    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'x-feed-status': String(upstream.status),
    });
    response.end(text);
  } catch (error) {
    // 🔴 503 — NEVER 502. Behind Cloudflare, a 502 from an origin has its body
    // REPLACED by the edge's own HTML page, so the sentence written for the
    // reader is destroyed and the page reports a JSON parse error instead. 503
    // is passed straight through. House rule part 8a. The local server has no
    // edge in front of it, which is exactly why it must behave the same way.
    response.writeHead(503, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    response.end(
      // 🔴 NO `upstream` HERE. It is declared inside the `try` above, so naming it
      // in the `catch` throws a ReferenceError from the error handler itself — the
      // one place that must never throw. That is not a hypothetical: it killed this
      // server on 20 Sep 2026, and the page could only report "Failed to fetch"
      // because by then nothing was listening.
      JSON.stringify({
        ok: false,
        error: `The feed could not be reached. ${error.message}`,
      })
    );
  }
}

const server = createServer((request, response) => {
  // 🔴 A NET UNDER EVERY ROUTE, because a server that dies is worse than a route
  // that fails: a dead server answers nothing at all, so the page cannot even say
  // what went wrong. Whatever a handler throws, the reader gets a sentence.
  const guard = (work) => {
    Promise.resolve(work).catch((error) => {
      console.error(`${request.url} → ${error.stack ?? error}`);
      if (response.headersSent) {
        response.end();
        return;
      }
      response.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify({ ok: false, error: `This route failed. ${error.message}` }));
    });
  };

  if ((request.url || '').startsWith('/api/')) {
    guard(serveApi(request, response));
    return;
  }
  const dataPath = new URL(request.url, 'http://localhost').pathname;
  if (DATA_PATHS.has(dataPath)) {
    guard(serveData(dataPath, response));
    return;
  }
  guard(serveStatic(request, response));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`aircraft-demo → http://127.0.0.1:${PORT}/  (proxying /api to ${UPSTREAM})`);
});
