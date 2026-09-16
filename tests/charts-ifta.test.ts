/**
 * The IFTA charts, and the ways a quarter drawn as a picture lies.
 *
 * tests/charts.test.ts pins the general failures — an unknown drawn as a zero,
 * a real value drawn as a sliver, an axis built from the data. These pin the
 * ones specific to a tax return, which are worse, because the half-entered
 * quarter is not an edge case here. It is the ordinary state of every quarter
 * for about four months:
 *
 *   1. Fuel in, miles not yet. Receipts arrive daily and odometers arrive at
 *      quarter end, so this is the NORMAL order — and drawn naively it is a
 *      full green bar against every jurisdiction, a refund announced as fact.
 *   2. A jurisdiction with no tax rate loaded. Its miles are known and its tax
 *      is not, and at the centre line of a diverging chart it reads as settled.
 *   3. Six of nine trucks with trip sheets entered. Every bar on the chart is
 *      then short at once, which is indistinguishable from a quiet quarter.
 *   4. A quarter's average drawn as zero rather than as absent, or compared
 *      against a quarter somebody is still typing into.
 *
 * Each test below names the one it holds shut.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  milesFigure,
  mpgTrend,
  netTaxFigure,
  quarterStillOpen,
  quarterTotals,
  truckCoverage,
  truckMilesFigure,
} from '../src/lib/charts/ifta.ts'
import {
  type FuelRow,
  type MileRow,
  quarterlyReturn,
  type RateRow,
  returnDueOn,
} from '../src/lib/ifta/compute.ts'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

/** Sep 15 2026, the same "today" tests/charts.test.ts uses. */
const today = utc(2026, 9, 15)

const ret = (miles: MileRow[], fuel: FuelRow[], rates: RateRow[]) =>
  quarterlyReturn({ miles, fuel, rates })

/** A quarter that is genuinely finished: both inputs present, every rate loaded. */
const complete = () =>
  ret(
    [
      { jurisdiction: 'CA', miles: 10_000 },
      { jurisdiction: 'NV', miles: 4_000 },
    ],
    [
      { jurisdiction: 'CA', gallonsMilli: 2_000_000, taxPaid: true },
      { jurisdiction: 'NV', gallonsMilli: 100_000, taxPaid: true },
    ],
    [
      { jurisdiction: 'CA', rateMills: 979 },
      { jurisdiction: 'NV', rateMills: 380 },
    ],
  )

// -------------------------------------------------- the half-entered quarter

test('a quarter with fuel and no miles yet draws no net-tax chart at all', () => {
  // The failure this whole module exists for, and it is the NORMAL order of a
  // real quarter. With no miles there are no taxable gallons, so every
  // jurisdiction comes out as a pure credit — a wall of green announcing a
  // refund that is not owed. A caveat under the chart does not fix it: the
  // shape is taken in first and in about a second.
  const fig = netTaxFigure({
    result: ret(
      [],
      [{ jurisdiction: 'CA', gallonsMilli: 2_000_000, taxPaid: true }],
      [{ jurisdiction: 'CA', rateMills: 979 }],
    ),
    trucks: null,
    open: true,
  })
  assert.equal(fig.items.length, 0)
  assert.ok(fig.refusal, 'the caller must be told there is nothing honest to draw')
  assert.match(fig.refusal, /credit/)
})

test('a quarter with miles and no fuel yet draws no net-tax chart either', () => {
  // The mirror image, and the one `complete` used to let through: with no
  // gallons there is no fleet average, so every taxable-gallon figure
  // multiplies out to nothing and the whole return prices at $0.00 on thousands
  // of miles. A return nobody can compute is not a return that owes nothing.
  const fig = netTaxFigure({
    result: ret(
      [{ jurisdiction: 'CA', miles: 10_000 }],
      [],
      [{ jurisdiction: 'CA', rateMills: 979 }],
    ),
    trucks: null,
    open: false,
  })
  assert.equal(fig.items.length, 0)
  assert.match(fig.refusal ?? '', /fleet average/)
})

test('an empty quarter is refused rather than drawn as a settled one', () => {
  const fig = netTaxFigure({ result: ret([], [], []), trucks: null, open: false })
  assert.equal(fig.items.length, 0)
  assert.ok(fig.refusal)
})

