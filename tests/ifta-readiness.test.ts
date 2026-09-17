/**
 * The return-readiness strip, and the one reading it must never allow.
 *
 * A progress bar over a tax return invites exactly one conclusion — "it is full,
 * so I can file" — and that conclusion is false in every case this file pins:
 * a truck can have miles entered and still have the wrong miles, a jurisdiction
 * can be missing its rate, and the receipts for a quarter arrive for months. So
 * the tests below are mostly about what the strip REFUSES to say.
 *
 *   1. A truck totalling zero miles is grey, not green. The bar must err short.
 *   2. A fleet with no trucks divides by nothing and claims nothing.
 *   3. The fraction cannot exceed 1, including when a mileage row still carries
 *      the id of a truck that has left the fleet.
 *   4. Two steps of the checklist can never be completed by software, so a full
 *      bar always sits above an open list.
 *   5. Nothing anywhere in the output tells anybody the return is ready.
 *   6. A jurisdiction with twelve miles still draws as a visible bar.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jurisdictionMilesBars, returnReadiness } from '../src/lib/charts/ifta-readiness.ts'
import { ceilingFor, MIN_VISIBLE_PERCENT, widthPercent } from '../src/lib/charts/scale.ts'

const hrefs = { miles: '/app/ifta/miles', fuel: '/app/ifta/fuel', trucks: '/app/vehicles/new' }

const truck = (id: string, label = id) => ({ id, label })

/** A readable default: 7 trucks, 4 of them with miles, everything else healthy. */
function readiness(over: Partial<Parameters<typeof returnReadiness>[0]> = {}) {
  return returnReadiness({
    trucks: [
      truck('t1', 'Unit 01'),
      truck('t2', 'Unit 02'),
      truck('t3', 'Unit 03'),
      truck('t4', 'Unit 04'),
      truck('t5', 'Unit 05'),
      truck('t6', 'Unit 06'),
      truck('t7', 'Unit 07'),
    ],
    rows: [
      { vehicleId: 't1', miles: 4_000 },
      { vehicleId: 't2', miles: 3_800 },
      { vehicleId: 't3', miles: 4_100 },
      { vehicleId: 't4', miles: 3_700 },
    ],
    missingRates: [],
    totalMiles: 15_600,
    totalGallonsMilli: 2_400_000,
    daysLeft: 45,
    dueLabel: 'Oct 31, 2026',
    hrefs,
    ...over,
  })
}

// ------------------------------------------------------------------ the counts

test('the strip counts trucks, and prints the arithmetic rather than a score', () => {
  const r = readiness()
  assert.equal(r.totalTrucks, 7)
  assert.equal(r.withMiles, 4)
  assert.equal(r.withoutMiles, 3)
  assert.equal(r.headline, '3 trucks still need miles')
  assert.equal(r.countLine, '4 of 7 trucks have miles entered.')
  // No bare percentage anywhere a person reads. "43% ready" is the unexplained
  // score the owner ruled out; "4 of 7" is arithmetic he can check.
  const prose = [r.headline, r.countLine, ...r.steps.map((x) => `${x.label} ${x.detail}`)].join(' ')
  assert.ok(!/%/.test(prose), `a percentage leaked into the copy: ${prose}`)
})

test('a truck with zero miles is not ready, it is missing', () => {
  // The whole bias of this bar. A trip sheet typed as zeroes puts nothing on the
  // return, so counting it as progress lengthens the bar without making the
  // return any more complete — and the one direction this must never err in is
  // over-stating.
  const r = readiness({
    rows: [
      { vehicleId: 't1', miles: 4_000 },
      { vehicleId: 't2', miles: 0 },
    ],
  })
  assert.equal(r.withMiles, 1)
  assert.equal(r.withoutMiles, 6)
  assert.ok(r.waiting.includes('Unit 02'), 'the zero-mile truck must be named as still waiting')
})

test('the grey trucks are named, because a name is something you can act on', () => {
  const r = readiness()
  assert.deepEqual(r.waiting, ['Unit 05', 'Unit 06', 'Unit 07'])
  assert.equal(r.waitingMore, 0)
  const miles = r.steps.find((x) => x.key === 'miles')
  assert.ok(miles?.detail.includes('Unit 05'), 'the miles step must name the trucks')
})

