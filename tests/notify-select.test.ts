import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type CategoryPreference,
  deservesSms,
  isCritical,
  isSnoozed,
  type Preference,
  reachedWindow,
  selectForRecipient,
  splitForQuietHours,
} from '../src/lib/notify/select.ts'
import { utcDate } from '../src/lib/rules/dates.ts'
import type { DeadlineItem } from '../src/lib/rules/index.ts'

const TODAY = utcDate(2026, 9, 15)

const mk = (over: Partial<DeadlineItem> & { days?: number; due?: Date }): DeadlineItem =>
  ({
    rule: { code: over.rule?.code ?? 'r1', title: 'A rule' },
    subjectType: 'driver',
    subjectId: 'd1',
    subjectLabel: 'A Driver',
    status: {
      standing: over.status?.standing ?? 'current',
      nextDue: over.due ?? utcDate(2026, 10, 15),
    },
    daysUntil: over.days ?? 30,
    ...over,
  }) as unknown as DeadlineItem

const pref = (o: Partial<Preference> = {}): Preference => ({
  category: 'compliance',
  channel: 'email',
  enabled: true,
  ...o,
})

/** Lead times live on their own table since 0010_cleanup.sql. */
const catPref = (o: Partial<CategoryPreference> = {}): CategoryPreference => ({
  category: 'compliance',
  leadDays: [30, 7, 1, -1],
  digest: true,
  ...o,
})

/** `mk` builds driver items, so a snooze about one says 'driver'. */
const snooze = (o: Partial<Parameters<typeof isSnoozed>[1][number]> = {}) => ({
  ruleCode: 'r1',
  subjectType: 'driver' as const,
  subjectId: 'd1',
  until: utcDate(2026, 9, 30),
  ...o,
})

const recipient = { userId: 'u1', email: 'a@b.test', phone: '+13105550101', timezone: 'UTC' }

const run = (
  items: DeadlineItem[],
  extra: Partial<Parameters<typeof selectForRecipient>[0]> = {},
) =>
  selectForRecipient({
    items,
    recipient,
    preferences: [pref()],
    categoryPreferences: [catPref()],
    snoozes: [],
    alreadySent: new Set(),
    today: TODAY,
    ...extra,
  })

// ---------------------------------------------------------------- windows

test('the most urgent reached window wins, not every reached one', () => {
  // If the job does not run for a week, an item that blew past the 30-day AND
  // the 7-day marks sends ONE message about seven days. Telling somebody the
  // same thing twice in one morning is how the mute happens.
  assert.equal(reachedWindow(6, [30, 7, 1, -1]), 7)
  assert.equal(reachedWindow(6, [30, 7]), 7)
  assert.equal(reachedWindow(31, [30, 7]), null, 'nothing reached yet')
  assert.equal(reachedWindow(30, [30, 7]), 30, 'exactly on the window counts')
})

test('overdue reaches the negative window', () => {
  assert.equal(reachedWindow(-3, [30, 7, 1, -1]), -1)
})

// ---------------------------------------------------------------- selection

test('an item outside every window sends nothing', () => {
  assert.equal(run([mk({ days: 90 })]).length, 0)
})

test('an item inside a window sends once', () => {
  const c = run([mk({ days: 5 })])
  assert.equal(c.length, 1)
  assert.equal(c[0].leadDays, 7)
})

test('the same message is never sent twice', () => {
  const first = run([mk({ days: 5 })])
  const second = run([mk({ days: 5 })], { alreadySent: new Set([first[0].dedupKey]) })
  assert.equal(second.length, 0, 'the dedup key must suppress the repeat')
})

test('an item we cannot date is never alerted on', () => {
  // "We still do not know" every morning is the purest form of nagging. It
  // belongs in the digest summary, not in a dated alert.
  const undated = mk({ days: undefined, status: { standing: 'unknown' } } as never)
  assert.equal(run([undated]).length, 0)
})

test('a snoozed item stays quiet until the snooze lapses', () => {
  const item = mk({ days: 5 })
  assert.equal(run([item], { snoozes: [snooze()] }).length, 0)

  const expired = [snooze({ until: utcDate(2026, 9, 1) })]
  assert.equal(run([item], { snoozes: expired }).length, 1, 'a lapsed snooze stops suppressing')
})

