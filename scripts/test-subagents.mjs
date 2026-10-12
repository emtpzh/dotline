#!/usr/bin/env node
// Subagent fan-out on the canvas: a Pi turn whose `subagent` tool ran three agents becomes one turn
// node with three branch children; a Claude Code turn that launched an Agent gets a child too, and
// adopting the agent's own sidechain file gives that child its tool footprint. A DSH turn's subagent
// calls branch too: a foreground call's result is its answer, a background one is named by the
// catalog and answered by the child's relayed report. A child never takes the main column: the next
// turn still continues the chain.
//
// Run: node scripts/test-subagents.mjs
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'td-subagents-'));
const entry = join(dir, 'entry.mjs');
writeFileSync(entry, `
  export { PiSessionCollector } from '${process.cwd()}/src/lib/adapters/pi-session.ts';
  export { ClaudeSessionCollector } from '${process.cwd()}/src/lib/adapters/claude-code-session.ts';
  export { adoptSubagentSessions } from '${process.cwd()}/src/lib/adapters/shared.ts';
  export { DshSessionCollector } from '${process.cwd()}/src/lib/adapters/dsh-session.ts';
`);
const out = join(dir, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', define: { 'import.meta.env.DEV': 'false', 'import.meta.env': '{}' } });
const { PiSessionCollector, ClaudeSessionCollector, adoptSubagentSessions, DshSessionCollector } = await import(out);

// ── Pi: three parallel runs in one tool result, details carried whole ──
const pi = new PiSessionCollector();
const L = (o) => pi.feedLine(JSON.stringify(o));
L({ type: 'session', version: 3, id: 'pi-1', timestamp: '2026-09-29T10:00:00.000Z', cwd: '/w' });
L({ type: 'message', id: 'u1', parentId: null, timestamp: 1, message: { role: 'user', content: [{ type: 'text', text: '把三块的调查分给三个人' }] } });
L({ type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: '分头去查。' }, { type: 'toolCall', id: 'call-1', name: 'subagent', arguments: { tasks: [{ agent: 'scout', task: '查 A' }, { agent: 'scout', task: '查 B' }, { agent: 'reviewer', task: '看 C' }] } }] } });
L({ type: 'message', id: 'r1', parentId: 'a1', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'subagent', content: [{ type: 'text', text: '(3 results)' }],
  details: { mode: 'parallel', results: [
    { agent: 'scout', task: '查 A', messages: [{ role: 'user', content: [{ type: 'text', text: '查 A' }] }, { role: 'assistant', content: [{ type: 'text', text: 'A 是这样' }] }] },
    { agent: 'scout', task: '查 B', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'B 是那样' }] }] },
    { agent: 'reviewer', task: '看 C', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'C 没问题' }] }] },
  ] } } });
L({ type: 'message', id: 'a2', parentId: 'r1', message: { role: 'assistant', content: [{ type: 'text', text: '汇总：A 这样，B 那样，C 没问题。' }] } });
L({ type: 'message', id: 'u2', parentId: 'a2', message: { role: 'user', content: [{ type: 'text', text: '那下一步呢' }] } });
L({ type: 'message', id: 'a3', parentId: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: '先做 A。' }] } });
const g = pi.toConversation().build();
const turns = g.nodes.filter((n) => n.data.importSource && !n.data.importSource.subagent);
const kids = g.nodes.filter((n) => n.data.importSource?.subagent);
assert.equal(turns.length, 2, 'two turns');
assert.equal(kids.length, 3, 'three subagent children');
assert.deepEqual(kids.map((k) => k.data.question), ['[scout] 查 A', '[scout] 查 B', '[reviewer] 看 C']);
assert.deepEqual(kids.map((k) => k.data.response), ['A 是这样', 'B 是那样', 'C 没问题']);
assert.ok(kids.every((k) => k.data.isBranch), 'children are branch nodes');
const t1 = turns[0], t2 = turns[1];
assert.ok(kids.every((k) => k.data.importSource.subagent.of === t1.data.importSource.itemIds[0]), 'children name their turn');
assert.ok(kids.every((k) => g.edges.some((e) => e.source === t1.id && e.target === k.id && e.data?.isBranchFromSelection)), 'branch edges from the turn');
assert.ok(g.edges.some((e) => e.source === t1.id && e.target === t2.id && !e.data?.isBranchFromSelection), 'the next turn continues the chain');
assert.equal(t2.position.x, t1.position.x, 'the next turn keeps the main column');
assert.ok(kids.every((k) => k.position.x > t1.position.x), 'children sit beside, not below');
assert.equal(new Set(kids.map((k) => k.data.importSource.itemIds[0])).size, 3, 'each child has its own id');
assert.equal(t1.data.response, '分头去查。\n\n汇总：A 这样，B 那样，C 没问题。', 'the parent keeps its whole answer');
console.log('pi: 3 subagent runs → 3 branch children, chain intact');

