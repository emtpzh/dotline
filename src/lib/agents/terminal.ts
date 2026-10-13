// "Continue in the terminal": the one way out of the canvas for an agent
// session, wherever it is offered (the answer's action row, the session
// line). The runtime's own CLI resumes the session in its
// directory; what the person approves and runs there grows back onto the
// canvas through the session subscription, like any turn added outside.

import type { ThoughtData } from '../../types';
import { toast } from '../ui-store';
import { t } from '../../i18n';
import { turnOf } from '../sessions/turn';

/** Runtimes whose CLI the host can resume in a terminal (runtime/terminal.cjs). */
const TERMINAL_RUNNERS = new Set(['claude-code', 'codex', 'pi']);
/** Inside the harness a harness session has no terminal: the bridge stages it
 *  in the harness's own chat instead (dsh-bridge's openInCli). */
const IN_HARNESS = !!import.meta.env.VITE_DSH_BRIDGE;

type Source = Partial<Pick<ThoughtData, 'importSource' | 'run' | 'cwd'>>;

/** The session a node's turn lives in, as a terminal would resume it; null
 *  when there is none, or its runtime has no terminal to resume in. `inChat`:
 *  a harness session inside the harness, which opens back in its chat. */
export function terminalTarget(data: Source | undefined): { runner: string; cwd: string | null; sessionId: string; inChat: boolean } | null {
  if (!data || !window.desktopSessions) return null;
  const turn = turnOf(data);
  if (!turn) return null;
  const inChat = IN_HARNESS && turn.runtime === 'dsh';
  if (!inChat && !TERMINAL_RUNNERS.has(turn.runtime)) return null;
  return { runner: turn.runtime, cwd: turn.resumeCwd, sessionId: turn.sessionId, inChat };
}

/** Resume the node's session in a terminal; where no terminal opens, the
 *  command goes to the clipboard instead. */
export async function continueInTerminal(data: Source | undefined): Promise<void> {
  const target = terminalTarget(data);
  if (!target) return;
  const r = await window.desktopSessions!.openInCli(target.runner, target.cwd, target.sessionId, 'terminal')
    .catch(() => ({ opened: false, via: '' as const, command: '' }));
  if (target.inChat) return; // the harness switches to the chat in plain view
  if (r.opened) toast('success', t('atlas.opened'));
  else if (r.command) {
    await navigator.clipboard.writeText(r.command).catch(() => {});
    toast('info', t('atlas.cmdCopied'), 9000);
  }
}
