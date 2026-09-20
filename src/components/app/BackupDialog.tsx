import { useState } from 'react';
import { FolderSync } from 'lucide-react';
import { useUiStore, toast } from '../../lib/ui-store';
import { backupSupported, enableAutoBackup, disableAutoBackup, backupActiveProject } from '../../lib/local-backup';
import { useT, fmt } from '../../i18n';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';

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

  // Absolute clock time keeps the render pure (no Date.now() while rendering)
  const rel = lastAt
    ? fmt(t('backup.lastAt'), { time: new Date(lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
    : t('backup.lastNever');

  return (
    <Dialog open={open && backupSupported} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent size="md" data-backup-dialog>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderSync size={15} strokeWidth={1.75} className={dir ? 'text-success' : 'text-primary'} />
            {t('backup.dialogTitle')}
          </DialogTitle>
          <DialogDescription>{t('backup.dialogHow')}</DialogDescription>
        </DialogHeader>

        {dir ? (
          <>
            <div className="text-xs bg-muted border rounded-lg px-3 py-2 space-y-0.5">
              <div className="text-foreground"><span className="text-muted-foreground">{t('backup.folder')}</span> {dir}</div>
              <div className="text-muted-foreground">{rel}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => { setBusy(true); void backupActiveProject().then((name) => { if (name) toast('success', fmt(t('backup.wroteActive'), { name })); }).finally(() => setBusy(false)); }}
                disabled={busy}
                data-backup-now
              >
                {t('backup.now')}
              </Button>
              <Button variant="outline" onClick={() => void enableAutoBackup()}>
                {t('backup.changeFolder')}
              </Button>
              <Button variant="outline" className="hover:text-destructive" onClick={() => { void disableAutoBackup(); }}>
                {t('backup.stop')}
              </Button>
            </div>
          </>
        ) : (
          <div>
            <Button onClick={() => void enableAutoBackup().then((ok) => { if (ok) close(); })}>
              {t('backup.autoSetup')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
