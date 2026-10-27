import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Loader2, Lock, MoreHorizontal, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { ScrollArea } from './ui/scroll-area';
import { Checkbox } from './ui/checkbox';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useT, t as ti, fmt } from '../i18n';
import { toast } from '../lib/ui-store';
import { ms } from '../lib/motion';
import { FRAME_COLORS } from '../lib/constants';
import { outcomeOf, type Group, type Thread } from '../lib/organize/threads';
import { proposeGroups, type Dimension } from '../lib/organize/propose';
import { loadThreads, rebuildCanvases } from '../store/organize';
import type { ProjectMeta } from '../store/projects';

// The canvas organizer: every conversation on every canvas, regrouped in a
// preview by topic, goal or time; confirming rebuilds the canvases that way.
// A proposal is a draft the user edits — groups can be renamed, left out,
// and conversations moved between them — and the side panel says what the
// rebuild will do before it does it. The group colors exist only here —
// they show how mixed a canvas is, and nothing about them is written anywhere.

type View = 'now' | Dimension;
type Proposal = { groups: Group[] } | { error: string };

const PALETTE = ['violet', 'sky', 'green', 'amber', 'rose', 'gray'] as const;
const dotOf = (i: number) => FRAME_COLORS[PALETTE[i % PALETTE.length]].dot;
/** a column's key for the conversations that stay where they are */
const STAY = '__stay__';
/** cards a column shows before it folds the rest */
const FOLD = 6;
const DIMS: Dimension[] = ['topic', 'goal', 'time'];
const DIM_LABEL = { topic: 'organizer.dimTopic', goal: 'organizer.dimGoal', time: 'organizer.dimTime' } as const;

interface Column {
  key: string;
  name: string;
  threadIds: string[];
  /** a proposed group (editable), the stay column, or a canvas as it is */
  kind: 'group' | 'stay' | 'canvas';
  index?: number;
  off?: boolean;
  /** where an accepted group lands: an existing canvas by that name, or a new one */
  lands?: 'new' | 'kept';
  reason?: string;
}

