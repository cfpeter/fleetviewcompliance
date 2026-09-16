/**
 * What 0010_cleanup.sql actually changed, asserted against the real database.
 *
 * Every test here is a defect that shipped, not a feature. They are written as
 * "this can no longer happen" rather than "this works", because each one is
 * guarding a shape that was wrong for long enough to reach a live schema:
 *
 *   ITEM 1  lead_days and digest hung off (category, CHANNEL), so one category
 *           kept three copies free to disagree
 *   ITEM 2  notification_snoozes.subject_type used the DOCUMENT vocabulary, so
 *           it could never match anything the rule engine says
 *   ITEM 4  profiles.timezone was NOT NULL DEFAULT 'America/Los_Angeles', so
 *           "never chose" was not expressible and carriers.timezone was dead
 *
 * ITEM 3 (quiet hours) changed no schema and is tested in notify-guard.test.ts
 * and notify-select.test.ts, where the logic lives.
 *
 * Against a real database, in a transaction that is always rolled back. A mock
 * would prove nothing: the whole claim is about what Postgres will and will not
 * now accept.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  actAs,
  actAsOwner,
  attempt,
  configured,
  makeUser,
  queryAsOwner,
  withRollback,
} from './helpers.ts'

if (!configured()) {
  console.error(
    '\n  ⚠  SKIPPING cleanup tests: no database configured.\n' +
      '     Set SUPABASE_DB_* in .env. Until these run, 0010 is UNVERIFIED.\n',
  )
}

type Client = Parameters<Parameters<typeof withRollback>[0]>[0]

/** A signed-in user who owns one carrier. */
async function carrierFor(c: Client, tag: string): Promise<{ userId: string; carrierId: string }> {
  await actAsOwner(c)
  const userId = await makeUser(c, `${tag}-${Date.now()}-${Math.random()}@test.local`)
  await actAs(c, userId)
  const { rows } = await queryAsOwner(c, 'select create_carrier($1, $2) as id', [
    `${Math.floor(Math.random() * 9_000_000) + 1_000_000}`,
    `Cleanup ${tag}`,
  ])
  return { userId, carrierId: rows[0].id }
}

