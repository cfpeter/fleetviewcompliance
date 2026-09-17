/**
 * What the `documents` table refuses.
 *
 * supabase/migrations/0003_documents.sql makes three promises, and the upload
 * feature is built on all three. None of them is checked anywhere in the
 * application, on purpose — PostgREST publishes this table to anyone holding the
 * publishable key, which is in the browser bundle, so a check in a page is not a
 * check at all. These are the real ones:
 *
 *   1. Append-only. An UPDATE may set the supersede columns and nothing else.
 *      "Replace this document" therefore cannot be implemented as an edit even
 *      by mistake — and a superseded medical card is the proof the driver was
 *      qualified for the period it covered, which 49 CFR 391.51(c) says we keep.
 *   2. The subject belongs to the same carrier. Without it, a carrier could
 *      attach a file to another tenant's driver: the INSERT passes RLS, because
 *      its own carrier_id is fine, while subject_id points somewhere else.
 *   3. No DELETE grant at all. Not a policy a later migration can loosen by
 *      accident — the privilege is not there.
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

if (!configured()) {
  console.error(
    '\n  ⚠  SKIPPING documents RLS tests: no database configured.\n' +
      '     Set SUPABASE_DB_* in .env. Until these run, nothing proves a carrier\n' +
      '     cannot file a document on another carrier’s driver.\n',
  )
}

type Client = Parameters<Parameters<typeof withRollback>[0]>[0]

/** A key of the shape src/lib/documents.ts generates. Nothing here reads it. */
function key(carrierId: string): string {
  const random = Array.from(
    { length: 48 },
    () => '0123456789abcdef'[Math.floor(Math.random() * 16)],
  )
  return `documents/${carrierId}/${random.join('')}.pdf`
}

