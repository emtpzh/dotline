#!/usr/bin/env node
// What a node runs on next: its own intent, written when it is asked and
// inherited along the line, never read off the global picker once it exists.
// Bundled for node the way test-agent-route.mjs does it.
//
// Run: node scripts/test-run-intent.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'tdag-intent-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const bundle = join(tmp, 'run-intent.mjs');
execFileSync(join(ROOT, 'node_modules/.bin/esbuild'), [
  join(ROOT, 'src/lib/run-intent.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
const { lineModel, intentOf, inheritIntent, effectiveIntent, intentFields, lineCwd, inheritCwd } = await import(pathToFileURL(bundle).href);

const PI = 'pi/deepseek/deepseek-v4-flash';
const HARNESS = 'harness/agent/deepseek-official/deepseek-flash';
const API = 'deepseek-official/deepseek-flash';
const CLAUDE = 'claude/opus';
const GLOBAL = { model: API };

/** A node's data as the canvas stores it; only the fields intents read. */
const node = (extra = {}) => ({ question: 'q', response: 'r', responses: ['r'], responseIndex: 0, ...extra });

test('a Pi turn asked through the global picker keeps running on Pi', () => {
  // pi issue: no intent written, the run recorded on the node
  const pi = node({ agentSession: { runtime: 'pi', model: PI, effort: 'high' }, generatedBy: [PI], generatedEfforts: ['high'] });
  assert.deepEqual(intentOf(pi), { model: PI, effort: 'high' });
  assert.deepEqual(inheritIntent([pi], GLOBAL), { model: PI, effort: 'high' });
});

test('the intent on the node wins over what its answer ran on', () => {
  const n = node({ model: API, agentSession: { model: PI }, generatedBy: [PI] });
  assert.equal(lineModel(n), API);
  assert.deepEqual(intentOf(n), { model: API });
});

test('a plain answer from before intents reruns on the model that wrote it', () => {
  assert.equal(lineModel(node({ generatedBy: ['old/model', API], responseIndex: 1 })), API);
});

test('effort is an agent entry\'s alone; an explicit default stays the default', () => {
  assert.deepEqual(intentOf(node({ model: API, effort: 'high' })), { model: API });
  // '' on the node is the runtime's default: the record's level does not creep back in
  assert.deepEqual(intentOf(node({ model: PI, effort: '', generatedEfforts: ['high'] })), { model: PI });
});

test('a root, or a node under material only, starts from the defaults', () => {
  assert.deepEqual(inheritIntent([], GLOBAL), GLOBAL);
  const file = node({ stepKind: 'file', generatedBy: [PI] });
  assert.deepEqual(inheritIntent([file], GLOBAL), GLOBAL);
});

test('parents that agree hand their intent down; parents that disagree start from the defaults, flagged', () => {
  const a = node({ model: HARNESS, effort: 'high' });
  const b = node({ model: HARNESS, effort: 'high' });
  assert.deepEqual(inheritIntent([a, b], GLOBAL), { model: HARNESS, effort: 'high' });
  const c = node({ model: HARNESS, effort: 'low' });
  assert.deepEqual(inheritIntent([a, c], GLOBAL), { model: HARNESS }, 'same model, levels differ: the runtime default');
  assert.deepEqual(inheritIntent([a, node({ model: PI })], GLOBAL), { ...GLOBAL, mixed: true });
});

test('an unasked node reads its parents until it has an intent of its own', () => {
  const parent = node({ model: PI });
  const unasked = { question: '', response: '', responses: [], responseIndex: -1 };
  assert.deepEqual(effectiveIntent(unasked, [parent], GLOBAL), { model: PI });
  assert.deepEqual(effectiveIntent({ ...unasked, model: API }, [parent], GLOBAL), { model: API });
});

test('the fields a node is written with carry effort for agent entries, access for those with levels', () => {
  assert.deepEqual(intentFields({ model: CLAUDE }), { model: CLAUDE, effort: '', access: 'read' });
  assert.deepEqual(intentFields({ model: CLAUDE, effort: 'high', access: 'write' }), { model: CLAUDE, effort: 'high', access: 'write' });
  // Pi has no read-only mode: it takes no level
  assert.deepEqual(intentFields({ model: PI, effort: 'high', access: 'read' }), { model: PI, effort: 'high', access: undefined });
  assert.deepEqual(intentFields({ model: HARNESS, access: 'write' }), { model: HARNESS, effort: '', access: undefined });
  assert.deepEqual(intentFields({ model: API, effort: 'high', access: 'write' }), { model: API, effort: undefined, access: undefined });
  assert.deepEqual(intentFields({}), { model: undefined, effort: undefined, access: undefined });
});

test('the access level travels down a line, and only where the parents agree', () => {
  const defaults = { model: PI, access: 'read' };
  // a node's own level, else the one its last turn ran at
  assert.deepEqual(intentOf(node({ model: PI, access: 'write' })), { model: PI, access: 'write' });
  assert.deepEqual(intentOf(node({ agentSession: { runtime: 'pi', model: PI, cwd: '/p', access: 'write' }, generatedBy: [PI] })), { model: PI, access: 'write' });
  // a child inherits its parent's level
  assert.deepEqual(inheritIntent([node({ model: PI, access: 'write' })], defaults), { model: PI, access: 'write' });
  // parents that disagree start from the default level
  assert.deepEqual(inheritIntent([node({ model: PI, access: 'write' }), node({ model: PI, access: 'read' })], defaults), { model: PI, access: 'read' });
  // a plain model has no level
  assert.deepEqual(intentOf(node({ model: API, access: 'write' })), { model: API });
});

test('a node keeps the directory it runs in, whatever the canvas default says later', () => {
  // its intent, when it runs on that runtime
  assert.equal(lineCwd(node({ model: PI, cwd: '/proj/a' }), 'pi'), '/proj/a');
  // a turn from before directories were written: where its own turn ran
  assert.equal(lineCwd(node({ agentSession: { runtime: 'pi', model: PI, cwd: '/proj/b' }, generatedBy: [PI] }), 'pi'), '/proj/b');
  // a mirrored session turn: the session's directory
  assert.equal(lineCwd(node({ importSource: { runner: 'dsh', sessionId: 's', itemIds: ['u'], cwd: '/proj/c' } }), 'dsh'), '/proj/c');
  // an intent for another runtime says nothing about this one
  assert.equal(lineCwd(node({ model: HARNESS, cwd: '/proj/a' }), 'pi'), undefined);
  // '' is a directory choice too: the runtime's own default
  assert.equal(lineCwd(node({ model: HARNESS, cwd: '' }), 'dsh'), '');
});

test('a follow-up on the same runtime goes on in its parent\'s session directory', () => {
  const pi = node({ agentSession: { runtime: 'pi', model: PI, cwd: '/proj/b' }, generatedBy: [PI] });
  assert.equal(inheritCwd([pi], 'pi'), '/proj/b');
  // another runtime, a plain parent, several parents: the canvas default decides
  assert.equal(inheritCwd([pi], 'dsh'), undefined);
  assert.equal(inheritCwd([node({ generatedBy: [API] })], 'pi'), undefined);
  assert.equal(inheritCwd([pi, node({ model: PI, cwd: '/proj/z' })], 'pi'), undefined);
  // material wired in beside the line does not make it ambiguous
  assert.equal(inheritCwd([pi, node({ stepKind: 'file' })], 'pi'), '/proj/b');
});
