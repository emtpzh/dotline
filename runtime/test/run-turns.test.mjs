// What a host knows of its runs and how a runtime names its turn: the
// registry a page asks when it missed a run's events, served over HTTP; and
// each runtime finding the entry carrying the prompt it wrote, and telling
// when its file holds the whole turn — from session files as the CLIs write
// them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createRunRegistry } = require('../agents/registry.cjs');
const { createAgentsHttp } = require('../agents/http.cjs');
const { promptEntryIn } = require('../agents/claude.cjs');
const { piTurnIn } = require('../agents/pi.cjs');
const { rolloutHolds } = require('../agents/codex.cjs');
const { until } = require('../agents/turn-file.cjs');

const dir = mkdtempSync(join(tmpdir(), 'td-run-turns-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const jsonl = (name, lines) => { const f = join(dir, name); writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); return f; };

test('the registry records a run from its start to its end, with its turn and whether the file held it', () => {
  const reg = createRunRegistry();
  const seen = [];
  const emit = reg.relay('codex', (p) => seen.push(p));
  reg.started('codex', 'r1');
  assert.equal(reg.list().runs[0].status, 'running');
  emit({ runId: 'r1', event: { type: 'session', sessionId: 's1', sessionFile: '/f' } });
  emit({ runId: 'r1', event: { type: 'turn', turnId: 't1' } });
  assert.deepEqual(seen.map((p) => p.event.type), ['session', 'turn'], 'passed on as they came');
  emit({ runId: 'r1', event: { type: 'run_end', how: 'end', turnId: 't1', held: true } });
  const [r] = reg.list().runs;
  assert.equal(r.status, 'ended');
  assert.equal(r.sessionId, 's1');
  assert.equal(r.turnId, 't1');
  assert.equal(r.held, true);
  assert.ok(r.endedAt);
  // a run's end that did not say so did not hold its turn
  emit({ runId: 'r2', event: { type: 'run_end', how: 'error' } });
  assert.equal(reg.list().runs.find((x) => x.runId === 'r2').held, false);
  // another host process is another boot
  assert.notEqual(reg.list().bootId, createRunRegistry().list().bootId);
});

test('a host serves its runs\' record to a page that missed their events', async () => {
  const fake = () => ({
    available: async () => '/bin/fake',
    run: async (_req, emit) => { setTimeout(() => emit({ runId: 'r1', event: { type: 'run_end', text: 'ok', how: 'end', turnId: 't1', held: true } }), 5); return 'r1'; },
    shutdown: () => {},
  });
  const agents = createAgentsHttp({ extraRuntimes: { fake } });
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (!(await agents.handle(req, res, new URL(req.url, 'http://x').pathname, raw ? JSON.parse(raw) : null))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/agents/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: 'fake' }) });
    const ended = await until(async () => {
      const list = await (await fetch(`${base}/agents/runs`)).json();
      return list.runs.find((r) => r.runId === 'r1' && r.status === 'ended') ? list : null;
    }, { within: 2000 });
    assert.ok(ended.bootId);
    assert.deepEqual(ended.runs.map((r) => [r.runtime, r.turnId, r.held]), [['fake', 't1', true]]);
  } finally {
    agents.shutdown();
    server.close();
  }
});

test('Claude Code: the line carrying the run\'s prompt, after where the run began', async () => {
  const text = (t) => [{ type: 'text', text: t }];
  const f = jsonl('claude.jsonl', [
    { type: 'user', uuid: 'old', message: { role: 'user', content: 'again' } },
    { type: 'assistant', uuid: 'a0', message: { role: 'assistant', content: text('x') } },
  ]);
  const from = statSync(f).size;
  appendFileSync(f, [
    { type: 'user', uuid: 'meta', isMeta: true, message: { role: 'user', content: text('again') } },
    { type: 'user', uuid: 'mine', message: { role: 'user', content: text('again\n') } },
    { type: 'user', uuid: 'tool', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'r' }] } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: text('y') } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(await promptEntryIn(f, from, 'again'), 'mine', 'the same question asked before the run is not its own');
  assert.equal(await promptEntryIn(f, 0, 'again'), 'mine', 'a fork\'s copied history comes first, the run\'s prompt last');
  assert.equal(await promptEntryIn(f, from, 'something else'), null);
  assert.equal(await promptEntryIn(join(dir, 'missing.jsonl'), 0, 'again'), null);
});

test('Pi: the entry carrying the run\'s prompt, and the turn held once an answer stops for good', async () => {
  const msg = (id, role, content, extra = {}) => ({ type: 'message', id, message: { role, content, ...extra } });
  const f = jsonl('pi.jsonl', [
    { type: 'session', id: 'sess' },
    msg('e1', 'user', [{ type: 'text', text: 'Q' }]),
    msg('e2', 'assistant', [{ type: 'toolCall', id: 'c', name: 'read' }], { stopReason: 'toolUse' }),
  ]);
  assert.deepEqual(await piTurnIn(f, 0, 'Q'), { turnId: 'e1', held: false }, 'a tool call is not the end');
  appendFileSync(f, JSON.stringify(msg('e3', 'assistant', [{ type: 'text', text: 'A' }], { stopReason: 'stop' })) + '\n');
  assert.deepEqual(await piTurnIn(f, 0, 'Q'), { turnId: 'e1', held: true });
  // the same question again: the later one is the run's, and not yet answered
  appendFileSync(f, JSON.stringify(msg('e4', 'user', 'Q')) + '\n');
  assert.deepEqual(await piTurnIn(f, 0, 'Q'), { turnId: 'e4', held: false });
});

test('Codex: the rollout holds a turn once its close follows its start', async () => {
  const f = jsonl('rollout.jsonl', [
    { type: 'turn_context', payload: { turn_id: 'old' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old' } },
    { type: 'turn_context', payload: { turn_id: 't1' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
  ]);
  assert.equal(await rolloutHolds(f, 0, 't1'), false, 'another turn\'s close is not this one\'s');
  appendFileSync(f, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }) + '\n');
  assert.equal(await rolloutHolds(f, 0, 't1'), true);
  // an interrupted turn is closed too
  const g = jsonl('aborted.jsonl', [{ type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } }, { type: 'event_msg', payload: { type: 'turn_aborted' } }]);
  assert.equal(await rolloutHolds(g, 0, 't2'), true);
});

test('the wait for a file is a watchdog: it answers as soon as the file does, and says so when it never does', async () => {
  let n = 0;
  assert.equal(await until(async () => (++n >= 3 ? 'yes' : null), { within: 2000 }), 'yes');
  const t = Date.now();
  assert.equal(await until(async () => null, { within: 150 }), null);
  assert.ok(Date.now() - t < 1000);
});
