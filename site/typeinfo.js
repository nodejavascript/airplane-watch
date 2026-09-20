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
const CLASS_LABEL = {
    airliner: 'Airliner',
    regional: 'Regional',
    business: 'Private & business',
    light: 'Light & training',
    helicopter: 'Helicopter',
    other: 'Other',
};
export function classLabel(klass) {
    return CLASS_LABEL[klass] ?? CLASS_LABEL.other;
}
/**
 * code -> [name, class]. Grouped by class so the list can be read, and so an
 * omission is obvious: a code sitting under the wrong heading is a mistake you
 * can see.
 */
const TABLE = {
    /* ------------------------------------------------------------- airliners --- */
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
    E170: ['Embraer 170', 'regional'],
    E75L: ['Embraer 175', 'regional'],
    E75S: ['Embraer 175', 'regional'],
    E190: ['Embraer 190', 'regional'],
    E195: ['Embraer 195', 'regional'],
    DH8A: ['Bombardier Dash 8-100', 'regional'],
    DH8C: ['Bombardier Dash 8-300', 'regional'],
    DH8D: ['Bombardier Dash 8 Q400', 'regional'],
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
    S76: ['Sikorsky S-76', 'helicopter'],
    S92: ['Sikorsky S-92', 'helicopter'],
};
/** The name for a code, its class, and whether we actually know the code. */
export function describeType(code) {
    const key = String(code ?? '').trim().toUpperCase();
    const found = TABLE[key];
    if (!found) {
        // Not a guess. An unrecognised code is shown as itself.
        return { code: key, name: key ? `${key} (type not in this list)` : 'type unknown', klass: 'other', known: false };
    }
    return { code: key, name: found[0], klass: found[1], known: true };
}
/** How many codes this site can name — printed on the page so the gap is visible. */
export function knownTypeCount() {
    return Object.keys(TABLE).length;
}
/** The order the classes are shown in, commonest first for a Canadian airport. */
export const CLASS_ORDER = [
    'airliner',
    'regional',
    'business',
    'light',
    'helicopter',
    'other',
];
