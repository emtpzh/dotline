// The run manager: the agent turns this page started, by the node each one
// answers. A run belongs to the page, not to the canvas in view — switching
// canvases never stops one. It starts the run, aborts it, answers what the
// agent asks, and keeps the run's OVERLAY: the text and thinking as they
// stream, the tool calls so far, the questions waiting for an answer. The
// overlay is only what the canvas shows while the run is going; the node's
// answer, steps and provenance come from the session file, written by the
// session sync (lib/sessions/sync) once the turn is there — the one writer.
//
// What a run learns that the sync needs (the session it opened, that it is
// over, what changed on disk) goes onto the node's binding (ThoughtData.run)
// wherever that node's canvas is: in view, or in its stored copy.

import { create } from 'zustand';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import type { AgentRunBinding, AgentRuntime, AgentTraceEntry, ApprovalOutcome, ApprovalRecord, ApprovalRequest, ThoughtData, ThoughtNode } from '../../types';
import type { ContextMessage, ImageAttachment } from '../api';
import { useStore } from '../../store';
import type { AgentRoute } from './agent-runtime';
import { lateFootprint } from '../sessions/writes';
import { hostBootId, watchHostRuns } from '../sessions/host-runs';

export interface RunOverlay {
  nodeId: string;
  canvasId: string;
  runtime: AgentRuntime;
  /** the question as asked, for the page-wide list of waiting questions */
  question: string;
  startedAt: string;
  text: string;
  reasoning: string;
  trace: AgentTraceEntry[];
  /** questions the agent waits on, oldest first */
  approvals: ApprovalRequest[];
  /** questions answered during the run: the turn's record once it is in */
  decided: ApprovalRecord[];
  /** the run's last event arrived */
  ended?: boolean;
}

export const useRuns = create<{ runs: Record<string, RunOverlay> }>(() => ({ runs: {} }));

const controllers = new Map<string, AbortController>();

const patchOverlay = (nodeId: string, fn: (r: RunOverlay) => RunOverlay): void => {
  useRuns.setState((s) => {
    const r = s.runs[nodeId];
    return r ? { runs: { ...s.runs, [nodeId]: fn(r) } } : s;
  });
};

/** A run of this page is going on this node. */
export const agentRunLive = (nodeId: string): boolean => controllers.has(nodeId);

export const overlayOf = (nodeId: string): RunOverlay | undefined => useRuns.getState().runs[nodeId];

/** How many of this page's runs answer nodes of this canvas. */
export function liveRunsOn(canvasId: string | null): number {
  if (!canvasId) return 0;
  return [...controllers.keys()].filter((id) => useRuns.getState().runs[id]?.canvasId === canvasId).length;
}

/** Stop the run on this node, if this page runs one. */
export function abortAgentRun(nodeId: string): boolean {
  const c = controllers.get(nodeId);
  if (!c) return false;
  c.abort();
  return true;
}

/** The overlay has done its job: the node holds the turn (or the run's fallback). */
export function clearOverlay(nodeId: string): void {
  if (controllers.has(nodeId)) return;
  useRuns.setState((s) => {
    if (!s.runs[nodeId]) return s;
    const runs = { ...s.runs };
    delete runs[nodeId];
    return { runs };
  });
}

/** The session sync wrote the run's turn into its node: the overlay goes
 *  (once the run is over, if it is not yet). */
export function noteSettled(nodeId: string): void {
  clearOverlay(nodeId);
}

type StoredCanvas = { state?: { nodes?: ThoughtNode[] } };

/**
 * Change a node wherever its canvas is: the canvas in view through the
 * store, another one in its stored copy (it reads the change when it is
 * opened again).
 */
export async function patchNodeOn(canvasId: string, nodeId: string, fn: (data: ThoughtData) => Partial<ThoughtData>): Promise<void> {
  const { useProjects, projectStorageKey } = await import('../../store/projects');
  const { activeId, switching } = useProjects.getState();
  if (activeId === canvasId && !switching) {
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...fn(n.data) } } : n)) }));
    return;
  }
  const { flushPendingWrites } = await import('../persistence');
  await flushPendingWrites();
  const key = projectStorageKey(canvasId);
  const raw = await idbGet(key);
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as StoredCanvas | undefined;
  const nodes = parsed?.state?.nodes;
  if (!parsed?.state || !nodes?.some((n) => n.id === nodeId)) return;
  parsed.state.nodes = nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...fn(n.data) } } : n));
  await idbSet(key, typeof raw === 'string' ? JSON.stringify(parsed) : parsed);
}

