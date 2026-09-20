/**
 * consent.ts — the cookie gate, and the only thing on this site that may load
 * Google's script.
 *
 * Ported from llm-demo/src/consent.ts, which is the tested copy — the model is
 * the same and the reasons are the same:
 *
 *   - **The Google Analytics script is NOT in the page.** It is appended only
 *     after a yes, so a declined visit makes no request to Google at all and
 *     receives no cookie. Not "cookies disabled" — never loaded.
 *   - The choice is remembered in localStorage, not in a cookie, because setting
 *     a cookie to record a cookie decision would be its own small joke.
 *   - Accept all and Reject all are the same size, the same weight and the same
 *     distance from the reader.
 *   - Rejecting is a real answer, not a nag.
 *   - The panel names ONE real choice, and its switch starts OFF.
 *
 * WHAT THIS SITE CHANGES, AND WHY — three deliberate departures from the copy it
 * was ported from, each because the standard is newer than that copy:
 *
 * 1. 🔴 **THE OWNER'S SWITCH IS NOT IN THE PANEL.** The reference still carries a
 *    "This device / count my visits" row that surfaces `?ga=off` to the visitor.
 *    George ruled it out on 19 Sep 2026, verbatim: *"new rule i dont want count
 *    my visits in the cookie settings"*. A visitor has no reason to look for it
 *    and no business seeing it, so `wordCountSwitch()` is not ported at all and
 *    the markup carries no `consentDeviceRow`. `?ga=off` / `?ga=on` still work
 *    from the address bar, which is where the person who runs the site can find
 *    them.
 *
 * 2. **THE ASK SAYS WHAT THIS SITE ACTUALLY COLLECTS.** It would be easy, and
 *    false, to reuse a sentence about text being trained on in a tab. What is
 *    true here is smaller and better: the page asks a public aircraft feed for
 *    aircraft near one airport, and the only thing sent to Google is anonymous
 *    page, click and scroll events.
 *
 * 3. **NO "THE TEXT YOU PASTE IS NEVER SENT" REASSURANCE**, because there is no
 *    text to paste. Copy that promises something the page cannot do is worse than
 *    no copy.
 */

