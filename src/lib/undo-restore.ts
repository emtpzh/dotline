import type { ThoughtNode } from '../types';

// What an undo or redo puts back: the canvas as a snapshot holds it, less
// what runs did. Undo steps over what the person did, never over a run.
// Pure, so the store's history and a test hold it the same way.

/** A run answers the node, or its binding waits for the run's turn. */
const running = (n: ThoughtNode): boolean => n.data.isLoading || !!n.data.run;

/**
 * A node a run answers — in the snapshot or now — keeps its data as it
 * stands now: a snapshot taken mid-run would bring the run back with nothing
 * left to end it, loading for good. A node the step brings back has no run
 * going. `stop`: the nodes the step takes away while a run answers them —
 * their runs go with them, the way deleting a node takes its run.
 */
export function restoreNodes(current: ThoughtNode[], snapshot: ThoughtNode[]): { nodes: ThoughtNode[]; stop: string[] } {
  const now = new Map(current.map((n) => [n.id, n]));
  const kept = new Set(snapshot.map((n) => n.id));
  const nodes = snapshot.map((s) => {
    const c = now.get(s.id);
    if (c) return running(s) || running(c) ? { ...s, data: c.data } : s;
    return s.data.isLoading ? { ...s, data: { ...s.data, isLoading: false } } : s;
  });
  return { nodes, stop: current.filter((n) => !kept.has(n.id) && running(n)).map((n) => n.id) };
}
