import { Dna, FolderOpen, Loader2, SquareTerminal } from 'lucide-react';
import { mainSubscription, useProjects, type ProjectMeta } from '../store/projects';
import { useCanvasStatus } from '../lib/use-canvas-status';
import { knownSessionIds } from '../lib/atlas/discover';
import { useT } from '../i18n';

/**
 * A canvas's mark, on its tab and its row in the library: what kind of
 * canvas it is — a paradigm, a session's mirror (faded when the session is
 * not on this machine: it listens again once the source shows up), a canvas
 * of its own — and what goes on there while it is out of view. A run going
 * there spins in the mark's place; a question waiting, or something new
 * since the canvas was left, is a dot on its corner.
 */
export default function CanvasIcon({ canvas }: { canvas: ProjectMeta }) {
  const t = useT();
  const status = useCanvasStatus(canvas.id);
  const arriving = useProjects((s) => s.switchingTo === canvas.id);
  if (arriving) return <Loader2 strokeWidth={1.75} className="animate-spin text-primary" />;
  if (status === 'running') return <Loader2 strokeWidth={1.75} className="animate-spin text-muted-foreground" aria-label={t('tabs.running')} data-canvas-status="running" />;
  const main = mainSubscription(canvas);
  const Kind = canvas.kind === 'paradigm' ? Dna : main ? SquareTerminal : FolderOpen;
  const tone = canvas.kind === 'paradigm'
    ? 'text-primary'
    : main && knownSessionIds.size > 0 && !knownSessionIds.has(main.sessionId) ? 'text-muted-foreground/40' : 'text-muted-foreground';
  return (
    <span className="relative inline-flex shrink-0">
      <Kind strokeWidth={1.75} className={tone} />
      {status && (
        <span
          className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-2 ring-card ${status === 'waiting' ? 'bg-warning' : 'bg-primary'}`}
          aria-label={t(status === 'waiting' ? 'tabs.waiting' : 'tabs.fresh')}
          data-canvas-status={status}
        />
      )}
    </span>
  );
}
