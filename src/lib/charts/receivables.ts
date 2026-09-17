/**
 * What you are owed, and how long it has been sitting there.
 *
 * THE DATE THESE BANDS ARE AGED FROM IS NOT THE INVOICE DATE, BECAUSE THERE IS
 * NO INVOICE DATE. 0009_loads.sql gives a load exactly one moment in time —
 * `created_at`, the day it was entered — and nothing else: no invoiced_on, no
 * paid_on, no payment row anywhere in the schema. So every band below is
 * "days since the load was entered", which is always OLDER than the invoice it
 * stands for, and every caller has to print that sentence next to the chart.
 *
 * That is not pedantry. An owner who reads "more than 90 days" off this screen
 * and says it down the phone to a broker whose invoice went out three weeks ago
 * has been handed an argument he loses, by us. Aging receivables properly needs
 * a migration (an invoice date on the load, and the day the money landed); until
 * then this is the age of the LOAD and it is labelled as the age of the load.
 *
 * WHICH LOADS COUNT. The `waiting` stage from `FUNNEL_STAGES` — invoiced, with
 * the factor, funded — imported rather than spelled out again, so this file and
 * the money funnel on /app/loads can never disagree about what "still out"
 * means. Short-paid and disputed money is owed too, and it is returned
 * SEPARATELY rather than folded into a band: it needs a phone call, not a wait.
 *
 * MONEY IS INTEGER CENTS AND NO FLOAT EXISTS HERE. Every band total is integer
 * addition of `totalRateCents` figures. The only division anywhere near this is
 * `widthPercent` inside the chart component, which produces a CSS width and
 * never a figure anybody reads.
 *
 * `null` IS NOT ZERO, here as everywhere. A band holding four loads nobody has
 * priced draws as an absence with the words for it, never as $0.00 — an
 * unpriced load is not a zero-dollar load, and the two go to different people.
 */
import { formatCents } from '../loads.ts'
import { daysSinceBooked, FUNNEL_STAGES } from './funnel.ts'
import { classifyLoad, type RevenueLoad } from './revenue.ts'
import type { Value } from './scale.ts'
import type { Tone } from './tones.ts'

/**
 * The billing states that mean the money is out with somebody else.
 *
 * Taken off the funnel's own stage rather than written out again. If a later
 * migration adds a billing state, it is added there once.
 */
export const WAITING_BILLING: readonly string[] =
  FUNNEL_STAGES.find((s) => s.key === 'waiting')?.billing ?? []

/** Owed, and contested. Spelled as the `billing_status` enum spells them. */
export const DISPUTED_BILLING: readonly string[] = ['short_paid', 'in_dispute']

export type AgeBandKey = 'to30' | 'to60' | 'to90' | 'over90'

export interface AgeBand {
  key: AgeBandKey
  /** Plain words, read by owners who are not fluent in English. */
  label: string
  tone: Tone
  /** Inclusive lower bound, in whole days since the load was entered. */
  from: number
  /** Inclusive upper bound, or `null` for the open-ended band. */
  to: number | null
}

/**
 * The four bands every accountant in the industry uses, and the colours this
 * app uses everywhere else.
 *
 * Blue for the first band because money out with a broker on ordinary terms is
 * not "on track" and it is not a problem either — it is simply out, which is
 * exactly what blue means on the money funnel. Amber at 31 days, because a net
 * 30 has then been missed. Red from 61, because sixty days is where a small
 * carrier's fuel and payroll actually break, and red in this app means act now.
 * The last two bands share the colour and are told apart by their words and
 * their figures, which is the rule: colour carries the urgency and nothing finer.
 */
export const AGE_BANDS: readonly AgeBand[] = [
  { key: 'to30', label: '30 days or less', tone: 'brand', from: 0, to: 30 },
  { key: 'to60', label: '31 to 60 days', tone: 'soon', from: 31, to: 60 },
  { key: 'to90', label: '61 to 90 days', tone: 'overdue', from: 61, to: 90 },
  { key: 'over90', label: 'More than 90 days', tone: 'overdue', from: 91, to: null },
]

/** Where the phone call starts. Exported so the page prints the number used. */
export const CHASE_AFTER_DAYS = 60

export interface AgingBand extends AgeBand {
  /** Exact integer cents across the priced loads in this band. */
  cents: number
  loads: number
  /** Loads in this band with no rate typed. Their dollars are unknown, not zero. */
  unpricedLoads: number
  /**
   * What the bar draws. `cents` when anything here is priced; `null` when the
   * band HAS loads and not one carries a rate; a real, known `0` when the band
   * is genuinely empty.
   */
  value: Value
  /** The exact figure, or the words for the absence. */
  display: string
}

