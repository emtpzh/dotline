import { create } from 'zustand';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import { useStore } from './index';
import { activeAbortControllers, releaseGenerations } from './streaming';
import { flushPendingWrites } from '../lib/persistence';
import { buildRuleOutRuleIn } from '../lib/paradigms/rule-out-rule-in';
import { toast } from '../lib/ui-store';
import { t, fmt } from '../i18n';
import { setLedgerSource } from '../lib/agents/continuity';

// Project layer: each canvas persists under its own IndexedDB key; this
// module owns the metadata list and the switching choreography.
// Metadata writes use bare idbSet — the debounced idbStorage has a single
// pending slot reserved for the main store and must not be shared.

const META_KEY = 'thoughtdag:projects';
const LEGACY_KEY = 'thoughtdag';

export const projectStorageKey = (id: string) => `thoughtdag:project:${id}`;

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 'chat' (default) = conversation canvas; 'paradigm' = orchestration view, no LLM. */
  kind?: 'chat' | 'paradigm';
  /** Provenance: which paradigm this run canvas was instantiated from. */
  instantiatedFrom?: { name: string; at: string };
  /** The sessions this canvas SUBSCRIBES to (store/projects Subscription):
      its main session, later sessions continuing the same line of thought
      (chapters, mounted at the main line's tail) and experiment sessions
      mounted at an anchor node (branches). One canvas = one line of
      thought; sessions are its physical chapters. */
  sessions?: Subscription[];
  /** The ledger from before subscriptions were kept by turn: read once to
      build `sessions` (and written into backups, which older versions
      read); never kept in the metadata after that. */
  sourceSession?: LegacyLedger;
  /** The working directory this canvas hands to agent runtimes, when the
      person chose one; absent = the mirrored project, else the canvas's
      own workspace. */
  agentCwd?: string;
  /** Archived = hidden from the dropdown and Recent work, data untouched.
      Tidying and destroying are different verbs. */
  archived?: boolean;
  /** DERIVED index: which sessions' provenance this canvas holds
      (importSource sessionIds, deduped). Recomputed from the graph on
      every debounced touch — never written by hand, so it cannot drift.
      Lets provenance adoption skip canvases without parsing their
      stored graphs. Absent on legacy metas → slow path fills it in. */
  provenanceSessions?: string[];
}

/** Archive/restore a canvas. Archiving the ACTIVE canvas switches away
 *  first — to the newest unarchived one, or a fresh canvas. */
export async function setProjectArchived(id: string, archived: boolean): Promise<void> {
  const { projects, activeId } = useProjects.getState();
  if (archived && id === activeId) {
    const rest = projects.filter((p) => p.id !== id && !p.archived).sort((a, b) => b.updatedAt - a.updatedAt);
    if (rest.length > 0) await switchProject(rest[0].id);
    else await createProject('My Canvas');
  }
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => (p.id === id ? { ...p, archived } : p)),
  }));
  await saveMeta();
}

/** One session a canvas subscribes to. Which of its turns the canvas has
 *  taken is kept by turn id — mirrored, or removed by hand and not to come
 *  back — so a turn the file adds anywhere (a second client, a fork above
 *  the tail) is new exactly when its id is not here. */
export interface Subscription {
  /** `runner:sessionId` (lib/sessions/read sessionKey) */
  key: string;
  runner: string;
  sessionId: string;
  role: 'main' | 'chapter' | 'branch';
  /** a branch: the node it was mounted at */
  anchorNodeId?: string;
  /** the turns (and the runs and notes they brought) the canvas has taken */
  handled: string[];
  /** a ledger from before ids: how many of the session's nodes it had taken.
   *  The first sync turns it into `handled`; until then it is the count. */
  legacyCount?: number;
  /** the main line's last turn on the canvas (derivable; kept for the continuity rule) */
  tailNodeId?: string;
}

type LegacyEntry = { sessionId: string; runner: string; importedCount: number; tailNodeId: string };
export type LegacyLedger = LegacyEntry & { chapters?: LegacyEntry[]; branches?: (LegacyEntry & { anchorNodeId: string })[] };

const subKey = (runner: string, sessionId: string) => `${runner}:${sessionId}`;

