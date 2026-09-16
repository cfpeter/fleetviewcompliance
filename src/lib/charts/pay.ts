/**
 * Driver pay, reduced to the few shapes a list of settlements cannot show.
 *
 * The table on /app/settlements answers "what does this one statement say". It
 * cannot answer either of the questions asked around it — "what have we actually
 * paid out lately" and "what has this driver made this year" — because both are
 * sums across rows, and a sum across forty rows sorted by period is a number you
 * can only reach by reading all forty and holding them in your head. Nowhere
 * else in this product is there a per-driver year-to-date figure at all.
 *
 * Everything here is integer CENTS, as in 0016_settlements.sql. No floats, at
 * any point, for the same reason the settlement arithmetic has none: a cent of
 * drift is a figure that does not reconcile against the driver's own notebook.
 *
 * THREE WAYS A PAY CHART LIES. All three are handled in this file rather than in
 * a page, so they are tested rather than remembered.
 *
 * 1. THE DOUBLE COUNT, and it is the dangerous one. A correction to a paid
 *    settlement is a REVISION — a second row, at revision N+1, for the same
 *    driver and the same period, carrying the corrected total. Sum a column
 *    naively and the driver appears to have been paid twice for one week.
 *
 *    Filtering on `superseded_at` is NOT enough, and that is the subtle part.
 *    The revise flow writes the revision, copies its lines, and only THEN stamps
 *    the old row as superseded — deliberately, so a failure half way leaves a
 *    usable revision rather than a settlement marked "replaced" by something
 *    that does not exist (see the ordering note in /app/settlements/[id].astro).
 *    A failure at that last step therefore leaves two live paid rows for one
 *    period with nothing marked on either. So a chain is identified here by the
 *    key the database itself enforces — (driver, period_start, period_end) is
 *    unique per revision — and exactly ONE row of a chain is ever counted: the
 *    highest-revision one that was actually paid.
 *
 * 2. THE PROVISIONAL TOTAL. A draft has no frozen `net_cents` at all, by design:
 *    its total is re-derived from its lines on every page load so it cannot
 *    drift from them. That makes a draft's total a number that is still moving,
 *    and a column that adds a moving total to a frozen one is a figure nobody
 *    can reconcile against anything afterwards — not the cheque, not the lines,
 *    not the same chart next week. So NOTHING here charts a draft. Open
 *    settlements are counted and named in the coverage line instead, which is
 *    what `paidCoverage` is for.
 *
 * 3. THE SILENT DISCARD. Every row handed in comes back out somewhere: charted,
 *    replaced, open, voided, or reported as unusable. A paid settlement that
 *    simply fell out of the derivation is money a driver is owed an explanation
 *    for, and there would be nothing on the screen to suggest it was ever there.
 */
import { isLocked, settlementTotals, type TotalLine } from '../settlements/compute.ts'
import { type Bucket, bucketValues, monthBuckets, type Value } from './scale.ts'

/** A settlement, as far as a chart is concerned: exactly the columns it reads. */
export interface PaySettlement {
  id: string
  driverId: string
  /** ISO 'YYYY-MM-DD', as the date columns store it. */
  periodStart: string
  periodEnd: string
  status: string
  revision: number
  supersededAt: string | null
  /** Frozen when it locked, and NULL on anything still open. Never re-derived here. */
  netCents: number | null
  paidOn: string | null
}

/** One settlement whose money really moved, placed on a date and counted once. */
export interface PaidSettlement {
  id: string
  driverId: string
  /** Integer cents: the frozen net, exactly as it was paid. */
  cents: number
  on: Date
  /** Placed by the period it covers, because the row carries no payment date. */
  placedByPeriod: boolean
}

/**
 * What the charts draw, and everything they had to leave out.
 *
 * The counts are not diagnostics. They are what `paidCoverage` turns into the
 * sentence above the chart, because a pay chart is read as "this is what we
 * paid" whether or not half the fleet's settlements are still in draft.
 */
