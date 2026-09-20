/**
 * Does the "last seen" filter actually hide anything?
 *
 * 🔴 THIS EXISTS BECAUSE THE LIVE DATA CANNOT ANSWER IT. Every look at the sky recorded so
 * far happened today, so every type falls inside every window and all six chips return the
 * same list — pressing them proves nothing. George asked to *"make sure to apply that
 * filter"*, and the only way to check it is against data where the windows differ.
 *
 * 🔴 AND IT CANNOT BE CHECKED AGAINST THE DEV SERVER AT ALL. Measured 20 Sep 2026: the dev
 * server BUILDS `/types.json` from Postgres (`x-data-source: database-cached`), so writing a
 * file to `site/types.json` changes nothing the page receives. The first attempt at this
 * proof did exactly that, got 57 rows from all six chips, and would have been reported as a
 * broken filter — it was a broken experiment. So this runs against a plain static server
 * serving `site/`, where `/types.json` IS the file on disk:
 *
 *     python3 -m http.server 4341 --directory site
 *     BASE=http://127.0.0.1:4341 node tools/check-seen-filter.mjs
 *
 * The live feed API is absent there, which does not matter: the type list is built from the
 * survey file and not from the feed, and a failed poll leaves it alone.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4340';

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
const page = await context.newPage();
await page.goto(`${BASE}/?v=${Date.now()}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.$eval('#consentDecline', (el) => el.click()).catch(() => {});

// A postal lookup is not needed and is not available here — step 1 only has to be answered,
// so the slider alone is moved.
await page.$eval(
  '#radiusSlider',
  (el) => {
    el.value = '6';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
);
// 🔴 `attached`, NOT `visible`. On the static server there is no airport lookup, so step 3
// never unlocks and the section stays hidden — but its type list is still rendered (measured:
// "locator resolved to 120 elements" while every visibility wait timed out). The filter is a
// change to that list, so the list is what this reads, hidden or not.
await page.waitForSelector('#typeList .typerow', { timeout: 30_000, state: 'attached' });

const chips = await page.$$eval('#seenFilter button', (nodes) => nodes.map((n) => n.textContent.trim()));
const rows = async () => page.$$eval('#typeList .typerow', (n) => n.length);

// "Everything" is already the airport set; clicking each chip in turn reads what it leaves.
const frozen = await page.$$eval('#typeFilter button[aria-pressed="true"]', (nodes) => nodes.map((n) => n.textContent.trim()));
const measured = [];
for (let i = 0; i < chips.length; i += 1) {
  await page.$$eval('#seenFilter button', (nodes, index) => nodes[index].click(), i);
  await page.waitForTimeout(250);
  measured.push({ chip: chips[i], rows: await rows(), note: (await page.$eval('#filterNote', (n) => n.textContent)).slice(0, 900) });
}

console.log(JSON.stringify({ frozenTypeFilter: frozen, chips: chips.length, measured }, null, 2));
await browser.close();
