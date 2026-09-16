/**
 * Test plumbing. Tests run against a REAL database — a mocked one proves
 * nothing about RLS, which is the only thing worth testing here.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'

function env() {
  const out: Record<string, string> = {}
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    /* env may come from the shell */
  }
  return { ...out, ...process.env } as Record<string, string>
}

const e = env()

/** Either the pasted URI or the four discrete fields; the URI wins. */
function config(): pg.ClientConfig | null {
  if (e.SUPABASE_DB_URL?.trim()) {
    const u = new URL(e.SUPABASE_DB_URL.trim())
    return {
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, '') || 'postgres',
      ssl: { rejectUnauthorized: false },
    }
  }
  if (!e.SUPABASE_DB_HOST || !e.SUPABASE_DB_PASSWORD || !e.SUPABASE_DB_USER) return null
  return {
    host: e.SUPABASE_DB_HOST,
    port: Number(e.SUPABASE_DB_PORT ?? 5432),
    user: e.SUPABASE_DB_USER,
    password: e.SUPABASE_DB_PASSWORD,
    database: e.SUPABASE_DB_NAME ?? 'postgres',
    ssl: { rejectUnauthorized: false },
  }
}

export function configured(): boolean {
  return config() !== null
}

export async function connect(): Promise<pg.Client> {
  const cfg = config()
  if (!cfg) throw new Error('no database configured')
  const c = new pg.Client(cfg)
  await c.connect()
  return c
}

/**
 * Runs a body inside a transaction that is ALWAYS rolled back, so the suite can
 * be run against the live database repeatedly without leaving anything behind.
 */
export async function withRollback(fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const c = await connect()
  try {
    await c.query('begin')
    await fn(c)
  } finally {
    await c.query('rollback').catch(() => {})
    await c.end()
  }
}

/**
 * Become a signed-in user for the rest of this transaction.
 *
 * This is exactly how PostgREST presents a request to Postgres: the role is
 * switched to `authenticated` and the JWT claims are put in a GUC, which is
 * where auth.uid() reads the user id from. Testing through this means the
 * policies are exercised the same way a real request exercises them.
 */
export async function actAs(c: pg.Client, userId: string): Promise<void> {
  await c.query(`select set_config('role', 'authenticated', true)`)
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ])
}

/** Drop back to the owner connection so the test can set up more fixtures. */
export async function actAsOwner(c: pg.Client): Promise<void> {
  await c.query('reset role')
  await c.query(`select set_config('request.jwt.claims', '', true)`)
}

export async function actAsAnon(c: pg.Client): Promise<void> {
  await c.query(`select set_config('role', 'anon', true)`)
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ role: 'anon' }),
  ])
}

/**
 * Run one statement with the owner's grants while keeping the impersonated
 * user's JWT claim. See `makeCarrier` below for why this exists.
 */
export async function queryAsOwner(
  c: pg.Client,
  sql: string,
  params: unknown[],
): Promise<pg.QueryResult> {
  await c.query('reset role')
  const result = await c.query(sql, params)
  await c.query(`select set_config('role', 'authenticated', true)`)
  return result
}

/**
 * Create a carrier for whoever `actAs` is currently impersonating.
 *
 * Migration 0021 revoked EXECUTE on `create_carrier` from `authenticated`, so
 * the only way a signed-in user reaches a carrier is `complete_carrier_claim`
 * after a verified USDOT claim. That revoke IS the security property, and a
 * test that granted the role back to make its fixtures convenient would delete
 * the property it is supposed to be protecting.
 *
 * So the fixture borrows the owner's grant for exactly one statement. The role
 * and the JWT claim are set independently in this harness, so resetting the
 * role leaves `request.jwt.claims` in place and `create_carrier` still writes
 * the membership for the right user — which is the whole reason this works
 * without weakening anything.
 */
export async function makeCarrier(c: pg.Client, dot: string, name: string): Promise<string> {
  await c.query('reset role')
  const { rows } = await c.query('select create_carrier($1, $2) as id', [dot, name])
  await c.query(`select set_config('role', 'authenticated', true)`)
  return rows[0].id as string
}

/** Creates an auth user and returns its id. Owner connection only. */
export async function makeUser(c: pg.Client, email: string): Promise<string> {
  const { rows } = await c.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                             email_confirmed_at, created_at, updated_at)
     values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
             'authenticated', $1, 'x', now(), now(), now())
     returning id`,
    [email],
  )
  return rows[0].id
}

/**
 * Runs a statement that is EXPECTED to be refused, and returns the error.
 *
 * The savepoint is not optional. In Postgres a failed statement aborts the
 * whole transaction, and every subsequent query returns 25P02 "current
 * transaction is aborted" — so a test that tries a forbidden write and then
 * queries to confirm nothing changed gets a misleading failure on the
 * *verification*, not the thing under test.
 */
export async function attempt(
  c: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<Error | null> {
  await c.query('savepoint attempt_sp')
  try {
    await c.query(sql, params)
    await c.query('release savepoint attempt_sp')
    return null
  } catch (e) {
    await c.query('rollback to savepoint attempt_sp')
    return e as Error
  }
}
