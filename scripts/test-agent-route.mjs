#!/usr/bin/env node
// When a session may stand in for the canvas's context: a follow-up continues
// (or forks) an agent session only while the canvas above it still says what
// the session recorded. Bundled for node the way test-layout.mjs does it.
//
// Run: node scripts/test-agent-route.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'tdag-route-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const build = (name) => {
  const out = join(tmp, `${name}.mjs`);
  execFileSync(join(ROOT, 'node_modules/.bin/esbuild'), [
    join(ROOT, `src/lib/agents/${name}.ts`), '--bundle', '--format=esm', '--platform=node',
    `--outfile=${out}`, '--define:import.meta.env.VITE_API_BASE=""', '--define:import.meta.env.DEV=false',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return import(pathToFileURL(out).href);
};
const { pristineChain } = await build('pristine');
const { continuity } = await build('continuity');

/** A mirrored turn: what the session recorded, and the canvas showing the same. */
const mirror = (id, q = `q-${id}`, r = `r-${id}`, extra = {}) => ({
  id, type: 'thought', position: { x: 0, y: 0 },
  data: { question: q, response: r, source: { question: q, response: r }, importSource: { runner: 'pi', sessionId: 's1', itemIds: [`${id}-u`, `${id}-a`] }, attachments: [], ...extra },
});
const ask = (id, extra = {}) => ({ id, type: 'thought', position: { x: 0, y: 0 }, data: { question: 'next?', response: '', attachments: [], ...extra } });
const edge = (source, target, data) => ({ id: `${source}-${target}`, source, target, ...(data ? { data } : {}) });

test('a question under untouched mirrored turns can lean on the session', () => {
  const nodes = [mirror('A'), mirror('B'), ask('D')];
  assert.equal(pristineChain('D', nodes, [edge('A', 'B'), edge('B', 'D')]), true);
});

test('an answer edited on the canvas above the question keeps the session out', () => {
  const B = mirror('B');
  B.data.response = 'rewritten on the canvas';
  assert.equal(pristineChain('D', [mirror('A'), B, ask('D')], [edge('A', 'B'), edge('B', 'D')]), false);
  const A = mirror('A');
  A.data.question = 'asked differently';
  assert.equal(pristineChain('D', [A, mirror('B'), ask('D')], [edge('A', 'B'), edge('B', 'D')]), false);
});

test('a turn the canvas sent with its context ahead still reads as untouched', () => {
  // an adopted agent turn records the whole prompt; the node shows the question as asked
  const B = mirror('B', 'the question as asked');
  B.data.source = { question: '[ThoughtDAG canvas context] …\n\n---\n\nthe question as asked', response: B.data.response };
  assert.equal(pristineChain('D', [mirror('A'), B, ask('D')], [edge('A', 'B'), edge('B', 'D')]), true);
});

test('a turn the session never held keeps the session out', () => {
  const plain = { id: 'P', type: 'thought', position: { x: 0, y: 0 }, data: { question: 'typed on the canvas', response: 'answered by a model', attachments: [] } };
  assert.equal(pristineChain('D', [mirror('A'), plain, ask('D')], [edge('A', 'P'), edge('P', 'D')]), false);
});

test('a document added on the canvas, above or on the question, keeps the session out', () => {
  const doc = { id: 'att1', name: 'notes.md', type: 'text/markdown', content: 'x' };
  const B = mirror('B', undefined, undefined, { attachments: [doc] });
  assert.equal(pristineChain('D', [mirror('A'), B, ask('D')], [edge('A', 'B'), edge('B', 'D')]), false);
  // left out of context: no longer a difference
  const Bx = mirror('B', undefined, undefined, { attachments: [doc], excludedAttachmentIds: ['att1'] });
  assert.equal(pristineChain('D', [mirror('A'), Bx, ask('D')], [edge('A', 'B'), edge('B', 'D')]), true);
  // the session's own steps are part of what it recorded
  const Bt = mirror('B', undefined, undefined, { steps: [{ id: 't1', tool: 'read', op: 'read', call: 'a.txt', result: '…', paths: ['a.txt'] }] });
  assert.equal(pristineChain('D', [mirror('A'), Bt, ask('D')], [edge('A', 'B'), edge('B', 'D')]), true);
  // on the question itself: a document would not travel with a continued turn
  assert.equal(pristineChain('D', [mirror('A'), mirror('B'), ask('D', { attachments: [doc] })], [edge('A', 'B'), edge('B', 'D')]), false);
  // an image does travel
  assert.equal(pristineChain('D', [mirror('A'), mirror('B'), ask('D', { attachments: [{ id: 'i1', name: 'shot.png', type: 'image/png', content: 'b64' }] })], [edge('A', 'B'), edge('B', 'D')]), true);
  // and once it has, the turn above that carried it is still the session's
  const shot = (addedAt) => ({ id: 'i1', name: 'shot.png', type: 'image/png', content: 'b64', addedAt });
  const Bi = mirror('B', undefined, undefined, { attachments: [shot('2026-10-07T09:16:00Z')], lastGeneratedAt: '2026-10-07T09:16:40Z' });
  assert.equal(pristineChain('D', [mirror('A'), Bi, ask('D')], [edge('A', 'B'), edge('B', 'D')]), true);
  // an image added after the turn ran is the canvas's
  const Bl = mirror('B', undefined, undefined, { attachments: [shot('2026-10-07T09:20:00Z')], lastGeneratedAt: '2026-10-07T09:16:40Z' });
  assert.equal(pristineChain('D', [mirror('A'), Bl, ask('D')], [edge('A', 'B'), edge('B', 'D')]), false);
});

test('a note wired in or a dashed reference keeps the session out', () => {
  const note = { id: 'N', type: 'thought', position: { x: 0, y: 0 }, data: { question: '', response: 'a note', stepKind: 'note', attachments: [] } };
  assert.equal(pristineChain('D', [mirror('A'), mirror('B'), note, ask('D')], [edge('A', 'B'), edge('B', 'D'), edge('N', 'D')]), false);
  const other = mirror('X');
  assert.equal(pristineChain('D', [mirror('A'), mirror('B'), other, ask('D')], [edge('A', 'B'), edge('B', 'D'), edge('X', 'D', { isCrossLink: true })]), false);
});

test('reshaping a turn on its way into context keeps the session out; folding it does not', () => {
  const edges = [edge('A', 'B'), edge('B', 'D')];
  const hl = [{ id: 'h1', text: 'r-B' }];
  assert.equal(pristineChain('D', [mirror('A'), mirror('B', undefined, undefined, { archived: true }), ask('D')], edges), false);
  assert.equal(pristineChain('D', [mirror('A'), mirror('B', undefined, undefined, { highlightMode: 'filter', highlights: hl }), ask('D')], edges), false);
  assert.equal(pristineChain('D', [mirror('A'), mirror('B', undefined, undefined, { highlightMode: 'tag', highlights: hl }), ask('D')], edges), false);
  // highlights kept but not applied to context
  assert.equal(pristineChain('D', [mirror('A'), mirror('B', undefined, undefined, { highlightMode: 'off', highlights: hl }), ask('D')], edges), true);
  assert.equal(pristineChain('D', [mirror('A'), mirror('B', undefined, undefined, { collapsed: true, summary: 'short' }), ask('D')], edges), true);
});

test('a role over the chain, or a passage the question was explored from, keeps the session out', () => {
  const edges = [edge('A', 'B'), edge('B', 'D')];
  assert.equal(pristineChain('D', [mirror('A', undefined, undefined, { rolePrompt: 'be terse', roleMode: 'inherit' }), mirror('B'), ask('D')], edges), false);
  assert.equal(pristineChain('D', [mirror('A'), mirror('B'), ask('D', { branchContext: 'a passage of B' })], edges), false);
});

// ── continuity: one vertical line is one agent session ──
// A question off a session's tail continues it; anything that would make
// the session's record disagree with the canvas opens a new one, and says
// why. The ask boxes warn from this and the send routes by it.

const tail = [{ runner: 'pi', sessionId: 's1', tailNodeId: 'B' }];
const chain = [edge('A', 'B'), edge('B', 'D')];

test('a question off the tail of a mirrored session continues it', () => {
  const c = continuity('D', [mirror('A'), mirror('B'), ask('D')], chain, 'pi', undefined, tail);
  assert.equal(c.kind, 'continue');
  assert.equal(c.sessionId, 's1');
});

test('an ordinary line has no session to continue or to break', () => {
  const plain = (id) => ({ id, type: 'thought', position: { x: 0, y: 0 }, data: { question: 'q', response: 'r', attachments: [] } });
  assert.equal(continuity('D', [plain('A'), plain('B'), ask('D')], chain, 'pi', undefined, tail), null);
  assert.equal(continuity('D', [plain('A'), plain('B'), ask('D')], chain, null, undefined, tail), null);
});

test('another runtime, a plain model or another directory opens a new session', () => {
  const nodes = [mirror('A'), mirror('B', undefined, undefined, { importSource: { runner: 'pi', sessionId: 's1', itemIds: ['b'], cwd: '/repo' } }), ask('D')];
  const codex = continuity('D', nodes, chain, 'codex', undefined, tail);
  assert.deepEqual([codex.kind, codex.reason, codex.detail], ['new', 'runtime', 'Codex']);
  const plain = continuity('D', nodes, chain, null, undefined, tail);
  assert.deepEqual([plain.kind, plain.reason, plain.detail], ['new', 'runtime', undefined]);
  const moved = continuity('D', nodes, chain, 'pi', '/elsewhere', tail);
  assert.deepEqual([moved.kind, moved.reason], ['new', 'cwd']);
  assert.equal(continuity('D', nodes, chain, 'pi', '/repo', tail).kind, 'continue');
});

test('the reason names what the canvas added: a role, a material, a reference, an edit', () => {
  const role = continuity('D', [mirror('A'), mirror('B'), ask('D', { rolePrompt: 'You are a skeptic.' })], chain, 'pi', undefined, tail);
  assert.deepEqual([role.reason, role.about], ['role', 'D']);
  const note = { id: 'N', type: 'thought', position: { x: 0, y: 0 }, data: { question: 'repro steps', response: '', stepKind: 'note', attachments: [] } };
  const mat = continuity('D', [mirror('A'), mirror('B'), note, ask('D')], [...chain, edge('N', 'A')], 'pi', undefined, tail);
  assert.deepEqual([mat.reason, mat.about], ['material', 'N']);
  const ref = continuity('D', [mirror('A'), mirror('B'), mirror('X'), ask('D')], [...chain, edge('X', 'D', { isCrossLink: true })], 'pi', undefined, tail);
  assert.deepEqual([ref.reason, ref.about], ['reference', 'X']);
  const B = mirror('B');
  B.data.response = 'rewritten on the canvas';
  const edited = continuity('D', [mirror('A'), B, ask('D')], chain, 'pi', undefined, tail);
  assert.deepEqual([edited.reason, edited.about], ['edited', 'B']);
  const merged = continuity('D', [mirror('A'), mirror('B'), ask('D')], [...chain, edge('A', 'D')], 'pi', undefined, tail);
  assert.equal(merged.reason, 'merge');
});

test('off an earlier turn: a runtime that can cut the session forks it there, one that cannot opens a new one', () => {
  const nodes = [mirror('A'), mirror('B'), ask('D')];
  const edges = [edge('A', 'B'), edge('A', 'D')];
  const fork = continuity('D', nodes, edges, 'pi', undefined, tail);
  assert.deepEqual([fork.kind, fork.turn], ['fork', 1]);
  const cc = (id) => mirror(id, undefined, undefined, { importSource: { runner: 'claude-code', sessionId: 's2', itemIds: [id] } });
  const noFork = continuity('D', [cc('A'), cc('B'), ask('D')], edges, 'claude-code', undefined, [{ runner: 'claude-code', sessionId: 's2', tailNodeId: 'B' }]);
  assert.deepEqual([noFork.kind, noFork.reason], ['new', 'no-fork']);
});

test('off the tail of a session the canvas does not follow, there is nothing to go on in', () => {
  const cc = (id) => mirror(id, undefined, undefined, { importSource: { runner: 'claude-code', sessionId: 's2', itemIds: [id] } });
  const c = continuity('D', [cc('A'), cc('B'), ask('D')], chain, 'claude-code', undefined, []);
  assert.deepEqual([c.kind, c.reason], ['new', 'unfollowed']);
});

test('the fork counts turns of its own session only', () => {
  const nodes = [mirror('A'), mirror('B'), mirror('C'), ask('D')];
  const edges = [edge('A', 'B'), edge('B', 'C'), edge('B', 'D')];
  assert.equal(continuity('D', nodes, edges, 'pi', undefined, [{ runner: 'pi', sessionId: 's1', tailNodeId: 'C' }]).turn, 2);
});
