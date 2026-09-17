/**
 * The chart arithmetic, and the four ways a chart lies.
 *
 * A wrong number in a table is a wrong number. A wrong chart is a wrong
 * CONCLUSION, arrived at in under a second, with nothing on screen to argue
 * with — the owner takes in the shape whole and acts on it. Every test below
 * pins one of the specific ways that happens:
 *
 *   1. an unknown drawn as a zero
 *   2. a real value drawn as an invisible sliver
 *   3. an axis so coarse the fleet looks idle
 *   4. an empty period deleted from the axis, so a slow quarter reads as a busy one
 *
 * and the runway tests pin the fifth, which is the dangerous one specific to
 * this product: a timeline of upcoming dates cannot plot an expired document or
 * one whose date nobody has entered, so drawn naively it shows the most exposed
 * carrier in the system the emptiest, calmest screen in the app.
 *
 * The health tests at the bottom pin the sixth, which shipped: a headline that
 * counts the wrong things. The ring read "141 need attention" when 119 of the
 * 141 were items nobody had typed a date for and 22 were actually late. Both
 * halves of the fix are tested — the 119 is out of the headline, and the 119 is
 * still on the chart, in the tiles, in the total and in a sentence of its own.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  attentionParts,
  buildHealth,
  donutSlices,
  type HealthInput,
  healthHeadline,
  healthMath,
  missingLine,
  openCount,
  openParts,
} from '../src/lib/charts/health.ts'
import {
  buildRunway,
  isDueSoon,
  type RunwayItem,
  weekRangeLabel,
} from '../src/lib/charts/runway.ts'
import {
  bucketValues,
  ceilingFor,
  compactMoney,
  compactNumber,
  divergingRows,
  MIN_VISIBLE_PERCENT,
  monthBuckets,
  niceCeiling,
  ticks,
  weekBuckets,
  weekStart,
  widthPercent,
} from '../src/lib/charts/scale.ts'
import { evaluate, SOON_DAYS } from '../src/lib/rules/index.ts'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

// --------------------------------------------------------------------- scales

test('an unknown never becomes a zero', () => {
  // The single most important line in the charting code. `null` in, `null` out,
  // so the component is FORCED to branch and draw the absence. Returning 0 here
  // would put a zero-height column on the axis that is indistinguishable, to
  // the eye and to every downstream caller, from a month that was truly empty.
  assert.equal(widthPercent(null, 100), null)
  assert.equal(ceilingFor([null, null]), 0)
  assert.deepEqual(
    bucketValues([], monthBuckets(utc(2026, 1, 1), utc(2026, 3, 1)), () => null),
    [null, null, null],
  )
})

test('a small but real value still draws wide enough to see', () => {
  // 3 miles against a 40,000-mile ceiling is 0.0075% — sub-pixel, identical on
  // screen to the state he never drove through. "A little" and "none" are
  // different answers to an IFTA auditor.
  const w = widthPercent(3, 40_000)
  assert.ok(w !== null && w >= MIN_VISIBLE_PERCENT, `expected a visible bar, got ${w}`)
  // A true zero stays at zero. The floor lifts small values, never absent ones.
  assert.equal(widthPercent(0, 40_000), 0)
})

test('a value never overflows its track', () => {
  assert.equal(widthPercent(500, 100), 100)
})

test('no chart divides by an empty domain', () => {
  assert.equal(widthPercent(5, 0), 0)
  assert.deepEqual(ticks(0), [])
})

test('the axis ceiling is fine enough that a full chart looks full', () => {
  // The textbook 1/2/5 ladder turns 101 into 200: every bar lands in the left
  // half and a carrier who had a normal month sees a chart of a dead one.
  assert.equal(niceCeiling(101), 120)
  assert.equal(niceCeiling(11_400), 12_000)
  assert.equal(niceCeiling(100), 100)
  assert.equal(niceCeiling(7), 8)
})

test('axis labels are not floating-point noise', () => {
  // 1.2 * 100 is 120.00000000000001 in binary floating point, and an axis
  // labelled that is a bug report. Checked as "no long decimal tail" rather
  // than as a substring, because 999,999 rounds up to a legitimate 1,000,000.
  const tail = (v: number) => (String(v).split('.')[1] ?? '').length
  for (const n of [101, 1.01, 10_100, 999_999, 33_333]) {
    assert.ok(tail(niceCeiling(n)) <= 3, `${n} -> ${niceCeiling(n)}`)
  }
  for (const t of ticks(120, 4)) assert.ok(tail(t) <= 3, `tick ${t}`)
})

test('the ceiling comes off the known values and ignores the missing ones', () => {
  assert.equal(ceilingFor([50, null, 20]), 50)
})

// ------------------------------------------------------------------ diverging

test('money owed and money owed back share one scale', () => {
  // Scaled per-half, a $40 credit draws the same width as a $4,000 bill — the
  // exact misreading a diverging chart exists to prevent.
  const { rows } = divergingRows([4000, -40])
  assert.ok(rows[0].positive > rows[1].negative * 10)
  assert.equal(rows[0].negative, 0)
  assert.equal(rows[1].positive, 0)
})

test('a row we cannot price is not a row that is settled', () => {
  // The centre line means "nothing owed either way". A jurisdiction whose tax
  // rate we have not loaded has not been found to owe nothing, so it must not
  // draw as a bare centre line — nor set the scale for the rows we CAN price.
  const { max, rows } = divergingRows([4000, null])
  assert.equal(rows[1].unknown, true)
  assert.equal(rows[1].negative, 0)
  assert.equal(rows[1].positive, 0)
  assert.equal(rows[0].unknown, false)
  assert.equal(max, 4000)
})

// -------------------------------------------------------------------- buckets

test('the axis keeps the quiet months', () => {
  // Built from the data alone, an axis of Jan/Feb/Apr/May puts a dead March
  // BEHIND the chart and squeezes the gap out of existence.
  const months = monthBuckets(utc(2026, 1, 15), utc(2026, 5, 2))
  assert.deepEqual(
    months.map((m) => m.key),
    ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'],
  )
})

test('a month axis crossing new year labels the year', () => {
  const months = monthBuckets(utc(2025, 11, 1), utc(2026, 2, 1))
  assert.deepEqual(
    months.map((m) => m.label),
    ['Nov', 'Dec', 'Jan 26', 'Feb'],
  )
})

test('a single-month range is one bucket, not zero and not two', () => {
  const months = monthBuckets(utc(2026, 6, 10), utc(2026, 6, 28))
  assert.equal(months.length, 1)
  assert.equal(months[0].key, '2026-06')
})

test('weeks start on Monday and a Sunday belongs to the week it ends', () => {
  // 2026-09-13 is a Sunday; its week began Monday the 7th.
  assert.equal(
    weekStart(utc(2026, 9, 13))
      .toISOString()
      .slice(0, 10),
    '2026-09-07',
  )
  assert.equal(
    weekStart(utc(2026, 9, 7))
      .toISOString()
      .slice(0, 10),
    '2026-09-07',
  )
})

test('bucket boundaries do not double-count or drop the item on the seam', () => {
  const weeks = weekBuckets(utc(2026, 9, 7), 2)
  const items = [
    { on: utc(2026, 9, 13) }, // last day of week one
    { on: utc(2026, 9, 14) }, // first day of week two
  ]
  assert.deepEqual(
    bucketValues(
      items,
      weeks,
      (i) => i.on,
      () => 1,
      true,
    ),
    [1, 1],
  )
})

test('an item outside every bucket is dropped, not folded into the nearest', () => {
  const weeks = weekBuckets(utc(2026, 9, 7), 1)
  assert.deepEqual(
    bucketValues(
      [{ on: utc(2027, 1, 1) }],
      weeks,
      (i) => i.on,
      () => 1,
      true,
    ),
    [0],
  )
})

test('a period with nothing recorded is null, unless the caller says zero is a finding', () => {
  const months = monthBuckets(utc(2026, 1, 1), utc(2026, 2, 1))
  const sales = [{ on: utc(2026, 1, 9), cents: 250_00 }]
  const amount = (s: { cents: number }) => s.cents
  // Revenue: we cannot evidence "he hauled nothing in February", only "nothing
  // was entered for February".
  assert.deepEqual(
    bucketValues(sales, months, (s) => s.on, amount),
    [250_00, null],
  )
  // Counts of things we hold completely: zero is a real answer.
  assert.deepEqual(
    bucketValues(sales, months, (s) => s.on, amount, true),
    [250_00, 0],
  )
})

test('an unparseable date is skipped rather than landing in bucket one', () => {
  const months = monthBuckets(utc(2026, 1, 1), utc(2026, 1, 31))
  assert.deepEqual(
    bucketValues([{ on: new Date('nope') }], months, (i) => i.on),
    [null],
  )
})

// ------------------------------------------------------------------ formatting

test('compact money never rounds a figure into a different number', () => {
  assert.equal(compactMoney(0), '$0')
  assert.equal(compactMoney(94_250), '$943')
  assert.equal(compactMoney(1_250_00), '$1.3k')
  assert.equal(compactMoney(-1_250_00), '-$1.3k')
  assert.equal(compactMoney(48_000_00), '$48k')
  assert.equal(compactNumber(41_208.4), '41,208')
})

// --------------------------------------------------------------------- runway

const today = utc(2026, 9, 15) // a Tuesday

test('what is already behind him is counted, never dropped off the timeline', () => {
  // The failure this whole module exists to prevent: eleven expired and thirty
  // undated items have no future date, so a naive upcoming-deadlines chart
  // plots NOTHING and hands the most exposed carrier in the system the calmest
  // screen in the app.
  const items: RunwayItem[] = [
    ...Array.from({ length: 11 }, () => ({ standing: 'overdue' as const })),
    ...Array.from({ length: 30 }, () => ({ standing: 'unknown' as const })),
  ]
  const r = buildRunway(items, today)
  assert.equal(r.overdue, 11)
  assert.equal(r.undated, 30)
  assert.equal(r.scheduled, 0)
  assert.equal(
    r.overdue + r.undated + r.settled + r.beyond + r.unschedulable + r.scheduled,
    items.length,
    'every item must be accounted for somewhere',
  )
})

test("an unknown carrying a computed next date is still 'no date'", () => {
  // A rule can work out when the next inspection is OWED while having no idea
  // whether the last one happened. Plotting that date would draw an obligation
  // as handled-and-scheduled on the strength of a date we derived, not one he
  // gave us.
  const r = buildRunway([{ standing: 'unknown', nextDue: utc(2026, 10, 1) }], today)
  assert.equal(r.undated, 1)
  assert.equal(r.scheduled, 0)
})

test('a finished one-time obligation is not stacked in with the real gaps', () => {
  /**
   * The counterpart to the test above, and the opposite failure.
   *
   * A one-time obligation that has been satisfied — the road test, the
   * hire-time MVR — has no next occurrence, so `status` returns it `current`
   * with no date. "No date" is the same shape as the undated gaps, and one line
   * of this function separates them. If it ever stops separating them, the
   * block at the left edge of the axis — which this module's header calls the
   * first thing on the chart — fills up with completed paperwork, under a
   * caption that reads "have no date yet".
   */
  const r = buildRunway([{ standing: 'current' }], today)

  assert.equal(r.settled, 1)
  assert.equal(r.undated, 0, 'a finished obligation is not a missing date')
  assert.equal(r.overdue, 0, 'a finished obligation is not past due')
  assert.equal(r.scheduled, 0, 'there is nothing to draw on a week')
})

