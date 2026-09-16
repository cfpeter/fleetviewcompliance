/**
 * Revenue, drawn without inventing any of it.
 *
 * The load board already answers "what is on the board". It cannot answer the
 * two questions the owner asks about money — "is this month better or worse
 * than the last three" and "how much of my year is one broker" — because both
 * of those are shapes, and a table sorted by date is a shape you can only see
 * by reading forty rows and holding them in your head. A carrier taking 70% of
 * his revenue from one customer is a carrier one lost contract from closing,
 * and in an alphabetical list that fact is invisible.
 *
 * FOUR TRAPS THIS MODULE EXISTS TO AVOID. Each one has a test named after it.
 *
 * 1. A LOAD WITH NO RATE IS NOT A $0 LOAD. `linehaul_cents` and its two
 *    siblings are all nullable, and a load booked off a phone at the truck stop
 *    routinely carries a reference number and nothing else. Summed as zero it
 *    drags the month's column down and reads as a bad month; it is not a bad
 *    month, it is an unfinished record. Those go to two different people, so
 *    they are counted separately and `Figure`'s coverage says how many.
 *
 * 2. A QUOTE IS NOT MONEY. `quoted` means priced and not committed, and a
 *    cancelled load means whatever was priced is not coming. Drawn as revenue
 *    they book income nobody has agreed to pay, on the screen the owner uses to
 *    decide whether he can make payroll.
 *
 * 3. `status` AND `billing` ARE NOT ONE FUNNEL. 0009_loads.sql made them
 *    separate enums because a load can be delivered and unbilled, and merging
 *    them is the documented cause of "the reports don't match" across this
 *    whole product category. Nothing here derives one from the other. The mix
 *    chart draws `billing` alone, because `billing` is the one about money.
 *
 * 4. A MONTH BOUNDARY IS A LOCAL ONE. `created_at` is a timestamptz — a real
 *    instant — and bucketing it in UTC dates a load booked at 5pm on 30
 *    September in Fontana into October. The chart then disagrees with the date
 *    printed beside the same load in the table underneath it, which is trap 3
 *    arriving by a different road.
 *
 * Money is integer cents throughout and no float ever exists in the arithmetic
 * below. `compactMoney` appears only on column labels, never on a figure the
 * owner might reconcile against a cheque — those stay exact, in the table.
 */
import { totalRateCents } from '../loads.ts'
import { CARRIER_TIME_ZONE } from '../stops.ts'
import { type Bucket, compactMoney, monthBuckets, type Value } from './scale.ts'
import type { Tone } from './tones.ts'

/**
 * The columns every derivation here reads, and nothing else.
 *
 * Deliberately not the page's row type. Kept to the shape these functions
 * actually need, so they can be tested against six hand-written objects rather
 * than against a database — the same reason `buildRunway` takes a standing and
 * a date instead of a DeadlineItem.
 */
export interface RevenueLoad {
  status?: string | null
  exception?: string | null
  billing?: string | null
  linehaul_cents?: number | null
  fuel_surcharge_cents?: number | null
  accessorials_cents?: number | null
  /** The timestamptz as PostgREST hands it over. */
  created_at?: string | null
  customer_id?: string | null
}

/**
 * What one load contributes, as exactly one of four answers.
 *
 * A union rather than `number | null`, because the three ways of contributing
 * nothing are three different sentences on screen and the page has to be able
 * to write the right one. Collapsed to null they all render as "no data", and
 * "you have not typed the rate yet" becomes indistinguishable from "this one
 * was cancelled".
 */
export type RevenueClass =
  | { kind: 'counted'; cents: number }
  | { kind: 'unpriced' }
  | { kind: 'quoted' }
  | { kind: 'cancelled' }

/**
 * Decide what one load is worth to a revenue chart.
 *
 * The order of the tests is the argument. Cancelled comes first because it is
 * the strongest statement available about the money — whatever stage the load
 * reached, that rate is not arriving — and a load that is both quoted and
 * cancelled must land in exactly one bucket or the coverage sentence
 * double-counts it.
 *
 * TONU is deliberately NOT excluded here. It is an exception, not a
 * cancellation: truck ordered and not used is usually the most collectable $150
 * on the board, and it is already the line item small carriers most often
 * forget. Dropping it from revenue would teach them to forget it here too.
 */
export function classifyLoad(load: RevenueLoad): RevenueClass {
  if (load.exception === 'cancelled') return { kind: 'cancelled' }
  if (load.status === 'quoted') return { kind: 'quoted' }
  // totalRateCents is NULL only when all three money columns are null, and a
  // null component inside a priced load really does add nothing. That rule
  // lives in loads.ts and is imported rather than repeated: written out twice,
  // the invoice total and the chart total drift apart within a month.
  const cents = totalRateCents(load)
  if (cents === null) return { kind: 'unpriced' }
  return { kind: 'counted', cents }
}

