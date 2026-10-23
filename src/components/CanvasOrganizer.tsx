import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from './ui/dialog';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { ScrollArea } from './ui/scroll-area';
import { Checkbox } from './ui/checkbox';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { useT, t as ti, fmt } from '../i18n';
import { toast } from '../lib/ui-store';
import { ms } from '../lib/motion';
import { FRAME_COLORS } from '../lib/constants';
import { outcomeOf, type Group, type Thread } from '../lib/organize/threads';
import { proposeGroups, groupSources, type Dimension } from '../lib/organize/propose';
import { loadThreads, rebuildCanvases } from '../store/organize';
import type { ProjectMeta } from '../store/projects';

// The canvas organizer: every conversation on every canvas, regrouped in a
// preview by topic, goal or time; confirming rebuilds the canvases that way.
// The group colors exist only here — they show how mixed a canvas is, and
// nothing about them is written anywhere.

type View = 'now' | Dimension;
type Proposal = { groups: Group[] } | { error: string };

const PALETTE = ['violet', 'sky', 'green', 'amber', 'rose', 'gray'] as const;
const dotOf = (i: number) => FRAME_COLORS[PALETTE[i % PALETTE.length]].dot;

interface Column { key: string; name: string; threadIds: string[]; proposed?: boolean; off?: boolean }

