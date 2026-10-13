import { set as idbSet } from 'idb-keyval';
import { useStore, stripTransient } from '../../store';
import {
  useProjects, switchProject, adoptImportedProject, createProject, projectStorageKey,
  addSubscription, removeSubscription, subscribedSessionIds, subscriptionsOf, mainSubscription, findSubscription, takenCount,
} from '../../store/projects';
import { useUiStore, toast } from '../ui-store';
import { t, fmt } from '../../i18n';
import { placeSegment, syncConversation } from '../sessions/sync';
import { legacyTaken } from '../sessions/plan';
import type { SessionSnapshot } from '../sessions/read';
import type { ThoughtNode } from '../../types';

// The canonical-canvas contract, chapter edition. One canvas = one line
// of thought; sessions are its physical chapters. Routing order:
//   1. SUBSCRIBED session (main / chapter / branch) → open the canvas and
//      sync it (lib/sessions/sync): only turns it has not taken land.
//   2. UNREGISTERED session whose opening carries a live anchor → MOUNT
//      it: mode=branch hangs sideways at the anchor node (a side
//      experiment), mode=continue extends the main line below it (the
//      next chapter after context surgery) — and register it, which is
//      what makes every later arrival idempotent.
//   3. Otherwise → a fresh canvas subscribing to this session.
// Appending and mounting never move an existing node.

export type CanonicalResult =
  | { kind: 'imported'; nodeCount: number }
  | { kind: 'opened' } // already mirrored, nothing new
  | { kind: 'appended'; turns: number }
  | { kind: 'mounted'; mode: 'branch' | 'continue'; turns: number }
  | null; // not a runner session

export async function importOrAppendSession(text: string): Promise<CanonicalResult> {
  const { anyRunnerSessionConversation } = await import('../adapters');
  const conv = await anyRunnerSessionConversation(text);
  return importOrAppendConversation(conv);
}

export { shellSessionReader } from '../sessions/read';

/** `background`: the live watcher's sync, not a person opening the session —
 *  a sync that finds nothing new leaves the camera where it is. */