/** A ledger from before ids, as subscriptions that still count. */
export function subscriptionsFromLegacy(ss: LegacyLedger | undefined): Subscription[] {
  if (!ss) return [];
  const one = (e: LegacyEntry, role: Subscription['role'], anchorNodeId?: string): Subscription => ({
    key: subKey(e.runner, e.sessionId), runner: e.runner, sessionId: e.sessionId, role,
    handled: [], legacyCount: e.importedCount, ...(e.tailNodeId ? { tailNodeId: e.tailNodeId } : {}), ...(anchorNodeId ? { anchorNodeId } : {}),
  });
  return [
    ...(ss.sessionId ? [one(ss, 'main')] : []),
    ...(ss.chapters ?? []).filter((c) => c.sessionId).map((c) => one(c, 'chapter')),
    ...(ss.branches ?? []).filter((b) => b.sessionId).map((b) => one(b, 'branch', b.anchorNodeId)),
  ];
}

/** How many of a session's nodes a subscription has taken (the old ledger's count). */
export const takenCount = (sub: Subscription): number => sub.legacyCount ?? sub.handled.length;

/** The old ledger shape, for backups older versions open (and the atlas's counts). */
export function legacyLedgerOf(subs: Subscription[] | undefined): LegacyLedger | undefined {
  if (!subs?.length) return undefined;
  const entry = (s: Subscription): LegacyEntry => ({ sessionId: s.sessionId, runner: s.runner, importedCount: takenCount(s), tailNodeId: s.tailNodeId ?? '' });
  const main = subs.find((s) => s.role === 'main');
  const chapters = subs.filter((s) => s.role === 'chapter').map(entry);
  const branches = subs.filter((s) => s.role === 'branch').map((s) => ({ ...entry(s), anchorNodeId: s.anchorNodeId ?? '' }));
  return {
    ...(main ? entry(main) : { sessionId: '', runner: '', importedCount: 0, tailNodeId: '' }),
    ...(chapters.length ? { chapters } : {}),
    ...(branches.length ? { branches } : {}),
  };
}

/** A canvas's subscriptions (the legacy ledger read through, for a meta not migrated yet). */
export function subscriptionsOf(meta: ProjectMeta | undefined): Subscription[] {
  if (!meta) return [];
  return meta.sessions ?? subscriptionsFromLegacy(meta.sourceSession);
}

/** The session a canvas mirrors first, if it mirrors one. */
export const mainSubscription = (meta: ProjectMeta | undefined): Subscription | undefined =>
  subscriptionsOf(meta).find((s) => s.role === 'main');

/** Which canvas subscribes to a session, and how. One session, one canvas. */
export function findSubscription(sessionId: string | undefined): { project: ProjectMeta; sub: Subscription } | null {
  if (!sessionId) return null;
  for (const p of useProjects.getState().projects) {
    const sub = subscriptionsOf(p).find((s) => s.sessionId === sessionId);
    if (sub) return { project: p, sub };
  }
  return null;
}

function setSubscriptions(projectId: string, fn: (subs: Subscription[]) => Subscription[]): void {
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => {
      if (p.id !== projectId) return p;
      const next = fn(subscriptionsOf(p));
      const out: ProjectMeta = { ...p, sessions: next.length ? next : undefined };
      delete out.sourceSession;
      return out;
    }),
  }));
}

/** Subscribe a canvas to a session (a main session, a chapter, a branch). */
export async function addSubscription(projectId: string, sub: Omit<Subscription, 'key'> & { key?: string }): Promise<void> {
  const full: Subscription = { ...sub, key: sub.key ?? subKey(sub.runner, sub.sessionId) };
  setSubscriptions(projectId, (subs) => {
    const rest = subs.filter((s) => s.sessionId !== full.sessionId);
    // a canvas has one main session: a second one joins as a chapter
    const role = full.role === 'main' && rest.some((s) => s.role === 'main') ? 'chapter' : full.role;
    return [...rest, { ...full, role }];
  });
  await saveMeta();
}

/** Change whichever subscription holds this session. */
export async function patchSubscription(projectId: string, sessionId: string, patch: Partial<Omit<Subscription, 'key' | 'sessionId' | 'runner'>>): Promise<void> {
  setSubscriptions(projectId, (subs) => subs.map((s) => {
    if (s.sessionId !== sessionId) return s;
    const next = { ...s, ...patch };
    if ('legacyCount' in patch && patch.legacyCount === undefined) delete next.legacyCount;
    return next;
  }));
  await saveMeta();
}

/** Mark turns of a subscribed session as taken. */
export async function noteHandled(projectId: string, sessionId: string, ids: string[], tailNodeId?: string): Promise<void> {
  setSubscriptions(projectId, (subs) => subs.map((s) => {
    if (s.sessionId !== sessionId) return s;
    const handled = [...s.handled, ...ids.filter((id) => !s.handled.includes(id))];
    return { ...s, handled, ...(tailNodeId ? { tailNodeId } : {}) };
  }));
  await saveMeta();
}

/** Deletion IS unsubscription: drop this session from the canvas. When the
 *  last one goes the canvas is native again. Reopening the session from the
 *  atlas resubscribes. */
