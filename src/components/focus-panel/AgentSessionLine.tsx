import { FolderOpen, SquareTerminal, Pin } from 'lucide-react';
import { useT } from '../../i18n';
import { useProjects, setProjectAgentCwd } from '../../store/projects';
import { toast } from '../../lib/ui-store';
import type { ThoughtData } from '../../types';
import { runtimeOf } from '../../lib/agents/runtimes';
import { continueInTerminal, terminalTarget } from '../../lib/agents/terminal';
import { Button } from '../ui/button';

// Where an agent turn ran, kept in view: the runtime, the access level, the
// working directory, whether the turn continued a session. The directory is a fact of the turn
// — before its first run, the one the node will run in — and is not edited
// here; one click makes it the canvas's default for new lines, one opens it.

const RUNTIME_LABEL: Record<string, string> = { pi: 'Pi', dsh: 'DeepSeek Harness', 'claude-code': 'Claude Code', codex: 'Codex' };

export default function AgentSessionLine({ data }: { data: ThoughtData }) {
  const t = useT();
  const activeId = useProjects((s) => s.activeId);
  const chosen = useProjects((s) => s.projects.find((p) => p.id === s.activeId)?.agentCwd);
  const runner = data.agentSession?.runtime ?? data.importSource?.runner ?? runtimeOf(data.model);
  const cwd = data.agentSession?.cwd ?? data.importSource?.cwd ?? data.cwd ?? null;
  if (!runner || !cwd) return null;
  // the pin is offered only when this directory is not already the canvas's:
  // neither the chosen one nor the canvas's own workspace by default
  const isOwnWorkspace = !chosen && !!activeId && cwd.endsWith(`/workspaces/${activeId}`);
  const canPin = !!window.desktopAgents && !!activeId && chosen !== cwd && !isOwnWorkspace;
  const short = cwd.split('/').filter(Boolean).slice(-2).join('/');

  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2 flex items-center gap-2 text-xs min-w-0" data-agent-session-line>
      <span className="text-2xs font-medium text-muted-foreground bg-muted rounded-md px-1.5 py-0.5 shrink-0">{RUNTIME_LABEL[runner] ?? runner}</span>
      {data.agentSession?.effort && <span className="text-2xs font-mono text-muted-foreground shrink-0" title={t('agent.effortTitle')} data-agent-session-effort>{data.agentSession.effort}</span>}
      {data.agentSession?.access && <span className="text-2xs text-muted-foreground shrink-0" data-agent-session-access>{data.agentSession.access === 'write' ? t('access.ranWrite') : t('access.ranRead')}</span>}
      <FolderOpen size={13} strokeWidth={1.75} className="text-muted-foreground shrink-0" />
      <span className="font-mono text-muted-foreground truncate flex-1 min-w-0" title={cwd} data-agent-session-cwd={cwd}>{short}</span>
      {data.agentSession?.continued && <span className="text-2xs text-muted-foreground shrink-0" title={t('agent.continuedTitle')}>↩ {t('agent.continued')}</span>}
      {window.desktopLocal && (
        <Button variant="ghost" onClick={() => void window.desktopLocal!.open(cwd)} className="text-muted-foreground hover:text-primary shrink-0" title={t('agent.openDir')}>
          <FolderOpen strokeWidth={1.75} />
        </Button>
      )}
      {terminalTarget(data) && (
        <Button variant="ghost" onClick={() => void continueInTerminal(data)} disabled={data.isLoading} className="text-muted-foreground hover:text-primary shrink-0" title={t('agent.continueInTerminalTitle')}>
          <SquareTerminal strokeWidth={1.75} />
        </Button>
      )}
      {canPin && (
        <Button variant="ghost"
          onClick={() => { void setProjectAgentCwd(activeId!, cwd).then(() => toast('success', t('agent.useAsCwdDone'), 4000)); }}
          className="text-muted-foreground hover:text-primary shrink-0"
          title={t('agent.useAsCwd')}
          data-agent-session-pin
        >
          <Pin strokeWidth={1.75} />
        </Button>
      )}
    </div>
  );
}