// ------------------------------------------------------ the unpriced jurisdiction

test('a jurisdiction with no rate never lands on the centre line of the net chart', () => {
  // A missing rate is not a zero. Placed at the centre of a diverging axis it
  // reads as "settled, nothing owed either way", which is precisely the lie the
  // `rate_unknown` outcome was invented to prevent — and it is the shape an
  // audit finds, because the filing is quietly short by exactly that state.
  const result = ret(
    [
      { jurisdiction: 'CA', miles: 10_000 },
      { jurisdiction: 'NV', miles: 4_000 },
    ],
    [{ jurisdiction: 'CA', gallonsMilli: 2_000_000, taxPaid: true }],
    [{ jurisdiction: 'CA', rateMills: 979 }],
  )
  const fig = netTaxFigure({ result, trucks: null, open: false })

  // NV stays ON the chart, carrying `null` rather than a number. `Diverging`
  // draws that as an unknown spanning the centre, which is a different claim
  // from sitting on it: one says "we could not price this", the other says
  // "nothing is owed either way". Dropping the row entirely — the first version
  // of this — kept the lie out but left the prose underneath as the only trace
  // of a jurisdiction he still has to file for, and prose under a chart is read
  // second if it is read at all.
  const nv = fig.items.find((i) => i.label === 'NV')
  assert.ok(nv, 'the jurisdiction must not disappear from the chart')
  assert.equal(nv.value, null, 'a missing rate is never a number, least of all zero')

  // The priced rows still sort by amount, and the unpriced ones sort after all
  // of them — they have no position on the axis to earn.
  assert.deepEqual(
    fig.items.map((i) => i.label),
    ['CA', 'NV'],
  )

  // On the chart is not the same as explained. The code has to be in the
  // caveat too, because "3 jurisdictions are missing a rate" is a sentence
  // nobody can act on.
  assert.match(fig.coverage ?? '', /NV/)
})

test('a jurisdiction with no rate stays on the mileage chart, where the figure is real', () => {
  // The miles ARE known; only the tax on them is not. Dropping the row from
  // both charts would take a state the trucks demonstrably ran in off the only
  // picture of the quarter.
  const result = ret(
    [
      { jurisdiction: 'CA', miles: 10_000 },
      { jurisdiction: 'NV', miles: 4_000 },
    ],
    [{ jurisdiction: 'CA', gallonsMilli: 2_000_000, taxPaid: true }],
    [{ jurisdiction: 'CA', rateMills: 979 }],
  )
  const fig = milesFigure({ result, fuel: [], trucks: null, open: false })

  const nv = fig.items.find((i) => i.label === 'NV')
  assert.equal(nv?.value, 4_000)
  assert.match(nv?.note ?? '', /no tax rate/i)
  // Red because the row is a problem, not because it is a big one — the same
  // red the table under the chart already paints an unpriced line.
  assert.equal(nv?.tone, 'overdue')
})

// -------------------------------------------------------- miles we do not have

test('a jurisdiction we hold a receipt from is never drawn at zero miles', () => {
  // Nobody buys diesel in a state they did not drive in. A zero-length bar here
  // claims the trucks never went, contradicted by a fuel row on the same
  // return, and a zero is what `quarterlyReturn` reports for a jurisdiction
  // that reached it through fuel alone.
  const result = ret(
    [{ jurisdiction: 'CA', miles: 10_000 }],
    [
      { jurisdiction: 'CA', gallonsMilli: 2_000_000, taxPaid: true },
      { jurisdiction: 'NV', gallonsMilli: 150_000, taxPaid: true },
    ],
    [
      { jurisdiction: 'CA', rateMills: 979 },
      { jurisdiction: 'NV', rateMills: 380 },
    ],
  )
  const fig = milesFigure({
    result,
    fuel: [
      { jurisdiction: 'CA', gallonsMilli: 2_000_000, taxPaid: true },
      { jurisdiction: 'NV', gallonsMilli: 150_000, taxPaid: true },
    ],
    trucks: null,
    open: false,
  })

  const nv = fig.items.find((i) => i.label === 'NV')
  assert.equal(nv?.value, null, 'no miles on file is an absence, never a measured zero')
  assert.notEqual(nv?.display, '0')
  assert.match(nv?.note ?? '', /fuel was bought here/i)
})

