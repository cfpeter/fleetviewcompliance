/**
 * The phase 1 gate.
 *
 * One carrier must never see another carrier's rows, and `anon` must see
 * nothing at all. Every assertion runs as a real Postgres role with real JWT
 * claims, against the real policies.
 *
 * If this file passes, the security model holds. If it is skipped, nothing
 * about the security model has been demonstrated — so a skip is reported
 * loudly rather than quietly counting as a pass.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
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

const TENANT_TABLES = ['carriers', 'drivers', 'vehicles', 'terminals', 'documents']

if (!configured()) {
  console.error(
    '\n  ⚠  SKIPPING tenancy tests: no database configured.\n' +
      '     Set SUPABASE_DB_* in .env. Until these run, cross-tenant isolation is UNPROVEN.\n',
  )
}

describe('cross-tenant isolation', { skip: !configured() }, () => {
  /** Builds two fully populated carriers owned by two different users. */
  async function fixture(c: Parameters<Parameters<typeof withRollback>[0]>[0]) {
    await actAsOwner(c)
    const alice = await makeUser(c, `alice-${Date.now()}@test.local`)
    const bob = await makeUser(c, `bob-${Date.now()}@test.local`)

    const mk = async (userId: string, dot: string, name: string) => {
      await actAs(c, userId)
      const { rows } = await queryAsOwner(c, `select create_carrier($1, $2) as id`, [dot, name])
      const carrierId = rows[0].id
      await c.query(
        `insert into drivers (carrier_id, first_name, last_name) values ($1, $2, 'Driver')`,
        [carrierId, name],
      )
      await c.query(`insert into vehicles (carrier_id, unit_number) values ($1, $2)`, [
        carrierId,
        `unit-${name}`,
      ])
      await c.query(`insert into terminals (carrier_id, name) values ($1, $2)`, [
        carrierId,
        `yard-${name}`,
      ])
      await c.query(
        `insert into documents (carrier_id, subject_type, subject_id, kind, storage_key)
         values ($1, 'carrier', $1, 'test', $2)`,
        [carrierId, `k/${name}`],
      )
      return carrierId
    }

    const carrierA = await mk(alice, `9${Date.now() % 1000000}`, 'ALPHA')
    const carrierB = await mk(bob, `8${Date.now() % 1000000}`, 'BRAVO')
    return { alice, bob, carrierA, carrierB }
  }

  test('a user sees exactly their own carrier, and only one row per table', async () => {
    await withRollback(async (c) => {
      const { alice, carrierA } = await fixture(c)
      await actAs(c, alice)

      const { rows: carriers } = await c.query('select id from carriers')
      assert.equal(carriers.length, 1, 'should see exactly one carrier')
      assert.equal(carriers[0].id, carrierA)

      for (const t of ['drivers', 'vehicles', 'terminals', 'documents']) {
        const { rows } = await c.query(`select carrier_id from ${t}`)
        assert.equal(rows.length, 1, `${t}: expected 1 visible row, saw ${rows.length}`)
        assert.equal(rows[0].carrier_id, carrierA, `${t}: leaked another carrier's row`)
      }
    })
  })

  test('the other carrier is invisible on every tenant table', async () => {
    await withRollback(async (c) => {
      const { alice, carrierB } = await fixture(c)
      await actAs(c, alice)

      for (const t of TENANT_TABLES) {
        const col = t === 'carriers' ? 'id' : 'carrier_id'
        const { rows } = await c.query(`select count(*)::int as n from ${t} where ${col} = $1`, [
          carrierB,
        ])
        assert.equal(rows[0].n, 0, `${t}: carrier B's rows are visible to carrier A`)
      }
    })
  })

  test('a user cannot write into another carrier', async () => {
    await withRollback(async (c) => {
      const { alice, carrierB } = await fixture(c)
      await actAs(c, alice)
      await assert.rejects(
        () =>
          c.query(`insert into drivers (carrier_id, first_name, last_name) values ($1, 'X', 'Y')`, [
            carrierB,
          ]),
        /row-level security/i,
        'insert into another carrier should be refused',
      )
    })
  })

  test('a user cannot move their own row into another carrier', async () => {
    await withRollback(async (c) => {
      const { alice, carrierB } = await fixture(c)
      await actAs(c, alice)
      // The UPDATE matches a row Alice can see; WITH CHECK is what must stop the
      // new carrier_id. Without it this is a one-line data exfiltration.
      const err = await attempt(c, `update drivers set carrier_id = $1`, [carrierB])
      const moved = await c.query(`select count(*)::int as n from drivers where carrier_id = $1`, [
        carrierB,
      ])
      assert.ok(
        err !== null || moved.rows[0].n === 0,
        'WITH CHECK must prevent re-parenting a row into another carrier',
      )
    })
  })

  test('a document cannot be attached to another carrier subject', async () => {
    await withRollback(async (c) => {
      const { alice, carrierA, carrierB } = await fixture(c)
      await actAsOwner(c)
      const { rows } = await c.query('select id from drivers where carrier_id = $1', [carrierB])
      const bobsDriver = rows[0].id

      await actAs(c, alice)
      await assert.rejects(
        () =>
          c.query(
            `insert into documents (carrier_id, subject_type, subject_id, kind, storage_key)
             values ($1, 'driver', $2, 'medical_certificate', 'k/x')`,
            [carrierA, bobsDriver],
          ),
        /does not belong/i,
      )
    })
  })

  test('anon sees nothing on any tenant table', async () => {
    await withRollback(async (c) => {
      await fixture(c)
      await actAsAnon(c)
      for (const t of TENANT_TABLES) {
        // A missing GRANT raises rather than returning zero rows. Both are a
        // pass; silently returning data is not.
        const n = await c
          .query(`select count(*)::int as n from ${t}`)
          .then((r: { rows: Array<{ n: number }> }) => r.rows[0].n)
          .catch(() => 0)
        assert.equal(n, 0, `${t}: anon can read ${n} rows`)
      }
    })
  })

  test('documents cannot be deleted, by anyone holding a session', async () => {
    await withRollback(async (c) => {
      const { alice } = await fixture(c)
      await actAs(c, alice)
      const err = await attempt(c, 'delete from documents')
      const left = await c.query('select count(*)::int as n from documents')
      assert.ok(
        err !== null || left.rows[0].n === 1,
        'documents must not be deletable: the retention rules require them',
      )
    })
  })

  test('documents are append-only on update', async () => {
    await withRollback(async (c) => {
      const { alice } = await fixture(c)
      await actAs(c, alice)
      const err = await attempt(c, `update documents set storage_key = 'tampered'`)
      assert.match(String(err), /append-only/i, 'storage_key must not be rewritable')
      // Superseding is the permitted update, and must still work afterwards.
      await c.query('update documents set superseded_at = now()')
    })
  })
})

