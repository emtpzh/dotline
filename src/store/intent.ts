import type { ThoughtNode, ThoughtEdge } from '../types';
import { useUiStore } from '../lib/ui-store';
import { isAgentModel } from '../lib/agents/runtimes';
import { effectiveIntent, type RunIntent } from '../lib/run-intent';

// The store-side half of lib/run-intent: where the defaults come from (the
// global picker) and which nodes count as a node's parents.

/** Where a root starts: the global pick and, for an agent entry, its effort and access level. */
export function globalIntent(): RunIntent {
  const { selectedModel, agentEffort, agentAccess } = useUiStore.getState();
  if (!selectedModel) return {};
  return isAgentModel(selectedModel) ? { model: selectedModel, effort: agentEffort, access: agentAccess } : { model: selectedModel };
}

/** The nodes a node grows off: its incoming edges, references and watch edges aside. */
export function parentsOf(nodeId: string, nodes: ThoughtNode[], edges: ThoughtEdge[]): ThoughtNode['data'][] {
  return edges
    .filter((e) => e.target === nodeId && !e.data?.isCrossLink)
    .map((e) => nodes.find((n) => n.id === e.source)?.data)
    .filter((d): d is ThoughtNode['data'] => !!d);
}

/** What a node about to be asked runs on: its own intent, else the line's. */
export function nodeIntent(nodeId: string, nodes: ThoughtNode[], edges: ThoughtEdge[]): RunIntent & { mixed?: true } {
  return effectiveIntent(nodes.find((n) => n.id === nodeId)?.data, parentsOf(nodeId, nodes, edges), globalIntent());
}
