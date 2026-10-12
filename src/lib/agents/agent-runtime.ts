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
//      finished turn is adopted from it, never rebuilt from the stream
//   4. a model list
// Everything runtime-specific lives in desktop/agents/<runtime>.js.

import type { ContextMessage, ImageAttachment, StreamCallbacks } from '../api';
import type { ModelInfo } from '../use-models';
import type { AgentRuntime, AgentStep, ThoughtNode } from '../../types';
import { useUiStore } from '../ui-store';
import { useStore } from '../../store';
import { continuity, linkOf, type SessionLink } from './continuity';
import { upstreamFingerprint } from '../../store/context-builder';
import { countTokens } from '../../utils';

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
 *  file under the runtime's root whose name carries the id. */
async function agentSessionFile(runtime: AgentRuntime, sessionId: string, tail: { data: { agentSession?: { sessionId: string | null; sessionFile: string | null } } } | undefined): Promise<string | null> {
  const own = tail?.data.agentSession;
  if (own?.sessionId === sessionId && own.sessionFile) return own.sessionFile;
  const bridge = window.desktopSessions;
  if (!bridge) return null;
  try {
    const rootKey = AGENT_RUNTIMES[runtime].rootKey;
    const roots = await bridge.roots();
    const root = roots.find((x) => x.key === rootKey);
    if (!root) return null;
    const files = await bridge.list(rootKey);
    const hit = files.find((f) => f.rel.includes(sessionId));
    return hit ? `${root.path.replace(/\/$/, '')}/${hit.rel}` : null;
  } catch { return null; }
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
  let cwd = lineCwd(node?.data, runtime) ?? inheritCwd(parentsOf(nodeId, nodes, edges), runtime);
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
    if (!c || c.kind === 'new') return { cwd, link: linkOf(c) };
    const parent = nodes.find((n) => n.id === c.parentId);
    const sessionPath = await agentSessionFile(runtime, c.sessionId, parent);
    // the session is named but its record is gone: nothing to lean on
    if (!sessionPath) return { cwd, link: { kind: 'new', reason: 'missing' } };
    if (c.kind === 'continue') return { cwd, sessionPath, continue: true };
    return { cwd, sessionPath, forkAfterTurn: parent?.data.importSource?.itemIds ?? [], link: linkOf(c) };
  } catch {
    return { cwd };
  }
}

/**
 * The moment a continued turn names its session: the node becomes that
 * turn's mirror now — provenance stamped, ledger advanced — so the live
 * sweep, which polls the file every few seconds, does not append the
 * in-progress turn a second time. The completion stamp fills in the rest.
 */
