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

import {
  DEFAULT_AIRPORT,
  parseAirport,
  type ResolvedAirport,
} from './airports.js';
import { thumbSvg } from './thumbs.js';
import {
  DEFAULTS,
  DetectionEngine,
  distanceNm,
  kmToNm,
  nmToKm,
  normaliseKey,
  type Departure,
  type Reading,
  type TypeRule,
} from './detect.js';
import {
  CLASS_ORDER,
  classLabel,
  describeType,
  isCivilClass,
  knownTypeCount,
  type AircraftClass,
} from './typeinfo.js';
import { RESIDENTS } from './region.js';

const WATCH_KEY = 'aircraft_watchlist';
const TYPES_KEY = 'aircraft_types';
const BOARD_KEY = 'aircraft_departures';
const AIRPORT_KEY = 'aircraft_airport';
const VIEW_KEY = 'aircraft_view';
const POLL_MS = 10_000;

/**
 * 🔴 KILOMETRES, NOT NAUTICAL MILES. George, 20 Sep 2026: *"nobody understand
 * nm"*. The feed takes nautical miles and says so in its own endpoint summary
 * (*"Aircrafts surrounding a point (lat, lon) up to 250nm"*), so the conversion
 * happens in `kmToNm` and the reader never meets the unit. Each distance says
 * what it means in plain words as well as in kilometres, because "20 km" is a
 * number and "the airport and the city around it" is an answer.
 */
const DISTANCES: { km: number; label: string; blurb: string }[] = [
  { km: 10, label: 'Just the airport', blurb: 'the runway and the apron' },
  { km: 20, label: 'The airport and the city', blurb: 'climb-out and approach' },
  { km: 50, label: 'The whole region', blurb: 'everything passing over' },
];

/** One measured type, as tools/survey-types.mjs writes it. */
interface SurveyedType {
  code: string;
  seen: number;
  airports: string[];
  operators: string[];
  /** Tail numbers this type actually transmitted, most widely seen first. */
  registrations?: { reg: string; airports: string[] }[];
}

interface TypesDocument {
  generated: string;
  method: string;
  aircraftInspected: number;
  counted: string;
  roundsRefusedByRateLimit?: number;
  /** Said out loud: a registration is only in here if one was transmitted. */
  registrationsNote?: string;
  types: SurveyedType[];
}

/** One airport, as tools/verify-airports.mjs writes it after asking the feed. */
interface ListedAirport {
  icao: string;
  iata?: string;
  name: string;
  location: string;
  country?: string;
  lat: number;
  lon: number;
  elevationFt: number | null;
}

interface AirportsDocument {
  generated: string;
  covers: string;
  method: string;
  kept: number;
  dropped: string[];
  airports: ListedAirport[];
}

/** An airport with how far it is from the reader. */
interface NearbyAirport {
  airport: ListedAirport;
  km: number;
}

/** One aircraft matching the selection that is in the air right now. */
interface LiveAircraft {
  label: string;
  tail: string;
  type: string;
  hex: string;
  altitudeFt: number | null;
  climbFpm: number | null;
  speedKt: number | null;
  km: number;
  bearingDeg: number;
  matchedBy: string;
  watched: boolean;
}

/**
 * How far round the compass one point is from another, in degrees from north.
 *
 * This is what makes the live view a picture rather than a list: distance alone
 * says an aircraft is 8 km away, and distance with a bearing says it is 8 km to
 * the south-west, which is the direction an aircraft leaves Hamilton for Toronto.
 */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
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

function compassPoint(degrees: number): string {
  return COMPASS[Math.round(degrees / 22.5) % 16];
}

