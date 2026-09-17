/**
 * Who may read and who may write `billing_subscriptions`.
 *
 * This row decides whether a carrier is a paying customer. If a signed-in user
 * can write it, he can grant himself a subscription — and PostgREST publishes
 * every table and function in this schema to anyone holding the publishable key,
 * which is in the browser bundle. So the refusals below are not defence in
 * depth behind an application check; there is no application check. They are the
 * only thing standing there.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  actAs,
  actAsAnon,
  actAsOwner,
  attempt,
  configured,
  makeCarrier,
  makeUser,
  withRollback,
} from './helpers.ts'

if (!configured()) {
  console.error(
    '\n  ⚠  SKIPPING billing RLS tests: no database configured.\n' +
      '     Set SUPABASE_DB_* in .env. Until these run, nothing stops a user writing\n' +
      '     himself a subscription.\n',
  )
}

/** A billing row for a carrier, written the only way anything ever writes one. */
async function giveSubscription(
  c: Parameters<Parameters<typeof withRollback>[0]>[0],
  carrierId: string,
  customer: string,
) {
  await actAsOwner(c)
  await c.query(
    `insert into billing_subscriptions
       (carrier_id, stripe_customer_id, stripe_subscription_id, status,
        current_period_end, billable_trucks)
     values ($1, $2, $3, 'active', now() + interval '20 days', 9)`,
    [carrierId, customer, `sub_${customer.slice(4)}`],
  )
}

