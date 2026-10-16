import { ChevronDown } from 'lucide-react';
import { useT } from '../../i18n';
import { useProjects, setProjectAgentCwd } from '../../store/projects';
import { toast } from '../../lib/ui-store';
import type { ThoughtData } from '../../types';
import { runtimeOf, AGENT_RUNTIMES } from '../../lib/agents/runtimes';
import { continueInTerminal, terminalTarget } from '../../lib/agents/terminal';
import { describeModel } from '../../lib/use-models';
import { turnOf } from '../../lib/sessions/turn';
import { normDir, openLocalPath } from '../../lib/local-path';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

// How this turn ran, as one faint tag in the title row: the runtime and the
// folder for an agent turn, the model for a chat one. Open, it says the
// rest — model and effort, the access it ran at, the whole directory — and
// offers what acts on that place: continue the session where it lives, open
// the folder, make it the canvas's directory for new lines.

const ROWS = 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs';

export default function RunTag({ data }: { data: ThoughtData }) {
  const t = useT();
  const activeId = useProjects((s) => s.activeId);
  const chosen = useProjects((s) => s.projects.find((p) => p.id === s.activeId)?.agentCwd);
  const turn = turnOf(data);
  const runner = turn?.runtime ?? data.importSource?.runner ?? runtimeOf(data.model);
  const cwd = turn?.cwd ?? data.importSource?.cwd ?? data.cwd ?? null;
  const i = data.responseIndex;
  const generated = data.generatedBy?.[i];
  const agent = !!runner && !!cwd;
  if (!agent && !generated) return null;

  const config = turn?.config;
  const model = agent ? config?.model?.split('/').pop() ?? generated?.split('/').pop() : generated;
  const effort = data.generatedEfforts?.[i] ?? config?.effort;
  const permission = config?.permission ?? (data.access ? (data.access === 'write' ? t('access.ranWrite') : t('access.ranRead')) : undefined);
  const runtimeLabel = runner ? (AGENT_RUNTIMES[runner as keyof typeof AGENT_RUNTIMES]?.label ?? runner) : '';
  const folder = cwd?.split('/').filter(Boolean).pop() ?? '';
  const label = agent ? `${runtimeLabel} · ${folder}` : describeModel(generated).split(' · ').pop() ?? '';
  // the pin is offered only when this directory is not already the canvas's
  const isOwnWorkspace = !chosen && !!activeId && !!cwd && cwd.endsWith(`/workspaces/${activeId}`);
  const canPin = agent && !!window.desktopAgents && !!activeId && (!chosen || normDir(chosen) !== normDir(cwd!)) && !isOwnWorkspace;
  const target = agent ? terminalTarget(data) : null;
  const actions = agent && (target || window.desktopLocal || canPin);

  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="ghost" size="xs" className="min-w-0 shrink gap-1 px-1.5 font-normal text-muted-foreground/80 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground" title={t('runTag.title')} data-run-tag />}
      >
        <span className="truncate">{agent ? <><span>{runtimeLabel}</span><span className="hidden @[22rem]/panel:inline"> · {folder}</span></> : label}</span>
        <ChevronDown strokeWidth={1.75} className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-2.5 p-3" data-run-tag-popover>
        <dl className={ROWS}>
          {model && (<><dt className="text-muted-foreground/70">{t('runTag.model')}</dt><dd className="min-w-0 break-words text-foreground">{agent ? `${runtimeLabel} · ${model}` : describeModel(model)}{effort ? ` · ${effort}` : ''}</dd></>)}
          {permission && (<><dt className="text-muted-foreground/70">{t('runTag.access')}</dt><dd className="text-foreground">{permission}</dd></>)}
          {!agent && data.gatewaySearches?.[i] && (<><dt className="text-muted-foreground/70">{t('runTag.web')}</dt><dd className="text-foreground">{t('runTag.webOn')}</dd></>)}
          {cwd && (<><dt className="text-muted-foreground/70">{t('runTag.dir')}</dt><dd className="min-w-0 break-all font-mono text-2xs text-muted-foreground" data-run-tag-cwd={cwd}>{cwd}</dd></>)}
        </dl>
        {actions && (
          <div className="-mx-1.5 -mb-1.5 flex flex-col border-t border-border pt-1.5">
            {target && (
              <Button variant="ghost" size="sm" className="justify-start font-normal" disabled={data.isLoading}
                title={target.inChat ? t('agent.openInChatTitle') : t('agent.continueInTerminalTitle')}
                onClick={() => void continueInTerminal(data)}>
                {target.inChat ? t('runTag.chat') : t('runTag.terminal')}
              </Button>
            )}
            {window.desktopLocal && (
              <Button variant="ghost" size="sm" className="justify-start font-normal" onClick={() => void openLocalPath(cwd!)}>
                {t('agent.openDir')}
              </Button>
            )}
            {canPin && (
              <Button variant="ghost" size="sm" className="justify-start font-normal" title={t('agent.useAsCwd')} data-run-tag-pin
                onClick={() => { void setProjectAgentCwd(activeId!, cwd!).then(() => toast('success', t('agent.useAsCwdDone'), 4000)); }}>
                {t('runTag.pin')}
              </Button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
