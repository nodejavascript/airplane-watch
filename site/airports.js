/**
 * airports.ts — the airports the reader can point the fence at.
 *
 * 🔴 THE COORDINATES ARE NOT IN THIS FILE, AND THAT IS THE POINT. A hard-coded
 * latitude is a fact that goes wrong silently: the fence still draws, the feed
 * still answers, and the page quietly watches the wrong piece of sky. So the
 * only thing kept here is the identifier, and the position is fetched from the
 * feed's own airport endpoint (`/api/0/airport/{icao}`) the first time it is
 * needed. Measured 20 Sep 2026 — the endpoint answers for all seven of these,
 * with the airport's own name and elevation beside the position.
 */
export const AIRPORTS = [
    { icao: 'CYHM', label: 'Hamilton' },
    { icao: 'CYKF', label: 'Kitchener–Waterloo' },
    { icao: 'CYYZ', label: 'Toronto Pearson' },
    { icao: 'CYTZ', label: 'Billy Bishop' },
    { icao: 'KBUF', label: 'Buffalo' },
    { icao: 'CYUL', label: 'Montréal' },
    { icao: 'CYVR', label: 'Vancouver' },
];
export const DEFAULT_AIRPORT = 'CYHM';
/**
 * Shape the feed's airport payload into something the page can trust, and refuse
 * anything that is not a real position.
 *
 * A missing or out-of-range latitude is a refusal, not a default: defaulting to
 * 0,0 would put the fence in the Atlantic and report, cheerfully, that nothing
 * ever takes off anywhere.
 */
export function parseAirport(icao, payload) {
    const raw = (payload ?? {});
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        throw new Error(`The feed has no usable position for ${icao}.`);
    }
    const elevation = Number(raw.alt_feet);
    return {
        icao: String(raw.icao || icao).toUpperCase(),
        label: '',
        name: String(raw.name || icao),
        location: String(raw.location || ''),
        iata: String(raw.iata || ''),
        lat,
        lon,
        elevationFt: Number.isFinite(elevation) ? elevation : null,
    };
}
