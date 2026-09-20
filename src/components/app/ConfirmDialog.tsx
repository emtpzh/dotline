import { useUiStore } from '../../lib/ui-store';
import { useT } from '../../i18n';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';

// The app's one confirm box: anything that asks "are you sure?" resolves
// through ui-store.confirm(). Escape and the backdrop answer no, Enter
// answers yes — Base UI owns both, along with the focus trap that keeps
// Delete and the other canvas shortcuts from firing underneath.
export default function ConfirmDialog() {
  const request = useUiStore((s) => s.confirmRequest);
  const resolveConfirm = useUiStore((s) => s.resolveConfirm);
  const t = useT();

  return (
    <AlertDialog
      open={!!request}
      onOpenChange={(open) => { if (!open) resolveConfirm(false); }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          {request?.title && <AlertDialogTitle>{request.title}</AlertDialogTitle>}
          <AlertDialogDescription className="whitespace-pre-line [overflow-wrap:anywhere]">
            {request?.message}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => resolveConfirm(false)}>
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            autoFocus
            variant={request?.danger ? 'destructive' : 'default'}
            onClick={() => resolveConfirm(true)}
          >
            {request?.confirmLabel ?? t('common.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
