// The agents surface over HTTP, for hosts that are not the desktop shell:
// the harness plugin's host and the local server. Same calls as
// window.desktopAgents, one endpoint each, and one feed carrying every run's
// events (the renderer's shim turns it back into onEvent): a WebSocket where
// the host can upgrade (`upgrade`), server-sent events otherwise. Runtimes
// are created on first use, as in the shell.
'use strict';
const path = require('node:path');
const os = require('node:os');
const ops = require('./ops.cjs');
const terminal = require('../terminal.cjs');
const { acceptWebSocket } = require('./ws-feed.cjs');
const { createRunRegistry } = require('./registry.cjs');

const RUNTIME_FACTORIES = {
  pi: (log) => require('./pi.cjs').createPiRuntime({ log }),
  codex: (log) => require('./codex.cjs').createCodexRuntime({ log }),
  'claude-code': (log) => require('./claude.cjs').createClaudeRuntime({ log }),
};

/**
 * `extraRuntimes` adds runtimes only the host can build — the harness
 * plugin's own agent loop needs the harness's context — as factories of
 * (log, host); `host.listening()` says whether any page is on the events
 * feed right now, so a runtime can hand a question elsewhere when nobody is.
 */
function createAgentsHttp({ workspaceRoot = path.join(os.homedir(), '.thoughtdag', 'workspaces'), log = () => {}, extraRuntimes = {} } = {}) {
  const factories = { ...RUNTIME_FACTORIES, ...extraRuntimes };
  const runtimes = new Map();
  const owners = new Map();      // runId → runtime name
  const clients = new Set();     // pages on the feed: { send(text), ping(), close() }
  const registry = createRunRegistry();
  const host = { listening: () => clients.size > 0 };
  const runtime = (name = 'pi') => {
    const key = factories[name] ? name : 'pi';
    if (!runtimes.has(key)) runtimes.set(key, factories[key](log, host));
    return runtimes.get(key);
  };
  const broadcast = (payload) => {
    const text = JSON.stringify(payload);
    for (const c of clients) { try { c.send(text); } catch { clients.delete(c); } }
  };
  const heartbeat = setInterval(() => { for (const c of clients) { try { c.ping(); } catch { clients.delete(c); } } }, 20000);
  heartbeat.unref?.();

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  /**
   * Handle one request. `sub` is the path after the mount point, starting
   * with `/agents`; `body` is the parsed JSON body (or null). Returns false
   * when the path is not ours.
   */
  async function handle(req, res, sub, body) {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = sub.replace(/\/+$/, '');
    const method = req.method ?? 'GET';
    try {
      if (p === '/agents/available' && method === 'GET') {
        const out = {};
        for (const name of Object.keys(factories)) out[name] = await runtime(name).available().catch(() => null);
        return json(res, 200, out), true;
      }
      if (p === '/agents/models' && method === 'GET') {
        const name = url.searchParams.get('runtime') ?? 'pi';
        // a runtime this host cannot run is not installed here — never another one's catalog
        if (!factories[name]) return json(res, 200, { installed: false, models: [], default: null }), true;
        try { return json(res, 200, await runtime(name).models()), true; }
        catch (e) { return json(res, 200, { installed: false, models: [], default: null, error: e instanceof Error ? e.message : String(e) }), true; }
      }
      if (p === '/agents/events' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        const client = { send: (text) => res.write(`data: ${text}\n\n`), ping: () => res.write(': hb\n\n'), close: () => res.end() };
        clients.add(client);
        req.on('close', () => clients.delete(client));
        return true;
      }
      if (p === '/agents/run' && method === 'POST') {
        const r = body && typeof body === 'object' ? body : {};
        if (r.runtime && !factories[r.runtime]) return json(res, 400, { error: `no ${r.runtime} runtime on this host` }), true;
        const name = r.runtime || 'pi';
        const runId = await runtime(name).run(r, registry.relay(name, broadcast));
        owners.set(runId, name);
        registry.started(name, runId);
        return json(res, 200, { runId }), true;
      }
      // the runs this host process knows: what a page that missed their events asks
      if (p === '/agents/runs' && method === 'GET') return json(res, 200, registry.list()), true;
      if (p === '/agents/abort' && method === 'POST') {
        const id = String(body?.runId ?? '');
        return json(res, 200, { ok: runtime(owners.get(id)).abort(id) }), true;
      }
      if (p === '/agents/answer' && method === 'POST') {
        const id = String(body?.runId ?? '');
        return json(res, 200, { ok: runtime(owners.get(id)).answer(id, String(body?.requestId ?? ''), body?.response) }), true;
      }
      if (p === '/agents/workspace' && method === 'POST') return json(res, 200, { dir: await ops.workspaceFor(workspaceRoot, String(body?.canvasId ?? 'default')) }), true;
      if (p === '/agents/materials' && method === 'POST') return json(res, 200, await ops.writeMaterials(String(body?.cwd ?? ''), body?.files)), true;
      if (p === '/agents/stat' && method === 'POST') return json(res, 200, await ops.statDir(String(body?.path ?? ''))), true;
      if (p === '/agents/open-in-cli' && method === 'POST') return json(res, 200, await terminal.openInTerminal(String(body?.runner ?? ''), body?.cwd ?? null, String(body?.sessionId ?? ''))), true;
      return false;
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      return true;
    }
  }

  /** The same feed over a WebSocket: the host calls this from its upgrade
   *  route (after its own Host / Origin checks). */
  function upgrade(req, socket, head) {
    const client = acceptWebSocket(req, socket, head);
    if (!client) return;
    clients.add(client);
    client.onClose(() => clients.delete(client));
  }

  const shutdown = () => { clearInterval(heartbeat); for (const r of runtimes.values()) r.shutdown(); for (const c of clients) { try { c.close(); } catch { /* gone */ } } };
  return { handle, upgrade, shutdown };
}

// hosts that bring runtimes of their own check for this before relying on it
module.exports = { createAgentsHttp, extraRuntimes: true };