describe('load child rows cannot be attached across carriers', { skip: !configured() }, () => {
  test("a stop cannot be hung on another carrier's load", async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const alice = await makeUser(c, `la-${Date.now()}@test.local`)
      const bob = await makeUser(c, `lb-${Date.now()}@test.local`)

      const mkLoad = async (userId: string, dot: string, name: string) => {
        await actAs(c, userId)
        const { rows } = await queryAsOwner(c, `select create_carrier($1,$2) as id`, [dot, name])
        const carrierId = rows[0].id
        const { rows: l } = await c.query(
          `insert into loads (carrier_id, load_number) values ($1,$2) returning id`,
          [carrierId, `L-${name}`],
        )
        return { carrierId, loadId: l[0].id }
      }

      const a = await mkLoad(alice, `6${Date.now() % 1000000}`, 'ALPHA')
      const b = await mkLoad(bob, `5${Date.now() % 1000000}`, 'BRAVO')

      await actAs(c, alice)
      // Alice's own carrier_id (so RLS is satisfied) but Bob's load_id. Without
      // the parent trigger this INSERT succeeds and lands on Bob's load.
      const err = await attempt(
        c,
        `insert into load_stops (carrier_id, load_id, sequence, stop_type)
         values ($1, $2, 1, 'pickup')`,
        [a.carrierId, b.loadId],
      )
      assert.ok(err, "attaching a stop to another carrier's load must be refused")
      assert.match(String(err), /does not belong/i)

      // Her own load still works, so the trigger is not simply blocking everything.
      const ok = await attempt(
        c,
        `insert into load_stops (carrier_id, load_id, sequence, stop_type)
         values ($1, $2, 1, 'pickup')`,
        [a.carrierId, a.loadId],
      )
      assert.equal(ok, null, 'a stop on her own load must still be allowed')
    })
  })

  test('a load must be identifiable by one of its two reference numbers', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const u = await makeUser(c, `lid-${Date.now()}@test.local`)
      await actAs(c, u)
      const { rows } = await queryAsOwner(c, `select create_carrier($1,$2) as id`, [
        `4${Date.now() % 1000000}`,
        'IDENT',
      ])
      // A load with neither number can never be returned by the search box and
      // cannot be named on the phone.
      const err = await attempt(c, `insert into loads (carrier_id) values ($1)`, [rows[0].id])
      assert.ok(err, 'a load with no reference number at all must be refused')
    })
  })
})
