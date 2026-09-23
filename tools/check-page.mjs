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
out.watchButtons = await page.$$eval('.watch-toggle', (n) => n.length);

// ── the bell, and the place search ─────────────────────────────────────────────────────
// The bell is a separate list from the star, so with the page fresh there are no bells armed.
out.bellsBefore = await page.$$eval('.bell[aria-pressed="true"]', (n) => n.length);
out.starsBefore = await page.$$eval('.star[aria-pressed="true"]', (n) => n.length);
out.notifyNoteBefore = await text('#notifyNote');

// ── the seen chips ──────────────────────────────────────────────────────────────────────
// 🔴 THE FIXTURE IS A PUBLIC BUILDING'S POSTAL CODE, NEVER A HOME — 23 September 2026.
// It was the owner's own postal code, which is a private item in a repository that is now
// public. The airport replaces it: the same shape of query, and every aircraft this page
// shows is at that airport. Measured from the geocoder before it was written down — which
// is the only way a fixture may enter this repo, because a made-up one does not resolve.
await page.fill('#postalInput', 'L0R1W0');
await page.press('#postalInput', 'Enter');
await page.waitForTimeout(3500);
// 🔴 THE DISTANCE IS A CHIP NOW, NOT A SLIDER — one press, one answer, instead of writing a value
// into a range input and firing two synthetic events at it. 
// ⚠ AND IT PRESSES A STOP THAT EXISTS: the row opens on `All` and the numbered stops are
// 25 · 50 · 75 · 100 · 150 · 200 · 400, so 25 is the tight fence this checker wants.
await page.click('#radiusButtons button[data-km="25"]');
await page.waitForSelector('#typeList .typerow', { timeout: 30_000 });

out.seenChips = await page.$$eval('#seenFilter button', (nodes) => nodes.map((n) => n.textContent.trim()));
out.seenPressed = await page.$$eval('#seenFilter button[aria-pressed="true"]', (nodes) => nodes.map((n) => n.textContent.trim()));
out.typeRowsAll = await page.$$eval('#typeList .typerow', (n) => n.length);

// ── the row labels, and whether they are wired to their groups ──────────────────────────
out.rowLabels = await page.$$eval('.chip-label', (nodes) => nodes.map((n) => n.textContent.trim()));
out.groupLabels = await page.evaluate(() =>
  ['typeFilter', 'yearFilter', 'seenFilter'].map((id) => {
    const host = document.getElementById(id);
    const labelled = host?.getAttribute('aria-labelledby');
    return {
      id,
      labelledby: labelled ?? null,
      pointedAt: labelled ? document.getElementById(labelled)?.textContent.trim() ?? null : null,
    };
  })
);
out.yearChips = await page.$$eval('#yearFilter button', (nodes) => nodes.map((n) => n.textContent.trim()));

// ── the two kinds of window, measured against each other ────────────────────────────────
const rowsFor = async (label) => {
  await page.$$eval(
    '#seenFilter button',
    (nodes, wanted) => {
      const hit = nodes.find((n) => n.textContent.trim() === wanted);
      if (hit) hit.click();
    },
    label
  );
  await page.waitForTimeout(300);
  return {
    label,
    rows: await page.$$eval('#typeList .typerow', (n) => n.length),
    bite: (await page.$eval('#filterNote', (n) => n.textContent)).match(/Nothing is hidden[^.]*\.|This window is hiding \d+ types[^.]*\./)?.[0] ?? null,
    how: (await page.$eval('#filterNote', (n) => n.textContent)).match(/A type is shown when[^.]*\./)?.[0]?.slice(0, 150) ?? null,
  };
};
out.windows = [];
for (const label of ['All flights', '5 minutes', 'last hour', 'last 12 hours', 'today', 'this year']) {
  out.windows.push(await rowsFor(label));
}

// 🔴 A QUIET FENCE MUST NOT ABORT THE PROBE. Measured 20 Sep 2026, 17:47: the feed answered with
// exactly one aircraft (a C206) and the type list did not yet contain its type, so starring every
// row still showed an empty table. That is correct page behaviour — the list is built from what the
// survey caught, and a live type only joins it once this session has seen one — but it stopped the
// measurements below from running at all. So the positive case is recorded rather than asserted on.
await page.$$eval('#typeList .typerow .type-toggle', (nodes) => {
  for (const node of nodes) node.click();
});
out.rowsAppeared = await page
  .waitForSelector('#aircraftBody tr.aircraft-row', { timeout: 60_000 })
  .then(() => true)
  .catch(() => false);
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

// ── the bell arms alerts WITHOUT starring, and the search finds a place by name ────────
// Reload for a clean slate, then arm the bell on one type and check the star stayed off.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.$eval('#consentDecline', (el) => el.click()).catch(() => {});
await page.click('#radiusButtons button[data-km="25"]');
await page.waitForSelector('#typeList .typerow', { timeout: 30_000, state: 'attached' });
// 🔴 THE STAR COUNT BEFORE THE BELL, BECAUSE THE SECTION ABOVE STARRED EVERYTHING AND
// localStorage SURVIVES THE RELOAD. Measured the first time: 59 stars pressed after a bell
// click, which reads as "the bell starred everything" and was this probe's own dirty state.
const starsBeforeBell = await page.$$eval('.star[aria-pressed="true"]', (n) => n.length);
await page.$eval('#typeList .typerow .alert-toggle', (el) => el.click());
await page.waitForTimeout(400);
out.bellsAfterOneClick = await page.$$eval('.bell[aria-pressed="true"]', (n) => n.length);
out.starsBeforeBell = starsBeforeBell;
out.starsAfterBellClick = await page.$$eval('.star[aria-pressed="true"]', (n) => n.length);
out.notifyNoteAfter = await text('#notifyNote');
// And the table must NOT have gained a row from arming an alert: the bell is not a selection.
out.rowsAfterBellOnly = await page.$$eval('#aircraftBody tr.aircraft-row', (n) => n.length);
// A second press widens a narrowed bell, a third turns it off.
await page.$eval('#typeList .typerow .alert-toggle', (el) => el.click());
await page.waitForTimeout(300);
out.bellsAfterSecondClick = await page.$$eval('.bell[aria-pressed="true"]', (n) => n.length);

// The place search, driven the way a reader drives it. "Change location" first, because the
// page deliberately hides the whole ask once it knows where you are — measured: filling the box
// straight after the reload times out on "element is not visible".
await page.$eval('#changePlace', (el) => el.click());
await page.waitForTimeout(400);
await page.fill('#placeSearchInput', 'Stoney Creek Ontario');
await page.press('#placeSearchInput', 'Enter');
await page.waitForSelector('#placeResults .place-result', { timeout: 30_000 });
out.searchResults = await page.$$eval('#placeResults .place-result', (nodes) => nodes.map((n) => n.textContent.trim()));
out.searchNote = await text('#placeSearchNote');
await page.$eval('#placeResults .place-result', (el) => el.click());
await page.waitForTimeout(1500);
out.locationAfterSearch = await text('#placeName');
out.nearbyAfterSearch = await text('#nearbyHead');
out.rowsInSearchResult = await page.$$eval('#placeResults .place-result', (n) => n.length);

// ── 1 (previous message) · find me names the place ──────────────────────────────────────
await page.$eval('#changePlace', (el) => el.click()).catch(() => {});
await page.waitForTimeout(400);
await page.$eval('#locateBtn', (el) => el.click()).catch(() => {});
await page.waitForTimeout(4000);
out.locationAfterFindMe = await text('#placeName');
out.locateNote = await text('#locateNote');

console.log(JSON.stringify(out, null, 2));
await browser.close();