test('the jurisdictions we have no figure for rank last, not first', () => {
  // `null` sorted naively lands at the top of a descending list, where a dashed
  // slot at the head of a ranked chart reads as the biggest bar on it.
  const result = ret(
    [
      { jurisdiction: 'CA', miles: 100 },
      { jurisdiction: 'TX', miles: 5_000 },
    ],
    [{ jurisdiction: 'NV', gallonsMilli: 150_000, taxPaid: true }],
    [],
  )
  const fig = milesFigure({
    result,
    fuel: [{ jurisdiction: 'NV', gallonsMilli: 150_000, taxPaid: true }],
    trucks: null,
    open: false,
  })
  assert.deepEqual(
    fig.items.map((i) => i.label),
    ['TX', 'CA', 'NV'],
  )
})

test('the collapsed tail never swallows a jurisdiction that carries a caveat', () => {
  // The rows with something wrong with them sort LAST, so a flat limit of ten
  // hides exactly the ones the chart exists to keep on screen — behind a link
  // reading "5 more", which is the quietest way a chart can drop a state off a
  // tax return. Fifteen jurisdictions, one of them unpriced.
  const miles: MileRow[] = Array.from({ length: 15 }, (_, i) => ({
    jurisdiction: `J${String(i).padStart(2, '0')}`,
    miles: 1_000 * (15 - i),
  }))
  const fig = milesFigure({
    result: ret(
      miles,
      [{ jurisdiction: 'J00', gallonsMilli: 2_000_000, taxPaid: true }],
      // Every jurisdiction priced except the smallest, which therefore ranks
      // dead last.
      miles.slice(0, 14).map((m) => ({ jurisdiction: m.jurisdiction, rateMills: 500 })),
    ),
    fuel: [],
    trucks: null,
    open: false,
  })

  assert.equal(fig.items[14].label, 'J14')
  assert.match(fig.items[14].note ?? '', /no tax rate/i)
  assert.ok(fig.limit >= 15, `the unpriced row must be drawn, got a limit of ${fig.limit}`)

  // And a clean list still collapses, or the limit stops meaning anything.
  const clean = milesFigure({ result: complete(), fuel: [], trucks: null, open: false })
  assert.equal(clean.limit, 10)
})

// ------------------------------------------------------------ truck coverage

test('a chart drawn from six of nine trucks says so', () => {
  // The mileage chart is drawn from the trucks whose trip sheets somebody
  // entered. The three nobody entered are not short bars, they are absent —
  // and a fleet two trucks short looks exactly like a quiet quarter.
  const fleet = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
  const trucks = truckCoverage(
    fleet,
    fleet.slice(0, 6).map((id) => ({ vehicleId: id, miles: 4_000 })),
  )
  assert.equal(trucks.total, 9)
  assert.equal(trucks.reporting, 6)

  const miles = milesFigure({ result: complete(), fuel: [], trucks, open: false })
  assert.match(miles.coverage ?? '', /6 of 9/)

  // The tax chart has to say more than the mileage chart does: every figure on
  // it is DERIVED from those miles, so a missing truck shortens every bar at
  // once rather than removing one.
  const net = netTaxFigure({ result: complete(), trucks, open: false })
  assert.match(net.coverage ?? '', /6 of 9/)
  assert.match(net.coverage ?? '', /floor/)
})

test('a truck list we could not read is not a fleet that all reported', () => {
  // The two have to stay apart. One is a question we cannot answer; the other
  // is an answer. Collapsed, a failed query prints as a complete picture.
  const trucks = truckCoverage(null, [])
  assert.equal(trucks.unreadable, true)
  const fig = milesFigure({ result: complete(), fuel: [], trucks, open: false })
  assert.match(fig.coverage ?? '', /could not be read/)
})

test('a row carrying a truck that has left the fleet cannot print "10 of 9"', () => {
  const trucks = truckCoverage(
    ['a'],
    [
      { vehicleId: 'a', miles: 1_000 },
      { vehicleId: 'gone', miles: 5_000 },
    ],
  )
  assert.equal(trucks.reporting, 1)
  assert.equal(trucks.total, 1)
})

