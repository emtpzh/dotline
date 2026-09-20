import { useState, useRef, useEffect, useMemo } from 'react';
import { describeModel } from '../../lib/use-models';
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, Maximize2, RefreshCw, Trash2, Pencil } from 'lucide-react';
import { useStore } from '../../store';
import { isFactNode } from '../../lib/facts';
import { useUiStore } from '../../lib/ui-store';
import { generateId } from '../../utils';
import { copyText } from '../../lib/export';
import { Markdown, HighlightedMarkdown } from '../Markdown';
import { useT } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import { collectExploreMarksKey, type ExploreMark } from '../../lib/explore-marks';
import ReasoningDisclosure from '../app/ReasoningDisclosure';
import { ApprovalCard, DecisionsDisclosure } from '../app/ApprovalCard';
import { AgentTrace } from '../app/AgentTrace';
import type { ThoughtData } from '../../types';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import SelectionActions from '../app/SelectionActions';
import { useTextSelection } from '../../lib/use-text-selection';

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
    if (!childId) return;
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
  // the rest streams in); scroll back down to re-engage following.
  useEffect(() => {
    const el = streamRef.current;
    if (!data.isLoading || !el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [data.isLoading, data.response, data.reasoning]);

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

  return (
    <div className="panel-card px-4 py-3">
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-2xs font-semibold text-success">{t('panel.response')}</label>
        {(data.response || data.isLoading) && (
          <Button variant="ghost" size="icon-sm"
            onClick={() => useUiStore.getState().setResponseViewerNodeId(nodeId)}
            title={t('panel.expandResponse')}
            className="text-muted-foreground hover:text-primary hover:bg-accent"
            data-response-expand
          >
            <Maximize2 size={13} strokeWidth={1.75} />
          </Button>
        )}
      </div>

      {data.isLoading && data.pendingApprovals?.length ? (
        <div className="py-1 flex flex-col gap-1.5">{data.pendingApprovals.map((req) => <ApprovalCard key={req.id} nodeId={nodeId} request={req} />)}</div>
      ) : data.isLoading && data.agentTrace && data.agentTrace.length > 0 && (!data.response || data.restreaming) ? (
        <div className="py-1"><AgentTrace entries={data.agentTrace} /></div>
      ) : data.isLoading && (!data.response || data.restreaming) ? (
        data.reasoning ? (
          <div className="py-1">
            <div className="text-2xs text-muted-foreground mb-1">💭 {t('node.reasoningLive')}</div>
            <div ref={streamRef} className="text-xs text-muted-foreground italic leading-relaxed whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
              {data.reasoning.length > 4000 ? '…' + data.reasoning.slice(-4000) : data.reasoning}
            </div>
          </div>
        ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="animate-pulse text-primary">●</span> {t('common.thinking')}
        </div>
        )
      ) : data.isLoading && data.response && !data.restreaming ? (
        <div ref={streamRef} className="markdown-body text-sm text-foreground leading-relaxed max-h-[500px] overflow-y-auto py-1">
          <Markdown base={data.importSource?.cwd}>{data.response}</Markdown>
          <span className="inline-block w-2 h-4 bg-primary animate-pulse rounded-sm ml-0.5 align-text-bottom" />
        </div>
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
        <div ref={responseRef} className="relative">
          {data.approvals && data.approvals.length > 0 && <DecisionsDisclosure records={data.approvals} />}
          {data.reasonings?.[data.responseIndex] && (
            <ReasoningDisclosure text={data.reasonings[data.responseIndex]!} />
          )}
          <div className="markdown-body text-sm text-foreground leading-relaxed cursor-text py-1" onClick={handleExploreMarkClick}>
            {highlightedTexts.size > 0 || exploreSpecs.length > 0 ? (
              <HighlightedMarkdown content={data.response} highlights={highlightedTexts} exploreMarks={exploreSpecs} />
            ) : (
              <Markdown base={data.importSource?.cwd}>{data.response}</Markdown>
            )}
          </div>

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
        <div className="mt-2 flex items-center gap-0.5 text-muted-foreground">
          {!isViewerMode && <Button variant="ghost" size="icon-sm"
            onClick={() => void rerunNode(nodeId, {})}
            className="hover:text-primary hover:bg-accent"
            title={t('common.regenerate')}
          >
            <RefreshCw size={15} strokeWidth={1.75} />
          </Button>}
          <Button variant="ghost" size="icon-sm"
            onClick={() => void copyText(data.response)}
            className="hover:text-primary hover:bg-accent"
            title={t('actions.copyResponse')}
          >
            <Copy size={14} strokeWidth={1.75} />
          </Button>
          {!isViewerMode && (
            <Button variant="ghost" size="icon-sm"
              onClick={startEditResponse}
              className="hover:text-primary hover:bg-accent"
              title={t('actions.editResponse')}
              data-edit-response
            >
              <Pencil size={14} strokeWidth={1.75} />
            </Button>
          )}
          {(data.generatedBy?.[data.responseIndex]) && (
            <span
              className="text-2xs text-muted-foreground font-mono ml-1 truncate flex-1 min-w-0 max-w-[420px]"
              title={`${t('node.generatedByTitle')} · ${describeModel(data.generatedBy[data.responseIndex], data.generatedEfforts?.[data.responseIndex])}`}
            >
              {describeModel(data.generatedBy[data.responseIndex], data.generatedEfforts?.[data.responseIndex])}
            </span>
          )}
          {hasMultipleVersions && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground ml-1">
              <Button variant="ghost" size="icon-sm" onClick={() => navigateVersion(nodeId, 'prev')} className="hover:text-primary hover:bg-accent"><ChevronLeft size={14} strokeWidth={1.75} /></Button>
              <span className="text-primary font-medium">v{data.responseIndex + 1}/{data.responses.length}</span>
              <Button variant="ghost" size="icon-sm" onClick={() => navigateVersion(nodeId, 'next')} className="hover:text-primary hover:bg-accent"><ChevronRight size={14} strokeWidth={1.75} /></Button>
              {!isViewerMode && <Button variant="ghost" size="icon-sm"
                onClick={() => deleteVersion(nodeId, data.responseIndex)}
                className="text-muted-foreground hover:text-destructive/90 hover:bg-destructive/10"
                title={t('common.deleteVersion')}
              >
                <Trash2 size={13} strokeWidth={1.75} />
              </Button>}
            </div>
          )}
        </div>
      )}

      {/* Web references consulted for this response */}
      {data.references && data.references.length > 0 && !data.isLoading && (
        <div className="mt-3 pt-2 border-t border-border/60">
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
        <div className="mt-2 flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/15 rounded-lg px-3 py-2">
          <AlertTriangle size={14} strokeWidth={1.75} className="shrink-0" />
          {t('common.generationFailed')}
          {!isViewerMode && <Button variant="destructive" size="xs"
            onClick={() => editQuestion(nodeId, data.question)}
            className="ml-auto border-destructive/30"
          >
            <RefreshCw size={12} strokeWidth={1.75} /> {t('common.retry')}
          </Button>}
        </div>
      )}
    </div>
  );
}
