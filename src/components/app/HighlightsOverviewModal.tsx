import { useMemo, useState } from 'react';
import { Download, Highlighter, Trash2 } from 'lucide-react';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { downloadMarkdown } from '../../lib/export';
import { useT, fmt } from '../../i18n';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';

// Every highlight on the canvas, in one place: the essence the reading
// left behind. Two lenses (by time = the reading journey, by node = the
// structure), each entry pinpoints back to its node (the same provenance
// chip + locate pattern the reader chips and diagnostics use), and a
// checked subset weaves straight into one cited passage — the overview
// picks by CONTENT, the selection toolbar picks by structure.

interface Entry {
  hlId: string;
  text: string;
  at?: string;
  nodeId: string;
  nodeTitle: string;
  showGroup?: boolean;
}

export default function HighlightsOverviewModal({ onLocate }: { onLocate: (nodeId: string) => void }) {
  const open = useUiStore((s) => s.highlightsOverviewOpen);
  const setOpen = useUiStore((s) => s.setHighlightsOverviewOpen);
  const nodes = useStore((s) => s.nodes);
  const removeHighlight = useStore((s) => s.removeHighlight);
  const convergeFrom = useStore((s) => s.convergeFrom);
  const t = useT();
  const [sort, setSort] = useState<'time' | 'node'>('time');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const n of nodes) {
      const title = n.data.question.replace(/\s+/g, ' ').trim().slice(0, 60) || '—';
      for (const h of n.data.highlights || []) {
        out.push({ hlId: h.id, text: h.text, at: h.at, nodeId: n.id, nodeTitle: title });
      }
    }
    const sorted = sort === 'time'
      ? [...out].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      : out; // canvas order = grouped by node already
    return sorted.map((e, i) => ({ ...e, showGroup: sort === 'node' && (i === 0 || sorted[i - 1].nodeTitle !== e.nodeTitle) }));
  }, [nodes, sort]);


  const togglePick = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };

  const close = () => { setOpen(false); setPicked(new Set()); };

  const weavePicked = () => {
    const ids = [...picked].filter((id) => entries.some((e) => e.hlId === id));
    if (ids.length === 0) return;
    const nodeIds = [...new Set(entries.filter((e) => ids.includes(e.hlId)).map((e) => e.nodeId))];
    close();
    // the weave lands unasked on the canvas: an extra request, the model, then Enter
    const id = convergeFrom(nodeIds, 'weave', ids);
    if (id) useUiStore.getState().setArrivalFocusNodeId(id);
  };

  const exportMd = () => {
    const lines = entries.map((e) => `- ${e.text}\n  — ${e.nodeTitle}${e.at ? ` · ${e.at.slice(0, 10)}` : ''}`);
    downloadMarkdown(`# ${t('hlov.title')}\n\n${lines.join('\n')}\n`);
  };

  const chip = 'shrink-0 text-2xs font-mono text-primary bg-primary/10 hover:bg-primary/20 rounded-full px-1.5 py-0.5 transition-colors';
  const sortBtn = (v: 'time' | 'node', label: string) => (
    <Button variant="ghost"
      onClick={() => setSort(v)}
      className={`text-2xs px-2.5 py-1 rounded-full transition-colors ${sort === v ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'}`}
    >
      {label}
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent size="md" className="p-0 gap-0 max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 px-5 py-3 pr-12 border-b border-border shrink-0">
          <Highlighter size={15} strokeWidth={1.75} className="text-warning" />
          <DialogTitle>{t('hlov.title')}</DialogTitle>
          <span className="text-2xs text-muted-foreground">{fmt(t('hlov.count'), { n: entries.length })}</span>
          <div className="flex-1" />
          {sortBtn('time', t('hlov.byTime'))}
          {sortBtn('node', t('hlov.byNode'))}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
          {entries.length === 0 && <p className="text-xs text-muted-foreground italic py-2">{t('hlov.empty')}</p>}
          {entries.map((e) => {
            return (
              <div key={e.hlId}>
                {e.showGroup && (
                  <div className="text-2xs text-muted-foreground font-medium mt-3 mb-1 first:mt-0 truncate">{e.nodeTitle}</div>
                )}
                <div className="group flex items-start gap-2.5 py-1.5 border-b border-border/50 last:border-0">
                  <input
                    type="checkbox"
                    checked={picked.has(e.hlId)}
                    onChange={() => togglePick(e.hlId)}
                    className="mt-1 accent-amber-500 shrink-0"
                  />
                  <span className="flex-1 text-sm text-foreground leading-relaxed min-w-0">
                    <mark className="bg-warning/15 text-warning px-0.5 rounded">{e.text}</mark>
                  </span>
                  {sort === 'time' && (
                    <Button variant="ghost" className={chip} onClick={() => { close(); onLocate(e.nodeId); }} title={t('hlov.locateTitle')}>
                      {e.nodeTitle.slice(0, 14)}{e.nodeTitle.length > 14 ? '…' : ''}
                    </Button>
                  )}
                  {sort === 'node' && (
                    <Button variant="ghost" className={chip} onClick={() => { close(); onLocate(e.nodeId); }} title={t('hlov.locateTitle')}>
                      ↦
                    </Button>
                  )}
                  {e.at && <span className="shrink-0 text-2xs text-muted-foreground font-mono mt-0.5">{e.at.slice(5, 10)}</span>}
                  <Button variant="ghost" size="icon-sm"
                    onClick={() => removeHighlight(e.nodeId, e.hlId)}
                    title={t('common.delete')}
                    className="text-muted-foreground hover:text-destructive/90 shrink-0 opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 strokeWidth={1.75} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-border shrink-0 space-y-2">
          {picked.size > 0 && (
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={weavePicked} className="text-xs bg-warning hover:bg-warning text-white shrink-0">
                {fmt(t('hlov.weavePicked'), { n: picked.size })}
              </Button>
            </div>
          )}
          <div className="flex items-center">
            <span className="text-2xs text-muted-foreground">{picked.size > 0 ? fmt(t('hlov.picked'), { n: picked.size }) : t('hlov.pickHint')}</span>
            <div className="flex-1" />
            {entries.length > 0 && (
              <Button variant="ghost" size="xs" onClick={exportMd} className="text-2xs text-muted-foreground hover:text-muted-foreground" title={t('hlov.exportTitle')}>
                <Download strokeWidth={1.75} /> {t('hlov.export')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
