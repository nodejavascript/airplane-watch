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
  AIRPORTS,
  DEFAULT_AIRPORT,
  parseAirport,
  type ResolvedAirport,
} from './airports.js';
import {
  DEFAULTS,
  DetectionEngine,
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
  knownTypeCount,
  type AircraftClass,
} from './typeinfo.js';

const WATCH_KEY = 'aircraft_watchlist';
const TYPES_KEY = 'aircraft_types';
const BOARD_KEY = 'aircraft_departures';
const AIRPORT_KEY = 'aircraft_airport';
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
}

interface TypesDocument {
  generated: string;
  method: string;
  aircraftInspected: number;
  counted: string;
  roundsRefusedByRateLimit?: number;
  types: SurveyedType[];
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
  /** Types the feed showed in THIS session, which may be newer than the survey. */
  private liveTypes = new Map<string, number>();
  private typeFilter: AircraftClass | 'all' = 'all';

  start(): void {
    this.watchlist = this.loadList(WATCH_KEY);
    this.typeRules = this.loadTypeRules();
    this.board = this.loadBoard();
    this.buildAirportButtons();
    this.buildRadiusButtons();
    this.buildTypeFilter();
    this.renderWatchlist();
    this.renderBoard();
    this.bindWatchForm();
    this.bindNotify();
    this.renderWatchButton();

    const saved = readStore(AIRPORT_KEY, DEFAULT_AIRPORT);
    void this.chooseAirport(saved);
    void this.loadSurvey();

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

  private buildAirportButtons(): void {
    const host = byId('airportButtons');
    if (!host) return;
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
    const options: { key: AircraftClass | 'all'; label: string }[] = [
      { key: 'all', label: 'Everything' },
      ...CLASS_ORDER.filter((klass) => klass !== 'other').map((klass) => ({
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

  private async chooseAirport(icao: string): Promise<void> {
    this.stop();
    this.setStatus(`Looking up ${icao}…`, 'working');
    try {
      const response = await fetch(`/api/0/airport/${encodeURIComponent(icao)}`, {
        headers: { accept: 'application/json' },
      });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(`The feed answered ${response.status} for ${icao}.`);
      this.airport = parseAirport(icao, payload);
    } catch (error) {
      this.airport = null;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setStatus(this.lastError, 'error');
      return;
    }

    writeStore(AIRPORT_KEY, this.airport.icao);
    for (const button of document.querySelectorAll<HTMLButtonElement>('#airportButtons .chip')) {
      button.setAttribute('aria-pressed', String(button.dataset.icao === this.airport.icao));
    }

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
        `Looking ${this.radiusKm} km out — ${kmToNm(this.radiusKm)} nautical miles, which is the unit the feed takes. ` +
        (this.radiusKm <= 10
          ? 'A short distance is the best chance of catching an aircraft on the ground, and the least notice of anything else.'
          : this.radiusKm >= 50
            ? 'A long distance sees a great deal of traffic, and very little of it on the ground — the two pull in opposite directions.'
            : `Climb-out and approach both fall inside it, and about ${km} km is what most aircraft cover in the first minute after leaving.`);
    }

    this.engine = new DetectionEngine(
      {
        lat: this.airport.lat,
        lon: this.airport.lon,
        radiusNm: kmToNm(this.radiusKm),
        now: Date.now(),
        staleAfterSec: DEFAULTS.staleAfterSec,
        cooldownMs: DEFAULTS.cooldownMs,
      },
      this.watchlist
    );
    this.engine.setTypeRules(this.typeRules);

    track('airport_chosen', { airport: this.airport.icao, km: this.radiusKm, nm: kmToNm(this.radiusKm) });
    await this.poll();
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
    if (!this.airport || !this.engine) return;
    const url =
      `/api/v2/point/${this.airport.lat}/${this.airport.lon}/${kmToNm(this.radiusKm)}`;

    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      const payload = (await readJson(response)) as FeedResponse;
      // 🔴 A 429 IS THE FEED ASKING US TO SLOW DOWN, AND THE PAGE SAYS SO.
      // Measured 20 Sep 2026: seven airports polled back to back had five refused
      // by the third round. Hiding it behind "0 aircraft" would be a lie about a
      // rate limit, and the reader would think the sky was empty.
      if (response.status === 429) {
        this.lastError = 'the feed is rate-limiting us';
        this.setStatus(
          'The feed asked us to slow down (HTTP 429). It is volunteer-funded and answers a limited number of requests; the page will try again on the next poll.',
          'error'
        );
        return;
      }
      if (!response.ok) throw new Error(`The feed answered ${response.status}.`);

      this.engine.setWatchlist(this.watchlist);
      this.engine.setTypeRules(this.typeRules);
      const readings = Array.isArray(payload.ac) ? payload.ac : [];

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
  private combinedTypes(): { code: string; seen: number; airports: string[]; operators: string[] }[] {
    const rows = new Map<string, { code: string; seen: number; airports: string[]; operators: string[] }>();
    for (const row of this.survey?.types ?? []) {
      rows.set(row.code, { code: row.code, seen: row.seen, airports: [...(row.airports ?? [])], operators: [...(row.operators ?? [])] });
    }
    for (const [code, seen] of this.liveTypes) {
      const existing = rows.get(code);
      if (existing) existing.seen += seen;
      else rows.set(code, { code, seen, airports: [], operators: [] });
    }
    return [...rows.values()].sort((a, b) => b.seen - a.seen || a.code.localeCompare(b.code));
  }

  private renderTypeList(): void {
    const host = byId('typeList');
    if (!host) return;

    const rows = this.combinedTypes().filter((row) => {
      if (this.typeFilter === 'all') return true;
      return describeType(row.code).klass === this.typeFilter;
    });

    if (rows.length === 0) {
      host.innerHTML =
        '<p class="muted small">Nothing in this group yet. Change the filter, or wait for the page to see something.</p>';
      return;
    }

    const maxima = Math.max(...rows.map((row) => row.seen), 1);

    host.innerHTML = rows
      .map((row) => {
        const info = describeType(row.code);
        const already = this.typeRules.some((rule) => normaliseKey(rule.type) === normaliseKey(row.code));
        // A bar, because "136 sightings" and "1 sighting" are the same shape to
        // the eye until the numbers are drawn against each other.
        const width = Math.max(2, Math.round((row.seen / maxima) * 100));
        return (
          `<div class="typerow${already ? ' typerow-on' : ''}">` +
          `<div class="typerow-main">` +
          `<b>${escapeHtml(info.name)}</b> <span class="mono muted">${escapeHtml(row.code)}</span> ` +
          `<span class="tag">${escapeHtml(classLabel(info.klass))}</span>` +
          `</div>` +
          `<div class="typerow-meta">` +
          `<span class="typerow-bar" aria-hidden="true"><i style="width:${width}%"></i></span>` +
          `<span class="small muted">${row.seen} sighting${row.seen === 1 ? '' : 's'}` +
          (row.operators.length > 0 ? ` · ${escapeHtml(row.operators.slice(0, 4).join(' '))}` : '') +
          (row.airports.length > 1 ? ` · ${row.airports.length} airports` : row.airports.length === 1 ? ` · ${escapeHtml(row.airports[0])}` : '') +
          `</span></div>` +
          `<button type="button" class="ghost ${already ? 'chip-off' : 'chip-on'} type-toggle" data-type="${escapeHtml(row.code)}" data-ga="type-watch">` +
          `${already ? 'Watching — stop' : 'Watch this type'}</button>` +
          '</div>'
        );
      })
      .join('');

    for (const button of host.querySelectorAll<HTMLButtonElement>('.type-toggle')) {
      button.addEventListener('click', () => {
        const code = button.dataset.type ?? '';
        if (this.typeRules.some((rule) => normaliseKey(rule.type) === normaliseKey(code))) {
          this.typeRules = this.typeRules.filter((rule) => normaliseKey(rule.type) !== normaliseKey(code));
        } else {
          // New rules start WIDE — tails empty means every aircraft of the type.
          this.typeRules.push({ type: code, tails: [] });
          track('type_watched', { code, total: this.typeRules.length });
        }
        this.saveTypeRules();
        this.renderWatchlist();
        this.renderTypeList();
      });
    }
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
          ` — ${departure.altitudeFt ?? '?'} ft${climb}, ${departure.distanceNm} nm out.`,
        tag: departure.hex,
      });
    } catch {
      /* Some browsers refuse to build a notification from a page that is not
         itself in the foreground. The board is the record either way. */
    }
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
