// Agent runtimes as models the canvas can pick. The desktop shell runs the
// agent (window.desktopAgents), the canvas compiles what it wired in and
// hands over one prompt, the agent answers with its own tools in a working
// directory, and its events come back as the same callbacks a streamed
// model call uses. The runtime keeps the session file, the keys and the
// catalog; the canvas keeps the context.
//
// THE CONTRACT — the only things this file asks of a runtime, whichever it
// is (Pi, Codex, Claude Code, and the harness's own agent loop when the
// canvas runs inside it):
//   1. start a run on a working directory with one prompt at an access level
//      (read / write, as the runtime's own permission mode, for a runtime
//      that has one; nothing beyond it is asked on the canvas — the CLI
//      refuses it, a failed tool call like any other) and, if the person
//      chose one, an effort level in the runtime's own words; abort it
//   2. an event stream carrying eight kinds, nothing else is read:
//        session · text · reasoning · tool_start · tool_end · question ·
//        end · error  (plus fs_changes, which the shell produces itself)
//   3. a session file on disk the atlas already knows how to read — the
//      turn lands on its node from there (lib/sessions/sync), never rebuilt
//      from the stream
//   4. a model list
// Everything runtime-specific lives in desktop/agents/<runtime>.js.

import type { ContextMessage, ImageAttachment, StreamCallbacks } from '../api';
import type { ModelInfo } from '../use-models';
import type { AgentRuntime, ThoughtNode } from '../../types';
import { useUiStore } from '../ui-store';
import { useStore } from '../../store';
import { continuity, linkOf, sessionOf, type SessionLink } from './continuity';

export { AGENT_RUNTIMES, LIVE_RUNTIMES, AGENT_PROVIDER, runtimeOf, isAgentModel, agentTarget, type RuntimeCaps } from './runtimes';
import { AGENT_RUNTIMES, LIVE_RUNTIMES, AGENT_PROVIDER, runtimeOf, agentTarget } from './runtimes';
import { intentOf, lineCwd, inheritCwd } from '../run-intent';

/** Every live runtime's configured models as picker entries; a runtime
 *  that is not installed contributes nothing. */
export async function agentModels(): Promise<ModelInfo[]> {
  const bridge = window.desktopAgents;
  if (!bridge) return [];
  // only runtimes the host says it has: a host that predates one (an older
  // harness plugin, before the harness's own loop joined) must not answer
  // for it with another runtime's catalog
  const present = await bridge.available().catch(() => ({} as Record<string, string | null>));
  // the runtimes answer side by side: one slow catalog does not queue the others
  const answers = await Promise.all(LIVE_RUNTIMES.map((runtime) => (present[runtime] ? bridge.models(runtime).catch(() => null) : null)));
  const out: ModelInfo[] = [];
  LIVE_RUNTIMES.forEach((runtime, i) => {
    const def = AGENT_RUNTIMES[runtime];
    const r = answers[i];
    if (!r?.installed) return; // not installed, or it did not answer: it stays out of the list
    const presets = r.presets?.length ? r.presets : undefined;
    for (const m of r.models) out.push({ id: `${def.prefix}${m.provider}/${m.id}`, name: `${def.label} · ${m.name}`, provider: AGENT_PROVIDER, vision: m.vision, efforts: m.efforts ?? [], defaultEffort: m.defaultEffort ?? null, ...(presets ? { presets } : {}) });
  });
  return out;
}

export type AgentRoute = {
  cwd: string; sessionPath?: string; forkAfterTurn?: string[]; continue?: boolean;
  /** what became of the session above, as the node will record it */
  link?: SessionLink;
  /** a continued session: which one, and the turn the new one follows —
      the run's binding, known before it starts */
  sessionId?: string; afterTurnId?: string;
};

/** Where an agent turn runs: the folder the person chose for this canvas,
 *  the project its mirrored nodes came from, the canvas's own workspace —
 *  or, for a runtime without workspaces, the session the harness chat
 *  shows now, else the runtime's own default (cwd ''). */
