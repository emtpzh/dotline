import { create } from 'zustand';

// Appearance: two independent axes, four quadrants.
//   lighting — light / dark / system  → swaps the whole token set (data-theme)
//   paper    — plain / grid           → canvas texture + component dialect (data-paper)
// Tokens live in index.css; this module only flips the two root attributes
// and remembers the choice. The share viewer follows the VIEWER's settings.

export type Lighting = 'light' | 'dark' | 'system';
export type Paper = 'plain' | 'grid';

const LS_LIGHTING = 'thoughtdag.lighting';
const LS_PAPER = 'thoughtdag.paper';

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function resolve(lighting: Lighting): 'light' | 'dark' {
  return lighting === 'system' ? (media?.matches ? 'dark' : 'light') : lighting;
}

// Inside DeepSeek Harness (the plugin builds with VITE_DSH_BRIDGE) the board
// wears the harness's own colors: index.css keeps them as a fixed palette,
// light and dark alike, so the canvas reads as part of the host app.
const PALETTE = import.meta.env.VITE_DSH_BRIDGE ? 'harness' : 'thoughtdag';

function apply(lighting: Lighting, paper: Paper): 'light' | 'dark' {
  const resolved = resolve(lighting);
  // `.dark` is what the tokens and every `dark:` utility key on (shadcn's
  // convention, wired as @custom-variant in index.css). data-theme stays
  // beside it as the readable state for tests and screenshots.
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.paper = paper;
  document.documentElement.dataset.palette = PALETTE;
  return resolved;
}

interface AppearanceState {
  lighting: Lighting;
  paper: Paper;
  /** the theme actually on screen — 'system' collapsed to light/dark.
      Subscribe to this to re-derive anything computed from token values
      (edge palettes resolve through it). */
  resolved: 'light' | 'dark';
  setLighting: (l: Lighting) => void;
  setPaper: (p: Paper) => void;
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  lighting: (localStorage.getItem(LS_LIGHTING) as Lighting) || 'light',
  paper: (localStorage.getItem(LS_PAPER) as Paper) || 'plain',
  resolved: 'light',
  setLighting: (lighting) => {
    localStorage.setItem(LS_LIGHTING, lighting);
    set({ lighting, resolved: apply(lighting, get().paper) });
  },
  setPaper: (paper) => {
    localStorage.setItem(LS_PAPER, paper);
    apply(get().lighting, paper);
    set({ paper });
  },
}));

/** Called once before first render — no flash of the wrong theme. */
export function initAppearance(): void {
  const s = useAppearance.getState();
  useAppearance.setState({ resolved: apply(s.lighting, s.paper) });
  media?.addEventListener('change', () => {
    const st = useAppearance.getState();
    if (st.lighting === 'system') {
      useAppearance.setState({ resolved: apply(st.lighting, st.paper) });
    }
  });
}

/** The edge colors as CURRENTLY rendered (theme-resolved). Wires are drawn
    from their meaning at render time (lib/edge-look); this palette resolves
    that meaning against the active theme and palette. */
export function edgePalette(): { accent: string; warm: string; trace: string; material: string } {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    accent: read('--edge-continue', 'var(--primary)'),
    warm: read('--edge-explore', 'oklch(0.710 0.139 59.4)'),
    trace: read('--edge-trace', 'oklch(0.769 0.165 70.1)'),
    material: read('--muted-foreground', 'oklch(0.556 0 0)'),
  };
}
