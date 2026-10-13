# Agent runtimes

One file per runtime (CommonJS, `.cjs`, so it loads the same under any package type): `pi.cjs` over `pi --mode rpc`, `codex.cjs` over `codex app-server`, `claude.cjs` over `claude -p` with stream-json both ways. A host can add runtimes only it can build (`createAgentsHttp({ extraRuntimes })`): the harness plugin adds `dsh`, the harness's own agent loop, from `dsh/lib/index.js`. Each exports a factory returning the same surface:

- `available()` → where the binary is, or null
- `models()` → `{ installed, models: [{ provider, id, name, reasoning, vision, efforts, defaultEffort }], default }` — `efforts` are the effort levels the CLI accepts for that model, in its own words, read from the CLI (empty when it has none); `defaultEffort` its own default when it says
- `run(request, onEvent)` → run id at once; events follow, tagged with it. The request names the runtime, an absolute `cwd` (`''` only for a runtime with a default of its own — the harness), one `prompt` as the canvas routed the turn plus its halves `context` and `question`, optional `images`, a `model` from that runtime's own list, a session to continue (`sessionPath`), or to branch after one of its turns (`sessionPath` + `forkAfterTurn`, that turn's item ids as the canvas's mirror records them: a new session holding the conversation up to and including it — Pi cuts before the next turn's question, or clones a turn nothing follows; the harness forks at the turn's end), and optionally `effort`: one of the levels the runtime itself listed for that model, in its own words (Codex from `model/list`, Claude Code and Pi from their `--help`), which it passes on as is (`--effort`, the turn's `effort`, `set_thinking_level`). A word the runtime did not list is dropped: the CLI's own setting stands. And `access`, `read` or `write`: the level the turn runs at, as the runtime's own permission mode — Claude Code `default` / `acceptEdits`, Codex's `read-only` / `workspace-write` sandbox with approvals never asked for. Absent means `read`. Pi has no permission mode of its own and takes no level: it runs as it would in the terminal, and nothing on the canvas holds it back. Nothing beyond the level is asked for on the canvas: the CLI refuses it by itself and the model hears so as a failed tool call; the person continues in the terminal, where the CLI asks natively. The person's own allow rules in each CLI's settings still apply.
- `abort(runId)`, `answer(runId, requestId, { confirmed } | { value } | { cancelled: true })`, `shutdown()`

A run emits exactly these event kinds (the renderer reads nothing else):

| kind | meaning |
|---|---|
| `session` | which session file this run writes to, and where (cwd); `model.resolved` names the real model when the run used an alias (Claude Code's `opus` → `claude-opus-5`); `effort` is the level the turn actually ran at, read back from the runtime's own record (Pi's state, Codex's rollout `turn_context`, Claude Code's transcript entries), never assumed |
| `message_update` with a text or thinking delta | the answer or the reasoning growing |
| `tool_execution_start` / `tool_execution_end` | a tool call, for the live trace |
| `question` | the agent asks the person: select / input / editor (Codex's user-input requests, Pi's dialogs), or a confirm from an extension of the agent's own — never a permission prompt |
| `question_answered` | the person's answer went back (record) |
| `fs_changes` | what the shell saw change on disk (produced here, not by the agent) |
| `run_end` / `run_error` | the turn is over |

Nothing starts at launch. A runtime's process (Pi's rpc, Codex's app-server, a Pi catalog read) is started by the first request that needs it and retires after ten minutes without one (`TD_AGENT_IDLE_MS`); Claude Code runs one process per turn. A launch that never opens the agent group never starts a CLI.

The stream is for showing; the file is the truth. While a run goes on, the
canvas shows its events (text, thinking, tool calls, questions) in an overlay
kept by the run manager (`src/lib/agents/runs.ts`); the turn itself is written
into its node by the session sync (`src/lib/sessions/sync.ts`) from the session
file, read by the same adapters the atlas uses — the one writer of session turns
on the canvas. Anything a runtime does beyond these kinds stays inside its own file.

When a branch cannot be cut (the file does not hold the turn that way, the turn
is still open), a runtime opens a fresh session and sends `context` ahead of the
`question` instead. The canvas only asks to continue or branch when nothing above
the question was edited on the canvas or wired in beside the conversation
(`src/lib/agents/pristine.ts`); which runtimes can branch at all is `caps.forkAt`
in `src/lib/agents/agent-runtime.ts`.

A run is not tied to the page or the canvas that started it: closing or
reloading the page, or switching to another canvas, does not stop it (only
`abort` does). Before it starts, the node records a binding: the session it
continues and the turn it follows, or — for a fresh session — the session the
run names in its first `session` event. The session sync finds the run's turn in
the file by that binding and writes it into the node, now or whenever that canvas
is in view again; a question the run asks while its canvas is out of view waits
in the page's top bar.
