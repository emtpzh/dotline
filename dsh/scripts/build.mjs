#!/usr/bin/env node
// Build the plugin's bundled Dotline SPA with a subpath base so the host
// half can serve it under /dotline/. Usage:
//   node scripts/build.mjs [dotline-repo] [outDir]   (from dsh/: node scripts/build.mjs ..)
//   npm run dsh:build                                  (from the repo root)
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, cpSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repo = resolve(process.argv[2] ?? process.env.THOUGHTDAG_REPO ?? resolve(__dirname, '../..'))
const outDir = resolve(process.argv[3] ?? resolve(__dirname, '../dist-app'))
const tmp = resolve(__dirname, '../.dist-tmp')

if (!existsSync(resolve(repo, 'package.json'))) {
  console.error('dotline repo not found at', repo)
  process.exit(1)
}
console.log('building dotline (base /dotline/) from', repo)
rmSync(tmp, { recursive: true, force: true })
// VITE_API_BASE points the SPA's own proxy calls (/api/models, /api/stream…) at
// this host, which answers them on the harness's providers.
// VITE_DSH_BRIDGE tells the SPA where the plugin's session bridge answers, so
// it installs the harness-backed window.desktopSessions at boot
// The type gate the root `npm run build` has, then vite itself. tsc and vite
// ship pure-JS entries no installer ever touches, so both run as node scripts
// through this process's own node binary: execFileSync cannot spawn `npm` (a
// .cmd needing a shell on Windows) nor the extensionless .bin shims, while a
// JS entry takes argv verbatim — no shell, no quoting, one code path.
execFileSync(process.execPath, [resolve(repo, 'node_modules/typescript/bin/tsc'), '-b'], { cwd: repo, stdio: 'inherit' })
execFileSync(process.execPath, [resolve(repo, 'node_modules/vite/bin/vite.js'), 'build', '--base=/dotline/', '--outDir=' + tmp], { cwd: repo, stdio: 'inherit', env: { ...process.env, VITE_DSH_BRIDGE: '/dotline/api', VITE_API_BASE: '/dotline' } })
// keep only what the embedded SPA needs; landing-page covers are not served
rmSync(resolve(tmp, 'covers'), { recursive: true, force: true })
// the tutorial's gifs stay: a first-time visitor inside the harness sees the same walkthrough
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
cpSync(tmp, outDir, { recursive: true })
rmSync(tmp, { recursive: true, force: true })
console.log('plugin SPA written to', outDir)

// The why layer: the CLI's library, bundled for the host (Node), so the plugin
// registers the same four questions as native harness tools and a /why command
// esbuild is the one tool that cannot run as a node script: its installer
// overwrites bin/esbuild with the native binary on macOS and Linux (the JS
// shim survives only on Windows), so node on it dies with a SyntaxError. Its
// JS API locates the platform binary itself — the same flags as the root
// `cli:build`, resolved from the repo's own esbuild, still no shell anywhere.
const whyOut = resolve(__dirname, '../lib/why.mjs')
await createRequire(resolve(repo, 'package.json'))('esbuild').build({
  entryPoints: [resolve(repo, 'cli/src/lib.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  define: { 'import.meta.env': '{}' },
  outfile: whyOut,
  logLevel: 'warning',
})
console.log('why layer written to', whyOut)

// The shared agent runtime (plain Node): the host serves it over HTTP so the
// canvas inside the harness runs agents exactly as the desktop shell does
const runtimeOut = resolve(__dirname, '../lib/runtime')
rmSync(runtimeOut, { recursive: true, force: true })
cpSync(resolve(repo, 'runtime'), runtimeOut, { recursive: true })
console.log('agent runtime written to', runtimeOut)
