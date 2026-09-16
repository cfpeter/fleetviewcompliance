#!/usr/bin/env node
/**
 * Deploy, but only to the right Cloudflare account.
 *
 * WHY THIS EXISTS. Wrangler authenticates globally, per machine. This laptop was
 * logged in to a DIFFERENT product's Cloudflare account, and `npm run deploy:dev`
 * would have cheerfully created a `fleetview-compliance-dev` Worker and an R2
 * bucket over there — no error, no warning, just a working deployment on the
 * wrong account that somebody has to find and unpick later.
 *
 * So deploys do not use the machine's login at all. They use a token scoped to
 * THIS product, kept in .env (gitignored), and this script refuses to run unless
 * that token can actually see fleetviewcompliance.com. Same reasoning as the
 * per-repo SSH keys: one credential per project, and no shared global state that
 * a different project can quietly change underneath you.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ZONE = 'fleetviewcompliance.com'

const env = process.argv[2]
if (env !== 'dev' && env !== 'production') {
  console.error('Usage: node scripts/deploy.mjs <dev|production>')
  process.exit(1)
}

/** Read .env without a dependency. Values may contain '=' , so split once. */
function loadEnv(file = '.env') {
  let raw = ''
  try {
    raw = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  } catch {
    return {}
  }
  const out = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i === -1) continue
    out[t.slice(0, i).trim()] = t
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  return out
}

const fileEnv = loadEnv()

/**
 * The token, from .env if this project has its own, otherwise from whatever
 * `wrangler login` stored on this machine.
 *
 * Either is fine. The check below is what matters — it is the same check either
 * way, and it is the only thing that tells you, before anything is created,
 * which account you are about to deploy to.
 */
function machineToken() {
  for (const p of [
    `${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`,
    `${process.env.HOME}/.wrangler/config/default.toml`,
  ]) {
    try {
      const m = readFileSync(p, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)
      if (m) return m[1]
    } catch {
      // not there; try the next one
    }
  }
  return null
}

const token = process.env.CLOUDFLARE_API_TOKEN || fileEnv.CLOUDFLARE_API_TOKEN
const checkToken = token ?? machineToken()

if (!checkToken) {
  console.error(`Not logged in to Cloudflare. Run \`npx wrangler login\` with the account
that owns ${ZONE}, or put a scoped CLOUDFLARE_API_TOKEN in .env.`)
  process.exit(1)
}

const api = async (path) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${checkToken}` },
  })
  return r.json()
}

/**
 * The guard, and it distinguishes TWO failures that look identical from here.
 *
 * "The API refused to answer" is not "this is the wrong account", and conflating
 * them cost a real deploy: wrangler rewrites its token file when it refreshes
 * an OAuth token, this script read it mid-write, and the resulting API failure
 * was reported as WRONG ACCOUNT in capital letters. A guard that cries wolf is
 * a guard somebody deletes, and the whole point of this one is that it is still
 * there the day it matters.
 */
const zones = await api(`/zones?name=${ZONE}`)

if (zones?.success !== true) {
  const detail = (zones?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ')
  console.error(`
COULD NOT VERIFY THE ACCOUNT — not deploying, but this is probably not your fault.

Cloudflare did not answer the zone lookup${detail ? `: ${detail}` : '.'}

This is usually a token being refreshed underneath us, or a network blip. Run
the same command again. If it keeps happening, check \`npx wrangler whoami\`.
`)
  process.exit(1)
}

const found = (zones.result ?? []).find((z) => z.name === ZONE)

if (!found) {
  console.error(`
REFUSING TO DEPLOY.

Cloudflare answered, and this account cannot see ${ZONE} — so it is a different
account. Deploying would create a Worker and an R2 bucket on it.

If the account is right but the token lacks Zone:Read, add that permission; the
check needs it. Do not remove the check.
`)
  process.exit(1)
}

/**
 * WHAT GETS BAKED IN, AND WHY THIS CHECK EXISTS.
 *
 * src/lib/supabase/server.ts reads `import.meta.env.PUBLIC_SUPABASE_URL`, which
 * Vite INLINES AT BUILD TIME. The Worker never reads it at runtime, so a
 * Cloudflare secret cannot fix it afterwards — whatever was in the env when
 * `astro build` ran is what the deployed Worker talks to, permanently.
 *
 * That makes one mistake catastrophic and completely silent: running
 * `deploy:prod` on a laptop whose .env holds DEV credentials ships a production
 * site, on the real domain, reading and writing the development database. Real
 * carriers would sign in and see test data; test runs would write to whatever
 * they believed was safe. Nothing would error.
 *
 * So production refuses to build from the default .env. It requires
 * .env.production (gitignored, loaded by Vite in production mode) and refuses
 * if the Supabase project in it is the same one .env points at.
 */
const supabaseRef = (v) => (v.match(/https:\/\/([a-z0-9]+)\.supabase\.co/) ?? [])[1] ?? null

if (env === 'production') {
  const prodEnv = loadEnv('.env.production')
  const devRef = supabaseRef(fileEnv.PUBLIC_SUPABASE_URL ?? '')
  const prodRef = supabaseRef(prodEnv.PUBLIC_SUPABASE_URL ?? '')

  if (!prodRef) {
    console.error(`
REFUSING TO DEPLOY TO PRODUCTION.

.env.production is missing or has no PUBLIC_SUPABASE_URL.

Supabase credentials are inlined at BUILD time, so production would be built
from .env — the development database — and no Cloudflare secret could undo it.
Create .env.production with the production project's values first.
`)
    process.exit(1)
  }

  if (prodRef === devRef) {
    console.error(`
REFUSING TO DEPLOY TO PRODUCTION.

.env.production points at the same Supabase project as .env (${prodRef}).
That is the development database. Production would serve real carriers from it.
`)
    process.exit(1)
  }

  console.log(`✓ production Supabase project ${prodRef} (dev is ${devRef ?? 'unset'})`)
}

// Two config FILES, not two environments — see the header of wrangler.dev.jsonc
// for why an `env` block does not survive the Astro adapter's build.
const args =
  env === 'dev' ? ['wrangler', 'deploy', '-c', 'wrangler.dev.jsonc'] : ['wrangler', 'deploy']

console.log(`✓ token verified · zone ${ZONE} · account "${found.account.name}"`)
console.log(`→ ${args.join(' ')}\n`)

const run = spawnSync('npx', args, {
  stdio: 'inherit',
  // Only forwarded when this project has its own token. Otherwise wrangler uses
  // the machine login it already has — the same one just checked above.
  env: token ? { ...process.env, CLOUDFLARE_API_TOKEN: token } : process.env,
})
process.exit(run.status ?? 1)