describe('billing rows are readable by their carrier and writable by nobody', {
  skip: !configured(),
}, () => {
  /** Two carriers, two owners, one subscription each. */
  async function fixture(c: Parameters<Parameters<typeof withRollback>[0]>[0]) {
    await actAsOwner(c)
    const stamp = Date.now()
    const alice = await makeUser(c, `billing-alice-${stamp}@test.local`)
    const bob = await makeUser(c, `billing-bob-${stamp}@test.local`)

    await actAs(c, alice)
    const carrierA = await makeCarrier(c, `7${stamp % 1000000}`, 'ALPHA BILLING')
    await actAs(c, bob)
    const carrierB = await makeCarrier(c, `6${stamp % 1000000}`, 'BRAVO BILLING')

    await giveSubscription(c, carrierA, `cus_alpha${stamp}`)
    await giveSubscription(c, carrierB, `cus_bravo${stamp}`)
    return { alice, bob, carrierA, carrierB }
  }

  test('an owner sees his own subscription and nobody else at all', async () => {
    await withRollback(async (c) => {
      const { alice, carrierA } = await fixture(c)
      await actAs(c, alice)

      const { rows } = await c.query('select carrier_id, status from billing_subscriptions')
      // Not "does not see Bob's" — sees EXACTLY one row. A policy that leaked
      // would show two, and a policy that denied everything would show none.
      assert.equal(rows.length, 1)
      assert.equal(rows[0].carrier_id, carrierA)
      assert.equal(rows[0].status, 'active')
    })
  })

  test('another carrier cannot be read even by naming its id', async () => {
    await withRollback(async (c) => {
      const { alice, carrierB } = await fixture(c)
      await actAs(c, alice)
      const { rows } = await c.query('select * from billing_subscriptions where carrier_id = $1', [
        carrierB,
      ])
      assert.equal(rows.length, 0)
    })
  })

  test('a signed-out visitor sees nothing', async () => {
    await withRollback(async (c) => {
      await fixture(c)
      await actAsAnon(c)
      const e = await attempt(c, 'select * from billing_subscriptions')
      // `anon` has no grant at all, so this is a permission error rather than an
      // empty result. Either would be acceptable; a row would not.
      assert.ok(e, 'anon must not read billing rows')
    })
  })

  test('a user cannot give himself a subscription', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const stamp = Date.now()
      const carl = await makeUser(c, `billing-carl-${stamp}@test.local`)
      await actAs(c, carl)
      const carrier = await makeCarrier(c, `5${stamp % 1000000}`, 'CARL BILLING')
      await actAs(c, carl)

      const e = await attempt(
        c,
        `insert into billing_subscriptions (carrier_id, stripe_customer_id, status)
         values ($1, 'cus_selfserve', 'active')`,
        [carrier],
      )
      assert.ok(e, 'a user inserted his own subscription')
      assert.match(String(e?.message), /permission denied/i)
    })
  })

  test('a user cannot upgrade, extend or cancel an existing row', async () => {
    await withRollback(async (c) => {
      const { alice, carrierA } = await fixture(c)
      await actAs(c, alice)

      // Each of these is a different way of stealing the same thing: a status
      // he did not pay for, a period that never ends, a truck count that is not
      // his fleet.
      const updated = await attempt(
        c,
        `update billing_subscriptions set status = 'active',
           current_period_end = now() + interval '10 years', billable_trucks = 1
         where carrier_id = $1`,
        [carrierA],
      )
      assert.ok(updated, 'a user updated his own billing row')
      assert.match(String(updated?.message), /permission denied/i)

      // And deleting it is not a way out either: with no row the screen falls
      // back to the trial, so a delete is a free month.
      const deleted = await attempt(c, 'delete from billing_subscriptions where carrier_id = $1', [
        carrierA,
      ])
      assert.ok(deleted, 'a user deleted his own billing row')
      assert.match(String(deleted?.message), /permission denied/i)
    })
  })

  test('one Stripe customer cannot be pointed at two carriers', async () => {
    // If it could, the billing portal opened from either account would show the
    // other carrier's card, invoices and address.
    await withRollback(async (c) => {
      const { carrierB } = await fixture(c)
      await actAsOwner(c)
      const e = await attempt(
        c,
        `insert into billing_subscriptions (carrier_id, stripe_customer_id, status)
         values ($1, (select stripe_customer_id from billing_subscriptions limit 1), 'active')
         on conflict (carrier_id) do update set stripe_customer_id = excluded.stripe_customer_id`,
        [carrierB],
      )
      assert.ok(e, 'two carriers shared one Stripe customer')
    })
  })

  test('an id from the wrong place is refused at the column', async () => {
    // A subscription id written into the customer column, or an empty string,
    // fails here rather than as a 404 from Stripe three weeks later on the one
    // page that matters.
    await withRollback(async (c) => {
      await actAsOwner(c)
      const stamp = Date.now()
      const dave = await makeUser(c, `billing-dave-${stamp}@test.local`)
      await actAs(c, dave)
      const carrier = await makeCarrier(c, `4${stamp % 1000000}`, 'DAVE BILLING')
      await actAsOwner(c)

      for (const bad of ['sub_123', '', 'cus 123', 'whatever']) {
        const e = await attempt(
          c,
          `insert into billing_subscriptions (carrier_id, stripe_customer_id, status)
           values ($1, $2, 'active')`,
          [carrier, bad],
        )
        assert.ok(e, `${JSON.stringify(bad)} was accepted as a Stripe customer id`)
      }

      // And a status that is not a Stripe-shaped word.
      const badStatus = await attempt(
        c,
        `insert into billing_subscriptions (carrier_id, stripe_customer_id, status)
         values ($1, 'cus_ok', 'Active Now!')`,
        [carrier],
      )
      assert.ok(badStatus, 'a free-text status was accepted')
    })
  })

  test('a status Stripe has not invented yet is still stored', async () => {
    // The other direction, and the more dangerous one. Against an enum or a
    // closed value list, the first event carrying a new status would fail to
    // write — Stripe would retry, the retries would fail too, and this row would
    // go on saying `active` about a subscription that is not. Stale-but-generous
    // is the wrong way to be wrong, and it is silent.
    await withRollback(async (c) => {
      await actAsOwner(c)
      const stamp = Date.now()
      const erin = await makeUser(c, `billing-erin-${stamp}@test.local`)
      await actAs(c, erin)
      const carrier = await makeCarrier(c, `3${stamp % 1000000}`, 'ERIN BILLING')
      await actAsOwner(c)

      await c.query(
        `insert into billing_subscriptions (carrier_id, stripe_customer_id, status)
         values ($1, 'cus_future', 'some_future_status')`,
        [carrier],
      )
      const { rows } = await c.query(
        'select status from billing_subscriptions where carrier_id = $1',
        [carrier],
      )
      assert.equal(rows[0].status, 'some_future_status')
    })
  })

  test('closing a carrier takes its billing row with it', async () => {
    await withRollback(async (c) => {
      const { carrierA } = await fixture(c)
      await actAsOwner(c)
      await c.query('delete from carriers where id = $1', [carrierA])
      const { rows } = await c.query('select 1 from billing_subscriptions where carrier_id = $1', [
        carrierA,
      ])
      assert.equal(rows.length, 0)
    })
  })

  test('the table refuses to hand over write access through a function', async () => {
    // 0021's lesson, checked rather than trusted: PostgREST publishes every
    // function in this schema, so a definer helper here would be one curl away
    // from pointing a carrier's billing portal at a stranger's Stripe customer.
    // This migration adds none, and this test fails if one appears without the
    // grant being thought about again.
    await withRollback(async (c) => {
      await actAsOwner(c)
      const { rows } = await c.query(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname like '%billing%'
            and has_function_privilege('authenticated', p.oid, 'execute')`,
      )
      assert.deepEqual(
        rows.map((r) => r.proname),
        [],
        'a billing function is executable by authenticated',
      )
    })
  })
})
