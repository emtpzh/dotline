import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { Markdown, HighlightedMarkdown } from '../Markdown';
import ReasoningDisclosure from './ReasoningDisclosure';
import { isViewerMode } from '../../lib/viewer';
import { generateId } from '../../utils';
import { useT } from '../../i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import Composer from './composer/Composer';
import SelectionActions from './SelectionActions';
import { useTextSelection } from '../../lib/use-text-selection';
import { turnOf } from '../../lib/sessions/turn';
import { useRuns, withOverlay } from '../../lib/agents/runs';

// The answer, reading-size: the same reading loop the PDF reader gives
// external material, for the model's own text — select to highlight or to
// branch from a passage, ask a follow-up below. Every answer is reading
// material; every reading invites divergence. Follow-ups keep you in the
// viewer: it swaps to the new node and streams the answer in place, so a
// whole chain of questions can be read and asked without leaving.

export default function ResponseViewer() {
  const nodeId = useUiStore((s) => s.responseViewerNodeId);
  const node = useStore((s) => (nodeId ? s.nodes.find((n) => n.id === nodeId) : undefined));
  const runOverlay = useRuns((s) => (nodeId ? s.runs[nodeId] : undefined));
  const t = useT();
  const close = () => useUiStore.getState().setResponseViewerNodeId(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  // the reading pane as an element (not a ref): the selection bar is kept
  // inside it, and a collision boundary has to be read during render
  const [readingPane, setReadingPane] = useState<HTMLDivElement | null>(null);
  const [branchFrom, setBranchFrom] = useState('');
  const { text: selectedText, anchor: selectionAnchor, clear: clearSelection, reset: resetSelection } =
    useTextSelection(bodyRef, !!nodeId && !isViewerMode);

  useEffect(() => {
    if (!nodeId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [nodeId]);

  // Reset staged input when the viewer swaps nodes (render-time adjust)
  const [prevNodeId, setPrevNodeId] = useState(nodeId);
  if (prevNodeId !== nodeId) {
    setPrevNodeId(nodeId);
    setBranchFrom(''); resetSelection();
  }

  if (!nodeId || !node) return null;
  const data = withOverlay(node.data, runOverlay);
  const reasoning = data.reasonings?.[data.responseIndex];
  const canInteract = !isViewerMode && !data.stepKind;

  const highlightSelection = (text: string) => {
    useStore.getState().addHighlight(nodeId, { id: generateId(), text });
    clearSelection();
  };

  const branchFromSelection = (text: string) => {
    setBranchFrom(text);
    clearSelection();
  };

  return (
    <Dialog open={!!node} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent
        size="full"
        className="p-0 gap-0 h-[92vh] flex flex-col overflow-hidden"
        data-response-viewer
      >
        <DialogHeader className="px-6 py-4 pr-14 border-b bg-card shrink-0">
          <DialogTitle className="line-clamp-2 leading-snug">{data.question}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-8 py-6" ref={setReadingPane}>
          <div className="max-w-[760px] mx-auto" ref={bodyRef}>
            {reasoning && <ReasoningDisclosure text={reasoning} />}
            {data.isLoading && (!data.response || data.restreaming) ? (
              data.reasoning ? (
                <div>
                  <div className="text-2xs text-muted-foreground mb-1">{t('node.reasoningLive')}</div>
                  <div className="text-xs text-muted-foreground italic leading-relaxed whitespace-pre-wrap break-words">{data.reasoning}</div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
                  <Loader2 size={16} strokeWidth={1.75} className="animate-spin text-primary" /> {t('common.thinking')}
                </div>
              )
            ) : (
              <div className="markdown-body text-[15px] text-foreground leading-relaxed cursor-text">
                {data.highlights.length > 0 && !data.isLoading ? (
                  <HighlightedMarkdown content={data.response} highlights={new Set(data.highlights.map((h) => h.text))} />
                ) : (
                  <Markdown base={turnOf(data)?.cwd ?? undefined}>{data.response}</Markdown>
                )}
                {data.isLoading && <span className="tdag-caret ml-0.5" />}
              </div>
            )}
          </div>
        </div>

        {/* Selection bar: the card's grammar, in reading size */}
        {canInteract && (
          <SelectionActions
            text={selectedText}
            anchor={selectionAnchor}
            onExplore={branchFromSelection}
            onHighlight={highlightSelection}
            boundary={readingPane}
          />
        )}

        {/* Follow-up right where you read — the answer streams back into
            this same viewer (the divergence loop never leaves the text) */}
        {canInteract && (
          <div className="border-t border-border bg-card px-6 py-3 shrink-0">
            <div className="max-w-[760px] mx-auto">
              <Composer
                target={{ kind: 'child', parentId: nodeId }}
                placeholder={branchFrom ? t('viewerqa.placeholderBranch') : t('viewerqa.placeholder')}
                passage={branchFrom}
                onClearPassage={() => setBranchFrom('')}
                focusKey={branchFrom}
                autoFocus={!!branchFrom}
                blocked={data.isLoading}
                // the new card's answer streams in this same viewer
                onSent={(id) => { if (id) useUiStore.getState().setResponseViewerNodeId(id); }}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
