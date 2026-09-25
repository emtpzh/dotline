import { useStore } from '../store';
import { llmCall } from './api';
import { isViewerMode } from './viewer';
import { nodeConclusion } from './node-face';
import type { ThoughtNode } from '../types';

// Names for the turns that never pass through the per-answer judge
// (generateSummary): imported agent sessions arrive with hundreds of turns
// and no model call at all, and older canvases hold answers from before
// every answer got one. One background call names a batch of turns — the
// far view's only text — so a long session costs a handful of calls, not
// one per turn. Until a name lands, the card shows its question's opening.

const BATCH = 30;
const QUIET_MS = 2000;
const PAUSE_AFTER_ERROR_MS = 5 * 60_000;

// Nodes whose per-answer judge is in flight: that call names them itself.
const naming = new Set<string>();
export function markNaming(nodeId: string): void { naming.add(nodeId); }
export function unmarkNaming(nodeId: string): void { naming.delete(nodeId); }

// `${id}:${version text length}` already sent once this session — a turn
// the model declined to name is not asked again and again.
const attempted = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let pausedUntil = 0;

function versionOf(n: ThoughtNode): string {
  return n.data.responses[n.data.responseIndex] ?? n.data.response;
}

function needsName(n: ThoughtNode): boolean {
  const d = n.data;
  if (d.stepKind && d.stepKind !== 'prompt') return false; // material, frames, human turns
  if (!d.response.trim() || d.isLoading || d.responseIndex < 0) return false;
  if (d.summaryTopics?.[d.responseIndex]) return false;
  if (naming.has(n.id)) return false;
  return !attempted.has(`${n.id}:${versionOf(n).length}`);
}

/** Call whenever the canvas changes; runs once things have been quiet. */
export function scheduleBatchNaming(): void {
  if (isViewerMode) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void run(); }, QUIET_MS);
}

async function run(): Promise<void> {
  if (running || Date.now() < pausedUntil) return;
  running = true;
  try {
    for (;;) {
      const batch = useStore.getState().nodes.filter(needsName).slice(0, BATCH);
      if (batch.length === 0) return;
      for (const n of batch) attempted.add(`${n.id}:${versionOf(n).length}`);
      const sent = batch.map((n) => ({ id: n.id, version: versionOf(n) }));
      const lines = batch.map((n, i) => {
        const q = n.data.question.replace(/\s+/g, ' ').trim().slice(0, 200);
        const a = (nodeConclusion(n.data) ?? '').replace(/\s+/g, ' ').slice(0, 160);
        return `${i + 1}. Q: ${q}\n   A: ${a}`;
      });
      let raw: string;
      try {
        raw = await llmCall([{
          role: 'user',
          content: `Below are ${batch.length} turns from one thinking map (a conversation or an agent session), oldest first.\n\n${lines.join('\n')}\n\nGive each turn a short name: its subject as a bare noun phrase that tells it apart from its neighbours. Hard limit: 6 characters for CJK languages, 14 characters otherwise. Use the same language as the turn's question. Never use dash characters (—, –, -).\n\nOutput exactly ${batch.length} lines, one per turn, in the format: number | name. Output nothing else.`,
        }]);
      } catch {
        // no model configured, offline, or a provider error: these turns
        // are not "attempted" — try the whole batch again later
        for (const n of batch) attempted.delete(`${n.id}:${versionOf(n).length}`);
        pausedUntil = Date.now() + PAUSE_AFTER_ERROR_MS;
        return;
      }
      const entries: { nodeId: string; topic: string; forResponse: string }[] = [];
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*(\d+)\s*[.)]?\s*[|｜:：]\s*(.+?)\s*$/);
        const turn = m ? sent[Number(m[1]) - 1] : undefined;
        const topic = m?.[2].replace(/^["'“”「」]+|["'“”「」]+$/g, '').trim();
        if (turn && topic) entries.push({ nodeId: turn.id, topic, forResponse: turn.version });
      }
      if (entries.length > 0) useStore.getState().setTopics(entries);
    }
  } finally {
    running = false;
  }
}
