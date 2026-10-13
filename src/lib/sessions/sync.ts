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
import type { AgentRunBinding, AgentRuntime, AgentStep, ThoughtEdge, ThoughtNode } from '../../types';
import type { ImportableConversation } from '../import-chat';

const APPEND_GAP = 190;
/** A session file quiet this long holds all its open turn will get (a run killed mid-turn writes no end). */
const QUIET_MS = 60_000;
/** A run over this long whose turn the file never showed: it is not coming. */
const GIVE_UP_MS = 10 * 60_000;

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

/** The runs on the canvas in view waiting for a turn of this session. */
function bindingsFor(nodes: ThoughtNode[], runner: string, sessionId: string): (Binding & { run: AgentRunBinding })[] {
  return nodes
    .filter((n) => n.data.run && n.data.run.runtime === runner && n.data.run.sessionId === sessionId)
    .map((n) => ({ nodeId: n.id, question: n.data.run!.question, afterTurnId: n.data.run!.afterTurnId, turnId: n.data.run!.turnId, ended: !!n.data.run!.endedAt || !agentRunLive(n.id), run: n.data.run! }))
    .sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt));
}

/** One step naming the files the file system saw change during the turn
 *  that the tools did not already declare — absolute paths, op "write",
 *  like any footprint. */
export function fsFootprint(
  cwd: string,
  changes: AgentRunBinding['changes'],
  steps: AgentStep[],
): AgentStep | null {
  const ch = changes;
  if (!ch) return null;
  const declared = new Set<string>();
  for (const a of steps) for (const p of a.paths ?? []) declared.add(p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p}`);
  const changed = [...ch.changed, ...ch.added].filter((p) => !declared.has(p));
  const removed = ch.removed.filter((p) => !declared.has(p));
  if (changed.length === 0 && removed.length === 0 && !ch.truncated) return null;
  const rel = (p: string) => (p.startsWith(cwd) ? p.slice(cwd.length).replace(/^\//, '') : p);
  const lines: string[] = [];
  if (changed.length) lines.push('Changed on disk during this turn (seen by the file system, not declared by a tool):', ...changed.map((p) => '- ' + rel(p)));
  if (removed.length) lines.push('Removed:', ...removed.map((p) => '- ' + rel(p)));
  if (ch.truncated) lines.push('(the directory was too large to scan completely)');
  return { id: `fs-${Date.now().toString(36)}`, tool: 'fs-changes', op: 'write', call: '', result: lines.join('\n'), paths: [...changed, ...removed] };
}

/** Whether a session file has been quiet long enough that its open turn is all it will be. */
async function fileQuiet(loc: FileLoc | null): Promise<boolean> {
  if (!loc || !window.desktopSessions) return true;
  const listed = (await window.desktopSessions.list(loc.rootKey).catch(() => [])).find((f) => f.rel === loc.rel);
  if (!listed) return true;
  if (listed.live === false) return true; // no host holds the session: nothing more is coming
  return Date.now() - listed.mtime >= QUIET_MS;
}

const rechecks = new Map<string, ReturnType<typeof setTimeout>>();
/** Read a file again later: a turn the canvas waits for is not over, and the
 *  file may not change again to say so. */
function recheckLater(loc: FileLoc): void {
  const key = `${loc.rootKey}|${loc.rel}`;
  if (rechecks.has(key)) return;
  rechecks.set(key, setTimeout(() => { rechecks.delete(key); void syncFile(loc, { background: true }); }, QUIET_MS / 2));
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
  const kept = run.append
    ? d.responses.map((r, i) => ({ r, q: d.questions?.[i], by: d.generatedBy?.[i], rs: d.reasonings?.[i], at: d.generatedAts?.[i], ed: d.editedAts?.[i], gw: d.gatewaySearches?.[i], ef: d.generatedEfforts?.[i] })).filter(({ r }) => r && !failText.has(r))
    : [];
  const responses = [...kept.map((k) => k.r), response];
  return {
    ...d,
    response, responses,
    questions: [...kept.map((k) => k.q ?? d.question), d.question],
    generatedBy: [...kept.map((k) => k.by), ranOn],
    generatedEfforts: [...kept.map((k) => k.ef), config?.effort],
    generatedAts: [...kept.map((k) => k.at), now],
    editedAts: [...kept.map((k) => k.ed), undefined],
    gatewaySearches: [...kept.map((k) => k.gw), undefined],
    reasonings: [...kept.map((k) => k.rs), overlay?.reasoning || undefined],
    responseIndex: responses.length - 1,
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
export async function syncConversation(
  conv: ImportableConversation,
  snapshot: SessionSnapshot | null,
  hit: { project: ProjectMeta; sub: Subscription },
  opts: { background?: boolean } = {},
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
  let waiting = false;
  const settled: string[] = [];
  for (const b of plan.bound) {
    const binding = bindings.find((x) => x.nodeId === b.nodeId)!;
    const fd = b.fresh.data;
    const live = agentRunLive(b.nodeId);
    // over: the file closed the turn, the run's last event came, or (no run
    // here) the file has gone quiet
    const over = allComplete || complete.has(b.unit) || !!binding.run.endedAt || (!live && await fileQuiet(snapshot?.file ?? null));
    const cwd = fd.importSource?.config?.cwd ?? fd.importSource?.cwd ?? '';
    const steps = fd.steps ?? [];
    const fsStep = over ? fsFootprint(cwd, binding.run.changes, steps) : null;
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
            const data = settledData({ ...n, data: withTurn }, b.fresh, binding.run, graph);
            return { ...n, data: failed ? { ...data, generationFailed: true } : data };
          }
          // still being written: what the file holds so far (the overlay shows the live stream)
          return { ...n, data: { ...withTurn, response: fd.response || n.data.response, run: { ...binding.run, turnId: b.unit } } };
        }),
      };
    });
    if (done) settled.push(b.nodeId);
    else if (!live) waiting = true;
  }
  if (settled.length) {
    const st = useStore.getState();
    st.settleFrom(settled);
    for (const id of settled) {
      st.logEvent('generate', id, { chars: st.nodes.find((n) => n.id === id)?.data.response.length ?? 0, agent: true });
      noteSettled(id);
    }
  }
  if (waiting && snapshot) recheckLater(snapshot.file);
  // runs long over whose turn never showed up let go of their binding
  const found = new Set(plan.bound.map((b) => b.nodeId));
  const lost = bindings.filter((b) => !found.has(b.nodeId) && b.run.endedAt && Date.now() - Date.parse(b.run.endedAt) > GIVE_UP_MS).map((b) => b.nodeId);
  if (lost.length) useStore.setState((st) => ({ nodes: st.nodes.map((n) => (lost.includes(n.id) ? { ...n, data: { ...n.data, run: undefined } } : n)) }));

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
          ...(textChanged ? { question: fd.question, response: fd.response, responses: fd.responses, responseIndex: fd.responseIndex, tokenCount: fd.tokenCount } : {}),
          attachments,
          ...(stepsGrew ? { steps: fd.steps } : {}),
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

/** On arrival (a canvas switched to, a page opened): runs this canvas left
 *  waiting for their turns read them from their files. */
export async function syncWaitingRuns(): Promise<void> {
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
