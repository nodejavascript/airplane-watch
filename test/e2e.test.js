/**
 * e2e.test.js — behaviour, in a real Chrome, against a real build.
 *
 * House standard part 6: the unit suite proves the shape, this one proves what
 * happens. Three things are only visible here — that a refusal makes ZERO
 * requests to Google (not "few", not "none of the ones we thought of"), that the
 * footer door actually opens the panel, and that a ground-to-air transition puts
 * a line on the board.
 *
 * 🔴 THE FEED IS STUBBED, AND THAT IS DELIBERATE. These tests must be runnable
 * offline and must not depend on whether an aircraft happens to be climbing over
 * Hamilton at the moment they run. So every `/api/**` request is intercepted in
 * the browser and answered from a scripted sequence — which also makes the
 * ground-to-air transition reproducible, and a transition is the one thing a live
 * feed cannot be asked to produce on demand.
 *
 * Gotchas this file already accounts for, each of which cost time in this family:
 *   - `waitForFunction(fn, {timeout})` treats the second argument as `arg`;
 *     the timeout is the THIRD. Written `fn, null, {timeout}`.
 *   - `page.click` can hang on "not stable"; `$eval(el => el.click())` does not.
 *   - `route.abort()` on a request logs a console error, which pollutes the very
 *     thing these tests assert. `route.fulfill({status: 204})` records the
 *     request without the noise.
 *   - an overflow measurement in a browser with no viewport reports the whole
 *     document as overflowing, because `clientWidth` is 0. Refuse to measure.
 *   - Chrome is used through `channel: 'chrome'`, so no browser is downloaded.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}/`;

let server;
let browser;

/** Every request the browser made that goes to Google. The promise is "none". */
function watchGoogle(page) {
  const hits = [];
  page.on('request', (request) => {
    if (/google|gstatic|googleapis/i.test(request.url())) hits.push(request.url());
  });
  return hits;
}

/** The airport lookup, and a scripted set of polls. */
function feedStub(aircraftByPoll) {
  let poll = 0;
  return async (route) => {
    const url = route.request().url();
    if (url.includes('/api/0/airport/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          icao: 'CYHM',
          iata: 'YHM',
          name: 'John C. Munro Hamilton International Airport',
          location: 'Hamilton',
          countryiso2: 'CA',
          lat: 43.173599,
          lon: -79.934998,
          alt_feet: 780,
        }),
      });
    }
    const rows = aircraftByPoll[Math.min(poll, aircraftByPoll.length - 1)];
    poll += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ac: rows, total: rows.length, now: Date.now() / 1000 }),
    });
  };
}

before(async () => {
  server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  // Wait for the port rather than sleeping a guessed interval.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const response = await fetch(BASE);
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('the dev server never came up');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  browser = await chromium.launch({ channel: 'chrome' });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

async function openPage(aircraftByPoll) {
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const page = await context.newPage();
  await page.route('**/api/**', feedStub(aircraftByPoll || [[]]));
  await page.route('**googletagmanager**', (route) => route.fulfill({ status: 204, body: '' }));
  return { context, page };
}

/* ------------------------------------------------------------------- shell --- */

test('the shell is served no-store, so a deploy is visible', async () => {
  const response = await fetch(BASE);
  assert.equal(response.status, 200);
  // Without this a returning visitor reads their own cache, and a correct deploy
  // is indistinguishable from no deploy at all.
  assert.match(response.headers.get('cache-control') || '', /no-store/);
});

test('no URL ending in .html is served as a page', async () => {
  const response = await fetch(`${BASE}index.html`, { redirect: 'manual' });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), '/');
});

