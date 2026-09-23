/**
 * live-check.mjs — what a VISITOR actually receives, from the deployed host.
 *
 * House standard part 6: this is the third kind of test, and it is separate from
 * `test:e2e` on purpose. `test:e2e` must stay runnable offline against its own
 * build, and a local build cannot prove what a visitor gets — a site with a
 * deploy workflow can serve a stale artefact, and a site published by hand can
 * serve a month-old one. On 19 Sep 2026 the served copy of password-please was a
 * month old and predated the cookie gate entirely. Nothing else would have
 * caught that.
 *
 * Usage:  node tools/live-check.mjs [https://host/]
 *         npm run test:live
 */

import { chromium } from 'playwright';

const DEFAULT_HOST = 'https://airplane-watch.nodejavascript.com/';
const HOST = process.argv[2] || DEFAULT_HOST;
const EXPECTED_TITLE = new URL(HOST).host;
const EXPECTED_THEME = '#38bdf8';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function head(url) {
  try {
    const response = await fetch(url, { redirect: 'manual' });
    return { status: response.status, headers: response.headers };
  } catch (error) {
    return { status: 0, headers: new Headers(), error: error.message };
  }
}

console.log(`\nlive check against ${HOST}\n`);

/* -------------------------------------------------------------- the shell --- */

const shell = await fetch(HOST).then(
  async (response) => ({ status: response.status, headers: response.headers, body: await response.text() }),
  (error) => ({ status: 0, headers: new Headers(), body: '', error: error.message })
);

check('the host answers 200', shell.status === 200, `got ${shell.status} ${shell.error || ''}`);
check(
  'the shell says no-store, so a deploy is visible',
  /no-store/.test(shell.headers.get('cache-control') || ''),
  `cache-control: ${shell.headers.get('cache-control') || '(none)'}`
);
check('the Google tag is NOT in the served HTML', !/googletagmanager/i.test(shell.body));
check('consent.js is in the served HTML', /consent\.js/.test(shell.body));
// 🔴 COMMENTS COME OUT FIRST, BECAUSE THE PAGE EXPLAINS ITS OWN RULES AND THE EXPLANATION NAMES THEM.
// This check failed on a page that is exactly right: `index.html` carries a note reading *"There is NO
// privacy.html anywhere — the policy is a #privacy section of the page itself"*, and a bare substring
// search over the whole document matched **the sentence stating the rule**. The same fault stopped the
// deploy script's own Analytics gate an hour earlier, where the placeholder id appeared only inside the
// comment describing the gate. **A check that searches a whole document for a string matches the prose
// that describes the string** — so the two checks below read what the browser is given to render.
const rendered = shell.body.replace(/<!--[\s\S]*?-->/g, '');
check('there is no privacy.html in the served HTML', !/privacy\.html/i.test(rendered));
check('the served HTML has no link ending in .html', !/href="[^"]*\.html?"/i.test(rendered));
check('there is no www form of this host in the served HTML', !new RegExp(`www\\.${EXPECTED_TITLE.replace(/\./g, '\\.')}`, 'i').test(shell.body));

const assets = await Promise.all(
  ['/consent.js', '/app.js', '/detect.js', '/styles.css', '/favicon.svg', '/favicon-32.png', '/favicon.ico', '/apple-touch-icon.png', '/manifest.webmanifest', '/robots.txt', '/sitemap.xml'].map(
    async (path) => [path, await head(new URL(path, HOST).href)]
  )
);
for (const [path, result] of assets) {
  check(`${path} answers 200`, result.status === 200, `got ${result.status}`);
}

/* --------------------------------------------------------- in a real Chrome --- */

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
const page = await context.newPage();

const googleRequests = [];
page.on('request', (request) => {
  if (/google|gstatic|googleapis/i.test(request.url())) googleRequests.push(request.url());
});

