// Builds the fixture harness: desktop/plugin.js + stub SDK + real React, bundled for a plain browser.
// No install, no network. React, ReactDOM, esbuild and Playwright are read from an existing
// node_modules folder that you point PICKUP_HARNESS_MODULES at (anything that has them).
//   PICKUP_HARNESS_MODULES=/path/to/node_modules node desktop/test/build.mjs
// Output: desktop/test/.build/{harness.html,harness.js}; open harness.html in a browser, and drive
// it from the console via window.__fixture / window.__setProfile (see pickup.test.mjs).
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function modulesDir() {
  const dir = process.env.PICKUP_HARNESS_MODULES || process.env.npm_config_modules || process.argv.find(a => a.startsWith('--modules='))?.slice(10)

  if (!dir) {
    throw new Error('Pass --modules=/path/to/node_modules (or set PICKUP_HARNESS_MODULES): a folder containing react, react-dom, esbuild and playwright.')
  }

  return resolve(dir)
}

export async function buildHarness(outDir = join(here, '.build')) {
  const modules = modulesDir()
  const { build } = createRequire(join(modules, 'noop.js'))('esbuild')

  mkdirSync(outDir, { recursive: true })

  await build({
    entryPoints: [join(here, 'harness-entry.js')],
    outfile: join(outDir, 'harness.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    nodePaths: [modules],
    alias: { '@hermes/plugin-sdk': join(here, 'stub-sdk.js') },
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'warning'
  })

  // Fixture theme variables so the page is readable. The shipped plugin only references the names.
  writeFileSync(
    join(outDir, 'harness.html'),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pick up — fixture harness (stub SDK, not live)</title>
<style>
  :root{--ui-text-primary:#1d1d1f;--ui-text-secondary:#444;--ui-text-tertiary:#6b6b70;--ui-stroke-secondary:#c9c9ce;--ui-accent:#8a5a00;--ui-bg-quaternary:#ececf0}
  html,body,#root{height:100%;margin:0}
  body{font:14px/1.45 system-ui,sans-serif;background:#fafafa}
  .codicon::before{content:"•"}
</style></head><body><div id="root"></div><script src="harness.js"></script></body></html>`
  )

  return join(outDir, 'harness.html')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(await buildHarness())
}
