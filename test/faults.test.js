/**
 * faults.test.js — the page's fault reporter, and the promises it had to keep.
 *
 * 🔴 WHAT THIS FILE IS FOR, IN ONE SENTENCE. On 23 Sep 2026 the owner asked for
 * the page to report its own breakage, and set the terms in the same breath:
 * *"consent panel promises the visitor this is a required cookie if that what it
 * is. its used to trap errors and should not collect pii."* So there are two
 * things to prove and neither is provable by reading: **that the reporter
 * collects nothing about the reader**, and **that the panel tells the truth about
 * what it is**.
 *
 * 🔴 THE FIRST IS PROVED BY RUNNING THE SHIPPED FILE WITH A TRAP ON EVERYTHING IT
 * MUST NOT TOUCH, not by scanning it for banned words. `localStorage`,
 * `sessionStorage` and `document.cookie` are defined here as ACCESS COUNTERS: the
 * page is free to touch them, and the test counts whether it did. A reading test
 * would pass on a file that reached storage through a helper; a counter cannot.
 * The reading checks are kept as well, but they are the second line, not the
 * first.
 *
 * 🔴 THE SECOND IS PROVED BY READING THE PAGE, because that is the only place a
 * promise about copy can be checked. And every one of those checks is written
 * against an anchor it REQUIRES to exist — following `test/static.test.js`, where
 * a check whose anchors had been renamed asserted nothing for weeks while looking
 * green. A missing anchor throws here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildBrowserItem,
  cleanBrowserFault,
  redactText,
  reportBrowserFault,
} from '../worker/rollbar.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SITE = join(ROOT, 'site');

const read = (...parts) => readFileSync(join(...parts), 'utf8');

/** Strip comments, so a comment cannot fail a check about code. */
function stripJs(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Strip HTML comments, for the same reason. */
function stripHtml(source) {
  return source.replace(/<!--[\s\S]*?-->/g, '');
}

/** The text between two anchors — and LOUD when either is missing. */
function between(source, from, to, what) {
  const a = source.indexOf(from);
  assert.notEqual(a, -1, `the anchor "${from}" is missing, so ${what} cannot be checked`);
  const b = source.indexOf(to, a + from.length);
  assert.ok(
    b !== -1 && b > a,
    `the anchor "${to}" is missing or out of order, so ${what} cannot be checked`
  );
  return source.slice(a, b);
}

/* ------------------------------------------------------------------ *
 * a stubbed browser, with a trap on everything the page must not touch
 * ------------------------------------------------------------------ */

let loads = 0;

/**
 * Run `site/faults.js` the way the page runs it — as a classic script, before
 * anything else — and hand back what it sent.
 */
async function loadPage(options = {}) {
  const beacon = options.beacon === undefined ? true : options.beacon;
  const sent = [];
  const listeners = new Map();
  const touched = { storage: 0, cookie: 0 };

  const document = {};
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get() {
      touched.cookie += 1;
      return '';
    },
    set() {
      touched.cookie += 1;
    },
  });

  const window = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    document,
  };

  // A getter that counts, rather than a value the page could use quietly.
  const countingStore = {
    configurable: true,
    get() {
      touched.storage += 1;
      return {
        getItem() {
          touched.storage += 1;
          return null;
        },
        setItem() {
          touched.storage += 1;
        },
        removeItem() {
          touched.storage += 1;
        },
        clear() {
          touched.storage += 1;
        },
      };
    },
  };

  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

  define('window', window);
  define('document', document);
  define('location', { pathname: '/', protocol: 'https:' });
  define('navigator', {
    sendBeacon(url, blob) {
      sent.push({ kind: 'beacon', url, blob });
      return beacon;
    },
  });
  define('fetch', async (url, init) => {
    sent.push({ kind: 'fetch', url, init });
    return { ok: true };
  });
  define('HTMLScriptElement', class HTMLScriptElement {});
  define('HTMLLinkElement', class HTMLLinkElement {});
  Object.defineProperty(globalThis, 'localStorage', countingStore);
  Object.defineProperty(globalThis, 'sessionStorage', countingStore);

  loads += 1;
  await import(`${pathToFileURL(join(SITE, 'faults.js')).href}?load=${loads}`);

  return { sent, touched, listeners, window };
}

/** Fire one event at the listeners the page registered. */
function fire(page, type, event) {
  for (const listener of page.listeners.get(type) || []) listener(event);
}

/** The JSON the page actually sent. */
async function payloadOf(entry) {
  if (entry.blob) return JSON.parse(await entry.blob.text());
  return JSON.parse(entry.init.body);
}

/** A realistic error event, with a real stack behind it. */
function errorEvent(message, stack, filename, lineno) {
  const error = new Error(message);
  if (stack) error.stack = stack;
  return { target: {}, message, error, filename, lineno, colno: 3 };
}