// ── Pi without details: one run, the result text is its answer ──
const pi2 = new PiSessionCollector();
const L2 = (o) => pi2.feedLine(JSON.stringify(o));
L2({ type: 'session', version: 3, id: 'pi-2', timestamp: '2026-09-29T10:00:00.000Z', cwd: '/w' });
L2({ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: '让 scout 看看' }] } });
L2({ type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'subagent', arguments: { agent: 'scout', task: '看看仓库' } }] } });
L2({ type: 'message', id: 'r1', parentId: 'a1', message: { role: 'toolResult', toolCallId: 'c', toolName: 'subagent', content: [{ type: 'text', text: '仓库有三个包' }] } });
L2({ type: 'message', id: 'a2', parentId: 'r1', message: { role: 'assistant', content: [{ type: 'text', text: '三个包。' }] } });
const g2 = pi2.toConversation().build();
const k2 = g2.nodes.filter((n) => n.data.importSource?.subagent);
assert.equal(k2.length, 1); assert.equal(k2[0].data.question, '[scout] 看看仓库'); assert.equal(k2[0].data.response, '仓库有三个包');
console.log('pi: a single run without details reads the result text');

// ── Claude Code: an Agent call, then its sidechain file adopted ──
const cc = new ClaudeSessionCollector();
const C = (o) => cc.feedLine(JSON.stringify(o));
C({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'cc-1', cwd: '/w', timestamp: '2026-09-29T10:00:00.000Z', message: { role: 'user', content: '摸清目录' } });
C({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'cc-1', message: { role: 'assistant', content: [{ type: 'text', text: '派一个探索代理。' }, { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { subagent_type: 'Explore', description: '摸清目录', prompt: '在 /w 下列出所有包' } }] } });
C({ type: 'user', uuid: 'u1b', parentUuid: 'a1', sessionId: 'cc-1', timestamp: '2026-09-29T10:00:30.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '三个包：a、b、c' }] } });
C({ type: 'assistant', uuid: 'a2', parentUuid: 'u1b', sessionId: 'cc-1', message: { role: 'assistant', content: [{ type: 'text', text: '有三个包。' }] } });
C({ type: 'user', uuid: 'u2', parentUuid: 'a2', sessionId: 'cc-1', timestamp: '2026-09-29T10:01:00.000Z', message: { role: 'user', content: '先看 a' } });
C({ type: 'assistant', uuid: 'a3', parentUuid: 'u2', sessionId: 'cc-1', message: { role: 'assistant', content: [{ type: 'text', text: 'a 是入口。' }] } });
const conv = cc.toConversation();
// the child's own file: sidechain top to bottom
const side = new ClaudeSessionCollector();
const S = (o) => side.feedLine(JSON.stringify(o));
S({ type: 'user', uuid: 's1', parentUuid: null, isSidechain: true, agentId: 'agent-x', sessionId: 'cc-1', cwd: '/w', timestamp: '2026-09-29T10:00:05.000Z', message: { role: 'user', content: '在 /w 下列出所有包' } });
S({ type: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true, agentId: 'agent-x', sessionId: 'cc-1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s', name: 'Bash', input: { command: 'ls /w' } }] } });
S({ type: 'user', uuid: 's3', parentUuid: 's2', isSidechain: true, agentId: 'agent-x', sessionId: 'cc-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'a b c' }] } });
S({ type: 'assistant', uuid: 's4', parentUuid: 's3', isSidechain: true, agentId: 'agent-x', sessionId: 'cc-1', message: { role: 'assistant', content: [{ type: 'text', text: '三个包：a、b、c' }] } });
const sub = side.toSubagentSession();
assert.ok(sub && sub.sessionId === 'agent-x' && sub.firstQuestion === '在 /w 下列出所有包', 'the sidechain file reads as a subagent session');
conv.adopt([sub]);
const g3 = conv.build();
const ccTurns = g3.nodes.filter((n) => n.data.importSource && !n.data.importSource.subagent);
const ccKids = g3.nodes.filter((n) => n.data.importSource?.subagent);
assert.equal(ccTurns.length, 2); assert.equal(ccKids.length, 1);
assert.equal(ccKids[0].data.question, '[Explore] 摸清目录');
assert.equal(ccKids[0].data.response, '三个包：a、b、c');
assert.deepEqual(ccKids[0].data.importSource.itemIds, ['toolu_1', 'agent-x'], 'call id first, the child session id once adopted');
assert.ok((ccKids[0].data.steps ?? []).length >= 1, 'the child carries the sidechain tool footprint as steps');
assert.equal(ccTurns[1].position.x, ccTurns[0].position.x, 'the next turn keeps the main column');
console.log('claude-code: Agent call → child; sidechain adopted with its tools');

// ── Codex: the parent never names the child; a child is paired by time with the turn it started under ──
const turnsByTime = [
  { question: 'q1', response: 'r1', itemIds: ['t1'], tools: [], at: '2026-09-29T10:00:00.000Z' },
  { question: 'q2', response: 'r2', itemIds: ['t2'], tools: [], at: '2026-09-29T10:05:00.000Z' },
];
adoptSubagentSessions(turnsByTime, [
  { runner: 'codex', sessionId: 'child-1', firstQuestion: '查依赖', at: '2026-09-29T10:02:00.000Z', turns: [{ question: '查依赖', response: '十二个依赖', itemIds: ['c1'], tools: [{ name: 'exec_command', call: 'npm ls', result: '…', truncated: false, op: 'run' }] }] },
  { runner: 'codex', sessionId: 'child-2', firstQuestion: '跑测试', at: '2026-09-29T10:06:00.000Z', turns: [{ question: '跑测试', response: '全过', itemIds: ['c2'], tools: [] }] },
]);
assert.equal(turnsByTime[0].subagents?.length, 1); assert.equal(turnsByTime[0].subagents[0].output, '十二个依赖'); assert.equal(turnsByTime[0].subagents[0].tools?.length, 1);
assert.equal(turnsByTime[1].subagents?.length, 1); assert.equal(turnsByTime[1].subagents[0].task, '跑测试');
console.log('codex: children paired by time with the turn they started under');

// ── DSH: one foreground run, two background runs named by the catalog, a report relayed later ──
const dsh = new DshSessionCollector();
const D = (o) => dsh.feedLine(JSON.stringify(o));
const userMsg = (seq, text, source = { kind: 'user' }) => D({ type: 'user/message', seq, time: 1790000000000 + seq * 1000, data: { content: [{ type: 'text', text }], source, id: `u${seq}` } });
const say = (seq, turn, step, text) => D({ type: 'assistant/message', seq, data: { turn, step, message: { content: [{ type: 'text', text }], id: `a${seq}` } } });
const call = (seq, turn, callId, description, prompt) => D({ type: 'tool/call', seq, data: { turn, step: 1, callId, name: 'subagent', arguments: JSON.stringify({ description, prompt }) } });
const result = (seq, turn, callId, text) => D({ type: 'tool/result', seq, time: 1790000000000 + seq * 1000, data: { turn, step: 1, message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }] } } });
D({ type: 'session', version: 4, id: 'session-parent', createdAt: 1790000000000, cwd: '/w' });
userMsg(1, '分析这个仓库');
say(2, 1, 1, '分三路去查。');
call(3, 1, 'c-fg', 'List packages', '列出 /w 下所有包');
result(4, 1, 'c-fg', '三个包：a、b、c');
call(5, 1, 'c-bg1', 'Frontend dive', '只看 src/');
call(6, 1, 'c-bg2', 'Backend dive', '只看 server.mjs');
D({ type: 'subagent/catalog', seq: 7, data: { version: 0, childId: 'child-front', childCreatedAt: 1790000007000, mode: 'continuable', label: 'Frontend dive' } });
result(8, 1, 'c-bg1', 'started subagent child-front');
D({ type: 'subagent/catalog', seq: 9, data: { version: 0, childId: 'child-back', childCreatedAt: 1790000009000, mode: 'continuable', label: 'Backend dive' } });
// a background job's result names the job, not the child: the catalog's label pairs it
result(10, 1, 'c-bg2', 'started background subagent job job-2');
say(11, 1, 2, '等他们回来。');
userMsg(12, 'Agent child-front sent a message: ', { kind: 'agent-message', form: 'relay', senderSessionId: 'child-front' });
D({ type: 'user/message', seq: 13, data: { content: [{ type: 'text', text: 'Agent child-front sent a message: ' }, { type: 'text', text: '前端报告：三个 store' }], source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child-front' } } });
D({ type: 'user/message', seq: 14, data: { content: [{ type: 'text', text: 'Background subagent child-front finished and will do no further work unless you send it more.' }, { type: 'text', text: 'Its closing message:' }, { type: 'text', text: '报告已发给父 agent' }], source: { kind: 'subagent-settled', form: 'notice', summary: '…', senderSessionId: 'child-front' } } });
D({ type: 'user/message', seq: 15, data: { content: [{ type: 'text', text: 'Background subagent child-back finished and will do no further work unless you send it more.' }, { type: 'text', text: 'Its closing message:' }, { type: 'text', text: '后端报告：五个路由' }], source: { kind: 'subagent-settled', form: 'notice', summary: '…', senderSessionId: 'child-back' } } });
userMsg(16, '那先改哪');
say(17, 2, 1, '先改前端。');
const dconv = dsh.toConversation();
assert.deepEqual(dconv.children(), ['child-front', 'child-back'], 'the parent names its background children');
// the child's own log: origin subagent, its prompt first, one tool
const child = new DshSessionCollector();
const K = (o) => child.feedLine(JSON.stringify(o));
K({ type: 'session', version: 4, id: 'child-front', createdAt: 1790000007000, cwd: '/w', parentSession: 'session-parent', isSeeded: false, origin: 'subagent', delegationDepth: 1 });
K({ type: 'user/message', seq: 1, time: 1790000007000, data: { content: [{ type: 'text', text: '只看 src/' }], source: { kind: 'user' }, id: 'k1' } });
K({ type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'k-read', name: 'read', arguments: JSON.stringify({ path: '/w/src/store.ts' }) } });
K({ type: 'tool/result', seq: 3, data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'k-read' }, content: [{ type: 'text', text: 'export …' }] } } });
K({ type: 'assistant/message', seq: 4, data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '三个 store' }], id: 'ka' } } });
const childSub = child.toSubagentSession();
assert.ok(childSub && childSub.runner === 'dsh' && childSub.sessionId === 'child-front', 'a delegated DSH log reads as a subagent session');
const forkHead = new DshSessionCollector();
forkHead.feedLine(JSON.stringify({ type: 'session', version: 4, id: 'fork', createdAt: 1, parentSession: 'session-parent', isSeeded: true, delegationDepth: 0 }));
forkHead.feedLine(JSON.stringify({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' }, id: 'f1' } }));
assert.equal(forkHead.toSubagentSession(), null, 'a fork names a parent but is no subagent');
dconv.adopt([childSub]);
const g4 = dconv.build();
const dTurns = g4.nodes.filter((n) => n.data.importSource && !n.data.importSource.subagent);
const dKids = g4.nodes.filter((n) => n.data.importSource?.subagent);
assert.equal(dTurns.length, 2, 'relayed reports and settled notices open no turns');
assert.deepEqual(dKids.map((k) => k.data.question), ['[subagent] List packages', '[subagent] Frontend dive', '[subagent] Backend dive']);
assert.equal(dKids[0].data.response, '三个包：a、b、c', 'a foreground result is the answer');
assert.equal(dKids[1].data.response, '前端报告：三个 store\n\n报告已发给父 agent', 'a background run answers with what its child sent back');
assert.equal(dKids[2].data.response, '后端报告：五个路由', 'the catalog pairs a run its result did not name');
assert.deepEqual(dKids[1].data.importSource.itemIds, ['c-bg1', 'child-front'], 'call id first, the child session id once adopted');
assert.ok((dKids[1].data.steps ?? []).length === 1, 'the adopted child carries its steps');
assert.ok(dKids.every((k) => g4.edges.some((e) => e.source === dTurns[0].id && e.target === k.id && e.data?.isBranchFromSelection)), 'branch edges from the launching turn');
assert.equal(dTurns[1].position.x, dTurns[0].position.x, 'the next turn keeps the main column');
assert.equal(dTurns[0].data.response, '分三路去查。\n\n等他们回来。', 'the parent keeps its own answer');
console.log('dsh: foreground and background subagents branch off their turn, reports and transcripts adopted');

rmSync(dir, { recursive: true, force: true });
console.log('ok');