export type CwdChoice = { cwd: string; kind: 'chosen' | 'mirrored' | 'workspace' | 'session' | 'default' };

/** The project directory most of the active canvas's mirrored nodes came from. */
function majorityCwd(nodes: ThoughtNode[]): string | null {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const c = n.data.importSource?.cwd;
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: string | null = null; let bestN = 0;
  for (const [c, n] of counts) if (n > bestN) { best = c; bestN = n; }
  return best;
}

/** The working directory the active canvas's agent turns run in on this
 *  runtime (the picked model's when omitted): the one the person chose for
 *  this canvas, else the project its mirrored nodes came from, else the
 *  canvas's own workspace — or, where the runtime has none, the harness
 *  chat's current session, else the runtime's default. */
export async function resolveAgentCwd(runtime: AgentRuntime | null = runtimeOf(useUiStore.getState().selectedModel)): Promise<CwdChoice | null> {
  if (!window.desktopAgents) return null;
  try {
    const { useProjects } = await import('../../store/projects');
    const { projects, activeId } = useProjects.getState();
    const meta = projects.find((p) => p.id === activeId);
    if (meta?.agentCwd) return { cwd: meta.agentCwd, kind: 'chosen' };
    const best = majorityCwd(useStore.getState().nodes);
    if (runtime && !AGENT_RUNTIMES[runtime].caps.workspace) {
      if (best) return { cwd: best, kind: 'mirrored' };
      const current = runtime === 'dsh' ? (await import('../atlas/dsh-bridge')).currentDshSession()?.cwd : null;
      return current ? { cwd: current, kind: 'session' } : { cwd: '', kind: 'default' };
    }
    const workspace = await window.desktopAgents.workspace(activeId ?? 'default');
    if (best && best !== workspace) return { cwd: best, kind: 'mirrored' };
    return { cwd: workspace, kind: 'workspace' };
  } catch {
    return null;
  }
}

/** The mirrored project directory of the active canvas, if any. */
export async function mirroredCwd(): Promise<string | null> {
  try {
    const { useProjects } = await import('../../store/projects');
    const workspace = window.desktopAgents ? await window.desktopAgents.workspace(useProjects.getState().activeId ?? 'default') : null;
    const best = majorityCwd(useStore.getState().nodes);
    return best && best !== workspace ? best : null;
  } catch { return null; }
}

/** The session file for a session id: the tail node's own record, else the
 *  session registry's (which finds it by name under the runtime's root). */
async function agentSessionFile(runtime: AgentRuntime, sessionId: string, tail: { data: { agentSession?: { sessionId: string | null; sessionFile: string | null } } } | undefined): Promise<string | null> {
  const own = tail?.data.agentSession;
  if (own?.sessionId === sessionId && own.sessionFile) return own.sessionFile;
  const { sessionFile, absolutePath } = await import('../sessions/store');
  const loc = await sessionFile(runtime, sessionId);
  return loc ? absolutePath(loc) : null;
}

/**
 * The directory a node's agent turn runs in, settled on the node the first
 * time it runs on this runtime: its own (intent, or what its turn ran in),
 * else its one parent's session directory on the same runtime, else the
 * canvas's default. From then on it is the node's — the canvas's default
 * moving on does not move it. undefined = no agents bridge.
 */
export async function nodeCwd(nodeId: string, runtime: AgentRuntime): Promise<string | undefined> {
  const { nodes, edges } = useStore.getState();
  const node = nodes.find((n) => n.id === nodeId);
  const { parentsOf } = await import('../../store/intent');
  let cwd = lineCwd(node?.data, runtime);
  if (cwd === undefined) {
    cwd = inheritCwd(parentsOf(nodeId, nodes, edges), runtime);
    // the session's directory moved or was deleted: never recreated empty
    // under the old path — the line starts over where new lines start
    const { dirExists } = await import('../sessions/store');
    if (cwd && (await dirExists(cwd)) === false) cwd = undefined;
  }
  if (cwd === undefined) cwd = (await resolveAgentCwd(runtime))?.cwd;
  if (cwd !== undefined && node && node.data.cwd !== cwd) {
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, cwd } } : n)) }));
  }
  return cwd;
}

