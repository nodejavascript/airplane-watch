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
  }
}

export {};
