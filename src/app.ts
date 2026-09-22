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
  DEFAULT_AIRPORT,
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
  type Match,
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
 * 🔴 KILOMETRES, NOT NAUTICAL MILES. George, 20 Sep 2026: *"nobody understand
 * nm"*. The feed takes nautical miles and says so in its own endpoint summary
 * (*"Aircrafts surrounding a point (lat, lon) up to 250nm"*), so the conversion
 * happens in `kmToNm` and the reader never meets the unit. Each distance says
 * what it means in plain words as well as in kilometres, because "20 km" is a
 * number and "the airport and the city around it" is an answer.
 */
/**
 * 🔴 THE DISTANCE IS A SHORT LOGARITHMIC LADDER: EVERY STOP IS TWICE THE ONE BEFORE IT.
 *
 * George, 20 Sep 2026: *"How far out from you? maybe this should be a slider? logrythmic?"* — then,
 * 22 Sep 2026: *"i forgot the slider is actually a filter for pic an aircraf. lets remove the slider and
 * ask the distance about the pick an aircraf under kind"*, and in the same message *"make the option
 * logrythmic"* and *"thse 4 filters are getting cluttery"*.
 *
 * 🔴 SO THE STOPS WERE CUT FROM SEVENTEEN TO SIX, AND THE PROGRESSION IS THE REASON. Equal RATIOS are
 * what a logarithmic scale means: 5 → 10 → 20 → 40 → 80 → 160 km puts the detail where the reader can
 * use it (the difference between 5 and 10 km is the difference between seeing an aircraft on the apron
 * and not) and spends no width on stops nobody can tell apart (the difference between 100 and 125 km is
 * nothing at all). Seventeen chips that doubled the row into three lines was the clutter he named.
 *
 * 5 km to 160 km still covers what the page is good at: below 5 the round loses the airport's own apron,
 * and past 160 the fence on a 30-minute poll is wider than any aircraft can be watched across.
 */
const RADIUS_LADDER = [5, 10, 20, 40, 80, 160];


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

/** One end of a route, as this site's own proxy normalises it — never adsbdb's words. */
interface RouteEnd {
  icao: string;
  iata: string;
  /** The city the airport serves, e.g. "Boston". */
  city: string;
  /** Two-letter country, e.g. "US". */
  country: string;
  /** The airport's full name, e.g. "Logan International Airport". */
  name: string;
}

/**
 * 🔴 A ROUTE IS A LOOKUP, NOT A READING, AND IT IS A DIFFERENT KIND OF CLAIM.
 *
 * ADS-B does not carry a destination. Measured 22 Sep 2026 against the feed itself:
 * `/v2/callsign/DAL1719` answers with the aircraft record — hex, registration, type, altitude,
 * track — and no origin, no destination, no route. An aircraft broadcasts WHO IT IS, never where
 * it is booked to. So the destination on this table comes from a callsign lookup (`api.adsbdb.com`,
 * free, no key) and never from the radio, and the footnote under the table says so in those words.
 *
 * Everything on the row that was MEASURED and everything that was LOOKED UP therefore sit in
 * different columns, and only the looked-up one can be wrong about today: a flight can be diverted,
 * a callsign can be reused for another leg, and the record can simply be out of date.
 */
interface RouteInfo {
  airline: string;
  origin: RouteEnd;
  destination: RouteEnd;
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
 * How far round the compass one point is from another, in degrees from north.
 *
 * 🔴 IT WAS DELETED WITH THE CHART AND IT HAS COME BACK FOR THE TABLE. `bearingDeg` and the compass
 * tables used to serve the top-down radar drawing, and when George removed that card on 22 Sep 2026
 * their only caller went with it. His next instruction gave them a new one: *"can be add bearing like
 * NW, S, N, etc"* — so they are restored here rather than reinstated as the special case they would
 * have been if the table had grown its own copy of the arithmetic.
 */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const p1 = lat1 * toRad;
  const p2 = lat2 * toRad;
  const dl = (lon2 - lon1) * toRad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 🔴 THE COMPASS, TWICE: WORDS FOR A TOOLTIP AND LETTERS FOR A CELL. *"204°" is a number and
 * "south-south-west" is a place — but `SSW` is a place that fits in a column two characters wide,
 * which is what a table that was too wide needs. Both come from the SAME index, so they cannot
 * disagree about which of the sixteen it is. */
const COMPASS = ['north', 'north-north-east', 'north-east', 'east-north-east', 'east', 'east-south-east', 'south-east', 'south-south-east', 'south', 'south-south-west', 'south-west', 'west-south-west', 'west', 'west-north-west', 'north-west', 'north-north-west'];
const COMPASS_SHORT = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Which of the sixteen, as an index — the one place the rounding happens. */
function compassIndex(degrees: number): number {
  return Math.round(degrees / 22.5) % 16;
}

function compassPoint(degrees: number): string {
  return COMPASS[compassIndex(degrees)];
}

function compassPointShort(degrees: number): string {
  return COMPASS_SHORT[compassIndex(degrees)];
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
    return [];
  }
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function readStore(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — the session still works, it just does not survive a reload */
  }
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

/**
 * Where an aircraft is, to the precision the feed actually means — or a dash.
 *
 * Four decimals is roughly eleven metres, which is finer than a position derived by
 * multilateration deserves; more digits would be precision theatre. A hemisphere is named
 * because the numbers alone do not tell a reader whether they are looking at their own
 * half of the world.
 */
function positionText(state: { lat?: number; lon?: number }): string {
  if (typeof state.lat !== 'number' || typeof state.lon !== 'number') {
    return '<span class="muted">—</span>';
  }
  return `${state.lat.toFixed(4)}, ${state.lon.toFixed(4)}`;
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
  private radiusKm = 20;
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
  /** The raw readings from the last poll — the table and the map are drawn from these. */
  private lastReadings: Reading[] = [];

  /**
   * 🔴 THE ROUTES, REMEMBERED PER CALLSIGN AND ASKED FOR AT MOST ONCE.
   *
   * Three states, and the difference between two of them is the whole reason this is a Map of
   * `RouteInfo | null` and not a Set:
   *
   *   absent      → nobody has asked yet, so the cell says so rather than claiming there is none
   *   `null`      → the lookup answered, and there is NO ROUTE ON FILE for this callsign
   *   `RouteInfo` → the route it holds
   *
   * `routeRetryAt` is what stops a lookup that FAILED (a timeout, a 503, a moment offline) from
   * being retried on every poll for the rest of the session — and stops it from being remembered as
   * "no route", which would turn a network blip into a fact about the aircraft.
   */
  private routes = new Map<string, RouteInfo | null>();
  private routeAsked = new Set<string>();
  private routeRetryAt = new Map<string, number>();
  private routeRepaint: number | null = null;

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
      // A corrupt store is not worth failing over; the reader simply starts again.
      this.restored = null;
    }