/**
 * The route for the node about to generate, in the node's own directory. A
 * question asked DIRECTLY off a session's tail, with nothing else wired in,
 * nothing above it edited on the canvas and the same directory, continues
 * that session: the session already holds the conversation, so only the
 * question travels. The same question off an earlier turn of a session
 * opens a new session holding the conversation up to that turn, where the
 * runtime can cut one. Anything else — other wiring, an edit, another
 * directory — opens a fresh session carrying the compiled context. The
 * decision is lib/agents/continuity's, the same one the ask boxes warn from.
 */
export async function agentOutbound(model: string | undefined, nodeId?: string): Promise<AgentRoute | undefined> {
  const runtime = runtimeOf(model);
  if (!window.desktopAgents || !runtime) return undefined;
  if (!nodeId) {
    const choice = await resolveAgentCwd(runtime);
    return choice ? { cwd: choice.cwd } : undefined;
  }
  const cwd = await nodeCwd(nodeId, runtime);
  if (cwd === undefined) return undefined;
  try {
    const { nodes } = useStore.getState();
    const c = continuity(nodeId, nodes, useStore.getState().edges, runtime, cwd);
    if (c?.kind === 'new' && c.reason === 'cwd') {
      // left the session's directory because it is gone, not by choice: say that
      const was = sessionOf(nodes.find((n) => n.id === c.parentId)?.data ?? {})?.cwd;
      const { dirExists } = await import('../sessions/store');
      if (was && (await dirExists(was)) === false) return { cwd, link: { kind: 'new', reason: 'gone', detail: was } };
    }
    if (!c || c.kind === 'new') return { cwd, link: linkOf(c) };
    const parent = nodes.find((n) => n.id === c.parentId);
    const sessionPath = await agentSessionFile(runtime, c.sessionId, parent);
    // the session is named but its record is gone: nothing to lean on
    if (!sessionPath) return { cwd, link: { kind: 'new', reason: 'missing' } };
    if (c.kind === 'continue') return { cwd, sessionPath, continue: true, sessionId: c.sessionId, ...(parent?.data.importSource?.itemIds?.[0] ? { afterTurnId: parent.data.importSource.itemIds[0] } : {}) };
    return { cwd, sessionPath, forkAfterTurn: parent?.data.importSource?.itemIds ?? [], link: linkOf(c) };
  } catch {
    return { cwd };
  }
}

/** The materials wired into a node's context — its own and its ancestors'
 *  document attachments — written where the agent can read them. Returns
 *  the note to append to the prompt, or '' when nothing was written. */
async function materialsToDisk(nodeId: string | undefined, cwd: string): Promise<string> {
  if (!nodeId || !window.desktopAgents) return '';
  try {
    const { useStore } = await import('../../store');
    const { loadAttachmentContent } = await import('../attachment-vault');
    const { nodes, edges } = useStore.getState();
    const seen = new Set<string>();
    const queue = [nodeId];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of edges) if (e.target === id && !seen.has(e.source)) queue.push(e.source);
    }
    const files: { name: string; content: string; encoding?: 'utf8' | 'base64' }[] = [];
    const names = new Set<string>();
    for (const n of nodes) {
      if (!seen.has(n.id)) continue;
      for (const att of n.data.attachments ?? []) {
        if (names.has(att.name) || files.length >= 40) continue;
        const isPdf = /^application\/pdf/.test(att.type);
        const isImage = att.type.startsWith('image/');
        if (isImage) continue;
        let content = '';
        try { content = await loadAttachmentContent(att); } catch { content = att.content; }
        if (!content) continue;
        names.add(att.name);
        if (isPdf) files.push({ name: att.name, content, encoding: 'base64' });
        else files.push({ name: att.name, content });
      }
    }
    if (files.length === 0) return '';
    const r = await window.desktopAgents.writeMaterials(cwd, files);
    if (!r.dir || r.written.length === 0) return '';
    return `The canvas's materials are also on disk, readable with your tools, under ${r.dir}:\n` + r.written.map((f) => '- ' + f).join('\n');
  } catch {
    return '';
  }
}

