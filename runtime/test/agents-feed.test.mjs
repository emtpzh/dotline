// The agents feed reaches a page over a WebSocket as it does over SSE: every
// run's events, pings the browser answers, and the page counted as listening
// while it is there (a runtime hands its questions elsewhere when nobody is).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const { createAgentsHttp } = createRequire(import.meta.url)('../agents/http.cjs');

let host = null;
const fake = (_log, h) => {
  host = h;
  return {
    available: async () => '/bin/fake',
    // the run's end carries the text it was sent, so a test can size the event
    run: async (req, emit) => { setTimeout(() => emit({ runId: 'r1', event: { type: 'run_end', text: req.prompt ?? 'ok', how: 'end' } }), 20); return 'r1'; },
    shutdown: () => {},
  };
};
const agents = createAgentsHttp({ extraRuntimes: { fake } });
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const handled = await agents.handle(req, res, new URL(req.url, 'http://x').pathname, raw ? JSON.parse(raw) : null);
  if (!handled) { res.writeHead(404); res.end(); }
});
server.on('upgrade', (req, socket, head) => agents.upgrade(req, socket, head));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `127.0.0.1:${server.address().port}`;
after(() => { agents.shutdown(); server.close(); });

const post = (path, body) => fetch(`http://${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

test('a run\'s events reach a page on the socket, and the page counts as listening', async () => {
  const ws = new WebSocket(`ws://${base}/agents/ws`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const got = new Promise((resolve) => { ws.onmessage = (ev) => resolve(JSON.parse(ev.data)); });
  const { runId } = await post('/agents/run', { runtime: 'fake' });
  assert.equal(runId, 'r1');
  assert.deepEqual(await got, { runId: 'r1', event: { type: 'run_end', text: 'ok', how: 'end' } });
  assert.equal(host.listening(), true);
  ws.close();
  await new Promise((r) => { ws.onclose = r; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(host.listening(), false, 'a page gone from the socket is no longer listening');
});

test('the SSE feed still carries the same events', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`http://${base}/agents/events`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  await post('/agents/run', { runtime: 'fake' });
  let text = '';
  while (!text.includes('run_end')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /data: \{"runId":"r1","event":\{"type":"run_end"/);
  ctrl.abort();
});

test('a large event arrives whole (extended frame lengths)', async () => {
  const ws = new WebSocket(`ws://${base}/agents/ws`);
  await new Promise((resolve) => { ws.onopen = resolve; });
  for (const size of [200, 70_000]) {
    const got = new Promise((resolve) => { ws.onmessage = (ev) => resolve(JSON.parse(ev.data)); });
    const prompt = 'x'.repeat(size);
    await post('/agents/run', { runtime: 'fake', prompt });
    assert.equal((await got).event.text, prompt);
  }
  ws.close();
});

test('the socket closes cleanly when the page closes it', async () => {
  const ws = new WebSocket(`ws://${base}/agents/ws`);
  await new Promise((resolve) => { ws.onopen = resolve; });
  ws.close(1000);
  const ev = await new Promise((resolve) => { ws.onclose = resolve; });
  assert.equal(ev.code, 1000);
});
