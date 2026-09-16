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
import {
  actAs,
  actAsAnon,
  actAsOwner,
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

  const link = async (token: string, scope: string, subject: string | null, interval: string) => {
    await c.query(
      `insert into share_links (carrier_id, token, scope, subject_id, expires_at)
       values ($1,$2,$3::share_scope,$4, now() + $5::interval)`,
      [carrier, token, scope, subject, interval],
    )
    return token
  }

  const file = await link(`file-${name}-${Date.now()}`, 'driver_file', driver, '30 days')
  const summary = await link(`sum-${name}-${Date.now()}`, 'carrier_summary', null, '30 days')
  const expired = await link(`exp-${name}-${Date.now()}`, 'carrier_summary', null, '-1 day')

  const { rows: rev } = await c.query(
    `insert into share_links (carrier_id, token, scope, expires_at, revoked_at)
     values ($1,$2,'carrier_summary', now() + interval '30 days', now()) returning token`,
    [carrier, `rev-${name}-${Date.now()}`],
  )

  await actAsOwner(c)
  return { carrier, driver, file, summary, expired, revoked: rev[0].token }
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
