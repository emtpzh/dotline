import { useEffect, useState } from 'react';

/**
 * One-shot entrance class for canvas cards.
 *
 * `.animate-fade-in` owns the `animation` property — and so does every state a
 * card can enter LATER: the selected glow, the loading border, the beacon.
 * The last class to set the shorthand wins, so while a card was selected the
 * entrance animation was simply switched off; removing that state handed
 * `animation` back to `.animate-fade-in`, which REPLAYED the entrance: the
 * card vanished (opacity 0), slid up from 8px and faded back in under the
 * cursor. Deselecting, or selecting a different card, made the previous one
 * do that — a canvas that blinked on every click.
 *
 * An entrance happens exactly once, so the class is dropped from the list as
 * soon as it has played (a hair past the animation's own 0.3s). State
 * animations can then come and go without ever replaying it — including the
 * loading border, which used to blink a card once its answer arrived.
 */
export function useEntranceFade(ms = 320): string {
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setEntering(false), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return entering ? 'animate-fade-in' : '';
}
