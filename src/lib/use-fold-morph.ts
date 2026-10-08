import { useLayoutEffect, type RefObject } from 'react';
import { MOTION, reducedMotion } from './motion';
import { takeFoldFrom } from './fold-motion';

const EASE_STANDARD = 'cubic-bezier(0.2, 0, 0, 1)'; // --ease-standard

/**
 * The card's half of lib/fold-motion: after a fold flips, play the card's
 * height from where it was to where it now is. The wires follow it frame by
 * frame (React Flow measures the card as it moves); what hangs below
 * re-seats once the morph is over (toggleCollapse waits for it).
 */
export function useFoldMorph(id: string, collapsed: boolean, ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const from = takeFoldFrom(id);
    const el = ref.current;
    if (from === undefined || !el || reducedMotion()) return;
    const to = el.offsetHeight;
    if (Math.abs(to - from) < 2) return;
    el.animate(
      [{ height: `${from}px`, overflow: 'hidden' }, { height: `${to}px`, overflow: 'hidden' }],
      { duration: MOTION.base, easing: EASE_STANDARD },
    );
  }, [id, collapsed, ref]);
}
