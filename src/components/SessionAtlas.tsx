import { useEffect, useMemo, useState, useCallback } from 'react';
import { ArrowUpRight, ChevronDown, FolderOpen, GitBranch, ListFilter, Loader2, MoreHorizontal, Plug, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { scanSessions, groupByCwd, disabledRoots, setRootDisabled, runnerLabel, type SessionCard } from '../lib/atlas/discover';
import { diffAgainstWatermark, markSeen, markAllSeen, changeKeyOf, type CardChange } from '../lib/atlas/watermark';
import type { CanonicalResult } from '../lib/atlas/canonical';
import { useProjects, subscribedSessionIds, mainSubscription } from '../store/projects';
import { useT, t as ti, fmt } from '../i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator } from './ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from './ui/command';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { InputGroup, InputGroupAddon, InputGroupInput } from './ui/input-group';
import { ButtonGroup, ButtonGroupSeparator } from './ui/button-group';
import { readSession } from '../lib/sessions/read';
import { toast } from '../lib/ui-store';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';

// Session discovery is a list of sources. Canvas management lives in ProjectSwitcher.

const dateLabel = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const sizeLabel = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const folderName = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? cwd;

type SortKey = 'time' | 'name' | 'size' | 'runner';
const SORT_LABEL = { time: 'atlas.sortTime', name: 'atlas.sortName', size: 'atlas.sortSize', runner: 'atlas.sortRunner' } as const;
const SORTERS: Record<SortKey, (a: SessionCard, b: SessionCard) => number> = {
  time: (a, b) => b.mtime - a.mtime,
  name: (a, b) => a.title.localeCompare(b.title),
  size: (a, b) => b.size - a.size,
  runner: (a, b) => a.runner.localeCompare(b.runner) || b.mtime - a.mtime,
};

const ALL = '__all__';

// The intake dialog: built-in sources probe their standard paths; runners
// whose parser isn't ready yet stand as honest placeholders; custom
// directories enter ONLY through the native picker (shell-side whitelist).
function SourcesDialog({ roots, counts, onChanged, onClose, terminalSettings }: {
  terminalSettings?: React.ReactNode;
  roots: SessionRoot[];
  counts: Map<string, number>;
  onChanged: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const off = disabledRoots();
  const builtinLabel: Record<string, string> = { 'claude-projects': 'Claude Code', 'codex-sessions': 'Codex', 'dsh-sessions': 'DeepSeek Harness', 'pi-sessions': 'Pi' };
  // one-command handoff: install /thoughtdag ($thoughtdag) into the
  // agent's own commands directory, content-compare driving the state
  const [cmds, setCmds] = useState<Record<string, { state: string; dest: string; invoke: string }> | null>(null);
  const refreshCmds = () => { void window.desktopSessions?.commandsStatus?.().then(setCmds).catch(() => { }); };
  useEffect(refreshCmds, []);
  const row = (root: SessionRoot) => (
    <div key={root.key} className="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0" data-atlas-source={root.key}>
      <Checkbox
        aria-label={root.path}
        checked={!off.has(root.key)}
        disabled={!root.exists}
        onCheckedChange={checked => { setRootDisabled(root.key, !checked); onChanged(); }} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{builtinLabel[root.key] ?? folderName(root.path)}</div>
        <div className="truncate text-xs text-muted-foreground">{root.path}</div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {root.exists ? (counts.get(root.key) ?? 0) : t('atlas.rootMissing')}
      </span>
      {!root.builtin && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('common.delete')}
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => { void window.desktopSessions!.removeRoot(root.key).then(onChanged); }}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
  const handoff = cmds ? Object.entries(cmds).filter(([, c]) => c.state !== 'unavailable') : [];
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent size="md" className="max-h-[80dvh] overflow-y-auto" data-atlas-sources-dialog>
        <DialogHeader>
          <DialogTitle>{t('atlas.sourcesTitle')}</DialogTitle>
          <DialogDescription>{t('atlas.sourcesHint')}</DialogDescription>
        </DialogHeader>
        <div>
          {roots.filter((r) => r.builtin).map(row)}
          {roots.filter((r) => !r.builtin).map(row)}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onChanged}>
            <RefreshCw />
            {t('atlas.autoDetect')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { void window.desktopSessions!.addRoot().then((r) => { if (r) onChanged(); }); }}
            data-atlas-add-dir>
            <Plug />
            {t('atlas.addDir')}
          </Button>
        </div>
        {terminalSettings && (
          <div className="flex items-center gap-3 border-t border-border pt-4">
            <span className="flex-1 text-sm text-foreground">{t('atlas.terminalChoice')}</span>
            {terminalSettings}
          </div>
        )}
        {handoff.length > 0 && (
          <div className="border-t border-border pt-4">
            <div className="pb-1 text-xs font-medium text-muted-foreground">{t('atlas.handoffTitle')}</div>
            {handoff.map(([runner, c]) => (
              <div key={runner} className="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0" data-atlas-handoff={runner} data-handoff-state={c.state}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm text-foreground">
                    {runnerLabel(runner)}
                    <code className="rounded-md border border-border bg-muted px-1.5 font-mono text-xs">{c.invoke}</code>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {t(c.state === 'installed' ? 'atlas.handoffOn' : c.state === 'outdated' ? 'atlas.handoffOutdated' : 'atlas.handoffOff')}
                  </div>
                </div>
                {c.state !== 'installed' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    data-handoff-install
                    onClick={() => void (async () => {
                      const { confirmDialog } = await import('../lib/ui-store');
                      const ok = await confirmDialog({
                        title: ti('atlas.handoffEnableTitle'),
                        message: fmt(ti('confirm.installCommand'), { path: c.dest }),
                        confirmLabel: ti(c.state === 'outdated' ? 'atlas.handoffUpdate' : 'atlas.handoffEnable'),
                      });
                      if (!ok) return;
                      const r = await window.desktopSessions!.commandsInstall!(runner);
                      if (r.ok) toast('success', fmt(ti('atlas.handoffInstalled'), { cmd: c.invoke }), 8000);
                      else toast('error', r.error ?? 'install failed');
                      refreshCmds();
                    })()}
                  >
                    {t(c.state === 'outdated' ? 'atlas.handoffUpdate' : 'atlas.handoffEnable')}
                  </Button>
                )}
                {(c.state === 'installed' || c.state === 'outdated') && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t('atlas.handoffRemove')}
                    title={t('atlas.handoffRemove')}
                    data-handoff-remove
                    onClick={() => void window.desktopSessions!.commandsRemove!(runner).then(refreshCmds)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One toast per outcome of the canonical road, wherever it led. */
function reportCanonical(result: NonNullable<CanonicalResult>) {
  if (result.kind === 'appended') toast('success', fmt(ti('atlas.appended'), { n: result.turns }), 9000);
  else if (result.kind === 'mounted') toast('success', fmt(ti(result.mode === 'continue' ? 'atlas.mountedChapter' : 'atlas.mountedBranch'), { n: result.turns }), 9000);
  else if (result.kind === 'opened') toast('info', ti('atlas.upToDate'), 6000);
  else toast('success', fmt(ti('toast.importedChats'), { n: 1, m: result.nodeCount }), 9000);
}

export default function SessionAtlas({ onClose, onSwitched, focusSessionId }: { onClose: () => void; onSwitched: () => void; focusSessionId?: string }) {
  const t = useT();
  const projects = useProjects((s) => s.projects);
  const activeId = useProjects(s => s.activeId);
  const isDesktop = !!window.desktopSessions;
  const [cards, setCards] = useState<SessionCard[] | null>(null);
  const [roots, setRoots] = useState<SessionRoot[]>([]);
  const [scanning, setScanning] = useState(false);
  // All directories are visible until the user narrows the list.
  const [folder, setFolder] = useState<string>(ALL);
  const [busy, setBusy] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  // Tier 2 enrichment: the thread store's REAL names and fork lineage.
  // Purely additive — absent codex CLI, the maps stay empty and every
  // card keeps its Tier 1 identity (first user prompt).
  const [threadNames, setThreadNames] = useState<Map<string, string>>(new Map());
  const [threadForks, setThreadForks] = useState<Map<string, string>>(new Map());
  // the picks: sessions on their way onto a canvas. A row click picks;
  // only the footer's button writes — nothing lands on a canvas by a
  // single stray click.
  const [picked, setPicked] = useState<Map<string, SessionCard>>(new Map());
  const pickKey = (card: SessionCard) => `${card.rootKey}|${card.rel}`;
  const togglePick = (card: SessionCard) => setPicked((prev) => {
    const next = new Map(prev);
    const k = pickKey(card);
    if (next.has(k)) next.delete(k); else next.set(k, card);
    return next;
  });
  // which canvas (if any) subscribes to a session — main, chapter or branch alike
  const canvasOf = (sessionId: string) => projects.find((p) => subscribedSessionIds(p).includes(sessionId));
  const [query, setQuery] = useState('');
  const [runnerOff, setRunnerOff] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [only, setOnly] = useState<string[]>([]);
  const onlyUnlinked = only.includes('unlinked');
  const onlyChanged = only.includes('changed');
  const [showSubagents, setShowSubagents] = useState(false);
  const [changes, setChanges] = useState<Map<string, CardChange>>(new Map());
  const [targets, setTargets] = useState<Awaited<ReturnType<NonNullable<Window['desktopSessions']>['openTargets']>> | null>(null);
  useEffect(() => { void window.desktopSessions?.openTargets().then(setTargets).catch(() => { }); }, []);
  const appHosts = useMemo(() => new Map((targets?.apps ?? []).map((a) => [a.runner, a.name])), [targets]);

  const refresh = async () => {
    setScanning(true);
    try {
      setRoots(await window.desktopSessions?.roots().catch(() => []) ?? []);
      const scanned = await scanSessions();
      setCards(scanned);
      setChanges(diffAgainstWatermark(scanned));
      // Tier 2 enrichment, fire-and-forget: real thread names + fork
      // lineage from the codex app-server; silence on any failure
      void window.desktopSessions?.codexThreads?.().then((threads) => {
        if (!threads) return;
        setThreadNames(new Map(threads.filter((t) => t.name && t.sessionId).map((t) => [t.sessionId, t.name!])));
        setThreadForks(new Map(threads.filter((t) => t.forkedFromId && t.sessionId).map((t) => [t.sessionId, t.forkedFromId!])));
      }).catch(() => { });
      // arrival from a mirror canvas: land on the folder that holds the session
      // this canvas mirrors
      if (focusSessionId) {
        const hit = scanned.find((c) => c.sessionId === focusSessionId);
        if (hit) setFolder(hit.cwd ?? '');
      }
    } catch (err) {
      toast('error', fmt(ti('atlas.parseFailed'), { msg: err instanceof Error ? err.message : String(err) }));
    } finally { setScanning(false); }
  };
  // one scan on mount; refresh is recreated per render and must not re-run the scan
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, []);
  // ...and the twin badge's session scrolls into view once the scan lands
  const landed = cards !== null;
  useEffect(() => {
    if (landed && focusSessionId) document.querySelector(`[data-atlas-session="${CSS.escape(focusSessionId)}"]`)?.scrollIntoView({ block: 'center' });
  }, [landed, focusSessionId]);

  // live freshness: the watcher (live-mirror) broadcasts store changes;
  // an open atlas rescans, throttled — badges and counts stay current
  useEffect(() => {
    let cooling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChanged = () => {
      if (cooling || scanning) return;
      cooling = true;
      timer = setTimeout(() => { cooling = false; void refresh(); }, 2000);
    };
    window.addEventListener('td:sessions-changed', onChanged);
    return () => { clearTimeout(timer); window.removeEventListener('td:sessions-changed', onChanged); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  // ONE identity per card — display, search and sort must agree: the
  // REAL thread name when the store lends one, the parsed title
  // otherwise. Search or sort on a different string than the one on
  // screen reads as a broken atlas.
  const displayTitle = useCallback((c: SessionCard): string => threadNames.get(c.sessionId) ?? c.title, [threadNames]);

  // filters shape the whole atlas: folder counts follow them too
  const visible = useMemo(() => (cards ?? []).filter((c) =>
    !runnerOff.has(c.runner)
    && (showSubagents || !c.subagent)
    && (!onlyChanged || changes.has(changeKeyOf(c)))
    && (!query.trim() || `${displayTitle(c)} ${c.cwd ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))), [cards, runnerOff, query, onlyChanged, changes, showSubagents, displayTitle]);
  const folders = useMemo(() => groupByCwd(visible), [visible]);
  const runners = useMemo(() => [...new Set((cards ?? []).map((c) => c.runner))].sort(), [cards]);
  const rootCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards ?? []) m.set(c.rootKey, (m.get(c.rootKey) ?? 0) + 1);
    return m;
  }, [cards]);
  const sorter = sortKey === 'name' ? (a: SessionCard, b: SessionCard) => displayTitle(a).localeCompare(displayTitle(b)) : SORTERS[sortKey];
  const shown = visible
    .filter(c => (folder === ALL || (c.cwd ?? '') === folder) && (!onlyUnlinked || !canvasOf(c.sessionId)))
    .sort(sorter);
  // across every folder the list reads by project: one heading per
  // folder, so a row never has to repeat its path
  const sections = folder === ALL
    ? groupByCwd(shown).map((g) => ({ key: g.cwd ?? '', name: g.name || t('atlas.unfiled'), path: g.cwd, cards: [...g.cards].sort(sorter) }))
    : [{ key: folder, name: null, path: null, cards: shown }];
  const pickable = shown.filter(c => !!c.sessionId && !canvasOf(c.sessionId));
  const allPicked = pickable.length > 0 && pickable.every(c => picked.has(pickKey(c)));
  const somePicked = pickable.some(c => picked.has(pickKey(c)));
  const hiddenFilters = runnerOff.size + (showSubagents ? 1 : 0);
  const destinations = projects
    .filter(p => !p.archived && p.kind !== 'paradigm')
    .sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : b.updatedAt - a.updatedAt));

  const seen = (card: SessionCard) => {
    markSeen(card);
    setChanges((m) => { const n = new Map(m); n.delete(changeKeyOf(card)); return n; });
  };

  const fail = (err: unknown) => toast('error', fmt(ti('atlas.parseFailed'), { msg: err instanceof Error ? err.message : String(err) }));

  // a session that already lives on a canvas: open it there and sync
  // what it said since
  const openLinked = async (card: SessionCard) => {
    if (busy) return;
    setBusy(card.rel);
    try {
      // streamed end to end: a session bigger than one V8 string can hold
      // (600MB+ rollouts exist) must never be read whole
      const { importOrAppendConversation } = await import('../lib/atlas/canonical');
      const read = await readSession(card, { cards });
      if (!read) throw new Error(ti('handoff.notASession'));
      const result = await importOrAppendConversation(read.conv, { snapshot: read.snapshot });
      seen(card);
      if (!result) throw new Error(ti('handoff.notASession'));
      reportCanonical(result);
      onClose();
      onSwitched();
    } catch (err) { fail(err); } finally { setBusy(null); }
  };

  // the picks onto a canvas. `projectId` absent = a new canvas.
  const addPicked = async (projectId?: string) => {
    if (busy || picked.size < 1) return;
    setTargetOpen(false);
    setBusy('__add__');
    try {
      const { importOrAppendConversation, mergeSessionsIntoProject } = await import('../lib/atlas/canonical');
      const list = [...picked.values()];
      const reads = [];
      for (const card of list) {
        const read = await readSession(card, { cards });
        if (!read) throw new Error(ti('handoff.notASession'));
        reads.push(read);
      }
      if (!projectId && reads.length === 1) {
        // one session onto a canvas of its own takes the canonical road:
        // it re-adopts a canvas that still holds its mirror, mounts back
        // at the node it departed from, or opens as a fresh mirror
        const result = await importOrAppendConversation(reads[0].conv, { snapshot: reads[0].snapshot });
        if (!result) throw new Error(ti('handoff.notASession'));
        reportCanonical(result);
      } else {
        const result = await mergeSessionsIntoProject(reads.map((r) => r.conv), projectId);
        if (!result) throw new Error(ti('handoff.notASession'));
        toast('success', fmt(ti('atlas.merged'), { n: result.mounted }), 10000);
        if (result.skipped > 0) toast('info', fmt(ti('atlas.mergeSkippedInfo'), { n: result.skipped }), 8000);
      }
      for (const card of list) seen(card);
      setPicked(new Map());
      onClose();
      onSwitched();
    } catch (err) { fail(err); } finally { setBusy(null); }
  };

  // Re-mirror: the coarse tier of recoverability. The read-only source is
  // a permanent undo floor — delete the twin canvas (edits and all, after
  // an explicit confirm) and rebuild the full mirror from the file.
  const recast = async (card: SessionCard) => {
    const twin = useProjects.getState().projects.find((p) => mainSubscription(p)?.sessionId === card.sessionId);
    if (!twin || busy) return;
    const { confirmDialog } = await import('../lib/ui-store');
    const ok = await confirmDialog({
      title: ti('confirm.recastTitle'),
      message: fmt(ti('confirm.recast'), { name: twin.name }),
      confirmLabel: ti('confirm.recastTitle'),
      danger: true,
    });
    if (!ok) return;
    setBusy(card.rel);
    try {
      const { importOrAppendConversation } = await import('../lib/atlas/canonical');
      const read = await readSession(card, { cards });
      if (!read) throw new Error(ti('handoff.notASession'));
      const { deleteProject } = await import('../store/projects');
      await deleteProject(twin.id);
      const result = await importOrAppendConversation(read.conv, { snapshot: read.snapshot });
      if (!result) throw new Error(ti('handoff.notASession'));
      toast('success', ti('atlas.recastDone'), 8000);
      onClose();
      onSwitched();
    } catch (err) { fail(err); } finally { setBusy(null); }
  };

  const openInCli = async (card: SessionCard, mode: 'app' | 'terminal') => {
    const r = await window.desktopSessions!.openInCli(card.runner, card.cwd, card.sessionId, mode)
      .catch(() => ({ opened: false, via: '' as const, command: '' }));
    if (r.opened && r.via === 'app') {
      // no documented deep link to a specific session yet — hand the user
      // the id so the app's own search can land on it
      await navigator.clipboard.writeText(card.sessionId).catch(() => { });
      toast('success', ti('atlas.appOpened'), 9000);
    } else if (r.opened) toast('success', ti('atlas.opened'));
    else if (r.command) {
      await navigator.clipboard.writeText(r.command).catch(() => { });
      toast('info', ti('atlas.cmdCopied'), 9000);
    }
  };

  const sessionRow = (card: SessionCard) => {
    const home = canvasOf(card.sessionId);
    const change = changes.get(changeKeyOf(card));
    const canPick = !home && !!card.sessionId;
    const isPicked = picked.has(pickKey(card));
    const fork = threadForks.get(card.sessionId);
    return (
      // the row picks (or, on a canvas already, opens it); its controls
      // keep their clicks to themselves — a menu item must not also pick
      <div
        key={pickKey(card)}
        className={`flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0 ${canPick || home ? 'cursor-pointer hover:bg-muted/60' : ''} ${isPicked ? 'bg-primary/5' : ''} ${card.sessionId === focusSessionId ? 'bg-accent' : ''}`}
        onClick={() => { if (busy) return; if (canPick) togglePick(card); else if (home) void openLinked(card); }}
        data-atlas-session={card.sessionId}
        data-atlas-pick={isPicked ? 'on' : 'off'}>
        <span className="flex" onClick={e => e.stopPropagation()}>
          <Checkbox
            aria-label={fmt(t('atlas.selectSession'), { name: displayTitle(card) })}
            disabled={!!busy || !canPick}
            checked={isPicked}
            onCheckedChange={() => togglePick(card)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm text-foreground">{displayTitle(card)}</span>
            {fork && <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-label={fmt(t('atlas.forkedFrom'), { id: fork })} data-atlas-fork />}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted-foreground" title={card.cwd ?? undefined}>
            <span className="shrink-0">{runnerLabel(card.runner)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{dateLabel(card.mtime)}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{sizeLabel(card.size)}</span>
          </div>
        </div>
        {change && (change.kind === 'new'
          ? <Badge data-atlas-badge="new">{t('atlas.badgeNew')}</Badge>
          : <Badge variant="outline" className="border-primary/40 text-primary" data-atlas-badge="updated">+{sizeLabel(change.deltaSize)}</Badge>)}
        {home && (
          <Badge variant="secondary" className="hidden max-w-44 sm:inline-flex" title={home.name} data-atlas-badge="canvas">
            <span className="truncate">{home.id === activeId ? t('atlas.onCurrent') : fmt(t('atlas.linkedCanvas'), { name: home.name })}</span>
          </Badge>
        )}
        <span className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          {home && (
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void openLinked(card)} data-atlas-open>
              {busy === card.rel ? <Loader2 className="animate-spin" /> : <ArrowUpRight />}
              {t('atlas.openCanvas')}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger disabled={!!busy} render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t('atlas.more')} />}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {appHosts.has(card.runner) && <DropdownMenuItem onClick={() => void openInCli(card, 'app')}>{fmt(t('atlas.openApp'), { name: appHosts.get(card.runner)! })}</DropdownMenuItem>}
              <DropdownMenuItem onClick={() => void openInCli(card, 'terminal')}>{t('atlas.openTerminal')}</DropdownMenuItem>
              {projects.some(p => mainSubscription(p)?.sessionId === card.sessionId) && <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => void recast(card)}>{t('atlas.recast')}</DropdownMenuItem>
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
    );
  };

  return <>
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent size="lg" className="flex max-h-[90dvh] flex-col overflow-hidden" data-session-atlas showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t('atlas.title')}</DialogTitle>
          <DialogDescription>{t('atlas.subtitle')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="min-w-40 flex-1">
            <InputGroupInput
              aria-label={t('atlas.filterTitle')}
              placeholder={t('atlas.filterTitle')}
              value={query}
              onChange={e => setQuery(e.target.value)}
              data-atlas-filter />
            <InputGroupAddon><Search /></InputGroupAddon>
          </InputGroup>
          <Select value={folder} onValueChange={v => v !== null && setFolder(v)}>
            <SelectTrigger aria-label={t('atlas.folders')} className="max-w-48">
              <FolderOpen className="text-muted-foreground" />
              <SelectValue>{folder === ALL ? t('atlas.allFolders') : folder ? folderName(folder) : t('atlas.unfiled')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('atlas.allFolders')}</SelectItem>
              {folders.map(g => <SelectItem key={g.cwd ?? ''} value={g.cwd ?? ''}>
                <span className="flex-1 truncate">{g.name || t('atlas.unfiled')}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{g.cards.length}</span>
              </SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={sortKey} onValueChange={v => v && setSortKey(v as SortKey)}>
            <SelectTrigger aria-label={t('atlas.sortLabel')}>
              <SelectValue>{fmt(t('atlas.sortBy'), { key: t(SORT_LABEL[sortKey]) })}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABEL) as SortKey[]).map(k => <SelectItem key={k} value={k}>{t(SORT_LABEL[k])}</SelectItem>)}
            </SelectContent>
          </Select>
          {isDesktop && <Button variant="outline" size="icon" disabled={scanning || !!busy} aria-label={t('atlas.refresh')} title={t('atlas.refresh')} onClick={() => void refresh()}>
            <RefreshCw className={scanning ? 'animate-spin' : ''} />
          </Button>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup multiple variant="outline" size="sm" value={only} onValueChange={setOnly}>
            <ToggleGroupItem value="unlinked">{t('atlas.unlinked')}</ToggleGroupItem>
            <ToggleGroupItem value="changed" data-atlas-only-changed>
              {t('atlas.onlyChanged')}
              {changes.size > 0 && <span className="text-primary tabular-nums">{changes.size}</span>}
            </ToggleGroupItem>
          </ToggleGroup>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
              <ListFilter />
              {t('atlas.filters')}
              {hiddenFilters > 0 && <Badge variant="secondary" className="h-4 px-1.5">{hiddenFilters}</Badge>}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('atlas.filterSources')}</DropdownMenuLabel>
                {runners.map(r => <DropdownMenuCheckboxItem
                  key={r}
                  checked={!runnerOff.has(r)}
                  onCheckedChange={on => setRunnerOff(prev => { const next = new Set(prev); if (on) next.delete(r); else next.add(r); return next; })}>
                  {runnerLabel(r)}
                </DropdownMenuCheckboxItem>)}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={showSubagents} onCheckedChange={setShowSubagents} data-atlas-show-sub>{t('atlas.showSub')}</DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* fixed height: the dialog never jumps when the scan lands or a
            filter empties the list */}
        <div className="flex h-[min(56dvh,480px)] min-h-0 flex-col overflow-hidden rounded-xl border border-border">
          <div className="flex items-center gap-3 border-b border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <Checkbox
              aria-label={t('atlas.selectAll')}
              title={t('atlas.selectAll')}
              disabled={!!busy || !pickable.length}
              checked={allPicked}
              indeterminate={somePicked && !allPicked}
              onCheckedChange={checked => setPicked(prev => { const next = new Map(prev); for (const c of pickable) { if (checked) next.set(pickKey(c), c); else next.delete(pickKey(c)); } return next; })} />
            <span className="flex-1 tabular-nums">{cards ? fmt(t('atlas.sessions'), { n: shown.length }) : ''}</span>
            {changes.size > 0 && <Button variant="ghost" size="xs" onClick={() => { markAllSeen(cards ?? []); setChanges(new Map()); }} data-atlas-mark-all>
              {t('atlas.markAllSeen')}
            </Button>}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {cards === null && scanning
              ? Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="flex items-center gap-3 border-b border-border px-3 py-3.5 last:border-b-0">
                  <div className="size-4 rounded-[4px] bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-2/3 animate-pulse rounded-md bg-muted" />
                    <div className="h-2.5 w-1/3 animate-pulse rounded-md bg-muted" />
                  </div>
                </div>
              ))
              : shown.length === 0
                ? <p className="p-8 text-center text-sm text-muted-foreground">
                  {!isDesktop ? t('atlas.webNoScan') : cards?.length ? t('atlas.filteredOut') : t('atlas.empty')}
                </p>
                : sections.map(s => <section key={s.key} data-atlas-folder={s.name ?? undefined}>
                  {s.name && <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground" title={s.path ?? undefined}>
                    <FolderOpen className="size-3.5" />
                    <span className="truncate">{s.name}</span>
                    <span className="tabular-nums">{s.cards.length}</span>
                  </div>}
                  {s.cards.map(sessionRow)}
                </section>)}
          </div>
        </div>
        <DialogFooter className="items-center sm:justify-between">
          {picked.size > 0
            ? <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="tabular-nums">{fmt(t('atlas.mergeSelected'), { n: picked.size })}</span>
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setPicked(new Map())}>{t('atlas.clearPick')}</Button>
            </div>
            : <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {isDesktop
                ? <Button variant="ghost" size="sm" onClick={() => setSourcesOpen(true)} data-atlas-sources><Plug />{t('atlas.sourcesTitle')}</Button>
                : null}
              <span className="hidden sm:inline">{t('atlas.pickHint')}</span>
            </div>}
          <ButtonGroup>
            <Button disabled={!!busy || picked.size === 0} onClick={() => void addPicked()} data-atlas-add-new>
              {busy === '__add__' ? <Loader2 className="animate-spin" /> : <Plus />}
              {t('atlas.addNew')}
            </Button>
            <ButtonGroupSeparator className="bg-primary-foreground/30" />
            <Popover open={targetOpen} onOpenChange={setTargetOpen}>
              <PopoverTrigger
                disabled={!!busy || picked.size === 0 || destinations.length === 0}
                render={<Button size="icon" aria-label={t('atlas.addTo')} title={t('atlas.addTo')} data-atlas-add-to />}>
                <ChevronDown />
              </PopoverTrigger>
              <PopoverContent align="end" side="top" className="w-72 gap-0 p-0">
                <Command className="bg-transparent">
                  <CommandInput autoFocus placeholder={t('switcher.search')} />
                  <CommandList>
                    <CommandEmpty>{t('switcher.noResults')}</CommandEmpty>
                    <CommandGroup heading={t('atlas.addTo')}>
                      {destinations.map(p => <CommandItem key={p.id} value={p.id} keywords={[p.name]} onSelect={() => void addPicked(p.id)}>
                        <FolderOpen className="text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {p.id === activeId && <CommandShortcut className="tracking-normal">{t('atlas.currentOpen')}</CommandShortcut>}
                      </CommandItem>)}
                    </CommandGroup>
                  </CommandList>
                </Command>
                <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{t('atlas.independentHint')}</p>
              </PopoverContent>
            </Popover>
          </ButtonGroup>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {sourcesOpen && <SourcesDialog
      terminalSettings={targets && targets.terminals.length > 0 && <Select
        value={targets.prefs.terminal}
        onValueChange={value => { if (!value) return; if (value === '__add__') { void window.desktopSessions?.addTerminal().then(() => window.desktopSessions?.openTargets().then(setTargets)); return; } void window.desktopSessions?.setOpenPrefs({ terminal: value }).then(p => setTargets(tg => tg ? { ...tg, prefs: p } : tg)); }}>
        <SelectTrigger aria-label={t('atlas.terminalChoice')}>
          <SelectValue>{targets.terminals.find(term => term.id === targets.prefs.terminal)?.name}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {targets.terminals.map(term => <SelectItem key={term.id} value={term.id}>{term.name}</SelectItem>)}
          {targets.canAddCustom && <SelectItem value="__add__">{t('atlas.otherTerminal')}</SelectItem>}
        </SelectContent>
      </Select>}
      roots={roots}
      counts={rootCounts}
      onChanged={() => void refresh()}
      onClose={() => setSourcesOpen(false)} />}
  </>;
}