test('robots.txt and the sitemap answer, and the sitemap lists one URL', async () => {
  const robots = await fetch(`${BASE}robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Sitemap: https:\/\/aircraft-demo\.nodejavascript\.com\/sitemap\.xml/);

  const sitemap = await fetch(`${BASE}sitemap.xml`);
  assert.equal(sitemap.status, 200);
  const locs = (await sitemap.text()).match(/<loc>/g) || [];
  assert.equal(locs.length, 1);
});

/* ------------------------------------------------------------ the cookie gate --- */

test('BEFORE answering: nothing is loaded, and a refusal makes ZERO requests to Google', async () => {
  const { context, page } = await openPage();
  const google = watchGoogle(page);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#consentBar:not([hidden])');

  // The claim is "no request at all", not "no cookie". So both are asserted, and
  // the request count is asserted at the moment before an answer.
  assert.equal(google.length, 0, `requests to Google before an answer: ${google.join(', ')}`);
  const gtagBefore = await page.evaluate(() => typeof window.gtag);
  assert.equal(gtagBefore, 'undefined', 'window.gtag exists before the visitor answered');

  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#consentBar[hidden]');
  await page.waitForTimeout(400);

  assert.equal(google.length, 0, `a refusal still made ${google.length} request(s) to Google`);
  assert.equal(await page.evaluate(() => typeof window.gtag), 'undefined');
  assert.equal(await page.evaluate(() => window.localStorage.getItem('analytics_consent')), 'denied');

  await context.close();
});

test('a refusal is real: the bar does not come back on the next visit', async () => {
  const { context, page } = await openPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#consentBar:not([hidden])');
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#consentBar[hidden]');

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(300);

  const hidden = await page.$eval('#consentBar', (element) => element.hidden);
  assert.equal(hidden, true, 'the bar nagged the visitor who already said no');

  await context.close();
});

test('AFTER a yes: the tag loads and the page can send events', async () => {
  const { context, page } = await openPage();
  const google = watchGoogle(page);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#consentBar:not([hidden])');
  assert.equal(google.length, 0);

  await page.$eval('#consentAccept', (element) => element.click());
  await page.waitForFunction(() => typeof window.gtag === 'function', null, { timeout: 5000 });

  assert.ok(google.length > 0, 'nothing was requested from Google after a yes');
  assert.ok(google.some((url) => url.includes('googletagmanager')), 'the tag itself did not load');
  assert.equal(await page.evaluate(() => typeof window.aircraftTrack), 'function');

  await context.close();
});

test('the footer door is DELEGATED — it opens the panel, and leaves the answer alone', async () => {
  const { context, page } = await openPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#consentBar:not([hidden])');
  await page.$eval('#consentAccept', (element) => element.click());
  await page.waitForSelector('#consentBar[hidden]');

  await page.$eval('#consentBtn', (element) => element.click());
  const panelShown = await page.$eval('#consentPrefs', (element) => !element.hidden);
  assert.equal(panelShown, true, 'the footer door did nothing');

  // Opening settings must not un-consent the visitor, and must not re-ask the
  // question — something called settings that repeats the question is not a
  // settings control.
  const answer = await page.evaluate(() => window.localStorage.getItem('analytics_consent'));
  assert.equal(answer, 'granted');
  const askHidden = await page.$eval('#consentAsk', (element) => element.hidden);
  assert.equal(askHidden, true);

  const panel = await page.$eval('#consentPrefs', (element) => element.innerHTML);
  assert.equal(/This device|count my visits/i.test(panel), false, 'the banned owner switch is in the panel');

  await context.close();
});

/* ---------------------------------------------------------------- the demo --- */

test('the page names the airport it looked up, and lists what the feed can see', async () => {
  const { context, page } = await openPage([
    [
      { hex: 'c011e4', flight: 'ACA123', t: 'B738', alt_baro: 3200, baro_rate: 1800, lat: 43.19, lon: -79.93 },
      { hex: 'a8246d', flight: 'BBA535', t: 'B738', alt_baro: 'ground', gs: 0, lat: 43.18, lon: -79.94 },
    ],
  ]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());

  await page.waitForFunction(
    () => /John C\. Munro Hamilton/.test(document.getElementById('airportTitle').textContent),
    null,
    { timeout: 10_000 }
  );

  // The position is fetched, never typed into the page — so the coordinates on
  // screen prove the lookup happened rather than a constant being echoed.
  const where = await page.$eval('#airportWhere', (element) => element.textContent);
  assert.match(where, /43\.1736, -79\.9350/);

  const body = await page.$eval('#aircraftBody', (element) => element.textContent);
  assert.match(body, /ACA123/);
  assert.match(body, /BBA535/);
  // The two phases must be told apart, because telling them apart is the feature.
  assert.match(body, /airborne/);
  assert.match(body, /on the ground/);

  await context.close();
});

test('a ground-to-air transition puts a CONFIRMED departure on the board', async () => {
  const { context, page } = await openPage([
    [{ hex: 'c011e4', flight: 'ACA123', t: 'B738', alt_baro: 'ground', gs: 0, lat: 43.18, lon: -79.94 }],
    [{ hex: 'c011e4', flight: 'ACA123', t: 'B738', alt_baro: 1400, baro_rate: 2300, lat: 43.19, lon: -79.93 }],
  ]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());

  await page.waitForFunction(
    () => document.querySelectorAll('#departures .departure').length > 0,
    null,
    { timeout: 30_000 }
  );

  const rows = await page.$$eval('#departures .departure', (items) =>
    items.map((item) => item.textContent.replace(/\s+/g, ' ').trim())
  );
  assert.equal(rows.length, 1, `expected one departure, got ${rows.length}: ${rows.join(' | ')}`);
  assert.match(rows[0], /ACA123/);
  assert.match(rows[0], /seen on the ground first/, 'a ground-to-air transition must never be reported as a guess');
  assert.match(rows[0], /1400 ft/);
  assert.match(rows[0], /2300 ft\/min/);

  const emptyHidden = await page.$eval('#departuresEmpty', (element) => element.hidden);
  assert.equal(emptyHidden, true, 'the empty message is still showing over a populated board');

  await context.close();
});

test('a first sighting already climbing is labelled a guess, not a fact', async () => {
  const { context, page } = await openPage([
    [{ hex: 'a1b2c3', flight: 'WJA456', t: 'B737', alt_baro: 4100, baro_rate: 2100, lat: 43.20, lon: -79.92 }],
  ]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());

  await page.waitForFunction(
    () => document.querySelectorAll('#departures .departure').length > 0,
    null,
    { timeout: 30_000 }
  );

  const row = await page.$eval('#departures .departure', (element) => element.textContent);
  assert.match(row, /first seen climbing/);
  assert.match(row, /already climbing/);

  await context.close();
});

test('a watched aircraft is marked on the board, and the watchlist survives a reload', async () => {
  const polls = [
    [{ hex: 'c011e4', flight: 'ACA123', r: 'C-GXXX', t: 'B738', alt_baro: 'ground', gs: 0, lat: 43.18, lon: -79.94 }],
    [{ hex: 'c011e4', flight: 'ACA123', r: 'C-GXXX', t: 'B738', alt_baro: 1600, baro_rate: 2400, lat: 43.19, lon: -79.93 }],
  ];
  const { context, page } = await openPage(polls);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());

  // Typed without the hyphen, watched and matched anyway — registrations are
  // written with one and transmitted without one.
  await page.fill('#watchInput', 'cgxxx');
  await page.$eval('#watchForm button[type="submit"]', (element) => element.click());

  const watchlist = await page.$eval('#watchList', (element) => element.textContent);
  assert.match(watchlist, /cgxxx/);

  await page.waitForFunction(
    () => document.querySelectorAll('#departures .departure-watched').length > 0,
    null,
    { timeout: 30_000 }
  );

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(300);
  const afterReload = await page.$eval('#watchList', (element) => element.textContent);
  assert.match(afterReload, /cgxxx/, 'the watchlist did not survive a reload');
  const board = await page.$eval('#departures', (element) => element.textContent);
  assert.match(board, /ACA123/, 'the board did not survive a reload');

  await context.close();
});

test('the aircraft table offers a watch control, and it works without typing', async () => {
  const { context, page } = await openPage([
    [{ hex: 'c011e4', flight: 'ACA123', t: 'B738', alt_baro: 5000, lat: 43.19, lon: -79.93 }],
  ]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#aircraftBody .watch-toggle');

  await page.$eval('#aircraftBody .watch-toggle', (element) => element.click());
  await page.waitForTimeout(200);

  const watchlist = await page.$eval('#watchList', (element) => element.textContent);
  assert.match(watchlist, /ACA123/);

  await context.close();
});

test('the page does not scroll sideways at a phone width, or at a desktop one', async () => {
  for (const width of [360, 1180]) {
    const { context, page } = await openPage([
      [{ hex: 'c011e4', flight: 'ACA123', t: 'B738', alt_baro: 3200, baro_rate: 1800, lat: 43.19, lon: -79.93 }],
    ]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.$eval('#consentDecline', (element) => element.click());
    await page.waitForTimeout(500);

    const overflow = await page.evaluate(() => {
      // A browser with no viewport reports the whole document as overflowing,
      // because clientWidth is 0. Refuse to measure rather than report a bug
      // that is not there — this produced a phantom "233px overflow" twice.
      if (document.documentElement.clientWidth === 0) return null;
      return document.documentElement.scrollWidth - document.documentElement.clientWidth;
    });
    if (overflow !== null) {
      assert.ok(overflow <= 1, `at ${width}px the page scrolls sideways by ${overflow}px`);
    }
    await context.close();
  }
});

test('the abstract layer is painted, not merely declared', async () => {
  const { context, page } = await openPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());

  const painted = await page.evaluate(() => {
    const layer = document.querySelector('.dvs-pattern');
    if (!layer) return null;
    const style = getComputedStyle(layer);
    return {
      position: style.position,
      image: style.backgroundImage,
      mask: style.maskImage || style.webkitMaskImage,
      pointerEvents: style.pointerEvents,
      box: layer.getBoundingClientRect().width * layer.getBoundingClientRect().height,
    };
  });

  assert.ok(painted, 'there is no .dvs-pattern in the page');
  assert.equal(painted.position, 'fixed');
  assert.equal(painted.pointerEvents, 'none');
  assert.match(painted.image, /conic-gradient/, 'the drawing is not painted');
  assert.ok(painted.mask && painted.mask !== 'none', 'the drawing is not masked, so it has an edge');
  assert.ok(painted.box > 0, 'the layer has no area to paint into');

  await context.close();
});
