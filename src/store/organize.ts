import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import { useStore, stripTransient } from './index';
import { useProjects, projectStorageKey, replaceProjects, switchProject, subscriptionsOf, type ProjectMeta, type Subscription } from './projects';
import { activeAbortControllers } from './streaming';
import { liftCanvas } from './lift';
import { flushPendingWrites } from '../lib/persistence';
import { composeGraph, splitThreads, type Outcome, type StoredGraph, type Thread } from '../lib/organize/threads';
import { t } from '../i18n';

// The organizer's commit: canvases rebuilt as the preview showed, in one go,
// with a way back. Every canvas but the one in view is rewritten in storage;
// the one in view is rewritten through the store (its undo stack starts over,
// so a Cmd+Z cannot bring back nodes that now live elsewhere). Its
// subscriptions follow the session nodes they mirror.

/** Conversation canvases in the lists: what the organizer works on. */
export const organizable = (p: ProjectMeta): boolean => p.kind !== 'paradigm' && !p.archived;

const stored = (g: StoredGraph) => ({ state: { nodes: stripTransient(g.nodes), edges: g.edges, events: g.events }, version: 1 });

function liveGraph(): StoredGraph {
  const s = useStore.getState();
  return { nodes: s.nodes, edges: s.edges, events: s.events };
}

async function readGraph(id: string): Promise<StoredGraph> {
  if (id === useProjects.getState().activeId) return liveGraph();
  const raw = await idbGet(projectStorageKey(id));
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const st = parsed?.state ?? {};
  return { nodes: st.nodes ?? [], edges: st.edges ?? [], events: st.events ?? [] };
}

/** Every organizable canvas's conversations, read now. Canvases with none are left out. */
export async function loadThreads(): Promise<{ canvases: ProjectMeta[]; threads: Thread[] }> {
  await flushPendingWrites();
  const metas = useProjects.getState().projects.filter(organizable);
  // every canvas is read at once; each one is split as soon as it arrives
  const per = await Promise.all(metas.map(async (p) => {
    try { return splitThreads(p.id, await readGraph(p.id), p.updatedAt); } catch { return []; /* unreadable: left out */ }
  }));
  const threads = per.flat();
  return { canvases: metas.filter((p) => threads.some((th) => th.canvasId === p.id)), threads };
}

function showGraph(g: StoredGraph): void {
  const nodes = liftCanvas(stripTransient(g.nodes), g.edges);
  useStore.setState({
    nodes, edges: g.edges, events: g.events,
    history: [{ nodes, edges: g.edges }], historyIndex: 0,
    selectedNodeId: null, selectedNodeIds: [],
  });
}

const sessionsOf = (g: StoredGraph) => [...new Set(g.nodes.map((n) => n.data.importSource?.sessionId).filter((x): x is string => !!x))];

/** Where a subscription goes: with its tail if the tail moved, else with most of its nodes. */
function homeOfSubscription(sub: Subscription, written: Map<string, StoredGraph>): string | null {
  let best: string | null = null, most = 0;
  for (const [id, g] of written) {
    if (sub.tailNodeId && g.nodes.some((n) => n.id === sub.tailNodeId)) return id;
    const n = g.nodes.filter((x) => x.data.importSource?.sessionId === sub.sessionId).length;
    if (n > most) { best = id; most = n; }
  }
  return best;
}

export type Undo = () => Promise<void>;

