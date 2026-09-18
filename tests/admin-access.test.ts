/**
 * The operator gate, tested as the attack.
 *
 * /app/admin/claims lists claim requests across EVERY carrier on the platform —
 * which companies are here, which USDOT numbers strangers are trying to take,
 * and the account email of whoever is trying. A carrier who reaches it learns
 * all of that about his competitors, and a screen that lists claims is one
 * commit away from a screen that grants them, which is handing somebody else's
 * federal number to whoever asked. So the happy path is not what is worth
 * testing here. These are:
 *
 *   a signed-in carrier who is not an operator gets in
 *   a variable nobody set means "let everybody in" instead of "let nobody in"
 *   `ADMIN_OPERATORS=*` is read as a wildcard
 *   an address typed at signup, never confirmed, stands in for the operator's
 *   the refusal looks different from a missing page, and so announces the page
 *   the gate is moved below a redirect that announces the page anyway
 *   the privileged key is read before anybody has been allowed in
 *
 * The last three cannot be reached through the pure functions, because they are
 * facts about WHERE the check sits rather than about what it returns. They are
 * asserted against the source, the same way tests/env-inlining.test.ts asserts
 * the rule that keeps secrets out of the bundle — a guard in the right shape in
 * the wrong place is not a guard.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  adminEnv,
  isEmptyAllowlist,
  isOperator,
  isOperatorRequest,
  notFound,
  OPERATOR_ENV_KEY,
  parseOperators,
} from '../src/lib/admin/operators.ts'

const OPERATOR_ID = '11111111-2222-3333-4444-555555555555'
const CARRIER_ID = '99999999-8888-7777-6666-555555555555'

/** A real, confirmed, signed-in account that is NOT on the list. */
const carrier = {
  id: CARRIER_ID,
  email: 'dispatch@sunvalleytrucking.com',
  emailConfirmed: true,
}

/** The owner, by user id — the strong form of an allowlist entry. */
const operatorById = { id: OPERATOR_ID, email: 'someone@example.com', emailConfirmed: true }

// ------------------------------------------------ 1. a non-operator is refused

test('a signed-in carrier who is not on the list is refused', () => {
  // The list is populated — this is not the empty-config case. It simply does
  // not name him, and that is the entire test: access is granted by being
  // named, never by failing to be excluded.
  assert.equal(isOperator(carrier, OPERATOR_ID), false)
  assert.equal(isOperator(carrier, 'owner@fleetviewcompliance.com'), false)
  assert.equal(
    isOperator(carrier, `${OPERATOR_ID}, owner@fleetviewcompliance.com`),
    false,
    'a carrier got in through a list that names two other people',
  )

  // And the same person IS let in when named, so the test above is not passing
  // because the gate refuses everybody unconditionally.
  assert.equal(isOperator(operatorById, OPERATOR_ID), true)
  assert.equal(isOperator(carrier, `${OPERATOR_ID} ${carrier.email}`), true)
})

test('an unconfirmed address never stands in for an operator address', () => {
  // Signing up as owner@… and never clicking the link must not be a way in:
  // the address is something the attacker typed until Supabase has watched a
  // link come back from that mailbox.
  const pretender = {
    id: CARRIER_ID,
    email: 'owner@fleetviewcompliance.com',
    emailConfirmed: false,
  }
  assert.equal(isOperator(pretender, 'owner@fleetviewcompliance.com'), false)

  // Confirmed, the same address is the operator.
  assert.equal(isOperator({ ...pretender, emailConfirmed: true }, pretender.email), true)

  // A user id needs no confirmation, which is why it is the form to prefer: it
  // is not a value the account holder can choose.
  assert.equal(isOperator({ id: OPERATOR_ID, emailConfirmed: false }, OPERATOR_ID), true)
})

test('nobody at all is somebody the gate refuses', () => {
  // A request with no session reaches the gate as an empty identity. It must be
  // refused by the allowlist rather than by whatever happens to run next.
  assert.equal(isOperator(null, OPERATOR_ID), false)
  assert.equal(isOperator(undefined, OPERATOR_ID), false)
  assert.equal(isOperator({}, OPERATOR_ID), false)
  assert.equal(isOperator({ id: null, email: null }, OPERATOR_ID), false)
  assert.equal(
    isOperator({ id: '', email: '', emailConfirmed: true }, ' , , '),
    false,
    'an empty identity matched an empty entry',
  )
})

// ------------------------- 2. missing configuration refuses everybody, not all

test('an unset or empty ADMIN_OPERATORS lets NOBODY in', () => {
  // The one that matters most. A guard that reads "if the list is empty, skip
  // the check" is the same guard with the sign flipped, and it fails open on
  // the day somebody forgets to set a variable on a new environment.
  for (const raw of [undefined, null, '', '   ', '\n\t ', ',', ',,,', ' ; , ; ']) {
    assert.equal(
      isOperator(operatorById, raw),
      false,
      `an operator got in with ADMIN_OPERATORS=${JSON.stringify(raw)}`,
    )
    assert.equal(
      isOperator(carrier, raw),
      false,
      `a carrier got in with ADMIN_OPERATORS=${JSON.stringify(raw)}`,
    )
    assert.equal(isEmptyAllowlist(parseOperators(raw)), true)
  }
})

