import { useEffect, useState } from 'react';
import { MOTION, ms } from './motion';

/**
 * Keeps something mounted for its exit: `open` turning false starts a
 * `leaving` phase of `exitMs` (the element plays its way out), and only
 * then does `mounted` go false. Opening again mid-exit just stays.
 */
export function usePresence(open: boolean, exitMs: number = MOTION.exit): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  // adjust during render: an open always mounts at once
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), ms(exitMs));
    return () => clearTimeout(timer);
  }, [open, mounted, exitMs]);
  return { mounted: open || mounted, leaving: !open && mounted };
}
