#!/usr/bin/env node
/**
 * Applies supabase/migrations/NNNN_*.sql in order, once each.
 *
 * Plain node + pg, no framework. Connects through the SESSION pooler on 5432:
 * Supabase's direct db.<ref> host is IPv6-only and this network is IPv4-only,
 * so the direct host times out with a misleading ENETUNREACH.
 *
 *   node scripts/migrate.mjs                 apply pending
 *   node scripts/migrate.mjs --dry           list pending, apply nothing
 *   node scripts/migrate.mjs --only NAME     apply exactly that one file
 *
 * `--only` EXISTS BECAUSE A PENDING LIST IS NOT ALWAYS A QUEUE. Most pending
 * migrations are simply steps nobody has taken yet. Occasionally one of them is
 * a DECISION — 0030 adds triggers that refuse writes — and the owner has said
 * yes to a different file in the same list. Applying the lot because the runner
 * only knows how to apply the lot is how a schema change nobody approved gets
 * in on somebody else's yes.
 *
 * It applies OUT OF ORDER by design, and says so when it does, so the skipped
 * files stay pending and are applied later by a plain run. Use it when the files
 * are independent; a migration that builds on an earlier pending one will fail
 * inside its transaction and leave nothing behind, which is the right answer.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { dbConfig } from './db-config.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dry = process.argv.includes('--dry')
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt === -1 ? null : process.argv[onlyAt + 1]

// Parse .env by hand rather than adding a dependency: this runs outside the
// bundler and the file is trivial.
function env() {
  const out = {}
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // No .env is fine when the values come from the real environment.
  }
  return { ...out, ...process.env }
}

const cfg = dbConfig(env())
if (!cfg) {
  console.error('No database connection configured.')
  console.error('Supabase dashboard -> Connect -> Session pooler (port 5432, NOT 6543).')
  console.error('Paste the whole URI into .env as SUPABASE_DB_URL=..., or fill the')
  console.error('SUPABASE_DB_HOST / _USER / _PASSWORD fields individually.')
  process.exit(1)
}

const client = new pg.Client(cfg)

const files = readdirSync(join(root, 'supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()

await client.connect()
await client.query(`
  create table if not exists _migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )
`)

const { rows } = await client.query('select name from _migrations')
const done = new Set(rows.map((r) => r.name))
let pending = files.filter((f) => !done.has(f))

if (only) {
  if (!files.includes(only)) {
    console.error(`No such migration: ${only}`)
    await client.end()
    process.exit(1)
  }
  // Named but already applied is not an error — it is the answer to "is this
  // one in yet", and re-running must never look like it did something.
  const skipped = pending.filter((f) => f < only)
  pending = pending.filter((f) => f === only)
  if (skipped.length) {
    console.log(`Skipping ${skipped.length} earlier pending, left for later:`)
    console.log(skipped.map((p) => `  · ${p}`).join('\n'))
  }
}

if (!pending.length) {
  console.log(only ? `${only} is already applied.` : `Up to date (${files.length} applied).`)
  await client.end()
  process.exit(0)
}

console.log(`${pending.length} pending:\n${pending.map((p) => '  ' + p).join('\n')}`)
if (dry) {
  await client.end()
  process.exit(0)
}

for (const name of pending) {
  const sql = readFileSync(join(root, 'supabase/migrations', name), 'utf8')
  // One transaction per file: a failure leaves that migration entirely unapplied
  // rather than half-applied, which is the difference between "run it again" and
  // "work out what happened by hand".
  try {
    await client.query('begin')
    await client.query(sql)
    await client.query('insert into _migrations (name) values ($1)', [name])
    await client.query('commit')
    console.log(`  ✓ ${name}`)
  } catch (err) {
    await client.query('rollback')
    console.error(`  ✗ ${name}\n${err.message}`)
    await client.end()
    process.exit(1)
  }
}

await client.end()
console.log('Done.')
