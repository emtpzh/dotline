#!/usr/bin/env node
// The organizer's model grouping (src/lib/organize/grouping.ts), with a fake
// model. What is checked is the cost and the stability, not the grouping:
//   - groups are defined once from a bounded prompt, then batches sort the
//     conversations side by side, never more than PARALLEL at a time
//   - reopening on unchanged conversations asks nothing; a few new ones
//     are sorted into the remembered groups; many new ones redefine them,
//     and a group that survives keeps its key and its conversations
//   - a conversation keeps its place after the organizer moved it
//   - a batch the model fumbles is asked once more; a dead batch costs only
//     its own conversations
//   - a rebuilt draft teaches the memory its names and moves
//
// Run: node scripts/test-organize.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'tdag-organize-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const bundle = join(tmp, 'grouping.mjs');
execFileSync(join(ROOT, 'node_modules/.bin/esbuild'), [
  join(ROOT, 'src/lib/organize/grouping.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
const G = await import(pathToFileURL(bundle).href);

const SUBJECTS = ['cooking', 'travel', 'rust'];
const thread = (canvasId, n, subject = SUBJECTS[n % 3]) => ({
  id: `${canvasId}:node-${n}`, canvasId, nodeIds: [`node-${n}`],
  title: `${subject} question ${n}`, turns: [`${subject} question ${n}`, `${subject} follow-up`],
  lastAt: 1_000_000 + n, fixed: false,
});
const many = (from, count, canvasId = n => (n % 2 ? 'a' : 'b')) => Array.from({ length: count }, (_, i) => thread(canvasId(from + i), from + i));
const CANVASES = [{ id: 'a', name: 'Mixed A' }, { id: 'b', name: 'Mixed B' }, { id: 'c', name: 'Elsewhere' }];

/** A model that defines one group per subject and sorts by the subject in
 *  each line. `fumble(batchIndex)` may drop or break a reply. */
function fakeModel({ fumble, names = ['Cooking', 'Travel', 'Rust'] } = {}) {
  const calls = { define: 0, assign: 0, live: 0, peak: 0, prompts: [] };
  const ask = async (prompt) => {
    calls.prompts.push(prompt);
    const defining = prompt.startsWith('A person keeps');
    // numbered as sent, so a fumble picks the same batch every run
    const index = defining ? calls.define++ : calls.assign++;
    calls.live++; calls.peak = Math.max(calls.peak, calls.live);
    await new Promise((r) => setTimeout(r, 5));
    calls.live--;
    if (defining) return JSON.stringify({ groups: names.map((name) => ({ name, reason: `about ${name}`, covers: `${name.toLowerCase()} talk` })) });
    const groups = [...prompt.matchAll(/^G(\d+) (\S+):/gm)].map((m) => [Number(m[1]), m[2].toLowerCase()]);
    const lines = [...prompt.matchAll(/^\[(\d+)\] \(canvas: [^)]*\) (\w+)/gm)].map(([, i, subject]) => {
      const g = groups.find(([, n]) => n === subject);
      return `${i} ${g ? `G${g[0]}` : '-'}`;
    });
    return fumble ? fumble(index, lines) : lines.join('\n');
  };
  return { ask, calls };
}

const run = (ask, threads, memory, extra = {}) => G.regroup({ ask, dim: 'topic', lang: 'English', threads, canvases: CANVASES, memory, ...extra });
const subjectOf = (groups, id) => groups.find((g) => g.threadIds.includes(id))?.name;

test('reads assignment lines in the shapes models write them', () => {
  const m = G.parseAssign('1 G2\n[2]: G1\n3 -\n4 → g3\nnoise\n5 G9\n99 G1\n1 G3', 5, 3);
  assert.deepEqual([...m], [[1, 1], [2, 0], [3, null], [4, 2]]);
});

test('a group named like last time keeps its key', () => {
  const prev = [{ key: 'g4', name: 'Rust', reason: '', covers: '' }];
  const { groups, seq } = G.parseDefine('{"groups":[{"name":"Rust"},{"name":"Go"},{"name":"Go"}]}', prev, 7);
  assert.deepEqual(groups.map((g) => [g.key, g.name]), [['g4', 'Rust'], ['g7', 'Go']]);
  assert.equal(seq, 8);
  assert.throws(() => G.parseDefine('no json', [], 0), G.BadReply);
});

test('one bounded define, then parallel batches', async () => {
  const threads = many(0, 300);
  const { ask, calls } = fakeModel();
  const { groups, memory } = await run(ask, threads, null);
  assert.equal(calls.define, 1);
  assert.equal(calls.assign, Math.ceil(300 / G.BATCH));
  assert.ok(calls.peak <= G.PARALLEL && calls.peak > 1, `peak ${calls.peak}`);
  const definePrompt = calls.prompts.find((p) => p.startsWith('A person keeps'));
  assert.ok(definePrompt.split('\n').filter((l) => l.startsWith('- ')).length <= 130, 'the sample stays bounded');
  assert.deepEqual(groups.map((g) => g.threadIds.length), [100, 100, 100]);
  assert.equal(subjectOf(groups, threads[4].id), 'Travel');
  assert.equal(Object.keys(memory.assigned).length, 300);
});

test('reopening asks only about what changed', async () => {
  const threads = many(0, 120);
  const first = await run(fakeModel().ask, threads, null);

  const same = fakeModel();
  const again = await run(same.ask, threads, first.memory);
  assert.equal(same.calls.define + same.calls.assign, 0);
  assert.deepEqual(again.groups, first.groups);

  const few = fakeModel();
  const grown = await run(few.ask, [...threads, ...many(1000, 6)], first.memory);
  assert.equal(few.calls.define, 0);
  assert.equal(few.calls.assign, 1);
  assert.equal(subjectOf(grown.groups, 'b:node-1000'), 'Travel');

  // many new ones: the groups are defined again, anchored on the old ones
  const lots = fakeModel({ names: ['Rust', 'Travel', 'Cooking', 'Music'] });
  const big = await run(lots.ask, [...threads, ...many(2000, 80)], first.memory);
  assert.equal(lots.calls.define, 1);
  assert.match(lots.calls.prompts[0], /Groups proposed last time:\n- Cooking: cooking talk/);
  assert.equal(lots.calls.assign, Math.ceil(80 / G.BATCH), 'kept groups keep their conversations');
  const keyOf = (gs, name) => gs.find((g) => g.name === name).key;
  for (const name of ['Cooking', 'Travel', 'Rust']) assert.equal(keyOf(big.groups, name), keyOf(first.groups, name));
});

test('regroup asks everything again', async () => {
  const threads = many(0, 50);
  const first = await run(fakeModel().ask, threads, null);
  const m = fakeModel();
  await run(m.ask, threads, first.memory, { fresh: true });
  assert.equal(m.calls.define, 1);
  assert.equal(m.calls.assign, 2);
});

test('a moved conversation keeps its place', async () => {
  const threads = many(0, 30);
  const first = await run(fakeModel().ask, threads, null);
  const moved = threads.map((th) => ({ ...th, canvasId: 'c', id: `c:${th.nodeIds[0]}` }));
  const m = fakeModel();
  const after = await run(m.ask, moved, first.memory);
  assert.equal(m.calls.define + m.calls.assign, 0);
  assert.equal(subjectOf(after.groups, 'c:node-2'), 'Rust');
  // a renamed opening is read again
  const renamed = moved.map((th, i) => (i === 0 ? { ...th, title: 'cooking anew', turns: ['cooking anew'] } : th));
  const r = fakeModel();
  await run(r.ask, renamed, first.memory);
  assert.equal(r.calls.assign, 1);
});

test('fumbled batches are asked once more; a dead batch costs only itself', async () => {
  const threads = many(0, 100);
  const half = fakeModel({ fumble: (i, lines) => (i === 0 ? lines.slice(0, 10).join('\n') : lines.join('\n')) });
  const r1 = await run(half.ask, threads, null);
  assert.equal(r1.groups.reduce((n, g) => n + g.threadIds.length, 0), 100);
  assert.equal(half.calls.assign, 3 + 1);

  const dead = fakeModel({ fumble: (i, lines) => { if (i === 0 || i === 3) throw new Error('boom'); return lines.join('\n'); } });
  const r2 = await run(dead.ask, threads, null);
  assert.equal(r2.groups.reduce((n, g) => n + g.threadIds.length, 0), 60, 'the first batch of 40 stays home');
  assert.equal(Object.keys(r2.memory.assigned).length, 60, 'and is asked about next time');

  const gone = fakeModel({ fumble: () => { throw new Error('offline'); } });
  await assert.rejects(run(gone.ask, threads, null), /offline/);
});

test('a rebuilt draft teaches its names and moves', async () => {
  const threads = many(0, 30);
  const first = await run(fakeModel().ask, threads, null);
  const [cooking, travel] = first.groups;
  const draft = [
    { ...cooking, name: 'Kitchen', threadIds: [...cooking.threadIds, travel.threadIds[0]] },
    { ...travel, threadIds: travel.threadIds.slice(1) },
  ];
  const memory = G.learnDraft(first.memory, draft, threads);
  const m = fakeModel({ names: ['Kitchen', 'Travel', 'Rust'] });
  const next = await run(m.ask, threads, memory);
  assert.equal(m.calls.define + m.calls.assign, 0);
  assert.equal(next.groups[0].name, 'Kitchen');
  assert.ok(next.groups[0].threadIds.includes(travel.threadIds[0]));
});
