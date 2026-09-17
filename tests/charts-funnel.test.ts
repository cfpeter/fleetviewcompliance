/**
 * The money funnel on the load board.
 *
 * What these tests are actually defending:
 *
 * 1. NOT A CENT IS LOST. The stage totals must add up to the board total
 *    exactly, in integer cents, or the figure under the bars disagrees with the
 *    bars and the owner cannot reconcile either against a rate confirmation.
 *
 * 2. `status` AND `billing` STAY INDEPENDENT. A delivered load that is not
 *    ready to invoice is the most normal row on this board. Nothing here may
 *    promote it, demote it, or count it twice.
 *
 * 3. AN EMPTY BOARD DOES NOT DIVIDE BY ZERO, and a board with one load on it
 *    does not draw a shape that reads as "everything is fine everywhere".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DELIVERED_STATUSES,
  daysSinceBooked,
  FUNNEL_STAGES,
  funnelHeadline,
  moneyFunnel,
  SLOW_AFTER_DAYS,
  stageOf,
} from '../src/lib/charts/funnel.ts'
import type { RevenueLoad } from '../src/lib/charts/revenue.ts'

/** Mid-morning UTC, which is the same calendar day in Los Angeles. */
const TODAY = new Date('2026-09-16T17:00:00Z')

/** Noon UTC on a day `n` days before TODAY, so no timezone boundary is involved. */
function daysAgo(n: number): string {
  return new Date(Date.UTC(2026, 8, 16 - n, 12, 0, 0)).toISOString()
}

function load(over: Partial<RevenueLoad> = {}): RevenueLoad {
  return {
    status: 'booked',
    billing: 'not_ready',
    linehaul_cents: 100_000,
    created_at: daysAgo(1),
    ...over,
  }
}

/** Every stage's cents, keyed, so an assertion reads like the screen does. */
function cents(funnel: ReturnType<typeof moneyFunnel>): Record<string, number> {
  return Object.fromEntries(funnel.rows.map((r) => [r.key, r.cents]))
}

// --- not a cent lost --------------------------------------------------------

test('the stage totals add up to the board total, to the cent', () => {
  // Deliberately awkward amounts. Three of these summed as dollars through a
  // float and multiplied back give 100 cents on one machine and 99 on another,
  // and one cent off a linehaul is a broker holding payment for a week.
  const funnel = moneyFunnel(
    [
      load({ billing: 'not_ready', status: 'in_transit', linehaul_cents: 33 }),
      load({ billing: 'not_ready', status: 'delivered', linehaul_cents: 33 }),
      load({ billing: 'ready_to_invoice', linehaul_cents: 34 }),
      load({ billing: 'invoiced', linehaul_cents: 1 }),
      load({ billing: 'paid', linehaul_cents: 1 }),
      load({ billing: 'short_paid', linehaul_cents: 1 }),
    ],
    TODAY,
  )
  const summed = funnel.rows.reduce((n, r) => n + r.cents, 0)
  assert.equal(summed, funnel.totalCents)
  assert.equal(funnel.totalCents, 103)
  // Integers all the way down. A float anywhere in the addition shows up here.
  assert.ok(Number.isInteger(funnel.totalCents))
  for (const row of funnel.rows) assert.ok(Number.isInteger(row.cents), `${row.key} is not integer`)
})

test('the three money components are added, not just the linehaul', () => {
  const funnel = moneyFunnel(
    [
      load({
        billing: 'ready_to_invoice',
        linehaul_cents: 185_000,
        fuel_surcharge_cents: 42_050,
        // Negative accessorials are real: a lumper or an advance on the rate
        // confirmation comes off the total, and a funnel that ignored it would
        // never match the cheque.
        accessorials_cents: -15_000,
      }),
    ],
    TODAY,
  )
  assert.equal(stageOf(funnel, 'ready')?.cents, 212_050)
  assert.equal(funnel.totalCents, 212_050)
})

test('every load handed in is accounted for exactly once', () => {
  const rows = [
    load({ billing: 'not_ready', status: 'in_transit' }),
    load({ billing: 'not_ready', status: 'delivered' }),
    load({ billing: 'paid' }),
    load({ status: 'quoted' }),
    load({ exception: 'cancelled' }),
    load({ billing: 'invoiced', linehaul_cents: null }),
  ]
  const funnel = moneyFunnel(rows, TODAY)
  assert.equal(funnel.loads, rows.length)
  assert.equal(
    funnel.countedLoads + funnel.unpricedLoads + funnel.quotedLoads + funnel.cancelledLoads,
    rows.length,
    'a load stopped being counted anywhere',
  )
  const onBars = funnel.rows.reduce((n, r) => n + r.loads + r.unpricedLoads, 0)
  assert.equal(onBars, funnel.countedLoads + funnel.unpricedLoads)
})