interface FeedResponse {
  ac?: Reading[];
  now?: number;
  total?: number;
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
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const kind = (response.headers.get('content-type') ?? 'no content type').split(';')[0];
    throw new Error(
      `The feed answered ${response.status} with ${kind} instead of JSON` +
        (/^\s*<(!doctype|html)/i.test(text)
          ? ' — that is a web page, so something in front of the feed answered instead of the feed'
          : '') +
        `. ` +
        text.slice(0, 120).replace(/\s+/g, ' ').trim()
    );
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

const TAIL_STAR =
  '<svg class="tail-star" viewBox="0 0 24 24" aria-hidden="true"><path d="' + STAR_PATH + '"/></svg>';

function starButton(code: string, wholeType: boolean, narrowed: boolean): string {
  const label = wholeType ? 'Favourited — remove' : narrowed ? 'Favourite the whole type' : 'Favourite this type';
  return (
    `<button type="button" class="star type-toggle${narrowed ? ' star-part' : ''}" ` +
    `data-type="${escapeHtml(code)}" aria-pressed="${wholeType}" ` +
    `title="${label}" aria-label="${label}" data-ga="type-favourite">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg></button>`
  );
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function readStore(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — the session still works, it just does not survive a reload */
  }
}

/** Send an event only if the visitor allowed analytics. */
function track(name: string, params: Record<string, unknown> = {}): void {
  if (typeof window.aircraftTrack === 'function') window.aircraftTrack(name, params);
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(value: string): string {
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
  private airport: ResolvedAirport | null = null;
  private engine: DetectionEngine | null = null;
  private watchlist: string[] = [];
  private typeRules: TypeRule[] = [];
  private board: Departure[] = [];
  private timer: number | null = null;
  private radiusKm = 20;
  private lastPollAt = 0;
  private lastError = '';
  private polls = 0;
  private survey: TypesDocument | null = null;

  /**
   * Type codes the feed itself marks as military, harvested by
   * `tools/survey-military.mjs`. Empty if that file could not be read.
   */
  private militaryCodes = new Set<string>();

  /**
   * Where the reader actually is, once they have said. Everything else — the
   * fence, the airports list, the chart — hangs off this rather than off the
   * airport, because the question is what is in the air around THEM.
   */
  private centre: { lat: number; lon: number } | null = null;

  /** The airport list the feed itself confirmed, for the "around you" panel. */
  private listedAirports: AirportsDocument | null = null;
  private nearby: NearbyAirport[] = [];
  /** The raw readings from the last poll — the live view is drawn from these. */
  private lastReadings: Reading[] = [];
  private view: 'select' | 'live' = 'select';
  /** Types the feed showed in THIS session, which may be newer than the survey. */
  private liveTypes = new Map<string, number>();
  private typeFilter: AircraftClass | 'all' = 'all';

  start(): void {
    this.watchlist = this.loadList(WATCH_KEY);
    this.typeRules = this.loadTypeRules();
    this.board = this.loadBoard();
    this.buildRadiusButtons();
    this.buildTypeFilter();
    this.renderWatchlist();
    this.renderBoard();
    this.bindWatchForm();
    this.bindNotify();
    this.renderWatchButton();
    this.bindView();
    this.bindLocate();

    const saved = readStore(AIRPORT_KEY, DEFAULT_AIRPORT);
    void this.chooseAirport(saved);
    void this.loadSurvey();
    void this.loadMilitary();
    void this.loadAirports();
    this.view = readStore(VIEW_KEY, 'select') === 'live' ? 'live' : 'select';
    this.showView(this.view);
    this.updateSteps();

    const notice = byId('notifyNote');
    if (notice && !('Notification' in window)) {
      notice.textContent =
        'This browser has no notification support. Departures will still appear on the board below.';
    }
  }

  /* ---------------------------------------------------------------- storing */

  private loadList(key: string): string[] {
    try {
      const raw = JSON.parse(readStore(key, '[]'));
      return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private loadBoard(): Departure[] {
    try {
      const raw = JSON.parse(readStore(BOARD_KEY, '[]'));
      if (!Array.isArray(raw)) return [];
      // A board that grows without limit is a slow page. The session is what
      // matters, and a hundred departures is more than one sitting.
      return (raw as Departure[]).slice(0, 100);
    } catch {
      return [];
    }
  }

  /**
   * The type rules, tolerantly. A rule with no `tails` array means "every
   * aircraft of this type", and a rule with an empty one means the same thing —
   * so a truncated or hand-edited store degrades to the wider rule rather than to
   * no rule at all, which is the safe direction to fail in.
   */
  private loadTypeRules(): TypeRule[] {
    try {
      const raw = JSON.parse(readStore(TYPES_KEY, '[]'));
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((rule) => rule && typeof rule.type === 'string' && rule.type.trim() !== '')
        .map((rule) => ({
          type: String(rule.type).trim().toUpperCase(),
          tails: Array.isArray(rule.tails) ? rule.tails.filter((tail: unknown) => typeof tail === 'string') : [],
        }));
    } catch {
      return [];
    }
  }

  private saveTypeRules(): void {
    writeStore(TYPES_KEY, JSON.stringify(this.typeRules));
    this.engine?.setTypeRules(this.typeRules);
  }

  private saveWatchlist(): void {
    writeStore(WATCH_KEY, JSON.stringify(this.watchlist));
    this.engine?.setWatchlist(this.watchlist);
  }

  private saveBoard(): void {
    writeStore(BOARD_KEY, JSON.stringify(this.board.slice(0, 100)));
  }

  /* ------------------------------------------------------------ the airport */

  private buildRadiusButtons(): void {
    const host = byId('radiusButtons');
    if (!host) return;
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
      button.setAttribute('aria-pressed', String(choice.km === this.radiusKm));
      button.addEventListener('click', () => {
        this.radiusKm = choice.km;
        for (const other of host.querySelectorAll('button')) {
          other.setAttribute('aria-pressed', String(other === button));
        }
        if (this.airport) void this.chooseAirport(this.airport.icao);
        track('distance_changed', { km: choice.km, nm: kmToNm(choice.km) });
      });
      host.appendChild(button);
    }
  }

  private buildTypeFilter(): void {
    const host = byId('typeFilter');
    if (!host) return;
    host.innerHTML = '';
    // 🔴 WARPLANES FIRST. George, 20 Sep 2026: *"war plans should be first
    // option"*. It is the one filter somebody arriving at this page is most
    // likely to be looking for — it is the whole reason the class was asked for —
    // so it leads, and "Everything" follows it as the default that is already on.
    const options: { key: AircraftClass | 'all'; label: string }[] = [
      { key: 'military', label: classLabel('military') },
      { key: 'all', label: 'Everything' },
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
  private setBusy(icao: string, on: boolean): void {
    for (const chip of document.querySelectorAll<HTMLElement>(`.chip[data-icao="${icao}"]`)) {
      if (on) chip.setAttribute('aria-busy', 'true');
      else chip.removeAttribute('aria-busy');
    }
  }

  private async chooseAirport(icao: string): Promise<void> {
    this.stop();
    this.setBusy(icao, true);
    this.setStatus(`Looking up ${icao}…`, 'working');
    try {
      const response = await fetch(`/api/0/airport/${encodeURIComponent(icao)}`, {
        headers: { accept: 'application/json' },
      });
      // Same order as the poll: a 429 arrives as an HTML page, so it is caught by
      // its status and never by trying to parse it.
      if (response.status === 429) {
        this.airport = null;
        this.setBusy(icao, false);
        this.setStatus('The feed asked us to slow down (HTTP 429) while looking that airport up. Try again in a moment.', 'error');
        return;
      }
      const payload = await readJson(response);
      if (!response.ok) throw new Error(`The feed answered ${response.status} for ${icao}.`);
      this.airport = parseAirport(icao, payload);
    } catch (error) {
      this.airport = null;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setBusy(icao, false);
      this.setStatus(this.lastError, 'error');
      return;
    }

    writeStore(AIRPORT_KEY, this.airport.icao);

    const title = byId('airportTitle');
    if (title) title.textContent = `${this.airport.name} (${this.airport.icao})`;
    const where = byId('airportWhere');
    if (where) {
      where.textContent =
        `${this.airport.location || '—'} · ${this.airport.lat.toFixed(4)}, ${this.airport.lon.toFixed(4)}` +
        (this.airport.elevationFt !== null ? ` · field elevation ${this.airport.elevationFt} ft` : '');
    }

    const fence = byId('fenceNote');
    if (fence) {
      const km = nmToKm(kmToNm(this.radiusKm));
      fence.textContent =
        `Looking ${this.radiusKm} km out from ${this.centre ? 'your own position' : 'the airport'} — ` +
        `${kmToNm(this.radiusKm)} nautical miles, which is the unit the feed takes. ` +
        (this.radiusKm <= 10
          ? 'A short distance is the best chance of catching an aircraft on the ground, and the least notice of anything else.'
          : this.radiusKm >= 50
            ? 'A long distance sees a great deal of traffic, and very little of it on the ground — the two pull in opposite directions.'
            : `Climb-out and approach both fall inside it, and about ${km} km is what most aircraft cover in the first minute after leaving.`);
    }

    const at = this.point() ?? { lat: this.airport.lat, lon: this.airport.lon };
    this.engine = new DetectionEngine(
      {
        lat: at.lat,
        lon: at.lon,
        radiusNm: kmToNm(this.radiusKm),
        now: Date.now(),
        staleAfterSec: DEFAULTS.staleAfterSec,
        cooldownMs: DEFAULTS.cooldownMs,
      },
      this.watchlist
    );
    this.engine.setTypeRules(this.typeRules);

    track('airport_chosen', { airport: this.airport.icao, km: this.radiusKm, nm: kmToNm(this.radiusKm) });
    this.setBusy(icao, false);
    await this.poll();
    this.updateSteps();
    this.timer = window.setInterval(() => void this.poll(), POLL_MS);
  }

  private stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /* -------------------------------------------------------------- the polls */

  private async poll(): Promise<void> {
    const at = this.point();
    if (!at || !this.engine) return;
    const url = `/api/v2/point/${at.lat}/${at.lon}/${kmToNm(this.radiusKm)}`;

    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });

      // 🔴 THE STATUS IS CHECKED *BEFORE* THE BODY IS READ, AND THAT ORDER IS THE
      // WHOLE FIX. Measured 20 Sep 2026: when the feed rate-limits it answers 429
      // with an HTML page, not JSON — `<title>429 Too Many Requests</title>` — so
      // parsing first threw a JSON error and the reader was told *"the feed
      // answered 429 with text/html instead of JSON, that is a web page"*, which
      // is true and useless: it names the symptom and hides the cause. A rate
      // limit is a rate limit whether or not the body parses.
      if (response.status === 429) {
        this.lastError = 'the feed is rate-limiting us';
        this.setStatus(
          'The feed asked us to slow down (HTTP 429). It is volunteer-funded and answers a limited number of ' +
            'requests per minute, and this page asks again every ten seconds. Nothing is wrong with the site — ' +
            'the aircraft table below is simply holding the last reading it managed to get.',
          'error'
        );
        return;
      }

      const payload = (await readJson(response)) as FeedResponse;
      if (!response.ok) throw new Error(`The feed answered ${response.status}.`);

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
        if (!type || type === '-' || type.length > 6) continue;
        this.liveTypes.set(type, (this.liveTypes.get(type) ?? 0) + 1);
      }
      if (this.liveTypes.size !== before) this.renderTypeList();

      const departures = this.engine.ingest(readings, Date.now());

      this.polls += 1;
      this.lastPollAt = Date.now();
      this.lastError = '';

      if (departures.length > 0) this.recordDepartures(departures);
      this.renderAircraft();
      this.renderLive();
      this.setStatus(
        `${readings.length} aircraft in the fence · poll ${this.polls} · last ${formatClock(this.lastPollAt)}`,
        'ok'
      );
    } catch (error) {
      // The page keeps the last good picture and says what went wrong, rather
      // than emptying the table and looking like nothing is there.
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setStatus(`Feed problem: ${this.lastError}`, 'error');
    }
  }

  private recordDepartures(departures: Departure[]): void {
    for (const departure of departures) {
      this.board.unshift(departure);
      if (departure.watched) this.notify(departure);
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

  private setStatus(text: string, kind: 'ok' | 'error' | 'working'): void {
    const node = byId('status');
    if (!node) return;
    node.textContent = text;
    node.dataset.kind = kind;
  }

  private renderAircraft(): void {
    const body = byId('aircraftBody');
    if (!body || !this.engine) return;
    const rows = this.engine.snapshot().slice(0, 40);

    if (rows.length === 0) {
      body.innerHTML =
        '<tr><td colspan="6" class="muted">Nothing in the fence at this moment. Aircraft appear and disappear as they pass.</td></tr>';
      return;
    }

    body.innerHTML = rows
      .map((state) => {
        const label = state.callsign || state.registration || state.hex;
        const info = describeType(state.type);
        const phase =
          state.phase === 'ground'
            ? '<span class="tag tag-ground">on the ground</span>'
            : state.phase === 'airborne'
              ? '<span class="tag tag-air">airborne</span>'
              : '<span class="tag tag-unknown">no altitude</span>';
        return (
          `<tr${state.watched ? ' class="watched-row"' : ''}>` +
          `<td class="mono">${escapeHtml(state.hex)}</td>` +
          `<td><b>${escapeHtml(label)}</b></td>` +
          `<td class="mono" title="${escapeHtml(info.name)}">${escapeHtml(state.type || '—')}</td>` +
          `<td>${phase}</td>` +
          `<td class="mono">${formatClock(state.observedAt)}</td>` +
          `<td><button type="button" class="linkish watch-toggle" data-key="${escapeHtml(label)}" ` +
          `data-type="${escapeHtml(state.type || '')}" ` +
          `data-ga="watch">${state.watched ? 'unwatch' : 'watch'}</button></td>` +
          '</tr>'
        );
      })
      .join('');

    for (const button of body.querySelectorAll<HTMLButtonElement>('.watch-toggle')) {
      button.addEventListener('click', () => {
        const key = button.dataset.key ?? '';
        if (this.watchlist.some((item) => normaliseKey(item) === normaliseKey(key))) {
          this.removeWatch(key);
        } else {
          this.addWatch(key);
        }
      });
    }
  }

  private renderBoard(): void {
    const list = byId('departures');
    const empty = byId('departuresEmpty');
    if (!list || !empty) return;

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
        return (
          `<li class="departure${departure.watched ? ' departure-watched' : ''}">` +
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
          '</li>'
        );
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
  private async loadSurvey(): Promise<void> {
    const note = byId('typeNote');
    try {
      const response = await fetch('/types.json', { headers: { accept: 'application/json' } });
      this.survey = (await readJson(response)) as TypesDocument;
    } catch (error) {
      this.survey = null;
      if (note) {
        note.textContent =
          'The measured type list could not be read, so this shows only the types seen in this session. ' +
          (error instanceof Error ? error.message : '');
      }
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
    this.renderTypeList();
  }

  /** The survey's types, with anything newer that this session saw merged in. */
  private combinedTypes(): {
    code: string;
    seen: number;
    airports: string[];
    operators: string[];
    registrations: { reg: string; airports: string[] }[];
  }[] {
    type Row = ReturnType<Page['combinedTypes']>[number];
    const rows = new Map<string, Row>();
    for (const row of this.survey?.types ?? []) {
      rows.set(row.code, {
        code: row.code,
        seen: row.seen,
        airports: [...(row.airports ?? [])],
        operators: [...(row.operators ?? [])],
        registrations: [...(row.registrations ?? [])],
      });
    }
    for (const [code, seen] of this.liveTypes) {
      const existing = rows.get(code);
      // A type this session saw but the survey never did has no measured tail
      // numbers, and is given none rather than an invented list.
      if (existing) existing.seen += seen;
      else rows.set(code, { code, seen, airports: [], operators: [], registrations: [] });
    }
    // 🔴 ALPHABETICAL BY NAME, NOT BY HOW OFTEN IT WAS SEEN. George, 20 Sep 2026:
    // *"maybe list the airplane types in alpha order"*. The sighting count is
    // still shown on every row, so nothing is hidden by the change — the list
    // just stops reshuffling itself as the page watches, which made it
    // impossible to go back to a type you had seen a moment ago.
    return [...rows.values()].sort((a, b) =>
      describeType(a.code).name.localeCompare(describeType(b.code).name) || a.code.localeCompare(b.code)
    );
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
  private point(): { lat: number; lon: number } | null {
    if (this.centre) return this.centre;
    if (this.airport) return { lat: this.airport.lat, lon: this.airport.lon };
    return null;
  }

  /** Re-aim the fence and start polling again — used when the reader moves. */
  private rearm(): void {
    const at = this.point();
    if (!at) return;
    this.engine = new DetectionEngine(
      {
        lat: at.lat,
        lon: at.lon,
        radiusNm: kmToNm(this.radiusKm),
        now: Date.now(),
        staleAfterSec: DEFAULTS.staleAfterSec,
        cooldownMs: DEFAULTS.cooldownMs,
      },
      this.watchlist
    );
    this.engine.setTypeRules(this.typeRules);
    this.stop();
    void this.poll();
    this.timer = window.setInterval(() => void this.poll(), POLL_MS);
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
  private updateSteps(): void {
    const place = this.airport !== null || this.centre !== null;
    const picked = this.typeRules.length > 0 || this.watchlist.length > 0;

    for (const section of document.querySelectorAll<HTMLElement>('.step-gated')) {
      const step = section.dataset.step ?? '';

      // 🔴 SHOWN, EXPLAINED, INERT — NOT HIDDEN. George, 20 Sep 2026: *"maybe make
      // it visible just put note to select airport first"*. A page that hides what
      // is coming reads as broken; a page that shows it with the reason reads as
      // waiting. So these stay on the page, dimmed, with their note, and every
      // control inside them disabled until the page knows where the reader is.
      if (step === '2' || step === '3' || step === '5') {
        section.hidden = false;
        section.dataset.waiting = String(!place);
        const why = section.querySelector<HTMLElement>('.step-why');
        if (why) why.hidden = place;
        for (const control of section.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) {
          control.disabled = !place;
        }
        continue;
      }

      // The two that would be empty shells still arrive with the glide.
      const show = step === '4' || step === '6' ? picked : place;
      if (show && section.hidden) {
        section.hidden = false;
        section.classList.add('step-arrive');
        window.setTimeout(() => section.classList.remove('step-arrive'), 900);
      } else if (!show && !section.hidden) {
        section.hidden = true;
      }
    }

    const bar = document.querySelector('.viewbar');
    if (bar instanceof HTMLElement) bar.hidden = !place;
  }

  private async loadMilitary(): Promise<void> {
    try {
      const response = await fetch('/military.json', { headers: { accept: 'application/json' } });
      const doc = (await readJson(response)) as { codes?: { code: string }[]; note?: string };
      for (const row of doc.codes ?? []) this.militaryCodes.add(String(row.code).toUpperCase());
    } catch {
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
  private klassOf(code: string): AircraftClass {
    const known = describeType(code).klass;
    if (isCivilClass(known)) return known;
    if (this.militaryCodes.has(code.trim().toUpperCase())) return 'military';
    return known;
  }

  private renderTypeList(): void {
    const host = byId('typeList');
    if (!host) return;

    const rows = this.combinedTypes().filter((row) => {
      if (this.typeFilter === 'all') return true;
      return this.klassOf(row.code) === this.typeFilter;
    });

    // 🔴 THE AIRCRAFT A SURVEY CAN NEVER SEE. Hamilton's Lancaster flies a handful
    // of times a year, so a list built from one afternoon of sightings will always
    // miss exactly the aircraft a person most wants to watch. Curated from the
    // operator's own record and labelled as curated, never mixed into a count.
    const curated =
      this.typeFilter === 'all' || this.typeFilter === 'military' || this.typeFilter === 'other'
        ? (RESIDENTS[this.airport?.icao ?? ''] ?? [])
        : [];

    if (rows.length === 0 && curated.length === 0) {
      host.innerHTML =
        '<p class="muted small">Nothing in this group yet. Change the filter, or wait for the page to see something.</p>';
      return;
    }

    const maxima = Math.max(...rows.map((row) => row.seen), 1);

    const curatedHtml = curated
      .map((resident) => {
        const keys = [resident.registration, ...(resident.alsoMatch ?? [])];
        const code = (resident.typeCode ?? '').toUpperCase();
        const already =
          keys.some((key) => this.watchlist.some((item) => normaliseKey(item) === normaliseKey(key))) ||
          (code !== '' && this.typeRules.some((rule) => normaliseKey(rule.type) === code));
        return (
          `<div class="typerow typerow-curated${already ? ' typerow-on' : ''}">` +
          `<div class="typerow-thumb" aria-hidden="true">${thumbSvg(code || 'ZZZZ', 'military')}</div>` +
          `<div class="typerow-main">` +
          `<b>${escapeHtml(resident.name)}</b> ` +
          `<span class="mono muted">${escapeHtml(code || resident.registration)}</span> ` +
          `<span class="mono muted">${escapeHtml(resident.registration)}</span> ` +
          `<span class="tag tag-curated">based here · listed by hand</span>` +
          '</div>' +
          `<div class="typerow-actions">` +
          `<button type="button" class="star resident-toggle" ` +
          `data-reg="${escapeHtml(resident.registration)}" data-also="${escapeHtml(keys.slice(1).join(','))}" ` +
          `data-type="${escapeHtml(code)}" aria-pressed="${already}" ` +
          `title="${already ? 'Favourited — remove' : 'Favourite this aircraft'}" ` +
          `aria-label="${already ? 'Favourited — remove' : 'Favourite this aircraft'}" ` +
          `data-ga="resident-favourite">` +
          `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg></button>` +
          '</div>' +
          `<p class="small muted typerow-meta">${escapeHtml(resident.note)}</p>` +
          '</div>'
        );
      })
      .join('');

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

        // 🔴 CHIPS IN THE CARD, NOTHING BEHIND A BUTTON. George, 20 Sep 2026: *"i
        // dont want the button choose tail numbers, list the tail numbers as chips
        // in the car they can highlight"*.
        const tailChips =
          tails.length === 0
            ? ''
            : '<div class="tail-chips">' +
              tails
                .map((item) => {
                  const on = chosen.has(normaliseKey(item.reg));
                  // 🔴 A LITTLE STAR ON THE ONES YOU PICKED. George, 20 Sep 2026:
                  // *"if i select tail number also add a little star in their
                  // button"* — so the choice is visible as a mark and not only as a
                  // border colour, which at this size is easy to miss.
                  return (
                    `<button type="button" class="tail-chip" data-type="${escapeHtml(row.code)}" ` +
                    `data-tail="${escapeHtml(item.reg)}" aria-pressed="${on}" ` +
                    `title="${on ? 'Watching only this one' : 'Watch only this one'}" ` +
                    `data-ga="tail-chip">${on ? TAIL_STAR : ''}${escapeHtml(item.reg)}</button>`
                  );
                })
                .join('') +
              '</div>';

        const tailNote =
          tails.length === 0
            ? ''
            : `<p class="small muted tail-note">${
                chosen.size > 0
                  ? 'Only the highlighted ones are watched — highlighting a tail number <b>un-favourites the whole type</b>. Press a highlighted one again, or press the button, to go back to all of them.'
                  : 'Press any of these to watch that aeroplane instead of the whole type. Every tail number here is one that actually transmitted its registration — many transponders never send one, so this is a sample of what identifies itself and not a fleet list.'
              }</p>`;

        return (
          `<div class="typerow${already ? ' typerow-on' : ''}">` +
          `<div class="typerow-thumb" aria-hidden="true">${thumbSvg(row.code, klass)}</div>` +
          `<div class="typerow-main">` +
          `<b>${escapeHtml(info.name)}</b> <span class="mono muted">${escapeHtml(row.code)}</span> ` +
          `<span class="tag">${escapeHtml(classLabel(klass))}</span>` +
          '</div>' +
          `<div class="typerow-actions">` +
          starButton(row.code, wholeType, already && !wholeType) +
          '</div>' +
          `<div class="typerow-meta">` +
          `<span class="typerow-bar" aria-hidden="true"><i style="width:${width}%"></i></span>` +
          `<span class="small muted">${row.seen} sighting${row.seen === 1 ? '' : 's'}` +
          (row.operators.length > 0 ? ` · ${escapeHtml(row.operators.slice(0, 4).join(' '))}` : '') +
          (row.airports.length > 1 ? ` · ${row.airports.length} airports` : row.airports.length === 1 ? ` · ${escapeHtml(row.airports[0])}` : '') +
          `</span></div>` +
          tailChips +
          tailNote +
          '</div>'
        );
      })
      .join('');

    host.innerHTML = curatedHtml + measuredHtml;

    for (const button of host.querySelectorAll<HTMLButtonElement>('.type-toggle')) {
      button.addEventListener('click', () => {
        const code = button.dataset.type ?? '';
        const rule = this.typeRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(code));
        if (!rule) {
          // New rules start WIDE — tails empty means every aircraft of the type.
          this.typeRules.push({ type: code, tails: [] });
          track('type_favourited', { code, total: this.typeRules.length });
        } else if (rule.tails.length > 0) {
          // Nothing narrowed any more: the whole type is favourited again.
          rule.tails = [];
          track('type_widened', { code });
        } else {
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
    for (const chip of host.querySelectorAll<HTMLButtonElement>('.tail-chip')) {
      chip.addEventListener('click', () => {
        const code = chip.dataset.type ?? '';
        const tail = chip.dataset.tail ?? '';
        let rule = this.typeRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(code));
        if (!rule) {
          rule = { type: code, tails: [] };
          this.typeRules.push(rule);
        }
        const on = rule.tails.some((item) => normaliseKey(item) === normaliseKey(tail));
        if (on) rule.tails = rule.tails.filter((item) => normaliseKey(item) !== normaliseKey(tail));
        else rule.tails.push(tail);
        this.saveTypeRules();
        this.renderWatchlist();
        this.renderTypeList();
        track('tail_highlighted', { code, highlighted: !on, tails: rule.tails.length });
      });
    }

    for (const button of host.querySelectorAll<HTMLButtonElement>('.resident-toggle')) {
      button.addEventListener('click', () => {
        const keys = [button.dataset.reg ?? '', ...(button.dataset.also ?? '').split(',')].filter(Boolean);
        const code = (button.dataset.type ?? '').trim();
        const watching =
          keys.some((key) => this.watchlist.some((item) => normaliseKey(item) === normaliseKey(key))) ||
          (code !== '' && this.typeRules.some((rule) => normaliseKey(rule.type) === normaliseKey(code)));
        if (watching) {
          this.watchlist = this.watchlist.filter(
            (item) => !keys.some((key) => normaliseKey(item) === normaliseKey(key))
          );
          if (code) {
            this.typeRules = this.typeRules.filter((rule) => normaliseKey(rule.type) !== normaliseKey(code));
            this.saveTypeRules();
          }
        } else {
          // 🔴 BOTH KEYS, ON PURPOSE. The registration catches the aeroplane when it
          // is painted with that registration; the type code catches it whichever
          // markings it wears that week — and the museum's Lancaster is painted
          // RCAF KB726, not C-GVRA. Watching only one would watch the aeroplane on
          // some days and not others.
          for (const key of keys) {
            if (!this.watchlist.some((item) => normaliseKey(item) === normaliseKey(key))) this.watchlist.push(key);
          }
          if (code && !this.typeRules.some((rule) => normaliseKey(rule.type) === normaliseKey(code))) {
            this.typeRules.push({ type: code, tails: [] });
            this.saveTypeRules();
          }
          track('resident_favourited', { reg: button.dataset.reg ?? '', type: code });
        }
        this.saveWatchlist();
        this.renderWatchlist();
        this.renderTypeList();
      });
    }

    // The star buttons are rebuilt above, so the waiting gate is re-applied here
    // or a fresh poll would hand back buttons that are enabled too early.
    this.updateSteps();
  }

  private renderWatchlist(): void {
    const host = byId('watchList');
    if (!host) return;

    if (this.typeRules.length === 0 && this.watchlist.length === 0) {
      host.innerHTML =
        '<li class="muted">Nothing watched yet. Pick a type above, press <b>watch</b> on an aircraft in the ' +
        'live list, or type a tail number.</li>';
      return;
    }

    const typeItems = this.typeRules
      .map((rule) => {
        const info = describeType(rule.type);
        const narrowed = rule.tails.length > 0;
        const tails = rule.tails
          .map(
            (tail) =>
              `<span class="tail"><span class="mono">${escapeHtml(tail)}</span> ` +
              `<button type="button" class="linkish tail-remove" data-type="${escapeHtml(rule.type)}" ` +
              `data-tail="${escapeHtml(tail)}" data-ga="tail-remove">×</button></span>`
          )
          .join(' ');
        return (
          `<li class="watch-type">` +
          `<div class="watch-type-head">` +
          `<span><b>${escapeHtml(info.name)}</b> <span class="mono muted">${escapeHtml(rule.type)}</span> — ` +
          `<b>${narrowed ? `${rule.tails.length} tail number${rule.tails.length === 1 ? '' : 's'}` : 'every one of them'}</b></span>` +
          `<button type="button" class="linkish type-remove" data-type="${escapeHtml(rule.type)}" ` +
          `data-ga="type-unwatch">stop watching</button>` +
          '</div>' +
          `<div class="watch-type-tails">${narrowed ? tails : '<span class="muted small">No tail numbers — every aircraft of this type is watched.</span>'}</div>` +
          `<form class="tail-form" data-type="${escapeHtml(rule.type)}" autocomplete="off">` +
          `<input type="text" name="tail" placeholder="Narrow to a tail number — C-GXXX" spellcheck="false" />` +
          `<button class="ghost chip-small" type="submit">Add</button>` +
          '</form>' +
          '</li>'
        );
      })
      .join('');

    const namedItems = this.watchlist
      .map(
        (item) =>
          `<li><span class="mono">${escapeHtml(item)}</span> ` +
          `<button type="button" class="linkish watch-remove" data-key="${escapeHtml(item)}" ` +
          `data-ga="unwatch">remove</button></li>`
      )
      .join('');

    host.innerHTML = typeItems + namedItems;

    for (const button of host.querySelectorAll<HTMLButtonElement>('.type-remove')) {
      button.addEventListener('click', () => {
        const code = button.dataset.type ?? '';
        this.typeRules = this.typeRules.filter((rule) => normaliseKey(rule.type) !== normaliseKey(code));
        this.saveTypeRules();
        this.renderWatchlist();
        this.renderTypeList();
      });
    }

    for (const button of host.querySelectorAll<HTMLButtonElement>('.tail-remove')) {
      button.addEventListener('click', () => {
        const code = button.dataset.type ?? '';
        const tail = button.dataset.tail ?? '';
        const rule = this.typeRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(code));
        if (!rule) return;
        rule.tails = rule.tails.filter((item) => normaliseKey(item) !== normaliseKey(tail));
        this.saveTypeRules();
        this.renderWatchlist();
      });
    }

    for (const form of host.querySelectorAll<HTMLFormElement>('.tail-form')) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const input = form.querySelector<HTMLInputElement>('input[name="tail"]');
        const value = input?.value.trim() ?? '';
        if (!value) return;
        const code = form.dataset.type ?? '';
        const rule = this.typeRules.find((candidate) => normaliseKey(candidate.type) === normaliseKey(code));
        if (!rule) return;
        if (!rule.tails.some((item) => normaliseKey(item) === normaliseKey(value))) rule.tails.push(value);
        this.saveTypeRules();
        this.renderWatchlist();
        track('tail_narrowed', { code, tails: rule.tails.length });
      });
    }

    for (const button of host.querySelectorAll<HTMLButtonElement>('.watch-remove')) {
      button.addEventListener('click', () => this.removeWatch(button.dataset.key ?? ''));
    }

    this.updateSteps();
  }

  private renderWatchButton(): void {
    const button = byId('notifyBtn');
    const note = byId('notifyNote');
    if (!button || !note) return;
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

  private bindNotify(): void {
    const button = byId('notifyBtn');
    if (!button) return;
    button.addEventListener('click', async () => {
      if (!('Notification' in window)) return;
      try {
        await Notification.requestPermission();
      } catch {
        /* older Safari takes a callback instead of a promise */
      }
      this.renderWatchButton();
      track('notifications_asked', { permission: Notification.permission });
    });
  }

  private notify(departure: Departure): void {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const label = departure.callsign || departure.registration || departure.hex;
    const climb = departure.climbFpm !== null ? `, ${departure.climbFpm} ft/min` : '';
    try {
      new Notification(`${label} has left ${this.airport?.icao ?? 'the airport'}`, {
        body:
          `${departure.verdict === 'confirmed' ? 'It was on the ground and it is not now' : 'It was first seen already climbing'}` +
          ` — ${departure.altitudeFt ?? '?'} ft${climb}, ${Math.round(nmToKm(departure.distanceNm))} km out.`,
        tag: departure.hex,
      });
    } catch {
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
  private async loadAirports(): Promise<void> {
    const note = byId('nearbyNote');
    try {
      const response = await fetch('/airports.json', { headers: { accept: 'application/json' } });
      this.listedAirports = (await readJson(response)) as AirportsDocument;
    } catch (error) {
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
        (dropped.length > 0
          ? `${dropped.length} identifier was dropped because the feed could not place it: ${dropped.join(', ')}.`
          : 'Nothing was dropped.');
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
  private renderMap(): void {
    const host = byId('locMap');
    if (!host) return;
    const at = this.centre;
    if (!at || this.nearby.length === 0) {
      host.innerHTML = '';
      return;
    }

    const size = 340;
    const middle = size / 2;
    const radius = middle - 32;
    const near = this.nearby.slice(0, 10);
    const maxKm = Math.max(this.radiusKm, ...near.map((row) => row.km));
    const toPx = (km: number): number => (km / maxKm) * radius;

    const place = (lat: number, lon: number): { x: number; y: number; km: number } => {
      const km = nmToKm(distanceNm(at.lat, at.lon, lat, lon));
      const rad = (bearingDeg(at.lat, at.lon, lat, lon) * Math.PI) / 180;
      return { x: middle + Math.sin(rad) * toPx(km), y: middle - Math.cos(rad) * toPx(km), km };
    };

    let svg =
      `<svg class="locmap" viewBox="0 0 ${size} ${size}" role="img" ` +
      `aria-label="A ${this.radiusKm} kilometre circle around your position, with the nearest airports marked with their codes">`;

    for (const ring of [maxKm / 2, maxKm]) {
      svg += `<circle class="locmap-ring" cx="${middle}" cy="${middle}" r="${toPx(ring).toFixed(1)}" />`;
      svg +=
        `<text class="locmap-small" x="${(middle + 4).toFixed(1)}" ` +
        `y="${(middle - toPx(ring) + 12).toFixed(1)}">${Math.round(ring)} km</text>`;
    }

    // The reader, at the middle, because everything here is measured from them.
    svg += `<circle class="locmap-you" cx="${middle}" cy="${middle}" r="4.5" />`;
    svg += `<text class="locmap-small" x="${middle}" y="${middle + 17}" text-anchor="middle">you</text>`;

    for (const row of near) {
      const spot = place(row.airport.lat, row.airport.lon);
      const chosenAirport = row.airport.icao === this.airport?.icao;
      svg +=
        `<line class="locmap-line" x1="${middle}" y1="${middle}" ` +
        `x2="${spot.x.toFixed(1)}" y2="${spot.y.toFixed(1)}" />`;
      svg +=
        `<circle class="locmap-airport" cx="${spot.x.toFixed(1)}" cy="${spot.y.toFixed(1)}" ` +
        `r="${chosenAirport ? 5 : 3.2}" />`;
      svg +=
        `<text class="locmap-label" x="${(spot.x + 7).toFixed(1)}" ` +
        `y="${(spot.y + 3.5).toFixed(1)}">${escapeHtml(row.airport.icao)}</text>`;
    }

    svg += '</svg>';
    svg +=
      '<p class="small muted locmap-note">You, at the middle, and the ' +
      `${this.radiusKm} km circle this page is watching. The nearest ten airports are marked with their codes, and ` +
      'the one you picked is drawn larger. It is drawn rather than embedded: an embedded map is an API key, a ' +
      'billing account, and a request to Google from every visitor before they have answered the cookie question.</p>';
    host.innerHTML = svg;
  }

  private renderNearby(): void {
    const host = byId('nearbyList');
    if (!host || !this.listedAirports) return;
    if (this.nearby.length === 0) {
      host.innerHTML =
        '<p class="muted small">Press <b>find airports near me</b> and this list is ordered by how far each one is ' +
        'from where you are.</p>';
      return;
    }
    host.innerHTML = this.nearby
      .slice(0, 14)
      .map(
        ({ airport, km }) =>
          `<button type="button" class="ghost chip near-chip" data-icao="${escapeHtml(airport.icao)}" data-ga="airport-near">` +
          `<span class="mono">${escapeHtml(airport.icao)}</span> ${escapeHtml(airport.location || airport.name)}` +
          `<span class="near-km">${Math.round(km)} km</span></button>`
      )
      .join('');
    for (const button of host.querySelectorAll<HTMLButtonElement>('.near-chip')) {
      button.addEventListener('click', () => void this.chooseAirport(button.dataset.icao ?? ''));
    }
    this.renderMap();
  }

  private computeNearby(lat: number, lon: number): void {
    const list = this.listedAirports?.airports ?? [];
    if (list.length === 0) return;
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
    this.renderNearby();
    if (this.airport) this.rearm();
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
  private bindPostal(): void {
    const form = byId<HTMLFormElement>('postalForm');
    const input = byId<HTMLInputElement>('postalInput');
    const note = byId('postalNote');
    if (!form || !input) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      if (note) note.textContent = `Looking up ${value.toUpperCase()}…`;
      try {
        const response = await fetch(`/api/geo/postal/${encodeURIComponent(value)}`, {
          headers: { accept: 'application/json' },
        });
        const body = (await readJson(response)) as {
          ok?: boolean;
          error?: string;
          place?: string;
          region?: string;
          country?: string;
          lat?: number;
          lon?: number;
          note?: string;
        };
        if (!body.ok || typeof body.lat !== 'number' || typeof body.lon !== 'number') {
          if (note) note.textContent = body.error ?? 'That code could not be looked up.';
          return;
        }
        this.computeNearby(body.lat, body.lon);
        if (note) {
          note.textContent =
            `${body.place}, ${body.region} — airports below are listed by distance from there. ${body.note ?? ''}`.trim();
        }
        track('postal_located', { count: this.nearby.length });
      } catch (error) {
        if (note) {
          note.textContent =
            'The postal code could not be looked up. ' +
            (error instanceof Error ? error.message : '') +
            ' Pick an airport by name instead — nothing else on the page depends on this.';
        }
      }
    });
  }

  private bindLocate(): void {
    this.bindPostal();
    const button = byId<HTMLButtonElement>('locateBtn');
    const note = byId('locateNote');
    if (!button) return;
    button.addEventListener('click', () => {
      if (!('geolocation' in navigator)) {
        if (note) note.textContent = 'This browser cannot report a position. Pick an airport by name instead.';
        return;
      }
      button.disabled = true;
      if (note) note.textContent = 'Asking your browser where you are…';
      track('locate_asked', {});
      navigator.geolocation.getCurrentPosition(
        (position) => {
          button.disabled = false;
          this.computeNearby(position.coords.latitude, position.coords.longitude);
          if (note) {
            note.textContent =
              'Ordered by distance from your position. Your coordinates are used inside this page and are not sent ' +
              'anywhere — the feed is only ever told which airport you chose.';
          }
        },
        (error) => {
          button.disabled = false;
          if (note) {
            note.textContent =
              `Your browser did not give a position (${error.message}). Pick an airport by name below instead — ` +
              'nothing else on the page depends on knowing where you are.';
          }
        },
        { timeout: 10_000, maximumAge: 300_000 }
      );
    });
  }

  /* --------------------------------------------------------- the live view */

  private bindView(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.view-switch')) {
      button.addEventListener('click', () => {
        this.showView(button.dataset.view === 'live' ? 'live' : 'select');
        track('view_switched', { view: this.view });
      });
    }
  }

  private showView(view: 'select' | 'live'): void {
    this.view = view;
    writeStore(VIEW_KEY, view);
    const select = byId('selectView');
    const live = byId('liveView');
    if (select) select.hidden = view !== 'select';
    if (live) live.hidden = view !== 'live';
    for (const button of document.querySelectorAll<HTMLButtonElement>('.view-switch')) {
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
    }
    if (view === 'live') this.renderLive();
  }

  /**
   * Aircraft matching the selection that are in the air at this moment.
   *
   * This is deliberately NOT the departures board. The board is a record of what
   * has already left; this is a picture of what is up there now, so a person can
   * look up at a contrail and find it. Both are read from the same poll, so the
   * chart and the table can never disagree about the same aircraft.
   */
  private matchedAirborne(): LiveAircraft[] {
    const at = this.point();
    if (!this.engine || !this.airport || !at) return [];
    const out: LiveAircraft[] = [];
    for (const reading of this.lastReadings) {
      if (typeof reading.lat !== 'number' || typeof reading.lon !== 'number') continue;
      // On the ground is not in the air. The string 'ground' is how the feed
      // says it, and it is a string rather than a number — see detect.ts.
      if (reading.alt_baro === 'ground') continue;
      const match = this.engine.matchOf(reading);
      if (!match) continue;
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

  private renderLive(): void {
    const chart = byId('liveChart');
    const body = byId('liveBody');
    const empty = byId('liveEmpty');
    const summary = byId('liveSummary');
    if (!chart || !body || !empty) return;

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
    const toPx = (km: number): number => (km / maxKm) * radius;

    let svg = `<svg viewBox="0 0 ${size} ${size}" class="radar" role="img" aria-label="Aircraft in the air, drawn by direction and distance from ${escapeHtml(this.airport?.icao ?? 'the airport')}">`;
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
    ] as const) {
      const rad = (deg * Math.PI) / 180;
      svg += `<text x="${(centre + Math.sin(rad) * (radius + 12)).toFixed(1)}" y="${(centre - Math.cos(rad) * (radius + 12) + 4).toFixed(1)}" class="radar-compass" text-anchor="middle">${name}</text>`;
    }
    svg += `<circle cx="${centre}" cy="${centre}" r="3" class="radar-field" />`;
    svg += `<text x="${centre}" y="${centre + 16}" class="radar-label" text-anchor="middle">${escapeHtml(this.airport?.icao ?? '')}</text>`;
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
        const climb =
          row.climbFpm === null
            ? '—'
            : `${row.climbFpm > 0 ? '+' : ''}${row.climbFpm} ft/min`;
        return (
          '<tr>' +
          `<td><b>${escapeHtml(row.label)}</b>${row.tail && row.tail !== row.label ? ` <span class="mono muted small">${escapeHtml(row.tail)}</span>` : ''}</td>` +
          `<td title="${escapeHtml(info.name)}">${escapeHtml(info.name)}</td>` +
          `<td class="mono">${row.altitudeFt === null ? '—' : `${row.altitudeFt.toLocaleString()} ft`}</td>` +
          `<td class="mono">${escapeHtml(climb)}</td>` +
          `<td class="mono">${Math.round(row.km)} km ${compassPoint(row.bearingDeg)}</td>` +
          `<td class="small muted">${escapeHtml(row.matchedBy)}</td>` +
          '</tr>'
        );
      })
      .join('');
  }

  /* ------------------------------------------------------------- watchlist */

  private bindWatchForm(): void {
    const form = byId<HTMLFormElement>('watchForm');
    const input = byId<HTMLInputElement>('watchInput');
    if (!form || !input) return;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      this.addWatch(value);
      input.value = '';
    });
  }

  private addWatch(key: string): void {
    const value = key.trim();
    if (!value) return;
    if (this.watchlist.some((item) => normaliseKey(item) === normaliseKey(value))) return;
    this.watchlist.push(value);
    this.saveWatchlist();
    this.renderWatchlist();
    this.renderAircraft();
    track('aircraft_watched', { total: this.watchlist.length });
  }

  private removeWatch(key: string): void {
    this.watchlist = this.watchlist.filter((item) => normaliseKey(item) !== normaliseKey(key));
    this.saveWatchlist();
    this.renderWatchlist();
    this.renderAircraft();
  }
}

const page = new Page();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => page.start());
} else {
  page.start();
}
