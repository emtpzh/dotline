import { create } from 'zustand';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import { useStore } from './index';
import { activeAbortControllers, releaseGenerations } from './streaming';
import { flushPendingWrites } from '../lib/persistence';
import { buildRuleOutRuleIn } from '../lib/paradigms/rule-out-rule-in';
import { toast, useUiStore } from '../lib/ui-store';
import { t, fmt } from '../i18n';
import { setLedgerSource } from '../lib/agents/continuity';
import { normDir } from '../lib/local-path';
import { cameraNow } from '../lib/layout-motion';
import { neighbourOf, reconcileOpen, withClosed, withMoved, withOpened } from '../lib/workspace';

// Project layer: each canvas persists under its own IndexedDB key; this
// module owns the metadata list and the switching choreography.
// Metadata writes use bare idbSet — the debounced idbStorage has a single
// pending slot reserved for the main store and must not be shared.
//
// Canvases work like desktops (lib/workspace): the open ones are tabs, a
// stashed one is out of the tabs but kept as it was left, and every canvas
// remembers where the person was on it — switching back lands there.

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
  /** Where the person was when they last left this canvas (or closed the
      app on it): coming back puts the camera, the selection and the
      details panel back. Absent = never left yet, so arrival fits. */
  view?: CanvasView;
}

/** Where the person is on a canvas. */
export interface CanvasView {
  x: number;
  y: number;
  zoom: number;
  selectedNodeId?: string;
  /** the details panel was open on the selected card */
  panel?: boolean;
}

const byRecent = (a: ProjectMeta, b: ProjectMeta) => b.updatedAt - a.updatedAt;

/** Where the canvas in view goes when it has to give way: the tab beside
 *  it, else the most recent canvas in the lists, else any other one. */
function successorOf(id: string): string | null {
  const { projects, openIds } = useProjects.getState();
  return neighbourOf(openIds.filter((x) => x === id || projects.some((p) => p.id === x)), id)
    ?? projects.filter((p) => p.id !== id && !p.archived).sort(byRecent)[0]?.id
    ?? projects.find((p) => p.id !== id)?.id
    ?? null;
}

/** Archive/restore a canvas. Archiving the ACTIVE canvas switches away
 *  first — to the tab beside it, or the newest unarchived canvas, or a
 *  fresh one. An archived canvas leaves the tabs. */
export async function setProjectArchived(id: string, archived: boolean): Promise<void> {
  const { activeId } = useProjects.getState();
  if (archived && id === activeId) {
    const next = successorOf(id);
    if (next) await switchProject(next);
    else await createProject('My Canvas');
  }
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => (p.id === id ? { ...p, archived } : p)),
    openIds: archived ? withClosed(s.openIds, id) : s.openIds,
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
  /** The open canvases — the top bar's tabs — in the order the person
      keeps them. The canvas in view is always among them. */
  openIds: string[];
  /** Canvases out of view that something happened on since they were
      left (a session they follow grew): their tabs say so until opened.
      This page's knowledge only, never stored. */
  fresh: string[];
  switching: boolean;
  /** the canvas a switch in progress is bringing into view */
  switchingTo: string | null;
}

export const useProjects = create<ProjectsState>(() => ({
  projects: [],
  activeId: null,
  openIds: [],
  fresh: [],
  switching: false,
  switchingTo: null,
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
  const { projects, activeId, openIds } = useProjects.getState();
  await idbSet(META_KEY, { projects, activeId, openIds });
}

// ─── Where the person is on a canvas ────────────────────────────

/** The canvas in view as the person sees it now; undefined before the
 *  canvas has a camera (booting, the viewer). */
function viewNow(): CanvasView | undefined {
  const cam = cameraNow();
  if (!cam) return undefined;
  const { selectedNodeId } = useStore.getState();
  return {
    x: Math.round(cam.x),
    y: Math.round(cam.y),
    zoom: Math.round(cam.zoom * 1000) / 1000,
    ...(selectedNodeId ? { selectedNodeId } : {}),
    ...(selectedNodeId && useUiStore.getState().panelOpen ? { panel: true } : {}),
  };
}

const sameView = (a: CanvasView | undefined, b: CanvasView): boolean =>
  !!a && a.x === b.x && a.y === b.y && a.zoom === b.zoom && a.selectedNodeId === b.selectedNodeId && !!a.panel === !!b.panel;

function keepView(id: string, view: CanvasView | undefined): boolean {
  if (!view || sameView(useProjects.getState().projects.find((p) => p.id === id)?.view, view)) return false;
  useProjects.setState((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, view } : p)) }));
  return true;
}