export interface PaidSet {
  rows: PaidSettlement[]
  /** Paid rows dropped because a higher revision of the same period was also paid. */
  replaced: number
  /** Draft or approved. The money has not moved, and the total is still moving. */
  open: number
  voided: number
  /** Counted, but a later revision of it is still open — so this is not the last word. */
  beingRevised: number
  /** Paid with no frozen total. Impossible through this app; reported, never guessed. */
  missingNet: number
  /** Paid, with no date on it we can read at all. */
  unplaceable: number
  /** How many of `rows` were placed by period end rather than by a payment date. */
  placedByPeriod: number
}

/**
 * The calendar day out of a date or timestamp column, at UTC midnight.
 *
 * Never `new Date('2026-03-01')` unqualified: on a Los Angeles carrier that
 * parses as the previous afternoon, which is how a settlement moves a day — and
 * across a month boundary, into the wrong column — without anyone touching it.
 * A value we cannot read returns null and the caller has to deal with it.
 */
function isoDay(value: string | null | undefined): Date | null {
  const m = typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null
  if (!m) return null
  const d = new Date(`${m[1]}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The settlements that represent money that actually moved, each counted once.
 *
 * `superseded_at` is deliberately not the filter — see the note at the top of
 * this file. The chain is the (driver, period) key, and the row that speaks for
 * it is the highest-revision PAID one. A paid statement whose revision is still
 * a draft therefore keeps counting: that money did move, and dropping it while
 * the office is halfway through a correction would quietly take a week's pay off
 * the driver's year.
 */
export function paidSettlements(rows: readonly PaySettlement[]): PaidSet {
  const chains = new Map<string, PaySettlement[]>()
  for (const row of rows) {
    // The database's own uniqueness key, minus the revision. Two rows sharing it
    // are the same statement re-issued; nothing else can produce a collision,
    // because settlements_period_idx forbids it.
    const key = `${row.driverId}|${row.periodStart}|${row.periodEnd}`
    const chain = chains.get(key)
    if (chain) chain.push(row)
    else chains.set(key, [row])
  }

  const out: PaidSettlement[] = []
  let replaced = 0
  let open = 0
  let voided = 0
  let beingRevised = 0
  let missingNet = 0
  let unplaceable = 0
  let placedByPeriod = 0

  for (const chain of chains.values()) {
    for (const row of chain) {
      if (row.status === 'draft' || row.status === 'approved') open++
      else if (row.status === 'void') voided++
    }

    const paid = chain.filter((r) => r.status === 'paid')
    if (paid.length === 0) continue

    const latest = paid.reduce((a, b) => (b.revision > a.revision ? b : a))
    replaced += paid.length - 1

    // A correction that has been started but not yet paid. The figure below is
    // still the right one — it is what the driver was actually handed — but the
    // caption has to say that a different number is on its way.
    if (
      chain.some(
        (r) => r.revision > latest.revision && (r.status === 'draft' || r.status === 'approved'),
      )
    ) {
      beingRevised++
    }

    if (latest.netCents === null) {
      // A CHECK constraint makes this unreachable through the app. If it turns
      // up anyway somebody has been in the database by hand, and inventing a
      // total from the lines would paper over exactly the case worth seeing.
      missingNet++
      continue
    }

    // Cash basis: a statement belongs to the period in which the money moved,
    // because that is the figure a driver reconciles against his bank. A paid
    // settlement with no payment date is placed by the period it covers rather
    // than dropped — dropping it would understate his year by a whole week —
    // and the count of those is reported so the caption can admit the mix.
    const byPayment = isoDay(latest.paidOn)
    const on = byPayment ?? isoDay(latest.periodEnd)
    if (!on) {
      unplaceable++
      continue
    }
    if (!byPayment) placedByPeriod++

    out.push({
      id: latest.id,
      driverId: latest.driverId,
      cents: latest.netCents,
      on,
      placedByPeriod: !byPayment,
    })
  }

  return {
    rows: out,
    replaced,
    open,
    voided,
    beingRevised,
    missingNet,
    unplaceable,
    placedByPeriod,
  }
}

/**
 * What a chart drawn from `paidSettlements` does not cover, as one sentence.
 *
 * Voided settlements are deliberately absent from it. A void is money that never
 * moved and was never meant to; naming it here would spend the one line the
 * owner actually reads on a non-event, and the lines that matter — a draft whose
 * total is still moving, a correction in flight — would be read past.
 */
export function paidCoverage(set: PaidSet): string | undefined {
  const parts: string[] = []
  if (set.open > 0) {
    parts.push(
      `${set.open} open ${set.open === 1 ? 'settlement is' : 'settlements are'} not counted — a draft's total is still moving.`,
    )
  }
  if (set.beingRevised > 0) {
    parts.push(
      `${set.beingRevised} paid ${set.beingRevised === 1 ? 'statement is' : 'statements are'} being revised, so the figure is what was paid, not the correction.`,
    )
  }
  if (set.missingNet > 0) {
    parts.push(
      `${set.missingNet} paid ${set.missingNet === 1 ? 'settlement has' : 'settlements have'} no stored total and ${set.missingNet === 1 ? 'is' : 'are'} left out.`,
    )
  }
  if (set.unplaceable > 0) {
    parts.push(
      `${set.unplaceable} paid ${set.unplaceable === 1 ? 'settlement has' : 'settlements have'} no readable date and ${set.unplaceable === 1 ? 'is' : 'are'} left out.`,
    )
  }
  // Written out in full rather than as "N by period", because every clause here
  // has to stand on its own: this one is often the only sentence on the figure,
  // and "3 are counted by period" says nothing to somebody who has not read the
  // code that decides which date a settlement lands on.
  if (set.placedByPeriod > 0) {
    parts.push(
      `${set.placedByPeriod} paid ${set.placedByPeriod === 1 ? 'settlement has' : 'settlements have'} no payment date, so ${set.placedByPeriod === 1 ? 'it is' : 'they are'} counted in the period ${set.placedByPeriod === 1 ? 'it covers' : 'they cover'}.`,
    )
  }
  return parts.length > 0 ? parts.join(' ') : undefined
}

