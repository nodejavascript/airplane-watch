/**
 * rollbar.js — the only place this Worker talks to Rollbar.
 *
 * 🔴 WHY THIS IS HAND-WRITTEN AND NOT THE ROLLBAR SDK. `rollbar` (npm) is a
 * Node/browser package: it reaches for `http`, `process`, `window` and a queueing
 * agent that this runtime does not have. A Worker has one reliable way to report —
 * `fetch` to `https://api.rollbar.com/api/1/item/` — and the payload it wants is
 * documented and small. So the whole notifier is the file you are reading, which
 * is also why it can be tested by stubbing one global.
 *
 * 🔴 THE REPORTER MUST NEVER BECOME THE INCIDENT. Every function here is written
 * so that it cannot throw, cannot hang, and cannot take the response down with it:
 * a missing token is a silent no-op, a refused or timed-out POST returns `false`,
 * and the caller schedules this file's work with `ctx.waitUntil` so the visitor's
 * answer is sent before we go and talk to Rollbar about it.
 *
 * 🔴 THE FRAMES ARE REVERSED, AND THAT IS NOT A STYLE CHOICE — read from Rollbar's
 * own create-item reference, 23 Sep 2026: `body.trace.frames` is *"a list of stack
 * frames, ordered such that the most recent call is last in the list"*. V8 prints a
 * stack with the most recent call FIRST, so the parsed lines are reversed here. Get
 * this wrong and the traceback reads upside down in the UI, which is worse than no
 * traceback because it looks deliberate.
 *
 * WHAT IS DELIBERATELY NOT SENT, and why it is a rule rather than an oversight:
 *
 *   - **No `person`, ever.** This site has no accounts, so there is nobody to
 *     identify, and inventing an id would be worse than sending none.
 *   - **No `user_ip`.** Rollbar will not attach one unless it is asked to, and it
 *     is not asked. The reader of a page about aircraft is not the subject of it.
 *   - **No query string.** `request.url` carries the origin and the path only. The
 *     query is where a visitor's own search lives — the tail number or the place
 *     name they are watching — and this is a public page, not a login. The route
 *     travels in `context` instead, which is the field Rollbar indexes for exactly
 *     that purpose.
 */

/** Where an item goes. One endpoint, documented at docs.rollbar.com/reference/create-item. */
const ENDPOINT = 'https://api.rollbar.com/api/1/item/';

/** A report is worth less than the answer it delays, so it gets a short leash. */
const TIMEOUT_MS = 5_000;

/** Longest stack we will keep in `custom` when the frames themselves do not parse. */
const RAW_STACK_LIMIT = 4_000;

/**
 * Turn a V8 stack string into Rollbar frames, ordered most-recent-call LAST.
 *
 * Handles the three shapes V8 prints:
 *   `    at handleRequest (worker/index.js:120:9)`   — named function
 *   `    at async Object.fetch (worker/index.js:60:12)`
 *   `    at worker/index.js:120:9`                    — anonymous frame
 * Anything else in the stack — the `Error: message` first line, blank lines — is
 * skipped. A frame that cannot be parsed is dropped rather than guessed at.
 */
export function framesFromStack(stack) {
  if (typeof stack !== 'string' || stack.length === 0) return [];

  const frames = [];
  for (const line of stack.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue;

    let rest = trimmed.slice(3).trim();
    if (rest.startsWith('async ')) rest = rest.slice(6).trim();

    // `fn (file:line:col)` when the frame is named, `file:line:col` when it is not.
    let method = '';
    let location = rest;
    const open = rest.lastIndexOf(' (');
    if (open !== -1 && rest.endsWith(')')) {
      method = rest.slice(0, open).trim();
      location = rest.slice(open + 2, -1);
    }

    // Split from the right: a filename may contain colons (a URL, a Windows path),
    // but the line and column are always the last two fields.
    const parts = location.split(':');
    if (parts.length < 3) continue;
    const colno = Number(parts.pop());
    const lineno = Number(parts.pop());
    const filename = parts.join(':');
    if (!Number.isFinite(lineno) || !Number.isFinite(colno)) continue;

    frames.push({ filename, lineno, colno, method });
  }

  // V8 lists the most recent call first; Rollbar wants it last.
  return frames.reverse();
}

/** A string that is safe to put in Rollbar's `custom` object. */
function asText(value) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, 255);
}

/**
 * Build the `data` object for one error.
 *
 * Exported so a test can assert the payload without a network call, and so the
 * shape lives in exactly one place.
 */
