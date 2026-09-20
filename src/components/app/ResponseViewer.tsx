import { useEffect, useRef, useState } from 'react';
import { GitBranch, Loader2, Send, X } from 'lucide-react';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { Markdown, HighlightedMarkdown } from '../Markdown';
import ReasoningDisclosure from './ReasoningDisclosure';
import { isViewerMode } from '../../lib/viewer';
import { generateId, isImeComposing } from '../../utils';
import { useT } from '../../i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import SelectionActions from './SelectionActions';
import { useTextSelection } from '../../lib/use-text-selection';

// The answer, reading-size: the same reading loop the PDF reader gives
// external material, for the model's own text — select to highlight or to
// branch from a passage, ask a follow-up below. Every answer is reading
// material; every reading invites divergence. Follow-ups keep you in the
// viewer: it swaps to the new node and streams the answer in place, so a
// whole chain of questions can be read and asked without leaving.

export default function ResponseViewer() {
  const nodeId = useUiStore((s) => s.responseViewerNodeId);
  const node = useStore((s) => (nodeId ? s.nodes.find((n) => n.id === nodeId) : undefined));
  const t = useT();
  const close = () => useUiStore.getState().setResponseViewerNodeId(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  // the reading pane as an element (not a ref): the selection bar is kept
  // inside it, and a collision boundary has to be read during render
  const [readingPane, setReadingPane] = useState<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [branchFrom, setBranchFrom] = useState('');
  const [input, setInput] = useState('');
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
    setBranchFrom(''); setInput(''); resetSelection();
  }

  if (!nodeId || !node) return null;
  const data = node.data;
  const reasoning = data.reasonings?.[data.responseIndex];
  const canInteract = !isViewerMode && !data.stepKind;

  const highlightSelection = (text: string) => {
    useStore.getState().addHighlight(nodeId, { id: generateId(), text });
    clearSelection();
  };

  const branchFromSelection = (text: string) => {
    setBranchFrom(text);
    clearSelection();
    setTimeout(() => inputRef.current?.focus(), 60);
  };

  const ask = () => {
    const q = input.trim();
    if (!q || data.isLoading) return;
    void useStore.getState().addQuestion(q, {
      parentId: nodeId,
      branchContext: branchFrom || undefined,
    });
    // addQuestion creates the node synchronously (generation is the async
    // part) — swap the viewer to it and read the answer as it streams
    const fresh = useStore.getState().nodes;
    const newId = fresh[fresh.length - 1]?.id;
    if (newId && newId !== nodeId) useUiStore.getState().setResponseViewerNodeId(newId);
    setInput('');
    setBranchFrom('');
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
                  <div className="text-2xs text-muted-foreground mb-1">💭 {t('node.reasoningLive')}</div>
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
                  <Markdown base={data.importSource?.cwd}>{data.response}</Markdown>
                )}
                {data.isLoading && <span className="inline-block w-2 h-4 bg-primary animate-pulse rounded-sm ml-0.5" />}
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
              {branchFrom && (
                <div className="mb-2 text-xs pl-3 py-1.5 pr-2 border-l-2 border-edge-explore bg-edge-explore/10 rounded-r text-muted-foreground flex items-start gap-1.5">
                  <GitBranch size={13} strokeWidth={1.75} className="text-edge-explore shrink-0 mt-0.5" />
                  <span className="italic leading-relaxed min-w-0 flex-1">“{branchFrom.slice(0, 160)}{branchFrom.length > 160 ? '…' : ''}”</span>
                  <Button variant="ghost" onClick={() => setBranchFrom('')} className="text-muted-foreground hover:text-foreground shrink-0" title={t('common.cancel')}>
                    <X strokeWidth={1.75} />
                  </Button>
                </div>
              )}
              <div className="flex items-end gap-2">
                <Textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) { e.preventDefault(); ask(); }
                  }}
                  placeholder={branchFrom ? t('viewerqa.placeholderBranch') : t('viewerqa.placeholder')}
                  rows={1}
                  className="flex-1 resize-none leading-relaxed"
                />
                <Button size="icon"
                  onClick={ask}
                  disabled={!input.trim() || data.isLoading}
                  title={t('viewerqa.askTitle')}
                  className="shrink-0"
                >
                  <Send strokeWidth={1.75} />
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
