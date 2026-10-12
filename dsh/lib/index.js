// dsh-dotline host half — a plain Cordis plugin that mounts the
// Dotline SPA under a prefix on the EXISTING DSH web server (no second
// process, no second port) and bridges DSH sessions to the canvas.
//
// Layout of this file, mirroring dsh-synapse:
//   - the static Dotline build lives in ../dist-app (a Vite build with
//     base = the mount prefix, so every asset reference is already
//     /<prefix>/... and resolves through the routes registered below)
//   - /<prefix>/            the SPA shell (index.html)
//   - /<prefix>/<asset...>  static assets (prefix route, path-traversal safe)
//   - /<prefix>/api/...     the session bridge (Host-header fenced)
//
// The bridge's read direction feeds the Dotline dsh-session adapter:
// the adapter parses the same event JSONL a real ~/.dsh session log holds,
// so the bridge serves a session's durable events as that text.
//
// The write direction is how an edited canvas becomes the model's next
// context — through DSH's own primitives, never by touching a log:
//   POST /sessions/<id>/fork      { afterTurn | atSeq }  → a child session that
//                                 inherits the prefix up to that turn boundary
//                                 (sessionController.fork: the UI sees it too)
//   POST /sessions/<id>/inject    { text | blocks }      → model-facing context
//                                 for the next step (agent.inject: no wake,
//                                 shown in the transcript as injected context)
//   POST /sessions/<id>/followup  { text | blocks, mode } → a user prompt that
//                                 wakes the agent (sessionController.prompt)
//   GET  /sessions/<id>/turns     turn boundaries with their seqs, so the
//                                 canvas can name a fork point by turn
//
// The other agents on this machine: the host is a local Node process, so it
// can read what the desktop shell reads — Claude Code's ~/.claude/projects
// and Codex's ~/.codex/sessions — and serve them with the desktop bridge's
// own primitives, so Session Atlas inside the harness sees all three:
//   GET  /roots                          the two file roots (key, path, exists)
//   GET  /roots/<key>/list               every .jsonl under a root (rel, size, mtime)
//   GET  /roots/<key>/head?rel&bytes     the first bytes of one file, as text
//   GET  /roots/<key>/read?rel           one whole file
//   GET  /roots/<key>/range?rel&start&length   a line-aligned byte window
// Everything the model then sees is on the child's log, in DSH's own
// event vocabulary: switching back to the chat shows exactly that.
//
// The model connection: inside the harness Dotline has no proxy of its
// own, so this host also answers the SPA's proxy protocol with the harness's
// providers and credentials (the SPA is built with VITE_API_BASE=/dotline):
//   GET  /models     the harness's model catalog in the SPA's list shape
//                    (vision from each adapter's declared input modalities)
//   POST /stream     one model call, streamed as the SPA's SSE frames; images
//                    enter the attachment store and ride the last user message
//   POST /claude     the same call, whole answer as JSON
//   POST /fetch-url  the SPA's link snapshot, through the harness's bounded fetcher
//
// The why layer inside the harness: the CLI's library (bundled as ./why.mjs at
// build time) answers the same four questions here, over the same
// ~/.thoughtdag index the CLI and the MCP server use — as native harness tools
// the agent calls like any other (why_check, why_file, why_find, why_recall),
// as a /why command a person types in the chat, and as a short system-prompt
// section that says when to ask. Relative paths resolve against the session's
// working directory.
// These are canvas-native calls (summaries, condensing, a canvas that is
// not a mirrored session) — they run on the harness's models but do not
// enter any session log; a mirrored session's turns go through /followup.
//
// The harness's own agent loop is a runtime on the canvas's agent lane
// (/agents, next to Pi, Codex and Claude Code), listed as
// "harness/agent/<provider>/<model>": a question goes INTO the harness —
// continuing a mirrored session, forking one at the end of the parent's
// turn, or a fresh session with the canvas's wired context injected first —
// and the agent's text, reasoning, tool calls and approvals come back as the
// lane's events. The session stays: the Chat lists it, the atlas can open
// it, and the canvas adopts the finished turn from it.

import { randomUUID } from 'node:crypto'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dotline'
export const inject = ['webServer', 'sessions', 'sessionController', 'agents', 'llm', 'attachments', 'web', 'tools', 'commands', 'systemPrompt', 'approval']

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(import.meta.url)
const APP_DIR = resolve(__dirname, '../dist-app')

// The plugin's own version travels into the canvas's URL (?dv=), so the
// update dialog and the release history know which release runs here, as
// they do in the desktop shell. The registry is asked for the newest
// version at most once a day; a failed lookup is silence, not an error.
const PLUGIN_VERSION = (() => { try { return require(resolve(__dirname, '..', 'package.json')).version ?? null } catch { return null } })()
let latestLookup = { value: null, at: 0 }
// dsh-dotline is this plugin's own package; until its first release is on
// the registry the lookup answers 404 and `latest` stays null.
const REGISTRY_LOOKUP = true
async function latestPluginVersion() {
  if (!REGISTRY_LOOKUP) return null
  if (Date.now() - latestLookup.at < 24 * 60 * 60 * 1000) return latestLookup.value
  latestLookup = { value: latestLookup.value, at: Date.now() }
  try {
    const r = await fetch('https://registry.npmjs.org/dsh-dotline/latest', { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
    if (r.ok) { const j = await r.json(); if (typeof j?.version === 'string') latestLookup.value = j.version }
  } catch { /* offline, or the registry is slow: keep what we had */ }
  return latestLookup.value
}
// the shared runtime, copied under lib/runtime by the build (Node code, no
// harness dependency); the harness's own agent loop joins it as the dsh runtime
function createAgentsHost(ctx) {
  const shared = require(resolve(__dirname, 'runtime', 'agents', 'http.cjs'))
  const { createAgentsHttp } = shared
  const log = (line) => console.error(line)
  // lib/runtime is a build copy: one older than this file has no harness runtime
  if (!shared.extraRuntimes) {
    const msg = '[dsh-dotline] lib/runtime predates this plugin build: the harness agent is unavailable until the plugin is rebuilt (npm run build in dsh/)'
    ctx.logger.warn(msg)
    log(msg)
  }
  return createAgentsHttp({ log, extraRuntimes: { dsh: (_log, host) => createDshRuntime(ctx, { log, host }) } })
}

const MAX_BODY_BYTES = 32 * 1024
// a compiled canvas context can be long; the write endpoints take up to this
const MAX_WRITE_BODY_BYTES = 4 * 1024 * 1024
// a model call carries the whole context the canvas compiled
const MAX_CALL_BODY_BYTES = 24 * 1024 * 1024
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.ico': 'image/x-icon',
}

/** Owns an error + an HTTP status; rendered as a JSON body. */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readJson(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > limit) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'request body is not valid JSON') }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendFile(res, contentType, body) {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

/** Static asset path under APP_DIR, or null when it escapes (traversal). */
function assetPath(rel) {
  const normalized = normalize(rel)
  const abs = resolve(APP_DIR, normalized)
  // the platform's separator: resolve() hands back backslashes on Windows,
  // and a check against '/' there rejects every path (issue #23)
  if (abs !== APP_DIR && !abs.startsWith(APP_DIR + sep)) return null
  return abs
}

/** Every event of a live session, inherited prefix included — the Session
 *  class exposes a snapshot read, not a raw array. */
function allEvents(session) {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return session.events ?? []
}

/** A live session's title: the session's own field where it has one; harness
 *  0.2 keeps it only as the log's latest session/title event. */
function titleOfSession(session) {
  if (session.displayTitle !== undefined) return session.displayTitle
  const events = allEvents(session)
  for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === 'session/title') return events[i].data?.title ?? null
  return null
}

/** Session list the bridge exposes: identity + a cheap title, never the log. */
function sessionSummary(session) {
  const header = session.header ?? {}
  return {
    id: session.id,
    title: titleOfSession(session),
    cwd: cwdOfSession(session),
    parentSession: header.parentSession ?? undefined,
    createdAt: header.createdAt ?? null,
    firstLiveSeq: session.firstLiveSeq ?? null,
    // the log's current length: a poller compares it to know the session moved
    seq: typeof session.seq === 'number' ? session.seq : null,
  }
}

