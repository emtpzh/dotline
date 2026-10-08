import type { ThoughtNode, ThoughtEdge, Highlight, Attachment, CanvasEvent, CanvasOp, AgentAccess } from '../types';

export interface Snapshot {
  nodes: ThoughtNode[];
  edges: ThoughtEdge[];
}

export interface EventSlice {
  /** Append-only semantic operation log (thinking timeline, form 2). */
  events: CanvasEvent[];
  logEvent: (op: CanvasOp, id?: string, d?: Record<string, string | number | boolean>) => void;
}

export interface HistorySlice {
  history: Snapshot[];
  historyIndex: number;
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
}

export interface NodeSlice {
  nodes: ThoughtNode[];
  edges: ThoughtEdge[];
  selectedNodeId: string | null;
  selectedNodeIds: string[];
  setNodes: (nodes: ThoughtNode[]) => void;
  setEdges: (edges: ThoughtEdge[]) => void;
  setSelectedNodeId: (id: string | null) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  deleteNode: (nodeId: string) => void;
  deleteEdges: (edgeIds: string[]) => void;
  editResponse: (nodeId: string, response: string) => void;
  toggleCollapse: (nodeId: string) => void;
  setEditing: (nodeId: string, editing: boolean) => void;
  setEditingResponse: (nodeId: string, editing: boolean) => void;
  duplicateNode: (nodeId: string) => void;
  addCrossLink: (sourceId: string, targetId: string) => void;
  /** Convert an edge between dashed summary reference and solid full-context
   *  wiring. Solid = the target reads the source's WHOLE upstream (files
   *  included); dashed = a light quote block. Cycle-guarded. */
  setEdgeStructural: (edgeId: string, structural: boolean) => void;
  navigateVersion: (nodeId: string, direction: 'prev' | 'next') => void;
  deleteVersion: (nodeId: string, versionIndex: number) => void;
  batchDelete: (nodeIds: string[]) => void;
  /** Duplicate the multi-selection as a detached copy: inner edges kept, boundary edges cut, attachments shared by reference under new ids (undoable). */
  duplicateSelection: (nodeIds: string[]) => void;
  /** Re-run the column-tree layout over the whole graph, keeping pinned cards where they are — or, with `resetPins`, handing every card back to layout first (undoable). */
  relayout: (resetPins?: boolean) => void;
  /** Mark cards as placed by hand (a drag): layout keeps them where they are. */
  pinNodes: (nodeIds: string[]) => void;
  /** Hand a pinned card back to layout; it glides to its seat (undoable). */
  releasePin: (nodeId: string) => void;
  /** Re-seat everything grown out of a card; the card itself stays (undoable). */
  tidyChain: (nodeId: string) => void;
  /** Re-flow the cards inside a frame; nothing outside it moves (undoable). */
  tidyFrame: (frameId: string) => void;
  /** These cards changed size: settle what hangs from them (and what stands in the way) once React Flow has re-measured them. Columns never move. */
  settleFrom: (nodeIds: string[]) => void;
  /** Stack the selected nodes into one vertical column, in conversation order (undoable). */
  alignSelection: (nodeIds: string[]) => void;
  /** Set/clear a per-node LLM override (undefined = follow the global picker). */
  /** Change what a node runs on next (its intent); only this node — what grew off it keeps its own. */
  setNodeIntent: (nodeId: string, intent: { model?: string; effort?: string; cwd?: string; access?: AgentAccess }) => void;
  /** Archive/unarchive nodes: dimmed on canvas, excluded from every context walk (undoable). */
  setArchived: (nodeIds: string[], archived: boolean) => void;
  /** Nodes whose answers predate upstream changes (derived, not persisted). */
  staleIds: string[];
  /** Recompute staleness across the graph (debounce-subscribed to nodes/edges). */
  recomputeStaleness: () => void;
}

export interface AddQuestionOptions {
  parentId?: string;
  /** Selected text this node explores; also marks the node as an orange branch. */
  branchContext?: string;
  branchYRatio?: number;
  /** false → the new node starts with roleMode 'reset' (no inherited role). */
  inheritRole?: boolean;
  /** The role this question is asked in, from here down (see ThoughtData.rolePrompt). */
  rolePrompt?: string;
  roleName?: string;
  initialAttachments?: Attachment[];
  excludeAllInheritedAttachments?: boolean;
  /** @-mentioned node ids: any not already in the new node's context get a
      real dashed reference edge (the graph stays honest). */
  mentions?: string[];
  /** What the ask box said the question runs on, when the person changed it
      there; otherwise the line's intent (or, for a root, the defaults). */
  intent?: import('../lib/run-intent').RunIntent;
}

