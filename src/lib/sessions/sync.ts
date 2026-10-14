// The session sync: the one writer of session turns into nodes. It reads a
// subscribed session (lib/sessions/read), plans against what the canvas has
// taken of it (lib/sessions/plan) and applies the plan to the canvas in
// view: a turn the file added lands where its parent turn is (under the
// tail, or beside an earlier turn it forks from); a turn still being
// written, or a delegated run whose report came late, is brought up to date
// while nobody has edited it; a turn a canvas run is waiting for (its
// binding, ThoughtData.run) is written into that run's node.
//
// A canvas out of view is not written: its sessions catch up when it is in
// view again. Appending and mounting never move an existing node.
//
// One sync of a session at a time (lib/sessions/serial), each from the file
// as it stands when its turn comes: syncs started by the run, the watcher,
// a recheck or an arrival never interleave, and none applies an older read
// over a newer one. What a write may do to a node is lib/sessions/writes.
//
// Nothing here is decided by how long anything took. A canvas run's turn is
// the one the run named (its `turn`), written once the run is over — its
// host says so (lib/sessions/host-runs) — from the file, which then holds
// all of it. Only a run from before runs named their turns is still found by
// its question's wording and closed by the file.

import { makeNode } from '../import-chat';
import { useStore } from '../../store';
import { upstreamFingerprint } from '../../store/context-builder';
import {
  useProjects, switchProject, patchSubscription, noteHandled, subscriptionsOf,
  type ProjectMeta, type Subscription,
} from '../../store/projects';
import { useUiStore } from '../ui-store';
import { generateId, countTokens } from '../../utils';
import { placeNewNodes } from '../layout';
import { matchEntry } from '../agents/runtimes';
import { agentRunLive, noteSettled, overlayOf } from '../agents/runs';
import { pruneHighlights } from '../highlight-match';
import { t } from '../../i18n';
import { legacyTaken, planSync, unitIds, type Binding } from './plan';
import { readSession, type FileLoc, type SessionSnapshot } from './read';
import { underSession } from './serial';
import { fsFootprint, refreshedTurn, sameRun, withTurnVersion } from './writes';
import type { AgentRunBinding, AgentRuntime, ThoughtEdge, ThoughtNode } from '../../types';
import type { ImportableConversation } from '../import-chat';

const APPEND_GAP = 190;

export type SyncResult =
  | { kind: 'opened' } // nothing new
  | { kind: 'appended'; turns: number }
  | null; // the canvas is not in view, or nothing to read

/** Place a segment of freshly built nodes under/beside an anchor, above
 *  the collision floor of its column band. Never moves existing nodes. */
export function placeSegment(
  store: { nodes: ThoughtNode[] },
  nodes: ThoughtNode[],
  innerEdges: ThoughtEdge[],
  anchorNode: ThoughtNode,
  sideways: boolean,
): { moved: ThoughtNode[]; edges: ThoughtEdge[] } {
  const baseX = anchorNode.position.x + (sideways ? 560 : 0);
  const bandLeft = baseX - 40;
  const bandRight = baseX + 580;
  const floor = store.nodes.reduce((acc, n) => {
    const w = n.width ?? n.measured?.width ?? 540;
    if (n.position.x + w < bandLeft || n.position.x > bandRight) return acc;
    const h = n.height ?? n.measured?.height ?? 300;
    return Math.max(acc, n.position.y + h);
  }, sideways ? anchorNode.position.y - 300 : anchorNode.position.y + (anchorNode.height ?? 140));
  const dx = baseX - nodes[0].position.x;
  const dy = Math.max(floor + APPEND_GAP, sideways ? anchorNode.position.y : -Infinity) - nodes[0].position.y;
  const moved = nodes.map((n): ThoughtNode => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }));
  const edges: ThoughtEdge[] = [
    { id: generateId(), source: anchorNode.id, target: moved[0].id, type: 'smoothstep' } as ThoughtEdge,
    ...innerEdges,
  ];
  return { moved, edges };
}

/** The runs on the canvas in view waiting for a turn of this session. A run
 *  on a host that records runs is over when the host says so (its last
 *  event, or its record); one from before, when this page saw its end or
 *  does not run it. */
