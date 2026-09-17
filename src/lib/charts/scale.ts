/**
 * The arithmetic behind every chart in this app, kept pure so it can be tested.
 *
 * A chart is a much more dangerous way to be wrong than a table is. A table
 * with a blank cell reads as a blank cell; a chart with a missing month reads
 * as a month in which nothing happened. The owner does not squint at a bar and
 * wonder about provenance — he takes the shape in whole, in about a second, and
 * acts on it. So the honesty rules the rest of this codebase applies to numbers
 * have to be applied harder here, and they live in this file:
 *
 * 1. `null` means WE DO NOT KNOW and is never, anywhere, rendered as zero.
 *    Every function below propagates it rather than coercing it. The components
 *    draw it as an empty slot that says so.
 *
 * 2. A real value never renders as an invisible bar. 3 miles against a 40,000
 *    mile maximum is 0.0075% of the width — nothing, indistinguishable from the
 *    jurisdiction he did not drive in at all. `MIN_VISIBLE_PERCENT` is the floor
 *    that keeps "small" from reading as "none".
 *
 * 3. Axes end on a round number the eye can divide, and the ceiling is chosen
 *    from a fine ladder. A coarse one (1, 2, 5, 10) turns a maximum of 101 into
 *    an axis of 200, so every bar on the chart sits in the left half and the
 *    whole thing reads as a quiet quarter.
 */

/** A quantity, or `null` for one we do not have. */
export type Value = number | null

/**
 * The smallest width a real, non-zero value is allowed to render at.
 *
 * Picked so a 1px-ish sliver becomes a visible ~3px on a 320px-wide phone
 * chart. Below this the distinction the whole chart exists to draw — between a
 * little and none — is carried by nothing the eye can resolve.
 */
export const MIN_VISIBLE_PERCENT = 1.5

/**
 * The ladder of acceptable axis ceilings within a decade.
 *
 * Deliberately finer than the textbook 1/2/5. With the coarse ladder a fleet
 * that ran 11,400 miles gets a 20,000-mile axis and looks half-idle; here it
 * gets 12,000 and looks like what it is.
 */
const STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

/**
 * Round a maximum up to a number a person can read off an axis.
 *
 * Returns 0 for an empty or nonsensical domain, and callers must treat that as
 * "there is no chart to draw" rather than dividing by it.
 */
export function niceCeiling(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0
  const pow = 10 ** Math.floor(Math.log10(max))
  const f = max / pow
  const step = STEPS.find((s) => f <= s + 1e-9) ?? 10
  // toPrecision because 1.2 * 100 is 120.00000000000001 in binary floating
  // point, and an axis labelled "120.00000000000001" is a bug report.
  return Number((step * pow).toPrecision(12))
}

/**
 * Evenly spaced axis ticks from 0 to `max` inclusive.
 *
 * `count` is the number of INTERVALS, so `ticks(100, 4)` gives five labels.
 * Only used on charts wide enough to carry them; a phone gets the value
 * printed on the bar instead, which needs no axis at all.
 */
export function ticks(max: number, count = 4): number[] {
  if (!(max > 0) || count < 1) return []
  return Array.from({ length: count + 1 }, (_, i) => Number(((max / count) * i).toPrecision(12)))
}

/**
 * How wide (or tall) a value draws, as a percentage of the plot.
 *
 * `null` in, `null` out — the caller MUST branch on it and draw the
 * we-do-not-know treatment. Returning 0 here instead would put a zero-height
 * column on the chart and there would be no way, downstream, to tell it from a
 * month that was genuinely empty.
 */
export function widthPercent(value: Value, max: number): number | null {
  if (value === null) return null
  if (!(max > 0)) return 0
  if (value <= 0) return 0
  return Math.max(MIN_VISIBLE_PERCENT, Math.min(100, (value / max) * 100))
}

/**
 * The ceiling for a set of values, ignoring the ones we do not have.
 *
 * Unknowns are skipped rather than counted as zero for the usual reason, but
 * note what that means: an axis built from three known months does not grow to
 * accommodate the two we are missing, and the chart's caption has to say so.
 * Scaling is not a place to be clever about absent data.
 */
