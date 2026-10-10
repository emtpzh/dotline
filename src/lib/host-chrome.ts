// Inside DeepSeek Harness the canvas is an iframe laid over the whole
// window, and the window has no native title bar: the macOS traffic lights
// float over the top-left corner, the Windows caption buttons over the
// top-right. The client half measures those corners from the host's own
// markers and sends them (td:chrome); the canvas keeps its top bar on the
// first row, clear of them, through four variables (styles/base.css):
//
//   --chrome-left / --chrome-right  where the top bar may start / end
//   --chrome-row-top                the top bar's top, centred on the chrome
//   --chrome-panel-top              the side panel's top (below a right corner)
//
// The window is dragged from the canvas's empty chrome: the gap between the
// top bar's two clusters, the strip above it, the corner around the traffic
// lights. Only the host document can be a drag region (Chromium reads them
// from the main frame alone), so the canvas reports those rectangles
// (td:drag) and the client half lays transparent drag blocks over them.
// CSS variables and regions do not cross the frame boundary, hence the
// messages.
//
// The same message says whether the canvas needs its own way back to the
// chat (\`back\`): laid over the whole window it does; as a panel beside the
// harness's sidebar it does not, the sidebar is the way back.

import { useSyncExternalStore } from 'react';

const SOURCE = 'dsh-dotline';
const ROW_HEIGHT = 32; // the top bar's controls (Button size default/icon)

type Chrome = { left: number; right: number; center: number; band: number };
type Rect = { x: number; y: number; w: number; h: number };

let chrome: Chrome | null = null;
// no back button until the host asks for one: a panel never shows it
let back = false;
const backListeners = new Set<() => void>();
let lastSent = '';
let frame = 0;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);
const post = (data: Record<string, unknown>) =>
  window.parent.postMessage({ source: SOURCE, ...data }, window.location.origin);

function applyChrome(c: Chrome): void {
  const s = document.documentElement.style;
  const rowTop = c.center > 0 ? Math.max(4, Math.round(c.center - ROW_HEIGHT / 2)) : 16;
  s.setProperty('--chrome-left', `${c.left}px`);
  s.setProperty('--chrome-right', `${c.right}px`);
  s.setProperty('--chrome-row-top', `${rowTop}px`);
  // a right corner (Windows) sits where the panel's header would; a left
  // one (macOS) is clear of the panel
  s.setProperty('--chrome-panel-top', c.right > 0 ? `${c.band + 8}px` : '12px');
}

// The canvas's own layers that can float over the strip: the search bar
// (it opens in the top bar's gap), dialogs and their full-window backdrop,
// popovers and menus, the tour, the movable condense window, the reader's
// ask bar. A drag block over any of them would swallow its clicks.
const COVERS = '[data-canvas-search], [data-slot="dialog-overlay"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .tdag-tour, .tdag-condense-window, .tdag-ask-bar';

const meets = (a: Rect, b: DOMRect) =>
  a.x < b.right && b.left < a.x + a.w && a.y < b.bottom && b.top < a.y + a.h;

// The drag rectangles, in this frame's viewport — the same as the host's,
// since the overlay starts at its origin. A rectangle that meets one of
// the canvas's floating layers is left out while that layer is up.
function dragRects(): Rect[] {
  if (!chrome || (chrome.left === 0 && chrome.right === 0)) return [];
  const gap = document.querySelector('[data-topbar-gap]');
  const row = document.querySelector('[data-topbar]');
  if (!gap || !row) return [];
  const g = gap.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const w = window.innerWidth;
  const rects: Rect[] = [
    // above the top bar, short of a right corner (the caption buttons own it)
    { x: 0, y: 0, w: w - chrome.right, h: r.top },
    // the corner the traffic lights sit in, down to the top bar's bottom
    { x: 0, y: 0, w: chrome.left, h: r.bottom },
  ];
  if (g.width > 8) rects.push({ x: g.left, y: g.top, w: g.width, h: g.height });
  const covers = Array.from(document.querySelectorAll(COVERS), (el) => el.getBoundingClientRect())
    .filter((b) => b.width > 0 && b.height > 0);
  return rects
    .filter((x) => x.w > 0 && x.h > 0 && !covers.some((b) => meets(x, b)))
    .map((x) => ({ x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.w), h: Math.round(x.h) }));
}

/** Re-measure the drag rectangles (coalesced to one per frame). */
export function refreshHostDrag(): void {
  if (!chrome || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const rects = dragRects();
    const key = JSON.stringify(rects);
    if (key === lastSent) return;
    lastSent = key;
    post({ type: 'td:drag', rects });
  });
}

export function installHostChrome(): void {
  if (window.parent === window) return;
  window.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as ({ source?: string; type?: string } & Partial<Record<keyof Chrome, unknown>>) | null;
    if (ev.origin !== window.location.origin || d?.source !== SOURCE || d.type !== 'td:chrome') return;
    chrome = { left: num(d.left), right: num(d.right), center: num(d.center), band: num(d.band) };
    // a host that predates the field always laid the canvas over the window
    const nextBack = typeof (d as { back?: unknown }).back === 'boolean' ? (d as { back: boolean }).back : true;
    if (nextBack !== back) { back = nextBack; backListeners.forEach((fn) => fn()); }
    applyChrome(chrome);
    lastSent = ''; // the host may have just (re)built its drag layer
    refreshHostDrag();
  });
  // the gap moves with the window, the panel, and the clusters' widths;
  // the canvas's floating layers come and go
  // (one measure per frame however often these fire)
  window.addEventListener('resize', refreshHostDrag);
  new MutationObserver(refreshHostDrag).observe(document.body, { childList: true, subtree: true });
  // a floating layer dragged into or out of the strip
  window.addEventListener('pointerup', refreshHostDrag);
  const watchGap = () => {
    const gap = document.querySelector('[data-topbar-gap]');
    if (!gap) { setTimeout(watchGap, 500); return; }
    new ResizeObserver(refreshHostDrag).observe(gap);
    // the gap can move without resizing (the row's top or left changes)
    gap.closest('[data-topbar]')?.addEventListener('transitionend', refreshHostDrag);
    refreshHostDrag();
  };
  watchGap();
  // ready = the canvas draws its own way back to the chat, so the host's
  // fallback pill can go; the host answers with the chrome
  post({ type: 'td:ready' });
}

/** Whether the embedded canvas draws its own way back to the chat. */
export function useHostBack(): boolean {
  return useSyncExternalStore(
    (fn) => { backListeners.add(fn); return () => { backListeners.delete(fn); }; },
    () => back,
  );
}

/** The embedded canvas's way back to the conversation view. */
export function closeEmbeddedView(): void {
  post({ type: 'td:close' });
}
