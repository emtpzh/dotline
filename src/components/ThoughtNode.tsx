import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { describeModel } from '../lib/use-models';
import { faceState, faceTone, farPriority, nodeConclusion, nodeName, roleLabel, type FaceShape } from '../lib/node-face';
import { isAutoRerun, nodeRoute } from '../lib/edge-look';
import { Handle, Position, useReactFlow, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, FoldVertical, Hourglass, Pin, Plus, RefreshCw, Send, Split, Square, UnfoldVertical, X } from 'lucide-react';
import 'katex/dist/katex.min.css';
import type { ThoughtNode as ThoughtNodeType } from '../types';
import { useStore } from '../store';
import { useZoomTier } from '../lib/use-map-mode';
import { generateId, isImeComposing , activeSummary, activeTopic, awaitingInput } from '../utils';
import { processFile } from '../lib/attachments';
import { copyText } from '../lib/export';
import { isRunLocked } from '../lib/paradigm';
import { collectExploreMarksKey, type ExploreMark } from '../lib/explore-marks';
import { useUiStore, toast, type PanelSection } from '../lib/ui-store';
import { scrollFade } from '../lib/scroll-fade';
import { isFactNode } from '../lib/facts';
import SearchToggles from './app/SearchToggles';
import { RuntimeMenu, ModelMenu, AccessMenu } from './app/composer/RunControls';
import { useAskThisIntent } from './app/composer/run-intent-hooks';
import AgentCwdChip from './app/AgentCwdChip';
import { offersAccess, runtimeOf } from '../lib/agents/runtimes';
import { useEntranceFade } from '../lib/use-entrance-fade';
import { useSpawnEntrance } from '../lib/use-spawn-entrance';
import { useFoldMorph } from '../lib/use-fold-morph';
import { flyTo } from '../lib/motion';
import { Markdown, HighlightedMarkdown } from './Markdown';
import FanOutModal from './FanOutModal';
import { ApprovalCard } from './app/ApprovalCard';
import { AgentTrace } from './app/AgentTrace';
import { useT, fmt } from '../i18n';
import { isViewerMode } from '../lib/viewer';
import { Button } from './ui/button';
import SelectionActions from './app/SelectionActions';
import { FaceBody, FaceName, FarMark, StateMark } from './app/NodeFace';
import { sessionWhy } from '../lib/session-why';
import { useTextSelection } from '../lib/use-text-selection';
import { turnOf } from '../lib/sessions/turn';
import { useNodeView } from '../lib/agents/runs';

// The live tail of a streaming text: about the last `keep` characters, cut
// at a line start so the lines on screen wrap exactly as they will in the
// whole text — a cut mid-line re-wrapped every visible line on each chunk,
// and the text jittered sideways as it streamed. Its top edge fades out
// (.tdag-tail) instead of wearing an ellipsis. One long paragraph has no
// line start to cut at: it is cut in steps, so it re-wraps once per step.
function liveTail(text: string, keep: number): string {
  if (text.length <= keep) return text;
  const nl = text.lastIndexOf('\n', text.length - keep);
  if (nl >= 0 && text.length - nl < keep * 4) return text.slice(nl + 1);
  return text.slice(Math.floor((text.length - keep) / keep) * keep);
}

