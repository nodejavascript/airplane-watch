/**
 * app.ts — the page.
 *
 * The interesting logic is not here; it is in detect.ts, which is pure and
 * tested. This file does four things and no more:
 *
 *   1. asks the feed where the airport is, and keeps asking the feed for the
 *      aircraft near it;
 *   2. hands each poll to the DetectionEngine and renders what comes back;
 *   3. keeps the reader's watchlist and the aircraft types they picked in
 *      localStorage, so closing the tab does not lose the session;
 *   4. fires a browser notification when something they asked about leaves.
 *
 * 🔴 WHY THERE IS A PROXY AT ALL — measured 20 Sep 2026, not assumed. `api.adsb.lol`
 * answers a plain GET with **no `Access-Control-Allow-Origin` header at all**, and
 * answers an OPTIONS preflight with **405**. So a page on this origin may not read
 * that response in a browser: the request is sent, the feed answers 200, and the
 * browser throws the answer away. That is the silent kind of failure — nothing in
 * the page's own code is wrong. So every call goes to `/api/...` on THIS origin,
 * which is served in development by `tools/serve.mjs` and in production by a
 * Cloudflare Worker. Both do the same small job.
 */

import {
  parseAirport,
  type ResolvedAirport,
} from './airports.js';
import { thumbSvg } from './thumbs.js';
import {
  DEFAULTS,
  DetectionEngine,
  distanceNm,
  kmToNm,
  nmToKm,
  normaliseKey,
  type Departure,
  type Reading,
  type TrackState,
  type TypeRule,
} from './detect.js';
import {
  CLASS_ORDER,
  classLabel,
  describeType,
  isCivilClass,
  knownTypeCodes,
  knownTypeCount,
  makerOf,
  type AircraftClass,
} from './typeinfo.js';

const WATCH_KEY = 'aircraft_watchlist';
const TYPES_KEY = 'aircraft_types';
/**
 * 🔴 THE ALERT LIST IS ITS OWN, AND IT IS KEPT SEPARATELY. George, 20 Sep 2026: *"i should be
 * able to select from the list w3hich ones i want an alert for"*. Sharing `TYPES_KEY` would
 * put the star and the bell back in one list, which is the thing he is asking to separate.
 */
const ALERTS_KEY = 'aircraft_alerts';
const AIRPORT_KEY = 'aircraft_airport';
/**
 * 🔴 THE READER'S PLACE AND THEIR DISTANCE ARE KEPT TOO. George, 20 Sep 2026:
 * *"and maybe save in cooking, my location, how far, my favorites"* — the
 * favourites were already kept and the other two were not, so a reload made you
 * answer the distance again and forgot where you were.
 *
 * 🔴 IT IS LOCAL STORAGE AND NOT A COOKIE, ON PURPOSE. A cookie is sent to the
 * server with every single request, so a cookie holding where you are would hand
 * your position to this site ten times a minute. Local storage is never
 * transmitted anywhere. And the privacy section already tells the reader their
 * answer is "remembered in your browser's local storage, not in a cookie" — using
 * a cookie for this would make that sentence false.
 */
const CENTRE_KEY = 'aircraft_centre';
const RADIUS_KEY = 'aircraft_radius';
/** The community the reader picked inside this place — see renderAreaPicker. */
const AREA_KEY = 'aircraft_place_area';
/**
 * 🔴 THE FILTER CHOICES ARE REMEMBERED TOO — SAME STORE, SAME REASON.
 *
 * George, 22 Sep 2026: *"save the users setting in cookie"*. What he is asking for is that a reader
 * does not choose the same filters again on every visit. The watchlist, the place, the airports and the
 * distance are already kept exactly that way, and these four are the rest of what the reader chooses.
 *
 * 🔴 IT IS THE BROWSER'S OWN STORE AND NOT A COOKIE, AND THE REASON IS WRITTEN ABOVE THE PLACE KEY
 * ALREADY: a cookie is sent to the server with every request, so a cookie holding what you are watching
 * would hand it over ten times a minute, and the published policy tells the reader these settings live
 * in local storage *"not in a cookie"*. A settings cookie would make that sentence false to no purpose,
 * because nothing on the server reads it. His earlier version of this request — *"and maybe save in
 * cooking, my location, how far, my favorites"*, 20 Sep 2026 — was answered the same way.
 */
const KIND_KEY = 'aircraft_kind';
const MAKER_KEY = 'aircraft_maker';
const ERA_KEY = 'aircraft_era';
const SEEN_KEY = 'aircraft_seen';
/**
 * 🔴 A WIPE FINDS ITS KEYS — IT DOES NOT REMEMBER THEM. George, 22 Sep 2026: *"last item,
 * right align a link on the row ... called delete my data, with confirmation box. this
 * effectivly resets their location, and everything else"* — and then, so the scope could
 * not be read narrowly: *"this rests all defalt filters too"*.
 *
 * 🔴 AND THE LABEL WAS WIDENED THE NEXT DAY TO SAY WHERE THE PRESS LANDS. George, 23 Sep 2026:
 * *"delete my data can say delete my data and start over"*. The control clears the store AND comes
 * back as a first visit with every default in place, and the old word named only the first half — so
 * the label, the privacy page's two mentions and this comment now all say the same four-word thing.
 *
 * Every key this page writes begins with this prefix, so a wipe can enumerate what is
 * actually there instead of carrying a list of names. That matters, because the list the
 * older "Start over" button carries had already fallen behind the page twice: `ALERTS_KEY`
 * and `AREA_KEY` were added after it was written and were never added to it, so pressing
 * Start over left the alert bells and the chosen community behind. A prefix cannot fall
 * behind — a key added tomorrow is deleted tomorrow without anyone remembering.
 */
const STORE_PREFIX = 'aircraft_';
/**
 * The cookie gate's own two keys. `consent.ts` owns them and holds the same names, but it
 * is compiled as a separate script for the page and is not a module this file can import
 * from, so the names are repeated here deliberately.
 *
 * 🔴 DELETING THEM CAN ONLY EVER REDUCE WHAT LEAVES THE BROWSER. With no answer on file
 * the gate loads no tag at all until the reader answers again — so the moment after a
 * wipe is a moment in which nothing is sent, whatever the reader had said before.
 */
const CONSENT_KEYS = ['analytics_consent', 'ga_opt_out'];
/**
 * 🔴 THE PAGE ASKS A VOLUNTEER FEED, SO IT ASKS AS LITTLE AS IT CAN.
 *
 * George was shown this on 20 Sep 2026:
 *
 *   "The feed asked us to slow down (HTTP 429). It is volunteer-funded and answers
 *    a limited number of requests per minute, and this page asks again every ten
 *    seconds."
 *
 * That sentence was honest and the behaviour behind it was not. Measured against
 * api.adsb.lol the same day, with a named user agent: **ten requests three seconds
 * apart, ten one second apart, and eight two seconds apart were refused with 429
 * from the third or fourth request on** — so ten seconds was far too fast, and a
 * page that keeps asking is a page that keeps itself refused.
 *
 * So the cadence is ADAPTIVE now, and it starts slower than it used to:
 *
 *   · it begins at 20 seconds, not 10;
 *   · a success buys back speed, but never below 15;
 *   · a 429 doubles it, up to three minutes, and it recovers on its own;
 *   · and it STOPS ENTIRELY while the tab is in the background.
 *
 * That last one matters most: a tab nobody is looking at was spending the whole
 * allowance, and the reader who came back to it found a rate limit.
 */
const POLL_START_MS = 20_000;
const POLL_MIN_MS = 15_000;
const POLL_MAX_MS = 180_000;

/**
 * How many maker chips the row carries, and the key the remainder is filed under.
 *
 * 🔴 TEN, MEASURED RATHER THAN CHOSEN. On this site's own list, 50 distinct words open the 245 names it
 * can print — Cessna with 30 types down to Kaman with 1 — so a chip per word is four rows of chips on a
 * panel George has already called cluttered once. The ten with the most types are the ones a reader
 * arrives looking for, and everything else stays reachable through `Other`, which is a chip rather than a
 * silence.
 *
 * 🔴 AND `MAKER_OTHER` IS NOT THE WORD "Other". It is the key the filter compares against, and a maker's
 * own name is what the other keys hold — so this is deliberately a string no name in the table could be
 * (`*` is not how any manufacturer begins), and one that survives being written into an attribute and
 * read back by a selector.
 */
const MAKER_CHIPS = 10;
const MAKER_OTHER = '*other';

/**
 * 🔴 KILOMETRES, NOT NAUTICAL MILES. George, 20 Sep 2026: *"nobody understand
 * nm"*. The feed takes nautical miles and says so in its own endpoint summary
 * (*"Aircrafts surrounding a point (lat, lon) up to 250nm"*), so the conversion
 * happens in `kmToNm` and the reader never meets the unit.
 */
/**
 * 🔴 THE DISTANCE STOPS ARE GEORGE'S OWN NUMBERS, AND THE RULE THEY KEEP IS THE RATIO.
 *
 * George, 20 Sep 2026: *"How far out from you? maybe this should be a slider? logrythmic?"* — then,
 * 22 Sep 2026: *"i forgot the slider is actually a filter for pic an aircraf. lets remove the slider and
 * ask the distance about the pick an aircraf under kind"*, and in the same message *"make the option
 * logrythmic"* and *"thse 4 filters are getting cluttery"*. **He named the stops himself at the end of
 * that same day:** *"distance can be logrythmic starting at 25, 50, 75, 100, 150, 200, 400"* — which
 * replaced the six doubling stops (5 · 10 · 20 · 40 · 80 · 160) this file had carried until then.
 *
 * 🔴 AND IT IS NOT A DOUBLING LADDER, SO NEITHER THE CODE NOR THE TEST MAY PRETEND IT IS. What makes a
 * scale readable is the RATIO between neighbours: **never more than double**, because a stop further
 * than twice the one before leaves a middle the reader cannot choose — and never so close that two chips
 * answer the same question. His steps run ×2, ×1.5, ×1.33, ×1.5, ×1.33, ×2: every one inside that rule,
 * with the widest steps at the two ends, which is where a scale can afford them.
 *
 * The range covers what this page is good at: 25 km is the airport and the neighbourhood around it, and
 * 400 km is as wide as a numbered fence can be before a poll every half minute stops meaning anything.
 */
const RADIUS_LADDER = [25, 50, 75, 100, 150, 200, 400];

/**
 * 🔴 AND THE DISTANCE A READER STARTS ON IS 50 KM — ONE OF THE STOPS ABOVE, NEVER A NUMBER OF ITS OWN.
 *
 * George, 22 Sep 2026: *"i want the default Distance to be 50km"*. It is a named constant rather than
 * the literal `50` written into the field twice, because the default has to BE a stop: a default that
 * is not on the ladder would light no chip, and `currentRadius()` — which snaps whatever is stored to
 * the nearest stop — would then quietly answer a different question from the one the reader sees.
 *
 * *Prior value, preserved and now dead:* the starting distance was `RADIUS_ALL`, on his own instruction
 * that day — *"at the begining of distance, default select all"*. `All` is still the widest fence the
 * feed serves and is still the last chip; it is simply no longer what an unasked reader is given.
 */
const RADIUS_DEFAULT = 50;

/**
 * 🔴 `All` IS THE WIDEST FENCE THE FEED WILL SERVE — AND IT IS NO LONGER WHAT A READER STARTS ON.
 *
 * *Prior wording, preserved and now dead:* *"AND IT IS THE ONE A READER STARTS ON … So the row opens with
 * `All`, the chip a reader who has chosen nothing is standing on, and it is what the page asks the feed
 * for until somebody says otherwise."* **George changed the start on 22 Sep 2026: *"i want the default
 * Distance to be 50km"*** — so a reader who has chosen nothing is given `RADIUS_DEFAULT`, and `All` is a
 * stop they can press rather than the one they begin on.
 *
 * 🔴 463 km IS 250 NAUTICAL MILES, WHICH IS THE FEED'S OWN CEILING AND NOT A NUMBER OF MINE. Its endpoint
 * summary says it out loud — *"Aircrafts surrounding a point (lat, lon) up to 250nm"* — and `kmToNm(463)`
 * is exactly 250 at the conversion the rest of the page uses. A larger number would be one this page
 * printed and the feed quietly ignored, which is the sort of polite lie the rest of this file refuses.
 *
 * ⚠️ AND THE COST IS STATED RATHER THAN HIDDEN. A fence this wide asks a VOLUNTEER feed for a quarter of
 * a continent every twenty seconds and returns hundreds of aircraft, where 25 km returns a handful. The
 * cadence backs off on a refusal (see `POLL_START_MS`), so it degrades rather than breaks — but this is
 * the heaviest thing a reader can ask for, and it is why the numbered stops sit beside it.
 */
const RADIUS_ALL = 463;

/** Every distance the row offers, in the order it offers them: `All` first, then the numbered stops. */
const RADIUS_CHOICES = [RADIUS_ALL, ...RADIUS_LADDER];


/**
 * 🔴 AN ERA IS A FILTER A READER ACTUALLY REACHES FOR. George, 20 Sep 2026: *"i
 * want you to know the year each aircraft was made so it helps you filter more"*.
 *
 * Four choices, not eight. 1970 and 2000 are the two lines that mean something to
 * somebody looking at a screen full of type codes — the jet age arriving in
 * earnest, and the generation being built now — and a longer list of them would be
 * a taxonomy rather than a filter.
 *
 * 🔴 THE YEAR IS THE TYPE'S, NOT THE AIRFRAME'S, and every label says "first
 * flown" rather than "built" for that reason. Nothing free publishes a build year
 * per airframe: measured 20 Sep 2026, the feed's own 617,361-row airframe database
 * has no year field, hexdb.io returns owner and type but no year, and the
 * planespotters photo API returns photographs and no year.
 */
type EraKey = 'all' | 'before1970' | '1970to1999' | 'since2000';

const ERAS: { key: EraKey; label: string; from: number; to: number }[] = [
  // 🔴 SHORT TOO, UNDER ITS OWN LABEL. The row is labelled "First flown", so a chip reading
  // "first flown before 1970" beside it would be the phrase the label just removed. George
  // asked for this on the last-seen row (*"a label instead of saying last seen mnay times"*)
  // and the same reasoning applies here word for word.
  { key: 'all', label: 'Any year', from: 0, to: 9999 },
  { key: 'before1970', label: 'before 1970', from: 0, to: 1969 },
  { key: '1970to1999', label: '1970–1999', from: 1970, to: 1999 },
  { key: 'since2000', label: '2000 or later', from: 2000, to: 9999 },
];

/**
 * 🔴 AND THE FILTER THAT MAKES THE LIST WORTH READING: WHEN WAS IT LAST SEEN.
 *
 * George, 20 Sep 2026: *"the list should also by filtered by last seen. the goal is
 * to alert people when their selected aircrafts are in the air around them. so
 * something that is never going to fly soon is a useless selection"*.
 *
 * He is right, and it is the sharpest thing that has been asked of this page. A list
 * of types that have EVER flown near you is a list of the past; what somebody needs
 * before they star a type is how likely it is to be up there tomorrow. The survey now
 * carries `lastSeen` per type, merged across every run, so the answer improves every
 * time it is re-run — and the list opens NARROWED, because a filter nobody presses
 * does not stop anybody picking something dead.
 */
type SeenKey = 'all' | 'fiveMin' | 'hour' | 'halfDay' | 'today' | 'week' | 'month' | 'quarter' | 'year' | 'noData';

/**
 * What a window asks, which is not the same as how wide it is.
 *
 * 🔴 `noData` IS THE ONE THAT IS NOT A WINDOW AT ALL, AND IT IS THE OPPOSITE OF ONE. George,
 * 20 Sep 2026: *"for last seen, add option for not data"*. Every other choice keeps types that
 * HAVE a sighting on record; this one keeps the types that have none. It is the answer to
 * "what is this site unable to say anything about", which no date filter can express — a type
 * with no date is dropped by all of them, including "All flights" on a `lastSeen` basis, and
 * before this it could only be seen by accident.
 */
type SeenMode = 'all' | 'rolling' | 'calendar' | 'noData';

interface SeenChoice {
  key: SeenKey;
  /** 🔴 SHORT, BECAUSE THE ROW SAYS "Last seen" ONCE — see the note on SEEN_CHOICES. */
  label: string;
  /**
   * The window in a sentence, when the chip's own words do not read there.
   *
   * 🔴 MEASURED, NOT GUESSED. The first cut put the chip label straight into the sentence and
   * it printed *"within last hour of right now"* and *"within last 12 hours of right now"* —
   * the label is written for a chip, where "last hour" sits under the words "Last seen", and
   * it needs its article the moment it stands alone. `5 minutes` needed the same: "within 5
   * minutes of right now" is a different claim from "within THE last 5 minutes".
   */
  phrase?: string;
  mode: SeenMode;
  /**
   * The earliest moment this window includes, given a "now".
   *
   * Null for `all`, which has no floor, and for `noData`, which is not measured in time at
   * all.
   */
  since: ((now: Date) => Date) | null;
}

/**
 * 🔴 THE EIGHT CHOICES, SHORT, UNDER ONE LABEL. George, 20 Sep 2026: *"i want a label instead
 * of saying last seen mnay times, and i want 5 minutes, last hour, last 12 hours"*.
 *
 * Every chip used to carry the phrase itself — "Last seen today", "Last seen this week" —
 * so the row said "last seen" six times and the words the reader actually needs to tell apart
 * were buried at the end of each. The row is labelled **Last seen** once now, and each chip is
 * just the window. The same treatment went to the year row, which repeated "first flown" on
 * every chip: with a label saying so, *"first flown before 1970"* beside a label reading
 * *"First flown"* would be the repetition back again.
 *
 * The three short windows are counted IN MINUTES FROM NOW rather than from a calendar
 * boundary — "5 minutes" means the last five minutes, and there is no way to read that as
 * anything else. `today`, `this week` and the rest are the opposite: they are the period the
 * reader is living in, and the sentence under the chips prints the exact moment each one
 * starts so the difference is never left to inference.
 *
 * The order runs narrow to wide, after "All flights" — which is the absence of a window and
 * belongs first, where the default sits.
 *
 * 🔴 AND TWO WERE TAKEN OUT. George, 22 Sep 2026: *"for last seen remove no data and remove 12
 * hours"*. `last 12 hours` sat between `last hour` and `today` and was the window nobody picked —
 * twelve hours straddles a night, so it answers a question neither of its neighbours does.
 * `no data` was not part of the time scale at all: it answered *"which types has the record never
 * caught"*, which is a filter about the RECORD rather than about time, and it was the tenth chip on
 * a row that was already wrapping. Its machinery stays in `SeenMode` and in the list renderer so the
 * choice can come back if it is wanted, but nothing offers it, so that branch is unreachable by
 * design rather than by accident.
 */
const SEEN_CHOICES: SeenChoice[] = [
  { key: 'all', label: 'All flights', mode: 'all', since: null },
  { key: 'fiveMin', label: '5 minutes', phrase: 'the last 5 minutes', mode: 'rolling', since: (now) => rolling(now, 5 * 60_000) },
  { key: 'hour', label: 'last hour', phrase: 'the last hour', mode: 'rolling', since: (now) => rolling(now, 60 * 60_000) },
  { key: 'today', label: 'today', mode: 'calendar', since: (now) => startOfDay(now) },
  { key: 'week', label: 'this week', mode: 'calendar', since: (now) => startOfWeek(now) },
  { key: 'month', label: 'this month', mode: 'calendar', since: (now) => startOfMonth(now) },
  { key: 'quarter', label: 'this quarter', mode: 'calendar', since: (now) => startOfQuarter(now) },
  { key: 'year', label: 'this year', mode: 'calendar', since: (now) => startOfYear(now) },
];

/**
 * 🔴 IT OPENS ON "ALL FLIGHTS". George's list puts it first, and it is the honest default on
 * a list this short: with six rounds of history a window hides most of what has been
 * measured, and a reader arriving at the page should see what the feed has found before
 * being handed a filter they did not ask for.
 */
const SEEN_DEFAULT: SeenKey = 'all';

/** One measured type, as tools/survey-types.mjs writes it. */
interface SurveyedType {
  code: string;
  seen: number;
  airports: string[];
  operators: string[];
  /** Tail numbers this type actually transmitted, most widely seen first. */
  registrations?: { reg: string; airports: string[] }[];
  /** The most recent time this type was seen, across every survey run. ISO. */
  lastSeen?: string | null;
  /** How many survey runs have recorded it. */
  runsSeen?: number;
  /** How many times it was seen in total, across every run. */
  seenInAllRuns?: number;
}

interface TypesDocument {
  generated: string;
  method: string;
  aircraftInspected: number;
  counted: string;
  roundsRefusedByRateLimit?: number;
  /** Said out loud: a registration is only in here if one was transmitted. */
  registrationsNote?: string;
  /**
   * 🔴 HOW MUCH HISTORY STANDS BEHIND "LAST SEEN", AND IT IS READ, NOT GUESSED.
   * `runsRecorded` is the number of looks at the sky the database holds, and the two
   * dates bound them. The filter needs the count to decide what "often" means, and the
   * page needs the span to know whether a calendar window could change anything — see
   * the note on SeenChoice.
   */
  runsRecorded?: number;
  historyFrom?: string;
  historyTo?: string;
  historyNote?: string;
  types: SurveyedType[];
}

/** One type's first flight, as tools/survey-years.mjs measured it from Wikidata. */
interface YearEntry {
  year: number;
  /** `first flight`, or `service entry` when that was the only dated fact. */
  basis: string;
  item: string;
  /** The label of the item that answered — which may be the family, not the variant. */
  name: string;
  /** The string that was searched for. */
  asked: string;
  /** True when the item's label was exactly the name the type table gives. */
  exact: boolean;
}

interface YearsDocument {
  generated: string;
  source: string;
  method: string;
  acceptance: string;
  /** What the year is a year OF — repeated on the page, never left in the file. */
  scope: string;
  asked: number;
  resolved: number;
  unmatched: string[];
  years: Record<string, YearEntry>;
}

/** One airport, as tools/verify-airports.mjs writes it after asking the feed. */
interface ListedAirport {
  icao: string;
  iata?: string;
  name: string;
  location: string;
  country?: string;
  lat: number;
  lon: number;
  elevationFt: number | null;
}

interface AirportsDocument {
  generated: string;
  covers: string;
  method: string;
  kept: number;
  dropped: string[];
  airports: ListedAirport[];
}

/** An airport with how far it is from the reader. */
interface NearbyAirport {
  airport: ListedAirport;
  km: number;
}

/**
 * 🔴 THERE IS NO SCHEDULE PANEL, AND SO THERE IS NO TYPE FOR ONE. George, 22 Sep 2026, pasting the
 * whole section back: *"remove this section, if these plans show up then they show up"*.
 *
 * He is right, and it is the same reasoning that took the departures board off the page: a SCHEDULE is a
 * promise about the future, and this page only ever knows the past. The panel listed a museum, the eight
 * aircraft it keeps, and the days it intends to fly them — and then, in the same breath, admitted that one
 * of the eight had never once been reported by the feed. A reader had to hold both halves at once and work
 * out which one applied to them.
 *
 * What survives is what was measured: a type the feed has actually seen. If the Lancaster goes up and
 * transmits, it arrives in the table like any other aeroplane — which is the whole of the promise, and the
 * only one this page can keep.
 *
 * `HistoricDocument`, `HistoricSite` and `HistoricAircraft` were deleted with it. The collector that fills
 * the database (`tools/load-historic.mjs`, on `aircraft-historic.timer`) is deliberately untouched: it
 * gathers data, it is not the section, and nothing on the page depends on it either way.
 */

/**
 * One place name, with the list of communities in brackets cut off.
 *
 * `"Hamilton (Confederation Park / … / North Stoney Creek)"` becomes `"Hamilton"`, and a
 * name without brackets is returned unchanged. George, 20 Sep 2026: *"Your location just
 * make it say the city name, not the others in ()"*.
 *
 * It is applied to EVERY string that reaches the screen from a place lookup — the label
 * under "Your location", the heading above the airport list, and anything restored from a
 * browser that saved the uncleaned version. A rule applied in one of those places and not
 * the others is exactly how the same string ends up printed twice in two different shapes
 * on one card, which is what he was looking at when he reported it.
 */
function stripBrackets(value: string): string {
  return String(value ?? '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** One freely-licensed photograph of a type, with the credit its licence requires. */
interface PhotoEntry {
  code: string;
  name: string;
  title: string;
  src: string;
  /** False when the search match was weak — see the note in thumbHtml(). */
  confident: boolean;
  reason: string;
  artist: string;
  licence: string;
  creditPage: string;
}

/**
 * Web Mercator, the arithmetic every slippy map is built on.
 *
 * `lonToTile` and `latToTile` return a position in TILES — fractional, not whole
 * numbers — and multiplying by 256 turns that into pixels at that zoom. Latitude
 * is the one that surprises people: it is not linear, because the projection
 * stretches towards the poles, which is why the same code that puts Hamilton in
 * the right place would put Iqaluit in the wrong one.
 */
function lonToTile(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 2 ** zoom;
}

function latToTile(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom;
}

/**
 * 🔴 HOW MUCH HEIGHT COUNTS AS A CLIMB, AND THE TWO NUMBERS ARE MEASURED RATHER THAN PICKED.
 *
 * The trail is one point per poll, and the poll runs from 15 seconds to three minutes — so the gap
 * between two points is a real slice of flying, not a second of it. A jet climbing at the 2,000
 * ft/min a departure out of Hamilton holds would gain about 660 feet in a 20-second gap; a level
 * cruise wanders by a few tens of feet as the pressure altitude is re-read.
 *
 * `TRAIL_LEVEL_FT` therefore puts the "level" band well above the wander and well below a real
 * climb, so a cruise is not painted as a climb and a climb is not painted as a cruise.
 * `RATE_LEVEL_FPM` does the same job for the fallback, which reads the aircraft's reported rate of
 * climb instead of the difference between two points.
 */
const TRAIL_LEVEL_FT = 100;
const RATE_LEVEL_FPM = 200;

/**
 * Which of the four hues one segment of a flight path gets.
 *
 * `unknown` is a real answer and not a failure: it means the reading carried no altitude to compare
 * (or the trail predates the field), and the page draws it dashed and says so in the key rather
 * than colouring it as "level" — which would be an assertion nobody made.
 */
function climbHue(
  from: number | null,
  to: number | null,
  current: number | undefined
): 'climb' | 'descend' | 'level' | 'unknown' {
  if (from !== null && to !== null) {
    const delta = to - from;
    if (delta >= TRAIL_LEVEL_FT) return 'climb';
    if (delta <= -TRAIL_LEVEL_FT) return 'descend';
    return 'level';
  }
  // No altitudes on the points themselves — the aircraft's own reported rate is the honest
  // fallback, and it describes the whole path it is drawing rather than inventing a profile.
  if (typeof current === 'number') {
    if (current >= RATE_LEVEL_FPM) return 'climb';
    if (current <= -RATE_LEVEL_FPM) return 'descend';
    return 'level';
  }
  return 'unknown';
}

interface FeedResponse {
  ac?: Reading[];
  now?: number;
  total?: number;
}

/**
 * 🔴 READ EVERY RESPONSE AS TEXT, THEN PARSE IT DELIBERATELY.
 *
 * `await response.json()` trusts the other end to be the feed. The moment
 * anything answers in front of it — a proxy, an edge error page, a maintenance
 * notice — the reader gets a JavaScript parser complaint in place of the
 * sentence that was written for them. This is not hypothetical: it is exactly
 * what happened on rag-demo on 19 Sep 2026, where the server sent a careful
 * explanation as JSON with status 502 and Cloudflare replaced the body with its
 * own HTML page, so the page reported `Unexpected token '<'`.
 *
 * The matching rule on the server side is in worker/index.js: never answer 502
 * from behind Cloudflare, because the edge deletes the body. 503 is passed
 * through.
 */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // expected: nothing is swallowed here — this re-throws, carrying the shape that
    // went wrong, and the caller is the one that judges whether it is a fault.
    const kind = (response.headers.get('content-type') ?? 'no content type').split(';')[0];
    throw new Error(
      `The feed answered ${response.status} with ${kind} instead of JSON` +
        (/^\s*<(!doctype|html)/i.test(text)
          ? ' — that is a web page, so something in front of the feed answered instead of the feed'
          : '') +
        `. ` +
        text.slice(0, 120).replace(/\s+/g, ' ').trim()
    );
  }
}

/**
 * 🔴 THE STAR, AND THE THREE THINGS IT SAYS. George, 20 Sep 2026: *"instead of
 * favority this, use a start icon"*. One control, and its shape carries the
 * state: outlined means the whole type is NOT favourited, filled means it is, and
 * a narrowed type — one watched by particular tail numbers rather than as a whole
 * — shows outlined with a dot, because it is not the whole type and must not
 * claim to be.
 *
 * The words did not disappear; they moved into the title and the accessible name,
 * so a screen reader still hears "Favourite this type" and a sighted reader
 * gets the glance.
 */
const STAR_PATH = 'M12 2.7l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.6l-5.8 3.05L7.3 14.15 2.6 9.55l6.5-.95z';

/**
 * 🔴 THE STAR GOES BEFORE THE TEXT, EVERYWHERE IT APPEARS IN SOMETHING.
 *
 * George, 20 Sep 2026: *"when a star is placed inside anything it should precede
 * the text"*. A mark that follows its own label reads as punctuation; one that
 * leads it reads as a state the thing is in. So this is one drawing, named for the
 * mark rather than for where it first appeared, and it is always written first.
 */
const MARK_STAR = `<svg class="mark-star" viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>`;

/**
 * The way out of a rule, drawn rather than typed.
 *
 * George, 22 Sep 2026: *"use an icon instead for the ✕"*. The glyph `✕` is a character in whatever font
 * happens to be installed, so it arrives at that font's weight, its width and its baseline — it sat heavier
 * than every other mark on the page and changed shape from one machine to the next, which is a lot of
 * variance for the control that removes something.
 *
 * A stroked cross in the same 24-unit box as the star and the aeroplane is the same mark everywhere. It is
 * drawn with `currentColor`, so it still takes the colour its row gives it, and the button keeps its own
 * `aria-label`, so a screen reader loses nothing to the glyph going away.
 */
const CROSS_PATH = 'M6 6 L18 18 M18 6 L6 18';
const MARK_CROSS =
  `<svg class="mark-cross" viewBox="0 0 24 24" aria-hidden="true"><path d="${CROSS_PATH}"/></svg>`;

/**
 * A top-down aeroplane, drawn on the map mark instead of a dot.
 *
 * George, 21 Sep 2026: *"in the map, i want to see the images of the plane and the aircraft type,
 * then the tail"*. A dot says "something is here"; a shape of an aeroplane says what the reader is
 * looking at without having to read the label to find out. Drawn in a 24-unit box so it can be
 * scaled to any marker size, and shaped nose-up so no rotation arithmetic is needed.
 */
const PLANE_PATH =
  'M12 2 L13.6 2.4 L14.4 9 L21 12.4 L21 14.2 L14.4 13.2 L14.2 18 L16.6 19.4 L16.6 20.6 ' +
  'L12 19.6 L7.4 20.6 L7.4 19.4 L9.8 18 L9.6 13.2 L3 14.2 L3 12.4 L9.6 9 L10.4 2.4 Z';

function starButton(code: string, wholeType: boolean, narrowed: boolean): string {
  const label = wholeType ? 'Favourited — remove' : narrowed ? 'Favourite the whole type' : 'Favourite this type';
  return (
    `<button type="button" class="star type-toggle${narrowed ? ' star-part' : ''}" ` +
    `data-type="${escapeHtml(code)}" aria-pressed="${wholeType}" ` +
    `title="${label}" aria-label="${label}" data-ga="type-favourite">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg></button>`
  );
}

/** A bell, drawn in the same 24-unit box as the star so they line up on a row. */
const BELL_PATH =
  'M12 2.6a5.6 5.6 0 0 0-5.6 5.6v3.2l-1.5 2.6a1 1 0 0 0 .87 1.5h12.46a1 1 0 0 0 .87-1.5l-1.5-2.6V8.2A5.6 5.6 0 0 0 12 2.6Zm0 18.8a2.6 2.6 0 0 0 2.45-1.8h-4.9A2.6 2.6 0 0 0 12 21.4Z';

/**
 * 🔴 THE BELL IS A SECOND QUESTION, NOT A LOUDER ANSWER TO THE FIRST. George, 20 Sep 2026:
 * *"i should be able to select from the list w3hich ones i want an alert for"*.
 *
 * The star says *show me this*; the bell says *tell me when this one goes*. Starring a type to
 * watch it in the table used to arm a phone notification as a side effect, so a reader who
 * starred a dozen things got a dozen alerts they never asked for, and a reader who wanted to
 * be told about exactly one aircraft had no way to say so. Two marks, two lists.
 *
 * The wording is deliberate on every state, because this is the control that decides whether a
 * phone makes a noise:
 *   - never armed → "Alert me about this type"
 *   - armed for the whole type → "Alerting — turn off"
 *   - armed for some tails only → "Alerting for the tail numbers you picked"
 */
function bellButton(code: string, wholeType: boolean, narrowed: boolean): string {
  const label = wholeType
    ? 'Alerting for this type — turn off'
    : narrowed
      ? 'Alerting for the tail numbers you picked — press to alert for the whole type'
      : 'Alert me about this type';
  return (
    `<button type="button" class="bell alert-toggle${narrowed ? ' bell-part' : ''}" ` +
    `data-type="${escapeHtml(code)}" aria-pressed="${wholeType || narrowed}" ` +
    `title="${label}" aria-label="${label}" data-ga="type-alert">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${BELL_PATH}"/></svg></button>`
  );
}

/**
 * Read one rule list out of storage.
 *
 * 🔴 ONE READER FOR BOTH LISTS, FOR THE SAME REASON THERE IS ONE MATCHER. The star and the
 * bell hold the same shape, and two copies of the parser is how a tail number survives a
 * reload in one list and not the other — which would look like the alert forgetting what it was
 * told, intermittently and only after a refresh.
 */
function readRules(key: string): TypeRule[] {
  try {
    const raw = JSON.parse(readStore(key, '[]'));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((rule) => rule && typeof rule.type === 'string' && rule.type.trim() !== '')
      .map((rule) => ({
        type: String(rule.type).trim().toUpperCase(),
        tails: Array.isArray(rule.tails) ? rule.tails.filter((tail: unknown) => typeof tail === 'string') : [],
      }));
  } catch {
    // expected: rules that will not parse mean no rules, not a broken page. The
    // reader keeps the defaults and loses nothing they had.
    return [];
  }
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/**
 * 🔴 A CAUGHT ERROR IS INVISIBLE TO THE FAULT REPORTER UNLESS THE CATCH SENDS IT.
 *
 * George, 23 September 2026, verbatim: ***"if you have any try/catch rollbar wont get it
 * unless to invoke the catch err and send to rollbar."*** The reporter hooks `error` and
 * `unhandledrejection` — an error that ESCAPED — and nothing else. Everything inside a
 * `try`/`catch` has already been caught by the time anybody could be told, so **the only
 * way a caught fault reaches the project is for the catch to say so.**
 *
 * Two forms, and every catch in this file uses one of them:
 *
 *     reportFault(error, 'reading the feed');        // this is a fault — send it
 *     // expected: private mode refuses to store; the visit still works
 *
 * **A catch that does neither fails `npm test`.** The thing being guarded against is a
 * catch added six months from now that quietly swallows something, and that cannot be
 * guarded by a convention — a gate is the only instrument that fires at the moment of
 * the work rather than at the end of it.
 *
 * ⚠️ NOT EVERY CATCH IS A FAULT, AND SENDING THEM ALL WOULD BE WORSE THAN SENDING NONE.
 * A reader in private mode, a corrupt value in this browser's own storage, a free map
 * service with no name for a field — those are answers, not breaks, and an item list
 * full of them is an item list nobody reads. The test for a fault is not "did something
 * throw" but **"is somebody going to have to fix this"**.
 */
function reportFault(error: unknown, where: string): void {
  window.aircraftFault?.(error, where);
}

function readStore(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    // expected: storage switched off is not a fault — the fallback IS the answer.
    return fallback;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // expected: private mode refuses to store. The visit still works, it just does not
    // survive a reload — which is the honest outcome, and what the policy says.
  }
}

