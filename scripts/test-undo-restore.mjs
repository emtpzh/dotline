#!/usr/bin/env node
// What an undo puts back: the canvas as the snapshot holds it, less what
// runs did. A snapshot taken while a run answered a node must not bring that
// run back once it is over (the node would load for good), a node the step
// removes stops its run, and one it brings back has no run going.
//
// Run: node scripts/test-undo-restore.mjs
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'td-undo-restore-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const out = join(dir, 'bundle.mjs');
await build({ entryPoints: [`${process.cwd()}/src/lib/undo-restore.ts`], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const { restoreNodes } = await import(out);

const node = (id, data = {}, position = { x: 0, y: 0 }) => ({ id, type: 'thought', position, data: { question: id, response: '', responses: [], isLoading: false, ...data } });
const run = { runtime: 'codex', question: 'q', startedAt: '2026-10-15T03:36:10.883Z', runId: 'r1', bootId: 'b1' };

test('a run that is over stays over: the snapshot from mid-run does not bring it back', () => {
  // the snapshot: the first answer in, the second still running
  const snap = [node('a', { response: 'A', responses: ['A'] }), node('b', { isLoading: true, run, response: 'partial' })];
  // now: the second answered, and a follow-up asked under it
  const settledB = node('b', { response: 'B', responses: ['B'] });
  const now = [snap[0], settledB, node('c', { isLoading: true, run: { ...run, runId: 'r2' } })];
  const { nodes, stop } = restoreNodes(now, snap);
  assert.deepEqual(nodes.map((n) => n.id), ['a', 'b']);
  assert.equal(nodes[1].data, settledB.data);
  assert.equal(nodes[1].data.isLoading, false);
  assert.deepEqual(stop, ['c']);
});

test('a run going now keeps going: its node is not put back to before it', () => {
  const before = node('b', { response: 'old', responses: ['old'] }, { x: 0, y: 0 });
  const live = node('b', { isLoading: true, run, response: '' }, { x: 5, y: 5 });
  const { nodes, stop } = restoreNodes([live], [before]);
  assert.equal(nodes[0].data, live.data);
  // the rest of the node is the snapshot's
  assert.deepEqual(nodes[0].position, { x: 0, y: 0 });
  assert.deepEqual(stop, []);
});

test('a node brought back has no run going', () => {
  const { nodes } = restoreNodes([], [node('b', { isLoading: true, run })]);
  assert.equal(nodes[0].data.isLoading, false);
});

test('what the person did is undone as before', () => {
  const snap = [node('a', { response: 'A', responses: ['A', 'A2'] })];
  const now = [node('a', { response: 'A', responses: ['A'] }), node('d')];
  const { nodes, stop } = restoreNodes(now, snap);
  assert.equal(nodes[0], snap[0]);
  assert.deepEqual(stop, []);
});
