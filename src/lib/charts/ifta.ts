/**
 * What the IFTA charts are drawn from, kept out of the pages so it can be tested.
 *
 * A quarterly return is the place in this app where a chart is most useful and
 * most dangerous at the same time. Useful, because a return is a list of who is
 * billing you and who owes you money back, and that is a shape rather than a
 * column of signed numbers. Dangerous, because the NORMAL state of a quarter is
 * half-entered — receipts arrive daily, odometers arrive at quarter end — and
 * every half-state has a confident, wrong chart waiting to be drawn from it:
 *
 *   - Fuel entered and no miles yet. Every jurisdiction computes as a pure
 *     credit and the chart announces a refund, in green, as fact.
 *     `quarterlyReturn()` already refuses to call that complete; nothing here
 *     may draw it either, because a coverage note under a wall of green is read
 *     second and the shape is read first.
 *   - A jurisdiction with no rate on file. It has miles, so it belongs on the
 *     mileage chart. It has no net figure at all, so on a diverging axis it can
 *     only sit on the centre line — where it reads as "settled, nothing owed",
 *     the exact lie the `rate_unknown` outcome exists to prevent. It comes off
 *     that chart and is NAMED in the coverage note instead.
 *   - Six of nine trucks with miles entered. Every bar on both charts is then a
 *     floor rather than a total, and the truck nobody entered is invisible
 *     rather than short.
 *
 * So the functions below return refusals and coverage sentences alongside the
 * numbers, and a caller that ignores them renders a lie. None of them does any
 * of the return's own arithmetic: that is `quarterlyReturn()`'s, it is money
 * owed to an authority that audits, and a second implementation behind a chart
 * is a second answer nobody reconciles.
 */

import {
  type FuelRow,
  fleetMpgCentis,
  mpg,
  type QuarterlyReturn,
  quarterLabel,
  returnDueOn,
} from '../ifta/compute.ts'
import { isoDay, nextQuarterStart } from '../ifta/input.ts'
import { formatCents } from '../loads.ts'
import { compactNumber, type Value } from './scale.ts'
import type { Tone } from './tones.ts'

/**
 * Whether a quarter is still having figures typed into it.
 *
 * NOT "is the quarter over". The deadline is what decides, because receipts and
 * trip sheets keep arriving all through the month after a quarter closes —
 * which is the whole reason the return is not due until the last day of that
 * month. A chart that treated 1 October as the moment Q3 became final would
 * call a half-typed quarter finished for thirty days, every quarter, and the
 * thirty days after a quarter ends are exactly when somebody is looking at it.
 */
export function quarterStillOpen(periodStart: Date, today: Date): boolean {
  return returnDueOn(periodStart).getTime() >= today.getTime()
}

// ---------------------------------------------------------------------------
// Per-truck coverage
// ---------------------------------------------------------------------------

export interface TruckCoverage {
  /** Trucks on file. */
  total: number
  /** Trucks with at least one mileage row this quarter. A typed 0 counts. */
  reporting: number
  /** Miles in this quarter recorded against no truck at all. */
  orphanMiles: number
  /** The truck list could not be read, so nothing may be claimed about it. */
  unreadable: boolean
}

/**
 * How much of the fleet the quarter's miles actually cover.
 *
 * A mileage chart is drawn from the trucks whose trip sheets somebody entered,
 * and the truck nobody entered does not appear as a short bar — it does not
 * appear at all. That is the failure `Figure`'s coverage prop exists for, and
 * this is the count that fills it in.
 *
 * `vehicleIds` of `null` means the truck list could not be read. It is NOT the
 * same as a carrier with no trucks: one is a question we cannot answer, the
 * other is an answer. Collapsing them would print "every truck has reported"
 * over a failed query.
 */
export function truckCoverage(
  vehicleIds: readonly string[] | null,
  rows: readonly { vehicleId: string | null; miles: number }[],
): TruckCoverage {
  if (vehicleIds === null) return { total: 0, reporting: 0, orphanMiles: 0, unreadable: true }

  const reported = new Set(rows.map((r) => r.vehicleId).filter((id): id is string => id !== null))
  return {
    total: vehicleIds.length,
    // Counted by walking the truck LIST, not by counting distinct ids on the
    // rows. A row still carrying the id of a truck that has since left the
    // fleet would otherwise push this past `total` and print "10 of 9 trucks".
    reporting: vehicleIds.filter((id) => reported.has(id)).length,
    orphanMiles: rows.filter((r) => r.vehicleId === null).reduce((n, r) => n + r.miles, 0),
    unreadable: false,
  }
}

