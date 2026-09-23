/**
 * worker/index.js — the production half of the proxy, for Cloudflare Workers.
 *
 * The page calls `/api/...` on its OWN origin. In development that is handled by
 * tools/serve.mjs. In production it is handled here, on a route bound to
 * `airplane-watch.nodejavascript.com/api/*`.
 *
 * 🔴 WHY A PROXY, AND WHY IT CANNOT BE AVOIDED — measured 20 Sep 2026.
 * `api.adsb.lol` answers a plain GET with **no `Access-Control-Allow-Origin`
 * header at all**, and answers an OPTIONS preflight with **405**. A browser
 * therefore sends the request, receives a real 200 with real aircraft, and then
 * discards the answer because the page is not permitted to read it. There is no
 * client-side arrangement of the page that fixes this; the header has to come
 * from something that is not the feed.
 *
 * 🔴 AND THE PRODUCTION PROXY DELIBERATELY DOES **NOT** SEND `Access-Control-Allow-Origin`.
 * tools/serve.mjs sends `*`, because on this machine a second local port is
 * sometimes used to try the page. Production does not, and should not: the page
 * is same-origin, so it needs no CORS header at all, and sending a wildcard would
 * turn this Worker into an open relay for anybody's browser to spend adsb.lol's
 * bandwidth through. Same contract, one deliberate difference — and the
 * difference is the safer of the two.
 *
 * 🔴 NEVER ANSWER 502. House rule part 8a: behind Cloudflare an origin's 502 has
 * its body REPLACED by the edge's own HTML error page, so the explanation written
 * for the reader is destroyed and the page reports a JSON parse error instead.
 * That is exactly what happened on rag-demo on 19 Sep 2026. 503 is passed through
 * untouched, which is why every failure below is a 503.
 */

/**
 * 🔴 THE FEED IS ASKED FROM THE DROPLET'S OWN ADDRESS, NOT FROM HERE — 23 September 2026.
 *
 * This read `https://api.adsb.lol` and asked it from the Worker, whose egress is a pool shared with every
 * other Workers customer. Measured at the same moment: adsb.lol answered this Worker **429** on /v2/point
 * and on /v2/hex while it answered **200 with real aircraft** to the dvs-sites droplet — and it answered
 * **200** to this Worker on /0/me, so it is a limit on the data endpoints keyed to the asking address, not
 * a ban on the address and not a broken Worker.
 *
 * So the Worker now asks `airplane-watch.nodejavascript.com/feed…`, and **Caddy on the droplet asks
 * adsb.lol** from the droplet's address. **Only the egress changes:** the edge cache, the cooldown, the
 * stale reading served with its age, and the refusal written in this site's own words all stay exactly as
 * they were. `upstreamPath()` already produces the feed's own path — `/v2/…` and `/api/0/…` — so the
 * mapping on the droplet is a single strip of `/feed`, with no per-endpoint special cases.
 *
 * The token is what keeps that path from being an open relay through the droplet's address. It is a Worker
 * secret; the matching value lives in the droplet's Caddyfile.
 */
import { reportBrowserFault, reportFailure } from './rollbar.js';

const UPSTREAM = 'https://airplane-watch.nodejavascript.com/feed';
const CACHE_SECONDS = 25;