describe('documents are append-only and stay inside their carrier', { skip: !configured() }, () => {
  /** Two carriers, two owners, one driver each. */
  async function fixture(c: Client) {
    await actAsOwner(c)
    const stamp = Date.now()
    const alice = await makeUser(c, `doc-alice-${stamp}@test.local`)
    const bob = await makeUser(c, `doc-bob-${stamp}@test.local`)

    await actAs(c, alice)
    const carrierA = await makeCarrier(c, `8${stamp % 1000000}`, 'ALPHA DOCS')
    await actAs(c, bob)
    const carrierB = await makeCarrier(c, `9${stamp % 1000000}`, 'BRAVO DOCS')

    await actAsOwner(c)
    // Two drivers in carrier A, because the interesting move-the-subject case is
    // a move to a driver that IS visible. Moving it to the same id changes
    // nothing and the trigger rightly allows it.
    const { rows: da } = await c.query(
      `insert into drivers (carrier_id, first_name, last_name)
       values ($1, 'Alice', 'Driver'), ($1, 'Second', 'Driver')
       returning id`,
      [carrierA],
    )
    const { rows: db } = await c.query(
      `insert into drivers (carrier_id, first_name, last_name) values ($1, 'Bravo', 'Driver')
       returning id`,
      [carrierB],
    )
    return {
      alice,
      bob,
      carrierA,
      carrierB,
      driverA: da[0].id,
      driverA2: da[1].id,
      driverB: db[0].id,
    }
  }

  /** Inserts a document the way the application does, as the signed-in user. */
  async function insert(
    c: Client,
    args: { carrierId: string; subjectId: string; kind?: string },
  ): Promise<string> {
    const { rows } = await c.query(
      `insert into documents
         (carrier_id, subject_type, subject_id, kind, storage_key, file_name,
          content_type, byte_size)
       values ($1, 'driver', $2, $3, $4, 'card.pdf', 'application/pdf', 1024)
       returning id`,
      [args.carrierId, args.subjectId, args.kind ?? 'medical_certificate', key(args.carrierId)],
    )
    return rows[0].id as string
  }

  test('an owner files a document on his own driver', async () => {
    await withRollback(async (c) => {
      const { alice, carrierA, driverA } = await fixture(c)
      await actAs(c, alice)
      const id = await insert(c, { carrierId: carrierA, subjectId: driverA })
      const { rows } = await c.query('select kind, superseded_at from documents where id = $1', [
        id,
      ])
      assert.equal(rows.length, 1)
      assert.equal(rows[0].kind, 'medical_certificate')
      assert.equal(rows[0].superseded_at, null)
    })
  })

  test('a document cannot be filed on another carrier’s driver', async () => {
    await withRollback(async (c) => {
      const { alice, carrierA, driverB } = await fixture(c)
      await actAs(c, alice)
      // Alice's own carrier_id, so RLS is satisfied. The subject is Bob's
      // driver. This is the attack the trigger exists for, and it is exactly
      // what a hand-edited /app/drivers/<uuid> URL produces.
      const error = await attempt(
        c,
        `insert into documents
           (carrier_id, subject_type, subject_id, kind, storage_key)
         values ($1, 'driver', $2, 'medical_certificate', $3)`,
        [carrierA, driverB, key(carrierA)],
      )
      assert.ok(error, 'a document was filed on another carrier’s driver')
      assert.match(error.message, /does not belong to carrier/)
    })
  })

  test('a document cannot be written under another carrier at all', async () => {
    await withRollback(async (c) => {
      const { alice, carrierB, driverB } = await fixture(c)
      await actAs(c, alice)
      const error = await attempt(
        c,
        `insert into documents
           (carrier_id, subject_type, subject_id, kind, storage_key)
         values ($1, 'driver', $2, 'medical_certificate', $3)`,
        [carrierB, driverB, key(carrierB)],
      )
      assert.ok(error, 'a document was written under another carrier')
    })
  })

  test('one carrier’s documents are invisible to another', async () => {
    await withRollback(async (c) => {
      const { alice, bob, carrierA, driverA } = await fixture(c)
      await actAs(c, alice)
      const id = await insert(c, { carrierId: carrierA, subjectId: driverA })

      // Bob knows the id. That is the whole premise of the download route's
      // check: an id is not an authorisation.
      await actAs(c, bob)
      const { rows } = await c.query('select id, storage_key from documents where id = $1', [id])
      assert.equal(rows.length, 0, 'another carrier read a document by its id')
    })
  })

  test('the file, the dates, the kind and the carrier cannot be edited', async () => {
    await withRollback(async (c) => {
      const { alice, carrierA, driverA, driverA2, carrierB } = await fixture(c)
      await actAs(c, alice)
      const id = await insert(c, { carrierId: carrierA, subjectId: driverA })

      // Every column the append-only trigger names, one at a time, so a failure
      // says which one stopped being protected.
      const edits: [string, unknown[]][] = [
        ['update documents set storage_key = $2 where id = $1', [id, key(carrierA)]],
        ['update documents set kind = $2 where id = $1', [id, 'cdl']],
        ['update documents set issued_on = $2 where id = $1', [id, '2026-01-01']],
        ['update documents set expires_on = $2 where id = $1', [id, '2027-01-01']],
        ['update documents set carrier_id = $2 where id = $1', [id, carrierB]],
        // Another driver in the SAME carrier — visible, so RLS and the subject
        // trigger are both happy and only the append-only rule can refuse it.
        ['update documents set subject_id = $2 where id = $1', [id, driverA2]],
        ['update documents set subject_type = $2 where id = $1', [id, 'carrier']],
        // A literal, not now(). Inside a transaction now() is the transaction's
        // start time, which is the value the row already holds — so `now()` here
        // is not a change at all and the trigger correctly lets it through. The
        // test that reads as strictest was the one proving nothing.
        ['update documents set uploaded_at = $2 where id = $1', [id, '2000-01-01T00:00:00Z']],
      ]
      for (const [sql, params] of edits) {
        const error = await attempt(c, sql, params)
        assert.ok(error, `this UPDATE was allowed: ${sql}`)
        assert.match(error.message, /append-only|does not belong/, sql)
      }

      // And nothing changed.
      const { rows } = await c.query(
        'select kind, issued_on, expires_on from documents where id = $1',
        [id],
      )
      assert.equal(rows[0].kind, 'medical_certificate')
      assert.equal(rows[0].issued_on, null)
      assert.equal(rows[0].expires_on, null)
    })
  })

  test('superseding is the one UPDATE that is allowed', async () => {
    await withRollback(async (c) => {
      const { alice, carrierA, driverA } = await fixture(c)
      await actAs(c, alice)
      const old = await insert(c, { carrierId: carrierA, subjectId: driverA })
      const fresh = await insert(c, { carrierId: carrierA, subjectId: driverA })

      // Exactly what storeDocument() does, in the order it does it: the new row
      // exists before the old one is retired, so there is never a moment with no
      // current medical card.
      await c.query(
        'update documents set superseded_at = now(), superseded_by = $2 where id = $1',
        [old, fresh],
      )
      const { rows } = await c.query(
        'select superseded_at, superseded_by from documents where id = $1',
        [old],
      )
      assert.ok(rows[0].superseded_at, 'the supersede did not take')
      assert.equal(rows[0].superseded_by, fresh)

      // The old row is still readable. It is the proof for the period it
      // covered, and the Old files list opens it.
      const { rows: still } = await c.query('select storage_key from documents where id = $1', [
        old,
      ])
      assert.equal(still.length, 1)
    })
  })

  test('nobody can delete a document, not even its own carrier', async () => {
    await withRollback(async (c) => {
      const { alice, carrierA, driverA } = await fixture(c)
      await actAs(c, alice)
      const id = await insert(c, { carrierId: carrierA, subjectId: driverA })

      const error = await attempt(c, 'delete from documents where id = $1', [id])
      assert.ok(error, 'a document was deleted')
      assert.match(error.message, /permission denied/)

      const { rows } = await c.query('select id from documents where id = $1', [id])
      assert.equal(rows.length, 1, 'the row is gone')
    })
  })
})
