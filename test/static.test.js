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
  assert.match(htmlCode, /<section class="card" id="step-3">/);
  assert.match(htmlCode, /id="typeList"/);
  assert.match(htmlCode, /id="typeFilter"/);
  assert.match(htmlCode, /measured, not remembered/i);
});

test('what you are watching is its own section, and tail numbers are optional', () => {
  assert.match(htmlCode, /<section class="card" id="step-4">/);
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
  assert.match(survey.method, /rounds? of \d+ nm/);
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
  assert.match(source, /military: 'Warplanes'/, 'the class is not called Warplanes');
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
