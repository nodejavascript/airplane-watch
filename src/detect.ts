/**
 * detect.ts — the part of this demo that is actually a claim, and the only part
 * worth testing hard.
 *
 * THE CLAIM: an aircraft that was on the ground at an airport and is now in the
 * air has taken off, and somebody who asked to be told about it should be told.
 *
 * THE PROBLEM: "on the ground" is the hardest thing in this data to see. An
 * aircraft at 35,000 ft is received from three hundred kilometres away; an
 * aircraft sitting on the apron is received only by a receiver within a few
 * kilometres of it, because the terminal building, the fuel trucks and the curve
 * of the earth are all in the way. So the ground state is missing exactly when it
 * is most wanted, and a detector that patiently waits for "was ground, now air"
 * will miss most departures and never say so.
 *
 * SO THERE ARE TWO ANSWERS, AND THE PAGE NAMES WHICH ONE IT HAS:
 *
 *   'confirmed' — the aircraft was seen on the ground inside the fence and is now
 *                 airborne. This is a departure, and it is a fact.
 *   'inferred'  — the aircraft has never been seen before, it is inside the fence,
 *                 and it is airborne and climbing. It almost certainly departed,
 *                 but "almost certainly" is not "confirmed", and calling it
 *                 confirmed would be the lie this whole file exists to avoid.
 *
 * And every path that could produce a wrong answer has a guard, because a
 * notification about a plane that did not take off is worth less than no
 * notification at all:
 *
 *   - a STALE sample (the feed has not heard from it recently) proves nothing;
 *   - an aircraft DESCENDING inside the fence is arriving, not departing;
 *   - an aircraft we already watched leave is not leaving again;
 *   - and a COOLDOWN stops one long climb from firing on every poll.
 *
 * Everything here is pure. No fetch, no DOM, no clock read unless it is passed
 * in. That is why test/detect.test.js can drive ten years of edge cases in
 * milliseconds without a browser, and why the browser code below it is small.
 */

/** What a single reading from the feed says about the aircraft's phase. */
export type Phase = 'ground' | 'airborne' | 'unknown';

/** One aircraft, as the readsb-shaped feed sends it. Only the fields we use. */
export interface Reading {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground' | null;
  alt_geom?: number | null;
  gs?: number | null;
  baro_rate?: number | null;
  seen?: number | null;
  seen_pos?: number | null;
  category?: string;
  /**
   * 🔴 WHERE IT IS POINTING, WHICH THE FEED HAS BEEN SENDING ALL ALONG AND THIS SITE WAS
   * THROWING AWAY. George, 22 Sep 2026: *"the icon is always an airplane pointing up, but the
   * airplane should point towards its trajectory"*.
   *
   * `track` is the direction it is travelling OVER THE GROUND, in degrees clockwise from true
   * north — which is the trajectory itself, so it is the one to prefer. `true_heading` is where the
   * NOSE points, and it differs from the path by the wind correction angle; both are TRUE
   * directions. `mag_heading` is MAGNETIC, which in southern Ontario is about 11 degrees west of
   * true, so it is the last resort and the only one carrying a known error.
   *
   * Measured on a live Hamilton response, 22 Sep 2026: `track` was present on every aircraft
   * sampled, while `true_heading` and `mag_heading` were often null — so the preferred field is
   * also the reliable one.
   */
  track?: number | null;
  true_heading?: number | null;
  mag_heading?: number | null;
}

/** One remembered position, with the time it was read. */
export interface TrailPoint {
  lat: number;
  lon: number;
  /** ms epoch on OUR clock, as `observedAt` is. */
  at: number;
}

