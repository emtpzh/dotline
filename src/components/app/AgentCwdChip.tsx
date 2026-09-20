import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Check, ChevronDown, ShieldCheck, ShieldOff, X } from 'lucide-react';
import { useT } from '../../i18n';
import { Popover, PopoverContent } from '../ui/popover';
import { useUiStore } from '../../lib/ui-store';
import { useProjects, setProjectAgentCwd } from '../../store/projects';
import { useStore } from '../../store';
import { runtimeOf, AGENT_RUNTIMES, resolveAgentCwd, mirroredCwd, setGuardMode, allowLocation, type CwdChoice } from '../../lib/agents/agent-runtime';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

// Where the agent works, on the toolbar, whenever an agent model is the
// pick: the chosen folder, the mirrored project, or the canvas's own
// workspace — for a runtime without workspaces (the harness), the session
// its chat shows, else its own default. One click shows the choices; the
// folder dialog (or a typed path, where there is no dialog) adds a new one.
// Nothing is mandatory.

const tail = (p: string) => p.split('/').filter(Boolean).slice(-1)[0] ?? p;

export default function AgentCwdChip() {
  const t = useT();
  const selectedModel = useUiStore((s) => s.selectedModel);
  const activeId = useProjects((s) => s.activeId);
  const projects = useProjects((s) => s.projects);
  const nodeCount = useStore((s) => s.nodes.length);
  const [choice, setChoice] = useState<CwdChoice | null>(null);
  const [mirrored, setMirrored] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const runtime = runtimeOf(selectedModel);
  const visible = !!window.desktopAgents && !!runtime;
  const caps = runtime ? AGENT_RUNTIMES[runtime].caps : null;

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void resolveAgentCwd(runtime).then((c) => { if (alive) setChoice(c); });
    void mirroredCwd().then((m) => { if (alive) setMirrored(m); });
    return () => { alive = false; };
  }, [visible, runtime, activeId, projects, nodeCount]);

  if (!visible || !choice) return null;
  // what "no choice" means on this runtime: the mirrored project, else the
  // canvas's workspace, or the harness's current session / its own default
  const defaultLabel = mirrored ? t('agent.cwdMirrored') : caps?.workspace ? t('agent.cwdWorkspace') : t('agent.cwdSession');
  const defaultHint = mirrored ?? (caps?.workspace ? t('agent.cwdWorkspaceHint') : (choice.kind === 'session' ? choice.cwd : t('agent.cwdSessionHint')));
  const chipLabel = choice.kind === 'workspace' ? t('agent.cwdWorkspace') : choice.kind === 'default' ? t('agent.cwdSession') : tail(choice.cwd);
  const meta = projects.find((p) => p.id === activeId);
  const recent = [...new Set(projects.map((p) => p.agentCwd).filter((c): c is string => !!c))].filter((c) => c !== meta?.agentCwd).slice(0, 5);

  const choose = async (cwd: string | undefined) => {
    if (!activeId) return;
    await setProjectAgentCwd(activeId, cwd);
    setOpen(false);
  };
  const nativePicker = window.desktopAgents?.capabilities?.nativePicker !== false;
  const pick = async () => {
    const dir = await window.desktopAgents!.pickCwd();
    if (dir) await choose(dir);
  };
  const submitTyped = async () => {
    const v = typed.trim();
    if (v.startsWith('/')) await choose(v);
  };

  return (
    <div ref={rootRef} className="relative">
      <Button variant="outline" size="sm"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="backdrop-blur max-w-[220px]"
        title={`${t('agent.cwd')} · ${choice.cwd || t('agent.cwdSessionHint')}`}
        data-agent-cwd={choice.kind}
      >
        <FolderOpen size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" />
        <span className="truncate">{chipLabel}</span>
        <ChevronDown size={12} strokeWidth={1.75} className="text-muted-foreground shrink-0" />
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverContent anchor={rootRef} align="end" sideOffset={6} className="w-[320px] gap-0 p-0 py-1.5" onClick={(e) => e.stopPropagation()}>
          <p className="text-2xs text-muted-foreground uppercase tracking-wider font-medium px-3 pt-1">{t('agent.cwd')}</p>
          <p className="text-2xs text-muted-foreground px-3 pb-1.5" data-agent-cwd-scope>{t('agent.cwdScope')}</p>
          <Button variant="ghost" size="sm" onClick={() => void choose(undefined)} className="w-full text-left text-xs hover:bg-accent">
            <span className="flex-1 min-w-0">
              <span className="block text-foreground">{defaultLabel}</span>
              <span className="block text-2xs text-muted-foreground truncate">{defaultHint}</span>
            </span>
            {!meta?.agentCwd && <Check size={13} strokeWidth={2} className="shrink-0 text-primary" />}
          </Button>
          {meta?.agentCwd && (
            <Button variant="ghost" size="sm" onClick={() => void choose(meta.agentCwd)} className="w-full text-left text-xs hover:bg-accent">
              <span className="flex-1 min-w-0"><span className="block text-foreground">{tail(meta.agentCwd)}</span><span className="block text-2xs text-muted-foreground truncate">{meta.agentCwd}</span></span>
              <Check size={13} strokeWidth={2} className="shrink-0 text-primary" />
            </Button>
          )}
          {recent.length > 0 && <p className="text-2xs text-muted-foreground uppercase tracking-wider font-medium px-3 pt-2 pb-1">{t('agent.cwdRecent')}</p>}
          {recent.map((c) => (
            <Button variant="ghost" size="sm" key={c} onClick={() => void choose(c)} className="w-full text-left text-xs hover:bg-accent">
              <span className="flex-1 min-w-0"><span className="block text-foreground">{tail(c)}</span><span className="block text-2xs text-muted-foreground truncate">{c}</span></span>
            </Button>
          ))}
          <div className="border-t border-border/60 my-1" />
          {nativePicker ? (
            <Button variant="ghost" size="sm" onClick={() => void pick()} className="w-full text-left text-xs text-foreground hover:bg-accent" data-agent-cwd-pick>
              <FolderOpen size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" /> {t('agent.cwdPick')}
            </Button>
          ) : (
            <div className="px-3 py-2 flex items-center gap-2">
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void submitTyped(); }}
                placeholder={t('agent.cwdType')}
                className="flex-1 min-w-0 font-mono focus:border-primary/60"
                data-agent-cwd-input
              />
              <Button variant="ghost" size="sm" onClick={() => void submitTyped()} className="text-xs text-primary hover:underline shrink-0">{t('agent.cwdUse')}</Button>
            </div>
          )}
          {/* the boundary guard: only a runtime that reads the guard file */}
          {caps?.guard && (
            <>
              <div className="border-t border-border/60 my-1" />
              <p className="text-2xs text-muted-foreground uppercase tracking-wider font-medium px-3 pt-1 pb-1">{t('agent.guard')}</p>
              <Button variant="ghost" size="sm" onClick={() => { void setGuardMode('ask'); setOpen(false); }} className="w-full text-left text-xs hover:bg-accent" data-agent-guard="ask">
                <ShieldCheck size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" />
                <span className="flex-1 min-w-0"><span className="block text-foreground">{t('agent.guardAsk')}</span><span className="block text-2xs text-muted-foreground">{t('agent.guardAskHint')}</span></span>
                {(meta?.agentGuard?.mode ?? 'ask') === 'ask' && <Check size={13} strokeWidth={2} className="shrink-0 text-primary" />}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { void setGuardMode('allow'); setOpen(false); }} className="w-full text-left text-xs hover:bg-accent" data-agent-guard="allow">
                <ShieldOff size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" />
                <span className="flex-1 min-w-0"><span className="block text-foreground">{t('agent.guardAllow')}</span><span className="block text-2xs text-muted-foreground">{t('agent.guardAllowHint')}</span></span>
                {meta?.agentGuard?.mode === 'allow' && <Check size={13} strokeWidth={2} className="shrink-0 text-primary" />}
              </Button>
              {(meta?.agentGuard?.allow?.length ?? 0) > 0 && (
                <>
                  <p className="text-2xs text-muted-foreground px-3 pt-2 pb-1">{t('agent.guardAllowed')}</p>
                  {meta!.agentGuard!.allow.map((a) => (
                    <div key={a} className="px-3 py-1 text-xs flex items-center gap-2 min-w-0" data-agent-guard-allowed={a}>
                      <span className="flex-1 min-w-0 truncate text-muted-foreground font-mono" title={a}>{a}</span>
                      <Button variant="ghost" onClick={() => void allowLocation(a, true)} className="text-muted-foreground hover:text-destructive/90 shrink-0" title={t('agent.guardRemove')}>
                        <X size={12} strokeWidth={2} />
                      </Button>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