export interface Aging {
  /** All four bands, always, oldest last. An empty band is a fact. */
  bands: AgingBand[]
  /** Exact integer cents across every priced load in the bands. */
  totalCents: number
  countedLoads: number
  unpricedLoads: number
  /** Loads that are out but carry no readable entry date. In no band. */
  undatedLoads: number
  /** Their money, which is therefore in no band either. */
  undatedCents: number
  /** Whole days since the oldest load still out was entered. */
  oldestDays: number | null
  /** Money past the chase line. The figure worth a phone call today. */
  chaseCents: number
  /**
   * The loads `chaseCents` is built from, and ONLY those.
   *
   * A load past the line with no rate on it is counted in `chaseUnpricedLoads`
   * instead, so the pair printed on screen — "$4,200 across 3 loads" — is
   * always the same three loads that made the $4,200.
   */
  chaseLoads: number
  chaseUnpricedLoads: number
  /** Short paid or in dispute. Owed, contested, and NOT in any band above. */
  disputedCents: number
  disputedLoads: number
  /** Every load that is out, priced or not, dated or not. */
  waitingLoads: number
  /** The cutoff the chase figures used, so the page prints the same number. */
  chaseAfterDays: number
}

function bandIndexFor(days: number): number {
  // A load entered "tomorrow" — a clock an hour ahead of the carrier's own day —
  // is not aged backwards out of the chart. It belongs in the first band.
  const d = Math.max(0, days)
  return AGE_BANDS.findIndex((b) => d >= b.from && (b.to === null || d <= b.to))
}

/**
 * Split what is still out across the four age bands.
 *
 * `today` is passed in rather than read off the clock, so the banding is
 * deterministic in a test — the same reason `revenueByMonth` and `moneyFunnel`
 * take it.
 *
 * Quoted and cancelled loads are left out, exactly as every other derivation in
 * this folder leaves them out: a quote is money nobody has agreed to pay, and a
 * cancelled load's rate is not arriving. Two charts on one page drawn from two
 * different populations is how a page starts disagreeing with itself.
 */
export function receivablesAging(
  loads: readonly RevenueLoad[] | null | undefined,
  today: Date,
  opts: { timeZone?: string; chaseAfterDays?: number } = {},
): Aging {
  const chaseAfterDays = Math.max(1, Math.trunc(opts.chaseAfterDays ?? CHASE_AFTER_DAYS))
  const cells = AGE_BANDS.map(() => ({ cents: 0, loads: 0, unpriced: 0 }))

  let countedLoads = 0
  let unpricedLoads = 0
  let undatedLoads = 0
  let undatedCents = 0
  let oldestDays: number | null = null
  let chaseCents = 0
  let chaseLoads = 0
  let chaseUnpricedLoads = 0
  let disputedCents = 0
  let disputedLoads = 0
  let waitingLoads = 0

  for (const load of loads ?? []) {
    const klass = classifyLoad(load)
    if (klass.kind === 'quoted' || klass.kind === 'cancelled') continue
    const billing = load.billing ?? ''

    if (DISPUTED_BILLING.includes(billing)) {
      disputedLoads++
      if (klass.kind === 'counted') disputedCents += klass.cents
      continue
    }
    if (!WAITING_BILLING.includes(billing)) continue

    waitingLoads++
    const days = daysSinceBooked(load.created_at, today, opts.timeZone)
    if (days === null) {
      // Counted and named rather than dropped. A load quietly missing from a
      // money chart is the one failure nobody notices, because the chart still
      // looks fine.
      undatedLoads++
      if (klass.kind === 'counted') undatedCents += klass.cents
      continue
    }
    if (oldestDays === null || days > oldestDays) oldestDays = days

    const i = bandIndexFor(days)
    // Unreachable: the bands cover every day from 0 upwards. Guarded so a future
    // edit to AGE_BANDS that leaves a hole cannot silently delete money.
    if (i === -1) {
      undatedLoads++
      if (klass.kind === 'counted') undatedCents += klass.cents
      continue
    }

    cells[i].loads++
    if (klass.kind === 'counted') {
      cells[i].cents += klass.cents
      countedLoads++
      if (days > chaseAfterDays) {
        chaseCents += klass.cents
        chaseLoads++
      }
    } else {
      cells[i].unpriced++
      unpricedLoads++
      if (days > chaseAfterDays) chaseUnpricedLoads++
    }
  }

  const bands: AgingBand[] = AGE_BANDS.map((band, i) => {
    const cell = cells[i]
    const priced = cell.loads - cell.unpriced
    const value: Value = cell.loads === 0 ? 0 : priced > 0 ? cell.cents : null
    return {
      ...band,
      cents: cell.cents,
      loads: cell.loads,
      unpricedLoads: cell.unpriced,
      value,
      display:
        value !== null
          ? formatCents(value)
          : // Two absences, two different sentences. A band holding three loads
            // nobody has priced must not read like a band holding nothing.
            `no rate on ${cell.unpriced} ${cell.unpriced === 1 ? 'load' : 'loads'}`,
    }
  })

  return {
    bands,
    totalCents: bands.reduce((n, b) => n + b.cents, 0),
    countedLoads,
    unpricedLoads,
    undatedLoads,
    undatedCents,
    oldestDays,
    chaseCents,
    chaseLoads,
    chaseUnpricedLoads,
    disputedCents,
    disputedLoads,
    waitingLoads,
    chaseAfterDays,
  }
}

