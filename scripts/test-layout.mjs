#!/usr/bin/env node
// Layout invariants. autoLayout is pure, but it lives in src/ where the module
// graph reaches import.meta.env, so it is bundled for node the same way the
// benchmark compiler bundles product code (benchmark/tools/build-bundle.sh).
//
// The rules being checked are the canvas grammar, not aesthetics:
//   - a node CONTINUES below every parent it continues from
//   - a node EXPLORED out of a parent stands beside it, never above its top
//   - no two thought cards overlap
//   - the same graph, handed over in a different order, lays out the same way
//
// Run: node scripts/test-layout.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'tdag-layout-'));
const bundle = join(tmp, 'layout.mjs');
execFileSync(join(ROOT, 'node_modules/.bin/esbuild'), [
  join(ROOT, 'src/lib/layout.ts'), '--bundle', '--format=esm', '--platform=node',
  `--outfile=${bundle}`, '--define:import.meta.env.VITE_API_BASE=""',
  '--define:import.meta.env.DEV=false',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const { autoLayout, nodeHeight, placeNewNodes, reseatSubtree } = await import(pathToFileURL(bundle).href);
const framesBundle = join(tmp, 'frames.mjs');
execFileSync(join(ROOT, 'node_modules/.bin/esbuild'), [
  join(ROOT, 'src/lib/frames.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${framesBundle}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
const { frameMembers } = await import(pathToFileURL(framesBundle).href);

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const NODE_W = 520;
const CONTENT = new Set(['note', 'file', 'link', 'frame']);
const th = (id, over = {}) => ({
  id, type: 'thought', position: { x: 0, y: 0 },
  data: {
    question: 'q', response: 'r', responses: ['r'], responseIndex: 0,
    isCollapsed: true, isEditing: false, isEditingResponse: false, isLoading: false,
    tokenCount: 0, highlights: [], highlightMode: false, roleMode: 'assistant',
    attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
    isRoot: false, isBranch: false, ...over,
  },
});
const file = (id, x) => ({ ...th(id, { stepKind: 'file' }), position: { x, y: 0 }, measured: { width: 120, height: 120 } });
const frame = (id, x, y, width, height, frameCarry = true) => ({
  ...th(id, { stepKind: 'frame', frameCarry }), position: { x, y }, width, height, zIndex: -1,
});
const placed = (node, x, y, width = 520, height = 120) => ({
  ...node, position: { x, y }, measured: { width, height },
});
const ed = (s, t, data) => ({ id: `${s}->${t}`, source: s, target: t, ...(data ? { data } : {}) });
const xOf = (laid, id) => laid.find((n) => n.id === id).position.x;
const nodeOf = (laid, id) => laid.find((n) => n.id === id);

// Every arrow-order and overlap rule, checked per edge.
function violations(laid, edges) {
  const by = new Map(laid.map((n) => [n.id, n]));
  const out = [];
  for (const e of edges) {
    if (e.data?.isCrossLink) continue;
    const s = by.get(e.source), t = by.get(e.target);
    if (!s || !t || CONTENT.has(s.data?.stepKind) || CONTENT.has(t.data?.stepKind)) continue;
    if (e.data?.isBranchFromSelection) {
      if (t.position.y < s.position.y) out.push(`explore ${e.source}->${e.target} above parent top`);
    } else if (t.position.y < s.position.y + nodeHeight(s)) {
      out.push(`structural ${e.source}->${e.target} above parent bottom`);
    }
  }
  const solid = laid.filter((n) => !CONTENT.has(n.data?.stepKind));
  for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
    const a = solid[i], b = solid[j];
    if (a.position.x < b.position.x + NODE_W && b.position.x < a.position.x + NODE_W &&
        a.position.y < b.position.y + nodeHeight(b) && b.position.y < a.position.y + nodeHeight(a))
      out.push(`overlap ${a.id}/${b.id}`);
  }
  return out;
}

console.log('layout invariants\n');

test('a merge sits under the parent it was continued from: the first edge in, not the median', () => {
  const nodes = ['root', 'p1', 'p2', 'p3', 'merge'].map((i) => th(i));
  const edges = [ed('root', 'p1'), ed('root', 'p2'), ed('root', 'p3'),
                 ed('p3', 'merge'), ed('p1', 'merge'), ed('p2', 'merge')];
  const laid = autoLayout(nodes, edges);
  assert(xOf(laid, 'merge') === xOf(laid, 'p3'),
    `merge at ${xOf(laid, 'merge')}, first parent p3 at ${xOf(laid, 'p3')}`);
});

test('the same graph in a different node order lays out the same way', () => {
  const ids = ['root', 'p1', 'p2', 'p3', 'merge'];
  const edges = [ed('root', 'p1'), ed('root', 'p2'), ed('root', 'p3'),
                 ed('p1', 'merge'), ed('p2', 'merge'), ed('p3', 'merge')];
  const byId = new Map(ids.map((i) => [i, th(i)]));
  const sig = (order) => autoLayout(order.map((i) => byId.get(i)), edges)
    .map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}`).sort().join('|');
  const a = sig(ids), b = sig([...ids].reverse()), c = sig(['root', 'p3', 'p1', 'p2', 'merge']);
  assert(a === b && b === c, 'layout changed when the node array was permuted');
});

test('an explore branch follows the merge that moves beneath its parents', () => {
  const nodes = ['rootA', 'rootB', 'B', 'merge', 'branch'].map((i) => th(i));
  const edges = [ed('rootB', 'B'), ed('rootA', 'merge'), ed('B', 'merge'),
                 ed('merge', 'branch', { isBranchFromSelection: true })];
  const laid = autoLayout(nodes, edges);
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

test('a merge continued from one parent and explored from another keeps the plain column', () => {
  const nodes = ['explore', 'a', 'b', 'plain', 'merge'].map((i) => th(i));
  const edges = [ed('a', 'b'), ed('b', 'plain'),
                 ed('explore', 'merge', { isBranchFromSelection: true }), ed('plain', 'merge')];
  const laid = autoLayout(nodes, edges);
  assert(xOf(laid, 'merge') === xOf(laid, 'plain'),
    `merge at ${xOf(laid, 'merge')}, plain parent at ${xOf(laid, 'plain')}`);
});

test('a merge of material-anchored chains follows its first parent, wherever that chain sits', () => {
  const nodes = [file('mLeft', 0), file('mMid', 1000), file('mRight', 2000),
                 th('qRight'), th('qLeft'), th('qMid'), th('merge')];
  const edges = [ed('mRight', 'qRight'), ed('mLeft', 'qLeft'), ed('mMid', 'qMid'),
                 ed('qRight', 'merge'), ed('qLeft', 'merge'), ed('qMid', 'merge')];
  const laid = autoLayout(nodes, edges);
  assert(xOf(laid, 'merge') === xOf(laid, 'qRight'),
    `merge at ${xOf(laid, 'merge')}, first parent qRight at ${xOf(laid, 'qRight')}`);
});

test('a chain reading several documents hangs from the lowest of them', () => {
  const nodes = [file('f0', 0), file('f1', 900), file('f2', 1800), file('f3', 2700), file('f4', 3600), th('synth')];
  nodes[3].position.y = 400; // f3 hangs lowest
  const edges = ['f0', 'f1', 'f2', 'f3', 'f4'].map((f) => ed(f, 'synth'));
  const x = xOf(autoLayout(nodes, edges), 'synth');
  assert(Math.abs(x - (2700 - 60)) < 1, `synthesis at ${x}, not under the lowest document f3`);
});

test('a linked frame re-wraps the members it contained before layout', () => {
  const nodes = [
    frame('frame', 0, 400, 700, 900),
    placed(th('root'), 100, 500, 520, 260),
    placed(th('child'), 100, 900, 520, 260),
  ];
  const laid = autoLayout(nodes, [ed('root', 'child')]);
  const f = nodeOf(laid, 'frame'), root = nodeOf(laid, 'root'), child = nodeOf(laid, 'child');
  const minX = Math.min(root.position.x, child.position.x);
  const maxX = Math.max(root.position.x + 520, child.position.x + 520);
  const minY = Math.min(root.position.y, child.position.y);
  const maxY = Math.max(root.position.y + nodeHeight(root), child.position.y + nodeHeight(child));
  assert(f.position.y < 0, `frame stayed near its old y=${f.position.y}`);
  assert(f.position.x < minX && f.position.y < minY, 'frame does not leave padding above/left of members');
  assert(f.position.x + f.width > maxX && f.position.y + f.height > maxY, 'frame does not enclose laid-out members');
});

test('an unlinked frame is untouched by auto layout', () => {
  const original = frame('frame', 0, 400, 700, 900, false);
  const laid = autoLayout([
    original,
    placed(th('root'), 100, 500),
    placed(th('child'), 100, 900),
  ], [ed('root', 'child')]);
  const f = nodeOf(laid, 'frame');
  assert(f.position.x === original.position.x && f.position.y === original.position.y, 'unlinked frame moved');
  assert(f.width === original.width && f.height === original.height, 'unlinked frame resized');
});

test('a linked frame with no members is untouched by auto layout', () => {
  const original = frame('empty', 2000, 2000, 700, 900);
  const laid = autoLayout([original, placed(th('root'), 0, 0)], []);
  const f = nodeOf(laid, 'empty');
  assert(f.position.x === original.position.x && f.position.y === original.position.y, 'empty frame moved');
  assert(f.width === original.width && f.height === original.height, 'empty frame resized');
});

test('nested frames re-wrap inner to outer with more room on the outer frame', () => {
  const nodes = [
    frame('outer', 0, 400, 760, 1050),
    frame('inner', 50, 450, 660, 950),
    placed(th('root'), 100, 500),
    placed(th('child'), 100, 900),
  ];
  const laid = autoLayout(nodes, [ed('root', 'child')]);
  const outer = nodeOf(laid, 'outer'), inner = nodeOf(laid, 'inner');
  assert(outer.position.x < inner.position.x, 'outer frame does not have more left padding');
  assert(outer.position.y < inner.position.y, 'outer frame does not have more top padding');
  assert(outer.position.x + outer.width > inner.position.x + inner.width, 'outer frame does not have more right padding');
  assert(outer.position.y + outer.height > inner.position.y + inner.height, 'outer frame does not have more bottom padding');
});

test('overlapping frames can share a member and both still follow it', () => {
  const nodes = [
    frame('leftFrame', 0, 400, 650, 700),
    frame('rightFrame', 150, 400, 650, 700),
    placed(th('root'), 100, 500, 520, 120),
  ];
  const laid = autoLayout(nodes, []);
  const root = nodeOf(laid, 'root');
  for (const id of ['leftFrame', 'rightFrame']) {
    const f = nodeOf(laid, id);
    assert(f.position.x < root.position.x && f.position.y < root.position.y, `${id} lost shared member`);
    assert(f.position.x + f.width > root.position.x + 520, `${id} no longer wraps shared member`);
  }
});

// #40: two linked frames that merely overlap must never own each other
test('a partially overlapping frame is not a member, its own nodes stay with it', () => {
  const F1 = frame('F1', 0, 0, 1000, 800);
  const F2 = frame('F2', 700, 500, 600, 500); // centre (1000, 750) inside F1, but not contained
  const a = placed(th('a'), 540, 540);        // centre (800, 600): inside both
  const far = placed(th('far'), 1000, 880);   // centre (1260, 940): inside F2 only
  const all = [F1, F2, a, far];
  const ids = (f) => frameMembers(f, all).map((n) => n.id).sort();
  assert(JSON.stringify(ids(F1)) === JSON.stringify(['a']), `F1 owns ${ids(F1)} (expected only a)`);
  assert(JSON.stringify(ids(F2)) === JSON.stringify(['a', 'far']), `F2 owns ${ids(F2)} (expected a, far)`);
});

test('a fully contained frame is a member of the outer frame, never the reverse', () => {
  const outer = frame('outer', 0, 0, 1000, 800);
  const inner = frame('inner', 100, 100, 400, 300);
  const n = placed(th('n'), 120, 120);
  const all = [outer, inner, n];
  const ids = (f) => frameMembers(f, all).map((x) => x.id).sort();
  assert(JSON.stringify(ids(outer)) === JSON.stringify(['inner', 'n']), `outer owns ${ids(outer)}`);
  assert(JSON.stringify(ids(inner)) === JSON.stringify(['n']), `inner owns ${ids(inner)}`);
});

test('auto layout keeps partially overlapping frames on their own members', () => {
  const nodes = [
    frame('F1', 0, 0, 1000, 800),
    frame('F2', 700, 500, 600, 500),
    placed(th('a'), 540, 540, 520, 120),
    placed(th('far'), 1000, 880, 520, 120),
  ];
  const laid = autoLayout(nodes, []);
  const f2 = nodeOf(laid, 'F2'), far = nodeOf(laid, 'far'), a = nodeOf(laid, 'a');
  const wraps = (f, n) => f.position.x < n.position.x && f.position.y < n.position.y && f.position.x + f.width > n.position.x + 520 && f.position.y + f.height > n.position.y + nodeHeight(n);
  assert(wraps(f2, far) && wraps(f2, a), 'F2 no longer wraps its own members after layout');
});

// ── placeNewNodes: creating ONE card must not reflow the canvas ──
// autoLayout re-derives the whole graph, which is right behind the relayout
// button and wrong as the side effect of asking a follow-up: on a canvas
// placed by hand (the example canvas, or anything the user dragged) every
// card jumped the moment a child appeared. These fixtures are deliberately
// OFF the layout grid for that reason.
const seat = (id, x, y, over) => ({ ...th(id, over), position: { x, y } });
const spots = (nodes) => new Map(nodes.map((n) => [n.id, `${Math.round(n.position.x)},${Math.round(n.position.y)}`]));
const movedOther = (before, after, except) => [...before]
  .filter(([id]) => !except.includes(id))
  .filter(([id, p]) => {
    const n = after.find((x) => x.id === id);
    return !n || `${Math.round(n.position.x)},${Math.round(n.position.y)}` !== p;
  })
  .map(([id]) => id);
const at = (laid, id) => laid.find((n) => n.id === id).position;

// The reported bug, in its own shape: a hand-placed chain with a branch and a
// far-away chapter, one follow-up, nothing else may move.
test('a follow-up leaves every card already on the canvas exactly where it was', () => {
  const nodes = [seat('root', 40, 390), seat('a', 40, 640),
                 seat('branch', 700, 860), seat('far', 2210, 150)];
  const edges = [ed('root', 'a'), ed('root', 'branch', { isBranchFromSelection: true }), ed('a', 'next')];
  const before = spots(nodes);
  const laid = placeNewNodes([...nodes, seat('next', 0, 0)], edges, ['next']);
  const moved = movedOther(before, laid, ['next']);
  assert(moved.length === 0, `cards moved: ${moved.join(', ')}`);
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

test('a follow-up hangs in its parent column, directly below the parent', () => {
  const nodes = [seat('root', 40, 390), seat('a', 40, 640)];
  const edges = [ed('root', 'a'), ed('a', 'next')];
  const laid = placeNewNodes([...nodes, seat('next', 0, 0)], edges, ['next']);
  const n = at(laid, 'next');
  assert(n.x === 40, `next at x=${n.x}, parent column is 40`);
  assert(n.y === 640 + nodeHeight(nodes[1]) + 72, `next at y=${n.y}`);
});

// A parent that just collapsed still carries its expanded `measured` height
// for a render tick; believing it pushed the child — and then the whole
// column — into the next free slot out on the right.
test('a parent that just collapsed is measured collapsed, not as it was', () => {
  const parent = { ...seat('a', 40, 640), measured: { width: 520, height: 900 } };
  const nodes = [seat('root', 40, 390), parent];
  const edges = [ed('root', 'a'), ed('a', 'next')];
  const laid = placeNewNodes([...nodes, seat('next', 0, 0)], edges, ['next']);
  const n = at(laid, 'next');
  assert(n.x === 40, `next at x=${n.x} — a stale parent height pushed it out of the column`);
  assert(n.y === 640 + 240 + 72, `next at y=${n.y}, not tight under the collapsed parent`);
});

test('a second child lands beside the chain, not in the gap under the first', () => {
  const nodes = [seat('root', 40, 390), seat('a', 40, 640)];
  const edges = [ed('root', 'a'), ed('root', 'b')];
  const laid = placeNewNodes([...nodes, seat('b', 0, 0)], edges, ['b']);
  const n = at(laid, 'b');
  assert(n.x > 580 && n.y >= 640, `b at ${n.x},${n.y} — inside the column it must not enter`);
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

test('a selection branch sits beside its parent, past the parent card', () => {
  const nodes = [seat('root', 40, 390), seat('a', 40, 640), seat('sib', 700, 410)];
  const edges = [ed('root', 'a'), ed('root', 'sib', { isBranchFromSelection: true }),
                 ed('a', 'b', { isBranchFromSelection: true })];
  const laid = placeNewNodes([...nodes, seat('b', 0, 0)], edges, ['b']);
  const n = at(laid, 'b');
  assert(n.x > 580 && n.x < 1240, `branch at x=${n.x}, not beside its parent`);
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

test('a batch of branches spreads into consecutive slots instead of stacking', () => {
  const nodes = [seat('root', 40, 390)];
  const ids = ['f1', 'f2', 'f3'];
  const edges = ids.map((i) => ed('root', i, { isBranchFromSelection: true }));
  const laid = placeNewNodes([...nodes, ...ids.map((i) => seat(i, 0, 0))], edges, ids);
  const xs = ids.map((i) => at(laid, i).x);
  assert(new Set(xs).size === ids.length, `batch stacked: ${xs.join(', ')}`);
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

// The example canvas is a poster of chapter frames. A card asked inside a
// chapter must not be flung past every other chapter because the row is full.
const chapterFrame = (id, x, y, w, h) => ({
  ...th(id, { stepKind: 'frame' }),
  position: { x, y }, width: w, height: h, measured: { width: w, height: h },
});

test('a card asked inside a chapter frame is seated inside it', () => {
  // the chapter's one open column is filled top to bottom
  const filler = { ...seat('filler', 700, 410, { isCollapsed: false }), measured: { width: 520, height: 1200 } };
  const nodes = [chapterFrame('ch', 0, 0, 1290, 1460), seat('root', 40, 390), seat('a', 40, 640), filler];
  const edges = [ed('root', 'a'), ed('root', 'b')];
  const laid = placeNewNodes([...nodes, seat('b', 0, 0)], edges, ['b']);
  const n = at(laid, 'b');
  assert(n.x === 40, `b at x=${n.x}, not back under the parent's column`);
  assert(n.y === 640 + 240 + 72, `b at y=${n.y}, not below the chain it must clear`);
  assert(n.x + 520 <= 1290, `b at x=${n.x} leaves the chapter frame`);
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

test('a chapter frame only bounds the card when its row is actually full', () => {
  const nodes = [chapterFrame('ch', 0, 0, 2000, 1460), seat('root', 40, 390), seat('a', 40, 640)];
  const edges = [ed('root', 'a'), ed('root', 'b')];
  const laid = placeNewNodes([...nodes, seat('b', 0, 0)], edges, ['b']);
  assert(at(laid, 'b').x === 628, `b at x=${at(laid, 'b').x}, expected beside the chain inside the chapter`);
});

// Frames follow their members (autoLayout re-wraps them). Seating keeps the
// same promise without moving anything: a card that had to take the floor
// past a linked chapter's bottom edge grows that chapter down to hold it.
test('a card seated past its chapter edge grows the linked frame to hold it', () => {
  const nodes = [chapterFrame('ch', 0, 0, 1290, 1000), seat('root', 40, 390), seat('a', 40, 640)];
  const edges = [ed('root', 'a'), ed('a', 'next')];
  const before = spots(nodes);
  const laid = placeNewNodes([...nodes, seat('next', 0, 0)], edges, ['next']);
  assert(movedOther(before, laid, ['next']).length === 0, `cards moved: ${movedOther(before, laid, ['next']).join(', ')}`);
  const ch = nodeOf(laid, 'ch');
  assert(ch.position.x === 0 && ch.position.y === 0, 'the chapter moved');
  assert(ch.width === 1290, `chapter width changed to ${ch.width} for a card inside its columns`);
  const card = nodeOf(laid, 'next');
  assert(ch.height >= card.position.y + nodeHeight(card), `chapter height ${ch.height} does not hold the card`);
  assert(frameMembers(ch, laid).some((n) => n.id === 'next'), 'the new card is not a member of its chapter');
});

test('a chapter the card already fits in keeps its size, and an unlinked one never grows', () => {
  const roomy = placeNewNodes([chapterFrame('ch', 0, 0, 1290, 3000), seat('a', 40, 640), seat('next', 0, 0)], [ed('a', 'next')], ['next']);
  assert(nodeOf(roomy, 'ch').height === 3000, `a roomy chapter resized to ${nodeOf(roomy, 'ch').height}`);
  const loose = { ...chapterFrame('ch', 0, 0, 1290, 1000), data: { ...th('ch').data, stepKind: 'frame', frameCarry: false } };
  const laid = placeNewNodes([loose, seat('a', 40, 640), seat('next', 0, 0)], [ed('a', 'next')], ['next']);
  assert(nodeOf(laid, 'ch').height === 1000, `an unlinked frame grew to ${nodeOf(laid, 'ch').height}`);
});

test('a chapter that grows past its enclosing frame grows that frame too', () => {
  const nodes = [chapterFrame('outer', -100, -100, 1600, 1200), chapterFrame('ch', 0, 0, 1290, 1000),
                 seat('a', 40, 640)];
  const edges = [ed('a', 'next')];
  const laid = placeNewNodes([...nodes, seat('next', 0, 0)], edges, ['next']);
  const outer = nodeOf(laid, 'outer'), ch = nodeOf(laid, 'ch');
  assert(ch.height > 1000, 'the inner chapter did not grow');
  assert(outer.position.y + outer.height > ch.position.y + ch.height, 'the outer frame no longer holds the chapter');
  assert(frameMembers(outer, laid).some((n) => n.id === 'ch'), 'the chapter fell out of its enclosing frame');
});

// A card can continue from one parent and be explored out of another. The
// plain wire decides the column and the checkout floor; the explore parent is
// owed its top edge and no more (a branch beside it, not a link under it).
test('a card explored from one parent and continued from another follows the plain wire', () => {
  const nodes = [seat('noise', 2210, 150), seat('explorer', 1450, 1200)];
  const edges = [ed('noise', 't'), ed('explorer', 't', { isBranchFromSelection: true })];
  const laid = placeNewNodes([...nodes, seat('t', 0, 0)], edges, ['t']);
  const n = at(laid, 't');
  assert(n.x === 2210, `t at x=${n.x}, not in the column of the parent it continues from`);
  assert(n.y === 1200, `t at y=${n.y}, expected level with the top of the parent that explored it`);
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

// Promoting a dashed reference to a real wire changes the graph under that
// card: it and its chain must obey the arrow grammar again — and only they.
test('wiring a card solid re-seats its chain and moves nothing else', () => {
  const nodes = [seat('root', 40, 390), seat('a', 40, 640),
                 seat('side', 700, 400), seat('t', 700, 1400), seat('tChild', 700, 1800)];
  // the new wire: side -> t (t now continues from side)
  const edges = [ed('root', 'a'), ed('side', 't'), ed('t', 'tChild')];
  const before = spots(nodes);
  const laid = reseatSubtree(nodes, edges, 't');
  const moved = movedOther(before, laid, ['t', 'tChild']);
  assert(moved.length === 0, `cards moved: ${moved.join(', ')}`);
  assert(at(laid, 't').y > 400 + nodeHeight(nodes[2]), 't did not land under its new parent');
  assert(at(laid, 'tChild').y > at(laid, 't').y, 'tChild did not follow its parent');
  assert(violations(laid, edges).length === 0, violations(laid, edges).join('; '));
});

test('a re-seat stops at material: a chain under a document keeps its place', () => {
  const doc = file('doc', 40);
  const nodes = [seat('p', 40, 900), doc, seat('below', 40, 600), seat('deep', 40, 1000)];
  const edges = [ed('p', 'doc'), ed('doc', 'below'), ed('below', 'deep')];
  const before = spots(nodes);
  const laid = reseatSubtree(nodes, edges, 'doc');
  assert(movedOther(before, laid, []).length === 0, 'a re-seat walked through material and moved its chain');
});

test('a question asked from a document hangs just below that document', () => {
  const doc = file('pdf', 2980); // measured 120 tall
  const edges = [ed('pdf', 'q')];
  const laid = placeNewNodes([doc, seat('q', 0, 0)], edges, ['q']);
  const n = at(laid, 'q');
  assert(n.x === 2980, `ask at x=${n.x}, document at 2980`);
  assert(n.y >= 120 && n.y < 400, `ask at y=${n.y}, not tight under the document`);
});

test('the first card sits at the origin; a later root takes the next free column', () => {
  assert(at(placeNewNodes([seat('r', 0, 0)], [], ['r']), 'r').x === 0, 'first card is not at the origin');
  const laid = placeNewNodes([seat('a', 0, 0), seat('b', 628, 0), seat('r', 0, 0)], [], ['r']);
  assert(at(laid, 'r').x === 1216, `root at x=${at(laid, 'r').x}, expected past both cards`);
});

test('the benchmark canvases keep the arrow order', () => {
  const dir = join(ROOT, 'benchmark/canvases/inputs');
  let checked = 0, bad = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.thoughtdag.json'))) {
    const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const v = violations(autoLayout(c.nodes ?? [], c.edges ?? []), c.edges ?? []);
    checked++;
    if (v.length) bad.push(`${f}: ${v[0]}`);
  }
  assert(checked > 0, 'no benchmark canvases found');
  assert(bad.length === 0, `${bad.length}/${checked} canvases violate: ${bad[0]}`);
});

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failing` : '\nall passed');
process.exit(failures ? 1 : 0);
