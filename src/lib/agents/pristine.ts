// Whether a session can stand in for the canvas's context. A continued or
// forked agent session carries its own record of the conversation; the
// canvas may only lean on it while that record and the canvas agree.

import type { ThoughtEdge, ThoughtNode } from '../../types';
import { partitionContext } from '../graph';

/** An attachment that came out of the session itself (a tool call's
 *  footprint), not one the person added on the canvas. */
const fromSession = (a: { op?: unknown; name: string }): boolean => !!a.op || /^(tool|🔧|⌨️)/.test(a.name);

/**
 * Whether a session can stand in for the context the canvas would compile
 * for this node: nothing wired in beside the conversation (no materials, no
 * references), nothing on the question itself the session would not carry
 * (a document, a passage it was explored from), no canvas instruction (a
 * role) over the chain, and every turn above it a session turn nobody
 * edited on the canvas, added to, or reshaped on its way into context
 * (archived, highlight-filtered or -tagged). A continued or forked session
 * carries its own record of those turns — whatever the canvas changed would
 * silently not reach the agent. Collapse is only a view: it changes nothing.
 */
export function pristineChain(nodeId: string, nodes: ThoughtNode[], edges: ThoughtEdge[]): boolean {
  const { materials, references, mainline } = partitionContext(nodeId, nodes, edges);
  if (materials.length || references.length) return false;
  const self = mainline[mainline.length - 1];
  if (!self || self.id !== nodeId) return false;
  const selfExcluded = new Set(self.data.excludedAttachmentIds ?? []);
  if ((self.data.attachments ?? []).some((a) => !selfExcluded.has(a.id) && !a.type.startsWith('image/'))) return false;
  if (self.data.branchContext) return false;
  if (mainline.some((n) => n.data.rolePrompt)) return false;
  return mainline.slice(0, -1).every((n) => {
    const d = n.data;
    if (d.archived) return false;
    if ((d.highlightMode === 'filter' || d.highlightMode === 'tag') && (d.highlights?.length ?? 0) > 0) return false;
    const src = d.source;
    if (!d.importSource || !src) return false;
    // a turn the canvas sent with its context ahead records the whole
    // prompt; the question as asked ends it
    const q = d.question.trim();
    if (d.question !== src.question && !(q && src.question.trimEnd().endsWith(q))) return false;
    if (d.response !== src.response) return false;
    const excluded = new Set(d.excludedAttachmentIds ?? []);
    return (d.attachments ?? []).every((a) => excluded.has(a.id) || fromSession(a));
  });
}
