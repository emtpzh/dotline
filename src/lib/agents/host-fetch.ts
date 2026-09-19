import { toast } from '../ui-store';
import { t } from '../../i18n';

// fetch() for the host's agent and session endpoints. These answer in
// milliseconds on this machine; one still pending after SLOW_MS is almost
// always queued in the browser — every connection it keeps to the host taken
// (a browser keeps six per host, and each open harness tab holds some) — so
// the person hears why a turn looks stuck instead of watching it spin.

const SLOW_MS = 12_000;
const QUIET_MS = 60_000;
let warnedAt = 0;

export function hostFetch(input: string, init?: RequestInit): Promise<Response> {
  const timer = setTimeout(() => {
    if (Date.now() - warnedAt < QUIET_MS) return;
    warnedAt = Date.now();
    toast('info', t('agent.hostBusy'), 12_000);
  }, SLOW_MS);
  return fetch(input, init).finally(() => clearTimeout(timer));
}
