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

/** A harness agent entry's own provider/model, which the harness also
    serves as a plain call; every other id is returned as is. */
export function plainModelOf(id: string | undefined): string | undefined {
  const target = id ? agentTarget(id) : null;
  return target?.runtime === 'dsh' && target.id ? `${target.provider}/${target.id}` : id;
}

/** The plain model the canvas's side calls prefer when an agent entry is
    chosen: a fast, cheap one, matched by name since each host names it its
    own way (`deepseek-official/deepseek-flash`, `deepseek-v4-flash`). */
const SIDE_MODEL = /deepseek.*flash/i;

/** The model a side call (plaque, title, condense…) runs on when `id` is the
    chosen model. A plain model keeps it; an agent entry never opens an agent
    session for one: the side model when this host lists it, else the
    entry's own bare model (a harness entry), else the host's default. */
export function sideModelOf(id: string | undefined, models: { id: string }[], hostDefault: string | null | undefined): string | undefined {
  if (!id || !isAgentModel(id)) return id;
  const side = models.find((m) => !isAgentModel(m.id) && SIDE_MODEL.test(m.id.split('/').pop() ?? ''));
  if (side) return side.id;
  const own = plainModelOf(id);
  if (own && !isAgentModel(own)) return own;
  return hostDefault && !isAgentModel(hostDefault) ? hostDefault : id;
}