test('a snooze is per item, not per rule across the whole fleet', () => {
  // Snoozing one driver's medical card must not silence every other driver's.
  const items = [mk({ days: 5 }), mk({ days: 5, subjectId: 'd2' } as never)]
  const c = run(items, { snoozes: [snooze()] })
  assert.equal(c.length, 1)
  assert.equal(c[0].item.subjectId, 'd2')
})

// ------------------------------------------------- the snooze subject type

test('a snooze from the wrong vocabulary does NOT suppress', () => {
  // The bug 0010_cleanup.sql fixes. The column held `document_subject` values —
  // 'vehicle' where the engine says 'power_unit' — and isSnoozed ignored it
  // entirely, which is the only reason nothing broke. Now that it is compared, a
  // row from the old vocabulary fails to match, and failing to match means we
  // NAG about an item somebody set aside. That is the survivable error; the
  // other direction silences a deadline nobody meant to silence.
  const tractor = mk({ days: 5, subjectType: 'power_unit', subjectId: 'v1' } as never)
  const old = [snooze({ subjectType: 'vehicle' as never, subjectId: 'v1' })]
  assert.equal(isSnoozed(tractor, old, TODAY), false)

  const migrated = [snooze({ subjectType: 'power_unit' as never, subjectId: 'v1' })]
  assert.equal(isSnoozed(tractor, migrated, TODAY), true)
})

test('a tractor snooze does not silence the trailer that shares its rule code', () => {
  // The two halves of a rig are different subjects with different obligations,
  // and before 0010 both stored subject_type = 'vehicle'.
  const trailer = mk({ days: 5, subjectType: 'trailer', subjectId: 'v1' } as never)
  const onTheTractor = [snooze({ subjectType: 'power_unit' as never, subjectId: 'v1' })]
  assert.equal(isSnoozed(trailer, onTheTractor, TODAY), false)
})

// ------------------------------------------------- lead times by category

test('lead times come from the category row, not from a channel row', () => {
  // Before 0010 every channel row carried its own copy of this array, so one
  // category could hold three disagreeing answers and the screen showed whichever
  // it read first. There is now one row and therefore one answer.
  const c = run([mk({ days: 5 })], { categoryPreferences: [catPref({ leadDays: [3] })] })
  assert.equal(c.length, 0, '5 days out has not reached a 3-day window')

  const wider = run([mk({ days: 5 })], { categoryPreferences: [catPref({ leadDays: [10] })] })
  assert.equal(wider.length, 1)
  assert.equal(wider[0].leadDays, 10)
})

test('a category with no row of its own gets the default, never silence', () => {
  // `[]` means "warn me never". Arriving there because a row has not been
  // written yet is a deadline passing while the settings page still shows
  // 30, 7, 1, -1 — so an absent row falls back to the documented list.
  const c = run([mk({ days: 5 })], { categoryPreferences: [] })
  assert.equal(c.length, 1)
  assert.equal(c[0].leadDays, 7)
})

test('a disabled preference sends nothing', () => {
  assert.equal(run([mk({ days: 5 })], { preferences: [pref({ enabled: false })] }).length, 0)
})

test('a channel with no destination is skipped rather than erroring', () => {
  const noPhone = { ...recipient, phone: undefined }
  const c = selectForRecipient({
    items: [mk({ days: 5 })],
    recipient: noPhone,
    preferences: [pref({ channel: 'sms' })],
    snoozes: [],
    alreadySent: new Set(),
    today: TODAY,
  })
  assert.equal(c.length, 0)
})

test('candidates come out most urgent first', () => {
  const c = run([mk({ days: 6 }), mk({ days: -2, rule: { code: 'r2' } } as never)])
  assert.ok((c[0].item.daysUntil ?? 0) < (c[1].item.daysUntil ?? 0))
})

// ---------------------------------------------------------------- sms rationing

test('SMS is reserved for overdue and tomorrow', () => {
  assert.equal(deservesSms(mk({ status: { standing: 'overdue' } } as never)), true)
  assert.equal(deservesSms(mk({ days: 1 })), true)
  assert.equal(deservesSms(mk({ days: 30 })), false, 'a month out is an email, not a text')
})

test('"critical" for quiet hours is the SAME rule as SMS rationing', () => {
  // Written twice, the two definitions drift, and then the settings page's
  // promise — "anything already overdue, and anything due tomorrow" — is true of
  // one of them and a lie about the other.
  assert.equal(isCritical, deservesSms)
})

