/**
 * The revenue derivations, and the six ways a money chart lies.
 *
 * A wrong number in the loads table is a wrong number. A wrong revenue chart is
 * a wrong CONCLUSION about whether this was a good quarter, reached in about a
 * second, acted on by somebody deciding whether he can afford a second truck.
 * Every test below pins one specific way that happens:
 *
 *   1. a load nobody has priced summed as a $0 load, so an unfinished record
 *      reads as a bad month
 *   2. a quote or a cancelled load counted as money, so income nobody has
 *      agreed to pay appears in the total
 *   3. `billing` derived from `status`, which is the documented cause of "the
 *      reports don't match" across this whole product category
 *   4. a load booked in the evening bucketed into the next month, so the chart
 *      disagrees with the date printed beside the same load underneath it
 *   5. a concentration share computed over less than the whole while being
 *      presented as the whole
 *   6. a row that silently stops being counted anywhere, which nobody notices
 *      because the chart still looks fine
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BILLING_GROUPS,
  billingMix,
  bookedDay,
  type CustomerForRevenue,
  classifyLoad,
  type RevenueLoad,
  revenueByMonth,
  sliceOf,
  summarise,
  topCustomers,
} from '../src/lib/charts/revenue.ts'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

/** Today for every windowed test. A Tuesday, matching tests/charts.test.ts. */
const today = utc(2026, 9, 15)

/** A committed, priced load. Overridden field by field in each test. */
function load(over: Partial<RevenueLoad> = {}): RevenueLoad {
  return {
    status: 'delivered',
    exception: null,
    billing: 'invoiced',
    linehaul_cents: 1_000_00,
    fuel_surcharge_cents: null,
    accessorials_cents: null,
    created_at: '2026-09-10T18:00:00.000Z',
    customer_id: null,
    ...over,
  }
}

// ------------------------------------------------------------ what counts

test('a load nobody has priced is not a load worth zero', () => {
  // THE trap on this side of the app. All three money columns are nullable and
  // a load booked off a phone at a truck stop routinely carries a reference
  // number and nothing else. Summed as zero it drags the month's column down
  // and reads as a bad month. It is not a bad month; it is an unfinished
  // record, and the two go to different people.
  const bare = load({ linehaul_cents: null, fuel_surcharge_cents: null, accessorials_cents: null })
  assert.deepEqual(classifyLoad(bare), { kind: 'unpriced' })

  const month = revenueByMonth([bare], today, { months: 3 })
  const september = month.columns[month.columns.length - 1]
  assert.equal(september.value, null, 'an unpriced month must have no figure at all')
  assert.equal(september.unpricedLoads, 1)
  assert.equal(month.window.unpricedLoads, 1)
  assert.equal(month.window.totalCents, 0)
})

test('a null fuel surcharge inside a priced load really does add nothing', () => {
  // The other half of the same rule. A load that pays a linehaul and no fuel
  // surcharge is fully priced — refusing to count it would be the mirror-image
  // lie, hiding real money because one optional column is blank.
  assert.deepEqual(classifyLoad(load({ linehaul_cents: 1_850_00 })), {
    kind: 'counted',
    cents: 185000,
  })
  assert.deepEqual(
    classifyLoad(load({ linehaul_cents: 1_850_00, accessorials_cents: -150_00 })),
    { kind: 'counted', cents: 170000 },
    'a deduction on the rate confirmation is part of what the load pays',
  )
})

test('a quote is not money and a cancelled load is not money', () => {
  // Both would book income nobody has agreed to pay, on the screen the owner
  // uses to decide whether he can make payroll.
  assert.deepEqual(classifyLoad(load({ status: 'quoted' })), { kind: 'quoted' })
  assert.deepEqual(classifyLoad(load({ exception: 'cancelled' })), { kind: 'cancelled' })

  const sum = summarise([load(), load({ status: 'quoted' }), load({ exception: 'cancelled' })])
  assert.equal(sum.totalCents, 100000, 'only the committed, priced load is money')
  assert.equal(sum.quotedLoads, 1)
  assert.equal(sum.cancelledLoads, 1)
})

