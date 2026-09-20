/**
 * thumbs.ts — the little aeroplane drawn beside every type in the list.
 *
 * George, 20 Sep 2026: *"can we have a thumbnail of the plane?"*
 *
 * ---------------------------------------------------------------- WHAT IT IS
 *
 * 🔴 IT IS A SHAPE OF SEEING, NOT A PHOTOGRAPH. There is no picture library behind
 * this file and none is pretended: each drawing is a **top-down silhouette for a
 * KIND of aeroplane** — a swept-wing jet, a high-wing turboprop, a light
 * single — chosen from the type's class and, for the aeroplanes whose shape is
 * unmistakable, from the code itself. So the Dash 8 gets the high-wing twin
 * turboprop it is, and the Lancaster gets four engines on a straight wing, and
 * the Cessna 172 gets the single high-wing it is, while a Boeing 787 and an Airbus
 * A320 share the swept-wing jet, because from above at 40 pixels they are the same
 * drawing and inventing a difference would be inventing a fact.
 *
 * That is the honest limit, and it is why the drawing is `aria-hidden` beside a
 * printed name: **the silhouette is a glance, the name is the truth.**
 *
 * ------------------------------------------------------------- WHY NOT IMAGES
 *
 * A photograph of each type would be a licence we do not hold, a file per type
 * that goes stale, and a network request per row. These are inline SVG on the
 * page, drawn in `currentColor` so they take the row's own colour, cost nothing,
 * load with the HTML, and cannot 404. The site already draws its own marks this
 * way — the brand bar's five circles are the same technique.
 *
 * Drawn nose-up in a 48 × 48 box, stroke-only, so they sit on any background.
 */
/* ------------------------------------------------------------------ shapes ---
 * Every path is written in a 48 × 48 box with the nose at the top. Coordinates are
 * whole or half numbers so the drawing stays crisp when it is scaled down. */
const FUSELAGE = 'M24 4.5c2.4 0 3.6 2.4 3.6 5.6V38c0 3.4-1.2 5.6-3.6 5.6s-3.6-2.2-3.6-5.6V10.1c0-3.2 1.2-5.6 3.6-5.6Z';
const SHAPES = {
    // Swept wings, two engines under them, a thin fin along the tail. The 737, the
    // A320, the CRJ, the E-Jet — from above, one drawing.
    jet: `<path d="${FUSELAGE}"/>` +
        '<path d="M20.6 21 4.6 33.4v3.1l16-7V21Z"/>' +
        '<path d="M27.4 21l16 12.4v3.1l-16-7V21Z"/>' +
        '<path d="M21 38.6 13 44.2v1.6l8-3.1Z"/>' +
        '<path d="M27 38.6l8 5.6v1.6l-8-3.1Z"/>' +
        '<path d="M23.3 33.2h1.4V45h-1.4Z"/>' +
        '<circle cx="14.4" cy="31.4" r="1.9"/>' +
        '<circle cx="33.6" cy="31.4" r="1.9"/>',
    // Straight wing high on the body, two engine nacelles with a propeller line
    // across each, and a tailplane at the very back. The Dash 8, the ATR, the Twin
    // Otter — the aeroplanes that land at Hamilton all day.
    turboprop: `<path d="${FUSELAGE}"/>` +
        '<path d="M20.6 20.4H6v2.6h14.6Z"/>' +
        '<path d="M27.4 20.4H42v2.6H27.4Z"/>' +
        '<circle cx="11" cy="21.7" r="2"/>' +
        '<circle cx="37" cy="21.7" r="2"/>' +
        '<path d="M11 17.8v7.8M37 17.8v7.8"/>' +
        '<path d="M18.6 40.6h10.8v2H18.6Z"/>' +
        '<path d="M23.3 36.4h1.4v8.4h-1.4Z"/>',
    // A short body, wings swept and set back, two engines on the REAR fuselage and a
    // tailplane at the top of the fin. Citation, Challenger, Global, Learjet.
    bizjet: '<path d="M24 6c2 0 3 2 3 4.6V37c0 2.8-1 4.6-3 4.6s-3-1.8-3-4.6V10.6C21 8 22 6 24 6Z"/>' +
        '<path d="M20.9 22.6 6.2 31.4v2.8l14.7-5.4Z"/>' +
        '<path d="M27.1 22.6l14.7 8.8v2.8l-14.7-5.4Z"/>' +
        '<path d="M20.4 32.4h1.8v5.2h-1.8Z"/>' +
        '<path d="M25.8 32.4H27.6v5.2h-1.8Z"/>' +
        '<path d="M17.6 40.4h12.8v2H17.6Z"/>' +
        '<path d="M23.3 35.6h1.4v8.8h-1.4Z"/>',
    // One propeller at the nose and a straight wing across the top — a Cessna, a
    // Piper, a Diamond. The aeroplane most people learn in.
    prop: `<path d="${FUSELAGE}"/>` +
        '<path d="M20.6 19.6H7.4v3.2h13.2Z"/>' +
        '<path d="M27.4 19.6h13.2v3.2H27.4Z"/>' +
        '<path d="M20.2 6.6h7.6"/>' +
        '<path d="M18.8 40.8h10.4v2.2H18.8Z"/>' +
        '<path d="M23.3 36.6h1.4v8.6h-1.4Z"/>',
    // The rotor disc is the whole point: a circle, a small body under it, and a tail
    // boom out to the tail rotor.
    heli: '<circle cx="24" cy="19.5" r="14"/>' +
        '<ellipse cx="24" cy="20.5" rx="4.4" ry="8.4"/>' +
        '<path d="M23.2 28v13h1.6V28Z"/>' +
        '<circle cx="24" cy="42.6" r="3"/>' +
        '<path d="M15.6 31.4h16.8"/>',
    // Four engines on a straight wing and a deep, blunt body: the Lancaster, the
    // B-17, the C-17, the C-130. Not every warplane is a fighter, and the one this
    // site exists for is this shape.
    heavy: '<path d="M24 5c2.8 0 4.2 2.6 4.2 6v27c0 3.4-1.4 5.8-4.2 5.8S19.8 41.4 19.8 38V11c0-3.4 1.4-6 4.2-6Z"/>' +
        '<path d="M19.9 20 3.6 31.6v3.4L19.9 27Z"/>' +
        '<path d="M28.1 20l16.3 11.6v3.4L28.1 27Z"/>' +
        '<circle cx="9.6" cy="29.4" r="2.1"/>' +
        '<circle cx="16" cy="26.6" r="2.1"/>' +
        '<circle cx="32" cy="26.6" r="2.1"/>' +
        '<circle cx="38.4" cy="29.4" r="2.1"/>' +
        '<path d="M9.6 25v8.8M16 22.2v8.8M32 22.2v8.8M38.4 25v8.8"/>' +
        '<path d="M17.4 41h13.2v2.2H17.4Z"/>',
    // Pointed nose, sharply swept wings, one big fin: a single-seat fighter, whatever
    // decade it was built in.
    fighter: '<path d="M24 4.5c1.8 0 2.6 2 2.6 4.4V38c0 3-0.8 5-2.6 5s-2.6-2-2.6-5V8.9c0-2.4 0.8-4.4 2.6-4.4Z"/>' +
        '<path d="M21.8 15.6 5.4 30.6v3.6l16.4-9.4Z"/>' +
        '<path d="M26.2 15.6l16.4 15v3.6l-16.4-9.4Z"/>' +
        '<path d="M18.4 39.4h11.2l1.6 3.4H16.8Z"/>' +
        '<path d="M23.2 34h1.6v11h-1.6Z"/>',
    // Deliberately plain: for a code this site cannot name, a shape that claims
    // nothing about the aeroplane beyond "it is one".
    generic: '<path d="M16 17h16v14H16Z"/>' +
        '<path d="M16 21.6H6v3.2h10Z"/>' +
        '<path d="M32 21.6h10v3.2H32Z"/>' +
        '<path d="M21.4 12h5.2v5h-5.2Z"/>',
};
/* -------------------------------------------------- which shape is which ---
 * Class first, because the class is the thing we can defend; then the codes whose
 * shape is unmistakable and would be a lie to draw otherwise. */