/* ------------------------------------------------------------------ *
 * part 1 · what the page sends
 * ------------------------------------------------------------------ */

test('the reporter sends exactly six fields, and no field about the reader', async () => {
  const page = await loadPage();
  fire(page, 'error', errorEvent('Uncaught TypeError: x is not a function', '', '/app.js', 12));

  assert.equal(page.sent.length, 1, 'one fault should have produced one report');
  assert.equal(page.sent[0].url, '/api/fault', 'the report must go to this site, not to a monitoring service');

  const payload = await payloadOf(page.sent[0]);
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['column', 'line', 'message', 'route', 'source', 'stack'],
    'the payload grew a field, and every field here is one the reader was promised'
  );
});

test('no query string survives, so a tail number or a place cannot ride along', async () => {
  const page = await loadPage();
  fire(
    page,
    'error',
    errorEvent(
      'boom /api/geo/reverse?lat=43.17&lon=-79.93',
      'Error: boom\n    at https://airplane-watch.nodejavascript.com/app.js?tail=C-FABC:12:3',
      '/app.js?v=7',
      12
    )
  );

  const payload = await payloadOf(page.sent[0]);
  const text = JSON.stringify(payload);
  assert.equal(text.includes('?'), false, 'a query string reached the report');
  assert.equal(text.includes('C-FABC'), false, 'a tail number reached the report');
  assert.equal(text.includes('43.17'), false, 'a position reached the report');
  assert.equal(payload.source, '/app.js', 'the script should be sent as a path on this site');
  assert.equal(payload.route, '/');
});

test('the same fault is sent once, and one page cannot flood the project', async () => {
  const page = await loadPage();

  for (let i = 0; i < 3; i += 1) {
    fire(page, 'error', errorEvent('the same fault', '', '/a.js', 5));
  }
  assert.equal(page.sent.length, 1, 'an identical fault was sent more than once');

  for (let i = 0; i < 12; i += 1) {
    fire(page, 'error', errorEvent(`distinct fault ${i}`, '', '/b.js', i + 1));
  }
  assert.equal(page.sent.length, 5, 'the per-page cap is not holding');
});

test('nothing was written to storage and no cookie was touched', async () => {
  const page = await loadPage();
  fire(page, 'error', errorEvent('boom', '', '/app.js', 1));
  fire(page, 'error', errorEvent('boom again', '', '/app.js', 2));

  assert.deepEqual(
    page.touched,
    { storage: 0, cookie: 0 },
    'the fault reporter read or wrote browser storage — which is where the watchlist lives'
  );
});

test('a script that never loaded is reported, because that is the silent breakage', async () => {
  const page = await loadPage();
  const script = Object.create(globalThis.HTMLScriptElement.prototype);
  script.src = 'https://airplane-watch.nodejavascript.com/app.js?v=9';

  fire(page, 'error', { target: script });

  const payload = await payloadOf(page.sent[0]);
  assert.equal(payload.message, 'A script on this page did not load.');
  assert.equal(payload.source, '/app.js', 'the script address should travel as a path, with no query');
});

test('a promise nobody caught is reported too', async () => {
  const page = await loadPage();
  fire(page, 'unhandledrejection', { reason: new Error('nothing caught this') });

  const payload = await payloadOf(page.sent[0]);
  assert.match(payload.message, /^Error: nothing caught this$/);
});

test('when the beacon is refused, the fetch takes over', async () => {
  const page = await loadPage({ beacon: false });
  fire(page, 'error', errorEvent('boom', '', '/app.js', 4));

  assert.equal(page.sent.length, 2, 'the beacon was tried and the fallback should follow it');
  assert.equal(page.sent[0].kind, 'beacon');
  assert.equal(page.sent[1].kind, 'fetch', 'the fallback did not run, so the report was lost');
  assert.equal(page.sent[1].init.method, 'POST');
  assert.equal(page.sent[1].init.keepalive, true);

  const payload = await payloadOf(page.sent[1]);
  assert.equal(payload.message, 'boom');
});

test('the shipped file contacts this site and nothing else, and reads nothing of the reader', () => {
  const js = stripJs(read(SITE, 'faults.js'));

  assert.equal(/https?:\/\//.test(js), false, 'the reporter names a second host');
  assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/.test(js), false);
  assert.equal(/location\.(search|href|hash)|document\.referrer/.test(js), false);
  assert.equal(
    /analytics_consent|ga_opt_out|consentBar|consentAnalytics/.test(js),
    false,
    'the required reporter is reading the optional choice, which would make it optional too'
  );
  assert.equal(/navigator\.userAgent|user_ip|person/.test(js), false);
});

