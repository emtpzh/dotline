// A canvas from before steps, brought up to date as it loads: tool-call
// attachments become steps (lib/agents/steps), and every answer that was
// current against its upstream stays current. The steps' summary line
// reads differently now, so a recorded fingerprint is first checked the
// way that canvas compiled — if it matched then, it is re-recorded the way
// the canvas compiles now; an answer already stale stays stale.

import type { ThoughtEdge, ThoughtNode } from '../types';
import { liftSteps } from '../lib/agents/steps';
import { upstreamFingerprint } from './context-builder';

/** A run recorded the old way (agentSession.pending) becomes the binding
 *  the session sync finds its turn by (ThoughtData.run). */
function liftRuns(nodes: ThoughtNode[]): ThoughtNode[] {
  if (!nodes.some((n) => n.data.agentSession?.pending && !n.data.run)) return nodes;
  return nodes.map((n) => {
    const s = n.data.agentSession;
    if (!s?.pending || n.data.run) return n;
    const run = {
      runtime: s.runtime, question: n.data.question, startedAt: n.data.askedAt ?? n.data.lastGeneratedAt ?? new Date().toISOString(),
      ...(s.sessionId ? { sessionId: s.sessionId } : {}), ...(s.model ? { model: s.model } : {}), ...(s.changes ? { changes: s.changes } : {}),
    };
    return { ...n, data: { ...n.data, run, agentSession: { ...s, pending: undefined } } };
  });
}

export function liftCanvas(nodes: ThoughtNode[], edges: ThoughtEdge[]): ThoughtNode[] {
  nodes = liftRuns(nodes);
  const lifted = liftSteps(nodes);
  if (lifted === nodes) return nodes;
  return lifted.map((n) => {
    const recorded = n.data.lastContextHash;
    if (!recorded) return n;
    if (upstreamFingerprint(n.id, lifted, edges, { legacySummary: true }) !== recorded) return n;
    const now = upstreamFingerprint(n.id, lifted, edges);
    return now === recorded ? n : { ...n, data: { ...n.data, lastContextHash: now } };
  });
}
