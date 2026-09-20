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
export const REGION_AIRPORTS: string[] = [
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
export interface Resident {
  /** The type, in words — this is the thing the visitor picks. */
  name: string;
  /**
   * The key used to match it in the feed. Registrations are how a warbird or a
   * rare airframe is actually watched.
   */
  registration: string;
  /**
   * The ICAO type code the aircraft transmits, where one is known.
   *
   * 🔴 THIS IS NOT INVENTED, AND THE COMMENT ABOVE USED TO SAY THE OPPOSITE —
   * that a warbird "usually has no current ICAO type designator to match on".
   * That is wrong, and it was wrong in the way that matters: it was a claim about
   * the world made from assumption rather than from a source. Read 20 Sep 2026
   * out of the aircraft database the feed itself uses (617,361 airframes):
   * `C07DD7;C-GVRA;LANC;00;AVRO Lancaster`. The Lancaster's designator is `LANC`,
   * the same one the RAF's PA474 carries. So a type watch on `LANC` works, and a
   * reader can ask for the aeroplane by name rather than by tail number.
   */
  typeCode?: string;
  /** Also matched, when the feed reports any of these. */
  alsoMatch?: string[];
  note: string;
  source: string;
}

export const RESIDENTS: Record<string, Resident[]> = {
  CYHM: [
    {
      name: 'Avro Lancaster Mk. X',
      registration: 'C-GVRA',
      typeCode: 'LANC',
      // The museum's own page gives the markings, which is what gets painted on
      // the aeroplane and sometimes what a radio operator reads out.
      alsoMatch: ['KB726', 'VR-A'],
      note:
        'The Mynarski Memorial Lancaster, marked RCAF KB726 / “VeRA” — built at Malton in 1945, and one of only two airworthy Lancasters left in the world. It flies a handful of times a year, which is exactly why a three-round survey of 720 sightings never once saw it.',
      source:
        'https://www.warplane.com/aircraft/collection/details.aspx?aircraftId=4 — Canadian Warplane Heritage Museum, 9280 Airport Road, Mount Hope, ON. Read 20 Sep 2026: serial RCAF FM213, construction number 3414, civil registration C-GVRA, status “Airworthy (flown regularly)”, current markings RCAF KB726.',
    },
  ],
};
