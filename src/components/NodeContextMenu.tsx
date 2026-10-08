import { useMemo } from 'react';
import { Archive, ArchiveRestore, BookOpen, Copy, Files, FlaskConical, GitFork, LayoutGrid, Maximize2, PinOff, RefreshCw, Split, StickyNote, Trash2 } from 'lucide-react';
import { useStore } from '../store';
import { useUiStore, confirmDialog, toast } from '../lib/ui-store';
import { recapToNote } from '../lib/recap';
import { useT, fmt, t as ti } from '../i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from './ui/dropdown-menu';

// Right-click on a node: the app's own context menu (same visual language
// as the toolbar's ⋯ menu). The browser menu stays available where it is
// genuinely useful — right-clicking selected TEXT is not intercepted
// (see the onNodeContextMenu guard in App).

export default function NodeContextMenu({ x, y, nodeId, onClose }: {
  x: number; y: number; nodeId: string; onClose: () => void;
}) {
  const t = useT();
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const hasFollowers = useStore((s) => s.edges.some((e) => e.source === nodeId && !e.data?.isCrossLink));

  // The menu opens at the pointer, not at a trigger, so it is anchored to a
  // zero-size rectangle there; the positioner keeps it inside the viewport.
  const anchor = useMemo(() => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }), [x, y]);

  if (!node) return null;
  const kind = node.data.stepKind;
  const isContent = !!kind; // note / file / link / frame
  const hasResponse = !isContent && !!node.data.response && !node.data.isLoading;
  const copyText = isContent
    ? (kind === 'note' || kind === 'link' ? node.data.question : '')
    : node.data.response;

  const icon = 'text-muted-foreground shrink-0';

  return (
    <DropdownMenu open onOpenChange={(next: boolean) => { if (!next) onClose(); }}>
      <DropdownMenuContent anchor={anchor} align="start" className="w-[200px]">
        {!isContent && (
          <DropdownMenuItem onClick={() => {
            useStore.getState().setSelectedNodeId(nodeId);
            useUiStore.getState().setPanelOpen(true);
          }}>
            <BookOpen size={14} strokeWidth={1.75} className={icon} /> {t('ctx.openPanel')}
          </DropdownMenuItem>
        )}
        {hasResponse && (
          <DropdownMenuItem onClick={() => useUiStore.getState().setResponseViewerNodeId(nodeId)}>
            <Maximize2 size={14} strokeWidth={1.75} className={icon} /> {t('ctx.readingView')}
          </DropdownMenuItem>
        )}
        {hasResponse && (
          <DropdownMenuItem onClick={() => { void useStore.getState().rerunNode(nodeId); }}>
            <RefreshCw size={14} strokeWidth={1.75} className={icon} /> {t('ctx.rerun')}
          </DropdownMenuItem>
        )}
        {hasResponse && (
          <DropdownMenuItem title={ti('actions.regenBranchTitle')} onClick={() => { void useStore.getState().regenerate(nodeId); }}>
            <GitFork size={14} strokeWidth={1.75} className={icon} /> {t('ctx.regenBranch')}
          </DropdownMenuItem>
        )}
        {/* several roles take this question at once: candidates or reviewers */}
        {!isContent && !!node.data.question && (
          <DropdownMenuItem title={ti('fanout.entryTitle')} onClick={() => useUiStore.getState().setFanOutNodeId(nodeId)} data-ctx-fanout>
            <Split size={14} strokeWidth={1.75} className={icon} /> {t('fanout.entry')}
          </DropdownMenuItem>
        )}
        {hasResponse && (
          <DropdownMenuItem onClick={() => { void recapToNote(nodeId); }}>
            <StickyNote size={14} strokeWidth={1.75} className={icon} /> {t('continue.summarize')}
          </DropdownMenuItem>
        )}
        {copyText && (
          <DropdownMenuItem onClick={() => {
            void navigator.clipboard.writeText(copyText).then(() => toast('success', ti('ctx.copied')));
          }}>
            <Copy size={14} strokeWidth={1.75} className={icon} /> {t('ctx.copyContent')}
          </DropdownMenuItem>
        )}
        {!isContent && (
          <DropdownMenuItem
            title={ti('exp.takeTitle')}
            onClick={() => { void import('../lib/experiment-loop').then((m) => m.takeToExperiment(nodeId, 'branch')); }}
            data-take-to-experiment
          >
            <FlaskConical size={14} strokeWidth={1.75} className={icon} /> {t('exp.take')}
          </DropdownMenuItem>
        )}
        {!isContent && (
          <DropdownMenuItem
            title={ti('exp.continueTitle')}
            onClick={() => { void import('../lib/experiment-loop').then((m) => m.takeToExperiment(nodeId, 'continue')); }}
            data-take-to-continue
          >
            <BookOpen size={14} strokeWidth={1.75} className={icon} /> {t('exp.continue')}
          </DropdownMenuItem>
        )}
        {kind === 'frame' && (
          <DropdownMenuItem title={ti('ctx.tidyFrameTitle')} onClick={() => useStore.getState().tidyFrame(nodeId)}>
            <LayoutGrid size={14} strokeWidth={1.75} className={icon} /> {t('ctx.tidyFrame')}
          </DropdownMenuItem>
        )}
        {!isContent && hasFollowers && (
          <DropdownMenuItem title={ti('ctx.tidyChainTitle')} onClick={() => useStore.getState().tidyChain(nodeId)}>
            <LayoutGrid size={14} strokeWidth={1.75} className={icon} /> {t('ctx.tidyChain')}
          </DropdownMenuItem>
        )}
        {!isContent && node.data.layoutPinned && (
          <DropdownMenuItem onClick={() => useStore.getState().releasePin(nodeId)}>
            <PinOff size={14} strokeWidth={1.75} className={icon} /> {t('ctx.releasePin')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => useStore.getState().duplicateNode(nodeId)}>
          <Files size={14} strokeWidth={1.75} className={icon} /> {t('ctx.duplicate')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => useStore.getState().setArchived([nodeId], !node.data.archived)}>
          {node.data.archived
            ? <ArchiveRestore size={14} strokeWidth={1.75} className={icon} />
            : <Archive size={14} strokeWidth={1.75} className={icon} />}
          {node.data.archived ? t('ctx.unarchive') : t('archive.label')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => {
            void confirmDialog({
              title: ti('confirm.deleteNodesTitle'),
              message: fmt(ti('confirm.deleteNodes'), { n: 1 }),
              confirmLabel: ti('common.delete'),
              danger: true,
            }).then((ok) => { if (ok) useStore.getState().deleteNode(nodeId); });
          }}
        >
          <Trash2 size={14} strokeWidth={1.75} className="shrink-0" /> {t('common.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