export async function importOrAppendConversation(
  conv: import('../import-chat').ImportableConversation | null,
  opts: { background?: boolean; snapshot?: SessionSnapshot | null } = {},
): Promise<CanonicalResult> {
  if (!conv) return null;

  // ── 1. subscribed somewhere? open + sync ──
  const hit = findSubscription(conv.sessionId);
  if (hit) return syncConversation(conv, opts.snapshot ?? null, hit, opts);

  const built = conv.build();
  const qa = built.nodes.filter((n) => n.data.importSource);
  // the tail is the line's last turn: a subagent branch beside it never is
  const tailQaId = qa.filter((n) => !n.data.importSource?.subagent).at(-1)?.id ?? qa.at(-1)?.id ?? built.nodes.at(-1)?.id ?? '';
  if (built.nodes.length === 0) return null;
  const allTaken = legacyTaken(built, qa.length);

  // ── 1a. provenance adoption: a canvas that still HOLDS this
  //       session's mirror nodes but lost its ledger entry (a healed
  //       or legacy subscription) is the session's home. Re-register at
  //       the exact break point — the LAST surviving mirrored turn — so
  //       reopening continues there instead of splitting the mirror
  //       across a second canvas. Turns pruned BEFORE the break point
  //       stay pruned (importedCount covers them); a pruned TAIL does
  //       come back — the rebuilt ledger cannot know it once reached
  //       further, and a split canvas would be the worse failure. ──
  if (conv.sessionId) {
    const claim = await findProvenanceClaim(conv.sessionId);
    if (claim) {
      let lastIdx = -1;
      let tailNode = '';
      qa.forEach((n, i) => {
        const k = n.data.importSource?.itemIds?.[0];
        const nid = k ? claim.byFirstId.get(k) : undefined;
        if (nid) { lastIdx = i; tailNode = nid; }
      });
      if (lastIdx >= 0) {
        await addSubscription(claim.projectId, {
          runner: conv.source, sessionId: conv.sessionId, role: 'chapter', handled: legacyTaken(built, lastIdx + 1), tailNodeId: tailNode,
        });
        const adopted = findSubscription(conv.sessionId);
        if (adopted) return syncConversation(conv, opts.snapshot ?? null, adopted, opts);
      }
    }
  }

  // ── 2. anchor-first mounting: the return half of the experiment loop,
  //       command-free — the anchor travels in the opening message ──
  if (conv.sessionId && qa.length > 0) {
    const { parseAnchor } = await import('../experiment-loop');
    const anchor = parseAnchor(qa[0].data.question ?? '');
    if (anchor && useProjects.getState().projects.some((p) => p.id === anchor.project)) {
      await switchProject(anchor.project);
      const store = useStore.getState();
      const meta = useProjects.getState().projects.find((p) => p.id === anchor.project)!;
      let anchorNode = store.nodes.find((n) => n.id === anchor.node) ?? null;
      const main = mainSubscription(meta);
      if (!anchorNode && anchor.mode === 'continue' && main) {
        // a chapter continues the MAIN line: fall back to its living tail
        anchorNode = store.nodes.find((n) => n.id === main.tailNodeId)
          ?? store.nodes.filter((n) => n.data.importSource?.sessionId === main.sessionId).at(-1) ?? null;
      }
      // native canvases mount too — the ledger grows an empty-main
      // container on registration; no subscription is required to host
      if (anchorNode) {
        // The opening turn REPLAYS what the canvas already holds (the
        // compiled context, anchor included) — mounted verbatim, every
        // continue would nest the previous opener one level deeper.
        // Compress it to a departure marker; the reply stays.
        const opener = built.nodes.find((n) => n.data.importSource && n.data.stepKind !== 'note');
        if (opener && parseAnchor(opener.data.question ?? '')) {
          const mark = t('exp.openerMark');
          opener.data = { ...opener.data, question: mark, source: opener.data.source ? { ...opener.data.source, question: mark } : opener.data.source };
        }
        const inSet = new Set(built.nodes.map((n) => n.id));
        const innerEdges = built.edges.filter((e) => inSet.has(e.source) && inSet.has(e.target));
        const sideways = anchor.mode !== 'continue';
        const seg = placeSegment(store, built.nodes, innerEdges, anchorNode, sideways);
        if (sideways) {
          const firstQa = seg.moved.find((n) => n.data.importSource && n.data.stepKind !== 'note');
          if (firstQa) firstQa.data = { ...firstQa.data, isBranch: true };
        }
        store.pushHistory();
        useStore.setState((s) => ({ nodes: [...s.nodes, ...seg.moved], edges: [...s.edges, ...seg.edges] }));
        await addSubscription(anchor.project, {
          runner: conv.source, sessionId: conv.sessionId, role: sideways ? 'branch' : 'chapter',
          handled: allTaken, tailNodeId: tailQaId, ...(sideways ? { anchorNodeId: anchorNode.id } : {}),
        });
        useUiStore.getState().setArrivalFocusNodeId(seg.moved[seg.moved.length - 1].id);
        return { kind: 'mounted', mode: sideways ? 'branch' : 'continue', turns: qa.length };
      }
      // anchor target unreachable — fall through to an honest plain import
    }
  }

  // ── 3. a fresh canvas subscribing to this session ──
  const id = crypto.randomUUID();
  await idbSet(projectStorageKey(id), JSON.stringify({ state: { nodes: stripTransient(built.nodes), edges: built.edges }, version: 1 }));
  useUiStore.getState().setArrivalFocusNodeId(built.nodes[built.nodes.length - 1].id);
  await adoptImportedProject(id, conv.title.slice(0, 60), 'chat', conv.sessionId ? {
    sessions: [{ key: `${conv.source}:${conv.sessionId}`, runner: conv.source, sessionId: conv.sessionId, role: 'main', handled: allTaken, tailNodeId: tailQaId }],
  } : undefined);
  return { kind: 'imported', nodeCount: built.nodes.length };
}

/** The MANUAL road into a canvas: mount an arbitrary session onto a
 *  chosen canvas's main-line tail (the anchored road is automatic; this
 *  one is for "I want these sessions to meet" — the join entry the map
 *  offers). Registers as a chapter, so growth appends idempotently. */
export async function mountConversationToProject(
  conv: import('../import-chat').ImportableConversation | null,
  projectId: string,
): Promise<CanonicalResult> {
  if (!conv || !conv.sessionId) return null;
  if (findSubscription(conv.sessionId)) return importOrAppendConversation(conv); // already lives somewhere
  const built = conv.build();
  const qa = built.nodes.filter((n) => n.data.importSource);
  if (built.nodes.length === 0) return null;
  await switchProject(projectId);
  const store = useStore.getState();
  const meta = useProjects.getState().projects.find((p) => p.id === projectId);
  if (!meta) return null;
  const main = mainSubscription(meta);
  const anchorNode = (main ? store.nodes.find((n) => n.id === main.tailNodeId)
    ?? store.nodes.filter((n) => n.data.importSource?.sessionId === main.sessionId).at(-1) : null)
    ?? store.nodes.at(-1) ?? null;
  if (!anchorNode) return null;
  const inSet = new Set(built.nodes.map((n) => n.id));
  const innerEdges = built.edges.filter((e) => inSet.has(e.source) && inSet.has(e.target));
  const seg = placeSegment(store, built.nodes, innerEdges, anchorNode, false);
  store.pushHistory();
  useStore.setState((s) => ({ nodes: [...s.nodes, ...seg.moved], edges: [...s.edges, ...seg.edges] }));
  await addSubscription(projectId, {
    runner: conv.source, sessionId: conv.sessionId, role: 'chapter', handled: legacyTaken(built, qa.length),
    tailNodeId: qa.filter((n) => !n.data.importSource?.subagent).at(-1)?.id ?? qa.at(-1)?.id ?? built.nodes.at(-1)!.id,
  });
  useUiStore.getState().setArrivalFocusNodeId(seg.moved[seg.moved.length - 1].id);
  return { kind: 'mounted', mode: 'continue', turns: qa.length };
}

