import type { Position } from '@xyflow/react';
import type { ThoughtNode } from '../types';
import { nodeHeight } from './layout';
import { NODE_CSS_WIDTH } from './constants';

// Collision-aware bezier routing, the light way: build the natural arc,
// then — if it passes through any node card — try a few sideways "bends"
// (control points pushed perpendicular to the edge) and keep the first
// candidate that clears every card. No A*, no visibility graph: a handful
// of samples per candidate is enough at canvas scale, and edges stay
// stable while dragging because candidates are tried in a fixed order.

interface Pt { x: number; y: number }

const BENDS = [0, 0.18, -0.18, 0.36, -0.36, 0.55, -0.55];
const SAMPLES = 22;
const MARGIN = 10; // clearance around cards

// The obstacle grid: cells this many px square. A card covers a few; a
// wire's candidate arcs, a few dozen at most.
const CELL = 512;
// A box over more cells than this (a big frame) is not filed; every query
// checks it instead. A query over more cells than this scans every box.
const FILE_MAX_CELLS = 64;
const QUERY_MAX_CELLS = 1024;
// Cell coordinates past ±LIMIT (5e8 px) are not filed either, which keeps
// the numeric cell key cx * ROW + cy exact and unique.
const LIMIT = 2 ** 20;
const ROW = 2 ** 22;
const fileable = (c: number) => c > -LIMIT && c < LIMIT; // false for NaN, ±Infinity

/**
 * Every card as an obstacle, for one nodes snapshot: its box inflated by
 * MARGIN, filed in a coarse grid so a wire tests only the cards near it.
 * Built once per snapshot and shared by every wire — a store write used to
 * make each visible wire rebuild and test all of the boxes itself.
 *
 * A snapshot whose boxes all match the previous snapshot's gets the
 * previous field back, so a write that moves no card (a streaming chunk
 * once the card has stopped growing, a selection) re-routes no wire: the
 * field is what the wires' memo depends on, not the nodes array.
 */
export interface ObstacleField {
  readonly ids: readonly string[];
  /** a card's own x and width (the mirror test reads them) */
  readonly px: Float64Array;
  readonly w: Float64Array;
  /** the inflated boxes */
  readonly x1: Float64Array;
  readonly y1: Float64Array;
  readonly x2: Float64Array;
  readonly y2: Float64Array;
  /** first index of each id, as nodes.find would pick */
  readonly index: ReadonlyMap<string, number>;
  readonly grid: ReadonlyMap<number, readonly number[]>;
  /** boxes too big or too far out to file: every query checks them */
  readonly wide: readonly number[];
  /** per-query visit marks, so a box filed in several cells is taken once */
  readonly seen: Uint32Array;
  mark: number;
}

// A turn folded into a pleat (lib/pleats) sits stacked under its strip, out
// of sight: it is in no wire's way. Its box is empty — kept in the arrays,
// so the mirror test still finds its x and width, but never filed and never
// met by a query (an empty box overlaps nothing).
const boxTop = (n: ThoughtNode) => (n.data.inPleat ? Infinity : n.position.y - MARGIN);
const boxBottom = (n: ThoughtNode) => (n.data.inPleat ? -Infinity : n.position.y + nodeHeight(n) + MARGIN);

const fields = new WeakMap<ThoughtNode[], ObstacleField>();
let lastField: ObstacleField | null = null;

/** The obstacle field of a nodes snapshot (see ObstacleField). */
export function obstacleField(nodes: ThoughtNode[]): ObstacleField {
  let field = fields.get(nodes);
  if (!field) {
    field = lastField && sameBoxes(lastField, nodes) ? lastField : buildField(nodes);
    fields.set(nodes, field);
  }
  // the next snapshot is compared with the one asked for last (an undo can
  // hand an older array back)
  lastField = field;
  return field;
}

// The same expressions buildField stores, so equal means bit-for-bit equal.
function sameBoxes(field: ObstacleField, nodes: ThoughtNode[]): boolean {
  if (field.ids.length !== nodes.length) return false;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id !== field.ids[i]
      || n.position.x !== field.px[i]
      || (n.measured?.width ?? NODE_CSS_WIDTH) !== field.w[i]
      || boxTop(n) !== field.y1[i]
      || boxBottom(n) !== field.y2[i]) return false;
  }
  return true;
}

