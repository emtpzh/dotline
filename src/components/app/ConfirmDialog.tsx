import { useEffect } from 'react';
import { useUiStore } from '../../lib/ui-store';
import { useT } from '../../i18n';

export default function ConfirmDialog() {
  const request = useUiStore((s) => s.confirmRequest);
  const resolveConfirm = useUiStore((s) => s.resolveConfirm);
  const t = useT();

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Capture-phase + stopPropagation keeps Delete/undo shortcuts in the
      // canvas from firing underneath the dialog.
      e.stopPropagation();
      if (e.key === 'Escape') resolveConfirm(false);
      if (e.key === 'Enter') resolveConfirm(true);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [request, resolveConfirm]);

  if (!request) return null;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/25 flex items-center justify-center animate-fade-in"
      onClick={() => resolveConfirm(false)}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-xl w-[380px] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {request.title && (
          <h3 className="text-sm font-semibold text-foreground mb-1.5">{request.title}</h3>
        )}
        <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line [overflow-wrap:anywhere]">{request.message}</p>
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={() => resolveConfirm(false)}
            className="text-xs text-muted-foreground hover:text-foreground px-4 py-2 rounded-lg hover:bg-accent transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => resolveConfirm(true)}
            autoFocus
            className={`text-xs text-white px-4 py-2 rounded-lg transition-colors ${
              request.danger ? 'bg-destructive hover:bg-destructive/90' : 'bg-primary hover:bg-primary/90'
            }`}
          >
            {request.confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
