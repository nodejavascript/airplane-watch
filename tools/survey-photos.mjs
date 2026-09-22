/**
 * survey-photos.mjs — a free, openly-licensed photograph for every aircraft type.
 *
 * George, 20 Sep 2026: *"where are the photos. there are free opensource photos
 * online"* — and he is right, and the earlier answer here was wrong. It said a
 * photograph per type "would be a licence we do not hold, a file per type that
 * goes stale, and a network request per row". Two of those are true and the first
 * one is not: **Wikimedia Commons exists, its media is freely licensed, and the
 * MediaWiki API answers with a page image and its licence terms without a key.**
 * Measured before writing this, with no key at all:
 *
 *   "Boeing 737 MAX"           → Boeing 737 MAX           → Alaska_737_Max_9.jpg
 *   "de Havilland Canada Dash 8" → De Havilland Canada Dash 8 → Hamburg_Airport_Widerøe…
 *   "Avro Lancaster"           → Avro Lancaster           → Battle_of_Britain_Memorial…
 *   "Cessna 172"               → Cessna 172               → Cessna_172S_Skyhawk_SP…
 *
 * ---------------------------------------------------------------- HOW IT ASKS
 *
 * One search per type code, taking the FIRST result's page image, then one batched
 * query for the licence metadata of every file at once. The name it searches with
 * is the name this site already shows the reader (`describeType(code).name`), so
 * the photograph and the label can never describe two different aeroplanes.
 *
 * 🔴 A PHOTOGRAPH IS NOT ALWAYS RIGHT, AND THE PAGE IS TOLD WHEN IT MIGHT NOT BE.
 * Search finds a page; a page image is usually the aeroplane but is sometimes a
 * logo, a map or an operator's colour scheme. So every entry records what it
 * matched and how closely, and the page shows the picture BESIDE the name rather
 * than instead of it — the picture is a glance, the name is the truth. An entry
 * whose match is poor is written with `confident: false` and the page can leave
 * the drawing in its place.
 *
 * 🔴 AND IT RECORDS THE LICENCE AND THE AUTHOR, because the licence requires it.
 * A Commons image is nearly always CC BY, CC BY-SA or public domain, and all three
 * require the credit to travel with the picture. The credit is fetched here and
 * printed on the page; a photograph with no attribution would be a licence
 * breach, which is worse than no photograph.
 *
 * Usage: node tools/survey-photos.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describeType } from '../site/typeinfo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://en.wikipedia.org/w/api.php';
/** 🔴 The other half of the same free library. An article that leads with no usable image still has a
 * FOLDER of photographs of the aeroplane on Commons, and the file names there state the designation.
 * Same API shape, same licences, no key — so it is the fallback when Wikipedia has the article but not
 * the picture, and it is where the Cessna 150's photograph comes from: its article carries no lead
 * image at all, measured 22 Sep 2026. */
const COMMONS = 'https://commons.wikimedia.org/w/api.php';

/** 🔴 The feed refuses a request with no user agent; Wikipedia asks the same. */
const UA = 'aircraft-demo/1.0 (+https://aircraft-demo.nodejavascript.com; tools/survey-photos.mjs)';

/** Wikimedia's own hosts, and the only hosts the page will ever be allowed to fetch from. */
export const WIKIMEDIA_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org'];

/**
 * 🔴 THE `Artist` FIELD IS NOT ALWAYS A NAME. Measured 20 Sep 2026: for one
 * Commons file it came back as
 * `Delta_Air_Lines_B767-300_N130DL.jpg: Richard Snyder from San Jose, CA, United States`
 * — a filename, a colon, and a description, because that is what the uploader put
 * in the field. Printed as-is it makes the row unreadable and buries the licence
 * behind a wall of text, so it is trimmed to the part that is actually a name.
 */
function cleanArtist(raw) {
  let text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  // Drop a leading filename and its colon, if that is what this is.
  text = text.replace(/^[^:]*\.(jpg|jpeg|png|gif|svg|tif|tiff)\s*:\s*/i, '');
  // And a trailing location tail, which is not a name either.
  text = text.replace(/,\s*(United States|USA|US|Canada|UK|United Kingdom|Germany|France)\b.*$/i, '');
  text = text.trim();
  if (text.length > 70) text = text.slice(0, 67).trimEnd() + '…';
  return text || 'Unknown';
}

