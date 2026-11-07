#!/usr/bin/env node
// Work outlives the canvas it runs on (src/store/background.ts): what a
// generation writes lands on the canvas it was asked on — the store while it
// is in view, its shadow while it is not, the store again once it is back —
// and nothing of a deleted canvas is written after it is gone.
//
// Run: node --test scripts/test-background.mjs
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'td-background-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const out = join(dir, 'bundle.mjs');
await build({ entryPoints: [`${process.cwd()}/src/store/background.ts`], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const bg = await import(out);

const written = [];
const announced = [];
bg.configureBackground({
  persist: async (id, g) => { written.push({ id, nodes: g.nodes.map((n) => `${n.id}:${n.data.response}`), events: g.events.length }); },
  finished: (id, nodeId, ok) => { announced.push(`${id}/${nodeId}/${ok}`); },
});

const node = (id, response = '') => ({ id, type: 'thought', position: { x: 0, y: 0 }, data: { question: id, response, responses: response ? [response] : [], responseIndex: response ? 0 : -1 } });
/** a store the size of the part the routing touches */
function fakeStore(graph) {
  let state = { ...graph, staleIds: [], selectedNodeId: null, selectedNodeIds: [] };
  const set = (p) => { state = { ...state, ...(typeof p === 'function' ? p(state) : p) }; };
  const get = () => state;
  return { set, get, swap: (g) => { state = { ...state, ...g }; } };
}
const answer = (h, id, text) => h.set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, response: text } } : n)) }));
const responseOf = (graph, id) => graph.nodes.find((n) => n.id === id)?.data.response;
const tick = () => new Promise((r) => setTimeout(r, 0));

test('in view, a bound write goes to the store', () => {
  const store = fakeStore({ nodes: [node('a1')], edges: [], events: [] });
  bg.enterView('A');
  const h = bg.bindCanvas(store.set, store.get);
  assert.equal(h.canvasId, 'A');
  assert.equal(h.live(), true);
  answer(h, 'a1', 'hello');
  assert.equal(responseOf(store.get(), 'a1'), 'hello');
});

test('switched away with an answer going, its writes land on the canvas it belongs to, not the one in view', async () => {
  const store = fakeStore({ nodes: [node('b1')], edges: [], events: [] });
  bg.enterView('B');
  const h = bg.bindCanvas(store.set, store.get);
  const release = h.hold();
  answer(h, 'b1', 'part');
  bg.leaveView('B', { nodes: store.get().nodes, edges: [], events: [] });
  assert.equal(bg.bindCanvas(store.set, store.get), null, 'nothing binds between canvases');
  // the store now holds another canvas
  store.swap({ nodes: [node('c1')], edges: [], events: [] });
  bg.enterView('C');
  answer(h, 'b1', 'part and the rest');
  h.get().logEvent('generate', 'b1');
  assert.equal(h.live(), false);
  assert.equal(responseOf(store.get(), 'b1'), undefined, 'the canvas in view is untouched');
  assert.equal(responseOf(h.get(), 'b1'), 'part and the rest', 'the shadow has it');
  assert.equal(h.get().events.length, 1);
  // the last work done out of view: the shadow is written at once
  release();
  await tick(); await tick();
  const w = written.find((x) => x.id === 'B');
  assert.deepEqual(w, { id: 'B', nodes: ['b1:part and the rest'], events: 1 });
});

test('back in view, the store takes the shadow over and the answer writes the store again', () => {
  const store = fakeStore({ nodes: [node('d1')], edges: [], events: [] });
  bg.enterView('D');
  const h = bg.bindCanvas(store.set, store.get);
  const release = h.hold();
  bg.leaveView('D', { nodes: store.get().nodes, edges: [], events: [] });
  bg.enterView('E');
  answer(h, 'd1', 'while away');
  bg.leaveView('E', { nodes: [], edges: [], events: [] });
  const shadow = bg.takeShadow('D');
  assert.equal(responseOf(shadow, 'd1'), 'while away');
  assert.equal(bg.takeShadow('D'), null, 'taken once');
  store.swap(shadow);
  bg.enterView('D');
  answer(h, 'd1', 'while away, and back');
  assert.equal(responseOf(store.get(), 'd1'), 'while away, and back');
  release();
});

