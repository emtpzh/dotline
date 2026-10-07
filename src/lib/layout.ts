import type { ThoughtNode, ThoughtEdge } from '../types';
import { getDescendantIds } from './graph';
import { frameContains, frameMembers, frameRect, isFrameNode } from './frames';
import { COLLAPSED_LAYOUT_HEIGHT, LAYOUT_COL_WIDTH, LAYOUT_H_GAP, LAYOUT_V_GAP } from './constants';

/** Material + regions: user-arranged, never moved by any layout pass.
 *  Notes/files/links are content the user placed; a frame is a region rather
 *  than a card, so a card landing inside one is the point of a frame. */
const CONTENT_KINDS = new Set(['note', 'file', 'link', 'frame']);
const isContentKind = (node: ThoughtNode) => CONTENT_KINDS.has(node.data.stepKind ?? '');

// Estimated rendered height of a node — fallback when React Flow hasn't
// measured the DOM yet (fresh nodes) and for collapse shifting. Every
// variable region of the card is height-capped in CSS (question scrolls at
// 180px, the answer at 400px), so the estimate caps each part the same way
// — an uncapped formula here would keep spreading nodes for content the
// card no longer grows for.
export function estimateNodeHeight(node: ThoughtNode): number {
  if (node.data.isCollapsed) return COLLAPSED_LAYOUT_HEIGHT;
  // Calibrated against measured DOM heights (2026-08): CJK markdown renders
  // ~1px per char at card width before the 400px CSS cap; chrome (name row
  // + takeaway line + the answer's one action row + paddings) runs ~130px
  // since the follow-up box and the highlight row left the card (2026-10).
  // Under-estimating here is what made map-mode relayout overlap once
  // zoomed back in.
  const questionH = Math.min(180, 40 + (node.data.question || '').length / 1.2);
  const responseH = Math.min(400, (node.data.response || '').length / 1.05);
  const insightH = (node.data.attachments?.length ?? 0) > 0 ? 30 : 0;
  const estimated = 130 + questionH + responseH + insightH;
  return Math.max(260, Math.min(930, estimated));
}

// Height used for layout: the larger of the measured DOM height (React
// Flow's ResizeObserver writes `measured` back through onNodesChange) and
// the estimate. The max matters: while zoomed out, semantic zoom renders
// small thumbnail cards, so `measured` under-reports the full-size height —
// laying out with it would overlap once the user zooms back in. Slightly
// generous spacing beats overlapping cards.
export function nodeHeight(node: ThoughtNode): number {
  return Math.max(node.measured?.height ?? 0, estimateNodeHeight(node));
}

/** Rendered width of a card: React Flow's measurement when it has one, the
 *  author-declared width next (frames, file cards), the column width last. */
function cardWidth(node: ThoughtNode): number {
  return node.measured?.width ?? node.width ?? LAYOUT_COL_WIDTH;
}

/** Height a NEW card hangs from.
 *
 *  - A parent that was just collapsed still reports its expanded `measured`
 *    height for a render tick; hanging the child off that number would leave
 *    a canyon under the short card, so the estimate (which knows collapsed
 *    cards are short) wins there.
 *  - Material measures itself honestly — a document card has no answer, no
 *    follow-up box, none of the chrome the estimate budgets for, so its
 *    measured height is the truth and the estimate overshoots it by a
 *    couple of hundred pixels.
 *  - Everywhere else the measured DOM height is the truth. */
function hangHeight(node: ThoughtNode): number {
  if (node.data.isCollapsed) return estimateNodeHeight(node);
  const measured = node.measured?.height;
  if (measured && isContentKind(node)) return measured;
  return nodeHeight(node);
}

/** The smallest frame that owns `node` by frames.ts's rule, if any. */
function innermostFrameOf(node: ThoughtNode, allNodes: ThoughtNode[]): ThoughtNode | undefined {
  const area = (f: ThoughtNode) => frameRect(f).width * frameRect(f).height;
  return allNodes
    .filter((f) => isFrameNode(f) && frameMembers(f, [node]).length > 0)
    .sort((a, b) => area(a) - area(b))[0];
}

/**
 * Seat freshly created cards WITHOUT re-deriving the rest of the canvas.
 *
 * autoLayout is a pure re-derivation of the whole graph: right for the
 * one-click relayout and for reading an imported session, destructive as the
 * side effect of creating one node. A canvas whose cards were placed by hand
 * (the example) or dragged by the user jumped the moment a follow-up was
 * asked, and chains landed outside the chapter frames drawn around them.
 *
 * Making a node is a LOCAL gesture, so its placement is local too: the card
 * lands where the arrow grammar puts it relative to its parents — a
 * continuation directly below its parent in the parent's column, an explore
 * branch beside it, a chain grown from material below that material — and it
 * steps sideways only far enough to not sit on top of a card that is already
 * there. Everything else stays exactly where it was left; the global reflow
 * stays where it belongs, behind the relayout button.
 *
 * Several ids are seated in order, each seeing the ones before it, so a batch
 * (a fan-out) spreads into consecutive columns instead of stacking.
 *
 * A card seated for a chapter stays that chapter's member. When the row and
 * the floor ran past a linked frame's edge, the frame grows right and down to
 * hold it (it never moves or shrinks), and so does every frame that held that
 * chapter — the promise autoLayout keeps by re-wrapping, kept without moving
 * anything.
 *
 * Returns the whole array; only the listed nodes' positions and the sizes of
 * the frames that had to grow change.
 */
