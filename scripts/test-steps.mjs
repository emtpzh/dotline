#!/usr/bin/env node
// An agent turn's tool calls are steps, apart from the person's
// attachments. A canvas from before steps carried them as attachments; it
// is lifted on load, and lifting never changes what an answer's upstream
// compiles to — no answer turns stale because the canvas was upgraded.
//
// Run: node scripts/test-steps.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'tdag-steps-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const entry = join(tmp, 'entry.ts');
writeFileSync(entry, [
  `export * from ${JSON.stringify(join(ROOT, 'src/lib/agents/steps.ts'))};`,
  `export { buildContext, upstreamFingerprint } from ${JSON.stringify(join(ROOT, 'src/store/context-builder.ts'))};`,
  `export { liftCanvas } from ${JSON.stringify(join(ROOT, 'src/store/lift.ts'))};`,
].join('\n'));
const out = join(tmp, 'steps.mjs');
execFileSync(join(ROOT, 'node_modules/.bin/esbuild'), [
  entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`,
  '--define:import.meta.env.VITE_API_BASE=""', '--define:import.meta.env.DEV=false',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const { liftSteps, liftCanvas, stepSummary, commandOf, buildContext, upstreamFingerprint } = await import(pathToFileURL(out).href);

const node = (id, data) => ({ id, type: 'thought', position: { x: 0, y: 0 }, data: { question: `q-${id}`, response: `r-${id}`, attachments: [], ...data } });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target });
const toolAtt = (id, name, call, result, extra = {}) => ({
  id, name, type: 'text/plain', size: call.length + result.length, content: `[call] ${call}\n[result]\n${result}`, ...extra,
});

// A canvas as it was before steps: a turn run from the canvas (its tool
// calls excluded, the file-system footprint among them), an imported turn
// (its tool calls in context in full), and the person's own image.
const shot = { id: 'img', name: 'shot.png', type: 'image/png', size: 3, content: 'b64' };
const before = () => [
  node('A', {
    attachments: [
      shot,
      toolAtt('a1', 'tool: bash', '{"command":"ls -lat | head"}', 'total 8', { op: 'run' }),
      toolAtt('a2', 'tool: read', 'src/a.ts', 'export {}', { op: 'read', paths: ['src/a.ts'] }),
      { id: 'fs-1', name: 'tool: fs-changes', type: 'text/plain', size: 0, content: 'Changed on disk…\n- out.txt', op: 'write', paths: ['/repo/out.txt'] },
    ],
    excludedAttachmentIds: ['a1', 'a2', 'fs-1'],
    agentSession: { runtime: 'pi', cwd: '/repo' },
  }),
  node('B', {
    attachments: [toolAtt('b1', 'tool: Edit (truncated)', 'src/b.ts\n--- old\nx\n+++ new\ny', 'ok', { op: 'edit', paths: ['src/b.ts'] })],
    importSource: { runner: 'claude-code', sessionId: 's', itemIds: [], cwd: '/repo' },
  }),
  node('C', {}),
];
const edges = [edge('A', 'B'), edge('B', 'C')];

test('lifting moves tool calls into steps and leaves the person\'s attachments', () => {
  const nodes = liftSteps(before());
  const A = nodes[0].data;
  assert.deepEqual(A.attachments.map((a) => a.id), ['img']);
  assert.deepEqual(A.steps.map((s) => [s.id, s.tool, s.op ?? null]), [['a1', 'bash', 'run'], ['a2', 'read', 'read'], ['fs-1', 'fs-changes', 'write']]);
  assert.deepEqual(A.excludedAttachmentIds, []);
  assert.equal(A.includedStepIds, undefined);
  // an imported turn's calls went downstream in full: they still do
  const B = nodes[1].data;
  assert.deepEqual(B.includedStepIds, ['b1']);
  assert.equal(B.steps[0].truncated, true);
  // the footprint did not rebuild exactly: it keeps what it was
  assert.ok(A.steps[2].legacy);
  assert.equal(A.steps[0].legacy, undefined);
  // lifting twice changes nothing
  assert.equal(liftSteps(nodes), nodes);
});

test('a lifted canvas compiles as it did, and its recorded fingerprints stay current', () => {
  // the fingerprints recorded before: the old compile, i.e. the legacy line
  const lifted = liftSteps(before());
  const recorded = Object.fromEntries(['B', 'C'].map((id) => [id, upstreamFingerprint(id, lifted, edges, { legacySummary: true })]));
  const old = before().map((n) => (recorded[n.id] ? { ...n, data: { ...n.data, lastContextHash: recorded[n.id] } } : n));
  old[2].data.lastContextHash = 'stale-already';
  const nodes = liftCanvas(old, edges);
  // re-recorded the way the canvas compiles now
  assert.equal(nodes[1].data.lastContextHash, upstreamFingerprint('B', nodes, edges));
  // an answer that was stale stays stale
  assert.equal(nodes[2].data.lastContextHash, 'stale-already');
  // the legacy line and the in-full output, as they always read
  const legacy = buildContext('C', nodes, edges, undefined, undefined, undefined, undefined, { legacySummary: true }).messages.map((m) => m.content);
  assert.ok(legacy.includes('[Files this turn touched in /repo — contents not included] read: a.ts; write: out.txt'));
  assert.ok(legacy.includes('[File: tool: Edit (truncated)]\n[call] src/b.ts\n--- old\nx\n+++ new\ny\n[result]\nok'));
});

test('downstream sees one line of what the turn did, outputs left out', () => {
  // as a canvas loads: its steps lifted, its old run record with them
  const nodes = liftCanvas(before(), edges);
  const msgs = buildContext('C', nodes, edges).messages.map((m) => m.content);
  assert.ok(msgs.includes('[What this turn did in /repo — outputs left out] ran: ls -lat | head; read: a.ts; write: out.txt'), msgs.join('\n---\n'));
  assert.ok(!msgs.some((m) => m.includes('total 8')));
  // the person brings one step in: its output goes in full, and it leaves the line
  nodes[0].data.includedStepIds = ['a1'];
  const withOne = buildContext('C', nodes, edges).messages.map((m) => m.content);
  assert.ok(withOne.includes('[File: tool: bash]\n[call] {"command":"ls -lat | head"}\n[result]\ntotal 8'));
  assert.ok(withOne.includes('[What this turn did in /repo — outputs left out] read: a.ts; write: out.txt'));
});

test('a command reads as the person would type it', () => {
  assert.equal(commandOf({ call: '{"command":"npm test"}' }), 'npm test');
  assert.equal(commandOf({ call: '{"cmd":["bash","-lc","git status"]}' }), 'bash -lc git status');
  assert.equal(commandOf({ call: 'git diff\nsecond line' }), 'git diff');
  assert.equal(stepSummary([{ id: 'x', tool: 'search', op: 'search', call: 'q', result: '' }], undefined), null);
  // a step that never had an op is still a shell call by its name
  assert.equal(stepSummary([{ id: 'y', tool: 'bash', call: '{"command":"make"}', result: '' }], undefined), '[What this turn did — outputs left out] ran: make');
});

test('a canvas run recorded the old way folds into what the node keeps now; its answers stay current', () => {
  const ran = (id, extra) => node(id, {
    responses: [`r-${id}`], responseIndex: 0, generatedBy: [undefined],
    steps: [{ id: `${id}-s`, tool: 'bash', op: 'run', call: 'ls', result: 'x', paths: ['out.txt'] }], ...extra,
  });
  const old = [
    ran('A', { agentSession: { runtime: 'pi', sessionId: 'p1', sessionFile: '/f', cwd: '/repo', effort: 'high', access: 'write', model: 'pi/x/y' } }),
    ran('B', { agentSession: { runtime: 'pi', sessionId: 'p1', sessionFile: '/f', cwd: '/repo', pending: true, model: 'pi/x/y' } }),
    node('C', {}),
  ];
  const edges = [edge('A', 'B'), edge('B', 'C')];
  for (const n of old) n.data.lastContextHash = upstreamFingerprint(n.id, old, edges);
  const nodes = liftCanvas(old, edges);
  const [A, B] = nodes.map((n) => n.data);
  assert.equal('agentSession' in A, false);
  assert.deepEqual([A.access, A.cwd, A.generatedBy[0], A.generatedEfforts[0]], ['write', '/repo', 'pi/x/y', 'high']);
  // a run that was still going is a binding the session sync finds its turn by
  assert.deepEqual([B.run.runtime, B.run.sessionId, B.run.question, B.run.model], ['pi', 'p1', 'q-B', 'pi/x/y']);
  for (const n of nodes) assert.equal(n.data.lastContextHash, upstreamFingerprint(n.id, nodes, edges), `${n.id} stays current`);
});
