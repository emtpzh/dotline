import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useProjects } from '../store/projects';
import { globalIntent } from '../store/intent';
import { continuity, sessionOf, type Continuity } from './agents/continuity';
import { runtimeOf } from './agents/runtimes';
import { inheritIntent } from './run-intent';
import { roleLabel } from './node-face';
import type { Attachment, ThoughtData, ThoughtEdge, ThoughtNode } from '../types';

/** What an ask box holds for the question it is about to send. */
export interface AskDraft {
  /** the model the box will send on, when the person changed it there
      (otherwise the line's own, as a new node would inherit it) */
  model?: string;
  rolePrompt?: string;
  roleName?: string;
  branchContext?: string;
  attachments?: Attachment[];
  mentions?: string[];
}

const DRAFT_ID = '__ask__';

/** Where the question in an ask box would run, decided the way the send
 *  will decide it: the graph as it will stand once the question exists (its
 *  wire from the parent, its @-references, its role and files), handed to
 *  the one continuity rule (lib/agents/continuity). */
export function predictAsk(parentId: string | null, nodes: ThoughtNode[], edges: ThoughtEdge[], draft: AskDraft): Continuity | null {
  if (!parentId) return null;
  const parent = nodes.find((n) => n.id === parentId);
  // an ordinary line has no session to continue or to break (the parent is
  // the only structural wire the question gets, so this is exact)
  if (!parent || !sessionOf(parent.data)) return null;
  const intent = inheritIntent([parent.data], globalIntent());
  const data = {
    question: '', response: '', responses: [], responseIndex: -1,
    isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0,
    highlights: [], highlightMode: 'tag', roleMode: 'inherit', isRoot: false, isBranch: !!draft.branchContext,
    attachments: draft.attachments ?? [], excludedAttachmentIds: [], includedAttachmentIds: [],
    ...(draft.rolePrompt ? { rolePrompt: draft.rolePrompt } : {}),
    ...(draft.branchContext ? { branchContext: draft.branchContext } : {}),
  } as ThoughtData;
  const ask: ThoughtNode = { id: DRAFT_ID, type: 'thought', position: { x: 0, y: 0 }, data };
  const wires: ThoughtEdge[] = [
    { id: `${DRAFT_ID}:parent`, source: parentId, target: DRAFT_ID, data: draft.branchContext ? { isBranchFromSelection: true } : {} },
    ...(draft.mentions ?? [])
      .filter((m) => m !== parentId && nodes.some((n) => n.id === m))
      .map((m): ThoughtEdge => ({ id: `${DRAFT_ID}:${m}`, source: m, target: DRAFT_ID, data: { isCrossLink: true } })),
  ];
  const c = continuity(DRAFT_ID, [...nodes, ask], [...edges, ...wires], runtimeOf(draft.model ?? intent.model), undefined);
  // a role picked in this very box: it has no node to point at yet, so the
  // notice names it and can offer to drop it (no `about` = the box's own)
  if (c?.kind === 'new' && c.about === DRAFT_ID) {
    return { kind: 'new', parentId: c.parentId, reason: c.reason, detail: roleLabel({ roleName: draft.roleName, rolePrompt: draft.rolePrompt }) };
  }
  return c;
}

/** Whether the directory a session ran in is gone, as the host says
 *  (undefined while it has not said, or cannot). */
function useDirGone(dir: string | null | undefined): boolean {
  const [gone, setGone] = useState<{ dir: string; gone: boolean } | null>(null);
  useEffect(() => {
    if (!dir) return;
    let alive = true;
    void import('./sessions/store').then((m) => m.dirExists(dir)).then((exists) => { if (alive) setGone({ dir, gone: exists === false }); });
    return () => { alive = false; };
  }, [dir]);
  return !!dir && gone?.dir === dir && gone.gone;
}

export function useContinuity(parentId: string | null, draft: AskDraft): Continuity | null {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  // the mirrored sessions and their tails move as turns land
  const ledger = useProjects((s) => s.projects.find((p) => p.id === s.activeId)?.sessions);
  const { model, rolePrompt, roleName, branchContext, attachments, mentions } = draft;
  const mentionKey = (mentions ?? []).join(',');
  const attachmentKey = (attachments ?? []).map((a) => `${a.id}:${a.type}`).join(',');
  const predicted = useMemo(
    () => predictAsk(parentId, nodes, edges, { model, rolePrompt, roleName, branchContext, attachments, mentions }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what the draft actually changes
    [parentId, nodes, edges, ledger, model, rolePrompt, roleName, branchContext, attachmentKey, mentionKey],
  );
  // a session goes on only in its own directory: gone, the question opens a new one
  const dir = predicted && predicted.kind !== 'new' ? sessionOf(nodes.find((n) => n.id === predicted.parentId)?.data ?? {})?.cwd : null;
  const gone = useDirGone(dir);
  return useMemo(
    () => (gone && predicted && predicted.kind !== 'new' ? { kind: 'new', parentId: predicted.parentId, reason: 'gone', detail: dir ?? undefined } : predicted),
    [gone, predicted, dir],
  );
}
