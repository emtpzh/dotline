// window.desktopAgents over HTTP: the same surface the desktop shell
// exposes through IPC, implemented on a host's /agents endpoints — the
// harness plugin's host, or the local server. Events arrive on one feed: a
// WebSocket where the host offers one (it does not hold one of the browser's
// six connections per host, which the short requests a turn needs would
// otherwise queue behind), server-sent events where it does not. A dropped
// feed comes back on its own. Installed only when the host answers; the
// hosted deployment has no machine to run an agent on and never does.

import { hostFetch } from './host-fetch';

type AgentEvent = { runId: string; event: Record<string, unknown> & { type: string } };

/** How long a run waits for the feed before it starts anyway. */
const FEED_WAIT_MS = 3000;

export async function installAgentsHttpBridge(apiBase: string): Promise<boolean> {
  if (window.desktopAgents) return true;
  const api = apiBase.replace(/\/+$/, '');
  let available: Record<string, string | null>;
  try {
    const r = await hostFetch(api + '/agents/available', { credentials: 'same-origin' });
    if (!r.ok) return false;
    available = await r.json();
  } catch { return false; }
  const post = async <T,>(path: string, body: unknown): Promise<T> => {
    const r = await hostFetch(api + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body ?? {}) });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json() as Promise<T>;
  };

  const listeners: ((p: AgentEvent) => void)[] = [];
  const dispatch = (data: unknown) => {
    if (typeof data !== 'string') return;
    try { const p = JSON.parse(data) as AgentEvent; for (const cb of listeners) cb(p); } catch { /* a heartbeat */ }
  };

  // the socket first; a host that refuses it before it ever opened has none
  // (an older plugin, a server without the upgrade) and the page stays on SSE
  let mode: 'ws' | 'sse' = typeof WebSocket === 'function' ? 'ws' : 'sse';
  let socketEverOpened = false;
  let ws: WebSocket | null = null;
  let es: EventSource | null = null;
  let ready: Promise<void> | null = null;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const socketUrl = () => {
    const u = new URL(api + '/agents/ws', window.location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.href;
  };
  const retry = () => {
    ready = null;
    if (retryTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** retries++);
    retryTimer = setTimeout(() => { retryTimer = null; void ensureFeed(); }, delay);
  };
  /** The feed, connected; settles (never rejects) once it is up or has failed this time. */
  const ensureFeed = (): Promise<void> => {
    if (ready) return ready;
    ready = new Promise<void>((resolve) => {
      if (mode === 'ws') {
        const sock = new WebSocket(socketUrl());
        ws = sock;
        let opened = false;
        sock.onopen = () => { opened = true; socketEverOpened = true; retries = 0; resolve(); };
        sock.onmessage = (ev) => dispatch(ev.data);
        sock.onclose = () => {
          if (ws !== sock) return;
          ws = null;
          if (!opened && !socketEverOpened) { mode = 'sse'; ready = null; void ensureFeed().then(resolve); return; }
          resolve();
          retry();
        };
        return;
      }
      const src = new EventSource(api + '/agents/events');
      es = src;
      src.onopen = () => { retries = 0; resolve(); };
      src.onmessage = (ev) => dispatch(ev.data);
      // a dropped stream is retried by EventSource itself; a refused one is
      // closed for good — a new one after a pause, or no event ever arrives again
      src.onerror = () => {
        if (src.readyState !== EventSource.CLOSED || es !== src) return;
        es = null;
        resolve();
        retry();
      };
    });
    return ready;
  };
  /** A run's first events go out as it starts: be on the feed first (briefly). */
  const feedUp = () => Promise.race([ensureFeed(), new Promise<void>((r) => setTimeout(r, FEED_WAIT_MS))]);

  window.desktopAgents = {
    capabilities: { nativePicker: false },
    available: async () => available,
    models: async (runtime) => {
      const r = await hostFetch(api + '/agents/models' + (runtime ? `?runtime=${encodeURIComponent(runtime)}` : ''), { credentials: 'same-origin' });
      return r.json();
    },
    run: async (request) => { await feedUp(); const r = await post<{ runId: string }>('/agents/run', request); return r.runId; },
    abort: async (runId) => (await post<{ ok: boolean }>('/agents/abort', { runId })).ok,
    answer: async (runId, requestId, response) => (await post<{ ok: boolean }>('/agents/answer', { runId, requestId, response })).ok,
    workspace: async (canvasId) => (await post<{ dir: string }>('/agents/workspace', { canvasId })).dir,
    pickCwd: async () => null,
    guardWrite: async (cwd, config) => (await post<{ ok: boolean }>('/agents/guard', { cwd, config })).ok,
    writeMaterials: async (cwd, files) => post('/agents/materials', { cwd, files }),
    onEvent: (cb) => { listeners.push(cb); void ensureFeed(); },
  };
  return true;
}