    this.buildRadiusButtons();
    this.buildTypeFilter();
    this.buildSeenFilter();
    this.renderPlace();
    this.renderWatchlist();
    this.bindNotify();
    this.renderWatchButton();
    this.bindStepToggles();
    this.bindStartOver();
    this.bindLocate();
    this.bindChangePlace();
    this.bindVisibility();
    this.bindMapResize();

    // 🔴 A COMMA-SEPARATED LIST, BECAUSE SEVERAL CAN BE PICKED NOW. A value written
    // before this change is a single identifier, which splits to a list of one — so
    // a session saved by the older page comes back rather than being discarded.
    const saved = readStore(AIRPORT_KEY, DEFAULT_AIRPORT)
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter((code) => /^[A-Z0-9]{3,4}$/.test(code));
    void this.loadChosenAirports(saved.length > 0 ? saved : [DEFAULT_AIRPORT]);
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
    for (const km of RADIUS_LADDER) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip chip-small';
      button.textContent = `${km} km`;
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
   * The distance actually in use, snapped to a stop on the ladder.
   *
   * 🔴 IT IS SNAPPED BECAUSE A KEPT VALUE CAN BE OFF THE LADDER. A distance stored by an earlier
   * version, or a ladder that later loses a stop, leaves `radiusKm` holding a number no chip prints —
   * and then no chip is pressed, which reads as "nothing is chosen" while the page is measuring
   * perfectly well. Snapping to the nearest stop means the pressed chip is always the distance in use.
   */
  private currentRadius(): number {
    return RADIUS_LADDER.reduce(
      (best, km) => (Math.abs(km - this.radiusKm) < Math.abs(best - this.radiusKm) ? km : best),
      RADIUS_LADDER[0] ?? this.radiusKm
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
      return (
        'The feed asked us to slow down (HTTP 429). It is volunteer-funded and answers a limited number of ' +
        'requests, and this page had been asking every ten seconds. It has slowed itself down to give the feed ' +
        'room, and it will speed back up on its own — the table below keeps the last reading it managed to get.'
      );
    }
    if (response.status >= 500) {
      return (
        `The feed's own server is having trouble (HTTP ${response.status}). That is at their end, not yours and ` +
        'not this site\'s: api.adsb.lol is a volunteer service and its gateway sometimes fails for a moment, ' +
        'then recovers. The page keeps asking, and the table below keeps the last reading it got.'
      );
    }
    if (!response.ok) {
      return (
        `The feed answered HTTP ${response.status}. The page keeps asking every ten seconds, so this may clear ` +
        'on its own.'
      );
    }
    return null;
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
        if (!response.ok) throw new Error(`The feed answered ${response.status} for ${icao}.`);
        resolved = parseAirport(icao, payload);
      } catch (error) {
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
    writeStore(AIRPORT_KEY, this.chosenIcaos().join(','));
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
    // distance is in use from the start (20 km, or the last one chosen), so there IS something to
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
        this.lastError = `the feed answered ${response.status}`;
        // 🔴 BEING REFUSED IS A REASON TO ASK LESS OFTEN, NOT TO KEEP ASKING. Ten
        // seconds was too fast even before a limit was hit; doubling on the refusal
        // and creeping back on every success is what lets the page recover by
        // itself instead of sitting in a rate limit until somebody reloads.
        if (response.status === 429) {
          this.pollMs = Math.min(POLL_MAX_MS, Math.max(POLL_START_MS, this.pollMs * 2));
          this.startTimer();
        }
        this.setStatus(trouble, 'error');
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
      const before = this.liveTypes.size;
      for (const reading of readings) {
        const type = String(reading.t || '').trim().toUpperCase();
        if (!type || type === '-' || type.length > 6) continue;
        this.liveTypes.set(type, (this.liveTypes.get(type) ?? 0) + 1);
      }
      if (this.liveTypes.size !== before) this.renderTypeList();

      const departures = this.engine.ingest(readings, Date.now());

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
      // The page keeps the last good picture and says what went wrong, rather
      // than emptying the table and looking like nothing is there.
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
    const body = byId('aircraftBody');
    if (!body || !this.engine) return;
    // 🔴 THE GATE IS CHECKED ON EVERY DRAW, NOT ONLY WHEN A STAR IS PRESSED. A reload, a restored
    // selection or a rule removed by clearing storage all land here, and the card must not be
    // able to show a table whose list is empty because nothing was ever picked.
    this.renderLiveGate();

    // 🔴 ONLY THE AIRCRAFT THE READER ACTUALLY ASKED ABOUT. George, 20 Sep 2026: *"this
    // should only list the selected flights and or tail"*.
    //
    // It listed every aircraft in the fence, which made the card a firehose: a reader who
    // had starred a helicopter and named one tail number still had to read thirty rows
    // about airliners passing over. The page already knows what was picked — the starred
    // types and the named tails are step 3 and step 5 — so the table shows those and
    // nothing else. `matchOf` decides, and it is the engine's rule rather than a second
    // copy written here.
    const all = this.engine.snapshot();
    const rows = all.filter((state) => this.isWatchedNow(state)).slice(0, 60);

    if (rows.length === 0) {
      // The empty state has to say WHICH empty it is. "Nothing in the fence" over a card
      // that is deliberately filtered would be a lie: there may be forty aircraft out
      // there and none of them the reader's.
      body.innerHTML =
        all.length === 0
          ? '<tr><td colspan="6" class="muted">Nothing in the fence at this moment. Aircraft appear and disappear as they pass.</td></tr>'
          : '<tr><td colspan="6" class="muted">Nothing in the fence matches what you picked. ' +
            `The feed can see ${all.length} aircraft right now, and none of them is on your list — ` +
            'star a type in step 3, or name a tail number, and they will appear here.</td></tr>';
      // 🔴 THE MAP IS DRAWN ON THIS PATH TOO, AND IT DID NOT USE TO BE.
      //
      // This returned before the map was drawn, so a poll that found nothing on the list left the
      // map showing whatever was on it a moment ago — an aircraft that had already left. That was
      // survivable while a second map in another step carried the same shapes and was refreshed by
      // other paths; it is not survivable now that this is the only map on the page. Found while
      // merging the two, and fixed in the same change.
      this.renderMap();
      this.tickWatchStates();
      return;
    }

    // 🔴 EVERY ROW NAMES ITS OWN TYPE, AND THE FULL-WIDTH GROUP LINE IS GONE.
    //
    // George, 22 Sep 2026: *"the line in the middle is confusing, A21N Airbus A321neo 1 aircraft
    // …"* — and it was. The table named a type in a `<tr>` that spanned every column, so a reader
    // met something that LOOKED like a row and answered a question the row beneath it was already
    // answering; with a single aircraft under it, all it said was "1 aircraft". The type is now a
    // column on the row it belongs to, and the rows are still SORTED by type, so the list reads in
    // exactly the order it did before — without the line that did not fit its own columns.
    //
    // 🔴 THE AIRPORT COLUMN IS GONE, AND THE ROUTE CARRIES ITS OWN CITIES. George, 22 Sep 2026:
    // *"remove airport column, and move the DESTINATION column to be the first column"*. The column
    // said which airport the aeroplane was nearest — a fact about WHERE IT IS, on a row that already
    // answers that twice over with the bearing and the position, and it was the widest cell on a
    // table that has had to be narrowed twice. The city now rides with the code it belongs to, in the
    // one cell where a four-letter code without a place beside it would be a code nobody can read.
    //
    // ⚠️ THE NEAREST AIRPORT IS STILL WORKED OUT, because it still orders the list. Two aircraft of
    // the same type, passing two different airports, hold a stable order that way instead of sorting
    // by nothing; it is simply no longer printed.
    const rowsSorted = rows
      .map((state) => ({ state, airport: this.nearestAirportTo(state) }))
      .sort((a, b) => {
        const an = describeType(a.state.type).name;
        const bn = describeType(b.state.type).name;
        return (
          an.localeCompare(bn) ||
          (a.airport ?? 'zz').localeCompare(b.airport ?? 'zz') ||
          a.state.callsign.localeCompare(b.state.callsign)
        );
      });

    const html: string[] = [];
    for (const { state } of rowsSorted) {
      const label = state.callsign || state.registration || state.hex;
      // 🔴 THE TAIL NUMBER, PRINTED UNDER THE AIRCRAFT TYPE. George, 22 Sep 2026: *"for type list the
      // tail under the aircraft type"*. A row whose callsign column is carrying a callsign (ACA123)
      // leaves the aeroplane itself unnamed, and the registration is the name a reader can act on — it
      // is the one step 5 watches by. It is printed only when the callsign column is not already showing
      // the same string, so no row ever names the same aeroplane twice, and only when a type is named,
      // because on a row where nothing was transmitted there is no type for it to sit under.
      const tailReg = (state.registration ?? '').trim();
      const tailUnderType = tailReg !== '' && normaliseKey(tailReg) !== normaliseKey(label);
      // 🔴 NAMED BY THE READER, OR CAUGHT BY A TYPE THEY STARRED. Every row here is
      // selected — that is the whole point of the filter above — so the highlight can no
      // longer mean "selected". It means the narrower and rarer thing: you named this
      // tail number yourself, rather than it arriving because a type you starred was up.
      const byName = this.matchKind(state) === 'aircraft';
      const phase =
        state.phase === 'ground'
          ? '<span class="tag tag-ground">on the ground</span>'
          : state.phase === 'airborne'
            ? '<span class="tag tag-air">airborne</span>'
            : '<span class="tag tag-unknown">no altitude</span>';
      const info = state.type ? describeType(state.type) : null;
      html.push(
        // 🔴 EVERY REAL ROW CARRIES A CLASS OF ITS OWN, BECAUSE "NOT A GROUP ROW" WAS NOT
        // ENOUGH TO TELL A DATA ROW FROM A PLACEHOLDER. The empty states above are single
        // `<tr>`s with a `colspan` cell, so `tr:not(.type-group)` matches them too — and a
        // test waiting for `#aircraftBody tr:not(.type-group)` was satisfied by the sentence
        // saying there was nothing to show. Measured: one rewritten test passed on the
        // placeholder alone, which is a false pass, and a false pass is worse than a
        // failure because it is read as cover.
        // 🔴 THE DESTINATION IS THE FIRST COLUMN, AND IT READS IN THE DIRECTION IT TRAVELLED. George,
        // 22 Sep 2026: *"move the DESTINATION column to be the first column, and use from and to with
        // a little arrow, not to and from"*. It led with the arrival airport and mentioned the
        // departure underneath, which is the fact in the wrong order — a reader wants to know where it
        // came FROM before they are told where it is going, and the arrow is what carries the one to
        // the other. The cell itself is built by `destinationCell`, so the three states an answer can
        // be in — on its way, none on file, and known — are all decided in one place.
        `<tr class="aircraft-row${byName ? ' watched-row' : ''}">` +
        this.destinationCell(this.routeOf(state.callsign)) +
        `<td>${
          info
            ? `<span class="mono">${escapeHtml(info.code)}</span>` +
              (info.known ? `<span class="cell-type">${escapeHtml(info.name)}</span>` : '') +
              (info.known && tailUnderType
                ? `<span class="cell-tail">${escapeHtml(tailReg)}</span>`
                : '')
            : '<span class="muted">not transmitted</span>'
        }</td>` +
        `<td><b>${escapeHtml(label)}</b></td>` +
        `<td>${phase}</td>` +
        // 🔴 THE LAST-READING COLUMN IS GONE. George, 22 Sep 2026: *"fdor last reading just remove
        // that"* — in the same message that said the table was too wide. It held a clock time AND a
        // relative age, and it was one of the two widest cells on the row; the page's own freshness
        // now reads above the map (`#radiusRefreshed`), which is where a reader goes to ask whether
        // the page is still live.
        //
        // ⚠️ WHAT WENT WITH IT, SAID OUT LOUD RATHER THAN DISCOVERED LATER: the per-ROW age. One
        // aircraft's reading can be much older than the page's last poll — a transponder that has gone
        // quiet keeps its row for up to forty-five minutes — and nothing on the row says so any more.
        // If that turns out to matter more than the width did, the age belongs back as a `· 8s`
        // inside the Phase cell, which costs no column at all.
        `<td class="mono bearing">${this.bearingCell(state)}</td>` +
        // 🔴 THE POSITION, WHERE THE WATCH LINK USED TO BE. George, 20 Sep 2026:
        // *"remove the watch link, can you put long/lat"*. Watching is done by picking —
        // a type in step 3 or a tail number in step 5 — so a control on every row was a
        // second way to do the same thing, in the one place a reader is trying to read.
        // Four decimals is about eleven metres, which is as much as the position means.
        `<td class="mono pos">${positionText(state)}</td>` +
        '</tr>'
      );
    }
    body.innerHTML = html.join('');

    // 🔴 THE AGES ARE UPDATED WITHOUT RE-RENDERING THE TABLE. "12s ago" is wrong a second
    // after it is written, and the page polls on a schedule that runs from 15 seconds to
    // three minutes — so a time rendered only on a poll would sit there saying "12s ago"
    // while the gap grew to two minutes, which is exactly the reassurance a stalled page
    // should not give. Rewriting the table every second would throw away the reader's
    // scroll position and their text selection to change a few characters, so only the
    // age spans are touched.
    this.tickReadingAges();

    // 🔴 THE MAP IS DRAWN WHERE THE POSITIONS ARRIVE, AND LAST.
    //
    // It plots aircraft the FEED reports, so drawing it only when the list changes leaves it stale
    // the moment an aircraft appears. Drawing it at the END means the table is never delayed by the
    // map, and the two always describe the same poll. Calling it is cheap: `lastPlot` skips the
    // write whenever the picture has not changed.
    //
    // ⚠️ AND IT IS THE ONE MAP — the circle, where you are, the airport codes and the aircraft you
    // are watching, all in one picture. The empty-list path above draws it too, which the old
    // second map did not do from here.
    this.renderMap();
    // And the row's own status is brought up to date in the same pass, so the row and the map
    // cannot describe different moments — see `tickWatchStates`.
    this.tickWatchStates();
  }

