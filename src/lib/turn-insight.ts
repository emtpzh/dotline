import type { ThoughtData } from '../types';

// The self-explaining chain: everything here renders information the
// import already carries for free — no LLM calls, no new state. A turn's
// steps leave a FOOTPRINT of the files it touched.

export interface FootprintEntry { path: string; name: string; op: 'read' | 'write' | 'edit' }

/** The files this turn touched, straight from its steps —
 *  writes and edits first, then reads, each path once. This is what a
 *  reader looking back needs (the panel's changed-files line); the calls
 *  themselves stay in the drawer. Empty for hand-made nodes. */
export function footprint(data: Pick<ThoughtData, 'steps'>): FootprintEntry[] {
  const seen = new Map<string, FootprintEntry>();
  for (const step of data.steps ?? []) {
    if (!step.paths?.length || (step.op !== 'read' && step.op !== 'write' && step.op !== 'edit')) continue;
    for (const path of step.paths) {
      const prev = seen.get(path);
      if (!prev) seen.set(path, { path, name: path.split('/').filter(Boolean).pop() ?? path, op: step.op });
      else if (prev.op === 'read' && step.op !== 'read') prev.op = step.op;
    }
  }
  return [...seen.values()].sort((a, b) => (a.op === 'read' ? 1 : 0) - (b.op === 'read' ? 1 : 0));
}

/** The closing paragraph of an answer. Agents state their conclusion
 *  LAST — the opening line is usually "let me look at…" — so a collapsed
 *  imported turn shows its end, not its start. */
export function conclusionOf(response: string, max = 140): string {
  const paras = response
    .replace(/```[\s\S]*?```/g, '')
    .split(/\n\s*\n/)
    .map((p) => p
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images → their text
      .replace(/[#*`>|_~]/g, '')
      .replace(/^\s*[-•\d.)]+\s*/gm, '')
      .replace(/\s+/g, ' ')
      .trim())
    // a lead-in to a block ("Now the warnings:"), a sources line, a bare
    // closing offer — none of these is the finding
    .filter((p) => p.length > 12 && !/[:：]$/.test(p) && !/^(sources?|references?|来源|参考)\b/i.test(p));
  const substantive = paras.filter((p) => p.length >= 30);
  const last = substantive[substantive.length - 1] ?? paras[paras.length - 1]
    ?? response.replace(/[#*`>-]/g, '').replace(/\s+/g, ' ').trim();
  return last.length > max ? `${last.slice(0, max)}…` : last;
}
