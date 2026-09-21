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
 * 🔴 THE DISTANCE IS A LOGARITHMIC LADDER NOW, NOT THREE BUTTONS. George, 20 Sep 2026:
 * *"How far out from you? maybe this should be a slider? logrythmic?"*
 *
 * Three chips offered three answers, and the two that mattered sat at the ends: the
 * difference between 10 and 20 km is the whole difference between catching an aircraft
 * on the ground and not, while the difference between 20 and 50 is barely noticeable.
 * A slider alone would be worse — dragging to 37 km is false precision for a fence, and
 * a fence is a question you answer, not a number you tune — so the slider is
 * **logarithmic and snapped**: equal travel gives equal RATIOS (each step is about a
 * quarter larger than the last), and every stop is a round number.
 *
 * 5 km to 200 km covers everything the page is good at: below 5 the round loses the
 * airport's own apron, and above 200 on a 30-minute poll the fence is wider than any
 * aircraft can be watched across.
 */
const RADIUS_LADDER = [
  5, 6, 8, 10, 12, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200,
];


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
 * 🔴 THE NINE CHOICES, SHORT, UNDER ONE LABEL. George, 20 Sep 2026: *"i want a label instead
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
 */
const SEEN_CHOICES: SeenChoice[] = [
  { key: 'all', label: 'All flights', mode: 'all', since: null },
  { key: 'fiveMin', label: '5 minutes', phrase: 'the last 5 minutes', mode: 'rolling', since: (now) => rolling(now, 5 * 60_000) },
  { key: 'hour', label: 'last hour', phrase: 'the last hour', mode: 'rolling', since: (now) => rolling(now, 60 * 60_000) },
  { key: 'halfDay', label: 'last 12 hours', phrase: 'the last 12 hours', mode: 'rolling', since: (now) => rolling(now, 12 * 60 * 60_000) },
  { key: 'today', label: 'today', mode: 'calendar', since: (now) => startOfDay(now) },
  { key: 'week', label: 'this week', mode: 'calendar', since: (now) => startOfWeek(now) },
  { key: 'month', label: 'this month', mode: 'calendar', since: (now) => startOfMonth(now) },
  { key: 'quarter', label: 'this quarter', mode: 'calendar', since: (now) => startOfQuarter(now) },
  { key: 'year', label: 'this year', mode: 'calendar', since: (now) => startOfYear(now) },
  // 🔴 LAST, BECAUSE IT IS NOT PART OF THE SCALE. The other nine run narrow to wide; this one
  // is a different question — which types the record is SILENT about — and putting it at the
  // end keeps the time scale unbroken while still making the option reachable.
  { key: 'noData', label: 'no data', mode: 'noData', since: null },
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
 * A place where historic aircraft are based and flown, and the days they fly.
 *
 * 🔴 THE POINT OF THE PAGE, PER GEORGE. 20 Sep 2026: *"thats the whole point actually, to
 * watch these old aircraft fly past your home location"*. Everything else here answers "what
 * is in the air"; this answers the question a reader actually has about a rare aeroplane,
 * which is WHEN TO LOOK UP. It is read from the site's own database rather than written into
 * this file, because it is data — George asked exactly that question about an earlier draft
 * that had it as a note: *"shoudnt these be in the api?"*.
 */
interface HistoricDocument {
  generated: string;
  source: string;
  method: string;
  caution: string;
  sites: HistoricSite[];
}

interface HistoricSite {
  icao: string;
  name: string;
  url: string;
  note: string;
  source: string;
  readAt: string;
  nextAt: string | null;
  upcoming: number;
  daysPublished: number;
  aircraft: HistoricAircraft[];
  flights: { aircraft: number; beginsAt: string; seats: string | null; url: string }[];
}

interface HistoricAircraft {
  name: string;
  label: string;
  theirId: number;
  typeCode: string | null;
  codeSource: string | null;
  /**
   * 🔴 THREE STATES, NOT TWO, AND THE THIRD ONE IS THE HONEST ONE. `true` — the feed has
   * reported this type. `false` — it never has. `null` — nobody has sourced the type code,
   * so the question has not been asked, and saying "never reported" here would be a claim
   * that was never checked. Only `LANC` has a source today.
   */
  reported: boolean | null;
}

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

/** One aircraft matching the selection that is in the air right now. */
interface LiveAircraft {
  label: string;
  tail: string;
  type: string;
  hex: string;
  altitudeFt: number | null;
  climbFpm: number | null;
  speedKt: number | null;
  km: number;
  bearingDeg: number;
  matchedBy: string;
  watched: boolean;
}

/**
 * How far round the compass one point is from another, in degrees from north.
 *
 * This is what makes the live view a picture rather than a list: distance alone
 * says an aircraft is 8 km away, and distance with a bearing says it is 8 km to
 * the south-west, which is the direction an aircraft leaves Hamilton for Toronto.
 */
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

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const p1 = lat1 * toRad;
  const p2 = lat2 * toRad;
  const dl = (lon2 - lon1) * toRad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 16-point compass, because "204°" is a number and "south-south-west" is a place. */
const COMPASS = ['north', 'north-north-east', 'north-east', 'east-north-east', 'east', 'east-south-east', 'south-east', 'south-south-east', 'south', 'south-south-west', 'south-west', 'west-south-west', 'west', 'west-north-west', 'north-west', 'north-north-west'];

function compassPoint(degrees: number): string {
  return COMPASS[Math.round(degrees / 22.5) % 16];
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

  /** The same, where there is room for almost nothing — the middle of the radar. */
  private airportCentreLabel(): string {
    const codes = this.chosenIcaos();
    if (codes.length === 0) return this.centre ? 'you' : '';
    if (codes.length <= 2) return codes.join(' / ');
    return `${codes.length} airports`;
  }

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
  /**
   * The days historic aircraft fly, from the site's own database. Null until read, and null
   * for good if the file cannot be read — the panel is an extra, so its absence is quiet.
   */
  private historic: HistoricDocument | null = null;
  /** The raw readings from the last poll — the live view is drawn from these. */
  private lastReadings: Reading[] = [];

  /**
   * Whether the reader has answered the distance half of step 1 by moving the slider.
   *
   * 🔴 IT USED TO SAY "step 2", AND THERE IS NO STEP 2 ANY MORE. The distance and the place
   * are one card — George, 20 Sep 2026: *"the circle in the map should be based on the how
   * far out from you distance, so lets combine those cards nicely"* — so the status line was
   * sending the reader to look for a step that is not on the page.
   *
   * 🔴 IT IS NOT PRESELECTED, AND THAT IS THE POINT. A distance applied silently is a step
   * that answers itself, and a step that answers itself cannot be waited on — which is why
   * the first attempt at this revealed steps 2, 3 and 5 together. The reader moves the
   * slider, and the next step arrives because they did.
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
    this.bindWatchForm();
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
    void this.loadHistoric();
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
   * 🔴 A SLIDER, LOGARITHMIC, SNAPPED — and the feed is only asked when you let go.
   *
   * The slider's POSITION is linear and its VALUE is not: position n is
   * `RADIUS_LADDER[n]`, and the ladder is roughly geometric, so the same drag moves you
   * 5→6 km at one end of the track and 160→200 km at the other. That is what makes a
   * short distance feel controllable without wasting half the track on numbers nobody
   * can tell apart.
   *
   * 🔴 DRAGGING REDRAWS; RELEASING FETCHES. `input` fires on every pixel of a drag, so
   * it redraws the map and the sentence — local work — and `change` fires when the
   * reader lets go, which is what re-aims the fence and may ask the feed. Measured
   * against the live feed on 20 Sep 2026: ten requests three seconds apart were refused
   * with 429 from the third onward. A control that asked on every pixel would exhaust
   * that budget in one gesture.
   */
  private buildRadiusButtons(): void {
    const host = byId('radiusButtons');
    if (!host) return;
    host.innerHTML = '';

    const nearest = RADIUS_LADDER.reduce(
      (best, _km, index) =>
        Math.abs(RADIUS_LADDER[index] - this.radiusKm) < Math.abs(RADIUS_LADDER[best] - this.radiusKm) ? index : best,
      0
    );

    const row = document.createElement('div');
    row.className = 'radius-row';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = 'radiusSlider';
    slider.className = 'radius-slider';
    slider.min = '0';
    slider.max = String(RADIUS_LADDER.length - 1);
    slider.step = '1';
    slider.value = String(nearest);
    slider.setAttribute('aria-label', 'How far out to look');

    const readout = document.createElement('b');
    readout.id = 'radiusValue';
    readout.className = 'radius-value';

    const show = (index: number): void => {
      const km = RADIUS_LADDER[index];
      readout.textContent = `${km} km`;
      slider.setAttribute('aria-valuetext', `${km} kilometres`);
    };
    show(nearest);

    slider.addEventListener('input', () => {
      const index = Number(slider.value);
      this.radiusKm = RADIUS_LADDER[index];
      show(index);
      // Local only: the sentence, the circle and the map all come from `radiusKm`,
      // and none of them needs the feed to be asked again.
      this.renderMap();
    });

    slider.addEventListener('change', () => {
      // 🔴 MOVING THE SLIDER IS WHAT ANSWERS STEP 1, and until it is answered step 3 is
      // not on the page. Nothing is applied silently, so the reader can see which step
      // the page is waiting on.
      const first = !this.radiusChosen;
      this.radiusChosen = true;
      const km = RADIUS_LADDER[Number(slider.value)];
      // Kept, so a reload does not ask the same question again.
      writeStore(RADIUS_KEY, String(km));
      this.updateSteps();
      // Re-aimed with the distance they actually chose. Nothing is re-fetched by the
      // page: `point()` already falls back to the airports that are picked, so this is
      // the same point at a new radius rather than a new question.
      this.rearm();
      track('distance_chosen', { km, nm: kmToNm(km), first });
    });

    row.append(slider);
    host.append(row, readout);
  }

  private buildTypeFilter(): void {
    const host = byId('typeFilter');
    if (!host) return;
    host.innerHTML = '';
    this.labelChips(host, 'Kind', 'typeFilterLabel');
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
    // 🔴 NOTHING IS ASKED OF THE FEED UNTIL STEP 2 IS ANSWERED. The page is waiting
    // on a choice, and saying so beats showing a count of aircraft in a fence the
    // reader has not picked.
    if (!this.radiusChosen) {
      this.setStatus('Set how far out to look at the top of the page, and this fills in.', 'working');
      return;
    }
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
      this.renderLive();
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
          ? '<tr><td colspan="5" class="muted">Nothing in the fence at this moment. Aircraft appear and disappear as they pass.</td></tr>'
          : '<tr><td colspan="5" class="muted">Nothing in the fence matches what you picked. ' +
            `The feed can see ${all.length} aircraft right now, and none of them is on your list — ` +
            'star a type in step 3, or name a tail number, and they will appear here.</td></tr>';
      return;
    }

    // 🔴 GROUPED BY TYPE, WITH THE AIRPORT ON EVERY ROW, AND NO HEX ADDRESS AT ALL.
    // George, 20 Sep 2026: *"i want to group by aircraft type, and the airport. Address is
    // useless"*.
    //
    // He is right about the address: a transponder hex code is an implementation detail
    // that no reader can use, and it was the FIRST column — the most prominent place on
    // the table for the least useful fact. What a reader actually asks is "what is that"
    // and "where" — a type and an airport — so the type heads each group and the airport
    // is the first thing on the row.
    //
    // The airport is the nearest one the reader is watching, worked out from the aircraft's
    // last known position. An aircraft with no position yet is put under "not placed" rather
    // than being given a guess or dropped, because it is real and it is in the fence.
    const withAirport = rows.map((state) => ({ state, airport: this.nearestAirportTo(state) }));
    const groups = new Map<string, { label: string; items: typeof withAirport }>();
    for (const row of withAirport) {
      const code = row.state.type || '';
      if (!groups.has(code)) {
        groups.set(code, { label: code ? describeType(code).name : 'Type not transmitted', items: [] });
      }
      groups.get(code)!.items.push(row);
    }

    const html: string[] = [];
    for (const [code, group] of [...groups.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label) || a[0].localeCompare(b[0]))) {
      // Sorted by airport inside the group, so the rows read as sub-groups rather than as
      // whatever order the feed happened to report them in.
      group.items.sort((a, b) => (a.airport ?? 'zz').localeCompare(b.airport ?? 'zz') || a.state.callsign.localeCompare(b.state.callsign));
      html.push(
        `<tr class="type-group"><th scope="colgroup" colspan="5">` +
          (code ? `<span class="mono">${escapeHtml(code)}</span> ${escapeHtml(group.label)}` : escapeHtml(group.label)) +
          `<span class="group-count">${group.items.length} aircraft</span>` +
          `</th></tr>`
      );
      for (const { state, airport } of group.items) {
        const label = state.callsign || state.registration || state.hex;
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
        html.push(
          // 🔴 EVERY REAL ROW CARRIES A CLASS OF ITS OWN, BECAUSE "NOT A GROUP ROW" WAS NOT
          // ENOUGH TO TELL A DATA ROW FROM A PLACEHOLDER. The empty states above are single
          // `<tr>`s with a `colspan` cell, so `tr:not(.type-group)` matches them too — and a
          // test waiting for `#aircraftBody tr:not(.type-group)` was satisfied by the sentence
          // saying there was nothing to show. Measured: one rewritten test passed on the
          // placeholder alone, which is a false pass, and a false pass is worse than a
          // failure because it is read as cover.
          `<tr class="aircraft-row${byName ? ' watched-row' : ''}">` +
          `<td class="mono">${airport ? escapeHtml(airport) : '<span class="muted">not placed</span>'}</td>` +
          `<td><b>${escapeHtml(label)}</b></td>` +
          `<td>${phase}</td>` +
          // 🔴 THE TIME IS PRINTED TWICE ON PURPOSE, IN THE TWO FORMS THAT ANSWER DIFFERENT
          // QUESTIONS. George, 20 Sep 2026: *"last reading should include fromnow()"*. A
          // clock time says WHEN it was; "12s ago" says WHETHER IT STILL MEANS ANYTHING, and
          // that is the question a reader watching a live feed is actually asking. A cell
          // that said only "15:04:22" made them do the subtraction themselves, against their
          // own clock, with no idea whether the page had stalled.
          `<td class="mono">${formatClock(state.observedAt)}` +
          `<span class="reading-ago" data-at="${state.observedAt}"> · ${fromNow(state.observedAt)}</span></td>` +
          // 🔴 THE POSITION, WHERE THE WATCH LINK USED TO BE. George, 20 Sep 2026:
          // *"remove the watch link, can you put long/lat"*. Watching is done by picking —
          // a type in step 3 or a tail number in step 5 — so a control on every row was a
          // second way to do the same thing, in the one place a reader is trying to read.
          // Four decimals is about eleven metres, which is as much as the position means.
          `<td class="mono pos">${positionText(state)}</td>` +
          '</tr>'
        );
      }
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
  }

  /**
   * Keep every "· 12s ago" honest, once a second, without touching the rest of the table.
   *
   * The timestamp each one is counting from is carried on the element itself, so this needs
   * no state of its own and cannot disagree with what was rendered.
   */
  private tickReadingAges(): void {
    const paint = (): void => {
      for (const spread of Array.from(document.querySelectorAll<HTMLElement>('.reading-ago'))) {
        const at = Number(spread.dataset.at);
        if (Number.isFinite(at)) spread.textContent = ` · ${fromNow(at)}`;
      }
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
    } catch (error) {
      this.survey = null;
      if (note) {
        note.textContent =
          'The measured type list could not be read, so this shows only the types seen in this session. ' +
          (error instanceof Error ? error.message : '');
      }
      this.renderFilterNote();
      this.renderTypeList();
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
  private labelChips(host: HTMLElement, text: string, id: string): void {
    const label = document.createElement('span');
    label.className = 'chip-label';
    label.id = id;
    label.textContent = text;
    host.appendChild(label);
    host.setAttribute('aria-labelledby', id);
  }

  private buildSeenFilter(): void {
    const host = byId('seenFilter');
    if (!host) return;
    host.innerHTML = '';
    this.labelChips(host, 'Last seen', 'seenFilterLabel');
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
    this.labelChips(host, 'First flown', 'yearFilterLabel');
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
      // 🔴 THE DISTANCE STEP IS GONE, FOLDED INTO STEP 1. George, 20 Sep 2026: *"the
      // circle in the map should be based on the how far out from you distance, so
      // lets combine those cards nicely"*. They are one question — where you are, and
      // how far out from there — so they are one card, and the circle now sits
      // directly under the chips that decide it.
      //
      //   1  where you are + how far out → ANSWERED by a place AND a distance
      //                                    → unlocks 3
      //   3  the aircraft types          → ANSWERED when something is starred
      //                                    → unlocks 4
      //   5  name one aircraft           → the alternative to 3, so it rides with it
      //   4, 6, 7                        → a watchlist, a board and a chart are all
      //                                    empty until something has been picked
      const answered1 = place && this.radiusChosen;
      const answered2 = answered1 && picked;
      const show = step === 1 ? true : step === 3 || step === 5 ? answered1 : answered2;

      if (show && section.hidden) {
        section.hidden = false;
        section.classList.add('step-arrive');
        window.setTimeout(() => section.classList.remove('step-arrive'), 900);
        // The chart is drawn when it arrives rather than when it was last polled,
        // or it would show whatever was in the air a moment before it appeared.
        if (step === 7) this.renderLive();
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
  private emptyMessage(): string {
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
      host.innerHTML = `<p class="muted small">${escapeHtml(this.emptyMessage() + (why ? ` ${why}.` : ''))}</p>`;
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

    const typeItems = this.typeRules
      .map((rule) => {
        const info = describeType(rule.type);
        const narrowed = rule.tails.length > 0;
        const entry = this.yearOf(rule.type);
        return (
          `<li class="watch-type">` +
          `<span class="watch-what">${MARK_STAR}<b>${escapeHtml(info.name)}</b> ` +
          `<span class="mono muted">${escapeHtml(rule.type)}</span>` +
          (entry ? ` <span class="year-tag">${entry.year}</span>` : '') +
          ` — <b>${
            narrowed
              ? `${rule.tails.length} tail number${rule.tails.length === 1 ? '' : 's'}`
              : 'every one of them'
          }</b>` +
          (narrowed ? ` <span class="mono muted">${escapeHtml(rule.tails.join(', '))}</span>` : '') +
          '</span>' +
          `<button type="button" class="linkish type-remove" data-type="${escapeHtml(rule.type)}" ` +
          `data-ga="type-unwatch">stop watching</button>` +
          '</li>'
        );
      })
      .join('');

    const namedItems = this.watchlist
      .map(
        (item) =>
          `<li class="watch-type"><span class="watch-what">${MARK_STAR}` +
          `<span class="mono">${escapeHtml(item)}</span> — <b>this aircraft</b></span>` +
          `<button type="button" class="linkish watch-remove" data-key="${escapeHtml(item)}" ` +
          `data-ga="unwatch">remove</button></li>`
      )
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
        `${this.listedAirports.kept} airports, every one of them confirmed by asking the feed where it is. ` +
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
  private renderMap(): void {
    const host = byId('locMap');
    if (!host) return;
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

    const described =
      this.airports.length === 1
        ? `the airport you picked (${this.airports[0].icao})`
        : `${this.airports.length} airports you picked (${this.chosenIcaos().join(', ')})`;

    host.innerHTML =
      `<div class="locmap" style="width:${VIEW_W}px;height:${VIEW_H}px">` +
      tiles +
      `<svg class="locmap-over" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" ` +
      `aria-label="A map showing ${escapeHtml(described)}` +
      (anchorPx
        ? `, a ${this.radiusKm} kilometre circle around ${you ? 'your position' : 'the airports you are watching'}`
        : '') +
      `, and the nearest other airports marked with their codes">` +
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
      '</svg></div>' +
      '<p class="small muted locmap-note">The map is ' +
      '<a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a>, free and with no API key. ' +
      (anchor
        ? `It is fitted so the ${this.radiusKm} km gap you chose is inside the frame, together with the airports you picked — a ring you can only see part of is no use as a distance.`
        : 'It is fitted to the airports you picked.') +
      ' The tiles are fetched by this site\'s own server rather than by your ' +
      'browser, so the map service never sees you — the same way the flight feed is handled.' +
      '</p>';
  }

  /**
   * 🔴 THE MAP IS REDRAWN WHEN THE BOX CHANGES SIZE. The tiles are placed by pixel,
   * so a wider card cannot reflow the drawing to fit — the box has to be measured and
   * the map drawn again. A resize listener on the window would miss the case that
   * matters most here: a step that was folded open, or a card that grew when a note
   * filled in. A ResizeObserver sees all of them.
   */
  private bindMapResize(): void {
    const host = byId('locMap');
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
   * Read `historic.json` — the days the museum at Hamilton flies its aircraft.
   *
   * 🔴 THIS IS THE THING THE READER ACTUALLY CAME FOR, AND IT IS STILL ONLY A SCHEDULE.
   * George, 20 Sep 2026: *"thats the whole point actually, to watch these old aircraft fly
   * past your home location"*. A Lancaster flies a handful of times a year from a named
   * airfield, and a handful of times a year is not something anybody notices by chance — so
   * the schedule is the useful half, and the feed is the lucky half.
   *
   * It is composed by the site's own database and served at `/historic.json`, the same shape
   * whether that came from the database or from the file the deploy carries. If it cannot be
   * read the panel is simply absent: this is an extra, and a broken extra must not take the
   * page with it.
   */
  private async loadHistoric(): Promise<void> {
    try {
      const response = await fetch('/historic.json', { headers: { accept: 'application/json' } });
      this.historic = (await readJson(response)) as HistoricDocument;
    } catch {
      this.historic = null;
    }
    this.renderHistoric();
  }

  /**
   * Show the historic site nearest the reader — but only when it is one of THEIR airports.
   *
   * 🔴 THE SITE IS SHOWN AGAINST AN AIRPORT THE READER ALREADY HAS, WHICH IS WHAT MAKES IT
   * BELIEVABLE. The museum is at CYHM; CYHM is in the same list, measured by the same
   * distance, as every other airport on this card. So the sentence is not "somewhere there is
   * a museum" — it is "the airport 15 km from you flies a Lancaster", which is a fact about a
   * place already on screen.
   *
   * Nothing here is offered when the reader has no location: a schedule for an airport
   * hundreds of kilometres away is not news, and this card has already been criticised once
   * for claiming a place it did not know (see the note in `renderNearby`).
   */
  private renderHistoric(): void {
    const host = byId('historicPanel');
    if (!host) return;
    const sites = this.historic?.sites ?? [];
    // The nearest airport the reader has, out of the airports that have a historic site.
    const within = this.nearby.find(({ airport }) => sites.some((site) => site.icao === airport.icao));
    if (this.centre === null || within === undefined) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    const site = sites.find((one) => one.icao === within.airport.icao);
    if (!site) {
      host.hidden = true;
      return;
    }

    const names = site.aircraft.map((one) => one.name);
    // 🔴 THE AIRCRAFT WHOSE TYPE THE FEED HAS NEVER REPORTED ARE NAMED, NOT HIDDEN. This is
    // the honest answer to "why have I never seen it" and it comes straight from the
    // database: `reported === false` means the survey has looked 129 types deep and never
    // once recorded this code. `null` means nobody has sourced the code, so the page says
    // nothing rather than guessing which of the two it is.
    const neverSeen = site.aircraft.filter((one) => one.reported === false).map((one) => one.name);

    const days = this.historicDays(site);
    const dayLines = days
      .map((day) => {
        const flown = [...new Set(day.aircraft)].join(', ');
        const open = day.seats.some((seats) => seats !== null && !/sold out/i.test(seats));
        return (
          `<li><b>${escapeHtml(day.label)}</b> — ${escapeHtml(flown)}` +
          (open ? '' : ' <span class="historic-gone">(no seats left)</span>') +
          `</li>`
        );
      })
      .join('');

    host.hidden = false;
    host.innerHTML =
      `<p class="historic-head">` +
      `<a href="${escapeHtml(site.url)}" target="_blank" rel="noopener">${escapeHtml(site.name)}</a> ` +
      `flies from <span class="mono">${escapeHtml(site.icao)}</span>, ` +
      `${Math.round(within.km)} km from you.` +
      `</p>` +
      `<p class="small muted">Aircraft: ${escapeHtml(names.join(', '))}.</p>` +
      (dayLines === ''
        ? `<p class="small muted">Nothing is scheduled in the days published so far.</p>`
        : `<p class="small"><b>Next days they fly:</b></p><ul class="historic-days">${dayLines}</ul>`) +
      (neverSeen.length === 0
        ? ''
        : `<p class="small muted">The feed has never reported ${escapeHtml(neverSeen.join(' or '))} — ` +
          `it flies a handful of times a year, and this page can only list what the feed saw. ` +
          `A flight that transmits will appear in the table like any other.</p>`);
    track('historic_shown', { icao: site.icao, upcoming: site.upcoming });
  }

  /**
   * The next few days the site flies, each with the aircraft on it.
   *
   * 🔴 THE MUSEUM'S OWN CLOCK, SAID OUT LOUD. The times are the museum's local times, and a
   * reader in another zone would otherwise read a number that means nothing to them. The zone
   * is named in the output rather than assumed, and the day is grouped in that same zone — a
   * flight at 09:30 in Mount Hope is not on the same date as 09:30 in Auckland.
   */
  private historicDays(site: HistoricSite): { label: string; aircraft: string[]; seats: (string | null)[] }[] {
    const zone = 'America/Toronto';
    const dayKey = (at: Date): string =>
      new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    const dayLabel = (at: Date): string =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, weekday: 'short', month: 'short', day: 'numeric',
      }).format(at);

    const byAircraft = new Map(site.aircraft.map((one) => [one.theirId, one.name]));
    const grouped = new Map<string, { label: string; aircraft: string[]; seats: (string | null)[] }>();
    for (const flight of site.flights) {
      const at = new Date(flight.beginsAt);
      const key = dayKey(at);
      if (!grouped.has(key)) grouped.set(key, { label: dayLabel(at), aircraft: [], seats: [] });
      const group = grouped.get(key);
      if (group) {
        const name = byAircraft.get(flight.aircraft);
        if (name) group.aircraft.push(name);
        group.seats.push(flight.seats);
      }
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 4).map(([, group]) => group);
  }

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
    // 🔴 THE HISTORIC PANEL IS RENDERED LAST, BECAUSE IT DEPENDS ON `this.nearby` — and it
    // is rendered HERE rather than only at load, so a reader who moves their location gets
    // the panel for the airport that is now near them rather than the one that was.
    this.renderHistoric();
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
    for (const id of ['radiusHead', 'radiusButtons', 'locMap']) {
      const element = byId(id);
      if (element) element.hidden = !shown;
    }
    if (!shown) return;
    const head = byId('radiusHead');
    if (head) {
      head.textContent = hasCentre
        ? 'How far out from you?'
        : this.airports.length > 1
          ? 'How far out from the airports you picked?'
          : 'How far out from the airport?';
    }
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
    if (!button) return;
    button.addEventListener('click', () => {
      if (!('geolocation' in navigator)) {
        if (note) note.textContent = 'This browser cannot report a position. Pick an airport by name instead.';
        return;
      }
      button.disabled = true;
      if (note) note.textContent = 'Asking your browser where you are…';
      track('locate_asked', {});
      navigator.geolocation.getCurrentPosition(
        (position) => {
          button.disabled = false;
          void this.nameMyPosition(position.coords.latitude, position.coords.longitude, note);
        },
        (error) => {
          button.disabled = false;
          if (note) {
            note.textContent =
              `Your browser did not give a position (${error.message}). Pick an airport by name below instead — ` +
              'nothing else on the page depends on knowing where you are.';
          }
        },
        { timeout: 10_000, maximumAge: 300_000 }
      );
    });
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
   * 🔴 THERE IS NO VIEW SWITCH ANY MORE. George, 20 Sep 2026: *"i only want the user
   * to pick so remove Pick what to watch / In the air now"*. Two buttons offering
   * "choose" and "look" put a mode in front of the thing the page is actually for.
   * So there is one flow: pick, and the chart arrives as the step AFTER the picking
   * — which is the order the questions are actually asked in.
   *
   * The chart is drawn when its step arrives (see updateSteps), not when it was last
   * polled, or it would show whatever was in the air a moment before it appeared.
   */

  /**
   * Aircraft matching the selection that are in the air at this moment.
   *
   * A picture of what is up there NOW, so a person can look up at a contrail and
   * find it. It is read from the same poll as the table, so the chart and the table
   * can never disagree about the same aircraft.
   */
  private matchedAirborne(): LiveAircraft[] {
    const at = this.point();
    // No airport required: the fence is drawn round the READER, so an aircraft can
    // be in it whether or not an airport lookup ever succeeded.
    if (!this.engine || !at) return [];
    const out: LiveAircraft[] = [];
    for (const reading of this.lastReadings) {
      if (typeof reading.lat !== 'number' || typeof reading.lon !== 'number') continue;
      // On the ground is not in the air. The string 'ground' is how the feed
      // says it, and it is a string rather than a number — see detect.ts.
      if (reading.alt_baro === 'ground') continue;
      const match = this.engine.matchOf(reading);
      if (!match) continue;
      out.push({
        label: String(reading.flight || reading.r || reading.hex).trim(),
        tail: String(reading.r || '').trim(),
        type: String(reading.t || '').trim().toUpperCase(),
        hex: reading.hex,
        altitudeFt: typeof reading.alt_baro === 'number' ? reading.alt_baro : null,
        climbFpm: typeof reading.baro_rate === 'number' ? reading.baro_rate : null,
        speedKt: typeof reading.gs === 'number' ? reading.gs : null,
        km: nmToKm(distanceNm(at.lat, at.lon, reading.lat, reading.lon)),
        bearingDeg: bearingDeg(at.lat, at.lon, reading.lat, reading.lon),
        matchedBy: match.label,
        watched: true,
      });
    }
    return out.sort((a, b) => a.km - b.km);
  }

  private renderLive(): void {
    const chart = byId('liveChart');
    const body = byId('liveBody');
    const empty = byId('liveEmpty');
    const summary = byId('liveSummary');
    if (!chart || !body || !empty) return;

    const rows = this.matchedAirborne();
    empty.hidden = rows.length > 0;

    if (rows.length === 0) {
      chart.innerHTML = '';
      body.innerHTML = '';
      if (summary) {
        summary.textContent =
          this.watchlist.length === 0 && this.typeRules.length === 0
            ? 'Nothing is selected yet, so there is nothing to chart. Pick an aircraft type on the first view.'
            : 'Nothing matching your selection is in the air inside the fence at this moment.';
      }
      return;
    }

    if (summary) {
      summary.textContent =
        `${rows.length} matching aircraft in the air right now · drawn from the reading taken at ${formatClock(this.lastPollAt)}`;
    }

    // 🔴 A TOP-DOWN PICTURE, NOT A BAR CHART. Distance alone says "8 km away";
    // distance WITH a bearing says "8 km to the south-west", which is where an
    // aircraft leaving Hamilton for Toronto actually is. The circle is the fence
    // the feed was asked for, so the picture and the query are the same shape.
    const size = 340;
    const centre = size / 2;
    const radius = centre - 28;
    const maxKm = Math.max(this.radiusKm, ...rows.map((row) => row.km));
    const toPx = (km: number): number => (km / maxKm) * radius;

    let svg = `<svg viewBox="0 0 ${size} ${size}" class="radar" role="img" aria-label="Aircraft in the air, drawn by direction and distance from ${escapeHtml(this.airportPhrase())}">`;
    svg += `<circle cx="${centre}" cy="${centre}" r="${radius.toFixed(1)}" class="radar-edge" />`;
    for (const ring of [maxKm / 3, (maxKm * 2) / 3, maxKm]) {
      svg += `<circle cx="${centre}" cy="${centre}" r="${toPx(ring).toFixed(1)}" class="radar-ring" />`;
      svg += `<text x="${(centre + 4).toFixed(1)}" y="${(centre - toPx(ring) + 12).toFixed(1)}" class="radar-label">${Math.round(ring)} km</text>`;
    }
    for (const [deg, name] of [
      [0, 'N'],
      [90, 'E'],
      [180, 'S'],
      [270, 'W'],
    ] as const) {
      const rad = (deg * Math.PI) / 180;
      svg += `<text x="${(centre + Math.sin(rad) * (radius + 12)).toFixed(1)}" y="${(centre - Math.cos(rad) * (radius + 12) + 4).toFixed(1)}" class="radar-compass" text-anchor="middle">${name}</text>`;
    }
    svg += `<circle cx="${centre}" cy="${centre}" r="3" class="radar-field" />`;
    svg += `<text x="${centre}" y="${centre + 16}" class="radar-label" text-anchor="middle">${escapeHtml(this.airportCentreLabel())}</text>`;
    for (const row of rows) {
      const rad = (row.bearingDeg * Math.PI) / 180;
      const x = centre + Math.sin(rad) * toPx(row.km);
      const y = centre - Math.cos(rad) * toPx(row.km);
      // A higher aircraft is drawn larger, so altitude is visible at a glance
      // without reading a number off a list.
      const dot = 3.2 + Math.min(6, (row.altitudeFt ?? 0) / 6500);
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${dot.toFixed(1)}" class="radar-dot"><title>${escapeHtml(row.label)} · ${escapeHtml(row.type)} · ${row.altitudeFt ?? '?'} ft · ${Math.round(row.km)} km ${compassPoint(row.bearingDeg)}</title></circle>`;
    }
    svg += '</svg>';
    chart.innerHTML = svg;

    body.innerHTML = rows
      .map((row) => {
        const info = describeType(row.type);
        const climb =
          row.climbFpm === null
            ? '—'
            : `${row.climbFpm > 0 ? '+' : ''}${row.climbFpm} ft/min`;
        return (
          '<tr>' +
          `<td><b>${escapeHtml(row.label)}</b>${row.tail && row.tail !== row.label ? ` <span class="mono muted small">${escapeHtml(row.tail)}</span>` : ''}</td>` +
          `<td title="${escapeHtml(info.name)}">${escapeHtml(info.name)}</td>` +
          `<td class="mono">${row.altitudeFt === null ? '—' : `${row.altitudeFt.toLocaleString()} ft`}</td>` +
          `<td class="mono">${escapeHtml(climb)}</td>` +
          `<td class="mono">${Math.round(row.km)} km ${compassPoint(row.bearingDeg)}</td>` +
          `<td class="small muted">${escapeHtml(row.matchedBy)}</td>` +
          '</tr>'
        );
      })
      .join('');
  }

  /* ------------------------------------------------------------- watchlist */

  private bindWatchForm(): void {
    const form = byId<HTMLFormElement>('watchForm');
    const input = byId<HTMLInputElement>('watchInput');
    if (!form || !input) return;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      this.addWatch(value);
      input.value = '';
    });
  }

  private addWatch(key: string): void {
    const value = key.trim();
    if (!value) return;
    if (this.watchlist.some((item) => normaliseKey(item) === normaliseKey(value))) return;
    this.watchlist.push(value);
    this.saveWatchlist();
    this.renderWatchlist();
    this.renderAircraft();
    track('aircraft_watched', { total: this.watchlist.length });
  }

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
