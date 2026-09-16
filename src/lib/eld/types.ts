/**
 * Hours of service, read from whatever ELD the carrier already has.
 *
 * We are not building an ELD and never will: it is a regulated device, and every
 * customer already pays for one. We read from it, and we read exactly four
 * things — the four that answer the single question dispatch needs:
 *
 *     can this driver legally finish this run before we commit to the shipper?
 *
 * Anything beyond those four is somebody else's product.
 */

export type DutyStatus = 'off_duty' | 'sleeper' | 'driving' | 'on_duty_not_driving' | 'unknown'

export interface HoursSnapshot {
  driverId: string
  /** Minutes of drive time left today under the 11-hour rule. */
  driveMinutesRemaining: number
  /** Minutes left in the 14-hour window. */
  shiftMinutesRemaining: number
  /** Minutes until a 30-minute break is required. Null when none is pending. */
  minutesUntilBreak: number | null
  /** Minutes left in the 60/70-hour cycle. */
  cycleMinutesRemaining: number
  status: DutyStatus
  /** When the ELD says this was true. Stale data is worse than none. */
  observedAt: Date
}

/**
 * Every read is three-state, for the same reason every federal read is.
 *
 * `unavailable` is not an error and not zero hours — it is "we did not ask" or
 * "nobody has connected an ELD". A dispatcher told "0 minutes remaining" when we
 * simply cannot see the device will either park a driver who was fine or, far
 * worse, learn to ignore the number.
 */
export type HoursResult =
  | { state: 'ok'; snapshot: HoursSnapshot }
  | { state: 'unavailable'; reason: string }
  | { state: 'error'; message: string }

export interface EldProvider {
  /** Shown in the UI so the owner knows which device this came from. */
  readonly name: string
  hoursFor(driverExternalId: string): Promise<HoursResult>
}

/**
 * What a carrier with no ELD connection gets.
 *
 * It exists so that every call site has a provider and none of them has to
 * branch on "is one configured" — and so the honest answer travels all the way
 * to the screen instead of being invented near it.
 */
export const notConnected: EldProvider = {
  name: 'No ELD connected',
  hoursFor: async () => ({
    state: 'unavailable',
    reason: 'No ELD is connected to this account.',
  }),
}

/** Minutes to "4h 25m", for a dispatcher reading it at a glance. */
export function humanMinutes(m: number): string {
  if (m <= 0) return 'none'
  const h = Math.floor(m / 60)
  const rem = m % 60
  return h > 0 ? `${h}h ${rem}m` : `${rem}m`
}

/**
 * Whether a snapshot is fresh enough to act on.
 *
 * An ELD that stopped reporting four hours ago is not telling you the driver has
 * four hours left; it is telling you nothing, and the number on screen is the
 * most dangerous kind of wrong — precise, plausible, and stale.
 */
export const STALE_AFTER_MINUTES = 30

export function isStale(s: HoursSnapshot, now = new Date()): boolean {
  return (now.getTime() - s.observedAt.getTime()) / 60_000 > STALE_AFTER_MINUTES
}

/**
 * Can this driver legally finish a run of the given length?
 *
 * Returns the three-valued answer rather than a boolean, because "we cannot see
 * his hours" must never collapse into "no" (which parks a legal driver) or
 * "yes" (which is the one that ends in a violation).
 */
export type Feasibility = 'yes' | 'no' | 'unknown'

export function canFinish(result: HoursResult, estimatedMinutes: number, now = new Date()): {
  verdict: Feasibility
  because: string
} {
  if (result.state !== 'ok') {
    return { verdict: 'unknown', because: result.state === 'error' ? result.message : result.reason }
  }
  if (isStale(result.snapshot, now)) {
    return {
      verdict: 'unknown',
      because: `The last reading is over ${STALE_AFTER_MINUTES} minutes old.`,
    }
  }

  const s = result.snapshot
  // The binding constraint is whichever clock runs out first. Reporting only the
  // drive clock is how a dispatcher gets surprised by the 14-hour window.
  const limit = Math.min(s.driveMinutesRemaining, s.shiftMinutesRemaining, s.cycleMinutesRemaining)
  if (estimatedMinutes <= limit) {
    return { verdict: 'yes', because: `${humanMinutes(limit)} available.` }
  }

  const which =
    limit === s.cycleMinutesRemaining
      ? 'the 60/70-hour cycle'
      : limit === s.shiftMinutesRemaining
        ? 'the 14-hour window'
        : 'drive time'
  return {
    verdict: 'no',
    because: `Needs ${humanMinutes(estimatedMinutes)} but only ${humanMinutes(limit)} left on ${which}.`,
  }
}
