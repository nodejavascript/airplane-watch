/**
 * detect.test.js — the unit tests for the only part of this site that makes a
 * claim, plus the two failure modes that would make the claim false.
 *
 * These are pure: no browser, no network, no clock read unless it is passed in.
 * Every guard in detect.ts is here with a case that would fail without it, which
 * is the point — a guard nobody can demonstrate is a comment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  DetectionEngine,
  distanceNm,
  insideFence,
  isStale,
  judgeTakeoff,
  kmToNm,
  nmToKm,
  phaseOf,
  TRACK_TTL_MS,
  TRAIL_POINTS,
  TRAIL_WINDOW_MS,
} from '../site/detect.js';

const CYHM = { lat: 43.173599, lon: -79.934998 };
const options = { ...CYHM, radiusNm: 10, now: 1_000_000, staleAfterSec: 60, cooldownMs: 20 * 60 * 1000 };

/* --------------------------------------------------------------- phaseOf --- */

test('phaseOf reads the string "ground" as ground, not as a missing altitude', () => {
  // Measured on a live Hamilton response, 20 Sep 2026: a parked aircraft really
  // does come back as `alt_baro: "ground"` with `gs: 0`.
  assert.equal(phaseOf({ hex: 'a8246d', alt_baro: 'ground', gs: 0 }), 'ground');
});

test('phaseOf reads a number as airborne — including a NEGATIVE number', () => {
  // Below-sea-level airports exist (Amsterdam is -11 ft), so a bare
  // `alt_baro > 0` test would report every aircraft there as being on the ground.
  assert.equal(phaseOf({ hex: 'abc123', alt_baro: 3200 }), 'airborne');
  assert.equal(phaseOf({ hex: 'abc123', alt_baro: -11 }), 'airborne');
  assert.equal(phaseOf({ hex: 'abc123', alt_baro: 0 }), 'airborne');
});

test('phaseOf refuses to guess when the altitude is missing entirely', () => {
  // Also measured live: another aircraft in the same Hamilton response carried
  // `alt_baro: null`. Unknown is not ground.
  assert.equal(phaseOf({ hex: 'abc123', alt_baro: null }), 'unknown');
  assert.equal(phaseOf({ hex: 'abc123' }), 'unknown');
});

/* --------------------------------------------------------------- staleness --- */

test('a reading the feed has not heard from recently proves nothing', () => {
  assert.equal(isStale({ hex: 'a', seen: 5 }, 60), false);
  assert.equal(isStale({ hex: 'a', seen: 61 }, 60), true);
});

test('a missing `seen` field is not treated as stale', () => {
  // Not every payload carries it, and inventing staleness from an absent field
  // would silently disable the detector.
  assert.equal(isStale({ hex: 'a' }, 60), false);
  assert.equal(isStale({ hex: 'a', seen: null }, 60), false);
});

/* ---------------------------------------------------------------- the fence --- */

test('distanceNm is right at three known separations', () => {
  assert.equal(Math.round(distanceNm(43.173599, -79.934998, 43.173599, -79.934998)), 0);
  // One degree of latitude is 60 nautical miles, near enough anywhere.
  assert.ok(Math.abs(distanceNm(43, -79, 44, -79) - 60) < 0.2);
  // One degree of longitude at 43 N is 60 x cos(43) = about 43.9 nm.
  assert.ok(Math.abs(distanceNm(43, -79, 43, -78) - 43.9) < 0.4);
});

test('an aircraft with no position is outside the fence, not inside it', () => {
  // Defaulting an absent position to the airport would report every such
  // aircraft as being over the runway.
  assert.equal(insideFence({ hex: 'a' }, options), false);
});

/* ------------------------------------------------------------ judgeTakeoff --- */

test('a confirmed departure needs a previous GROUND reading', () => {
  const previous = {
    hex: 'abc123', phase: 'ground', observedAt: 1, callsign: '', registration: '', type: '', watched: false,
  };
  const decision = judgeTakeoff(previous, { hex: 'abc123', alt_baro: 1400, baro_rate: 2100, lat: 43.18, lon: -79.93 }, options);
  assert.equal(decision.verdict, 'confirmed');
});

