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
export const DEFAULTS = {
    radiusNm: 10,
    staleAfterSec: 60,
    cooldownMs: 20 * 60 * 1000,
};
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
export function phaseOf(reading) {
    if (reading.alt_baro === 'ground')
        return 'ground';
    if (typeof reading.alt_baro === 'number' && Number.isFinite(reading.alt_baro))
        return 'airborne';
    return 'unknown';
}
/** True when the sample is too old to prove anything. */
export function isStale(reading, staleAfterSec) {
    const seen = reading.seen;
    if (typeof seen !== 'number' || !Number.isFinite(seen))
        return false;
    return seen > staleAfterSec;
}
/**
 * Great-circle distance in nautical miles. The fence has to be measured, not
 * assumed: an airport's own coordinate is not where an aircraft is, and a
 * rectangle around a runway reaches much further along the diagonals than a
 * circle does.
 */
export function distanceNm(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180;
    const earthNm = 3440.065;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * earthNm * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function insideFence(reading, options) {
    if (typeof reading.lat !== 'number' || typeof reading.lon !== 'number')
        return false;
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
export function judgeTakeoff(previous, reading, options) {
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
/**
 * The engine: keep one TrackState per aircraft and turn a poll into 0..n
 * departures. Deliberately a plain class over a Map, so a test can feed it a
 * scripted sequence of polls and assert exactly what came out — which is how the
 * two guards that matter (cooldown, already-airborne) are proved rather than
 * hoped for.
 */
export class DetectionEngine {
    tracks = new Map();
    firedAt = new Map();
    options;
    watchlist;
    constructor(options, watchlist = []) {
        this.options = options;
        this.watchlist = new Set([...watchlist].map(normaliseKey));
    }
    /** The names the reader asked to be told about — hex, callsign or tail number. */
    setWatchlist(keys) {
        this.watchlist = new Set([...keys].map(normaliseKey));
    }
    /** Does this aircraft match anything the reader is watching? */
    isWatched(reading) {
        if (this.watchlist.size === 0)
            return false;
        return (this.watchlist.has(normaliseKey(reading.hex)) ||
            (!!reading.flight && this.watchlist.has(normaliseKey(reading.flight))) ||
            (!!reading.r && this.watchlist.has(normaliseKey(reading.r))));
    }
    stateOf(hex) {
        return this.tracks.get(hex);
    }
    /** Every aircraft we hold, newest reading first. */
    snapshot() {
        return [...this.tracks.values()].sort((a, b) => b.observedAt - a.observedAt);
    }
    /**
     * Take one poll and return the departures it proves.
     *
     * `now` is a parameter rather than `Date.now()` because the cooldown is the
     * rule most likely to be wrong, and a rule that cannot be fast-forwarded in a
     * test is a rule nobody checks.
     */
    ingest(readings, now) {
        const found = [];
        for (const reading of readings) {
            if (!reading || typeof reading.hex !== 'string' || reading.hex === '')
                continue;
            const hex = reading.hex.toLowerCase();
            const previous = this.tracks.get(hex);
            const decision = judgeTakeoff(previous, reading, { ...this.options, now });
            const watched = this.isWatched(reading);
            if (decision.verdict !== 'none') {
                const last = this.firedAt.get(hex);
                const cooling = last !== undefined && now - last < this.options.cooldownMs;
                // 🔴 The cooldown applies to an INFERRED departure only. A confirmed
                // ground-to-air transition cannot repeat within one departure, and
                // suppressing one because an inference fired earlier would lose the only
                // event this whole page exists to report.
                if (!(decision.verdict === 'inferred' && cooling)) {
                    const altitudeFt = typeof reading.alt_baro === 'number' ? Math.round(reading.alt_baro) : null;
                    const climbFpm = typeof reading.baro_rate === 'number' ? Math.round(reading.baro_rate) : null;
                    const distanceToAirport = typeof reading.lat === 'number' && typeof reading.lon === 'number'
                        ? Math.round(distanceNm(this.options.lat, this.options.lon, reading.lat, reading.lon) * 10) / 10
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
                    });
                    this.firedAt.set(hex, now);
                }
            }
            // Write the state AFTER judging, so the judgement used the reading as it
            // arrived rather than as this function just rewrote it.
            const phase = phaseOf(reading);
            const next = {
                hex,
                phase,
                observedAt: now,
                groundAt: phase === 'ground' ? now : previous?.groundAt,
                airborneAt: phase === 'airborne' && previous?.phase === 'ground' ? now : previous?.airborneAt,
                callsign: (reading.flight || '').trim() || previous?.callsign || '',
                registration: reading.r || previous?.registration || '',
                type: reading.t || previous?.type || '',
                watched,
            };
            this.tracks.set(hex, next);
        }
        return found;
    }
}
/**
 * One key shape for hex, callsign and tail number, so "c-gxxx", "C-GXXX" and
 * "cgxxx" are the same aircraft to the reader who typed it. Aircraft
 * registrations are written with a hyphen and transmitted without one.
 */
export function normaliseKey(value) {
    return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