export function ceilingFor(values: readonly Value[]): number {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v))
  if (known.length === 0) return 0
  return niceCeiling(Math.max(...known))
}

// ------------------------------------------------------------------ diverging

export interface DivergingRow {
  /** Fraction of the negative half this value fills, 0-100. */
  negative: number
  /** Fraction of the positive half this value fills, 0-100. */
  positive: number
  /** No figure. Neither half is filled and the component draws the absence. */
  unknown: boolean
}

/**
 * Lay out values that run in both directions from a centre line.
 *
 * IFTA is the case that demands it: a quarter is a list of jurisdictions you
 * owe and jurisdictions that owe you, and the useful question — "where is the
 * money actually going" — is invisible when both are drawn as positive bars of
 * a column headed "amount".
 *
 * BOTH halves share ONE scale, taken from the largest magnitude in either
 * direction. Scaling each half to its own maximum would draw a $40 credit the
 * same width as a $4,000 bill, which is the exact misreading the chart is
 * supposed to prevent.
 */
export function divergingRows(values: readonly Value[]): {
  max: number
  rows: DivergingRow[]
} {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v))
  const max = niceCeiling(Math.max(0, ...known.map((v) => Math.abs(v))))
  const rows = values.map((v) => {
    // A row we have no figure for sits at the centre line untouched, and the
    // centre line is exactly where 'settled' lives. IFTA is the case: a
    // jurisdiction whose tax rate we have not loaded is not a jurisdiction that
    // owes nothing, and dropping it off the chart entirely — the only option
    // before this — left the prose underneath as the sole trace of a state the
    // carrier still has to file for.
    if (v === null || !Number.isFinite(v)) return { negative: 0, positive: 0, unknown: true }
    const pct = widthPercent(Math.abs(v), max) ?? 0
    return v < 0
      ? { negative: pct, positive: 0, unknown: false }
      : { negative: 0, positive: v > 0 ? pct : 0, unknown: false }
  })
  return { max, rows }
}

// -------------------------------------------------------------------- buckets

/** A span of time on an axis. `end` is EXCLUSIVE. */
export interface Bucket {
  /** Stable identity, e.g. '2026-03' or '2026-03-09'. */
  key: string
  /** What the axis prints, e.g. 'Mar' or 'Mar 9'. */
  label: string
  start: Date
  end: Date
}

const MS_DAY = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad = (n: number) => String(n).padStart(2, '0')

/** UTC midnight of the same calendar day. Everything here is UTC, as elsewhere. */
export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * Consecutive calendar months covering `from`..`to` inclusive.
 *
 * CONSECUTIVE is the whole point. Building the axis from the months that
 * happen to appear in the data skips the empty ones, and a chart that reads
 * Jan, Feb, Apr, May puts the quiet March *behind* it and squeezes the gap out
 * of existence. The owner would be looking at a slow quarter drawn as a busy
 * one.
 */
export function monthBuckets(from: Date, to: Date): Bucket[] {
  const out: Bucket[] = []
  let y = from.getUTCFullYear()
  let m = from.getUTCMonth()
  const endY = to.getUTCFullYear()
  const endM = to.getUTCMonth()
  // 600 months is fifty years; the guard is here so a bad date range cannot
  // hang a request rather than because anyone will chart that long.
  for (let guard = 0; guard < 600; guard++) {
    const start = new Date(Date.UTC(y, m, 1))
    const end = new Date(Date.UTC(y, m + 1, 1))
    out.push({
      key: `${y}-${pad(m + 1)}`,
      // The year rides along in January so a 14-month axis does not read as
      // two of the same month with no way to tell which is which.
      label: m === 0 ? `${MONTHS[m]} ${String(y).slice(2)}` : MONTHS[m],
      start,
      end,
    })
    if (y > endY || (y === endY && m >= endM)) break
    m += 1
    if (m > 11) {
      m = 0
      y += 1
    }
  }
  return out
}

/** The Monday at or before `d`, at UTC midnight. */
export function weekStart(d: Date): Date {
  const day = utcDay(d)
  // getUTCDay: 0 is Sunday. Monday-based weeks because a fleet plans in them —
  // a deadline landing Saturday belongs with the week it ends, not the next.
  const shift = (day.getUTCDay() + 6) % 7
  return new Date(day.getTime() - shift * MS_DAY)
}

