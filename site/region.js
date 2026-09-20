/**
 * region.ts — the airports offered, and the aircraft known to be BASED at one.
 *
 * Two lists, and they are different kinds of knowledge on purpose.
 *
 * ---------------------------------------------------------------- the airports
 *
 * A list of ICAO identifiers for the region — southern Ontario and everything
 * within a reasonable drive or flight of it. **Only the identifier is written
 * down.** The name and the position come from the feed's own airport endpoint,
 * fetched by `tools/verify-airports.mjs` into `site/airports.json`, so a mistyped
 * or retired code is dropped by the source rather than believed by us. A
 * hard-coded latitude is a fact that goes wrong silently: the page still draws,
 * the feed still answers, and it quietly watches the wrong piece of sky.
 *
 * ⚠️ The list is a REGION, not the world. "Airports around you" is answered from
 * this set, so somebody in Vancouver sees Vancouver and somebody in Hamilton sees
 * Hamilton — but somebody in Australia sees nothing, and the page says so rather
 * than pretending. Widening it is one array.
 *
 * ------------------------------------------------------------- the residents
 *
 * 🔴 GEORGE, 20 Sep 2026: *"hamilton should have landcaster i didnt see it."*
 *
 * He is right, and the reason the Lancaster was missing is the interesting part:
 * **the survey measures what FLIES, and a museum aircraft mostly does not.** The
 * Mynarski Memorial Lancaster is based at Hamilton and is one of only two
 * airworthy Lancasters in the world — and it flies a handful of times a year, so
 * no three-round sample will ever catch it. A list built only from sightings will
 * therefore always be missing exactly the aircraft a person most wants to see.
 *
 * So there is a second, CURATED list: aircraft known to be based at a place. It is
 * labelled as curated wherever it is shown, never mixed in with the measured
 * counts, because "we were told this is here" and "we saw this here" are different
 * claims and the page must not blur them.
 */
/** The airports offered, by identifier only. Positions are fetched, never typed. */
export const REGION_AIRPORTS = [
    // Ontario — Hamilton and the Golden Horseshoe
    'CYHM', 'CYKF', 'CYYZ', 'CYTZ', 'CYZD', 'CYKZ', 'CYYB', 'CYOO', 'CYSN', 'CYQA',
    'CNC3', 'CYZE', 'CYLS', 'CYXU', 'CYGD', 'CPB8', 'CNF4',
    // Ontario — west and north
    'CYQG', 'CYCK', 'CYLD', 'CYSB', 'CYTS', 'CYYU', 'CYEL', 'CYMO', 'CYHF', 'CYWA',
    // Ontario — east
    'CYOW', 'CYGK', 'CYTR', 'CYCC', 'CYRP', 'CYSH', 'CYTA', 'CYBN',
    // Québec
    'CYUL', 'CYHU', 'CYMX', 'CYQB', 'CYJN', 'CYSC', 'CYBG', 'CYGP',
    // New York, Ohio, Michigan and Pennsylvania — within reach of the border
    'KBUF', 'KROC', 'KSYR', 'KITH', 'KALB', 'KERI', 'KPBG', 'KART', 'KMSS', 'KOGS',
    'KCLE', 'KTOL', 'KDTW', 'KYIP', 'KARB', 'KFNT', 'KGRR', 'KLAN', 'KMBS', 'KAPN',
    'KPIT', 'KMDT', 'KAVP',
    // Far enough out to be worth offering, still a real destination from here
    'CYVR', 'CYYC', 'CYEG', 'CYWG', 'CYHZ', 'CYYT', 'CYFB', 'CYXY', 'KSEA', 'KORD',
];
/**
 * Aircraft that are BASED at an airport rather than merely passing through, and
 * that a short sample will not find because they rarely fly.
 *
 * 🔴 EVERY CLAIM HERE NEEDS A SOURCE IT CAN BE CHECKED AGAINST, and the source is
 * named beside it. Nothing in this table is a guess: an entry that cannot be
 * sourced does not belong here, and an unsourced one would be exactly the kind of
 * "plausible-sounding fact" this project keeps having to remove.
 */
/*
 * 🔴 THE HAND-LISTED AIRCRAFT THAT USED TO LIVE HERE IS GONE. George,
 * 20 Sep 2026: *"i dont want to list by hand"*. It held Hamilton's Lancaster as a
 * curated entry, worked out by hand from the museum's own record, because a survey
 * of one afternoon can never see an aeroplane that flies a handful of times a
 * year. The reasoning was sound and the instruction is the instruction, and the
 * Lancaster is not lost with it: `LANC` is a named type in `typeinfo.ts`, read out
 * of the feed's own aircraft database, so it appears under Warplanes the moment it
 * transmits — which is the honest way for it to arrive, and the only way that
 * cannot go stale.
 *
 * What remains here is a list of IDENTIFIERS. Nothing in it is a claim about the
 * world; every one is checked against the feed by `tools/verify-airports.mjs`
 * before it reaches the page.
 */
