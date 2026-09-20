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

/* ------------------------------------------------- kilometres, not nm --- */

test('the reader is shown kilometres, and the feed is still asked in nautical miles', async () => {
  const { context, page } = await openPage([
    [{ hex: 'c011e4', flight: 'ACA123', t: 'B738', alt_baro: 5000, lat: 43.19, lon: -79.93 }],
  ]);
  const polled = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v2/point/')) polled.push(request.url());
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());

  // The buttons read in km, with words beside the number.
  const chips = await page.$$eval('#radiusButtons .chip', (items) =>
    items.map((item) => item.textContent.replace(/\s+/g, ' ').trim())
  );
  assert.ok(chips.length >= 3, `expected three distances, got ${chips.length}`);
  assert.match(chips[0], /km/);
  assert.match(chips[0], /Just the airport/i);

  // Nothing the reader can read says "nm".
  const visibleText = await page.evaluate(() => document.body.innerText);
  assert.equal(/\bnm\b/.test(visibleText), false, 'the page shows the reader "nm"');
  assert.match(visibleText, /20 km/);

  await page.waitForFunction(() => true, null, { timeout: 1000 });
  assert.ok(polled.length > 0, 'no poll reached the feed');
  // …but the FEED still gets nautical miles, because that is the unit it takes:
  // its own endpoint summary says "up to 250nm". Default 20 km is 11 nm.
  assert.match(polled[0], /\/11$/, `the poll did not ask in nautical miles: ${polled[0]}`);

  await context.close();
});

/* ------------------------------------------------------- watching a type --- */

test('a type can be watched whole, and then narrowed to tail numbers', async () => {
  const polls = [
    [{ hex: 'c011e4', flight: 'ACA123', r: 'C-GXXX', t: 'B38M', alt_baro: 'ground', gs: 0, lat: 43.18, lon: -79.94 }],
    [{ hex: 'c011e4', flight: 'ACA123', r: 'C-GXXX', t: 'B38M', alt_baro: 1700, baro_rate: 2300, lat: 43.19, lon: -79.93 }],
  ];
  const { context, page } = await openPage(polls);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());

  // The list arrives from the measured survey, and every row says what the code
  // means rather than only the code.
  await page.waitForSelector('#typeList .typerow');
  const listText = await page.$eval('#typeList', (element) => element.textContent);
  assert.match(listText, /Boeing 737 MAX 8/);
  assert.match(listText, /Cessna 172/);

  const rows = await page.$$eval('#typeList .typerow', (items) => items.length);
  assert.ok(rows >= 10, `only ${rows} types rendered`);

  // Filtering by kind is a real filter, not decoration.
  await page.$$eval('#typeFilter .chip', (items) => {
    const helicopters = items.find((item) => /Helicopter/.test(item.textContent));
    helicopters.click();
  });
  await page.waitForTimeout(150);
  const filtered = await page.$$eval('#typeList .typerow-main', (items) => items.map((item) => item.textContent));
  assert.ok(filtered.length > 0, 'the helicopter filter hid everything');
  assert.ok(
    filtered.every((text) => /Helicopter/.test(text)),
    `a non-helicopter survived the helicopter filter: ${filtered.find((t) => !/Helicopter/.test(t))}`
  );

  // Back to everything, and watch a whole type.
  await page.$$eval('#typeFilter .chip', (items) => items[0].click());
  await page.waitForTimeout(150);
  await page.$$eval('#typeList .typerow', (items) => {
    const row = items.find((item) => /Boeing 737 MAX 8/.test(item.textContent));
    row.querySelector('.type-toggle').click();
  });
  await page.waitForTimeout(150);

  let watchlist = await page.$eval('#watchList', (element) => element.textContent);
  assert.match(watchlist, /Boeing 737 MAX 8/);
  assert.match(watchlist, /every one of them/, 'a new type rule must start WIDE');

  // The departure it catches says which rule caught it.
  await page.waitForFunction(
    () => document.querySelectorAll('#departures .departure').length > 0,
    null,
    { timeout: 30_000 }
  );
  let board = await page.$eval('#departures .departure', (element) => element.textContent);
  assert.match(board, /caught by: any B38M/);

  // Now narrow it, and the same aircraft stops counting for that rule.
  await page.fill('#watchList .tail-form input', 'C-OTHER');
  await page.$eval('#watchList .tail-form button[type="submit"]', (element) => element.click());
  await page.waitForTimeout(200);
  watchlist = await page.$eval('#watchList', (element) => element.textContent);
  assert.match(watchlist, /1 tail number/);
  assert.match(watchlist, /C-OTHER/);

  await context.close();
});

