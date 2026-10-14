// A run's own turn in its session file. A runtime knows the prompt it wrote,
// so the turn is found by that, exactly — the entry carrying it, after the
// point the file had reached when the run began — never by guessing from
// the question's wording. And a run's end waits for the file to hold the
// whole turn, so a page that reads the file on `run_end` reads all of it.
'use strict';
const fsp = require('node:fs/promises');

/**
 * Watchdog on a runtime that never writes its turn's end to its file (a
 * crash between answering and flushing): how long `run_end` waits for the
 * file before it goes out saying the file did not hold the turn (`held:
 * false`). Not a guess at anything: past it, the page is told so.
 */
const FLUSH_MS = Number(process.env.TD_AGENT_FLUSH_MS) || 15_000;
const POLL_MS = 100;

/** The file's size now (0 when it does not exist yet): where a run's own lines begin. */
async function sizeOf(file) {
  if (!file) return 0;
  return fsp.stat(file).then((s) => s.size, () => 0);
}

/** The JSON lines of a file from a byte offset on (a line cut by the offset, or still being written, is skipped). */
async function linesFrom(file, offset = 0) {
  if (!file) return [];
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, Math.min(offset, size));
    const buf = Buffer.alloc(size - start);
    if (buf.length) await fh.read(buf, 0, buf.length, start);
    const out = [];
    for (const raw of buf.toString('utf8').split('\n')) {
      if (!raw.trim()) continue;
      try { out.push(JSON.parse(raw)); } catch { /* cut or unfinished */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** A message's text: a string, or its text blocks. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/** The prompt as the run wrote it, as the file will show it. */
const samePrompt = (content, prompt) => textOf(content).trim() === String(prompt ?? '').trim();

/** `check()` until it answers, or null once the watchdog fires (or `signal` aborts). */
async function until(check, { within = FLUSH_MS, signal } = {}) {
  const deadline = Date.now() + within;
  for (;;) {
    const got = await check();
    if (got) return got;
    if (signal?.aborted || Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

module.exports = { FLUSH_MS, sizeOf, linesFrom, textOf, samePrompt, until };
