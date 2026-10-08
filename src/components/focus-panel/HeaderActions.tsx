import { useState } from 'react';
import { Archive, ArchiveRestore, ClipboardCopy, Copy, Ellipsis, FileDown, GitFork, Square, Trash2, Undo2 } from 'lucide-react';
import { useStore } from '../../store';
import { contextChainMarkdown, downloadMarkdown, copyText } from '../../lib/export';
import { toast, confirmDialog } from '../../lib/ui-store';
import { useT, fmt } from '../../i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Button } from '../ui/button';

// Compact action strip: archive, and everything else behind "…". What acts
// on the answer (regenerate, on another model too) sits under the answer;
// asking on in several roles at once is the card's right-click menu; a
// parallel answer as its own card too.

export default function HeaderActions({ nodeId, isLoading }: { nodeId: string; isLoading: boolean }) {
  const stopGeneration = useStore((s) => s.stopGeneration);
  const duplicateNode = useStore((s) => s.duplicateNode);
  const deleteNode = useStore((s) => s.deleteNode);
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);
  const deleteConvergeSources = useStore((s) => s.deleteConvergeSources);
  // a merge that has answered can take its sources off the canvas
  const mergedSources = useStore((s) => {
    const d = s.nodes.find((x) => x.id === nodeId)?.data;
    return d?.converge?.kind === 'merge' && d.response ? d.converge.sources.filter((id) => s.nodes.some((n) => n.id === id)).length : 0;
  });
  const setArchived = useStore((s) => s.setArchived);
  const isArchived = useStore((s) => !!s.nodes.find((n) => n.id === nodeId)?.data.archived);
  // fine tier of recoverability: a mirror node that drifted from its
  // frozen source snapshot can be put back — text only, never structure
  const diverged = useStore((s) => {
    const n = s.nodes.find((x) => x.id === nodeId);
    return !!n?.data.source && (n.data.question !== n.data.source.question || n.data.response !== n.data.source.response);
  });
  const revisionOf = useStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.revisionOf);
  const originalExists = useStore((s) => !!revisionOf && s.nodes.some((n) => n.id === revisionOf));
  const t = useT();

  const revertToSource = () => {
    const s = useStore.getState();
    const node = s.nodes.find((x) => x.id === nodeId);
    if (!node?.data.source) return;
    s.pushHistory();
    useStore.setState((st) => ({
      nodes: st.nodes.map((n) => (n.id === nodeId
        ? { ...n, data: { ...n.data, question: n.data.source!.question, response: n.data.source!.response } } : n)),
    }));
    toast('success', t('panel.reverted'));
  };

  const [menuOpen, setMenuOpen] = useState(false);

  const iconBtn = 'text-muted-foreground hover:text-foreground hover:bg-border/50';

  return (
    <div className="relative flex items-center gap-1 shrink-0">
      {isLoading && (
        <Button variant="ghost" size="icon"
          onClick={() => stopGeneration(nodeId)}
          title={t('actions.stop')}
          className="text-white bg-destructive hover:bg-destructive/90"
        >
          <Square strokeWidth={1.75} fill="currentColor" />
        </Button>
      )}
      <Button variant="ghost"
        onClick={() => setArchived([nodeId], !isArchived)}
        title={isArchived ? t('archive.restoreTitle') : t('archive.title')}
        className={isArchived ? 'text-warning bg-warning/10' : iconBtn}
      >
        {isArchived ? <ArchiveRestore strokeWidth={1.75} /> : <Archive strokeWidth={1.75} />}
      </Button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          title={t('panel.more')}
          className={`${iconBtn} ${menuOpen ? 'bg-border/50 text-foreground' : ''}`}
        >
          <Ellipsis size={17} strokeWidth={1.75} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[210px]">
            <DropdownMenuItem onClick={() => { duplicateNode(nodeId); }}>
              <Copy size={15} strokeWidth={1.75} /> {t('common.duplicate')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { downloadMarkdown(contextChainMarkdown(nodeId)); }} title={t('actions.exportTitle')}>
              <FileDown size={15} strokeWidth={1.75} /> {t('common.exportMd')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { void copyText(contextChainMarkdown(nodeId)); }} title={t('actions.copyTitle')}>
              <ClipboardCopy size={15} strokeWidth={1.75} /> {t('actions.copyMd')}
            </DropdownMenuItem>
            {diverged && (
              <DropdownMenuItem onClick={() => { revertToSource(); }} data-revert-source>
                <Undo2 size={15} strokeWidth={1.75} /> {t('panel.revertToSource')}
              </DropdownMenuItem>
            )}
            {/* a revision leads back to the session turn it rewrote */}
            {originalExists && (
              <DropdownMenuItem onClick={() => { setSelectedNodeId(revisionOf!); }} data-open-original>
                <GitFork size={15} strokeWidth={1.75} /> {t('fact.openOriginal')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {mergedSources > 0 && (
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  void confirmDialog({
                    title: t('converge.deleteSourcesTitle'),
                    message: fmt(t('converge.deleteSourcesMsg'), { n: mergedSources }),
                    confirmLabel: t('common.delete'),
                    danger: true,
                  }).then((ok) => { if (ok) deleteConvergeSources(nodeId); });
                }}
                data-delete-merged-sources
              >
                <Trash2 size={15} strokeWidth={1.75} /> {t('converge.deleteSources')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              onClick={() => { deleteNode(nodeId); setSelectedNodeId(null); }}
            >
              <Trash2 size={15} strokeWidth={1.75} /> {t('common.delete')}
            </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

    </div>
  );
}