test('narrowing to a tail number is UNDONE by removing it, back to the whole type', async () => {
  const { context, page } = await openPage([
    [{ hex: 'c011e4', flight: 'ACA123', r: 'C-GXXX', t: 'B38M', alt_baro: 5000, lat: 43.19, lon: -79.93 }],
  ]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  await page.$$eval('#typeList .typerow', (items) => {
    items.find((item) => /Boeing 737 MAX 8/.test(item.textContent)).querySelector('.type-toggle').click();
  });
  await page.fill('#watchList .tail-form input', 'C-GXXX');
  await page.$eval('#watchList .tail-form button[type="submit"]', (element) => element.click());
  await page.waitForTimeout(200);
  assert.match(await page.$eval('#watchList', (element) => element.textContent), /1 tail number/);

  await page.$eval('#watchList .tail-remove', (element) => element.click());
  await page.waitForTimeout(200);
  const after = await page.$eval('#watchList', (element) => element.textContent);
  assert.match(after, /every one of them/, 'removing the last tail did not widen the rule again');
  assert.equal(/tail number/.test(after), false);

  await context.close();
});

/* ============================================ the second round, 20 Sep 2026 ==
 * The brief: see the airports around you, pick whole types, reach the tail
 * numbers inside a type, then chart what is in the air now.
 */

test('the live view hides the choosing flow and charts only what matches', async () => {
  const { context, page } = await openPage([
    [
      { hex: 'c011e4', flight: 'ACA123', r: 'C-GXXX', t: 'B38M', alt_baro: 9000, baro_rate: 1800, gs: 240, lat: 43.19, lon: -79.93 },
      { hex: 'abcdef', flight: 'NOTMINE', r: 'N00001', t: 'C172', alt_baro: 4000, baro_rate: 300, gs: 90, lat: 43.21, lon: -79.9 },
    ],
  ]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  // Watch one type only, so an aircraft of any other type must not be drawn.
  await page.$$eval('#typeList .typerow', (items) => {
    items.find((item) => /Boeing 737 MAX 8/.test(item.textContent))?.querySelector('.type-toggle').click();
  });
  await page.waitForTimeout(300);

  await page.$eval('.view-switch[data-view="live"]', (element) => element.click());
  await page.waitForTimeout(400);

  assert.equal(await page.$eval('#liveView', (element) => element.hidden), false, 'the live view did not open');
  assert.equal(await page.$eval('#selectView', (element) => element.hidden), true, 'the choosing flow is still showing');

  const dots = await page.$$eval('#liveChart circle.radar-dot title', (nodes) => nodes.map((n) => n.textContent));
  assert.equal(dots.length, 1, `expected exactly one charted aircraft, drew ${dots.length}: ${dots.join(' | ')}`);
  assert.match(dots[0], /ACA123/);
  assert.equal(/NOTMINE/.test(dots.join(' ')), false, 'an aircraft matching nothing was drawn anyway');

  const table = await page.$eval('#liveBody', (element) => element.textContent);
  assert.match(table, /ACA123/);
  assert.match(table, /km/, 'the table must give a distance in kilometres');
  assert.equal(/NOTMINE/.test(table), false);

  await context.close();
});

test('the live view survives a switch back and forth', async () => {
  const { context, page } = await openPage([
    [{ hex: 'c011e4', flight: 'ACA123', r: 'C-GXXX', t: 'B38M', alt_baro: 9000, lat: 43.19, lon: -79.93 }],
  ]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');
  await page.$$eval('#typeList .typerow', (items) => {
    items.find((item) => /Boeing 737 MAX 8/.test(item.textContent))?.querySelector('.type-toggle').click();
  });
  await page.waitForTimeout(250);

  await page.$eval('.view-switch[data-view="live"]', (element) => element.click());
  await page.waitForTimeout(200);
  await page.$eval('#liveView .view-switch[data-view="select"]', (element) => element.click());
  await page.waitForTimeout(200);
  assert.equal(await page.$eval('#selectView', (element) => element.hidden), false, 'going back did not restore the choosing flow');

  await context.close();
});

test('ticking a tail number inside a type narrows the rule, and unticking widens it again', async () => {
  const { context, page } = await openPage([
    [{ hex: 'c011e4', flight: 'ACA123', r: 'C-GXXX', t: 'B38M', alt_baro: 9000, lat: 43.19, lon: -79.93 }],
  ]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  // The measurement for this type lists a tail number, because the survey saw
  // one transmit itself. Open the type and tick it.
  await page.$$eval('#typeList .typerow', (items) => {
    items.find((item) => /Boeing 737 MAX 8/.test(item.textContent))?.querySelector('.type-expand').click();
  });
  await page.waitForTimeout(200);

  const boxes = await page.$$('#typeList .tail-box input');
  assert.ok(boxes.length > 0, 'opening a type revealed no tail numbers to tick');
  await boxes[0].click();
  await page.waitForTimeout(250);

  const watch = await page.$eval('#watchList', (element) => element.textContent);
  assert.match(watch, /1 tail number/, `ticking a box did not narrow the rule: ${watch.slice(0, 200)}`);

  await page.$$eval('#typeList .tail-box input', (inputs) => inputs[0].click());
  await page.waitForTimeout(250);
  const widened = await page.$eval('#watchList', (element) => element.textContent);
  assert.match(widened, /every one of them/, 'unticking the last tail did not widen the rule again');

  await context.close();
});

test('a curated aircraft can be watched even though it has no type code to match', async () => {
  const { context, page } = await openPage([[[]]]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  const curated = await page.$eval('#typeList', (element) => element.textContent);
  assert.match(curated, /Lancaster/, 'the one aircraft this site was asked for is not on the list');
  assert.match(curated, /C-GVRA/);

  await page.$eval('#typeList .resident-toggle', (element) => element.click());
  await page.waitForTimeout(250);

  const watch = await page.$eval('#watchList', (element) => element.textContent);
  assert.match(watch, /C-GVRA/, 'watching the curated aircraft did not add its registration');
  assert.match(watch, /KB726/, 'the alternate marking it is painted with was not watched too');

  await context.close();
});

test('refusing the position request leaves a usable page', async () => {
  const { context, page } = await openPage([[[]]]);
  await context.grantPermissions([]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  await page.$eval('#locateBtn', (element) => element.click());
  await page.waitForTimeout(400);

  const note = await page.$eval('#locateNote', (element) => element.textContent);
  assert.ok(note.length > 0, 'a refusal said nothing at all');
  assert.equal(/undefined|NaN/.test(note), false, `the refusal message is broken: ${note}`);

  // And the page still works. The manual airport picker was removed on
  // 20 Sep 2026, so the path to an airport is the code or the position — and
  // after a refusal the form must still be there and still usable.
  assert.equal(await page.$eval('#postalInput', (element) => element.disabled), false,
    'the postal code field is unusable after a position refusal');

  await context.close();
});

/* ============================================ 20 Sep 2026, second pass ======= */

/** The postal answer, in the shape our own proxy normalises it into. */
function postalStub(route) {
  const asked = new URL(route.request().url()).pathname.split('/').pop() ?? '';
  const clean = decodeURIComponent(asked).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean === 'L8E' || clean === '[redacted]') {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true, lookedUp: 'L8E', country: 'Canada', region: 'Ontario',
        place: 'Hamilton (Riverdale)', lat: 43.2318, lon: -79.7696,
      }),
    });
  }
  return route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: 'That is not a Canadian postal code or a five-digit ZIP code.' }),
  });
}

