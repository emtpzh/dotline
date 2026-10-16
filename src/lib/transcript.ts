import type { AgentStep, ToolOp } from '../types';
import { toolOpOf } from './agents/tool-ops';
import { commandOf } from './agents/steps';

// An agent turn read the way it happened: the answer's text, cut where the
// tool calls came back (a step's textAt), each run of calls between two
// passages one foldable line. A turn whose calls never recorded where they
// sat (canvases from before, a hand-edited answer) reads as one line of all
// its calls ahead of the whole answer.

export type TranscriptPart<S> = { kind: 'text'; text: string } | { kind: 'steps'; steps: S[] };

/** Cut `response` at its calls' offsets. `placed` says the offsets still
 *  describe this text (it is the one they were recorded against). */
export function interleave<S extends { textAt?: number }>(response: string, steps: S[], placed: boolean): TranscriptPart<S>[] {
  const parts: TranscriptPart<S>[] = [];
  const pushText = (text: string) => { if (text.trim()) parts.push({ kind: 'text', text: text.trim() }); };
  if (!placed || !steps.some((s) => s.textAt !== undefined)) {
    if (steps.length) parts.push({ kind: 'steps', steps });
    pushText(response);
    return parts;
  }
  const at = (s: S) => Math.min(response.length, Math.max(0, s.textAt ?? response.length));
  // stable: calls at the same offset keep their order
  const sorted = steps.map((s, i) => ({ s, i })).sort((a, b) => at(a.s) - at(b.s) || a.i - b.i).map((x) => x.s);
  let from = 0;
  for (const s of sorted) {
    const cut = at(s);
    if (cut > from) { pushText(response.slice(from, cut)); from = cut; }
    const last = parts[parts.length - 1];
    if (last?.kind === 'steps') last.steps.push(s);
    else parts.push({ kind: 'steps', steps: [s] });
  }
  pushText(response.slice(from));
  return parts;
}

/** What a call did: its recorded op, or one read off its name. */
export const opOf = (s: { op?: ToolOp; tool?: string; name?: string }): ToolOp => s.op ?? toolOpOf(s.tool ?? s.name ?? '');

export type StepCount = { op: 'read' | 'edit' | 'run' | 'search' | 'fetch' | 'agent' | 'other'; n: number };
const COUNT_ORDER: StepCount['op'][] = ['read', 'search', 'edit', 'run', 'fetch', 'agent', 'other'];

/** A run of calls counted by what they did — files by distinct path where
 *  the calls name theirs, calls otherwise. */
export function countSteps(steps: { op?: ToolOp; tool?: string; name?: string; paths?: string[] }[]): StepCount[] {
  const calls = new Map<StepCount['op'], number>();
  const files = new Map<StepCount['op'], Set<string>>();
  for (const s of steps) {
    const raw = opOf(s);
    const op: StepCount['op'] = raw === 'write' ? 'edit' : raw;
    if ((op === 'read' || op === 'edit') && s.paths?.length) {
      const set = files.get(op) ?? new Set<string>();
      s.paths.forEach((p) => set.add(p));
      files.set(op, set);
    } else {
      calls.set(op, (calls.get(op) ?? 0) + 1);
    }
  }
  return COUNT_ORDER
    .map((op) => ({ op, n: (calls.get(op) ?? 0) + (files.get(op)?.size ?? 0) }))
    .filter((c) => c.n > 0);
}

/** The one line a step shows folded: the command it ran, the files it
 *  touched, the page it fetched, or the head of its call. */
export function stepHeadline(s: AgentStep): string {
  if (opOf(s) === 'run') return commandOf(s, 120);
  if (s.paths?.length) return s.paths.map((p) => p.split('/').filter(Boolean).pop() ?? p).join(', ');
  if (s.url) return s.url;
  const line = s.call.trim().split('\n')[0]?.trim() ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/** Steps the transcript shows: the file-system footprint a canvas run
 *  records beside the turn repeats its edits, so it stays in the files row. */
export const transcriptSteps = (steps: AgentStep[] | undefined): AgentStep[] =>
  (steps ?? []).filter((s) => s.tool !== 'fs-changes');
