# dsh-dotline

This directory is the DeepSeek Harness plugin of [Dotline](../README.md), published to npm as `dsh-dotline`; its version follows the app's, and the Dotline build it embeds is the one in this tree.

Dotline for DeepSeek Harness: open DSH sessions (live or on disk) as
editable thought graphs on Dotline's infinite canvas — from inside the
harness UI.

This is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugin (a Cordis plugin distributed as an npm package), built on the same shell
pattern as [dsh-synapse](https://github.com/liangmianya/dsh-synapse): the host
half mounts the Dotline SPA under `/dotline/` on the EXISTING harness
web server (no second process, no second port), and the client half adds a
"思维图" global panel to the sidebar that shows the canvas in a same-origin
iframe in the centre column.

> The canvas is not any one session's — it lists and mirrors all of them — so
> its entry sits in the sidebar's panel list under New Session, not in a
> session's header, and works from the empty state too. Opening a session
> from the sidebar (or the canvas's back button) returns to the chat.
> (入口在侧边栏「新会话」下方的全局面板列表，不属于某个会话；从侧边栏点开会话
> 或点画布的返回按钮即回到对话。) A harness without global panels (no
> `layout` service) gets the older "对话 | 思维图" switch in the session header.

## Moving from dsh-thoughtdag

This plugin was published as `dsh-thoughtdag` before it became Dotline. Remove the old one first: both read and write the same canvases (they share the harness's origin), so two open at once would overwrite each other's saves.

```
dsh plugin --profile web remove dsh-thoughtdag
dsh plugin --profile web add dsh-dotline
```

The canvas now lives at `/dotline/` instead of `/thoughtdag/`. Canvases, keys and settings stay where they were: they belong to the harness's web origin, not to the path, so the new plugin opens the same canvases.

## What works

- `dsh plugin --profile web add dsh-dotline` installs the plugin from npm; every GitHub release also carries `dsh-dotline-<version>.tgz`, and the same command takes that file's URL (`dsh plugin` forwards to pnpm)
- The harness GUI gains a "思维图" row in the sidebar's global panels; it opens
  Dotline at `/dotline/` in the centre column (same origin — no CORS,
  no second server), and the canvas keeps its state while the chat is shown
- The host serves the SPA plus a read-only session bridge:

  | Endpoint | Purpose |
  |---|---|
  | `GET /dotline/api/disksessions` | list durable sessions on disk (id, title, cwd from the session header; newest first) |
  | `GET /dotline/api/disksessions/<id>/log` | one disk session as JSONL — the exact dialect Dotline's `dsh-session` adapter parses, so a past harness session imports like a local file |
  | `GET /dotline/api/sessions` | list live sessions in this process |
  | `GET /dotline/api/sessions/<id>/log` | one live session's events as JSONL |
  | `GET /dotline/api/sessions/<id>/turns` | turn boundaries (start/end seq, the person's message id) of a live or on-disk session — the fork points a canvas can name |
  | `POST /dotline/api/sessions/<id>/fork` | `{ afterTurn }` or `{ atSeq }` → a child session inheriting the prefix through that completed turn (`sessionController.fork`, so the chat UI lists it) |
  | `POST /dotline/api/sessions/<id>/inject` | `{ text }` or `{ blocks: [{type:'text',text}] }` → model-facing context for the next step (`agent.inject`; no wake; shown in the transcript as injected context from `dsh-dotline`) |
  | `POST /dotline/api/sessions/<id>/followup` | `{ text | blocks, mode?: 'queue' | 'steer' }` → a user prompt through `sessionController.prompt`, exactly as the composer sends one |
  | `GET /dotline/api/roots` · `GET /dotline/api/roots/<key>/list\|head\|read\|range` | the other agents' session directories on this machine (`claude-projects` = `~/.claude/projects`, `codex-sessions` = `~/.codex/sessions`) with the desktop bridge's file primitives, so Session Atlas inside the harness lists all three sources and mirrors a Claude Code or Codex session as the desktop does; `rel` never escapes its root |
  | `GET /dotline/api/models` | the harness's model catalog in the SPA's list shape (`<provider>/<model>` ids, the harness default) |
  | `POST /dotline/api/stream` · `POST /dotline/api/claude` | the SPA's own proxy protocol, answered on the harness's providers and credentials (`ctx.llm.stream`); the embedded SPA is built with `VITE_API_BASE=/dotline`, so its model picker and every canvas-native generation (summaries, condensing, a canvas that is not a mirrored session) run on the harness's models. These calls do not enter a session log; a mirrored session's turns go through `/followup` |
  | `/agents/*` runtime `dsh` (`harness/agent/<provider>/<model>` in the picker) | the harness's own agent loop as a runtime on the canvas's agent lane, beside Pi, Codex and Claude Code (same contract: `runtime/agents/README.md`). A question goes INTO the harness: a tail follow-up continues the mirrored session (`sessionPath`), a follow-up off an earlier turn forks the session at that turn's end (`forkAfterTurn`, the turn's user-message id), anything else opens a fresh session in the chosen working directory with the canvas's wired context injected first (`agent.inject`, source `dsh-dotline`) and the question as a user follow-up. Text, reasoning, tool calls and approvals come back as the lane's events; the session stays in the Chat and the atlas, and the canvas adopts the finished turn from it. `images` (base64) are admitted through the controller's prompt and a vision model is selected for that turn. A run keeps going when the canvas closes. A plain model call (`/stream`, `/claude`) naming an agent entry is one of the canvas's side calls (plaques, titles, condensing) and runs as a plain call, opening no session: on the catalog's deepseek flash model, else the entry's own provider/model, else the catalog default (the canvas already sends side calls to that model itself) |
  | `GET /dotline/api/agents/ws` (WebSocket) | the agent lane's events, the same feed as `/agents/events` over a socket: an SSE stream holds one of the browser's six connections per host while the page is open, and with several harness tabs the short requests a turn needs queue behind them. Same Host fence as the api, and the Origin (when sent) must be a trusted host; the page falls back to SSE where the harness cannot upgrade |
  | `GET /dotline/api/dir-picker` · `POST …/dir-picker/pick` · `GET …/dir-picker/list?path=` · `POST …/dir-picker/mkdir` | the agent lane's working-directory chooser on the harness's own `ctx.directoryPicker` (harness 0.1.5+): `{ kind }` says which one this boot mounted — `native` opens the OS folder dialog on the host's display (loopback bind, not over SSH), `browse` lists one level at a time (`{ path, home, crumbs, entries, truncated }`) and creates a child folder (`{ path, name }`) for the folder browser inside the canvas's cwd popover. A harness without the service answers `kind: null` and the canvas keeps its typed path |
  | `POST /dotline/api/fetch-url` | the SPA's link snapshot (`{ url }` → `{ title, text, fetchedAt, html? }`) through the harness's bounded, credential-free fetcher (`ctx.web.fetch`) |

  Disk logs are zstd *concatenated-frame* files; the bridge locates frame
  boundaries structurally and decodes each with `node:zlib` (the same walk the
  DSH persistence backend performs), so no external zstd binary or native
  module is needed.
- The bridge is Host-header fenced (localhost/127.0.0.1 + `trustedHosts`)

## Verified (2026-09)

- installed into the local `web` profile via `dsh plugin --profile web add <dir>`
- a fresh web-profile boot serves `/dotline/` (SPA) and the bridge API; the
  index injection table lists `dsh-dotline/client.js`
- headless-browser walk: the "对话 | 思维图" switch appears in the session header, the full-screen
  same-origin iframe opens, and Dotline boots inside it
- fetching the bridge from INSIDE the dotline iframe works with no extra
  auth: `GET /dotline/api/disksessions` lists every on-disk session (new
  sessions created by the running instance appear automatically) and
  `GET .../log` returns the full event stream
- real session logs decode correctly (multi-frame zstd → 15k+ JSONL lines,
  identical to the `zstd` CLI)
- the live bridge (`/api/sessions`) reflects the running instance's active
  session as soon as the GUI opens one (verified: opening the UI surfaces the
  auto-created session with its live seq), complementing the disk archive

### Canvas-side import

When a turn launched from the canvas needs the person's approval (the
harness's sandbox asking to escalate, a policy hook answering `ask`), the
plugin answers first: it registers ahead of the harness's own panel on the
`approval/request` waterfall for the sessions it is running, streams the
question to the canvas as a `question` event on the agent lane, and the node
shows it — tool, command, the harness's reason, allow once or reject. The
decision returns through the lane's `answer` (`POST /dotline/api/agents/answer`)
and stays on the node as part of the turn's record. When no canvas is on the
lane's events feed (or it leaves while the question stands), the request is
handed down the chain to the harness's panel unchanged.

Inside the iframe the canvas runs with this bridge as its session source
(the SPA is built with `VITE_DSH_BRIDGE=/dotline/api`): Session Atlas
lists the harness's sessions beside Claude Code's, Codex's and Pi's (served by
this host from their directories), opens one as a graph, and follows it
live by polling the session's seq. The client half tells the canvas which
session the chat shows (`td:current-session`) and switches the chat when the
canvas names one (`td:select-session`).

## The why layer inside the harness

The plugin bundles the `thoughtdag` CLI's library (`lib/why.mjs`, built at pack time) and answers the same four questions over the same `~/.thoughtdag` index — no CLI or MCP install needed:

| Surface | What |
|---|---|
| Native tools | `why_check(path)`, `why_file(path, include_read?, limit?)`, `why_find(phrase, in?, limit?)`, `why_recall(session, turn)` — the agent calls them like any harness tool; relative paths resolve against the session's working directory |
| `/why <path \| url \| arxiv:id>` | a person asks from the chat; the answer is the CLI's `why` output, no model message |
| System-prompt section | four lines telling the model to `why_check` before editing a file with history and how to read the other three |

Both are off by default; `whyTools: true` / `whyPrompt: true` in the plugin config turn them on (the prompt section needs the tools).

## Not yet (roadmap)

- Canvas why panel (a node's file → its history through `/dotline/api`)
- Canvas UI for the write bridge: name a fork point on a node, hand a compiled context to `inject`, continue with `followup`; the client already switches the chat to a session the canvas names (`td:select-session`)
- `replace`: shadow a surface range from the canvas (DSH's compaction primitive); needs a live check of how the chat renders a replaced range
- Theme and language sync with the harness UI
- Open the chat's current session on the canvas automatically when the view switches

## Development

```bash
# 1. build the embedded Dotline SPA with a /dotline/ subpath base (from the repo root)
npm run dsh:build            # writes dsh/dist-app, which git ignores

# 2. install into a profile from this directory (pnpm link)
dsh plugin --profile web add /abs/path/to/dotline/dsh

# 3. restart the profile's web app; open "思维图" in the sidebar
```

The script drives `tsc`, `vite` and `esbuild` through Node directly, so the
same code path builds on Windows, macOS and Linux. Always run it as
`npm run dsh:build` instead of passing the flags through Git Bash by hand:
MSYS path conversion rewrites `--base=/dotline/` into a Git-install path,
which bakes a broken base into `dist-app` — every asset request then falls
through to the SPA fallback HTML and the canvas mounts as a blank white page.

While developing, the profile keeps a pnpm *link* to this directory, so edits
to `lib/` apply on the next restart without reinstalling.

License: MIT
