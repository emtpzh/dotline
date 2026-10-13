// A session a canvas run opened is the canvas's from its first event on:
// the run names the session, the canvas subscribes to it right then — its
// main session when it has none, else a chapter — so the turn the run writes
// lands on its node (by the run's binding) and turns added to the session
// later, from a terminal or a chat, grow on the same canvas. Explicit, not a
// side effect of reading the turn back.

import type { AgentRuntime } from '../../types';
import { addSubscription, findSubscription, subscriptionsOf, useProjects } from '../../store/projects';

export async function followRunSession(runtime: AgentRuntime, sessionId: string, canvasId: string): Promise<void> {
  if (findSubscription(sessionId)) return;
  const meta = useProjects.getState().projects.find((p) => p.id === canvasId);
  if (!meta) return;
  const role = subscriptionsOf(meta).some((s) => s.role === 'main') ? 'chapter' : 'main';
  await addSubscription(canvasId, { runner: runtime, sessionId, role, handled: [] });
}
