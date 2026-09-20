/**
 * e2e.test.js — behaviour, in a real Chrome, against a real build.
 *
 * House standard part 6: the unit suite proves the shape, this one proves what
 * happens. Three things are only visible here — that a refusal makes ZERO
 * requests to Google (not "few", not "none of the ones we thought of"), that the
 * footer door actually opens the panel, and that a watched departure still raises
 * the alert now that the board it used to fire from is gone.
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
    // 🔴 ONLY THE AIRCRAFT QUERY ADVANCES THE SCRIPTED SEQUENCE, AND THAT IS THE FIX
    // FOR A HARNESS THAT COULD NOT HAVE WORKED. This stub used to answer EVERY
    // `/api/**` request that was not the airport lookup with the next set of aircraft —
    // and the page's own map asks for tiles under `/api/tiles/…`, thirty of them on a
    // single render (measured on the page: 31 requests before step 1 is even answered).
    // So each tile request ate one step of the sequence, the aircraft query kept being
    // handed the FIRST set of readings, and a test waiting for a ground-to-air
    // transition waited for a transition the page had no way to see. The failure read as
    // "the alert is broken" and was nothing of the kind.
    if (!url.includes('/api/v2/point/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
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

/**
 * Answers step 1 the way a reader does — by moving the distance slider.
 *
 * 🔴 THIS WAS FOUR CALLS TO `#radiusButtons button`, AND THE BUTTONS ARE GONE. George,
 * 20 Sep 2026: *"maybe this should be a slider? logrythmic?"* — so the row of distance
 * buttons became one slider, and every test that pressed a button started failing on a
 * missing selector. That reads exactly like a broken page and is not one, which is why the
 * gesture lives here, once, instead of in each test.
 *
 * `index` is the slider's own step, which is not the same as a distance: the track is
 * linear and the values are not, so `10` is 50 km. The default step is what "just move it"
 * means, and a test that cares about the exact distance passes one in.
 */