/* ------------------------------------------------------------------ *
 * part 2 · what the Worker keeps, and what it throws away
 * ------------------------------------------------------------------ */

test('anything that is not a fault with a message is refused', () => {
  assert.equal(cleanBrowserFault(null), null);
  assert.equal(cleanBrowserFault(undefined), null);
  assert.equal(cleanBrowserFault('a string'), null);
  assert.equal(cleanBrowserFault([]), null);
  assert.equal(cleanBrowserFault({}), null);
  assert.equal(cleanBrowserFault({ message: '   ' }), null);
  assert.equal(cleanBrowserFault({ message: 42 }), null);
});

test('the allow-list drops every field it does not name, including the tempting ones', () => {
  const cleaned = cleanBrowserFault({
    message: 'boom',
    route: '/fence',
    person: { id: 7, email: 'someone@example.com' },
    user_ip: '203.0.113.9',
    userAgent: 'Mozilla/5.0',
    referrer: 'https://elsewhere.example/',
    session: 'abc123',
  });

  assert.deepEqual(Object.keys(cleaned).sort(), [
    'column',
    'line',
    'message',
    'route',
    'source',
    'stack',
  ]);
  const text = JSON.stringify(cleaned);
  assert.equal(text.includes('203.0.113.9'), false);
  assert.equal(text.includes('someone@example.com'), false);
  assert.equal(text.includes('Mozilla'), false);
  assert.equal(text.includes('abc123'), false);
});

test('redaction happens on the server, so a client that skips it cannot get round it', () => {
  const cleaned = cleanBrowserFault({
    message: 'GET /api/geo/reverse?lat=43.17&lon=-79.93 got a 500',
    stack: 'Error\n    at https://airplane-watch.nodejavascript.com/app.js?token=secret:1:2',
    route: '/?tail=C-FABC',
  });

  assert.equal(cleaned.message.includes('43.17'), false);
  assert.equal(cleaned.route.includes('C-FABC'), false);
  assert.equal(JSON.stringify(cleaned).includes('secret'), false);
  assert.equal(cleaned.route, '/');
});

test('redactText keeps the address and drops the query, on every shape of URL', () => {
  assert.equal(redactText('at /app.js?v=7', 100), 'at /app.js');
  assert.equal(redactText('at https://host/a/b.js?x=1#y', 100), 'at https://host/a/b.js');
  assert.equal(redactText('nothing to do here', 100), 'nothing to do here');
  assert.equal(redactText('a'.repeat(50), 10).length, 10);
  assert.equal(redactText(undefined, 10), '');
});

test('the item says it came from the page, and carries no person and no address', () => {
  const fault = cleanBrowserFault({
    message: 'boom',
    route: '/fence',
    stack: 'Error: boom\n    at outer (https://airplane-watch.nodejavascript.com/app.js:10:5)',
  });
  const item = buildBrowserItem(fault, {}, {
    origin: 'https://airplane-watch.nodejavascript.com',
    colo: 'YYZ',
    ray: 'abc123',
  });

  const text = JSON.stringify(item);
  assert.equal(text.includes('person'), false, 'an item must never claim to identify anybody');
  assert.equal(text.includes('user_ip'), false);
  assert.equal(text.includes('?'), false, 'a query string reached the item');
  assert.equal(item.platform, 'browser');
  assert.equal(item.custom.reported_by, 'page');
  assert.equal(item.context, '/fence');
  assert.equal(item.request.url, 'https://airplane-watch.nodejavascript.com/fence');
  assert.equal(item.custom.colo, 'YYZ');
});

test('the frames are ordered most-recent-call LAST, which is the order Rollbar reads', () => {
  const fault = cleanBrowserFault({
    message: 'boom',
    route: '/',
    stack: [
      'Error: boom',
      '    at inner (https://host/app.js:1:1)',
      '    at outer (https://host/app.js:2:2)',
    ].join('\n'),
  });
  const item = buildBrowserItem(fault);

  assert.deepEqual(
    item.body.trace.frames.map((frame) => frame.method),
    ['outer', 'inner'],
    'the traceback would read upside down in the UI'
  );
});

test('a fault with no parseable stack still records where it came from', () => {
  const fault = cleanBrowserFault({ message: 'boom', source: '/app.js', line: 9, column: 4 });
  const item = buildBrowserItem(fault);

  assert.deepEqual(item.body.trace.frames, [
    { filename: '/app.js', lineno: 9, colno: 4, method: '' },
  ]);
});

test('nothing is sent when the Worker has no token, and a fault is still recognised', () => {
  const calls = [];
  const waited = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  const ctx = { waitUntil: (work) => waited.push(work) };

  const accepted = reportBrowserFault({}, ctx, { message: 'boom' }, {});
  assert.ok(accepted, 'a fault was refused even though it was well formed');
  assert.equal(calls.length, 0, 'a request was made with no token configured');
  assert.equal(waited.length, 0);
});