  /**
   * 🔴 WHICH WAY IT IS FROM YOU, IN TWO LETTERS RATHER THAN TWO NUMBERS.
   *
   * George, 22 Sep 2026: *"can be add bearing like NW, S, N, etc"*. The chart that used to answer
   * this went with the second table, and it is the one thing that view gave the page that the table
   * did not: `43.3733, -79.3760` is a POSITION, and "north-west, 12 km away" is an ANSWER. It is also
   * the narrowest way to say it, which is why it earns a column on a table that was too wide.
   *
   * 🔴 IT IS FROM THE CENTRE OF THE FENCE, WHICH IS NOT ALWAYS YOU. With a place known the fence is
   * drawn round the reader and this is the direction from them; with only airports picked it is the
   * direction from the airports, and the paragraph above the map says which. The title spells the
   * whole thing out and carries the distance, so neither fact has to fit in the cell.
   */
  private bearingCell(state: TrackState): string {
    const at = this.point();
    if (!at || typeof state.lat !== 'number' || typeof state.lon !== 'number') {
      return '<span class="muted">—</span>';
    }
    const degrees = bearingDeg(at.lat, at.lon, state.lat, state.lon);
    const km = nmToKm(distanceNm(at.lat, at.lon, state.lat, state.lon));
    const title = `${compassPoint(degrees)} of the fence's centre, about ${km} km away`;
    return `<span title="${escapeHtml(title)}">${compassPointShort(degrees)}</span>`;
  }

