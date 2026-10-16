// Pull past the top of a scroll box to reveal what sits above its content,
// the way a rubber band gives: a gap opens with resistance and the hidden
// row fades into it; let go once it shows in full and it stays, let go
// earlier and it springs shut. Only a gesture that STARTS at the top pulls —
// the momentum of scrolling up to the top never opens it by itself.
//
// The slot is driven straight on the DOM while the gesture runs (no render
// per wheel tick); `onReveal` hands it back to React once it has opened.
// It holds one element, the row, bottom-aligned so the row slides in from
// the top edge as the gap opens; an empty row (nothing to reveal) never pulls.

const RESISTANCE = 0.4;
const MAX_PULL = 96;
// how far past the row's own height a pull must go to keep it open
const OVERSHOOT = 20;
// a wheel gesture has ended when no event came for this long
const IDLE_MS = 180;

export function pullReveal(scroller: HTMLElement, slot: HTMLElement, onReveal: () => void): () => void {
  let pull = 0;
  let lastWheel = -Infinity;
  let fromTop = false;
  let idle = 0;
  let touchY: number | null = null;
  let settling = 0;

  const row = () => slot.firstElementChild as HTMLElement | null;
  const natural = () => row()?.offsetHeight ?? 0;
  const pullable = () => !!row()?.firstElementChild;
  const show = (h: number) => {
    slot.style.transition = 'none';
    slot.style.height = `${h}px`;
    slot.style.opacity = String(Math.min(1, h / Math.max(1, natural())));
  };
  const release = () => {
    if (pull === 0) return;
    const full = pull >= natural() + OVERSHOOT;
    pull = 0;
    slot.style.transition = 'height var(--dur-base) var(--ease-standard), opacity var(--dur-base) var(--ease-standard)';
    slot.style.height = full ? `${natural()}px` : '0px';
    slot.style.opacity = full ? '1' : '0';
    if (full) {
      settling = window.setTimeout(() => { slot.style.transition = ''; onReveal(); }, 220);
    }
  };
  const pullBy = (dy: number) => {
    pull = Math.max(0, Math.min(Math.max(MAX_PULL, natural() + OVERSHOOT), pull + dy * RESISTANCE));
    show(pull);
  };

  const onWheel = (e: WheelEvent) => {
    if (e.timeStamp - lastWheel > IDLE_MS) fromTop = scroller.scrollTop <= 0;
    lastWheel = e.timeStamp;
    if (!fromTop || scroller.scrollTop > 0 || !pullable()) return;
    if (e.deltaY < 0 || pull > 0) pullBy(-e.deltaY);
    window.clearTimeout(idle);
    idle = window.setTimeout(release, IDLE_MS);
  };
  const onTouchStart = (e: TouchEvent) => {
    touchY = scroller.scrollTop <= 0 && pullable() ? e.touches[0].clientY : null;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (touchY === null) return;
    const dy = e.touches[0].clientY - touchY;
    touchY = e.touches[0].clientY;
    if (dy > 0 || pull > 0) pullBy(dy);
  };
  const onTouchEnd = () => { touchY = null; release(); };

  scroller.addEventListener('wheel', onWheel, { passive: true });
  scroller.addEventListener('touchstart', onTouchStart, { passive: true });
  scroller.addEventListener('touchmove', onTouchMove, { passive: true });
  scroller.addEventListener('touchend', onTouchEnd);
  scroller.addEventListener('touchcancel', onTouchEnd);
  return () => {
    window.clearTimeout(idle);
    window.clearTimeout(settling);
    scroller.removeEventListener('wheel', onWheel);
    scroller.removeEventListener('touchstart', onTouchStart);
    scroller.removeEventListener('touchmove', onTouchMove);
    scroller.removeEventListener('touchend', onTouchEnd);
    scroller.removeEventListener('touchcancel', onTouchEnd);
  };
}
