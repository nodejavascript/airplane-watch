/**
 * types.d.ts — the two globals the consent gate creates.
 *
 * Declared rather than cast away, because the whole point of the gate is that
 * these do NOT exist until the visitor says yes. A page that could call
 * `window.aircraftTrack(...)` without a type error would be a page that can send
 * an event before consent, which is the one thing the gate is for.
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    /** Created by consent.ts, and only after a yes. */
    aircraftTrack?: (name: string, params?: Record<string, unknown>) => void;
    /**
     * Created by faults.ts, before anything else on the page runs.
     *
     * 🔴 THE PAGE HAS TO CALL THIS FROM ITS OWN `catch` BLOCKS. A caught error is
     * invisible to the reporter — see the note on `reportFault` in `faults.ts` — so a
     * catch that has decided something is broken must send it here, and a catch that
     * has decided it is not must say so in words. A test fails on either being absent.
     */
    aircraftFault?: (error: unknown, where?: string) => void;
  }
}

export {};
