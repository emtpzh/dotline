import { useState, useRef, useEffect } from 'react';
import { ChevronRight, GitBranch, Scissors, Star, Tag, X } from 'lucide-react';
import { useStore } from '../../store';
import { isImeComposing } from '../../utils';
import { useT } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import type { Highlight } from '../../types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

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
    <div className="panel-card px-4 py-3">
      <details className="group">
        <summary className="text-2xs font-semibold text-warning cursor-pointer hover:text-warning/90 transition-colors flex items-center gap-1.5 select-none">
          <ChevronRight size={12} strokeWidth={1.75} className="transition-transform group-open:rotate-90" />
          {t('highlight.title')}
          {highlights.length > 0 && (
            <span className="text-muted-foreground font-normal">({highlights.length})</span>
          )}
        </summary>
        <div className="mt-2">
          {highlights.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">{t('highlight.empty')}</p>
          ) : (
            <>
              <div className="space-y-1.5 mb-3">
                {highlights.map((h) => (
                  <div key={h.id} className="flex items-start gap-2 bg-warning/10 rounded-lg px-3 py-2 group/hl">
                    <span className="text-xs text-warning flex-1 leading-relaxed">
                      <Star size={14} strokeWidth={1.75} className="inline" /> {h.text.slice(0, 80)}{h.text.length > 80 ? '…' : ''}
                    </span>
                    {!isViewerMode && <Button variant="ghost"
                      onClick={() => removeHighlight(nodeId, h.id)}
                      className="text-warning hover:text-destructive/90 shrink-0 opacity-0 group-hover/hl:opacity-100"
                    >
                      <X strokeWidth={1.75} />
                    </Button>}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                {/* Downstream mode: tag or filter-only */}
                <div className="flex items-center gap-1.5">
                  {([
                    { mode: 'tag' as const, icon: <Tag size={14} strokeWidth={1.75} />, label: t('highlight.modeTag') },
                    { mode: 'filter' as const, icon: <Scissors size={14} strokeWidth={1.75} />, label: t('highlight.modeFilter') },
                  ]).map(({ mode, icon, label }) => (
                    <Button variant="ghost"
                      key={mode}
                      onClick={() => setHighlightMode(nodeId, mode)}
                      title={mode === 'tag' ? t('highlight.hintTag') : t('highlight.hintFilter')}
                      className={`text-xs px-2.5 py-1.5 rounded-lg transition-colors flex items-center gap-1 ${
                        highlightMode === mode
                          ? 'bg-primary text-white'
                          : 'bg-muted text-muted-foreground hover:bg-border'
                      }`}
                    >
                      <span>{icon}</span> {label}
                    </Button>
                  ))}
                </div>
                <Button variant="ghost" size="sm"
                  onClick={() => setHighlightExploreContext(highlights.map((h) => h.text).join('\n\n'))}
                  className="text-xs bg-primary/10 hover:bg-primary/20 text-primary"
                  title={t('highlight.exploreTitle')}
                >
                  <GitBranch strokeWidth={1.75} />
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
