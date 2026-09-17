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
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRunway, type RunwayItem, weekRangeLabel } from '../src/lib/charts/runway.ts'
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
import { evaluate } from '../src/lib/rules/index.ts'

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
