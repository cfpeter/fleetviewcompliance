/**
 * The ring on the dashboard, and the four ways it could lie about a fleet.
 *
 * It draws a WHOLE, which is a more dangerous thing to draw than a quantity: a
 * bar chart that drops a row is short by a row, but a ring that drops a bucket
 * silently re-scales every other slice, so the fleet still adds up to a full
 * circle and the picture looks complete. Every test below pins one of the ways
 * that happens here:
 *
 *   1. a bucket going missing, so the arcs no longer add up to the fleet
 *   2. a missing date counted as, or quietly promoted to, on track
 *   3. the centre number meaning something other than what the screen says
 *   4. a real bucket drawn as an arc too thin to see
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  attentionParts,
  buildHealth,
  donutSlices,
  type Health,
  type HealthInput,
  healthHeadline,
} from '../src/lib/charts/health.ts'
import { SOON_DAYS } from '../src/lib/rules/index.ts'

const count = (h: Health, key: string) => h.buckets.find((b) => b.key === key)?.count ?? -1

/** `n` identical items, so a fixture reads as the fleet it describes. */
const many = (n: number, item: HealthInput): HealthInput[] => Array.from({ length: n }, () => item)

const overdue: HealthInput = { standing: 'overdue' }
const missing: HealthInput = { standing: 'unknown' }
const soon: HealthInput = { standing: 'current', daysUntil: 10 }
const later: HealthInput = { standing: 'current', daysUntil: 300 }

// --- 1. the four buckets are the whole fleet --------------------------------

test('the four buckets add up to the total', () => {
  const h = buildHealth([
    ...many(4, overdue),
    ...many(12, missing),
    ...many(5, soon),
    ...many(22, later),
  ])
  const summed = h.buckets.reduce((n, b) => n + b.count, 0)
  assert.equal(summed, h.total)
  assert.equal(h.total, 43)
})

test('the total holds for any mix, including the empty fleet', () => {
  // Property rather than example: a bucket that stops being counted is the one
  // failure this chart cannot show on its face, because the ring still closes.
  for (let a = 0; a <= 3; a++) {
    for (let b = 0; b <= 3; b++) {
      for (let c = 0; c <= 3; c++) {
        for (let d = 0; d <= 3; d++) {
          const h = buildHealth([
            ...many(a, overdue),
            ...many(b, missing),
            ...many(c, soon),
            ...many(d, later),
          ])
          assert.equal(h.total, a + b + c + d, `lost an item at ${a}/${b}/${c}/${d}`)
          assert.equal(
            h.buckets.reduce((n, x) => n + x.count, 0),
            h.total,
            `buckets disagree with the total at ${a}/${b}/${c}/${d}`,
          )
        }
      }
    }
  }
})

test('always four buckets, in rank order, empty ones included', () => {
  // Order is the product: `unknown` sits second, WITH overdue, because not
  // knowing when a card expires carries the same exposure as it having expired.
  const h = buildHealth([])
  assert.deepEqual(
    h.buckets.map((b) => b.key),
    ['overdue', 'unknown', 'soon', 'ontrack'],
  )
  assert.equal(h.total, 0)
})

test('a duty with no schedule is not a bucket and is declared instead', () => {
  // 'Check yourself' rows are not overdue, not on track, and have no date to be
  // missing. Counting them anywhere would put a number on the ring that no
  // colour in the vocabulary can honestly describe.
  const h = buildHealth([overdue, { standing: 'unsupported' }, { standing: 'unsupported' }])
  assert.equal(h.total, 1)
  assert.equal(h.unschedulable, 2)
  assert.equal(count(h, 'ontrack'), 0)
})

test('a rule that does not apply is counted nowhere at all', () => {
  const h = buildHealth([{ standing: 'not_applicable' }, later])
  assert.equal(h.total, 1)
  assert.equal(h.unschedulable, 0)
})

// --- 2. a missing date is never a pass --------------------------------------

test('a missing date never counts as on track', () => {
  const h = buildHealth(many(30, missing))
  assert.equal(count(h, 'unknown'), 30)
  assert.equal(count(h, 'ontrack'), 0)
  assert.equal(h.onTrack, 0)
  assert.equal(h.needsAttention, 30)
})

