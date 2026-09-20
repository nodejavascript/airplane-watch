#!/usr/bin/env bash
#
# deploy.sh — build, test, then publish aircraft-demo.
#
# 🔴 THIS SCRIPT REFUSES TO RUN UNTIL THE SITE IS ACTUALLY READY TO GO LIVE, and
# that is the point rather than an annoyance. House standard parts 5c and 7a: on
# the day a site is deployed four things are made TOGETHER — the DNS record, the
# theme colour, the background, and its own Google Analytics property in the `mcp`
# account, named with the full domain. The unit suite contains a test that fails
# while `data-ga-id` is still the placeholder, so `npm test` fails and this script
# stops before anything is published. A half-deployed site is worse than an
# undeployed one.
#
# The static site goes to Caddy on dvs-sites; the /api proxy goes to the
# Cloudflare Worker. Both are needed: without the Worker the page loads and every
# poll fails.
#
# Usage: bash tools/deploy.sh [--dry-run]

set -euo pipefail

cd "$(dirname "$0")/.."
SITE_DIR="site"
REMOTE_DIR="/srv/aircraft-demo"
HOST="aircraft-demo.nodejavascript.com"
DRY_RUN="${1:-}"

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

say "1/6 · build"
npm run build

say "2/6 · unit tests (this is where the GA-placeholder gate stops an early deploy)"
npm test

say "3/6 · check the pieces that must exist before a deploy"
[ -f "$SITE_DIR/index.html" ] || die "no $SITE_DIR/index.html"
[ -f "$SITE_DIR/consent.js" ] || die "no $SITE_DIR/consent.js — the gate did not build"
[ -f "$SITE_DIR/detect.js" ] || die "no $SITE_DIR/detect.js — the detector did not build"
for icon in favicon.svg favicon-32.png favicon.ico apple-touch-icon.png; do
  [ -f "$SITE_DIR/$icon" ] || die "missing $SITE_DIR/$icon — run: npm run icons"
done
grep -q 'G-PENDING' "$SITE_DIR/index.html" && die "the Analytics id is still the placeholder"

say "4/6 · has the DNS record been created? (house rule 7a: at deployment, never before)"
if ! dig +short "$HOST" >/dev/null 2>&1 || [ -z "$(dig +short "$HOST" || true)" ]; then
  echo "  The name $HOST does not resolve yet."
  echo "  Create the DNS record NOW, with the deploy — that is the rule, and it is"
  echo "  also the only order in which the certificate can be issued:"
  echo
  echo "    ~/.cloudflare_open.py https://dash.cloudflare.com/"
  echo "    A  $HOST -> 178.128.225.32  (proxied)"
  echo
  die "stopping before anything is published"
fi
echo "  $HOST resolves."

say "5/6 · publish the static site, then the proxy"
if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "  dry run: rsync $SITE_DIR/ → dvs-sites:$REMOTE_DIR/"
  echo "  dry run: wrangler deploy"
else
  ssh dvs-sites "sudo mkdir -p $REMOTE_DIR"
  rsync -az --delete --rsync-path="sudo rsync" "$SITE_DIR/" "dvs-sites:$REMOTE_DIR/"

  # 🔴 THE CADDY BLOCK MUST BE IN PLACE AND MUST CARRY `no-store` ON THE SHELL,
  # or a returning visitor reads their own cache and a correct deploy looks
  # exactly like no deploy. It also has to import the family's (clean-urls)
  # snippet, so no URL a visitor sees ends in .html.
  ssh dvs-sites "sudo grep -q '$HOST' /etc/caddy/Caddyfile" || {
    echo "  The Caddy block for $HOST is not there yet. Add it — it must import"
    echo "  (clean-urls), must not name www, and must send the shell no-store:"
    echo
    echo "    $HOST {"
    echo "        import (clean-urls)"
    echo "        root * $REMOTE_DIR"
    echo "        @plain not path /static/*"
    echo "        header @plain Cache-Control \"no-store\""
    echo "        file_server"
    echo "    }"
    die "stopping before the reload"
  }
  ssh dvs-sites "sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy"

  # The proxy. Without it the page loads and every poll fails, because the feed
  # sends no cross-origin header.
  npx --yes wrangler deploy

  .venv/bin/python3 "$HOME/.cloudflare_purge.py" --all || true
fi

say "6/6 · verify the DEPLOYED page — never trust the push"
if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "  dry run: skipping the live check"
else
  node tools/live-check.mjs "https://$HOST/"
  echo
  echo "  Then, and only then:"
  echo "    1. add this site to the part 5 register   (~/.nodejs_theme_register.py)"
  echo "    2. add it to ~/.seo_audit.py's SITES and ~/.searchconsole_setup.py"
  echo "    3. verify BOTH Search Console properties and submit /sitemap.xml to each"
  echo "    4. add a link to it from nodejavascript.com, in the section it belongs in"
  echo "    5. .venv/bin/python3 ~/.nodejs_compliance.py --save"
fi

say "done"
