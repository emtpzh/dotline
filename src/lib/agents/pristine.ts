// Whether a session can stand in for the canvas's context. A continued or
// forked agent session carries its own record of the conversation; the
// canvas may only lean on it while that record and the canvas agree.

import type { ThoughtEdge, ThoughtNode } from '../../types';
import { partitionContext } from '../graph';

/** Why the canvas's context for a node has moved away from what its session
 *  recorded — each one a reason a follow-up cannot lean on that session. */
export type Unpristine =
  | { reason: 'material'; nodeId: string }
  | { reason: 'reference'; nodeId: string }
  | { reason: 'attachment' }
  | { reason: 'passage' }
  | { reason: 'role'; nodeId: string }
  | { reason: 'edited'; nodeId: string };

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
 * null = pristine; otherwise the first thing that is not, to say out loud.
 */
export function whyNotPristine(nodeId: string, nodes: ThoughtNode[], edges: ThoughtEdge[]): Unpristine | null {
  const { materials, references, mainline } = partitionContext(nodeId, nodes, edges);
  const self = mainline[mainline.length - 1];
  if (!self || self.id !== nodeId) return { reason: 'edited', nodeId };
  // what the person just did on this question outranks what the chain holds
  const role = [...mainline].reverse().find((n) => n.data.rolePrompt);
  if (role) return { reason: 'role', nodeId: role.id };
  if (self.data.branchContext) return { reason: 'passage' };
  const selfExcluded = new Set(self.data.excludedAttachmentIds ?? []);
  if ((self.data.attachments ?? []).some((a) => !selfExcluded.has(a.id) && !a.type.startsWith('image/'))) return { reason: 'attachment' };
  if (references.length) return { reason: 'reference', nodeId: references[0].source.id };
  if (materials.length) return { reason: 'material', nodeId: materials[0].id };
  const edited = mainline.slice(0, -1).find((n) => {
    const d = n.data;
    if (d.archived) return true;
    if ((d.highlightMode === 'filter' || d.highlightMode === 'tag') && (d.highlights?.length ?? 0) > 0) return true;
    const src = d.source;
    if (!d.importSource || !src) return true;
    // a turn the canvas sent with its context ahead records the whole
    // prompt; the question as asked ends it
    const q = d.question.trim();
    if (d.question !== src.question && !(q && src.question.trimEnd().endsWith(q))) return true;
    if (d.response !== src.response) return true;
    const excluded = new Set(d.excludedAttachmentIds ?? []);
    // an image the question carried went into the session with it; one
    // added after the turn last ran is the canvas's own
    const sentImage = (a: { type: string; addedAt?: string }) =>
      a.type.startsWith('image/') && (!a.addedAt || !d.lastGeneratedAt || a.addedAt <= d.lastGeneratedAt);
    // the turn's steps are the session's own record: only attachments can differ
    return !(d.attachments ?? []).every((a) => excluded.has(a.id) || sentImage(a));
  });
  return edited ? { reason: 'edited', nodeId: edited.id } : null;
}

export function pristineChain(nodeId: string, nodes: ThoughtNode[], edges: ThoughtEdge[]): boolean {
  return whyNotPristine(nodeId, nodes, edges) === null;
}
