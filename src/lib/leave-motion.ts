import { MOTION, reducedMotion } from './motion';

const EASE_EXIT = 'cubic-bezier(0.3, 0, 0.8, 0.15)'; // --ease-exit
const leaving = new Set<string>();

/**
 * A deletion plays out before it lands: the cards shrink a little and fade,
 * their wires fade with them, and only then does `remove` change the store
 * (and the layout glide closes the gap). A card that vanishes in one frame
 * leaves the user unsure which one went — on a zoomed-out map especially.
 *
 * Purely visual: it animates what the canvas already shows and never
 * touches node data, history or persistence. With nothing on screen to
 * animate (another runtime, reduced motion, cards scrolled away), `remove`
 * runs at once. Cards already on their way out are not deleted twice.
 */
export function leaveThen(nodeIds: Iterable<string>, edgeIds: Iterable<string>, remove: () => void): void {
  const ids = [...nodeIds].filter((id) => !leaving.has(id));
  if (ids.length === 0) return;
  if (typeof document === 'undefined' || reducedMotion()) { remove(); return; }
  const cards = ids
    .map((id) => document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.firstElementChild)
    .filter((el): el is Element => !!el);
  if (cards.length === 0) { remove(); return; }
  const wires = [...edgeIds]
    .map((id) => document.querySelector(`.react-flow__edge[data-id="${CSS.escape(id)}"]`))
    .filter((el): el is Element => !!el);
  const timing = { duration: MOTION.exit, easing: EASE_EXIT, fill: 'forwards' as const };
  // the node wrapper carries the card's position in its transform: animate
  // the card inside it
  for (const el of cards) el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.96)' }], timing);
  for (const el of wires) el.animate([{ opacity: 1 }, { opacity: 0 }], timing);
  ids.forEach((id) => leaving.add(id));
  setTimeout(() => {
    ids.forEach((id) => leaving.delete(id));
    remove();
  }, MOTION.exit);
}
