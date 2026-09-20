import { useEffect, useRef } from 'react';
import { toast as sonner } from 'sonner';
import { useUiStore, type ToastItem } from '../../lib/ui-store';
import { useAppearance } from '../../lib/appearance';
import { Toaster as SonnerToaster } from '../ui/sonner';

// The toast surface. Every caller still goes through ui-store's toast() —
// the store stays the one source of truth for what is on screen and for how
// long (a sticky toast has no timer; a normal one is removed by the store).
// This component only mirrors that list into sonner, which draws it.
export default function Toaster() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);
  const theme = useAppearance((s) => s.resolved);
  // what sonner is currently showing, so this can tell new from changed
  const shown = useRef(new Map<string, ToastItem>());

  useEffect(() => {
    const live = new Set(toasts.map((t) => t.id));
    for (const id of shown.current.keys()) {
      if (!live.has(id)) {
        sonner.dismiss(id);
        shown.current.delete(id);
      }
    }
    for (const item of toasts) {
      const before = shown.current.get(item.id);
      if (before && before.message === item.message) continue;
      const show = item.kind === 'error' ? sonner.error : item.kind === 'success' ? sonner.success : sonner.info;
      show(item.message, {
        id: item.id,
        // the store's own timer decides when this goes; sonner just draws it
        duration: Infinity,
        onDismiss: () => dismissToast(item.id),
        action: item.action
          ? { label: item.action.label, onClick: () => { item.action!.run(); dismissToast(item.id); } }
          : undefined,
      });
      shown.current.set(item.id, item);
    }
  }, [toasts, dismissToast]);

  return <SonnerToaster theme={theme} position="bottom-right" closeButton />;
}
