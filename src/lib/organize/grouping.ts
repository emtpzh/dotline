import type { Group, Thread } from './threads';

// How the model groups conversations, in two steps that stay cheap however
// many there are. First it settles the groups from a sample of each canvas
// (a prompt of bounded size), anchored on the groups it gave last time.
// Then conversations are put into those fixed groups in small batches that
// run side by side. What a conversation was put in is remembered against
// what the model read of it, so the next open asks only about the new or
// changed ones — and a group that survives keeps its key.
//
// Nothing here talks to a model or to storage: `ask` and the memory are
// handed in (propose.ts wires them), so the whole flow can be tested.

export type ModelDimension = 'topic' | 'goal';
export type Ask = (prompt: string) => Promise<string>;

export interface GroupDef {
  key: string;
  name: string;
  /** shown under the group's name */
  reason: string;
  /** what belongs in it, one sentence: what the batches read */
  covers: string;
}

export interface Memory {
  groups: GroupDef[];
  /** by anchor: the key of the group a conversation was put in ('' = none
   *  fits), and the signature of what the model read of it then */
  assigned: Record<string, { sig: string; key: string }>;
  /** the next group key to mint */
  seq: number;
}

export type Progress = { stage: 'define' } | { stage: 'assign'; done: number; total: number };

/** The model's reply could not be read. propose.ts words it for the user. */
export class BadReply extends Error {}

const NONE = '';
export const BATCH = 40;
export const PARALLEL = 4;
/** how many sample lines the defining prompt carries, all canvases together */
const SAMPLE = 120;

