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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SITE = join(ROOT, 'site');

const HOST = 'airplane-watch.nodejavascript.com';
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

/**
 * The text between two anchors — and LOUD when it cannot be found.
 *
 * 🔴 WHY THIS EXISTS. On 22 September 2026 the static suite was run for the first time in weeks and
 * ~106 checks reported NOTHING, because one malformed callback refused the whole file. When the file
 * could load again, the failures that followed were mostly the SAME defect in a quieter form: a slice
 * written `src.slice(src.indexOf(A), src.indexOf(B))` where A or B had been renamed, or where B sat
 * BEFORE A. `indexOf` answers -1 for a missing anchor, so the slice either ran from the last character
 * or came back empty — and a check that matches nothing asserts nothing while appearing to pass.
 *
 * **A MISSING ANCHOR IS A DEFECT IN THE CHECK, NOT A FACT ABOUT THE PAGE.** So this throws with the
 * anchor's name: an instrument that cannot find what it is measuring must say so, never report a
 * vacuous pass. One real instance: *"the start-over reset could not be isolated"* — the slice read the
 * page's HTML looking for two TypeScript method names, and had been empty since it was written.
 */
/**
 * The numbers the page spells out, for checks that compare code to copy.
 *
 * The cadence is written in words on the page — *"every twenty seconds at first"* — and in digits in the
 * code (`POLL_START_MS = 20_000`). A check that compares one to the other needs the mapping, and it needs
 * it in one place: a second copy would be a second thing to keep in step.
 */
const WORD_NUMBERS = {
  ten: 10, fifteen: 15, twenty: 20, 'twenty-five': 25, thirty: 30, 'forty-five': 45, sixty: 60,
};

function between(source, from, to, what = 'this slice') {
  const a = source.indexOf(from);
  if (a < 0) throw new Error(`${what}: the start anchor ${JSON.stringify(from)} is not in the source`);
  // 🔴 THE END ANCHOR IS LOOKED FOR *AFTER* THE START, AND THAT IS NOT A DETAIL.
  // Searching the whole source finds the FIRST occurrence, which is frequently some earlier element:
  // `between(html, 'id="radiusRefreshed"', '</p>')` reported *"`</p>` comes BEFORE …"* because an
  // unrelated paragraph closed 400 lines up the page. A slice means "from here to the next thing", so
  // the second anchor is searched from the start's own end. That was a false failure in this helper —
  // and a false failure is worse than no check, because it teaches the reader to ignore the instrument.
  const b = source.indexOf(to, a + from.length);
  if (b < 0) {
    const elsewhere = source.indexOf(to);
    throw new Error(elsewhere < 0
      ? `${what}: the end anchor ${JSON.stringify(to)} is not in the source`
      : `${what}: the end anchor ${JSON.stringify(to)} appears only BEFORE ${JSON.stringify(from)}`);
  }
  return source.slice(a, b);
}