/** Serve one session's durable event log as JSONL text (the input dialect of
 *  Dotline's dsh-session adapter). Sequenced events are serialized in log
 *  order; the exact wire shape mirrors the on-disk session.jsonl.zstd rows
 *  (a type/session header line first), so the canvas imports a live DSH
 *  session exactly like a file on disk. */
function sessionToJsonl(session) {
  const lines = []
  const header = session.header ?? {}
  const hdr = { type: 'session', version: 0, id: session.id }
  if (header.createdAt !== undefined) hdr.createdAt = header.createdAt
  const cwd = cwdOfSession(session)
  if (cwd !== null) hdr.cwd = cwd
  // fork lineage, exactly as the on-disk header carries it: who the parent
  // is and how many leading events are inherited (a reader of the log tells
  // the child's own turns from the prefix by seq >= seedLength)
  if (header.parentSession !== undefined) hdr.parentSession = header.parentSession
  // a delegated child says so, as on disk: the canvas hangs it off its parent's turn instead of listing it as a conversation
  if (header.origin !== undefined) hdr.origin = header.origin
  if (typeof session.inheritedEventCount === 'number' && session.inheritedEventCount > 0) hdr.seedLength = session.inheritedEventCount
  lines.push(JSON.stringify(hdr))
  for (const event of allEvents(session)) {
    lines.push(JSON.stringify(event))
  }
  return lines.join('\n')
}

/** The events after `since`, as lines — the tail a reader appends to the
 *  log it already holds, instead of fetching the whole log again. */
function eventsJsonlSince(session, since) {
  const lines = []
  for (const event of allEvents(session)) if (typeof event.seq === 'number' && event.seq > since) lines.push(JSON.stringify(event))
  return lines.join('\n')
}

// ── durable-session bridge (disk) ──────────────────────────────────────
// DSH persists each session as session[.v<n>].jsonl.zstd under
// $DSH_HOME/sessions/<encoded-cwd>/<session-id>/ — the name carries the log
// FORMAT version, which moves on its own (today `session.v3.jsonl.zstd`),
// so the directory is asked what it holds rather than told. The zstd log is a
// CONCATENATION of independently-encoded frames (one per durable batch
// append); Node's one-shot zstdDecompressSync only decodes the FIRST frame,
// so frames are located structurally and decoded one by one (the same
// container walk the DSH persistence backend performs). A final torn frame
// (live tail) is dropped; the next read picks it up whole.

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 LE
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames }
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** Decode a concatenated-frame zstd buffer to UTF-8 text ('' when corrupt). */
function decompressZstdToText(raw) {
  try {
    const { frames } = scanZstdFrames(raw)
    if (frames.length === 0) return ''
    const parts = []
    for (const { start, end } of frames) parts.push(zstdDecompressSync(raw.subarray(start, end)))
    return Buffer.concat(parts).toString('utf8')
  } catch { return '' }
}

/** A session directory's durable log, by name: `session.jsonl.zstd` from the
 *  first format, `session.v<n>.jsonl.zstd` from every one after it. */
const SESSION_LOG = /^session(?:\.v(\d+))?\.jsonl\.zstd$/
const logVersion = (name) => Number(SESSION_LOG.exec(name)?.[1] ?? 0)

/** The log one session directory holds: the highest format version in it —
 *  a directory carrying both is one DSH upgraded, and the new log is the
 *  session. Null when it holds none (a directory made but never written). */
const sessionLogName = (names) => names.filter(n => SESSION_LOG.test(n)).sort((a, b) => logVersion(b) - logVersion(a))[0] ?? null

/** Walk $DSH_HOME/sessions for session logs (2 levels deep). */
async function findSessionFiles(dshHome) {
  const root = join(dshHome, 'sessions')
  const out = []
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return out }
  for (const ws of entries) {
    if (!ws.isDirectory()) continue
    let sessions
    try { sessions = await readdir(join(root, ws.name), { withFileTypes: true }) } catch { continue }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      let names
      try { names = await readdir(join(root, ws.name, s.name)) } catch { continue }
      const name = sessionLogName(names)
      if (name === null) continue // no log yet
      const log = join(root, ws.name, s.name, name)
      try {
        const st = await stat(log)
        out.push({ dir: ws.name, sessionDir: s.name, log, size: st.size, mtime: st.mtimeMs })
      } catch { /* gone between the walk and the stat */ }
    }
  }
  return out
}

/** Cheap title from the FIRST zstd frame only (bounded read): the session
 *  header names the id+cwd; session/title arrives right after in live logs.
 *  Falls back to the session id when the frame boundary cuts early. */
const HEAD_READ_BYTES = 256 * 1024 // covers the first frames: header + title + opening turns
// a session's head is decoded once per (path, size, mtime): the listing is
// polled, and a poll must not decompress sixty files it already knows
const headCache = new Map()
async function cachedHead(f) {
  const key = `${f.log}|${f.size}|${f.mtime}`
  const hit = headCache.get(key)
  if (hit) return hit
  const head = await sessionTitleFromHead(f.log)
  if (headCache.size > 4000) headCache.clear()
  headCache.set(key, head)
  return head
}
async function sessionTitleFromHead(logPath) {
  try {
    const fh = await open(logPath, 'r')
    let buf
    try {
      const st = await fh.stat()
      const want = Math.min(st.size, HEAD_READ_BYTES)
      const b = Buffer.alloc(want)
      const { bytesRead } = await fh.read(b, 0, want, 0)
      buf = b.subarray(0, bytesRead)
    } finally { await fh.close() }
    const text = decompressZstdToText(buf)
    let title = null
    let id = null
    let cwd = null
    for (const raw of text.split('\n')) {
      try {
        const o = JSON.parse(raw)
        if (o.type === 'session') {
          if (typeof o.id === 'string') id = o.id
          if (typeof o.cwd === 'string') cwd = o.cwd
        }
        if (o.type === 'session/title' && typeof o.data?.title === 'string') { title = o.data.title; break }
      } catch { /* partial tail */ }
    }
    return { title, id, cwd }
  } catch { return { title: null, id: null } }
}

// ── write direction helpers ────────────────────────────────────────────

/** The live session for an id, across the store's method spellings. */
const liveSession = (ctx, id) => (typeof ctx.sessions.get === 'function' ? ctx.sessions.get(id) : ctx.sessions.sessionOf?.(id)) ?? undefined

/** Turn boundaries of an event list: where each turn starts and ends (seq),
 *  and the id of the message a person actually sent in it. A fork can only
 *  cut at an endSeq (DSH rejects a boundary inside an open turn). */
function turnsOf(events) {
  const turns = new Map()
  for (const e of events) {
    if (!e || typeof e.type !== 'string') continue
    const n = e.data?.turn
    if (e.type === 'turn/start' && typeof n === 'number') turns.set(n, { turn: n, startSeq: e.seq, endSeq: null, userMessageId: null })
    else if (e.type === 'turn/end' && typeof n === 'number' && turns.has(n)) turns.get(n).endSeq = e.seq
    else if (e.type === 'user/message' && (e.data?.source?.kind ?? 'user') === 'user') {
      const openTurn = [...turns.values()].reverse().find(t => t.endSeq === null)
      if (openTurn && openTurn.userMessageId === null) openTurn.userMessageId = e.data?.id ?? null
    }
  }
  return [...turns.values()]
}

/** Events of a session by id: the live store first, else the durable log. */
async function eventsOfSession(ctx, id) {
  const live = liveSession(ctx, id)
  if (live !== undefined) return allEvents(live)
  const dshHome = process.env.DSH_HOME || join(os.homedir(), '.dsh')
  const files = await findSessionFiles(dshHome)
  const hit = files.find(f => f.sessionDir === id)
  if (!hit) return null
  const raw = await readFile(hit.log).catch(() => null)
  if (!raw) return null
  const events = []
  for (const line of decompressZstdToText(raw).split('\n')) {
    if (!line) continue
    try { events.push(JSON.parse(line)) } catch { /* torn tail */ }
  }
  return events
}