test('an aircraft already airborne inside the fence is a flyover, not a departure', () => {
  const previous = {
    hex: 'abc123', phase: 'airborne', observedAt: 1, callsign: '', registration: '', type: '', watched: false,
  };
  const decision = judgeTakeoff(previous, { hex: 'abc123', alt_baro: 900, baro_rate: 1800, lat: 43.18, lon: -79.93 }, options);
  assert.equal(decision.verdict, 'none');
  assert.match(decision.reason, /already airborne/);
});

test('first sighting climbing inside the fence is INFERRED, never confirmed', () => {
  const decision = judgeTakeoff(undefined, { hex: 'abc123', alt_baro: 2400, baro_rate: 1900, lat: 43.18, lon: -79.93 }, options);
  assert.equal(decision.verdict, 'inferred');
});

test('first sighting that is not climbing is nothing at all', () => {
  // Level flight at 3,000 ft over the airport is a training circuit or a
  // flypast. Reporting it as a departure is the false alarm that ruins the page.
  const level = judgeTakeoff(undefined, { hex: 'abc123', alt_baro: 3000, baro_rate: 0, lat: 43.18, lon: -79.93 }, options);
  assert.equal(level.verdict, 'none');

  const descending = judgeTakeoff(undefined, { hex: 'abc123', alt_baro: 3000, baro_rate: -1200, lat: 43.18, lon: -79.93 }, options);
  assert.equal(descending.verdict, 'none');
});

test('an aircraft descending after a ground reading is not a departure', () => {
  // It was on the ground, then it is airborne but going down — which is a
  // reading that makes no sense for a departure and must not be reported as one.
  const previous = {
    hex: 'abc123', phase: 'ground', observedAt: 1, callsign: '', registration: '', type: '', watched: false,
  };
  const decision = judgeTakeoff(previous, { hex: 'abc123', alt_baro: 200, baro_rate: -700, lat: 43.18, lon: -79.93 }, options);
  // Ground to air is still the one transition that is a fact; the climb rate is
  // not consulted there, and the reason says so.
  assert.equal(decision.verdict, 'confirmed');
  assert.match(decision.reason, /on the ground/);
});

test('an aircraft outside the fence is never a departure however much it climbs', () => {
  const decision = judgeTakeoff(undefined, { hex: 'abc123', alt_baro: 9000, baro_rate: 2200, lat: 44.5, lon: -79.9 }, options);
  assert.equal(decision.verdict, 'none');
  assert.match(decision.reason, /outside the fence/);
});

test('a stale reading is refused even when everything else looks right', () => {
  const decision = judgeTakeoff(undefined, { hex: 'abc123', alt_baro: 3000, baro_rate: 2000, seen: 400, lat: 43.18, lon: -79.93 }, options);
  assert.equal(decision.verdict, 'none');
  assert.match(decision.reason, /not heard from it recently/);
});

/* ---------------------------------------------------------------- the engine --- */

test('one long climb fires once, not once per poll', () => {
  const engine = new DetectionEngine(options);
  const climb = { hex: 'abc123', alt_baro: 2500, baro_rate: 2000, lat: 43.18, lon: -79.93 };

  const first = engine.ingest([climb], 1_000_000);
  assert.equal(first.length, 1);
  assert.equal(first[0].verdict, 'inferred');

  // Eleven more polls over two minutes, all inside the cooldown.
  for (let step = 1; step <= 11; step += 1) {
    const later = engine.ingest([{ ...climb, alt_baro: 2500 + step * 900 }], 1_000_000 + step * 10_000);
    assert.equal(later.length, 0, `poll ${step} fired again`);
  }
});

/**
 * 🔴 REPAIRED 22 SEP 2026, AND IT WAS THE TEST THAT WAS WRONG RATHER THAN THE RULE.
 *
 * The assertion that used to end the test above read: *"Past the cooldown it may fire once more — an
 * aircraft that lands and leaves again inside one session is a second departure, not a duplicate"* —
 * and then advanced twenty-one minutes and expected a departure from an aircraft it had never put
 * back on the ground. The rule, correctly, answered "already airborne". An aircraft that never lands
 * has not departed twice, so the test had been red since the day it was written and the sentence in
 * its own comment described the case it was not setting up.
 *
 * The cooldown only ever suppresses an INFERRED departure — a confirmed ground-to-air transition
 * cannot repeat within one departure — so the case worth testing is an aircraft whose phase is
 * UNKNOWN: a position with no altitude, then a climb. That is real transponder behaviour, and it is
 * the only way the cooldown can be reached twice by the same aircraft.
 */