test('a well formed fault is posted once, and scheduled so it outlives the 204', () => {
  const calls = [];
  const waited = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  const ctx = { waitUntil: (work) => waited.push(work) };
  const env = { ROLLBAR_SERVER_TOKEN: 'a-token' };

  const fault = reportBrowserFault(env, ctx, { message: 'boom', route: '/fence' }, {});
  assert.ok(fault);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.rollbar.com/api/1/item/');
  assert.equal(calls[0].init.headers['x-rollbar-access-token'], 'a-token');
  assert.equal(waited.length, 1, 'the report was not scheduled, so the runtime may cancel it');

  assert.equal(reportBrowserFault(env, ctx, { nothing: true }, {}), null);
  assert.equal(calls.length, 1, 'a report with no message was sent anyway');
});

/* ------------------------------------------------------------------ *
 * part 3 · whether the page tells the truth about it
 * ------------------------------------------------------------------ */

test('the reporter is in the page, and before everything else', () => {
  const html = stripHtml(read(SITE, 'index.html'));
  const reporter = html.indexOf('./faults.js');
  assert.notEqual(reporter, -1, 'the page does not load the fault reporter at all');
  assert.ok(reporter < html.indexOf('./consent.js'), 'it must install before the cookie gate');
  assert.ok(reporter < html.indexOf('./app.js'), 'it must install before the page it watches');
});

test('the panel declares the reporter as Required, and puts no switch on it', () => {
  const html = stripHtml(read(SITE, 'index.html'));
  const row = between(
    html,
    '<p class="consentRowName">Fault report</p>',
    '<li class="consentRow">',
    'the fault-report row of the panel'
  );

  assert.match(row, /class="consentAlways"/, 'the required row is not marked as required');
  assert.match(row, />\s*Required\s*</, 'the required row does not carry the word Required');
  assert.equal(
    /consentSwitch/.test(row),
    false,
    'the required row carries a switch, which would be a control that does nothing when pressed'
  );
});

test('the question says plainly that Reject all does not stop the required reporter', () => {
  const html = stripHtml(read(SITE, 'index.html'));
  const ask = between(html, 'id="consentAsk"', 'id="consentPrefs"', 'the consent question');

  assert.match(ask, /Reject all does not stop it<\/b>/);
  assert.match(ask, /no cookie, nothing stored/);
  assert.match(ask, /Analytics is the only cookie here/, 'the existing promise was lost');
});

test('the policy names the fault note, what is not in it, and where it goes', () => {
  const html = stripHtml(read(SITE, 'index.html'));
  const privacy = between(html, 'id="privacy"', 'id="consentBar"', 'the privacy section');

  assert.match(privacy, /last changed on 23 September 2026/);
  assert.match(privacy, /The only cookie is the analytics one/, 'the cookie promise was lost');
  assert.match(privacy, /not a cookie and not a choice/);
  assert.match(privacy, /never reads your watchlist/);
  assert.match(privacy, /rollbar\.com/, 'the policy does not name the service the fault note reaches');
  assert.match(privacy, /Four\s+things travel that way/, 'the list of what leaves is out of date');
});

test('the required tag is drawn as a label, not as something to press', () => {
  const css = read(SITE, 'styles.css');
  const rule = between(css, '.consentAlways {', '}', 'the required-tag rule');

  assert.match(rule, /text-transform:\s*uppercase/);
  assert.equal(
    /cursor/.test(rule),
    false,
    'the required tag invites a press that would do nothing — a fake choice'
  );
});

test('no error message in the page can carry an aircraft, airport or position', () => {
  // Comments are stripped first, and that is not tidiness: this file's own note
  // about the message it removed QUOTES the removed call, and reading it raw
  // reported the comment as the defect. That is the false failure the static
  // suite already learned to avoid, caught here on the first run.
  const src = stripJs(read(ROOT, 'src', 'app.ts'));

  const templates = src.match(/new Error\(\s*`[^`]*`/g) || [];
  assert.ok(templates.length > 0, 'no error templates were found, so this check is measuring nothing');

  const identifiers = /\$\{[^}]*\b(icao|tail|callsign|reg|hex|lat|lon|place|town|query|search)\b/;
  const carrying = templates.filter((text) => identifiers.test(text));
  assert.deepEqual(carrying, [], `an error message interpolates an identifier: ${carrying.join(' | ')}`);

  const fromLookup = src.match(/new Error\(\s*body\.[a-z]/g) || [];
  assert.deepEqual(
    fromLookup,
    [],
    `an error message is built from a lookup answer: ${fromLookup.join(' | ')}`
  );
});
