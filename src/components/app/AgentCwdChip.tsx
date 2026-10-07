import { useEffect, useRef, useState } from 'react';
import { FolderOpen, ChevronDown } from 'lucide-react';
import { useT } from '../../i18n';
import { Popover, PopoverContent } from '../ui/popover';
import { useUiStore } from '../../lib/ui-store';
import { useProjects, setProjectAgentCwd } from '../../store/projects';
import { useStore } from '../../store';
import { runtimeOf, AGENT_RUNTIMES, resolveAgentCwd, mirroredCwd, type CwdChoice } from '../../lib/agents/agent-runtime';
import { Button } from '../ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../ui/input-group';
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from '../ui/command';
import CwdBrowser from './CwdBrowser';

// Where the agent works, above the box that starts a line (and on the
// toolbar where a host still shows it), whenever an agent model is the
// pick: the chosen folder, the mirrored project, or the canvas's own
// workspace — for a runtime without workspaces (the harness), the session
// its chat shows, else its own default. One click shows the choices; the
// folder dialog adds a new one — the host's own, or, on a host whose dialog
// would open where nobody looks, its folders walked in the popover — and a
// typed path does where there is no dialog.
// Nothing is mandatory.

const tail = (p: string) => p.split('/').filter(Boolean).slice(-1)[0] ?? p;

/** iconOnly: canvas top bar out of room — the folder name moves to the tooltip;
 *  composer: the borderless control above an ask box */
export default function AgentCwdChip({ iconOnly = false, composer = false }: { iconOnly?: boolean; composer?: boolean }) {
  const t = useT();
  const selectedModel = useUiStore((s) => s.selectedModel);
  const activeId = useProjects((s) => s.activeId);
  const projects = useProjects((s) => s.projects);
  const nodeCount = useStore((s) => s.nodes.length);
  const [choice, setChoice] = useState<CwdChoice | null>(null);
  const [mirrored, setMirrored] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // focus lands on the list, not on whatever button happens to be tabbable first
  const listRef = useRef<HTMLDivElement>(null);
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
  const browseDirs = !nativePicker && !!window.desktopAgents?.capabilities?.browseDirs && !!window.desktopAgents?.listDirs;
  const pick = async () => {
    if (browseDirs) return setBrowsing(true);
    const dir = await window.desktopAgents!.pickCwd();
    if (dir) await choose(dir);
  };
  const submitTyped = async () => {
    const v = typed.trim();
    if (v.startsWith('/')) await choose(v);
  };

  return (
    <div ref={rootRef} className="relative">
      {/* chrome at the default size, like the switcher and the picker it
          stands between: one row of canvas controls, one height */}
      <Button variant={composer ? 'ghost' : 'chrome'} size={composer ? 'sm' : 'default'}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); setBrowsing(false); }}
        // this one opens its popover by anchor, not as a PopoverTrigger, so it
        // states the open state itself — chrome keys its accent off it
        aria-expanded={open}
        className={composer ? 'max-w-[220px] gap-1.5 rounded-md px-2 text-xs font-normal text-foreground hover:bg-muted aria-expanded:bg-muted' : 'max-w-[220px]'}
        title={`${t('agent.cwd')} · ${choice.cwd || t('agent.cwdSessionHint')}`}
        data-agent-cwd={choice.kind}
      >
        <FolderOpen strokeWidth={1.75} className="shrink-0" />
        {!iconOnly && <span className={`text-xs truncate ${composer ? '' : 'font-medium'}`}>{chipLabel}</span>}
        <ChevronDown strokeWidth={1.75} className="shrink-0 opacity-70" />
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverContent anchor={rootRef} align={composer ? 'start' : 'end'} sideOffset={6} className="w-[320px] gap-0 p-0" initialFocus={listRef} onClick={(e) => e.stopPropagation()}>
          {browsing ? (
            <CwdBrowser start={choice.cwd || mirrored || undefined} onUse={(dir) => { setBrowsing(false); void choose(dir); }} onBack={() => setBrowsing(false)} />
          ) : (
            /* a menu of folders: cmdk owns the row metrics and the tick, so a
               two-line choice is a row that grows, not text spilling out of a button */
            <Command ref={listRef} shouldFilter={false} className="bg-transparent">
              <CommandList className="max-h-[60vh]">
                <CommandGroup heading={<span className="uppercase tracking-wider">{t('agent.cwd')}</span>}>
                  <p className="px-2 pb-1.5 text-2xs text-muted-foreground" data-agent-cwd-scope>{t('agent.cwdScope')}</p>
                  <CommandItem value="default" onSelect={() => void choose(undefined)} data-checked={!meta?.agentCwd}>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-xs text-foreground">{defaultLabel}</span>
                      <span className="block truncate text-2xs text-muted-foreground">{defaultHint}</span>
                    </span>
                  </CommandItem>
                  {meta?.agentCwd && (
                    <CommandItem value="current" onSelect={() => void choose(meta.agentCwd)} data-checked>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-xs text-foreground">{tail(meta.agentCwd)}</span>
                        <span className="block truncate text-2xs text-muted-foreground">{meta.agentCwd}</span>
                      </span>
                    </CommandItem>
                  )}
                </CommandGroup>
                {recent.length > 0 && (
                  <CommandGroup heading={<span className="uppercase tracking-wider">{t('agent.cwdRecent')}</span>}>
                    {recent.map((c) => (
                      <CommandItem key={c} value={c} onSelect={() => void choose(c)}>
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-xs text-foreground">{tail(c)}</span>
                          <span className="block truncate text-2xs text-muted-foreground">{c}</span>
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {(nativePicker || browseDirs) && (
                  <>
                    <CommandSeparator />
                    <CommandGroup>
                      <CommandItem value="pick" onSelect={() => void pick()} data-agent-cwd-pick>
                        <FolderOpen strokeWidth={1.75} className="text-muted-foreground" />
                        <span className="flex-1 truncate text-xs text-foreground">{t('agent.cwdPick')}</span>
                      </CommandItem>
                    </CommandGroup>
                  </>
                )}
              </CommandList>
              {/* no folder dialog on this runtime: the path is typed. The field
                  sits outside the list so the list's keys stay the list's, and it
                  is one control — the field and its confirm share a border. */}
              {!nativePicker && (
                <div className="border-t border-border/60 p-1">
                  <InputGroup>
                    <InputGroupInput
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void submitTyped(); }}
                      placeholder={t('agent.cwdType')}
                      // a path reads in mono; the prompt that asks for one is prose
                      className="font-mono text-xs! placeholder:font-sans"
                      data-agent-cwd-input
                    />
                    <InputGroupAddon align="inline-end">
                      {/* only an absolute path is a directory — say so by staying dim
                          rather than swallowing the click */}
                      <InputGroupButton onClick={() => void submitTyped()} disabled={!typed.trim().startsWith('/')} className="text-primary">
                        {t('agent.cwdUse')}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </div>
              )}
            </Command>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
