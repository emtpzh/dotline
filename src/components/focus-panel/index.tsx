import { useEffect, useRef, useState } from 'react';
import { useRuns, withOverlay } from '../../lib/agents/runs';
import { X } from 'lucide-react';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { partitionContext } from '../../lib/graph';
import { resolveRoleSourceFor } from '../../store/context-builder';
import { PANEL_WIDTH_KEY, PANEL_MIN_WIDTH, PANEL_DEFAULT_WIDTH, PANEL_INSET } from '../../lib/constants';
import { awaitingInput } from '../../utils';
import { useT } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import RoleLine from './RoleLine';
import RunTag from './RunTag';
import QuestionSection from './QuestionSection';
import ResponseSection from './ResponseSection';
import ContextHistory from './ContextHistory';
import QuestionAttachments from './QuestionAttachments';
import { ChangedFiles, CondensedFrom } from './TurnLines';
import HighlightsSection from './HighlightsSection';
import HeaderActions from './HeaderActions';
import ContextOrderSection from './ContextOrderSection';
import Composer from '../app/composer/Composer';
import { Button } from '../ui/button';

// The panel reads a turn as a conversation. The title row: the card's
// name, how the turn ran (one tag, the rest behind it), the card's menu.
// The transcript: everything the next question carries folded into one
// line, the question as a bubble with its files, the answer with its tool
// calls folded where they happened and its actions under it, then what it
// changed and what was marked in it. The one box, pinned at the bottom,
// types a waiting card's own question, then asks on from it — and while
// the card answers, its send button is the stop.