/** The clause naming trucks a mileage-derived chart cannot see, or null when it sees them all. */
function truckShortfall(trucks: TruckCoverage | null): { text: string; partial: boolean } | null {
  if (!trucks || trucks.unreadable) {
    return {
      text:
        'Your truck list could not be read, so there is no way to say here whether every truck ' +
        'has miles entered for this quarter.',
      partial: false,
    }
  }
  if (trucks.total === 0 || trucks.reporting >= trucks.total) return null
  const missing = trucks.total - trucks.reporting
  return {
    text: `Only ${trucks.reporting} of ${trucks.total} trucks have miles entered for this quarter; the other ${missing} ${missing === 1 ? 'is' : 'are'} invisible here rather than short.`,
    partial: true,
  }
}

// ---------------------------------------------------------------------------
// Miles by jurisdiction
// ---------------------------------------------------------------------------

export interface MilesBar {
  label: string
  value: Value
  display: string
  note?: string
  href?: string
  tone?: Tone
}

export interface MilesFigure {
  /** Ranked, biggest first, with the jurisdictions we have no figure for last. */
  items: MilesBar[]
  /**
   * How many rows may be drawn before the tail collapses behind a "more" link.
   *
   * NEVER fewer than it takes to reach the last row carrying a caveat. The
   * unpriced jurisdictions and the ones with no miles entered sort LAST, so a
   * flat limit of ten hides precisely the rows this chart exists to keep on
   * screen — and hides them behind a link reading "5 more", which is the
   * quietest way a chart can drop a state off a tax return.
   */
  limit: number
  /** The sentence under the chart. Null when there is nothing true to say. */
  takeaway: string | null
  coverage?: string
}

/** Rows before the tail collapses, when nothing in the tail needs saying. */
const MILES_ROWS = 10

/**
 * Miles by jurisdiction, ranked.
 *
 * Every jurisdiction on the return is here, including the ones with no tax rate
 * on file. Their miles are known — it is only the tax on them that is not — and
 * dropping them would take a state the trucks demonstrably ran in off the one
 * chart that could show it.
 */
export function milesFigure(args: {
  result: QuarterlyReturn
  fuel: readonly FuelRow[]
  trucks: TruckCoverage | null
  open: boolean
}): MilesFigure {
  const { result, fuel, trucks, open } = args
  const fuelled = new Set(fuel.filter((f) => f.gallonsMilli > 0).map((f) => f.jurisdiction))

  const items: MilesBar[] = result.lines.map((line) => {
    const unpriced = line.outcome.kind === 'rate_unknown'
    // Zero miles in a jurisdiction we hold a receipt from is not zero miles.
    // Nobody buys diesel in a state they did not drive in, so the paper says a
    // truck ran there and the mileage box says nobody has typed it yet. Drawn
    // as a zero bar this claims he never went — contradicted by a row two
    // inches down the same page.
    const unentered = line.miles === 0 && fuelled.has(line.jurisdiction)
    return {
      label: line.jurisdiction,
      value: unentered ? null : line.miles,
      display: unentered ? 'not entered' : compactNumber(line.miles),
      note: unentered
        ? 'Fuel was bought here and no miles are entered, so a truck ran in this jurisdiction.'
        : unpriced
          ? 'No tax rate on file, so these miles are not priced on the return.'
          : undefined,
      // Red because the row is a PROBLEM, never because it is a big one — see
      // tones.ts. It is the same red the table below already paints an
      // unpriced line, borrowed rather than invented.
      //
      // `unentered` is NOT that. Fuel was bought and nobody has typed the miles
      // yet, which is a gap in what we hold — grey, by the same rule the whole
      // product follows: red is act-now, grey is "we do not have it". Red here
      // would say the owner is late for something when he is only missing a
      // number, on the screen whose job is telling him which numbers to go and
      // find. `unpriced` keeps the red: no tax rate on file stops the return
      // being filed correctly, and that is act-now.
      //
      // Latent rather than visible today — `Bars` draws a null value as the
      // dashed slot and never reads the tone — so this is the colour being
      // correct before something starts using it, not a repaint.
      tone: unpriced ? 'overdue' : unentered ? 'neutral' : 'brand',
    }
  })

  // Unknowns sort last rather than first: they have no magnitude to rank by,
  // and a dashed slot at the top of a ranked chart reads as the biggest bar.
  items.sort((a, b) => (b.value ?? -1) - (a.value ?? -1))

  const ranked = items.filter((i): i is MilesBar & { value: number } => (i.value ?? 0) > 0)
  const n = result.lines.length
  const takeaway =
    ranked.length === 0 || result.totalMiles <= 0
      ? null
      : `${ranked[0].label} carries ${compactNumber(ranked[0].value)} of the ${compactNumber(result.totalMiles)} miles on file — ${Math.round((ranked[0].value / result.totalMiles) * 100)}% of a quarter that runs through ${n} ${n === 1 ? 'jurisdiction' : 'jurisdictions'}.`

  const shortfall = truckShortfall(trucks)
  const coverage = [
    shortfall?.text,
    open
      ? 'The quarter is still being entered, so these are the miles on file today rather than the quarter’s total.'
      : null,
  ]
    .filter(Boolean)
    .join(' ')

  return {
    items,
    // The last row with something to say about it, so the collapse can never
    // swallow it. See the note on MilesFigure.limit.
    limit: Math.max(
      MILES_ROWS,
      items.reduce((deepest, item, i) => (item.note ? i + 1 : deepest), 0),
    ),
    takeaway,
    coverage: coverage || undefined,
  }
}

