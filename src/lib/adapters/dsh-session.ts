import type { ThoughtNode, ThoughtEdge, TurnConfig } from '../../types';
import { makeNode, type ImportableConversation } from '../import-chat';
import { autoLayout } from '../layout';
import { generateId } from '../../utils';
import {
  turnsToBranch, seedPlaque, toolSteps, dropSelfCommandTurns, toolOpOf, clipText,
  toolPaths, toolScope, renderCall as renderArgCall, attachSubagentBranches, adoptSubagentSessions,
  ARTIFACT_CALL_LIMIT, TOOL_CALL_LIMIT, TOOL_RESULT_LIMIT, type RunnerTool, type SubagentRun, type SubagentSession,
} from './shared';
import { turnSource, noteConfig, cloneTurns } from './shared';

// DeepSeek Harness session importer — the continuity layer's READ
// direction for the DSH runner. A session lives as a zstd-compressed
// JSONL under ~/.dsh/sessions/<encoded-cwd>/<session-id>/session.jsonl.zstd
// (the desktop shell decompresses before this reader sees a line). Each
// line is ONE event; every event carries a monotonic seq, and turn/step
// boundaries ride explicit events (turn/start, step/start, step/end).
// The file is append-only: durable facts, never rewritten.
//
// Projection rules (v0, deliberately honest about what it drops):
//   - A TURN = one REAL user message plus everything the model did until
//     the next real user message → one Q/A node. "Real" is decided by the
//     event's source.kind: DSH INJECTS user-role messages for runtime
//     context snapshots (source.kind "plugin") and skill catalogs
//     ("skill-catalog") ahead of every turn. Those are runner template,
//     not conversation — same judgment as Codex developer messages — and
//     are dropped; only source.kind "user" opens a turn.
//   - The response = the assistant message's TEXT parts per step, folded
//     in order (a step that only reasons or calls tools adds no text).
//     reasoning parts are dropped: they never re-enter a next turn's
//     context in DSH either (same rule as the Claude Code adapter).
//   - Tool calls pair with their results by callId into atomic text
//     attachments on the turn's node (tool/call arguments + tool/result
//     text); a call that names a file (read / write / edit) records that
//     path as its footprint.
//   - Most file work in DSH happens INSIDE run_code: the code calls
//     tools.read / tools.edit / tools.write, and each such sub-call is
//     logged as tool/code-dispatch with its own name, arguments and result.
//     A dispatch that names a file becomes a tool of its own (keyed by the
//     sub-call id) — that is the turn's real footprint, and the reason
//     `why <file>` finds DSH turns at all. Shell, search and bookkeeping
//     dispatches stay folded inside the root run_code attachment (its code
//     already shows them). Unknown event types are noise to this projector.
//   - A subagent call ({description, prompt}) delegates to a child session
//     that lives beside the parent on disk (its header: origin "subagent",
//     parentSession). The parent names the child: a foreground call's
//     result is the child's answer; a background one returns "started
//     subagent <id>", a subagent/catalog event pairs the id with the call's
//     description, and the child's report arrives later as agent-message and
//     subagent-settled notices keyed by senderSessionId. Each run becomes a
//     branch off the turn that launched it (adapters/shared.ts).
//   - The source session file is never written — read-only by contract.

interface DshPart { type?: string; text?: string }

interface DshUserMessage {
  type: 'user/message';
  seq: number;
  time?: number;
  data: {
    content?: DshPart[];
    source?: { kind?: string };
    id?: string;
  };
}

interface DshAssistantMessage {
  type: 'assistant/message';
  seq: number;
  time?: number;
  data: {
    turn: number;
    step: number;
    message: { content?: DshPart[]; id?: string };
  };
}

interface DshToolCall {
  type: 'tool/call';
  seq: number;
  time?: number;
  data: {
    turn: number;
    step: number;
    callId: string;
    name: string;
    arguments: string;
  };
}

interface DshToolResult {
  type: 'tool/result';
  seq: number;
  time?: number;
  data: {
    turn: number;
    step: number;
    message: { source?: { callId?: string }; content?: unknown };
  };
}

interface DshCodeDispatch {
  type: 'tool/code-dispatch';
  data: {
    rootCallId?: string; parentCallId?: string; subCallId?: string;
    name?: string; arguments?: unknown; isError?: boolean; content?: unknown;
  };
}