test('a TONU stays in, because it is the most collectable money on the board', () => {
  // Truck ordered, not used is an EXCEPTION, not a cancellation. It is usually
  // still billable and it is already the line item small carriers most often
  // forget; dropping it from revenue would teach them to forget it here too.
  assert.deepEqual(classifyLoad(load({ exception: 'tonu', linehaul_cents: 150_00 })), {
    kind: 'counted',
    cents: 15000,
  })
})

test('a load that is both quoted and cancelled is excluded exactly once', () => {
  // Counted in two buckets it would be named twice in the coverage sentence,
  // and the totals printed beside the chart would not add up to the board.
  const sum = summarise([load({ status: 'quoted', exception: 'cancelled' })])
  assert.equal(sum.loads, 1)
  assert.equal(sum.cancelledLoads, 1)
  assert.equal(sum.quotedLoads, 0)
})

test('money written off is still drawn, and still declared', () => {
  // It was really hauled and really billed, so removing it would understate
  // what the business did. But the total then overstates what will actually be
  // collected, and that deserves a sentence rather than a silent subtraction.
  const sum = summarise([load({ billing: 'written_off', linehaul_cents: 600_00 }), load()])
  assert.equal(sum.totalCents, 160000)
  assert.equal(sum.writtenOffCents, 60000)
  assert.equal(sum.writtenOffLoads, 1)
})

test('cents stay integers however many loads are added up', () => {
  // Money is int4 cents in 0009_loads.sql and no float is allowed to exist on
  // the way to the screen. One cent of drift is an invoice that does not match
  // the rate confirmation, which is a broker holding payment for a week.
  const odd = [1_234_55, 99_99, 7, 45_67, 1_00].map((c) => load({ linehaul_cents: c }))
  const sum = summarise(odd)
  assert.equal(sum.totalCents, 123455 + 9999 + 7 + 4567 + 100)
  assert.ok(Number.isInteger(sum.totalCents))
})

// ------------------------------------------------------------------- months

test('an evening booking stays in the month the table prints beside it', () => {
  // 2026-10-01T00:30Z is 5:30pm on 30 September in Fontana. formatStamp()
  // prints that row "Sep 30". Bucketed in raw UTC the same load lands in
  // October, and the owner gets a chart whose month totals cannot be
  // reconciled with the rows directly underneath it — which is the "reports
  // don't match" complaint arriving by a different road.
  assert.equal(
    bookedDay('2026-10-01T00:30:00.000Z')?.toISOString().slice(0, 10),
    '2026-09-30',
    'the carrier is in America/Los_Angeles, not in UTC',
  )

  const month = revenueByMonth([load({ created_at: '2026-10-01T00:30:00.000Z' })], today, {
    months: 2,
  })
  assert.equal(month.columns[1].key, '2026-09')
  assert.equal(month.columns[1].value, 100000)
  assert.equal(month.columns[0].value, null)
})

test('the axis is twelve consecutive months, not the months that had loads', () => {
  // Built from the data alone, an axis of Jan/Apr/Sep deletes the quiet months
  // and shows a carrier who ran three good months out of twelve a picture of
  // three good months out of three.
  const month = revenueByMonth([load({ created_at: '2026-09-10T18:00:00.000Z' })], today)
  assert.equal(month.columns.length, 12)
  assert.deepEqual(
    month.columns.map((c) => c.key),
    [
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ],
  )
  assert.equal(
    month.columns.filter((c) => c.value !== null).length,
    1,
    'eleven months with nothing entered must stay eleven empty slots',
  )
})