try {
  await page.goto(HOST, { waitUntil: 'load', timeout: 30_000 });

  check('the title IS the host', (await page.title()) === EXPECTED_TITLE, `title is "${await page.title()}"`);

  const themeMeta = await page.$eval('meta[name="theme-color"]', (element) => element.content);
  check(`the theme colour is ${EXPECTED_THEME}`, themeMeta.toLowerCase() === EXPECTED_THEME, `got ${themeMeta}`);

  const h1Count = await page.$$eval('h1', (items) => items.length);
  check('exactly one <h1>', h1Count === 1, `found ${h1Count}`);

  const headerOk = await page.evaluate(() => {
    const header = document.querySelector('header');
    if (!header) return { ok: false, why: 'no header' };
    const brand = header.querySelector('a.brand');
    if (!brand) return { ok: false, why: 'no brand link' };
    if (new URL(brand.href).pathname !== '/') return { ok: false, why: `brand goes to ${brand.href}` };
    if (header.querySelector('nav')) return { ok: false, why: 'the header carries a nav' };
    return { ok: true };
  });
  check('the header is the brand bar, brand to self, no nav', headerOk.ok, headerOk.why || '');

  // 🔴 THE VALUE IS PASSED IN, BECAUSE A BROWSER CANNOT SEE A NODE VARIABLE. This callback read
  // `EXPECTED_TITLE` directly, which exists only in this process — so the browser threw
  // `ReferenceError: EXPECTED_TITLE is not defined`, the throw escaped the script, and **every check
  // after it never ran**: the footer, the consent gate and the Google-request assertions were all
  // silently skipped while the run reported "2 failed". Measured on the first live run, 22 Sep 2026.
  const footerOk = await page.evaluate((host) => {
    const footer = document.querySelector('footer.site-footer');
    if (!footer) return { ok: false, why: 'no footer' };
    const home = footer.querySelectorAll('a[href="https://nodejavascript.com/"]').length;
    const privacy = footer.querySelector('a[href="#privacy"]');
    const door = footer.querySelector('#consentBtn');
    const copy = footer.querySelector('.footer-copy');
    if (home !== 1) return { ok: false, why: `${home} mother-site links` };
    if (!privacy) return { ok: false, why: 'no #privacy link' };
    if (!door) return { ok: false, why: 'no cookie door' };
    if (!copy || !copy.textContent.includes(host))
      return { ok: false, why: 'copyright does not carry the full domain' };
    if (/back to top/i.test(footer.textContent)) return { ok: false, why: 'Back to top is present' };
    return { ok: true };
  }, new URL('https://' + EXPECTED_TITLE).host);
  check('the footer is brand · links · copyright, with one home link', footerOk.ok, footerOk.why || '');

  check('the #privacy anchor resolves to a real section', await page.$('#privacy') !== null);

  // The gate, against the deployed page rather than against the source.
  await page.waitForSelector('#consentBar:not([hidden])', { timeout: 10_000 });
  check('nothing is requested from Google before an answer', googleRequests.length === 0, googleRequests.join(', '));
  check('window.gtag does not exist before an answer', (await page.evaluate(() => typeof window.gtag)) === 'undefined');

  const answers = await page.$$eval('.consentActions button', (buttons) =>
    buttons.map((button) => {
      const style = getComputedStyle(button);
      return { label: button.textContent.trim(), width: button.getBoundingClientRect().width, weight: style.fontWeight };
    })
  );
  check('there are two answers', answers.length === 2, `found ${answers.length}`);
  if (answers.length === 2) {
    check(
      'the two answers are the same size and weight',
      Math.abs(answers[0].width - answers[1].width) < 1.5 && answers[0].weight === answers[1].weight,
      JSON.stringify(answers)
    );
  }

  await page.$eval('#consentDecline', (element) => element.click());
  await page.waitForTimeout(600);
  check('a refusal makes ZERO requests to Google', googleRequests.length === 0, googleRequests.join(', '));
  check('the answer is remembered', (await page.evaluate(() => localStorage.getItem('analytics_consent'))) === 'denied');
  check('the bar is gone', await page.$eval('#consentBar', (element) => element.hidden));

  // The door, on the deployed page. On a client-rendered site this is the check
  // that catches a bound-not-delegated listener, because the button renders and
  // looks right either way.
  await page.$eval('#consentBtn', (element) => element.click());
  await page.waitForTimeout(200);
  check('the footer door opens the panel', await page.$eval('#consentPrefs', (element) => !element.hidden));

  const panel = await page.$eval('#consentPanel, #consentPrefs', (element) => element.textContent);
  check('the panel does not offer the owner his own switch', !/This device|count my visits/i.test(panel));

  // 🔴 THE CHECK ANSWERS STEP 1, BECAUSE A VISITOR HAS TO. The page deliberately draws no airport list
  // until it knows where the reader is — George's rule: *"if you dont know location, there should be no
  // airports seen"* — so a fresh visit has no chips, no map marks and makes no call to the feed. The old
  // version waited for the airport title, which no longer exists, and threw. **A live check that never
  // gets past the first screen is not checking the demo**, so this drives the place search the way a
  // visitor does: type a place, submit, press the suggestion, and then wait for the list and the map.
  await page.fill('#placeSearchInput', 'Hamilton');
  await page.press('#placeSearchInput', 'Enter');
  await page.waitForSelector('#placeResults .near-chip, #placeResults button', { timeout: 15_000 });
  const suggested = await page.$eval('#placeResults button, #placeResults .near-chip', (element) => {
    element.click();
    return element.textContent.trim();
  });
  check('the place search answered from this site\'s own server', typeof suggested === 'string', suggested);

  // 🔴 WHAT "THE DEMO WORKS" MEANS, AND WHY THE FEED'S OWN REFUSAL IS NOT A FAILURE.
  //
  // A visitor answers step 1 and the page then asks a volunteer-funded feed for the aircraft inside their
  // fence. Measured on this site's first live run (22 Sep 2026): the place search answered
  // `200 /api/geo/search?q=Hamilton` with six places, pressing one loaded **14 airport chips** and the
  // note *"76 airports, each one confirmed by asking the feed where it is"*, and the map fetched its
  // tiles — and then the feed answered **429**, because a few page loads in a few minutes is more than it
  // will take from one address. The page said so in plain words: *"The feed asked us to slow down (HTTP
  // 429)…"*.
  //
  // **A check that fails because a volunteer service said "slow down" is a false failure, and a false
  // failure teaches the reader to ignore the check.** So the wait accepts either proof that data arrived
  // or the page's own honest report that it was refused — and fails only when NEITHER happened, which is
  // what a broken page looks like.
  //
  // ⚠️ AND IT MUST NOT WAIT ON `#fenceFrom` BEING VISIBLE. That caption is HIDDEN when the circle is
  // centred on the reader — deliberately, because the heading above it already says "How far out from
  // you?" — so waiting for it to appear waits for something the correct page will never show.
  await page.waitForFunction(
    () => {
      const chips = document.querySelectorAll('.near-chip').length;
      if (chips === 0) return false;
      const marks = document.querySelectorAll('svg.locmap .locmap-plane-mark, svg.locmap .locmap-airport, svg.locmap .locmap-you').length;
      const status = document.getElementById('status')?.textContent ?? '';
      return marks > 0 || /slow down|429|rate/i.test(status);
    },
    null,
    { timeout: 45_000 }
  );
  const resolved = await page.evaluate(() => ({
    status: document.getElementById('status')?.textContent.trim() ?? '',
    chips: document.querySelectorAll('.near-chip').length,
    map: document.querySelectorAll('svg.locmap .locmap-plane-mark, svg.locmap .locmap-airport, svg.locmap .locmap-you').length,
    place: document.getElementById('placeName')?.textContent.trim() ?? '',
    note: document.getElementById('nearbyNote')?.textContent.trim().slice(0, 80) ?? '',
  }));
  check('the airports around the reader are listed, from the feed\'s own answers',
    resolved.chips > 0 && /airports?, each one confirmed/i.test(resolved.note),
    `${resolved.chips} chips for ${resolved.place} — ${resolved.note}`);
  // Either the map has something on it, or the page said out loud why it does not.
  const refused = /slow down|429|rate/i.test(resolved.status);
  check('the map is drawn, or the page says the feed refused it',
    resolved.map > 0 || refused,
    refused ? `feed refused — the page says so: ${resolved.status.slice(0, 90)}` : `${resolved.map} marks`);

  const painted = await page.evaluate(() => {
    const layer = document.querySelector('.dvs-pattern');
    if (!layer) return null;
    const style = getComputedStyle(layer);
    return style.backgroundImage;
  });
  check('the abstract is painted on the deployed page', !!painted && /gradient/.test(painted));
} catch (error) {
  failed += 1;
  console.log(`  FAIL the live check threw — ${error.message}`);
}

await browser.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