export default function CanvasOrganizer({ onClose, onSwitched }: { onClose: () => void; onSwitched: () => void }) {
  const t = useT();
  const [data, setData] = useState<{ canvases: ProjectMeta[]; threads: Thread[] } | null>(null);
  const [view, setView] = useState<View>('now');
  const [proposals, setProposals] = useState<Partial<Record<Dimension, Proposal>>>({});
  // which groups are ticked, per grouping: switching away and back keeps the choice
  const [acceptedBy, setAcceptedBy] = useState<Partial<Record<Dimension, Set<string>>>>({});
  // which grouping colors the cards; the first one seen, until the user picks
  const [colorBy, setColorBy] = useState<Dimension | null>(null);
  const [applying, setApplying] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const viewRef = useRef<View>('now');
  // one request per grouping at a time: going away and back while it runs
  // waits for it, never starts a second one that would land over the first
  const asking = useRef(new Set<Dimension>());

  useEffect(() => {
    let live = true;
    void loadThreads().then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, []);

  const threadById = useMemo(() => new Map((data?.threads ?? []).map((th) => [th.id, th])), [data]);
  const nameOf = useMemo(() => new Map((data?.canvases ?? []).map((c) => [c.id, c.name])), [data]);
  const proposal = view === 'now' ? undefined : proposals[view];
  const groups = proposal && 'groups' in proposal ? proposal.groups : null;
  const accepted = useMemo(() => (view === 'now' ? new Set<string>() : acceptedBy[view] ?? new Set<string>()), [view, acceptedBy]);
  const setAccepted = (fn: (s: Set<string>) => Set<string>) => {
    if (view !== 'now') setAcceptedBy((a) => ({ ...a, [view]: fn(a[view] ?? new Set()) }));
  };
  const editGroups = (fn: (gs: Group[]) => Group[]) => {
    if (view === 'now') return;
    setProposals((p) => {
      const cur = p[view];
      return cur && 'groups' in cur ? { ...p, [view]: { groups: fn(cur.groups) } } : p;
    });
  };

  const ask = async (dim: Dimension, fresh: boolean) => {
    if (!data || asking.current.has(dim)) return;
    asking.current.add(dim);
    setProposals((p) => { const rest = { ...p }; delete rest[dim]; return rest; });
    try {
      const gs = await proposeGroups(dim, data.threads, data.canvases, { fresh });
      setProposals((p) => ({ ...p, [dim]: { groups: gs } }));
      setAcceptedBy((a) => ({ ...a, [dim]: new Set(gs.map((g) => g.key)) }));
      if (viewRef.current === dim) setColorBy((c) => (fresh || !c ? dim : c));
    } catch (e) {
      setProposals((p) => ({ ...p, [dim]: { error: e instanceof Error ? e.message : String(e) } }));
    } finally {
      asking.current.delete(dim);
    }
  };

  const choose = (next: View) => {
    setView(next);
    viewRef.current = next;
    setRenaming(null);
    if (next === 'now' || !data) return;
    const known = proposals[next];
    if (known && 'groups' in known) { setColorBy((c) => c ?? next); return; }
    void ask(next, false);
  };

  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    const p = colorBy && proposals[colorBy];
    if (p && 'groups' in p) p.groups.forEach((g, i) => g.threadIds.forEach((id) => m.set(id, dotOf(i))));
    return m;
  }, [colorBy, proposals]);

  const live = useMemo(() => (groups ?? []).filter((g) => accepted.has(g.key) && g.threadIds.length), [groups, accepted]);
  const outcome = useMemo(
    () => (groups && data && live.length ? outcomeOf(data.canvases, data.threads, live) : null),
    [groups, live, data],
  );
  // what the rebuild does, counted the way the user will see it afterwards
  const effect = useMemo(() => {
    if (!outcome || !data) return null;
    let moved = 0;
    for (const c of outcome.canvases) for (const id of c.threadIds) if (threadById.get(id)?.canvasId !== c.id) moved++;
    return {
      made: outcome.canvases.filter((c) => !c.id).length,
      kept: outcome.canvases.filter((c) => c.id).length,
      moved,
      removed: outcome.removed.map((id) => nameOf.get(id) ?? id),
    };
  }, [outcome, data, threadById, nameOf]);

  const proposedIds = new Set(groups?.flatMap((g) => g.threadIds) ?? []);
  const staying = groups ? (data?.threads ?? []).filter((th) => !proposedIds.has(th.id)).map((th) => th.id) : [];
  const fixed = data?.threads.filter((th) => th.fixed).length ?? 0;

  const columns: Column[] = groups
    ? [
      ...groups.map((g, i): Column => ({
        key: g.key, name: g.name, threadIds: g.threadIds, kind: 'group', index: i, off: !accepted.has(g.key), reason: g.reason,
        lands: accepted.has(g.key) && g.threadIds.length ? (data?.canvases.some((c) => c.name === g.name) ? 'kept' : 'new') : undefined,
      })),
      ...(staying.length ? [{ key: STAY, name: t('organizer.stayColumn'), threadIds: staying, kind: 'stay' as const }] : []),
    ]
    : (data?.canvases ?? []).map((c) => ({ key: c.id, name: c.name, threadIds: data!.threads.filter((th) => th.canvasId === c.id).map((th) => th.id), kind: 'canvas' }));

  const moveThread = (id: string, to: string) => {
    if (threadById.get(id)?.fixed) return;
    editGroups((gs) => gs.map((g) => {
      const rest = g.threadIds.filter((x) => x !== id);
      return { ...g, threadIds: g.key === to ? [...rest, id] : rest };
    }));
  };
  const rename = (key: string, name: string) => {
    const clean = name.trim();
    setRenaming(null);
    if (!clean) return;
    editGroups((gs) => gs.map((g) => (g.key === key ? { ...g, name: clean } : g)));
  };

  // FLIP: a card glides from where it was to the column it lands in.
  // Positions are taken relative to the board, so a scroll in between
  // does not read as motion.
  const boardRef = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const lastRects = useRef(new Map<string, { x: number; y: number }>());
  const layoutKey = columns.map((c) => `${c.key}:${c.threadIds.join(',')}`).join('|');
  useLayoutEffect(() => {
    const origin = boardRef.current?.getBoundingClientRect();
    if (!origin) return;
    const next = new Map<string, { x: number; y: number }>();
    for (const [id, el] of cards.current) {
      el.getAnimations().forEach((a) => a.cancel());
      const r = el.getBoundingClientRect();
      next.set(id, { x: r.left - origin.left, y: r.top - origin.top });
    }
    const duration = ms(520);
    if (duration) for (const [id, el] of cards.current) {
      const from = lastRects.current.get(id), to = next.get(id)!;
      if (!from) continue;
      const dx = from.x - to.x, dy = from.y - to.y;
      if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    }
    lastRects.current = next;
  }, [layoutKey]);

  const apply = async () => {
    if (!outcome || !data) return;
    setApplying(true);
    try {
      const undo = await rebuildCanvases(outcome, data.threads);
      onSwitched();
      onClose();
      toast('success', fmt(ti('organizer.done'), { n: outcome.canvases.length }), 10000, {
        label: ti('common.undo'),
        run: () => void undo().then(onSwitched).catch((e) => toast('error', fmt(ti('organizer.failed'), { msg: e instanceof Error ? e.message : String(e) }))),
      });
    } catch (e) {
      setApplying(false);
      toast('error', fmt(ti('organizer.failed'), { msg: e instanceof Error ? e.message : String(e) }));
    }
  };

  const ready = DIMS.filter((d) => { const p = proposals[d]; return !!p && 'groups' in p; });
  const editable = !!groups && !applying;

  const card = (id: string, col: Column) => {
    const th = threadById.get(id);
    if (!th) return null;
    const from = nameOf.get(th.canvasId) ?? '';
    const moving = col.kind === 'group' && !col.off && from !== col.name;
    const canMove = editable && !th.fixed;
    return (
      <div
        key={id}
        ref={(el) => { if (el) cards.current.set(id, el); else cards.current.delete(id); }}
        draggable={canMove}
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; setDragging(id); }}
        onDragEnd={() => { setDragging(null); setOver(null); }}
        className={`group/card relative overflow-hidden rounded-md border border-border bg-background py-1.5 pr-1 pl-3 ${canMove ? 'cursor-grab active:cursor-grabbing' : ''} ${dragging === id ? 'opacity-50' : ''}`}
        data-organizer-thread={th.title}
      >
        <span className={`absolute inset-y-0 left-0 w-1 ${colorOf.get(id) ?? 'bg-muted'}`} />
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm" title={th.title}>{th.title}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {th.fixed && <Lock className="size-3 shrink-0" aria-label={t('organizer.fixedOne')} />}
              <span className="shrink-0">{fmt(t('organizer.nodes'), { n: th.nodeIds.length })}</span>
              {(moving || col.kind === 'stay') && from && <Badge variant="secondary" className="max-w-full min-w-0 truncate" data-organizer-from>
                {moving ? fmt(t('organizer.from'), { name: from }) : fmt(t('organizer.stays'), { name: from })}
              </Badge>}
            </div>
          </div>
          {canMove && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100" aria-label={t('organizer.moveTo')} />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('organizer.moveTo')}</DropdownMenuLabel>
                  {groups!.filter((g) => g.key !== col.key).map((g) => (
                    <DropdownMenuItem key={g.key} onClick={() => moveThread(id, g.key)}>
                      <span className={`size-2 shrink-0 rounded-full ${dotOf(groups!.indexOf(g))}`} />
                      <span className="truncate">{g.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                {col.kind !== 'stay' && <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => moveThread(id, STAY)}>{t('organizer.keepHome')}</DropdownMenuItem>
                </>}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    );
  };

  const column = (c: Column) => {
    const open = expanded.has(c.key);
    const ids = open ? c.threadIds : c.threadIds.slice(0, FOLD);
    const droppable = editable && c.kind !== 'canvas' && !!dragging;
    return (
      <section
        key={c.key}
        onDragOver={(e) => { if (!droppable) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== c.key) setOver(c.key); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === c.key ? null : o)); }}
        onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); setDragging(null); setOver(null); if (id) moveThread(id, c.key); }}
        className={`flex flex-col gap-2 rounded-xl border bg-card p-2.5 transition-[opacity,border-color] ${c.kind === 'group' ? (c.off ? 'border-dashed border-border opacity-55' : 'border-primary/40') : c.kind === 'stay' ? 'border-dashed border-border bg-muted/40' : 'border-border'} ${over === c.key ? 'border-primary ring-2 ring-primary/30' : ''}`}
        data-organizer-column={c.name}
      >
        <header className="flex flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            {c.kind === 'group' && <Checkbox
              aria-label={fmt(t('organizer.acceptGroup'), { name: c.name })}
              checked={!c.off}
              disabled={applying}
              onCheckedChange={(on) => setAccepted((s) => { const n = new Set(s); if (on) n.add(c.key); else n.delete(c.key); return n; })}
              data-organizer-accept={c.name} />}
            {c.kind === 'group' && <span className={`size-2 shrink-0 rounded-full ${dotOf(c.index!)}`} />}
            {renaming === c.key
              ? <Input
                autoFocus
                defaultValue={c.name}
                onFocus={(e) => e.currentTarget.select()}
                aria-label={t('organizer.rename')}
                className="h-7 min-w-0 flex-1 px-1.5 text-sm"
                onBlur={(e) => rename(c.key, e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') rename(c.key, e.currentTarget.value); else if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); } }} />
              : c.kind === 'group' && editable
                ? <Button variant="ghost" size="xs" className="-ml-1 min-w-0 flex-1 justify-start px-1 text-sm font-medium" title={t('organizer.rename')} onClick={() => setRenaming(c.key)}>
                  <span className="truncate">{c.name}</span>
                </Button>
                : <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={c.name}>{c.name}</h3>}
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{c.threadIds.length}</span>
          </div>
          {c.kind === 'group' && (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {c.off
                ? <span>{t('organizer.landsOff')}</span>
                : c.lands && <Badge variant={c.lands === 'new' ? 'outline' : 'secondary'} data-organizer-lands={c.lands}>
                  {t(c.lands === 'new' ? 'organizer.landsNew' : 'organizer.landsKept')}
                </Badge>}
              {c.reason && <span className="truncate" title={c.reason}>{c.reason}</span>}
            </div>
          )}
          {c.kind === 'stay' && <p className="text-xs text-muted-foreground">{t('organizer.stayHint')}</p>}
          {colorOf.size > 0 && c.threadIds.length > 0 && (
            <div className="mt-0.5 flex h-1 overflow-hidden rounded-full bg-muted">
              {c.threadIds.map((id) => <span key={id} className={`flex-1 ${colorOf.get(id) ?? ''}`} />)}
            </div>
          )}
        </header>
        {ids.map((id) => card(id, c))}
        {c.kind === 'group' && c.threadIds.length === 0 && (
          <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">{t('organizer.dropHere')}</p>
        )}
        {c.threadIds.length > FOLD && (
          <Button variant="ghost" size="xs" className="self-start text-muted-foreground" onClick={() => setExpanded((s) => { const n = new Set(s); if (open) n.delete(c.key); else n.add(c.key); return n; })}>
            {open ? t('organizer.fold') : fmt(t('organizer.unfold'), { n: c.threadIds.length - FOLD })}
          </Button>
        )}
      </section>
    );
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !applying) onClose(); }}>
      <DialogContent size="full" className="flex h-[min(780px,92dvh)] flex-col gap-0 overflow-hidden p-0" showCloseButton={!applying} data-canvas-organizer>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border py-3 pr-12 pl-4">
          <div className="min-w-0 flex-1">
            <DialogTitle>{t('organizer.title')}</DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">{t('organizer.subtitle')}</DialogDescription>
          </div>
          <ToggleGroup variant="outline" size="sm" value={[view]} onValueChange={(v) => { if (v[0]) choose(v[0] as View); }} disabled={!data || applying} data-organizer-dims>
            <ToggleGroupItem value="now">{t('organizer.dimNow')}</ToggleGroupItem>
            {DIMS.map((d) => <ToggleGroupItem key={d} value={d}>{t(DIM_LABEL[d])}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[1fr_300px]">
          <ScrollArea className="min-h-0 bg-canvas">
            {!data
              ? <p className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('organizer.loading')}</p>
              : !data.threads.length
                ? <p className="p-6 text-muted-foreground">{t('organizer.empty')}</p>
                : (
                  <div ref={boardRef} className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] content-start items-start gap-3 p-4">
                    {columns.filter((c) => c.threadIds.length || c.kind === 'group').map(column)}
                  </div>
                )}
          </ScrollArea>

          <ScrollArea className="min-h-0 border-t border-border sm:border-t-0 sm:border-l">
            <div className="flex flex-col gap-3 p-4 text-sm">
              {!data ? null : view === 'now' ? (
                <>
                  <h4 className="font-medium">{fmt(t('organizer.nowTitle'), { canvases: data.canvases.length, threads: data.threads.length })}</h4>
                  <p className="text-xs text-muted-foreground">{t('organizer.nowHint')}</p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                    <dt className="font-medium">{t('organizer.dimTopic')}</dt><dd className="text-muted-foreground">{t('organizer.dimTopicHint')}</dd>
                    <dt className="font-medium">{t('organizer.dimGoal')}</dt><dd className="text-muted-foreground">{t('organizer.dimGoalHint')}</dd>
                    <dt className="font-medium">{t('organizer.dimTime')}</dt><dd className="text-muted-foreground">{t('organizer.dimTimeHint')}</dd>
                  </dl>
                  {ready.length > 0 && (
                    <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                      <span className="text-xs font-medium text-muted-foreground">{t('organizer.colorBy')}</span>
                      <ToggleGroup variant="outline" size="sm" value={[colorBy ?? 'none']} onValueChange={(v) => { if (v[0]) setColorBy(v[0] === 'none' ? null : v[0] as Dimension); }} data-organizer-color-by>
                        <ToggleGroupItem value="none">{t('organizer.colorNone')}</ToggleGroupItem>
                        {ready.map((d) => <ToggleGroupItem key={d} value={d}>{t(DIM_LABEL[d])}</ToggleGroupItem>)}
                      </ToggleGroup>
                    </div>
                  )}
                </>
              ) : !proposal ? (
                <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('organizer.proposing')}</p>
              ) : 'error' in proposal ? (
                <>
                  <p className="text-destructive">{proposal.error}</p>
                  <Button variant="outline" size="sm" className="self-start" onClick={() => void ask(view, true)}>{t('organizer.retry')}</Button>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-medium">{fmt(t('organizer.groupsTitle'), { n: proposal.groups.length })}</h4>
                    {view !== 'time' && <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={applying} onClick={() => void ask(view, true)} data-organizer-regroup>
                      <RefreshCw />
                      {t('organizer.regroup')}
                    </Button>}
                  </div>
                  <p className="text-xs text-muted-foreground">{t('organizer.editHint')}</p>

                  <div className="flex flex-col gap-2 rounded-xl border border-border p-3" data-organizer-effect>
                    <span className="text-xs font-medium text-muted-foreground">{t('organizer.effectTitle')}</span>
                    {!effect
                      ? <p className="text-xs text-muted-foreground">{t('organizer.effectNone')}</p>
                      : <ul className="flex flex-col gap-1.5 text-xs">
                        <li className="flex justify-between"><span>{t('organizer.effectMoved')}</span><span className="tabular-nums">{effect.moved}</span></li>
                        <li className="flex justify-between"><span>{t('organizer.effectMade')}</span><span className="tabular-nums">{effect.made}</span></li>
                        <li className="flex justify-between"><span>{t('organizer.effectKept')}</span><span className="tabular-nums">{effect.kept}</span></li>
                        {effect.removed.length > 0 && <li className="flex flex-col gap-1 text-warning" data-organizer-removed>
                          <span className="flex justify-between"><span>{t('organizer.effectRemoved')}</span><span className="tabular-nums">{effect.removed.length}</span></span>
                          <span className="text-muted-foreground">{effect.removed.join(t('organizer.listSep'))}</span>
                        </li>}
                      </ul>}
                  </div>

                </>
              )}
              {fixed > 0 && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="size-3 shrink-0" />{fmt(t('organizer.fixed'), { n: fixed })}</p>}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter className="m-0 items-center rounded-b-xl border-t border-border p-3 sm:justify-between">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-organizer-summary>
            {outcome && effect && data && <>
              {fmt(t('organizer.summaryFrom'), { n: data.canvases.length })}
              <ArrowRight className="size-3" />
              {fmt(t('organizer.summary'), { to: outcome.canvases.length, moved: effect.moved })}
            </>}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" disabled={applying} onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!outcome || applying} onClick={() => void apply()} data-organizer-apply>
              {applying && <Loader2 className="animate-spin" />}
              {t('organizer.apply')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
