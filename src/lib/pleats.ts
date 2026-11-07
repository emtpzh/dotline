import type { ThoughtEdge, ThoughtNode } from '../types';
import { awaitingInput } from '../utils';
import { nodeConclusion, nodeName } from './node-face';
import { LONG_CHAIN } from './constants';

// Folding a long chain: a run of consecutive turns on one column shows as
// ONE strip on the canvas — the pleat. It is view state only, like a card's
// fold: the turns, their wires and every context stay exactly as they are.
// A turn inside a pleat carries `inPleat`; consecutive ones on a column are
// one pleat, which the run's first turn draws (App: the rest are hidden and
// the wires that touched them are drawn to the pleat). Layout treats the run
// as one card of the pleat's height (pleatLayoutView, used by lib/layout).
//
// Which runs fold is a plan over one chain:
//   gather — keep the head, the landmarks (a decision, a pivot, an open
//            question, the person's highlights, anything wired beyond the
//            chain) and the last turns; fold the ordinary stretches between;
//   middle — keep the head and the tail; fold everything between.
// A lone turn is never worth a pleat: a run of one unfolds.

const MATERIAL = new Set(['note', 'file', 'link', 'frame']);
const isTurn = (n: ThoughtNode) => !MATERIAL.has(n.data.stepKind ?? '');
/** the last turns stay open: they are the working context (condense's frontier rule) */
const FRONTIER = 2;

/** One WeakMap cache keyed by both arrays: computed once per store update,
 *  shared by every card that asks during the same render. */
function memo2<T>(fn: (nodes: ThoughtNode[], edges: ThoughtEdge[]) => T): (nodes: ThoughtNode[], edges: ThoughtEdge[]) => T {
  const cache = new WeakMap<ThoughtNode[], WeakMap<ThoughtEdge[], T>>();
  return (nodes, edges) => {
    let inner = cache.get(nodes);
    if (!inner) { inner = new WeakMap(); cache.set(nodes, inner); }
    if (!inner.has(edges)) inner.set(edges, fn(nodes, edges));
    return inner.get(edges)!;
  };
}

const byIdCache = new WeakMap<ThoughtNode[], Map<string, ThoughtNode>>();
function byIdOf(nodes: ThoughtNode[]): Map<string, ThoughtNode> {
  let m = byIdCache.get(nodes);
  if (!m) { m = new Map(nodes.map((n) => [n.id, n])); byIdCache.set(nodes, m); }
  return m;
}

/** Who continues whose column — the rule layout seats by (classifyChildren
 *  with its claimant): a parent's first plain wire continues it, unless the
 *  child it reaches is claimed by another parent it continues from. */
export interface Columns {
  down: Map<string, string>;
  up: Map<string, string>;
}

export const columnsOf = memo2((nodes, edges): Columns => {
  const byId = byIdOf(nodes);
  const turn = (id: string) => { const n = byId.get(id); return !!n && isTurn(n); };
  const structural = edges.filter((e) => !e.data?.isCrossLink && e.source !== e.target && turn(e.source) && turn(e.target));
  const parents = new Map<string, ThoughtEdge[]>();
  const kids = new Map<string, ThoughtEdge[]>();
  for (const e of structural) {
    parents.set(e.target, [...(parents.get(e.target) ?? []), e]);
    kids.set(e.source, [...(kids.get(e.source) ?? []), e]);
  }
  const claimant = (child: string) => {
    const ps = parents.get(child) ?? [];
    return (ps.find((e) => !e.data?.isBranchFromSelection) ?? ps[0])?.source;
  };
  const down = new Map<string, string>();
  const up = new Map<string, string>();
  for (const [p, es] of kids) {
    const cont = es.find((e) => !e.data?.isBranchFromSelection && claimant(e.target) === p);
    if (cont && !up.has(cont.target)) {
      down.set(p, cont.target);
      up.set(cont.target, p);
    }
  }
  return { down, up };
});

