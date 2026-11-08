import { useSyncExternalStore } from 'react';
import { useUiStore } from './ui-store';
import { PANEL_INSET, PANEL_MIN_WIDTH } from './constants';
import { CHROME_EVENT } from './host-chrome';

// The side panel's width as it is drawn. The stored width is the one the
// person dragged it to; the window decides how much of that there is room
// for now. A width dragged in a wide window and read in a narrower one
// (another screen, the canvas embedded in a host window) never reaches the
// top bar or the camera as a width the panel does not take: everything that
// makes room for the panel reads it from here.

/** the panel never takes more than this share of the window */
const MAX_SHARE = 0.7;
/** what the top bar keeps beside an open panel: its last fold (the canvas
 *  library, a stale count, the ⋯ menu) with room to spare */
const TOPBAR_FLOOR = 160;
/** the top bar ends this far before the panel */
export const TOPBAR_PANEL_GAP = 12;

/** The width a panel that wants `wanted` takes in a window `viewport` wide
 *  whose top bar starts at `left` (past a host window's corner controls). */
export function panelWidthFor(wanted: number, viewport: number, left: number): number {
  const room = viewport - Math.max(16, left) - TOPBAR_FLOOR - TOPBAR_PANEL_GAP - PANEL_INSET;
  const max = Math.min(Math.floor(viewport * MAX_SHARE), room);
  // a window too narrow for both keeps the panel readable; the top bar folds
  return Math.max(PANEL_MIN_WIDTH, Math.min(wanted, max));
}

// The window's width and where the top bar starts, read when either moves —
// not on every render: the corner is a CSS variable the host sets
// (lib/host-chrome), and reading computed style forces a style pass.
type Frame = { viewport: number; left: number };
const read = (): Frame => ({
  viewport: window.innerWidth,
  left: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chrome-left')) || 0,
});
let frame: Frame = read();
const listeners = new Set<() => void>();
const remeasure = () => {
  const next = read();
  if (next.viewport === frame.viewport && next.left === frame.left) return;
  frame = next;
  listeners.forEach((fn) => fn());
};
window.addEventListener('resize', remeasure);
window.addEventListener(CHROME_EVENT, remeasure);

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** The open panel's width now, for code outside React. */
export function panelWidthNow(): number {
  remeasure();
  return panelWidthFor(useUiStore.getState().panelWidth, frame.viewport, frame.left);
}

/** The width a drag to `wanted` leaves the panel at, stored as drawn. */
export const panelWidthAt = (wanted: number): number => panelWidthFor(wanted, window.innerWidth, frame.left);

/** The open panel's width, following the window and the host's corners. */
export function usePanelWidth(): number {
  const wanted = useUiStore((s) => s.panelWidth);
  const { viewport, left } = useSyncExternalStore(subscribe, () => frame);
  return panelWidthFor(wanted, viewport, left);
}