export default function ThoughtNode({ id, data: stored }: NodeProps<ThoughtNodeType>) {
  // an agent run of this page shows through its overlay until its turn is in
  const data = useNodeView(id, stored);
  // Actions are stable references: selecting them one by one (instead of a
  // bare useStore() destructure) means this card no longer re-renders on
  // EVERY store change — with N cards mounted that multiplied every
  // streamed chunk into N markdown re-renders.
  const deleteNode = useStore((s) => s.deleteNode);
  const toggleCollapse = useStore((s) => s.toggleCollapse);
  const setEditing = useStore((s) => s.setEditing);
  const editQuestion = useStore((s) => s.editQuestion);
  const submitHumanTurn = useStore((s) => s.submitHumanTurn);
  const stopGeneration = useStore((s) => s.stopGeneration);
  const addHighlight = useStore((s) => s.addHighlight);
  const navigateVersion = useStore((s) => s.navigateVersion);
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const addAttachment = useStore((s) => s.addAttachment);
  const rerunNode = useStore((s) => s.rerunNode);
  const t = useT();
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [fanoutOpen, setFanoutOpen] = useState(false);
  // fan-out placeholder shows its expand button until branches exist
  const hasFanoutChildren = useStore((s) => s.edges.some((e) => e.source === id && e.data?.isBranchFromSelection));

  const [revision, setRevision] = useState(data.question);
  // A card still waiting for its question keeps the words in the shared
  // draft (`ask:<id>`) — the focus panel's box reads and writes the same,
  // so the two never disagree; a revision stays this editor's own.
  const askDraft = useUiStore((s) => s.drafts[`ask:${id}`] ?? '');
  const awaitingNow = !!awaitingInput(data);
  const editValue = awaitingNow ? askDraft : revision;
  const setEditValue = (v: string) => (awaitingNow ? useUiStore.getState().setDraft(`ask:${id}`, v) : setRevision(v));
  // an empty card's run settings: one quiet line until asked for
  const [askSettingsOpen, setAskSettingsOpen] = useState(false);
  const responseRef = useRef<HTMLDivElement>(null);
  const responseBox = useCallback((el: HTMLDivElement | null) => {
    responseRef.current = el;
    return scrollFade(el);
  }, []);
  const nodeRef = useRef<HTMLDivElement>(null);
  const questionTaRef = useRef<HTMLTextAreaElement>(null);
  const rf = useReactFlow();
  const zoomTier = useZoomTier();
  const mapMode = zoomTier !== 'work';

  // ── Paradigm run semantics (instantiated human/prompt steps) ──
  const isHuman = data.stepKind === 'human';
  // Awaiting its own question (empty ask node / human turn): shared
  // predicate — the focus panel derives the same state from it.
  const awaiting = awaitingInput(data);
  const isAwaitingHuman = awaiting === 'human';
  // A prompt step that hasn't started yet — the cascade runs it once all its
  // structural parents complete (triggerParadigmCascade in store/streaming).
  const isWaitingUpstream = data.stepKind === 'prompt' && !data.response && !data.isLoading && !data.generationFailed;
  const isParadigmNode = isHuman || data.stepKind === 'prompt';
  const isAwaitingAsk = awaiting === 'ask';
  // isEditing is node-level state shared with the focus panel. When the
  // panel is open on THIS node, the panel owns the editor: rendering a
  // second textarea here made the two fight over focus, and the loser's
  // blur-submit closed both within one frame (the "double-click does
  // nothing" bug). Pending asks / human turns keep their card box — the
  // panel renders those read-only.
  const panelOwnsEditor = useUiStore((s) => s.panelOpen) && selectedNodeId === id && !isParadigmNode;
  // The same goes for a card still waiting for its question: with the panel
  // open on it, the panel's box is where it is typed (one box, one focus);
  // the card shows the shared draft as it grows.
  const panelOwnsAsk = useUiStore((s) => s.panelOpen) && selectedNodeId === id && (isAwaitingAsk || isAwaitingHuman) && !isViewerMode;
  // While any paradigm step is incomplete the run is in progress: structure
  // is fixed (no follow-ups, no deletion) until the performance finishes.
  const runLocked = useStore((s) => isParadigmNode && isRunLocked(s.nodes));
  // Every node follows the same zoom grammar — a node waiting for input or
  // a running paradigm step folds like any other, its face carrying the
  // state ("waiting for you", "generating") instead of a full card.
  // Far tier: the node reduces to its name row's shape and name.
  const glyphTier = zoomTier === 'glyph';
  // Handles move to the dot at the far tier — tell React Flow to re-measure
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [glyphTier, id, updateNodeInternals]);
  // Upstream changed since this answer was written (see recomputeStaleness)
  const isStale = useStore((s) => s.staleIds.includes(id));
  // Lit while its condense-dialog segment row is hovered — the list points,
  // the canvas answers.
  const condenseLit = useUiStore((s) => s.condenseHighlightIds.includes(id));
  // Page-anchored questions wear a p.N chip that reopens the reader right
  // there — the material node this question grew from is the reader target
  const anchorMaterialId = useStore((s) => {
    if (!data.anchor) return null;
    const e = s.edges.find((e) =>
      e.target === id && !e.data?.isCrossLink &&
      s.nodes.some((n) => n.id === e.source && (n.data.stepKind === 'file' || n.data.stepKind === 'link' || n.data.stepKind === 'note')));
    return e?.source ?? null;
  });
  const openReaderAtAnchor = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!data.anchor || !anchorMaterialId) return;
    useUiStore.getState().setReaderNodeId(anchorMaterialId, { page: data.anchor.page, threadId: id });
  };

  // React Flow mounts new nodes visibility:hidden until measured, so the
  // textarea's autoFocus fires against a hidden element and is dropped.
  // Re-focus a fresh ask / human slot shortly after mount instead.
  useEffect(() => {
    if (!isAwaitingAsk && !isAwaitingHuman) return;
    const timer = setTimeout(() => questionTaRef.current?.focus(), 80);
    return () => clearTimeout(timer);
    // mount-only: a node awaits input exactly once, at creation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // no selection menu in the viewer (branch/highlight are writes)
  const { text: selectedText, anchor: selectionAnchor, clear: clearSelection } =
    useTextSelection(responseRef, !isViewerMode);

  // A new card brought into view when it lands off screen; its question
  // box focuses itself on mount (the effect above)
  const revealNode = (nid: string) => {
    requestAnimationFrame(() => {
      const n = rf.getNode(nid);
      if (!n) return;
      const { x, y, zoom } = rf.getViewport();
      const left = n.position.x * zoom + x, top = n.position.y * zoom + y;
      const off = left < 0 || top < 0 || left + 520 * zoom > window.innerWidth || top + 160 * zoom > window.innerHeight;
      if (off) void flyTo(rf, n.position.x + 260, n.position.y + 120, zoom);
    });
  };

  // Asking on from this card makes the next card — the question is typed
  // there, never in a box on this one. Below: a follow-up; from a selected
  // passage: a branch beside, leaving at the passage's height.
  const askBelow = () => {
    const nid = useStore.getState().askFrom(id);
    if (nid) revealNode(nid);
  };
  const handleBranch = (text: string) => {
    let ratio = 0.5;
    const rect = selectionAnchor?.getBoundingClientRect();
    if (rect && nodeRef.current) {
      const nodeRect = nodeRef.current.getBoundingClientRect();
      ratio = Math.max(0.1, Math.min(0.9, (rect.top + rect.height / 2 - nodeRect.top) / nodeRect.height));
    }
    clearSelection();
    const nid = useStore.getState().askFrom(id, { branchContext: text, branchYRatio: ratio });
    if (nid) revealNode(nid);
  };

  const handleHighlight = (text: string) => {
    addHighlight(id, { id: generateId(), text });
    clearSelection();
  };

  const handleDoubleClickQuestion = (e: React.MouseEvent) => {
    e.stopPropagation(); // inline edit, not the panel
    if (isViewerMode) return;
    // Editing mid-generation is ambiguous by design: stop first, then edit.
    if (data.isLoading) { toast('info', t('question.lockedWhileGenerating')); return; }
    setRevision(data.question);
    setEditing(id, true);
  };

  const handleEditSubmit = () => {
    // an unasked merge / weave may go with no request of its own: the default run
    if (!editValue.trim() && !(isAwaitingAsk && data.converge)) return;
    // Unchanged question = the user opened the editor to read or copy, not
    // to regenerate — closing must never cost them their answer.
    if (editValue.trim() === data.question && !isAwaitingAsk) { setEditing(id, false); return; }
    if (isHuman) {
      // Human turn: record the question only — no generation on this node;
      // downstream prompt steps answer (and the cascade advances).
      submitHumanTurn(id, editValue.trim());
    } else {
      // an empty card with no intent of its own runs on what its box showed —
      // the defaults a line starts with (one asked off a node carries its line's)
      if (isAwaitingAsk) askIntent.commit();
      editQuestion(id, editValue.trim());
    }
    // asked: the shared draft has done its job
    if (awaitingNow) useUiStore.getState().setDraft(`ask:${id}`, '');
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setEditing(id, false); return; }
    if (e.key !== 'Enter' || isImeComposing(e)) return;
    // First-input surfaces (human turn, empty ask node) keep Enter-to-send.
    // REVISING an existing question confirms explicitly — a regeneration is
    // never one accidental keystroke away: Enter breaks the line; submit is
    // the ✓ button, ⌘/Ctrl+Enter or Shift+Enter.
    if (isHuman || isAwaitingAsk) {
      if (!e.shiftKey) { e.preventDefault(); handleEditSubmit(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.shiftKey) { e.preventDefault(); handleEditSubmit(); }
  };

  // Click-away must NEVER fire a generation: mid-edit trips to copy text
  // elsewhere used to submit the half-written question. Unchanged drafts
  // close silently (the editor was opened to read); changed drafts stay
  // open and wait for an explicit Enter.
  const handleEditBlur = () => {
    if (editValue.trim() === data.question) setEditing(id, false);
  };

  const autoGrowTa = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(400, el.scrollHeight)}px`;
  };

  // Where this card sits in the grammar: the solid wire it hangs from
  // (lib/edge-look) — its bar, its dot and that wire share one color.
  const route = useStore((s) => nodeRoute(s.nodes, s.edges, id));
  // What an empty card's box runs on — the same as the panel's box for it
  const askIntent = useAskThisIntent(id);
  const webOn = useUiStore((s) => s.webSearchEnabled);
  const askSummary = [
    describeModel(askIntent.intent.model, askIntent.intent.effort, { compact: true }),
    offersAccess(askIntent.intent.model) ? t(askIntent.intent.access === 'write' ? 'access.write' : 'access.read')
      : !runtimeOf(askIntent.intent.model) && webOn ? t('paradigm.webSearch') : null,
  ].filter(Boolean).join(' · ') || t('ask.settingsTitle');
  const hasMultipleVersions = data.responses.length > 1;

  const highlightedTexts = new Set(data.highlights.map((h) => h.text));
  // Passages child branches explore from, marked in this answer (derived
  // from the children — nothing stored here). Click jumps to the branch.
  const exploreMarksKey = useStore((s) => collectExploreMarksKey(id, s.nodes, s.edges));
  const exploreMarks = useMemo(() => JSON.parse(exploreMarksKey) as ExploreMark[], [exploreMarksKey]);
  const exploreSpecs = exploreMarks.map((m) => ({
    text: m.text,
    nodeId: m.nodeId,
    title: `${t('node.exploredHere')} · ${m.question.slice(0, 80)}`,
  }));
  const handleResponseClick = (e: React.MouseEvent) => {
    const m = (e.target as HTMLElement).closest?.('mark[data-explore-target]');
    if (!m) return;
    if (window.getSelection()?.toString()) return; // a drag-select, not a click
    e.stopPropagation();
    const childId = m.getAttribute('data-explore-target');
    const child = childId ? rf.getNode(childId) : undefined;
    if (!child || !childId) return;
    setSelectedNodeId(childId);
    void flyTo(rf, child.position.x + 260, child.position.y + 110);
  };
  // The judged takeaway of the ACTIVE version (display only — the model
  // always reads the full answer)
  const versionSummary = activeSummary(data);
  // The face — name row, question, conclusion — is the same at every zoom
  // that shows text (lib/node-face): zooming out only drops layers.
  const state = faceState(data, isStale);
  const tone = faceTone(route, data.stepKind);
  const shape: FaceShape = 'round';
  // The far view always needs a label; the name row shows only a real
  // name (a fallback would just repeat the question beneath it)
  const name = nodeName(data) ?? t('face.newQuestion');
  const rowName = activeTopic(data) ?? null;
  const conclusion = nodeConclusion(data);
  // entrance, played once: the glow / loading classes own the
  // `animation` property too, and handing it back and forth replayed it
  // ...unless the card was just asked off another one: then it grows out
  // of its parent along the new wire (lib/spawn-motion)
  const born = useSpawnEntrance(id, nodeRef);
  // folding plays the height change instead of jumping (lib/fold-motion)
  useFoldMorph(id, data.isCollapsed, nodeRef);
  // An answer that just finished settles once: the running border lets go
  // with one soft flash (canvas.css .tdag-settle). Adjust during render:
  // a card that mounts finished never flashes.
  const [wasLoading, setWasLoading] = useState(data.isLoading);
  const [justFinished, setJustFinished] = useState(false);
  if (wasLoading !== data.isLoading) {
    setWasLoading(data.isLoading);
    setJustFinished(!data.isLoading && !!data.response);
  }
  const fade = useEntranceFade();
  const entrance = born ? '' : fade;
  // A tier change re-keys the face so the new form fades in instead of
  // snapping over the old one
  const formKey = glyphTier ? 'far' : mapMode ? 'map' : data.isCollapsed ? 'folded' : 'open';
  // Working-distance controls live at the end of the name row and show on
  // intent (hover, focus, selection — canvas.css .tdag-hover); stop stays
  // in sight while a run goes. The map face carries none.
  const controls = (
    <span className="flex items-center gap-0.5 -my-1 -mr-2 shrink-0">
      {data.isLoading && (
        <Button variant="ghost" size="icon-sm"
          onClick={(e) => { e.stopPropagation(); stopGeneration(id); }}
          title={t('actions.stop')}
          className="text-white bg-destructive hover:bg-destructive/90"
        >
          <Square strokeWidth={1.75} fill="currentColor" />
        </Button>
      )}
      {/* Placed by hand: layout keeps the card here. The pin stays in sight
          (it explains why a relayout left the card alone); clicking it hands
          the card back and it glides to its seat. */}
      {data.layoutPinned && !isViewerMode && (
        <Button variant="ghost" size="icon-sm"
          onClick={(e) => { e.stopPropagation(); useStore.getState().releasePin(id); }}
          title={t('pin.release')}
          className="text-muted-foreground/70 hover:text-foreground"
          data-pin
        >
          <Pin strokeWidth={1.75} />
        </Button>
      )}
      <span className="tdag-hover flex items-center gap-0.5">
        <Button variant="ghost" size="icon-sm"
          onClick={(e) => { e.stopPropagation(); toggleCollapse(id); }}
          title={data.isCollapsed ? t('face.expand') : t('face.collapse')}
          className="text-muted-foreground hover:text-foreground"
          data-fold
        >
          {data.isCollapsed ? <UnfoldVertical strokeWidth={1.75} /> : <FoldVertical strokeWidth={1.75} />}
        </Button>
        {!(isParadigmNode && runLocked) && !isViewerMode && (
          <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); deleteNode(id); }} className="text-muted-foreground hover:text-destructive/90 hover:bg-destructive/10" title={t('common.delete')}>
            <X strokeWidth={1.75} />
          </Button>
        )}
      </span>
    </span>
  );
  // What became of the agent session above: a new one and why, or a fork
  // of it at turn N — on the name row at every distance that shows text
  const sessionNote = useStore((s) => (data.sessionLink?.kind === 'new' ? sessionWhy(data.sessionLink, s.nodes, t) : null));
  // The node's own marks after its name: the role it was SET to (never an
  // inherited one — only where the role changes), that it reruns itself
  // (its answer can change while nobody touches it), then the session note
  const auto = isAutoRerun(data);
  const tags = (data.rolePrompt || auto || data.sessionLink) ? (
    <>
      {data.rolePrompt && (
        <span className="tdag-tag" data-tag="role" title={data.rolePrompt} data-role-tag>{roleLabel(data)}</span>
      )}
      {auto && (
        <span className="tdag-tag" data-tag="auto" data-auto-tag
          title={fmt(t('face.autoTitle'), { n: data.autoRerunRounds ?? 1 })}>↻ {t('face.auto')}</span>
      )}
      {data.sessionLink && (
        <span className="tdag-tag" data-tag={data.sessionLink.kind === 'new' ? 'warn' : undefined} data-session-link={data.sessionLink.kind}
          title={data.sessionLink.kind === 'new' ? t('session.newBody') : undefined}>
          {data.sessionLink.kind === 'new' ? fmt(t('session.newBadge'), { why: sessionNote ?? '' }) : fmt(t('session.forkBadge'), { n: data.sessionLink.turn })}
        </span>
      )}
    </>
  ) : null;
  // Stale is the one state you can act on from the card: click to replay
  const stateMark = state === 'stale' && !data.isLoading ? (
    <StateMark state="stale" title={t('node.staleTitle')}
      onClick={(e) => { e.stopPropagation(); if (!isViewerMode) void rerunNode(id, {}); }} />
  ) : undefined;
  // The panel, on this card, at a section — where the card's quiet line points
  const openPanelAt = (section: PanelSection | null) => {
    setSelectedNodeId(id);
    useUiStore.getState().openPanelAt(section);
  };
  // "5 sources · 2 highlights": counts, one quiet line; the lists are in the panel
  const refCount = data.references?.length ?? 0;
  const signals = [
    refCount > 0 ? fmt(t('node.refCount'), { n: refCount }) : null,
    data.highlights.length > 0 ? fmt(t('node.highlightCount'), { n: data.highlights.length }) : null,
  ].filter(Boolean);
  // The passage a branch explores, one line (the full text on hover)
  const passage = data.branchContext ? (data.anchor ? data.branchContext.replace(/^\(p\.\s?\d+\)\s*/, '') : data.branchContext) : '';
  // Asking on from this card: its bottom handle turns into "+" on intent
  const canAskBelow = !mapMode && !isAwaitingAsk && !isViewerMode && !(isParadigmNode && runLocked);
  // An empty card or a human turn is all question: no answer area under it
  const hasLower = !(isHuman || isAwaitingAsk);

  return (
    <div
      ref={nodeRef}
      className={glyphTier
        ? `w-[520px] ${entrance} ${data.archived ? 'opacity-35 saturate-50 ' : ''}${selectedNodeId === id ? 'glyph-selected ' : ''}`
        : `thought-node relative rounded-xl w-[520px] ${entrance} transition-all duration-200 ${mapMode ? 'map-node ' : ''}${condenseLit ? 'condense-lit ' : ''}${data.archived ? 'opacity-35 saturate-50 ' : ''}${isWaitingUpstream ? 'opacity-60 ' : ''}${data.isLoading ? 'loading-border' : ''}${justFinished ? 'tdag-settle' : ''} ${selectedNodeId === id ? 'tdag-selected' : ''} ${isDropTarget ? 'ring-2 ring-primary/50 ring-dashed' : ''}`}
      onClick={() => setSelectedNodeId(id)}
      onDoubleClick={() => {
        // Double-click opens the panel (single click only selects); inner
        // editors (question/response) stop propagation to stay inline
        setSelectedNodeId(id);
        useUiStore.getState().setPanelOpen(true);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDropTarget(false);
        for (const file of Array.from(e.dataTransfer.files)) {
          await processFile(file, {
            add: (att) => addAttachment(id, att),
            update: (attId, patch) => useStore.getState().setAttachmentData(id, attId, patch),
          });
        }
        setSelectedNodeId(id);
      }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDropTarget(true); }}
      onDragLeave={() => setIsDropTarget(false)}
    >
      {data.focusRole === 'down' && !glyphTier && (
        // Context Focus: floating corner tag — the card may have no meta
        // row yet (unanswered follow-up), so it cannot live there
        <span className="absolute -top-2.5 right-4 z-10 text-2xs text-primary/80 bg-card border border-border rounded-full px-2 py-px shadow-sm whitespace-nowrap" data-focus-down>
          {t('focus.downstream')}
        </span>
      )}
      {/* At the far tier every anchor sits on the dot, so wires meet it */}
      <Handle type="target" position={Position.Top} id="top" className={`!bg-primary !border-2 !border-white tdag-handle ${mapMode ? '!w-6 !h-6 tdag-handle-lg' : '!w-3.5 !h-3.5'}`} style={glyphTier ? { top: '50%' } : undefined} />
      {/* Side anchors: NOT interaction targets — the system routes dashed
          reference edges through them so cross-chain lines never cut across
          the vertical chain grammar. Two handles for people (top in, bottom
          out); four anchors for the layout. */}
      <Handle type="target" position={Position.Left} id="left" isConnectable={false} className="!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none" style={glyphTier ? { top: '50%', left: '50%' } : { top: '40%' }} />

      {glyphTier ? (
        // Far: the name row reduced to its shape (grown into a dot) and name
        <div
          key={formKey}
          className="drag-handle cursor-grab active:cursor-grabbing relative w-full h-32 animate-in fade-in-0 duration-(--dur-fast)"
          title={[
            name,
            data.question ? `${t('panel.question')}: ${data.question.replace(/\s+/g, ' ').slice(0, 120)}` : null,
            conclusion ? `${t('panel.response')}: ${conclusion}` : null,
          ].filter(Boolean).join('\n')}
          data-glyph-node
        >
          <FarMark shape={shape} tone={tone} name={name} state={state}
            priority={farPriority({ isRoot: data.isRoot, selected: selectedNodeId === id, state })} />
        </div>
      ) : mapMode ? (
        // Map: the folded face drawn larger — same layers, same order
        <div
          key={formKey}
          className="tdag-face drag-handle cursor-grab active:cursor-grabbing animate-in fade-in-0 duration-(--dur-fast)"
          onDoubleClick={(e) => {
            e.stopPropagation();
            // the map is read, then dived into: double-click flies to working scale
            const n = rf.getNode(id);
            if (n) void flyTo(rf, n.position.x + 260, n.position.y + 120, 1);
          }}
        >
          <FaceName shape={shape} tone={tone} name={rowName} state={state} tags={tags} />
          <FaceBody question={data.question} placeholder={t('face.noQuestion')} conclusion={conclusion} />
        </div>
      ) : (
      <div key={formKey} className="animate-in fade-in-0 duration-(--dur-fast)">
      <FaceName className="tdag-face drag-handle cursor-grab active:cursor-grabbing"
        shape={shape} tone={tone} name={rowName} state={state} stateMark={stateMark} trailing={controls} tags={tags} />

      {data.isCollapsed && (
        <div className="tdag-face">
          <FaceBody question={data.question} placeholder={t('face.noQuestion')} conclusion={conclusion} />
        </div>
      )}

      {!data.isCollapsed && (
        <>
        <div className={`px-4 pt-2 ${hasLower ? '' : 'pb-3'}`}>
          {/* The passage this branch explores, one quiet line: without it
              the user loses the thread that spawned the node. Page-anchored
              ones carry p.N, which reopens the reader at that page. */}
          {data.branchContext && (
            <div className="mb-2 flex items-center gap-2 min-w-0 border-l-2 border-edge-explore pl-2.5 text-xs text-muted-foreground"
              title={`${t('node.exploringFrom')}\n“${passage}”`} data-branch-context>
              <span className="truncate min-w-0">{passage}</span>
              {data.anchor && anchorMaterialId && (
                <Button variant="ghost" size="xs"
                  onClick={openReaderAtAnchor}
                  title={fmt(t('node.openAtPage'), { n: data.anchor.page })}
                  className="ml-auto h-5 shrink-0 px-1 text-2xs font-mono font-normal text-muted-foreground hover:text-foreground"
                >
                  p.{data.anchor.page}
                </Button>
              )}
            </div>
          )}
          {/* Question — written in place, in the same type it will be read
              in: an empty card or a human turn is typed straight into the
              question's slot; revising one opens the same slot. */}
          {panelOwnsAsk ? (
            <p className={`px-1 py-1.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${editValue ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground'}`} data-question-mirror>
              {editValue || data.instruction || t(data.converge ? (data.converge.kind === 'merge' ? 'converge.mergePlaceholder' : 'converge.weavePlaceholder') : isAwaitingHuman ? 'face.awaiting' : 'node.askPlaceholder')}
            </p>
          ) : (data.isEditing && !panelOwnsEditor) || isAwaitingHuman || isAwaitingAsk ? (
            <div>
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleEditKeyDown}
                onBlur={isHuman || isAwaitingAsk ? undefined : handleEditBlur} // click-away keeps the draft, never generates
                onInput={(e) => autoGrowTa(e.currentTarget)}
                ref={(el) => { questionTaRef.current = el; autoGrowTa(el); }}
                placeholder={data.instruction || (isAwaitingAsk ? t(data.converge ? (data.converge.kind === 'merge' ? 'converge.mergePlaceholder' : 'converge.weavePlaceholder') : 'node.askPlaceholder') : undefined)}
                className={`block w-[calc(100%+0.5rem)] -mx-1 rounded-xl px-2 py-1.5 resize-none text-sm font-semibold leading-relaxed text-foreground placeholder:font-medium placeholder:text-muted-foreground focus:outline-none nowheel nopan nodrag ${
                  isHuman || isAwaitingAsk ? 'bg-transparent' : 'bg-accent'
                }`}
                rows={1}
                autoFocus
                data-question-input
              />
              {isFactNode({ data }) && !isHuman && !isAwaitingAsk && <p className="text-2xs text-muted-foreground mt-1.5" data-fact-note>{t('fact.editQuestionNote')}</p>}
              {/* where an empty card runs and on what: one quiet line,
                  the menus on request */}
              {isAwaitingAsk && !data.converge && (
                <div className="mt-1 flex flex-wrap items-center gap-0.5 nopan nodrag" data-composer="ask">
                  {askSettingsOpen ? (
                    <>
                      {runtimeOf(askIntent.intent.model) && <AgentCwdChip composer />}
                      <RuntimeMenu intent={askIntent.intent} onIntent={askIntent.onIntent} />
                      {offersAccess(askIntent.intent.model)
                        ? <AccessMenu value={askIntent.intent.access ?? 'read'} onChange={(access) => askIntent.onIntent({ access })} />
                        : !runtimeOf(askIntent.intent.model) && <SearchToggles size={14} model={askIntent.intent.model} />}
                      <ModelMenu intent={askIntent.intent} onIntent={askIntent.onIntent} />
                    </>
                  ) : (
                    <Button variant="ghost" size="xs"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setAskSettingsOpen(true)}
                      title={t('ask.settingsTitle')}
                      className="-ml-1 min-w-0 max-w-[75%] font-normal text-muted-foreground hover:text-foreground"
                      data-ask-settings
                    >
                      <span className="truncate">{askSummary}</span>
                    </Button>
                  )}
                  <span className="flex-1" />
                  <span className="shrink-0 text-2xs text-muted-foreground">{t('ask.enterToSend')}</span>
                </div>
              )}
              {/* Revision confirms explicitly: visible exits instead of an
                  invisible Enter contract. mousedown-preventDefault keeps the
                  textarea's blur from racing the click. */}
              {!isHuman && !isAwaitingAsk && (
                <div className="flex items-center justify-end gap-2 mt-1.5">
                  <Button variant="ghost" size="sm"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setEditing(id, false)}
                    className="text-xs text-muted-foreground hover:text-destructive/90 hover:bg-accent"
                    data-edit-cancel
                  >
                    <X strokeWidth={2} /> {t('question.editCancel')}
                  </Button>
                  <Button size="sm"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleEditSubmit}
                    disabled={!editValue.trim()}
                    data-edit-submit>
                    <Check strokeWidth={2.25} /> {t('question.editSubmit')}
                  </Button>
                </div>
              )}
              {isHuman && (
                <div className="flex justify-end mt-1.5">
                  <Button variant="ghost" size="sm"
                    onClick={handleEditSubmit}
                    disabled={!editValue.trim()}
                    className="text-xs bg-edge-explore hover:opacity-85 text-white"
                  >
                    <Send strokeWidth={1.75} /> {t('paradigm.start')}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            // Long pasted questions must not stretch the card: same pattern
            // as the answer block — cap the height, scroll inside (nowheel
            // keeps the wheel on the text, not the canvas zoom).
            <div
              ref={scrollFade}
              onDoubleClick={handleDoubleClickQuestion}
              className="tdag-scroll-fade text-sm text-foreground font-semibold mb-3 cursor-pointer hover:bg-accent rounded-xl px-2 py-1.5 -mx-1 transition-colors max-h-[180px] overflow-y-auto nowheel nopan"
            >
              {data.question}
            </div>
          )}

          {/* Layer 3: the conclusion, one line above the full answer */}
          {hasLower && (versionSummary && !data.isLoading ? (
            <div className="tdag-face"><div className="tdag-c tdag-flush">{versionSummary}</div></div>
          ) : <div className="h-1" />)}
        </div>

        {/* Layer 4: the answer and the few things that act on it. Where it
            came from (model, time, files, sources, session) is the panel's.
            No rule above it: a long answer fades at the edge it scrolls
            past (lib/scroll-fade). */}
        {hasLower && (
        <div className="px-4 pt-1 pb-2">
          {/* A waiting prompt step shows its pending state instead of an empty box */}
          {isWaitingUpstream ? (
            <div className="border-2 border-dashed border-border rounded-xl py-3 px-3 text-xs text-muted-foreground flex items-center gap-2">
              <Hourglass size={13} strokeWidth={1.75} /> {t('paradigm.waitingUpstream')}
            </div>
          ) : data.isLoading ? (
            data.pendingApprovals?.length ? (
              <div className="flex flex-col gap-1.5">
                {data.pendingApprovals.map((req) => <ApprovalCard key={req.id} nodeId={id} request={req} compact />)}
              </div>
            ) : data.agentTrace && data.agentTrace.length > 0 && (!data.response || data.restreaming) ? (
              <AgentTrace entries={data.agentTrace} compact />
            ) : data.response && !data.restreaming ? (
              // Streaming: show the live tail of the response on the canvas
              <div className="tdag-tail text-sm text-muted-foreground leading-relaxed max-h-[180px] overflow-hidden flex flex-col justify-end whitespace-pre-wrap break-words">
                <span>{liveTail(data.response, 400)}<span className="tdag-caret ml-0.5 align-text-bottom" /></span>
              </div>
            ) : data.reasoning ? (
              // Reasoning models think before they answer — show the live
              // tail of the thinking, visually quieter than an answer
              <div className="max-h-[140px] overflow-hidden flex flex-col justify-end">
                <div className="text-2xs text-muted-foreground mb-1">{t('node.reasoningLive')}</div>
                <div className="tdag-tail max-h-[116px] overflow-hidden flex flex-col justify-end">
                  <div className="text-xs text-muted-foreground italic leading-relaxed whitespace-pre-wrap break-words">
                    {liveTail(data.reasoning, 300)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="animate-pulse text-primary">●</span> {t('common.thinking')}
              </div>
            )
          ) : data.response ? (
            // The answer sits on the card itself — no box inside the box
            <div
              ref={responseBox}
              onClick={handleResponseClick}
              className="tdag-scroll-fade markdown-body text-sm text-foreground leading-relaxed max-h-[400px] overflow-y-auto cursor-text nopan nodrag nowheel"
            >
              {highlightedTexts.size > 0 || exploreSpecs.length > 0 ? (
                <HighlightedMarkdown content={data.response} highlights={highlightedTexts} exploreMarks={exploreSpecs} />
              ) : (
                <Markdown base={turnOf(data)?.cwd ?? undefined}>{data.response}</Markdown>
              )}
            </div>
          ) : null}

          {/* Fan-out placeholder: the human decides when to expand */}
          {data.stepKind === 'fanout' && !hasFanoutChildren && !data.isLoading && (
            <div className="mt-2">
              <Button variant="ghost"
                onClick={(e) => { e.stopPropagation(); setFanoutOpen(true); }}
                title={t('paradigm.expandTitle')}
                className="w-full border-2 border-dashed border-edge-explore/50 hover:border-edge-explore hover:bg-edge-explore/5 text-edge-explore text-sm"
              >
                <Split strokeWidth={1.75} />
                {fmt(t('paradigm.expand'), { n: data.fanoutRoles?.length ?? 0 })}
              </Button>
              {fanoutOpen && (
                <FanOutModal
                  parentId={id}
                  initialQuestion={data.question}
                  initialRoles={data.fanoutRoles}
                  onClose={() => setFanoutOpen(false)}
                />
              )}
            </div>
          )}

          {/* One quiet row under the answer: the version it shows, regenerate
              and copy on intent, and the counts that open the panel */}
          {data.response && !data.isLoading && !data.generationFailed && (
            <div className="mt-1 -mx-1.5 flex h-7 items-center gap-0.5 text-muted-foreground" data-card-footer>
              {hasMultipleVersions && (
                <span className="mr-1 flex items-center font-mono text-2xs tabular-nums" data-version>
                  <Button variant="ghost" size="icon-xs" className="tdag-hover hover:text-foreground" onClick={(e) => { e.stopPropagation(); navigateVersion(id, 'prev'); }}><ChevronLeft strokeWidth={1.75} /></Button>
                  <span>{data.responseIndex + 1}/{data.responses.length}</span>
                  <Button variant="ghost" size="icon-xs" className="tdag-hover hover:text-foreground" onClick={(e) => { e.stopPropagation(); navigateVersion(id, 'next'); }}><ChevronRight strokeWidth={1.75} /></Button>
                </span>
              )}
              <span className="tdag-hover flex items-center gap-0.5">
                {!isViewerMode && (
                  <Button variant="ghost" size="icon-sm"
                    onClick={(e) => { e.stopPropagation(); void rerunNode(id, {}); }}
                    className="hover:text-foreground"
                    title={t('common.regenerate')}
                  >
                    <RefreshCw strokeWidth={1.75} />
                  </Button>
                )}
                <Button variant="ghost" size="icon-sm"
                  onClick={(e) => { e.stopPropagation(); void copyText(data.response); }}
                  className="hover:text-foreground"
                  title={t('actions.copyResponse')}
                >
                  <Copy strokeWidth={1.75} />
                </Button>
              </span>
              {data.focusRole === 'ctx' && (
                <span className="w-[7px] h-[7px] rounded-full bg-primary inline-block ml-1.5 shrink-0" title={t('focus.inContext')} data-focus-dot />
              )}
              <span className="flex-1" />
              <Button variant="ghost" size="xs"
                onClick={(e) => { e.stopPropagation(); openPanelAt(signals.length === 0 ? null : refCount > 0 ? 'refs' : 'highlights'); }}
                title={t('node.detailsTitle')}
                className={`font-normal text-muted-foreground hover:text-foreground ${signals.length === 0 ? 'tdag-hover' : ''}`}
                data-card-signals
              >
                {signals.length > 0 ? signals.join(' · ') : t('node.details')}
              </Button>
            </div>
          )}

          {/* Failed generation: retry in place */}
          {data.generationFailed && !data.isLoading && (
            <div className="mt-2 mb-1 flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/15 rounded-lg px-3 py-2">
              <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0" />
              {t('common.generationFailed')}
              {hasMultipleVersions && (
                <span className="flex items-center gap-1 text-muted-foreground shrink-0" title={t('node.backToVersionTitle')}>
                  <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); navigateVersion(id, 'prev'); }} className="hover:text-foreground"><ChevronLeft strokeWidth={1.75} /></Button>
                  v{data.responseIndex + 1}/{data.responses.length}
                  <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); navigateVersion(id, 'next'); }} className="hover:text-foreground"><ChevronRight strokeWidth={1.75} /></Button>
                </span>
              )}
              {!isViewerMode && (
                <Button variant="destructive" size="xs"
                  onClick={(e) => { e.stopPropagation(); editQuestion(id, data.question); }}
                  className="ml-auto border-destructive/30"
                >
                  <RefreshCw strokeWidth={1.75} /> {t('common.retry')}
                </Button>
              )}
            </div>
          )}
        </div>
        )}
        </>
      )}
      </div>
      )}

      {/* The bottom handle: drag to wire; on a working card it is also the
          way on — "+" on intent, click for a question card below */}
      <Handle type="source" position={Position.Bottom} id="continue"
        className={`!bg-primary !border-2 !border-white tdag-handle ${mapMode ? '!w-6 !h-6 tdag-handle-lg' : canAskBelow ? 'tdag-ask' : '!w-3.5 !h-3.5'}`}
        style={glyphTier ? { top: '50%', bottom: 'auto' } : undefined}
        title={canAskBelow ? t('node.askBelow') : undefined}
        onClick={canAskBelow ? (e) => { e.stopPropagation(); askBelow(); } : undefined}
        data-ask-below={canAskBelow ? '' : undefined}
      >
        {canAskBelow && <Plus strokeWidth={2.5} />}
      </Handle>
      <Handle
        type="source"
        position={Position.Right}
        id="branch"
        isConnectable={false}
        className="!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none"
        style={glyphTier ? { top: '50%', left: '50%', right: 'auto' } : { top: '50%' }}
      />

      {/* Select a passage → explore / highlight */}
      <SelectionActions
        text={selectedText}
        anchor={selectionAnchor}
        onExplore={handleBranch}
        onHighlight={handleHighlight}
      />
    </div>
  );
}