/**
 * 🔴 ONE REQUEST TO THE FEED PER WINDOW — AND WHY THE MAP BELOW WAS NOT ENOUGH.
 *
 * Measured 20 Sep 2026 against the live feed, with a named user agent: ten requests
 * three seconds apart, ten one second apart, and eight two seconds apart were ALL
 * refused with 429 from the third or fourth request onward.
 *
 * 🔴 SUPERSEDED 23 Sep 2026 — THIS COMMENT USED TO SAY THE HEADER WAS THE REAL FIX AND THE MAP WAS
 * THE STOPGAP. *Prior wording, kept because it was acted on:* *"The `cache-control` header below is
 * what shares an answer between readers across the Cloudflare cache — that is the real fix at the
 * edge — and this map covers the case where the Worker is invoked anyway."* **Measured, and it does
 * not do that: a request through this proxy answers with NO `cf-cache-status` header at all**, so an
 * extension-less `/api/...` path is not being cached by the edge on the strength of a `cache-control`
 * header. The map was therefore doing all of the work, and a map lives inside ONE isolate — so a few
 * visitors landing on different isolates meant a few upstream calls, and the feed refused them.
 *
 * 🔴 AND THE MEASUREMENT THAT SETTLED IT — 23 Sep 2026, the same URL a minute apart:
 *
 *   · through this Worker (Cloudflare's shared egress)  → **429**, repeatedly, over several minutes
 *   · from the dvs-sites droplet, which has its own IP  → **200**
 *   · from George's machine                            → **200**
 *
 * **So the feed is not refusing this site for asking too often — it is refusing Cloudflare's egress
 * address, which every Workers customer shares.** No cadence change inside the Worker can fix that
 * on its own, and the honest engineering is: ask less, ask less often, and never hand a reader
 * somebody else's 429 page. That is what the edge cache and the cooldown below do.
 */
const FEED_CACHE_MS = 25_000;
const FEED_STALE_MS = 15 * 60 * 1000;
const FEED_CACHE_MAX = 24;
const feedCache = new Map();

/**
 * 🔴 A REFUSAL BUYS QUIET, AND THIS IS THE HALF THE PROXY WAS MISSING.
 *
 * A rate limit is an INSTRUCTION, not an error to report: the polite answer is to stop asking for a
 * while. The proxy had no such memory — every visitor's poll went upstream — so a dozen readers
 * meant a dozen refusals an hour where one would have done, and each one of them went out from an
 * address that was already being refused. The cooldown starts at a minute, doubles on each refusal
 * (up to ten), honours `Retry-After` when the feed names one, and is CLEARED OUTRIGHT by a good
 * answer — the allowance is back, so there is nothing to stay quiet about.
 *
 * It is per isolate, like the map above, so it is best-effort; the edge cache is what makes it
 * usually unnecessary, and `stale-while-we-wait` is what makes it invisible when it is not.
 */
const COOLDOWN_START_MS = 60_000;
const COOLDOWN_MAX_MS = 10 * 60 * 1000;
let cooldownMs = COOLDOWN_START_MS;
let cooldownUntil = 0;
let refusedWith = 0;

function rememberFeed(target, entry) {
  feedCache.set(target, entry);
  while (feedCache.size > FEED_CACHE_MAX) feedCache.delete(feedCache.keys().next().value);
}

/**
 * 🔴 THE EDGE CACHE, GUARDED. The Cache API is available to a Worker on a route of a hostname in its
 * own zone, and this Worker is on `airplane-watch.nodejavascript.com/api/*` — but a proxy that THROWS
 * because a cache call was unexpected is worse than one that simply does not cache, so both calls
 * below are allowed to fail to a no-op and the in-memory map still covers the isolate.
 *
 * It is per data centre, which the docs state plainly, so it does not share an answer between
 * continents — nothing free does. It shares one between every reader in the same one, which is the
 * case that was costing us: the cache key is the upstream URL, so two readers watching two different
 * airports ask two different questions and neither is answered with the other's data.
 */
async function edgeMatch(key) {
  try {
    return (await caches.default.match(key)) ?? null;
  } catch {
    return null;
  }
}

async function edgePut(key, response) {
  try {
    await caches.default.put(key, response);
  } catch {
    // Nothing to do and nothing to say: the map covers this isolate, and the cooldown covers the rest.
  }
}

/** `Retry-After` is either seconds or an HTTP date; both are legal, and the feed may send neither. */
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, COOLDOWN_MAX_MS);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), COOLDOWN_MAX_MS);
  return null;
}

/** A reading the page can use, with how old it is. One shape, so every path dates what it serves. */
function feedReading(entry, now, how) {
  return new Response(entry.body, {
    status: 200,
    headers: {
      'content-type': entry.type,
      'cache-control': `public, max-age=${CACHE_SECONDS}`,
      'x-proxied-from': 'adsb.lol',
      'x-feed-cache': how,
      'x-feed-age-ms': String(Math.max(0, now - entry.at)),
    },
  });
}

