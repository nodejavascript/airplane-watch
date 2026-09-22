# aircraft-demo

Watch a named aircraft leave a named airport, and be told when it does.

Live: **https://aircraft-demo.nodejavascript.com** *(not yet deployed — see below)*
Local: `npm run serve` → http://127.0.0.1:4340/

## What it does

Pick one of seven airports, point a fence of 5, 10 or 25 nautical miles at it, and
name the aircraft you care about by tail number, callsign or transponder address.
The page asks a public flight feed for everything inside the fence every ten
seconds, and tells you the moment a watched aircraft is airborne — with a browser
notification if you allowed one.

## The honest part, which is the whole design

**An aircraft sitting on the apron is only heard by a receiver a few kilometres
away.** Buildings and the curve of the earth block 1090 MHz at ground level, so
the ground state is missing exactly when it is most wanted. Every departure is
therefore labelled:

- **seen on the ground first** — the aircraft was read on the ground inside the
  fence and is now airborne. A fact.
- **first seen climbing** — it was never seen on the ground, but it is inside the
  fence, airborne, and climbing. Almost certainly a departure, and called a guess.

A flyover is ignored, a descending aircraft is ignored, a stale reading proves
nothing, and a missing altitude is never read as "on the ground". Each of those
guards has a test in `test/detect.test.js`, because a guard nobody can
demonstrate is a comment.

## Why there is a proxy

`api.adsb.lol` sends **no `Access-Control-Allow-Origin` header at all** and answers
an OPTIONS preflight with **405** (measured 20 Sep 2026). A browser therefore sends
the request, receives a real 200 with real aircraft, and discards the answer. So
every call goes to `/api/…` on this origin: `tools/serve.mjs` locally, and the
Cloudflare Worker in `worker/` in production.

Production deliberately does **not** send a wildcard CORS header — the page is
same-origin and needs none, and a wildcard would make the Worker an open relay for
anybody's browser to spend the feed's bandwidth through.

## Commands

```bash
npm run build      # tsc: src/*.ts → site/*.js   (never edit site/*.js by hand)
npm run serve      # build, then serve on 4340 and proxy /api
npm run survey     # re-measure which aircraft types really come and go → site/types.json
npm run icons      # regenerate the icon set
npm test           # unit: the detector, and the site standard
npm run test:e2e   # real Chrome, stubbed feed, no network needed
npm run test:live  # against the DEPLOYED host
npm run deploy     # build → test → rsync → wrangler → live check
```

`site/*.js` is generated. Edit `src/`.

## Distances are kilometres, and the type list is measured

Two things were changed on 20 Sep 2026 because they were wrong for a visitor:

- **No more nautical miles.** *"nobody understand nm"* — so the reader picks 10, 20 or 50 km with a plain-word
  label beside each (*"Just the airport"*, *"the airport and the city"*, *"the whole region"*). The feed still
  takes nautical miles, because its own endpoint summary says *"up to 250nm"*, so the conversion is exact
  (1 nm = 1852 m) and lives in `kmToNm` / `nmToKm` where a test can check it.
- **Watch a type, then narrow it if you want.** `npm run survey` reads the feed around all seven airports and
  writes `site/types.json` — the aircraft that *actually* come and go, counted, with the date and the method
  beside them. A type is watched **whole** until you add tail numbers to it; removing the last tail widens it
  back to the whole type. The page never invents a type: an unknown code is shown as itself.
- **"What you are watching" names the aeroplanes.** The row for a watched type lists every tail number on
  record for it, under the type, with the ones being watched in yellow — a whole-type rule marks every tail
  it lists. It does **not** answer with a phrase: *"every one of them"* named nothing, so it was removed
  (George, 22 Sep 2026). The list is the same sample the card shows — what identified itself, never a fleet
  list.

**`site/types.json` is data, not code** — refresh it by re-running one script rather than by editing the site.
The survey is polite about the feed's rate limit and reports any round it could not get (measured: seven
airports polled back to back had five refused by the third round).

## Not deployed yet, and what that means

House rule **7a**: DNS is created at deployment, never before. This is a demo on a
port, not a subdomain, so four things do not exist yet and are made together on
the day it goes live:

