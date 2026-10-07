// The harness's agent loop as a runtime on the canvas's agent lane, against
// a stand-in harness: which session a run opens, continues or forks, what
// reaches the agent, the events that come back, approvals, abort.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { internals } from '../lib/index.js'

const { createDshRuntime, installApprovalAnswerer, sessionIdOfPath, sessionLogName, findSessionFiles } = internals

/** A harness with just what the runtime touches. `turn(id)` scripts what an
 *  agent does after a prompt; sessions can be seeded with events; `version`
 *  is the session format its sessions are written in. */
function fakeHarness({ turn, version = 3 } = {}) {
  const handlers = new Map()
  const sessions = new Map()
  const agents = new Map()
  const log = { created: [], forks: [], injected: [], prompts: [], selected: [], cancelled: [], cleared: [] }
  let n = 0
  const fire = (id, event) => { for (const h of handlers.get('session/event') ?? []) h({ id }, event) }
  fire.stream = (id, frame) => { for (const h of handlers.get('agent/assistant-stream') ?? []) h({ agent: agents.get(id), frame }) }
  const addSession = (id, cwd, events = [], pending = []) => {
    sessions.set(id, { id, header: { version, meta: { cwd } }, events, seq: events.length })
    const inbox = {
      pending: [...pending],
      get hasPending() { return inbox.pending.length > 0 },
      clear: () => { log.cleared.push(id); inbox.pending = [] },
    }
    agents.set(id, {
      id,
      session: sessions.get(id),
      inbox,
      inject: (m) => log.injected.push({ id, text: m.content[0].text, source: m.source }),
      cancel: () => { log.cancelled.push(id); fire(id, { type: 'turn/end', data: { turn: 99 } }) },
      whenIdle: () => new Promise(() => {}),
    })
    return id
  }
  const pendingOf = (id) => agents.get(id).inbox.pending
  const ctx = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => handlers.set(name, handlers.get(name).filter(f => f !== fn))
    },
    sessions: { get: (id) => sessions.get(id) },
    agents: { get: (id) => agents.get(id) },
    llm: { listModels: async () => [{ id: 'v4', inputModalities: ['text', 'image'] }] },
    sessionController: {
      modelCatalog: async () => ({ groups: [{ id: 'ds', name: 'DS', models: [{ id: 'v4', name: 'V4' }, { id: 'lite', name: 'Lite' }] }], default: { provider: 'ds', model: 'v4' } }),
      create: async ({ cwd } = {}) => { const id = addSession(`session-${++n}`, cwd ?? '/home'); log.created.push({ id, cwd: cwd ?? null }); return { sessionId: id } },
      // a harness whose cut runs to the next turn's start hands the child
      // what the parent had queued for that turn — the sibling's question
      fork: async ({ sessionId, atSeq }) => { const id = addSession(`session-${++n}`, sessions.get(sessionId).header.meta.cwd, [], pendingOf(sessionId)); log.forks.push({ from: sessionId, atSeq, id }); return { sessionId: id } },
      selectModel: async (x) => { log.selected.push(x) },
      prompt: async ({ sessionId, content }) => {
        log.prompts.push({ sessionId, text: content[0].text })
        setImmediate(() => (turn ?? defaultTurn)(sessionId, fire))
      },
      resolveAgent: async (id) => (agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'NOT_FOUND' } }),
    },
    handlers,
  }
  return { ctx, log, addSession, pendingOf }
}

function defaultTurn(id, fire) {
  fire(id, { type: 'turn/start', data: { turn: 1 } })
  fire(id, { type: 'user/message', data: { id: 'msg-q', source: { kind: 'user' } } })
  fire(id, { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"path":"/w/a.txt"}' } })
  fire(id, { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [] } } })
  fire(id, { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'hm' } } })
  fire(id, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'Hel' } } })
  fire(id, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'lo' } } })
  fire(id, { type: 'turn/end', data: { turn: 1 } })
}

/** Run one request to its end; the events in order. */
async function runToEnd(runtime, req) {
  const events = []
  let runId
  await new Promise((resolve) => {
    void runtime.run(req, (p) => { events.push(p.event); if (p.event.type === 'run_end' || p.event.type === 'run_error') resolve() }).then((id) => { runId = id })
  })
  return { events, runId }
}

