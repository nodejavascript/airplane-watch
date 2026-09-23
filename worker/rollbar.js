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
 * Report one error. Resolves `true` when Rollbar accepted it, `false` for every
 * other outcome — no token, a network failure, a timeout, a refused payload.
 *
 * It never rejects, so a caller may fire it into `ctx.waitUntil` without a
 * `.catch`, and it never logs the token.
 */
export async function report(env, error, context = {}) {
  const token = env && env.ROLLBAR_SERVER_TOKEN;
  // Not configured is not an error. A local `wrangler dev` with no secret set
  // must behave exactly as the site did before Rollbar existed.
  if (!token) return false;

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rollbar-access-token': token,
      },
      body: JSON.stringify({ data: buildItem(error, context, env) }),
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

/**
 * Schedule a report against a request, and never let it delay the answer.
 *
 * `ctx.waitUntil` is what keeps the report alive after the response is returned.
 * Without it the runtime may cancel the fetch the moment the response goes out —
 * which is the quiet way an error reporter reports nothing at all.
 */
export function reportFailure(env, ctx, error, request) {
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