/** Loads a revenue chart has any business drawing: priced or merely unpriced. */
export function isRevenueLoad(load: RevenueLoad): boolean {
  const kind = classifyLoad(load).kind
  return kind === 'counted' || kind === 'unpriced'
}

// ---------------------------------------------------------------------------
// The carrier's own day
// ---------------------------------------------------------------------------

/**
 * The calendar day an instant fell on, where the trucks are.
 *
 * Returned as UTC midnight of that local day so it can be compared against
 * `monthBuckets`, which is UTC throughout like everything else in scale.ts.
 *
 * This is trap 4. `formatStamp` in customers.ts already prints load timestamps
 * in `America/Los_Angeles`, so a load booked at 5pm on 30 September reads "Sep
 * 30" in the table. Bucketed in raw UTC the same load lands in October, and the
 * owner gets a chart whose month totals cannot be reconciled with the rows
 * printed directly underneath it.
 *
 * The parts are read with `formatToParts` rather than by slicing a formatted
 * string, and the zone constant is imported from stops.ts rather than written
 * out again — when a carrier outside California signs up, the fix is to read
 * `carriers.timezone` in one place, not to find four copies of a string.
 */
function carrierDayOf(instant: Date, timeZone: string): Date | null {
  if (Number.isNaN(instant.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN)
  const year = read('year')
  const month = read('month')
  const day = read('day')
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  return new Date(Date.UTC(year, month - 1, day))
}

/**
 * A stored timestamp as the day it was in the yard, or `null`.
 *
 * `null` for a missing or unreadable stamp, and the caller must count those
 * rather than dropping them — a load quietly missing from a revenue chart is
 * the one failure mode nobody notices, because the chart still looks fine.
 */
export function bookedDay(
  iso: string | null | undefined,
  timeZone: string = CARRIER_TIME_ZONE,
): Date | null {
  if (!iso) return null
  return carrierDayOf(new Date(iso), timeZone)
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/**
 * Every load in a set, accounted for.
 *
 * `loads` is the sum of the four class counts and is checked by a test, for the
 * same reason the runway checks it: the dangerous bug in a chart derivation is
 * not a wrong number, it is a row that silently stops being counted anywhere.
 */
export interface RevenueSummary {
  /** counted + unpriced + quoted + cancelled. Nothing else exists. */
  loads: number
  /** Loads carrying a figure. */
  countedLoads: number
  /** Exact integer cents across `countedLoads`. */
  totalCents: number
  /** Committed loads with no rate typed. NOT loads worth zero. */
  unpricedLoads: number
  quotedLoads: number
  cancelledLoads: number
  /**
   * Of `totalCents`, how much is already given up on.
   *
   * Written-off money was really hauled and really billed, so it stays in the
   * revenue total — but the total then overstates what will be collected, and
   * that is worth a sentence rather than a silent subtraction.
   */
  writtenOffCents: number
  writtenOffLoads: number
}

function emptySummary(): RevenueSummary {
  return {
    loads: 0,
    countedLoads: 0,
    totalCents: 0,
    unpricedLoads: 0,
    quotedLoads: 0,
    cancelledLoads: 0,
    writtenOffCents: 0,
    writtenOffLoads: 0,
  }
}

function addTo(sum: RevenueSummary, load: RevenueLoad, klass: RevenueClass): void {
  sum.loads++
  if (klass.kind === 'counted') {
    sum.countedLoads++
    sum.totalCents += klass.cents
    if (load.billing === 'written_off') {
      sum.writtenOffLoads++
      sum.writtenOffCents += klass.cents
    }
    return
  }
  if (klass.kind === 'unpriced') sum.unpricedLoads++
  else if (klass.kind === 'quoted') sum.quotedLoads++
  else sum.cancelledLoads++
}

/** What a set of loads is worth, and what it is not worth and why. */
export function summarise(loads: readonly RevenueLoad[] | null | undefined): RevenueSummary {
  const sum = emptySummary()
  for (const load of loads ?? []) addTo(sum, load, classifyLoad(load))
  return sum
}

// ---------------------------------------------------------------------------
// Revenue by month
// ---------------------------------------------------------------------------

export interface RevenueColumn extends Bucket {
  /** Integer cents, or `null` when this month has no figure at all. */
  value: Value
  /** What the column prints. `compactMoney` only — the exact cents are in the table. */
  display: string
  countedLoads: number
  unpricedLoads: number
  /**
   * The month still running.
   *
   * Drawn in a different tone by the page, because a half-finished month is a
   * short column for a reason that has nothing to do with the business, and
   * eleven full months followed by a short one reads as a collapse.
   */
  isCurrent: boolean
}

export interface MonthlyRevenue {
  columns: RevenueColumn[]
  /** Loads that landed on the axis. */
  window: RevenueSummary
  /** Loads dated outside it. Real money, deliberately not drawn here. */
  outside: RevenueSummary
  /** Loads with no readable booking date. Counted so nothing vanishes. */
  undated: number
  months: number
}

/**
 * Revenue by the month the load was BOOKED, over the last `months` months.
 *
 * Booked, not delivered and not paid, and the page has to say so — nothing in
 * 0009_loads.sql records when the freight came off or when the money landed, so
 * `created_at` is the only date a load has. Drawing it under a heading that
 * implies cash received would be the most expensive kind of wrong this app can
 * be: an owner reading a paid-in month that is really a booked one.
 *
 * Twelve months by default. Thirteen or fourteen columns is the point at which
 * they become stripes on a 375px phone, which is the width this is read at.
 */
export function revenueByMonth(
  loads: readonly RevenueLoad[] | null | undefined,
  today: Date,
  opts: { months?: number; timeZone?: string } = {},
): MonthlyRevenue {
  const timeZone = opts.timeZone ?? CARRIER_TIME_ZONE
  const months = Math.max(1, Math.trunc(opts.months ?? 12))
  const rows = loads ?? []

  const anchor = carrierDayOf(today, timeZone)
  // Unreachable from the pages, which pass `new Date()`. If it ever is reached,
  // an axis invented from a date we could not read would draw a year of empty
  // months over real loads, so instead nothing is drawn and every load is
  // reported as outside the window — where the page's coverage will say so.
  if (!anchor) {
    return { columns: [], window: emptySummary(), outside: summarise(rows), undated: 0, months }
  }

  const from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - (months - 1), 1))
  const to = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1))
  // monthBuckets, never the months present in the data. An axis assembled from
  // the rows shows a carrier who ran three good months and two dead ones a
  // picture of five good months.
  const buckets = monthBuckets(from, to)

  const cells = buckets.map(() => ({ cents: 0, counted: 0, unpriced: 0 }))
  const window = emptySummary()
  const outside = emptySummary()
  let undated = 0

  for (const load of rows) {
    const day = bookedDay(load.created_at, timeZone)
    if (!day) {
      undated++
      continue
    }
    const klass = classifyLoad(load)
    const t = day.getTime()
    const i = buckets.findIndex((b) => t >= b.start.getTime() && t < b.end.getTime())
    if (i === -1) {
      addTo(outside, load, klass)
      continue
    }
    addTo(window, load, klass)
    if (klass.kind === 'counted') {
      cells[i].cents += klass.cents
      cells[i].counted++
    } else if (klass.kind === 'unpriced') {
      cells[i].unpriced++
    }
  }

  const columns = buckets.map((bucket, i) => {
    const cell = cells[i]
    // `counted > 0`, not `cents > 0`. A month whose only load really was
    // written for zero has a figure, and that figure is zero — it draws as a
    // flat column labelled $0, which is a claim we can evidence. A month with
    // no priced load has no figure at all and draws as the absence it is.
    const value: Value = cell.counted > 0 ? cell.cents : null
    return {
      ...bucket,
      value,
      display:
        value !== null
          ? compactMoney(value)
          : // Two different absences, two different words. A month in which four
            // loads were booked and none was priced must not read the same as a
            // month in which the truck never moved.
            cell.unpriced > 0
            ? 'no rate'
            : '—',
      countedLoads: cell.counted,
      unpricedLoads: cell.unpriced,
      isCurrent: i === buckets.length - 1,
    }
  })

  return { columns, window, outside, undated, months }
}

