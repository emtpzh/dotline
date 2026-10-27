import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, ArrowUpRight, ChevronDown, FolderOpen, GitBranch, Layers, Loader2, MoreHorizontal, Plug, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { scanSessions, loadLastScan, disabledRoots, setRootDisabled, runnerLabel, type SessionCard } from '../lib/atlas/discover';
import { diffAgainstWatermark, markSeen, markAllSeen, changeKeyOf, type CardChange } from '../lib/atlas/watermark';
import type { CanonicalResult } from '../lib/atlas/canonical';
import { useProjects, subscribedSessionIds, mainSubscription } from '../store/projects';
import { useT, useI18n, t as ti, fmt } from '../i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from './ui/command';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { InputGroup, InputGroupAddon, InputGroupInput } from './ui/input-group';
import { ButtonGroup, ButtonGroupSeparator } from './ui/button-group';
import { readSession } from '../lib/sessions/read';
import { toast } from '../lib/ui-store';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Kbd, KbdGroup } from './ui/kbd';

// Session discovery is a list of sources. Canvas management lives in ProjectSwitcher.

const dateLabel = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** "3 minutes ago" within a week, the date after that; `now` 0 = not known yet. */
function whenLabel(ms: number, now: number, lang: string): string {
  const age = now - ms;
  if (!now || age > 7 * 864e5) return dateLabel(ms);
  const rtf = new Intl.RelativeTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', { numeric: 'auto', style: 'short' });
  if (age < 60e3) return rtf.format(0, 'second');
  if (age < 3600e3) return rtf.format(-Math.floor(age / 60e3), 'minute');
  if (age < 864e5) return rtf.format(-Math.floor(age / 3600e3), 'hour');
  return rtf.format(-Math.floor(age / 864e5), 'day');
}
const sizeLabel = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const folderName = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? cwd;

type SortKey = 'time' | 'name' | 'size' | 'runner';
const SORT_LABEL = { time: 'atlas.sortTime', name: 'atlas.sortName', size: 'atlas.sortSize', runner: 'atlas.sortRunner' } as const;

const ALL = '__all__';
const PAGE = 150;

// The view the atlas reopens on: folder, order and source filters are the
// user's standing choice, kept in this browser only. The text query and
// the one-off toggles start clean each time.
const PREFS_KEY = 'thoughtdag.atlas.view';
interface ViewPrefs { folder: string; sortKey: SortKey; runnerOff: string[]; showSubagents: boolean }
function loadPrefs(): Partial<ViewPrefs> {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<ViewPrefs>; } catch { return {}; }
}
function savePrefs(p: ViewPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage off: the view just won't be remembered */ }
}

type Snap = Map<string, { mtime: number; size: number }>;
const snapOf = (cards: SessionCard[]): Snap => new Map(cards.map((c) => [changeKeyOf(c), { mtime: c.mtime, size: c.size }]));

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

type RowAct = 'pick' | 'open' | 'app' | 'terminal' | 'recast';

interface RowProps {
  card: SessionCard;
  title: string;
  when: string;
  fork?: string;
  home: { name: string; current: boolean } | null;
  change?: CardChange;
  isPicked: boolean;
  canPick: boolean;
  disabled: boolean;
  loading: boolean;
  focused: boolean;
  appName?: string;
  canRecast: boolean;
  onAct: (act: RowAct, card: SessionCard) => void;
}

