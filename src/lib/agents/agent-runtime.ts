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
//   1. start a run on a working directory with one prompt (and, if the
//      person chose one, an effort level in the runtime's own words); abort it
//   2. an event stream carrying eight kinds, nothing else is read:
//        session · text · reasoning · tool_start · tool_end · question ·
//        end · error  (plus fs_changes, which the shell produces itself)
//   3. a session file on disk the atlas already knows how to read — the
//      finished turn is adopted from it, never rebuilt from the stream
//   4. a model list
// Everything runtime-specific lives in desktop/agents/<runtime>.js.

import type { ContextMessage, ImageAttachment, StreamCallbacks } from '../api';
import type { ModelInfo } from '../use-models';
import type { AgentRuntime, ThoughtNode } from '../../types';
import { useUiStore } from '../ui-store';
import { useStore } from '../../store';
import { pristineChain } from './pristine';
import { upstreamFingerprint } from '../../store/context-builder';
import { countTokens } from '../../utils';

/** What a runtime does beyond the contract's minimum. */
export interface RuntimeCaps {
  /** honors the boundary guard file the canvas writes into the working directory */
  guard: boolean;
  /** opens a new session holding a conversation up to one of its earlier turns */
  forkAt: boolean;
  /** runs in the canvas's own workspace when nothing else is chosen; without
      one the runtime's own default applies, and a directory binds a turn
      only when the person chose it */
  workspace: boolean;
}

/** The runtimes the shell can run, keyed by the prefix of their picker ids. */
export const AGENT_RUNTIMES: Record<AgentRuntime, { prefix: string; label: string; rootKey: string; caps: RuntimeCaps }> = {
  pi: { prefix: 'pi/', label: 'Pi', rootKey: 'pi-sessions', caps: { guard: true, forkAt: true, workspace: true } },
  codex: { prefix: 'codex/', label: 'Codex', rootKey: 'codex-sessions', caps: { guard: true, forkAt: false, workspace: true } },
  'claude-code': { prefix: 'claude/', label: 'Claude Code', rootKey: 'claude-projects', caps: { guard: true, forkAt: false, workspace: true } },
  // the harness's agent loop, served by the harness itself (nowhere else answers for it)
  dsh: { prefix: 'harness/agent/', label: 'Harness', rootKey: 'dsh-sessions', caps: { guard: false, forkAt: true, workspace: false } },
};
/** The runtimes the shell implements today. */
export const LIVE_RUNTIMES: AgentRuntime[] = ['pi', 'codex', 'claude-code', 'dsh'];
/** The harness's agent entry from before it listed one per model: the session's current model. */
const BARE_HARNESS_AGENT = 'harness/agent';


/** The provider key the picker groups every agent-run model under. */
export const AGENT_PROVIDER = '__agent__';

export const runtimeOf = (id: string | undefined | null): AgentRuntime | null => {
  if (!id) return null;
  if (id === BARE_HARNESS_AGENT) return 'dsh';
  for (const [rt, def] of Object.entries(AGENT_RUNTIMES)) if (id.startsWith(def.prefix)) return rt as AgentRuntime;
  return null;
};
export const isAgentModel = (id: string | undefined | null): boolean => runtimeOf(id) !== null;

/** `<runtime prefix><provider>/<model>` → the runtime and its own coordinates, or null. */
export function agentTarget(id: string): { runtime: AgentRuntime; provider: string; id: string } | null {
  const runtime = runtimeOf(id);
  if (!runtime) return null;
  if (id === BARE_HARNESS_AGENT) return { runtime, provider: 'dsh', id: '' };
  const rest = id.slice(AGENT_RUNTIMES[runtime].prefix.length);
  if (!rest) return null;
  const i = rest.indexOf('/');
  // a runtime with one provider (Codex) names models without a provider segment
  if (i <= 0 || i === rest.length - 1) return { runtime, provider: runtime, id: rest };
  return { runtime, provider: rest.slice(0, i), id: rest.slice(i + 1) };
}

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
    for (const m of r.models) out.push({ id: `${def.prefix}${m.provider}/${m.id}`, name: `${def.label} · ${m.name}`, provider: AGENT_PROVIDER, vision: m.vision, efforts: m.efforts ?? [], defaultEffort: m.defaultEffort ?? null });
  });
  return out;
}

export type AgentRoute = { cwd: string; sessionPath?: string; forkAfterTurn?: string[]; continue?: boolean };

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
 * The route for the node about to generate. A question asked DIRECTLY off
 * a session's tail, with nothing else wired in and nothing above it edited
 * on the canvas, continues that session: the session already holds the
 * conversation, so only the question travels. The same question off an
 * earlier turn of a session opens a new session holding the conversation
 * up to that turn, where the runtime can cut one. Anything else — other
 * wiring, an edit, a working directory the person chose elsewhere — opens a
 * fresh session carrying the compiled context.
 */
