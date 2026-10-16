// The desktop shell's preload bridge (desktop/preload.js). Absent on the
// web app — presence of window.desktop IS the "running in the shell" test.
// Methods beyond checkForUpdates are optional: an older shell may pair with
// a newer page during dev; the page degrades to the shell's own dialogs.
interface DesktopUpdateEvent {
  kind: 'available' | 'downloading' | 'ready' | 'latest' | 'check-failed' | 'download-failed' | 'lookup' | 'dev';
  version?: string;
  percent?: number;
}

interface DesktopBridge {
  checkForUpdates: () => Promise<void>;
  downloadUpdate?: () => Promise<void>;
  installUpdate?: () => Promise<void>;
  onUpdateEvent?: (cb: (e: DesktopUpdateEvent) => void) => void;
}

// Fenced read-only primitives over the runner session stores (main.js
// SESSION_ROOTS). All runner knowledge lives in src/lib/atlas/.
interface SessionRoot {
  key: string;
  path: string;
  builtin: boolean;
  exists: boolean;
}

interface DesktopSessionsBridge {
  roots: () => Promise<SessionRoot[]>;
  /** Native directory picker — the ONLY door into the whitelist. */
  addRoot: () => Promise<SessionRoot | null>;
  removeRoot: (key: string) => Promise<void>;
  /** `live`: a running host holds this session (only the harness bridge says; absent elsewhere). */
  list: (rootKey: string) => Promise<{ rel: string; size: number; mtime: number; live?: boolean }[]>;
  head: (rootKey: string, rel: string, bytes: number) => Promise<string>;
  read: (rootKey: string, rel: string) => Promise<string>;
  /** Line-aligned chunked read — the road for sessions too big for one string. */
  readRange: (rootKey: string, rel: string, start: number, length: number) => Promise<{ text: string; nextStart: number; eof: boolean }>;
  openInCli: (runner: string, cwd: string | null, sessionId: string, mode: 'app' | 'terminal') => Promise<{ opened: boolean; via: 'app' | 'terminal' | ''; command: string }>;
  openTargets: () => Promise<{
    terminals: { id: string; name: string; custom: boolean }[];
    apps: { runner: string; name: string }[];
    prefs: { terminal: string };
    canAddCustom: boolean;
  }>;
  setOpenPrefs: (prefs: { terminal: string }) => Promise<{ terminal: string }>;
  /** Native app picker (macOS) — a user-chosen terminal app joins the registry. */
  addTerminal: () => Promise<{ id: string; name: string } | null>;
  /** One-command handoff installer: ships /thoughtdag ($thoughtdag)
      into the agent's own commands directory, with content-compare
      status and clean removal. */
  commandsStatus?: () => Promise<Record<string, { state: 'installed' | 'outdated' | 'absent' | 'unavailable'; dest: string; invoke: string }>>;
  commandsInstall?: (runner: string) => Promise<{ ok: boolean; dest?: string; error?: string }>;
  commandsRemove?: (runner: string) => Promise<{ ok: boolean; error?: string }>;
  /** Codex app-server read path (Tier 2): real thread names, fork
      lineage, full turns. null whenever the codex CLI is absent. */
  codexThreads?: () => Promise<{
    id: string; sessionId: string; name: string | null; preview: string;
    forkedFromId: string | null; parentThreadId: string | null;
    updatedAt: string | null; cwd: string | null; path: string | null;
  }[] | null>;
  codexThreadRead?: (threadId: string) => Promise<unknown | null>;
  /** thoughtdag:// deep links: push while running, pull once at startup. */
  onDeepLink?: (cb: (url: string) => void) => void;
  pendingDeepLink?: () => Promise<string | null>;
  /** Start watching all live roots; events arrive via onSessionsChanged. */
  watchStart: () => Promise<boolean>;
  onSessionsChanged: (cb: (e: { rootKey: string; rel: string }) => void) => void;
}

/** Local paths a response mentions, opened on this machine. */
interface DesktopLocalBridge {
  open(path: string): Promise<{ ok: boolean; kind?: 'dir' | 'file'; opened?: 'viewer' | 'finder'; reason?: string }>;
  /** data URL for an image file (images only, bounded), null otherwise */
  image(path: string): Promise<string | null>;
}

/** An agent runtime the shell can hand a turn to (Pi today): its models,
 *  a run on a working directory, the run's events, an abort. */
interface DesktopAgentModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
  /** the effort levels the runtime accepts for this model, in its own words (read from the CLI); empty = none */
  efforts?: string[];
  /** the runtime's own default among them, when it says */
  defaultEffort?: string | null;
}

/** One agent preset a runtime composes fresh sessions from (the harness's): its tools, prompt sections and skills. */
interface DesktopAgentPreset {
  id: string;
  name: string;
  /** what a session that names no preset is composed from */
  isDefault: boolean;
  description?: string;
  /** why it cannot compose a session; absent when it can */
  broken?: string;
}

