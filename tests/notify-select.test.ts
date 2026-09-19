import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_LEAD_DAYS, isDefaultLeadDays } from '../src/lib/notify/preferences.ts'
import {
  type CategoryPreference,
  deservesSms,
  isCritical,
  isSnoozed,
  leadDaysForItem,
  type Preference,
  reachedWindow,
  selectForRecipient,
  splitForQuietHours,
} from '../src/lib/notify/select.ts'
import { utcDate } from '../src/lib/rules/dates.ts'
import { type DeadlineItem, evaluate } from '../src/lib/rules/index.ts'

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

test('a finished one-time obligation never earns a message, on any channel', () => {
  /**
   * The worst reachable form of one bug, and the reason it was fixed in
   * `status` rather than in each chart that tripped over it.
   *
   * A one-time obligation anchored to employment used to come back `current`
   * with the HIRE DATE as its next due date, so a road test passed in 2021
   * arrived here with `daysUntil` around -2040. Every comparison against a
   * window is then true:
   *
   *   reachedWindow(-2040, [30, 7, 1, -1]) === -1   — the overdue nag fires
   *   deservesSms(-2040)                   === true — and it goes out by TEXT,
   *                                                   which `isCritical` lets
   *                                                   through quiet hours
   *
   * So a carrier signing up on a Sunday night would have been woken by texts
   * about paperwork his drivers completed years ago. The dashboard's amber tile
   * was the visible symptom of the same arithmetic; this was the expensive one,
   * and it is the one that leaves the building.
   *
   * Both halves are asserted. The guard above (`daysUntil === undefined`) is
   * what catches it now, but the reason it catches it is that `status` stopped
   * inventing the date — so the raw window arithmetic is pinned too, to say
   * plainly that it is NOT what makes this safe.
   */
  // Built by the ENGINE, not by hand. A hand-built item would assert only that
  // the `daysUntil === undefined` guard below works, and would go on passing if
  // `status` started inventing the hire date again — which is precisely how
  // this reached production while four other call sites were being patched.
  const done = evaluate(
    [
      {
        type: 'driver',
        id: 'd1',
        label: 'Miguel Arellano',
        context: { carrierOperation: 'A', cdl: true },
        anchors: { hire_date: utcDate(2021, 2, 15) },
        lastDone: { road_test_or_equivalent: utcDate(2021, 2, 15) },
      },
    ],
    TODAY,
  ).find((i) => i.rule.code === 'road_test_or_equivalent')

  assert.ok(done, 'the road test must still be on the list')
  assert.equal(done.status.standing, 'current', 'it is done')
  assert.equal(done.daysUntil, undefined, 'a satisfied one-time has no countdown')
  assert.equal(done.status.nextDue, undefined, 'and no next date')

  assert.deepEqual(
    run([done], { preferences: [pref({ channel: 'email' }), pref({ channel: 'sms' })] }),
    [],
    'a completed obligation was queued for delivery',
  )
  assert.equal(deservesSms(done), false, 'and it must not read as critical')
  assert.equal(isCritical(done), false)

  // The arithmetic this used to be fed. Left here deliberately: it still says
  // yes, and always will — the past passes every window. Nothing may rely on
  // `reachedWindow` to reject a finished item.
  assert.equal(reachedWindow(-2040, [30, 7, 1, -1]), -1)
  assert.equal(deservesSms({ status: { standing: 'current' }, daysUntil: -2040 }), true)
})

// -------------------------------------------------- both sides of zero

/**
 * The guard that must not be removed.
 *
 * `daysUntil <= d` is true of EVERY window in a list once the date is behind us,
 * so a date long past reaches the widest window on the row and comes back as a
 * warning about something months away. It only ever looked harmless because
 * every list in production happened to end in -1, which made the minimum come
 * out negative by luck. A rule's own window list is not required to end in -1 —
 * `[30]` and `[90]` are both real rows in the catalogue — and the moment one of
 * those is used, a lapsed date is announced as a 90-day heads-up and
 * `deservesSms` reads the same item as critical and texts it through quiet
 * hours. If these assertions go red, that path is open again.
 */
test('a date already behind us cannot reach a window in front of us', () => {
  assert.equal(reachedWindow(-2040, [90]), null, 'five years past is not a 90-day warning')
  assert.equal(reachedWindow(-1, [30]), null)
  assert.equal(
    reachedWindow(-3, [30, 7, 1]),
    null,
    'no post-lapse window, so no post-lapse message',
  )

  // And the other side of zero, which is the half that keeps working.
  assert.equal(reachedWindow(-3, [90, 45, 14, -1]), -1)
  assert.equal(reachedWindow(-40, [90, -1, -30]), -30, 'the most urgent nudge, not the first')
})

