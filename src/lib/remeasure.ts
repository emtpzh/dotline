/**
 * A card asking React Flow to measure it again (its handles move between
 * zoom tiers), gathered with the others that ask in the same task.
 *
 * useUpdateNodeInternals measures each call in an animation frame callback
 * of its own and reports each measurement as a change of its own. Cards ask
 * together — every card mounting at once on a canvas fitted whole, every
 * card on screen crossing into the far tier — so the store was written once
 * per card, and each write re-routed every wire on screen: a reload of a
 * 380-card canvas made some 200 writes, five seconds of main thread.
 * Gathered, the cards are measured in one call and written once.
 */
const pending = new Set<string>();
let update: ((ids: string[]) => void) | null = null;

/** `updateNodeInternals` is the asking card's useUpdateNodeInternals(); the
 *  app has one flow, so the first card's measures the whole batch. */
export function remeasure(id: string, updateNodeInternals: (ids: string[]) => void): void {
  pending.add(id);
  if (update) return;
  update = updateNodeInternals;
  queueMicrotask(() => {
    const ids = [...pending];
    const run = update!;
    pending.clear();
    update = null;
    run(ids);
  });
}
