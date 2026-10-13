#!/usr/bin/env node
// What each runtime's session file says a turn ran on — model, effort,
// permission, directory — and whether the turn is over, read the same way
// for all four formats. A snapshot never stops the collector: reading goes
// on, and the turn in progress keeps growing.
//
// Run: node scripts/test-session-config.mjs
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'td-session-config-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const entry = join(dir, 'entry.mjs');
const src = `${process.cwd()}/src/lib/adapters`;
writeFileSync(entry, [
  `export { ClaudeSessionCollector } from '${src}/claude-code-session.ts';`,
  `export { CodexSessionCollector } from '${src}/codex-session.ts';`,
  `export { PiSessionCollector } from '${src}/pi-session.ts';`,
  `export { DshSessionCollector } from '${src}/dsh-session.ts';`,
  `export { matchEntry } from '${process.cwd()}/src/lib/agents/runtimes.ts';`,
].join('\n'));
const out = join(dir, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', define: { 'import.meta.env.DEV': 'false', 'import.meta.env': '{}' } });
const { ClaudeSessionCollector, CodexSessionCollector, PiSessionCollector, DshSessionCollector, matchEntry } = await import(out);
const feed = (c, lines) => { for (const l of lines) c.feedLine(JSON.stringify(l)); };

test('claude code: model and effort from the answer, permission and directory from the question', () => {
  const c = new ClaudeSessionCollector();
  const base = { sessionId: 's-1', cwd: '/w' };
  feed(c, [
    { ...base, type: 'user', uuid: 'u0', parentUuid: null, permissionMode: 'auto', message: { role: 'user', content: 'hi' } },
    { ...base, type: 'assistant', uuid: 'a0', parentUuid: 'u0', effort: 'medium', message: { role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't0', name: 'Read', input: { file_path: '/w/x' } }] } },
    { ...base, type: 'user', uuid: 'r0', parentUuid: 'a0', permissionMode: 'auto', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'x' }] } },
  ]);
  let s = c.finish();
  assert.equal(s.turns.length, 1);
  assert.deepEqual(s.turns[0].config, { permission: 'auto', cwd: '/w', model: 'claude-haiku-5-5', effort: 'medium', basis: 'observed' });
  assert.equal(s.turns[0].complete, false, 'a tool result came back: the model goes on');
  // reading goes on after a snapshot: the same turn grows and ends
  feed(c, [{ ...base, type: 'assistant', uuid: 'a1', parentUuid: 'r0', effort: 'medium', message: { role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }]);
  s = c.finish();
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].response, 'done');
  assert.equal(s.turns[0].complete, true);
  // a synthetic line written by the CLI names no model
  feed(c, [
    { ...base, type: 'user', uuid: 'u1', parentUuid: 'a1', permissionMode: 'acceptEdits', message: { role: 'user', content: 'next' } },
    { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'x' }] } },
  ]);
  s = c.finish();
  assert.equal(s.turns[1].config.permission, 'acceptEdits');
  assert.equal(s.turns[1].config.model, undefined);
  assert.equal(s.turns[0].complete, true);
});

test('codex: the turn context says what the turn runs on; task_complete ends it', () => {
  const c = new CodexSessionCollector();
  feed(c, [
    { type: 'session_meta', payload: { id: 'cx-1', cwd: '/start', timestamp: '2026-10-01T00:00:00Z' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'turn_context', payload: { turn_id: 't1', cwd: '/start/sub', model: 'gpt-5.6-sol', effort: 'high', approval_policy: 'never', sandbox_policy: { type: 'workspace-write' } } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
  ]);
  let s = c.finish();
  assert.deepEqual(s.turns[0].config, { model: 'gpt-5.6-sol', effort: 'high', permission: 'workspace-write · never', cwd: '/start/sub', basis: 'observed' });
  assert.equal(s.turns[0].complete, false);
  feed(c, [{ type: 'event_msg', payload: { type: 'task_complete' } }]);
  s = c.finish();
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].complete, true);
});

