// What a node runs on next: its own intent, set the moment it is asked and
// changed only on the node itself. The global picker (and its effort) is
// where a ROOT starts; everything else inherits from the line it grows off,
// so nothing already on the canvas changes when the global pick moves on.
//
//   intent  — model / effort / access on the node: what its next run uses
//   record  — generatedBy / generatedEfforts / agentSession, per version:
//             what actually ran (never rewritten)
//
// A node from before intents were written reads its record as its intent:
// a rerun reproduces what it answered with. Pure: no store, no picker state
// — callers pass the defaults in.

import type { ThoughtNode, AgentRuntime, AgentAccess } from '../types';
import { isAgentModel, offersAccess, runtimeOf } from './agents/runtimes';

type Data = ThoughtNode['data'];
type IntentSource = Pick<Data, 'model' | 'effort' | 'access' | 'agentSession' | 'generatedBy' | 'generatedEfforts' | 'responseIndex'>;
type CwdSource = Pick<Data, 'model' | 'cwd' | 'agentSession' | 'importSource' | 'generatedBy' | 'responseIndex'>;

export type RunIntent = { model?: string; effort?: string; access?: AgentAccess };

/** Kinds that never generate: they carry material into a line, not a model. */
const INERT = new Set(['note', 'file', 'link', 'frame', 'human']);

/** The model a node runs on next: its intent, else what its answer ran on. */
export function lineModel(data: IntentSource | undefined): string | undefined {
  if (!data) return undefined;
  return data.model ?? data.agentSession?.model ?? data.generatedBy?.[data.responseIndex] ?? undefined;
}

/** A node's intent, read from its record where it predates intents. Effort
 *  and access belong to agent entries only; '' is the runtime's own default
 *  effort, and a node with no level of its own has none (the default applies). */
export function intentOf(data: IntentSource | undefined): RunIntent {
  const model = lineModel(data);
  if (!data || !model) return {};
  if (!isAgentModel(model)) return { model };
  const effort = data.effort !== undefined ? data.effort : (data.agentSession?.effort ?? data.generatedEfforts?.[data.responseIndex] ?? undefined);
  const access = data.access ?? data.agentSession?.access;
  return { model, ...(effort ? { effort } : {}), ...(access ? { access } : {}) };
}

/** The intent a node asked off these parents starts with: one generating
 *  parent (or several that agree) passes its own on; none, or parents that
 *  disagree, start from the defaults — `mixed` says which of the two. */
export function inheritIntent(parents: (Data | undefined)[], defaults: RunIntent): RunIntent & { mixed?: true } {
  const own = parents
    .filter((p): p is Data => !!p && !INERT.has(p.stepKind ?? ''))
    .map(intentOf)
    .filter((i) => i.model);
  if (own.length === 0) return defaults;
  const [first] = own;
  if (!own.every((i) => i.model === first.model)) return { ...defaults, mixed: true };
  // same model, different levels: the runtime's default rather than a guess;
  // the access level only when every parent agrees, else the default's
  const access = own.every((i) => i.access === first.access) ? first.access ?? defaults.access : defaults.access;
  const effort = own.every((i) => (i.effort ?? '') === (first.effort ?? '')) ? first.effort : undefined;
  return { model: first.model, ...(effort ? { effort } : {}), ...(access && isAgentModel(first.model) ? { access } : {}) };
}

/** What a node will run on when it is asked or rerun: its own intent (or
 *  record), else — a node not asked yet — what its parents hand down. */
export function effectiveIntent(data: Data | undefined, parents: (Data | undefined)[], defaults: RunIntent): RunIntent & { mixed?: true } {
  const own = intentOf(data);
  return own.model ? own : inheritIntent(parents, defaults);
}

/** The directory a node's turn on this runtime runs in: its intent when it
 *  runs on that runtime, else the directory its turn on that runtime ran in
 *  (its own run, or the session it mirrors). Undefined = it has none there. */
export function lineCwd(data: CwdSource | undefined, runtime: AgentRuntime): string | undefined {
  if (!data) return undefined;
  if (data.cwd !== undefined && runtimeOf(lineModel(data)) === runtime) return data.cwd;
  if (data.agentSession?.runtime === runtime) return data.agentSession.cwd;
  if (data.importSource?.runner === runtime) return data.importSource.cwd ?? undefined;
  return undefined;
}

/** The directory a node asked off these parents inherits on this runtime:
 *  its one parent's — the session the line goes on in — when that parent
 *  has one there. Several parents, or none on this runtime: undefined, and
 *  the canvas's default applies. */
export function inheritCwd(parents: (Data | undefined)[], runtime: AgentRuntime): string | undefined {
  const live = parents.filter((p): p is Data => !!p && !INERT.has(p.stepKind ?? ''));
  return live.length === 1 ? lineCwd(live[0], runtime) : undefined;
}

/** The intent fields a node carries, written without undefined keys. */
export function intentFields(i: RunIntent): Pick<Data, 'model' | 'effort' | 'access'> {
  return i.model && isAgentModel(i.model)
    ? { model: i.model, effort: i.effort ?? '', access: offersAccess(i.model) ? i.access ?? 'read' : undefined }
    : { model: i.model, effort: undefined, access: undefined };
}
