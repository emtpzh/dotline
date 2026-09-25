import { useRef } from 'react';
import { useStore as useRfStore } from '@xyflow/react';

/**
 * Semantic zoom, three tiers with hysteresis at both boundaries.
 *
 *   work  (zoom > 0.62)  — the card as the user left it, expanded or folded
 *   map   (~0.32 – 0.72) — every card folded (name · question · conclusion),
 *                           the same face drawn 1.75× so it reads at distance
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

export function useZoomTier(): ZoomTier {
  const ref = useRef<ZoomTier>('work');
  return useRfStore((s) => {
    const z = s.transform[2];
    const cur = ref.current;
    if (cur === 'work') {
      if (z <= WORK_KEEP) ref.current = z <= MAP_DROP ? 'glyph' : 'map';
    } else if (cur === 'map') {
      if (z >= RESTORE_WORK) ref.current = 'work';
      else if (z <= MAP_DROP) ref.current = 'glyph';
    } else {
      if (z >= RESTORE_WORK) ref.current = 'work';
      else if (z >= GLYPH_RESTORE) ref.current = 'map';
    }
    return ref.current;
  });
}

/** Legacy boolean view: true whenever cards are folded (map OR glyph). */
export function useMapMode(): boolean {
  return useZoomTier() !== 'work';
}