function bindingsFor(nodes: ThoughtNode[], runner: string, sessionId: string): (Binding & { run: AgentRunBinding })[] {
  return nodes
    .filter((n) => n.data.run && n.data.run.runtime === runner && n.data.run.sessionId === sessionId)
    .map((n) => {
      const run = n.data.run!;
      // a run on a host that records runs: it names its turn, the host says when it is over
      const exact = !!run.runId && !!run.bootId;
      return { nodeId: n.id, question: run.question, afterTurnId: run.afterTurnId, turnId: run.turnId, exact, ended: !!run.endedAt || (!exact && !agentRunLive(n.id)), run };
    })
    .sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt));
}

/** A turn the canvas ran and that is over in the file: its answer as the
 *  node's version, recorded the way a finished generation records one — in
 *  place of the earlier versions, or beside them for a run that appends —
 *  with what only the run saw (its thinking, the questions it asked). */
function settledData(n: ThoughtNode, fresh: ThoughtNode, run: AgentRunBinding, graph: { nodes: ThoughtNode[]; edges: ThoughtEdge[] }): ThoughtNode['data'] {
  const d = n.data;
  const response = fresh.data.response;
  const now = new Date().toISOString();
  const config = fresh.data.importSource?.config;
  const ranOn = run.model ?? (config ? matchEntry(run.runtime, config) : undefined);
  const overlay = overlayOf(n.id);
  const failText = new Set([t('node.failedPlaceholder'), t('node.emptyResponse'), t('node.stoppedPlaceholder')]);
  return {
    ...d,
    ...withTurnVersion(d, { response, by: ranOn, effort: config?.effort, at: now, reasoning: overlay?.reasoning || undefined }, run, failText),
    approvals: overlay?.decided.length ? [...(d.approvals ?? []), ...overlay.decided] : d.approvals,
    highlights: pruneHighlights(d.highlights, response),
    isLoading: false, generationFailed: undefined, restreaming: undefined, reasoning: undefined,
    pendingApprovals: undefined, agentTrace: undefined,
    tokenCount: countTokens(d.question + response),
    source: { question: fresh.data.source?.question ?? fresh.data.question, response },
    run: undefined,
    lastContextHash: upstreamFingerprint(n.id, graph.nodes, graph.edges), lastGeneratedAt: now,
  };
}

/**
 * Bring the canvas in view up to date with one subscribed session.
 * `background`: the live watcher's sync, not a person opening the session —
 * a sync that finds nothing new leaves the camera where it is, and a
 * session subscribed by another canvas waits for that canvas.
 */
export function syncConversation(
  conv: ImportableConversation,
  snapshot: SessionSnapshot | null,
  hit: { project: ProjectMeta; sub: Subscription },
  opts: { background?: boolean } = {},
): Promise<SyncResult> {
  return underSession(conv.source, conv.sessionId!, async () => {
    // the file as it stands now: a read that waited for an earlier sync is behind it
    const now = snapshot ? await readSession(snapshot.file).catch(() => null) : null;
    return applySync(now?.conv ?? conv, now?.snapshot ?? snapshot, hit, opts);
  });
}