/** What we remember about one aircraft between polls. */
export interface TrackState {
  hex: string;
  phase: Phase;
  /** ms epoch when this state was written — our clock, not theirs. */
  observedAt: number;
  /** ms epoch of the last reading that put it on the ground. */
  groundAt?: number;
  /** ms epoch when it was first seen airborne after a ground reading. */
  airborneAt?: number;
  callsign: string;
  registration: string;
  type: string;
  /** true when the reader asked to be told about this one. */
  watched: boolean;
  /**
   * 🔴 WHERE IT WAS, SO THE TABLE CAN SAY WHICH AIRPORT IT IS AT. George, 20 Sep 2026:
   * *"i want to group by aircraft type, and the airport. Address is useless"*. The table
   * could not answer "which airport" at all before this, because the state it renders from
   * carried no position — only a hex code, which is the one field he has now asked to be
   * rid of. Kept as the last known position rather than the reading's, so an aircraft that
   * drops out of a poll keeps the place it was last seen.
   */
  lat?: number;
  lon?: number;
  /**
   * 🔴 WHICH WAY IT IS GOING, so the aeroplane on the map points along its path instead of always
   * pointing up. Kept as the LAST known value rather than this reading's, because a reading that
   * omits the heading must not blank the one the aircraft had a second ago — the same rule the
   * position follows.
   */
  trackDeg?: number;
  /**
   * 🔴 WHERE IT HAS BEEN — the flight path, drawn behind it. George, 22 Sep 2026: *"in the lower
   * map are you able to trace its flight?"*.
   *
   * The feed reports only where an aircraft is NOW, so a path can only be what this page has heard
   * and remembered across polls. It is bounded twice on purpose (`TRAIL_POINTS` and
   * `TRAIL_WINDOW_MS`): a count alone would let an aircraft that stopped reporting keep a stale
   * path on the map, and a window alone would let a fast aircraft at a short interval draw hundreds
   * of points.
   */
  trail?: TrailPoint[];
}

/**
 * How much of a flight path is kept. Thirty points at the 20-second poll is ten minutes of flying,
 * which at a jet's 450 knots is about 75 nautical miles of path — long enough to read a turn, and
 * bounded so a long session cannot grow without limit.
 */
export const TRAIL_POINTS = 30;

/** A point older than this is dropped, so a path never outlives the flight it describes. */
export const TRAIL_WINDOW_MS = 10 * 60 * 1000;

/**
 * 🔴 AND THE WHOLE TRACK IS FORGOTTEN AFTER THIS, WHICH IT NEVER WAS BEFORE.
 *
 * `tracks` was never pruned: every aircraft ever heard stayed in the map for the life of the tab.
 * That was survivable when a track was a dozen fields. It is not once each one also carries a
 * flight path, which is what this round added — so the leak is closed here rather than multiplied.
 * A track not heard from in 45 minutes is stale by every rule in this file (a READING is stale
 * after 60 seconds) and unreachable from the page, so it is dropped.
 */
export const TRACK_TTL_MS = 45 * 60 * 1000;

export type Verdict = 'none' | 'confirmed' | 'inferred';

export interface TakeoffDecision {
  verdict: Verdict;
  /** Why, in words the page can print. Empty when nothing happened. */
  reason: string;
}

export interface DetectOptions {
  /** Radius of the fence in nautical miles. */
  radiusNm: number;
  /** Centre of the fence. */
  lat: number;
  lon: number;
  /** The reader's "now", in ms epoch. Passed in so tests can move time. */
  now: number;
  /**
   * A reading older than this many seconds is not evidence of anything. The
   * feed's own `seen` field counts seconds since the last message about this
   * aircraft, so a large value means we are looking at a memory, not at a plane.
   */
  staleAfterSec: number;
  /** One long climb must not fire on every poll. */
  cooldownMs: number;
}

export const DEFAULTS = {
  radiusNm: 10,
  staleAfterSec: 60,
  cooldownMs: 20 * 60 * 1000,
};

/* ------------------------------------------------------------- the units --- */

