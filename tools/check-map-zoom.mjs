/**
 * Read the map's actual zoom, and the box it was asked to fit.
 *
 * George, 21 Sep 2026: "the map zoom should change to be zoomed out only to what is necessary.
 * it should change when distance is changed, or new airports are selected."
 *
 * Both halves of that are claims about numbers, so measure the numbers: the tile zoom out of
 * the image URLs at each distance, and with one, two and three airports picked. A zoom that
 * does not move when the distance does is a bug; a zoom that moves the WRONG WAY is a worse one.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4340';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(BASE, { waitUntil: 'load' });
if (await page.$('#consentDecline')) await page.$eval('#consentDecline', (e) => e.click());

// Answer step 1 by picking a place, which is what puts the reader on the map.
await page.fill('#placeSearchInput', 'Stoney Creek Ontario');
await page.$eval('#placeSearchForm button[type="submit"]', (e) => e.click());
await page.waitForSelector('#placeResults .place-result');
await page.$eval('#placeResults .place-result', (e) => e.click());
await page.waitForTimeout(1500);

/** The zoom the map is actually drawing at, read off the tile URLs it asked for. */
async function zoom() {
  const zs = await page.$$eval('#locMap img.locmap-tile', (imgs) =>
    imgs.map((img) => (img.getAttribute('src') ?? '').match(/\/api\/tiles\/(\d+)\//)?.[1]).filter(Boolean)
  );
  // 🔴 `locmap-fence`, NOT `locmap-ring`. The first version of this guard asked for a class
  // that has never existed, so it returned null for the ring at every distance and reported a
  // clean run while measuring nothing about the fence at all. It also made me believe, for one
  // round, that the map was drawing no circle — a false negative that sends the next change in
  // the wrong direction. The element and its box are read from the page as rendered.
  const ring = await page
    .$eval('#locMap circle.locmap-fence', (el) => ({
      r: Number(el.getAttribute('r')),
      cx: Number(el.getAttribute('cx')),
      cy: Number(el.getAttribute('cy')),
    }))
    .catch(() => null);
  const view = await page
    .$eval('#locMap svg.locmap-over', (el) => ({ w: el.clientWidth, h: el.clientHeight }))
    .catch(() => null);
  return { zoom: zs.length ? Number(zs[0]) : null, tiles: zs.length, fence: ring, view };
}

/** How many airports are picked right now. */
async function picked() {
  return page.$$eval('#nearbyList .near-chip[aria-pressed="true"]', (items) => items.length);
}

/** The reader's own place as the page holds it, from the label. */
async function place() {
  return page.$eval('#placeName', (el) => el.textContent.trim()).catch(() => null);
}

const out = { place: await place(), atDistance: {}, atAirports: {} };

// ── the distance ladder ───────────────────────────────────────────────────────
const steps = await page.$$eval('#radiusButtons .radius-slider', (sliders) =>
  sliders.map((s) => ({ min: Number(s.min), max: Number(s.max) }))
);
const ladder = steps[0] ?? { min: 0, max: 0 };
for (const value of [ladder.min, Math.round((ladder.min + ladder.max) / 2), ladder.max]) {
  await page.$eval(
    '#radiusButtons .radius-slider',
    (slider, v) => {
      slider.value = String(v);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value
  );
  await page.waitForTimeout(700);
  const label = await page.$eval('#radiusValue', (el) => el.textContent.trim()).catch(() => String(value));
  out.atDistance[label] = { ...(await zoom()), airports: await picked() };
}

// ── and the airport set ───────────────────────────────────────────────────────
await page.$eval('#radiusButtons .radius-slider', (slider, v) => {
  slider.value = String(v);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}, ladder.min);
await page.waitForTimeout(500);

for (const want of [1, 2, 3]) {
  // Press chips until the wanted number is picked.
  let now = await picked();
  const codes = await page.$$eval('#nearbyList .near-chip', (items) =>
    items.map((i) => ({ icao: i.dataset.icao, on: i.getAttribute('aria-pressed') === 'true' }))
  );
  for (const chip of codes) {
    if (now >= want) break;
    if (!chip.on) {
      await page.$eval(
        `#nearbyList .near-chip[data-icao="${chip.icao}"]`,
        (el) => el.click()
      );
      await page.waitForTimeout(900);
      now = await picked();
    }
  }
  const codes_on = await page.$$eval('#nearbyList .near-chip[aria-pressed="true"]', (items) =>
    items.map((i) => i.dataset.icao)
  );
  out.atAirports[`${want} airport(s)`] = { ...(await zoom()), picked: codes_on };
}

out.pageErrors = errors;
console.log(JSON.stringify(out, null, 2));
await browser.close();

/* ============================== the verdict =================================
 *
 * 🔴 THIS GUARD PRINTED NUMBERS AND EXITED 0 — WHICH IS NOT A GUARD. A check that cannot fail
 * is a print statement, and this file's own history proves the cost: a wrong selector made it
 * report a clean run over a map it had measured nothing about. What follows is the actual
 * claim George asked about, tested three ways.
 */
const faults = [];

/* 🔴 THE BOUNDS ARE DERIVED, NOT GUESSED, AND THE FIRST VERSION OF THIS GUARD GOT THAT WRONG.
 *
 * It demanded the fence fill at least half of the map's height. At 200 km the fence came out at
 * 49% of the full height and the guard failed — on a map that was CORRECTLY fitted. The reason
 * is arithmetic:
 *
 *   · the zoom ladder is DISCRETE — zoom 15, 14, 13 … each step doubles the scale, so the
 *     tightest zoom that fits draws the box somewhere between half and all of the space;
 *   · and the space is the view MINUS the padding, so a fence that fills half of the padded box
 *     fills a little LESS than half of the view.
 *
 * 458 px tall, PAD 40 → 378 px of usable height; a 224 px fence cannot be doubled to 448 without
 * overflowing, so 224 px is the tightest possible answer and the map is right. A threshold of
 * "half the full view" fires on that. That is a FALSE FAILURE, which is worse than no check —
 * it teaches the reader to ignore the guard. So the real invariants are used below instead, and
 * the floor is a sanity bound far below the discrete limit rather than at it.
 *
 * PAD is read from the source so the two cannot drift apart.
 */
const PAD = (() => {
  const match = /const PAD = (\d+)/.exec(readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8'));
  if (!match) {
    console.error('FAULT: could not read PAD out of src/app.ts — this guard must not guess it.');
    process.exit(1);
  }
  return Number(match[1]);
})();

// 1 · the fence must be DRAWN, and DRAWN WHOLE. The false negative above is the reason this is
// checked first: "the zoom is fine" means nothing if there is no circle to fit.
const drawn = Object.entries(out.atDistance).filter(([, v]) => v.fence !== null);
if (drawn.length === 0) {
  faults.push('no fence is drawn at any distance, so nothing was fitted to anything');
}
for (const [label, v] of drawn) {
  if (!(v.fence.r > 0)) faults.push(`at "${label}" the fence has radius ${v.fence.r}`);
  if (v.view) {
    const roomW = v.view.w - PAD * 2;
    const roomH = v.view.h - PAD * 2;
    const across = v.fence.r * 2;
    // It must FIT — a circle leaving the frame is a wrong answer however tight the zoom is.
    if (across > roomW + 1) faults.push(`at "${label}" the fence is wider than the usable map (${across} vs ${roomW})`);
    if (across > roomH + 1) faults.push(`at "${label}" the fence is taller than the usable map (${across} vs ${roomH})`);
    // And it must not be squeezed into a speck. 🔴 THE FLOOR IS 20% OF THE USABLE BOX, AND IT
    // IS SET FROM MEASUREMENT RATHER THAN TASTE. The fit now allows the picked airports ONE
    // zoom step beyond what the fence alone needs, and the fence alone fills between 50% and
    // 100% of the usable box — so one step out puts the worst legitimate case at about 25%.
    // Measured before the cap, and this is what the floor exists to catch:
    //
    //     8 km · 14 airports   fence  72 px — 19% of usable height
    //     0 km · 14 airports   fence  11 px —  3%, a dot
    //
    // Measured after it: 38% and 48%. A threshold at 20% clears every legitimate case with
    // room to spare and fails either of those regressions.
    const floor = Math.min(roomW, roomH) * 0.2;
    if (across < floor) {
      faults.push(
        `at "${label}" the fence is ${across} px across in a ${roomW}x${roomH} usable map — ` +
          `under the ${Math.round(floor)} px floor, so far airports have crushed it`
      );
    }
  }
}

// 2 · the zoom must CHANGE with the distance, and in the right DIRECTION.
const dist = Object.entries(out.atDistance).filter(([, v]) => v.zoom !== null);
const zooms = dist.map(([, v]) => v.zoom);
if (new Set(zooms).size === 1 && dist.length > 1) {
  faults.push(`the zoom never changes with distance — ${dist.map(([k]) => k).join(', ')} all draw at zoom ${zooms[0]}`);
}
for (let i = 1; i < dist.length; i += 1) {
  // The ladder runs near → far, so a wider fence must never be drawn at a CLOSER zoom.
  if (dist[i][1].zoom > dist[i - 1][1].zoom) {
    faults.push(`the zoom got CLOSER as the distance grew: ${dist[i - 1][0]} at ${dist[i - 1][1].zoom}, ${dist[i][0]} at ${dist[i][1].zoom}`);
  }
}

// 3 · and it must change the right way when airports are added — more of them means more to
// hold, which means further out, never nearer.
const air = Object.entries(out.atAirports).filter(([, v]) => v.zoom !== null);
for (let i = 1; i < air.length; i += 1) {
  if (air[i][1].zoom > air[i - 1][1].zoom) {
    faults.push(`adding airports brought the zoom CLOSER: ${air[i - 1][0]} at ${air[i - 1][1].zoom}, ${air[i][0]} at ${air[i][1].zoom}`);
  }
}

if (out.pageErrors.length) faults.push(`page errors: ${out.pageErrors.join(' | ')}`);

if (faults.length) {
  console.log('\nFAULTS:');
  for (const fault of faults) console.log(' -', fault);
  process.exit(1);
}
console.log('\nTHE MAP IS FITTED TO THE FENCE: IT MOVES WITH THE DISTANCE AND THE AIRPORTS, AND USES THE FRAME');
