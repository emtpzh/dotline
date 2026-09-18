// Fact nodes. A node that IS a session turn — mirrored from a session file,
// or an agent run adopted from one (importSource) — is the record of what
// was asked and answered there. The canvas never rewrites it: a changed
// question or a rerun becomes a new sibling turn (for an agent, a session
// forked at the parent's turn), a changed answer a revision beside it,
// written by the canvas. What the record says stays true, and a session can
// keep standing in for the conversation above it.

import type { ThoughtNode } from '../types';

export const isFactNode = (n: Pick<ThoughtNode, 'data'> | null | undefined): boolean => !!n?.data.importSource;

/** What a copy of a node must not carry: a copy is the canvas's, not the session's. */
export const factless = { importSource: undefined, source: undefined, agentSession: undefined, revisionOf: undefined } as const;
