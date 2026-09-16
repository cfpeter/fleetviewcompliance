/**
 * The pay charts, and the specific ways each one could lie about money.
 *
 * A wrong number on a settlement is a dispute with one driver about one week. A
 * wrong pay CHART is a conclusion about the whole year, reached in a second, and
 * acted on — "he's already had twelve thousand out of me" is said out loud in a
 * yard long before anybody opens the statement that would disprove it. Every
 * test below pins one way that happens:
 *
 *   1. a revision counted alongside the statement it replaces, so a driver
 *      appears to have been paid twice for one week (the one that matters most)
 *   2. a draft's moving total added to a frozen paid one inside the same column
 *   3. a month nobody was paid in drawn as a zero, or dropped off the axis
 *   4. a driver with nothing recorded drawn as a driver who earned nothing
 *   5. money quietly falling out of the derivation with nothing on screen to
 *      suggest it was ever there
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  driverYearToDate,
  monthsEnding,
  netForDisplay,
  type PaySettlement,
  paidCoverage,
  paidSettlements,
  payByMonth,
} from '../src/lib/charts/pay.ts'

/** A settlement with sensible defaults, so each test states only what it is about. */
function settlement(over: Partial<PaySettlement> & { id: string }): PaySettlement {
  return {
    driverId: 'driver-a',
    periodStart: '2026-03-02',
    periodEnd: '2026-03-08',
    status: 'paid',
    revision: 1,
    supersededAt: null,
    netCents: 1_800_00,
    paidOn: '2026-03-12',
    ...over,
  }
}

/** Every row handed in has to come back out somewhere. Nothing may vanish. */
function accountsForEverything(rows: readonly PaySettlement[]) {
  const set = paidSettlements(rows)
  assert.equal(
    set.rows.length + set.replaced + set.open + set.voided + set.missingNet + set.unplaceable,
    rows.length,
    'a settlement fell out of the derivation with nothing to show for it',
  )
  return set
}

// ------------------------------------------------------- the double count

test('a revision is never counted alongside the statement it replaces', () => {
  // THE test. Revision 1 was paid at $1,800 and corrected to $1,900 on revision
  // 2; both rows are `paid` and both are real. Summed naively the driver has
  // been paid $3,700 for one week, which is the single most damaging number
  // this chart could put on a screen.
  const set = accountsForEverything([
    settlement({
      id: 'rev1',
      revision: 1,
      netCents: 1_800_00,
      supersededAt: '2026-03-20T10:00:00Z',
    }),
    settlement({ id: 'rev2', revision: 2, netCents: 1_900_00 }),
  ])
  assert.equal(set.rows.length, 1)
  assert.equal(set.rows[0].id, 'rev2')
  assert.equal(set.rows[0].cents, 1_900_00)
  assert.equal(set.replaced, 1)
})

test('a revision whose supersede stamp never landed still does not double-count', () => {
  // The revise flow writes the revision, copies its lines, and stamps
  // `superseded_at` on the old row LAST — so a failure at that step leaves two
  // live paid rows for one period with nothing marked on either. A chart that
  // filtered on `superseded_at` would count both and never look broken.
  const set = accountsForEverything([
    settlement({ id: 'rev1', revision: 1, netCents: 1_800_00, supersededAt: null }),
    settlement({ id: 'rev2', revision: 2, netCents: 1_900_00, supersededAt: null }),
  ])
  assert.equal(set.rows.length, 1)
  assert.equal(set.rows[0].cents, 1_900_00)
})

test('rows arriving oldest-last still resolve to the highest revision', () => {
  // PostgREST orders by period and revision, and a future edit to that ORDER BY
  // must not be able to change which figure a driver is shown.
  const set = paidSettlements([
    settlement({ id: 'rev3', revision: 3, netCents: 2_000_00 }),
    settlement({ id: 'rev1', revision: 1, netCents: 1_800_00 }),
    settlement({ id: 'rev2', revision: 2, netCents: 1_900_00 }),
  ])
  assert.equal(set.rows.length, 1)
  assert.equal(set.rows[0].cents, 2_000_00)
})

test('a paid statement still counts while its correction sits in draft', () => {
  // Revising a paid settlement creates the revision as a DRAFT and supersedes
  // the paid row immediately. Dropping the superseded row would take a week's
  // pay off the driver's year for as long as the office takes to finish the
  // correction — and the money did move.
  const set = accountsForEverything([
    settlement({
      id: 'rev1',
      revision: 1,
      netCents: 1_800_00,
      supersededAt: '2026-03-20T10:00:00Z',
    }),
    settlement({ id: 'rev2', revision: 2, status: 'draft', netCents: null, paidOn: null }),
  ])
  assert.equal(set.rows.length, 1)
  assert.equal(set.rows[0].cents, 1_800_00)
  assert.equal(set.beingRevised, 1)
  assert.match(paidCoverage(set) ?? '', /being revised/)
})