/** Which canvas still holds mirror nodes of this session? Active canvas
 *  first (it is in memory and the user's likely target), then the rest
 *  by recency from their stored graphs. Returns the mirrored turns'
 *  first item ids mapped to node ids — the break-point evidence. */
async function findProvenanceClaim(sessionId: string): Promise<{ projectId: string; byFirstId: Map<string, string> } | null> {
  const { projects, activeId } = useProjects.getState();
  const ordered = [...projects].sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : b.updatedAt - a.updatedAt));
  for (const p of ordered) {
    // the meta fingerprint answers "not here" without parsing the
    // stored graph; a legacy meta (no fingerprint) takes the slow path
    // once and gets its fingerprint backfilled below
    if (p.id !== activeId && p.provenanceSessions && !p.provenanceSessions.includes(sessionId)) continue;
    let nodes: ThoughtNode[];
    if (p.id === activeId) {
      nodes = useStore.getState().nodes;
    } else {
      try {
        const { get: idbGet } = await import('idb-keyval');
        const raw = await idbGet(projectStorageKey(p.id));
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        nodes = (parsed?.state?.nodes ?? []) as ThoughtNode[];
      } catch { continue; }
    }
    if (p.id !== activeId && !p.provenanceSessions) {
      const sids = [...new Set(nodes.map((n) => n.data.importSource?.sessionId).filter((x): x is string => !!x))];
      useProjects.setState((s) => ({
        projects: s.projects.map((q) => (q.id === p.id ? { ...q, provenanceSessions: sids } : q)),
      }));
    }
    const byFirstId = new Map<string, string>();
    for (const n of nodes) {
      if (n.data.importSource?.sessionId === sessionId && n.data.stepKind !== 'note') {
        const k = n.data.importSource.itemIds?.[0];
        if (k) byFirstId.set(k, n.id);
      }
    }
    if (byFirstId.size > 0) return { projectId: p.id, byFirstId };
  }
  return null;
}

/** How much of this canvas is one of a kind? Coverage is a RELATIONSHIP
 *  question: only nodes whose provenance matches the MAIN subscribed
 *  session count as rebuildable (recast rebuilds the main line only).
 *  Chapters, branches, foreign-provenance pastes, hand-made nodes and
 *  drifted text are all unique here — conservative on purpose. */
export type CanvasUniqueness = 'native' | 'pristine-mirror' | 'diverged-mirror';

export async function canvasUniqueness(projectId: string): Promise<CanvasUniqueness> {
  const { projects, activeId } = useProjects.getState();
  const meta = projects.find((p) => p.id === projectId);
  const subs = subscriptionsOf(meta);
  const main = subs.find((s) => s.role === 'main');
  if (!main) return subs.length ? 'diverged-mirror' : 'native';
  if (subs.length > 1) {
    return 'diverged-mirror'; // a multi-session composition is always unique
  }
  let nodes: ThoughtNode[];
  if (projectId === activeId) {
    nodes = useStore.getState().nodes;
  } else {
    const { get: idbGet } = await import('idb-keyval');
    const raw = await idbGet(projectStorageKey(projectId));
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      nodes = (parsed?.state?.nodes ?? []) as ThoughtNode[];
    } catch { return 'diverged-mirror'; } // unreadable — warn high, never low
  }
  const sid = main.sessionId;
  const mirror = nodes.filter((n) => n.data.importSource?.sessionId === sid);
  const diverged =
    nodes.some((n) => !n.data.importSource)
    || nodes.some((n) => n.data.importSource && n.data.importSource.sessionId !== sid)
    || mirror.filter((n) => n.data.source).length < takenCount(main)
    || mirror.some((n) => n.data.source && (n.data.question !== n.data.source.question || n.data.response !== n.data.source.response));
  return diverged ? 'diverged-mirror' : 'pristine-mirror';
}

export { subscribedSessionIds };

