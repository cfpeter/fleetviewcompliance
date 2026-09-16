/**
 * Date arithmetic for deadlines.
 *
 * Deadlines are DATES, not instants. Everything here works in UTC midnight and
 * nothing here consults the local clock — a deadline must not move because the
 * office manager opened the page from a hotel in another timezone.
 */

export function utcDate(y: number, m1to12: number, day: number): Date {
  return new Date(Date.UTC(y, m1to12 - 1, day))
}

export function lastDayOfMonth(y: number, m1to12: number): Date {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m1to12, 0))
}

/**
 * Add months, clamping BACKWARD when the target month is shorter.
 *
 * 31 January + 1 month is 28 February, never 3 March. Most date libraries roll
 * forward, which moves a deadline LATER — the one direction this domain refuses.
 * A compliance date that drifts later is a compliance date that is silently
 * wrong in the dangerous direction.
 */
export function addMonthsClamped(d: Date, months: number): Date {
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const day = d.getUTCDate()

  const targetMonthStart = new Date(Date.UTC(y, m + months, 1))
  const ty = targetMonthStart.getUTCFullYear()
  const tm = targetMonthStart.getUTCMonth()
  const daysInTarget = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate()

  return new Date(Date.UTC(ty, tm, Math.min(day, daysInTarget)))
}

/** Whole days from a to b. Both are UTC midnights, so no rounding surprises. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

/** Strips any time component, so a `new Date()` can be compared with a deadline. */
export function toUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** Exact days. No clamping needed — a day is always a day. */
export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000)
}