export function placeNewNodes(allNodes: ThoughtNode[], allEdges: ThoughtEdge[], newNodeIds: string[]): ThoughtNode[] {
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const pending = newNodeIds.filter((id) => byId.has(id));
  if (pending.length === 0) return allNodes;

  const pos = new Map(allNodes.map((n) => [n.id, { ...n.position }]));
  // Siblings not seated yet are not obstacles — but ones already seated are,
  // or a fan-out would land every card on the same spot.
  const unseated = new Set(pending);
  const seated = new Set<string>();
  const V_PAD = 24;
  const H_GAP = LAYOUT_H_GAP;

  // Frames as this batch has left them: a later card sees an earlier one's growth.
  const grown = new Map<string, { width: number; height: number }>();
  const liveFrame = (f: ThoughtNode): ThoughtNode => {
    const g = grown.get(f.id);
    return g ? { ...f, width: g.width, height: g.height, measured: { ...g } } : f;
  };
  const liveFrames = () => allNodes.filter(isFrameNode).map(liveFrame);
  const growToHold = (frame: ThoughtNode, r: { x: number; y: number; width: number; height: number }, pad: number) => {
    if (frame.data.frameCarry === false) return;
    const fr = frameRect(liveFrame(frame));
    if (r.x + r.width <= fr.x + fr.width && r.y + r.height <= fr.y + fr.height) return;
    const outers = liveFrames().filter((o) => o.id !== frame.id && frameContains(frameRect(o), fr));
    const width = Math.max(fr.width, Math.ceil(r.x + r.width + pad - fr.x));
    const height = Math.max(fr.height, Math.ceil(r.y + r.height + pad - fr.y));
    grown.set(frame.id, { width, height });
    for (const outer of outers) growToHold(outer, { x: fr.x, y: fr.y, width, height }, FRAME_NESTING_GAP);
  };

  for (const id of pending) {
    const node = byId.get(id)!;
    unseated.delete(id);
    // Material is placed by the gesture that creates it (a drop point, the
    // reader pane); no layout pass has ever moved it and this one doesn't.
    if (isContentKind(node)) continue;

    const w = cardWidth(node);
    const h = estimateNodeHeight(node);
    const obstacles = allNodes
      .filter((n) => n.id !== id && !unseated.has(n.id) && n.data.stepKind !== 'frame')
      .map((n) => ({ x: pos.get(n.id)!.x, y: pos.get(n.id)!.y, w: cardWidth(n), h: hangHeight(n) }));
    const hits = (x: number, y: number) => obstacles.filter((r) =>
      x < r.x + r.w && x + w > r.x && y < r.y + r.h + V_PAD && y + h + V_PAD > r.y);

    // The wires that make this card hang where it hangs. Dashed references
    // are not parentage — unless a reference is the ONLY thing pointing here
    // (its original edge was deleted and redrawn), which is exactly the case
    // autoLayout adopts as parent.
    const incoming = allEdges.filter((e) => e.target === id);
    const structural = incoming.filter((e) => !e.data?.isCrossLink);
    const wires = (structural.length ? structural : incoming)
      .map((e) => ({ e, p: byId.get(e.source) }))
      .filter((w): w is { e: ThoughtEdge; p: ThoughtNode } => !!w.p && w.p.id !== id);
    // The parent the card hangs from: a plain wire wins over an explore wire,
    // the same way autoLayout picks the claimant — being explored out of one
    // parent doesn't stop a card continuing from another. The card is a
    // BRANCH only with respect to the parent it hangs from.
    const baseWire = wires.find((w) => !w.e.data?.isBranchFromSelection) ?? wires[0];
    const base = baseWire?.p;
    const isBranch = !!baseWire?.e.data?.isBranchFromSelection;

    // Slide right past whatever the card lands ON, column by column, sizing
    // each step to the cards actually in the way — a hand-arranged canvas has
    // no uniform grid to march along. First free slot wins. `limit` is the
    // chapter frame's right edge: a slot past it means leaving the chapter,
    // which the caller handles differently (null). The guard is only there for
    // a canvas so packed that nothing is ever free.
    const slideRight = (from: number, y: number, limit: number): number | null => {
      let cx = from;
      for (let guard = 0; guard <= obstacles.length + 2; guard++) {
        const blocked = hits(cx, y);
        if (blocked.length === 0) return cx;
        const next = Math.max(...blocked.map((r) => r.x + r.w)) + H_GAP;
        if (next + w > limit) return null;
        cx = next;
      }
      return null;
    };

    let x: number;
    let y: number;
    let chapter: ThoughtNode | undefined;
    if (!base) {
      // A root question: the next free column on the right, on the top row.
      // Frames are regions, and cards still waiting for a seat don't exist yet.
      const cards = allNodes.filter((n) => n.id !== id && !unseated.has(n.id) && n.data.stepKind !== 'frame');
      x = cards.length
        ? Math.max(...cards.map((n) => pos.get(n.id)!.x + cardWidth(n))) + LAYOUT_H_GAP
        : 0;
      y = cards.length ? Math.min(...cards.map((n) => pos.get(n.id)!.y)) : 0;
    } else {
      const basePos = pos.get(base.id)!;
      const baseH = hangHeight(base);
      if (isBranch) {
        // Explore branch: beside its parent, out of the parent's side handle.
        y = basePos.y + baseH * 0.25;
      } else {
        // Continuation: the next link of the column, clearing every parent it
        // reads (a material parent is simply the top of the chain). A parent
        // it was only EXPLORED out of is meant to stand beside it, so that one
        // is owed its top edge and no more.
        y = Math.max(...wires.map(({ e, p }) => {
          const pp = pos.get(p.id)!;
          return e.data?.isBranchFromSelection ? pp.y : pp.y + hangHeight(p) + LAYOUT_V_GAP;
        }));
      }
      // A chapter frame is a promise about what belongs together: a card
      // asked inside one is seated inside it, or not beside the chain at all.
      // Which frame the parent is in follows the one membership rule dragging
      // and autoLayout share (frames.ts, by centre); nested, the innermost wins.
      chapter = innermostFrameOf({ ...base, position: basePos }, liveFrames());
      const limit = chapter ? frameRect(chapter).x + frameRect(chapter).width : Infinity;

      // A card already hanging below the parent in its own column makes the
      // new one an ALTERNATIVE answer: it starts beside the chain, never in
      // the gap, where the parent's own arrow would run straight through it.
      let beside = basePos.x;
      if (!isBranch) {
        for (const r of obstacles) {
          if (Math.abs(r.x - basePos.x) < 1 && r.y > basePos.y + 1) beside = Math.max(beside, r.x + r.w + H_GAP);
        }
      }

      const slot = slideRight(beside, y, limit);
      if (slot !== null) {
        x = slot;
      } else {
        // The chapter is out of room on this row: take the floor under the
        // parent's own column. The card stays in its chapter, next to the
        // parent it was asked from, instead of being flung past every other
        // chapter in the room.
        x = basePos.x;
        y = Math.max(basePos.y + baseH,
          ...obstacles.filter((r) => Math.abs(r.x - basePos.x) < 1).map((r) => r.y + r.h)) + LAYOUT_V_GAP;
        x = slideRight(x, y, Infinity) ?? x;
      }
    }
    pos.set(id, { x, y });
    seated.add(id);
    if (chapter) growToHold(chapter, { x, y, width: w, height: h }, FRAME_SIDE_PADDING);
  }

  if (seated.size === 0) return allNodes;
  return allNodes.map((n) => {
    if (seated.has(n.id)) return { ...n, position: pos.get(n.id)! };
    const g = grown.get(n.id);
    // `measured` goes with it, so frameRect reads the new size before React Flow re-measures
    return g ? { ...n, width: g.width, height: g.height, ...(n.measured ? { measured: { ...g } } : {}) } : n;
  });
}