test('two drivers settled for the same week are two settlements, not one', () => {
  // The chain key is (driver, period). Drop the driver from it and the fleet's
  // second driver disappears into the first one's bar — every week.
  const set = paidSettlements([
    settlement({ id: 'a', driverId: 'driver-a', netCents: 1_800_00 }),
    settlement({ id: 'b', driverId: 'driver-b', netCents: 1_400_00 }),
  ])
  assert.equal(set.rows.length, 2)
})

// ------------------------------------------------------ frozen vs provisional

test('a draft is never drawn, and the chart says it is missing', () => {
  // A draft has no frozen total by design — it is re-derived from its lines on
  // every load. Adding a moving total to a frozen one inside one column makes a
  // figure nobody can reconcile against the cheque afterwards.
  const set = accountsForEverything([
    settlement({ id: 'open-1', status: 'draft', netCents: null, paidOn: null }),
    settlement({
      id: 'open-2',
      status: 'approved',
      netCents: null,
      paidOn: null,
      periodEnd: '2026-03-15',
      periodStart: '2026-03-09',
    }),
  ])
  assert.equal(set.rows.length, 0)
  assert.equal(set.open, 2)
  assert.match(paidCoverage(set) ?? '', /2 open settlements are not counted/)
})

test('a voided settlement is never money paid', () => {
  // Void is a cancelled statement kept on purpose. Counting it pays a driver
  // for a week the carrier explicitly called off.
  const set = accountsForEverything([settlement({ id: 'v', status: 'void', netCents: 900_00 })])
  assert.equal(set.rows.length, 0)
  assert.equal(set.voided, 1)
  // Deliberately NOT in the coverage line: a void is a non-event, and spending
  // the one sentence the owner reads on it buries the drafts that do matter.
  assert.equal(paidCoverage(set), undefined)
})

test('a paid settlement with no stored total is reported, never re-derived', () => {
  // Impossible through the app (a CHECK constraint forbids it), so if it turns
  // up somebody has been in the database by hand. Guessing the total from the
  // lines would hide the one case worth seeing.
  const set = accountsForEverything([settlement({ id: 'x', netCents: null })])
  assert.equal(set.rows.length, 0)
  assert.equal(set.missingNet, 1)
  assert.match(paidCoverage(set) ?? '', /no stored total/)
})

test('a settlement paid with no payment date is placed by its period, not dropped', () => {
  // `paid_on` is nullable even on a locked row. Dropping those would silently
  // take whole weeks out of a driver's year; placing them by the period they
  // cover mixes two bases, so the count is reported and the caption admits it.
  const set = paidSettlements([settlement({ id: 'p', paidOn: null })])
  assert.equal(set.rows.length, 1)
  assert.equal(set.rows[0].on.toISOString().slice(0, 10), '2026-03-08')
  assert.equal(set.placedByPeriod, 1)
  assert.match(paidCoverage(set) ?? '', /no payment date/)
})

test('a settlement with no readable date at all is counted, not quietly discarded', () => {
  const set = accountsForEverything([
    settlement({ id: 'junk', paidOn: null, periodEnd: 'not-a-date' }),
  ])
  assert.equal(set.rows.length, 0)
  assert.equal(set.unplaceable, 1)
})

test('a payment date is read as a calendar day, never as local time', () => {
  // `new Date('2026-01-01')` in Los Angeles is the previous afternoon, which
  // moves a settlement into the previous month — and, on New Year, out of the
  // year-to-date figure entirely.
  const set = paidSettlements([settlement({ id: 'ny', paidOn: '2026-01-01' })])
  assert.equal(set.rows[0].on.toISOString(), '2026-01-01T00:00:00.000Z')
})

// -------------------------------------------------------------- year to date

test('a driver with nothing paid this year is unknown, not zero', () => {
  // Zero claims he earned nothing. Null says no paid settlement exists for him,
  // which on a fleet that started using this screen last week is everybody.
  const ytd = driverYearToDate(paidSettlements([]).rows, ['driver-a'], '2026-09-15')
  assert.deepEqual(ytd, [{ driverId: 'driver-a', cents: null, settlements: 0 }])
})

test('year to date stops at the year boundary in both directions', () => {
  const paid = paidSettlements([
    settlement({ id: 'last-year', paidOn: '2025-12-31', netCents: 5_000_00 }),
    settlement({
      id: 'this-year',
      paidOn: '2026-01-02',
      netCents: 1_200_00,
      periodStart: '2025-12-28',
      periodEnd: '2026-01-03',
    }),
  ]).rows
  const ytd = driverYearToDate(paid, ['driver-a'], '2026-09-15')
  assert.equal(ytd.length, 1)
  assert.equal(ytd[0].cents, 1_200_00)
  assert.equal(ytd[0].settlements, 1)
})