export async function removeSubscription(projectId: string, sessionId: string): Promise<void> {
  setSubscriptions(projectId, (subs) => subs.filter((s) => s.sessionId !== sessionId));
  await saveMeta();
}

/** Every session id a canvas subscribes to. */
export function subscribedSessionIds(meta: ProjectMeta): string[] {
  return subscriptionsOf(meta).map((s) => s.sessionId).filter(Boolean);
}

/** Stamp paradigm provenance on a project (persisted with the meta list). */
export async function markInstantiatedFrom(projectId: string, paradigmName: string): Promise<void> {
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => (p.id === projectId ? { ...p, instantiatedFrom: { name: paradigmName, at: new Date().toISOString() } } : p)),
  }));
  await saveMeta();
}

interface ProjectsState {
  projects: ProjectMeta[];
  activeId: string | null;
  switching: boolean;
}

export const useProjects = create<ProjectsState>(() => ({
  projects: [],
  activeId: null,
  switching: false,
}));

// The sessions the active canvas mirrors, with their tails: what decides
// whether a question continues a session (lib/agents/continuity).
setLedgerSource(() => {
  const { projects, activeId } = useProjects.getState();
  return subscriptionsOf(projects.find((p) => p.id === activeId))
    .filter((s) => s.sessionId && s.tailNodeId)
    .map((s) => ({ runner: s.runner, sessionId: s.sessionId, tailNodeId: s.tailNodeId! }));
});

async function saveMeta(): Promise<void> {
  const { projects, activeId } = useProjects.getState();
  await idbSet(META_KEY, { projects, activeId });
}

// ─── Boot & migration ───────────────────────────────────────────
// Idempotent write order: ① copy graph data → ② write metadata → ③ delete
// legacy key. A crash between steps re-runs the migration harmlessly.
let bootPromise: Promise<void> | null = null;

export function bootProjects(): Promise<void> {
  bootPromise ??= (async () => {
    let meta = await idbGet<{ projects: ProjectMeta[]; activeId: string }>(META_KEY);
    if (!meta || meta.projects.length === 0) {
      const legacy = await idbGet<string>(LEGACY_KEY); // raw persist envelope string
      const id = crypto.randomUUID();
      const now = Date.now();
      if (legacy) await idbSet(projectStorageKey(id), legacy);
      meta = { projects: [{ id, name: 'My Canvas', createdAt: now, updatedAt: now }], activeId: id };
      await idbSet(META_KEY, meta);
      if (legacy) await idbDel(LEGACY_KEY);
    }
    if (!meta.projects.some((p) => p.id === meta!.activeId)) {
      meta.activeId = meta.projects[0].id;
    }
    // the ledger by count becomes subscriptions (still counting until each
    // session's first sync reads which turns the count covered)
    if (meta.projects.some((p) => p.sourceSession && !p.sessions)) {
      meta = { ...meta, projects: meta.projects.map((p) => {
        if (!p.sourceSession || p.sessions) return p;
        const subs = subscriptionsFromLegacy(p.sourceSession);
        const out: ProjectMeta = { ...p, ...(subs.length ? { sessions: subs } : {}) };
        delete out.sourceSession;
        return out;
      }) };
      await idbSet(META_KEY, meta);
    }
    useProjects.setState({ projects: meta.projects, activeId: meta.activeId });
    useStore.persist.setOptions({ name: projectStorageKey(meta.activeId) });
    await useStore.persist.rehydrate(); // fires onFinishHydration → App gate opens
  })().catch(async (e) => {
    console.error('[thoughtdag] project boot failed:', e);
    toast('error', t('toast.projectsLoadFailed'));
    useStore.persist.setOptions({ name: projectStorageKey('recovery') });
    await useStore.persist.rehydrate();
  });
  return bootPromise;
}

// ─── Switching ──────────────────────────────────────────────────
// Danger window: between setOptions and rehydrate completion, any setState
// would write the OLD graph under the NEW key. Defenses: every stream stops
// first (agent runs are the page's and go on: lib/agents/runs), and the
// `switching` flag disables the switcher UI.
let suppressTouch = false;

/** Returns how many agent turns of the canvas left behind run on. */
async function drainGenerations(): Promise<number> {
  const { liveRunsOn } = await import('../lib/agents/runs');
  const kept = liveRunsOn(useProjects.getState().activeId);
  releaseGenerations();
  const deadline = Date.now() + 1000;
  while (activeAbortControllers.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 0)); // let the final abort writes reach the debounce queue
  return kept;
}