// ---------------------------------------------------------------------------
// Miles by truck
// ---------------------------------------------------------------------------

export interface TruckMilesFigure {
  items: MilesBar[]
  takeaway: string | null
  coverage?: string
}

/**
 * The quarter's miles per truck, for the screen those miles are typed on.
 *
 * The question this answers is not "which truck ran furthest". It is "which
 * trip sheet is only half in the box" — and that one is invisible in a list of
 * totals, because 320 miles and 41,208 miles both read as a truck that has been
 * done. Side by side as bars, the truck somebody stopped entering is the short
 * one, and the truck nobody started is an empty slot rather than a zero.
 *
 * `unreadable` is the mileage read having failed. Every truck then comes back
 * as an unknown: "0 miles" against a truck with twelve jurisdictions on file is
 * an accusation, and the whole fleet would be wearing it.
 */
export function truckMilesFigure(args: {
  trucks: readonly { id: string; label: string; href: string }[]
  rows: readonly { vehicleId: string | null; miles: number }[]
  unreadable: boolean
}): TruckMilesFigure {
  const { trucks, rows, unreadable } = args

  let unentered = 0
  const items: MilesBar[] = trucks.map((truck) => {
    const mine = rows.filter((r) => r.vehicleId === truck.id)
    // At least one ROW, not at least one mile. A trip sheet typed as zeroes is
    // a truck somebody has been through; a truck with no rows is one nobody has
    // opened yet, and those are different answers.
    const entered = !unreadable && mine.length > 0
    if (!unreadable && !entered) unentered++
    return {
      label: truck.label,
      value: entered ? mine.reduce((n, r) => n + r.miles, 0) : null,
      display: unreadable
        ? '—'
        : entered
          ? compactNumber(mine.reduce((n, r) => n + r.miles, 0))
          : 'nothing entered',
      note: entered
        ? undefined
        : unreadable
          ? undefined
          : 'No jurisdictions on file for this truck this quarter.',
      href: truck.href,
    }
  })
  items.sort((a, b) => (b.value ?? -1) - (a.value ?? -1))

  const orphanMiles = rows.filter((r) => r.vehicleId === null).reduce((n, r) => n + r.miles, 0)
  const reporting = trucks.length - unentered
  const total = rows.reduce((n, r) => n + r.miles, 0)

  const takeaway = unreadable
    ? null
    : trucks.length === 0
      ? null
      : `${reporting === trucks.length ? `All ${trucks.length}` : `${reporting} of ${trucks.length}`} ${trucks.length === 1 ? 'truck has' : 'trucks have'} miles entered for this quarter, ${compactNumber(total)} in total.`

  const clauses: string[] = []
  if (unreadable) {
    clauses.push(
      'The miles already recorded could not be read, so nothing drawn here is a measurement. ' +
        'Reload before typing.',
    )
  } else if (unentered > 0) {
    clauses.push(
      `${unentered} ${unentered === 1 ? 'truck has' : 'trucks have'} nothing entered for this quarter, drawn as an empty slot rather than at zero — a truck with no trip sheet on file has not run nothing, it has not been typed in. A return filed now is short by whatever ${unentered === 1 ? 'it' : 'they'} ran.`,
    )
  }
  if (orphanMiles > 0) {
    clauses.push(
      `${compactNumber(orphanMiles)} miles this quarter are recorded against no truck, so they are on none of these bars — but they do count on the return.`,
    )
  }

  return { items, takeaway, coverage: clauses.join(' ') || undefined }
}

