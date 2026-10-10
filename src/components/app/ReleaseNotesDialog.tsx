import { useEffect } from 'react';
import { useI18n, useT } from '../../i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { useUiStore } from '../../lib/ui-store';
import { WHATS_NEW } from '../../whats-new';
import { appVersion } from '../../lib/app-version';
import { WhatsNewItems } from './WhatsNewDialog';
import { Button } from '../ui/button';
import { APP_NAME } from '../../lib/brand';

// The release history behind the ⋯ menu: every entry of the what's-new
// list, newest first, the running version marked. Same card as the update
// dialog, so a release reads the same whether it popped up or was looked up.
// Works in the web build too; only the "current" mark needs the shell's
// version.

export default function ReleaseNotesDialog() {
  const open = useUiStore((s) => s.releaseNotesOpen);
  const setOpen = useUiStore((s) => s.setReleaseNotesOpen);
  const lang = useI18n((s) => s.lang);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, setOpen]);


  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="lg" className="p-0 gap-0 max-h-[85vh] overflow-y-auto" data-release-notes>
        <DialogHeader className="px-6 pt-5 pb-4 pr-14 border-b">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground">{APP_NAME}</div>
          <DialogTitle>{t('releaseNotes.title')}</DialogTitle>
        </DialogHeader>
        <ol className="px-6 divide-y divide-border">
          {WHATS_NEW.map((entry) => {
            const current = appVersion === entry.version;
            return (
              <li key={entry.version} className="py-4" data-release={entry.version}>
                <div className="flex items-baseline gap-2.5 flex-wrap">
                  <span className="text-sm font-semibold text-foreground tabular-nums">v{entry.version}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{entry.date}</span>
                  {current && (
                    <span className="text-2xs font-medium uppercase tracking-wide text-primary bg-primary/10 rounded-full px-2 py-0.5">{t('releaseNotes.current')}</span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed mt-1.5 [overflow-wrap:anywhere]">{entry.lead[lang]}</p>
                <WhatsNewItems items={entry.items} lang={lang} />
              </li>
            );
          })}
        </ol>
        <div className="sticky bottom-0 bg-card px-6 py-4 border-t border-border flex justify-end">
          <Button variant="outline" size="sm"
            onClick={() => setOpen(false)}>
            {t('common.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