/** Model-facing content from a request body: `blocks` (text blocks only for
 *  now — images arrive through the attachment store in a later step) or a
 *  plain `text`. Empty content is a 400, never a silent no-op. */
function contentOf(body) {
  if (Array.isArray(body?.blocks)) {
    const blocks = body.blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0).map(b => ({ type: 'text', text: b.text }))
    if (blocks.length === 0) throw new HttpError(400, 'blocks: no text block with content')
    if (blocks.length !== body.blocks.length) throw new HttpError(400, 'blocks: only { type: "text", text } is accepted here')
    return blocks
  }
  if (typeof body?.text === 'string' && body.text.length > 0) return [{ type: 'text', text: body.text }]
  throw new HttpError(400, 'body needs text or blocks')
}

/** How a message this plugin puts into a session names its producer. The
 *  session format decides the spelling: v4 (harness 0.2) refuses the
 *  `{ kind: 'plugin', plugin }` wrapper — the turn then ends in an error
 *  before the model is called — and names a third-party producer
 *  `plugin:<name>` in `kind` itself, as its migration of v3 logs does. */
const sourceFor = (session) => (session?.header?.version ?? 0) >= 4
  ? { kind: 'plugin:dsh-dotline' }
  : { kind: 'plugin', plugin: 'dsh-dotline' }

// ── the other agents' session files on this machine ────────────────────

const FILE_ROOTS = {
  'claude-projects': join(os.homedir(), '.claude', 'projects'),
  'codex-sessions': join(os.homedir(), '.codex', 'sessions'),
  'pi-sessions': join(os.homedir(), '.pi', 'agent', 'sessions'),
}
const FILE_READ_MAX = 256 * 1024 * 1024

/** An absolute path inside a root, or a 400/404 — rel never escapes. */
function fileInRoot(rootKey, rel) {
  const root = FILE_ROOTS[rootKey]
  if (!root) throw new HttpError(404, 'no such root')
  if (typeof rel !== 'string' || !rel) throw new HttpError(400, 'rel required')
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) throw new HttpError(400, 'rel escapes its root')
  return abs
}

/** Every session file under a root, two-to-five levels deep like the desktop's walk. */
const listCache = new Map() // rootKey → { at, files }: a walk is reused for a few seconds
const LIST_CACHE_MS = 5000
async function listRoot(rootKey) {
  const root = FILE_ROOTS[rootKey]
  if (!root) throw new HttpError(404, 'no such root')
  const hit = listCache.get(rootKey)
  if (hit && Date.now() - hit.at < LIST_CACHE_MS) return hit.files
  const out = []
  const walk = async (dir, depth) => {
    if (depth > 5) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) await walk(p, depth + 1)
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        try { const st = await stat(p); out.push({ rel: p.slice(root.length + 1), size: st.size, mtime: st.mtimeMs }) } catch { /* raced */ }
      }
    }
  }
  await walk(root, 0)
  listCache.set(rootKey, { at: Date.now(), files: out })
  return out
}

/** The first `bytes` of a file, as text (the desktop bridge's head). */
async function headOfFile(abs, bytes) {
  const n = Math.min(Math.max(1024, bytes | 0), 524288)
  const fh = await open(abs, 'r')
  try { const buf = Buffer.alloc(n); const { bytesRead } = await fh.read(buf, 0, n, 0); return buf.subarray(0, bytesRead).toString('utf8') } finally { await fh.close() }
}

/** A byte window cut on a line boundary (the desktop bridge's read-range). */
async function rangeOfFile(abs, start, length) {
  const fh = await open(abs, 'r')
  try {
    const from = Math.max(0, Number(start) || 0)
    const want = Math.min(Math.max(65536, Number(length) || 0), 32 * 1024 * 1024)
    const total = (await fh.stat()).size
    const size = Math.min(want, Math.max(0, total - from))
    if (size === 0) return { text: '', nextStart: from, eof: true }
    const b = Buffer.alloc(size)
    const { bytesRead } = await fh.read(b, 0, size, from)
    let slice = b.subarray(0, bytesRead)
    const eof = from + size >= total
    if (!eof) {
      const lastNl = slice.lastIndexOf(0x0a)
      if (lastNl >= 0) slice = slice.subarray(0, lastNl + 1)
      else return { text: '', nextStart: from + size, eof: false }
    }
    return { text: slice.toString('utf8'), nextStart: from + slice.length, eof }
  } finally { await fh.close() }
}

// ── model connection helpers ───────────────────────────────────────────

/** The SPA names a harness model as "<provider>/<model>" (the model id itself
 *  may contain slashes, so the split is at the first one). */
function splitModelId(id) {
  if (typeof id !== 'string') return null
  const i = id.indexOf('/')
  if (i <= 0 || i === id.length - 1) return null
  return { provider: id.slice(0, i), model: id.slice(i + 1) }
}

/** The harness's catalog in the SPA's list shape. No model is marked as
 *  seeing images: a model is marked vision when its adapter declares image
 *  input; those images then enter the attachment store and ride the call. */
const AGENT_MODEL = 'harness/agent'
/** The canvas names the harness's agent loop 'harness/agent/<provider>/<model>'
 *  (the agent lane's dsh runtime lists those entries); the bare
 *  'harness/agent' stays accepted (older canvases) and means the session's
 *  current model. */
const isAgentModelId = (id) => typeof id === 'string' && (id === AGENT_MODEL || id.startsWith(AGENT_MODEL + '/'))
function agentTargetOf(id) {
  if (!isAgentModelId(id) || id === AGENT_MODEL) return null
  const rest = id.slice(AGENT_MODEL.length + 1)
  const i = rest.indexOf('/')
  return i > 0 && i < rest.length - 1 ? { provider: rest.slice(0, i), model: rest.slice(i + 1) } : null
}
/** The model a plain call (/stream, /claude) runs on. Agent turns go
 *  through /agents/run; an agent entry reaching a plain call is one of the
 *  canvas's side calls (plaques, titles, condense…) made while that entry is
 *  the chosen model, so it runs on a plain model without opening a session:
 *  the catalog's fast side model (the canvas's sideModelOf picks the same),
 *  else the entry's own provider/model, else the catalog default. */
const SIDE_MODEL = /deepseek.*flash/i
const plainModelOf = (id, models) => {
  if (!isAgentModelId(id)) return id
  const side = models.find(m => SIDE_MODEL.test(m.id.split('/').pop() ?? ''))
  if (side) return side.id
  const t = agentTargetOf(id)
  return t ? `${t.provider}/${t.model}` : null
}
/** Which of a provider's models take images: the adapter's declared input
 *  modalities; a name that says "vision" only when the adapter says nothing. */
async function visionIdsOf(ctx, providerId, catalogModels) {
  const out = new Set()
  try {
    for (const m of await ctx.llm.listModels(providerId)) if ((m.inputModalities ?? []).includes('image')) out.add(m.id)
    if (out.size > 0) return out
  } catch { /* provider not routable right now */ }
  for (const m of catalogModels) if (/vision/i.test(m.id) || /vision/i.test(m.name ?? '')) out.add(m.id)
  return out
}

async function modelsPayload(ctx) {
  const cat = await ctx.sessionController.modelCatalog()
  // the bare models by provider; the agent loop on each of them is the
  // agent lane's dsh runtime, listed through /agents/models
  const models = []
  for (const g of cat.groups ?? []) {
    const vision = await visionIdsOf(ctx, g.id, g.models ?? [])
    for (const m of g.models ?? []) models.push({ id: `${g.id}/${m.id}`, name: m.name ?? m.id, provider: g.name ?? g.id, vision: vision.has(m.id) })
  }
  const def = cat.default ? `${cat.default.provider}/${cat.default.model}` : null
  return {
    models,
    default: def && models.some(m => m.id === def) ? def : (models[0]?.id ?? null),
    capabilities: { webSearch: false, searchEngine: 'none', scholarSearch: false, vision: models.some(m => m.vision) },
    harness: { routableProviders: cat.routableProviders ?? [], failures: (cat.failures ?? []).map(f => ({ provider: f.id, message: f.message })) },
  }
}