export async function claimAgentTurn(runtime: AgentRuntime, nodeId: string, sessionId: string, cwd: string): Promise<void> {
  try {
    const { useStore } = await import('../../store');
    const { useProjects, patchLedgerEntry, subscribedSessionIds } = await import('../../store/projects');
    const { projects, activeId } = useProjects.getState();
    const meta = activeId ? projects.find((p) => p.id === activeId) : undefined;
    if (!meta || !activeId || !subscribedSessionIds(meta).includes(sessionId)) return;
    const ss = meta.sourceSession!;
    const entry = [ss, ...(ss.chapters ?? []), ...(ss.branches ?? [])].find((e) => e.sessionId === sessionId);
    if (!entry) return;
    useStore.setState((st) => ({
      nodes: st.nodes.map((n) => n.id === nodeId ? { ...n, data: { ...n.data, importSource: { runner: runtime, sessionId, itemIds: [], cwd } } } : n),
    }));
    await patchLedgerEntry(activeId, sessionId, { importedCount: entry.importedCount + 1, tailNodeId: nodeId });
  } catch { /* the completion stamp still lands */ }
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

type AgentSessionRef = { runtime: AgentRuntime; sessionFile: string | null; sessionId: string | null; cwd: string };

/** A session file as the sessions bridge names it: its root and the path under it. */
async function sessionFileLocation(runtime: AgentRuntime, sessionFile: string): Promise<{ rootKey: string; rel: string } | string> {
  const bridge = window.desktopSessions;
  if (!bridge) return 'no sessions bridge';
  const rootKey = AGENT_RUNTIMES[runtime].rootKey;
  const root = (await bridge.roots()).find((x) => x.key === rootKey);
  if (!root) return 'no root ' + rootKey;
  const base = root.path.replace(/\/$/, '') + '/';
  if (!sessionFile.startsWith(base)) return 'file outside root ' + base;
  return { rootKey, rel: sessionFile.slice(base.length) };
}

/** The turn a question became in a session file: the last one asking it
 *  (the canvas's context may ride ahead of it in the record), else the last. */
async function turnInFile(loc: { rootKey: string; rel: string }, question: string) {
  const { anyRunnerSessionConversation } = await import('../adapters');
  const text = await window.desktopSessions!.read(loc.rootKey, loc.rel);
  if (!text) return 'empty file';
  const conv = await anyRunnerSessionConversation(text);
  if (!conv?.sessionId) return 'no conversation recognized';
  const qa = conv.build().nodes.filter((n) => n.data.importSource);
  const q = question.trim();
  // a subagent the turn launched sits after it in the record: it is never the
  // turn asked, and counting it imported would keep it off the canvas
  const turns = qa.map((n, i) => ({ n, i })).filter(({ n }) => !n.data.importSource?.subagent);
  let idx = -1;
  for (let j = turns.length - 1; j >= 0; j--) {
    const qq = turns[j].n.data.question.trim();
    if (qq === q || qq.endsWith(q) || q.endsWith(qq)) { idx = turns[j].i; break; }
  }
  if (idx < 0) idx = turns.at(-1)?.i ?? -1;
  if (idx < 0) return 'no turn in file yet';
  return { sessionId: conv.sessionId, idx, turn: qa[idx] };
}

/** After an agent run: the node becomes the mirror of the turn the runtime just wrote —
 *  the turn's tool calls as its steps, provenance
 *  (runner, session, item ids, cwd), the source snapshot — and the canvas
 *  subscribes to the session so turns added later, from the terminal,
 *  append here. The live sweep never appends this turn a second time: the
 *  ledger records it as imported with this node as the tail. */
export async function adoptAgentTurn(nodeId: string, session: AgentSessionRef, question: string): Promise<boolean> {
  const why = (reason: string): false => { console.warn('[agent] turn not adopted:', reason, session.runtime, session.sessionFile); return false; };
  if (!window.desktopSessions || !session.sessionFile) return why(!window.desktopSessions ? 'no sessions bridge' : 'no session file');
  try {
    const loc = await sessionFileLocation(session.runtime, session.sessionFile);
    if (typeof loc === 'string') return why(loc);
    const { useProjects, registerLedgerEntry, updateSourceSession, subscribedSessionIds } = await import('../../store/projects');
    const found = await turnInFile(loc, question);
    if (typeof found === 'string') return why(found);
    const { idx, turn } = found;
    const conv = { sessionId: found.sessionId };
    const toolSteps = turn.data.steps ?? [];
    // what the file system saw change, beyond what the tools declared:
    // a shell redirect, a script's output — one more step
    const fsStep = fsFootprint(session, toolSteps);
    useStore.setState((st) => ({
      nodes: st.nodes.map((n) => n.id === nodeId
        ? { ...n, data: {
            ...n.data,
            // the turn's own steps, replacing an earlier run's: their
            // outputs stay out of downstream context unless brought in by hand
            steps: fsStep ? [...toolSteps, fsStep] : toolSteps,
            includedStepIds: undefined,
            importSource: turn.data.importSource,
            // the snapshot is what Pi recorded — the compiled context ahead of
            // the question — so the node reads as edited (the question as
            // asked) and the live sweep never rewrites it from the file
            source: turn.data.source ?? { question: turn.data.question, response: turn.data.response },
            agentTrace: undefined,
          } }
        : n),
    }));
    const { projects, activeId } = useProjects.getState();
    const meta = activeId ? projects.find((p) => p.id === activeId) : undefined;
    if (!meta) return true;
    const entry = { sessionId: conv.sessionId, runner: session.runtime, importedCount: idx + 1, tailNodeId: nodeId };
    if (subscribedSessionIds(meta).includes(conv.sessionId)) {
      const { patchLedgerEntry } = await import('../../store/projects');
      await patchLedgerEntry(activeId!, conv.sessionId, { importedCount: idx + 1, tailNodeId: nodeId });
    } else if (!meta.sourceSession) {
      await updateSourceSession(activeId!, entry);
      if (!useProjects.getState().projects.find((p) => p.id === activeId)?.sourceSession) {
        // updateSourceSession only patches an existing ledger: create it
        useProjects.setState((st) => ({ projects: st.projects.map((p) => (p.id === activeId ? { ...p, sourceSession: entry } : p)) }));
        await registerLedgerEntry(activeId!, 'chapter', entry).catch(() => {});
        useProjects.setState((st) => ({ projects: st.projects.map((p) => (p.id === activeId && p.sourceSession ? { ...p, sourceSession: { ...p.sourceSession, chapters: (p.sourceSession.chapters ?? []).filter((c) => c.sessionId !== entry.sessionId) } } : p)) }));
      }
    } else {
      await registerLedgerEntry(activeId!, 'chapter', entry);
    }
    // the ledger stops at this turn; what the turn launched beside itself
    // (subagent runs) is already in the file, which may not change again
    void import('../atlas/live-mirror').then((m) => m.remirrorSession(loc)).catch(() => {});
    return true;
  } catch (e) {
    return why('threw: ' + (e instanceof Error ? e.message : String(e)));
  }
}

/** A session file quiet this long holds a finished turn — for runtimes
 *  whose files carry no end-of-turn mark (a harness log does: turn/end). */
const SETTLE_MS = 60_000;

/** A harness log with a turn started and not yet ended: the agent is still
 *  at it, however long it has sat waiting on a job. */
function dshTurnOpen(log: string): boolean {
  const open = new Set<number>();
  for (const line of log.split('\n')) {
    if (!line.includes('"turn/')) continue;
    try {
      const e = JSON.parse(line) as { type?: string; data?: { turn?: unknown } };
      const n = e.data?.turn;
      if (typeof n !== 'number') continue;
      if (e.type === 'turn/start') open.add(n);
      else if (e.type === 'turn/end') open.delete(n);
    } catch { /* a torn line */ }
  }
  return open.size > 0;
}
let recheck: ReturnType<typeof setTimeout> | null = null;
let reconciling = false;

/** Record an agent turn's final answer on its node the way a finished
 *  generation does (one version, provenance, the context fingerprint). */
function settleAgentNode(nodeId: string, response: string): void {
  const { nodes, edges } = useStore.getState();
  const contextHash = upstreamFingerprint(nodeId, nodes, edges);
  const now = new Date().toISOString();
  useStore.setState((st) => ({
    nodes: st.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const s = n.data.agentSession;
      return { ...n, data: {
        ...n.data,
        response, responses: [response], questions: [n.data.question],
        generatedBy: [s?.model], generatedEfforts: [s?.effort], generatedAts: [now], editedAts: [undefined],
        gatewaySearches: [undefined], reasonings: [undefined], responseIndex: 0,
        isLoading: false, generationFailed: undefined, tokenCount: countTokens(n.data.question + response),
        // the node now says what the session says
        ...(n.data.source ? { source: { ...n.data.source, response } } : {}),
        agentSession: s ? { ...s, pending: undefined } : s,
        lastContextHash: contextHash, lastGeneratedAt: now,
      } };
    }),
  }));
}

