import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Eye, FileJson, ImageDown, X } from 'lucide-react';
import { useUiStore } from '../../lib/ui-store';
import { exportActiveProjectJson } from '../../lib/export';
import { useT } from '../../i18n';

// Two jobs, two lanes. LANE 1: the read-only canvas link — it CARRIES the
// whole graph (minted against the public viewer origin, so a link made on
// the desktop app opens for anyone); long by design, so the right channels
// are the ones tolerant of long URLs (chat, mail, docs) and the right
// control is Copy. LANE 2: one door — the thought-map console owns the
// whole feed story (picture, caption, platform buttons) so entries stay few.
export default function ShareDialog() {
  const url = useUiStore((s) => s.shareDialogUrl);
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [readonlyMark, setReadonlyMark] = useState(true);
  const close = () => { setCopied(false); useUiStore.getState().setShareDialogUrl(null); };

  useEffect(() => {
    if (!url) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [url]);

  if (!url) return null;

  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return createPortal((
    <div className="fixed inset-0 z-[80] bg-foreground/25 backdrop-blur-[2px] flex items-center justify-center animate-fade-in" onClick={close} data-share-dialog>
      <div className="bg-background rounded-2xl shadow-2xl border border-border w-[min(480px,92vw)] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Eye size={15} strokeWidth={1.75} className="text-primary" /> {t('viewer.shareDialogTitle')}
          </div>
          <button onClick={close} className="w-7 h-7 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground flex items-center justify-center transition-colors">
            <X size={15} strokeWidth={1.75} />
          </button>
        </div>

        {/* Lane 1: hand the graph to someone who will open it */}
        <div className="text-2xs font-semibold text-primary mb-1">{t('share.directLane')}</div>
        <p className="text-xs text-muted-foreground mb-2">{t('share.directNote')}</p>
        <div className="flex gap-1.5 mb-4">
          <input
            readOnly
            value={url}
            onFocus={(e) => e.target.select()}
            className="flex-1 min-w-0 text-xs font-mono text-muted-foreground bg-muted border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-ring/40 truncate"
          />
          <button
            onClick={() => void copy()}
            className={`shrink-0 text-xs px-3 py-2 rounded-lg flex items-center gap-1.5 transition-colors ${
              copied ? 'bg-success text-white' : 'bg-primary text-white hover:bg-primary/90'
            }`}
            data-share-copy
          >
            {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.75} />}
            {copied ? t('viewer.copied') : t('viewer.copyLink')}
          </button>
        </div>
        {url.length > 30000 && (
          <p className="text-2xs text-warning bg-warning/10 border border-warning/30 rounded-lg px-3 py-2 leading-relaxed mb-3" data-share-toolong>
            {t('share.linkTooLong')}
          </p>
        )}
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => void exportActiveProjectJson({ sharedReadonly: readonlyMark })}
            data-share-fullfile
            className="text-xs px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors flex items-center gap-1.5"
          >
            <FileJson size={13} strokeWidth={1.75} />
            {t('share.fullFile')}
          </button>
          <label className="flex items-center gap-1.5 text-2xs text-muted-foreground cursor-pointer select-none">
            <input type="checkbox" checked={readonlyMark} onChange={(e) => setReadonlyMark(e.target.checked)}
              className="accent-[color:var(--primary)]" />
            {t('share.readonlyMark')}
          </label>
        </div>

        {/* Lane 2: post to a feed — picture + permanent repo link */}
        <div className="border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => { close(); useUiStore.getState().setThoughtMapOpen(true); }}
              data-share-thought-map
              className="text-xs px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors flex items-center gap-1.5 font-medium"
            >
              <ImageDown size={13} strokeWidth={1.75} />
              {t('tmap.export')}
            </button>
          </div>
        </div>
      </div>
    </div>
  ), document.body);
}