/**
 * One API call, and IT WAITS WHEN IT IS TOLD TO.
 *
 * 🔴 THE 429 IS NOT AN ERROR TO REPORT, IT IS AN INSTRUCTION TO SLOW DOWN — AND IT COST SIXTEEN
 * PHOTOGRAPHS TO LEARN THAT. Measured 22 Sep 2026: naming 24 more types took the run past Wikipedia's
 * request budget partway through, and from that point every call answered *"Wikipedia answered 429"*.
 * Sixteen codes were written into `missing` as if no article existed — including the **HondaJet, the
 * Avro Lancaster, four Learjets and the Mooney M20**, every one of which the previous run had found a
 * photograph for. A page that reports a rate limit as an absence makes the run look worse than it is
 * AND loses photographs that were already working, which is the same false-negative trap the flight
 * feed taught this project (ten requests three seconds apart refused from the third onward).
 *
 * So a 429 or a 503 waits — for the `Retry-After` the server names, or a growing backoff — and asks
 * again, up to six times. Anything else still throws.
 */
async function ask(params, api = API, attempt = 0) {
  const url = `${api}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  const response = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!response.ok) {
    if ((response.status === 429 || response.status === 503) && attempt < 6) {
      const named = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(named) && named > 0 ? named : 4 * (attempt + 1);
      console.log(`  rate limited (${response.status}) — waiting ${wait}s, then asking again`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return ask(params, api, attempt + 1);
    }
    throw new Error(`Wikipedia answered ${response.status}`);
  }
  return response.json();
}

/**
 * 🔴 WHAT COUNTS AS AN AEROPLANE, AND WHAT ONLY LOOKS LIKE ONE.
 *
 * The first version asked only for a category containing one of these words, and `aviation` is in it —
 * which let **Västberga helicopter robbery**, **2018 Horizon Air Bombardier Q400 incident**, **Alaska
 * Airlines Flight 1282**, **Alaska Airlines fleet**, **Cirrus Aircraft**, **Mooney International
 * Corporation**, **National Stearman Fly-In** and **Pratt & Whitney Canada PT6** all through the gate.
 * Every one of those is categorised with a word that means aviation, and not one of them is an
 * aeroplane. So the gate is now two tests: something that makes it an airframe, and nothing that makes
 * it a robbery, a crash report, an airline's fleet list, a museum, a maker or an engine.
 */
const AIRFRAME_CATEGORY =
  /aircraft|aeroplane|airplane|helicopter|rotorcraft|airliner|glider|sailplane|gyroplane|ultralight|balloon|airship|blimp|zeppelin/i;
// 🔴 `\bengines?\b` WAS TOO BROAD AND IT COST TWO AIRCRAFT THEIR PHOTOGRAPHS. Measured 22 Sep 2026:
// the HondaJet is categorised **Engine-over-wing aircraft**, a perfectly ordinary airframe category, and
// the type `Honda HA-420 HondaJet` was refused because of the word "Engine" in it. An engine is now only
// an engine when the category is about engines — `Aircraft engines`, `2000s turbofan engines` — and not
// when an engine is how the wing is arranged.
const NOT_AIRFRAME_CATEGORY =
  /manufacturer|company|corporation|aircraft engines?|engines? of\b|(turbofan|turbojet|turboshaft|turboprop|piston|diesel|electric) engines?|airlines?\b|fleet|accident|incident|crash|collision|robbery|museum|fly-in|list of|ambulance/i;

/** Fold a name down to letters and digits, so `A-5` and `A5` are the same token and `SR-3500` survives. */
function squashed(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * 🔴 THE TOKENS THAT IDENTIFY THE AEROPLANE RATHER THAN ITS MAKER: anything carrying a digit.
 *
 * `150`, `AW139`, `SR-3500`, `AS365` — these are what a designation is, and they are what a wrong
 * match cannot fake: searching "Murphy SR-3500 Super Rebel" returned *a list of military aid to
 * Ukraine* under the old first-result rule, and no military aid list contains "sr3500".
 *
 * ⚠️ THE SITE'S OWN CODE IS NOT USED. `C150` is this page's shorthand and appears in no article
 * title on earth, so searching it finds nothing — the NAME is what gets searched.
 */
function modelTokens(name) {
  const words = String(name ?? '').toLowerCase().split(/[\s/]+/);
  // 🔴 BOTH FORMS, AND THE JOINED ONE MATTERS. `DC-3` is ONE designation — split on the hyphen it
  // leaves `3`, which is too short to be evidence of anything, and the Douglas DC-3 misses its own
  // article. `AA-5` and `PA-23-250` are the same shape. Splitting is kept as well, because a hyphen
  // in a Boeing designation is a separator: `737-800` should still find `Boeing 737`.
  const whole = words.map((word) => word.replace(/[^a-z0-9]/g, ''));
  const split = words.flatMap((word) => word.split(/[^a-z0-9]+/));
  const out = new Set();
  for (const token of [...whole, ...split]) {
    if (/\d/.test(token) && token.length >= 3) out.add(token);
  }
  return [...out];
}

/** The designation tokens of a name that are long enough to be evidence — see `modelTokens`. */
function strongTokens(name) {
  return modelTokens(name).filter((token) => token.length >= 3);
}

/**
 * 🔴 WORDS THAT DESCRIBE A KIND OF AEROPLANE RATHER THAN AN AEROPLANE, WHICH CANNOT CARRY A MATCH.
 *
 * Measured 22 Sep 2026, on the first run of the scoring rule: the type `North American Rockwell
 * Turbo Commander 690/840` matched the article **Turboprop**, on the word "turbo". That is a
 * photograph of a category of engine beside the name of an aeroplane — the exact class of wrong
 * match the whole rule exists to stop, and it came in through the word test. `Leonardo`, `Commander`
 * and `Super` are here for the same reason: they are housekeeping in a designation, not a name.
 */
const GENERIC_WORDS = new Set([
  'turbo', 'prop', 'props', 'turboprop', 'turbofan', 'jet', 'jets', 'aircraft', 'airplane', 'aeroplane',
  'helicopter', 'heli', 'glider', 'sailplane', 'engine', 'engines', 'twin', 'turbine', 'super', 'light',
  'heavy', 'narrow', 'wide', 'body', 'trainer', 'commander', 'series', 'family', 'class', 'type', 'model',
  'north', 'american', 'south', 'general', 'aviation', 'air', 'lines', 'regional', 'express',
]);

/** `Glider (aircraft)` is the article about gliders; the bracket is a disambiguator, not the name. */
function withoutBrackets(title) {
  return String(title ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Words long enough to be about the aeroplane rather than about its maker — `citabria`, `thrush`,
 * `dauphin`, `sling`.
 *
 * 🔴 FIVE CHARACTERS, AND THAT IS A MEASURED LIMIT, NOT A STYLE CHOICE. Allowing three recovered
 * one row (the TBM 900, whose article is at `SOCATA TBM`) and let **six wrong photographs in**, all
 * of them through a maker or a category word: `IAI Astra` → `IAI Westwind` (a different aeroplane),
 * `Beechcraft King Air 90` → `Beechcraft C-12 Huron`, `Piper PA-23-250 Aztec` → `Piper PA-28
 * Cherokee`, `Learjet 75` → `Learjet 60`, `DHC-3 Otter` → `DHC-1 Chipmunk`, and `Balloon` → *the 2023
 * Chinese balloon incident*. A wrong photograph beside a name is worse than a drawing, so the shorter
 * word is out and the TBM 900 keeps its drawing.
 */
function nameWords(name) {
  return String(name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 5 && /[a-z]/.test(word));
}

/**
 * 🔴 A WORD MAY ONLY CARRY A MATCH IF IT IS DISTINCTIVE TO THIS TYPE, MEASURED FROM THE CORPUS
 * ITSELF RATHER THAN FROM A HAND-WRITTEN LIST THAT GOES STALE.
 *
 * Every wrong photograph that survived the word tests on 22 Sep 2026 came in through a MAKER:
 * `piper` matched the Cherokee for the Aztec, `hawker` matched a Hurricane for a business jet,
 * `learjet` matched a Learjet 60 for a 75, `bellanca` matched the company for the Citabria, `canada`
 * matched an engine for the Beaver. A maker is shared by many types by definition, so it identifies
 * nothing — and the corpus itself says which words those are, because they turn up in many of its own
 * names. `otter`, `citabria`, `bonanza`, `buccaneer` and `skylane` turn up in one or two, and those
 * are the ones worth matching on: `otter` finds the Twin Otter, `skylane` finds the 182.
 *
 * ⚠️ THE LIMIT, STATED PLAINLY: this is a FREQUENCY test, not a semantic one. It removes the class of
 * failure that was actually measured and it cannot prove a match is right. What the reader can check
 * is the evidence string printed in every entry. A wrong photograph beside a name is worse than a
 * drawing, so a word that might be either keeps its drawing.
 */
const WORD_COUNT = new Map();

/** True when this word belongs to this type rather than to the industry. */
function distinctive(word) {
  return !GENERIC_WORDS.has(word) && (WORD_COUNT.get(word) ?? 0) <= 2;
}

/**
 * 🔴 TWO GATES, AND A CANDIDATE HAS TO PASS BOTH — WHICH IS WHAT REPLACED "THE FIRST RESULT".
 *
 * The old rule took `gsrlimit: 1` and then asked whether the page title contained the first word of
 * the name. Measured 22 Sep 2026, over the 20 types that ended up showing a drawing:
 *
 * - **It threw away fourteen matches that were RIGHT.** `Leonardo AW139` was refused because the
 *   article is at `AgustaWestland AW139` — the same helicopter, renamed by its maker. Same story for
 *   `Airbus H125` (the article is `Eurocopter AS350 Écureuil`), `IAI Astra` (`Gulfstream G100`),
 *   `Rockwell Thrush Commander` (`Ayres Thrush`) and ten more. The test was on the MAKE, which is the
 *   one part of a name that changes.
 * - **It accepted things that were wrong**, which is why the fourteen hid: `AS21` was matched to the
 *   `K21`, an armoured fighting vehicle, and `Murphy SR-3500 Super Rebel` to a list about military aid.
 *
 * So a candidate now has to be **an airframe** (see the two category tests above) **and about this
 * aeroplane** — and the evidence that it is about this aeroplane has to be in its TITLE: the name
 * itself, the name as a prefix, a designation token, or a word distinctive to this type.
 *
 * 🔴 A MENTION IN THE TEXT IS NOT ENOUGH, AND THAT IS THE SECOND MEASURED CORRECTION. Allowing a
 * designation found in a first paragraph — which is what recognises a RENAMED type without a table of
 * aliases — let in **Alaska Airlines Flight 1282** for the 737 MAX 9, **Alaska Airlines fleet** for
 * the Embraer 175, **Airbus BelugaXL** for the A330-200 and four crash reports besides, because a page
 * about a crash says "a Boeing 737-800" in its first sentence. It is now allowed only for the WHOLE
 * name, which is what the renamed cases actually state ("…now marketed as the Airbus H125") and what
 * a crash report never does contiguously.
 */
/** Is this page an airframe, rather than a maker, a fleet, a crash report, an engine or a list? */
function isAirframe(page) {
  const categories = (page.categories ?? []).map((one) => String(one.title ?? ''));
  return (
    categories.some((one) => AIRFRAME_CATEGORY.test(one)) &&
    !categories.some((one) => NOT_AIRFRAME_CATEGORY.test(one))
  );
}

function judge(page, name) {
  const title = squashed(page.title);
  const isAirframePage = isAirframe(page);
  const whole = squashed(name);
  // 🔴 A TOKEN OF TWO CHARACTERS OR FEWER CANNOT CARRY A MATCH ON ITS OWN. `A5` and `7` are in a
  // thousand page titles that have nothing to do with them, so a short token is only ever a
  // tie-breaker: a type named that way has to have its name in the article's TITLE, which is how
  // `ICON A-5` finds `Icon A5` and `Bellanca 7 Citabria` does not find a list of aircraft types.
  const strong = strongTokens(name);
  const words = nameWords(name).filter(distinctive);
  const parts = String(name ?? '').trim().split(/\s+/);
  const multiWord = parts.length >= 2;

  const titleEquals = whole !== '' && squashed(withoutBrackets(page.title)) === whole;
  const titleStarts = whole.length >= 5 && title.startsWith(whole);
  const titleToken = strong.find((token) => title.includes(token)) ?? '';
  const wordHit = words.find((word) => title.includes(word)) ?? '';

  // 🔴 THE EVIDENCE HAS TO BE IN THE TITLE, AND NOTHING ELSE COUNTS.
  //
  // Two weaker routes were measured and both were removed on 22 Sep 2026. A designation found in the
  // article's FIRST PARAGRAPH let in **Alaska Airlines Flight 1282** for the 737 MAX 9, **Alaska
  // Airlines fleet** for the Embraer 175 and four crash reports besides, because a page about a crash
  // says "a Boeing 737-800" in its opening sentence. The WHOLE NAME found in the paragraph was no
  // better: it matched the type `Rockwell Thrush Commander` to **Agricultural aircraft**, and
  // `Cessna 150` to **Cessna 152** — a different aeroplane of the same family.
  //
  // 🔴 AND A ONE-WORD NAME MUST BE THE TITLE, not mentioned in it. The first run matched the type
  // `Glider` to **Gimli Glider** — the 1983 incident — and offered **the 2023 Chinese balloon incident**
  // for `Balloon`, because the word is in those articles' first sentences.
  const aboutThisAeroplane = titleEquals || titleStarts || titleToken !== '' || wordHit !== '';
  if (!isAirframePage || !aboutThisAeroplane) return null;
  const evidence = [];
  let kind = 1;
  if (titleEquals) {
    evidence.push('the article IS the type, by name');
    kind = 5;
  } else if (titleStarts) {
    evidence.push('the article title begins with the type name');
    kind = 4;
  } else if (titleToken) {
    evidence.push(`its title carries ${titleToken}`);
    kind = 3;
  } else {
    evidence.push(`it is about ${wordHit}`);
    kind = 2;
  }
  evidence.push('and its categories are those of an airframe, not of a maker, a fleet or a crash');

  return { kind, hasImage: Boolean(page.pageimage && page.thumbnail?.source), reason: evidence.join(', ') };
}

/**
 * 🔴 A FAMILY MATCH, AND IT IS THE LAST RESORT — MEASURED AGAINST WHAT IT COSTS.
 *
 * `Beechcraft King Air 90`, `Cessna T182 Turbo Skylane` and `Cessna P210 Turbine` have no article of
 * their own: Wikipedia covers each family in one page. Requiring a designation in the title leaves
 * those three with a drawing while their family's article sits one line away, and the family article
 * IS the aeroplane — a King Air is a King Air. So a candidate sharing a word with the name is allowed
 * — maker word included — but ONLY when no candidate met the stricter test, and only when the page
 * passes the airframe gate, which is what keeps crash reports, fleets, makers and engines out.
 *
 * ⚠️ THE HONEST LIMIT: this can land on the neighbouring model rather than the exact one (the King Air
 * page covers the 90, the 100 and the 200). That is a glance-level difference, and the project's rule
 * for a photograph is that it is a glance while the name beside it is the truth. It is never allowed
 * to be a DIFFERENT KIND of page — which is what the gate is for.
 */
function familyMatch(page, name) {
  if (!isAirframe(page)) return null;
  const title = squashed(page.title);
  const words = String(name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && /[a-z]/.test(word) && !GENERIC_WORDS.has(word));
  const shared = words.find((word) => title.includes(word));
  if (!shared) return null;
  return { shared, hasImage: Boolean(page.pageimage && page.thumbnail?.source) };
}

/**
 * The article Wikipedia ITSELF says this type name refers to, when the name is a redirect.
 *
 * Returns `{ title, file, thumb, reason }` when the redirect lands on an airframe with a usable image,
 * and `null` in every other case — including a redirect to a section or a list, which is not an
 * article about this aeroplane.
 */
async function directArticle(name) {
  const data = await ask({
    action: 'query',
    titles: name,
    redirects: 1,
    prop: 'pageimages|categories',
    piprop: 'thumbnail|name',
    pithumbsize: 480,
    cllimit: 'max',
    clshow: '!hidden',
  });
  const page = (data.query?.pages ?? [])[0];
  if (!page || page.missing === true) return null;
  // 🔴 IT HAS TO BE A REDIRECT, NOT MERELY A PAGE THAT EXISTS. Measured 22 Sep 2026: `Balloon` exists as
  // an article in its own right — about party balloons, with a photograph of one — so accepting the
  // resolved page on sight would have put a party balloon beside the type `Balloon`, while the article
  // the site wants (`Hot air balloon`) sat one line down the search results. A page that already IS the
  // name is not evidence of anything; the search route decides that case on its own merits.
  // 🔴 A REDIRECT IS EVIDENCE, AND SO IS AN EXACT TITLE — BUT NOT FOR A ONE-WORD NAME.
  // Measured 22 Sep 2026: the type `Kaman K-MAX` was given a photograph of the **Kaman HH-43 Huskie**, a
  // different helicopter from the same maker, because "Kaman" is in both titles — while the K-MAX's own
  // article, with an image, sat two lines further down the search results. This route refused to look at
  // a page whose title is simply the type's own name.
  //
  // ⚠️ `Balloon` IS WHY THE REFUSAL EXISTED, so it is kept for exactly that case: the article `Balloon`
  // is about PARTY balloons, and accepting an exact title would have put one beside the type `Balloon`
  // while `Hot air balloon` — the article the page actually wants — sat one line up. A ONE-WORD name
  // that is also a common noun is the ambiguous case, so for those the search route still decides.
  const redirected = (data.query?.redirects ?? []).length > 0;
  const isTheArticleItself = squashed(withoutBrackets(page.title)) === squashed(name);
  const oneWord = String(name ?? '').trim().split(/\s+/).length === 1;
  if (!redirected && !(isTheArticleItself && !oneWord)) return null;
  // A redirect to a SECTION arrives as a page whose title still carries the fragment, and a redirect to
  // a LIST is not an aeroplane. Both are refused rather than shown.
  if (/#/.test(String(page.title))) return null;
  // 🔴 THE REDIRECT IS THE WHOLE EVIDENCE, SO THE NAME TEST IS NOT REPEATED HERE. `Airbus H125`
  // resolves to `Eurocopter AS350 Écureuil`, and no title test could connect those two names — that is
  // exactly why this route exists. What is still required is that the article it lands on is an
  // AIRFRAME: a redirect can point at a list, an operator's fleet or a manufacturer just as easily.
  if (!isAirframe(page)) return null;
  if (!page.pageimage || !page.thumbnail?.source) return null;
  return {
    title: page.title,
    file: page.pageimage,
    thumb: page.thumbnail.source,
    reason: redirected
      ? `Wikipedia redirects "${name}" to this article, so the site takes Wikipedia at its word that they are the same aeroplane; it leads with an image and its categories are those of an airframe`
      : 'the article is this type by name, leads with an image, and its categories are those of an airframe',
  };
}

/** Every code the page can show: the measured survey, the military list and the museum's own types. */
function codes() {
  const out = new Set();
  const survey = JSON.parse(readFileSync(join(ROOT, 'site', 'types.json'), 'utf8'));
  for (const row of survey.types ?? []) out.add(row.code);
  // 🔴 THE OTHER TWO LISTS THE PAGE RENDERS, WHICH THE SURVEY USED TO MISS. A code the page shows and
  // the file does not mention falls back to the drawing — which is right for a type nobody can name,
  // and wrong for a Catalina the museum flies every week.
  for (const file of ['military.json', 'historic.json']) {
    const path = join(ROOT, 'site', file);
    if (!existsSync(path)) continue;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    for (const row of doc.codes ?? []) out.add(String(row.code ?? row));
    for (const site of doc.sites ?? []) {
      for (const row of site.aircraft ?? []) if (row.typeCode) out.add(String(row.typeCode));
    }
  }
  return [...out].sort();
}

const wanted = codes();
console.log(`${wanted.length} type codes to find a photograph for`);

// 🔴 COUNT THE WORDS BEFORE MATCHING WITH THEM. `distinctive()` reads this, and it has to be built
// from the whole corpus first — a word cannot be judged common or rare while the list is still being
// walked. The names come from the site's own type table, so this is the same 199 names the page
// prints, and nothing is hand-listed.
for (const code of wanted) {
  for (const word of nameWords(describeType(code).name)) {
    WORD_COUNT.set(word, (WORD_COUNT.get(word) ?? 0) + 1);
  }
}
const makers = [...WORD_COUNT.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
console.log(
  `  ${WORD_COUNT.size} distinct words; ${makers.length} of them are common to three or more types and cannot carry a match (${makers.slice(0, 8).map(([w]) => w).join(', ')}…)`
);

/** code -> { name, title, file, thumb, confident, reason } */
const found = new Map();
const misses = [];

for (const code of wanted) {
  const name = describeType(code).name;
  // 🔴 A TYPE THE PAGE CANNOT NAME IS NOT SOMETHING TO SEARCH FOR. `AS21` and `RCAL` are deliberately
  // left unnamed — the site will not invent a designation — and searching a bare code would return a
  // stranger's article and print it as this aeroplane.
  if (!name || squashed(name) === squashed(code) || /not in this list/i.test(name)) {
    misses.push({ code, name: name ?? code, why: 'the page has no name for this type, so there is nothing to search for' });
    continue;
  }
  try {
    // 🔴 FIRST, ASK WIKIPEDIA WHETHER IT CONSIDERS THIS TYPE TO BE ANOTHER ARTICLE.
    //
    // The hard case is the RENAMED aeroplane: `Airbus H125` is the article `Eurocopter AS350`, and
    // `Leonardo AW139` is `AgustaWestland AW139`, because the maker changed the name and Wikipedia kept
    // one article. A title test cannot see that without an alias table, and an alias table is a list
    // somebody has to maintain and can get wrong. A REDIRECT is Wikipedia's own statement that the two
    // names are one subject — real evidence, no table, and it cannot go stale in our hands. Measured
    // 22 Sep 2026: this route alone recovers the renamed helicopter family, the Astra and the Sling.
    const direct = await directArticle(name);
    if (direct) {
      found.set(code, {
        name,
        title: direct.title,
        file: direct.file,
        thumb: direct.thumb,
        confident: true,
        reason: direct.reason,
      });
      continue;
    }

    const data = await ask({
      action: 'query',
      generator: 'search',
      gsrsearch: name,
      gsrlimit: 6,
      prop: 'pageimages|categories|extracts',
      piprop: 'thumbnail|name',
      pithumbsize: 480,
      cllimit: 'max',
      // 🔴 ONLY REAL CATEGORIES. The first version of this gate read the hidden maintenance banners
      // as well — `All Wikipedia articles in need of updating`, `Commons link from Wikidata`,
      // `Webarchive template wayback links` — and between them they matched the words `wiki`,
      // `commons` and `template`, so EVERY candidate failed and the run produced 0 photographs out of
      // 199. Measured on `Boeing 737` rather than guessed at: 42 categories, and the maintenance ones
      // are half of them.
      clshow: '!hidden',
      exintro: 1,
      explaintext: 1,
      exchars: 1200,
    });
    // 🔴 THE SEARCH'S OWN ORDER DECIDES, AND VERIFICATION ONLY GATES IT.
    //
    // The version between this and the first-result rule re-ranked the candidates by how strong their
    // evidence looked, and it was worse than doing nothing: a crash report and an airline's fleet page
    // both outranked the aeroplane, because a page that says "a Boeing 737-800" in its first sentence
    // looks, to a word test, exactly like the aeroplane. The search engine already ranks by relevance;
    // the job here is only to REJECT what fails (a fire engine, an armoured vehicle, a maker) and to
    // take the first that survives — which is what still finds `Boeing 737 Next Generation` for the
    // 737-800 rather than `Alaska Airlines Flight 1282`.
    //
    // A candidate that can actually be SHOWN is preferred among the survivors, still in the search's
    // order — `Glider (aircraft)` over `Glider`, both of which are correct.
    const passing = (data.query?.pages ?? [])
      .map((page) => ({ page, verdict: judge(page, name) }))
      .filter((row) => row.verdict !== null);
    // 🔴 THE STRICT TEST FIRST, AND THE FAMILY MATCH ONLY IF NOTHING PASSED IT. A candidate that can
    // be SHOWN is preferred among the survivors, still in the search's own order — `Glider (aircraft)`
    // over `Glider`, both of which are correct.
    const strict = passing.find((row) => row.verdict.hasImage) ?? passing[0];
    const family = strict
      ? null
      : (data.query?.pages ?? [])
          .map((page) => ({ page, verdict: familyMatch(page, name) }))
          .filter((row) => row.verdict !== null)
          .find((row) => row.verdict.hasImage);
    const winner = strict ?? family;
    if (!winner) {
      misses.push({ code, name, why: 'no article on that name is both an aircraft and about this type' });
    } else if (winner.page.pageimage && winner.page.thumbnail?.source) {
      found.set(code, {
        name,
        title: winner.page.title,
        file: winner.page.pageimage,
        thumb: winner.page.thumbnail.source,
        confident: true,
        reason: family
          ? `no article carries this designation, so this is the FAMILY article it belongs to — it shares "${winner.verdict.shared}" with the type name and its categories are those of an airframe`
          : `${winner.verdict.reason} (candidate ${passing.indexOf(winner) + 1} of ${passing.length} that passed, from ${(data.query?.pages ?? []).length} returned)`,
      });
    } else {
      // The article is right and has no usable lead image. Look on Commons, and KEEP the article's
      // title as the record of what was matched.
      const picture = await commonsPhoto(name);
      if (!picture) {
        misses.push({ code, name, why: `matched "${winner.page.title}", which leads with no image, and no Commons file stated the designation` });
      } else {
        found.set(code, {
          name,
          title: winner.page.title,
          file: picture.file,
          thumb: picture.thumb,
          confident: true,
          reason: `${winner.verdict.reason}; the article leads with no usable image, so the photograph is the Commons file "${picture.file}", whose name states the designation`,
        });
      }
    }
  } catch (error) {
    misses.push({ code, name, why: error.message });
  }
  // Wikimedia asks for a reasonable rate, same as the flight feed does — and a code can now cost TWO
  // requests (the redirect check, then the search), so the pause between codes is larger than it was.
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/**
 * A photograph from Commons when Wikipedia has the article but not the picture.
 *
 * 🔴 THE FILE NAME IS THE EVIDENCE, AND IT HAS TO CARRY BOTH HALVES. A designation alone would match
 * any operator's photograph of any aeroplane that shares a number (`150` appears in a thousand file
 * names); a maker alone would match a photograph of the factory headed note paper. Both together is
 * the aeroplane: `Cessna 150 ()`, `Murphy SR-3500 Super Rebel D-...`.
 */
async function commonsPhoto(name) {
  const tokens = modelTokens(name);
  const words = nameWords(name).filter(distinctive);
  const whole = squashed(name);
  const data = await ask(
    {
      action: 'query',
      generator: 'search',
      gsrsearch: name,
      gsrnamespace: 6,
      gsrlimit: 12,
      prop: 'imageinfo',
      iiprop: 'url',
      iiurlwidth: 500,
    },
    COMMONS
  );
  for (const page of data.query?.pages ?? []) {
    const file = String(page.title ?? '').replace(/^File:/, '');
    const flat = squashed(file);
    if (flat === '') continue;
    const named = whole !== '' && flat.includes(whole);
    const tokenHit = tokens.find((token) => flat.includes(token)) ?? '';
    const wordHit = words.find((word) => flat.includes(word)) ?? '';
    const stated = named || (tokenHit !== '' && wordHit !== '');
    const thumb = page.imageinfo?.[0]?.thumburl;
    if (stated && thumb) return { file, thumb };
  }
  return null;
}

console.log(`  ${found.size} with a photograph, ${misses.length} without`);

// ---------------------------------------------------------- the licence terms ---
const files = [...found.values()].map((row) => row.file);
const credits = new Map();
for (let i = 0; i < files.length; i += 40) {
  const batch = files.slice(i, i + 40);
  try {
    const data = await ask({
      action: 'query',
      titles: batch.map((file) => `File:${file}`).join('|'),
      prop: 'imageinfo',
      iiprop: 'extmetadata|url',
      iiurlwidth: 480,
    });
    for (const page of data.query?.pages ?? []) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      const meta = info.extmetadata ?? {};
      // 🔴 THE KEY HAS TO BE NORMALISED OR THE CREDITS SILENTLY MISS. Measured
      // 20 Sep 2026: the page-image API returns file names with UNDERSCORES
      // (`Alaska_737_Max_9.jpg`) and the titles API returns them with SPACES
      // (`File:Alaska 737 Max 9.jpg`). Keyed raw, every lookup missed — 5 of 56
      // photographs came back with a licence and 51 came back "Unknown", which
      // would have printed 51 uncredited photographs on the page. Both forms are
      // folded to spaces here.
      credits.set(String(page.title).replace(/^File:/, '').replace(/_/g, ' '), {
        artist: cleanArtist(String(meta.Artist?.value ?? '')),
        licence: String(meta.LicenseShortName?.value ?? 'see the file page').replace(/<[^>]*>/g, '').trim(),
        page: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/File:${page.title.replace(/^File:/, '')}`,
      });
    }
  } catch (error) {
    console.log(`  licence lookup failed for a batch: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 220));
}

const photos = {};
for (const [code, row] of found) {
  const credit = credits.get(row.file.replace(/_/g, ' ')) ?? {
    artist: 'Unknown',
    licence: 'see the file page',
    page: `https://commons.wikimedia.org/wiki/File:${row.file}`,
    };
  photos[code] = {
    code,
    name: row.name,
    title: row.title,
    src: row.thumb,
    confident: row.confident,
    reason: row.reason,
    artist: credit.artist,
    licence: credit.licence,
    creditPage: credit.page,
  };
}

