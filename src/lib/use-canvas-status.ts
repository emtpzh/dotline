import { useRuns, type RunOverlay } from './agents/runs';
import { useProjects } from '../store/projects';
import { useBackground } from '../store/background';

/** What a canvas out of view has going on, for its tab and its row in the
 *  library: a question waiting for the person (the most pressing), an
 *  answer still being written (an agent turn, or a direct answer streaming
 *  on out of view), or something new since it was left — an answer that
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
  const streaming = useBackground((s) => Object.values(s.streams).includes(canvasId));
  const fresh = useProjects((s) => s.fresh.includes(canvasId));
  const inView = useProjects((s) => s.activeId === canvasId);
  if (inView) return null;
  if (run === 'waiting') return 'waiting';
  if (run === 'running' || streaming) return 'running';
  return run ?? (fresh ? 'fresh' : null);
}
