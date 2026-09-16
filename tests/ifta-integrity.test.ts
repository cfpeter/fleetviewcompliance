/**
 * Two ways a quarter's miles could be silently wrong, guarded at the database.
 *
 * Both of these produce a filing that is short or doubled with NO error
 * anywhere — the worst shape a bug can have in a table that feeds a tax return.
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
  withRollback,
} from './helpers.ts'

async function carrier(c: Parameters<Parameters<typeof withRollback>[0]>[0], dot: string) {
  await actAsOwner(c)
  const u = await makeUser(c, `ifta-${dot}-${Date.now()}@test.local`)
  await actAs(c, u)
  return await makeCarrier(c, dot, 'IFTA TEST')
}

describe('IFTA data integrity', { skip: !configured() }, () => {
  test('fleet-level miles UPDATE rather than silently duplicating', async () => {
    await withRollback(async (c) => {
      const id = await carrier(c, `31${Date.now() % 100000}`)

      // No vehicle_id. Under a standard unique constraint two NULLs are
      // DISTINCT, so this second insert would not conflict — it would add
      // another row and double the quarter's miles with no error at all.
      const ins = (miles: number) =>
        c.query(
          `insert into jurisdiction_miles (carrier_id, vehicle_id, period_start, jurisdiction, miles)
           values ($1, null, '2026-07-01', 'CA', $2)
           on conflict (carrier_id, vehicle_id, period_start, jurisdiction)
           do update set miles = excluded.miles`,
          [id, miles],
        )

      await ins(1000)
      await ins(1500)

      const { rows } = await c.query(
        `select count(*)::int n, sum(miles)::int total from jurisdiction_miles
          where carrier_id = $1 and period_start = '2026-07-01' and jurisdiction = 'CA'`,
        [id],
      )
      assert.equal(rows[0].n, 1, 'a second save must correct the row, not add one beside it')
      assert.equal(rows[0].total, 1500, 'the corrected figure must win')
    })
  })

  test('per-vehicle rows are still independent of each other', async () => {
    await withRollback(async (c) => {
      const id = await carrier(c, `32${Date.now() % 100000}`)
      const { rows: v } = await c.query(
        `insert into vehicles (carrier_id, unit_number) values ($1,'101') returning id`,
        [id],
      )
      const { rows: v2 } = await c.query(
        `insert into vehicles (carrier_id, unit_number) values ($1,'102') returning id`,
        [id],
      )
      for (const truck of [v[0].id, v2[0].id]) {
        await c.query(
          `insert into jurisdiction_miles (carrier_id, vehicle_id, period_start, jurisdiction, miles)
           values ($1,$2,'2026-07-01','CA',500)`,
          [id, truck],
        )
      }
      const { rows } = await c.query(
        `select count(*)::int n from jurisdiction_miles where carrier_id = $1`,
        [id],
      )
      assert.equal(rows[0].n, 2, 'tightening the constraint must not merge two trucks')
    })
  })

  test('a misspelt jurisdiction is refused by the database, not just the form', async () => {
    await withRollback(async (c) => {
      const id = await carrier(c, `33${Date.now() % 100000}`)

      // "Californa" used to store happily and then appear as its own line on
      // the return, splitting one state's miles across two rows and reporting
      // BOTH short. App-side validation cannot catch an import or a psql session.
      const bad = await attempt(
        c,
        `insert into jurisdiction_miles (carrier_id, period_start, jurisdiction, miles)
         values ($1,'2026-07-01','Californa',100)`,
        [id],
      )
      assert.ok(bad, 'a jurisdiction that is not an IFTA member must be refused')

      const good = await attempt(
        c,
        `insert into jurisdiction_miles (carrier_id, period_start, jurisdiction, miles)
         values ($1,'2026-07-01','CA',100)`,
        [id],
      )
      assert.equal(good, null, 'a real jurisdiction must still be accepted')
    })
  })

  test('Alaska and Hawaii are not IFTA members and must be refused', async () => {
    await withRollback(async (c) => {
      const id = await carrier(c, `34${Date.now() % 100000}`)
      for (const j of ['AK', 'HI']) {
        const err = await attempt(
          c,
          `insert into fuel_purchases (carrier_id, purchased_on, jurisdiction, gallons_milli)
           values ($1,'2026-08-01',$2,100000)`,
          [id, j],
        )
        assert.ok(err, `${j} is not an IFTA member and must not be accepted`)
      }
      // A Canadian province is.
      const ok = await attempt(
        c,
        `insert into fuel_purchases (carrier_id, purchased_on, jurisdiction, gallons_milli)
         values ($1,'2026-08-01','BC',100000)`,
        [id],
      )
      assert.equal(ok, null, 'British Columbia is an IFTA member')
    })
  })
})
