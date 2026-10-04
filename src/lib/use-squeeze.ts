import { useLayoutEffect, useRef, useState } from 'react';

// A row of controls that must never overlap: when its content outgrows the
// row, the level steps up (the caller folds its lowest-priority controls
// into a menu per level); when the row grows back past the width the
// previous level needed, it steps down. Each step re-measures, so a level
// that still overflows climbs again on the next frame.
//
// The measure is overflow: the row's own (its fixed parts no longer fit)
// and each direct child's (a shrinkable cluster pressed below what its
// contents allow spills over its neighbour without widening the row).
//
// Returns a callback ref for the row (it may mount after the caller does)
// and the current level.
export function useSqueeze(maxLevel: number): [(el: HTMLElement | null) => void, number] {
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [level, setLevel] = useState(0);
  const checkRef = useRef<(() => void) | null>(null);
  // needed[l] = the row width level l took, recorded when it overflowed
  // (kept across a remount of the row: same controls, same widths)
  const neededRef = useRef<number[]>([]);

  useLayoutEffect(() => {
    if (!row) return;
    const needed = neededRef.current;
    const check = () => {
      let deficit = row.scrollWidth - row.clientWidth;
      for (const child of Array.from(row.children)) deficit = Math.max(deficit, child.scrollWidth - child.clientWidth);
      const over = deficit > 1;
      setLevel((l) => {
        if (over && l < maxLevel) { needed[l] = row.clientWidth + deficit; return l + 1; }
        if (!over && l > 0 && row.clientWidth >= (needed[l - 1] ?? Infinity)) return l - 1;
        return l;
      });
    };
    // the row resizes with the window and the panel; its direct children
    // resize when a control appears, a label changes, or a level folds
    const ro = new ResizeObserver(check);
    ro.observe(row);
    for (const child of Array.from(row.children)) ro.observe(child);
    checkRef.current = check;
    check();
    return () => { ro.disconnect(); checkRef.current = null; };
  }, [row, maxLevel]);

  // a fold that changes no size (its control was not shown anyway) fires no
  // resize, so every level change measures once more on its own
  useLayoutEffect(() => { checkRef.current?.(); }, [level]);

  return [setRow, level];
}
