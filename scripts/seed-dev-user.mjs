#!/usr/bin/env node
/**
 * Creates a CONFIRMED test account on the dev database.
 *
 * Supabase requires email confirmation by default, and its built-in SMTP only
 * delivers to project team members at a couple of messages an hour — so the
 * signup form cannot complete a round trip locally. Rather than turn
 * confirmation off (which would then also be off in production if the project
 * is ever promoted), this inserts a pre-confirmed user directly.
 *
 *   node scripts/seed-dev-user.mjs owner@example.test hunter2222
 *
 * Refuses to run against anything but a dev database.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { dbConfig } from './db-config.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const e = {}
for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m) e[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const [email, password] = process.argv.slice(2)
if (!email || !password) {
  console.error('usage: node scripts/seed-dev-user.mjs <email> <password>')
  process.exit(1)
}
if (password.length < 8) {
  console.error('password must be at least 8 characters')
  process.exit(1)
}

// A seeded account with a known password must never exist in production.
//
// Matched on the HOST, not on a substring of the URL. dev.fleetviewcompliance.com
// CONTAINS the production domain, so a substring test refuses the exact database
// this script exists to seed — and a guard that blocks the ordinary path is one
// you learn to prefix with ALLOW_SEED=1 every single time, which is also what you
// will type on the day it was right. The two hosts are the production custom
// domains in wrangler.jsonc; anything else (dev, localhost, a preview) is fair game.
const PRODUCTION_HOSTS = ['fleetviewcompliance.com', 'www.fleetviewcompliance.com']
// Parsed by hand rather than with `new URL`, which throws on a value that was
// written without a scheme — and a throw here would skip the check entirely.
const siteHost = (e.PUBLIC_SITE_URL ?? '')
  .trim()
  .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  .split('/')[0]
  .split(':')[0]
  .toLowerCase()
if (PRODUCTION_HOSTS.includes(siteHost) && !process.env.ALLOW_SEED) {
  console.error(`PUBLIC_SITE_URL points at production (${siteHost}). Refusing.`)
  console.error('Set ALLOW_SEED=1 only if you are certain this is a dev database.')
  process.exit(1)
}

const cfg = dbConfig(e)
if (!cfg) {
  console.error('No database configured.')
  process.exit(1)
}

const c = new pg.Client(cfg)
await c.connect()
try {
  // auth.users has no plain unique constraint on email (it is enforced by a
  // partial index), so ON CONFLICT cannot target it. Remove then insert.
  await c.query('delete from auth.users where lower(email) = lower($1)', [email])
  const { rows } = await c.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values (
       '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
       'authenticated', 'authenticated', $1, crypt($2, gen_salt('bf')),
       now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
       now(), now()
     )
     returning id`,
    [email.toLowerCase(), password],
  )
  await c.query(
    `update auth.users set
       confirmation_token         = coalesce(confirmation_token, ''),
       recovery_token             = coalesce(recovery_token, ''),
       email_change               = coalesce(email_change, ''),
       email_change_token_new     = coalesce(email_change_token_new, ''),
       email_change_token_current = coalesce(email_change_token_current, ''),
       phone_change               = coalesce(phone_change, ''),
       phone_change_token         = coalesce(phone_change_token, ''),
       reauthentication_token     = coalesce(reauthentication_token, '')
     where id = $1`,
    [rows[0].id],
  )
  console.log(`✓ ${email} ready (id ${rows[0].id})`)
} catch (err) {
  console.error('failed:', err.message)
  process.exitCode = 1
} finally {
  await c.end()
}