// ---------------------------------------------------------------------------
// The billing mix
// ---------------------------------------------------------------------------

export interface BillingGroup {
  key: string
  label: string
  tone: Tone
  /** `billing_status` enum values from 0009_loads.sql, spelled exactly. */
  members: readonly string[]
}

/**
 * The ten billing states, grouped into the five answers an owner acts on.
 *
 * Ten segments on one bar are stripes, and the legend under them is a wall. The
 * grouping is by WHOSE PROBLEM IT IS, which is the only cut that changes what
 * he does next:
 *
 *   - paperwork not done, and ready to invoice, are HIS. They are kept apart
 *     because the second one is the expensive one — a finished load he simply
 *     has not billed, cash sitting on his own desk, and it is where a small
 *     carrier's money actually gets stuck.
 *   - invoiced, sent to the factor and funded are all "out with somebody
 *     else". Nothing he does today moves them.
 *   - paid and closed are done.
 *   - short paid, disputed and written off are broken, and they are the ones
 *     that need a phone call.
 *
 * The tones are lifted straight off `billingPillClass` in loads.ts — amber for
 * ready-to-invoice, red for the broken ones, green for paid. A chart that gave
 * those states different colours from the pills in the table two inches below
 * it would teach the owner that neither can be trusted.
 */
export const BILLING_GROUPS: readonly BillingGroup[] = [
  { key: 'not_ready', label: 'Paperwork not done', tone: 'neutral', members: ['not_ready'] },
  { key: 'ready', label: 'Ready to invoice', tone: 'soon', members: ['ready_to_invoice'] },
  {
    key: 'awaiting',
    label: 'Waiting on payment',
    tone: 'brand',
    members: ['invoiced', 'submitted_to_factor', 'funded'],
  },
  { key: 'settled', label: 'Paid', tone: 'good', members: ['paid', 'closed'] },
  {
    key: 'problem',
    label: 'Short paid, disputed or written off',
    tone: 'overdue',
    members: ['short_paid', 'in_dispute', 'written_off'],
  },
]

