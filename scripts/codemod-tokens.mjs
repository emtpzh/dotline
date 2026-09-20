// One-shot rename of the old design tokens to shadcn's names. Kept in the
// repo for the length of the migration: a branch cut before the cutover can
// be rebased and then run through this, which is cheaper than resolving the
// rename by hand. Usage: `node scripts/codemod-tokens.mjs [--dry]`
//
// Everything is replaced in ONE scan, because the two vocabularies overlap:
// the old `accent` was the brand color (now `primary`) while shadcn's own
// `accent` is the hover wash the old `wash` became. Rescanning would walk
// wash → accent → primary. For the same reason the script stops if the tree
// no longer holds any unambiguous old token — it has already run here.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry');

const UTILITIES = 'bg|text|border|ring|divide|fill|stroke|outline|from|to|via|shadow|caret|decoration|placeholder';
// a Tailwind prefix chain: hover:, group-hover:, focus-visible:, dark:, md:…
const PREFIX = '((?:[a-z0-9-]+(?:-\\[[^\\]]+\\])?:)*)';
// /50 or /[0.05]
const ALPHA = '(\\/(?:\\[[^\\]]+\\]|\\d+))?';

// old token → new token. `wash` and `accent` are context-sensitive, so they
// resolve in the replacer below.
const TOKENS = {
  'ink-faint': 'muted-foreground',
  'ink-muted': 'muted-foreground',
  ink: 'foreground',
  'line-strong': 'input',
  line: 'border',
  surface: 'background',
  wash: null,
  'accent-strong': 'primary',
  accent: null,
  warm: 'edge-explore',
  trace: 'edge-trace',
  watch: 'edge-watch',
};

// Raw Tailwind palette → status tokens. The shade carries the intent: the
// light end was a tint (a 50 background), the middle is the color itself.
const STATUS = { red: 'destructive', rose: 'destructive', amber: 'warning', yellow: 'warning', orange: 'warning', green: 'success', emerald: 'success', violet: 'primary', blue: 'primary' };
const TINT = { 50: '/10', 100: '/15', 200: '/30', 300: '/40' };

// a state prefix means the class is the hover/focus/active form, which
// shadcn writes as a dimmed version of the resting color
const isState = (prefix) => /(^|:)(hover|group-hover|focus|focus-within|focus-visible|active|aria-|data-)/.test(prefix);

const OLD = Object.keys(TOKENS).sort((a, b) => b.length - a.length).join('|');
const FAMILIES = Object.keys(STATUS).join('|');
const SCAN = new RegExp(`\\b${PREFIX}(${UTILITIES})-(?:(${OLD})|(${FAMILIES})-(\\d{2,3}))${ALPHA}\\b`, 'g');

function renameClasses(text) {
  return text.replace(SCAN, (match, prefix, utility, oldToken, family, shade, alpha) => {
    if (oldToken) {
      let token = TOKENS[oldToken];
      let suffix = alpha ?? '';
      // a resting wash is `muted`; the same fill on hover is `accent`
      if (oldToken === 'wash') token = isState(prefix) ? 'accent' : 'muted';
      // the brand color, except as a focus ring — that is `ring` itself
      if (oldToken === 'accent') token = utility === 'ring' && isState(prefix) ? 'ring' : 'primary';
      // the old hover accent was a second, darker swatch; shadcn dims instead
      if (oldToken === 'accent-strong' && !alpha) suffix = '/90';
      return `${prefix}${utility}-${token}${suffix}`;
    }
    const token = STATUS[family];
    // A fill in the 50–300 range was a tint of the color, not the color. Its
    // own alpha (bg-amber-50/90) modulated an already-pale swatch, so the
    // tint replaces it rather than stacking with it.
    const tint = utility === 'bg' || utility === 'border' ? TINT[shade] : undefined;
    // hover:bg-red-600 next to bg-red-500 was the darker twin — shadcn dims
    const dimmed = isState(prefix) && !tint && Number(shade) >= 500 ? '/90' : '';
    return `${prefix}${utility}-${token}${tint ?? alpha ?? dimmed}`;
  });
}

// CSS custom properties: --color-ink → --foreground, and the rgb triplet the
// old glows used (oklch cannot be spelled as an rgb() triplet).
const CSS_VARS = [
  ['--color-ink-faint', '--muted-foreground'],
  ['--color-ink-muted', '--muted-foreground'],
  ['--color-ink', '--foreground'],
  ['--color-line-strong', '--input'],
  ['--color-line', '--border'],
  ['--color-surface', '--background'],
  ['--color-card', '--card'],
  ['--color-wash', '--muted'],
  ['--color-accent-strong', '--primary'],
  ['--color-accent', '--primary'],
  ['--color-warm', '--edge-explore'],
  ['--color-trace', '--edge-trace'],
  ['--color-watch', '--edge-watch'],
];

function renameVars(text) {
  let out = text;
  // rgba(var(--accent-rgb), 0.45) → color-mix(in oklch, var(--primary) 45%, transparent)
  out = out.replace(/rgba\(var\(--accent-rgb\)\s*,\s*([0-9.]+)\)/g,
    (_m, a) => `color-mix(in oklch, var(--primary) ${+(Number(a) * 100).toFixed(1)}%, transparent)`);
  for (const [oldVar, newVar] of CSS_VARS) {
    // var(--color-line, #e6e4ee) — the fallback goes with it
    out = out.replace(new RegExp(`var\\(${oldVar}(,\\s*[^)]+)?\\)`, 'g'), `var(${newVar})`);
  }
  return out;
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx|css)$/.test(entry.name)) yield path;
  }
}

const files = [];
for await (const path of walk('src')) {
  // the token file defines the new names; the shadcn components are born new
  if (path === join('src', 'index.css')) continue;
  if (path.startsWith(join('src', 'components', 'ui'))) continue;
  files.push([path, await readFile(path, 'utf8')]);
}

const OLD_UNAMBIGUOUS = new RegExp(`\\b(?:${UTILITIES})-(?:ink|ink-muted|ink-faint|wash|line|line-strong|surface|warm)\\b|--color-(?:ink|wash|line|surface|warm)`);
if (!files.some(([, text]) => OLD_UNAMBIGUOUS.test(text))) {
  console.log('no old tokens left — nothing to do');
  process.exit(0);
}

let changed = 0;
for (const [path, before] of files) {
  // FRAME_COLORS in constants.ts are identity colors, not status: a frame's
  // amber means "this chapter", not "warning". They keep the raw palette.
  const skipStatus = path === join('src', 'lib', 'constants.ts');
  const after = renameVars(skipStatus ? before.replace(SCAN, (m, p, u, o, f, s, a) =>
    (o ? renameClasses(m) : m)) : renameClasses(before));
  if (after === before) continue;
  changed++;
  console.log(DRY ? `would change ${path}` : `changed ${path}`);
  if (!DRY) await writeFile(path, after);
}
console.log(`${changed} file(s)`);
