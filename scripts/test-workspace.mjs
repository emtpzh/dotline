#!/usr/bin/env node
// The open canvases as tabs: where an opened canvas lands, which tab takes
// the place of one leaving, how a dragged tab moves, what survives a canvas
// list that changed under the tabs, and which tab the keys reach.
//
// Run: node scripts/test-workspace.mjs
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'td-workspace-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const out = join(dir, 'bundle.mjs');
await build({ entryPoints: [`${process.cwd()}/src/lib/workspace.ts`], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const { withOpened, neighbourOf, withClosed, withMoved, reconcileOpen, tabAt, tabBeside } = await import(out);

test('an opened canvas lands right after the tab it was opened from', () => {
  assert.deepEqual(withOpened(['a', 'b', 'c'], 'x', 'a'), ['a', 'x', 'b', 'c']);
  assert.deepEqual(withOpened(['a', 'b', 'c'], 'x', 'c'), ['a', 'b', 'c', 'x']);
});

test('an opened canvas with no tab to follow goes to the end', () => {
  assert.deepEqual(withOpened(['a', 'b'], 'x', null), ['a', 'b', 'x']);
  assert.deepEqual(withOpened(['a', 'b'], 'x', 'gone'), ['a', 'b', 'x']);
  assert.deepEqual(withOpened([], 'x', null), ['x']);
});

test('a canvas already open keeps its place', () => {
  const open = ['a', 'b', 'c'];
  assert.deepEqual(withOpened(open, 'c', 'a'), ['a', 'b', 'c']);
  assert.notEqual(withOpened(open, 'c', 'a'), open, 'a new list, never the same one');
});

test('the tab to the right takes the place of one leaving, else the one to the left', () => {
  assert.equal(neighbourOf(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(neighbourOf(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(neighbourOf(['a'], 'a'), null);
  assert.equal(neighbourOf(['a', 'b'], 'gone'), 'a');
  assert.equal(neighbourOf([], 'gone'), null);
});

test('a closed canvas leaves the tabs and nothing else moves', () => {
  assert.deepEqual(withClosed(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(withClosed(['a', 'b'], 'gone'), ['a', 'b']);
});

test('a dragged tab lands at the index it is given, counted without it', () => {
  assert.deepEqual(withMoved(['a', 'b', 'c', 'd'], 'a', 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(withMoved(['a', 'b', 'c', 'd'], 'd', 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(withMoved(['a', 'b', 'c'], 'b', 99), ['a', 'c', 'b']);
  assert.deepEqual(withMoved(['a', 'b', 'c'], 'b', -3), ['b', 'a', 'c']);
  assert.deepEqual(withMoved(['a', 'b'], 'gone', 0), ['a', 'b']);
});

test('the tabs follow the canvas list: gone, archived and repeated canvases leave', () => {
  const canvases = [{ id: 'a' }, { id: 'b', archived: true }, { id: 'c' }];
  assert.deepEqual(reconcileOpen(['a', 'b', 'c', 'a', 'zz'], canvases, 'a'), ['a', 'c']);
});

test('the canvas in view is always open, first when it was missing', () => {
  const canvases = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(reconcileOpen(['b'], canvases, 'c'), ['c', 'b']);
  // a list from before tabs opens the canvas in view alone
  assert.deepEqual(reconcileOpen(undefined, canvases, 'b'), ['b']);
  // an archived canvas in view (opening it unarchives it) is still open
  assert.deepEqual(reconcileOpen([], [{ id: 'a', archived: true }], 'a'), ['a']);
  // a canvas in view that is gone from the list is not
  assert.deepEqual(reconcileOpen(['a'], canvases.slice(0, 1), 'gone'), ['a']);
});

test('the keys count tabs from 1, and 9 is always the last one', () => {
  const open = ['a', 'b', 'c'];
  assert.equal(tabAt(open, 1), 'a');
  assert.equal(tabAt(open, 3), 'c');
  assert.equal(tabAt(open, 4), null);
  assert.equal(tabAt(open, 9), 'c');
  assert.equal(tabAt([], 1), null);
  const many = 'abcdefghijk'.split('');
  assert.equal(tabAt(many, 8), 'h');
  assert.equal(tabAt(many, 9), 'k');
});

test('the tab beside the one in view wraps around the ends', () => {
  const open = ['a', 'b', 'c'];
  assert.equal(tabBeside(open, 'b', 1), 'c');
  assert.equal(tabBeside(open, 'c', 1), 'a');
  assert.equal(tabBeside(open, 'a', -1), 'c');
  assert.equal(tabBeside(['a'], 'a', 1), null);
  assert.equal(tabBeside(open, 'gone', 1), 'a');
});
