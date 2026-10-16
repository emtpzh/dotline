// A scroll box tells where it has more: its top edge fades once you have
// scrolled, its bottom edge while text continues below — no rules drawn
// across it (base.css .tdag-scroll-fade). A React 19 ref callback: it
// returns its own cleanup. Content that grows (streaming, a section
// opening) re-measures through its children's sizes.

export function scrollFade(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  const update = () => {
    el.toggleAttribute('data-fade-top', el.scrollTop > 1);
    el.toggleAttribute('data-fade-bottom', el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  };
  const sizes = new ResizeObserver(update);
  const watch = () => {
    sizes.disconnect();
    sizes.observe(el);
    for (const child of el.children) sizes.observe(child);
    update();
  };
  const children = new MutationObserver(watch);
  children.observe(el, { childList: true });
  el.addEventListener('scroll', update, { passive: true });
  watch();
  return () => {
    el.removeEventListener('scroll', update);
    children.disconnect();
    sizes.disconnect();
  };
}