test('a postal code orders the airports by distance, without asking the browser for anything', async () => {
  const { context, page } = await openPage([[[]]]);
  await page.route('**/api/geo/postal/**', postalStub);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');
  await page.waitForSelector('#nearbyList');

  await page.fill('#postalInput', '[redacted]');
  await page.$eval('#postalForm button[type="submit"]', (element) => element.click());
  await page.waitForTimeout(500);

  const chips = await page.$$eval('#nearbyList .near-chip', (items) =>
    items.map((item) => item.textContent.replace(/\s+/g, ' ').trim())
  );
  assert.ok(chips.length > 3, `a postal code produced no nearby airports: ${chips.join(' | ')}`);
  assert.match(chips[0], /CYHM/, `Hamilton should be nearest to a Hamilton postal code, got: ${chips[0]}`);

  // The distances must be ordered, which is the whole point of the panel.
  const kms = chips.map((text) => Number((text.match(/(\d+) km/) ?? [])[1]));
  assert.equal(kms.some(Number.isNaN), false, `a chip has no distance: ${chips.join(' | ')}`);
  for (let i = 1; i < kms.length; i += 1) {
    assert.ok(kms[i] >= kms[i - 1], `the list is not in distance order: ${kms.join(', ')}`);
  }

  const note = await page.$eval('#postalNote', (element) => element.textContent);
  assert.match(note, /Hamilton/);

  await context.close();
});

