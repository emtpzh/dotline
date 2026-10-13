// The read layer: one road from a session file to what the canvas knows of
// it. A file becomes a SessionSnapshot — the session's identity, its
// directories, and every turn with its id, its parent turn, whether it is
// over and what it ran on — through the four collectors the importers use,
// read incrementally: each file keeps its collectors and the offset they
// reached, so a growing file is read from where the last read stopped. A
// file that shrank or whose head changed is read again from the start.
//
// Everything that turns a file into a session goes through here: the live
// mirror, opening a session from the atlas, the session sync, the canvas's
// own agent runs. The identity rule a file head answers to lives here too.

import type { AgentRuntime, TurnConfig } from '../../types';
import type { ImportableConversation } from '../import-chat';
import type { RunnerTurn } from '../adapters/shared';
import type { SessionCard } from '../atlas/discover';

export interface FileLoc { rootKey: string; rel: string }

export interface SessionTurn extends RunnerTurn {
  /** the turn's first item: stable across reads */
  id: string;
  /** the turn its question answered: the tree's (Claude Code, Pi), else the one before */
  parentTurnId?: string;
  complete: boolean;
  config: TurnConfig;
}

export interface SessionSnapshot {
  runner: AgentRuntime;
  sessionId: string;
  key: string;
  title: string;
  file: FileLoc;
  /** the directory the session started in, and the one its last turn ran in */
  cwd: { origin?: string; last?: string };
  subagent?: boolean;
  turns: SessionTurn[];
}

export const sessionKey = (runner: string, sessionId: string): string => `${runner}:${sessionId}`;

/** The identity a session file answers to. One rule for every reader
 *  (cards, the live watcher, deep links): a codex rollout is its
 *  session_meta id; a claude-code file is its sessionId — EXCEPT a
 *  subagent's own file, whose sessionId names the PARENT and whose real
 *  name is the agentId. Reading the parent's id there would hang the
 *  parent's badges on the child and let the parent's canvas adopt it. */
export function identityFromHead(head: string): string | null {
  for (const raw of head.split('\n')) {
    let l: { type?: string; payload?: { id?: string }; sessionId?: string; isSidechain?: boolean; agentId?: string; id?: string };
    try { l = JSON.parse(raw) as typeof l; } catch { continue; }
    // dsh: the session-open event names the file at the TOP level
    if (l.type === 'session' && typeof l.id === 'string') return l.id;
    if (l.type === 'session_meta' && l.payload?.id) return l.payload.id;
    if ((l.type === 'user' || l.type === 'assistant') && typeof l.sessionId === 'string') {
      return l.isSidechain && typeof l.agentId === 'string' ? l.agentId : l.sessionId;
    }
  }
  return null;
}

interface Collector { feedLine(raw: string): void; toConversation(): ImportableConversation | null }

interface FileState {
  /** the collectors in the importers' precedence: the first that recognizes the session wins */
  collectors: Collector[];
  /** where the next read starts, in the bridge's own offsets */
  offset: number;
  /** a line not yet ended when the last read stopped */
  carry: string;
  /** the file's opening bytes when reading began: another head is another file */
  head: string;
}

const HEAD_BYTES = 4096;
const CHUNK = 8 * 1024 * 1024;
const KEEP_FILES = 48;
const files = new Map<string, FileState>();
const queues = new Map<string, Promise<unknown>>();

async function freshCollectors(): Promise<Collector[]> {
  const [{ ClaudeSessionCollector }, { CodexSessionCollector }, { DshSessionCollector }, { PiSessionCollector }] = await Promise.all([
    import('../adapters/claude-code-session'), import('../adapters/codex-session'),
    import('../adapters/dsh-session'), import('../adapters/pi-session'),
  ]);
  return [new ClaudeSessionCollector(), new CodexSessionCollector(), new DshSessionCollector(), new PiSessionCollector()];
}

/** Feed what the file gained since the last read. A file read through a
 *  host can fail halfway: the state then starts over next time. */
