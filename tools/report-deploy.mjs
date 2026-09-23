/**
 * report-deploy.mjs — tell Rollbar which revision went out.
 *
 * 🔴 WHY THIS EXISTS AT ALL, AND IT IS A MEASURED REASON — 23 September 2026.
 * Rollbar refuses an ERROR report from this project: `POST /item/` answers
 *
 *     429  {"err":1,"message":"This account has been deactivated. To reactivate
 *           it, log in to Rollbar and choose a plan."}
 *
 * — while the **same** `post_server_item` key, posting at the same moment to
 * `POST /deploy/`, answers **200 `{"data":{"deploy_id":45306460}}`**. The API
 * reference says one token covers both endpoints, and it does. So the key, the
 * project and the account's write path are all fine, and what a plan governs is
 * **occurrence ingestion** specifically. That makes the deploy report the one
 * Rollbar channel that works today.
 *
 * It is worth having regardless of any of that, because an error is far easier to
 * read next to the release that introduced it — which is the whole point of deploy
 * tracking in Rollbar.
 *
 * 🔴 IT CANNOT FAIL THE DEPLOY. Rollbar's answer is printed, and the exit code is
 * 0 unless `--strict` is passed, because a monitoring record is not worth a failed
 * publish. That is the same rule the Worker's reporter follows at the other end:
 * the thing that watches must never become the incident.
 *
 * The token is read from the secrets folder and is never in this repository:
 *   $ROLLBAR_SERVER_TOKEN_FILE, else ~/Documents/secrets/.rollbar_airplane_watch_server_token
 *
 * Usage: node tools/report-deploy.mjs [--revision <sha>] [--dry-run] [--strict]
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const ENDPOINT = 'https://api.rollbar.com/api/1/deploy/';
const TOKEN_FILE =
  process.env.ROLLBAR_SERVER_TOKEN_FILE ||
  join(homedir(), 'Documents/secrets/.rollbar_airplane_watch_server_token');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const strict = args.includes('--strict');
const revisionFlag = args.indexOf('--revision');

function git(command) {
  return execSync(command, { cwd: join(import.meta.dirname, '..') }).toString().trim();
}

const revision =
  revisionFlag === -1 ? git('git rev-parse HEAD') : args[revisionFlag + 1] || git('git rev-parse HEAD');
const subject = git('git log -1 --pretty=%s');

const payload = {
  environment: 'production',
  revision,
  local_username: 'geooogle',
  comment: subject.slice(0, 200),
};

if (dryRun) {
  console.log(`dry run · would report this deploy to Rollbar:`);
  console.log(`  ${JSON.stringify(payload)}`);
  process.exit(0);
}

let token;
try {
  token = readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {
  console.log(`  (no Rollbar token at ${TOKEN_FILE} — the deploy is not reported)`);
  process.exit(strict ? 1 : 0);
}

try {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rollbar-access-token': token },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const text = (await response.text()).replace(/\s+/g, ' ').slice(0, 200);
  console.log(`  Rollbar deploy report (${revision.slice(0, 7)}) -> HTTP ${response.status} ${text}`);
  if (!response.ok) process.exit(strict ? 1 : 0);
} catch (error) {
  console.log(`  Rollbar deploy report could not be sent: ${error.message}`);
  process.exit(strict ? 1 : 0);
}
