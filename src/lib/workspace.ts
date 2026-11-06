// The open canvases: the tabs along the top bar, in the order the person
// keeps them — the desktops of this app. A canvas is open (a tab), stashed
// (out of the tabs, kept in the library as it was left) or archived (out
// of the library's lists too). The canvas in view is always open.
//
// Pure rules over canvas ids, so they hold the same wherever they are
// applied and can be tested on their own (scripts/test-workspace.mjs).

/** Open a canvas: it joins the tabs right after `after` (the tab being
 *  left), or at the end; a canvas already open stays where it is. */
export function withOpened(open: readonly string[], id: string, after?: string | null): string[] {
  if (open.includes(id)) return [...open];
  const at = after ? open.indexOf(after) : -1;
  return at < 0 ? [...open, id] : [...open.slice(0, at + 1), id, ...open.slice(at + 1)];
}

/** The tab that takes the place of one leaving: the one to its right,
 *  else the one to its left; null when it was the only one. */
export function neighbourOf(open: readonly string[], id: string): string | null {
  const at = open.indexOf(id);
  if (at < 0) return open[0] ?? null;
  return open[at + 1] ?? open[at - 1] ?? null;
}

/** A canvas leaves the tabs (stashed, archived, deleted). */
export function withClosed(open: readonly string[], id: string): string[] {
  return open.filter((x) => x !== id);
}

/** Move a tab to `to`, the index it should have once it is there. */
export function withMoved(open: readonly string[], id: string, to: number): string[] {
  const from = open.indexOf(id);
  if (from < 0) return [...open];
  const rest = open.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Keep the tabs honest against the canvas list: unknown, archived and
 *  repeated ids go, and the canvas in view is open (first, if it was not). */
export function reconcileOpen(
  open: readonly string[] | undefined,
  canvases: readonly { id: string; archived?: boolean }[],
  activeId: string | null,
): string[] {
  const live = new Set(canvases.filter((c) => !c.archived).map((c) => c.id));
  const out: string[] = [];
  for (const id of open ?? []) if (live.has(id) && !out.includes(id)) out.push(id);
  if (activeId && canvases.some((c) => c.id === activeId) && !out.includes(activeId)) out.unshift(activeId);
  return out;
}

/** The Nth tab, counted from 1, the way browsers number theirs: 9 is
 *  always the last one. */
export function tabAt(open: readonly string[], n: number): string | null {
  if (!open.length || n < 1) return null;
  if (n >= 9) return open[open.length - 1];
  return open[n - 1] ?? null;
}

/** The tab beside the one in view, wrapping around the ends. */
export function tabBeside(open: readonly string[], activeId: string | null, step: 1 | -1): string | null {
  if (open.length < 2) return null;
  const at = activeId ? open.indexOf(activeId) : -1;
  if (at < 0) return open[0];
  return open[(at + step + open.length) % open.length];
}