export default function CanvasOrganizer({ onClose, onSwitched }: { onClose: () => void; onSwitched: () => void }) {
  const t = useT();
  const [data, setData] = useState<{ canvases: ProjectMeta[]; threads: Thread[] } | null>(null);
  const [view, setView] = useState<View>('now');
  const [proposals, setProposals] = useState<Partial<Record<Dimension, Proposal>>>({});
  // which groups are ticked, per grouping: switching away and back keeps the choice
  const [acceptedBy, setAcceptedBy] = useState<Partial<Record<Dimension, Set<string>>>>({});
  // the last grouping seen colors the cards in every view, "now" included
  const [colorBy, setColorBy] = useState<Dimension | null>(null);
  const [applying, setApplying] = useState(false);
  const viewRef = useRef<View>('now');

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

  const choose = async (next: View) => {
    setView(next);
    viewRef.current = next;
    if (next === 'now' || !data) return;
    const known = proposals[next];
    if (known && 'groups' in known) { setColorBy(next); return; }
    setProposals((p) => { const rest = { ...p }; delete rest[next]; return rest; });
    try {
      const gs = await proposeGroups(next, data.threads, data.canvases);
      setProposals((p) => ({ ...p, [next]: { groups: gs } }));
      setAcceptedBy((a) => ({ ...a, [next]: new Set(gs.map((g) => g.key)) }));
      if (viewRef.current === next) setColorBy(next);
    } catch (e) {
      setProposals((p) => ({ ...p, [next]: { error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    const p = colorBy && proposals[colorBy];
    if (p && 'groups' in p) p.groups.forEach((g, i) => g.threadIds.forEach((id) => m.set(id, dotOf(i))));
    return m;
  }, [colorBy, proposals]);

  const columns: Column[] = groups
    ? groups.map((g) => ({ key: g.key, name: g.name, threadIds: g.threadIds, proposed: true, off: !accepted.has(g.key) }))
    : (data?.canvases ?? []).map((c) => ({ key: c.id, name: c.name, threadIds: data!.threads.filter((th) => th.canvasId === c.id).map((th) => th.id) }));

  const outcome = useMemo(
    () => (groups && data ? outcomeOf(data.canvases, data.threads, groups.filter((g) => accepted.has(g.key))) : null),
    [groups, accepted, data],
  );

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

  const proposedIds = new Set(groups?.flatMap((g) => g.threadIds) ?? []);
  const fixed = data?.threads.filter((th) => th.fixed).length ?? 0;
  const leftOut = groups ? (data?.threads.filter((th) => !th.fixed && !proposedIds.has(th.id)).length ?? 0) : 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !applying) onClose(); }}>
      <DialogContent size="full" className="flex h-[min(780px,92dvh)] flex-col gap-0 overflow-hidden p-0" showCloseButton={!applying} data-canvas-organizer>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-3 pr-12 pl-4">
          <DialogTitle>{t('organizer.title')}</DialogTitle>
          <ToggleGroup variant="outline" size="sm" value={[view]} onValueChange={(v) => { if (v[0]) void choose(v[0] as View); }} disabled={!data || applying}>
            <ToggleGroupItem value="now">{t('organizer.dimNow')}</ToggleGroupItem>
            <ToggleGroupItem value="topic">{t('organizer.dimTopic')}</ToggleGroupItem>
            <ToggleGroupItem value="goal">{t('organizer.dimGoal')}</ToggleGroupItem>
            <ToggleGroupItem value="time">{t('organizer.dimTime')}</ToggleGroupItem>
          </ToggleGroup>
          <DialogDescription className="text-xs">{t('organizer.subtitle')}</DialogDescription>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[1fr_300px]">
          <ScrollArea className="min-h-0 bg-canvas">
            {!data
              ? <p className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('organizer.loading')}</p>
              : !data.threads.length
                ? <p className="p-6 text-muted-foreground">{t('organizer.empty')}</p>
                : (
                  <div ref={boardRef} className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] content-start gap-3 p-4">
                    {columns.filter((c) => c.threadIds.length).map((c) => (
                      <section
                        key={c.key}
                        className={`rounded-xl border bg-card p-2.5 transition-opacity ${c.proposed ? 'border-dashed border-primary/50' : 'border-border'} ${c.off ? 'opacity-45' : ''}`}
                        data-organizer-column={c.name}
                      >
                        <header className="flex items-baseline justify-between gap-2">
                          <h3 className="truncate text-sm font-medium" title={c.name}>{c.name}</h3>
                          <span className="shrink-0 text-xs text-muted-foreground">{fmt(t('organizer.threadCount'), { n: c.threadIds.length })}</span>
                        </header>
                        {colorOf.size > 0 && (
                          <div className="mt-1.5 flex h-1 overflow-hidden rounded-full bg-muted">
                            {c.threadIds.map((id) => <span key={id} className={`flex-1 ${colorOf.get(id) ?? ''}`} />)}
                          </div>
                        )}
                        {c.threadIds.map((id) => {
                          const th = threadById.get(id)!;
                          const from = nameOf.get(th.canvasId) ?? '';
                          return (
                            <div
                              key={id}
                              ref={(el) => { if (el) cards.current.set(id, el); else cards.current.delete(id); }}
                              className="relative mt-2 overflow-hidden rounded-md border border-border bg-background py-1.5 pr-2 pl-3"
                              data-organizer-thread={th.title}
                            >
                              <span className={`absolute inset-y-0 left-0 w-1 ${colorOf.get(id) ?? 'bg-muted'}`} />
                              <div className="truncate text-sm" title={th.title}>{th.title}</div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                                {fmt(t('organizer.nodes'), { n: th.nodeIds.length })}
                                {c.proposed && from !== c.name && <Badge variant="secondary" className="max-w-full truncate">{fmt(t('organizer.from'), { name: from })}</Badge>}
                              </div>
                            </div>
                          );
                        })}
                      </section>
                    ))}
                  </div>
                )}
          </ScrollArea>

          <ScrollArea className="min-h-0 border-t border-border sm:border-t-0 sm:border-l">
            <div className="flex flex-col gap-2 p-4 text-sm">
              {!data ? null : view === 'now' ? (
                <>
                  <h4 className="font-medium">{fmt(t('organizer.nowTitle'), { canvases: data.canvases.length, threads: data.threads.length })}</h4>
                  <p className="text-xs text-muted-foreground">{t('organizer.nowHint')}</p>
                </>
              ) : !proposal ? (
                <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('organizer.proposing')}</p>
              ) : 'error' in proposal ? (
                <>
                  <p className="text-destructive">{proposal.error}</p>
                  <Button variant="outline" size="sm" className="self-start" onClick={() => void choose(view)}>{t('organizer.retry')}</Button>
                </>
              ) : (
                <>
                  <h4 className="font-medium">{fmt(t('organizer.groupsTitle'), { n: proposal.groups.length })}</h4>
                  <p className="text-xs text-muted-foreground">{t('organizer.groupsHint')}</p>
                  <div className="flex flex-col">
                    {proposal.groups.map((g, i) => (
                      <label key={g.key} className="flex cursor-pointer items-start gap-2 border-b border-border py-2 last:border-b-0" data-organizer-group={g.name}>
                        <Checkbox
                          className="mt-0.5"
                          checked={accepted.has(g.key)}
                          disabled={applying}
                          onCheckedChange={(on) => setAccepted((s) => { const n = new Set(s); if (on) n.add(g.key); else n.delete(g.key); return n; })}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 font-medium"><span className={`size-2 shrink-0 rounded-full ${dotOf(i)}`} />{g.name}</span>
                          {g.reason && <span className="block text-xs text-muted-foreground">{g.reason}</span>}
                          <span className="block text-xs text-muted-foreground">{groupSources(g, threadById, nameOf)}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {leftOut > 0 && <p className="text-xs text-muted-foreground">{fmt(t('organizer.leftOut'), { n: leftOut })}</p>}
                </>
              )}
              {fixed > 0 && <p className="text-xs text-muted-foreground">{fmt(t('organizer.fixed'), { n: fixed })}</p>}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter className="m-0 items-center rounded-b-xl border-t border-border p-3 sm:justify-between">
          <span className="text-xs text-muted-foreground" data-organizer-summary>
            {outcome && accepted.size > 0 && data ? fmt(t('organizer.summary'), { from: data.canvases.length, to: outcome.canvases.length }) : ''}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" disabled={applying} onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!outcome || accepted.size === 0 || applying} onClick={() => void apply()} data-organizer-apply>
              {applying && <Loader2 className="animate-spin" />}
              {t('organizer.apply')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
