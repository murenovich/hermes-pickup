// Static gate: only the two allowed import sources (@hermes/plugin-sdk and react; react/jsx-runtime is
// NOT allowed, plugin.js defines its own jsx/jsxs on createElement), and every component identifier passed
// to jsx()/jsxs() is imported or declared locally. Usage: node desktop/test/check-imports.mjs [plugin.js]
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const file = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin.js')
const src = readFileSync(file, 'utf8')
const ALLOWED = new Set(['@hermes/plugin-sdk', 'react'])
const problems = []

// Forms the main import regex below does not see: side-effect imports and re-exports from a module.
for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) {
  problems.push(`side-effect import: ${m[1]}`)
}

for (const m of src.matchAll(/^\s*export\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm)) {
  problems.push(`re-export from: ${m[1]}`)
}

const imported = new Set()

for (const m of src.matchAll(/^import\s*([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
  if (!ALLOWED.has(m[2])) {
    problems.push(`disallowed import: ${m[2]}`)
  }

  for (const name of m[1].replace(/[{}]/g, ' ').split(',')) {
    const id = name.trim().split(/\s+as\s+/).pop()

    if (id) {
      imported.add(id)
    }
  }
}

if (/\bimport\s*\(/.test(src)) {
  problems.push('dynamic import() found')
}

if (/\brequire\s*\(/.test(src)) {
  problems.push('require() found')
}

const declared = new Set(
  [...src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1])
)

const used = new Set([...src.matchAll(/\bjsxs?\(\s*([A-Za-z_$][\w$.]*)\s*,/g)].map(m => m[1]))

for (const id of used) {
  if (/^[A-Z]/.test(id) && !imported.has(id) && !declared.has(id)) {
    problems.push(`jsx component not imported or declared: ${id}`)
  }
}

const body = src.replace(/^import[\s\S]*?from\s*['"][^'"]+['"]/gm, '')

for (const id of imported) {
  if (!new RegExp(`\\b${id}\\b`).test(body)) {
    problems.push(`unused import: ${id}`)
  }
}

const code = src
  .replace(/\/\/.*$/gm, '')
  .replace(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "''")

if (/<[A-Z][\w]*[\s/>]/.test(code)) {
  problems.push('possible JSX syntax')
}

// Colour values live inside string literals; do not strip those before this check.
const colours = src.replace(/\/\/.*$/gm, '').match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)

if (colours) {
  problems.push(`hardcoded colour literals: ${[...new Set(colours)].join(', ')}`)
}

console.log(`imports: ${[...imported].sort().join(', ')}`)
console.log(`jsx components used: ${[...used].filter(i => /^[A-Z]/.test(i)).sort().join(', ')}`)

if (problems.length) {
  console.error(`FAIL\n- ${problems.join('\n- ')}`)
  process.exit(1)
}

console.log('PASS: two allowed import sources, all jsx identifiers resolved, no JSX syntax, no colour literals')