test('due today is not overdue', () => {
  // Zero belongs with the future, not with the past: the deadline has not gone
  // by yet, and a post-lapse nudge on the day itself would be a lie.
  assert.equal(reachedWindow(0, [30, 7, 1, -1]), 1)
  assert.equal(reachedWindow(0, [14, 7, 0, -7]), 0, 'a window of 0 is "on the day"')
  assert.equal(reachedWindow(0, [-1]), null)
})

// -------------------------------------------------- the rule's own window

/**
 * An item carrying a rule row's hand-tuned warning window.
 *
 * `status` is rebuilt rather than passed through: `mk` spreads the override last,
 * so naming a standing there would drop `nextDue` with it and the item would be
 * skipped as undated long before any window was consulted.
 */
const withWindows = (
  windows: number[],
  over: { days?: number; standing?: DeadlineItem['status']['standing'] } = {},
): DeadlineItem =>
  mk({
    days: over.days,
    status: { standing: over.standing ?? 'current', nextDue: utcDate(2026, 10, 15) },
    rule: {
      code: 'medical_certificate_general',
      title: 'Medical certificate',
      warningDays: windows,
    },
  } as never)

/** A medical card: 90 days, because a DOT physical is an appointment. */
const MEDICAL = [90, 45, 14, -1]

test('a rule with a long window is warned about at its own distance', () => {
  // The defect. All 51 rules carry a window chosen for how long the remedy
  // takes, nothing read it, and a medical certificate was first mentioned at 30
  // days — the same as a fee you can pay online in an afternoon.
  const c = run([withWindows(MEDICAL, { days: 80 })])
  assert.equal(c.length, 1, '80 days out has reached the 90-day window on the rule')
  assert.equal(c[0].leadDays, 90)
})

test('the rule window is added to the ladder, never swapped for it', () => {
  // A 90-day warning that then goes quiet until the deadline is worse than the
  // flat 30 it replaced. The point is an earlier warning, not a lonelier one.
  const item = (days: number) => run([withWindows(MEDICAL, { days })])[0]

  assert.equal(item(80).leadDays, 90)
  assert.equal(item(40).leadDays, 45)
  assert.equal(item(20).leadDays, 30, 'the default rung survives the merge')
  assert.equal(item(5).leadDays, 7, 'and so do the near ones')
  assert.equal(item(1).leadDays, 1)

  // Stated as the property, because it is the property that matters: the merged
  // ladder can only ever be a superset of the one in use today, so no item comes
  // out of this change with fewer warnings than it gets now.
  for (const d of DEFAULT_LEAD_DAYS) {
    assert.ok(
      leadDaysForItem(withWindows(MEDICAL), DEFAULT_LEAD_DAYS).includes(d),
      `the merge dropped the ${d}-day window`,
    )
  }
})

test('a window longer than a year is not a window', () => {
  // The same cap `parseLeadDays` puts on what a person types, for the same
  // reason: `reachedWindow` fires as soon as daysUntil <= lead, so a window
  // longer than the obligation's own cycle is reached permanently — an annual
  // item would alert the morning it was renewed and every morning after.
  assert.deepEqual(leadDaysForItem(withWindows([400, 90]), DEFAULT_LEAD_DAYS), [90, 30, 7, 1, -1])
})

test('a rule with nothing to say gets the default, not silence', () => {
  // Eight rows in the catalogue carry an empty window list. They resolve to
  // "check this yourself" and never reach here, but an empty list must mean "no
  // opinion" rather than "warn me never" whatever produced it.
  assert.deepEqual(leadDaysForItem(withWindows([]), DEFAULT_LEAD_DAYS), DEFAULT_LEAD_DAYS)
  assert.equal(run([withWindows([], { days: 5 })]).length, 1)
  // `mk` builds a rule row with no window field at all — the same answer.
  assert.equal(run([mk({ days: 5 })])[0].leadDays, 7)
})