/**
 * 🔴 "NOBODY UNDERSTANDS nm" — George, 20 Sep 2026, and he is right.
 *
 * The reader picks a distance in KILOMETRES, and the feed is asked in NAUTICAL
 * MILES, because that is the unit the API takes — its own endpoint summary reads
 * *"Aircrafts surrounding a point (lat, lon) up to 250nm"*. One nautical mile is
 * exactly 1852 metres, so the conversion is exact rather than approximate, and it
 * lives here rather than inside the page so a test can check it.
 */
export const KM_PER_NM = 1.852;

/**
 * Which way it is going, in degrees clockwise from true north — or undefined when the feed said
 * nothing usable.
 *
 * 🔴 THE ORDER IS THE POINT. `track` is the ground track, which IS the trajectory and is what
 * George asked the icon to follow. `true_heading` is where the nose points — a different thing,
 * separated from the path by the wind correction angle. `mag_heading` is magnetic, about 11 degrees
 * west of true in southern Ontario, so it is last and it is the only one that carries a known
 * error. A value that is not finite is not a heading, and a wrong heading is worse than none here:
 * the reader has no way to tell that the aeroplane is pointing somewhere it is not going.
 *
 * A finite value is normalised rather than rejected, so the feed's own 360 reads as 0 (north) and
 * anything outside the range still lands somewhere sensible instead of being thrown away.
 */
function headingOf(reading: Reading): number | undefined {
  for (const raw of [reading.track, reading.true_heading, reading.mag_heading]) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    return ((raw % 360) + 360) % 360;
  }
  return undefined;
}

/**
 * The flight path so far, with this reading added — or the old path, pruned.
 *
 * 🔴 A POINT IS NEVER INVENTED, AND NEVER REPEATED. An aircraft the feed reports without a position
 * adds nothing, and an aircraft that has not moved adds nothing either — a repeated point draws a
 * dot on top of itself and makes a path look longer than the flying it describes. In both cases the
 * window is still applied, so a path ages out even while nothing is being appended to it.
 */
function appendTrail(
  previous: TrailPoint[] | undefined,
  reading: Reading,
  now: number
): TrailPoint[] | undefined {
  const kept = (previous ?? []).filter((point) => now - point.at <= TRAIL_WINDOW_MS);
  const { lat, lon } = reading;
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return kept.length > 0 ? kept : undefined;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return kept.length > 0 ? kept : undefined;
  }
  const last = kept[kept.length - 1];
  if (last && last.lat === lat && last.lon === lon) {
    return kept.length > 0 ? kept : undefined;
  }
  const grown = [...kept, { lat, lon, at: now }];
  return grown.length > TRAIL_POINTS ? grown.slice(grown.length - TRAIL_POINTS) : grown;
}

/** Kilometres the reader chose → whole nautical miles the feed takes. */
export function kmToNm(km: number): number {
  return Math.max(1, Math.round(km / KM_PER_NM));
}

/** Nautical miles the feed works in → kilometres the reader reads. */
export function nmToKm(nm: number): number {
  return Math.round(nm * KM_PER_NM);
}

/* -------------------------------------------------------- watching a TYPE ---
 *
 * George, 20 Sep 2026: *"airpplane type, not tail numbers, if i selected an
 * airplane, then the user can select tail numbers or not."*
 *
 * So watching has TWO levels, and the second is optional:
 *
 *   { type: 'B38M', tails: [] }                  any 737 MAX 8 that leaves
 *   { type: 'B38M', tails: ['C-GXXX','C-FABC'] }  only those two
 *
 * A tail number on its own still works, for somebody who knows the aeroplane
 * rather than the model. What does not work — and must not — is a type rule with
 * an empty tails list being read as "no aircraft": an empty filter means NO
 * FILTER, which is the whole point of the feature.
 */
export interface TypeRule {
  /** ICAO type designator, as the feed sends it: B38M, C172, DH8D. */
  type: string;
  /** Tail numbers, callsigns or addresses. EMPTY means every aircraft of the type. */
  tails: string[];
}

