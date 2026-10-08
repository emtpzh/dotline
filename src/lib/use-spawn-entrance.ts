import { useLayoutEffect, useState, type RefObject } from 'react';
import { useReactFlow } from '@xyflow/react';
import { MOTION, reducedMotion } from './motion';
import { spawnOf, CARD_LAG_MS } from './spawn-motion';

const EASE_ENTER = 'cubic-bezier(0.05, 0.7, 0.1, 1)'; // --ease-enter

/**
 * A card born from another grows out of the parent's handle along its new
 * wire (lib/spawn-motion) instead of fading in where it lands. Returns true
 * when it does, so the card skips its ordinary entrance fade.
 *
 * Played with the Web Animations API on the card's own element: the
 * card's CSS `animation` belongs to its states (use-entrance-fade), and a
 * WAAPI animation composes beside them instead of taking that property.
 */
export function useSpawnEntrance(id: string, ref: RefObject<HTMLElement | null>): boolean {
  const rf = useReactFlow();
  const [spawn] = useState(() => (reducedMotion() ? undefined : spawnOf(id)));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!spawn || !el) return;
    const self = rf.getNode(id), parent = rf.getNode(spawn.from);
    if (!self || !parent) return;
    const pw = parent.measured?.width ?? 520, ph = parent.measured?.height ?? 200;
    const beside = spawn.via === 'beside';
    // where the wire leaves the parent, and the point of the card it reaches
    const origin = beside
      ? { x: parent.position.x + pw, y: parent.position.y + ph * spawn.ratio }
      : { x: parent.position.x + pw / 2, y: parent.position.y + ph };
    const anchor = beside
      ? { x: self.position.x, y: self.position.y + 40 }
      : { x: self.position.x + (self.measured?.width ?? 520) / 2, y: self.position.y };
    const dx = origin.x - anchor.x, dy = origin.y - anchor.y;
    const transformOrigin = beside ? '0 40px' : '50% 0';
    const anim = el.animate([
      { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(0.92)`, transformOrigin },
      { opacity: 1, transform: 'none', transformOrigin },
    ], { duration: MOTION.enter, delay: spawn.delay + CARD_LAG_MS, easing: EASE_ENTER, fill: 'backwards' });
    return () => anim.cancel();
    // mount only: a card is born once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return !!spawn;
}
