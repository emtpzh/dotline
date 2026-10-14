// Codex as an agent runtime: one long-lived `codex app-server` (JSON-RPC 2.0
// over stdio, newline-delimited). A run is one turn on one thread: fresh
// (`thread/start` in the working directory), continued (`thread/resume`),
// or branched (`thread/fork`). The server's notifications become the same
// event kinds the Pi runtime emits, so the renderer reads nothing new:
// text and reasoning deltas, tool starts and ends, questions (the server's
// user-input requests), run_end. The turn runs at the canvas's access level
// as Codex's own sandbox (read: `read-only`, write: `workspace-write`) with
// approvals never asked for: what the sandbox refuses fails inside the turn,
// as a failed tool call, and any approval request that still arrives is
// declined. Codex keeps its rollout files, login and model
// list; the shell only asks.
//
// The turn is named as it starts (`turn`, the server's turn id — the id the
// rollout records on the turn's `turn_context`), and `run_end` goes out once
// the rollout holds the turn's close (`task_complete` / `turn_aborted`).
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { snapshotDir, diffSnapshots } = require('./fs-diff.cjs');
const { sizeOf, linesFrom, until } = require('./turn-file.cjs');

const fsp = fs.promises;
const RESPONSE_MS = 30 * 1000;
const CANDIDATE_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.bun', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), path.join(os.homedir(), '.local', 'bin')];

async function executable(p) { try { await fsp.access(p, fs.constants.X_OK); return true; } catch { return false; } }
async function findCodex() {
  const names = process.platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...CANDIDATE_DIRS].filter(Boolean);
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); if (await executable(p)) return p; }
  return null;
}
function childEnv() {
  const seen = new Set((process.env.PATH || '').split(path.delimiter).filter(Boolean));
  return { ...process.env, PATH: [...seen, ...CANDIDATE_DIRS.filter((d) => !seen.has(d))].join(path.delimiter) };
}

/** The canvas's access level as Codex policy: the sandbox decides, nobody is asked. */
const policyFor = (access) => ({ approvalPolicy: 'never', sandbox: access === 'write' ? 'workspace-write' : 'read-only' });