test('a finished one-time obligation is never drawn as overdue, however old', () => {
  /**
   * The regression in its original shape. Before `status` stopped handing back
   * the hire date as a future due date, a road test passed in 2021 arrived here
   * as `current` with `nextDue` five years in the past, fell into the `t < day`
   * arm, and was counted OVERDUE. The chart that exists so a bad month cannot
   * hide was reporting finished paperwork as past due, and the number it
   * inflated is the one rendered biggest and linked to a filter.
   *
   * Asserted through the engine rather than a hand-built fixture, because the
   * hand-built fixture is what let this through: the bug was in what `status`
   * produced, not in what the chart did with a well-formed item.
   */
  const items = evaluate(
    [
      {
        type: 'driver',
        id: 'd1',
        label: 'Miguel Arellano',
        context: { carrierOperation: 'A', cdl: true },
        anchors: { hire_date: utc(2021, 2, 15) },
        lastDone: { road_test_or_equivalent: utc(2021, 2, 15) },
      },
    ],
    today,
  ).filter((i) => i.rule.code === 'road_test_or_equivalent')

  assert.equal(items.length, 1)
  const r = buildRunway(
    items.map((i) => ({ standing: i.status.standing, nextDue: i.status.nextDue })),
    today,
  )
  assert.equal(r.overdue, 0, 'a road test passed five years ago is not past due')
  assert.equal(r.settled, 1)
})