test('post-lapse nudges are NOT taken from the rule', () => {
  // Deliberately out of scope. A window after the date is the one `deservesSms`
  // can turn into a text message, and this change is about warning EARLIER. Six
  // rows carry a -30 or a -7; reading those here would add a text per cycle to
  // items that are already texting, which is a separate decision from this one.
  assert.deepEqual(
    leadDaysForItem(withWindows([90, 45, 14, -1, -30]), DEFAULT_LEAD_DAYS),
    [90, 45, 30, 14, 7, 1, -1],
  )

  const c = run([withWindows([90, 45, 14, -1, -30], { days: -35, standing: 'overdue' })])
  assert.equal(c.length, 1)
  assert.equal(c[0].leadDays, -1, 'the default nudge, not the rule row -30')
})

// -------------------------------------------------- whose setting wins

test("an owner's own lead times are not overridden by the rule row", () => {
  // The rule window is a better DEFAULT. It is not a better answer than a person
  // who sat down and typed what he wanted.
  const his = [catPref({ leadDays: [14, 3] })]
  assert.equal(run([withWindows(MEDICAL, { days: 80 })], { categoryPreferences: his }).length, 0)

  const inside = run([withWindows(MEDICAL, { days: 10 })], { categoryPreferences: his })
  assert.equal(inside.length, 1)
  assert.equal(inside[0].leadDays, 14, 'his ladder, his rungs')
})

test("a wider setting than the rule's window is still his", () => {
  const his = [catPref({ leadDays: [120, 30] })]
  const c = run([withWindows(MEDICAL, { days: 110 })], { categoryPreferences: his })
  assert.equal(c[0].leadDays, 120)
})

test('a stored row nobody moved is not a choice', () => {
  // The alerts form upserts a lead-time row for EVERY category on every save, so
  // a person who ticked a channel box owns a row holding 30, 7, 1, -1 he never
  // typed. Reading that row's existence as a preference would freeze him on the
  // flat ladder forever, which is the defect wearing a different hat.
  const untouched = run([withWindows(MEDICAL, { days: 80 })], { categoryPreferences: [catPref()] })
  assert.equal(untouched.length, 1)
  assert.equal(untouched[0].leadDays, 90)

  const noRow = run([withWindows(MEDICAL, { days: 80 })], { categoryPreferences: [] })
  assert.equal(noRow[0].leadDays, 90, 'and no row at all reads the same way')

  // Order is not a preference: the column default and parseLeadDays both sort
  // largest-first, a hand-written row need not.
  assert.equal(isDefaultLeadDays([-1, 1, 7, 30]), true)
  assert.equal(isDefaultLeadDays([30, 7, 1, -1]), true)
  assert.equal(isDefaultLeadDays(undefined), true, 'never chosen is not a choice either')
  assert.equal(isDefaultLeadDays([30, 7, 1]), false)
  assert.equal(isDefaultLeadDays([60, 30, 7, -1]), false)
})

// -------------------------------------------------- and not one more text

test('an earlier email window does not become an earlier text', () => {
  // SMS is rationed to what is overdue or due within a day, and widening the
  // email windows must not quietly widen that. It cannot: the merged ladder
  // still holds 1 and -1, so everything at or inside a day reports the same
  // window it reports today, and every window this change adds is above 1.
  for (const days of [1, 0]) {
    const c = run([withWindows(MEDICAL, { days })])
    assert.equal(c[0].leadDays, 1, 'inside a day is still the 1-day window')
  }

  const early = run([withWindows(MEDICAL, { days: 80 })])[0]
  assert.equal(deservesSms(early.item), false, 'a 90-day warning is an email')
  assert.equal(isCritical(early.item), false, 'and it must not break through quiet hours')
})

test('an overdue interval rule keeps the flat ladder, so it cannot text early', () => {
  // The inverse trap. A rolling obligation that is overdue carries a POSITIVE
  // countdown, because its next cycle is still ahead — and it is already
  // critical on standing alone, so `deservesSms` says yes whatever the number
  // is. Handing it the rule's 90 would make it a candidate, and therefore a text
  // message, three months before a date it has already missed.
  const behind = withWindows(MEDICAL, { days: 80, standing: 'overdue' })
  assert.equal(deservesSms(behind), true, 'overdue by standing, with days in hand')
  assert.deepEqual(leadDaysForItem(behind, DEFAULT_LEAD_DAYS), DEFAULT_LEAD_DAYS)
  assert.equal(run([behind]).length, 0, 'unchanged: nothing goes out 80 days ahead')

  // It still reaches the ladder it always reached, at the distance it always did.
  const near = withWindows(MEDICAL, { days: 20, standing: 'overdue' })
  assert.equal(run([near])[0].leadDays, 30)
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
