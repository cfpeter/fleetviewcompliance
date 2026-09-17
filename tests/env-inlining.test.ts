/**
 * The one rule that keeps secrets out of the deployed bundle.
 *
 * VITE REPLACES THE `import.meta.env` EXPRESSION, NOT THE PROPERTY ACCESS. A
 * literal key — `import.meta.env.PUBLIC_SUPABASE_URL` — becomes that one string
 * and nothing else. A COMPUTED key cannot be resolved at build time, so Vite
 * substitutes an object literal holding EVERY variable the build machine's .env
 * carried and lets the running code index that. It looks like the cautious
 * spelling and it is the dangerous one.
 *
 * FAILURE PINNED: `workerEnv[k] ?? (import.meta.env as unknown as Record<string,
 * string>)[k]`, in src/pages/api/cron/digest.ts and src/pages/app/setup.astro,
 * written in the belief that a key Vite cannot see is a value Vite cannot
 * inline. It shipped. `dist/server/**\/*.mjs` contained CRON_SECRET,
 * CLAIM_CODE_PEPPER, SUPABASE_SECRET_KEY and RESEND_API_KEY as plaintext
 * literals — verified by searching the built output for the actual values — in
 * a file uploaded to Cloudflare and left in dist/ afterwards.
 *
 * Asserted against the SOURCE, because any build made from a file containing
 * that expression is already wrong, and because the bundle it produces is not
 * something a test can safely search for real secrets. The fix is the reader in
 * src/lib/billing/config.ts: `cloudflare:workers` first, `process.env` second,
 * neither of which Vite touches.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(path))
    else if (/\.(ts|astro)$/.test(entry.name)) out.push(path)
  }
  return out
}

/**
 * Code with the comments taken out.
 *
 * Every file that reads the environment now carries a long note about why the
 * computed key is forbidden, and those notes quote the expression they forbid.
 * Scanning the raw text would therefore fail on the very comments that exist to
 * keep this from coming back. `//` is only treated as a comment when it does not
 * follow a colon, so the `https://` inside a string does not truncate a line.
 */
function code(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

test('no source reads import.meta.env by a computed key', () => {
  const offenders: string[] = []
  let scanned = 0
  let literalReads = 0

  for (const file of sources(SRC)) {
    scanned++
    const body = code(readFileSync(file, 'utf8'))
    // Every occurrence, then judged by what follows it. A literal property is
    // the only safe shape; anything else — `[k]`, a cast, a bare reference
    // passed somewhere — puts the whole object in the bundle.
    for (const match of body.matchAll(/import\.meta\.env\s*(.?)/g)) {
      if (match[1] === '.') literalReads++
      else offenders.push(`${file.slice(SRC.length + 1)}: import.meta.env${match[1] ?? ''}`)
    }
  }

  // A scan that matched nothing would pass in silence. src/lib/supabase/server.ts
  // and src/middleware.ts both read literal keys and are expected to stay.
  assert.ok(scanned > 50, `only scanned ${scanned} files — the walk is broken`)
  assert.ok(literalReads >= 3, `only found ${literalReads} literal reads — the scan is broken`)
  assert.deepEqual(
    offenders,
    [],
    'import.meta.env indexed by anything but a literal key inlines EVERY .env value into dist/',
  )
})

test('the routes that read secrets fall back to process.env', () => {
  // The other half: a file could avoid `import.meta.env` and still have no
  // fallback at all, which reads as "nothing is configured" everywhere outside
  // the Worker rather than as the bug it is.
  for (const path of [
    'pages/api/cron/digest.ts',
    'pages/app/setup.astro',
    'lib/billing/config.ts',
  ]) {
    const body = code(readFileSync(join(SRC, path), 'utf8'))
    assert.match(
      body,
      /await import\('cloudflare:workers'\)/,
      `${path} no longer reads the Worker env`,
    )
    assert.match(body, /process\.env/, `${path} has no process.env fallback`)
  }
})
