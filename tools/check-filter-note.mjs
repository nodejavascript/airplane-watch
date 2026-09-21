/**
 * Read the type-list note as the reader sees it, in every filter mode.
 *
 * The note has one builder with four branches — rolling, calendar, all, no-data — and the
 * count now has to come after the filtering in all of them. A grep of the source would pass on
 * a branch that never renders, so the page is driven and each mode is clicked.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4340';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(BASE, { waitUntil: 'load' });
if (await page.$('#consentDecline')) await page.$eval('#consentDecline', (e) => e.click());

// Answer step 1 so step 3 exists at all — it is gated.
await page.fill('#placeSearchInput', 'Stoney Creek Ontario');
await page.$eval('#placeSearchForm button[type="submit"]', (e) => e.click());
await page.waitForSelector('#placeResults .place-result');
await page.$eval('#placeResults .place-result', (e) => e.click());
await page.waitForTimeout(1200);

const out = {};

/** The note, plus the count under the list, which must not disagree with it. */
async function read() {
  return {
    note: await page.$eval('#filterNote', (el) => el.innerText.replace(/\s+/g, ' ').trim()),
    underList: await page.$eval('#typeList > p:last-child', (el) => el.innerText.replace(/\s+/g, ' ').trim()),
  };
}

// Every seen-filter chip, by its own label.
const chips = await page.$$eval('#seenFilter button', (items) =>
  items.map((item) => item.textContent.trim())
);

for (const label of chips) {
  await page.$$eval(
    '#seenFilter button',
    (items, wanted) => {
      const chip = items.find((item) => item.textContent.trim() === wanted);
      if (chip) chip.click();
    },
    label
  );
  await page.waitForTimeout(250);
  out[label] = await read();
}

out.pageErrors = errors;
console.log(JSON.stringify(out, null, 2));
await browser.close();

// ── the checks ────────────────────────────────────────────────────────────────
const faults = [];
for (const [label, text] of Object.entries(out)) {
  if (label === 'pageErrors') continue;
  const note = text.note ?? '';

  // The count must be in the LAST sentence, after the filtering, not at the front.
  const showing = note.indexOf('Showing ');
  if (showing === -1) {
    faults.push(`"${label}": the note states no count at all`);
  } else {
    const after = note.slice(showing);
    if (!/^Showing \d+ of \d+ type/.test(after)) faults.push(`"${label}": the count is malformed: ${after}`);
    // Nothing may follow the count except its own final full stop.
    if (!/^Showing \d+ of \d+ types?\.$/.test(after.trim())) {
      faults.push(`"${label}": something is printed after the count: ${after.trim()}`);
    }
  }

  // And the two counts must agree — the same number in two places is only acceptable if equal.
  const inNote = (note.match(/Showing (\d+) of (\d+)/) ?? []).slice(1).join('/');
  const below = (text.underList.match(/Showing (\d+) of (\d+)/) ?? []).slice(1).join('/');
  if (inNote && below && inNote !== below) {
    faults.push(`"${label}": the note says ${inNote} and the line under the list says ${below}`);
  }

  // 🔴 AND NOTHING INSIDE THE NOTE MAY CONTRADICT THE COUNT IT ENDS WITH. This is the check
  // that caught the real defect on 20 Sep 2026: the no-data branch read *"59 types are in this
  // state and shown below"* while the same paragraph ended *"Showing 0 of 129 types."* — because
  // that branch counted the types the filter DROPPED, which in this mode are the ones NOT in the
  // state. A sentence that disagrees with the number beside it is worse than no sentence.
  const shown = Number((note.match(/Showing (\d+) of \d+/) ?? [])[1]);
  if (Number.isFinite(shown)) {
    const claims = [...note.matchAll(/(\d+) types? (?:are in this state|is in this state)/g)].map((m) => Number(m[1]));
    for (const claim of claims) {
      if (claim !== shown) {
        faults.push(`"${label}": the note claims ${claim} types are in this state but ends by showing ${shown}`);
      }
    }
    const hiding = [...note.matchAll(/hiding (\d+) types?/g)].map((m) => Number(m[1]));
    for (const hidden of hiding) {
      // Hidden + shown must account for every type the page can name, once the other reasons are
      // added — so hidden can never exceed the total.
      const total = Number((note.match(/Showing \d+ of (\d+)/) ?? [])[1]);
      if (hidden + shown > total) {
        faults.push(`"${label}": hiding ${hidden} plus showing ${shown} exceeds the ${total} the page can name`);
      }
    }
  }

  // The sentences George asked to be cut must not have come back.
  if (/not a choice worth making/.test(note)) faults.push(`"${label}": the trailing homily is still there`);
  if (/Wikidata/.test(note) && !/could not be read/.test(note)) {
    faults.push(`"${label}": the year provenance paragraph is back in the note`);
  }
}
if (out.pageErrors.length) faults.push(`page errors: ${out.pageErrors.join(' | ')}`);

if (faults.length) {
  console.log('\nFAULTS:');
  for (const fault of faults) console.log(' -', fault);
  process.exit(1);
}
console.log('\nTHE COUNT ENDS THE NOTE IN EVERY MODE, AND THE TWO COUNTS AGREE');
