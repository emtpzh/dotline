// What a node runs on next: its own intent, set the moment it is asked and
// changed only on the node itself. The global picker (and its effort) is
// where a ROOT starts; everything else inherits from the line it grows off,
// so nothing already on the canvas changes when the global pick moves on.
//
//   intent  — model / effort / access on the node: what its next run uses
//   record  — generatedBy / generatedEfforts, per version: what actually
//             ran (never rewritten); for a session turn the canvas did not
//             run, its session file's record (importSource.config)
//
// A node from before intents were written reads its record as its intent:
// a rerun reproduces what it answered with. Pure: no store, no picker state
// — callers pass the defaults in.

import type { ThoughtNode, AgentRuntime, AgentAccess } from '../types';
import { AGENT_RUNTIMES, isAgentModel, matchEntry, offersAccess, runtimeOf } from './agents/runtimes';
import { turnOf } from './sessions/turn';

type Data = ThoughtNode['data'];
type IntentSource = Pick<Data, 'model' | 'effort' | 'access' | 'generatedBy' | 'generatedEfforts' | 'responseIndex'> & Partial<Pick<Data, 'importSource'>>;
type CwdSource = Pick<Data, 'model' | 'cwd' | 'importSource' | 'generatedBy' | 'responseIndex'> & Partial<Pick<Data, 'run'>>;

/** The runtime and record of the session turn a node mirrors, when it
 *  mirrors one of an agent runtime's (a delegated child's run excepted). */
function recordedTurn(data: IntentSource): { runtime: AgentRuntime; config: NonNullable<NonNullable<Data['importSource']>['config']> | undefined } | null {
  const src = data.importSource;
  if (!src || src.subagent || !(src.runner in AGENT_RUNTIMES)) return null;
  return { runtime: src.runner as AgentRuntime, config: src.config };
}

export type RunIntent = { model?: string; effort?: string; access?: AgentAccess };

/** Kinds that never generate: they carry material into a line, not a model. */
const INERT = new Set(['note', 'file', 'link', 'frame', 'human']);

/** The model a node runs on next: its intent, else what its answer ran on. */
/** The model a node's own intent or the canvas's own record names. */
const lineModelOwn = (data: IntentSource): string | undefined =>
  data.model ?? data.generatedBy?.[data.responseIndex] ?? undefined;

export function lineModel(data: IntentSource | undefined): string | undefined {
  if (!data) return undefined;
  const own = lineModelOwn(data);
  if (own) return own;
  // a session turn the canvas did not run: what its session file says ran it
  const turn = recordedTurn(data);
  return turn ? matchEntry(turn.runtime, turn.config) : undefined;
}

/** A node's intent, read from its record where it predates intents. Effort
 *  and access belong to agent entries only; '' is the runtime's own default
 *  effort, and a node with no level of its own has none (the default applies). */
export function intentOf(data: IntentSource | undefined): RunIntent {
  const model = lineModel(data);
  if (!data || !model) return {};
  if (!isAgentModel(model)) return { model };
  const effort = data.effort !== undefined ? data.effort
    : (data.generatedEfforts?.[data.responseIndex] ?? recordedTurn(data)?.config?.effort ?? undefined);
  // the level is the canvas's to give: a recorded mode never widens it (the ask box offers the raise)
  const access = data.access;
  return { model, ...(effort ? { effort } : {}), ...(access ? { access } : {}) };
}

/** The intent a node asked off these parents starts with: one generating
 *  parent (or several that agree) passes its own on; none, or parents that
 *  disagree, start from the defaults — `mixed` says which of the two. */
export function inheritIntent(parents: (Data | undefined)[], defaults: RunIntent): RunIntent & { mixed?: true } {
  const live = parents.filter((p): p is Data => !!p && !INERT.has(p.stepKind ?? ''));
  const own = live.map(intentOf).filter((i) => i.model);
  if (own.length === 0) return defaults;
  const [first] = own;
  if (!own.every((i) => i.model === first.model)) return { ...defaults, mixed: true };
  // a session turn nothing on the canvas ran: the canvas gave it no level,
  // and the one it goes on at is the canvas's starting one (read), not the
  // default a new line would take
  const recorded = live.some((p) => !lineModelOwn(p) && recordedTurn(p));
  // same model, different levels: the runtime's default rather than a guess;
  // the access level only when every parent agrees, else the default's
  const access = own.every((i) => i.access === first.access) ? first.access ?? (recorded ? undefined : defaults.access) : defaults.access;
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
  // where its session goes on: the turn's directory, or (Codex) its last one
  const turn = turnOf(data);
  return (turn?.runtime === runtime ? turn.resumeCwd : null) ?? undefined;
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
