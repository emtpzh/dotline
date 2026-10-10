import type { Element, ElementContent, Parent, Properties, Root, Text } from 'hast';

// Highlights and explore traces, marked on the RENDERED tree.
//
// A highlight is captured from what the reader saw, so it is located in what
// the reader sees: the text of the finished hast (after syntax highlighting
// and KaTeX), not the markdown source. Splicing <mark> tags into the source
// used to print them verbatim inside code blocks and could never find a
// formula. Here each touched text node is split and its slice wrapped, so a
// passage crossing bold, code, links, list items or table cells becomes a
// run of <mark> fragments that never disturbs the structure around them.
//
// Matching ignores whitespace and `$` on both sides: selections and the tree
// disagree on line breaks, tabs between cells and indentation, and a formula
// is captured as `$tex$` (see selectionText) while the tree carries its TeX
// in KaTeX's annotation. A formula is one indivisible atom — touched at all,
// it is marked whole.

export interface MarkSpec {
  text: string;
  /** lower wins where two passages overlap */
  prio: number;
  properties: Properties;
}

type Slot =
  | { kind: 'text'; node: Text; parent: Parent }
  | { kind: 'atom'; node: Element; parent: Parent };

const SKIP = /[\s$]/;
export const compactForMatch = (s: string) => s.replace(/[\s$]/g, '');

const hasClass = (el: Element, name: string) => {
  const c = el.properties?.className;
  return Array.isArray(c) && c.includes(name);
};

function textOf(node: ElementContent | Root): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element' || node.type === 'root') return node.children.map((c) => textOf(c as ElementContent)).join('');
  return '';
}

function findTex(el: Element): string | null {
  for (const c of el.children) {
    if (c.type !== 'element') continue;
    if (c.tagName === 'annotation' && c.properties?.encoding === 'application/x-tex') return textOf(c);
    const inner = findTex(c);
    if (inner !== null) return inner;
  }
  return null;
}

/** Wrap every occurrence of the specs' text in the tree with <mark>. */
export function applyMarks(tree: Root, specs: MarkSpec[]): void {
  if (specs.length === 0) return;

  const slots: Slot[] = [];
  let hay = '';
  // per hay char: which slot it came from and where inside it
  const at: { slot: number; off: number }[] = [];

  const visit = (node: ElementContent, parent: Parent) => {
    if (node.type === 'text') {
      const slot = slots.push({ kind: 'text', node, parent }) - 1;
      for (let i = 0; i < node.value.length; i++) {
        if (SKIP.test(node.value[i])) continue;
        hay += node.value[i];
        at.push({ slot, off: i });
      }
      return;
    }
    if (node.type !== 'element') return;
    if (node.tagName === 'style' || node.tagName === 'script') return;
    if (hasClass(node, 'katex')) {
      const tex = compactForMatch(findTex(node) ?? textOf(node));
      const slot = slots.push({ kind: 'atom', node, parent }) - 1;
      hay += tex;
      for (let i = 0; i < tex.length; i++) at.push({ slot, off: -1 });
      return;
    }
    for (const c of node.children) visit(c, node);
  };
  for (const c of tree.children) visit(c as ElementContent, tree);

  const spans: { start: number; end: number; spec: MarkSpec }[] = [];
  for (const spec of specs) {
    const needle = compactForMatch(spec.text);
    if (!needle) continue;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
      spans.push({ start: i, end: i + needle.length, spec });
    }
  }
  spans.sort((a, b) => a.spec.prio - b.spec.prio || a.start - b.start);
  const kept: typeof spans = [];
  for (const s of spans) {
    if (kept.some((k) => s.start < k.end && k.start < s.end)) continue;
    kept.push(s);
  }
  if (kept.length === 0) return;

  // Fragments per slot. A fragment knows whether it opens or closes its
  // passage, so only the passage's two ends get rounded.
  type Piece = { from: number; to: number; spec: MarkSpec; edge: string };
  const pieces = new Map<number, Piece[]>();
  for (const s of kept) {
    const runs: { slot: number; from: number; to: number }[] = [];
    for (let i = s.start; i < s.end; i++) {
      const { slot, off } = at[i];
      const last = runs[runs.length - 1];
      if (last && last.slot === slot) last.to = off + 1;
      else runs.push({ slot, from: off, to: off + 1 });
    }
    runs.forEach((r, i) => {
      const edge = [i === 0 ? 'start' : '', i === runs.length - 1 ? 'end' : ''].filter(Boolean).join(' ') || 'mid';
      const list = pieces.get(r.slot) ?? [];
      // a formula belongs to the first passage that reaches it
      if (slots[r.slot].kind === 'atom' && list.length > 0) return;
      list.push({ from: r.from, to: r.to, spec: s.spec, edge });
      pieces.set(r.slot, list);
    });
  }

  const mark = (spec: MarkSpec, edge: string, children: ElementContent[]): Element => ({
    type: 'element',
    tagName: 'mark',
    properties: { ...spec.properties, dataMarkEdge: edge },
    children,
  });

  for (const [index, list] of pieces) {
    const slot = slots[index];
    const siblings = slot.parent.children as ElementContent[];
    const pos = siblings.indexOf(slot.node);
    if (pos === -1) continue;
    if (slot.kind === 'atom') {
      siblings.splice(pos, 1, mark(list[0].spec, list[0].edge, [slot.node]));
      continue;
    }
    const value = slot.node.value;
    const out: ElementContent[] = [];
    let cursor = 0;
    for (const p of list.sort((a, b) => a.from - b.from)) {
      if (p.from > cursor) out.push({ type: 'text', value: value.slice(cursor, p.from) });
      out.push(mark(p.spec, p.edge, [{ type: 'text', value: value.slice(p.from, p.to) }]));
      cursor = p.to;
    }
    if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) });
    siblings.splice(pos, 1, ...out);
  }
}

/** The rehype plugin form: `[rehypeMarks, specs]`. */
export default function rehypeMarks(specs: MarkSpec[]) {
  return (tree: Root) => applyMarks(tree, specs);
}
