// Where a Pi session is cut so a new session ends exactly with one turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { forkPlan } = createRequire(import.meta.url)('../agents/pi.cjs');

const file = (entries) => [JSON.stringify({ type: 'session', id: 'sess', timestamp: '2026-09-18T00:00:00Z', cwd: '/w', version: 3 }), ...entries.map((e) => JSON.stringify(e))].join('\n');
const user = (id, parentId) => ({ type: 'message', id, parentId, message: { role: 'user', content: 'q' } });
const asst = (id, parentId) => ({ type: 'message', id, parentId, message: { role: 'assistant', content: [] } });

// u1 a1 | u2 a2 | u3 a3 — three turns in a line
const line = file([user('u1', null), asst('a1', 'u1'), user('u2', 'a1'), asst('a2', 'u2'), user('u3', 'a2'), asst('a3', 'u3')]);

test('a turn with a later turn below is cut before that turn\'s question', () => {
  assert.deepEqual(forkPlan(line, ['u1', 'a1']), { kind: 'fork', entryId: 'u2' });
  assert.deepEqual(forkPlan(line, ['u2', 'a2']), { kind: 'fork', entryId: 'u3' });
});

test('the last turn of the active branch is cloned as it stands', () => {
  assert.deepEqual(forkPlan(line, ['u3', 'a3']), { kind: 'clone' });
});

test('settings entries between turns ride along', () => {
  const f = file([user('u1', null), asst('a1', 'u1'), { type: 'model_change', id: 'm1', parentId: 'a1' }, user('u2', 'm1'), asst('a2', 'u2')]);
  assert.deepEqual(forkPlan(f, ['u1', 'a1']), { kind: 'fork', entryId: 'u2' });
  // a settings entry after the last turn is still the leaf of that turn
  const g = file([user('u1', null), asst('a1', 'u1'), { type: 'thinking_level_change', id: 't1', parentId: 'a1' }]);
  assert.deepEqual(forkPlan(g, ['u1', 'a1']), { kind: 'clone' });
});

test('a turn on a branch the file has moved away from is cut at its own child', () => {
  // u1 a1 ─┬─ u2 a2        (the earlier branch)
  //        └─ u2b a2b      (the active leaf)
  const f = file([user('u1', null), asst('a1', 'u1'), user('u2', 'a1'), asst('a2', 'u2'), user('u2b', 'a1'), asst('a2b', 'u2b')]);
  assert.deepEqual(forkPlan(f, ['u1', 'a1']), { kind: 'fork', entryId: 'u2' });
  // a2 has nothing below and is not the leaf: nothing Pi can cut there
  assert.equal(forkPlan(f, ['u2', 'a2']), null);
});

test('ids the file does not hold, or a turn that did not end where the ids say, give no plan', () => {
  assert.equal(forkPlan(line, ['nope']), null);
  assert.equal(forkPlan(line, []), null);
  assert.equal(forkPlan(line, ['u2']), null); // an assistant message follows u2: the ids were not the whole turn
});
