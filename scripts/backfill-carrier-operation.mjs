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
 *   - Never the OWNER'S three columns on a row whose operation_source is
 *     'owner'. He has answered on /app/settings, and "I'm not sure" is an
 *     answer — overwriting it with the federal value would undo a choice he
 *     made on purpose.
 *   - The four fmcsa_* columns (0040) on any row, owner or not. Those are the
 *     federal record itself, not his answer, and they are what a rule falls
 *     back to when he has said he is not sure. An owner row is the case that
 *     needs them most: his NULL is the reason the fallback exists.
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
import { censusOperation, federalOperationColumns, lookupCarrier } from '../src/lib/fmcsa.ts'
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

/** 0040's census-only mirror, in the same order. `federalOperationColumns` in
 *  src/lib/fmcsa.ts writes them; this list only has to know they exist. */
const FEDERAL_COLUMNS = ['fmcsa_carrier_operation', 'fmcsa_for_hire', 'fmcsa_hazmat']

const show = (v) => {
  if (v === null || v === undefined) return '—'
  if (v === true) return 'yes'
  if (v === false) return 'no'
  return String(v)
}

/** The three facts on one line, in the order the settings form asks them:
 *  crosses state lines / for hire / hazmat. */
const trio = (op, forHire, hazmat) => `${show(op)}/${show(forHire)}/${show(hazmat)}`

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
    [[...OPERATION_COLUMNS, 'operation_source', ...FEDERAL_COLUMNS]],
  )
  const has = new Set(present.map((r) => r.column_name))
  const migrated = [...OPERATION_COLUMNS, 'operation_source'].every((c) => has.has(c))
  // 0040 separately: a database can hold 0031 and not 0040, and on that one the
  // owner columns are still fillable while the federal fallback has nowhere to
  // go. Reading the two as one flag would stop a backfill that can still work.
  const hasFederal = FEDERAL_COLUMNS.every((c) => has.has(c))

  if (!migrated) {
    console.log('0031_carrier_operation.sql is not applied on this database.')
    if (APPLY) {
      console.error('Nothing to write to. Apply the migration first.')
      process.exit(1)
    }
    console.log('Showing what the census says for every carrier with a USDOT number.\n')
  } else if (!hasFederal) {
    console.log(
      '0040_federal_operation_fallback.sql is not applied: the federal fallback ' +
        'columns will be skipped.\n',
    )
  }

  // TWO REASONS TO LOOK A CARRIER UP, and a row can have either.
  //   1. one of HIS three columns is NULL and he has not answered himself
  //   2. one of the federal mirror columns is NULL
  // The second reaches rows the first never did: an owner who answered "I'm
  // not sure" is excluded from the first for good, and is exactly the carrier
  // whose board the fallback is meant to clear.
  const { rows: carriers } = await client.query(
    !migrated
      ? `select id, dot_number, legal_name,
                null::text as carrier_operation, null::boolean as for_hire,
                null::boolean as hazmat, null::text as operation_source,
                null::text as fmcsa_carrier_operation, null::boolean as fmcsa_for_hire,
                null::boolean as fmcsa_hazmat
           from carriers
          where dot_number is not null
          order by created_at`
      : hasFederal
        ? `select id, dot_number, legal_name, carrier_operation, for_hire, hazmat,
                  operation_source, fmcsa_carrier_operation, fmcsa_for_hire, fmcsa_hazmat
             from carriers
            where dot_number is not null
              and ((operation_source is distinct from 'owner'
                     and (carrier_operation is null or for_hire is null or hazmat is null))
                or fmcsa_carrier_operation is null
                or fmcsa_for_hire is null
                or fmcsa_hazmat is null)
            order by created_at`
        : `select id, dot_number, legal_name, carrier_operation, for_hire, hazmat,
                  operation_source,
                  null::text as fmcsa_carrier_operation, null::boolean as fmcsa_for_hire,
                  null::boolean as fmcsa_hazmat
             from carriers
            where dot_number is not null
              and operation_source is distinct from 'owner'
              and (carrier_operation is null or for_hire is null or hazmat is null)
            order by created_at`,
  )

  if (carriers.length === 0) {
    console.log(
      'Every carrier with a USDOT number is already filled, his columns and the federal ones.',
    )
    process.exit(0)
  }

  console.log(`${carriers.length} carrier(s) to look up.\n`)
  const header =
    `${'USDOT'.padEnd(9)} ${'Legal name'.padEnd(24)} ${'his answers'.padEnd(13)} ` +
    `${'federal'.padEnd(13)} ${'src'.padEnd(6)} will write`
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
    const owned = c.operation_source === 'owner'

    // HIS three columns. Only NULL ones take a value, and none of them do on a
    // row he has answered himself.
    const write = {}
    if (!owned) {
      for (const col of OPERATION_COLUMNS) {
        const after = facts?.[col] ?? null
        if (c[col] === null && after !== null) write[col] = after
      }
    }

    // The federal mirror. Any row, owner or not — but still only where the
    // column is NULL, so a value already read off the census is not rewritten
    // by a second run.
    let federal = null
    if (hasFederal && facts) {
      const fill = {}
      for (const [i, col] of FEDERAL_COLUMNS.entries()) {
        const after = facts[OPERATION_COLUMNS[i]] ?? null
        if (c[col] === null && after !== null) fill[col] = after
      }
      if (Object.keys(fill).length > 0) federal = fill
    }

    const willWrite = [
      ...Object.keys(write),
      ...(federal ? Object.keys(federal).map((k) => k.replace('fmcsa_', '')) : []).map(
        (k) => `${k} (federal)`,
      ),
    ]

    console.log(
      `${String(c.dot_number).padEnd(9)} ${String(c.legal_name ?? '')
        .slice(0, 24)
        .padEnd(24)} ` +
        `${trio(c.carrier_operation, c.for_hire, c.hazmat).padEnd(13)} ` +
        `${trio(facts?.carrier_operation, facts?.for_hire, facts?.hazmat).padEnd(13)} ` +
        `${String(c.operation_source ?? '—').padEnd(6)} ` +
        `${note || (willWrite.length > 0 ? willWrite.join(', ') : 'nothing')}`,
    )

    if (Object.keys(write).length > 0 || federal) {
      plan.push({ id: c.id, dot: c.dot_number, write, federal, facts })
    }
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
  let mirrored = 0
  for (const p of plan) {
    // COALESCE per column, and the 'owner' guard repeated in the WHERE: the
    // dry-run read and this write are two statements, and an owner who saved
    // his answers between them must win.
    if (Object.keys(p.write).length > 0) {
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

    // The federal mirror, in its own statement and with NO owner guard — these
    // columns are not his and nothing he can do on /app/settings writes them.
    // COALESCE all the same, so a value read on an earlier run stands.
    if (p.federal) {
      const cols = federalOperationColumns(p.facts)
      const r = await client.query(
        `update carriers
            set fmcsa_carrier_operation = coalesce(fmcsa_carrier_operation, $2),
                fmcsa_for_hire          = coalesce(fmcsa_for_hire, $3),
                fmcsa_hazmat            = coalesce(fmcsa_hazmat, $4),
                fmcsa_operation_read_at = $5
          where id = $1`,
        [
          p.id,
          cols.fmcsa_carrier_operation,
          cols.fmcsa_for_hire,
          cols.fmcsa_hazmat,
          cols.fmcsa_operation_read_at,
        ],
      )
      mirrored += r.rowCount ?? 0
    }
  }
  await client.query('commit')
  console.log(`Wrote ${written} row(s), and the federal record for ${mirrored}.`)
} catch (err) {
  await client.query('rollback').catch(() => {})
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await client.end()
}
