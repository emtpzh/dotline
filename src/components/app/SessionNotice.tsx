import { useStore } from '../../store';
import { useT, fmt } from '../../i18n';
import { shortName } from '../../lib/node-face';
import { sessionWhy } from '../../lib/session-why';
import type { Continuity } from '../../lib/agents/continuity';
import { Button } from '../ui/button';

/**
 * Said BEFORE the send, where the question is written: this question cannot
 * go on in the agent session above, why, and what that costs — with the way
 * back when the reason is one the person just added. A fork from an earlier
 * turn keeps the session's record and only gets a quiet line. Nothing shows
 * for a question that continues, or on a line with no agent session.
 */
export default function SessionNotice({ c, onLocate, onDropRole }: {
  c: Continuity | null;
  /** show the node a reason points at (a material, a reference, an edit) */
  onLocate?: (nodeId: string) => void;
  /** the role was set in this ask box: send without it and go on */
  onDropRole?: () => void;
}) {
  const t = useT();
  const nodes = useStore((s) => s.nodes);
  if (!c || c.kind === 'continue') return null;
  if (c.kind === 'fork') {
    return <p className="mb-1.5 px-1 text-2xs text-muted-foreground" data-session-notice="fork">{fmt(t('session.forkLine'), { n: c.turn })}</p>;
  }
  const about = c.about ? nodes.find((n) => n.id === c.about) : undefined;
  const locatable = !!about && !!onLocate && (c.reason === 'material' || c.reason === 'reference' || c.reason === 'edited');
  const droppable = c.reason === 'role' && !!onDropRole;
  return (
    <div className="mb-1.5 flex items-start gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs" role="status" data-session-notice="new">
      <span className="mt-1 size-2 shrink-0 rounded-full bg-warning" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-warning">{fmt(t('session.newTitle'), { why: sessionWhy(c, nodes, t) })}</p>
        <p className="mt-0.5 leading-snug text-muted-foreground">{t('session.newBody')}</p>
        {(locatable || droppable) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {locatable && (
              <Button variant="link" size="xs" className="h-auto px-0" onClick={(e) => { e.stopPropagation(); onLocate!(about!.id); }}>
                {fmt(t('session.locate'), { x: shortName(about!.data) })}
              </Button>
            )}
            {droppable && (
              <Button variant="outline" size="xs" onClick={(e) => { e.stopPropagation(); onDropRole!(); }}>
                {t('session.keepRole')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
