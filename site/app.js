/**
 * app.ts — the page.
 *
 * The interesting logic is not here; it is in detect.ts, which is pure and
 * tested. This file does four things and no more:
 *
 *   1. asks the feed where the airport is, and keeps asking the feed for the
 *      aircraft near it;
 *   2. hands each poll to the DetectionEngine and renders what comes back;
 *   3. keeps the reader's watchlist and their own departures board in
 *      localStorage, so closing the tab does not lose the session;
 *   4. fires a browser notification when something they asked about leaves.
 *
 * 🔴 WHY THERE IS A PROXY AT ALL — measured 20 Sep 2026, not assumed. `api.adsb.lol`
 * answers a plain GET with **no `Access-Control-Allow-Origin` header at all**, and
 * answers an OPTIONS preflight with **405**. So a page on this origin may not read
 * that response in a browser: the request is sent, the feed answers 200, and the
 * browser throws the answer away. That is the silent kind of failure — nothing in
 * the page's own code is wrong. So every call goes to `/api/...` on THIS origin,
 * which is served in development by `tools/serve.mjs` and in production by a
 * Cloudflare Worker. Both do the same small job.
 */
import { DEFAULT_AIRPORT, parseAirport, } from './airports.js';
import { thumbSvg } from './thumbs.js';
import { DEFAULTS, DetectionEngine, distanceNm, kmToNm, nmToKm, normaliseKey, } from './detect.js';
import { CLASS_ORDER, classLabel, describeType, isCivilClass, knownTypeCount, } from './typeinfo.js';
const WATCH_KEY = 'aircraft_watchlist';
const TYPES_KEY = 'aircraft_types';
const BOARD_KEY = 'aircraft_departures';
const AIRPORT_KEY = 'aircraft_airport';
/**
 * 🔴 THE READER'S PLACE AND THEIR DISTANCE ARE KEPT TOO. George, 20 Sep 2026:
 * *"and maybe save in cooking, my location, how far, my favorites"* — the
 * favourites were already kept and the other two were not, so a reload made you
 * answer step 2 again and forgot where you were.
 *
 * 🔴 IT IS LOCAL STORAGE AND NOT A COOKIE, ON PURPOSE. A cookie is sent to the
 * server with every single request, so a cookie holding where you are would hand
 * your position to this site ten times a minute. Local storage is never
 * transmitted anywhere. And the privacy section already tells the reader their
 * answer is "remembered in your browser's local storage, not in a cookie" — using
 * a cookie for this would make that sentence false.
 */
const CENTRE_KEY = 'aircraft_centre';
const RADIUS_KEY = 'aircraft_radius';
/**
 * 🔴 THE PAGE ASKS A VOLUNTEER FEED, SO IT ASKS AS LITTLE AS IT CAN.
 *
 * George was shown this on 20 Sep 2026:
 *
 *   "The feed asked us to slow down (HTTP 429). It is volunteer-funded and answers
 *    a limited number of requests per minute, and this page asks again every ten
 *    seconds."
 *
 * That sentence was honest and the behaviour behind it was not. Measured against
 * api.adsb.lol the same day, with a named user agent: **ten requests three seconds
 * apart, ten one second apart, and eight two seconds apart were refused with 429
 * from the third or fourth request on** — so ten seconds was far too fast, and a
 * page that keeps asking is a page that keeps itself refused.
 *
 * So the cadence is ADAPTIVE now, and it starts slower than it used to:
 *
 *   · it begins at 20 seconds, not 10;
 *   · a success buys back speed, but never below 15;
 *   · a 429 doubles it, up to three minutes, and it recovers on its own;
 *   · and it STOPS ENTIRELY while the tab is in the background.
 *
 * That last one matters most: a tab nobody is looking at was spending the whole
 * allowance, and the reader who came back to it found a rate limit.
 */
const POLL_START_MS = 20_000;
const POLL_MIN_MS = 15_000;
const POLL_MAX_MS = 180_000;
/**
 * 🔴 KILOMETRES, NOT NAUTICAL MILES. George, 20 Sep 2026: *"nobody understand
 * nm"*. The feed takes nautical miles and says so in its own endpoint summary
 * (*"Aircrafts surrounding a point (lat, lon) up to 250nm"*), so the conversion
 * happens in `kmToNm` and the reader never meets the unit. Each distance says
 * what it means in plain words as well as in kilometres, because "20 km" is a
 * number and "the airport and the city around it" is an answer.
 */
const DISTANCES = [
    { km: 10, label: 'Just the airport', blurb: 'the runway and the apron' },
    { km: 20, label: 'The airport and the city', blurb: 'climb-out and approach' },
    { km: 50, label: 'The whole region', blurb: 'everything passing over' },
];
const ERAS = [
    { key: 'all', label: 'Any year', from: 0, to: 9999 },
    { key: 'before1970', label: 'first flown before 1970', from: 0, to: 1969 },
    { key: '1970to1999', label: 'first flown 1970–1999', from: 1970, to: 1999 },
    { key: 'since2000', label: 'first flown 2000 or later', from: 2000, to: 9999 },
];
const SEEN_CHOICES = [
    { key: 'day', label: 'seen in the last day', days: 1 },
    { key: 'week', label: 'seen this week', days: 7 },
    { key: 'month', label: 'seen this month', days: 30 },
    { key: 'ever', label: 'seen at any time', days: Number.POSITIVE_INFINITY },
];
/** The window the list opens on. Wide enough to survive a survey a week old. */
const SEEN_DEFAULT = 'month';
/**
 * How far round the compass one point is from another, in degrees from north.
 *
 * This is what makes the live view a picture rather than a list: distance alone
 * says an aircraft is 8 km away, and distance with a bearing says it is 8 km to
 * the south-west, which is the direction an aircraft leaves Hamilton for Toronto.
 */
/**
 * Web Mercator, the arithmetic every slippy map is built on.
 *
 * `lonToTile` and `latToTile` return a position in TILES — fractional, not whole
 * numbers — and multiplying by 256 turns that into pixels at that zoom. Latitude
 * is the one that surprises people: it is not linear, because the projection
 * stretches towards the poles, which is why the same code that puts Hamilton in
 * the right place would put Iqaluit in the wrong one.
 */
function lonToTile(lon, zoom) {
    return ((lon + 180) / 360) * 2 ** zoom;
}
function latToTile(lat, zoom) {
    const rad = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom;
}
function bearingDeg(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180;
    const p1 = lat1 * toRad;
    const p2 = lat2 * toRad;
    const dl = (lon2 - lon1) * toRad;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
/** 16-point compass, because "204°" is a number and "south-south-west" is a place. */
const COMPASS = ['north', 'north-north-east', 'north-east', 'east-north-east', 'east', 'east-south-east', 'south-east', 'south-south-east', 'south', 'south-south-west', 'south-west', 'west-south-west', 'west', 'west-north-west', 'north-west', 'north-north-west'];
function compassPoint(degrees) {
    return COMPASS[Math.round(degrees / 22.5) % 16];
}
/**
 * 🔴 READ EVERY RESPONSE AS TEXT, THEN PARSE IT DELIBERATELY.
 *
 * `await response.json()` trusts the other end to be the feed. The moment
 * anything answers in front of it — a proxy, an edge error page, a maintenance
 * notice — the reader gets a JavaScript parser complaint in place of the
 * sentence that was written for them. This is not hypothetical: it is exactly
 * what happened on rag-demo on 19 Sep 2026, where the server sent a careful
 * explanation as JSON with status 502 and Cloudflare replaced the body with its
 * own HTML page, so the page reported `Unexpected token '<'`.
 *
 * The matching rule on the server side is in worker/index.js: never answer 502
 * from behind Cloudflare, because the edge deletes the body. 503 is passed
 * through.
 */
async function readJson(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    }
    catch {
        const kind = (response.headers.get('content-type') ?? 'no content type').split(';')[0];
        throw new Error(`The feed answered ${response.status} with ${kind} instead of JSON` +
            (/^\s*<(!doctype|html)/i.test(text)
                ? ' — that is a web page, so something in front of the feed answered instead of the feed'
                : '') +
            `. ` +
            text.slice(0, 120).replace(/\s+/g, ' ').trim());
    }
}
/**
 * 🔴 THE STAR, AND THE THREE THINGS IT SAYS. George, 20 Sep 2026: *"instead of
 * favority this, use a start icon"*. One control, and its shape carries the
 * state: outlined means the whole type is NOT favourited, filled means it is, and
 * a narrowed type — one watched by particular tail numbers rather than as a whole
 * — shows outlined with a dot, because it is not the whole type and must not
 * claim to be.
 *
 * The words did not disappear; they moved into the title and the accessible name,
 * so a screen reader still hears "Favourite this type" and a sighted reader
 * gets the glance.
 */
const STAR_PATH = 'M12 2.7l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.6l-5.8 3.05L7.3 14.15 2.6 9.55l6.5-.95z';
/**
 * 🔴 THE STAR GOES BEFORE THE TEXT, EVERYWHERE IT APPEARS IN SOMETHING.
 *
 * George, 20 Sep 2026: *"when a star is placed inside anything it should precede
 * the text"*. A mark that follows its own label reads as punctuation; one that
 * leads it reads as a state the thing is in. So this is one drawing, named for the
 * mark rather than for where it first appeared, and it is always written first.
 */
