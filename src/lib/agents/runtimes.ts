// The agent runtimes as the picker names them: which runtime an id belongs
// to and what each one can do. Pure data, no store: anything that only needs
// to tell an agent entry from a plain model imports this, not agent-runtime.

import type { AgentAccess, AgentRuntime, TurnConfig } from '../../types';

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
  /** which directory a session goes on in: the one it started in (the
      runtime files its sessions by it), or the one its last turn ran in */
  resumeIn: 'origin' | 'last';
}

/** The runtimes the shell can run, keyed by the prefix of their picker ids. */
export const AGENT_RUNTIMES: Record<AgentRuntime, { prefix: string; label: string; rootKey: string; caps: RuntimeCaps }> = {
  pi: { prefix: 'pi/', label: 'Pi', rootKey: 'pi-sessions', caps: { forkAt: true, access: false, workspace: true, resumeIn: 'origin' } },
  codex: { prefix: 'codex/', label: 'Codex', rootKey: 'codex-sessions', caps: { forkAt: false, access: true, workspace: true, resumeIn: 'last' } },
  'claude-code': { prefix: 'claude/', label: 'Claude Code', rootKey: 'claude-projects', caps: { forkAt: false, access: true, workspace: true, resumeIn: 'origin' } },
  // the harness's agent loop, served by the harness itself (nowhere else answers for it)
  dsh: { prefix: 'harness/agent/', label: 'Harness', rootKey: 'dsh-sessions', caps: { forkAt: true, access: false, workspace: false, resumeIn: 'origin' } },
};
/** The provider segment a runtime's picker ids carry when its record names none. */
const OWN_PROVIDER: Partial<Record<AgentRuntime, string>> = { 'claude-code': 'claude-code', codex: 'codex' };
/** Claude Code's model families, as its picker offers them (aliases the CLI resolves). */
const CLAUDE_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
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

/** The agent entries the picker lists, as the model list last handed them
 *  over (lib/use-models). Kept here so the intent rules can read them
 *  without the model list's imports. */
let pickerEntries: string[] = [];
export function setAgentEntries(models: { id: string }[]): void {
  pickerEntries = models.map((m) => m.id).filter((id) => isAgentModel(id));
}

/**
 * The picker entry that runs what a turn's record names, on its runtime: an
 * entry with the very id, else one whose model is the same by its last
 * segment, else (Claude Code) the family alias, else an entry made from the
 * recorded name itself — the CLIs take a full model name as it is. A harness
 * turn goes on with the bare entry, which keeps the session's own model: a
 * model passed on resume would switch the chat's session too.
 */
export function matchEntry(runtime: AgentRuntime, recorded: Pick<TurnConfig, 'model' | 'provider'> | undefined, entries: string[] = pickerEntries): string | undefined {
  const prefix = AGENT_RUNTIMES[runtime].prefix;
  if (runtime === 'dsh') return BARE_HARNESS_AGENT;
  const model = recorded?.model;
  if (!model) return undefined;
  const own = entries.filter((id) => runtimeOf(id) === runtime);
  const provider = recorded?.provider ?? OWN_PROVIDER[runtime];
  const exact = provider ? `${prefix}${provider}/${model}` : undefined;
  if (exact && own.includes(exact)) return exact;
  const last = model.split('/').pop()!;
  const byName = own.find((id) => id.split('/').pop() === last);
  if (byName) return byName;
  if (runtime === 'claude-code') {
    const family = CLAUDE_FAMILIES.find((f) => model.includes(f));
    const alias = family ? own.find((id) => id.split('/').pop() === family) : undefined;
    if (alias) return alias;
  }
  return exact ?? `${prefix}${model}`;
}

/** What a recorded permission amounts to on the canvas's two levels:
 *  write when the turn could change files, read when it could not;
 *  undefined when the record names no mode the canvas can place. */
export function accessOfPermission(permission: string | undefined): AgentAccess | undefined {
  if (!permission) return undefined;
  const p = permission.toLowerCase();
  if (/read-only|readonly|\bplan\b|\bdefault\b|read only/.test(p)) return 'read';
  if (/accept|bypass|auto|write|full-access|full access|danger|yolo/.test(p)) return 'write';
  return undefined;
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
