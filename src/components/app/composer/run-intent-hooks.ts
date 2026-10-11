// What an ask box will send on: the model, its effort and, for an agent
// runtime, the access level. A box that starts a line (the landing, an
// empty ask node) edits the canvas's defaults — what a new line starts
// with; a box that asks off a node starts from what that node's line hands
// down and keeps its changes to itself until the question is sent.

import { useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useUiStore } from '../../../lib/ui-store';
import { useModels } from '../../../lib/use-models';
import { isAgentModel, offersAccess } from '../../../lib/agents/runtimes';
import { inheritIntent, intentFields, type RunIntent } from '../../../lib/run-intent';

export type IntentPatch = Partial<RunIntent>;
const NO_CHANGES: IntentPatch = {};

/** An intent with only the fields its model takes: effort is an agent's,
 *  access an agent's whose runtime has levels. */
export function normalized(i: RunIntent): RunIntent {
  if (!i.model || !isAgentModel(i.model)) return i.model ? { model: i.model } : {};
  return { model: i.model, effort: i.effort ?? '', ...(offersAccess(i.model) ? { access: i.access ?? 'read' } : {}) };
}

/** The defaults a new line starts with, and the way to change them. */
export function useRootIntent(): { intent: RunIntent; onIntent: (patch: IntentPatch) => void } {
  const selected = useUiStore((s) => s.selectedModel);
  const effort = useUiStore((s) => s.agentEffort);
  const access = useUiStore((s) => s.agentAccess);
  const data = useModels();
  const model = selected && data?.models.some((m) => m.id === selected) ? selected : data?.default ?? selected ?? undefined;
  const intent = useMemo(() => normalized({ model, effort, access }), [model, effort, access]);
  const onIntent = (patch: IntentPatch) => {
    const ui = useUiStore.getState();
    if (patch.model !== undefined) ui.setSelectedModel(patch.model);
    if ('effort' in patch) ui.setAgentEffort(patch.effort ?? '');
    if (patch.access) ui.setAgentAccess(patch.access);
  };
  return { intent, onIntent };
}

/** What a question asked off `parentId` runs on: the line's intent, with
 *  whatever the person changed in this box on top (`changed` names those
 *  fields). `reset` drops the box's changes, as a send does. */
export function useFollowUpIntent(parentId: string | null): {
  intent: RunIntent; base: RunIntent; changed: (keyof RunIntent)[];
  onIntent: (patch: IntentPatch) => void; reset: () => void;
} {
  const parentData = useStore((s) => (parentId ? s.nodes.find((n) => n.id === parentId)?.data : undefined));
  const globals = useRootIntent().intent;
  const base = useMemo(() => normalized(inheritIntent([parentData], globals)), [parentData, globals]);
  // the box's own changes belong to the node it asks off: another node, a clean box
  const [own, setOwn] = useState<{ for: string | null; patch: IntentPatch }>({ for: parentId, patch: {} });
  const patch = own.for === parentId ? own.patch : NO_CHANGES;
  const intent = useMemo(() => normalized({ ...base, ...patch }), [base, patch]);
  const changed = (['model', 'effort', 'access'] as const).filter((k) => k in patch && patch[k] !== base[k]);
  return {
    intent, base, changed,
    onIntent: (p) => setOwn((cur) => ({ for: parentId, patch: { ...(cur.for === parentId ? cur.patch : {}), ...p } })),
    reset: () => setOwn({ for: parentId, patch: {} }),
  };
}

/** What a node still waiting for its own question runs on: its own intent
 *  when it has one (a card asked off a node carries its line's, askFrom),
 *  else the canvas's defaults — a box that starts a line edits what new
 *  lines start with. `commit` pins the defaults onto the node at send, so
 *  it runs on what its box showed. */
export function useAskThisIntent(nodeId: string): {
  intent: RunIntent; onIntent: (patch: IntentPatch) => void; commit: () => void;
} {
  const own = useStore((s) => s.nodes.find((n) => n.id === nodeId)?.data);
  const root = useRootIntent();
  const model = own?.model, effort = own?.effort, access = own?.access;
  const ownIntent = useMemo(() => normalized({ model, effort, access }), [model, effort, access]);
  if (model) {
    return {
      intent: ownIntent,
      onIntent: (p) => useStore.getState().setNodeIntent(nodeId, intentFields(normalized({ ...ownIntent, ...p }))),
      commit: () => {},
    };
  }
  return {
    intent: root.intent,
    onIntent: root.onIntent,
    commit: () => {
      const d = useStore.getState().nodes.find((n) => n.id === nodeId)?.data;
      if (d && !d.converge && !d.model && root.intent.model) useStore.getState().setNodeIntent(nodeId, intentFields(root.intent));
    },
  };
}
