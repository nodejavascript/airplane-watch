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
import { AIRPORTS, DEFAULT_AIRPORT, parseAirport, } from './airports.js';
import { DEFAULTS, DetectionEngine, normaliseKey, } from './detect.js';
const WATCH_KEY = 'aircraft_watchlist';
const BOARD_KEY = 'aircraft_departures';
const AIRPORT_KEY = 'aircraft_airport';
const POLL_MS = 10_000;
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
    airport = null;
    engine = null;
    watchlist = [];
    board = [];
    timer = null;
    radiusNm = DEFAULTS.radiusNm;
    lastPollAt = 0;
    lastError = '';
    polls = 0;
    start() {
        this.watchlist = this.loadList(WATCH_KEY);
        this.board = this.loadBoard();
        this.buildAirportButtons();
        this.buildRadiusButtons();
        this.renderWatchlist();
        this.renderBoard();
        this.bindWatchForm();
        this.bindNotify();
        this.renderWatchButton();
        const saved = readStore(AIRPORT_KEY, DEFAULT_AIRPORT);
        void this.chooseAirport(saved);
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
    saveWatchlist() {
        writeStore(WATCH_KEY, JSON.stringify(this.watchlist));
        this.engine?.setWatchlist(this.watchlist);
    }
    saveBoard() {
        writeStore(BOARD_KEY, JSON.stringify(this.board.slice(0, 100)));
    }
    /* ------------------------------------------------------------ the airport */
    buildAirportButtons() {
        const host = byId('airportButtons');
        if (!host)
            return;
        host.innerHTML = '';
        for (const airport of AIRPORTS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chip';
            button.dataset.icao = airport.icao;
            button.setAttribute('data-ga', 'airport');
            button.innerHTML = `<b>${escapeHtml(airport.icao)}</b> <span>${escapeHtml(airport.label)}</span>`;
            button.addEventListener('click', () => void this.chooseAirport(airport.icao));
            host.appendChild(button);
        }
    }
    buildRadiusButtons() {
        const host = byId('radiusButtons');
        if (!host)
            return;
        host.innerHTML = '';
        for (const radius of [5, 10, 25]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chip chip-small';
            button.dataset.radius = String(radius);
            button.textContent = `${radius} nm`;
            button.setAttribute('aria-pressed', String(radius === this.radiusNm));
            button.addEventListener('click', () => {
                this.radiusNm = radius;
                for (const other of host.querySelectorAll('button')) {
                    other.setAttribute('aria-pressed', String(other === button));
                }
                if (this.airport)
                    void this.chooseAirport(this.airport.icao);
                track('radius_changed', { radius_nm: radius });
            });
            host.appendChild(button);
        }
    }
    async chooseAirport(icao) {
        this.stop();
        this.setStatus(`Looking up ${icao}…`, 'working');
        try {
            const response = await fetch(`/api/0/airport/${encodeURIComponent(icao)}`, {
                headers: { accept: 'application/json' },
            });
            const payload = await readJson(response);
            if (!response.ok)
                throw new Error(`The feed answered ${response.status} for ${icao}.`);
            this.airport = parseAirport(icao, payload);
        }
        catch (error) {
            this.airport = null;
            this.lastError = error instanceof Error ? error.message : String(error);
            this.setStatus(this.lastError, 'error');
            return;
        }
        writeStore(AIRPORT_KEY, this.airport.icao);
        for (const button of document.querySelectorAll('#airportButtons .chip')) {
            button.setAttribute('aria-pressed', String(button.dataset.icao === this.airport.icao));
        }
        const title = byId('airportTitle');
        if (title)
            title.textContent = `${this.airport.name} (${this.airport.icao})`;
        const where = byId('airportWhere');
        if (where) {
            where.textContent =
                `${this.airport.location || '—'} · ${this.airport.lat.toFixed(4)}, ${this.airport.lon.toFixed(4)}` +
                    (this.airport.elevationFt !== null ? ` · field elevation ${this.airport.elevationFt} ft` : '');
        }
        const fence = byId('fenceNote');
        if (fence) {
            fence.textContent =
                `Watching a ${this.radiusNm} nautical mile circle around it. ` +
                    (this.radiusNm <= 5
                        ? 'A tight fence is the best chance of catching an aircraft on the ground, and the least notice of anything else.'
                        : 'A wider fence sees more aircraft, and sees fewer of them on the ground — the two pull in opposite directions.');
        }
        this.engine = new DetectionEngine({
            lat: this.airport.lat,
            lon: this.airport.lon,
            radiusNm: this.radiusNm,
            now: Date.now(),
            staleAfterSec: DEFAULTS.staleAfterSec,
            cooldownMs: DEFAULTS.cooldownMs,
        }, this.watchlist);
        track('airport_chosen', { airport: this.airport.icao, radius_nm: this.radiusNm });
        await this.poll();
        this.timer = window.setInterval(() => void this.poll(), POLL_MS);
    }
    stop() {
        if (this.timer !== null) {
            window.clearInterval(this.timer);
            this.timer = null;
        }
    }
    /* -------------------------------------------------------------- the polls */
    async poll() {
        if (!this.airport || !this.engine)
            return;
        const url = `/api/v2/point/${this.airport.lat}/${this.airport.lon}/${this.radiusNm}`;
        try {
            const response = await fetch(url, { headers: { accept: 'application/json' } });
            const payload = (await readJson(response));
            if (!response.ok)
                throw new Error(`The feed answered ${response.status}.`);
            this.engine.setWatchlist(this.watchlist);
            const readings = Array.isArray(payload.ac) ? payload.ac : [];
            const departures = this.engine.ingest(readings, Date.now());
            this.polls += 1;
            this.lastPollAt = Date.now();
            this.lastError = '';
            if (departures.length > 0)
                this.recordDepartures(departures);
            this.renderAircraft();
            this.setStatus(`${readings.length} aircraft in the fence · poll ${this.polls} · last ${formatClock(this.lastPollAt)}`, 'ok');
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
                `<td class="mono">${escapeHtml(state.type || '—')}</td>` +
                `<td>${phase}</td>` +
                `<td class="mono">${formatClock(state.observedAt)}</td>` +
                `<td><button type="button" class="linkish watch-toggle" data-key="${escapeHtml(label)}" ` +
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
            return (`<li class="departure${departure.watched ? ' departure-watched' : ''}">` +
                `<span class="departure-time mono">${formatClock(departure.at)}</span>` +
                `<span class="departure-what"><b>${escapeHtml(label)}</b>` +
                (departure.type ? ` <span class="mono">${escapeHtml(departure.type)}</span>` : '') +
                (departure.watched ? ' <span class="tag tag-watched">watched</span>' : '') +
                '</span>' +
                `<span class="departure-how">${escapeHtml(altitude)} · ${escapeHtml(climb)} · ` +
                `${departure.distanceNm} nm out</span>` +
                `<span class="departure-verdict tag tag-${departure.verdict}">` +
                `${departure.verdict === 'confirmed' ? 'seen on the ground first' : 'first seen climbing'}</span>` +
                `<span class="departure-why muted">${escapeHtml(departure.reason)}</span>` +
                '</li>');
        })
            .join('');
    }
    renderWatchlist() {
        const host = byId('watchList');
        if (!host)
            return;
        if (this.watchlist.length === 0) {
            host.innerHTML =
                '<li class="muted">Nothing watched yet. Press <b>watch</b> on an aircraft, or type a tail number above.</li>';
            return;
        }
        host.innerHTML = this.watchlist
            .map((item) => `<li><span class="mono">${escapeHtml(item)}</span> ` +
            `<button type="button" class="linkish watch-remove" data-key="${escapeHtml(item)}" ` +
            `data-ga="unwatch">remove</button></li>`)
            .join('');
        for (const button of host.querySelectorAll('.watch-remove')) {
            button.addEventListener('click', () => this.removeWatch(button.dataset.key ?? ''));
        }
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
            new Notification(`${label} has left ${this.airport?.icao ?? 'the airport'}`, {
                body: `${departure.verdict === 'confirmed' ? 'It was on the ground and it is not now' : 'It was first seen already climbing'}` +
                    ` — ${departure.altitudeFt ?? '?'} ft${climb}, ${departure.distanceNm} nm out.`,
                tag: departure.hex,
            });
        }
        catch {
            /* Some browsers refuse to build a notification from a page that is not
               itself in the foreground. The board is the record either way. */
        }
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