// --- status and billing stay independent ------------------------------------

test('a delivered load that is not ready to invoice is its own stage, not paid', () => {
  // The single most normal row on this board, and the one a six-stage funnel
  // would have to lie about.
  const funnel = moneyFunnel([load({ status: 'delivered', billing: 'not_ready' })], TODAY)
  const at = cents(funnel)
  assert.equal(at.paperwork, 100_000)
  assert.equal(at.working, 0)
  assert.equal(at.paid, 0)
  assert.equal(at.ready, 0)
})

test('a load still on the truck sits in the grey stage, not the amber one', () => {
  const funnel = moneyFunnel([load({ status: 'in_transit', billing: 'not_ready' })], TODAY)
  assert.equal(cents(funnel).working, 100_000)
  assert.equal(cents(funnel).paperwork, 0)
  assert.equal(stageOf(funnel, 'working')?.tone, 'neutral')
})

test('billing decides the stage once the freight is off — status never overrides it', () => {
  // Booked-and-already-paid happens (the owner hauled it himself and was paid
  // in cash). Delivered-and-still-not-ready happens far more often. Neither is
  // an error and neither may be moved by the other enum.
  const funnel = moneyFunnel(
    [
      load({ status: 'booked', billing: 'paid', linehaul_cents: 50_000 }),
      load({ status: 'pod_received', billing: 'not_ready', linehaul_cents: 70_000 }),
      load({ status: 'delivered', billing: 'invoiced', linehaul_cents: 90_000 }),
    ],
    TODAY,
  )
  const at = cents(funnel)
  assert.equal(at.paid, 50_000)
  assert.equal(at.paperwork, 70_000, 'POD received is delivered for this purpose')
  assert.equal(at.waiting, 90_000, 'delivered does not stop it being invoiced')
})

test('only the two not-ready stages look at the truck at all', () => {
  const split = FUNNEL_STAGES.filter((s) => s.delivered !== undefined)
  assert.deepEqual(
    split.map((s) => s.key),
    ['working', 'paperwork'],
  )
  for (const stage of split) assert.deepEqual(stage.billing, ['not_ready'])
  // At the consignee is not delivered. Billing a load that is still being
  // unloaded is how an invoice gets re-issued.
  assert.ok(!DELIVERED_STATUSES.includes('at_consignee'))
})

test('a quote is not money and a cancellation is not money', () => {
  const funnel = moneyFunnel(
    [
      load({ status: 'quoted', billing: 'not_ready', linehaul_cents: 500_000 }),
      load({ exception: 'cancelled', billing: 'ready_to_invoice', linehaul_cents: 400_000 }),
      load({ billing: 'ready_to_invoice', linehaul_cents: 100_000 }),
    ],
    TODAY,
  )
  assert.equal(funnel.totalCents, 100_000, 'quoted and cancelled money reached the bars')
  assert.equal(funnel.quotedCents, 500_000, 'the page still needs the number to name it')
  assert.equal(funnel.cancelledCents, 400_000)
})

test('TONU stays on the bars — it is an exception, not a cancellation', () => {
  // Usually the most collectable $150 on the board and the one most often
  // forgotten. Dropping it here would teach an owner to forget it too.
  const funnel = moneyFunnel(
    [load({ exception: 'tonu', billing: 'ready_to_invoice', linehaul_cents: 15_000 })],
    TODAY,
  )
  assert.equal(stageOf(funnel, 'ready')?.cents, 15_000)
})

// --- the empty board --------------------------------------------------------

test('an empty board draws nothing and divides by nothing', () => {
  const funnel = moneyFunnel([], TODAY)
  assert.equal(funnel.totalCents, 0)
  assert.equal(funnel.loads, 0)
  assert.equal(funnel.rows.length, FUNNEL_STAGES.length)
  for (const row of funnel.rows) {
    assert.equal(row.cents, 0)
    // 0, not NaN and not Infinity. `width:NaN%` is a bar the browser drops
    // silently, which is the one failure mode nobody notices.
    assert.equal(row.percent, 0, `${row.key} produced ${row.percent}`)
    assert.ok(Number.isFinite(row.percent as number))
  }
  assert.equal(funnelHeadline(funnel), 'No money on the board yet.')
})

