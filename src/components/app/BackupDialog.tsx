import { useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderSync, X } from 'lucide-react';
import { useUiStore, toast } from '../../lib/ui-store';
import { backupSupported, enableAutoBackup, disableAutoBackup, backupActiveProject } from '../../lib/local-backup';
import { useT, fmt } from '../../i18n';

// Auto-backup control center: status (folder, last write), backup-now for
// EVERY canvas, change folder, stop. The automatic write itself is
// change-triggered (debounced ~1 min after an edit), not a fixed timer.

export default function BackupDialog() {
  const open = useUiStore((s) => s.backupDialogOpen);
  const dir = useUiStore((s) => s.autoBackupDir);
  const lastAt = useUiStore((s) => s.lastAutoBackupAt);
  const t = useT();
  const [busy, setBusy] = useState(false);
  const close = () => useUiStore.getState().setBackupDialogOpen(false);
  if (!open || !backupSupported) return null;

  // Absolute clock time keeps the render pure (no Date.now() while rendering)
  const rel = lastAt
    ? fmt(t('backup.lastAt'), { time: new Date(lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
    : t('backup.lastNever');

  return createPortal((
    <div className="fixed inset-0 z-[80] bg-foreground/25 backdrop-blur-[2px] flex items-center justify-center animate-fade-in" onClick={close} data-backup-dialog>
      <div className="bg-background rounded-2xl shadow-2xl border border-border w-[min(440px,92vw)] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-1">
          <div className="text-sm font-semibold text-foreground flex items-center gap-2">
            <FolderSync size={15} strokeWidth={1.75} className={dir ? 'text-success' : 'text-primary'} /> {t('backup.dialogTitle')}
          </div>
          <button onClick={close} className="w-7 h-7 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground flex items-center justify-center transition-colors">
            <X size={15} strokeWidth={1.75} />
          </button>
        </div>
        <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{t('backup.dialogHow')}</p>

        {dir ? (
          <>
            <div className="text-xs bg-muted border border-border rounded-lg px-3 py-2 mb-3 space-y-0.5">
              <div className="text-foreground"><span className="text-muted-foreground">{t('backup.folder')}</span> {dir}</div>
              <div className="text-muted-foreground">{rel}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => { setBusy(true); void backupActiveProject().then((name) => { if (name) toast('success', fmt(t('backup.wroteActive'), { name })); }).finally(() => setBusy(false)); }}
                disabled={busy}
                className="text-xs bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-40"
                data-backup-now
              >
                {t('backup.now')}
              </button>
              <button onClick={() => void enableAutoBackup()} className="text-xs border border-border text-muted-foreground hover:bg-accent px-3 py-2 rounded-lg transition-colors">
                {t('backup.changeFolder')}
              </button>
              <button onClick={() => { void disableAutoBackup(); }} className="text-xs border border-border text-muted-foreground hover:bg-accent hover:text-destructive/90 px-3 py-2 rounded-lg transition-colors">
                {t('backup.stop')}
              </button>
            </div>
          </>
        ) : (
          <button
            onClick={() => void enableAutoBackup().then((ok) => { if (ok) close(); })}
            className="text-xs bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-lg transition-colors"
          >
            {t('backup.autoSetup')}
          </button>
        )}
      </div>
    </div>
  ), document.body);
}
