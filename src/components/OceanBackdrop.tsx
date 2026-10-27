import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore as useFlowStore, type ReactFlowState } from '@xyflow/react';
import { OceanEngine } from '../vendor/ascii-sharks/engine';
import { useUiStore } from '../lib/ui-store';

// The harness plugin's ASCII ocean: fish and sharks drawn behind the cards.
// It sits in screen space (it does not pan or zoom with the board), between
// the dot ground and the pane, and never takes a pointer — the engine only
// listens on the window, so fish still scatter from the cursor and a click
// on empty canvas still splashes.
//
// It stays out of the way: it dims and stops while someone reads (detail
// panel, reader), fades as cards cover the screen, and stops after a minute
// without input. It deliberately does not duck while the board is worked
// (panning, typing, ...): a backdrop that flickers with every gesture pulls
// the eye more than a steady one. On the landing it keeps to the sides,
// clear of the column of text. Must live inside <ReactFlow>.

const IDLE_MS = 60_000;

const LEVEL_READING = 0.5;

/** Share of the viewport covered by cards, in tenths (frames are see-through). */
function coverage(s: ReactFlowState): number {
  const { width: W, height: H } = s;
  if (!W || !H) return 0;
  const [tx, ty, k] = s.transform;
  let area = 0;
  for (const n of s.nodeLookup.values()) {
    if (n.hidden || (n.data as { stepKind?: string }).stepKind === 'frame') continue;
    const x = n.internals.positionAbsolute.x * k + tx;
    const y = n.internals.positionAbsolute.y * k + ty;
    const w = (n.measured.width ?? 0) * k;
    const h = (n.measured.height ?? 0) * k;
    area += Math.max(0, Math.min(x + w, W) - Math.max(x, 0)) * Math.max(0, Math.min(y + h, H) - Math.max(y, 0));
  }
  return Math.round(Math.min(1, area / (W * H)) * 10) / 10;
}

/** Fades in on mount, and out before it unmounts when switched off. */
export default function OceanBackdrop({ enabled, landing }: { enabled: boolean; landing?: boolean }) {
  const [parked, setParked] = useState(!enabled);
  if (!enabled && parked) return null;
  return <OceanCanvas enabled={enabled} landing={landing} onSettled={() => setParked(!enabled)} />;
}

function OceanCanvas({ enabled, landing, onSettled }: { enabled: boolean; landing?: boolean; onSettled: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<OceanEngine | null>(null);
  const [shown, setShown] = useState(false);
  const covered = useFlowStore(coverage);
  const reading = useUiStore((s) => s.panelOpen || !!s.readerNodeId);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new OceanEngine(canvas, {
      fps: 30,
      idleMs: IDLE_MS,
      canSplash: (e) => e.target instanceof Element && e.target.classList.contains('react-flow__pane'),
    });
    engineRef.current = engine;
    // one frame at opacity 0 first, so the fade-in has somewhere to start
    const raf = requestAnimationFrame(() => setShown(true));
    return () => {
      cancelAnimationFrame(raf);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setHeld(reading || !enabled);
  }, [reading, enabled]);

  const level = !enabled || !shown ? 0
    : reading ? LEVEL_READING
    // an empty board shows the ocean off; a full one keeps it to the gaps
    : 1.3 - 0.7 * Math.min(1, covered / 0.4);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-landing={landing || undefined}
      style={{ '--ocean-level': level } as CSSProperties}
      onTransitionEnd={onSettled}
      className="tdag-ocean pointer-events-none absolute inset-0 z-0 size-full font-mono"
    />
  );
}
