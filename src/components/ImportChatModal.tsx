import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import type { ImportableConversation } from '../lib/import-chat';
import { importChatConversations } from '../lib/export';
import { useT, fmt } from '../i18n';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';

// Conversation picker for ChatGPT/Claude exports: each checked conversation
// becomes its own canvas.
export default function ImportChatModal({
  conversations,
  onClose,
  onDone,
}: {
  conversations: ImportableConversation[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (i: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const allSelected = checked.size === conversations.length;

  const doImport = async () => {
    if (checked.size === 0 || busy) return;
    setBusy(true);
    await importChatConversations([...checked].sort((a, b) => a - b).map((i) => conversations[i]));
    setBusy(false);
    onDone();
  };

  return (
    <Dialog open onOpenChange={(next: boolean) => { if (!next) onClose(); }}>
      <DialogContent size="md" className="p-0 gap-0 max-h-[80vh] flex flex-col">
        <DialogHeader className="px-6 py-4 pr-14 border-b">
          <DialogTitle>{t('import.title')}</DialogTitle>
          <DialogDescription>{t('import.subtitle')}</DialogDescription>
        </DialogHeader>

        <div className="px-6 py-2 border-b border-border/60">
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none py-1">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setChecked(allSelected ? new Set() : new Set(conversations.map((_, i) => i)))}
              className="rounded border-border text-primary focus:ring-ring w-3.5 h-3.5"
            />
            {t('import.selectAll')}
            <span className="ml-auto text-2xs text-muted-foreground uppercase tracking-wider">{conversations[0]?.source}</span>
          </label>
        </div>

        <ul className="flex-1 overflow-y-auto py-1">
          {conversations.map((c, i) => (
            <li key={i}>
              <label className="flex items-center gap-3 px-6 py-2 hover:bg-accent transition-colors cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={checked.has(i)}
                  onChange={() => toggle(i)}
                  className="rounded border-border text-primary focus:ring-ring w-3.5 h-3.5 shrink-0"
                />
                <MessageSquare size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" />
                <span className="text-sm text-foreground truncate flex-1">{c.title}</span>
                <span className="text-2xs text-muted-foreground shrink-0">{fmt(t('import.messages'), { n: c.messageCount })}</span>
              </label>
            </li>
          ))}
        </ul>

        <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground hover:bg-accent">
            {t('common.cancel')}
          </Button>
          <Button size="sm"
            onClick={() => void doImport()}
            disabled={checked.size === 0 || busy}>
            {busy ? '…' : fmt(t('import.confirm'), { n: checked.size })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
