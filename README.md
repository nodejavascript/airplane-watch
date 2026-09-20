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

### The Lancaster that flies out of Hamilton

Asked 20 Sep 2026: *"im not sure way the lancaster doesnt show up in hamilton, search the web they do
offer tour flights"*. Read live from the museum's own pages that day:

- The **Canadian Warplane Heritage Museum** states *"We are located at 9280 Airport Road in Mount Hope,
  Ontario right at the Hamilton International Airport"* — which is **CYHM**, the airport this page
  watches, and one of the 76 entries in `site/airports.json`. Nothing there marks it as a place a
  Lancaster flies from.
- Its flights page says *"All Lancaster passenger seat sales for the 2026 season are NOW SOLD OUT.
  Seats for the 2027 season are expected to go on sale in November 2026."*
- **And the page still cannot show one, for the only reason that matters:** no type code beginning
  `LAN` appears in the 129 the survey measured. The page can list what the feed reported and nothing
  else. Its own aircraft flight schedule is fetched per day in the browser
  (`FlightPurchaseHandler.ashx?action=getAircraftFlightsDay&date=…`), so the dates are not in the
  markup and cannot be read without a browser.
- ⚠️ **Its ADS-B equipage was NOT confirmed.** `hexdb.io` returns *"Aircraft not found"* for both the
  registration and the computed hex, so it is unknown whether one would ever be reported here. Do not
  claim it is visible — that is not established either way.