// a seeded session: two finished turns (seqs 1-4, 5-8)
const twoTurns = [
  { seq: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, type: 'user/message', data: { id: 'm1', source: { kind: 'user' } } },
  { seq: 3, type: 'assistant/message', data: {} },
  { seq: 4, type: 'turn/end', data: { turn: 1 } },
  { seq: 5, type: 'turn/start', data: { turn: 2 } },
  { seq: 6, type: 'user/message', data: { id: 'm2', source: { kind: 'user' } } },
  { seq: 7, type: 'assistant/message', data: {} },
  { seq: 8, type: 'turn/end', data: { turn: 2 } },
]

test('lists one entry per harness model', async () => {
  const { ctx } = fakeHarness()
  const r = await createDshRuntime(ctx).models()
  assert.equal(r.installed, true)
  assert.deepEqual(r.models.map(m => `${m.provider}/${m.id}`), ['ds/v4', 'ds/lite'])
  assert.equal(r.models[0].vision, true)
  assert.equal(r.default, 'ds/v4')
})

test('a fresh run opens a session in the chosen folder, the context injected ahead of the question', async () => {
  const { ctx, log } = fakeHarness()
  const { events } = await runToEnd(createDshRuntime(ctx), { runtime: 'dsh', cwd: '/proj', prompt: 'CTX\n\n---\n\nQ?', context: 'CTX', question: 'Q?', model: { provider: 'ds', id: 'lite' } })
  assert.deepEqual(log.created, [{ id: 'session-1', cwd: '/proj' }])
  assert.deepEqual(log.injected.map(i => i.text), ['CTX'])
  assert.equal(log.injected[0].source.kind, 'plugin')
  assert.deepEqual(log.prompts, [{ sessionId: 'session-1', text: 'Q?' }])
  assert.deepEqual(log.selected, [{ sessionId: 'session-1', provider: 'ds', model: 'lite' }])
  const session = events.find(e => e.type === 'session')
  assert.equal(session.sessionFile, '~/.dsh/sessions/session-1/session.jsonl.zstd')
  assert.equal(session.cwd, '/proj')
  assert.equal(session.continued, false)
  assert.deepEqual(events.filter(e => e.type === 'message_update').map(e => [e.assistantMessageEvent.type, e.assistantMessageEvent.delta]), [['thinking_delta', 'hm'], ['text_delta', 'Hel'], ['text_delta', 'lo']])
  assert.deepEqual(events.find(e => e.type === 'tool_execution_start'), { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: '/w/a.txt' } })
  assert.deepEqual(events.find(e => e.type === 'tool_execution_end'), { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', isError: false })
  assert.deepEqual(events.at(-1), { type: 'run_end', text: 'Hello', how: 'end' })
})

test('a run on a session path continues that session with the question alone', async () => {
  const { ctx, log, addSession } = fakeHarness()
  addSession('session-a', '/proj', twoTurns)
  const { events } = await runToEnd(createDshRuntime(ctx), { runtime: 'dsh', cwd: '', prompt: 'Q?', context: 'CTX', question: 'Q?', sessionPath: '~/.dsh/sessions/session-a/session.jsonl.zstd' })
  assert.deepEqual(log.created, [])
  assert.deepEqual(log.injected, [])
  assert.deepEqual(log.prompts, [{ sessionId: 'session-a', text: 'Q?' }])
  assert.equal(events.find(e => e.type === 'session').continued, true)
})

test('forking after a turn cuts at that turn\'s end and sends the question alone', async () => {
  const { ctx, log, addSession } = fakeHarness()
  addSession('session-a', '/proj', twoTurns)
  const { events } = await runToEnd(createDshRuntime(ctx), { runtime: 'dsh', cwd: '', prompt: 'Q?', context: 'CTX', question: 'Q?', sessionPath: '~/.dsh/sessions/session-a/session.jsonl.zstd', forkAfterTurn: ['m1', 'x'] })
  assert.deepEqual(log.forks.map(f => [f.from, f.atSeq]), [['session-a', 4]])
  assert.deepEqual(log.injected, [])
  const session = events.find(e => e.type === 'session')
  assert.equal(session.forkedFrom, 'session-a')
  assert.equal(session.cwd, '/proj')
  assert.equal(session.continued, false)
})

test('a fork starts with the parent\'s turn alone: what the parent had queued does not come along', async () => {
  const { ctx, log, addSession, pendingOf } = fakeHarness()
  // the sibling question, asked off the same parent earlier and still queued
  // in what a wide fork cut hands the child
  addSession('session-a', '/proj', twoTurns, [{ id: 'sibling' }])
  const { events } = await runToEnd(createDshRuntime(ctx), { runtime: 'dsh', cwd: '', prompt: 'Q?', context: 'CTX', question: 'Q?', sessionPath: '~/.dsh/sessions/session-a/session.jsonl.zstd', forkAfterTurn: ['m1', 'x'] })
  const child = events.find(e => e.type === 'session').sessionId
  assert.deepEqual(log.cleared, [child])
  assert.deepEqual(pendingOf(child), [])
  assert.deepEqual(pendingOf('session-a'), [{ id: 'sibling' }]) // the parent keeps its own
  assert.deepEqual(log.prompts, [{ sessionId: child, text: 'Q?' }])
})

test('a continued session keeps whatever it has queued', async () => {
  const { ctx, log, addSession, pendingOf } = fakeHarness()
  addSession('session-a', '/proj', twoTurns, [{ id: 'queued-in-the-harness' }])
  await runToEnd(createDshRuntime(ctx), { runtime: 'dsh', cwd: '', prompt: 'Q?', question: 'Q?', sessionPath: '~/.dsh/sessions/session-a/session.jsonl.zstd' })
  assert.deepEqual(log.cleared, [])
  assert.deepEqual(pendingOf('session-a'), [{ id: 'queued-in-the-harness' }])
})

test('a turn that cannot be cut falls back to a fresh session carrying the context', async () => {
  const { ctx, log, addSession } = fakeHarness()
  // turn 2 still open
  addSession('session-a', '/proj', twoTurns.slice(0, 7))
  await runToEnd(createDshRuntime(ctx), { runtime: 'dsh', cwd: '/proj', prompt: 'Q?', context: 'CTX', question: 'Q?', sessionPath: '~/.dsh/sessions/session-a/session.jsonl.zstd', forkAfterTurn: ['m2'] })
  assert.deepEqual(log.forks, [])
  assert.equal(log.created.length, 1)
  assert.deepEqual(log.injected.map(i => i.text), ['CTX'])
})

test('an approval goes to the page on the feed, and to the harness panel when none is there', async () => {
  let listening = true
  let approve
  const { ctx } = fakeHarness({
    turn: (id, fire) => {
      approve = ctx.handlers.get('approval/request')[0]({ agent: { id }, toolName: 'bash', callId: 'c1', reason: 'writes outside' }, () => 'panel')
      void approve.then(() => fire(id, { type: 'turn/end', data: { turn: 1 } }))
    },
  })
  installApprovalAnswerer(ctx)
  const runtime = createDshRuntime(ctx, { host: { listening: () => listening } })
  const events = []
  const runId = await runtime.run({ runtime: 'dsh', cwd: '/p', prompt: 'Q', question: 'Q' }, (p) => {
    events.push(p.event)
    if (p.event.type === 'question') runtime.answer(p.runId, p.event.id, { confirmed: true })
  })
  assert.equal(await (async () => { while (!approve) await new Promise(r => setImmediate(r)); return approve })(), 'allowed-once')
  const q = events.find(e => e.type === 'question')
  assert.equal(q.kind, 'confirm')
  assert.equal(q.title, 'bash')
  assert.equal(q.message, 'writes outside')
  assert.equal(events.find(e => e.type === 'question_answered').outcome, 'allowed-once')
  assert.ok(runId.startsWith('dsh-'))

  // nobody on the feed: the harness's own panel answers
  listening = false
  approve = null
  await runToEnd(runtime, { runtime: 'dsh', cwd: '/p', prompt: 'Q', question: 'Q' })
  assert.equal(await approve, 'panel')
})

test('abort cancels the agent and ends the run', async () => {
  const { ctx, log } = fakeHarness({ turn: () => {} }) // a turn that never ends on its own
  const runtime = createDshRuntime(ctx)
  const events = []
  const ended = new Promise((resolve) => {
    void runtime.run({ runtime: 'dsh', cwd: '/p', prompt: 'Q', question: 'Q' }, (p) => {
      events.push(p.event)
      if (p.event.type === 'session') setImmediate(() => runtime.abort(p.runId))
      if (p.event.type === 'run_end') resolve()
    })
  })
  await ended
  assert.deepEqual(log.cancelled, ['session-1'])
  assert.equal(events.at(-1).how, 'aborted')
})

test('a v4 harness takes the context under a producer-owned source kind and streams through the agent\'s frames', async () => {
  // harness 0.2: the live stream is no session event, and the settled
  // message carries the same text again
  const turn = (id, fire) => {
    fire(id, { type: 'turn/start', data: { turn: 1 } })
    fire.stream(id, { type: 'start' })
    fire.stream(id, { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'hm' } })
    fire.stream(id, { type: 'chunk', chunk: { type: 'text-delta', text: 'Hel' } })
    fire.stream(id, { type: 'chunk', chunk: { type: 'text-delta', text: 'lo' } })
    fire.stream(id, { type: 'end' })
    fire(id, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hello' }] } } })
    fire(id, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }
  const { ctx, log } = fakeHarness({ version: 4, turn })
  const { events } = await runToEnd(createDshRuntime(ctx), { runtime: 'dsh', cwd: '/p', prompt: 'CTX\n\n---\n\nQ?', context: 'CTX', question: 'Q?' })
  assert.deepEqual(log.injected[0].source, { kind: 'plugin:dsh-thoughtdag' })
  assert.deepEqual(events.filter(e => e.type === 'message_update').map(e => [e.assistantMessageEvent.type, e.assistantMessageEvent.delta]), [['thinking_delta', 'hm'], ['text_delta', 'Hel'], ['text_delta', 'lo']])
  assert.deepEqual(events.at(-1), { type: 'run_end', text: 'Hello', how: 'end' })
})

test('a turn the harness ends in an error is the run\'s error, not an empty answer', async () => {
  const turn = (id, fire) => {
    fire(id, { type: 'turn/start', data: { turn: 1 } })
    fire(id, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'no API key', code: 'UNKNOWN' } } } })
  }
  const { ctx } = fakeHarness({ turn })
  const { events } = await runToEnd(createDshRuntime(ctx), { runtime: 'dsh', cwd: '/p', prompt: 'Q', question: 'Q' })
  assert.deepEqual(events.at(-1), { type: 'run_error', message: 'no API key' })
})

