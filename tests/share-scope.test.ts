/**
 * What a proof token buys.
 *
 * A share token is an unauthenticated credential handed to a stranger, so these
 * assertions run as the real `anon` role against the real functions. Scope is
 * enforced in SQL precisely so that no arrangement of page code can widen it —
 * and that claim is only worth anything if it is tested here rather than in the
 * page.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type pg from 'pg'
import { hashProofToken, newProofToken } from '../src/lib/proof/token.ts'
import {
  actAs,
  actAsAnon,
  actAsOwner,
  attempt,
  configured,
  makeUser,
  queryAsOwner,
  withRollback,
} from './helpers.ts'

async function carrierWithLinks(c: pg.Client, name: string, dot: string) {
  await actAsOwner(c)
  const user = await makeUser(c, `${name}-${Date.now()}@share.test`)
  await actAs(c, user)

  const { rows: cc } = await queryAsOwner(c, 'select create_carrier($1,$2) as id', [dot, name])
  const carrier = cc[0].id
  const { rows: d } = await c.query(
    `insert into drivers (carrier_id, first_name, last_name) values ($1,$2,'Driver') returning id`,
    [carrier, name],
  )
  const driver = d[0].id

  await c.query(
    `insert into compliance_records (carrier_id, subject_type, subject_id, anchor_key, occurred_on)
     values ($1,'driver',$2,'medical_certificate_expires','2027-06-01')`,
    [carrier, driver],
  )
  await c.query(
    `insert into compliance_records (carrier_id, subject_type, subject_id, anchor_key, occurred_on)
     values ($1,'carrier',$1,'ucr_paid_through','2026-12-31')`,
    [carrier],
  )

  // Real tokens hashed by the real application function, because that is the
  // only way a link is written since 0026 — the page never stores the token.
  // If hashProofToken() and the SQL share_token_hash() ever disagreed, every
  // assertion in this file would fail at once, which is the point.
  const link = async (scope: string, subject: string | null, interval: string) => {
    const token = newProofToken()
    await c.query(
      `insert into share_links (carrier_id, token_hash, scope, subject_id, expires_at)
       values ($1,$2,$3::share_scope,$4, now() + $5::interval)`,
      [carrier, await hashProofToken(token), scope, subject, interval],
    )
    return token
  }

  const file = await link('driver_file', driver, '30 days')
  const summary = await link('carrier_summary', null, '30 days')
  const expired = await link('carrier_summary', null, '-1 day')

  const revoked = newProofToken()
  await c.query(
    `insert into share_links (carrier_id, token_hash, scope, expires_at, revoked_at)
     values ($1,$2,'carrier_summary', now() + interval '30 days', now())`,
    [carrier, await hashProofToken(revoked)],
  )

  await actAsOwner(c)
  return { carrier, driver, file, summary, expired, revoked }
}

const call = async (c: pg.Client, fn: string, token: string) =>
  (await c.query(`select * from ${fn}($1)`, [token])).rows

describe('share token scope', { skip: !configured() }, () => {
  test('a driver_file token reads that driver and nothing wider', async () => {
    await withRollback(async (c) => {
      const a = await carrierWithLinks(c, 'ALPHA', `91${Date.now() % 100000}`)
      await actAsAnon(c)

      const driver = await call(c, 'share_driver', a.file)
      assert.equal(driver.length, 1)
      assert.equal(driver[0].id, a.driver)

      const anchors = await call(c, 'share_anchors', a.file)
      assert.ok(anchors.length > 0)
      assert.ok(
        anchors.every((r: { subject_type: string }) => r.subject_type === 'driver'),
        'a driver_file token must not return carrier-level anchors',
      )

      // Wrong scope: fleet counts belong to a carrier summary.
      assert.equal((await call(c, 'share_fleet_counts', a.file)).length, 0)
    })
  })

  test('a carrier_summary token can never reach a driver', async () => {
    await withRollback(async (c) => {
      const a = await carrierWithLinks(c, 'BRAVO', `92${Date.now() % 100000}`)
      await actAsAnon(c)

      assert.equal(
        (await call(c, 'share_driver', a.summary)).length,
        0,
        'a summary token must not read a driver row even though one exists',
      )
      const anchors = await call(c, 'share_anchors', a.summary)
      assert.ok(
        anchors.every((r: { subject_type: string }) => r.subject_type === 'carrier'),
        'a summary token must not return any driver anchor',
      )
      assert.equal((await call(c, 'share_fleet_counts', a.summary)).length, 1)
    })
  })

  test('expired, revoked and invented tokens all return nothing', async () => {
    await withRollback(async (c) => {
      const a = await carrierWithLinks(c, 'CHARLIE', `93${Date.now() % 100000}`)
      await actAsAnon(c)

      for (const [label, token] of [
        ['expired', a.expired],
        ['revoked', a.revoked],
        ['invented', 'definitely-not-a-real-token'],
      ] as const) {
        for (const fn of ['share_carrier', 'share_driver', 'share_anchors', 'share_fleet_counts']) {
          assert.equal((await call(c, fn, token)).length, 0, `${fn} leaked to a ${label} token`)
        }
        assert.equal(
          (await call(c, 'resolve_share_token', token)).length,
          0,
          `resolve_share_token accepted a ${label} token`,
        )
      }
    })
  })

  test("one carrier's token cannot reach another carrier", async () => {
    await withRollback(async (c) => {
      const a = await carrierWithLinks(c, 'DELTA', `94${Date.now() % 100000}`)
      const b = await carrierWithLinks(c, 'ECHO', `95${Date.now() % 100000}`)
      await actAsAnon(c)

      const carrier = await call(c, 'share_carrier', a.summary)
      assert.equal(carrier.length, 1)
      assert.equal(carrier[0].legal_name, 'DELTA', 'the token must resolve to its own carrier')

      const driver = await call(c, 'share_driver', a.file)
      assert.equal(driver.length, 1)
      assert.notEqual(driver[0].id, b.driver)
    })
  })

  test('anon still cannot read the underlying tables directly', async () => {
    // The functions are the ONLY door. If this ever passes, the revoke has been
    // undone somewhere and the whole scoping argument collapses.
    await withRollback(async (c) => {
      await carrierWithLinks(c, 'FOXTROT', `96${Date.now() % 100000}`)
      await actAsAnon(c)
      for (const t of ['carriers', 'drivers', 'compliance_records']) {
        const n = await c
          .query(`select count(*)::int as n from ${t}`)
          .then((r) => r.rows[0].n)
          .catch(() => -1)
        assert.equal(
          n,
          -1,
          `anon can read ${t} directly — the functions are no longer the only door`,
        )
      }
    })
  })
})

/**
 * How the token is STORED, which is a different question from what it buys.
 *
 * 0013 kept the token in plain text, so every row was a working, login-free link
 * into a carrier's compliance file for anybody who could read the table.
 * 0026_share_token_hash.sql replaced it with sha256(token), hashed inside the
 * SECURITY DEFINER functions so that the stored value is never itself a
 * credential. These tests exist to prove the two things that could have gone
 * wrong: that the fix broke links people are already holding, and that the
 * plaintext is merely unused rather than actually gone.
 */