test('miles belonging to no truck are counted rather than lost', () => {
  const trucks = truckCoverage(['a'], [{ vehicleId: null, miles: 120 }])
  assert.equal(trucks.orphanMiles, 120)
  assert.equal(trucks.reporting, 0)
})

test('a finished quarter with the whole fleet reporting carries no caveat', () => {
  // The other half of rule four. If the amber note appears under every chart it
  // stops being read, and the charts that genuinely are incomplete lose the one
  // thing that says so.
  const trucks = truckCoverage(['a'], [{ vehicleId: 'a', miles: 14_000 }])
  assert.equal(netTaxFigure({ result: complete(), trucks, open: false }).coverage, undefined)
  assert.equal(
    milesFigure({ result: complete(), fuel: [], trucks, open: false }).coverage,
    undefined,
  )
})

// ------------------------------------------------------------- miles by truck

const fleetOf = (...ids: string[]) =>
  ids.map((id) => ({ id, label: `Unit ${id}`, href: `/app/ifta/miles?v=${id}` }))

test('a truck with no trip sheet on file is an empty slot, not a bar at zero', () => {
  // The distinction the whole chart exists for. A truck drawn at zero has run
  // nothing; a truck nobody has typed in has run something nobody knows. Only
  // the second is ever what we have evidence for, and it is the one that makes
  // the return short.
  const fig = truckMilesFigure({
    trucks: fleetOf('a', 'b'),
    rows: [{ vehicleId: 'a', miles: 12_000 }],
    unreadable: false,
  })
  const b = fig.items.find((i) => i.label === 'Unit b')
  assert.equal(b?.value, null)
  assert.equal(b?.display, 'nothing entered')
  assert.match(fig.coverage ?? '', /has not run nothing, it has not been typed in/)
  assert.match(fig.takeaway ?? '', /1 of 2 trucks have miles entered/)
})

test('a trip sheet typed as zeroes counts as entered, because somebody went through it', () => {
  const fig = truckMilesFigure({
    trucks: fleetOf('a'),
    rows: [{ vehicleId: 'a', miles: 0 }],
    unreadable: false,
  })
  assert.equal(fig.items[0].value, 0)
  assert.equal(fig.coverage, undefined)
})

test('miles belonging to no truck are named, because the bars do not add up to the return', () => {
  // Left unsaid, the chart quietly claims the fleet ran 12,000 miles while the
  // return on the next screen is built from 13,400.
  const fig = truckMilesFigure({
    trucks: fleetOf('a'),
    rows: [
      { vehicleId: 'a', miles: 12_000 },
      { vehicleId: null, miles: 1_400 },
    ],
    unreadable: false,
  })
  assert.match(fig.coverage ?? '', /1,400 miles this quarter are recorded against no truck/)
})

test('a failed read makes every truck unknown rather than accusing all of them', () => {
  // '0 miles' against a truck with twelve jurisdictions already on file is an
  // accusation, and on a failed read the whole fleet would be wearing one.
  const fig = truckMilesFigure({
    trucks: fleetOf('a', 'b'),
    rows: [],
    unreadable: true,
  })
  assert.deepEqual(
    fig.items.map((i) => i.value),
    [null, null],
  )
  assert.equal(fig.takeaway, null, 'nothing may be claimed from a read that failed')
  assert.match(fig.coverage ?? '', /could not be read/)
})

// --------------------------------------------------------------- the ordering

