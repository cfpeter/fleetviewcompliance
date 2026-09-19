#!/usr/bin/env node
/**
 * Fills carriers.carrier_operation / for_hire / hazmat for carriers that signed
 * up before 0031_carrier_operation.sql gave the table those columns.
 *
 * WHY. Every applicability gate in src/lib/rules reads the three facts off the
 * carrier row, and a row with NULL in all three is shown every rule in the
 * catalogue — IFTA, IRP, UCR, hazmat, the FMCSA insurance filing — whether or
 * not it owes them. Signup now copies the facts off the FMCSA census row; this
 * script does the same for the carriers that were created before it did.
 *
 *   node scripts/backfill-carrier-operation.mjs           dry run: look every
 *                                                         carrier up, print the
 *                                                         table, write nothing
 *   node scripts/backfill-carrier-operation.mjs --apply   write the rows shown
 *
 * WHAT IT WILL AND WILL NOT WRITE.
 *   - Only carriers with a dot_number: there is nothing to look up otherwise.
 *   - Only columns that are NULL. A value already on the row is never replaced,
 *     whoever wrote it.
 *   - Never a row whose operation_source is 'owner'. The owner has answered on
 *     /app/settings, and "I'm not sure" is an answer — overwriting it with the
 *     federal value would undo a choice he made on purpose.
 *   - Never a guess. A census value that does not settle a fact leaves the
 *     column NULL, which the rules read as "unknown" and keep tracking. See
 *     `censusOperation` in src/lib/fmcsa.ts for the mapping.
 *
 * Refuses to run against production — `guard()` is the one in demo-data.mjs.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { censusOperation, lookupCarrier } from '../src/lib/fmcsa.ts'
import { dbConfig } from './db-config.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')

// ---------------------------------------------------------------- environment

/** Parsed by hand, exactly as migrate.mjs does: this runs outside the bundler. */
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

const e = env()

/** The dev Supabase project this script is allowed to write to. See demo-data.mjs. */
const DEV_PROJECT_REF = e.DEMO_DEV_PROJECT_REF?.trim() || 'jgonfqmpecngjjlayfwj'

/** The two production hosts, matched on the HOST and never on a substring. */
const PRODUCTION_HOSTS = ['fleetviewcompliance.com', 'www.fleetviewcompliance.com']

/**
 * Four independent reasons to stop, every one failing CLOSED. Copied from
 * demo-data.mjs rather than imported so that a change there is a change
 * somebody has to make here on purpose.
 */
