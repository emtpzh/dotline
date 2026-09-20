import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useUiStore, type ToastItem } from '../../lib/ui-store';
import { Button } from '../ui/button';

const KIND_STYLES: Record<ToastItem['kind'], string> = {
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  success: 'border-success/30 bg-success/10 text-success',
  info: 'border-border bg-card text-muted-foreground',
};

const KIND_ICONS: Record<ToastItem['kind'], typeof Info> = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
};

export default function Toaster() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[90] flex flex-col gap-2 max-w-[380px]">
      {toasts.map((t) => {
        const Icon = KIND_ICONS[t.kind];
        return (
          <div
            key={t.id}
            className={`flex items-start gap-2.5 border rounded-xl shadow-lg px-4 py-3 animate-fade-in ${KIND_STYLES[t.kind]}`}
          >
            <Icon size={16} strokeWidth={1.75} className="shrink-0 mt-0.5" />
            {/* message owns the full row; the action drops below it — a long
                action label once crushed the message to two chars a line */}
            <div className="flex-1 min-w-0">
              <p className="text-xs leading-relaxed break-words">{t.message}</p>
              {t.action && (
                <Button variant="ghost" size="xs"
                  onClick={() => { t.action!.run(); dismissToast(t.id); }}
                  className="mt-2 text-2xs bg-primary/10 text-primary hover:bg-primary/20"
                >
                  {t.action.label}
                </Button>
              )}
            </div>
            <Button variant="ghost"
              onClick={() => dismissToast(t.id)}
              className="shrink-0 opacity-50 hover:opacity-100"
            >
              <X size={14} strokeWidth={1.75} />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