export async function rebuildCanvases(outcome: Outcome, shown: Thread[]): Promise<Undo> {
  const { projects, activeId, switching } = useProjects.getState();
  if (switching || activeAbortControllers.size > 0) throw new Error(t('organizer.busy'));
  await flushPendingWrites();

  // read again: the threads the preview showed may have grown since
  const sourceOf = new Map(shown.map((th) => [th.id, th.canvasId]));
  const touched = new Set<string>(outcome.removed);
  for (const c of outcome.canvases) {
    if (c.id) touched.add(c.id);
    for (const tid of c.threadIds) { const src = sourceOf.get(tid); if (src) touched.add(src); }
  }
  const graphs = new Map<string, StoredGraph>();
  const fresh = new Map<string, Thread>();
  for (const id of touched) {
    const meta = projects.find((p) => p.id === id);
    if (!meta) continue;
    const g = await readGraph(id);
    graphs.set(id, g);
    for (const th of splitThreads(id, g, meta.updatedAt)) fresh.set(th.id, th);
  }
  const before = new Map([...graphs].map(([id, g]) => [id, id === activeId ? g : stored(g)]));
  const metaBefore = projects;

  // every thread's canvas after the rebuild; threads nobody placed (new since
  // the preview, or a run started on them) stay where they are
  const ids = outcome.canvases.map((c) => c.id ?? crypto.randomUUID());
  const homeOf = new Map<string, string>();
  outcome.canvases.forEach((c, i) => c.threadIds.forEach((tid) => { const th = fresh.get(tid); if (th && !th.fixed) homeOf.set(tid, ids[i]); }));
  for (const th of fresh.values()) if (!homeOf.has(th.id)) homeOf.set(th.id, th.canvasId);

  const finals = new Set([...homeOf.values()]);
  const written = new Map<string, StoredGraph>();
  for (const id of new Set([...touched, ...ids])) {
    if (!finals.has(id)) continue;
    const mine = [...fresh.values()].filter((th) => homeOf.get(th.id) === id);
    written.set(id, composeGraph(
      graphs.get(id) ?? null,
      mine.filter((th) => th.canvasId === id),
      mine.filter((th) => th.canvasId !== id).map((th) => ({ thread: th, graph: graphs.get(th.canvasId)! })),
    ));
  }
  const removed = [...touched].filter((id) => !finals.has(id));
  const lastAt = (id: string) => Math.max(0, ...[...fresh.values()].filter((th) => homeOf.get(th.id) === id).map((th) => th.lastAt));

  const now = Date.now();
  let next: ProjectMeta[] = projects
    .filter((p) => !removed.includes(p.id))
    .map((p) => (written.has(p.id) ? { ...p, updatedAt: Math.max(p.updatedAt, lastAt(p.id)), provenanceSessions: sessionsOf(written.get(p.id)!) } : p));
  outcome.canvases.forEach((c, i) => {
    if (c.id || !written.has(ids[i])) return;
    next.push({ id: ids[i], name: c.name, createdAt: now, updatedAt: lastAt(ids[i]) || now, kind: 'chat', provenanceSessions: sessionsOf(written.get(ids[i])!) });
  });
  // subscriptions follow the nodes they mirror
  for (const p of projects.filter((q) => touched.has(q.id))) {
    for (const sub of subscriptionsOf(p)) {
      const home = homeOfSubscription(sub, written);
      if (home === p.id || (!home && !removed.includes(p.id))) continue;
      next = next.map((q) => {
        let subs = subscriptionsOf(q);
        if (q.id === p.id) subs = subs.filter((s) => s.sessionId !== sub.sessionId);
        if (q.id === home) {
          // a canvas has one main session: another one joins as a chapter
          const role = sub.role === 'main' && subs.some((s) => s.role === 'main') ? 'chapter' : sub.role;
          subs = [...subs.filter((s) => s.sessionId !== sub.sessionId), { ...sub, role }];
        }
        if (q.id !== p.id && q.id !== home) return q;
        const out: ProjectMeta = { ...q, sessions: subs.length ? subs : undefined };
        delete out.sourceSession;
        return out;
      });
    }
  }

  for (const [id, g] of written) if (id !== activeId) await idbSet(projectStorageKey(id), stored(g));
  if (activeId && removed.includes(activeId)) {
    // the canvas in view emptied out: open where its latest conversation went
    const first = [...fresh.values()].filter((th) => th.canvasId === activeId).sort((a, b) => b.lastAt - a.lastAt)[0];
    await replaceProjects(next);
    await switchProject((first && homeOf.get(first.id)) ?? next.find((p) => written.has(p.id))!.id);
  } else {
    if (activeId && written.has(activeId)) showGraph(written.get(activeId)!);
    await replaceProjects(next);
  }
  for (const id of removed) await idbDel(projectStorageKey(id));
  const created = ids.filter((id) => !projects.some((p) => p.id === id));

  return async () => {
    const now = useProjects.getState();
    if (now.switching || activeAbortControllers.size > 0) throw new Error(t('organizer.busy'));
    await flushPendingWrites();
    const restore = (id: string) => {
      const v = before.get(id);
      return idbSet(projectStorageKey(id), id === activeId ? stored(v as StoredGraph) : v);
    };
    await replaceProjects(metaBefore);
    if (activeId && now.activeId !== activeId) {
      // back to the canvas the rebuild started from (flushing the one in view first)
      if (before.has(activeId)) await restore(activeId);
      await switchProject(activeId);
    } else if (activeId && before.has(activeId)) {
      showGraph(before.get(activeId) as StoredGraph);
    }
    for (const id of before.keys()) if (id !== activeId) await restore(id);
    for (const id of created) await idbDel(projectStorageKey(id));
  };
}