/**
 * 🔴 WHAT A READER GETS WHEN THE FEED REFUSES — AND IT IS NEVER THE FEED'S OWN ERROR PAGE.
 *
 * George, 23 Sep 2026, looking at the live site: *"maybe i dont want to see this again"*. What he was
 * looking at was **nginx's 429 page, passed straight through** — because this branch used to end by
 * returning the upstream body and status verbatim, and that only happened when the isolate held no
 * cached reading, which is exactly the state a first visitor lands in. So the reader got a stranger's
 * error page and a paragraph about our polling, and nothing to look at.
 *
 * It is two answers now, and which one is honest depends on whether we have anything to show:
 *   · we have a reading — serve it, as a 200, and put the refusal in `x-feed-status` with the age in
 *     `x-feed-age-ms`. The page keeps its picture and dates it;
 *   · we have nothing — answer in JSON, 503 (never 502, house part 8a), in this site's own words, so
 *     the page can say it in one short line instead of relaying somebody else's HTML.
 */
function refusal(cached, now, status) {
  if (cached && now - cached.at < FEED_STALE_MS) {
    const reading = feedReading(cached, now, 'stale');
    reading.headers.set('x-feed-status', String(status));
    return reading;
  }
  return json(
    503,
    {
      ok: false,
      error:
        'The feed is refusing requests from this site just now, so there is nothing to show yet. ' +
        'It is a volunteer service and answers a limited number of requests; the page will try again shortly.',
      feed_status: status,
    },
    { 'x-feed-status': String(status) },
  );
}

/**
 * 🔴 WHERE AN AIRCRAFT IS GOING IS NOT IN THE FEED — measured 22 Sep 2026. The feed's own
 * `/v2/callsign/DAL1719` answers with the aircraft record and no route at all: ADS-B carries who
 * the aircraft is, never where it is booked to. The route comes from `api.adsbdb.com`, which maps
 * a callsign to an origin and a destination, and it is fetched from here for the same reasons the
 * feed is — no CORS on the page's own origin, and the visitor's browser is not sent to a third
 * party. The answer is normalised to this site's field names, exactly as the dev server does it,
 * so the page cannot tell the two apart.
 */
const ROUTE_UPSTREAM = 'https://api.adsbdb.com/v0/callsign';
const ROUTE_CACHE_MAX = 400;
const routeCache = new Map();

function rememberRoute(callsign, body) {
  routeCache.set(callsign, { at: Date.now(), body });
  while (routeCache.size > ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value);
}

function routeAirport(raw) {
  const row = raw ?? {};
  const icao = String(row.icao_code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(icao)) return null;
  return {
    icao,
    iata: String(row.iata_code ?? '').trim().toUpperCase(),
    city: String(row.municipality ?? '').trim(),
    country: String(row.country_iso_name ?? '').trim().toUpperCase(),
    name: String(row.name ?? '').trim(),
  };
}

function normaliseRoute(payload) {
  const route = payload?.response?.flightroute;
  if (!route) return null;
  const origin = routeAirport(route.origin);
  const destination = routeAirport(route.destination);
  if (!origin || !destination) return null;
  return {
    airline: String(route.airline?.name ?? '').trim(),
    origin,
    destination,
  };
}

async function serveRoute(rawCallsign) {
  const callsign = String(rawCallsign ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(callsign)) {
    return json(400, { ok: false, error: 'A callsign is up to eight letters and digits.' });
  }

  const cached = routeCache.get(callsign);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) {
    return new Response(JSON.stringify(cached.body), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=21600' },
    });
  }

  let upstream;
  try {
    upstream = await fetch(`${ROUTE_UPSTREAM}/${encodeURIComponent(callsign)}`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    // 503, never 502 — see the note at the top of this file.
    return json(503, { ok: false, error: `The route lookup could not be reached. ${error.message}` });
  }

  // 🔴 A CALLSIGN WITH NO PUBLISHED ROUTE IS AN ANSWER, NOT A FAILURE: adsbdb answers 404, and the
  // page prints a dash. Cached like any other answer, because it will still be true in an hour.
  if (upstream.status === 404) {
    const body = { ok: true, callsign, route: null };
    rememberRoute(callsign, body);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=21600' },
    });
  }
  if (!upstream.ok) return json(503, { ok: false, error: `The route lookup answered ${upstream.status}.` });

  const payload = await upstream.json().catch(() => null);
  const body = { ok: true, callsign, route: normaliseRoute(payload) };
  rememberRoute(callsign, body);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=21600' },
  });
}