export type MatchKind = 'aircraft' | 'type' | 'type+tail';

export interface Match {
  kind: MatchKind;
  /** Ready to print — says which rule caught it, so the board can explain itself. */
  label: string;
}

/**
 * Read the phase out of one reading.
 *
 * 🔴 `alt_baro` is a NUMBER OR THE STRING "ground" — never a boolean, and never
 * reliably present. Measured on a live Hamilton response on 20 Sep 2026: one
 * parked aircraft came back as `alt_baro: "ground"` with `gs: 0`, and another
 * aircraft in the same response carried `alt_baro: null`. So `typeof x ===
 * 'number'` is the test, and a bare comparison against 0 silently classifies
 * every aircraft in the sky as being on the ground.
 */
export function phaseOf(reading: Reading): Phase {
  if (reading.alt_baro === 'ground') return 'ground';
  if (typeof reading.alt_baro === 'number' && Number.isFinite(reading.alt_baro)) return 'airborne';
  return 'unknown';
}

/** True when the sample is too old to prove anything. */
export function isStale(reading: Reading, staleAfterSec: number): boolean {
  const seen = reading.seen;
  if (typeof seen !== 'number' || !Number.isFinite(seen)) return false;
  return seen > staleAfterSec;
}

/**
 * Great-circle distance in nautical miles. The fence has to be measured, not
 * assumed: an airport's own coordinate is not where an aircraft is, and a
 * rectangle around a runway reaches much further along the diagonals than a
 * circle does.
 */
export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const earthNm = 3440.065;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * earthNm * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function insideFence(reading: Reading, options: DetectOptions): boolean {
  if (typeof reading.lat !== 'number' || typeof reading.lon !== 'number') return false;
  return distanceNm(options.lat, options.lon, reading.lat, reading.lon) <= options.radiusNm;
}

/**
 * Decide whether this reading is a departure.
 *
 * The order of the guards IS the design. Each one exists because the version
 * without it produced an answer that was wrong in a specific way, and the reason
 * string says which guard fired so the page can be honest about a near-miss
 * rather than silently doing nothing.
 */
export function judgeTakeoff(
  previous: TrackState | undefined,
  reading: Reading,
  options: DetectOptions
): TakeoffDecision {
  const phase = phaseOf(reading);

  if (phase === 'ground') {
    return { verdict: 'none', reason: 'on the ground' };
  }
  if (phase === 'unknown') {
    // No altitude at all. Some transponders send position without it, and an
    // engine start is indistinguishable from a landing in that data.
    return { verdict: 'none', reason: 'no altitude in the sample' };
  }
  if (isStale(reading, options.staleAfterSec)) {
    return { verdict: 'none', reason: 'the feed has not heard from it recently' };
  }
  if (!insideFence(reading, options)) {
    return { verdict: 'none', reason: 'outside the fence' };
  }

  const rate = typeof reading.baro_rate === 'number' ? reading.baro_rate : null;

  if (previous === undefined) {
    // First sighting. Climbing is the only honest signal we have.
    if (rate !== null && rate > 0) {
      return {
        verdict: 'inferred',
        reason: 'first seen inside the fence, already climbing',
      };
    }
    return { verdict: 'none', reason: 'first seen, but not climbing' };
  }

  // Already known to be in the air. A level aircraft that entered the fence on
  // its way somewhere is a flyover, not a departure.
  if (previous.phase === 'airborne') {
    return { verdict: 'none', reason: 'already airborne' };
  }

  if (previous.phase === 'ground') {
    // The one that is a fact. The cooldown does not apply — a real ground-to-air
    // transition is a real event, and it can only happen once per departure.
    return { verdict: 'confirmed', reason: 'it was on the ground and it is not now' };
  }

  // previous.phase === 'unknown' — we saw it, but could not tell what it was
  // doing. Climbing makes it a departure; anything else stays unproven.
  if (rate !== null && rate > 0) {
    return { verdict: 'inferred', reason: 'inside the fence and climbing' };
  }
  return { verdict: 'none', reason: 'nothing to compare against' };
}