/** The canvas's compiled messages, split for an agent that keeps its own
 *  history: the last user message is the question; everything before it is
 *  the context the canvas wired in, sent ahead of the question as one block. */
export function compileForAgent(messages: ContextMessage[]): { question: string; context: string } {
  const msgs = messages.filter((m) => m && typeof m.content === 'string' && m.content.trim());
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') throw new Error('the last message must be the question');
  const system = msgs.slice(0, -1).filter((m) => m.role === 'system').map((m) => m.content.trim());
  const history = msgs.slice(0, -1).filter((m) => m.role !== 'system');
  const parts: string[] = [];
  if (system.length) parts.push('Instructions from the canvas:\n\n' + system.join('\n\n'));
  if (history.length) parts.push('The conversation the canvas wired into this question, oldest first:\n\n' + history.map((m) => `[${m.role === 'assistant' ? 'assistant' : 'user'}]\n${m.content.trim()}`).join('\n\n'));
  const context = parts.length
    ? '[Dotline canvas context] The question that follows was asked from a Dotline canvas. Treat the material below as the conversation so far; answer the question at the end.\n\n' + parts.join('\n\n---\n\n')
    : '';
  return { question: last.content.trim(), context };
}

type AgentEvent = { runId: string; event: Record<string, unknown> & { type: string } };
const handlers = new Map<string, (event: AgentEvent['event']) => void>();
/** Events of runs nobody handles yet. Over HTTP the events feed can beat the
 *  run's own reply: a run's first events wait here until its handler is set
 *  (other pages' runs pass through too; only the latest few are kept). */
const early = new Map<string, AgentEvent['event'][]>();
const EARLY_RUNS = 16;
let subscribed = false;
function subscribe() {
  if (subscribed || !window.desktopAgents) return;
  subscribed = true;
  window.desktopAgents.onEvent(({ runId, event }) => {
    const h = handlers.get(runId);
    if (h) { h(event); return; }
    const q = early.get(runId) ?? [];
    if (q.length < 2000) q.push(event);
    early.delete(runId);
    early.set(runId, q);
    if (early.size > EARLY_RUNS) early.delete(early.keys().next().value!);
  });
}
/** Handle a run's events, starting with any that arrived before its id did. */
function handleRun(runId: string, handler: (event: AgentEvent['event']) => void): void {
  handlers.set(runId, handler);
  const q = early.get(runId);
  early.delete(runId);
  for (const event of q ?? []) handlers.get(runId)?.(event);
}

/** The agent preset the global choice names for this model's runtime, when
 *  the runtime lists it and it can compose a session; else undefined (the
 *  runtime's own default). */
async function presetFor(modelId: string): Promise<string | undefined> {
  const chosen = useUiStore.getState().agentPreset;
  if (!chosen) return undefined;
  const { getModelsOnce } = await import('../use-models');
  const presets = (await getModelsOnce().catch(() => null))?.models.find((m) => m.id === modelId)?.presets;
  return presets?.some((p) => p.id === chosen && !p.broken) ? chosen : undefined;
}

/** One line naming what a tool call does, for the node's progress row. */
function toolQuery(name: string, args: unknown): string {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : null;
  if (!a) return '';
  for (const k of ['command', 'path', 'file_path', 'pattern', 'url', 'query', 'description']) {
    const v = a[k];
    if (typeof v === 'string' && v) return v.slice(0, 120);
  }
  const first = Object.values(a).find((v) => typeof v === 'string' && v);
  return typeof first === 'string' ? first.slice(0, 120) : name;
}

/**
 * One turn on an agent runtime with the streamed-call contract: text deltas
 * through onChunk, thinking through onReasoning, tool starts through
 * onToolCall, the session through onAgentSession; resolves with the final
 * text; an aborted signal stops the run and rejects with AbortError.
 */