/** The chain (one column) through a turn, head first. */
export function chainThrough(cols: Columns, id: string): string[] {
  let head = id;
  const seen = new Set([id]);
  for (let p = cols.up.get(head); p && !seen.has(p); p = cols.up.get(head)) {
    seen.add(p);
    head = p;
  }
  const out = [head];
  const inChain = new Set(out);
  for (let c = cols.down.get(head); c && !inChain.has(c); c = cols.down.get(c)) {
    out.push(c);
    inChain.add(c);
  }
  return out;
}

/** A run of consecutive folded turns, head first: one pleat. */
export interface PleatRun { head: string; ids: string[] }

export const pleatRuns = memo2((nodes, edges): PleatRun[] => {
  if (!nodes.some((n) => n.data.inPleat)) return [];
  const cols = columnsOf(nodes, edges);
  const byId = byIdOf(nodes);
  const folded = (id: string | undefined) => !!id && !!byId.get(id)?.data.inPleat;
  const runs: PleatRun[] = [];
  for (const n of nodes) {
    if (!n.data.inPleat || !isTurn(n) || folded(cols.up.get(n.id))) continue;
    const ids = [n.id];
    for (let c = cols.down.get(n.id); folded(c) && !ids.includes(c!); c = cols.down.get(c!)) ids.push(c!);
    runs.push({ head: n.id, ids });
  }
  return runs;
});

/** Every folded turn → the head of its pleat (heads map to themselves). */
export function pleatHeads(runs: PleatRun[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of runs) for (const id of r.ids) out.set(id, r.head);
  return out;
}

// ─── Layout's view: a pleat is one card ─────────────────────────

export interface PleatLayoutView {
  nodes: ThoughtNode[];
  edges: ThoughtEdge[];
  /** the laid-out view back over the whole canvas: folded turns sit at their pleat */
  expand: (laid: ThoughtNode[]) => ThoughtNode[];
}

/**
 * The canvas as layout should see it: each run reduced to its head (whose
 * height is the pleat's, see layout nodeHeight), wires to the folded turns
 * drawn to the head, wires inside a run gone. What leaves a run other than
 * its own continuation is marked as explored out of the pleat, so it hangs
 * beside the strip and can never take over the column; what enters a folded
 * turn from elsewhere likewise, so the pleat stays under its own parent.
 * Null when nothing is folded.
 */
export function pleatLayoutView(nodes: ThoughtNode[], edges: ThoughtEdge[]): PleatLayoutView | null {
  const runs = pleatRuns(nodes, edges);
  if (runs.length === 0) return null;
  const headOf = pleatHeads(runs);
  const cols = columnsOf(nodes, edges);
  const exits = new Set<string>();
  for (const r of runs) {
    const tail = r.ids[r.ids.length - 1];
    const below = cols.down.get(tail);
    const exit = below && edges.find((e) => e.source === tail && e.target === below && !e.data?.isCrossLink && !e.data?.isBranchFromSelection);
    if (exit) exits.add(exit.id);
  }
  const viewEdges: ThoughtEdge[] = [];
  for (const e of edges) {
    const sh = headOf.get(e.source);
    const th = headOf.get(e.target);
    if (sh && sh === th) continue;
    let v: ThoughtEdge = sh || th ? { ...e, source: sh ?? e.source, target: th ?? e.target } : e;
    const leaves = !!sh && !exits.has(e.id);
    const entersMember = !!th && th !== e.target;
    if ((leaves || entersMember) && !e.data?.isCrossLink && !e.data?.isBranchFromSelection) {
      v = { ...v, data: { ...v.data, isBranchFromSelection: true } };
    }
    viewEdges.push(v);
  }
  const viewNodes = nodes.filter((n) => (headOf.get(n.id) ?? n.id) === n.id);
  return {
    nodes: viewNodes,
    edges: viewEdges,
    expand: (laid) => {
      if (laid === viewNodes) return nodes;
      const out = new Map(laid.map((n) => [n.id, n]));
      return nodes.map((n) => {
        const head = headOf.get(n.id);
        if (!head || head === n.id) return out.get(n.id) ?? n;
        const p = out.get(head)?.position;
        return !p || (p.x === n.position.x && p.y === n.position.y) ? n : { ...n, position: { x: p.x, y: p.y } };
      });
    },
  };
}