interface DesktopAgentRunRequest {
  /** which runtime runs the turn (default: pi) */
  runtime?: 'pi' | 'codex' | 'claude-code' | 'dsh';
  /** absolute working directory the agent runs in ('' = the runtime's own default, where it has one) */
  cwd: string;
  /** what the agent is sent, as the canvas routed the turn */
  prompt: string;
  /** the prompt's two halves: the canvas's context (compiled, materials
      noted) and the question — a runtime that falls back to a fresh session
      sends both, one that injects context apart (the harness) splits them */
  context?: string;
  question?: string;
  images?: { type: 'image'; data: string; mimeType: string }[];
  /** continue this session file (absolute path) instead of opening a fresh one */
  sessionPath?: string;
  /** branch the current session at this entry (with sessionPath) */
  forkEntryId?: string;
  /** with sessionPath: a new session holding the conversation up to and
      including this turn (its item ids, as the canvas's mirror records them) */
  forkAfterTurn?: string[];
  model?: { provider: string; id: string };
  /** an effort level in the runtime's own words (one it listed for the model); absent or unknown = the runtime's default */
  effort?: string;
  thinkingLevel?: string;
  /** how far the turn may go, as the runtime's own permission mode; absent = read */
  access?: 'read' | 'write';
  /** the agent preset a fresh session is composed from (one the runtime listed); a continued or forked session keeps its own; absent = the runtime's default */
  preset?: string;
}

/** one row of a folder listing: a child, or a crumb of the path above it */
interface DesktopDirEntry { name: string; path: string; hidden: boolean }
interface DesktopDirListing {
  path: string;
  home: string;
  /** root → the listed folder, each a jump target */
  crumbs: DesktopDirEntry[];
  /** child folders, name-sorted */
  entries: DesktopDirEntry[];
  /** the host cut the children short */
  truncated: boolean;
}

/** A run as the host that runs it records it (runtime/agents/registry.cjs). */
interface DesktopHostRun {
  runId: string;
  runtime: string;
  status: 'running' | 'ended';
  startedAt: string;
  sessionId?: string;
  sessionFile?: string;
  /** the run's turn in its session file (the id of its first item) */
  turnId?: string;
  how?: string;
  endedAt?: string;
  /** the session file held the whole turn when the run ended */
  held?: boolean;
}

interface DesktopAgentsBridge {
  /** what this host can do beyond the calls: a native folder dialog, or
   *  folder listings the page browses itself (a host whose dialog would open
   *  on a display nobody is watching) */
  capabilities?: { nativePicker: boolean; browseDirs?: boolean };
  /** where the runtime's binary is, or null when not installed */
  available(): Promise<Record<string, string | null>>;
  models(runtime?: 'pi' | 'codex' | 'claude-code' | 'dsh'): Promise<{ installed: boolean; models: DesktopAgentModel[]; default: string | null; thinkingLevel?: string | null; error?: string; presets?: DesktopAgentPreset[] }>;
  /** resolves with the run id at once; events follow through onEvent */
  run(request: DesktopAgentRunRequest): Promise<string>;
  abort(runId: string): Promise<boolean>;
  /** the runs this host process knows, running and lately ended, and the
   *  process's boot id: a run of another boot is over (absent on older hosts) */
  runs?(): Promise<{ bootId: string; runs: DesktopHostRun[] }>;
  /** the event feed is back after a drop: runs' events sent meanwhile were missed */
  onFeedReopen?(cb: () => void): void;
  /** the shell-managed working directory of a canvas, created on demand */
  workspace(canvasId: string): Promise<string>;
  /** whether a path exists and is a directory (absent on older hosts) */
  stat?(path: string): Promise<{ exists: boolean; dir: boolean }>;
  /** the person's answer to a runtime's question during a run */
  answer(runId: string, requestId: string, response: { confirmed: boolean } | { value: string } | { cancelled: true }): Promise<boolean>;
  /** a folder picked in the system dialog, or null */
  pickCwd(): Promise<string | null>;
  /** one level of the host's folders (absent path = home); only with capabilities.browseDirs */
  listDirs?(path?: string): Promise<DesktopDirListing>;
  /** a new child folder under an existing one, its absolute path; only with capabilities.browseDirs */
  createDir?(parent: string, name: string): Promise<string>;
  /** the canvas's materials written under <cwd>/.thoughtdag/materials */
  writeMaterials(cwd: string, files: { name: string; content: string; encoding?: 'utf8' | 'base64' }[]): Promise<{ dir: string | null; written: string[] }>;
  onEvent(cb: (payload: { runId: string; event: Record<string, unknown> & { type: string } }) => void): void;
}

interface Window {
  desktop?: DesktopBridge;
  desktopSessions?: DesktopSessionsBridge;
  desktopLocal?: DesktopLocalBridge;
  desktopAgents?: DesktopAgentsBridge;
}