/**
 * Re-seat one card and everything that grows OUT of it, after the graph
 * itself changed under it (a dashed reference promoted to a real wire, so the
 * card now continues from a new parent).
 *
 * This is the graph's own re-derivation, scoped: the affected chain obeys the
 * arrow grammar again, and every other card on the canvas keeps the
 * arrangement the user gave it. Material ends the walk — a note or a document
 * is never moved, so the chain hanging off it is none of this function's
 * business either.
 *
 * Order is breadth-first, parents before children, so each card is measured
 * against parents that have already landed.
 */
export function reseatSubtree(allNodes: ThoughtNode[], allEdges: ThoughtEdge[], nodeId: string): ThoughtNode[] {
  const node = allNodes.find((n) => n.id === nodeId);
  if (!node || isContentKind(node)) return allNodes;

  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const e of allEdges) {
    if (e.data?.isCrossLink) continue;
    children.set(e.source, [...(children.get(e.source) ?? []), e.target]);
  }

  const order: string[] = [];
  const seen = new Set([nodeId]);
  let frontier = [nodeId];
  while (frontier.length > 0) {
    order.push(...frontier);
    const next: string[] = [];
    for (const id of frontier) {
      const current = byId.get(id);
      if (!current || isContentKind(current)) continue;
      for (const c of children.get(id) ?? []) {
        if (!seen.has(c)) { seen.add(c); next.push(c); }
      }
    }
    frontier = next;
  }
  return placeNewNodes(allNodes, allEdges, order);
}

/**
 * Column-Tree layout with collision resolution.
 *
 * Pass 1 — Column assignment:
 *   - Each continuation chain (first non-branch child) inherits the parent's column.
 *   - Additional children (explore / duplicate / distill / regenerate siblings)
 *     are assigned to the next available column to the right.
 *   - Multiple roots each get their own column group.
 *
 * Pass 2 — Vertical positioning:
 *   - Within a column, nodes are placed top-to-bottom in chain order.
 *   - A branch child's y aligns with (or slightly below) its parent's y.
 *
 * Pass 3 — Collision detection & nudge:
 *   - Sort all nodes by y, then by column.
 *   - Any overlap (bbox intersection + padding) pushes the lower node down.
 *   - Iterates until stable (max 5 passes).
 */