test('nothing is silently discarded, whatever standing it carries', () => {
  const items: RunwayItem[] = [
    { standing: 'current', nextDue: utc(2026, 9, 17) },
    { standing: 'current', nextDue: utc(2027, 6, 1) }, // past the horizon
    { standing: 'unsupported' },
    { standing: 'not_applicable' }, // the ONE thing that legitimately vanishes
    { standing: 'overdue' },
  ]
  const r = buildRunway(items, today)
  assert.equal(r.scheduled + r.beyond + r.unschedulable + r.overdue + r.undated + r.settled, 4)
  assert.equal(r.beyond, 1)
  assert.equal(r.unschedulable, 1)
})

test('a current standing with a past date counts as a problem, not as nothing', () => {
  const r = buildRunway([{ standing: 'current', nextDue: utc(2026, 1, 1) }], today)
  assert.equal(r.overdue, 1)
})

test('the heaviest week is named only when there is actually a pile', () => {
  const one = buildRunway(
    [
      { standing: 'current', nextDue: utc(2026, 9, 17) },
      { standing: 'current', nextDue: utc(2026, 10, 20) },
    ],
    today,
  )
  // One item in one week is a Tuesday, not a heavy week. Calling it one teaches
  // him to ignore the sentence when it eventually matters.
  assert.equal(one.peak, null)

  const pile = buildRunway(
    [
      { standing: 'current', nextDue: utc(2026, 10, 13) },
      { standing: 'current', nextDue: utc(2026, 10, 14) },
      { standing: 'current', nextDue: utc(2026, 10, 16) },
    ],
    today,
  )
  assert.ok(pile.peak, 'three items in one week is a pile')
  assert.equal(pile.peak.count, 3)
  assert.equal(weekRangeLabel(pile.peak), 'Oct 12–18')
})

