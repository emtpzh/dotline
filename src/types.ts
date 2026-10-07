import type { Node, Edge } from '@xyflow/react';
import type { EdgeMeaning } from './lib/edge-look';
import type { SessionLink } from './lib/agents/continuity';

export interface Attachment {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  addedAt?: string; // ISO timestamp: when this material entered the canvas (thinking-timeline raw data)
  content: string; // base64 for images, raw text for text files; '' for vaulted PDFs
  /** Bulky payload lives in the attachment vault (IndexedDB), not here —
      read through loadAttachmentContent(). Exports inline it back. */
  contentInVault?: boolean;
  thumbnailUrl?: string; // data URL for image preview
  extractedText?: string; // companion text (PDF extraction / image auto-understanding)
  extractedBy?: string; // which model produced extractedText (extraction provenance)
  pageImages?: string[]; // rendered page images as base64 PNG (PDF)
  numPages?: number; // PDF page count
  renderMode?: 'full' | 'text-only'; // PDF: include page images or text only
  isExtracting?: boolean; // PDF extraction in progress
  digest?: string; // reader's guided digest (markdown, with (p.N) anchors)
  digestBy?: string; // model that wrote the digest
  /** Canvases from before steps (lib/agents/steps): a tool call carried as
      an attachment. Read only to lift it into `steps`; never written. */
  paths?: string[];
  op?: ToolOp;
}

/** What a tool call DID, classified from its name across runners. */
export type ToolOp = 'read' | 'write' | 'edit' | 'run' | 'search' | 'fetch' | 'agent' | 'other';

/** One tool call of an agent turn: what the agent did, not material the
 *  person gave. Its output stays out of downstream context unless the
 *  person brings it in (ThoughtData.includedStepIds); the turn leaves a
 *  one-line summary of its steps instead. */
export interface AgentStep {
  id: string;
  /** the runtime's own name for the tool: bash, Read, apply_patch */
  tool: string;
  op?: ToolOp;
  /** the command, the diff, the query — clipped as the session adapters clip it */
  call: string;
  /** what came back, clipped; the whole output stays in the session file */
  result: string;
  truncated?: boolean;
  /** files the call touched (absolute or relative to the turn's directory) */
  paths?: string[];
  /** a web resource it fetched */
  url?: string;
  /** a step lifted from an attachment whose text the fields do not rebuild
      exactly: that attachment as it was, so its context never changes */
  legacy?: { name: string; size: number; content: string };
}

export interface Highlight {
  id: string;
  text: string;
  at?: string; // ISO timestamp: when the user marked it (thinking-timeline raw data)
}

/** A web source the model consulted while generating a response. */
/** The agent runtimes the desktop shell can run a turn on. */
export type AgentRuntime = 'pi' | 'codex' | 'claude-code' | 'dsh';

/** How far an agent turn may go, as each runtime's own permission mode:
    read = reads and searches only; write = may change the working directory.
    Anything beyond is refused inside the turn, never asked on the canvas. */
export type AgentAccess = 'read' | 'write';

/** An agent runtime asking the person whether one action may proceed —
    shown on the node while the turn waits. */
export interface ApprovalRequest {
  id: string;
  /** what is being asked: a yes/no (the default), a pick, a line, a text */
  kind?: 'confirm' | 'select' | 'input' | 'editor';
  options?: string[];
  placeholder?: string | null;
  prefill?: string | null;
  /** the tool the runtime is deciding about (its own name) */
  toolName: string;
  callId: string | null;
  /** the runtime's or a policy hook's human-readable reason */
  reason: string | null;
  /** the call as the canvas already shows it: tool name and its one-line query */
  name: string;
  query: string;
  /** the full arguments, serialized, when the runtime supplied them */
  arguments: string | null;
  askedAt: string;
  /** set the moment the person clicks, before the runtime confirms */
  answered?: ApprovalOutcome;
  /** where the answer goes: a desktop runtime's run, else the harness bridge */
  channel?: { runId: string };
  /** records from before access levels: the standing rule an approval set,
      and whether a later one was decided from it without asking */
  rule?: string | null;
  auto?: boolean;
}