/** Legacy mirrors (imported before importer notes became annotations)
 *  wired notes INTO the chain — prev→note→turn — which severs the chain
 *  for layout and no relayout can fix it. Heal the wiring: incoming
 *  edges of a provenance-stamped note re-aim at the turn it annotates,
 *  the note keeps only its outgoing annotation edge. Idempotent; user
 *  notes (no provenance) are untouched. */
export function healLegacyNoteEdges(nodes: ThoughtNode[], edges: ThoughtEdge[]): ThoughtEdge[] {
  const legacy = nodes.filter((n) => n.data.stepKind === 'note' && n.data.importSource
    && edges.some((e) => e.target === n.id));
  if (legacy.length === 0) return edges;
  let out = [...edges];
  for (const note of legacy) {
    const incoming = out.filter((e) => e.target === note.id);
    const onward = out.find((e) => e.source === note.id);
    out = out.filter((e) => e.target !== note.id);
    if (!onward) continue;
    for (const inc of incoming) {
      if (!out.some((e) => e.source === inc.source && e.target === onward.target)) {
        out.push({ ...inc, target: onward.target });
      }
    }
  }
  return out;
}

type FrameSnapshot = {
  id: string;
  memberIds: string[];
  rect: { x: number; y: number; width: number; height: number };
  nestingLevel: number;
};

const FRAME_SIDE_PADDING = 36;
const FRAME_TITLE_GAP = 44;
const FRAME_NESTING_GAP = 24;
const FRAME_MIN_WIDTH = 280;
const FRAME_MIN_HEIGHT = 180;

function snapshotLayoutFrames(allNodes: ThoughtNode[]): FrameSnapshot[] {
  const frames = allNodes.filter((n) => n.data.stepKind === 'frame' && n.data.frameCarry !== false);
  const snapshots = frames.map((frame) => {
    // Membership is the same rule dragging uses (lib/frames): ordinary nodes
    // by centre, and it is frozen here, before layout, so a node cannot switch
    // frames while it is being moved. Nested frames are not listed as members:
    // they are re-wrapped in their own right, inner to outer, below.
    const memberIds = frameMembers(frame, allNodes).filter((n) => !isFrameNode(n)).map((n) => n.id);
    return { id: frame.id, memberIds, rect: frameRect(frame), nestingLevel: 0 };
  });

  // nesting is full containment (also lib/frames) — the relation dragging
  // uses to carry one frame with another; partial overlap nests nothing
  const contains = (outer: FrameSnapshot, inner: FrameSnapshot) => outer.id !== inner.id && frameContains(outer.rect, inner.rect);

  // Level 0 is the innermost frame. Each enclosing layer gets more padding,
  // which keeps nested frame borders from collapsing onto the same edge.
  const memo = new Map<string, number>();
  const levelOf = (frame: FrameSnapshot): number => {
    const cached = memo.get(frame.id);
    if (cached !== undefined) return cached;
    const innerFrames = snapshots.filter((candidate) => contains(frame, candidate));
    const level = innerFrames.length === 0 ? 0 : 1 + Math.max(...innerFrames.map(levelOf));
    memo.set(frame.id, level);
    return level;
  };
  for (const snapshot of snapshots) snapshot.nestingLevel = levelOf(snapshot);
  return snapshots;
}

