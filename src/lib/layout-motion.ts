import type { ThoughtNode } from '../types';

type Pos = { x: number; y: number };
type SetNodes = (update: (nodes: ThoughtNode[]) => ThoughtNode[]) => void;

const DURATION_MS = 220;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

let cancelRunning: (() => void) | null = null;

/** The canvas's camera, handed over by the canvas when it mounts — layout
 *  code moves cards, and sometimes has to move the camera with them. */
export type ViewportBridge = {
  getViewport: () => { x: number; y: number; zoom: number };
  setViewport: (v: { x: number; y: number; zoom: number }) => void;
  /** The canvas pane's size in screen pixels. */
  size: () => { width: number; height: number };
};
let viewport: ViewportBridge | null = null;
export function registerViewport(bridge: ViewportBridge | null): void { viewport = bridge; }

// While the user is dragging, layout that runs on its own waits: a card
// sliding away under the pointer is a card the user is fighting.
let held = false;
export function holdLayout(on: boolean): void { held = on; }
export function isLayoutHeld(): boolean { return held; }

/**
 * Hand a layout result to the canvas so the cards GLIDE to their new seats
 * instead of jumping: a card that teleports is a card the user has to find
 * again. Positions are interpolated in the store (not with a CSS transition
 * on the node wrapper), so the wires follow the cards frame by frame.
 *
 * Everything except the moving positions — data, frame sizes — lands at
 * once; each frame then patches only the positions of the cards in flight,
 * over whatever the store holds by then, so a streaming answer arriving
 * mid-glide is never overwritten. A new glide snaps the running one to its
 * end first. `onDone` runs after the last frame (history goes there, so the
 * snapshot holds the final positions).
 *
 * `anchorId` keeps one card still ON SCREEN while it moves on the canvas:
 * the camera travels with it, so the card the user is reading does not
 * slide out from under their eyes. Only when that card is in view.
 */
export function glideNodes(prev: ThoughtNode[], next: ThoughtNode[], setNodes: SetNodes, onDone?: () => void,
  options: { anchorId?: string | null } = {}): void {
  cancelRunning?.();
  const before = new Map(prev.map((n) => [n.id, n.position]));
  const flights = new Map<string, { from: Pos; to: Pos }>();
  for (const n of next) {
    const from = before.get(n.id);
    if (from && (Math.abs(from.x - n.position.x) > 0.5 || Math.abs(from.y - n.position.y) > 0.5)) {
      flights.set(n.id, { from, to: n.position });
    }
  }
  const reduced = typeof window === 'undefined' || !window.matchMedia
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (flights.size === 0) {
    setNodes(() => next);
    onDone?.();
    return;
  }

  const patch = (at: (f: { from: Pos; to: Pos }) => Pos) =>
    setNodes((nodes) => nodes.map((n) => {
      const f = flights.get(n.id);
      return f ? { ...n, position: at(f) } : n;
    }));

  // the camera follows the anchor card, by the same fraction of its flight
  const anchor = options.anchorId ? flights.get(options.anchorId) : undefined;
  const anchorNode = options.anchorId ? prev.find((n) => n.id === options.anchorId) : undefined;
  const camera = anchor && anchorNode && viewport ? (() => {
    const v0 = viewport.getViewport();
    const { width, height } = viewport.size();
    const w = (anchorNode.measured?.width ?? 520) * v0.zoom;
    const h = (anchorNode.measured?.height ?? 200) * v0.zoom;
    const sx = anchor.from.x * v0.zoom + v0.x;
    const sy = anchor.from.y * v0.zoom + v0.y;
    const inView = sx < width && sx + w > 0 && sy < height && sy + h > 0;
    return inView ? { v0, dx: anchor.to.x - anchor.from.x, dy: anchor.to.y - anchor.from.y } : null;
  })() : null;
  const follow = (k: number) => {
    if (!camera || !viewport) return;
    const { v0, dx, dy } = camera;
    viewport.setViewport({ x: v0.x - dx * k * v0.zoom, y: v0.y - dy * k * v0.zoom, zoom: v0.zoom });
  };

  setNodes(() => next.map((n) => {
    const f = flights.get(n.id);
    return f ? { ...n, position: f.from } : n;
  }));

  // A hidden page runs no animation frames: land at once rather than leave
  // the cards mid-flight until the tab comes back. A throttled one may run
  // them late: the deadline ends the glide on time regardless.
  const instant = reduced || (typeof document !== 'undefined' && document.hidden);
  const deadline = instant ? undefined : setTimeout(() => finish(), DURATION_MS + 80);
  let raf = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    clearTimeout(deadline);
    cancelRunning = null;
    patch((f) => f.to);
    follow(1);
    onDone?.();
  };
  if (instant) { finish(); return; }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / DURATION_MS);
    if (t >= 1) { finish(); return; }
    const k = easeOut(t);
    patch((f) => ({ x: f.from.x + (f.to.x - f.from.x) * k, y: f.from.y + (f.to.y - f.from.y) * k }));
    follow(k);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  cancelRunning = finish;
}
