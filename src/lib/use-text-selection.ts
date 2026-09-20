import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';

// The reader's current text selection, as something a Popover can anchor to.
// Shared by the node card, the focus panel and the reading viewer, which all
// answer a selection with the same two gestures (see SelectionActions).

interface Selected {
  text: string;
  /** kept live so the bar follows the words while the container scrolls */
  range: Range;
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
      const text = selection?.toString().trim() ?? '';
      if (!selection || !text || !ref.current?.contains(selection.anchorNode)) {
        setSelected(null);
        return;
      }
      setSelected({ text, range: selection.getRangeAt(0).cloneRange() });
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

