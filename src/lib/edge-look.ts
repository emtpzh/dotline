import type { CSSProperties } from 'react';
import type { ThoughtData, ThoughtEdge, ThoughtNode } from '../types';

// How a wire looks is DERIVED from what it means, at render time. An edge
// stores meaning only — is it a reference, is it a fork, does it follow the
// thread's tip — and three independent channels show it:
//   dash  = weight: dashed is one reference block, solid is the whole line
//   color = route:  goes on (continue), branches off (fork), brings material in
//   flow  = runs on its own: follows the tip, or feeds a node that reruns itself
// A card's own color follows the solid wire it hangs from, so the node and
// its incoming line always agree. Red is not part of this grammar: it means
// an error, nothing else.

const MATERIAL = new Set(['note', 'file', 'link']);

export type EdgeRoute = 'continue' | 'fork' | 'material';
/** A card's route: the solid conversation wire it hangs from, or none. */
export type NodeRoute = 'origin' | 'continue' | 'fork';

/** autoRerun, with the legacy fallback: old graphs stored evaluatorTrigger. */
export function isAutoRerun(data: Pick<ThoughtData, 'autoRerun' | 'evaluatorTrigger'>): boolean {
  return data.autoRerun ?? data.evaluatorTrigger === 'auto';
}

interface Routes {
  edge: Map<string, EdgeRoute>;
  node: Map<string, NodeRoute>;
  material: Set<string>;
}

// Keyed on the edges array: routes change only when wiring does, and a
// node's kind is fixed at birth — so cards can read their route on every
// store update without walking the graph each time.
const cache = new WeakMap<ThoughtEdge[], Routes>();

/**
 * Routes of every edge and card. A parent's FIRST plain solid child
 * continues its column; every other solid child — explored from a passage,
 * a perspective, an alternative answer, a fork in an imported session —
 * grows beside it and is a fork. Same rule as layout's classifyChildren,
 * so the orange wires are exactly the ones that leave the column.
 */
export function routesOf(nodes: ThoughtNode[], edges: ThoughtEdge[]): Routes {
  const hit = cache.get(edges);
  if (hit) return hit;
  const material = new Set(nodes.filter((n) => MATERIAL.has(n.data.stepKind ?? '')).map((n) => n.id));
  const edge = new Map<string, EdgeRoute>();
  const node = new Map<string, NodeRoute>();
  const continued = new Set<string>();
  for (const e of edges) {
    if (material.has(e.source)) { edge.set(e.id, 'material'); continue; }
    // a reference is quoted from the line it sits on: it goes on, never forks
    if (e.data?.isCrossLink) { edge.set(e.id, 'continue'); continue; }
    let route: EdgeRoute;
    if (e.data?.isBranchFromSelection || continued.has(e.source)) route = 'fork';
    else { route = 'continue'; continued.add(e.source); }
    edge.set(e.id, route);
    // a card continuing from any parent is a continuation (layout seats it
    // from that parent), whatever else it was explored out of
    if (node.get(e.target) !== 'continue') node.set(e.target, route);
  }
  const out = { edge, node, material };
  cache.set(edges, out);
  return out;
}

export function nodeRoute(nodes: ThoughtNode[], edges: ThoughtEdge[], nodeId: string): NodeRoute {
  return routesOf(nodes, edges).node.get(nodeId) ?? 'origin';
}

/** What an edge means, as the canvas draws it. */
export interface EdgeMeaning {
  route: EdgeRoute;
  /** dashed: the target reads one reference block, not the whole line.
      A material's wire is never one — its whole text flows either way. */
  reference: boolean;
  /** runs on its own: follows the thread's tip, or feeds an auto-rerun node */
  live: boolean;
}

export function edgeMeaning(
  e: ThoughtEdge,
  routes: Routes,
  byId: Map<string, ThoughtNode>,
): EdgeMeaning {
  const route = routes.edge.get(e.id) ?? 'continue';
  const target = byId.get(e.target);
  return {
    route,
    reference: !!e.data?.isCrossLink && route !== 'material',
    live: !!e.data?.followsTip || (!!target && isAutoRerun(target.data)),
  };
}

export interface EdgePalette { accent: string; warm: string; material: string }

/** The arrowheads' marker ids, one per wire color (components/EdgeMarkers).
    React Flow takes a string markerEnd as the id of a marker already in the
    page, so the edges name these and draw no markers of their own. */
export const ARROW_IDS = {
  continue: 'tdag-arrow-continue',
  fork: 'tdag-arrow-fork',
  material: 'tdag-arrow-material',
  trace: 'tdag-arrow-trace',
} as const;

/** One dash for every reference (there used to be three). */
export const REFERENCE_DASH = '8 4';

export function edgeLook(m: EdgeMeaning, palette: EdgePalette): {
  style: CSSProperties;
  markerEnd: string;
  className?: string;
} {
  const stroke = m.route === 'material' ? palette.material : m.route === 'fork' ? palette.warm : palette.accent;
  return {
    style: { stroke, strokeWidth: 1.75, ...(m.reference ? { strokeDasharray: REFERENCE_DASH } : {}) },
    markerEnd: ARROW_IDS[m.route],
    className: [m.reference ? 'tdag-ref' : '', m.live ? 'tdag-live' : ''].filter(Boolean).join(' ') || undefined,
  };
}

// The wires as the canvas hands them to React Flow, kept by identity. React
// Flow re-renders a wire whenever the object it is handed changes, and the
// canvas derives its wires afresh on every store write — so every wire on
// screen used to re-render for each streaming chunk, each measurement.
const drawn = new WeakMap<ThoughtEdge, { meaning: EdgeMeaning; palette: EdgePalette; edge: ThoughtEdge }>();
const emphases = new WeakMap<ThoughtEdge, Map<string, ThoughtEdge>>();
const drawnLists = new WeakMap<ThoughtEdge[], ThoughtEdge[]>();

/** A wire wearing the look of what it means: the same object for as long
 *  as the stored edge, its meaning and the palette stay as they were. */
export function drawnEdge(e: ThoughtEdge, meaning: EdgeMeaning, palette: EdgePalette): ThoughtEdge {
  const hit = drawn.get(e);
  if (hit && hit.palette === palette && hit.meaning.route === meaning.route
    && hit.meaning.reference === meaning.reference && hit.meaning.live === meaning.live) return hit.edge;
  const look = edgeLook(meaning, palette);
  const edge: ThoughtEdge = { ...e, animated: false, style: look.style, markerEnd: look.markerEnd, className: look.className, data: { ...e.data, view: meaning } };
  drawn.set(e, { meaning, palette, edge });
  return edge;
}

/** One emphasis of a drawn wire (on the focus path, dimmed, ...), made once
 *  per wire and kind. `make` may read only the wire: whatever else the
 *  emphasis depends on belongs in `kind`. */
export function emphasized(e: ThoughtEdge, kind: string, make: (e: ThoughtEdge) => ThoughtEdge): ThoughtEdge {
  let kinds = emphases.get(e);
  if (!kinds) emphases.set(e, (kinds = new Map()));
  let out = kinds.get(kind);
  if (!out) kinds.set(kind, (out = make(e)));
  return out;
}

/** The drawn list for a stored edges array: the list handed out last when
 *  it holds the very same wires, so React Flow is handed no change at all. */
export function drawnList(edges: ThoughtEdge[], next: ThoughtEdge[]): ThoughtEdge[] {
  const last = drawnLists.get(edges);
  if (last && last.length === next.length && last.every((e, i) => e === next[i])) return last;
  drawnLists.set(edges, next);
  return next;
}