/** Deletion IS unsubscription. After nodes are removed, any subscribed
 *  session with no surviving mirror node on the ACTIVE canvas loses its
 *  ledger entry: listening stops, nothing regrows from a canvas the
 *  user just weeded. (Undo restores the nodes but not the entry — the
 *  toast points at the atlas, where reopening resubscribes.) */
export async function unsubscribeOrphanedSessions(): Promise<void> {
  // never judge a ledger before its canvas exists: boot hydration races
  // this call on startup, and an un-hydrated store reads as "zero
  // mirror nodes" — which once mass-unsubscribed healthy canvases.
  // After the await, an empty canvas is the truth, not an artifact.
  const { bootProjects } = await import('../../store/projects');
  await bootProjects();
  const { projects, activeId } = useProjects.getState();
  const meta = projects.find((p) => p.id === activeId);
  if (!meta) return;
  const subscribed = subscribedSessionIds(meta);
  if (subscribed.length === 0) return;
  const alive = new Set<string>();
  for (const n of useStore.getState().nodes) {
    const sid = n.data.importSource?.sessionId;
    if (sid) alive.add(sid);
    // a run waiting for its first turn holds its session too
    if (n.data.run?.sessionId) alive.add(n.data.run.sessionId);
  }
  const orphaned = subscribed.filter((sid) => !alive.has(sid));
  if (orphaned.length === 0) return;
  for (const sid of orphaned) await removeSubscription(meta.id, sid);
  // identity is announced, not implied: when the last subscription goes,
  // the canvas says out loud that it is native again
  const after = useProjects.getState().projects.find((p) => p.id === meta.id);
  const key = subscriptionsOf(after).length ? 'toast.unsubscribed' : 'toast.unsubscribedNative';
  toast('info', fmt(t(key), { n: orphaned.length }), 8000);
}

/** Curate several sessions onto ONE canvas. Every session mounts as an
 *  EQUAL chapter (empty-main container, no main line), laid out as
 *  side-by-side columns with NO cross-links: the sessions share no
 *  context, and a wire is context, so drawing one would be a lie — the
 *  joins are the curator's to wire. Each chapter keeps its own ledger
 *  entry, so every session listens and appends independently. Sessions
 *  already subscribed elsewhere are skipped (one session, one canvas). */
export async function mergeSessionsIntoProject(
  convs: (import('../import-chat').ImportableConversation | null)[],
  projectId?: string,
): Promise<{ mounted: number; skipped: number; projectId: string } | null> {
  const real = convs.filter((c): c is NonNullable<(typeof convs)[number]> => !!c && !!c.sessionId);
  if (real.length === 0) return null;
  const pid = projectId
    ?? await createProject(fmt(t('atlas.mergedName'), { title: real[0].title.slice(0, 24), n: real.length }));
  await switchProject(pid);
  useStore.getState().pushHistory();
  let mounted = 0, skipped = 0;
  for (const conv of real) {
    const sid = conv.sessionId!; // narrowed by the filter above
    if (findSubscription(sid)) { skipped++; continue; }
    const built = conv.build();
    if (built.nodes.length === 0) { skipped++; continue; }
    const qa = built.nodes.filter((n) => n.data.importSource);
    const cur = useStore.getState().nodes;
    const rightEdge = cur.reduce((acc, n) => Math.max(acc, n.position.x + (n.width ?? n.measured?.width ?? 540)), -Infinity);
    const topEdge = cur.reduce((acc, n) => Math.min(acc, n.position.y), Infinity);
    const chainLeft = Math.min(...built.nodes.map((n) => n.position.x));
    const chainTop = Math.min(...built.nodes.map((n) => n.position.y));
    const dx = (Number.isFinite(rightEdge) ? rightEdge + 180 : 0) - chainLeft;
    const dy = (Number.isFinite(topEdge) ? topEdge : 0) - chainTop;
    const moved = built.nodes.map((n): ThoughtNode => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }));
    const inSet = new Set(moved.map((n) => n.id));
    const innerEdges = built.edges.filter((e) => inSet.has(e.source) && inSet.has(e.target));
    useStore.setState((st) => ({ nodes: [...st.nodes, ...moved], edges: [...st.edges, ...innerEdges] }));
    await addSubscription(pid, {
      runner: conv.source, sessionId: sid, role: 'chapter', handled: legacyTaken(built, qa.length),
      tailNodeId: qa.filter((n) => !n.data.importSource?.subagent).at(-1)?.id ?? qa.at(-1)?.id ?? moved[moved.length - 1].id,
    });
    mounted++;
  }
  useStore.getState().pushHistory();
  const last = useStore.getState().nodes.at(-1);
  if (mounted > 0 && last) useUiStore.getState().setArrivalFocusNodeId(last.id);
  return { mounted, skipped, projectId: pid };
}