export interface CustomerForReceivables {
  id: string
  name: string
  days_to_pay?: number | null
}

export interface CustomerReceivable {
  id: string
  name: string
  /** Exact integer cents still out with them. */
  cents: number
  loads: number
  unpricedLoads: number
  /** Days since their oldest load still out was entered. */
  oldestDays: number | null
  /** NULL means they never told us. It does not mean they pay on delivery. */
  daysToPay: number | null
}

export interface CustomerReceivables {
  /** Most money out first. Ties broken by age, then by name, so it is stable. */
  rows: CustomerReceivable[]
  /** Money out on loads with no customer on them. In no row above. */
  unattributedCents: number
  unattributedLoads: number
}

/**
 * Whose money it is.
 *
 * The aging bands answer "how stale is what I am owed". They cannot answer
 * "who do I ring", because a band is a mix of brokers. This is the same
 * population, cut the other way, so the two always add up to the same total —
 * minus the unattributed part, which is returned rather than hidden for exactly
 * that reason.
 */
export function receivablesByCustomer(
  loads: readonly RevenueLoad[] | null | undefined,
  customers: readonly CustomerForReceivables[] | null | undefined,
  today: Date,
  opts: { timeZone?: string } = {},
): CustomerReceivables {
  const known = new Map((customers ?? []).map((c) => [c.id, c]))
  const tally = new Map<
    string,
    { cents: number; loads: number; unpriced: number; oldest: number | null }
  >()

  let unattributedCents = 0
  let unattributedLoads = 0

  for (const load of loads ?? []) {
    const klass = classifyLoad(load)
    if (klass.kind === 'quoted' || klass.kind === 'cancelled') continue
    if (!WAITING_BILLING.includes(load.billing ?? '')) continue

    const days = daysSinceBooked(load.created_at, today, opts.timeZone)
    const id = load.customer_id ?? ''
    if (!known.has(id)) {
      // `customer_id` is ON DELETE SET NULL, so a bare null is the normal case.
      unattributedLoads++
      if (klass.kind === 'counted') unattributedCents += klass.cents
      continue
    }

    const entry = tally.get(id) ?? { cents: 0, loads: 0, unpriced: 0, oldest: null }
    entry.loads++
    if (klass.kind === 'counted') entry.cents += klass.cents
    else entry.unpriced++
    if (days !== null && (entry.oldest === null || days > entry.oldest)) entry.oldest = days
    tally.set(id, entry)
  }

  const rows: CustomerReceivable[] = []
  for (const [id, entry] of tally) {
    const customer = known.get(id)
    if (!customer) continue
    rows.push({
      id,
      name: customer.name,
      cents: entry.cents,
      loads: entry.loads,
      unpricedLoads: entry.unpriced,
      oldestDays: entry.oldest,
      daysToPay: customer.days_to_pay ?? null,
    })
  }

  rows.sort((a, b) => {
    if (b.cents !== a.cents) return b.cents - a.cents
    const ao = a.oldestDays ?? -1
    const bo = b.oldestDays ?? -1
    if (bo !== ao) return bo - ao
    return a.name.localeCompare(b.name)
  })

  return { rows, unattributedCents, unattributedLoads }
}

/**
 * How long a wait reads in plain words: "34 days", "1 day".
 *
 * Never "34d". The copy rule is the copy rule, and an abbreviation is a word
 * the reader has to already know.
 */
export function daysWord(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`
}
