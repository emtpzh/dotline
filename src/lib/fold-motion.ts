/**
 * Folding and unfolding a card changes its height smoothly instead of in
 * one frame. The store notes the card's on-screen height just before the
 * fold flips (it is the one place every fold goes through); the card
 * plays from that height to its new one when it re-renders
 * (lib/use-fold-morph). Never in node data; a no-op off the browser.
 */
const heights = new Map<string, number>();

export function noteFoldFrom(nodeId: string): void {
  if (typeof document === 'undefined') return;
  const card = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`)?.firstElementChild as HTMLElement | null | undefined;
  if (card) heights.set(nodeId, card.offsetHeight);
}

export function takeFoldFrom(nodeId: string): number | undefined {
  const h = heights.get(nodeId);
  heights.delete(nodeId);
  return h;
}
