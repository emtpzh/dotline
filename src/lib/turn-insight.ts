import type { ThoughtData } from '../types';
import { countTokens } from '../utils';

// The self-explaining chain: everything here renders information the
// import already carries for free — no LLM calls, no new state. A turn's
// steps become ACTION MARKS (read-code turn? run-experiment
// turn?), and its token split shows what is actually eating the context —
// the pruning compass of the inspection layer.

export type ActionKind = 'edit' | 'read' | 'search' | 'run' | 'web' | 'agent' | 'other';
export interface ActionMark { kind: ActionKind; count: number }

const ACTION_KINDS: [RegExp, ActionKind][] = [
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/i, 'edit'],
  [/^(Read|NotebookRead)$/i, 'read'],
  [/^(Grep|Glob|LS|Search|WebSearch)$/i, 'search'],
  [/^(Bash|BashOutput|Shell)$/i, 'run'],
  [/^(WebFetch|Fetch)$/i, 'web'],
  [/^(Task|Agent)$/i, 'agent'],
];
const ACTION_ORDER: ActionKind[] = ['edit', 'read', 'search', 'run', 'web', 'agent', 'other'];

/** What a turn DID, counted from its tool calls — the objective marks a
 *  card's name row carries at every zoom that still shows text. Edits count
 *  the distinct files changed when the footprint knows them (the number a
 *  reader asks for), the calls otherwise. Empty for hand-made nodes. */
export function actionMarks(data: Pick<ThoughtData, 'steps'>): ActionMark[] {
  const counts = new Map<ActionKind, number>();
  for (const step of data.steps ?? []) {
    const kind = ACTION_KINDS.find(([re]) => re.test(step.tool))?.[1] ?? 'other';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const changed = footprint(data).filter((f) => f.op !== 'read').length;
  if (changed > 0) counts.set('edit', changed);
  return ACTION_ORDER.filter((k) => counts.has(k)).map((kind) => ({ kind, count: counts.get(kind)! }));
}

export interface TurnComposition {
  q: number;
  a: number;
  tool: number;
  total: number;
  /** tool output share of the turn, 0..1 — the pruning signal */
  toolShare: number;
}

/** Token split of one turn — null when it carries no tool output (nothing
 *  to explain: the badge row and bar only appear on imported turns). */
export function turnComposition(data: Pick<ThoughtData, 'question' | 'response' | 'steps'>): TurnComposition | null {
  let tool = 0;
  for (const step of data.steps ?? []) tool += countTokens(step.call) + countTokens(step.result);
  if (tool === 0) return null;
  const q = countTokens(data.question);
  const a = countTokens(data.response);
  const total = q + a + tool;
  return { q, a, tool, total, toolShare: total > 0 ? tool / total : 0 };
}

export interface FootprintEntry { path: string; name: string; op: 'read' | 'write' | 'edit' }

/** The files this turn touched, straight from its steps —
 *  writes and edits first, then reads, each path once. This is what a
 *  reader looking back needs on the card's face; the calls themselves
 *  stay in the drawer. Empty for hand-made nodes. */
export function footprint(data: Pick<ThoughtData, 'steps'>): FootprintEntry[] {
  const seen = new Map<string, FootprintEntry>();
  for (const step of data.steps ?? []) {
    if (!step.paths?.length || (step.op !== 'read' && step.op !== 'write' && step.op !== 'edit')) continue;
    for (const path of step.paths) {
      const prev = seen.get(path);
      if (!prev) seen.set(path, { path, name: path.split('/').filter(Boolean).pop() ?? path, op: step.op });
      else if (prev.op === 'read' && step.op !== 'read') prev.op = step.op;
    }
  }
  return [...seen.values()].sort((a, b) => (a.op === 'read' ? 1 : 0) - (b.op === 'read' ? 1 : 0));
}

/** The closing paragraph of an answer. Agents state their conclusion
 *  LAST — the opening line is usually "let me look at…" — so a collapsed
 *  imported turn shows its end, not its start. */
export function conclusionOf(response: string, max = 140): string {
  const paras = response
    .replace(/```[\s\S]*?```/g, '')
    .split(/\n\s*\n/)
    .map((p) => p
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images → their text
      .replace(/[#*`>|_~]/g, '')
      .replace(/^\s*[-•\d.)]+\s*/gm, '')
      .replace(/\s+/g, ' ')
      .trim())
    // a lead-in to a block ("Now the warnings:"), a sources line, a bare
    // closing offer — none of these is the finding
    .filter((p) => p.length > 12 && !/[:：]$/.test(p) && !/^(sources?|references?|来源|参考)\b/i.test(p));
  const substantive = paras.filter((p) => p.length >= 30);
  const last = substantive[substantive.length - 1] ?? paras[paras.length - 1]
    ?? response.replace(/[#*`>-]/g, '').replace(/\s+/g, ' ').trim();
  return last.length > max ? `${last.slice(0, max)}…` : last;
}