/** One tool call of a running agent turn, as the node shows it live. */
export interface AgentTraceEntry {
  id: string;
  name: string;
  query: string;
  status: 'running' | 'ok' | 'error';
  startedAt: string;
  endedAt?: string;
}

export type ApprovalOutcome = 'allowed-once' | 'allowed-session' | 'rejected' | 'cancelled' | 'unavailable' | 'answered';

/** A decided approval: part of the turn's record, like a tool footprint. */
export interface ApprovalRecord extends ApprovalRequest {
  outcome: ApprovalOutcome;
  decidedAt: string;
  /** the pick or the text, for select/input/editor */
  value?: string;
}

export interface Reference {
  title: string;
  url?: string;
  media?: string;
  date?: string;
}

export interface ThoughtData extends Record<string, unknown> {
  question: string;
  response: string;
  responses: string[];
  /** Question wording per version, parallel to `responses` — a version is a
      (question, answer) PAIR, so an edited question never orphans the
      answers written against the old wording. Absent = every version shares
      the current `question` (pre-migration canvases, never-edited nodes). */
  questions?: string[];
  responseIndex: number;
  isCollapsed: boolean;
  isEditing: boolean;
  isEditingResponse: boolean;
  isLoading: boolean;
  generationFailed?: boolean; // set on LLM failure; cleared on retry/success (persisted so Retry survives refresh)
  references?: Reference[]; // web sources cited by the current response ([n] markers)
  /** The model this node runs on next (its intent, written when it is asked:
      inherited from the line, the global pick only for a root). undefined =
      a node from before intents — its record stands in (lib/run-intent). */
  model?: string;
  /** The agent effort this node runs at next, in the runtime's own words;
      '' = the runtime's default. Only for agent entries. */
  effort?: string;
  /** The working directory this node's agent turn runs in next (its intent),
      settled at its first agent run: the directory of the session its
      parent's turn lives in when the line stays on that runtime, else the
      canvas's default. '' = the runtime's own default. Only for agent entries;
      another runtime picked on the node clears it. */
  cwd?: string;
  /** The access level this node's agent turn runs at next (its intent,
      inherited like the effort). Only for agent entries. */
  access?: AgentAccess;
  /** A converge node (merge / weave), created unasked off a selection: its
      first ask and every rerun use the converge prompt, the question being
      the person's extra request (`request`, absent = none, the default
      question shows). `sources` is the selection it converged; a weave
      without `highlightIds` threads every mark on them. */
  converge?: { kind: 'merge' | 'weave'; sources: string[]; highlightIds?: string[]; request?: string };
  webSearch?: boolean; // may this node's generation use web search? (snapshotted at ask time; undefined = legacy, follow global)
  scholarSearch?: boolean; // same for arXiv / Semantic Scholar tools
  autoRerun?: boolean; // regenerate in place whenever an upstream ancestor finishes (generic primitive)
  /** Transient: a regeneration is streaming and data.response still holds
      the OLD text (cleared on the first new chunk) — display shows the live
      thinking, not the stale answer. */
  restreaming?: boolean;
  /** The runtime session this node's last agent turn ran in (desktop agent lanes). */
  agentSession?: {
    runtime: AgentRuntime; sessionId: string | null; sessionFile: string | null; cwd: string;
    /** the effort level the turn actually ran at, in the runtime's own words, from its own record */
    effort?: string;
    /** the access level the turn ran at */
    access?: AgentAccess;
    /** the turn continued the mirrored session instead of opening a fresh one */
    continued?: boolean;
    /** the run was still going when this record was last written: a canvas
        reopened meanwhile adopts the turn from the session file once it ends */
    pending?: boolean;
    /** the picker id the turn ran under, for the version it becomes */
    model?: string;
    /** what changed on disk during the turn, by the file system's account */
    changes?: { changed: string[]; added: string[]; removed: string[]; truncated?: boolean };
  };
  /** What became of the agent session above when this turn last ran (or,
      before its first run, what its ask box predicted): it opened a new
      session and why, or it forked the session at turn N. Absent = it went
      on in that session, or there was none (lib/agents/continuity). */
  sessionLink?: SessionLink;
  /** The tool calls of an agent turn, in order (lib/agents/steps). */
  steps?: AgentStep[];
  /** Steps whose output goes downstream in full; the others leave only
      their line in the turn's summary. */
  includedStepIds?: string[];
  /** Transient: the tool calls of the agent turn running now, in order. */
  agentTrace?: AgentTraceEntry[];
  /** Transient: an agent runtime is waiting for the person's decision on one action. */
  /** Transient: approvals the agent is waiting on, oldest first. A model can
      ask for several at once (parallel tool calls); each is answered on its
      own card and the turn resumes only when all are answered. */
  pendingApprovals?: ApprovalRequest[];
  /** Every approval decided during this turn's generations, oldest first. */
  approvals?: ApprovalRecord[];
  archived?: boolean; // pruned-but-kept: dimmed on canvas, EXCLUDED from every context walk
  archivedAt?: string; // ISO timestamp: when it was pruned (thinking-timeline raw data)
  /** Provenance seed for staleness tracking: fingerprint of the exact
      context this node's current response was generated from, plus when.
      A future staleness pass compares this against the CURRENT upstream
      fingerprint to flag "upstream changed since this was written". */
  lastContextHash?: string;
  lastGeneratedAt?: string;
  // ── thinking-timeline raw data (write-only for now: a future timeline /
  //    process-replay view needs these recorded from day one — they cannot
  //    be reconstructed later) ──
  createdAt?: string; // when the node entered the canvas
  askedAt?: string; // when its question was (last) committed
  generatedAts?: (string | undefined)[]; // per-version answer completion times, parallel to responses[]
  editedAts?: (string | undefined)[]; // per-version manual-revision times (the human intervened) — generation stamps stay untouched
  // ── node kind (beyond the default Q&A node) ──
  // 'human' = a dialogue turn (the human asks here); 'prompt' = a machine
  // processing step (fixed prompt, context only from upstream);
  // 'note' / 'file' / 'link' = CONTENT nodes (canvas material: markdown
  // text, attachments, or a stamped web snapshot) — they never generate,
  // feed context only via OUTGOING edges, and are ignored by autoLayout.
  // Legacy v1 kinds ('step'|'fanout'|'review'|'synthesis') still
  // instantiate; 'fanout' also marks fan-out placeholders.
  // 'frame' = a labeled background region (spatial annotation) — no handles,
  // never in context, ignored by layout; the wayfinding primitive.
  stepKind?: 'human' | 'prompt' | 'note' | 'file' | 'link' | 'frame' | 'step' | 'fanout' | 'review' | 'synthesis';
  /** Provenance of a node imported from an external runner session (the
      continuity layer's read direction). Source sessions stay read-only;
      these ids let a future continuation point back at native items. */
  /** Provenance of an imported turn. `cwd` is the source session's working
      directory: relative paths the agent wrote ("./fig1.png") resolve
      against it. */
  importSource?: { runner: string; sessionId: string; itemIds: string[]; cwd?: string };
  /** Frozen snapshot of the SOURCE projection at import time. The working
      question/response fields are free to iterate; this never changes, so
      "has this node diverged from its source?" is a field comparison, and
      the mirror outlives runner-side cleanup (sessions are short-lived
      upstream — the canvas is the archive). */
  source?: { question: string; response: string };
  linkUrl?: string; // link node: the source URL
  linkTitle?: string; // link node: page title (or a ⚠-prefixed fetch error)
  linkFetchedAt?: string; // link node: ISO timestamp of the snapshot (web content drifts)
  /** link node: the sanit-ready page HTML captured at fetch time. Serves the
      reader's original view only — context always reads the extracted copy
      in `question`. Absent on old snapshots and non-HTML fetches. */
  linkSnapshotHtml?: string;
  frameColor?: string; // frame node: fixed-palette color token (wayfinding, not decoration)
  frameCarry?: boolean; // frame node: dragging carries contained nodes (absent = true; new frames start false so they can be adjusted into place first)
  instruction?: string; // paradigm body: the prompt (prompt node) or operator guidance (human node)
  fanoutRoles?: { name: string; prompt: string }[]; // role list carried by fanout steps/placeholders
  autoRerunRounds?: number; // max auto-triggered runs per user action (default 1); >1 enables loops
  tokenCount: number;
  branchContext?: string;
  /** A revision: the fact node (a session turn) whose answer this node
      rewrote. The fact stays as recorded; this node is the canvas's. */
  revisionOf?: string;
  highlights: Highlight[];
  highlightMode: 'off' | 'tag' | 'filter'; // off=normal, tag=mark important, filter=pass highlights only
  summary?: string; // legacy single display summary (pre-versioned nodes)
  /** Display-only summaries, aligned with `responses` by index. Never enter
      context or fingerprints — the map layer, not the transcript. */
  summaries?: (string | undefined | null)[];
  /** Which model produced each response version (id, vendor prefix and all).
      Recorded at generation time so switching the global model later never
      obscures where an old answer came from. */
  generatedBy?: (string | undefined | null)[];
  /** Per version: this answer used the model gateway's built-in web search
      (no tool pings from the proxy, so the stream flags it once instead). */
  gatewaySearches?: (boolean | undefined)[];
  /** per version: the effort level an agent turn actually ran at (its own record); absent for API models */
  generatedEfforts?: (string | undefined | null)[];
  /** Epistemic move per version: insight (default, unmarked) | ruleout |
      decision | pivot | open. Auto-labeled by the takeaway judge; display
      layer only. */
  summaryTypes?: (string | undefined | null)[];
  /** Micro topic per version (≤6 CJK chars / ≤14 latin): the noun phrase the
      narrow surfaces show — timeline tooltips, unbadged plaques. Written by
      the same judge call as the summary; display layer only. Older canvases
      lack it — every consumer must fall back to the summary itself. */
  summaryTopics?: (string | undefined | null)[];
  /** Where on the source material this question was asked from: page number,
      plus selection rectangles as fractions of the page box when asked in the
      original PDF view (rects power the in-reader marks; page alone powers
      the canvas p.N chip — text-view selections have no page-box geometry). */
  anchor?: {
    page: number;
    rects?: [number, number, number, number][];
    /** The attachment this anchor points into. Lets edge-less clip nodes
        (notes/images extracted from a document) keep their provenance —
        the reader shows their marks and the p.N chip finds its way back
        without wiring the heavy material into their context. */
    attId?: string;
  };
  /** Marks a guided-digest node: the attachment id it digests. The reader's
      digest tab is a view of this node; rerun routes through the digest
      prompt (see generateDigest). */
  digestOf?: string;
  /** Distill node in a condensed copy-tree: the original-tree node ids this
      node collapsed. Powers the provenance chip (click = highlight the
      source run); context flows through normal wires only. */
  condensedFrom?: string[];
  /** Reasoning/thinking stream of the CURRENT generation (live buffer). */
  reasoning?: string;
  /** Per-version reasoning, aligned with `responses` by index. Display
      only: never enters context, fingerprints or summaries. Models that
      don't emit reasoning leave holes (undefined). */
  reasonings?: (string | undefined | null)[];
  /** The role this node was SET to: the system prompt for it and every node
      downstream along solid wires, until the next node that sets one. A
      role is identity only; the task stays in the question. */
  rolePrompt?: string;
  /** What that role is called where the canvas shows it: the template's
      name, or the one typed with a custom role. Absent on older nodes and
      unnamed custom roles — the prompt's opening stands in. */
  roleName?: string;
  appliedRole?: string; // the role actually used when generating the current response
  roleSourceNodeId?: string; // user-chosen role source node (for multi-parent role conflict)
  roleMode: 'inherit' | 'set-next' | 'reset'; // inherit from ancestors / set for descendants / reset for this node
  attachments: Attachment[];
  excludedAttachmentIds: string[]; // upstream attachment IDs to exclude from context
  includedAttachmentIds: string[]; // override ancestor exclusions (re-include)
  isRoot: boolean;
  isBranch: boolean;
  /** Legacy: the old reviewer identity. Nothing reads it any more — a
      reviewer is a role + autoRerun + a reference that follows the tip. */
  isEvaluator?: boolean;
  /** auto = re-critique whenever the watched subtree produces new content. */
  evaluatorTrigger?: 'auto' | 'manual';
  /** Context Focus role, set ONLY by the render pipeline (displayNodes) —
      never persisted. target = the focused node, ctx = feeds its context,
      down = one structural step downstream (not in context). */
  focusRole?: 'target' | 'ctx' | 'down';
}

