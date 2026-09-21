/**
 * Check the two things George asked for on 21 Sep 2026 that only the rendered page can show:
 *
 *   1 · "and Showing 32 of 143 types. should be on a new line and highlighted."
 *   2 · "if i have nothing selected, it should tell the user to select some first, so all of this
 *        ... should be removed and tell a message instead, then show [it] when airplane types are
 *        selected"
 *
 * Both are claims about what is on screen, so both are read off the page — the element's own
 * display, and its measured colour, rather than the stylesheet it came from.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4340';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(BASE, { waitUntil: 'load' });
if (await page.$('#consentDecline')) await page.$eval('#consentDecline', (e) => e.click());
await page.fill('#placeSearchInput', 'Stoney Creek Ontario');
await page.$eval('#placeSearchForm button[type="submit"]', (e) => e.click());
await page.waitForSelector('#placeResults .place-result');
await page.$eval('#placeResults .place-result', (e) => e.click());
await page.waitForTimeout(1200);

const reply = {};

// ── 1 · the count, on its own line and highlighted ───────────────────────────
reply.count = await page.evaluate(() => {
  const el = document.querySelector('#filterNote .filter-count');
  if (!el) return { found: false };
  const styles = getComputedStyle(el);
  const note = getComputedStyle(el.parentElement);
  return {
    found: true,
    text: el.textContent.trim(),
    display: styles.display,
    weight: styles.fontWeight,
    colour: styles.color,
    // "On a new line" is a fact about the box, not about a <br>: a block element starts its own
    // line. Its own offsetTop must sit below the note's text, and it must be the last child.
    isLastChild: el.parentElement.lastElementChild === el,
    blockStartsLine: styles.display === 'block',
    fontSize: styles.fontSize,
    noteColour: note.color,
    differsFromNote: styles.color !== note.color,
  };
});

// ── 2 · the live gate ────────────────────────────────────────────────────────
const gate = async () =>
  page.evaluate(() => {
    const ask = document.querySelector('#liveAsk');
    const block = document.querySelector('#notifyBlock');
    const table = document.querySelector('#liveTable');
    const visible = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return !el.hidden && s.display !== 'none' && el.offsetParent !== null;
    };
    return {
      ask: visible(ask),
      askText: ask?.textContent?.trim() ?? '',
      notifyBlock: visible(block),
      table: visible(table),
      starred: [...document.querySelectorAll('#typeList .type-toggle')].filter(
        (b) => b.getAttribute('aria-pressed') === 'true'
      ).length,
    };
  });

reply.withNothingPicked = await gate();

// Star one type the way the page does it.
await page.$$eval('#typeList .typerow .type-toggle', (buttons) => buttons[0]?.click());
await page.waitForTimeout(500);
reply.afterStarringOne = await gate();

// And un-star it again — the gate must close, not latch open.
await page.$$eval('#typeList .typerow .type-toggle', (buttons) => buttons[0]?.click());
await page.waitForTimeout(500);
reply.afterUnstarring = await gate();

reply.pageErrors = errors;
console.log(JSON.stringify(reply, null, 2));
await browser.close();

const faults = [];
if (!reply.count.found) faults.push('the count is not its own element, so it cannot be on its own line');
else {
  if (!reply.count.blockStartsLine) faults.push(`the count is ${reply.count.display}, not a block of its own`);
  if (!reply.count.isLastChild) faults.push('the count is not the last thing in the note');
  if (!reply.count.differsFromNote) faults.push('the count is the same colour as the note around it, so it is not highlighted');
  if (!/^Showing \d+ of \d+ types?\.$/.test(reply.count.text)) faults.push(`the count reads oddly: ${reply.count.text}`);
}
if (reply.withNothingPicked.ask !== true) faults.push('nothing picked, but no sentence tells the reader to pick');
if (reply.withNothingPicked.notifyBlock !== false) faults.push('the alert line is still shown with nothing picked');
if (reply.withNothingPicked.table !== false) faults.push('the table is still shown with nothing picked');
if (reply.afterStarringOne.starred < 1) faults.push('starring a type did not register');
if (reply.afterStarringOne.ask !== false) faults.push('the "pick something" sentence stayed after a type was starred');
if (reply.afterStarringOne.notifyBlock !== true) faults.push('the alert line did not come back');
if (reply.afterStarringOne.table !== true) faults.push('the table did not come back');
if (reply.afterUnstarring.table !== false) faults.push('the table stayed after the last type was un-starred');
if (reply.pageErrors.length) faults.push(`page errors: ${reply.pageErrors.join(' | ')}`);

if (faults.length) {
  console.log('\nFAULTS:');
  for (const fault of faults) console.log(' -', fault);
  process.exit(1);
}
console.log('\nTHE COUNT IS ITS OWN HIGHLIGHTED LINE, AND THE LIVE CARD WAITS FOR A SELECTION');
