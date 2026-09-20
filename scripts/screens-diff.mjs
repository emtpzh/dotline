// Pixel-compares two screenshot sets from scripts/screens.mjs and prints how
// much moved. Usage: `node scripts/screens-diff.mjs before after`
// Decoding happens in Chrome (no image dependency): each pair is drawn onto
// canvases and compared channel by channel.
import { readdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [a, b] = process.argv.slice(2, 4);
if (!a || !b) throw new Error('usage: node scripts/screens-diff.mjs <before> <after>');

// anything under this is noise (antialiasing, a blinking dot); above it the
// shot is worth opening
const THRESHOLD_PCT = 0.1;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();

const names = (await readdir(`.screens/${a}`)).filter((f) => f.endsWith('.png')).sort();
let worst = 0;

for (const name of names) {
  const [left, right] = await Promise.all([
    readFile(`.screens/${a}/${name}`, 'base64'),
    readFile(`.screens/${b}/${name}`, 'base64').catch(() => null),
  ]);
  if (!right) {
    console.log(`missing  ${name} (not in ${b})`);
    continue;
  }
  const pct = await page.evaluate(async ([l, r]) => {
    const load = (data) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = `data:image/png;base64,${data}`;
    });
    const [li, ri] = await Promise.all([load(l), load(r)]);
    if (li.width !== ri.width || li.height !== ri.height) return 100;
    const draw = (img) => {
      const c = new OffscreenCanvas(img.width, img.height);
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      return cx.getImageData(0, 0, img.width, img.height).data;
    };
    const [ld, rd] = [draw(li), draw(ri)];
    let diff = 0;
    for (let i = 0; i < ld.length; i += 4) {
      if (Math.abs(ld[i] - rd[i]) > 8 || Math.abs(ld[i + 1] - rd[i + 1]) > 8
        || Math.abs(ld[i + 2] - rd[i + 2]) > 8) diff++;
    }
    return (diff / (ld.length / 4)) * 100;
  }, [left, right]);
  worst = Math.max(worst, pct);
  const mark = pct <= THRESHOLD_PCT ? 'same' : 'DIFF';
  console.log(`${mark}  ${name}  ${pct.toFixed(3)}% of pixels`);
}

console.log(`worst: ${worst.toFixed(3)}% (threshold ${THRESHOLD_PCT}%)`);
await browser.close();
process.exit(worst <= THRESHOLD_PCT ? 0 : 1);
