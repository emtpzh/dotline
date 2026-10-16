// Base URL of the LLM proxy. Dev defaults to the local server.mjs; a
// production build defaults to SAME-ORIGIN /api/* (the deployment's worker
// serves it) — zero-config correct on any host. Override with VITE_API_BASE
// when the proxy runs elsewhere (e.g. a static build against a LAN proxy).
export const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

// PDFs above this page count default to text-only context (Vision page images
// would cost ~1500 tokens per page).
export const PDF_VISION_PAGE_THRESHOLD = 10;

// Undo stack depth (full-graph snapshots).
export const HISTORY_LIMIT = 50;

// Rendered node card width (ThoughtNode w-[520px]).
export const NODE_CSS_WIDTH = 520;

// Layout column pitch — wider than the card so edges have breathing room.
// Gaps sit at the tight end: enough air for the wires and the edge chips,
// no more — a denser canvas keeps more of the graph in one glance.
export const LAYOUT_COL_WIDTH = 540;
export const LAYOUT_H_GAP = 48;
// 72 is lifted from a real working canvas — the density its author settled
// into by hand, adopted as the default.
export const LAYOUT_V_GAP = 72;

// Collapsed node card height, used by layout estimation and collapse shifting.
export const COLLAPSED_NODE_HEIGHT = 80;
// Layout footprint of a collapsed node. NOT the folded card's own height:
// at map zoom the same face renders up to 1.75× larger (≈ 190px world height),
// and laying out by the working-size strip made every imported chain
// overlap the moment the user zoomed to the map.
export const COLLAPSED_LAYOUT_HEIGHT = 240;

// JS mirror of the design tokens in src/index.css — for places that take
// color values rather than classes. Canvas wires resolve theirs at render
// time (lib/appearance edgePalette, lib/edge-look); nothing is persisted.
export const COLORS = {
  surface: 'var(--background)',
  card: 'var(--card)',
  line: 'var(--border)',
  inkMuted: 'var(--muted-foreground)',
  accent: 'var(--edge-continue)',   // a wire that goes on: the conversation chain
  warm: 'var(--edge-explore)',      // a wire that forks off beside its parent
  trace: 'var(--edge-trace)',       // ancestor-path highlight
  material: 'var(--muted-foreground)', // a material's wire
} as const;


// Frame palette — FIXED set (no picker): frames are navigation objects, so
// color is function, not decoration. Tokens referenced by FrameNode + the
// frame navigator.
export const FRAME_COLORS: Record<string, { border: string; bg: string; dot: string }> = {
  gray: { border: 'border-foreground/15', bg: 'bg-foreground/[0.03]', dot: 'bg-foreground/30' },
  violet: { border: 'border-primary/40', bg: 'bg-primary/[0.05]', dot: 'bg-primary' },
  amber: { border: 'border-amber-400/60', bg: 'bg-amber-400/[0.07]', dot: 'bg-amber-400' },
  green: { border: 'border-emerald-500/40', bg: 'bg-emerald-500/[0.05]', dot: 'bg-emerald-500' },
  sky: { border: 'border-sky-500/40', bg: 'bg-sky-500/[0.05]', dot: 'bg-sky-500' },
  rose: { border: 'border-rose-400/50', bg: 'bg-rose-400/[0.06]', dot: 'bg-rose-400' },
};

// Focus panel overlay: the panel floats OVER the canvas (the canvas never
// resizes). Width is user-resizable and persisted; App reads it to nudge
// the viewport when the selected node would be hidden underneath.
export const PANEL_WIDTH_KEY = 'thoughtdag.panelWidth';
export const PANEL_MIN_WIDTH = 380;
export const PANEL_DEFAULT_WIDTH = 520;
export const PANEL_INSET = 12; // matches right-3/top-3/bottom-3

export function loadPanelWidth(): number {
  const raw = localStorage.getItem(PANEL_WIDTH_KEY);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : PANEL_DEFAULT_WIDTH;
}