test('a week range spanning a month boundary names both months', () => {
  const r = buildRunway(
    [
      { standing: 'current', nextDue: utc(2026, 9, 30) },
      { standing: 'current', nextDue: utc(2026, 10, 1) },
    ],
    today,
  )
  assert.ok(r.peak)
  assert.equal(weekRangeLabel(r.peak), 'Sep 28–Oct 4')
})

test('the column ceiling never divides by zero and never clips the tall week', () => {
  // Floored at 3 so the one renewal a quiet carrier has all quarter does not
  // draw as the tallest column this chart can produce.
  assert.equal(buildRunway([], today).max, 3)
  assert.equal(buildRunway([{ standing: 'current', nextDue: utc(2026, 9, 17) }], today).max, 3)
  const busy = buildRunway(
    Array.from({ length: 6 }, () => ({ standing: 'current' as const, nextDue: utc(2026, 9, 17) })),
    today,
  )
  assert.equal(busy.max, 6)
})

test('the horizon is whole weeks and starts with the one holding today', () => {
  const r = buildRunway([], today, 13)
  assert.equal(r.weeks.length, 13)
  assert.equal(r.weeks[0].isCurrent, true)
  assert.equal(r.weeks[0].start.toISOString().slice(0, 10), '2026-09-14')
  // A deadline four days ago and a deadline tomorrow are both "this week", but
  // only the second one is upcoming — the first is counted as overdue above.
  assert.ok(r.weeks[0].start <= today)
})

test('month labels mark boundaries only, once each', () => {
  const r = buildRunway([], today, 13)
  const labels = r.weeks.map((w) => w.monthLabel).filter(Boolean)
  assert.deepEqual(labels, ['Sep', 'Oct', 'Nov', 'Dec'])
})

// ------------------------------------------------------- runway: the urgency split
//
// Height says HOW MANY. It cannot say HOW SOON, and a week of four renewals due
// inside the 45-day window drew exactly like a week of four due at the far end
// of the quarter. So each week is counted twice over and the column is stacked:
// amber for what is inside the window, green for what is dated past it.
//
// Two colours, never three. There is no red on a future week: red is overdue,
// an overdue item has no future date, and it is already counted in the block at
// the left edge of the axis.

test('a week is split into what is due soon and what is dated further out', () => {
  // Sep 15 + 45 days is Oct 30, and the week of Oct 26 straddles the line: Oct
  // 30 is the last day inside the window, Oct 31 the first day outside it. One
  // week, both colours — the case the stack exists for.
  const r = buildRunway(
    [
      { standing: 'current', nextDue: utc(2026, 10, 30) },
      { standing: 'current', nextDue: utc(2026, 10, 31) },
    ],
    today,
  )
  const w = r.weeks.find((x) => x.count > 0)
  assert.ok(w, 'both dates are inside the horizon')
  assert.equal(w.key, '2026-10-26')
  assert.equal(w.soon, 1)
  assert.equal(w.later, 1)
  assert.equal(w.count, 2, 'the total the column is drawn at is unchanged')
  assert.equal(r.soon, 1)
  assert.equal(r.later, 1)
  assert.equal(r.scheduled, 2)
})

test('the runway splits on the same window as the tiles and the health ring', () => {
  // Not a second threshold invented for this chart. If these ever disagree, the
  // owner has a column painted amber next to a tile that does not count it.
  const at = (days: number) => new Date(today.getTime() + days * 86_400_000)
  assert.equal(buildRunway([{ standing: 'current', nextDue: at(SOON_DAYS) }], today).soon, 1)
  assert.equal(buildRunway([{ standing: 'current', nextDue: at(SOON_DAYS) }], today).later, 0)
  assert.equal(buildRunway([{ standing: 'current', nextDue: at(SOON_DAYS + 1) }], today).later, 1)
  assert.equal(buildRunway([{ standing: 'current', nextDue: at(SOON_DAYS + 1) }], today).soon, 0)
  // Carried on the result so the legend can print the number without importing
  // the rules engine into a chart component.
  assert.equal(buildRunway([], today).soonDays, SOON_DAYS)
})

