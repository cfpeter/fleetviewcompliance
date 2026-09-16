/**
 * The MCS-150 biennial update deadline, computed from the USDOT number alone.
 *
 * This needs no API call, no account and no data from the carrier — which makes
 * it the one deadline we can show a stranger the instant they type their number.
 *
 * 49 CFR 390.19T(b)(2)-(3):
 *   month = the LAST digit of the USDOT number (0 means October, not December)
 *   year  = the NEXT-TO-LAST digit's parity; odd digit -> odd years, even -> even
 *
 * Missing it carries the penalties in 49 U.S.C. 521(b)(2)(B) / 14901(a) AND
 * deactivation of the USDOT number. "INACTIVE" on a carrier's federal record
 * means exactly this and nothing more sinister — worth saying plainly, because
 * owners read it as an accusation.
 */

/** 1 = January … 9 = September, and 0 = October. Not a modulo — a lookup. */
function filingMonth(dot: string): number {
  const last = Number(dot[dot.length - 1])
  return last === 0 ? 10 : last
}

/**
 * A one-digit USDOT number has no next-to-last digit. Treating the absent digit
 * as 0 (even) matches how FMCSA reads a zero-padded number.
 */
function filesInOddYears(dot: string): boolean {
  const nextToLast = dot.length >= 2 ? Number(dot[dot.length - 2]) : 0
  return nextToLast % 2 === 1
}

export interface Mcs150Schedule {
  month: number
  oddYears: boolean
  /** The next filing deadline at or after `from`. Always the last day of the month. */
  nextDue: Date
}

export function mcs150Schedule(dotNumber: string, from = new Date()): Mcs150Schedule {
  const dot = dotNumber.trim()
  const month = filingMonth(dot)
  const oddYears = filesInOddYears(dot)

  // Walk forward from this year to the next year of the right parity whose
  // filing month has not already passed.
  let year = from.getUTCFullYear()
  for (let i = 0; i < 4; i++) {
    const candidate = year + i
    if (candidate % 2 === (oddYears ? 1 : 0)) {
      // Last day of the filing month, in UTC. Anchoring at UTC midnight keeps a
      // deadline from sliding a day when the viewer is in another timezone.
      const end = new Date(Date.UTC(candidate, month, 0))
      if (end >= from) return { month, oddYears, nextDue: end }
    }
  }
  // Unreachable for any real date, but a total function beats a thrown error
  // on a marketing page.
  return { month, oddYears, nextDue: new Date(Date.UTC(year + 2, month, 0)) }
}

/**
 * Whether the carrier is actually current, given when they last filed.
 *
 * `nextDue` alone is a trap. A carrier who last filed in 2021 and whose filing
 * month is May has a "next due" of May 2028 — which reads as two years of slack
 * when in fact they have missed 2022, 2024 and 2026 and their USDOT number is
 * deactivated. The next future deadline is the wrong number to show alone.
 */
export type Mcs150State = 'current' | 'overdue' | 'unknown'

export interface Mcs150Status {
  state: Mcs150State
  /** The next filing deadline in the future. */
  nextDue: Date
  /** The most recent deadline already passed — what they are overdue against. */
  lastDue: Date
  month: number
  oddYears: boolean
}

export function mcs150Status(
  dotNumber: string,
  lastFiled: Date | null,
  from = new Date(),
): Mcs150Status {
  const { month, oddYears, nextDue } = mcs150Schedule(dotNumber, from)

  // Biennial, so the previous deadline is exactly two years before the next.
  const lastDue = new Date(Date.UTC(nextDue.getUTCFullYear() - 2, month, 0))

  // No filing date at all is NOT "current". We do not know, and the exposure is
  // the same as being overdue, so it must not render as reassurance.
  const state: Mcs150State =
    lastFiled === null ? 'unknown' : lastFiled >= lastDue ? 'current' : 'overdue'

  return { state, nextDue, lastDue, month, oddYears }
}