test('the biggest bill is at the top and the biggest credit at the bottom', () => {
  // The axis runs owed-to-the-right, so the list has to run owed-to-the-top or
  // the chart reads in two directions at once.
  const result = ret(
    [
      { jurisdiction: 'CA', miles: 2_000 },
      { jurisdiction: 'NV', miles: 20_000 },
      { jurisdiction: 'AZ', miles: 8_000 },
    ],
    [{ jurisdiction: 'CA', gallonsMilli: 4_000_000, taxPaid: true }],
    [
      { jurisdiction: 'CA', rateMills: 979 },
      { jurisdiction: 'NV', rateMills: 380 },
      { jurisdiction: 'AZ', rateMills: 260 },
    ],
  )
  const fig = netTaxFigure({ result, trucks: null, open: false })
  const values = fig.items.map((i) => i.value)
  // Every jurisdiction in this fixture has a rate on file. Asserted rather than
  // assumed: an unpriced row sorts after all the priced ones by design, so one
  // creeping in here would quietly make the ordering check below vacuous.
  assert.equal(values.includes(null), false, 'nothing in this fixture is unpriced')
  const priced = values.filter((v): v is number => v !== null)
  assert.deepEqual(
    priced,
    [...priced].sort((a, b) => b - a),
  )
  assert.ok(priced[0] > 0, 'CA bought far more fuel than it burned, so it must be the credit')
  assert.equal(fig.items[fig.items.length - 1].label, 'CA')
  // A credit is written in parentheses here because that is how the table under
  // the chart writes it. Two notations for one fact is one of them misread.
  assert.match(fig.items[fig.items.length - 1].display, /^\(\$/)
})

// ------------------------------------------------------------------- the trend

test('a quarter missing either input has no average, and that is not zero', () => {
  // `fleetMpgCentis` answers 0 for a quarter with no gallons. Plotted, that is
  // a column of no height on an axis of real averages — a quarter in which the
  // fleet apparently managed nothing per gallon, rather than one nobody has
  // finished typing.
  const trend = mpgTrend(
    [
      { periodStart: utc(2026, 1, 1), totalMiles: 40_000, totalGallonsMilli: 0 },
      { periodStart: utc(2026, 4, 1), totalMiles: 0, totalGallonsMilli: 6_000_000 },
    ],
    today,
  )
  assert.deepEqual(
    trend.columns.map((c) => c.value),
    [null, null],
  )
  assert.equal(trend.known, 0)
  assert.match(trend.coverage ?? '', /Q1 2026, Q2 2026/)
})

test('no trend is claimed from a quarter somebody is still typing into', () => {
  // Q3 holds all its miles and half its receipts, which prints an average well
  // above anything the trucks did. Announced as an improvement, the chart is
  // telling the owner his fuel economy got better because his bookkeeping got
  // worse.
  const trend = mpgTrend(
    [
      { periodStart: utc(2026, 4, 1), totalMiles: 40_000, totalGallonsMilli: 6_000_000 },
      { periodStart: utc(2026, 7, 1), totalMiles: 40_000, totalGallonsMilli: 3_000_000 },
    ],
    today,
  )
  assert.equal(trend.takeaway, null, 'one closed quarter is not a trend')
  assert.equal(trend.columns[1].open, true)
  // Neutral, not brand: the height is real but the meaning is not settled, and
  // a column the same colour as the finished ones invites the comparison that
  // cannot be made yet.
  assert.equal(trend.columns[1].tone, 'neutral')
  assert.match(trend.coverage ?? '', /Q3 2026 is still being entered/)
})

test('the comparison names the two closed quarters it was actually made from', () => {
  const trend = mpgTrend(
    [
      { periodStart: utc(2026, 1, 1), totalMiles: 40_000, totalGallonsMilli: 5_714_000 },
      { periodStart: utc(2026, 4, 1), totalMiles: 41_000, totalGallonsMilli: 6_300_000 },
      { periodStart: utc(2026, 7, 1), totalMiles: 20_000, totalGallonsMilli: 1_500_000 },
    ],
    today,
  )
  const takeaway = trend.takeaway ?? ''
  assert.match(takeaway, /Q2 2026 came in at 6\.51 mpg/)
  assert.match(takeaway, /0\.49 below Q1 2026/)
  assert.equal(takeaway.includes('Q3 2026'), false, 'the open quarter must not be compared')
  // The reason to watch this number at all: taxable gallons are miles divided
  // by it, so a lower average is more gallons to report on every jurisdiction.
  assert.match(takeaway, /441 more taxable gallons/)
})

test('an average that improved reports fewer gallons, not more', () => {
  const trend = mpgTrend(
    [
      { periodStart: utc(2026, 1, 1), totalMiles: 41_000, totalGallonsMilli: 6_300_000 },
      { periodStart: utc(2026, 4, 1), totalMiles: 41_000, totalGallonsMilli: 5_857_000 },
    ],
    today,
  )
  assert.match(trend.takeaway ?? '', /above Q1 2026/)
  assert.match(trend.takeaway ?? '', /fewer taxable gallons/)
})

test('a hundredth of a mile per gallon is not reported as a trend', () => {
  // Calling arithmetic noise a change teaches the owner to ignore this sentence
  // by the time it means something.
  const trend = mpgTrend(
    [
      { periodStart: utc(2026, 1, 1), totalMiles: 40_000, totalGallonsMilli: 5_714_000 },
      { periodStart: utc(2026, 4, 1), totalMiles: 40_000, totalGallonsMilli: 5_716_000 },
    ],
    today,
  )
  assert.match(trend.takeaway ?? '', /held at/)
})

// ------------------------------------------------------------------- bucketing

test('a quarter nobody recorded anything in stays on the axis', () => {
  // Built from the rows instead, an axis of Q1/Q3 puts a dead Q2 behind the
  // chart and squeezes the gap out of existence — a carrier who sat out a
  // quarter sees three busy ones in a row.
  const totals = quarterTotals(
    [utc(2026, 1, 1), utc(2026, 4, 1), utc(2026, 7, 1)],
    [
      { periodStart: '2026-01-01', miles: 100 },
      { periodStart: '2026-07-01', miles: 300 },
    ],
    [{ purchasedOn: '2026-01-15', gallonsMilli: 10_000 }],
  )
  assert.deepEqual(
    totals.map((t) => t.totalMiles),
    [100, 0, 300],
  )
  // And the quiet quarter has no average, so it draws as an absence rather than
  // as a zero between two real columns.
  assert.equal(mpgTrend(totals, today).columns[1].value, null)
})

test('a receipt on the last day of a quarter is not counted in the next one', () => {
  const totals = quarterTotals(
    [utc(2026, 1, 1), utc(2026, 4, 1)],
    [],
    [
      { purchasedOn: '2026-03-31', gallonsMilli: 1_000 },
      { purchasedOn: '2026-04-01', gallonsMilli: 2_000 },
    ],
  )
  assert.deepEqual(
    totals.map((t) => t.totalGallonsMilli),
    [1_000, 2_000],
  )
})

// ---------------------------------------------------------- when a quarter ends

test('a quarter is not finished the day it ends, it is finished when it is filed', () => {
  // Receipts and trip sheets arrive all through the month after a quarter
  // closes — which is exactly why the return is not due until the last day of
  // that month. Treating 1 October as the moment Q3 became final would call a
  // half-typed quarter finished for thirty days, every quarter, during the one
  // month anybody is looking at it.
  assert.equal(quarterStillOpen(utc(2026, 7, 1), utc(2026, 10, 15)), true)
  assert.equal(quarterStillOpen(utc(2026, 4, 1), today), false)

  const due = returnDueOn(utc(2026, 4, 1))
  assert.equal(quarterStillOpen(utc(2026, 4, 1), due), true, 'open on the day it is due')
  assert.equal(quarterStillOpen(utc(2026, 4, 1), new Date(due.getTime() + 86_400_000)), false)
})

// ------------------------------------------------------------------- takeaways

test('the mileage sentence is about the miles on file, and only fires when there are some', () => {
  const fig = milesFigure({ result: complete(), fuel: [], trucks: null, open: false })
  assert.match(fig.takeaway ?? '', /CA carries 10,000 of the 14,000 miles on file/)
  assert.match(fig.takeaway ?? '', /71%/)

  const empty = milesFigure({ result: ret([], [], []), fuel: [], trucks: null, open: false })
  assert.equal(empty.takeaway, null)
})

test('the net sentence counts both directions rather than naming a single winner', () => {
  const result = ret(
    [
      { jurisdiction: 'CA', miles: 2_000 },
      { jurisdiction: 'NV', miles: 20_000 },
    ],
    [{ jurisdiction: 'CA', gallonsMilli: 4_000_000, taxPaid: true }],
    [
      { jurisdiction: 'CA', rateMills: 979 },
      { jurisdiction: 'NV', rateMills: 380 },
    ],
  )
  const fig = netTaxFigure({ result, trucks: null, open: false })
  assert.match(fig.takeaway ?? '', /1 jurisdiction is billing you and 1 owes you back/)
})