// `leaving`: the panel is playing its way out (App keeps it mounted for
// that, lib/use-presence) — it keeps showing `nodeId`, the card it showed,
// while the selection may already have moved on or cleared.
export default function FocusPanel({ onFocusNode, nodeId, leaving = false }: {
  onFocusNode?: (id: string) => void;
  nodeId?: string | null;
  leaving?: boolean;
}) {
  const {
    nodes, edges, selectedNodeId: liveSelectedId, setSelectedNodeId,
    stopGeneration,
  } = useStore();
  const t = useT();
  const selectedNodeId = leaving ? (nodeId ?? null) : liveSelectedId;

  // Selected text from the response, staged as context for the follow-up
  const [branchContext, setBranchContext] = useState('');

  // Resizable width, persisted on drag end; double-click resets the default.
  // The width lives in ui-store so the canvas toolbar can offset itself.
  const panelWidth = useUiStore((s) => s.panelWidth);
  const setPanelWidth = useUiStore((s) => s.setPanelWidth);
  const [resizing, setResizing] = useState(false);

  const onResizePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setResizing(true);
  };
  const onResizePointerMove = (e: React.PointerEvent) => {
    if (!resizing) return;
    const maxW = Math.floor(window.innerWidth * 0.7);
    setPanelWidth(Math.min(maxW, Math.max(PANEL_MIN_WIDTH, window.innerWidth - PANEL_INSET - e.clientX)));
  };
  const onResizePointerUp = (e: React.PointerEvent) => {
    if (!resizing) return;
    setResizing(false);
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    localStorage.setItem(PANEL_WIDTH_KEY, String(useUiStore.getState().panelWidth));
  };
  const onResizeDoubleClick = () => {
    setPanelWidth(PANEL_DEFAULT_WIDTH);
    localStorage.removeItem(PANEL_WIDTH_KEY);
  };

  // Reset staged context when switching nodes (adjust-during-render).
  const [prevNodeId, setPrevNodeId] = useState(selectedNodeId);
  if (prevNodeId !== selectedNodeId) {
    setPrevNodeId(selectedNodeId);
    setBranchContext('');
  }

  // A card's quiet line points at a section ("5 sources" → the list):
  // scroll there once the panel shows this node, then forget it
  const scrollRef = useRef<HTMLDivElement>(null);
  // the title row draws its rule only once the transcript runs under it
  const [scrolled, setScrolled] = useState(false);
  // an agent run of this page shows through its overlay until its turn is in
  const runOverlay = useRuns((s) => (selectedNodeId ? s.runs[selectedNodeId] : undefined));
  const panelSection = useUiStore((s) => s.panelSection);
  useEffect(() => {
    if (!panelSection) return;
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(`[data-panel-section="${panelSection}"]`);
      el?.querySelector('details:not([open])')?.setAttribute('open', ''); // a folded list opens to be seen
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      useUiStore.setState({ panelSection: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [panelSection, selectedNodeId]);

  const node = nodes.find((n) => n.id === selectedNodeId);

  if (!node) {
    return null;
  }

  const data = withOverlay(node.data, runOverlay);
  const hasMultipleVersions = data.responses.length > 1;
  // Waiting for its own question → the question box is open and the
  // follow-up input steps aside (nothing to follow up on yet)
  const awaiting = awaitingInput(data);

  // Inherited role for the status line: the SAME resolution buildContext
  // injects (structural mainline, legacy roleMode honored) — what the panel
  // shows is by construction what the model receives.
  const inheritedFrom = data.rolePrompt
    ? undefined
    : resolveRoleSourceFor(selectedNodeId!, nodes, edges, { ignoreOwn: true });

  // Layered context view — same partition the prompt builder uses, so the
  // tree the user reads and the prompt the model reads never drift apart.
  const partition = partitionContext(selectedNodeId!, nodes, edges);
  const highlightedTexts = new Set(data.highlights.map((h) => h.text));
  const jump = (id: string) => { setSelectedNodeId(id); onFocusNode?.(id); };

  return (
    <div
      data-focus-panel
      className={`@container/panel absolute right-3 top-[var(--chrome-panel-top)] bottom-3 z-20 bg-card border border-border rounded-2xl shadow-xl overflow-hidden flex flex-col ${leaving ? 'tdag-panel-out' : 'tdag-panel-in'} ${resizing ? 'select-none' : ''}`}
      style={{ width: panelWidth, minWidth: PANEL_MIN_WIDTH, maxWidth: '70vw' }}
    >
      {/* Resize handle on the left edge */}
      <div
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onDoubleClick={onResizeDoubleClick}
        className={`absolute left-0 top-0 h-full w-[8px] -ml-[3px] z-20 cursor-col-resize hover:bg-primary/20 transition-colors flex items-center justify-center ${resizing ? 'bg-primary/30' : ''}`}
        title={t('panel.resizeTitle')}
        data-panel-resize
      >
        {/* a visible grip: the handle exists whether or not you hover it */}
        <div className={`w-[3px] h-9 rounded-full transition-colors ${resizing ? 'bg-primary' : 'bg-input'}`} />
      </div>
      {/* Title row: name · role, how the turn ran, the card's menu */}
      <div className={`flex items-start gap-1 pl-5 pr-3 pt-2 pb-1 shrink-0 border-b transition-colors ${scrolled ? 'border-border' : 'border-transparent'}`}>
        <RoleLine nodeId={selectedNodeId!} data={data} inheritedFrom={inheritedFrom}
          onJump={(id) => { useStore.getState().setSelectedNodeId(id); onFocusNode?.(id); }} />
        <div className="flex h-8 min-w-0 max-w-[62%] items-center gap-0.5">
          <RunTag data={data} />
          {!isViewerMode && <HeaderActions nodeId={selectedNodeId!} />}
          <Button variant="ghost" size="icon-sm"
            onClick={() => { useUiStore.getState().setPanelOpen(false); setSelectedNodeId(null); }}
            title={t('panel.close')}
            aria-label={t('panel.close')}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <X strokeWidth={1.75} />
          </Button>
        </div>
      </div>

      {/* Scrollable content: one conversation column */}
      <div ref={scrollRef} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}
        className="flex-1 overflow-y-auto px-5 pt-1 pb-4 flex flex-col gap-4" data-panel-scroll>
        <ContextHistory nodeId={selectedNodeId!} data={data} partition={partition} onJump={jump} />
        {/* the question shows once it is asked — before that it is typed below, its files above the box */}
        {!awaiting ? (
          <QuestionSection
            key={`q-${selectedNodeId}`}
            nodeId={selectedNodeId!}
            question={data.question}
            isEditing={data.isEditing}
            isHuman={data.stepKind === 'human'}
            branchContext={data.branchContext}
            attachments={data.attachments}
          />
        ) : (data.attachments?.length ?? 0) > 0 && (
          <div className="flex justify-end"><QuestionAttachments nodeId={selectedNodeId!} attachments={data.attachments} /></div>
        )}

        <ResponseSection
          key={`r-${selectedNodeId}`}
          nodeId={selectedNodeId!}
          data={data}
          hasMultipleVersions={hasMultipleVersions}
          highlightedTexts={highlightedTexts}
          onExploreSelection={setBranchContext}
          onFocusNode={onFocusNode}
        />

        <ContextOrderSection nodeId={node.id} />

        {/* What the turn left: the files it changed, where it came from, what was marked; empty ones stay out */}
        {!data.isLoading && (
          <div className="flex flex-col gap-1.5 empty:hidden">
            <ChangedFiles data={data} />
            <CondensedFrom data={data} onFocusNode={onFocusNode} />
            {data.highlights.length > 0 && (
              <HighlightsSection
                key={`h-${selectedNodeId}`}
                nodeId={selectedNodeId!}
                highlights={data.highlights}
                highlightMode={data.highlightMode}
                onExplore={setBranchContext}
              />
            )}
          </div>
        )}
      </div>

      {/* The ONE box — pinned at the bottom. A waiting card's question is
          typed here (it goes into the card); once answered, the same box
          asks on, and selected text or highlights stage into it. */}
      {!isViewerMode && (
        <div className="relative shrink-0 px-4 pb-3 pt-2">
            <Composer
              key={selectedNodeId}
              contextPreview={false}
              running={!awaiting && data.isLoading}
              onStop={() => stopGeneration(selectedNodeId!)}
              target={awaiting ? { kind: 'ask-this', nodeId: selectedNodeId! } : { kind: 'child', parentId: selectedNodeId! }}
              placeholder={awaiting ? (data.instruction || t(data.converge ? (data.converge.kind === 'merge' ? 'converge.mergePlaceholder' : 'converge.weavePlaceholder') : 'node.askPlaceholder')) : undefined}
              passage={awaiting ? undefined : branchContext}
              onClearPassage={() => setBranchContext('')}
              focusKey={`${selectedNodeId}:${branchContext}`}
              onFocusNode={onFocusNode}
            />
        </div>
      )}
    </div>
  );
}