/**
 * Every key in this browser that this page is responsible for, FOUND rather than listed.
 *
 * `includeConsent` is the one thing the two wipes disagree about, and the disagreement is
 * the point of them: "Start over" is a way to get a clean page, so it leaves the reader's
 * cookie answer alone; "delete my data" is the reader asking for all of it gone, so that
 * one takes the cookie answer too.
 */
function storedKeys(includeConsent: boolean): string[] {
  const found: string[] = [];
  try {
    for (let at = 0; at < localStorage.length; at += 1) {
      const key = localStorage.key(at);
      if (key === null) continue;
      if (key.startsWith(STORE_PREFIX) || (includeConsent && CONSENT_KEYS.includes(key))) {
        found.push(key);
      }
    }
  } catch {
    // expected: private mode has nothing stored, so there is nothing to find.
  }
  return found;
}

/** Drop one key, for the places that clear a single setting rather than all of them.
 *
 * A browser in private mode refuses to remove as well as to store, and that is not an error worth
 * reporting: the setting simply lasts as long as the visit, which is the honest outcome. */
function dropStore(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // expected: private mode refuses to remove as well as to store, and the page
    // carries on as a first visit either way.
  }
}

/** Drop every key this page owns — the place, the distance, the airports, the types, the
 * alerts, the tails, and all four filters — so the page comes back as a first visit. */
function forgetStored(includeConsent: boolean): void {
  for (const key of storedKeys(includeConsent)) dropStore(key);
}

/**
 * The starts of the calendar windows the "last seen" filter measures against.
 *
 * All five are LOCAL time, because the question "has it been up today?" is asked in the
 * reader's own day and not in UTC. Each returns the first instant of the period, so a
 * comparison is a plain `>=`.
 *
 * The week starts on **Monday**, which is the Canadian convention and matches what a
 * calendar on the wall shows.
 */
function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfWeek(now: Date): Date {
  const day = startOfDay(now);
  // getDay() is 0 for Sunday; Monday is wanted, so Sunday is six days in and not minus one.
  const back = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - back);
}

function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function startOfQuarter(now: Date): Date {
  return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
}

function startOfYear(now: Date): Date {
  return new Date(now.getFullYear(), 0, 1);
}

/**
 * A window counted back from this moment, rather than from a calendar boundary.
 *
 * `rolling(now, 5 * 60_000)` is "the last five minutes". It is a different kind of answer
 * from `startOfDay` — that one is the day the reader is living in, this one is a stopwatch —
 * and the sentence under the chips says which is running.
 */
function rolling(now: Date, ms: number): Date {
  return new Date(now.getTime() - ms);
}

/** "Fri 18 Sep, 00:00" — the moment a window opens, for the sentence under the chips. */
function formatWindowStart(at: Date): string {
  return at.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}