/** Run a layout pass over the folded view, then hand the whole canvas back. */
export function throughPleats(nodes: ThoughtNode[], edges: ThoughtEdge[], pass: (nodes: ThoughtNode[], edges: ThoughtEdge[]) => ThoughtNode[]): ThoughtNode[] {
  const view = pleatLayoutView(nodes, edges);
  return view ? view.expand(pass(view.nodes, view.edges)) : pass(nodes, edges);
}

// ─── Plans: which turns of a chain fold ─────────────────────────

const moveOf = (n: ThoughtNode) => n.data.summaryTypes?.[n.data.responseIndex] ?? undefined;

/** Never folded: placed by hand, or in a state the person must see. */
const held = (n: ThoughtNode) => !!n.data.layoutPinned || n.data.isLoading || !!n.data.generationFailed || !!awaitingInput(n.data);

/** Why a turn stays in sight when a chain is gathered — all of it data the
 *  canvas already has: the judged move, the person's marks, the wiring. */
function landmark(n: ThoughtNode, wired: Set<string>): boolean {
  const move = moveOf(n);
  return move === 'decision' || move === 'pivot' || move === 'open'
    || n.data.highlights.length > 0 || wired.has(n.id);
}

/** Turns of the chain with any wire besides the chain's own links. */
function wiredBeyond(chain: string[], cols: Columns, edges: ThoughtEdge[]): Set<string> {
  const inChain = new Set(chain);
  const out = new Set<string>();
  for (const e of edges) {
    if (!e.data?.isCrossLink && cols.down.get(e.source) === e.target && inChain.has(e.source)) continue;
    if (inChain.has(e.source)) out.add(e.source);
    if (inChain.has(e.target)) out.add(e.target);
  }
  return out;
}

/** Folds every stretch of `foldable` turns two or longer; the rest open. */
function planRuns(chain: ThoughtNode[], foldable: (n: ThoughtNode, i: number) => boolean): Map<string, boolean> {
  const plan = new Map<string, boolean>();
  let run: ThoughtNode[] = [];
  const flush = () => {
    for (const n of run) plan.set(n.id, run.length >= 2);
    run = [];
  };
  chain.forEach((n, i) => {
    if (foldable(n, i)) { run.push(n); return; }
    flush();
    plan.set(n.id, false);
  });
  flush();
  return plan;
}

export type FoldPlanKind = 'gather' | 'middle' | 'open';

/** The fold state a chain should take, turn by turn (true = in a pleat). */
export function chainPlan(nodes: ThoughtNode[], edges: ThoughtEdge[], id: string, kind: FoldPlanKind): Map<string, boolean> {
  const cols = columnsOf(nodes, edges);
  const byId = byIdOf(nodes);
  const ids = chainThrough(cols, id);
  const chain = ids.map((i) => byId.get(i)).filter((n): n is ThoughtNode => !!n);
  if (kind === 'open') return new Map(chain.map((n) => [n.id, false]));
  const last = chain.length - 1;
  if (kind === 'middle') return planRuns(chain, (n, i) => i > 0 && i < last && !held(n));
  const wired = wiredBeyond(ids, cols, edges);
  return planRuns(chain, (n, i) => i > 0 && i < chain.length - FRONTIER && !held(n) && !landmark(n, wired));
}

/** A run of one is not a pleat: it opens. */
export function withoutLoneFolds(nodes: ThoughtNode[], edges: ThoughtEdge[]): ThoughtNode[] {
  const lone = new Set(pleatRuns(nodes, edges).filter((r) => r.ids.length < 2).map((r) => r.head));
  if (lone.size === 0) return nodes;
  return nodes.map((n) => (lone.has(n.id) ? { ...n, data: { ...n.data, inPleat: undefined } } : n));
}