// --------------------------------------------------------------- year to date

export interface DriverPay {
  driverId: string
  /** `null` when nothing has been paid to him in the year. Never 0 — see below. */
  cents: Value
  settlements: number
}

/**
 * What each driver has been paid so far this year, ranked.
 *
 * `todayIso` is the carrier's own day (todayInCalifornia), not a UTC clock. On
 * the evening of 31 December a UTC year rolls over while the office is still
 * working in the old one, and a year-to-date figure that resets a day early is
 * the one number on this page somebody would notice immediately and never trust
 * again.
 *
 * A driver on the roster with nothing paid comes back as `null`, not 0. Zero is
 * a claim that he earned nothing; null is the truth, which is that no paid
 * settlement exists for him — and on a fleet that has just started using this
 * screen, that is nearly everyone. A driver who was paid but is NOT on the
 * roster passed in still appears: he has been terminated since, and the money
 * was still paid this year.
 */
export function driverYearToDate(
  paid: readonly PaidSettlement[],
  roster: readonly string[],
  todayIso: string,
): DriverPay[] {
  const year = Number(todayIso.slice(0, 4))
  const totals = new Map<string, { cents: number; settlements: number }>()

  // Seeded in roster order so the drivers with nothing paid come back in the
  // order the caller sorted them, rather than in whatever order a uuid hash
  // happens to produce.
  for (const id of roster) totals.set(id, { cents: 0, settlements: 0 })

  const seen = new Set<string>()
  for (const row of paid) {
    if (row.on.getUTCFullYear() !== year) continue
    seen.add(row.driverId)
    const t = totals.get(row.driverId) ?? { cents: 0, settlements: 0 }
    t.cents += row.cents
    t.settlements += 1
    totals.set(row.driverId, t)
  }

  const withPay: DriverPay[] = []
  const withoutPay: DriverPay[] = []
  for (const [driverId, t] of totals) {
    if (seen.has(driverId)) withPay.push({ driverId, cents: t.cents, settlements: t.settlements })
    else withoutPay.push({ driverId, cents: null, settlements: 0 })
  }

  // Sorted by what was paid, descending. Array.prototype.sort is stable, so two
  // drivers on identical money keep roster order rather than swapping places
  // between page loads.
  withPay.sort((a, b) => (b.cents as number) - (a.cents as number))
  return [...withPay, ...withoutPay]
}

