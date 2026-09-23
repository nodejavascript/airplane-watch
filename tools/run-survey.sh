#!/usr/bin/env bash
#
# One round of watching: ask the feed what is flying near the airports this site
# covers, then put what it found into the site's database.
#
# 🔴 WHY THIS EXISTS. George, 20 Sep 2026: *"any year, t= i want last seen to work."*
# Last-seen could not work from a single reading — with one survey every type shares
# one timestamp, so "in the last day", "in the last week" and "in the last month" are
# the same set and the filter does nothing. What makes it work is runs ACCUMULATING:
# each round records what it saw, and a type seen in three of ten rounds is a
# different proposition from one seen in all ten.
#
# So this is not a one-off command. It is a thing that happens on a schedule, and the
# schedule is the feature.
#
# 🔴 THE FEED HAS A REAL LIMIT AND THIS IS BUILT TO STAY INSIDE IT. Measured
# 20 Sep 2026: ten requests three seconds apart, ten one second apart, and eight two
# seconds apart were ALL refused with HTTP 429 from the third or fourth request on.
# The feed is volunteer-funded. A round makes about 21 requests with its own pauses,
# which takes roughly three minutes — deliberately slow. Do not shorten those pauses
# and do not raise the frequency to make the numbers move faster: an impatient
# scraper is how a free feed gets closed to everybody.
#
# Usage:  tools/run-survey.sh            # one round
#         tools/run-survey.sh --check    # say what is in the database, ask nothing

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}"
LOG="$LOG_DIR/aircraft-survey.log"
mkdir -p "$LOG_DIR"

say() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

# A check is a question, not a round — answer it on the terminal, out of the log,
# and do not take the lock for it.
if [[ "${1:-}" == "--check" ]]; then
  node tools/load-db.mjs --check
  exit 0
fi

# Never two rounds at once. A second round starting while the first is still asking
# would double the request rate at exactly the moment the feed is least willing.
exec 9>"$LOG_DIR/aircraft-survey.lock"
if ! flock -n 9; then
  say 'a round is already running — leaving it to finish'
  exit 0
fi

{
  say '--- round starting ---'

  # The database lives on the droplet and is reached through the tunnel service.
  # If the tunnel is down the round still runs — the file is still written — and the
  # load fails loudly rather than silently keeping the site on yesterday's answer.
  if ! node tools/survey-types.mjs; then
    say 'the survey failed; nothing was loaded'
    exit 1
  fi

  # 🔴 EXIT 3 IS ITS OWN ANSWER, AND IT IS NOT A FAILURE. `load-db.mjs` withholds the
  # publish when the round saw a type code the site has no name for — the file the site
  # serves is left as it was. Anything else non-zero means the database could not be
  # reached. Reporting 3 as "the database could not be reached" would send the next reader
  # to check a tunnel that is working perfectly, which is the most expensive kind of
  # wrong message.
  set +e
  node tools/load-db.mjs
  code=$?
  set -e

  if [[ $code -eq 0 ]]; then
    say 'round complete'
  elif [[ $code -eq 3 ]]; then
    say 'the round loaded, but site/types.json was NOT published — the site has no name for a type it saw'
    say 'the would-be file is in .survey/; name the codes in src/typeinfo.ts and the next round will publish'
  else
    say 'the survey was written to the file, but the database could not be reached'
    say 'run: systemctl --user status aircraft-db-tunnel.service'
    exit 1
  fi
} >>"$LOG" 2>&1

# Keep the log from growing without limit — a round writes about 20 lines.
if [[ "$(wc -l <"$LOG")" -gt 4000 ]]; then
  tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