const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** The SPA's { role, content } messages as harness Messages; system lines
 *  fold into the call's system prompt. Images (base64) attach to the last
 *  user message as image blocks. */
async function callOf(ctx, body, target) {
  const system = []
  const messages = []
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (!m || typeof m.content !== 'string') continue
    if (m.role === 'system') { system.push(m.content); continue }
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    messages.push({
      id: 'td-' + randomUUID(), role,
      content: [{ type: 'text', text: m.content }],
      source: role === 'assistant' ? { kind: 'model', provider: target.provider, model: target.model } : { kind: 'user' },
    })
  }
  if (messages.length === 0) throw new HttpError(400, 'messages: nothing to send')
  // the canvas sends images only to a model it was told sees them; they
  // enter the attachment store first (the harness's image contract), then
  // ride the last user message as image blocks
  const images = Array.isArray(body?.images) ? body.images.filter(i => i && typeof i.data === 'string' && IMAGE_MEDIA.has(i.mimeType)) : []
  if (images.length > 0) {
    let lastUser = null
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { lastUser = messages[i]; break }
    if (lastUser) {
      for (const img of images) {
        try {
          const ref = await ctx.attachments.saveImage({ data: Buffer.from(img.data, 'base64'), mediaType: img.mimeType, name: 'canvas-image' })
          lastUser.content.push({ type: 'image', attachment: ref })
        } catch (error) {
          throw new HttpError(400, 'image rejected by the harness: ' + (error instanceof Error ? error.message : String(error)))
        }
      }
    }
  }
  return { provider: target.provider, model: target.model, messages, ...(system.length ? { system: system.join('\n\n') } : {}) }
}

/** A short line naming what a tool call is doing, for the canvas's progress row. */
function toolQuery(name, args) {
  let a = args
  if (typeof a === 'string') { try { a = JSON.parse(a) } catch { return a.slice(0, 120) } }
  if (!a || typeof a !== 'object') return ''
  if (/^run_code$/i.test(name) && typeof a.code === 'string') return (a.code.split('\n').find(l => l.trim()) ?? '').trim().slice(0, 120)
  for (const k of ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'description']) if (typeof a[k] === 'string' && a[k]) return a[k].slice(0, 120)
  const first = Object.values(a).find(v => typeof v === 'string' && v)
  return first ? first.slice(0, 120) : ''
}

// ── approvals from the canvas ──────────────────────────────────────────
// A turn launched from the canvas runs behind the harness's own approval
// panel, which the canvas view covers. So the plugin answers first: while a
// canvas turn is running, its session is registered here with a way to put
// the question to the person on the canvas. When nobody is there to ask (no
// page on the events feed, or it left while the question stood), the
// request is handed down the chain (`next()`) to the harness's panel.

/** sessionId → the canvas turn running in it: `ask` (resolves with the
 *  outcome, or null when nobody can answer) and the tool calls seen so far
 *  (callId → name, arguments). */
const canvasTurns = new Map()

function installApprovalAnswerer(ctx) {
  ctx.on('approval/request', async function (req, next) {
    const entry = canvasTurns.get(req?.agent?.id)
    if (!entry?.ask) return next()
    const call = req.callId !== undefined ? entry.calls.get(req.callId) : undefined
    const name = call?.name ?? req.toolName
    const outcome = await entry.ask({ toolName: req.toolName, reason: req.reason ?? null, name, query: call ? toolQuery(name, call.arguments) : '' }, req.signal)
    return outcome ?? next()
  }, true)
}

/**
 * One question through the harness's agent loop: continuing a session,
 * forking one at the end of the turn a user-message id names, or in a
 * fresh session that receives the canvas's context first (also the
 * fallback when the named session or turn cannot be used). Progress goes to
 * `sink` (session, text, reasoning, toolStart, toolEnd); `ask` answers this
 * turn's approvals. Resolves with the session and the final text when the
 * turn ends or `signal` aborts it; rejects with the harness's reason when
 * the turn ends in an error or is blocked. No time limit: an agent may wait
 * on a background job for as long as the job takes, and a turn still
 * running is never reported as over.
 *
 * turn: { question, context, images, model: { provider, model } | null,
 *         preset: string | null, cwd, continueSession, fork: { session, anchor } }
 *
 * `preset` names the agent preset a FRESH session is composed from; a
 * continued or forked session keeps the one it was created with (the
 * harness fixes a session's composition once it has spoken).
 */