  /**
   * The route for a callsign, asking for it the first time it is seen.
   *
   * Returns `undefined` while the answer is still on its way — which the cell prints as
   * "asking…" rather than as a dash, because an unanswered question and a question with the
   * answer "nobody has one" are different things and a reader is entitled to tell them apart.
   */
  private routeOf(callsign: string): RouteInfo | null | undefined {
    const key = String(callsign ?? '').trim().toUpperCase();
    // A callsign is two to eight letters and digits. Anything else is not a callsign, and asking
    // about it would spend a request on a shape the lookup cannot answer.
    if (!/^[A-Z0-9]{2,8}$/.test(key)) return null;
    if (this.routes.has(key)) return this.routes.get(key) ?? null;
    if (!this.routeAsked.has(key)) {
      const retryAt = this.routeRetryAt.get(key) ?? 0;
      if (Date.now() >= retryAt) {
        this.routeAsked.add(key);
        void this.askRoute(key);
      }
    }
    return undefined;
  }

  private async askRoute(callsign: string): Promise<void> {
    try {
      const response = await fetch(`/api/route/${encodeURIComponent(callsign)}`, {
        headers: { accept: 'application/json' },
      });
      const trouble = this.feedTrouble(response);
      if (trouble) throw new Error(trouble);
      const body = (await response.json()) as { ok?: boolean; route?: RouteInfo | null };
      if (!body.ok) throw new Error('the route lookup refused the request');
      this.routes.set(callsign, body.route ?? null);
    } catch {
      // 🔴 A FAILED LOOKUP IS NOT A MISSING ROUTE. It is forgotten rather than stored, so the cell
      // keeps saying "asking…" and the question can be asked again — but not on every poll, which
      // is what `routeRetryAt` is for.
      this.routeAsked.delete(callsign);
      this.routeRetryAt.set(callsign, Date.now() + 5 * 60 * 1000);
    }
    this.scheduleRouteRepaint();
  }

