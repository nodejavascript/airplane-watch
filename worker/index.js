/**
 * worker/index.js — the production half of the proxy, for Cloudflare Workers.
 *
 * The page calls `/api/...` on its OWN origin. In development that is handled by
 * tools/serve.mjs. In production it is handled here, on a route bound to
 * `aircraft-demo.nodejavascript.com/api/*`.
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

const UPSTREAM = 'https://api.adsb.lol';
const CACHE_SECONDS = 25;

/**
 * 🔴 ONE REQUEST TO THE FEED PER WINDOW, PER ISOLATE.
 *
 * Measured 20 Sep 2026 against the live feed, with a named user agent: ten requests
 * three seconds apart, ten one second apart, and eight two seconds apart were ALL
 * refused with 429 from the third or fourth request onward. The `cache-control`
 * header below is what shares an answer between readers across the Cloudflare cache —
 * that is the real fix at the edge — and this map covers the case where the Worker is
 * invoked anyway. It is per isolate, so it is best-effort by nature, and the header
 * is not.
 */
const FEED_CACHE_MS = 25_000;
const FEED_STALE_MS = 15 * 60 * 1000;
const FEED_CACHE_MAX = 24;
const feedCache = new Map();

function rememberFeed(target, entry) {
  feedCache.set(target, entry);
  while (feedCache.size > FEED_CACHE_MAX) feedCache.delete(feedCache.keys().next().value);
}

/** The postal-code lookup. Free, no key, and it sends `access-control-allow-origin: *`. */
const GEO = 'https://api.zippopotam.us';

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
const USER_AGENT = 'aircraft-demo.nodejavascript.com';

/**
 * 🔴 A CANADIAN POSTAL CODE RESOLVES ON ITS FIRST THREE CHARACTERS. Measured 20
 * Sep 2026: `/ca/L8E` → 200 with the right place, `/ca/[redacted]` → 404 with `{}`,
 * `/us/14201` → 200. So a reader who types the whole six characters gets the
 * right answer, and is never told they typed it wrong.
 */
function postalTarget(raw) {
  const clean = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(clean)) return { country: 'ca', code: clean.slice(0, 3) };
  if (/^[A-Z]\d[A-Z]$/.test(clean)) return { country: 'ca', code: clean };
  if (/^\d{5}$/.test(clean)) return { country: 'us', code: clean };
  return null;
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
 * It answers the same shape as the postal lookup: `town` for the label, `areas` empty on
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
        'the postal code is what carries that, which is why typing one also offers the communities it covers.',
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

/**
 * The postal answer is normalised rather than passed through, so the page never
 * depends on the field names of a service that is free and owes us nothing.
 */
async function servePostal(raw) {
  const target = postalTarget(raw);
  if (!target) {
    return json(400, {
      ok: false,
      error:
        'That is not a Canadian postal code or a five-digit ZIP code. A Canadian one looks like [redacted] ' +
        '(and the first three characters are enough), and an American one is five digits.',
    });
  }
  let upstream;
  try {
    upstream = await fetch(`${GEO}/${target.country}/${target.code}`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    // 503, never 502 — see the note at the top of this file.
    return json(503, { ok: false, error: `The postal code lookup could not be reached. ${error.message}` });
  }
  if (upstream.status === 404) return json(404, { ok: false, error: `Nothing is listed for ${target.code}.` });
  if (!upstream.ok) return json(503, { ok: false, error: `The postal code lookup answered ${upstream.status}.` });

  const body = await upstream.json().catch(() => null);
  const place = body && Array.isArray(body.places) ? body.places[0] : null;
  if (!place) return json(404, { ok: false, error: `Nothing is listed for ${target.code}.` });

  return new Response(
    JSON.stringify({
      ok: true,
      lookedUp: target.code,
      country: body.country,
      region: place.state,
      place: String(place['place name'] ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim(),
      // 🔴 The Worker has to answer the same shape as tools/serve.mjs, or production and
      // development disagree about what the page receives — the same contract kept in two
      // places on purpose, and the one place a divergence shows up silently.
      town: String(place['place name'] ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim(),
      areas: (/\((.*)\)\s*$/.exec(String(place['place name'] ?? ''))?.[1] ?? '')
        .split('/')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
      lat: Number(place.latitude),
      lon: Number(place.longitude),
      note:
        'A postal code covers a whole delivery area, so this is the centre of an area and not a street address. ' +
        'Airports are then listed by distance from it.',
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=86400',
        'x-proxied-from': 'zippopotam.us',
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

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');

    if (request.method !== 'GET') {
      return json(405, { ok: false, error: 'Only GET is proxied.' });
    }

    // The postal lookup is a different upstream with a different answer shape,
    // so it is handled before the path allow-list — which would otherwise refuse
    // it, correctly, because it is not a feed path.
    if (path.startsWith('/photo')) {
      return servePhoto(url.searchParams.get('src'));
    }

    if (path.startsWith('/tiles/')) {
      return serveTile(path);
    }

    if (path.startsWith('/geo/postal/')) {
      return servePostal(decodeURIComponent(path.slice('/geo/postal/'.length)));
    }
    if (path.startsWith('/geo/reverse')) {
      return serveReverse(url.searchParams.get('lat'), url.searchParams.get('lon'));
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
    const cached = feedCache.get(target);

    if (cached && now - cached.at < FEED_CACHE_MS) {
      return new Response(cached.body, {
        status: 200,
        headers: {
          'content-type': cached.type,
          'cache-control': `public, max-age=${CACHE_SECONDS}`,
          'cdn-cache-control': `max-age=${CACHE_SECONDS}`,
          'x-proxied-from': 'adsb.lol',
          'x-feed-cache': 'fresh',
          'x-feed-age-ms': String(now - cached.at),
        },
      });
    }

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: { accept: 'application/json', 'user-agent': 'aircraft-demo.nodejavascript.com' },
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
      rememberFeed(target, { at: now, body: text, type });
      // Pass 200 through with the reading, so the page can say when it was taken.
      return new Response(text, {
        status: 200,
        headers: {
          'content-type': type,
          // A shared cache in front of a dozen readers polling every twenty seconds is
          // the whole reason a volunteer-funded feed stays usable.
          'cache-control': `public, max-age=${CACHE_SECONDS}`,
          'cdn-cache-control': `max-age=${CACHE_SECONDS}`,
          'x-proxied-from': 'adsb.lol',
          'x-feed-cache': 'miss',
          'x-feed-age-ms': '0',
        },
      });
    }

    // 🔴 REFUSED — SO SERVE THE LAST THING WE HEARD, AND SAY HOW OLD IT IS. The
    // upstream status travels in `x-feed-status` instead of as the status, so the
    // page keeps its data, can still back off, and can date what it is showing.
    if (cached && now - cached.at < FEED_STALE_MS) {
      return new Response(cached.body, {
        status: 200,
        headers: {
          'content-type': cached.type,
          'cache-control': 'no-store',
          'x-proxied-from': 'adsb.lol',
          'x-feed-cache': 'stale',
          'x-feed-age-ms': String(now - cached.at),
          'x-feed-status': String(upstream.status),
        },
      });
    }

    // Pass the feed's own status through unchanged, so the page can say what
    // actually happened rather than what this proxy guessed.
    return new Response(text, {
      status: upstream.status,
      headers: {
        'content-type': type,
        'cache-control': 'no-store',
        'x-proxied-from': 'adsb.lol',
        'x-feed-status': String(upstream.status),
      },
    });
  },
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
