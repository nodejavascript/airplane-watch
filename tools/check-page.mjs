/**
 * Drives the page and reads back the six things asked for on 20 Sep 2026.
 *
 * Every value below is taken from the rendered DOM, not from the source — the failures in
 * this project have all been "the code says it does that", reported without looking.
 *
 * Usage: node tools/check-page.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4340';

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
// "Find me" needs a position and needs the permission to have been granted.
await context.grantPermissions(['geolocation']);
await context.setGeolocation({ latitude: 43.2318, longitude: -79.7696 });

const page = await context.newPage();
await page.goto(`${BASE}/?v=${Date.now()}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.$eval('#consentDecline', (el) => el.click()).catch(() => {});

const out = {};
const text = (sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);

// ── 3 · the table lists only what was picked ────────────────────────────────────────────
// Nothing starred yet, so nothing may be listed — and the empty state has to say which
// empty it is, because the feed is busy right now.
out.emptyTable = await text('#aircraftBody');
out.watchButtonsWhenEmpty = await page.$$eval('.watch-toggle', (n) => n.length);

// ── the seen chips ──────────────────────────────────────────────────────────────────────
await page.fill('#postalInput', '[redacted]');
await page.press('#postalInput', 'Enter');
await page.waitForTimeout(3500);
await page.$eval(
  '#radiusSlider',
  (el) => {
    el.value = '6';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
);
await page.waitForSelector('#typeList .typerow', { timeout: 30_000 });

out.seenChips = await page.$$eval('#seenFilter button', (nodes) => nodes.map((n) => n.textContent.trim()));
out.seenPressed = await page.$$eval('#seenFilter button[aria-pressed="true"]', (nodes) => nodes.map((n) => n.textContent.trim()));
out.typeRowsAll = await page.$$eval('#typeList .typerow', (n) => n.length);

// ── 1 · star every type, then the table must list what is up ────────────────────────────
// Starring ALL of them rather than one, because which type happens to be overhead right now
// is not knowable from outside the page — and the point of this measurement is the positive
// case, which needs at least one of the six aircraft in the fence to be on the list.
await page.$$eval('#typeList .typerow .type-toggle', (nodes) => {
  for (const node of nodes) node.click();
});
await page.waitForSelector('#aircraftBody tr.aircraft-row', { timeout: 60_000 });
await page.waitForTimeout(600);

out.headings = await page.$$eval('#live thead th', (nodes) => nodes.map((n) => n.textContent.trim()));
out.groupHeads = await page.$$eval('#aircraftBody .type-group', (nodes) =>
  nodes.slice(0, 4).map((n) => n.textContent.replace(/\s+/g, ' ').trim())
);
out.bodyRows = await page.$$eval('#aircraftBody tr', (nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()).slice(0, 6));
out.firstDataCells = await page.$$eval('#aircraftBody tr.aircraft-row td', (nodes) =>
  nodes.slice(0, 5).map((n) => n.textContent.replace(/\s+/g, ' ').trim())
);
out.watchButtons = await page.$$eval('.watch-toggle', (n) => n.length);
out.headingCount = await page.$$eval('#aircraftBody tr.aircraft-row', (n) => n.length);

// ── 2 · the age ticks on its own, without waiting for a poll ────────────────────────────
const readAge = () => page.$eval('.reading-ago', (n) => n.textContent.trim()).catch(() => null);
out.ageAtFirstPaint = await readAge();
await page.waitForTimeout(2400);
out.ageTwoSecondsLater = await readAge();
out.ageTicked = out.ageAtFirstPaint !== out.ageTwoSecondsLater;

out.locationLabel = await text('#placeName');
out.step2Sub = await text('#live .sub');
out.filterNote = await text('#filterNote');

// ── 1 (previous message) · find me names the place ──────────────────────────────────────
await page.$eval('#changePlace', (el) => el.click()).catch(() => {});
await page.waitForTimeout(400);
await page.$eval('#locateBtn', (el) => el.click()).catch(() => {});
await page.waitForTimeout(4000);
out.locationAfterFindMe = await text('#placeName');
out.locateNote = await text('#locateNote');

console.log(JSON.stringify(out, null, 2));
await browser.close();
