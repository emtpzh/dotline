import { useRef, useState } from 'react';
import { useI18n, useT, fmt } from '../../i18n';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { useUiStore } from '../../lib/ui-store';
import { appVersion } from '../../lib/app-version';
import { announcedSince, type WhatsNewEntry, type WhatsNewItem } from '../../whats-new';
import type { Lang } from '../../i18n';
import { Button } from '../ui/button';
import { APP_NAME } from '../../lib/brand';

// On the first launch after an update: what changed since the version this
// person last read about, newest release first, each with a door to read
// more. Releases that were skipped, or whose notes never got shown, come
// along — so the dialog is "since your last look", not "this version only".
// The desktop shell hands its version over in the URL (?dv=); the web build
// has no version of its own and never shows this. A fresh install is not an
// update: the current version is recorded silently and nothing pops.
// `?wn=1` forces the dialog with every announced release up to the running
// version (development, demos; the shell adds it for TD_WHATS_NEW=1).

const SEEN_KEY = 'thoughtdag.whatsNewSeen';
const params = new URLSearchParams(window.location.search);

function decide(): WhatsNewEntry[] {
  if (!appVersion) return [];
  const forced = params.get('wn') === '1';
  if (forced) return announcedSince(null, appVersion);
  let seen: string | null = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { /* storage unavailable: never nag */ }
  if (seen === null) {
    // no record: either a fresh install, or an install that predates this
    // dialog (0.4.5 is its first release). Marks an earlier version leaves —
    // a finished tutorial, a backup — tell the two apart: with any of them
    // this is an upgrade and every announced release shows; without, the
    // version is recorded silently and nothing pops on a first launch.
    let prior = false;
    try { prior = !!(localStorage.getItem('thoughtdag.tutorialDone') || localStorage.getItem('thoughtdag.lastBackupAt')); } catch { /* ignore */ }
    if (!prior) { try { localStorage.setItem(SEEN_KEY, appVersion); } catch { /* ignore */ } return []; }
    return announcedSince(null, appVersion);
  }
  if (seen === appVersion) return [];
  return announcedSince(seen, appVersion);
}

/** The numbered items of one release; shared with the release history. */
export function WhatsNewItems({ items, lang }: { items: WhatsNewItem[]; lang: Lang }) {
  if (items.length === 0) return null;
  return (
    <ol className="divide-y divide-border">
      {items.map((it, i) => (
        <li key={i} className="py-3 flex gap-3.5">
          <span className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center mt-0.5">{i + 1}</span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{it.title[lang]}</div>
            <p className="text-sm text-muted-foreground leading-relaxed mt-1 [overflow-wrap:anywhere]">{it.body[lang]}</p>
            {it.link && (
              <a
                href={it.link.href}
                target="_blank"
                rel="noreferrer"
                className="inline-block mt-1.5 text-xs font-medium text-primary hover:underline"
              >
                {it.link.label[lang]} →
              </a>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function WhatsNewDialog() {
  const [entries, setEntries] = useState<WhatsNewEntry[]>(() => decide());
  const open = entries.length > 0;
  const lang = useI18n((s) => s.lang);
  const t = useT();
  const okRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    if (appVersion) { try { localStorage.setItem(SEEN_KEY, appVersion); } catch { /* ignore */ } }
    setEntries([]);
  };



  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent size="lg" className="p-0 gap-0 max-h-[85vh] overflow-y-auto" data-whats-new>
        <DialogHeader className="px-6 pt-5 pb-4 pr-14 border-b">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground">{APP_NAME}</div>
          <DialogTitle>{fmt(t('whatsNew.title'), { v: appVersion ?? '' })}</DialogTitle>
          {entries.length > 1 && <DialogDescription>{t('whatsNew.multi')}</DialogDescription>}
        </DialogHeader>
        <ol className="px-6 divide-y divide-border">
          {entries.map((entry) => (
            <li key={entry.version} className="py-4" data-release={entry.version}>
              {entries.length > 1 && (
                <div className="flex items-baseline gap-2.5 mb-1.5">
                  <span className="text-sm font-semibold text-foreground tabular-nums">v{entry.version}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{entry.date}</span>
                </div>
              )}
              <p className="text-sm text-muted-foreground leading-relaxed [overflow-wrap:anywhere]">{entry.lead[lang]}</p>
              <WhatsNewItems items={entry.items} lang={lang} />
            </li>
          ))}
        </ol>
        <div className="sticky bottom-0 bg-card px-6 py-4 border-t border-border flex items-center justify-between gap-4">
          <Button variant="ghost" size="sm"
            onClick={() => { close(); useUiStore.getState().setReleaseNotesOpen(true); }}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            data-whats-new-all
          >
            {t('whatsNew.seeAll')}
          </Button>
          <Button size="sm"
            ref={okRef}
            onClick={close}>
            {t('whatsNew.ok')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