interface DshSessionLine {
  type?: string;
  id?: string;
  cwd?: string;
  seq?: number;
  time?: number;
  data?: {
    title?: string;
    source?: { kind?: string };
    content?: unknown;
    message?: { content?: unknown; source?: unknown; id?: string };
    callId?: string;
    name?: string;
    arguments?: string;
    turn?: number;
    step?: number;
  };
}

/** Text under a DSH message: content is an array of parts, text parts may
 *  nest one level deep inside tool-result blocks. Images become an honest
 *  marker, never base64 noise on a canvas card. */
function partsText(content: unknown, depth = 0): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || depth > 2) return '';
  return content.map((p) => {
    if (!p || typeof p !== 'object') return '';
    const o = p as DshPart;
    if (o.type === 'text' && typeof o.text === 'string') return o.text;
    if (o.type === 'image') return '[image omitted]';
    // reasoning never re-enters the model's own next context in DSH; it is
    // not the answer — drop it here, before the nested fallback below could
    // re-admit its `text` field as if it were a text part.
    if (o.type === 'reasoning') return '';
    return partsText(o.text ?? (o as { content?: unknown }).content, depth + 1);
  }).filter(Boolean).join('\n');
}

/** run_code carries the code it ran as a JSON string of {code,
 *  description} — render the CODE (that is what ran). A file tool renders
 *  the way every runner's does (a Write shows its file, an Edit its diff);
 *  anything else keeps its raw JSON arguments. */
function renderRootCall(name: string, argumentsJson: string, args: unknown): { text: string; truncated: boolean } {
  const op = toolOpOf(name);
  if (op === 'run' || /^run_code$/i.test(name)) {
    const a = (args ?? {}) as { code?: string };
    return clipText(typeof a.code === 'string' ? a.code : argumentsJson, ARTIFACT_CALL_LIMIT);
  }
  const body = args && typeof args === 'object' ? renderArgCall(name, args) : argumentsJson;
  return clipText(body, op === 'write' || op === 'edit' ? ARTIFACT_CALL_LIMIT : TOOL_CALL_LIMIT);
}

const parseArgs = (json: string | undefined): unknown => { try { return JSON.parse(json ?? ''); } catch { return undefined; } };

interface DshTurn {
  question: string;
  response: string;
  itemIds: string[];
  tools: RunnerTool[];
  at?: string;
  subagents?: SubagentRun[];
  config?: TurnConfig;
  complete?: boolean;
}

/** The subagent tool's arguments (dsh-tool-subagent): a short label and the child's standalone prompt. */
function spawnOf(args: unknown): { task: string; prompt: string } | undefined {
  const a = (args && typeof args === 'object' ? args : {}) as { description?: unknown; prompt?: unknown };
  return typeof a.prompt === 'string' && typeof a.description === 'string' ? { task: a.description, prompt: a.prompt } : undefined;
}

/** Streaming turn collector — one line in at a time (a DSH session can
 *  run tens of thousands of events; no path may hold it whole). */
export class DshSessionCollector {
  private turns: DshTurn[] = [];
  private pendingTools = new Map<string, { name: string; call: string; truncated: boolean; op: RunnerTool['op']; paths: string[]; url?: string; locator?: RunnerTool['locator']; spawn?: { task: string; prompt: string } }>();
  private current: DshTurn | null = null;
  private sessionId: string | null = null;
  private cwd: string | null = null;
  private title: string | null = null;
  private firstQuestion: string | null = null;
  private startedAt: string | null = null;
  private delegated = false;
  // background children: who each catalog entry is, and what each child sent back
  private catalog: { childId: string; label: string }[] = [];
  private reports = new Map<string, { relayed: string[]; closing?: string }>();
  // what the session is set to: its model selection, permission preset and sandbox
  private selection: { provider?: string; model?: string; effort?: string } = {};
  private preset: string | null = null;
  private sandbox: string | null = null;

  private permission(): string | undefined {
    const parts = [this.preset, this.sandbox && this.sandbox !== this.preset ? this.sandbox : null].filter(Boolean);
    return parts.length ? parts.join(' · ') : undefined;
  }

  feedLine(raw: string): void {
    const t = raw.trim();
    if (!t) return;
    let line: DshSessionLine;
    try { line = JSON.parse(t) as DshSessionLine; } catch { return; }
    this.feed(line);
  }

