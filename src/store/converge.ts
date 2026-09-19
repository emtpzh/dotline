import type { ThoughtNode, ThoughtEdge } from '../types';
import type { ContextMessage, ImageAttachment } from '../lib/api';
import { buildContext, type MessageSource } from './context-builder';
import { t, fmt } from '../i18n';

// A converge node (merge / weave) is asked like any other node — created
// unasked off a selection, its question typed on the node — but answers
// through its own prompt: the first ask and every rerun build it here, the
// person's question riding along as the extra request (none = the default).

export type ConvergeRun = { question: string; messages: ContextMessage[]; images: ImageAttachment[]; sources: MessageSource[] };

type Converge = NonNullable<ThoughtNode['data']['converge']>;

/** The question a converge node shows when it was asked with no request of its own. */
export function convergeDefaultQuestion(c: Converge, nodes: ThoughtNode[]): string {
  if (c.kind === 'weave') return fmt(t('weave.defaultQuestion'), { n: weaveEntries(c, nodes).length });
  return fmt(t('converge.mergeDefault'), { n: c.sources.length });
}

/** The marks a weave threads, in canvas order then mark order per node. */
function weaveEntries(c: Converge, nodes: ThoughtNode[]): { n: number; text: string; from: string }[] {
  const wanted = c.highlightIds ? new Set(c.highlightIds) : null;
  const entries: { n: number; text: string; from: string }[] = [];
  for (const node of nodes) {
    if (!c.sources.includes(node.id)) continue;
    const title = node.data.question.replace(/\s+/g, ' ').trim().slice(0, 60);
    for (const h of node.data.highlights || []) {
      if (wanted && !wanted.has(h.id)) continue;
      entries.push({ n: entries.length + 1, text: h.text, from: title });
    }
  }
  return entries;
}

/** The run of a converge node with this request ('' = none), or null when
 *  there is nothing left to converge (every weave mark removed meanwhile). */
export function convergeRun(nodeId: string, request: string, nodes: ThoughtNode[], edges: ThoughtEdge[], staleIds?: ReadonlySet<string> | string[]): ConvergeRun | null {
  const node = nodes.find((n) => n.id === nodeId);
  const c = node?.data.converge;
  if (!node || !c) return null;
  const req = request.trim();
  const sources = c.sources.filter((id) => nodes.some((n) => n.id === id));

  if (c.kind === 'weave') {
    // Merge compresses RAW content; weave works on the person's OWN marks —
    // already human-curated, so the model's job is editorial and every
    // sentence cites [n] back to a mark. The fan-in edges carry provenance
    // and the full upstream for follow-ups; this run feeds ONLY the marks.
    const entries = weaveEntries({ ...c, sources }, nodes);
    if (entries.length === 0) return null;
    const list = entries.map((e) => `${fmt(t('weave.entry'), { n: String(e.n), from: e.from })}\n${e.text}`).join('\n\n');
    return {
      question: req || convergeDefaultQuestion(c, nodes),
      images: [],
      sources: sources.map((nid) => ({ layer: 'chain' as const, nodeId: nid, part: 'response' as const })),
      messages: [
        { role: 'system', content: 'You weave a user\'s own highlighted passages into one coherent text. CRITICAL: Your output language MUST match the primary language of the highlights. Do not translate.' },
        { role: 'user', content: `以下是我在一次探索中亲手标记的 ${entries.length} 条高光，按画布顺序编号，每条注明出处节点。(Below are the ${entries.length} passages I highlighted myself during an exploration, numbered in canvas order, each with its source node.)

${list}` },
        { role: 'user', content: `把这些高光串联成一段连贯的文字。(Weave these highlights into one coherent passage.)

规则 / Rules:
1. 输出语言与高光的主要语言一致。(Match the highlights' primary language.)
2. 这些是我自己判断过的重点：忠实串联与衔接，不要引入高光之外的新论断。(These are MY judged marks: thread and connect them faithfully; introduce no claims beyond the highlights.)
3. 每个来自高光的表述标注 [n] 引用其编号，方便我回溯。(Cite [n] for every statement drawn from a highlight.)
4. 高光之间的矛盾要点明，不要抹平。(Name contradictions between highlights; do not smooth them over.)
5. 只输出串联后的文字。(Output only the woven passage.)${req ? `

用户对这次串联的额外要求（优先满足）/ The user's specific request (takes priority):
${req}` : ''}` },
      ],
    };
  }

  // Merge: the context arrives through the fan-in edges (the selection's
  // sinks, ancestors flowing in along their chains); the prompt is instruction only
  const ctx = buildContext(
    nodeId,
    nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, question: '', response: '' } } : n)),
    edges,
    undefined, node.data.excludedAttachmentIds, node.data.includedAttachmentIds, staleIds,
  );
  return {
    question: req || convergeDefaultQuestion(c, nodes),
    images: ctx.images,
    // the converged selection IS the members, plus whatever the compiler drew
    sources: [...sources.map((nid) => ({ layer: 'chain' as const, nodeId: nid, part: 'response' as const })), ...ctx.sources],
    messages: [
      { role: 'system', content: `You merge conversation nodes. CRITICAL: Your output language MUST match the primary language of the user content. If the content is in Chinese, respond in Chinese. If English, respond in English. Never use German or any other language unless the content is in that language. Do not translate — use the same language as the source.` },
      ...ctx.messages,
      { role: 'user', content: `将以上讨论综合为一份完整文档。(Synthesize the discussion above into one comprehensive document.)

规则 / Rules:
1. 输出语言必须与上面内容的主要语言一致。(Output language must match the primary language of the content above.)
2. 这是综合(synthesis)，不是流水摘要：提炼出经过这些讨论后「我们现在知道什么」。(This is a SYNTHESIS, not a running summary: distill what we NOW KNOW after these discussions.)
3. 按此结构组织 / Structure:
   - **结论 (Conclusions)** — 立得住的要点，合并重复表述 (consolidated takeaways, dedup repeated points)
   - **依据 (Key evidence)** — 支撑结论的关键论据/数据/引用 (the arguments, data or citations that carry the conclusions)
   - **分歧与未决 (Open questions)** — 节点间的矛盾之处与尚未回答的问题 (contradictions between nodes and what remains unanswered)
4. 保留所有独特洞见与引用标注，丢弃寒暄和重复。(Keep every unique insight and citation marker; drop filler and repetition.)
5. 只输出综合后的内容，不要元评论。(Output ONLY the synthesis.)${req ? `

用户对这次综合的额外要求（优先满足，可覆盖上面的结构）/ The user's specific request for this synthesis (takes priority, may override the structure above):
${req}` : ''}` },
    ],
  };
}
