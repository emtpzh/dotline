// Which session turn a node is, and what it ran on: the one question every
// place that shows or continues an agent turn asks — the session line, the
// continuity rule, the directory a follow-up runs in, the terminal button,
// the context's relative paths. One answer, read off the node's provenance
// (importSource: the turn as its session file records it), with the record
// of the canvas's own run (agentSession) standing in until the file has it.

import type { AgentRuntime, ThoughtData, TurnConfig } from '../../types';
import { AGENT_RUNTIMES } from '../agents/runtimes';

export interface TurnRef {
  runtime: AgentRuntime;
  sessionId: string;
  /** the turn's own items in the file; empty while only the run knows the session */
  itemIds: string[];
  /** the directory the turn ran in */
  cwd: string | null;
  /** the directory the session goes on in (RuntimeCaps.resumeIn) */
  resumeCwd: string | null;
  /** what the turn ran on, as its session file records it */
  config?: TurnConfig;
  /** a run the turn delegated: never a turn a question goes on from */
  subagent?: boolean;
}

type Source = Partial<Pick<ThoughtData, 'importSource' | 'agentSession'>>;

export function turnOf(data: Source | undefined): TurnRef | null {
  if (!data) return null;
  const src = data.importSource;
  const run = data.agentSession;
  let runtime: AgentRuntime;
  let sessionId: string;
  if (src?.sessionId && src.runner in AGENT_RUNTIMES) {
    runtime = src.runner as AgentRuntime;
    sessionId = src.sessionId;
  } else if (run?.sessionId) {
    runtime = run.runtime;
    sessionId = run.sessionId;
  } else {
    return null;
  }
  const config = src?.sessionId === sessionId ? src.config : undefined;
  const ranHere = run?.runtime === runtime && run.cwd ? run.cwd : null;
  // the session's own directory (the file's header or first line), and the turn's
  const origin = ranHere || (src?.sessionId === sessionId ? src.cwd : null) || config?.cwd || null;
  const cwd = ranHere || config?.cwd || origin;
  const resumeCwd = AGENT_RUNTIMES[runtime].caps.resumeIn === 'last' ? cwd : origin;
  return {
    runtime, sessionId, cwd, resumeCwd,
    itemIds: src?.sessionId === sessionId ? src.itemIds ?? [] : [],
    ...(config ? { config } : {}),
    ...(src?.subagent ? { subagent: true } : {}),
  };
}