async function runHarnessTurn(ctx, turn, sink, { signal, ask } = {}) {
  let sessionId = null
  let forkedFrom = null
  if (turn.continueSession && (liveSession(ctx, turn.continueSession) || (await eventsOfSession(ctx, turn.continueSession)) !== null)) {
    sessionId = turn.continueSession
  } else if (turn.fork?.session && turn.fork.anchor) {
    const events = await eventsOfSession(ctx, turn.fork.session)
    const t = events ? turnsOf(events).find(x => x.userMessageId === turn.fork.anchor) : null
    // DSH cuts only at a completed turn's end
    if (t && t.endSeq !== null) {
      sessionId = (await ctx.sessionController.fork({ sessionId: turn.fork.session, atSeq: t.endSeq })).sessionId
      forkedFrom = turn.fork.session
    }
  }
  const inheritsHistory = sessionId !== null
  let preset = null
  if (!sessionId) {
    const created = await ctx.sessionController.create({ ...(turn.cwd ? { cwd: turn.cwd } : {}), ...(turn.preset ? { agentPreset: turn.preset } : {}) })
    sessionId = created.sessionId
    preset = created.agentPreset ?? null
  }
  const hasImages = turn.images.length > 0
  if (hasImages) {
    const vm = await visionModel(ctx, turn.model).catch(() => null)
    if (vm) await ctx.sessionController.selectModel({ sessionId, provider: vm.provider, model: vm.model }).catch(() => {})
  }
  // the model the canvas picked for this turn, unless images already moved
  // the session to a vision model
  if (turn.model && !hasImages) await ctx.sessionController.selectModel({ sessionId, provider: turn.model.provider, model: turn.model.model }).catch(() => {})
  const agent = await agentOf(ctx, sessionId)
  // A branch starts with the parent's turn and nothing else. Harnesses
  // before the fork cut moved to the turn's own end seed the child up to
  // the NEXT turn/start, which carries the message queued for that turn —
  // the sibling question asked off the same parent earlier. Inherited, it
  // would run first and sit in this branch's history, which is precisely
  // what forking at the parent was for. Whatever the cut left pending goes.
  if (forkedFrom) {
    try { if (agent.inbox?.hasPending) agent.inbox.clear() } catch { /* an inbox this release does not expose */ }
  }
  sink.session({ sessionId, continued: sessionId === turn.continueSession, forkedFrom, preset, cwd: cwdOfSession(liveSession(ctx, sessionId)) ?? turn.cwd ?? null })

  const entry = { ask, calls: new Map() }
  canvasTurns.set(sessionId, entry)
  let sawChunk = false
  let fullText = ''
  // why the turn ended, when the harness says it failed: reported as the
  // run's error, never as a quiet end with nothing said
  let failure = null
  let done
  const finished = new Promise(resolve => { done = resolve })
  const onChunk = (c) => {
    if (c?.type === 'text-delta' && c.text) { sawChunk = true; fullText += c.text; sink.text(c.text) }
    else if (c?.type === 'reasoning-delta' && c.text) sink.reasoning(c.text)
  }
  // the live stream: a session event of its own before harness 0.2, which
  // keeps it off the log and hands it out as the agent's stream frames
  const offStream = ctx.on('agent/assistant-stream', ({ agent: subject, frame } = {}) => {
    if (subject?.id === sessionId) onChunk(frame?.chunk)
  })
  const off = ctx.on('session/event', (session, event) => {
    if (session?.id !== sessionId || !event) return
    if (event.type === 'assistant/chunk') {
      onChunk(event.data?.chunk)
    } else if (event.type === 'assistant/message' && !sawChunk) {
      // chunks did not reach us live (e.g. a compacted row): the whole text at once
      const text = (event.data?.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
      if (text) { fullText += text; sink.text(text) }
    } else if (event.type === 'tool/call' || event.type === 'tool/code-dispatch-start') {
      const callId = event.data?.callId ?? null
      if (callId) entry.calls.set(callId, { name: event.data?.name ?? 'tool', arguments: event.data?.arguments })
      sink.toolStart({ callId, name: event.data?.name ?? 'tool', arguments: event.data?.arguments })
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId ?? null
      if (callId) sink.toolEnd({ callId, name: entry.calls.get(callId)?.name ?? 'tool', isError: !!(event.data?.message?.isError ?? event.data?.isError) })
    } else if (event.type === 'turn/end') {
      const reason = event.data?.reason
      if (reason?.kind === 'error') failure = String(reason.error?.message ?? 'the harness turn failed')
      else if (reason?.kind === 'blocked') failure = 'the harness blocked this turn'
      done('end')
    }
  })
  // marked first: cancelling may end the turn on the spot
  const onAbort = () => { done('aborted'); try { agent.cancel({ kind: 'user' }) } catch { /* best effort */ } }
  try {
    if (signal?.aborted) return { sessionId, text: fullText, how: 'aborted' }
    signal?.addEventListener('abort', onAbort, { once: true })
    // a session that already holds the conversation gets only the question
    if (!inheritsHistory && turn.context) agent.inject({ id: 'td-' + randomUUID(), role: 'user', content: [{ type: 'text', text: turn.context }], source: sourceFor(agent.session) })
    const promptContent = [{ type: 'text', text: turn.question }]
    for (const img of turn.images) promptContent.push({ type: 'image', mediaType: img.mimeType, data: img.data })
    await ctx.sessionController.prompt({ requestId: 'td-' + randomUUID(), sessionId, mode: 'queue', content: promptContent }, AbortSignal.timeout(30000))
    const how = await Promise.race([finished, agent.whenIdle().then(() => finished)])
    if (how === 'end' && failure) throw new Error(failure)
    return { sessionId, text: fullText, how }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (typeof off === 'function') off()
    if (typeof offStream === 'function') offStream()
    if (canvasTurns.get(sessionId) === entry) canvasTurns.delete(sessionId)
  }
}

/** The images of a request the harness can take (base64, a known type). */
const imagesOf = (list) => (Array.isArray(list) ? list : []).filter(i => i && typeof i.data === 'string' && IMAGE_MEDIA.has(i.mimeType))

/** The session id a session path names: `…/<session-id>/session[.v<n>].jsonl.zstd`
 *  — the canvas's own virtual name, or a real log path from disk. */
function sessionIdOfPath(p) {
  const parts = String(p ?? '').split(/[\\/]+/).filter(Boolean)
  return parts.length >= 2 && SESSION_LOG.test(parts[parts.length - 1]) ? parts[parts.length - 2] : null
}

/** Where the canvas reads a harness session as a file: the root its
 *  session bridge serves (src/lib/atlas/dsh-bridge.ts) plus the session's
 *  own path under it. The finished turn is adopted from there. */
const DSH_ROOT_PATH = '~/.dsh/sessions'
const sessionFileOf = (id) => `${DSH_ROOT_PATH}/${id}/session.jsonl.zstd`

/**
 * The harness as an agent runtime on the canvas's agent lane — the same
 * contract as Pi, Codex and Claude Code (runtime/agents): models, a run
 * that opens, continues or forks a session, the eight event kinds, answer,
 * abort. A run is not tied to the page that started it: it keeps going when
 * the page closes, and its approvals then fall to the harness's own panel.
 */
function createDshRuntime(ctx, { log = () => {}, host = { listening: () => false } } = {}) {
  const runs = new Map() // runId → { abort: AbortController, pending: Map<requestId, resolve> }
  return {
    available: async () => 'harness',

    async models() {
      const cat = await ctx.sessionController.modelCatalog()
      const models = []
      for (const g of cat.groups ?? []) {
        const vision = await visionIdsOf(ctx, g.id, g.models ?? [])
        for (const m of g.models ?? []) models.push({ provider: g.id, id: m.id, name: m.name ?? m.id, reasoning: false, vision: vision.has(m.id), efforts: [] })
      }
      const def = cat.default ? `${cat.default.provider}/${cat.default.model}` : null
      return { installed: true, models, default: def && models.some(m => `${m.provider}/${m.id}` === def) ? def : null, presets: await presetRoster(ctx) }
    },

    async run(req, onEvent) {
      const runId = 'dsh-' + randomUUID()
      const emit = (event) => { try { onEvent({ runId, event }) } catch { /* no listener */ } }
      const run = { abort: new AbortController(), pending: new Map() }
      runs.set(runId, run)
      const question = typeof req.question === 'string' && req.question ? req.question : String(req.prompt ?? '')
      const forkAnchor = Array.isArray(req.forkAfterTurn) && typeof req.forkAfterTurn[0] === 'string' ? req.forkAfterTurn[0] : null
      const pathSession = sessionIdOfPath(req.sessionPath)
      const turn = {
        question,
        context: typeof req.context === 'string' ? req.context : '',
        images: imagesOf(req.images),
        model: req.model && req.model.provider && req.model.id ? { provider: String(req.model.provider), model: String(req.model.id) } : null,
        preset: typeof req.preset === 'string' && PRESET_ID.test(req.preset) ? req.preset : null,
        cwd: typeof req.cwd === 'string' && req.cwd ? req.cwd : null,
        continueSession: pathSession && !forkAnchor ? pathSession : null,
        fork: pathSession && forkAnchor ? { session: pathSession, anchor: forkAnchor } : null,
      }
      const ask = async (q, signal) => {
        if (!host.listening()) return null
        const id = 'td-' + randomUUID()
        // waiting before asking: an answer may come back at once
        const decision = new Promise(resolve => { run.pending.set(id, resolve) })
        emit({ type: 'question', kind: 'confirm', id, title: q.name, message: [q.query, q.reason].filter(Boolean).join('\n'), options: [], placeholder: null, prefill: null, paths: [], suggest: null })
        let stopPoll
        const gone = new Promise(resolve => { const t = setInterval(() => { if (!host.listening()) resolve('gone') }, 500); stopPoll = () => clearInterval(t) })
        const aborted = new Promise(resolve => {
          for (const s of [signal, run.abort.signal]) {
            if (!s) continue
            if (s.aborted) resolve('aborted')
            else s.addEventListener('abort', () => resolve('aborted'), { once: true })
          }
        })
        const r = await Promise.race([decision, gone, aborted])
        stopPoll()
        run.pending.delete(id)
        // the page left: the question moves to the harness's panel
        if (r === 'gone') { emit({ type: 'question_answered', id, outcome: 'cancelled', value: null }); return null }
        const outcome = r === 'aborted' ? 'cancelled' : r
        emit({ type: 'question_answered', id, outcome, value: null })
        return outcome
      }
      void (async () => {
        try {
          const r = await runHarnessTurn(ctx, turn, {
            session: (s) => emit({ type: 'session', sessionId: s.sessionId, sessionFile: sessionFileOf(s.sessionId), model: turn.model ? { provider: turn.model.provider, id: turn.model.model, name: turn.model.model } : null, cwd: s.cwd ?? '', continued: s.continued, ...(s.forkedFrom ? { forkedFrom: s.forkedFrom } : {}), ...(s.preset ? { preset: s.preset } : {}) }),
            text: (t) => emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: t } }),
            reasoning: (t) => emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: t } }),
            toolStart: (c) => emit({ type: 'tool_execution_start', toolCallId: c.callId ?? '', toolName: c.name, args: argsObject(c.arguments) }),
            toolEnd: (c) => emit({ type: 'tool_execution_end', toolCallId: c.callId, toolName: c.name, isError: c.isError }),
          }, { signal: run.abort.signal, ask })
          emit({ type: 'run_end', text: r.text, how: r.how })
        } catch (e) {
          log(`[dsh-dotline] agent run failed: ${e instanceof Error ? e.message : String(e)}`)
          emit({ type: 'run_error', message: e instanceof Error ? e.message : String(e) })
        } finally {
          runs.delete(runId)
        }
      })()
      return runId
    },

    abort(runId) {
      const r = runs.get(String(runId))
      if (!r) return false
      r.abort.abort()
      return true
    },

    /** The person's answer to an approval: { confirmed } allows once or
     *  rejects; a withdrawn question rejects. */
    answer(runId, requestId, response) {
      const resolve = runs.get(String(runId))?.pending.get(String(requestId))
      if (!resolve) return false
      resolve(response && typeof response === 'object' && response.confirmed ? 'allowed-once' : 'rejected')
      return true
    },

    shutdown() { for (const r of runs.values()) r.abort.abort() },
  }
}

