// Claude Code as an agent runtime: one `claude -p` process per turn, spoken
// to in stream-json both ways. The turn's text and thinking arrive as
// content-block deltas, tool calls as tool_use blocks with their
// tool_result, the end as a result message. The turn runs at the canvas's
// access level as Claude Code's own permission mode (read: `default`, where
// only reads go through; write: `acceptEdits`). Nobody is asked on the
// canvas: what that mode would ask about, Claude Code refuses by itself in
// print mode, and the model hears so as a failed tool call. The person's
// own allow rules in Claude Code's settings still apply. A session
// continues with `--resume`, branches with `--fork-session`. Claude Code
// keeps its session files under ~/.claude/projects, its login and its model
// aliases; the shell only asks. Same event kinds as the other runtimes.
//
// The turn is named (`turn`) by the transcript line carrying the prompt this
// run wrote, once the CLI has written it; `run_end` goes out after the
// process is gone, when the transcript holds all the turn will ever get.
'use strict';

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { snapshotDir, diffSnapshots } = require('./fs-diff.cjs');
const { sizeOf, linesFrom, samePrompt } = require('./turn-file.cjs');

const fsp = fs.promises;
const CANDIDATE_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'), path.join(os.homedir(), '.npm-global', 'bin'), path.join(os.homedir(), '.bun', 'bin')];

async function executable(p) { try { await fsp.access(p, fs.constants.X_OK); return true; } catch { return false; } }
async function findClaude() {
  const names = process.platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...CANDIDATE_DIRS].filter(Boolean);
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); if (await executable(p)) return p; }
  return null;
}
function childEnv() {
  const seen = new Set((process.env.PATH || '').split(path.delimiter).filter(Boolean));
  return { ...process.env, PATH: [...seen, ...CANDIDATE_DIRS.filter((d) => !seen.has(d))].join(path.delimiter) };
}

/** Claude Code has no model list; its aliases resolve to the newest model
 *  of each family inside the CLI, so they never go stale. The CLI's own
 *  "default" is not offered: which model it means lives in the CLI's settings
 *  and can change under the person, so the picker names families only. */
/** The effort levels this CLI accepts, in its own words, read from its own
 *  `--help` (the `--effort <level>` entry lists them in parentheses) — so a
 *  CLI that adds a level shows it without a change here. Empty when the
 *  CLI has no such flag. Read once per launch. */
let effortsPromise = null;
function effortsOf(bin) {
  if (!effortsPromise) effortsPromise = new Promise((resolve) => {
    execFile(bin, ['--help'], { env: childEnv(), timeout: 8000, maxBuffer: 1 << 20 }, (_err, stdout) => {
      const help = String(stdout || '');
      const at = help.indexOf('--effort');
      if (at < 0) return resolve([]);
      const next = help.indexOf('\n  --', at + 1);
      const m = help.slice(at, next > 0 ? next : undefined).match(/\(([a-z0-9_, \n-]+)\)/i);
      resolve(m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : []);
    });
  });
  return effortsPromise;
}

const MODELS = [
  { provider: 'claude-code', id: 'fable', name: 'Fable', reasoning: true, vision: true },
  { provider: 'claude-code', id: 'opus', name: 'Opus', reasoning: true, vision: true },
  { provider: 'claude-code', id: 'sonnet', name: 'Sonnet', reasoning: true, vision: true },
  { provider: 'claude-code', id: 'haiku', name: 'Haiku', reasoning: true, vision: true },
];

/** The effort a turn ran at, as the transcript records it on every
 *  assistant entry (`effort`) — the CLI's own setting when the canvas named none. */
async function turnEffortOf(file) {
  if (!file) return null;
  try {
    const lines = (await fsp.readFile(file, 'utf8')).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"effort"')) continue;
      try { const o = JSON.parse(lines[i]); if (o.type === 'assistant' && typeof o.effort === 'string') return o.effort; } catch { /* torn line */ }
    }
  } catch { /* no file */ }
  return null;
}