/** 🔴 THE FREE MAP, ASKED FOR BY US AND NEVER BY THE VISITOR. See the note in
 * tools/serve.mjs — same decision, same reasons. A tile at a given z/x/y never
 * changes, so it is cached at the edge for a month, which is what the tile
 * server's own usage policy asks for. */
const TILES = 'https://tile.openstreetmap.org';

/** 🔴 A CLOSED LIST, NOT AN OPEN RELAY. `/photo?src=…` fetches from Wikimedia's
 * two media hosts and nowhere else — a proxy that fetches whatever URL it is
 * handed is a service for other people's traffic. Same rule as tools/serve.mjs. */
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
  if (!url.pathname.startsWith('/wikipedia/commons/')) return null;
  return url;
}

async function servePhoto(raw) {
  const url = photoTarget(raw);
  if (!url) return json(400, { ok: false, error: 'Only photographs from Wikimedia Commons are served here.' });
  try {
    const upstream = await fetch(url.toString(), {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
    if (!upstream.ok) throw new Error(`the image host answered ${upstream.status}`);
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'image/jpeg',
        'cache-control': 'public, max-age=2592000, immutable',
        'cdn-cache-control': 'max-age=2592000',
        'x-proxied-from': 'wikimedia.org',
      },
    });
  } catch (error) {
    // 503, never 502 — see the note at the top of this file.
    return json(503, { ok: false, error: `A photograph could not be fetched. ${error.message}` });
  }
}

/**
 * 🔴 EVERY OUTBOUND REQUEST MUST NAME ITSELF — measured 20 Sep 2026. Fetched five
 * ways from one machine in one second: no user-agent header → 403 Forbidden,
 * `accept` alone → 403, `curl/8.5.0` → 200, an honest tool name → 200, a browser
 * user agent → 200. So a request with no user agent is refused, and the failure
 * looks like the feed being down rather than like the request being turned away.
 */
/**
 * 🔴 WHO THE FEED SEES WHEN THIS SITE ASKS — and it was the old name until 23 Sep 2026.
 *
 * It read `'planewatch.nodejavascript.com'`, which was true until the site was renamed that morning.
 * A volunteer service reads its logs to decide who to throttle, and adsb.lol's own terms ask a
 * production user to *"contact me so I do not break your application by accident"* — so the name and
 * the address it is reachable at belong in the string, and a stale one is worse than none.
 */
const USER_AGENT =
  'airplane-watch.nodejavascript.com (+https://airplane-watch.nodejavascript.com/)';

/**
 * A place, searched by NAME.
 *
 * The counterpart of the dev server's route, so production and development answer the same
 * shape — George asked for the interaction he knows from inputresponse.com: type a place, get a
 * list, pick one.
 */
