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

async function serveApi(request, response) {
  const target = UPSTREAM + upstreamPath(request.url);
  try {
    const upstream = await fetch(target, {
      headers: { accept: 'application/json', 'user-agent': 'aircraft-demo (local development)' },
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