/** The uuid of the transcript's last user line carrying `prompt` (after
 *  byte `from`): the line the CLI wrote for this run's prompt. */
async function promptEntryIn(file, from, prompt) {
  let id = null;
  for (const l of await linesFrom(file, from)) {
    if (l?.type === 'user' && !l.isMeta && typeof l.uuid === 'string' && samePrompt(l.message?.content, prompt)) id = l.uuid;
  }
  return id;
}

/** The CLI's configured effort (`effortLevel` in ~/.claude/settings.json), when set. */
async function configuredEffort() {
  try { const s = JSON.parse(await fsp.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')); return typeof s.effortLevel === 'string' ? s.effortLevel : null; } catch { return null; }
}

/** ~/.claude/projects/<slug>/<sessionId>.jsonl. The slug is the cwd with
 *  '/' and '.' turned into '-', but a long path is cut and given a short
 *  suffix by Claude Code itself — so the file is found by its id across the
 *  project directories when the computed name is not there. */
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
async function sessionFileFor(cwd, sessionId) {
  const guess = path.join(PROJECTS_DIR, cwd.replace(/[/.]/g, '-'), `${sessionId}.jsonl`);
  if (await fsp.access(guess).then(() => true, () => false)) return guess;
  try {
    const dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const candidate = path.join(PROJECTS_DIR, d.name, `${sessionId}.jsonl`);
      if (await fsp.access(candidate).then(() => true, () => false)) return candidate;
    }
  } catch { /* no projects yet */ }
  return null;
}
// the session id is the file's name; a directory on the way may carry a
// UUID of its own (a project path that names a session), so take the LAST
const sessionIdOf = (sessionPath) => { const all = String(sessionPath ?? '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi); return all && all.length ? all[all.length - 1] : null; };

/** The permission mode for the canvas's access level. */
const permissionModeFor = (access) => (access === 'write' ? 'acceptEdits' : 'default');

function createClaudeRuntime({ log } = {}) {
  const say = log || (() => {});
  const runs = new Map();     // runId → state
  let binPromise = null;
  const bin = () => { if (!binPromise) binPromise = findClaude(); return binPromise; };

  return {
    available: () => bin(),

    async models() {
      const b = await bin();
      if (!b) return { installed: false, models: [], default: null };
      const [efforts, defaultEffort] = await Promise.all([effortsOf(b), configuredEffort()]);
      return { installed: true, models: MODELS.map((m) => ({ ...m, efforts, defaultEffort })), default: 'claude/claude-code/opus' };
    },

    async run(req, onEvent) {
      const asked = String(req.cwd || '');
      if (!asked || !path.isAbsolute(asked)) throw new Error('run needs an absolute cwd');
      await fsp.mkdir(asked, { recursive: true });
      // the folder's one spelling (no trailing slash, links resolved): the
      // one the CLI writes into its session file, and the one the canvas
      // compares a follow-up's directory against
      const cwd = await fsp.realpath(asked);
      const b = await bin();
      if (!b) throw new Error('claude is not installed (no `claude` on PATH or in the usual places)');
      const runId = randomUUID();
      const emit = (event) => { try { onEvent({ runId, event }); } catch { /* renderer gone */ } };
      const access = req.access === 'write' ? 'write' : 'read';
      const state = { runId, proc: null, asks: new Map(), text: '', final: null, sessionId: null, waiting: false, ended: false, aborted: false, turnId: null, file: null };
      runs.set(runId, state);

      void (async () => {
        const IDLE = Number(process.env.TD_AGENT_IDLE_MS) || 10 * 60 * 1000;
        let lastEvent = Date.now();
        const mark = (event) => { lastEvent = Date.now(); if (event.type === 'question') state.waiting = true; if (event.type === 'question_answered') state.waiting = false; emit(event); };
        let watchdog = null;
        const before = await snapshotDir(cwd).catch(() => null);
        try {
          const mode = permissionModeFor(access);
          const model = req.model && typeof req.model === 'object' && req.model.id && req.model.id !== 'default' ? req.model.id : null;
          const resumeId = req.sessionPath ? sessionIdOf(req.sessionPath) : null;
          const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', mode];
          if (model) args.push('--model', model);
          // only a level the CLI itself lists; anything else means its default
          if (req.effort && (await effortsOf(b)).includes(req.effort)) args.push('--effort', req.effort);
          if (resumeId) { args.push('--resume', resumeId); if (req.forkEntryId) args.push('--fork-session'); }
          // where this run's lines begin: a continued session's file as it
          // is now; a fresh or forked one is a new file (its copied history
          // comes first, the run's prompt last)
          const from = resumeId && !req.forkEntryId ? await sizeOf(await sessionFileFor(cwd, resumeId)) : 0;
          // the transcript line carrying this run's prompt, looked for as the turn goes until found
          let looking = false;
          const findTurn = async () => {
            if (state.turnId || looking || !state.sessionId) return;
            looking = true;
            try {
              state.file ??= await sessionFileFor(cwd, state.sessionId);
              const id = await promptEntryIn(state.file, state.file && !req.forkEntryId && resumeId === state.sessionId ? from : 0, req.prompt);
              if (id && !state.turnId) { state.turnId = id; mark({ type: 'turn', turnId: id }); }
            } finally { looking = false; }
          };
          const proc = spawn(b, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
          state.proc = proc;
          let buf = '';
          const finished = new Promise((resolve) => {
            const done = (how) => { if (state.ended) return; state.ended = true; resolve(how); };
            proc.stdout.on('data', (d) => {
              buf += d.toString();
              let i;
              while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                if (!line.trim()) continue;
                let m; try { m = JSON.parse(line); } catch { continue; }
                handle(m, done);
              }
            });
            proc.stderr.on('data', (d) => say('[claude stderr] ' + d.toString().trim().slice(0, 400)));
            proc.on('error', (e) => { mark({ type: 'run_error', message: 'spawn error: ' + e.message }); done('error'); });
            proc.on('exit', (code, signal) => { if (!state.ended) { if (!state.aborted && code) mark({ type: 'run_error', message: `claude exited (${signal || code})` }); done(state.aborted ? 'aborted' : (code ? 'error' : 'end')); } });
          });
          watchdog = setInterval(() => {
            if (state.waiting || Date.now() - lastEvent < IDLE) return;
            mark({ type: 'run_error', message: `no activity for ${IDLE >= 60000 ? Math.round(IDLE / 60000) + ' min' : Math.round(IDLE / 1000) + ' s'}; the turn was stopped` });
            state.aborted = true; try { proc.kill(); } catch { /* gone */ }
          }, 15000);

          const handle = (m, done) => {
            switch (m.type) {
              case 'system':
                if (m.subtype === 'init') {
                  state.sessionId = m.session_id;
                  // the file appears once the first lines are written; the
                  // completion re-emits the session with its real path
                  mark({ type: 'session', sessionId: m.session_id, sessionFile: null, model: model ? { provider: 'claude-code', id: model, name: model } : null, cwd });
                } else if (m.subtype === 'permission_denied') {
                  mark({ type: 'tool_execution_end', toolCallId: m.tool_use_id ?? '', toolName: m.tool_name ?? 'tool', result: 'permission denied', isError: true });
                }
                break;
              case 'stream_event': {
                const ev = m.event ?? {};
                if (ev.type === 'content_block_delta') {
                  const d = ev.delta ?? {};
                  if (d.type === 'text_delta' && d.text) { state.text += d.text; mark({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: d.text } }); }
                  else if (d.type === 'thinking_delta' && d.thinking) mark({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: d.thinking } });
                }
                break;
              }
              case 'assistant':
                void findTurn();
                // the alias resolved to a real model inside the CLI; the final session event carries it
                if (!state.resolvedModel && typeof m.message?.model === 'string') state.resolvedModel = m.message.model;
                for (const b of m.message?.content ?? []) if (b.type === 'tool_use') mark({ type: 'tool_execution_start', toolCallId: b.id, toolName: b.name, args: b.input ?? {} });
                break;
              case 'user':
                for (const b of m.message?.content ?? []) if (b.type === 'tool_result') mark({ type: 'tool_execution_end', toolCallId: b.tool_use_id, toolName: '', result: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null).slice(0, 4000), isError: !!b.is_error });
                break;
              case 'control_request':
                // nothing is handed to the canvas to decide
                write(proc, { type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'unsupported request' } });
                break;
              case 'result':
                state.final = typeof m.result === 'string' ? m.result : null;
                if (m.subtype && m.subtype !== 'success') mark({ type: 'run_error', message: String(m.result ?? m.subtype) });
                done(m.subtype === 'success' ? 'end' : 'error');
                break;
              default: break;
            }
          };

          // the prompt goes in as one user message; stdin stays open for answers
          const content = [{ type: 'text', text: String(req.prompt ?? '') }];
          for (const img of Array.isArray(req.images) ? req.images : []) if (img && typeof img.data === 'string') content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } });
          write(proc, { type: 'user', message: { role: 'user', content } });

          const how = await finished;
          // let the CLI finish writing its transcript: it exits on its own
          // after the result; a kill is only the fallback
          await new Promise((resolve) => { if (proc.exitCode !== null || proc.signalCode) return resolve(); const t = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } resolve(); }, 8000); proc.once('exit', () => { clearTimeout(t); resolve(); }); });
          // the process is gone: the transcript holds all this turn will get
          await findTurn();
          if (state.sessionId) {
            const file = state.file ?? await sessionFileFor(cwd, state.sessionId);
            const ran = await turnEffortOf(file);
            mark({ type: 'session', effort: ran, sessionId: state.sessionId, sessionFile: file, model: { provider: 'claude-code', id: model ?? 'default', name: model ?? 'default', ...(state.resolvedModel ? { resolved: state.resolvedModel } : {}) }, cwd });
          }
          if (before) {
            const after = await snapshotDir(cwd).catch(() => null);
            if (after) { const d = diffSnapshots(before, after); if (d.changed.length || d.added.length || d.removed.length || d.truncated) mark({ type: 'fs_changes', ...d }); }
          }
          mark({ type: 'run_end', text: state.final ?? state.text, how, ...(state.turnId ? { turnId: state.turnId } : {}), held: !!state.turnId });
        } catch (e) {
          mark({ type: 'run_error', message: e instanceof Error ? e.message : String(e) });
          mark({ type: 'run_end', text: state.final ?? state.text, how: 'error', ...(state.turnId ? { turnId: state.turnId } : {}), held: false });
        } finally {
          if (watchdog) clearInterval(watchdog);
          runs.delete(runId);
        }
      })();
      return runId;
    },

    abort(runId) {
      const r = runs.get(runId);
      if (!r) return false;
      r.aborted = true;
      for (const [id, respond] of r.asks) { respond({ confirmed: false }); r.asks.delete(id); }
      try { r.proc?.kill(); } catch { /* gone */ }
      return true;
    },

    answer(runId, requestId, response) {
      const r = runs.get(runId);
      const respond = r?.asks.get(String(requestId));
      if (!respond) return false;
      r.asks.delete(String(requestId));
      const a = response && typeof response === 'object' ? response : { confirmed: !!response };
      respond(a.cancelled ? { confirmed: false } : a);
      return true;
    },

    shutdown() { for (const r of runs.values()) { try { r.proc?.kill(); } catch { /* gone */ } } },
  };
}

function write(proc, obj) { try { proc.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; } }

module.exports = { promptEntryIn, createClaudeRuntime, findClaude };
