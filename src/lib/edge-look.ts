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