  /**
   * One repaint for however many routes land at once.
   *
   * Ten rows can easily produce ten answers in the same second, and repainting the table ten times
   * would rewrite the reader's scroll position, their text selection and the map for no gain —
   * which is the same reasoning the age ticks use.
   */
  private scheduleRouteRepaint(): void {
    if (this.routeRepaint !== null) return;
    this.routeRepaint = window.setTimeout(() => {
      this.routeRepaint = null;
      this.renderAircraft();
    }, 250);
  }

  /**
   * The route cell — which LEADS the row — in one direction, from where it came to where it is going.
   *
   * 🔴 `from … → to …` BECAME `from …` OVER `to …`. George, 22 Sep 2026: *"remove →"*. The two legs have
   * been stacked since the morning, when he asked for the order — *"use from and to with a little arrow,
   * not to and from"* — and the arrow was what opened the second leg. Taken away, the second leg opens
   * with its own label, the two lines align on the left, and nothing is lost: `from` and `to` are the
   * words that carry the direction, and a glyph between them was decoration on a 12-pixel cell.
   *
   * Each leg keeps its own city, because a four-letter code on its own is the thing this page has
   * already had to fix once.
   *
   * Three states, and all three say something: still being looked up, nothing on file, and known. A
   * dash is never a blank, because "nobody has a route for this callsign" and "this page has not
   * finished asking" are different answers and a reader is entitled to tell them apart.
   */
  private destinationCell(route: RouteInfo | null | undefined): string {
    if (route === undefined) {
      return (
        '<td class="mono dest dest-waiting" title="Asking the route lookup about this callsign.">' +
        '<span class="muted">asking…</span></td>'
      );
    }
    if (route === null) {
      return (
        '<td class="mono dest dest-none" ' +
        'title="No route is on file for this callsign. The aircraft itself never transmits where it is going."' +
        '><span class="muted">—</span></td>'
      );
    }
    const { origin, destination, airline } = route;
    // 🔴 THE BRACKETS GO, AND THE COLUMN NARROWS WITH THEM. `San José (Alajuela)` is the airport's own
    // way of naming the city and it is twice as long as the city is: `stripBrackets` is the same
    // helper the place line uses, and the full name stays in the title for anyone who wants it.
    const to = [stripBrackets(destination.city), destination.country]
      .filter((part) => part !== '')
      .join(', ');
    const from = [stripBrackets(origin.city), origin.country]
      .filter((part) => part !== '')
      .join(', ');
    const whole =
      `On file for this callsign: from ${origin.icao} ${origin.city}` +
      ` to ${destination.icao} ${destination.city}${airline ? ` · ${airline}` : ''}.` +
      ' A route is looked up, not transmitted by the aircraft, so a diversion or a reused callsign can make it wrong.';
    // 🔴 TWO LEGS, STACKED. Side by side the pair would set the width of the widest column on the table
    // — which is what the airport column was doing when it was taken out. Stacked, the widest line is a
    // city and a country, and both legs start at the same edge.
    return (
      `<td class="mono dest" title="${escapeHtml(whole)}">` +
      `<span class="dest-leg dest-from">` +
      '<span class="dest-label">from</span> ' +
      `<b>${escapeHtml(origin.icao)}</b>` +
      (from ? ` <span class="cell-city">${escapeHtml(from)}</span>` : '') +
      '</span>' +
      `<span class="dest-leg dest-to">` +
      '<span class="dest-label">to</span> ' +
      `<b>${escapeHtml(destination.icao)}</b>` +
      (to ? ` <span class="cell-city">${escapeHtml(to)}</span>` : '') +
      '</span></td>'
    );
  }

