import { useState, useRef, useEffect, useMemo } from 'react';
import { describeModel } from '../lib/use-models';
import { actionMarks, turnComposition, footprint } from '../lib/turn-insight';
import { faceState, faceTone, farPriority, nodeConclusion, nodeName, roleLabel, type FaceShape } from '../lib/node-face';
import { nodeRoute } from '../lib/edge-look';
import { Handle, Position, useReactFlow, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Archive, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, GitBranch, Globe, Hourglass, Minimize2, RefreshCw, Send, Split, Square, Star, Trash2, X, Pencil } from 'lucide-react';
import 'katex/dist/katex.min.css';
import type { ThoughtNode as ThoughtNodeType } from '../types';
import { useStore } from '../store';
import { useZoomTier } from '../lib/use-map-mode';
import { generateId, isImeComposing , activeSummary, activeTopic, awaitingInput, formatStamp } from '../utils';
import { processFile } from '../lib/attachments';
import { copyText } from '../lib/export';
import { isRunLocked } from '../lib/paradigm';
import { collectExploreMarksKey, type ExploreMark } from '../lib/explore-marks';
import { useUiStore, toast } from '../lib/ui-store';
import { isFactNode } from '../lib/facts';
import SearchToggles from './app/SearchToggles';
import { useEntranceFade } from '../lib/use-entrance-fade';
import { Markdown, HighlightedMarkdown } from './Markdown';
import FanOutModal from './FanOutModal';
import ReasoningDisclosure from './app/ReasoningDisclosure';
import { ApprovalCard } from './app/ApprovalCard';
import { AgentTrace } from './app/AgentTrace';
import { SquareTerminal } from 'lucide-react';
import { useT, fmt } from '../i18n';
import MentionSurface from './app/NodeMention';
import { useMentions } from '../lib/mentions';
import { isViewerMode } from '../lib/viewer';
import { Button } from './ui/button';
import SelectionActions from './app/SelectionActions';
import { FaceBody, FaceName, FarMark, StateMark } from './app/NodeFace';
import SessionNotice from './app/SessionNotice';
import { AskRoleChip, RolePickerButton, type AskRole } from './app/RolePicker';
import { sessionWhy } from '../lib/session-why';
import { useContinuity } from '../lib/use-continuity';
import { useTextSelection } from '../lib/use-text-selection';
import { Textarea } from './ui/textarea';