/** An aircraft we have judged to have departed. This is what the board shows. */
export interface Departure {
  hex: string;
  callsign: string;
  registration: string;
  type: string;
  /** 'confirmed' or 'inferred' — never 'none'. The board shows which. */
  verdict: Exclude<Verdict, 'none'>;
  reason: string;
  /** ms epoch of the reading that decided it. */
  at: number;
  /** Barometric altitude in feet at the moment of the reading. */
  altitudeFt: number | null;
  /** Vertical rate in feet per minute at the moment of the reading. */
  climbFpm: number | null;
  /** Distance from the airport at the moment of the reading. */
  distanceNm: number;
  /** True when any watch rule caught it. */
  watched: boolean;
  /**
   * 🔴 TRUE ONLY WHEN THE READER ASKED TO BE TOLD ABOUT THIS ONE. Separate from `watched` on
   * purpose: the star says "show me this", the bell says "wake me for this", and a reader who
   * stars a dozen types wants notifications about one of them.
   */
  alert: boolean;
  /** WHICH rule caught it — a single aircraft, a whole type, or a type narrowed to tails. */
  matchedBy: MatchKind | null;
  /** The rule in words, for the board. */
  matchedLabel: string;
}

/**
 * The engine: keep one TrackState per aircraft and turn a poll into 0..n
 * departures. Deliberately a plain class over a Map, so a test can feed it a
 * scripted sequence of polls and assert exactly what came out — which is how the
 * two guards that matter (cooldown, already-airborne) are proved rather than
 * hoped for.
 */
export class DetectionEngine {
  private tracks = new Map<string, TrackState>();
  private firedAt = new Map<string, number>();
  private options: DetectOptions;
  private watchlist: Set<string>;
  private typeRules: TypeRule[] = [];
  /**
   * 🔴 A SECOND RULE SET, FOR A DIFFERENT QUESTION. George, 20 Sep 2026: *"i should be able
   * to select from the list w3hich ones i want an alert for"*.
   *
   * "Show me this in the table" and "wake my phone for this" are not the same wish, and until
   * now the page could not tell them apart: anything matching a star raised a notification.
   * A reader who stars everything they find interesting gets a phone full of alerts; a reader
   * who stars one thing to watch it go by wants NO notification. So the bell is its own list,
   * in the same shape as the star's, and the alert fires only for what is on it.
   */
  private alertRules: TypeRule[] = [];

  constructor(options: DetectOptions, watchlist: Iterable<string> = []) {
    this.options = options;
    this.watchlist = new Set([...watchlist].map(normaliseKey));
  }

  /** The names the reader asked to be told about — hex, callsign or tail number. */
  setWatchlist(keys: Iterable<string>): void {
    this.watchlist = new Set([...keys].map(normaliseKey));
  }

  /** The types the reader asked about, each optionally narrowed to tail numbers. */
  setTypeRules(rules: Iterable<TypeRule>): void {
    this.typeRules = normaliseRules(rules);
  }

  /** The types the reader asked to be ALERTED about — the bell, not the star. */
  setAlertRules(rules: Iterable<TypeRule>): void {
    this.alertRules = normaliseRules(rules);
  }

  /**
   * Which rule, if any, this aircraft matches — or null.
   *
   * Order matters and is deliberate: a tail number the reader named is reported as
   * a tail number, not as "a type", even when a type rule would also have caught
   * it. The board should say the most specific true thing it can. When more than
   * one rule matches, the narrowest wins.
   */
  matchOf(reading: Reading): Match | null {
    return matchAgainst(reading, this.watchlist, this.typeRules);
  }