/**
 * Apply a fold plan: the flags, plus where each affected turn starts — a
 * turn sinking into a pleat sits at the pleat's spot, a turn coming out of
 * one starts there and glides down — and the turns to settle from (the top
 * of each changed stretch, which stays where it is; layout re-hangs what
 * grows out of it). Null when the plan changes nothing.
 */
export function applyFoldPlan(nodes: ThoughtNode[], edges: ThoughtEdge[], plan: Map<string, boolean>): { nodes: ThoughtNode[]; sources: string[] } | null {
  const before = pleatRuns(nodes, edges);
  let flagged = nodes.map((n) => {
    const want = plan.get(n.id);
    if (want === undefined || !!n.data.inPleat === want || !isTurn(n)) return n;
    return { ...n, data: { ...n.data, inPleat: want || undefined } };
  });
  flagged = withoutLoneFolds(flagged, edges);
  const changed = flagged.filter((n, i) => n !== nodes[i]).map((n) => n.id);
  if (changed.length === 0) return null;

  const after = pleatRuns(flagged, edges);
  const key = (r: PleatRun) => r.ids.join('\u0000');
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  const affected = new Set(changed);
  for (const r of before) if (!afterKeys.has(key(r))) for (const id of r.ids) affected.add(id);
  for (const r of after) if (!beforeKeys.has(key(r))) for (const id of r.ids) affected.add(id);

  // the top of each changed stretch stays; a stretch further down what one
  // of those tops grows into re-hangs with the rest of it
  const cols = columnsOf(flagged, edges);
  const tops = new Set([...affected].filter((id) => { const up = cols.up.get(id); return !up || !affected.has(up); }));
  const kids = new Map<string, string[]>();
  for (const e of edges) if (!e.data?.isCrossLink) kids.set(e.source, [...(kids.get(e.source) ?? []), e.target]);
  const below = new Set<string>();
  for (const top of tops) {
    const stack = [...(kids.get(top) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (below.has(id)) continue;
      below.add(id);
      stack.push(...(kids.get(id) ?? []));
    }
  }
  const sources = [...tops].filter((id) => !below.has(id));
  const posOf = new Map(nodes.map((n) => [n.id, n.position]));
  const oldHead = pleatHeads(before);
  const newHead = pleatHeads(after);
  const spot = (id: string) => posOf.get(oldHead.get(id) ?? id)!;
  const placed = flagged.map((n) => {
    if (!affected.has(n.id) || tops.has(n.id)) return n;
    const p = spot(newHead.get(n.id) ?? n.id);
    return p.x === n.position.x && p.y === n.position.y ? n : { ...n, position: { x: p.x, y: p.y } };
  });
  return { nodes: placed, sources };
}

// ─── What the canvas shows ──────────────────────────────────────

/** Where a chain stands: its length, how many turns are folded now, how
 *  many each plan would fold and whether the chain already is that way. */
export interface ChainFolds {
  turns: number;
  folded: number;
  gather: number;
  gathered: boolean;
  middle: number;
  middled: boolean;
}

export function chainFolds(nodes: ThoughtNode[], edges: ThoughtEdge[], id: string): ChainFolds | null {
  const ids = chainThrough(columnsOf(nodes, edges), id);
  if (ids.length < 3) return null;
  const byId = byIdOf(nodes);
  const isIn = (i: string) => !!byId.get(i)?.data.inPleat;
  const sum = (kind: FoldPlanKind): [number, boolean] => {
    let n = 0;
    let same = true;
    for (const [i, on] of chainPlan(nodes, edges, id, kind)) {
      if (on) n++;
      if (on !== isIn(i)) same = false;
    }
    return [n, same];
  };
  const [gather, gathered] = sum('gather');
  const [middle, middled] = sum('middle');
  return { turns: ids.length, folded: ids.filter(isIn).length, gather, gathered, middle, middled };
}

/** ChainFolds as one string, so a selector stays stable while nothing about
 *  the chain changes ('' = no chain worth folding). */
export function chainFoldsKey(nodes: ThoughtNode[], edges: ThoughtEdge[], id: string): string {
  const f = chainFolds(nodes, edges, id);
  return f ? [f.turns, f.folded, f.gather, +f.gathered, f.middle, +f.middled].join(':') : '';
}

export function parseChainFolds(key: string): ChainFolds | null {
  if (!key) return null;
  const [turns, folded, gather, gathered, middle, middled] = key.split(':').map(Number);
  return { turns, folded, gather, gathered: !!gathered, middle, middled: !!middled };
}

/** The same, only under the head of a long chain (the pill's card). */
export function chainPillKey(nodes: ThoughtNode[], edges: ThoughtEdge[], id: string): string {
  const cols = columnsOf(nodes, edges);
  if (cols.up.has(id) || !cols.down.has(id)) return '';
  if (byIdOf(nodes).get(id)?.data.inPleat) return '';
  if (chainThrough(cols, id).length < LONG_CHAIN) return '';
  return chainFoldsKey(nodes, edges, id);
}

/** A visible turn next to a pleat on its column: it can fold into it. */
export function besidePleat(nodes: ThoughtNode[], edges: ThoughtEdge[], id: string): boolean {
  // every card asks on every store update: two cached lookups, never a scan
  const byId = byIdOf(nodes);
  const n = byId.get(id);
  if (!n || n.data.inPleat || held(n)) return false;
  const cols = columnsOf(nodes, edges);
  const folded = (other: string | undefined) => !!other && !!byId.get(other)?.data.inPleat;
  return folded(cols.up.get(id)) || folded(cols.down.get(id));
}

/** The selection as one stretch of a single column (two or more turns, in
 *  chain order), or null when it is anything else. */
export function contiguousStretch(nodes: ThoughtNode[], edges: ThoughtEdge[], ids: string[]): string[] | null {
  if (ids.length < 2) return null;
  const byId = byIdOf(nodes);
  if (ids.some((id) => { const n = byId.get(id); return !n || !isTurn(n) || n.data.inPleat || held(n); })) return null;
  const chain = chainThrough(columnsOf(nodes, edges), ids[0]);
  const at = ids.map((id) => chain.indexOf(id)).sort((a, b) => a - b);
  if (at[0] < 0 || at[at.length - 1] - at[0] !== ids.length - 1) return null;
  return chain.slice(at[0], at[0] + ids.length);
}

/** One folded turn as its pleat shows it. */
export interface PleatTurn {
  id: string;
  /** its place on the chain, 1-based */
  n: number;
  name: string;
  move: string | null;
  question: string;
  conclusion: string;
  marked: boolean;
  /** a branch leaves this turn */
  fork: boolean;
  at: string | null;
}

/** What a pleat draws for its turns, as one string (stable for a selector). */
export function pleatTurnsKey(nodes: ThoughtNode[], edges: ThoughtEdge[], ids: string[]): string {
  const byId = byIdOf(nodes);
  const cols = columnsOf(nodes, edges);
  const chain = chainThrough(cols, ids[0]);
  const forks = new Set(edges
    .filter((e) => !e.data?.isCrossLink && ids.includes(e.source) && cols.down.get(e.source) !== e.target && !!byId.get(e.target) && isTurn(byId.get(e.target)!))
    .map((e) => e.source));
  const turns: PleatTurn[] = [];
  for (const id of ids) {
    const n = byId.get(id);
    if (!n) continue;
    const d = n.data;
    turns.push({
      id,
      n: chain.indexOf(id) + 1,
      name: nodeName(d) ?? '',
      move: moveOf(n) ?? null,
      question: d.question.replace(/\s+/g, ' ').trim().slice(0, 160),
      conclusion: nodeConclusion(d) ?? '',
      marked: d.highlights.length > 0,
      fork: forks.has(id),
      at: d.askedAt ?? d.createdAt ?? null,
    });
  }
  return JSON.stringify(turns);
}
