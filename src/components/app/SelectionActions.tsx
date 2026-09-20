import { GitBranch, Star } from 'lucide-react';
import { Popover, PopoverContent } from '../ui/popover';
import { Button } from '../ui/button';
import { useT } from '../../i18n';

// Select a passage, and the two divergence gestures come to it: explore
// (branch from these words) and highlight. The same bar answers in the node
// card, the focus panel and the reading viewer — one grammar, three places.
//
// It rides a Popover anchored to the selection's own rectangle, so it is
// portaled out of whatever box the text sits in: a dialog with its own
// scroll and `overflow-hidden` used to clip it, and near the top of a
// viewport it now flips below the passage instead of being pinned.

export default function SelectionActions({
  text,
  anchor,
  onExplore,
  onHighlight,
  boundary,
}: {
  text: string;
  anchor: { getBoundingClientRect: () => DOMRect } | null;
  /** The box the bar must stay inside — a reading pane with its own scroll.
      Without one it only avoids the viewport's edges. */
  boundary?: Element | null;
  onExplore: (text: string) => void;
  onHighlight: (text: string) => void;
}) {
  const t = useT();
  if (!text || !anchor) return null;
  return (
    <Popover open>
      <PopoverContent
        anchor={anchor}
        collisionBoundary={boundary ?? undefined}
        side="top"
        sideOffset={8}
        // the selection must survive the click that acts on it
        initialFocus={false}
        finalFocus={false}
        className="w-auto flex-row gap-1 p-1"
        onMouseDown={(e) => e.preventDefault()}
      >
        <Button
          size="sm"
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onExplore(text); }}
          className="whitespace-nowrap"
        >
          <GitBranch strokeWidth={1.75} /> {t('common.explore')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onHighlight(text); }}
          className="bg-warning text-warning-foreground hover:bg-warning/90 hover:text-warning-foreground whitespace-nowrap"
        >
          <Star strokeWidth={1.75} /> {t('common.highlight')}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
