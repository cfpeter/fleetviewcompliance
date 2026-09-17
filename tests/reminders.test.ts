/**
 * The owner's own reminders: the arithmetic, the selection, and the wall
 * between a line he typed and a rule somebody else wrote.
 *
 * Two halves. The pure half tests the advance rule and the send decision, which
 * are the two places a silent mistake costs something real — a repeat that lands
 * on the wrong date, or an email that goes twice. The database half tests what
 * only a database can be asked: that another carrier cannot see this list, and
 * that the constraints refuse rows the pages refuse.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Preference } from '../src/lib/notify/select.ts'
import {
  DEFAULT_REMINDER_LEAD_DAYS,
  isRepeatMonths,
  nextCycle,
  parseDueOn,
  parseReminderLeadDays,
  parseTitle,
  REMINDER_ORIGIN,
  type ReminderItem,
  type ReminderRow,
  reminderEmailLine,
  reminderStatus,
  reminderWindows,
  selectReminders,
  subjectOf,
  toReminderItem,
} from '../src/lib/reminders.ts'
import {
  actAs,
  actAsOwner,
  attempt,
  configured,
  makeCarrier,
  makeUser,
  withRollback,
} from './helpers.ts'

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`)

// --- the repeat rule --------------------------------------------------------

test('a yearly reminder done late still renews on its own date', () => {
  // Due 1 March, paid on the 20th. The policy renews on 1 March next year, not
  // on the day he got round to it — counting from today would walk the date
  // forward through the years and eventually move it into a different month.
  const next = nextCycle(utc('2026-03-01'), 12, utc('2026-03-20'))
  assert.equal(next.toISOString().slice(0, 10), '2027-03-01')
})

test('a monthly repeat clamps backward into a short month', () => {
  // 31 January + 1 month is 28 February, never 3 March. A date this product
  // moves must never move LATER than the owner meant.
  const next = nextCycle(utc('2026-01-31'), 1, utc('2026-01-31'))
  assert.equal(next.toISOString().slice(0, 10), '2026-02-28')
})

test('done today moves strictly past today, never onto it', () => {
  // Landing on today would leave the reminder open, due now, one press after he
  // cleared it — the button visibly doing nothing.
  const next = nextCycle(utc('2026-06-15'), 1, utc('2026-06-15'))
  assert.equal(next.toISOString().slice(0, 10), '2026-07-15')
})

test('a reminder three cycles behind produces ONE next date, not three', () => {
  const next = nextCycle(utc('2023-04-10'), 12, utc('2026-09-16'))
  assert.equal(next.toISOString().slice(0, 10), '2027-04-10')
})

test('a quarterly repeat lands on the same day of the month all year', () => {
  let on = utc('2026-01-15')
  const seen: string[] = []
  for (let i = 0; i < 4; i++) {
    on = nextCycle(on, 3, utc('2020-01-01'))
    seen.push(on.toISOString().slice(0, 10))
  }
  assert.deepEqual(seen, ['2026-04-15', '2026-07-15', '2026-10-15', '2027-01-15'])
})

test('only the offered intervals are accepted', () => {
  for (const good of [0, 1, 3, 6, 12]) assert.equal(isRepeatMonths(good), true)
  // 24 is not on the list and the check constraint refuses it; a page that let
  // it through would store a repeat no label on any screen names.
  for (const bad of [2, 5, 24, -12]) assert.equal(isRepeatMonths(bad), false)
})

// --- standing ---------------------------------------------------------------

test('a date in the past is overdue, today is not', () => {
  const today = utc('2026-09-16')
  assert.equal(reminderStatus(utc('2026-09-15'), today).standing, 'overdue')
  // Due today is still current. A reminder is late the day AFTER, the same
  // boundary every other date in this product uses.
  assert.equal(reminderStatus(utc('2026-09-16'), today).standing, 'current')
  assert.equal(reminderStatus(utc('2026-09-17'), today).standing, 'current')
})

test('an overdue reminder carries the date it was due, so the date line reads', () => {
  // `dueLine` prints "was due {lastDue ?? nextDue}". Without lastDue an overdue
  // reminder would print the em dash that means "no date at all".
  const s = reminderStatus(utc('2026-01-02'), utc('2026-09-16'))
  assert.equal(s.lastDue?.toISOString().slice(0, 10), '2026-01-02')
})

// --- what the form accepts --------------------------------------------------

test('a blank title is refused and a long one is refused', () => {
  assert.equal(parseTitle('   ').ok, false)
  assert.equal(parseTitle('x'.repeat(121)).ok, false)
  const ok = parseTitle('  Pay truck insurance  ')
  assert.equal(ok.ok && ok.value, 'Pay truck insurance')
})

test('a past due date is ACCEPTED', () => {
  // "I should have done this last week" is a real thing to write down. It shows
  // up overdue, in red, which is exactly what he meant.
  assert.equal(parseDueOn('2019-01-01').ok, true)
})

test('a date that is not a day is refused', () => {
  // These match the pattern and are not days. Postgres would answer them with
  // "invalid input syntax for type date" across the top of his screen.
  for (const bad of ['', '2026-02-31', '2026-13-01', 'tomorrow', '26-01-01']) {
    assert.equal(parseDueOn(bad).ok, false, `${bad} must be refused`)
  }
  assert.equal(parseDueOn('1999-01-01').ok, false, 'a year four digits wrong is a typo')
})

test('an empty lead-days box means the default, not zero', () => {
  const blank = parseReminderLeadDays('')
  assert.equal(blank.ok && blank.value, DEFAULT_REMINDER_LEAD_DAYS)
  // Zero is a real answer and different from blank: tell me on the day.
  const zero = parseReminderLeadDays('0')
  assert.equal(zero.ok && zero.value, 0)
  for (const bad of ['-1', '400', 'seven', '7 days']) {
    assert.equal(parseReminderLeadDays(bad).ok, false, `${bad} must be refused`)
  }
})

// --- the windows ------------------------------------------------------------

test('every reminder is also warned on the day and one day late', () => {
  // A reminder that warns a month early and then goes silent on the day is
  // worse than no reminder at all.
  assert.deepEqual(reminderWindows(30), [30, 0, -1])
  // 0 typed by hand must not produce a duplicate window: one warning, not two
  // identical emails on the same morning.
  assert.deepEqual(reminderWindows(0), [0, -1])
})

// --- choosing what to send --------------------------------------------------

function item(over: Partial<ReminderItem> & { dueOn: Date; id: string }): ReminderItem {
  const today = utc('2026-09-16')
  const row: ReminderRow = {
    id: over.id,
    title: over.title ?? 'Pay truck insurance',
    note: null,
    due_on: over.dueOn.toISOString().slice(0, 10),
    repeat_months: 0,
    lead_days: over.leadDays ?? 7,
    driver_id: null,
    vehicle_id: null,
    completed_at: null,
    last_done_on: null,
  }
  const built = toReminderItem(row, today)
  assert.ok(built)
  return { ...built, ...over }
}

const emailOn: Preference[] = [{ category: 'reminder', channel: 'email', enabled: true }]

test('nothing is sent before the window is reached', () => {
  const out = selectReminders({
    items: [item({ id: 'a', dueOn: utc('2026-12-01'), leadDays: 7 })],
    recipient: { userId: 'u1', email: 'o@example.com' },
    preferences: emailOn,
    alreadySent: new Set(),
  })
  assert.equal(out.length, 0)
})

test('one message, at the most urgent window reached', () => {
  // Two windows are behind us (7 and 0) because the job did not run. He gets ONE
  // email about the most urgent, not two about both.
  const out = selectReminders({
    items: [item({ id: 'a', dueOn: utc('2026-09-16'), leadDays: 7 })],
    recipient: { userId: 'u1', email: 'o@example.com' },
    preferences: emailOn,
    alreadySent: new Set(),
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].leadDays, 0)
  assert.equal(out[0].channel, 'email')
})

test('a key already sent is not sent again', () => {
  const first = selectReminders({
    items: [item({ id: 'a', dueOn: utc('2026-09-20'), leadDays: 7 })],
    recipient: { userId: 'u1', email: 'o@example.com' },
    preferences: emailOn,
    alreadySent: new Set(),
  })
  assert.equal(first.length, 1)

  const again = selectReminders({
    items: [item({ id: 'a', dueOn: utc('2026-09-20'), leadDays: 7 })],
    recipient: { userId: 'u1', email: 'o@example.com' },
    preferences: emailOn,
    alreadySent: new Set([first[0].dedupKey]),
  })
  assert.equal(again.length, 0, 'an overdue reminder must not email every morning')
})

test('the key carries the due date, so next cycle is a new message', () => {
  // A repeating reminder moves its date when Done is pressed. If the key did not
  // carry the date, the key spent this year would silence next year's warning
  // for the same reminder — not late, never.
  const pick = (due: string, leadDays: number) =>
    selectReminders({
      items: [item({ id: 'a', dueOn: utc(due), leadDays })],
      recipient: { userId: 'u1', email: 'o@example.com' },
      preferences: emailOn,
      alreadySent: new Set(),
    })[0].dedupKey

  const thisCycle = pick('2026-09-20', 7)
  // A year out, inside a deliberately wide window so there is a key to compare.
  const nextCycleKey = pick('2027-09-01', 365)
  assert.notEqual(thisCycle, nextCycleKey)
  assert.match(thisCycle, /\|2026-09-20\|/)
})

test('turning reminders off in settings stops them', () => {
  const out = selectReminders({
    items: [item({ id: 'a', dueOn: utc('2026-09-16') })],
    recipient: { userId: 'u1', email: 'o@example.com' },
    preferences: [{ category: 'reminder', channel: 'email', enabled: false }],
    alreadySent: new Set(),
  })
  assert.equal(out.length, 0)
})

test('a customer who has never seen this setting still gets reminders', () => {
  // The rule that decides whether this feature ships switched on. Every existing
  // carrier has preference rows for the three older categories and none for this
  // one; reading that as "off" would mean silence, forever, with the settings
  // page showing a ticked box.
  const out = selectReminders({
    items: [item({ id: 'a', dueOn: utc('2026-09-16') })],
    recipient: { userId: 'u1', email: 'o@example.com' },
    preferences: [
      { category: 'compliance', channel: 'email', enabled: true },
      { category: 'federal', channel: 'email', enabled: false },
    ],
    alreadySent: new Set(),
  })
  assert.equal(out.length, 1)
})

test('a recipient with no email address gets nothing', () => {
  const out = selectReminders({
    items: [item({ id: 'a', dueOn: utc('2026-09-16') })],
    recipient: { userId: 'u1' },
    preferences: emailOn,
    alreadySent: new Set(),
  })
  assert.equal(out.length, 0)
})

test('the most urgent reminder leads the list', () => {
  const out = selectReminders({
    items: [
      item({ id: 'later', dueOn: utc('2026-09-20'), leadDays: 30 }),
      item({ id: 'late', dueOn: utc('2026-08-01'), leadDays: 30 }),
    ],
    recipient: { userId: 'u1', email: 'o@example.com' },
    preferences: emailOn,
    alreadySent: new Set(),
  })
  assert.deepEqual(
    out.map((c) => c.item.id),
    ['late', 'later'],
  )
})

// --- the wall between a reminder and a rule ---------------------------------

test('an emailed reminder says it is not a rule, where a rule prints its citation', () => {
  const line = reminderEmailLine(item({ id: 'a', dueOn: utc('2026-08-01') }))
  assert.match(line, /not a rule/i)
  // A skimmed email must not read as something the government sent him.
  assert.match(line, /LATE since 2026-08-01/)
  assert.doesNotMatch(line, /CFR/)
})

test('the badge that replaces the citation says whose it is', () => {
  assert.equal(REMINDER_ORIGIN.label, 'Your reminder')
})

test('a reminder with no driver and no truck belongs to the company', () => {
  const base: ReminderRow = {
    id: 'a',
    title: 'Renew MC permit',
    note: null,
    due_on: '2026-10-01',
    repeat_months: 12,
    lead_days: 30,
    driver_id: null,
    vehicle_id: null,
    completed_at: null,
    last_done_on: null,
  }
  assert.equal(subjectOf(base).kind, 'carrier')
  assert.equal(subjectOf(base).href, null)

  const driver = subjectOf({
    ...base,
    driver_id: '11111111-1111-1111-1111-111111111111',
    drivers: { first_name: 'Ana', last_name: 'Ruiz' },
  })
  assert.equal(driver.label, 'Ana Ruiz')
  assert.equal(driver.href, '/app/drivers/11111111-1111-1111-1111-111111111111')

  // PostgREST hands a many-to-one embed back as an array on some versions.
  const truck = subjectOf({
    ...base,
    vehicle_id: '22222222-2222-2222-2222-222222222222',
    vehicles: [{ unit_number: '204', vin: null }],
  })
  assert.equal(truck.label, '204')
})

// --- the database -----------------------------------------------------------

if (!configured()) {
  console.error(
    '\n  ⚠  SKIPPING reminder database tests: no database configured.\n' +
      '     Until these run, nothing about reminder tenancy has been demonstrated.\n',
  )
}

describe('reminders in the database', { skip: !configured() }, () => {
  /** A carrier owned by a fresh user, with one driver and one truck. */
  async function fixture(
    c: Parameters<Parameters<typeof withRollback>[0]>[0],
    tag: string,
    dot: string,
  ) {
    await actAsOwner(c)
    const user = await makeUser(c, `rem-${tag}-${Date.now()}@test.local`)
    await actAs(c, user)
    const carrierId = await makeCarrier(c, dot, `REMINDER ${tag}`)
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

  /** The head of every insert below: the columns, in one place. */
  const add = (extra = '') =>
    `insert into reminders (carrier_id, title, due_on${extra ? `, ${extra}` : ''})`

  test('a reminder is visible to its own carrier and to nobody else', async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'a', `71${Date.now() % 100000}`)
      await c.query(`${add()} values ($1,'Pay insurance','2026-10-01')`, [mine.carrierId])

      await fixture(c, 'b', `72${Date.now() % 100000}`)
      // Acting as the OTHER carrier's owner now.
      const { rows } = await c.query('select id from reminders')
      assert.equal(rows.length, 0, 'another carrier must not see this list at all')

      // And cannot write into it either, even naming the carrier correctly: the
      // WITH CHECK half of the policy is what refuses this.
      const refused = await attempt(c, `${add()} values ($1,'Sneaky','2026-10-01')`, [
        mine.carrierId,
      ])
      assert.ok(refused, "writing into another carrier's list must be refused")

      await actAs(c, mine.user)
      const { rows: own } = await c.query('select title from reminders')
      assert.equal(own.length, 1)
      assert.equal(own[0].title, 'Pay insurance')
    })
  })

  test("a reminder cannot point at another carrier's driver", async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'c', `73${Date.now() % 100000}`)
      const theirs = await fixture(c, 'd', `74${Date.now() % 100000}`)

      await actAs(c, mine.user)
      // RLS checks carrier_id and nothing else, so without the trigger this row
      // is mine by the policy's reckoning and points into their fleet.
      const refused = await attempt(
        c,
        `${add('driver_id')} values ($1,'Medical card','2026-10-01',$2)`,
        [mine.carrierId, theirs.driverId],
      )
      assert.ok(refused, 'a driver from another carrier must be refused')

      const ok = await attempt(
        c,
        `${add('driver_id')} values ($1,'Medical card','2026-10-01',$2)`,
        [mine.carrierId, mine.driverId],
      )
      assert.equal(ok, null, 'my own driver must still be accepted')
    })
  })

  test('a reminder is about one thing at most', async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'e', `75${Date.now() % 100000}`)
      const refused = await attempt(
        c,
        `${add('driver_id, vehicle_id')} values ($1,'Both','2026-10-01',$2,$3)`,
        [mine.carrierId, mine.driverId, mine.vehicleId],
      )
      assert.ok(refused, 'a row about a driver AND a truck has no honest label')
    })
  })

  test('the database refuses what the form refuses', async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'f', `76${Date.now() % 100000}`)

      const blank = await attempt(c, `${add()} values ($1,'   ','2026-10-01')`, [mine.carrierId])
      assert.ok(blank, 'a blank title renders as an empty line beside a federal deadline')

      const wildLead = await attempt(c, `${add('lead_days')} values ($1,'Far','2026-10-01',400)`, [
        mine.carrierId,
      ])
      assert.ok(wildLead, 'a warning further out than a year is not a warning')

      const oddRepeat = await attempt(
        c,
        `${add('repeat_months')} values ($1,'Odd','2026-10-01',5)`,
        [mine.carrierId],
      )
      assert.ok(oddRepeat, 'an interval no screen names must not be storable')
    })
  })

  test('a repeating reminder cannot be quietly closed', async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'g', `77${Date.now() % 100000}`)
      const { rows } = await c.query(
        `${add('repeat_months')} values ($1,'Insurance','2026-10-01',12) returning id`,
        [mine.carrierId],
      )
      // Done on a repeating reminder MOVES it. Closing it would take it off the
      // list for good with nothing on screen saying the repeat had stopped.
      const refused = await attempt(c, `update reminders set completed_at = now() where id = $1`, [
        rows[0].id,
      ])
      assert.ok(refused, 'closing a repeating reminder must be impossible')

      const moved = await attempt(
        c,
        `update reminders set due_on = '2027-10-01', last_done_on = current_date where id = $1`,
        [rows[0].id],
      )
      assert.equal(moved, null, 'advancing it is the supported way to finish a cycle')
    })
  })

  test('a one-time reminder closes, opens again, and can be deleted', async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'h', `78${Date.now() % 100000}`)
      const { rows } = await c.query(
        `${add()} values ($1,'Call the broker','2026-10-01') returning id`,
        [mine.carrierId],
      )
      const id = rows[0].id

      await c.query(`update reminders set completed_at = now() where id = $1`, [id])
      await c.query(`update reminders set completed_at = null where id = $1`, [id])

      // A real DELETE, unlike a compliance record. This is his own list, not
      // evidence anybody is entitled to inspect.
      await c.query(`delete from reminders where id = $1`, [id])
      const { rows: left } = await c.query(`select id from reminders where id = $1`, [id])
      assert.equal(left.length, 0)
    })
  })

  test('removing a truck removes the reminder that was about it', async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'i', `79${Date.now() % 100000}`)
      await c.query(`${add('vehicle_id')} values ($1,'Truck payment','2026-10-01',$2)`, [
        mine.carrierId,
        mine.vehicleId,
      ])
      await c.query(`delete from vehicles where id = $1`, [mine.vehicleId])
      const { rows } = await c.query('select id from reminders')
      // Left behind with a null vehicle it would silently re-label itself as a
      // company-wide reminder — a wrong answer that looks exactly like a right one.
      assert.equal(rows.length, 0)
    })
  })

  test('the notification tables accept the new category', async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c, 'j', `80${Date.now() % 100000}`)
      const ok = await attempt(
        c,
        `insert into notification_preferences (carrier_id, user_id, category, channel, enabled)
         values ($1, $2, 'reminder', 'email', true)`,
        [mine.carrierId, mine.user],
      )
      assert.equal(ok, null, 'the digest logs reminder sends under their own category')
    })
  })
})
