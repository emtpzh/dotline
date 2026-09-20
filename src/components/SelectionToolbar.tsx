import { AlignVerticalJustifyStart, Archive, ClipboardList, Copy, FileDown, GitBranch, Highlighter, Trash2 } from 'lucide-react';
import { useStore } from '../store';
import { confirmDialog, useUiStore } from '../lib/ui-store';
import { selectionMarkdown, downloadMarkdown } from '../lib/export';
import { useT, t as ti, fmt } from '../i18n';
import { Button } from './ui/button';

// Converge actions (merge / weave / explore) each land one new node, unasked,
// wired from the selection: the question — or, for merge and weave, an
// optional extra request — is typed on that node, where the model can be
// picked first. Nothing runs from the toolbar itself.

export default function SelectionToolbar() {
  const { selectedNodeIds, nodes, batchDelete, convergeFrom, alignSelection, setArchived, duplicateSelection } = useStore();
  const t = useT();

  if (selectedNodeIds.length < 2) return null;

  const selectedNodes = selectedNodeIds
    .map((id) => nodes.find((n) => n.id === id))
    .filter(Boolean);

  const totalTokens = selectedNodes.reduce((sum, n) => sum + (n?.data.tokenCount || 0), 0);

  // Collect all highlights from selected nodes
  const allHighlights = selectedNodes.flatMap((n) => n?.data.highlights || []);

  const converge = (kind: 'explore' | 'merge' | 'weave') => {
    const id = convergeFrom(selectedNodeIds, kind);
    if (id) useUiStore.getState().setArrivalFocusNodeId(id);
  };

  const actionBtn = 'text-xs px-3 py-1.5 rounded-lg transition-colors';

  return (
    <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 animate-fade-in">
      <div className="bg-card/95 backdrop-blur border border-border rounded-xl px-4 py-3 shadow-lg space-y-2">
        {/* Header */}
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground font-medium">
            {fmt(t('toolbar.nodesSelected'), { n: selectedNodeIds.length })}
            <span className="text-xs text-muted-foreground ml-1.5">
              ({fmt(t('toolbar.tokens'), { n: totalTokens })}{allHighlights.length > 0 ? fmt(t('toolbar.highlightCount'), { n: allHighlights.length }) : ''})
            </span>
          </span>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="ghost"
            onClick={() => converge('merge')}
            className={`${actionBtn} bg-primary/10 hover:bg-primary/15 text-primary`}
            title={t('toolbar.mergeSummaryTitle')}
          >
            <ClipboardList strokeWidth={1.75} className="inline" /> {t('toolbar.mergeSummary')}
          </Button>

          {allHighlights.length > 0 && (
            <Button variant="ghost"
              onClick={() => converge('weave')}
              className={`${actionBtn} bg-warning/10 hover:bg-warning/20 text-warning`}
              title={t('toolbar.weaveTitle')}
            >
              <Highlighter strokeWidth={1.75} className="inline" /> {t('toolbar.weave')}
            </Button>
          )}

          <Button variant="ghost"
            onClick={() => converge('explore')}
            className={`${actionBtn} bg-primary/10 hover:bg-primary/20 text-primary`}
            title={t('toolbar.exploreTitle')}
          >
            <GitBranch strokeWidth={1.75} className="inline" /> {t('common.explore')}
          </Button>

          {/* Low-frequency actions: icon-only so the row stays one line in
              both languages (full label lives in the tooltip). */}
          <Button variant="ghost" size="icon"
            onClick={() => { setArchived(selectedNodeIds, true); }}
            className="bg-muted hover:bg-border text-muted-foreground"
            title={`${t('archive.label')} — ${t('archive.batchTitle')}`}
          >
            <Archive strokeWidth={1.75} />
          </Button>

          <Button variant="ghost" size="icon"
            onClick={() => duplicateSelection(selectedNodeIds)}
            className="bg-muted hover:bg-border text-muted-foreground"
            title={`${t('toolbar.duplicate')} — ${t('toolbar.duplicateTitle')}`}
          >
            <Copy strokeWidth={1.75} />
          </Button>

          <Button variant="ghost" size="icon"
            onClick={() => {
              void confirmDialog({
                title: t('confirm.alignTitle'),
                message: fmt(t('confirm.alignMsg'), { n: selectedNodeIds.length }),
                confirmLabel: t('common.confirmAlign'),
              }).then((ok) => { if (ok) alignSelection(selectedNodeIds); });
            }}
            className="bg-muted hover:bg-border text-muted-foreground"
            title={`${t('toolbar.align')} — ${t('confirm.alignTitle')}`}
          >
            <AlignVerticalJustifyStart strokeWidth={1.75} />
          </Button>

          <Button variant="ghost" size="icon"
            onClick={() => downloadMarkdown(selectionMarkdown(selectedNodeIds))}
            className="bg-muted hover:bg-border text-muted-foreground"
            title={`${t('common.exportMd')} — ${t('toolbar.exportTitle')}`}
          >
            <FileDown strokeWidth={1.75} />
          </Button>

          <div className="w-px h-5 bg-border" />

          <Button variant="destructive" size="sm"
            onClick={() => {
              void confirmDialog({
                title: ti('confirm.deleteNodesTitle'),
                message: fmt(ti('confirm.deleteNodes'), { n: selectedNodeIds.length }),
                confirmLabel: ti('common.delete'),
                danger: true,
              }).then((ok) => { if (ok) batchDelete(selectedNodeIds); });
            }}>
            <Trash2 strokeWidth={1.75} className="inline" /> {t('toolbar.deleteAll')}
          </Button>
        </div>

      </div>
    </div>
  );
}