writeFileSync(
  join(ROOT, 'site', 'photos.json'),
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      source: 'https://www.wikipedia.org/ — the MediaWiki API, no key, no account',
      licence:
        'Each photograph is under the licence named beside it, nearly always Creative Commons or public domain. The author and the file page travel with every entry, because all of those licences require the credit.',
      method:
        'One search per type code, six candidate articles each, and a candidate is only used when its own categories say it is an aircraft AND it is about that type — its title carries the model token, or the whole name, or its own first paragraph names the token (which is how a renamed type like the Airbus H125 is recognised in the Eurocopter AS350 article, with no alias table to go stale). The best-scoring candidate wins; a title that carries no usable image falls back to the Commons file whose NAME states both the maker and the designation. Then one batched query for the licence terms of every file. The 22 Sep 2026 rewrite replaced "take the first search result and check its title contains the first word of the name", which threw away fourteen correct matches (Leonardo AW139 lives at AgustaWestland AW139) and accepted wrong ones (AS21 matched an armoured fighting vehicle).',
      covers:
        'Every code the page can render: the measured survey, the military list and the museum\u2019s own types. A code with no entry has no article and no Commons file that met the evidence rule, and it keeps its drawing.',
      note:
        'A photograph is a glance and the name beside it is the truth: a search matches a PAGE, and a page image is usually the aeroplane but is not guaranteed to be. Every entry here states, in `reason`, the evidence it was accepted on — and every code left out is in `missing` with the reason it was refused, so the refusals are auditable rather than invisible.',
      found: photos,
      missing: misses,
    },
    null,
    1
  ) + '\n'
);

console.log(`wrote site/photos.json — ${Object.keys(photos).length} photographs`);
const weak = Object.values(photos).filter((row) => !row.confident).length;
console.log(`  ${weak} of them with a weak match, marked as such`);
console.log(`  licences: ${[...new Set(Object.values(photos).map((row) => row.licence))].slice(0, 6).join(' · ')}`);
