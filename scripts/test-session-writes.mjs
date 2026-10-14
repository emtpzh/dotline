#!/usr/bin/env node
// What a write of a canvas run's turn may do to its node: a run's binding
// is one run's, a turn is one version (the run's stand-in gives way to the
// file's turn), a refresh changes the turn's own version and nothing else,
// and writes of one session never interleave.
//
// Run: node scripts/test-session-writes.mjs
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'td-session-writes-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const entry = join(dir, 'entry.mjs');
const src = `${process.cwd()}/src/lib`;
writeFileSync(entry, [
  `export { sameRun, withTurnVersion, refreshedTurn, lateFootprint, reconciled } from '${src}/sessions/writes.ts';`,
  `export { underSession } from '${src}/sessions/serial.ts';`,
].join('\n'));
const out = join(dir, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const { sameRun, withTurnVersion, refreshedTurn, lateFootprint, reconciled, underSession } = await import(out);

const FAIL = new Set(['(failed)', '(empty)', '(stopped)']);
const run = (o = {}) => ({ runtime: 'codex', question: 'q', startedAt: '2026-10-14T10:00:00.000Z', ...o });
const node = (o = {}) => ({
  question: 'q',
  responses: ['a0', 'a1'],
  questions: ['q0', 'q'],
  generatedBy: ['m0', 'm1'],
  generatedEfforts: [undefined, 'high'],
  generatedAts: ['t0', 't1'],
  editedAts: [undefined, undefined],
  gatewaySearches: [undefined, undefined],
  reasonings: [undefined, 'r1'],
  ...o,
});
const turn = { response: 'file answer', by: 'codex/gpt', effort: 'medium', at: 't2', reasoning: 'thought' };
const aligned = (v) => {
  const n = v.responses.length;
  for (const k of ['questions', 'generatedBy', 'generatedEfforts', 'generatedAts', 'editedAts', 'gatewaySearches', 'reasonings']) assert.equal(v[k].length, n, k);
  assert.equal(v.responseIndex, n - 1);
  assert.equal(v.response, v.responses[n - 1]);
};

test('a binding is one run: another start, or another runtime, is another run', () => {
  assert.ok(sameRun(run(), run({ endedAt: 'x', turnId: 'u1', changes: { changed: [], added: [], removed: [] } })));
  assert.ok(!sameRun(run(), run({ startedAt: '2026-10-14T10:00:00.001Z' })));
  assert.ok(!sameRun(run(), run({ runtime: 'pi' })));
  assert.ok(!sameRun(undefined, run()));
  assert.ok(!sameRun(run(), undefined));
});

test('a run that replaces takes the node\'s versions\' place; one that appends goes beside them', () => {
  const replaced = withTurnVersion(node(), turn, run(), FAIL);
  assert.deepEqual(replaced.responses, ['file answer']);
  assert.deepEqual(replaced.generatedEfforts, ['medium']);
  aligned(replaced);
  const appended = withTurnVersion(node(), turn, run({ append: true }), FAIL);
  assert.deepEqual(appended.responses, ['a0', 'a1', 'file answer']);
  assert.deepEqual(appended.generatedBy, ['m0', 'm1', 'codex/gpt']);
  assert.deepEqual(appended.reasonings, [undefined, 'r1', 'thought']);
  aligned(appended);
});

test('the run\'s own stand-in gives way to the file\'s turn: one turn, one version', () => {
  // a stopped run wrote its partial text as the last version, then the file's turn came
  const d = node({ responses: ['a0', 'partial'], generatedEfforts: [undefined, undefined] });
  const v = withTurnVersion(d, turn, run({ append: true, standIn: true }), FAIL);
  assert.deepEqual(v.responses, ['a0', 'file answer']);
  assert.deepEqual(v.generatedEfforts, [undefined, 'medium']);
  aligned(v);
  // a stand-in that was a placeholder takes no real version with it
  const p = withTurnVersion(node({ responses: ['a0', '(stopped)'] }), turn, run({ append: true, standIn: true }), FAIL);
  assert.deepEqual(p.responses, ['a0', 'file answer']);
});

test('placeholders of failed rounds never stay as versions', () => {
  const v = withTurnVersion(node({ responses: ['a0', '(failed)'] }), turn, run({ append: true }), FAIL);
  assert.deepEqual(v.responses, ['a0', 'file answer']);
  aligned(v);
});

test('a refresh changes the turn\'s own version and nothing else', () => {
  const d = node({ responses: ['a0', 'file answer'], responseIndex: 1 });
  const r = refreshedTurn(d, { question: 'q', response: 'file answer, longer', tokenCount: 9 });
  assert.deepEqual(r.responses, ['a0', 'file answer, longer']);
  assert.equal(r.response, 'file answer, longer');
  assert.equal(r.responseIndex, 1);
  assert.deepEqual(r.questions, ['q0', 'q']);
  // what each version records is not the refresh's to touch
  for (const k of ['generatedBy', 'generatedEfforts', 'generatedAts', 'reasonings']) assert.equal(k in r, false, k);
  // a mirrored turn with one version
  assert.deepEqual(refreshedTurn({ responses: ['x'], responseIndex: 0 }, { question: 'q', response: 'y', tokenCount: 1 }).responses, ['y']);
});

test('what changed on disk after the turn was written joins its steps once', () => {
  const changes = { changed: ['/w/a.ts'], added: [], removed: [] };
  const d = { steps: [{ id: 's1', tool: 'Read', op: 'read', call: '', result: '', paths: ['/w/b.ts'] }], importSource: { sessionId: 's', cwd: '/w' } };
  const p = lateFootprint(d, changes);
  assert.equal(p.steps.length, 2);
  assert.equal(p.steps[1].tool, 'fs-changes');
  assert.equal(lateFootprint({ ...d, steps: p.steps }, changes), null);
  // a node holding no session turn takes none
  assert.equal(lateFootprint({ steps: [] }, changes), null);
});

test('writes of one session wait for each other, in order, whatever became of the one before', async () => {
  const log = [];
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = underSession('codex', 's1', async () => { log.push('a<'); await pause(20); log.push('a>'); throw new Error('a failed'); });
  const b = underSession('codex', 's1', async () => { log.push('b<'); await pause(5); log.push('b>'); return 'b'; });
  // another session is not held up
  const c = underSession('codex', 's2', async () => { log.push('c'); return 'c'; });
  await assert.rejects(a);
  assert.equal(await b, 'b');
  assert.equal(await c, 'c');
  assert.deepEqual(log.filter((x) => x !== 'c'), ['a<', 'a>', 'b<', 'b>']);
  assert.ok(log.indexOf('c') < log.indexOf('a>'));
});

test('what a binding knows of its run only grows, from the host\'s record', () => {
  const now = '2026-10-14T12:00:00.000Z';
  const host = (runs) => ({ bootId: 'boot-1', runs });
  const b = run({ runId: 'r1', bootId: 'boot-1' });
  // still running: nothing to add — the same binding
  assert.equal(reconciled(b, host([{ runId: 'r1', status: 'running' }]), now), b);
  // its turn named while the page was away
  assert.equal(reconciled(b, host([{ runId: 'r1', status: 'running', turnId: 't1' }]), now).turnId, 't1');
  // over: when the host says, and whether the file held it
  const over = reconciled(b, host([{ runId: 'r1', status: 'ended', turnId: 't1', endedAt: 'e', held: true }]), now);
  assert.deepEqual([over.endedAt, over.turnId, over.held], ['e', 't1', true]);
  // a run the host's boot does not know: over, not held
  const gone = reconciled(b, host([]), now);
  assert.deepEqual([gone.endedAt, gone.held], [now, false]);
  // what the binding already knows is not taken back
  const known = run({ runId: 'r1', turnId: 'mine', endedAt: 'x', held: true });
  assert.equal(reconciled(known, host([{ runId: 'r1', status: 'ended', turnId: 'other', held: false }]), now), known);
  // a run from before runs had ids: the host has nothing to say about it
  const legacy = run();
  assert.equal(reconciled(legacy, host([]), now), legacy);
});
