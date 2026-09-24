/**
 * What the dates he has not answered could cost him, at the very most.
 *
 * THE OWNER ASKED FOR A TOTAL: "add the total price of the unpaid compliance…
 * show how much the owner will pay if they miss their fee." This is that
 * number, and almost all of the work in here is about the three ways it could
 * be a lie.
 *
 * IT IS A CEILING, NOT A FORECAST. Every figure in penalties.ts is the MAXIMUM
 * assessable under Appendix B. What is actually billed turns on enforcement
 * discretion, severity weighting and settlement, and is routinely a fraction of
 * it. So nothing here may be worded as "you will pay" — the words on the screen
 * are "the most they can fine you", and `counted` is published beside the
 * figure so it can be taken apart.
 *
 * IT MUST NEVER READ AS ZERO WHEN IT MEANS UNKNOWN. Of 52 rules, most carry no
 * line-item penalty — an expired medical card is an ACUTE finding and a parked
 * driver, not a fine. A fleet can therefore be in serious trouble and have
 * nothing at all to sum, which is exactly the case on the first carrier this
 * was run against: four overdue rows, not one dollar figure between them. So
 * `unpriced` is a first-class part of the answer, not a footnote, and a caller
 * that prints `ceilingCents` without it is printing "$0 at risk" over a fleet
 * whose drivers cannot legally drive.
 *
 * IT IS THE CARRIER'S MONEY ONLY. Appendix B sets $19,246 for the employer at
 * (a)(3) and $4,812 for the driver at (a)(4) for the same subject matter. A
 * total on the owner's dashboard that swept up the driver's side would bill him
 * for somebody else's penalty.
 */
import type { Standing } from './compute.ts'
import type { Penalty } from './penalties.ts'

/**
 * One row, reduced to the two things this calculation needs.
 *
 * Deliberately not `DeadlineItem`: the same reason `buildRunway` takes a
 * standing and a date and knows nothing about the shape the pages use. It keeps
 * this testable against four-line fixtures instead of a fleet.
 */
export interface ExposureInput {
  standing: Standing
  penalty?: readonly Penalty[]
}

export interface Exposure {
  /** Cents. The sum of the maximums for the rows that carry one. */
  ceilingCents: number
  /** How many rows contributed to that figure. */
  counted: number
  /**
   * How many at-risk rows carry no amount we can stand behind.
   *
   * THE MOST IMPORTANT FIELD IN HERE. Zero and unknown are different findings
   * and only one of them is good news.
   */
  unpriced: number
}

/**
 * Overdue and unknown, and nothing else.
 *
 * `unknown` counts for the same reason it sorts with overdue everywhere else in
 * this product: a date nobody has typed carries the same exposure as one that
 * has expired, and leaving it out would make a fleet that has answered nothing
 * look cheaper than one that has answered everything badly.
 *
 * `current` and `soon` do not count. A deadline that has not arrived is not an
 * exposure, and putting a price on a date he still has time to meet turns a
 * reminder into a threat.
 */
const AT_RISK: ReadonlySet<Standing> = new Set<Standing>(['overdue', 'unknown'])

/**
 * The most one row could cost.
 *
 * A per-day amount contributes its CAP, never its daily figure multiplied by
 * how long it has been overdue. Two reasons, and the second is the real one:
 * the cap is what Appendix B says the daily accrual stops at, so the cap IS the
 * maximum; and a number that grows every night is a number that would have the
 * dashboard quoting a different, larger figure every morning for a row nobody
 * has touched. That is a scoreboard, not a fact.
 */
function ceilingFor(p: Penalty): number {
  return p.unit === 'per_day' ? (p.capCents ?? p.maxCents) : p.maxCents
}

/**
 * The carrier's own exposure across a set of rows.
 *
 * Where a rule carries several amounts — the employer side and the driver side
 * of one obligation — only the carrier's is taken, and the largest of them, so
 * the answer stays a ceiling.
 */
export function exposure(rows: readonly ExposureInput[]): Exposure {
  let ceilingCents = 0
  let counted = 0
  let unpriced = 0

  for (const row of rows) {
    if (!AT_RISK.has(row.standing)) continue

    const carrierAmounts = (row.penalty ?? []).filter((p) => p.payer === 'carrier')
    if (carrierAmounts.length === 0) {
      unpriced++
      continue
    }

    ceilingCents += Math.max(...carrierAmounts.map(ceilingFor))
    counted++
  }

  return { ceilingCents, counted, unpriced }
}