test('the soon window is closed at BOTH ends: -2040 days is not "due in 45 days"', () => {
  /**
   * The bug that has shipped three times in this codebase, in three files: the
   * dashboard's due-soon tile, the qualification binder's "Expires soon" pill,
   * and the health ring. All three tested `days <= SOON_DAYS` and nothing else,
   * and EVERY NEGATIVE NUMBER PASSES THAT — a pre-employment query run the week
   * the driver was hired comes back with a countdown near -2040 and was painted
   * as due this month.
   *
   * Asserted against the predicate directly, because through `buildRunway` a
   * past date is taken by the `overdue` arm before the split is ever asked, so
   * the near edge of the window is not otherwise reachable from a test — and an
   * unreachable guard is one a future edit deletes as dead code.
   */
  assert.equal(isDueSoon(-2040), false, 'finished years ago is not coming up')
  assert.equal(isDueSoon(-1), false, 'yesterday is not coming up')
  assert.equal(isDueSoon(0), true, 'due today is the most urgent thing there is')
  assert.equal(isDueSoon(SOON_DAYS), true, 'the far edge is inclusive')
  assert.equal(isDueSoon(SOON_DAYS + 1), false)
  // Same both-ends rule at any window the caller picks.
  assert.equal(isDueSoon(-1, 0), false)
  assert.equal(isDueSoon(0, 0), true)
})

test('the window is guarded on BOTH sides of zero, so a past date is never amber', () => {
  /**
   * The bug that has shipped three times in this codebase, in three files: the
   * dashboard's due-soon tile, the qualification binder's "Expires soon" pill,
   * and the health ring. All three tested `days <= SOON_DAYS` and nothing else,
   * and EVERY NEGATIVE NUMBER PASSES THAT — a pre-employment query run the week
   * the driver was hired comes back with something like -2040 and was painted
   * as due this month.
   *
   * Here the near edge is guarded twice: nothing with a past date reaches the
   * weeks at all (it is counted overdue), and the split itself asks
   * `days >= 0 && days <= soonDays` rather than the far edge alone.
   */
  const r = buildRunway([{ standing: 'current', nextDue: utc(2026, 1, 1) }], today)
  assert.equal(r.overdue, 1)
  assert.equal(r.soon, 0, 'a date eight months in the past is not "due in the next 45 days"')
  assert.equal(r.later, 0)
  assert.equal(r.scheduled, 0)
  assert.equal(
    r.weeks.reduce((n, w) => n + w.soon + w.later, 0),
    0,
    'nothing was drawn on any week',
  )

  // And zero itself IS inside the window: due today is the most urgent thing
  // the chart can draw, so the near edge is inclusive, not exclusive.
  assert.equal(buildRunway([{ standing: 'current', nextDue: today }], today).soon, 1)
})

test('an overdue item with a future date is not drawn on a future week', () => {
  // The inverse trap, and the reason the buckets are decided STANDING FIRST,
  // days second. An overdue rolling rule can carry a POSITIVE countdown: the
  // last inspection was five months ago, so it is past due, while the next
  // occurrence computes to sixteen days out. Split on days alone, that lands as
  // a green segment in October — drawn as handled — while the block on the left
  // is counting it as overdue. The same fleet, two answers.
  const r = buildRunway([{ standing: 'overdue', nextDue: utc(2026, 10, 1) }], today)
  assert.equal(r.overdue, 1)
  assert.equal(r.soon, 0)
  assert.equal(r.later, 0)
  assert.equal(r.scheduled, 0)
})

test('nothing that is not drawn is counted in the split', () => {
  // `undated`, `settled` and `unschedulable` have no week and no colour, and
  // `not_applicable` stays the ONE thing that legitimately vanishes. If any of
  // them leaked into `soon` or `later` the legend's totals would be larger than
  // the columns they are a key to.
  const r = buildRunway(
    [
      { standing: 'unknown' },
      { standing: 'unknown', nextDue: utc(2026, 9, 17) },
      { standing: 'current' },
      { standing: 'unsupported' },
      { standing: 'not_applicable' },
      { standing: 'current', nextDue: utc(2027, 6, 1) },
      { standing: 'current', nextDue: utc(2026, 9, 17) },
    ],
    today,
  )
  assert.equal(r.undated, 2)
  assert.equal(r.settled, 1)
  assert.equal(r.unschedulable, 1)
  assert.equal(r.beyond, 1)
  assert.equal(r.soon, 1)
  assert.equal(r.later, 0)
  assert.equal(r.soon + r.later, r.scheduled, 'the split accounts for every drawn item')
})

