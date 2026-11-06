import { useEffect, useMemo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { useStore } from '../store';
import { obstacleField, onCardBorder, routeEdge } from '../lib/edge-path';
import { walkUpAncestors } from '../lib/graph';
import { referenceBlockContent } from '../store/context-builder';
import { countTokens } from '../utils';
import { useT, fmt } from '../i18n';
import type { ThoughtEdge, ThoughtNode } from '../types';
import { Button } from './ui/button';
import { sessionWhy } from '../lib/session-why';
import { reducedMotion } from '../lib/motion';
import { spawnOf, WIRE_MS } from '../lib/spawn-motion';

// Lookups every wire shares, built once per store snapshot: each wire used to
// scan the whole nodes and edges arrays itself on every store write.
const nodeIndexes = new WeakMap<ThoughtNode[], Map<string, ThoughtNode>>();
function nodeIn(nodes: ThoughtNode[], id: string): ThoughtNode | undefined {
  let index = nodeIndexes.get(nodes);
  if (!index) {
    index = new Map();
    for (const n of nodes) if (!index.has(n.id)) index.set(n.id, n);
    nodeIndexes.set(nodes, index);
  }
  return index.get(id);
}

const mergeOrders = new WeakMap<ThoughtEdge[], Map<string, number>>();
/** Each merge input's place in its join's stated order. A card fed by a
 *  single solid wire is no merge: its wire has no place. */
function mergeOrder(edges: ThoughtEdge[]): Map<string, number> {
  const known = mergeOrders.get(edges);
  if (known) return known;
  const into = new Map<string, ThoughtEdge[]>();
  for (const e of edges) {
    if (e.data?.isCrossLink) continue;
    const siblings = into.get(e.target);
    if (siblings) siblings.push(e);
    else into.set(e.target, [e]);
  }
  const order = new Map<string, number>();
  for (const siblings of into.values()) {
    if (siblings.length < 2) continue;
    siblings.sort((a, b) => (a.data?.contextOrder ?? Number.MAX_SAFE_INTEGER) - (b.data?.contextOrder ?? Number.MAX_SAFE_INTEGER));
    siblings.forEach((e, i) => { if (!order.has(e.id)) order.set(e.id, i); });
  }
  mergeOrders.set(edges, order);
  return order;
}

/**
 * Custom edge registered under the 'smoothstep' type name (overrides the
 * built-in, so edges persisted before this component existed pick it up
 * with no migration). Renders as a bezier ARC with collision avoidance:
 * aligned nodes get a near-straight line, offset nodes a gentle curve,
 * and when the natural arc would cut through a card the path bends
 * sideways until it clears (see lib/edge-path). Click an edge to select
 * it — a delete button appears at its midpoint, and Delete/Backspace
 * removes it via App's key handler.
 */
export default function ThoughtEdgeView({
  id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, markerEnd, markerStart, selected, interactionWidth, data,
}: EdgeProps<ThoughtEdge>) {
  const deleteEdges = useStore((s) => s.deleteEdges);
  const setEdgeStructural = useStore((s) => s.setEdgeStructural);
  const t = useT();

  // The line kind IS the context weight: dashed = a reference block, solid
  // = full wiring (files included). Selected, the edge wears a chip that
  // prices and performs the conversion. Explored forks, wires that follow a
  // thread's tip and material wires keep their meaning and don't convert.
  // The render pipeline hands over what the edge means (lib/edge-look).
  const view = data?.view;
  const isRef = !!view?.reference;
  const convertible = isRef
    ? !data?.followsTip && !data?.isWatch
    : !!view && view.route !== 'material' && !data?.isBranchFromSelection;
  // The price reads the whole graph, so only the selected wire follows it:
  // the others don't re-render on every store write for a chip they lack.
  const priced = !!selected && convertible;
  const pricedNodes = useStore((s) => (priced ? s.nodes : null));
  const pricedEdges = useStore((s) => (priced ? s.edges : null));
  const refTok = useMemo(() => {
    const src = pricedNodes ? nodeIn(pricedNodes, source) : undefined;
    if (!pricedNodes || !pricedEdges || !src) return 0;
    // a reference block's price, as the source stands (solid: what the
    // summary would be after demotion — the edge itself leaves the chain)
    const structural = pricedEdges.filter((e) => !e.data?.isCrossLink && (isRef || e.id !== id));
    const chain = walkUpAncestors(source, pricedNodes, structural).ordered
      .filter((n) => n.id !== source && !['note', 'file', 'link'].includes(n.data.stepKind ?? ''));
    return countTokens(referenceBlockContent({ source: src, edge: { id, source, target, data } as ThoughtEdge, chain }));
  }, [pricedNodes, pricedEdges, isRef, source, target, id, data]);
  // Ends on the card borders (lib/edge-path onCardBorder): the line starts
  // tucked a pixel under its source, so it reads as growing out of it, and
  // the path stops short of the target by enough that the arrowhead, which
  // reaches a little past the path's end (EdgeMarkers), still clears the card.
  const srcBox = useInternalNode(source);
  const tgtBox = useInternalNode(target);
  const boxOf = (n: typeof srcBox) => n && n.measured.width && n.measured.height
    ? { ...n.internals.positionAbsolute, width: n.measured.width, height: n.measured.height }
    : null;
  const sBox = boxOf(srcBox), tBox = boxOf(tgtBox);
  const sp = sBox ? onCardBorder(sourceX, sourceY, sourcePosition, sBox, -1) : { x: sourceX, y: sourceY };
  const tp = tBox ? onCardBorder(targetX, targetY, targetPosition, tBox, 3.5) : { x: targetX, y: targetY };
  // Routing sees the cards as boxes only (lib/edge-path ObstacleField). The
  // field keeps its identity through writes that leave every box where it
  // was — streaming text into a card that has stopped growing, a selection —
  // so those writes re-route no wire.
  const field = useStore((s) => obstacleField(s.nodes));
  const { path, labelX, labelY } = useMemo(
    () => routeEdge(sp.x, sp.y, sourcePosition, tp.x, tp.y, targetPosition, source, target, field),
    [sp.x, sp.y, sourcePosition, tp.x, tp.y, targetPosition, source, target, field],
  );

  // When selected, force full visibility (overrides the ancestor-dim pass)
  // and thicken the stroke as selection feedback.
  const edgeStyle = selected ? { ...style, strokeWidth: 2.5, opacity: 1 } : style;

  // A wire into a card born a moment ago draws itself out of the parent
  // (lib/spawn-motion): a solid overlay grows along the path while the real
  // wire — arrowhead included — waits hidden, then takes over.
  const [drawDelay] = useState(() => {
    const s = reducedMotion() ? undefined : spawnOf(target);
    return s && s.from === source ? s.delay : null;
  });
  const [drawing, setDrawing] = useState(drawDelay !== null);
  useEffect(() => {
    if (drawDelay === null) return;
    const timer = setTimeout(() => setDrawing(false), drawDelay + WIRE_MS);
    return () => clearTimeout(timer);
  }, [drawDelay]);

  // A merge's incoming blocks have a stated order — show it AT the join,
  // where the question "which reads first?" is asked. Only merges wear
  // numbers; a single-parent edge needs none.
  const mergeIndex = useStore((s) => (isRef ? -1 : mergeOrder(s.edges).get(id) ?? -1));

  // The wire into a turn that left its agent session says why, where the
  // line leaves the column — when the wire is long enough to carry words;
  // the card's name row always says it too
  const roomy = Math.hypot(targetX - sourceX, targetY - sourceY) > 200;
  const labelled = roomy && !isRef && view?.route !== 'material';
  const link = useStore((s) => (labelled ? nodeIn(s.nodes, target)?.data.sessionLink : undefined));
  const why = useStore((s) => (link?.kind === 'new' ? sessionWhy(link, s.nodes, t) : ''));
  const linkText = link?.kind === 'new'
    ? fmt(t('session.newBadge'), { why })
    : link?.kind === 'fork' ? fmt(t('session.forkBadge'), { n: link.turn }) : null;

  return (
    <>
      <BaseEdge
        path={path}
        style={drawing ? { ...edgeStyle, opacity: 0 } : edgeStyle}
        markerEnd={markerEnd}
        markerStart={markerStart}
        interactionWidth={interactionWidth}
      />
      {drawing && (
        <path d={path} pathLength={1} className="tdag-draw"
          style={{ stroke: edgeStyle?.stroke ?? 'var(--edge-continue)', strokeWidth: edgeStyle?.strokeWidth ?? 1.75, animationDelay: `${drawDelay}ms` }} />
      )}
      {mergeIndex >= 0 && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              pointerEvents: 'none',
              transform: `translate(-50%, -50%) translate(${tp.x}px, ${tp.y - 22}px)`,
            }}
            data-merge-order={mergeIndex + 1}
          >
            <div className="w-4.5 h-4.5 min-w-[18px] px-0.5 rounded-full bg-card border border-border shadow-sm flex items-center justify-center text-2xs font-mono text-muted-foreground" style={{ fontSize: 10 }}>
              {mergeIndex + 1}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
      {view?.live && !isRef && (
        // A solid wire that runs on its own (it feeds a node that reruns
        // itself): bright dots gliding INSIDE the stroke, narrower than it,
        // so the line never reads as dashed — dashed is taken: references.
        // A dashed one flows by its own dashes (canvas.css .tdag-live).
        <path d={path} className="tdag-flow-ov" fill="none" />
      )}
      {linkText && !selected && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute max-w-[220px] truncate rounded-md border border-border bg-card px-1.5 py-px text-2xs text-muted-foreground shadow-sm"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            data-session-link-label={link!.kind}
          >
            {linkText}
          </div>
        </EdgeLabelRenderer>
      )}
      {selected && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              pointerEvents: 'all',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            <div className="flex items-center gap-1">
              {convertible && refTok > 0 && (
                <Button variant="outline" size="xs"
                  onClick={(e) => { e.stopPropagation(); setEdgeStructural(id, isRef); }}
                  className="shadow-md hover:border-primary/40 whitespace-nowrap"
                  title={isRef ? t('edge.depthToggleTitle') : t('edge.solidChipTitle')}
                >
                  {fmt(t(isRef ? 'edge.quoteChip' : 'edge.solidChip'), { n: refTok })}
                </Button>
              )}
              <Button variant="outline" size="icon-sm"
                onClick={(e) => { e.stopPropagation(); deleteEdges([id]); }}
                className="shadow-md hover:border-destructive/40"
                title={t('canvas.deleteEdgeTitle')}
              >
                <X strokeWidth={2} />
              </Button>
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