async function catchUp(loc: FileLoc): Promise<FileState> {
  const bridge = window.desktopSessions!;
  const key = `${loc.rootKey}|${loc.rel}`;
  const head = await bridge.head(loc.rootKey, loc.rel, HEAD_BYTES).catch(() => '');
  let state = files.get(key);
  // the same file grown, or another one under the name (rewritten, shrunk)
  if (!state || !head.startsWith(state.head)) {
    state = { collectors: await freshCollectors(), offset: 0, carry: '', head };
  }
  files.delete(key);
  files.set(key, state);
  if (files.size > KEEP_FILES) files.delete(files.keys().next().value!);
  state.head = head;
  try {
    for (;;) {
      const r = await bridge.readRange(loc.rootKey, loc.rel, state.offset, CHUNK);
      const lines = (state.carry + r.text).split('\n');
      state.carry = lines.pop() ?? '';
      for (const ln of lines) for (const c of state.collectors) c.feedLine(ln);
      const moved = r.nextStart !== state.offset;
      state.offset = r.nextStart;
      if (r.eof || !moved) break;
    }
  } catch (e) {
    files.delete(key);
    throw e;
  }
  // a last line written without its newline is whole once it parses
  if (state.carry.trim()) {
    try {
      JSON.parse(state.carry);
      for (const c of state.collectors) c.feedLine(state.carry);
      state.carry = '';
    } catch { /* still being written */ }
  }
  return state;
}

/** Reads of one file wait for each other: collectors are fed in order. */
function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

/** The turns as a snapshot names them: ids, parent turns, completion. */
function snapshotTurns(turns: RunnerTurn[], cwd: string | undefined): SessionTurn[] {
  const byItem = new Map<string, string>();
  const out: SessionTurn[] = [];
  let prev: string | undefined;
  turns.forEach((t, i) => {
    const id = t.itemIds[0] ?? `turn-${i}`;
    for (const item of t.itemIds) byItem.set(item, id);
    const parentTurnId = t.parentItemId ? byItem.get(t.parentItemId) ?? prev : prev;
    const config: TurnConfig = t.config ?? { ...(cwd ? { cwd } : {}), basis: 'inferred' };
    out.push({ ...t, id, ...(parentTurnId && parentTurnId !== id ? { parentTurnId } : {}), complete: !!t.complete || i < turns.length - 1, config });
    prev = id;
  });
  return out;
}

/**
 * A session file as the canvas knows it: the conversation the importers
 * build from (with the subagents it spawned adopted), and its snapshot.
 * null when no bridge, no session format, or nothing read yet.
 */
export async function readSession(loc: FileLoc, opts: { cards?: SessionCard[] | null } = {}): Promise<{ snapshot: SessionSnapshot; conv: ImportableConversation } | null> {
  if (!window.desktopSessions) return null;
  const key = `${loc.rootKey}|${loc.rel}`;
  const state = await serial(key, () => catchUp(loc)).catch(() => null);
  if (!state) return null;
  let conv: ImportableConversation | null = null;
  for (const c of state.collectors) { conv = c.toConversation(); if (conv) break; }
  if (!conv?.sessionId || !conv.session) return null;
  const { withSubagents } = await import('../atlas/subagents');
  conv = (await withSubagents(conv, loc.rootKey, loc.rel, opts.cards)) ?? conv;
  const runner = conv.source as AgentRuntime;
  const turns = snapshotTurns(conv.session!.turns, conv.session!.cwd);
  const origin = conv.session!.cwd ?? turns[0]?.config.cwd;
  const last = turns.at(-1)?.config.cwd ?? origin;
  const snapshot: SessionSnapshot = {
    runner, sessionId: conv.sessionId!, key: sessionKey(runner, conv.sessionId!), title: conv.title, file: loc,
    cwd: { ...(origin ? { origin } : {}), ...(last ? { last } : {}) },
    ...(conv.session!.subagent ? { subagent: true } : {}),
    turns,
  };
  void import('./store').then((m) => m.noteSnapshot(snapshot)).catch(() => {});
  return { snapshot, conv };
}

/** Chunked reader over the bridge's readRange — the road for any size. */
export function shellSessionReader(rootKey: string, rel: string): () => Promise<string | null> {
  let start = 0;
  let done = false;
  return async () => {
    if (done) return null;
    const r = await window.desktopSessions!.readRange(rootKey, rel, start, CHUNK);
    start = r.nextStart;
    if (r.eof) done = true;
    return r.text;
  };
}
