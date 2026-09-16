#!/usr/bin/env node
/**
 * Applies supabase/migrations/NNNN_*.sql in order, once each.
 *
 * Plain node + pg, no framework. Connects through the SESSION pooler on 5432:
 * Supabase's direct db.<ref> host is IPv6-only and this network is IPv4-only,
 * so the direct host times out with a misleading ENETUNREACH.
 *
 *   node scripts/migrate.mjs           apply pending
 *   node scripts/migrate.mjs --dry     list pending, apply nothing
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { dbConfig } from './db-config.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dry = process.argv.includes('--dry')

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
const pending = files.filter((f) => !done.has(f))

if (!pending.length) {
  console.log(`Up to date (${files.length} applied).`)
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
