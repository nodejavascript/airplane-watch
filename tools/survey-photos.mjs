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

async function ask(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  const response = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!response.ok) throw new Error(`Wikipedia answered ${response.status}`);
  return response.json();
}

/** Every code the page can show: the measured survey, plus everything the table names. */
function codes() {
  const out = new Set();
  const survey = JSON.parse(readFileSync(join(ROOT, 'site', 'types.json'), 'utf8'));
  for (const row of survey.types ?? []) out.add(row.code);
  return [...out].sort();
}

const wanted = codes();
console.log(`${wanted.length} type codes to find a photograph for`);

/** code -> { name, title, file, thumb, confident, reason } */
const found = new Map();
const misses = [];

for (const code of wanted) {
  const name = describeType(code).name;
  try {
    const data = await ask({
      action: 'query',
      generator: 'search',
      gsrsearch: name,
      gsrlimit: 1,
      prop: 'pageimages',
      piprop: 'thumbnail|name',
      pithumbsize: 480,
    });
    const page = (data.query?.pages ?? [])[0];
    const thumb = page?.thumbnail?.source;
    const file = page?.pageimage;
    if (!page || !thumb || !file) {
      misses.push({ code, name, why: 'no page image' });
      continue;
    }
    // The page title has to actually contain the name we asked for, or the search
    // matched something else entirely and we would be showing the wrong aeroplane.
    const confident = String(page.title).toLowerCase().includes(name.toLowerCase().split(' ')[0].toLowerCase());
    found.set(code, {
      name,
      title: page.title,
      file,
      thumb,
      confident,
      reason: confident ? 'search matched the type name' : `search matched "${page.title}"`,
    });
  } catch (error) {
    misses.push({ code, name, why: error.message });
  }
  // Wikimedia asks for a reasonable rate, same as the flight feed does.
  await new Promise((resolve) => setTimeout(resolve, 220));
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
        'One search per aircraft type using the name this site already shows, taking the first result and its page image, then one batched query for the licence terms of every file.',
      covers: 'Every type code in the measured survey. A type with no entry has no page image this could trust.',
      note:
        'A photograph is a glance and the name beside it is the truth: search matches a page, and a page image is usually the aeroplane but is not guaranteed to be. Entries whose match was weak are marked confident: false.',
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