export async function agentCallStream(
  messages: ContextMessage[],
  onChunk: (chunk: string, fullSoFar: string) => void,
  signal: AbortSignal | undefined,
  images: ImageAttachment[] | undefined,
  callbacks: StreamCallbacks | undefined,
  modelId: string,
  route: AgentRoute | undefined,
  nodeId?: string,
): Promise<string> {
  const bridge = window.desktopAgents;
  if (!bridge) throw new Error('agent runtimes need the desktop app');
  const target = agentTarget(modelId);
  if (!target) throw new Error('not an agent model: ' + modelId);
  const { caps } = AGENT_RUNTIMES[target.runtime];
  const cwd = route?.cwd ?? (await agentOutbound(modelId))?.cwd;
  // '' leaves the directory to a runtime that has a default of its own
  if (cwd === undefined || (!cwd && caps.workspace)) throw new Error('no working directory for this canvas');
  const { question, context } = compileForAgent(messages);
  // the node's own level and access (its intent, or what its last turn ran
  // at), the global ones only for a node that has neither
  const data = nodeId ? useStore.getState().nodes.find((n) => n.id === nodeId)?.data : undefined;
  const intent = intentOf(data);
  // a runtime without levels runs as it would in the terminal
  const access = caps.access ? intent.access ?? (intent.model ? 'read' : useUiStore.getState().agentAccess) : undefined;
  // a continued or forked session already holds the conversation: only the
  // question travels (the context rides along for a runtime that has to
  // fall back to a fresh session)
  const inherits = !!route?.sessionPath && (!!route.continue || !!route.forkAfterTurn?.length);
  const materials = inherits || !cwd ? '' : await materialsToDisk(nodeId, cwd);
  const ahead = [context, materials].filter(Boolean).join('\n\n');
  const prompt = !inherits && ahead ? `${ahead}\n\n---\n\n${question}` : question;
  const effort = data?.effort !== undefined || intent.model ? intent.effort : (useUiStore.getState().agentEffort || undefined);
  // the preset a fresh session is composed from: the global choice, while the
  // runtime still lists it whole (one deleted or broken since: its default)
  const preset = await presetFor(modelId);
  subscribe();

  let full = '';
  let reasoning = '';
  let finalText = '';
  const done = new Promise<{ how: string; error?: string }>((resolve) => {
    void bridge.run({
      runtime: target.runtime, cwd, prompt, question,
      ...(ahead ? { context: ahead } : {}),
      ...(route?.sessionPath ? { sessionPath: route.sessionPath } : {}),
      ...(route?.forkAfterTurn?.length ? { forkAfterTurn: route.forkAfterTurn } : {}),
      images: (images ?? []).map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })),
      // the bare harness entry names no model: the session keeps its own
      ...(target.id ? { model: { provider: target.provider, id: target.id } } : {}),
      ...(effort ? { effort } : {}),
      ...(access ? { access } : {}),
      ...(preset ? { preset } : {}),
    }).then((runId) => {
      const stop = () => { void bridge.abort(runId); };
      if (signal?.aborted) { stop(); }
      signal?.addEventListener('abort', stop, { once: true });
      handleRun(runId, (event) => {
        switch (event.type) {
          case 'session': {
            // an alias (`opus`) resolved inside the CLI: the picker learns the real name
            const resolved = (event.model as { resolved?: string } | null | undefined)?.resolved;
            if (resolved) window.dispatchEvent(new CustomEvent('td:agent-model-resolved', { detail: { id: modelId, resolved } }));
            callbacks?.onAgentSession?.({
              runtime: target.runtime,
              sessionId: (event.sessionId as string | null) ?? null,
              sessionFile: (event.sessionFile as string | null) ?? null,
              cwd: (event.cwd as string) ?? cwd,
              ...(access ? { access } : {}),
              ...(typeof event.effort === 'string' && event.effort ? { effort: event.effort } : {}),
              ...(typeof event.preset === 'string' && event.preset ? { preset: event.preset } : {}),
            });
            break;
          }
          case 'message_update': {
            const ev = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
            if (ev?.type === 'text_delta' && ev.delta) { full += ev.delta; onChunk(ev.delta, full); }
            else if (ev?.type === 'thinking_delta' && ev.delta) { reasoning += ev.delta; callbacks?.onReasoning?.(ev.delta, reasoning); }
            break;
          }
          case 'tool_execution_start': {
            const name = String(event.toolName ?? 'tool');
            // the trace, not the one-line placeholder: the node shows every call
            const query = toolQuery(name, event.args);
            callbacks?.onAgentTool?.({ id: String(event.toolCallId ?? ''), name, query, phase: 'start' });
            break;
          }
          case 'tool_execution_end':
            callbacks?.onAgentTool?.({ id: String(event.toolCallId ?? ''), name: String(event.toolName ?? 'tool'), query: '', phase: 'end', isError: !!event.isError });
            break;
          case 'extension_ui_cancelled': {
            // an extension's own question, withdrawn: the run goes on with the
            // dialog's default; the trace says so, the terminal is where to answer
            const id = `dialog-${Date.now()}`;
            const title = String(event.title ?? event.method ?? 'dialog');
            callbacks?.onAgentTool?.({ id, name: 'dialog', query: title, phase: 'start' });
            callbacks?.onAgentTool?.({ id, name: 'dialog', query: '', phase: 'end', isError: true });
            break;
          }
          case 'question_answered':
            callbacks?.onApprovalDecided?.({ id: String(event.id), outcome: (event.outcome as import('../../types').ApprovalOutcome) ?? 'cancelled', value: typeof event.value === 'string' ? event.value : null });
            break;
          case 'question':
            callbacks?.onApproval?.({
              id: String(event.id), kind: (event.kind as 'confirm' | 'select' | 'input' | 'editor') ?? 'confirm',
              toolName: target.runtime, callId: null, reason: null,
              name: String(event.title ?? ''), query: String(event.message ?? ''), arguments: null,
              options: Array.isArray(event.options) ? (event.options as string[]) : [],
              placeholder: typeof event.placeholder === 'string' ? event.placeholder : null,
              prefill: typeof event.prefill === 'string' ? event.prefill : null,
              channel: { runId },
            });
            break;
          case 'fs_changes':
            callbacks?.onAgentChanges?.({ changed: (event.changed as string[]) ?? [], added: (event.added as string[]) ?? [], removed: (event.removed as string[]) ?? [], truncated: !!event.truncated });
            break;
          case 'run_end':
            finalText = typeof event.text === 'string' && event.text ? event.text : full;
            handlers.delete(runId);
            signal?.removeEventListener('abort', stop);
            resolve({ how: String(event.how ?? 'end') });
            break;
          case 'run_error':
            handlers.delete(runId);
            signal?.removeEventListener('abort', stop);
            resolve({ how: 'error', error: String(event.message ?? 'agent run failed') });
            break;
          default:
            break;
        }
      });
    }).catch((e: unknown) => resolve({ how: 'error', error: e instanceof Error ? e.message : String(e) }));
  });
  const r = await done;
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (r.how === 'error') throw new Error(r.error ?? 'agent run failed');
  return finalText || full;
}

/**
 * After an agent run on this page: its turn read from the session file onto
 * its node — steps, provenance, the snapshot — by the session sync, which
 * finds the turn by the node's binding (ThoughtData.run). True once the node
 * carries the turn.
 */
export async function adoptAgentTurn(nodeId: string, runtime: AgentRuntime, sessionId: string): Promise<boolean> {
  if (!window.desktopSessions) return false;
  const { syncSession } = await import('../sessions/sync');
  await syncSession(runtime, sessionId).catch(() => null);
  const n = useStore.getState().nodes.find((x) => x.id === nodeId);
  return !!n && !n.data.run && n.data.importSource?.sessionId === sessionId && !!n.data.importSource.itemIds?.length;
}
