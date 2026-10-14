import { FolderOpen, MessageSquare, SquareTerminal, Pin } from 'lucide-react';
import { useT } from '../../i18n';
import { useProjects, setProjectAgentCwd } from '../../store/projects';
import { toast } from '../../lib/ui-store';
import type { ThoughtData } from '../../types';
import { runtimeOf } from '../../lib/agents/runtimes';
import { continueInTerminal, terminalTarget } from '../../lib/agents/terminal';
import { turnOf } from '../../lib/sessions/turn';
import { normDir } from '../../lib/local-path';
import { useStore } from '../../store';
import { Button } from '../ui/button';

// Where an agent turn ran, kept in view: the runtime, the model and effort
// its session file records (or, until the file has the turn, the run's own),
// the access level, the working directory, whether the turn continued a session. The directory is a fact of the turn
// — before its first run, the one the node will run in — and is not edited
// here; one click makes it the canvas's default for new lines, one opens it.

const RUNTIME_LABEL: Record<string, string> = { pi: 'Pi', dsh: 'DeepSeek Harness', 'claude-code': 'Claude Code', codex: 'Codex' };

export default function AgentSessionLine({ data, nodeId }: { data: ThoughtData; nodeId?: string }) {
  const t = useT();
  // the turn went on in the session above it: the turn it follows is of the same session
  const continued = useStore((s) => {
    if (!nodeId || data.sessionLink) return false;
    const own = turnOf(data);
    if (!own) return false;
    const up = s.edges.find((e) => e.target === nodeId && !e.data?.isCrossLink && turnOf(s.nodes.find((n) => n.id === e.source)?.data)?.sessionId === own.sessionId);
    return !!up;
  });
  const activeId = useProjects((s) => s.activeId);
  const chosen = useProjects((s) => s.projects.find((p) => p.id === s.activeId)?.agentCwd);
  const turn = turnOf(data);
  const runner = turn?.runtime ?? data.importSource?.runner ?? runtimeOf(data.model);
  const cwd = turn?.cwd ?? data.importSource?.cwd ?? data.cwd ?? null;
  if (!runner || !cwd) return null;
  const config = turn?.config;
  const model = config?.model?.split('/').pop();
  const effort = data.generatedEfforts?.[data.responseIndex] ?? config?.effort;
  // the mode the turn ran under, as its session file records it; else the level the canvas gave it
  const permission = config?.permission ?? (data.access ? (data.access === 'write' ? t('access.ranWrite') : t('access.ranRead')) : undefined);
  // the pin is offered only when this directory is not already the canvas's:
  // neither the chosen one nor the canvas's own workspace by default
  const isOwnWorkspace = !chosen && !!activeId && cwd.endsWith(`/workspaces/${activeId}`);
  const canPin = !!window.desktopAgents && !!activeId && (!chosen || normDir(chosen) !== normDir(cwd)) && !isOwnWorkspace;
  const short = cwd.split('/').filter(Boolean).slice(-2).join('/');
  const target = terminalTarget(data);

  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2 flex items-center gap-2 text-xs min-w-0" data-agent-session-line>
      <span className="text-2xs font-medium text-muted-foreground bg-muted rounded-md px-1.5 py-0.5 shrink-0">{RUNTIME_LABEL[runner] ?? runner}</span>
      {model && <span className="text-2xs font-mono text-muted-foreground truncate max-w-[140px] shrink-0" title={t('agent.modelTitle')} data-agent-session-model>{model}</span>}
      {effort && <span className="text-2xs font-mono text-muted-foreground shrink-0" title={t('agent.effortTitle')} data-agent-session-effort>{effort}</span>}
      {permission && <span className="text-2xs text-muted-foreground truncate max-w-[140px] shrink-0" title={t('agent.permissionTitle')} data-agent-session-access>{permission}</span>}
      <FolderOpen size={13} strokeWidth={1.75} className="text-muted-foreground shrink-0" />
      <span className="font-mono text-muted-foreground truncate flex-1 min-w-0" title={cwd} data-agent-session-cwd={cwd}>{short}</span>
      {continued && <span className="text-2xs text-muted-foreground shrink-0" title={t('agent.continuedTitle')}>↩ {t('agent.continued')}</span>}
      {window.desktopLocal && (
        <Button variant="ghost" onClick={() => void window.desktopLocal!.open(cwd)} className="text-muted-foreground hover:text-primary shrink-0" title={t('agent.openDir')}>
          <FolderOpen strokeWidth={1.75} />
        </Button>
      )}
      {target && (
        <Button variant="ghost" onClick={() => void continueInTerminal(data)} disabled={data.isLoading} className="text-muted-foreground hover:text-primary shrink-0" title={target.inChat ? t('agent.openInChatTitle') : t('agent.continueInTerminalTitle')}>
          {target.inChat ? <MessageSquare strokeWidth={1.75} /> : <SquareTerminal strokeWidth={1.75} />}
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