// One session. A click on the row only picks it; a session already on a
// canvas opens through its canvas chip (or Enter), so no stray click ever
// moves the user to another canvas.
const AtlasRow = memo(function AtlasRow({ card, title, when, fork, home, change, isPicked, canPick, disabled, loading, focused, appName, canRecast, onAct }: RowProps) {
  const t = useT();
  return (
    <div
      role="listitem"
      tabIndex={-1}
      className={`group/row flex items-center gap-3 border-b border-border px-3 py-2 outline-none last:border-b-0 focus-visible:bg-muted [content-visibility:auto] [contain-intrinsic-size:auto_52px] ${canPick ? 'cursor-pointer hover:bg-muted/60' : ''} ${isPicked ? 'bg-primary/5' : ''} ${focused ? 'bg-accent' : ''}`}
      onClick={() => { if (!disabled && canPick) onAct('pick', card); }}
      onDoubleClick={() => { if (!disabled && home) onAct('open', card); }}
      data-atlas-row={changeKeyOf(card)}
      data-atlas-session={card.sessionId}
      data-atlas-pick={isPicked ? 'on' : 'off'}>
      <span className="flex" onClick={e => e.stopPropagation()}>
        <Checkbox
          aria-label={fmt(t('atlas.selectSession'), { name: title })}
          disabled={disabled || !canPick}
          checked={isPicked}
          onCheckedChange={() => onAct('pick', card)} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {change && <span
            className={`size-1.5 shrink-0 rounded-full ${change.kind === 'new' ? 'bg-primary' : 'bg-primary/50'}`}
            title={change.kind === 'new' ? t('atlas.badgeNew') : `+${sizeLabel(change.deltaSize)}`}
            data-atlas-badge={change.kind === 'new' ? 'new' : 'updated'} />}
          <span className={`truncate text-sm ${change ? 'font-medium text-foreground' : 'text-foreground'}`}>{title}</span>
          {fork && <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-label={fmt(t('atlas.forkedFrom'), { id: fork })} data-atlas-fork />}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted-foreground" title={card.cwd ?? undefined}>
          <span className="shrink-0">{runnerLabel(card.runner)}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{sizeLabel(card.size)}</span>
          {change?.kind === 'updated' && <span className="shrink-0 text-primary">+{sizeLabel(change.deltaSize)}</span>}
          {change?.kind === 'new' && <span className="shrink-0 text-primary">{t('atlas.badgeNew')}</span>}
        </div>
      </div>
      {home && (
        <Button
          variant="secondary"
          size="xs"
          className="max-w-44 min-w-0"
          disabled={disabled}
          title={fmt(t('atlas.openOn'), { name: home.name })}
          onClick={e => { e.stopPropagation(); onAct('open', card); }}
          data-atlas-open
          data-atlas-badge="canvas">
          {loading ? <Loader2 className="animate-spin" /> : <ArrowUpRight />}
          <span className="truncate">{home.current ? t('atlas.onCurrent') : home.name}</span>
        </Button>
      )}
      <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:inline" title={dateLabel(card.mtime)}>{when}</span>
      <span className="flex" onClick={e => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger disabled={disabled} render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground opacity-60 group-hover/row:opacity-100 data-popup-open:opacity-100" aria-label={t('atlas.more')} />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {appName && <DropdownMenuItem onClick={() => onAct('app', card)}>{fmt(t('atlas.openApp'), { name: appName })}</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => onAct('terminal', card)}>{t('atlas.openTerminal')}</DropdownMenuItem>
            {canRecast && <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => onAct('recast', card)}>{t('atlas.recast')}</DropdownMenuItem>
            </>}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  );
});

/** Asks for the next page of rows once the end of the list scrolls near. */
function MoreRows({ onMore }: { onMore: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) onMore(); }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [onMore]);
  return <div ref={ref} className="h-px" aria-hidden />;
}

