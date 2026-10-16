import type { ToolOp } from '../../types';

// Tool names → what they DID. Deterministic, runner-neutral: the same
// table classifies a Claude Code `Edit` and a Codex `apply_patch`. Its own
// module so the panel can name a live call's op without loading the
// session adapters.
const TOOL_OPS: [RegExp, ToolOp][] = [
  [/^(Read|NotebookRead|read_file|view_image)$/i, 'read'],
  [/^(Write|write_file)$/i, 'write'],
  [/^(Edit|MultiEdit|NotebookEdit|apply_patch)$/i, 'edit'],
  [/^(Bash|BashOutput|Shell|exec_command|local_shell|write_stdin)$/i, 'run'],
  [/^(Grep|Glob|LS|Search|WebSearch|web_search)$/i, 'search'],
  [/^(WebFetch|Fetch)$/i, 'fetch'],
  [/^(Task|Agent)$/i, 'agent'],
];

export function toolOpOf(name: string): ToolOp {
  return TOOL_OPS.find(([re]) => re.test(name))?.[1] ?? 'other';
}