test('a month with loads and no rates does not read like a month with no loads', () => {
  // Both draw as an empty slot, so the only thing separating them is the word
  // printed above it. "—" says the truck never moved; "no rate" says four
  // loads are sitting there waiting for somebody to type the number.
  const month = revenueByMonth(
    [
      load({ created_at: '2026-08-10T18:00:00.000Z', linehaul_cents: null }),
      load({ created_at: '2026-08-12T18:00:00.000Z', linehaul_cents: null }),
    ],
    today,
    { months: 2 },
  )
  const [august, september] = month.columns
  assert.equal(august.value, null)
  assert.equal(august.display, 'no rate')
  assert.equal(september.display, '—')
})

test('a load genuinely written for nothing draws a zero, not an absence', () => {
  // The inverse of the first test and just as important. Somebody typed 0, so
  // we have a figure and the figure is zero — a claim we can evidence. Drawn
  // as an empty slot it would read as "nobody entered anything", which is the
  // opposite of what happened.
  const month = revenueByMonth([load({ linehaul_cents: 0 })], today, { months: 1 })
  assert.equal(month.columns[0].value, 0)
  assert.equal(month.columns[0].display, '$0')
  assert.equal(month.columns[0].countedLoads, 1)
})

test('the month still running is flagged, so a short column is not read as a collapse', () => {
  // On the 15th the last column holds half a month. Eleven full months and a
  // half one reads as revenue falling off a cliff, which is a conclusion about
  // the business drawn from the calendar.
  const month = revenueByMonth([], today, { months: 4 })
  assert.deepEqual(
    month.columns.map((c) => c.isCurrent),
    [false, false, false, true],
  )
})

test('an older load is left off the axis, not folded into the first column', () => {
  // Folded in, a carrier's entire first year would pile onto October 2025 and
  // draw a spike that never happened.
  const month = revenueByMonth([load({ created_at: '2019-04-02T18:00:00.000Z' })], today)
  assert.equal(month.columns[0].value, null)
  assert.equal(month.outside.countedLoads, 1)
  assert.equal(month.outside.totalCents, 100000)
  assert.equal(month.window.loads, 0)
})

test('an unreadable booking date is counted, never dropped', () => {
  // A load quietly missing from a revenue chart is the one failure mode nobody
  // notices, because the chart still looks perfectly fine without it.
  const month = revenueByMonth(
    [load({ created_at: 'not a date' }), load({ created_at: null })],
    today,
  )
  assert.equal(month.undated, 2)
  assert.equal(month.window.loads, 0)
})

test('every load lands in exactly one place', () => {
  // The invariant the runway tests also assert, and for the same reason: the
  // dangerous bug in a chart derivation is not a wrong number, it is a row that
  // stops being counted anywhere at all.
  const rows = [
    load(),
    load({ status: 'quoted' }),
    load({ exception: 'cancelled' }),
    load({ linehaul_cents: null }),
    load({ created_at: '2019-04-02T18:00:00.000Z' }),
    load({ created_at: '' }),
  ]
  const month = revenueByMonth(rows, today)
  assert.equal(month.window.loads + month.outside.loads + month.undated, rows.length)
  const w = month.window
  assert.equal(w.countedLoads + w.unpricedLoads + w.quotedLoads + w.cancelledLoads, w.loads)
})

// -------------------------------------------------------------- billing mix

test('billing is never derived from status', () => {
  // 0009_loads.sql keeps them as two independent enums because a load can be
  // delivered and unbilled, and that is the most normal row in a small
  // carrier's week. Deriving one from the other makes it an error state.
  const mix = billingMix([
    load({ status: 'delivered', billing: 'not_ready' }),
    load({ status: 'booked', billing: 'paid' }),
  ])
  assert.equal(sliceOf(mix, 'not_ready')?.count, 1, 'delivered-and-unbilled is a real row')
  assert.equal(sliceOf(mix, 'settled')?.count, 1, 'booked-and-already-paid is also a real row')
})