async function chooseDistance(page, index = 6) {
  await page.$eval(
    '#radiusSlider',
    (element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    index
  );
}

/**
 * Answer step 1, which is what UNLOCKS step 3 — the aircraft-type list.
 *
 * 🔴 SIXTEEN TESTS WAITED ON A LIST THE PAGE DELIBERATELY KEEPS HIDDEN. Every one of them
 * ended the same way, measured in the suite output:
 *
 *     waiting for locator('#typeList .typerow') to be visible
 *     64 × locator resolved to 43 elements. Proceeding with the first one: <div class="typerow">…
 *
 * Forty-three rows, found immediately, sixty-four times — and reported as a failure. The rows
 * were there and the SECTION around them was `hidden`, because `updateSteps()` shows the
 * type list only once step 1 is answered (`place && radiusChosen`). The test was asserting on
 * a page state the reader has not reached yet, so it could never pass, and it said nothing
 * about whether the type list works.
 *
 * That mattered more than the count suggests: the type list is exactly what changed today —
 * the table is grouped by type now — so the one area with new behaviour had no working test
 * at all, and the suite's noise was hiding it.
 */
async function answerStep1(page) {
  await chooseDistance(page);
}

/**
 * Select aircraft the way the page now does it: star types in step 3.
 *
 * 🔴 THE TABLE'S OWN WATCH LINK IS GONE, SO EVERY TEST THAT USED IT HAD TO MOVE. George,
 * 20 Sep 2026: *"remove the watch link"*, alongside *"this should only list the selected
 * flights and or tail"*. Selection now happens where the question is asked — a type starred
 * in step 3, a tail ticked on that type's row — and the table shows the result.
 *
 * Every type is starred rather than one, because which type happens to be overhead is not
 * knowable from outside the page, and these tests need at least one scripted aircraft to be
 * on the list. One click per row is enough: the listeners are attached at render time, so a
 * node detached by the next render still fires when it is clicked.
 */
async function starEveryType(page) {
  await page.waitForSelector('#typeList .typerow', { timeout: 30_000, state: 'attached' });
  await page.$$eval('#typeList .typerow .type-toggle', (nodes) => {
    for (const node of nodes) node.click();
  });
}

/** The distance the page is currently showing, in km. */
async function shownDistance(page) {
  return page.$eval('#radiusValue', (element) => element.textContent.trim());
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
  // 🔴 WAITING FOR A HIDDEN ELEMENT TO APPEAR IS A WAIT THAT CAN NEVER END.
  // `waitForSelector` defaults to `state: 'visible'`, and the selector here MATCHES AN
  // ELEMENT THAT IS HIDDEN — which is the whole point of `[hidden]`. So this line could
  // never be satisfied, and each of the three tests carrying it burned a full 30-second
  // timeout and reported a failure. Measured in the suite output: *"waiting for locator
  // '#consentBar[hidden]' to be visible … 64 × locator resolved to hidden <div hidden>…"* —
  // Playwright found it immediately, 64 times, and was right to call it not visible.
  // `state: 'attached'` is the question actually being asked: the bar is in the document,
  // it has been dismissed, and it is not on screen.
  await page.waitForSelector('#consentBar[hidden]', { state: 'attached' });
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
  // 🔴 WAITING FOR A HIDDEN ELEMENT TO APPEAR IS A WAIT THAT CAN NEVER END.
  // `waitForSelector` defaults to `state: 'visible'`, and the selector here MATCHES AN
  // ELEMENT THAT IS HIDDEN — which is the whole point of `[hidden]`. So this line could
  // never be satisfied, and each of the three tests carrying it burned a full 30-second
  // timeout and reported a failure. Measured in the suite output: *"waiting for locator
  // '#consentBar[hidden]' to be visible … 64 × locator resolved to hidden <div hidden>…"* —
  // Playwright found it immediately, 64 times, and was right to call it not visible.
  // `state: 'attached'` is the question actually being asked: the bar is in the document,
  // it has been dismissed, and it is not on screen.
  await page.waitForSelector('#consentBar[hidden]', { state: 'attached' });

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
  // 🔴 WAITING FOR A HIDDEN ELEMENT TO APPEAR IS A WAIT THAT CAN NEVER END.
  // `waitForSelector` defaults to `state: 'visible'`, and the selector here MATCHES AN
  // ELEMENT THAT IS HIDDEN — which is the whole point of `[hidden]`. So this line could
  // never be satisfied, and each of the three tests carrying it burned a full 30-second
  // timeout and reported a failure. Measured in the suite output: *"waiting for locator
  // '#consentBar[hidden]' to be visible … 64 × locator resolved to hidden <div hidden>…"* —
  // Playwright found it immediately, 64 times, and was right to call it not visible.
  // `state: 'attached'` is the question actually being asked: the bar is in the document,
  // it has been dismissed, and it is not on screen.
  await page.waitForSelector('#consentBar[hidden]', { state: 'attached' });

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

  // 🔴 THE AIRPORT CARD'S OLD ELEMENTS ARE GONE AND THE TEST HAS TO SAY WHAT IT CAN NOW.
  // This read `#airportTitle` and `#airportWhere`, and it asserted the fetched coordinates
  // appeared on screen — which was a good proof that the lookup happened rather than a
  // constant being echoed. Both elements have since been removed in a redesign, and the page
  // no longer prints an airport's coordinates to the reader at all. So the coordinate claim
  // is DROPPED rather than faked, and what is left is checked against the elements that do
  // exist: the airport is named in the nearby list, and the feed answered.
  await page.waitForFunction(
    () => /CYHM/.test(document.getElementById('nearbyList')?.textContent ?? ''),
    null,
    { timeout: 20_000 }
  );
  const nearby = await page.$eval('#nearbyList', (element) => element.textContent);
  assert.match(nearby, /CYHM/, 'the airport the feed named is not on the page');

  // 🔴 THE TABLE LISTS ONLY WHAT WAS PICKED, SO SOMETHING HAS TO BE PICKED FIRST.
  // George, 20 Sep 2026: *"this should only list the selected flights and or tail"*. This
  // test used to read the two scripted aircraft straight off the card, which stopped being
  // true the moment the card started filtering — the failure said "the table does not name
  // the aircraft" when the table was working exactly as asked.
  await chooseDistance(page);
  await starEveryType(page);

  await page.waitForFunction(
    () => /ACA123/.test(document.getElementById('aircraftBody')?.textContent ?? ''),
    null,
    { timeout: 45_000 }
  );
  const body = await page.$eval('#aircraftBody', (element) => element.textContent);
  assert.match(body, /BBA535/);
  // The two phases must be told apart, because telling them apart is the feature.
  assert.match(body, /airborne/);
  assert.match(body, /on the ground/);

  await context.close();
});

