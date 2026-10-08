/**
 * A card asked off another one is BORN from it: the wire draws out of the
 * parent's handle first, then the card grows out along it to its seat
 * (ThoughtNode, ThoughtEdgeView) — the context flow, played once.
 *
 * The store notes the birth here when it makes the card; the canvas reads
 * it when the card and its wire mount. It never enters node data, history
 * or persistence, and goes stale after a moment, so a card that mounts
 * later (a reload, scrolling into view) simply appears.
 */
import { MOTION } from './motion';

export type Spawn = {
  /** The parent the card grows out of. */
  from: string;
  /** Out of the parent's bottom handle, or out of its side (a branch). */
  via: 'below' | 'beside';
  /** For `beside`: where along the parent's height the wire leaves. */
  ratio: number;
  /** Siblings born together leave one after another. */
  delay: number;
  at: number;
};

const STAGGER_MS = 60;
const FRESH_MS = 1000;
const births = new Map<string, Spawn>();

export function noteSpawn(from: string, ids: string[], via: Spawn['via'], ratio = 0.5): void {
  const at = typeof performance !== 'undefined' ? performance.now() : 0;
  ids.forEach((id, i) => births.set(id, { from, via, ratio, delay: i * STAGGER_MS, at }));
}

/** The birth of a card made a moment ago; undefined for any other card. */
export function spawnOf(id: string): Spawn | undefined {
  const s = births.get(id);
  if (!s) return undefined;
  if (performance.now() - s.at > FRESH_MS) { births.delete(id); return undefined; }
  return s;
}

/** The wire draws first; the card leaves the handle just after it starts. */
export const WIRE_MS = MOTION.base;
export const CARD_LAG_MS = 40;
