import { useStore as useRfStore } from '@xyflow/react';

/**
 * Semantic zoom, three tiers with hysteresis at both boundaries.
 *
 *   work  (zoom > 0.62)  — the card as the user left it, expanded or folded
 *   map   (~0.32 – 0.72) — every card folded (name · question · conclusion),
 *                           the same face drawn larger so it reads at distance
 *                           (canvas.css .map-node: never above reading size)
 *   glyph (zoom < 0.32)  — the name row only: a dot and the node's name
 *
 * One grammar across all three (lib/node-face): zooming out removes layers
 * from the bottom, it never swaps what a slot says.
 *
 * Cards are KEPT longer than the raw numbers suggest: the harvest (work→map)
 * is late (0.62) and the restore (map→work) is early (0.72), so at any given
 * zoom you almost always see the fuller, more readable form. Dual thresholds
 * per boundary prevent flapping.
 */
export type ZoomTier = 'work' | 'map' | 'glyph';

// Keep-work is late and restore-work is early: a node stays a full card all
// the way down to 0.62 zoom and pops back to a card as soon as you have
// zoomed back to 0.72. Glyph is the truly-zoomed-out floor.
const WORK_KEEP = 0.62;
const RESTORE_WORK = 0.72;
const MAP_DROP = 0.32;
const GLYPH_RESTORE = 0.4;

// One tier for the whole canvas. With hysteresis the tier depends on the
// zoom's history, not just its value — kept per component, a card mounted
// inside the 0.62–0.72 band (scrolled into view, newly asked) started as a
// full card while its neighbours stayed map faces. There is one canvas, so
// the history lives here; every caller steps it with the same zoom.
let shared: ZoomTier = 'work';

function step(cur: ZoomTier, z: number): ZoomTier {
  if (cur === 'work') return z <= WORK_KEEP ? (z <= MAP_DROP ? 'glyph' : 'map') : 'work';
  if (cur === 'map') return z >= RESTORE_WORK ? 'work' : z <= MAP_DROP ? 'glyph' : 'map';
  return z >= RESTORE_WORK ? 'work' : z >= GLYPH_RESTORE ? 'map' : 'glyph';
}

export function useZoomTier(): ZoomTier {
  return useRfStore((s) => (shared = step(shared, s.transform[2])));
}

/** Legacy boolean view: true whenever cards are folded (map OR glyph). */
export function useMapMode(): boolean {
  return useZoomTier() !== 'work';
}
