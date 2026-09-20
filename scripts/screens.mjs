// Visual baseline — shoots the same list of screens before and after a UI
// change so a PR can show what moved. Prereq: `npm run dev` on :5173.
// Usage: `node scripts/screens.mjs before` → .screens/before/*.png
//        `node scripts/screens.mjs after`  → .screens/after/*.png
// No LLM call: the empty landing and the first-run example graph are the
// two states, and selection is driven through window.__store.
import { chromium } from 'playwright-core';
import { mkdir, rm } from 'node:fs/promises';

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.APP_URL ?? 'http://localhost:5173';
const LABEL = process.argv[2] ?? 'shots';
const OUT = `.screens/${LABEL}`;

// light and dark are the app's own themes; harness is the palette the
// DeepSeek Harness plugin build pins (lib/appearance.ts).
const THEMES = [
  { name: 'light', theme: 'light', palette: 'thoughtdag' },
  { name: 'dark', theme: 'dark', palette: 'thoughtdag' },
  { name: 'harness', theme: 'light', palette: 'harness' },
];

// The landing's own button seeds the example graph — same path a first-time
// visitor takes, so the shot is of real content, not a fixture.
const loadExample = async (page) => {
  await page.getByText('Load example canvas').click();
  await page.waitForFunction(() => window.__store.getState().nodes.length > 0);
};

const SCREENS = [
  { name: 'landing' },
  { name: 'canvas', run: loadExample },
  {
    name: 'canvas-node-selected',
    async run(page) {
      await loadExample(page);
      await page.evaluate(() => {
        const s = window.__store.getState();
        const first = s.nodes.find((n) => !n.parentId) ?? s.nodes[0];
        if (first) s.setSelectedNodeId(first.id);
      });
    },
  },
];

// The canvas keeps moving for a while after it loads (fit-view easing, late
// measurements), so shoot until two shots in a row match, then keep the last.
async function settle(page, file) {
  let previous = null;
  for (let i = 0; i < 8; i++) {
    const shot = await page.screenshot({ path: file });
    if (previous && shot.equals(previous)) return;
    previous = shot;
    await page.waitForTimeout(400);
  }
  console.warn(`  (never settled: ${file})`);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

for (const screen of SCREENS) {
  for (const t of THEMES) {
    const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(
      ([theme]) => {
        // skip the first-run tour and the seeding hook: every shot starts
        // from the same empty canvas
        localStorage.setItem('thoughtdag.seeded', 'yes');
        localStorage.setItem('thoughtdag.tutorialDone', 'yes');
        localStorage.setItem('thoughtdag.lighting', theme);
      },
      [t.theme],
    );
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__store?.persist?.hasHydrated?.());
    // the palette is a build-time constant, so set it on the element too
    await page.evaluate(({ theme, palette }) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.palette = palette;
    }, t);
    await screen.run?.(page);
    await page.waitForTimeout(800);
    // freeze everything that would otherwise make two shots of the same
    // build differ: running animations, transitions, the text caret
    await page.addStyleTag({
      content: `*, *::before, *::after { animation: none !important;
        transition: none !important; caret-color: transparent !important; }`,
    });
    // Web fonts are loaded lazily per weight, so a shot can land while text
    // is still in the fallback face (wider, and it reflows). Pull them all in
    // first — `document.fonts.ready` alone does not do it.
    await page.evaluate(async () => {
      await Promise.all([...document.fonts].map((f) => f.load().catch(() => {})));
      await document.fonts.ready;
    });
    const file = `${OUT}/${screen.name}--${t.name}.png`;
    await settle(page, file);
    console.log(file);
    await ctx.close();
  }
}

await browser.close();