function guard(cfg) {
  const stop = (why, ...rest) => {
    console.error(`Refusing to run: ${why}`)
    for (const line of rest) console.error(`  ${line}`)
    process.exit(1)
  }

  const deploy = (e.DEPLOY_ENV ?? '').trim().toLowerCase()
  if (deploy !== 'development') {
    stop(
      `DEPLOY_ENV is ${deploy ? `'${deploy}'` : 'not set'}, not 'development'.`,
      'This script only ever touches the development database.',
    )
  }

  const url = (e.PUBLIC_SUPABASE_URL ?? '').trim()
  if (!url) stop('PUBLIC_SUPABASE_URL is not set.', 'Cannot tell which project this is.')
  const ref = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('.')[0]
    .toLowerCase()
  if (ref !== DEV_PROJECT_REF) {
    stop(
      `PUBLIC_SUPABASE_URL points at project '${ref}', not the dev project.`,
      `Expected '${DEV_PROJECT_REF}'.`,
    )
  }

  const siteHost = (e.PUBLIC_SITE_URL ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase()
  if (PRODUCTION_HOSTS.includes(siteHost)) {
    stop(`PUBLIC_SITE_URL is the production site (${siteHost}).`)
  }

  const carriesRef =
    (cfg.user ?? '').toLowerCase().includes(DEV_PROJECT_REF) ||
    (cfg.host ?? '').toLowerCase().includes(DEV_PROJECT_REF)
  if (!carriesRef) {
    stop(
      'The database connection does not name the dev project.',
      `user=${cfg.user} host=${cfg.host}`,
      `Expected '${DEV_PROJECT_REF}' in one of them.`,
    )
  }
}

const cfg = dbConfig(e)
if (!cfg) {
  console.error('No database connection configured. See scripts/migrate.mjs for the fields.')
  process.exit(1)
}
guard(cfg)

// ------------------------------------------------------------------- printing

const OPERATION_COLUMNS = ['carrier_operation', 'for_hire', 'hazmat']

const show = (v) => {
  if (v === null || v === undefined) return '—'
  if (v === true) return 'yes'
  if (v === false) return 'no'
  return String(v)
}

/** "—" when nothing changes, "— → C" when it does. */
const change = (before, after) =>
  after === null || after === undefined || before !== null
    ? show(before)
    : `${show(before)} → ${show(after)}`

// ------------------------------------------------------------------- the work

const client = new pg.Client(cfg)
await client.connect()

try {
  // 0031 applied? Without the columns the dry run still shows what the census
  // says, but there is nowhere to write it, so --apply stops here.
  const { rows: present } = await client.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'carriers'
        and column_name = any($1)`,
    [[...OPERATION_COLUMNS, 'operation_source']],
  )
  const migrated = present.length === OPERATION_COLUMNS.length + 1

  if (!migrated) {
    console.log('0031_carrier_operation.sql is not applied on this database.')
    if (APPLY) {
      console.error('Nothing to write to. Apply the migration first.')
      process.exit(1)
    }
    console.log('Showing what the census says for every carrier with a USDOT number.\n')
  }

  const { rows: carriers } = await client.query(
    migrated
      ? `select id, dot_number, legal_name, carrier_operation, for_hire, hazmat, operation_source
           from carriers
          where dot_number is not null
            and operation_source is distinct from 'owner'
            and (carrier_operation is null or for_hire is null or hazmat is null)
          order by created_at`
      : `select id, dot_number, legal_name,
                null::text as carrier_operation, null::boolean as for_hire,
                null::boolean as hazmat, null::text as operation_source
           from carriers
          where dot_number is not null
          order by created_at`,
  )

  if (carriers.length === 0) {
    console.log('Every carrier with a USDOT number already has all three columns filled.')
    process.exit(0)
  }

  console.log(`${carriers.length} carrier(s) to look up.\n`)
  const header =
    `${'USDOT'.padEnd(9)} ${'Legal name'.padEnd(28)} ${'operation'.padEnd(11)} ` +
    `${'for hire'.padEnd(11)} ${'hazmat'.padEnd(11)} classdef (federal)`
  console.log(header)
  console.log('-'.repeat(header.length))

  const token = e.SOCRATA_APP_TOKEN
  const plan = []

  for (const c of carriers) {
    let census = null
    let note = ''
    try {
      census = await lookupCarrier(c.dot_number, token)
      if (!census) note = 'no census row'
    } catch (err) {
      note = `lookup failed: ${err instanceof Error ? err.message : String(err)}`
    }

    const facts = censusOperation(census)
    // Only NULL columns take a value. Everything else is kept as it was.
    const write = {}
    for (const col of OPERATION_COLUMNS) {
      const after = facts?.[col] ?? null
      if (c[col] === null && after !== null) write[col] = after
    }

    console.log(
      `${String(c.dot_number).padEnd(9)} ${String(c.legal_name ?? '')
        .slice(0, 28)
        .padEnd(28)} ` +
        `${change(c.carrier_operation, facts?.carrier_operation).padEnd(11)} ` +
        `${change(c.for_hire, facts?.for_hire).padEnd(11)} ` +
        `${change(c.hazmat, facts?.hazmat).padEnd(11)} ` +
        `${note || census?.classdef || '—'}`,
    )

    if (Object.keys(write).length > 0) plan.push({ id: c.id, dot: c.dot_number, write })
  }

  console.log('')
  const untouched = carriers.length - plan.length
  console.log(
    `${plan.length} row(s) would change; ${untouched} would not ` +
      '(no census row, nothing the census settles, or already filled).',
  )

  if (!APPLY) {
    console.log('Dry run. Nothing was written. Run with --apply to write the rows above.')
    process.exit(0)
  }

  await client.query('begin')
  let written = 0
  for (const p of plan) {
    // COALESCE per column, and the 'owner' guard repeated in the WHERE: the
    // dry-run read and this write are two statements, and an owner who saved
    // his answers between them must win.
    const r = await client.query(
      `update carriers
          set carrier_operation = coalesce(carrier_operation, $2),
              for_hire          = coalesce(for_hire, $3),
              hazmat            = coalesce(hazmat, $4),
              operation_source  = coalesce(operation_source, 'fmcsa')
        where id = $1
          and operation_source is distinct from 'owner'`,
      [p.id, p.write.carrier_operation ?? null, p.write.for_hire ?? null, p.write.hazmat ?? null],
    )
    written += r.rowCount ?? 0
  }
  await client.query('commit')
  console.log(`Wrote ${written} row(s).`)
} catch (err) {
  await client.query('rollback').catch(() => {})
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await client.end()
}
