// A canvas from before steps, brought up to date as it loads: tool-call
// attachments become steps (lib/agents/steps), and every answer that was
// current against its upstream stays current. The steps' summary line
// reads differently now, so a recorded fingerprint is first checked the
// way that canvas compiled — if it matched then, it is re-recorded the way
// the canvas compiles now; an answer already stale stays stale.

import type { ThoughtEdge, ThoughtNode } from '../types';
import { liftSteps } from '../lib/agents/steps';
import { upstreamFingerprint } from './context-builder';

export function liftCanvas(nodes: ThoughtNode[], edges: ThoughtEdge[]): ThoughtNode[] {
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
