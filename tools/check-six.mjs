/**
 * Drives the rendered page and reports the six things George asked for, read off the DOM.
 *
 * Written as a probe rather than a restatement of the source: every claim below is a value
 * taken from the live page, because the failures in this session were all "the code says it
 * does that" reported without looking.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4340';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });

const feed = [];
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('/api/v2/point/') || u.includes('/api/adsl/')) feed.push(u);
});

await page.goto(`${BASE}/?v=${Date.now()}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// Set a place, so the location line and the airport list are exercised.
await page.fill('#postalInput', '[redacted]');
await page.press('#postalInput', 'Enter');
await page.waitForTimeout(4000);

// The community chips the postal area offers — this is the answer to "[redacted] should say
// stoney creek at least".
const areas = await page.$$eval('#areaPicker .area-chip', (nodes) => nodes.map((n) => n.textContent.trim()));
const stoney = page.locator('#areaPicker .area-chip', { hasText: 'Stoney Creek' }).first();
if (await stoney.count()) {
  await stoney.click();
  await page.waitForTimeout(600);
}
const afterArea = await page.textContent('#placeName');

// Answer step 1 — the page deliberately asks the feed for nothing until it is answered.
await page.$eval('#radiusSlider', (el) => {
  el.value = '10';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(9000);

const out = await page.evaluate(() => {
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  const head = document.querySelector('#aircraftHead');
  const body = document.querySelector('#aircraftBody');
  const rows = [...(body?.querySelectorAll('tr') ?? [])];
  const firstRow = rows.find((r) => !r.classList.contains('type-group'));
  const groupRows = rows.filter((r) => r.classList.contains('type-group'));
  const radius = document.querySelector('#radiusSlider, input[type=range]');
  const style = radius ? getComputedStyle(radius) : null;
  const rowStyle = document.querySelector('.radius-row') ? getComputedStyle(document.querySelector('.radius-row')) : null;
  return {
    location: text('#placeName'),
    nearbyHead: text('#nearbyHead'),
    headings: [...(head?.querySelectorAll('th') ?? [])].map((th) => th.textContent.trim()),
    groupCount: groupRows.length,
    firstGroup: groupRows[0]?.textContent.trim() ?? null,
    firstRowCells: [...(firstRow?.querySelectorAll('td') ?? [])].map((td) => td.textContent.trim()),
    firstRowWatchKey: firstRow?.querySelector('td:nth-child(2)')?.textContent?.trim() ?? null,
    spanDays: text('#spanDays'),
    fenceNoteExists: !!document.querySelector('#fenceNote'),
    radiusBlurbExists: document.querySelector('#radiusBlurb') !== null,
    radiusEnds: document.querySelectorAll('.radius-end').length,
    // The two words he named, and the sentence he quoted.
    regionWords: [...document.querySelectorAll('#distance *')]
      .filter((n) => n.childElementCount === 0)
      .map((n) => n.textContent)
      .join(' '),
    lookingSentence: (document.body.innerText.match(/Looking [^.]*\./g) ?? []).slice(0, 3),
    feetNote: !!document.querySelector('#fenceNote'),
    sliderWidth: radius ? Math.round(radius.getBoundingClientRect().width) : 0,
    rowWidth: rowStyle ? Math.round(document.querySelector('.radius-row').getBoundingClientRect().width) : 0,
    sliderFlex: style ? style.flexGrow : null,
    // Any bracketed place list still on screen.
    bracketLeak: (document.body.innerText.match(/\(([^)]{20,})\)/) ?? [null])[0],
    // Any postal-code-looking token printed as a place.
    postalLeak: (document.body.innerText.match(/\bL\d[A-Z]\s?\d[A-Z]\d\b/i) ?? [null])[0],
  };
});

out.feedRequests = feed.length;
out.areaChips = areas;
out.locationAfterArea = afterArea;
out.feedUrls = feed.slice(0, 3);
console.log(JSON.stringify(out, null, 2));

await browser.close();