test('the slices always add up to the whole the bar is drawn against', () => {
  // Proportion takes `total` separately from the segments. If the two disagree
  // the bar silently fails to fill, and a half-empty bar reads as a finding.
  const mix = billingMix([
    load({ billing: 'not_ready' }),
    load({ billing: 'ready_to_invoice' }),
    load({ billing: 'funded' }),
    load({ billing: 'short_paid' }),
    load({ billing: 'closed' }),
  ])
  assert.equal(
    mix.slices.reduce((n, s) => n + s.count, 0),
    mix.total,
  )
  assert.equal(mix.total, 5)
})

test('a billing state no group claims gets its own slice rather than a neighbour', () => {
  // A later migration adding a value to the enum must not quietly file loads
  // under a label that is a statement about them nobody checked.
  const mix = billingMix([load({ billing: 'factored_recourse' }), load({ billing: 'paid' })])
  const other = sliceOf(mix, 'other')
  assert.equal(other?.count, 1)
  assert.equal(mix.total, 2)
  assert.equal(
    billingMix([load({ billing: 'paid' })]).slices.length,
    BILLING_GROUPS.length,
    'the extra slice appears only when something is actually in it',
  )
})

test('the mix and the revenue chart cover the same loads', () => {
  // Two charts on one page drawn from two different populations is how a page
  // starts disagreeing with itself in front of the owner.
  const rows = [load(), load({ status: 'quoted' }), load({ exception: 'cancelled' })]
  const mix = billingMix(rows)
  const month = revenueByMonth(rows, today)
  assert.equal(mix.total, month.window.countedLoads + month.window.unpricedLoads)
  assert.equal(mix.quotedLoads, month.window.quotedLoads)
  assert.equal(mix.cancelledLoads, month.window.cancelledLoads)
})

test('a slice counts loads while its cents count only the priced ones', () => {
  // The width of a segment is loads; the money sentence beside it is cents.
  // Conflating them would have the bar say one thing and the number say
  // another — and `unpricedLoads` is what lets the page admit the gap.
  const mix = billingMix([
    load({ billing: 'invoiced', linehaul_cents: 2_000_00 }),
    load({ billing: 'invoiced', linehaul_cents: null }),
  ])
  const awaiting = sliceOf(mix, 'awaiting')
  assert.equal(awaiting?.count, 2)
  assert.equal(awaiting?.countedLoads, 1)
  assert.equal(awaiting?.cents, 200000)
  assert.equal(mix.unpricedLoads, 1)
})

// ------------------------------------------------------------ concentration

const customers: CustomerForRevenue[] = [
  { id: 'a', name: 'Golden State Foods', days_to_pay: 45 },
  { id: 'b', name: 'Inland Produce', days_to_pay: null },
  { id: 'c', name: 'Ruiz Distributing', days_to_pay: 0 },
]

test('one broker being most of the year is visible', () => {
  // The entire reason this ranking exists. An alphabetical book of forty
  // brokers hides it, and a carrier who does not know he is one lost contract
  // from closing cannot price that risk.
  const ranking = topCustomers(
    [
      load({ customer_id: 'a', linehaul_cents: 70_000_00 }),
      load({ customer_id: 'b', linehaul_cents: 20_000_00 }),
      load({ customer_id: 'c', linehaul_cents: 10_000_00 }),
    ],
    customers,
  )
  assert.equal(ranking.rows[0].name, 'Golden State Foods')
  assert.equal(ranking.topShare, 70)
  assert.equal(ranking.attributedCents, 10000000)
})

test('the share is computed over attributed revenue only, and says so', () => {
  // Loads with nobody on them cannot belong to anyone, so they are out of the
  // denominator — which means the share is over less than the whole. Reported
  // as a bare percentage it overstates concentration, and the page needs these
  // two numbers to be able to admit it.
  const ranking = topCustomers(
    [
      load({ customer_id: 'a', linehaul_cents: 60_000_00 }),
      load({ customer_id: null, linehaul_cents: 40_000_00 }),
    ],
    customers,
  )
  assert.equal(ranking.topShare, 100, 'of what we could attribute, one broker is all of it')
  assert.equal(ranking.unattributedCents, 4000000)
  assert.equal(ranking.unattributedLoads, 1)
})

