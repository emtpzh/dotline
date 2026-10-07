import { useMemo } from 'react';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { describeModel } from '../../lib/use-models';
import { footprint } from '../../lib/turn-insight';
import { sessionWhy } from '../../lib/session-why';
import { formatStamp } from '../../utils';
import { useT, fmt } from '../../i18n';
import type { ThoughtData } from '../../types';
import { Button } from '../ui/button';

// Where this turn came from: the provenance the canvas card no longer
// carries — the model and effort, when, how much, the session it went on
// in, the web search, the files it touched, what it was condensed from.
// Each row shows only when there is something to say; the card points
// here from its name row's tool marks.

export default function TurnSection({ data, onFocusNode }: { data: ThoughtData; onFocusNode?: (id: string) => void }) {
  const t = useT();
  const i = data.responseIndex;
  const model = data.generatedBy?.[i];
  const at = data.generatedAts?.[i];
  const searched = data.gatewaySearches?.[i];
  const link = data.sessionLink;
  const why = useStore((s) => (link?.kind === 'new' ? sessionWhy(link, s.nodes, t) : null));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the exact field read
  const files = useMemo(() => footprint(data), [data.steps]);
  const condensed = data.condensedFrom ?? [];

  const rows: { key: string; label: string; value: React.ReactNode }[] = [];
  if (model) rows.push({ key: 'model', label: t('turn.model'), value: <span className="font-mono">{describeModel(model, data.generatedEfforts?.[i])}</span> });
  if (at) rows.push({ key: 'time', label: t('turn.time'), value: <span className="font-mono">{formatStamp(at)}</span> });
  if (data.response && data.tokenCount > 0) rows.push({ key: 'usage', label: t('turn.usage'), value: <span className="font-mono">{fmt(t('turn.tokens'), { n: data.tokenCount.toLocaleString() })}</span> });
  if (link) rows.push({
    key: 'session', label: t('turn.session'),
    value: link.kind === 'new'
      ? <span title={t('session.newBody')}>{why ? fmt(t('session.newBadge'), { why }) : t('session.newAction')}</span>
      : fmt(t('session.forkLine'), { n: link.turn }),
  });
  if (searched) rows.push({ key: 'web', label: t('turn.web'), value: t('node.gatewaySearched') });
  if (files.length > 0) {
    const changed = files.filter((f) => f.op !== 'read');
    const read = files.filter((f) => f.op === 'read');
    rows.push({
      key: 'files', label: t('turn.files'),
      value: (
        <span className="font-mono text-2xs leading-relaxed text-muted-foreground" data-footprint>
          {changed.map((f) => (
            <span key={f.path} className="block text-foreground truncate" title={f.path}>{t('face.filesChanged')} {f.name}</span>
          ))}
          {read.length > 0 && (
            <span className="block" title={read.map((f) => f.path).join('\n')}>
              {t('face.filesRead')} {read.map((f) => f.name).join(t('turn.listSep'))}
            </span>
          )}
        </span>
      ),
    });
  }
  if (condensed.length > 0) rows.push({
    key: 'condensed', label: t('turn.condensed'),
    value: (
      <Button variant="link" size="xs" className="h-auto p-0 text-xs text-foreground underline decoration-muted-foreground/50 underline-offset-2"
        title={t('node.condensedFromTitle')}
        data-condensed-from
        onClick={() => {
          // provenance travels by link: light the original run on the canvas
          useUiStore.getState().setCondenseHighlightIds(condensed);
          onFocusNode?.(condensed[0]);
          window.setTimeout(() => useUiStore.getState().setCondenseHighlightIds([]), 2600);
        }}
      >
        {fmt(t('turn.condensedCount'), { n: condensed.length })}
      </Button>
    ),
  });
  if (data.archived) rows.push({ key: 'archived', label: t('turn.archive'), value: <span title={t('archive.badgeTitle')}>{t('archive.badge')}</span> });

  if (rows.length === 0) return null;
  return (
    <div className="panel-card px-4 py-3" data-panel-section="turn">
      <label className="text-2xs font-semibold text-muted-foreground">{t('turn.title')}</label>
      <dl className="mt-1.5 grid grid-cols-[4rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        {rows.map((r) => (
          <div key={r.key} className="contents" data-turn-row={r.key}>
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0 text-foreground">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