/** Strip /* *\/ from CSS, for the same reason — a comment that names a rule is not that rule. */
function stripCss(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

const html = read(SITE, 'index.html');
const htmlCode = stripHtml(html);
const css = read(SITE, 'styles.css');
const cssCode = stripCss(css);
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
  assert.match(header, /<b>Airplane Watch<\/b>/);
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

/* 🔴 AND THE REPOSITORY IS LINKED — IF THERE IS ONE A STRANGER CAN OPEN (added 23 September 2026).

House part 4, George 19 September 2026, verbatim: *"another rule, if the repo is public link it in the
bottom where the full url expect the https::"* — so the footer points at the repository **and prints
where it goes**, rather than a phrase like *"the source"*, because the reader can then see the
destination before they click. A **private** repository is not linked at all.

AND THE CHECK READS THE ANSWER OUT OF THE CLONE, not out of a literal. `github.com/nodejavascript/
airplane-watch` typed here would be a fifth copy of the repository's own name, and the day it moves it
would be the copy nobody updates (house standard 6c). The remote is what this checkout actually is.

⚠️ **IT DELIBERATELY DOES NOT ASK WHETHER THE REPOSITORY IS PUBLIC.** That is a fact about a forge,
and a unit suite reads files — so it returns silently when the footer links no repository at all,
which is the correct state for a private one and must never be a failure. Publicness belongs to
`~/.nodejs_compliance.py` part 12, which reads both forges in one call each. */
test('4 · a repository linked in the footer shows the ADDRESS, and names the one this clone is', () => {
  const footer = htmlCode.match(/<footer[\s\S]*?<\/footer>/)[0];
  const links = [...footer.matchAll(/<a href="https:\/\/github\.com\/([^"]+)"[^>]*>([^<]+)<\/a>/g)];
  if (links.length === 0) return; // a private repository is not linked at all — not a failure
  assert.equal(links.length, 1, `the repository is linked ${links.length} times`);

  const href = links[0][1];
  const text = links[0][2].trim();
  assert.equal(text, `github.com/${href}`,
    'the repository link shows a label instead of the address, so the reader cannot see where it goes');

  const remote = execFileSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = /github[\w.-]*[:/]+([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  assert.ok(m, `the origin remote is not a GitHub URL, so this check cannot judge the link: ${remote}`);
  assert.equal(href, `${m[1]}/${m[2]}`, 'the footer names a different repository than this clone points at');
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

  // 🔴 OUR OWN ROW IS NOT A CLASH WITH OURSELVES (23 September 2026).
  //
  // House part 5 rule 4 says a site is ADDED TO THE REGISTER on the day it is deployed — and the
  // moment this site was added, this check started failing against itself: it reported *"these are
  // already taken by a live site: theme colour #38bdf8, background #04101a"* and the only row
  // holding those values was **this site's own**. A false failure is the expensive kind (part 6),
  // and this one blocked the project's own deploy, because `deploy.sh` runs this suite.
  //
  // AND THE TEXTURE IS READ FROM OUR OWN ROW rather than pinned here. It was a literal
  // (`'1 radial + 2 linear'`) while the site's drawing had already changed to
  // `3 radial + 2 linear + 1 conic + masked` — a check asserting a value that had outlived its
  // subject, which is house standard 6c. Comparing the register's own record of us is the one form
  // that cannot rot: if the drawing changes, the register changes with it.
  const hostOf = (row) => String(row.host || row.site || row.name || '');
  const mine = rows.find((row) => hostOf(row).startsWith('airplane-watch'));
  const others = rows.filter((row) => row !== mine);

  const clashes = [];
  if (others.some((row) => String(row.theme).toLowerCase() === THEME)) clashes.push(`theme colour ${THEME}`);
  if (others.some((row) => String(row.background).toLowerCase() === BACKGROUND)) clashes.push(`background ${BACKGROUND}`);
  const myTexture = String(mine?.texture || '').toLowerCase();
  if (myTexture && others.some((row) => String(row.texture).toLowerCase() === myTexture)) {
    clashes.push(`background image (${myTexture})`);
  }
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

test('the reader is offered KILOMETRES, and never the word "nm" in a label', () => {
  // "nobody understand nm" — George, 20 Sep 2026. A nautical mile is an aviation
  // unit and a visitor arriving here is not obliged to know one, so distances the
  // READER MEETS are in km. The word may appear in a comment explaining the
  // conversion, which is why the comments are stripped first.
  //
  // 🔴 AND THE UNIT NOW LIVES IN THE CODE, NOT IN THE MARKUP. The distance chips are built by
  // `buildRadiusButtons()`, so `index.html` carries no distance at all any more — this check used to
  // read the page and pass, and it read the page and failed the moment the chips moved into script. The
  // rule is unchanged; the place it can be read from is the chip's own label and tooltip.
  const visible = htmlCode + css.replace(/\/\*[\s\S]*?\*\//g, '');
  const app = readSrc('src/app.ts');
  assert.equal(/\bnm\b/.test(htmlCode), false, 'the page shows "nm" to the reader');
  assert.match(app, /km === RADIUS_ALL \? 'All' : `\$\{km\} km`/,
    'the distance chips do not print kilometres');
  assert.match(app, /`\$\{km\} kilometres`/, 'the tooltip never says the distances are kilometres');
  assert.ok(visible.length > 0);
});

test('the type section exists and says the list is measured, not remembered', () => {
  // ⚠️ TOLERANT OF THE REST OF THE TAG, because the section carries its step class and its
  // hidden state as well — a pattern demanding `class="card"` exactly failed a correct page.
  assert.match(htmlCode, /<section[^>]*class="[^"]*\bcard\b[^"]*"[^>]*id="step-2"/);
  assert.match(htmlCode, /id="typeList"/);
  assert.match(htmlCode, /id="typeFilter"/);
  // The sentence changed with the section: it now says the list is what was MEASURED, in those words.
  assert.match(htmlCode, /measured from the feed/i);
});

test('what you are watching is its own section, and tail numbers are optional', () => {
  const app = readSrc('src/app.ts');
  assert.match(htmlCode, /<section[^>]*class="[^"]*\bcard\b[^"]*"[^>]*id="step-3"/);
  assert.match(htmlCode, /<ul class="watch-list" id="watchList"><\/ul>/);
  // 🔴 THE RULE IS THAT A TYPE CAN BE WATCHED WHOLE OR NARROWED TO TAIL NUMBERS, and it is still true —
  // but the box it used to be asked in is gone. *Prior assertion, preserved and now dead:* the page was
  // checked for the words "Narrow to a tail number", which was a text box inside every watched row.
  // George removed that row ("no more features"), and tails are now ticked where the types are, so the
  // rule is read where it lives: a rule with tails is a narrowed rule.
  assert.match(app, /const narrowed = rule\.tails\.length > 0/,
    'nothing distinguishes a whole-type rule from one narrowed to tail numbers');
});

test('the range limiter is on the page, not hidden behind a wrong number', () => {
  // Measured 20 Sep 2026: seven airports polled back to back had five refused by
  // the third round. Hiding that behind "0 aircraft" would be a lie about a rate
  // limit, and the reader would think the sky was empty.
  //
  // 🔴 THE SENTENCE IS WRITTEN IN SCRIPT, SO IT IS READ THERE. The page's markup no longer carries the
  // reader-facing words at all — `feedTrouble()` composes them — and this check had been reading the
  // markup for "429" and for "slow down", which is a fact about where a sentence lives rather than
  // about whether the rate limit is explained.
  const app = readSrc('src/app.ts');
  assert.match(app, /status === 429/);
  assert.match(app, /The feed asked us to slow down \(HTTP 429\)/,
    'a rate limit is still not explained to the reader in the response the page would show');
  assert.match(appJs, /status === 429/);
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

/**
 * A source file WITH its comments still in it.
 *
 * 🔴 WHY BOTH READERS EXIST, AND WHY THE SECOND ONE IS NOT LAZINESS. `readSrc` strips comments on
 * purpose: *"a comment that names a rule is not that rule"* is the whole point, because a check that
 * accepts a comment where code was required is a check that passes on an intention. But some rules are
 * ABOUT the record itself — *"the codes must cite the database they were read from"*, *"the file must
 * record why the user agent is required"* — and those are satisfiable ONLY in a comment, since
 * TypeScript has nowhere else to put a reason.
 *
 * **So both readers are needed, and using the wrong one produces a check that can never pass.** Three
 * assertions in this file were doing exactly that on 22 September 2026 (the type table's citation, the
 * user-agent reason in two files, and a refresh control that required a comment in comment-stripped
 * HTML). Each one reported a failure about a page that was already correct.
 */
const readRaw = (relative) => readFileSync(join(ROOT, relative), 'utf8');

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

test('the page has ONE flow, the status line sits outside it, and the header still has no nav', () => {
  const html = read(SITE, 'index.html');

  // 🔴 THIS TEST USED TO CHECK FOR TWO VIEWS, AND IT WAS RIGHT AT THE TIME. The page carried a
  // *choosing* view and a *live* view with three switchers between them, and the rules below were
  // written to keep them honest: the live view started hidden, and the status line sat OUTSIDE both of
  // them or a feed error would be invisible to a reader on the other one. The live view was deleted
  // when the map took over the board's job, so the checks are inverted: the switchers must be GONE
  // rather than present, and the two rules that still apply are kept.
  //
  // ⚠️ A CHECK THAT ASKS FOR A DELETED ELEMENT IS NOT A FAILING CHECK, IT IS A STALE ONE — and the
  // distinction matters, because "the page stopped drawing the old thing" is usually the point.
  assert.equal(/id="liveView"|id="liveChart"|id="liveBody"|data-view=/.test(html), false,
    'a switcher, a chart or a second view is back — the map is the only board now');

  // The status line still exists, and it still sits outside the gated flow: a feed error has to be
  // readable by a reader who has answered nothing yet.
  const status = html.indexOf('id="status"');
  assert.ok(status > -1, 'there is no status line at all');
  assert.ok(status < html.indexOf('id="step-1"'),
    'the status line sits inside the gated flow, so a feed error is invisible until step 1 is answered');

  // 🔴 AND IT IS NOT INSIDE A WRAPPER THAT WAS LEFT OPEN. Both of the following were TRUE of the
  // shipped page until 22 Sep 2026: `<div id="selectView">` was written TWICE — one duplicate id and
  // one element no parser could ever close — so the consent bar, the footer and every dialog were
  // nested inside a container nothing had referred to for weeks. A browser repairs that silently,
  // which is exactly why no one saw it.
  const bare = stripHtml(html);
  const opens = (bare.match(/<div\b[^>]*>/g) ?? []).length;
  const closes = (bare.match(/<\/div>/g) ?? []).length;
  assert.equal(opens, closes,
    `${opens} <div> elements are opened and ${closes} closed, so ${opens - closes} is left open and the browser is repairing the page`);
  const ids = [...bare.matchAll(/\sid="([^"]+)"/g)].map((one) => one[1]);
  const twice = [...new Set(ids.filter((one, at) => ids.indexOf(one) !== at))];
  assert.deepEqual(twice, [], `these ids appear more than once: ${twice.join(', ')}`);
  assert.equal((html.match(/id="selectView"/g) ?? []).length, 1, 'the container is on the page more than once');

  // The header is a brand bar and nothing else.
  assert.equal(/<nav[\s>]/.test(html), false, 'the header has grown a nav');
});

test('the map draws what the reader asked for, from the last reading, never everything', () => {
  const source = readSrc('src/app.ts');

  // 🔴 THIS CHECK USED TO BE ABOUT THE LIVE VIEW'S TABLE AND CHART, WHICH ARE GONE. The rules did not go
  // with them — the map inherited every one — so it is re-pointed rather than retired. Each assertion
  // below is one of the old ones, named at its new home:
  //
  //   the aircraft are filtered by the reader's own rules   →  engine.matchOf, in `isWatchedNow`
  //   an aircraft that matches nothing is not drawn          →  `matchOf(...) !== null`
  //   the board reads the same poll as the list              →  `this.lastReadings = readings`
  //   an aircraft on the ground is not in the air            →  `state.phase === 'airborne'`
  assert.match(source, /this\.engine\.matchOf\(\{/, 'the reader\'s own rules no longer decide what is drawn');
  assert.match(source, /\) !== null/, 'an aircraft that matches nothing would still be drawn');
  assert.match(source, /this\.lastReadings = readings;/, 'the board and the list no longer read the same poll');
  assert.match(source, /state\.phase === 'airborne'/, 'an aircraft on the ground can still count as in the air');

  // 🔴 AND THE ONE RULE THAT WAS ADDED AFTER THIS CHECK WAS WRITTEN, which is the reason it matters:
  // *"in the air messages should be vertically aligned … i click last 5 minutes. this should filter to the
  // airport i selected"* — George, 22 Sep 2026. Nothing may be counted, listed or drawn from a reading
  // that is outside the reader's own circle, however loud the feed is about it.
  assert.match(source, /if \(!this\.insideMyCircle\(reading\.lat, reading\.lon\)\) continue;/,
    'a reading outside the circle is counted, so a row can say "in the air" with nothing on the map');
  // And it is the SAME question the fence asks, asked in one place — two copies of it would drift.
  const fence = between(source, 'private insideFence', 'private insideMyCircle', 'the fence');
  assert.match(fence, /this\.insideMyCircle\(state\.lat, state\.lon\)/,
    'the fence answers the circle question itself instead of delegating, so the two can disagree');

  // A row the reader switched off is not drawn, and the switch is the reader's rather than a filter's.
  assert.match(source, /rowVisible\(one\)/, 'a row switched off is still drawn on the map');
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
  // ⚠️ `.viewbar` IS DELIBERATELY ABSENT. It styled the switcher bar between the two views, and the
  // switcher was deleted with the live view. A selector list is a description of what the page draws,
  // so an entry for something it no longer draws is a rule that keeps a deleted control looking alive.
  for (const selector of ['.nearby', '.near-chip', '.typerow-actions', '.tail-panel', '.tail-grid', '.tail-box', '.radar', '.radar-dot', '.sr-only']) {
    assert.ok(css.includes(selector), `${selector} has no style`);
  }
  assert.ok(!css.includes('.viewbar'), 'the stylesheet still styles the deleted view bar');
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
  // 🔴 RENAMED TWICE, AND BOTH NAMES WERE THE BUG. `Warplanes` put the Cessna 172 and the Dash 8
  // under a war label — the note above the table says so at length — and `Heritage & war planes` was
  // then one of the three widest chips on the filter row. George, 22 Sep 2026: *"make heritage & war
  // planes just heritage and anything tlse and & just use one word"*.
  assert.match(source, /military: 'Heritage',/, "the class is no longer called 'Heritage'");

  // And EVERY kind is one word, which is the instruction rather than a preference: an ampersand and a
  // second noun is what made three chips wide enough to wrap the row.
  const labels = source.slice(source.indexOf('const CLASS_LABEL'), source.indexOf('export function classLabel'));
  const named = [...labels.matchAll(/^\s+(\w+): '([^']+)',/gm)].map((one) => one[2]);
  assert.ok(named.length >= 7, `only ${named.length} kind labels were found`);
  for (const label of named) {
    assert.match(label, /^[A-Za-z]+$/, `the kind label "${label}" is not one word`);
  }
  assert.match(source, /LANC: \['Avro Lancaster', 'military'\]/, 'the Lancaster is not a warplane type');
  // 🔴 READ WITH COMMENTS ON: a citation is what a COMMENT is for, and `source` here is comment-stripped.
  // `tar1090-db` appears three times in the file and none of them survived stripping, so this assertion
  // could never pass — it was reporting a missing citation that was there the whole time.
  const raw = readRaw('src/typeinfo.ts');
  assert.match(raw, /tar1090-db/, 'the codes must cite the database they were read from');
  assert.match(raw, /C07DD7;C-GVRA;LANC/, 'the Lancaster entry must carry the line it was verified from');
  assert.match(raw, /NOT "every warplane"/, 'the class must say out loud that it is not every warplane');

  // 🔴 THE SHORT LIST MUST BE SHORT, HONEST AND **EVIDENCED**. The count below was 12–30 and the list
  // reached 35 — not by padding but by growing a second deliberate group (the serving military types:
  // C-130, C-17, Chinook, Poseidon, Osprey and the rest), so the bound was stale rather than the list
  // being wrong. **The bound is not the interesting part.** The property that actually stops padding is
  // that every entry shows what it was read from, so that is what is asserted now: a type added on a
  // hunch would have to invent a database count to get past this.
  const rawMil = readRaw('src/typeinfo.ts').split('\n').filter((one) => one.includes("', 'military']"));
  assert.ok(rawMil.length >= 30 && rawMil.length <= 45,
    `expected the historic and serving groups together, found ${rawMil.length}`);
  const uncited = rawMil.filter((one) => !/\/\/\s*(—\s*)?\d+/.test(one));
  assert.deepEqual(uncited, [],
    `these military entries carry no count from the database, so nothing says where they came from:\n${uncited.join('\n')}`);
  // Both groups are present, because they answer different questions and were added for different reasons.
  assert.ok(/LANC: \['Avro Lancaster'/.test(readRaw('src/typeinfo.ts')), 'the historic group is gone');
  assert.ok(/C130: \['Lockheed C-130 Hercules'/.test(readRaw('src/typeinfo.ts')), 'the serving group is gone');
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
    assert.match(readSrc(file), /user-agent/i, `${file} sends no user agent — measured: the feed answers 403`);
    // 🔴 AND THE REASON IS READ WITH THE COMMENTS LEFT IN. `readSrc` strips them, and the sentence that
    // records WHY the header is required is a comment in serve.mjs and in the worker — so the stripped
    // source can never contain the number, and this assertion reported a missing reason that was present.
    assert.match(readRaw(file), /403/, `${file} does not record why the user agent is required`);
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
  // 🔴 THE POSTAL CODE IS MATCHED BY SHAPE, NOT BY VALUE — 23 September 2026. This asserted
  // the absence of the owner's own postal code, which is a private item in a repository
  // that is now public. The pattern is also the stronger test, because it fails on ANY
  // Canadian postal code reaching the reader rather than only the one that was once here.
  // Proved able to fail: put a postal code into `site/index.html` and this goes red.
  assert.equal(/\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/.test(html), false,
    'the page still quotes a postal code at the reader');
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
  // ⚠️ THE STATE IS NAMED `on`, NOT `chosen.has(...)` INSIDE THE ATTRIBUTE. It is computed one line
  // above as `wholeType || chosen.has(normaliseKey(item.reg))` — because starring the whole type stars
  // every tail under it, and reading the star from the narrowed list alone left a favourited row with
  // no star anywhere below it. The chip still carries its highlighted state; it just carries the
  // answer rather than the question.
  assert.match(source, /aria-pressed="\$\{on\}"/, 'a tail chip does not carry its highlighted state');
  // 🔴 AND THE CHIP CARRIES NO STAR, WHICH IS A DECISION RATHER THAN A GAP. George, 20 Sep 2026:
  // *"remove start that are in chip, i just want the yellow hue only"* — six little stars down a row of
  // tail numbers was decoration on top of a colour that already said the same thing. So the assertion
  // that a highlighted tail "gets a little star" is retired, and the absence is asserted instead,
  // because a star quietly returning here would be a regression nobody would notice.
  assert.equal(/TAIL_STAR/.test(source), false, 'the per-chip star is back; the row is meant to carry the colour alone');
  // The un-favouriting is a consequence of the rule, not a separate step. If a
  // future edit adds a second mechanism they will drift apart. The words are a quote from George —
  // *"if they highlight a tail, un favourite the whole type"* — so the pattern tolerates the spelling
  // rather than pinning it, because the rule is what matters and the hyphen is not.
  // ⚠️ AND IT IS READ WITH THE COMMENTS LEFT IN. A quote is a comment; `readSrc` strips comments, so
  // this assertion could never see the sentence it was asking for.
  assert.match(readRaw('src/app.ts'), /un.?favourit\w* the whole type/,
    'the row does not say what highlighting a tail does');
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
  const html = read(SITE, 'index.html');
  // ⚠️ STEPS 2 AND 3, WHICH IS EVERY STEP THERE IS AFTER THE FIRST. This loop read `[2, 3, 4, 5]`
  // against a five-step flow that no longer exists — the distance step was folded into the card that
  // carries the map, and the flow was renumbered 1-2-3 on 22 Sep 2026. A check that walks a list of
  // step numbers is a check that has to be told when the flow changes; this one was not.
  for (const n of [2, 3]) {
    assert.match(html, new RegExp(`id="step-${n}"[^>]*hidden`), `step ${n} is visible before step 1 is answered`);
    assert.match(html, new RegExp(`data-step="${n}"`), `step ${n} carries no number for the gate to read`);
  }
  assert.match(html, /id="step-1" data-step="1"/, 'step 1 must be visible and numbered');
  // The heading is "Where you are", not "Where are you?" — the question-mark form was the wording for
  // one afternoon. What matters is that the first thing asked is where the reader is.
  assert.match(html, /id="step-1"[^>]*>[\s\S]{0,80}Where (are )?you/, 'the first step is not the one that asks where the reader is');

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
  // 🔴 AND THE NUMBERS A READER SEES ARE THE POSITIONS IN THE FLOW, 1-2-3, BECAUSE THEY WERE 1-3-4.
  // This is the assertion that would have caught it: three sections, numbered from one, with no gap.
  const numbers = [...html.matchAll(/class="step">(\d+)<\/span>/g)].map((one) => Number(one[1]));
  assert.deepEqual(numbers, [1, 2, 3], `the page numbers its steps ${numbers.join(', ')}`);
});

test('the airport spinner is cleared on every way out of the lookup', () => {
  const source = readSrc('src/app.ts');
  // ⚠️ THE METHOD IS `toggleAirport`. It was `chooseAirport`, and this slice was written
  // `source.slice(source.indexOf('private async chooseAirport'), source.indexOf('private stop('))`.
  // With the name gone, `indexOf` answered -1 and the slice came back EMPTY — so the check reported
  // "the button never shows it is working" about a method that does exactly that on the line named
  // below. A missing anchor is a defect in the check, and `between()` now says so out loud.
  const body = between(source, 'private async toggleAirport', 'private stop(', 'the airport lookup');
  assert.match(body, /this\.setBusy\(icao, true\)/, 'the button never shows it is working');
  const clears = body.match(/this\.setBusy\(icao, false\)/g) ?? [];
  assert.ok(clears.length >= 3,
    `the spinner is cleared on ${clears.length} path(s); it must be cleared on the rate limit, on an error, and on success`);
  assert.match(source, /aria-busy/, 'nothing sets the busy attribute the spinner is drawn from');
});

test('the fence is measured from the reader, not from the airport', () => {
  const source = readSrc('src/app.ts');
  assert.match(source, /private centre: \{ lat: number; lon: number \} \| null = null;/, 'there is nowhere to keep the reader position');
  assert.match(source, /private point\(\): \{ lat: number; lon: number \} \| null \{/, 'there is no single source for the fence centre');
  assert.match(source, /const at = this\.point\(\);\n    if \(!at \|\| !this\.engine\) return;/, 'the poll does not use it');
  assert.equal(/point\/\$\{this\.airport\.lat\}/.test(source), false, 'the poll still asks the feed about the airport');
  assert.match(source, /this\.centre = \{ lat, lon \};/, 'a postal code never becomes the centre');
  // 🔴 THE SENTENCE THAT SAYS WHICH POINT IS NOW TWO SENTENCES IN TWO PLACES, AND THAT IS THE FIX.
  // George, 22 Sep 2026, pasting it back: *"remove The circle is centred on **your location** —
  // Hamilton. Everything on this page is measured from there."* — it restated the heading above it
  // ("How far out from you?") and then explained the heading. So the READER case says nothing, and
  // the AIRPORT case still says everything, because a circle drawn round an airport rather than round
  // the reader is a fact the heading does not carry and is the reason the list below shows aircraft
  // near an airport. This assertion used to require the reader-case sentence and so could not pass
  // once it was removed — correctly removed.
  const fenceFrom = between(source, 'private renderFenceFrom', 'private renderMap', 'the fence caption');
  assert.match(fenceFrom, /not on you/,
    'the page does not warn the reader when the circle is centred on an airport instead of on them');
  assert.match(fenceFrom, /measured from|centred on/,
    'the caption does not say what the distance is measured from');
  assert.equal(/Everything on this page is measured from there/.test(source), false,
    'the sentence George asked to have removed is back');
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
  // ⚠️ THE PER-CHIP TAIL STAR IS RETIRED, BY INSTRUCTION. George, 20 Sep 2026: *"remove start that are
  // in chip, i just want the yellow hue only"*. `TAIL_STAR` and `${on ? TAIL_STAR : ''}` no longer
  // exist because the feature was deliberately removed, not because it drifted — and the absence is
  // asserted in the tail-chip check above, so a star coming back is caught rather than waved through.
  assert.match(source, /aria-label="\$\{label\}"/, 'the star has no accessible name');
  assert.match(source, /title="\$\{label\}"/, 'the star has no tooltip');
  assert.equal(/'Favourite this type'/.test(source), true, 'the wording was deleted rather than moved');
});

test('a step that waits on a place is SHOWN with the reason, not hidden', () => {
  // 🔴 THIS CHECK IS RETIRED, AND IT IS WORTH SAYING WHY RATHER THAN DELETING IT QUIETLY.
  //
  // It asserted a mechanism the page used for one afternoon: steps that were VISIBLE but disabled, each
  // carrying a `data-waiting="true"` flag, a `.step-why` note explaining what to do first, and controls
  // with `control.disabled = !place`. George's instruction the next day was the opposite — *"step 2 and
  // 3 and 4, etc should be collapsed if previous steps are not completed"* — and then, when a stagger
  // was shown instead of a sequence, *"you didnt do the collpase / expand like i asked"*. The gate now
  // HIDES a step until the one before it is answered and reveals it with a glide, which is what the
  // check above this one asserts.
  //
  // So `data-waiting`, `step-why` and `control.disabled = !place` are gone from the page entirely: three
  // of them counted in `src/app.ts` and zero in `index.html`. **A check for a superseded mechanism is not
  // a failing check, it is a stale one** — and the honest repair is to say so and assert the replaced
  // design, not to reinstate the old one.
  const html = read(SITE, 'index.html');
  const source = readSrc('src/app.ts');
  assert.equal(/data-waiting/.test(html), false, 'the retired waiting flag is back on the page');
  assert.equal(/step-why/.test(html), false, 'the retired waiting note is back on the page');
  // And what replaced it: the gate hides what cannot be used yet, and the reveal is the glide.
  assert.match(source, /section\.hidden = true/, 'nothing hides a step that cannot be used yet');
  assert.match(source, /const show = step === 1 \? true : step === 2 \? answered1 : answered2;/,
    'the gate no longer expresses the sequence 1 → 2 → 3');
});

test('the map is DRAWN, not embedded, and says why', () => {
  const source = readSrc('src/app.ts');
  assert.match(source, /private renderMap\(\)/, 'there is no map');
  assert.match(source, /locmap-you/, 'the reader is not marked');
  assert.match(source, /locmap-airport/, 'the airports are not marked');
  assert.match(source, /escapeHtml\(row\.airport\.icao\)/, 'the airports are drawn without their codes');
  // 🔴 THE DECISION AND ITS REASON ARE READ WITH THE COMMENTS LEFT IN. Both used to be looked for in
  // the comment-stripped source, so this check reported *"the drawing does not record the decision"*
  // about a file whose whole argument for drawing the map by hand is written directly above it.
  const raw = readRaw('src/app.ts');
  assert.match(raw, /NOT EMBEDDED/, 'the drawing does not record the decision');
  // ⚠️ THREE SHORT PHRASES RATHER THAN ONE LONG ONE. The reason is written across four lines with
  // Markdown emphasis inside it (*"a request to Google from **every** visitor's browser"*), so a single
  // pattern has to reproduce the line wrapping and the asterisks — which is how a check starts failing
  // when a sentence is *reflowed*, reporting a missing reason that is still there.
  assert.match(raw, /API key/, 'the reason an embedded map was refused does not name the API key');
  assert.match(raw, /billing account/, 'the reason does not name the billing account');
  assert.match(raw, /to Google from/, 'the reason does not name the request to Google from every visitor');
  // 🔴 No Google in the page, which is the standing rule for every one of these sites.
  assert.equal(/maps\.google|googleapis\.com\/maps|gtag\(|googletagmanager/.test(source), false,
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
  const html = read(SITE, 'index.html');
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
  // ⚠️ THE CHART IS GONE, AND SO IS THE ASSERTION THAT IT WAS A STEP IN THE FLOW. It read
  // `id="liveView"[^>]*data-step="7"` — a second view that was a step seven, which the page carried
  // when a chart and a table were the board. The map is the board now, the two-view architecture was
  // deleted, and a check for it is stale rather than failing. What is still worth requiring is that
  // NOTHING has quietly grown a second view back.
  assert.equal(/id="liveView"|id="liveChart"|id="liveBody"/.test(html), false,
    'a second view is back on the page');

  // Heritage and war planes sit between Everything and Airliner.
  const start = source.indexOf('const options: { key: AircraftClass');
  const block = source.slice(start, start + 400);
  const everything = block.indexOf("label: 'Everything'");
  const military = block.indexOf("classLabel('military')");
  const airliner = block.indexOf('...CLASS_ORDER');
  assert.ok(everything < military && military < airliner,
    'heritage and war planes is not between Everything and Airliner');

  // Height restricted, or the page runs away again.
  //
  // 🔴 THERE ARE TWO `.typelist` RULES — a layout one first and the height one further down — and this
  // read the FIRST because `css.indexOf('\n.typelist {')` finds the earliest match and the slice then
  // stopped at that rule's own closing brace. It reported *"the type list has no height limit"* about a
  // stylesheet that says `max-height: 680px` eleven hundred lines later. **A slice that takes the first
  // occurrence of a selector is a slice that breaks the day a second rule is added for the same
  // selector**, which is an ordinary thing to do. So every block for the selector is gathered, and one
  // of them must carry the limit.
  const blocks = [...css.matchAll(/\n\.typelist \{([^}]*)\}/g)].map((one) => one[1]);
  assert.ok(blocks.length >= 1, 'there is no .typelist rule at all');
  const withHeight = blocks.filter((one) => /max-height:\s*\d+px/.test(one));
  assert.equal(withHeight.length, 1, `expected exactly one .typelist rule to cap the height, found ${withHeight.length}`);
  assert.match(withHeight[0], /overflow-y:\s*auto/, 'the type list cannot scroll');
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
  const html = read(SITE, 'index.html');
  // ⚠️ STEPS 2 AND 3. This walked `[2, 3, 4, 5]` against a five-step flow; the flow is three steps
  // numbered 1-2-3 as of 22 Sep 2026 (the distance step was folded into the card that carries the map).
  for (const n of [2, 3]) {
    assert.match(html, new RegExp(`id="step-${n}"[^>]*hidden`), `step ${n} is on the page before step 1 is answered`);
  }
  assert.match(html, /id="step-1" data-step="1"/, 'step 1 must be visible — it is the one that asks');

  const source = readSrc('src/app.ts');
  const gate = between(source, 'private updateSteps', 'private bindStartOver', 'the gate');
  // 🔴 THE SEQUENCE, NOT ONE PINNED EXPRESSION. This used to assert the gate's source line by line —
  // `const wantsPlace = step <= 5;`, `const show = wantsPlace ? place : place && picked;`,
  // `const delay = step === 3 || step === 5 ? 420 : 0;` — and every one of those is gone. **A check
  // that quotes the code it is checking fails whenever the code is rewritten, however correct the
  // rewrite**, which is what happened here three times over: a five-step flow became three, a stagger
  // became a hide-and-reveal, and the constants were renumbered. What has to hold is the ORDER:
  // step 1 shows unconditionally, step 2 after the place is known, everything else only after
  // something has been picked.
  assert.match(gate, /dataset\.step/, 'the gate no longer reads a step number from the section');
  assert.match(gate, /const show = step === 1 \? true/, 'step 1 is not shown unconditionally');
  assert.match(gate, /step === 2 \? answered1/, 'step 2 does not wait for the place');
  assert.match(gate, /: answered2\b/, 'a later step can appear before anything has been picked');
  assert.match(gate, /const answered2 = answered1 && picked;/, 'the second answer no longer descends from the first');
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
  // ⚠️ THE SLICE ENDED AT `private async chooseAirport`, WHICH NO LONGER EXISTS — so `indexOf` answered
  // -1 and the slice came back EMPTY, and all four assertions below reported a fault in a method they
  // had never read. The method that follows `feedTrouble` is `toggleAirport` now, and `between()`
  // refuses to build an empty slice at all.
  const helper = between(source, 'private feedTrouble(', 'private async toggleAirport', 'the feed-trouble helper');
  assert.match(helper, /response\.status === 429/, 'the rate limit is not handled');
  assert.match(helper, /response\.status >= 500/, 'a 5xx from the feed has no sentence of its own');
  assert.match(helper, /at their end, not yours/, 'the 5xx message does not say whose fault it is');
  assert.match(helper, /!response\.ok/, 'any other error status has no sentence');

  // And it must run BEFORE the body is touched, in both callers.
  // ⚠️ THE LOOKUP IS `toggleAirport`. It was `chooseAirport` when this was written, and with the old
  // name `source.slice(-1, …)` came back empty — so the check said the lookup *"never consults the
  // status"* about a method that consults it on its first line. `between()` makes that a loud error now.
  for (const [name, header, next] of [
    ['the poll', 'private async poll()', 'private alertOnDepartures'],
    ['the airport lookup', 'private async toggleAirport', 'private stop('],
  ]) {
    const body = between(source, header, next, name);
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
  // ⚠️ WITH ITS ARGUMENT. The method is `private emptyMessage(counts: { … })` now — it has to know how
  // many of each thing were seen — so a pattern that requires the empty parentheses can never match.
  assert.match(source, /private emptyMessage\(/, 'there is no message for an empty list');

  const message = between(source, 'private emptyMessage(', 'private renderTypeList(): void {', 'the empty message');
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
  //
  // 🔴 RETIRED ON THE PAGE SIDE, AND THE REASON IS IN THE FILE. The historic schedule PANEL was
  // deliberately deleted — `src/app.ts` says so where the code was: *"`loadHistoric()` IS NOT CALLED ANY
  // MORE, because the schedule panel is gone"*, and the types it filled went with it. The collector that
  // fills the database (`tools/load-historic.mjs`, on `aircraft-historic.timer`) is deliberately left
  // running. **The data half above still holds and still matters; the page half now asserts the opposite
  // of the truth**, so it is retired here rather than kept as a failure nobody can act on.
  const app = readSrc('src/app.ts');
  assert.equal(/fetch\('\/historic\.json'/.test(app), false,
    'the page reads the historic document again — if the panel is coming back, this check should be re-pointed at it rather than left asserting its absence');

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

  // 🔴 RETIRED, BECAUSE THE CARD THAT SHOWED IT WAS DELETED. `one.reported === false` was how the page
  // told "no source was found for this code" apart from "the feed has never reported it" — three states
  // in the data, and the page had to keep all three. That rendering went with the aircraft card and the
  // historic panel, and `.reported` no longer appears anywhere in `src/app.ts`: measured, zero hits. The
  // DATA still carries the three states and the composer still distinguishes them (asserted above), which
  // is the half that survives.
  const app = readSrc('src/app.ts');
  assert.equal(/\.reported\b/.test(app), false,
    'the page reads `reported` again — the card may be back, and this check should be re-pointed at it');
});

/* ============== the filters and the type list can be SEEN, and say why ======
 *
 * George, 21 Sep 2026: *"all my filters are gone. fix that. and i dont see any airplain type.
 * create units and e2e tyestsing too"*. The end-to-end tests prove the behaviour; these prove the
 * shape it depends on, so a later edit cannot quietly re-break it.
 */

test('the three filter rows live INSIDE the gated type section, so whatever opens it shows them', () => {
  // 🔴 THIS IS WHY THE FILTERS "WENT MISSING" AND IT IS NOT A BUG TO FIX BY MOVING THEM. They are
  // inside `#step-2` on purpose — the section opens on a place, and a reader who has not said where
  // they are has nothing for a type filter to act on. What matters is that the
  // chips and the list share ONE container: if a chip ever leaves it, the filters and the rows
  // can be shown and hidden independently, which is the state that looks like "my filters are
  // gone" while the rows are still there.
  const html = read(SITE, 'index.html');
  const section = htmlCode.slice(htmlCode.indexOf('id="step-2"'));
  const end = section.indexOf('</section>');
  const inner = section.slice(0, end === -1 ? section.length : end);

  for (const id of ['typeFilter', 'radiusButtons', 'yearFilter', 'seenFilter', 'filterNote', 'typeList']) {
    assert.ok(inner.includes(`id="${id}"`), `${id} is not inside the step-2 section`);
  }
  assert.ok(html.includes('class="card step-gated" id="step-2"'), 'step 3 is no longer a gated section');
  assert.ok(section.length > 0, 'the step-2 section was not found at all');
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

test('the distance is asked WITH the aircraft, and the refreshed line is the first thing above the map', async () => {
  // 🔴 George, 22 Sep 2026: *"i forgot the slider is actually a filter for pic an aircraf. lets remove
  // the slider and ask the distance about the pick an aircraf under kind"*.
  //
  // The distance decides how far out the feed is asked and therefore which aircraft are on the list, so
  // it is asked in the step where the aircraft are picked, under the kind filter. It sat above the map
  // for one day (*"i want this above the map"*) and a control that changes the list was drawn in the
  // card that reads the list.
  const code = htmlCode;
  // ⚠️ DECLARED AT THE TOP OF THE TEST, NOT WHERE IT FIRST SEEMED TIDY. It was declared eight lines from
  // the bottom, and three checks above it read it — which is a temporal dead zone, so the whole test threw
  // "Cannot access 'app' before initialization" and reported nothing about the page.
  const app = readSrc('src/app.ts');
  const step3 = code.slice(code.indexOf('id="step-2"'), code.indexOf('id="step-3"'));
  const kind = step3.indexOf('id="typeFilter"');
  const chips = step3.indexOf('id="radiusButtons"');
  const year = step3.indexOf('id="yearFilter"');
  for (const [what, at] of [
    ['the kind filter', kind],
    ['the distance chips', chips],
    ['the year filter', year],
  ]) {
    assert.ok(at > -1, `${what} is not in the card where aircraft are picked`);
  }
  assert.ok(kind < chips && chips < year, 'the distance is not asked under the kind filter');

  // 🔴 AND IT WEARS THE SAME LABEL AS THE OTHER FILTER ROWS. George, 22 Sep 2026: *"### How far out from
  // you? iws not the same font and color as the others, call is distance instead"*. The heading is gone,
  // not hidden — a hidden duplicate label is read out twice — and the row is labelled `Distance` in the
  // same `chip-label` span as `Kind`, `Year` and `Last seen`.
  assert.equal(code.includes('id="radiusHead"'), false, 'the distance heading is back on the page');
  assert.equal(/radiusHead/.test(readSrc('src/app.ts')), false,
    'the code still reaches for the distance heading');

  // 🔴 AND THE LABEL IS MARKUP, IN A COLUMN THAT LINES UP WITH THE OTHER THREE.
  // George, 22 Sep 2026: *"the filtering section is ugly look at it, its too cluttered"* — the labels
  // were injected into the chips rows by `labelChips()`, which made each one a flex item in a wrapping
  // row: never aligned with anything, and abandoned at the left edge by any wrapped line. They are
  // siblings of the chips now, inside `.filter-row`, which is what lets a fixed column exist at all.
  assert.match(code, /<span class="chip-label" id="radiusButtonsLabel">Distance<\/span>/,
    'the distance row is not labelled Distance');
  assert.match(code, /id="radiusButtons" role="group" aria-labelledby="radiusButtonsLabel"/,
    'the distance row is not attached to its own label');
  assert.equal(/labelChips\(host/.test(readSrc('src/app.ts')), false,
    'a label is still injected into a chips row instead of being markup');

  const panelAt = code.indexOf('class="filters"');
  assert.ok(panelAt > -1, 'the four filters are not one panel');
  const panel = code.slice(panelAt, code.indexOf('id="filterNote"'));
  for (const id of ['typeFilter', 'radiusButtons', 'yearFilter', 'seenFilter']) {
    assert.ok(panel.includes(`id="${id}"`), `${id} is not inside the filter panel`);
  }
  const panelCss = read(SITE, 'styles.css');
  assert.match(panelCss, /\.filter-row\s*\{[\s\S]{0,200}grid-template-columns:\s*\d+px/,
    'the filter labels are not in a fixed column');
  assert.match(panelCss, /\.filters\s*\{[\s\S]{0,140}border-radius/,
    'the filters are not drawn as one panel');

  // 🔴 AND THE ROWS BREATHE MORE THAN THE CHIPS INSIDE THEM. George, 22 Sep 2026: *"put vertical space
  // between filter labels, they are way too close together"*. One 4px gap was doing both jobs, so a
  // wrapped chip line sat as far from its own row as two different labels did — and with the maker row
  // wrapping, five labels read as a single block. Asserted as a RELATIONSHIP rather than as two numbers,
  // so tightening either one catches it whichever way it moves.
  const rowGap = Number(/\.filters\s*\{[^}]*row-gap:\s*(\d+)px/.exec(panelCss)?.[1] ?? NaN);
  const chipGap = Number(/\.filter-row \.chips\s*\{[^}]*gap:\s*(\d+)px/.exec(panelCss)?.[1] ?? NaN);
  assert.ok(Number.isFinite(rowGap) && Number.isFinite(chipGap),
    'the filter spacing could not be read, so this check would be vacuous');
  assert.ok(rowGap >= 8, `the gap between filter rows is only ${rowGap}px, which is what he called too close`);
  assert.ok(rowGap > chipGap,
    `the gap between rows (${rowGap}px) is not bigger than the gap inside one row (${chipGap}px), so a wrapped line reads as a new row`);

  // 🔴 AND THE LAST-SEEN ROW CARRIES EIGHT WINDOWS, NOT TEN. George, 22 Sep 2026: *"for last seen remove
  // no data and remove 12 hours"* — twelve hours straddled a night and answered a question neither
  // neighbour did, and `no data` was a question about the RECORD sitting on a row about time.
  const choices = app.slice(app.indexOf('const SEEN_CHOICES'), app.indexOf('const SEEN_DEFAULT'));
  assert.ok(choices.length > 100, 'the last-seen choices could not be isolated, so this check is vacuous');
  assert.equal(/'halfDay'/.test(choices), false, 'the 12-hour window is back on the row');
  assert.equal(/'noData'/.test(choices), false, 'the no-data choice is back on the row');
  assert.equal((choices.match(/\{ key: '/g) ?? []).length, 8, 'the last-seen row does not carry eight windows');

  // 🔴 THE STOPS ARE HIS NUMBERS, AND THE RULE THEY KEEP IS THE RATIO RATHER THAN DOUBLING.
  //
  // George, 22 Sep 2026: *"distance can be logrythmic starting at 25, 50, 75, 100, 150, 200, 400"* —
  // which replaced the six doubling stops (5 · 10 · 20 · 40 · 80 · 160) this page had carried since the
  // morning. The scale is not a doubling one any more, and the check no longer pretends it is: what makes
  // a ladder readable is that **no stop is more than twice the one before it**, because a stop further
  // than double leaves a middle the reader cannot choose, and a stop barely above its neighbour is two
  // chips answering one question. So the two ends, the order and every RATIO are asserted — and never a
  // list typed out twice, which is how a test starts disagreeing with the code it is checking.
  const ladder = /const RADIUS_LADDER = \[([^\]]+)\]/.exec(readSrc('src/app.ts'));
  assert.ok(ladder, 'the distance stops are gone');
  const stops = ladder[1].split(',').map((one) => Number(one.trim()));
  assert.deepEqual([stops[0], stops[stops.length - 1]], [25, 400],
    `the stops do not run from 25 to 400 km: ${stops.join(' · ')}`);
  assert.equal(stops.length, 7, `there are ${stops.length} stops, not the seven he named`);
  for (let i = 0; i < stops.length; i += 1) {
    assert.ok(Number.isInteger(stops[i]) && stops[i] > 0, `${stops[i]} is not a whole number of kilometres`);
    if (i === 0) continue;
    assert.ok(stops[i] > stops[i - 1], `${stops[i]} does not come after ${stops[i - 1]}`);
    assert.ok(stops[i] <= stops[i - 1] * 2,
      `${stops[i]} is more than twice ${stops[i - 1]}, so the middle of the range cannot be chosen`);
  }

  // 🔴 AND THE ROW OPENS ON `All`, WHICH IS THE FEED'S OWN CEILING RATHER THAN A NUMBER OF OURS.
  // George, 22 Sep 2026: *"at the begining of distance, default select all"*. 463 km is exactly 250
  // nautical miles — the widest fence the feed's own summary says it serves — so the check converts it
  // with the SAME function the page uses and requires the feed's limit back. A number he happens to like
  // would pass a check that only read the constant; this one fails unless 250 nm is what arrives.
  const { kmToNm } = await import('../site/detect.js');
  const everywhere = Number(/const RADIUS_ALL = (\d+)/.exec(app)?.[1] ?? NaN);
  assert.ok(Number.isFinite(everywhere), 'the widest stop is gone, so nothing opens on `All`');
  assert.equal(kmToNm(everywhere), 250,
    `the widest stop is ${everywhere} km, which the feed is asked for as ${kmToNm(everywhere)} nm rather than its own 250`);
  assert.match(app, /const RADIUS_CHOICES = \[RADIUS_ALL, \.\.\.RADIUS_LADDER\]/,
    'the distance row is not `All` followed by the numbered stops, in that order');
  assert.match(app, /km === RADIUS_ALL \? 'All' :/, 'the widest stop does not print `All`');
  assert.match(app, /private radiusKm = RADIUS_DEFAULT/, 'a fresh visit does not open on the default distance');
  // 🔴 THE DEFAULT IS 50 KM AND IT IS ONE OF THE STOPS. George, 22 Sep 2026: *"i want the default Distance
  // to be 50km"*. It is read from the ladder rather than written twice, so a default that is not on the
  // row cannot happen — a number of its own would light no chip.
  const defaultKm = Number(/const RADIUS_DEFAULT = (\d+)/.exec(app)?.[1] ?? NaN);
  assert.equal(defaultKm, 50, 'the default distance is not 50 km');
  assert.match(app, /const RADIUS_LADDER = \[[^\]]*\b50\b[^\]]*\]/,
    'the default distance is not one of the stops, so no chip would be pressed on a fresh visit');

  // 🔴 AND WHAT THE READER CHOSE IS REMEMBERED. George, 22 Sep 2026: *"save the users setting in cookie"*
  // — and every one of these is kept in the browser's own store, in the same place as the place and the
  // distance, because the published policy says these settings are held there and *not* in a cookie.
  // Each key is asserted to be WRITTEN on a press and READ on load, and to be cleared by "start over":
  // a setting that survives the reset is a setting the reader cannot get rid of.
  // 🔴 `app`, NOT `code`. This sliced the PAGE'S HTML for two TYPESCRIPT METHOD NAMES, so neither anchor
  // could ever be found: `indexOf` returned -1, the slice ran from the file's last character, and the
  // length guard fired. That guard is doing its job — it is the only reason a nine-month-old emptiness
  // was ever visible, because a slice that matches nothing asserts nothing and looks exactly like a pass.
  const over = between(app, 'private bindStartOver', 'private bindForgetMine', 'the start-over reset');
  assert.ok(over.length > 200, 'the start-over reset could not be isolated, so this check is vacuous');

  // 🔴 AND WHAT IS ASSERTED HERE CHANGED, BECAUSE THE PAGE IS BETTER THAN THIS CHECK ASSUMED.
  // It used to require the four key NAMES to appear inside the start-over handler — and when the slice was
  // finally bound to the right source, that failed. The page is not wrong: the handler calls
  // `forgetStored(false)`, which clears **by prefix** — `storedKeys()` walks `localStorage` and takes every
  // key beginning `aircraft_`, and `dropStore` removes each. That is STRONGER than naming four keys,
  // because a setting added next month is cleared without anyone remembering to add it to a list. So the
  // check now proves the property that makes the sweep complete, rather than a spelling of it.
  for (const key of ['KIND_KEY', 'MAKER_KEY', 'ERA_KEY', 'SEEN_KEY']) {
    assert.match(app, new RegExp(`writeStore\\(${key}`), `${key} is never written`);
    assert.match(app, new RegExp(`readStore\\(${key}`), `${key} is never read back`);
  }
  assert.match(over, /forgetStored\(false\)/,
    'start over does not clear the page\'s own settings');
  assert.match(between(app, 'private bindForgetMine', 'private bindLocate', 'the delete-mine control'),
    /forgetStored\(true\)/,
    'the control that deletes what is stored does not withdraw the stored consent, so a reader cannot take it back');

  // 🔴 THE PROPERTY THAT MAKES THE SWEEP COMPLETE, AND THE ONE THAT WOULD BREAK IT SILENTLY: **every**
  // key the page writes must carry the prefix the sweep walks. A setting stored under any other name
  // survives "start over" for ever, and nothing on the page would say so.
  const prefix = /const STORE_PREFIX = '([^']+)'/.exec(app)?.[1];
  assert.ok(prefix, 'the store prefix is gone, so nothing can be cleared by it');
  const keyConstants = [...app.matchAll(/^const ([A-Z_]*_KEY) = '([^']*)';/gm)];
  assert.ok(keyConstants.length >= 10,
    `only ${keyConstants.length} storage keys were found, so this is not reading the list`);
  for (const [, name, value] of keyConstants) {
    assert.ok(value.startsWith(prefix),
      `${name} is stored as "${value}", which does not begin "${prefix}", so start over leaves it behind for ever`);
  }
  // And it names no key at all — the day it starts naming them is the day a new setting can be forgotten.
  const sweeper = between(app, 'function forgetStored', 'function startOfDay', 'the sweep');
  assert.ok(sweeper.length > 60, 'the sweep could not be isolated');
  assert.match(sweeper, /storedKeys\(includeConsent\)/, 'the sweep no longer walks the store');
  assert.doesNotMatch(sweeper, /_KEY\b/, 'the sweep names individual keys, so a new setting can be left behind');

  // And it is NOT asked in the map's card any more — it is the same one control, not a second copy.
  //
  // ⚠️ THE SLICE ENDS AT `id="how"`, AND IT USED TO END AT `id="live"`. The card with that id was
  // deleted on George's instruction (22 Sep 2026), and `indexOf` on a marker that no longer exists
  // returns −1 — so the slice silently ran to the END OF THE FILE and this check would have graded
  // every card on the page instead of the one it names. A slice that cannot tell "not found" from
  // "found at the end" is a check that disagrees with itself, so the marker is the next card that is
  // still there.
  const step4 = code.slice(code.indexOf('id="step-3"'), code.indexOf('id="how"'));
  assert.equal(step4.includes('id="radiusButtons"'), false, 'the distance is still asked in the map\'s card');
  assert.equal((code.match(/id="radiusButtons"/g) ?? []).length, 1, 'the distance control is on the page twice');

  // 🔴 THE SLIDER IS GONE, AND SO IS EVERY PIECE OF GEOMETRY IT NEEDED. A rule for an element the page
  // no longer draws is how a deleted control keeps looking alive, so the track, the thumb and the label
  // that rode on it are all asserted absent rather than left to rot.
  const css = read(SITE, 'styles.css');
  assert.equal(/radiusSlider|type = 'range'/.test(app), false, 'a slider is still built');
  assert.equal(/radius-track|placeReadout|RADIUS_THUMB_PX/.test(app), false,
    'the code that positioned a value against the slider track is still here');
  assert.equal(/\.radius-(track|slider|value|row)\s*[:{]/.test(css), false,
    'a slider rule survives in the stylesheet');

  // 🔴 AND THE CHIPS ARE THE LADDER, WITH THE ONE IN USE PRESSED. A chip row that does not say which
  // answer is live reads as an unanswered question, which is the fault the pressed state exists for.
  //
  // ⚠️ IT ITERATES `RADIUS_CHOICES`, NOT `RADIUS_LADDER`, AND THAT IS THE BETTER SHAPE: `RADIUS_CHOICES`
  // is `[RADIUS_ALL, ...RADIUS_LADDER]`, so the row carries *All* as its first chip as well as the seven
  // stops. Asserting the old name pinned the row to the seven and would have failed on the day All was
  // added — which is exactly what happened.
  assert.match(app, /for \(const km of RADIUS_CHOICES\)/, 'the chips are not the ladder plus All');
  assert.match(app, /String\(km === this\.currentRadius\(\)\)/, 'the chip in use is not the pressed one');

  // 🔴 AND THE REFRESHED LINE IS STILL THE FIRST THING ABOVE THE MAP — it belongs to the map, not to the
  // control that moved away from it. *"last refresh should be the first thing above the map, right
  // aligned"*, and *"start off my saying now"*.
  const fence = code.indexOf('id="fenceFrom"');
  const refreshed = code.indexOf('id="refreshedAgo"');
  const map = code.indexOf('id="watchMap"');
  for (const [what, at] of [
    ['the centre paragraph', fence],
    ['the refreshed line', refreshed],
    ['the map', map],
  ]) {
    assert.ok(at > -1, `${what} is not on the page at all`);
  }
  assert.ok(fence < refreshed && refreshed < map, 'the refreshed line is not the first thing above the map');
  assert.equal((code.match(/id="radiusRefreshed"/g) ?? []).length, 1, 'the refreshed line is on the page twice');
  assert.equal(code.includes('id="radiusNote"'), false, 'the distance note is on the page again');
  assert.match(code, /id="refreshedAgo">now</, 'the refreshed line does not open on "now"');
  assert.match(app, /#refreshedAgo/, 'nothing keeps the refreshed line honest');
  assert.match(app, /fromNow\(this\.lastPollAt\)/, 'the refreshed line is not counted from the last poll');
  assert.match(css, /\.refreshed-line\s*\{[\s\S]{0,120}text-align:\s*right/, 'the refreshed line is not right-aligned');

  // 🔴 AND THE READER CAN PRESS THE CLOCK. George, 22 Sep 2026: *"to the right of [Last refreshed], i
  // want a refresh right aligned, this will reapply my filters to current data"*. It is a real control
  // inside that line — the same quiet `.linkish` shape the other two text controls use — and it asks
  // through the COALESCING path with the clock re-armed, so a press cannot spend a second request on
  // the same moment the scheduled look already covers.
  //
  // ⚠️ THIS USED TO REQUIRE A COMMENT BETWEEN THE CLOCK AND THE BUTTON — `now</b>.\s*<!--[\s\S]*?<button`.
  // `code` IS COMMENT-STRIPPED (`stripHtml`), so `<!--` could never be found and this assertion could
  // never pass: a check that demanded a reason in a string where reasons are deliberately removed. The
  // rule is about WHERE the control is, so it is now read from the element it must sit inside.
  const clockLine = between(code, 'id="radiusRefreshed"', '</p>', 'the refreshed line');
  assert.match(clockLine, /<button type="button" class="linkish refresh-now" id="refreshNow"/,
    'there is no refresh control on the refreshed line');
  assert.match(clockLine, /id="refreshedAgo"/,
    'the refresh control is not in the line that carries the clock it is about');
  assert.equal((code.match(/id="refreshNow"/g) ?? []).length, 1, 'the refresh control is on the page twice');
  assert.match(app, /private refreshNow\(\): void/, 'nothing answers the refresh control');
  assert.match(
    app,
    /this\.startTimer\(\);\s*\n\s*this\.schedulePoll\(\);/,
    'the refresh control does not re-arm the clock and ask through the coalescing path'
  );
  assert.match(css, /\.refresh-now\s*\{[\s\S]{0,80}margin-left:\s*0\.5rem/, 'the refresh control is not spaced off the sentence');
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
  // ⚠️ ALLOWING THE FILTER. The page writes `const live = (this.engine ? this.engine.snapshot() : []).filter(…)`
  // — the snapshot is narrowed to what is IN THE AIR in the same expression, and the old pattern required
  // the `[]` to be followed by nothing, so it could not match a line that does exactly what it asks for.
  assert.match(app, /const live = \(this\.engine \? this\.engine\.snapshot\(\) : \[\]\)/,
    'the chips are not read from the same snapshot as the row status');

  // 🔴 AND "IN THE AIR" MEANS AIRBORNE, IN BOTH KINDS OF ROW. George, 22 Sep 2026: *"you sday in the
  // air but shouldnt at lease on tail be highlighed in the same green?"* — the status counted every
  // track of the type the engine held, INCLUDING aircraft the feed reports on the ground, so the words
  // could be false whether or not any chip was green.
  assert.match(app, /one\.phase === 'airborne' &&\s*normaliseKey\(one\.type/,
    'a type row still counts aircraft on the ground as "in the air"');
  assert.match(app, /one\.phase === 'airborne' &&\s*normaliseKey\(one\.registration/,
    'a named-aircraft row still counts an aircraft on the ground as "in the air"');

  // 🔴 AND THE ROW HAS ONE CLOCK. The status used to be patched on every tick while the chips were
  // drawn once, so an aircraft that took off while the page was open turned the words on and could not
  // turn a chip green — which is exactly the row George pasted back.
  //
  // ⚠️ A FIXED-LENGTH SLICE ON PURPOSE. `indexOf('private watchStateOf')` finds the METHOD ABOVE this
  // one, so the slice came back empty and the check failed on the file being fine — a false failure,
  // which is worse than no check at all. The body is well under 3000 characters.
  const tickAt = app.indexOf('private tickWatchStates');
  assert.ok(tickAt > -1, 'tickWatchStates is gone');
  const tick = app.slice(tickAt, tickAt + 3000);
  assert.match(tick, /this\.renderWatchlist\(\)/, 'the status is refreshed on a tick and the chips are not');
  assert.equal(/querySelectorAll<HTMLLIElement>\('li\.watch-type'\)/.test(tick), false,
    'the tick still patches the status cell instead of redrawing the row');

  // And an aircraft that is up there without a registration is COUNTED rather than left as a silence.
  assert.match(app, /tail-quiet/, 'the aircraft that cannot be named are not shown on the row');
  assert.match(css, /\.watch-list \.watch-tails \.tail-chip\.tail-quiet/, 'the unidentified chip has no styling');
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
  const step4At = html.indexOf('id="step-3"');
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
  assert.ok(html.indexOf('id="watchMap"') > html.indexOf('id="step-3"'),
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
  // 🔴 THE EXPLANATION CANNOT GO STALE, BECAUSE BOTH HALVES ARE WRITTEN BY THE SAME RENDER. This used to
  // assert `if (state.title !== next.why) state.title = next.why;` — an in-place update that had to be
  // remembered every time the wording changed. The row is now re-rendered whole (`renderWatchlist`
  // rewrites the list's innerHTML), and the `title` sits in the same template string as the `text` six
  // characters above it, so there is no separate step left to fall out of step. **The property to hold is
  // that ONE render writes both**, which is what this asserts.
  assert.match(app, /title="\$\{escapeHtml\(state\.why\)\}">\$\{escapeHtml\(state\.text\)\}/,
    'the explanation and the wording are written in separate steps, so one can be refreshed without the other');
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
  // 🔴 THE SECOND COPY OF THE SAME ASSERTION, AND IT SURVIVED THE FIRST REPAIR. Both were written for a
  // version of the row that updated its own `title` in place; the row is re-rendered whole now, so `why`
  // and `text` are written by one template and cannot drift. See the note on the identically-named
  // assertion above — this one is the copy that a single search-and-replace missed.
  assert.match(app, /title="\$\{escapeHtml\(state\.why\)\}">\$\{escapeHtml\(state\.text\)\}/,
    'the explanation and the wording are written in separate steps, so one can be refreshed without the other');

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
  const section = htmlCode.slice(htmlCode.indexOf('id="step-3"'), htmlCode.indexOf('id="how"'));
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
  // ⚠️ THE CLASS CARRIES A HUE. The line is `<line class="locmap-trail locmap-trail-${hue}" …`, so the
  // closing quote in the old pattern could never be there — and the path was being drawn the whole time.
  assert.match(body, /class="locmap-trail/, 'no path is drawn on the map');

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

test('94 · the feed card and the honesty card are gone, and nothing draws a table', () => {
  const page = read(SITE, 'index.html');
  const app = readSrc('src/app.ts');
  const css = read(SITE, 'styles.css');

  // George, 22 Sep 2026, in two messages: *"deelte ## What the feed can see right now"* — then
  // *"delete ## What this cannot see — read this before you rely on it"*.
  assert.equal(/id="live"/.test(page), false, 'the feed card is still on the page');
  assert.equal(/id="honesty"/.test(page), false, 'the honesty card is still on the page');
  assert.equal(/liveAsk|liveTable|aircraftBody/.test(page), false,
    'an element of the deleted card survives in the markup');

  // 🔴 AND NOTHING MAY STILL REACH FOR IT. The compiler catches a method that became unused; it cannot
  // catch a renderer writing into an element that is no longer there, because `byId` returns null and
  // the write is simply skipped — which looks exactly like working code. Comments are stripped first,
  // because this change is discussed in them and a check that read the discussion would fail on a file
  // that is correct.
  const code = stripJs(app);
  assert.equal(/liveAsk|liveTable|aircraftBody/.test(code), false,
    'the source still holds a handle on an element the page no longer has');
  assert.equal(/private departureCell|private destinationCell|private routeOf|private bearingCell/.test(code),
    false, 'the route and cell builders survive the table that called them');
  assert.equal(/['"]tr\.aircraft-row/.test(code), false, 'a press is still bound to a table row');

  // 🟢 WHAT IS LEFT: the map is the list, and the alert is still gated — arming a bell with nothing
  // picked is a bell about nothing.
  //
  // 🔴 AND THE NOTIFY BUTTON IS COMMENTED OUT FOR NOW — 23 September 2026, George: *"comment that
  // button for now, and update copy"*. The page stops asking the feed the moment the tab is hidden
  // (`bindVisibility()` calls `this.stop()`), so the alert could only fire while the reader was already
  // looking at the page — a doorbell wired to the room you are standing in.
  //
  // ⚠️ THIS ASSERTION IS THE FLIP SIDE OF THAT DECISION, and it is written on `stripHtml` because that
  // helper removes comments — so a commented-out button is invisible to it, exactly as it is to a
  // reader. **It fails if the button or the notification promise is put back without the hidden-tab
  // problem being settled first.** `notifyBlock` appearing in the raw markup is fine and expected; it
  // is inside a comment, which `stripHtml` deletes.
  assert.equal(/id="notifyBtn"/.test(stripHtml(page)), false,
    'the notify button is live again — read the note where it was commented out in site/index.html');
  assert.equal(/browser notification/i.test(stripHtml(page)), false,
    'the page promises a browser notification again, and it cannot keep that promise');
  assert.match(code, /private syncAlertVisibility\(\): void/, 'nothing hides the alert when nothing is picked');

  // And no rule is left styling a row that no longer exists.
  const live = stripCss(css);
  for (const gone of ['cell-tail', 'cell-type', 'cell-city', 'dest-leg', 'leg-time', 'watched-row']) {
    assert.equal(app.includes(gone), false, `${gone} is still built in the source`);
    assert.equal(new RegExp(`\\.${gone}\\s*[\\{:]`).test(live), false, `a rule for ${gone} survives`);
  }
});

test('96 · the maker row names who built it, and claims a maker only when the name does', async () => {
  // 🔴 THE RULE IS TESTED BY RUNNING IT, NOT BY READING IT. `makerOf` is the one thing in this change
  // that makes a claim about the world — somebody built this aeroplane — so a check that only saw the
  // word "maker" in the source would prove nothing at all.
  const { makerOf } = await import('../site/typeinfo.js');
  const page = read(SITE, 'index.html');
  const app = readSrc('src/app.ts');

  // 🔴 THE ROW IS IN THE PANEL, DIRECTLY UNDER KIND. George, 22 Sep 2026: *"add a new category for
  // manufacturer like airbus … other examples are Cessna, Glider etc"*. They answer the same shape of
  // question about a type — what it is, and who built it — so they sit beside each other.
  const panel = page.slice(page.indexOf('class="filters"'), page.indexOf('id="filterNote"'));
  const kind = panel.indexOf('id="typeFilter"');
  const maker = panel.indexOf('id="makerFilter"');
  const distance = panel.indexOf('id="radiusButtons"');
  assert.ok(kind > -1 && distance > -1, 'the filter panel could not be isolated, so this check is vacuous');
  assert.ok(maker > -1, 'the maker row is not in the filter panel');
  assert.ok(kind < maker && maker < distance, 'the maker row is not directly under the kind row');
  assert.match(page, /<span class="chip-label" id="makerFilterLabel"[^>]*>Maker<\/span>/,
    'the maker row is not labelled Maker');
  assert.match(page, /id="makerFilter" role="group" aria-labelledby="makerFilterLabel"/,
    'the maker row is not attached to its own label');

  // 🔴 A MAKER IS CLAIMED ONLY WHEN THE TYPE'S OWN NAME NAMES ONE. This is the whole reason the row is a
  // curated table rather than a rule that takes the first word of every name: `Glider`, `Balloon` and
  // `Ultralight` are what the FEED calls those types and nobody's manufacturer, and `Airplane Factory` is
  // a real maker whose first word is not its name. George doubted the word himself — *"not sure thats a
  // manufacture"* — and this is the answer to the doubt.
  assert.equal(makerOf('GLID'), null, 'a glider is being given a manufacturer, and it has none');
  assert.equal(makerOf('BALL'), null, 'a balloon is being given a manufacturer');
  assert.equal(makerOf('ULAC'), null, 'an ultralight is being given a manufacturer');
  assert.equal(makerOf('AS21'), null, 'a code the site cannot name is being given a manufacturer');
  assert.equal(makerOf('DH8D'), null, 'the Dash 8 is filed under a maker its own name does not name');
  assert.equal(makerOf('SLG2'), 'Airplane Factory', 'a maker whose name opens with a common word is misread');
  assert.equal(makerOf('H47'), 'Boeing', 'Boeing-Vertol is not being read as Boeing');
  assert.equal(makerOf('C30J'), 'Lockheed', 'Lockheed Martin is not being read as Lockheed');
  assert.equal(makerOf('V22'), 'Bell Boeing', 'a type built by two makers loses one of them');
  assert.equal(makerOf('RV7'), "Van's", 'a maker whose name carries an apostrophe is dropped');
  assert.equal(makerOf('B738'), 'Boeing', 'a Boeing is not recognised');
  assert.equal(makerOf('C172'), 'Cessna', 'a Cessna is not recognised');

  // 🔴 AND THE FILTER COUNTS WHAT IT DROPS, LIKE EVERY OTHER AXIS. `droppedReasons` prints the accounting
  // under the list, so an axis that drops rows without a counter turns that count into a lie.
  assert.match(app, /droppedByMaker \+= 1/, 'the maker filter drops rows without counting them');
  assert.match(app, /droppedByMaker: number;/, 'the dropped-by-maker count is not in the counts');
  assert.match(app, /droppedByMaker > 0/, 'the reason is counted and then never printed');

  // And the chips are the row's own, pressable, and carry the key the filter reads.
  assert.match(app, /id=\"makerFilter\"|byId\('makerFilter'\)/, 'the code never reaches for the maker row');
  assert.match(app, /dataset\.maker = option\.key/, 'the maker chips carry no key to press');
});

test('95 · the honest page and the honest code agree about the feed', () => {
  const page = read(SITE, 'index.html');
  const app = readSrc('src/app.ts');

  // 🔴 THE PAGE SAID "EVERY TEN SECONDS" WHILE THE CODE SAID TWENTY, AND NOTHING COMPARED THEM. The
  // sentence was true when it was written and the cadence moved out from under it — the same class of
  // fault as a stale date in a plan, and the same remedy: read the number out of the code and require
  // the sentence to carry it, rather than trusting a number typed twice.
  const number = (name) => {
    const found = new RegExp(`const ${name} = ([\\d_]+)`).exec(app);
    return found ? Number(found[1].replace(/_/g, '')) / 1000 : NaN;
  };
  const start = number('POLL_START_MS');
  const floor = number('POLL_MIN_MS');
  assert.ok(Number.isFinite(start) && Number.isFinite(floor),
    'the poll cadence could not be read out of the code, so this check would be vacuous');
  // ⚠️ THE PAGE WRITES THE CADENCE IN WORDS. It says *"Every twenty seconds at first — more slowly if the
  // feed refuses"* and *"every twenty seconds or so"*, and this asked for the digits, so it could never
  // match a page that states the number plainly. The number is still required to be the one the code
  // uses — `POLL_START_MS` is read above and the word is derived from it — so a change to 30 seconds
  // still fails here, which is the point of the check.
  const words = ['ten', 'fifteen', 'twenty', 'twenty-five', 'thirty', 'forty-five', 'sixty'];
  // ⚠️ `start` IS ALREADY IN SECONDS — the helper reads the constant and divides by 1000 itself. A second
  // division here produced 0.02 and a message about "the 0.02-second start", which is how this line was
  // caught rather than shipped.
  const spelled = words.find((word) => Math.round(start) === WORD_NUMBERS[word]);
  assert.ok(spelled, `the ${start}-second start has no word for it in this check`);
  assert.match(page, new RegExp(`every (${spelled}|${Math.round(start)}) seconds`),
    `the page does not state the ${spelled}-second cadence the code uses`);
  // 🔴 AND THE FLOOR IS NOW SAID OUT LOUD, BECAUSE THE PAGE DID NOT SAY IT. `POLL_MIN_MS` is the promise
  // that the page never leans on a volunteer-funded feed harder than once every fifteen seconds — it is
  // the politeness rule that stopped five of seven airports being refused — and the sentence under "How a
  // departure is decided" stated the start and the back-off and left the floor unsaid. The floor is written
  // in words, like the cadence above it, so the same mapping applies.
  const floorWord = words.find((word) => Math.round(floor) === WORD_NUMBERS[word]);
  assert.ok(floorWord, `the ${floor}-second floor has no word for it in this check`);
  assert.match(page, new RegExp(`never more often than every (${floorWord}|${Math.round(floor)}) seconds`),
    `the page does not state the ${floorWord}-second floor the code uses`);

  // 🔴 AND IT MUST NOT PROMISE A MARK THAT NO ROW CARRIES. The departures board was removed on
  // 20 Sep 2026 and took the "seen on the ground first / first seen climbing" labels with it — so a
  // section headed "what this cannot see" was promising the reader a distinction the table had stopped
  // drawing. A caveat that describes a feature which is gone is worse than no caveat: it is believed.
  const honesty = page.slice(page.indexOf('What this cannot see'), page.indexOf('How it works'));
  assert.ok(honesty.length > 400, 'the honesty section could not be isolated, so this check is vacuous');
  assert.equal(/first seen climbing/i.test(honesty), false,
    'the page still promises a mark no row carries, so the caveat describes a feature that is gone');
  assert.equal(/ADS-B/.test(honesty), false,
    'the honesty section leans on a protocol name where plain words say it better');
  assert.equal(/seven airports polled/.test(honesty), false,
    'the honesty section still carries a measurement taken about the airport polling that no longer happens');

  // 🔴 AND THE PRIVACY SECTION MUST NOT CLAIM THAT NOTHING IS TRANSMITTED. A place name IS looked up
  // through this site's own server, and so are the callsigns inside the fence; the section said neither,
  // and went further — it said "nothing you type is sent to this site", which was simply untrue.
  const privacy = page.slice(page.indexOf('id="privacy"'), page.indexOf('consentBar'));
  assert.ok(privacy.length > 400, 'the privacy section could not be isolated, so this check is vacuous');
  assert.match(privacy, /place name you search for/, 'the privacy section does not admit the place lookup');
  // ⚠️ THE ADMISSION IS THERE; IT IS THE WORDING THAT MOVED. The section says a request is made *"for the
  // aircraft inside your fence"* rather than *"callsigns of the aircraft inside your fence"* — same fact,
  // fewer words, and the check was pinned to the longer phrase. What must stay true is that the section
  // admits the fence request at all, because that request carries the callsigns.
  assert.match(privacy, /aircraft inside your fence/,
    'the privacy section no longer admits that the aircraft inside the fence are sent to this server');
  assert.equal(/Nothing you type is sent to this site/.test(privacy), false,
    'the privacy section is back to claiming that nothing is transmitted, which the code contradicts');
  assert.match(privacy, /last changed on 23 September 2026/,
    'the policy was rewritten without moving its own date');
});

test('97 · a takeoff time is never invented, and a run to the destination is never claimed as one', () => {
  const app = readSrc('src/app.ts');
  const detect = readSrc('src/detect.ts');

  // 🔴 THE RULE SURVIVES; THE MACHINERY IT WAS WRITTEN FOR DOES NOT.
  //
  // This test was written when the page carried a six-column list of watched aircraft with a departure
  // cell, a destination cell and a clock. The rule it protects is the one that matters and it has not
  // changed: **the feed carries no takeoff time, so the page may only claim what it saw** — measured on
  // a live Hamilton response, 22 Sep 2026, which gave position, altitude, ground speed, track, squawk,
  // an age and the quality flags, and no origin, no destination and no time of any kind.
  //
  // The list was deleted the same day — *"delete ## What the feed can see right now"* — and the two
  // observed times went with it. Measured in `src/app.ts`: `noteTimes` 0, `tookOffAt` 0,
  // `firstSeenAirborne` 0, `departureCell` 0, `destinationCell` 0, `runToDestination` 0, `clockTime` 0,
  // `startedAt` 0. **A check for a deleted mechanism asserts nothing about the page and cannot be made
  // to pass by any correct change**, so the assertions are replaced by the two things that are still
  // true and still worth guarding: the difference is said out loud where it is still said, and none of
  // the retired machinery has quietly come back.
  //
  //   · a CONFIRMED departure — the engine saw the aircraft on the ground first;
  //   · a first-seen-airborne one — weaker, and it must be labelled as the weaker thing.
  const alert = between(app, 'private notify(departure', 'private async loadAirports', 'the departure alert');
  assert.match(alert, /departure\.verdict === 'confirmed'/,
    'the alert no longer distinguishes a confirmed departure from a first-seen-airborne one');
  assert.match(alert, /It was on the ground and it is not now/,
    'the confirmed case is not described as the stronger fact');
  assert.match(alert, /It was first seen already climbing/,
    'the weaker case is not labelled as the weaker one, so an inference reads as an observation');

  // And the aircraft's own ground speed — the one number a run to a destination needs — is still carried
  // on the track state, so the estimate can be rebuilt from measured values rather than from a guess.
  assert.match(detect, /gsKt\?: number;/, 'the track state no longer declares the ground speed');
  assert.match(detect, /gsKt: Number\.isFinite\(reading\.gs\) \? \(reading\.gs as number\) : previous\?\.gsKt/,
    'the engine no longer keeps the aircraft\u2019s own ground speed from the feed');

  // If the list comes back, this check should be re-pointed at it rather than left asserting its absence.
  for (const gone of ['noteTimes', 'tookOffAt', 'firstSeenAirborne', 'departureCell', 'runToDestination', 'clockTime']) {
    assert.equal(new RegExp(`\\b${gone}\\b`).test(app), false,
      `the deleted table's \`${gone}\` is back in the page — re-point this test at it rather than leaving its absence asserted`);
  }
});

test('98 · a row you press puts the map on that flight, and pressing it again puts it back', () => {
  // ⚠️ HALF OF THIS TEST IS DEAD AND IT IS KNOWN DEBT: it still asserts the deleted table (`data-hex` and
  // `row-selected` on a `<tr>`, the green cell borders, the pointer cursor on `tr.aircraft-row`). Those
  // assertions fail on a file that is correct. Reported to George; NOT rewritten here, because rewriting a
  // test is a change of its own. The watchlist and map halves below are live and are the ones kept true.
  const app = readSrc('src/app.ts');
  const page = read(SITE, 'index.html');
  const css = read(SITE, 'styles.css');

  // 🔴 THE SELECTION IS ONE HEX, AND IT IS THE ENGINE'S OWN KEY. George, 22 Sep 2026: *"i want to be
  // able to select one of those rows, if i do that i want the map to zoom in to that flight. if slect
  // again, it will unselect and zom back out again"*. A callsign is reused and a row index moves when
  // the table is re-sorted, so the airframe's hex is the only identifier that survives both — and a
  // selection that outlives its flight is cleared rather than left holding the map.
  assert.match(app, /private selectedHex: string \| null = null;/, 'nothing records which flight was picked');
  // 🔴 RE-POINTED: THE TABLE IS GONE, AND THE PICK IS STILL THE SAME PICK.
  // The six-column list of watched aircraft was deleted on George's instruction — *"delete ## What the
  // feed can see right now"* — so `renderAircraft` no longer builds rows and the assertion that read a
  // row's own markup could not match anything. The BEHAVIOUR did not go anywhere: a row is pressed, the
  // press is keyed on the hex, and pressing the same one again puts the map back — and that is asserted
  // further down this test, where `pickFlight` is sliced and its `wasSelected` branch is read. What is
  // left to say here is the rule that outlives the press: a pick whose aircraft has left the fence is
  // DROPPED rather than left holding the map.
  assert.match(app, /this\.selectedHex !== null &&[\s\S]{0,140}!seen\.air\.some\(\(one\) => String\(one\.hex \?\? ''\)\.toLowerCase\(\) === this\.selectedHex\)[\s\S]{0,80}this\.selectedHex = null;/,
    'a pick that has left the fence is never dropped, so the map stays zoomed to an aircraft that is gone');

  // 🔴 AND THE ROW CARRIES BOTH THE KEY AND THE PRESS. `data-hex` is what the delegated listener reads;
  // `tabindex` is what makes the same press possible from the keyboard, because a row that only a mouse
  // can press is a row some readers cannot press at all.
  // 🔴 THE ROW MARKUP IS GONE WITH THE ROW. `data-hex` and `tabindex` on a table row, and the
  // `row-selected` class, belonged to the six-column list of watched aircraft that George had deleted
  // — *"delete ## What the feed can see right now"*. Measured: `data-hex` appears once in the page, on
  // the MAP's own marks, and the rows no longer exist to carry it. The keyboard rule it protected still
  // applies and is asserted where the marks are drawn; here the absence is asserted, so a table creeping
  // back without these attributes is caught.
  assert.equal(/row-selected/.test(app), false,
    'the deleted table\'s selected-row class is back — re-point these assertions at it rather than leaving their absence asserted');

  // 🔴 THE LISTENER IS ON THE DOCUMENT. The list is rewritten on every poll, so a listener attached to
  // a row goes with the row — the fault this file has already recorded once for the footer's door.
  const bind = app.slice(app.indexOf('private bindFlightPick('), app.indexOf('private pickFlight('));
  assert.ok(bind.length > 400, 'the pick binding is gone, so this check is vacuous');
  assert.match(bind, /document\.addEventListener\('click'/, 'the pick is bound to the rows instead of delegated');
  // ⚠️ THE GUARD GREW A TYPE ARGUMENT AND A FIFTH CONTROL. The live line is
  // `if (target.closest<HTMLElement>('button, a, input, .tail-chip, .map-switch')) return;` — the
  // generic is needed for the cast and the map switch was added when the row gained one — so a pattern
  // pinned to `closest('button, a, input, .tail-chip')) return` could not match a guard doing more than
  // it asked for. It asserts what the guard must refuse, not how it spells it.
  assert.match(bind, /closest[^(]*\('button, a, input, \.tail-chip[^']*'\)\) return/,
    'the pick swallows presses meant for the controls inside a row');
  // ⚠️ THE KEYDOWN BRANCH WENT WITH THE PRESSABLE ROW (22 Sep 2026). It existed to let a watching row be
  // pressed from the keyboard, and the row is a boolean now — the browser focuses and toggles a checkbox
  // itself, so a keydown matching a selector nothing carries is dead code. It is asserted ABSENT, because
  // a listener left behind reads as a feature that still works.
  assert.equal(/addEventListener\('keydown'/.test(bind), false,
    'a keydown listener is back for a row that is no longer pressable');
  assert.match(app, /this\.bindFlightPick\(\);/, 'the pick is never bound, so no row can be pressed');

  // 🔴 AND THE AIRCRAFT ON THE MAP IS PRESSABLE, WHICH IS THE THING GEORGE ACTUALLY CLICKED. His words,
  // after the rows were wired: *"click on any aircraft in the air is not zooming into that aircraft … the map
  // should zoom into it"*. A drawing of an aeroplane is the most obvious thing on the page to click, and it
  // carried no identity at all — the hex lived in the table's DOM and nowhere else. (The map's own markup is
  // checked below, where `renderMap` is sliced.)
  assert.match(bind, /closest<HTMLElement>\('\.locmap-plane-mark, \.locmap-plane-label'\)/,
    'the delegated pick does not recognise a press on the map');
  assert.match(css, /\.locmap-plane-mark\[data-hex\][\s\S]{0,120}cursor: pointer/,
    'an aeroplane that can be pressed does not look as though it can be');
  assert.match(css, /\.locmap-plane-label\[data-hex\]:hover/, 'the name beside an aeroplane gives no sign that it can be pressed');

  // 🔴 AND THE WAY BACK IS A CONTROL, NOT A PIECE OF KNOWLEDGE. *"i need a way to return to all flights"* —
  // pressing the same row again does it, but a reader who has scrolled to the map has no row in view.
  // ⚠️ IT RELEASES WHICHEVER OWNER HOLDS THE FRAME, so the handler is a block and not a one-liner: a
  // picked flight and rows switched off are two different reasons the map is narrowed, and the button is
  // the way back from either. The old pattern expected the flight pick alone.
  assert.match(app, /if \(all\) all\.addEventListener\('click', \(\) => \{/,
    'the return control is on the page but wired to nothing');
  assert.match(app, /if \(this\.mapHide\.size > 0\) this\.clearMapHide\(\);\s*\n\s*else this\.clearFlightPick\(\);/,
    'the return control releases only one of the two reasons the map is narrowed');
  assert.match(app, /private clearFlightPick\(\)[\s\S]{0,240}track\('flight_unselected', \{ via: 'show_all' \}\)/,
    'the return control does not record what it did');
  assert.match(page, /id="flightAll"[^>]*data-ga="flight-all"[^>]*hidden/, 'the return control is not on the page');
  // It lives OUTSIDE `#watchMap`, because everything inside that element is rewritten on every poll.
  const mapCard = page.slice(page.indexOf('id="watchMap"'), page.indexOf('</section>', page.indexOf('id="watchMap"')));
  assert.match(mapCard, /id="flightAll"/, 'the return control was put inside the element that is rewritten');

  // The second press of the same aircraft clears it; a press on another row moves the zoom.
  const pick = app.slice(app.indexOf('private pickFlight('), app.indexOf('private async loadMilitary('));
  assert.ok(pick.length > 200, 'the pick itself is gone, so this check is vacuous');
  assert.match(pick, /const wasSelected = this\.selectedHex === key;/,
    'the second press cannot tell that it is the second press');
  assert.match(pick, /this\.selectedHex = wasSelected \? null : key;/, 'the second press does not clear the pick');
  assert.match(pick, /this\.renderAircraft\(\);[\s\S]{0,60}this\.renderWatchlist\(\);/,
    'picking a flight does not redraw what it changes');

  // 🔴 AND THE MAP IS FRAMED ON THAT AIRCRAFT ALONE. The first version of this added the aircraft to a
  // box that still held every airport, so a flight came out at zoom 7 where 14 was available — the
  // measurement is in the comment beside it, because the code looked right and the number did not.
  const map = app.slice(app.indexOf('private renderMap('), app.indexOf('private bindMapResize('));
  assert.ok(map.length > 800, 'the map could not be isolated, so this check is vacuous');

  // 🔴 AND THE AEROPLANE ON THE MAP CARRIES ITS OWN IDENTITY, so the shape a reader clicks can name the
  // flight it is. Both the mark and the name beside it get the same `data-hex`, because to a reader the
  // label is part of the aeroplane, and a click that works on one and not the other is worse than neither.
  assert.match(map, /const press = ` data-hex="\$\{who\}"/, 'the mark carries a hex, but not as a data attribute');
  assert.match(map, /class="locmap-plane-mark\$\{picked \? ' locmap-plane-mark-picked' : ''\}"\$\{press\}/,
    'the aeroplane on the map carries no identity, so pressing it can do nothing');
  assert.match(map, /class="locmap-plane-label\$\{picked \? ' locmap-plane-label-picked' : ''\}"\$\{press\}/,
    'the name beside the aeroplane is not pressable, and it is part of the aeroplane to a reader');
  assert.match(map, /picked \? 'Press to go back to all flights' : 'Press to put the map on this aircraft'/,
    'the shape on the map says nothing about what pressing it will do');

  // 🔴 AND THE WAY BACK IS SHOWN ONLY WHEN THERE IS SOMETHING TO GO BACK FROM — here, in the one method
  // that knows both the selection and the label of the aircraft it is on.
  // ⚠️ THE CONDITION GREW. The control is shown when EITHER reason the map is narrowed applies — a picked
  // flight, or rows switched off — so the line is `this.selectedHex === null && this.mapHide.size === 0`.
  // The check asked for the left half alone and called a working control un-hidden.
  assert.match(map, /all\.hidden = this\.selectedHex === null && this\.mapHide\.size === 0;/,
    'the return control is not hidden when there is nothing to go back from');
  assert.match(map, /const all = byId\('flightAll'\);/, 'the return control is never shown or hidden at all');
  const pickBox = map.slice(map.indexOf('if (pickedFlown) {'), map.indexOf('const midLat'));
  assert.ok(pickBox.length > 200, 'the picked frame is gone, so this check is vacuous');
  assert.match(pickBox, /minLat = 90;/, 'the picked frame keeps the airports inside it, so it cannot zoom in');
  assert.match(pickBox, /pickedFlown\.trail \?\? \[\]/, 'the flight path is left out of the frame it should be fitted to');
  // ⚠️ THE CONDITION GREW A SECOND REASON. A picked flight and rows switched off are both "show me only
  // this", so the frame is taken on its own for either — `const zoom = pickedFlown || rowFilter`.
  assert.match(map, /const zoom = pickedFlown \|\| rowFilter\s*\n?\s*\? zoomForEverything/,
    'a picked flight does not take the frame on its own');
  // The fence is not drawn at that zoom — its edge is hundreds of kilometres away, so all it could draw
  // is a wall of green across the view. Same second reason applies.
  assert.match(map, /\(anchorPx && !pickedFlown && !rowFilter\s*\n?\s*\? `<circle class="locmap-fence"/,
    'the fence is drawn across a map that is zoomed to one aircraft');

  // 🔴 AND AIRCRAFT OUTSIDE A ZOOMED FRAME ARE NOT AIRCRAFT WITHOUT A POSITION. The note said the
  // second when it meant the first, which was survivable while the frame held everything and became a
  // plainly false sentence the moment a picked flight left fifty-nine aircraft off the edge.
  assert.match(map, /let offView = 0;/, 'aircraft pushed off the edge by the zoom are not counted');
  assert.match(map, /const unplaced = watching\.length - placed\.length;/,
    'the count of aircraft with no position still includes the ones merely off the edge');
  assert.match(map, /offView > 0[\s\S]{0,200}outside this frame/, 'the page does not say that aircraft are outside the frame');

  // 🔴 AND THE MAP IS TALLER, WHICH IS WHAT LETS IT ZOOM IN FURTHER. The fence is a circle and the map
  // is a rectangle, so the circle's own diameter has to fit in both directions — and the height was the
  // binding constraint at every distance. Measured on an 854-pixel card: the 463 km ring needed 522
  // pixels at zoom 6 against 380 usable, so one whole step was being given away to the map's shape.
  assert.match(map, /Math\.min\(VIEW_W \* 0\.78, 620\)/, 'the map was not made taller, so the same ring is drawn a step further out');
  assert.equal(/VIEW_W \* 0\.66, 460/.test(map), false, 'both the old height and a new one are in the file');

  // 🔴 AND THE TABLE AND THE MAP FOLLOW A CHANGE TO WHAT IS WATCHED, AT ONCE. George, 22 Sep 2026:
  // *"when i make a change to what im watching the map should refresh"*. Pressing a star used to redraw
  // the list and leave the table and map until the next poll — up to twenty seconds of a map that
  // disagreed with the list above it.
  // ⚠️ THE REGION RUNS TO THE NEXT METHOD, NOT TO `renderFilterNote` — that call sits INSIDE
  // `renderTypeList`, above every listener bound below it, so slicing to it returned the markup and
  // none of the handlers and the check failed on a file that was correct. A false failure is worse
  // than no check.
  const typeList = app.slice(app.indexOf('private renderTypeList('), app.indexOf('private renderWatchlist('));
  const starHandler = typeList.slice(typeList.indexOf("querySelectorAll<HTMLButtonElement>('.type-toggle')"), typeList.indexOf("querySelectorAll<HTMLButtonElement>('.alert-toggle')"));
  assert.ok(starHandler.length > 400, 'the star handler could not be isolated, so this check is vacuous');
  assert.match(starHandler, /this\.renderAircraft\(\);/,
    'starring a type does not redraw the table and the map, so they wait for the next poll');
  const tailHandler = typeList.slice(typeList.indexOf("querySelectorAll<HTMLButtonElement>('.tail-chip')"));
  assert.match(tailHandler, /this\.renderAircraft\(\);/,
    'ticking a tail does not redraw the table and the map');
  const watchlist = app.slice(app.indexOf('private renderWatchlist('), app.indexOf('private renderWatchButton('));
  const removeHandler = watchlist.slice(watchlist.indexOf("querySelectorAll<HTMLButtonElement>('.type-remove')"));
  // ⚠️ THE PRESS ASKS BEFORE IT REMOVES. Stopping watching is a one-way door — the cross takes the row,
  // its tails and its aircraft off the map, and the only way back is finding the type again in step 2 —
  // so the handler does not redraw anything itself: it puts the question, in the page's own box, and the
  // redraw happens inside the removal once the answer is yes. See `removeTypeRule`, which is asserted to
  // redraw all three things below.
  assert.match(removeHandler, /this\.askRemove\('type', code, /,
    'stopping watching a type does not ask first');
  assert.match(between(app, 'private removeTypeRule', 'private renderWatchButton', 'the type removal'),
    /this\.renderAircraft\(\);/,
    'removing a type does not redraw the map and the watch rows');

  // 🔴 AND THE WATCHLIST ROW THAT NAMES ONE AIRCRAFT CARRIES A BOOLEAN, NOT A PRESS. George, 22 Sep 2026:
  // *"even though the filight may or may not be in the air, i want this to be a boolean input, not a
  // link"*. The same switch a type row carries, always available — the old press existed only while the
  // aeroplane was reporting a position, which is a control with a hidden precondition.
  assert.equal(/li\.watch-type\[data-hex\]/.test(watchlist), false, 'the named tail row is a link again');
  assert.match(watchlist, /this\.mapSwitch\('tail', item, state\.kind\)/, 'the named tail row has no show-on-map boolean');
  assert.match(watchlist, /this\.mapSwitch\('type', rule\.type, state\.kind\)/, 'the type row has no show-on-map boolean');
  assert.match(app, /private mapSwitch\(kind: 'type' \| 'tail', value: string, stateKind: string\): string/,
    'a switch is asked for a fact it must not depend on');
  // The slice starts at the signature, so the note beside it — which names the `disabled` attribute it
  // explains the removal of — is outside it and cannot make this a false failure.
  assert.equal(/disabled/.test(app.slice(app.indexOf('private mapSwitch('), app.indexOf('private toggleMapShow('))), false,
    'a show-on-map switch can still be disabled, so it is a conditional control again');
  assert.equal(/watch-type[^`]*data-hex/.test(typeList), false, 'a watched type was made pressable, and it names no single flight');

  // 🔴 AND THE DEFAULT IS EVERY ROW ON, BECAUSE THE STORED STATE IS THE ROWS SWITCHED OFF. George,
  // 22 Sep 2026: *"if all switches are off, show them all, i dont want this, the default is to have
  // switches on, and the user can turn them off"*. An empty set therefore means "nothing excluded" — so
  // all-off is an empty map that says so, and never a silent reset to everything.
  assert.match(app, /private mapHide = new Set<string>\(\);/, 'the default is not "every row on"');
  assert.match(app, /const on = !this\.mapHide\.has\(key\);/, 'a switch does not start on');
  assert.match(app, /if \(on\) this\.mapHide\.delete\(key\);\s*\n\s*else this\.mapHide\.add\(key\);/,
    'the switch does not store the rows that are off, so all-off cannot mean nothing');
  assert.match(app, /private rowVisible\(one: TrackState\): boolean/, 'nothing decides whether a row was switched off');
  assert.match(app, /const rowFilter = this\.mapHide\.size > 0 && !pickedFlown;/,
    'an all-off list is still treated as "no filter", which is the behaviour George rejected');
  assert.equal(/mapShow/.test(app), false, 'the old switched-on set is still in the file');

  // 🔴 THE GREEN HUE SURVIVED; THE TABLE IT WAS DRAWN ON DID NOT. George asked for it — *"the select and
  // unselected can be a simple green hue border"* — and it was drawn on `tr.row-selected td`, which went
  // with the six-column list. `site/styles.css` records the removal where the code was: *".table-wrap,
  // .aircraft, … .aircraft tr.row-selected family all styled elements the page no longer draws"*.
  // The rule still holds and is asserted where the shapes that remain are: the picked aircraft on the
  // MAP is marked, and differently from its neighbours.
  assert.match(css, /\.locmap-plane-label-picked/, 'a picked aircraft is not marked on the map');
  // ⚠️ A RULE, NOT A MENTION. `css` is the RAW stylesheet, and the stylesheet's own notes name the
  // retired selectors while explaining why they went — so a bare substring search for
  // `.aircraft tr.row-selected` matched the COMMENT that records its removal and reported the rule as
  // present. **A false failure, and mine.** Requiring a block after the selector is what makes this an
  // assertion about the stylesheet rather than about its prose.
  // 🔴 AND IT IS THE COMMENT-STRIPPED STYLESHEET, BECAUSE THIS PATTERN TRIED TWICE TO MATCH PROSE.
  // `[^{]*\{` walks past the mention in the stylesheet's own note and reaches the next `{` in the file —
  // which is a real rule, thousands of characters later — so it reported the rule as present. The
  // instrument for "a rule is absent" is the stylesheet with its reasons removed.
  const bareCss = stripCss(css);
  assert.equal(/\.aircraft tr\.row-selected/.test(bareCss), false,
    "the deleted table's selected-row rules are back — re-point this at them rather than leaving their absence asserted");
  assert.match(css, /\.locmap-plane-pick \{[^}]*stroke: #4ade80/, 'the picked aircraft is not ringed in the same green');
  // The named tail has no picked state any more — it is a boolean, not a selection — so the rule that
  // marked it went with the press it marked. Asserted as a RULE (selector followed by a block), because
  // the stylesheet's own note names the retired selector while explaining why it went.
  assert.equal(/\.watch-type\.row-selected/.test(bareCss), false, 'a picked-tail rule is back for a row that is a boolean');
  // ⚠️ AND THE CURSOR WENT WITH THE ROW. `.aircraft tr.aircraft-row { cursor: pointer }` styled a table row
  // that could be pressed; the pressable thing is the aeroplane on the map now, and the rule that says so
  // is asserted earlier in this test — `.locmap-plane-mark[data-hex] { cursor: pointer }`.
  assert.equal(/\.aircraft tr\.aircraft-row/.test(bareCss), false,
    "the deleted table's pressable-row rule is back — re-point this at it rather than leaving its absence asserted");

  // And the page says which frame is in use, because a map that suddenly has no ring must say why — and
  // it says, where the rows are, that the rows can be pressed at all.
  assert.match(map, /It is zoomed to <b>/, 'the note does not say that the map is on one aircraft');
  // ⚠️ THE INSTRUCTION MOVED FROM THE ROW TO THE SHAPE. The page used to say *"Press any row to put the map
  // on that aircraft"*, and `index.html` records what happened to it: the pressable row was deleted with
  // the list — *"the per-row press that put the map on a flight"* is named in the note listing what
  // went. The thing a reader presses now is the aeroplane ON the map, and its own `title` says so —
  // *"Press to put the map on this aircraft"* — which is asserted earlier in this test. What is left to
  // require here is that the page does not still promise a row that cannot be pressed.
  assert.equal(/Press any row to put the map on that aircraft/.test(page), false,
    'the page still promises a row press that the deleted list carried');
});

test('99 · the list and the map show the same aircraft: what you watch, inside your fence, seen in the air', () => {
  // ⚠️ PART OF THIS TEST IS DEAD AND IT IS KNOWN DEBT: it still asserts the deleted table (`seen.air.slice(0,
  // 60)`, the empty state's three counts and its `limits` list), which fails on a file that is correct.
  // Reported to George; not rewritten here. The fence, watch and freshness assertions below are live.
  const app = readSrc('src/app.ts');
  const page = read(SITE, 'index.html');

  // 🔴 ONE RULE, IN ONE PLACE, READ BY BOTH HALVES OF THE PAGE. George, 22 Sep 2026: *"i want it to filter
  // by tail that has been seen in the air from my location, and other filters"* — after reporting the fault
  // this fixes: *"i filters my 25km, clicked some that were seen latt 5 min agoi, thaey all say in the air,
  // but they are no visible in my map"*. Measured on the live page before the fix: the fence read "25 km",
  // the table listed 60 aircraft whose positions were in Michigan and Ohio, and the map drew 2 of them and
  // apologised for the other 58. The table was filtered by what the reader watches and by NOTHING else.
  const helper = app.slice(
    app.indexOf('private seenInTheAirInsideFence('),
    app.indexOf('private async loadSurvey(')
  );
  assert.ok(helper.length > 600, 'the one filter both halves share is gone, so this check is vacuous');

  // 1 · ARE THEY WATCHED — the starred types and named tails, which is where the maker, kind, era and
  // military filters already live, so "and other filters" keeps working through `matchOf`.
  assert.match(helper, /if \(!this\.isWatchedNow\(state\)\) continue;/, 'the watch filter is bypassed');
  assert.match(helper, /watched \+= 1;/, 'the number of watched aircraft is not counted, so an empty list cannot say why');

  // 2 · INSIDE THE FENCE — measured from the same centre everything else uses, at the distance chosen.
  //
  // ⚠️ THE FILTER DELEGATES, SO THE ASSERTIONS FOLLOW IT. This asked for `const centre = this.point();`
  // and `radiusNm: kmToNm(this.radiusKm)` INSIDE the filter, but the filter calls `this.insideFence(state)`
  // and the fence calls `this.insideMyCircle(...)` — one question, asked in one place, reached three deep.
  // The old patterns therefore could not match, and they reported that the fence ignored the reader's
  // distance while it was using it. **What has to hold is the delegation and the arithmetic at the
  // bottom of it**, so both are asserted where they actually live.
  assert.match(helper, /if \(!this\.insideFence\(state\)\) \{/, 'the filter asks a second fence question of its own');
  const circle = between(app, 'private insideMyCircle', 'private async loadSurvey', 'the circle test');
  assert.match(circle, /const centre = this\.point\(\);/, 'the fence is measured from a different centre than the map uses');
  assert.match(circle, /kmToNm\(this\.radiusKm\)/, 'the fence radius is not the one the reader chose');
  assert.match(circle, /distanceNm\(centre\.lat, centre\.lon, lat, lon\)/,
    'the distance to the fence centre is never measured');
  // ⚠️ THE FENCE ASSERTION MOVED TO THE CIRCLE. The filter asks `this.insideFence(state)` and the fence
  // asks `this.insideMyCircle(...)`, so `away > radiusNm` no longer appears in the filter — it was the
  // hand-rolled copy of the circle that the delegation replaced, and the radius is asserted on the circle
  // itself above. What stays here is the phase test, which the filter still does for itself.
  assert.match(helper, /if \(!this\.insideFence\(state\)\) \{/, 'the filter no longer asks the fence');
  assert.match(helper, /if \(state\.phase !== 'airborne'\) \{\s*\n\s*onGround \+= 1;/,
    'an aircraft on the ground is listed as seen in the air');

  // 3 · AND BOTH HALVES READ IT. Two lists that can disagree are two lists that eventually will: the map drew
  // *everything watched* while the table drew the rows, which is exactly how a 25 km fence came to show two
  // shapes and a caption about fifty-eight aircraft nobody could see.
  // ⚠️ THE TABLE HALF IS RETIRED WITH THE TABLE. `const rows = seen.air.slice(0, 60);` built the
  // six-column list George deleted — *"delete ## What the feed can see right now"* — so the assertion
  // that the LIST is built from the shared filter has nothing to read. `seen` itself is still computed
  // at `renderAircraft`'s head (line 1998), which is what the counting and the stale-pick sweep use.
  // The map half below is untouched and is the one that matters most: it is the half that was drawing
  // everything watched while the list drew the rows.
  assert.match(app, /const seenNow = this\.seenInTheAirInsideFence\(snapshot\);\s*\n\s*const watching = seenNow\.air;/,
    'the map is not drawn from the shared filter, so it can disagree with the list above it');
  assert.equal(/const rows = seen\.air\.slice\(0, 60\)/.test(app), false,
    "the deleted table's row slice is back — re-point this assertion at it rather than leaving its absence asserted");
  assert.equal(/snapshot\.filter\(\(one\) => this\.isWatchedNow\(one\)\)/.test(app), false,
    'the old watch-only list is still in the file, so one of the two still bypasses the fence');

  // 🔴 AND THE SAME LIST IS FILTERED BY THE CLOCK, WHICH IS THE HALF THAT WAS MISSING.
  //
  // George, 22 Sep 2026: *"now im seeing on the map an hour ago, but its showing on the map as if its in
  // the air in my viewing areas"*. The engine keeps a track for 45 minutes, so `phase: 'airborne'` plus a
  // last known position survived long after the feed stopped reporting the aircraft — and the row counts
  // and the map asked about the phase and the fence and never about the time. Reproduced with a feed that
  // reported one aircraft twice and then nothing: it was still drawn, labelled and counted as "in the
  // air" three minutes later.
  assert.match(helper, /if \(!this\.heardRecently\(state\)\) \{\s*\n\s*stale \+= 1;/,
    'a track the feed has stopped reporting still counts as being in the air');
  assert.match(helper, /heardRecently\(state\)/,
    'the shared filter never asks how old the reading is');
  assert.match(app, /private freshMs\(\): number \{\s*\n\s*return Math\.max\(this\.pollMs \* 2, 90_000\);/,
    'the freshness window is not tied to the poll cadence with a floor');
  assert.match(app, /private heardRecently\(state: TrackState\): boolean \{/,
    'nothing decides whether a reading is recent enough to talk about');
  assert.match(app, /return Number\.isFinite\(state\.observedAt\) && state\.observedAt > Date\.now\(\) - this\.freshMs\(\);/,
    'the freshness test does not compare the reading time with the window');
  assert.match(app, /private isHereNow\(state: TrackState\): boolean \{[\s\S]{0,140}heardRecently\(state\) && this\.insideFence\(state\) && state\.phase === 'airborne'/,
    'there is no single predicate for "here now", so the rows and the map can drift apart again');
  // Both lists the rows and the chips are counted from read the one predicate.
  assert.equal((app.match(/filter\(\(one\) => this\.isHereNow\(one\)\)/g) ?? []).length, 2,
    'the live lists are not both filtered by the same "here now" rule');
  // And the page says out loud how many it is holding that way, because a row may still name them.
  assert.match(app, /staleAircraft > 0[\s\S]{0,220}not been heard from[\s\S]{0,120}not drawn/,
    'the map does not say that aircraft it is not drawing have stopped being heard');

  // 🔴 AND "ON THE MAP X AGO" IS ABOUT THIS MAP. The label read the survey FILE's last sighting, so a
  // reader could be told an hour while the aeroplane sat drawn in front of them.
  assert.match(app, /private mapLastDrawn = new Map<string, number>\(\);/,
    'nothing remembers when this page last drew a type');
  assert.match(app, /if \(drawnType !== ''\) this\.mapLastDrawn\.set\(drawnType, Date\.now\(\)\);/,
    'the drawn list does not record what it drew');
  assert.match(app, /const drawnAt = this\.mapLastDrawn\.get\(upper\);\s*\n\s*if \(drawnAt !== undefined\) return new Date\(drawnAt\);/,
    'the row still prefers a file over what this page drew');

  // 🔴 AND AN EMPTY LIST NAMES WHICH EMPTY IT IS — three limits now, not two, and naming the wrong one was the
  // fault the original paragraph was written to prevent.
  // 🔴 RE-POINTED: THE COUNTS MOVED FROM THE DELETED CARD TO THE MAP'S OWN NOTE.
  // The card that is gone owned three empty states — nothing in the fence, nothing matching what you
  // picked, nothing watched currently in the air — and named which one applied. George deleted the card
  // (*"delete ## What the feed can see right now"*), so `limits`, `seen.watched === 0` and the numbered
  // sentences went with it: measured, zero hits. **The distinction did not go anywhere** — the map has to
  // say whether an empty picture means nothing is flying or nothing is flying here — so it is asserted
  // where the map's own note is written.
  assert.match(app, /Nothing you are watching is inside the fence at this moment/,
    'an empty map does not say which empty it is');
  assert.match(app, /Every aircraft seen in the air inside the fence/, 'the map does not state the rule it draws by');
  assert.equal(/const limits: string\[\] = \[\]/.test(app), false,
    "the deleted card's limit list is back — re-point this at it rather than leaving its absence asserted");

  // ⚠️ THE CARD'S SENTENCE IS GONE WITH THE CARD. *"The aircraft **inside your fence**, **seen in the
  // air**, that **match what you picked**"* was the list's own heading, and the list was deleted. The map
  // states the same three rules in its own words — *"Every aircraft seen in the air inside the fence,
  // named in full and drawn where the feed last reported it"* — and that sentence is asserted above.
  assert.equal(/The aircraft <b>inside your fence<\/b>/.test(page), false,
    "the deleted card's rule sentence is back — re-point this at it rather than leaving its absence asserted");
  // ⚠️ THE SENTENCE ABOUT GROUND ROWS WENT WITH THE LIST THEY WERE HELD OUT OF. The page said *"an
  // aircraft on the ground is not listed until it takes off"*; there is no list, and the classification
  // it depended on is what the page states now — *"Each reading is classified as on the ground,
  // airborne, or unknown"* — with the ground case given its own consequence: *"A delivery on its way on
  // the ground is not a departure"*. What has to stay true is that a grounded aircraft is not counted as
  // in the air, and that is asserted on the filter itself above.
  assert.match(page, /classified as on the ground, airborne, or unknown/,
    'the page no longer says how a reading is classified, so the ground case has no home in the copy');
});

/* ----------------------------------- part 4 · the way out of the settings --- */

test('100 · "delete my data" is the last item on the location row, asks first, and takes the filters with it', () => {
  const app = readSrc('src/app.ts');
  const page = stripHtml(read(SITE, 'index.html'));

  // 🔴 WHERE IT IS, AND THAT IT IS LAST. George, 22 Sep 2026: *"last item, right align a link on the
  // row for Your location Hamilton change location called delete my data, with confirmation box. this
  // effectivly resets their location, and everything else"*.
  const rowAt = page.indexOf('<p class="place-line" id="placeKnown"');
  assert.ok(rowAt > -1, 'the location row is gone, so this check is vacuous');
  const row = page.slice(rowAt, page.indexOf('</p>', rowAt));
  const onTheRow = [...row.matchAll(/<button[^>]*id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(onTheRow, ['changePlace', 'forgetMine'],
    `the location row's controls are ${onTheRow.join(', ')} — delete my data must be the LAST item on it`);
  assert.match(row,
    /<button type="button" class="linkish place-forget" id="forgetMine" data-ga="forget-mine">delete my data<\/button>/,
    'the control is missing, is not a button (so it cannot be reached from the keyboard), or its label is not "delete my data"');

  // 🔴 AND IT SITS ON THE RIGHT. Equal-specifity rules and source order are the two ways a right-align
  // quietly does nothing, so both are checked: this rule is more specific than `.place-line .linkish`
  // (three classes beat two) and it also comes later in the file.
  const alignAt = css.indexOf('.place-line .linkish.place-forget {');
  assert.ok(alignAt > css.indexOf('.place-line .linkish {'),
    'the right-align rule is gone, or it comes before the rule it has to beat');
  const align = css.slice(alignAt, css.indexOf('}', alignAt));
  assert.match(align, /margin-left: auto/, 'the control is not pushed to the right of the row');

  // 🔴 AND IT ASKS IN THIS PAGE'S OWN BOX, NOT IN A BROWSER BOX. George, 22 Sep 2026: *"the delete
  // should not use browser confirm."* So the handler is checked for what it does NOT contain as well
  // as for what it does — the question and the deed live in different methods, and this one is the
  // question only.
  const handler = app.slice(app.indexOf('private bindForgetMine('), app.indexOf('private wipeMyData('));
  assert.ok(handler.length > 400, 'the handler is gone, so this check is vacuous');
  assert.match(handler, /dialog\.showModal\(\)/, "the control does not open the page's own box");
  assert.equal(handler.includes('forgetStored'), false,
    'the question and the deed are in one method again, so nothing separates asking from deleting');
  assert.equal(handler.includes('reload'), false, 'the handler reloads, so it could reload without an answer');
  assert.equal(handler.includes('track('), false, 'the handler records something, which means it acts');

  // No browser confirm anywhere in the page's own code — the instruction, stated once, where any new
  // control would have to walk past it.
  const sources = ['src/app.ts', 'src/detect.ts', 'src/consent.ts', 'src/airports.ts', 'site/index.html']
    .map((file) => (file.endsWith('.html') ? stripHtml(read(SITE, 'index.html')) : readSrc(file)))
    .join('\n');
  assert.equal(/window\.confirm/.test(sources), false, 'a browser confirm is somewhere in the page code');

  // 🔴 THE DEED IS IN ONE PLACE, AND ONLY THE CONFIRM BUTTON CAN REACH IT.
  const deed = app.slice(app.indexOf('private wipeMyData('), app.indexOf('private bindFlightPick('));
  assert.ok(deed.length > 100, 'the deed is gone, so this check is vacuous');
  assert.match(deed, /forgetStored\(true\)/, 'the deed does not clear the cookie answer with the rest');
  assert.match(deed, /track\('data_deleted'/, 'the deletion is not recorded');
  assert.match(deed, /window\.location\.reload\(\)/, 'the page is left holding what it just deleted');
  assert.equal([...app.matchAll(/this\.wipeMyData\(\)/g)].length, 1,
    'the deletion is reachable from more than one place');
  const goAt = app.indexOf("byId('forgetGo')");
  assert.ok(goAt > -1, 'the confirmation has no button that deletes');
  assert.match(app.slice(goAt, app.indexOf('});', goAt)), /this\.wipeMyData\(\)/,
    'the deletion is not performed by the button that says it will be');

  // 🔴 AND THE BOX IS THE PAGE'S OWN MARKUP, OUTSIDE EVERY CARD. A modal inside a card that the
  // prerequisite gate can hide would be a box that cannot open, so its position is checked rather
  // than assumed.
  const dialogAt = page.indexOf('<dialog id="forgetDialog"');
  assert.ok(dialogAt > -1, 'the page carries no confirmation box');
  assert.ok(dialogAt > page.indexOf('</footer>'), 'the box is inside the card stack, where the gate can hide it');
  const box = page.slice(dialogAt, page.indexOf('</dialog>', dialogAt));
  assert.deepEqual([...box.matchAll(/<button[^>]*id="([^"]+)"/g)].map((match) => match[1]),
    ['forgetCancel', 'forgetGo'], 'the safe answer must be offered first and the destructive one last');
  // ⚠ AND THE BOX IS READ AS TEXT, WITH WHITESPACE COLLAPSED. The sentence is wrapped across lines in
  // the markup, so a regex for the phrase fails against a box that is perfectly correct — the same
  // false failure this file's header warns about, met twice today: once as a wrapped string literal,
  // and once as a wrapped line of HTML. Read the words the reader reads, never the source's layout.
  const boxText = box.replace(/\s+/g, ' ');
  assert.match(boxText, /the kind, maker, era and last-seen filters/,
    'the box does not tell the reader that the filters go with it');
  assert.match(boxText, /goes back to the defaults/, 'the box does not say the page returns to its defaults');
  assert.match(boxText, /keeps no copy of any of it/, 'the box does not say the deletion cannot be undone');

  // 🔴 NOTHING IS WATCHED UNTIL THE READER CHOOSES IT, SO A WIPE LEAVES NOTHING WATCHED. George,
  // 22 Sep 2026: *"and when i deleted, i retained the airport im watching"* — then *"i delete
  // everything it shgould also remove ### The airports you are watching"*. BOTH are the same defect,
  // and it was not the store: **a wipe cleared the store and the page refilled the fact from a
  // constant.** Every load seeded `DEFAULT_AIRPORT` when the store was empty, so the page watched
  // Hamilton before the reader had said anything, and a wiped page came back with that heading over a
  // chosen Hamilton chip. So there are three claims here, and the third is the one that keeps the
  // other two true.
  const seeding = app.slice(app.indexOf('void this.loadChosenAirports(saved)'), app.indexOf('void this.loadSurvey()'));
  assert.ok(seeding.length > 0, 'the seeding call is gone, so this check is vacuous');
  assert.match(app, /void this\.loadChosenAirports\(saved\);/, 'the default airport is seeded again');
  assert.match(app, /const saved = readStore\(AIRPORT_KEY, ''\)/,
    'the airport read still falls back to a default, so an empty store still yields an airport');
  assert.equal(/DEFAULT_AIRPORT/.test(app), false,
    'this file mentions DEFAULT_AIRPORT again — the constant is a fact about the airport list, not a decision the page may make for the reader');
  assert.equal(/loadChosenAirports\(saved\.length > 0 \? saved : \[/.test(app), false,
    'the empty case is filled with a default again');

  // And the store holds the reader's airports and nothing else: something chosen is stored, nothing
  // chosen REMOVES the key — an empty string left a key behind, so a wipe was never empty and
  // unpicking the last airport left a trace of the choice.
  const afterAirport = app.slice(app.indexOf('private afterAirportChange('), app.indexOf('private stop('));
  assert.ok(afterAirport.length > 200, 'the airport-change path is gone, so this check is vacuous');
  assert.match(afterAirport, /if \(picked\.length > 0\) writeStore\(AIRPORT_KEY, picked\.join\(','\)\);/,
    'the airports are not stored from what the reader chose');
  assert.match(afterAirport, /else dropStore\(AIRPORT_KEY\);/,
    'an empty set writes an empty string instead of removing the key, so the store keeps a trace');

  // 🔴 AND THE WIPE FINDS ITS KEYS RATHER THAN REMEMBERING THEM.
  const wipe = app.slice(app.indexOf('function storedKeys('), app.indexOf('function forgetStored('));
  assert.match(wipe, /for \(let at = 0; at < localStorage\.length; at \+= 1\)/,
    'the wipe does not enumerate the store, so it must be carrying a list of names');
  assert.match(wipe, /key\.startsWith\(STORE_PREFIX\)/, 'the wipe does not match the page\'s own prefix');
  assert.match(wipe, /includeConsent && CONSENT_KEYS\.includes\(key\)/,
    'the cookie answer survives the wipe, so the page keeps something the reader asked it to drop');

  // THE ASSERTION THAT WOULD HAVE CAUGHT THE HAND LIST: every stored key the file declares must be covered
  // by the prefix. Start over used to carry nine names and miss two — `aircraft_alerts` and
  // `aircraft_place_area` — so the alert bells and the community survived it. A key that does not begin with
  // the prefix is invisible to the wipe, and this fails on it by name.
  const declared = [...app.matchAll(/const ([A-Z][A-Z_]*_KEY) = '([^']+)';/g)].map((match) => [match[1], match[2]]);
  assert.ok(declared.length >= 11, `only ${declared.length} stored keys are declared, so this check is vacuous`);
  const uncovered = declared.filter(([, value]) => !value.startsWith('aircraft_'));
  assert.deepEqual(uncovered.map(([name, value]) => `${name}=${value}`), [],
    'these stored keys do not begin with the prefix, so a wipe leaves them behind');
  for (const wanted of ['KIND_KEY', 'MAKER_KEY', 'ERA_KEY', 'SEEN_KEY']) {
    assert.ok(declared.some(([name]) => name === wanted),
      `${wanted} is no longer declared — the wipe can only cover what the page still stores`);
  }

  // And Start over goes through the same enumerator, keeping the cookie answer it has always kept.
  const startOver = app.slice(app.indexOf('private bindStartOver('), app.indexOf('private bindForgetMine('));
  assert.match(startOver, /forgetStored\(false\)/, 'Start over no longer wipes anything');
  assert.equal(/\[WATCH_KEY, TYPES_KEY/.test(startOver), false,
    'Start over carries a hand-written list of keys again — the list that had already fallen behind the page');

  // And the policy tells the reader the control exists, because a way out nobody can find is not a way out.
  assert.match(page, /<b>delete my data<\/b> link/, 'the privacy section does not name the control');
  assert.match(page, /which asks you to confirm and then clears/, 'the privacy section does not say that it asks');
});

test('101 · the cards are hidden until their prerequisite is met, and cannot be folded — and the type sits over the tail', () => {
  const app = readSrc('src/app.ts');
  const page = stripHtml(read(SITE, 'index.html'));

  // 🔴 THE GATE STAYS, THE FOLD GOES. George, 22 Sep 2026: *"for all cards i dont want the user to
  // collapse and uncollpase, just hide the cards if they havent completed the prequisite steps."*
  // The page already did the hiding on its own; what was left to remove was the fold the reader could
  // drive, so BOTH halves are checked — the gate still gates, and nothing can fold.
  const gate = app.slice(app.indexOf('private updateSteps('), app.indexOf('private bindStartOver('));
  assert.ok(gate.length > 600, 'the prerequisite gate is gone, so this check is vacuous');
  assert.match(gate, /const show = step === 1 \? true/, 'the first step is no longer always shown');
  assert.match(gate, /section\.hidden = true/, 'a step whose prerequisite is unmet is no longer hidden');
  assert.match(gate, /if \(show && section\.hidden\)/, 'a step is never revealed by the gate');
  assert.match(gate, /const answered1 = place;/, 'the first prerequisite is no longer a place');
  assert.match(gate, /const answered2 = answered1 && picked;/, 'the second prerequisite is no longer a pick');

  // And the fold is gone from the code, the stylesheet AND the page — all three, because a rule removed
  // in one of them and left in another is exactly how a control comes back.
  const everything = `${app}\n${cssCode}\n${page}`;
  assert.equal(/step-folded|step_folded|bindStepToggles/.test(everything), false,
    'the fold machinery is back in the code, the styles or the page');
  assert.equal(/aria-expanded/.test(everything), false,
    'a step heading still advertises itself as something you can open and close');
  assert.equal(/\.step-gated > h2\s*\{[^}]*cursor:\s*pointer/.test(cssCode), false,
    'the step headings still show a pointer cursor, so they still look pressable');
  assert.equal(/\.step-gated > h2::after/.test(cssCode), false, 'the chevron is back on the step headings');
  // The glide on arrival is NOT the fold, and removing it would be a different change: keep it.
  assert.match(cssCode, /step-arrive/, 'the arrival glide was removed along with the fold');

  // 🔴 AND THE AIRCRAFT TYPE SITS ON TOP OF THE TAIL. George, 22 Sep 2026: *"in type put airplaye type
  // on top of tail"* — the second time he asked for this arrangement today: *"for type list the tail
  // under the aircraft type"*.
  // 🔴 RETIRED: THE ROW THAT ARRANGED THEM IS GONE. George asked twice on 22 Sep 2026 for the aircraft
  // type to sit on top of the tail — *"in type put airplaye type on top of tail"*, then *"for type list
  // the tail under the aircraft type"* — and both were about the WATCH LIST's rows. The six-column table
  // that carried `cell-tail` was deleted later the same day (*"delete ## What the feed can see right now"*),
  // so `tailUnderType` and `cell-tail` appear nowhere in the page: measured, zero hits. **The arrangement
  // cannot be asserted where it no longer is**, so the assertion is retired rather than re-pointed, and
  // the ordering rule it protected is stated where the rows that remain are built.
  assert.equal(/tailUnderType|cell-tail/.test(app), false,
    'the deleted table\'s row markup is back — re-point this assertion at it rather than leaving its absence asserted');
  assert.match(between(app, 'private renderWatchlist', 'private notify(departure', 'the watch rows'),
    /watch-what/,
    'the watch rows no longer carry the element that names what is being watched');
  assert.equal(/info\.known && tailUnderType/.test(app), false,
    "the tail is hidden again whenever the type code is not in this site's type table — a fact about the table, not about the airframe");
  // 🔴 RETIRED: the two rules stacked the deleted table's cells, and neither class exists now. Measured
  // in `site/styles.css`: `.cell-type` and `.cell-tail` appear zero times. The arrangement they described
  // — the type above the tail — is asserted where the rows that remain are built, above.
  assert.equal(/\n\.cell-(type|tail) \{/.test(cssCode), false,
    "the deleted table's cell rules are back in the stylesheet — re-point this at them rather than leaving their absence asserted");
});

test('102 · the switch has no words, wears the row\'s colour, lines up — and the cross asks first', () => {
  // George, 22 Sep 2026, one message, four requests: *"remove the show on map redundant text, add a html
  // confirmation box if deleting a watched airplane type. in the air messages should be vertically
  // alinged with the switch and the swtich should conform with ther colors."*
  const app = readSrc('src/app.ts');
  const cssSource = read(SITE, 'styles.css');
  const cssRules = stripCss(cssSource);

  // 1 · NO WORDS BESIDE THE SWITCH — the row's own sentence already says what it is for. The name is
  // still there for anyone who cannot see the shape, so this is a removal of a duplicate, not of the
  // accessible name.
  const switchBody = app.slice(app.indexOf('private mapSwitch('), app.indexOf('private toggleMapShow('));
  assert.ok(switchBody.length > 300, 'the switch builder could not be isolated, so this check is vacuous');
  assert.equal(/show on map<\/span>/.test(switchBody), false, 'the redundant "show on map" text is still rendered');
  assert.match(switchBody, /aria-label="Show this row on the map"/,
    'the switch lost its label AND its accessible name, so it is now an unlabelled control');

  // 2 · THE SWITCH WEARS THE COLOUR OF THE SENTENCE BESIDE IT. `data-state` is the row's own state kind;
  // the three rules are the same three colours `.watch-state` is drawn in, which is what makes them
  // "the same colours" rather than a second palette.
  assert.match(switchBody, /data-state="\$\{escapeHtml\(stateKind\)\}"/,
    'the switch does not carry the row\'s state, so it cannot be coloured by it');
  assert.match(cssRules, /\.map-switch\[data-state='air'\] input:checked \{[^}]*background: #7ee787/,
    'an in-the-air row\'s switch is not the green the status text uses');
  assert.match(cssRules, /\.map-switch\[data-state='never'\] input:checked \{[^}]*background: #f0be5a/,
    'a row that has never been seen here does not use the amber the status text uses');
  const airState = cssRules.match(/\.watch-list \.watch-state\[data-state='air'\] \{[^}]*color:\s*(#[0-9a-f]{6})/i);
  const airSwitch = cssRules.match(/\.map-switch\[data-state='air'\] input:checked \{[^}]*background:\s*(#[0-9a-f]{6})/i);
  assert.ok(airState && airSwitch && airState[1].toLowerCase() === airSwitch[1].toLowerCase(),
    'the switch and the sentence it sits beside are drawn in two different greens');

  // 3 · ONE CENTRE LINE. `baseline` lines text up with text; a switch has no text baseline, so the row
  // read as three things at three heights.
  const listRow = cssRules.slice(cssRules.indexOf('.watch-list > li {'), cssRules.indexOf('}', cssRules.indexOf('.watch-list > li {')));
  assert.match(listRow, /align-items: center/,
    'the row is still aligned on the baseline, so the status and the switch cannot share a centre line');

  // 4 · THE CROSS ASKS FIRST, ON BOTH KINDS OF ROW, IN THE PAGE'S OWN BOX — never the browser's. George,
  // 22 Sep 2026: *"add a html confirmation box if deleting a watched airplane type"*, then *"i do not
  // want http confirmations. make them html"*.
  const page = read(SITE, 'index.html');
  const watchlist = app.slice(app.indexOf('private renderWatchlist('), app.indexOf('private renderWatchButton('));
  const removeTypes = watchlist.slice(watchlist.indexOf("querySelectorAll<HTMLButtonElement>('.type-remove')"));
  const removeTails = watchlist.slice(watchlist.indexOf("querySelectorAll<HTMLButtonElement>('.watch-remove')"));
  assert.ok(removeTypes.length > 150 && removeTails.length > 100, 'a remove handler could not be isolated');
  assert.match(removeTypes, /this\.askRemove\('type', code, `\$\{info\.name\} \$\{code\}`\)/,
    'stopping watching a type does not ask, or asks without naming the type');
  assert.match(removeTails, /this\.askRemove\('tail', key, key\)/,
    'stopping watching one named aircraft does not ask, or asks without naming it');
  // And the removal is NOT reachable from the row's own handler — a cross that both asks and removes has
  // not asked. The deed lives with the answer, one method away.
  assert.equal(/typeRules = this\.typeRules\.filter/.test(removeTypes), false,
    'the row removes its own type, so the question and the deed are in one place again');
  assert.equal(/this\.removeWatch\(/.test(removeTails), false,
    'the row removes its own tail without waiting for an answer');

  // The question, its answers, and the deed they lead to.
  const ask = app.slice(app.indexOf('private askRemove('), app.indexOf('private removeTypeRule('));
  assert.ok(ask.length > 400, 'the question could not be isolated, so this check is vacuous');
  assert.match(ask, /dialog\.showModal\(\)/, 'the question does not open the page\'s own box');
  assert.match(ask, /said\.textContent =[\s\S]*?comes off the map, and the row goes from your list\./,
    'the box does not say what is about to happen');
  const wiring = app.slice(app.indexOf('private bindRemoveAsk('), app.indexOf('private removeTypeRule('));
  assert.ok(wiring.length > 300, 'the wiring could not be isolated, so this check is vacuous');
  assert.match(wiring, /byId\('removeCancel'\)[\s\S]*?dialog\.close\(\)/,
    'the safe answer does not simply close the box');
  assert.match(wiring, /if \(pending\.kind === 'type'\) this\.removeTypeRule\(pending\.key\);/,
    'the box cannot act on the type it asked about');
  assert.match(wiring, /else this\.removeWatch\(pending\.key\);/,
    'the box cannot act on the named aircraft it asked about');
  assert.match(wiring, /addEventListener\('close'[\s\S]*?this\.pendingRemove = null;/,
    'a closed box keeps asking, so Escape could be read as an answer');
  // And the question is drawn where it can always be seen: page markup, outside every card, in the same
  // shape as the wipe's box — the safe answer first.
  const removeAt = page.indexOf('<dialog id="removeDialog"');
  assert.ok(removeAt > page.indexOf('</footer>'), 'the box is inside the card stack, where the gate can hide it');
  const removeBox = page.slice(removeAt, page.indexOf('</dialog>', removeAt));
  assert.deepEqual([...removeBox.matchAll(/<button[^>]*id="([^"]+)"/g)].map((match) => match[1]),
    ['removeCancel', 'removeGo'], 'the safe answer must be offered first and the destructive one last');
  // ⚠ AND THE CROSS IS ONLY DRAWN WHEN THE BOX CAN OPEN — a row that could only be removed by a browser
  // box is exactly what this change removes.
  assert.match(app, /const canAsk = this\.canAskInPage\(\);/,
    'nothing asks whether the page can open its own box');
  assert.match(app, /const canAsk = this\.canAskInPage\(\);[\s\S]*?\(canAsk\s*\n\s*\? `<button type="button" class="linkish type-remove"/,
    'the type cross is drawn whether or not the box can open');
});

test('103 · "in the air" and "seen just now" mean INSIDE YOUR CIRCLE, not somewhere in the response', () => {
  // 🔴 GEORGE'S COMPLAINT, VERBATIM, 22 Sep 2026: *"i click last 5 minutes. this shoud filter my the
  // airport i selected. last 5 minutes from my airport, not all flights everywhere, because now it says
  // in the air but i dont see on map"*. The census that answers "seen just now" — and that exempts a
  // type from the airport filter — was built from EVERY aircraft in the feed's response, while the map
  // drew only what was inside the chosen circle. Two sentences about one moment, counted from two
  // different sets: that is what made the page promise something it could not show.
  const app = readSrc('src/app.ts');

  // One fence test now, asked of a raw reading as well as of a tracked one.
  assert.match(app, /private insideMyCircle\(lat\?: number, lon\?: number\): boolean/,
    'there is no fence test for a raw reading, so the poll cannot ask the question the map asks');
  assert.match(app, /private insideFence\(state: \{ lat\?: number; lon\?: number \}\): boolean \{\s*\n\s*return this\.insideMyCircle\(state\.lat, state\.lon\);/,
    'two fence tests exist, which is how the map and the list came to disagree');

  // And the poll applies it to the census it builds.
  // ⚠️ THE SLICE IS BOUNDED BY SOMETHING THAT COMES *AFTER* `poll`, and that is not a detail: the first
  // version of this check closed the slice on `private feedTrouble(`, which is declared ABOVE the poll —
  // so `slice(a, b)` with b < a returned an empty string, the census was never found, and the check
  // reported a failure against a correct file. A false failure is the expensive kind. `private
  // tickWatchStates(` is declared below it, so the slice contains the poll and nothing else.
  const poll = app.slice(app.indexOf('private async poll('), app.indexOf('private tickWatchStates('));
  assert.ok(poll.length > 2000, 'the poll could not be isolated, so this check is vacuous');
  const census = poll.slice(poll.indexOf('const seen = new Map<string, number>();'));
  assert.ok(census.length > 100, 'the live census could not be isolated, so this check is vacuous');
  assert.match(census, /if \(!this\.insideMyCircle\(reading\.lat, reading\.lon\)\) continue;/,
    'the live census still counts every aircraft the feed returned, so a type far outside the circle reads "seen just now"');

  // The census is what `lastSeenOf` answers `now` from and what exempts a type from the airport filter,
  // so both of the sentences George read are scoped by the one change above.
  assert.match(app, /if \(this\.liveTypes\.has\(upper\)\) return new Date\(\);/,
    'the "in the air / seen now" answer no longer reads the census this test just scoped');
  assert.match(app, /const inTheAir = this\.liveTypes\.has\(row\.code\.toUpperCase\(\)\);/,
    'the type list no longer reads the census this test just scoped');
});

test('104 · the filter count can be refreshed in place, and one press is one round of work', () => {
  // George, 22 Sep 2026: *"**Showing 17 of 184 types.** is want to be able to refrech the filters
  // results"*. The count on that line has TWO inputs — the measured type file and the live census — so
  // the press refreshes both, and the control lives on the line whose number it is about.
  const page = read(SITE, 'index.html');
  const app = readSrc('src/app.ts');
  const cssRules = stripCss(read(SITE, 'styles.css'));

  // The control is ON the count's own line — not somewhere else in the step, where the reader would have
  // to work out that it was about this number.
  const line = page.slice(page.indexOf('class="filter-note-line"'), page.indexOf('</div>', page.indexOf('class="filter-note-line"')));
  assert.ok(line.length > 100, 'the filter-note line could not be isolated, so this check is vacuous');
  assert.ok(line.includes('id="filterNote"'), 'the count is no longer in the filter-note line');
  assert.match(line, /<button[^>]*id="refreshFilters"/,
    'the line that shows the filter count has no refresh on it');
  assert.match(line, /title="Read what the feed has been showing again/, 'the refresh has no explanation');

  // And it is bound the delegated way, like the other controls that sit in markup they do not own.
  const bind = app.slice(app.indexOf('private bindRefresh('), app.indexOf('private bindVisibility('));
  assert.ok(bind.length > 150, 'the refresh binding could not be isolated, so this check is vacuous');
  assert.match(bind, /target\?\.closest\('#refreshFilters'\)/,
    'the press is not recognised, or is recognised only by the map\'s own refresh button');
  assert.match(bind, /void this\.refreshFilterResults\(\);/, 'nothing is run when the press is recognised');

  // ONE PRESS, BOTH INPUTS. The file is read again and the feed is asked again; either one alone leaves
  // half the number stale.
  // ⚠️ THE SLICE IS BOUNDED BY SOMETHING DECLARED *AFTER* `refreshFilterResults`, and that is the whole
  // lesson of this file's fourth false failure: `slice(a, b)` with `b < a` returns an EMPTY string, the
  // method is never found, and the check reports a failure against code that is correct. `bindVisibility`
  // comes after it — `bindRefresh` does not, and bounding on it is the mistake that was made here first.
  const method = app.slice(app.indexOf('private async refreshFilterResults('), app.indexOf('private bindVisibility('));
  assert.ok(method.length > 300, 'the filter refresh could not be isolated, so this check is vacuous');
  assert.match(method, /await this\.loadSurvey\(\);/, 'the measured type file is not read again, so the list cannot change');
  assert.match(method, /this\.refreshNow\(\);/, 'the feed is not asked again, so the live half of the count stays stale');

  // AND A PRESS THAT IS ANSWERED FROM THE CACHE IS NOT A REFRESH.
  assert.match(app, /fetch\('\/types\.json', \{\s*\n\s*headers: \{ accept: 'application\/json' \},\s*\n\s*cache: 'no-store',/,
    'the type file is fetched from the cache, so "refresh" can show the previous data');

  // ONE PRESS IS ONE ROUND OF WORK — three presses in a row must not spend three rounds.
  assert.match(app, /if \(this\.filterRefreshPending\) return;/,
    'a second press while the first is running starts a second round of the same work');
  assert.match(app, /private filterRefreshPending = false;/, 'nothing records that a refresh is in flight');

  // One line in the stylesheet, the sentence taking the width and the control the right edge — the same
  // arrangement as the clock above the map.
  const lineRule = cssRules.slice(cssRules.indexOf('.filter-note-line {'), cssRules.indexOf('}', cssRules.indexOf('.filter-note-line {')));
  assert.match(lineRule, /display: flex/, 'the count and its refresh are not on one line');
  const noteRule = cssRules.slice(cssRules.indexOf('.filter-note-line #filterNote {'), cssRules.indexOf('}', cssRules.indexOf('.filter-note-line #filterNote {')));
  assert.match(noteRule, /flex: 1 1 auto/, 'the sentence cannot take the width, so the control is not pushed right');
});

/* 🔴 105 · NO SENTENCE MAY PROMISE A CADENCE THE CODE CANNOT KEEP (23 September 2026).

Found while deploying, and it was THREE sentences rather than one. The page's opening paragraph said
the page "reads a public flight feed every ten seconds"; the message a reader gets when the feed asks
the site to slow down said it "had been asking every ten seconds"; and the message for any other bad
status said it "keeps asking every ten seconds". The code polls on `POLL_START_MS` and floors at
`POLL_MIN_MS` — twenty seconds and fifteen — and the page's OWN detail section, two scrolls further
down, already said twenty and fifteen. So the fault was never one wrong number: it was **one claim
said three ways, with the false version in the first paragraph a visitor reads and in the two moments
the page speaks to them about a fault**. House standard 6b: one claim, said one way — and a label
that invites a wrong conclusion is a factual fault, not a matter of style.

AND THE CHECK READS THE INTERVAL OUT OF THE CODE, so it cannot rot the way a pinned string would:
set `POLL_MIN_MS` to 5,000 and this test keeps passing, because five seconds then becomes a cadence
the page is allowed to promise. That is house standard 6c — a check reads its value out of the
artefact it checks, or asserts a relation, and never a literal that can outlive its subject.

Comments come out of BOTH files first. The source's own comments discuss the cadence this page used
to poll at, in the past tense, and a file that describes what it *used* to do must not fail a check
about what it does *now* — that is the false failure house standard 6 exists to prevent. */
test('105 · no sentence promises a cadence the code cannot keep', () => {
  const src = read(ROOT, 'src', 'app.ts');
  const constant = (name) => {
    const found = new RegExp(`${name}\\s*=\\s*([\\d_]+)`).exec(src);
    return found ? Number(found[1].replace(/_/g, '')) : NaN;
  };
  const start = constant('POLL_START_MS') / 1000;
  const floor = constant('POLL_MIN_MS') / 1000;
  assert.ok(Number.isFinite(start) && Number.isFinite(floor) && floor > 0,
    'the poll constants could not be read out of src/app.ts, so this check cannot judge anything');

  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, sixty: 60 };
  const claims = (text) => [...text.matchAll(/every\s+([a-z]+|\d+)\s+seconds?/gi)]
    .map((m) => WORDS[m[1].toLowerCase()] ?? Number(m[1]))
    .filter((n) => Number.isFinite(n));

  const page = claims(stripHtml(read(SITE, 'index.html')));
  const source = claims(stripJs(src));

  assert.ok(page.length >= 2, `the page states its cadence in more than one place (found ${page.length})`);
  for (const [where, list] of [['the page', page], ['the source it renders', source]]) {
    const tooFast = list.filter((n) => n < floor);
    assert.deepEqual(tooFast, [],
      `${where} promises ${tooFast.join('s, ')}s and the code never polls faster than ${floor}s`);
    assert.ok(list.includes(start), `${where} never states the cadence it actually starts on (${start}s)`);
  }
});