/** The selection and the details panel as the canvas was left (a card
 *  gone since is simply not selected). */
function restoreSelection(view: CanvasView | undefined): void {
  const id = view?.selectedNodeId;
  const sel = id && useStore.getState().nodes.some((n) => n.id === id) ? id : null;
  useStore.setState({ selectedNodeId: sel, selectedNodeIds: sel ? [sel] : [] });
  useUiStore.getState().setPanelOpen(!!sel && !!view?.panel);
}

let viewTimer: ReturnType<typeof setTimeout> | null = null;

/** The canvas in view moved, or what is selected on it changed: keep it,
 *  so a reload or a return lands where the person was. */
export function noteView(): void {
  if (viewTimer) clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    viewTimer = null;
    const { activeId, switching } = useProjects.getState();
    if (!activeId || switching) return;
    if (keepView(activeId, viewNow())) void saveMeta();
  }, 800);
}

/** How the canvas puts its camera back when a canvas comes into view: on
 *  the view it was left with, or framing it whole the first time. The
 *  canvas registers it once it has a camera. */
type FrameArrival = (view: CanvasView | undefined) => void;
let frameArrival: FrameArrival | null = null;
export function onCanvasArrival(fn: FrameArrival | null): void { frameArrival = fn; }

// Every arrival frames the camera itself. Whoever brought the canvas there
// claims the arrival afterwards, so it does not frame it a second time; an
// action that changed the canvas in view without switching (the organizer
// rearranging it) finds nothing to claim and frames what it did. Counted,
// not timed: a large canvas can take seconds to arrive.
let arrivals = 0;
let claimed = 0;
/** True once per arrival not yet claimed: a canvas came into view since. */
export function claimArrival(): boolean {
  if (claimed === arrivals) return false;
  claimed = arrivals;
  return true;
}

/** Something happened on a canvas out of view: its tab says so until it is opened. */
export function markCanvasFresh(id: string): void {
  const { activeId, fresh, projects } = useProjects.getState();
  if (id === activeId || fresh.includes(id) || !projects.some((p) => p.id === id)) return;
  useProjects.setState({ fresh: [...fresh, id] });
}

// ─── Boot & migration ───────────────────────────────────────────
// Idempotent write order: ① copy graph data → ② write metadata → ③ delete
// legacy key. A crash between steps re-runs the migration harmlessly.
let bootPromise: Promise<void> | null = null;