// ---------------------------------------------------------------------------
// Net tax by jurisdiction
// ---------------------------------------------------------------------------

export interface NetTaxRow {
  label: string
  /**
   * Signed cents. Negative is money coming back. `null` for a jurisdiction with
   * no rate on file — it stays ON the chart, drawn as an unknown spanning the
   * centre line, because the centre line means "settled" and a state we cannot
   * price has not been found to owe nothing. Dropping it left the prose under
   * the chart as the only trace of a jurisdiction he still has to file for.
   */
  value: number | null
  display: string
}

export interface NetTaxFigure {
  /** Empty whenever `refusal` is set. */
  items: NetTaxRow[]
  /** Why there is no honest chart. A caller MUST NOT render one when this is set. */
  refusal: string | null
  takeaway: string | null
  coverage?: string
}

/**
 * The half-entered states in which there is no net figure to draw at all.
 *
 * These are refusals rather than caveats, and the difference matters. A caveat
 * sits under the chart and is read second; the shape is read first and in about
 * a second. A quarter with fuel and no miles drawn as a diverging chart is a
 * full green bar for every jurisdiction — a refund, announced — and no sentence
 * printed underneath takes that back.
 */
function refuseNetTax(result: QuarterlyReturn): string | null {
  if (result.totalMiles === 0 && result.totalGallonsMilli === 0) {
    return 'Nothing is recorded for this quarter yet, so there is no net figure to draw.'
  }
  if (result.totalMiles === 0) {
    return (
      'Fuel is recorded for this quarter and no miles are. Every jurisdiction would draw as a ' +
      'pure credit, which claims money back that is not owed.'
    )
  }
  // Covers miles-with-no-fuel as well: with no gallons there is no average, and
  // with no average every taxable-gallon figure on the return multiplies out to
  // nothing. A return nobody can compute is not a return that owes nothing.
  if (result.mpgCentis === 0) {
    return (
      'No fleet average can be derived from the miles and gallons on file, so every jurisdiction ' +
      'would price at nothing.'
    )
  }
  return null
}

/**
 * The quarter as money running both ways from a centre line.
 *
 * Only the priced jurisdictions are on it. One with no rate has no signed
 * figure to place, and the centre line is where "settled" lives — so it is
 * removed and named in `coverage` instead, by code, because "3 jurisdictions
 * are missing a rate" is a sentence nobody can act on.
 */