/** Codes with four engines (or two on a long straight wing) — the heavy shape. */
const HEAVY = new Set([
    'LANC', 'B17', 'B24', 'B29', 'C17', 'C30J', 'C130', 'A400', 'K35R', 'K135', 'B52', 'DC3', 'DC3T', 'C295', 'C27J', 'CN35',
]);
/** Codes that are single-seat fighters — the fighter shape. */
const FIGHTER = new Set([
    'P51', 'SPIT', 'HURI', 'HAHU', 'F86', 'VAMP', 'ME09', 'ME08', 'CORS', 'P40', 'WFUR', 'WCAT', 'A1', 'LYSA', 'BLEN', 'B25',
    'T6', 'TEX2', 'HAWK',
]);
/** Codes driven by a propeller on a straight wing — the turboprop shape. */
const TURBOPROP = new Set([
    'DH8A', 'DH8B', 'DH8C', 'DH8D', 'DH3T', 'DHC2', 'DHC6', 'AT45', 'AT72', 'AT76', 'SF34', 'B190', 'C208',
    'PC12', 'TBM8', 'TBM9', 'BE20', 'BE30', 'BE58', 'B350', 'BE9L', 'C441', 'PAY2',
]);
/** Codes that are business jets: rear engines and a T-tail. */
const BIZJET = new Set([
    'E55P', 'C68A', 'C680', 'C550', 'C501', 'C25A', 'C25B', 'C25C', 'C560', 'C56X', 'C750',
    'CL30', 'CL35', 'CL60', 'GLEX', 'GL7T', 'LJ45', 'LJ60', 'ASTR', 'F2TH', 'F900', 'FA50',
]);
/**
 * The shape for a type code, given what the table says its class is.
 *
 * The class decides first, so a code nobody has written down still gets a sensible
 * drawing rather than nothing — and the code sets above override it only where the
 * shape is genuinely different from the class's default.
 */
export function shapeFor(code, klass) {
    const key = String(code ?? '').trim().toUpperCase();
    if (HEAVY.has(key))
        return 'heavy';
    if (FIGHTER.has(key))
        return 'fighter';
    if (TURBOPROP.has(key))
        return 'turboprop';
    if (BIZJET.has(key))
        return 'bizjet';
    switch (klass) {
        case 'airliner':
            return 'jet';
        case 'regional':
            return 'turboprop';
        case 'business':
            return 'bizjet';
        case 'light':
            return 'prop';
        case 'helicopter':
            return 'heli';
        case 'military':
            return 'fighter';
        default:
            return 'generic';
    }
}
/**
 * The drawing as markup, ready to put in a row.
 *
 * `aria-hidden` and no `role`, on purpose: the name is printed beside it, so a
 * screen reader that announced the picture as well would say everything twice.
 */
export function thumbSvg(code, klass) {
    const shape = shapeFor(code, klass);
    return (`<svg viewBox="0 0 48 48" class="thumb-${shape}" width="40" height="40" aria-hidden="true" focusable="false">` +
        `<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">` +
        SHAPES[shape] +
        '</g></svg>');
}