export function autoLayout(allNodes: ThoughtNode[], allEdges: ThoughtEdge[]): ThoughtNode[] {
  if (allNodes.length === 0) return allNodes;
  const frameSnapshots = snapshotLayoutFrames(allNodes);
  // Content nodes (notes / files) are user-arranged material: layout never
  // moves them and their edges don't shape the column tree. A node whose
  // only parent is a content node simply roots its own chain.
  const contentIds = new Set(allNodes.filter(isContentKind).map((n) => n.id));
  const nodes = allNodes.filter((n) => !contentIds.has(n.id));
  const edges = allEdges.filter((e) => !contentIds.has(e.source) && !contentIds.has(e.target));

  const NODE_WIDTH = LAYOUT_COL_WIDTH;
  const H_GAP = LAYOUT_H_GAP;
  const V_GAP = LAYOUT_V_GAP;
  const V_PAD = 24; // extra vertical padding for collision

  // --- Structural edges (no cross-links) ---
  // Structural edges drive the column tree. Cross-links normally don't —
  // BUT if a node's ONLY incoming edge is a cross-link (user deleted the
  // original edge and re-wired by dragging), that link IS its parent chain:
  // adopt it so the node still stacks below its arrow-parent instead of
  // being treated as a detached root. A wire that follows a thread's tip
  // (a reviewer's) is never adopted: it moves every time the thread grows.
  const structuralEdges = edges.filter((e) => !e.data?.isCrossLink);
  const hasStructuralParent = new Set(structuralEdges.map((e) => e.target));
  for (const e of edges) {
    if (e.data?.isCrossLink && !e.data?.isWatch && !e.data?.followsTip && !hasStructuralParent.has(e.target)) {
      structuralEdges.push(e);
      hasStructuralParent.add(e.target);
    }
  }
  const targetIds = new Set(structuralEdges.map((e) => e.target));
  const roots = nodes.filter((n) => !targetIds.has(n.id));

  const structuralParents = new Map<string, string[]>();
  for (const e of structuralEdges) {
    const list = structuralParents.get(e.target) || [];
    list.push(e.source);
    structuralParents.set(e.target, list);
  }

  // ── Material anchors ──
  // Layout never moves content nodes, but chains GROWN FROM them must obey
  // the arrow grammar: the child starts BELOW its material, roughly under
  // it — not at the canvas top as a free root. (Fixes questions asked from
  // the reader appearing above their file node.)
  const materialAnchors = new Map<string, { x: number; y: number }>();
  const perMaterialCount = new Map<string, number>();
  for (const root of roots) {
    const mats = allEdges
      .filter((e) => e.target === root.id && !e.data?.isCrossLink && contentIds.has(e.source))
      .map((e) => allNodes.find((n) => n.id === e.source))
      .filter((m): m is ThoughtNode => !!m);
    if (mats.length === 0) continue;
    // The chain starts below the LOWEST material, or it collides with the one
    // that hangs furthest down; it takes that same card's x, so the chain
    // hangs from one document and reads as a line rather than floating at the
    // centroid of a row of papers (tried once, #20).
    const lowest = mats.reduce((a, b) =>
      a.position.y + nodeHeight(a) > b.position.y + nodeHeight(b) ? a : b);
    const k = perMaterialCount.get(lowest.id) ?? 0;
    perMaterialCount.set(lowest.id, k + 1);
    materialAnchors.set(root.id, {
      x: lowest.position.x - 60 + k * (LAYOUT_COL_WIDTH + LAYOUT_H_GAP),
      y: lowest.position.y + nodeHeight(lowest) + LAYOUT_V_GAP,
    });
  }

  const childrenMap = new Map<string, string[]>();
  for (const edge of structuralEdges) {
    const list = childrenMap.get(edge.source) || [];
    list.push(edge.target);
    childrenMap.set(edge.source, list);
  }

  // Being explored out is a property of the EDGE, not of the node: a node can
  // be explored out of one parent and continue plainly from another, and to
  // that second parent it is an ordinary continuation.
  const edgeKey = (parent: string, child: string) => `${parent}\u0000${child}`;
  const exploreEdges = new Set(
    edges
      .filter((e) => e.data?.isBranchFromSelection)
      .map((e) => edgeKey(e.source, e.target))
  );

  // Classify children into 3 types:
  // 1. Continuation — first non-explore child, inherits parent column
  // 2. Regenerate siblings — other non-explore children, columns adjacent to parent
  // 3. Explore branches — explored out of THIS parent, columns further out
  function classifyChildren(parentId: string, claimant: Map<string, string>): {
    continuation: string | null;
    regenerates: string[];
    explores: string[];
  } {
    // A merge is laid out by one parent only; the others still draw their
    // arrow to it, they just no longer decide where it sits.
    const children = (childrenMap.get(parentId) || []).filter(
      (c) => (claimant.get(c) ?? parentId) === parentId
    );
    const nonExplore = children.filter((c) => !exploreEdges.has(edgeKey(parentId, c)));
    const explores = children.filter((c) => exploreEdges.has(edgeKey(parentId, c)));
    return {
      continuation: nonExplore[0] ?? null,
      regenerates: nonExplore.slice(1),
      explores,
    };
  }

  // --- Pass 1: Assign columns ---
  // Anchored chains live in VIRTUAL columns pinned to their material's x —
  // the grid formula never sees them, collision grouping still does.
  const VIRT_BASE = 100000;

  function assignAllColumns(claimant: Map<string, string>) {
    const nodeColumn = new Map<string, number>();
    let nextColumn = 0;
    let nextVirt = VIRT_BASE;
    const colXOverride = new Map<number, number>();
    const colX = (col: number) => colXOverride.get(col) ?? col * (NODE_WIDTH + H_GAP);

    function assignColumns(nodeId: string, col: number) {
      if (nodeColumn.has(nodeId)) return;
      nodeColumn.set(nodeId, col);

      const { continuation, regenerates, explores } = classifyChildren(nodeId, claimant);

      if (continuation) assignColumns(continuation, col);

      // Regenerate siblings: columns immediately adjacent (col+1, col+2, ...).
      // On an ANCHORED chain (virtual column) the sibling must take a fresh
      // virtual column pinned beside the chain — arithmetic on a virtual
      // column id would land in the grid formula at x ≈ 62 million, and
      // feeding it into nextColumn would catapult every later root after it.
      for (let i = 0; i < regenerates.length; i++) {
        let regenCol: number;
        if (col >= VIRT_BASE) {
          regenCol = nextVirt++;
          colXOverride.set(regenCol, colX(col) + (i + 1) * (NODE_WIDTH + H_GAP));
        } else {
          regenCol = col + 1 + i;
          nextColumn = Math.max(nextColumn, regenCol + 1);
        }
        assignColumns(regenerates[i], regenCol);
      }

      // Explore branches: after all regenerate columns (anchored chains keep
      // them beside the chain too, past the sibling columns)
      let exploreOffset = 0;
      for (const ec of explores) {
        let exploreCol: number;
        if (col >= VIRT_BASE) {
          exploreCol = nextVirt++;
          colXOverride.set(exploreCol, colX(col) + (regenerates.length + 1 + exploreOffset) * (NODE_WIDTH + H_GAP));
          exploreOffset++;
        } else {
          exploreCol = nextColumn;
          nextColumn++;
        }
        assignColumns(ec, exploreCol);
      }
    }

    for (const root of roots) {
      const anchor = materialAnchors.get(root.id);
      if (anchor) {
        const virtCol = nextVirt++;
        colXOverride.set(virtCol, anchor.x);
        assignColumns(root.id, virtCol);
      } else {
        const rootCol = nextColumn;
        nextColumn++;
        assignColumns(root.id, rootCol);
      }
    }

    // A claimant sitting on a chain the walk never reaches would strand the
    // merge with no column at all. Fall back to the median parent that DID get
    // one, and repeat: placing one merge can unlock another below it.
    for (let guard = 0; guard < nodes.length; guard++) {
      let progressed = false;
      for (const node of nodes) {
        if (nodeColumn.has(node.id)) continue;
        const cols = (structuralParents.get(node.id) || [])
          .map((p) => nodeColumn.get(p))
          .filter((c): c is number => c !== undefined)
          .sort((a, b) => a - b);
        if (!cols.length) continue;
        assignColumns(node.id, cols[Math.floor((cols.length - 1) / 2)]);
        progressed = true;
      }
      if (!progressed) break;
    }

    return { nodeColumn, colX };
  }

  // ── Which parent owns a merge ──
  // A conversation has a main line. A node with several parents sits under
  // the parent it was CONTINUED from — the source of the first structural
  // edge that reached it, which is the order a person wires things: the
  // follow-up is asked from one node, the other sources are connected after.
  // Centring the node among its parents (tried once, #20) reads well as a
  // picture and badly as a conversation: the main line vanishes into the
  // middle. Edge order is stable under any permutation of the node array, so
  // the same graph lays out the same way however it arrives. Only a parent the
  // node continues from may own it; one that explored it out stands beside it.
  const claimant = new Map<string, string>();
  for (const [child, ps] of structuralParents) {
    if (ps.length < 2) continue;
    const continued = ps.filter((p) => !exploreEdges.has(edgeKey(p, child)));
    const pool = continued.length ? continued : ps;
    claimant.set(child, pool[0]);
  }
  const { nodeColumn, colX } = assignAllColumns(claimant);

  // --- Pass 2: Vertical positioning ---
  const nodeHeightMap = new Map<string, number>();
  for (const node of nodes) {
    nodeHeightMap.set(node.id, nodeHeight(node));
  }

  const positioned = new Map<string, { x: number; y: number }>();

  // BFS in topological order to assign y
  const visited = new Set<string>();
  const queue: string[] = [...roots.map((r) => r.id)];

  // Roots start at y=0; material-anchored roots start under their material
  for (const rootId of queue) {
    const col = nodeColumn.get(rootId) ?? 0;
    const anchor = materialAnchors.get(rootId);
    positioned.set(rootId, { x: colX(col), y: anchor?.y ?? 0 });
    visited.add(rootId);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const parentPos = positioned.get(current)!;
    const parentHeight = nodeHeightMap.get(current) || 220;

    const { continuation, regenerates, explores } = classifyChildren(current, claimant);

    if (continuation && !visited.has(continuation)) {
      visited.add(continuation);
      const col = nodeColumn.get(continuation) ?? 0;
      positioned.set(continuation, {
        x: colX(col),
        y: parentPos.y + parentHeight + V_GAP,
      });
      queue.push(continuation);
    }

    // Regenerate siblings: same y as continuation (they're alternative answers)
    const continuationY = parentPos.y + parentHeight + V_GAP;
    for (const rc of regenerates) {
      if (visited.has(rc)) continue;
      visited.add(rc);
      const col = nodeColumn.get(rc) ?? 0;
      positioned.set(rc, {
        x: colX(col),
        y: continuationY,
      });
      queue.push(rc);
    }

    // Explore branches: start at parent's y (slight offset for visible edge)
    for (const ec of explores) {
      if (visited.has(ec)) continue;
      visited.add(ec);
      const col = nodeColumn.get(ec) ?? 0;
      positioned.set(ec, {
        x: colX(col),
        y: parentPos.y + parentHeight * 0.25,
      });
      queue.push(ec);
    }
  }

  // Same story for y: a merge reached only through its claimant may still be
  // unplaced. Sit it below the lowest parent that was placed, so the arrow
  // keeps pointing downward instead of the node collapsing to the origin.
  for (let guard = 0; guard < nodes.length; guard++) {
    let progressed = false;
    for (const node of nodes) {
      if (positioned.has(node.id)) continue;
      const ps = (structuralParents.get(node.id) || []).filter((p) => positioned.has(p));
      if (!ps.length) continue;
      const bottom = Math.max(
        ...ps.map((p) => positioned.get(p)!.y + (nodeHeightMap.get(p) || 220))
      );
      positioned.set(node.id, { x: colX(nodeColumn.get(node.id) ?? 0), y: bottom + V_GAP });
      progressed = true;
    }
    if (!progressed) break;
  }

  // Handle any orphan nodes (shouldn't happen, but safety)
  for (const node of nodes) {
    if (!positioned.has(node.id)) {
      positioned.set(node.id, { x: 0, y: 0 });
    }
  }

  // ── A merge clears every parent it reads ──
  // Pass 2 hands a node its y from the single parent that walked to it, so a
  // synthesis could sit level with — or above — the other sources feeding it
  // and the arrow pointed back up the canvas. Whichever parent is chosen, the
  // node belongs below the LOWEST one. Only merges need this (a single-parent
  // chain is already correct by construction), and explore branches are
  // exempt: they are meant to sit alongside their parent, not beneath it.
  for (let pass = 0; pass < 5; pass++) {
    let moved = false;
    for (const node of nodes) {
      const pos = positioned.get(node.id);
      if (!pos) continue;
      const all = (structuralParents.get(node.id) || []).filter((p) => positioned.has(p));
      if (all.length < 2) continue;
      // Two rules, one for each kind of arrow into this node. A parent it
      // CONTINUES from must be cleared entirely. A parent that EXPLORED it out
      // is meant to stand beside it — no clearance owed, but the child must
      // still never float above that parent's top edge.
      const continued = all.filter((p) => !exploreEdges.has(`${p}\u0000${node.id}`));
      const explored = all.filter((p) => exploreEdges.has(`${p}\u0000${node.id}`));
      let floor = -Infinity;
      for (const p of continued) {
        floor = Math.max(floor, positioned.get(p)!.y + (nodeHeightMap.get(p) || 220) + V_GAP);
      }
      for (const p of explored) {
        floor = Math.max(floor, positioned.get(p)!.y);
      }
      if (floor > -Infinity && pos.y < floor) {
        const delta = floor - pos.y;
        pos.y = floor;
        // The whole subtree travels with it, not only the part sharing this
        // column. An explore branch is given a column of its own, so a
        // column-restricted shift left it where it was and the child came to
        // rest above the parent that spawned it. Dedupe first: a descendant
        // reachable by two paths must not be moved twice.
        for (const dId of new Set(getDescendantIds(node.id, structuralEdges))) {
          const dPos = positioned.get(dId);
          if (dPos) dPos.y += delta;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  // --- Pass 3: Collision resolution ---
  // Group nodes by column, sort by y within each column, push down overlaps
  const columnNodes = new Map<number, string[]>();
  for (const node of nodes) {
    const col = nodeColumn.get(node.id) ?? 0;
    const list = columnNodes.get(col) || [];
    list.push(node.id);
    columnNodes.set(col, list);
  }

  for (let pass = 0; pass < 5; pass++) {
    let moved = false;

    for (const [, colNodeIds] of columnNodes) {
      // Sort by current y
      colNodeIds.sort((a, b) => (positioned.get(a)!.y) - (positioned.get(b)!.y));

      for (let i = 1; i < colNodeIds.length; i++) {
        const prevId = colNodeIds[i - 1];
        const currId = colNodeIds[i];
        const prevPos = positioned.get(prevId)!;
        const currPos = positioned.get(currId)!;
        const prevHeight = nodeHeightMap.get(prevId) || 220;

        const minY = prevPos.y + prevHeight + V_PAD;
        if (currPos.y < minY) {
          const delta = minY - currPos.y;
          currPos.y = minY;
          moved = true;

          // Push all descendants down too. Not only the ones sharing this
          // column: an explore branch is given a column of its own, and
          // leaving it behind stranded a child above the parent it came from.
          // Dedupe — a descendant reachable by two paths moves once.
          for (const dId of new Set(getDescendantIds(currId, structuralEdges))) {
            const dPos = positioned.get(dId);
            if (dPos) dPos.y += delta;
          }
        }
      }
    }

    if (!moved) break;
  }

  // --- Pass 4: Serpentine fold ---
  // A pure PATH component (every node ≤1 structural child — the shape of
  // an imported session chain) taller than FOLD_HEIGHT wraps into
  // newspaper columns: within a column order and vertical alignment hold
  // (the layout law, extended, not broken — folding a line is not
  // shuffling its words), columns advance in reading order, and
  // zoom-to-fit sees a page instead of a hair. Folding only happens when
  // nothing else occupies the space to the right — a canvas with branches
  // or side material keeps its tall single line rather than colliding.
  // Fold points PREFER chapter boundaries: past 60% of the column budget,
  // a turn annotated by an importer note (compaction) starts a new column,
  // so chapters and columns tend to coincide.
  const FOLD_HEIGHT = 8000;
  const FOLD_COL_GAP = 180; // folded columns breathe wider than branch columns
  // importer-owned notes (provenance-stamped) annotate turns via an edge;
  // those targets are the preferred fold points
  const importerNotes = allNodes.filter((n) => n.data.stepKind === 'note' && n.data.importSource);
  const noteTargets = new Set(
    allEdges.filter((e) => importerNotes.some((n) => n.id === e.source)).map((e) => e.target)
  );
  for (const root of roots) {
    const chain: string[] = [];
    let cur: string | undefined = root.id;
    let pure = true;
    while (cur) {
      chain.push(cur);
      const kids: string[] = childrenMap.get(cur) || [];
      if (kids.length > 1) { pure = false; break; }
      cur = kids[0];
    }
    if (!pure || chain.length < 8) continue;
    const chainSet = new Set(chain);
    const first = positioned.get(chain[0])!;
    const lastId = chain[chain.length - 1];
    const totalH = positioned.get(lastId)!.y + (nodeHeightMap.get(lastId) || 220) - first.y;
    if (totalH <= FOLD_HEIGHT) continue;
    const rightOccupied = nodes.some((n) => !chainSet.has(n.id) && positioned.get(n.id)!.x > first.x + NODE_WIDTH / 2);
    if (rightOccupied) continue;
    let foldCol = 0;
    let y = first.y;
    for (const id of chain) {
      const h = nodeHeightMap.get(id) || 220;
      const used = y - first.y;
      const mustFold = used + h > FOLD_HEIGHT;
      const chapterFold = noteTargets.has(id) && used > FOLD_HEIGHT * 0.6;
      if ((mustFold || chapterFold) && y !== first.y) { foldCol++; y = first.y; }
      const p = positioned.get(id)!;
      p.x = first.x + foldCol * (NODE_WIDTH + FOLD_COL_GAP);
      p.y = y;
      y += h + V_GAP;
    }
  }

  // --- Pass 5: Importer-note placement ---
  // The layout law, refined: USER content (notes, files, frames the user
  // arranged) is never moved — but importer-OWNED notes (provenance-
  // stamped) are the mirror's own annotations, and the mirror may re-seat
  // them on every relayout. Preference order: the gutter left of the turn
  // they annotate → directly above it (a chapter heading when the turn
  // opens a folded column) → stacked above the column top.
  const solidRects = nodes.map((n) => {
    const p = positioned.get(n.id)!;
    return { x: p.x, y: p.y, w: NODE_WIDTH, h: nodeHeightMap.get(n.id) || 220 };
  });
  const NOTE_W = 460;
  const NOTE_H = 130;
  const collides = (x: number, y: number) =>
    solidRects.some((r) => x < r.x + r.w && x + NOTE_W > r.x && y < r.y + r.h && y + NOTE_H > r.y);
  const colTopStacks = new Map<number, number>();
  for (const note of importerNotes) {
    const targetId = allEdges.find((e) => e.source === note.id)?.target;
    const tp = targetId ? positioned.get(targetId) : undefined;
    if (!tp) continue;
    let x = tp.x - 520;
    let y = tp.y;
    if (collides(x, y)) { x = tp.x; y = tp.y - NOTE_H - 40; }
    if (collides(x, y)) {
      const colKey = Math.round(tp.x);
      const colMinY = Math.min(...nodes.filter((n) => Math.round(positioned.get(n.id)!.x) === colKey).map((n) => positioned.get(n.id)!.y));
      const k = colTopStacks.get(colKey) ?? 0;
      colTopStacks.set(colKey, k + 1);
      x = tp.x;
      y = colMinY - NOTE_H - 40 - k * (NOTE_H + 30);
    }
    positioned.set(note.id, { x, y });
  }

  // --- Pass 6: Frame follow-up ---
  // Frames are not part of the column tree. Instead, linked frames snapshot
  // their members before layout and re-wrap those same members afterwards.
  // This preserves the conversation layout law while keeping spatial regions
  // attached to the nodes the user grouped.
  const frameLayouts = new Map<string, { position: { x: number; y: number }; width: number; height: number }>();
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  const contentKinds = new Set(['note', 'file', 'link']);
  const snapshotsInnerToOuter = [...frameSnapshots].sort((a, b) => a.nestingLevel - b.nestingLevel);

  for (const frame of snapshotsInnerToOuter) {
    if (frame.memberIds.length === 0) continue;
    const rects = frame.memberIds
      .map((id) => {
        const node = nodeById.get(id);
        if (!node) return null;
        const position = positioned.get(id) ?? node.position;
        const width = node.measured?.width ?? node.width ?? LAYOUT_COL_WIDTH;
        const height = contentKinds.has(node.data.stepKind ?? '')
          ? (node.measured?.height ?? node.height ?? 120)
          : Math.max(node.measured?.height ?? 0, node.height ?? 0, nodeHeight(node));
        return { x: position.x, y: position.y, width, height };
      })
      .filter((r): r is { x: number; y: number; width: number; height: number } => r !== null);
    if (rects.length === 0) continue;

    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.width));
    const maxY = Math.max(...rects.map((r) => r.y + r.height));
    const sidePadding = FRAME_SIDE_PADDING + frame.nestingLevel * FRAME_NESTING_GAP;
    const topPadding = sidePadding + FRAME_TITLE_GAP;
    const x = minX - sidePadding;
    const y = minY - topPadding;
    const width = Math.max(FRAME_MIN_WIDTH, maxX - minX + sidePadding * 2);
    const height = Math.max(FRAME_MIN_HEIGHT, maxY - minY + topPadding + sidePadding);
    frameLayouts.set(frame.id, { position: { x, y }, width, height });
  }

  return allNodes.map((node) => {
    const frameLayout = frameLayouts.get(node.id);
    if (frameLayout) return { ...node, ...frameLayout };
    const pos = positioned.get(node.id);
    return pos ? { ...node, position: pos } : node;
  });
}
