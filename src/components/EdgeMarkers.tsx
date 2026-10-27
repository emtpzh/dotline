import type { EdgePalette } from '../lib/edge-look';
import { ARROW_IDS } from '../lib/edge-look';

// The canvas's one arrowhead, in each wire color. React Flow's built-in
// `arrowclosed` is a short, wide, blunt triangle; this one is slender with a
// notched back and softened corners. Drawn in stroke-width units, so it
// scales with the line — including the far-zoom and focus thickening that
// canvas.css applies to the stroke — and always keeps the same proportions.
// The tip reaches ARROW_REACH stroke widths past the path's end, so the
// butt end of the line sits inside the head, never beside the tip.
export default function EdgeMarkers({ palette }: { palette: EdgePalette & { trace: string } }) {
  const colors = { continue: palette.accent, fork: palette.warm, material: palette.material, trace: palette.trace } as const;
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute size-0 overflow-hidden">
      <defs>
        {(Object.keys(ARROW_IDS) as (keyof typeof ARROW_IDS)[]).map((k) => (
          <marker
            key={k}
            id={ARROW_IDS[k]}
            viewBox="-8.5 -4 9.5 8"
            markerWidth={9.5}
            markerHeight={8}
            markerUnits="strokeWidth"
            orient="auto-start-reverse"
            refX={-1.2}
            refY={0}
          >
            <path d="M0,0 L-7.5,-3.2 L-5.5,0 L-7.5,3.2 Z" fill={colors[k]} stroke={colors[k]} strokeWidth={0.5} strokeLinejoin="round" />
          </marker>
        ))}
      </defs>
    </svg>
  );
}