test('every column adds up: soon plus later is the height it is drawn at', () => {
  // The invariant the component depends on. It stacks two segments scaled
  // against `max` and prints `count` above them; if the parts ever stop summing
  // to the total, the number and the shape disagree on the same column.
  const items: RunwayItem[] = [
    { standing: 'current', nextDue: utc(2026, 9, 17) },
    { standing: 'current', nextDue: utc(2026, 9, 18) },
    { standing: 'current', nextDue: utc(2026, 10, 14) },
    { standing: 'current', nextDue: utc(2026, 10, 30) },
    { standing: 'current', nextDue: utc(2026, 10, 31) },
    { standing: 'current', nextDue: utc(2026, 12, 1) },
    { standing: 'overdue' },
    { standing: 'unknown' },
  ]
  const r = buildRunway(items, today)
  for (const w of r.weeks) {
    assert.equal(w.soon + w.later, w.count, `week ${w.key}`)
  }
  assert.equal(
    r.weeks.reduce((n, w) => n + w.soon, 0),
    r.soon,
  )
  assert.equal(
    r.weeks.reduce((n, w) => n + w.later, 0),
    r.later,
  )
  assert.equal(r.soon + r.later, r.scheduled)
  // Everything dated past the window is green, everything inside it is amber:
  // four this side of Oct 30, two past it.
  assert.equal(r.soon, 4)
  assert.equal(r.later, 2)
})

test('the current week has no green in it, so it needs no colour of its own', () => {
  // Every date inside the week holding today is at most six days away, which is
  // inside any sane window. The old chart painted week one amber as a "you are
  // here" marker; now it is amber for the same reason every other amber is, and
  // the vertical rule to its left is what says "today".
  const r = buildRunway([{ standing: 'current', nextDue: utc(2026, 9, 17) }], today)
  assert.equal(r.weeks[0].isCurrent, true)
  assert.equal(r.weeks[0].soon, 1)
  assert.equal(r.weeks[0].later, 0)
})

test('the split window is a parameter, so the boundary can be pinned', () => {
  // Same shape as `buildHealth`: every caller passes the app's one value, and
  // the argument exists so a test can stand on the edge of it. With a zero-day
  // window only today itself is soon — and it IS soon, because zero is inside.
  const r = buildRunway(
    [
      { standing: 'current', nextDue: today },
      { standing: 'current', nextDue: utc(2026, 9, 16) },
    ],
    today,
    13,
    0,
  )
  assert.equal(r.soon, 1)
  assert.equal(r.later, 1)
  assert.equal(r.weeks[0].count, 2, 'both are still drawn in week one')
})

// ------------------------------------ the health ring: what "needs attention" is
//
// The sixth way a chart lies, and the one this product shipped: a headline that
// counts the wrong things.
//
// The ring's centre number read `overdue + unknown + soon`. On a real fleet that
// is 141 — of which 119 are items where nobody has typed a date in yet and 22
// are genuinely late or nearly late. "141 need attention" is not a blunter way
// of saying 22, it is a different claim, and it was printed in the biggest type
// on the owner's dashboard and on the page a broker opens.
//
// The fix is not to hide the 119. A missing date is not a pass, it never draws
// as one, and it never leaves the chart. It stops being counted as a deadline in
// trouble, because it is not one — and it gets its own count, its own arc and
// its own sentence instead. Every test below pins one half of that: the 119 is
// out of the headline, AND the 119 is still everywhere else.

/** The fleet from the defect report: 9 + 13 late or nearly late, 119 blanks. */
const fleetOf171: HealthInput[] = [
  ...Array.from({ length: 9 }, () => ({ standing: 'overdue' as const })),
  ...Array.from({ length: 119 }, () => ({ standing: 'unknown' as const })),
  ...Array.from({ length: 13 }, () => ({ standing: 'current' as const, daysUntil: 10 })),
  ...Array.from({ length: 30 }, () => ({ standing: 'current' as const, daysUntil: 300 })),
]

const bucket = (items: readonly HealthInput[], key: string) =>
  buildHealth(items).buckets.find((b) => b.key === key)?.count ?? -1