export interface BillingSlice {
  key: string
  label: string
  tone: Tone
  /** Loads in this group. This is what the bar is drawn from. */
  count: number
  /** Of those, the ones carrying a rate. */
  countedLoads: number
  /** Exact integer cents across `countedLoads`. */
  cents: number
}

export interface BillingMix {
  slices: BillingSlice[]
  /** Sum of the slice counts, always. Passed to `Proportion` as the whole. */
  total: number
  quotedLoads: number
  cancelledLoads: number
  /** Loads in the bar with no rate on them, so `cents` understates every slice. */
  unpricedLoads: number
}

/**
 * Where the money on the board is, as a mix of LOADS.
 *
 * Counts, not dollars, because `Proportion` is a count bar and quietly feeding
 * it cents would make a segment's width and the number printed in its legend
 * mean two different things. It also has a real consequence the page must state
 * out loud: twelve small loads waiting on payment look bigger here than one
 * large one. The exact cents per slice are returned alongside so the sentence
 * under the chart can correct for exactly that.
 *
 * Quoted and cancelled loads are left out, and left out of `revenueByMonth`
 * too. Two charts on one page drawn from two different populations is how a
 * page starts disagreeing with itself.
 */
export function billingMix(loads: readonly RevenueLoad[] | null | undefined): BillingMix {
  const slices: BillingSlice[] = BILLING_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    tone: g.tone,
    count: 0,
    countedLoads: 0,
    cents: 0,
  }))
  // A `billing_status` value no group claims — which today means a value added
  // to the enum by a later migration than this file. It gets its own slice
  // rather than being folded into the nearest one, because folding it would
  // put loads into a group whose label is a statement about them that nobody
  // checked. Appended only when it is non-empty, so the legend stays five long.
  const other: BillingSlice = {
    key: 'other',
    label: 'Some other billing state',
    tone: 'neutral',
    count: 0,
    countedLoads: 0,
    cents: 0,
  }

  let quotedLoads = 0
  let cancelledLoads = 0
  let unpricedLoads = 0

  for (const load of loads ?? []) {
    const klass = classifyLoad(load)
    if (klass.kind === 'quoted') {
      quotedLoads++
      continue
    }
    if (klass.kind === 'cancelled') {
      cancelledLoads++
      continue
    }
    const index = BILLING_GROUPS.findIndex((g) => g.members.includes(load.billing ?? ''))
    const slice = index === -1 ? other : slices[index]
    slice.count++
    if (klass.kind === 'counted') {
      slice.countedLoads++
      slice.cents += klass.cents
    } else {
      unpricedLoads++
    }
  }

  const live = other.count > 0 ? [...slices, other] : slices
  return {
    slices: live,
    total: live.reduce((n, s) => n + s.count, 0),
    quotedLoads,
    cancelledLoads,
    unpricedLoads,
  }
}

/** One slice by key, for a page writing a sentence about it. */
export function sliceOf(mix: BillingMix, key: string): BillingSlice | undefined {
  return mix.slices.find((s) => s.key === key)
}

// ---------------------------------------------------------------------------
// Concentration
// ---------------------------------------------------------------------------

export interface CustomerForRevenue {
  id: string
  name: string
  days_to_pay?: number | null
}