  private flush(): void {
    const c = this.current;
    if (c && (c.question || c.response || c.tools.length)) this.turns.push({ ...c, complete: true });
    this.current = null;
  }

  private ensure(): DshTurn {
    if (!this.current) this.current = { question: '', response: '', itemIds: [], tools: [] };
    return this.current;
  }

  private feed(line: DshSessionLine): void {
    // a Pi header is also `type: "session"`; DSH's carries createdAt (a number),
    // Pi's a string timestamp and format version ≥ 3 — not ours
    if (line.type === 'session' && line.id && !('timestamp' in line)) {
      if (!this.sessionId) this.sessionId = line.id;
      if (line.cwd && !this.cwd) this.cwd = line.cwd;
      const h = line as { origin?: string; createdAt?: number };
      if (h.origin === 'subagent') this.delegated = true;
      if (typeof h.createdAt === 'number' && !this.startedAt) this.startedAt = new Date(h.createdAt).toISOString();
      return;
    }
    // what the turn runs on: the session's selection, then each request's own
    const d = (line.data ?? {}) as { provider?: unknown; model?: unknown; reasoningEffort?: unknown; preset?: unknown; mode?: unknown; header?: { config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } };
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    if (line.type === 'model/selection') {
      this.selection = { provider: str(d.provider), model: str(d.model), effort: str(d.reasoningEffort) };
      return;
    }
    if (line.type === 'permission/preset') { this.preset = str(d.preset) ?? this.preset; return; }
    if (line.type === 'sandbox/mode') { this.sandbox = str(d.mode) ?? this.sandbox; return; }
    if (line.type === 'request/header' || line.type === 'request/context') {
      const c = line.type === 'request/header' ? d.header?.config ?? {} : d;
      if (this.current) noteConfig(this.current, { provider: str(c.provider), model: str(c.model), effort: str(c.reasoningEffort) });
      return;
    }
    if (line.type === 'turn/end') {
      if (this.current) this.current.complete = true;
      return;
    }
    if (line.type === 'subagent/catalog') {
      const d = line.data as { childId?: unknown; label?: unknown } | undefined;
      if (typeof d?.childId === 'string') this.catalog.push({ childId: d.childId, label: typeof d.label === 'string' ? d.label : '' });
      return;
    }
    if (line.type === 'session/title' && line.data?.title && !this.title) {
      this.title = line.data.title;
      return;
    }
    // The ONLY turn opener: a user-role message a human actually sent.
    // DSH prefixes each turn with plugin/skill-catalog injections that
    // also ride user/message events — those never open or append a turn.
    if (line.type === 'user/message') {
      const um = line as unknown as DshUserMessage;
      const kind = um.data?.source?.kind;
      // a background child's report: relayed messages, then the settled notice with its closing message
      if (kind === 'agent-message' || kind === 'subagent-settled') {
        const from = (um.data?.source as { senderSessionId?: unknown } | undefined)?.senderSessionId;
        if (typeof from !== 'string') return;
        const parts = (um.data?.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text ?? '');
        const r = this.reports.get(from) ?? { relayed: [] };
        if (kind === 'agent-message') {
          const text = parts.slice(1).join('\n').trim();
          if (text) r.relayed.push(text);
        } else {
          const at = parts.findIndex((t) => t.trim() === 'Its closing message:');
          const text = (at >= 0 ? parts.slice(at + 1) : parts.slice(1)).join('\n').trim();
          if (text) r.closing = text;
        }
        this.reports.set(from, r);
        return;
      }
      if (kind && kind !== 'user') return;
      const text = partsText(um.data?.content).trim();
      if (!text) return;
      if (!this.firstQuestion) this.firstQuestion = text.split('\n')[0].slice(0, 80);
      this.flush();
      const t = this.ensure();
      t.question = text;
      t.itemIds = [um.data?.id ?? `u${um.seq}`];
      if (um.time) t.at = new Date(um.time).toISOString();
      t.complete = false;
      noteConfig(t, { ...this.selection, permission: this.permission(), cwd: this.cwd ?? undefined }, 'inferred');
      return;
    }
    if (line.type === 'assistant/message' && this.current) {
      const am = line as unknown as DshAssistantMessage;
      const parts = am.data?.message?.content;
      const text = partsText(parts).trim();
      const id = am.data?.message?.id;
      if (id) this.current.itemIds.push(id);
      // text parts only; reasoning parts carry no 'text' under our reader
      if (text) this.current.response = this.current.response ? `${this.current.response}\n\n${text}` : text;
      return;
    }
    if (line.type === 'tool/call') {
      const tc = line as unknown as DshToolCall;
      if (!tc.data?.callId || !tc.data?.name) return;
      const op = /^run_code$/i.test(tc.data.name) ? 'run' : toolOpOf(tc.data.name);
      const args = parseArgs(tc.data.arguments);
      const call = renderRootCall(tc.data.name, tc.data.arguments ?? '', args);
      const scope = op === 'run' ? {} : toolScope(args);
      const spawn = spawnOf(args);
      this.pendingTools.set(tc.data.callId, { name: tc.data.name, call: call.text, truncated: call.truncated, op, paths: op === 'run' ? [] : toolPaths(args), ...scope, ...(spawn ? { spawn } : {}) });
      return;
    }
    if (line.type === 'tool/result') {
      const tr = line as unknown as DshToolResult;
      const callId = tr.data?.message?.source?.callId;
      if (!callId) return;
      const reg = this.pendingTools.get(callId);
      if (!reg) return;
      const full = partsText(tr.data?.message?.content);
      const res = clipText(full, TOOL_RESULT_LIMIT);
      const t = this.ensure();
      if (reg.spawn) {
        // foreground: the result IS the child's answer; background: an id now, the report later
        const started = /^started subagent (\S+)/.exec(full.trim());
        const background = !!started || /^started background subagent job\b/.test(full.trim());
        (t.subagents ??= []).push({
          agent: reg.name, task: reg.spawn.task, output: background ? '' : full.trim(),
          itemIds: [callId], match: reg.spawn.prompt,
          ...(started ? { child: started[1] } : {}), ...(tr.time ? { at: new Date(tr.time).toISOString() } : {}),
        });
      }
      t.tools.push({
        name: reg.name, call: reg.call, result: res.text, truncated: reg.truncated || res.truncated,
        op: reg.op, nativeCallId: callId,
        ...(reg.paths.length ? { paths: reg.paths } : {}), ...(reg.url ? { url: reg.url } : {}), ...(reg.locator ? { locator: reg.locator } : {}),
        textAt: t.response.length,
      });
      this.pendingTools.delete(callId);
      return;
    }
    // A file operation dispatched from inside run_code (see the header): its
    // own tool, its own footprint. Dispatches that name no file fold into
    // the root call.
    if (line.type === 'tool/code-dispatch') {
      const d = (line as unknown as DshCodeDispatch).data;
      if (!d?.name || !d.subCallId) return;
      const paths = toolPaths(d.arguments);
      const scope = toolScope(d.arguments);
      if (!paths.length && !scope.url) return;
      const op = toolOpOf(d.name);
      const call = clipText(renderArgCall(d.name, d.arguments), op === 'write' || op === 'edit' ? ARTIFACT_CALL_LIMIT : TOOL_CALL_LIMIT);
      const res = clipText(partsText(d.content), TOOL_RESULT_LIMIT);
      const cur = this.ensure();
      cur.tools.push({
        textAt: cur.response.length,
        name: d.name, call: call.text, result: res.text, truncated: call.truncated || res.truncated,
        op, nativeCallId: d.subCallId, ...(paths.length ? { paths } : {}), ...(scope.url ? { url: scope.url } : {}), ...(scope.locator ? { locator: scope.locator } : {}),
      });
      return;
    }
    // turn/step boundaries, request/*, permission/preset, sandbox/mode,
    // approval/policy, agent-preset/selected, agent/inbox/spliced,
    // llm/retry, *-chunks… — scheduling or transport, not conversation.
  }

