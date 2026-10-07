import type { ThoughtData } from '../types';
import { activeSummary, activeTopic, awaitingInput } from '../utils';
import { conclusionOf } from './turn-insight';
import type { NodeRoute } from './edge-look';

// The one display grammar every card follows, at every zoom. A card holds
// four layers in a fixed order — name, question, conclusion, body — and
// zooming out only takes layers away from the bottom; it never swaps what a
// slot says. Expanded shows all four, the folded / map face the first
// three, the far view only the name row reduced to its shape and name.

/** 'unlinked' is material's own: on the canvas, read by no one (no wire out). */
export type FaceState = 'failed' | 'wait' | 'running' | 'upstream' | 'stale' | 'unlinked';
export type FaceTone = 'primary' | 'explore' | 'warning' | 'muted';
/** Two kinds of things on a canvas: a turn (round) and material (square). */
export type FaceShape = 'round' | 'square';

/** The one state a card reports, highest priority first. Same mark at
 *  every zoom: a dot with a label, the far view keeps only its color. */
export function faceState(
  data: Pick<ThoughtData, 'stepKind' | 'question' | 'response' | 'isLoading' | 'generationFailed'>,
  isStale: boolean,
): FaceState | null {
  if (data.generationFailed && !data.isLoading) return 'failed';
  if (awaitingInput(data)) return 'wait';
  if (data.isLoading) return 'running';
  if (data.stepKind === 'prompt' && !data.response) return 'upstream';
  if (isStale) return 'stale';
  return null;
}

/** Color of the wire that brought this node here — the same color as its
 *  left bar and as that wire (lib/edge-look). A paradigm's human turn keeps
 *  the warm tone: the person acts there. */
export function faceTone(route: NodeRoute, stepKind?: ThoughtData['stepKind']): FaceTone {
  if (stepKind === 'human' || route === 'fork') return 'explore';
  return 'primary';
}

// A name is short enough to sit beside a dot on the far view: CJK counts
// double, so both scripts stop at about the same printed width.
const NAME_UNITS = 24;
const WIDE = /[⺀-鿿가-힯豈-﫿＀-￯]/;

export function clipName(text: string): string {
  const clean = text.replace(/[#*`>_~]/g, '').replace(/\s+/g, ' ').trim();
  let units = 0;
  let out = '';
  for (const ch of clean) {
    const w = WIDE.test(ch) ? 2 : 1;
    if (units + w > NAME_UNITS) return `${out.trimEnd()}…`;
    units += w;
    out += ch;
  }
  return out;
}

/** The node's short name: the judged topic of the active version, or the
 *  opening of its question until a topic arrives. */
export function nodeName(data: Pick<ThoughtData, 'summaryTopics' | 'responseIndex' | 'question'>): string | null {
  return activeTopic(data) ?? (data.question.trim() ? clipName(data.question) : null);
}

/** What a role is called where the canvas shows it: its name, else the
 *  opening of its prompt. */
export function roleLabel(role: { roleName?: string; rolePrompt?: string }): string {
  if (role.roleName?.trim()) return role.roleName.trim();
  const prompt = (role.rolePrompt ?? '').replace(/\s+/g, ' ').trim();
  return prompt.length > 14 ? `${prompt.slice(0, 14)}…` : prompt;
}

/** A short name for any node, materials included — for sentences that
 *  point at one ("wired in the material 「repro steps」"). */
export function shortName(data: ThoughtData): string {
  if (data.stepKind === 'file') return clipName(data.attachments?.[0]?.name ?? '');
  if (data.stepKind === 'link') return clipName(data.linkTitle && !data.linkTitle.startsWith('⚠') ? data.linkTitle : data.linkUrl ?? '');
  if (data.stepKind === 'note') return data.summaryTopics?.[0] ?? clipName(data.question.replace(/^#+\s*/gm, ''));
  return nodeName(data) ?? '';
}

/** What this step yielded, in one line: the judged takeaway, or — until it
 *  arrives — the answer's close (imported agent turns state their finding
 *  last) or its opening. */
export function nodeConclusion(data: Pick<ThoughtData, 'summaries' | 'summary' | 'responseIndex' | 'response' | 'isLoading' | 'importSource'>): string | null {
  const judged = activeSummary(data);
  if (judged) return judged;
  if (!data.response || data.isLoading) return null;
  if (data.importSource) return conclusionOf(data.response);
  const plain = data.response.replace(/[#*`>|_~-]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > 140 ? `${plain.slice(0, 140)}…` : plain;
}

/** Far-view label priority: which names survive when the map gets dense.
 *  3 root / selected, 2 needs attention, 1 an ordinary step, 0 material. */
export function farPriority(opts: { isRoot?: boolean; selected: boolean; state: FaceState | null; material?: boolean }): number {
  if (opts.isRoot || opts.selected) return 3;
  if (opts.state === 'wait' || opts.state === 'running' || opts.state === 'failed') return 2;
  return opts.material ? 0 : 1;
}