test('grey is never folded into the green', () => {
  const r = readiness()
  const green = r.segments.find((x) => x.tone === 'good')
  const grey = r.segments.find((x) => x.tone === 'neutral')
  assert.equal(green?.count, 4)
  assert.equal(grey?.count, 3)
  // Both segments exist even when one is zero, so the legend can never quietly
  // drop the category the strip is about.
  const done = readiness({
    rows: Array.from({ length: 7 }, (_, i) => ({ vehicleId: `t${i + 1}`, miles: 1_000 })),
  })
  assert.equal(done.segments.length, 2)
  assert.equal(done.segments.find((x) => x.tone === 'neutral')?.count, 0)
  assert.equal(done.withMiles + done.withoutMiles, done.totalTrucks)
})

// ------------------------------------------------------------- the arithmetic

test('a fleet with no trucks does not divide by zero', () => {
  const r = readiness({ trucks: [], rows: [] })
  assert.equal(r.totalTrucks, 0)
  assert.equal(r.withMiles, 0)
  assert.equal(r.withoutMiles, 0)
  // 0, never NaN, and never 1 either: a carrier with nothing on file has made no
  // progress, it has not finished.
  assert.equal(r.fraction, 0)
  assert.ok(Number.isFinite(r.fraction))
  assert.equal(r.headline, 'No trucks on file yet')
})

test('the fraction never exceeds 1, even with a stale truck id on the rows', () => {
  // A mileage row still carrying the id of a truck that has left the fleet. Count
  // distinct ids on the rows instead of walking the truck list and this prints
  // "9 of 7 trucks" over a bar wider than its own track.
  const r = readiness({
    trucks: [truck('t1', 'Unit 01'), truck('t2', 'Unit 02')],
    rows: [
      { vehicleId: 't1', miles: 500 },
      { vehicleId: 't2', miles: 500 },
      { vehicleId: 'sold-last-year', miles: 9_000 },
      { vehicleId: null, miles: 300 },
    ],
  })
  assert.equal(r.totalTrucks, 2)
  assert.equal(r.withMiles, 2)
  assert.ok(r.fraction <= 1, `fraction was ${r.fraction}`)
  assert.equal(r.fraction, 1)
  assert.ok(r.withoutMiles >= 0)
})

test('an unreadable truck list claims nothing at all', () => {
  // `null` is not "no trucks". One is a question we cannot answer, the other is
  // an answer, and collapsing them prints "all trucks have miles" over a failed
  // query.
  const r = readiness({ trucks: null })
  assert.equal(r.unreadable, true)
  assert.equal(r.totalTrucks, 0)
  assert.equal(r.withMiles, 0)
  assert.equal(r.fraction, 0)
  assert.equal(r.headline, 'We could not read your truck list')
  assert.equal(r.steps.find((x) => x.key === 'miles')?.tone, 'neutral')
})

// --------------------------------------------------------------- the refusals

test('a full bar still sits over an open checklist', () => {
  const r = readiness({
    rows: Array.from({ length: 7 }, (_, i) => ({ vehicleId: `t${i + 1}`, miles: 2_000 })),
  })
  assert.equal(r.withoutMiles, 0)
  assert.equal(r.fraction, 1)
  assert.equal(r.headline, 'All 7 trucks have miles entered')

  // The two steps no software can finish. If either of these ever goes green the
  // strip has become a green light, which is the failure this whole file exists
  // to prevent.
  assert.equal(r.steps.find((x) => x.key === 'check')?.tone, 'neutral')
  assert.notEqual(r.steps.find((x) => x.key === 'file')?.tone, 'good')
  assert.ok(
    r.steps.some((x) => x.tone !== 'good'),
    'every step went green at once',
  )
})

test('nothing in the output tells anybody the return is ready', () => {
  for (const r of [
    readiness(),
    readiness({
      rows: Array.from({ length: 7 }, (_, i) => ({ vehicleId: `t${i + 1}`, miles: 9 })),
    }),
    readiness({ trucks: [], rows: [] }),
    readiness({ trucks: null }),
  ]) {
    // Only the parts that ASSERT A STATE. The caveat is checked separately
    // below, because the one place "ready to file" is allowed to appear is
    // inside the sentence that denies it.
    const prose = [r.headline, r.countLine, ...r.steps.map((x) => `${x.label} ${x.detail}`)]
      .join(' ')
      .toLowerCase()
    assert.ok(
      !/\bready\b|\bcomplete\b|\bdone\b|\ball set\b|\bgood to go\b|\bsafe to file\b/.test(prose),
      `readiness copy handed out permission to file: ${prose}`,
    )
  }
})

test('the caveat is never empty, and says a full bar is not permission', () => {
  const r = readiness()
  assert.ok(r.caveat.length >= 3)
  assert.ok(r.caveat.some((c) => /not mean the return is ready to file/i.test(c)))
  // The parked truck. Grey must not read as an accusation of bad bookkeeping.
  assert.ok(r.caveat.some((c) => /did not run/i.test(c)))
})