const MARK_STAR = `<svg class="mark-star" viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>`;
function starButton(code, wholeType, narrowed) {
    const label = wholeType ? 'Favourited — remove' : narrowed ? 'Favourite the whole type' : 'Favourite this type';
    return (`<button type="button" class="star type-toggle${narrowed ? ' star-part' : ''}" ` +
        `data-type="${escapeHtml(code)}" aria-pressed="${wholeType}" ` +
        `title="${label}" aria-label="${label}" data-ga="type-favourite">` +
        `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg></button>`);
}
function byId(id) {
    return document.getElementById(id);
}
function readStore(key, fallback) {
    try {
        return localStorage.getItem(key) ?? fallback;
    }
    catch {
        return fallback;
    }
}
function writeStore(key, value) {
    try {
        localStorage.setItem(key, value);
    }
    catch {
        /* private mode — the session still works, it just does not survive a reload */
    }
}
/** Send an event only if the visitor allowed analytics. */
function track(name, params = {}) {
    if (typeof window.aircraftTrack === 'function')
        window.aircraftTrack(name, params);
}
function formatClock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (character) => {
        switch (character) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
}
class Page {
    /**
     * 🔴 MORE THAN ONE AIRPORT, BECAUSE A READER USUALLY CARES ABOUT MORE THAN ONE.
     * George, 20 Sep 2026: *"i should also be able to select multiple airport. if i
     * select multiple, make sure all are viewable in the maps"*.
     *
     * It is a LIST and not a single slot. Before this, picking a second airport
     * silently dropped the first — so there was no way to watch Hamilton and Toronto
     * at once, which is the ordinary thing to want when you live between them.
     */
    airports = [];
    /**
     * The first airport picked, for the places with room for only one.
     *
     * 🔴 IT IS THE FIRST PICKED, NOT THE ALPHABETICALLY FIRST. The airport somebody
     * chose first is the one they came for, so it keeps the heading, the centre of
     * the radar and the notification rather than being displaced by a code that
     * happens to sort earlier.
     */
    get airport() {
        return this.airports[0] ?? null;
    }
    isChosen(icao) {
        return this.airports.some((one) => one.icao === icao);
    }
    /**
     * An airport the page already holds, from the map's own list or the one beside it.
     * Nothing here costs a request to the feed.
     */
    findListed(icao) {
        const code = icao.toUpperCase();
        const near = this.nearby.find((row) => row.airport.icao === code)?.airport;
        if (near)
            return near;
        return (this.listedAirports?.airports ?? []).find((one) => one.icao === code) ?? null;
    }
    chosenIcaos() {
        return this.airports.map((one) => one.icao);
    }
    /** How to name the airports being watched, where a sentence has room for a few. */
    airportPhrase() {
        const codes = this.chosenIcaos();
        if (codes.length === 0)
            return 'the airport';
        if (codes.length <= 3)
            return codes.join(' / ');
        return `${codes.slice(0, 3).join(' / ')} +${codes.length - 3} more`;
    }
    /** The same, where there is room for almost nothing — the middle of the radar. */
    airportCentreLabel() {
        const codes = this.chosenIcaos();
        if (codes.length === 0)
            return this.centre ? 'you' : '';
        if (codes.length <= 2)
            return codes.join(' / ');
        return `${codes.length} airports`;
    }
    engine = null;
    watchlist = [];
    typeRules = [];
    board = [];
    timer = null;
    /** How long until the next look at the feed. Moves — see the note on POLL_START_MS. */
    pollMs = POLL_START_MS;
    /** True while airports are being restored, when the fence is re-aimed only once. */
    restoring = false;
    /** A pending immediate poll, so three re-aims in one moment are one request. */
    pollSoon = null;
    radiusKm = 20;
    lastPollAt = 0;
    lastError = '';
    polls = 0;
    survey = null;
    /**
     * Type codes the feed itself marks as military, harvested by
     * `tools/survey-military.mjs`. Empty if that file could not be read.
     */
    militaryCodes = new Set();
    /** Photographs and their credits, keyed by type code — see `tools/survey-photos.mjs`. */
    photos = {};
    /** First-flown years, keyed by type code — see `tools/survey-years.mjs`. */
    yearsDoc = null;
    /** Which era the type list is narrowed to. Not presellected into anything narrower. */
    eraFilter = 'all';
    /** How recently a type must have been seen to stay on the list. */
    seenFilter = SEEN_DEFAULT;
    /**
     * Where the reader actually is, once they have said. Everything else — the
     * fence, the airports list, the chart — hangs off this rather than off the
     * airport, because the question is what is in the air around THEM.
     */
    centre = null;
    /** What the reader's place is called, for saying it back to them. */
    placeLabel = '';
    /** A place read back from storage, applied once the airport list has loaded. */
    restored = null;
    /** The airport list the feed itself confirmed, for the "around you" panel. */
    listedAirports = null;
    nearby = [];
    /** The raw readings from the last poll — the live view is drawn from these. */
    lastReadings = [];
    /**
     * Whether the reader has answered step 2 by choosing a distance.
     *
     * 🔴 IT IS NOT PRESELECTED, AND THAT IS THE POINT. A distance applied silently is
     * a step that answers itself, and a step that answers itself cannot be waited on —
     * which is why the first attempt at this revealed steps 2, 3 and 5 together. The
     * reader picks, and the next step arrives because they did.
     */
    radiusChosen = false;
    /** Types the feed showed in THIS session, which may be newer than the survey. */
    liveTypes = new Map();
    typeFilter = 'all';
    start() {
        this.watchlist = this.loadList(WATCH_KEY);
        this.typeRules = this.loadTypeRules();
        this.board = this.loadBoard();
        // 🔴 WHAT WAS KEPT COMES BACK BEFORE ANYTHING IS BUILT FROM IT. The distance
        // buttons read their pressed state from `this.radiusKm`, so restoring after
        // they are built would leave the wrong one lit.
        const keptRadius = Number(readStore(RADIUS_KEY, ''));
        if (Number.isFinite(keptRadius) && keptRadius > 0) {
            this.radiusKm = keptRadius;
            // Step 2 was answered once already, so it is answered now — the sequence
            // resumes where the reader left it instead of collapsing back to step 1.
            this.radiusChosen = true;
        }
        try {
            const kept = JSON.parse(readStore(CENTRE_KEY, 'null'));
            if (kept && typeof kept.lat === 'number' && typeof kept.lon === 'number') {
                this.restored = { lat: kept.lat, lon: kept.lon, label: kept.label ?? '' };
            }
        }
        catch {
            // A corrupt store is not worth failing over; the reader simply starts again.
            this.restored = null;
        }
        this.buildRadiusButtons();
        this.buildTypeFilter();
        this.buildSeenFilter();
        this.renderWatchlist();
        this.renderBoard();
        this.bindWatchForm();
        this.bindNotify();
        this.renderWatchButton();
        this.bindStepToggles();
        this.bindStartOver();
        this.bindLocate();
        this.bindVisibility();
        this.bindMapResize();
        // 🔴 A COMMA-SEPARATED LIST, BECAUSE SEVERAL CAN BE PICKED NOW. A value written
        // before this change is a single identifier, which splits to a list of one — so
        // a session saved by the older page comes back rather than being discarded.
        const saved = readStore(AIRPORT_KEY, DEFAULT_AIRPORT)
            .split(',')
            .map((code) => code.trim().toUpperCase())
            .filter((code) => /^[A-Z0-9]{3,4}$/.test(code));
        void this.loadChosenAirports(saved.length > 0 ? saved : [DEFAULT_AIRPORT]);
        void this.loadSurvey();
        void this.loadYears();
        void this.loadMilitary();
        void this.loadPhotos();
        void this.loadAirports();
        this.updateSteps();
        const notice = byId('notifyNote');
        if (notice && !('Notification' in window)) {
            notice.textContent =
                'This browser has no notification support. Departures will still appear on the board below.';
        }
    }
    /* ---------------------------------------------------------------- storing */
    loadList(key) {
        try {
            const raw = JSON.parse(readStore(key, '[]'));
            return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [];
        }
        catch {
            return [];
        }
    }
    loadBoard() {
        try {
            const raw = JSON.parse(readStore(BOARD_KEY, '[]'));
            if (!Array.isArray(raw))
                return [];
            // A board that grows without limit is a slow page. The session is what
            // matters, and a hundred departures is more than one sitting.
            return raw.slice(0, 100);
        }
        catch {
            return [];
        }
    }
    /**
     * The type rules, tolerantly. A rule with no `tails` array means "every
     * aircraft of this type", and a rule with an empty one means the same thing —
     * so a truncated or hand-edited store degrades to the wider rule rather than to
     * no rule at all, which is the safe direction to fail in.
     */
    loadTypeRules() {
        try {
            const raw = JSON.parse(readStore(TYPES_KEY, '[]'));
            if (!Array.isArray(raw))
                return [];
            return raw
                .filter((rule) => rule && typeof rule.type === 'string' && rule.type.trim() !== '')
                .map((rule) => ({
                type: String(rule.type).trim().toUpperCase(),
                tails: Array.isArray(rule.tails) ? rule.tails.filter((tail) => typeof tail === 'string') : [],
            }));
        }
        catch {
            return [];
        }
    }
    saveTypeRules() {
        writeStore(TYPES_KEY, JSON.stringify(this.typeRules));
        this.engine?.setTypeRules(this.typeRules);
    }
    saveWatchlist() {
        writeStore(WATCH_KEY, JSON.stringify(this.watchlist));
        this.engine?.setWatchlist(this.watchlist);
    }
    saveBoard() {
        writeStore(BOARD_KEY, JSON.stringify(this.board.slice(0, 100)));
    }
    /* ------------------------------------------------------------ the airport */
    buildRadiusButtons() {
        const host = byId('radiusButtons');
        if (!host)
            return;
        host.innerHTML = '';
        for (const choice of DISTANCES) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chip';
            button.dataset.km = String(choice.km);
            // The distance AND what it means. "20 km" is a number; "the airport and the
            // city around it" is an answer.
            button.innerHTML =
                `<b>${choice.km} km</b> <span>${escapeHtml(choice.label)}</span>`;
            button.setAttribute('aria-pressed', String(this.radiusChosen && choice.km === this.radiusKm));
            button.addEventListener('click', () => {
                // 🔴 CHOOSING A DISTANCE IS WHAT ANSWERS STEP 2, and until it is answered
                // step 3 is not on the page. That is the whole sequence: nothing here is
                // applied silently, so the reader can see which step the page is waiting on.
                const first = !this.radiusChosen;
                this.radiusChosen = true;
                this.radiusKm = choice.km;
                // Kept, so a reload does not ask the same question again.
                writeStore(RADIUS_KEY, String(choice.km));
                for (const other of host.querySelectorAll('button')) {
                    other.setAttribute('aria-pressed', String(other === button));
                }
                // Step 2 is answered, so step 3 may arrive — and the fence is (re)aimed
                // with the distance they actually chose.
                this.updateSteps();
                // Re-aimed with the distance they actually chose. Nothing is re-fetched:
                // `point()` already falls back to the airports that are picked, so this is
                // the same point at a new radius rather than a new question.
                this.rearm();
                track('distance_chosen', { km: choice.km, nm: kmToNm(choice.km), first });
            });
            host.appendChild(button);
        }
    }
    buildTypeFilter() {
        const host = byId('typeFilter');
        if (!host)
            return;
        host.innerHTML = '';
        // 🔴 WARPLANES FIRST. George, 20 Sep 2026: *"war plans should be first
        // option"*. It is the one filter somebody arriving at this page is most
        // likely to be looking for — it is the whole reason the class was asked for —
        // so it leads, and "Everything" follows it as the default that is already on.
        // 🔴 EVERYTHING FIRST, WARPLANES LAST. George, 20 Sep 2026: *"everything come
        // before warplane"*. The default belongs at the front, where it is already the
        // pressed one, and the narrowest filter belongs at the end rather than in the
        // reader's way. (The rule earlier the same day was the opposite — that is his
        // to change, and this is what he asked for now.)
        const options = [
            { key: 'all', label: 'Everything' },
            { key: 'military', label: classLabel('military') },
            ...CLASS_ORDER.filter((klass) => klass !== 'other' && klass !== 'military').map((klass) => ({
                key: klass,
                label: classLabel(klass),
            })),
        ];
        for (const option of options) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chip chip-small';
            button.textContent = option.label;
            button.dataset.kind = option.key;
            button.setAttribute('aria-pressed', String(option.key === this.typeFilter));
            button.addEventListener('click', () => {
                this.typeFilter = option.key;
                for (const other of host.querySelectorAll('button')) {
                    other.setAttribute('aria-pressed', String(other === button));
                }
                this.renderTypeList();
            });
            host.appendChild(button);
        }
    }
    /**
     * A spinner ON the button whose airport is being looked up.
     *
     * 🔴 AND IT IS CLEARED ON EVERY WAY OUT, not just the happy one. A spinner that
     * outlives its request is worse than no spinner at all: the reader presses the
     * button a second time, the page looks stuck, and the fault is invisible because
     * everything else on the page still works.
     */
    setBusy(icao, on) {
        for (const chip of document.querySelectorAll(`.chip[data-icao="${icao}"]`)) {
            if (on)
                chip.setAttribute('aria-busy', 'true');
            else
                chip.removeAttribute('aria-busy');
        }
    }
    /**
     * 🔴 A RESPONSE THAT IS NOT GOING TO PARSE IS DECIDED BY ITS STATUS, NEVER BY
     * TRYING TO PARSE IT.
     *
     * George, 20 Sep 2026, twice in one day and for two different faults:
     *
     *   "The feed answered 429 with text/html instead of JSON — that is a web page"
     *   "The feed answered 502 with text/html instead of JSON ... <title>502 Bad
     *    Gateway</title> ... nginx"
     *
     * Both sentences were TRUE and both were useless. The first was the feed's rate
     * limit; the second was **adsb.lol's own nginx**, which answers 502 with an HTML
     * page of its own when its backend is unwell — measured 20 Sep 2026, the same
     * endpoint answering 200 minutes later. Neither is anything to do with the
     * reader's connection or with this site, and a message about JSON parsing tells
     * them neither of those things.
     *
     * So the status decides, before the body is touched, and the reader is told which
     * fault they are looking at and what it means.
     */
    feedTrouble(response) {
        if (response.status === 429) {
            return ('The feed asked us to slow down (HTTP 429). It is volunteer-funded and answers a limited number of ' +
                'requests, and this page had been asking every ten seconds. It has slowed itself down to give the feed ' +
                'room, and it will speed back up on its own — the table below keeps the last reading it managed to get.');
        }
        if (response.status >= 500) {
            return (`The feed's own server is having trouble (HTTP ${response.status}). That is at their end, not yours and ` +
                'not this site\'s: api.adsb.lol is a volunteer service and its gateway sometimes fails for a moment, ' +
                'then recovers. The page keeps asking, and the table below keeps the last reading it got.');
        }
        if (!response.ok) {
            return (`The feed answered HTTP ${response.status}. The page keeps asking every ten seconds, so this may clear ` +
                'on its own.');
        }
        return null;
    }
    /**
     * 🔴 PICKING AN AIRPORT IS A TOGGLE, NOT A SLOT.
     *
     * George, 20 Sep 2026: *"i should also be able to select multiple airport"*.
     * Pressing one that is already picked now unpicks it and the star comes off,
     * which is what a star means everywhere else on this page.
     *
     * 🔴 AND A FAILED LOOKUP NO LONGER UNPICKS ANYTHING. The old code set the airport
     * to null on every error path, so a moment of rate limiting at the feed threw away
     * a choice the reader had already made. An error now means only that the airport
     * was not ADDED — what was picked before is untouched.
     */
    async toggleAirport(icao) {
        if (this.isChosen(icao)) {
            this.airports = this.airports.filter((one) => one.icao !== icao);
            this.afterAirportChange();
            track('airport_unpicked', { airport: icao, count: this.airports.length });
            return;
        }
        // 🔴 AN AIRPORT WE ALREADY HOLD IS NEVER ASKED FOR AGAIN. The page carries 76
        // airports and their positions from the feed's own airport file, so a saved or
        // pressed airport can be resolved from memory — and it used to ask the feed once
        // per airport on every visit, which is most of the burst that got the page
        // rate-limited on 20 Sep 2026.
        const listed = this.findListed(icao);
        let resolved;
        if (listed) {
            resolved = {
                icao: listed.icao,
                label: listed.location || listed.name,
                name: listed.name,
                location: listed.location,
                iata: listed.iata ?? '',
                lat: listed.lat,
                lon: listed.lon,
                elevationFt: listed.elevationFt,
            };
        }
        else {
            this.setBusy(icao, true);
            this.setStatus(`Looking up ${icao}…`, 'working');
            try {
                const response = await fetch(`/api/0/airport/${encodeURIComponent(icao)}`, {
                    headers: { accept: 'application/json' },
                });
                // Same order as the poll, through the same helper: an error status arrives
                // as an HTML page, so it is caught by its status and never by trying to
                // parse it.
                const trouble = this.feedTrouble(response);
                if (trouble) {
                    this.setBusy(icao, false);
                    this.setStatus(trouble, 'error');
                    return;
                }
                const payload = await readJson(response);
                if (!response.ok)
                    throw new Error(`The feed answered ${response.status} for ${icao}.`);
                resolved = parseAirport(icao, payload);
            }
            catch (error) {
                this.lastError = error instanceof Error ? error.message : String(error);
                this.setBusy(icao, false);
                this.setStatus(this.lastError, 'error');
                return;
            }
            this.setBusy(icao, false);
        }
        this.airports = [...this.airports, resolved];
        this.afterAirportChange();
        track('airport_picked', {
            airport: resolved.icao,
            count: this.airports.length,
            km: this.radiusKm,
            nm: kmToNm(this.radiusKm),
        });
    }
    /**
     * Bring back the airports a previous visit picked.
     *
     * It goes through the same toggle as a press does, so a restored session and a
     * fresh one cannot end up in different states — and an identifier the feed cannot
     * place is dropped rather than listed as if it were real.
     */
    async loadChosenAirports(list) {
        // 🔴 ONE RE-AIM FOR THE WHOLE RESTORE, NOT ONE PER AIRPORT. Every change to the
        // set re-aims the fence, and re-aiming polls immediately — so restoring eight
        // airports asked the feed eight times in a couple of seconds on every visit,
        // before the page had drawn anything. That burst is exactly the shape a rate
        // limiter is built to refuse, and it happened on every single load.
        this.restoring = true;
        // Capped, because this is one feed request each and the feed rate-limits. A
        // stored list never grows past this, so the cap is a guard rather than a limit
        // anybody will meet.
        for (const icao of list.slice(0, 8)) {
            if (!this.isChosen(icao))
                await this.toggleAirport(icao);
        }
        this.restoring = false;
        this.afterAirportChange();
        this.updateSteps();
    }
    /**
     * Everything that has to happen once the set of picked airports changes.
     *
     * It is in one place on purpose: the star, the sentence, the map and the fence are
     * four views of the same fact, and a change that updated three of them would leave
     * the page disagreeing with itself.
     */
    afterAirportChange() {
        writeStore(AIRPORT_KEY, this.chosenIcaos().join(','));
        this.renderAirportPanel();
        // Redraws the chips AND the map — `renderNearby` draws the map too — so the
        // stars and the map agree with the list in the same frame.
        this.renderNearby();
        // A restore re-aims once, at the end — see loadChosenAirports().
        if (this.restoring)
            return;
        this.rearm();
        this.updateSteps();
    }
    /**
     * 🔴 WHICH AIRPORTS ARE PICKED, SAID IN WORDS, BESIDE THE MAP.
     *
     * The stars show it and this states it. Both are needed: a star is a mark you have
     * to already understand, and somebody who has just pressed three chips wants to see
     * the three named once rather than counted.
     */
    renderAirportPanel() {
        const where = byId('airportWhere');
        if (!where)
            return;
        const count = this.airports.length;
        if (count === 0) {
            where.textContent =
                'No airport picked yet. Press one of the airports above — you can pick as many as you like.';
        }
        else if (count === 1) {
            const one = this.airports[0];
            where.textContent =
                `${one.name} (${one.icao}) · ${one.location || '—'} · ${one.lat.toFixed(4)}, ${one.lon.toFixed(4)}` +
                    (one.elevationFt !== null ? ` · field elevation ${one.elevationFt} ft` : '');
        }
        else {
            where.textContent =
                `${count} airports watched: ` +
                    this.airports.map((one) => `${one.icao} — ${one.location || one.name}`).join(' · ');
        }
        this.renderFenceNote();
    }
    /**
     * What the fence is drawn round — which changed the moment several airports could
     * be picked at once, so the sentence has to be able to say "the middle of them".
     */
    renderFenceNote() {
        const fence = byId('fenceNote');
        if (!fence)
            return;
        const km = nmToKm(kmToNm(this.radiusKm));
        const from = this.centre
            ? 'your own position'
            : this.airports.length > 1
                ? 'the middle of the airports you picked'
                : 'the airport';
        fence.textContent =
            `Looking ${this.radiusKm} km out from ${from} — ` +
                `${kmToNm(this.radiusKm)} nautical miles, which is the unit the feed takes. ` +
                (this.radiusKm <= 10
                    ? 'A short distance is the best chance of catching an aircraft on the ground, and the least notice of anything else.'
                    : this.radiusKm >= 50
                        ? 'A long distance sees a great deal of traffic, and very little of it on the ground — the two pull in opposite directions.'
                        : `Climb-out and approach both fall inside it, and about ${km} km is what most aircraft cover in the first minute after leaving.`);
    }
    stop() {
        if (this.timer !== null) {
            window.clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** Restart the clock on the CURRENT cadence, which moves as the feed answers. */
    startTimer() {
        this.stop();
        this.timer = window.setInterval(() => void this.poll(), this.pollMs);
    }
    /**
     * 🔴 ONE IMMEDIATE LOOK, EVEN WHEN THREE THINGS CHANGE IN THE SAME MOMENT.
     *
     * A page load re-aims the fence three times over — the restored airports, the
     * place worked out from the postal code, and the distance the reader presses — and
     * every re-aim called `poll()` straight away. Measured on 20 Sep 2026 by counting
     * the requests the page made: **three feed requests inside one second on every
     * single load**, before the page had drawn anything. That burst is exactly the
     * shape a rate limiter exists to refuse, and it happened on every visit.
     *
     * So an immediate look is now COALESCED: the first re-aim schedules it, the next
     * two replace the pending one, and the feed sees a single request.
     */
    schedulePoll() {
        if (this.pollSoon !== null)
            window.clearTimeout(this.pollSoon);
        this.pollSoon = window.setTimeout(() => {
            this.pollSoon = null;
            void this.poll();
        }, 150);
    }
    /**
     * 🔴 A TAB NOBODY IS LOOKING AT MUST NOT SPEND THE ALLOWANCE. The page asked the
     * feed every ten seconds whether or not anyone could see it, so a tab left open
     * behind another window could hold the whole budget down for the tab that was
     * actually being read. Hidden means stopped; coming back polls once and carries on.
     */
    bindVisibility() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.stop();
                return;
            }
            if (this.engine) {
                void this.poll();
                this.startTimer();
            }
        });
    }
    /**
     * Say the cadence out loud once it has slowed, so a reader who wonders why the
     * numbers are moving slowly is told rather than guessing.
     */
    cadenceNote() {
        return this.pollMs > POLL_START_MS
            ? ` · the feed asked us to slow down, so the next look is in ${Math.round(this.pollMs / 1000)}s`
            : '';
    }
    /* -------------------------------------------------------------- the polls */
    async poll() {
        const at = this.point();
        if (!at || !this.engine)
            return;
        // 🔴 NOTHING IS ASKED OF THE FEED UNTIL STEP 2 IS ANSWERED. The page is waiting
        // on a choice, and saying so beats showing a count of aircraft in a fence the
        // reader has not picked.
        if (!this.radiusChosen) {
            this.setStatus('Choose how far out to look in step 2, and this fills in.', 'working');
            return;
        }
        const url = `/api/v2/point/${at.lat}/${at.lon}/${kmToNm(this.radiusKm)}`;
        try {
            const response = await fetch(url, { headers: { accept: 'application/json' } });
            // 🔴 THE STATUS IS CHECKED *BEFORE* THE BODY IS READ, AND THAT ORDER IS THE
            // WHOLE FIX — for every error status, not just the rate limit. See the note
            // on feedTrouble(): the 429 came back as an HTML page and so did the 502, and
            // both were reported as a JSON parsing complaint, which names the symptom and
            // hides the cause.
            const trouble = this.feedTrouble(response);
            if (trouble) {
                this.lastError = `the feed answered ${response.status}`;
                // 🔴 BEING REFUSED IS A REASON TO ASK LESS OFTEN, NOT TO KEEP ASKING. Ten
                // seconds was too fast even before a limit was hit; doubling on the refusal
                // and creeping back on every success is what lets the page recover by
                // itself instead of sitting in a rate limit until somebody reloads.
                if (response.status === 429) {
                    this.pollMs = Math.min(POLL_MAX_MS, Math.max(POLL_START_MS, this.pollMs * 2));
                    this.startTimer();
                }
                this.setStatus(trouble, 'error');
                return;
            }
            const payload = (await readJson(response));
            if (!response.ok)
                throw new Error(`The feed answered ${response.status}.`);
            this.engine.setWatchlist(this.watchlist);
            this.engine.setTypeRules(this.typeRules);
            const readings = Array.isArray(payload.ac) ? payload.ac : [];
            // Held for the live view, which draws what is in the air NOW rather than
            // what has already left. Both come off the same reading of the feed, so
            // the picture and the table can never disagree about the same aircraft.
            this.lastReadings = readings;
            // Count what this session is actually seeing, so the type list is never
            // empty even if the measured file cannot be read — and so a type the
            // survey never caught still becomes watchable rather than invisible.
            const before = this.liveTypes.size;
            for (const reading of readings) {
                const type = String(reading.t || '').trim().toUpperCase();
                if (!type || type === '-' || type.length > 6)
                    continue;
                this.liveTypes.set(type, (this.liveTypes.get(type) ?? 0) + 1);
            }
            if (this.liveTypes.size !== before)
                this.renderTypeList();
            const departures = this.engine.ingest(readings, Date.now());
            // 🔴 A SUCCESS BUYS BACK SPEED, SLOWLY AND WITH A FLOOR. Creeping straight
            // back to the fastest cadence would put the page into a sawtooth against the
            // limit — refused, back off, allowed, refused — and the floor is what stops it.
            if (this.pollMs > POLL_MIN_MS) {
                this.pollMs = Math.max(POLL_MIN_MS, this.pollMs - 5_000);
                this.startTimer();
            }
            // 🔴 A READING THE PROXY HAD TO CACHE IS STILL A READING, AND IT IS DATED.
            // The proxy serves the last good answer when the feed refuses, and says how
            // old it is, so the page can be honest rather than either showing an error
            // over data it has, or showing that data as though it were live.
            const feedStatus = response.headers.get('x-feed-status');
            const feedAge = Number(response.headers.get('x-feed-age-ms') ?? '0');
            if (feedStatus === '429') {
                this.pollMs = Math.min(POLL_MAX_MS, Math.max(POLL_START_MS, this.pollMs * 2));
                this.startTimer();
            }
            this.polls += 1;
            this.lastPollAt = Date.now();
            this.lastError = '';
            if (departures.length > 0)
                this.recordDepartures(departures);
            this.renderAircraft();
            this.renderLive();
            // Plain words. George, 20 Sep 2026: *"i dont like ... 2 aircraft in the fence
            // · poll 3 · last 01:15:00 PM"* — "poll" is how it works, not what the reader
            // asked, and the count is what they came for.
            const age = feedStatus === '429' && feedAge > 0 ? Math.round(feedAge / 1000) : 0;
            this.setStatus(`${readings.length} aircraft around you · updated ${formatClock(this.lastPollAt)}` +
                (age > 0 ? ` · the feed is refusing requests, so this is the reading from ${age}s ago` : '') +
                this.cadenceNote(), 'ok');
        }
        catch (error) {
            // The page keeps the last good picture and says what went wrong, rather
            // than emptying the table and looking like nothing is there.
            this.lastError = error instanceof Error ? error.message : String(error);
            this.setStatus(`Feed problem: ${this.lastError}`, 'error');
        }
    }
    recordDepartures(departures) {
        for (const departure of departures) {
            this.board.unshift(departure);
            if (departure.watched)
                this.notify(departure);
            track('departure_detected', {
                verdict: departure.verdict,
                watched: departure.watched,
                airport: this.airport?.icao ?? '',
                aircraft_type: departure.type,
            });
        }
        this.board = this.board.slice(0, 100);
        this.saveBoard();
        this.renderBoard();
    }
    /* --------------------------------------------------------------- the view */
    setStatus(text, kind) {
        const node = byId('status');
        if (!node)
            return;
        node.textContent = text;
        node.dataset.kind = kind;
    }
    renderAircraft() {
        const body = byId('aircraftBody');
        if (!body || !this.engine)
            return;
        const rows = this.engine.snapshot().slice(0, 40);
        if (rows.length === 0) {
            body.innerHTML =
                '<tr><td colspan="6" class="muted">Nothing in the fence at this moment. Aircraft appear and disappear as they pass.</td></tr>';
            return;
        }
        body.innerHTML = rows
            .map((state) => {
            const label = state.callsign || state.registration || state.hex;
            const phase = state.phase === 'ground'
                ? '<span class="tag tag-ground">on the ground</span>'
                : state.phase === 'airborne'
                    ? '<span class="tag tag-air">airborne</span>'
                    : '<span class="tag tag-unknown">no altitude</span>';
            return (`<tr${state.watched ? ' class="watched-row"' : ''}>` +
                `<td class="mono">${escapeHtml(state.hex)}</td>` +
                `<td><b>${escapeHtml(label)}</b></td>` +
                (state.type ? this.typeCell(state.type) : '<td class="mono">—</td>') +
                `<td>${phase}</td>` +
                `<td class="mono">${formatClock(state.observedAt)}</td>` +
                `<td><button type="button" class="linkish watch-toggle" data-key="${escapeHtml(label)}" ` +
                `data-type="${escapeHtml(state.type || '')}" ` +
                `data-ga="watch">${state.watched ? 'unwatch' : 'watch'}</button></td>` +
                '</tr>');
        })
            .join('');
        for (const button of body.querySelectorAll('.watch-toggle')) {
            button.addEventListener('click', () => {
                const key = button.dataset.key ?? '';
                if (this.watchlist.some((item) => normaliseKey(item) === normaliseKey(key))) {
                    this.removeWatch(key);
                }
                else {
                    this.addWatch(key);
                }
            });
        }
    }
    renderBoard() {
        const list = byId('departures');
        const empty = byId('departuresEmpty');
        if (!list || !empty)
            return;
        empty.hidden = this.board.length > 0;
        list.innerHTML = this.board
            .map((departure) => {
            const label = departure.callsign || departure.registration || departure.hex;
            const climb = departure.climbFpm !== null ? `${departure.climbFpm} ft/min` : 'rate unknown';
            const altitude = departure.altitudeFt !== null ? `${departure.altitudeFt} ft` : 'altitude unknown';
            const kind = describeType(departure.type);
            const typeText = departure.type
                ? `<span class="mono">${escapeHtml(departure.type)}</span> <span class="muted">${escapeHtml(kind.name)}</span>`
                : '';
            return (`<li class="departure${departure.watched ? ' departure-watched' : ''}">` +
                `<span class="departure-time mono">${formatClock(departure.at)}</span>` +
                `<span class="departure-what"><b>${escapeHtml(label)}</b>` +
                (typeText ? ` <span class="departure-type">${typeText}</span>` : '') +
                (departure.watched ? ' <span class="tag tag-watched">watched</span>' : '') +
                '</span>' +
                `<span class="departure-how">${escapeHtml(altitude)} · ${escapeHtml(climb)} · ` +
                `${nmToKm(departure.distanceNm)} km out</span>` +
                `<span class="departure-verdict tag tag-${departure.verdict}">` +
                `${departure.verdict === 'confirmed' ? 'seen on the ground first' : 'first seen climbing'}</span>` +
                (departure.matchedLabel
                    ? `<span class="departure-why muted">caught by: ${escapeHtml(departure.matchedLabel)} · ` +
                        `${escapeHtml(departure.reason)}</span>`
                    : `<span class="departure-why muted">${escapeHtml(departure.reason)}</span>`) +
                '</li>');
        })
            .join('');
    }
    /* -------------------------------------------------- the measured types --- */
    /**
     * Read `types.json`, which `tools/survey-types.mjs` measured and wrote.
     *
     * 🔴 THE LIST IS DATA, NOT CODE, AND THAT IS THE WHOLE POINT. The page does not
     * carry a hard-coded idea of what flies out of Hamilton; it reads what the feed
     * actually showed, with the date and the method beside it, so the list can be
     * refreshed by re-running one script rather than by editing the site. If the
     * file is missing the page says so and falls back to what it sees live — it does
     * not invent a list.
     */
    async loadSurvey() {
        const note = byId('typeNote');
        try {
            const response = await fetch('/types.json', { headers: { accept: 'application/json' } });
            this.survey = (await readJson(response));
        }
        catch (error) {
            this.survey = null;
            if (note) {
                note.textContent =
                    'The measured type list could not be read, so this shows only the types seen in this session. ' +
                        (error instanceof Error ? error.message : '');
            }
            this.renderFilterNote();
            this.renderTypeList();
            return;
        }
        if (note && this.survey) {
            const refused = this.survey.roundsRefusedByRateLimit ?? 0;
            note.textContent =
                `Measured ${this.survey.generated.slice(0, 10)} from ${this.survey.aircraftInspected} aircraft readings — ` +
                    `${this.survey.method}. Counted as ${this.survey.counted ?? 'sightings'}, so a busy airliner seen in every ` +
                    `round scores more than one. This site can name ${knownTypeCount()} type codes; anything else is shown as ` +
                    `its raw code rather than guessed at.` +
                    (refused > 0 ? ` ${refused} round(s) were refused by the feed's own rate limit.` : '');
        }
        this.renderFilterNote();
        this.renderTypeList();
    }
    /**
     * Read `years.json`, which `tools/survey-years.mjs` measured and wrote.
     *
     * 🔴 SAME SHAPE AS EVERY OTHER LIST ON THIS PAGE: a measured file, with its date,
     * its method and its source, so the year can be refreshed by re-running one
     * script rather than by editing the site. If it cannot be read the page shows NO
     * years and says so — it does not fall back to a number somebody typed once.
     */
    async loadYears() {
        try {
            const response = await fetch('/years.json', { headers: { accept: 'application/json' } });
            this.yearsDoc = (await readJson(response));
        }
        catch {
            this.yearsDoc = null;
        }
        this.buildYearFilter();
        this.renderFilterNote();
        this.renderTypeList();
    }
    yearOf(code) {
        return this.yearsDoc?.years?.[String(code).toUpperCase()] ?? null;
    }
    /**
     * 🔴 WHEN WAS THIS TYPE LAST SEEN HERE — and a type on the screen RIGHT NOW counts
     * as now. The survey records the last time each type was seen, merged across every
     * run it has made, but this session's own sightings are newer than any file, so
     * they win. Nothing here guesses: a type with no record and nothing in the air has
     * NO date, and the page says so rather than inventing one.
     */
    lastSeenOf(code) {
        const upper = code.toUpperCase();
        if (this.liveTypes.has(upper))
            return new Date();
        const row = this.survey?.types.find((one) => one.code === upper);
        if (!row?.lastSeen)
            return null;
        const at = new Date(row.lastSeen);
        return Number.isNaN(at.getTime()) ? null : at;
    }
    /** "seen just now" / "seen 3 hours ago" / "seen 12 days ago", in plain words. */
    sinceText(at) {
        if (at === null)
            return 'not seen here yet';
        const minutes = (Date.now() - at.getTime()) / 60_000;
        if (minutes < 2)
            return 'seen just now';
        if (minutes < 60)
            return `seen ${Math.round(minutes)} minutes ago`;
        const hours = minutes / 60;
        if (hours < 24)
            return `seen ${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'} ago`;
        const days = Math.round(hours / 24);
        if (days <= 45)
            return `seen ${days} day${days === 1 ? '' : 's'} ago`;
        return `seen ${Math.round(days / 30)} months ago`;
    }
    /**
     * 🔴 THE FILTER THAT MAKES THE LIST WORTH READING. See the note on SEEN_CHOICES:
     * a type that never flies near you is not a choice worth offering, and a filter
     * nobody presses does not stop anybody picking one.
     */
    buildSeenFilter() {
        const host = byId('seenFilter');
        if (!host)
            return;
        host.innerHTML = '';
        for (const choice of SEEN_CHOICES) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chip chip-small';
            button.textContent = choice.label;
            button.dataset.seen = choice.key;
            button.setAttribute('aria-pressed', String(choice.key === this.seenFilter));
            button.addEventListener('click', () => {
                this.seenFilter = choice.key;
                for (const other of host.querySelectorAll('button')) {
                    other.setAttribute('aria-pressed', String(other === button));
                }
                this.renderTypeList();
                track('seen_chosen', { seen: choice.key });
            });
            host.appendChild(button);
        }
    }
    /**
     * 🔴 ONE SENTENCE FOR BOTH FILTERS, because they answer one question: what have you
     * hidden, and why. Two notes stacked under three rows of chips is a wall of small
     * grey text, which is the thing George has asked me to stop doing twice.
     */
    renderFilterNote() {
        const note = byId('filterNote');
        if (!note)
            return;
        const parts = [];
        if (this.yearsDoc === null) {
            parts.push('The first-flown years could not be read, so no year is shown and the year filter does nothing.');
        }
        else {
            parts.push(`First-flown years for ${this.yearsDoc.resolved} of the ${this.yearsDoc.asked} type codes this site can ` +
                `name, from ${this.yearsDoc.source}. ${this.yearsDoc.scope}`);
        }
        const rows = this.survey?.types ?? [];
        if (rows.length > 0) {
            const runs = Math.max(1, ...rows.map((row) => row.runsSeen ?? 1));
            parts.push(`Last seen: ${runs} survey run${runs === 1 ? '' : 's'} recorded so far. A type that has not been seen ` +
                'inside the window you choose is hidden rather than offered — an aircraft that does not fly near you is ' +
                'not a choice worth making.');
        }
        note.textContent = parts.join(' ');
    }
    /** The sentence behind a year, for the tooltip — the row itself carries only the number. */
    yearTitle(entry) {
        return (`${entry.year}: the year the ${entry.name} was first ${entry.basis === 'first flight' ? 'flown' : 'in service'}. ` +
            (entry.exact ? '' : `Matched on the ${entry.name}, so this may be the family's year rather than this variant's. `) +
            'From Wikidata (CC0). ' +
            "It is the TYPE's year, not the year the individual airframe was built — nothing free publishes a build year " +
            'for a single airframe.');
    }
    buildYearFilter() {
        const host = byId('yearFilter');
        if (!host)
            return;
        host.innerHTML = '';
        for (const era of ERAS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chip chip-small';
            button.textContent = era.label;
            button.dataset.era = era.key;
            button.setAttribute('aria-pressed', String(era.key === this.eraFilter));
            button.addEventListener('click', () => {
                this.eraFilter = era.key;
                for (const other of host.querySelectorAll('button')) {
                    other.setAttribute('aria-pressed', String(other === button));
                }
                this.renderTypeList();
                track('era_chosen', { era: era.key });
            });
            host.appendChild(button);
        }
    }
    /**
     * 🔴 WHICH TYPE CODES SURVIVE THE THREE FILTERS, AND WHY SOME DO NOT.
     *
     * The kind, the era and the last sighting all narrow, and they narrow together —
     * "war planes first flown before 1970 that have been seen this week" is a question
     * this answers. A type with NO year is dropped under an era filter and counted,
     * because a filter must not answer "before 1970" with something nobody measured;
     * and a type with no recent sighting is dropped under a last-seen filter, which is
     * the whole point of having one.
     */
    typeRows() {
        const era = ERAS.find((candidate) => candidate.key === this.eraFilter) ?? ERAS[0];
        const seen = SEEN_CHOICES.find((candidate) => candidate.key === this.seenFilter) ?? SEEN_CHOICES[2];
        let undated = 0;
        let stale = 0;
        const rows = this.combinedTypes().filter((row) => {
            if (this.typeFilter !== 'all' && this.klassOf(row.code) !== this.typeFilter)
                return false;
            if (era.key !== 'all') {
                const entry = this.yearOf(row.code);
                if (entry === null) {
                    undated += 1;
                    return false;
                }
                if (entry.year < era.from || entry.year > era.to)
                    return false;
            }
            if (seen.days !== Number.POSITIVE_INFINITY) {
                const at = this.lastSeenOf(row.code);
                if (at === null || Date.now() - at.getTime() > seen.days * 86_400_000) {
                    stale += 1;
                    return false;
                }
            }
            return true;
        });
        return { rows, undated, stale };
    }
    /**
     * One type's code and its year, as a table cell can carry them.
     *
     * 🔴 THE NUMBER ALONE WOULD BE MISTAKEN FOR A COUNT. Every other number in this
     * table is how MANY — readings, aircraft, kilometres — so the year goes in its own
     * mark, and the sentence behind it (including what it is a year OF) is on the
     * tooltip rather than in the cell.
     */
    typeCell(code) {
        const entry = this.yearOf(code);
        return (`<td class="mono" title="${escapeHtml(entry ? this.yearTitle(entry) : describeType(code).name)}">` +
            escapeHtml(code) +
            (entry ? ` <span class="year-tag">${entry.year}</span>` : '') +
            '</td>');
    }
    /** The survey's types, with anything newer that this session saw merged in. */
    combinedTypes() {
        const rows = new Map();
        for (const row of this.survey?.types ?? []) {
            rows.set(row.code, {
                code: row.code,
                seen: row.seen,
                airports: [...(row.airports ?? [])],
                operators: [...(row.operators ?? [])],
                registrations: [...(row.registrations ?? [])],
                lastSeen: row.lastSeen ?? null,
            });
        }
        for (const [code, seen] of this.liveTypes) {
            const existing = rows.get(code);
            // A type this session saw but the survey never did has no measured tail
            // numbers, and is given none rather than an invented list.
            if (existing)
                existing.seen += seen;
            else
                rows.set(code, { code, seen, airports: [], operators: [], registrations: [], lastSeen: null });
        }
        // 🔴 ALPHABETICAL BY NAME, NOT BY HOW OFTEN IT WAS SEEN. George, 20 Sep 2026:
        // *"maybe list the airplane types in alpha order"*. The sighting count is
        // still shown on every row, so nothing is hidden by the change — the list
        // just stops reshuffling itself as the page watches, which made it
        // impossible to go back to a type you had seen a moment ago.
        return [...rows.values()].sort((a, b) => describeType(a.code).name.localeCompare(describeType(b.code).name) || a.code.localeCompare(b.code));
    }
    /**
     * The point the feed is asked about, and the centre of the fence.
     *
     * 🔴 IT IS THE READER'S OWN PLACE, NOT THE AIRPORT. George, 20 Sep 2026: *"choose
     * how far out to look is how far from my postal or zip code. i want to know
     * whats in the air and around me"*. The airport is only the fallback for a
     * reader who has not said where they are, because a fence drawn round an
     * airport answers a different question from the one this site is for.
     */
    point() {
        if (this.centre)
            return this.centre;
        const picked = this.airports;
        if (picked.length === 1)
            return { lat: picked[0].lat, lon: picked[0].lon };
        if (picked.length > 1) {
            // 🔴 THE MIDDLE OF THE AIRPORTS PICKED, WHEN THERE IS NO PLACE TO STAND.
            // A reader who has picked Hamilton and Toronto but not said where they are
            // has asked about both, so aiming at the first would quietly ignore the
            // second. The average of the latitudes and the longitudes is the centre of
            // the box they span — good to a few kilometres over the distances this page
            // works in, and honest about being a centre rather than pretending to be one
            // of the airports.
            return {
                lat: picked.reduce((sum, one) => sum + one.lat, 0) / picked.length,
                lon: picked.reduce((sum, one) => sum + one.lon, 0) / picked.length,
            };
        }
        return null;
    }
    /** Re-aim the fence and start polling again — used when the reader moves or picks. */
    rearm() {
        // Said here rather than where a distance is pressed, because this is the one
        // place that runs for every reason the fence can change — a new distance, a new
        // place, a new airport — so the sentence cannot fall out of step with the fence.
        this.renderFenceNote();
        // 🔴 AND THE MAP IS REDRAWN HERE TOO, WHICH IT WAS NOT UNTIL 20 SEP 2026. The
        // circle IS the distance, and the distance chips used to live in their own card
        // where nothing on the map appeared to depend on them — so pressing 50 km redrew
        // the sentence and left the circle exactly where it was. Now that the chips and
        // the map share one card that is plainly a bug, and it was found by driving the
        // page and reading the circle's radius back: it sat at 20 km for every setting.
        this.renderMap();
        const at = this.point();
        if (!at) {
            // 🔴 NOTHING TO AIM AT: no place given and no airport picked. Polling on would
            // ask the feed about a point that does not exist. The table keeps its last
            // reading rather than being emptied, because an empty table says "nothing is
            // flying" when the truth is "nothing has been asked for yet".
            this.stop();
            this.setStatus('Pick an airport above, or say where you are, and this fills in.', 'working');
            return;
        }
        this.engine = new DetectionEngine({
            lat: at.lat,
            lon: at.lon,
            radiusNm: kmToNm(this.radiusKm),
            now: Date.now(),
            staleAfterSec: DEFAULTS.staleAfterSec,
            cooldownMs: DEFAULTS.cooldownMs,
        }, this.watchlist);
        this.engine.setTypeRules(this.typeRules);
        this.stop();
        this.schedulePoll();
        this.startTimer();
    }
    /**
     * 🔴 ONE STEP AT A TIME. George, 20 Sep 2026: *"i dont want other steps to be
     * visible is the 1st step is not complete. maybe a nice slow glide down
     * animation like when they finish a step"*.
     *
     * The gate is the PREVIOUS step having an answer in it, not a form being filled
     * in: a type list is meaningless before a place is known, and a watchlist is
     * meaningless before something has been picked. The glide runs once, on
     * arrival — never on a re-render, or the page would twitch every ten seconds as
     * the feed answered.
     */
    updateSteps() {
        const place = this.airport !== null || this.centre !== null;
        const picked = this.typeRules.length > 0 || this.watchlist.length > 0;
        for (const section of document.querySelectorAll('.step-gated')) {
            const step = Number(section.dataset.step ?? '0');
            // 🔴 ONE STEP AT A TIME, AND EACH WAITS FOR THE ONE BEFORE IT TO BE ANSWERED.
            // George, 20 Sep 2026: *"step 2 and 3 and 4, etc should be collapsed if
            // previous steps are not completed. as soon as step 1 is done, gently expand
            // step two"* — and then, when the first attempt revealed 2, 3 and 5 together
            // a third of a second apart, *"you didnt do the collpase / expand like i
            // asked"*. He was right: a stagger is not a sequence.
            //
            // 🔴 THE DISTANCE STEP IS GONE, FOLDED INTO STEP 1. George, 20 Sep 2026: *"the
            // circle in the map should be based on the how far out from you distance, so
            // lets combine those cards nicely"*. They are one question — where you are, and
            // how far out from there — so they are one card, and the circle now sits
            // directly under the chips that decide it.
            //
            //   1  where you are + how far out → ANSWERED by a place AND a distance
            //                                    → unlocks 3
            //   3  the aircraft types          → ANSWERED when something is starred
            //                                    → unlocks 4
            //   5  name one aircraft           → the alternative to 3, so it rides with it
            //   4, 6, 7                        → a watchlist, a board and a chart are all
            //                                    empty until something has been picked
            const answered1 = place && this.radiusChosen;
            const answered2 = answered1 && picked;
            const show = step === 1 ? true : step === 3 || step === 5 ? answered1 : answered2;
            if (show && section.hidden) {
                section.hidden = false;
                section.classList.add('step-arrive');
                window.setTimeout(() => section.classList.remove('step-arrive'), 900);
                // The chart is drawn when it arrives rather than when it was last polled,
                // or it would show whatever was in the air a moment before it appeared.
                if (step === 7)
                    this.renderLive();
            }
            else if (!show && !section.hidden) {
                section.hidden = true;
            }
        }
    }
    /**
     * 🔴 EVERY STEP HEADING COLLAPSES AND EXPANDS, AND THE READER OWNS IT.
     *
     * George, 20 Sep 2026: *"you didnt do the collpase / expand like i asked"*. The
     * automatic sequence above decides what ARRIVES; this decides what STAYS OPEN.
     * A reader who has finished with where they are should be able to fold it away
     * and get on with the part they care about, rather than scrolling past a step
     * they have already answered.
     *
     * Delegated on the document, so every step works including the ones revealed
     * later — a listener bound to the headings at load would only ever know about the
     * steps that existed at load. That is the same mistake that made the cookie gate's
     * footer door dead on the other sites in this family.
     */
    /**
     * 🔴 START OVER, BECAUSE THERE IS NO OTHER WAY TO GET RID OF A STALE PAGE.
     *
     * George, 20 Sep 2026: *"maybe you need a start over that deletes my cookie or
     * something, i steill see all cards open"*. It was not a cookie — the served page
     * carries `hidden` on every step after the first, and the bundle on disk has the
     * sequential gate. What he was looking at was a TAB: opening the same address
     * again only focuses a tab that already has it, so the page he was reading was
     * the one from before the fixes, and no reload of the address would be reached.
     *
     * So this clears everything the page has kept in this browser — the watchlist,
     * the type rules, the departures board, the chosen airport — and reloads. It is
     * the reader's own reset, and it also happens to be the honest answer to "I still
     * see the old thing": a page that keeps state must offer a way to drop it.
     */
    bindStartOver() {
        const button = byId('startOver');
        if (!button)
            return;
        button.addEventListener('click', () => {
            for (const key of [WATCH_KEY, TYPES_KEY, BOARD_KEY, AIRPORT_KEY, CENTRE_KEY, RADIUS_KEY]) {
                try {
                    localStorage.removeItem(key);
                }
                catch {
                    /* private mode refuses to remove as well as to store */
                }
            }
            track('start_over', {});
            window.location.reload();
        });
    }
    bindStepToggles() {
        document.addEventListener('click', (event) => {
            // 🔴 A DESCENDANT SELECTOR, NOT A CHILD ONE. `closest` matches a selector
            // against each ancestor, and the first version of this used `.step-gated > h2`
            // — which reads as a child selector and did not fire in Chrome. Matching on
            // the plain descendant and checking the parent explicitly is the same test
            // written so it cannot be ambiguous.
            const target = event.target;
            const heading = target?.closest('h2');
            if (!(heading instanceof HTMLElement))
                return;
            const section = heading.parentElement;
            if (!(section instanceof HTMLElement) || !section.classList.contains('step-gated'))
                return;
            section.classList.toggle('step-folded');
            const folded = section.classList.contains('step-folded');
            heading.setAttribute('aria-expanded', String(!folded));
            track('step_folded', { step: section.dataset.step ?? '', folded });
        });
    }
    async loadMilitary() {
        try {
            const response = await fetch('/military.json', { headers: { accept: 'application/json' } });
            const doc = (await readJson(response));
            for (const row of doc.codes ?? [])
                this.militaryCodes.add(String(row.code).toUpperCase());
        }
        catch {
            // Not fatal, and deliberately silent in the page: without the file the
            // warplanes filter still works for the historic types in the static table,
            // which is where the Lancaster lives.
            this.militaryCodes.clear();
        }
        this.renderTypeList();
    }
    /**
     * The class of a type code, with the harvested military set applied.
     *
     * 🔴 A CIVIL TYPE IS NEVER RECLASSIFIED BY THE FEED'S GLOBAL MILITARY FLAG, AND
     * THIS IS THE FILTERING FAULT THE READER SPOTTED. The flag comes from a WORLDWIDE
     * query that takes no point and no radius, so every type any air force anywhere
     * flies appears in it — measured 20 Sep 2026 it named 11 of the 62 types this
     * site actually sees, including the Cessna 172, the Dash 8, the Airbus A320 and
     * the Boeing 737. Applied naively that put the 172 and the Dash 8 under
     * **Warplanes** and took the 737 and the A320 out of **Airliner**, so two filters
     * were quietly wrong at once.
     *
     * So the flag may only classify a code this site does not already place — which
     * is how the C-17, the C-130 and the Chinook still land under Warplanes.
     */
    klassOf(code) {
        const known = describeType(code).klass;
        if (isCivilClass(known))
            return known;
        if (this.militaryCodes.has(code.trim().toUpperCase()))
            return 'military';
        return known;
    }
    /**
     * 🔴 A PHOTOGRAPH WHERE ONE WAS FOUND AND THE MATCH WAS TRUSTED — A DRAWING
     * OTHERWISE, AND NEVER A GUESS.
     *
     * George, 20 Sep 2026: *"where are the photos. there are free opensource photos
     * online"*. He was right and the earlier answer here was wrong: Wikimedia Commons
     * is free, its licences are permissive, and the MediaWiki API hands back a page
     * image AND its credit terms with no key at all. Measured before building on it:
     * 56 of the 62 types the survey sees have a usable photograph.
     *
     * 🔴 BUT 11 OF THOSE MATCHES WERE BAD, WHICH IS WHY `confident` EXISTS. Measured
     * on the same run: searching "Boeing 737-300" matched **a list of aircraft type
     * designators**, "AgustaWestland Lynx" matched **an armoured fighting vehicle**,
     * and "Cessna 414" matched **a microphone company**. Those are not near misses,
     * they are the wrong subject entirely, and a page that printed them would be
     * worse than one with no pictures at all. So a weak match gets the drawing — and
     * the drawing cannot be wrong about which aeroplane it is, because it only ever
     * claims a KIND of aeroplane.
     *
     * 🔴 AND THE PHOTOGRAPH IS FETCHED BY OUR OWN SERVER, never by the reader's
     * browser, so the image host never sees them. Same shape as the feed and the map.
     */
    thumbHtml(code, klass) {
        const photo = this.photos[code];
        if (photo && photo.confident) {
            const src = `/api/photo?src=${encodeURIComponent(photo.src)}`;
            return (`<img class="typerow-photo" src="${escapeHtml(src)}" alt="" width="76" height="48" ` +
                `loading="lazy" decoding="async" ` +
                `title="${escapeHtml(`${photo.title} — photograph by ${photo.artist}, ${photo.licence}`)}" />`);
        }
        return thumbSvg(code, klass);
    }
    /**
     * The credit a Commons licence requires, printed on the row.
     *
     * 🔴 NOT A TOOLTIP. Every licence these files carry — CC BY, CC BY-SA, GFDL —
     * requires the attribution to be visible beside the work, and an uncredited
     * photograph is a licence breach rather than a missing nicety. So it goes in the
     * row's own text, next to the sighting count.
     */
    creditOf(code) {
        const photo = this.photos[code];
        if (!photo || !photo.confident)
            return '';
        return ` · photo ${photo.artist} (${photo.licence})`;
    }
    async loadPhotos() {
        try {
            const response = await fetch('/photos.json', { headers: { accept: 'application/json' } });
            const doc = (await readJson(response));
            this.photos = doc.found ?? {};
        }
        catch {
            // Not fatal. Without the file every row falls back to its drawing, which is
            // what a row with no trusted photograph does anyway.
            this.photos = {};
        }
        this.renderTypeList();
    }
    /**
     * 🔴 AN EMPTY LIST HAS TO SAY WHY IT IS EMPTY, OR IT READS AS BROKEN.
     *
     * Measured 20 Sep 2026: the **Heritage & war planes** filter — the one asked for
     * by name, and doubted to be working — shows nothing at all at Hamilton. That is
     * not a fault in the filter. The class holds the historic types that still fly
     * (the Lancaster among them) plus whatever the feed flags as military, and the
     * historic ones fly a handful of times a year, so on any given afternoon they are
     * not in the feed. "No rows" and "no aeroplanes" are different statements, and a
     * blank box makes the second one by accident.
     *
     * 🔴 AND THIS GUARD HAS TO EXIST AT ALL. A patch earlier the same day removed the
     * curated-rows block and the empty check went with it, so a filter matching
     * nothing rendered an empty box. Found by looking at the file, not by reading my
     * own report of the change.
     */
    emptyMessage() {
        if (this.typeFilter === 'military') {
            return ("Nothing in this group has been seen here, and that is its normal state rather than a fault. It holds " +
                "the historic types that still fly — Hamilton's Lancaster among them, one of only two airworthy in the " +
                "world, which flies a handful of times a year — plus whatever the feed itself flags as military. Most " +
                "military aircraft never transmit this kind of data at all. An empty list here says nothing about what " +
                "is overhead; it says these particular aircraft are not.");
        }
        if (this.typeFilter === 'all') {
            return 'Nothing has been seen yet — the page has only just started looking. Give it a minute.';
        }
        return (`No ${classLabel(this.typeFilter)} has been seen at this airport. The list is measured from the feed, so ` +
            'it shows what actually flies here rather than what could. Try another filter, or leave it and watch.');
    }
    renderTypeList() {
        const host = byId('typeList');
        if (!host)
            return;
        const { rows, undated, stale } = this.typeRows();
        if (rows.length === 0) {
            // 🔴 A FILTER THAT HIDES TYPES SAYS HOW MANY IT HID, AND WHY. Otherwise an era
            // filter over a list where a third of the codes have no year looks as though
            // the types have gone, rather than as though the years are missing.
            const hidden = undated > 0
                ? ` ${undated} type${undated === 1 ? '' : 's'} in this view ${undated === 1 ? 'has' : 'have'} no first-flown year, so ${undated === 1 ? 'it is' : 'they are'} left out of a year filter rather than guessed at.`
                : '';
            host.innerHTML = `<p class="muted small">${escapeHtml(this.emptyMessage() + hidden)}</p>`;
            return;
        }
        // The bar is drawn against the busiest row on the list, so "169 sightings"
        // and "1 sighting" are not the same shape to the eye.
        const maxima = Math.max(...rows.map((row) => row.seen), 1);
        // 🔴 NOTHING IS LISTED BY HAND HERE ANY MORE. George, 20 Sep 2026: *"i dont
        // want to list by hand"* — so the hand-written residents layer is gone and every
        // row on this page is now something the feed was seen showing. The Lancaster
        // did not leave with it: `LANC` is a named type in the table, read out of the
        // feed's own aircraft database, so it appears under Warplanes the moment it
        // transmits — which is the honest way for it to arrive.
        const measuredHtml = rows
            .map((row) => {
            const info = describeType(row.code);
            const klass = this.klassOf(row.code);
            const rule = this.typeRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(row.code));
            const already = rule !== undefined;
            // 🔴 THE WHOLE TYPE IS ONLY FAVOURITED WHEN NOTHING IS NARROWED. George,
            // 20 Sep 2026: *"if they highlight a tail, un favourite the whole type"* —
            // so the moment one tail is highlighted the button changes to offer the
            // whole type back, and the row stops claiming to watch all of them.
            const wholeType = already && rule.tails.length === 0;
            const chosen = new Set((rule?.tails ?? []).map((tail) => normaliseKey(tail)));
            const width = Math.max(2, Math.round((row.seen / maxima) * 100));
            const tails = (row.registrations ?? []).slice(0, 24);
            const entry = this.yearOf(row.code);
            // 🔴 CHIPS IN THE CARD, NOTHING BEHIND A BUTTON. George, 20 Sep 2026: *"i
            // dont want the button choose tail numbers, list the tail numbers as chips
            // in the car they can highlight"*.
            const tailChips = tails.length === 0
                ? ''
                : '<div class="tail-chips">' +
                    tails
                        .map((item) => {
                        // 🔴 STARRING THE WHOLE TYPE STARS EVERY TAIL UNDER IT. George, 20
                        // Sep 2026: *"if i favorite a whole airplay type, put stars for all
                        // the tail numbers"*. A rule with no tail numbers means every
                        // aircraft of that type is watched, so every chip in the row IS
                        // watched and must say so — the old version read the star from the
                        // narrowed list alone, which is empty for a whole-type rule, so a
                        // row you had favourited showed a star at the top and not one
                        // anywhere below it.
                        //
                        // 🔴 AND THE CHIP CARRIES NO STAR AT ALL — JUST THE YELLOW. George,
                        // 20 Sep 2026: *"remove start that are in chip, i just want the
                        // yellow hue only"*. Six little stars down a row of tail numbers
                        // was decoration on top of a colour that already said the same
                        // thing; the colour is the mark.
                        const on = wholeType || chosen.has(normaliseKey(item.reg));
                        return (`<button type="button" class="tail-chip" data-type="${escapeHtml(row.code)}" ` +
                            `data-tail="${escapeHtml(item.reg)}" aria-pressed="${on}" ` +
                            `title="${wholeType
                                ? 'The whole type is watched, so this one is too — press to watch only this aeroplane'
                                : on
                                    ? 'Watching only this one'
                                    : 'Watch only this one'}" ` +
                            `data-ga="tail-chip">${escapeHtml(item.reg)}</button>`);
                    })
                        .join('') +
                    '</div>';
            const tailNote = tails.length === 0
                ? ''
                : `<p class="small muted tail-note">${wholeType
                    ? 'The whole type is starred, so every one of these is watched. Press one to watch only that aeroplane instead.'
                    : chosen.size > 0
                        ? 'Only the starred ones are watched — starring a tail number <b>un-favourites the whole type</b>. Press a starred one again, or press the star on the row, to go back to all of them.'
                        : 'Press any of these to watch that aeroplane instead of the whole type. Every tail number here is one that actually transmitted its registration — many transponders never send one, so this is a sample of what identifies itself and not a fleet list.'}</p>`;
            return (`<div class="typerow${already ? ' typerow-on' : ''}">` +
                `<div class="typerow-thumb">${this.thumbHtml(row.code, klass)}</div>` +
                `<div class="typerow-main">` +
                `<b>${escapeHtml(info.name)}</b> <span class="mono muted">${escapeHtml(row.code)}</span> ` +
                `<span class="tag">${escapeHtml(classLabel(klass))}</span>` +
                // The year sits where the eye already looks for what a type IS, and its
                // tooltip carries the whole sentence including the caveat about whose year
                // it is.
                (entry
                    ? ` <span class="year-tag" title="${escapeHtml(this.yearTitle(entry))}">${entry.year}</span>`
                    : '') +
                '</div>' +
                `<div class="typerow-actions">` +
                starButton(row.code, wholeType, already && !wholeType) +
                '</div>' +
                `<div class="typerow-meta">` +
                `<span class="typerow-bar" aria-hidden="true"><i style="width:${width}%"></i></span>` +
                `<span class="small muted">${row.seen} sighting${row.seen === 1 ? '' : 's'}` +
                ` · ${escapeHtml(this.sinceText(this.lastSeenOf(row.code)))}` +
                (row.operators.length > 0 ? ` · ${escapeHtml(row.operators.slice(0, 4).join(' '))}` : '') +
                (row.airports.length > 1 ? ` · ${row.airports.length} airports` : row.airports.length === 1 ? ` · ${escapeHtml(row.airports[0])}` : '') +
                `${escapeHtml(this.creditOf(row.code))}</span></div>` +
                tailChips +
                tailNote +
                '</div>');
        })
            .join('');
        host.innerHTML =
            measuredHtml +
                (undated > 0 || stale > 0
                    ? `<p class="small muted">${[
                        undated > 0
                            ? `${undated} type${undated === 1 ? '' : 's'} here ${undated === 1 ? 'has' : 'have'} no first-flown year, so ${undated === 1 ? 'it is' : 'they are'} left out while a year filter is on.`
                            : '',
                        stale > 0
                            ? `${stale} more ${stale === 1 ? 'type was' : 'types were'} seen here, but not inside the window you chose.`
                            : '',
                    ]
                        .filter(Boolean)
                        .join(' ')}</p>`
                    : '');
        for (const button of host.querySelectorAll('.type-toggle')) {
            button.addEventListener('click', () => {
                const code = button.dataset.type ?? '';
                const rule = this.typeRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(code));
                if (!rule) {
                    // New rules start WIDE — tails empty means every aircraft of the type.
                    this.typeRules.push({ type: code, tails: [] });
                    track('type_favourited', { code, total: this.typeRules.length });
                }
                else if (rule.tails.length > 0) {
                    // Nothing narrowed any more: the whole type is favourited again.
                    rule.tails = [];
                    track('type_widened', { code });
                }
                else {
                    this.typeRules = this.typeRules.filter((candidate) => normaliseKey(candidate.type) !== normaliseKey(code));
                    track('type_unfavourited', { code });
                }
                this.saveTypeRules();
                this.renderWatchlist();
                this.renderTypeList();
            });
        }
        // 🔴 HIGHLIGHTING A TAIL UN-FAVOURITES THE WHOLE TYPE, by construction: the
        // first tick on an un-narrowed rule fills `tails`, and a rule with tails is
        // by definition not the whole type. No separate step, nothing to forget.
        for (const chip of host.querySelectorAll('.tail-chip')) {
            chip.addEventListener('click', () => {
                const code = chip.dataset.type ?? '';
                const tail = chip.dataset.tail ?? '';
                let rule = this.typeRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(code));
                if (!rule) {
                    rule = { type: code, tails: [] };
                    this.typeRules.push(rule);
                }
                const on = rule.tails.some((item) => normaliseKey(item) === normaliseKey(tail));
                if (on)
                    rule.tails = rule.tails.filter((item) => normaliseKey(item) !== normaliseKey(tail));
                else
                    rule.tails.push(tail);
                this.saveTypeRules();
                this.renderWatchlist();
                this.renderTypeList();
                track('tail_highlighted', { code, highlighted: !on, tails: rule.tails.length });
            });
        }
        // The star buttons are rebuilt above, so the waiting gate is re-applied here
        // or a fresh poll would hand back buttons that are enabled too early.
        this.updateSteps();
    }
    /**
     * 🔴 THIS PANEL IS A LIST OF WHAT WAS PICKED, NOT A SECOND PLACE TO PICK IT.
     *
     * George, 20 Sep 2026: *"what you are watching, only list was was selected above,
     * no more features"*. So the box that used to sit in every row — "narrow to a tail
     * number, Add" — is gone, and so is the text telling the reader which controls to
     * use: the stars and the tail chips above are the way in, and this says back what
     * they did. Every row carries the same star, because that is how the choice is
     * drawn everywhere else on the page.
     *
     * 🔴 AND THE TWO WAYS OUT STAY, BECAUSE THEY ARE NOT "FEATURES". Pressing a star
     * or a chip again removes a TYPE, but an aircraft named by hand — in step 5, or
     * with the watch button on the live table — has nothing above to un-press. Without
     * a remove here it could never be undone at all, which is a dead end rather than a
     * tidier page.
     */
    renderWatchlist() {
        const host = byId('watchList');
        if (!host)
            return;
        if (this.typeRules.length === 0 && this.watchlist.length === 0) {
            host.innerHTML = '<li class="muted">Nothing watched yet. Star a type above, and it appears here.</li>';
            return;
        }
        const typeItems = this.typeRules
            .map((rule) => {
            const info = describeType(rule.type);
            const narrowed = rule.tails.length > 0;
            const entry = this.yearOf(rule.type);
            return (`<li class="watch-type">` +
                `<span class="watch-what">${MARK_STAR}<b>${escapeHtml(info.name)}</b> ` +
                `<span class="mono muted">${escapeHtml(rule.type)}</span>` +
                (entry ? ` <span class="year-tag">${entry.year}</span>` : '') +
                ` — <b>${narrowed
                    ? `${rule.tails.length} tail number${rule.tails.length === 1 ? '' : 's'}`
                    : 'every one of them'}</b>` +
                (narrowed ? ` <span class="mono muted">${escapeHtml(rule.tails.join(', '))}</span>` : '') +
                '</span>' +
                `<button type="button" class="linkish type-remove" data-type="${escapeHtml(rule.type)}" ` +
                `data-ga="type-unwatch">stop watching</button>` +
                '</li>');
        })
            .join('');
        const namedItems = this.watchlist
            .map((item) => `<li class="watch-type"><span class="watch-what">${MARK_STAR}` +
            `<span class="mono">${escapeHtml(item)}</span> — <b>this aircraft</b></span>` +
            `<button type="button" class="linkish watch-remove" data-key="${escapeHtml(item)}" ` +
            `data-ga="unwatch">remove</button></li>`)
            .join('');
        host.innerHTML = typeItems + namedItems;
        for (const button of host.querySelectorAll('.type-remove')) {
            button.addEventListener('click', () => {
                const code = button.dataset.type ?? '';
                this.typeRules = this.typeRules.filter((rule) => normaliseKey(rule.type) !== normaliseKey(code));
                this.saveTypeRules();
                this.renderWatchlist();
                this.renderTypeList();
            });
        }
        for (const button of host.querySelectorAll('.watch-remove')) {
            button.addEventListener('click', () => this.removeWatch(button.dataset.key ?? ''));
        }
        this.updateSteps();
    }
    renderWatchButton() {
        const button = byId('notifyBtn');
        const note = byId('notifyNote');
        if (!button || !note)
            return;
        if (!('Notification' in window)) {
            button.hidden = true;
            return;
        }
        if (Notification.permission === 'granted') {
            button.hidden = true;
            note.textContent = 'Notifications are on for this site. You will be told when a watched aircraft leaves.';
            return;
        }
        button.hidden = false;
        button.textContent = Notification.permission === 'denied' ? 'Notifications are blocked' : 'Tell me when they leave';
        note.textContent =
            Notification.permission === 'denied'
                ? 'This browser has blocked notifications for this site. Departures still appear on the board.'
                : 'Notifications are off. The board below works either way.';
    }
    bindNotify() {
        const button = byId('notifyBtn');
        if (!button)
            return;
        button.addEventListener('click', async () => {
            if (!('Notification' in window))
                return;
            try {
                await Notification.requestPermission();
            }
            catch {
                /* older Safari takes a callback instead of a promise */
            }
            this.renderWatchButton();
            track('notifications_asked', { permission: Notification.permission });
        });
    }
    notify(departure) {
        if (!('Notification' in window) || Notification.permission !== 'granted')
            return;
        const label = departure.callsign || departure.registration || departure.hex;
        const climb = departure.climbFpm !== null ? `, ${departure.climbFpm} ft/min` : '';
        try {
            new Notification(`${label} has left ${this.airportPhrase()}`, {
                body: `${departure.verdict === 'confirmed' ? 'It was on the ground and it is not now' : 'It was first seen already climbing'}` +
                    ` — ${departure.altitudeFt ?? '?'} ft${climb}, ${Math.round(nmToKm(departure.distanceNm))} km out.`,
                tag: departure.hex,
            });
        }
        catch {
            /* Some browsers refuse to build a notification from a page that is not
               itself in the foreground. The board is the record either way. */
        }
    }
    /* ------------------------------------------------- airports around you */
    /**
     * The airport list, built by asking the feed about every identifier.
     *
     * 🔴 POSITIONS ARE FETCHED, NEVER TYPED. `tools/verify-airports.mjs` asks
     * `/api/0/airport/{icao}` for each one and throws away any identifier the feed
     * cannot place — which is the only way to be sure the list is a list of real
     * airports rather than a list of strings that look like airports. It dropped
     * one on 20 Sep 2026: `CYTJ` (Terrace Bay) answered with no usable position.
     */
    async loadAirports() {
        const note = byId('nearbyNote');
        try {
            const response = await fetch('/airports.json', { headers: { accept: 'application/json' } });
            this.listedAirports = (await readJson(response));
        }
        catch (error) {
            this.listedAirports = null;
            if (note) {
                note.textContent =
                    'The wider airport list could not be read, so the seven main airports are offered instead. ' +
                        (error instanceof Error ? error.message : '');
            }
            return;
        }
        if (note && this.listedAirports) {
            const dropped = this.listedAirports.dropped ?? [];
            note.textContent =
                `${this.listedAirports.kept} airports, every one of them confirmed by asking the feed where it is. ` +
                    'Press as many as you like: each one you press is watched, and the map is drawn to fit all of them. ' +
                    (dropped.length > 0
                        ? `${dropped.length} identifier was dropped because the feed could not place it: ${dropped.join(', ')}.`
                        : 'Nothing was dropped.');
        }
        // 🔴 THE KEPT PLACE IS APPLIED HERE, NOT IN start(). Ordering the airports by
        // distance needs the airport list, and the list has only just arrived — so
        // doing it in start() would sort against an empty list and show the reader
        // nothing near them.
        if (this.restored) {
            const kept = this.restored;
            this.restored = null;
            this.computeNearby(kept.lat, kept.lon, kept.label);
            return;
        }
        this.renderNearby();
    }
    /**
     * 🔴 WHERE YOU ARE, AND HOW FAR THE PAGE IS LOOKING — DRAWN HERE, NOT EMBEDDED.
     *
     * George, 20 Sep 2026: *"maybe google map can show a circle around their location
     * with a marker on the airport with the airport code, not sure"* — and the
     * drawing is right, the source is not. An embedded Google map needs an API key,
     * a billing account, and a request to Google from **every** visitor's browser
     * before they have answered the cookie question — which is the one thing this
     * site's own gate exists to prevent. It would also add a third party to a page
     * whose promise is that it asks the feed, this server, and nobody else.
     *
     * So it is drawn from the two facts that matter: where the reader is, and how
     * far out the fence reaches. The nearest airports carry their codes, the chosen
     * one is drawn larger, and the rings are the distance they picked in step 2.
     */
    /**
     * 🔴 THE MAP IS A FREE SERVICE, AND THE BROWSER NEVER TALKS TO IT.
     *
     * George, 20 Sep 2026: *"instead of ggoogle maps, use a free service"*. Chosen
     * by measuring, with no key: `tile.openstreetmap.org` answered 200 with 39861
     * bytes of PNG, CARTO answered 200, OpenTopoMap answered 200, and Stadia
     * answered **401 — it wants a key**. OpenStreetMap is the canonical free one, it
     * is ODbL-licensed, and its own tile policy asks to be cached and to be told who
     * is asking.
     *
     * 🔴 SO EVERY TILE IS FETCHED BY THIS SITE'S OWN SERVER, at `/api/tiles/z/x/y`,
     * and the page points at nothing else. Putting an `<img>` straight at the tile
     * server would work and would be wrong: it hands every reader's address to a
     * stranger on page load, on a site whose first section promises it does not do
     * that, before the cookie question has even been answered. Same shape as the
     * flight feed. Attribution is required by the licence and is printed on the map.
     *
     * The fence, the nearest airports and their codes are drawn on top in SVG, in
     * the same pixel space as the tiles, so they cannot drift out of step with the
     * map underneath them.
     *
     * 🔴 AND THE ZOOM IS CHOSEN TO FIT EVERY AIRPORT THAT WAS PICKED. George, 20 Sep
     * 2026: *"if i select multiple, make sure all are viewable in the maps"*. The
     * old zoom was derived from the fence radius around the reader alone, so an
     * airport outside that circle — which is exactly what a second airport usually
     * is — was drawn off the edge of the view and vanished. A map showing two of the
     * three airports you picked is worse than no map, because it looks complete.
     */
    renderMap() {
        const host = byId('locMap');
        if (!host)
            return;
        const at = this.centre;
        const needed = [
            ...(at ? [at] : []),
            ...this.airports.map((one) => ({ lat: one.lat, lon: one.lon })),
        ];
        if (needed.length === 0) {
            host.innerHTML = '';
            return;
        }
        const TILE = 256;
        // 🔴 THE MAP TAKES THE WIDTH IT IS GIVEN. George, 20 Sep 2026: *"i like the zoom
        // out, but use the full available width for the map"*. It was a fixed 512-pixel
        // box inside a card twice that wide, so half the card sat empty — and worse, the
        // zoom was chosen for a NARROW view, which is half of why it had to zoom out
        // further than it needed to for the same airports to fit.
        const VIEW_W = Math.max(280, Math.round(host.clientWidth) || 512);
        const VIEW_H = Math.round(Math.min(VIEW_W * 0.66, 460));
        // Room for a code label to the right of a mark, so nothing that fits the box is
        // drawn with its label running off the edge of the view.
        const PAD = 40;
        // The box that has to fit, in degrees.
        let minLat = 90;
        let maxLat = -90;
        let minLon = 180;
        let maxLon = -180;
        for (const point of needed) {
            minLat = Math.min(minLat, point.lat);
            maxLat = Math.max(maxLat, point.lat);
            minLon = Math.min(minLon, point.lon);
            maxLon = Math.max(maxLon, point.lon);
        }
        // 🔴 THE FENCE IS DRAWN, NOT FITTED — UNLESS THERE IS NOTHING ELSE TO SHOW.
        // George, 20 Sep 2026: *"only the required zoom out where airports can be seen"*.
        // Folding the whole circle into the box meant a 50 km setting zoomed the map out
        // to 50 km of mostly empty ground and shrank the airports just picked to dots.
        // The airports are what was asked for, so the zoom is chosen for THEM and the
        // reader's own point; the circle is drawn at its true size, and a circle running
        // off the edge of a map is an ordinary thing for a circle to do.
        if (at && this.airports.length === 0) {
            // Nothing picked yet, so the circle is the only thing on the map and there is
            // no such thing as too zoomed out for it.
            const dLat = this.radiusKm / 111.32;
            const dLon = this.radiusKm / (111.32 * Math.max(0.2, Math.cos((at.lat * Math.PI) / 180)));
            minLat = Math.min(minLat, at.lat - dLat);
            maxLat = Math.max(maxLat, at.lat + dLat);
            minLon = Math.min(minLon, at.lon - dLon);
            maxLon = Math.max(maxLon, at.lon + dLon);
        }
        const midLat = (minLat + maxLat) / 2;
        const midLon = (minLon + maxLon) / 2;
        // 🔴 A FLOOR OF ABOUT TWO KILOMETRES, not half a thousandth of a degree. One
        // airport picked on top of the reader spans almost nothing, and the old floor
        // asked for the closest zoom the tile service has — a satellite view of a car
        // park with a code label on it.
        const spanLat = Math.max(maxLat - minLat, 0.02);
        const spanLon = Math.max(maxLon - minLon, 0.02);
        // 🔴 THE ZOOM IS CHOSEN FOR THE AIRPORTS YOU PICKED, AND FOR NOTHING ELSE.
        //
        // George, 20 Sep 2026: *"only the required zoom out where airports can be seen"*,
        // and separately *"the circle in the map should be based on the how far out from
        // you distance"*.
        //
        // 🔴 I TRIED TO SATISFY BOTH AND IT PRODUCED SOMETHING WORSE, which the
        // measurement caught: an ease-out of up to two steps aimed at bringing the
        // circle's edge into view gave **zoom 11 at 10 km, zoom 10 at 20 km and zoom 12 at
        // 50 km** — a LARGER radius producing a CLOSER view, because the easing succeeded
        // at the small radii and failed at the large one. A rule that makes the map jump
        // about as you change a number is worse than a circle whose edge is off-screen.
        //
        // So the rule is now one sentence: **the zoom depends only on the airports you
        // picked and where you are.** The same picks give the same view at every distance.
        // The circle is drawn at its true size, so a radius larger than the airports need
        // runs past the edge of the map — and the note on the map says exactly that.
        const metresPerDegLat = 110_574;
        const metresPerDegLon = 111_320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
        let zoom = 3;
        for (let candidate = 15; candidate >= 3; candidate -= 1) {
            const candidateScale = (156543.03392 * Math.cos((midLat * Math.PI) / 180)) / 2 ** candidate;
            const wide = (spanLon * metresPerDegLon) / candidateScale;
            const tall = (spanLat * metresPerDegLat) / candidateScale;
            if (wide <= VIEW_W - PAD * 2 && tall <= VIEW_H - PAD * 2) {
                zoom = candidate;
                break;
            }
        }
        const scale = (156543.03392 * Math.cos((midLat * Math.PI) / 180)) / 2 ** zoom;
        const span = 2 ** zoom;
        const middleX = lonToTile(midLon, zoom) * TILE;
        const middleY = latToTile(midLat, zoom) * TILE;
        const left = middleX - VIEW_W / 2;
        const top = middleY - VIEW_H / 2;
        const x0 = Math.floor(left / TILE);
        const x1 = Math.floor((left + VIEW_W - 1) / TILE);
        const y0 = Math.max(0, Math.floor(top / TILE));
        const y1 = Math.min(span - 1, Math.floor((top + VIEW_H - 1) / TILE));
        let tiles = '';
        for (let ty = y0; ty <= y1; ty += 1) {
            for (let tx = x0; tx <= x1; tx += 1) {
                // Wrapped across the antimeridian, clamped before the poles — the two
                // edges of a slippy map are the two places a tile number stops meaning
                // what it says.
                const wrapped = ((tx % span) + span) % span;
                tiles +=
                    `<img class="locmap-tile" alt="" width="${TILE}" height="${TILE}" ` +
                        `style="left:${(tx * TILE - left).toFixed(0)}px;top:${(ty * TILE - top).toFixed(0)}px" ` +
                        `src="/api/tiles/${zoom}/${wrapped}/${ty}.png" decoding="async" />`;
            }
        }
        const spotOf = (lat, lon) => ({
            x: lonToTile(lon, zoom) * TILE - left,
            y: latToTile(lat, zoom) * TILE - top,
        });
        const you = at ? spotOf(at.lat, at.lon) : null;
        const fencePx = (this.radiusKm * 1000) / scale;
        let marks = '';
        // The nearest airports, small and grey, with a line back to the reader. A picked
        // one is skipped here and drawn in its own pass below, so it can never be drawn
        // twice or have something laid over it.
        if (you) {
            for (const row of this.nearby.slice(0, 10)) {
                if (this.isChosen(row.airport.icao))
                    continue;
                const spot = spotOf(row.airport.lat, row.airport.lon);
                // Off the view is off the view — a marker drawn outside would be clipped
                // anyway, and its label would run back into the map.
                if (spot.x < -30 || spot.x > VIEW_W + 30 || spot.y < -30 || spot.y > VIEW_H + 30)
                    continue;
                marks +=
                    `<line class="locmap-line" x1="${you.x.toFixed(1)}" y1="${you.y.toFixed(1)}" ` +
                        `x2="${spot.x.toFixed(1)}" y2="${spot.y.toFixed(1)}" />` +
                        `<circle class="locmap-airport" cx="${spot.x.toFixed(1)}" cy="${spot.y.toFixed(1)}" r="3.4" />` +
                        `<text class="locmap-label" x="${(spot.x + 8).toFixed(1)}" ` +
                        `y="${(spot.y + 3.5).toFixed(1)}">${escapeHtml(row.airport.icao)}</text>`;
            }
        }
        // 🔴 EVERY PICKED AIRPORT, DRAWN LAST SO NOTHING IS LAID OVER IT, AND NEVER
        // SKIPPED BY THE OFF-VIEW GUARD THE OTHERS USE. The zoom above was chosen to fit
        // them all, so a picked airport outside the view would mean the arithmetic was
        // wrong — and quietly hiding it is how a wrong zoom stays wrong.
        for (const one of this.airports) {
            const spot = spotOf(one.lat, one.lon);
            if (you) {
                marks +=
                    `<line class="locmap-line locmap-line-chosen" x1="${you.x.toFixed(1)}" y1="${you.y.toFixed(1)}" ` +
                        `x2="${spot.x.toFixed(1)}" y2="${spot.y.toFixed(1)}" />`;
            }
            marks +=
                `<circle class="locmap-airport locmap-airport-chosen" cx="${spot.x.toFixed(1)}" ` +
                    `cy="${spot.y.toFixed(1)}" r="6" />` +
                    `<text class="locmap-label locmap-label-chosen" x="${(spot.x + 9).toFixed(1)}" ` +
                    `y="${(spot.y + 3.5).toFixed(1)}">${escapeHtml(one.icao)}</text>`;
        }
        const described = this.airports.length === 1
            ? `the airport you picked (${this.airports[0].icao})`
            : `${this.airports.length} airports you picked (${this.chosenIcaos().join(', ')})`;
        host.innerHTML =
            `<div class="locmap" style="width:${VIEW_W}px;height:${VIEW_H}px">` +
                tiles +
                `<svg class="locmap-over" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" ` +
                `aria-label="A map showing ${escapeHtml(described)}` +
                (you ? `, a ${this.radiusKm} kilometre circle around your position` : '') +
                `, and the nearest other airports marked with their codes">` +
                (you
                    ? `<circle class="locmap-fence" cx="${you.x.toFixed(1)}" cy="${you.y.toFixed(1)}" r="${fencePx.toFixed(1)}" />`
                    : '') +
                marks +
                (you
                    ? `<circle class="locmap-you" cx="${you.x.toFixed(1)}" cy="${you.y.toFixed(1)}" r="5" />` +
                        `<text class="locmap-you-label" x="${you.x.toFixed(1)}" ` +
                        `y="${(you.y + 18).toFixed(1)}" text-anchor="middle">you</text>`
                    : '') +
                '</svg></div>' +
                '<p class="small muted locmap-note">The map is ' +
                '<a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a>, free and with no API key. ' +
                'It is zoomed to fit exactly the airports you picked, no further out than that needs' +
                (you ? `, and the circle is the ${this.radiusKm} km distance you chose — drawn to scale, so it can run past the edge of the map` : '') +
                '. The tiles are fetched by this site\'s own server rather than by your browser, so the map service never ' +
                'sees you — the same way the flight feed is handled.' +
                '</p>';
    }
    /**
     * 🔴 THE MAP IS REDRAWN WHEN THE BOX CHANGES SIZE. The tiles are placed by pixel,
     * so a wider card cannot reflow the drawing to fit — the box has to be measured and
     * the map drawn again. A resize listener on the window would miss the case that
     * matters most here: a step that was folded open, or a card that grew when a note
     * filled in. A ResizeObserver sees all of them.
     */
    bindMapResize() {
        const host = byId('locMap');
        if (!host || typeof ResizeObserver === 'undefined')
            return;
        let last = host.clientWidth;
        new ResizeObserver(() => {
            const width = Math.round(host.clientWidth);
            // A folded-away card measures zero, and redrawing on zero would throw the map
            // away and not bring it back.
            if (width === 0 || Math.abs(width - last) < 24)
                return;
            last = width;
            this.renderMap();
        }).observe(host);
    }
    renderNearby() {
        const host = byId('nearbyList');
        if (!host || !this.listedAirports)
            return;
        if (this.nearby.length === 0) {
            host.innerHTML =
                '<p class="muted small">Type a postal code above — or press <b>find me</b> — and this list is ordered by ' +
                    'how far each airport is from where you are.</p>';
            return;
        }
        host.innerHTML = this.nearby
            .slice(0, 14)
            .map(({ airport, km }) => {
            // 🔴 AN AIRPORT IS A CHOICE, SO IT TAKES THE YELLOW — AND NOTHING ELSE.
            // George, 20 Sep 2026: *"selecting an airport should hava star and yellow
            // hue"*, then *"remove start that are in chip, i just want the yellow hue
            // only"*. The colour is the mark; a star repeated on every chip is the
            // same fact drawn twice.
            //
            // 🔴 AND IT IS A TOGGLE. George, 20 Sep 2026: *"i should also be able to
            // select multiple airport"*. The label says what pressing it will do
            // rather than what the airport is, because that is the question a reader
            // has while their pointer is over it.
            const picked = this.isChosen(airport.icao);
            return (`<button type="button" class="ghost chip near-chip" data-icao="${escapeHtml(airport.icao)}" ` +
                `aria-pressed="${picked}" title="${picked ? `Stop watching ${airport.icao}` : `Also watch ${airport.icao}`}" ` +
                `data-ga="airport-near">` +
                `<span class="mono">${escapeHtml(airport.icao)}</span> ${escapeHtml(airport.location || airport.name)}` +
                `<span class="near-km">${Math.round(km)} km</span></button>`);
        })
            .join('');
        for (const button of host.querySelectorAll('.near-chip')) {
            button.addEventListener('click', () => void this.toggleAirport(button.dataset.icao ?? ''));
        }
        // Said back to the reader, because a place they gave once and cannot see again
        // is indistinguishable from a place the page forgot.
        const head = byId('nearbyHead');
        if (head)
            head.textContent = this.placeLabel ? `Airports around ${this.placeLabel}` : 'Airports around you';
        this.renderMap();
    }
    computeNearby(lat, lon, label = '') {
        const list = this.listedAirports?.airports ?? [];
        if (list.length === 0)
            return;
        // 400 km, because that is roughly the reach of the list as it stands. The
        // filter is not decoration: three of the identifiers in the source region
        // file are far outside it — Brampton's CNC3 is fine, but a mistyped code
        // resolved to Paramount Bistcho in northern Alberta, and a list that
        // offered that as an airport "near you" would be worse than a shorter list.
        this.nearby = list
            .map((airport) => ({ airport, km: nmToKm(distanceNm(lat, lon, airport.lat, airport.lon)) }))
            .filter((row) => row.km <= 400)
            .sort((a, b) => a.km - b.km);
        // 🔴 THE READER'S PLACE IS NOW THE CENTRE OF EVERYTHING — the fence, the
        // chart and the airport order all hang off it, because the question is what
        // is in the air around THEM.
        this.centre = { lat, lon };
        // Kept so a reload does not forget where the reader is. The label travels with
        // it, because "restored to Hamilton (Riverdale)" is an answer and a pair of
        // coordinates is not.
        this.placeLabel = label;
        writeStore(CENTRE_KEY, JSON.stringify({ lat, lon, label }));
        this.renderNearby();
        // 🔴 RE-ARMED EVEN WITH NO AIRPORT. `this.point()` falls back to the centre, and
        // the poll only ever needed a point — so a reader whose airport lookup failed
        // can still say where they are and be shown what is in the air around them. The
        // old `if (this.airport)` guard meant the steps appeared with nothing behind
        // them, which is a dead end dressed as progress.
        this.rearm();
        this.updateSteps();
        track('nearby_computed', { count: this.nearby.length });
    }
    /**
     * A postal code, for anyone who would rather not hand their browser a position.
     *
     * 🔴 THIS EXISTS BECAUSE THE POSITION REQUEST IS A REAL ASK. A browser prompt is
     * a thing people refuse, and a page that only works after a yes is a page that
     * does not work. A postal code is typed, is not a location the browser knows,
     * and is looked up by our own server so the lookup service never sees the
     * visitor directly.
     */
    bindPostal() {
        const form = byId('postalForm');
        const input = byId('postalInput');
        const note = byId('postalNote');
        if (!form || !input)
            return;
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const value = input.value.trim();
            if (!value)
                return;
            if (note)
                note.textContent = `Looking up ${value.toUpperCase()}…`;
            try {
                const response = await fetch(`/api/geo/postal/${encodeURIComponent(value)}`, {
                    headers: { accept: 'application/json' },
                });
                const body = (await readJson(response));
                if (!body.ok || typeof body.lat !== 'number' || typeof body.lon !== 'number') {
                    if (note)
                        note.textContent = body.error ?? 'That code could not be looked up.';
                    return;
                }
                this.computeNearby(body.lat, body.lon, `${body.place ?? ''}${body.region ? `, ${body.region}` : ''}`);
                if (note) {
                    note.textContent =
                        `${body.place}, ${body.region} — airports below are listed by distance from there. ${body.note ?? ''}`.trim();
                }
                track('postal_located', { count: this.nearby.length });
            }
            catch (error) {
                if (note) {
                    note.textContent =
                        'The postal code could not be looked up. ' +
                            (error instanceof Error ? error.message : '') +
                            ' Pick an airport by name instead — nothing else on the page depends on this.';
                }
            }
        });
    }
    bindLocate() {
        this.bindPostal();
        const button = byId('locateBtn');
        const note = byId('locateNote');
        if (!button)
            return;
        button.addEventListener('click', () => {
            if (!('geolocation' in navigator)) {
                if (note)
                    note.textContent = 'This browser cannot report a position. Pick an airport by name instead.';
                return;
            }
            button.disabled = true;
            if (note)
                note.textContent = 'Asking your browser where you are…';
            track('locate_asked', {});
            navigator.geolocation.getCurrentPosition((position) => {
                button.disabled = false;
                this.computeNearby(position.coords.latitude, position.coords.longitude, 'your position');
                if (note) {
                    note.textContent =
                        'Ordered by distance from your position. Your coordinates are used inside this page and are not sent ' +
                            'anywhere — the feed is only ever told which airport you chose.';
                }
            }, (error) => {
                button.disabled = false;
                if (note) {
                    note.textContent =
                        `Your browser did not give a position (${error.message}). Pick an airport by name below instead — ` +
                            'nothing else on the page depends on knowing where you are.';
                }
            }, { timeout: 10_000, maximumAge: 300_000 });
        });
    }
    /* --------------------------------------------------------- the live view */
    /**
     * 🔴 THERE IS NO VIEW SWITCH ANY MORE. George, 20 Sep 2026: *"i only want the user
     * to pick so remove Pick what to watch / In the air now"*. Two buttons offering
     * "choose" and "look" put a mode in front of the thing the page is actually for.
     * So there is one flow: pick, and the chart arrives as the step AFTER the picking
     * — the same way the departures board does, because it is the same kind of thing.
     *
     * The chart is drawn when its step arrives (see updateSteps), not when it was last
     * polled, or it would show whatever was in the air a moment before it appeared.
     */
    /**
     * Aircraft matching the selection that are in the air at this moment.
     *
     * This is deliberately NOT the departures board. The board is a record of what
     * has already left; this is a picture of what is up there now, so a person can
     * look up at a contrail and find it. Both are read from the same poll, so the
     * chart and the table can never disagree about the same aircraft.
     */
    matchedAirborne() {
        const at = this.point();
        // No airport required: the fence is drawn round the READER, so an aircraft can
        // be in it whether or not an airport lookup ever succeeded.
        if (!this.engine || !at)
            return [];
        const out = [];
        for (const reading of this.lastReadings) {
            if (typeof reading.lat !== 'number' || typeof reading.lon !== 'number')
                continue;
            // On the ground is not in the air. The string 'ground' is how the feed
            // says it, and it is a string rather than a number — see detect.ts.
            if (reading.alt_baro === 'ground')
                continue;
            const match = this.engine.matchOf(reading);
            if (!match)
                continue;
            out.push({
                label: String(reading.flight || reading.r || reading.hex).trim(),
                tail: String(reading.r || '').trim(),
                type: String(reading.t || '').trim().toUpperCase(),
                hex: reading.hex,
                altitudeFt: typeof reading.alt_baro === 'number' ? reading.alt_baro : null,
                climbFpm: typeof reading.baro_rate === 'number' ? reading.baro_rate : null,
                speedKt: typeof reading.gs === 'number' ? reading.gs : null,
                km: nmToKm(distanceNm(at.lat, at.lon, reading.lat, reading.lon)),
                bearingDeg: bearingDeg(at.lat, at.lon, reading.lat, reading.lon),
                matchedBy: match.label,
                watched: true,
            });
        }
        return out.sort((a, b) => a.km - b.km);
    }
    renderLive() {
        const chart = byId('liveChart');
        const body = byId('liveBody');
        const empty = byId('liveEmpty');
        const summary = byId('liveSummary');
        if (!chart || !body || !empty)
            return;
        const rows = this.matchedAirborne();
        empty.hidden = rows.length > 0;
        if (rows.length === 0) {
            chart.innerHTML = '';
            body.innerHTML = '';
            if (summary) {
                summary.textContent =
                    this.watchlist.length === 0 && this.typeRules.length === 0
                        ? 'Nothing is selected yet, so there is nothing to chart. Pick an aircraft type on the first view.'
                        : 'Nothing matching your selection is in the air inside the fence at this moment.';
            }
            return;
        }
        if (summary) {
            summary.textContent =
                `${rows.length} matching aircraft in the air right now · drawn from the reading taken at ${formatClock(this.lastPollAt)}`;
        }
        // 🔴 A TOP-DOWN PICTURE, NOT A BAR CHART. Distance alone says "8 km away";
        // distance WITH a bearing says "8 km to the south-west", which is where an
        // aircraft leaving Hamilton for Toronto actually is. The circle is the fence
        // the feed was asked for, so the picture and the query are the same shape.
        const size = 340;
        const centre = size / 2;
        const radius = centre - 28;
        const maxKm = Math.max(this.radiusKm, ...rows.map((row) => row.km));
        const toPx = (km) => (km / maxKm) * radius;
        let svg = `<svg viewBox="0 0 ${size} ${size}" class="radar" role="img" aria-label="Aircraft in the air, drawn by direction and distance from ${escapeHtml(this.airportPhrase())}">`;
        svg += `<circle cx="${centre}" cy="${centre}" r="${radius.toFixed(1)}" class="radar-edge" />`;
        for (const ring of [maxKm / 3, (maxKm * 2) / 3, maxKm]) {
            svg += `<circle cx="${centre}" cy="${centre}" r="${toPx(ring).toFixed(1)}" class="radar-ring" />`;
            svg += `<text x="${(centre + 4).toFixed(1)}" y="${(centre - toPx(ring) + 12).toFixed(1)}" class="radar-label">${Math.round(ring)} km</text>`;
        }
        for (const [deg, name] of [
            [0, 'N'],
            [90, 'E'],
            [180, 'S'],
            [270, 'W'],
        ]) {
            const rad = (deg * Math.PI) / 180;
            svg += `<text x="${(centre + Math.sin(rad) * (radius + 12)).toFixed(1)}" y="${(centre - Math.cos(rad) * (radius + 12) + 4).toFixed(1)}" class="radar-compass" text-anchor="middle">${name}</text>`;
        }
        svg += `<circle cx="${centre}" cy="${centre}" r="3" class="radar-field" />`;
        svg += `<text x="${centre}" y="${centre + 16}" class="radar-label" text-anchor="middle">${escapeHtml(this.airportCentreLabel())}</text>`;
        for (const row of rows) {
            const rad = (row.bearingDeg * Math.PI) / 180;
            const x = centre + Math.sin(rad) * toPx(row.km);
            const y = centre - Math.cos(rad) * toPx(row.km);
            // A higher aircraft is drawn larger, so altitude is visible at a glance
            // without reading a number off a list.
            const dot = 3.2 + Math.min(6, (row.altitudeFt ?? 0) / 6500);
            svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${dot.toFixed(1)}" class="radar-dot"><title>${escapeHtml(row.label)} · ${escapeHtml(row.type)} · ${row.altitudeFt ?? '?'} ft · ${Math.round(row.km)} km ${compassPoint(row.bearingDeg)}</title></circle>`;
        }
        svg += '</svg>';
        chart.innerHTML = svg;
        body.innerHTML = rows
            .map((row) => {
            const info = describeType(row.type);
            const climb = row.climbFpm === null
                ? '—'
                : `${row.climbFpm > 0 ? '+' : ''}${row.climbFpm} ft/min`;
            return ('<tr>' +
                `<td><b>${escapeHtml(row.label)}</b>${row.tail && row.tail !== row.label ? ` <span class="mono muted small">${escapeHtml(row.tail)}</span>` : ''}</td>` +
                `<td title="${escapeHtml(info.name)}">${escapeHtml(info.name)}</td>` +
                `<td class="mono">${row.altitudeFt === null ? '—' : `${row.altitudeFt.toLocaleString()} ft`}</td>` +
                `<td class="mono">${escapeHtml(climb)}</td>` +
                `<td class="mono">${Math.round(row.km)} km ${compassPoint(row.bearingDeg)}</td>` +
                `<td class="small muted">${escapeHtml(row.matchedBy)}</td>` +
                '</tr>');
        })
            .join('');
    }
    /* ------------------------------------------------------------- watchlist */
    bindWatchForm() {
        const form = byId('watchForm');
        const input = byId('watchInput');
        if (!form || !input)
            return;
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const value = input.value.trim();
            if (!value)
                return;
            this.addWatch(value);
            input.value = '';
        });
    }
    addWatch(key) {
        const value = key.trim();
        if (!value)
            return;
        if (this.watchlist.some((item) => normaliseKey(item) === normaliseKey(value)))
            return;
        this.watchlist.push(value);
        this.saveWatchlist();
        this.renderWatchlist();
        this.renderAircraft();
        track('aircraft_watched', { total: this.watchlist.length });
    }
    removeWatch(key) {
        this.watchlist = this.watchlist.filter((item) => normaliseKey(item) !== normaliseKey(key));
        this.saveWatchlist();
        this.renderWatchlist();
        this.renderAircraft();
    }
}
const page = new Page();
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => page.start());
}
else {
    page.start();
}