  /** Background runs: a run the result did not name takes the catalog entry its description
   *  labels, and a run still without an answer takes what its child sent back. */
  private settleRuns(turns: DshTurn[]): void {
    const runs = turns.flatMap((t) => t.subagents ?? []);
    const claimed = new Set(runs.map((r) => r.child).filter(Boolean));
    for (const run of runs) {
      if (run.child) continue;
      const entry = this.catalog.find((c) => !claimed.has(c.childId) && c.label === run.task);
      if (entry) { run.child = entry.childId; claimed.add(entry.childId); }
    }
    for (const run of runs) {
      const r = run.child ? this.reports.get(run.child) : undefined;
      if (!r || run.output.trim()) continue;
      const texts = [...r.relayed];
      if (r.closing && r.closing !== texts.at(-1)) texts.push(r.closing);
      run.output = texts.join('\n\n');
    }
  }

  /** The session as read so far; reading may go on afterwards (runs are
   *  settled on the snapshot's copy). */
  finish(): { sessionId: string; title: string; turns: DshTurn[]; cwd?: string } | null {
    if (!this.sessionId) return null;
    const c = this.current;
    const turns = cloneTurns(c && (c.question || c.response || c.tools.length) ? [...this.turns, c] : this.turns);
    this.settleRuns(turns);
    const asked = this.firstQuestion ?? null;
    const title = this.title ?? asked ?? `session ${this.sessionId.replace(/^session-/, '').slice(0, 8)}`;
    return { sessionId: this.sessionId, title, turns: dropSelfCommandTurns(turns), ...(this.cwd ? { cwd: this.cwd } : {}) };
  }