async function servePlaceSearch(raw) {
  const query = String(raw ?? '').trim();
  if (query.length < 2) {
    return json(400, { ok: false, error: 'Type at least two characters of a place name.' });
  }

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '6',
    // Canada and the United States: the fence is drawn round the reader, so a match on another
    // continent is never the one being asked for.
    countrycodes: 'ca,us',
    addressdetails: '1',
  });

  let upstream;
  try {
    upstream = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    // 503, never 502 — the edge replaces a 502 body with its own page and destroys the message.
    return json(503, { ok: false, error: `The place search could not be reached. ${error.message}` });
  }
  if (!upstream.ok) return json(503, { ok: false, error: `The place search answered ${upstream.status}.` });

  const rows = await upstream.json().catch(() => null);
  const places = (Array.isArray(rows) ? rows : []).slice(0, 6).map((row) => {
    const address = row.address ?? {};
    // The object's own name is the COMMUNITY when it differs from the administrative town —
    // see the longer note on the same rule in tools/serve.mjs.
    const own = String(row.name ?? '').trim();
    const town = String(address.city ?? address.town ?? address.village ?? '').trim() || own;
    const area =
      String(address.suburb ?? address.neighbourhood ?? '').trim() || (own !== '' && own !== town ? own : '');
    return {
      label: String(row.display_name ?? town).split(',').slice(0, 3).join(',').trim(),
      name: town,
      area,
      region: String(address.state ?? '').trim(),
      lat: Number(row.lat),
      lon: Number(row.lon),
    };
  });

  return new Response(
    JSON.stringify({
      ok: true,
      query,
      places,
      note: 'Pick one, and the airports below are ordered by distance from it.',
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // A place name does not move, and the cache also keeps the free service at one request
        // per place rather than one per reader.
        'cache-control': 'public, max-age=300',
        'x-proxied-from': 'nominatim.openstreetmap.org',
      },
    }
  );
}

/**
 * 🔴 A COORDINATE, TURNED INTO THE NAME OF THE PLACE IT FALLS IN.
 *
 * "Find me" used to print the words "your position" under the numbers the browser gave it,
 * which names nothing. George, 20 Sep 2026: *"when i clicked find me, it says your
 * position"*. Photon is used because it is free, needs no key, and was the only service
 * measured that ever named a real neighbourhood — see the longer note in tools/serve.mjs,
 * which carries the five measurements behind that choice.
 *
 * It answers the same shape as the place search: `town` for the label, `areas` empty on
 * purpose, because a street named `district` must never arrive where a community is
 * expected.
 */
