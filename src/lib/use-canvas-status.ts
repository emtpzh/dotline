import { useRuns, type RunOverlay } from './agents/runs';
import { useProjects } from '../store/projects';

/** What a canvas out of view has going on, for its tab and its row in the
 *  library: a question waiting for the person (the most pressing), an agent
 *  turn still running, or something new since it was left — a turn that
 *  finished while away, a session it follows that grew. */
export type CanvasStatus = 'waiting' | 'running' | 'fresh';

function runStatus(runs: Record<string, RunOverlay>, canvasId: string): CanvasStatus | null {
  let out: CanvasStatus | null = null;
  for (const r of Object.values(runs)) {
    if (r.canvasId !== canvasId) continue;
    if (r.approvals.length > 0) return 'waiting';
    if (!r.ended) out = 'running';
    else if (!out) out = 'fresh';
  }
  return out;
}

/** The canvas in view has none: what goes on there is on its cards. */
export function useCanvasStatus(canvasId: string): CanvasStatus | null {
  const run = useRuns((s) => runStatus(s.runs, canvasId));
  const fresh = useProjects((s) => s.fresh.includes(canvasId));
  const inView = useProjects((s) => s.activeId === canvasId);
  if (inView) return null;
  return run ?? (fresh ? 'fresh' : null);
}