function buildField(nodes: ThoughtNode[]): ObstacleField {
  const count = nodes.length;
  const ids = new Array<string>(count);
  const px = new Float64Array(count), w = new Float64Array(count);
  const x1 = new Float64Array(count), y1 = new Float64Array(count);
  const x2 = new Float64Array(count), y2 = new Float64Array(count);
  const index = new Map<string, number>();
  const grid = new Map<number, number[]>();
  const wide: number[] = [];
  for (let i = 0; i < count; i++) {
    const n = nodes[i];
    const width = n.measured?.width ?? NODE_CSS_WIDTH;
    ids[i] = n.id;
    if (!index.has(n.id)) index.set(n.id, i);
    px[i] = n.position.x;
    w[i] = width;
    y1[i] = boxTop(n);
    y2[i] = boxBottom(n);
    if (n.data.inPleat) {
      x1[i] = Infinity;
      x2[i] = -Infinity;
      continue;
    }
    x1[i] = n.position.x - MARGIN;
    x2[i] = n.position.x + width + MARGIN;
    const cx1 = Math.floor(x1[i] / CELL), cx2 = Math.floor(x2[i] / CELL);
    const cy1 = Math.floor(y1[i] / CELL), cy2 = Math.floor(y2[i] / CELL);
    if (!(fileable(cx1) && fileable(cx2) && fileable(cy1) && fileable(cy2))
      || (cx2 - cx1 + 1) * (cy2 - cy1 + 1) > FILE_MAX_CELLS) {
      wide.push(i);
      continue;
    }
    for (let cx = cx1; cx <= cx2; cx++) {
      for (let cy = cy1; cy <= cy2; cy++) {
        const key = cx * ROW + cy;
        const cell = grid.get(key);
        if (cell) cell.push(i);
        else grid.set(key, [i]);
      }
    }
  }
  return { ids, px, w, x1, y1, x2, y2, index, grid, wide, seen: new Uint32Array(count), mark: 0 };
}

/**
 * The boxes that reach into the given area, endpoints left out. A wire's
 * samples all lie inside the area it asks about (see routeEdge), so the
 * boxes left out could never count a hit: the result is the one a test
 * against every card gives.
 */
function obstaclesNear(
  f: ObstacleField, minX: number, minY: number, maxX: number, maxY: number,
  sourceId: string, targetId: string,
): number[] {
  const out: number[] = [];
  const take = (i: number) => {
    if (f.x1[i] < maxX && f.x2[i] > minX && f.y1[i] < maxY && f.y2[i] > minY
      && f.ids[i] !== sourceId && f.ids[i] !== targetId) out.push(i);
  };
  const cx1 = Math.floor(minX / CELL), cx2 = Math.floor(maxX / CELL);
  const cy1 = Math.floor(minY / CELL), cy2 = Math.floor(maxY / CELL);
  if (!(fileable(cx1) && fileable(cx2) && fileable(cy1) && fileable(cy2))
    || (cx2 - cx1 + 1) * (cy2 - cy1 + 1) > QUERY_MAX_CELLS) {
    for (let i = 0; i < f.ids.length; i++) take(i);
    return out;
  }
  if (f.mark === 0xffffffff) { f.seen.fill(0); f.mark = 0; }
  const mark = ++f.mark;
  for (let cx = cx1; cx <= cx2; cx++) {
    for (let cy = cy1; cy <= cy2; cy++) {
      const cell = f.grid.get(cx * ROW + cy);
      if (!cell) continue;
      for (const i of cell) {
        if (f.seen[i] === mark) continue;
        f.seen[i] = mark;
        take(i);
      }
    }
  }
  for (const i of f.wide) take(i);
  return out;
}

function controlFor(pos: Position | undefined, x: number, y: number, ox: number, oy: number): Pt {
  // Control point extends along the handle direction, like a normal bezier
  switch (pos) {
    case 'left': return { x: x - ox, y };
    case 'right': return { x: x + ox, y };
    case 'top': return { x, y: y - oy };
    default: return { x, y: y + oy }; // bottom / undefined
  }
}

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

export interface Box { x: number; y: number; width: number; height: number }

/**
 * Pin a wire's end to its card's border. React Flow anchors an edge at the
 * handle's OUTER edge, from bounds measured once — so a line hung half a
 * handle off the card, and a handle measured mid-transition (the bottom
 * one grows into "+") left it a stale distance further. The card box is
 * what the eye reads, so the end sits `out` px beyond the side it leaves
 * from (negative = tucked under the card). A handle that sits INSIDE the
 * card (the far tier's dot) is left where it is.
 */
export function onCardBorder(x: number, y: number, pos: Position | undefined, box: Box, out: number): Pt {
  const reach = 40; // a handle's outer edge never lies further off its side
  switch (pos) {
    case 'top': {
      const side = box.y;
      return y <= side + 1 && y >= side - reach ? { x, y: side - out } : { x, y };
    }
    case 'bottom': {
      const side = box.y + box.height;
      return y >= side - 1 && y <= side + reach ? { x, y: side + out } : { x, y };
    }
    case 'left': {
      const side = box.x;
      return x <= side + 1 && x >= side - reach ? { x: side - out, y } : { x, y };
    }
    case 'right': {
      const side = box.x + box.width;
      return x >= side - 1 && x <= side + reach ? { x: side + out, y } : { x, y };
    }
    default: return { x, y };
  }
}

