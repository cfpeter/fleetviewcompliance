/**
 * Deleting a truck or a driver, against a real database.
 *
 * This one cannot be tested any other way. The whole feature is about what
 * Postgres does to OTHER tables when a row goes — cascades, set-nulls, and the
 * two tables with no foreign key at all — and a mock would simply agree with
 * whatever the test expected.
 *
 * The property being defended: a delete that would destroy or orphan evidence
 * must be refused, and a row with nothing behind it must still be deletable, or
 * the mistyped truck stays on the fleet and on the bill forever.
 *
 * Every test runs inside `withRollback`, as an ordinary signed-in carrier user
 * over the same role and policies a real request uses — not as a superuser, and
 * not with RLS off.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  canRemove,
  DRIVER_HISTORY_KINDS,
  heldLines,
  refusalFor,
  remindersLine,
  VEHICLE_HISTORY_KINDS,
} from '../src/lib/fleet/remove.ts'
import {
  actAs,
  actAsOwner,
  attempt,
  configured,
  makeCarrier,
  makeUser,
  withRollback,
} from './helpers.ts'

// ---------------------------------------------------------------------------
// The pure half: counts in, sentences out
// ---------------------------------------------------------------------------

const kind = (key: string) => ({ key, one: key, many: `${key}s` })
const report = (counts: { kind: ReturnType<typeof kind>; count: number }[], extra = {}) => ({
  counts,
  reminders: 0,
  unreadable: false,
  ...extra,
})

test('a row with nothing behind it can go', () => {
  const empty = report(VEHICLE_HISTORY_KINDS.map((k) => ({ kind: k, count: 0 })))
  assert.equal(canRemove(empty), true)
  assert.equal(refusalFor('vehicle', 'Unit 104', empty), null)
})

test('one record anywhere is enough to refuse', () => {
  // Not a majority and not a weighting. One document is one thing an auditor can
  // ask for, and the whole point of the check is that it has no threshold.
  for (const target of DRIVER_HISTORY_KINDS) {
    const counts = DRIVER_HISTORY_KINDS.map((k) => ({ kind: k, count: k === target ? 1 : 0 }))
    assert.equal(canRemove(report(counts)), false, `${target.key} did not block a delete`)
  }
})

test('a count we could not read is not a count of zero', () => {
  // The difference between "nothing on file" and "we could not look", and only
  // one of them is safe to delete on.
  const unknown = report(
    VEHICLE_HISTORY_KINDS.map((k) => ({ kind: k, count: 0 })),
    { unreadable: true },
  )
  assert.equal(canRemove(unknown), false)
  assert.match(refusalFor('vehicle', 'Unit 104', unknown)?.why ?? '', /could not read/i)
})

test('the refusal names the row, says what is on file, and says what to do instead', () => {
  const r = refusalFor(
    'driver',
    'Juan Ramirez',
    report([
      { kind: kind('compliance date'), count: 3 },
      { kind: kind('file'), count: 1 },
      { kind: kind('load'), count: 0 },
    ]),
  )
  assert.ok(r)
  // The name, because a refusal that does not say which row it is about is a
  // refusal read twice.
  assert.match(r.title, /Juan Ramirez/)
  // The counts, pluralised, so he can see exactly what he would have lost.
  assert.deepEqual(r.held, ['3 compliance dates', '1 file'])
  // The reason, in his words, with the citation that settles it.
  assert.match(r.why, /391\.51\(c\)/)
  // AND THE WAY OUT. A dead end that does not say what to do instead is a
  // broken button, and the thing he actually wanted — off the reminders, off
  // the bill — is one status change away.
  assert.match(r.instead, /Terminated|Inactive/)
})

test('the truck refusal points at the status change, and says both halves of it', () => {
  const r = refusalFor('vehicle', 'Unit 104', report([{ kind: kind('load'), count: 2 }]))
  assert.ok(r)
  assert.deepEqual(r.held, ['2 loads'])
  assert.match(r.instead, /Sold|Out of service|Inactive/)
  assert.match(r.instead, /reminders/i)
  assert.match(r.instead, /charging/i)
})

test('reminders do not block a delete, but they are named before it happens', () => {
  // 0023_custom_reminders.sql chose CASCADE knowingly: a reminder is the owner's
  // private to-do, not evidence. Losing it is honest — surprising him with it is
  // not, so the confirmation says so.
  const withTodo = report([{ kind: kind('load'), count: 0 }], { reminders: 2 })
  assert.equal(canRemove(withTodo), true)
  assert.match(remindersLine('vehicle', withTodo) ?? '', /2 reminders.*truck.*deleted too/)
  assert.equal(remindersLine('vehicle', report([])), null)
})

test('nothing on file produces no held lines at all', () => {
  assert.deepEqual(heldLines(report([{ kind: kind('file'), count: 0 }])), [])
})

// ---------------------------------------------------------------------------
// The database half: what actually happens when the row goes
// ---------------------------------------------------------------------------

describe('deleting a truck or a driver, in Postgres', { skip: !configured() }, () => {
  type Client = Parameters<Parameters<typeof withRollback>[0]>[0]

  async function fixture(c: Client, tag: string, dot: string) {
    await actAsOwner(c)
    const user = await makeUser(c, `del-${tag}-${Date.now()}@test.local`)
    await actAs(c, user)
    const carrierId = await makeCarrier(c, dot, `DELETE ${tag}`)
    const { rows: d } = await c.query(
      `insert into drivers (carrier_id, first_name, last_name) values ($1,'Ana','Ruiz') returning id`,
      [carrierId],
    )
    const { rows: v } = await c.query(
      `insert into vehicles (carrier_id, unit_number) values ($1,'204') returning id`,
      [carrierId],
    )
    return { user, carrierId, driverId: d[0].id as string, vehicleId: v[0].id as string }
  }

  const dot = (n: number) => `${n}${Date.now() % 100000}`

  // --- the rows that really are mistakes ------------------------------------

  test('a truck with nothing on it can be deleted', async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'a', dot(41))
      const refused = await attempt(c, 'delete from vehicles where id = $1', [mine.vehicleId])
      assert.equal(refused, null, 'a mistyped unit number must be removable')
      const { rows } = await c.query('select id from vehicles where id = $1', [mine.vehicleId])
      assert.equal(rows.length, 0)
    })
  })

  test('a driver with nothing on him can be deleted', async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'b', dot(42))
      const refused = await attempt(c, 'delete from drivers where id = $1', [mine.driverId])
      assert.equal(refused, null, 'a driver typed twice must be removable')
      const { rows } = await c.query('select id from drivers where id = $1', [mine.driverId])
      assert.equal(rows.length, 0)
    })
  })

  // --- the rows that are not ------------------------------------------------

  test('a compliance date makes the truck undeletable', async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'c', dot(43))
      await c.query(
        `insert into compliance_records (carrier_id, subject_type, subject_id, anchor_key, occurred_on)
         values ($1, 'vehicle', $2, 'periodic_inspection_date', '2026-01-10')`,
        [mine.carrierId, mine.vehicleId],
      )
      const refused = await attempt(c, 'delete from vehicles where id = $1', [mine.vehicleId])
      assert.ok(refused, 'a truck with an inspection date on file must not be deletable')
      assert.match(refused.message, /compliance dates/)
    })
  })

  test('THE DELETE DOES NOT CASCADE INTO compliance_records — it would orphan them', async () => {
    // The reason this feature needed a guard at all. `compliance_records` has NO
    // foreign key to `vehicles`: it points at a subject through
    // (subject_type, subject_id). Without the trigger the delete SUCCEEDS,
    // nothing errors, and the evidence is left pointing at an id that no longer
    // names a truck. This test proves both halves: the row survives, and it
    // survives because the parent was refused, not because a cascade was kind.
    await withRollback(async (c) => {
      const mine = await fixture(c, 'd', dot(44))
      await c.query(
        `insert into compliance_records (carrier_id, subject_type, subject_id, anchor_key, occurred_on)
         values ($1, 'vehicle', $2, 'periodic_inspection_date', '2026-01-10')`,
        [mine.carrierId, mine.vehicleId],
      )

      assert.ok(await attempt(c, 'delete from vehicles where id = $1', [mine.vehicleId]))

      const { rows: records } = await c.query(
        `select subject_id from compliance_records where subject_id = $1`,
        [mine.vehicleId],
      )
      assert.equal(records.length, 1, 'the evidence must still be here')
      const { rows: truck } = await c.query('select id from vehicles where id = $1', [
        mine.vehicleId,
      ])
      assert.equal(truck.length, 1, 'and it must still point at a truck that exists')
    })
  })

  test("a driver's documents are never reachable by deleting him", async () => {
    // 49 CFR 391.51(c): the qualification file is kept for his employment plus
    // three years. `documents` has no DELETE grant and no foreign key here, so
    // the only way to lose it is to delete the driver it hangs off.
    await withRollback(async (c) => {
      const mine = await fixture(c, 'e', dot(45))
      await c.query(
        `insert into documents (carrier_id, subject_type, subject_id, kind, storage_key)
         values ($1, 'driver', $2, 'medical_certificate', 'k/1')`,
        [mine.carrierId, mine.driverId],
      )

      const refused = await attempt(c, 'delete from drivers where id = $1', [mine.driverId])
      assert.ok(refused, 'a driver with a file must not be deletable')
      assert.match(refused.message, /documents/)

      const { rows } = await c.query('select id from documents where subject_id = $1', [
        mine.driverId,
      ])
      assert.equal(rows.length, 1, 'the medical card must still be on file')
    })
  })

  test('a paid settlement still cannot be deleted away, and now it says why', async () => {
    // 0018 already made this FK RESTRICT after a cascade destroyed a paid
    // settlement. The guard runs first, so what the owner gets is a sentence
    // about settlements instead of a foreign-key violation.
    await withRollback(async (c) => {
      const mine = await fixture(c, 'f', dot(46))
      await c.query(
        `insert into settlements (carrier_id, driver_id, period_start, period_end)
         values ($1, $2, '2026-01-05', '2026-01-11')`,
        [mine.carrierId, mine.driverId],
      )
      const refused = await attempt(c, 'delete from drivers where id = $1', [mine.driverId])
      assert.ok(refused)
      assert.match(refused.message, /settlements/)
    })
  })

  test('IFTA miles keep a truck on the fleet, because a null vehicle cannot be filed', async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'g', dot(47))
      await c.query(
        `insert into jurisdiction_miles (carrier_id, vehicle_id, period_start, jurisdiction, miles)
         values ($1, $2, '2026-07-01', 'CA', 4200)`,
        [mine.carrierId, mine.vehicleId],
      )
      const refused = await attempt(c, 'delete from vehicles where id = $1', [mine.vehicleId])
      assert.ok(refused, 'the FK is SET NULL, so without the guard the miles lose their truck')
      assert.match(refused.message, /IFTA miles/)

      const { rows } = await c.query(
        'select vehicle_id from jurisdiction_miles where carrier_id = $1',
        [mine.carrierId],
      )
      assert.equal(rows[0].vehicle_id, mine.vehicleId, 'the miles must still name the truck')
    })
  })

  test('a load remembers who drove it, because the driver cannot be deleted', async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'h', dot(48))
      // `loads_identifiable` (0011) refuses a load with neither reference, so
      // the fixture gives it the one a dispatcher would say on the phone.
      const { rows: load } = await c.query(
        `insert into loads (carrier_id, load_number) values ($1, 'L-1') returning id`,
        [mine.carrierId],
      )
      await c.query(
        `insert into load_assignments (carrier_id, load_id, driver_id) values ($1, $2, $3)`,
        [mine.carrierId, load[0].id, mine.driverId],
      )
      const refused = await attempt(c, 'delete from drivers where id = $1', [mine.driverId])
      assert.ok(refused, 'the FK is SET NULL, so without the guard the load forgets him')
      assert.match(refused.message, /loads/)
    })
  })

  // --- the ones that are deliberately allowed through ------------------------

  test('a reminder does not stop a delete, and goes with the truck', async () => {
    // 0023 argued this and chose CASCADE; tests/reminders.test.ts pins the
    // cascade itself. Here the point is that the guard does not overrule it — a
    // private to-do is not evidence, and blocking on one would mean the mistyped
    // truck becomes undeletable the moment somebody writes a note about it.
    await withRollback(async (c) => {
      const mine = await fixture(c, 'i', dot(49))
      await c.query(
        `insert into reminders (carrier_id, title, due_on, vehicle_id)
         values ($1, 'Truck payment', '2026-10-01', $2)`,
        [mine.carrierId, mine.vehicleId],
      )
      const refused = await attempt(c, 'delete from vehicles where id = $1', [mine.vehicleId])
      assert.equal(refused, null, 'a to-do must not make a truck permanent')
      const { rows } = await c.query('select id from reminders where carrier_id = $1', [
        mine.carrierId,
      ])
      assert.equal(rows.length, 0)
    })
  })

  test('closing a carrier still takes its whole fleet with it', async () => {
    // The guard must not turn "delete my account" into an error. A cascade from
    // `carriers` arrives at this trigger with the parent row ALREADY gone — the
    // same fact 0018 documents — and that is how it is recognised and let
    // through. Without this the carrier delete in tests/billing-rls.test.ts, and
    // account closure generally, would fail on any carrier with one date on file.
    await withRollback(async (c) => {
      const mine = await fixture(c, 'j', dot(50))
      await c.query(
        `insert into compliance_records (carrier_id, subject_type, subject_id, anchor_key, occurred_on)
         values ($1, 'driver', $2, 'medical_certificate_expires', '2027-01-10')`,
        [mine.carrierId, mine.driverId],
      )
      await actAsOwner(c)
      const refused = await attempt(c, 'delete from carriers where id = $1', [mine.carrierId])
      assert.equal(refused, null, 'closing an account must not be blocked by its own history')
      const { rows } = await c.query('select id from drivers where id = $1', [mine.driverId])
      assert.equal(rows.length, 0)
    })
  })

  // --- tenancy --------------------------------------------------------------

  test('the guard cannot be used to count another carrier rows', async () => {
    // The trigger is SECURITY INVOKER, so its lookups run under the caller's own
    // RLS. Another carrier's truck is invisible to this statement anyway — it
    // deletes zero rows and the trigger never fires — and that is what makes the
    // message in the guard safe to raise at all.
    await withRollback(async (c) => {
      const mine = await fixture(c, 'k', dot(51))
      await fixture(c, 'l', dot(52))
      const { rowCount } = await c.query('delete from vehicles where id = $1', [mine.vehicleId])
      assert.equal(rowCount, 0, "another carrier's truck must be invisible, not refused")
      await actAsOwner(c)
      const { rows } = await c.query('select id from vehicles where id = $1', [mine.vehicleId])
      assert.equal(rows.length, 1, 'and it must still be there')
    })
  })

  // --- the grants the append-only tables must never gain ---------------------

  test('nothing here handed out a DELETE on documents or compliance_records', async () => {
    // 0003 and 0005 do not grant DELETE, and 0028 must not have quietly needed
    // one to make the trigger work. The privilege simply is not there, which is
    // stronger than a policy a later migration could loosen by accident.
    await withRollback(async (c) => {
      await actAsOwner(c)
      const { rows } = await c.query(
        `select table_name from information_schema.role_table_grants
          where grantee = 'authenticated'
            and privilege_type = 'DELETE'
            and table_name in ('documents', 'compliance_records')`,
      )
      assert.deepEqual(rows, [], 'the append-only tables must never be deletable')
    })
  })
})