async function serveReverse(rawLat, rawLon) {
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json(400, { ok: false, error: 'That is not a latitude and longitude.' });
  }

  let upstream;
  try {
    upstream = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&limit=1`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    // 503, never 502 — the edge replaces a 502 body with its own page and destroys the message.
    return json(503, { ok: false, error: `The place lookup could not be reached. ${error.message}` });
  }
  if (!upstream.ok) return json(503, { ok: false, error: `The place lookup answered ${upstream.status}.` });

  const body = await upstream.json().catch(() => null);
  const hit = body && Array.isArray(body.features) ? body.features[0] : null;
  const properties = (hit && hit.properties) || {};
  const town = String(properties.city ?? properties.town ?? properties.village ?? '').trim();
  if (town === '') return json(404, { ok: false, error: 'That position could not be named.' });

  return new Response(
    JSON.stringify({
      ok: true,
      place: town,
      town,
      region: String(properties.state ?? '').trim(),
      areas: [],
      district: String(properties.district ?? properties.suburb ?? '').trim(),
      lat,
      lon,
      note:
        'A coordinate names the town it falls in. The community name inside a town is not in the free map data — ' +
        'searching for the community by name is what names it.',
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // A coordinate names the same town forever, so this one is worth keeping.
        'cache-control': 'public, max-age=86400',
        'x-proxied-from': 'photon.komoot.io',
      },
    }
  );
}

/** Only these shapes are proxied. Everything else is refused before any fetch. */
const ALLOWED = [
  /^\/v2\/point\/-?\d+(\.\d+)?\/-?\d+(\.\d+)?\/\d{1,3}$/,
  /^\/v2\/hex\/[0-9a-f]{6}$/i,
  /^\/v2\/callsign\/[A-Z0-9]{1,8}$/i,
  /^\/v2\/reg(istration)?\/[A-Z0-9-]{2,10}$/i,
  /^\/v2\/(mil|ladd|pia)$/,
  /^\/0\/airport\/[A-Z0-9]{4}$/i,
];

function isAllowed(path) {
  return ALLOWED.some((pattern) => pattern.test(path));
}

/**
 * 🔴 THE FEED'S OWN PATHS ARE INCONSISTENT, AND THAT IS NOT OURS TO FIX.
 *
 *   /v2/point/…        the aircraft endpoints — no /api prefix upstream
 *   /api/0/airport/…   the airport endpoint — it carries its OWN /api
 *
 * The page calls `/api/v2/…` and `/api/0/…` on its own origin; the upstream path
 * is what follows, except that the `/0/` group needs the feed's `/api` put back.
 * Getting this wrong is quiet — the aircraft endpoints keep working while the
 * airport lookup answers `{"detail":"Not Found"}` — which is exactly what this
 * Worker and tools/serve.mjs both did until it was caught by running the local
 * proxy against the real feed rather than assuming it worked.
 */
function upstreamPath(url) {
  const rest = url.pathname.replace(/^\/api/, '');
  return (rest.startsWith('/0/') ? `/api${rest}` : rest) + (url.search || '');
}

/** Only the shapes the page uses, and only within its zoom range. */
function tilePath(path) {
  const match = /^\/tiles\/(\d{1,2})\/(\d+)\/(\d+)\.png$/.exec(path);
  if (!match) return null;
  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const span = 2 ** z;
  if (!Number.isInteger(z) || z < 3 || z > 16) return null;
  if (!Number.isInteger(x) || x < 0 || x >= span) return null;
  if (!Number.isInteger(y) || y < 0 || y >= span) return null;
  return { z, x, y };
}

async function serveTile(path) {
  const tile = tilePath(path);
  if (!tile) return json(404, { ok: false, error: 'Not a tile this proxy serves.' });
  const target = `${TILES}/${tile.z}/${tile.x}/${tile.y}.png`;
  try {
    const upstream = await fetch(target, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
    if (!upstream.ok) throw new Error(`the tile server answered ${upstream.status}`);
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'image/png',
        'cache-control': 'public, max-age=2592000, immutable',
        'cdn-cache-control': 'max-age=2592000',
        'x-proxied-from': 'openstreetmap.org',
      },
    });
  } catch (error) {
    // 503, never 502 — see the note at the top of this file.
    return json(503, { ok: false, error: `A map tile could not be fetched. ${error.message}` });
  }
}

/**
 * The proxy itself — every route, every cache, every refusal written below.
 *
 * It is an ordinary object rather than the module's default export so that the
 * guard underneath can wrap it without a line of the proxy changing, which is
 * both a smaller diff and an honest statement of what happened here: the proxy
 * was not touched, a boundary was added around it.
 */
/*
 * 🔴 THE PAGE'S OWN FAULTS ARRIVE HERE, AND THIS IS THE ONLY ROUTE THAT TAKES A
 * POST. It is answered before the GET-only check below because it is the one path
 * that is not a proxy at all: the page reports a fault to its own origin and this
 * Worker relays it, which is what keeps every credential out of the published
 * repository and keeps the reader's browser from calling a monitoring service
 * directly. See `worker/rollbar.js` for what may be kept and what is thrown away.
 *
 * It is deliberately NOT behind the cookie gate — a fault on a reader's machine is
 * otherwise invisible for ever — so it is declared as Required in the panel
 * instead of being offered as a choice, and the page's copy says so.
 */
async function serveFault(request, env, ctx) {
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'A fault report is a POST.' });
  }

  // Cheap hygiene, not security. A browser always sends Origin on a POST, so a
  // page on somebody else's site cannot use this endpoint from a reader's browser.
  // A client that is not a browser can put anything in the header, which is
  // exactly why the defence is the allow-list in rollbar.js and not this line.
  const origin = request.headers.get('origin');
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      host = '';
    }
    if (host !== new URL(request.url).host) {
      return json(403, { ok: false, error: 'Fault reports are accepted from this site only.' });
    }
  }

  const body = await request.text().catch(() => '');
  if (body.length > 8_000) {
    return json(413, { ok: false, error: 'That fault report is larger than this endpoint accepts.' });
  }

  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    return json(400, { ok: false, error: 'A fault report is JSON.' });
  }

  const url = new URL(request.url);
  reportBrowserFault(env, ctx, raw, {
    origin: url.origin,
    colo: request.cf && request.cf.colo,
    ray: request.headers.get('cf-ray'),
  });

  // 204 whatever the outcome, because the reader's page has nothing to do with
  // the answer — it has already moved on. A refused or undeliverable report is
  // visible in the Worker's own logs, not in the visitor's browser.
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

const proxy = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');

    if (path === '/fault') {
      return serveFault(request, env, ctx);
    }

    if (request.method !== 'GET') {
      return json(405, { ok: false, error: 'Only GET is proxied.' });
    }

    // The photo lookup is a different upstream with a different answer shape,
    // so it is handled before the path allow-list — which would otherwise refuse
    // it, correctly, because it is not a feed path.
    if (path.startsWith('/photo')) {
      return servePhoto(url.searchParams.get('src'));
    }

    // 🔴 THE EGRESS DIAGNOSTIC WAS HERE AND IS DELETED (23 Sep 2026, the session that added it). It asked
    // eight endpoints from inside this Worker and printed a status for each — a body only when the status
    // was not 200 — and what it proved is written in the note at the top of this file and in the project
    // record, where it is useful, rather than left as a public path on a live Worker.

    // 🔴 THE EGRESS PROBE WAS HERE AND IS DELETED (23 Sep 2026, the same session that added it). It asked
    // three feeds the same question at the same moment and returned statuses only, and it answered the
    // question it was built for: **from a Cloudflare Worker, adsb.lol answers 429 and airplanes.live and
    // adsb.fi answer 403 — every one of them refuses this egress.** The probe had no business staying: it
    // was a public path on a live Worker that spent other people's allowance, and the finding it produced
    // lives in the note at the top of this file where it is needed.

    if (path.startsWith('/tiles/')) {
      return serveTile(path);
    }

    if (path.startsWith('/geo/reverse')) {
      return serveReverse(url.searchParams.get('lat'), url.searchParams.get('lon'));
    }
    if (path.startsWith('/geo/search')) {
      return servePlaceSearch(url.searchParams.get('q'));
    }
    if (path.startsWith('/route/')) {
      return serveRoute(path.slice('/route/'.length));
    }

    if (!isAllowed(path)) {
      return json(400, {
        ok: false,
        error:
          'That path is not one this proxy passes on. It forwards the aircraft and airport lookups the page uses, and nothing else.',
      });
    }

    const target = UPSTREAM + upstreamPath(url);
    const now = Date.now();
    const cacheKey = new Request(target, { method: 'GET' });
    const cached = feedCache.get(target);

    // 1 · THE EDGE CACHE FIRST, WHICH IS WHAT ACTUALLY SHARES ONE CALL BETWEEN READERS. A visitor's
    // poll is answered from this data centre's cache for `CACHE_SECONDS` whichever isolate runs it,
    // and the age of the reading travels with it so the page can date what it shows.
    const edge = await edgeMatch(cacheKey);
    if (edge) {
      const storedAt = Number(edge.headers.get('x-stored-at') || '0');
      return new Response(edge.body, {
        status: 200,
        headers: {
          'content-type': edge.headers.get('content-type') || 'application/json; charset=utf-8',
          'cache-control': `public, max-age=${CACHE_SECONDS}`,
          'x-proxied-from': 'adsb.lol',
          'x-feed-cache': 'edge',
          'x-feed-age-ms': String(storedAt > 0 ? Math.max(0, now - storedAt) : 0),
        },
      });
    }

    if (cached && now - cached.at < FEED_CACHE_MS) {
      return feedReading(cached, now, 'fresh');
    }

    // 2 · A REFUSAL BUYS QUIET. While the cooldown runs this proxy does not call the feed at all, and
    // the reader is served the last reading we have — or, with none, one short honest sentence.
    if (now < cooldownUntil) {
      return refusal(cached, now, refusedWith || 429);
    }

    // 🔴 A PROXY THAT CANNOT ASK SAYS SO, AND NEVER LOOKS LIKE A FEED PROBLEM. The droplet's Caddy refuses
    // `/feed/*` without this token, so a missing secret would otherwise reach the reader as "the feed is
    // refusing us" — the least debuggable shape this page has, and the one thing worse than being down.
    if (!env?.FEED_TOKEN) {
      return json(503, {
        ok: false,
        error:
          'This proxy is not configured, so the feed cannot be reached: the feed token is missing from its environment.',
      });
    }

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          // The token the droplet's Caddy requires, so /feed/* is not an open relay through its address.
          'x-airplane-watch-feed': env.FEED_TOKEN,
        },
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      // 503, never 502 — see the note at the top.
      return json(503, {
        ok: false,
        error: `The feed could not be reached from here. ${error.message}`,
      });
    }

    const text = await upstream.text();
    const type = upstream.headers.get('content-type') || 'application/json; charset=utf-8';

    if (upstream.ok) {
      // A GOOD ANSWER ENDS THE COOLDOWN OUTRIGHT — the allowance is back, so there is nothing left to
      // stay quiet about, and the next refusal starts its back-off from the bottom again.
      cooldownMs = COOLDOWN_START_MS;
      cooldownUntil = 0;
      refusedWith = 0;
      rememberFeed(target, { at: now, body: text, type });
      if (ctx) {
        // Stored with the moment it was taken, so a reader served from the cache is told how old it is
        // rather than being shown it as live.
        ctx.waitUntil(
          edgePut(
            cacheKey,
            new Response(text, {
              headers: {
                'content-type': type,
                'cache-control': `public, max-age=${CACHE_SECONDS}`,
                'x-stored-at': String(now),
              },
            }),
          ),
        );
      }
      // Pass 200 through with the reading, so the page can say when it was taken.
      return feedReading({ at: now, body: text, type }, now, 'miss');
    }

    // 🔴 REFUSED — SO GO QUIET, THEN SERVE THE LAST THING WE HEARD AND SAY HOW OLD IT IS. The upstream
    // status travels in `x-feed-status` rather than as the status whenever there is a reading to serve,
    // so the page keeps its data, can still back off, and can date what it is showing.
    refusedWith = upstream.status;
    if (upstream.status === 429 || upstream.status >= 500) {
      const named = parseRetryAfter(upstream.headers.get('retry-after'));
      cooldownMs = Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_START_MS, cooldownMs * 2));
      cooldownUntil = now + (named ?? cooldownMs);
    }
    return refusal(cached, now, upstream.status);
  },
};

/**
 * 🔴 THE GUARD — EVERY UNEXPECTED ERROR ENDS HERE, AND IT ENDS AS A 503.
 *
 * Measured 23 Sep 2026: the proxy had no boundary at all, so an exception thrown
 * anywhere inside it — a route handler, the cache bookkeeping, a promise nobody
 * awaited — left the Worker entirely. Cloudflare then answers with its own error
 * page instead of this site's JSON, the page reports a parse error rather than a
 * message, and nothing anywhere records that it happened. That is the shape of
 * fault this site is least able to see, and the only one it cannot now have.
 *
 * THREE THINGS, IN THIS ORDER, AND THE ORDER MATTERS:
 *
 *   1. `reportFailure` is called BEFORE the response is built, and it schedules
 *      the report with `ctx.waitUntil`, so the Rollbar POST is kept alive after
 *      the visitor has their answer. It is never awaited, because a report is
 *      worth less than the answer it would delay.
 *   2. The visitor gets a 503 carrying this site's own JSON, so the page can say
 *      something true instead of surfacing a parse error.
 *   3. **NEVER 502.** House part 8: behind Cloudflare an origin's 502 has its body
 *      REPLACED by the edge's own HTML error page, which destroys the explanation
 *      written for the reader. 503 is passed through untouched, which is why every
 *      failure in this file is a 503 — including this one.
 *
 * What is NOT put in the response, deliberately: nothing about the error itself.
 * The message may name a file, an upstream or a token's absence, and none of that
 * belongs in an answer to a stranger. It goes to Rollbar, where it is useful.
 */
export default {
  async fetch(request, env, ctx) {
    try {
      return await proxy.fetch(request, env, ctx);
    } catch (error) {
      reportFailure(env, ctx, error, request);
      return json(503, {
        ok: false,
        error: 'This proxy hit an unexpected error answering that request.',
      });
    }
  },
};

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}