export interface RoutedPath {
  path: string;
  labelX: number;
  labelY: number;
}

export function routeEdge(
  sourceX: number, sourceY: number, sourcePosition: Position | undefined,
  targetX: number, targetY: number, targetPosition: Position | undefined,
  sourceId: string, targetId: string,
  field: ObstacleField,
): RoutedPath {
  // Horizontal edges carry fixed semantic anchors (source right edge →
  // target left edge). When the target's CENTER lies left of the source's
  // center (hand-placed nodes), mirror both anchors about their node's
  // vertical centerline: the edge leaves left and enters right instead of
  // looping around the source card. Center comparison keeps the direction
  // matching what you see (a card mostly on the left connects from the
  // left, even while still overlapping); the flip at center-crossing is a
  // single follow-the-drag switch, not a flutter. Render-time only — the
  // stored handles keep their meaning. Centerline mirroring also keeps
  // glyph-tier anchors hugging the seal.
  if (sourcePosition === 'right' && targetPosition === 'left') {
    const s = field.index.get(sourceId);
    const t = field.index.get(targetId);
    if (s !== undefined && t !== undefined) {
      const sCx = field.px[s] + field.w[s] / 2;
      const tCx = field.px[t] + field.w[t] / 2;
      if (tCx < sCx) {
        sourceX = 2 * sCx - sourceX;
        targetX = 2 * tCx - targetX;
        sourcePosition = 'left' as Position;
        targetPosition = 'right' as Position;
      }
    }
  }
  const p0: Pt = { x: sourceX, y: sourceY };
  const p3: Pt = { x: targetX, y: targetY };
  const dist = Math.hypot(targetX - sourceX, targetY - sourceY);
  const offset = Math.min(Math.max(dist * 0.45, 40), 260);

  // Unit normal to the straight source→target line, for sideways bending
  const nx = dist > 0 ? -(targetY - sourceY) / dist : 0;
  const ny = dist > 0 ? (targetX - sourceX) / dist : 0;

  // Every candidate's control points, and the area they span: a bezier
  // never leaves the hull of its control points, so no sample of any
  // candidate falls outside it (padded for rounding).
  const c1s: Pt[] = [], c2s: Pt[] = [];
  let minX = Math.min(sourceX, targetX), maxX = Math.max(sourceX, targetX);
  let minY = Math.min(sourceY, targetY), maxY = Math.max(sourceY, targetY);
  for (const bend of BENDS) {
    const sway = bend * dist;
    const c1 = controlFor(sourcePosition, sourceX, sourceY, offset, offset);
    const c2 = controlFor(targetPosition, targetX, targetY, offset, offset);
    c1.x += nx * sway; c1.y += ny * sway;
    c2.x += nx * sway; c2.y += ny * sway;
    c1s.push(c1); c2s.push(c2);
    minX = Math.min(minX, c1.x, c2.x); maxX = Math.max(maxX, c1.x, c2.x);
    minY = Math.min(minY, c1.y, c2.y); maxY = Math.max(maxY, c1.y, c2.y);
  }
  const pad = 1 + (Math.abs(minX) + Math.abs(maxX) + Math.abs(minY) + Math.abs(maxY)) * 1e-9;
  // Obstacles: the cards near the wire except its two endpoints, inflated by MARGIN
  const near = obstaclesNear(field, minX - pad, minY - pad, maxX + pad, maxY + pad, sourceId, targetId);
  const { x1, y1, x2, y2 } = field;

  let best: { c1: Pt; c2: Pt; hits: number } | null = null;

  for (let b = 0; b < BENDS.length; b++) {
    const c1 = c1s[b], c2 = c2s[b];
    let hits = 0;
    if (near.length > 0) {
      for (let i = 1; i < SAMPLES; i++) {
        const pt = cubicAt(p0, c1, c2, p3, i / SAMPLES);
        for (const o of near) {
          if (pt.x > x1[o] && pt.x < x2[o] && pt.y > y1[o] && pt.y < y2[o]) { hits++; break; }
        }
      }
    }
    if (hits === 0) { best = { c1, c2, hits }; break; }
    if (!best || hits < best.hits) best = { c1, c2, hits };
  }

  const { c1, c2 } = best!;
  const mid = cubicAt(p0, c1, c2, p3, 0.5);
  return {
    path: `M ${sourceX} ${sourceY} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${targetX} ${targetY}`,
    labelX: mid.x,
    labelY: mid.y,
  };
}
