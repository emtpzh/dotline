import type { StateCreator } from 'zustand';
import type { ThoughtNode, ThoughtEdge } from '../../types';
import { generateId } from '../../utils';
import { placeNewNodes, reseatSubtree } from '../../lib/layout';
import { getDescendantIds, selectionSinks, walkUpAncestors } from '../../lib/graph';
import type { ContextMessage, ImageAttachment } from '../../lib/api';
import { buildContext, resolveExplicitRole, applyRoleOverride, type MessageSource } from '../context-builder';
import { activeAbortControllers, autoRunCounts, runNodeGeneration, triggerParadigmCascade } from '../streaming';
import { useUiStore, toast } from '../../lib/ui-store';
import { t, fmt } from '../../i18n';
import type { StoreState, LlmSlice, AddQuestionOptions } from '../types';
import { condenseGuard } from '../../lib/condense-guard';
import { noteSpawn } from '../../lib/spawn-motion';
import { isFactNode } from '../../lib/facts';
import { lineModel, lineCwd, intentOf, inheritIntent, intentFields } from '../../lib/run-intent';
import { runtimeOf } from '../../lib/agents/runtimes';
import { continuity, linkOf } from '../../lib/agents/continuity';
import { globalIntent, nodeIntent } from '../intent';
import { convergeRun } from '../converge';

/** @-mentions become real dashed reference edges into `id` — @ is the
 *  keyboard's way of drawing a wire, never an invisible injection. Ones
 *  already upstream (or already wired in) stay pure designators: their
 *  content is in the walk, nothing double-feeds. */
function wireMentions(id: string, mentions: string[], upstream: Set<string>, nodes: ThoughtNode[], edges: ThoughtEdge[]): ThoughtEdge[] {
  const refSources = new Set(edges.filter((e) => e.data?.isCrossLink && e.target === id).map((e) => e.source));
  let next = edges;
  let wired = 0;
  for (const mid of mentions) {
    if (mid === id || upstream.has(mid) || refSources.has(mid) || !nodes.some((n) => n.id === mid)) continue;
    next = [...next, {
      id: `crosslink-${mid}-${id}`,
      source: mid, target: id,
      sourceHandle: 'branch', targetHandle: 'left',
      type: 'smoothstep',
      data: { isCrossLink: true, createdAt: new Date().toISOString() },
    }];
    refSources.add(mid);
    wired++;
  }
  if (wired > 0) toast('info', fmt(t('mention.wired'), { n: wired }), 6000);
  return next;
}