// the thread id is in the rollout's file name; take the LAST UUID in the
// path in case a directory carries one of its own
const threadIdOf = (sessionPath) => {
  const all = String(sessionPath ?? '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  return all && all.length ? all[all.length - 1] : null;
};

function createCodexRuntime({ log } = {}) {
  const say = log || (() => {});
  let proc = null;            // the app-server child
  let ready = null;           // initialize handshake
  let buf = '';
  let nextId = 1;
  const pending = new Map();  // our request id → resolve
  const runs = new Map();     // runId → run state
  const byThread = new Map(); // threadId → runId
  const serverAsks = new Map(); // question id → { rpcId, respond(answer) }
  let binPromise = null;
  const bin = () => { if (!binPromise) binPromise = findCodex(); return binPromise; };

  const write = (obj) => { try { proc.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; } };
  const send = (method, params, timeoutMs = RESPONSE_MS) => new Promise((resolve, reject) => {
    if (!proc) return reject(new Error('codex app-server is not running'));
    lastUse = Date.now();
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`codex did not answer ${method} in ${timeoutMs / 1000}s`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); if (msg.error) reject(new Error(msg.error.message || `codex refused ${method}`)); else resolve(msg.result); });
    if (!write({ jsonrpc: '2.0', id, method, params })) { clearTimeout(timer); pending.delete(id); reject(new Error('codex stdin closed')); }
  });

  // The app-server retires after SERVER_IDLE_MS without a run or a request:
  // a catalog read at picker time must not pin a hundred megabytes for the
  // rest of the launch. The next run starts it again.
  const SERVER_IDLE_MS = Number(process.env.TD_AGENT_IDLE_MS) || 10 * 60 * 1000;
  let lastUse = Date.now();
  const retire = setInterval(() => {
    if (!proc || runs.size || pending.size || Date.now() - lastUse < SERVER_IDLE_MS) return;
    say('codex app-server idle; stopping it');
    try { proc.kill(); } catch { /* gone */ }
    proc = null; ready = null;
  }, 30 * 1000);
  retire.unref?.();

  const die = (reason) => {
    for (const p of pending.values()) p({ error: { message: reason } });
    pending.clear();
    for (const r of runs.values()) { r.emit({ type: 'run_error', message: reason }); r.end('exit'); }
    proc = null; ready = null;
  };

  async function ensureServer() {
    if (proc && ready) return ready;
    const b = await bin();
    if (!b) throw new Error('codex is not installed (no `codex` on PATH or in the usual places)');
    proc = spawn(b, ['app-server'], { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        dispatch(msg);
      }
    });
    proc.stderr.on('data', (d) => say('[codex stderr] ' + d.toString().trim().slice(0, 400)));
    proc.on('error', (e) => die('spawn error: ' + e.message));
    proc.on('exit', (code, signal) => die(`codex exited (${signal || code})`));
    ready = send('initialize', { clientInfo: { name: 'thoughtdag', title: 'ThoughtDAG', version: '0.5.0' }, capabilities: null })
      .then(() => { write({ jsonrpc: '2.0', method: 'initialized', params: {} }); });
    return ready;
  }

  // the effort a turn ran at, as the rollout records it (turn_context.effort):
  // the model's own default when the canvas named none
  async function turnEffortOf(file) {
    if (!file) return null;
    try {
      const lines = (await fsp.readFile(file, 'utf8')).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"turn_context"')) continue;
        try { const o = JSON.parse(lines[i]); if (o.type === 'turn_context' && typeof o.payload?.effort === 'string') return o.payload.effort; } catch { /* torn line */ }
      }
    } catch { /* no file yet */ }
    return null;
  }

  // ~/.codex/config.toml `model_reasoning_effort` overrides every model's own
  // default; the picker's 'default' must name what a turn will actually use
  async function configuredEffort() {
    try {
      const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      const m = (await fsp.readFile(path.join(home, 'config.toml'), 'utf8')).match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
      return m ? m[1] : null;
    } catch { return null; }
  }

  const runOf = (threadId) => { const id = byThread.get(threadId); return id ? runs.get(id) : undefined; };

  // ── the server speaks: responses, notifications, and its own requests ──
  function dispatch(msg) {
    lastUse = Date.now();
    if (msg.id !== undefined && msg.method === undefined) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p(msg); } return; }
    const params = msg.params ?? {};
    const run = runOf(params.threadId);
    if (msg.id !== undefined && msg.method) { serverRequest(msg, run); return; }
    if (!run) return;
    switch (msg.method) {
      case 'item/agentMessage/delta':
        run.text += String(params.delta ?? '');
        run.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: String(params.delta ?? '') } });
        break;
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        run.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: String(params.delta ?? '') } });
        break;
      case 'item/started': {
        const it = params.item ?? {};
        const t = toolOf(it);
        if (t) run.emit({ type: 'tool_execution_start', toolCallId: it.id, toolName: t.name, args: t.args });
        break;
      }
      case 'item/completed': {
        const it = params.item ?? {};
        if (it.type === 'agentMessage' && typeof it.text === 'string') run.final = it.text;
        const t = toolOf(it);
        if (t) run.emit({ type: 'tool_execution_end', toolCallId: it.id, toolName: t.name, result: t.result, isError: t.isError });
        break;
      }
      case 'turn/completed': {
        const turn = params.turn ?? {};
        if (turn.status === 'failed') run.emit({ type: 'run_error', message: turn.error?.message ?? 'the turn failed' });
        run.end(turn.status === 'interrupted' ? 'aborted' : turn.status === 'failed' ? 'error' : 'end');
        break;
      }
      default: break;
    }
  }

  /** A thread item as a tool call, for the trace and the record. */
  function toolOf(it) {
    switch (it.type) {
      case 'commandExecution': return { name: 'bash', args: { command: it.command, cwd: it.cwd }, result: it.aggregatedOutput ?? null, isError: it.status === 'failed' || (typeof it.exitCode === 'number' && it.exitCode !== 0) };
      case 'fileChange': return { name: 'edit', args: { path: (it.changes ?? []).map((c) => c.path).join(', ') }, result: it.status ?? null, isError: it.status === 'failed' || it.status === 'declined' };
      case 'mcpToolCall': return { name: `${it.server}/${it.tool}`, args: it.arguments ?? {}, result: it.result ?? it.error ?? null, isError: !!it.error };
      case 'dynamicToolCall': return { name: it.tool, args: it.arguments ?? {}, result: null, isError: it.status === 'failed' };
      case 'webSearch': return { name: 'web_search', args: { query: it.query ?? '' }, result: null, isError: false };
      default: return null;
    }
  }

  // ── the server asks the person: approvals and user input ──
  function serverRequest(msg, run) {
    const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
    const params = msg.params ?? {};
    if (!run) {
      // nobody at the canvas for this thread: fail closed
      if (msg.method === 'item/tool/requestUserInput') return reply({ answers: {} });
      if (msg.method === 'item/permissions/requestApproval') return reply({ permissions: {}, scope: 'turn' });
      return reply({ decision: 'decline' });
    }
    const ask = (question, respond) => {
      const id = `q-${msg.id}`;
      serverAsks.set(id, { rpcId: msg.id, respond });
      run.waiting = true;
      run.emit({ type: 'question', id, ...question });
    };
    const decided = (id, outcome, value) => { run.waiting = false; run.emit({ type: 'question_answered', id, outcome, value: value ?? null }); };
    // approvals are never asked for (policy `never`); one that arrives
    // anyway is beyond this turn's level: declined at once
    switch (msg.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return reply({ decision: 'decline' });
      case 'item/permissions/requestApproval':
        return reply({ permissions: {}, scope: 'turn' });
      case 'item/tool/requestUserInput': {
        // one question at a time; the answers go back together
        const qs = Array.isArray(params.questions) ? params.questions : [];
        const answers = {};
        const next = (i) => {
          if (i >= qs.length) { reply({ answers }); return; }
          const q = qs[i];
          const opts = (q.options ?? []).map((o) => o.label);
          ask({ kind: opts.length ? 'select' : 'input', title: q.header || 'question', message: q.question || '', options: opts, placeholder: q.isOther ? 'other…' : null, prefill: null, paths: [], suggest: null },
            (a, id) => { const v = typeof a?.value === 'string' ? a.value : ''; answers[q.id] = { answers: v ? [v] : [] }; decided(id, v ? 'answered' : 'cancelled', v || null); next(i + 1); });
        };
        return next(0);
      }
      default:
        return write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported request ${msg.method}` } });
    }
  }

  const effortsIn = (m) => (m.supportedReasoningEfforts ?? []).map((e) => (e && typeof e === 'object' ? e.reasoningEffort : e)).filter((e) => typeof e === 'string');
  const modelEntry = (m) => ({ provider: 'codex', id: m.model ?? m.id, name: m.displayName ?? m.model ?? m.id, reasoning: true, vision: true, efforts: effortsIn(m), defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : null });
  // model id → the reasoning efforts it advertises, from model/list
  const effortsByModel = new Map();
  const noteEfforts = (r) => { for (const m of r?.data ?? []) effortsByModel.set(m.model ?? m.id, effortsIn(m)); };
  // only a level the model itself advertises, in Codex's own words; anything
  // else means the model's default
  const effortFor = (model, word) => { const offered = effortsByModel.get(model); return word && offered && offered.includes(word) ? word : null; };
  // the model a run uses when the canvas named none: the server's own
  // default from model/list, not the config file's — a config can name a
  // model this CLI version cannot run, and the list only carries runnable ones
  let defaultModel = null;
  async function defaultModelId() {
    if (defaultModel) return defaultModel;
    try { const r = await send('model/list', {}); noteEfforts(r); const d = (r?.data ?? []).find((m) => m.isDefault) ?? (r?.data ?? [])[0]; defaultModel = d ? (d.model ?? d.id) : null; } catch { /* leave it to the config */ }
    return defaultModel;
  }

  return {
    available: () => bin(),

    async models() {
      const b = await bin();
      if (!b) return { installed: false, models: [], default: null };
      await ensureServer();
      const r = await send('model/list', {});
      noteEfforts(r);
      const configured = await configuredEffort();
      const models = (r?.data ?? []).filter((m) => !m.hidden).map(modelEntry).map((m) => (configured && m.efforts.includes(configured) ? { ...m, defaultEffort: configured } : m));
      const def = (r?.data ?? []).find((m) => m.isDefault);
      defaultModel = def ? (def.model ?? def.id) : defaultModel;
      return { installed: true, models, default: def ? `codex/${def.model ?? def.id}` : (models[0] ? `codex/${models[0].id}` : null) };
    },

    async run(req, onEvent) {
      const asked = String(req.cwd || '');
      if (!asked || !path.isAbsolute(asked)) throw new Error('run needs an absolute cwd');
      await fsp.mkdir(asked, { recursive: true });
      // the folder's one spelling (no trailing slash, links resolved): the
      // one the CLI writes into its session file, and the one the canvas
      // compares a follow-up's directory against
      const cwd = await fsp.realpath(asked);
      await ensureServer();
      const runId = randomUUID();
      const emit = (event) => { try { onEvent({ runId, event }); } catch { /* renderer gone */ } };
      const access = req.access === 'write' ? 'write' : 'read';
      const state = { runId, threadId: null, turnId: null, text: '', final: null, waiting: false, emit, end: null, done: null };
      state.done = new Promise((resolve) => { state.end = (how) => { if (state.ended) return; state.ended = true; resolve(how); }; });
      runs.set(runId, state);
      void (async () => {
        const IDLE = Number(process.env.TD_AGENT_IDLE_MS) || 10 * 60 * 1000;
        let lastEvent = Date.now();
        const origEmit = state.emit;
        state.emit = (event) => { lastEvent = Date.now(); if (event.type === 'question') state.waiting = true; if (event.type === 'question_answered') state.waiting = false; origEmit(event); };
        const watchdog = setInterval(() => {
          if (state.waiting || Date.now() - lastEvent < IDLE) return;
          state.emit({ type: 'run_error', message: `no activity for ${IDLE >= 60000 ? Math.round(IDLE / 60000) + ' min' : Math.round(IDLE / 1000) + ' s'}; the turn was stopped` });
          if (state.threadId && state.turnId) send('turn/interrupt', { threadId: state.threadId, turnId: state.turnId }).catch(() => {});
          setTimeout(() => state.end('idle'), 5000);
        }, 15000);
        try {
          const policy = policyFor(access);
          const model = (req.model && typeof req.model === 'object' && req.model.id ? req.model.id : null) ?? await defaultModelId();
          let thread;
          const resumeId = req.sessionPath ? threadIdOf(req.sessionPath) : null;
          if (req.forkEntryId && resumeId) thread = (await send('thread/fork', { threadId: resumeId, cwd, ...policy, ...(model ? { model } : {}) })).thread;
          else if (resumeId) thread = (await send('thread/resume', { threadId: resumeId, cwd, ...policy, ...(model ? { model } : {}) })).thread;
          else thread = (await send('thread/start', { cwd, ...policy, ...(model ? { model } : {}) })).thread;
          state.threadId = thread.id;
          byThread.set(thread.id, runId);
          state.emit({ type: 'session', sessionId: thread.id, sessionFile: thread.path ?? null, model: model ? { provider: 'codex', id: model, name: model } : null, cwd });
          const before = await snapshotDir(cwd).catch(() => null);
          const input = [{ type: 'text', text: String(req.prompt ?? ''), text_elements: [] }];
          for (const img of Array.isArray(req.images) ? req.images : []) if (img && typeof img.data === 'string') input.push({ type: 'image', url: `data:${img.mimeType};base64,${img.data}` });
          const effort = req.effort && model ? effortFor(model, req.effort) : null;
          // where this run's lines begin in the rollout
          const from = await sizeOf(thread.path);
          const started = await send('turn/start', { threadId: thread.id, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, 60 * 1000);
          state.turnId = started?.turn?.id ?? null;
          if (state.turnId) state.emit({ type: 'turn', turnId: state.turnId });
          const how = await state.done;
          const held = state.turnId && thread.path ? !!(await until(() => rolloutHolds(thread.path, from, state.turnId))) : false;
          const ran = await turnEffortOf(thread.path);
          if (ran) state.emit({ type: 'session', sessionId: thread.id, sessionFile: thread.path ?? null, model: model ? { provider: 'codex', id: model, name: model } : null, cwd, effort: ran });
          if (before) {
            const after = await snapshotDir(cwd).catch(() => null);
            if (after) { const d = diffSnapshots(before, after); if (d.changed.length || d.added.length || d.removed.length || d.truncated) state.emit({ type: 'fs_changes', ...d }); }
          }
          state.emit({ type: 'run_end', text: state.final ?? state.text, how, ...(state.turnId ? { turnId: state.turnId } : {}), held });
        } catch (e) {
          state.emit({ type: 'run_error', message: e instanceof Error ? e.message : String(e) });
          state.emit({ type: 'run_end', text: state.final ?? state.text, how: 'error', ...(state.turnId ? { turnId: state.turnId } : {}), held: false });
        } finally {
          clearInterval(watchdog);
          if (state.threadId) byThread.delete(state.threadId);
          runs.delete(runId);
        }
      })();
      return runId;
    },

    abort(runId) {
      const r = runs.get(runId);
      if (!r) return false;
      // withdraw any question still open for this run, then interrupt
      for (const [id, ask] of serverAsks) { if (id.startsWith('q-')) { /* the server's own timeout covers it */ } void ask; }
      if (r.threadId && r.turnId) send('turn/interrupt', { threadId: r.threadId, turnId: r.turnId }).catch(() => {});
      return true;
    },

    answer(runId, requestId, response) {
      const ask = serverAsks.get(String(requestId));
      if (!ask || !runs.has(runId)) return false;
      serverAsks.delete(String(requestId));
      const a = response && typeof response === 'object' ? response : { confirmed: !!response };
      if (a.cancelled) { ask.respond({ confirmed: false, value: '' }, String(requestId)); return true; }
      ask.respond(a, String(requestId));
      return true;
    },

    shutdown() { clearInterval(retire); try { proc?.kill(); } catch { /* gone */ } proc = null; ready = null; },
  };
}

/** The rollout holds the turn to its close: its `turn_context` (or
 *  `task_started`) and, after it, its `task_complete` or `turn_aborted`. */
async function rolloutHolds(file, from, turnId) {
  let open = false;
  for (const l of await linesFrom(file, from)) {
    const p = l?.payload ?? {};
    const starts = l?.type === 'turn_context' || (l?.type === 'event_msg' && p.type === 'task_started');
    if (starts) { open = p.turn_id === turnId; continue; }
    if (open && l?.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted') && (!p.turn_id || p.turn_id === turnId)) return true;
  }
  return false;
}

module.exports = { createCodexRuntime, findCodex, rolloutHolds };
