import { useState, useRef, useEffect } from 'react';
import { ChevronRight, GitBranch, Scissors, Tag, X } from 'lucide-react';
import { useStore } from '../../store';
import { isImeComposing } from '../../utils';
import { useT } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import type { Highlight } from '../../types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { HighlightText } from '../HighlightText';

// Highlights: the list, how they pass downstream (tag / filter-only — no
// highlights at all IS the "pass everything" state), and one way to act on
// them: ask a question about them (an explore branch).

export default function HighlightsSection({
  nodeId,
  highlights,
  highlightMode,
}: {
  nodeId: string;
  highlights: Highlight[];
  highlightMode: 'off' | 'tag' | 'filter';
}) {
  const addQuestion = useStore((s) => s.addQuestion);
  const removeHighlight = useStore((s) => s.removeHighlight);
  const setHighlightMode = useStore((s) => s.setHighlightMode);
  const t = useT();

  const [highlightExploreContext, setHighlightExploreContext] = useState('');
  const [highlightExploreInput, setHighlightExploreInput] = useState('');
  const highlightExploreRef = useRef<HTMLInputElement>(null);

  // Auto-focus highlight explore input when context is set
  useEffect(() => {
    if (highlightExploreContext) {
      setTimeout(() => highlightExploreRef.current?.focus(), 100);
    }
  }, [highlightExploreContext]);

  const submitExplore = () => {
    if (!highlightExploreInput.trim()) return;
    addQuestion(highlightExploreInput.trim(), { parentId: nodeId, branchContext: highlightExploreContext });
    setHighlightExploreInput('');
    setHighlightExploreContext('');
  };

  return (
    <div className="panel-card px-4 py-3" data-panel-section="highlights">
      <details className="group">
        <summary className="text-2xs font-semibold text-warning cursor-pointer hover:text-warning/80 transition-colors flex items-center gap-1.5 select-none">
          <ChevronRight size={12} strokeWidth={1.75} className="transition-transform group-open:rotate-90" />
          {t('highlight.title')}
          {highlights.length > 0 && (
            <span className="text-muted-foreground font-normal tabular-nums">{highlights.length}</span>
          )}
        </summary>
        <div className="mt-2">
          {highlights.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">{t('highlight.empty')}</p>
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
                <Button variant="ghost" size="sm"
                  onClick={() => setHighlightExploreContext(highlights.map((h) => h.text).join('\n\n'))}
                  className="text-xs"
                  title={t('highlight.exploreTitle')}
                >
                  <GitBranch strokeWidth={1.75} className="text-edge-explore" />
                  {t('common.explore')}
                </Button>
              </div>
              {/* Highlight Explore input */}
              {highlightExploreContext && (
                <div className="mt-3 flex gap-1.5">
                  <Input
                    ref={highlightExploreRef}
                    type="text"
                    value={highlightExploreInput}
                    onChange={(e) => setHighlightExploreInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isImeComposing(e)) submitExplore();
                      if (e.key === 'Escape') { setHighlightExploreContext(''); setHighlightExploreInput(''); }
                    }}
                    placeholder={t('highlight.explorePlaceholder')}
                    className="flex-1 border-primary/30 bg-primary/5"
                  />
                  <Button size="sm"
                    onClick={submitExplore}
                    className="shrink-0"
                  >
                    {t('common.go')}
                  </Button>
                  <Button variant="ghost" size="sm"
                    onClick={() => { setHighlightExploreContext(''); setHighlightExploreInput(''); }}
                    className="text-xs text-muted-foreground hover:text-muted-foreground shrink-0"
                  >
                    <X strokeWidth={1.75} />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </details>
    </div>
  );
}
