// Verify the real independent-import path without browser persistence.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'dotline-placement-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const mocks = {
  '../../store': `
    export const useStore = {
      getState: () => globalThis.fixture.graph,
      setState: update => Object.assign(globalThis.fixture.graph, update(globalThis.fixture.graph)),
    };
    export const stripTransient = x => x;
  `,
  '../../store/projects': `
    export const useProjects = { getState: () => globalThis.fixture };
    export const switchProject = async id => { globalThis.fixture.activeId = id; };
    export const createProject = async name => {
      globalThis.fixture.projects.push({ id: 'new', name });
      globalThis.fixture.graph.nodes = []; globalThis.fixture.graph.edges = [];
      return 'new';
    };
    export const findSubscription = sid => globalThis.fixture.subscriptions.find(s => s.sessionId === sid);
    export const addSubscription = async (id, sub) => { globalThis.fixture.subscriptions.push({ ...sub, projectId: id }); };
    export const adoptImportedProject = () => {};
    export const projectStorageKey = x => x;
    export const removeSubscription = () => {};
    export const subscribedSessionIds = () => [];
    export const subscriptionsOf = () => [];
    export const mainSubscription = () => null;
    export const takenCount = () => 0;
  `,
  '../ui-store': `export const useUiStore = { getState: () => ({ setArrivalFocusNodeId: id => { globalThis.fixture.focus = id; } }) }; export const toast = () => {};`,
  '../../i18n': `export const t = x => x; export const fmt = x => x;`,
  '../sessions/sync': `export const placeSegment = () => {}; export const syncConversation = () => {};`,
};
await build({
  stdin: { contents: `export { mergeSessionsIntoProject } from './src/lib/atlas/canonical';`, resolveDir: process.cwd() },
  outfile: join(dir, 'placement.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'persistence-fixture', setup(b) {
    b.onResolve({ filter: /.*/ }, args => args.importer.endsWith('/atlas/canonical.ts') && mocks[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
  } }],
});
const { mergeSessionsIntoProject } = await import(join(dir, 'placement.mjs'));
const node = (id, x, y, sid) => ({ id, position: { x, y }, width: 400, data: { importSource: { sessionId: sid, itemIds: [id] } } });
const conversation = sid => ({ sessionId: sid, title: sid, source: 'codex', build: () => ({
  nodes: [node(`${sid}-1`, 20, 50, sid), node(`${sid}-2`, 20, 350, sid)],
  edges: [{ id: `${sid}-edge`, source: `${sid}-1`, target: `${sid}-2` }],
}) });
beforeEach(() => {
  globalThis.fixture = { activeId: 'current', projects: [{ id: 'current' }], subscriptions: [], graph: { nodes: [node('existing', 100, 100, '')], edges: [], pushHistory() {} } };
});
after(() => { delete globalThis.fixture; });

test('one session joins the current canvas without connecting to its existing nodes', async () => {
  const before = structuredClone(globalThis.fixture.graph.nodes[0]);
  const result = await mergeSessionsIntoProject([conversation('one')], 'current');
  assert.equal(result.mounted, 1);
  assert.equal(globalThis.fixture.projects.length, 1);
  assert.deepEqual(globalThis.fixture.graph.nodes[0], before);
  const [, head, tail] = globalThis.fixture.graph.nodes;
  assert.equal(head.position.x, tail.position.x);
  assert.ok(tail.position.y > head.position.y);
  assert.ok(head.position.x > before.position.x + before.width);
  assert.deepEqual(globalThis.fixture.graph.edges.map(e => [e.source, e.target]), [['one-1', 'one-2']]);
  assert.equal(globalThis.fixture.subscriptions[0].tailNodeId, 'one-2');
});

test('batch import stays independent and repeated imports do not duplicate nodes', async () => {
  await mergeSessionsIntoProject([conversation('one'), conversation('two')], 'current');
  assert.equal(globalThis.fixture.graph.nodes.length, 5);
  assert.equal(globalThis.fixture.subscriptions.length, 2);
  assert.deepEqual(globalThis.fixture.graph.edges.map(e => [e.source, e.target]), [['one-1', 'one-2'], ['two-1', 'two-2']]);
  const result = await mergeSessionsIntoProject([conversation('one')], 'current');
  assert.equal(result.mounted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(globalThis.fixture.graph.nodes.length, 5);
});

test('a new canvas can hold a single session', async () => {
  const result = await mergeSessionsIntoProject([conversation('one')]);
  assert.equal(result.projectId, 'new');
  assert.equal(globalThis.fixture.projects.at(-1).name, 'one');
  assert.equal(globalThis.fixture.activeId, 'new');
  assert.equal(globalThis.fixture.graph.nodes.length, 2);
});
