// The canvas's runs as the host that runs them records them
// (runtime/agents/registry.cjs). A run outlives the page that started it,
// so what a page missed — a run's turn, its end, whether its session file
// held all of it — it asks the host, never infers from how long a file has
// been quiet: when the canvas comes into view (and the page opens), and
// when the host's event feed comes back after a drop. A run's last words
// that reach the page with no stream to take them (another page's run, one
// started before a reload, the end that follows a run's error) land on its
// binding as they come.
//
// A binding's run unknown to the host's current boot is over: the process
// that ran it is gone, or forgot it long ago.

import { useStore } from '../../store';
import { reconciled, type HostRuns } from './writes';
import type { AgentRunBinding } from '../../types';

async function hostRuns(): Promise<HostRuns | null> {
  const bridge = window.desktopAgents;
  if (!bridge?.runs) return null;
  try { return await bridge.runs(); } catch { return null; }
}

let boot: Promise<string | null> | null = null;
/** The host process's boot id (null on a host that keeps no record of runs). */
export function hostBootId(): Promise<string | null> {
  boot ??= hostRuns().then((h) => h?.bootId ?? null);
  return boot;
}

/** Bring the bindings on the canvas in view up to date with the host's record. */
export async function reconcileHostRuns(): Promise<void> {
  const host = await hostRuns();
  if (!host) return;
  boot = Promise.resolve(host.bootId);
  const now = new Date().toISOString();
  useStore.setState((st) => {
    let changed = false;
    const nodes = st.nodes.map((n) => {
      const run = n.data.run;
      if (!run) return n;
      const next = reconciled(run, host, now);
      if (next === run) return n;
      changed = true;
      return { ...n, data: { ...n.data, run: next } };
    });
    return changed ? { nodes } : st;
  });
}

let watching = false;
/** Take runs' last words that no stream on this page takes, and catch up
 *  when the host's feed comes back. Once per page. */
export function watchHostRuns(): void {
  if (watching || !window.desktopAgents) return;
  watching = true;
  void import('../agents/agent-runtime').then(({ onStrayRunEvent }) => onStrayRunEvent((runId, event) => {
    if (event.type !== 'turn' && event.type !== 'run_end') return;
    // a run of another canvas: its binding catches up when that canvas is in view
    const node = useStore.getState().nodes.find((n) => n.data.run?.runId === runId);
    const run = node?.data.run;
    if (!node || !run) return;
    const turnId = typeof event.turnId === 'string' && event.turnId ? event.turnId : undefined;
    const next: AgentRunBinding = event.type === 'turn'
      ? { ...run, ...(turnId ? { turnId } : {}) }
      : { ...run, endedAt: run.endedAt ?? new Date().toISOString(), ...(turnId ? { turnId } : {}), held: event.held === true };
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === node.id && n.data.run?.runId === runId ? { ...n, data: { ...n.data, run: next } } : n)) }));
    if (event.type === 'run_end' && next.sessionId) void import('./sync').then((m) => m.syncSession(next.runtime, next.sessionId!)).catch(() => null);
  }));
  window.desktopAgents.onFeedReopen?.(() => { void import('./sync').then((m) => m.syncWaitingRuns()).catch(() => {}); });
}
