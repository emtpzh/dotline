import { useState, useRef, useEffect, useMemo } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, RefreshCw, Trash2, Pencil } from 'lucide-react';
import { useStore } from '../../store';
import { isFactNode } from '../../lib/facts';
import { generateId } from '../../utils';
import { copyText } from '../../lib/export';
import { Markdown, HighlightedMarkdown } from '../Markdown';
import { useT } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import { collectExploreMarksKey, type ExploreMark } from '../../lib/explore-marks';
import ReasoningDisclosure from '../app/ReasoningDisclosure';
import { ApprovalCard, DecisionsDisclosure } from '../app/ApprovalCard';
import type { ThoughtData } from '../../types';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import SelectionActions from '../app/SelectionActions';
import { RegenerateWith } from '../app/composer/RunControls';
import { nodeIntent } from '../../store/intent';
import { isAgentModel, runtimeOf } from '../../lib/agents/runtimes';
import { useTextSelection } from '../../lib/use-text-selection';
import { turnOf } from '../../lib/sessions/turn';
import { interleave, transcriptSteps } from '../../lib/transcript';
import { LiveStepsLine, StepsLine } from './StepsLine';
import { ACTION, ACTION_ICON } from './line';
import { TurnStamp } from './TurnLines';

export default function ResponseSection({
  nodeId,
  data,
  hasMultipleVersions,
  highlightedTexts,
  onExploreSelection,
  onFocusNode,
}: {
  nodeId: string;
  data: ThoughtData;
  hasMultipleVersions: boolean;
  highlightedTexts: Set<string>;
  onExploreSelection: (text: string) => void;
  onFocusNode?: (id: string) => void;
}) {
  const editResponse = useStore((s) => s.editResponse);
  const editQuestion = useStore((s) => s.editQuestion);
  const setEditingResponse = useStore((s) => s.setEditingResponse);
  const navigateVersion = useStore((s) => s.navigateVersion);
  const rerunNode = useStore((s) => s.rerunNode);
  const deleteVersion = useStore((s) => s.deleteVersion);
  const addHighlight = useStore((s) => s.addHighlight);
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);
  const setNodeIntent = useStore((s) => s.setNodeIntent);
  // what a regenerate runs on: the node's own intent, or its line's
  const intentModel = useStore((s) => nodeIntent(nodeId, s.nodes, s.edges).model);
  const intentEffort = useStore((s) => nodeIntent(nodeId, s.nodes, s.edges).effort);
  // the same question on another model: the node takes it (another model
  // starts at its runtime's default level; another runtime settles its own
  // directory at its first run), then answers again as a new version
  const regenerateWith = (m: string) => {
    setNodeIntent(nodeId, {
      model: m,
      effort: isAgentModel(m) ? (m === intentModel ? intentEffort ?? '' : '') : undefined,
      ...(runtimeOf(m) !== runtimeOf(intentModel) ? { cwd: undefined } : {}),
    });
    void rerunNode(nodeId, {});
  };
  // Passages child branches explore from (derived from the children).
  // Clicking a mark walks the panel to that branch and centers it. The
  // selector returns the serialized form: a fresh array from a selector
  // re-renders forever (Object.is snapshot comparison).
  const exploreMarksKey = useStore((s) => collectExploreMarksKey(nodeId, s.nodes, s.edges));
  const exploreMarks = useMemo(() => JSON.parse(exploreMarksKey) as ExploreMark[], [exploreMarksKey]);
  const t = useT();
  const exploreSpecs = exploreMarks.map((m) => ({
    text: m.text,
    nodeId: m.nodeId,
    title: `${t('node.exploredHere')} · ${m.question.slice(0, 80)}`,
  }));
  const handleExploreMarkClick = (e: React.MouseEvent) => {
    const m = (e.target as HTMLElement).closest?.('mark[data-explore-target]');
    if (!m) return;
    if (window.getSelection()?.toString()) return; // a drag-select, not a click
    e.stopPropagation();
    const childId = m.getAttribute('data-explore-target');
    // the same guard the card's click has: a mark whose node is gone does
    // nothing, instead of selecting an id the panel cannot show
    if (!childId || !useStore.getState().nodes.some((n) => n.id === childId)) return;
    setSelectedNodeId(childId);
    onFocusNode?.(childId);
  };

  const [editResponseValue, setEditResponseValue] = useState('');
  const responseRef = useRef<HTMLDivElement>(null);
  // selection menu stages writes, so the shared viewer has none
  const { text: selectedText, anchor: selectionAnchor, clear: clearSelection } =
    useTextSelection(responseRef, !isViewerMode);
  const streamRef = useRef<HTMLDivElement>(null);

  // Follow the stream — but only while the reader is at the bottom. Scroll
  // up during generation and the view stays put (read from the top while
  // the rest streams in); scroll back down to re-engage following. The
  // reasoning stream scrolls in its own box; the answer, in the panel's.
  useEffect(() => {
    const own = streamRef.current;
    const el = own && own.scrollHeight > own.clientHeight + 1 ? own : own?.closest<HTMLElement>('[data-panel-scroll]');
    if (!data.isLoading || !el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [data.isLoading, data.response, data.reasoning, data.agentTrace]);

  // Button-triggered (see ThoughtNode): double-click stays a text gesture.
  const startEditResponse = () => {
    if (isViewerMode) return;
    setEditResponseValue(data.response);
    setEditingResponse(nodeId, true);
  };

  const handleResponseEditSubmit = () => {
    editResponse(nodeId, editResponseValue);
  };

  const handleResponseEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setEditingResponse(nodeId, false);
  };

  const handleHighlight = (text: string) => {
    addHighlight(nodeId, { id: generateId(), text });
    clearSelection();
  };

  const handleBranchFromSelection = (text: string) => {
    onExploreSelection(text);
    clearSelection();
  };

  // No response yet and nothing in flight (e.g. a fresh ask node or a
  // paradigm human turn) — the card would be an empty box, so skip it.
  if (!data.response && !data.isLoading && !data.isEditingResponse && !data.generationFailed) {
    return null;
  }

  const base = turnOf(data)?.cwd ?? undefined;
  const answerText = (text: string) => (highlightedTexts.size > 0 || exploreSpecs.length > 0
    ? <HighlightedMarkdown content={text} highlights={highlightedTexts} exploreMarks={exploreSpecs} />
    : <Markdown base={base}>{text}</Markdown>);
  // the calls sit where they came back, while the answer is the one they were recorded against
  const placed = !!data.source && data.response === data.source.response;
  const liveText = data.restreaming ? '' : data.response;
  const liveTrace = data.agentTrace ?? [];

  return (
    <div className="flex flex-col gap-3" data-panel-response>
      {data.isLoading && (liveText || liveTrace.length > 0) ? (
        <div ref={streamRef} className="flex flex-col gap-3">
          {interleave(liveText, liveTrace, true).map((part, i, parts) => (part.kind === 'steps'
            ? <LiveStepsLine key={`s${i}`} entries={part.steps} />
            : (
              <div key={`t${i}`} className="markdown-body text-[13px] text-foreground">
                <Markdown base={base}>{part.text}</Markdown>
                {i === parts.length - 1 && <span className="tdag-caret ml-0.5 align-text-bottom" />}
              </div>
            )))}
          {data.pendingApprovals?.map((req) => <ApprovalCard key={req.id} nodeId={nodeId} request={req} />)}
        </div>
      ) : data.isLoading && data.pendingApprovals?.length ? (
        <div className="flex flex-col gap-1.5">{data.pendingApprovals.map((req) => <ApprovalCard key={req.id} nodeId={nodeId} request={req} />)}</div>
      ) : data.isLoading ? (
        data.reasoning ? (
          <div>
            <div className="text-[13px] text-muted-foreground mb-1">{t('node.reasoningLive')}</div>
            <div ref={streamRef} className="text-xs text-muted-foreground italic leading-relaxed whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
              {data.reasoning.length > 4000 ? '…' + data.reasoning.slice(-4000) : data.reasoning}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className="animate-pulse text-primary">●</span> {t('common.thinking')}
          </div>
        )
      ) : data.isEditingResponse ? (
        <div>
          <Textarea
            value={editResponseValue}
            onChange={(e) => setEditResponseValue(e.target.value)}
            onKeyDown={handleResponseEditKeyDown}
            className="w-full border-primary resize-y min-h-[150px]"
            rows={10}
            autoFocus
          />
          {isFactNode({ data }) && <p className="text-2xs text-muted-foreground mt-1.5" data-fact-note>{t('fact.editResponseNote')}</p>}
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="ghost" size="sm" onClick={() => setEditingResponse(nodeId, false)} className="text-xs text-muted-foreground hover:text-foreground hover:bg-accent">{t('common.cancel')}</Button>
            <Button size="sm" onClick={handleResponseEditSubmit}>{t('common.save')}</Button>
          </div>
        </div>
      ) : (
        <div ref={responseRef} className="relative flex flex-col gap-3">
          {data.approvals && data.approvals.length > 0 && <DecisionsDisclosure records={data.approvals} />}
          {data.reasonings?.[data.responseIndex] && (
            <ReasoningDisclosure text={data.reasonings[data.responseIndex]!} />
          )}
          {interleave(data.response, transcriptSteps(data.steps), placed).map((part, i) => (part.kind === 'steps'
            ? <StepsLine key={`s${i}`} steps={part.steps} />
            : (
              <div key={`t${i}`} className="markdown-body text-[13px] text-foreground cursor-text" onClick={handleExploreMarkClick}>
                {answerText(part.text)}
              </div>
            )))}

          {/* Select a passage → explore / highlight */}
          <SelectionActions
            text={selectedText}
            anchor={selectionAnchor}
            onExplore={handleBranchFromSelection}
            onHighlight={handleHighlight}
          />
        </div>
      )}

      {/* Response action row — the actions that act on THIS answer live
          under it (LLM-chat convention); the sibling-branch variant is in
          the header's ⋯ menu */}
      {data.response && !data.isLoading && !data.isEditingResponse && !data.generationFailed && (
        <div className="-ml-1.5 -mt-1 flex items-center gap-0.5 text-muted-foreground" data-response-actions>
          {!isViewerMode && (
            <Button variant="ghost" size="icon-sm" className={ACTION} onClick={() => void rerunNode(nodeId, {})} title={t('common.regenerate')}>
              <RefreshCw strokeWidth={1.75} className={ACTION_ICON} />
            </Button>
          )}
          {!isViewerMode && <RegenerateWith current={intentModel} onPick={regenerateWith} />}
          <Button variant="ghost" size="icon-sm" className={ACTION} onClick={() => void copyText(data.response)} title={t('actions.copyResponse')}>
            <Copy strokeWidth={1.75} className={ACTION_ICON} />
          </Button>
          {!isViewerMode && (
            <Button variant="ghost" size="icon-sm" className={ACTION} onClick={startEditResponse} title={t('actions.editResponse')} data-edit-response>
              <Pencil strokeWidth={1.75} className={ACTION_ICON} />
            </Button>
          )}
          {hasMultipleVersions && (
            <div className="group/versions ml-2 flex items-center gap-0.5 text-xs">
              <Button variant="ghost" size="icon-sm" className={ACTION} onClick={() => navigateVersion(nodeId, 'prev')}><ChevronLeft strokeWidth={1.75} className={ACTION_ICON} /></Button>
              <span className="px-0.5 tabular-nums">{data.responseIndex + 1} / {data.responses.length}</span>
              <Button variant="ghost" size="icon-sm" className={ACTION} onClick={() => navigateVersion(nodeId, 'next')}><ChevronRight strokeWidth={1.75} className={ACTION_ICON} /></Button>
              {!isViewerMode && (
                <Button variant="ghost" size="icon-sm"
                  onClick={() => deleteVersion(nodeId, data.responseIndex)}
                  className={`${ACTION} opacity-0 group-hover/versions:opacity-100 focus-visible:opacity-100 hover:text-destructive hover:bg-destructive/10`}
                  title={t('common.deleteVersion')}
                >
                  <Trash2 strokeWidth={1.75} className={ACTION_ICON} />
                </Button>
              )}
            </div>
          )}
          <TurnStamp data={data} />
        </div>
      )}

      {/* Web references consulted for this response */}
      {data.references && data.references.length > 0 && !data.isLoading && (
        <div className="pt-2 border-t border-border/60" data-panel-section="refs">
          <p className="text-2xs text-muted-foreground font-medium mb-1.5">{t('refs.title')}</p>
          <ol className="space-y-1">
            {data.references.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-xs leading-snug">
                <span className="shrink-0 text-2xs text-muted-foreground font-mono mt-0.5">[{i + 1}]</span>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noreferrer" className="text-primary hover:text-primary/90 hover:underline break-all">
                    {r.title}
                  </a>
                ) : (
                  <span className="text-muted-foreground">{r.title}</span>
                )}
                {(r.media || r.date) && (
                  <span className="shrink-0 text-2xs text-muted-foreground">{[r.media, r.date].filter(Boolean).join(' · ')}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Failed generation: retry in place */}
      {data.generationFailed && !data.isLoading && (
        <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/15 rounded-lg px-3 py-2">
          <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0" />
          {t('common.generationFailed')}
          {!isViewerMode && <Button variant="destructive" size="xs"
            onClick={() => editQuestion(nodeId, data.question)}
            className="ml-auto border-destructive/30"
          >
            <RefreshCw strokeWidth={1.75} /> {t('common.retry')}
          </Button>}
        </div>
      )}
    </div>
  );
}