test('a customer we have simply not finished entering is not a customer worth nothing', () => {
  // Summed to zero they would rank below a broker we genuinely earn nothing
  // from, and draw as a full-width zero bar. `null` makes Bars draw the empty
  // slot it actually is.
  const ranking = topCustomers(
    [
      load({ customer_id: 'a', linehaul_cents: 1_00 }),
      load({ customer_id: 'b', linehaul_cents: null }),
      load({ customer_id: 'b', linehaul_cents: null }),
    ],
    customers,
  )
  assert.deepEqual(
    ranking.rows.map((r) => [r.name, r.cents]),
    [
      ['Golden State Foods', 100],
      ['Inland Produce', null],
    ],
  )
  assert.equal(ranking.rows[1].unpricedLoads, 2)
  assert.equal(ranking.unpricedLoads, 2)
})

test('terms nobody has told us stay unknown, and pay-on-delivery stays zero', () => {
  // `days_to_pay` NULL means they never told us; 0 means they pay on delivery,
  // which is the best terms in the industry. Collapsed together, the broker who
  // has never answered the question sorts alongside the best payer on the book.
  const ranking = topCustomers([load({ customer_id: 'b' }), load({ customer_id: 'c' })], customers)
  const byName = new Map(ranking.rows.map((r) => [r.name, r.daysToPay]))
  assert.equal(byName.get('Inland Produce'), null)
  assert.equal(byName.get('Ruiz Distributing'), 0)
})

test('nothing to divide by produces no share at all', () => {
  // A percentage invented from an empty book would print "100% from one
  // customer" on the screen of a carrier who has hauled nothing yet.
  assert.equal(topCustomers([], customers).topShare, null)
  assert.equal(
    topCustomers([load({ customer_id: 'b', linehaul_cents: null })], customers).topShare,
    null,
  )
})

test('quotes and cancellations are out of the ranking too, and are counted', () => {
  const ranking = topCustomers(
    [
      load({ customer_id: 'a' }),
      load({ customer_id: 'a', status: 'quoted', linehaul_cents: 9_999_00 }),
      load({ customer_id: 'a', exception: 'cancelled', linehaul_cents: 9_999_00 }),
    ],
    customers,
  )
  assert.equal(ranking.attributedCents, 100000)
  assert.equal(ranking.quotedLoads, 1)
  assert.equal(ranking.cancelledLoads, 1)
  assert.equal(ranking.rows[0].countedLoads, 1)
})

test('a load pointing at a customer we were not given is unattributed, not dropped', () => {
  // Otherwise the bars add up to less than the total printed above them, with
  // nothing on screen saying why.
  const ranking = topCustomers([load({ customer_id: 'gone', linehaul_cents: 500_00 })], customers)
  assert.equal(ranking.rows.length, 0)
  assert.equal(ranking.unattributedLoads, 1)
  assert.equal(ranking.unattributedCents, 50000)
})

test('the order does not shuffle between two identical renders', () => {
  // Bars are read by position. A broker who was third becoming fourth on a
  // refresh that changed nothing teaches the owner the ranking is decorative.
  const rows = [
    load({ customer_id: 'a', linehaul_cents: 5_000_00 }),
    load({ customer_id: 'b', linehaul_cents: 5_000_00 }),
    load({ customer_id: 'c', linehaul_cents: 5_000_00 }),
  ]
  const once = topCustomers(rows, customers).rows.map((r) => r.name)
  const twice = topCustomers([...rows].reverse(), customers).rows.map((r) => r.name)
  assert.deepEqual(once, twice)
  assert.deepEqual(once, ['Golden State Foods', 'Inland Produce', 'Ruiz Distributing'])
})