test('a missing date that still carries a computable next date is not on track', () => {
  // IFTA knows when the quarter closes without knowing whether the last one was
  // ever filed. The date is real; the reassurance is the invention.
  const h = buildHealth([{ standing: 'unknown', daysUntil: 300 }])
  assert.equal(count(h, 'unknown'), 1)
  assert.equal(count(h, 'ontrack'), 0)
})

test('the grey bucket is drawn, never dropped', () => {
  const slices = donutSlices(buildHealth([...many(399, later), missing]))
  const grey = slices.find((s) => s.key === 'unknown')
  assert.ok(grey, 'the one missing date vanished from the ring')
  assert.equal(grey.count, 1)
})

// --- 3. the centre number means exactly what the screen says -----------------

test('the centre number is everything that is not on track', () => {
  const h = buildHealth([
    ...many(4, overdue),
    ...many(12, missing),
    ...many(5, soon),
    ...many(22, later),
  ])
  assert.equal(h.needsAttention, 21)
  assert.equal(h.needsAttention, h.total - h.onTrack)
  assert.equal(h.needsAttention, count(h, 'overdue') + count(h, 'unknown') + count(h, 'soon'))
})

test('the centre number is always the total minus the green slice', () => {
  for (let a = 0; a <= 3; a++) {
    for (let b = 0; b <= 3; b++) {
      for (let c = 0; c <= 3; c++) {
        for (let d = 0; d <= 3; d++) {
          const h = buildHealth([
            ...many(a, overdue),
            ...many(b, missing),
            ...many(c, soon),
            ...many(d, later),
          ])
          assert.equal(h.needsAttention, h.total - h.onTrack, `at ${a}/${b}/${c}/${d}`)
        }
      }
    }
  }
})

test('the parts printed under the ring add up to the centre number', () => {
  // This is the no-unexplained-score rule as a test. If the sentence and the
  // number ever disagree, the number is a score a broker can quote and the
  // carrier cannot take apart.
  const h = buildHealth([
    ...many(4, overdue),
    ...many(12, missing),
    ...many(5, soon),
    ...many(22, later),
  ])
  const parts = attentionParts(h)
  assert.deepEqual(
    parts.map((p) => p.count),
    [4, 12, 5],
  )
  assert.equal(
    parts.reduce((n, p) => n + p.count, 0),
    h.needsAttention,
  )
  // Green never appears in the addition; it is the remainder, not a part of it.
  assert.ok(!parts.some((p) => p.key === 'ontrack'))
})

test('an empty part is left out of the addition but stays on the ring legend', () => {
  const h = buildHealth([...many(3, overdue), ...many(9, later)])
  assert.deepEqual(
    attentionParts(h).map((p) => p.key),
    ['overdue'],
  )
  assert.equal(h.buckets.length, 4)
})

test('the day boundary the soon bucket uses is the one the dashboard says', () => {
  const on = buildHealth([{ standing: 'current', daysUntil: SOON_DAYS }])
  assert.equal(count(on, 'soon'), 1)
  const past = buildHealth([{ standing: 'current', daysUntil: SOON_DAYS + 1 }])
  assert.equal(count(past, 'soon'), 0)
  assert.equal(count(past, 'ontrack'), 1)
  // The label has to say the same number the bucket used, or the tile is a lie
  // about its own contents.
  assert.equal(on.buckets[2].label, `Due in ${SOON_DAYS} days`)
})

test('the headline states the answer and agrees with the number', () => {
  assert.equal(healthHeadline(buildHealth([])), 'Nothing tracked yet')
  assert.equal(healthHeadline(buildHealth(many(5, later))), 'Nothing needs attention')
  assert.equal(healthHeadline(buildHealth([overdue])), '1 needs attention')
  assert.equal(healthHeadline(buildHealth([overdue, missing])), '2 need attention')
})

// --- 4. a real bucket is never an invisible arc ------------------------------

