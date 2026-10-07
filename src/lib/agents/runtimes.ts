// The agent runtimes as the picker names them: which runtime an id belongs
// to and what each one can do. Pure data, no store: anything that only needs
// to tell an agent entry from a plain model imports this, not agent-runtime.

import type { AgentRuntime } from '../../types';

/** What a runtime does beyond the contract's minimum. */
export interface RuntimeCaps {
  /** opens a new session holding a conversation up to one of its earlier turns */
  forkAt: boolean;
  /** runs at the canvas's access levels (read / write) because the runtime
      itself has a read-only mode to map them onto; one without runs as it
      would in the terminal, and the ask box offers no level */
  access: boolean;
  /** runs in the canvas's own workspace when nothing else is chosen; without
      one the runtime's own default applies, and a directory binds a turn
      only when the person chose it */
  workspace: boolean;
}

/** The runtimes the shell can run, keyed by the prefix of their picker ids. */
export const AGENT_RUNTIMES: Record<AgentRuntime, { prefix: string; label: string; rootKey: string; caps: RuntimeCaps }> = {
  pi: { prefix: 'pi/', label: 'Pi', rootKey: 'pi-sessions', caps: { forkAt: true, access: false, workspace: true } },
  codex: { prefix: 'codex/', label: 'Codex', rootKey: 'codex-sessions', caps: { forkAt: false, access: true, workspace: true } },
  'claude-code': { prefix: 'claude/', label: 'Claude Code', rootKey: 'claude-projects', caps: { forkAt: false, access: true, workspace: true } },
  // the harness's agent loop, served by the harness itself (nowhere else answers for it)
  dsh: { prefix: 'harness/agent/', label: 'Harness', rootKey: 'dsh-sessions', caps: { forkAt: true, access: false, workspace: false } },
};
/** The runtimes the shell implements today. */
export const LIVE_RUNTIMES: AgentRuntime[] = ['pi', 'codex', 'claude-code', 'dsh'];
/** The harness's agent entry from before it listed one per model: the session's current model. */
const BARE_HARNESS_AGENT = 'harness/agent';


/** The provider key the picker groups every agent-run model under. */
export const AGENT_PROVIDER = '__agent__';

export const runtimeOf = (id: string | undefined | null): AgentRuntime | null => {
  if (!id) return null;
  if (id === BARE_HARNESS_AGENT) return 'dsh';
  for (const [rt, def] of Object.entries(AGENT_RUNTIMES)) if (id.startsWith(def.prefix)) return rt as AgentRuntime;
  return null;
};
export const isAgentModel = (id: string | undefined | null): boolean => runtimeOf(id) !== null;
/** Whether a model runs at an access level the ask box offers. */
export const offersAccess = (id: string | undefined | null): boolean => {
  const rt = runtimeOf(id);
  return !!rt && AGENT_RUNTIMES[rt].caps.access;
};

/** `<runtime prefix><provider>/<model>` → the runtime and its own coordinates, or null. */
export function agentTarget(id: string): { runtime: AgentRuntime; provider: string; id: string } | null {
  const runtime = runtimeOf(id);
  if (!runtime) return null;
  if (id === BARE_HARNESS_AGENT) return { runtime, provider: 'dsh', id: '' };
  const rest = id.slice(AGENT_RUNTIMES[runtime].prefix.length);
  if (!rest) return null;
  const i = rest.indexOf('/');
  // a runtime with one provider (Codex) names models without a provider segment
  if (i <= 0 || i === rest.length - 1) return { runtime, provider: runtime, id: rest };
  return { runtime, provider: rest.slice(0, i), id: rest.slice(i + 1) };
}
