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
const CACHE_SECONDS = 5;

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

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');

    if (request.method !== 'GET') {
      return json(405, { ok: false, error: 'Only GET is proxied.' });
    }
    if (!isAllowed(path)) {
      return json(400, {
        ok: false,
        error:
          'That path is not one this proxy passes on. It forwards the aircraft and airport lookups the page uses, and nothing else.',
      });
    }

    const target = UPSTREAM + upstreamPath(url);
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

    // Pass the feed's own status through unchanged, so the page can say what
    // actually happened rather than what this proxy guessed.
    return new Response(text, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        // A shared cache in front of a dozen readers polling every ten seconds is
        // the whole reason a volunteer-funded feed stays usable.
        'cache-control': `public, max-age=${CACHE_SECONDS}`,
        'cdn-cache-control': `max-age=${CACHE_SECONDS}`,
        'x-proxied-from': 'adsb.lol',
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