test('a missing date is not counted as needing attention', () => {
  // THE DEFECT. 141 was overdue + unknown + soon. 22 is overdue + soon, which
  // is what the spec asks for in as many words: "the number that needs
  // attention, not the total".
  const h = buildHealth(fleetOf171)
  assert.equal(h.total, 171)
  assert.equal(h.needsAttention, 22, 'the headline is overdue + due soon and nothing else')
  assert.notEqual(h.needsAttention, 141)
  assert.equal(h.needsAttention, bucket(fleetOf171, 'overdue') + bucket(fleetOf171, 'soon'))
  // And the words on the screen follow the number.
  assert.equal(healthHeadline(h), '22 need attention')
  // The parts printed under the ring are the parts the number is made of, so
  // the addition beside it can never come to something else.
  assert.equal(
    attentionParts(h).reduce((n, p) => n + p.count, 0),
    h.needsAttention,
  )
  assert.ok(!attentionParts(h).some((p) => p.key === 'unknown'), 'grey is not a part of the sum')
})

test('a missing date is still on the ring, with its own count', () => {
  // The other half, and the half a future edit is likely to undo: taking grey
  // out of the headline must not take it off the chart. It keeps its arc, its
  // number, and a field of its own so no screen has to dig for it.
  const h = buildHealth(fleetOf171)
  assert.equal(h.missing, 119)
  assert.equal(bucket(fleetOf171, 'unknown'), 119)
  assert.equal(h.onTrack, 30, 'and it was not quietly promoted into the green')

  const grey = donutSlices(h).find((s) => s.key === 'unknown')
  assert.ok(grey, 'the grey arc vanished from the ring')
  assert.equal(grey.count, 119)
  assert.ok(grey.percent > 0)

  // Still one of the four tiles, still second in rank order, still beside red.
  assert.deepEqual(
    h.buckets.map((b) => b.key),
    ['overdue', 'unknown', 'soon', 'ontrack'],
  )

  // And it is stated in words on both pages, in each reader's own language,
  // with the same count in both.
  const owner = missingLine(h, 'owner')
  const visitor = missingLine(h, 'visitor')
  assert.ok(owner?.includes('119'), owner ?? 'no line for the owner')
  assert.ok(visitor?.includes('119'), visitor ?? 'no line for the broker')
  assert.equal(missingLine(buildHealth([]), 'owner'), null, 'nothing missing, nothing said')
})

test('the four buckets still cover every tracked item', () => {
  // The accounting the whole change rests on. Pulling grey out of the headline
  // is only honest if grey is still inside the total, so this is asserted as an
  // identity over every mix rather than on one fixture.
  for (let a = 0; a <= 3; a++) {
    for (let b = 0; b <= 3; b++) {
      for (let c = 0; c <= 3; c++) {
        for (let d = 0; d <= 3; d++) {
          const items: HealthInput[] = [
            ...Array.from({ length: a }, () => ({ standing: 'overdue' as const })),
            ...Array.from({ length: b }, () => ({ standing: 'unknown' as const })),
            ...Array.from({ length: c }, () => ({ standing: 'current' as const, daysUntil: 10 })),
            ...Array.from({ length: d }, () => ({ standing: 'current' as const, daysUntil: 300 })),
          ]
          const h = buildHealth(items)
          const where = `at ${a}/${b}/${c}/${d}`
          assert.equal(h.total, a + b + c + d, `lost an item ${where}`)
          assert.equal(
            h.needsAttention + h.missing + h.onTrack,
            h.total,
            `books do not close ${where}`,
          )
          assert.equal(h.needsAttention, a + c, where)
          assert.equal(h.missing, b, where)
          // The ranking list counts everything not on track, grey included, so
          // a driver with nothing but blanks is still somebody to open.
          assert.equal(openCount(h), a + b + c, where)
          assert.equal(
            openParts(h).reduce((n, p) => n + p.count, 0),
            openCount(h),
            where,
          )
        }
      }
    }
  }
})

test('the sentence under the ring adds up and leaves nothing out', () => {
  // The no-unexplained-score rule, as arithmetic a reader can check. A broker
  // quotes the centre number back down the phone; the sentence beside it has to
  // show what it is made of AND show that the rest of the fleet is still
  // accounted for, or the smaller number looks like the smaller number.
  const h = buildHealth(fleetOf171)
  const said = healthMath(h)

  assert.ok(said.includes('9 overdue + 13 due in 45 days = 22 need attention'), said)
  assert.ok(said.includes('119 have no date on file'), said)
  assert.ok(said.includes('30 are on track'), said)
  assert.ok(said.includes('22 + 119 + 30 = 171'), said)
  assert.equal(h.needsAttention + h.missing + h.onTrack, h.total)

  // One string, one function. The dashboard and the public proof page print
  // this same sentence, so the owner and the broker cannot be handed two
  // different accounts of one carrier.
  assert.equal(healthMath(buildHealth(fleetOf171)), said)
})