const DIMENSION_PROMPT: Record<ModelDimension, string> = {
  topic: 'by SUBJECT: what the conversations are about. Conversations on the same subject belong together even when they serve different purposes.',
  goal: 'by GOAL: the purpose or project the person was pursuing (building a product, writing a survey, planning a trip, learning a field). Conversations serving the same goal belong together even when their subjects differ.',
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A conversation's identity across canvases: its earliest node, which
 *  travels with it when the organizer moves it. */
export const anchorOf = (th: Thread): string => th.id.slice(th.canvasId.length + 1);

/** What the model reads of a conversation. */
export function describe(th: Thread, later = 4): string {
  const turns = th.turns.slice(1, 1 + later).map((s) => clip(s, 40)).join(' / ');
  return `${clip(th.title, 60)}${turns ? ` — ${turns}` : ''}`;
}

/** FNV-1a over what the model read: a conversation that grows past those
 *  turns keeps its place; one whose opening was renamed is asked again. */
export function sigOf(th: Thread): string {
  let h = 0x811c9dc5;
  const s = describe(th);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** About how many groups to ask for: grows slowly with the conversations. */
export const targetGroups = (n: number) => Math.min(12, Math.max(2, Math.round(Math.sqrt(n) * 0.7)));

/** Evenly spread over each canvas's conversations, newest first, in
 *  proportion to its size — every canvas shows at least two (or all it has). */
export function sample(threads: Thread[], canvases: { id: string }[], budget = SAMPLE): Map<string, Thread[]> {
  const out = new Map<string, Thread[]>();
  for (const c of canvases) {
    const mine = threads.filter((th) => th.canvasId === c.id).sort((a, b) => b.lastAt - a.lastAt);
    if (!mine.length) continue;
    const want = Math.min(mine.length, Math.max(2, Math.round((budget * mine.length) / threads.length)));
    const step = mine.length / want;
    out.set(c.id, Array.from({ length: want }, (_, i) => mine[Math.floor(i * step)]));
  }
  return out;
}

export function definePrompt(dim: ModelDimension, lang: string, threads: Thread[], canvases: { id: string; name: string }[], previous: GroupDef[]): string {
  const picks = sample(threads, canvases);
  const blocks = canvases.filter((c) => picks.has(c.id)).map((c) => {
    const total = threads.filter((th) => th.canvasId === c.id).length;
    return `Canvas 「${c.name}」 (${total} conversations), for example:\n${picks.get(c.id)!.map((th) => `- ${describe(th, 1)}`).join('\n')}`;
  });
  const anchor = previous.length
    ? `\nGroups proposed last time:\n${previous.map((g) => `- ${g.name}: ${g.covers}`).join('\n')}\nKeep a group that still fits, with its name unchanged. Rename, merge, split or drop one only when the conversations call for it.\n`
    : '';
  return `A person keeps their conversations with an AI on several canvases, and the canvases have become mixed. There are ${threads.length} conversations in all; below, each canvas with a sample of them (title — next turn).

${blocks.join('\n\n')}
${anchor}
Propose the groups to regroup ALL ${threads.length} conversations ${DIMENSION_PROMPT[dim]}

Rules:
- Aim for about ${targetGroups(threads.length)} groups. Each must be distinct from the others.
- Name each group in ${lang}, as a short noun phrase (at most 12 characters in Chinese, 28 in English).
- When a group is essentially one existing canvas, reuse that canvas's name exactly.
- "reason": one line in ${lang} saying what ties the group together (at most 30 characters in Chinese, 70 in English).
- "covers": one sentence in ${lang} saying which conversations belong in it, precise enough to sort an unseen conversation.

Output only JSON, nothing else: {"groups":[{"name":"…","reason":"…","covers":"…"}]}`;
}

const jsonIn = (raw: string): unknown => {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new BadReply();
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { throw new BadReply(); }
};

/** The defined groups, keyed: a group named like one from last time keeps
 *  that one's key, so what was put in it stays put. */
export function parseDefine(raw: string, previous: GroupDef[], seq: number): { groups: GroupDef[]; seq: number } {
  const parsed = jsonIn(raw) as { groups?: { name?: unknown; reason?: unknown; covers?: unknown }[] };
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const groups: GroupDef[] = [];
  for (const g of Array.isArray(parsed?.groups) ? parsed.groups : []) {
    const name = str(g?.name);
    if (!name || groups.some((o) => o.name === name)) continue;
    const key = previous.find((p) => p.name === name)?.key ?? `g${seq++}`;
    groups.push({ key, name, reason: str(g.reason), covers: str(g.covers) || str(g.reason) });
  }
  if (!groups.length) throw new BadReply();
  return { groups, seq };
}

export function assignPrompt(dim: ModelDimension, groups: GroupDef[], batch: Thread[], nameOf: Map<string, string>): string {
  return `Sort conversations with an AI into fixed groups, ${DIMENSION_PROMPT[dim]}

Groups:
${groups.map((g, i) => `G${i + 1} ${g.name}: ${g.covers}`).join('\n')}

Conversations (the canvas each is on now, its title and later turns):
${batch.map((th, i) => `[${i + 1}] (canvas: ${nameOf.get(th.canvasId) ?? ''}) ${describe(th)}`).join('\n')}

Put every conversation in the one group it fits best. Answer one line per conversation, its number and its group, like:
1 G2
2 G1
Write "-" instead of a group only when no group fits at all. Output only those lines.`;
}

/** Line number → group index (or null for "-"). Lines that don't read, and
 *  numbers or groups out of range, are left out: those get asked again. */
export function parseAssign(raw: string, size: number, groups: number): Map<number, number | null> {
  const out = new Map<number, number | null>();
  for (const line of raw.split('\n')) {
    const m = /^\s*\[?(\d+)\]?[\s:：.,=>→-]*(?:G\s*(\d+)|(-|none))\s*$/i.exec(line);
    if (!m) continue;
    const i = Number(m[1]);
    if (i < 1 || i > size || out.has(i)) continue;
    if (m[3]) { out.set(i, null); continue; }
    const g = Number(m[2]);
    if (g >= 1 && g <= groups) out.set(i, g - 1);
  }
  return out;
}

const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/** Every conversation's group key ('' = none fits), asked in batches that
 *  run side by side. What a batch missed is asked once more; what still has
 *  no answer is left out (it stays where it is). */
export async function assignAll(ask: Ask, dim: ModelDimension, groups: GroupDef[], threads: Thread[], nameOf: Map<string, string>, onProgress?: (p: Progress) => void): Promise<Map<string, string>> {
  const got = new Map<string, string>();
  let failure: unknown = null;
  const total = threads.length;
  const report = () => onProgress?.({ stage: 'assign', done: got.size, total });
  const round = async (todo: Thread[]) => {
    const queue = chunk(todo, BATCH);
    const worker = async () => {
      for (let batch = queue.shift(); batch; batch = queue.shift()) {
        try {
          const answers = parseAssign(await ask(assignPrompt(dim, groups, batch, nameOf)), batch.length, groups.length);
          for (const [i, g] of answers) got.set(batch[i - 1].id, g === null ? NONE : groups[g].key);
        } catch (e) {
          failure ??= e;
        }
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  };
  report();
  await round(threads);
  const missed = threads.filter((th) => !got.has(th.id));
  if (missed.length) await round(missed);
  if (!got.size && total) throw failure ?? new BadReply();
  return got;
}

/**
 * The model's proposal for `threads` (the movable ones), and what to
 * remember of it. Groups are defined again when asked to (`fresh`), when
 * there are none yet, or when too many conversations are new or changed
 * for the old groups to be trusted; otherwise only those are sorted.
 * A fresh proposal sorts every conversation again.
 */
export async function regroup(opts: {
  ask: Ask;
  dim: ModelDimension;
  lang: string;
  threads: Thread[];
  canvases: { id: string; name: string }[];
  memory: Memory | null;
  fresh?: boolean;
  onProgress?: (p: Progress) => void;
}): Promise<{ groups: Group[]; memory: Memory }> {
  const { ask, dim, lang, threads, canvases, fresh, onProgress } = opts;
  const before = opts.memory ?? { groups: [], assigned: {}, seq: 0 };
  const nameOf = new Map(canvases.map((c) => [c.id, c.name]));

  const cached = (th: Thread, keys: Set<string>) => {
    const m = before.assigned[anchorOf(th)];
    return !!m && m.sig === sigOf(th) && (m.key === NONE || keys.has(m.key));
  };
  const stale = threads.filter((th) => !cached(th, new Set(before.groups.map((g) => g.key)))).length;
  const redefine = fresh || !before.groups.length || stale > Math.max(12, threads.length / 4);

  let defs = before.groups, seq = before.seq;
  if (redefine && threads.length) {
    onProgress?.({ stage: 'define' });
    ({ groups: defs, seq } = parseDefine(await ask(definePrompt(dim, lang, threads, canvases, before.groups)), before.groups, seq));
  }

  const keys = new Set(defs.map((g) => g.key));
  const keyOf = new Map<string, string>();
  const todo: Thread[] = [];
  for (const th of threads) {
    if (!fresh && cached(th, keys)) keyOf.set(th.id, before.assigned[anchorOf(th)].key);
    else todo.push(th);
  }
  if (todo.length) for (const [id, key] of await assignAll(ask, dim, defs, todo, nameOf, onProgress)) keyOf.set(id, key);

  const groups: Group[] = defs
    .map((d) => ({ key: d.key, name: d.name, reason: d.reason, threadIds: threads.filter((th) => keyOf.get(th.id) === d.key).map((th) => th.id) }))
    .filter((g) => g.threadIds.length);
  if (!groups.length) throw new BadReply();

  // remembered: the conversations there are now, each with what it was put in
  const assigned: Memory['assigned'] = {};
  for (const th of threads) {
    const key = keyOf.get(th.id);
    if (key !== undefined) assigned[anchorOf(th)] = { sig: sigOf(th), key };
  }
  return { groups, memory: { groups: defs, assigned, seq } };
}

/**
 * A draft the user rebuilt from teaches the memory: a renamed group keeps
 * its new name, and a conversation dragged to another group is remembered
 * there. The next proposal is anchored on what the user settled.
 */
export function learnDraft(memory: Memory, accepted: Group[], threads: Thread[]): Memory {
  const byId = new Map(threads.map((th) => [th.id, th]));
  const groups = memory.groups.map((d) => {
    const g = accepted.find((a) => a.key === d.key);
    return g && g.name !== d.name ? { ...d, name: g.name } : d;
  });
  const assigned = { ...memory.assigned };
  for (const g of accepted) {
    if (!groups.some((d) => d.key === g.key)) continue;
    for (const id of g.threadIds) {
      const th = byId.get(id);
      if (th) assigned[anchorOf(th)] = { sig: sigOf(th), key: g.key };
    }
  }
  return { ...memory, groups, assigned };
}