test('past the cooldown the same climb may fire again, and not before', () => {
  const engine = new DetectionEngine(options);
  const noAltitude = { hex: 'abc123', lat: 43.18, lon: -79.93 };
  const climbing = { ...noAltitude, alt_baro: 2500, baro_rate: 2000 };

  engine.ingest([noAltitude], 1_000_000);
  const first = engine.ingest([climbing], 1_000_010);
  assert.equal(first.length, 1, 'the first inferred climb did not fire at all');
  assert.equal(first[0].verdict, 'inferred');

  // The same situation again, inside the cooldown: silent.
  engine.ingest([noAltitude], 1_000_020);
  assert.equal(engine.ingest([climbing], 1_000_030).length, 0, 'it fired again inside the cooldown');

  // Past the cooldown it may fire once more. The cooldown limits repetition; it is not a silence.
  const after = 1_000_030 + options.cooldownMs + 1;
  engine.ingest([noAltitude], after);
  assert.equal(engine.ingest([climbing], after + 10).length, 1, 'the cooldown never expires');
});

test('an aircraft that lands and leaves again IS a second departure', () => {
  // The other half of what the old test was reaching for, and the half that needs the ground — which
  // is the part the old test never provided.
  const engine = new DetectionEngine(options);
  const ground = { hex: 'abc123', alt_baro: 'ground', gs: 0, lat: 43.18, lon: -79.93 };
  const climbing = { hex: 'abc123', alt_baro: 2500, baro_rate: 2000, lat: 43.18, lon: -79.93 };

  engine.ingest([ground], 1_000_000);
  const first = engine.ingest([climbing], 1_000_010);
  assert.equal(first.length, 1);
  assert.equal(first[0].verdict, 'confirmed');

  // Down and up again — inside the cooldown, because a confirmed departure is not suppressed by it.
  // One departure cannot repeat, but two departures can happen.
  engine.ingest([ground], 1_000_020);
  const second = engine.ingest([climbing], 1_000_030);
  assert.equal(second.length, 1, 'a second real departure inside the cooldown was suppressed');
  assert.equal(second[0].verdict, 'confirmed');
});

test('a re-aim keeps the flight paths, and does not keep the cooldown', () => {
  // 🔴 George, 22 Sep 2026, found while merging the maps: moving the distance builds a NEW engine, so
  // every trail on the map was thrown away by nudging the slider.
  const first = new DetectionEngine(options);
  first.ingest([{ hex: 'abc123', lat: 43.18, lon: -79.93, track: 90 }], 1_000_000);
  first.ingest([{ hex: 'abc123', lat: 43.19, lon: -79.94 }], 1_000_010);

  const second = new DetectionEngine({ ...options, radiusNm: 25 });
  second.adoptTracks(first);

  const carried = second.stateOf('abc123');
  assert.ok(carried, 'the aircraft was not carried across the re-aim');
  assert.deepEqual(carried.trail?.map((point) => point.lat), [43.18, 43.19],
    'the flight path did not survive the re-aim');
  assert.equal(carried.trackDeg, 90, 'the heading did not survive the re-aim');

  // And a null previous engine — the first arm of the page's life — is not an error.
  const cold = new DetectionEngine(options);
  cold.adoptTracks(null);
  assert.equal(cold.snapshot().length, 0);
});

test('a CONFIRMED departure is not suppressed by a recent inference', () => {
  // The cooldown exists to stop one climb firing on every poll. Applying it to a
  // ground-to-air transition would lose the only event this page exists to
  // report, and that would be a rule that protects the wrong thing.
  const engine = new DetectionEngine(options);
  engine.ingest([{ hex: 'abc123', alt_baro: 1200, baro_rate: 1800, lat: 43.18, lon: -79.93 }], 1_000_000);

  const ground = engine.ingest([{ hex: 'abc123', alt_baro: 'ground', gs: 0, lat: 43.18, lon: -79.93 }], 1_000_010);
  assert.equal(ground.length, 0);

  const off = engine.ingest([{ hex: 'abc123', alt_baro: 900, baro_rate: 2400, lat: 43.18, lon: -79.93 }], 1_000_020);
  assert.equal(off.length, 1);
  assert.equal(off[0].verdict, 'confirmed');
  assert.equal(off[0].reason.match(/ground/)[0], 'ground');
});