export async function agentOutbound(model: string | undefined, nodeId?: string): Promise<AgentRoute | undefined> {
  const runtime = runtimeOf(model);
  if (!window.desktopAgents || !runtime) return undefined;
  const { caps } = AGENT_RUNTIMES[runtime];
  const choice = await resolveAgentCwd(runtime);
  if (!choice) return undefined;
  const fresh: AgentRoute = { cwd: choice.cwd };
  if (!nodeId) return fresh;
  try {
    const { useProjects } = await import('../../store/projects');
    const { nodes, edges } = useStore.getState();
    const incoming = edges.filter((e) => e.target === nodeId);
    if (incoming.length !== 1) return fresh;
    if (!pristineChain(nodeId, nodes, edges)) return fresh;
    const parent = nodes.find((n) => n.id === incoming[0].source);
    if (!parent) return fresh;
    const sessionCwd = parent.data.agentSession?.cwd || parent.data.importSource?.cwd || null;
    // a directory binds the turn where the runtime works in one, or where the person chose it
    if ((caps.workspace || choice.kind === 'chosen') && sessionCwd && sessionCwd !== choice.cwd) return fresh;
    const cwd = sessionCwd ?? choice.cwd;
    const { projects, activeId } = useProjects.getState();
    const ss = projects.find((p) => p.id === activeId)?.sourceSession;
    const entries = ss ? [ss, ...(ss.chapters ?? []), ...(ss.branches ?? [])].filter((e) => e.runner === runtime && e.sessionId) : [];
    const entry = entries.find((e) => e.tailNodeId === parent.id);
    if (entry) {
      const sessionPath = await agentSessionFile(runtime, entry.sessionId, parent);
      return sessionPath ? { cwd, sessionPath, continue: true } : fresh;
    }
    const src = parent.data.importSource;
    if (caps.forkAt && src?.runner === runtime && src.sessionId && src.itemIds?.length) {
      const sessionPath = await agentSessionFile(runtime, src.sessionId, parent);
      if (sessionPath) return { cwd, sessionPath, forkAfterTurn: src.itemIds };
    }
    return fresh;
  } catch {
    return fresh;
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
        if (att.op || /^(tool|🔧|⌨️)/.test(att.name)) continue; // tool footprints are not materials
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
    ? '[ThoughtDAG canvas context] The question that follows was asked from a ThoughtDAG canvas. Treat the material below as the conversation so far; answer the question at the end.\n\n' + parts.join('\n\n---\n\n')
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
  if (caps.guard) await writeGuard(cwd);
  // a continued or forked session already holds the conversation: only the
  // question travels (the context rides along for a runtime that has to
  // fall back to a fresh session)
  const inherits = !!route?.sessionPath && (!!route.continue || !!route.forkAfterTurn?.length);
  const materials = inherits || !cwd ? '' : await materialsToDisk(nodeId, cwd);
  const ahead = [context, materials].filter(Boolean).join('\n\n');
  const prompt = !inherits && ahead ? `${ahead}\n\n---\n\n${question}` : question;
  const effort = useUiStore.getState().agentEffort || undefined;
  // what this conversation already allowed for good: every 'allowed-session'
  // decision on this canvas whose rule belongs to this runtime
  const allowRules = [...new Set(useStore.getState().nodes.flatMap((n) => (n.data.approvals ?? []).filter((a) => a.outcome === 'allowed-session' && typeof a.rule === 'string' && a.rule.startsWith(target.runtime === 'claude-code' ? 'claude:' : target.runtime + ':')).map((a) => a.rule as string)))];
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
      ...(allowRules.length ? { allowRules } : {}),
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
              ...(typeof event.effort === 'string' && event.effort ? { effort: event.effort } : {}),
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
            callbacks?.onApprovalDecided?.({ ...(event.auto ? { auto: true, name: String(event.title ?? ''), query: String(event.message ?? ''), rule: typeof event.rule === 'string' ? event.rule : null } : {}), id: String(event.id), outcome: (event.outcome as import('../../types').ApprovalOutcome) ?? 'cancelled', value: typeof event.value === 'string' ? event.value : null });
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
              paths: Array.isArray(event.paths) ? (event.paths as string[]) : [],
              suggest: typeof event.suggest === 'string' ? event.suggest : null,
              rule: typeof event.rule === 'string' ? event.rule : null,
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
  let idx = -1;
  for (let i = qa.length - 1; i >= 0; i--) {
    const qq = qa[i].data.question.trim();
    if (qq === q || qq.endsWith(q) || q.endsWith(qq)) { idx = i; break; }
  }
  if (idx < 0) idx = qa.length - 1;
  if (idx < 0) return 'no turn in file yet';
  return { sessionId: conv.sessionId, idx, turn: qa[idx] };
}

/** After an agent run: the node becomes the mirror of the turn the runtime just wrote —
 *  the turn's tool calls as attachments (footprints), provenance
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
    const toolAtts = turn.data.attachments ?? [];
    // what the file system saw change, beyond what the tools declared:
    // a shell redirect, a script's output — one footprint attachment
    const fsAtt = fsFootprint(session, toolAtts);
    const agentAtts = fsAtt ? [...toolAtts, fsAtt] : toolAtts;
    useStore.setState((st) => ({
      nodes: st.nodes.map((n) => n.id === nodeId
        ? { ...n, data: {
            ...n.data,
            attachments: [...(n.data.attachments ?? []).filter((a) => !a.op), ...agentAtts],
            // footprints are pointers, not contents: an agent turn's tool
            // outputs stay out of downstream context unless brought back by hand
            excludedAttachmentIds: [...new Set([...(n.data.excludedAttachmentIds ?? []), ...agentAtts.map((a) => a.id)])],
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
    return true;
  } catch (e) {
    return why('threw: ' + (e instanceof Error ? e.message : String(e)));
  }
}

/** A session file quiet this long holds a finished turn. */
const SETTLE_MS = 60_000;
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
 * read back from its session file — the answer so far while the file still
 * moves, then, once it has been quiet for a minute, the turn adopted and the
 * answer recorded as the node's version. Runs on arrival and whenever a
 * session file changes; a turn still moving is looked at again later.
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
      const quiet = !listed || Date.now() - listed.mtime >= SETTLE_MS;
      const found = await turnInFile(loc, n.data.question).catch(() => 'unreadable');
      const response = typeof found === 'string' ? '' : found.turn.data.response;
      if (!quiet) {
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

/** The active canvas's guard tuning, as the guard file expects it. */
export async function guardConfig(): Promise<{ mode: 'ask' | 'allow'; allow: string[] }> {
  try {
    const { useProjects } = await import('../../store/projects');
    const { projects, activeId } = useProjects.getState();
    const g = projects.find((p) => p.id === activeId)?.agentGuard;
    return { mode: g?.mode === 'allow' ? 'allow' : 'ask', allow: g?.allow ?? [] };
  } catch { return { mode: 'ask', allow: [] }; }
}

/** Write the guard file for a working directory (the run's, or the
 *  canvas's current one when omitted). */
export async function writeGuard(cwd?: string): Promise<void> {
  if (!window.desktopAgents) return;
  const dir = cwd ?? (await resolveAgentCwd())?.cwd;
  if (!dir) return;
  try { await window.desktopAgents.guardWrite(dir, await guardConfig()); } catch { /* the guard falls back to asking */ }
}

/** Switch the active canvas's guard mode, effective for the run in progress. */
export async function setGuardMode(mode: 'ask' | 'allow'): Promise<void> {
  const { useProjects, setProjectAgentGuard } = await import('../../store/projects');
  const { projects, activeId } = useProjects.getState();
  if (!activeId) return;
  const g = projects.find((p) => p.id === activeId)?.agentGuard;
  await setProjectAgentGuard(activeId, { mode, allow: g?.allow ?? [] });
  await writeGuard();
}

/** Let a directory through from now on for the active canvas (and the
 *  run in progress); `remove` takes it back. */
export async function allowLocation(dir: string, remove = false): Promise<void> {
  const { useProjects, setProjectAgentGuard } = await import('../../store/projects');
  const { projects, activeId } = useProjects.getState();
  if (!activeId) return;
  const g = projects.find((p) => p.id === activeId)?.agentGuard;
  const allow = remove ? (g?.allow ?? []).filter((a) => a !== dir) : [...new Set([...(g?.allow ?? []), dir])];
  await setProjectAgentGuard(activeId, { mode: g?.mode ?? 'ask', allow });
  await writeGuard();
}

/** One attachment naming the files the file system saw change during the
 *  turn that the tools did not already declare — absolute paths, op
 *  "write", the why layer's join key like any footprint. */
function fsFootprint(
  session: { cwd: string; changes?: { changed: string[]; added: string[]; removed: string[]; truncated?: boolean } },
  toolAtts: import('../../types').Attachment[],
): import('../../types').Attachment | null {
  const ch = session.changes;
  if (!ch) return null;
  const declared = new Set<string>();
  for (const a of toolAtts) for (const p of a.paths ?? []) declared.add(p.startsWith('/') ? p : `${session.cwd.replace(/\/$/, '')}/${p}`);
  const changed = [...ch.changed, ...ch.added].filter((p) => !declared.has(p));
  const removed = ch.removed.filter((p) => !declared.has(p));
  if (changed.length === 0 && removed.length === 0 && !ch.truncated) return null;
  const rel = (p: string) => (p.startsWith(session.cwd) ? p.slice(session.cwd.length).replace(/^\//, '') : p);
  const lines: string[] = [];
  if (changed.length) lines.push('Changed on disk during this turn (seen by the file system, not declared by a tool):', ...changed.map((p) => '- ' + rel(p)));
  if (removed.length) lines.push('Removed:', ...removed.map((p) => '- ' + rel(p)));
  if (ch.truncated) lines.push('(the directory was too large to scan completely)');
  return {
    id: `fs-${Date.now().toString(36)}`, name: 'tool: fs-changes', type: 'text/plain', size: 0,
    content: lines.join('\n'), op: 'write', paths: [...changed, ...removed],
  } as import('../../types').Attachment;
}
