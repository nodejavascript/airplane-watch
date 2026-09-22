/**
 * A picture of the three filter rows, for the eye rather than for an assertion.
 *
 * It force-opens step 3 (which is gated on a place being known) so the rows are on screen
 * without needing the postal lookup or the feed.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
await p.goto(`http://127.0.0.1:4340/?v=${Date.now()}`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1800);
await p.$eval('#consentDecline', (el) => el.click()).catch(() => {});
await p.click('#radiusButtons button[data-km="20"]');
await p.waitForSelector('#typeList .typerow', { timeout: 30_000, state: 'attached' });
await p.$eval('#step-3', (el) => { el.hidden = false; });
await p.waitForTimeout(400);
// Element screenshots scroll the element into view themselves, which a page clip does not.
//
// 🔴 THE PANEL IS SHOT AS WELL, AND IT IS THE ONE THAT MATTERS. George, 22 Sep 2026: *"the filtering
// section is ugly look at it, its too cluttered"* — a judgement about the block as a whole, which
// three separate row shots cannot show: what made it ugly was how the rows sat together.
const panel = await p.$('.filters');
if (panel) await panel.screenshot({ path: '/tmp/row-filters.png' });
for (const id of ['typeFilter', 'yearFilter', 'seenFilter']) {
  await (await p.$(`#${id}`)).screenshot({ path: `/tmp/row-${id}.png` });
}
// One type row, with both marks on it — the star and the bell.
await p.$eval('#typeList .typerow .type-toggle', (el) => el.click());
await p.$eval('#typeList .typerow .alert-toggle', (el) => el.click());
await p.waitForTimeout(400);
await (await p.$('#typeList .typerow')).screenshot({ path: '/tmp/row-type.png' });
console.log('shot written');
await b.close();
