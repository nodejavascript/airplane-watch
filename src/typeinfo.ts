/**
 * typeinfo.ts — turning the feed's four-letter aircraft codes into something a
 * person can read, and sorting them into kinds.
 *
 * The feed reports `t`, an ICAO type designator: `B38M`, `C172`, `DH8D`. That is
 * precise and useless — nobody knows what `B38M` is. So every code gets a name,
 * and a class, because the classes are what make the measured list navigable:
 * "20 sightings of C172" and "20 sightings of B789" mean very different things
 * and a reader should not have to know that to see it.
 *
 * 🔴 THE CODES AND NAMES COVER EVERY TYPE THE SURVEY ACTUALLY FOUND — all 54 of
 * them, measured 20 Sep 2026 across seven airports (`tools/survey-types.mjs`,
 * `site/types.json`) — plus the common ones a visitor is likely to meet at one of
 * these airports on another day. **An unknown code is NOT guessed at**: it is
 * shown as the raw code with its class left as "other", because inventing a name
 * for a code is the same failure as inventing a type out of a blank `t` field.
 */

export type AircraftClass =
  | 'airliner'
  | 'regional'
  | 'business'
  | 'light'
  | 'helicopter'
  | 'military'
  | 'other';

export interface TypeInfo {
  code: string;
  name: string;
  klass: AircraftClass;
}

const CLASS_LABEL: Record<AircraftClass, string> = {
  airliner: 'Airliner',
  regional: 'Regional',
  business: 'Private & business',
  light: 'Light & training',
  helicopter: 'Helicopter',
  military: 'Heritage & war planes',
  other: 'Other',
};

export function classLabel(klass: AircraftClass): string {
  return CLASS_LABEL[klass] ?? CLASS_LABEL.other;
}

/**
 * 🔴 THE CLASSES THAT ARE CIVIL, AND WHY THIS LIST HAS TO EXIST.
 *
 * `site/military.json` is harvested from the feed's own MILITARY feed — a
 * **global** query that takes no point and no radius, as its own `covers` field
 * says out loud. So any type that *any* air force anywhere flies appears in it,
 * and a type-level "military" flag taken from that file reclassifies the ordinary
 * fleet.
 *
 * Measured on the files in this repository, 20 Sep 2026: the global military feed
 * flags **11 of the 62 types the station survey actually sees** — `C172`, `DH8D`,
 * `A320`, `A319`, `C182`, `A21N`, `B737`, `C560`, `A139`, `PC12`, `BE9L`. Applied
 * naively, that put the Cessna 172 and the Dash 8 Q400 under **Warplanes** and hid
 * the Boeing 737 and the Airbus A320 from **Airliner**. That is the defect this
 * list closes.
 *
 * The rule that follows: a type the table already knows to be a civil aircraft is
 * NEVER reclassified by the feed's global military flag. The flag may only classify
 * a code this table does not place — which is how the C-17, the C-130 and the
 * Chinook still land under Warplanes.
 */
const CIVIL_CLASSES: ReadonlySet<AircraftClass> = new Set<AircraftClass>([
  'airliner',
  'regional',
  'business',
  'light',
  'helicopter',
]);

/** True when this site already knows the code as a civil aircraft. */
export function isCivilClass(klass: AircraftClass): boolean {
  return CIVIL_CLASSES.has(klass);
}

/**
 * code -> [name, class]. Grouped by class so the list can be read, and so an
 * omission is obvious: a code sitting under the wrong heading is a mistake you
 * can see.
 */
