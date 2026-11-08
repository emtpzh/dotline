// Hold ⌥ and the two-finger scroll moves the canvas wherever the pointer
// rests. While the canvas slides, cards pass under the still pointer, and the
// first one with scrolling text (`nowheel`) would take the scroll for itself
// and stop the pan dead. With ⌥ held the canvas gets the wheel first. Pinch
// and ⌘-wheel are left alone and still zoom.
//
// A gesture that starts with ⌥ held stays with the canvas until it comes to
// rest, so letting go of ⌥ early never drops the coasting tail into a card.
//
// Mac only: ⌥ is free there, while Alt on Windows/Linux opens the window's
// menu bar when it is released.

// a wheel gesture, its coasting included, has ended when no event came for this long
const IDLE_MS = 180;

export const OPTION_PAN = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.userAgent);

/** `pan` moves the canvas by a screen-space delta, or returns false when the
 *  canvas must hold still; the wheel then goes on as usual. */
export function optionPan(root: HTMLElement, pan: (dx: number, dy: number) => boolean): () => void {
  if (!OPTION_PAN) return () => {};
  let last = -Infinity;
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) return;
    if (!e.altKey && e.timeStamp - last > IDLE_MS) return;
    // a line-mode wheel moves 20px a line, as the canvas's own scroll-pan does
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 1;
    if (!pan(-e.deltaX * unit, -e.deltaY * unit)) return;
    last = e.timeStamp;
    // keep it from the card underneath, and from the canvas's own wheel handler
    e.preventDefault();
    e.stopPropagation();
  };
  root.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => root.removeEventListener('wheel', onWheel, { capture: true });
}