/** Change a node's binding wherever its canvas is. */
export function patchBinding(canvasId: string, nodeId: string, fn: (run: AgentRunBinding) => AgentRunBinding): Promise<void> {
  return patchNodeOn(canvasId, nodeId, (d) => (d.run ? { run: fn(d.run) } : {}));
}

export type RunEnd = { how: 'end' | 'aborted' | 'error'; text: string; error?: string };

/**
 * Run one agent turn for a node: the overlay fills as it streams, the
 * binding learns the session and the end. Resolves when the run's last
 * event arrives; the node itself is the session sync's to write.
 */
export async function runAgentTurn(o: {
  nodeId: string;
  canvasId: string;
  runtime: AgentRuntime;
  question: string;
  messages: ContextMessage[];
  images?: ImageAttachment[];
  model: string;
  route: AgentRoute;
  /** the binding the run answers to (its startedAt): what the run learns lands only there */
  startedAt?: string;
  /** the run named its session: the binding and the subscription follow */
  onSession: (session: { runtime: AgentRuntime; sessionId: string | null; sessionFile: string | null; cwd: string; effort?: string; preset?: string }) => void;
}): Promise<RunEnd> {
  const { nodeId } = o;
  // the run's last words, should they come after its stream closed, still land
  watchHostRuns();
  controllers.get(nodeId)?.abort();
  const controller = new AbortController();
  controllers.set(nodeId, controller);
  useRuns.setState((s) => ({ runs: { ...s.runs, [nodeId]: {
    nodeId, canvasId: o.canvasId, runtime: o.runtime, question: o.question, startedAt: new Date().toISOString(),
    text: '', reasoning: '', trace: [], approvals: [], decided: [],
  } } }));
  const mine = () => controllers.get(nodeId) === controller;
  // what the run learns goes onto its own binding: never onto a newer run's
  const patchOwn = (fn: (run: AgentRunBinding) => AgentRunBinding) =>
    patchBinding(o.canvasId, nodeId, (run) => (!o.startedAt || run.startedAt === o.startedAt ? fn(run) : run));
  let last: { turnId?: string; held?: boolean } = {};
  // stream frames arrive fast: the overlay commits at most every ~100ms
  let latest: { text?: string; reasoning?: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const commit = () => {
    timer = null;
    if (!latest || !mine()) { latest = null; return; }
    const p = latest;
    latest = null;
    patchOverlay(nodeId, (r) => ({ ...r, ...p }));
  };
  const push = (p: { text?: string; reasoning?: string }) => {
    latest = { ...(latest ?? {}), ...p };
    if (!timer) { commit(); timer = setTimeout(commit, 100); }
  };
  const { agentCallStream } = await import('./agent-runtime');
  const { noticeQuestion, clearQuestionNotice } = await import('./offscreen');
  const inView = async () => {
    const { useProjects } = await import('../../store/projects');
    return useProjects.getState().activeId === o.canvasId;
  };
  let text = '';
  try {
    text = await agentCallStream(o.messages, (_chunk, full) => push({ text: full }), controller.signal, o.images, {
      onReasoning: (_chunk, full) => push({ reasoning: full }),
      onAgentTool: (call) => {
        if (!mine()) return;
        const now = new Date().toISOString();
        patchOverlay(nodeId, (r) => {
          const trace = [...r.trace];
          if (call.phase === 'start') trace.push({ id: call.id || `${trace.length}`, name: call.name, query: call.query, status: 'running', startedAt: now });
          else { const i = trace.findIndex((e) => e.id === call.id && e.status === 'running'); if (i >= 0) trace[i] = { ...trace[i], status: call.isError ? 'error' : 'ok', endedAt: now }; }
          return { ...r, trace };
        });
      },
      onAgentSession: (session) => { if (mine()) o.onSession(session); },
      // the run's id on its host, and the host's boot: what a page that
      // misses the run's events asks the host about
      onAgentRun: ({ runId }) => { if (mine()) void hostBootId().then((bootId: string | null) => patchOwn((run) => ({ ...run, runId, ...(bootId ? { bootId } : {}) }))); },
      onAgentTurn: (turnId) => { if (mine()) void patchOwn((run) => ({ ...run, turnId })); },
      onAgentEnd: (end) => { last = end; },
      // onto the binding for the sync to write with the turn — or, the turn
      // written before the run's last word (the file can close it first),
      // straight onto the turn's steps
      onAgentChanges: (changes) => { if (mine()) void patchNodeOn(o.canvasId, nodeId, (d) => (d.run ? (!o.startedAt || d.run.startedAt === o.startedAt ? { run: { ...d.run, changes } } : {}) : lateFootprint(d, changes) ?? {})); },
      onApproval: (request) => {
        if (!mine()) return;
        const askedAt = new Date().toISOString();
        // append, never replace: parallel tool calls each ask on their own card
        patchOverlay(nodeId, (r) => (r.approvals.some((p) => p.id === request.id) ? r : { ...r, approvals: [...r.approvals, { ...request, askedAt }] }));
        // a card out of sight gets a toast; a canvas out of view, the page's list of waiting questions
        void inView().then((v) => { if (v) noticeQuestion(nodeId); });
      },
      onApprovalDecided: ({ id, outcome, value }) => {
        if (!mine()) return;
        const decidedAt = new Date().toISOString();
        patchOverlay(nodeId, (r) => {
          const asked = r.approvals.find((p) => p.id === id);
          const approvals = r.approvals.filter((p) => p.id !== id);
          if (!approvals.length) clearQuestionNotice(nodeId);
          if (!asked) return { ...r, approvals };
          const record = { ...asked } as ApprovalRequest;
          delete record.answered;
          return { ...r, approvals, decided: [...r.decided, { ...record, outcome: outcome as ApprovalOutcome, decidedAt, ...(value ? { value } : {}) }] };
        });
      },
    }, o.model, o.route, nodeId);
    if (timer) clearTimeout(timer);
    commit();
    return { how: 'end', text };
  } catch (err) {
    if (timer) clearTimeout(timer);
    commit();
    const partial = overlayOf(nodeId)?.text ?? '';
    if (err instanceof DOMException && err.name === 'AbortError') return { how: 'aborted', text: partial };
    return { how: 'error', text: partial, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (mine()) {
      controllers.delete(nodeId);
      patchOverlay(nodeId, (r) => ({ ...r, ended: true, approvals: [] }));
      clearQuestionNotice(nodeId);
      // over, with its turn and whether the file held all of it — on the
      // binding before anyone reads the file for it
      await patchOwn((run) => ({ ...run, endedAt: new Date().toISOString(), ...(last.turnId ? { turnId: last.turnId } : {}), ...(last.held !== undefined ? { held: last.held } : {}) }));
    }
  }
}

/** Mark a question answered on the overlay the moment it is clicked; drop it once the runtime has it. */
export function markAnswered(nodeId: string, requestId: string, mark: ApprovalRequest['answered'] | undefined): void {
  patchOverlay(nodeId, (r) => ({ ...r, approvals: r.approvals.map((p) => (p.id === requestId ? { ...p, answered: mark } : p)) }));
}
export function dropQuestion(nodeId: string, requestId: string): void {
  patchOverlay(nodeId, (r) => ({ ...r, approvals: r.approvals.filter((p) => p.id !== requestId) }));
}

/** What a node shows while a run of this page answers it: the overlay over its own data. */
export function withOverlay(data: ThoughtData, r: RunOverlay | undefined): ThoughtData {
  if (!r) return data;
  const live = !r.ended || data.isLoading;
  return {
    ...data,
    isLoading: live,
    ...(r.text ? { response: r.text, restreaming: undefined } : {}),
    ...(r.reasoning ? { reasoning: r.reasoning } : {}),
    agentTrace: r.trace,
    pendingApprovals: r.approvals.length ? r.approvals : undefined,
  };
}

/** The node's data as the canvas shows it now. */
export function useNodeView(nodeId: string | null | undefined, data: ThoughtData): ThoughtData;
export function useNodeView(nodeId: string | null | undefined, data: ThoughtData | undefined): ThoughtData | undefined;
export function useNodeView(nodeId: string | null | undefined, data: ThoughtData | undefined): ThoughtData | undefined {
  const r = useRuns((s) => (nodeId ? s.runs[nodeId] : undefined));
  return data && r ? withOverlay(data, r) : data;
}