test('a postal code that is not one is refused with a sentence, and the page still works', async () => {
  const { context, page } = await openPage([[[]]]);
  await page.route('**/api/geo/postal/**', postalStub);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  await page.fill('#postalInput', 'not a code');
  await page.$eval('#postalForm button[type="submit"]', (element) => element.click());
  await page.waitForTimeout(400);

  const note = await page.$eval('#postalNote', (element) => element.textContent);
  assert.match(note, /not a Canadian postal code/i, `the refusal was not explained: ${note}`);
  assert.equal(/undefined|NaN|\[object/.test(note), false, `the refusal message is broken: ${note}`);

  // Refusing a lookup must not take the rest of the page with it.
  assert.equal(await page.$eval('#postalInput', (element) => element.disabled), false,
    'the postal code field is unusable after a refused lookup');
  assert.ok(await page.$$eval('#typeList .typerow', (items) => items.length) > 0);

  await context.close();
});

test('the Warplanes filter shows the Lancaster, and it is not hidden behind a filter', async () => {
  const { context, page } = await openPage([[[]]]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  // It is on the list under "everything" without touching a filter.
  assert.match(await page.$eval('#typeList', (element) => element.textContent), /Lancaster/);

  await page.$$eval('#typeFilter .chip', (items) => {
    items.find((item) => /Warplanes/i.test(item.textContent))?.click();
  });
  await page.waitForTimeout(300);

  const filtered = await page.$eval('#typeList', (element) => element.textContent);
  assert.match(filtered, /Lancaster/, 'the Lancaster vanished when the warplanes filter was applied');
  assert.match(filtered, /LANC/, 'the Lancaster row does not show its real type code');
  assert.equal(/Boeing 737 MAX 8/.test(filtered), false, 'an airliner is showing under the warplanes filter');

  await context.close();
});

test('the type list is in alphabetical order', async () => {
  const { context, page } = await openPage([[[]]]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  // 🔴 THE CURATED ROWS ARE EXCLUDED ON PURPOSE, AND THAT IS THE DESIGN. The
  // Lancaster is pinned to the top rather than sorted among the measured types,
  // because the whole reason it exists is that sorting by what the feed happened
  // to see is how it went missing in the first place. The alphabetical rule is
  // about the MEASURED list; asserting it over the pinned row would be testing a
  // behaviour nobody asked for.
  const names = await page.$$eval('#typeList .typerow:not(.typerow-curated) .typerow-main b', (items) =>
    items.map((item) => item.textContent.trim())
  );
  assert.ok(names.length > 5, 'no measured types to sort');
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(names, sorted, `the type list is not alphabetical:\n  ${names.join('\n  ')}`);

  await context.close();
});

/* ============================================ 20 Sep 2026, third pass ======== */

test('the later steps are hidden until the first one is answered, then glide in', async () => {
  const { context, page } = await openPage([[[]]]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#step-1');

  // Before an airport resolves, the reader sees the first step and nothing else.
  // The lookup is in flight at this point, so this is the true opening state.
  const before = await page.$$eval('.step-gated', (items) => items.map((item) => item.hidden));
  assert.equal(before.some((hidden) => hidden === false), false, 'a later step is showing before step 1 is answered');

  await page.waitForFunction(() => document.querySelector('#step-3')?.hidden === false, null, { timeout: 20000 });
  assert.equal(await page.$eval('#step-2', (element) => element.hidden), false, 'step 2 did not arrive with step 3');
  assert.equal(await page.$eval('#step-4', (element) => element.hidden), true, 'the watchlist showed before anything was picked');

  // A step that arrives is animated; the animation is removed again so a
  // re-render every ten seconds does not make the page twitch.
  await page.waitForTimeout(1200);
  assert.equal(await page.$eval('#step-3', (element) => element.classList.contains('step-arrive')), false,
    'the glide class is left on the step');

  await context.close();
});

test('the Warplanes filter is warplanes — the Cessna and the Dash 8 are NOT in it', async () => {
  const { context, page } = await openPage([[[]]]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  await page.$$eval('#typeFilter .chip', (items) => {
    items.find((item) => /Warplanes/i.test(item.textContent))?.click();
  });
  await page.waitForTimeout(400);

  const filtered = await page.$eval('#typeList', (element) => element.textContent);
  assert.match(filtered, /Lancaster/, 'the Lancaster is missing from Warplanes');

  // 🔴 THE BUG THE READER SPOTTED. Both of these are in the feed's worldwide
  // military feed because some air force somewhere flies one, and both are in the
  // measured survey at Hamilton. Neither is a warplane.
  assert.equal(/Cessna 172/.test(filtered), false, 'the Cessna 172 is classified as a warplane');
  assert.equal(/Dash 8/.test(filtered), false, 'the Dash 8 is classified as a warplane');

  // And the other direction: a type the flag stole from Airliner must be back.
  await page.$$eval('#typeFilter .chip', (items) => {
    items.find((item) => /^Airliner$/.test(item.textContent.trim()))?.click();
  });
  await page.waitForTimeout(400);
  const airliners = await page.$eval('#typeList', (element) => element.textContent);
  assert.match(airliners, /Boeing 737 MAX 8/, 'the Boeing 737 did not come back to Airliner');
  assert.equal(/Cessna 172/.test(airliners), false, 'a Cessna is showing under Airliner');

  await context.close();
});

test('tail numbers are chips on the row, and highlighting one unfavourites the whole type', async () => {
  const { context, page } = await openPage([[[]]]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  // The chips are there without pressing anything at all.
  const chips = await page.$$('#typeList .tail-chip');
  assert.ok(chips.length > 3, `the tail numbers are not listed as chips, found ${chips.length}`);

  await page.$$eval('#typeList .typerow', (items) => {
    items.find((item) => /Dash 8-400/.test(item.textContent))?.querySelector('.type-toggle').click();
  });
  await page.waitForTimeout(300);
  assert.match(await page.$eval('#watchList', (element) => element.textContent), /every one of them/,
    'favouriting a type did not watch the whole type');

  await page.$eval('#typeList .typerow .tail-chip', (element) => element.click());
  await page.waitForTimeout(300);

  const watch = await page.$eval('#watchList', (element) => element.textContent);
  assert.match(watch, /1 tail number/, `highlighting a tail did not narrow the rule: ${watch.slice(0, 200)}`);

  const pressed = await page.$$eval('#typeList .tail-chip[aria-pressed="true"]', (items) => items.length);
  assert.equal(pressed, 1, 'the highlighted chip does not show as highlighted');

  const button = await page.$$eval('#typeList .typerow', (items) =>
    items.find((item) => /Dash 8-400/.test(item.textContent))?.querySelector('.type-toggle').textContent
  );
  assert.match(button, /Favourite the whole type/,
    `the row still claims to watch the whole type after a tail was highlighted: ${button}`);

  await context.close();
});

test('the readability of a Dash 8 name, and a drawing beside every type', async () => {
  const { context, page } = await openPage([[[]]]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  const list = await page.$eval('#typeList', (element) => element.textContent);
  assert.match(list, /Dash 8/, 'the Dash 8 is not named');
  assert.equal(/Bombardier Dash 8/.test(list), false, 'the long name the reader asked to change is still there');
  assert.equal(/de Havilland Canada Dash/.test(list), false, 'the name still leads with the maker and the full series');

  const drawings = await page.$$eval('#typeList .typerow-thumb svg', (items) => items.length);
  const rows = await page.$$eval('#typeList .typerow', (items) => items.length);
  assert.equal(drawings, rows, `only ${drawings} of ${rows} rows have a drawing`);

  await context.close();
});

/* ============================================ 20 Sep 2026, fourth pass ======= */

test('the aircraft step is on the page from the start, with a note instead of a hiding', async () => {
  const { context, page } = await openPage([[[]]]);
  await page.route('**/api/0/airport/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForTimeout(900);

  for (const id of ['#step-2', '#step-3', '#step-5']) {
    assert.equal(await page.$eval(id, (element) => element.hidden), false, `${id} is hidden rather than waiting`);
    const why = await page.$eval(`${id} .step-why`, (element) => ({ hidden: element.hidden, text: element.textContent }));
    assert.equal(why.hidden, false, `${id} shows no note about what to do first`);
    assert.ok(why.text.length > 20, `${id}'s note says nothing`);
  }
  assert.match(await page.$eval('#step-3 .step-why', (element) => element.textContent), /airport/i);

  // And the controls inside a waiting step cannot be used.
  const disabled = await page.$$eval('#step-3 button', (items) => items.filter((i) => i.disabled).length);
  const total = await page.$$eval('#step-3 button', (items) => items.length);
  assert.ok(disabled > 0, 'nothing in the waiting step is disabled');
  assert.equal(disabled, total, `${total - disabled} control(s) in a waiting step are still usable`);

  await context.close();
});

test('the star says what the row actually watches', async () => {
  const { context, page } = await openPage([[[]]]);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  const row = '#typeList .typerow:has(.tail-chip)';
  const star = `${row} .star.type-toggle`;

  assert.equal(await page.$eval(star, (element) => element.getAttribute('aria-pressed')), 'false',
    'a type starts out favourited');

  await page.$eval(star, (element) => element.click());
  await page.waitForTimeout(250);
  assert.equal(await page.$eval(star, (element) => element.getAttribute('aria-pressed')), 'true',
    'pressing the star did not favourite the whole type');
  assert.match(await page.$eval(star, (element) => element.getAttribute('title')), /remove/i);

  // Highlighting one tail number un-favourites the whole type, and the star says so.
  await page.$eval(`${row} .tail-chip`, (element) => element.click());
  await page.waitForTimeout(250);
  assert.equal(await page.$eval(star, (element) => element.getAttribute('aria-pressed')), 'false',
    'the star still claims the whole type is favourited after a tail was highlighted');
  assert.match(await page.$eval(star, (element) => element.getAttribute('title')), /whole type/i);

  // 🔴 And the little star is on the chip the reader picked.
  const stars = await page.$$eval(`${row} .tail-chip .tail-star`, (items) => items.length);
  assert.equal(stars, 1, `expected one starred tail chip, found ${stars}`);

  await context.close();
});

test('the map draws the reader, the circle and the airport codes', async () => {
  const { context, page } = await openPage([[[]]]);
  await page.route('**/api/geo/postal/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, lookedUp: 'L8E', place: 'Hamilton', region: 'Ontario', lat: 43.2318, lon: -79.7696 }) })
  );

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForSelector('#typeList .typerow');

  assert.equal(await page.$$eval('#locMap svg', (items) => items.length), 0, 'a map is drawn before the reader says where they are');

  await page.fill('#postalInput', 'L8E');
  await page.$eval('#postalForm button[type="submit"]', (element) => element.click());
  await page.waitForSelector('#locMap svg', { timeout: 10000 });

  assert.ok(await page.$$eval('#locMap .locmap-you', (items) => items.length) >= 1, 'the reader is not on the map');
  assert.ok(await page.$$eval('#locMap .locmap-ring', (items) => items.length) >= 2, 'the distance rings are missing');
  const labels = await page.$$eval('#locMap .locmap-label', (items) => items.map((i) => i.textContent));
  assert.ok(labels.includes('CYHM'), `the airport codes are not on the map: ${labels.join(' ')}`);
  assert.equal(await page.$$eval('#locMap [src], #locMap iframe', (items) => items.length), 0,
    'the map loads something from somewhere instead of drawing it');

  await context.close();
});