1. the DNS record for `aircraft-demo.nodejavascript.com`
2. its own Google Analytics property in the `mcp` account, named with the full domain
3. its row in the family theme register
4. its link from `nodejavascript.com`

`site/index.html` carries `data-ga-id="G-PENDING"`, and **a unit test fails while
that is true** — so `npm test`, and therefore `npm run deploy`, cannot complete
against an undeployed site whose property was never created. That is the gate, not
an oversight.

## Data

Aircraft positions from **[adsb.lol](https://adsb.lol/)**, a community network,
published under the **Open Database License**. Aircraft that have asked not to be
published, and aircraft with no ADS-B at all, will never appear here. Nothing is
stored on a server: the watchlist, the chosen airport and the departures board
live in the reader's own browser.

### The old aircraft, and the days they fly — this is the point of the page

George, 20 Sep 2026: **"thats the whole point actually, to watch these old aircraft fly past your
home location"**. Everything else here answers *what is in the air*. This answers the question a
reader actually has about a rare aeroplane, which is **when to look up** — because a Lancaster flies a
handful of times a year, and a handful of times a year is not something anybody notices by chance.

**It is DATA, in the database, served by the API.** Asked of an earlier draft that had it as a note
here: *"shoudnt these be in the api?"* — and the honest answer was yes. Three tables and a view in
`db/schema.sql`, composed once in `tools/historic-document.mjs` and served at `/historic.json`.

```bash
node tools/load-historic.mjs            # read the operator's next 28 days
node tools/load-historic.mjs --check    # what the database already holds
```

**It runs by itself, once a day.** `aircraft-historic.timer` fires at **07:40** — after the 07:20
survey round, so the two do not queue behind each other — and re-reads the whole 28-day window every
time, so the schedule is always a month deep and a day fresh. A run takes about a minute. The units
are versioned in `~/preferences/aircraft/` because a systemd unit is not part of this repo.

The museum is at **CYHM** — the airport this page already watches, 15 km from Hamilton — and the
museum names it itself: *"We are located at 9280 Airport Road in Mount Hope, Ontario right at the
Hamilton International Airport."* So the panel reads *"flies from CYHM, 15 km from you"*, and the
distance is the same measurement as every other airport on the card.

Two things are worth knowing before touching the loader:

- **The endpoint's `date` parameter is one day ahead of the day it returns.** Measured against ten
  dates, all ten agreeing. The loader asks for the offset day **and** checks every event against the
  day it claims, so if that ever changes the result is an empty day rather than the wrong day.
- **`LANC` is a Lancaster and `LNC4` is a Lancair.** The survey's own list contains `LNC4`, a
  kit-built light aircraft. A name-shaped match would have announced a Lancaster on the strength of a
  Lancair. Only `LANC` is the Lancaster, and only the Lancaster's code has a source
  (`hexdb.io` hex `C07DD7` — Registration `C-GVRA`, ICAOTypeCode `LANC`, RegisteredOwners
  *Canadian Warplane Heritage Museum*).

**⚠️ CORRECTED 20 SEPTEMBER 2026, AND THE PRIOR TEXT IS QUOTED SO IT CANNOT COME BACK.** This section
previously ended: *"Its ADS-B equipage was NOT confirmed. `hexdb.io` returns 'Aircraft not found' for
both the registration and the computed hex, so it is unknown whether one would ever be reported
here."* **That was wrong**, and it was reached by looking up a hex computed from the registration
rather than the hex the airframe actually carries — and then drawing a conclusion from two 404s.
`C-GVRA` **is** in the register, under its Mode-S address `C07DD7`, with owner *Canadian Warplane
Heritage Museum*. The type is `LANC` and it is the one the page already knows. **The right statement
is the opposite one: the page would show it the moment a survey round caught it, and no round ever
has** — which `site/historic.json` reports as `reported: false`, read from the survey's own table.

`reported` has **three** states in the data, and the third is the honest one: `true` (the feed has
reported this type), `false` (it never has), and **`null` — nobody has sourced this aircraft's type
code, so the question has not been asked.** The page prints the never-reported note only for a
definite `false`. Only the Lancaster is sourced today.
