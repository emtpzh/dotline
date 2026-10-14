// What a session sync does to a canvas, decided without touching it: the
// session as its importer builds it, against what the canvas has taken of
// it. Pure — lib/sessions/sync applies the plan.
//
// A session's nodes are UNITS, each with an id that survives every reread:
// a turn is its first item, a delegated run its call id, a compaction note
// the turn it stands before. The canvas keeps the units it has taken
// (Subscription.handled) — mirrored, or removed by hand and not to come
// back — so a unit is new exactly when its id is not there, wherever the
// file put it: after the tail, above it (a second client forking the
// session), beside a turn (a subagent's report arriving late).

import type { ThoughtEdge, ThoughtNode } from '../../types';

/** A canvas run waiting for its turn (ThoughtData.run), as the plan sees it. */
export interface Binding {
  nodeId: string;
  question: string;
  /** the turn it goes on from: its own comes later in the file */
  afterTurnId?: string;
  /** its last event arrived: the file holds all it will write */
  ended?: boolean;
  /** its turn: named by the run itself, or found by an earlier sync */
  turnId?: string;
  /** the run names its own turn (a run on a host that records runs): its
   *  turn is found by that id, never by the question's wording, and turns
   *  after the one it goes on from wait while it has not named it yet */
  exact?: boolean;
}

export interface SyncPlan {
  /** units taken by this sync */
  taken: string[];
  /** a canvas run's node and the session turn that is its */
  bound: { nodeId: string; fresh: ThoughtNode; unit: string }[];
  /** the built nodes to add, in build order */
  append: ThoughtNode[];
  /** taken units still on the canvas, with what the file says now */
  refresh: { nodeId: string; fresh: ThoughtNode }[];
}

/** Each built node's unit id (node id → unit). */
export function unitIds(nodes: ThoughtNode[], edges: ThoughtEdge[]): Map<string, string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, string>();
  for (const n of nodes) {
    const src = n.data.importSource;
    if (!src) continue;
    const first = src.itemIds?.[0];
    if (first) { out.set(n.id, first); continue; }
    if (n.data.stepKind === 'note') {
      const before = edges.map((e) => (e.source === n.id ? byId.get(e.target) : undefined)).find((t) => t?.data.importSource?.itemIds?.[0]);
      const k = before?.data.importSource?.itemIds?.[0];
      if (k) out.set(n.id, `note:${k}`);
    }
  }
  return out;
}

/** A ledger from before ids took the session's first `count` nodes (its
 *  importer's order, notes and delegated runs included): those, by id. */
export function legacyTaken(built: { nodes: ThoughtNode[]; edges: ThoughtEdge[] }, count: number): string[] {
  const ids = unitIds(built.nodes, built.edges);
  return built.nodes.filter((n) => n.data.importSource).slice(0, count).map((n) => ids.get(n.id)).filter((k): k is string => !!k);
}

const isTurn = (n: ThoughtNode) => !!n.data.importSource?.itemIds?.length && !n.data.importSource.subagent && n.data.stepKind !== 'note';

/** The question a session turn records ends with the one the canvas asked
 *  (the canvas's context may ride ahead of it), or is it. */
export function asksTheSame(recorded: string, asked: string): boolean {
  const a = recorded.trim();
  const b = asked.trim();
  return !!a && !!b && (a === b || a.endsWith(b) || b.endsWith(a));
}

export function planSync(input: {
  built: { nodes: ThoughtNode[]; edges: ThoughtEdge[] };
  handled: ReadonlySet<string>;
  /** the canvas's nodes of this session */
  canvas: ThoughtNode[];
  bindings: Binding[];
}): SyncPlan {
  const { built, handled, canvas, bindings } = input;
  const ids = unitIds(built.nodes, built.edges);
  const turns = built.nodes.filter(isTurn);
  const order = new Map(turns.map((n, i) => [ids.get(n.id)!, i]));
  const bound: SyncPlan['bound'] = [];
  const claimed = new Set<string>();
  // a session a run opened by forking holds the conversation it forked
  // from ahead of the run's own turn: the canvas has it already, as the
  // chain the run was asked off
  const inherited = new Set<string>();
  const inherit = (b: Binding, hit: ThoughtNode) => {
    if (b.afterTurnId !== undefined) return;
    for (const n of built.nodes.slice(0, built.nodes.indexOf(hit))) {
      const u = ids.get(n.id);
      if (u && !handled.has(u) && !claimed.has(u)) inherited.add(u);
    }
  };
  // turns after the one a running exact run goes on from, while it has not
  // named its own: one of them may be its turn, so none is taken as another's
  let holdFrom = Infinity;
  for (const b of bindings) {
    // named (by the run, or found before while it was written): that turn,
    // taken or not — the id is the turn's first item, or any item of it
    if (b.turnId) {
      const known = turns.find((n) => ids.get(n.id) === b.turnId) ?? turns.find((n) => n.data.importSource?.itemIds?.includes(b.turnId!));
      const unit = known ? ids.get(known.id)! : undefined;
      if (known && unit && !claimed.has(unit)) {
        claimed.add(unit);
        bound.push({ nodeId: b.nodeId, fresh: known, unit });
        inherit(b, known);
      }
      continue;
    }
    if (b.exact && !b.ended) {
      const from = b.afterTurnId !== undefined && order.has(b.afterTurnId) ? order.get(b.afterTurnId)! + 1 : 0;
      holdFrom = Math.min(holdFrom, from);
      continue;
    }
    const from = b.afterTurnId !== undefined && order.has(b.afterTurnId) ? order.get(b.afterTurnId)! + 1 : 0;
    const open = turns.slice(from).filter((n) => { const u = ids.get(n.id)!; return !handled.has(u) && !claimed.has(u); });
    // the turn asking this question; a run that is over takes the first one
    // after its own when the runtime recorded the question otherwise
    // (a run that names its turn and did not: by the wording alone)
    const hit = open.find((n) => asksTheSame(n.data.question, b.question)) ?? (b.ended && !b.exact ? open[0] : undefined);
    if (!hit) continue;
    const unit = ids.get(hit.id)!;
    claimed.add(unit);
    bound.push({ nodeId: b.nodeId, fresh: hit, unit });
    inherit(b, hit);
  }
  // everything the file holds from the first held turn on waits
  const heldTurn = Number.isFinite(holdFrom) ? turns.find((n) => order.get(ids.get(n.id)!)! >= holdFrom && !handled.has(ids.get(n.id)!) && !claimed.has(ids.get(n.id)!)) : undefined;
  const heldAt = heldTurn ? built.nodes.indexOf(heldTurn) : Infinity;
  const append = built.nodes.filter((n, i) => {
    const u = ids.get(n.id);
    return !!u && !handled.has(u) && !claimed.has(u) && !inherited.has(u) && i < heldAt;
  });
  const onCanvas = new Map<string, string>();
  for (const n of canvas) {
    const k = n.data.importSource?.itemIds?.[0];
    if (k) onCanvas.set(k, n.id);
  }
  const refresh: SyncPlan['refresh'] = [];
  for (const n of built.nodes) {
    const u = ids.get(n.id);
    if (!u || !handled.has(u) || claimed.has(u)) continue;
    const nodeId = onCanvas.get(u);
    if (nodeId) refresh.push({ nodeId, fresh: n });
  }
  return { taken: [...inherited, ...bound.map((b) => b.unit).filter((u) => !handled.has(u)), ...append.map((n) => ids.get(n.id)!)], bound, append, refresh };
}