test('a question with images runs on a model that takes them, whatever it is called', async () => {
  const png = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
  // the picked model cannot see: the catalog's model that can takes the turn
  const a = fakeHarness()
  await runToEnd(createDshRuntime(a.ctx), { runtime: 'dsh', cwd: '/p', prompt: 'Q', question: 'Q', images: [png], model: { provider: 'ds', id: 'lite' } })
  assert.deepEqual(a.log.selected, [{ sessionId: 'session-1', provider: 'ds', model: 'v4' }])
  // the picked model can: it keeps the turn
  const b = fakeHarness()
  await runToEnd(createDshRuntime(b.ctx), { runtime: 'dsh', cwd: '/p', prompt: 'Q', question: 'Q', images: [png], model: { provider: 'ds', id: 'v4' } })
  assert.deepEqual(b.log.selected, [{ sessionId: 'session-1', provider: 'ds', model: 'v4' }])
})

test('a session path names its session', () => {
  assert.equal(sessionIdOfPath('~/.dsh/sessions/session-a/session.jsonl.zstd'), 'session-a')
  assert.equal(sessionIdOfPath('/Users/x/.dsh/sessions/-Users-x-proj/session-b/session.jsonl.zstd'), 'session-b')
  // the log's name carries the format version, and DSH moves it on
  assert.equal(sessionIdOfPath('/Users/x/.dsh/sessions/-Users-x-proj/session-c/session.v3.jsonl.zstd'), 'session-c')
  assert.equal(sessionIdOfPath('/tmp/other.jsonl'), null)
  assert.equal(sessionIdOfPath('/Users/x/.dsh/sessions/-Users-x-proj/session-d/notes.jsonl.zstd'), null)
})

