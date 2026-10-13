// Whether a question goes on in the agent session above it. One vertical
// line on the canvas is one agent session: a turn that continues it grows
// straight below; a turn that cannot — another runtime, another directory,
// a role, anything the canvas wired in that the session never saw — opens a
// new session and grows beside it, as a fork, with the reason written on it.
// The ask boxes read this BEFORE sending (the person hears what a question
// will cost while it can still be changed), and the run reads the same
// function when it leaves (agentOutbound), so the warning and what happens
// are one decision.

import type { AgentRuntime, ThoughtData, ThoughtEdge, ThoughtNode } from '../../types';
import { AGENT_RUNTIMES } from './runtimes';
import { whyNotPristine } from './pristine';
import { turnOf } from '../sessions/turn';

export type SessionBreak =
  | 'runtime' | 'cwd' | 'role' | 'material' | 'reference' | 'merge'
  | 'attachment' | 'passage' | 'edited' | 'no-fork' | 'unfollowed' | 'missing'
  /** the directory the session ran in is not there any more */
  | 'gone';

export type Continuity =
  /** only the question travels: the session holds the conversation; `turn`
      is the turn of the session the question becomes */
  | { kind: 'continue'; parentId: string; runtime: AgentRuntime; sessionId: string; turn: number }
  /** a new session holding the conversation up to the parent's turn */
  | { kind: 'fork'; parentId: string; runtime: AgentRuntime; sessionId: string; turn: number }
  /** a new session carrying the canvas's compiled text, nothing else */
  | { kind: 'new'; parentId: string; reason: SessionBreak; about?: string; detail?: string };

/** What a node records about the session its turn left from — shown on
 *  its card and its wire long after the send (types: ThoughtData.sessionLink). */
export type SessionLink = { kind: 'new'; reason: SessionBreak; about?: string; detail?: string } | { kind: 'fork'; turn: number };

export function linkOf(c: Continuity | null | undefined): SessionLink | undefined {
  if (!c || c.kind === 'continue') return undefined;
  if (c.kind === 'fork') return { kind: 'fork', turn: c.turn };
  return { kind: 'new', reason: c.reason, ...(c.about ? { about: c.about } : {}), ...(c.detail ? { detail: c.detail } : {}) };
}

/** The sessions this canvas mirrors and where each one's tail is. */
export interface LedgerEntry { runner: string; sessionId: string; tailNodeId: string }
let ledgerSource: () => LedgerEntry[] = () => [];
/** The project store hands over its ledger (it cannot be imported from here). */
export function setLedgerSource(fn: () => LedgerEntry[]): void { ledgerSource = fn; }
export function canvasLedger(): LedgerEntry[] { return ledgerSource(); }

/** The agent session a node's turn lives in, if it lives in one, and the
 *  directory it goes on in. */
export function sessionOf(data: Partial<Pick<ThoughtData, 'importSource' | 'agentSession'>>): { runtime: AgentRuntime; sessionId: string; cwd: string | null } | null {
  const turn = turnOf(data);
  return turn ? { runtime: turn.runtime, sessionId: turn.sessionId, cwd: turn.resumeCwd } : null;
}

/** Which turn of its session a node is, counting from the session's first. */
function turnNumber(node: ThoughtNode, sessionId: string, byId: Map<string, ThoughtNode>, edges: ThoughtEdge[]): number {
  let n = 0;
  let cur: ThoughtNode | undefined = node;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id) && sessionOf(cur.data)?.sessionId === sessionId) {
    seen.add(cur.id);
    n++;
    const id: string = cur.id;
    const up: ThoughtEdge | undefined = edges.find((e) => e.target === id && !e.data?.isCrossLink && sessionOf(byId.get(e.source)?.data ?? {})?.sessionId === sessionId);
    cur = up ? byId.get(up.source) : undefined;
  }
  return n;
}

/**
 * Where the turn of `nodeId` would run, given the runtime it runs on (null:
 * an ordinary model) and its directory (undefined: whatever it inherits,
 * which is the parent's session directory). null when no agent session sits
 * above it — an ordinary chain has nothing to continue or to break.
 */
export function continuity(
  nodeId: string,
  nodes: ThoughtNode[],
  edges: ThoughtEdge[],
  runtime: AgentRuntime | null,
  cwd: string | undefined,
  ledger: LedgerEntry[] = canvasLedger(),
): Continuity | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = edges.filter((e) => e.target === nodeId);
  const parents = incoming
    .filter((e) => !e.data?.isCrossLink)
    .map((e) => byId.get(e.source))
    .filter((n): n is ThoughtNode => !!n && !['note', 'file', 'link'].includes(n.data.stepKind ?? ''));
  const parent = parents.find((p) => sessionOf(p.data));
  if (!parent) return null;
  const session = sessionOf(parent.data)!;
  const parentId = parent.id;
  const broken = (reason: SessionBreak, extra: { about?: string; detail?: string } = {}): Continuity => ({ kind: 'new', parentId, reason, ...extra });
  if (runtime !== session.runtime) return broken('runtime', runtime ? { detail: AGENT_RUNTIMES[runtime].label } : {});
  if (cwd !== undefined && session.cwd && cwd !== session.cwd) return broken('cwd', { detail: cwd });
  if (parents.length > 1) return broken('merge');
  const why = whyNotPristine(nodeId, nodes, edges);
  if (why) return broken(why.reason, 'nodeId' in why ? { about: why.nodeId } : {});
  if (incoming.length !== 1) return broken('reference');
  const entry = ledger.find((e) => e.runner === runtime && e.sessionId && e.tailNodeId === parentId);
  if (entry) return { kind: 'continue', parentId, runtime, sessionId: entry.sessionId, turn: turnNumber(parent, session.sessionId, byId, edges) + 1 };
  const src = parent.data.importSource;
  if (AGENT_RUNTIMES[runtime].caps.forkAt && src?.runner === runtime && src.sessionId && src.itemIds?.length) {
    return { kind: 'fork', parentId, runtime, sessionId: src.sessionId, turn: turnNumber(parent, src.sessionId, byId, edges) };
  }
  // the parent is its session's last turn here, but the canvas does not
  // follow that session (its ledger does not name the tail): nothing to go on in
  const later = edges.some((e) => e.source === parentId && e.target !== nodeId && sessionOf(byId.get(e.target)?.data ?? {})?.sessionId === session.sessionId);
  return broken(later ? 'no-fork' : 'unfollowed');
}
