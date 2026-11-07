import { create, type StoreApi } from 'zustand';
import type { CanvasEvent, ThoughtData, ThoughtEdge, ThoughtNode } from '../types';
import type { StoreState } from './types';
import { appendEvent } from './slices/events';
import { withSummary } from './slices/highlights';

// Work outlives the canvas it runs on. A generation is bound to the canvas
// it started on (bindCanvas): while that canvas is in view its writes go to
// the store, as ever; once the person switches away they go to the canvas's
// shadow — its graph as it was left, kept here and written under its own
// key — and when it is back in view the store takes the shadow over, so an
// answer still going keeps streaming into its card. What only the canvas in
// view can do (settle the layout around a grown card, fire the reruns that
// wait on an answer, keep undo steps) waits for its return.
//
// A shadow is kept only for a canvas left with work still running on it,
// and lives until that canvas is back in view, or is deleted. Nothing here
// reaches the store or storage on its own: switchProject (store/projects)
// drives the hand-overs, and the storage write is configured from there.

type Set = StoreApi<StoreState>['setState'];
type Get = StoreApi<StoreState>['getState'];

export interface Graph { nodes: ThoughtNode[]; edges: ThoughtEdge[]; events: CanvasEvent[] }
interface Shadow extends Graph { dirty: boolean; timer: ReturnType<typeof setTimeout> | null }

/** the canvas whose graph the store holds right now: its writes go there */
let inView: string | null = null;
const shadows = new Map<string, Shadow>();
/** work in flight per canvas that may still write it (a stream, a plaque) */
const holds = new Map<string, number>();
const writing = new Map<string, Promise<void>>();
const waiters = new Map<string, ((back: boolean) => void)[]>();
/** answers finished out of view, per canvas: settled and followed up on its return */
const finished = new Map<string, string[]>();
const aborts = new Map<string, () => void>();

/** Direct generations going on, by node, with the canvas each one writes:
 *  what a tab out of view shows as running. */
export const useBackground = create<{ streams: Record<string, string> }>(() => ({ streams: {} }));

let persistGraph: ((canvasId: string, graph: Graph) => Promise<void>) | null = null;
let announce: ((canvasId: string, nodeId: string, ok: boolean) => void) | null = null;

/** How a shadow is written to storage, and who hears of an answer finished
 *  out of view (ok: it answered, rather than failed). */
export function configureBackground(o: { persist: (canvasId: string, graph: Graph) => Promise<void>; finished?: (canvasId: string, nodeId: string, ok: boolean) => void }): void {
  persistGraph = o.persist;
  announce = o.finished ?? null;
}

const PERSIST_DELAY = 2000;
const graphOf = (s: Shadow): Graph => ({ nodes: s.nodes, edges: s.edges, events: s.events });

function write(id: string): Promise<void> {
  const s = shadows.get(id);
  if (!s) return writing.get(id) ?? Promise.resolve();
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  if (!s.dirty || !persistGraph) return writing.get(id) ?? Promise.resolve();
  s.dirty = false;
  const before = writing.get(id) ?? Promise.resolve();
  // one write at a time per canvas, in order: a later state never lands under an earlier one
  const next = before.then(() => persistGraph!(id, graphOf(s))).catch((e) => { console.warn('[thoughtdag] background canvas write failed:', e); });
  writing.set(id, next);
  void next.then(() => { if (writing.get(id) === next) writing.delete(id); });
  return next;
}

function touch(id: string, s: Shadow): void {
  s.dirty = true;
  if (s.timer) clearTimeout(s.timer);
  // a pure debounce: a stream writing every 100ms is written once it pauses or ends
  s.timer = setTimeout(() => { void write(id); }, PERSIST_DELAY);
}

if (typeof window !== 'undefined') {
  const flushAll = () => { for (const id of shadows.keys()) void write(id); };
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
}

/** The canvas whose graph the store holds; null while one is being swapped for another. */
export const canvasInView = (): string | null => inView;