test('a board where nothing is priced says so instead of showing zeros', () => {
  const funnel = moneyFunnel(
    [load({ linehaul_cents: null }), load({ linehaul_cents: null })],
    TODAY,
  )
  assert.equal(funnel.totalCents, 0)
  assert.equal(funnel.unpricedLoads, 2)
  // The stage holding them has NO figure — it must not draw as $0.00 next to
  // five genuinely empty stages that do.
  assert.equal(stageOf(funnel, 'working')?.value, null)
  assert.equal(stageOf(funnel, 'working')?.display, 'no rate')
  assert.equal(stageOf(funnel, 'working')?.percent, null)
  assert.equal(stageOf(funnel, 'paid')?.value, 0, 'a genuinely empty stage is a known zero')
  assert.equal(stageOf(funnel, 'paid')?.display, '$0.00')
  assert.equal(
    funnelHeadline(funnel),
    'No load on the board has a rate yet, so there is no amount to show.',
  )
})

test('an unpriced load in a stage that has money is a note, not a silent gap', () => {
  const funnel = moneyFunnel(
    [
      load({ billing: 'ready_to_invoice', linehaul_cents: 200_000 }),
      load({ billing: 'ready_to_invoice', linehaul_cents: null }),
    ],
    TODAY,
  )
  const ready = stageOf(funnel, 'ready')
  assert.equal(ready?.cents, 200_000)
  assert.equal(ready?.unpricedLoads, 1)
  assert.equal(ready?.note, '1 more load here with no rate.')
})

// --- one load -------------------------------------------------------------

test('a single load fills its own stage and nothing else', () => {
  const funnel = moneyFunnel(
    [load({ billing: 'ready_to_invoice', linehaul_cents: 185_000 })],
    TODAY,
  )
  const full = funnel.rows.filter((r) => r.percent === 100)
  assert.equal(full.length, 1, 'more than one stage drew at full width')
  assert.equal(full[0].key, 'ready')

  // Every other stage is a known, printed zero. This is the whole guard against
  // the misreading: a lone full bar beside five blank rows could be read as
  // "everything is fine", so the five rows each carry $0.00 in words.
  for (const row of funnel.rows) {
    if (row.key === 'ready') continue
    assert.equal(row.percent, 0, `${row.key} borrowed width from the only load`)
    assert.equal(row.display, '$0.00', `${row.key} did not print its zero`)
  }

  // And the bar is never allowed to be the whole message: the exact amount and
  // the load count are both printed, so "100% of your money" always arrives as
  // "$1,850.00 on 1 load".
  assert.equal(full[0].display, '$1,850.00')
  assert.equal(funnel.countedLoads, 1)
  assert.equal(funnelHeadline(funnel), '$1,850.00 on the board. $1,850.00 you can invoice today.')
})

test('a small amount beside a large one is still visible', () => {
  // 15,000 cents against 2,000,000 is 0.75% — sub-pixel on a phone, and
  // indistinguishable from the stage with nothing in it at all.
  const funnel = moneyFunnel(
    [
      load({ billing: 'paid', linehaul_cents: 2_000_000 }),
      load({ billing: 'ready_to_invoice', linehaul_cents: 15_000 }),
    ],
    TODAY,
  )
  const ready = stageOf(funnel, 'ready')
  assert.ok((ready?.percent ?? 0) >= 1.5, `drew at ${ready?.percent}%`)
  assert.equal(ready?.display, '$150.00')
  assert.equal(stageOf(funnel, 'working')?.percent, 0, 'an empty stage stays at zero')
})

// --- ageing -----------------------------------------------------------------

test('days are counted from the day the load was entered, in the carrier day', () => {
  assert.equal(daysSinceBooked(daysAgo(0), TODAY), 0)
  assert.equal(daysSinceBooked(daysAgo(60), TODAY), 60)
  assert.equal(daysSinceBooked(null, TODAY), null)
  assert.equal(daysSinceBooked('not a date', TODAY), null)
})

test('invoiced money that has sat too long is called out in words and in red', () => {
  const funnel = moneyFunnel(
    [
      load({ billing: 'invoiced', linehaul_cents: 300_000, created_at: daysAgo(80) }),
      load({ billing: 'funded', linehaul_cents: 100_000, created_at: daysAgo(2) }),
    ],
    TODAY,
  )
  assert.equal(stageOf(funnel, 'waiting')?.cents, 400_000)
  assert.equal(funnel.slowCents, 300_000)
  assert.equal(funnel.slowLoads, 1)
  assert.equal(funnel.oldestWaitingDays, 80)
  assert.equal(
    stageOf(funnel, 'waiting')?.alarm,
    `$3,000.00 of this is over ${SLOW_AFTER_DAYS} days old. Chase it.`,
  )
})

test('waiting money is never painted green, however new it is', () => {
  // "On track" is money that arrived. Money out with a broker has not arrived,
  // so it does not get the colour that means it did.
  const funnel = moneyFunnel([load({ billing: 'invoiced', created_at: daysAgo(1) })], TODAY)
  assert.equal(stageOf(funnel, 'waiting')?.tone, 'brand')
  assert.equal(stageOf(funnel, 'waiting')?.alarm, undefined)
  assert.equal(stageOf(funnel, 'paid')?.tone, 'good')
})