test('the ranking is by money paid, with the drivers who have none at the bottom', () => {
  const paid = paidSettlements([
    settlement({ id: 'a1', driverId: 'driver-a', netCents: 1_800_00 }),
    settlement({
      id: 'a2',
      driverId: 'driver-a',
      netCents: 1_700_00,
      periodStart: '2026-03-09',
      periodEnd: '2026-03-15',
      paidOn: '2026-03-19',
    }),
    settlement({ id: 'b1', driverId: 'driver-b', netCents: 2_400_00 }),
  ]).rows
  const ytd = driverYearToDate(paid, ['driver-a', 'driver-b', 'driver-c'], '2026-09-15')
  assert.deepEqual(
    ytd.map((d) => [d.driverId, d.cents, d.settlements]),
    [
      ['driver-a', 3_500_00, 2],
      ['driver-b', 2_400_00, 1],
      ['driver-c', null, 0],
    ],
  )
})

test('a driver paid this year but since off the roster is still shown', () => {
  // He was terminated in June. The money still left the account in April, and a
  // year-to-date total that quietly loses it does not add up to the bank.
  const paid = paidSettlements([settlement({ id: 'gone', driverId: 'driver-z' })]).rows
  const ytd = driverYearToDate(paid, ['driver-a'], '2026-09-15')
  assert.deepEqual(
    ytd.map((d) => d.driverId),
    ['driver-z', 'driver-a'],
  )
})

// ------------------------------------------------------------------- by month

test('a month with no paid settlement is an absence, not a zero', () => {
  // We can evidence "no paid settlement lands in April". We cannot evidence
  // "nobody was paid in April" — a carrier who paid in cash and never marked
  // the statements looks identical from here.
  const paid = paidSettlements([settlement({ id: 'm', paidOn: '2026-03-12' })]).rows
  const { values } = payByMonth(
    paid,
    new Date(Date.UTC(2026, 1, 1)),
    new Date(Date.UTC(2026, 3, 1)),
  )
  assert.deepEqual(values, [null, 1_800_00, null])
})

test('the month axis keeps the months nobody was paid in', () => {
  // Built from the settlements alone, an axis of Feb/Mar/May would put a dead
  // April behind the chart and show a carrier who skipped a payroll run an
  // unbroken year.
  const { buckets } = payByMonth([], new Date(Date.UTC(2026, 1, 1)), new Date(Date.UTC(2026, 4, 1)))
  assert.deepEqual(
    buckets.map((b) => b.key),
    ['2026-02', '2026-03', '2026-04', '2026-05'],
  )
})

test('two settlements inside one month add up rather than replacing each other', () => {
  const paid = paidSettlements([
    settlement({ id: 'w1', paidOn: '2026-03-05', netCents: 1_800_00 }),
    settlement({
      id: 'w2',
      paidOn: '2026-03-12',
      netCents: 1_700_00,
      periodStart: '2026-03-09',
      periodEnd: '2026-03-15',
    }),
  ]).rows
  const { values } = payByMonth(
    paid,
    new Date(Date.UTC(2026, 2, 1)),
    new Date(Date.UTC(2026, 2, 1)),
  )
  assert.deepEqual(values, [3_500_00])
})

test('the window ends on the current month and does not roll into the next', () => {
  // Taken off a UTC clock on the last evening of a month in California, the
  // window would open on an empty column labelled with next month.
  const { from, to } = monthsEnding('2026-01-31', 6)
  assert.equal(from.toISOString().slice(0, 10), '2025-08-01')
  assert.equal(to.toISOString().slice(0, 10), '2026-01-01')
  assert.equal(payByMonth([], from, to).buckets.length, 6)
})

// ------------------------------------------------------------ the net on screen

test("a draft's net comes from its lines and is never presented as frozen", () => {
  const net = netForDisplay('draft', null, [
    { category: 'earning', amountCents: 2_000_00 },
    { category: 'deduction', amountCents: -250_00 },
  ])
  assert.deepEqual(net, { cents: 1_750_00, frozen: false, drift: false })
})

test('a locked total that disagrees with its own lines is reported, not hidden', () => {
  // Unreachable through the app: the lines are immutable once locked. So it
  // means somebody edited the database by hand, and a silently wrong total on a
  // statement the driver has already been paid is the worst number here.
  const net = netForDisplay('paid', 1_900_00, [{ category: 'earning', amountCents: 1_800_00 }])
  assert.equal(net.cents, 1_900_00)
  assert.equal(net.frozen, true)
  assert.equal(net.drift, true)
})

test('a locked settlement shows what was paid, not what the lines now add to', () => {
  const net = netForDisplay('paid', 1_800_00, [{ category: 'earning', amountCents: 1_800_00 }])
  assert.deepEqual(net, { cents: 1_800_00, frozen: true, drift: false })
})
