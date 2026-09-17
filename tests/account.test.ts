/**
 * The database half of "let the owner manage his own account" (migration 0027).
 *
 * Two facts are under test and both of them are security-shaped:
 *
 *   carrier_members()   a SECURITY DEFINER function that hands out other
 *                       people's names and email addresses. RLS is BYPASSED
 *                       inside it, so the membership check in its body is the
 *                       only thing between a caller and another carrier's
 *                       contact list. If that check is wrong, nothing else
 *                       catches it.
 *
 *   the email mirror    `profiles.email` is what the morning digest sends to,
 *                       and `auth.users.email` is what the person signs in
 *                       with. If they drift, the product detects a deadline
 *                       correctly and mails it to an address he stopped
 *                       reading — which is the worst failure this application
 *                       has, because it looks exactly like a quiet week.
 *
 * As everywhere else in this suite, the assertions run as real Postgres roles
 * with real JWT claims against the real policies. A skip proves nothing.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  actAs,
  actAsOwner,
  attempt,
  configured,
  makeCarrier,
  makeUser,
  queryAsOwner,
  withRollback,
} from './helpers.ts'

if (!configured()) {
  console.error(
    '\n  ⚠  SKIPPING account tests: no database configured.\n' +
      '     Set SUPABASE_DB_* in .env. Until these run, carrier_members() is UNPROVEN.\n',
  )
}

describe('who can sign in, and the email they sign in with', { skip: !configured() }, () => {
  /**
   * One carrier with two people on it, and a second carrier owned by a
   * stranger. Two members matter: with one, a function that ignored its
   * argument entirely would still look correct.
   */
  async function fixture(c: Parameters<Parameters<typeof withRollback>[0]>[0]) {
    await actAsOwner(c)
    const stamp = Date.now()
    const owner = await makeUser(c, `acct-owner-${stamp}@test.local`)
    const staff = await makeUser(c, `acct-staff-${stamp}@test.local`)
    const stranger = await makeUser(c, `acct-stranger-${stamp}@test.local`)

    await actAs(c, owner)
    const carrier = await makeCarrier(c, `8${stamp % 1000000}`, 'ACCOUNT TEST')
    await actAs(c, stranger)
    const otherCarrier = await makeCarrier(c, `9${stamp % 1000000}`, 'OTHER ACCOUNT')

    // `authenticated` has no INSERT on memberships by design (0001) — the only
    // way onto a carrier is the USDOT claim — so the fixture borrows the
    // owner's grant for exactly this one statement rather than granting the
    // role something the product does not give it.
    await queryAsOwner(
      c,
      `insert into memberships (user_id, carrier_id, role) values ($1, $2, 'staff')`,
      [staff, carrier],
    )
    await queryAsOwner(c, `update profiles set full_name = 'Staff Person' where id = $1`, [staff])

    return { owner, staff, stranger, carrier, otherCarrier }
  }

  test('a member sees everyone on his carrier, with their role', async () => {
    await withRollback(async (c) => {
      const { owner, staff, carrier } = await fixture(c)
      await actAs(c, owner)

      const { rows } = await c.query(
        'select user_id, full_name, email, role from carrier_members($1) order by role',
        [carrier],
      )

      // EXACTLY two. One would mean the join dropped somebody; three would mean
      // the carrier filter is not filtering.
      assert.equal(rows.length, 2)
      const byId = new Map(rows.map((r) => [r.user_id, r]))
      assert.equal(byId.get(owner)?.role, 'owner')
      assert.equal(byId.get(staff)?.role, 'staff')
      // The name and address come from `profiles`, which the caller's own RLS
      // would never have let them read for anybody but themselves. That is the
      // entire reason this function exists.
      assert.equal(byId.get(staff)?.full_name, 'Staff Person')
      assert.match(String(byId.get(staff)?.email), /^acct-staff-/)
    })
  })

  test('a colleague is invisible through the tables themselves', async () => {
    await withRollback(async (c) => {
      const { owner, carrier } = await fixture(c)
      await actAs(c, owner)

      // The point of the function is that it is the ONLY opening. If either
      // policy had been widened instead, these two counts would be 2 and the
      // narrow disclosure would be pointless.
      const profiles = await c.query('select count(*)::int as n from profiles')
      assert.equal(profiles.rows[0].n, 1)
      const memberships = await c.query('select count(*)::int as n from memberships')
      assert.equal(memberships.rows[0].n, 1)

      // And the function still answers, over the same connection, for the same
      // person. Nothing above is a session that lost its claims.
      const members = await c.query('select count(*)::int as n from carrier_members($1)', [carrier])
      assert.equal(members.rows[0].n, 2)
    })
  })

  test("a stranger cannot read another carrier's members", async () => {
    await withRollback(async (c) => {
      const { stranger, carrier } = await fixture(c)
      await actAs(c, stranger)

      const failure = await attempt(c, 'select * from carrier_members($1)', [carrier])
      assert.ok(failure, 'a non-member read another carrier and was allowed to')
      // 42501 insufficient_privilege, not an empty result: "you are not a
      // member" must never render as "this carrier has nobody on it".
      assert.equal((failure as { code?: string }).code, '42501')
    })
  })

  test('a null carrier id is refused rather than treated as "all of them"', async () => {
    await withRollback(async (c) => {
      const { owner } = await fixture(c)
      await actAs(c, owner)

      const failure = await attempt(c, 'select * from carrier_members($1)', [null])
      assert.ok(failure, 'a null carrier id was not refused')
      assert.equal((failure as { code?: string }).code, '42501')
    })
  })

  test('changing the sign-in email moves the address the digest sends to', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const stamp = Date.now()
      const user = await makeUser(c, `mirror-old-${stamp}@test.local`)

      // The signup trigger from 0001 put the original address on the profile.
      const before = await c.query('select email from profiles where id = $1', [user])
      assert.equal(before.rows[0].email, `mirror-old-${stamp}@test.local`)

      // What Supabase does when a person confirms an email change.
      const next = `mirror-new-${stamp}@test.local`
      await c.query('update auth.users set email = $2 where id = $1', [user, next])

      const after = await c.query('select email from profiles where id = $1', [user])
      // Without this trigger the row still holds the OLD address, the settings
      // page shows the new one, and every compliance email goes somewhere he
      // has stopped opening.
      assert.equal(after.rows[0].email, next)
    })
  })

  test('an ordinary auth.users write does not touch the profile', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const stamp = Date.now()
      const user = await makeUser(c, `mirror-quiet-${stamp}@test.local`)

      // auth.users is written on every token refresh. The trigger is scoped
      // `after update of email ... when (new.email is distinct from old.email)`
      // precisely so that it does not rewrite a row of `profiles` once per
      // signed-in request — and this is what proves the scoping holds.
      await c.query(`update profiles set full_name = 'Left Alone' where id = $1`, [user])
      await c.query('update auth.users set updated_at = now() where id = $1', [user])

      const { rows } = await c.query('select full_name, email from profiles where id = $1', [user])
      assert.equal(rows[0].full_name, 'Left Alone')
      assert.equal(rows[0].email, `mirror-quiet-${stamp}@test.local`)
    })
  })

  test('a person may edit their own name, phone and timezone and nobody else may', async () => {
    await withRollback(async (c) => {
      const { owner, staff } = await fixture(c)
      await actAs(c, owner)

      // The exact shape of the settings page's save: three columns named, and
      // the columns it does NOT render left out of the statement entirely. A
      // PostgREST update is a PATCH, so what is not named is not written — this
      // is why "Your details" cannot repeat the bug that once blanked stored
      // notification preferences on every save.
      await c.query(
        `update profiles
            set quiet_from = '22:00', quiet_to = '07:00', quiet_allow_critical = false
          where id = $1`,
        [owner],
      )
      await c.query(
        `update profiles
            set full_name = 'Owner Person', phone = '+18183340168', timezone = 'America/Phoenix'
          where id = $1`,
        [owner],
      )

      const { rows } = await c.query(
        `select full_name, phone, timezone, quiet_from, quiet_to, quiet_allow_critical
           from profiles where id = $1`,
        [owner],
      )
      assert.equal(rows[0].full_name, 'Owner Person')
      assert.equal(rows[0].phone, '+18183340168')
      assert.equal(rows[0].timezone, 'America/Phoenix')
      // Untouched by the second statement, which is the whole point.
      assert.equal(rows[0].quiet_from, '22:00:00')
      assert.equal(rows[0].quiet_allow_critical, false)

      // `profiles_update_self` scopes to `id = auth.uid()`, so this matches no
      // row rather than raising. Zero rows updated is the refusal.
      const stolen = await c.query(`update profiles set full_name = 'Hijacked' where id = $1`, [
        staff,
      ])
      assert.equal(stolen.rowCount, 0)
    })
  })
})