// ------------------------------------------------------------- the step tones

test('red is act now, amber is due soon, grey is missing', () => {
  // Miles missing is GREY, not red: a trip sheet nobody has typed is missing, not
  // wrong, and red here would compete with the blockers that mean something worse.
  assert.equal(readiness().steps.find((x) => x.key === 'miles')?.tone, 'neutral')

  // Miles on file and no gallons at all prices every jurisdiction at nothing,
  // which files short. That is red.
  const noFuel = readiness({ totalGallonsMilli: 0 })
  assert.equal(noFuel.steps.find((x) => x.key === 'fuel')?.tone, 'overdue')

  // A jurisdiction with no rate is red and NAMED. "2 jurisdictions are missing a
  // rate" is a sentence nobody can act on.
  const noRates = readiness({ missingRates: ['OR', 'WA'] })
  const rates = noRates.steps.find((x) => x.key === 'rates')
  assert.equal(rates?.tone, 'overdue')
  assert.ok(rates?.detail.includes('OR') && rates?.detail.includes('WA'))

  assert.equal(readiness({ daysLeft: 12 }).steps.find((x) => x.key === 'file')?.tone, 'soon')
  assert.equal(readiness({ daysLeft: -3 }).steps.find((x) => x.key === 'file')?.tone, 'overdue')
  assert.equal(readiness({ daysLeft: 80 }).steps.find((x) => x.key === 'file')?.tone, 'neutral')
})

test('an empty quarter is missing, not broken', () => {
  // Nothing entered at all: no miles and no fuel. That is a quarter nobody has
  // started, so it is grey rather than the red reserved for a return that would
  // file short.
  const r = readiness({ totalMiles: 0, totalGallonsMilli: 0, rows: [] })
  assert.equal(r.steps.find((x) => x.key === 'fuel')?.tone, 'neutral')
  assert.equal(r.steps.find((x) => x.key === 'rates')?.tone, 'neutral')
})

// ------------------------------------------------------- miles by jurisdiction

test('miles add up per jurisdiction across every truck', () => {
  const j = jurisdictionMilesBars([
    { jurisdiction: 'CA', miles: 5_000 },
    { jurisdiction: 'NV', miles: 2_000 },
    { jurisdiction: 'CA', miles: 4_100 },
    { jurisdiction: 'AZ', miles: 4_000 },
  ])
  assert.equal(j.total, 15_100)
  assert.deepEqual(
    j.items.map((i) => [i.label, i.value]),
    [
      ['CA', 9_100],
      ['AZ', 4_000],
      ['NV', 2_000],
    ],
  )
  assert.equal(j.items[0].display, '9,100')
  assert.ok(j.takeaway?.includes('CA has 9,100 of the 15,100 miles on file'))
})

test('a jurisdiction with twelve miles still draws as a visible bar', () => {
  // THE reason MIN_VISIBLE_PERCENT exists. 12 miles against a 16,000 ceiling is
  // 0.075% of the width — sub-pixel, and indistinguishable from the state the
  // trucks never entered. "A little" versus "none" is the entire question an
  // IFTA auditor is asking.
  const j = jurisdictionMilesBars([
    { jurisdiction: 'CA', miles: 15_588 },
    { jurisdiction: 'OR', miles: 12 },
  ])
  // The same ceiling `Bars` computes internally, off the WHOLE set.
  const ceiling = ceilingFor(j.items.map((i) => i.value))
  const thin = widthPercent(j.items[1].value, ceiling)
  assert.ok(thin !== null)
  assert.ok((thin ?? 0) >= MIN_VISIBLE_PERCENT, `12 miles drew at ${thin}%`)
  assert.ok((thin ?? 0) < 100)
  // And it is still the shorter bar — the floor must not flatten the ranking.
  assert.ok((widthPercent(j.items[0].value, ceiling) ?? 0) > (thin ?? 0))
})

test('ties are broken by code, so two page loads agree', () => {
  const j = jurisdictionMilesBars([
    { jurisdiction: 'NV', miles: 100 },
    { jurisdiction: 'AZ', miles: 100 },
    { jurisdiction: 'CA', miles: 100 },
  ])
  assert.deepEqual(
    j.items.map((i) => i.label),
    ['AZ', 'CA', 'NV'],
  )
})

test('no rows is no chart, not a chart of nothing', () => {
  const j = jurisdictionMilesBars([])
  assert.deepEqual(j.items, [])
  assert.equal(j.total, 0)
  assert.equal(j.takeaway, null)
})