export default function SessionAtlas({ onClose, onSwitched, focusSessionId }: { onClose: () => void; onSwitched: () => void; focusSessionId?: string }) {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const projects = useProjects((s) => s.projects);
  const activeId = useProjects(s => s.activeId);
  const isDesktop = !!window.desktopSessions;
  const [prefs] = useState(loadPrefs);
  const [cards, setCards] = useState<SessionCard[] | null>(null);
  const [roots, setRoots] = useState<SessionRoot[]>([]);
  const [scanning, setScanning] = useState(false);
  const [now, setNow] = useState(0);
  // All directories are visible until the user narrows the list.
  const [folder, setFolder] = useState<string>(prefs.folder ?? ALL);
  const [busy, setBusy] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  // Tier 2 enrichment: the thread store's REAL names and fork lineage.
  // Purely additive — absent codex CLI, the maps stay empty and every
  // card keeps its Tier 1 identity (first user prompt).
  const [threadNames, setThreadNames] = useState<Map<string, string>>(new Map());
  const [threadForks, setThreadForks] = useState<Map<string, string>>(new Map());
  // the picks: sessions on their way onto a canvas, by file key — the card
  // itself is looked up at use, so a rescan in between never hands the
  // import (or the watermark) a stale size. Only the footer's button
  // writes — nothing lands on a canvas by a single stray click.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [runnerOff, setRunnerOff] = useState<Set<string>>(() => new Set(prefs.runnerOff ?? []));
  const [sortKey, setSortKey] = useState<SortKey>(prefs.sortKey && prefs.sortKey in SORT_LABEL ? prefs.sortKey : 'time');
  const [only, setOnly] = useState<string[]>([]);
  const onlyUnlinked = only.includes('unlinked');
  const onlyChanged = only.includes('changed');
  const [showSubagents, setShowSubagents] = useState(!!prefs.showSubagents);
  const [changes, setChanges] = useState<Map<string, CardChange>>(new Map());
  // The order the list was last sorted in. A live rescan updates every
  // card's numbers but sorts by these, so rows never move under the
  // pointer; the user re-sorts when they choose.
  const [snap, setSnap] = useState<Snap>(new Map());
  const [targets, setTargets] = useState<Awaited<ReturnType<NonNullable<Window['desktopSessions']>['openTargets']>> | null>(null);
  useEffect(() => { void window.desktopSessions?.openTargets().then(setTargets).catch(() => { }); }, []);
  const appHosts = useMemo(() => new Map((targets?.apps ?? []).map((a) => [a.runner, a.name])), [targets]);
  useEffect(() => savePrefs({ folder, sortKey, runnerOff: [...runnerOff], showSubagents }), [folder, sortKey, runnerOff, showSubagents]);

  // one scan at a time; a request that arrives mid-scan runs once after it
  const scanningRef = useRef(false);
  const pendingRef = useRef<'user' | 'live' | null>(null);
  const focusedRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = async (mode: 'initial' | 'user' | 'live') => {
    if (scanningRef.current) {
      if (pendingRef.current !== 'user') pendingRef.current = mode === 'live' ? 'live' : 'user';
      return;
    }
    scanningRef.current = true;
    setScanning(true);
    try {
      setRoots(await window.desktopSessions?.roots().catch(() => []) ?? []);
      const { cards: scanned, listed } = await scanSessions();
      setCards(scanned);
      setNow(Date.now());
      setChanges(diffAgainstWatermark(scanned, listed));
      if (mode !== 'live') setSnap(snapOf(scanned));
      // Tier 2 enrichment, fire-and-forget: real thread names + fork
      // lineage from the codex app-server; silence on any failure
      void window.desktopSessions?.codexThreads?.().then((threads) => {
        if (!threads) return;
        setThreadNames(new Map(threads.filter((t) => t.name && t.sessionId).map((t) => [t.sessionId, t.name!])));
        setThreadForks(new Map(threads.filter((t) => t.forkedFromId && t.sessionId).map((t) => [t.sessionId, t.forkedFromId!])));
      }).catch(() => { });
      // arrival from a mirror canvas: land ONCE on the folder that holds the
      // session this canvas mirrors — later rescans leave the user's choice be
      const hit = !focusedRef.current && focusSessionId ? scanned.find((c) => c.sessionId === focusSessionId) : undefined;
      if (hit) { focusedRef.current = true; setFolder(hit.cwd ?? ''); }
      // a remembered folder with no session left in it is gone, not filtered
      else setFolder((f) => (f === ALL || scanned.some((c) => (c.cwd ?? '') === f) ? f : ALL));
      setPicked((prev) => {
        const keys = new Set(scanned.map(changeKeyOf));
        return [...prev].every((k) => keys.has(k)) ? prev : new Set([...prev].filter((k) => keys.has(k)));
      });
    } catch (err) {
      toast('error', fmt(ti('atlas.parseFailed'), { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      scanningRef.current = false;
      setScanning(false);
      const next = pendingRef.current;
      pendingRef.current = null;
      if (next) void refresh(next);
    }
  };
  // the last scan paints at once; one fresh scan on mount replaces it.
  // refresh is recreated per render and must not re-run the scan
  useEffect(() => {
    let live = true;
    if (isDesktop) void loadLastScan().then((last) => {
      if (!live || !last?.length) return;
      setCards((c) => c ?? last);
      setNow((n) => n || Date.now());
      setSnap((s) => (s.size ? s : snapOf(last)));
    });
    void refresh('initial');
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ...and the twin badge's session scrolls into view once the scan lands
  const landed = cards !== null && !scanning;
  useEffect(() => {
    if (landed && focusSessionId) document.querySelector(`[data-atlas-session="${CSS.escape(focusSessionId)}"]`)?.scrollIntoView({ block: 'center' });
  }, [landed, focusSessionId]);

  // live freshness: the watcher (live-mirror) broadcasts store changes;
  // an open atlas rescans (only changed files are re-read), throttled
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChanged = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; void refresh('live'); }, 1500);
    };
    window.addEventListener('td:sessions-changed', onChanged);
    return () => { clearTimeout(timer); window.removeEventListener('td:sessions-changed', onChanged); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // which canvas (if any) subscribes to a session — main, chapter or branch alike
  const homeOf = useMemo(() => {
    const m = new Map<string, (typeof projects)[number]>();
    for (const p of projects) for (const id of subscribedSessionIds(p)) if (!m.has(id)) m.set(id, p);
    return m;
  }, [projects]);
  const mirrored = useMemo(() => new Set(projects.map((p) => mainSubscription(p)?.sessionId).filter(Boolean)), [projects]);
  const cardByKey = useMemo(() => new Map((cards ?? []).map((c) => [changeKeyOf(c), c])), [cards]);

  // ONE identity per card — display, search and sort must agree: the
  // REAL thread name when the store lends one, the parsed title
  // otherwise. Search or sort on a different string than the one on
  // screen reads as a broken atlas.
  const displayTitle = useCallback((c: SessionCard): string => threadNames.get(c.sessionId) ?? c.title, [threadNames]);

  // filters shape the whole atlas: folder counts follow them too
  const visible = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return (cards ?? []).filter((c) =>
      !runnerOff.has(c.runner)
      && (showSubagents || !c.subagent)
      && (!onlyChanged || changes.has(changeKeyOf(c)))
      && (!onlyUnlinked || !homeOf.has(c.sessionId))
      && (!q || `${displayTitle(c)} ${c.cwd ?? ''}`.toLowerCase().includes(q)));
  }, [cards, runnerOff, deferredQuery, onlyChanged, onlyUnlinked, homeOf, changes, showSubagents, displayTitle]);

  const sorter = useMemo(() => {
    const at = (c: SessionCard) => snap.get(changeKeyOf(c)) ?? c;
    const by: Record<SortKey, (a: SessionCard, b: SessionCard) => number> = {
      time: (a, b) => at(b).mtime - at(a).mtime,
      name: (a, b) => displayTitle(a).localeCompare(displayTitle(b)),
      size: (a, b) => at(b).size - at(a).size,
      runner: (a, b) => a.runner.localeCompare(b.runner) || at(b).mtime - at(a).mtime,
    };
    return by[sortKey];
  }, [snap, sortKey, displayTitle]);

  // the folder rail, in sorted-order time (it holds still with the list);
  // the chosen folder stays listed even when the filters empty it
  const folders = useMemo(() => {
    const m = new Map<string, { key: string; name: string; path: string | null; count: number; latest: number }>();
    for (const c of visible) {
      const key = c.cwd ?? '';
      const at = snap.get(changeKeyOf(c))?.mtime ?? c.mtime;
      const g = m.get(key);
      if (g) { g.count++; g.latest = Math.max(g.latest, at); } else m.set(key, { key, name: c.cwd ? folderName(c.cwd) : '', path: c.cwd, count: 1, latest: at });
    }
    if (folder !== ALL && !m.has(folder)) m.set(folder, { key: folder, name: folder ? folderName(folder) : '', path: folder || null, count: 0, latest: 0 });
    return [...m.values()].sort((a, b) => (!a.path !== !b.path ? (a.path ? -1 : 1) : b.latest - a.latest));
  }, [visible, snap, folder]);

  const shown = useMemo(() => visible.filter((c) => folder === ALL || (c.cwd ?? '') === folder).sort(sorter), [visible, folder, sorter]);
  // across every folder the list reads by project: one heading per
  // folder, so a row never has to repeat its path
  const sections = useMemo(() => {
    if (folder !== ALL) return [{ key: folder, name: null as string | null, path: null as string | null, cards: shown }];
    const by = new Map<string, SessionCard[]>();
    for (const c of shown) { const k = c.cwd ?? ''; by.set(k, [...(by.get(k) ?? []), c]); }
    return folders.filter((f) => by.has(f.key)).map((f) => ({ key: f.key, name: f.name || t('atlas.unfiled'), path: f.path, cards: by.get(f.key)! }));
  }, [folder, shown, folders, t]);

  const runners = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards ?? []) m.set(c.runner, (m.get(c.runner) ?? 0) + 1);
    return [...m].sort((a, b) => a[0].localeCompare(b[0]));
  }, [cards]);
  const rootCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards ?? []) m.set(c.rootKey, (m.get(c.rootKey) ?? 0) + 1);
    return m;
  }, [cards]);
  // cards whose numbers moved since the list was sorted: the re-sort offer
  const drift = useMemo(() => (sortKey === 'name' ? 0 : (cards ?? []).filter((c) => {
    const s = snap.get(changeKeyOf(c));
    return !s || s.mtime !== c.mtime || s.size !== c.size;
  }).length), [cards, snap, sortKey]);

  const pickable = shown.filter(c => !!c.sessionId && !homeOf.has(c.sessionId));
  const allPicked = pickable.length > 0 && pickable.every(c => picked.has(changeKeyOf(c)));
  const somePicked = pickable.some(c => picked.has(changeKeyOf(c)));
  const shownKeys = useMemo(() => new Set(shown.map(changeKeyOf)), [shown]);
  const pickedHidden = [...picked].filter((k) => !shownKeys.has(k)).length;
  const filtered = !!query.trim() || only.length > 0 || runnerOff.size > 0 || folder !== ALL;
  const destinations = projects
    .filter(p => !p.archived && p.kind !== 'paradigm')
    .sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : b.updatedAt - a.updatedAt));

  // rows render a page at a time; any change of view starts from the top page
  const viewKey = `${folder}|${deferredQuery}|${only.join()}|${[...runnerOff].join()}|${showSubagents}|${sortKey}`;
  const [more, setMore] = useState({ key: '', n: PAGE });
  const limit = more.key === viewKey ? more.n : PAGE;
  const onMore = useCallback(() => setMore((m) => ({ key: viewKey, n: (m.key === viewKey ? m.n : PAGE) + PAGE })), [viewKey]);

  const clearFilters = () => { setQuery(''); setOnly([]); setRunnerOff(new Set()); setFolder(ALL); };

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
      // the cards as the latest scan has them, never as they were when picked
      const list = [...picked].map((k) => cardByKey.get(k)).filter((c): c is SessionCard => !!c && !homeOf.has(c.sessionId));
      if (!list.length) throw new Error(ti('handoff.notASession'));
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
      setPicked(new Set());
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

  // rows are memoized; they reach the latest handlers through one stable door
  const actRef = useRef<(act: RowAct, card: SessionCard) => void>(() => { });
  useLayoutEffect(() => {
    actRef.current = (act, card) => {
      if (act === 'pick') setPicked((prev) => { const next = new Set(prev); const k = changeKeyOf(card); if (next.has(k)) next.delete(k); else next.add(k); return next; });
      else if (act === 'open') void openLinked(card);
      else if (act === 'recast') void recast(card);
      else void openInCli(card, act);
    };
  });
  const onAct = useCallback((act: RowAct, card: SessionCard) => actRef.current(act, card), []);

  // ↑↓ walk the rows, Space picks, Enter opens a linked session (or picks)
  const onListKey = (e: React.KeyboardEvent) => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-atlas-row]') ?? [])];
    const at = rows.findIndex((r) => r === document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      next?.focus();
      next?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const card = at >= 0 ? cardByKey.get(rows[at].dataset.atlasRow ?? '') : undefined;
    if (!card || busy) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (e.key === 'Enter' && homeOf.has(card.sessionId)) void openLinked(card);
      else if (!homeOf.has(card.sessionId)) onAct('pick', card);
    }
  };

  let budget = limit;
  const sectionsShown = sections.map((s) => {
    const take = s.cards.slice(0, Math.max(0, budget));
    budget -= take.length;
    return { ...s, rows: take };
  }).filter((s) => s.rows.length);

  const folderButton = (key: string, name: string, count: number, path?: string | null) => (
    <Button
      key={key}
      variant="ghost"
      size="sm"
      className={`w-full justify-start gap-2 font-normal ${folder === key ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`}
      aria-current={folder === key ? 'true' : undefined}
      title={path ?? undefined}
      onClick={() => setFolder(key)}
      data-atlas-folder-nav={key === ALL ? 'all' : name}>
      {key === ALL ? <Layers /> : <FolderOpen />}
      <span className="min-w-0 flex-1 truncate text-left">{name}</span>
      <span className="text-xs tabular-nums">{count}</span>
    </Button>
  );

  return <>
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent
        size="xl"
        className="flex h-[min(88dvh,720px)] flex-col gap-0 overflow-hidden p-0"
        data-session-atlas
        showCloseButton={!busy}
        onKeyDown={e => {
          const el = e.target as HTMLElement;
          if (e.key === '/' && !el.closest('input, textarea, [role="menu"], [role="listbox"]')) { e.preventDefault(); searchRef.current?.focus(); }
        }}>
        <DialogHeader className="flex-row items-start gap-3 border-b border-border py-3 pr-12 pl-4">
          <div className="min-w-0 flex-1">
            <DialogTitle>{t('atlas.title')}</DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">{t('atlas.subtitle')}</DialogDescription>
          </div>
          {isDesktop && <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setSourcesOpen(true)} data-atlas-sources>
              <Plug />
              <span className="hidden sm:inline">{t('atlas.sourcesTitle')}</span>
            </Button>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" disabled={scanning || !!busy} aria-label={t('atlas.refresh')} title={t('atlas.refresh')} onClick={() => void refresh('user')}>
              <RefreshCw className={scanning ? 'animate-spin' : ''} />
            </Button>
          </div>}
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label={t('atlas.folders')} className="hidden min-h-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-muted/30 p-2 sm:flex">
            {folderButton(ALL, t('atlas.foldersAll'), visible.length)}
            <div className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">{t('atlas.folders')}</div>
            {folders.map((g) => folderButton(g.key, g.name || t('atlas.unfiled'), g.count, g.path))}
          </nav>

          <div className="flex min-h-0 flex-col">
            <div className="flex flex-col gap-2 border-b border-border p-3">
              <div className="flex items-center gap-2">
                <InputGroup className="min-w-0 flex-1">
                  <InputGroupInput
                    ref={searchRef}
                    aria-label={t('atlas.filterTitle')}
                    placeholder={t('atlas.filterTitle')}
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); listRef.current?.querySelector<HTMLElement>('[data-atlas-row]')?.focus(); } }}
                    data-atlas-filter />
                  <InputGroupAddon><Search /></InputGroupAddon>
                </InputGroup>
                <Select value={folder} onValueChange={v => v !== null && setFolder(v)}>
                  <SelectTrigger aria-label={t('atlas.folders')} className="max-w-36 sm:hidden">
                    <FolderOpen className="text-muted-foreground" />
                    <SelectValue>{folder === ALL ? t('atlas.foldersAll') : folder ? folderName(folder) : t('atlas.unfiled')}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{t('atlas.foldersAll')}</SelectItem>
                    {folders.map(g => <SelectItem key={g.key} value={g.key}>
                      <span className="flex-1 truncate">{g.name || t('atlas.unfiled')}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{g.count}</span>
                    </SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={sortKey} onValueChange={v => { if (!v) return; setSortKey(v as SortKey); if (cards) setSnap(snapOf(cards)); }}>
                  <SelectTrigger aria-label={t('atlas.sortLabel')}>
                    <ArrowDownUp className="text-muted-foreground" />
                    <SelectValue>{t(SORT_LABEL[sortKey])}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(SORT_LABEL) as SortKey[]).map(k => <SelectItem key={k} value={k}>{fmt(t('atlas.sortBy'), { key: t(SORT_LABEL[k]) })}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <ToggleGroup
                  multiple
                  variant="outline"
                  size="sm"
                  value={[...only, ...(showSubagents ? ['sub'] : [])]}
                  onValueChange={v => { setOnly(v.filter((x) => x !== 'sub')); setShowSubagents(v.includes('sub')); }}>
                  <ToggleGroupItem value="unlinked">{t('atlas.unlinked')}</ToggleGroupItem>
                  <ToggleGroupItem value="changed" data-atlas-only-changed>
                    {t('atlas.onlyChanged')}
                    {changes.size > 0 && <span className="text-primary tabular-nums">{changes.size}</span>}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="sub" data-atlas-show-sub>{t('atlas.showSub')}</ToggleGroupItem>
                </ToggleGroup>
                {runners.length > 1 && <>
                  <span className="mx-1 h-4 w-px bg-border" aria-hidden />
                  <ToggleGroup
                    multiple
                    variant="outline"
                    size="sm"
                    aria-label={t('atlas.filterSources')}
                    value={runners.map(([r]) => r).filter((r) => !runnerOff.has(r))}
                    onValueChange={v => setRunnerOff(new Set(runners.map(([r]) => r).filter((r) => !v.includes(r))))}>
                    {runners.map(([r, n]) => <ToggleGroupItem key={r} value={r} data-atlas-runner={r}>
                      {runnerLabel(r)}
                      <span className="text-muted-foreground tabular-nums">{n}</span>
                    </ToggleGroupItem>)}
                  </ToggleGroup>
                </>}
              </div>
            </div>

            <div className="flex items-center gap-3 border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
              <Checkbox
                aria-label={t('atlas.selectAll')}
                title={t('atlas.selectAll')}
                disabled={!!busy || !pickable.length}
                checked={allPicked}
                indeterminate={somePicked && !allPicked}
                onCheckedChange={checked => setPicked(prev => { const next = new Set(prev); for (const c of pickable) { if (checked) next.add(changeKeyOf(c)); else next.delete(changeKeyOf(c)); } return next; })} />
              <span className="flex-1 tabular-nums">{cards ? fmt(t('atlas.sessions'), { n: shown.length }) : ''}</span>
              {drift > 0 && <Button variant="outline" size="xs" onClick={() => cards && setSnap(snapOf(cards))} data-atlas-resort>
                <ArrowDownUp />
                {fmt(t('atlas.resort'), { n: drift })}
              </Button>}
              {changes.size > 0 && <Button variant="ghost" size="xs" onClick={() => { markAllSeen(cards ?? []); setChanges(new Map()); }} data-atlas-mark-all>
                {t('atlas.markAllSeen')}
              </Button>}
            </div>
            <div ref={listRef} role="list" aria-label={t('atlas.title')} className="min-h-0 flex-1 overflow-y-auto" onKeyDown={onListKey}>
              {cards === null && (scanning || isDesktop)
                ? Array.from({ length: 7 }, (_, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-border px-3 py-3 last:border-b-0">
                    <div className="size-4 rounded-[4px] bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 w-2/3 animate-pulse rounded-md bg-muted" />
                      <div className="h-2.5 w-1/3 animate-pulse rounded-md bg-muted" />
                    </div>
                  </div>
                ))
                : shown.length === 0
                  ? <div className="flex flex-col items-center gap-3 p-10 text-center text-sm text-muted-foreground">
                    <p>{!isDesktop ? t('atlas.webNoScan') : cards?.length ? t('atlas.filteredOut') : t('atlas.empty')}</p>
                    {isDesktop && !!cards?.length && filtered && <Button variant="outline" size="sm" onClick={clearFilters} data-atlas-clear-filters>{t('atlas.clearFilters')}</Button>}
                  </div>
                  : <>
                    {sectionsShown.map(s => <section key={s.key} data-atlas-folder={s.name ?? undefined}>
                      {s.name && <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur-sm" title={s.path ?? undefined}>
                        <FolderOpen className="size-3.5" />
                        <span className="truncate">{s.name}</span>
                        <span className="tabular-nums">{s.cards.length}</span>
                      </div>}
                      {s.rows.map((card) => {
                        const home = homeOf.get(card.sessionId);
                        return <AtlasRow
                          key={changeKeyOf(card)}
                          card={card}
                          title={displayTitle(card)}
                          when={whenLabel(card.mtime, now, lang)}
                          fork={threadForks.get(card.sessionId)}
                          home={home ? (home.id === activeId ? { name: home.name, current: true } : { name: home.name, current: false }) : null}
                          change={changes.get(changeKeyOf(card))}
                          isPicked={picked.has(changeKeyOf(card))}
                          canPick={!home && !!card.sessionId}
                          disabled={!!busy}
                          loading={busy === card.rel}
                          focused={card.sessionId === focusSessionId}
                          appName={appHosts.get(card.runner)}
                          canRecast={mirrored.has(card.sessionId)}
                          onAct={onAct} />;
                      })}
                    </section>)}
                    {shown.length > limit && <MoreRows onMore={onMore} />}
                  </>}
            </div>
          </div>
        </div>

        <DialogFooter className="m-0 items-center gap-2 rounded-b-xl border-t border-border p-3 sm:justify-between">
          {picked.size > 0
            ? <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">{fmt(t('atlas.mergeSelected'), { n: picked.size })}</span>
              {pickedHidden > 0 && <span className="truncate text-xs">{fmt(t('atlas.pickedHidden'), { n: pickedHidden })}</span>}
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setPicked(new Set())}>{t('atlas.clearPick')}</Button>
            </div>
            : <div className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
              <KbdGroup><Kbd>↑</Kbd><Kbd>↓</Kbd></KbdGroup>{t('atlas.keyMove')}
              <Kbd className="ml-2">Space</Kbd>{t('atlas.keyPick')}
              <Kbd className="ml-2">Enter</Kbd>{t('atlas.keyOpen')}
              <Kbd className="ml-2">/</Kbd>{t('atlas.keySearch')}
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
      onChanged={() => void refresh('user')}
      onClose={() => setSourcesOpen(false)} />}
  </>;
}
