import type { StateCreator } from 'zustand';
import type { StoreState, RoleSlice } from '../types';

// Roles are deliberately narrow: ONE semantic — a rolePrompt set on a node
// is the system prompt for that node and everything downstream along solid
// wires (nearest ancestor wins), and any node can set one. It is identity
// only: the task stays in the question. The old set-next/reset modes and
// multi-source pickers are gone from the UI; context-builder still resolves
// legacy graphs that carry them.
export const createRoleSlice: StateCreator<StoreState, [], [], RoleSlice> = (set, get) => ({
  setRolePrompt: (nodeId: string, rolePrompt: string, roleName?: string) => {
    get().pushHistory();
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, rolePrompt: rolePrompt || undefined, roleName: (rolePrompt && roleName?.trim()) || undefined } }
          : n
      ),
    }));
    get().pushHistory();
  },
});