/** The harness's preset id rule (a preset id is also a directory name). */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** The agent presets a fresh session can be composed from, path-free, the
 *  harness's default marked; a broken one is listed with its reason. Empty
 *  on a harness without presets (before dsh-agent-presets, or a composition
 *  that mounts none): the canvas then offers no choice. */
async function presetRoster(ctx) {
  let presets
  try { presets = ctx.get('agentPresets') } catch { return [] }
  if (typeof presets?.remoteExportList !== 'function') return []
  try {
    const r = await presets.remoteExportList()
    return (r?.presets ?? []).map(p => ({
      id: p.id, name: p.name ?? p.id, isDefault: !!p.isDefault,
      ...(p.description ? { description: p.description } : {}),
      ...(p.broken ? { broken: p.broken } : {}),
    }))
  } catch { return [] }
}

/** Tool arguments as an object, whether the event carried JSON text or one. */
function argsObject(a) {
  if (a && typeof a === 'object') return a
  if (typeof a === 'string') { try { const o = JSON.parse(a); return o && typeof o === 'object' ? o : { input: a } } catch { return { input: a } } }
  return {}
}

/** A model that takes images, by the same test the model list marks them
 *  with: the one the canvas picked when it can, else the catalog's first.
 *  Names say nothing — no model in harness 0.2's catalog is called "vision". */
async function visionModel(ctx, preferred = null) {
  const cat = await ctx.sessionController.modelCatalog()
  const groups = cat.groups ?? []
  const pick = preferred && groups.find(g => g.id === preferred.provider)
  if (pick && (await visionIdsOf(ctx, pick.id, pick.models ?? [])).has(preferred.model)) return preferred
  for (const g of groups) {
    const vision = await visionIdsOf(ctx, g.id, g.models ?? [])
    const m = (g.models ?? []).find(x => vision.has(x.id))
    if (m) return { provider: g.id, model: m.id }
  }
  return null
}

/** Resolve the requested model against the catalog (an agent entry by
 *  plainModelOf), falling back to its default. */
async function targetOf(ctx, requested) {
  const payload = await modelsPayload(ctx)
  requested = plainModelOf(requested, payload.models)
  const id = requested && payload.models.some(m => m.id === requested) ? requested : payload.default
  const t = splitModelId(id)
  if (!t) throw new HttpError(503, 'no model is routable in this harness')
  return t
}

/** One plain model call in the SPA's proxy protocol: /claude answers with
 *  the whole text, /stream with SSE frames ({ text } / { reasoning } /
 *  { error }, then [DONE]). */