test('a canvas left with nothing going keeps no shadow, and a stray write goes nowhere', () => {
  const store = fakeStore({ nodes: [node('f1')], edges: [], events: [] });
  bg.enterView('F');
  const h = bg.bindCanvas(store.set, store.get);
  bg.leaveView('F', { nodes: store.get().nodes, edges: [], events: [] });
  store.swap({ nodes: [node('g1')], edges: [], events: [] });
  bg.enterView('G');
  answer(h, 'f1', 'late');
  assert.equal(bg.takeShadow('F'), null);
  assert.equal(responseOf(store.get(), 'f1'), undefined);
  assert.equal(responseOf(store.get(), 'g1'), '');
});

test('a plaque lands where its canvas is when the judge answers', () => {
  const store = fakeStore({ nodes: [node('h1', 'answer')], edges: [], events: [] });
  bg.enterView('H');
  const h = bg.bindCanvas(store.set, store.get);
  const release = h.hold();
  bg.leaveView('H', { nodes: store.get().nodes, edges: [], events: [] });
  bg.enterView('I');
  h.setSummary('h1', 'takeaway', 'answer', 'insight', 'topic');
  release();
  const shadow = bg.takeShadow('H');
  assert.deepEqual(shadow.nodes[0].data.summaries, ['takeaway']);
  assert.deepEqual(shadow.nodes[0].data.summaryTopics, ['topic']);
});

test('what waits for a canvas goes on when it is back, and stops when it is deleted', async () => {
  bg.enterView('J');
  assert.equal(await bg.whenInView('J'), true);
  bg.leaveView('J', { nodes: [], edges: [], events: [] });
  bg.enterView('K');
  const back = bg.whenInView('J');
  bg.enterView('J');
  assert.equal(await back, true);
  bg.enterView('K');
  const never = bg.whenInView('L');
  await bg.dropCanvas('L');
  assert.equal(await never, false);
  assert.equal(await bg.whenInView(null), false);
});

test('deleting a canvas stops its answers and writes nothing of it afterwards', async () => {
  const store = fakeStore({ nodes: [node('m1')], edges: [], events: [] });
  bg.enterView('M');
  const h = bg.bindCanvas(store.set, store.get);
  const release = h.hold();
  let aborted = 0;
  const untrack = bg.trackStream('m1', 'M', () => { aborted++; });
  assert.equal(bg.useBackground.getState().streams.m1, 'M');
  bg.leaveView('M', { nodes: store.get().nodes, edges: [], events: [] });
  bg.enterView('N');
  answer(h, 'm1', 'doomed');
  const before = written.length;
  await bg.dropCanvas('M');
  assert.equal(aborted, 1);
  untrack();
  release();
  await tick(); await tick();
  assert.equal(written.length, before, 'no write after the drop');
  assert.equal(bg.takeShadow('M'), null);
  assert.equal(bg.useBackground.getState().streams.m1, undefined);
});

test('the organizer waits while work goes on out of view, and idle shadows can be let go', async () => {
  const store = fakeStore({ nodes: [node('o1')], edges: [], events: [] });
  bg.enterView('O');
  const h = bg.bindCanvas(store.set, store.get);
  const release = h.hold();
  bg.leaveView('O', { nodes: store.get().nodes, edges: [], events: [] });
  bg.enterView('P');
  assert.equal(bg.backgroundBusy(), true);
  answer(h, 'o1', 'done');
  release();
  await tick(); await tick();
  assert.equal(bg.backgroundBusy(), false);
  bg.dropIdleShadows();
  assert.equal(bg.takeShadow('O'), null);
});

test('an agent run changing a node out of view changes the shadow when there is one', () => {
  const store = fakeStore({ nodes: [node('q1')], edges: [], events: [] });
  bg.enterView('Q');
  const release = bg.bindCanvas(store.set, store.get).hold();
  bg.leaveView('Q', { nodes: store.get().nodes, edges: [], events: [] });
  bg.enterView('R');
  assert.equal(bg.patchShadowNode('Q', 'q1', () => ({ response: 'from the run' })), true);
  assert.equal(bg.patchShadowNode('nowhere', 'q1', () => ({})), false);
  assert.equal(responseOf(bg.takeShadow('Q'), 'q1'), 'from the run');
  release();
});

test('answers finished out of view are announced once each and handed over on return', () => {
  bg.noteFinished('S', 's1', true);
  bg.noteFinished('S', 's1', true);
  bg.noteFinished('S', 's2', false);
  assert.deepEqual(bg.takeFinished('S'), ['s1', 's2']);
  assert.deepEqual(bg.takeFinished('S'), []);
  assert.deepEqual(announced.filter((a) => a.startsWith('S/')), ['S/s1/true', 'S/s1/true', 'S/s2/false']);
});