async function applySync(
  conv: ImportableConversation,
  snapshot: SessionSnapshot | null,
  hit: { project: ProjectMeta; sub: Subscription },
  opts: { background?: boolean },
): Promise<SyncResult> {
  const sessionId = conv.sessionId!;
  if (useProjects.getState().activeId !== hit.project.id) {
    if (opts.background) return null;
    await switchProject(hit.project.id);
  }
  if (useProjects.getState().switching) return null;
  const projectId = hit.project.id;
  const built = conv.build();
  const ids = unitIds(built.nodes, built.edges);
  let sub = subscriptionsOf(useProjects.getState().projects.find((p) => p.id === projectId)).find((s) => s.sessionId === sessionId) ?? hit.sub;
  // a ledger from before ids: the turns its count covered, by id, once
  if (sub.legacyCount !== undefined) {
    const handled = [...new Set([...sub.handled, ...legacyTaken(built, sub.legacyCount)])];
    await patchSubscription(projectId, sessionId, { handled, legacyCount: undefined });
    sub = { ...sub, handled, legacyCount: undefined };
  }
  const store = useStore.getState();
  const survivors = store.nodes.filter((n) => n.data.importSource?.sessionId === sessionId);
  const bindings = bindingsFor(store.nodes, conv.source, sessionId);
  const plan = planSync({ built, handled: new Set(sub.handled), canvas: survivors, bindings });
  const complete = new Set((snapshot?.turns ?? []).filter((t) => t.complete).map((t) => t.id));
  const allComplete = !snapshot;

  // ── the canvas's own runs: their turns land in their nodes ──
  const settled: string[] = [];
  for (const b of plan.bound) {
    const binding = bindings.find((x) => x.nodeId === b.nodeId)!;
    // the node still waits for THIS run, as it stands now: a turn already
    // written, a binding a newer run replaced, take nothing
    const run = useStore.getState().nodes.find((n) => n.id === b.nodeId)?.data.run;
    if (!run || !sameRun(run, binding.run)) continue;
    const fd = b.fresh.data;
    // over: the run is (its host said so — the file then holds the whole
    // turn); a run from before runs named their turns, also when the file closed it
    const over = allComplete || !!run.endedAt || (!binding.exact && complete.has(b.unit));
    const cwd = fd.importSource?.config?.cwd ?? fd.importSource?.cwd ?? '';
    const steps = fd.steps ?? [];
    const fsStep = over ? fsFootprint(cwd, run.changes, steps) : null;
    const done = over && !!fd.response.trim();
    // the runtime's own error, not an answer: recorded, with the retry a failed run gets
    const failed = !!snapshot?.turns.find((x) => x.id === b.unit)?.failed;
    useStore.setState((st) => {
      const graph = { nodes: st.nodes, edges: st.edges };
      return {
        nodes: st.nodes.map((n) => {
          if (n.id !== b.nodeId) return n;
          const withTurn = {
            ...n.data,
            importSource: fd.importSource,
            source: fd.source ?? { question: fd.question, response: fd.response },
            steps: fsStep ? [...steps, fsStep] : steps,
            includedStepIds: undefined,
          };
          if (done) {
            const data = settledData({ ...n, data: withTurn }, b.fresh, run, graph);
            return { ...n, data: failed ? { ...data, generationFailed: true } : data };
          }
          // still being written: what the file holds so far (the overlay shows the live stream)
          return { ...n, data: { ...withTurn, response: fd.response || n.data.response, run: { ...run, turnId: b.unit } } };
        }),
      };
    });
    if (done) settled.push(b.nodeId);
  }
  if (settled.length) {
    const st = useStore.getState();
    st.settleFrom(settled);
    for (const id of settled) {
      st.logEvent('generate', id, { chars: st.nodes.find((n) => n.id === id)?.data.response.length ?? 0, agent: true });
      noteSettled(id);
    }
  }
  // runs over whose turn the file does not show, with no run of this page
  // to write its own account: the node says the run failed, and keeps its
  // binding — the turn, should the file show it after all, takes that place
  const found = new Set(plan.bound.map((b) => b.nodeId));
  const unanswered = bindings.filter((b) => b.exact && !found.has(b.nodeId) && b.run.endedAt && b.run.held !== undefined && !b.run.standIn && !overlayOf(b.nodeId)).map((b) => b.nodeId);
  if (unanswered.length) {
    const failText = new Set([t('node.failedPlaceholder'), t('node.emptyResponse'), t('node.stoppedPlaceholder')]);
    const now = new Date().toISOString();
    useStore.setState((st) => ({
      nodes: st.nodes.map((n) => {
        if (!unanswered.includes(n.id) || !n.data.run) return n;
        const run = n.data.run;
        return { ...n, data: { ...n.data, ...withTurnVersion(n.data, { response: t('node.failedPlaceholder'), by: run.model, at: now }, { append: true }, failText), generationFailed: true, isLoading: false, run: { ...run, standIn: true } } };
      }),
    }));
  }

  // ── turns still being written, runs whose report came late ──
  let refreshed = false;
  for (const { nodeId, fresh } of plan.refresh) {
    const node = useStore.getState().nodes.find((n) => n.id === nodeId);
    if (!node || node.data.run || node.data.isLoading) continue;
    const src = node.data.source;
    const pristine = !!src && node.data.question === src.question && (node.data.response ?? '') === (src.response ?? '');
    const fd = fresh.data;
    const textChanged = fd.question !== node.data.question || (fd.response ?? '') !== (node.data.response ?? '');
    const oldAtts = node.data.attachments ?? [];
    const newAtts = fd.attachments ?? [];
    const attachmentsGrew = newAtts.length > oldAtts.length && oldAtts.every((a, i) => newAtts[i]?.name === a.name);
    // a turn's steps grow while it is written; a child's come with its transcript
    const stepsGrew = (fd.steps?.length ?? 0) > (node.data.steps?.length ?? 0) && (!!fd.importSource?.subagent || textChanged);
    const configNew = !!fd.importSource?.config && JSON.stringify(fd.importSource.config) !== JSON.stringify(node.data.importSource?.config);
    if (!pristine || !(textChanged || attachmentsGrew || stepsGrew || configNew)) continue;
    const attachments = textChanged ? fd.attachments : [...oldAtts, ...newAtts.slice(oldAtts.length)];
    useStore.setState((s) => ({
      nodes: s.nodes.map((n) => (n.id === node.id ? {
        ...n,
        data: {
          ...n.data,
          // the turn's own version, not the node's others (a canvas run may have appended it beside them)
          ...(textChanged ? refreshedTurn(n.data, fd) : {}),
          attachments,
          // what the file system saw is the canvas's, not the file's: it stays
          ...(stepsGrew ? { steps: [...(fd.steps ?? []), ...(n.data.steps ?? []).filter((x) => x.tool === 'fs-changes')] } : {}),
          importSource: { ...fd.importSource!, ...(n.data.importSource?.subagent ? { subagent: n.data.importSource.subagent } : {}) },
          source: fd.source,
        },
      } : n)),
    }));
    refreshed = true;
  }
  if (refreshed) useStore.getState().recomputeStaleness();

  const boundIds = new Map(plan.bound.map((b) => [b.unit, b.nodeId]));
  if (plan.append.length === 0) {
    if (plan.taken.length) {
      const tail = lastTurnNode(plan.bound.map((b) => b.nodeId)) ?? sub.tailNodeId;
      await noteHandled(projectId, sessionId, plan.taken, tail);
    }
    if (!opts.background) useUiStore.getState().setArrivalFocusNodeId(sub.tailNodeId ?? survivors.at(-1)?.id ?? null);
    return { kind: 'opened' };
  }

  // ── turns the file added: under their parent turn, or beside it ──
  const now = useStore.getState();
  const liveSurvivors = now.nodes.filter((n) => n.data.importSource?.sessionId === sessionId);
  const anchor = now.nodes.find((n) => n.id === sub.tailNodeId) ?? liveSurvivors.filter((n) => !n.data.importSource?.subagent && n.data.stepKind !== 'note').at(-1) ?? null;
  const appendix = plan.append.map((n): ThoughtNode => ({ ...n, data: { ...n.data } }));
  const inSet = new Set(appendix.map((n) => n.id));
  const innerEdges = built.edges.filter((e) => inSet.has(e.source) && inSet.has(e.target));
  // a turn's real parent may be one the canvas already holds (a session is a
  // tree): its edge goes to that node, found by the turn's id
  const canvasByUnit = new Map<string, string>();
  for (const n of liveSurvivors) {
    const k = n.data.importSource?.itemIds?.[0];
    if (k) canvasByUnit.set(k, n.id);
  }
  for (const [unit, nodeId] of boundIds) canvasByUnit.set(unit, nodeId);
  const crossEdges: ThoughtEdge[] = [];
  for (const e of built.edges) {
    if (!inSet.has(e.target) || inSet.has(e.source)) continue;
    const unit = ids.get(e.source);
    const canvasId = unit ? canvasByUnit.get(unit) : undefined;
    if (canvasId) crossEdges.push({ ...e, id: generateId(), source: canvasId });
  }
  const crossTargets = new Set(crossEdges.map((e) => e.target));

  let moved: ThoughtNode[];
  let extraEdges: ThoughtEdge[];
  if (anchor) {
    const seg = placeSegment(now, appendix, innerEdges, anchor, false);
    moved = seg.moved;
    // the anchor edge is the linear fallback: dropped where the head found
    // its real parent; every other parentless root gets the same fallback
    const hasInner = new Set(innerEdges.map((e) => e.target));
    extraEdges = seg.edges.filter((e) => !(e.source === anchor.id && crossTargets.has(e.target)));
    for (const n of moved) {
      if (n.id === moved[0].id) continue;
      if (!hasInner.has(n.id) && !crossTargets.has(n.id) && n.data.stepKind !== 'note') {
        extraEdges.push({ id: generateId(), source: anchor.id, target: n.id, type: 'smoothstep' } as ThoughtEdge);
      }
    }
    extraEdges = [...extraEdges, ...crossEdges];
  } else {
    // every earlier mirror node was removed by hand: land beside the
    // canvas, say so, and do not pretend to continue anything
    const maxX = now.nodes.length ? Math.max(...now.nodes.map((n) => n.position.x)) : 0;
    const dx = maxX + 560 - appendix[0].position.x;
    const dy = -appendix[0].position.y;
    moved = appendix.map((n): ThoughtNode => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }));
    const turnsAdded = moved.filter((n) => n.data.importSource?.itemIds?.length && !n.data.importSource.subagent).length;
    const note = makeNote(orphanNoteText(turnsAdded), moved[0]);
    moved = [note, ...moved];
    extraEdges = [
      { id: generateId(), source: note.id, target: moved[1].id, type: 'smoothstep' } as ThoughtEdge,
      ...innerEdges, ...crossEdges,
    ];
  }

  now.pushHistory();
  useStore.setState((s) => ({ nodes: [...s.nodes, ...moved], edges: [...s.edges, ...extraEdges] }));
  // a subagent that found its turn on the canvas, and a turn forking the
  // session above its tail (another client on the same session), are seated
  // by the arrow grammar — beside their parent, like any branch
  const forkHead = anchor && crossEdges.some((e) => e.target === moved[0].id && e.source !== anchor.id);
  const kids = forkHead
    ? moved.filter((n) => n.data.stepKind !== 'note').map((n) => n.id)
    : moved.filter((n) => n.data.importSource?.subagent && crossTargets.has(n.id)).map((n) => n.id);
  if (kids.length) useStore.setState((s) => ({ nodes: placeNewNodes(s.nodes, s.edges, kids) }));
  const lineTail = moved.filter((n) => n.data.importSource?.itemIds?.length && !n.data.importSource.subagent).at(-1)?.id
    ?? lastTurnNode(plan.bound.map((b) => b.nodeId)) ?? sub.tailNodeId;
  await noteHandled(projectId, sessionId, plan.taken, lineTail);
  useUiStore.getState().setArrivalFocusNodeId(moved[anchor ? 0 : 1].id);
  return { kind: 'appended', turns: plan.append.filter((n) => n.data.importSource?.itemIds?.length && !n.data.importSource.subagent && n.data.stepKind !== 'note').length };
}

