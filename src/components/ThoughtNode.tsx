import { useState, useRef, useEffect, useMemo } from 'react';
import { describeModel } from '../lib/use-models';
import { toolFingerprint, turnComposition, footprint, conclusionOf } from '../lib/turn-insight';
import { Handle, Position, useReactFlow, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AlertTriangle, Archive, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Eye, GitBranch, Globe, Hourglass, Minimize2, Paperclip, RefreshCw, Send, Split, Square, Star, Trash2, UserRound, X, Pencil } from 'lucide-react';
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
  // Map labels represent completed steps (their takeaway). A node WAITING
  // for human input has nothing to summarize — its identity is the input
  // box. And while a paradigm run is in progress the canvas is a DASHBOARD
  // (waiting/running states are what the human watches), not a map. Both
  // keep their working form at every zoom.
  const zoomedOut = mapMode && !isAwaitingHuman && !isAwaitingAsk && !(isParadigmNode && runLocked);
  // Glyph tier: the node collapses to one seal — the thinking's skeleton
  const glyphTier = zoomTier === 'glyph' && zoomedOut;
  // Handles move to hug the seal at glyph tier — tell React Flow to re-measure
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
    });
    mention.clear();
    setInputValue('');
    setBranchFromText('');
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

  const isRoot = data.isRoot;
  const isBranch = data.isBranch;
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
  // The self-explaining chain (imported turns): action fingerprint + token
  // split, both computed from data the import already carries — free.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the exact fields read
  const toolMarks = useMemo(() => toolFingerprint(data), [data.attachments]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the exact fields read
  const composition = useMemo(() => turnComposition(data), [data.question, data.response, data.attachments]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the exact fields read
  const prints = useMemo(() => footprint(data), [data.attachments]);
  const marksLine = toolMarks.map((m) => `${m.glyph}${m.count > 1 ? m.count : ''}`).join(' ');
  const marksTitle = toolMarks.map((m) => `${m.name}×${m.count}`).join(' · ');
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
  // Map layer: the display summary for the ACTIVE version. Long answers wear
  // it instead of raw text; the full answer lives one double-click away.
  const versionSummary = activeSummary(data);
  const takeawayType = data.summaryTypes?.[data.responseIndex] ?? undefined;
  // Reasoning of the ACTIVE version (models that emit it); display only
  const versionReasoning = data.reasonings?.[data.responseIndex] ?? undefined;
  // Only the rare, high-signal moves wear a badge — a map where every node
  // has one is a map where none do. insight = the unmarked default.
  const TYPE_BADGE: Record<string, { glyph: string; cls: string; solid: string; key: string; nudge?: string }> = {
    ruleout: { glyph: '✕', cls: 'text-destructive bg-destructive/10', solid: 'bg-destructive text-white', key: 'takeaway.ruleout' },
    // ⚖'s ink sits low in its em box (tall ascent, glyph rides the baseline),
    // so a centered line box leaves it optically LOW — nudge up to visual
    // center (pixel-measured on macOS system fonts; em unit tracks font size)
    decision: { glyph: '⚖', cls: 'text-primary bg-primary/10', solid: 'bg-primary text-white', key: 'takeaway.decision', nudge: 'block -translate-y-[0.08em]' },
    pivot: { glyph: '↩', cls: 'text-edge-explore bg-edge-explore/10', solid: 'bg-edge-explore text-white', key: 'takeaway.pivot' },
    open: { glyph: '?', cls: 'text-warning bg-warning/10', solid: 'bg-warning text-white', key: 'takeaway.open' },
    // glyph tier only: steps WITH a takeaway spark; plain steps stay dots
    insight: { glyph: '✦', cls: 'text-sky-600 bg-sky-500/10', solid: 'bg-sky-500 text-white', key: 'takeaway.insight' },
  };
  const badge = takeawayType && takeawayType !== 'insight' && TYPE_BADGE[takeawayType] ? TYPE_BADGE[takeawayType] : null;
  // The glyph seal: typed moves keep their seal; insight sparks; evaluators
  // wear their red eye; everything else is a neutral waypoint dot
  const glyphSeal = takeawayType && TYPE_BADGE[takeawayType]
    ? TYPE_BADGE[takeawayType]
    : (versionSummary ? TYPE_BADGE.insight : null);
  // Stale at glyph tier: the seal itself wears the amber ring — there is no
  // card corner left to pin the dot to
  const staleRing = isStale && glyphTier ? ' ring-4 ring-warning' : '';
  // "Continue last thread" hover: this node is the flight destination
  const isBeacon = useUiStore((s) => s.beaconNodeId === id);
  // entrance, played once: the glow / loading / beacon classes own the
  // `animation` property too, and handing it back and forth replayed it
  const entrance = useEntranceFade();
  const showSummaryCard = !!versionSummary && data.response.length > 400 && !data.isLoading && !data.isEditingResponse;

  return (
    <div
      ref={nodeRef}
      className={glyphTier
        ? `w-[520px] ${entrance} transition-all duration-200 ${isBeacon ? 'beacon-node ' : ''}${data.archived ? 'opacity-35 saturate-50 ' : ''}${selectedNodeId === id ? 'glyph-selected ' : ''}`
        : `thought-node relative rounded-xl w-[520px] ${entrance} transition-all duration-200 ${isBeacon ? 'beacon-node ' : ''}${zoomedOut ? 'map-node ' : ''}${condenseLit ? 'condense-lit ' : ''}${data.archived ? 'opacity-35 saturate-50 ' : ''}${isWaitingUpstream ? 'opacity-60 ' : ''}${
        data.isEvaluator ? 'evaluator-node' : isHuman ? 'human-node' : isBranch ? 'orange-node' : isRoot ? 'root-node' : 'branch-node'
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
      <Handle type="target" position={Position.Top} id="top" className={`!bg-primary !border-2 !border-white tdag-handle ${zoomedOut ? '!w-6 !h-6 tdag-handle-lg' : '!w-3.5 !h-3.5'}`} />
      {/* Side anchors: NOT interaction targets — the system routes dashed
          reference edges through them so cross-chain lines never cut across
          the vertical chain grammar. Two handles for people (top in, bottom
          out); four anchors for the layout. */}
      <Handle type="target" position={Position.Left} id="left" isConnectable={false} className="!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none" style={glyphTier ? { top: '50%', left: 'calc(50% - 56px)' } : { top: '40%' }} />

      {/* Stale dot pins to the CARD's corner — at glyph tier the card is
          gone (one centered seal), so the seal wears an amber ring instead
          of a dot floating where the card used to be */}
      {isStale && zoomedOut && !glyphTier && (
        <span className="absolute top-2.5 right-2.5 w-3.5 h-3.5 rounded-full bg-warning z-10" title={t('node.staleBadge')} />
      )}
      {zoomedOut && !glyphTier && badge && (
        // The cognitive move owns the plaque's top-left corner: a solid seal
        // (no translucency — edges passing behind must not bleed through),
        // glyph sized for map distance
        <span
          title={t(badge.key as Parameters<typeof t>[0])}
          className={`absolute -top-5 -left-5 w-14 h-14 rounded-2xl text-4xl font-bold flex items-center justify-center border-2 border-card shadow-md z-10 ${badge.solid}`}
          data-map-badge
        >
          <span className={badge.nudge}>{badge.glyph}</span>
        </span>
      )}
      {glyphTier ? (
        // Glyph tier: the node IS one seal — the skeleton of the thinking.
        // Typed moves keep their color, takeaway-bearing steps spark ✦,
        // evaluators wear the red eye, digests the book, plain steps a dot.
        <div
          className="drag-handle cursor-grab active:cursor-grabbing w-full h-32 flex items-center justify-center"
          title={[
            data.isEvaluator
              ? t('evaluator.badge')
              : data.digestOf
                ? t('reader.viewDigest')
                : glyphSeal
                  ? t(glyphSeal.key as Parameters<typeof t>[0])
                  : null,
            data.question ? `${t('panel.question')}: ${data.question.replace(/\s+/g, ' ').slice(0, 120)}` : null,
            versionSummary ? `${t('panel.response')}: ${versionSummary}` : null,
          ].filter(Boolean).join('\n')}
          data-glyph-node
        >
          {data.isEvaluator ? (
            <span className={`w-28 h-28 rounded-[2rem] bg-edge-watch text-white flex items-center justify-center border-4 border-card shadow-lg${staleRing}`}>
              <Eye size={60} strokeWidth={2} />
            </span>
          ) : data.digestOf ? (
            <span className={`w-28 h-28 rounded-[2rem] bg-teal-500 text-white flex items-center justify-center border-4 border-card shadow-lg${staleRing}`}>
              <BookOpen size={60} strokeWidth={2} />
            </span>
          ) : glyphSeal ? (
            <span className={`w-28 h-28 rounded-[2rem] text-7xl font-bold flex items-center justify-center border-4 border-card shadow-lg ${glyphSeal.solid}${staleRing}`}>
              <span className={glyphSeal.nudge}>{glyphSeal.glyph}</span>
            </span>
          ) : (
            <span className={`w-14 h-14 rounded-full bg-foreground/25 border-4 border-card shadow-md${staleRing}`} />
          )}
        </div>
      ) : zoomedOut ? (
        // Map label: the TAKEAWAY is the headline (what this step yielded),
        // the question a readable eyebrow — the zoomed-out canvas reads like
        // a lab notebook's table of contents, not a pile of shrunken
        // documents. EXCEPT the root: its opening question IS the map's
        // title — the reader's entry point — so there question leads and
        // the takeaway is the subtitle.
        <div
          className="drag-handle cursor-grab active:cursor-grabbing px-6 py-5 relative"
          onDoubleClick={(e) => {
            e.stopPropagation();
            // a plaque is a map label: double-click dives to working scale
            const n = rf.getNode(id);
            if (n) rf.setCenter(n.position.x + 260, n.position.y + 120, { zoom: 1, duration: 300 });
          }}
        >
          {(versionSummary || data.response) ? (
            isRoot ? (
              <>
                <div className="text-2xl font-semibold text-foreground leading-snug line-clamp-3">
                  {data.question}
                </div>
                <div className="text-lg text-muted-foreground leading-snug line-clamp-2 mt-1.5">
                  {versionSummary || data.response.replace(/[#*`>-]/g, '').slice(0, 140)}
                </div>
              </>
            ) : (
              // Thinning by signal: badged turns (ruled out / decided /
              // pivoted / open) keep the full takeaway in full ink — the
              // map's landmarks. Unbadged waypoints shrink to their micro
              // topic (when the judge wrote one) in muted ink, so the
              // turning points read first.
              <>
                <div className="text-lg text-muted-foreground leading-snug line-clamp-2">
                  {data.question}
                </div>
                <div className={`text-2xl font-semibold leading-snug line-clamp-3 mt-1.5 ${badge ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {(badge ? versionSummary : (activeTopic(data) ?? versionSummary)) || data.response.replace(/[#*`>-]/g, '').slice(0, 140)}
                </div>
              </>
            )
          ) : (
            <div className="text-2xl font-semibold text-foreground leading-snug line-clamp-3">
              {data.question}
            </div>
          )}
          {toolMarks.length > 0 && (
            <div className="mt-1.5 text-lg text-muted-foreground tracking-wide select-none" title={marksTitle} data-map-tool-marks>{marksLine}</div>
          )}
        </div>
      ) : (
      <>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border cursor-grab active:cursor-grabbing drag-handle">
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => toggleCollapse(id)} className={`hover:bg-accent rounded-lg w-7 h-7 flex items-center justify-center transition-all text-sm font-bold ${data.isCollapsed ? 'text-primary bg-primary/10' : 'text-muted-foreground'}`}>
            {data.isCollapsed ? <ChevronRight size={18} strokeWidth={1.75} /> : <ChevronDown size={18} strokeWidth={1.75} />}
          </Button>
          <span className="text-xs text-muted-foreground font-mono">{data.tokenCount} tok</span>
          {toolMarks.length > 0 && (
            <span className="text-2xs text-muted-foreground shrink-0 select-none" title={marksTitle} data-tool-marks>{marksLine}</span>
          )}
          {compBar}
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
              <Minimize2 size={11} strokeWidth={1.75} /> {fmt(t('node.condensedFrom'), { n: String(data.condensedFrom.length) })}
            </Button>
          )}
          {isStale && !data.isLoading && (
            <Button variant="ghost" size="xs"
              onClick={(e) => { e.stopPropagation(); if (!isViewerMode) void rerunNode(id, {}); }}
              title={t('node.staleTitle')}
              className="text-2xs bg-warning/10 text-warning hover:bg-warning/25"
            >
              <RefreshCw size={11} strokeWidth={1.75} /> {t('node.staleBadge')}
            </Button>
          )}
          {data.archived && (
            <span className="text-2xs bg-warning/10 text-warning px-1.5 py-0.5 rounded-md flex items-center gap-1 font-medium" title={t('archive.badgeTitle')}>
              <Archive size={11} strokeWidth={1.75} /> {t('archive.badge')}
            </span>
          )}
          {isHuman && (
            <span className="text-2xs bg-edge-explore/10 text-edge-explore px-1.5 py-0.5 rounded-md flex items-center gap-1 font-medium">
              <UserRound size={11} strokeWidth={1.75} /> {isAwaitingHuman ? t('paradigm.yourTurn') : t('paradigm.kind.human')}
            </span>
          )}
          {isWaitingUpstream && (
            <span className="text-2xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-md flex items-center gap-1 font-medium">
              <Hourglass size={11} strokeWidth={1.75} /> {t('paradigm.waitingUpstream')}
            </span>
          )}
          {data.isEvaluator ? (
            <span className="text-2xs bg-edge-watch/10 text-edge-watch px-1.5 py-0.5 rounded-md flex items-center gap-1 font-medium">
              <Eye size={12} strokeWidth={1.75} /> {t('evaluator.badge')}
            </span>
          ) : data.appliedRole && (
            <span className="text-2xs bg-primary/10 text-primary px-1.5 py-0.5 rounded-md truncate max-w-[120px]" title={data.appliedRole}>
              {data.appliedRole.slice(0, 20)}{data.appliedRole.length > 20 ? '…' : ''}
            </span>
          )}
          {(() => {
            // The chip answers "who wrote THIS answer" — the actual model
            // recorded at generation time, following version paging. The
            // per-node pin (data.model) is only the fallback before any
            // answer exists; when both are known and differ, the tooltip
            // names the pin so the next generation holds no surprise.
            const gen = data.generatedBy?.[data.responseIndex] ?? undefined;
            const label = gen ?? data.model;
            if (!label) return null;
            const pinNote = gen && data.model && data.model !== gen
              ? `\n${fmt(t('node.pinnedModel'), { m: data.model })}`
              : '';
            return (
              <span className="text-2xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-md font-mono truncate max-w-[130px]" title={`${label}${pinNote}`}>
                {label.split('/').pop()}
              </span>
            );
          })()}
        </div>
        <div className="flex items-center gap-0.5">
          {data.isLoading && (
            <Button variant="ghost" size="icon-sm"
              onClick={(e) => { e.stopPropagation(); stopGeneration(id); }}
              title={t('actions.stop')}
              className="text-white bg-destructive hover:bg-destructive/90"
            >
              <Square size={10} strokeWidth={1.75} fill="currentColor" />
            </Button>
          )}
          {!(isParadigmNode && runLocked) && !isViewerMode && (
            <Button variant="ghost" size="icon-sm" onClick={() => deleteNode(id)} className="text-muted-foreground hover:text-destructive/90 hover:bg-destructive/10" title={t('common.delete')}>
              <X size={16} strokeWidth={1.75} />
            </Button>
          )}
        </div>
      </div>

      {!data.isCollapsed && (
        <div className="px-5 py-4">
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
                    <X size={12} strokeWidth={2} /> {t('question.editCancel')}
                  </Button>
                  <Button size="sm"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleEditSubmit}
                    disabled={!editValue.trim()}
                    
                    data-edit-submit>
                    <Check size={12} strokeWidth={2.25} /> {t('question.editSubmit')}
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
                    <Send size={12} strokeWidth={1.75} /> {t('paradigm.start')}
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
            showSummaryCard ? (
              // the map shows the landmark, not the terrain photo: an auto
              // summary of THIS version (display only — the model reads the
              // full text; double-click opens the panel for humans)
              <div className="px-3 py-2.5 bg-background rounded-xl nopan" title={t('node.summaryTitle')}>
                <span className="text-2xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full">{t('node.summaryLabel')}</span>
                {badge && (
                  <span title={t(badge.key as Parameters<typeof t>[0])} className={`text-2xs px-1.5 py-0.5 rounded-full ml-1.5 font-medium ${badge.cls}`}>
                    {badge.glyph} {t(badge.key as Parameters<typeof t>[0])}
                  </span>
                )}
                <div className="text-sm text-muted-foreground leading-relaxed mt-1.5">{versionSummary}</div>
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
            )
          )}

          {/* Fan-out placeholder: the human decides when to expand */}
          {data.stepKind === 'fanout' && !hasFanoutChildren && !data.isLoading && (
            <div className="mt-2">
              <Button variant="ghost"
                onClick={(e) => { e.stopPropagation(); setFanoutOpen(true); }}
                title={t('paradigm.expandTitle')}
                className="w-full border-2 border-dashed border-edge-explore/50 hover:border-edge-explore hover:bg-edge-explore/5 text-edge-explore text-sm"
              >
                <Split size={16} strokeWidth={1.75} />
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
                  className={`rounded-full w-6 h-6 flex items-center justify-center transition-colors ${data.isEvaluator ? 'hover:text-edge-watch hover:bg-destructive/10' : 'hover:text-primary hover:bg-accent'}`}
                  title={data.isEvaluator ? t('evaluator.rerun') : t('common.regenerate')}
                >
                  <RefreshCw size={14} strokeWidth={1.75} />
                </Button>
              )}
              <Button variant="ghost" size="icon-sm"
                onClick={(e) => { e.stopPropagation(); void copyText(data.response); }}
                className="hover:text-primary hover:bg-accent"
                title={t('actions.copyResponse')}
              >
                <Copy size={13} strokeWidth={1.75} />
              </Button>
              {!isViewerMode && (
                <Button variant="ghost" size="icon-sm"
                  onClick={(e) => { e.stopPropagation(); startEditResponse(); }}
                  className="hover:text-primary hover:bg-accent"
                  title={t('actions.editResponse')}
                  data-edit-response
                >
                  <Pencil size={13} strokeWidth={1.75} />
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
              {data.importSource?.runner === 'pi' && window.desktopSessions && (
                <Button variant="ghost" size="icon-sm"
                  onClick={(e) => { e.stopPropagation(); void window.desktopSessions!.openInCli('pi', data.importSource!.cwd ?? '', data.importSource!.sessionId, 'terminal'); }}
                  className="hover:text-primary hover:bg-accent"
                  title={t('agent.openInTerminal')}
                  data-open-in-terminal
                >
                  <SquareTerminal size={13} strokeWidth={1.75} />
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
                  <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); navigateVersion(id, 'prev'); }} className="hover:text-primary hover:bg-accent"><ChevronLeft size={14} strokeWidth={1.75} /></Button>
                  <span className="text-primary font-medium">v{data.responseIndex + 1}/{data.responses.length}</span>
                  <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); navigateVersion(id, 'next'); }} className="hover:text-primary hover:bg-accent"><ChevronRight size={14} strokeWidth={1.75} /></Button>
                  {!isViewerMode && (
                    <Button variant="ghost" size="icon-sm"
                      onClick={(e) => { e.stopPropagation(); deleteVersion(id, data.responseIndex); }}
                      className="text-muted-foreground hover:text-destructive/90 hover:bg-destructive/10"
                      title={t('common.deleteVersion')}
                    >
                      <Trash2 size={13} strokeWidth={1.75} />
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Failed generation: retry in place */}
          {data.generationFailed && !data.isLoading && (
            <div className="mt-2 flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/15 rounded-lg px-3 py-2">
              <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0" />
              {t('common.generationFailed')}
              {hasMultipleVersions && (
                <span className="flex items-center gap-1 text-muted-foreground shrink-0" title={t('node.backToVersionTitle')}>
                  <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); navigateVersion(id, 'prev'); }} className="hover:text-primary"><ChevronLeft size={14} strokeWidth={1.75} /></Button>
                  v{data.responseIndex + 1}/{data.responses.length}
                  <Button variant="ghost" size="icon-sm" onClick={(e) => { e.stopPropagation(); navigateVersion(id, 'next'); }} className="hover:text-primary"><ChevronRight size={14} strokeWidth={1.75} /></Button>
                </span>
              )}
              {!isViewerMode && (
                <Button variant="destructive" size="xs"
                  onClick={(e) => { e.stopPropagation(); editQuestion(id, data.question); }}
                  className="ml-auto border-destructive/30"
                >
                  <RefreshCw size={12} strokeWidth={1.75} /> {t('common.retry')}
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
          {!data.isLoading && !data.isEditingResponse && !isAwaitingAsk && !(isParadigmNode && runLocked) && !isViewerMode && selectedNodeId !== id && (
            <div className="mt-3 pt-3 border-t border-border relative">
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
                <Button variant="ghost" size="icon-sm"
                  onClick={handleSubmitBranch}
                  disabled={!inputValue.trim()}
                  className="text-muted-foreground hover:text-primary shrink-0 hover:bg-border"
                >
                  <Send size={18} strokeWidth={1.75} />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Collapsed view — question + summary */}
      {data.isCollapsed && (
        <div className="px-5 py-3">
          <div className="text-sm text-foreground font-semibold truncate flex items-center gap-1.5">
            {data.question.slice(0, 80)}{data.question.length > 80 ? '…' : ''}
            {(data.attachments?.length > 0) && (
              <span className="text-2xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full shrink-0"><Paperclip size={12} strokeWidth={1.75} className="inline" />{data.attachments.length}</span>
            )}
            {(data.references?.length ?? 0) > 0 && (
              <span className="text-2xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full shrink-0"><Globe size={12} strokeWidth={1.75} className="inline" /> {data.references!.length}</span>
            )}
            {toolMarks.length > 0 && (
              <span className="text-2xs text-muted-foreground shrink-0 select-none" title={marksTitle}>{marksLine}</span>
            )}
            {compBar}
          </div>
          {prints.length > 0 && (
            <div
              className="text-2xs text-muted-foreground font-mono mt-1 truncate select-none"
              title={`${t('node.footprint')}\n${prints.map((f) => `${f.op === 'read' ? '📖' : '✏️'} ${f.path}`).join('\n')}`}
              data-footprint
            >
              {prints.slice(0, 3).map((f) => `${f.op === 'read' ? '📖' : '✏️'} ${f.name}`).join('   ')}{prints.length > 3 ? `   +${prints.length - 3}` : ''}
            </div>
          )}
          {versionSummary ? (
            <div className="text-xs text-muted-foreground mt-1.5 leading-relaxed line-clamp-2">
              {versionSummary}
            </div>
          ) : data.response ? (
            <div className="text-xs text-muted-foreground mt-1.5 leading-relaxed line-clamp-2 italic">
              {data.importSource ? conclusionOf(data.response) : `${data.response.replace(/[#*`>-]/g, '').slice(0, 120)}${data.response.length > 120 ? '…' : ''}`}
            </div>
          ) : null}
        </div>
      )}

      </>
      )}

      <Handle type="source" position={Position.Bottom} id="continue" className={`!bg-primary !border-2 !border-white tdag-handle ${zoomedOut ? '!w-6 !h-6 tdag-handle-lg' : '!w-3.5 !h-3.5'}`} />
      <Handle
        type="source"
        position={Position.Right}
        id="branch"
        isConnectable={false}
        className="!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none"
        style={glyphTier ? { top: '50%', left: 'calc(50% + 56px)', right: 'auto' } : { top: '50%' }}
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