test('the watchlist matches a hex, a callsign or a tail number, and ignores case and hyphens', () => {
  const engine = new DetectionEngine(options, ['C-GXXX', 'aca123', 'C011E4']);
  assert.equal(engine.isWatched({ hex: 'c011e4' }), true);
  assert.equal(engine.isWatched({ hex: 'ffffff', flight: 'ACA123  ' }), true);
  assert.equal(engine.isWatched({ hex: 'ffffff', flight: 'WJA456', r: 'C-GXXX' }), true);
  assert.equal(engine.isWatched({ hex: 'ffffff', flight: 'WJA456', r: 'N12345' }), false);
});

test('an empty watchlist watches nothing rather than everything', () => {
  // `[].includes(...)` and an empty Set are the same thing; an inverted test
  // here would notify the reader about every aircraft in the sky.
  const engine = new DetectionEngine(options, []);
  assert.equal(engine.isWatched({ hex: 'c011e4', flight: 'ACA123' }), false);
});

test('a departure remembers what it looked like, so the board can show it', () => {
  const engine = new DetectionEngine(options, ['C011E4']);
  const found = engine.ingest(
    [{ hex: 'c011e4', flight: 'ACA123', r: 'C-GXXX', t: 'B738', alt_baro: 1800, baro_rate: 2050, lat: 43.19, lon: -79.93 }],
    1_000_000
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].callsign, 'ACA123');
  assert.equal(found[0].type, 'B738');
  assert.equal(found[0].registration, 'C-GXXX');
  assert.equal(found[0].watched, true);
  assert.equal(found[0].altitudeFt, 1800);
  assert.equal(found[0].climbFpm, 2050);
  assert.ok(found[0].distanceNm > 0 && found[0].distanceNm < 10);
});

test('a reading with no hex is skipped rather than stored under an empty key', () => {
  const engine = new DetectionEngine(options);
  assert.equal(engine.ingest([{ hex: '' }, {}], 1_000_000).length, 0);
  assert.equal(engine.snapshot().length, 0);
});

test('the state a poll writes keeps the callsign after a reading that omits it', () => {
  // Transponders drop the callsign from individual messages. Losing it on the
  // next poll would blank the name on the row the reader is looking at.
  const engine = new DetectionEngine(options);
  engine.ingest([{ hex: 'abc123', flight: 'ACA123', alt_baro: 5000, lat: 43.2, lon: -79.9 }], 1_000_000);
  engine.ingest([{ hex: 'abc123', alt_baro: 5200, lat: 43.21, lon: -79.9 }], 1_000_010);
  assert.equal(engine.stateOf('abc123').callsign, 'ACA123');
});

test('DEFAULTS are the values the page actually uses', () => {
  assert.equal(DEFAULTS.radiusNm, 10);
  assert.ok(DEFAULTS.cooldownMs >= 5 * 60 * 1000);
});

/* -------------------------------------------------------------- the units --- */

test('the reader picks kilometres and the feed is asked in nautical miles', () => {
  // "nobody understand nm" — so the unit the reader meets is km and the unit the
  // API takes is nm, and the conversion between them is exact: one nautical mile
  // is 1852 m by definition, not roughly.
  assert.equal(kmToNm(10), 5);
  assert.equal(kmToNm(20), 11);
  assert.equal(kmToNm(50), 27);
  assert.equal(nmToKm(5), 9);
  assert.equal(nmToKm(11), 20);
  assert.equal(nmToKm(27), 50);
});

test('the distance can never round down to zero, which would watch nothing', () => {
  // The feed's radius is an integer, so a very small choice rounds to 0 — and 0
  // nautical miles returns an empty sky that looks like a working page.
  assert.equal(kmToNm(0.4), 1);
  assert.equal(kmToNm(0), 1);
  assert.equal(kmToNm(-5), 1);
});

/* ------------------------------------------------------- watching a TYPE --- */