const TABLE: Record<string, [string, AircraftClass]> = {
  /* ------------------------------------------------------------- airliners --- */
  /* ------------------------------- military and historic types ("warplanes") ---
   * 🔴 EVERY CODE BELOW WAS READ OUT OF THE FEED'S OWN AIRCRAFT DATABASE, not
   * from memory. That is the same file a receiver uses to turn a transponder
   * address into a type — downloaded 20 Sep 2026 from
   * `https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz`
   * (617,361 airframes) — and the number in each comment is how many airframes
   * in it carry that code, so a code nobody uses is visible as such.
   *
   * 🔴 WHY THIS IS A SHORT LIST, AND IT SAYS SO. A modern fighter or a transport
   * on a military task very often does not transmit ADS-B at all, or transmits
   * without the flag that would mark it military — measured the same day, the
   * feed's own military feed reported 162 aircraft worldwide. So this class is
   * NOT "every warplane" and must never be presented as one. It is (a) the
   * historic types below, which do transmit because they now fly as
   * civilian-registered aircraft, and (b) whatever the feed itself flags as
   * military, which the page adds at run time from `military.json`.
   *
   * The Lancaster is the reason this class exists: Hamilton is its home, it
   * flies a handful of times a year, and the Hamilton airframe is registered
   * **C-GVRA** with type code **LANC**. Verified in that same database:
   * `C07DD7;C-GVRA;LANC;00;AVRO Lancaster`.
   */
  LANC: ['Avro Lancaster', 'military'], //   2 — incl. C-GVRA at Hamilton
  B25: ['North American B-25 Mitchell', 'military'], //   55
  SPIT: ['Supermarine Spitfire', 'military'], //   84
  HURI: ['Hawker Hurricane', 'military'], //   15
  HAHU: ['Hawker Hurricane (alt code)', 'military'], //    3
  CORS: ['Vought F4U Corsair', 'military'], //   53
  P51: ['North American P-51 Mustang', 'military'], //  242
  P40: ['Curtiss P-40 Warhawk', 'military'], //   48
  F86: ['North American F-86 Sabre', 'military'], //   28
  VAMP: ['de Havilland Vampire', 'military'], //   20
  ME09: ['Messerschmitt Bf 109', 'military'], //   22
  ME08: ['Messerschmitt Me 262', 'military'], //   14
  LYSA: ['Westland Lysander', 'military'], //    4
  WFUR: ['Hawker Sea Fury', 'military'], //    1
  WCAT: ['Grumman FM-2 Wildcat', 'military'], //    1
  BLEN: ['Bristol Bolingbroke', 'military'], //    1
  A1: ['Douglas A-1 Skyraider', 'military'], //    2
  T6: ['North American T-6 Texan', 'military'], //  808
  DC3: ['Douglas DC-3 / C-47 Dakota', 'military'], //  221
  DC3T: ['Douglas DC-3 (turbine)', 'military'], //   17
  B38M: ['Boeing 737 MAX 8', 'airliner'],
  B738: ['Boeing 737-800', 'airliner'],
  B739: ['Boeing 737-900', 'airliner'],
  B737: ['Boeing 737-700', 'airliner'],
  B39M: ['Boeing 737 MAX 9', 'airliner'],
  B752: ['Boeing 757-200', 'airliner'],
  B763: ['Boeing 767-300', 'airliner'],
  B77L: ['Boeing 777-200LR', 'airliner'],
  B77W: ['Boeing 777-300ER', 'airliner'],
  B788: ['Boeing 787-8 Dreamliner', 'airliner'],
  B789: ['Boeing 787-9 Dreamliner', 'airliner'],
  B78X: ['Boeing 787-10 Dreamliner', 'airliner'],
  B744: ['Boeing 747-400', 'airliner'],
  B748: ['Boeing 747-8', 'airliner'],
  A319: ['Airbus A319', 'airliner'],
  A320: ['Airbus A320', 'airliner'],
  A20N: ['Airbus A320neo', 'airliner'],
  A321: ['Airbus A321', 'airliner'],
  A21N: ['Airbus A321neo', 'airliner'],
  A332: ['Airbus A330-200', 'airliner'],
  A333: ['Airbus A330-300', 'airliner'],
  A343: ['Airbus A340-300', 'airliner'],
  A359: ['Airbus A350-900', 'airliner'],
  A35K: ['Airbus A350-1000', 'airliner'],
  BCS1: ['Airbus A220-100', 'airliner'],
  BCS3: ['Airbus A220-300', 'airliner'],
  E295: ['Embraer E195-E2', 'airliner'],
  E290: ['Embraer E190-E2', 'airliner'],

  /* --------------------------------------------------------------- regional --- */
  CRJ2: ['Bombardier CRJ-200', 'regional'],
  CRJ7: ['Bombardier CRJ-700', 'regional'],
  CRJ9: ['Bombardier CRJ-900', 'regional'],
  E145: ['Embraer ERJ 145', 'regional'],
  E135: ['Embraer ERJ 135', 'regional'],
  E170: ['Embraer 170', 'regional'],
  E75L: ['Embraer 175', 'regional'],
  E75S: ['Embraer 175', 'regional'],
  E190: ['Embraer 190', 'regional'],
  E195: ['Embraer 195', 'regional'],
  /* 🔴 THE DASH 8 IS NOT CALLED A "BOMBARDIER" ANY MORE, AND THE NAME A VISITOR
   * KNOWS IS "DASH 8". George, 20 Sep 2026: *"**Bombardier Dash 8 Q400** is there
   * another description that is more common to the average user"*. Two things were
   * wrong with the old name and only one of them was the maker:
   *
   *   1. de Havilland Canada built it, Bombardier only owned the programme from
   *      1992 to 2019, and it has been de Havilland Canada again since — so
   *      "Bombardier" dates the aeroplane to a window most of its life is outside.
   *   2. Nobody at an airport says "Dash 8 Q400". They say **the Dash 8**, because
   *      it is the aeroplane that lands at Hamilton several times a day.
   *
   * So the maker is right, the family name leads, and the marketing suffix stays in
   * brackets for anybody who knows it by that. Change the SORT NAME with it or the
   * alphabetical list lies about where the row is. */
  DH8A: ['Dash 8-100', 'regional'],
  DH8B: ['Dash 8-200', 'regional'],
  DH8C: ['Dash 8-300', 'regional'],
  DH8D: ['Dash 8-400 (Q400)', 'regional'],
  DH3T: ['de Havilland Canada DHC-3 Turbo Otter', 'regional'],
  SF34: ['Saab 340', 'regional'],
  B190: ['Beechcraft 1900', 'regional'],
  AT72: ['ATR 72', 'regional'],
  AT76: ['ATR 72-600', 'regional'],
  AT45: ['ATR 42-500', 'regional'],

  /* ------------------------------------------------------ private & business --- */
  E55P: ['Embraer Phenom 300', 'business'],
  C68A: ['Cessna Citation Latitude', 'business'],
  C680: ['Cessna Citation Sovereign', 'business'],
  C550: ['Cessna Citation II', 'business'],
  C501: ['Cessna Citation I', 'business'],
  C25A: ['Cessna Citation CJ2', 'business'],
  C25B: ['Cessna Citation CJ3', 'business'],
  C25C: ['Cessna Citation CJ4', 'business'],
  C560: ['Cessna Citation V', 'business'],
  C56X: ['Cessna Citation Excel', 'business'],
  C750: ['Cessna Citation X', 'business'],
  CL30: ['Bombardier Challenger 300', 'business'],
  CL35: ['Bombardier Challenger 350', 'business'],
  CL60: ['Bombardier Challenger 600', 'business'],
  GLEX: ['Bombardier Global Express', 'business'],
  GL7T: ['Bombardier Global 7500', 'business'],
  LJ45: ['Learjet 45', 'business'],
  LJ60: ['Learjet 60', 'business'],
  ASTR: ['IAI Astra', 'business'],
  F2TH: ['Dassault Falcon 2000', 'business'],
  F900: ['Dassault Falcon 900', 'business'],
  PC12: ['Pilatus PC-12', 'business'],
  PC24: ['Pilatus PC-24', 'business'],
  BE20: ['Beechcraft King Air 200', 'business'],
  BE30: ['Beechcraft King Air 300', 'business'],
  /* 🔴 THE CODES BELOW WERE ADDED ON 20 Sep 2026 FOR ONE REASON: THE FEED'S
   * GLOBAL MILITARY FEED LISTS EVERY ONE OF THEM, AND EVERY ONE OF THEM IS AN
   * ORDINARY CIVIL AEROPLANE. A King Air 350, a King Air 90, a Falcon 50, an
   * AW169, a Dauphin and a Bell 212 are all flown by air forces somewhere — so
   * before this they were reclassified as warplanes and the airliners they were
   * parked beside vanished from the Airliner filter with them. Naming them here
   * is what makes the civil classes win. */
  B350: ['Beechcraft King Air 350', 'business'],
  BE9L: ['Beechcraft King Air 90', 'business'],
  FA50: ['Dassault Falcon 50', 'business'],
  BE40: ['Beechcraft 400 Beechjet', 'business'],
  BE58: ['Beechcraft Baron 58', 'business'],
  TBM8: ['Socata TBM 850', 'business'],
  TBM9: ['Daher TBM 900', 'business'],
  PAY2: ['Piper Cheyenne 2', 'business'],
  C441: ['Cessna Conquest II', 'business'],

  /* ------------------------------------------------------ light & training --- */
  C150: ['Cessna 150', 'light'],
  C152: ['Cessna 152', 'light'],
  C172: ['Cessna 172 Skyhawk', 'light'],
  C182: ['Cessna 182 Skylane', 'light'],
  C185: ['Cessna 185 Skywagon', 'light'],
  C206: ['Cessna 206 Stationair', 'light'],
  C208: ['Cessna 208 Caravan', 'light'],
  C210: ['Cessna 210 Centurion', 'light'],
  P28A: ['Piper PA-28 Cherokee', 'light'],
  P28R: ['Piper PA-28R Cherokee Arrow', 'light'],
  PA28: ['Piper PA-28 Cherokee', 'light'],
  PA44: ['Piper PA-44 Seminole', 'light'],
  PA46: ['Piper PA-46 Malibu', 'light'],
  S22T: ['Cirrus SR22T', 'light'],
  SR22: ['Cirrus SR22', 'light'],
  SR20: ['Cirrus SR20', 'light'],
  TB20: ['Socata TB-20 Trinidad', 'light'],
  TB21: ['Socata TB-21 Trinidad', 'light'],
  DA40: ['Diamond DA40', 'light'],
  DA42: ['Diamond DA42 Twin Star', 'light'],
  LA4: ['Lake LA-4 Buccaneer', 'light'],
  DHC2: ['de Havilland Canada Beaver', 'light'],
  DHC6: ['de Havilland Canada Twin Otter', 'light'],
  M20P: ['Mooney M20', 'light'],
  RV7: ['Van’s RV-7', 'light'],
  RV8: ['Van’s RV-8', 'light'],
  BE36: ['Beechcraft Bonanza 36', 'light'],
  GLID: ['Glider', 'light'],
  ULAC: ['Ultralight', 'light'],

  /* ------------------------------------------------------------ helicopters --- */
  H500: ['Hughes 500', 'helicopter'],
  H60: ['Sikorsky UH-60 Black Hawk', 'helicopter'],
  R22: ['Robinson R22', 'helicopter'],
  R44: ['Robinson R44', 'helicopter'],
  R66: ['Robinson R66', 'helicopter'],
  B407: ['Bell 407', 'helicopter'],
  B412: ['Bell 412', 'helicopter'],
  B429: ['Bell 429', 'helicopter'],
  AS50: ['Airbus H125', 'helicopter'],
  AS55: ['Airbus H155', 'helicopter'],
  EC30: ['Airbus H130', 'helicopter'],
  EC35: ['Airbus H135', 'helicopter'],
  EC45: ['Airbus H145', 'helicopter'],
  A139: ['Leonardo AW139', 'helicopter'],
  A109: ['Leonardo A109', 'helicopter'],
  A169: ['Leonardo AW169', 'helicopter'],
  AS65: ['Airbus AS365 Dauphin', 'helicopter'],
  B212: ['Bell 212', 'helicopter'],
  S76: ['Sikorsky S-76', 'helicopter'],
  S92: ['Sikorsky S-92', 'helicopter'],
};

