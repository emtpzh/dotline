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
const bundle = join(tmp, 'pristine.mjs');
execFileSync(join(ROOT, 'node_modules/.bin/esbuild'), [
  join(ROOT, 'src/lib/agents/pristine.ts'), '--bundle', '--format=esm', '--platform=node',
  `--outfile=${bundle}`, '--define:import.meta.env.VITE_API_BASE=""', '--define:import.meta.env.DEV=false',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const { pristineChain } = await import(pathToFileURL(bundle).href);

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
  // the session's own tool footprints are part of what it recorded
  const Bt = mirror('B', undefined, undefined, { attachments: [{ id: 't1', name: 'tool: read a.txt', type: 'text/plain', content: '…', op: 'read' }] });
  assert.equal(pristineChain('D', [mirror('A'), Bt, ask('D')], [edge('A', 'B'), edge('B', 'D')]), true);
  // on the question itself: a document would not travel with a continued turn
  assert.equal(pristineChain('D', [mirror('A'), mirror('B'), ask('D', { attachments: [doc] })], [edge('A', 'B'), edge('B', 'D')]), false);
  // an image does travel
  assert.equal(pristineChain('D', [mirror('A'), mirror('B'), ask('D', { attachments: [{ id: 'i1', name: 'shot.png', type: 'image/png', content: 'b64' }] })], [edge('A', 'B'), edge('B', 'D')]), true);
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