test('a type rule with NO tails watches every aircraft of that type', () => {
  // This is the whole feature: an empty filter means no filter. Reading an empty
  // tails list as "match nothing" would make the main control do the opposite of
  // what it says.
  const engine = new DetectionEngine(options);
  engine.setTypeRules([{ type: 'B38M', tails: [] }]);
  assert.equal(engine.isWatched({ hex: 'aaa111', t: 'B38M' }), true);
  assert.equal(engine.isWatched({ hex: 'bbb222', t: 'B38M' }), true);
  assert.equal(engine.isWatched({ hex: 'ccc333', t: 'A321' }), false);
});

test('a type rule WITH tails watches only those aircraft', () => {
  const engine = new DetectionEngine(options);
  engine.setTypeRules([{ type: 'B38M', tails: ['C-GXXX'] }]);
  assert.equal(engine.isWatched({ hex: 'aaa111', t: 'B38M', r: 'C-GXXX' }), true);
  // Hyphens and case do not matter — a registration is written with a hyphen and
  // transmitted without one.
  assert.equal(engine.isWatched({ hex: 'aaa111', t: 'B38M', r: 'cgxxx' }), true);
  assert.equal(engine.isWatched({ hex: 'bbb222', t: 'B38M', r: 'C-FABC' }), false);
  // …and narrowing to a tail must also stop watching the OTHER types.
  assert.equal(engine.isWatched({ hex: 'ccc333', t: 'A321', r: 'C-GXXX' }), false);
});

test('one type rule with tails does not silence another type wide open', () => {
  const engine = new DetectionEngine(options);
  engine.setTypeRules([
    { type: 'B38M', tails: ['C-GXXX'] },
    { type: 'C172', tails: [] },
  ]);
  assert.equal(engine.isWatched({ hex: 'a', t: 'C172', r: 'C-FZZZ' }), true, 'the wide rule was swallowed');
  assert.equal(engine.isWatched({ hex: 'b', t: 'B38M', r: 'C-FZZZ' }), false);
});

test('the most specific rule wins, so the board can say the truest thing', () => {
  // A tail number named on its own is reported as a tail number, not as "a type",
  // even when a type rule would also have caught it.
  const engine = new DetectionEngine(options, ['C-GXXX']);
  engine.setTypeRules([{ type: 'B38M', tails: [] }]);

  const named = engine.matchOf({ hex: 'aaa111', t: 'B38M', r: 'C-GXXX' });
  assert.equal(named.kind, 'aircraft');

  const byType = engine.matchOf({ hex: 'bbb222', t: 'B38M', r: 'C-FABC' });
  assert.equal(byType.kind, 'type');

  engine.setTypeRules([{ type: 'B38M', tails: ['C-FABC'] }]);
  assert.equal(engine.matchOf({ hex: 'bbb222', t: 'B38M', r: 'C-FABC' }).kind, 'type+tail');
});

test('an aircraft with no type code matches no type rule, whatever the rule says', () => {
  // `t` is a string and often empty. A rule for "" would silently match every
  // aircraft the feed could not identify.
  const engine = new DetectionEngine(options);
  engine.setTypeRules([{ type: '', tails: [] }]);
  assert.equal(engine.isWatched({ hex: 'aaa111' }), false);
  assert.equal(engine.isWatched({ hex: 'aaa111', t: '' }), false);
});

test('a departure remembers WHICH rule caught it', () => {
  const engine = new DetectionEngine(options, ['C-GXXX']);
  engine.setTypeRules([{ type: 'C172', tails: [] }]);

  const byType = engine.ingest(
    [{ hex: 'a1b2c3', t: 'C172', alt_baro: 2600, baro_rate: 1100, lat: 43.18, lon: -79.93 }],
    1_000_000
  );
  assert.equal(byType.length, 1);
  assert.equal(byType[0].watched, true);
  assert.equal(byType[0].matchedBy, 'type');
  assert.match(byType[0].matchedLabel, /C172/);

  const byName = engine.ingest(
    [{ hex: 'd4e5f6', t: 'B38M', r: 'C-GXXX', alt_baro: 3100, baro_rate: 2400, lat: 43.18, lon: -79.93 }],
    1_000_010
  );
  assert.equal(byName[0].matchedBy, 'aircraft');
});