  /**
   * Which ALERT rule, if any, this aircraft matches — or null.
   *
   * The same rules as `matchOf`, asked of the bell's list instead of the star's. It is the
   * same function so the two cannot drift: an aircraft alerted about is always one the page
   * would also have listed, and a rule that works for one works for the other.
   */
  alertOf(reading: Reading): Match | null {
    return matchAgainst(reading, EMPTY_KEYS, this.alertRules);
  }

  /**
   * 🔴 IS THERE ANYTHING TO ALERT ABOUT AT ALL? The page needs this to be able to say so.
   *
   * A reader who has granted notifications and picked nothing gets silence, and silence is
   * indistinguishable from a broken alert — which is the failure this whole feature keeps
   * running into. The page asks this and says which it is.
   */
  hasAlertRules(): boolean {
    return this.alertRules.length > 0;
  }

  /** Does this aircraft match anything the reader is watching? */
  isWatched(reading: Reading): boolean {
    return this.matchOf(reading) !== null;
  }

  stateOf(hex: string): TrackState | undefined {
    return this.tracks.get(hex);
  }

  /** Every aircraft we hold, newest reading first. */
  snapshot(): TrackState[] {
    return [...this.tracks.values()].sort((a, b) => b.observedAt - a.observedAt);
  }

  /**
   * Take one poll and return the departures it proves.
   *
   * `now` is a parameter rather than `Date.now()` because the cooldown is the
   * rule most likely to be wrong, and a rule that cannot be fast-forwarded in a
   * test is a rule nobody checks.
   */
  ingest(readings: Reading[], now: number): Departure[] {
    const found: Departure[] = [];

    for (const reading of readings) {
      if (!reading || typeof reading.hex !== 'string' || reading.hex === '') continue;
      const hex = reading.hex.toLowerCase();
      const previous = this.tracks.get(hex);

      const decision = judgeTakeoff(previous, reading, { ...this.options, now });
      const match = this.matchOf(reading);
      const watched = match !== null;
      const alert = this.alertOf(reading) !== null;

      if (decision.verdict !== 'none') {
        const last = this.firedAt.get(hex);
        const cooling = last !== undefined && now - last < this.options.cooldownMs;

        // 🔴 The cooldown applies to an INFERRED departure only. A confirmed
        // ground-to-air transition cannot repeat within one departure, and
        // suppressing one because an inference fired earlier would lose the only
        // event this whole page exists to report.
        if (!(decision.verdict === 'inferred' && cooling)) {
          const altitudeFt =
            typeof reading.alt_baro === 'number' ? Math.round(reading.alt_baro) : null;
          const climbFpm = typeof reading.baro_rate === 'number' ? Math.round(reading.baro_rate) : null;
          const distanceToAirport =
            typeof reading.lat === 'number' && typeof reading.lon === 'number'
              ? Math.round(
                  distanceNm(this.options.lat, this.options.lon, reading.lat, reading.lon) * 10
                ) / 10
              : 0;

          found.push({
            hex,
            callsign: (reading.flight || '').trim(),
            registration: reading.r || '',
            type: reading.t || '',
            verdict: decision.verdict,
            reason: decision.reason,
            at: now,
            altitudeFt,
            climbFpm,
            distanceNm: distanceToAirport,
            watched,
            alert,
            matchedBy: match ? match.kind : null,
            matchedLabel: match ? match.label : '',
          });
          this.firedAt.set(hex, now);
        }
      }

      // Write the state AFTER judging, so the judgement used the reading as it
      // arrived rather than as this function just rewrote it.
      const phase = phaseOf(reading);
      const next: TrackState = {
        hex,
        phase,
        observedAt: now,
        groundAt: phase === 'ground' ? now : previous?.groundAt,
        airborneAt:
          phase === 'airborne' && previous?.phase === 'ground' ? now : previous?.airborneAt,
        callsign: (reading.flight || '').trim() || previous?.callsign || '',
        registration: reading.r || previous?.registration || '',
        type: reading.t || previous?.type || '',
        lat: Number.isFinite(reading.lat) ? (reading.lat as number) : previous?.lat,
        lon: Number.isFinite(reading.lon) ? (reading.lon as number) : previous?.lon,
        // A reading with no heading keeps the last one, for the same reason a reading with no
        // position keeps the last position: the aircraft does not stop pointing when the feed
        // sends a shorter frame.
        trackDeg: headingOf(reading) ?? previous?.trackDeg,
        trail: appendTrail(previous?.trail, reading, now),
        watched,
      };
      this.tracks.set(hex, next);
    }

    // 🔴 AND THE ONES NOBODY HAS HEARD FROM GO — see `TRACK_TTL_MS`. Deleting from a Map while
    // iterating it is defined behaviour in JavaScript, so this needs no copy.
    for (const [hex, track] of this.tracks) {
      if (now - track.observedAt > TRACK_TTL_MS) this.tracks.delete(hex);
    }
    // The cooldown stamps are the same kind of leak and are dead the moment the cooldown expires,
    // so they are dropped in the same pass rather than kept for the session.
    for (const [hex, at] of this.firedAt) {
      if (now - at > this.options.cooldownMs) this.firedAt.delete(hex);
    }

    return found;
  }
}

