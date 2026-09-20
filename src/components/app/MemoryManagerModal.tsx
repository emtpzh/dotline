import { useState } from 'react';
import { Download, Plus, Trash2 } from 'lucide-react';
import { useUiStore } from '../../lib/ui-store';
import { downloadFile } from '../../lib/export';
import { generateId } from '../../utils';
import { useT, fmt } from '../../i18n';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';

// The memory manager: the ChatGPT-style curation surface, and the ONLY
// standing entry point to memory (writes announce themselves via toasts;
// nothing on the canvas). Easy in, easy out: entries paste in as plain
// lines (ChatGPT/Claude memory pages copy out that way) and export as a
// JSON file you own.

export default function MemoryManagerModal() {
  const t = useT();
  const open = useUiStore((s) => s.memoryManagerOpen);
  const setOpen = useUiStore((s) => s.setMemoryManagerOpen);
  const memories = useUiStore((s) => s.memories);
  const setMemories = useUiStore((s) => s.setMemories);
  const enabled = useUiStore((s) => s.memoryEnabled);
  const setEnabled = useUiStore((s) => s.setMemoryEnabled);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');

  const kindLabel = (k: string) => t(k === 'auto' ? 'memory.kindAuto' : k === 'imported' ? 'memory.kindImported' : 'memory.kindManual');
  const catBadge = (c?: string) =>
    c === 'preference' ? { label: t('memory.catPreference'), cls: 'bg-sky-500/10 text-sky-600' }
    : c === 'identity' ? { label: t('memory.catIdentity'), cls: 'bg-primary/10 text-primary' }
    : c === 'project' ? { label: t('memory.catProject'), cls: 'bg-warning/10 text-warning' }
    : null;

  const add = () => setMemories([...memories, { id: generateId(), text: '', kind: 'manual', at: new Date().toISOString() }]);
  const commit = (id: string, text: string) => {
    const v = text.trim();
    if (!v) { setMemories(memories.filter((m) => m.id !== id)); return; }
    setMemories(memories.map((m) => (m.id === id ? { ...m, text: v } : m)));
  };
  const doImport = () => {
    const lines = importText.split('\n').map((l) => l.replace(/^[-•\s]+/, '').trim()).filter((l) => l.length > 1);
    if (lines.length === 0) { setImporting(false); return; }
    const now = new Date().toISOString();
    setMemories([...memories, ...lines.map((text) => ({ id: generateId(), text, kind: 'imported' as const, at: now }))]);
    setImportText('');
    setImporting(false);
  };
  const doExport = () => downloadFile('thoughtdag-memory.json', JSON.stringify(memories, null, 2), 'application/json');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="md" className="p-0 gap-0 max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 px-5 py-3 pr-12 border-b border-border shrink-0">
          <DialogTitle>{t('memory.managerTitle')}</DialogTitle>
          <span className="text-2xs text-muted-foreground flex-1">{fmt(t('memory.hint'), { n: memories.length })}</span>
          <Button variant="ghost"
            onClick={() => setEnabled(!enabled)}
            title={t('caps.memoryTitle')}
            className={`text-2xs px-2.5 py-1 rounded-full transition-colors shrink-0 ${enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}
          >
            {enabled ? t('caps.on') : t('caps.off')}
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3 space-y-2">
          {memories.length === 0 && !importing && (
            <p className="text-xs text-muted-foreground italic py-2">{t('memory.empty')}</p>
          )}
          {memories.map((m) => (
            <div key={m.id} className="border border-border rounded-xl px-3 py-2 bg-background group">
              <div className="flex items-start gap-2">
                <textarea
                  defaultValue={m.text}
                  onBlur={(e) => commit(m.id, e.target.value)}
                  rows={1}
                  className="flex-1 text-sm text-foreground bg-transparent focus:outline-none resize-y leading-relaxed"
                />
                <Button variant="ghost" size="icon-sm"
                  onClick={() => setMemories(memories.filter((x) => x.id !== m.id))}
                  title={t('common.delete')}
                  className="text-muted-foreground hover:text-destructive/90 shrink-0 opacity-0 group-hover:opacity-100"
                >
                  <Trash2 size={13} strokeWidth={1.75} />
                </Button>
              </div>
              <p className="text-2xs text-muted-foreground mt-1 font-mono flex items-center gap-1.5 flex-wrap">
                {(() => { const b = catBadge(m.category); return b ? <span className={`px-1.5 py-px rounded-full font-sans ${b.cls}`}>{b.label}</span> : null; })()}
                <span>{kindLabel(m.kind)}{m.project ? ` · ${m.project}` : ''} · {m.at.slice(0, 10)}</span>
              </p>
            </div>
          ))}
          {importing && (
            <div className="border border-primary/40 rounded-xl px-3 py-2 bg-background space-y-2">
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={t('memory.importPlaceholder')}
                rows={5}
                autoFocus
                className="w-full text-xs text-foreground bg-transparent focus:outline-none resize-y leading-relaxed placeholder-muted-foreground"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="xs" onClick={() => setImporting(false)} className="text-xs text-muted-foreground hover:text-foreground hover:bg-accent">{t('common.cancel')}</Button>
                <Button size="xs" onClick={doImport}>{t('memory.importConfirm')}</Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-border shrink-0">
          <Button variant="ghost" size="sm" onClick={add} className="text-xs text-primary hover:bg-primary/10">
            <Plus size={14} strokeWidth={1.75} /> {t('memory.add')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setImporting(true)} className="text-xs text-muted-foreground hover:text-foreground hover:bg-accent">
            {t('memory.import')}
          </Button>
          <div className="flex-1" />
          {memories.length > 0 && (
            <Button variant="ghost" size="xs" onClick={doExport} className="text-2xs text-muted-foreground hover:text-muted-foreground" title={t('memory.exportTitle')}>
              <Download size={12} strokeWidth={1.75} /> {t('memory.export')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