test('nothing in the variable is ever read as "everybody"', () => {
  // Every value somebody might reasonably type meaning "open it up". None of
  // them is a user id and none is an email address, so all of them parse to an
  // empty list, and an empty list admits nobody — including the person who
  // typed it, who then finds out immediately.
  for (const raw of ['*', '**', 'all', 'ALL', 'true', '1', 'yes', 'any', '@', '@.com', '*@*']) {
    const list = parseOperators(raw)
    assert.equal(isEmptyAllowlist(list), true, `ADMIN_OPERATORS=${raw} parsed to ${list.ids}`)
    assert.equal(isOperator(carrier, raw), false, `ADMIN_OPERATORS=${raw} let a carrier in`)
    assert.equal(isOperator(operatorById, raw), false)
  }

  // A junk entry beside a real one does not widen the real one either.
  assert.equal(isOperator(carrier, `* ${OPERATOR_ID}`), false)
  assert.equal(isOperator(operatorById, `* ${OPERATOR_ID}`), true)
})

test('a typo refuses, and refuses the operator first', () => {
  // The failure that must never be silent-and-open: a misspelled address
  // matches nobody, so the person who set it discovers it by being locked out
  // rather than by a stranger reading the queue.
  assert.equal(
    isOperator({ ...carrier, email: 'owner@fleetview.com' }, 'owner@fleetvew.com'),
    false,
  )
  assert.equal(isOperator(operatorById, `${OPERATOR_ID.slice(0, -1)}0`), false)
})

test('the allowlist is read the way a person would type it', () => {
  // Commas, semicolons, newlines and stray spacing all parse the same, and
  // case never decides access — an operator who typed his address in capitals
  // is still the operator. Duplicates collapse.
  const raw = `\n ${OPERATOR_ID.toUpperCase()} , Owner@FleetViewCompliance.com;\towner@fleetviewcompliance.com \n`
  const list = parseOperators(raw)
  assert.deepEqual(list.ids, [OPERATOR_ID])
  assert.deepEqual(list.emails, ['owner@fleetviewcompliance.com'])

  assert.equal(isOperator({ id: OPERATOR_ID.toUpperCase(), emailConfirmed: true }, raw), true)
  assert.equal(
    isOperator(
      { id: CARRIER_ID, email: ' OWNER@fleetviewcompliance.com ', emailConfirmed: true },
      raw,
    ),
    true,
  )
})

test('an unreadable environment admits nobody', async () => {
  // isOperatorRequest wraps the environment read in a catch that answers NO.
  // Here the variable is simply absent, which is the same thing from the
  // gate's point of view.
  const before = process.env[OPERATOR_ENV_KEY]
  delete process.env[OPERATOR_ENV_KEY]
  try {
    assert.equal(await isOperatorRequest(operatorById), false)
    assert.equal(await isOperatorRequest(carrier), false)

    process.env[OPERATOR_ENV_KEY] = OPERATOR_ID
    assert.equal(await isOperatorRequest(operatorById), true)
    assert.equal(await isOperatorRequest(carrier), false)

    // And the reader itself finds the value, so the two assertions above are
    // not both passing because nothing is ever read at all.
    const env = await adminEnv()
    assert.equal(env(OPERATOR_ENV_KEY), OPERATOR_ID)
  } finally {
    if (before === undefined) delete process.env[OPERATOR_ENV_KEY]
    else process.env[OPERATOR_ENV_KEY] = before
  }
})

// ------------------------------- 3. the refusal does not reveal the route

test('the refusal is the response an unknown route gives, and nothing more', () => {
  const refusal = notFound()
  // Astro answers a route that does not exist with `new Response(null, { status:
  // 404 })`. Anything else here — a 403, a body, a location, a word — is a
  // confirmation that the path guessed is real.
  assert.equal(refusal.status, 404)
  assert.equal(refusal.body, null, 'a body distinguishes the refusal from a missing page')
  assert.equal(refusal.redirected, false)

  assert.deepEqual([...refusal.headers.keys()], [], 'a header distinguishes the refusal')

  const missingRoute = new Response(null, { status: 404 })
  assert.equal(refusal.status, missingRoute.status)
  assert.equal(refusal.statusText, missingRoute.statusText)
  assert.deepEqual([...refusal.headers.entries()], [...missingRoute.headers.entries()])
})

test('the refusal carries no words at all', async () => {
  // Read rather than assumed: a body added later — "not allowed", "admin" — is
  // the leak this whole file exists to prevent, and `body === null` above would
  // still pass for an empty string.
  assert.equal(await notFound().text(), '')
})

