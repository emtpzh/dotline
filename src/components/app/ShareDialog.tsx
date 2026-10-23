import { useState } from 'react';
import { Check, Copy, Eye, FileJson } from 'lucide-react';
import { useUiStore } from '../../lib/ui-store';
import { exportActiveProjectJson } from '../../lib/export';
import { useT } from '../../i18n';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';

// The read-only canvas link — it CARRIES the whole graph (minted against
// the public viewer origin, so a link made on the desktop app opens for
// anyone); long by design, so the right channels are the ones tolerant of
// long URLs (chat, mail, docs) and the right control is Copy. The full file
// is the fallback when the link outgrows them.
export default function ShareDialog() {
  const url = useUiStore((s) => s.shareDialogUrl);
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [readonlyMark, setReadonlyMark] = useState(true);
  const close = () => { setCopied(false); useUiStore.getState().setShareDialogUrl(null); };


  const copy = async () => {
    await navigator.clipboard.writeText(url ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Dialog open={!!url} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent size="md" data-share-dialog>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye size={15} strokeWidth={1.75} className="text-primary" /> {t('viewer.shareDialogTitle')}
          </DialogTitle>
        </DialogHeader>

        {/* Lane 1: hand the graph to someone who will open it */}
        <div className="text-2xs font-semibold text-primary mb-1">{t('share.directLane')}</div>
        <p className="text-xs text-muted-foreground mb-2">{t('share.directNote')}</p>
        <div className="flex gap-1.5 mb-4">
          <Input
            readOnly
            value={url ?? ''}
            onFocus={(e) => e.target.select()}
            className="flex-1 min-w-0 font-mono text-muted-foreground truncate"
          />
          <Button
            onClick={() => void copy()}
            className={copied ? 'shrink-0 bg-success text-success-foreground hover:bg-success/90' : 'shrink-0'}
            data-share-copy
          >
            {copied ? <Check strokeWidth={2} /> : <Copy strokeWidth={1.75} />}
            {copied ? t('viewer.copied') : t('viewer.copyLink')}
          </Button>
        </div>
        {(url?.length ?? 0) > 30000 && (
          <p className="text-2xs text-warning bg-warning/10 border border-warning/30 rounded-lg px-3 py-2 leading-relaxed mb-3" data-share-toolong>
            {t('share.linkTooLong')}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => void exportActiveProjectJson({ sharedReadonly: readonlyMark })} data-share-fullfile>
            <FileJson strokeWidth={1.75} />
            {t('share.fullFile')}
          </Button>
          <label className="flex items-center gap-1.5 text-2xs text-muted-foreground cursor-pointer select-none">
            <input type="checkbox" checked={readonlyMark} onChange={(e) => setReadonlyMark(e.target.checked)}
              className="accent-[color:var(--primary)]" />
            {t('share.readonlyMark')}
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