test('only the waiting stage is aged', () => {
  // An old load sitting at ready-to-invoice is already the loudest thing on the
  // chart; ageing it as well would put two alarms on one fact.
  const funnel = moneyFunnel(
    [load({ billing: 'ready_to_invoice', created_at: daysAgo(400) })],
    TODAY,
  )
  assert.equal(funnel.slowCents, 0)
  assert.equal(funnel.oldestWaitingDays, null)
  for (const row of funnel.rows) assert.equal(row.alarm, undefined)
})

// --- the headline -----------------------------------------------------------

test('the headline leads with the answer, not with the name of the chart', () => {
  const at = (over: Partial<RevenueLoad>) => moneyFunnel([load(over)], TODAY)

  assert.equal(
    funnelHeadline(at({ billing: 'ready_to_invoice' })),
    '$1,000.00 on the board. $1,000.00 you can invoice today.',
  )
  assert.equal(
    funnelHeadline(at({ billing: 'short_paid' })),
    '$1,000.00 on the board. $1,000.00 came back short or disputed.',
  )
  assert.equal(
    funnelHeadline(at({ billing: 'not_ready', status: 'delivered' })),
    '$1,000.00 on the board. $1,000.00 delivered and not invoiced yet.',
  )
  assert.equal(
    funnelHeadline(at({ billing: 'invoiced' })),
    '$1,000.00 on the board. $1,000.00 invoiced and waiting to get paid.',
  )
  assert.equal(
    funnelHeadline(at({ billing: 'not_ready', status: 'in_transit' })),
    '$1,000.00 on the board. All of it is on trucks still working.',
  )
  assert.equal(
    funnelHeadline(at({ billing: 'paid' })),
    '$1,000.00 on the board. All of it is paid.',
  )
})

test('the invoice he never sent outranks the cheque that came back light', () => {
  const funnel = moneyFunnel(
    [
      load({ billing: 'ready_to_invoice', linehaul_cents: 900_000 }),
      load({ billing: 'in_dispute', linehaul_cents: 20_000 }),
    ],
    TODAY,
  )
  // The disputed $200 is red and it is broken — but it ANNOUNCED itself when a
  // light cheque arrived. The $9,000 nobody invoiced announces nothing at all,
  // it is five minutes of work, and it comes back in full.
  assert.equal(funnelHeadline(funnel), '$9,200.00 on the board. $9,000.00 you can invoice today.')
})

test('a missing POD outranks a dispute, and both outrank money merely out', () => {
  const funnel = moneyFunnel(
    [
      load({ billing: 'not_ready', status: 'delivered', linehaul_cents: 310_000 }),
      load({ billing: 'in_dispute', linehaul_cents: 20_000 }),
      load({ billing: 'invoiced', linehaul_cents: 800_000 }),
    ],
    TODAY,
  )
  assert.equal(
    funnelHeadline(funnel),
    '$11,300.00 on the board. $3,100.00 delivered and not invoiced yet.',
  )
})

test('the headline total is the sum of the bars and nothing cleverer', () => {
  const funnel = moneyFunnel(
    [
      load({ billing: 'paid', linehaul_cents: 123_456 }),
      load({ billing: 'invoiced', linehaul_cents: 654_321 }),
    ],
    TODAY,
  )
  const summed = funnel.rows.reduce((n, r) => n + r.cents, 0)
  assert.ok(funnelHeadline(funnel).startsWith('$7,777.77 on the board.'))
  assert.equal(summed, 777_777)
})

// --- a billing value this file has never heard of ---------------------------

test('an unknown billing status gets its own row rather than joining one', () => {
  const funnel = moneyFunnel(
    [
      load({ billing: 'factored_recourse', linehaul_cents: 50_000 }),
      load({ billing: 'paid', linehaul_cents: 50_000 }),
    ],
    TODAY,
  )
  assert.equal(funnel.rows.length, FUNNEL_STAGES.length + 1)
  const other = stageOf(funnel, 'other')
  assert.equal(other?.cents, 50_000)
  assert.equal(other?.tone, 'neutral')
  // Still inside the total, so the bars keep adding up to the number under them.
  assert.equal(funnel.totalCents, 100_000)
  assert.equal(
    funnel.rows.reduce((n, r) => n + r.cents, 0),
    funnel.totalCents,
  )
  // And it is not there when nothing needs it.
  assert.equal(moneyFunnel([load({ billing: 'paid' })], TODAY).rows.length, FUNNEL_STAGES.length)
})

test('null and undefined load lists are the same as an empty board', () => {
  assert.equal(moneyFunnel(null, TODAY).totalCents, 0)
  assert.equal(moneyFunnel(undefined, TODAY).loads, 0)
})