const clearPending = (nodeId: string): void => {
  useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === nodeId && n.data.agentSession ? { ...n, data: { ...n.data, agentSession: { ...n.data.agentSession, pending: undefined } } } : n)) }));
};

/**
 * Agent turns that were still running when their canvas was last saved: the
 * page closed or reloaded mid-turn and the run went on without it. Each is
 * read back from its session file — the answer so far while the turn runs,
 * then, once it is over, the turn adopted and the answer recorded as the
 * node's version. Over means the harness logged the turn's end (or no
 * longer holds the session); for other runtimes, the file quiet for a
 * minute. Runs on arrival and whenever a session file changes; a turn
 * still running is looked at again later.
 */
export async function reconcilePendingAgentTurns(): Promise<void> {
  const bridge = window.desktopSessions;
  if (!bridge || reconciling) return;
  reconciling = true;
  let again = false;
  try {
    // a node generating in this page is its own run's business
    const pending = useStore.getState().nodes.filter((n) => n.data.agentSession?.pending && !n.data.isLoading);
    for (const n of pending) {
      const s = n.data.agentSession!;
      const loc = s.sessionFile ? await sessionFileLocation(s.runtime, s.sessionFile).catch(() => 'unreadable') : 'no session file';
      if (typeof loc === 'string') { clearPending(n.id); continue; }
      const listed = (await bridge.list(loc.rootKey).catch(() => [])).find((f) => f.rel === loc.rel);
      let settled = !listed || Date.now() - listed.mtime >= SETTLE_MS;
      if (listed && s.runtime === 'dsh') {
        // the harness says when a turn is over; a session no host holds any
        // more runs nothing, so what it holds is final
        const log = listed.live === false ? '' : await bridge.read(loc.rootKey, loc.rel).catch(() => null);
        if (log === null) { again = true; continue; }
        settled = !dshTurnOpen(log);
      }
      const found = await turnInFile(loc, n.data.question).catch(() => 'unreadable');
      const response = typeof found === 'string' ? '' : found.turn.data.response;
      if (!settled) {
        again = true;
        if (response) useStore.setState((st) => ({ nodes: st.nodes.map((x) => (x.id === n.id && !x.data.isLoading ? { ...x, data: { ...x.data, response } } : x)) }));
        continue;
      }
      if (!response) { clearPending(n.id); continue; }
      if (await adoptAgentTurn(n.id, s, n.data.question).catch(() => false)) settleAgentNode(n.id, response);
      else clearPending(n.id);
    }
  } finally {
    reconciling = false;
  }
  if (recheck) clearTimeout(recheck);
  recheck = again ? setTimeout(() => { recheck = null; void reconcilePendingAgentTurns(); }, SETTLE_MS / 2) : null;
}