test('a watched departure raises the alert — the board went, the alert stayed', async () => {
  const polls = [
    [{ hex: 'c011e4', flight: 'ACA123', t: 'B738', alt_baro: 'ground', gs: 0, lat: 43.18, lon: -79.94 }],
    [{ hex: 'c011e4', flight: 'ACA123', t: 'B738', alt_baro: 1400, baro_rate: 2300, lat: 43.19, lon: -79.93 }],
  ];
  const { context, page } = await openPage(polls);

  // 🔴 THIS TEST EXISTS BECAUSE THE ALERT FIRED FROM INSIDE THE BOARD.
  //
  // The departures board was removed on George's instruction (20 Sep 2026, pasting
  // the list: *"remove all of this"*) — and the notification for a watched aircraft
  // was raised from the board's own write. Deleting the board the obvious way would
  // have deleted the alert, which is the thing he said the page is FOR: *"the goal is
  // to alert people when their selected aircrafts are in the air around them"*.
  //
  // A screenshot cannot see this: with the board gone there is nothing on the page
  // that shows whether the alert still fires. So `Notification` is stubbed before any
  // script runs, and the promise is that a watched ground-to-air transition raises
  // exactly one.
  await page.addInitScript(() => {
    window.__alerts = [];
    class StubNotification {
      static permission = 'granted';
      constructor(title, options) {
        window.__alerts.push({ title: String(title), body: String((options && options.body) || '') });
      }
    }
    Object.defineProperty(window, 'Notification', { value: StubNotification, writable: true });
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());

  // 🔴 SELECTED BY STARRING A TYPE, BECAUSE THE TABLE'S WATCH LINK IS GONE. An earlier
  // version of this test filled `#watchInput`, then clicked the table's own watch button;
  // both controls have since been removed by George, and a test that waits for a removed
  // selector fails on a 30-second timeout that reads exactly like a broken alert.
  //
  // 🔴 AND STEP 1 HAS TO BE ANSWERED BEFORE THE PAGE ASKS THE FEED FOR ANYTHING.
  // Measured on the page rather than guessed: with no distance chosen the table still
  // reads *"Waiting for the first poll…"*. The page deliberately sends nothing until the
  // reader has said where and how far — so a test that expects aircraft has to answer step 1
  // first, or it is waiting for a request the page will never make.
  await chooseDistance(page);
  await starEveryType(page);

  await page.waitForFunction(() => window.__alerts.length > 0, null, { timeout: 45_000 });
  const alerts = await page.evaluate(() => window.__alerts);
  assert.equal(alerts.length, 1, `expected one alert, got ${alerts.length}: ${JSON.stringify(alerts)}`);
  assert.match(alerts[0].title, /ACA123/, 'the alert must name the aircraft that left');

  await context.close();
});

test('the selection survives a reload', async () => {
  // One set, so every poll returns the same aircraft — the stub clamps at the last entry,
  // which is what makes the row still there to assert on after the reload.
  const polls = [
    [{ hex: 'c011e4', flight: 'ACA123', r: 'C-GXXX', t: 'B738', alt_baro: 5000, lat: 43.19, lon: -79.93 }],
  ];
  const { context, page } = await openPage(polls);

  // 🔴 WHAT IS ASSERTED IS THE ROW, BECAUSE THE TWO CARDS THAT USED TO PROVE IT ARE GONE.
  // This test read `#watchList`, and then the table's watch button — both removed by George.
  // What survives is the guarantee itself: what you picked is still picked after a reload,
  // and the table still lists it.
  const rows = async () => page.$$eval('#aircraftBody tr.aircraft-row', (nodes) => nodes.length);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await chooseDistance(page);
  await starEveryType(page);
  await page.waitForSelector('#aircraftBody tr.aircraft-row', { timeout: 45_000 });
  const before = await rows();
  assert.ok(before > 0, 'nothing was listed before the reload, so the reload proves nothing');

  await page.reload({ waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click()).catch(() => {});
  await chooseDistance(page);
  await page.waitForSelector('#aircraftBody tr.aircraft-row', { timeout: 45_000 });
  assert.equal(await rows(), before, 'the selection did not survive a reload');

  await context.close();
});

test('the table lists only the aircraft that were picked', async () => {
  const { context, page } = await openPage([
    [{ hex: 'c011e4', flight: 'ACA123', t: 'B738', alt_baro: 5000, lat: 43.19, lon: -79.93 }],
  ]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await chooseDistance(page);

  // 🔴 THE NEGATIVE CASE FIRST, AND IT HAS TO NAME ITS OWN REASON FOR BEING EMPTY. George,
  // 20 Sep 2026: *"this should only list the selected flights and or tail"*. Nothing has
  // been picked yet, so the card must list nothing — and must say which nothing it is,
  // because "nothing in the fence" over a filtered card would be false while aircraft are
  // plainly overhead. The message counts them, so this waits for a poll to have happened.
  await page.waitForFunction(
    () => /matches what you picked/.test(document.querySelector('#aircraftBody')?.textContent ?? ''),
    null,
    { timeout: 45_000 }
  );
  const empty = await page.$eval('#aircraftBody', (element) => element.textContent.replace(/\s+/g, ' '));
  assert.match(empty, /matches what you picked/);
  assert.match(empty, /The feed can see \d+ aircraft right now/, 'the empty state must say how many it is leaving out');

  // And the positive case: pick, and they arrive.
  await starEveryType(page);
  await page.waitForSelector('#aircraftBody tr.aircraft-row', { timeout: 45_000 });

  // 🔴 THE CONTROL THAT USED TO BE HERE IS GONE, SO ITS ABSENCE IS ASSERTED. This test
  // asserted that the table's watch button toggled to "unwatch"; George asked for the link to
  // be removed and for lat/long to take its place, so the honest version of the test checks
  // the table has no watch control left and that the position is on every row.
  assert.equal(await page.$$eval('.watch-toggle', (nodes) => nodes.length), 0, 'the watch link is still on the page');
  const cells = await page.$$eval('#aircraftBody tr.aircraft-row td', (nodes) => nodes.map((n) => n.textContent.trim()));
  const positions = cells.filter((cell) => /^-?\d+\.\d{4}, -?\d+\.\d{4}$/.test(cell));
  assert.ok(positions.length > 0, `no lat/long on any row: ${JSON.stringify(cells.slice(0, 6))}`);

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

  // 🔴 THE CONTROL IS A SLIDER AND ITS READOUT IS THE PROOF. It used to be a row of
  // buttons that carried words like "Just the airport" beside each distance; George asked
  // for a slider on 20 Sep 2026 (*"maybe this should be a slider? logrythmic?"*) and the
  // words went with the buttons. What the reader is told now is the number.
  await chooseDistance(page, 6);
  const shown = await shownDistance(page);
  assert.match(shown, /^\d+ km$/, `the distance readout is not a distance in km: ${shown}`);
  const stated = Number(shown.replace(/[^\d]/g, ''));
  assert.ok(stated > 0, 'the slider must state a real distance');

  // Nothing the reader can read says "nm".
  const visibleText = await page.evaluate(() => document.body.innerText);
  assert.equal(/\bnm\b/.test(visibleText), false, 'the page shows the reader "nm"');
  assert.match(visibleText, new RegExp(`${stated} km`), 'the page does not show the distance it chose');

  // 🔴 WAIT FOR THE REQUEST RATHER THAN A GUESSED INTERVAL. This was a flat 1,000 ms
  // against a feed the page asks on its own schedule, and it reported *"no poll reached the
  // feed"* on a page that was polling — a false failure, which is worse than no check,
  // because it teaches the reader to ignore the test.
  const deadline = Date.now() + 20_000;
  while (polled.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(200);
  }
  assert.ok(polled.length > 0, 'no poll reached the feed');
  // …but the FEED still gets nautical miles, because that is the unit it takes: its own
  // endpoint summary says "up to 250nm". The radius on the wire is the kilometres the
  // reader chose converted at 1.852 km to the nautical mile, rounded — so it is checked
  // against the readout rather than against a number written here.
  const expectedNm = Math.round(stated / 1.852);
  assert.match(
    polled[0],
    new RegExp(`/${expectedNm}$`),
    `the poll did not ask in nautical miles: ${polled[0]} (${stated} km is ${expectedNm} nm)`
  );

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
  await answerStep1(page);
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

  // 🔴 THE LINE THAT USED TO BE HERE ASSERTED ON THE BOARD. The board is gone
  // (see the alert test above), and which rule caught a departure is a property of
  // the ENGINE, not of any list — it is covered directly in test/detect.test.js
  // (*"a departure remembers WHICH rule caught it"*). Asserting it through a card
  // that no longer exists would have proved nothing and failed for the wrong reason.

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
  await answerStep1(page);
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
  await answerStep1(page);
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
  await answerStep1(page);
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
  await answerStep1(page);
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


test('refusing the position request leaves a usable page', async () => {
  const { context, page } = await openPage([[[]]]);
  await context.grantPermissions([]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await answerStep1(page);
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
  await answerStep1(page);
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
  await answerStep1(page);
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


test('the type list is in alphabetical order', async () => {
  const { context, page } = await openPage([[[]]]);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await answerStep1(page);
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
  await answerStep1(page);
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
  await answerStep1(page);
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
  await answerStep1(page);
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
  await answerStep1(page);
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
  await answerStep1(page);
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


test('every row shows a free photograph with its credit, or a drawing and no claim', async () => {
  const { context, page } = await openPage([[[]]]);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await answerStep1(page);
  await page.waitForSelector('#typeList .typerow');
  await page.waitForTimeout(900);

  const rows = await page.$$eval('#typeList .typerow', (items) =>
    items.map((item) => ({
      text: item.textContent,
      photos: item.querySelectorAll('img.typerow-photo').length,
      drawings: item.querySelectorAll('.typerow-thumb svg').length,
      src: item.querySelector('img.typerow-photo')?.getAttribute('src') ?? '',
    }))
  );
  assert.ok(rows.length > 5, 'no types to check');
  assert.ok(rows.some((r) => r.photos === 1), 'not one row shows a photograph');

  for (const row of rows) {
    // Exactly one of the two, never neither and never both.
    assert.equal(row.photos + row.drawings, 1, `a row has ${row.photos} photo(s) and ${row.drawings} drawing(s)`);
  }

  for (const row of rows.filter((r) => r.photos === 1)) {
    // 🔴 The credit has to be ON THE ROW, because every licence these files carry
    // requires the attribution to be visible — and a row that shows a photograph
    // without one is a licence breach, not a missing nicety.
    assert.match(row.text, /photo .+ \(/, `a photographed row carries no credit: ${row.text.slice(0, 120)}`);
    // 🔴 And the image must come from our own origin, never from Wikimedia direct.
    assert.ok(row.src.startsWith('/api/photo?src='), `the image is fetched from somewhere else: ${row.src}`);
  }

  await context.close();
});

test('a type whose search match was weak gets a drawing instead of a wrong picture', async () => {
  const { context, page } = await openPage([[[]]]);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.$eval('#consentDecline', (element) => element.click());
  await answerStep1(page);
  await page.waitForSelector('#typeList .typerow');
  await page.waitForTimeout(900);

  const photos = await page.evaluate(async () => (await (await fetch('/photos.json')).json()).found);
  const weak = Object.values(photos).filter((r) => !r.confident);
  assert.ok(weak.length > 0, 'the survey found no weak matches, so this test proves nothing');

  // The measured examples: a list page, an armoured vehicle, a microphone company.
  const byCode = await page.$$eval('#typeList .typerow', (items) =>
    Object.fromEntries(
      items.map((item) => [
        item.querySelector('.typerow-main .mono')?.textContent ?? '',
        { photo: item.querySelectorAll('img.typerow-photo').length, text: item.textContent },
      ])
    )
  );
  let checked = 0;
  for (const row of weak) {
    const shown = byCode[row.code];
    if (!shown) continue;
    assert.equal(shown.photo, 0, `${row.code} showed a photograph from a weak match (${row.title})`);
    checked += 1;
  }
  assert.ok(checked > 0, 'no weak-match type was on the visible list to check');

  await context.close();
});
