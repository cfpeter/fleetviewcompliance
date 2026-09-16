/**
 * Keeps the database's anchor_kinds registry in step with the rule catalogue.
 *
 * The failure this prevents is silent and nasty: add an `expiry` rule, forget
 * the registry row, and corrections to that date stop taking effect. The screen
 * keeps showing the typo, the owner retypes it, and nothing changes.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { allRules } from '../src/lib/rules/index.ts'
import { configured, queryAsOwner, withRollback } from './helpers.ts'

/** Anchors whose value is a STATEMENT about one current document. */
function statementAnchors(): string[] {
  const out = new Set<string>()
  for (const r of allRules) {
    if (r.recurrence.type === 'expiry') out.add(r.recurrence.anchor)
  }
  return [...out].sort()
}

describe('anchor kinds', { skip: !configured() }, () => {
  test('every expiry anchor in the catalogue is registered as a statement', async () => {
    await withRollback(async (c) => {
      const { rows } = await c.query(`select anchor_key from anchor_kinds where kind = 'statement'`)
      const registered = new Set(rows.map((r: { anchor_key: string }) => r.anchor_key))
      for (const a of statementAnchors()) {
        assert.ok(
          registered.has(a),
          `anchor '${a}' is an expiry anchor but is not registered as a statement — ` +
            'corrections to it will be silently ignored',
        )
      }
    })
  })

  test('a correction to a statement anchor wins, even when its date is earlier', async () => {
    await withRollback(async (c) => {
      const { rows: u } = await c.query(
        `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
           email_confirmed_at, created_at, updated_at)
         values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
           'authenticated', $1, 'x', now(), now(), now()) returning id`,
        [`kinds-${Date.now()}@test.local`],
      )
      await c.query(`select set_config('role','authenticated',true)`)
      await c.query(`select set_config('request.jwt.claims',$1,true)`, [
        JSON.stringify({ sub: u[0].id, role: 'authenticated' }),
      ])
      const { rows: cc } = await queryAsOwner(c, `select create_carrier($1,$2) as id`, [
        `7${Date.now() % 1000000}`,
        'KINDS TEST',
      ])
      const carrier = cc[0].id

      const add = (key: string, on: string) =>
        c.query(
          `insert into compliance_records (carrier_id, subject_type, subject_id, anchor_key, occurred_on)
           values ($1,'carrier',$1,$2,$3)`,
          [carrier, key, on],
        )

      // The typo, then the correction — an EARLIER date typed LATER.
      await add('medical_certificate_expires', '2027-06-30')
      await add('medical_certificate_expires', '2026-06-30')
      const stmt = await c.query(
        `select occurred_on from current_compliance_anchors
          where carrier_id = $1 and anchor_key = 'medical_certificate_expires'`,
        [carrier],
      )
      assert.equal(
        stmt.rows[0].occurred_on.toISOString().slice(0, 10),
        '2026-06-30',
        'the correction must win for a statement anchor',
      )

      // An occurrence behaves the opposite way, and that is also correct: a
      // record of an OLDER inspection typed later does not replace the newer one.
      await add('periodic_inspection_date', '2026-03-10')
      await add('periodic_inspection_date', '2025-01-05')
      const occ = await c.query(
        `select occurred_on from current_compliance_anchors
          where carrier_id = $1 and anchor_key = 'periodic_inspection_date'`,
        [carrier],
      )
      assert.equal(
        occ.rows[0].occurred_on.toISOString().slice(0, 10),
        '2026-03-10',
        'the most recent occurrence must win for an occurrence anchor',
      )
    })
  })
})