/** One step naming the files the file system saw change during the turn
 *  that the tools did not already declare — absolute paths, op "write",
 *  the why layer's join key like any footprint. */
function fsFootprint(
  session: { cwd: string; changes?: { changed: string[]; added: string[]; removed: string[]; truncated?: boolean } },
  steps: AgentStep[],
): AgentStep | null {
  const ch = session.changes;
  if (!ch) return null;
  const declared = new Set<string>();
  for (const a of steps) for (const p of a.paths ?? []) declared.add(p.startsWith('/') ? p : `${session.cwd.replace(/\/$/, '')}/${p}`);
  const changed = [...ch.changed, ...ch.added].filter((p) => !declared.has(p));
  const removed = ch.removed.filter((p) => !declared.has(p));
  if (changed.length === 0 && removed.length === 0 && !ch.truncated) return null;
  const rel = (p: string) => (p.startsWith(session.cwd) ? p.slice(session.cwd.length).replace(/^\//, '') : p);
  const lines: string[] = [];
  if (changed.length) lines.push('Changed on disk during this turn (seen by the file system, not declared by a tool):', ...changed.map((p) => '- ' + rel(p)));
  if (removed.length) lines.push('Removed:', ...removed.map((p) => '- ' + rel(p)));
  if (ch.truncated) lines.push('(the directory was too large to scan completely)');
  return { id: `fs-${Date.now().toString(36)}`, tool: 'fs-changes', op: 'write', call: '', result: lines.join('\n'), paths: [...changed, ...removed] };
}
