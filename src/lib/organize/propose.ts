import { llmCall } from '../api';
import { useI18n, t } from '../../i18n';
import type { Group, Thread } from './threads';

// How the organizer proposes groups. Time needs no model: it is read off the
// threads. Topic and goal ask the side model once per open of the organizer.

export type Dimension = 'topic' | 'goal' | 'time';

const DAY = 86_400_000;

function byTime(threads: Thread[]): Group[] {
  const now = Date.now();
  const bands: [string, string, (age: number) => boolean][] = [
    ['week', t('organizer.timeWeek'), (a) => a <= 7 * DAY],
    ['month', t('organizer.timeMonth'), (a) => a > 7 * DAY && a <= 31 * DAY],
    ['older', t('organizer.timeOlder'), (a) => a > 31 * DAY],
  ];
  return bands
    .map(([key, name, inBand]) => ({ key, name, reason: '', threadIds: threads.filter((th) => inBand(now - th.lastAt)).map((th) => th.id) }))
    .filter((g) => g.threadIds.length);
}

const DIMENSION_PROMPT: Record<Exclude<Dimension, 'time'>, string> = {
  topic: 'by SUBJECT: what the conversations are about. Conversations on the same subject belong together even when they serve different purposes.',
  goal: 'by GOAL: the purpose or project the person was pursuing (building a product, writing a survey, planning a trip, learning a field). Conversations serving the same goal belong together even when their subjects differ.',
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function byModel(dim: Exclude<Dimension, 'time'>, threads: Thread[], canvases: { id: string; name: string }[]): Promise<Group[]> {
  const nameOf = new Map(canvases.map((c) => [c.id, c.name]));
  // the prompt stays bounded however many conversations there are: past a
  // hundred or so, each line carries fewer of its later turns, then none
  const later = threads.length > 300 ? 0 : threads.length > 120 ? 2 : 4;
  const lines = threads.map((th, i) => {
    const turns = th.turns.slice(1, 1 + later).map((s) => clip(s, 40)).join(' / ');
    return `[${i + 1}] (canvas: ${nameOf.get(th.canvasId)}) ${clip(th.title, 60)}${turns ? ` — ${turns}` : ''}`;
  });
  const lang = useI18n.getState().lang === 'zh' ? 'Chinese' : 'English';
  const raw = await llmCall([{
    role: 'user',
    content: `A person keeps their conversations with an AI on several canvases, and the canvases have become mixed. Below are ${threads.length} conversations, each with the canvas it is on now, its title and the names of its later turns.

Existing canvases: ${canvases.map((c) => `「${c.name}」`).join(', ')}

${lines.join('\n')}

Regroup the conversations ${DIMENSION_PROMPT[dim]}

Rules:
- Every conversation goes into exactly one group. Prefer 2 to 8 groups; a group may hold a single conversation.
- Name each group in ${lang}, as a short noun phrase (at most 12 characters in Chinese, 28 in English).
- When a group is essentially one existing canvas, reuse that canvas's name exactly.
- Give each group a one-line reason in ${lang} (at most 30 characters in Chinese, 70 in English) saying what ties it together.

Output only JSON, nothing else: {"groups":[{"name":"…","reason":"…","items":[1,2]}]}`,
  }]);
  return parseGroups(raw, threads);
}

/** The model's grouping, made safe: unknown numbers dropped, a thread claimed
 *  twice kept in its first group, empty groups and duplicate names merged away.
 *  Threads the model left out are simply not proposed — they stay home. */
export function parseGroups(raw: string, threads: Thread[]): Group[] {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(t('organizer.badReply'));
  let parsed: { groups?: { name?: unknown; reason?: unknown; items?: unknown }[] };
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { throw new Error(t('organizer.badReply')); }
  const claimed = new Set<string>();
  const out: Group[] = [];
  for (const g of parsed.groups ?? []) {
    const name = typeof g.name === 'string' ? g.name.trim() : '';
    if (!name || !Array.isArray(g.items)) continue;
    const ids: string[] = [];
    for (const i of g.items) {
      const id = typeof i === 'number' ? threads[i - 1]?.id : undefined;
      if (id && !claimed.has(id)) { claimed.add(id); ids.push(id); }
    }
    if (!ids.length) continue;
    const same = out.find((o) => o.name === name);
    if (same) { same.threadIds.push(...ids); continue; }
    out.push({ key: `g${out.length}`, name, reason: typeof g.reason === 'string' ? g.reason.trim() : '', threadIds: ids });
  }
  if (!out.length) throw new Error(t('organizer.badReply'));
  return out;
}

// A model's grouping is kept for the rest of the app session, keyed by what
// it was asked about: reopening the organizer on unchanged canvases costs no
// second call. "Regroup" asks again on purpose.
const asked = new Map<string, Group[]>();
const askKey = (dim: Dimension, threads: Thread[], canvases: { id: string; name: string }[]) =>
  [dim, useI18n.getState().lang, canvases.map((c) => `${c.id}=${c.name}`).join(','), threads.map((th) => `${th.id}:${th.canvasId}:${th.turns.length}`).join(',')].join('|');

export async function proposeGroups(dim: Dimension, threads: Thread[], canvases: { id: string; name: string }[], opts: { fresh?: boolean } = {}): Promise<Group[]> {
  const movable = threads.filter((th) => !th.fixed);
  if (dim === 'time') return byTime(movable);
  const key = askKey(dim, movable, canvases);
  const kept = !opts.fresh && asked.get(key);
  if (kept) return kept.map((g) => ({ ...g, threadIds: [...g.threadIds] }));
  const groups = await byModel(dim, movable, canvases);
  asked.set(key, groups.map((g) => ({ ...g, threadIds: [...g.threadIds] })));
  return groups;
}
