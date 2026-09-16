/**
 * The quarterly return is money owed to a tax authority that audits, so the
 * arithmetic gets tested harder than its size suggests.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  fleetMpgCentis,
  quarterLabel,
  quarterlyReturn,
  quarterStart,
  returnDueOn,
} from '../src/lib/ifta/compute.ts'

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

// ---------------------------------------------------------------- periods

test('the four filing deadlines are the ones IFTA actually uses', () => {
  // Apr 30 / Jul 31 / Oct 31 / Jan 31 — the last day of the month FOLLOWING
  // the quarter, not the quarter-end itself, and rolled off a weekend.
  assert.equal(iso(returnDueOn(utc(2026, 1, 1))), '2026-04-30') // Thu
  assert.equal(iso(returnDueOn(utc(2026, 4, 1))), '2026-07-31') // Fri
  assert.equal(iso(returnDueOn(utc(2026, 7, 1))), '2026-11-02') // Sat -> Mon
  assert.equal(iso(returnDueOn(utc(2026, 10, 1))), '2027-02-01') // Sun -> Mon
})

test('a date lands in the right quarter', () => {
  assert.equal(iso(quarterStart(utc(2026, 9, 15))), '2026-07-01')
  assert.equal(iso(quarterStart(utc(2026, 1, 1))), '2026-01-01')
  assert.equal(iso(quarterStart(utc(2026, 12, 31))), '2026-10-01')
  assert.equal(quarterLabel(quarterStart(utc(2026, 9, 15))), 'Q3 2026')
})

// ---------------------------------------------------------------- mpg

test('fleet MPG is one figure for the whole fleet', () => {
  // 10,000 miles on 1,562.5 gallons = 6.40 mpg.
  assert.equal(fleetMpgCentis(10_000, 1_562_500), 640)
})

test('no fuel means no MPG, not a division by zero', () => {
  assert.equal(fleetMpgCentis(5000, 0), 0)
})

// ---------------------------------------------------------------- the return

test('you owe tax where you burned fuel, and get credit where you bought it', () => {
  // 1,000 miles in CA, 1,000 in NV. All 320 gallons bought in NV.
  // Fleet MPG = 2000 / 320 = 6.25.
  // CA: burned 1000/6.25 = 160 gal, bought 0 -> owes 160 x $0.979 = $156.64
  // NV: burned 160 gal, bought 320 -> credit 160 x $0.250 = -$40.00
  const r = quarterlyReturn({
    miles: [
      { jurisdiction: 'CA', miles: 1000 },
      { jurisdiction: 'NV', miles: 1000 },
    ],
    fuel: [{ jurisdiction: 'NV', gallonsMilli: 320_000, taxPaid: true }],
    rates: [
      { jurisdiction: 'CA', rateMills: 979 },
      { jurisdiction: 'NV', rateMills: 250 },
    ],
  })

  assert.equal(r.mpgCentis, 625)
  const ca = r.lines.find((l) => l.jurisdiction === 'CA')!
  const nv = r.lines.find((l) => l.jurisdiction === 'NV')!

  assert.equal(ca.taxableGallonsMilli, 160_000)
  assert.equal(ca.outcome.kind === 'computed' && ca.outcome.netCents, 15_664)
  assert.equal(nv.outcome.kind === 'computed' && nv.outcome.netCents, -4_000)
  assert.equal(r.netCents, 11_664)
  assert.equal(r.complete, true)
})

test('a missing rate is NOT zero tax — it makes the return incomplete', () => {
  // The failure this prevents: driving through a state we have no rate for and
  // filing a return that is quietly short. Short filings are what audits find.
  const r = quarterlyReturn({
    miles: [
      { jurisdiction: 'CA', miles: 1000 },
      { jurisdiction: 'AZ', miles: 500 },
    ],
    fuel: [{ jurisdiction: 'CA', gallonsMilli: 240_000, taxPaid: true }],
    rates: [{ jurisdiction: 'CA', rateMills: 979 }],
  })

  assert.deepEqual(r.missingRates, ['AZ'])
  assert.equal(r.complete, false, 'a return with an unpriced jurisdiction is not finished')
  const az = r.lines.find((l) => l.jurisdiction === 'AZ')!
  assert.equal(az.outcome.kind, 'rate_unknown')
  // And it must not have quietly contributed nothing to the total.
  assert.ok(az.taxableGallonsMilli > 0, 'the gallons burned there are still known')
})

test('bulk fuel with no tax paid earns no credit but still counts toward MPG', () => {
  // The classic audit finding: claiming farm-tank gallons as tax-paid.
  const r = quarterlyReturn({
    miles: [{ jurisdiction: 'CA', miles: 1000 }],
    fuel: [
      { jurisdiction: 'CA', gallonsMilli: 100_000, taxPaid: true },
      { jurisdiction: 'CA', gallonsMilli: 60_000, taxPaid: false },
    ],
    rates: [{ jurisdiction: 'CA', rateMills: 979 }],
  })

  // MPG uses all 160 gallons: 1000/160 = 6.25.
  assert.equal(r.mpgCentis, 625)
  const ca = r.lines.find((l) => l.jurisdiction === 'CA')!
  // Credit only for the 100 tax-paid gallons.
  assert.equal(ca.purchasedGallonsMilli, 100_000)
  // Burned 160, credited 100 -> owes 60 gal x $0.979 = $58.74
  assert.equal(ca.outcome.kind === 'computed' && ca.outcome.netCents, 5_874)
})

test('a jurisdiction we bought fuel in but never drove through still appears', () => {
  // It is a credit, and dropping it would silently forfeit money.
  const r = quarterlyReturn({
    miles: [{ jurisdiction: 'CA', miles: 1000 }],
    fuel: [
      { jurisdiction: 'CA', gallonsMilli: 100_000, taxPaid: true },
      { jurisdiction: 'OR', gallonsMilli: 50_000, taxPaid: true },
    ],
    rates: [
      { jurisdiction: 'CA', rateMills: 979 },
      { jurisdiction: 'OR', rateMills: 380 },
    ],
  })
  const or = r.lines.find((l) => l.jurisdiction === 'OR')
  assert.ok(or, 'a fuel-only jurisdiction must still be on the return')
  assert.equal(or.miles, 0)
  assert.ok(or.outcome.kind === 'computed' && or.outcome.netCents < 0, 'it is a credit')
})

test('a quarter with no travel at all still produces a return', () => {
  // A nil return is still a return. Filing is required even with zero tax owed,
  // and the penalty for not filing is $50 or 10% of tax due, whichever is more.
  const r = quarterlyReturn({ miles: [], fuel: [], rates: [] })
  assert.equal(r.netCents, 0)
  assert.equal(r.complete, true)
  assert.deepEqual(r.lines, [])
})

test('the arithmetic never touches a float', () => {
  // 0.1 + 0.2 !== 0.3 in binary floating point, and a quarter is a sum of
  // hundreds of these. Every output must be a whole number of its unit.
  const r = quarterlyReturn({
    miles: [{ jurisdiction: 'CA', miles: 1237 }],
    fuel: [{ jurisdiction: 'CA', gallonsMilli: 193_456, taxPaid: true }],
    rates: [{ jurisdiction: 'CA', rateMills: 979 }],
  })
  assert.ok(Number.isInteger(r.netCents))
  assert.ok(Number.isInteger(r.mpgCentis))
  for (const l of r.lines) {
    assert.ok(Number.isInteger(l.taxableGallonsMilli))
    assert.ok(Number.isInteger(l.purchasedGallonsMilli))
    if (l.outcome.kind === 'computed') assert.ok(Number.isInteger(l.outcome.netCents))
  }
})

// ---------------------------------------------------------------- blockers

test('fuel with no miles is INCOMPLETE, not a refund', () => {
  // The most dangerous bug this feature had, and the normal order of a real
  // quarter: receipts arrive continuously, miles come off trip sheets at the
  // end. With fuel and no miles every jurisdiction became a pure credit and the
  // page announced a refund, in green, as fact.
  const r = quarterlyReturn({
    miles: [],
    fuel: [{ jurisdiction: 'CA', gallonsMilli: 2_420_000, taxPaid: true }],
    rates: [{ jurisdiction: 'CA', rateMills: 979 }],
  })
  assert.equal(r.complete, false, 'a return claiming money back on no miles is not finished')
  assert.ok(r.blockers.some((b) => /no miles/i.test(b)))
})

test('miles with no fuel is INCOMPLETE too', () => {
  const r = quarterlyReturn({
    miles: [{ jurisdiction: 'CA', miles: 5000 }],
    fuel: [],
    rates: [{ jurisdiction: 'CA', rateMills: 979 }],
  })
  assert.equal(r.complete, false)
  assert.ok(r.blockers.some((b) => /no fuel/i.test(b)))
})

test('an MPG that rounds to zero blocks the return', () => {
  // Both inputs present, so neither single-sided check fires — and every
  // taxable-gallon figure multiplies out to nothing. 10 miles on 2,001 gallons
  // used to report complete, with $1,958.98 claimed back.
  const r = quarterlyReturn({
    miles: [{ jurisdiction: 'CA', miles: 10 }],
    fuel: [{ jurisdiction: 'CA', gallonsMilli: 2_001_000, taxPaid: true }],
    rates: [{ jurisdiction: 'CA', rateMills: 979 }],
  })
  assert.equal(r.mpgCentis, 0)
  assert.equal(r.complete, false, 'a return with no derivable MPG is not one that owes nothing')
  assert.ok(r.blockers.some((b) => /rounds to zero/i.test(b)))
})

test('a genuinely nil quarter is still complete', () => {
  // Nothing recorded at all is a nil return, which is a real thing that must be
  // filed. Only a HALF-entered quarter is blocked.
  const r = quarterlyReturn({ miles: [], fuel: [], rates: [] })
  assert.equal(r.complete, true)
  assert.deepEqual(r.blockers, [])
})

test('a missing rate is named in the blockers', () => {
  const r = quarterlyReturn({
    miles: [
      { jurisdiction: 'CA', miles: 1000 },
      { jurisdiction: 'AZ', miles: 500 },
    ],
    fuel: [{ jurisdiction: 'CA', gallonsMilli: 240_000, taxPaid: true }],
    rates: [{ jurisdiction: 'CA', rateMills: 979 }],
  })
  assert.equal(r.complete, false)
  assert.ok(r.blockers.some((b) => b.includes('AZ')))
})

// ---------------------------------------------------------------- weekends

test('a deadline falling on a weekend rolls to Monday', () => {
  // Two of the next four fall on a weekend, and without this the page called a
  // return overdue on a day it was not late.
  // Q3 2026 nominally ends 31 Oct 2026, a Saturday.
  assert.equal(iso(returnDueOn(utc(2026, 7, 1))), '2026-11-02')
  // Q4 2026 nominally ends 31 Jan 2027, a Sunday.
  assert.equal(iso(returnDueOn(utc(2026, 10, 1))), '2027-02-01')
})

test('a weekday deadline is left alone', () => {
  // Q1 2026 ends 30 Apr 2026, a Thursday.
  assert.equal(iso(returnDueOn(utc(2026, 1, 1))), '2026-04-30')
  // Q2 2026 ends 31 Jul 2026, a Friday.
  assert.equal(iso(returnDueOn(utc(2026, 4, 1))), '2026-07-31')
})

test('the rolled date is never EARLIER than the nominal one', () => {
  // Rolling forward is safe; rolling backward would make us call a return late
  // before it was.
  for (let y = 2026; y <= 2032; y++) {
    for (const m of [1, 4, 7, 10]) {
      const start = utc(y, m, 1)
      const nominal = new Date(Date.UTC(y, m + 3, 0))
      assert.ok(returnDueOn(start) >= nominal, `${y}-${m} rolled backward`)
    }
  }
})
