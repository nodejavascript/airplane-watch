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
  phaseOf,
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

  // Past the cooldown it may fire once more — an aircraft that lands and leaves
  // again inside one session is a second departure, not a duplicate.
  const after = engine.ingest([{ ...climb, alt_baro: 12_000 }], 1_000_000 + 21 * 60_000);
  assert.equal(after.length, 1);
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
