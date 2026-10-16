#!/usr/bin/env node
// A turn reads the way it happened: each session format records how far
// the answer had got when a tool call came back (textAt), and the panel
// cuts the answer there, one folded line per run of calls. A turn whose
// offsets no longer describe its text reads as one line ahead of it all.
//
// Run: node scripts/test-transcript.mjs
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'td-transcript-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const entry = join(dir, 'entry.mjs');
const src = `${process.cwd()}/src/lib`;
writeFileSync(entry, [
  `export { ClaudeSessionCollector } from '${src}/adapters/claude-code-session.ts';`,
  `export { CodexSessionCollector } from '${src}/adapters/codex-session.ts';`,
  `export { toolSteps } from '${src}/adapters/shared.ts';`,
  `export { interleave, countSteps } from '${src}/transcript.ts';`,
].join('\n'));
const out = join(dir, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', define: { 'import.meta.env.DEV': 'false', 'import.meta.env': '{}' } });
const { ClaudeSessionCollector, CodexSessionCollector, toolSteps, interleave, countSteps } = await import(out);
const feed = (c, lines) => { for (const l of lines) c.feedLine(JSON.stringify(l)); };
const shape = (parts) => parts.map((p) => (p.kind === 'text' ? p.text : p.steps.map((s) => s.tool).join('+')));

test('claude code: a call sits after the text written before it', () => {
  const c = new ClaudeSessionCollector();
  const base = { sessionId: 's-1', cwd: '/w' };
  const say = (uuid, parent, text, stop = 'tool_use') => ({ ...base, type: 'assistant', uuid, parentUuid: parent, message: { role: 'assistant', model: 'm', stop_reason: stop, content: [{ type: 'text', text }] } });
  const call = (uuid, parent, id, name, input) => ({ ...base, type: 'assistant', uuid, parentUuid: parent, message: { role: 'assistant', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
  const result = (uuid, parent, id) => ({ ...base, type: 'user', uuid, parentUuid: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  feed(c, [
    { ...base, type: 'user', uuid: 'u0', parentUuid: null, message: { role: 'user', content: 'fix it' } },
    say('a0', 'u0', 'Let me look.'),
    call('a1', 'a0', 't0', 'Read', { file_path: '/w/a.ts' }),
    result('r0', 'a1', 't0'),
    call('a2', 'r0', 't1', 'Grep', { pattern: 'x' }),
    result('r1', 'a2', 't1'),
    say('a3', 'r1', 'Found it; editing.'),
    call('a4', 'a3', 't2', 'Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }),
    result('r2', 'a4', 't2'),
    say('a5', 'r2', 'Done.', 'end_turn'),
  ]);
  const turn = c.finish().turns[0];
  assert.equal(turn.response, 'Let me look.\n\nFound it; editing.\n\nDone.');
  const steps = toolSteps(turn);
  assert.deepEqual(steps.map((s) => s.textAt), [12, 12, 32]);
  assert.deepEqual(shape(interleave(turn.response, steps, true)), ['Let me look.', 'Read+Grep', 'Found it; editing.', 'Edit', 'Done.']);
});

test('claude code: the CLI\'s own note after a pasted image stays in the turn', () => {
  const c = new ClaudeSessionCollector();
  const base = { sessionId: 's-2', cwd: '/w' };
  feed(c, [
    { ...base, type: 'user', uuid: 'u0', parentUuid: null, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }, { type: 'text', text: 'what is this' }] } },
    { ...base, type: 'attachment', uuid: 'x0', parentUuid: 'u0' },
    { ...base, type: 'user', isMeta: true, uuid: 'm0', parentUuid: 'x0', message: { role: 'user', content: [{ type: 'text', text: '[Image: source: /tmp/shot.png]' }] } },
    { ...base, type: 'assistant', uuid: 'a0', parentUuid: 'm0', message: { role: 'assistant', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'A chart.' }] } },
  ]);
  const turns = c.finish().turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].question, 'what is this');
  assert.equal(turns[0].response, 'A chart.');
});

test('codex: a folded segment\'s calls shift with its text', () => {
  const c = new CodexSessionCollector();
  feed(c, [
    { type: 'session_meta', payload: { id: 'cx-1', cwd: '/w', timestamp: '2026-10-01T00:00:00Z' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'turn_context', payload: { turn_id: 't1', cwd: '/w', model: 'm' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First.' }] } },
    // a scheduling marker splits the turn; the segment folds back into it
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1b' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Running.' }] } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":["ls"]}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'a.ts' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Listed.' }] } },
  ]);
  const turns = c.finish().turns;
  assert.equal(turns.length, 1, 'the segment folded into the turn');
  const turn = turns[0];
  assert.equal(turn.response, 'First.\n\nRunning.\n\nListed.');
  const steps = toolSteps(turn);
  assert.deepEqual(steps.map((s) => s.textAt), ['First.\n\nRunning.'.length]);
  assert.deepEqual(shape(interleave(turn.response, steps, true)), ['First.\n\nRunning.', 'shell', 'Listed.']);
});

test('without offsets, or once the text changed, the calls read as one line ahead of the answer', () => {
  const steps = [{ id: '1', tool: 'Read', op: 'read', paths: ['/a'], call: '', result: '' }, { id: '2', tool: 'Bash', op: 'run', call: 'ls', result: '' }];
  assert.deepEqual(shape(interleave('One.\n\nTwo.', steps, true)), ['Read+Bash', 'One.\n\nTwo.']);
  const placed = steps.map((s, i) => ({ ...s, textAt: i === 0 ? 4 : 11 }));
  assert.deepEqual(shape(interleave('One.\n\nTwo.', placed, true)), ['One.', 'Read', 'Two.', 'Bash']);
  assert.deepEqual(shape(interleave('Edited by hand.', placed, false)), ['Read+Bash', 'Edited by hand.']);
  // an offset past the end (the text got shorter) lands at the end, never throws
  assert.deepEqual(shape(interleave('One.', placed, true)), ['One.', 'Read+Bash']);
});

test('a run of calls is counted by what it did: files by distinct path, the rest by call', () => {
  const counts = countSteps([
    { tool: 'Read', op: 'read', paths: ['/a'] },
    { tool: 'Read', op: 'read', paths: ['/a'] },
    { tool: 'Read', op: 'read', paths: ['/b'] },
    { tool: 'Write', op: 'write', paths: ['/c'] },
    { tool: 'Edit', op: 'edit', paths: ['/c'] },
    { tool: 'Bash', op: 'run' },
    { name: 'Grep' },
  ]);
  assert.deepEqual(counts, [{ op: 'read', n: 2 }, { op: 'search', n: 1 }, { op: 'edit', n: 1 }, { op: 'run', n: 1 }]);
});
