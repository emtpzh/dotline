import { useEffect, useRef } from 'react';
import { OceanEngine } from '../vendor/ascii-sharks/engine';

// The harness plugin's ASCII ocean: fish and sharks drawn behind the cards.
// It sits in screen space (it does not pan or zoom with the board), between
// the dot ground and the pane, and never takes a pointer — the engine only
// listens on the window, so fish still scatter from the cursor and a click
// on empty canvas still splashes.
export default function OceanBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new OceanEngine(canvas, {
      fps: 30,
      canSplash: (e) => e.target instanceof Element && e.target.classList.contains('react-flow__pane'),
    });
    return () => engine.destroy();
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="tdag-ocean pointer-events-none absolute inset-0 z-0 size-full font-mono" />;
}
