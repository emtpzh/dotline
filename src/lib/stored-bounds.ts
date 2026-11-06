import { Position } from '@xyflow/react';
import type { ThoughtNode } from '../types';
import { useStore } from '../store';
import { estimateNodeHeight } from './layout';
import { isContentKind } from './content';

/**
 * Arriving on a canvas without drawing all of it first.
 *
 * React Flow leaves off-screen nodes unmounted (onlyRenderVisibleElements)
 * only once it holds their handle bounds, and those come from the DOM: a
 * node it has never measured is rendered whatever the viewport, to be
 * measured. Loading a graph (boot, every canvas switch) rebuilds React
 * Flow's node lookup, so each load drew every card once — on a 380-card
 * canvas about two seconds of main thread for cards nobody could see.
 *
 * A stored card knows its size already: React Flow wrote `measured` back
 * through onNodesChange the last time it drew it, and the graph keeps it.
 * Until React Flow draws a card again, the card goes to it with handles laid
 * out on that box (`Node.handles`, React Flow's own way to place edges
 * before measuring). It is culled then like any measured node; its wires,
 * the minimap and fitView read the box. Once the card has mounted its
 * handles are no longer supplied, and the DOM measurement React Flow takes
 * after the mount is the only truth from there on — supplied handles replace
 * whatever React Flow measured each time it reads the node.
 *
 * The box only has to be no smaller than the card will draw: a supplied
 * handle sits on its border, so a wire end that reaches the screen brings
 * its box, and the card, into view, and the measurement then puts the end
 * where it belongs. Only the far ends of wires leaving the screen can run
 * a little off until their cards are drawn — as for any card React Flow
 * measured at another zoom and has not drawn since.
 *
 * A question card's box is as tall as the layout seats it, when that is
 * taller than its stored height: its text regions are height-capped, so the
 * layout's estimate covers the card at any zoom, even when it was stored
 * folded from far out. Material grows with what it holds — a file's
 * preview, a note's text — and a stored height measured far out (the dot is
 * 128px tall) could hide most of it, so material is drawn on arrival as
 * before. A frame is the size it was given.
 */

type NodeHandle = NonNullable<ThoughtNode['handles']>[number];

// cards in the DOM right now
const mounted = new Set<string>();
// cards React Flow has measured since the graph loaded: the mounted ones,
// and those drawn earlier and scrolled away since (their bounds stay in
// React Flow's lookup)
let drawn = new Set<string>();

/** A card entered the DOM. Called from a layout effect: React Flow observes
 *  the element only in a later passive effect, so the card counts as drawn
 *  before React Flow can measure it, and its supplied handles can never be
 *  read over that measurement. */
export function cardMounted(id: string): void {
  mounted.add(id);
  drawn.add(id);
}

export function cardUnmounted(id: string): void {
  mounted.delete(id);
}

// A graph load rebuilds React Flow's lookup: only the cards still in the
// DOM (an id the next graph shares with one on screen) keep a measurement.
useStore.persist.onHydrate(() => { drawn = new Set(mounted); });

const handle = (id: string, type: 'source' | 'target', position: Position, x: number, y: number): NodeHandle =>
  ({ id, type, position, x, y, width: 0, height: 0 });

/** A question card's handles (ThoughtNode, ParadigmNode) at reading zoom on
 *  a w × h box — same ids, sides and order: top and left in, bottom and
 *  right out. A frame has none. */
function handlesFor(node: ThoughtNode, w: number, h: number): NodeHandle[] {
  if (node.data.stepKind === 'frame') return [];
  return [
    handle('top', 'target', Position.Top, w / 2, 0),
    handle('left', 'target', Position.Left, 0, h * 0.4),
    handle('continue', 'source', Position.Bottom, w / 2, h),
    handle('branch', 'source', Position.Right, w, h / 2),
  ];
}

const withBounds = new WeakMap<ThoughtNode, ThoughtNode>();

function fromStore(node: ThoughtNode): ThoughtNode {
  const w = node.measured?.width, h = node.measured?.height;
  // never drawn anywhere, or material: React Flow draws it to measure it
  if (!w || !h || isContentKind(node.data.stepKind)) return node;
  let out = withBounds.get(node);
  if (!out) {
    const height = node.data.stepKind === 'frame' ? h : Math.max(h, estimateNodeHeight(node));
    out = { ...node, measured: { width: w, height }, handles: handlesFor(node, w, height) };
    withBounds.set(node, out);
  }
  return out;
}

/** The graph as React Flow receives it: a card not drawn since the graph
 *  loaded carries its stored box and handles. Same array when none does. */
export function withStoredBounds(nodes: ThoughtNode[]): ThoughtNode[] {
  let out: ThoughtNode[] | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (drawn.has(n.id)) continue;
    const next = fromStore(n);
    if (next !== n) (out ??= nodes.slice())[i] = next;
  }
  return out ?? nodes;
}
