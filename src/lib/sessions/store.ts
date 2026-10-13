// The session registry: what the canvas knows of each agent session, keyed
// `runner:sessionId` — where its file is, the directory it started in and
// the one its last turn ran in (and whether that still exists), what its
// last turn ran on, its turns in file order, whether a turn is still open.
// A cache of what the read layer saw: every field can be rebuilt from the
// file, so losing it costs a read, never correctness. Canvases subscribe to
// sessions in their own metadata (store/projects); this is not theirs.

import { get as idbGet, set as idbSet } from 'idb-keyval';
import type { AgentRuntime, TurnConfig } from '../../types';
import { AGENT_RUNTIMES } from '../agents/runtimes';
import { sessionKey, type FileLoc, type SessionSnapshot } from './read';

export interface SessionRecord {
  key: string;
  runner: AgentRuntime;
  sessionId: string;
  title: string;
  file: FileLoc;
  cwd: { origin?: string; last?: string; exists?: boolean; checkedAt?: number };
  lastConfig?: TurnConfig;
  /** the turns the file holds, in file order */
  turnIds: string[];
  /** a turn is still being written */
  live: { open: boolean };
  updatedAt: number;
}

const IDB_KEY = 'thoughtdag:sessions';
let records: Map<string, SessionRecord> | null = null;
let loading: Promise<Map<string, SessionRecord>> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Promise<Map<string, SessionRecord>> {
  if (records) return Promise.resolve(records);
  loading ??= idbGet<Record<string, SessionRecord>>(IDB_KEY)
    .catch(() => undefined)
    .then((stored) => (records = new Map(Object.entries(stored ?? {}))));
  return loading;
}

function save(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (records) void idbSet(IDB_KEY, Object.fromEntries(records)).catch(() => {});
  }, 800);
}

/** What a fresh read of a session's file says. */
export async function noteSnapshot(s: SessionSnapshot): Promise<void> {
  const all = await load();
  const before = all.get(s.key);
  const last = s.turns.at(-1);
  const sameDir = before?.cwd.origin === s.cwd.origin && before?.cwd.last === s.cwd.last;
  all.set(s.key, {
    key: s.key, runner: s.runner, sessionId: s.sessionId, title: s.title, file: s.file,
    cwd: { ...s.cwd, ...(sameDir && before?.cwd.exists !== undefined ? { exists: before.cwd.exists, checkedAt: before.cwd.checkedAt } : {}) },
    ...(last ? { lastConfig: last.config } : {}),
    turnIds: s.turns.map((t) => t.id),
    live: { open: !!last && !last.complete },
    updatedAt: Date.now(),
  });
  save();
}

export async function sessionRecord(runner: string, sessionId: string): Promise<SessionRecord | undefined> {
  return (await load()).get(sessionKey(runner, sessionId));
}

/** The file a session id names, by FILENAME: cc files are `<id>.jsonl`,
 *  codex rollouts embed the id, a subagent file is `agent-<id>.jsonl`. A
 *  path-wide match would hit `<parent-id>/subagents/…` first for any
 *  session that ever spawned an agent; a harness session is a directory
 *  named by its id, holding session.jsonl.zstd. */
export function pickSessionFile<T extends { rel: string }>(files: T[], sid: string): T | undefined {
  return files.find((f) => (f.rel.split('/').pop() ?? f.rel).includes(sid))
    ?? files.find((f) => f.rel.split('/').slice(0, -1).includes(sid));
}

/** Where a session's file is: the registry's word, else its runtime's root
 *  searched by name (and then remembered). */
export async function sessionFile(runtime: AgentRuntime, sessionId: string): Promise<FileLoc | null> {
  const known = await sessionRecord(runtime, sessionId);
  if (known) return known.file;
  const bridge = window.desktopSessions;
  if (!bridge) return null;
  try {
    const rootKey = AGENT_RUNTIMES[runtime].rootKey;
    const hit = pickSessionFile(await bridge.list(rootKey), sessionId);
    return hit ? { rootKey, rel: hit.rel } : null;
  } catch { return null; }
}

/** A file's absolute path, as the runtimes take it. */
export async function absolutePath(loc: FileLoc): Promise<string | null> {
  const root = (await window.desktopSessions?.roots().catch(() => []))?.find((r) => r.key === loc.rootKey);
  return root ? `${root.path.replace(/\/$/, '')}/${loc.rel}` : null;
}

const dirChecks = new Map<string, { exists: boolean; at: number }>();
const DIR_TTL_MS = 30_000;

/** Whether a directory is still there, as the host sees it; undefined when
 *  the host cannot say (an older one, or no host). Asked at most twice a minute per path. */
export async function dirExists(path: string): Promise<boolean | undefined> {
  if (!path || !window.desktopAgents?.stat) return undefined;
  const seen = dirChecks.get(path);
  if (seen && Date.now() - seen.at < DIR_TTL_MS) return seen.exists;
  try {
    const r = await window.desktopAgents.stat(path);
    const exists = !!r.exists && r.dir !== false;
    dirChecks.set(path, { exists, at: Date.now() });
    return exists;
  } catch { return undefined; }
}