/**
 * The two rule sets, normalised the one way.
 *
 * Kept as a function rather than written out in each setter, because two copies of a
 * normaliser is how a tail number ends up matching a star but not a bell.
 */function normaliseRules(rules: Iterable<TypeRule>): TypeRule[] {
  return [...rules]
    .filter((rule) => String(rule?.type ?? '').trim() !== '')
    .map((rule) => ({
      type: normaliseKey(rule.type),
      tails: [...(rule.tails ?? [])].map(normaliseKey).filter((tail) => tail !== ''),
    }));
}

/** No named aircraft at all — for the alert rule set, which does not watch by name. */
const EMPTY_KEYS: Set<string> = new Set();

/**
 * The matching rule, in one place, over whichever rule set is handed in.
 *
 * `matchOf` and `alertOf` both call this, so "what the page lists" and "what it alerts about"
 * can never disagree about what a rule means. The parts they differ on — which list, and
 * whether a named aircraft counts — are parameters.
 *
 * Order matters and is deliberate: a tail number the reader named is reported as a tail
 * number, not as "a type", even when a type rule would also have caught it. The row should say
 * the most specific true thing it can. When more than one rule matches, the narrowest wins.
 */
function matchAgainst(reading: Reading, named: Set<string>, rules: TypeRule[]): Match | null {
  const hex = normaliseKey(reading.hex);
  const registration = reading.r ? normaliseKey(reading.r) : '';
  const callsign = reading.flight ? normaliseKey(reading.flight) : '';

  const byName =
    named.has(hex) || (registration !== '' && named.has(registration)) || (callsign !== '' && named.has(callsign));
  if (byName) {
    const shown = (reading.r || reading.flight || reading.hex || '').trim();
    return { kind: 'aircraft', label: `${shown} — watched by name` };
  }

  const type = reading.t ? normaliseKey(reading.t) : '';
  if (type === '') return null;

  const byTail: TypeRule[] = [];
  for (const rule of rules) {
    if (rule.type !== type) continue;
    if (rule.tails.length === 0) return { kind: 'type', label: `any ${rule.type}` };
    if (rule.tails.includes(registration) || rule.tails.includes(hex) || rule.tails.includes(callsign)) {
      byTail.push(rule);
    }
  }
  if (byTail.length > 0) {
    return { kind: 'type+tail', label: `${byTail[0].type}, tail ${(reading.r || reading.hex || '').trim()}` };
  }

  return null;
}

/**
 * One key shape for hex, callsign and tail number, so "c-gxxx", "C-GXXX" and
 * "cgxxx" are the same aircraft to the reader who typed it. Aircraft
 * registrations are written with a hyphen and transmitted without one.
 */
export function normaliseKey(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
