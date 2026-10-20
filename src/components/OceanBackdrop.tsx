import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useOnViewportChange, useStore as useFlowStore, type ReactFlowState } from '@xyflow/react';
import { OceanEngine } from '../vendor/ascii-sharks/engine';
import { useUiStore } from '../lib/ui-store';

// The harness plugin's ASCII ocean: fish and sharks drawn behind the cards.
// It sits in screen space (it does not pan or zoom with the board), between
// the dot ground and the pane, and never takes a pointer — the engine only
// listens on the window, so fish still scatter from the cursor and a click
// on empty canvas still splashes.
//
// It stays out of the way: it nearly vanishes while the board is being
// worked (panning, zooming, dragging, marquee, typing), dims and stops while
// someone reads (detail panel, reader), fades as cards cover the screen,
// and stops after a minute without input. Must live inside <ReactFlow>.

const IDLE_MS = 60_000;
/** how long the board stays quiet after the last interaction before the ocean returns */
const SETTLE_MS = 700;
/** a viewport that has not changed for this long has stopped moving */
const MOVE_QUIET_MS = 250;
/** a keystroke in a field counts as working the board for this long */
const TYPING_MS = 1200;

const LEVEL_BUSY = 0.25;
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

const nodeDragging = (s: ReactFlowState) => s.nodes.some((n) => n.dragging);
const marquee = (s: ReactFlowState) => s.userSelectionActive;

/** Fades in on mount, and out before it unmounts when switched off. */
export default function OceanBackdrop({ enabled }: { enabled: boolean }) {
  const [parked, setParked] = useState(!enabled);
  if (!enabled && parked) return null;
  return <OceanCanvas enabled={enabled} onSettled={() => setParked(!enabled)} />;
}

function OceanCanvas({ enabled, onSettled }: { enabled: boolean; onSettled: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<OceanEngine | null>(null);
  const [shown, setShown] = useState(false);
  const [moving, setMoving] = useState(false);
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const dragging = useFlowStore(nodeDragging);
  const selecting = useFlowStore(marquee);
  const covered = useFlowStore(coverage);
  const reading = useUiStore((s) => s.panelOpen || !!s.readerNodeId);

  // Not onEnd alone: a pan-on-scroll of a single wheel event (one notch of
  // a mouse wheel) gets a start and never an end, so a quiet spell ends it.
  const moveTimer = useRef(0);
  const onMove = useCallback(() => {
    setMoving(true);
    clearTimeout(moveTimer.current);
    moveTimer.current = window.setTimeout(() => setMoving(false), MOVE_QUIET_MS);
  }, []);
  const onMoveEnd = useCallback(() => {
    clearTimeout(moveTimer.current);
    setMoving(false);
  }, []);
  useOnViewportChange({ onStart: onMove, onChange: onMove, onEnd: onMoveEnd });
  useEffect(() => () => clearTimeout(moveTimer.current), []);

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

  // typing in any field of the app works the board too — on `input`, not
  // keydown, so IME composition and paste count as well
  useEffect(() => {
    let timer = 0;
    const onInput = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (!el || !(el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      setTyping(true);
      clearTimeout(timer);
      timer = window.setTimeout(() => setTyping(false), TYPING_MS);
    };
    document.addEventListener('input', onInput, true);
    return () => {
      document.removeEventListener('input', onInput, true);
      clearTimeout(timer);
    };
  }, []);

  // dim at once when work starts; come back only once it has settled
  const working = moving || dragging || selecting || typing;
  useEffect(() => {
    const timer = window.setTimeout(() => setBusy(working), working ? 0 : SETTLE_MS);
    return () => clearTimeout(timer);
  }, [working]);

  const level = !enabled || !shown ? 0
    : busy ? LEVEL_BUSY
    : reading ? LEVEL_READING
    // an empty board shows the ocean off; a full one keeps it to the gaps
    : 1.3 - 0.7 * Math.min(1, covered / 0.4);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-busy={busy || undefined}
      style={{ '--ocean-level': level } as CSSProperties}
      onTransitionEnd={onSettled}
      className="tdag-ocean pointer-events-none absolute inset-0 z-0 size-full font-mono"
    />
  );
}
