/**
 * The canvas's one beat. Every duration and curve the app moves by comes
 * from here (JS) or from the matching CSS variables in styles/base.css
 * (--dur-*, --ease-*) — keep both in sync.
 *
 *   fast   150  controls on intent, tier fades, label thinning
 *   base   220  layout glide, panel in/out, chrome shifts, height changes, wire draw-in
 *   enter  320  a new card settling into its seat, toasts
 *   exit   140  a card leaving, the panel going away
 *   flight      camera moves: 300–900, by how far the eye has to travel
 *
 * "Reduce motion" is honored here once, so call sites never ask: ms() and
 * flight durations come back 0, and the CSS variables drop to 0ms.
 */
export const MOTION = { fast: 150, base: 220, enter: 320, exit: 140 } as const;

const FLIGHT_MIN = 300;
const FLIGHT_MAX = 900;

export function reducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** A duration, or 0 when the user asked for less motion. */
export const ms = (d: number): number => (reducedMotion() ? 0 : d);

/** cubic-bezier(x1, y1, x2, y2) as an easing function (Newton, then bisection). */
function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const err = sx(t) - x;
      const d = dx(t);
      if (Math.abs(err) < 1e-5) return sy(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 24; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-5) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

/** The standard curve: quick to start, long gentle landing. */
export const easeStandard = bezier(0.2, 0, 0, 1);

/** Duration of a camera flight that moves the eye `screenDist` pixels. */
export function flightMs(screenDist: number): number {
  return ms(Math.round(Math.min(FLIGHT_MAX, Math.max(FLIGHT_MIN, 220 + screenDist * 0.45))));
}

type Viewport = { x: number; y: number; zoom: number };

/** The canvas pane's size; the window when the pane is not mounted. */
function paneSize(): { width: number; height: number } {
  const el = typeof document !== 'undefined' ? document.querySelector('.react-flow') : null;
  const r = el?.getBoundingClientRect();
  return r && r.width > 0
    ? { width: r.width, height: r.height }
    : { width: typeof window !== 'undefined' ? window.innerWidth : 1280, height: typeof window !== 'undefined' ? window.innerHeight : 800 };
}

/**
 * Flight duration for centering the world point (x, y) at `zoom`, seen from
 * the current viewport: how far that point travels across the screen, plus
 * the zoom change counted as distance (each doubling ≈ 300px of travel).
 */
export function flightTo(view: Viewport, x: number, y: number, zoom = view.zoom): number {
  const { width, height } = paneSize();
  const sx = x * view.zoom + view.x - width / 2;
  const sy = y * view.zoom + view.y - height / 2;
  const zoomDist = Math.abs(Math.log2(zoom / view.zoom)) * 300;
  return flightMs(Math.hypot(sx, sy) + zoomDist);
}

type Camera = {
  getViewport: () => Viewport;
  setCenter: (x: number, y: number, o?: { zoom?: number; duration?: number; ease?: (t: number) => number }) => Promise<boolean>;
};

/** Center the camera on (x, y): one curve, duration by distance. Resolves when it lands. */
export function flyTo(rf: Camera, x: number, y: number, zoom?: number): Promise<boolean> {
  const view = rf.getViewport();
  const z = zoom ?? view.zoom;
  return rf.setCenter(x, y, { zoom: z, duration: flightTo(view, x, y, z), ease: easeStandard });
}

/** Options for fitView and friends: the base beat, the standard curve. */
export function fitMotion(duration: number = 400): { duration: number; ease: (t: number) => number } {
  return { duration: ms(duration), ease: easeStandard };
}