export default function ThoughtNode({ id, data }: NodeProps<ThoughtNodeType>) {
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
  const setEditingResponse = useStore((s) => s.setEditingResponse);
  const editResponse = useStore((s) => s.editResponse);
  const addHighlight = useStore((s) => s.addHighlight);
  const navigateVersion = useStore((s) => s.navigateVersion);
  const deleteVersion = useStore((s) => s.deleteVersion);
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const addAttachment = useStore((s) => s.addAttachment);
  const rerunNode = useStore((s) => s.rerunNode);
  const t = useT();
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [fanoutOpen, setFanoutOpen] = useState(false);
  // fan-out placeholder shows its expand button until branches exist
  const hasFanoutChildren = useStore((s) => s.edges.some((e) => e.source === id && e.data?.isBranchFromSelection));

  const inlineDraftKey = `inline:${id}`;
  const [inputValue, setInputValueState] = useState(() => useUiStore.getState().drafts[inlineDraftKey] ?? '');
  const mention = useMentions(id);
  const setInputValue = (v: string) => {
    setInputValueState(v);
    useUiStore.getState().setDraft(inlineDraftKey, v);
  };
  const [branchFromText, setBranchFromText] = useState('');
  const [askRole, setAskRole] = useState<AskRole | null>(null);
  const [branchYRatio, setBranchYRatio] = useState(0.5);
  const [editValue, setEditValue] = useState(data.question);
  const [editResponseValue, setEditResponseValue] = useState(data.response);
  const responseRef = useRef<HTMLDivElement>(null);
  const nodeRef = useRef<HTMLDivElement>(null);
  const questionTaRef = useRef<HTMLTextAreaElement>(null);
  const addQuestion = useStore((s) => s.addQuestion);
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

  // Sync local edit buffer when the response changes externally (streaming, undo)
  const [prevResponse, setPrevResponse] = useState(data.response);
  if (prevResponse !== data.response) {
    setPrevResponse(data.response);
    setEditResponseValue(data.response);
  }

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

  const handleBranch = (text: string) => {
    setBranchFromText(text);
    // the branch leaves the card at the height of the passage it came from
    const rect = selectionAnchor?.getBoundingClientRect();
    if (rect && nodeRef.current) {
      const nodeRect = nodeRef.current.getBoundingClientRect();
      const ratio = Math.max(0.1, Math.min(0.9, (rect.top + rect.height / 2 - nodeRect.top) / nodeRect.height));
      setBranchYRatio(ratio);
    }
    setInputValue('');
    clearSelection();
  };

  const handleHighlight = (text: string) => {
    addHighlight(id, { id: generateId(), text });
    clearSelection();
  };

  const handleSubmitBranch = () => {
    if (!inputValue.trim()) return;
    addQuestion(inputValue.trim(), {
      parentId: id,
      branchContext: branchFromText || undefined,
      branchYRatio: branchFromText ? branchYRatio : undefined,
      mentions: mention.mentions.map((x) => x.nodeId),
      rolePrompt: askRole?.prompt,
      roleName: askRole?.name,
    });
    mention.clear();
    setInputValue('');
    setBranchFromText('');
    setAskRole(null);
    clearSelection();
  };

  const handleDoubleClickQuestion = (e: React.MouseEvent) => {
    e.stopPropagation(); // inline edit, not the panel
    if (isViewerMode) return;
    // Editing mid-generation is ambiguous by design: stop first, then edit.
    if (data.isLoading) { toast('info', t('question.lockedWhileGenerating')); return; }
    setEditValue(data.question);
    setEditing(id, true);
  };

  // Editing an answer is a BUTTON, not a double-click: double-click is the
  // system's select-a-word gesture, and hijacking it made selecting text
  // inside answers a trap. The button lives with regenerate/copy.
  const startEditResponse = () => {
    if (isViewerMode) return;
    setEditResponseValue(data.response);
    setEditingResponse(id, true);
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
      editQuestion(id, editValue.trim());
    }
  };

  const handleResponseEditSubmit = () => {
    editResponse(id, editResponseValue);
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

  const handleResponseEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setEditingResponse(id, false);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (mention.invokeKey(e)) return; // @-picker owns the key
    if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) { e.preventDefault(); handleSubmitBranch(); }
    if (e.key === 'Escape') { setBranchFromText(''); }
  };

  // Where this card sits in the grammar: the solid wire it hangs from
  // (lib/edge-look) — its bar, its dot and that wire share one color.
  const route = useStore((s) => nodeRoute(s.nodes, s.edges, id));
  // The inline follow-up box, and whether its question would go on in the
  // agent session above (lib/agents/continuity) — warned before the send
  const showInline = !mapMode && !data.isCollapsed && !data.isLoading && !data.isEditingResponse && !isAwaitingAsk && !(isParadigmNode && runLocked) && !isViewerMode && selectedNodeId !== id;
  const session = useContinuity(showInline ? id : null, { rolePrompt: askRole?.prompt, roleName: askRole?.name, branchContext: branchFromText || undefined, mentions: mention.mentions.map((x) => x.nodeId) });
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
    rf.setCenter(child.position.x + 260, child.position.y + 110, { zoom: rf.getZoom(), duration: 300 });
  };
  // The self-explaining chain (imported turns): what the turn did, its
  // token split and the files it touched — all computed from data the
  // import already carries, free.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the exact fields read
  const marks = useMemo(() => actionMarks(data), [data.attachments]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the exact fields read
  const composition = useMemo(() => turnComposition(data), [data.question, data.response, data.attachments]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the exact fields read
  const prints = useMemo(() => footprint(data), [data.attachments]);
  const compBar = composition && (
    <span
      className="inline-flex h-1.5 w-14 rounded-full overflow-hidden shrink-0 self-center"
      title={fmt(t('insight.compTitle'), { q: composition.q, a: composition.a, tool: composition.tool, pct: Math.round(composition.toolShare * 100) })}
      data-comp-bar
    >
      <span style={{ flex: Math.max(composition.q, 1) }} className="bg-primary/50" />
      <span style={{ flex: Math.max(composition.a, 1) }} className="bg-foreground/25" />
      <span style={{ flex: Math.max(composition.tool, 1) }} className={composition.toolShare > 0.6 ? 'bg-warning' : 'bg-edge-explore/60'} />
    </span>
  );
  // The judged takeaway of the ACTIVE version (display only — the model
  // always reads the full answer)
  const versionSummary = activeSummary(data);
  // Reasoning of the ACTIVE version (models that emit it); display only
  const versionReasoning = data.reasonings?.[data.responseIndex] ?? undefined;
  // The face — name row, question, conclusion — is the same at every zoom
  // that shows text (lib/node-face): zooming out only drops layers.
  const state = faceState(data, isStale);
  const tone = faceTone(route, data.stepKind);
  const shape: FaceShape = data.isEvaluator ? 'diamond' : 'round';
  // The far view always needs a label; the name row shows only a real
  // name (a fallback would just repeat the question beneath it)
  const name = nodeName(data) ?? t('face.newQuestion');
  const rowName = activeTopic(data) ?? null;
  const conclusion = nodeConclusion(data);
  // "Continue last thread" hover: this node is the flight destination
  const isBeacon = useUiStore((s) => s.beaconNodeId === id);
  // entrance, played once: the glow / loading / beacon classes own the
  // `animation` property too, and handing it back and forth replayed it
  const entrance = useEntranceFade();
  // A tier change re-keys the face so the new form fades in instead of
  // snapping over the old one
  const formKey = glyphTier ? 'far' : mapMode ? 'map' : data.isCollapsed ? 'folded' : 'open';
  // Working-distance controls live at the end of the name row; the map
  // face carries none (it is read, then dived into)
  const controls = (
    <span className="flex items-center gap-0.5 -my-1 -mr-2 shrink-0">
      <Button variant="ghost" size="icon-sm"
        onClick={(e) => { e.stopPropagation(); toggleCollapse(id); }}
        title={data.isCollapsed ? t('face.expand') : t('face.collapse')}
        className={data.isCollapsed ? 'text-primary' : 'text-muted-foreground'}
      >
        {data.isCollapsed ? <ChevronRight strokeWidth={1.75} /> : <ChevronDown strokeWidth={1.75} />}
      </Button>
      {data.isLoading && (
        <Button variant="ghost" size="icon-sm"
          onClick={(e) => { e.stopPropagation(); stopGeneration(id); }}
          title={t('actions.stop')}
          className="text-white bg-destructive hover:bg-destructive/90"
        >
          <Square strokeWidth={1.75} fill="currentColor" />
        </Button>
      )}
      {!(isParadigmNode && runLocked) && !isViewerMode && (
        <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); deleteNode(id); }} className="text-muted-foreground hover:text-destructive/90 hover:bg-destructive/10" title={t('common.delete')}>
          <X strokeWidth={1.75} />
        </Button>
      )}
    </span>
  );
  // What became of the agent session above: a new one and why, or a fork
  // of it at turn N — on the name row at every distance that shows text
  const sessionNote = useStore((s) => (data.sessionLink?.kind === 'new' ? sessionWhy(data.sessionLink, s.nodes, t) : null));
  // The node's own marks after its name: the role it was SET to (never an
  // inherited one — only where the role changes), then the session note
  const tags = (data.rolePrompt || data.sessionLink) ? (
    <>
      {data.rolePrompt && (
        <span className="tdag-tag" data-tag="role" title={data.rolePrompt} data-role-tag>{roleLabel(data)}</span>
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
  // Provenance, rare enough to get one line above the answer (a role is on
  // the name row, where it was set — not repeated under every answer)
  const hasMeta = (data.condensedFrom?.length ?? 0) > 0 || data.archived;

  return (
    <div
      ref={nodeRef}
      className={glyphTier
        ? `w-[520px] ${entrance} ${isBeacon ? 'beacon-node ' : ''}${data.archived ? 'opacity-35 saturate-50 ' : ''}${selectedNodeId === id ? 'glyph-selected ' : ''}`
        : `thought-node relative rounded-xl w-[520px] ${entrance} transition-all duration-200 ${isBeacon ? 'beacon-node ' : ''}${mapMode ? 'map-node ' : ''}${condenseLit ? 'condense-lit ' : ''}${data.archived ? 'opacity-35 saturate-50 ' : ''}${isWaitingUpstream ? 'opacity-60 ' : ''}${
        isHuman ? 'human-node' : route === 'fork' ? 'orange-node' : route === 'origin' ? 'root-node' : 'branch-node'
      } ${data.isLoading ? 'loading-border' : ''} ${selectedNodeId === id ? 'ring-2 ring-primary !border-primary selected-glow' : ''} ${isDropTarget ? 'ring-2 ring-primary/50 ring-dashed' : ''}`}
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
          className="drag-handle cursor-grab active:cursor-grabbing relative w-full h-32"
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
          className="tdag-face drag-handle cursor-grab active:cursor-grabbing animate-in fade-in-0 duration-150"
          onDoubleClick={(e) => {
            e.stopPropagation();
            // the map is read, then dived into: double-click flies to working scale
            const n = rf.getNode(id);
            if (n) rf.setCenter(n.position.x + 260, n.position.y + 120, { zoom: 1, duration: 300 });
          }}
        >
          <FaceName shape={shape} tone={tone} name={rowName} marks={marks} state={state} tags={tags} />
          <FaceBody question={data.question} placeholder={t('face.noQuestion')} conclusion={conclusion} />
        </div>
      ) : (
      <div key={formKey} className="animate-in fade-in-0 duration-150">
      <FaceName className="tdag-face drag-handle cursor-grab active:cursor-grabbing"
        shape={shape} tone={tone} name={rowName} marks={marks} state={state} stateMark={stateMark} trailing={controls} tags={tags} />

      {data.isCollapsed && (
        <div className="tdag-face">
          <FaceBody question={data.question} placeholder={t('face.noQuestion')} conclusion={conclusion} />
        </div>
      )}

      {!data.isCollapsed && (
        <>
        <div className="px-4 pt-2">
          {/* The passage this branch explores: without it the user loses
              the thread that spawned the node. Page-anchored ones carry a
              p.N chip that reopens the reader at that page, thread open —
              the same provenance grammar as the digest's page buttons. */}
          {data.branchContext && (
            <div className="mb-2.5 text-xs pl-3 py-1.5 pr-2 border-l-2 border-edge-explore bg-edge-explore/10 rounded-r text-muted-foreground flex items-start gap-1.5">
              <GitBranch size={13} strokeWidth={1.75} className="text-edge-explore shrink-0 mt-0.5" />
              <span className="italic leading-relaxed min-w-0">
                “{(data.anchor ? data.branchContext.replace(/^\(p\.\s?\d+\)\s*/, '') : data.branchContext).slice(0, 180)}{data.branchContext.length > 180 ? '…' : ''}”
              </span>
              {data.anchor && anchorMaterialId && (
                <Button variant="ghost" size="xs"
                  onClick={openReaderAtAnchor}
                  title={fmt(t('node.openAtPage'), { n: data.anchor.page })}
                  className="ml-auto shrink-0 text-2xs font-mono text-primary bg-primary/10 hover:bg-primary/20"
                >
                  p.{data.anchor.page}
                </Button>
              )}
            </div>
          )}
          {/* Question */}
          {(data.isEditing && !panelOwnsEditor) || isAwaitingHuman || isAwaitingAsk ? (
            <div>
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleEditKeyDown}
                onBlur={isHuman || isAwaitingAsk ? undefined : handleEditBlur} // click-away keeps the draft, never generates
                onInput={(e) => autoGrowTa(e.currentTarget)}
                ref={(el) => { questionTaRef.current = el; autoGrowTa(el); }}
                placeholder={data.instruction || (isAwaitingAsk ? t(data.converge ? (data.converge.kind === 'merge' ? 'converge.mergePlaceholder' : 'converge.weavePlaceholder') : 'node.askPlaceholder') : undefined)}
                className={`w-full bg-muted border rounded-xl p-3 text-sm text-foreground resize-none focus:outline-none focus:ring-2 ${
                  isHuman ? 'border-edge-explore focus:ring-edge-explore/20' : 'border-primary focus:ring-ring/20'
                }`}
                rows={2}
                autoFocus
              />
              {isFactNode({ data }) && !isHuman && !isAwaitingAsk && <p className="text-2xs text-muted-foreground mt-1.5" data-fact-note>{t('fact.editQuestionNote')}</p>}
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
              onDoubleClick={handleDoubleClickQuestion}
              className="text-sm text-foreground font-semibold mb-3 cursor-pointer hover:bg-accent rounded-xl px-2 py-1.5 -mx-1 transition-colors max-h-[180px] overflow-y-auto nowheel nopan"
            >
              {data.question}
            </div>
          )}

          {/* Layer 3: the conclusion, one line above the full answer */}
          {versionSummary && !data.isLoading && !data.isEditingResponse ? (
            <div className="tdag-face"><div className="tdag-c tdag-flush">{versionSummary}</div></div>
          ) : <div className="h-1" />}
        </div>

        {/* Layer 4: the answer and everything that acts on it */}
        <div className="px-4 pt-3 pb-4 border-t border-border">
          {hasMeta && (
            <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
              {data.condensedFrom && data.condensedFrom.length > 0 && (
                <Button variant="ghost" size="xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    // provenance travels by chip, context by wires: highlight the
                    // original run and glide the viewport onto it
                    const src = useStore.getState().nodes.filter((n) => data.condensedFrom!.includes(n.id));
                    if (src.length === 0) return;
                    useUiStore.getState().setCondenseHighlightIds(data.condensedFrom!);
                    const xs = src.map((n) => n.position.x), ys = src.map((n) => n.position.y);
                    rf.fitBounds({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) + 520 - Math.min(...xs), height: Math.max(...ys) + 240 - Math.min(...ys) }, { duration: 350, padding: 0.2 });
                    window.setTimeout(() => useUiStore.getState().setCondenseHighlightIds([]), 2600);
                  }}
                  title={t('node.condensedFromTitle')}
                  data-condensed-from
                  className="text-2xs bg-primary/10 text-primary hover:bg-primary/20"
                >
                  <Minimize2 strokeWidth={1.75} /> {fmt(t('node.condensedFrom'), { n: String(data.condensedFrom.length) })}
                </Button>
              )}
              {data.archived && (
                <span className="text-2xs bg-warning/10 text-warning px-1.5 py-0.5 rounded-md flex items-center gap-1 font-medium" title={t('archive.badgeTitle')}>
                  <Archive size={11} strokeWidth={1.75} /> {t('archive.badge')}
                </span>
              )}
            </div>
          )}

          {/* Highlights */}
          {data.highlights.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1">
              {data.highlights.map((h) => (
                <span key={h.id} className="inline-flex items-center gap-1 text-xs bg-warning/15 text-warning px-2 py-0.5 rounded-full">
                  <Star size={14} strokeWidth={1.75} />
                  {h.text.slice(0, 30)}{h.text.length > 30 ? '…' : ''}
                </span>
              ))}
            </div>
          )}

          {/* Response — a human turn / pending ask has none by design; a
              waiting prompt step shows its pending state instead of an empty box */}
          {isHuman || isAwaitingAsk ? null : isWaitingUpstream ? (
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
              <div className="text-sm text-muted-foreground leading-relaxed px-3 py-2.5 bg-background rounded-xl max-h-[180px] overflow-hidden flex flex-col justify-end whitespace-pre-wrap break-words">
                {data.response.length > 400 ? '…' + data.response.slice(-400) : data.response}
                <span className="inline-block w-2 h-4 bg-primary animate-pulse rounded-sm" />
              </div>
            ) : data.reasoning ? (
              // Reasoning models think before they answer — show the live
              // tail of the thinking, visually quieter than an answer
              <div className="px-3 py-2.5 bg-muted/70 rounded-xl max-h-[140px] overflow-hidden flex flex-col justify-end">
                <div className="text-2xs text-muted-foreground mb-1">💭 {t('node.reasoningLive')}</div>
                <div className="text-xs text-muted-foreground italic leading-relaxed whitespace-pre-wrap break-words">
                  {data.reasoning.length > 300 ? '…' + data.reasoning.slice(-300) : data.reasoning}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="animate-pulse text-primary">●</span> {t('common.thinking')}
              </div>
            )
          ) : data.isEditingResponse ? (
            <div>
              <Textarea
                value={editResponseValue}
                onChange={(e) => setEditResponseValue(e.target.value)}
                onKeyDown={handleResponseEditKeyDown}
                className="w-full border-primary resize-y min-h-[100px]"
                rows={6}
                autoFocus
              />
              {isFactNode({ data }) && <p className="text-2xs text-muted-foreground mt-1.5" data-fact-note>{t('fact.editResponseNote')}</p>}
              <div className="flex justify-end gap-2 mt-2">
                <Button variant="ghost" size="sm" onClick={() => setEditingResponse(id, false)} className="text-xs text-muted-foreground hover:text-foreground hover:bg-accent">{t('common.cancel')}</Button>
                <Button size="sm" onClick={handleResponseEditSubmit}>{t('common.save')}</Button>
              </div>
            </div>
          ) : (
            <>
            {versionReasoning && (
              <ReasoningDisclosure text={versionReasoning} />
            )}
            <div
              ref={responseRef}
              onClick={handleResponseClick}
              className="markdown-body text-sm text-foreground leading-relaxed max-h-[400px] overflow-y-auto cursor-text nopan nodrag nowheel px-3 py-2.5 bg-background rounded-xl"
            >
              {highlightedTexts.size > 0 || exploreSpecs.length > 0 ? (
                <HighlightedMarkdown content={data.response} highlights={highlightedTexts} exploreMarks={exploreSpecs} />
              ) : (
                <Markdown base={data.importSource?.cwd}>{data.response}</Markdown>
              )}
            </div>
            </>
          )}

          {/* Files this turn touched: changes first, in full ink */}
          {prints.length > 0 && !data.isLoading && (
            <div
              className="mt-2 px-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs font-mono text-muted-foreground"
              title={`${t('node.footprint')}\n${prints.map((f) => `${f.op === 'read' ? t('face.filesRead') : t('face.filesChanged')} ${f.path}`).join('\n')}`}
              data-footprint
            >
              {prints.slice(0, 6).map((f) => (
                <span key={f.path} className={f.op === 'read' ? '' : 'text-foreground'}>
                  {f.op === 'read' ? t('face.filesRead') : t('face.filesChanged')} {f.name}
                </span>
              ))}
              {prints.length > 6 && <span>+{prints.length - 6}</span>}
            </div>
          )}

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

          {/* Web references consulted for this response (compact) */}
          {(data.references?.length ?? 0) > 0 && !data.isLoading && !data.isEditingResponse && (
            <div className="mt-2 px-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
              <Globe size={11} strokeWidth={1.75} className="shrink-0" />
              {data.references!.slice(0, 3).map((r, i) =>
                r.url ? (
                  <a key={i} href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-primary/80 hover:text-primary hover:underline nopan">
                    [{i + 1}] {r.title.length > 44 ? r.title.slice(0, 44) + '…' : r.title}
                  </a>
                ) : (
                  <span key={i}>[{i + 1}] {r.title.slice(0, 44)}</span>
                )
              )}
              {data.references!.length > 3 && <span>+{data.references!.length - 3}</span>}
            </div>
          )}

          {/* Response action row — LLM-chat convention: the actions that act
              on THIS answer live right under it (regenerate = new version in
              place; the sibling-branch variant lives in the panel's ⋯ menu) */}
          {data.response && !data.isLoading && !data.isEditingResponse && !isHuman && !isAwaitingAsk && !data.generationFailed && (
            <div className="mt-1.5 flex items-center gap-0.5 text-muted-foreground">
              {!isViewerMode && (
                <Button variant="ghost"
                  onClick={(e) => { e.stopPropagation(); void rerunNode(id, {}); }}
                  size="icon-xs"
                  className={`rounded-full ${data.isEvaluator ? 'hover:text-edge-watch hover:bg-destructive/10' : 'hover:text-primary hover:bg-accent'}`}
                  title={data.isEvaluator ? t('evaluator.rerun') : t('common.regenerate')}
                >
                  <RefreshCw strokeWidth={1.75} />
                </Button>
              )}
              <Button variant="ghost" size="icon-sm"
                onClick={(e) => { e.stopPropagation(); void copyText(data.response); }}
                className="hover:text-primary hover:bg-accent"
                title={t('actions.copyResponse')}
              >
                <Copy strokeWidth={1.75} />
              </Button>
              {!isViewerMode && (
                <Button variant="ghost" size="icon-sm"
                  onClick={(e) => { e.stopPropagation(); startEditResponse(); }}
                  className="hover:text-primary hover:bg-accent"
                  title={t('actions.editResponse')}
                  data-edit-response
                >
                  <Pencil strokeWidth={1.75} />
                </Button>
              )}
              {data.focusRole === 'ctx' && (
                <span className="w-[7px] h-[7px] rounded-full bg-primary inline-block ml-1 shrink-0" title={t('focus.inContext')} data-focus-dot />
              )}
              {(data.generatedBy?.[data.responseIndex]) && (
                <span
                  className="text-2xs text-muted-foreground font-mono ml-1 truncate flex-1 min-w-0 max-w-[260px]"
                  title={`${t('node.generatedByTitle')} · ${describeModel(data.generatedBy[data.responseIndex], data.generatedEfforts?.[data.responseIndex])}`}
                >
                  {describeModel(data.generatedBy[data.responseIndex], data.generatedEfforts?.[data.responseIndex], { compact: true })}
                </span>
              )}
              {data.agentSession?.continued && (
                <span className="text-2xs text-muted-foreground ml-1 shrink-0" title={t('agent.continuedTitle')} data-agent-continued>↩ {t('agent.continued')}</span>
              )}
              {data.sessionLink && !data.agentSession?.continued && (
                <span className="text-2xs text-muted-foreground ml-1 shrink-0" data-agent-new-session
                  title={data.sessionLink.kind === 'new' ? `${sessionNote ?? ''}\n${t('session.newBody')}` : fmt(t('session.forkLine'), { n: data.sessionLink.turn })}>
                  ↳ {data.sessionLink.kind === 'new' ? t('session.newAction') : fmt(t('session.forkBadge'), { n: data.sessionLink.turn })}
                </span>
              )}
              {data.importSource?.runner === 'pi' && window.desktopSessions && (
                <Button variant="ghost" size="icon-sm"
                  onClick={(e) => { e.stopPropagation(); void window.desktopSessions!.openInCli('pi', data.importSource!.cwd ?? '', data.importSource!.sessionId, 'terminal'); }}
                  className="hover:text-primary hover:bg-accent"
                  title={t('agent.openInTerminal')}
                  data-open-in-terminal
                >
                  <SquareTerminal strokeWidth={1.75} />
                </Button>
              )}
              {data.gatewaySearches?.[data.responseIndex] && (
                <span className="text-2xs text-muted-foreground ml-1 shrink-0" title={t('node.gatewaySearchedTitle')} data-gateway-searched>
                  🌐 {t('node.gatewaySearched')}
                </span>
              )}
              {data.generatedAts?.[data.responseIndex] && (
                <span className="text-2xs text-muted-foreground font-mono ml-1 shrink-0" title={t('node.generatedAtTitle')} data-generated-at>
                  {formatStamp(data.generatedAts[data.responseIndex]!)}
                </span>
              )}
              {hasMultipleVersions && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground ml-1">
                  <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); navigateVersion(id, 'prev'); }} className="hover:text-primary hover:bg-accent"><ChevronLeft strokeWidth={1.75} /></Button>
                  <span className="text-primary font-medium">v{data.responseIndex + 1}/{data.responses.length}</span>
                  <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); navigateVersion(id, 'next'); }} className="hover:text-primary hover:bg-accent"><ChevronRight strokeWidth={1.75} /></Button>
                  {!isViewerMode && (
                    <Button variant="ghost" size="icon-sm"
                      onClick={(e) => { e.stopPropagation(); deleteVersion(id, data.responseIndex); }}
                      className="text-muted-foreground hover:text-destructive/90 hover:bg-destructive/10"
                      title={t('common.deleteVersion')}
                    >
                      <Trash2 strokeWidth={1.75} />
                    </Button>
                  )}
                </div>
              )}
              <span className="ml-auto flex items-center gap-2 pl-2 shrink-0">
                {compBar}
                <span className="text-2xs font-mono">{data.tokenCount} tok</span>
              </span>
            </div>
          )}

          {/* Failed generation: retry in place */}
          {data.generationFailed && !data.isLoading && (
            <div className="mt-2 flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/15 rounded-lg px-3 py-2">
              <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0" />
              {t('common.generationFailed')}
              {hasMultipleVersions && (
                <span className="flex items-center gap-1 text-muted-foreground shrink-0" title={t('node.backToVersionTitle')}>
                  <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); navigateVersion(id, 'prev'); }} className="hover:text-primary"><ChevronLeft strokeWidth={1.75} /></Button>
                  v{data.responseIndex + 1}/{data.responses.length}
                  <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); navigateVersion(id, 'next'); }} className="hover:text-primary"><ChevronRight strokeWidth={1.75} /></Button>
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

          {/* Branch context indicator when branching from selection */}
          {branchFromText && (
            <div className="mt-3 text-xs pl-3 py-2 pr-2 border-l-3 border-primary bg-primary/5 rounded-r">
              <span className="text-primary font-medium"><GitBranch size={14} strokeWidth={1.75} className="inline" /> {t('node.exploringFrom')}</span>
              <p className="text-muted-foreground mt-1 leading-relaxed">&ldquo;{branchFromText.slice(0, 150)}{branchFromText.length > 150 ? '...' : ''}&rdquo;</p>
            </div>
          )}

          {/* Inline continue input — hidden while a paradigm run is in
              progress (the structure IS the paradigm); returns on unlock */}
          {showInline && (
            <div className="mt-3 pt-3 border-t border-border relative">
              {askRole && <div className="mb-1.5"><AskRoleChip role={askRole} onClear={() => setAskRole(null)} /></div>}
              {inputValue.trim() && (
                <SessionNotice c={session} onDropRole={() => setAskRole(null)} onLocate={(nid) => {
                  const n = rf.getNode(nid);
                  if (n) rf.setCenter(n.position.x + 260, n.position.y + 120, { zoom: rf.getZoom(), duration: 300 });
                }} />
              )}
              <MentionSurface m={mention} text={inputValue} setText={setInputValue} />
              <div className="flex items-end gap-2 bg-muted rounded-xl px-4 py-2.5 transition-shadow focus-within:ring-1 focus-within:ring-ring/40">
                <textarea
                  rows={1}
                  ref={mention.bindAnchor}
                  value={inputValue}
                  onChange={(e) => {
                    setInputValue(e.target.value);
                    mention.track(e.target.value, e.target.selectionStart ?? e.target.value.length);
                    e.target.style.height = 'auto';
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
                  }}
                  onKeyDown={handleInputKeyDown}
                  placeholder={t('common.followUp')}
                  className="flex-1 bg-transparent text-sm text-foreground placeholder-muted-foreground focus:outline-none resize-none leading-relaxed max-h-[120px] overflow-y-auto nowheel nopan nodrag"
                />
                <SearchToggles size={15} />
                <RolePickerButton value={askRole} onChange={setAskRole} />
                <Button variant="ghost" size="icon-sm"
                  onClick={handleSubmitBranch}
                  disabled={!inputValue.trim()}
                  title={session?.kind === 'new' ? t('session.sendNew') : undefined}
                  className={`${session?.kind === 'new' ? 'text-warning' : 'text-muted-foreground'} hover:text-primary shrink-0 hover:bg-border`}
                >
                  <Send strokeWidth={1.75} />
                </Button>
              </div>
            </div>
          )}
        </div>
        </>
      )}
      </div>
      )}

      <Handle type="source" position={Position.Bottom} id="continue" className={`!bg-primary !border-2 !border-white tdag-handle ${mapMode ? '!w-6 !h-6 tdag-handle-lg' : '!w-3.5 !h-3.5'}`} style={glyphTier ? { top: '50%', bottom: 'auto' } : undefined} />
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
