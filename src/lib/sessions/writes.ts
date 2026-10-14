// What a session turn does to its node, decided without touching the canvas:
// the rules every writer of a canvas run's turn answers to — the session sync
// writing the file's turn, the run writing its own account when the file has
// none. Pure, so they hold the same wherever they are applied and can be
// tested on their own.
//
// The guarantees:
//   - a binding is one run's: a write on behalf of a run lands only while
//     the node still carries THAT run's binding (sameRun), so a late signal
//     of a run already settled, or of a run a newer one replaced, is dropped;
//   - a turn is one version: the run's own stand-in account (a stopped or
//     failed run whose binding stays) is replaced by the file's turn, never
//     kept beside it;
//   - the file saying a taken turn differently changes the version that turn
//     wrote and nothing else: the node's other versions, and what each
//     version records, stay as they are;
//   - what a binding knows of its run only grows: the host's record adds
//     the turn and the end it missed, and a run the host's boot does not
//     know is over.

import type { AgentRunBinding, AgentStep, ThoughtData } from '../../types';

/** Two bindings are the same run. */
export function sameRun(a: AgentRunBinding | undefined, b: AgentRunBinding | undefined): boolean {
  return !!a && !!b && a.runtime === b.runtime && a.startedAt === b.startedAt;
}

type VersionData = Pick<ThoughtData,
  'question' | 'responses' | 'questions' | 'generatedBy' | 'generatedEfforts' | 'generatedAts'
  | 'editedAts' | 'gatewaySearches' | 'reasonings'>;

export interface TurnVersion {
  response: string;
  /** the picker entry it ran on */
  by?: string;
  effort?: string;
  at: string;
  reasoning?: string;
}

/** The node's versions with the turn's: in place of the earlier ones, or
 *  beside them for a run that appends — in place of the run's stand-in. */
export function withTurnVersion(
  d: VersionData,
  v: TurnVersion,
  run: Pick<AgentRunBinding, 'append' | 'standIn'>,
  failText: ReadonlySet<string>,
): Pick<ThoughtData, 'response' | 'responses' | 'questions' | 'generatedBy' | 'generatedEfforts' | 'generatedAts' | 'editedAts' | 'gatewaySearches' | 'reasonings' | 'responseIndex'> {
  let rows = run.append
    ? d.responses.map((r, i) => ({ r, q: d.questions?.[i], by: d.generatedBy?.[i], rs: d.reasonings?.[i], at: d.generatedAts?.[i], ed: d.editedAts?.[i], gw: d.gatewaySearches?.[i], ef: d.generatedEfforts?.[i] }))
    : [];
  // the run's own account stood in for this turn: the turn takes its place
  if (run.standIn) rows = rows.slice(0, -1);
  const kept = rows.filter(({ r }) => r && !failText.has(r));
  const responses = [...kept.map((k) => k.r), v.response];
  return {
    response: v.response,
    responses,
    questions: [...kept.map((k) => k.q ?? d.question), d.question],
    generatedBy: [...kept.map((k) => k.by), v.by],
    generatedEfforts: [...kept.map((k) => k.ef), v.effort],
    generatedAts: [...kept.map((k) => k.at), v.at],
    editedAts: [...kept.map((k) => k.ed), undefined],
    gatewaySearches: [...kept.map((k) => k.gw), undefined],
    reasonings: [...kept.map((k) => k.rs), v.reasoning],
    responseIndex: responses.length - 1,
  };
}

/** A taken turn the file now says differently, written into the version in
 *  view — the turn's own: the caller refreshes only a node still reading as
 *  the file last said — and nowhere else. */
export function refreshedTurn(
  d: Pick<ThoughtData, 'responses' | 'questions' | 'responseIndex'>,
  fresh: Pick<ThoughtData, 'question' | 'response' | 'tokenCount'>,
): Pick<ThoughtData, 'question' | 'response' | 'responses' | 'responseIndex' | 'tokenCount'> & Partial<Pick<ThoughtData, 'questions'>> {
  const i = d.responses.length ? Math.min(Math.max(d.responseIndex, 0), d.responses.length - 1) : 0;
  const responses = d.responses.length ? d.responses.map((r, k) => (k === i ? fresh.response : r)) : [fresh.response];
  return {
    question: fresh.question,
    response: fresh.response,
    responses,
    ...(d.questions ? { questions: d.questions.map((q, k) => (k === i ? fresh.question : q)) } : {}),
    responseIndex: i,
    tokenCount: fresh.tokenCount,
  };
}

/** One step naming the files the file system saw change during the turn
 *  that the tools did not already declare — absolute paths, op "write",
 *  like any footprint. */
export function fsFootprint(
  cwd: string,
  changes: AgentRunBinding['changes'],
  steps: AgentStep[],
): AgentStep | null {
  const ch = changes;
  if (!ch) return null;
  const declared = new Set<string>();
  for (const a of steps) for (const p of a.paths ?? []) declared.add(p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p}`);
  const changed = [...ch.changed, ...ch.added].filter((p) => !declared.has(p));
  const removed = ch.removed.filter((p) => !declared.has(p));
  if (changed.length === 0 && removed.length === 0 && !ch.truncated) return null;
  const rel = (p: string) => (p.startsWith(cwd) ? p.slice(cwd.length).replace(/^\//, '') : p);
  const lines: string[] = [];
  if (changed.length) lines.push('Changed on disk during this turn (seen by the file system, not declared by a tool):', ...changed.map((p) => '- ' + rel(p)));
  if (removed.length) lines.push('Removed:', ...removed.map((p) => '- ' + rel(p)));
  if (ch.truncated) lines.push('(the directory was too large to scan completely)');
  return { id: `fs-${Date.now().toString(36)}`, tool: 'fs-changes', op: 'write', call: '', result: lines.join('\n'), paths: [...changed, ...removed] };
}

/** What changed on disk, arriving after the turn was written: its footprint
 *  joins the turn's steps, once. */
export function lateFootprint(
  d: Pick<ThoughtData, 'steps' | 'importSource'>,
  changes: NonNullable<AgentRunBinding['changes']>,
): Pick<ThoughtData, 'steps'> | null {
  const steps = d.steps ?? [];
  if (!d.importSource?.sessionId || steps.some((s) => s.tool === 'fs-changes')) return null;
  const cwd = d.importSource.config?.cwd ?? d.importSource.cwd ?? '';
  const step = fsFootprint(cwd, changes, steps);
  return step ? { steps: [...steps, step] } : null;
}

/** The runs a host records (runtime/agents/registry.cjs). */
export type HostRuns = { bootId: string; runs: DesktopHostRun[] };

/** The binding as the host's record of its run has it; the same object when nothing changed. */
export function reconciled(run: AgentRunBinding, host: HostRuns, now: string): AgentRunBinding {
  if (!run.runId || (run.endedAt && run.held !== undefined && run.turnId)) return run;
  const r = host.runs.find((x) => x.runId === run.runId);
  if (!r) {
    // not on the record of the host's boot: the run is over, whatever it last said
    return run.endedAt && run.held !== undefined ? run : { ...run, endedAt: run.endedAt ?? now, held: run.held ?? false };
  }
  const turnId = run.turnId ?? r.turnId;
  const ended = r.status === 'ended';
  const next: AgentRunBinding = {
    ...run,
    ...(turnId ? { turnId } : {}),
    ...(ended ? { endedAt: run.endedAt ?? r.endedAt ?? now, held: r.held === true } : {}),
  };
  return next.turnId === run.turnId && next.endedAt === run.endedAt && next.held === run.held ? run : next;
}