test('a session directory is read at the format version it holds', () => {
  assert.equal(sessionLogName(['session.lock', 'session.v3.jsonl.zstd']), 'session.v3.jsonl.zstd')
  assert.equal(sessionLogName(['session.jsonl.zstd']), 'session.jsonl.zstd')
  // upgraded in place: the newer log is the session
  assert.equal(sessionLogName(['session.jsonl.zstd', 'session.v3.jsonl.zstd']), 'session.v3.jsonl.zstd')
  assert.equal(sessionLogName(['session.v3.jsonl.zstd', 'session.v10.jsonl.zstd']), 'session.v10.jsonl.zstd')
  assert.equal(sessionLogName(['session.lock']), null)
})

test('the disk walk finds sessions whatever version wrote them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-home-'))
  const ws = join(home, 'sessions', '--Users-x-proj--')
  for (const [dir, name] of [['session-old', 'session.jsonl.zstd'], ['session-new', 'session.v3.jsonl.zstd'], ['session-empty', 'session.lock']]) {
    await mkdir(join(ws, dir), { recursive: true })
    await writeFile(join(ws, dir, name), 'x')
  }
  const found = await findSessionFiles(home)
  assert.deepEqual(found.map(f => f.sessionDir).sort(), ['session-new', 'session-old'])
  assert.equal(found.find(f => f.sessionDir === 'session-new').log, join(ws, 'session-new', 'session.v3.jsonl.zstd'))
})