export function netTaxFigure(args: {
  result: QuarterlyReturn
  trucks: TruckCoverage | null
  open: boolean
}): NetTaxFigure {
  const { result, trucks, open } = args

  const refusal = refuseNetTax(result)
  if (refusal) return { items: [], refusal, takeaway: null }

  const priced: NetTaxRow[] = []
  const unpriced: NetTaxRow[] = []
  for (const line of result.lines) {
    if (line.outcome.kind === 'rate_unknown') {
      unpriced.push({ label: line.jurisdiction, value: null, display: 'no rate on file' })
      continue
    }
    if (line.outcome.kind !== 'computed') continue
    const cents = line.outcome.netCents
    priced.push({
      label: line.jurisdiction,
      value: cents,
      // Parentheses for a credit, exactly as the table under this chart writes
      // it. Two notations for one fact on one screen is one of them being
      // misread.
      display: cents < 0 ? `(${formatCents(-cents)})` : formatCents(cents),
    })
  }
  // Biggest bill first, biggest credit last, so the axis reads top to bottom in
  // the same direction it reads left to right. The unpriced ones sort after all
  // of them: they have no position on the axis to earn, and interleaving them
  // would break the one ordering the chart promises.
  priced.sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const items: NetTaxRow[] = [...priced, ...unpriced]

  if (priced.length === 0) {
    return {
      items: [],
      refusal:
        'No jurisdiction on this return has a tax rate on file, so there is no net figure to draw.',
      takeaway: null,
    }
  }

  const owed = priced.filter((i) => (i.value ?? 0) > 0)
  const credit = priced.filter((i) => (i.value ?? 0) < 0)
  const largestCredit = credit.length > 0 ? credit[credit.length - 1] : null
  const takeaway =
    owed.length > 0 && credit.length > 0
      ? `${owed.length} ${owed.length === 1 ? 'jurisdiction is' : 'jurisdictions are'} billing you and ${credit.length} ${credit.length === 1 ? 'owes' : 'owe'} you back. The largest line either way is ${owed[0].label} at ${owed[0].display}.`
      : owed.length > 0
        ? `Every priced jurisdiction is billing you this quarter; the largest is ${owed[0].label} at ${owed[0].display}.`
        : largestCredit
          ? `Every priced jurisdiction owes you back this quarter; the largest is ${largestCredit.label} at ${largestCredit.display}.`
          : 'Every priced jurisdiction comes out at nothing this quarter.'

  const shortfall = truckShortfall(trucks)
  const clauses: string[] = []

  if (result.missingRates.length > 0) {
    const n = result.missingRates.length
    clauses.push(
      `${result.missingRates.join(', ')} ${n === 1 ? 'has' : 'have'} no tax rate on file, so ${n === 1 ? 'it is' : 'they are'} drawn unpriced rather than at nothing — a jurisdiction with no rate is not a jurisdiction with no tax. ${n === 1 ? 'Its' : 'Their'} miles are in the table below.`,
    )
  }
  if (shortfall) {
    clauses.push(
      shortfall.partial
        ? // Spelled out rather than left implied. Every figure on this chart is
          // derived from the miles, so a fleet that is two trucks short is a
          // chart on which every single bar is too short at once — which looks
          // exactly like a quiet quarter.
          `${shortfall.text} Every figure here is derived from those miles, so each bar is a floor rather than a total.`
        : shortfall.text,
    )
  }
  if (open) clauses.push('The quarter is still being entered, so these figures will move.')

  return { items, refusal: null, takeaway, coverage: clauses.join(' ') || undefined }
}

// ---------------------------------------------------------------------------
// Fleet MPG across quarters
// ---------------------------------------------------------------------------

export interface QuarterTotals {
  periodStart: Date
  totalMiles: number
  totalGallonsMilli: number
}

export interface MpgColumn {
  key: string
  label: string
  /** Hundredths of a mile per gallon, or `null` when no average can be derived. */
  value: Value
  display: string
  tone?: Tone
  /** True while the quarter is still being entered. */
  open: boolean
  totalMiles: number
}

export interface MpgTrend {
  columns: MpgColumn[]
  /** Quarters with a derivable average. Fewer than two is not a trend. */
  known: number
  /** The sentence under the chart, or null when no honest comparison exists. */
  takeaway: string | null
  coverage?: string
}

/**
 * Fleet miles and gallons per quarter, bucketed onto a CONSECUTIVE list of
 * quarters rather than onto the quarters that happen to appear in the rows.
 *
 * An axis assembled from the data deletes the quiet quarters, so a carrier who
 * ran two quarters, sat out a third and ran a fourth sees four busy quarters in
 * a row. `recentQuarters()` is what the caller should be passing in here.
 */
export function quarterTotals(
  quarters: readonly Date[],
  miles: readonly { periodStart: string; miles: number }[],
  fuel: readonly { purchasedOn: string; gallonsMilli: number }[],
): QuarterTotals[] {
  return quarters.map((q) => {
    const from = isoDay(q)
    const to = isoDay(nextQuarterStart(q))
    return {
      periodStart: q,
      // `period_start` IS a quarter's first day, so this is an exact match and
      // not a range. A mileage row dated anywhere else is not a quarter summary
      // and must not be folded into one.
      totalMiles: miles.filter((m) => m.periodStart === from).reduce((n, m) => n + m.miles, 0),
      // Half-open, and on strings — ISO dates compare correctly as text, so
      // nothing here has to work out that September has thirty days.
      totalGallonsMilli: fuel
        .filter((f) => f.purchasedOn >= from && f.purchasedOn < to)
        .reduce((n, f) => n + f.gallonsMilli, 0),
    }
  })
}

