import { GitBranch, Scissors, Tag, X } from 'lucide-react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import type { Highlight } from '../../types';
import { Button } from '../ui/button';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { HighlightText } from '../HighlightText';
import PanelSection from './PanelSection';

// Highlights: the list, how they pass downstream (tag / filter-only — no
// highlights at all IS the "pass everything" state), and one way to act on
// them: ask about them — they go into the panel's ask box as the passage,
// the same way a selection does.

export default function HighlightsSection({
  nodeId,
  highlights,
  highlightMode,
  onExplore,
}: {
  nodeId: string;
  highlights: Highlight[];
  highlightMode: 'off' | 'tag' | 'filter';
  onExplore: (text: string) => void;
}) {
  const removeHighlight = useStore((s) => s.removeHighlight);
  const setHighlightMode = useStore((s) => s.setHighlightMode);
  const t = useT();

  return (
    <PanelSection section="highlights" title={t('highlight.title')} meta={highlights.length}>
      {highlights.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('highlight.empty')}</p>
      ) : (
        <>
          <ul className="space-y-0.5 mb-3">
            {highlights.map((h) => (
              <li key={h.id} className="group/hl flex items-start gap-1 rounded-md py-1 pl-2.5 pr-1 hover:bg-muted/60 transition-colors">
                <span className="mt-[0.3rem] h-3 w-0.5 shrink-0 rounded-full bg-warning" aria-hidden />
                <p className="flex-1 min-w-0 pl-1.5 text-xs leading-relaxed text-foreground line-clamp-3 break-words">
                  <HighlightText text={h.text} />
                </p>
                {!isViewerMode && (
                  <Button variant="ghost" size="icon-xs"
                    onClick={() => removeHighlight(nodeId, h.id)}
                    title={t('common.delete')}
                    aria-label={t('common.delete')}
                    className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover/hl:opacity-100 focus-visible:opacity-100"
                  >
                    <X strokeWidth={1.75} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            {/* Downstream mode: tag or filter-only */}
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              value={highlightMode === 'off' ? [] : [highlightMode]}
              onValueChange={(v) => { const next = v[0]; if (next === 'tag' || next === 'filter') setHighlightMode(nodeId, next); }}
            >
              <ToggleGroupItem value="tag" title={t('highlight.hintTag')} className="text-xs">
                <Tag strokeWidth={1.75} /> {t('highlight.modeTag')}
              </ToggleGroupItem>
              <ToggleGroupItem value="filter" title={t('highlight.hintFilter')} className="text-xs">
                <Scissors strokeWidth={1.75} /> {t('highlight.modeFilter')}
              </ToggleGroupItem>
            </ToggleGroup>
            {!isViewerMode && (
              <Button variant="ghost" size="sm"
                onClick={() => onExplore(highlights.map((h) => h.text).join('\n\n'))}
                className="text-xs"
                title={t('highlight.exploreTitle')}
                data-highlight-explore
              >
                <GitBranch strokeWidth={1.75} className="text-edge-explore" />
                {t('common.explore')}
              </Button>
            )}
          </div>
        </>
      )}
    </PanelSection>
  );
}