function track(name: string, params: Record<string, unknown> = {}): void {
  if (typeof window.aircraftTrack === 'function') window.aircraftTrack(name, params);
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * How long ago, in the shortest form that is still precise where it matters.
 *
 * 🔴 THE FIRST MINUTE IS COUNTED IN SECONDS, BECAUSE THAT IS THE ONE THAT IS READ. George,
 * 20 Sep 2026: *"last reading should include fromnow()"*. A live feed is judged by whether
 * it is still moving, and "a minute ago" flattens the difference between a reading taken two
 * seconds ago and one taken fifty-nine seconds ago — which is the whole range over which a
 * reader decides whether the page has stalled.
 *
 * Past an hour the seconds stop mattering and the answer is rounded to the unit a person
 * would say out loud. It is never shown as a bare number with no unit.
 */
function fromNow(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

class Page {
  /**
   * 🔴 MORE THAN ONE AIRPORT, BECAUSE A READER USUALLY CARES ABOUT MORE THAN ONE.
   * George, 20 Sep 2026: *"i should also be able to select multiple airport. if i
   * select multiple, make sure all are viewable in the maps"*.
   *
   * It is a LIST and not a single slot. Before this, picking a second airport
   * silently dropped the first — so there was no way to watch Hamilton and Toronto
   * at once, which is the ordinary thing to want when you live between them.
   */
  private airports: ResolvedAirport[] = [];

  /**
   * The first airport picked, for the places with room for only one.
   *
   * 🔴 IT IS THE FIRST PICKED, NOT THE ALPHABETICALLY FIRST. The airport somebody
   * chose first is the one they came for, so it keeps the heading, the centre of
   * the radar and the notification rather than being displaced by a code that
   * happens to sort earlier.
   */
  private get airport(): ResolvedAirport | null {
    return this.airports[0] ?? null;
  }

  private isChosen(icao: string): boolean {
    return this.airports.some((one) => one.icao === icao);
  }

  /**
   * An airport the page already holds, from the map's own list or the one beside it.
   * Nothing here costs a request to the feed.
   */
  private findListed(icao: string): ListedAirport | null {
    const code = icao.toUpperCase();
    const near = this.nearby.find((row) => row.airport.icao === code)?.airport;
    if (near) return near;
    return (this.listedAirports?.airports ?? []).find((one) => one.icao === code) ?? null;
  }

  private chosenIcaos(): string[] {
    return this.airports.map((one) => one.icao);
  }

  /** How to name the airports being watched, where a sentence has room for a few. */
  private airportPhrase(): string {
    const codes = this.chosenIcaos();
    if (codes.length === 0) return 'the airport';
    if (codes.length <= 3) return codes.join(' / ');
    return `${codes.slice(0, 3).join(' / ')} +${codes.length - 3} more`;
  }

  /**
   * 🔴 `airportCentreLabel()` WENT WITH THE RADAR. It named the middle of the top-down drawing
   * ("CYHM / CYKF", or "3 airports"), and that drawing is the card George removed on 22 Sep 2026.
   * `airportPhrase()` above is untouched and still says the same thing everywhere it is read.
   */

  private engine: DetectionEngine | null = null;
  private watchlist: string[] = [];
  private typeRules: TypeRule[] = [];
  /**
   * The types the reader wants an ALERT about — the bell, kept apart from the star's list.
   *
   * George, 20 Sep 2026: *"i should be able to select from the list w3hich ones i want an alert
   * for"*. It used to be that anything starred raised a notification, so the two wishes could
   * not be told apart.
   */
  private alertRules: TypeRule[] = [];
  private timer: number | null = null;
  /**
   * The once-a-second repaint of "· 12s ago" beside each reading.
   *
   * 🔴 SEPARATE FROM THE POLL TIMER, AND DELIBERATELY SO. The table is refreshed when the
   * feed answers, which can be three minutes apart, but a reading's age changes every
   * second — so the age is repainted on its own clock. One timer, started when the table is
   * first drawn, and it writes only the age spans.
   */
  private ageTicker: number | undefined;
  /** How long until the next look at the feed. Moves — see the note on POLL_START_MS. */
  private pollMs = POLL_START_MS;
  /** True while airports are being restored, when the fence is re-aimed only once. */
  private restoring = false;
  /** A pending immediate poll, so three re-aims in one moment are one request. */
  private pollSoon: number | null = null;
  /**
   * The fence in use. A fresh visit starts on **50 km** — `RADIUS_DEFAULT`.
   *
   * George, 22 Sep 2026: *"i want the default Distance to be 50km"*. *Prior wording, preserved and now
   * dead:* *"A fresh visit starts on `All` — `RADIUS_ALL`, the widest the feed serves"*, which was his
   * instruction the same day and is superseded by this one. A reader who has chosen nothing is looking
   * around their own airport rather than at a quarter of the continent, and narrows or widens it by
   * pressing a numbered stop; a value kept from an earlier visit is restored over this, and
   * `currentRadius()` snaps whatever is stored to the nearest chip so a distance from an older ladder
   * still lands on one.
   */
  private radiusKm = RADIUS_DEFAULT;
  private lastPollAt = 0;
  private lastError = '';
  private polls = 0;
  private survey: TypesDocument | null = null;
  /**
   * 🔴 WHETHER THE RECORD HAS BEEN READ — which is NOT the same fact as an empty record, and
   * the two must never share a sentence. `false` means the file is still in flight (or the
   * attempt has not finished); `true` with `survey === null` means it was read and refused.
   * Without this the page said *"not seen yet"* about every type while the record was still
   * arriving, which reads as a fact about an aeroplane and is really a fact about the network.
   */
  private surveyRead = false;

  /**
   * One refresh of the filter results at a time — see `refreshFilterResults`.
   */
  private filterRefreshPending = false;

  /**
   * WHAT THE BOX IS ASKING ABOUT, OR `null`. Set when the question opens and cleared when it closes, so
   * the answer can only ever act on the row that was named in the question the reader just read.
   *
   * See `askRemove` and `bindRemoveAsk`: the question and the deed are deliberately two methods.
   */
  private pendingRemove: { kind: 'type' | 'tail'; key: string } | null = null;

  /**
   * Type codes the feed itself marks as military, harvested by
   * `tools/survey-military.mjs`. Empty if that file could not be read.
   */
  private militaryCodes = new Set<string>();

  /** Photographs and their credits, keyed by type code — see `tools/survey-photos.mjs`. */
  private photos: Record<string, PhotoEntry> = {};

  /** First-flown years, keyed by type code — see `tools/survey-years.mjs`. */
  private yearsDoc: YearsDocument | null = null;
  /** Which era the type list is narrowed to. Not presellected into anything narrower. */
  private eraFilter: EraKey = 'all';
  /** How recently a type must have been seen to stay on the list. */
  private seenFilter: SeenKey = SEEN_DEFAULT;
  /**
   * Where the reader actually is, once they have said. Everything else — the
   * fence, the airports list, the chart — hangs off this rather than off the
   * airport, because the question is what is in the air around THEM.
   */
  private centre: { lat: number; lon: number } | null = null;

  /**
   * The exact markup the position map drew last time, so an identical picture is not rebuilt.
   *
   * It is drawn on every poll and whenever the list changes, and re-injecting a whole tile
   * layer plus its marks to produce the same pixels is work that buys nothing — the kind of
   * cost that shows up as a page which is merely slow everywhere, and is then blamed on
   * whatever was added last.
   */
  private lastPlot = '';

  /** What the reader's place is called, for saying it back to them. */
  private placeLabel = '';
  /**
   * 🔴 WHERE YOU ARE, SAID PROPERLY. George, 20 Sep 2026: *"Your location put the city in
   * highlighted text, you should be able to pinpoint their location a bit better, im in
   * stoney fcreek for example"*.
   *
   * Three parts, because they are three different facts:
   *   placeLabel — what the reader is called, or 'your position'
   *   placeTown  — the town the place belongs to
   *   placeArea  — WHICH community inside that area, once the reader says so
   *
   * The postcode cannot tell us the third; it lists them. So the third is the reader's
   * to give in one tap, and until they do the town is the honest answer.
   */
  private placeTown = '';
  private placeArea = '';
  private placeAreas: string[] = [];

  /** A place read back from storage, applied once the airport list has loaded. */
  private restored: { lat: number; lon: number; label: string; town?: string; areas?: string[] } | null = null;

  /** The airport list the feed itself confirmed, for the "around you" panel. */
  private listedAirports: AirportsDocument | null = null;

  /**
   * The sentence under the airport list once a place is known, kept so it can be put BACK.
   * The list is drawn in two states — with a place and without one — and each needs its own
   * text; holding the place-known one here is what stops the place-unknown one following a
   * reader into the other state.
   */
  private airportsNote = '';
  private nearby: NearbyAirport[] = [];
  // 🔴 THERE IS NO `historic` FIELD, BECAUSE THERE IS NO PANEL TO FILL. See the note where the
  // interfaces used to be.
  /** The raw readings from the last poll — the map is drawn from these. */
  private lastReadings: Reading[] = [];

  /**
   * 🔴 THE ONE AIRCRAFT THE MAP IS ZOOMED TO, BY HEX, OR `null` FOR THE WHOLE FENCE.
   *
   * George, 22 Sep 2026: *"i want to be able to select one of those rows, if i do that i want the map to
   * zoom in to that flight. if slect again, it will unselect and zom back out again. the select and
   * unselected can be a simple green hue border"*. It is a hex rather than a callsign or a row index
   * because the feed can reuse a callsign and the row order changes on every sort — and because the
   * engine's own key for an airframe is the one identifier that survives both.
   *
   * It is cleared when that airframe is no longer on the list (see `renderAircraft`), so a selection can
   * never outlive the flight it describes and leave the map zoomed to nothing.
   */
  private selectedHex: string | null = null;

  /**
   * Whether the reader has moved the distance slider — which is now a record of a CHOICE, not of an
   * answered step.
   *
   * 🔴 IT NO LONGER GATES ANYTHING, AND THAT IS THE WHOLE POINT OF IT NOW. George moved the control
   * on 22 Sep 2026 (*"i want this above the map"*) into step 4, which step 3 unlocks — so a gate of
   * `place && radiusChosen` would have waited on a control inside the card that gate was holding
   * shut. The distance is in use from the start, `updateSteps` gates on the place alone, and this
   * flag is left with the two jobs it can still do honestly: it is `first` on the analytics event
   * for the reader's first move, and it is what the restored radius sets when a kept distance is
   * read back out of storage.
   */
  private radiusChosen = false;
  /** Types the feed showed in THIS session, which may be newer than the survey. */
  private liveTypes = new Map<string, number>();
  private typeFilter: AircraftClass | 'all' = 'all';
  /**
   * Which maker is chosen — `all`, a maker's name, or `MAKER_OTHER` for the remainder.
   *
   * George, 22 Sep 2026: *"add a new category for manufacturer like airbus … other examples are
   * Cessna, Glider etc"*. The values are named by `makerOf` in `typeinfo.ts`, which claims a maker only
   * when the type's own name names one — see the note there for why `Glider` and `Balloon` are not
   * makers.
   */
  private makerFilter: string = 'all';
  /**
   * The makers the row is showing, filled on the first render that has rows, and then held still.
   *
   * 🔴 NULL MEANS NOT BUILT YET, AND IT IS BUILT FROM THE MEASURED LIST RATHER THAN THE FILTERED ONE.
   * Built from the filtered rows the chips would rearrange themselves under the reader's own press, and
   * built before the survey lands there is nothing to count. So it is filled once, when there is
   * something to count, and kept for the session.
   */
  private makerChips: string[] | null = null;

  start(): void {
    this.watchlist = this.loadList(WATCH_KEY);
    this.typeRules = this.loadTypeRules();
    this.alertRules = this.loadAlertRules();

    // 🔴 WHAT WAS KEPT COMES BACK BEFORE ANYTHING IS BUILT FROM IT. The distance
    // buttons read their pressed state from `this.radiusKm`, so restoring after
    // they are built would leave the wrong one lit.
    const keptRadius = Number(readStore(RADIUS_KEY, ''));
    if (Number.isFinite(keptRadius) && keptRadius > 0) {
      this.radiusKm = keptRadius;
      // Step 2 was answered once already, so it is answered now — the sequence
      // resumes where the reader left it instead of collapsing back to step 1.
      this.radiusChosen = true;
    }
    try {
      const kept = JSON.parse(readStore(CENTRE_KEY, 'null')) as { lat?: number; lon?: number; label?: string; town?: string; areas?: string[] } | null;
      if (kept && typeof kept.lat === 'number' && typeof kept.lon === 'number') {
        this.restored = { lat: kept.lat, lon: kept.lon, label: kept.label ?? '', town: kept.town ?? '', areas: Array.isArray(kept.areas) ? kept.areas : [] };
      }
    } catch {
      // expected: a corrupt store is not worth failing over. The reader starts again,
      // and the page says so rather than pretending to have restored something.
      this.restored = null;
    }

    // 🔴 THE FILTER CHOICES COME BACK BEFORE THE ROWS ARE BUILT FROM THEM, for the same reason the
    // distance does: each chip row reads its own pressed state off the value it is about to be given,
    // so restoring afterwards would leave the wrong chip lit and the list filtered by something the
    // reader cannot see is on.
    //
    // ⚠️ EVERY VALUE IS CHECKED AGAINST THE CHOICES THAT EXIST. A setting saved before an option was
    // renamed or removed would otherwise be a filter matching nothing, which reads as a broken page —
    // the same fault the distance snapping and the maker row's fallback both exist to prevent.
    const keptKind = readStore(KIND_KEY, 'all');
    if (keptKind === 'all' || CLASS_ORDER.includes(keptKind as AircraftClass)) {
      this.typeFilter = keptKind as AircraftClass | 'all';
    }
    const keptMaker = readStore(MAKER_KEY, 'all');
    if (keptMaker !== '') this.makerFilter = keptMaker;
    const keptEra = readStore(ERA_KEY, 'all');
    if (ERAS.some((era) => era.key === keptEra)) this.eraFilter = keptEra as EraKey;
    const keptSeen = readStore(SEEN_KEY, '');
    if (SEEN_CHOICES.some((choice) => choice.key === keptSeen)) this.seenFilter = keptSeen as SeenKey;

    this.buildRadiusButtons();
    this.buildTypeFilter();
    this.buildSeenFilter();
    this.renderPlace();
    this.renderWatchlist();
    this.bindNotify();
    this.renderWatchButton();
    this.bindStartOver();
    this.bindForgetMine();
    this.bindRemoveAsk();
    this.bindFlightPick();
    this.bindLocate();
    this.bindChangePlace();
    this.bindVisibility();
    this.bindRefresh();
    this.bindMapResize();

    // 🔴 A COMMA-SEPARATED LIST, BECAUSE SEVERAL CAN BE PICKED NOW. A value written
    // before this change is a single identifier, which splits to a list of one — so
    // a session saved by the older page comes back rather than being discarded.
    //
    // 🔴 AND THE PAGE DOES NOT GIVE ITSELF ONE. George, 22 Sep 2026, after pressing delete my
    // data: *"i delete everything it shgould also remove ### The airports you are watching"*.
    // Every load used to seed `DEFAULT_AIRPORT` when the store was empty, so the page watched
    // Hamilton before the reader had said anything — and a wipe therefore came back with that
    // heading over a chosen Hamilton chip. **A wipe cleared the store and the page refilled the
    // same fact from a constant, which is not a deletion.** Nothing is watched now until the
    // reader chooses it: with none chosen the page asks where they are and offers the airports
    // around that place, and the type list is not filtered while nothing is chosen (the filter
    // only narrows when there IS a choice), so step 3 still holds every type.
    //
    // ⚠️ `DEFAULT_AIRPORT` IS NO LONGER IMPORTED BY THIS FILE, and that is the point rather than
    // an oversight: the constant is a fact about the airport list, not a decision the page is
    // entitled to make on the reader's behalf.
    const saved = readStore(AIRPORT_KEY, '')
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter((code) => /^[A-Z0-9]{3,4}$/.test(code));
    void this.loadChosenAirports(saved);
    void this.loadSurvey();
    void this.loadYears();
    void this.loadMilitary();
    void this.loadPhotos();
    void this.loadAirports();
    // 🔴 `loadHistoric()` IS NOT CALLED ANY MORE, because the schedule panel is gone — see the note
    // where its interfaces used to be. Deleting the panel and leaving the fetch would be the
    // half-removed feature this file has already met once: a reader paying for a file nothing draws.
    this.updateSteps();

    const notice = byId('notifyNote');
    if (notice && !('Notification' in window)) {
      notice.textContent =
        'This browser has no notification support, so there is no way to tell you when one leaves.';
    }
  }

  /* ---------------------------------------------------------------- storing */

  private loadList(key: string): string[] {
    try {
      const raw = JSON.parse(readStore(key, '[]'));
      return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [];
    } catch {
      // expected: a saved list that will not parse is an empty list, not a fault —
      // this is this browser's own storage, and the reader loses only their own old
      // choices.
      return [];
    }
  }

  /**
   * The type rules, tolerantly. A rule with no `tails` array means "every
   * aircraft of this type", and a rule with an empty one means the same thing —
   * so a truncated or hand-edited store degrades to the wider rule rather than to
   * no rule at all, which is the safe direction to fail in.
   */
  private loadTypeRules(): TypeRule[] {
    return readRules(TYPES_KEY);
  }

  private loadAlertRules(): TypeRule[] {
    return readRules(ALERTS_KEY);
  }

  private saveTypeRules(): void {
    writeStore(TYPES_KEY, JSON.stringify(this.typeRules));
    this.engine?.setTypeRules(this.typeRules);
  }

  private saveAlertRules(): void {
    writeStore(ALERTS_KEY, JSON.stringify(this.alertRules));
    this.engine?.setAlertRules(this.alertRules);
    // The button's note counts what is armed, so it has to be redrawn with it.
    this.renderWatchButton();
  }

  private saveWatchlist(): void {
    writeStore(WATCH_KEY, JSON.stringify(this.watchlist));
    this.engine?.setWatchlist(this.watchlist);
  }

  /* ------------------------------------------------------------ the airport */

  /**
   * 🔴 THE DISTANCE IS A CHIP ROW UNDER THE KIND FILTER, NOT A SLIDER ABOVE THE MAP.
   *
   * George, 22 Sep 2026: *"i forgot the slider is actually a filter for pic an aircraf. lets remove the
   * slider and ask the distance about the pick an aircraf under kind"*. He is describing what the
   * control actually does: the distance decides how far out the feed is asked, and therefore which
   * aircraft are on the list at all. It is part of choosing what to watch, so it is asked where the
   * choosing happens.
   *
   * 🔴 AND A CHIP IS BETTER THAN A SLIDER HERE FOR A REASON THAT WAS MEASURED, NOT PREFERRED. A slider
   * is dragged, so it can stop between two stops — and `RADIUS_LADDER[index]` is `undefined` for an
   * index past either end, which blanks the whole map silently (21 Sep 2026: `radiusKm` held `undefined`,
   * every mark landed at NaN, and the caption read *"the undefined km gap you chose"*). A chip cannot
   * do that. It also PRINTS ITS ANSWER — every other choice on this page does, and a reader can see
   * what is available instead of discovering it by dragging.
   *
   * Every press re-aims the fence and re-asks the feed exactly once, which is what a distance changes.
   */
  private buildRadiusButtons(): void {
    const host = byId('radiusButtons');
    if (!host) return;
    host.innerHTML = '';
    for (const km of RADIUS_CHOICES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip chip-small';
      // 🔴 THE WIDEST STOP SAYS `All`, NOT `463 km`. George, 22 Sep 2026: *"at the begining of distance,
      // default select all"* — `All` is the word for "every aircraft the feed can see", and its tooltip
      // carries the number and the unit it came from, so the reader can still find out what it is.
      button.textContent = km === RADIUS_ALL ? 'All' : `${km} km`;
      button.title =
        km === RADIUS_ALL
          ? `Everything the feed can see — its own widest fence, 250 nautical miles (${RADIUS_ALL} km)`
          : `${km} kilometres`;
      button.dataset.km = String(km);
      button.setAttribute('data-ga', 'distance');
      button.setAttribute('aria-pressed', String(km === this.currentRadius()));
      button.addEventListener('click', () => {
        for (const other of host.querySelectorAll('button')) {
          other.setAttribute('aria-pressed', String(other === button));
        }
        this.chooseRadius(km);
      });
      host.append(button);
    }
  }

  /**
   * The distance actually in use, snapped to a chip.
   *
   * 🔴 IT IS SNAPPED BECAUSE A KEPT VALUE CAN BE OFF THE ROW. A distance stored by an earlier version,
   * or a scale that later loses a stop, leaves `radiusKm` holding a number no chip prints — and then no
   * chip is pressed, which reads as "nothing is chosen" while the page is measuring perfectly well.
   * Snapping to the nearest chip means the pressed chip is always the distance in use, and it is why the
   * ladder could be replaced wholesale without an old stored value landing nowhere.
   */
  private currentRadius(): number {
    return RADIUS_CHOICES.reduce(
      (best, km) => (Math.abs(km - this.radiusKm) < Math.abs(best - this.radiusKm) ? km : best),
      RADIUS_CHOICES[0] ?? this.radiusKm
    );
  }

  /**
   * One press of a distance chip: kept, applied, and the feed asked once at the new fence.
   *
   * It used to be two events on a slider — `input` redrew the map locally, `change` re-aimed the fence
   * and fetched — because a drag fires on every pixel and the feed refuses a burst (measured 20 Sep
   * 2026: ten requests three seconds apart were refused with 429 from the third onward). A chip has one
   * event, so there is nothing to debounce and nothing to explain.
   */
  private chooseRadius(km: number): void {
    const first = !this.radiusChosen;
    this.radiusChosen = true;
    this.radiusKm = km;
    // Kept, so a reload does not ask the same question again.
    writeStore(RADIUS_KEY, String(km));
    this.updateSteps();
    // Re-aimed at the distance they actually chose. `point()` already falls back to the airports that
    // are picked, so this is the same point at a new radius rather than a new question.
    this.rearm();
    track('distance_chosen', { km, nm: kmToNm(km), first });
  }

  private buildTypeFilter(): void {
    const host = byId('typeFilter');
    if (!host) return;
    host.innerHTML = '';
    // 🔴 WARPLANES FIRST. George, 20 Sep 2026: *"war plans should be first
    // option"*. It is the one filter somebody arriving at this page is most
    // likely to be looking for — it is the whole reason the class was asked for —
    // so it leads, and "Everything" follows it as the default that is already on.
    // 🔴 EVERYTHING FIRST, WARPLANES LAST. George, 20 Sep 2026: *"everything come
    // before warplane"*. The default belongs at the front, where it is already the
    // pressed one, and the narrowest filter belongs at the end rather than in the
    // reader's way. (The rule earlier the same day was the opposite — that is his
    // to change, and this is what he asked for now.)
    const options: { key: AircraftClass | 'all'; label: string }[] = [
      { key: 'all', label: 'Everything' },
      { key: 'military', label: classLabel('military') },
      ...CLASS_ORDER.filter((klass) => klass !== 'other' && klass !== 'military').map((klass) => ({
        key: klass,
        label: classLabel(klass),
      })),
    ];
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip chip-small';
      button.textContent = option.label;
      button.dataset.kind = option.key;
      button.setAttribute('aria-pressed', String(option.key === this.typeFilter));
      button.addEventListener('click', () => {
        this.typeFilter = option.key;
        // Kept, so a reload does not ask the reader to choose it again.
        writeStore(KIND_KEY, option.key);
        for (const other of host.querySelectorAll('button')) {
          other.setAttribute('aria-pressed', String(other === button));
        }
        this.renderTypeList();
      });
      host.appendChild(button);
    }
  }

  /**
   * The maker row: the makers with the most types, and one chip for everything else.
   *
   * 🔴 THE WHOLE ROW IS DERIVED FROM THE LIST, WHICH IS WHY IT IS BUILT HERE AND NOT IN THE MARKUP.
   * Kind, era and last-seen are fixed sets that can be written down; "who made it" is whatever the
   * measured list happens to contain, and it changes as the survey finds more aeroplanes. A maker the
   * row is not showing is still reachable — through `Other` — and the tooltip says how much that holds
   * rather than leaving the reader to find out by pressing it.
   *
   * 🔴 AND THE CURRENT CHOICE IS CHECKED AGAINST THE NEW ROW. If a maker drops out of the top ten between
   * one build and the next, a filter naming it would match nothing and read as a broken page rather than
   * as a filter — so a choice that is no longer offered falls back to everything.
   */
  private buildMakerFilter(rows: { code: string }[]): void {
    const host = byId('makerFilter');
    if (!host) return;
    const counts = new Map<string, number>();
    for (const row of rows) {
      const maker = makerOf(row.code);
      if (maker === null) continue;
      counts.set(maker, (counts.get(maker) ?? 0) + 1);
    }
    // Most types first, then alphabetically — so two makers with the same count keep a stable order
    // instead of swapping places between builds.
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shown = ranked.slice(0, MAKER_CHIPS).map(([maker]) => maker);
    const held = ranked.slice(0, MAKER_CHIPS).reduce((sum, [, count]) => sum + count, 0);
    const rest = rows.length - held;
    this.makerChips = shown;

    const options: { key: string; label: string; title: string }[] = [
      { key: 'all', label: 'Everything', title: 'Every maker' },
      ...shown.map((maker) => ({ key: maker, label: maker, title: `Only ${maker}` })),
      ...(rest > 0
        ? [
            {
              key: MAKER_OTHER,
              label: 'Other',
              title:
                `${rest} ${rest === 1 ? 'type is' : 'types are'} by a maker with a single type in this ` +
                'list, or by a maker this site cannot name',
            },
          ]
        : []),
    ];
    if (!options.some((option) => option.key === this.makerFilter)) this.makerFilter = 'all';

    host.innerHTML = '';
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip chip-small';
      button.textContent = option.label;
      button.title = option.title;
      button.dataset.maker = option.key;
      button.setAttribute('aria-pressed', String(option.key === this.makerFilter));
      button.addEventListener('click', () => {
        this.makerFilter = option.key;
        writeStore(MAKER_KEY, option.key);
        for (const other of host.querySelectorAll('button')) {
          other.setAttribute('aria-pressed', String(other === button));
        }
        this.renderTypeList();
      });
      host.appendChild(button);
    }
  }

  /**
   * A spinner ON the button whose airport is being looked up.
   *
   * 🔴 AND IT IS CLEARED ON EVERY WAY OUT, not just the happy one. A spinner that
   * outlives its request is worse than no spinner at all: the reader presses the
   * button a second time, the page looks stuck, and the fault is invisible because
   * everything else on the page still works.
   */
  private setBusy(icao: string, on: boolean): void {
    for (const chip of document.querySelectorAll<HTMLElement>(`.chip[data-icao="${icao}"]`)) {
      if (on) chip.setAttribute('aria-busy', 'true');
      else chip.removeAttribute('aria-busy');
    }
  }

  /**
   * 🔴 A RESPONSE THAT IS NOT GOING TO PARSE IS DECIDED BY ITS STATUS, NEVER BY
   * TRYING TO PARSE IT.
   *
   * George, 20 Sep 2026, twice in one day and for two different faults:
   *
   *   "The feed answered 429 with text/html instead of JSON — that is a web page"
   *   "The feed answered 502 with text/html instead of JSON ... <title>502 Bad
   *    Gateway</title> ... nginx"
   *
   * Both sentences were TRUE and both were useless. The first was the feed's rate
   * limit; the second was **adsb.lol's own nginx**, which answers 502 with an HTML
   * page of its own when its backend is unwell — measured 20 Sep 2026, the same
   * endpoint answering 200 minutes later. Neither is anything to do with the
   * reader's connection or with this site, and a message about JSON parsing tells
   * them neither of those things.
   *
   * So the status decides, before the body is touched, and the reader is told which
   * fault they are looking at and what it means.
   */
  private feedTrouble(response: Response): string | null {
    if (response.status === 429) {
      // 🔴 SHORT, ON PURPOSE. George, 23 Sep 2026, looking at the live site: *"maybe i dont want to see
      // this again"*. What he was looking at was **the feed's own nginx page, passed through by the
      // proxy** whenever the isolate held no reading to serve — so the proxy no longer does that (see
      // `refusal()` in worker/index.js) and normally serves a reading with its age instead. What is left
      // here is the sentence for the one case that has nothing to show at all: it names the fault, says
      // there is nothing new yet, and says what happens next. It does not explain our polling to someone
      // who came to look at aeroplanes.
      return (
        'The feed asked us to slow down (HTTP 429). It is a volunteer service and it is refusing this site ' +
        'just now, so there is nothing new to show yet — the page asks every twenty seconds and will slow ' +
        'itself down further, and it will try again shortly.'
      );
    }
    if (response.status >= 500) {
      return (
        `The feed is not answering properly just now (HTTP ${response.status}). That is at their end, not yours ` +
        `and not this site's — api.adsb.lol is a volunteer service, and it fails for a moment and then recovers. ` +
        'The page keeps asking.'
      );
    }
    if (!response.ok) {
      return (
        `The feed answered HTTP ${response.status}. The page keeps asking every twenty seconds, so this may ` +
        'clear on its own.'
      );
    }
    return null;
  }

  /**
   * 🔴 THE PROXY EXPLAINS ITSELF IN JSON, AND ITS SENTENCE WINS OVER THE ONE ABOVE.
   *
   * Since 23 September 2026 a refusal the proxy cannot cover with a reading is answered **in JSON, in this
   * site's own words** — it used to hand the reader the feed's own nginx page — so there is a better
   * sentence available than this file's generic one, and it is the proxy that knows which upstream refused.
   *
   * It is CAPPED, deliberately: an unexpected or runaway message must not fill the status line, so anything
   * longer than a couple of lines is discarded in favour of this page's own copy. A message from a server
   * is still a message from somewhere else, and the status line is this page's to speak in.
   */
  private async proxyMessage(response: Response): Promise<string | null> {
    if (!(response.headers.get('content-type') ?? '').includes('json')) return null;
    try {
      // 🔴 THROUGH `readJson`, LIKE EVERY OTHER RESPONSE ON THIS PAGE — and the static suite checks the
      // BUILT code for a bare `.json()`, because that trusts the other end to be JSON. It is how a reader
      // once got a JavaScript parser complaint where a sentence had been written for them.
      const body = (await readJson(response)) as { error?: unknown };
      const said = typeof body?.error === 'string' ? body.error.trim() : '';
      return said.length > 0 && said.length <= 240 ? said : null;
    } catch {
      // expected: an answer this page cannot read just means no sentence is shown.
      // The reader still gets their whole table, and there is nothing to fix.
      return null;
    }
  }

  /**
   * 🔴 PICKING AN AIRPORT IS A TOGGLE, NOT A SLOT.
   *
   * George, 20 Sep 2026: *"i should also be able to select multiple airport"*.
   * Pressing one that is already picked now unpicks it and the star comes off,
   * which is what a star means everywhere else on this page.
   *
   * 🔴 AND A FAILED LOOKUP NO LONGER UNPICKS ANYTHING. The old code set the airport
   * to null on every error path, so a moment of rate limiting at the feed threw away
   * a choice the reader had already made. An error now means only that the airport
   * was not ADDED — what was picked before is untouched.
   */
  private async toggleAirport(icao: string): Promise<void> {
    if (this.isChosen(icao)) {
      this.airports = this.airports.filter((one) => one.icao !== icao);
      this.afterAirportChange();
      track('airport_unpicked', { airport: icao, count: this.airports.length });
      return;
    }

    // 🔴 AN AIRPORT WE ALREADY HOLD IS NEVER ASKED FOR AGAIN. The page carries 76
    // airports and their positions from the feed's own airport file, so a saved or
    // pressed airport can be resolved from memory — and it used to ask the feed once
    // per airport on every visit, which is most of the burst that got the page
    // rate-limited on 20 Sep 2026.
    const listed = this.findListed(icao);
    let resolved: ResolvedAirport;
    if (listed) {
      resolved = {
        icao: listed.icao,
        label: listed.location || listed.name,
        name: listed.name,
        location: listed.location,
        iata: listed.iata ?? '',
        lat: listed.lat,
        lon: listed.lon,
        elevationFt: listed.elevationFt,
      };
    } else {
      this.setBusy(icao, true);
      this.setStatus(`Looking up ${icao}…`, 'working');
      try {
        const response = await fetch(`/api/0/airport/${encodeURIComponent(icao)}`, {
          headers: { accept: 'application/json' },
        });
        // Same order as the poll, through the same helper: an error status arrives
        // as an HTML page, so it is caught by its status and never by trying to
        // parse it.
        const trouble = this.feedTrouble(response);
        if (trouble) {
          this.setBusy(icao, false);
          this.setStatus(trouble, 'error');
          return;
        }
        const payload = await readJson(response);
        // 🔴 THE AIRPORT CODE LEFT THIS MESSAGE ON 23 Sep 2026, and both reasons
        // point the same way. It read `… answered ${response.status} for ${icao}`
        // — and `icao` is an airport this reader chose, found from a place they
        // asked for, so the message carried something derived from them into a
        // text that can reach the fault report. It was also worse copy: the row
        // already says which airport was being looked up, so naming it again in
        // the status line only made a short sentence longer.
        if (!response.ok) throw new Error(`The feed answered ${response.status} while resolving an airport.`);
        resolved = parseAirport(icao, payload);
      } catch (error) {
        // 🔴 THIS CATCH IS ONLY EVER REACHED BY A REAL FAULT. A known refusal from the
        // feed is handled above and returns before the throw, so what lands here is a
        // status this page does not recognise, or a body that was not JSON at all — and
        // the reader is told about it either way, so the project should be too.
        reportFault(error, 'resolving an airport against the feed');
        this.lastError = error instanceof Error ? error.message : String(error);
        this.setBusy(icao, false);
        this.setStatus(this.lastError, 'error');
        return;
      }
      this.setBusy(icao, false);
    }

    this.airports = [...this.airports, resolved];
    this.afterAirportChange();
    track('airport_picked', {
      airport: resolved.icao,
      count: this.airports.length,
      km: this.radiusKm,
      nm: kmToNm(this.radiusKm),
    });
  }

  /**
   * Bring back the airports a previous visit picked.
   *
   * It goes through the same toggle as a press does, so a restored session and a
   * fresh one cannot end up in different states — and an identifier the feed cannot
   * place is dropped rather than listed as if it were real.
   */
  private async loadChosenAirports(list: string[]): Promise<void> {
    // 🔴 ONE RE-AIM FOR THE WHOLE RESTORE, NOT ONE PER AIRPORT. Every change to the
    // set re-aims the fence, and re-aiming polls immediately — so restoring eight
    // airports asked the feed eight times in a couple of seconds on every visit,
    // before the page had drawn anything. That burst is exactly the shape a rate
    // limiter is built to refuse, and it happened on every single load.
    this.restoring = true;
    // Capped, because this is one feed request each and the feed rate-limits. A
    // stored list never grows past this, so the cap is a guard rather than a limit
    // anybody will meet.
    for (const icao of list.slice(0, 8)) {
      if (!this.isChosen(icao)) await this.toggleAirport(icao);
    }
    this.restoring = false;
    this.afterAirportChange();
    this.updateSteps();
  }

  /**
   * Everything that has to happen once the set of picked airports changes.
   *
   * It is in one place on purpose: the star, the sentence, the map and the fence are
   * four views of the same fact, and a change that updated three of them would leave
   * the page disagreeing with itself.
   */
  private afterAirportChange(): void {
    const picked = this.chosenIcaos();
    // 🔴 THE STORE HOLDS THE READER'S AIRPORTS AND NOTHING ELSE. George, 22 Sep 2026, after pressing
    // delete my data: *"and when i deleted, i retained the airport im watching"* — and then *"i
    // delete everything it shgould also remove ### The airports you are watching"*.
    //
    // Two things were wrong here and both are the same mistake: the page was keeping a fact nobody
    // chose. It wrote the picked set on every load, and on a first visit that set was the single
    // airport this page handed a new reader — so a wipe came back holding `aircraft_airport`. And
    // an empty set wrote an EMPTY STRING rather than removing the key, so unpicking the last
    // airport left a trace behind and the store could never be empty.
    //
    // So: something chosen is stored; nothing chosen REMOVES the key. The store is now exactly the
    // reader's choices, which is the only thing a delete can honestly be asked to clear.
    if (picked.length > 0) writeStore(AIRPORT_KEY, picked.join(','));
    else dropStore(AIRPORT_KEY);
    // 🔴 THERE IS NO SUMMARY LINE ANY MORE. George, 20 Sep 2026: *"you can remove this
    // 5 airports watched: CYHM — Hamilton · CYSN — St Catharines ..."*. The chips are
    // gold when they are picked and the map draws them; a sentence repeating the list
    // underneath the list was the same fact told three times.
    // Redraws the chips AND the map — `renderNearby` draws the map too — so the
    // stars and the map agree with the list in the same frame.
    this.renderNearby();
    // 🔴 AND THE TYPE LIST, WHICH IS FILTERED BY THESE AIRPORTS. George, 20 Sep 2026:
    // *"the selections will always be filtered by their selected airports"*. Without
    // this line the list was drawn once when the survey loaded and never again, so
    // picking an airport changed nothing — and on a reload it depended on which of
    // two async loads happened to finish first. Found by counting: 32 of the 62 types
    // were not seen at CYHM, and the page still showed all 62.
    this.renderTypeList();
    // A restore re-aims once, at the end — see loadChosenAirports().
    if (this.restoring) return;
    this.rearm();
    this.updateSteps();
  }

  /**
   * What the fence is drawn round — which changed the moment several airports could
   * be picked at once, so the sentence has to be able to say "the middle of them".
   */
  private stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Restart the clock on the CURRENT cadence, which moves as the feed answers. */
  private startTimer(): void {
    this.stop();
    this.timer = window.setInterval(() => void this.poll(), this.pollMs);
  }

  /**
   * 🔴 ONE IMMEDIATE LOOK, EVEN WHEN THREE THINGS CHANGE IN THE SAME MOMENT.
   *
   * A page load re-aims the fence three times over — the restored airports, the
   * place worked out from what they searched for, and the distance they press — and
   * every re-aim called `poll()` straight away. Measured on 20 Sep 2026 by counting
   * the requests the page made: **three feed requests inside one second on every
   * single load**, before the page had drawn anything. That burst is exactly the
   * shape a rate limiter exists to refuse, and it happened on every visit.
   *
   * So an immediate look is now COALESCED: the first re-aim schedules it, the next
   * two replace the pending one, and the feed sees a single request.
   */
  private schedulePoll(): void {
    if (this.pollSoon !== null) window.clearTimeout(this.pollSoon);
    this.pollSoon = window.setTimeout(() => {
      this.pollSoon = null;
      void this.poll();
    }, 150);
  }

  /**
   * 🔴 "REFRESH" — THE READER PRESSES THE POLL THEMSELVES. George, 22 Sep 2026: *"to the right of
   * [Last refreshed], i want a refresh right aligned, this will reapply my filters to current
   * data"*.
   *
   * The page already asks the feed on its own cadence, so this control does not exist to make the
   * data arrive — it exists because the line above the map reads "Last refreshed 12s ago", and a
   * reader who has just switched a row on wants the answer this moment rather than at the next tick.
   * The filters re-apply for free: every one of them is read off its control as the map is drawn, so
   * what comes back is drawn through the settings exactly as they stand when the answer lands.
   *
   * 🔴 THE IMMEDIATE LOOK GOES THROUGH `schedulePoll()`, NOT STRAIGHT TO THE FEED, and the clock is
   * re-armed with it. That is the same coalescing path every other "something changed" takes, so a
   * press in the same moment as a distance change is still ONE request — and re-arming means the next
   * scheduled look is a full interval away rather than a second away.
   */
  private refreshNow(): void {
    if (!this.point() || !this.engine) return;
    this.setStatus('Asking the feed again…', 'working');
    this.startTimer();
    this.schedulePoll();
  }

  /** The one control above the map that is about the clock rather than about the distance. */
  private bindRefresh(): void {
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      // 🔴 TWO REFRESHES, AND THEY ARE NOT THE SAME PRESS. The one on the clock above the map asks the
      // feed again; the one on the filter count reads the measured type file again *and* asks the feed,
      // because the count on that line is made of both. Delegated on the document, like the other, so a
      // redraw cannot leave it bound to a node that is gone.
      if (target?.closest('#refreshFilters')) {
        void this.refreshFilterResults();
        return;
      }
      if (!target?.closest('#refreshNow')) return;
      this.refreshNow();
    });
  }

  /**
   * 🔴 "REAPPLY MY FILTERS TO WHAT THE FEED IS SHOWING NOW." George, 22 Sep 2026: *"**Showing 17 of 184
   * types.** is want to be able to refrech the filters results"*.
   *
   * The count on that line has TWO inputs, so one press refreshes both: `/types.json` is read again —
   * `no-store`, because a press that is answered from the browser's cache is not a refresh — and the
   * feed is asked again, because the census of what is being heard right now is the other half of the
   * list. The re-reading itself is `loadSurvey()`, which is the same work the first load does: it sets
   * the note, the filter count, the list and the watch rows, so nothing here has to repeat any of it.
   *
   * ⚠️ ONE PRESS IS ONE ROUND OF WORK. A second press while the first is still in flight returns, and
   * the label says so, because two fetches for one press would spend the feed's allowance twice and
   * answer the same question.
   */
  private async refreshFilterResults(): Promise<void> {
    if (this.filterRefreshPending) return;
    this.filterRefreshPending = true;
    const button = byId<HTMLButtonElement>('refreshFilters');
    const label = button?.textContent ?? null;
    if (button) button.textContent = 'refreshing…';
    this.setStatus('Reading what the feed has been showing again…', 'working');
    try {
      await this.loadSurvey();
      // The sky, not just the file. `refreshNow()` carries the status line and the coalescing into
      // `schedulePoll()`, so a press in the same moment as a distance change is still ONE request.
      this.refreshNow();
    } finally {
      this.filterRefreshPending = false;
      if (button) button.textContent = label ?? 'refresh';
    }
  }

  /**
   * 🔴 A TAB NOBODY IS LOOKING AT MUST NOT SPEND THE ALLOWANCE. The page asked the
   * feed every ten seconds whether or not anyone could see it, so a tab left open
   * behind another window could hold the whole budget down for the tab that was
   * actually being read. Hidden means stopped; coming back polls once and carries on.
   */
  private bindVisibility(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stop();
        return;
      }
      if (this.engine) {
        void this.poll();
        this.startTimer();
      }
    });
  }

  /**
   * Say the cadence out loud once it has slowed, so a reader who wonders why the
   * numbers are moving slowly is told rather than guessing.
   */
  private cadenceNote(): string {
    return this.pollMs > POLL_START_MS
      ? ` · the feed asked us to slow down, so the next look is in ${Math.round(this.pollMs / 1000)}s`
      : '';
  }

  /* -------------------------------------------------------------- the polls */

  private async poll(): Promise<void> {
    const at = this.point();
    if (!at || !this.engine) return;
    // 🔴 THE FEED IS ASKED AS SOON AS THERE IS A POINT — it is not held back until a distance is
    // chosen any more. That guard made sense while the distance control sat in step 1 and the
    // reader had to answer it: there was nothing to ask about until they had. The control now lives
    // above the map in step 4, so waiting on it would mean the page never filled in at all — and a
    // distance is in use from the start (the widest the feed offers, or the last one chosen), so there
    // IS something to
    // ask. The status line said "Set how far out to look at the top of the page" for exactly this
    // case, which is precisely what stopped being true.
    const url = `/api/v2/point/${at.lat}/${at.lon}/${kmToNm(this.radiusKm)}`;

    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });

      // 🔴 THE STATUS IS CHECKED *BEFORE* THE BODY IS READ, AND THAT ORDER IS THE
      // WHOLE FIX — for every error status, not just the rate limit. See the note
      // on feedTrouble(): the 429 came back as an HTML page and so did the 502, and
      // both were reported as a JSON parsing complaint, which names the symptom and
      // hides the cause.
      const trouble = this.feedTrouble(response);
      if (trouble) {
        // The proxy's own sentence is preferred when it offers one: it knows which upstream refused.
        const proxySaid = await this.proxyMessage(response);
        this.lastError = `the feed answered ${response.status}`;
        // 🔴 BEING REFUSED IS A REASON TO ASK LESS OFTEN, NOT TO KEEP ASKING. Ten
        // seconds was too fast even before a limit was hit; doubling on the refusal
        // and creeping back on every success is what lets the page recover by
        // itself instead of sitting in a rate limit until somebody reloads.
        if (response.status === 429) {
          this.pollMs = Math.min(POLL_MAX_MS, Math.max(POLL_START_MS, this.pollMs * 2));
          this.startTimer();
        }
        this.setStatus(proxySaid ?? trouble, 'error');
        return;
      }

      const payload = (await readJson(response)) as FeedResponse;
      if (!response.ok) throw new Error(`The feed answered ${response.status}.`);

      this.engine.setWatchlist(this.watchlist);
      this.engine.setTypeRules(this.typeRules);
      // 🔴 THE BELL'S LIST IS HANDED OVER TOO, OR A RELOAD SILENTLY DISARMS EVERY ALERT while
      // the bell still shows as pressed on the row — an alert that looks armed and is not.
      this.engine.setAlertRules(this.alertRules);
      const readings = Array.isArray(payload.ac) ? payload.ac : [];
      // Held for the live view, which draws what is in the air NOW rather than
      // what has already left. Both come off the same reading of the feed, so
      // the picture and the table can never disagree about the same aircraft.
      this.lastReadings = readings;

      // Count what this session is actually seeing, so the type list is never
      // empty even if the measured file cannot be read — and so a type the
      // survey never caught still becomes watchable rather than invisible.
      //
      // 🔴 IT COUNTS WHAT IS IN FRONT OF THE READER *NOW*, NOT WHAT HAS EVER BEEN. George, 22 Sep 2026:
      // *"if its in the are outside of my circle, i dont want the tails to say in the air"*. This map
      // only ever grew — a type counted once stayed counted for as long as the tab was open — so a row
      // could read *"on the map just now"* about an aircraft that left the fence twenty minutes earlier,
      // and the type list went on offering types that were no longer anywhere near. It is rebuilt from
      // the poll that has just arrived, which is the only reading it ever claimed to describe.
      const seen = new Map<string, number>();
      for (const reading of readings) {
        const type = String(reading.t || '').trim().toUpperCase();
        if (!type || type === '-' || type.length > 6) continue;
        // 🔴 WHAT IS IN FRONT OF THE READER, NOT WHAT IS IN THE RESPONSE. See `insideMyCircle`.
        if (!this.insideMyCircle(reading.lat, reading.lon)) continue;
        seen.set(type, (seen.get(type) ?? 0) + 1);
      }
      // 🔴 A SWAP IS A CHANGE. One type leaving as another arrives leaves the SIZE the same, so a
      // size-only comparison would leave the list drawn for the previous set of types.
      const changed =
        seen.size !== this.liveTypes.size || [...seen.keys()].some((code) => !this.liveTypes.has(code));
      this.liveTypes = seen;
      if (changed) this.renderTypeList();

      const departures = this.engine.ingest(readings, Date.now());
      // ⚠️ THIS IS WHERE THE PAGE USED TO NOTE A TAKEOFF TIME, and the line is deliberately not
      // replaced. `noteTimes` recorded, per airframe, when this page watched it leave the ground and
      // when it was first seen airborne — two facts that fed two cells of the table. The table is gone
      // (see the note on `renderMap`), so nothing on the page reads them any more, and a fact no view
      // reads is a fact that cannot be seen to be wrong. The engine itself is untouched: `departures`
      // still arrives here and still drives the alert below, which was always the reason for the work.
      // If the takeoff time returns — his words were *"in arrival list the time it took off in the users
      // locat time"*, and the map has room for it — it belongs back here, beside the ingest it was
      // measured from.
      void departures;

      // 🔴 A SUCCESS BUYS BACK SPEED, SLOWLY AND WITH A FLOOR. Creeping straight
      // back to the fastest cadence would put the page into a sawtooth against the
      // limit — refused, back off, allowed, refused — and the floor is what stops it.
      if (this.pollMs > POLL_MIN_MS) {
        this.pollMs = Math.max(POLL_MIN_MS, this.pollMs - 5_000);
        this.startTimer();
      }

      // 🔴 A READING THE PROXY HAD TO CACHE IS STILL A READING, AND IT IS DATED.
      // The proxy serves the last good answer when the feed refuses, and says how
      // old it is, so the page can be honest rather than either showing an error
      // over data it has, or showing that data as though it were live.
      const feedStatus = response.headers.get('x-feed-status');
      const feedAge = Number(response.headers.get('x-feed-age-ms') ?? '0');
      if (feedStatus === '429') {
        this.pollMs = Math.min(POLL_MAX_MS, Math.max(POLL_START_MS, this.pollMs * 2));
        this.startTimer();
      }

      this.polls += 1;
      this.lastPollAt = Date.now();
      this.lastError = '';

      if (departures.length > 0) this.alertOnDepartures(departures);
      this.renderAircraft();
      // Plain words. George, 20 Sep 2026: *"i dont like ... 2 aircraft in the fence
      // · poll 3 · last 01:15:00 PM"* — "poll" is how it works, not what the reader
      // asked, and the count is what they came for.
      const age = feedStatus === '429' && feedAge > 0 ? Math.round(feedAge / 1000) : 0;
      this.setStatus(
        `${readings.length} aircraft around you · updated ${formatClock(this.lastPollAt)}` +
          (age > 0 ? ` · the feed is refusing requests, so this is the reading from ${age}s ago` : '') +
          this.cadenceNote(),
        'ok'
      );
    } catch (error) {
      // As above: a refusal the page knows about never reaches this catch, so anything
      // that does is a fault. The page keeps the last good picture and says what went
      // wrong, rather than emptying the table and looking like nothing is there.
      reportFault(error, 'reading the feed');
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setStatus(`Feed problem: ${this.lastError}`, 'error');
    }
  }

  /**
   * 🔴 THE DEPARTURES BOARD IS GONE, AND THIS IS WHAT IS LEFT OF IT. George, 20 Sep
   * 2026, pasting the list: *"remove all of this"*. The board was a card of every
   * aircraft first seen climbing, kept in the browser, and it was removed along with
   * its card.
   *
   * 🔴 THE ALERT SURVIVES IT, AND THAT IS NOT AN ACCIDENT — IT IS THE POINT. The
   * notification for a watched aircraft fired from INSIDE the board's write, so
   * deleting the board wholesale would have deleted the one thing George said the page
   * is for: *"the goal is to alert people when their selected aircrafts are in the air
   * around them"*. Removing a feature must not quietly remove the reason for the page.
   *
   * The detection itself is untouched — `engine.ingest()` still decides what a departure
   * is, which is what the tests in `test/detect.test.js` are about. Only the list, its
   * storage and its rendering are gone; nothing accumulates any more.
   */
  private alertOnDepartures(departures: Departure[]): void {
    for (const departure of departures) {
      // 🔴 THE BELL DECIDES, NOT THE STAR. See the note on `bellButton`. A departure the reader
      // asked to see is not automatically one they asked to be woken for.
      if (departure.alert) this.notify(departure);
      track('departure_detected', {
        verdict: departure.verdict,
        watched: departure.watched,
        alert: departure.alert,
        airport: this.airport?.icao ?? '',
        aircraft_type: departure.type,
      });
    }
  }

  /* --------------------------------------------------------------- the view */

  private setStatus(text: string, kind: 'ok' | 'error' | 'working'): void {
    const node = byId('status');
    if (!node) return;
    node.textContent = text;
    node.dataset.kind = kind;
  }

  private renderAircraft(): void {
    if (!this.engine) return;
    // ⚠️ THIS METHOD IS NAMED FOR THE THING IT USED TO DRAW. It rendered a six-column table of the
    // aircraft you are watching; that table's card was deleted on George's instruction and what is
    // left here is the map, the pick that has gone stale, and the watchlist's own status. The name
    // is kept deliberately: eight call sites say *"redraw the aircraft"* and that is still exactly
    // what they get — renaming it would be churn across the file for no behaviour at all. If the
    // list ever comes back, it belongs here, which is why the counting above it was left in place.
    // 🔴 ONLY THE AIRCRAFT THE READER ACTUALLY ASKED ABOUT — still the rule, on the map. George,
    // 20 Sep 2026: *"this should only list the selected flights and or tail"*. `matchOf` decides
    // what was picked, and it is the engine's rule rather than a second copy written here.
    const all = this.engine.snapshot();
    // 🔴 ONE FILTER, READ BY BOTH HALVES OF THE PAGE. See `seenInTheAirInsideFence`: what the reader
    // watches, inside the fence they chose, seen in the air — the map draws these and nothing else.
    // It used to be two filters, and the list's one was weaker, which is why a 25 km fence left a list
    // of aircraft hundreds of kilometres away all saying *in the air* — George, 22 Sep 2026: *"they all
    // say in the air, but they are no visible in my map"*.
    //
    // ⚠️ THE LIST ITSELF IS GONE (see the note on `renderMap`): George, 22 Sep 2026 — *"delete ## What
    // the feed can see right now"*. What is left of this method is the part that was never the table's:
    // the pick that has gone stale, the map, and the watchlist's own status. The emptied `out`/`onGround`
    // counts on `seen` are kept because they are the shape of the answer, not a number that has to be
    // printed — put the list back and they are already counted.
    const seen = this.seenInTheAirInsideFence(all);

    // 🔴 A PICKED FLIGHT THAT IS NO LONGER ON THE LIST IS NOT PICKED ANY MORE. Without this the map would
    // stay zoomed to an aircraft that has left the fence for as long as the tab is open, with nothing on
    // the page saying why — and the reader's only way back would be to press a row that is gone.
    if (
      this.selectedHex !== null &&
      !seen.air.some((one) => String(one.hex ?? '').toLowerCase() === this.selectedHex)
    ) {
      this.selectedHex = null;
    }

    // 🔴 THERE IS NOTHING TO COUNT INTO ANY MORE. This method used to own three empty states —
    // nothing in the fence, nothing matching what you picked, and nothing watched currently in the
    // air — because a card that is deliberately filtered has to say WHICH empty it is. The card is
    // gone (see the note on `renderMap`), so the distinction it protected has nothing to attach to.
    // The map carries its own sentence for the same case, written where the map is drawn.

    // 🔴 THE MAP IS DRAWN WHERE THE POSITIONS ARRIVE, AND LAST.
    //
    // It plots aircraft the FEED reports, so drawing it only when the list changes leaves it stale
    // the moment an aircraft appears. Calling it is cheap: `lastPlot` skips the write whenever the
    // picture has not changed.
    //
    // ⚠️ AND IT IS THE ONE MAP — the circle, where you are, the airport codes and the aircraft you
    // are watching, all in one picture. It was the second of two; the other went with the table.
    this.renderMap();
    // 🔴 AND THE ONE AGE STILL ON THE PAGE IS KEPT HONEST ON THE SAME TICK. "12s ago" is wrong a second
    // after it is written, and a stale age on a live feed is the most reassuring thing a stalled page can
    // say — so the last-refreshed time above the map is repainted once a second. This call used to sit
    // above the map, painting the table's rows; the table is gone and the ticker is still needed, which is
    // why the call is kept rather than the method deleted with the rest of the row machinery.
    this.tickReadingAges();
    // And the watchlist's own status is brought up to date in the same pass, so the list and the map
    // cannot describe different moments — see `tickWatchStates`.
    this.tickWatchStates();
  }

  /**
   * Keep the page's own "last refreshed" honest, once a second.
   *
   * ⚠️ IT USED TO AGE EVERY ROW OF THE TABLE AS WELL, which is why it is a ticker rather than a
   * one-off paint. The table is gone and the one age that remains — the page's own last poll, above
   * the map — still goes stale between polls, so the ticker stays. It reads what it paints off the
   * element itself, so it keeps no state that could disagree with what was rendered.
   */
  private tickReadingAges(): void {
    const paint = (): void => {
      // 🔴 THE LOOP OVER `.reading-ago` IS GONE WITH THE LAST-READING COLUMN THAT CARRIED THEM.
      // George removed that column on 22 Sep 2026 — *"fdor last reading just remove that"* — so the
      // spans it used to age no longer exist, and a query for them on every tick would be a search
      // for something the page cannot produce. What is left is the one age that is still on the page.
      //
      // 🔴 AND IT IS THE ONE AGE THAT IS ABOUT THE WHOLE PAGE. George, 22 Sep 2026: *"and last refreshed
      // fromnow()"* — the time every other reading on the page is aged against, sitting with the
      // distance control above the map. It is painted by this same ticker, for the same reason a row
      // age would be: "12s ago" is wrong a second after it is written, and a stale age on a live feed
      // is the most reassuring thing a stalled page can say.
      const refreshed = document.querySelector<HTMLElement>('#refreshedAgo');
      // 🔴 IT OPENS ON "now", NOT "not yet". George, 22 Sep 2026: *"start off my saying now"*. A page
      // that has just loaded has not been refused anything, and a placeholder cannot be the thing that
      // tells a reader something is missing when nothing is.
      if (refreshed) refreshed.textContent = this.lastPollAt === 0 ? 'now' : fromNow(this.lastPollAt);
    };
    paint();
    if (this.ageTicker !== undefined) return;
    this.ageTicker = window.setInterval(paint, 1000);
  }

  /**
   * Does this aircraft match something the reader asked about — right now?
   *
   * 🔴 THE ENGINE ANSWERS THIS, NOT THE PAGE. `matchOf` is the one place the rule for
   * "watched by name" and "caught by a type rule" lives, and test/detect.test.js covers
   * it directly. Restating it here so the table could skip a poll cycle would have been a
   * second copy of the rule, and the second copy is the one that goes stale.
   */
  private isWatchedNow(state: { hex: string; callsign: string; registration: string; type: string }): boolean {
    if (!this.engine) return false;
    return (
      this.engine.matchOf({
        hex: state.hex,
        flight: state.callsign || undefined,
        r: state.registration || undefined,
        t: state.type || undefined,
      }) !== null
    );
  }

  /**
   * 🔴 WHAT THE TABLE AND THE MAP ARE ALLOWED TO SHOW — AND THEY SHOW THE SAME THING.
   *
   * George, 22 Sep 2026: *"i want it to filter by tail that has been seen in the air from my location,
   * and other filters"* — after finding the list full of aircraft that said *in the air* while the map,
   * drawn on his 25 km fence, showed none of them. Both halves were telling the truth about different
   * questions: the map was on the fence, and the list was filtered by **what he watches and nothing else**,
   * so it kept every aircraft the tracker still remembered from the wider fence he had just left — up to
   * forty-five minutes of them, hundreds of kilometres away.
   *
   * So there is now ONE rule, applied in ONE place, and both the table and the map read its answer:
   *
   *   1. **what the reader watches** — the starred types and named tails, which is where the maker, kind,
   *      era and military filters already live (`matchOf`), so those keep working untouched;
   *   2. **inside the fence** — measured from the same centre everything else uses (`point()`, which is
   *      the reader's own place when it is known) at the distance they chose;
   *   3. **seen in the air** — an aircraft on the ground is not "seen in the air", and it is not put on a
   *      map that is describing what is flying. It is still tracked, so the moment it takes off it appears
   *      with its takeoff time on it, which is the one thing the ground rows were ever for.
   *
   * The excluded counts are returned rather than dropped, because an empty list has to be able to say
   * WHICH empty it is: *"nothing seen in the air inside 25 km"* and *"nothing matched what you picked"* are
   * different answers and the reader is owed the right one.
   */
  private seenInTheAirInsideFence(all: TrackState[]): {
    air: TrackState[];
    onGround: number;
    outside: number;
    stale: number;
    watched: number;
  } {
    const air: TrackState[] = [];
    let onGround = 0;
    let outside = 0;
    let stale = 0;
    let watched = 0;
    for (const state of all) {
      if (!this.isWatchedNow(state)) continue;
      watched += 1;
      // 🔴 A TRACK THE FEED HAS STOPPED REPORTING IS NOT A STATEMENT ABOUT NOW, AND IT WAS BEING
      // DRAWN AS ONE. George, 22 Sep 2026: *"now im seeing on the map an hour ago, but its showing on
      // the map as if its in the air in my viewing areas"*. The engine keeps a track for forty-five
      // minutes (`TRACK_TTL_MS`) and deleted when it is older than that, so between one minute and
      // three quarters of an hour an aeroplane nobody is hearing any more still carried
      // `phase: 'airborne'` and the last place it was seen — and this method asked about the phase and
      // the fence and never about the clock. Measured: an aircraft reported twice and then never
      // again was still drawn, still labelled, and still counted as *"in the air"* three minutes
      // later. This is the test that closes it.
      if (!this.heardRecently(state)) {
        stale += 1;
        continue;
      }
      if (!this.insideFence(state)) {
        outside += 1;
        continue;
      }
      if (state.phase !== 'airborne') {
        onGround += 1;
        continue;
      }
      air.push(state);
    }
    return { air, onGround, outside, stale, watched };
  }

  /**
   * 🔴 HOW OLD A READING MAY BE AND STILL BE TREATED AS "NOW".
   *
   * Two polls at the cadence in use, and never less than a minute and a half. It has to be a window
   * rather than a single poll because the page asks less often whenever the feed refuses it
   * (`pollMs` doubles on a 429), and an aeroplane that vanishes during a slow spell reads as a page
   * that has broken. Two missed polls is the most the page can explain to itself — and at the ten
   * second poll that is a fifth of the time the engine keeps a track for, which is the whole point:
   * the engine remembers for forty-five minutes so a trail can be drawn, and this decides what may be
   * claimed about right now.
   */
  private freshMs(): number {
    return Math.max(this.pollMs * 2, 90_000);
  }

  /** Has this page heard from this aeroplane recently enough to talk about it in the present tense? */
  private heardRecently(state: TrackState): boolean {
    // ⚠️ A MISSING TIMESTAMP IS NOT FRESHNESS. `observedAt` is written on every sighting, so it is
    // absent only on something this page never really saw — and the honest answer there is that the
    // reading cannot support a claim about now.
    return Number.isFinite(state.observedAt) && state.observedAt > Date.now() - this.freshMs();
  }

  /**
   * 🔴 IS THIS AIRCRAFT HERE NOW — heard lately, inside the circle, and airborne.
   *
   * One predicate, because "here now" was being answered in three places with two different rules and
   * the missing term in all of them was TIME. The rows, the green chips, the map's own list and its
   * counts all read this.
   */
  private isHereNow(state: TrackState): boolean {
    return this.heardRecently(state) && this.insideFence(state) && state.phase === 'airborne';
  }

  /**
   * 🔴 IS THIS AIRCRAFT INSIDE THE CIRCLE THE READER CHOSE — the one question everything on this page
   * that speaks about the present has to ask before it says anything.
   *
   * George, 22 Sep 2026: *"i chose a distance of 50, i clicked these two, it tells me whats is in the air
   * but only one show up on my map. if its in the are outside of my circle, i dont want the tails to say
   * in the air"*. The map asked this question and the watchlist row did not: the engine keeps up to forty
   * five minutes of tracks, so an aircraft that has already flown out of the circle is still in the
   * snapshot the row was counted from — and the row read *"8 in the air"* beside a map drawing one.
   *
   * Two statements about one moment have to be counted from one thing. This is that thing: the rows, the
   * green chips beside them, the map's own list and its empty-state counts all read this method, so they
   * cannot describe different skies.
   *
   * ⚠️ NO CENTRE OR NO POSITION IS NOT A REASON TO EXCLUDE. The fence answer is then UNKNOWN, and an
   * aircraft is not hidden on missing data — the caller's own rule (watched? airborne?) decides, and a
   * page that hides what it cannot measure reports an absence it has no way to know about.
   */
  private insideFence(state: { lat?: number; lon?: number }): boolean {
    return this.insideMyCircle(state.lat, state.lon);
  }

  /**
   * The same question for a raw reading, which is what the feed hands over before anything is tracked.
   *
   * 🔴 AND THE POLL'S OWN CENSUS HAS TO ASK IT. George, 22 Sep 2026: *"i click last 5 minutes. this shoud
   * filter my the airport i selected. last 5 minutes from my airport, not all flights everywhere, because
   * now it says in the air but i dont see on map"*. The census that answers *"seen just now"* and exempts
   * a type from the airport filter was built from the WHOLE response — every aircraft the feed returned,
   * hundreds of kilometres away included — so a type flying over Toronto was offered as "seen just now"
   * here, and the row went on to promise an aircraft the map could not draw because it was outside the
   * circle. One question, asked in one place.
   */
  private insideMyCircle(lat?: number, lon?: number): boolean {
    const centre = this.point();
    if (centre === null) return true;
    if (typeof lat !== 'number' || typeof lon !== 'number') return true;
    return distanceNm(centre.lat, centre.lon, lat, lon) <= kmToNm(this.radiusKm);
  }

  /* -------------------------------------------------- the measured types --- */

  /**
   * Read `types.json`, which `tools/survey-types.mjs` measured and wrote.
   *
   * 🔴 THE LIST IS DATA, NOT CODE, AND THAT IS THE WHOLE POINT. The page does not
   * carry a hard-coded idea of what flies out of Hamilton; it reads what the feed
   * actually showed, with the date and the method beside it, so the list can be
   * refreshed by re-running one script rather than by editing the site. If the
   * file is missing the page says so and falls back to what it sees live — it does
   * not invent a list.
   */
  private async loadSurvey(): Promise<void> {
    const note = byId('typeNote');
    try {
      // 🔴 `no-store`, AND IT IS THE POINT OF THE REFRESH. George asked for a control that reapplies the
      // filters to CURRENT data; an answer that comes out of the browser's cache is the previous data, so
      // the request is made uncacheable rather than hoped to be fresh.
      const response = await fetch('/types.json', {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      this.survey = (await readJson(response)) as TypesDocument;
      this.surveyRead = true;
    } catch (error) {
      // A file this site ships that cannot be read is a deployment fault, not a normal
      // outcome — and the page only answers by showing a quieter list, so nothing else
      // would ever say so.
      reportFault(error, 'reading the measured type list');
      this.survey = null;
      // A refusal is an answer, and it has to be recorded as one — otherwise the rows would
      // say they are still waiting for a record that is never going to arrive.
      this.surveyRead = true;
      if (note) {
        note.textContent =
          'The measured type list could not be read, so this shows only the types seen in this session. ' +
          (error instanceof Error ? error.message : '');
      }
      this.renderFilterNote();
      this.renderTypeList();
      // 🔴 THE ROWS WERE DRAWN BEFORE THIS FILE EXISTED, SO THEY ARE DRAWN AGAIN NOW.
      this.refreshWatchRows();
      return;
    }
    if (note && this.survey) {
      const refused = this.survey.roundsRefusedByRateLimit ?? 0;
      note.textContent =
        `Measured ${this.survey.generated.slice(0, 10)} from ${this.survey.aircraftInspected} aircraft readings — ` +
        `${this.survey.method}. Counted as ${this.survey.counted ?? 'sightings'}, so a busy airliner seen in every ` +
        `round scores more than one. This site can name ${knownTypeCount()} type codes; anything else is shown as ` +
        `its raw code rather than guessed at.` +
        (refused > 0 ? ` ${refused} round(s) were refused by the feed's own rate limit.` : '');
    }
    this.renderFilterNote();
    this.renderTypeList();
    // 🔴 THE ROWS WERE DRAWN BEFORE THIS FILE EXISTED, SO THEY ARE DRAWN AGAIN NOW.
    this.refreshWatchRows();
  }

  /**
   * Read `years.json`, which `tools/survey-years.mjs` measured and wrote.
   *
   * 🔴 SAME SHAPE AS EVERY OTHER LIST ON THIS PAGE: a measured file, with its date,
   * its method and its source, so the year can be refreshed by re-running one
   * script rather than by editing the site. If it cannot be read the page shows NO
   * years and says so — it does not fall back to a number somebody typed once.
   */
  private async loadYears(): Promise<void> {
    try {
      const response = await fetch('/years.json', { headers: { accept: 'application/json' } });
      this.yearsDoc = (await readJson(response)) as YearsDocument;
    } catch (error) {
      // `/years.json` ships with this site, so not being able to read it means the
      // deployment is wrong — and the page answers by showing no years at all, which is
      // exactly the kind of quiet degradation nothing else would report.
      reportFault(error, 'reading the year file');
      this.yearsDoc = null;
    }
    this.buildYearFilter();
    this.renderFilterNote();
    this.renderTypeList();
    // The year tag on a watching row comes from this file, so the rows are drawn again with it.
    this.refreshWatchRows();
  }

  /**
   * How many of these aircraft match — the caller passes the list, so it is read ONCE per draw.
   *
   * `snapshot()` sorts, and with every type starred there are well over a hundred rows, so
   * asking the engine per row would sort the whole fleet a hundred times to draw one list.
   */
  private static countMatching(
    live: { type?: string; registration?: string }[],
    by: (one: { type?: string; registration?: string }) => boolean
  ): number {
    return live.filter(by).length;
  }

  /**
   * "4 minutes ago" / "3 hours ago" / "2 days ago" — always counted from NOW.
   *
   * 🔴 George, 21 Sep 2026: *"not on the map — never caught here people will not understand this.
   * make the messatge can be time related like was on map x hours ago, or minutes from now()"*.
   *
   * He is right, and the wording was the smaller half of it. A reader looking at a row wants to
   * know WHEN, and "never caught here" answers a different question in words that read as a
   * fault in the page rather than a fact about an aeroplane. Everything the status says is now a
   * time, and it is counted from the moment the reader is looking at it.
   */
  private agoText(at: Date): string {
    const minutes = Math.max(0, (Date.now() - at.getTime()) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) {
      const m = Math.round(minutes);
      return `${m} minute${m === 1 ? '' : 's'} ago`;
    }
    const hours = minutes / 60;
    if (hours < 24) {
      const h = Math.round(hours);
      return `${h} hour${h === 1 ? '' : 's'} ago`;
    }
    const days = Math.round(hours / 24);
    if (days <= 45) return `${days} day${days === 1 ? '' : 's'} ago`;
    return `${Math.round(days / 30)} months ago`;
  }

  /**
   * 🔴 WHAT A WATCHED TYPE IS DOING RIGHT NOW, IN PLACE OF THE WORDS "STOP WATCHING".
   *
   * George, 21 Sep 2026: *"i want to change stop watching into a status code, like 'in the air',
   * and if not in there air i want a different explanation why its not on the map"*.
   *
   * He is right that the row was wasting the most valuable column in it. A reader watches a type
   * because they want to know when it flies, and the row said nothing about that — every row read
   * the same whether the thing was overhead at that second or had not been seen for a month. The
   * way out is still there, as a small cross icon with its own label, so nobody is left holding a rule
   * they cannot clear; what changed is that the row now answers the question it exists for.
   *
   * 🔴 EVERY ANSWER IS A TIME. "on the map 4 minutes ago" when the record holds a sighting, and
   * "not seen in 2 days" — the span the record itself covers — when it holds none. Nothing is
   * guessed: the live feed, or a sighting the survey recorded, or the width of the record.
   */
  private watchStateOf(
    code: string,
    live: { type?: string; registration?: string; phase?: string }[]
  ): { kind: 'air' | 'recent' | 'never'; text: string; why: string } {
    // 🔴 "IN THE AIR" NOW MEANS AIRBORNE, AND IT DID NOT. The count used to be every track of this
    // type the engine was holding — which includes aircraft the feed is reporting ON THE GROUND — so
    // a row could say "in the air" with nothing of the type in the air at all, and never mind the
    // greens: the words themselves were false. George caught the other half of the same contradiction
    // on 22 Sep 2026 (*"you sday in the air but shouldnt at lease on tail be highlighed in the same
    // green?"*). Two statements about one moment have to be counted from one thing, and this is it.
    const count = Page.countMatching(
      live,
      (one: { type?: string; registration?: string; phase?: string }) =>
        one.phase === 'airborne' && normaliseKey(one.type ?? '') === normaliseKey(code)
    );
    if (count > 0) {
      return {
        kind: 'air',
        text: count === 1 ? 'in the air' : `${count} in the air`,
        why:
          'The feed is hearing this type AIRBORNE inside your fence right now, so it is on the map ' +
          'below. A tail number is green only when that particular aeroplane is one of them, and many ' +
          'transponders never send a registration at all.',
      };
    }

    const at = this.lastSeenOf(code);
    if (at) {
      const ago = this.agoText(at);
      return {
        kind: 'recent',
        text: `on the map ${ago}`,
        why:
          `This type was last seen here ${ago}. Nothing of it is inside your fence at this ` +
          'moment, so it is listed and not on the map now.',
      };
    }

    // Nothing of this type in the record at all. The sentence still says WHEN — how long the
    // record has been kept — because that is the honest width of the claim, and a span of time
    // needs no explaining while the old wording did.
    //
    // 🔴 BUT ONLY ONCE THE RECORD HAS BEEN READ. This is the state George caught on 22 Sep 2026:
    // every row reading *"not seen yet"*, then all of them turning into times the moment he
    // deleted one. The record was still in flight when the rows were drawn, and the answer given
    // in its absence was phrased as if the record had been read and found empty. It had not been
    // read at all. A page that says what it does not know is worse than one that waits.
    if (!this.surveyRead) {
      return {
        kind: 'never',
        text: 'checking…',
        why:
          'The record of what has flown here is still being read, so this page will not say yet ' +
          'whether this type has been seen. The answer appears as soon as the record arrives.',
      };
    }
    if (!this.survey) {
      return {
        kind: 'never',
        text: 'no record',
        why:
          'The record of what has flown here could not be read, so this page has nothing to ' +
          'measure this type against — which is not the same as the type never having flown here.',
      };
    }

    const days = Math.round(this.historySpanDays());
    if (days >= 1) {
      return {
        kind: 'never',
        text: `not seen in ${days} day${days === 1 ? '' : 's'}`,
        why:
          `Nothing of this type has been seen in the ${days} days this record covers. It is on ` +
          'your list and not on the map because it has not flown here.',
      };
    }
    return {
      kind: 'never',
      text: 'not seen yet',
      why: 'The record has only just begun, so this type may simply not have had a chance to appear.',
    };
  }

  /** The same question for one named aircraft, which is watched by its tail number. */
  private watchStateOfTail(
    tail: string,
    live: { type?: string; registration?: string; phase?: string }[]
  ): { kind: 'air' | 'recent'; text: string; why: string } {
    // 🔴 THE SAME CORRECTION AS THE TYPE ROW: "in the air" means AIRBORNE. This counted every track
    // carrying that registration, including one the feed reports on the ground, so a named aeroplane
    // sitting on the apron was described as being in the air. The two rows are read together and must
    // mean the same thing by the same word.
    const count = Page.countMatching(
      live,
      (one: { type?: string; registration?: string; phase?: string }) =>
        one.phase === 'airborne' && normaliseKey(one.registration ?? '') === normaliseKey(tail)
    );
    if (count > 0) {
      return {
        kind: 'air',
        text: 'in the air',
        why: 'The feed is hearing this aircraft AIRBORNE inside your fence right now, so it is on the map.',
      };
    }
    return {
      kind: 'recent',
      text: 'not on the map now',
      why:
        'A tail number is matched against what the aircraft transmits, so it appears on the map ' +
        'whenever the feed can hear it inside your fence — and it is not being heard at the moment.',
    };
  }

  /**
   * 🔴 KEEP THE STATUS COLUMN HONEST, ONCE PER POLL, WITHOUT REBUILDING THE LIST.
   *
   * The status was written when the row was built — when a type was starred — and then never
   * again, so it went stale the moment an aircraft arrived: measured on the page, a row read
   * *"not on the map — seen 2 hours ago"* while the map beside it was plotting that very aircraft.
   * A status that can be wrong is worse than no status, because the reader has no way to tell.
   *
   * Only the text is touched, exactly as `tickReadingAges` does for the table: rebuilding the
   * whole list on every poll would cost the reader their scroll position and any text they had
   * selected, and with every type starred there are well over a hundred rows. It is also skipped
   * outright when nothing the text depends on has changed — see `lastStatusKey`.
   */
  /**
   * EVERY INPUT THE STATUS TEXT IS WRITTEN FROM, so an unchanged set costs nothing. A poll
   * arrives every few seconds and the live set usually differs only by where the aircraft have
   * moved — which cannot change any status text — so without this guard every poll walked a
   * hundred-odd rows to write back exactly what was already there.
   *
   * 🔴 IT MUST COVER THE RECORD AS WELL AS THE FEED, AND THAT IS THE WHOLE BUG OF 22 SEP 2026.
   * The key used to be the live set alone, so a status written before the record arrived could
   * never be corrected: the live set had not changed, the pass was skipped, and the wrong answer
   * stood for as long as the reader left the page alone. George saw every row reading *"not seen
   * yet"* and turn into times the instant he deleted one — because deleting is a full rebuild,
   * and that was the first rebuild to run after the record landed. A guard keyed on part of its
   * inputs does not prevent work; it makes a wrong answer permanent.
   */
  private lastStatusKey = '';

  private tickWatchStates(): void {
    const host = byId('watchList');
    if (!host) return;
    // 🔴 THE SAME LIST THE ROWS WILL BE DRAWN FROM — filtered by the fence AND BY THE CLOCK, so an
    // aircraft crossing out of the circle, and one the feed has simply stopped reporting, are both
    // changes this tick can see. Counting the raw snapshot here would mean the key never moved when a
    // flight left the fence, and the row would keep saying "in the air" until some unrelated aircraft
    // happened to arrive.
    const live = (this.engine ? this.engine.snapshot() : []).filter((one) => this.isHereNow(one));

    // What the status text can actually depend on: which aircraft are here, of which type, under
    // which tail; whether the record has been read, and which reading of it; and whether the
    // years list is in, because that is what the row's year tag is drawn from. A position moving
    // does not change a status, and neither does a new reading of the same aircraft.
    const liveKey = live
      .map((one) => `${one.hex ?? ''}:${one.type ?? ''}:${one.registration ?? ''}`)
      .sort()
      .join(',');
    // 🔴 AND THE AGE ON A ROW HAS TO BE ABLE TO MOVE, OR IT IS A NUMBER THAT ONLY EVER GETS OLDER.
    // A row reading *"on the map just now"* is drawn from when this page last drew that type, and the
    // guard below skips the redraw while the aircraft set is unchanged — so the phrase would sit there
    // saying "just now" ten minutes later. The whole minute, per type this page has drawn, is folded
    // into the key: cheap (only drawn types), bounded, and it makes the sentence age in front of the
    // reader instead of freezing.
    const drawnAgeKey = [...this.mapLastDrawn]
      .map(([code, at]) => `${code}@${Math.floor((Date.now() - at) / 60_000)}`)
      .sort()
      .join(',');
    const statusKey =
      `${liveKey}|${drawnAgeKey}|${this.surveyRead ? (this.survey?.generated ?? 'read') : 'unread'}` +
      `|${this.yearsDoc ? 'years' : 'no-years'}`;
    if (statusKey === this.lastStatusKey) return;
    this.lastStatusKey = statusKey;

    // 🔴 THE ROW IS REBUILT NOW, NOT PATCHED. It used to rewrite the three things in the status cell
    // and leave the rest of the row alone, which was right while the status text was the only thing on
    // a row that could change between polls.
    //
    // 🔴 IT IS NOT THE ONLY THING ANY MORE, AND LEAVING IT AS IT WAS IS WHAT GEORGE SAW. George,
    // 22 Sep 2026, pasting the row back: *"Boeing 737 MAX 8 B38M 2016 in the air ✕ C-FFIP C-GJKK …
    // you sday in the air but shouldnt at lease on tail be highlighed in the same green?"* The status
    // said "in the air" and not one chip was green — because the STATUS was refreshed on every tick
    // and the CHIPS were drawn once, when the row was created, and never again. An aircraft that took
    // off while the page was open turned the words on and could not turn a chip green. A row whose two
    // halves are updated by different clocks will always disagree eventually; the honest repair is one
    // clock.
    //
    // The guard above is what keeps that cheap: the key is the set of aircraft the engine is holding,
    // by hex, type and registration, so this rebuild happens when the picture actually changes and not
    // once a second.
    this.renderWatchlist();
  }

  /**
   * 🔴 THE ROWS ARE BUILT FROM TWO FILES, SO BOTH MUST BE ABLE TO REDRAW THEM.
   *
   * The status is read from the record and the year tag from the years list, and both arrive
   * after the first paint — `start()` restores a kept selection and draws the rows before either
   * request has finished. Neither loader used to redraw this section: they refreshed the type
   * list and the filter note and left the watching rows as they were drawn, so a row carried
   * whatever the record did not yet know, and the status tick could not repair it either (see
   * `lastStatusKey`). One full rebuild per document is the honest repair, and it is cheap: it
   * runs at most twice per page load, and `renderWatchlist` is skipped by the tick guard the
   * rest of the time.
   */
  private refreshWatchRows(): void {
    // Clearing the key first is what lets the next status pass run rather than be skipped as
    // "nothing changed" — the record arriving IS a change, and the key now says so.
    this.lastStatusKey = '';
    this.renderWatchlist();
  }

  private yearOf(code: string): YearEntry | null {
    return this.yearsDoc?.years?.[String(code).toUpperCase()] ?? null;
  }

  /**
   * 🔴 WHEN WAS THIS TYPE LAST SEEN HERE — and a type on the screen RIGHT NOW counts
   * as now. The survey records the last time each type was seen, merged across every
   * run it has made, but this session's own sightings are newer than any file, so
   * they win. Nothing here guesses: a type with no record and nothing in the air has
   * NO date, and the page says so rather than inventing one.
   */
  private lastSeenOf(code: string): Date | null {
    const upper = code.toUpperCase();
    // 🔴 WHAT THIS PAGE DREW WINS OVER WHAT A FILE SAYS. See `mapLastDrawn`.
    const drawnAt = this.mapLastDrawn.get(upper);
    if (drawnAt !== undefined) return new Date(drawnAt);
    if (this.liveTypes.has(upper)) return new Date();
    const row = this.survey?.types.find((one) => one.code === upper);
    if (!row?.lastSeen) return null;
    const at = new Date(row.lastSeen);
    return Number.isNaN(at.getTime()) ? null : at;
  }

  /**
   * 🔴 EVERY TAIL NUMBER THE RECORD HOLDS FOR ONE TYPE — THE LIST ITSELF, NOT A SUMMARY.
   *
   * George, 22 Sep 2026, quoting the row he was looking at: *"**Bombardier CRJ-700** CRJ7 —
   * **every one of them** you used to list available tails below them, the ones that are
   * favourited. if it every one of them, list all tails. dont say everyone of them."*
   *
   * So a whole-type rule no longer ANSWERS with a phrase. It answers with the aeroplanes: every
   * registration the survey caught for that type, printed under the type, with the ones being
   * watched marked — the same yellow the card's chips use, because one colour means one thing.
   * A narrowed rule marks only the tails that were ticked; a whole-type rule watches them all, so
   * every chip is marked.
   *
   * 🔴 IT IS STILL A SAMPLE, AND THE PAGE STILL SAYS SO. Many transponders never transmit a
   * registration, so this is what identified itself and not a fleet list — the sentence is in
   * `types.json`'s own `registrationsNote` and is printed under the type list. This method must
   * never be presented as a complete fleet.
   *
   * 🔴 A TAIL THE READER PICKED AND THE RECORD DOES NOT LIST IS KEPT, AT THE END. The survey is
   * re-run and its list changes; a choice somebody made must not disappear because a later look
   * at the sky happened not to catch that aeroplane identifying itself.
   */
  private tailListOf(code: string): string[] {
    const upper = code.toUpperCase();
    const row = this.survey?.types.find((one) => one.code.toUpperCase() === upper);
    const listed = (row?.registrations ?? []).map((item) => item.reg);
    const chosen = this.typeRules
      .filter((rule) => rule.type.toUpperCase() === upper)
      .flatMap((rule) => rule.tails)
      .filter((tail) => !listed.some((reg) => normaliseKey(reg) === normaliseKey(tail)));
    return [...listed, ...chosen];
  }

  /** "seen just now" / "seen 3 hours ago" / "seen 12 days ago", in plain words. */
  private sinceText(at: Date | null): string {
    if (at === null) return 'not seen here yet';
    const minutes = (Date.now() - at.getTime()) / 60_000;
    if (minutes < 2) return 'seen just now';
    if (minutes < 60) return `seen ${Math.round(minutes)} minutes ago`;
    const hours = minutes / 60;
    if (hours < 24) return `seen ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    if (days <= 45) return `seen ${days} day${days === 1 ? '' : 's'} ago`;
    return `seen ${Math.round(days / 30)} months ago`;
  }

  /**
   * 🔴 THE FILTER THAT MAKES THE LIST WORTH READING. See the note on SEEN_CHOICES:
   * a type that never flies near you is not a choice worth offering, and a filter
   * nobody presses does not stop anybody picking one.
   */
  /**
   * The recorded types, PLUS a row for every code the page can name and the record has never
   * caught.
   *
   * Used by the no-data choice only. The added rows carry zero sightings and a null date, which
   * is the truth about them rather than a placeholder — the page knows the aeroplane exists and
   * has never seen it, and that is exactly what "last seen: not available" means.
   */
  private withNeverCaught(recorded: ReturnType<Page['combinedTypes']>): ReturnType<Page['combinedTypes']> {
    type Row = ReturnType<Page['combinedTypes']>[number];
    const have = new Set(recorded.map((row) => row.code.toUpperCase()));
    const extra: Row[] = [];
    for (const code of knownTypeCodes()) {
      const upper = code.toUpperCase();
      if (have.has(upper)) continue;
      extra.push({
        code: upper,
        seen: 0,
        airports: [],
        operators: [],
        registrations: [],
        lastSeen: null,
        runsSeen: 0,
        seenInAllRuns: 0,
      });
    }
    return [...recorded, ...extra].sort((a, b) =>
      describeType(a.code).name.localeCompare(describeType(b.code).name) || a.code.localeCompare(b.code)
    );
  }

  /**
   * 🔴 NOTHING PICKED IS NOT THE SAME AS NOTHING IN THE AIR, AND THE PAGE WAS SAYING THE WRONG ONE.
   *
   * George, 21 Sep 2026: *"if i have nothing selected, it should tell the user to select some
   * first, so all of this ... should be removed and tell a message instead, then show [it] when
   * airplane types are selected"*. With nothing starred, the card printed the alert line and a full
   * table whose only content was the sentence *"Nothing in the fence matches what you picked ... The
   * feed can see 4 aircraft right now"* — which reads as the feed's shortcoming when it is the
   * reader's own missing step.
   *
   * ⚠️ THE SENTENCE AND THE TABLE ARE BOTH GONE NOW, and the alert is the whole of what this method
   * still has to do — because the alert is the reason the gate existed. It is kept rather than deleted
   * with its siblings: arming a bell with nothing picked would be a bell for nothing, which is
   * exactly the confusion the 21 September instruction was about. The other half of that instruction
   * — *"then show [it] when airplane types are selected"* — is this method's remaining line.
   *
   * The test is the STARRED types (`typeRules`), not the bell: the bell is a separate list, and a
   * bell with nothing starred would still be a bell about nothing — see the note on `alertRules`.
   */
  private syncAlertVisibility(): void {
    const block = byId('notifyBlock');
    if (!block) return;
    block.hidden = this.typeRules.length === 0;
  }

  /**
   * Why the type list is shorter than the record, in one clause per reason — or `''`.
   *
   * 🔴 ONE BUILDER, TWO CALL SITES, SO THE REASONS CANNOT DISAGREE. This sentence is printed
   * under the list AND used as the explanation when a filter has emptied it, and the old code
   * built it twice with slightly different wording — "left out while a year filter is on" in
   * one place and "left out of a year filter rather than guessed at" in the other. Two
   * descriptions of one fact is two chances to describe it wrongly.
   *
   * Every counter it reads is incremented once per dropped type, so the parts add up to
   * exactly the number missing — which is what makes the count on the page checkable rather
   * than decorative.
   */
  private droppedReasons(counts: {
    rows: unknown[];
    total: number;
    droppedByAirport: number;
    droppedByKind: number;
    droppedByMaker: number;
    droppedByYear: number;
    droppedForNoYear: number;
    droppedBySeen: number;
  }): string {
    const parts: string[] = [];
    if (counts.droppedByAirport > 0) {
      parts.push(
        `${counts.droppedByAirport} ${counts.droppedByAirport === 1 ? 'type has' : 'types have'} been seen around ` +
          'here, but not at the airports you picked'
      );
    }
    if (counts.droppedByKind > 0) {
      parts.push(
        `${counts.droppedByKind} ${counts.droppedByKind === 1 ? 'is not the' : 'are not the'} kind you chose`
      );
    }
    if (counts.droppedByMaker > 0) {
      parts.push(
        `${counts.droppedByMaker} ${counts.droppedByMaker === 1 ? 'is not by the' : 'are not by the'} ` +
          'maker you chose'
      );
    }
    if (counts.droppedByYear > 0) {
      parts.push(`${counts.droppedByYear} first flew outside the years you chose`);
    }
    if (counts.droppedForNoYear > 0) {
      parts.push(
        `${counts.droppedForNoYear} ${counts.droppedForNoYear === 1 ? 'has' : 'have'} no first-flown year, ` +
          'so a year filter cannot judge them'
      );
    }
    if (counts.droppedBySeen > 0) {
      parts.push(
        `${counts.droppedBySeen} ${counts.droppedBySeen === 1 ? 'is' : 'are'} outside the last-seen choice you made`
      );
    }
    return parts.join('; ');
  }

  /**
   * One visible label at the start of a chip row.
   *
   * 🔴 THE LABEL IS THE ROW'S NAME, AND IT IS WIRED TO THE GROUP. George, 20 Sep 2026: *"i
   * want a label instead of saying last seen mnay times"*. Three rows of chips each said their
   * own subject on every chip, so the row read as a list of near-identical phrases and the one
   * word that differed was at the end of each. The subject is said once now, and `aria-labelledby`
   * points at it — which is also better for a screen reader than the invisible `aria-label` it
   * replaces, because what is announced is now the text the reader can see.
   */
  /*
   * 🔴 `labelChips()` WAS HERE, AND IT IS GONE BECAUSE THE LABEL IS MARKUP NOW.
   *
   * It built the row's name as a `<span class="chip-label">` INSIDE the chips row — a flex item in a
   * wrapping row, exactly like every chip beside it. That is why the four filter rows could not share a
   * column and why the block read as clutter: the label was never aligned with anything, and a wrapped
   * row put its chips back at the left edge under the label. George, 22 Sep 2026: *"the filtering
   * section is ugly look at it, its too cluttered"*.
   *
   * The four labels are `<span class="chip-label" id="…">` siblings of the chips in `site/index.html`
   * now, so `.filter-row` can put them in a fixed column, and each chips row carries
   * `aria-labelledby` to the same span. The compiler caught the leftover method the moment the last
   * caller went, which is the whole reason it is deleted rather than left sitting here unused.
   */

  private buildSeenFilter(): void {
    const host = byId('seenFilter');
    if (!host) return;
    host.innerHTML = '';
    // 🔴 EVERY CHOICE IS DRAWN, ALWAYS, AND THERE IS NO CONDITION HERE ANY MORE. This used
    // to skip a window while the recorded history was shorter than it, on the argument that
    // a chip which cannot change the list teaches the reader the filter is broken. The
    // argument was reasonable and the conclusion was wrong: the chips are the promise that
    // the window will exist, and a reader who cannot see "this year" today has no way to
    // know it is coming. The note under the chips carries the honesty instead — it says
    // when a window currently covers everything, and from what date the record starts.
    for (const choice of SEEN_CHOICES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip chip-small';
      button.textContent = choice.label;
      button.dataset.seen = choice.key;
      button.setAttribute('aria-pressed', String(choice.key === this.seenFilter));
      button.addEventListener('click', () => {
        this.seenFilter = choice.key;
        // Kept with the other filter choices — see the note on `SEEN_KEY`.
        writeStore(SEEN_KEY, choice.key);
        for (const other of host.querySelectorAll('button')) {
          other.setAttribute('aria-pressed', String(other === button));
        }
        this.renderTypeList();
        this.renderFilterNote();
        track('seen_chosen', { seen: choice.key, runs: this.runsRecorded() });
      });
      host.appendChild(button);
    }
  }

  /** How many looks the database holds. Zero until the survey answers. */
  private runsRecorded(): number {
    const n = this.survey?.runsRecorded;
    return Number.isFinite(n) && (n ?? 0) > 0 ? (n as number) : Math.max(1, ...(this.survey?.types ?? []).map((row) => row.runsSeen ?? 1));
  }

  /** How long the observed history covers, in days. 0 when there is nothing yet. */
  private historySpanDays(): number {
    const from = this.survey?.historyFrom ? new Date(this.survey.historyFrom).getTime() : NaN;
    const to = this.survey?.historyTo ? new Date(this.survey.historyTo).getTime() : NaN;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
    return (to - from) / 86_400_000;
  }

  /**
   * 🔴 ONE SENTENCE FOR BOTH FILTERS, because they answer one question: what have you
   * hidden, and why. Two notes stacked under three rows of chips is a wall of small
   * grey text, which is the thing George has asked me to stop doing twice.
   */
  private renderFilterNote(): void {
    const note = byId('filterNote');
    if (!note) return;
    const parts: string[] = [];
    // 🔴 THE YEAR PROVENANCE PARAGRAPH USED TO BE HERE, AND IT IS GONE. George, 20 Sep 2026,
    // pasting it back: *"nobody reads this"*. He is right, and it was also the same fact twice:
    // every row carries the source and the type-not-airframe caveat in its own tooltip
    // (`yearTitle`), so printing it again above the list was a wall of grey text for a reader who
    // had already been told. What stays is the one case that is NOT a duplicate — when the years
    // could not be read at all, because then there is nothing on any row to explain why.
    if (this.yearsDoc === null) {
      parts.push('The first-flown years could not be read, so no year is shown and the year filter does nothing.');
    }
    const rows = this.survey?.types ?? [];
    if (rows.length > 0) {
      const runs = this.runsRecorded();
      const span = this.historySpanDays();
      const window = SEEN_CHOICES.find((candidate) => candidate.key === this.seenFilter) ?? SEEN_CHOICES[0];
      // 🔴 THE NOTE HAS TO SAY WHAT THE WINDOW IS AND WHEN IT OPENS, because a calendar
      // window is not self-evident. "This month" could mean since the 1st or within thirty
      // days, and those are different lists. Naming the exact moment removes the question
      // instead of arguing about it — and it is the same convention the chips filter by, so
      // the sentence cannot drift from the behaviour.
      const start = window.since ? window.since(new Date()) : null;
      // 🔴 THREE KINDS OF CHOICE, AND THE SENTENCE SAYS WHICH ONE IS RUNNING. "5 minutes" is
      // counted back from this moment — a stopwatch, whose cut-off moves every second. "this
      // week" is the period the reader is living in — a calendar boundary, which does not
      // move. "no data" is neither: it is the list of types the record says NOTHING about.
      // They are different questions and a reader is entitled to know which they just asked.
      // Every one prints its own cut-off or its own count, so none of them is left to
      // inference.
      const how = window.mode === 'all'
        ? 'Every type this site has ever recorded is shown, with no window at all.'
        : window.mode === 'noData'
          ? 'Nothing on record says when these were last seen here — a type this site can name and has never ' +
            'caught. Every other choice on this row hides them, because they have no date to compare.'
          : window.mode === 'rolling'
            ? `Last seen within ${window.phrase ?? window.label} — counted back from right now, not from midnight, ` +
              `so the cut-off moves (it is ${formatWindowStart(start ?? new Date())}).`
            : `Last seen at or after ${formatWindowStart(start ?? new Date())} — ${window.label} by the clock on ` +
              'this machine, not a rolling count of days.';
      // 🔴 HOW MANY IT IS ACTUALLY HIDING, COUNTED RATHER THAN ARGUED. The first version of
      // this sentence INFERRED the answer — it compared the date the record starts against
      // the date the window starts, and concluded that the window "currently includes
      // everything measured". That reasoning is sound on real data and it was still the wrong
      // shape of check: an inference about a list, printed beside the list, is a second
      // opinion that can disagree with the thing it describes. This asks the same function
      // that built the list how many rows it dropped, so the sentence cannot contradict the
      // page. Measured against a fixture with known ages, the inference was wrong the moment
      // the fixture disagreed with it — which is exactly how a false reassurance ships.
      const counts = this.typeRows();
      const hidden = counts.droppedBySeen;
      const bite = window.mode === 'all'
        ? ''
        : window.mode === 'noData'
          // 🔴 THIS SENTENCE PRINTED THE WRONG NUMBER, AND IT PRINTED IT BACKWARDS. In this
          // mode `droppedBySeen` counts the types that HAVE a date — precisely the ones NOT in
          // this state — so the note read *"59 types are in this state and shown below"*
          // immediately above *"Showing 0 of 129 types."* Two sentences in one paragraph
          // contradicting each other, which is the fault this whole note keeps having.
          //
          // The count of types IN this state is the count of ROWS, because keeping them is
          // exactly what this choice does. Found by reading the note back off the rendered page
          // in all ten modes rather than by reasoning about it.
          ? counts.rows.length === 0
            ? ' Nothing is in this state at the moment: every type this site can name has at least one recorded sighting.'
            : ` ${counts.rows.length} type${counts.rows.length === 1 ? ' is' : 's are'} in this state and shown below.`
          : hidden === 0
            ? ' Nothing is hidden by it at the moment: every sighting on record falls inside this window.'
            : ` This window is hiding ${hidden} type${hidden === 1 ? '' : 's'} from the list below.`;
      // 🔴 THE COUNT GOES LAST, ON ITS OWN LINE, AND HIGHLIGHTED. George, 21 Sep 2026:
      // *"nobody reads this ... put the record count of airplane type after the filtering"*,
      // then *"and Showing 32 of 143 types. should be on a new line and highlighted"*. It used
      // to OPEN the sentence, so the reader met a number before anything had told them what had
      // been filtered out or why — and it was the tail of a long grey paragraph, which made the
      // one number they actually want the least visible thing on the card. Now the reason comes
      // first and the number is the last thing, on its own line, in the theme colour.
      //
      // 🔴 AND SINCE 23 Sep 2026 THE COUNT'S OWN LINE IS WHERE THE REFRESH SITS. George: *"the
      // refresh should be to the right of showing x of x types. and right aligned."* The markup is
      // unchanged — the control is the last item in `.filter-note-line` — and the stylesheet is what
      // puts it on this last line and pushes both against the right edge. Nothing here had to move,
      // which is why the count is still written by this one function and cannot drift from the list.
      //
      // And the trailing homily went with it — *"an aircraft that does not fly near you is not a
      // choice worth making"* explains a decision to a reader who never saw the alternative, and
      // `bite` already says how many were hidden.
      const words =
        `${how}${bite} ` +
        `${runs} look${runs === 1 ? '' : 's'} at the sky recorded so far` +
        (span > 0 ? `, spanning ${this.spanText(span)}` : '') +
        '.';
      // `innerHTML` rather than `textContent` so the count can be its own block. Nothing here is
      // reader input, and the one interpolated string is the count itself.
      note.innerHTML =
        escapeHtml(`${parts.join(' ')} ${words}`) +
        ` <b class="filter-count">Showing ${counts.rows.length} of ${counts.total} ` +
        `type${counts.total === 1 ? '' : 's'}.</b>`;
      return;
    }
    note.textContent = parts.join(' ');
  }

  /** "40 minutes" / "7 hours" / "3 days" — the span the survey history covers. */
  private spanText(days: number): string {
    const minutes = days * 1440;
    if (minutes < 90) return `${Math.max(1, Math.round(minutes))} minutes`;
    const hours = minutes / 60;
    if (hours < 36) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
    return `${Math.round(days)} days`;
  }

  /** The sentence behind a year, for the tooltip — the row itself carries only the number. */
  private yearTitle(entry: YearEntry): string {
    return (
      `${entry.year}: the year the ${entry.name} was first ${entry.basis === 'first flight' ? 'flown' : 'in service'}. ` +
      (entry.exact ? '' : `Matched on the ${entry.name}, so this may be the family's year rather than this variant's. `) +
      'From Wikidata (CC0). ' +
      "It is the TYPE's year, not the year the individual airframe was built — nothing free publishes a build year " +
      'for a single airframe.'
    );
  }

  private buildYearFilter(): void {
    const host = byId('yearFilter');
    if (!host) return;
    host.innerHTML = '';
    for (const era of ERAS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip chip-small';
      button.textContent = era.label;
      button.dataset.era = era.key;
      button.setAttribute('aria-pressed', String(era.key === this.eraFilter));
      button.addEventListener('click', () => {
        this.eraFilter = era.key;
        writeStore(ERA_KEY, era.key);
        for (const other of host.querySelectorAll('button')) {
          other.setAttribute('aria-pressed', String(other === button));
        }
        this.renderTypeList();
        track('era_chosen', { era: era.key });
      });
      host.appendChild(button);
    }
  }

  /**
   * 🔴 ONE OR THE OTHER, NEVER BOTH. George, 20 Sep 2026: *"if i refresh and my
   * location is know. i dont want to see this A postal code, or let the browser find
   * you ... but if a user want to change their location, delete thier location and
   * bring it back up"*.
   */
  /**
   * The reader's place as one short NAME — the community they named, else the town.
   *
   * George, 20 Sep 2026: *"Your location just make it say the city name, not the others in
   * ()"*, and then — reading his own postal code back off the page — that it *"should say
   * stoney creek at least"*. **The code itself is not repeated here:** it was his home, this
   * repository is public, and a quotation is still the thing it quotes.
   *
   * He was reading a label that said the town followed by seven neighbourhoods in brackets,
   * because the postal service names the whole area in one string and the page printed it
   * verbatim. A reader asking where the circle is centred does not want their postcode's
   * coverage read back to them.
   *
   * Which name leads matters: "Hamilton" is a city of half a million and says nothing about
   * where the circle sits, while "North Stoney Creek" is where they actually are. So the
   * community leads when one has been named, and the town carries it otherwise. What never
   * appears is the bracketed list or the code — and it never appears in the heading either,
   * which is why both callers come through here: a rule applied in one place and not the
   * other is how one card ends up printing the same place two different ways.
   */
  private nearbyPlace(): string {
    const area = stripBrackets(this.placeArea);
    if (area) return area;
    return stripBrackets(this.placeTown) || stripBrackets(this.placeLabel) || 'your position';
  }

  /**
   * The reader's place as the two-part line: the community, then the town it sits in.
   *
   * Returns `{ lead, tail }` rather than HTML, so the label and any other reader of it agree
   * on the words and only the markup differs.
   */
  private nearbyPlaceLine(): { lead: string; tail: string } {
    const lead = this.nearbyPlace();
    const town = stripBrackets(this.placeTown);
    return { lead, tail: this.placeArea && town && town !== lead ? town : '' };
  }

  private renderPlace(): void {
    const ask = byId('placeAsk');
    const known = byId('placeKnown');
    const name = byId('placeName');
    const have = this.centre !== null;
    if (ask) ask.hidden = have;
    if (known) known.hidden = !have;
    if (name) {
      // 🔴 THE LABEL IS A NAME, NOT A LIST AND NOT A CODE. George, 20 Sep 2026: *"Your
      // location just make it say the city name, not the others in ()"*, and then, reading
      // his own postal code back off the page, that it *"should say stoney creek at least"*.
      // See `nearbyPlace`. (The code is not written here — it was his home, and this
      // repository is public.)
      const { lead, tail } = this.nearbyPlaceLine();
      name.innerHTML =
        `<span class="place-area">${escapeHtml(lead)}</span>` +
        (tail ? `<span class="place-sep"> · </span><span class="place-town">${escapeHtml(tail)}</span>` : '');
    }
    this.renderAreaPicker();
  }

  /**
   * The community names this place carries — as chips, because there is exactly one of
   * them the reader is in and the page cannot work out which.
   *
   * Hidden for a browser position, where there is no postcode list to offer, and hidden
   * when the geocoder named only one place, because a picker with one option is not
   * a question.
   */
  private renderAreaPicker(): void {
    const host = byId('areaPicker');
    if (!host) return;
    // 🔴 ONE COMMUNITY IS ENOUGH TO BE WORTH OFFERING, WHEN IT IS A REAL CHOICE. This asked for
    // two, which used to be right for a postal area — the service listed several, one of them the
    // town itself. But a place SEARCH names one community and a town, and with the guard at two
    // the row vanished: the reader got "Hamilton" and no way to say the "Stoney Creek" they had
    // just typed. So the test is not how many there are, it is whether there is anything to
    // choose between — one name that differs from the town is a choice.
    const town = stripBrackets(this.placeTown);
    const worthOffering = this.placeAreas.length >= 2 || (this.placeAreas.length === 1 && this.placeAreas[0] !== town);
    if (!worthOffering) {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.innerHTML =
      `<span class="small muted">Which one? </span>` +
      this.placeAreas
        .map(
          (area) =>
            `<button type="button" class="chip chip-small area-chip" data-area="${escapeHtml(area)}" ` +
            `aria-pressed="${area === this.placeArea}" data-ga="place-area">${escapeHtml(area)}</button>`
        )
        .join('');
    for (const button of host.querySelectorAll<HTMLButtonElement>('.area-chip')) {
      button.addEventListener('click', () => {
        // 🔴 THE CHOICE DOES NOT MOVE THE FENCE. Naming the community is a better label
        // for the same place, not a new place — the coordinates are the ones the search
        // returned and they do not change. Re-aiming here would silently re-ask the feed
        // for an answer nobody asked for.
        this.placeArea = button.dataset.area === this.placeArea ? '' : button.dataset.area ?? '';
        writeStore(AREA_KEY, this.placeArea);
        this.renderPlace();
        // 🔴 THE HEADING NAMES THE PLACE TOO, SO IT HAS TO FOLLOW THE CHOICE. Measured
        // 20 Sep 2026: after clicking "North Stoney Creek" the label above read the community
        // and the heading beside it still read "Airports around Hamilton" — two names for one
        // place on one screen, which is the same defect the label was cleaned to fix.
        this.renderNearby();
        track('place_area_chosen', { area: this.placeArea });
      });
    }
  }

  /**
   * 🔴 CHANGING YOUR LOCATION MEANS GIVING IT UP FIRST. The store is CLEARED rather
   * than overwritten, so the next load has no place either — anything else and
   * "change location" would look as though it had worked and then come back on a
   * refresh. The airports and the types are NOT touched: George, 20 Sep 2026, *"i
   * suppose selected airports can stay along with selected airplane selections"*.
   */
  private bindChangePlace(): void {
    const button = byId('changePlace');
    if (!button) return;
    button.addEventListener('click', () => {
      this.centre = null;
      this.placeLabel = '';
      this.placeTown = '';
      this.placeArea = '';
      this.placeAreas = [];
      this.nearby = [];
      writeStore(CENTRE_KEY, '');
      this.renderPlace();
      // 🔴 `renderNearby` NOW DOES ALL THE WORK, INCLUDING HIDING THE DISTANCE BLOCK. It
      // used to stop at its empty-list line and leave the old map and its "you" marker
      // standing; it now goes through `renderDistance` on every path, so there is no
      // second place where the page can be half-updated.
      this.renderNearby();
      // The fence falls back to the airports still picked — see point() — so the page
      // keeps working while it waits to be told where the reader is.
      this.rearm();
      this.updateSteps();
      track('place_cleared', { airports: this.airports.length });
    });
  }

  /**
   * 🔴 WHICH TYPE CODES SURVIVE THE FILTERS, AND WHY SOME DO NOT.
   *
   * The airports, the kind, the era and the last sighting all narrow, and they narrow
   * together. A type with NO year is dropped under an era filter and counted, because a
   * filter must not answer "before 1970" with something nobody measured.
   */
  private typeRows(): {
    rows: ReturnType<Page['combinedTypes']>;
    /** 🔴 EVERY TYPE THIS MODE COULD SHOW, SHOWN OR NOT — the denominator of the count. */
    total: number;
    droppedByAirport: number;
    droppedByKind: number;
    /** 🔴 COUNTED LIKE EVERY OTHER REASON, so the printed count still adds up exactly. */
    droppedByMaker: number;
    droppedByYear: number;
    droppedForNoYear: number;
    droppedBySeen: number;
  } {
    const era = ERAS.find((candidate) => candidate.key === this.eraFilter) ?? ERAS[0];
    const seen = SEEN_CHOICES.find((candidate) => candidate.key === this.seenFilter) ?? SEEN_CHOICES[0];
    const picked = new Set(this.chosenIcaos());
    // 🔴 THE NO-DATA CHOICE GETS A DIFFERENT UNIVERSE, BECAUSE ITS OWN SENTENCE PROMISES ONE.
    //
    // George, 21 Sep 2026: *"the no data button shows nothing. it is supposed to show airplane
    // types where the last seen is null or not available."* He is right, and it was worse than
    // empty — it was impossible. `combinedTypes()` holds only what the record has SEEN, and every
    // one of those carries a date: measured 21 Sep 2026, 136 seen and **0 of them with a null
    // last-seen**, while the page can NAME 151 codes. So this filter could never show a thing.
    //
    // The 64 codes the page can name and the record has never caught ARE the set this choice
    // describes, and they are worth having: almost the whole heritage fleet is in there — `LANC`
    // (the Lancaster), `B25`, `DC3`, `T6`, `SPIT`, `LYSA`, `HURI`, `P51`, `CORS`. Every other
    // choice on the row hides them for want of a date to compare, which is what the note already
    // said. Only the candidate list changes: the airport, kind and year filters below still
    // apply to these rows exactly as they do to the rest.
    const recorded = this.combinedTypes();
    const all = seen.mode === 'noData' ? this.withNeverCaught(recorded) : recorded;
    // 🔴 EVERY REASON IS COUNTED, BECAUSE THE PAGE NOW PRINTS THE COUNT. George, 20 Sep 2026:
    // *"when i updated the filter, i want the count of airplan types"*. A count is only worth
    // showing if it can be accounted for, so each branch below increments its own reason and
    // the note lists them. That also fixes a smaller lie the old counters told: `undated`
    // counted only the types a YEAR filter rejected for having no year, and said nothing about
    // the ones it rejected for having the wrong one, so the reasons never added up to the
    // difference.
    let droppedByAirport = 0;
    let droppedByKind = 0;
    let droppedByMaker = 0;
    let droppedByYear = 0;
    let droppedForNoYear = 0;
    let droppedBySeen = 0;
    const rows = all.filter((row) => {
      // 🔴 ALWAYS FILTERED BY THE AIRPORTS YOU PICKED. George, 20 Sep 2026: *"the
      // selections will always be filtered by their selected airports"*. A type is
      // offered only when the feed has actually been seen showing it at one of them.
      //
      // 🔴 A TYPE WITH NO AIRPORT ATTRIBUTION STAYS. That means either an aircraft in
      // the air in front of the reader right now, or a type the survey caught
      // somewhere it could not place — and hiding what is flying past would be the
      // wrong kind of tidy.
      //
      // 🔴 AND SO DOES A TYPE THAT IS IN THE AIR NOW, WHATEVER THE SURVEY SAYS. Found
      // 21 Sep 2026 underneath an end-to-end test that had failed for a reason which
      // turned out to be data drift — and under that, a real defect. The survey's own
      // record said `B738` had only ever been seen at **KBUF, Buffalo**, so a 737
      // climbing over Hamilton at that moment was dropped from this list. A type that is
      // not on the list cannot be starred, so the reader could not pick the aircraft they
      // were watching and the live table stayed empty while the feed plainly showed it —
      // and the row's own text said *"seen just now"* at the same time as the list said
      // this type had never been here. The rule above already keeps a type overhead; this
      // is that rule applied when the survey holds a record that disagrees with the sky.
      const inTheAir = this.liveTypes.has(row.code.toUpperCase());
      if (!inTheAir && picked.size > 0 && row.airports.length > 0 && !row.airports.some((icao) => picked.has(icao))) {
        droppedByAirport += 1;
        return false;
      }
      if (this.typeFilter !== 'all' && this.klassOf(row.code) !== this.typeFilter) {
        droppedByKind += 1;
        return false;
      }
      // 🔴 THE MAKER, WHICH IS THE SECOND THING ABOUT A TYPE RATHER THAN A THIRD KIND OF IT. A maker
      // this site cannot name answers `null`, so it has no chip of its own and is reachable only
      // through `Other` — that is the honest place for it, and it is why `Other` is a chip.
      if (this.makerFilter !== 'all') {
        const maker = makerOf(row.code);
        const wanted =
          this.makerFilter === MAKER_OTHER
            ? maker === null || !(this.makerChips ?? []).includes(maker)
            : maker === this.makerFilter;
        if (!wanted) {
          droppedByMaker += 1;
          return false;
        }
      }
      if (era.key !== 'all') {
        const entry = this.yearOf(row.code);
        if (entry === null) {
          droppedForNoYear += 1;
          return false;
        }
        if (entry.year < era.from || entry.year > era.to) {
          droppedByYear += 1;
          return false;
        }
      }
      // 🔴 HOW RECENTLY, AGAINST A WINDOW THAT STARTS AT A KNOWN MOMENT. There used to be
      // three branches here — a round-based "often", a round-based "now", and a rolling day
      // count — because with only a few hours of history a calendar window could not tell
      // anything apart. George replaced that with one plain scale on 20 Sep 2026, so this
      // is now one comparison against one floor: was the last sighting at or after the
      // moment the chosen period begins.
      //
      // A type in the air right now passes every time window, including "today", because
      // `lastSeenOf` answers `now` for anything in `liveTypes` — the reader can see it, and
      // no filter should hide what is flying past.
      const at = this.lastSeenOf(row.code);
      if (seen.mode === 'noData') {
        // 🔴 THE ONE CHOICE THAT KEEPS WHAT THE OTHERS THROW AWAY. A type with no sighting on
        // record is dropped by every window above, because there is no date to compare — so
        // this is the only way to see what the record is silent about.
        if (at !== null) {
          droppedBySeen += 1;
          return false;
        }
        return true;
      }
      const floor = seen.since ? seen.since(new Date()).getTime() : null;
      if (floor !== null) {
        if (at === null || at.getTime() < floor) {
          droppedBySeen += 1;
          return false;
        }
      }
      return true;
    });
    return { rows, total: all.length, droppedByAirport, droppedByKind, droppedByMaker, droppedByYear, droppedForNoYear, droppedBySeen };
  }

  /** The survey's types, with anything newer that this session saw merged in. */
  private combinedTypes(): {
    code: string;
    seen: number;
    airports: string[];
    operators: string[];
    registrations: { reg: string; airports: string[] }[];
    lastSeen: string | null;
    /** 🔴 How many looks at the sky have found it. The filter needs this, and so does
     * the row it is printed on — "seen 3 of 3 looks" is the fact that makes "flies here
     * often" mean something on the day the site is first watched. */
    runsSeen: number;
    /** How many times in total, across every look. */
    seenInAllRuns: number;
  }[] {
    type Row = ReturnType<Page['combinedTypes']>[number];
    const rows = new Map<string, Row>();
    for (const row of this.survey?.types ?? []) {
      rows.set(row.code, {
        code: row.code,
        seen: row.seen,
        airports: [...(row.airports ?? [])],
        operators: [...(row.operators ?? [])],
        registrations: [...(row.registrations ?? [])],
        lastSeen: row.lastSeen ?? null,
        runsSeen: row.runsSeen ?? 0,
        seenInAllRuns: row.seenInAllRuns ?? row.seen,
      });
    }
    for (const [code, seen] of this.liveTypes) {
      const existing = rows.get(code);
      // A type this session saw but the survey never did has no measured tail
      // numbers, and is given none rather than an invented list. It has also never
      // been recorded by a look at the sky, so it counts as seen in none of them and
      // is NOT treated as a regular — the row is here because it is in the air now.
      if (existing) existing.seen += seen;
      else
        rows.set(code, {
          code,
          seen,
          airports: [],
          operators: [],
          registrations: [],
          lastSeen: null,
          runsSeen: 0,
          seenInAllRuns: 0,
        });
    }
    // 🔴 ALPHABETICAL BY NAME, NOT BY HOW OFTEN IT WAS SEEN. George, 20 Sep 2026:
    // *"maybe list the airplane types in alpha order"*. The sighting count is
    // still shown on every row, so nothing is hidden by the change — the list
    // just stops reshuffling itself as the page watches, which made it
    // impossible to go back to a type you had seen a moment ago.
    return [...rows.values()].sort((a, b) =>
      describeType(a.code).name.localeCompare(describeType(b.code).name) || a.code.localeCompare(b.code)
    );
  }

  /**
   * The point the feed is asked about, and the centre of the fence.
   *
   * 🔴 IT IS THE READER'S OWN PLACE, NOT THE AIRPORT. George, 20 Sep 2026: *"choose
   * how far out to look is how far from my postal or zip code. i want to know
   * whats in the air and around me"*. The airport is only the fallback for a
   * reader who has not said where they are, because a fence drawn round an
   * airport answers a different question from the one this site is for.
   */
  private point(): { lat: number; lon: number } | null {
    if (this.centre) return this.centre;
    const picked = this.airports;
    if (picked.length === 1) return { lat: picked[0].lat, lon: picked[0].lon };
    if (picked.length > 1) {
      // 🔴 THE MIDDLE OF THE AIRPORTS PICKED, WHEN THERE IS NO PLACE TO STAND.
      // A reader who has picked Hamilton and Toronto but not said where they are
      // has asked about both, so aiming at the first would quietly ignore the
      // second. The average of the latitudes and the longitudes is the centre of
      // the box they span — good to a few kilometres over the distances this page
      // works in, and honest about being a centre rather than pretending to be one
      // of the airports.
      return {
        lat: picked.reduce((sum, one) => sum + one.lat, 0) / picked.length,
        lon: picked.reduce((sum, one) => sum + one.lon, 0) / picked.length,
      };
    }
    return null;
  }

  /** Re-aim the fence and start polling again — used when the reader moves or picks. */
  private rearm(): void {
    // Said here rather than where a distance is pressed, because this is the one
    // place that runs for every reason the fence can change — a new distance, a new
    // place, a new airport — so the sentence cannot fall out of step with the fence.
    // 🔴 AND THE MAP IS REDRAWN HERE TOO, WHICH IT WAS NOT UNTIL 20 SEP 2026. The
    // circle IS the distance, and the distance chips used to live in their own card
    // where nothing on the map appeared to depend on them — so pressing 50 km redrew
    // the sentence and left the circle exactly where it was. Now that the chips and
    // the map share one card that is plainly a bug, and it was found by driving the
    // page and reading the circle's radius back: it sat at 20 km for every setting.
    this.renderMap();
    const at = this.point();
    if (!at) {
      // 🔴 NOTHING TO AIM AT: no place given and no airport picked. Polling on would
      // ask the feed about a point that does not exist. The table keeps its last
      // reading rather than being emptied, because an empty table says "nothing is
      // flying" when the truth is "nothing has been asked for yet".
      // 🔴 THE PAGE MAY NOT INVITE THE READER TO PICK FROM A LIST IT DELIBERATELY WITHHOLDS.
      // It said *"Pick an airport above, or say where you are, and this fills in."* — and there is no
      // airport above: `renderNearby` draws nothing until a centre is known, because George's rule is
      // *"if you dont know location, there should be no airports seen"*. So the first screen of a
      // fresh visit told a visitor to press something that is not there, while the seven airports the
      // page is built around went undrawn. **A promise the page does not keep is the defect, not the
      // withheld list** — the list stays withheld and the sentence now says what to do.
      this.stop();
      this.setStatus('Say where you are — search for a place, or let the browser find you — and this fills in.', 'working');
      return;
    }
    // 🔴 THE HISTORY CROSSES THE RE-AIM, OR MOVING THE DISTANCE WIPES EVERY FLIGHT PATH.
    //
    // This builds a NEW engine, and a new engine has no memory — so a reader who nudged the distance
    // lost the trail behind every aircraft on the map. Measured by watching it happen: the map's
    // paths vanished on the first `change` event. The tracks are handed over; the departure cooldown
    // is not, deliberately — see `adoptTracks`.
    const before = this.engine;
    this.engine = new DetectionEngine(
      {
        lat: at.lat,
        lon: at.lon,
        radiusNm: kmToNm(this.radiusKm),
        now: Date.now(),
        staleAfterSec: DEFAULTS.staleAfterSec,
        cooldownMs: DEFAULTS.cooldownMs,
      },
      this.watchlist
    );
    this.engine.adoptTracks(before);
    this.engine.setTypeRules(this.typeRules);
    this.stop();
    this.schedulePoll();
    this.startTimer();
  }

  /**
   * 🔴 ONE STEP AT A TIME. George, 20 Sep 2026: *"i dont want other steps to be
   * visible is the 1st step is not complete. maybe a nice slow glide down
   * animation like when they finish a step"*.
   *
   * The gate is the PREVIOUS step having an answer in it, not a form being filled
   * in: a type list is meaningless before a place is known, and a watchlist is
   * meaningless before something has been picked. The glide runs once, on
   * arrival — never on a re-render, or the page would twitch every ten seconds as
   * the feed answered.
   */
  private updateSteps(): void {
    const place = this.airport !== null || this.centre !== null;
    const picked = this.typeRules.length > 0 || this.watchlist.length > 0;

    for (const section of document.querySelectorAll<HTMLElement>('.step-gated')) {
      const step = Number(section.dataset.step ?? '0');

      // 🔴 ONE STEP AT A TIME, AND EACH WAITS FOR THE ONE BEFORE IT TO BE ANSWERED.
      // George, 20 Sep 2026: *"step 2 and 3 and 4, etc should be collapsed if
      // previous steps are not completed. as soon as step 1 is done, gently expand
      // step two"* — and then, when the first attempt revealed 2, 3 and 5 together
      // a third of a second apart, *"you didnt do the collpase / expand like i
      // asked"*. He was right: a stagger is not a sequence.
      //
      // 🔴 THE FLOW IS THREE STEPS, AND IT IS NUMBERED 1-2-3 — ON THE PAGE AND IN THE GATE.
      // It was **1, 3, 4** until 22 Sep 2026, and the reader could see the skip: the distance was
      // step 2, George moved its control into the card that carries the map — *"i want this above the
      // map"* — and the card it moved into was step 4, which step 3 unlocks. That left a sequence with
      // no second step in it, so `place && radiusChosen` became a circle that could never be entered:
      // the distance could only be chosen in a card that appears after a distance has been chosen.
      // The gate is the PLACE alone now, a distance is in use from the start, and the distance card
      // says so in its own note. The *numbering* was left behind by that change and is fixed the same
      // day — a reader counted 1, 3, 4 on the screen, which is a defect however harmless the code is.
      //
      //   1  where you are              → ANSWERED by a place            → unlocks 2
      //   2  the aircraft types         → ANSWERED when something is starred → unlocks 3
      //   3  what you are watching      → carries the distance and the map, and is empty until
      //                                   something has been picked
      const answered1 = place;
      const answered2 = answered1 && picked;
      const show = step === 1 ? true : step === 2 ? answered1 : answered2;

      if (show && section.hidden) {
        section.hidden = false;
        section.classList.add('step-arrive');
        window.setTimeout(() => section.classList.remove('step-arrive'), 900);
      } else if (!show && !section.hidden) {
        section.hidden = true;
      }
    }
  }

  /**
   * 🔴 START OVER, BECAUSE THERE IS NO OTHER WAY TO GET RID OF A STALE PAGE.
   *
   * George, 20 Sep 2026: *"maybe you need a start over that deletes my cookie or
   * something, i steill see all cards open"*. It was not a cookie — the served page
   * carries `hidden` on every step after the first, and the bundle on disk has the
   * sequential gate. What he was looking at was a TAB: opening the same address
   * again only focuses a tab that already has it, so the page he was reading was
   * the one from before the fixes, and no reload of the address would be reached.
   *
   * So this clears everything the page has kept in this browser — the watchlist,
   * the type rules, the chosen airport — and reloads. It is
   * the reader's own reset, and it also happens to be the honest answer to "I still
   * see the old thing": a page that keeps state must offer a way to drop it.
   */
  private bindStartOver(): void {
    const button = byId('startOver');
    if (!button) return;
    button.addEventListener('click', () => {
      // 🔴 THE HAND-WRITTEN LIST THAT USED TO BE HERE IS GONE, AND IT IS WORTH SAYING WHY.
      // It named nine keys, and the page had grown two more since it was written —
      // `ALERTS_KEY` and `AREA_KEY` — so Start over quietly left the alert bells and the
      // chosen community behind. A wipe that enumerates cannot fall behind the page it is
      // wiping. See `storedKeys`.
      forgetStored(false);
      track('start_over', {});
      window.location.reload();
    });
  }

  /**
   * 🔴 "DELETE MY DATA" — THE READER'S OWN WAY OUT, AND IT ASKS FIRST IN THIS PAGE, NOT IN A
   * BROWSER BOX.
   *
   * George, 22 Sep 2026: *"last item, right align a link on the row for Your location Hamilton
   * change location called delete my data, with confirmation box. this effectivly resets their
   * location, and everything else"* — then *"this rests all defalt filters too"* — and then,
   * about the box itself: *"the delete should not use browser confirm."*
   *
   * 🔴 AND IT IS LABELLED "delete my data and start over" SINCE 23 Sep 2026. George: *"delete my data
   * can say delete my data and start over"*. The label is in the markup, not here — this note exists so
   * the account of the control and the words on the control stay the same sentence.
   *
   * 🔴 WHY A `<dialog>` AND NOT `window.confirm`. A browser confirm is a small grey rectangle with
   * the browser's name on it, its buttons are ordered by the browser rather than by the site, it
   * cannot be read by a screen reader as part of the page, and on this page it looks like an
   * accident. `<dialog>` + `showModal()` is the same guarantee — nothing happens until the reader
   * answers, Escape says no, focus cannot leave the box — drawn in this site's own colours, with
   * the safe answer first.
   *
   * 🔴 AND IF THE BROWSER CANNOT OPEN A MODAL, THE CONTROL IS TAKEN AWAY RATHER THAN ASKED IN A
   * BROWSER BOX. A delete with no way to ask is worse than no delete, and a browser confirm is the
   * one thing this change exists to remove.
   *
   * WHAT IT DELETES IS EVERYTHING THE PAGE REMEMBERS, AND THAT IS MOSTLY FILTERS: where you are and
   * the community inside it, the distance, the airports, the types you starred, the alert bells, the
   * tail numbers you named, and the kind, maker, era and last-seen choices. The page therefore comes
   * back as a first visit with every default in place, which is what "resets their location, and
   * everything else" has to mean.
   *
   * 🔴 AND SAYING NO DOES NOTHING AT ALL: no event, no reload, no removal. A destructive control that
   * acts first and asks afterwards has not asked.
   */
  private bindForgetMine(): void {
    const button = byId('forgetMine');
    if (!button) return;
    const dialog = byId('forgetDialog') as HTMLDialogElement | null;
    if (!dialog || typeof dialog.showModal !== 'function') {
      // No modal support: the way out cannot be offered honestly, so it is not offered at all.
      button.hidden = true;
      return;
    }
    button.addEventListener('click', () => dialog.showModal());
    byId('forgetGo')?.addEventListener('click', () => {
      dialog.close();
      this.wipeMyData();
    });
    byId('forgetCancel')?.addEventListener('click', () => dialog.close());
  }

  /**
   * Forget everything this page holds in this browser, say so, and start again.
   *
   * It is separate from the dialog so the dialog can only ever ask: the two halves of a destructive
   * control are the question and the deed, and keeping them in different methods is what makes it
   * possible to read the question and see that it does nothing else.
   */
  private wipeMyData(): void {
    forgetStored(true);
    track('data_deleted', {});
    window.location.reload();
  }

  /**
   * 🔴 CAN THIS BROWSER SHOW THE PAGE'S OWN CONFIRMATION BOX? Asked of the element rather than remembered,
   * because the answer is a fact about the browser and the element is where it shows.
   */
  private canAskInPage(): boolean {
    const dialog = byId('removeDialog') as HTMLDialogElement | null;
    return dialog !== null && typeof dialog.showModal === 'function';
  }

  /**
   * ASK BEFORE STOPPING WATCHING — in this page's own box, never the browser's.
   *
   * George, 22 Sep 2026: *"add a html confirmation box if deleting a watched airplane type"*, then *"i do
   * not want http confirmations. make them html"*. `window.confirm` is a grey rectangle with the browser's
   * name on it, its buttons are ordered by the browser rather than by the site, and it is not part of the
   * page — `<dialog>` + `showModal()` is the same guarantee drawn here: nothing happens until the reader
   * answers, Escape says no, and focus cannot leave the box.
   *
   * ⚠️ AND IF THE BROWSER CANNOT OPEN A MODAL, THE CROSS IS NOT DRAWN AT ALL — see `renderWatchlist`. A
   * row that could only be removed by a browser box is exactly what this change removes, and a cross that
   * silently did nothing would be worse than one that is not there.
   */
  private askRemove(kind: 'type' | 'tail', key: string, what: string): void {
    const dialog = byId('removeDialog') as HTMLDialogElement | null;
    if (!dialog || typeof dialog.showModal !== 'function') return;
    this.pendingRemove = { kind, key };
    const said = byId('removeWhat');
    if (said) {
      said.textContent =
        `${what} comes off the map, and the row goes from your list. ` +
        'You can watch it again from the list in step 3.';
    }
    dialog.showModal();
  }

  /**
   * The question's two answers. Wired once, delegated to nothing — the box is in the page rather than in a
   * row, so it is not rewritten by a poll and a listener on it cannot go stale.
   */
  private bindRemoveAsk(): void {
    const dialog = byId('removeDialog') as HTMLDialogElement | null;
    if (!dialog || typeof dialog.showModal !== 'function') return;
    // A closed box forgets what it was asking, however it was closed — a button, Escape, or the backdrop.
    dialog.addEventListener('close', () => {
      this.pendingRemove = null;
    });
    byId('removeCancel')?.addEventListener('click', () => dialog.close());
    byId('removeGo')?.addEventListener('click', () => {
      const pending = this.pendingRemove;
      dialog.close();
      if (!pending) return;
      if (pending.kind === 'type') this.removeTypeRule(pending.key);
      else this.removeWatch(pending.key);
    });
  }

  /**
   * Stop watching a type, by its code — the deed the question asked about.
   *
   * It redraws three views rather than one: the row goes from the watch list, the star in step 3 goes
   * back to unstarred, and that type's aircraft come off the map, so the table, the list and the map are
   * all answering the same question again.
   */
  private removeTypeRule(code: string): void {
    this.typeRules = this.typeRules.filter((rule) => normaliseKey(rule.type) !== normaliseKey(code));
    this.saveTypeRules();
    this.renderWatchlist();
    this.renderTypeList();
    this.renderAircraft();
  }

  /**
   * 🔴 PRESSING AN AIRCRAFT PUTS THE MAP ON IT, AND PRESSING IT AGAIN TAKES IT OFF.
   *
   * George, 22 Sep 2026: *"i want to be able to select one of those rows, if i do that i want the map to
   * zoom in to that flight. if slect again, it will unselect and zom back out again"* — and then, when the
   * rows did not do it for him: *"click on any aircraft in the air is not zooming into that aircraft"*,
   * *"the map should zoom into it, and i need a way to return to all flights"*.
   *
   * So THREE things are pressable, and all three mean the same thing: a row of the table (whose center may
   * be thousands of pixels down the page), **the aeroplane drawn on the map**, and the name beside it — the
   * shape on the map is the most obvious thing on the page to click, and it is the one that was silent. What
   * is NOT pressable is a watched TYPE, because a type can cover several aircraft at once and so names no
   * single flight.
   *
   * It is DELEGATED ON THE DOCUMENT, not bound to the shapes, because both the table and the map are
   * rewritten on every poll — a listener attached to a row or a mark is gone with it, which is the fault
   * this file has already recorded once for the footer's consent door.
   */
  private bindFlightPick(): void {
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      // A press inside a control is that control's business — the tail chips narrow a type, the two
      // x buttons stop watching, and the show-on-map switch filters the map. Nothing here may swallow
      // those, and a press on the switch must not also be read as a press on the row it sits in, which
      // on a named tail would put the map on that aircraft and then clear the very filter just set.
      if (target.closest('button, a, input, .tail-chip, .map-switch')) return;

      // ⚠️ THE TABLE'S OWN BRANCH IS GONE WITH THE TABLE. A press on `tr.aircraft-row` used to pick
      // the flight; rows no longer exist, so the map's mark and a named tail are the two controls left.
      // The aeroplane on the map, and its name — both carry the airframe's hex. `closest` covers the icon
      // inside the mark as well as the mark itself.
      const onMap = target.closest<HTMLElement>('.locmap-plane-mark, .locmap-plane-label');
      if (onMap) {
        this.pickFlight(onMap.dataset.hex ?? '');
        return;
      }
    });

    // ⚠️ THE KEYBOARD BRANCH WENT WITH THE ROW LINK. It existed to let a watching row be pressed from the
    // keyboard, which is the right thing to do for a control — and a control it no longer is: the row is a
    // boolean now (see `mapSwitch`), the checkbox is focusable and changeable from the keyboard by the
    // browser itself, and a keydown listener matching a selector nothing carries is dead code.

    // 🔴 AND THE SHOW-ON-MAP SWITCHES, WHICH ARE REBUILT WITH THE ROWS ON EVERY POLL AND SO CANNOT BE
    // BOUND BY ROW. Delegated like the rest of this handler for exactly that reason. It listens for
    // `change` rather than `click`: a checkbox is changeable from the keyboard, and a press on its label
    // is the browser's to deliver.
    document.addEventListener('change', (event) => {
      const box = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('input.map-show');
      if (!box) return;
      this.toggleMapShow(box.dataset.mapKey ?? '', box.checked);
    });

    // 🔴 AND THE WAY BACK, WHICH IS NOT HIDDEN BEHIND A SECOND PRESS. *"i need a way to return to all
    // flights"* — pressing the same row again does that, but a reader who has scrolled to the map has no row
    // in view and no way to know it. The button appears only while a flight is picked (`renderMap` shows and
    // hides it), so it is never a control that does nothing.
    const all = byId('flightAll');
    if (all) all.addEventListener('click', () => {
      // Both owners of the frame are released here: the button is the way back from either.
      if (this.mapHide.size > 0) this.clearMapHide();
      else this.clearFlightPick();
    });
  }

  /** Back to every flight: one press on the map card's own control. */
  private clearFlightPick(): void {
    if (this.selectedHex === null) return;
    this.selectedHex = null;
    track('flight_unselected', { via: 'show_all' });
    this.renderAircraft();
    this.renderWatchlist();
  }

  /**
   * Back to every flight: one press on the map card's own control.
   *
   * ⚠️ IT SWITCHES EVERY ROW BACK ON rather than "cancelling a filter", which is the same thing said the
   * other way round — see `mapHide`. George, 22 Sep 2026: the default is on, and the reader turns rows off.
   */
  private clearMapHide(): void {
    if (this.mapHide.size === 0) return;
    this.mapHide.clear();
    track('map_show_row', { key: '', on: true });
    this.renderAircraft();
    this.renderWatchlist();
  }

  /**
   * Pick a flight, or unpick the one already picked.
   *
   * The second press of the SAME aircraft clears it — that is the "unselect and zoom back out" George
   * asked for — and pressing a different row moves the zoom rather than clearing it.
   */
  private pickFlight(hex: string): void {
    const key = hex.trim().toLowerCase();
    if (key === '') return;
    const wasSelected = this.selectedHex === key;
    this.selectedHex = wasSelected ? null : key;
    // 🔴 ONE MAP, ONE OWNER OF THE ZOOM. A picked aircraft wins the frame outright, so the exclusions
    // that were holding it are released rather than left switched off and ignored — see `mapHide`.
    if (this.selectedHex !== null) this.mapHide.clear();
    track(wasSelected ? 'flight_unselected' : 'flight_selected', {});
    this.renderAircraft();
    this.renderWatchlist();
  }

  private async loadMilitary(): Promise<void> {
    try {
      const response = await fetch('/military.json', { headers: { accept: 'application/json' } });
      const doc = (await readJson(response)) as { codes?: { code: string }[]; note?: string };
      for (const row of doc.codes ?? []) this.militaryCodes.add(String(row.code).toUpperCase());
    } catch (error) {
      // Silent IN THE PAGE on purpose — without the file the warplanes filter still works
      // for the historic types in the static table, which is where the Lancaster lives.
      // Silent to the project it is not: `/military.json` ships with the site, so failing
      // to read it is a deployment fault the reader would never think to mention.
      reportFault(error, 'reading the warplane codes');
      this.militaryCodes.clear();
    }
    this.renderTypeList();
  }

  /**
   * The class of a type code, with the harvested military set applied.
   *
   * 🔴 A CIVIL TYPE IS NEVER RECLASSIFIED BY THE FEED'S GLOBAL MILITARY FLAG, AND
   * THIS IS THE FILTERING FAULT THE READER SPOTTED. The flag comes from a WORLDWIDE
   * query that takes no point and no radius, so every type any air force anywhere
   * flies appears in it — measured 20 Sep 2026 it named 11 of the 62 types this
   * site actually sees, including the Cessna 172, the Dash 8, the Airbus A320 and
   * the Boeing 737. Applied naively that put the 172 and the Dash 8 under
   * **Warplanes** and took the 737 and the A320 out of **Airliner**, so two filters
   * were quietly wrong at once.
   *
   * So the flag may only classify a code this site does not already place — which
   * is how the C-17, the C-130 and the Chinook still land under Warplanes.
   */
  private klassOf(code: string): AircraftClass {
    const known = describeType(code).klass;
    if (isCivilClass(known)) return known;
    if (this.militaryCodes.has(code.trim().toUpperCase())) return 'military';
    return known;
  }

  /**
   * 🔴 A PHOTOGRAPH WHERE ONE WAS FOUND AND THE MATCH WAS TRUSTED — A DRAWING
   * OTHERWISE, AND NEVER A GUESS.
   *
   * George, 20 Sep 2026: *"where are the photos. there are free opensource photos
   * online"*. He was right and the earlier answer here was wrong: Wikimedia Commons
   * is free, its licences are permissive, and the MediaWiki API hands back a page
   * image AND its credit terms with no key at all. Measured before building on it:
   * 56 of the 62 types the survey sees have a usable photograph.
   *
   * 🔴 BUT 11 OF THOSE MATCHES WERE BAD, WHICH IS WHY `confident` EXISTS. Measured
   * on the same run: searching "Boeing 737-300" matched **a list of aircraft type
   * designators**, "AgustaWestland Lynx" matched **an armoured fighting vehicle**,
   * and "Cessna 414" matched **a microphone company**. Those are not near misses,
   * they are the wrong subject entirely, and a page that printed them would be
   * worse than one with no pictures at all. So a weak match gets the drawing — and
   * the drawing cannot be wrong about which aeroplane it is, because it only ever
   * claims a KIND of aeroplane.
   *
   * 🔴 AND THE PHOTOGRAPH IS FETCHED BY OUR OWN SERVER, never by the reader's
   * browser, so the image host never sees them. Same shape as the feed and the map.
   */
  private thumbHtml(code: string, klass: AircraftClass): string {
    const photo = this.photos[code];
    if (photo && photo.confident) {
      const src = `/api/photo?src=${encodeURIComponent(photo.src)}`;
      return (
        `<img class="typerow-photo" src="${escapeHtml(src)}" alt="" width="76" height="48" ` +
        `loading="lazy" decoding="async" ` +
        `title="${escapeHtml(`${photo.title} — photograph by ${photo.artist}, ${photo.licence}`)}" />`
      );
    }
    return thumbSvg(code, klass);
  }

  /**
   * The credit a Commons licence requires, printed on the row.
   *
   * 🔴 NOT A TOOLTIP. Every licence these files carry — CC BY, CC BY-SA, GFDL —
   * requires the attribution to be visible beside the work, and an uncredited
   * photograph is a licence breach rather than a missing nicety. So it goes in the
   * row's own text, next to the sighting count.
   */
  private creditOf(code: string): string {
    const photo = this.photos[code];
    if (!photo || !photo.confident) return '';
    return ` · photo ${photo.artist} (${photo.licence})`;
  }

  private async loadPhotos(): Promise<void> {
    try {
      const response = await fetch('/photos.json', { headers: { accept: 'application/json' } });
      const doc = (await readJson(response)) as { found?: Record<string, PhotoEntry> };
      this.photos = doc.found ?? {};
    } catch (error) {
      // Not fatal to the reader — every row falls back to its drawing, which is what a row
      // with no trusted photograph does anyway — but `/photos.json` is built from this
      // site's own database, so not reading it means something upstream is wrong and the
      // page would otherwise never say so.
      reportFault(error, 'reading the photographs');
      this.photos = {};
    }
    this.renderTypeList();
  }

  /**
   * 🔴 AN EMPTY LIST HAS TO SAY WHY IT IS EMPTY, OR IT READS AS BROKEN.
   *
   * Measured 20 Sep 2026: the **Heritage & war planes** filter — the one asked for
   * by name, and doubted to be working — shows nothing at all at Hamilton. That is
   * not a fault in the filter. The class holds the historic types that still fly
   * (the Lancaster among them) plus whatever the feed flags as military, and the
   * historic ones fly a handful of times a year, so on any given afternoon they are
   * not in the feed. "No rows" and "no aeroplanes" are different statements, and a
   * blank box makes the second one by accident.
   *
   * 🔴 AND THIS GUARD HAS TO EXIST AT ALL. A patch earlier the same day removed the
   * curated-rows block and the empty check went with it, so a filter matching
   * nothing rendered an empty box. Found by looking at the file, not by reading my
   * own report of the change.
   */
  private emptyMessage(counts: {
    rows: unknown[];
    total: number;
    droppedBySeen: number;
  }): string {
    const seen = SEEN_CHOICES.find((candidate) => candidate.key === this.seenFilter) ?? SEEN_CHOICES[0];
    // 🔴 THE WINDOW IS NAMED WHEN THE WINDOW IS THE REASON, AND THIS WAS THE BUG BEHIND
    // *"all my filters are gone ... and i dont see any airplain type"*. George, 21 Sep 2026.
    //
    // The branch below used to answer ANY empty list under the default kind filter with *"Nothing
    // has been seen yet — the page has only just started looking. Give it a minute."* So a reader
    // who had chosen **5 minutes** — and whose record held a full day of sightings, all of them
    // older than five minutes — was told the page had only just started looking. That is false,
    // it blames the page for a filter doing its job, and it hides the one thing that would fix
    // it: the choice he made. He then reasonably concluded the page was broken.
    //
    // Found by asking whether the list was ON SCREEN and NON-EMPTY under every one of the ten
    // choices, which no previous test asked — they all reached into the DOM with `$eval`, which
    // finds rows inside a hidden or empty list perfectly well.
    if (seen.mode !== 'all' && seen.mode !== 'noData' && counts.rows.length === 0 && counts.droppedBySeen > 0) {
      return (
        `Nothing on record has been seen within ${seen.phrase ?? seen.label}, so this window shows no ` +
        `types at all — all ${counts.total} types this site can name were last seen before it. ` +
        'This is the last-seen choice doing its job, not an empty list: widen it to see them.'
      );
    }
    if (this.typeFilter === 'military') {
      return (
        "Nothing in this group has been seen here, and that is its normal state rather than a fault. It holds " +
        "the historic types that still fly — Hamilton's Lancaster among them, one of only two airworthy in the " +
        "world, which flies a handful of times a year — plus whatever the feed itself flags as military. Most " +
        "military aircraft never transmit this kind of data at all. An empty list here says nothing about what " +
        "is overhead; it says these particular aircraft are not."
      );
    }
    // 🔴 THE MAKER IS ANSWERED BEFORE THE KIND, BECAUSE IT IS THE MORE SPECIFIC QUESTION. A reader who
    // chose Cessna is owed *"no Cessna has been seen here"* rather than *"no Light has been seen here"*:
    // the kind is still set from before, and answering with it would name a filter they did not just ask
    // about. `counts.rows` is empty either way, so only the sentence changes.
    if (this.makerFilter !== 'all') {
      const named = this.makerFilter === MAKER_OTHER ? null : this.makerFilter;
      return (
        (named
          ? `No ${named} has been seen at this airport. `
          : 'Nothing by a maker this row does not name has been seen at this airport. ') +
        'The list is measured from the feed, so it shows what actually flies here rather than what could. ' +
        'Try another filter, or leave it and watch.'
      );
    }
    if (this.typeFilter === 'all') {
      return 'Nothing has been seen yet — the page has only just started looking. Give it a minute.';
    }
    return (
      `No ${classLabel(this.typeFilter)} has been seen at this airport. The list is measured from the feed, so ` +
      'it shows what actually flies here rather than what could. Try another filter, or leave it and watch.'
    );
  }

  private renderTypeList(): void {
    const host = byId('typeList');
    if (!host) return;

    // 🔴 THE MAKER ROW IS BUILT FROM THE MEASURED LIST, BEFORE THE FILTERS ARE APPLIED TO IT. Its chips
    // have to exist before a chosen maker can be filtered on, and they have to be counted from the whole
    // list rather than from what survives the other filters — see the note on `makerChips`.
    if (this.makerChips === null) {
      const all = this.combinedTypes();
      if (all.length > 0) this.buildMakerFilter(all);
    }

    const counts = this.typeRows();
    const { rows } = counts;

    if (rows.length === 0) {
      // 🔴 A FILTER THAT HIDES TYPES SAYS HOW MANY IT HID, AND WHY. Otherwise an era
      // filter over a list where a third of the codes have no year looks as though
      // the types have gone, rather than as though the years are missing. The reasons are
      // built by one method and printed here and under the list, so the two cannot disagree.
      const why = this.droppedReasons(counts);
      host.innerHTML = `<p class="muted small">${escapeHtml(this.emptyMessage(counts) + (why ? ` ${why}.` : ''))}</p>`;
      // 🔴 THE NOTE AND THE GATE ARE RENDERED ON THIS PATH TOO. The early return above used to
      // leave the note showing the PREVIOUS filter's numbers — the same class of fault as the
      // stale note found on 21 Sep 2026, on the one branch where the list is replaced by a
      // sentence.
      this.renderFilterNote();
      this.syncAlertVisibility();
      return;
    }

    // The bar is drawn against the busiest row on the list, so "169 sightings"
    // and "1 sighting" are not the same shape to the eye.
    const maxima = Math.max(...rows.map((row) => row.seen), 1);

    // 🔴 NOTHING IS LISTED BY HAND HERE ANY MORE. George, 20 Sep 2026: *"i dont
    // want to list by hand"* — so the hand-written residents layer is gone and every
    // row on this page is now something the feed was seen showing. The Lancaster
    // did not leave with it: `LANC` is a named type in the table, read out of the
    // feed's own aircraft database, so it appears under Warplanes the moment it
    // transmits — which is the honest way for it to arrive.
    const measuredHtml = rows
      .map((row) => {
        const info = describeType(row.code);
        const klass = this.klassOf(row.code);
        const rule = this.typeRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(row.code));
        const already = rule !== undefined;
        // 🔴 THE WHOLE TYPE IS ONLY FAVOURITED WHEN NOTHING IS NARROWED. George,
        // 20 Sep 2026: *"if they highlight a tail, un favourite the whole type"* —
        // so the moment one tail is highlighted the button changes to offer the
        // whole type back, and the row stops claiming to watch all of them.
        const wholeType = already && rule.tails.length === 0;
        const chosen = new Set((rule?.tails ?? []).map((tail) => normaliseKey(tail)));
        // 🔴 THE BELL'S OWN RULE, FOUND THE SAME WAY. Nothing is shared with the star beyond
        // the lookup — no fallback to the starred list, because a reader who starred something
        // did not thereby ask to be woken for it, and that inference is the bug being fixed.
        const alertRule = this.alertRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(row.code));
        const alerting = alertRule !== undefined;
        const width = Math.max(2, Math.round((row.seen / maxima) * 100));
        const tails = (row.registrations ?? []).slice(0, 24);
        const entry = this.yearOf(row.code);

        // 🔴 CHIPS IN THE CARD, NOTHING BEHIND A BUTTON. George, 20 Sep 2026: *"i
        // dont want the button choose tail numbers, list the tail numbers as chips
        // in the car they can highlight"*.
        const tailChips =
          tails.length === 0
            ? ''
            : '<div class="tail-chips">' +
              tails
                .map((item) => {
                  // 🔴 STARRING THE WHOLE TYPE STARS EVERY TAIL UNDER IT. George, 20
                  // Sep 2026: *"if i favorite a whole airplay type, put stars for all
                  // the tail numbers"*. A rule with no tail numbers means every
                  // aircraft of that type is watched, so every chip in the row IS
                  // watched and must say so — the old version read the star from the
                  // narrowed list alone, which is empty for a whole-type rule, so a
                  // row you had favourited showed a star at the top and not one
                  // anywhere below it.
                  //
                  // 🔴 AND THE CHIP CARRIES NO STAR AT ALL — JUST THE YELLOW. George,
                  // 20 Sep 2026: *"remove start that are in chip, i just want the
                  // yellow hue only"*. Six little stars down a row of tail numbers
                  // was decoration on top of a colour that already said the same
                  // thing; the colour is the mark.
                  const on = wholeType || chosen.has(normaliseKey(item.reg));
                  return (
                    `<button type="button" class="tail-chip" data-type="${escapeHtml(row.code)}" ` +
                    `data-tail="${escapeHtml(item.reg)}" aria-pressed="${on}" ` +
                    `title="${
                      wholeType
                        ? 'The whole type is watched, so this one is too — press to watch only this aeroplane'
                        : on
                          ? 'Watching only this one'
                          : 'Watch only this one'
                    }" ` +
                    `data-ga="tail-chip">${escapeHtml(item.reg)}</button>`
                  );
                })
                .join('') +
              '</div>';

        // 🔴 THE PER-ROW INSTRUCTION IS GONE. George, 20 Sep 2026, pasting them back: *"these
        // can be removed"* — "The whole type is starred, so every one of these is watched.
        // Press one to watch only that aeroplane instead." and "Only the starred ones are
        // watched — starring a tail number un-favourites the whole type. Press a starred one
        // again, or press the star on the row, to go back to all of them."
        //
        // He is right, and it was the wrong place for it twice over: the sentence appeared on
        // EVERY row, so a list of forty types carried forty paragraphs explaining the same two
        // buttons — and the star's own tooltip already says which state it is in, on the one
        // control the reader is looking at.
        //
        // ⚠️ ONE CLAUSE FROM THE THIRD BRANCH WAS NOT IN WHAT HE QUOTED, AND IT IS NOT PROSE:
        // *"many transponders never send one, so this is a sample of what identifies itself and
        // not a fleet list"*. That is a caveat about what the data MEANS — the kind this
        // project keeps — so it moved to the one note under the list rather than being deleted
        // with the instructions. See `registrationsNote` in the note beside `#typeList`.
        return (
          `<div class="typerow${already ? ' typerow-on' : ''}">` +
          `<div class="typerow-thumb">${this.thumbHtml(row.code, klass)}</div>` +
          `<div class="typerow-main">` +
          `<b>${escapeHtml(info.name)}</b> <span class="mono muted">${escapeHtml(row.code)}</span> ` +
          `<span class="tag">${escapeHtml(classLabel(klass))}</span>` +
          // The year sits where the eye already looks for what a type IS, and its
          // tooltip carries the whole sentence including the caveat about whose year
          // it is.
          (entry
            ? ` <span class="year-tag" title="${escapeHtml(this.yearTitle(entry))}">${entry.year}</span>`
            : '') +
          '</div>' +
          `<div class="typerow-actions">` +
          starButton(row.code, wholeType, already && !wholeType) +
          bellButton(
            row.code,
            alerting && alertRule.tails.length === 0,
            alerting && alertRule.tails.length > 0
          ) +
          '</div>' +
          `<div class="typerow-meta">` +
          `<span class="typerow-bar" aria-hidden="true"><i style="width:${width}%"></i></span>` +
          `<span class="small muted">${row.seen} sighting${row.seen === 1 ? '' : 's'}` +
          ` · ${escapeHtml(this.sinceText(this.lastSeenOf(row.code)))}` +
          // 🔴 HOW OFTEN, BESIDE HOW RECENTLY — because on the day the site is first
          // watched the count is the only one of the two that means anything. "3 of 3
          // looks" is a regular; "1 of 3" is a visitor, and no date can say that yet.
          (row.runsSeen > 0 && this.runsRecorded() > 1
            ? ` <span class="looks-tag">${row.runsSeen} of ${this.runsRecorded()} looks</span>`
            : '') +
          (row.operators.length > 0 ? ` · ${escapeHtml(row.operators.slice(0, 4).join(' '))}` : '') +
          (row.airports.length > 1 ? ` · ${row.airports.length} airports` : row.airports.length === 1 ? ` · ${escapeHtml(row.airports[0])}` : '') +
          `${escapeHtml(this.creditOf(row.code))}</span></div>` +
          tailChips +
          '</div>'
        );
      })
      .join('');

    // 🔴 THE COUNT, AND WHERE THE REST WENT. George, 20 Sep 2026: *"when i updated the
    // filter, i want the count of airplan types"*. The count is not just the number shown — a
    // reader who sees 57 wants to know what happened to the other 72, and a number with no
    // account of the difference is a number they cannot check. `droppedReasons` sums to
    // exactly `total - rows.length`, because every dropped type increments exactly one
    // counter and stops.
    const why = this.droppedReasons(counts);
    host.innerHTML =
      measuredHtml +
      `<p class="small muted">Showing <b>${rows.length}</b> of ${counts.total} type${counts.total === 1 ? '' : 's'}` +
      `${why ? ` — ${escapeHtml(why)}` : ''}.</p>`;

    // 🔴 THE NOTE ABOVE AND THE LIST BELOW ARE RENDERED FROM ONE CALL, BECAUSE THEY WERE
    // DISAGREEING. Measured on George's own page, 21 Sep 2026: the note read *"Showing 136 of 136
    // types"* while the line under the same list read *"Showing 58 of 136 types — 78 types have
    // been seen around here, but not at the airports you picked."* The cause: the note was
    // rendered when the survey loaded, BEFORE the saved airports were restored, so it counted a
    // list with no airport filter applied — and eleven later call sites redrew the list without
    // redrawing the note, so it never caught up. Anything that changes the list changes both, or
    // the card contradicts itself.
    this.renderFilterNote();
    this.syncAlertVisibility();

    for (const button of host.querySelectorAll<HTMLButtonElement>('.type-toggle')) {
      button.addEventListener('click', () => {
        const code = button.dataset.type ?? '';
        const rule = this.typeRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(code));
        if (!rule) {
          // New rules start WIDE — tails empty means every aircraft of the type.
          this.typeRules.push({ type: code, tails: [] });
          track('type_favourited', { code, total: this.typeRules.length });
        } else if (rule.tails.length > 0) {
          // Nothing narrowed any more: the whole type is favourited again.
          rule.tails = [];
          track('type_widened', { code });
        } else {
          this.typeRules = this.typeRules.filter((candidate) => normaliseKey(candidate.type) !== normaliseKey(code));
          track('type_unfavourited', { code });
        }
        this.saveTypeRules();
        this.renderWatchlist();
        this.renderTypeList();
        // 🔴 AND THE MAP AND THE TABLE REDRAW WITH IT. George, 22 Sep 2026: *"when i make a change to what
        // im watching the map should refresh"*. Starring a type changes which aircraft are on the map,
        // and this used to wait for the next poll — up to twenty seconds of a map that disagreed with
        // the list above it. `renderAircraft` ends by drawing the map and the row statuses, so one call
        // is the whole refresh.
        this.renderAircraft();
      });
    }

    // 🔴 THE BELL, WHICH IS A DIFFERENT QUESTION FROM THE STAR. It keeps its own list, so
    // pressing it does not change what the table lists and starring a type does not arm an
    // alert. George, 20 Sep 2026: *"i should be able to select from the list w3hich ones i
    // want an alert for"*.
    for (const button of host.querySelectorAll<HTMLButtonElement>('.alert-toggle')) {
      button.addEventListener('click', () => {
        const code = button.dataset.type ?? '';
        const current = this.alertRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(code));
        if (!current) {
          this.alertRules.push({ type: code, tails: [] });
          track('type_alert_on', { code, total: this.alertRules.length });
        } else if (current.tails.length > 0) {
          // A narrowed bell widens back to the whole type, exactly as the star does — the
          // second press is "all of them", not "off", because that is what the shading says.
          current.tails = [];
          track('type_alert_widened', { code });
        } else {
          this.alertRules = this.alertRules.filter((candidate) => normaliseKey(candidate.type) !== normaliseKey(code));
          track('type_alert_off', { code });
        }
        this.saveAlertRules();
        this.renderTypeList();
      });
    }

    // 🔴 HIGHLIGHTING A TAIL UN-FAVOURITES THE WHOLE TYPE, by construction: the
    // first tick on an un-narrowed rule fills `tails`, and a rule with tails is
    // by definition not the whole type. No separate step, nothing to forget.
    for (const chip of host.querySelectorAll<HTMLButtonElement>('.tail-chip')) {
      chip.addEventListener('click', () => {
        const code = chip.dataset.type ?? '';
        const tail = chip.dataset.tail ?? '';
        // The same predicate the chip was drawn from: lit when the whole type is on, or when
        // this tail is one of the ones picked. Read from the STAR's list, because that is the
        // list the row's marks are about — the bell follows it rather than driving it.
        const starRule = this.typeRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(code));
        const on =
          starRule !== undefined &&
          (starRule.tails.length === 0 || starRule.tails.some((item) => normaliseKey(item) === normaliseKey(tail)));

        // 🔴 A TAIL TICK STARS THE TYPE IF IT WAS NOT STARRED, AND THAT IS THE OLD BEHAVIOUR
        // DELIBERATELY KEPT. Ticking one tail on a row the reader has not starred is how you say
        // "not the whole type — just this aeroplane", and it was the only way to reach a narrowed
        // rule without starring first. Removing it while adding the bell would have quietly
        // dropped a working gesture, and the test that covers it — *"highlighting one
        // unfavourites the whole type"* — was already failing for unrelated reasons, so nothing
        // would have caught it. Measured in the suite output for this very change: the chip
        // click had become a no-op on an unstarred row.
        const star = this.typeRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(code));
        if (star) {
          if (on) star.tails = star.tails.filter((item) => normaliseKey(item) !== normaliseKey(tail));
          else star.tails.push(tail);
        } else {
          this.typeRules.push({ type: code, tails: [tail] });
        }

        // 🔴 THE BELL IS ONLY NARROWED, NEVER CREATED, BY A TAIL TICK. A reader who has not asked
        // to be told about a type must not start receiving alerts because they tidied which
        // airframes the table shows. Arming is the bell's own decision, made by pressing it.
        const bell = this.alertRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(code));
        if (bell) {
          if (on) bell.tails = bell.tails.filter((item) => normaliseKey(item) !== normaliseKey(tail));
          else bell.tails.push(tail);
        }

        this.saveTypeRules();
        this.saveAlertRules();
        this.renderWatchlist();
        this.renderTypeList();
        // The same refresh for a tail tick: what the table lists has just changed, so the map is redrawn
        // with it rather than on the next poll.
        this.renderAircraft();
        track('tail_highlighted', { code, highlighted: !on });
      });
    }

    // The star buttons are rebuilt above, so the waiting gate is re-applied here
    // or a fresh poll would hand back buttons that are enabled too early.
    this.updateSteps();
  }

  /**
   * 🔴 THIS PANEL IS A LIST OF WHAT WAS PICKED, NOT A SECOND PLACE TO PICK IT.
   *
   * George, 20 Sep 2026: *"what you are watching, only list was was selected above,
   * no more features"*. So the box that used to sit in every row — "narrow to a tail
   * number, Add" — is gone, and so is the text telling the reader which controls to
   * use: the stars and the tail chips above are the way in, and this says back what
   * they did. Every row carries the same star, because that is how the choice is
   * drawn everywhere else on the page.
   *
   * 🔴 AND THE TWO WAYS OUT STAY, BECAUSE THEY ARE NOT "FEATURES". Pressing a star
   * or a chip again removes a TYPE, but an aircraft named by hand — in step 5, or
   * with the watch button on the live table — has nothing above to un-press. Without
   * a remove here it could never be undone at all, which is a dead end rather than a
   * tidier page.
   */
  /**
   * 🔴 THE ROWS THE READER HAS SWITCHED **OFF** — WHICH IS WHY THE DEFAULT IS EVERY ROW ON.
   *
   * George, 22 Sep 2026: *"i belive you did, if all switches are off, show them all, i dont want this,
   * the default is to have switches on, and the user can turn them off"*.
   *
   * The first version stored the switched-ON keys and treated an empty set as "no filter" — so switching
   * every row off showed everything, which is the one answer a reader who has just switched everything
   * off cannot have meant. **The state is therefore the EXCLUSIONS, and an empty set means nothing is
   * excluded.** That single inversion gives all three behaviours George asked for:
   *
   *   1. **On load, every switch is on** — nothing has been switched off yet, and nothing has to be
   *      seeded or remembered to make that true. A row that appears later starts on as well.
   *   2. **Turning a row off takes it off the map**, and leaves the rest of the picture alone.
   *   3. **Turning every row off leaves an empty map that says so** — never a silent reset to everything.
   *
   * 🔴 IT IS A FILTER OVER THE SAME LIST THE MAP ALWAYS DREW — every aircraft seen in the air inside the
   * fence — so nothing here can pull in an aircraft the page would not otherwise show, and the only rows
   * that can vanish are the ones the reader switched off.
   *
   * ⚠️ THERE IS ONE MAP, SO THERE IS ONE OWNER OF THE ZOOM: switching a row off clears a picked flight,
   * and picking a flight clears the exclusions. Two owners of one frame is how a map ends up describing
   * neither.
   * ⚠️ IT IS NOT KEPT IN STORAGE — it is a view, not a choice, and a reload starts with every row on
   * again. Say the word and it can outlive the tab like the airports do.
   */
  private mapHide = new Set<string>();

  /**
   * 🔴 EVERY ROW'S OWN WORDING, BY KEY.
   *
   * The set above is keyed by a NORMALISED value, because that is the right way to compare a row with
   * what the feed reports. The caption must not reuse it to name the row: a key of `tail:CFOOL` is not
   * what the page wrote — the row reads `C-FOOL` — so a caption built from the keys quietly misspells
   * the aeroplane. Measured, 22 Sep 2026: *"It is fitted to the row you switched on — CFOOL"*.
   */
  private mapRowNames = new Map<string, string>();

  /**
   * 🔴 WHEN THIS PAGE LAST ACTUALLY DREW ONE, BY TYPE.
   *
   * The row that says *"on the map 1 hour ago"* was reading the SURVEY FILE's last sighting, not
   * anything this page had seen — so a reader could be told an hour while an aeroplane sat drawn on the
   * map in front of them. George, 22 Sep 2026: *"now im seeing on the map an hour ago, but its showing
   * on the map as if its in the air in my viewing areas"*. A row that says "on the map" has to be
   * talking about this map: this is written from the list the map drew, and it is read first.
   */
  private mapLastDrawn = new Map<string, number>();

  /** The key one row's switch is filed under. One builder, so the row and the map cannot disagree. */
  private static showKey(kind: 'type' | 'tail', value: string): string {
    return `${kind}:${normaliseKey(value)}`;
  }

  /**
   * Is this aircraft still on the map?
   *
   * ⚠️ IT ANSWERS *"has the reader switched this row off?"*, NOT *"is this row one of the chosen few?"* —
   * the difference is the whole of this change. An aircraft is drawn unless a row that names it has been
   * switched off, and an aircraft covered by no row at all is drawn, because there is no switch that
   * could have hidden it.
   */
  private rowVisible(one: TrackState): boolean {
    if (one.type && this.mapHide.has(Page.showKey('type', one.type))) return false;
    const reg = (one.registration ?? '').trim();
    return !(reg !== '' && this.mapHide.has(Page.showKey('tail', reg)));
  }

  /**
   * The switch itself.
   *
   * 🔴 IT IS A BOOLEAN AND IT IS ALWAYS AVAILABLE — it does not care whether anything is airborne.
   * George, 22 Sep 2026: *"even though the filight may or may not be in the air, i want this to be a
   * boolean input, not a link"*. The first version disabled the switch on a row with nothing in the
   * air, which made it a conditional control; the reader's question (*"show me this one"*) is not
   * conditional, and an empty map that says why is a better answer than a control that will not move
   * until the sky changes. The tooltip states the empty case instead of preventing it.
   *
   * 🔴 AND IT IS CHECKED UNLESS THE READER HAS SWITCHED IT OFF. The default is on, which is why the
   * set it reads is the exclusions and not the choices — see `mapHide`.
   */
  private mapSwitch(kind: 'type' | 'tail', value: string, stateKind: string): string {
    const key = Page.showKey(kind, value);
    // The row's own wording, kept beside the key that matches the feed, for the caption to use.
    this.mapRowNames.set(key, value);
    const on = !this.mapHide.has(key);
    const why = on
      ? 'This row is on the map. Switch it off to take it off — the rest of your list stays as it is.'
      : 'This row is switched off, so the map is not drawing it. Switch it back on to bring it back — '
        + 'or press Show all flights under the map to switch every row on again.';
    return (
      // 🔴 NO WORDS BESIDE IT. George, 22 Sep 2026: *"remove the show on map redundant text"*. The row's
      // own sentence already says what the switch is for, and the control is the same shape every reader
      // has met before — so the label is carried by `aria-label` for anyone who cannot see the shape.
      //
      // 🔴 AND THE SWITCH WEARS THE COLOUR OF THE SENTENCE BESIDE IT — *"the swtich should conform with
      // ther colors"*. `data-state` is the row's own state kind, which the stylesheet turns into the same
      // green, amber or theme colour the status text uses: one row, one colour.
      `<label class="map-switch" data-state="${escapeHtml(stateKind)}" title="${escapeHtml(why)}">` +
      `<input type="checkbox" role="switch" class="map-show" data-map-key="${escapeHtml(key)}" ` +
      `aria-label="Show this row on the map" ` +
      `data-ga="map-show"${on ? ' checked' : ''} />` +
      '</label>'
    );
  }

  /**
   * The press: one switch changed, so the rows and the map are both redrawn in the same frame.
   *
   * `on` arrives from the checkbox, and the stored set holds the rows that are OFF — so the branch is
   * deliberately the mirror of the obvious one.
   */
  private toggleMapShow(key: string, on: boolean): void {
    if (key === '') return;
    if (on) this.mapHide.delete(key);
    else this.mapHide.add(key);
    // One frame, one owner — see the note on `mapHide`.
    if (!on) this.selectedHex = null;
    track('map_show_row', { key, on });
    this.renderWatchlist();
    this.renderMap();
  }

  private renderWatchlist(): void {
    const host = byId('watchList');
    if (!host) return;

    if (this.typeRules.length === 0 && this.watchlist.length === 0) {
      host.innerHTML = '<li class="muted">Nothing watched yet. Star a type above, and it appears here.</li>';
      return;
    }

    // Read once, for every row — see `countMatching`. 🔴 AND INSIDE THE READER'S CIRCLE, because this
    // list is what the status beside each row is counted from and what turns a tail chip green: an
    // aircraft that has flown out of the fence is not on the map, so it may not be named as being in
    // the air either — see `insideFence`.
    //
    // 🔴 AND HEARD LATELY, WHICH IS THE OTHER HALF OF THE SAME CLAIM. Filtering by the fence alone let a
    // track the feed had stopped reporting keep a row reading *"in the air"* and a tail chip green for
    // as long as the engine remembered it — forty-five minutes. See `isHereNow`.
    const live = (this.engine ? this.engine.snapshot() : []).filter((one) => this.isHereNow(one));

    // 🔴 ASKED ONCE PER RENDER, AND IT IS A FACT ABOUT THE BROWSER RATHER THAN ABOUT THE ROW. The cross is
    // drawn only when the page's own confirmation box can open: a row that could only be removed by a
    // browser box is what this change exists to remove, and a cross that silently did nothing would be
    // worse than one that is not there. The reader can still unwatch a type from its star in step 3.
    const canAsk = this.canAskInPage();

    const typeItems = this.typeRules
      .map((rule) => {
        const info = describeType(rule.type);
        const narrowed = rule.tails.length > 0;
        const entry = this.yearOf(rule.type);
        const state = this.watchStateOf(rule.type, live);
        // 🔴 THE TAIL NUMBERS THEMSELVES, UNDER THE TYPE THEY BELONG TO — because a phrase names
        // no aeroplane. George, 22 Sep 2026: *"if it every one of them, list all tails. dont say
        // everyone of them."* A whole-type rule watches every tail under it, so every chip is
        // marked; a narrowed rule marks only the ones ticked. The list comes from `tailListOf`,
        // which is the record plus anything picked by hand that the record no longer lists.
        const chosen = new Set(rule.tails.map((tail) => normaliseKey(tail)));
        const tails = this.tailListOf(rule.type);
        // 🔴 THE AIRCRAFT OF *THIS TYPE* THAT ARE AIRBORNE RIGHT NOW — the same set the status beside
        // them is counted from, because the two statements have to agree.
        //
        // 🔴 THEY DID NOT AGREE, AND GEORGE CAUGHT IT. George, 22 Sep 2026, pasting the row back:
        // *"Boeing 737 MAX 8 B38M 2016 in the air ✕ C-FFIP C-GJKK … you sday in the air but shouldnt
        // at lease on tail be highlighed in the same green?"* The row said "in the air" and not one
        // chip was green. There were TWO faults behind it, both the page's:
        //
        //   1. the STATUS counted every track of the type the engine was holding, including aircraft
        //      the feed is reporting ON THE GROUND — so it could say "in the air" with nothing of the
        //      type in the air at all. Fixed where the count is made (see `watchStateOf`).
        //   2. the GREEN was matched on the REGISTRATION, and a large share of transponders never
        //      send one. An aeroplane could be up there, of the type, and match no chip on the row.
        //
        // This is the fix for the second: the registrations that ARE identifying themselves are put on
        // the row whether or not the survey ever recorded them, and the ones that are not are COUNTED
        // rather than left as an unexplained gap between the words and the chips.
        const typeKey = normaliseKey(rule.type);
        const airborne = live.filter(
          (one) => one.phase === 'airborne' && normaliseKey(one.type ?? '') === typeKey
        );
        const flyingRegs = new Set(
          airborne.map((one) => normaliseKey(one.registration)).filter((key) => key !== '')
        );
        const unidentified = airborne.filter((one) => normaliseKey(one.registration) === '').length;
        const quietWhy =
          `${unidentified} aircraft of this type ${unidentified === 1 ? 'is' : 'are'} airborne inside ` +
          'your fence without a registration on the air, so ' +
          (unidentified === 1 ? 'it' : 'they') +
          ' cannot be matched to a tail number. Many transponders never send one — it is not a fault in ' +
          'the feed.';
        // Every tail that identified itself belongs on the row, whether or not the survey ever
        // recorded it — that is the only way the green can ever appear for an aeroplane the record
        // happens to have missed.
        const seen = new Set(tails.map((tail) => normaliseKey(tail)));
        for (const one of airborne) {
          const reg = (one.registration ?? '').trim();
          if (reg === '' || seen.has(normaliseKey(reg))) continue;
          tails.push(reg);
          seen.add(normaliseKey(reg));
        }
        const tailsHtml =
          tails.length === 0
            ? '<div class="watch-tails"><span class="small muted">' +
              escapeHtml(
                'No tail number for this type is on record here yet — the feed has not caught one ' +
                  'identifying itself.'
              ) +
              '</span></div>'
            : '<div class="watch-tails">' +
              tails
                .map((tail) => {
                  const key = normaliseKey(tail);
                  const watched = !narrowed || chosen.has(key);
                  const flying = flyingRegs.has(key);
                  const what = flying
                    ? watched
                      ? 'In the air now, and watched'
                      : 'In the air now, but not on your list'
                    : watched
                      ? 'Not in the air at this moment'
                      : 'Not in the air, and not watched — tick it in step 3 to watch only this aeroplane';
                  return (
                    `<span class="tail-chip${flying ? ' tail-air' : ''}${watched ? '' : ' tail-off'}" ` +
                    `data-air="${flying}" data-watched="${watched}" title="${escapeHtml(what)}">` +
                    `${escapeHtml(tail)}</span>`
                  );
                })
                .join('') +
              // 🔴 AND HOW MANY OF THEM CANNOT BE NAMED AT ALL. Without this the row could still say
              // "2 in the air" beside a single green chip, and the reader would be left to guess
              // whether the page had lost one or the transponder never said. It never said, and now
              // the row says so.
              (unidentified > 0
                ? `<span class="tail-chip tail-quiet" title="${escapeHtml(quietWhy)}">` +
                  `+${unidentified} unidentified</span>`
                : '') +
              '</div>';
        return (
          `<li class="watch-type">` +
          `<span class="watch-what">${MARK_STAR}<b>${escapeHtml(info.name)}</b> ` +
          `<span class="mono muted">${escapeHtml(rule.type)}</span>` +
          (entry ? ` <span class="year-tag">${entry.year}</span>` : '') +
          '</span>' +
          // The status replaces the words "stop watching" — see `watchStateOf`. Its `title`
          // carries the longer explanation, so the column stays one line and the reasoning is
          // still one hover away.
          `<span class="watch-state" data-state="${state.kind}" ` +
          `title="${escapeHtml(state.why)}">${escapeHtml(state.text)}</span>` +
          // 🔴 THE SWITCH, BESIDE THE ANSWER IT FILTERS. George, 22 Sep 2026: *"can we add a swtich
          // called show on map, on change the map is reloaded and rezoomed"*.
          this.mapSwitch('type', rule.type, state.kind) +
          (canAsk
            ? `<button type="button" class="linkish type-remove" data-type="${escapeHtml(rule.type)}" ` +
              `data-ga="type-unwatch" title="Stop watching" ` +
              `aria-label="Stop watching ${escapeHtml(info.name)}">${MARK_CROSS}</button>`
            : '') +
          tailsHtml +
          '</li>'
        );
      })
      .join('');

    const namedItems = this.watchlist
      .map((item) => {
        const state = this.watchStateOfTail(item, live);
        // 🔴 THE ROW IS A BOOLEAN, NOT A LINK. George, 22 Sep 2026: *"even though the filight may or may
        // not be in the air, i want this to be a boolean input, not a link"*.
        //
        // It used to be a pressable `<li>`: the row carried the airframe's hex and a press put the map on
        // it — but only while that aircraft was reporting a position, so the control existed and did
        // nothing whenever the aeroplane was on the ground. That is a link with a hidden precondition. The
        // same show-on-map switch a type row carries does the job better and without a condition: it is a
        // boolean, it can be set at any time, and the map answers with what it has.
        return (
          '<li class="watch-type">' +
          `<span class="watch-what">${MARK_STAR}` +
          `<span class="mono">${escapeHtml(item)}</span> — <b>this aircraft</b></span>` +
          `<span class="watch-state" data-state="${state.kind}" ` +
          `title="${escapeHtml(state.why)}">${escapeHtml(state.text)}</span>` +
          // The same switch on a named tail — one aeroplane, which is the finest thing a row can mean.
          this.mapSwitch('tail', item, state.kind) +
          (canAsk
            ? `<button type="button" class="linkish watch-remove" data-key="${escapeHtml(item)}" ` +
              `data-ga="unwatch" title="Stop watching" ` +
              `aria-label="Stop watching ${escapeHtml(item)}">${MARK_CROSS}</button>`
            : '') +
          '</li>'
        );
      })
      .join('');

    host.innerHTML = typeItems + namedItems;

    for (const button of host.querySelectorAll<HTMLButtonElement>('.type-remove')) {
      button.addEventListener('click', () => {
        const code = button.dataset.type ?? '';
        // 🔴 STOPPING WATCHING IS NOT UNDOABLE, SO IT ASKS FIRST — IN THE PAGE'S OWN BOX. George, 22 Sep
        // 2026: *"add a html confirmation box if deleting a watched airplane type"*, and then, about the
        // box: *"i do not want http confirmations. make them html"*. The cross sits beside the switch and
        // removes the row, its tails and its aircraft from the map in one click, with nothing on the page
        // to put it back except finding the type again in step 3 — so it asks, and the question names what
        // is going.
        const info = describeType(code);
        this.askRemove('type', code, `${info.name} ${code}`);
      });
    }

    for (const button of host.querySelectorAll<HTMLButtonElement>('.watch-remove')) {
      button.addEventListener('click', () => {
        // The same question for one named aeroplane, which is the same one-way door.
        const key = button.dataset.key ?? '';
        this.askRemove('tail', key, key);
      });
    }

    this.updateSteps();
  }

  private renderWatchButton(): void {
    const button = byId('notifyBtn');
    const note = byId('notifyNote');
    if (!button || !note) return;
    if (!('Notification' in window)) {
      button.hidden = true;
      note.textContent = 'This browser cannot show notifications, so the bell beside each type cannot reach you.';
      return;
    }

    // 🔴 HOW MANY ARE ARMED, AND WHETHER THAT MATTERS YET. Two silences look identical to a
    // reader: "nothing has left" and "nothing is armed". Since the bell became a separate
    // choice, the common way to get no alerts is to have granted permission and picked
    // nothing — so the note counts the armed types and says which silence this is.
    const armed = this.alertRules.length;
    const what = armed === 0
      ? 'No type is armed for alerts, so nothing will reach you yet — press the bell beside a type in step 3.'
      : `${armed} type${armed === 1 ? '' : 's'} armed for alerts (the bell beside a type in step 3).`;

    if (Notification.permission === 'granted') {
      button.hidden = true;
      note.textContent = `Notifications are on for this site. ${what}`;
      return;
    }
    button.hidden = false;
    button.textContent = Notification.permission === 'denied' ? 'Notifications are blocked' : 'Tell me when they leave';
    note.textContent =
      Notification.permission === 'denied'
        ? `This browser has blocked notifications for this site, so nothing can reach you here. ${what} ` +
          'The table below still updates as aircraft leave.'
        : `Notifications are off. ${what} The table below works either way.`;
  }

  private bindNotify(): void {
    const button = byId('notifyBtn');
    if (!button) return;
    button.addEventListener('click', async () => {
      if (!('Notification' in window)) return;
      try {
        await Notification.requestPermission();
      } catch {
        // expected: older Safari takes a callback instead of a promise, and the
        // callback form above has already been offered.
      }
      this.renderWatchButton();
      track('notifications_asked', { permission: Notification.permission });
    });
  }

  private notify(departure: Departure): void {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const label = departure.callsign || departure.registration || departure.hex;
    const climb = departure.climbFpm !== null ? `, ${departure.climbFpm} ft/min` : '';
    try {
      new Notification(`${label} has left ${this.airportPhrase()}`, {
        body:
          `${departure.verdict === 'confirmed' ? 'It was on the ground and it is not now' : 'It was first seen already climbing'}` +
          ` — ${departure.altitudeFt ?? '?'} ft${climb}, ${Math.round(nmToKm(departure.distanceNm))} km out.`,
        tag: departure.hex,
      });
    } catch {
      // expected: some browsers refuse to build a notification from a page that is not
      // in the foreground. The alert has already fired either way, and the aircraft's
      // phase is corrected in the table on the next render.
    }
  }

  /* ------------------------------------------------- airports around you */

  /**
   * The airport list, built by asking the feed about every identifier.
   *
   * 🔴 POSITIONS ARE FETCHED, NEVER TYPED. `tools/verify-airports.mjs` asks
   * `/api/0/airport/{icao}` for each one and throws away any identifier the feed
   * cannot place — which is the only way to be sure the list is a list of real
   * airports rather than a list of strings that look like airports. It dropped
   * one on 20 Sep 2026: `CYTJ` (Terrace Bay) answered with no usable position.
   */
  private async loadAirports(): Promise<void> {
    const note = byId('nearbyNote');
    try {
      const response = await fetch('/airports.json', { headers: { accept: 'application/json' } });
      this.listedAirports = (await readJson(response)) as AirportsDocument;
    } catch (error) {
      // The reader only loses a longer menu of airports, but the list is served by this
      // site, so a failure to read it is the project's to know about.
      reportFault(error, 'reading the wider airport list');
      this.listedAirports = null;
      if (note) {
        note.textContent =
          'The wider airport list could not be read, so the seven main airports are offered instead. ' +
          (error instanceof Error ? error.message : '');
      }
      return;
    }
    if (note && this.listedAirports) {
      const dropped = this.listedAirports.dropped ?? [];
      this.airportsNote =
        `${this.listedAirports.kept} airports, each one confirmed by asking the feed where it is. ` +
        'Press as many as you like: each one you press is watched, and the map is drawn to fit all of them. ' +
        (dropped.length > 0
          ? `${dropped.length} identifier was dropped because the feed could not place it: ${dropped.join(', ')}.`
          : 'Nothing was dropped.');
      note.textContent = this.airportsNote;
    }
    // 🔴 THE KEPT PLACE IS APPLIED HERE, NOT IN start(). Ordering the airports by
    // distance needs the airport list, and the list has only just arrived — so
    // doing it in start() would sort against an empty list and show the reader
    // nothing near them.
    if (this.restored) {
      const kept = this.restored;
      this.restored = null;
      this.computeNearby(kept.lat, kept.lon, kept.label);
      return;
    }
    this.renderNearby();
  }


  /**
   * 🔴 WHERE YOU ARE, AND HOW FAR THE PAGE IS LOOKING — DRAWN HERE, NOT EMBEDDED.
   *
   * George, 20 Sep 2026: *"maybe google map can show a circle around their location
   * with a marker on the airport with the airport code, not sure"* — and the
   * drawing is right, the source is not. An embedded Google map needs an API key,
   * a billing account, and a request to Google from **every** visitor's browser
   * before they have answered the cookie question — which is the one thing this
   * site's own gate exists to prevent. It would also add a third party to a page
   * whose promise is that it asks the feed, this server, and nobody else.
   *
   * So it is drawn from the two facts that matter: where the reader is, and how
   * far out the fence reaches. The nearest airports carry their codes, the chosen
   * one is drawn larger, and the rings are the distance they picked.
   */
  /**
   * 🔴 THE MAP IS A FREE SERVICE, AND THE BROWSER NEVER TALKS TO IT.
   *
   * George, 20 Sep 2026: *"instead of ggoogle maps, use a free service"*. Chosen
   * by measuring, with no key: `tile.openstreetmap.org` answered 200 with 39861
   * bytes of PNG, CARTO answered 200, OpenTopoMap answered 200, and Stadia
   * answered **401 — it wants a key**. OpenStreetMap is the canonical free one, it
   * is ODbL-licensed, and its own tile policy asks to be cached and to be told who
   * is asking.
   *
   * 🔴 SO EVERY TILE IS FETCHED BY THIS SITE'S OWN SERVER, at `/api/tiles/z/x/y`,
   * and the page points at nothing else. Putting an `<img>` straight at the tile
   * server would work and would be wrong: it hands every reader's address to a
   * stranger on page load, on a site whose first section promises it does not do
   * that, before the cookie question has even been answered. Same shape as the
   * flight feed. Attribution is required by the licence and is printed on the map.
   *
   * The fence, the nearest airports and their codes are drawn on top in SVG, in
   * the same pixel space as the tiles, so they cannot drift out of step with the
   * map underneath them.
   *
   * 🔴 AND THE ZOOM IS CHOSEN TO FIT EVERY AIRPORT THAT WAS PICKED. George, 20 Sep
   * 2026: *"if i select multiple, make sure all are viewable in the maps"*. The
   * old zoom was derived from the fence radius around the reader alone, so an
   * airport outside that circle — which is exactly what a second airport usually
   * is — was drawn off the edge of the view and vanished. A map showing two of the
   * three airports you picked is worse than no map, because it looks complete.
   */
  /**
   * 🔴 WHAT THE MAP'S CIRCLE IS CENTRED ON, SAID OUT LOUD — AND WRITTEN BY THE MAP ITSELF.
   *
   * George, 21 Sep 2026: *"i wanrt from my location"*. With no place known the fence is
   * aimed at the AIRPORT, silently, so a reader who picked Hamilton and never said where
   * they are gets a circle round CYHM and a list of what the feed can see near the airport —
   * while the page's own promise is *"what is in the air around you"*. The number is right
   * and the centre is wrong, which is the harder kind of error to notice.
   *
   * 🔴 IT LIVES HERE, INSIDE THE MAP'S RENDERER, BECAUSE THAT IS WHAT IT DESCRIBES. It was
   * previously called from elsewhere and was deleted from there, which left `#fenceFrom` on
   * the page and EMPTY — a caption with nothing to say, found by a test that asked what the
   * circle is centred on rather than whether the element existed. A caption drawn by its own
   * renderer cannot be separated from the thing it captions again.
   */
  private renderFenceFrom(): void {
    const host = byId('fenceFrom');
    const button = byId<HTMLButtonElement>('fenceFromLocate');
    const shown = this.centre !== null || this.airports.length > 0;
    if (host) host.hidden = !shown;
    if (!shown) {
      if (button) button.hidden = true;
      return;
    }

    if (this.centre) {
      // 🔴 AND WHEN THE CENTRE IS THE READER, THIS PARAGRAPH SAYS NOTHING AT ALL. George, 22 Sep 2026,
      // pasting the sentence back: *"remove The circle is centred on **your location** — Hamilton.
      // Everything on this page is measured from there."* He is right that it was noise — the heading
      // directly above it already reads "How far out from you?", so the paragraph restated the heading
      // and then explained the heading.
      //
      // 🔴 THE OTHER BRANCH BELOW STAYS, AND IT IS NOT THE SAME CASE. A circle drawn round an AIRPORT
      // rather than round the reader is a fact the heading does not carry, it is the reason the list
      // beneath it shows aircraft near an airport instead of near the reader, and it is where the one
      // click that fixes it lives. Removing the noise must not remove the warning.
      if (host) {
        host.innerHTML = '';
        host.hidden = true;
      }
      if (button) button.hidden = true;
      return;
    }

    const picked = this.airports;
    const codes = picked.map((one) => escapeHtml(one.icao)).join(', ');
    const what =
      picked.length > 1
        ? `the middle of the ${picked.length} airports you picked (${codes})`
        : `the airport you picked (${codes})`;
    if (host) {
      host.innerHTML =
        `The circle is centred on <b>${what}</b>, not on you — ` +
        `and the list below is what the feed can see near there.`;
    }

    // Offered only when the browser can answer, and never pressed for the reader.
    if (button) button.hidden = !('geolocation' in navigator);
  }

  private renderMap(): void {
    // 🔴 ONE MAP, AND IT IS THE ONE IN THE WATCHING SECTION. George, 22 Sep 2026: *"i think the
    // circle in the first map can be added to the second map, then the first map can be
    // removed"*. This method was the first map and drew into `#locMap` in step 3; the circle it
    // drew has moved here, and `#locMap` no longer exists anywhere on the page.
    //
    // ⚠️ AND THAT IS WHY IT NO LONGER STANDS IN SOMEBODY ELSE'S FRAME. The second map used to be
    // handed `lastFrame` — the zoom, the tile grid and the projection worked out here — precisely
    // so two maps of one fence could not disagree about where a place is. With one map there is
    // nothing to disagree with, so the frame is computed here and used here, and `lastFrame` is
    // gone.
    const host = byId('watchMap');
    if (!host) return;
    // The sentence belongs to the circle it describes, so it is written here, by the code
    // that draws it. Its absence was measurable: the element was on the page and empty.
    this.renderFenceFrom();
    const at = this.centre;
    // 🔴 WHAT THE FENCE IS AIMED AT, WHICH IS NOT ALWAYS THE READER.
    //
    // With no place known, the fence is aimed at the airports that are picked — and the
    // sentence underneath the distance chips already said so (*"Looking 20 km out from the
    // middle of the airports you picked"*). The map did not: it drew the ring only when
    // there was a centre, so a reader with no location was shown a map with no circle and a
    // caption describing one. Found by measuring the page rather than reading it, and it is
    // the same fault as the ring that was reported missing earlier today.
    const anchor = this.point();

    // 🔴 SOMETIMES THE MAP IS ON ONE AIRCRAFT INSTEAD OF ON THE WHOLE FENCE.
    //
    // George, 22 Sep 2026: *"i want to be able to select one of those rows, if i do that i want the map to
    // zoom in to that flight"*. A picked flight replaces the frame outright — the fence is far too big to
    // be the frame around one aeroplane, and a circle drawn at that zoom would be a wall of green across
    // the view. The selection is read from the engine's own state, so an aircraft that has stopped
    // reporting cannot hold the map.
    const snapshot = this.engine ? this.engine.snapshot() : [];
    const found = this.selectedHex === null
      ? undefined
      : snapshot.find((one) => String(one.hex ?? '').toLowerCase() === this.selectedHex);
    const pickedFlown =
      found && typeof found.lat === 'number' && typeof found.lon === 'number'
        ? (found as TrackState & { lat: number; lon: number })
        : null;
    // What the page calls that aeroplane, built the same way the map's own label builds it — the type's
    // name, then its tail, then the callsign — so the sentence under the map names it exactly as the map
    // does. A code with no name in the table prints as its code, which is what the label does too.
    const pickedInfo = pickedFlown && pickedFlown.type ? describeType(pickedFlown.type) : null;
    const pickedLabel = pickedFlown
      ? [
          pickedInfo ? (pickedInfo.known ? pickedInfo.name : pickedInfo.code) : 'type not transmitted',
          (pickedFlown.registration ?? '').trim(),
          (pickedFlown.callsign ?? '').trim(),
        ]
          .filter((part) => part !== '')
          .join(' · ')
      : '';

    // 🔴 AND SOMETIMES THE MAP IS HELD TO PART OF THAT LIST — because the reader has switched a row off.
    // George, 22 Sep 2026: *"can we add a swtich called show on map, on change the map is reloaded and
    // rezoomed"*, and then the rule that fixed its default: *"the default is to have switches on, and the
    // user can turn them off"*.
    //
    // 🔴 THE FILTER IS APPLIED TO THE SAME LIST THE MAP ALWAYS DREW — watching, inside the fence, seen in
    // the air — so a switched-off row cannot remove anything but its own aircraft, and nothing here can
    // pull in an aircraft the page would not otherwise show. The aircraft are found here, before the
    // frame is computed, because the frame has to be built from THEM rather than from the fence.
    const seenNow = this.seenInTheAirInsideFence(snapshot);
    const watching = seenNow.air;
    const staleAircraft = seenNow.stale;
    const rowFilter = this.mapHide.size > 0 && !pickedFlown;
    const focused = rowFilter ? watching.filter((one) => this.rowVisible(one)) : watching;
    // Named for the caption the way the rows name themselves: the row's own wording where the page drew
    // that row, and the stripped key as the fallback for a name it has not seen yet. These are the rows
    // that are OFF — the caption says what was taken away, which is the shorter and more surprising list
    // now that everything starts on.
    const hiddenNames = [...this.mapHide].map(
      (key) => this.mapRowNames.get(key) ?? key.replace(/^(type|tail):/, '')
    );
    // 🔴 AND IT CAN BE EVERY ROW AT ONCE, WHICH IS A DIFFERENT SENTENCE FROM AN EMPTY SKY. "Nothing of
    // your rows is in the air" and "you have switched everything off" are two different truths, and the
    // reader who has just switched the last row off is owed the second one.
    //
    // ⚠️ COUNTED FROM THE ROWS THAT EXIST, NOT FROM THE SIZE OF THE SET. A key stays in `mapHide` after its
    // row is removed from the list, so a stale entry would let `mapHide.size` overstate how much is
    // switched off and print "every row is switched off" over a list that plainly has a row on.
    const rowKeys = [
      ...this.typeRules.map((rule) => Page.showKey('type', rule.type)),
      ...this.watchlist.map((item) => Page.showKey('tail', item)),
    ];
    const allRowsOff = rowKeys.length > 0 && rowKeys.every((key) => this.mapHide.has(key));

    const needed: { lat: number; lon: number }[] = [
      ...(at ? [at] : []),
      ...this.airports.map((one) => ({ lat: one.lat, lon: one.lon })),
    ];
    if (needed.length === 0) {
      host.innerHTML = '';
      return;
    }

    const TILE = 256;
    // 🔴 THE MAP TAKES THE WIDTH IT IS GIVEN. George, 20 Sep 2026: *"i like the zoom
    // out, but use the full available width for the map"*. It was a fixed 512-pixel
    // box inside a card twice that wide, so half the card sat empty — and worse, the
    // zoom was chosen for a NARROW view, which is half of why it had to zoom out
    // further than it needed to for the same airports to fit.
    const VIEW_W = Math.max(280, Math.round(host.clientWidth) || 512);
    // 🔴 THE MAP IS TALLER THAN IT WAS, WHICH IS WHAT MAKES IT ZOOM IN FURTHER.
    //
    // George, 22 Sep 2026: *"dont forget to zoom in as much as possible with out losing what in on the
    // map"*. The fence is a CIRCLE and the map is a rectangle, so what has to fit is the circle's own
    // diameter in BOTH directions — and the height was the binding constraint at every distance, not the
    // width. Measured on an 854-pixel card, 22 Sep 2026: the 463 km ring needed 261 pixels at zoom 5 and
    // 522 at zoom 6, against 380 usable pixels of a 460-pixel-high map — so one whole zoom step was being
    // given away to the map's own shape, with two thirds of the width unused beside it. At 620 pixels
    // high the same ring fits at zoom 6, which is twice the area of the same map drawn as it was.
    const VIEW_H = Math.round(Math.min(VIEW_W * 0.78, 620));
    // Room for a code label to the right of a mark, so nothing that fits the box is
    // drawn with its label running off the edge of the view.
    const PAD = 40;

    // The box that has to fit, in degrees.
    let minLat = 90;
    let maxLat = -90;
    let minLon = 180;
    let maxLon = -180;
    for (const point of needed) {
      minLat = Math.min(minLat, point.lat);
      maxLat = Math.max(maxLat, point.lat);
      minLon = Math.min(minLon, point.lon);
      maxLon = Math.max(maxLon, point.lon);
    }
    // 🔴 THE ZOOM FOLLOWS ONE RULE: THE BOX HAS TO HOLD THE AIRPORTS, WHERE YOU ARE, AND
    // THE DISTANCE YOU CHOSE.
    //
    // Both halves of the request are true at once — *"only the required zoom out where
    // airports can be seen"* and *"the circle in the map should be based on the how far out
    // from you distance"* — and this is where they are reconciled. An earlier attempt used
    // an ease-out to bring the circle's edge into view and produced **zoom 11 at 10 km,
    // zoom 10 at 20 km and zoom 12 at 50 km**: a larger radius giving a CLOSER view, because
    // the ease succeeded at the small radii and failed at the large one. A map that jumps
    // about as you change a number is worse than a circle whose edge is off screen. So the
    // radius goes into the fit properly, with no easing: monotonic, and the ring whole at
    // every distance. The full-width map is what makes that affordable.
    //
    // 🔴 AND IT IS FOLDED IN HERE, BEFORE THE SPAN IS MEASURED. It was briefly placed after
    // `spanLat`/`spanLon` were computed, which meant the radius was added to a box nobody
    // looked at again — the map chose zoom 14 and drew a 2,870-pixel circle on an 854-pixel
    // map. Nothing about the code looked wrong; the number did.
    //
    // 🔴 AROUND THE AIM, NOT NECESSARILY AROUND THE READER. With no place known the fence is
    // aimed at the middle of the airports being watched (see `point()`), and the ring has to
    // be whole around THAT — the caption underneath already said which one it was.
    if (anchor && !pickedFlown && !rowFilter) {
      const dLat = this.radiusKm / 111.32;
      const dLon = this.radiusKm / (111.32 * Math.max(0.2, Math.cos((anchor.lat * Math.PI) / 180)));
      minLat = Math.min(minLat, anchor.lat - dLat);
      maxLat = Math.max(maxLat, anchor.lat + dLat);
      minLon = Math.min(minLon, anchor.lon - dLon);
      maxLon = Math.max(maxLon, anchor.lon + dLon);
    }
    // 🔴 A PICKED FLIGHT SETS THE FRAME ON ITS OWN, AND THE BOX ABOVE IS THROWN AWAY FOR IT.
    //
    // ⚠️ THE FIRST VERSION OF THIS ADDED THE AIRCRAFT TO A BOX THAT STILL HELD ALL SEVENTY-SIX AIRPORTS,
    // which is worth recording because the code read as though it did the right thing: the map came out at
    // zoom 7 for a flight that could have been shown at 14, because the frame was still a continent wide.
    // The airports, the reader's place and the fence are what the map shows when NOTHING is picked; on one
    // aeroplane they are beside the point, so the box is built from that aeroplane alone.
    //
    // The box takes the aircraft AND every point of the path behind it, because a zoom that cut the path
    // off would lose the thing the map was zoomed in to show — the trail reaches back about ten minutes of
    // flying, which at a jet's speed is about seventy miles, and the two-hundredths-of-a-degree floor the
    // fence fit uses still applies so a nearly stationary aircraft is not taken to a car park.
    if (pickedFlown) {
      const points = [
        { lat: pickedFlown.lat, lon: pickedFlown.lon },
        ...(pickedFlown.trail ?? []).map((point) => ({ lat: point.lat, lon: point.lon })),
      ];
      minLat = 90;
      maxLat = -90;
      minLon = 180;
      maxLon = -180;
      for (const point of points) {
        minLat = Math.min(minLat, point.lat);
        maxLat = Math.max(maxLat, point.lat);
        minLon = Math.min(minLon, point.lon);
        maxLon = Math.max(maxLon, point.lon);
      }
    }
    // 🔴 AND A ROW FILTER SETS THE FRAME THE SAME WAY, FOR THE SAME REASON. The fence is far too big to be
    // the frame around what is left, so the box is built from their positions and the paths behind them
    // and the fence fold above is skipped — which is what stops the ring being drawn as a green wall
    // across a close-up.
    //
    // 🔴 NOTHING TO SHOW LEAVES THE BOX WHERE IT WAS. Every row switched off, or a row with nothing in the
    // air, is a truthful empty map over the airports you picked, and the caption says which of the two it
    // is rather than leaving the reader to wonder whether the page broke.
    if (rowFilter) {
      const points: { lat: number; lon: number }[] = [];
      for (const one of focused) {
        if (typeof one.lat !== 'number' || typeof one.lon !== 'number') continue;
        points.push({ lat: one.lat, lon: one.lon });
        for (const point of one.trail ?? []) points.push({ lat: point.lat, lon: point.lon });
      }
      if (points.length > 0) {
        minLat = 90;
        maxLat = -90;
        minLon = 180;
        maxLon = -180;
        for (const point of points) {
          minLat = Math.min(minLat, point.lat);
          maxLat = Math.max(maxLat, point.lat);
          minLon = Math.min(minLon, point.lon);
          maxLon = Math.max(maxLon, point.lon);
        }
      }
    }
    const midLat = (minLat + maxLat) / 2;
    const midLon = (minLon + maxLon) / 2;
    // 🔴 A FLOOR OF ABOUT TWO KILOMETRES, not half a thousandth of a degree. One
    // airport picked on top of the reader spans almost nothing, and the old floor
    // asked for the closest zoom the tile service has — a satellite view of a car
    // park with a code label on it.
    const spanLat = Math.max(maxLat - minLat, 0.02);
    const spanLon = Math.max(maxLon - minLon, 0.02);
    // 🔴 THE ZOOM IS ONE RULE: THE BOX HAS TO HOLD THE AIRPORTS, WHERE YOU ARE, AND THE
    // DISTANCE YOU CHOSE. See the fold above — this space used to hold a comment claiming the
    // opposite (that the zoom was chosen "for the airports you picked, and for nothing else")
    // directly above code that does not do that. Two contradicting paragraphs about the same
    // three lines is how the next change gets made in the wrong direction.
    const metresPerDegLat = 110_574;
    const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
    const metresPerDegLon = 111_320 * cosLat;
    /** The closest zoom at which a box this many degrees across fits the view. */
    const fittest = (latDeg: number, lonDeg: number): number => {
      for (let candidate = 15; candidate >= 3; candidate -= 1) {
        const candidateScale = (156543.03392 * cosLat) / 2 ** candidate;
        if (
          (lonDeg * metresPerDegLon) / candidateScale <= VIEW_W - PAD * 2 &&
          (latDeg * metresPerDegLat) / candidateScale <= VIEW_H - PAD * 2
        ) {
          return candidate;
        }
      }
      return 3;
    };

    // 🔴 THE AIRPORTS MAY WIDEN THE VIEW BY ONE STEP, AND NO MORE. Found by measuring the map
    // across radius × airports rather than in one case, 21 Sep 2026 — after two rounds of
    // telling George the map was fine, both of which had only looked at a single airport.
    //
    // What the numbers said (852×458 view, PAD 40):
    //
    //     8 km · 1 airport   fence 287 px — fills 76% of the usable height
    //     8 km · 14 airports fence  72 px — fills 19%
    //     0 km · 14 airports fence  11 px — fills  3%, a dot
    //
    // George, 21 Sep 2026: *"the map zoom should change to be zoomed out only to what is
    // necessary"*. He is right, and this is where his two instructions actually collide:
    // 20 Sep he asked that *"if i select multiple, make sure all are viewable in the maps"*,
    // and a far airport can only be viewable by zooming out, which is exactly what shrinks the
    // fence. Holding all fourteen is "necessary" for one request and absurd for the other.
    //
    // So neither is dropped: the fence's own fit is computed, the everything's fit is computed,
    // and the airports are allowed to take the view exactly ONE zoom step wider than the fence
    // needs. That still brings in every airport near enough to matter, and it stops a distant
    // one from turning a 8 km fence into a speck. The reader is who the fence is about, so when
    // the two disagree the fence wins — and the caption already names what is being watched.
    //
    // ⚠️ ONLY WHEN THE READER'S PLACE IS KNOWN. With no place, the fence is aimed at the middle
    // of the picked airports and there is no "your area" to protect, so the airports keep
    // setting the view outright — otherwise the circle would be drawn around marks that had
    // been pushed off the map.
    const spanForFence = anchor
      ? {
          lat: Math.max((this.radiusKm / 111.32) * 2, 0.02),
          lon: Math.max((this.radiusKm / (111.32 * cosLat)) * 2, 0.02),
        }
      : { lat: spanLat, lon: spanLon };
    const zoomForEverything = fittest(spanLat, spanLon);
    const zoomForFence = fittest(spanForFence.lat, spanForFence.lon);
    // A picked flight is the whole of the request, so it takes the frame with nothing else folded in —
    // the box above already holds the aircraft and its path, and "as zoomed in as it can be without
    // losing what is on the map" is exactly `fittest` on that box.
    const zoom = pickedFlown || rowFilter
      ? zoomForEverything
      : at && anchor
        ? Math.max(zoomForEverything, zoomForFence - 1)
        : zoomForEverything;
    const scale = (156543.03392 * Math.cos((midLat * Math.PI) / 180)) / 2 ** zoom;

    const span = 2 ** zoom;
    const middleX = lonToTile(midLon, zoom) * TILE;
    const middleY = latToTile(midLat, zoom) * TILE;
    const left = middleX - VIEW_W / 2;
    const top = middleY - VIEW_H / 2;

    const x0 = Math.floor(left / TILE);
    const x1 = Math.floor((left + VIEW_W - 1) / TILE);
    const y0 = Math.max(0, Math.floor(top / TILE));
    const y1 = Math.min(span - 1, Math.floor((top + VIEW_H - 1) / TILE));

    let tiles = '';
    for (let ty = y0; ty <= y1; ty += 1) {
      for (let tx = x0; tx <= x1; tx += 1) {
        // Wrapped across the antimeridian, clamped before the poles — the two
        // edges of a slippy map are the two places a tile number stops meaning
        // what it says.
        const wrapped = ((tx % span) + span) % span;
        tiles +=
          `<img class="locmap-tile" alt="" width="${TILE}" height="${TILE}" ` +
          `style="left:${(tx * TILE - left).toFixed(0)}px;top:${(ty * TILE - top).toFixed(0)}px" ` +
          `src="/api/tiles/${zoom}/${wrapped}/${ty}.png" decoding="async" />`;
      }
    }

    const spotOf = (lat: number, lon: number): { x: number; y: number } => ({
      x: lonToTile(lon, zoom) * TILE - left,
      y: latToTile(lat, zoom) * TILE - top,
    });
    // 🔴 THE RING IS DRAWN AROUND THE AIM, AND "YOU" IS ONLY DRAWN WHEN IT IS YOU.
    //
    // `you` is the reader; `anchorPx` is where the fence is pointed. With a place known they
    // are the same spot. Without one, the ring sits on the middle of the airports being
    // watched and is labelled as that — because a dot marked "you" on a map that does not
    // know where you are is the page inventing a fact, which is the whole complaint.
    const you = at ? spotOf(at.lat, at.lon) : null;
    const anchorPx = anchor ? spotOf(anchor.lat, anchor.lon) : null;
    const fencePx = (this.radiusKm * 1000) / scale;

    let marks = '';
    // The flight paths, kept apart from everything else so they are laid down FIRST — a path drawn
    // over an aeroplane, or over the circle it is flying inside, is a path drawn over the answer.
    let paths = '';
    // The nearest airports, small and grey, with a line back to the reader. A picked
    // one is skipped here and drawn in its own pass below, so it can never be drawn
    // twice or have something laid over it.
    if (you) {
      for (const row of this.nearby.slice(0, 10)) {
        if (this.isChosen(row.airport.icao)) continue;
        const spot = spotOf(row.airport.lat, row.airport.lon);
        // Off the view is off the view — a marker drawn outside would be clipped
        // anyway, and its label would run back into the map.
        if (spot.x < -30 || spot.x > VIEW_W + 30 || spot.y < -30 || spot.y > VIEW_H + 30) continue;
        marks +=
          `<line class="locmap-line" x1="${you.x.toFixed(1)}" y1="${you.y.toFixed(1)}" ` +
          `x2="${spot.x.toFixed(1)}" y2="${spot.y.toFixed(1)}" />` +
          `<circle class="locmap-airport" cx="${spot.x.toFixed(1)}" cy="${spot.y.toFixed(1)}" r="3.4" />` +
          `<text class="locmap-label" x="${(spot.x + 8).toFixed(1)}" ` +
          `y="${(spot.y + 3.5).toFixed(1)}">${escapeHtml(row.airport.icao)}</text>`;
      }
    }

    // 🔴 EVERY PICKED AIRPORT, DRAWN LAST SO NOTHING IS LAID OVER IT, AND NEVER
    // SKIPPED BY THE OFF-VIEW GUARD THE OTHERS USE. The zoom above was chosen to fit
    // them all, so a picked airport outside the view would mean the arithmetic was
    // wrong — and quietly hiding it is how a wrong zoom stays wrong.
    for (const one of this.airports) {
      const spot = spotOf(one.lat, one.lon);
      if (you) {
        marks +=
          `<line class="locmap-line locmap-line-chosen" x1="${you.x.toFixed(1)}" y1="${you.y.toFixed(1)}" ` +
          `x2="${spot.x.toFixed(1)}" y2="${spot.y.toFixed(1)}" />`;
      }
      marks +=
        `<circle class="locmap-airport locmap-airport-chosen" cx="${spot.x.toFixed(1)}" ` +
        `cy="${spot.y.toFixed(1)}" r="6" />` +
        `<text class="locmap-label locmap-label-chosen" x="${(spot.x + 9).toFixed(1)}" ` +
        `y="${(spot.y + 3.5).toFixed(1)}">${escapeHtml(one.icao)}</text>`;
    }

    // 🔴 THE AIRCRAFT YOU ARE WATCHING, DRAWN ON THE SAME MAP AS THE CIRCLE.
    //
    // George, 22 Sep 2026: *"i think the circle in the first map can be added to the second map,
    // then the first map can be removed"*. So this is the second map's content — the aircraft the
    // reader picked, at the positions the feed reported, each turned onto its track with the path
    // it has flown behind it — and it is drawn here, in the frame computed above, because there is
    // no longer a second map to hand that frame to.
    //
    // 🔴 AND THE CIRCLE IS WHAT MAKES THE TWO SETS OF SHAPES ONE PICTURE. The aircraft are filtered
    // to the fence by the engine, so without the ring a reader cannot tell whether an empty map
    // means nothing is flying or nothing is flying *here*. The ring is that answer.
    // 🔴 THE MAP DRAWS THE SAME AIRCRAFT THE TABLE LISTS — the reader's own filters, inside the fence they
    // chose, seen in the air. It used to draw *everything they watch*, which is why a 25 km fence could show
    // a two-shape map with a caption apologising for fifty-eight aircraft nobody could see. Two lists that
    // can disagree are two lists that eventually will; this is one.
    //
    // 🔴 AND IT IS `focused` RATHER THAN THE WHOLE LIST, which is the only difference a row switch makes:
    // the same list, filtered to the rows that are switched on. See where it is built.
    const placed = focused.filter(
      (one): one is (typeof one & { lat: number; lon: number }) =>
        typeof one.lat === 'number' && typeof one.lon === 'number'
    );

    // Drawn AFTER the airports and after the reader's own mark, so nothing is laid over a plane.
    let planes = '';
    let drawn = 0;
    // 🔴 AND AIRCRAFT THAT ARE SIMPLY OUTSIDE THE FRAME ARE NOT THE SAME AS AIRCRAFT WITH NO POSITION.
    //
    // This loop `continue`d past an off-view aircraft and the note below counted every aircraft it had
    // not drawn as *"on the list without a reported position yet"* — which was survivable while the frame
    // was built to hold them all, and became a plainly false sentence the moment a picked flight zoomed
    // the map to one aeroplane and left the other fifty-nine outside it. They have positions; they are
    // off the edge. Two counts, because they are two facts.
    let offView = 0;
    let traced = 0;
    let graded = 0;
    // 🔴 THE RATE OF CLIMB OF THE READING ON SCREEN, BECAUSE A TRAIL CAN BE TOO SHORT TO SAY.
    //
    // A path is classified from the altitudes ON ITS POINTS whenever they have them — that is the
    // real profile of the flight. But a trail built before this change (a tab that has not been
    // reloaded), or one whose transponder sends position without altitude, has nothing to compare,
    // and the honest fallback is the rate the aircraft is reporting NOW: it turns a path with no
    // history into "this is climbing at 2,000 ft a minute as it draws", which is true and useful,
    // rather than into a flat grey line that says it is level when nobody knows that.
    const rateByHex = new Map<string, number>();
    for (const reading of this.lastReadings) {
      if (typeof reading.baro_rate === 'number') rateByHex.set(reading.hex.toLowerCase(), reading.baro_rate);
    }
    for (const one of placed.slice(0, 60)) {
      const spot = spotOf(one.lat, one.lon);
      // Off the view is off the view, and saying so below is better than clipping it silently.
      if (spot.x < 0 || spot.x > VIEW_W || spot.y < 0 || spot.y > VIEW_H) {
        offView += 1;
        continue;
      }
      drawn += 1;
      // 🔴 AND THIS IS THE MOMENT THE PAGE CAN HONESTLY SAY A TYPE WAS ON THE MAP — see `mapLastDrawn`.
      const drawnType = String(one.type ?? '').trim().toUpperCase();
      if (drawnType !== '') this.mapLastDrawn.set(drawnType, Date.now());

      // The flight path, from what this page has heard across polls — the feed reports only where
      // an aircraft is now. Two points are needed to be a path: one point is a position, and
      // joining a single point would draw a line that says something the page does not know.
      const trail = one.trail ?? [];
      if (trail.length >= 2) {
        traced += 1;
        const spots = trail.map((point) => ({ ...spotOf(point.lat, point.lon), alt: point.alt ?? null }));
        // 🔴 ONE LINE PER SEGMENT, EACH COLOURED BY WHAT HAPPENED BETWEEN ITS TWO ENDS.
        //
        // George, 22 Sep 2026: *"did you implement the gradient trail on the map to indicate that
        // it is climbing or otherwise, with a colour hue to indicate that, with legend"*. It was
        // not implemented and it could not have been: a path drawn from latitude and longitude is
        // a path ON THE GROUND, so every climb and every descent looked identical, and the trail
        // answered the one question a flight path is drawn to answer with a line that said
        // nothing. A single `<polyline>` cannot carry a changing colour, which is why this is now
        // a line per segment — the drawing IS the gradient.
        const fallback = rateByHex.get(one.hex.toLowerCase());
        let gradedHere = false;
        for (let index = 1; index < spots.length; index += 1) {
          const from = spots[index - 1];
          const to = spots[index];
          const hue = climbHue(from.alt, to.alt, fallback);
          if (hue !== 'unknown') gradedHere = true;
          paths +=
            `<line class="locmap-trail locmap-trail-${hue}" ` +
            `x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" ` +
            `x2="${to.x.toFixed(1)}" y2="${to.y.toFixed(1)}" />`;
        }
        if (gradedHere) graded += 1;
      }

      // 🔴 THE AEROPLANE, THEN ITS WHOLE NAME, THEN THE TAIL — and its nose on its trajectory.
      // George, 21 Sep 2026: *"i want the map identifying planes by their full airplane name
      // **Cirrus SR22T** like this"*; 22 Sep: *"the airplane should point towards its
      // trajectory"*. The shape's nose is at the top of its box, which is north, and a true track
      // is degrees clockwise from north, so a plain `rotate()` about the same origin as the
      // translate puts the nose on the track. No heading from the feed means no rotation: the icon
      // keeps pointing up, and the page does not assert the aircraft is heading north.
      const info = describeType(one.type);
      const name = info.code ? (info.known ? info.name : info.code) : 'type not transmitted';
      const tail = (one.registration || '').toUpperCase().trim();
      const what = [name, tail || null]
        .filter((part): part is string => part !== null && part !== '')
        .join(' · ');
      const heading =
        typeof one.trackDeg === 'number' ? ` rotate(${one.trackDeg.toFixed(1)})` : '';
      const picked = pickedFlown !== null && String(one.hex ?? '').toLowerCase() === String(pickedFlown.hex ?? '').toLowerCase();
      // 🔴 WHO IS THIS SHAPE, SO THE MAP ITSELF CAN BE PRESSED. George, 22 Sep 2026: *"click on any aircraft in
      // the air is not zooming into that aircraft … the map should zoom into it"*. A drawing of an aeroplane on
      // a map is the most obvious thing on the page to click, and it carried no identity at all — the hex was
      // in the table's DOM and nowhere else. It is on the mark AND on its label, because the name beside the
      // aeroplane is part of the aeroplane as far as a reader is concerned.
      const who = escapeHtml(String(one.hex ?? ''));
      const press = ` data-hex="${who}" title="${escapeHtml(
        picked ? 'Press to go back to all flights' : 'Press to put the map on this aircraft'
      )}"`;
      planes +=
        `<g class="locmap-plane-mark${picked ? ' locmap-plane-mark-picked' : ''}"${press} ` +
        `transform="translate(${spot.x.toFixed(1)} ${spot.y.toFixed(1)})${heading}">` +
        // 🔴 AND A FULL-SIZE PRESS AREA. The aeroplane is drawn at about 14 pixels across — measured on the
        // live page — which is a hard target for a mouse and an impossible one on a phone. A transparent
        // circle of 15 pixels' radius sits under the shape, so anywhere near the aeroplane counts as pressing
        // it. It is inside the group, so it inherits the mark's `data-hex` and its pointer cursor, and it is
        // drawn FIRST so the icon and the ring stay on top of it.
        '<circle class="locmap-plane-hit" r="15" cx="0" cy="0" />' +
        `<path class="locmap-plane-icon" transform="scale(0.72) translate(-12 -12)" d="${PLANE_PATH}" />` +
        '</g>' +
        // 🔴 THE PICKED AIRCRAFT IS RINGED IN THE SAME GREEN AS ITS ROW, so the row and the map cannot
        // be read as being about two different aeroplanes. It is drawn from the same mark as the row's
        // border, which is what George asked for — *"the select and unselected can be a simple green
        // hue border"* — rather than a second, louder colour the page uses nowhere else.
        (picked
          ? `<circle class="locmap-plane-pick" cx="${spot.x.toFixed(1)}" cy="${spot.y.toFixed(1)}" r="17" />`
          : '') +
        `<text class="locmap-plane-label${picked ? ' locmap-plane-label-picked' : ''}"${press} ` +
        `x="${(spot.x + 11).toFixed(1)}" y="${(spot.y + 4).toFixed(1)}">${escapeHtml(what)}</text>`;
    }
    // `placed` is what has a position; anything on the list that is not in it has none, and that is the
    // only thing this number may now mean — see the note on `offView`.
    const unplaced = watching.length - placed.length;

    const described =
      this.airports.length === 1
        ? `the airport you picked (${this.airports[0].icao})`
        : `${this.airports.length} airports you picked (${this.chosenIcaos().join(', ')})`;

    const html =
      `<div class="locmap" style="width:${VIEW_W}px;height:${VIEW_H}px">` +
      tiles +
      `<svg class="locmap-over" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" ` +
      `aria-label="A map showing ${escapeHtml(described)}` +
      (pickedFlown
        ? `, zoomed to one aircraft: ${escapeHtml(pickedLabel)}`
        : anchorPx
          ? `, a ${this.radiusKm} kilometre circle around ${you ? 'your position' : 'the airports you are watching'}`
          : '') +
      `, the nearest other airports marked with their codes` +
      (drawn === 0
        ? ', and no aircraft on your list inside it at the moment'
        : `, and ${drawn} aircraft you are watching, each pointing along its track with its flight path behind it`) +
      `">` +
      // Paths first, so nothing is ever drawn across one.
      paths +
      // 🔴 THE FENCE IS NOT DRAWN WHEN THE MAP IS ON ONE AIRCRAFT. At that zoom the circle's edge is
      // hundreds of kilometres away, so the only thing it could draw is a green wall across the view —
      // and it would make the page look as though the fence had become tiny. The note below says which
      // frame is in use, so the ring's absence is stated rather than left to be puzzled over.
      (anchorPx && !pickedFlown && !rowFilter
        ? `<circle class="locmap-fence" cx="${anchorPx.x.toFixed(1)}" cy="${anchorPx.y.toFixed(1)}" r="${fencePx.toFixed(1)}" />`
        : '') +
      marks +
      (you
        ? `<circle class="locmap-you" cx="${you.x.toFixed(1)}" cy="${you.y.toFixed(1)}" r="5" />` +
          `<text class="locmap-you-label" x="${you.x.toFixed(1)}" ` +
          `y="${(you.y + 18).toFixed(1)}" text-anchor="middle">you</text>`
        : anchorPx
          ? `<circle class="locmap-anchor" cx="${anchorPx.x.toFixed(1)}" cy="${anchorPx.y.toFixed(1)}" r="5" />` +
            `<text class="locmap-you-label" x="${anchorPx.x.toFixed(1)}" ` +
            `y="${(anchorPx.y + 18).toFixed(1)}" text-anchor="middle">watched</text>`
          : '') +
      planes +
      // 🔴 THE BOX CLOSES HERE, AND THE KEY SITS OUTSIDE IT. `.locmap` is a fixed size with its
      // contents clipped, so a legend placed inside it would be cut off the bottom of the map on
      // the one day it is needed.
      '</svg></div>' +
      // 🔴 THE KEY IS NOT DECORATION — WITHOUT IT THE COLOURS ARE A CODE NOBODY CAN READ. George
      // asked for the hue *"with legend"* in the same sentence, and he is right that one without
      // the other is worse than neither: a reader who cannot tell green from amber will invent a
      // meaning for it.
      '<div class="locmap-legend">' +
      '<span class="legend-item"><i class="legend-line legend-climb"></i>climbing</span>' +
      '<span class="legend-item"><i class="legend-line legend-level"></i>level</span>' +
      '<span class="legend-item"><i class="legend-line legend-descend"></i>descending</span>' +
      '<span class="legend-item"><i class="legend-line legend-unknown"></i>altitude not reported</span>' +
      '</div>' +
      // 🔴 ONE NOTE, BECAUSE THERE IS ONE MAP. Two notes describing two maps is two places for the
      // same fact to drift, and the sentence that used to sit here — *"in the same frame as the map
      // above"* — described a map that no longer exists.
      '<p class="small muted locmap-note">The map is ' +
      '<a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a>, free and with no API key. ' +
      (pickedFlown
        ? `It is zoomed to <b>${escapeHtml(pickedLabel)}</b>, with the path this page has heard behind it, instead of the ${this.radiusKm} km circle — press that aircraft on the map to go back to every flight, or press <b>Show all flights</b> under the map. `
        : rowFilter
          ? allRowsOff
            ? `The frame is left where it was, because every row in your list is switched off — <b>${escapeHtml(hiddenNames.join(', '))}</b>. `
            : `It is fitted to what is left after the rows you switched off — <b>${escapeHtml(hiddenNames.join(', '))}</b> — instead of the ${this.radiusKm} km circle, which is far too wide to be the frame around them. `
          : anchor
            ? `It is fitted so the ${this.radiusKm} km gap you chose is inside the frame, together with the airports you picked — a ring you can only see part of is no use as a distance. `
            : 'It is fitted to the airports you picked. ') +
      (drawn === 0
        ? allRowsOff
          ? 'The map has nothing to draw. Switch one back on, or press <b>Show all flights</b> under it. '
          : rowFilter
            ? 'Nothing of the rows still switched on is in the air inside your fence at this moment, so ' +
              'the map has no aircraft on it. Press <b>Show all flights</b> under it to switch every row ' +
              'on again. '
            : 'Nothing you are watching is inside the fence at this moment, so the map is drawn with ' +
              'no aircraft on it — it stays where it is, and one appears the moment the feed sees it. '
        : pickedFlown
          ? 'Only that aircraft is drawn at this zoom — the map goes back to the whole fence when you ' +
            'press <b>Show all flights</b> under it. '
          : rowFilter
            ? 'Only the aircraft of the rows still switched on are drawn' +
              `${focused.length === 1 ? ' — one aircraft. ' : ` — ${focused.length} of them. `}` +
              'Press <b>Show all flights</b> under it to switch every row on again. '
            : 'Every aircraft seen in the air inside the fence, named in full and drawn where the ' +
              'feed last reported it. ') +
      (traced > 0
        ? 'The line behind an aircraft is the path it has flown in the last few minutes, drawn ' +
          'from what this page has heard — the feed reports only where a plane is now. ' +
          'Its colour is what the aircraft did between two readings: ' +
          '<b>green</b> where it gained height, <b>amber</b> where it lost it, <b>blue</b> where it ' +
          'held it, and a <b>dashed blue</b> where the reading carried no altitude to compare. ' +
          (graded > 0 ? '' : 'No aircraft on the map is reporting an altitude yet, so every path is dashed. ')
        : '') +
      (offView > 0
        ? `${offView} more ${offView === 1 ? 'is' : 'are'} on your list outside this frame, so they are ` +
          'listed and not drawn. '
        : '') +
      // 🔴 AND ONE THE FEED HAS STOPPED REPORTING IS NOT DRAWN AT ALL — which the reader has to be told,
      // because the row above may still name the aeroplane. See `heardRecently`.
      (staleAircraft > 0
        ? `${staleAircraft} ${staleAircraft === 1 ? 'aircraft has' : 'aircraft have'} not been heard from ` +
          'for a couple of minutes, so ' +
          `${staleAircraft === 1 ? 'it is' : 'they are'} listed and not drawn — the feed reports where an ` +
          'aircraft is now, and it is not reporting these. '
        : '') +
      (unplaced > 0
        ? `${unplaced} ${unplaced === 1 ? 'is' : 'are'} on the list without a reported position ` +
          'yet, so they are listed and not plotted. '
        : '') +
      'The tiles are fetched by this site\'s own server rather than by your ' +
      'browser, so the map service never sees you — the same way the flight feed is handled.' +
      '</p>';

    // 🔴 NOTHING CHANGED, SO NOTHING IS WRITTEN — which is also how an empty map stops costing
    // anything. George, 21 Sep 2026: *"can you stop updating when there are no plans in the air?"*.
    // With no aircraft the markup above is identical on every poll, so this comparison makes that
    // free. The guard moved here with the map: it used to sit in the second map's own method.
    if (html !== this.lastPlot) {
      this.lastPlot = html;
      host.innerHTML = html;
    }

    // 🔴 AND THE WAY BACK IS SHOWN ONLY WHEN THERE IS SOMETHING TO GO BACK FROM, which is why it is written
    // here rather than in the markup: a control that is always on screen and usually does nothing is a
    // control nobody trusts. George, 22 Sep 2026: *"i need a way to return to all flights"*. It sits
    // OUTSIDE `#watchMap`, because everything inside that element is rewritten by the line above.
    const all = byId('flightAll');
    if (all) {
      // 🔴 IT IS THE WAY BACK FROM EITHER FRAME — one picked aircraft, or rows switched off. Both are the
      // same control because both are the same request: stop narrowing it, and show me everything again.
      all.hidden = this.selectedHex === null && this.mapHide.size === 0;
      all.title = pickedFlown
        ? `Go back from ${pickedLabel} to every flight you are watching`
        : rowFilter
          ? 'Switch every row back on, and go back to every flight you are watching'
          : 'Back to every flight you are watching';
    }
  }

  /**
   * 🔴 THE MAP IS REDRAWN WHEN THE BOX CHANGES SIZE. The tiles are placed by pixel,
   * so a wider card cannot reflow the drawing to fit — the box has to be measured and
   * the map drawn again. A resize listener on the window would miss the case that
   * matters most here: a step that was folded open, or a card that grew when a note
   * filled in. A ResizeObserver sees all of them.
   */
  private bindMapResize(): void {
    const host = byId('watchMap');
    if (!host || typeof ResizeObserver === 'undefined') return;
    let last = host.clientWidth;
    new ResizeObserver(() => {
      const width = Math.round(host.clientWidth);
      // A folded-away card measures zero, and redrawing on zero would throw the map
      // away and not bring it back.
      if (width === 0 || Math.abs(width - last) < 24) return;
      last = width;
      this.renderMap();
    }).observe(host);
  }

  /**
   * 🔴 THE SCHEDULE PANEL WAS HERE, AND ALL THREE OF ITS METHODS ARE GONE WITH IT —
   * `loadHistoric`, `renderHistoric` and `historicDays`. George, 22 Sep 2026: *"remove this section,
   * if these plans show up then they show up"*.
   *
   * What it drew was a museum, its eight aircraft, and the days it intends to fly them, followed by an
   * admission that the feed had never once reported one of them. A schedule promises the future on a page
   * that reports the past, and the reader was left to reconcile the two. The page now says only what it
   * measured: if one of those aeroplanes goes up and transmits, it appears in the table like anything else.
   *
   * The three methods are DELETED rather than left uncalled, for the reason this file has recorded twice:
   * code that reads as though it works, reaching for an element that no longer exists, is worse than code
   * that is gone.
   */

  private renderNearby(): void {
    const host = byId('nearbyList');
    const head = byId('nearbyHead');
    const note = byId('nearbyNote');
    if (!host || !this.listedAirports) return;

    // 🔴 WITH NO LOCATION THERE IS NO SUCH THING AS "NEAR YOU", SO NOTHING IS OFFERED.
    //
    // George, 20 Sep 2026: *"if you dont know location. there should be no airports seen
    // expect selected one."* He was right, and the page was doing the opposite: a heading
    // reading **"Airports around you"** over a paragraph telling the reader to type a
    // postal code. Both are claims about a place we do not have. "Around you" is not a
    // heading this page is entitled to before it knows where you are, and a list that is
    // really an empty state dressed as a list is worse than no list at all.
    //
    // So with no centre there is no list and no heading. What survives is what the reader
    // already chose — an airport they picked is a fact, not a distance, and it has to stay
    // on screen or they cannot unpick it.
    if (this.centre === null) {
      const picked = (this.listedAirports.airports ?? []).filter((one) => this.isChosen(one.icao));
      if (picked.length === 0) {
        host.innerHTML = '';
        host.hidden = true;
        if (head) head.hidden = true;
        if (note) note.hidden = true;
      } else {
        host.hidden = false;
        if (head) {
          head.hidden = false;
          // 🔴 "YOU PICKED IT" IS A CLAIM ABOUT THE READER, AND SOMETIMES IT IS FALSE. George,
          // 20 Sep 2026, about this heading — and the reason it is a whole sentence rather than one
          // word is that the page used to hand every new reader an airport they had not chosen.
          // **It no longer does**: this branch is reached only when the reader has a place or an
          // airport of their own — see the seeding note in the constructor — so "you are watching"
          // is now true of something they did. It still does not say "you picked" on a page that
          // cannot know whether they tapped a chip or gave a location that implied it.
          head.textContent = picked.length === 1 ? 'The airport you are watching' : 'The airports you are watching';
        }
        host.innerHTML = picked.map((airport) => this.nearChip(airport, null)).join('');
        if (note) {
          note.hidden = false;
          note.textContent =
            'No place is known yet, so there is nothing to order these by and nothing else to offer. ' +
            'The rest of the list appears — nearest first — once the page knows where you are.';
        }
      }
      this.wireNearChips(host);
      this.renderDistance();
      return;
    }

    // From here on there IS a place, so a distance exists and the list can be ordered by it.
    host.hidden = false;
    if (head) {
      head.hidden = false;
      // 🔴 THE HEADING GETS THE SAME TREATMENT AS THE LABEL, OR THE SAME PLACE IS PRINTED
      // TWO WAYS ON ONE CARD. George, 20 Sep 2026, pasting this exact heading back:
      // *"remove ### Airports around Hamilton (Confederation Park / Nashdale / East Kentley /
      // Riverdale / Lakely / Grayside / North Stoney Creek), Ontario"* — the label above it
      // had been cleaned and the heading was still reading the postcode's coverage aloud,
      // followed by the province.
      //
      // So it says the same short name the label does: the community the reader named, or
      // the town, and never the parenthetical, the postcode or the province. "Airports
      // around Hamilton" is a heading; "Airports around Hamilton (seven communities),
      // Ontario" is the postal service's own coverage note printed as though it were a
      // place. They are not the same sentence and only one of them belongs on a heading.
      const shown = stripBrackets(this.nearbyPlace());
      head.textContent = shown ? `Airports around ${shown}` : 'Airports around you';
    }
    if (note) {
      note.hidden = false;
      // 🔴 THE TEXT IS PUT BACK ON EVERY PATH. It was written once by `loadAirports` and
      // then overwritten by the no-location branch — so a reader who gave their location
      // back up and then set it again read *"No place is known yet"* underneath a heading
      // that named the place. A sentence that is only written in one branch is stale in
      // the other, and this is the same trap the page had already shipped once.
      note.textContent = this.airportsNote;
    }
    if (this.nearby.length === 0) {
      host.innerHTML = '';
      this.renderDistance();
      return;
    }
    host.innerHTML = this.nearby
      .slice(0, 14)
      .map(({ airport, km }) => this.nearChip(airport, km))
      .join('');
    this.wireNearChips(host);
    this.renderDistance();
  }

  /**
   * One airport, as a chip — drawn in ONE place, so both lists cannot drift apart.
   *
   * 🔴 AN AIRPORT IS A CHOICE, SO IT TAKES THE YELLOW — AND NOTHING ELSE. George, 20 Sep
   * 2026: *"selecting an airport should hava star and yellow hue"*, then *"remove start
   * that are in chip, i just want the yellow hue only"*. The colour is the mark; a star
   * repeated on every chip is the same fact drawn twice.
   *
   * 🔴 AND IT IS A TOGGLE. George, 20 Sep 2026: *"i should also be able to select
   * multiple airport"*. The label says what pressing it will do rather than what the
   * airport is, because that is the question a reader has while their pointer is over it.
   *
   * `km` is null when there is no place to measure from, and then the chip carries no
   * distance — one invented from nowhere would be worse than none.
   */
  private nearChip(airport: ListedAirport, km: number | null): string {
    const picked = this.isChosen(airport.icao);
    return (
      `<button type="button" class="ghost chip near-chip" data-icao="${escapeHtml(airport.icao)}" ` +
      `aria-pressed="${picked}" title="${picked ? `Stop watching ${airport.icao}` : `Also watch ${airport.icao}`}" ` +
      `data-ga="airport-near">` +
      `<span class="mono">${escapeHtml(airport.icao)}</span> ${escapeHtml(airport.location || airport.name)}` +
      (km === null ? '' : `<span class="near-km">${Math.round(km)} km</span>`) +
      `</button>`
    );
  }

  private wireNearChips(host: HTMLElement): void {
    for (const button of host.querySelectorAll<HTMLButtonElement>('.near-chip')) {
      button.addEventListener('click', () => void this.toggleAirport(button.dataset.icao ?? ''));
    }
  }

  /**
   * 🔴 A DISTANCE NEEDS SOMETHING TO MEASURE FROM, AND THE PAGE HIDES THE QUESTION WHEN
   * THERE IS NOTHING.
   *
   * George, 20 Sep 2026: *"if you dont know location. there should be no airports seen
   * expect selected one."* The same reasoning reaches the distance block: **"How far out
   * from you?"** is not a question this page may ask before it knows where you are, and a
   * 20 km circle drawn around nothing is a drawing of an idea. The fence note underneath
   * was saying *"Looking 20 km out from the airport"* when there was no airport on the map
   * and no place to be near — a sentence with no subject.
   *
   * With an airport picked but no place, the distance IS meaningful — measured from that
   * airport — so the block stays and the heading says so.
   */
  /**
   * 🔴 THE SENTENCE UNDER THE SLIDER IS GONE. George, 20 Sep 2026: *"remove this
   * Looking 80 km out from your own position — 43 nautical miles, which is the unit the
   * feed takes. A long distance sees a great deal of traffic, and very little of it on the
   * ground — the two pull in opposite directions."*
   *
   * He is right that it earns nothing: a reader who has just moved a slider to 80 km does
   * not need to be told that 80 km is 43 nautical miles, and the trade-off it describes is
   * the one the slider already makes visible by being a slider. The number and the plain
   * description under the track say what was chosen; the rest was the page explaining
   * itself. It read the distance back in a unit the reader never asked for and then
   * editorialised about it.
   */
  private renderDistance(): void {
    const hasCentre = this.centre !== null;
    const shown = hasCentre || this.airports.length > 0;
    // ⚠️ THE MAP IS NOT IN THIS LIST ANY MORE. It used to be hidden and shown with the distance
    // controls, because it lived in step 1 beside them and then in step 3 at the end of the type
    // list. It now lives in step 4, whose own gating decides whether it can be seen at all, so a
    // `hidden` flag set here would fight it — and would leave the map invisible for good the first
    // time a reader reached step 4 with no place picked yet.
    // ⚠️ THE HEADING IS NOT IN THIS LIST ANY MORE, BECAUSE THERE IS NO HEADING. The distance used to be
    // an `<h3>How far out from you?</h3>` and this method both hid it and rewrote it (*"How far out from
    // the airports you picked?"*). George, 22 Sep 2026: *"### How far out from you? iws not the same
    // font and color as the others, call is distance instead"* — so the label is a `chip-label` inside
    // the row now, the same as `Kind`, `Year` and `Last seen`. What the heading carried that the label
    // does not is the one thing that mattered: that the fence is measured from the reader or from the
    // airports. That is `#fenceFrom`'s job, and it already says it — in the airport case only.
    for (const id of ['radiusButtons']) {
      const element = byId(id);
      if (element) element.hidden = !shown;
    }
    if (!shown) return;
    this.renderMap();
  }

  private computeNearby(
    lat: number,
    lon: number,
    label = '',
    town = '',
    areas: string[] = [],
    /**
     * A community the reader has ALREADY CHOSEN. Only the place search passes one.
     *
     * 🔴 SOMETHING THE READER TYPED MUST NOT BE ASKED BACK. George, 20 Sep 2026: *"i want to
     * search for location by name, similiar to what inputresponse.com does"* — and a reader who
     * typed "Stoney Creek", read a list, and pressed *"Stoney Creek, Hamilton, Golden
     * Horseshoe"* has answered the community question. The first cut dropped it: the search
     * returned `area: "Stoney Creek"`, the page set the label from the town only, printed
     * "Hamilton", and offered the community as a chip — asking again what it had just been told.
     *
     * It is matched against `areas` rather than trusted blindly, so a name that is not one of
     * this place's communities cannot become the label.
     */
    preferredArea = ''
  ): void {
    const list = this.listedAirports?.airports ?? [];
    if (list.length === 0) return;
    // 400 km, because that is roughly the reach of the list as it stands. The
    // filter is not decoration: three of the identifiers in the source region
    // file are far outside it — Brampton's CNC3 is fine, but a mistyped code
    // resolved to Paramount Bistcho in northern Alberta, and a list that
    // offered that as an airport "near you" would be worse than a shorter list.
    this.nearby = list
      .map((airport) => ({ airport, km: nmToKm(distanceNm(lat, lon, airport.lat, airport.lon)) }))
      .filter((row) => row.km <= 400)
      .sort((a, b) => a.km - b.km);
    // 🔴 THE READER'S PLACE IS NOW THE CENTRE OF EVERYTHING — the fence, the
    // chart and the airport order all hang off it, because the question is what
    // is in the air around THEM.
    this.centre = { lat, lon };
    // Kept so a reload does not forget where the reader is. The label travels with
    // it, because "restored to Hamilton (Riverdale)" is an answer and a pair of
    // coordinates is not.
    this.placeLabel = label;
    this.placeTown = town;
    this.placeAreas = areas;
    // A community only counts while it belongs to the area being looked at, so a new
    // place clears the old one rather than carrying a name from another town. And the name
    // the reader just picked beats the one remembered from last time.
    const remembered = readStore(AREA_KEY, '');
    this.placeArea = areas.includes(preferredArea)
      ? preferredArea
      : areas.includes(remembered)
        ? remembered
        : '';
    writeStore(CENTRE_KEY, JSON.stringify({ lat, lon, label }));
    this.renderPlace();
    this.renderNearby();
    // 🔴 RE-ARMED EVEN WITH NO AIRPORT. `this.point()` falls back to the centre, and
    // the poll only ever needed a point — so a reader whose airport lookup failed
    // can still say where they are and be shown what is in the air around them. The
    // old `if (this.airport)` guard meant the steps appeared with nothing behind
    // them, which is a dead end dressed as progress.
    this.rearm();
    this.updateSteps();
    track('nearby_computed', { count: this.nearby.length });
  }

  /**
   * Search for a place by NAME, then let the reader pick from the matches.
   *
   * 🔴 THE INTERACTION GEORGE ASKED FOR BY NAME. George, 20 Sep 2026: *"i want to search for
   * location by name, similiar to what inputresponse.com does"*. That site takes a typed city
   * and hands back a short list for the player to pick from, so the choice is explicit rather
   * than inferred. This does the same: the results appear as chips, and nothing is applied to
   * the page until one of them is pressed.
   *
   * 🔴 NOTHING IS CHOSEN AUTOMATICALLY, AND THAT IS THE POINT OF THE LIST. "Hamilton" is a city
   * in Ontario, a city in Ohio, and a dozen other places; a search box that silently took the
   * first match would move the reader's fences to another country without saying so. The list is
   * short (six), each entry carries the province or state, and the reader decides.
   *
   * It searches on submit rather than on every keystroke — see the note on the route in
   * tools/serve.mjs: the free geocoder behind it allows about one request a second, and a page
   * that leaned on it would be abusing a service it does not pay for.
   */
  private bindPlaceSearch(): void {
    const form = byId<HTMLFormElement>('placeSearchForm');
    const input = byId<HTMLInputElement>('placeSearchInput');
    const results = byId('placeResults');
    const note = byId('placeSearchNote');
    if (!form || !input || !results) return;

    const clearResults = (): void => {
      results.innerHTML = '';
      results.hidden = true;
    };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (value.length < 2) {
        if (note) note.textContent = 'Type at least two characters of a place name.';
        return;
      }
      clearResults();
      if (note) note.textContent = `Looking for ${value}…`;
      try {
        const response = await fetch(`/api/geo/search?q=${encodeURIComponent(value)}`, {
          headers: { accept: 'application/json' },
        });
        const body = (await readJson(response)) as {
          ok?: boolean;
          error?: string;
          places?: { label?: string; name?: string; area?: string; region?: string; lat?: number; lon?: number }[];
          note?: string;
        };
        const places = (body.places ?? []).filter(
          (place) => typeof place.lat === 'number' && typeof place.lon === 'number'
        );
        if (!body.ok || places.length === 0) {
          if (note) note.textContent = body.error ?? `Nothing matched “${value}”. Try a town and its province or state.`;
          return;
        }

        results.hidden = false;
        results.innerHTML = places
          .map(
            (place, index) =>
              `<button type="button" class="chip chip-small place-result" ` +
              `data-index="${index}" data-ga="place-result">` +
              `${escapeHtml(place.label ?? place.name ?? '')}</button>`
          )
          .join('');
        for (const button of results.querySelectorAll<HTMLButtonElement>('.place-result')) {
          button.addEventListener('click', () => {
            const picked = places[Number(button.dataset.index)];
            if (!picked || typeof picked.lat !== 'number' || typeof picked.lon !== 'number') return;
            const town = picked.name ?? picked.label ?? 'that place';
            // The community is carried when the geocoder named one — the same field the
            // path puts in its chips — so the label can say "Stoney Creek" rather than the town
            // it sits in. When it is empty the town leads, which is the same rule as everywhere
            // else on this card.
            // 🔴 THE COMMUNITY IS CARRIED, BECAUSE THE READER JUST CHOSE IT. The geocoder returns
            // the object's own name separately from the administrative town — "Stoney Creek" and
            // "Hamilton" — and this row in the list said both, so the reader has already picked
            // the community by picking the row. It goes in as the preferred area rather than as a
            // chip to press afterwards.
            this.computeNearby(picked.lat, picked.lon, town, town, picked.area ? [picked.area] : [], picked.area ?? '');
            if (note) {
              note.textContent = `${picked.label ?? town} — airports below are ordered by distance from there. ${body.note ?? ''}`.trim();
            }
            clearResults();
            track('place_picked', { by: 'search', count: this.nearby.length });
          });
        }
        if (note) note.textContent = `${places.length} place${places.length === 1 ? '' : 's'} matched “${value}”. Pick the right one:`;
      } catch (error) {
        // The lookup goes through this site's own server, so a failure here is either the
        // server or the free map service behind it — never the reader's mistake.
        reportFault(error, 'searching for a place');
        if (note) {
          note.textContent =
            'The place search could not be reached. ' +
            (error instanceof Error ? error.message : '') +
            ' Finding you by position still works.';
        }
      }
    });
  }

  private bindLocate(): void {
    this.bindPlaceSearch();
    const button = byId<HTMLButtonElement>('locateBtn');
    const note = byId('locateNote');

    // 🔴 TWO BUTTONS, ONE ACTION. `#fenceFromLocate` sits beside the map and asks exactly the
    // same question as `#locateBtn` — put the fence on me — so both run this one handler
    // rather than a second copy that would drift out of step. George, 21 Sep 2026:
    // *"i wanrt from my location"*. BOTH bindings are needed: the fence button sat on the
    // page with no listener at all after an edit removed the code that used to bind it.
    //
    // Each press reports into the note nearest it, so the message appears beside the control
    // that was pressed rather than in another step of the page.
    const aim = (pressed: HTMLButtonElement, into: HTMLElement | null): void => {
      if (!('geolocation' in navigator)) {
        if (into) into.textContent = 'This browser cannot report a position. Pick an airport by name instead.';
        return;
      }
      pressed.disabled = true;
      if (into) into.textContent = 'Asking your browser where you are…';
      track('locate_asked', {});
      navigator.geolocation.getCurrentPosition(
        (position) => {
          pressed.disabled = false;
          void this.nameMyPosition(position.coords.latitude, position.coords.longitude, into);
        },
        (error) => {
          pressed.disabled = false;
          if (into) {
            into.textContent =
              `Your browser did not give a position (${error.message}). Pick an airport by name below instead — ` +
              'nothing else on the page depends on knowing where you are.';
          }
        },
        { timeout: 10_000, maximumAge: 300_000 }
      );
    };

    if (button) button.addEventListener('click', () => aim(button, note));
    const fromButton = byId<HTMLButtonElement>('fenceFromLocate');
    if (fromButton) fromButton.addEventListener('click', () => aim(fromButton, byId('fenceFrom')));
  }

  /**
   * Name the place the browser put us, and order the airports from it.
   *
   * 🔴 THE PAGE USED TO WRITE "your position" AND LEAVE IT THERE. George, 20 Sep 2026: *"when
   * i clicked find me, it says your position"*. That is the label directly under the heading
   * "Your location", and it names nothing — the reader is told where they are in a way that
   * would be true of anybody standing anywhere.
   *
   * So the coordinates go to this site's own server, which asks a free map service to name
   * the town they fall in. Two things follow from that and both are said on the page: the
   * coordinates leave the browser (to this server, not to a third party and never to the
   * feed), and the answer is a TOWN — the community inside it is not in the free map data,
   * which is why the reader is offered the community the geocoder names, when it names one.
   *
   * If the naming fails the page prints the coordinates it was actually given, rather than
   * falling back to the empty phrase. A pair of numbers is a worse answer than a name and a
   * far better one than nothing.
   */
  private async nameMyPosition(lat: number, lon: number, note: HTMLElement | null): Promise<void> {
    const fallback = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    try {
      const response = await fetch(`/api/geo/reverse?lat=${lat}&lon=${lon}`, {
        headers: { accept: 'application/json' },
      });
      const body = (await readJson(response)) as {
        ok?: boolean;
        place?: string;
        town?: string;
        region?: string;
        areas?: string[];
        district?: string;
        note?: string;
      };
      // 🔴 THE PLACE NAME LEFT THIS ERROR ON 23 Sep 2026. It read
      // `new Error(body.place ?? 'no name')`, and `body.place` is the name of the town
      // the reader's own coordinates fall in — a fact about where they are, carried as
      // the text of an error. Nothing the reader sees changed; what changed is that a
      // visitor's position can no longer be the text of an error at all, which is the
      // property the fault report rests on.
      //
      // 🔴 AND THIS IS NO LONGER A THROW, FOR THE SAME REASON IT IS NO LONGER AN ERROR
      // MESSAGE (23 Sep 2026). "The free map data has no town for this coordinate" is an
      // ANSWER, not a fault, and throwing it made the expected case indistinguishable
      // from the broken one — the catch below could not tell a service that is down from
      // a field with no name, so neither could the fault report. Falling out of the
      // `try` now means "no name here", which is the fallback below, and the catch is
      // reserved for failing to ask at all.
      if (body.ok && body.town) {
        this.computeNearby(lat, lon, body.town, body.town, Array.isArray(body.areas) ? body.areas : []);
        // 🔴 ONE CLAUSE, AND GEORGE ASKED FOR IT THAT WAY. His words, 20 Sep 2026, pasting the
        // paragraph back: *"i dont want any of this anymore"*. It had grown into three sentences —
        // that a coordinate names the town it falls in, that a community name is not in the free
        // map data, that the postal code is what carries one, and then a disclosure about what
        // happens to the coordinates. The first three explained a limitation that no longer has
        // anything to do with the reader (the postal route is gone), and the disclosure has moved
        // to the top of the card, said once, where it covers every way in rather than one.
        if (note) {
          note.textContent = `Ordered by distance from ${body.town}${body.region ? `, ${body.region}` : ''}.`;
        }
        track('locate_named', { named: true });
        return;
      }
    } catch (error) {
      // Failing to ASK is a fault — the lookup unreachable, or an answer that was not JSON.
      // The reader would otherwise be shown a pair of numbers with no explanation of why.
      reportFault(error, 'naming the position from its coordinates');
    }
    // No name came back. Show the numbers the browser gave us — they are real, and the
    // reader can see for themselves that the page is not pretending to know more.
    this.computeNearby(lat, lon, fallback);
    if (note) {
      note.textContent = `Ordered by distance from ${fallback} — the position your browser gave.`;
    }
    track('locate_named', { named: false });
  }

  /* --------------------------------------------------------- the live view */

  /**
   * 🔴 THE "IN THE AIR RIGHT NOW" VIEW IS GONE, AND ITS CODE WENT WITH IT — the card, the top-down
   * chart, the second table, and both of the methods that filled them.
   *
   * George, 22 Sep 2026: *"remove this section What is in the air around you now, matching what you
   * picked."*, with the card pasted back in full. It was a SECOND view of the same aircraft as the
   * card above it — that one already lists what the feed can see, filtered to the reader's own
   * picks, and it carries the airport, the callsign, the phase and the position.
   *
   * `matchedAirborne()` and `renderLive()` existed only to fill it, so leaving them behind would
   * leave two charts nobody asks for and a table that can never be filled — the exact fault this
   * file was repaired for on 21 Sep 2026, when markup was deleted and the code that reached for it
   * stayed, doing nothing and reading as if it worked.
   *
   * 🔴 THE MAP DID NOT GO WITH IT. The one map lives in the watching section and is drawn by
   * `renderMap` below — the circle, the airports and the aircraft you are watching are all in it.
   */

  /* ------------------------------------------------------------- watchlist */

  /**
   * 🔴 THE BY-NAME FORM IS GONE, AND ITS CODE WENT WITH IT. George, 21 Sep 2026:
   * *"### Or one aircraft by name i dont want this, just show a map"*.
   *
   * `bindWatchForm()`, `#watchForm`, `#watchInput` and `#watchStatus` are all removed
   * together, and so is `addWatch()` — its only caller was this form. That matters more
   * than it looks: deleting the markup while leaving the code behind is the exact fault
   * this file was repaired for earlier the same day, because a handler that returns on a
   * missing element does nothing, silently, and reads as if it works.
   *
   * A named aircraft can still be taken OFF the list — `renderWatchlist()` draws those
   * rows and `removeWatch()` still serves them — so nobody is left holding a rule they
   * cannot clear.
   */

  private removeWatch(key: string): void {
    this.watchlist = this.watchlist.filter((item) => normaliseKey(item) !== normaliseKey(key));
    this.saveWatchlist();
    this.renderWatchlist();
    this.renderAircraft();
  }
}

const page = new Page();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => page.start());
} else {
  page.start();
}
