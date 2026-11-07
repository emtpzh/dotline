import { get as idbGet, set as idbSet } from 'idb-keyval';
import { llmCall } from '../api';
import { useI18n, t } from '../../i18n';
import type { Group, Thread } from './threads';
import { BadReply, learnDraft, regroup, type Memory, type ModelDimension, type Progress } from './grouping';

// How the organizer proposes groups. Time needs no model: it is read off the
// threads. Topic and goal ask the side model in two steps (grouping.ts),
// and what it said is remembered per grouping and language across app
// sessions, so reopening the organizer asks only about what changed.

export type Dimension = ModelDimension | 'time';
export type { Progress };

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

const memoryKey = (dim: ModelDimension) => `thoughtdag.organizer.${dim}.${useI18n.getState().lang}`;

async function recall(dim: ModelDimension): Promise<Memory | null> {
  try { return (await idbGet<Memory>(memoryKey(dim))) ?? null; } catch { return null; }
}

async function keep(dim: ModelDimension, memory: Memory): Promise<void> {
  try { await idbSet(memoryKey(dim), memory); } catch { /* remembered only for speed: losing it costs a call */ }
}

export async function proposeGroups(dim: Dimension, threads: Thread[], canvases: { id: string; name: string }[], opts: { fresh?: boolean; onProgress?: (p: Progress) => void } = {}): Promise<Group[]> {
  const movable = threads.filter((th) => !th.fixed);
  if (dim === 'time') return byTime(movable);
  try {
    const { groups, memory } = await regroup({
      ask: (content) => llmCall([{ role: 'user', content }]),
      dim,
      lang: useI18n.getState().lang === 'zh' ? 'Chinese' : 'English',
      threads: movable,
      canvases,
      memory: await recall(dim),
      fresh: opts.fresh,
      onProgress: opts.onProgress,
    });
    await keep(dim, memory);
    return groups;
  } catch (e) {
    throw e instanceof BadReply ? new Error(t('organizer.badReply')) : e;
  }
}

/** The groups a rebuild went ahead with, as the user left them: the next
 *  proposal starts from their names and from where they put things. */
export async function rememberRebuild(dim: Dimension, accepted: Group[], threads: Thread[]): Promise<void> {
  if (dim === 'time') return;
  const memory = await recall(dim);
  if (memory) await keep(dim, learnDraft(memory, accepted, threads));
}