// ------------------------------------------ where the gate sits in the request

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const read = (path: string) => readFileSync(`${SRC}/${path}`, 'utf8')

/** Code with the comments taken out — every note below quotes what it forbids. */
function code(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

test('the middleware refuses admin paths before anything that announces them', () => {
  const body = code(read('middleware.ts'))

  const gate = body.indexOf('if (ADMIN.test(pathname)) {')
  const notFoundCall = body.indexOf('return notFound()')
  const loginRedirect = body.indexOf('/login?next=')
  const setupRedirect = body.indexOf("context.redirect('/app/setup')")

  assert.ok(gate > 0, 'the /app/admin gate is gone from the middleware')
  assert.ok(notFoundCall > gate, 'the gate no longer answers with a bare 404')

  // BOTH of these announce the route. A redirect to /login?next=/app/admin/claims
  // tells a signed-out stranger the path is real; a redirect to /app/setup tells
  // a signed-in one the same. A route that does not exist gets neither, because
  // Astro matches routes before middleware runs at all.
  assert.ok(
    gate < loginRedirect,
    'the operator gate sits below the login redirect, which announces the route',
  )
  assert.ok(
    gate < setupRedirect,
    'the operator gate sits below the /app/setup redirect, which announces the route',
  )

  // The carrier redirect is skipped for admin paths as well — an operator who
  // has never set a carrier up must not be marched through onboarding, and the
  // redirect itself is the announcement above.
  assert.match(body, /pathname !== '\/app\/setup' && !ADMIN\.test\(pathname\)/)
})

test('the stray auth-code rescue cannot be used to probe for the route', () => {
  const body = code(read('middleware.ts'))

  // That redirect fires BEFORE any identity is known. Left applying to admin
  // paths, `/app/admin/claims?code=<uuid>` answers a stranger with a 303 while
  // `/app/not-a-page?code=<uuid>` answers 404 — the existence of the page, for
  // the price of a query parameter.
  const rescue = body.indexOf('/auth/callback?code=')
  const exemption = body.indexOf('!ADMIN.test(pathname)')

  assert.ok(rescue > 0, 'the stray-code rescue is gone; this test needs rewriting')
  assert.ok(exemption > 0, 'the admin subtree is no longer exempt from the stray-code rescue')
  assert.ok(exemption < rescue, 'the exemption is not part of the rescue condition any more')
})

test('the admin page decides access before it touches the privileged key', () => {
  const body = code(read('pages/app/admin/claims.astro'))

  const gate = body.indexOf('isOperator(')
  const refuse = body.indexOf('notFound()')
  const key = body.indexOf('SUPABASE_SECRET_KEY')
  const client = body.indexOf('createClient(')

  assert.ok(gate > 0, 'the page no longer checks for itself')
  assert.ok(refuse > gate, 'the page no longer refuses with the bare 404')

  // The service-role key bypasses RLS completely, so the ONLY thing standing
  // between a request and every carrier's claims is that this ordering holds.
  assert.ok(gate < key, 'the page reads SUPABASE_SECRET_KEY before deciding who is asking')
  assert.ok(refuse < client, 'the page builds the service-role client before refusing')
})

test('the admin page reads across carriers and writes nothing', () => {
  const body = code(read('pages/app/admin/claims.astro'))

  // Read-only for this pass. Granting a carrier to a user is a much bigger
  // decision than a list, and a POST handler here is where that decision would
  // arrive by accident.
  assert.doesNotMatch(body, /<form/i, 'the admin page grew a form')
  assert.doesNotMatch(body, /\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/, 'it writes')
  assert.doesNotMatch(body, /export const (POST|PUT|PATCH|DELETE)/, 'it grew a write endpoint')

  // The peppered hash is the one column 0021 keeps from the claimant's own
  // grant. The service key can read it; no page may put it on a screen.
  assert.doesNotMatch(body, /code_hash/, 'the page selects the code hash')

  // Zero client JavaScript, like every other screen in this app.
  assert.doesNotMatch(body, /<script|client:|onclick=/i, 'the admin page ships JavaScript')
})

test('nothing reads the environment by a computed import.meta.env key', () => {
  // The same rule tests/env-inlining.test.ts enforces over the whole tree,
  // asserted here too because these two files are new and both read secrets:
  // a computed key inlines every value the build machine carried, and
  // SUPABASE_SECRET_KEY is one of them.
  for (const path of ['lib/admin/operators.ts', 'pages/app/admin/claims.astro']) {
    for (const match of code(read(path)).matchAll(/import\.meta\.env\s*(.?)/g)) {
      assert.equal(match[1], '.', `${path} indexes import.meta.env by something other than a name`)
    }
  }
  assert.match(code(read('lib/admin/operators.ts')), /await import\('cloudflare:workers'\)/)
  assert.match(code(read('lib/admin/operators.ts')), /process\.env/)
})