export interface LlmSlice {
  addQuestion: (question: string, opts?: AddQuestionOptions) => void;
  editQuestion: (nodeId: string, question: string) => void;
  /** A paradigm human turn: record the question WITHOUT generating (the
   *  answers belong to downstream prompt nodes), then advance the cascade. */
  submitHumanTurn: (nodeId: string, question: string) => void;
  /** Converge a selection into one new node, UNASKED, with a REAL edge from
   *  each of the selection's sinks: explore (a plain question), merge (a
   *  synthesis of the content) or weave (the person's own highlights, cited;
   *  `highlightIds` narrows them). The question is typed on the node — for
   *  merge / weave an optional extra request. Returns the new node's id. */
  convergeFrom: (nodeIds: string[], kind: 'explore' | 'merge' | 'weave', highlightIds?: string[]) => string | null;
  /** An UNASKED card under one parent — the card's own follow-up: the
   *  question is typed on the new card. With `branchContext` it explores a
   *  passage of the parent's answer and grows beside it. Returns its id. */
  askFrom: (parentId: string, opts?: { branchContext?: string; branchYRatio?: number }) => string | null;
  /** Fan out N perspectives: once = blind candidate branches; follow = reviewers that auto-rerun with the thread. */
  fanOut: (parentId: string, question: string, roles: { name: string; prompt: string }[], opts?: { follow?: boolean; rounds?: number }) => Promise<void>;
  /** A sibling turn under the same parent: the same question, or a new wording. */
  regenerate: (nodeId: string, question?: string) => Promise<void>;
  /** After a merge has answered: delete the nodes it merged (and their
   *  descendants), rewiring it to their parents. */
  deleteConvergeSources: (nodeId: string) => void;
  stopGeneration: (nodeId: string) => void;
}

export interface RoleSlice {
  setRolePrompt: (nodeId: string, rolePrompt: string, roleName?: string) => void;
}

export interface HighlightSlice {
  addHighlight: (nodeId: string, highlight: Highlight) => void;
  removeHighlight: (nodeId: string, highlightId: string) => void;
  setHighlightMode: (nodeId: string, mode: 'off' | 'tag' | 'filter') => void;
  setSummary: (nodeId: string, summary: string, forResponse: string, type?: string, topic?: string) => void;
  setMaterialSummary: (nodeId: string, summary: string, topic?: string) => void;
  /** Names from a batch naming call, each for the version it was judged on. */
  setTopics: (entries: { nodeId: string; topic: string; forResponse: string }[]) => void;
}

export interface EvaluatorSlice {
  /** PRESET: ordinary node with a critic role + autoRerun, wired by a followsTip edge. */
  /** Regenerate a node in place from its incoming edges, appending a version (generic primitive). */
  rerunNode: (nodeId: string, opts?: { auto?: boolean }) => Promise<void>;
  /** Replay every currently-stale node in dependency order (confirm first — N generations). */
  replayStale: () => Promise<void>;
  /** Toggle the autoRerun primitive on any node. */
  setAutoRerun: (nodeId: string, enabled: boolean) => void;
  /** Set how many auto rounds per user action this node may fire (loops need >1). */
  setAutoRerunRounds: (nodeId: string, rounds: number) => void;
}

export interface AttachmentSlice {
  addAttachment: (nodeId: string, attachment: Attachment) => void;
  removeAttachment: (nodeId: string, attachmentId: string) => void;
  toggleExcludeAttachment: (nodeId: string, attachmentId: string, ancestorExcluded?: boolean) => void;
  setAttachmentRenderMode: (nodeId: string, attachmentId: string, mode: 'full' | 'text-only') => void;
  setAttachmentData: (nodeId: string, attachmentId: string, data: Partial<Attachment>) => void;
  getInheritedAttachments: (nodeId: string) => { attachment: Attachment; sourceNodeId: string; sourceQuestion: string; excludedByAncestor: boolean }[];
}

export type StoreState = HistorySlice & NodeSlice & LlmSlice & RoleSlice & HighlightSlice & AttachmentSlice & EvaluatorSlice & EventSlice;

export type PersistedState = { nodes: ThoughtNode[]; edges: ThoughtEdge[]; events?: CanvasEvent[] };