describe('0010 — item 1: lead times belong to the category, not the channel', {
  skip: !configured(),
}, () => {
  test('the channel table can no longer hold lead times at all', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const { rows } = await c.query(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'notification_preferences'`,
      )
      const columns = rows.map((r) => r.column_name)

      // The point of the migration. While these columns existed, a save could
      // write three different arrays for one category and no screen could ever
      // show the disagreement — so the fix is removal, not a convention.
      assert.ok(!columns.includes('lead_days'), 'lead_days must be gone from the channel table')
      assert.ok(!columns.includes('digest'), 'digest must be gone from the channel table')
      assert.ok(columns.includes('enabled'), 'the per-channel choice genuinely is per-channel')
    })
  })

  test('one category can hold exactly one lead-time row, enforced by the key', async () => {
    await withRollback(async (c) => {
      const { userId, carrierId } = await carrierFor(c, 'lead')

      await c.query(
        `insert into notification_category_preferences (carrier_id, user_id, category, lead_days)
         values ($1, $2, 'compliance', '{30,7,1,-1}')`,
        [carrierId, userId],
      )

      // A second row for the same category is what the old schema allowed three
      // of. The primary key IS the fact's shape, so the database refuses.
      const err = await attempt(
        c,
        `insert into notification_category_preferences (carrier_id, user_id, category, lead_days)
         values ($1, $2, 'compliance', '{1}')`,
        [carrierId, userId],
      )
      assert.ok(err, 'a second row for one category must be refused')
      assert.match(String(err?.message), /duplicate key|unique/i)

      // A different category is a different fact and is allowed.
      await c.query(
        `insert into notification_category_preferences (carrier_id, user_id, category, lead_days)
         values ($1, $2, 'federal', '{14}')`,
        [carrierId, userId],
      )
      const { rows } = await c.query(
        'select count(*)::int as n from notification_category_preferences where carrier_id = $1',
        [carrierId],
      )
      assert.equal(rows[0].n, 2)
    })
  })

  test('the upsert the settings page performs replaces rather than accumulates', async () => {
    await withRollback(async (c) => {
      const { userId, carrierId } = await carrierFor(c, 'upsert')
      const save = (days: string, digest: boolean) =>
        c.query(
          `insert into notification_category_preferences
             (carrier_id, user_id, category, lead_days, digest)
           values ($1, $2, 'compliance', $3, $4)
           on conflict (carrier_id, user_id, category)
           do update set lead_days = excluded.lead_days, digest = excluded.digest`,
          [carrierId, userId, days, digest],
        )

      await save('{30,7,1,-1}', true)
      await save('{45,10}', false)

      const { rows } = await c.query(
        `select lead_days, digest from notification_category_preferences
          where carrier_id = $1 and user_id = $2 and category = 'compliance'`,
        [carrierId, userId],
      )
      assert.equal(rows.length, 1, 'one row, still')
      assert.deepEqual(rows[0].lead_days, [45, 10])
      assert.equal(rows[0].digest, false)
    })
  })

  test("another carrier's lead times are invisible and unwritable", async () => {
    await withRollback(async (c) => {
      const mine = await carrierFor(c, 'mine')
      const theirs = await carrierFor(c, 'theirs')

      await actAs(c, theirs.userId)
      await c.query(
        `insert into notification_category_preferences (carrier_id, user_id, category, lead_days)
         values ($1, $2, 'compliance', '{99}')`,
        [theirs.carrierId, theirs.userId],
      )

      await actAs(c, mine.userId)
      const { rows } = await c.query('select * from notification_category_preferences')
      assert.equal(rows.length, 0, 'a new table is a new chance to leak a tenant')

      // WITH CHECK, not just USING: without it a user could write a row into
      // somebody else's carrier even while unable to read it back.
      const err = await attempt(
        c,
        `insert into notification_category_preferences (carrier_id, user_id, category, lead_days)
         values ($1, $2, 'system', '{1}')`,
        [theirs.carrierId, mine.userId],
      )
      assert.ok(err, "writing into another carrier's row must be refused")
    })
  })

  test('the table is append-safe for the job: no DELETE privilege exists to misuse', async () => {
    await withRollback(async (c) => {
      const { userId, carrierId } = await carrierFor(c, 'nodelete')
      await c.query(
        `insert into notification_category_preferences (carrier_id, user_id, category, lead_days)
         values ($1, $2, 'compliance', '{30}')`,
        [carrierId, userId],
      )
      const err = await attempt(
        c,
        'delete from notification_category_preferences where carrier_id = $1',
        [carrierId],
      )
      assert.ok(err, 'authenticated has no DELETE on this table')
      assert.match(String(err?.message), /permission denied/i)
    })
  })
})

describe("0010 — item 2: a snooze speaks the rule engine's vocabulary", {
  skip: !configured(),
}, () => {
  test("the engine's subjects are accepted and the document vocabulary is not", async () => {
    await withRollback(async (c) => {
      const { carrierId } = await carrierFor(c, 'snooze')

      // Exactly the union in src/lib/rules/types.ts. 'power_unit' and 'trailer'
      // could not be stored before 0010; 'employee' had nowhere to go at all.
      for (const subject of [
        'carrier',
        'driver',
        'employee',
        'power_unit',
        'trailer',
        'terminal',
      ]) {
        await c.query(
          `insert into notification_snoozes (carrier_id, rule_code, subject_type, until)
           values ($1, $2, $3, current_date + 7)`,
          [carrierId, `rule_${subject}`, subject],
        )
      }

      // 'vehicle' is the document-filing word. A snooze that used it could never
      // match an item the engine calls a power_unit, which is exactly why
      // isSnoozed used to ignore this column.
      const err = await attempt(
        c,
        `insert into notification_snoozes (carrier_id, rule_code, subject_type, until)
         values ($1, 'r', 'vehicle', current_date + 7)`,
        [carrierId],
      )
      assert.ok(err, "'vehicle' is not a thing the rule engine has subjects for")
      assert.match(String(err?.message), /invalid input value for enum|rule_subject/i)
    })
  })

  test('the column is the new enum and is still NOT NULL', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const { rows } = await c.query(
        `select udt_name, is_nullable from information_schema.columns
          where table_schema = 'public'
            and table_name = 'notification_snoozes'
            and column_name = 'subject_type'`,
      )
      assert.equal(rows[0]?.udt_name, 'rule_subject')
      // An untyped snooze is a snooze isSnoozed cannot judge. The rename dance
      // in the migration had to re-apply this; a dropped NOT NULL would be a
      // silent regression to a decorative column.
      assert.equal(rows[0]?.is_nullable, 'NO')
    })
  })

  test('document_subject is untouched, so documents still refuse engine words', async () => {
    await withRollback(async (c) => {
      const { carrierId } = await carrierFor(c, 'docs')
      // Widening the shared enum was the other option, and this is why it was
      // refused: documents_subject_belongs_to_carrier() switches on 'vehicle'
      // and raises on anything else, so 'power_unit' would have type-checked and
      // then failed at runtime.
      const err = await attempt(
        c,
        `insert into documents (carrier_id, subject_type, subject_id, kind, storage_key)
         values ($1, 'power_unit', null, 'test', 'k/1')`,
        [carrierId],
      )
      assert.ok(err, 'document_subject must not have gained the engine values')
    })
  })
})

describe('0010 — item 4: carriers.timezone is the fallback, and it is reachable', {
  skip: !configured(),
}, () => {
  test('a new profile carries no timezone at all, so there is something to fall back FROM', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const userId = await makeUser(c, `tz-${Date.now()}-${Math.random()}@test.local`)

      // handle_new_user() does not write the column. Before 0010 the NOT NULL
      // DEFAULT filled in 'America/Los_Angeles', so every account silently
      // CLAIMED Pacific and carriers.timezone could never be consulted — the
      // fallback would have been dead code dressed up as a fix.
      const { rows } = await c.query('select timezone from profiles where id = $1', [userId])
      assert.equal(rows.length, 1, 'the signup trigger still writes a profile')
      assert.equal(rows[0].timezone, null, 'and it no longer invents a zone')
    })
  })

  test('the column accepts NULL and has no default', async () => {
    await withRollback(async (c) => {
      await actAsOwner(c)
      const { rows } = await c.query(
        `select is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'profiles' and column_name = 'timezone'`,
      )
      assert.equal(rows[0]?.is_nullable, 'YES')
      assert.equal(rows[0]?.column_default, null)
    })
  })

  test('the carrier still has one, and signup still sets it', async () => {
    await withRollback(async (c) => {
      const { carrierId } = await carrierFor(c, 'carriertz')
      const { rows } = await c.query('select timezone from carriers where id = $1', [carrierId])
      // If this ever comes back null the fallback chain has no middle step and
      // every unset profile lands on the hard-coded constant instead.
      assert.equal(rows[0].timezone, 'America/Los_Angeles')
    })
  })

  test('a person who chose a zone keeps it', async () => {
    await withRollback(async (c) => {
      const { userId } = await carrierFor(c, 'chose')
      await c.query('update profiles set timezone = $1 where id = $2', ['America/Phoenix', userId])
      const { rows } = await c.query('select timezone from profiles where id = $1', [userId])
      // The migration deliberately did NOT backfill existing Pacific rows to
      // NULL: nothing in the data distinguishes "chose Pacific" from "never
      // chose", and nulling them would move a real choice by an hour.
      assert.equal(rows[0].timezone, 'America/Phoenix')
    })
  })
})

describe('0010 — item 3: the log is why a held message must never be written', {
  skip: !configured(),
}, () => {
  test('one dedup key can exist once, whatever status it carries', async () => {
    await withRollback(async (c) => {
      const { userId, carrierId } = await carrierFor(c, 'held')
      const write = (status: string) =>
        attempt(
          c,
          `insert into notification_log
             (carrier_id, user_id, channel, category, destination, dedup_key, status)
           values ($1, $2, 'email', 'compliance', 'a@b.test', 'u|r|d1|2026-11-01|30|email', $3)`,
          [carrierId, userId, status],
        )

      await actAsOwner(c) // authenticated has no INSERT on the log; the job is privileged
      assert.equal(await write('held'), null, 'the first write lands')

      const err = await write('sent')
      assert.ok(err, 'the key is spent')
      assert.match(String(err?.message), /duplicate key|unique/i)

      // THE POINT: a held message that wrote a log row would take the key with
      // it, and the real send could then never be recorded — so the job would
      // see the key in `alreadySent` and skip the message forever. Not late.
      // Never. That is why splitForQuietHours returns held candidates to a
      // caller that writes nothing at all.
    })
  })
})
