import { useMemo, useState } from 'react';
import { History, ImageDown, Sparkles } from 'lucide-react';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { useDateLocale, useI18n, useT, fmt } from '../../i18n';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { collectTimeline } from '../../lib/timeline';
import { generateGedankengang, getCached, graphFingerprint, type Gedankengang } from '../../lib/gedankengang';

// The third overview, after highlights and materials: the canvas as a
// chronicle. Every node in creation order, grouped by day, each row carrying
// its takeaway (or question), both timestamps, and a locate chip. The rail
// under the palette is for jumping while zoomed out; this is for reading the
// journey itself.

export default function TimelineOverviewModal({ onLocate }: { onLocate: (nodeId: string) => void }) {
  const open = useUiStore((s) => s.timelineOverviewOpen);
  const setOpen = useUiStore((s) => s.setTimelineOverviewOpen);
  const nodes = useStore((s) => s.nodes);
  const t = useT();
  const dateLocale = useDateLocale();
  const lang = useI18n((s) => s.lang);
  // The modal never renders the recent-edit glow, so the clock is moot: 0.
  const entries = useMemo(() => collectTimeline(nodes, 0), [nodes]);
  // The journey paragraph: session-cached per (graph fingerprint, interface
  // language) — reopening is free until the map changes, and switching the
  // language toggle narrates in the other language.
  const fp = useMemo(() => graphFingerprint(nodes), [nodes]);
  const [ged, setGed] = useState<Gedankengang | null>(null);
  const [gedLoading, setGedLoading] = useState(false);
  const [gedFailed, setGedFailed] = useState(false);
  // Prefer the cache for the CURRENT (graph, language) pair; fall back to
  // the last generated one so a stale/other-language paragraph still shows,
  // dimmed, with the regenerate affordance.
  const shown = getCached(fp, lang) ?? ged;
  const stale = !!shown && (shown.fp !== fp || shown.lang !== lang);
  const writeJourney = () => {
    setGedLoading(true);
    setGedFailed(false);
    const { nodes: ns, edges: es } = useStore.getState();
    generateGedankengang(ns, es, lang)
      .then(setGed)
      .catch(() => setGedFailed(true))
      .finally(() => setGedLoading(false));
  };

  const close = () => setOpen(false);
  const dayOf = (iso?: string) => (iso ? iso.slice(0, 10) : '');
  const fmtClock = (iso?: string) =>
    iso ? new Date(iso).toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent size="md" className="p-0 gap-0 max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 px-5 py-3 pr-12 border-b border-border shrink-0">
          <History size={15} strokeWidth={1.75} className="text-primary" />
          <DialogTitle>{t('tlov.title')}</DialogTitle>
          <span className="text-2xs text-muted-foreground">{fmt(t('tlov.count'), { n: entries.length })}</span>
          <div className="flex-1" />
          <button
            onClick={() => { close(); useUiStore.getState().setThoughtMapOpen(true); }}
            disabled={entries.length === 0}
            data-tmap-from-timeline
            className="flex items-center gap-1.5 text-2xs text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-full px-2.5 py-1 transition-colors disabled:opacity-50"
          >
            <ImageDown size={13} strokeWidth={1.75} />
            {t('tmap.export')}
          </button>
        </div>

        <div className="px-5 pt-3 shrink-0" data-gedankengang>
          {!shown && !gedLoading && (
            <button
              onClick={writeJourney}
              className="flex items-center gap-1.5 text-2xs text-primary bg-primary/10 hover:bg-primary/20 rounded-full px-3 py-1.5 transition-colors"
            >
              <Sparkles size={12} strokeWidth={1.75} />
              {t('tlov.gedankenGenerate')}
            </button>
          )}
          {gedLoading && (
            <p className="text-2xs text-muted-foreground italic py-1.5">{t('tlov.gedankenLoading')}</p>
          )}
          {gedFailed && !gedLoading && (
            <p className="text-2xs text-destructive py-1">{t('tlov.gedankenFailed')}</p>
          )}
          {shown && !gedLoading && (
            <div className={`rounded-xl bg-muted px-4 py-3 ${stale ? 'opacity-60' : ''}`}>
              <p className="text-sm text-foreground leading-relaxed">{shown.text}</p>
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-2xs text-muted-foreground">
                  {stale ? t('tlov.gedankenStale') : new Date(shown.at).toLocaleString(dateLocale)}
                </span>
                {stale && (
                  <button onClick={writeJourney} className="text-2xs text-primary hover:underline">
                    {t('tlov.gedankenRedo')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3" data-timeline-overview>
          {entries.length === 0 && <p className="text-xs text-muted-foreground italic py-2">{t('tlov.empty')}</p>}
          {entries.map((e, i) => {
            const prevDay = i > 0 ? dayOf(entries[i - 1].createdAt) : undefined;
            const day = dayOf(e.createdAt);
            const newDay = i === 0 || day !== prevDay;
            return (
              <div key={e.id}>
                {newDay && (
                  <div className="sticky top-0 bg-card text-2xs text-muted-foreground font-medium pt-3 pb-1 first:pt-0">
                    {day || t('tlov.undated')}
                  </div>
                )}
                <div className="group flex items-center gap-2.5 py-1.5 border-b border-border/50 last:border-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: e.color, opacity: e.archived ? 0.35 : 1 }}
                  />
                  <span className="text-2xs font-mono text-muted-foreground shrink-0 w-11">{fmtClock(e.createdAt)}</span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate ${e.archived ? 'text-muted-foreground line-through' : e.badged ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {e.topic && <span className="font-medium text-primary">{e.topic} · </span>}
                      {e.label || '…'}
                    </p>
                    {e.modifiedAt && e.modifiedAt !== e.createdAt && (
                      <p className="text-2xs text-muted-foreground">{t('timeline.modified')} {new Date(e.modifiedAt).toLocaleString(dateLocale)}</p>
                    )}
                  </div>
                  <button
                    className="shrink-0 text-2xs font-mono text-primary bg-primary/10 hover:bg-primary/20 rounded-full px-1.5 py-0.5 transition-colors opacity-0 group-hover:opacity-100"
                    onClick={() => { close(); onLocate(e.id); }}
                    title={t('hlov.locateTitle')}
                  >
                    {t('tlov.locate')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