export type ThoughtNode = Node<ThoughtData, 'thought'>;

/** An edge stores MEANING only — reference or not, fork or not, whether it
    follows the tip. How it looks (dash, color, flow) is derived at render
    time from that meaning (lib/edge-look); a `style` an older canvas stored
    is ignored. */
export interface ThoughtEdge extends Edge {
  data?: {
    /** A reference (dashed): the target reads one block — the source's own
        Q/A and a trail of its upstream questions — not the whole line. */
    isCrossLink?: boolean;
    /** A fork: the child grows beside its parent instead of continuing its
        column (explored from a passage, a perspective, a turn in a new agent
        session). The passage, when there is one, lives on the child's
        branchContext — the name is historical. */
    isBranchFromSelection?: boolean;
    /** Position of this edge's upstream BLOCK in the target's context when
        the target has several parents (set via the focus panel; creation
        order when absent). Lives on the edge — semantics drive rendering. */
    contextOrder?: number;
    /** Legacy: the old evaluator's watch edge. New ones are a reference
        with followsTip; old ones still never count as parentage for layout. */
    isWatch?: boolean;
    followsTip?: boolean; // edge slides forward to the newest node of its source thread
    branchYRatio?: number; // where along the parent the branch handle sits
    /** Legacy: a 'full' reference depth older canvases stored. Ignored —
        a reference is always one block; the whole line is a solid wire. */
    contextDepth?: 'full';
    /** ISO timestamp for edges wired INDEPENDENTLY of node birth (manual
        connect). Most edges are born with their target node — consumers
        should fall back to the target's createdAt. */
    createdAt?: string;
    /** Context Focus role, set ONLY by the render pipeline — never persisted.
        path = structural feed line, ref = reference into the context,
        down = one step downstream. */
    focusRole?: 'path' | 'ref' | 'down';
    /** What the canvas draws this edge as, set ONLY by the render pipeline
        (lib/edge-look) — never persisted. */
    view?: EdgeMeaning;
  };
}

export interface DAGState {
  nodes: ThoughtNode[];
  edges: ThoughtEdge[];
  history: { nodes: ThoughtNode[]; edges: ThoughtEdge[] }[];
  historyIndex: number;
}

/** Semantic operations recorded in the canvas event log (form 2 of the
    thinking timeline). View-level noise (drag, collapse, typing) is
    deliberately NOT here; ops record that something happened, never the
    content itself (the canvas carries the content). */
export type CanvasOp =
  | 'ask' | 'generate' | 'edit-question' | 'edit-response' | 'regenerate'
  | 'delete' | 'archive' | 'unarchive'
  | 'highlight-add' | 'highlight-remove'
  | 'connect' | 'disconnect'
  | 'merge' | 'weave' | 'explore' | 'fanout'
  | 'material-add' | 'undo' | 'redo'
  /** a request left for a model: the hash of what was sent, and which
      nodes it was built from — the alignment fact, recorded at send time */
  | 'commit';

export interface CanvasEvent {
  t: string; // ISO timestamp
  op: CanvasOp;
  /** Primary object (node or edge id). */
  id?: string;
  /** Light metadata only — counts, model names, flags. NEVER text content. */
  d?: Record<string, string | number | boolean>;
}
