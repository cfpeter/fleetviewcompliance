/**
 * Clickwrap evidence.
 *
 * Two halves. The pure half proves that what is shown and what is stored are
 * the same thing and that a missing header never becomes an invented value. The
 * database half proves the properties that make the row worth anything in a
 * dispute: nobody can change it, nobody can remove it, the timestamp is the
 * server's, and the version is recorded.
 *
 * The database half runs against the real database, because a mocked one proves
 * nothing about a trigger or a grant. A skip is reported loudly: if it does not
 * run, none of the append-only claims in 0025 have been demonstrated.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { EFFECTIVE_DATE } from '../src/lib/legal.ts'
import { notice } from '../src/lib/onboarding.ts'
import {
  ASSENT,
  ASSENT_TEXT,
  assentCanonical,
  assentDigest,
  clientIp,
  clientUserAgent,
  recordTermsAcceptance,
  TERMS_VERSION,
  ticked,
  USER_AGENT_MAX,
  versionFromEffectiveDate,
} from '../src/lib/terms.ts'
import {
  actAs,
  actAsAnon,
  actAsOwner,
  attempt,
  configured,
  makeUser,
  withRollback,
} from './helpers.ts'

// ------------------------------------------------------------------ version

test('the printed effective date becomes a sortable version', () => {
  assert.equal(versionFromEffectiveDate('16 September 2026'), '2026-09-16')
  assert.equal(versionFromEffectiveDate('1 January 2027'), '2027-01-01')
  assert.equal(versionFromEffectiveDate('  7 March 2028 '), '2028-03-07')
})

test('versions sort in the order the documents were issued', () => {
  // The whole reason for ISO rather than the printed form: as text, '16
  // September 2026' sorts before '2 January 2027', so "which one is newer"
  // answers wrongly on the printed form.
  const printed = ['16 September 2026', '2 January 2027']
  const versions = printed.map(versionFromEffectiveDate)
  assert.deepEqual([...versions].sort(), versions)
})

test('an unparseable date is still a usable version, never an exception', () => {
  // This runs on the signup path. Throwing here refuses to record an acceptance
  // because somebody typed a date oddly, which is the worst possible trade.
  assert.equal(versionFromEffectiveDate('16 Septiembre 2026'), '16 Septiembre 2026')
  assert.equal(versionFromEffectiveDate('2026-09-16'), '2026-09-16')
  assert.equal(versionFromEffectiveDate(''), '')
  assert.equal(versionFromEffectiveDate(null), '')
  assert.equal(versionFromEffectiveDate(undefined), '')
  assert.equal(versionFromEffectiveDate('32 September 2026'), '32 September 2026')
})

test('the stored version is DERIVED from legal.ts, not a second copy of the date', () => {
  // If somebody ever pastes a literal in place of the derivation, the two stop
  // agreeing the first time EFFECTIVE_DATE moves — and the value that goes
  // stale is the one in the evidence table, not the one on the page.
  assert.equal(TERMS_VERSION, versionFromEffectiveDate(EFFECTIVE_DATE))
  assert.notEqual(TERMS_VERSION, '')
  assert.match(
    TERMS_VERSION,
    /^\d{4}-\d{2}-\d{2}$/,
    `EFFECTIVE_DATE ${EFFECTIVE_DATE} no longer parses`,
  )
})

// ------------------------------------------------------------------- assent

test('the sentence beside the checkbox is short, plain and names both documents', () => {
  assert.equal(ASSENT_TEXT, 'I agree to the Terms and the Privacy Policy.')
  // Many of these customers do not read English easily. Long is not the enemy
  // of clarity by itself, but a paragraph beside a checkbox always is.
  assert.ok(ASSENT_TEXT.split(/\s+/).length <= 10, ASSENT_TEXT)
  // It has to remain an AGREEMENT, not a notification.
  assert.match(ASSENT_TEXT, /\bI agree\b/)
})

test('the hashed sentence is assembled from the same parts the page renders', () => {
  // The page renders ASSENT.terms and ASSENT.privacy as link text. If the
  // sentence that gets hashed were written out separately, an edit to the page
  // would silently stop matching the evidence.
  assert.equal(
    ASSENT_TEXT,
    `${ASSENT.lead} ${ASSENT.terms} ${ASSENT.join} ${ASSENT.privacy}${ASSENT.stop}`,
  )
  assert.equal(ASSENT.termsHref, '/terms')
  assert.equal(ASSENT.privacyHref, '/privacy')
})

test('the refusal tells a non-fluent reader exactly what to do', () => {
  const text = notice('terms_required')?.text ?? ''
  assert.equal(notice('terms_required')?.tone, 'error')
  assert.match(text, /Terms/)
  assert.match(text, /Privacy Policy/)
  assert.ok(text.split(/\s+/).length <= 14, text)
})

// -------------------------------------------------------------------- tick

test('an absent checkbox is a refusal, and so is a value that says no', () => {
  // An unticked checkbox sends nothing at all, so null is the common case.
  assert.equal(ticked(null), false)
  assert.equal(ticked(undefined), false)
  assert.equal(ticked(''), false)
  assert.equal(ticked('no'), false)
  assert.equal(ticked('false'), false)
  assert.equal(ticked('0'), false)
})

test('the values a browser can actually send count as agreement', () => {
  assert.equal(ticked('yes'), true)
  assert.equal(ticked('on'), true)
  assert.equal(ticked('YES'), true)
  assert.equal(ticked(' yes '), true)
  assert.equal(ticked('true'), true)
  assert.equal(ticked('1'), true)
})

// ------------------------------------------------------------------ digest

test('the digest is hex sha-256 and covers the version and both links', async () => {
  const d = await assentDigest('2026-09-16')
  assert.match(d ?? '', /^[0-9a-f]{64}$/)
  assert.equal(await assentDigest('2026-09-16'), d)

  const canonical = assentCanonical('2026-09-16')
  assert.ok(canonical.includes('2026-09-16'))
  assert.ok(canonical.includes('/terms'))
  assert.ok(canonical.includes('/privacy'))
  assert.ok(canonical.includes(ASSENT_TEXT))
})

test('a different version is a different digest', async () => {
  // Otherwise the hash proves nothing about WHICH documents were accepted.
  assert.notEqual(await assentDigest('2026-09-16'), await assentDigest('2027-01-01'))
})

// ------------------------------------------------------ reading the request

const h = (init: Record<string, string>) => new Headers(init)

test('the address comes from CF-Connecting-IP', () => {
  assert.equal(clientIp(h({ 'CF-Connecting-IP': '203.0.113.9' })), '203.0.113.9')
  assert.equal(clientIp(h({ 'cf-connecting-ip': '2001:db8::1' })), '2001:db8::1')
  assert.equal(clientIp(h({ 'CF-Connecting-IP': ' 198.51.100.4 ' })), '198.51.100.4')
})

test('X-Forwarded-For is never read, not even as a fallback', () => {
  // THE POINT OF THIS FILE. X-Forwarded-For is a list the client can prepend
  // to, so falling back to it means the address in an evidence table is a value
  // typed by the person being evidenced. No address is better than a chosen one.
  assert.equal(clientIp(h({ 'X-Forwarded-For': '203.0.113.9' })), null)
  assert.equal(clientIp(h({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })), null)
  assert.equal(clientIp(h({ 'True-Client-IP': '203.0.113.9' })), null)
  // And it does not win when both are present.
  assert.equal(
    clientIp(h({ 'CF-Connecting-IP': '198.51.100.4', 'X-Forwarded-For': '203.0.113.9' })),
    '198.51.100.4',
  )
})

test('a missing or malformed address is null, never a stand-in', () => {
  // Local development has no Cloudflare in front of the Worker, so this is the
  // everyday case rather than an edge one. '127.0.0.1' or 'unknown' here would
  // be a fabricated exhibit in the one table that exists to be believed.
  assert.equal(clientIp(h({})), null)
  assert.equal(clientIp(h({ 'CF-Connecting-IP': '' })), null)
  assert.equal(clientIp(h({ 'CF-Connecting-IP': '   ' })), null)
  assert.equal(clientIp(h({ 'CF-Connecting-IP': 'unknown' })), null)
  assert.equal(clientIp(h({ 'CF-Connecting-IP': '999.1.1.1' })), null)
  assert.equal(clientIp(h({ 'CF-Connecting-IP': '203.0.113.9; drop table' })), null)
})

test('an over-long user agent is cut to the column rather than failing the insert', () => {
  assert.equal(clientUserAgent(h({})), null)
  assert.equal(clientUserAgent(h({ 'User-Agent': '   ' })), null)
  assert.equal(clientUserAgent(h({ 'User-Agent': 'Mozilla/5.0' })), 'Mozilla/5.0')

  // The column check refuses anything longer. Without the cut, a header the
  // visitor chose would abort the signup that is recording its own acceptance.
  const long = clientUserAgent(h({ 'User-Agent': 'x'.repeat(USER_AGENT_MAX + 500) }))
  assert.equal(long?.length, USER_AGENT_MAX)
})

test('an escape sequence in a user agent is flattened, not stored', () => {
  // MEASURED, not assumed. `new Headers()` refuses only NUL, CR and LF, so a
  // real request CAN carry ESC, BEL and DEL in a user agent — which makes this
  // strip load-bearing rather than decorative. The string is read back one day
  // in a terminal, a support ticket or a court exhibit, and an escape sequence
  // rewrites what the person reading it sees.
  assert.throws(() => h({ 'User-Agent': 'a\u0000b' }), 'Headers stopped refusing NUL')

  const nasty = clientUserAgent(h({ 'User-Agent': 'Mozilla\u001b[2K\u0007evil\u007f ' }))
  assert.equal(nasty, 'Mozilla [2K evil')
})

// -------------------------------------------------------------- the rpc call

test('the recording call names no user and no time', async () => {
  // Both are read from the server inside the function. A parameter that does
  // not exist is a parameter a caller cannot forge, and this is the test that
  // notices if somebody adds one for convenience.
  let sent: Record<string, unknown> = {}
  const stub = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      assert.equal(fn, 'record_terms_acceptance')
      sent = args
      return Promise.resolve({ data: '2026-09-16T10:00:00Z', error: null })
    },
  }

  const out = await recordTermsAcceptance(stub, h({ 'CF-Connecting-IP': '203.0.113.9' }))
  assert.equal(out.recorded, true)
  assert.equal(out.acceptedAt, '2026-09-16T10:00:00Z')

  assert.deepEqual(Object.keys(sent).sort(), [
    'p_assent_digest',
    'p_document_version',
    'p_ip',
    'p_user_agent',
  ])
  assert.equal(sent.p_document_version, TERMS_VERSION)
  assert.equal(sent.p_ip, '203.0.113.9')
  assert.match(String(sent.p_assent_digest), /^[0-9a-f]{64}$/)
})

test('a failed recording is reported, not thrown', async () => {
  // The account already exists by the time this runs. Throwing would show a
  // customer an error for something that succeeded and still leave no row.
  const stub = {
    rpc: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
  }
  const out = await recordTermsAcceptance(stub, h({}))
  assert.equal(out.recorded, false)
  assert.equal(out.acceptedAt, null)
  assert.equal(out.error, 'boom')
})

// ------------------------------------------------------------- the database

if (!configured()) {
  console.error(
    '\n  ⚠  SKIPPING terms acceptance database tests: no database configured.\n' +
      '     Until these run, "append-only" is an unproven claim about evidence.\n',
  )
}

describe('terms acceptance is evidence', { skip: !configured() }, () => {
  const VERSION = '2026-09-16'

  test('an acceptance records the user, the version, the address and the browser', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const user = await makeUser(c, `terms-a-${Date.now()}@test.local`)
      await actAs(c, user)

      await c.query(`select record_terms_acceptance($1, $2, $3, $4)`, [
        VERSION,
        'a'.repeat(64),
        '203.0.113.9',
        'Mozilla/5.0 (test)',
      ])

      const { rows } = await c.query(
        `select user_id, document_version, host(ip) as ip, user_agent, assent_digest
           from terms_acceptances where user_id = $1`,
        [user],
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0].user_id, user)
      assert.equal(rows[0].document_version, VERSION)
      assert.equal(rows[0].ip, '203.0.113.9')
      assert.equal(rows[0].user_agent, 'Mozilla/5.0 (test)')
      assert.equal(rows[0].assent_digest, 'a'.repeat(64))
    })
  })

  test('the timestamp is the server clock and cannot be supplied', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const user = await makeUser(c, `terms-t-${Date.now()}@test.local`)

      // Structural: the function takes four text parameters and none of them is
      // a time or a user id. This is the guarantee; the value check below only
      // confirms it behaves the way the signature promises.
      const { rows: sig } = await c.query(
        `select pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'record_terms_acceptance'`,
      )
      assert.equal(sig.length, 1)
      assert.equal(
        sig[0].args,
        'p_document_version text, p_assent_digest text, p_ip text, p_user_agent text',
      )

      await actAs(c, user)
      await c.query(`select record_terms_acceptance($1, null, null, null)`, [VERSION])

      const { rows } = await c.query(
        `select accepted_at = now() as is_server_clock,
                accepted_at > now() - interval '1 minute' as is_recent
           from terms_acceptances where user_id = $1`,
        [user],
      )
      // now() is the transaction timestamp, so inside one transaction the
      // default is exactly it — which is the strongest form of "the server set
      // this", not an approximation.
      assert.equal(rows[0].is_server_clock, true)
      assert.equal(rows[0].is_recent, true)
    })
  })

  test('a user cannot update or delete their own acceptance', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const user = await makeUser(c, `terms-u-${Date.now()}@test.local`)
      await actAs(c, user)
      await c.query(`select record_terms_acceptance($1, null, null, null)`, [VERSION])

      const updated = await attempt(c, `update terms_acceptances set document_version = 'never'`)
      assert.ok(updated, 'a user was able to rewrite their own acceptance')

      const deleted = await attempt(c, `delete from terms_acceptances`)
      assert.ok(deleted, 'a user was able to delete their own acceptance')

      // And nothing moved.
      const { rows } = await c.query(
        `select document_version from terms_acceptances where user_id = $1`,
        [user],
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0].document_version, VERSION)
    })
  })

  test('a user cannot write an acceptance by inserting a row', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const user = await makeUser(c, `terms-i-${Date.now()}@test.local`)
      await actAs(c, user)

      const e = await attempt(
        c,
        `insert into terms_acceptances (user_id, document_version) values ($1, $2)`,
        [user, VERSION],
      )
      assert.ok(e, 'a user was able to write their own evidence directly')
    })
  })

  test('not even the owner can change or remove an acceptance', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const user = await makeUser(c, `terms-o-${Date.now()}@test.local`)
      await actAs(c, user)
      await c.query(`select record_terms_acceptance($1, null, null, null)`, [VERSION])

      // The owner bypasses RLS entirely, so this is the trigger being tested
      // rather than a policy — which is the whole reason it is a trigger.
      await actAsOwner(c)
      const updated = await attempt(
        c,
        `update terms_acceptances set ip = null where user_id = $1`,
        [user],
      )
      assert.ok(updated, 'the owner was able to edit evidence')
      assert.match(String(updated?.message), /cannot be changed/)

      const deleted = await attempt(c, `delete from terms_acceptances where user_id = $1`, [user])
      assert.ok(deleted, 'the owner was able to delete evidence')
      assert.match(String(deleted?.message), /cannot be deleted/)
    })
  })

  test('closing the account is the only thing that removes the row', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const user = await makeUser(c, `terms-c-${Date.now()}@test.local`)
      await actAs(c, user)
      await c.query(`select record_terms_acceptance($1, null, null, null)`, [VERSION])

      // Without this the foreign key cascade would raise and an account could
      // never be deleted at all, which is a worse promise than "we keep this
      // while you are a customer".
      await actAsOwner(c)
      await c.query(`delete from profiles where id = $1`, [user])
      const { rows } = await c.query(
        `select count(*)::int as n from terms_acceptances where user_id = $1`,
        [user],
      )
      assert.equal(rows[0].n, 0)
    })
  })

  test('recording twice keeps the first acceptance', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const user = await makeUser(c, `terms-d-${Date.now()}@test.local`)
      await actAs(c, user)

      await c.query(`select record_terms_acceptance($1, $2, $3, $4)`, [
        VERSION,
        'a'.repeat(64),
        '203.0.113.9',
        'first',
      ])
      await c.query(`select record_terms_acceptance($1, $2, $3, $4)`, [
        VERSION,
        'b'.repeat(64),
        '198.51.100.1',
        'second',
      ])

      const { rows } = await c.query(
        `select user_agent, host(ip) as ip from terms_acceptances where user_id = $1`,
        [user],
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0].user_agent, 'first')
      assert.equal(rows[0].ip, '203.0.113.9')
    })
  })

  test('a new version is a new row beside the old one', async () => {
    // This is the whole re-acceptance mechanism: nothing in the schema has to
    // change when the documents are revised.
    await withRollback(async (c) => {
      await actAsOwner(c)
      const user = await makeUser(c, `terms-v-${Date.now()}@test.local`)
      await actAs(c, user)

      await c.query(`select record_terms_acceptance($1, null, null, null)`, [VERSION])
      await c.query(`select record_terms_acceptance($1, null, null, null)`, ['2027-01-01'])

      const { rows } = await c.query(
        `select document_version from terms_acceptances
          where user_id = $1 order by document_version`,
        [user],
      )
      assert.deepEqual(
        rows.map((r) => r.document_version),
        [VERSION, '2027-01-01'],
      )
    })
  })

  test('an unknown address is stored as null rather than failing the signup', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const user = await makeUser(c, `terms-n-${Date.now()}@test.local`)
      await actAs(c, user)

      // What local development sends: no header, so no address.
      await c.query(`select record_terms_acceptance($1, null, null, null)`, [VERSION])
      // And what a malformed one must not do: abort the account creation.
      await c.query(`select record_terms_acceptance($1, null, $2, null)`, [
        '2027-01-01',
        'not-an-address',
      ])

      const { rows } = await c.query(
        `select count(*)::int as n from terms_acceptances where user_id = $1 and ip is null`,
        [user],
      )
      assert.equal(rows[0].n, 2)
    })
  })

  test('one person cannot see another account’s acceptance', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const alice = await makeUser(c, `terms-alice-${Date.now()}@test.local`)
      const bob = await makeUser(c, `terms-bob-${Date.now()}@test.local`)

      await actAs(c, alice)
      await c.query(`select record_terms_acceptance($1, null, $2, null)`, [VERSION, '203.0.113.9'])

      await actAs(c, bob)
      const { rows } = await c.query(`select count(*)::int as n from terms_acceptances`)
      assert.equal(rows[0].n, 0)
    })
  })

  test('a signed-out visitor can neither record nor read an acceptance', async () => {
    await withRollback(async (c) => {
      await actAsAnon(c)
      // An anon-callable recording function would have to take a user id, and
      // the publishable key is in the browser bundle — that is an acceptance
      // anybody can write in a stranger's name.
      assert.ok(
        await attempt(c, `select record_terms_acceptance($1, null, null, null)`, [VERSION]),
        'anon could record an acceptance',
      )
      assert.ok(
        await attempt(c, `select count(*) from terms_acceptances`),
        'anon could read acceptances',
      )
    })
  })
})
