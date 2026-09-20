/**
 * Check the historic panel the way the reader meets it.
 *
 * The panel only appears when the reader has a location AND one of their nearby airports has a
 * historic site, so this drives that exact path: search a place, pick it, then read what the
 * panel says. A grep of the source would pass on a panel that never renders.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4340';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newContext().then((context) => context.newPage());
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

const out = {};

await page.goto(BASE, { waitUntil: 'load' });
if (await page.$('#consentDecline')) await page.$eval('#consentDecline', (e) => e.click());

// With no location the panel must be absent — a schedule for an airport we do not know is not
// something this card is entitled to show.
out.hiddenWithNoLocation = await page.$eval('#historicPanel', (el) => el.hidden);

// Search a place near Hamilton and pick it.
await page.fill('#placeSearchInput', 'Stoney Creek Ontario');
await page.$eval('#placeSearchForm button[type="submit"]', (e) => e.click());
await page.waitForSelector('#placeResults .place-result');
await page.$eval('#placeResults .place-result', (e) => e.click());
await page.waitForTimeout(1500);

out.hiddenAfterLocation = await page.$eval('#historicPanel', (el) => el.hidden);
out.panelText = await page.$eval('#historicPanel', (el) => el.innerText.replace(/\s+/g, ' ').trim());
out.nearbyChips = await page.$$eval('#nearbyList .near-chip', (items) => items.map((i) => i.textContent.trim()));

// Is CYHM actually among the airports offered, i.e. is the claim anchored to something on screen?
out.cyhmOffered = out.nearbyChips.some((text) => text.includes('CYHM'));

// The link must go somewhere real and say so.
out.linkHref = await page.$eval('#historicPanel a', (el) => el.getAttribute('href')).catch(() => null);

// And moving the reader far away must take it away again, because the museum is then not near
// them — this is the check that the panel follows the reader rather than being rendered once.
//
// 🔴 THE SEARCH FORM IS GONE ONCE A PLACE IS KNOWN, SO "change location" COMES FIRST. The card
// puts the question away and offers one line saying where you are with a way back, which is a
// deliberate design (see `#placeKnown` in site/index.html) — so a probe that typed straight
// into the box again was testing a page that did not exist.
await page.$eval('#changePlace', (e) => e.click());
await page.waitForSelector('#placeSearchInput', { state: 'visible' });
await page.fill('#placeSearchInput', 'Vancouver British Columbia');
await page.$eval('#placeSearchForm button[type="submit"]', (e) => e.click());
await page.waitForSelector('#placeResults .place-result');
await page.$eval('#placeResults .place-result', (e) => e.click());
await page.waitForTimeout(1500);
out.hiddenAfterMovingAway = await page.$eval('#historicPanel', (el) => el.hidden);

out.pageErrors = errors;

console.log(JSON.stringify(out, null, 2));
await browser.close();

const faults = [];
if (out.hiddenWithNoLocation !== true) faults.push('the panel showed before the page knew where the reader is');
if (out.hiddenAfterLocation === true) faults.push('the panel never appeared for a reader beside the museum airport');
if (!out.cyhmOffered) faults.push('CYHM was not among the airports offered, so the claim is not anchored');
if (out.linkHref && !/^https:\/\/www\.warplane\.com/.test(out.linkHref)) faults.push(`the link is not the museum: ${out.linkHref}`);
if (!/Lancaster/.test(out.panelText ?? '')) faults.push('the panel does not name the Lancaster');
if (out.hiddenAfterMovingAway !== true) faults.push('the panel stayed after the reader moved to the other side of the country');
if (out.pageErrors.length) faults.push(`page errors: ${out.pageErrors.join(' | ')}`);

if (faults.length) {
  console.log('\nFAULTS:');
  for (const fault of faults) console.log(' -', fault);
  process.exit(1);
}
console.log('\nTHE HISTORIC PANEL APPEARS FOR THE RIGHT READER AND LEAVES WITH THEM');
