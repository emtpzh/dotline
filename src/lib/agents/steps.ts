// An agent turn's tool calls as the canvas keeps them: steps on the node,
// apart from the person's attachments. A step's output stays out of the
// context downstream unless the person brings it in; the turn leaves one
// line saying what it did instead — the commands it ran and the files it
// touched, never their output (the session file holds the whole of it).
//
// Canvases from before kept tool calls as attachments named `tool: …`.
// liftSteps moves them over once, when a canvas loads; this file is the
// only place that still knows what those attachments looked like.

import type { AgentStep, Attachment, ThoughtNode } from '../../types';

const LEGACY_NAME = /^tool: (.+?)( \(truncated\))?$/;
const LEGACY_BODY = /^\[call\] ([\s\S]*?)\n\[result\]\n([\s\S]*)$/;

/** A tool call carried as an attachment, from before steps. */
export function isLegacyToolAttachment(a: Pick<Attachment, 'name' | 'type' | 'op'>): boolean {
  if (a.op) return true;
  return a.type === 'text/plain' && (a.name.startsWith('tool: ') || /^(🔧|⌨️)/u.test(a.name));
}

/** A step as the attachment it was before steps: the name, size and text
 *  context has always carried for it, so a lifted step compiles exactly as
 *  it did and a new one compiles the same way. */
export function stepAsAttachment(s: AgentStep): { name: string; size: number; content: string } {
  if (s.legacy) return s.legacy;
  return {
    name: `tool: ${s.tool}${s.truncated ? ' (truncated)' : ''}`,
    size: s.call.length + s.result.length,
    content: `[call] ${s.call}\n[result]\n${s.result}`,
  };
}

/** A tool-call attachment from before steps, as a step with the same id. */
export function stepFromAttachment(a: Attachment): AgentStep {
  const name = a.name.match(LEGACY_NAME);
  const body = a.content.match(LEGACY_BODY);
  const step: AgentStep = {
    id: a.id,
    tool: name ? name[1] : a.name.replace(/^(🔧|⌨️)\s*/u, ''),
    ...(a.op ? { op: a.op } : {}),
    call: body ? body[1] : '',
    result: body ? body[2] : a.content,
    ...(name?.[2] ? { truncated: true } : {}),
    ...(a.paths?.length ? { paths: a.paths } : {}),
  };
  const back = stepAsAttachment(step);
  if (back.name !== a.name || back.size !== a.size || back.content !== a.content) {
    step.legacy = { name: a.name, size: a.size, content: a.content };
  }
  return step;
}

/** One node with its tool-call attachments moved into steps. What went
 *  downstream in full (an attachment nobody excluded — an imported turn's)
 *  stays included; the rest leaves only its summary line, as before. */
export function liftNode(n: ThoughtNode): ThoughtNode {
  const atts = n.data.attachments ?? [];
  const tools = atts.filter(isLegacyToolAttachment);
  if (tools.length === 0) return n;
  const ids = new Set(tools.map((a) => a.id));
  const excluded = new Set(n.data.excludedAttachmentIds ?? []);
  const included = [...(n.data.includedStepIds ?? []), ...tools.filter((a) => !excluded.has(a.id)).map((a) => a.id)];
  return {
    ...n,
    data: {
      ...n.data,
      attachments: atts.filter((a) => !ids.has(a.id)),
      excludedAttachmentIds: (n.data.excludedAttachmentIds ?? []).filter((id) => !ids.has(id)),
      steps: [...(n.data.steps ?? []), ...tools.map(stepFromAttachment)],
      includedStepIds: included.length ? included : undefined,
    },
  };
}

/** Every node lifted; the same array when nothing needed it. */
export function liftSteps(nodes: ThoughtNode[]): ThoughtNode[] {
  let changed = false;
  const out = nodes.map((n) => {
    const m = liftNode(n);
    if (m !== n) changed = true;
    return m;
  });
  return changed ? out : nodes;
}

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;
/** A shell call — by its op, or by its name on a step that never had one. */
const isShell = (s: AgentStep): boolean => s.op === 'run' || (!s.op && /^(bash|shell|exec_command|local_shell)$/i.test(s.tool));

/** The command a shell step ran, on one line: runtimes record a call as
 *  its raw input, often JSON ({"command": …}). */
export function commandOf(s: AgentStep, max = 80): string {
  let text = s.call;
  try {
    const input = JSON.parse(s.call) as { command?: unknown; cmd?: unknown };
    const c = input.command ?? input.cmd;
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.map(String).join(' ');
  } catch { /* not JSON: the call is the command */ }
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** What a turn did, in one line, for the steps whose output stays out:
 *  the commands it ran, the files it touched by what it did to them, the
 *  pages it fetched. null when there is nothing to say. */
export function stepSummary(steps: AgentStep[], where: string | undefined): string | null {
  const parts: string[] = [];
  const ran = steps.filter(isShell).map((s) => commandOf(s)).filter(Boolean);
  if (ran.length) parts.push(`ran: ${ran.slice(0, 8).join(' ; ')}${ran.length > 8 ? ` (+${ran.length - 8})` : ''}`);
  const touched = new Map<string, Set<string>>();
  for (const s of steps) {
    if (!s.op || isShell(s) || !s.paths?.length) continue;
    const set = touched.get(s.op) ?? new Set<string>();
    for (const p of s.paths) set.add(basename(p));
    touched.set(s.op, set);
  }
  for (const [op, set] of touched) parts.push(`${op}: ${[...set].join(', ')}`);
  const fetched = [...new Set(steps.filter((s) => s.url).map((s) => s.url!))];
  if (fetched.length) parts.push(`fetch: ${fetched.slice(0, 5).join(', ')}`);
  if (parts.length === 0) return null;
  return `[What this turn did${where ? ` in ${where}` : ''} — outputs left out] ${parts.join('; ')}`;
}

/** The line a turn left before steps — only the files, by what was done
 *  to them. Kept so a canvas from before can be checked against the
 *  fingerprints its answers were recorded with (store/lift). */
export function legacyStepSummary(steps: AgentStep[], where: string | undefined): string | null {
  const pointers = new Map<string, Set<string>>();
  for (const s of steps) {
    if (!s.op || !s.paths?.length) continue;
    const set = pointers.get(s.op) ?? new Set<string>();
    for (const p of s.paths) set.add(basename(p));
    pointers.set(s.op, set);
  }
  if (pointers.size === 0) return null;
  const parts = [...pointers.entries()].map(([op, set]) => `${op}: ${[...set].join(', ')}`);
  return `[Files this turn touched${where ? ` in ${where}` : ''} — contents not included] ${parts.join('; ')}`;
}