async function serveModelCall(ctx, path, req, res, body) {
  const target = await targetOf(ctx, body?.model)
  const options = await callOf(ctx, body, target)
  if (path === '/claude') {
    let text = ''
    for await (const chunk of ctx.llm.stream(options)) if (chunk.type === 'text-delta') text += chunk.text
    return sendJson(res, 200, { text, model: `${target.provider}/${target.model}` })
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  let closed = false
  req.on('close', () => { closed = true })
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      if (closed) break
      if (chunk.type === 'text-delta' && chunk.text) res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`)
      else if (chunk.type === 'reasoning-delta' && chunk.text) res.write(`data: ${JSON.stringify({ reasoning: chunk.text })}\n\n`)
    }
    if (!closed) res.write('data: [DONE]\n\n')
  } catch (error) {
    if (!closed) res.write(`data: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`)
  }
  res.end()
}

/** The live agent for a session, resuming a cold one through the controller. */
async function agentOf(ctx, id) {
  const live = ctx.agents.get(id)
  if (live !== undefined) return live
  const r = await ctx.sessionController.resolveAgent(id)
  if ('agent' in r) return r.agent
  throw new HttpError(404, 'no such session: ' + (r.error?.code ?? r.error?.message ?? 'unknown'))
}

// ── the why layer ──────────────────────────────────────────────────────

/** The working directory a session runs in, as its header records it. */
const cwdOfSession = (session) => session?.header?.cwd ?? session?.header?.meta?.cwd ?? null

/** A path the person or model typed, made absolute against the session's
 *  working directory when it is relative; URLs and arxiv ids pass through. */
function resolveAgainst(cwd, q) {
  const s = String(q ?? '').trim().replace(/^@/, '')
  if (!s || /^(https?:\/\/|arxiv:)/i.test(s) || s.startsWith('/') || !cwd) return s
  return resolve(cwd, s)
}

/** What the why layer managed to register — served at /why/status so a
 *  deployment can see it without reading logs. */
const whyStatus = { loaded: false, tools: [], command: false, prompt: false, error: null }

// the harness's tool names: one family, no collision with its own read/find tools
const TOOL_NAMES = { why_check: 'why_check', why_file: 'why_file', find: 'why_find', recall_turn: 'why_recall' }
const PATH_ARGS = new Set(['path'])

const WHY_PROMPT = `Dotline why layer. The tools why_check, why_file, why_find and why_recall read the local index of past agent conversations (Claude Code, Codex, this harness) — evidence from session logs, not opinion.
- Before editing a file that may have history, call why_check(path); if it has history, why_file(path) lists the turns that changed it: when, what was asked, what changed, and what the answer said about it.
- why_find(phrase) finds where exact words were asked or answered; why_recall(session, turn) reads one turn in full.
Cite what you learn briefly; do not restate whole turns.`

async function installWhyLayer(ctx, config) {
  const wantTools = config?.whyTools !== false
  const wantPrompt = config?.whyPrompt !== false
  if (!wantTools && !wantPrompt) return
  let why
  try {
    why = await import('./why.mjs')
    why.setQuiet?.(true)
  } catch (error) {
    whyStatus.error = error instanceof Error ? error.message : String(error)
    ctx.logger.warn('[dsh-dotline] why layer not loaded: ' + whyStatus.error)
    console.error('[dsh-dotline] why layer not loaded: ' + whyStatus.error)
    return
  }
  whyStatus.loaded = true
  const ask = async (mcpName, args, cwd) => {
    const a = { ...args }
    for (const k of PATH_ARGS) if (typeof a[k] === 'string') a[k] = resolveAgainst(cwd, a[k])
    return why.mcpCall(mcpName, a)
  }
  if (wantTools) {
    // raw definitions: the MCP tool schemas are already JSON Schema, and a
    // bare import of @deepseek-ai/dsh-tools does not resolve from a linked
    // plugin directory — the registry accepts either form
    for (const t of why.MCP_TOOLS) {
      const name = TOOL_NAMES[t.name] ?? t.name
      try {
        ctx.effect(() => ctx.tools.register({
          name,
          description: t.description,
          parameters: t.inputSchema,
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
          async execute(args, exec) { return ask(t.name, args ?? {}, cwdOfSession(exec?.agent?.session)) },
        }), 'dotline: tool ' + name)
        whyStatus.tools.push(name)
      } catch (error) {
        whyStatus.error = `${name}: ${error instanceof Error ? error.message : String(error)}`
        console.error('[dsh-dotline] tool not registered ' + whyStatus.error)
      }
    }
    ctx.effect(() => ctx.commands.register({
      name: 'why',
      description: 'Dotline: which past conversations touched this file, URL or paper',
      input: { hint: '<path | url | arxiv:id>' },
      async handler(inv) {
        const q = String(inv.rawInput ?? '').trim()
        if (!q) return { kind: 'error', text: 'usage: /why <path | url | arxiv:id>' }
        try { return { kind: 'success', text: await ask('why_file', { path: q }, cwdOfSession(inv.agent?.session)) } }
        catch (error) { return { kind: 'error', text: error instanceof Error ? error.message : String(error) } }
      },
    }), 'dotline: /why')
    whyStatus.command = true
  }
  if (wantPrompt && wantTools) { ctx.effect(() => ctx.systemPrompt.section({ name: 'dotline-why', order: 900, text: WHY_PROMPT }), 'dotline: why prompt'); whyStatus.prompt = true }
  ctx.logger.info('[dsh-dotline] why layer: ' + (wantTools ? 'why_check why_file why_find why_recall, /why' : 'no tools') + (wantPrompt && wantTools ? ', prompt section' : ''))
}

/** The agent lane's harness runtime, its approval hook and the plain model
 *  call, for the plugin's own tests. */
export const internals = { createDshRuntime, installApprovalAnswerer, sessionIdOfPath, sessionLogName, findSessionFiles, serveModelCall }

export async function apply(ctx, config) {
  const prefix = typeof config?.mountPrefix === 'string' && config.mountPrefix.startsWith('/') && config.mountPrefix.length > 1
    ? config.mountPrefix.replace(/\/+$/, '')
    : '/dotline'
  const trustedHosts = new Set(['localhost', '127.0.0.1', ...[...(config?.trustedHosts ?? [])].map(h => String(h).trim().toLowerCase()).filter(Boolean)])
  // the agent lane, built on first use; its runs stop when the plugin goes
  let agents = null
  const agentsHttp = () => (agents ??= createAgentsHost(ctx))
  ctx.effect(() => () => { agents?.shutdown(); agents = null }, 'dotline: agent runtimes')
  // the harness's own folder chooser (ctx.directoryPicker, harness 0.1.5+): an
  // OS dialog on the host's display, or listing primitives the canvas browses
  // itself. Not a hard dependency — an older harness has none, and the canvas
  // keeps its typed path.
  let directoryPicker = null
  ctx.inject(['directoryPicker'], (c) => c.effect(() => {
    directoryPicker = c.directoryPicker
    return () => { directoryPicker = null }
  }, 'dotline: directory picker'))
  const pickerOf = () => { try { return directoryPicker?.capability() ?? null } catch { return null } }

  const api = async (req, res) => {
    try {
      const hostname = (typeof req.headers.host === 'string' ? req.headers.host : '').replace(/:\d+$/, '').toLowerCase()
      if (!trustedHosts.has(hostname)) return sendJson(res, 403, { error: 'untrusted Host header' })
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      // full pathname is /<prefix>/api/<rest>; the register prefix strips /api
      const path = url.pathname.slice((prefix + '/api').length)
      // Durable sessions on disk — the archive Dotline's canvas imports.
      if (path === '/disksessions' && req.method === 'GET') {
        const dshHome = process.env.DSH_HOME || join(os.homedir(), '.dsh')
        const files = await findSessionFiles(dshHome)
        const sessions = []
        for (const f of files) {
          const head = await cachedHead(f)
          sessions.push({
            id: head.id ?? f.sessionDir,
            title: head.title,
            cwd: head.cwd,
            workspaceDir: f.dir,
            size: f.size,
            mtime: f.mtime,
          })
        }
        sessions.sort((a, b) => b.mtime - a.mtime)
        return sendJson(res, 200, { sessions })
      }
      const diskOne = /^\/disksessions\/([^/]+?)(\/log)?$/.exec(path)
      if (diskOne !== null && req.method === 'GET') {
        const name = decodeURIComponent(diskOne[1])
        const dshHome = process.env.DSH_HOME || join(os.homedir(), '.dsh')
        const files = await findSessionFiles(dshHome)
        const hit = files.find(f => f.sessionDir === name || f.sessionDir.startsWith(name))
        if (!hit) return sendJson(res, 404, { error: 'no such session on disk' })
        const raw = await readFile(hit.log).catch(() => null)
        if (!raw) return sendJson(res, 500, { error: 'session unreadable' })
        if (diskOne[2] === '/log') return sendFile(res, 'application/x-ndjson; charset=utf-8', decompressZstdToText(raw))
        const head = await sessionTitleFromHead(hit.log)
        return sendJson(res, 200, { session: { id: head.id ?? hit.sessionDir, title: head.title, cwd: head.cwd, size: hit.size, mtime: hit.mtime } })
      }
      // Live sessions (this process's in-memory store).
      if (path === '/sessions' && req.method === 'GET') {
        const list = ctx.sessions.list()
        return sendJson(res, 200, { sessions: list.map(sessionSummary) })
      }
      const one = /^\/sessions\/([^/]+?)(\/log)?$/.exec(path)
      if (one !== null && req.method === 'GET') {
        const id = decodeURIComponent(one[1])
        const session = liveSession(ctx, id)
        if (session === undefined) return sendJson(res, 404, { error: 'no such session' })
        if (one[2] === '/log') {
          const since = url.searchParams.get('since')
          if (since !== null && since !== '') return sendFile(res, 'application/x-ndjson; charset=utf-8', eventsJsonlSince(session, Number(since)))
          return sendFile(res, 'application/x-ndjson; charset=utf-8', sessionToJsonl(session))
        }
        return sendJson(res, 200, { session: sessionSummary(session) })
      }
      if (path === '/why/status' && req.method === 'GET') return sendJson(res, 200, whyStatus)
      if (path === '/version' && req.method === 'GET') return sendJson(res, 200, { version: PLUGIN_VERSION, latest: await latestPluginVersion(), checkedAt: latestLookup.at || null })
      // ── the other agents' session files ──
      if (path === '/roots' && req.method === 'GET') {
        const roots = []
        for (const [key, p] of Object.entries(FILE_ROOTS)) roots.push({ key, path: p, builtin: true, exists: await stat(p).then(st => st.isDirectory()).catch(() => false) })
        return sendJson(res, 200, { roots })
      }
      const rootRoute = /^\/roots\/([a-z-]+)\/(list|head|read|range|stat)$/.exec(path)
      if (rootRoute !== null && req.method === 'GET') {
        const key = rootRoute[1]
        if (rootRoute[2] === 'list') return sendJson(res, 200, { files: await listRoot(key) })
        const rel = url.searchParams.get('rel') ?? ''
        const abs = fileInRoot(key, rel)
        if (rootRoute[2] === 'stat') { const st = await stat(abs).catch(() => null); return st ? sendJson(res, 200, { size: st.size, mtime: st.mtimeMs }) : sendJson(res, 404, { error: 'no such file' }) }
        if (rootRoute[2] === 'head') return sendFile(res, 'text/plain; charset=utf-8', await headOfFile(abs, Number(url.searchParams.get('bytes')) || 16384).catch(() => ''))
        if (rootRoute[2] === 'read') {
          const st = await stat(abs).catch(() => null)
          if (!st) return sendJson(res, 404, { error: 'no such file' })
          if (st.size > FILE_READ_MAX) return sendJson(res, 413, { error: 'file too large to read whole; use range' })
          return sendFile(res, 'application/x-ndjson; charset=utf-8', await readFile(abs))
        }
        return sendJson(res, 200, await rangeOfFile(abs, url.searchParams.get('start'), url.searchParams.get('length')))
      }
      // ── the working-directory chooser: which kind this host offers, then its calls ──
      if (path === '/dir-picker' && req.method === 'GET') return sendJson(res, 200, { kind: pickerOf()?.kind ?? null })
      if (path.startsWith('/dir-picker/')) {
        const picker = pickerOf()
        const op = path.slice('/dir-picker/'.length)
        // the operator may sit at the dialog a while; a closed page closes it
        const ac = new AbortController()
        res.on('close', () => { if (!res.writableEnded) ac.abort() })
        try {
          if (op === 'pick' && req.method === 'POST' && picker?.kind === 'native') return sendJson(res, 200, { path: await picker.pick(ac.signal) })
          if (op === 'list' && req.method === 'GET' && picker?.kind === 'browse') return sendJson(res, 200, await picker.list(url.searchParams.get('path') || undefined, ac.signal))
          if (op === 'mkdir' && req.method === 'POST' && picker?.kind === 'browse') {
            const body = await readJson(req)
            return sendJson(res, 200, { path: await picker.createDirectory(String(body?.path ?? ''), String(body?.name ?? '')) })
          }
        } catch (error) {
          // the picker's closed vocabulary travels; anything else is a 500 below
          if (typeof error?.code === 'string' && error.code.startsWith('directory-')) return sendJson(res, 400, { error: error.message, code: error.code })
          throw error
        }
        return sendJson(res, 404, { error: picker ? 'not offered by this host\'s picker' : 'no directory picker on this harness' })
      }
      // ── link snapshots: the SPA's /api/fetch-url on the harness's bounded fetcher ──
      if (path === '/fetch-url' && req.method === 'POST') {
        const body = await readJson(req)
        const target = typeof body?.url === 'string' ? body.url.trim() : ''
        if (!/^https?:\/\//i.test(target)) return sendJson(res, 400, { error: 'url must be http(s)' })
        let r
        try { r = await ctx.web.fetch({ url: target }, AbortSignal.timeout(30000)) } catch (error) { return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) }) }
        if (r.statusCode >= 400) return sendJson(res, 502, { error: `HTTP ${r.statusCode} from ${target}` })
        const html = r.body?.kind === 'html' ? r.body.content : null
        const title = (html && /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim()) || new URL(target).hostname
        const text = html
          ? html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
          : String(r.body?.content ?? '')
        return sendJson(res, 200, { title, text, fetchedAt: new Date().toISOString(), ...(html ? { html } : {}), url: r.url ?? target, truncated: !!r.truncated })
      }
      // ── agent runtimes: the harness's own agent loop, and Pi, Codex and
      //    Claude Code on this machine — the same surface the desktop shell has ──
      if (path.startsWith('/agents/')) {
        const body = req.method === 'POST' ? await readJson(req, MAX_CALL_BODY_BYTES).catch(() => null) : null
        if (await agentsHttp().handle(req, res, path, body)) return
      }
      // ── model connection (the SPA's proxy protocol, on the harness's providers) ──
      if (path === '/models' && req.method === 'GET') return sendJson(res, 200, await modelsPayload(ctx))
      if ((path === '/stream' || path === '/claude') && req.method === 'POST') {
        return await serveModelCall(ctx, path, req, res, await readJson(req, MAX_CALL_BODY_BYTES))
      }
      // ── write direction ──
      const turnsRoute = /^\/sessions\/([^/]+)\/turns$/.exec(path)
      if (turnsRoute !== null && req.method === 'GET') {
        const id = decodeURIComponent(turnsRoute[1])
        const events = await eventsOfSession(ctx, id)
        if (events === null) return sendJson(res, 404, { error: 'no such session' })
        return sendJson(res, 200, { session: id, turns: turnsOf(events) })
      }
      const write = /^\/sessions\/([^/]+)\/(fork|inject|followup)$/.exec(path)
      if (write !== null && req.method === 'POST') {
        const id = decodeURIComponent(write[1])
        const body = await readJson(req, MAX_WRITE_BODY_BYTES)
        if (write[2] === 'fork') {
          // the boundary: an explicit seq, or the end of a named turn
          let atSeq = typeof body?.atSeq === 'number' ? body.atSeq : undefined
          if (typeof body?.afterTurn === 'number') {
            const events = await eventsOfSession(ctx, id)
            if (events === null) return sendJson(res, 404, { error: 'no such session' })
            const t = turnsOf(events).find(x => x.turn === body.afterTurn)
            if (!t) return sendJson(res, 400, { error: 'no such turn: ' + body.afterTurn })
            if (t.endSeq === null) return sendJson(res, 409, { error: 'turn ' + body.afterTurn + ' is still open; a fork needs a completed turn' })
            atSeq = t.endSeq
          }
          try {
            const r = await ctx.sessionController.fork({ sessionId: id, ...(atSeq !== undefined ? { atSeq } : {}) })
            return sendJson(res, 200, { session: r.sessionId, parent: id, atSeq: atSeq ?? null })
          } catch (error) {
            const code = error?.code ?? error?.name ?? 'fork failed'
            return sendJson(res, /NOT_FOUND/.test(String(code)) ? 404 : 409, { error: String(error?.message ?? code), code })
          }
        }
        const content = contentOf(body)
        if (write[2] === 'inject') {
          const agent = await agentOf(ctx, id)
          const message = { id: 'td-' + randomUUID(), role: 'user', content, source: sourceFor(agent.session) }
          agent.inject(message)
          return sendJson(res, 200, { accepted: true, session: id, messageId: message.id })
        }
        // followup: a person's prompt from the canvas — the controller owns
        // the user source and the queue/steer semantics the UI uses
        const requestId = 'td-' + randomUUID()
        const mode = body?.mode === 'steer' ? 'steer' : 'queue'
        await ctx.sessionController.prompt({ requestId, sessionId: id, mode, content }, AbortSignal.timeout(30000))
        return sendJson(res, 200, { accepted: true, session: id, requestId, mode })
      }
      return sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message })
      ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
      // the bridge only answers trusted local hosts, so the message may travel
      return sendJson(res, 500, { error: 'bridge unavailable', detail: error instanceof Error ? error.message : String(error) })
    }
  }

  const staticHandler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    let rel = url.pathname.slice(prefix.length).replace(/^\/+/, '') || 'index.html'
    if (rel.endsWith('/')) rel += 'index.html'
    if (url.pathname.startsWith(prefix + '/api/')) { rel = 'index.html' } // api never reaches the static table
    const abs = assetPath(rel)
    if (abs === null) { res.writeHead(403); res.end('forbidden'); return }
    try {
      const body = await readFile(abs)
      sendFile(res, MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream', body)
    } catch {
      res.writeHead(404); res.end('not found')
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: prefix, handler: (_req, res) => { res.writeHead(302, { location: prefix + '/' }); res.end() } }), 'dotline: redirect')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: prefix + '/api', handler: api }), 'dotline: api')
  // The agent lane's events over a WebSocket (the page falls back to the SSE
  // feed at /api/agents/events where this is missing): an SSE stream holds one
  // of the browser's six connections per host for as long as the page is open,
  // and with a few harness tabs the short requests a turn needs queue behind
  // them. The same Host fence as the api; and since any page may open a socket
  // here, the Origin — when the browser sends one — must be a trusted host too.
  if (typeof ctx.webServer.registerUpgrade === 'function') {
    const upgrade = (req, socket, head) => {
      const hostname = (typeof req.headers.host === 'string' ? req.headers.host : '').replace(/:\d+$/, '').toLowerCase()
      let originHost = null
      try { originHost = req.headers.origin ? new URL(req.headers.origin).hostname.toLowerCase() : null } catch { originHost = '' }
      if (!trustedHosts.has(hostname) || (originHost !== null && !trustedHosts.has(originHost))) { socket.destroy(); return }
      agentsHttp().upgrade(req, socket, head)
    }
    ctx.effect(() => ctx.webServer.registerUpgrade({ path: prefix + '/api/agents/ws', handler: upgrade }), 'dotline: agent events socket')
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: prefix, handler: staticHandler }), 'dotline: static')
  ctx.logger.info('[dsh-dotline] Dotline mounted at ' + prefix + '/')
  installApprovalAnswerer(ctx)
  await installWhyLayer(ctx, config)
}
