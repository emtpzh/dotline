// "Continue in the terminal": the one way out of the canvas for an agent
// session, wherever it is offered (the answer's action row, the session
// line). The runtime's own CLI resumes the session in its
// directory; what the person approves and runs there grows back onto the
// canvas through the session subscription, like any turn added outside.

import type { ThoughtData } from '../../types';
import { toast } from '../ui-store';
import { t } from '../../i18n';

/** Runtimes whose CLI the host can resume in a terminal (runtime/terminal.cjs). */
const TERMINAL_RUNNERS = new Set(['claude-code', 'codex', 'pi']);

type Source = Pick<ThoughtData, 'agentSession' | 'importSource'>;

/** The session a node's turn lives in, as a terminal would resume it; null
 *  when there is none, or its runtime has no terminal to resume in. */
export function terminalTarget(data: Source | undefined): { runner: string; cwd: string | null; sessionId: string } | null {
  if (!data || !window.desktopSessions) return null;
  const runner = data.agentSession?.runtime ?? data.importSource?.runner;
  const sessionId = data.agentSession?.sessionId ?? data.importSource?.sessionId;
  if (!runner || !sessionId || !TERMINAL_RUNNERS.has(runner)) return null;
  return { runner, cwd: data.agentSession?.cwd ?? data.importSource?.cwd ?? null, sessionId };
}

/** Resume the node's session in a terminal; where no terminal opens, the
 *  command goes to the clipboard instead. */
export async function continueInTerminal(data: Source | undefined): Promise<void> {
  const target = terminalTarget(data);
  if (!target) return;
  const r = await window.desktopSessions!.openInCli(target.runner, target.cwd, target.sessionId, 'terminal')
    .catch(() => ({ opened: false, via: '' as const, command: '' }));
  if (r.opened) toast('success', t('atlas.opened'));
  else if (r.command) {
    await navigator.clipboard.writeText(r.command).catch(() => {});
    toast('info', t('atlas.cmdCopied'), 9000);
  }
}