describe('share token storage', { skip: !configured() }, () => {
  test('a link made before the migration still opens', async () => {
    // The migration backfilled every existing row with share_token_hash(token)
    // while the plaintext was still there. This reproduces exactly that row —
    // including a token in the old free-form shape, which is what the real rows
    // and the pre-0026 fixtures held — and then opens it through the shipped
    // anonymous path. A carrier who gave a broker a link last month must not
    // have to send a new one.
    await withRollback(async (c) => {
      const a = await carrierWithLinks(c, 'GOLF', `97${Date.now() % 100000}`)
      const legacy = `sum-GOLF-${Date.now()}`
      await c.query(
        `insert into share_links (carrier_id, token_hash, scope, expires_at)
         values ($1, share_token_hash($2), 'carrier_summary', now() + interval '30 days')`,
        [a.carrier, legacy],
      )

      await actAsAnon(c)
      const resolved = await call(c, 'resolve_share_token', legacy)
      assert.equal(resolved.length, 1, 'a token that worked before the migration must still work')
      assert.equal(resolved[0].carrier_id, a.carrier)
      assert.equal((await call(c, 'share_carrier', legacy)).length, 1)
    })
  })

  test('a wrong token, a revoked one and an expired one all resolve to nothing', async () => {
    await withRollback(async (c) => {
      const a = await carrierWithLinks(c, 'HOTEL', `98${Date.now() % 100000}`)
      // One character different. Hashing turns a near-miss into an unrelated
      // digest, so there is nothing for a partial match to leak.
      const nearMiss = `${a.summary.slice(0, -1)}${a.summary.endsWith('A') ? 'B' : 'A'}`

      await actAsAnon(c)
      for (const [label, token] of [
        ['a token off by one character', nearMiss],
        ['a revoked link', a.revoked],
        ['an expired link', a.expired],
        ['an invented token', 'definitely-not-a-real-token'],
      ] as const) {
        assert.equal((await call(c, 'resolve_share_token', token)).length, 0, `${label} resolved`)
        assert.equal((await call(c, 'share_carrier', token)).length, 0, `${label} read a carrier`)
      }
      // The one that must still work, so the four refusals above are not simply
      // a broken lookup agreeing with itself.
      assert.equal((await call(c, 'resolve_share_token', a.summary)).length, 1)
    })
  })

  test('a view is counted for a working link and for nothing else', async () => {
    // record_share_view was rewritten by the same migration and is the one
    // function the scope tests above never call. The owner's question is "did
    // the broker open it", so a count that stopped moving would be a silent
    // wrong answer rather than a visible failure.
    await withRollback(async (c) => {
      const a = await carrierWithLinks(c, 'KILO', `88${Date.now() % 100000}`)

      await actAsAnon(c)
      for (const token of [a.summary, a.revoked, a.expired, 'not-a-token']) {
        await c.query('select record_share_view($1)', [token])
      }

      await actAsOwner(c)
      const views = async (token: string) =>
        (
          await c.query(
            'select view_count from share_links where token_hash = share_token_hash($1)',
            [token],
          )
        ).rows[0].view_count

      assert.equal(await views(a.summary), 1, 'a working link did not count the view')
      assert.equal(await views(a.revoked), 0, 'a revoked link counted a view')
      assert.equal(await views(a.expired), 0, 'an expired link counted a view')
    })
  })

  test('the plaintext token is nowhere in the table', async () => {
    await withRollback(async (c) => {
      const a = await carrierWithLinks(c, 'INDIA', `99${Date.now() % 100000}`)
      await actAsOwner(c)

      // The column is dropped, not merely unused. A column that still exists is
      // a column in every backup taken from here on.
      const { rows: cols } = await c.query(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'share_links'`,
      )
      const names = cols.map((r: { column_name: string }) => r.column_name)
      assert.ok(!names.includes('token'), 'share_links.token still exists')
      assert.ok(names.includes('token_hash'), 'share_links.token_hash is missing')

      // And the value itself appears in no column of the row, whatever it is
      // called. The whole row is rendered to text and searched.
      const { rows } = await c.query(
        `select s::text as whole_row, s.token_hash from share_links s
          where s.carrier_id = $1 and s.token_hash = share_token_hash($2)`,
        [a.carrier, a.summary],
      )
      assert.equal(rows.length, 1, 'the link under test was not found by its hash')
      assert.ok(
        !rows[0].whole_row.includes(a.summary),
        'the token is still readable somewhere in the row',
      )
      assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/)
    })
  })

  test('the hash column cannot be made to hold a plaintext token', async () => {
    // The check constraint is the second pair of eyes, the same guard 0021 puts
    // on carrier_claims.code_hash: a 43-character base64url token cannot pass
    // for 64 hex characters, so no mistake in page code can put one back.
    await withRollback(async (c) => {
      const a = await carrierWithLinks(c, 'JULIET', `90${Date.now() % 100000}`)
      await actAsOwner(c)
      const err = await attempt(
        c,
        `insert into share_links (carrier_id, token_hash, scope, expires_at)
         values ($1, $2, 'carrier_summary', now() + interval '30 days')`,
        [a.carrier, newProofToken()],
      )
      assert.ok(err, 'a raw token was accepted into token_hash')
      assert.match(String(err?.message), /token_hash_shape/)
    })
  })

  test('the application and the database compute the same digest', async () => {
    // Two implementations of one hash: hashProofToken() writes the column and
    // share_token_hash() reads it. If they ever drift, every link in the product
    // stops working at the same moment, so the agreement is asserted rather than
    // assumed.
    await withRollback(async (c) => {
      await actAsOwner(c)
      for (let i = 0; i < 20; i++) {
        const token = newProofToken()
        const { rows } = await c.query('select share_token_hash($1) as h', [token])
        assert.equal(rows[0].h, await hashProofToken(token))
      }
      // A known answer, so this is anchored to SHA-256 itself and not just to
      // the two implementations agreeing with each other.
      const abc = await c.query(`select share_token_hash('abc') as h`)
      assert.equal(
        abc.rows[0].h,
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      )

      // UTF-8 bytes on both sides. This is the case a latin1 conversion in SQL
      // would get wrong while every ASCII token kept passing.
      const text = 'ünïcode-Ω'
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
      const expected = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      const utf8 = await c.query('select share_token_hash($1) as h', [text])
      assert.equal(utf8.rows[0].h, expected)
    })
  })

  test('share_token_hash is not published as an RPC', async () => {
    // PostgREST publishes every function in this schema. This one is public
    // arithmetic with no caller outside the definer functions, so an RPC for it
    // is surface for nobody.
    await withRollback(async (c) => {
      await actAsAnon(c)
      const asAnon = await attempt(c, `select share_token_hash('x')`)
      assert.ok(asAnon, 'anon can call share_token_hash')
      assert.match(String(asAnon?.message), /permission denied/i)

      await actAsOwner(c)
      const user = await makeUser(c, `hash-${Date.now()}@share.test`)
      await actAs(c, user)
      const asUser = await attempt(c, `select share_token_hash('x')`)
      assert.ok(asUser, 'a signed-in user can call share_token_hash')
      assert.match(String(asUser?.message), /permission denied/i)
    })
  })
})
