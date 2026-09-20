import { useMemo, useState } from 'react';
import { BookOpen, FileText, Image as ImageIcon, Link2, Paperclip, StickyNote } from 'lucide-react';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { useT, fmt } from '../../i18n';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';

// Every material on the canvas, in one place — the sibling of the
// highlights overview. Attachments wherever they live (thought nodes and
// file nodes alike) plus note and link materials, two lenses (by time /
// by node), each row pinpointing its node and opening straight into the
// reader when there is something to read.

interface Entry {
  key: string;
  name: string;
  icon: 'pdf' | 'img' | 'txt' | 'note' | 'link';
  sizeKB?: number;
  at?: string;
  nodeId: string;
  nodeTitle: string;
  canOpen: boolean;
  showGroup?: boolean;
}

const ICONS = {
  pdf: FileText,
  img: ImageIcon,
  txt: FileText,
  note: StickyNote,
  link: Link2,
} as const;

export default function MaterialsOverviewModal({ onLocate }: { onLocate: (nodeId: string) => void }) {
  const open = useUiStore((s) => s.materialsOverviewOpen);
  const setOpen = useUiStore((s) => s.setMaterialsOverviewOpen);
  const nodes = useStore((s) => s.nodes);
  const t = useT();
  const [sort, setSort] = useState<'time' | 'node'>('time');

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const n of nodes) {
      const kind = n.data.stepKind;
      if (kind === 'note' || kind === 'link') {
        const title = kind === 'link'
          ? (n.data.linkTitle || n.data.linkUrl || '—')
          : (n.data.question.split('\n')[0].replace(/^#+\s*/, '').slice(0, 60) || '—');
        out.push({ key: n.id, name: title, icon: kind, at: n.data.createdAt, nodeId: n.id, nodeTitle: title, canOpen: true });
        continue;
      }
      const holder = n.data.question.replace(/\s+/g, ' ').trim().slice(0, 60) || (kind === 'file' ? t('glyph.file') : '—');
      for (const a of n.data.attachments || []) {
        const icon = a.type === 'application/pdf' ? 'pdf' : a.type.startsWith('image/') ? 'img' : 'txt';
        out.push({
          key: a.id, name: a.name, icon,
          sizeKB: a.size / 1024, at: a.addedAt,
          nodeId: n.id, nodeTitle: holder,
          canOpen: icon === 'pdf',
        });
      }
    }
    const sorted = sort === 'time'
      ? [...out].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      : out;
    return sorted.map((e, i) => ({ ...e, showGroup: sort === 'node' && (i === 0 || sorted[i - 1].nodeTitle !== e.nodeTitle) }));
  }, [nodes, sort, t]);


  const close = () => setOpen(false);
  const openReader = (nodeId: string) => {
    close();
    useUiStore.getState().setReaderNodeId(nodeId);
  };

  const chip = 'shrink-0 text-2xs font-mono text-primary bg-primary/10 hover:bg-primary/20 rounded-full px-1.5 py-0.5 transition-colors';
  const sortBtn = (v: 'time' | 'node', label: string) => (
    <button
      onClick={() => setSort(v)}
      className={`text-2xs px-2.5 py-1 rounded-full transition-colors ${sort === v ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'}`}
    >
      {label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent size="md" className="p-0 gap-0 max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 px-5 py-3 pr-12 border-b border-border shrink-0">
          <Paperclip size={15} strokeWidth={1.75} className="text-edge-explore" />
          <DialogTitle>{t('matov.title')}</DialogTitle>
          <span className="text-2xs text-muted-foreground">{fmt(t('matov.count'), { n: entries.length })}</span>
          <div className="flex-1" />
          {sortBtn('time', t('hlov.byTime'))}
          {sortBtn('node', t('hlov.byNode'))}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
          {entries.length === 0 && <p className="text-xs text-muted-foreground italic py-2">{t('matov.empty')}</p>}
          {entries.map((e) => {
            const Icon = ICONS[e.icon];
            return (
              <div key={e.key}>
                {e.showGroup && (
                  <div className="text-2xs text-muted-foreground font-medium mt-3 mb-1 first:mt-0 truncate">{e.nodeTitle}</div>
                )}
                <div className="group flex items-center gap-2.5 py-1.5 border-b border-border/50 last:border-0">
                  <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                    e.icon === 'note' ? 'bg-warning/15 text-warning' : e.icon === 'link' ? 'bg-cyan-100 text-cyan-700' : 'bg-muted text-muted-foreground'
                  }`}>
                    <Icon size={14} strokeWidth={1.75} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{e.name}</p>
                    <p className="text-2xs text-muted-foreground">
                      {e.sizeKB != null ? `${e.sizeKB.toFixed(1)} KB` : t(`matov.kind.${e.icon}` as Parameters<typeof t>[0])}
                      {e.at ? ` · ${e.at.slice(0, 10)}` : ''}
                    </p>
                  </div>
                  {sort === 'time' && (
                    <button className={chip} onClick={() => { close(); onLocate(e.nodeId); }} title={t('hlov.locateTitle')}>
                      {e.nodeTitle.slice(0, 14)}{e.nodeTitle.length > 14 ? '…' : ''}
                    </button>
                  )}
                  {sort === 'node' && (
                    <button className={chip} onClick={() => { close(); onLocate(e.nodeId); }} title={t('hlov.locateTitle')}>
                      ↦
                    </button>
                  )}
                  {e.canOpen && (
                    <button
                      onClick={() => openReader(e.nodeId)}
                      title={t('attach.openReader')}
                      className="w-7 h-7 rounded-lg text-muted-foreground hover:text-primary hover:bg-accent flex items-center justify-center transition-colors shrink-0"
                    >
                      <BookOpen size={14} strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
