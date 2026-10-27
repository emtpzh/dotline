import type { CanvasEvent, ThoughtEdge, ThoughtNode } from '../../types';
import { frameMembers, frameRect, isFrameNode } from '../frames';
import { shortName } from '../node-face';
import { nodeHeight } from '../layout';
import { LAYOUT_COL_WIDTH } from '../constants';

// The organizer moves conversations between canvases, never pieces of one.
// A conversation ("thread" here) is everything that has to travel together:
// nodes joined by ANY edge — references included, so no edge ever spans two
// canvases — and a frame with everything inside it.

export interface StoredGraph { nodes: ThoughtNode[]; edges: ThoughtEdge[]; events: CanvasEvent[] }

export interface Thread {
  /** canvas id + its earliest node id: the same thread on the next open */
  id: string;
  canvasId: string;
  nodeIds: string[];
  title: string;
  /** names of its nodes, oldest first: what the model reads */
  turns: string[];
  lastAt: number;
  /** an agent run is bound to one of its nodes: it stays where it is */
  fixed: boolean;
}

const stamp = (n: ThoughtNode): number => {
  const s = n.data.askedAt ?? n.data.createdAt ?? n.data.lastGeneratedAt;
  const ms = s ? Date.parse(s) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/** Oldest first; nodes from before timestamps fall back to reading order. */
const byAge = (a: ThoughtNode, b: ThoughtNode) =>
  stamp(a) - stamp(b) || a.position.y - b.position.y || a.position.x - b.position.x;

export function splitThreads(canvasId: string, graph: Pick<StoredGraph, 'nodes' | 'edges'>, fallbackAt: number): Thread[] {
  const { nodes, edges } = graph;
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // compress the whole path, so long chains stay flat
    for (let c = id; c !== r;) { const up = parent.get(c)!; parent.set(c, r); c = up; }
    return r;
  };
  const join = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    parent.set(find(a), find(b));
  };
  for (const e of edges) join(e.source, e.target);
  for (const f of nodes.filter(isFrameNode)) for (const m of frameMembers(f, nodes)) join(f.id, m.id);

  const groups = new Map<string, ThoughtNode[]>();
  for (const n of nodes) {
    const r = find(n.id);
    const g = groups.get(r);
    if (g) g.push(n); else groups.set(r, [n]);
  }
  return [...groups.values()].map((members) => {
    const ordered = [...members].sort(byAge);
    const content = ordered.filter((n) => !isFrameNode(n));
    const names = (content.length ? content : ordered).map((n) => shortName(n.data)).filter(Boolean);
    const lastAt = members.reduce((m, n) => Math.max(m, stamp(n)), 0);
    return {
      id: `${canvasId}:${ordered[0].id}`,
      canvasId,
      nodeIds: members.map((n) => n.id),
      title: names[0] ?? '…',
      turns: names,
      lastAt: lastAt > 0 ? lastAt : fallbackAt,
      fixed: members.some((n) => !!n.data.run),
    };
  });
}

// ─── What the canvas list becomes ───────────────────────────────

export interface Group { key: string; name: string; reason: string; threadIds: string[] }

export interface OutcomeCanvas {
  /** an existing canvas kept (and possibly refilled), or null for a new one */
  id: string | null;
  name: string;
  threadIds: string[];
}

export interface Outcome { canvases: OutcomeCanvas[]; removed: string[] }

/**
 * Accepted groups become canvases; whatever no accepted group took stays
 * on the canvas it is on. A group named exactly like an existing canvas
 * keeps that canvas (its id, its place in the lists). A canvas left with
 * nothing is removed.
 */
export function outcomeOf(sources: { id: string; name: string }[], threads: Thread[], accepted: Group[]): Outcome {
  const used = new Set<string>();
  const made: OutcomeCanvas[] = accepted.map((g) => {
    const same = sources.find((c) => c.name === g.name && !used.has(c.id));
    if (same) used.add(same.id);
    return { id: same?.id ?? null, name: g.name, threadIds: [...g.threadIds] };
  });
  const taken = new Set(accepted.flatMap((g) => g.threadIds));
  for (const c of sources) {
    const rest = threads.filter((t) => t.canvasId === c.id && !taken.has(t.id)).map((t) => t.id);
    if (!rest.length) continue;
    const kept = made.find((m) => m.id === c.id);
    if (kept) kept.threadIds.push(...rest);
    else made.push({ id: c.id, name: c.name, threadIds: rest });
  }
  const finalIds = new Set(made.map((m) => m.id));
  return { canvases: made, removed: sources.filter((c) => !finalIds.has(c.id)).map((c) => c.id) };
}

// ─── Moving threads ─────────────────────────────────────────────

const GAP = 160;

type Box = { minX: number; minY: number; maxX: number; maxY: number };

function boxOf(nodes: ThoughtNode[]): Box | null {
  if (!nodes.length) return null;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const n of nodes) {
    const r = isFrameNode(n) ? frameRect(n) : { x: n.position.x, y: n.position.y, width: n.measured?.width ?? n.width ?? LAYOUT_COL_WIDTH, height: nodeHeight(n) };
    b.minX = Math.min(b.minX, r.x);
    b.minY = Math.min(b.minY, r.y);
    b.maxX = Math.max(b.maxX, r.x + r.width);
    b.maxY = Math.max(b.maxY, r.y + r.height);
  }
  return b;
}

/**
 * One canvas's graph after the rebuild: what it keeps of its own, then each
 * incoming thread set to the right of everything already there. A thread
 * moves as a block — its own layout, arrow order and frames untouched.
 */
export function composeGraph(base: StoredGraph | null, keepThreads: Thread[], incoming: { thread: Thread; graph: StoredGraph }[]): StoredGraph {
  const keepIds = new Set(keepThreads.flatMap((t) => t.nodeIds));
  const nodes = (base?.nodes ?? []).filter((n) => keepIds.has(n.id));
  const edges = (base?.edges ?? []).filter((e) => keepIds.has(e.source));
  // events about what left go with it; the rest (the canvas as a whole,
  // objects long deleted) stay
  const leaving = new Set([
    ...(base?.nodes ?? []).filter((n) => !keepIds.has(n.id)).map((n) => n.id),
    ...(base?.edges ?? []).filter((e) => !keepIds.has(e.source)).map((e) => e.id),
  ]);
  const events = (base?.events ?? []).filter((ev) => !ev.id || !leaving.has(ev.id));

  const here = boxOf(nodes);
  let cursor = here ? here.maxX + GAP : 0;
  const top = here ? here.minY : 0;
  for (const { thread, graph } of incoming) {
    const ids = new Set(thread.nodeIds);
    const moving = graph.nodes.filter((n) => ids.has(n.id));
    const b = boxOf(moving);
    if (!b) continue;
    const dx = cursor - b.minX, dy = top - b.minY;
    nodes.push(...moving.map((n) => ({ ...n, selected: false, position: { x: n.position.x + dx, y: n.position.y + dy } })));
    const movingEdges = graph.edges.filter((e) => ids.has(e.source));
    edges.push(...movingEdges.map((e) => (e.selected ? { ...e, selected: false } : e)));
    const edgeIds = new Set(movingEdges.map((e) => e.id));
    events.push(...graph.events.filter((ev) => ev.id && (ids.has(ev.id) || edgeIds.has(ev.id))));
    cursor += b.maxX - b.minX + GAP;
  }
  events.sort((a, b) => a.t.localeCompare(b.t));
  return { nodes, edges, events };
}