export async function switchProject(id: string): Promise<void> {
  const { activeId, switching, projects } = useProjects.getState();
  if (switching || id === activeId || !projects.some((p) => p.id === id)) return;
  useProjects.setState({ switching: true });
  let kept = 0;
  try {
    kept = await drainGenerations();
    await flushPendingWrites();
    suppressTouch = true;
    useStore.persist.setOptions({ name: projectStorageKey(id) });
    await useStore.persist.rehydrate();
    useStore.setState({ selectedNodeId: null, selectedNodeIds: [] });
    // opening IS unarchiving: archived means "hidden from the lists", and
    // a canvas the user just switched to is back in the working set —
    // whatever road led here (atlas card, archived group, canonical open)
    useProjects.setState((s) => ({
      activeId: id,
      projects: s.projects.map((p) => (p.id === id && p.archived ? { ...p, archived: false } : p)),
    }));
    await saveMeta();
  } finally {
    suppressTouch = false;
    useProjects.setState({ switching: false });
  }
  if (kept > 0) toast('info', fmt(t('agent.runsOn'), { n: kept }), 8000);
  // agent turns left running when this canvas was last in view (here, or
  // in a page since closed) are read back from their session files
  void import('../lib/sessions/sync').then((m) => m.syncWaitingRuns()).catch(() => {});
}

// ─── CRUD ───────────────────────────────────────────────────────
export async function createProject(name = 'Untitled', kind: 'chat' | 'paradigm' = 'chat'): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  useProjects.setState((s) => ({
    projects: [...s.projects, { id, name, createdAt: now, updatedAt: now, kind }],
  }));
  await saveMeta();
  await switchProject(id); // empty key rehydrates to an empty canvas
  return id;
}

export async function setProjectAgentCwd(id: string, cwd: string | undefined): Promise<void> {
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => (p.id === id ? { ...p, agentCwd: cwd } : p)),
  }));
  await saveMeta();
}

export async function renameProject(id: string, name: string): Promise<void> {
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
  }));
  await saveMeta();
}

export async function deleteProject(id: string): Promise<void> {
  const { projects, activeId } = useProjects.getState();
  if (id === activeId) {
    const rest = projects.filter((p) => p.id !== id);
    if (rest.length > 0) await switchProject(rest[0].id);
    else await createProject('My Canvas');
  }
  await idbDel(projectStorageKey(id));
  useProjects.setState((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
  await saveMeta();
}

// Register a project entry for graph data already written to its storage key
// (used by JSON import) and switch to it.
export async function adoptImportedProject(
  id: string,
  name: string,
  kind: 'chat' | 'paradigm' = 'chat',
  extras?: Partial<Pick<ProjectMeta, 'instantiatedFrom' | 'sessions' | 'sourceSession'>>,
): Promise<void> {
  const now = Date.now();
  const { sourceSession, sessions, ...rest } = extras ?? {};
  const subs = sessions ?? subscriptionsFromLegacy(sourceSession);
  useProjects.setState((s) => ({
    projects: [...s.projects, { id, name, createdAt: now, updatedAt: now, kind, ...rest, ...(subs.length ? { sessions: subs } : {}) }],
  }));
  await saveMeta();
  await switchProject(id);
}

// Seed a new paradigm project with the built-in rule-out/rule-in score and
// switch to it (shared by the landing page and the project switcher).
export async function createBuiltinParadigm(lang: 'en' | 'zh'): Promise<void> {
  const { name, nodes, edges } = buildRuleOutRuleIn(lang);
  const id = crypto.randomUUID();
  await idbSet(projectStorageKey(id), JSON.stringify({ state: { nodes, edges }, version: 1 }));
  await adoptImportedProject(id, name, 'paradigm');
}

if (import.meta.env.DEV) {
  Object.assign(window, { __projects: useProjects });
}

// ─── updatedAt bookkeeping ──────────────────────────────────────
let touchTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((state, prev) => {
  if (suppressTouch) return;
  if (state.nodes === prev.nodes && state.edges === prev.edges) return;
  if (touchTimer) clearTimeout(touchTimer);
  touchTimer = setTimeout(() => {
    const { activeId } = useProjects.getState();
    if (!activeId) return;
    // the provenance fingerprint rides the same debounce: derived from
    // the live graph each time, so it can never drift from the truth
    const sids = [...new Set(useStore.getState().nodes
      .map((n) => n.data.importSource?.sessionId)
      .filter((x): x is string => !!x))];
    useProjects.setState((s) => ({
      projects: s.projects.map((p) => (p.id === activeId ? { ...p, updatedAt: Date.now(), provenanceSessions: sids } : p)),
    }));
    void saveMeta();
  }, 1000);
});