/** The last of these nodes still on the canvas. */
function lastTurnNode(nodeIds: string[]): string | undefined {
  const nodes = useStore.getState().nodes;
  return [...nodeIds].reverse().find((id) => nodes.some((n) => n.id === id));
}

function orphanNoteText(n: number): string {
  return `[Mirror] The source session grew by ${n} turn(s); the earlier mirrored turns were removed from this canvas by hand, so the new turns land here on their own.`;
}

function makeNote(text: string, beside: ThoughtNode): ThoughtNode {
  const note = makeNode(text, '', false);
  note.data.stepKind = 'note';
  // mirror-owned, not hand-made: provenance rides along (nodes WITHOUT
  // importSource are the user's own)
  note.data.importSource = beside.data.importSource ? { ...beside.data.importSource, itemIds: [] } : undefined;
  note.width = 460;
  note.position = { x: beside.position.x - 520, y: beside.position.y };
  return note;
}

/** Read one session file and sync it into the canvas that subscribes to it,
 *  when that canvas is in view. */
export async function syncFile(loc: FileLoc, opts: { background?: boolean } = {}): Promise<SyncResult> {
  const read = await readSession(loc);
  if (!read) return null;
  const { findSubscription } = await import('../../store/projects');
  const hit = findSubscription(read.snapshot.sessionId);
  if (!hit) return null;
  return syncConversation(read.conv, read.snapshot, hit, opts);
}

/** Sync a session by id, when the canvas in view subscribes to it. */
export async function syncSession(runtime: AgentRuntime, sessionId: string): Promise<SyncResult> {
  const { sessionFile } = await import('./store');
  const loc = await sessionFile(runtime, sessionId);
  return loc ? syncFile(loc, { background: true }) : null;
}

/** On arrival (a canvas switched to, a page opened) and when the host's feed
 *  is back: runs this canvas left waiting learn from the host what became
 *  of them, and read their turns from their files. */
export async function syncWaitingRuns(): Promise<void> {
  const { reconcileHostRuns, watchHostRuns } = await import('./host-runs');
  watchHostRuns();
  await reconcileHostRuns();
  const seen = new Set<string>();
  for (const n of useStore.getState().nodes) {
    const r = n.data.run;
    if (!r?.sessionId || n.data.isLoading) continue;
    const key = `${r.runtime}:${r.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await syncSession(r.runtime, r.sessionId).catch(() => null);
  }
}