/** The name for a code, its class, and whether we actually know the code. */
export function describeType(code: string | undefined | null): TypeInfo & { known: boolean } {
  const key = String(code ?? '').trim().toUpperCase();
  const found = TABLE[key];
  if (!found) {
    // Not a guess. An unrecognised code is shown as itself.
    return { code: key, name: key ? `${key} (type not in this list)` : 'type unknown', klass: 'other', known: false };
  }
  return { code: key, name: found[0], klass: found[1], known: true };
}

/** How many codes this site can name — printed on the page so the gap is visible. */
export function knownTypeCount(): number {
  return Object.keys(TABLE).length;
}

/**
 * The order the classes are offered in.
 *
 * 🔴 WARPLANES IS FIRST, AND THAT IS GEORGE'S INSTRUCTION, NOT AN ACCIDENT OF
 * SORTING. 20 Sep 2026: *"war plans should be first option"*. It is deliberately
 * not "commonest first" — the commonest aircraft at these airports is an airliner
 * and the reader can already see a hundred of those in the live list without
 * filtering for them. The rare thing is what a filter is for, so the rare thing
 * goes first.
 */
export const CLASS_ORDER: AircraftClass[] = [
  'military',
  'airliner',
  'regional',
  'business',
  'light',
  'helicopter',
  'other',
];
