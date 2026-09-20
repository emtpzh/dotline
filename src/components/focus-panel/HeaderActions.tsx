import { useState } from 'react';
import { Archive, ArchiveRestore, ClipboardCopy, Copy, Ellipsis, FileDown, GitFork, RefreshCw, Split, Square, Trash2, Undo2 } from 'lucide-react';
import { useStore } from '../../store';
import { contextChainMarkdown, downloadMarkdown, copyText } from '../../lib/export';
import ModelPicker from '../app/ModelPicker';
import { inheritIntent } from '../../lib/run-intent';
import { isAgentModel, runtimeOf } from '../../lib/agents/runtimes';
import { globalIntent, nodeIntent, parentsOf } from '../../store/intent';
import FanOutModal from '../FanOutModal';
import { toast, confirmDialog, useUiStore } from '../../lib/ui-store';
import { useT, fmt } from '../../i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';

// Compact action strip: the two actions you actually reach for (regenerate,
// archive) plus the model chip, everything else behind "…". Perspectives
// (once = candidates, follow = reviewers) live here until the palette lands.

export default function HeaderActions({ nodeId, isLoading }: { nodeId: string; isLoading: boolean }) {
  const regenerate = useStore((s) => s.regenerate);
  const rerunNode = useStore((s) => s.rerunNode);
  const stopGeneration = useStore((s) => s.stopGeneration);
  const duplicateNode = useStore((s) => s.duplicateNode);
  const deleteNode = useStore((s) => s.deleteNode);
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);
  const setNodeIntent = useStore((s) => s.setNodeIntent);
  const deleteConvergeSources = useStore((s) => s.deleteConvergeSources);
  // what this node runs on next: its own intent, or — not asked yet — the
  // line's (the global pick only for a root; the picker re-reads it)
  useUiStore((s) => s.selectedModel);
  const intentModel = useStore((s) => nodeIntent(nodeId, s.nodes, s.edges).model);
  const intentEffort = useStore((s) => nodeIntent(nodeId, s.nodes, s.edges).effort);
  // an unasked node whose sources disagree started from the global pick: say so until it is asked
  const mixedSources = useStore((s) => {
    const n = s.nodes.find((x) => x.id === nodeId);
    if (!n || n.data.responses.length > 0 || n.data.isLoading) return false;
    return !!inheritIntent(parentsOf(nodeId, s.nodes, s.edges), globalIntent()).mixed && n.data.model === globalIntent().model;
  });
  // a merge that has answered can take its sources off the canvas
  const mergedSources = useStore((s) => {
    const d = s.nodes.find((x) => x.id === nodeId)?.data;
    return d?.converge?.kind === 'merge' && d.response ? d.converge.sources.filter((id) => s.nodes.some((n) => n.id === id)).length : 0;
  });
  const setArchived = useStore((s) => s.setArchived);
  const isArchived = useStore((s) => !!s.nodes.find((n) => n.id === nodeId)?.data.archived);
  const nodeQuestion = useStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.question ?? '');
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
  const [fanOutOpen, setFanOutOpen] = useState(false);

  const iconBtn = 'text-muted-foreground hover:text-foreground hover:bg-border/50 rounded-lg w-8 h-8 flex items-center justify-center transition-colors';

  return (
    <div className="relative flex items-center gap-1 shrink-0">
      {isLoading ? (
        <button
          onClick={() => stopGeneration(nodeId)}
          title={t('actions.stop')}
          className="text-white bg-destructive hover:bg-destructive/90 rounded-lg w-8 h-8 flex items-center justify-center transition-colors"
        >
          <Square size={12} strokeWidth={1.75} fill="currentColor" />
        </button>
      ) : (
        <button
          onClick={() => void rerunNode(nodeId, {})}
          disabled={isLoading}
          title={isLoading ? t('node.generatingTitle') : t('common.regenerate')}
          className={`${iconBtn} disabled:opacity-25 disabled:cursor-not-allowed`}
        >
          <RefreshCw size={16} strokeWidth={1.75} className={isLoading ? 'animate-spin' : ''} />
        </button>
      )}
      <button
        onClick={() => setArchived([nodeId], !isArchived)}
        title={isArchived ? t('archive.restoreTitle') : t('archive.title')}
        className={isArchived ? 'text-warning bg-warning/10 rounded-lg w-8 h-8 flex items-center justify-center' : iconBtn}
      >
        {isArchived ? <ArchiveRestore size={16} strokeWidth={1.75} /> : <Archive size={16} strokeWidth={1.75} />}
      </button>
      <ModelPicker
        compact
        value={intentModel}
        // another model starts at its runtime's default level (the same one
        // keeps its level); another runtime settles its own directory at its first run
        onChange={(m) => setNodeIntent(nodeId, {
          model: m,
          effort: isAgentModel(m) ? (m === intentModel ? intentEffort ?? '' : '') : undefined,
          ...(runtimeOf(m) !== runtimeOf(intentModel) ? { cwd: undefined } : {}),
        })}
        effort={intentEffort}
        onEffortChange={(level) => setNodeIntent(nodeId, { model: intentModel, effort: level })}
        hint={mixedSources ? t('model.mixedSources') : undefined}
      />

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          title={t('panel.more')}
          className={`${iconBtn} ${menuOpen ? 'bg-border/50 text-foreground' : ''}`}
        >
          <Ellipsis size={17} strokeWidth={1.75} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[210px]">
            <DropdownMenuItem onClick={() => { setFanOutOpen(true); }} title={t('fanout.entryTitle')}>
              <Split size={15} strokeWidth={1.75} /> {t('fanout.entry')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { void regenerate(nodeId); }} title={t('actions.regenBranchTitle')}>
              <GitFork size={15} strokeWidth={1.75} /> {t('actions.regenBranch')}
            </DropdownMenuItem>
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

      {fanOutOpen && (
        <FanOutModal parentId={nodeId} initialQuestion={nodeQuestion} onClose={() => setFanOutOpen(false)} />
      )}
    </div>
  );
}