/**
 * Fleet MPG quarter by quarter — the number every other IFTA figure is built on.
 *
 * Taxable gallons are never measured. They are the miles run in a jurisdiction
 * divided by this one figure, so an MPG drifting down a quarter at a time
 * raises the tax on every line of every future return at once. It is the single
 * most useful number a small carrier can watch, and it is invisible as four
 * separate quarterly screens.
 *
 * `quarters` must be oldest-first: that is the order the axis is drawn in.
 */
export function mpgTrend(quarters: readonly QuarterTotals[], today: Date): MpgTrend {
  const columns: MpgColumn[] = quarters.map((q) => {
    const open = quarterStillOpen(q.periodStart, today)
    // `fleetMpgCentis` answers 0 for a quarter with no gallons, and 0 on an
    // axis of real averages draws as a column of no height — a quarter in which
    // the fleet apparently managed nothing per gallon. A quarter missing either
    // input has no average AT ALL, and that is null, which draws as the dashed
    // empty slot that says so.
    const centis =
      q.totalMiles > 0 && q.totalGallonsMilli > 0
        ? fleetMpgCentis(q.totalMiles, q.totalGallonsMilli)
        : 0
    const value = centis > 0 ? centis : null
    return {
      key: isoDay(q.periodStart),
      label: quarterLabel(q.periodStart),
      value,
      display: value === null ? '—' : mpg(value),
      // The open quarter is drawn neutral rather than in the brand tone. Its
      // height is real but its meaning is not settled, and a column the same
      // colour as the finished ones invites the comparison that cannot be made
      // yet.
      tone: open ? 'neutral' : 'brand',
      open,
      totalMiles: q.totalMiles,
    }
  })

  const known = columns.filter((c) => c.value !== null).length

  // THE COMPARISON IS BETWEEN CLOSED QUARTERS ONLY. A quarter still being
  // entered can hold all its miles and half its receipts, which prints a fleet
  // average well above anything the trucks did; announcing that as an
  // improvement is the chart telling the owner his fuel economy got better
  // because his bookkeeping got worse.
  const closed = columns.filter(
    (c): c is MpgColumn & { value: number } => !c.open && c.value !== null,
  )
  const takeaway =
    closed.length >= 2 ? mpgSentence(closed[closed.length - 2], closed[closed.length - 1]) : null

  const missing = columns.filter((c) => c.value === null).map((c) => c.label)
  const live = columns.filter((c) => c.open && c.value !== null).map((c) => c.label)
  const clauses: string[] = []
  if (missing.length > 0) {
    clauses.push(
      `No average can be drawn for ${missing.join(', ')} — a quarter needs both miles and fuel on file before it has one.`,
    )
  }
  if (live.length > 0) {
    clauses.push(
      `${live.join(', ')} ${live.length === 1 ? 'is' : 'are'} still being entered, so ${live.length === 1 ? 'that average' : 'those averages'} will move.`,
    )
  }

  return { columns, known, takeaway, coverage: clauses.join(' ') || undefined }
}

/** Two closed quarters, and what the difference between them costs on the return. */
function mpgSentence(
  earlier: MpgColumn & { value: number },
  later: MpgColumn & { value: number },
): string {
  const delta = later.value - earlier.value
  // Five hundredths of a mile per gallon is arithmetic, not a trend. Calling it
  // one teaches the owner to ignore this sentence by the time it means
  // something.
  if (Math.abs(delta) < 5) {
    return `${later.label} held at ${mpg(later.value)} mpg, level with ${earlier.label}.`
  }

  // The same arithmetic `quarterlyReturn()` uses for taxable gallons, run twice
  // over the LATER quarter's miles: what those miles cost at each average. That
  // difference is the whole point of watching this number — a lower average is
  // more taxable gallons on every jurisdiction of every return.
  const atNow = Math.round((later.totalMiles * 100 * 1000) / later.value)
  const atThen = Math.round((later.totalMiles * 100 * 1000) / earlier.value)
  const swing = Math.abs(atNow - atThen) / 1000

  const direction = delta < 0 ? 'below' : 'above'
  const cost = delta < 0 ? 'more' : 'fewer'
  return `${later.label} came in at ${mpg(later.value)} mpg, ${mpg(Math.abs(delta))} ${direction} ${earlier.label}. Over ${later.label}’s ${compactNumber(later.totalMiles)} miles that is about ${compactNumber(swing)} ${cost} taxable gallons to report.`
}