/** `count` consecutive Monday-to-Sunday weeks, starting with the one holding `from`. */
export function weekBuckets(from: Date, count: number): Bucket[] {
  const first = weekStart(from)
  return Array.from({ length: Math.max(0, count) }, (_, i) => {
    const start = new Date(first.getTime() + i * 7 * MS_DAY)
    const end = new Date(start.getTime() + 7 * MS_DAY)
    return {
      key: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`,
      label: `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}`,
      start,
      end,
    }
  })
}

/**
 * Drop each item into its bucket and reduce.
 *
 * An empty bucket comes back as `null`, NOT 0, and the distinction is the
 * reason this function exists rather than a one-line reduce at each call site.
 * "No loads were recorded in March" and "we hauled nothing in March" are
 * different claims: one is about the data, one is about the business. We only
 * ever have evidence for the first, so that is the only one we draw.
 *
 * A caller that genuinely wants zeroes — a count axis, where nothing recorded
 * really does mean none — passes `emptyIsZero`.
 */
export function bucketValues<T>(
  items: readonly T[],
  buckets: readonly Bucket[],
  dateOf: (item: T) => Date | null,
  amountOf: (item: T) => number = () => 1,
  emptyIsZero = false,
): Value[] {
  const sums = buckets.map(() => null as Value)
  for (const item of items) {
    const d = dateOf(item)
    if (!d || Number.isNaN(d.getTime())) continue
    const t = d.getTime()
    const i = buckets.findIndex((b) => t >= b.start.getTime() && t < b.end.getTime())
    if (i === -1) continue
    sums[i] = (sums[i] ?? 0) + amountOf(item)
  }
  return emptyIsZero ? sums.map((v) => v ?? 0) : sums
}

// ------------------------------------------------------------------ formatting

/* THE MONEY RULE, for this file and for every page that draws a chart.
 *
 * Any figure a person reads AS AN AMOUNT is written in full: thousands
 * separators and two decimal places, `$1,432.00`. Use `formatCents` from
 * src/lib/loads.ts — it is the one full-money formatter in the product, it
 * builds the string by integer division so it can be compared against a rate
 * confirmation digit by digit, and it renders an absent figure as '—' rather
 * than as '$0.00'.
 *
 * A figure is read AS AN AMOUNT whenever the reader could act on it, repeat it
 * on the phone, or check it against a cheque, an invoice or a settlement
 * statement. That is nearly everything: a value printed on or above a bar, a
 * total, a subtotal, a stat tile, a caption, a table cell, a per-driver or
 * per-customer figure, the number in a sentence under a chart.
 *
 * `compactMoney` is the ONE exception and it is narrow: an AXIS TICK — the mark
 * that says what full height on the plot is worth — MAY stay compact, and only
 * where the exact figure also appears in words somewhere on the same visual
 * (the column labels, the total line, the table directly under the chart). If a
 * reader cannot find the real number without leaving the picture, the axis does
 * not get to round either.
 *
 * WHY THE LINE IS DRAWN THERE. '$1.4k' is somewhere between $1,350 and $1,449 —
 * a hundred-dollar band printed as if it were a number. An owner reading it as
 * what a broker owes him, or as what he paid a driver, is reading a figure that
 * is wrong by more than most of the disputes this product exists to settle. An
 * axis tick is not that: nobody rings anybody about the height of a bar, and the
 * tick's whole job is to say roughly how big the picture is.
 */

/**
 * Money short enough to sit on a chart axis on a phone.
 *
 * AXIS TICKS ONLY. See THE MONEY RULE above: never a line item, never a total,
 * never a value label, never a figure in a sentence. The exact cents live in
 * `formatCents`.
 */
export function compactMoney(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const d = Math.abs(cents) / 100
  if (d >= 1_000_000) return `${sign}$${(d / 1_000_000).toFixed(d >= 10_000_000 ? 0 : 1)}m`
  if (d >= 10_000) return `${sign}$${Math.round(d / 1000)}k`
  if (d >= 1_000) return `${sign}$${(d / 1000).toFixed(1)}k`
  return `${sign}$${Math.round(d)}`
}

/** Whole numbers with thousands separators: 41,208. */
export function compactNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}
