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
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../site', import.meta.url)));
const PORT = Number(process.env.PORT || 4340);
const UPSTREAM = 'https://api.adsb.lol';
/** The feed is run on donations. A dozen visitors polling at once is enough. */
const CACHE_SECONDS = 5;

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
  try {
    const upstream = await fetch(target, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(12_000),
    });
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      // The header the feed does not send, and the only reason this proxy exists.
      'access-control-allow-origin': '*',
      'cache-control': `public, max-age=${CACHE_SECONDS}`,
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
      JSON.stringify({
        ok: false,
        error: `The feed could not be reached. ${error.message}`,
        upstream,
      })
    );
  }
}

const server = createServer((request, response) => {
  if ((request.url || '').startsWith('/api/')) {
    void serveApi(request, response);
    return;
  }
  void serveStatic(request, response);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`aircraft-demo → http://127.0.0.1:${PORT}/  (proxying /api to ${UPSTREAM})`);
});
