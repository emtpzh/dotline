import { useMemo } from 'react';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { footprint } from '../../lib/turn-insight';
import { sessionWhy } from '../../lib/session-why';
import { turnOf } from '../../lib/sessions/turn';
import { localPathOf, openLocalPath } from '../../lib/local-path';
import { formatStamp } from '../../utils';
import { useT, fmt, useDateLocale } from '../../i18n';
import type { ThoughtData } from '../../types';
import { Button } from '../ui/button';
import PanelSection from './PanelSection';
import { LINE_CLASS } from './line';

// What a turn leaves behind, said where it is read. When it ran and how
// much: one faint time at the end of the answer's actions, the rest on
// hover — the model and where it ran are the title row's to say. The files
// it changed: one folded line (reads are the tool calls' to show). What it
// was condensed from: one line that lights the originals on the canvas.

/** The answer's time, short: today's as a clock, an older one with its day. */
export function TurnStamp({ data }: { data: ThoughtData }) {
  const t = useT();
  const locale = useDateLocale();
  const i = data.responseIndex;
  const at = data.generatedAts?.[i];
  const link = data.sessionLink;
  const why = useStore((s) => (link?.kind === 'new' ? sessionWhy(link, s.nodes, t) : null));
  if (!at) return null;
  const d = new Date(at);
  if (isNaN(d.getTime())) return null;
  const today = d.toDateString() === new Date().toDateString();
  const short = d.toLocaleString(locale, today ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const detail = [
    formatStamp(at),
    data.response && data.tokenCount > 0 ? fmt(t('turn.tokens'), { n: data.tokenCount.toLocaleString() }) : null,
    data.gatewaySearches?.[i] ? t('transcript.stampWeb') : null,
    link ? (link.kind === 'new' ? (why ? fmt(t('session.newBadge'), { why }) : t('session.newAction')) : fmt(t('session.forkLine'), { n: link.turn })) : null,
    data.archived ? t('archive.badge') : null,
  ].filter(Boolean).join(' · ');
  return (
    <span className="ml-auto pr-1 text-xs tabular-nums text-muted-foreground/70" title={detail} data-turn-stamp>{short}</span>
  );
}

/** The files the turn changed, folded; each opens where it lives. */
export function ChangedFiles({ data }: { data: ThoughtData }) {
  const t = useT();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the exact field read
  const changed = useMemo(() => footprint(data).filter((f) => f.op !== 'read'), [data.steps]);
  if (changed.length === 0) return null;
  const cwd = turnOf(data)?.cwd ?? data.importSource?.cwd ?? data.cwd ?? null;
  const dirOf = (path: string) => {
    const rel = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
    return rel.split('/').slice(0, -1).join('/');
  };
  return (
    <PanelSection section="files" title={changed.length === 1 ? t('transcript.changedOne') : fmt(t('transcript.changed'), { n: changed.length })}>
      <div className="flex flex-col" data-footprint>
        {changed.map((f) => {
          const full = localPathOf(f.path, cwd);
          return (
            <Button key={f.path} variant="ghost" disabled={!full}
              onClick={() => { if (full) void openLocalPath(full); }}
              title={full ? `${t('transcript.openFile')} · ${f.path}` : f.path}
              className="h-auto min-w-0 justify-start gap-2 px-1 py-0.5 text-xs font-normal disabled:opacity-100">
              <span className="shrink-0 font-mono text-foreground">{f.name}</span>
              <span className="truncate font-mono text-2xs text-muted-foreground/70">{dirOf(f.path)}</span>
              <span className="ml-auto shrink-0 text-2xs text-muted-foreground/70">{t(f.op === 'edit' ? 'transcript.opEdit' : 'transcript.opWrite')}</span>
            </Button>
          );
        })}
      </div>
    </PanelSection>
  );
}

/** The run this card was condensed from: one click lights it on the canvas. */
export function CondensedFrom({ data, onFocusNode }: { data: ThoughtData; onFocusNode?: (id: string) => void }) {
  const t = useT();
  const condensed = data.condensedFrom ?? [];
  if (condensed.length === 0) return null;
  return (
    <Button variant="ghost" className={`${LINE_CLASS} h-auto p-0 font-normal hover:bg-transparent`}
      title={t('node.condensedFromTitle')}
      data-condensed-from
      onClick={() => {
        // provenance travels by link: light the original run on the canvas
        useUiStore.getState().setCondenseHighlightIds(condensed);
        onFocusNode?.(condensed[0]);
        window.setTimeout(() => useUiStore.getState().setCondenseHighlightIds([]), 2600);
      }}
    >
      {t('turn.condensed')} {fmt(t('turn.condensedCount'), { n: condensed.length })}
    </Button>
  );
}