// ---------------------------------------------------------------- quiet hours

const QUIET = { fromMinutes: 22 * 60, toMinutes: 7 * 60, allowCritical: true }
const urgent = () => run([mk({ days: 0, rule: { code: 'r2' } } as never)])[0]
const routine = () => run([mk({ days: 5 })])[0]

test('outside the quiet window everything goes', () => {
  const both = [urgent(), routine()]
  const { deliver, held } = splitForQuietHours(both, { ...QUIET, nowLocalMinutes: 9 * 60 })
  assert.equal(deliver.length, 2)
  assert.equal(held.length, 0)
})

test('inside the window the routine one waits and the urgent one breaks through', () => {
  const both = [urgent(), routine()]
  const { deliver, held } = splitForQuietHours(both, { ...QUIET, nowLocalMinutes: 2 * 60 })
  assert.equal(deliver.length, 1)
  assert.equal(deliver[0].item.daysUntil, 0, 'due today is what breaks through')
  assert.equal(held.length, 1)
  assert.equal(held[0].item.daysUntil, 5)
})

test('the breakthrough is per ITEM, not per message', () => {
  // One morning's email can carry a lapsed medical card and a registration due
  // in a month. Deciding the whole message on its most urgent line would push
  // the month-away item through quiet hours on the back of the lapsed one.
  const { deliver, held } = splitForQuietHours([routine(), urgent(), routine()], {
    ...QUIET,
    nowLocalMinutes: 3 * 60,
  })
  assert.equal(deliver.length, 1)
  assert.equal(held.length, 2)
})

test('unticking the breakthrough holds even the overdue ones', () => {
  const { deliver, held } = splitForQuietHours([urgent(), routine()], {
    ...QUIET,
    allowCritical: false,
    nowLocalMinutes: 2 * 60,
  })
  assert.equal(deliver.length, 0)
  assert.equal(held.length, 2)
})

test('a clock we cannot read SENDS rather than holds', () => {
  // `nowLocalMinutes: null` is an unresolvable timezone string. A profile
  // holding junk must not quietly become a person who is never told anything —
  // a badly timed email is an annoyance, an unsent one is the deadline we exist
  // to prevent.
  const { deliver, held } = splitForQuietHours([routine()], { ...QUIET, nowLocalMinutes: null })
  assert.equal(deliver.length, 1)
  assert.equal(held.length, 0)
})

test('no quiet hours set holds nothing', () => {
  const { held } = splitForQuietHours([routine()], {
    fromMinutes: null,
    toMinutes: null,
    allowCritical: true,
    nowLocalMinutes: 3 * 60,
  })
  assert.equal(held.length, 0)
})

test('held and delivered are a partition: nothing is lost and nothing is duplicated', () => {
  const all = [urgent(), routine()]
  const { deliver, held } = splitForQuietHours(all, { ...QUIET, nowLocalMinutes: 23 * 60 })
  const keys = [...deliver, ...held].map((c) => c.dedupKey).sort()
  assert.deepEqual(keys, all.map((c) => c.dedupKey).sort())
  for (const h of held) {
    assert.ok(
      !deliver.some((d) => d.dedupKey === h.dedupKey),
      'a held candidate must not also be delivered — the sender is the only thing that logs',
    )
  }
})

test('a held message is NOT deduped away: the next run offers it again', () => {
  // The trap this whole design exists to avoid. `notification_log.dedup_key` is
  // unique and the job treats every key in that table as handled, whatever the
  // row's status says. If a hold were logged, the message would never arrive —
  // not late, NEVER. So a hold writes nothing, and the only evidence it is
  // recoverable is that selection produces it again from scratch.
  const first = routine()
  const { deliver, held } = splitForQuietHours([first], { ...QUIET, nowLocalMinutes: 2 * 60 })
  assert.equal(held.length, 1)

  // Only DELIVERED candidates ever reach notification_log, so the set of keys
  // the next run sees as already sent is built from `deliver` alone.
  const alreadySent = new Set(deliver.map((c) => c.dedupKey))
  const tomorrow = run([mk({ days: 5 })], { alreadySent })
  assert.equal(tomorrow.length, 1, 'the held item is still a candidate the next morning')
  assert.equal(tomorrow[0].dedupKey, first.dedupKey, 'and it is the same message, not a new one')
})
