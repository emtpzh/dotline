#!/usr/bin/env node
// The session sync's plan: a canvas keeps the turns it has taken by id, so
// a turn the file adds anywhere — under the tail, above it from a second
// client, as a late subagent report — is new exactly when its id is not
// taken; a turn removed by hand stays removed; a canvas run's turn lands in
// the run's node instead of beside it. And the read layer: a file read in
// pieces as it grows says what one whole read says.
//
// Run: node scripts/test-session-sync.mjs
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'td-session-sync-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const entry = join(dir, 'entry.mjs');
const src = `${process.cwd()}/src/lib`;
writeFileSync(entry, [
  `export { ClaudeSessionCollector } from '${src}/adapters/claude-code-session.ts';`,
  `export { planSync, legacyTaken, unitIds } from '${src}/sessions/plan.ts';`,
  `export { readSession } from '${src}/sessions/read.ts';`,
].join('\n'));
const out = join(dir, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', define: { 'import.meta.env.DEV': 'false', 'import.meta.env': '{}' } });
const { ClaudeSessionCollector, planSync, legacyTaken, unitIds, readSession } = await import(out);

/** One Claude Code session, built as the importer builds it. */
function session(lines) {
  const cc = new ClaudeSessionCollector();
  for (const o of lines) cc.feedLine(JSON.stringify({ sessionId: 's-1', cwd: '/w', ...o }));
  return cc.toConversation().build();
}
const user = (uuid, parentUuid, text) => ({ type: 'user', uuid, parentUuid, message: { role: 'user', content: text } });
const said = (uuid, parentUuid, text) => ({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const hook = (uuid, parentUuid) => ({ type: 'system', subtype: 'stop_hook_summary', uuid, parentUuid });
const first = (n) => n.data.importSource.itemIds[0];
const canvasOf = (built, keep) => built.nodes.filter((n) => keep.includes(first(n))).map((n) => ({ ...n, id: `c-${first(n)}` }));

const BASE = [user('u0', null, 'why'), said('a0', 'u0', 'because'), hook('h0', 'a0'), user('u1', 'h0', 'and then'), said('a1', 'u1', 'then this')];

test('a turn a second client adds above the tail is new, and hangs off its own parent', () => {
  const built = session([...BASE, user('u2', 'h0', 'from the other client'), said('a2', 'u2', 'ok')]);
  const plan = planSync({ built, handled: new Set(['u0', 'u1']), canvas: canvasOf(built, ['u0', 'u1']), bindings: [] });
  assert.deepEqual(plan.append.map(first), ['u2']);
  assert.deepEqual(plan.taken, ['u2']);
  // its parent is the first turn, not the tail: the edge the sync draws comes from there
  const u2 = plan.append[0];
  const parent = built.edges.find((e) => e.target === u2.id);
  assert.equal(first(built.nodes.find((n) => n.id === parent.source)), 'u0');
});

test('a turn removed from the canvas by hand never grows back', () => {
  const built = session([...BASE, user('u2', 'a1', 'more'), said('a2', 'u2', 'yes')]);
  // u1 was taken, then deleted: not on the canvas, still taken
  const plan = planSync({ built, handled: new Set(['u0', 'u1']), canvas: canvasOf(built, ['u0']), bindings: [] });
  assert.deepEqual(plan.append.map(first), ['u2']);
  assert.deepEqual(plan.refresh.map((r) => r.nodeId), ['c-u0']);
});

test('a canvas run\'s turn lands in its node, and stays its turn while it is written', () => {
  const built = session([...BASE, user('u2', 'a1', '[Dotline canvas context] …\n\n---\n\nnext question'), said('a2', 'u2', 'answer')]);
  const binding = { nodeId: 'run-node', question: 'next question', afterTurnId: 'u1' };
  let plan = planSync({ built, handled: new Set(['u0', 'u1']), canvas: canvasOf(built, ['u0', 'u1']), bindings: [binding] });
  assert.deepEqual(plan.bound.map((b) => [b.nodeId, b.unit]), [['run-node', 'u2']]);
  assert.equal(plan.append.length, 0, 'never appended beside the run');
  assert.deepEqual(plan.taken, ['u2']);
  // the next sync, the turn already taken: the binding names it and it is still the run's
  plan = planSync({ built, handled: new Set(['u0', 'u1', 'u2']), canvas: canvasOf(built, ['u0', 'u1']), bindings: [{ ...binding, turnId: 'u2' }] });
  assert.deepEqual(plan.bound.map((b) => b.unit), ['u2']);
  assert.equal(plan.taken.length, 0);
  assert.ok(!plan.refresh.some((r) => first(r.fresh) === 'u2'), 'a run\'s turn is not refreshed as a mirror');
  // a question asked before the run's turn is never taken for it
  const early = planSync({ built, handled: new Set(['u0']), canvas: canvasOf(built, ['u0']), bindings: [{ nodeId: 'x', question: 'and then', afterTurnId: 'u1' }] });
  assert.equal(early.bound.length, 0);
});

test('a ledger from before ids is read as the ids its count covered', () => {
  const built = session([...BASE, user('u2', 'a1', 'more'), said('a2', 'u2', 'yes')]);
  assert.deepEqual(legacyTaken(built, 2), ['u0', 'u1']);
  const ids = unitIds(built.nodes, built.edges);
  assert.equal(ids.size, 3);
});

test('a file read in pieces as it grows says what one whole read says', async () => {
  const lines = [
    { type: 'session', version: 3, id: 'pi-1', timestamp: '2026-10-01T00:00:00Z', cwd: '/p' },
    { type: 'model_change', id: 'm0', parentId: null, provider: 'deepseek', modelId: 'deepseek-flash' },
    { type: 'message', id: 'u0', parentId: 'm0', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'message', id: 'a0', parentId: 'u0', message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-flash', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c0', name: 'read', arguments: { path: 'x' } }] } },
    { type: 'message', id: 'r0', parentId: 'a0', message: { role: 'toolResult', toolCallId: 'c0', content: [{ type: 'text', text: 'file' }] } },
    { type: 'message', id: 'a1', parentId: 'r0', message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-flash', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } },
    { type: 'message', id: 'u1', parentId: 'a1', message: { role: 'user', content: [{ type: 'text', text: 'again' }] } },
    { type: 'message', id: 'a2', parentId: 'u1', message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-flash', stopReason: 'stop', content: [{ type: 'text', text: 'twice' }] } },
  ].map((o) => JSON.stringify(o) + '\n');
  const files = { grow: '', whole: lines.join('') };
  globalThis.window = { desktopSessions: {
    head: async (_r, rel, bytes) => files[rel].slice(0, bytes),
    // line-aligned chunks of at most two lines, as a host might cut them
    readRange: async (_r, rel, start) => {
      const text = files[rel];
      if (start >= text.length) return { text: '', nextStart: start, eof: true };
      let end = start;
      for (let i = 0; i < 2 && end < text.length; i++) end = text.indexOf('\n', end) + 1 || text.length;
      return { text: text.slice(start, end), nextStart: end, eof: end >= text.length };
    },
    list: async () => [],
    roots: async () => [],
  } };
  const strip = (s) => ({ ...s, file: undefined });
  for (let i = 0; i < lines.length; i++) {
    // half a line arrives first: it waits for its end
    files.grow = lines.slice(0, i).join('') + lines[i].slice(0, 10);
    await readSession({ rootKey: 'r', rel: 'grow' });
    files.grow = lines.slice(0, i + 1).join('');
    await readSession({ rootKey: 'r', rel: 'grow' });
  }
  const grown = await readSession({ rootKey: 'r', rel: 'grow' });
  const whole = await readSession({ rootKey: 'r', rel: 'whole' });
  assert.deepEqual(strip(grown.snapshot), strip(whole.snapshot));
  assert.deepEqual(grown.snapshot.turns.map((t) => [t.id, t.parentTurnId, t.complete, t.response]), [['u0', undefined, true, 'done'], ['u1', 'u0', true, 'twice']]);
  assert.equal(grown.snapshot.turns[0].tools.length, 1);
  // the file rewritten under the same name: read again from its start
  files.grow = lines.slice(0, 3).join('').replace('"hi"', '"hello"');
  const rewritten = await readSession({ rootKey: 'r', rel: 'grow' });
  assert.deepEqual(rewritten.snapshot.turns.map((t) => t.question), ['hello']);
});

test('a session a run forked holds the conversation it forked from: taken, never appended', () => {
  // the fork's file: the parent's two turns copied ahead of the run's own
  const built = session([...BASE, user('u2', 'a1', 'the forked question'), said('a2', 'u2', 'answer')]);
  const plan = planSync({ built, handled: new Set(), canvas: [], bindings: [{ nodeId: 'run-node', question: 'the forked question' }] });
  assert.deepEqual(plan.bound.map((b) => b.unit), ['u2']);
  assert.equal(plan.append.length, 0);
  assert.deepEqual(plan.taken.sort(), ['u0', 'u1', 'u2']);
});

test('bindings: a new session, a page closed mid-run, a canvas switched away', () => {
  // a fresh session the run opened: its first turn records the canvas's context ahead of the question
  const fresh = session([user('n0', null, '[Dotline canvas context] …\n\n---\n\nfirst question'), said('b0', 'n0', 'first answer')]);
  let plan = planSync({ built: fresh, handled: new Set(), canvas: [], bindings: [{ nodeId: 'q', question: 'first question' }] });
  assert.deepEqual(plan.bound.map((b) => [b.nodeId, b.unit]), [['q', 'n0']]);
  assert.equal(plan.append.length, 0);
  // the page closed while it ran: no run here any more, the question recorded
  // some other way — the turn after the one it went on from is still its own
  const resumed = session([...BASE, user('u2', 'a1', 'rewritten by the runtime'), said('a2', 'u2', 'answer')]);
  plan = planSync({ built: resumed, handled: new Set(['u0', 'u1']), canvas: canvasOf(resumed, ['u0', 'u1']), bindings: [{ nodeId: 'q', question: 'the question as asked', afterTurnId: 'u1', ended: true }] });
  assert.deepEqual(plan.bound.map((b) => b.unit), ['u2']);
  // still running (another canvas in view, the run going on): no guess
  plan = planSync({ built: resumed, handled: new Set(['u0', 'u1']), canvas: canvasOf(resumed, ['u0', 'u1']), bindings: [{ nodeId: 'q', question: 'the question as asked', afterTurnId: 'u1' }] });
  assert.equal(plan.bound.length, 0);
  assert.deepEqual(plan.append.map(first), ['u2'], 'unclaimed, the turn is the file\'s like any other');
  // two runs on one session: each takes its own turn, in order
  const two = session([...BASE, user('u2', 'a1', 'one'), said('a2', 'u2', '1'), user('u3', 'a2', 'two'), said('a3', 'u3', '2')]);
  plan = planSync({ built: two, handled: new Set(['u0', 'u1']), canvas: canvasOf(two, ['u0', 'u1']), bindings: [{ nodeId: 'p', question: 'one', afterTurnId: 'u1' }, { nodeId: 'q', question: 'two', afterTurnId: 'u2' }] });
  assert.deepEqual(plan.bound.map((b) => [b.nodeId, b.unit]), [['p', 'u2'], ['q', 'u3']]);
});