export function bootProjects(): Promise<void> {
  bootPromise ??= (async () => {
    let meta = await idbGet<{ projects: ProjectMeta[]; activeId: string; openIds?: string[] }>(META_KEY);
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
    // the tabs as they were left; a list from before tabs opens the canvas in view
    const openIds = reconcileOpen(meta.openIds, meta.projects, meta.activeId);
    useProjects.setState({ projects: meta.projects, activeId: meta.activeId, openIds });
    useStore.persist.setOptions({ name: projectStorageKey(meta.activeId) });
    await useStore.persist.rehydrate(); // fires onFinishHydration → App gate opens
    // the canvas reopens as it was left (its camera: the canvas's first view)
    restoreSelection(meta.projects.find((p) => p.id === meta!.activeId)?.view);
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
  useProjects.setState({ switching: true, switchingTo: id });
  let kept = 0;
  try {
    // where the person was on the canvas being left: coming back lands there
    if (activeId) keepView(activeId, viewNow());
    kept = await drainGenerations();
    await flushPendingWrites();
    suppressTouch = true;
    useStore.persist.setOptions({ name: projectStorageKey(id) });
    await useStore.persist.rehydrate();
    const view = useProjects.getState().projects.find((p) => p.id === id)?.view;
    restoreSelection(view);
    // opening IS unarchiving: archived means "hidden from the lists", and
    // a canvas the user just switched to is back in the working set —
    // whatever road led here (atlas card, archived group, canonical open).
    // It is a tab now, beside the one it was opened from.
    useProjects.setState((s) => ({
      activeId: id,
      openIds: withOpened(s.openIds, id, activeId),
      fresh: s.fresh.filter((x) => x !== id),
      projects: s.projects.map((p) => (p.id === id && p.archived ? { ...p, archived: false } : p)),
    }));
    arrivals += 1;
    frameArrival?.(view);
    await saveMeta();
  } finally {
    suppressTouch = false;
    useProjects.setState({ switching: false, switchingTo: null });
  }
  if (kept > 0) toast('info', fmt(t('agent.runsOn'), { n: kept }), 8000);
  // agent turns left running when this canvas was last in view (here, or
  // in a page since closed) are read back from their session files
  void import('../lib/sessions/sync').then((m) => m.syncWaitingRuns()).catch(() => {});
}

// ─── Tabs ───────────────────────────────────────────────────────

/** Stash a canvas: it leaves the tabs and waits in the library as it was
 *  left. The canvas in view gives way to the tab beside it; the last tab
 *  stays (there is always a canvas in view). */
export async function stashProject(id: string): Promise<void> {
  const { openIds, activeId, switching } = useProjects.getState();
  if (switching || !openIds.includes(id) || openIds.length < 2) return;
  if (id === activeId) {
    const next = neighbourOf(openIds, id);
    if (!next) return;
    await switchProject(next);
    if (useProjects.getState().activeId === id) return; // the switch did not happen
  }
  useProjects.setState((s) => ({ openIds: withClosed(s.openIds, id) }));
  await saveMeta();
}

/** Keep one tab, stash the rest. */
export async function stashOthers(id: string): Promise<void> {
  if (useProjects.getState().activeId !== id) await switchProject(id);
  if (useProjects.getState().activeId !== id) return;
  useProjects.setState({ openIds: [id] });
  await saveMeta();
}

/** Drag a tab to another place among the tabs. */
export async function moveTab(id: string, to: number): Promise<void> {
  useProjects.setState((s) => ({ openIds: withMoved(s.openIds, id, to) }));
  await saveMeta();
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
    projects: s.projects.map((p) => (p.id === id ? { ...p, agentCwd: cwd && normDir(cwd) } : p)),
  }));
  await saveMeta();
}

export async function renameProject(id: string, name: string): Promise<void> {
  useProjects.setState((s) => ({
    projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
  }));
  await saveMeta();
}

/** Replace the canvas list wholesale: the organizer's rebuild and its undo
 *  (store/organize), which write the graphs themselves. A canvas that is
 *  gone leaves the tabs. */
export async function replaceProjects(projects: ProjectMeta[]): Promise<void> {
  useProjects.setState((s) => ({ projects, openIds: reconcileOpen(s.openIds, projects, s.activeId) }));
  await saveMeta();
}

export async function deleteProject(id: string): Promise<void> {
  const { activeId } = useProjects.getState();
  if (id === activeId) {
    const next = successorOf(id);
    if (next) await switchProject(next);
    else await createProject('My Canvas');
  }
  await idbDel(projectStorageKey(id));
  useProjects.setState((s) => ({
    projects: s.projects.filter((p) => p.id !== id),
    openIds: withClosed(s.openIds, id),
    fresh: s.fresh.filter((x) => x !== id),
  }));
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