export function buildItem(error, context = {}, env = {}) {
  const isError = error instanceof Error;
  // A thrown string is not an Error and carries no stack, but it still needs a name
  // to group under — so the class says what it actually is rather than pretending
  // to be one. `Error: Non-error thrown: …` would read as a mistake.
  const name = isError ? error.name || 'Error' : 'Non-error thrown';
  const message = isError ? error.message || '(no message)' : String(error);
  const stack = isError ? error.stack : '';

  const frames = framesFromStack(stack);
  const body = frames.length
    ? { trace: { frames, exception: { class: name, message } } }
    : { message: { body: `${name}: ${message}` } };

  const host = 'airplane-watch-proxy';
  const version = env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id;

  const item = {
    // `production` and `development` need no configuration in the Rollbar UI; a
    // new name is detected automatically. Set ROLLBAR_ENVIRONMENT to override.
    environment: asText(env.ROLLBAR_ENVIRONMENT) || 'production',
    level: 'error',
    platform: 'node',
    language: 'javascript',
    framework: 'cloudflare-workers',
    timestamp: Math.floor(Date.now() / 1000),
    // The route, not the URL: Rollbar indexes `context` and this is what makes
    // "which path is failing" a question the item list can answer.
    context: asText(context.route),
    body,
    request: {
      url: asText(context.origin && context.route ? context.origin + context.route : ''),
      method: asText(context.method),
    },
    server: {
      host,
      branch: 'master',
      ...(version ? { code_version: asText(version) } : {}),
    },
    custom: {
      colo: asText(context.colo),
      ray: asText(context.ray),
      route: asText(context.route),
      // When the frames did not parse — a thrown string, a stripped stack — the
      // raw text is the only traceback there is, so it is kept as text.
      ...(frames.length ? {} : { stack: String(stack).slice(0, RAW_STACK_LIMIT) }),
    },
    notifier: { name: 'airplane-watch', version: '0.1.0' },
  };

  return item;
}

/**
 * 🔴 WHICH TOKEN, AND WHY THE TWO ARE NOT INTERCHANGEABLE — MEASURED 23 Sep 2026.
 *
 * Rollbar answers a browser item sent with the server token in so many words:
 *
 *   POST https://api.rollbar.com/api/1/item/   →  HTTP 403
 *   {"err":1,"message":"insufficient privileges: post_client_item scope is required
 *    but the access token only has post_server_item."}
 *
 * It is a rule about the ITEM, not about the caller: a `platform: 'browser'` item
 * needs a `post_client_item` token, and a server item needs `post_server_item`. The
 * relay exists so that no key sits in the page, so the client token is held HERE,
 * beside the server one. That is cheap, because a client token is public by design —
 * every Rollbar browser SDK ships one in its pages. What it must never be is MISSING,
 * because the failure has no symptom the visitor can see: the endpoint answers 204
 * either way, and a browser fault sent with the only token on hand is refused with a
 * 403 that nobody reads. **That is how this was found — a real fault POSTed to the
 * deployed endpoint, answered 204, and never appeared in the project.**
 */
function tokenFor(env, item) {
  const browser = item && item.platform === 'browser';
  return browser
    ? { name: 'ROLLBAR_PAGE_TOKEN', token: env && env.ROLLBAR_PAGE_TOKEN }
    : { name: 'ROLLBAR_SERVER_TOKEN', token: env && env.ROLLBAR_SERVER_TOKEN };
}

/**
 * Send one item, and the ONLY place in this Worker that talks to Rollbar.
 *
 * Two callers — the Worker's own faults and the faults the page sends up — so the
 * token choice, the timeout and the read-the-body rule live here once rather than
 * once per caller. A copy of this function would be a second place the 429 lesson
 * could be forgotten.
 *
 * It resolves `true` when Rollbar accepted the item and `false` for every other
 * outcome — no token, the wrong token, a network failure, a timeout, a refused
 * payload. It never rejects, so a caller may fire it into `ctx.waitUntil` without a
 * `.catch`, and it never logs the token.
 */