test('an unwatched departure still lands on the board, marked as unwatched', () => {
  // The board is a record of what happened, not only of what was asked for —
  // otherwise the page looks broken whenever the reader watches nothing.
  const engine = new DetectionEngine(options);
  const found = engine.ingest(
    [{ hex: 'a1b2c3', t: 'C172', alt_baro: 2600, baro_rate: 1100, lat: 43.18, lon: -79.93 }],
    1_000_000
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].watched, false);
  assert.equal(found[0].matchedBy, null);
});

/* --------------------------------------- which way it is going, and where --- */

/**
 * George, 22 Sep 2026: *"the icon is always an airplane pointing up, but the airplane should point
 * towards its trajectory"* — and, of the lower map, *"are you able to trace its flight?"*.
 *
 * Both are things the feed has been answering all along and this site was throwing away: `track` was
 * in every reading and was not in the Reading interface at all. These cases pin the answers and,
 * more importantly, pin what happens when the feed says nothing — because "no heading" must not
 * become "heading north", and "one position" must not become "a flight path".
 */
const at = 1_000_000;

test('the heading comes from the track over the ground, which IS the trajectory', () => {
  const engine = new DetectionEngine(options);
  engine.ingest([{ hex: 'abc123', lat: 43.18, lon: -79.93, track: 271.5 }], at);
  assert.equal(engine.stateOf('abc123')?.trackDeg, 271.5);
});

test('the track is preferred, and the two heading fields are only fallbacks — in that order', () => {
  const engine = new DetectionEngine(options);
  // All three present: the ground track wins, because that is the direction of travel.
  engine.ingest(
    [{ hex: 'aaa111', lat: 43.18, lon: -79.93, track: 90, true_heading: 80, mag_heading: 70 }],
    at
  );
  assert.equal(engine.stateOf('aaa111')?.trackDeg, 90);

  // No track: the nose direction, which is true rather than magnetic.
  engine.ingest([{ hex: 'bbb222', lat: 43.18, lon: -79.93, true_heading: 80, mag_heading: 70 }], at);
  assert.equal(engine.stateOf('bbb222')?.trackDeg, 80);

  // Only magnetic is left. It is about 11 degrees out here and it is the LAST resort — but it is
  // still a real direction, and better than pretending the aircraft is heading north.
  engine.ingest([{ hex: 'ccc333', lat: 43.18, lon: -79.93, mag_heading: 70 }], at);
  assert.equal(engine.stateOf('ccc333')?.trackDeg, 70);
});

test('a heading the feed did not send is NOT north — it is absent', () => {
  const engine = new DetectionEngine(options);
  engine.ingest([{ hex: 'abc123', lat: 43.18, lon: -79.93 }], at);
  // Undefined, not 0. This is the whole defect in one line: the icon pointed north because nothing
  // said otherwise, and "nothing said otherwise" is not the same as "it is going north".
  assert.equal(engine.stateOf('abc123')?.trackDeg, undefined);
});

test('a heading that is not a finite number is refused rather than drawn', () => {
  const engine = new DetectionEngine(options);
  for (const [hex, track] of [
    ['nan000', Number.NaN],
    ['inf000', Number.POSITIVE_INFINITY],
    ['str000', 'north'],
  ]) {
    engine.ingest([{ hex, lat: 43.18, lon: -79.93, track }], at);
    assert.equal(engine.stateOf(hex)?.trackDeg, undefined, `${hex} was given a heading it cannot have`);
  }
});

test('a heading is normalised, so the feed 360 reads as north', () => {
  const engine = new DetectionEngine(options);
  engine.ingest([{ hex: 'aaa111', lat: 43.18, lon: -79.93, track: 360 }], at);
  assert.equal(engine.stateOf('aaa111')?.trackDeg, 0);
  engine.ingest([{ hex: 'bbb222', lat: 43.18, lon: -79.93, track: -10 }], at);
  assert.equal(engine.stateOf('bbb222')?.trackDeg, 350);
});

