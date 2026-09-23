/**
 * nameable.mjs — the one rule for "can this site put a name to this type code".
 *
 * 🔴 WHY IT IS ITS OWN FILE RATHER THAN A LINE IN EACH PLACE. Two things need to ask this
 * question:
 *
 *   - `test/static.test.js`, which refuses to let the repository hold a type list the page
 *     cannot name;
 *   - `tools/load-db.mjs`, which is the only thing that writes that list — and does so on
 *     a **timer**, every four hours, through `aircraft-survey.timer`.
 *
 * **A rule written twice is a rule that can disagree with itself**, and the disagreement
 * would be invisible: the two copies would only part company on the day somebody edited
 * one of them. So the question is asked here, once, and answered from one artefact.
 *
 * 🔴 AND IT ANSWERS FROM THE BUILT TABLE, WHICH IS THE FILE THE PAGE ACTUALLY LOADS. The
 * question is not *"does the source mention this code"* but *"does the file the browser
 * reads have an entry for it"* — `site/typeinfo.js`, built from `src/typeinfo.ts` by
 * `npm run build`. A source-only check would pass on an edit that never got built, which
 * is a mistake this project has already made once and written down.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TABLE = join(ROOT, 'site', 'typeinfo.js');

/**
 * Strip comments, so a code that appears only inside a note is not counted as named.
 *
 * The same two patterns the suite uses, for the same reason: this file's own notes discuss
 * type codes, and a check that reads them raw reports the prose as the entry.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * The codes given that this site has no entry for, in the order they arrived, with
 * duplicates removed. An empty array means every one of them can be named.
 *
 * Throws when the table cannot be read, rather than guessing. **"No table" is neither
 * "every code is named" nor "every code is unnamed"** — and either guess would be an
 * instrument answering a question it could not answer, which is worse than an instrument
 * that stops.
 */
export function unnamedCodes(codes) {
  let table;
  try {
    table = withoutComments(readFileSync(TABLE, 'utf8'));
  } catch (error) {
    throw new Error(
      `the type table could not be read at ${TABLE} (${error.message}) — run: npm run build`
    );
  }

  const missing = [];
  for (const code of new Set(codes)) {
    if (!new RegExp(`\\b${code}:`).test(table)) missing.push(code);
  }
  return missing;
}
