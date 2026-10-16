import { useState } from 'react';
import { GitBranch, Highlighter } from 'lucide-react';
import { Popover, PopoverContent } from '../ui/popover';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import { useT } from '../../i18n';

// Select a passage, and the two divergence gestures come to it: explore
// (branch from these words) and highlight. The same bar answers in the node
// card and the focus panel — one grammar, both places.
//
// It rides a Popover anchored to the selection's own rectangle, so it is
// portaled out of whatever box the text sits in: a dialog with its own
// scroll and `overflow-hidden` used to clip it, and near the top of a
// viewport it now flips below the passage instead of being pinned.
//
// One bar per selection: a new passage mounts a fresh one (it rises in at
// the new words instead of teleporting there), and a cleared selection
// keeps the last anchor long enough for the bar to fade out where it was.

type Anchor = { getBoundingClientRect: () => DOMRect };

export default function SelectionActions({
  text,
  anchor,
  onExplore,
  onHighlight,
}: {
  text: string;
  anchor: Anchor | null;
  onExplore: (text: string) => void;
  onHighlight: (text: string) => void;
}) {
  const t = useT();
  const open = !!text && !!anchor;
  const [shown, setShown] = useState<{ text: string; anchor: Anchor; key: number } | null>(null);
  if (open && shown?.anchor !== anchor) {
    setShown({ text, anchor, key: (shown?.key ?? 0) + 1 });
  }
  if (!shown) return null;

  const act = (e: React.MouseEvent, run: (text: string) => void) => {
    e.preventDefault();
    e.stopPropagation();
    if (open) run(shown.text);
  };

  return (
    <Popover key={shown.key} open={open}>
      <PopoverContent
        anchor={shown.anchor}
        side="top"
        sideOffset={6}
        // the selection must survive the click that acts on it
        initialFocus={false}
        finalFocus={false}
        className="w-auto flex-row items-center gap-0.5 rounded-lg p-0.5 shadow-lg duration-150 ease-out data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1"
        onMouseDown={(e) => e.preventDefault()}
      >
        <Button
          variant="ghost"
          size="sm"
          onMouseDown={(e) => act(e, onExplore)}
          className="whitespace-nowrap"
        >
          <GitBranch strokeWidth={1.75} className="text-edge-explore" /> {t('common.explore')}
        </Button>
        <Separator orientation="vertical" className="my-1.5 self-stretch" />
        <Button
          variant="ghost"
          size="sm"
          onMouseDown={(e) => act(e, onHighlight)}
          className="whitespace-nowrap"
        >
          <Highlighter strokeWidth={1.75} className="text-warning" /> {t('common.highlight')}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
