# ascii-sharks (vendored)

Source: https://github.com/stackedlol/ascii-sharks @ `c521e24a787e6d4cc460d4cf2b9815f25e4fe453`
(`src/engine.ts`, `math.ts`, `renderer.ts`, `species.ts`, `world.ts`).

**License: pending.** The upstream repository carries no license file yet;
permission from the author is being requested. Do not publish a release that
ships this directory until that is settled.

Used by `components/OceanBackdrop.tsx` as the canvas background inside the
harness plugin only (`data-palette='harness'`).

## Local changes

- `renderer.ts` — transparent background (no black fill, no cell grid, no
  offscreen background canvas); every colour neutral grey (no accents, no
  species tints, no red bite flash, no cyan wake), so the light theme can
  take the layer through a CSS invert.
- `engine.ts` — options object (`sharks`, `fps`, `canSplash`); render capped
  at `fps`; the loop runs only while the window — or the same-origin host
  window when embedded — has focus and the tab is visible.
- Parameter properties rewritten as fields (`erasableSyntaxOnly`).
