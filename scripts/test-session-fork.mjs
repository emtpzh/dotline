#!/usr/bin/env node
// Two clients on one Claude Code session: the desktop app asks, the canvas
// resumes the session from the CLI for two turns, then the desktop app
// answers again from its own view. Both later lines fork from the SAME
// non-turn line (a stop-hook summary after the first answer); the desktop's
// turn must hang off the first turn, not off the CLI line's last turn.
//
// Run: node scripts/test-session-fork.mjs
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'td-session-fork-'));
const entry = join(dir, 'entry.mjs');
writeFileSync(entry, `export { ClaudeSessionCollector } from '${process.cwd()}/src/lib/adapters/claude-code-session.ts';`);
const out = join(dir, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', define: { 'import.meta.env.DEV': 'false', 'import.meta.env': '{}' } });
const { ClaudeSessionCollector } = await import(out);

const cc = new ClaudeSessionCollector();
const L = (o) => cc.feedLine(JSON.stringify({ sessionId: 's-1', cwd: '/w', ...o }));
const user = (uuid, parentUuid, text, entrypoint) => L({ type: 'user', uuid, parentUuid, entrypoint, message: { role: 'user', content: text } });
const assistant = (uuid, parentUuid, text) => L({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const hookSummary = (uuid, parentUuid) => L({ type: 'system', subtype: 'stop_hook_summary', uuid, parentUuid });

user('u0', null, '为什么总去查 why_find', 'claude-desktop');
assistant('a0', 'u0', '因为插件注册了它。');
hookSummary('h0', 'a0');
// the canvas resumes from the CLI
user('u1', 'h0', '有必要吗', 'sdk-cli');
assistant('a1', 'u1', '可以关。');
hookSummary('h1', 'a1');
user('u2', 'h1', '都关了吧', 'sdk-cli');
assistant('a2', 'u2', '已关。');
// the desktop app answers from its own last line
user('u3', 'h0', '默认关，除非主动开', 'claude-desktop');
assistant('a3', 'u3', '好。');

const g = cc.toConversation().build();
const turns = g.nodes.filter((n) => n.data.importSource);
assert.equal(turns.length, 4, 'four turns');
const [t0, t1, t2, t3] = turns;
const wired = (a, b) => g.edges.some((e) => e.source === a.id && e.target === b.id);
assert.ok(wired(t0, t1), 'the CLI line continues the first turn');
assert.ok(wired(t1, t2), 'the CLI line goes on');
assert.ok(wired(t0, t3), 'the desktop turn hangs off the turn its client last saw');
assert.ok(!wired(t2, t3), 'the desktop turn does not continue the CLI line');
assert.ok(t3.position.x !== t2.position.x || t3.position.y < t2.position.y, 'the desktop turn is not stacked under the CLI line');
console.log('claude-code: a second client forking from a hook summary hangs off its real parent turn');

rmSync(dir, { recursive: true, force: true });