  /**
   * Keep every "· 12s ago" honest, once a second, without touching the rest of the table.
   *
   * The timestamp each one is counting from is carried on the element itself, so this needs
   * no state of its own and cannot disagree with what was rendered.
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
   * Which rule caught this aircraft, in the engine's own words — `aircraft` for a tail
   * number the reader named, `type` or `type+tail` for one caught by a starred type.
   *
   * Null when nothing matched, which cannot happen for a row in this table.
   */
  private matchKind(state: { hex: string; callsign: string; registration: string; type: string }): Match['kind'] | null {
    if (!this.engine) return null;
    return this.engine.matchOf({
      hex: state.hex,
      flight: state.callsign || undefined,
      r: state.registration || undefined,
      t: state.type || undefined,
    })?.kind ?? null;
  }

  /**
   * Which of the airports the reader is watching this aircraft is nearest to.
   *
   * Null when the aircraft has not reported a position, or when nothing is being watched —
   * and the row says "not placed" rather than inventing an airport, because a wrong airport
   * on a row is worse than an empty one.
   */
  private nearestAirportTo(state: { lat?: number; lon?: number }): string | null {
    if (typeof state.lat !== 'number' || typeof state.lon !== 'number') return null;
    let best: { icao: string; km: number } | null = null;
    for (const airport of this.airports) {
      const km = nmToKm(distanceNm(state.lat, state.lon, airport.lat, airport.lon));
      if (best === null || km < best.km) best = { icao: airport.icao, km };
    }
    return best ? best.icao : null;
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
      const response = await fetch('/types.json', { headers: { accept: 'application/json' } });
      this.survey = (await readJson(response)) as TypesDocument;
      this.surveyRead = true;
    } catch (error) {
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
    } catch {
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
    const live = this.engine ? this.engine.snapshot() : [];

    // What the status text can actually depend on: which aircraft are here, of which type, under
    // which tail; whether the record has been read, and which reading of it; and whether the
    // years list is in, because that is what the row's year tag is drawn from. A position moving
    // does not change a status, and neither does a new reading of the same aircraft.
    const liveKey = live
      .map((one) => `${one.hex ?? ''}:${one.type ?? ''}:${one.registration ?? ''}`)
      .sort()
      .join(',');
    const statusKey =
      `${liveKey}|${this.surveyRead ? (this.survey?.generated ?? 'read') : 'unread'}` +
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
   * airplane types are selected"*. With nothing starred, the card still printed the alert line and
   * a full table whose only content was the sentence *"Nothing in the fence matches what you
   * picked ... The feed can see 4 aircraft right now"* — which reads as the feed's shortcoming
   * when it is the reader's own missing step. So the alert line and the table are REMOVED, not
   * shown empty, and one sentence stands where they were.
   *
   * The test is the STARRED types (`typeRules`), not the bell: the bell is a separate list that
   * does not change what the table lists, so arming a bell with nothing starred would still leave
   * an empty table — see the note on `alertRules`.
   */
  private renderLiveGate(): void {
    const ask = byId('liveAsk');
    const block = byId('notifyBlock');
    const table = byId('liveTable');
    if (!ask || !block || !table) return;
    const picked = this.typeRules.length;
    if (picked === 0) {
      block.hidden = true;
      table.hidden = true;
      ask.hidden = false;
      ask.textContent =
        'Nothing is picked yet, so there is nothing to list. Star the types you care about in ' +
        'step 3 — or name a tail number — and the aircraft in your fence that match them will ' +
        'appear here with an alert when one leaves.';
      return;
    }
    block.hidden = false;
    table.hidden = false;
    ask.hidden = true;
    ask.textContent = '';
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
   * ()"*, and *"it says [redacted] should say stoney creek at least"*.
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
      // location just make it say the city name, not the others in ()"*, and then *"it says
      // [redacted] should say stoney creek at least"*. See `nearbyPlace`.
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
    return { rows, total: all.length, droppedByAirport, droppedByKind, droppedByYear, droppedForNoYear, droppedBySeen };
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
      this.stop();
      this.setStatus('Pick an airport above, or say where you are, and this fills in.', 'working');
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
      // 🔴 THE DISTANCE IS NO LONGER PART OF THE SEQUENCE, AND IT CANNOT BE. George moved the
      // control on 22 Sep 2026 — *"i want this above the map"* — and the map is in step 4, which
      // step 3 unlocks. `place && radiusChosen` therefore became a circle that could never be
      // entered: the distance could only be chosen in a card that appears after a distance has been
      // chosen. The gate is the PLACE alone now, a distance is in use from the start, and the
      // distance card says so in its own note.
      //
      //   1  where you are                 → ANSWERED by a place
      //                                    → unlocks 3
      //   3  the aircraft types            → ANSWERED when something is starred
      //                                    → unlocks 4 (which carries the distance and the map)
      //   5  name one aircraft             → the alternative to 3, so it rides with it
      //   4, 6                             → a watchlist, a map and a board are all
      //                                    empty until something has been picked
      const answered1 = place;
      const answered2 = answered1 && picked;
      const show = step === 1 ? true : step === 3 || step === 5 ? answered1 : answered2;

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
   * 🔴 EVERY STEP HEADING COLLAPSES AND EXPANDS, AND THE READER OWNS IT.
   *
   * George, 20 Sep 2026: *"you didnt do the collpase / expand like i asked"*. The
   * automatic sequence above decides what ARRIVES; this decides what STAYS OPEN.
   * A reader who has finished with where they are should be able to fold it away
   * and get on with the part they care about, rather than scrolling past a step
   * they have already answered.
   *
   * Delegated on the document, so every step works including the ones revealed
   * later — a listener bound to the headings at load would only ever know about the
   * steps that existed at load. That is the same mistake that made the cookie gate's
   * footer door dead on the other sites in this family.
   */
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
      for (const key of [WATCH_KEY, TYPES_KEY, AIRPORT_KEY, CENTRE_KEY, RADIUS_KEY]) {
        try {
          localStorage.removeItem(key);
        } catch {
          /* private mode refuses to remove as well as to store */
        }
      }
      track('start_over', {});
      window.location.reload();
    });
  }

  private bindStepToggles(): void {
    document.addEventListener('click', (event) => {
      // 🔴 A DESCENDANT SELECTOR, NOT A CHILD ONE. `closest` matches a selector
      // against each ancestor, and the first version of this used `.step-gated > h2`
      // — which reads as a child selector and did not fire in Chrome. Matching on
      // the plain descendant and checking the parent explicitly is the same test
      // written so it cannot be ambiguous.
      const target = event.target as HTMLElement | null;
      const heading = target?.closest('h2');
      if (!(heading instanceof HTMLElement)) return;
      const section = heading.parentElement;
      if (!(section instanceof HTMLElement) || !section.classList.contains('step-gated')) return;
      section.classList.toggle('step-folded');
      const folded = section.classList.contains('step-folded');
      heading.setAttribute('aria-expanded', String(!folded));
      track('step_folded', { step: section.dataset.step ?? '', folded });
    });
  }

  private async loadMilitary(): Promise<void> {
    try {
      const response = await fetch('/military.json', { headers: { accept: 'application/json' } });
      const doc = (await readJson(response)) as { codes?: { code: string }[]; note?: string };
      for (const row of doc.codes ?? []) this.militaryCodes.add(String(row.code).toUpperCase());
    } catch {
      // Not fatal, and deliberately silent in the page: without the file the
      // warplanes filter still works for the historic types in the static table,
      // which is where the Lancaster lives.
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
    } catch {
      // Not fatal. Without the file every row falls back to its drawing, which is
      // what a row with no trusted photograph does anyway.
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
      this.renderLiveGate();
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
    this.renderLiveGate();

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
  private renderWatchlist(): void {
    const host = byId('watchList');
    if (!host) return;

    if (this.typeRules.length === 0 && this.watchlist.length === 0) {
      host.innerHTML = '<li class="muted">Nothing watched yet. Star a type above, and it appears here.</li>';
      return;
    }

    // Read once, for every row — see `countMatching`.
    const live = this.engine ? this.engine.snapshot() : [];

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
          `<button type="button" class="linkish type-remove" data-type="${escapeHtml(rule.type)}" ` +
          `data-ga="type-unwatch" title="Stop watching" ` +
          `aria-label="Stop watching ${escapeHtml(info.name)}">${MARK_CROSS}</button>` +
          tailsHtml +
          '</li>'
        );
      })
      .join('');

    const namedItems = this.watchlist
      .map((item) => {
        const state = this.watchStateOfTail(item, live);
        return (
          `<li class="watch-type"><span class="watch-what">${MARK_STAR}` +
          `<span class="mono">${escapeHtml(item)}</span> — <b>this aircraft</b></span>` +
          `<span class="watch-state" data-state="${state.kind}" ` +
          `title="${escapeHtml(state.why)}">${escapeHtml(state.text)}</span>` +
          `<button type="button" class="linkish watch-remove" data-key="${escapeHtml(item)}" ` +
          `data-ga="unwatch" title="Stop watching" aria-label="Stop watching ${escapeHtml(item)}">${MARK_CROSS}</button></li>`
        );
      })
      .join('');

    host.innerHTML = typeItems + namedItems;

    for (const button of host.querySelectorAll<HTMLButtonElement>('.type-remove')) {
      button.addEventListener('click', () => {
        const code = button.dataset.type ?? '';
        this.typeRules = this.typeRules.filter((rule) => normaliseKey(rule.type) !== normaliseKey(code));
        this.saveTypeRules();
        this.renderWatchlist();
        this.renderTypeList();
      });
    }

    for (const button of host.querySelectorAll<HTMLButtonElement>('.watch-remove')) {
      button.addEventListener('click', () => this.removeWatch(button.dataset.key ?? ''));
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
        /* older Safari takes a callback instead of a promise */
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
      /* Some browsers refuse to build a notification from a page that is not
         itself in the foreground. The alert has already fired either way, and the
         aircraft's phase is corrected in the table on the next render. */
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
    const VIEW_H = Math.round(Math.min(VIEW_W * 0.66, 460));
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
    if (anchor) {
      const dLat = this.radiusKm / 111.32;
      const dLon = this.radiusKm / (111.32 * Math.max(0.2, Math.cos((anchor.lat * Math.PI) / 180)));
      minLat = Math.min(minLat, anchor.lat - dLat);
      maxLat = Math.max(maxLat, anchor.lat + dLat);
      minLon = Math.min(minLon, anchor.lon - dLon);
      maxLon = Math.max(maxLon, anchor.lon + dLon);
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
    const zoom =
      at && anchor ? Math.max(zoomForEverything, zoomForFence - 1) : zoomForEverything;
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
    const watching = (this.engine ? this.engine.snapshot() : []).filter((one) => this.isWatchedNow(one));
    const placed = watching.filter(
      (one): one is (typeof one & { lat: number; lon: number }) =>
        typeof one.lat === 'number' && typeof one.lon === 'number'
    );

    // Drawn AFTER the airports and after the reader's own mark, so nothing is laid over a plane.
    let planes = '';
    let drawn = 0;
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
      if (spot.x < 0 || spot.x > VIEW_W || spot.y < 0 || spot.y > VIEW_H) continue;
      drawn += 1;

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
      planes +=
        `<g class="locmap-plane-mark" transform="translate(${spot.x.toFixed(1)} ${spot.y.toFixed(1)})${heading}">` +
        `<path class="locmap-plane-icon" transform="scale(0.72) translate(-12 -12)" d="${PLANE_PATH}" />` +
        '</g>' +
        `<text class="locmap-plane-label" x="${(spot.x + 11).toFixed(1)}" ` +
        `y="${(spot.y + 4).toFixed(1)}">${escapeHtml(what)}</text>`;
    }
    const unplaced = watching.length - drawn;

    const described =
      this.airports.length === 1
        ? `the airport you picked (${this.airports[0].icao})`
        : `${this.airports.length} airports you picked (${this.chosenIcaos().join(', ')})`;

    const html =
      `<div class="locmap" style="width:${VIEW_W}px;height:${VIEW_H}px">` +
      tiles +
      `<svg class="locmap-over" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" ` +
      `aria-label="A map showing ${escapeHtml(described)}` +
      (anchorPx
        ? `, a ${this.radiusKm} kilometre circle around ${you ? 'your position' : 'the airports you are watching'}`
        : '') +
      `, the nearest other airports marked with their codes` +
      (drawn === 0
        ? ', and no aircraft on your list inside it at the moment'
        : `, and ${drawn} aircraft you are watching, each pointing along its track with its flight path behind it`) +
      `">` +
      // Paths first, so nothing is ever drawn across one.
      paths +
      (anchorPx
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
      (anchor
        ? `It is fitted so the ${this.radiusKm} km gap you chose is inside the frame, together with the airports you picked — a ring you can only see part of is no use as a distance. `
        : 'It is fitted to the airports you picked. ') +
      (drawn === 0
        ? 'Nothing you are watching is inside the fence at this moment, so the map is drawn with ' +
          'no aircraft on it — it stays where it is, and one appears the moment the feed sees it. '
        : 'Every aircraft on your list and inside the fence, named in full and drawn where the ' +
          'feed last reported it. ') +
      (traced > 0
        ? 'The line behind an aircraft is the path it has flown in the last few minutes, drawn ' +
          'from what this page has heard — the feed reports only where a plane is now. ' +
          'Its colour is what the aircraft did between two readings: ' +
          '<b>green</b> where it gained height, <b>amber</b> where it lost it, <b>blue</b> where it ' +
          'held it, and a <b>dashed blue</b> where the reading carried no altitude to compare. ' +
          (graded > 0 ? '' : 'No aircraft on the map is reporting an altitude yet, so every path is dashed. ')
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
          // 🔴 "YOU PICKED IT" IS A CLAIM ABOUT THE READER, AND SOMETIMES IT IS FALSE. A
          // brand-new visitor is given one airport (`DEFAULT_AIRPORT`) so the page has
          // something to draw — and calling that "the airport you picked" is a small lie
          // told on the very first screen. What IS true either way is that it is being
          // watched, so that is what the heading says.
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
      if (!body.ok || !body.town) throw new Error(body.place ?? 'no name');
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
    } catch {
      // No name came back. Show the numbers the browser gave us — they are real, and the
      // reader can see for themselves that the page is not pretending to know more.
      this.computeNearby(lat, lon, fallback);
      if (note) {
        note.textContent = `Ordered by distance from ${fallback} — the position your browser gave.`;
      }
      track('locate_named', { named: false });
    }
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