test('pi: the change entries set the session, the answer says what ran; a tool call is not the end', () => {
  const c = new PiSessionCollector();
  feed(c, [
    { type: 'session', version: 3, id: 'pi-1', timestamp: '2026-10-01T00:00:00Z', cwd: '/p' },
    { type: 'model_change', id: 'm0', parentId: null, provider: 'deepseek', modelId: 'deepseek-flash' },
    { type: 'thinking_level_change', id: 'k0', parentId: 'm0', thinkingLevel: 'high' },
    { type: 'message', id: 'u0', parentId: 'k0', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'message', id: 'a0', parentId: 'u0', message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-pro', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c0', name: 'read', arguments: { path: 'x' } }] } },
  ]);
  let s = c.finish();
  assert.deepEqual(s.turns[0].config, { provider: 'deepseek', model: 'deepseek-pro', effort: 'high', cwd: '/p', basis: 'observed' });
  assert.equal(s.turns[0].complete, false);
  feed(c, [
    { type: 'message', id: 'r0', parentId: 'a0', message: { role: 'toolResult', toolCallId: 'c0', content: [{ type: 'text', text: 'x' }] } },
    { type: 'message', id: 'a1', parentId: 'r0', message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-pro', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } },
  ]);
  s = c.finish();
  assert.equal(s.turns[0].complete, true);
  assert.equal(s.turns[0].response, 'done');
});

test('harness: model selection, each request\'s own model and effort, the preset; turn/end closes the turn', () => {
  const c = new DshSessionCollector();
  feed(c, [
    { type: 'session', version: 0, id: 'session-1', createdAt: 1, cwd: '/h' },
    { type: 'permission/preset', seq: 0, data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', seq: 1, data: { mode: 'workspace-write' } },
    { type: 'model/selection', seq: 2, data: { provider: 'deepseek-official', model: 'deepseek/deepseek-v4-flash', reasoningEffort: 'high' } },
    { type: 'turn/start', seq: 3, data: { turn: 1 } },
    { type: 'user/message', seq: 4, time: 5, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, id: 'm1' } },
    { type: 'request/header', seq: 5, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek/deepseek-v4-pro', reasoningEffort: 'max' } } } },
    { type: 'assistant/message', seq: 6, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }], id: 'a1' } } },
  ]);
  let s = c.finish();
  assert.deepEqual(s.turns[0].config, { provider: 'deepseek-official', model: 'deepseek/deepseek-v4-pro', effort: 'max', permission: 'workspace-write', cwd: '/h', basis: 'observed' });
  assert.equal(s.turns[0].complete, false);
  feed(c, [{ type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'completed' } } }]);
  s = c.finish();
  assert.equal(s.turns[0].complete, true);
});

test('a recorded model finds the picker entry that runs it', () => {
  const entries = ['claude/claude-code/opus', 'claude/claude-code/haiku', 'pi/deepseek/deepseek-pro', 'codex/codex/gpt-5.6-sol'];
  assert.equal(matchEntry('claude-code', { model: 'claude-haiku-5-5' }, entries), 'claude/claude-code/haiku', 'the family alias');
  assert.equal(matchEntry('claude-code', { model: 'claude-mystery-1' }, entries), 'claude/claude-code/claude-mystery-1', 'the full name, as the CLI takes it');
  assert.equal(matchEntry('pi', { provider: 'deepseek', model: 'deepseek-pro' }, entries), 'pi/deepseek/deepseek-pro');
  assert.equal(matchEntry('codex', { model: 'gpt-5.6-sol' }, entries), 'codex/codex/gpt-5.6-sol');
  assert.equal(matchEntry('dsh', { provider: 'p', model: 'm' }, entries), 'harness/agent', 'the session keeps its own model');
  assert.equal(matchEntry('pi', undefined, entries), undefined);
});

test('claude code: a turn the CLI answered with its own error is failed, not answered', () => {
  const c = new ClaudeSessionCollector();
  const base = { sessionId: 's-2', cwd: '/w' };
  feed(c, [
    { ...base, type: 'user', uuid: 'u0', parentUuid: null, message: { role: 'user', content: 'hi' } },
    { ...base, type: 'assistant', uuid: 'a0', parentUuid: 'u0', isApiErrorMessage: true, error: 'authentication_failed', message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'Failed to authenticate' }] } },
  ]);
  const s = c.finish();
  assert.equal(s.turns[0].failed, true);
  assert.equal(s.turns[0].config.model, undefined);
});