async function post(env, item) {
  const { name, token } = tokenFor(env, item);
  // Not configured is not an error the visitor should meet. A local `wrangler dev`
  // with no secret set must behave exactly as the site did before Rollbar existed —
  // but it IS said out loud here, because "no token" and "the wrong token" are
  // different faults and the second one is otherwise invisible.
  if (!token) {
    console.warn(`rollbar: nothing sent — ${name} is not set for a ${item && item.platform} item`);
    return false;
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rollbar-access-token': token,
      },
      body: JSON.stringify({ data: item }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      // 🔴 READ THE BODY, BECAUSE THE STATUS ALONE LIES HERE. Measured 23 Sep 2026: an
      // account that is not in a state to receive anything answers **429** — the same
      // code as a genuine rate limit — while its rate-limit headers read 49,998 of
      // 50,000 remaining, and the body says "This account has been deactivated. To
      // reactivate it, log in to Rollbar and choose a plan." A log line reading
      // "rejected with 429" sends the next reader hunting a rate limit that is not there.
      //
      // It stays a log line and nothing more: a report that cannot be delivered must
      // never change what the visitor receives.
      const detail = await response.text().catch(() => '');
      console.warn(
        `rollbar: item rejected (${response.status}) ${detail.replace(/\s+/g, ' ').slice(0, 200)}`
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Report one error the Worker itself caught. */
export async function report(env, error, context = {}) {
  return post(env, buildItem(error, context, env));
}

/**
 * Schedule a report against a request, and never let it delay the answer.
 *
 * `ctx.waitUntil` is what keeps the report alive after the response is returned.
 * Without it the runtime may cancel the fetch the moment the response goes out —
 * which is the quiet way an error reporter reports nothing at all.
 */
export function reportFailure(env, ctx, error, request) {
  // 🔴 NOTHING CONFIGURED IS NOT A PROMISE TO HOLD. Without a token `post` returns a
  // no-op, and handing that to `ctx.waitUntil` keeps the request alive for a request
  // that will never be made. Not configured has to mean exactly what it meant before
  // Rollbar existed: no fetch, and nothing scheduled.
  if (!(env && env.ROLLBAR_SERVER_TOKEN)) return;

  const url = new URL(request.url);
  const context = {
    route: url.pathname,
    origin: url.origin,
    method: request.method,
    colo: request.cf && request.cf.colo,
    ray: request.headers.get('cf-ray'),
  };

  const work = report(env, error, context);
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(work);
  } else {
    // No context to keep the promise alive: swallow the result rather than
    // leaving a rejection nobody is holding.
    work.catch(() => {});
  }
}

/* ------------------------------------------------------------------------- *
 * THE PAGE'S OWN FAULTS — what a browser sends up, and what is thrown away
 * ------------------------------------------------------------------------- */

/**
 * 🔴 THE ALLOW-LIST, AND WHY IT IS NOT A DENY-LIST.
 *
 * A deny-list would have to name everything a browser might send that must not
 * be kept — an account, a browser string, a viewport, a referrer, a visitor id,
 * an address — and the list is not knowable in advance. Anyone can POST here, so
 * the payload cannot be trusted at all, and the only shape that survives that is
 * one where **every field that is kept is named here** and everything else is
 * dropped before the item is built. Six fields are kept, and they are the six a
 * fault needs to be findable: where the reader was, what went wrong, the
 * traceback, and the script and position inside it.
 */
const FAULT_LIMITS = { route: 200, message: 300, stack: 4_000, source: 300 };

/** A URL reduced to its address: no query, no hash. */
function withoutQuery(token) {
  const cut = token.search(/[?#]/);
  return cut === -1 ? token : token.slice(0, cut);
}

/**
 * Redact every URL-shaped run in a line of text, then cap it.
 *
 * 🔴 THIS RUNS ON THE SERVER EVEN THOUGH THE PAGE ALREADY DID IT. The page's copy
 * of this rule stops a query string leaving the reader's machine; this one is
 * what makes the promise true if the page's copy is ever wrong, bypassed, or
 * replaced by a request from somewhere else. Redaction that only happens on the
 * client is a redaction the client can decline to perform.
 */
export function redactText(value, limit) {
  const text = typeof value === 'string' ? value : '';
  if (text === '') return '';
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)"']+/gi, withoutQuery)
    .replace(/(^|[\s("'=])(\/[^\s)"']*)/g, (_whole, lead, path) => lead + withoutQuery(path))
    // 🔴 HORIZONTAL WHITESPACE ONLY, BECAUSE THE NEWLINES *ARE* THE TRACEBACK.
    // This line collapsed `\s+` — every run of whitespace including newlines — and
    // that flattened a stack into one sentence, so `framesFromStack` found no frames
    // and every browser fault arrived with its traceback silently replaced by a single
    // unreadable line. The first run of this feature's own test caught it, which is
    // what the frames-order check is for. Long runs of blank lines are still tidied.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, limit);
}

/**
 * Turn whatever arrived into the six fields, or `null` when there is nothing
 * worth reporting.
 *
 * A fault with no message is not a fault — it is an empty POST, a probe, or a
 * mistake — so it is refused rather than stored as an item with a blank body
 * that would sit in the item list for ever looking like a real one.
 */
export function cleanBrowserFault(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const message = redactText(raw.message, FAULT_LIMITS.message);
  if (message === '') return null;

  const route = redactText(raw.route, FAULT_LIMITS.route);
  const whole = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };

  return {
    // The page path alone. A report with no path, or one that is not a path on
    // this site, is filed under `/` rather than under whatever was sent.
    route: route.startsWith('/') ? route : '/',
    message,
    stack: redactText(raw.stack, FAULT_LIMITS.stack),
    source: redactText(raw.source, FAULT_LIMITS.source),
    line: whole(raw.line),
    column: whole(raw.column),
  };
}

/**
 * The item for a fault the page reported.
 *
 * Same rules as the Worker's own items, and three that only apply here:
 *
 *   - `platform` is `browser`, so a fault on somebody's machine and a fault in
 *     this Worker are told apart in the item list without reading the body.
 *   - `request.url` is built from **the page path the reader was on**, never from
 *     this POST's own URL. The alternative — reporting `/api/fault` as the URL of
 *     every browser fault — would make the one field a reader looks at useless.
 *   - Nothing is taken from a request header. There is no user agent, no
 *     referrer and no address, and none is added later: `cf-ray` and the colo are
 *     infrastructure, not identity.
 *
 * `body.trace.frames` is ordered by `framesFromStack` above, and the order holds
 * here for the same reason it does there: a browser's stack prints the most
 * recent call first, exactly as V8 does on the server.
 */
export function buildBrowserItem(fault, env = {}, meta = {}) {
  const frames = framesFromStack(fault.stack);
  // The stack is the traceback when it parses. When it does not — a fault with no
  // Error behind it, a stripped stack — the script and the line are the only
  // location there is, and one frame stating it beats no traceback at all.
  if (frames.length === 0 && fault.source) {
    frames.push({ filename: fault.source, lineno: fault.line, colno: fault.column, method: '' });
  }

  const body = frames.length
    ? { trace: { frames, exception: { class: 'PageError', message: fault.message } } }
    : { message: { body: fault.message } };

  const version = env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id;

  return {
    environment: asText(env.ROLLBAR_ENVIRONMENT) || 'production',
    level: 'error',
    platform: 'browser',
    language: 'javascript',
    timestamp: Math.floor(Date.now() / 1000),
    context: asText(fault.route),
    body,
    request: {
      url: asText(meta.origin && fault.route ? meta.origin + fault.route : ''),
    },
    server: {
      host: 'airplane-watch',
      branch: 'master',
      ...(version ? { code_version: asText(version) } : {}),
    },
    custom: {
      // What separates the two reporters in the UI, so "is this the page or the
      // Worker" is a question the item list answers.
      reported_by: 'page',
      colo: asText(meta.colo),
      ray: asText(meta.ray),
      route: asText(fault.route),
      ...(frames.length ? {} : { stack: fault.stack }),
    },
    notifier: { name: 'airplane-watch-page', version: '0.1.0' },
  };
}

/**
 * Clean, build and send one fault the page reported.
 *
 * Returns the cleaned fault when it was accepted for reporting, or `null` when it
 * was refused before any request was made — which is what a test wants to see,
 * and what makes "nothing was sent" distinguishable from "something was sent and
 * failed". It still never throws: the page's report is scheduled against
 * `ctx.waitUntil`, so it outlives the 204 the reader gets back.
 */
export function reportBrowserFault(env, ctx, raw, meta = {}) {
  const fault = cleanBrowserFault(raw);
  if (!fault) return null;

  // 🔴 THE PAGE TOKEN, NOT THE SERVER TOKEN — see `tokenFor`. With the server token
  // this call is refused 403 and the fault is lost with no symptom, so an absent page
  // token means nothing is sent rather than something that cannot be delivered.
  if (!(env && env.ROLLBAR_PAGE_TOKEN)) return fault;

  const work = post(env, buildBrowserItem(fault, env, meta));
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(work);
  } else {
    work.catch(() => {});
  }
  return fault;
}