export interface CustomerRevenue {
  id: string
  name: string
  /** Integer cents, or `null` when they have loads and not one carries a rate. */
  cents: Value
  countedLoads: number
  unpricedLoads: number
  /** NULL means they never told us. It does not mean they pay on delivery. */
  daysToPay: number | null
}

export interface RevenueRanking {
  /** Customers with at least one eligible load, best first, unpriced last. */
  rows: CustomerRevenue[]
  /** Exact cents across `rows`. The denominator `topShare` uses. */
  attributedCents: number
  /** Revenue on loads with nobody on them. In no bar, and in no share. */
  unattributedCents: number
  unattributedLoads: number
  /** Eligible loads anywhere in the set with no rate typed. */
  unpricedLoads: number
  quotedLoads: number
  cancelledLoads: number
  /**
   * The top customer's share of attributed revenue, as a whole percent, or
   * `null` when there is nothing to divide by.
   *
   * Whole percent because it is read, not reconciled — and rounded here rather
   * than on the page so no caller can print '69.99999999999999%'.
   */
  topShare: number | null
}

/**
 * Rank customers by what they have actually paid for, and expose the
 * concentration.
 *
 * Concentration risk is the thing this ranking exists for. An alphabetical book
 * of forty brokers hides the fact that one of them is most of the year, and a
 * carrier who does not know that cannot price the risk of losing them. The
 * denominator is ATTRIBUTED revenue only — loads with no customer on them
 * cannot belong to anyone — which means the share is computed over less than
 * the whole, and the page has to say so or the number is overstated.
 *
 * A customer with loads but no rate on any of them comes back with `cents:
 * null` and sorts last, where `Bars` draws them as a dashed empty slot. Summing
 * them to zero would rank a customer we simply have not finished entering below
 * one we genuinely earn nothing from.
 */
export function topCustomers(
  loads: readonly RevenueLoad[] | null | undefined,
  customers: readonly CustomerForRevenue[] | null | undefined,
): RevenueRanking {
  const known = new Map((customers ?? []).map((c) => [c.id, c]))
  const tally = new Map<string, { cents: number; counted: number; unpriced: number }>()

  let unattributedCents = 0
  let unattributedLoads = 0
  let unpricedLoads = 0
  let quotedLoads = 0
  let cancelledLoads = 0

  for (const load of loads ?? []) {
    const klass = classifyLoad(load)
    if (klass.kind === 'quoted') {
      quotedLoads++
      continue
    }
    if (klass.kind === 'cancelled') {
      cancelledLoads++
      continue
    }
    if (klass.kind === 'unpriced') unpricedLoads++

    const id = load.customer_id ?? ''
    // An id we do not hold counts as unattributed rather than being dropped.
    // `customer_id` is ON DELETE SET NULL, so the normal case is a bare null;
    // the other case is a caller handing us a filtered customer list, and a
    // load silently missing from every bar would make the bars add up to less
    // than the total with nothing on screen saying why.
    if (!known.has(id)) {
      unattributedLoads++
      if (klass.kind === 'counted') unattributedCents += klass.cents
      continue
    }
    const entry = tally.get(id) ?? { cents: 0, counted: 0, unpriced: 0 }
    if (klass.kind === 'counted') {
      entry.cents += klass.cents
      entry.counted++
    } else {
      entry.unpriced++
    }
    tally.set(id, entry)
  }

  const rows: CustomerRevenue[] = []
  for (const [id, entry] of tally) {
    const customer = known.get(id)
    if (!customer) continue
    rows.push({
      id,
      name: customer.name,
      cents: entry.counted > 0 ? entry.cents : null,
      countedLoads: entry.counted,
      unpricedLoads: entry.unpriced,
      daysToPay: customer.days_to_pay ?? null,
    })
  }

  rows.sort((a, b) => {
    if (a.cents === null && b.cents === null) return a.name.localeCompare(b.name)
    // Unpriced last, never at zero. The tie-break on name keeps the order
    // stable between renders, so the bar that was third does not become fourth
    // on a refresh that changed nothing.
    if (a.cents === null) return 1
    if (b.cents === null) return -1
    if (b.cents !== a.cents) return b.cents - a.cents
    return a.name.localeCompare(b.name)
  })

  const attributedCents = rows.reduce((n, r) => n + (r.cents ?? 0), 0)
  const top = rows[0]?.cents ?? null
  const topShare =
    top !== null && attributedCents > 0 ? Math.round((top / attributedCents) * 100) : null

  return {
    rows,
    attributedCents,
    unattributedCents,
    unattributedLoads,
    unpricedLoads,
    quotedLoads,
    cancelledLoads,
    topShare,
  }
}
