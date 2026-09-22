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

- **No more nautical miles, and the distance is asked where the aircraft are picked.** *"nobody understand nm"* — the
  reader presses one stop, and the row **opens on `All`** (the feed's own widest fence, 250 nautical miles = 463 km)
  with George's numbered stops beside it: **25 · 50 · 75 · 100 · 150 · 200 · 400 km**, never more than double the one
  before. *Prior wording, now dead: "each about a quarter larger than the last" — that described the seventeen-stop
  scale, and then six doubling stops, both of which he has since replaced.*
  **It was a slider for one day.** George, 22 Sep 2026: *"i want this above the map"* — then, the same day:
  *"i forgot the slider is actually a filter for pic an aircraf. lets remove the slider and ask the distance
  about the pick an aircraf under kind"*. He is describing what the control actually does: the distance decides
  which aircraft the feed is asked about, and therefore which rows exist at all — so it belongs with choosing
  what to watch, and it is asked in step 3, under the kind filter, as a row of chips. A chip also cannot do the
  thing that made the slider dangerous: land between two stops, where `RADIUS_LADDER[index]` is `undefined` and
  the whole map draws at NaN. The gate on step 3 is the place alone; a distance is in use from the start. What
  stayed above the map is *"Last refreshed &lt;time&gt;"* — counted from the last feed reading, by the same
  ticker that ages every row. The feed still takes
  nautical miles, because its own endpoint summary says *"up to 250nm"*, so the conversion is exact (1 nm =
  1852 m) and lives in `kmToNm` / `nmToKm` where a test can check it.
- **Watch a type, then narrow it if you want.** `npm run survey` reads the feed around all seven airports and
  writes `site/types.json` — the aircraft that *actually* come and go, counted, with the date and the method
  beside them. A type is watched **whole** until you add tail numbers to it; removing the last tail widens it
  back to the whole type. The page never invents a type: an unknown code is shown as itself.
- **"What you are watching" names the aeroplanes.** The row for a watched type lists every tail number on
  record for it, under the type, with the ones being watched in yellow — a whole-type rule marks every tail
  it lists. It does **not** answer with a phrase: *"every one of them"* named nothing, so it was removed
  (George, 22 Sep 2026). The list is the same sample the card shows — what identified itself, never a fleet
  list.

## The table, the trail and the card that went (22 Sep 2026)

- **The route leads the row, in two columns, and the phase column is gone.** The table used to name a type in
  a full-width `<tr>`, which read as a row that did not fit its own columns — *"the line in the middle is
  confusing"* — and said only "1 aircraft" when a type had one example; the rows are still sorted by type.
  The nearest airport had a column of its own, and it went on 22 Sep 2026 — *"remove airport column, and
  move the DESTINATION column to be the first column"* — because it answered a question the same row
  already answers twice, with the bearing and the position. **Then the route itself became two columns**
  (22 Sep 2026, later: *"spil destination in to columns called depature and desination"*), so each leg
  carries what a reader wants from it: the departure has the airport it left and the time this page has for
  it leaving the ground, the destination has the airport it is bound for and about how long it has left to
  run. Each leg carries its own city, because a four-letter code is precise and useless to anyone who has
  not memorised four thousand of them. Every code in the table is still printed with the place it means
  beside it.
- **The phase is a tag now, not a column.** It said `airborne` on nearly every row — measured on the live
  table — so the column was there to repeat one word. What is ever news is the row that is **not** airborne:
  an aircraft on the ground inside the fence, or one transmitting a position with no altitude at all. Those
  two are drawn as a tag beside the callsign, and the word that said nothing is not rendered.
- **Destination is looked up, not heard, and the card says so.** Measured 22 Sep 2026: the feed's own callsign
  endpoint returns hex, registration, type, altitude and track — and no origin, destination or route. ADS-B
  carries who the aircraft is, never where it is booked to. So `Destination` comes from a free callsign lookup
  (`api.adsbdb.com`, no key) through the same proxy, normalised to this site's own field names. A dash means no
  route is on file; "asking…" means the answer has not arrived. A diversion or a reused callsign can make it
  wrong, which is why the column is labelled as a different kind of claim from the readings beside it.
- 🔴 **There is no takeoff time in the feed, so the departure cell says which time it has.** Measured: a live
  Hamilton response carries position, altitude, ground speed, track, squawk, an age and the quality flags —
  **no origin, no destination and no time of any kind**. The page therefore offers only what it watched:
  **`took off 14:05`**, and only where the engine confirmed a ground-to-air transition, or **`first seen
  14:22`** for the weaker fact that this reading is the first it has of that aircraft. Both are in the
  reader's own time zone and the tooltip says which is which. **A time the whole page shares is not news
  about an aircraft**, so the weaker one is withheld when it is no later than the moment the page opened —
  otherwise sixty rows carry sixty identical times. A row with no time says so in its own tooltip.
- 🔴 **The run to the destination is an estimate, and it says so where the number is.** *"destinate use
  fromnow()"* — the cell reads **`in about 1h 40m`**, with the word *about* in the cell. It is arithmetic on
  three measured numbers and nothing else: where the aircraft is, where the airport is (the feed answers
  `/api/0/airport/{icao}` for any airport by code — verified: `KDEN` → 39.861698, -104.672997), and the
  speed the aircraft reports over the ground. It assumes a straight line at an unchanged speed, and stays
  silent below 60 knots, under a minute, and over twelve hours. The airport lookups are **queued two at a
  time**, because asking for sixty at once made the feed answer 429 — and a refusal is retried rather than
  remembered as an unknown airport, so one busy second cannot take the estimate off every row for a session.
- **The flight path is coloured by what the aircraft did.** It was one `<polyline>` in one colour, so a climb
  and a descent were drawn identically and the trail answered the one question a flight path exists to answer
  with a line that said nothing. It is one line per segment now, classed from the altitude recorded on each
  trail point: **green** climbing, **amber** descending, **grey** level, **dashed grey** where the reading
  carried no altitude — and only then does it fall back to the rate of climb the aircraft is reporting now.
  A key sits under the map, because a colour with no key is a code nobody can read. Trail points carry the
  altitude they were recorded at (`detect.ts`), so an old tab's trail falls back rather than lying.
- **The "In the air right now" card is gone**, with its radar drawing, its second table and its two methods.
  It showed the same aircraft as the card above it, in different columns, and printed "nothing matching your
  selection is in the air" underneath a table a reader had already been told about. The one map is in the
  watching section and did not go with it.

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
stored on a server: the watchlist, the place you gave, the airport you picked, the distance and the
filters live in the reader's own browser.

### The old aircraft — collected, and no longer promised

🔴 **THE PAGE DOES NOT SHOW A SCHEDULE, AND THAT IS DELIBERATE.** George, 22 Sep 2026, pasting the
museum panel back whole: ***"remove this section, if these plans show up then they show up"***.

It used to print a museum, the eight aircraft it keeps and the days it intends to fly them — from the
airport the reader already had on screen — and then, in the same panel, admit that the feed had never
once reported one of those eight. A **schedule is a promise about the future on a card that only
reports the past**, and the reader was left holding both halves at once. What the page says now is what
was measured: if one of those aeroplanes goes up and transmits, it appears in the table like any other.

**The collector below is untouched and still runs.** It gathers data; it is not the section, and
nothing on the page depends on it either way. It is kept because the readings it holds — what the
museum flies, and which of those types the feed has actually seen — are worth having the day anyone
asks the question again.

#### The data, and how it is gathered

Three tables and a view in `db/schema.sql`, composed once in `tools/historic-document.mjs` and written
to `site/historic.json`. **Nothing on the page requests it any more** — a test asserts the page makes
no request for it — so it is data at rest, not a feature.

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
Hamilton International Airport."* When the panel existed it read *"flies from CYHM, 15 km from you"*,
and the distance was the same measurement as every other airport on the card. That sentence left with the
panel; the measurement it used is still the card's own.

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
code, so the question has not been asked.** The old panel printed the never-reported note only for a
definite `false`. Only the Lancaster is sourced today.