  toConversation(): ImportableConversation | null {
    const s = this.finish();
    if (!s || s.turns.length === 0) return null;
    return {
      title: s.title,
      messageCount: s.turns.length,
      source: 'dsh',
      sessionId: s.sessionId,
      session: { turns: s.turns, ...(s.cwd ? { cwd: s.cwd } : {}), ...(this.delegated ? { subagent: true } : {}) },
      build: () => buildGraphFromTurns(s.turns, s.sessionId, s.cwd),
      adopt: (subs) => adoptSubagentSessions(s.turns, subs),
      children: () => s.turns.flatMap((t) => (t.subagents ?? []).map((r) => r.child).filter((c): c is string => !!c)),
    };
  }

  /** This log as a delegated child's transcript (its header says origin "subagent"), for the parent to adopt. */
  toSubagentSession(): SubagentSession | null {
    const s = this.finish();
    if (!s || s.turns.length === 0 || !this.delegated) return null;
    const first = s.turns[0];
    const at = first.at ?? this.startedAt ?? undefined;
    return { runner: 'dsh', sessionId: s.sessionId, firstQuestion: first.question, turns: s.turns, ...(s.cwd ? { cwd: s.cwd } : {}), ...(at ? { at } : {}) };
  }
}

function collectFromText(text: string): DshSessionCollector {
  const c = new DshSessionCollector();
  for (const raw of text.split('\n')) c.feedLine(raw);
  return c;
}

export function buildGraphFromTurns(turns: DshTurn[], sessionId: string, cwd?: string): { nodes: ThoughtNode[]; edges: ThoughtEdge[] } {
  // faithful projection: EVERY turn imports — no tail cap (see the Claude
  // Code adapter for the rationale; the rule is runner-agnostic).
  const nodes: ThoughtNode[] = [];
  const edges: ThoughtEdge[] = [];
  let prev: ThoughtNode | null = null;

  for (const turn of turns) {
    const node = makeNode(turn.question || '(tool-only turn)', turn.response, prev === null);
    node.data.importSource = turnSource(turn, 'dsh', sessionId, cwd);
    node.data.source = { question: node.data.question, response: node.data.response };
    node.data.steps = toolSteps(turn);
    seedPlaque(node);
    nodes.push(node);
    if (prev) edges.push({ id: generateId(), source: prev.id, target: node.id, type: 'smoothstep' } as ThoughtEdge);
    attachSubagentBranches(node, turn, nodes, edges, 'dsh', sessionId, cwd);
    prev = node;
  }

  return { nodes: autoLayout(nodes, edges), edges };
}

/** Harvest: a short DSH experiment session hangs off the node it was
 *  compiled from — same runner-agnostic branch builder as the others. */
export function dshSessionAsBranch(
  text: string,
  anchorNode: { id: string; x: number; y: number },
): { nodes: ThoughtNode[]; edges: ThoughtEdge[]; turnCount: number } | null {
  const s = collectFromText(text).finish();
  if (!s) return null;
  return turnsToBranch(s.turns, s.sessionId, 'dsh', anchorNode, s.cwd);
}

/** The importable-conversation wrapper the import modal / canonical
 *  router consumes. */
export function dshSessionConversation(text: string): ImportableConversation | null {
  return collectFromText(text).toConversation();
}