/** Work that may still write this canvas: hold it until done. */
export function hold(canvasId: string): () => void {
  holds.set(canvasId, (holds.get(canvasId) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (holds.get(canvasId) ?? 1) - 1;
    if (n > 0) { holds.set(canvasId, n); return; }
    holds.delete(canvasId);
    // the last work on a canvas out of view is over: its answers are kept now
    if (inView !== canvasId) void write(canvasId);
  };
}

/** The canvas in view is about to be swapped out: with work still going on
 *  it, its graph stays here for that work to write into. */
export function leaveView(canvasId: string | null, graph: Graph): void {
  inView = null;
  if (canvasId && holds.has(canvasId) && !shadows.has(canvasId)) shadows.set(canvasId, { ...graph, dirty: false, timer: null });
}

/** The canvas coming into view, if work went on there while it was out of
 *  view: the newest graph it has (what is in storage may be a moment
 *  behind). The store takes it over; the shadow is gone. */
export function takeShadow(canvasId: string): Graph | null {
  const s = shadows.get(canvasId);
  if (!s) return null;
  if (s.timer) clearTimeout(s.timer);
  shadows.delete(canvasId);
  return graphOf(s);
}

/** The store holds this canvas now: its writes go there, and what waited for it goes on. */
export function enterView(canvasId: string): void {
  inView = canvasId;
  for (const resolve of waiters.get(canvasId) ?? []) resolve(true);
  waiters.delete(canvasId);
}

/** Resolves true once the canvas is in view (at once if it is), false if it is deleted first. */
export function whenInView(canvasId: string | null): Promise<boolean> {
  if (!canvasId) return Promise.resolve(false);
  if (inView === canvasId) return Promise.resolve(true);
  return new Promise((resolve) => { waiters.set(canvasId, [...(waiters.get(canvasId) ?? []), resolve]); });
}

/** A canvas is deleted: its work stops, its shadow goes, and nothing of it
 *  is written after this resolves. */
export async function dropCanvas(canvasId: string): Promise<void> {
  const streams = useBackground.getState().streams;
  for (const [nodeId, c] of Object.entries(streams)) if (c === canvasId) aborts.get(nodeId)?.();
  const s = shadows.get(canvasId);
  if (s?.timer) clearTimeout(s.timer);
  shadows.delete(canvasId);
  finished.delete(canvasId);
  for (const resolve of waiters.get(canvasId) ?? []) resolve(false);
  waiters.delete(canvasId);
  await writing.get(canvasId);
}

/** Work still going on a canvas out of view, or a shadow not written yet:
 *  what rewrites stored canvases (the organizer) waits for it. */
export function backgroundBusy(): boolean {
  if (holds.size > 0 || writing.size > 0) return true;
  for (const s of shadows.values()) if (s.dirty) return true;
  return false;
}

/** Forget shadows that have nothing left to write (all in storage): before
 *  something rewrites the stored canvases, so no older copy comes back. */
export function dropIdleShadows(): void {
  for (const [id, s] of shadows) if (!s.dirty && !holds.has(id)) shadows.delete(id);
}

/** Change a node on a canvas out of view that has a shadow; false when it
 *  has none (the stored copy is then the place to change it). */
export function patchShadowNode(canvasId: string, nodeId: string, fn: (data: ThoughtData) => Partial<ThoughtData>): boolean {
  const s = shadows.get(canvasId);
  if (!s) return false;
  s.nodes = s.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...fn(n.data) } } : n));
  touch(canvasId, s);
  return true;
}

/** A direct generation is going on this node, for this canvas (abort stops it). */
export function trackStream(nodeId: string, canvasId: string, abort: () => void): () => void {
  aborts.set(nodeId, abort);
  useBackground.setState((st) => ({ streams: { ...st.streams, [nodeId]: canvasId } }));
  return () => {
    if (aborts.get(nodeId) === abort) aborts.delete(nodeId);
    useBackground.setState((st) => {
      if (st.streams[nodeId] !== canvasId) return st;
      const streams = { ...st.streams };
      delete streams[nodeId];
      return { streams };
    });
  };
}

/** An answer finished (ok: answered, not failed) while its canvas was out of view. */
export function noteFinished(canvasId: string, nodeId: string, ok: boolean): void {
  const list = finished.get(canvasId) ?? [];
  if (!list.includes(nodeId)) finished.set(canvasId, [...list, nodeId]);
  announce?.(canvasId, nodeId, ok);
}

/** The answers that finished out of view, for the canvas now back in view. */
export function takeFinished(canvasId: string): string[] {
  const list = finished.get(canvasId) ?? [];
  finished.delete(canvasId);
  return list;
}

export interface CanvasHandle {
  readonly canvasId: string;
  /** the canvas's graph is the store's right now */
  live(): boolean;
  set: Set;
  get: Get;
  /** a node's plaque, wherever its canvas is when the judge answers */
  setSummary: (nodeId: string, summary: string, forResponse: string, type?: string, topic?: string) => void;
  hold(): () => void;
}

/**
 * Bind work to the canvas in view: what it writes lands on that canvas
 * wherever the canvas is by then — the store while it is in view, its
 * shadow while it is not. Null between canvases (a switch under way).
 */
export function bindCanvas(set: Set, get: Get): CanvasHandle | null {
  const canvasId = inView;
  if (!canvasId) return null;
  const live = () => inView === canvasId;

  const toShadow = (partial: Parameters<Set>[0]): void => {
    const s = shadows.get(canvasId);
    if (!s) return; // nowhere to write: the canvas is gone, or no work kept it
    const patch = typeof partial === 'function' ? partial(shadowState()) : partial;
    if (!patch) return;
    if (patch.nodes) s.nodes = patch.nodes;
    if (patch.edges) s.edges = patch.edges;
    if (patch.events) s.events = patch.events;
    touch(canvasId, s);
  };
  const route = ((partial: Parameters<Set>[0], replace?: boolean) => {
    if (live()) (set as (p: Parameters<Set>[0], r?: boolean) => void)(partial, replace);
    else toShadow(partial);
  }) as Set;

  // the store's state with the shadow's graph in it; what acts on the canvas
  // in view acts on the shadow instead, or waits for the canvas to be back
  const shadowState = (): StoreState => {
    const s = shadows.get(canvasId);
    return {
      ...get(),
      nodes: s?.nodes ?? [],
      edges: s?.edges ?? [],
      events: s?.events ?? [],
      staleIds: [],
      selectedNodeId: null,
      selectedNodeIds: [],
      logEvent: (op, id, d) => route((st) => ({ events: appendEvent(st.events, op, id, d) })),
      setSummary: (...args) => route(withSummary(...args)),
      pushHistory: () => {},
      settleFrom: () => {},
    };
  };

  return {
    canvasId,
    live,
    set: route,
    get: () => (live() ? get() : shadowState()),
    setSummary: (...args) => route(withSummary(...args)),
    hold: () => hold(canvasId),
  };
}