export const createLlmSlice: StateCreator<StoreState, [], [], LlmSlice> = (set, get) => ({
  addQuestion: async (question: string, opts: AddQuestionOptions = {}) => {
    if (condenseGuard()) return;
    const { parentId, branchContext, branchYRatio, inheritRole, rolePrompt, roleName, initialAttachments, excludeAllInheritedAttachments, mentions, intent: asked } = opts;
    const id = generateId();
    get().logEvent('ask', id, { chars: question.length, ...(parentId ? {} : { root: true }), ...(branchContext ? { branch: true } : {}) });
    const isRoot = !parentId;
    // Model follows the LINE, not the toolbar: a child takes its parent's
    // intent (model and effort), so a Pi thread stays Pi even while the
    // global picker sits on something else; only a root starts from the pick.
    // The ask box may have changed it for this question: what it showed is what runs.
    const intent = intentFields(asked?.model ? asked : parentId ? inheritIntent([get().nodes.find((n) => n.id === parentId)?.data], globalIntent()) : globalIntent());
    const newNode: ThoughtNode = {
      id,
      type: 'thought',
      position: { x: 0, y: 0 },
      dragHandle: '.drag-handle',
      data: {
        question,
        createdAt: new Date().toISOString(),
        askedAt: new Date().toISOString(),
        ...intent,
        response: '',
        responses: [],
        responseIndex: -1,
        isCollapsed: false,
        isEditing: false,
        isEditingResponse: false,
        isLoading: true,
        tokenCount: 0,
        branchContext,
        highlights: [], highlightMode: 'tag', attachments: initialAttachments || [],
        excludedAttachmentIds: excludeAllInheritedAttachments && parentId
          ? get().getInheritedAttachments(parentId).map(({ attachment }) => attachment.id).concat(
              (get().nodes.find((n) => n.id === parentId)?.data.attachments || []).map((a) => a.id)
            )
          : [],
        includedAttachmentIds: [],
        roleMode: inheritRole === false ? 'reset' : 'inherit',
        rolePrompt: rolePrompt || undefined,
        roleName: (rolePrompt && roleName?.trim()) || undefined,
        isRoot,
        isBranch: !!branchContext,
        // Search permissions are per-ask: snapshot the toggles shown next to
        // the input, so reruns of this node keep behaving the same way
        webSearch: useUiStore.getState().webSearchEnabled,
        scholarSearch: useUiStore.getState().scholarSearchEnabled,
      },
    };

    const isBranch = !!branchContext;
    const newEdge = parentId ? {
      id: `edge-${parentId}-${id}`,
      source: parentId,
      target: id,
      sourceHandle: isBranch ? 'branch' : 'continue',
      targetHandle: isBranch ? 'left' : 'top',
      type: 'smoothstep',
      data: isBranch ? { isBranchFromSelection: true, branchYRatio: branchYRatio ?? 0.5 } : {},
    } : null;

    let newEdges: ThoughtEdge[] = newEdge ? [...get().edges, newEdge] : get().edges;
    // @-mentions: any mentioned node NOT already flowing into this one gets
    // a real dashed reference edge (wireMentions)
    if (mentions?.length) {
      const structural = newEdges.filter((e) => !e.data?.isCrossLink);
      const upstream = parentId
        ? new Set(walkUpAncestors(parentId, get().nodes, structural).ordered.map((n) => n.id))
        : new Set<string>();
      newEdges = wireMentions(id, mentions.filter((mid) => mid !== parentId), upstream, get().nodes, newEdges);
    }
    // One vertical line is one agent session. A question that cannot go on
    // in the session above opens a new one: it grows beside its parent as a
    // fork and carries the reason (the ask box warned before the send —
    // lib/agents/continuity; the run records what actually happened).
    const predicted = parentId && newEdge
      ? continuity(id, [...get().nodes, newNode], newEdges, runtimeOf(intent.model), undefined)
      : null;
    if (predicted && predicted.kind !== 'continue') {
      newNode.data.sessionLink = linkOf(predicted);
      if (predicted.kind === 'new' && !isBranch) {
        const fork: ThoughtEdge = { ...newEdge!, sourceHandle: 'branch', targetHandle: 'left', data: { isBranchFromSelection: true, branchYRatio: 0.5 } };
        newEdges = newEdges.map((e) => (e.id === fork.id ? fork : e));
      }
    }
    // Auto-collapse parent node when creating a child
    const updatedNodes = parentId
      ? get().nodes.map((n) => n.id === parentId ? { ...n, data: { ...n.data, isCollapsed: true } } : n)
      : get().nodes;
    // The new card is SEATED, not laid out: asking one follow-up must not
    // re-derive a canvas the user arranged. See placeNewNodes.
    const newNodes = placeNewNodes([...updatedNodes, newNode], newEdges, [newNode.id]);
    set({ nodes: newNodes, edges: newEdges, selectedNodeId: id });

    // Build full context from ancestors + explicit role for the new node
    const selfNode = get().nodes.find((n) => n.id === id);
    const ctx = parentId
      ? buildContext(parentId, get().nodes, get().edges, branchContext, selfNode?.data.excludedAttachmentIds, selfNode?.data.includedAttachmentIds, get().staleIds)
      : { messages: [] as ContextMessage[], images: [] as ImageAttachment[], sources: [] as MessageSource[] };
    const contextMessages = ctx.messages;
    const contextImages = ctx.images;
    const parentNode = parentId ? get().nodes.find((n) => n.id === parentId) : null;
    applyRoleOverride(contextMessages, resolveExplicitRole(selfNode?.data, parentNode?.data));

    // Collect this node's own attachments (skip if same file already from ancestors)
    const selfAttachments = selfNode?.data.attachments || [];
    for (const att of selfAttachments) {
      const alreadyInContext = contextMessages.some(m => m.content.includes(`[PDF: ${att.name}]`) || m.content.includes(`[File: ${att.name}]`));
      if (alreadyInContext) continue;
      if (att.type.startsWith('image/')) {
        contextImages.push({ data: att.content, mimeType: att.type });
      } else if (att.type === 'application/pdf') {
        // text channel only — page images trip provider image-count limits
        if (att.extractedText) {
          contextMessages.push({ role: 'user', content: `[PDF: ${att.name}]\n${att.extractedText}` });
        }
      } else if (att.type === 'text/html') {
        // extracted Markdown only — raw HTML source never reaches a model
        if (att.extractedText?.trim()) {
          contextMessages.push({ role: 'user', content: `[File: ${att.name}]\n${att.extractedText}` });
        }
      } else if (att.content) {
        contextMessages.push({ role: 'user', content: `[File: ${att.name}]\n${att.content}` });
      }
    }

    // Record the applied role before streaming
    const appliedRole = contextMessages.find((m) => m.role === 'system')?.content || undefined;
    contextMessages.push({ role: 'user', content: question });
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, appliedRole } } : n
      ),
    }));

    await runNodeGeneration(set, get, id, { question, messages: contextMessages, images: contextImages, sources: ctx.sources });
  },

  /**
   * Fan out: one question, N context-isolated role branches. Each branch is
   * an ordinary child node (orange branch edge, reset role) so siblings
   * can't see each other — structural blindness for candidate pools.
   * Generations run concurrently (bounded); one history entry for the batch.
   */
  fanOut: async (parentId: string, question: string, roles: { name: string; prompt: string }[], opts: { follow?: boolean; rounds?: number } = {}) => {
    get().logEvent('fanout', parentId, { roles: roles.length, chars: question.length });
    const parent = get().nodes.find((n) => n.id === parentId);
    if (!parent || roles.length === 0) return;
    const follow = !!opts.follow;
    // every perspective runs on the line it fans out from
    const intent = intentFields(inheritIntent([parent.data], globalIntent()));
    // Bounded loops, declared not emergent: how many auto re-critiques a
    // reviewer fires per wave (writer↔critic iteration budget).
    const rounds = follow && opts.rounds && opts.rounds > 1 ? Math.min(opts.rounds, 5) : undefined;
    get().pushHistory();

    // Create all nodes and edges up front. Each perspective is a ROLE on its
    // node — identity in the role field, the task in the question, which is
    // the same for all — replacing whatever role the line above carries. Two
    // run policies, one mechanism:
    //   once   → forks off the parent, answered once (blind pool)
    //   follow → nodes that rerun themselves, wired by a reference that
    //            follows the thread's tip
    const created: { id: string; question: string; role: string }[] = [];
    const newNodes: ThoughtNode[] = [];
    const newEdges: ThoughtEdge[] = [];
    roles.forEach((role, i) => {
      const id = generateId();
      created.push({ id, question, role: role.prompt });
      newNodes.push({
        id,
        type: 'thought',
        // follow mode skips autoLayout (watch edges are cross-links, not
        // ancestry) — stack reviewers to the right of the watched node
        position: follow ? { x: parent.position.x + 640, y: parent.position.y + i * 380 } : { x: 0, y: 0 },
        dragHandle: '.drag-handle',
        data: {
          question,
          response: '',
          responses: [],
          responseIndex: -1,
          isCollapsed: false,
          isEditing: false,
          isEditingResponse: false,
          isLoading: !follow,
          tokenCount: 0,
          branchContext: undefined,
          highlights: [], highlightMode: 'tag', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
          roleMode: 'inherit',
          rolePrompt: role.prompt,
          roleName: role.name || undefined,
          isRoot: false,
          isBranch: false,
          // a perspective is no kind of node: its look follows from the role,
          // from rerunning itself, and from the wire it hangs on (edge-look)
          autoRerun: follow || undefined,
          autoRerunRounds: rounds,
          ...intent,
          webSearch: useUiStore.getState().webSearchEnabled,
          scholarSearch: useUiStore.getState().scholarSearchEnabled,
        },
      });
      newEdges.push(follow ? {
        id: `watch-${parentId}-${id}`,
        source: parentId,
        target: id,
        sourceHandle: 'branch',
        targetHandle: 'left',
        type: 'smoothstep',
        data: { isCrossLink: true, followsTip: true },
      } : {
        id: `edge-${parentId}-${id}`,
        source: parentId,
        target: id,
        sourceHandle: 'branch',
        targetHandle: 'left',
        type: 'smoothstep',
        data: { isBranchFromSelection: true, branchYRatio: 0.5 },
      });
    });

    const allEdges = [...get().edges, ...newEdges];
    const merged = [...get().nodes.map((n) => (n.id === parentId && !follow ? { ...n, data: { ...n.data, isCollapsed: true } } : n)), ...newNodes];
    // follow mode keeps its hand-stacked reviewers (watch edges are cross-
    // links); the one-shot candidates are seated beside the parent in order
    const allNodes = follow ? merged : placeNewNodes(merged, allEdges, newNodes.map((n) => n.id));
    noteSpawn(parentId, newNodes.map((n) => n.id), 'beside');
    set({ nodes: allNodes, edges: allEdges, selectedNodeId: null, selectedNodeIds: [] });

    // Bounded concurrency: free-tier providers dislike large bursts
    const LIMIT = 6;
    let cursor = 0;
    // Shared ancestor context for one-shot branches (identical per sibling)
    const ctx = follow ? null : buildContext(parentId, get().nodes, get().edges, undefined, undefined, undefined, get().staleIds);
    const worker = async () => {
      while (cursor < created.length) {
        const { id, question: branchQuestion, role } = created[cursor++];
        if (follow) {
          await get().rerunNode(id); // standard context walk through the watch edge
        } else {
          // the parent's line, spoken to in this perspective's role
          const messages: ContextMessage[] = [...ctx!.messages, { role: 'user', content: branchQuestion }];
          applyRoleOverride(messages, role);
          set((state) => ({ nodes: state.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, appliedRole: role } } : n)) }));
          await runNodeGeneration(set, get, id, { question: branchQuestion, messages, images: ctx!.images, sources: ctx!.sources });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIMIT, created.length) }, worker));
  },

  /**
   * One-Rule-honest converge: the new node hangs from the selection's SINKS
   * with real edges — the wiring IS the context, ancestors flow in along
   * their chains (transitive reduction: no residual edges, no scrambled
   * conversation order). It lands UNASKED: the person types the question on
   * it (explore) or an optional extra request (merge / weave), and can pick
   * the model first — the one the sources agree on, else the global pick.
   */
  convergeFrom: (nodeIds: string[], kind: 'explore' | 'merge' | 'weave', highlightIds?: string[]) => {
    const { nodes, edges } = get();
    const sources = nodeIds.filter((nid) => nodes.some((n) => n.id === nid));
    const parents = selectionSinks(sources, edges);
    if (parents.length === 0) return null;
    get().pushHistory();
    const id = generateId();
    get().logEvent(kind, id, { sources: sources.length });
    const intent = inheritIntent(parents.map((pid) => nodes.find((n) => n.id === pid)?.data), globalIntent());
    const newNode: ThoughtNode = {
      id, type: 'thought', position: { x: 0, y: 0 }, dragHandle: '.drag-handle',
      data: {
        question: '',
        ...intentFields(intent),
        ...(kind === 'explore' ? {} : { converge: { kind, sources, ...(highlightIds ? { highlightIds } : {}) } }),
        createdAt: new Date().toISOString(),
        response: '', responses: [], responseIndex: -1,
        isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
        tokenCount: 0, highlights: [], highlightMode: 'tag',
        attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
        roleMode: 'inherit', isRoot: false, isBranch: false,
        // weave is an editorial task on the person's own marks: no search
        webSearch: kind === 'weave' ? false : useUiStore.getState().webSearchEnabled,
        scholarSearch: kind === 'weave' ? false : useUiStore.getState().scholarSearchEnabled,
      },
    };
    const newEdges: ThoughtEdge[] = parents.map((pid) => ({
      id: `edge-${pid}-${id}`,
      source: pid,
      target: id,
      sourceHandle: 'continue',
      targetHandle: 'top',
      type: 'smoothstep',
      data: {},
    }));
    const allEdges = [...edges, ...newEdges];
    set({ nodes: placeNewNodes([...nodes, newNode], allEdges, [newNode.id]), edges: allEdges, selectedNodeId: id, selectedNodeIds: [] });
    return id;
  },

  askFrom: (parentId, opts = {}) => {
    if (condenseGuard()) return null;
    const { nodes, edges } = get();
    const parent = nodes.find((n) => n.id === parentId);
    if (!parent) return null;
    get().pushHistory();
    const id = generateId();
    const isBranch = !!opts.branchContext;
    const newNode: ThoughtNode = {
      id, type: 'thought', position: { x: 0, y: 0 }, dragHandle: '.drag-handle',
      data: {
        question: '',
        // the line's intent, shown (and changeable) on the new card's box
        ...intentFields(inheritIntent([parent.data], globalIntent())),
        createdAt: new Date().toISOString(),
        response: '', responses: [], responseIndex: -1,
        isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
        tokenCount: 0, branchContext: opts.branchContext,
        highlights: [], highlightMode: 'tag',
        attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
        roleMode: 'inherit', isRoot: false, isBranch,
        webSearch: useUiStore.getState().webSearchEnabled,
        scholarSearch: useUiStore.getState().scholarSearchEnabled,
      },
    };
    const edge: ThoughtEdge = {
      id: `edge-${parentId}-${id}`,
      source: parentId,
      target: id,
      sourceHandle: isBranch ? 'branch' : 'continue',
      targetHandle: isBranch ? 'left' : 'top',
      type: 'smoothstep',
      data: isBranch ? { isBranchFromSelection: true, branchYRatio: opts.branchYRatio ?? 0.5 } : {},
    };
    const allEdges = [...edges, edge];
    noteSpawn(parentId, [id], isBranch ? 'beside' : 'below', opts.branchYRatio ?? 0.5);
    set({ nodes: placeNewNodes([...nodes, newNode], allEdges, [id]), edges: allEdges, selectedNodeId: id, selectedNodeIds: [] });
    return id;
  },

  submitHumanTurn: (nodeId: string, question: string) => {
    if (condenseGuard()) return;
    const q = question.trim();
    if (!q) return;
    get().pushHistory();
    get().logEvent('ask', nodeId, { chars: q.length, human: true });
    autoRunCounts.clear(); // a human turn is a manual action: new auto wave
    // Second run of a paradigm: changing the input makes every answered
    // step downstream stale — the replay chip is the "re-run experiment"
    // button. Surface the blast radius, same as editQuestion.
    const prevQuestion = get().nodes.find((n) => n.id === nodeId)?.data.question;
    if (prevQuestion && prevQuestion !== q) {
      const staleCount = getDescendantIds(nodeId, get().edges)
        .filter((id) => get().nodes.find((n) => n.id === id)?.data.response).length;
      if (staleCount > 0) toast('info', fmt(t('toast.editMakesStale'), { n: staleCount }), 7000);
    }
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, question: q, askedAt: new Date().toISOString(), isEditing: false } } : n
      ),
    }));
    triggerParadigmCascade(get, nodeId);
  },

  editQuestion: async (nodeId: string, asked: string, opts: { mentions?: string[] } = {}) => {
    if (condenseGuard()) return;
    // a session turn keeps what it asked: the new wording is a sibling turn
    const target = get().nodes.find((n) => n.id === nodeId);
    if (!target) return;
    if (isFactNode(target)) {
      set((state) => ({ nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, isEditing: false } } : n)) }));
      toast('info', t('fact.branched'), 6000);
      await get().regenerate(nodeId, asked);
      return;
    }
    // A converge node answers through its own prompt; what was typed is the
    // extra request ('' = none, the default question shows)
    const conv = target.data.converge ? convergeRun(nodeId, asked, get().nodes, get().edges, get().staleIds) : null;
    if (target.data.converge && !conv) {
      toast('info', t('converge.nothingLeft'), 6000);
      return;
    }
    const question = conv ? conv.question : asked;
    if (!question.trim()) return;
    get().pushHistory();
    // Asked for the first time: the node takes its intent now — from the
    // line it hangs off, the global pick only for a root — unless the
    // person already picked one on it
    if (!lineModel(target.data)) {
      const intent = intentFields(nodeIntent(nodeId, get().nodes, get().edges));
      set((state) => ({ nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...intent } } : n)) }));
    }
    // The first question on an unasked card under one parent is that
    // parent's follow-up (askFrom, a wire dragged to empty canvas): the
    // parent folds to its conclusion, and the session above goes on or
    // forks with the reason on the card — what addQuestion does at birth
    const firstAsk = !target.data.question && target.data.responses.length === 0 && !target.data.converge;
    const parentEdges = firstAsk ? get().edges.filter((e) => e.target === nodeId && !e.data?.isCrossLink) : [];
    const parent = parentEdges.length === 1 ? get().nodes.find((n) => n.id === parentEdges[0].source) : undefined;
    if (parent && !['note', 'file', 'link', 'frame'].includes(parent.data.stepKind ?? '')) {
      const pe = parentEdges[0];
      if (!parent.data.isCollapsed) get().toggleCollapse(parent.id);
      const self = get().nodes.find((n) => n.id === nodeId)!;
      const predicted = continuity(nodeId, get().nodes, get().edges, runtimeOf(self.data.model), undefined);
      if (predicted && predicted.kind !== 'continue') {
        const sessionLink = linkOf(predicted);
        const fork = predicted.kind === 'new' && !pe.data?.isBranchFromSelection;
        const edges = fork
          ? get().edges.map((e) => (e.id === pe.id ? { ...e, sourceHandle: 'branch', targetHandle: 'left', data: { ...e.data, isBranchFromSelection: true, branchYRatio: 0.5 } } : e))
          : get().edges;
        const nodes = get().nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, sessionLink } } : n));
        // a fork grows beside its parent, not under it
        set({ nodes: fork ? placeNewNodes(nodes, edges, [nodeId]) : nodes, edges });
      }
    }
    // typed straight into an unasked card: its @-mentions wire like a new question's
    if (opts.mentions?.length) {
      const structural = get().edges.filter((e) => !e.data?.isCrossLink);
      const upstream = new Set(walkUpAncestors(nodeId, get().nodes, structural).ordered.map((n) => n.id));
      const edges = wireMentions(nodeId, opts.mentions, upstream, get().nodes, get().edges);
      if (edges !== get().edges) set({ edges });
    }
    if (target.data.converge) {
      const request = asked.trim() || undefined;
      set((state) => ({ nodes: state.nodes.map((n) => (n.id === nodeId && n.data.converge ? { ...n, data: { ...n.data, converge: { ...n.data.converge, request } } } : n)) }));
    }
    get().logEvent('edit-question', nodeId, { chars: question.length });
    // Staleness seed: descendants keep answers written against the OLD
    // content — surface the blast radius now, replay stays manual.
    const prevQuestion = get().nodes.find((n) => n.id === nodeId)?.data.question;
    if (prevQuestion && prevQuestion !== question) {
      const staleCount = getDescendantIds(nodeId, get().edges)
        .filter((id) => get().nodes.find((n) => n.id === id)?.data.response).length;
      if (staleCount > 0) toast('info', fmt(t('toast.editMakesStale'), { n: staleCount }), 7000);
    }
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: {
          ...n.data,
          // Turn versions: the wording is changing — pin the OLD wording to
          // every existing version first (absent array = they all shared it),
          // so the (question, answer) pairs stay truthful after the edit.
          ...(prevQuestion && prevQuestion !== question && n.data.responses.length > 0
            ? { questions: n.data.responses.map((_, i) => n.data.questions?.[i] ?? prevQuestion) }
            : {}),
          question, askedAt: new Date().toISOString(), isEditing: false, isLoading: true,
        } } : n
      ),
    }));
    if (conv) {
      await runNodeGeneration(set, get, nodeId, { question, messages: conv.messages, images: conv.images, versionMode: 'append', sources: conv.sources });
      return;
    }
    // Rebuild context with this node's own Q&A blanked out
    const editNode = get().nodes.find((n) => n.id === nodeId);
    const editCtx = buildContext(nodeId, get().nodes.map(n =>
      n.id === nodeId ? { ...n, data: { ...n.data, question: '', response: '' } } : n
    // the passage a branch explores travels with every asking of it, the
    // first one on an unasked card included (addQuestion passes it at birth)
    ), get().edges, editNode?.data.branchContext, editNode?.data.excludedAttachmentIds, editNode?.data.includedAttachmentIds, get().staleIds);
    const contextMessages = editCtx.messages;
    const appliedRole = contextMessages.find((m) => m.role === 'system')?.content || undefined;
    contextMessages.push({ role: 'user', content: question });
    set((state) => ({ nodes: state.nodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, appliedRole } } : n) }));

    // Append, never replace: the old (question, answer) pairs stay switchable
    // — an edited question must not orphan or erase the versions written
    // against the old wording.
    await runNodeGeneration(set, get, nodeId, { question, messages: contextMessages, images: editCtx.images, versionMode: 'append', sources: editCtx.sources });
  },

  regenerate: async (nodeId: string, question?: string) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const converge = node.data.converge;
    // a converge sibling asks with the original's request unless given a new one
    const request = question?.trim() ?? converge?.request ?? '';
    const q = question?.trim() || node.data.question;
    get().pushHistory();

    // Find a structural parent (any incoming edge) for creating sibling
    const parentEdge = get().edges.find((e) => e.target === nodeId);
    const parentId = parentEdge?.source;

    // Create a new sibling node with the same question
    const id = generateId();
    get().logEvent('regenerate', nodeId);
    const newNode: ThoughtNode = {
      id,
      type: 'thought',
      position: { x: 0, y: 0 },
      dragHandle: '.drag-handle',
      data: {
        question: q,
        response: '',
        responses: [],
        responseIndex: -1,
        isCollapsed: false,
        isEditing: false,
        isEditingResponse: false,
        isLoading: true,
        tokenCount: 0,
        branchContext: node.data.branchContext,
        highlights: [], highlightMode: 'tag', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
        roleMode: node.data.roleMode || 'inherit',
        rolePrompt: node.data.rolePrompt,
        isRoot: !parentId,
        isBranch: node.data.isBranch,
        // the sibling runs on what the original runs on, where it runs
        ...intentFields(intentOf(node.data)),
        ...(() => { const rt = runtimeOf(lineModel(node.data)); return rt ? { cwd: lineCwd(node.data, rt) } : {}; })(),
        ...(converge ? { converge: { ...converge, request: request || undefined } } : {}),
      },
    };

    // a converge node hangs off every source it converged, so does its sibling
    const newEdges = converge
      ? [...get().edges, ...get().edges.filter((e) => e.target === nodeId && !e.data?.isCrossLink).map((e) => ({ ...e, id: `edge-${e.source}-${id}`, target: id }))]
      : parentId
        ? [...get().edges, { id: `edge-${parentId}-${id}`, source: parentId, target: id, type: 'smoothstep' }]
        : get().edges;

    const newNodes = placeNewNodes([...get().nodes, newNode], newEdges, [newNode.id]);
    set({ nodes: newNodes, edges: newEdges, selectedNodeId: id });

    if (converge) {
      const conv = convergeRun(id, request, get().nodes, get().edges, get().staleIds);
      if (!conv) { toast('info', t('converge.nothingLeft'), 6000); return; }
      set((state) => ({ nodes: state.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question: conv.question } } : n)) }));
      await runNodeGeneration(set, get, id, { question: conv.question, messages: conv.messages, images: conv.images, sources: conv.sources });
      return;
    }

    const regenSelf = get().nodes.find((n) => n.id === id);
    const regenCtx = parentId
      ? buildContext(parentId, get().nodes, get().edges, node.data.branchContext, regenSelf?.data.excludedAttachmentIds, regenSelf?.data.includedAttachmentIds, get().staleIds)
      : { messages: [] as ContextMessage[], images: [] as ImageAttachment[], sources: [] as MessageSource[] };
    const contextMessages = regenCtx.messages;
    const regenParent = parentId ? get().nodes.find((n) => n.id === parentId) : null;
    applyRoleOverride(contextMessages, resolveExplicitRole(regenSelf?.data, regenParent?.data));

    const appliedRole = contextMessages.find((m) => m.role === 'system')?.content || undefined;
    contextMessages.push({ role: 'user', content: q });
    set((state) => ({ nodes: state.nodes.map((n) => n.id === id ? { ...n, data: { ...n.data, appliedRole } } : n) }));

    await runNodeGeneration(set, get, id, { question: q, messages: contextMessages, images: regenCtx.images, sources: regenCtx.sources });
  },

  /**
   * After a merge has answered: remove the nodes it merged (and their
   * descendants), rewiring the synthesis to the boundary parents so it
   * keeps its ancestry instead of becoming an orphan root.
   */
  deleteConvergeSources: (nodeId: string) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    const c = node?.data.converge;
    if (!node || !c || !node.data.response) return;
    get().pushHistory();
    const allRemove = new Set<string>();
    for (const nid of c.sources) {
      allRemove.add(nid);
      for (const d of getDescendantIds(nid, get().edges)) allRemove.add(d);
    }
    allRemove.delete(nodeId);
    for (const d of getDescendantIds(nodeId, get().edges)) allRemove.delete(d);
    const boundaryParents = [...new Set(
      get().edges
        .filter((e) => allRemove.has(e.target) && !allRemove.has(e.source) && e.source !== nodeId && !e.data?.isCrossLink)
        .map((e) => e.source)
    )];
    const rewired: ThoughtEdge[] = boundaryParents.map((pid) => ({
      id: `edge-${pid}-${nodeId}`,
      source: pid,
      target: nodeId,
      sourceHandle: 'continue',
      targetHandle: 'top',
      type: 'smoothstep',
      data: {},
    }));
    set((state) => {
      const edges = [...state.edges.filter((e) => !allRemove.has(e.source) && !allRemove.has(e.target)), ...rewired];
      const nodes = state.nodes
        .filter((n) => !allRemove.has(n.id))
        .map((n) => (n.id === nodeId && n.data.converge ? { ...n, data: { ...n.data, converge: { ...n.data.converge, sources: [] } } } : n));
      // only the synthesis lost its parents: it and what grows out of it
      // re-seat, the rest of the canvas keeps the arrangement it was given
      return { nodes: reseatSubtree(nodes, edges, nodeId), edges };
    });
  },

  stopGeneration: (nodeId: string) => {
    const controller = activeAbortControllers.get(nodeId);
    if (controller) {
      controller.abort();
      activeAbortControllers.delete(nodeId);
    }
  },
});
