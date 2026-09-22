/**
 * verify-airports.mjs — turn a list of airport IDENTIFIERS into a list of
 * airports, using the feed as the authority.
 *
 * Why this exists: the page needs names and positions for the airports it offers,
 * and typing them in is how a site ends up watching the wrong piece of sky. A
 * mistyped latitude does not throw — the fence still draws, the feed still
 * answers, and the page quietly reports that nothing ever takes off anywhere.
 *
 * So `src/region.ts` carries ONLY the identifiers, and this script asks the feed
 * about each one. What comes back is written to `site/airports.json`. What does
 * not come back is **dropped and reported** — a code the feed has never heard of
 * is a code we do not offer, rather than a row with a guessed position.
 *
 * Usage:  node tools/verify-airports.mjs
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = 'https://api.adsb.lol';

/** Polite to a volunteer-funded service: roughly one request a second. */
const BETWEEN_MS = 1_100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the identifiers straight out of region.ts, so there is one source of them. */
function identifiersFromSource() {
  const source = readFileSync(join(ROOT, 'src', 'region.ts'), 'utf8');
  const block = source.match(/export const REGION_AIRPORTS[^=]*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error('REGION_AIRPORTS not found in src/region.ts');
  return [...block[1].matchAll(/'([A-Z0-9]{4})'/g)].map((match) => match[1]);
}

async function ask(icao) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`${UPSTREAM}/api/0/airport/${icao}`, {
      headers: { accept: 'application/json', 'user-agent': 'planewatch airport check' },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429) {
      console.log(`    ${icao}: rate-limited, waiting ${attempt * 4}s`);
      await sleep(attempt * 4_000);
      continue;
    }
    if (!response.ok) return { ok: false, why: `HTTP ${response.status}` };
    return { ok: true, payload: await response.json() };
  }
  return { ok: false, why: 'still rate-limited after four attempts' };
}

async function main() {
  const identifiers = identifiersFromSource();
  const unique = [...new Set(identifiers)];
  console.log(`checking ${unique.length} identifiers against the feed\n`);

  const kept = [];
  const dropped = [];

  for (const icao of unique) {
    const result = await ask(icao);
    if (!result.ok) {
      dropped.push({ icao, why: result.why });
      console.log(`  DROPPED ${icao} — ${result.why}`);
      await sleep(BETWEEN_MS);
      continue;
    }
    const payload = result.payload ?? {};
    const lat = Number(payload.lat);
    const lon = Number(payload.lon);
    // A payload without a usable position is a drop, not a row at 0,0 — the
    // Atlantic. Refusing it here is the whole point of the script.
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      dropped.push({ icao, why: 'no usable position in the answer' });
      console.log(`  DROPPED ${icao} — no usable position`);
      await sleep(BETWEEN_MS);
      continue;
    }
    kept.push({
      icao: String(payload.icao || icao).toUpperCase(),
      iata: String(payload.iata || ''),
      name: String(payload.name || icao),
      location: String(payload.location || ''),
      country: String(payload.countryiso2 || ''),
      lat,
      lon,
      elevationFt: Number.isFinite(Number(payload.alt_feet)) ? Number(payload.alt_feet) : null,
    });
    console.log(`  ok      ${icao}  ${payload.name}  (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
    await sleep(BETWEEN_MS);
  }

  kept.sort((a, b) => a.icao.localeCompare(b.icao));

  writeFileSync(
    join(ROOT, 'site', 'airports.json'),
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        // Said out loud so nobody has to guess how much of the world this covers.
        covers:
          'Southern Ontario, Québec, and the American states within reach of the border. Somebody outside this region sees no airports and is told so.',
        method: 'Each identifier in src/region.ts looked up at /api/0/airport/{icao}; names and positions come from the feed, never from this repository.',
        checked: unique.length,
        kept: kept.length,
        dropped,
        airports: kept,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  console.log(`\nkept ${kept.length}, dropped ${dropped.length}`);
  if (dropped.length > 0) {
    console.log('dropped codes (remove them from src/region.ts or fix the typo):');
    for (const entry of dropped) console.log(`   ${entry.icao} — ${entry.why}`);
  }
  console.log('wrote site/airports.json');
}

main().catch((error) => {
  console.error(`airport check failed: ${error.message}`);
  process.exit(1);
});