// -------------------------------------------------------------------- by month

export interface MonthlyPay {
  buckets: Bucket[]
  /** One per bucket. `null` is a month with no paid settlement, never a zero. */
  values: Value[]
}

/**
 * The window of the last `count` calendar months, ending with the current one.
 *
 * Off the carrier's day rather than a UTC clock, for the same reason as above:
 * on the last evening of a month in California the UTC month has already turned,
 * and the chart would open on an empty column labelled with next month.
 */
export function monthsEnding(todayIso: string, count: number): { from: Date; to: Date } {
  const year = Number(todayIso.slice(0, 4))
  const month = Number(todayIso.slice(5, 7)) - 1
  const span = Math.max(1, count)
  return {
    from: new Date(Date.UTC(year, month - (span - 1), 1)),
    to: new Date(Date.UTC(year, month, 1)),
  }
}

/**
 * Paid money bucketed into consecutive months.
 *
 * Consecutive, from `monthBuckets`, never from the months that happen to appear
 * in the settlements: an axis built from the data alone deletes the month
 * nobody was paid in and shows a carrier who skipped a payroll run a picture of
 * an unbroken year.
 *
 * Empty months are `null` rather than 0. We can evidence "no paid settlement
 * lands in March"; we cannot evidence "nobody was paid in March" — a carrier who
 * paid in cash and never marked the statements paid looks identical from here,
 * and drawing him a zero column would be this app telling him something about
 * his own business that it does not know.
 */
export function payByMonth(paid: readonly PaidSettlement[], from: Date, to: Date): MonthlyPay {
  const buckets = monthBuckets(from, to)
  return {
    buckets,
    values: bucketValues(
      paid,
      buckets,
      (p) => p.on,
      (p) => p.cents,
    ),
  }
}

// ------------------------------------------------------------- the net on screen

export interface NetForDisplay {
  cents: number | null
  /** True when this is the frozen figure that was paid rather than a live sum. */
  frozen: boolean
  /** A locked settlement whose stored total disagrees with its own lines. */
  drift: boolean
}

/**
 * The net to print for one settlement, and whether it is a frozen figure.
 *
 * Shared by every page that prints a settlement's total, because the two kinds
 * of number must not be distinguished differently in two places: a locked row
 * shows what was paid, an open row shows what its lines add up to right now.
 *
 * Drift is REPORTED rather than hidden. A locked settlement whose stored total
 * does not match its lines cannot happen through this app — the lines are
 * immutable once locked — so it means somebody has been in the database by hand,
 * and a silently wrong total on a paid statement is the worst number this
 * product can show anybody.
 */
export function netForDisplay(
  status: string,
  netCents: number | null,
  lines: readonly TotalLine[],
): NetForDisplay {
  const live = settlementTotals(lines).netCents
  // `isLocked` rather than a second `status === 'paid' || 'void'` written out
  // here: the moment the lock is defined in two places, one of them is what a
  // future status gets added to and the other quietly starts lying.
  if (!isLocked(status) || netCents === null) return { cents: live, frozen: false, drift: false }
  return { cents: netCents, frozen: true, drift: netCents !== live }
}
