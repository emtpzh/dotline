import { Globe, GraduationCap } from 'lucide-react';
import { useUiStore } from '../../lib/ui-store';
import { useModels } from '../../lib/use-models';
import { directWithoutSearch } from '../../lib/direct-llm';
import { useT } from '../../i18n';
import { Button } from '../ui/button';

// Per-ask search permissions, shown next to every input that asks. The two
// toggles edit the shared default (ui-store, persisted); each new node
// snapshots them at creation, so reruns keep behaving the same way.
export default function SearchToggles({ size = 16, model }: { size?: number; /** the model the box sends on, when not the global pick */ model?: string }) {
  const web = useUiStore((s) => s.webSearchEnabled);
  const setWeb = useUiStore((s) => s.setWebSearchEnabled);
  const scholar = useUiStore((s) => s.scholarSearchEnabled);
  const setScholar = useUiStore((s) => s.setScholarSearchEnabled);
  const t = useT();
  // no key, no button: search that cannot run must not be offerable
  // (the capabilities panel is the one place that says why)
  const webAvailable = useModels()?.capabilities?.webSearch ?? true;
  // Models on a searchless direct lane (hosted app, e.g. DeepSeek browser-
  // direct) show DISABLED toggles with the reason — a control that vanishes
  // reads as a missing feature, a disabled one explains itself. Offering a
  // live toggle would route the request through the proxy, where thinking
  // streams die of the Workers CPU allowance.
  const selectedModel = useUiStore((s) => s.selectedModel);
  const noSearchLane = directWithoutSearch(model ?? selectedModel ?? undefined);

  // the box's own icon buttons: quiet until on, then tinted in the primary
  const cls = (on: boolean) =>
    noSearchLane
      ? 'rounded-md text-muted-foreground opacity-30 cursor-not-allowed'
      : `rounded-md ${on
        ? 'text-primary bg-primary/10 hover:bg-primary/15 hover:text-primary'
        : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`;
  const icon = size <= 14 ? 'size-3' : 'size-[13px]';

  return (
    <>
      {webAvailable && (
        <Button variant="ghost" size="icon-sm"
          type="button"
          onClick={() => { if (!noSearchLane) setWeb(!web); }}
          disabled={noSearchLane}
          title={noSearchLane ? t('toolbar.searchUnavailableLane') : web ? t('toolbar.webSearch') : t('toolbar.webSearchOff')}
          className={cls(web)}
          data-web-toggle
        >
          <Globe strokeWidth={1.75} className={icon} />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm"
        type="button"
        onClick={() => { if (!noSearchLane) setScholar(!scholar); }}
        disabled={noSearchLane}
        title={noSearchLane ? t('toolbar.searchUnavailableLane') : scholar ? t('toolbar.scholarSearch') : t('toolbar.scholarSearchOff')}
        className={cls(scholar)}
        data-scholar-toggle
      >
        <GraduationCap strokeWidth={1.75} className={icon} />
      </Button>
    </>
  );
}
