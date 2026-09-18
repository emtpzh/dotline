# Agent runtimes

One file per runtime (CommonJS, `.cjs`, so it loads the same under any package type): `pi.cjs` over `pi --mode rpc`, `codex.cjs` over `codex app-server`, `claude.cjs` over `claude -p` with stream-json both ways. A host can add runtimes only it can build (`createAgentsHttp({ extraRuntimes })`): the harness plugin adds `dsh`, the harness's own agent loop, from `dsh/lib/index.js`. Each exports a factory returning the same surface:

- `available()` → where the binary is, or null
- `models()` → `{ installed, models: [{ provider, id, name, reasoning, vision, efforts, defaultEffort }], default }` — `efforts` are the effort levels the CLI accepts for that model, in its own words, read from the CLI (empty when it has none); `defaultEffort` its own default when it says
- `run(request, onEvent)` → run id at once; events follow, tagged with it. The request names the runtime, an absolute `cwd` (`''` only for a runtime with a default of its own — the harness), one `prompt` as the canvas routed the turn plus its halves `context` and `question`, optional `images`, a `model` from that runtime's own list, a session to continue (`sessionPath`), or to branch after one of its turns (`sessionPath` + `forkAfterTurn`, that turn's item ids as the canvas's mirror records them: a new session holding the conversation up to and including it — Pi cuts before the next turn's question, or clones a turn nothing follows; the harness forks at the turn's end), and optionally `effort`: one of the levels the runtime itself listed for that model, in its own words (Codex from `model/list`, Claude Code and Pi from their `--help`), which it passes on as is (`--effort`, the turn's `effort`, `set_thinking_level`). A word the runtime did not list is dropped: the CLI's own setting stands.
- `abort(runId)`, `answer(runId, requestId, { confirmed } | { value } | { cancelled: true })`, `shutdown()`

A run emits exactly these event kinds (the renderer reads nothing else):

| kind | meaning |
|---|---|
| `session` | which session file this run writes to, and where (cwd); `model.resolved` names the real model when the run used an alias (Claude Code's `opus` → `claude-opus-5`); `effort` is the level the turn actually ran at, read back from the runtime's own record (Pi's state, Codex's rollout `turn_context`, Claude Code's transcript entries), never assumed |
| `message_update` with a text or thinking delta | the answer or the reasoning growing |
| `tool_execution_start` / `tool_execution_end` | a tool call, for the live trace |
| `question` | the agent asks the person: confirm / select / input / editor. A confirm may carry `rule`, an opaque key naming what "allow for this conversation" would cover (Claude Code: its own permission suggestion; Codex: the command, or all file changes); the answer `{ confirmed: true, scope: 'session' }` allows it for good — the runtime tells the CLI where it can (Claude Code `updatedPermissions` scoped to the session, Codex `acceptForSession`) and the canvas keeps the rule on the record, sending every such rule back as `allowRules` on later runs of this conversation |
| `question_answered` | the person's answer went back (record); with `auto: true` the runtime decided from a standing rule of this conversation and nobody was asked — the record is made from its `title`/`message`/`rule` |
| `fs_changes` | what the shell saw change on disk (produced here, not by the agent) |
| `run_end` / `run_error` | the turn is over |

Nothing starts at launch. A runtime's process (Pi's rpc, Codex's app-server, a Pi catalog read) is started by the first request that needs it and retires after ten minutes without one (`TD_AGENT_IDLE_MS`); Claude Code runs one process per turn. A launch that never opens the agent group never starts a CLI.

The finished turn is adopted from the session file by the atlas's adapter for that
runtime; the stream is for showing, the file is the truth. Anything a runtime does
beyond these kinds stays inside its own file.

When a branch cannot be cut (the file does not hold the turn that way, the turn
is still open), a runtime opens a fresh session and sends `context` ahead of the
`question` instead. The canvas only asks to continue or branch when nothing above
the question was edited on the canvas or wired in beside the conversation
(`src/lib/agents/pristine.ts`); which runtimes can branch at all is `caps.forkAt`
in `src/lib/agents/agent-runtime.ts`.

A run is not tied to the page that started it: closing or reloading the page does
not stop it (only `abort` does). The node remembers the run as pending; a page
opened later reads the turn back from the session file once the file has been
quiet for a minute.
