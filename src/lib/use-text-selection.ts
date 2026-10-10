import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';

// The reader's current text selection, as something a Popover can anchor to.
// Shared by the node card, the focus panel and the reading viewer, which all
// answer a selection with the same two gestures (see SelectionActions).

interface Selected {
  text: string;
  /** kept live so the bar follows the words while the container scrolls */
  range: Range;
}

const BLOCKS = new Set(['P', 'LI', 'DIV', 'PRE', 'TR', 'TABLE', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR']);

/** What a selection says, read the way the matcher reads the page (see
    lib/rehype-marks.ts). `Selection.toString()` turns a formula into its
    glyph soup ("E=mc 2") — a formula is taken whole, as `$tex$`, from
    KaTeX's annotation — and blocks keep a line break between them, so a
    passage crossing list items still has a gap where the source has one. */
export function selectionText(range: Range): { text: string; range: Range } {
  const r = range.cloneRange();
  const formulaAt = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest('.katex');
  const first = formulaAt(r.startContainer);
  if (first) r.setStartBefore(first);
  const last = formulaAt(r.endContainer);
  if (last) r.setEndAfter(last);

  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { out += n.nodeValue ?? ''; return; }
    if (n instanceof Element) {
      if (n.tagName === 'BUTTON') return; // a code block's copy button
      if (n.classList.contains('katex')) {
        const tex = n.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
        out += tex ? `$${tex.trim()}$` : (n.querySelector('.katex-html')?.textContent ?? '');
        return;
      }
      if (n.tagName === 'BR') { out += '\n'; return; }
    }
    n.childNodes.forEach(walk);
    if (n instanceof Element) {
      if (n.tagName === 'TD' || n.tagName === 'TH') out += ' ';
      else if (BLOCKS.has(n.tagName)) out += '\n';
    }
  };
  walk(r.cloneContents());
  return { text: out.replace(/[ \t]+/g, ' ').replace(/ *\n[\s]*/g, '\n').trim(), range: r };
}

/** The reader's current selection inside `ref` — text plus an anchor rect. */
export function useTextSelection(ref: RefObject<HTMLElement | null>, enabled = true) {
  const [selected, setSelected] = useState<Selected | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const read = (e: MouseEvent) => {
      // a click into a field or onto a button is not a reading gesture —
      // leave whatever is selected (the bar's own buttons land here)
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim() || !ref.current?.contains(selection.anchorNode)) {
        setSelected(null);
        return;
      }
      const picked = selectionText(selection.getRangeAt(0));
      setSelected(picked.text ? picked : null);
    };
    document.addEventListener('mouseup', read);
    return () => document.removeEventListener('mouseup', read);
  }, [ref, enabled]);

  const clear = useCallback(() => {
    setSelected(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const anchor = useMemo(
    () => (selected ? { getBoundingClientRect: () => selected.range.getBoundingClientRect() } : null),
    [selected],
  );

  /** Forget the selection without touching the document's — for when the
      text under it is replaced wholesale (the viewer swapping nodes). */
  const reset = useCallback(() => setSelected(null), []);

  return { text: selected?.text ?? '', anchor, clear, reset };
}

