import { useEffect, useMemo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { useStore } from '../store';
import { onCardBorder, routeEdge } from '../lib/edge-path';
import { walkUpAncestors } from '../lib/graph';
import { referenceBlockContent } from '../store/context-builder';
import { countTokens } from '../utils';
import { useT, fmt } from '../i18n';
import type { ThoughtEdge } from '../types';
import { Button } from './ui/button';
import { sessionWhy } from '../lib/session-why';
import { reducedMotion } from '../lib/motion';
import { spawnOf, WIRE_MS } from '../lib/spawn-motion';

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
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
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
  const src = nodes.find((n) => n.id === source);
  const refTok = useMemo(() => {
    if (!selected || !convertible || !src) return 0;
    // a reference block's price, as the source stands (solid: what the
    // summary would be after demotion — the edge itself leaves the chain)
    const structural = edges.filter((e) => !e.data?.isCrossLink && (isRef || e.id !== id));
    const chain = walkUpAncestors(source, nodes, structural).ordered
      .filter((n) => n.id !== source && !['note', 'file', 'link'].includes(n.data.stepKind ?? ''));
    return countTokens(referenceBlockContent({ source: src, edge: { id, source, target, data } as ThoughtEdge, chain }));
  }, [selected, convertible, isRef, source, target, id, nodes, edges, data, src]);
  // Ends on the card borders (lib/edge-path onCardBorder): the line starts
  // tucked a pixel under its source, so it reads as growing out of it, and
  // the arrow stops just short of the target, so the card never covers its tip.
  const srcBox = useInternalNode(source);
  const tgtBox = useInternalNode(target);
  const boxOf = (n: typeof srcBox) => n && n.measured.width && n.measured.height
    ? { ...n.internals.positionAbsolute, width: n.measured.width, height: n.measured.height }
    : null;
  const sBox = boxOf(srcBox), tBox = boxOf(tgtBox);
  const sp = sBox ? onCardBorder(sourceX, sourceY, sourcePosition, sBox, -1) : { x: sourceX, y: sourceY };
  const tp = tBox ? onCardBorder(targetX, targetY, targetPosition, tBox, 2) : { x: targetX, y: targetY };
  const { path, labelX, labelY } = useMemo(
    () => routeEdge(sp.x, sp.y, sourcePosition, tp.x, tp.y, targetPosition, source, target, nodes),
    [sp.x, sp.y, sourcePosition, tp.x, tp.y, targetPosition, source, target, nodes],
  );

  // When selected, force full visibility (overrides the ancestor-dim pass)
  // and thicken the stroke as selection feedback.
  const edgeStyle = selected ? { ...style, strokeWidth: 3, opacity: 1 } : style;

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
  const mergeIndex = useMemo(() => {
    if (isRef) return -1;
    const siblings = edges.filter((e) => e.target === target && !e.data?.isCrossLink);
    if (siblings.length < 2) return -1;
    siblings.sort((a, b) => (a.data?.contextOrder ?? Number.MAX_SAFE_INTEGER) - (b.data?.contextOrder ?? Number.MAX_SAFE_INTEGER));
    return siblings.findIndex((e) => e.id === id);
  }, [edges, target, id, isRef]);

  // The wire into a turn that left its agent session says why, where the
  // line leaves the column — when the wire is long enough to carry words;
  // the card's name row always says it too
  const tgt = nodes.find((n) => n.id === target);
  const roomy = Math.hypot(targetX - sourceX, targetY - sourceY) > 200;
  const link = roomy && !isRef && view?.route !== 'material' ? tgt?.data.sessionLink : undefined;
  const linkText = link?.kind === 'new'
    ? fmt(t('session.newBadge'), { why: sessionWhy(link, nodes, t) })
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
          style={{ stroke: edgeStyle?.stroke ?? 'var(--edge-continue)', strokeWidth: edgeStyle?.strokeWidth ?? 2, animationDelay: `${drawDelay}ms` }} />
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
