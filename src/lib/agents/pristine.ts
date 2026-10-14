// Whether a session can stand in for the canvas's context. A continued or
// forked agent session carries its own record of the conversation; the
// canvas may only lean on it while that record and the canvas agree.

import type { ThoughtEdge, ThoughtNode } from '../../types';
import { partitionContext } from '../graph';
import { turnOf } from '../sessions/turn';
import { upstreamFingerprint } from '../../store/context-builder';

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
 * The turn whose prompt carried everything above it into the session the
 * question would go on in — the first turn of a session the canvas opened
 * with its compiled text (a new one, or the first agent turn under an
 * ordinary line) — and its index in the mainline. A forked session's
 * record holds the turns of the session it was cut from, so the walk goes
 * on up through those. null when the record reaches the top of the line or
 * a turn no session holds sits in between (the turn checks will say so).
 */
function sessionHead(mainline: ThoughtNode[]): { index: number; node: ThoughtNode } | null {
  let i = mainline.length - 2;
  while (i > 0) {
    const sid = turnOf(mainline[i].data)?.sessionId;
    if (!sid) return null;
    let h = i;
    while (h > 0 && turnOf(mainline[h - 1].data)?.sessionId === sid) h--;
    if (h === 0) return null;
    if (mainline[h].data.sessionLink?.kind !== 'fork') return { index: h, node: mainline[h] };
    i = h - 1;
  }
  return null;
}

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
 * What sits above the turn that opened the session went in as that turn's
 * compiled text: it is the session's record as a whole, and holds while the
 * turn's upstream is still what it answered against (its fingerprint) —
 * an edit up there the session already saw breaks nothing below it.
 * null = pristine; otherwise the first thing that is not, to say out loud.
 */
export function whyNotPristine(nodeId: string, nodes: ThoughtNode[], edges: ThoughtEdge[]): Unpristine | null {
  const ctx = partitionContext(nodeId, nodes, edges);
  const self = ctx.mainline[ctx.mainline.length - 1];
  if (!self || self.id !== nodeId) return { reason: 'edited', nodeId };
  const head = sessionHead(ctx.mainline);
  const baked = !!head?.node.data.lastContextHash && upstreamFingerprint(head.node.id, nodes, edges) === head.node.data.lastContextHash;
  const above = baked ? partitionContext(head.node.id, nodes, edges) : null;
  const carried = new Set([...(above?.materials ?? []), ...(above?.references.map((r) => r.source) ?? [])].map((n) => n.id));
  const mainline = above ? ctx.mainline.slice(head!.index) : ctx.mainline;
  const materials = ctx.materials.filter((n) => !carried.has(n.id));
  const references = ctx.references.filter((r) => !carried.has(r.source.id));
  // what the person just did on this question outranks what the chain holds;
  // a role on the opening turn went into the session with its prompt
  const role = mainline.slice(above ? 1 : 0).reverse().find((n) => n.data.rolePrompt);
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
    // an image the question carried went into the session with it — any
    // file, on the turn that opened it with the canvas's text; one added
    // after the turn last ran is the canvas's own
    const opened = above && n === head!.node;
    const sent = (a: { type: string; addedAt?: string }) =>
      (opened || a.type.startsWith('image/')) && (!a.addedAt || !d.lastGeneratedAt || a.addedAt <= d.lastGeneratedAt);
    // the turn's steps are the session's own record: only attachments can differ
    return !(d.attachments ?? []).every((a) => excluded.has(a.id) || sent(a));
  });
  return edited ? { reason: 'edited', nodeId: edited.id } : null;
}

export function pristineChain(nodeId: string, nodes: ThoughtNode[], edges: ThoughtEdge[]): boolean {
  return whyNotPristine(nodeId, nodes, edges) === null;
}