test('the live slices close the ring exactly', () => {
  for (const fixture of [
    [...many(4, overdue), ...many(12, missing), ...many(5, soon), ...many(22, later)],
    [...many(399, later), missing],
    [...many(1, overdue), ...many(1, missing), ...many(1, soon), ...many(997, later)],
    many(7, soon),
  ]) {
    const slices = donutSlices(buildHealth(fixture))
    const last = slices[slices.length - 1]
    assert.ok(Math.abs(last.offset + last.percent - 100) < 1e-9, 'the ring does not close')
    // And no arc starts before the one before it ended.
    slices.reduce((edge, s) => {
      assert.ok(Math.abs(s.offset - edge) < 1e-9, 'a gap opened between two arcs')
      return s.offset + s.percent
    }, 0)
  }
})

test('one item in four hundred is still a visible arc', () => {
  // 1/400 is 0.25% of a ring: a sub-pixel the browser rounds away. "A little"
  // against "none" is the entire question this chart is being asked.
  const slices = donutSlices(buildHealth([...many(399, later), overdue]))
  const red = slices.find((s) => s.key === 'overdue')
  assert.ok(red && red.percent >= 1.5, `overdue drew at ${red?.percent}%`)
})

test('the floor is paid for by the big slice, never by another small one', () => {
  const slices = donutSlices(buildHealth([...many(997, later), overdue, missing, soon]))
  for (const s of slices) {
    if (s.key === 'ontrack') continue
    assert.ok(s.percent >= 1.5 - 1e-9, `${s.key} was squeezed to ${s.percent}%`)
  }
  const green = slices.find((s) => s.key === 'ontrack')
  assert.ok(green && green.percent < 99.7, 'the big slice did not give the width back')
})

test('an empty bucket draws nothing', () => {
  const slices = donutSlices(buildHealth([...many(2, overdue), ...many(3, later)]))
  assert.deepEqual(
    slices.map((s) => s.key),
    ['overdue', 'ontrack'],
  )
})

test('a fleet with nothing tracked has no ring to draw', () => {
  assert.deepEqual(donutSlices(buildHealth([])), [])
})

test('one bucket holding everything is a whole ring', () => {
  const slices = donutSlices(buildHealth(many(9, overdue)))
  assert.equal(slices.length, 1)
  assert.equal(slices[0].offset, 0)
  assert.equal(slices[0].percent, 100)
})

test('the arcs come round in the same order as the tiles under them', () => {
  // The tiles are the ring's legend. If the ring reorders itself by size, the
  // legend stops matching the picture and colour becomes the only thing tying
  // the two together — which is exactly what the colour rule forbids.
  const slices = donutSlices(
    buildHealth([...many(1, overdue), ...many(40, missing), ...many(2, soon), ...many(9, later)]),
  )
  assert.deepEqual(
    slices.map((s) => s.key),
    ['overdue', 'unknown', 'soon', 'ontrack'],
  )
})

test('something finished years ago is on track, not "due in 45 days"', () => {
  // THE BUG THIS PINS, which turned up three separate times in one day.
  //
  // `daysUntil` is NEGATIVE for a one-time obligation that has been satisfied.
  // A pre-employment Clearinghouse query run the week a driver was hired comes
  // back `current` with something like -2040. A window test written as
  // `days <= soonDays` is TRUE for that, so twenty finished items landed in the
  // amber arc under a tile reading "Due in 45 days".
  //
  // The same shape appeared in the qualification binder, where it printed
  // "Expires soon" forever on a file with nothing wrong with it, and again in
  // the dashboard's own filter. If you are comparing `daysUntil` to a window,
  // the past must not pass it.
  const done: HealthInput = { standing: 'current', daysUntil: -2040 }
  const h = buildHealth([done])

  assert.equal(h.buckets.find((b) => b.key === 'soon')?.count, 0)
  assert.equal(h.buckets.find((b) => b.key === 'ontrack')?.count, 1)

  // And the boundary either side of zero, so nobody "fixes" this with `> 0`
  // and quietly drops whatever is due today.
  assert.equal(
    buildHealth([{ standing: 'current', daysUntil: 0 }]).buckets.find((b) => b.key === 'soon')
      ?.count,
    1,
    'due today is due soon',
  )
  assert.equal(
    buildHealth([{ standing: 'current', daysUntil: -1 }]).buckets.find((b) => b.key === 'soon')
      ?.count,
    0,
    'yesterday is not due soon',
  )
})
