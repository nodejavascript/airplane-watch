/**
 * static.test.js — what only READING can settle.
 *
 * House standard part 6: a unit suite earns its place on the things behaviour
 * cannot show — that the Google tag is not in the page, that the title IS the
 * host, that the footer door is delegated rather than bound. The end-to-end
 * suite proves behaviour; this one proves the shape.
 *
 * 🔴 COMMENTS ARE STRIPPED BEFORE ANY CODE IS READ, AND THAT IS NOT TIDINESS.
 * On 19 Sep 2026 four checks in this family were written wrong and every one of
 * them reported a failure against code that was correct. One counted `<h1>` in
 * the raw source and found three, because the file's own COMMENTS discuss
 * `<h1>`. A false failure is the expensive kind: it teaches the reader to
 * distrust the gate, and then a real failure is ignored. So the helpers below
 * strip comments first, and every pattern is run against the artefact the test
 * actually opens.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SITE = join(ROOT, 'site');

const HOST = 'aircraft-demo.nodejavascript.com';
const THEME = '#38bdf8';
const BACKGROUND = '#04101a';

const read = (...parts) => readFileSync(join(...parts), 'utf8');

/** Strip /* *\/ and // from JavaScript, so a comment cannot fail a code check. */
function stripJs(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Strip <!-- --> from HTML, for the same reason. */
function stripHtml(source) {
  return source.replace(/<!--[\s\S]*?-->/g, '');
}

const html = read(SITE, 'index.html');
const htmlCode = stripHtml(html);
const css = read(SITE, 'styles.css');
const consentJs = stripJs(read(SITE, 'consent.js'));
const appJs = stripJs(read(SITE, 'app.js'));
const detectJs = stripJs(read(SITE, 'detect.js'));

/* --------------------------------------------------------- part 1 · title --- */

test('1 · the title IS the host — equality, not containment', () => {
  const match = htmlCode.match(/<title>([^<]*)<\/title>/);
  assert.ok(match, 'there is no <title>');
  // `title.includes(host)` is what let a half-right version ship once: a title
  // that CONTAINED the host passed while the title was a marketing sentence.
  assert.equal(match[1].trim(), HOST);
});

test('1 · og:site_name is the host as well', () => {
  assert.match(htmlCode, new RegExp(`<meta property="og:site_name" content="${HOST}"`));
});

/* ------------------------------------------------------ part 1b · no .html --- */

test('1b · no href on the page ends in .html', () => {
  const hrefs = [...htmlCode.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  const bad = hrefs.filter((href) => /\.html?$/i.test(href));
  assert.deepEqual(bad, [], `these hrefs end in .html: ${bad.join(', ')}`);
});

test('1b · the sitemap lists no .html URL', () => {
  const sitemap = read(SITE, 'sitemap.xml');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.ok(locs.length > 0, 'the sitemap lists nothing');
  assert.deepEqual(locs.filter((loc) => /\.html?$/i.test(loc)), []);
});

/* ----------------------------------------------- part 2 · the cookie gate --- */

test('2 · NOTHING from Google is in the page', () => {
  // Not even in a comment — the file must not carry the tag in any form, and
  // this is checked on the RAW source for exactly that reason.
  assert.equal(/googletagmanager/i.test(html), false, 'the page mentions googletagmanager');
  assert.equal(/gtag\s*\(/.test(htmlCode), false, 'the page calls gtag directly');
});

test('2 · the measurement id rides on the consent script, not on the page', () => {
  assert.match(htmlCode, /<script src="\.\/consent\.js" data-ga-id="[^"]+" defer><\/script>/);
});

test('2 · consent.js is never looked up by the footer door — the door is DELEGATED', () => {
  // The wrong version binds `#consentBtn` once as the script runs. It works on a
  // static footer and fails on a React footer, where no listener is ever
  // attached: the button renders, looks right in every screenshot, and does
  // nothing. A delegated gate therefore has no reason to look the door up by id,
  // and its absence is the assertion.
  assert.equal(
    /getElementById\(\s*['"]consentBtn['"]\s*\)/.test(consentJs),
    false,
    'consent.js looks up #consentBtn by id, so the door cannot be delegated'
  );
  assert.match(consentJs, /closest\?\.\(\s*['"]#consentBtn['"]\s*\)/, 'the delegated door is missing');
});

test('2 · the panel names ONE choice and does NOT offer the owner his own switch', () => {
  // George, 19 Sep 2026: *"new rule i dont want count my visits in the cookie
  // settings"*. `?ga=off` still works from the address bar; it is not surfaced
  // to a visitor.
  assert.equal(/consentDeviceRow/.test(htmlCode), false, 'the banned "This device" row is in the page');
  assert.equal(/countToggle/.test(htmlCode), false, 'the banned owner toggle is in the page');
  assert.equal(/countToggle|consentDeviceRow/.test(consentJs), false, 'the banned owner switch is still in the gate');
  // …but the owner's address-bar switch must still exist, or the rule has been
  // obeyed by deleting the feature rather than by hiding it.
  assert.match(consentJs, /'ga'/, 'the ?ga= switch is gone entirely');
  assert.match(consentJs, /ga_opt_out/);
});

test('2 · [hidden] wins over a class that declares display', () => {
  // The gate swaps the question for the panel by setting `.hidden`, and the
  // user-agent rule for `[hidden]` is a DEFAULT — any author rule overrides it,
  // so `.consentAsk { display: flex }` kept the question on screen underneath
  // its own settings panel. Readable in behaviour, invisible in a screenshot.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'the global [hidden] rule is missing');
});

test('2 · the bar reserves its height on <body>, not inside the footer', () => {
  // Padding is INSIDE the box, so padding on the footer does not lift the
  // footer's own bottom edge clear of a bar fixed to the bottom of the window.
  assert.match(css, /body\s*\{[^}]*padding-bottom:\s*var\(--consent-height\)/s);
});

/* ------------------------------------------------------------- part 3 · bar --- */

test('3 · the header is the brand and NOTHING ELSE — no nav', () => {
  const header = htmlCode.match(/<header[\s\S]*?<\/header>/);
  assert.ok(header, 'there is no <header>');
  assert.equal(/<nav[\s>]/.test(header[0]), false, 'the header carries a nav');
  assert.match(header[0], /class="brand"/);
});

test('3 · the brand goes to THIS SITE, not to nodejavascript.com', () => {
  const header = htmlCode.match(/<header[\s\S]*?<\/header>/)[0];
  const brandHref = header.match(/<a class="brand" href="([^"]*)"/);
  assert.ok(brandHref, 'the brand is not a link');
  assert.equal(brandHref[1], '/', 'the brand points somewhere other than this site');
  assert.equal(/nodejavascript\.com/.test(header.replace(/<small>[\s\S]*?<\/small>/g, '')), false);
});

test('3 · the mark, the label and the parent name are all in the bar', () => {
  const header = htmlCode.match(/<header[\s\S]*?<\/header>/)[0];
  assert.match(header, /class="mark"/);
  assert.match(header, /<b>aircraft-demo<\/b>/);
  assert.match(header, /<small>nodejavascript\.com<\/small>/);
});

/* ---------------------------------------------------------- part 4 · footer --- */

test('4 · the footer has three lines in order: brand, links, copyright', () => {
  const footer = htmlCode.match(/<footer[\s\S]*?<\/footer>/);
  assert.ok(footer, 'there is no <footer>');
  const order = ['footer-brand', 'footer-links', 'footer-copy'].map((name) => footer[0].indexOf(name));
  assert.ok(order.every((index) => index !== -1), 'a footer line is missing');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the footer lines are out of order');
});

test('4 · the mother-site link appears EXACTLY ONCE, on the brand line', () => {
  // George, 19 Sep 2026: *"there is too much redunderncy here … i like the top
  // line, the second line remove nodejavascript between privacy and cookie
  // settings"*.
  const footer = htmlCode.match(/<footer[\s\S]*?<\/footer>/)[0];
  const links = [...footer.matchAll(/<a[^>]*href="https:\/\/nodejavascript\.com\/"[^>]*>/g)];
  assert.equal(links.length, 1, `the mother-site link appears ${links.length} times`);
  const brandLine = footer.slice(0, footer.indexOf('footer-links'));
  assert.match(brandLine, /nodejavascript\.com/, 'the mother-site link is not on the brand line');
});

test('4 · the copyright carries the full domain name', () => {
  assert.match(htmlCode, new RegExp(`© 2026 ${HOST.replace(/\./g, '\\.')}\\.`));
});

test('4 · the privacy link is an in-page #privacy anchor and the section exists', () => {
  assert.match(htmlCode, /<a href="#privacy">Privacy<\/a>/);
  assert.match(htmlCode, /<section class="card" id="privacy">/);
});

test('4 · NO privacy page exists anywhere in the repository', () => {
  // George, 19 Sep 2026, verbatim: *"i dont like privacy html anywhere remember
  // that for the rules"*. The policy is a section of the page it belongs to.
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name === '.git') return [];
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
  const bad = walk(ROOT).filter((path) => /privacy.*\.(html?|md)$/i.test(path));
  assert.deepEqual(bad, [], `a privacy page exists: ${bad.join(', ')}`);
});

test('4 · the cookie door is in the footer', () => {
  assert.match(htmlCode, /<button id="consentBtn"[^>]*>Cookie settings<\/button>/);
});

test('4 · NO "Back to top" anywhere', () => {
  // George, 19 Sep 2026: *"remeber this, to remove · back to top from footers"*.
  assert.equal(/back to top/i.test(htmlCode), false);
});

/* ------------------------------------------------------ part 5 · identity --- */

test('5 · the theme colour is the declared, unique value', () => {
  assert.match(htmlCode, new RegExp(`<meta name="theme-color" content="${THEME}"`));
  assert.match(css, new RegExp(`--theme:\\s*${THEME}`));
});

test('5 · the background is the declared, unique value', () => {
  assert.match(css, new RegExp(`--bg:\\s*${BACKGROUND}`));
  assert.match(css, /background-color:\s*var\(--bg\)/);
});

test('5 · the background image is ONE radial plus TWO linear — a count nothing else has', () => {
  const body = css.match(/^body\s*\{[\s\S]*?\n\}/m);
  assert.ok(body, 'no body rule');
  assert.match(body[0], /background-image:/);
  const radial = (body[0].match(/radial-gradient\(/g) || []).length;
  const linear = (body[0].match(/linear-gradient\(/g) || []).length;
  const conic = (body[0].match(/conic-gradient\(/g) || []).length;
  assert.equal(radial, 1, `expected one radial gradient, found ${radial}`);
  assert.equal(linear, 2, `expected two linear gradients, found ${linear}`);
  assert.equal(conic, 0, 'a conic step is a band, which is the thing that was rejected');
});

test('5d-ii · the abstract is the page\u2019s OWN geometry, and it FADES', () => {
  // A gradient wash is not a drawing: nine of ten sites in this family passed
  // part 5d for weeks while painting no geometry at all.
  const layer = htmlCode.match(/<div class="dvs-pattern"[^>]*><\/div>/);
  assert.ok(layer, 'the abstract layer is not in the page');

  const rule = css.match(/\.dvs-pattern\s*\{[\s\S]*?\n\}/);
  assert.ok(rule, '.dvs-pattern has no rule');
  assert.match(rule[0], /position:\s*fixed/);
  assert.match(rule[0], /pointer-events:\s*none/);
  assert.match(rule[0], /repeating-conic-gradient\(/, 'the geometry must REPEAT — bearing ticks do');
  // It must be masked, and both spellings, or Safari paints hard edges.
  assert.match(rule[0], /mask-image:/);
  assert.match(rule[0], /-webkit-mask-image:/);
});

test('5 · the Analytics id does not clash with the family register, when one is readable', () => {
  const registerPath = join(process.env.HOME || '', '.nodejs_theme_register.json');
  if (!existsSync(registerPath)) return; // nothing to compare against; not a failure
  const register = JSON.parse(readFileSync(registerPath, 'utf8'));
  const rows = Array.isArray(register) ? register : register.sites || [];
  if (rows.length === 0) return;

  const clashes = [];
  if (rows.some((row) => String(row.theme).toLowerCase() === THEME)) clashes.push(`theme colour ${THEME}`);
  if (rows.some((row) => String(row.background).toLowerCase() === BACKGROUND)) clashes.push(`background ${BACKGROUND}`);
  const myTexture = '1 radial + 2 linear';
  if (rows.some((row) => String(row.texture).toLowerCase() === myTexture)) clashes.push(`background image (${myTexture})`);
  assert.deepEqual(clashes, [], `these are already taken by a live site: ${clashes.join(', ')}`);
});

/* -------------------------------------------------------------- part 6 --- */

test('6 · all three kinds of test exist in the repository', () => {
  for (const path of ['test/detect.test.js', 'test/static.test.js', 'test/e2e.test.js']) {
    assert.ok(existsSync(join(ROOT, path)), `missing ${path}`);
  }
  assert.ok(
    existsSync(join(ROOT, 'tools/live-check.mjs')),
    'missing the live check — a local build cannot prove what a visitor receives'
  );
});

/* --------------------------------------------------- the deploy-time gate --- */

test('the Analytics id is REAL — this site cannot be deployed without its own property', () => {
  // 🔴 THIS TEST IS MEANT TO FAIL UNTIL THE SITE GOES LIVE, AND IT IS A GATE, NOT
  // A BUG. House rule parts 5c and 7a: the Analytics property is created on the
  // day the site goes live, together with the DNS record. This demo has no
  // hostname yet, so it has no property yet, and `G-PENDING` is honest.
  //
  // What it stops is a site that gets deployed and quietly never gets a
  // property: `npm test` runs inside `npm run deploy`, so the deploy cannot
  // complete while the id is a placeholder. Fix it by creating the GA4 property
  // in the `mcp` account (84487458), named with the FULL domain, and pasting its
  // measurement id into site/index.html.
  const id = htmlCode.match(/data-ga-id="([^"]+)"/)[1];
  assert.match(id, /^G-[A-Z0-9]{10}$/, `"${id}" is a placeholder — create the GA4 property at deploy time`);
});

/* ------------------------------------------------- what must NOT have crept in --- */

test('no response is parsed blind — every fetch goes through readJson', () => {
  // A bare `response.json()` trusts the other end to be the feed. The moment
  // anything answers in front of it, the reader gets a JavaScript parser
  // complaint in place of the sentence written for them. That is exactly what
  // happened on rag-demo on 19 Sep 2026, and it is checked on the BUILT code,
  // because that is what a browser runs.
  assert.match(appJs, /async function readJson/);
  assert.equal(
    /\.json\(\)/.test(appJs.replace(/JSON\.parse|readJson[\s\S]{0,200}/g, '')),
    false,
    'app.js calls .json() directly somewhere'
  );
});

test('the proxy never answers 502 — the edge would delete the body', () => {
  const worker = stripJs(read(ROOT, 'worker', 'index.js'));
  assert.equal(/502/.test(worker), false, 'the worker can answer 502, whose body Cloudflare destroys');
  assert.match(worker, /503/);
});

test('production does NOT send a wildcard CORS header', () => {
  // Same-origin needs none, and a wildcard would make this Worker an open relay
  // for anybody's browser to spend the feed's bandwidth through. The local dev
  // server sends one on purpose; production must not.
  const worker = stripJs(read(ROOT, 'worker', 'index.js'));
  assert.equal(/access-control-allow-origin/i.test(worker), false, 'the worker sends a CORS header');
});

test('the dev server is on the reserved port and knows the DNS rule', () => {
  const serve = stripJs(read(ROOT, 'tools', 'serve.mjs'));
  assert.match(serve, /4340/);
  // 8080 is PM2's, and nine of this machine's own scripts sat on it by accident.
  assert.equal(/8080/.test(serve), false, 'something defaults to port 8080, which PM2 owns');
});

test('the theme colour in the stylesheet and the manifest agree', () => {
  const manifest = JSON.parse(read(SITE, 'manifest.webmanifest'));
  assert.equal(manifest.theme_color, THEME);
  assert.equal(manifest.background_color, BACKGROUND);
});

test('robots.txt carries the Sitemap line', () => {
  const robots = read(SITE, 'robots.txt');
  assert.match(robots, new RegExp(`^Sitemap: https://${HOST.replace(/\./g, '\\.')}/sitemap\\.xml$`, 'm'));
});

test('there is NO www anywhere in this site\u2019s own material', () => {
  // The rule governs OUR hostnames, never the string — so this looks for a www
  // form OF OUR DOMAIN, not for the word.
  const offenders = ['site/index.html', 'site/sitemap.xml', 'site/robots.txt', 'site/manifest.webmanifest']
    .map((path) => read(ROOT, path))
    .join('\n');
  assert.equal(/www\.nodejavascript\.com/i.test(offenders), false);
});

test('detect.js ships as plain JavaScript the browser can run', () => {
  // The page is a static site; `site/*.js` is GENERATED by tsc from `src/*.ts`,
  // and the unit tests import the generated file. If the build did not run, the
  // tests would pass against a file that does not exist.
  assert.match(detectJs, /export function phaseOf/);
  assert.match(detectJs, /export class DetectionEngine/);
});

/* ------------------------------------------------- kilometres, not nm --- */

test('the reader is offered KILOMETRES, and never the word "nm"', () => {
  // "nobody understand nm" — George, 20 Sep 2026. A nautical mile is an aviation
  // unit and a visitor arriving here is not obliged to know one, so distances the
  // READER MEETS are in km. The word may appear in a comment explaining the
  // conversion, which is why the comments are stripped first.
  const visible = htmlCode + css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/\bnm\b/.test(htmlCode), false, 'the page shows "nm" to the reader');
  assert.match(htmlCode, /\bkm\b/, 'no distance in kilometres anywhere on the page');
  assert.match(htmlCode, /kilometres/, 'the page never says the distances are kilometres');
  assert.ok(visible.length > 0);
});

test('the type section exists and says the list is measured, not remembered', () => {
  // ⚠️ TOLERANT OF THE REST OF THE TAG, because the section carries its step class and its
  // hidden state as well — a pattern demanding `class="card"` exactly failed a correct page.
  assert.match(htmlCode, /<section[^>]*class="[^"]*\bcard\b[^"]*"[^>]*id="step-3"/);
  assert.match(htmlCode, /id="typeList"/);
  assert.match(htmlCode, /id="typeFilter"/);
  assert.match(htmlCode, /measured, not remembered/i);
});

test('what you are watching is its own section, and tail numbers are optional', () => {
  assert.match(htmlCode, /<section[^>]*class="[^"]*\bcard\b[^"]*"[^>]*id="step-4"/);
  assert.match(htmlCode, /<ul class="watchlist" id="watchList"><\/ul>/);
  assert.match(htmlCode, /Narrow to a tail number/);
});

test('the range limiter is on the page, not hidden behind a wrong number', () => {
  // Measured 20 Sep 2026: seven airports polled back to back had five refused by
  // the third round. Hiding that behind "0 aircraft" would be a lie about a rate
  // limit, and the reader would think the sky was empty.
  assert.match(htmlCode, /429/);
  assert.match(appJs, /status === 429/);
  assert.match(appJs, /slow down/);
});

/* ------------------------------------------- the measured type list --- */

test('types.json exists, is honest about its method, and is not empty', () => {
  const path = join(SITE, 'types.json');
  assert.ok(existsSync(path), 'site/types.json is missing — run: node tools/survey-types.mjs');
  const survey = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(survey.types.length >= 10, `only ${survey.types.length} types were measured`);
  assert.ok(survey.aircraftInspected > 100, 'the sample is too small to call a list');
  // The page shows these words, so they have to be there and they have to be true.
  // The radius is written in the unit the READER chose, which is kilometres — it was nm once,
  // and the page then said so in a unit nobody had asked for.
  assert.match(survey.method, /rounds? of \d+ km/);
  assert.match(String(survey.counted), /sighting/i);
  assert.ok(typeof survey.generated === 'string' && survey.generated.length >= 10);
});

test('every type the survey measured can be NAMED, or is marked unknown on purpose', () => {
  // The page shows a name and a class for each row. A code the table has never
  // heard of must still render — as itself, in the "other" class — rather than
  // being dropped or invented.
  const survey = JSON.parse(readFileSync(join(SITE, 'types.json'), 'utf8'));
  const info = stripJs(readFileSync(join(SITE, 'typeinfo.js'), 'utf8'));
  const unknown = [];
  for (const type of survey.types) {
    if (!new RegExp(`\\b${type.code}:`).test(info)) unknown.push(type.code);
  }
  assert.deepEqual(unknown, [], `these measured types have no name in typeinfo.ts: ${unknown.join(', ')}`);
});

test('the type codes the feed actually sends are the shape the table expects', () => {
  const survey = JSON.parse(readFileSync(join(SITE, 'types.json'), 'utf8'));
  const bad = survey.types.filter((type) => !/^[A-Z0-9]{2,6}$/.test(type.code));
  assert.deepEqual(bad.map((type) => type.code), [], 'a type code is not a plausible ICAO designator');
  // The survey must not have counted a surface vehicle as an aeroplane.
  assert.deepEqual(
    survey.types.filter((type) => ['SERV', 'GRND', 'TWR'].includes(type.code)).map((type) => type.code),
    []
  );
});

/* ============================================ the second round, 20 Sep 2026 ==
 * These read the artefacts the round actually changed. Written, not run, until
 * the deploy — the house rule for this family.
 */

const readSrc = (relative) => stripJs(readFileSync(join(ROOT, relative), 'utf8'));

test('every airport in the list was placed by the feed, and none of them by hand', () => {
  assert.ok(existsSync(join(SITE, 'airports.json')), 'site/airports.json is missing — run tools/verify-airports.mjs');
  const doc = JSON.parse(read(SITE, 'airports.json'));

  assert.ok(Array.isArray(doc.airports) && doc.airports.length > 20, 'the airport list is too short to be useful');
  assert.equal(doc.kept, doc.airports.length, 'kept does not match the number of airports actually written');
  assert.ok(Array.isArray(doc.dropped), 'dropped must be a list, even when it is empty');
  assert.match(doc.method, /feed/i, 'the file must say where the positions came from');

  for (const airport of doc.airports) {
    assert.match(airport.icao, /^[A-Z0-9]{4}$/, `${airport.icao} is not a four-character identifier`);
    assert.equal(typeof airport.name, 'string');
    assert.ok(Number.isFinite(airport.lat) && Math.abs(airport.lat) <= 90, `${airport.icao} has no usable latitude`);
    assert.ok(Number.isFinite(airport.lon) && Math.abs(airport.lon) <= 180, `${airport.icao} has no usable longitude`);
  }

  // A dropped identifier that is still in the file means the tool ran against an
  // older source than the one on disk, which is the kind of drift worth failing.
  const source = readSrc('src/region.ts');
  for (const code of doc.dropped) {
    assert.equal(
      new RegExp(`'${code}'`).test(source),
      false,
      `${code} was dropped by the feed and is still listed in src/region.ts`
    );
  }
});

test('the type list says out loud that its tail numbers are a sample', () => {
  const doc = JSON.parse(read(SITE, 'types.json'));
  assert.ok(Array.isArray(doc.types) && doc.types.length > 10);
  assert.ok(
    typeof doc.registrationsNote === 'string' && /not a fleet list|sample/i.test(doc.registrationsNote),
    'a page offering tail numbers must say they are what identified itself, not a fleet list'
  );

  for (const type of doc.types) {
    assert.ok(Array.isArray(type.registrations), `${type.code} has no registrations array`);
    for (const entry of type.registrations) {
      assert.match(entry.reg, /^[A-Z0-9-]{4,10}$/, `${type.code} carries a registration that is not one: ${entry.reg}`);
      assert.ok(Array.isArray(entry.airports));
    }
  }
});

test('the page has two views and the header still has no nav', () => {
  const html = read(SITE, 'index.html');

  assert.match(html, /id="selectView"/, 'the choosing flow has no container to hide');
  assert.match(html, /id="liveView"[^>]*hidden/, 'the live view must start hidden');
  assert.match(html, /id="liveChart"/, 'the chart has nowhere to draw');
  assert.match(html, /id="liveBody"/, 'the chart has no table under it');
  assert.match(html, /id="nearbyList"/, 'there is nowhere to list nearby airports');
  assert.match(html, /id="locateBtn"/, 'there is no control to ask for a position');

  const switches = html.match(/class="ghost view-switch" data-view="(select|live)"/g) ?? [];
  assert.equal(switches.length, 3, 'expected two switches at the top and one back-link inside the live view');
  assert.equal((html.match(/data-view="live"/g) ?? []).length, 1);
  assert.equal((html.match(/data-view="select"/g) ?? []).length, 2);

  // The status line had to move OUT of a card that was gated, or a feed error
  // would be invisible to a reader who is on the other view.
  const statusIndex = html.indexOf('id="status"');
  assert.ok(statusIndex > -1);
  assert.ok(statusIndex < html.indexOf('id="selectView"'), 'the status line must sit outside both views');
});

test('the live view draws matches from the last reading, never everything', () => {
  const source = readSrc('src/app.ts');

  assert.match(source, /matchedAirborne\(\)/, 'there is no method that picks the aircraft to chart');
  assert.match(source, /this\.engine\.matchOf\(reading\)/, 'the chart must be filtered by the reader\'s own rules');
  assert.match(source, /if \(!match\) continue;/, 'an aircraft that matches nothing would still be drawn');
  assert.match(source, /this\.lastReadings = readings;/, 'the live view must read from the same poll as the board');
  assert.match(source, /alt_baro === 'ground'\) continue;/, 'an aircraft on the ground is not in the air');
  assert.match(source, /row\.km <= 400/, 'there must be a distance filter, with its reason written down');
});

test('nothing on this page is listed by hand', () => {
  const source = readSrc('src/app.ts');
  assert.equal(/RESIDENTS/.test(source), false, 'the hand-written residents layer is back in the page');
  assert.equal(/listed by hand/.test(read(SITE, 'index.html')), false, 'a row still says it was listed by hand');
  assert.equal(/resident-toggle/.test(source), false, 'a hand-listed row is still rendered');
  // 🔴 And it is gone from the source of truth too, not merely unused.
  assert.equal(/export const RESIDENTS/.test(readSrc('src/region.ts')), false,
    'the hand-written aircraft list is still in region.ts');
});

test('the new controls have styles, so they do not arrive unstyled', () => {
  const css = read(SITE, 'styles.css');
  for (const selector of ['.viewbar', '.nearby', '.near-chip', '.typerow-actions', '.tail-panel', '.tail-grid', '.tail-box', '.radar', '.radar-dot', '.sr-only']) {
    assert.ok(css.includes(selector), `${selector} has no style`);
  }
});

/* ============================================ 20 Sep 2026, second pass ======= */

test('the rate limit is caught by its STATUS, before anything tries to parse the body', () => {
  const source = readSrc('src/app.ts');

  const poll = source.indexOf('private async poll()');
  assert.ok(poll > -1);
  const statusCheck = source.indexOf("response.status === 429", poll);
  const bodyRead = source.indexOf('readJson(response)', poll);
  assert.ok(statusCheck > -1, 'the poll has no 429 branch at all');
  assert.ok(bodyRead > -1);
  assert.ok(
    statusCheck < bodyRead,
    'the body is read BEFORE the status is checked — and the feed answers 429 with an HTML page, so a rate ' +
      'limit gets reported as a JSON parse error that names the symptom and hides the cause'
  );

  // And the airport lookup must do the same, or choosing an airport during a
  // rate limit produces the same useless message.
  const choose = source.indexOf('private async chooseAirport');
  const chooseStatus = source.indexOf('response.status === 429', choose);
  const chooseRead = source.indexOf('readJson(response)', choose);
  assert.ok(chooseStatus > -1 && chooseStatus < chooseRead, 'the airport lookup reads the body before checking 429');
});

test('the warplanes class holds the historic codes, read from the feed own database', () => {
  const source = readSrc('src/typeinfo.ts');
  assert.match(source, /'military'/, 'there is no military class');
  // 🔴 RENAMED, AND THE OLD NAME WAS THE BUG. `Warplanes` put the Cessna 172 and the Dash 8
  // under a war label — the note above the table says so at length.
  assert.match(source, /military: 'Heritage & war planes'/,
    "the class is no longer called 'Heritage & war planes'");
  assert.match(source, /LANC: \['Avro Lancaster', 'military'\]/, 'the Lancaster is not a warplane type');
  assert.match(source, /tar1090-db/, 'the codes must cite the database they were read from');
  assert.match(source, /C07DD7;C-GVRA;LANC/, 'the Lancaster entry must carry the line it was verified from');
  assert.match(source, /NOT "every warplane"/, 'the class must say out loud that it is not every warplane');

  // The short list must actually be short and honest, not padded with guesses.
  const military = source.match(/', 'military'\]/g) ?? [];
  assert.ok(military.length >= 12 && military.length <= 30, `expected a short, deliberate list, found ${military.length}`);
});

test('the military harvest refuses ground stations but keeps real aircraft', () => {
  const source = readSrc('tools/survey-military.mjs');
  assert.match(source, /NOT_AN_AIRCRAFT/, 'the harvest does not exclude things that are not aircraft');
  assert.match(source, /'TWR'/, 'the tower code is not excluded');
  // The flag is not a promise, and the tool must say so rather than imply it.
  assert.match(source, /not the same as every military aircraft/i, 'the harvest must state what the flag does not mean');
});

test('every outbound request names itself, because the feed refuses Node default', () => {
  for (const file of ['tools/serve.mjs', 'worker/index.js', 'tools/survey-military.mjs']) {
    const source = readSrc(file);
    assert.match(source, /user-agent/i, `${file} sends no user agent — measured: the feed answers 403`);
    assert.match(source, /403/, `${file} does not record why the user agent is required`);
  }
});

test('the place search is proxied and normalised on BOTH sides, and the postal door is gone', () => {
  const serve = readSrc('tools/serve.mjs');
  const worker = readSrc('worker/index.js');

  for (const [name, source] of [['tools/serve.mjs', serve], ['worker/index.js', worker]]) {
    assert.match(source, /geo\/search/, `${name} has no place-search route`);
    assert.match(source, /nominatim/i, `${name} does not say who answers the search`);
    assert.match(source, /ok: true/, `${name} does not normalise the answer into our own shape`);
    assert.match(source, /places/, `${name} does not return a list to choose from`);
  }

  // 🔴 THE POSTAL DOOR IS GONE FROM BOTH SIDES, NOT JUST FROM THE PAGE. George, 20 Sep 2026,
  // pasting the paragraph back: *"i dont want any of this anymore"*. A route left in the
  // proxy is a door still on offer even when nothing on the page points at it — and the
  // Worker is the copy that answers in production.
  for (const [name, source] of [['tools/serve.mjs', serve], ['worker/index.js', worker]]) {
    assert.equal(/geo\/postal/.test(source), false, `${name} still serves the postal route`);
    assert.equal(/zippopotam/i.test(source), false, `${name} still names the postal service`);
  }

  // The page must not call a lookup service directly: what the visitor types would then go
  // straight to a third party from their own address.
  const app = readSrc('src/app.ts');
  assert.equal(/zippopotam/i.test(app), false, 'the page calls a lookup service directly');
  assert.equal(/geocod/i.test(app), false, 'the page calls the geocoder directly instead of our proxy');
  assert.match(app, /\/api\/geo\/search\?q=/, 'the page does not use the proxied place-search route');
});

test('no postal door survives anywhere — not in the page, not in the tests, not in the worker', () => {
  // The removal touched four files. A leftover in any one of them is a route, a field or a
  // claim that contradicts the others — which is exactly the shape George kept having to
  // report back to me.
  const html = read(SITE, 'index.html');
  assert.equal(/id="postal/i.test(html), false, 'the page still has a postal element');
  assert.equal(/postalForm|postalInput|postalNote/.test(html), false, 'the page still names a postal field');

  const app = readSrc('src/app.ts');
  assert.equal(/bindPostal|postalTarget|postalForm|postalInput|postalNote/.test(app), false,
    'the page still binds or reads a postal field');
  assert.equal(/\/api\/geo\/postal\//.test(app), false, 'the page still asks the postal route');

  const e2e = readSrc('test/e2e.test.js');
  assert.equal(/postalInput|postalForm|postalNote|geo\/postal/.test(e2e), false,
    'a test still drives a postal field that no longer exists');

  // And the paragraph George pasted back is gone from the copy too, including the two claims
  // that only made sense while the door was there.
  assert.equal(/[redacted]/.test(html), false, 'the page still quotes a postal code at the reader');
  assert.equal(/ZIP such as/i.test(html), false, 'the page still offers a ZIP code as a way in');
});

test('the type list is alphabetical by NAME, not by how often it was seen', () => {
  const source = readSrc('src/app.ts');
  assert.match(source, /describeType\(a\.code\)\.name\.localeCompare\(describeType\(b\.code\)\.name\)/,
    'the type list is not sorted by the name a reader actually sees');
  assert.equal(/sort\(\(a, b\) => b\.seen - a\.seen/.test(source), false,
    'the list is still sorted by sighting count, so it reshuffles under the reader');
});

test('military.json says what it is and what it is not, and its codes are shaped like codes', () => {
  const doc = JSON.parse(read(SITE, 'military.json'));
  assert.ok(Array.isArray(doc.codes) && doc.codes.length > 10, 'the harvest is too small to be a real one');
  assert.match(doc.flag, /dbFlags/, 'the file must name the flag it read');
  assert.match(doc.note, /not the same as every military aircraft/i, 'the file must state the limit of the flag');
  assert.match(doc.covers, /global/i, 'the file must say the query was worldwide, not local');
  assert.ok(Array.isArray(doc.dropped) && doc.dropped.includes('TWR'), 'the tower code was not excluded');

  for (const row of doc.codes) {
    assert.match(row.code, /^[A-Z0-9]{1,4}$/, `${row.code} is not a type code`);
    assert.ok(row.seen >= 1);
  }
  assert.equal(/TWR|GRND/.test(doc.codes.map((r) => r.code).join(',')), false, 'a ground station is in the aircraft list');
});

/* ============================================ 20 Sep 2026, third pass ======== */

test('a civil type is NEVER reclassified by the feed global military flag', () => {
  const source = readSrc('src/app.ts');
  const marker = source.indexOf('private klassOf(');
  assert.ok(marker > -1);
  const body = source.slice(marker, marker + 900);

  assert.match(body, /isCivilClass\(known\)/, 'the class method does not consult the civil guard');
  assert.match(body, /if \(isCivilClass\(known\)\) return known;/, 'a civil type can still be overridden by the flag');
  assert.ok(
    body.indexOf('isCivilClass(known)') < body.indexOf('militaryCodes.has'),
    'the military set is consulted BEFORE the civil guard, which is the bug: it put the Cessna 172 and the ' +
      'Dash 8 under Warplanes and took the Boeing 737 and the Airbus A320 out of Airliner'
  );
  assert.match(readSrc('src/typeinfo.ts'), /export function isCivilClass/, 'the guard does not exist');
});

test('Everything comes first and Warplanes last', () => {
  const source = readSrc('src/app.ts');
  const start = source.indexOf('const options: { key: AircraftClass');
  const block = source.slice(start, start + 500);
  const everything = block.indexOf("label: 'Everything'");
  const warplanes = block.indexOf("classLabel('military')");
  assert.ok(everything > -1 && warplanes > -1);
  assert.ok(everything < warplanes, 'Warplanes is not after Everything — the reader asked for the opposite order');
  // The default has to be the first chip, or the pressed state reads as the second.
  assert.ok(everything < block.indexOf('...CLASS_ORDER'), 'Everything is not the first option');
});

test('tail numbers are chips in the card, and the disclosure button is gone', () => {
  const source = readSrc('src/app.ts');
  assert.equal(/Choose tail numbers/.test(source), false, 'the disclosure button is still there');
  assert.equal(/type-expand/.test(source), false, 'the expand button is still bound');
  assert.equal(/expandedTypes/.test(source), false, 'the disclosure state is still kept');
  assert.match(source, /class="tail-chip"/, 'the tail chips are not rendered');
  assert.match(source, /aria-pressed="\$\{chosen\.has/, 'a tail chip does not carry its highlighted state');
  // The un-favouriting is a consequence of the rule, not a separate step. If a
  // future edit adds a second mechanism they will drift apart.
  assert.match(source, /un-favourites the whole type/, 'the row does not say what highlighting a tail does');
});

test('the word is FAVOURITE, and the row offers the right thing in each state', () => {
  const source = readSrc('src/app.ts');
  assert.match(source, /'Favourite this type'/, 'no favourite action on a type');
  assert.match(source, /'Favourite the whole type'/, 'a narrowed type has no way back to all of them');
  assert.match(source, /'Favourited — remove'/, 'a favourited type cannot be removed');
  assert.equal(/Watch this type/.test(source), false, 'the old wording is still in the page');
  assert.equal(/Watching — stop/.test(source), false, 'the old removal wording is still in the page');
});

test('later steps are held back, and arrive with the glide', () => {
  const html = read('index.html');
  for (const n of [2, 3, 4, 5]) {
    assert.match(html, new RegExp(`id="step-${n}"[^>]*hidden`), `step ${n} is visible before step 1 is answered`);
    assert.match(html, new RegExp(`data-step="${n}"`), `step ${n} carries no number for the gate to read`);
  }
  assert.match(html, /id="step-1" data-step="1"/, 'step 1 must be visible and numbered');
  assert.match(html, /id="step-1"[^>]*>[\s\S]{0,80}Where are you\?/, 'the first step is not the one that asks where the reader is');

  const css = read(SITE, 'styles.css');
  assert.match(css, /@keyframes step-glide/, 'there is no glide');
  assert.match(css, /animation: step-glide 620ms/, 'the glide is missing or not slow');
  assert.match(css, /\.step-gated\[hidden\][\s\S]{0,80}display: none/, 'a held-back step is still laid out');
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]{0,200}step-arrive[\s\S]{0,120}animation: none/,
    'the glide is not switched off for a reader who asked for less motion');

  const source = readSrc('src/app.ts');
  assert.match(source, /classList\.add\('step-arrive'\)/, 'a revealed step never gets the glide');
  assert.match(source, /classList\.remove\('step-arrive'\)/,
    'the glide class is left on, so the step would replay on every re-render');
});

test('the airport spinner is cleared on every way out of the lookup', () => {
  const source = readSrc('src/app.ts');
  const start = source.indexOf('private async chooseAirport');
  const end = source.indexOf('private stop(');
  const body = source.slice(start, end);
  assert.match(body, /this\.setBusy\(icao, true\)/, 'the button never shows it is working');
  const clears = body.match(/this\.setBusy\(icao, false\)/g) ?? [];
  assert.ok(clears.length >= 3,
    `the spinner is cleared on ${clears.length} path(s); it must be cleared on the rate limit, on an error, and on success`);
  assert.match(readSrc('src/app.ts'), /aria-busy/, 'nothing sets the busy attribute the spinner is drawn from');
});

test('the fence is measured from the reader, not from the airport', () => {
  const source = readSrc('src/app.ts');
  assert.match(source, /private centre: \{ lat: number; lon: number \} \| null = null;/, 'there is nowhere to keep the reader position');
  assert.match(source, /private point\(\): \{ lat: number; lon: number \} \| null \{/, 'there is no single source for the fence centre');
  assert.match(source, /const at = this\.point\(\);\n    if \(!at \|\| !this\.engine\) return;/, 'the poll does not use it');
  assert.equal(/point\/\$\{this\.airport\.lat\}/.test(source), false, 'the poll still asks the feed about the airport');
  assert.match(source, /this\.centre = \{ lat, lon \};/, 'a postal code never becomes the centre');
  assert.match(source, /out from \$\{this\.centre \? 'your own position' : 'the airport'\}/,
    'the page does not say which point the distance is from');
});

/* ============================================ 20 Sep 2026, fourth pass ======= */

test('no measure cap is left on a description, measured off the rendered page', () => {
  const css = read(SITE, 'styles.css');
  // These three were measured at 635px, 666px and 635px inside an 856px card.
  for (const selector of ['.sub', '.lede']) {
    const rule = css.slice(css.indexOf(`\n${selector} {`), css.indexOf('}', css.indexOf(`\n${selector} {`)));
    assert.match(rule, /max-width: none/, `${selector} is still capped short of the card`);
    assert.equal(/max-width: \d+ch/.test(rule), false, `${selector} still carries a character-measure cap`);
  }
  assert.equal(/max-width: 80ch/.test(css), false, 'a list is still capped at 80ch');
  // And a paragraph that lands in a flex chip row must take its own line.
  assert.match(css, /\.chips > p[\s\S]{0,120}flex-basis: 100%/, 'a note in a chip row is laid out as a chip');
});

test('a type is favourited with a star, and the shape carries the state', () => {
  const source = readSrc('src/app.ts');
  assert.match(source, /function starButton\(/, 'there is no star control');
  assert.match(source, /aria-pressed="\$\{wholeType\}"/, 'the star does not carry its pressed state');
  assert.match(source, /star-part/, 'a type narrowed to tails does not show as partly watched');
  assert.match(source, /const TAIL_STAR/, 'a highlighted tail number gets no little star');
  assert.match(source, /\$\{on \? TAIL_STAR : ''\}/, 'the tail star is not conditional on the highlight');
  // The words still have to reach a screen reader even though the icon replaced them.
  assert.match(source, /aria-label="\$\{label\}"/, 'the star has no accessible name');
  assert.match(source, /title="\$\{label\}"/, 'the star has no tooltip');
  assert.equal(/'Favourite this type'/.test(source), true, 'the wording was deleted rather than moved');
});

test('a step that waits on a place is SHOWN with the reason, not hidden', () => {
  const html = read('index.html');
  for (const n of [2, 3, 5]) {
    assert.match(html, new RegExp(`id="step-${n}"[^>]*data-waiting="true"`), `step ${n} does not start as waiting`);
    assert.equal(new RegExp(`id="step-${n}"[^>]*hidden`).test(html), false, `step ${n} is hidden instead of waiting`);
    assert.match(html, new RegExp(`id="step-${n}"[\\s\\S]{0,600}class="step-why"`), `step ${n} has no note saying what to do`);
  }
  assert.match(html, /id="step-4"[^>]*hidden/, 'the watchlist is shown before anything is picked');

  const css = read(SITE, 'styles.css');
  assert.match(css, /\.step-why\b/, 'the note has no style');
  assert.match(css, /data-waiting='true'[\s\S]{0,200}pointer-events: none/, 'a waiting step is still clickable');

  const source = readSrc('src/app.ts');
  assert.match(source, /control\.disabled = !place;/, 'the controls of a waiting step are still usable');
  assert.match(source, /waiting = String\(!place\)/, 'the waiting state is never set');
});

test('the map is DRAWN, not embedded, and says why', () => {
  const source = readSrc('src/app.ts');
  assert.match(source, /private renderMap\(\)/, 'there is no map');
  assert.match(source, /NOT EMBEDDED/, 'the drawing does not record the decision');
  assert.match(source, /an API key, a billing account, and a request to Google from every visitor/,
    'the reason an embedded map was refused is not written down');
  // The two things a map of this is for: where the reader is, and what is near.
  assert.match(source, /locmap-you/, 'the reader is not marked');
  assert.match(source, /locmap-airport/, 'the airports are not marked');
  assert.match(source, /escapeHtml\(row\.airport\.icao\)/, 'the airports are drawn without their codes');
  // 🔴 No Google in the page, which is the standing rule for every one of these sites.
  assert.equal(/maps\.google|googleapis\.com\/maps|gtag\(|googletagmanager/.test(readSrc('src/app.ts')), false,
    'something in the page now calls Google directly');
});

/* ============================================ 20 Sep 2026, fifth pass ======= */

test('the error handler cannot throw — the crash that read as "Failed to fetch"', () => {
  const source = readSrc('tools/serve.mjs');

  // 🔴 `upstream` is declared inside `serveApi`'s try and was named inside its
  // catch, where it does not exist. The ReferenceError came from the error
  // handler itself, killed the process, and the page could only report "Failed to
  // fetch" — because by then nothing was listening. Reproduced on 20 Sep 2026:
  // `ReferenceError: upstream is not defined at serveApi (serve.mjs:382:9)`.
  const api = source.slice(source.indexOf('async function serveApi'), source.indexOf('const server = createServer'));
  const catchAt = api.indexOf('} catch (error) {');
  assert.ok(catchAt > -1, 'serveApi has no catch');
  const handler = api.slice(catchAt);
  assert.equal(/\bupstream\b/.test(handler), false,
    'the catch block names `upstream`, which only exists inside the try — the error handler will throw and kill the server');

  // And every route has a net under it, so a future mistake in one cannot take
  // the whole process down again.
  assert.match(source, /const guard = \(work\) =>/, 'no route is guarded');
  assert.match(source, /guard\(serveApi\(request, response\)\)/, 'the api route is unguarded');
  assert.match(source, /guard\(serveStatic\(request, response\)\)/, 'the static route is unguarded');
});

test('the page says what it means and keeps the type list short', () => {
  const html = read('index.html');
  const source = readSrc('src/app.ts');
  const css = read(SITE, 'styles.css');

  // Plain words, not plumbing.
  assert.match(source, /aircraft around you · updated/, 'the status line does not say what the reader asked');
  assert.equal(/poll \$\{this\.polls\}/.test(source), false, 'the status line still counts polls');
  assert.equal(/in the fence · poll/.test(source), false, 'the status line still uses jargon');

  // No mode switch: the page is the picking flow, and the chart is a step in it.
  assert.equal(/Pick what to watch/.test(html), false, 'the view switch is back on the page');
  assert.equal(/In the air now<\/button>/.test(html), false, 'the view switch is back on the page');
  assert.equal(/view-switch|viewbar/.test(html + css), false, 'the switch is gone from the page but not from the styles');
  assert.match(html, /id="liveView"[^>]*data-step="7"[^>]*hidden/, 'the chart is not a step in the flow');

  // Heritage and war planes sit between Everything and Airliner.
  const start = source.indexOf('const options: { key: AircraftClass');
  const block = source.slice(start, start + 400);
  const everything = block.indexOf("label: 'Everything'");
  const military = block.indexOf("classLabel('military')");
  const airliner = block.indexOf('...CLASS_ORDER');
  assert.ok(everything < military && military < airliner,
    'heritage and war planes is not between Everything and Airliner');

  // Height restricted, or the page runs away again.
  const rule = css.slice(css.indexOf('\n.typelist {'), css.indexOf('}', css.indexOf('\n.typelist {')));
  assert.match(rule, /max-height:\s*\d+px/, 'the type list has no height limit');
  assert.match(rule, /overflow-y:\s*auto/, 'the type list cannot scroll');
  // And the mark the reader makes is yellow, not the site's own blue.
  assert.match(css, /\.star\[[^\]]*aria-pressed='true'\][\s\S]{0,160}#f0be5a/, 'a starred type is not yellow');
  assert.match(css, /\.tail-chip\[aria-pressed='true'\][\s\S]{0,160}#f0be5a/, 'a starred tail number is not yellow');

  // The descriptions are one or two lines, not paragraphs.
  for (const match of html.matchAll(/<p class="sub">([\s\S]*?)<\/p>/g)) {
    const text = match[1].replace(/<[^>]*>/g, '').trim();
    assert.ok(text.length <= 220, `a description is ${text.length} characters: ${text.slice(0, 60)}…`);
  }
});

test('the later steps do not exist until the first is answered', () => {
  const html = read('index.html');
  for (const n of [2, 3, 4, 5]) {
    assert.match(html, new RegExp(`id="step-${n}"[^>]*hidden`), `step ${n} is on the page before step 1 is answered`);
  }
  assert.match(html, /id="step-1" data-step="1"/, 'step 1 must be visible — it is the one that asks');

  const source = readSrc('src/app.ts');
  // The gate is sequential: 1 unlocks 2, 2 is answered on arrival and unlocks 3,
  // 3 unlocks the rest. Steps 3 and 5 are staggered so it reads in order.
  assert.match(source, /const wantsPlace = step <= 5;/, 'the gate does not run in step order');
  assert.match(source, /const show = wantsPlace \? place : place && picked;/, 'a watchlist or a chart can appear before anything is picked');
  assert.match(source, /const delay = step === 3 \|\| step === 5 \? 420 : 0;/, 'the steps land together instead of one after another');
  assert.equal(/data-waiting/.test(source), false, 'the waiting mechanism is still in the app');
  assert.equal(/step-why/.test(html), false, 'a waiting note is still on the page');
});

test('a 502 from the feed own gateway is described as what it is', () => {
  const source = readSrc('src/app.ts');

  // 🔴 The fault was described twice in one day and both descriptions named the
  // symptom: "answered 429 with text/html" and "answered 502 with text/html ...
  // nginx". The 502 was adsb.lol's OWN nginx failing, which has nothing to do with
  // the reader's connection, and the reader was told about JSON.
  assert.match(source, /private feedTrouble\(response: Response\)/, 'there is no single place that reads the status');
  const helper = source.slice(source.indexOf('private feedTrouble('), source.indexOf('private async chooseAirport'));
  assert.match(helper, /response\.status === 429/, 'the rate limit is not handled');
  assert.match(helper, /response\.status >= 500/, 'a 5xx from the feed has no sentence of its own');
  assert.match(helper, /at their end, not yours/, 'the 5xx message does not say whose fault it is');
  assert.match(helper, /!response\.ok/, 'any other error status has no sentence');

  // And it must run BEFORE the body is touched, in both callers.
  for (const [name, header, next] of [
    ['the poll', 'private async poll()', 'private recordDepartures'],
    ['the airport lookup', 'private async chooseAirport', 'private stop('],
  ]) {
    const body = source.slice(source.indexOf(header), source.indexOf(next));
    const decides = body.indexOf('this.feedTrouble(response)');
    const parses = body.indexOf('readJson(response)');
    assert.ok(decides > -1, `${name} never consults the status`);
    assert.ok(parses > -1, `${name} no longer parses a body`);
    assert.ok(decides < parses, `${name} reads the body before checking the status — the exact fault this fixes`);
  }
});

test('an empty type list explains itself, and the guard exists at all', () => {
  const source = readSrc('src/app.ts');

  // 🔴 THE GUARD WENT MISSING AND NOBODY NOTICED. A patch on 20 Sep 2026 removed
  // the curated-rows block and the empty check went with it, so a filter matching
  // nothing rendered a blank box — which is exactly what the Heritage & war planes
  // filter does at Hamilton most days. The first assertion is therefore that the
  // guard EXISTS, before any assertion about what it says.
  const list = source.slice(source.indexOf('private renderTypeList(): void {'));
  assert.match(list.slice(0, 1600), /if \(rows\.length === 0\) \{/, 'the type list has no empty guard');
  assert.match(source, /private emptyMessage\(\)/, 'there is no message for an empty list');

  const message = source.slice(source.indexOf('private emptyMessage()'), source.indexOf('private renderTypeList(): void {'));
  assert.match(message, /typeFilter === 'military'/, 'the war planes filter has no message of its own');
  assert.match(message, /normal state rather than a fault/,
    'an empty war planes list still reads as a fault rather than as its normal state');
  assert.match(message, /Lancaster/, 'the empty war planes message does not mention the aircraft that prompted it');
  assert.match(message, /typeFilter === 'all'/, 'the unfiltered list has no message');
  // Every other class gets the honest explanation that the list is measured.
  assert.match(message, /measured from the feed/, 'the other classes have no explanation');

  // And the abandoned dimmed-waiting approach left no CSS behind.
  assert.equal(/data-waiting/.test(read(SITE, 'styles.css')), false, 'the dead waiting rules are still in the stylesheet');
});

/* ============================ the historic schedule =========================
 *
 * George, 20 Sep 2026: *"thats the whole point actually, to watch these old aircraft fly past
 * your home location"* — and, of the first draft that put this in a README instead,
 * *"shoudnt these be in the api?"*. These tests hold both halves of that: the data lives in
 * the database and is served, and the composition exists in exactly one place.
 */

test('the historic schedule is DATA — in the schema, served by the API, not a note in a file', () => {
  const schema = read(ROOT, 'db', 'schema.sql');
  for (const table of ['historic_sites', 'historic_aircraft', 'historic_flights']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} is not in the schema`);
  }
  assert.match(schema, /CREATE OR REPLACE VIEW historic_next/, 'the next-flying-day is stored rather than computed');

  // Served, on the same path shape as every other data file the page reads.
  const serve = readSrc('tools/serve.mjs');
  assert.match(serve, /'\/historic\.json'/, 'the dev server does not answer /historic.json');
  assert.match(serve, /composeHistoric/, 'the dev server has no historic composer');

  // And read by the page rather than written into it.
  const app = readSrc('src/app.ts');
  assert.match(app, /fetch\('\/historic\.json'/, 'the page does not read the served document');

  // The file is the deploy artefact, because a Worker cannot reach Postgres — so it must
  // exist in the repo the deploy ships.
  assert.ok(existsSync(join(SITE, 'historic.json')), 'site/historic.json is missing, so a deploy would 404');
});

test('the historic document is composed in ONE place, or the file and the route drift', () => {
  // 🔴 THIS IS NOT STYLE, IT IS THE FAULT THIS REPO HAS ALREADY HAD. `types.json` was built
  // by the dev server from Postgres while `site/types.json` said something else, and an
  // experiment was invalidated by it. One composer, imported by both, is the fix.
  const composer = readSrc('tools/historic-document.mjs');
  assert.match(composer, /export async function composeHistoric/, 'there is no exported composer');

  const loader = readSrc('tools/load-historic.mjs');
  assert.match(loader, /import \{ composeHistoric \}/, 'the loader does not use the shared composer');
  assert.equal(/source: "the operator/.test(loader), false, 'the loader still carries its own copy of the document');

  const serve = readSrc('tools/serve.mjs');
  assert.match(serve, /import \{ composeHistoric \}/, 'the dev server does not use the shared composer');
});

test('the museum endpoint\'s ONE-DAY OFFSET is encoded and checked, not assumed', () => {
  // 🔴 READ RAW, NOT THROUGH `readSrc`. This test asserts on the MEASUREMENT RECORDED IN A
  // COMMENT, and `readSrc` strips comments — so through it every one of these would fail
  // against correct code. That is the false failure this file's header warns about, and it
  // has already cost this family four tests once.
  const loader = read(ROOT, 'tools', 'load-historic.mjs');

  // The measurement must be recorded where the code is, because a comment elsewhere is a
  // comment nobody reads when the number changes.
  assert.match(loader, /THE `date` PARAMETER IS ONE DAY AHEAD/i, 'the measured offset is not written down');
  assert.match(loader, /Ten pairs, measured/, 'the evidence for the offset is missing');

  // And the code itself: the offset day is requested, and every event is checked against the
  // day that was WANTED. The second half is what turns "the offset changed" from a wrong day
  // beside somebody's home airport into an empty day.
  const code = readSrc('tools/load-historic.mjs');
  assert.match(code, /day\.getTime\(\) \+ 86_400_000/, 'the offset day is not requested');
  assert.match(code, /startsWith\(wanted\)/, 'an event is not checked against the day it was asked for');
});

test('an aircraft whose type code has no source is reported as UNKNOWN, not as never seen', () => {
  // 🔴 THREE STATES IN THE DATA AND THE PAGE MUST KEEP ALL THREE. `reported: null` means no
  // source was found for this aircraft's code, which is not the same as "the feed has never
  // reported it" — and printing the second when the first is true is a claim nobody checked.
  const composer = readSrc('tools/historic-document.mjs');
  assert.match(composer, /item\.type_code === null \? null : inFeed\.has\(item\.type_code\)/,
    'the composer does not distinguish an unknown code from an unseen one');

  const loader = read(ROOT, 'tools', 'load-historic.mjs');
  // The trap is recorded where the code it guards is, and it is a COMMENT — so raw again.
  assert.match(loader, /LNC4/, 'the Lancair/Lancaster trap is not recorded next to the code it guards');

  const app = readSrc('src/app.ts');
  assert.match(app, /one\.reported === false/, 'the page does not test for the definite `false`');
  assert.equal(/reported !== true/.test(app), false,
    'the page treats anything that is not `true` as never seen, which swallows the unknown case');
});

/* ============== the filters and the type list can be SEEN, and say why ======
 *
 * George, 21 Sep 2026: *"all my filters are gone. fix that. and i dont see any airplain type.
 * create units and e2e tyestsing too"*. The end-to-end tests prove the behaviour; these prove the
 * shape it depends on, so a later edit cannot quietly re-break it.
 */

test('the three filter rows live INSIDE the gated type section, so whatever opens it shows them', () => {
  // 🔴 THIS IS WHY THE FILTERS "WENT MISSING" AND IT IS NOT A BUG TO FIX BY MOVING THEM. They are
  // inside `#step-3` on purpose — the section opens on a place, and a reader who has not said where
  // they are has nothing for a type filter to act on. What matters is that the
  // chips and the list share ONE container: if a chip ever leaves it, the filters and the rows
  // can be shown and hidden independently, which is the state that looks like "my filters are
  // gone" while the rows are still there.
  const html = read(SITE, 'index.html');
  const section = htmlCode.slice(htmlCode.indexOf('id="step-3"'));
  const end = section.indexOf('</section>');
  const inner = section.slice(0, end === -1 ? section.length : end);

  for (const id of ['typeFilter', 'yearFilter', 'seenFilter', 'filterNote', 'typeList']) {
    assert.ok(inner.includes(`id="${id}"`), `${id} is not inside the step-3 section`);
  }
  assert.ok(html.includes('class="card step-gated" id="step-3"'), 'step 3 is no longer a gated section');
  assert.ok(section.length > 0, 'the step-3 section was not found at all');
});

test('the type section opens on a PLACE — the distance no longer gates it', () => {
  const app = readSrc('src/app.ts');
  // 🔴 THE UNLOCK CONDITION, AND WHY IT CHANGED. George moved the distance control above the map on
  // 22 Sep 2026 (*"i want this above the map"*), and the map is in step 4 — which step 3 unlocks.
  // `place && radiusChosen` was therefore a gate waiting on a control inside the very card it was
  // holding shut: the distance could only be chosen after a distance had been chosen. The gate is
  // the place alone now, and a distance is in use from the start.
  assert.match(app, /const answered1 = place;/, 'the unlock condition for the type section has changed shape');
  assert.equal(
    /const answered1 = place && this\.radiusChosen/.test(app),
    false,
    'the type section still waits for a distance that is chosen in the card it unlocks'
  );

  // The place still has to survive a reload, or a returning reader gets a page with no filters and
  // no explanation — and a kept distance is still restored, because it is applied from the start.
  assert.match(app, /JSON\.parse\(readStore\(CENTRE_KEY/, 'the saved location is no longer restored');
  assert.match(app, /this\.radiusKm = keptRadius/, 'the saved distance is no longer restored');
  assert.match(app, /this\.radiusChosen = true/, 'the saved distance no longer counts as chosen');
});

test('the distance control sits ABOVE the map it draws, refreshed line first and right-aligned', () => {
  // 🔴 George, 22 Sep 2026: *"i want this above the map"*, then *"top above map right aligned"*, then
  // *"last refresh should be the first thing above the map, right aligned"*, then *"remove Everything
  // on this page is measured from here: …"*. The last one settled it: the line belongs to the MAP, so
  // it is the FIRST THING ABOVE THE MAP — the line the eye meets coming up off it — rather than the
  // top of the block, where it sat under the watchlist and read as a footnote to that instead.
  const code = htmlCode;
  const head = code.indexOf('id="radiusHead"');
  const buttons = code.indexOf('id="radiusButtons"');
  const fence = code.indexOf('id="fenceFrom"');
  const refreshed = code.indexOf('id="refreshedAgo"');
  const map = code.indexOf('id="watchMap"');

  for (const [what, at] of [
    ['the distance heading', head],
    ['the distance slider', buttons],
    ['the centre paragraph', fence],
    ['the refreshed line', refreshed],
    ['the map', map],
  ]) {
    assert.ok(at > -1, `${what} is not on the page at all`);
  }
  assert.ok(head < buttons && buttons < fence && fence < refreshed && refreshed < map,
    'the distance control, the refreshed line and the map are not in that order');
  assert.equal((code.match(/id="radiusRefreshed"/g) ?? []).length, 1, 'the refreshed line is on the page twice');

  // 🔴 AND THE NOTE HE REMOVED IS NOT BACK. It explained the control to a reader looking at the control.
  assert.equal(code.includes('id="radiusNote"'), false, 'the distance note is on the page again');

  // It opens on "now", not on a placeholder that reads like a fault — *"start off my saying now"*.
  assert.match(code, /id="refreshedAgo">now</, 'the refreshed line does not open on "now"');

  // And it is in the WATCHING card, not back in step 1.
  const step4 = code.slice(code.indexOf('id="step-4"'), code.indexOf('id="live"'));
  assert.ok(step4.includes('id="radiusButtons"'), 'the distance slider is not in the map\'s own card');
  assert.ok(step4.includes('id="refreshedAgo"'), 'the refreshed line is not in the map\'s own card');

  // The line is filled by the same ticker that ages every row, or it would freeze at whatever it said
  // when the poll landed.
  const app = readSrc('src/app.ts');
  assert.match(app, /#refreshedAgo/, 'nothing keeps the refreshed line honest');
  assert.match(app, /fromNow\(this\.lastPollAt\)/, 'the refreshed line is not counted from the last poll');

  // 🔴 THE VALUE RIDES ON THE DOT — *"**20 km** stick this to the dot on the line"* — so the slider's own
  // box has to exist to position it against, and the thumb width has to be known to place it.
  assert.ok(code.includes('id="radiusButtons"'), 'the slider host is gone');
  assert.match(app, /radius-track/, 'nothing positions the value against the track');
  assert.match(app, /placeReadout/, 'the value is not placed on the dot');
  const css = read(SITE, 'styles.css');
  assert.match(css, /\.radius-value\s*\{[\s\S]{0,200}position:\s*absolute/, 'the value is not positioned');
  assert.match(css, /\.radius-value\s*\{[\s\S]{0,300}translateX\(-50%\)/, 'the value is not centred on the dot');
  assert.match(css, /\.refreshed-line\s*\{[\s\S]{0,120}text-align:\s*right/, 'the refreshed line is not right-aligned');
});

test('a watched tail is a NEUTRAL label, and green only when it is in the air', () => {
  // 🔴 George, 22 Sep 2026: *"the yellow labels are not good, make them neutral, and make green hue only
  // if the tail is in the air"* — and he pasted the row back: *"Dash 8-400 (Q400) DH8D 1998 2 in the air
  // ✕ C-GJZG C-GLQK"*. The gold had stopped saying anything: on a whole-type rule EVERY chip was gold,
  // because a whole-type rule watches every tail under it, so the two chips that mattered — the flying
  // ones — were the hardest things on the row to pick out.
  //
  // So this checks BOTH halves: no gold is spent in this list, and the green is spent on one fact only.
  const css = read(SITE, 'styles.css');
  assert.equal(
    /\.watch-list \.watch-tails[\s\S]{0,400}#f0be5a/.test(css),
    false,
    'a watched tail is still gold'
  );
  assert.match(css, /\.watch-list \.watch-tails \.tail-chip\.tail-air[\s\S]{0,200}#7ee787/,
    'a tail that is in the air is not green');
  assert.match(css, /\.watch-list \.watch-tails \.tail-chip\.tail-off[\s\S]{0,80}opacity/,
    'a tail that is not watched is not dimmed');
  // The year is information rather than a mark, so it is neutral too — *"make them neutral"*.
  assert.equal(/\.year-tag\s*\{[\s\S]{0,240}#f0be5a/.test(css), false, 'the year tag is still gold');

  const app = readSrc('src/app.ts');
  assert.match(app, /one\.phase === 'airborne'/, 'nothing works out which of these tails are in the air');
  assert.match(app, /tail-air/, 'the chip is never given the in-the-air class');
  // It is read from the same snapshot the status column beside it is drawn from, or the chip and the
  // words could describe different moments.
  assert.match(app, /const live = this\.engine \? this\.engine\.snapshot\(\) : \[\]/,
    'the chips are not read from the same snapshot as the row status');
});

test('an empty type list NAMES THE WINDOW when the window is the reason', () => {
  // 🔴 THE SENTENCE THAT COST GEORGE A MORNING. Any empty list under the default kind filter used
  // to be answered with *"Nothing has been seen yet — the page has only just started looking. Give
  // it a minute."* — including a list emptied by a 5-minute last-seen choice over a record holding
  // a full day of sightings. It is false, it blames the page for a filter doing its job, and it
  // hides the one thing that would fix it, which is the choice the reader made.
  const app = readSrc('src/app.ts');

  // The window is checked BEFORE the kind filter, or the generic sentence wins again.
  const windowCheck = app.indexOf("if (seen.mode !== 'all' && seen.mode !== 'noData' && counts.rows.length === 0");
  const generic = app.indexOf("'Nothing has been seen yet — the page has only just started looking. Give it a minute.'");
  assert.ok(windowCheck > -1, 'the empty list no longer checks whether the last-seen window is the reason');
  assert.ok(generic > -1, 'the fallback sentence has gone, so this test is checking nothing');
  assert.ok(windowCheck < generic, 'the window check comes AFTER the generic sentence, so it never runs');

  // And the message must name the window and point at the fix rather than only reporting emptiness.
  const message = app.slice(windowCheck, generic);
  assert.match(message, /within \$\{seen\.phrase/, 'the empty message does not name the chosen window');
  assert.match(message, /widen it to see them|widen/i, 'the empty message does not say what to do about it');
  assert.match(message, /doing its job, not an empty list/, 'the empty message does not say the filter is working');

  // It also has to be given the counts, or it cannot tell an empty window from an empty page.
  assert.match(app, /private emptyMessage\(counts: \{/, 'emptyMessage no longer receives the counts');
  assert.match(app, /this\.emptyMessage\(counts\)/, 'the counts are not passed to emptyMessage');
});

test('EVERY element the page reaches for exists in the page', () => {
  // 🔴 THIS IS THE GENERAL FORM OF A BUG THAT COST THREE ROUNDS. George, 21 Sep 2026: *"i dont see
  // airplanes to click from. you used to have that, return it"*. The aircraft list had been deleted
  // from the markup while `renderWatchlist()` and `bindWatchForm()` stayed in app.ts, still calling
  // `byId('watchList')`, `byId('watchForm')` and `byId('watchInput')`. Every one of those functions
  // returns silently when its element is missing, so a whole feature did nothing and no test could
  // see it: a test selects an element and finds it, and nothing was selecting these.
  //
  // So the shape is checked once, everywhere, instead of one feature at a time. A byId for an id
  // that is not in the page is a feature that has been half-removed — the code reads as if it
  // works and the reader sees nothing.
  const app = readSrc('src/app.ts');
  const html = read(SITE, 'index.html');

  const wanted = new Set();
  for (const match of app.matchAll(/byId<[^>]*>\(\s*'([a-zA-Z0-9_-]+)'\s*\)|byId\(\s*'([a-zA-Z0-9_-]+)'\s*\)/g)) {
    wanted.add(match[1] ?? match[2]);
  }
  assert.ok(wanted.size > 25, `only ${wanted.size} ids were found in app.ts, which is too few to be the real set`);

  const defined = new Set([...html.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]));
  const missing = [...wanted].filter((id) => !defined.has(id)).sort();

  assert.deepEqual(
    missing,
    [],
    `app.ts reaches for ${missing.length} element(s) the page does not contain, so the code behind ` +
      `them runs and does nothing: ${missing.join(', ')}`
  );
});

test('the list of what you are watching is on the page, and wired to the code that fills it', () => {
  const html = read(SITE, 'index.html');
  assert.ok(html.includes('id="watchList"'), 'the list of what you are watching is missing from the page');
  assert.match(html, /<ul class="watch-list" id="watchList"><\/ul>/,
    'the watch list is not an empty <ul> for renderWatchlist to fill');

  const app = readSrc('src/app.ts');
  assert.match(app, /private renderWatchlist\(\): void/, 'renderWatchlist has gone');
  // And the list is drawn once at start, so a reader's saved watches come back with the page.
  assert.match(app, /this\.renderWatchlist\(\);/, 'the watch list is never rendered');
});

test('the by-name form is GONE, and its code went with it', () => {
  // 🔴 George, 21 Sep 2026: *"### Or one aircraft by name i dont want this, just show a
  // map"*. The block is removed — and so is every piece of code that served it, because
  // deleting markup while leaving a handler behind is the exact fault this page was
  // repaired for earlier the same day: the handler returns on a missing element, does
  // nothing, and reads as if it works.
  const html = read(SITE, 'index.html');
  const app = readSrc('src/app.ts');

  for (const id of ['watchForm', 'watchInput', 'watchStatus', 'watchHead', 'watchNote']) {
    assert.equal(html.includes(`id="${id}"`), false, `${id} is back on the page`);
  }
  assert.equal(/private bindWatchForm/.test(app), false, 'bindWatchForm is still in app.ts');
  assert.equal(/private addWatch/.test(app), false, 'addWatch is still in app.ts — its only caller was the removed form');
  assert.equal(/this\.bindWatchForm\(\)/.test(app), false, 'the removed form is still being bound at start');

  // What must SURVIVE: the list, and the way to clear a named row that is already on it.
  assert.match(app, /private renderWatchlist\(\): void/, 'the watch list went with the form');
  assert.match(app, /private removeWatch\(/, 'a named aircraft already on the list can no longer be cleared');
});

test('there is ONE map, in the watching section, with the circle drawn on it', () => {
  // 🔴 George, 22 Sep 2026: *"i think the circle in the first map can be added to the second map,
  // then the first map can be removed"*.
  //
  // This guard is the inverse of the one it replaces. That one asserted the map was in the aircraft
  // step and that its sentence and its button had travelled there with it out of the distance step.
  // The travelling is still worth holding — the sentence belongs to the circle it describes — but
  // the step is now the watching section, because that is where the one surviving map lives.
  const html = read(SITE, 'index.html');

  // 🔴 THE FIRST MAP IS GONE, ELEMENT AND ALL. An id left behind is worse than a missing one: the
  // code would have an element to draw into that nothing on the page can see.
  assert.equal((html.match(/id="locMap"/g) ?? []).length, 0,
    'the removed map is still on the page, so its drawing has somewhere invisible to go');
  assert.equal((html.match(/id="watchMap"/g) ?? []).length, 1,
    'the page does not have exactly one map, so two of them can disagree');
  assert.equal((html.match(/id="fenceFrom"/g) ?? []).length, 1, 'the fence sentence exists more than once');
  assert.equal((html.match(/id="fenceFromLocate"/g) ?? []).length, 1, 'the locate button exists more than once');

  // In the watching section, below the list it plots, with the sentence about the circle and the
  // button that moves it directly above the map that draws it.
  const step4At = html.indexOf('id="step-4"');
  const listAt = html.indexOf('id="watchList"');
  const sentenceAt = html.indexOf('id="fenceFrom"');
  const buttonAt = html.indexOf('id="fenceFromLocate"');
  const mapAt = html.indexOf('id="watchMap"');
  assert.ok(mapAt > step4At, 'the map is not in the watching section');
  assert.ok(mapAt > listAt, 'the map was put above the list it plots');
  assert.ok(sentenceAt > listAt && sentenceAt < mapAt,
    'the sentence describing the circle is not directly above the map that draws it');
  assert.ok(buttonAt > listAt && buttonAt < mapAt,
    'the button that moves the circle is not with the sentence it belongs to');
  // And nothing of it is left behind among the type rows it used to sit under.
  assert.ok(mapAt > html.indexOf('id="typeList"'),
    'a map is still drawn among the type rows it used to sit under');

  // The code still draws it, and now draws the circle itself.
  assert.match(appJs, /renderMap\(\) \{/, 'renderMap has gone');
  assert.match(appJs, /locmap-fence/, 'the circle is no longer drawn on the one map');
});

test('the one map draws the circle AND the aircraft, with no second map to keep in step', () => {
  // 🔴 George, 22 Sep 2026: *"i think the circle in the first map can be added to the second map,
  // then the first map can be removed"*.
  //
  // The guard this replaces required the second map NOT to work out its own zoom, and to be handed
  // the first map's frame instead, so the two could not disagree about where a place is. That was
  // the right rule while there were two maps — and it is exactly the thing that had to go. With one
  // map the sharing is not a virtue but the coupling itself, so this asserts the merge instead: ONE
  // renderer, which works out its own frame and draws both the circle and the aircraft.
  const html = read(SITE, 'index.html');
  assert.match(html, /<div id="watchMap"><\/div>/, 'the map has no place on the page');
  assert.equal((html.match(/id="watchMap"/g) ?? []).length, 1, 'the map exists more than once');
  assert.ok(html.indexOf('id="watchMap"') > html.indexOf('id="step-4"'),
    'the map was not put in the watching section');
  assert.ok(html.indexOf('id="watchMap"') > html.indexOf('id="watchList"'),
    'the map was put above the list it plots');

  // The second map is gone — the method, the call to it, and the frame it used to be handed. The
  // comments in the source may still discuss the old frame as history; the SHIPPED code must not
  // mention it at all, which is why this is asked of the stripped bundle.
  assert.equal(/renderWatchMap/.test(appJs), false, 'the second map is still in the shipped code');
  assert.equal(/lastFrame/.test(appJs), false,
    'the shared frame is still in the shipped code, so the map may still be standing in it');

  const body = method('renderMap() {', 'bindMapResize() {');
  assert.ok(body.length > 500, 'the map body could not be isolated, so this check is vacuous');

  // It draws the circle, and it draws the aircraft — that is what adding the circle to the second
  // map means.
  assert.match(body, /locmap-fence/, 'the circle is not drawn on the one map');
  assert.match(body, /locmap-plane-mark/, 'the aircraft are not drawn on the one map');
  // And it works its own frame out, because there is nothing left to share it with.
  assert.match(body, /fittest\(/, 'the one map does not compute its own zoom');

  // 🔴 AND THE MAP STAYS UP WHEN THERE IS NOTHING ON IT. George, 21 Sep 2026: *"can you leave the
  // map up even if there are no planes in the air"*. The empty case must not return early with a
  // paragraph where the map should be: the map is drawn either way, the circle is still on it, and
  // the sentence explaining the emptiness goes underneath.
  assert.match(body, /Nothing you are watching is inside the fence/i,
    'the empty map says nothing about why it is empty');
  assert.match(body, /it stays where it is/i, 'the empty map does not say that it will stay');
  assert.equal(/if \(watching\.length === 0\) \{\s*const empty/.test(body), false,
    'the map is replaced by a paragraph when nothing is in the air, instead of being left up');
  // 🔴 AND NOTHING IS WRITTEN WHEN NOTHING HAS CHANGED. George, 21 Sep 2026: *"can you stop
  // updating when there are no plans in the air?"* — with no aircraft the markup is identical on
  // every poll, so the write has to sit behind the comparison for that to cost nothing.
  assert.ok(body.indexOf('const html =') > -1 && body.indexOf('const html =') < body.indexOf('if (html !== this.lastPlot)'),
    'the map is not assembled before the comparison, so this check would be vacuous');
  assert.match(body, /if \(html !== this\.lastPlot\) \{\s*this\.lastPlot = html;\s*host\.innerHTML = html;/,
    'the map is written on every poll instead of only when it changes');
});

test('a watched row reports what it is doing, and keeps its way out', () => {
  // 🔴 George, 21 Sep 2026: *"i want to change stop watching into a status code, like 'in the
  // air', and if not in there air i want a different explanation why its not on the map"*.
  const html = read(SITE, 'index.html');
  const app = readSrc('src/app.ts');
  const css = read(SITE, 'styles.css');

  // The status exists for both kinds of row, and the words it replaced are gone.
  assert.match(app, /private watchStateOf\(/, 'watchStateOf has gone');
  assert.match(app, /private watchStateOfTail\(/, 'watchStateOfTail has gone');
  assert.equal(/>\s*stop watching</.test(app), false,
    'a row still prints "stop watching" where the status belongs');
  // The way out survives as a small labelled ✕ — an unlabelled glyph is unreachable to a screen
  // reader, and removing it outright would leave a rule nobody could clear.
  assert.match(app, /aria-label="Stop watching \$\{escapeHtml\(info\.name\)\}"/,
    'the way out lost its name for a screen reader');
  assert.match(app, /aria-label="Stop watching \$\{escapeHtml\(item\)\}"/,
    'the named-aircraft way out lost its name for a screen reader');
  // It is still WIRED, not just present.
  assert.match(html, /id="watchList"/, 'the list is gone');
  assert.match(app, /querySelectorAll<HTMLButtonElement>\('\.type-remove'\)/,
    'the type way out is never bound');

  // 🔴 THE STATUS MUST BE REFRESHED ON EVERY POLL, OR IT LIES. It was written only when the row
  // was built, and a measured row read "not on the map — seen 2 hours ago" while the map beside it
  // was plotting that very aircraft.
  const start = app.indexOf('private renderAircraft');
  const end = app.indexOf('\n  private ', start + 1);
  const table = app.slice(start, end);
  assert.ok(table.length > 200, 'the renderAircraft body could not be isolated, so this check is vacuous');
  assert.match(table, /this\.tickWatchStates\(\);/, 'the status is never refreshed by a poll, so it goes stale');
  assert.match(app, /private tickWatchStates\(\): void/, 'tickWatchStates has gone');
  // And refreshing must not rebuild the list — that costs the reader their scroll and selection.
  const tick = app.slice(app.indexOf('private tickWatchStates'), end > 0 ? app.indexOf('\n  private ', app.indexOf('private tickWatchStates') + 1) : undefined);
  assert.equal(/innerHTML/.test(tick), false, 'the status refresh rebuilds the whole list to change a few words');

  // The status is computed from facts, not written from hope.
  const state = app.slice(app.indexOf('private watchStateOf('), app.indexOf('private watchStateOfTail'));
  assert.match(state, /count > 0/, 'the status can say "in the air" without an aircraft in the air');
  assert.match(state, /this\.lastSeenOf\(code\)/, 'the reason it is not on the map is never looked up');
  // 🔴 EVERY STATUS IS A TIME. George, 21 Sep 2026: *"not on the map — never caught here people
  // will not understand this. make the messatge can be time related like was on map x hours ago,
  // or minutes from now()"*.
  assert.match(state, /this\.agoText\(at\)/, 'the status does not say how long ago the type was seen');
  // The longer explanation rides on the element rather than lengthening the column — and it must be
  // refreshed with the wording, or it describes the status the row used to have.
  assert.match(app, /class="watch-state"[\s\S]{0,200}?title="\$\{escapeHtml\(state\.why\)\}"/,
    'the status carries no explanation for the reader who wants one');
  assert.match(app, /if \(state\.title !== next\.why\) state\.title = next\.why;/,
    'the explanation goes stale while the wording is refreshed');
  assert.match(app, /private agoText\(at: Date\): string/, 'the relative-time wording has gone');
  assert.match(state, /this\.historySpanDays\(\)/,
    'a type with no sighting is not given the span the record actually covers');
  assert.equal(/never caught here/.test(state), false,
    'the status still uses wording the reader cannot follow');
  // The longer explanation rides on the element rather than lengthening the column. `[\s\S]`
  // rather than a negated backtick: the markup is built from two template literals, so the gap
  // between the class and the title contains one.
  assert.match(app, /class="watch-state"[\s\S]{0,160}?title="\$\{escapeHtml\(state\.why\)\}"/,
    'the status carries no explanation for the reader who wants one');
  assert.match(app, /if \(state\.title !== next\.why\) state\.title = next\.why;/,
    'the explanation goes stale while the wording is refreshed');

  // The column is at the right of the row, does not wrap, and the cells have their margins back.
  assert.match(css, /\.watch-list > li\s*\{[^}]*padding:\s*9px 12px/s,
    'the rows have no left and right margins inside the cell');
  assert.match(css, /\.watch-list \.watch-state\s*\{[^}]*margin-left:\s*auto/s,
    'the status is not in the column at the right of the row');
  assert.match(css, /\.watch-list \.watch-state\s*\{[^}]*white-space:\s*nowrap/s,
    'a status can wrap onto a second line, which breaks the column it exists to form');
});

test('the map mark is an aeroplane, then the type, then the tail', () => {
  // 🔴 George, 21 Sep 2026: *"in the map, i want to see the images of the plane and the aircraft
  // type, then the tail"*.
  const app = readSrc('src/app.ts');
  const css = read(SITE, 'styles.css');
  const start = app.indexOf('private renderMap');
  const end = app.indexOf('\n  private ', start + 1);
  const body = app.slice(start, end);
  assert.ok(body.length > 200, 'the renderMap body could not be isolated, so this check is vacuous');

  assert.match(app, /const PLANE_PATH =/, 'the aeroplane shape has gone');
  assert.match(body, /PLANE_PATH/, 'the mark is not drawn from the aeroplane shape');
  assert.equal(/locmap-plane\b(?!-)/.test(body), false, 'the mark is still a plain dot');
  // 🔴 THE NAME IS THE AEROPLANE'S WHOLE NAME, NOT ITS CODE. George, 21 Sep 2026: *"i want the
  // map identifying planes by their full airplane name Cirrus SR22T like this"*. The type list
  // has always named aircraft in full; the map was the last place still speaking in codes.
  assert.match(body, /describeType\(one\.type\)/, 'the mark names the aircraft by its code instead of its name');
  assert.match(body, /const name = info\.code \? \(info\.known \? info\.name : info\.code\) : 'type not transmitted'/,
    'the name does not fall back honestly for a code this site cannot name');
  assert.ok(body.indexOf('const name =') < body.indexOf('const tail ='),
    'the tail is placed before the name, and the order asked for is the aeroplane then the tail');
  assert.match(body, /\.join\(' · '\)/, 'the name and the tail are not joined into one label');
  // A value the feed did not transmit is absent or named as absent — never invented.
  assert.match(body, /type not transmitted/, 'a missing type is not named as missing');

  assert.match(css, /\.locmap-plane-icon\s*\{/, 'the aeroplane mark has no styling');
  assert.match(css, /\.locmap-plane-label\s*\{/, 'the mark label has no styling');
});

/* --------------------------------- part 15 · a status is not frozen wrong --- */

/**
 * One method's body, sliced out of THE SHIPPED BUNDLE by the names either side of it.
 *
 * 🔴 SLICED FROM `site/app.js`, NOT FROM `src/app.ts`, AND THE DIFFERENCE IS NOT ACADEMIC. On
 * 21 Sep 2026 a restructure was present in the source and absent from the bundle — the build was
 * stale, or the edit was reverted after it — and only reading the shipped file proved it. The
 * browser opens one of these two files, so that is the one every guard below judges.
 *
 * ⚠️ AND `private` IS NOT IN THERE. TypeScript erases access modifiers when it emits, so a
 * pattern written from the source (`private async loadSurvey(`) matches nothing and reports a
 * false failure against a correct build. Every boundary below was read out of the bundle rather
 * than assumed.
 *
 * 🔴 BOTH NAMES CARRY THEIR OPENING BRACE, because `this.renderWatchlist();` is also a match for
 * `renderWatchlist()` and a call site comes FIRST in the file. Slicing from a call site reads
 * somebody else's code and reports a pass — a false pass, which is worse than a false failure,
 * because nothing tells the reader to look.
 *
 * 🔴 AND THE SLICE MUST HOLD EXACTLY ONE METHOD. A byte limit was tried first and it was a guess
 * that had to be re-guessed: `renderMap` is 8,358 characters of emitted code and the limit was
 * 8,000, so a CORRECT boundary was rejected. Counting method definitions is exact instead — if the
 * end marker is not the very next method, the ones it skipped appear inside the slice and the count
 * is not zero. The pattern demands a definition (indented four spaces, ending `) {`), so a call
 * site or a continued expression cannot be mistaken for one.
 */
function method(name, nextName) {
  const start = appJs.indexOf(name);
  assert.ok(start > -1, `${name} is not in the shipped bundle`);
  const end = appJs.indexOf(nextName, start + 1);
  assert.ok(end > start, `${nextName} could not be found, so the check for ${name} is vacuous`);
  const body = appJs.slice(start, end);
  const skipped = body.match(/\n    [A-Za-z_][A-Za-z_0-9]*\([^\n]*\)\s*\{\n/g) ?? [];
  assert.equal(skipped.length, 0,
    `${nextName} is not the method after ${name} — the slice swallowed ${skipped.length} more ` +
      `(${skipped.map((line) => line.trim()).join(', ')}), so these checks would be reading code ` +
      'this test did not name');
  return body;
}

/**
 * 🔴 GEORGE, 22 SEP 2026: *"they were all not seen yet, but when i deleted one, the rest were all
 * last seen. seems like a buy race codition"* — and it reads like a race because the truth appeared
 * the moment he touched something. It is not a race. It is a status computed before its source had
 * been read, and then FROZEN by a guard that did not know the source was an input.
 *
 * The rows are drawn in `start()` the instant a kept selection is restored, and the record they are
 * judged against — `types.json` — is still in flight. So every row took the branch that means "the
 * record has been read and holds nothing" while the record had not been read at all. Then nothing
 * could correct it: `tickWatchStates` skipped its whole pass because the live set had not changed,
 * and neither loader redrew the watching rows. Deleting a row ran the first full rebuild since the
 * record landed, which is why the fix appeared to come from the delete.
 *
 * These four checks are the shape of that failure. Each one fails against the code that shipped it.
 */
test('87 · a status is never claimed before the record it is judged against has been read', () => {
  const body = method('watchStateOf(', 'watchStateOfTail(');

  // The record's arrival is tracked separately from the record itself: "not read yet" and "read and
  // empty" are different facts and must not share a sentence.
  assert.match(appJs, /surveyRead = false/, 'nothing records whether the record has been read');
  assert.match(body, /if \(!this\.surveyRead\)/, 'a status is stated before the record has been read');
  assert.match(body, /'checking…'/, 'a row says nothing about the wait while the record is in flight');
  assert.match(body, /'no record'/, 'a refused record is not named as refused');
  // And the false claim itself is gone: it may only be reached when the record is in hand.
  const claimed = body.indexOf("text: 'not seen yet'");
  const guarded = body.indexOf('if (!this.surveyRead)');
  assert.ok(guarded > -1 && claimed > guarded,
    'the "not seen yet" sentence is reachable without the record having been read');
});

test('88 · the status guard is keyed on every input the status is written from', () => {
  // 🔴 A GUARD KEYED ON PART OF ITS INPUTS DOES NOT PREVENT WORK — IT MAKES A WRONG ANSWER
  // PERMANENT. The key covered the live feed only, so the record arriving could not change it.
  assert.equal(/lastLiveKey/.test(appJs), false, 'the guard still ignores the record it judges against');
  const key = appJs.slice(appJs.indexOf('const statusKey ='));
  assert.match(key.slice(0, 400), /this\.surveyRead/, 'the guard key ignores whether the record has been read');
  assert.match(key.slice(0, 400), /this\.yearsDoc/, 'the guard key ignores the years list the year tag comes from');
  // The emitted `if` is broken across two lines by the compiler, so the pattern tolerates the
  // break: a check that demanded one line would fail against a correct build, and a false
  // failure is the expensive kind.
  assert.match(appJs, /if \(statusKey === this\.lastStatusKey\)\s*return;/,
    'the guard does not compare the full key');
});

test('89 · both documents redraw the watching rows when they land', () => {
  // The refresh has to be able to lift the guard, or the pass it depends on is still skipped.
  const refresh = method('refreshWatchRows() {', 'yearOf(');
  assert.match(refresh, /this\.lastStatusKey = '';/, 'the refresh cannot lift the guard');
  assert.match(refresh, /this\.renderWatchlist\(\);/, 'the refresh does not redraw the rows');

  const survey = method('async loadSurvey(', 'async loadYears(');
  const years = method('async loadYears(', 'static countMatching(');
  assert.match(survey, /this\.refreshWatchRows\(\);/,
    'the survey loader does not redraw the watching rows, so a row keeps whatever the record did not yet know');
  assert.match(years, /this\.refreshWatchRows\(\);/,
    'the years loader does not redraw the watching rows, so the year tag is missing from a kept selection');

  // The refused path counts too — the catch in `loadSurvey` returns early, and a reader whose
  // record failed to load is exactly the reader who must not be left on a stale claim.
  assert.equal((survey.match(/this\.refreshWatchRows\(\);/g) ?? []).length, 2,
    "only one of the survey loader's two exits redraws the rows");
});

test('90 · the rows on the list are the ones being watched, and each says how to stop', () => {
  // George, 22 Sep 2026, on the same section: *"Everything you have picked, in one place, with the
  // way to stop watching each one, and a map of where those aircraft are right now. The table below
  // lists only what is on this list."*
  const body = method('renderWatchlist() {', 'renderWatchButton() {');
  assert.ok(body.length > 400, 'the watch list body could not be isolated, so this check is vacuous');
  // The class is one of several in the attribute — `class="linkish type-remove"` — so the
  // pattern matches the word inside the attribute rather than the start of it. Demanding
  // `class="type-remove"` fails against correct markup, which is how this check first failed.
  assert.match(body, /class="[^"]*\btype-remove\b/,
    'a watched type has no way to stop watching it');
  assert.match(body, /class="[^"]*\bwatch-remove\b/,
    'a watched tail number has no way to stop watching it');
  // The list is built from the rules actually kept — not from the table, which is every type.
  assert.match(body, /this\.typeRules/, 'the list is not built from what is being watched');
  assert.match(body, /this\.watchlist/, 'named aircraft on the list are not built from the list');
  assert.match(body, /watch-state/, 'a row does not say what the aircraft is doing');

  // 🔴 THE MAP IS NOT BUILT BY THIS METHOD, SO THIS IS NOT WHERE TO LOOK FOR IT. It is written
  // into a host element the page already carries, inside the same section as the list — the check
  // is that the host exists in the page, and that something draws into it. Asking `renderWatchlist`
  // to contain the map was a check that disagreed with the code it was checking.
  assert.match(htmlCode, /id="watchMap"/, 'the page has no host for the map of positions');
  assert.match(appJs, /byId\('watchMap'\)/, 'nothing draws into the map of positions');
  const section = htmlCode.slice(htmlCode.indexOf('id="step-4"'), htmlCode.indexOf('id="live"'));
  assert.ok(section.length > 200, 'the watching section could not be isolated, so this is vacuous');
  assert.ok(section.indexOf('watchList') > -1, 'the watching list is not in the watching section');
  assert.ok(section.indexOf('watchMap') > -1,
    'the map of positions is not in the watching section, so the two are not in one place');
});

/* --------------------- part 16 · which way it points, and where it has been --- */

/**
 * George, 22 Sep 2026, of the lower map:
 *
 *   "are you able to trace its flight?  the icon is always an airplane pointing up, but the
 *    airplane should point towards its trajectory"
 *
 * Both were already in the feed and were being thrown away — `track` was on every aircraft in a
 * live Hamilton response and was not in the `Reading` interface at all. These guards hold the two
 * things that would make the feature lie rather than the two things that make it work: an aeroplane
 * that points NORTH when the feed said nothing, and a "flight path" joined from a single point.
 */
test('91 · the aeroplane points along its track, and points nowhere in particular when there is none', () => {
  const body = method('renderMap() {', 'bindMapResize() {');
  assert.ok(body.length > 500, 'the map body could not be isolated, so this check is vacuous');

  // 🔴 ROTATION IS DRIVEN BY THE FEED'S OWN TRACK, not by a hard-coded direction and not by the
  // direction the aircraft moved between two polls — which is unavailable on the first sighting and
  // wrong on any turn.
  assert.match(body, /typeof one\.trackDeg === 'number'/,
    'the mark does not ask whether a heading was transmitted');
  assert.match(body, /rotate\(\$\{one\.trackDeg\.toFixed\(1\)\}\)/,
    'the mark is not rotated by the heading the feed sent');
  // And no heading means NO rotation — the shape points north on its own, so a default of 0 here
  // would assert the aircraft is heading north.
  assert.match(body, /_?:\s*''/m, 'a missing heading is not left un-rotated');
  assert.match(appJs, /PLANE_PATH/, 'the aeroplane shape has gone');
  // The heading must reach the map at all: the engine's snapshot is what carries it.
  assert.match(stripJs(read(SITE, 'detect.js')), /trackDeg/,
    'the engine does not carry a heading for the map to draw');
});

test('92 · a flight path is drawn, under the aircraft, only where there is a path', () => {
  const body = method('renderMap() {', 'bindMapResize() {');

  // A path takes TWO points. One point is a position, and joining one point would draw a line that
  // says something the page does not know.
  assert.match(body, /trail\.length >= 2/,
    'a path can be drawn from a single point, which is not a path');
  assert.match(body, /class="locmap-trail"/, 'no path is drawn on the map');

  // 🔴 UNDER EVERYTHING. The paths are collected separately and laid down before the marks, so a
  // path can never be drawn across the aeroplane it belongs to.
  const pathsAt = body.indexOf('paths +');
  const marksAt = body.indexOf('marks +', pathsAt + 1);
  assert.ok(pathsAt > -1, 'the paths are never placed on the map');
  assert.ok(marksAt > pathsAt, 'the paths are drawn over the aircraft instead of under them');
  assert.match(appJs, /let paths = ''/, 'the paths are not kept apart from the marks');

  // The legend appears only when a path is actually there — a key for a line that is absent sends
  // the reader looking for something that is not on the map.
  assert.match(body, /traced > 0/, 'the note does not check whether a path is on the map');

  assert.match(css, /\.locmap-trail\s*\{/, 'the path has no styling');
  assert.match(css, /\.locmap-trail\s*\{[^}]*stroke-linejoin:\s*round/,
    'the path has no round joins, so a turn grows a spike at the corner');
});

/* ------------------- part 17 · the memory the page must not throw away --- */

/**
 * 🔴 GEORGE, 22 SEP 2026, found while merging the maps: *"i think the circle in the first map can be
 * added to the second map, then the first map can be removed"*.
 *
 * Moving the distance slider calls `rearm()`, and `rearm()` builds a NEW `DetectionEngine`. A new
 * engine has no history — so a reader who nudged the distance lost the trail behind every aircraft
 * on the map. It was invisible for as long as a track held only a phase and a position, and it became
 * visible the moment a flight path was drawn. The fix is a handover, and this holds it in place.
 */
test('93 · a re-aim hands the remembered tracks over instead of starting from nothing', () => {
  assert.match(appJs, /adoptTracks\(/, 'the engine has no way to carry what it remembers across a re-aim');
  assert.match(stripJs(read(SITE, 'detect.js')), /adoptTracks\(previous/,
    'the shipped engine does not implement the handover');

  const body = method('rearm() {', 'updateSteps() {');
  assert.ok(body.length > 200, 'the rearm body could not be isolated, so this check is vacuous');
  // The engine being replaced has to be kept BEFORE it is replaced, or there is nothing to hand over.
  const kept = body.indexOf('const before = this.engine');
  const replaced = body.indexOf('this.engine = new DetectionEngine(');
  assert.ok(kept > -1, 'the re-aim does not keep the engine it is replacing');
  assert.ok(replaced > kept, 'the engine is replaced before it is kept, so the handover has nothing to pass');
  assert.match(body, /this\.engine\.adoptTracks\(before\)/,
    'the re-aim builds a new engine and never hands it the tracks, so every flight path is lost');

  // 🔴 AND THE HANDOVER IS READ FROM THE SHIPPED ENGINE, NOT FROM THE SOURCE. TypeScript erases the
  // type annotations when it emits, so `adoptTracks(previous: DetectionEngine | null): void` is
  // `adoptTracks(previous)` in the file the browser runs — a pattern taken from the source matches
  // nothing there and reports a failure against code that is correct. Sliced from `adoptTracks` to
  // the method after it, so the window is the handover and not whatever happens to follow.
  const engine = stripJs(read(SITE, 'detect.js'));
  const from = engine.indexOf('adoptTracks(previous) {');
  const to = engine.indexOf('ingest(', from + 1);
  assert.ok(from > -1 && to > from, 'the handover could not be isolated, so this check is vacuous');
  const handover = engine.slice(from, to);
  assert.match(handover, /this\.tracks\.set\(track\.hex/,
    'the handover does not copy the tracks it is supposed to carry');

  // 🔴 AND THE COOLDOWN IS NOT CARRIED. A re-aim is a new question about a new area, and a fresh
  // cooldown there can only produce a notification the reader would rather have than miss. Asked of
  // the handover alone — the old form of this check searched a fixed distance past the method name
  // and could reach into the next method entirely.
  assert.equal(/firedAt/.test(handover), false,
    'the handover carries the departure cooldown as well, which would silence a real departure');
});