test('a carrier with nothing but missing dates is never told nothing needs attention', () => {
  /**
   * THE BOUNDARY CASE THAT MADE THE OLD ARITHMETIC TEMPTING, and the one this
   * change has to get right to be allowed at all.
   *
   * On his first week an owner has nothing overdue and nothing due soon —
   * because nobody has typed a date in yet — so the centre number is 0 and every
   * arc on his ring is grey. "Nothing needs attention" over 119 blanks is the
   * most reassuring sentence in the app shown to the carrier who has told us the
   * least, which is the exact failure `buildRunway` and this module both exist
   * to prevent. So the headline says what is actually true instead.
   */
  const fresh = Array.from({ length: 119 }, () => ({ standing: 'unknown' as const }))
  const h = buildHealth(fresh)

  assert.equal(h.needsAttention, 0)
  assert.equal(h.missing, 119)
  assert.equal(h.onTrack, 0, 'a blank is never on track')
  assert.equal(h.total, 119)
  assert.notEqual(healthHeadline(h), 'Nothing needs attention')
  assert.equal(healthHeadline(h), '119 dates are missing')

  // The ring is a full circle of grey, not an empty one and not a green one.
  const slices = donutSlices(h)
  assert.deepEqual(
    slices.map((s) => s.key),
    ['unknown'],
  )
  assert.equal(slices[0].percent, 100)

  // And the sentence says so without claiming an addition it does not have.
  const said = healthMath(h)
  assert.ok(said.includes('119 have no date on file'), said)
  assert.ok(said.includes('That is every one of the 119 we track.'), said)

  // One item, and the words still read as English.
  const one = buildHealth([{ standing: 'unknown' }])
  assert.equal(healthHeadline(one), '1 date is missing')
})

test('a carrier with no missing dates counts exactly overdue plus due soon', () => {
  // The other boundary: with nothing grey, the new number and the old number
  // agree, which is what makes this a narrowing of the headline rather than a
  // new definition of it.
  const items: HealthInput[] = [
    ...Array.from({ length: 4 }, () => ({ standing: 'overdue' as const })),
    ...Array.from({ length: 5 }, () => ({ standing: 'current' as const, daysUntil: 10 })),
    ...Array.from({ length: 22 }, () => ({ standing: 'current' as const, daysUntil: 300 })),
  ]
  const h = buildHealth(items)
  assert.equal(h.missing, 0)
  assert.equal(h.needsAttention, 9)
  assert.equal(h.needsAttention, h.total - h.onTrack, 'with no grey, the two readings are one')
  assert.equal(openCount(h), h.needsAttention)
  assert.equal(healthHeadline(h), '9 need attention')
  assert.equal(missingLine(h, 'owner'), null)
  assert.ok(!healthMath(h).includes('no date on file'), healthMath(h))

  // Nothing wrong at all is still allowed to say so — but only when there is
  // also nothing missing, which is the clause above this one.
  const clean = buildHealth(
    Array.from({ length: 5 }, () => ({ standing: 'current' as const, daysUntil: 300 })),
  )
  assert.equal(healthHeadline(clean), 'Nothing needs attention')
  assert.equal(healthHeadline(buildHealth([])), 'Nothing tracked yet')
})

test('the headline window is closed at both ends, so a finished item is not "due soon"', () => {
  // The bug that has shipped three times here, now guarding the number the whole
  // dashboard is built around. A pre-employment query run the week a driver was
  // hired reports something like -2040 days and is `current`; `days <= 45` alone
  // is true for that, and twenty finished items would inflate the headline.
  assert.equal(buildHealth([{ standing: 'current', daysUntil: -2040 }]).needsAttention, 0)
  assert.equal(buildHealth([{ standing: 'current', daysUntil: -1 }]).needsAttention, 0)
  assert.equal(buildHealth([{ standing: 'current', daysUntil: 0 }]).needsAttention, 1)
  assert.equal(buildHealth([{ standing: 'current', daysUntil: SOON_DAYS }]).needsAttention, 1)
  assert.equal(buildHealth([{ standing: 'current', daysUntil: SOON_DAYS + 1 }]).needsAttention, 0)
  // Same window the runway splits on. If these ever disagree, a column is
  // painted amber next to a headline that does not count it.
  for (const days of [-2040, -1, 0, 1, SOON_DAYS, SOON_DAYS + 1]) {
    assert.equal(
      buildHealth([{ standing: 'current', daysUntil: days }]).needsAttention === 1,
      isDueSoon(days),
      `the ring and the runway disagree at ${days} days`,
    )
  }
  // A `current` item with no next date is a one-time obligation already
  // finished. Not unknown, not a gap, and not a call on his attention.
  const done = buildHealth([{ standing: 'current' }])
  assert.equal(done.needsAttention, 0)
  assert.equal(done.missing, 0)
  assert.equal(done.onTrack, 1)
})
