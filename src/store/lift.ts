// A canvas from before steps, brought up to date as it loads: tool-call
// attachments become steps (lib/agents/steps), a canvas run's old record
// (agentSession) folds into what the node keeps now, and every answer that
// was current against its upstream stays current. The steps' summary line
// reads differently now, so a recorded fingerprint is first checked the
// way that canvas compiled — if it matched then, it is re-recorded the way
// the canvas compiles now; an answer already stale stays stale.

import type { AgentAccess, AgentRunBinding, AgentRuntime, ThoughtData, ThoughtEdge, ThoughtNode } from '../types';
import { liftSteps } from '../lib/agents/steps';
import { upstreamFingerprint } from './context-builder';

/** What a canvas run recorded before bindings and turn configs. */
type LegacyRun = {
  runtime: AgentRuntime; sessionId: string | null; sessionFile?: string | null; cwd: string;
  effort?: string; access?: AgentAccess; model?: string; pending?: boolean;
  changes?: AgentRunBinding['changes'];
};

/** The run record of before (agentSession) folded into what the canvas
 *  keeps now: a run still pending becomes its binding (ThoughtData.run), the
 *  level and directory it ran at the node's own, the model and effort its
 *  version's record. Its session and turn are the node's provenance
 *  (importSource), when it has any; the record itself goes. */
function liftAgentSessions(nodes: ThoughtNode[]): ThoughtNode[] {
  const legacyOf = (n: ThoughtNode) => (n.data as { agentSession?: LegacyRun }).agentSession;
  if (!nodes.some((n) => legacyOf(n))) return nodes;
  return nodes.map((n) => {
    const s = legacyOf(n);
    if (!s) return n;
    const d = { ...n.data } as ThoughtData & { agentSession?: LegacyRun };
    delete d.agentSession;
    if (s.pending && !d.run) {
      d.run = {
        runtime: s.runtime, question: d.question, startedAt: d.askedAt ?? d.lastGeneratedAt ?? new Date().toISOString(),
        ...(s.sessionId ? { sessionId: s.sessionId } : {}), ...(s.model ? { model: s.model } : {}), ...(s.changes ? { changes: s.changes } : {}),
      };
    }
    if (d.access === undefined && s.access) d.access = s.access;
    if (d.cwd === undefined && s.cwd) d.cwd = s.cwd;
    const i = d.responseIndex;
    if (i >= 0 && i < d.responses.length) {
      if (s.model && !d.generatedBy?.[i]) d.generatedBy = Object.assign([...(d.generatedBy ?? [])], { [i]: s.model });
      if (s.effort && !d.generatedEfforts?.[i]) d.generatedEfforts = Object.assign([...(d.generatedEfforts ?? [])], { [i]: s.effort });
    }
    return { ...n, data: d };
  });
}

export function liftCanvas(nodes: ThoughtNode[], edges: ThoughtEdge[]): ThoughtNode[] {
  const stepped = liftSteps(nodes);
  const lifted = liftAgentSessions(stepped);
  if (lifted === nodes) return nodes;
  return lifted.map((n) => {
    const recorded = n.data.lastContextHash;
    if (!recorded) return n;
    const now = upstreamFingerprint(n.id, lifted, edges);
    if (now === recorded) return n;
    // current the way the canvas compiled before the lift: current still
    const before = upstreamFingerprint(n.id, stepped, edges, stepped !== nodes ? { legacySummary: true } : undefined);
    return before === recorded ? { ...n, data: { ...n.data, lastContextHash: now } } : n;
  });
}
