/**
 * Does the type section survive a reload?
 *
 * George, 21 Sep 2026: *"all my filters are gone. fix that. and i dont see any airplain type."*
 *
 * The filters and the type list both live inside `#step-3`, and `updateSteps()` opens it on
 * `answered1 = place && this.radiusChosen`. Both halves of that are restored from the reader's own
 * storage on load — so the thing to test is a page that has a SAVED location and a SAVED distance,
 * which is what every tab he opens now has, and which no fresh-context probe of mine ever had.
 *
 * So: answer step 1, confirm the section is open, reload, and look again.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4340';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const look = async (label) => {
  const state = await page.evaluate(() => {
    const vis = (id) => {
      const el = document.getElementById(id);
      if (!el) return 'MISSING';
      return el.hidden ? 'hidden' : el.getClientRects().length > 0 ? 'VISIBLE' : 'not-rendered';
    };
    return {
      step3: vis('step-3'),
      typeFilter: vis('typeFilter'),
      yearFilter: vis('yearFilter'),
      seenFilter: vis('seenFilter'),
      filterNote: vis('filterNote'),
      typeList: vis('typeList'),
      typeRows: document.querySelectorAll('#typeList .typerow').length,
      filterChips: document.querySelectorAll('#typeFilter button, #yearFilter button, #seenFilter button').length,
      radiusChosen: (() => {
        const chip = document.querySelector('#radiusButtons button[aria-pressed="true"]');
        return chip ? chip.textContent.trim() : null;
      })(),
      storedRadius: localStorage.getItem('aircraft_radius'),
      storedCentre: (localStorage.getItem('aircraft_centre') ?? '').slice(0, 60),
      storedAirports: localStorage.getItem('aircraft_airport'),
      placedLabel: (document.getElementById('placeName')?.textContent ?? '').trim().slice(0, 30),
      placeKnownVisible: vis('placeKnown'),
      placeAskVisible: vis('placeAsk'),
    };
  });
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(state, null, 1));
  return state;
};

await page.goto(BASE, { waitUntil: 'load' });
if (await page.$('#consentDecline')) await page.$eval('#consentDecline', (e) => e.click());
await page.waitForTimeout(700);
await look('at first load');

// Answer step 1 the way the suite does — a place and a distance, both events.
await page.fill('#placeSearchInput', 'Stoney Creek Ontario');
await page.$eval('#placeSearchForm button[type="submit"]', (e) => e.click());
await page.waitForSelector('#placeResults .place-result');
await page.$eval('#placeResults .place-result', (e) => e.click());
await page.waitForTimeout(1200);

await page.click('#radiusButtons button[data-km="25"]');
await page.waitForTimeout(1200);
await look('after answering step 1');

// ── AND NOW THE RELOAD, WHICH IS WHAT A FRESH TAB GIVES HIM ──────────────────
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1800);
await page.$eval('#consentDecline', (e) => e.click()).catch(() => {});
await page.waitForTimeout(1200);
const after = await look('AFTER A RELOAD');

console.log('\npageErrors:', errors);
await page.screenshot({ path: '/tmp/shots4/after-reload.png', fullPage: true }).catch(async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync('/tmp/shots4', { recursive: true });
  await page.screenshot({ path: '/tmp/shots4/after-reload.png', fullPage: true });
});
await browser.close();

const faults = [];
if (after.step3 !== 'VISIBLE') faults.push(`the type section is ${after.step3} after a reload`);
if (after.typeFilter !== 'VISIBLE') faults.push(`the kind filter is ${after.typeFilter} after a reload`);
if (after.seenFilter !== 'VISIBLE') faults.push(`the last-seen filter is ${after.seenFilter} after a reload`);
if (after.typeRows === 0) faults.push('no aircraft type is listed after a reload');
if (after.filterChips === 0) faults.push('there are no filter chips after a reload');
if (errors.length) faults.push(`page errors: ${errors.join(' | ')}`);

if (faults.length) {
  console.log('\nFAULTS:');
  for (const f of faults) console.log(' -', f);
  process.exit(1);
}
console.log('\nTHE FILTERS AND THE TYPE LIST COME BACK AFTER A RELOAD');