test('a reading with no heading keeps the last one, and does not blank it', () => {
  const engine = new DetectionEngine(options);
  engine.ingest([{ hex: 'abc123', lat: 43.18, lon: -79.93, track: 180 }], at);
  // A shorter frame a second later. Without the carried value the aeroplane would snap back to
  // pointing north for one poll and then back again — a flicker that reads as a broken page.
  engine.ingest([{ hex: 'abc123', lat: 43.19, lon: -79.94 }], at + 20_000);
  assert.equal(engine.stateOf('abc123')?.trackDeg, 180);
});

test('the flight path accumulates one point per new position', () => {
  const engine = new DetectionEngine(options);
  engine.ingest([{ hex: 'abc123', lat: 43.18, lon: -79.93 }], at);
  engine.ingest([{ hex: 'abc123', lat: 43.19, lon: -79.94 }], at + 20_000);
  engine.ingest([{ hex: 'abc123', lat: 43.2, lon: -79.95 }], at + 40_000);

  const trail = engine.stateOf('abc123')?.trail ?? [];
  assert.deepEqual(
    trail.map((point) => point.lat),
    [43.18, 43.19, 43.2]
  );
  assert.deepEqual(
    trail.map((point) => point.at),
    [at, at + 20_000, at + 40_000]
  );
});

test('one position is not a path, and a repeated position adds nothing', () => {
  const engine = new DetectionEngine(options);
  engine.ingest([{ hex: 'abc123', lat: 43.18, lon: -79.93 }], at);
  assert.equal(engine.stateOf('abc123')?.trail?.length, 1);

  // Same place, a poll later. A second identical point would draw a segment of zero length and make
  // the path look like more flying than happened.
  engine.ingest([{ hex: 'abc123', lat: 43.18, lon: -79.93 }], at + 20_000);
  assert.equal(engine.stateOf('abc123')?.trail?.length, 1);
});

test('a reading with no position never invents one, and the path still ages out', () => {
  const engine = new DetectionEngine(options);
  engine.ingest([{ hex: 'abc123', lat: 43.18, lon: -79.93 }], at);
  engine.ingest([{ hex: 'abc123' }], at + 20_000);
  // The path is unchanged — no borrowed point, no moved one.
  assert.deepEqual(engine.stateOf('abc123')?.trail?.map((p) => p.lat), [43.18]);

  // And a point older than the window is dropped even though nothing new was added.
  engine.ingest([{ hex: 'abc123' }], at + TRAIL_WINDOW_MS + 1);
  assert.equal(engine.stateOf('abc123')?.trail, undefined);
});

test('the path is capped, and it is the OLDEST that goes', () => {
  const engine = new DetectionEngine(options);
  for (let i = 0; i < TRAIL_POINTS + 8; i += 1) {
    engine.ingest([{ hex: 'abc123', lat: 43.18 + i * 0.001, lon: -79.93 }], at + i * 1_000);
  }
  const trail = engine.stateOf('abc123')?.trail ?? [];
  assert.equal(trail.length, TRAIL_POINTS);
  // The newest reading is the one on the end, and the first point is the eighth — a cap that kept
  // the old end would leave the aeroplane at the head of a path it has left.
  assert.equal(trail[trail.length - 1].lat, 43.18 + (TRAIL_POINTS + 7) * 0.001);
  assert.equal(trail[0].lat, 43.18 + 8 * 0.001);
});

test('a track nobody has heard from in a long time is forgotten', () => {
  // 🔴 THE LEAK THIS CLOSES. `tracks` was never pruned, so every aircraft ever heard stayed for the
  // life of the tab — tolerable for a dozen fields, not once each track also carries a flight path.
  const engine = new DetectionEngine(options);
  engine.ingest([{ hex: 'abc123', lat: 43.18, lon: -79.93 }], at);
  engine.ingest([{ hex: 'def456', lat: 43.4, lon: -79.9 }], at);

  // Another aircraft keeps the engine ingesting, so this is a real poll and not a paused page.
  engine.ingest([{ hex: 'zzz999', lat: 43.5, lon: -79.8 }], at + TRACK_TTL_MS + 1);

  assert.equal(engine.stateOf('abc123'), undefined, 'a stale track was kept');
  assert.equal(engine.stateOf('def456'), undefined, 'a stale track was kept');
  assert.ok(engine.stateOf('zzz999'), 'the aircraft that was just heard was dropped too');
});
