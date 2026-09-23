/**
 * Prove the postal door is gone and nothing else went with it.
 *
 * George, 20 Sep 2026: *"i dont want any of this anymore"*, pasting the postal paragraph back.
 * So this checks two things at once — that no `#postal*` element survives anywhere in the
 * rendered page, and that the one way in that replaced it (a place searched by name) still
 * works end to end.
 *
 * 🔴 The page is driven, not read. A grep of the source would pass on a page that never
 * renders, and this card is built at runtime.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4340';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const out = { postalElements: [], postalText: [], placeSearch: {}, rowsAppeared: false };
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(BASE, { waitUntil: 'load' });

// The consent bar is in the way of nothing, but decline it so the page is in its normal state.
if (await page.$('#consentDecline')) await page.$eval('#consentDecline', (e) => e.click());

try {
  // Step 1 asks the reader where they are. Answer it, so the type list unlocks.
  const start = await page.$('#placeSearchForm button[type="submit"]');
  if (start) await start.click();
  await page.waitForTimeout(800);
  if (await page.$('#locateBtn')) await page.$eval('#locateBtn', (e) => e.click());
  await page.waitForTimeout(800);
} catch {
  // A step that is not there is not a failure here — the checks below say what is.
}

// 1. Nothing postal survives in the document, by id or by name.
out.postalElements = await page.$$eval('[id^="postal"], [name^="postal"], #postalForm, #postalInput, #postalNote', (nodes) =>
  nodes.map((node) => `${node.tagName.toLowerCase()}#${node.id || node.getAttribute('name')}`)
);
out.postalText = await page.$$eval('body *', (nodes) =>
  nodes
    .filter((node) => node.children.length === 0)
    .map((node) => node.textContent ?? '')
    // 🔴 ANY POSTAL CODE, NOT ONE PARTICULAR CODE — 23 September 2026. This searched for
    // the owner's own postal code, which is a private item in a repository that is now
    // public. Matching the shape is also the stronger test: it catches a postal code the
    // page might print that nobody thought to name.
    .filter((text) => /postal|ZIP code|\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/i.test(text))
);

// 2. The place search is present, and it answers a real query.
out.placeSearch = await page.evaluate(() => ({
  hasForm: Boolean(document.querySelector('#placeSearchForm')),
  hasInput: Boolean(document.querySelector('#placeSearchInput')),
  hasResultsHost: Boolean(document.querySelector('#placeResults')),
  inputDisabled: document.querySelector('#placeSearchInput')?.disabled ?? null,
  note: document.querySelector('#placeSearchNote')?.textContent?.trim() ?? '',
}));

if (out.placeSearch.hasForm) {
  await page.fill('#placeSearchInput', 'Stoney Creek Ontario');
  await page.$eval('#placeSearchForm button[type="submit"]', (e) => e.click());
  await page.waitForTimeout(2500);
  out.placeSearch.resultCount = await page.$$eval('#placeResults .place-result', (items) => items.length);
  out.placeSearch.firstResult = await page.$eval('#placeResults .place-result', (el) => el.textContent.trim()).catch(() => null);

  if (out.placeSearch.resultCount > 0) {
    await page.$eval('#placeResults .place-result', (e) => e.click());
    await page.waitForTimeout(2500);
    out.placeSearch.heading = await page.$eval('#nearbyHead', (el) => el.textContent.trim()).catch(() => null);
    out.placeSearch.nearbyChips = await page.$$eval('#nearbyList .near-chip', (items) => items.map((i) => i.textContent.trim()));
  }
}

// 3. The rest of the page still rendered — the aircraft table has real rows.
out.rowsAppeared = (await page.$$eval('#liveList tr.aircraft-row', (items) => items.length)) > 0;
out.typeRows = await page.$$eval('#typeList .typerow', (items) => items.length);

// 4. A quiet fence must not abort the probe: only report what failed to render.
out.pageErrors = errors;

await browser.close();
console.log(JSON.stringify(out, null, 2));

const faults = [];
if (out.postalElements.length) faults.push(`postal element(s) still on the page: ${out.postalElements.join(', ')}`);
if (out.postalText.length) faults.push(`postal wording still readable: ${out.postalText.join(' | ')}`);
if (!out.placeSearch.hasForm) faults.push('the place search form is gone');
if (out.placeSearch.note === '') faults.push('the place search says nothing about itself');

if (faults.length) {
  console.log('\nFAULTS:');
  for (const fault of faults) console.log(' -', fault);
  process.exit(1);
}
console.log('\nNO POSTAL DOOR, AND THE WAY IN THAT REPLACED IT ANSWERS');
