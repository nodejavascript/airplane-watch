/**
 * secrets.test.js — the Rollbar keys must never be in this repository, and a deploy
 * must not be able to put them there.
 *
 * 🔴 WHY THIS IS A TEST AND NOT A NOTE IN A FILE. George's instruction, 23 Sep 2026:
 * *"i just dont want rollbar keys saved to the repo, can you do that even when you
 * deploy?"* — and the repository is deliberately **public**, so a key that reaches a
 * commit is a key that has been published. The house rule is that a record is read at
 * the end while only a gate fires at the moment of work, and `tools/deploy.sh` runs
 * `npm test` as its own step 2 — so a check that lives here stops a publish, at the
 * moment of work, without anyone having to remember.
 *
 * WHAT IS CHECKED, AND WHERE EACH KEY REALLY LIVES:
 *
 *   1. **No key VALUE in the working tree** — every tracked file, which includes
 *      `site/`, the directory that is actually rsynced to the web. A key baked into a
 *      built page would be published to the internet and committed in the same breath.
 *   2. **No key VALUE in any commit** — `git log -S` across every branch, because a
 *      line deleted today is still in the commit that introduced it.
 *   3. **No token ASSIGNED as a literal** — the shape check, which catches a key this
 *      machine has never seen: a Rollbar token name followed by a quoted value.
 *   4. **No secret-shaped file tracked** — `.dev.vars`, `.env`, a key or a certificate.
 *
 * The comparison keys are read from `~/Documents/secrets/`, never from the repository,
 * and the test SKIPS with a printed reason on a machine that has no keys — an honest
 * skip, because a machine with no key has no key to leak. It never fails for the
 * absence of a file it does not own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/**
 * Where the keys really live. Overridable so the gate itself can be PROVED able to
 * fail, in a throwaway clone, with a made-up value — rather than by writing a live key
 * somewhere it does not belong just to watch a test go red. An unproven gate is only
 * a comment.
 */
const SECRETS = process.env.AIRCRAFT_SECRETS_DIR || join(homedir(), 'Documents/secrets');

/** The Rollbar credentials this project uses. Their real home is the secrets folder. */
const KEY_FILES = [
  '.rollbar_airplane_watch_server_token',
  '.rollbar_airplane_watch_read_token',
  '.rollbar_access_token',
];

/** A token NAME followed by a quoted value of 20+ token characters. */
const ASSIGNED_TOKEN = /rollbar[-_ ]?(server|account|access)?[-_ ]?token["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}/i;

/** Files that must never be tracked at all. */
const FORBIDDEN_FILE = /(^|\/)\.dev\.vars$|(^|\/)\.env(\.|$)|\.(pem|key|p12)$/i;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

/** Every tracked file, with its contents. Binary-ish files are skipped by size. */
function trackedFiles() {
  const names = git(['ls-files']).split('\n').filter(Boolean);
  const files = [];
  for (const name of names) {
    const path = join(ROOT, name);
    if (!existsSync(path)) continue;
    if (statSync(path).size > 2_000_000) continue;
    let content;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue; // not text
    }
    files.push({ name, content });
  }
  return files;
}

/** The keys this machine actually holds, as {name, value}. Empty is a valid answer. */
function localKeys() {
  const keys = [];
  for (const name of KEY_FILES) {
    const path = join(SECRETS, name);
    if (!existsSync(path)) continue;
    const value = readFileSync(path, 'utf8').trim();
    if (value.length >= 20) keys.push({ name, value });
  }
  return keys;
}

/* ------------------------------------------------ no key value in the tree --- */

test('no Rollbar key is in any tracked file, including the published site/', (t) => {
  const keys = localKeys();
  if (keys.length === 0) {
    t.diagnostic('no Rollbar key on this machine, so there is no value to search for');
    return;
  }

  const files = trackedFiles();
  const found = [];
  for (const { name, content } of files) {
    for (const key of keys) {
      if (content.includes(key.value)) found.push(`${key.name} in ${name}`);
    }
  }

  assert.deepEqual(found, [], `a Rollbar key is in a tracked file: ${found.join(', ')}`);
  t.diagnostic(`searched ${files.length} tracked files for ${keys.length} key(s)`);
});

/* --------------------------------------------- no key value in any commit --- */

test('no Rollbar key is in any commit, on any branch', (t) => {
  const keys = localKeys();
  if (keys.length === 0) {
    t.diagnostic('no Rollbar key on this machine, so there is no value to search for');
    return;
  }

  for (const key of keys) {
    // -S is the pickaxe: it reports commits where the number of occurrences of the
    // string changed, which includes a commit that REMOVED it. A line deleted today is
    // still in the commit that introduced it, so absence here is the real claim.
    const hits = git(['log', '--all', '--oneline', `-S${key.value}`]).trim();
    assert.equal(hits, '', `commits containing ${key.name}:\n${hits}`);
  }
});

/* ------------------------------------------- no token assigned as a literal --- */

test('no tracked file assigns a Rollbar token as a quoted literal', () => {
  const offenders = [];
  for (const { name, content } of trackedFiles()) {
    for (const [index, line] of content.split('\n').entries()) {
      // The name is allowed to appear — it is read from the environment. What is not
      // allowed is a name followed by a value someone pasted in.
      if (ASSIGNED_TOKEN.test(line)) offenders.push(`${name}:${index + 1}`);
    }
  }
  assert.deepEqual(offenders, [], `a Rollbar token looks pasted into: ${offenders.join(', ')}`);
});

/* ------------------------------------------------- no secret-shaped file --- */

test('no secret-shaped file is tracked, and .dev.vars is ignored', () => {
  const tracked = git(['ls-files']).split('\n').filter(Boolean);
  const offenders = tracked.filter((name) => FORBIDDEN_FILE.test(name));
  assert.deepEqual(offenders, [], `these must never be tracked: ${offenders.join(', ')}`);

  // The local twin of the Worker secret is ignored, so creating one to develop against
  // cannot stage itself. `git check-ignore` exits 0 only when the path IS ignored.
  const ignored = (() => {
    try {
      git(['check-ignore', '.dev.vars']);
      return true;
    } catch {
      return false;
    }
  })();
  assert.equal(ignored, true, '.dev.vars is NOT ignored — the local twin of the Worker secret could be committed');
});