(function () {
  var KEY = 'analytics_consent';
  var OWNER_KEY = 'ga_opt_out';
  var started = false;

  function read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function write(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      /* Private mode, or storage switched off. The choice then lasts for the
         visit, which is the honest outcome. */
    }
  }

  function drop(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      /* as above */
    }
  }

  function measurementId(): string {
    var tag = document.querySelector('script[data-ga-id]');
    return tag ? tag.getAttribute('data-ga-id') || '' : '';
  }

  function ownerOptedOut(): boolean {
    return read(OWNER_KEY) === '1';
  }

  function allowed(): boolean {
    return !ownerOptedOut() && read(KEY) === 'granted';
  }

  /**
   * Load the analytics tag, once, and only if it is allowed. Nothing before this
   * point has contacted Google.
   */
  function start(): void {
    if (started || !allowed()) return;
    var id = measurementId();
    if (!id) return;
    started = true;

    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag(): void {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
    };
    // The page's own events go out through this, and it only exists once the
    // visitor has said yes — a page with no consent has no way to send one.
    window.aircraftTrack = function aircraftTrack(
      name: string,
      params: Record<string, unknown> = {}
    ): void {
      window.gtag?.('event', name, params);
    };

    var tag = document.createElement('script');
    tag.async = true;
    tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.appendChild(tag);

    window.gtag('js', new Date());
    // The page sends its own page_view, so the automatic one stays off rather
    // than counting this landing twice.
    window.gtag('config', id, { send_page_view: false });
    window.gtag('event', 'page_view', {
      page_location: location.href,
      page_path: location.pathname,
      page_title: document.title,
    });

    // The other two things the house standard asks every site to send, both of
    // them about the page rather than about the reader: which controls are
    // pressed, and how far down a page people get.
    //
    // Two deliberate limits. **Nothing here reads anything the reader typed** —
    // a control is named by its own id, its tag and its role, never by its
    // contents, so a tail number somebody is watching is never sent. And **the
    // listeners do not exist until this point**: a visitor who has not allowed
    // analytics has no click or scroll listener on the page at all, rather than
    // one that stays quiet, which is the difference between a promise and a
    // habit.
    document.addEventListener(
      'click',
      function (event: Event) {
        var target = event.target as HTMLElement | null;
        var node = target && target.closest ? target.closest('a, button') : null;
        if (!node) return;
        var href = node.getAttribute('href') || '';
        var offsite = /^https?:\/\//.test(href) && href.indexOf(location.host) === -1;
        var scheme = href.indexOf('mailto:') === 0 ? 'mailto' : href.indexOf('tel:') === 0 ? 'tel' : '';
        window.gtag?.('event', 'element_click', {
          page_path: location.pathname,
          element_id: node.id || '',
          element_kind: node.tagName.toLowerCase(),
          element_role: node.getAttribute('data-ga') || String(node.className || '').split(' ')[0] || '',
          outbound: offsite || scheme === 'mailto',
          link_scheme: scheme,
          outbound_host: offsite ? new URL(href).host : '',
        });
      },
      true
    );

    var marks = [25, 50, 75, 100];
    var deepest = 0;
    var sent: Record<number, boolean> = {};
    var onScroll = function () {
      var page = document.documentElement.scrollHeight;
      // A page shorter than the window is fully read the moment it is opened, so
      // it counts as the deepest mark rather than as nothing at all.
      var percent =
        page <= window.innerHeight
          ? 100
          : Math.min(100, Math.round(((window.scrollY + window.innerHeight) / page) * 100));
      deepest = Math.max(deepest, percent);
      for (var i = 0; i < marks.length; i += 1) {
        var mark = marks[i];
        if (deepest >= mark && !sent[mark]) {
          sent[mark] = true;
          window.gtag?.('event', 'scroll_depth', { page_path: location.pathname, percent_scrolled: mark });
        }
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /**
   * The owner's own switch, from the address bar: ?ga=off / ?ga=on. It beats
   * consent, because it exists so the person who runs the site can leave himself
   * out of his own numbers without changing what every visitor is offered.
   */
  function applyOwnerSwitch(): void {
    var params = new URLSearchParams(location.search);
    var flag = params.get('ga');
    if (flag === 'off') {
      write(OWNER_KEY, '1');
      // Already loaded on this page? Reloading is what actually stops it.
      if (window.gtag) location.reload();
    }
    if (flag === 'on') drop(OWNER_KEY);
  }

  var bar: HTMLElement | null = null;

  /**
   * Reserve the banner's own height at the bottom of the page.
   *
   * The banner is fixed to the bottom of the window, which means it sits on top
   * of whatever is behind it and takes the click — on inputresponse.com that cost
   * a real visitor a real click on the footer, which was unclickable until they
   * answered. The page is told to leave exactly the banner's own height free,
   * measured here rather than guessed.
   *
   * 🔴 AND THE SPACE GOES ON <body>, NOT IN THE FOOTER'S PADDING. Padding is
   * inside the box, so padding on the footer does not lift the footer's own
   * bottom edge clear of a bar fixed to the bottom of the window — measured on
   * gord100, 19 Sep 2026, where it was tried first.
   */
  function reserveSpace(): void {
    var root = document.documentElement;
    var height = !bar || bar.hidden ? 0 : Math.ceil(bar.getBoundingClientRect().height);
    if (root.style.getPropertyValue('--consent-height') === height + 'px') return;
    root.style.setProperty('--consent-height', height + 'px');
  }

  function hide(): void {
    if (bar) bar.hidden = true;
    reserveSpace();
  }

  interface Panel {
    ask: HTMLElement | null;
    prefs: HTMLElement | null;
    settings: HTMLElement | null;
    toggle: HTMLElement | null;
    word: HTMLElement | null;
  }

  /**
   * Two views share this one fixed bar rather than a second dialog appearing
   * over it. That is not tidiness: the bar is the thing whose height is measured
   * and reserved at the bottom of the page, and the observer already follows it,
   * so the taller view is measured rather than guessed at.
   */
  function panel(): Panel {
    return {
      ask: document.getElementById('consentAsk'),
      prefs: document.getElementById('consentPrefs'),
      settings: document.getElementById('consentSettings'),
      toggle: document.getElementById('consentAnalytics'),
      word: document.getElementById('consentAnalyticsWord'),
    };
  }

  /**
   * The switch, and the word beside it is not decoration: a state carried only by
   * colour is a state some readers cannot see. The visual state is drawn from
   * `aria-checked` in the stylesheet, so the ring and the announcement cannot
   * disagree — they are the same attribute.
   */
  function setAnalytics(on: boolean): void {
    var parts = panel();
    if (parts.toggle) parts.toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    if (parts.word) parts.word.textContent = on ? 'On' : 'Off';
  }

  function analyticsOn(): boolean {
    var parts = panel();
    return !!parts.toggle && parts.toggle.getAttribute('aria-checked') === 'true';
  }

  function openPrefs(): void {
    if (!bar) return;
    var parts = panel();
    setAnalytics(read(KEY) === 'granted');
    if (parts.ask) parts.ask.hidden = true;
    if (parts.prefs) parts.prefs.hidden = false;
    if (parts.settings) parts.settings.hidden = true;
    bar.hidden = false;
    reserveSpace();
    // Focus the panel, not a control inside it. A focus ring on a switch is a
    // recommendation about what to do with the switch, and this is the one place
    // on the site where a recommendation is the whole thing being avoided.
    if (parts.prefs) {
      parts.prefs.setAttribute('tabindex', '-1');
      parts.prefs.focus();
    }
  }

  /** Back to the question, which is the state the bar opens in. */
  function askMode(): void {
    var parts = panel();
    if (parts.ask) parts.ask.hidden = false;
    if (parts.prefs) parts.prefs.hidden = true;
    if (parts.settings) parts.settings.hidden = false;
  }

  function show(): void {
    if (!bar) return;
    askMode();
    bar.hidden = false;
    reserveSpace();
    // Focus the banner, NOT the first button: putting focus on a button draws the
    // browser's focus ring around it, which quietly recommends that answer.
    bar.setAttribute('tabindex', '-1');
    bar.focus();
  }

  function decide(answer: 'granted' | 'denied'): void {
    var was = read(KEY);
    write(KEY, answer);
    hide();
    if (answer === 'granted') start();
    // Withdrawing has to actually stop it. The tag is already in the page and
    // cannot be unloaded, so the honest way to stop counting is to load the page
    // again without it — the same thing the address-bar switch does, and the only
    // version of "no" that is true.
    if (answer === 'denied' && was === 'granted' && window.gtag) location.reload();
  }

  /**
   * What moving the switch does: the answer, and the bar closes. It does not wait
   * for a separate Save button, which would make one setting into a two-step form
   * — and somebody who flipped the switch and walked away would have answered
   * nothing while appearing to have answered something.
   */
  function setAndDecide(on: boolean): void {
    setAnalytics(on);
    decide(on ? 'granted' : 'denied');
  }

  /**
   * The x at the top of the panel, and the Escape key, which do the same thing.
   * What closing MEANS depends on whether there is already an answer: with an
   * answer, the bar goes away and nothing changes; with none, the panel steps
   * back to the QUESTION, because an x that dismissed the question would be a way
   * to never choose and still be counted.
   */
  function closePrefs(): void {
    if (!read(KEY)) {
      show();
      return;
    }
    hide();
  }

  function build(): void {
    if (!measurementId()) return;

    bar = document.getElementById('consentBar');
    if (!bar) return;

    var accept = document.getElementById('consentAccept');
    var decline = document.getElementById('consentDecline');
    if (accept) accept.addEventListener('click', function () { decide('granted'); });
    if (decline) decline.addEventListener('click', function () { decide('denied'); });

    var parts = panel();
    if (parts.settings) parts.settings.addEventListener('click', openPrefs);
    if (parts.toggle) {
      parts.toggle.addEventListener('click', function () {
        setAndDecide(!analyticsOn());
      });
    }

    var close = document.getElementById('consentClose');
    if (close) close.addEventListener('click', closePrefs);
    document.addEventListener('keydown', function (event) {
      var prefs = document.getElementById('consentPrefs');
      if (event.key === 'Escape' && prefs && !prefs.hidden) {
        event.preventDefault();
        closePrefs();
      }
    });

    window.addEventListener('resize', reserveSpace);
    window.addEventListener('orientationchange', reserveSpace);
    window.addEventListener('load', reserveSpace);
    // The one that actually settles it: the banner tells us when its own size
    // moves, whatever the reason.
    if (typeof ResizeObserver === 'function') new ResizeObserver(reserveSpace).observe(bar);

    // 🔴 THE FOOTER DOOR IS DELEGATED, NOT BOUND — and this is the rule here that
    // a screenshot cannot check. Binding `#consentBtn` directly runs ONCE, at
    // load. It works on this site, whose footer is static HTML, and it fails on a
    // site whose footer is a component that does not exist yet at that moment —
    // where no listener is ever attached, the button renders, looks right in
    // every screenshot, and does nothing when pressed. That is exactly how it
    // shipped once, on password-please. A delegated gate therefore has NO reason
    // to look the door up by id, and its absence is what the unit test asserts.
    //
    // It opens the PANEL rather than asking the question again: the reader has
    // already answered, and something called settings that repeats the question
    // is not a settings control. The answer is left alone, so nothing stops
    // running just because somebody looked.
    document.addEventListener(
      'click',
      (event: Event) => {
        const target = event.target as Element | null;
        if (target?.closest?.('#consentBtn')) openPrefs();
      },
      true
    );

    if (!read(KEY)) show();
  }

  applyOwnerSwitch();
  start();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
