import type { Element, ElementContent, Root } from 'hast';

// Inline citations. A web answer cites its sources as [n] — server.mjs asks
// for exactly that, numbered as its search results were — and a model may
// gather several as [1, 2]. In the panel each number becomes an <a
// data-cite="n"> that Markdown's Anchor draws as a pill with its source's
// card. Only a number the answer has a source for; never inside code, a
// link, a formula or a pill already made. Runs after the sanitizer (and
// after rehype-marks: a highlight is matched on the words as written), so
// a pasted <a data-cite> never reaches it as one.

const SKIP = new Set(['a', 'code', 'pre', 'kbd', 'samp', 'script', 'style']);
const CITE = /\[(\d{1,3}(?:\s*[,，]\s*\d{1,3})*)\]/g;

const isFormula = (el: Element): boolean => {
  const cls = el.properties.className;
  return Array.isArray(cls) && cls.some((c) => String(c).startsWith('katex'));
};

export default function rehypeCites({ count }: { count: number }) {
  const split = (text: string): ElementContent[] | null => {
    const out: ElementContent[] = [];
    let last = 0;
    for (const m of text.matchAll(CITE)) {
      const nums = m[1].split(/\s*[,，]\s*/).map(Number);
      if (!nums.every((n) => n >= 1 && n <= count)) continue;
      if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
      for (const n of nums) {
        out.push({ type: 'element', tagName: 'a', properties: { dataCite: String(n) }, children: [{ type: 'text', value: String(n) }] });
      }
      last = m.index + m[0].length;
    }
    if (last === 0) return null;
    if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
    return out;
  };
  const walk = (parent: Root | Element): void => {
    const children = parent.children as ElementContent[];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type === 'element') {
        if (!SKIP.has(child.tagName) && !isFormula(child)) walk(child);
        continue;
      }
      if (child.type !== 'text') continue;
      const parts = split(child.value);
      if (!parts) continue;
      children.splice(i, 1, ...parts);
      i += parts.length - 1;
    }
  };
  return (tree: Root) => { walk(tree); };
}
