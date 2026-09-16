/**
 * Motive (formerly KeepTruckin).
 *
 * ⚠️ THE REQUEST AND RESPONSE SHAPES BELOW ARE UNVERIFIED.
 *
 * Nobody has run this against the real API. Motive's HOS endpoints need a
 * partner API key that this project does not have, and writing an adapter that
 * LOOKS tested is worse than writing none — the first person to connect an
 * account would trust numbers nobody has ever seen.
 *
 * So: the field mapping is marked, the parse is defensive, and anything it does
 * not recognise becomes `error` rather than a plausible-looking snapshot. When a
 * key exists, run it against one real driver and check every field against what
 * the Motive dashboard shows for that same driver at that same moment, before
 * this is allowed anywhere near the dispatch screen.
 *
 * Chosen first among the vendors because its API key is self-serve and it has a
 * test mode — the others need a partner agreement before you can see a response
 * at all.
 */
import type { DutyStatus, EldProvider, HoursResult } from './types.ts'

const BASE = 'https://api.gomotive.com/v1'

/** UNVERIFIED: Motive's duty-status vocabulary, mapped to ours. */
function toDutyStatus(raw: unknown): DutyStatus {
  switch (String(raw)) {
    case 'off_duty':
      return 'off_duty'
    case 'sleeper':
    case 'sleeper_berth':
      return 'sleeper'
    case 'driving':
      return 'driving'
    case 'on_duty':
    case 'on_duty_not_driving':
      return 'on_duty_not_driving'
    default:
      return 'unknown'
  }
}

/** Seconds to whole minutes, refusing anything that is not a number. */
function minutes(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.round(n / 60)) : null
}

export function motiveProvider(apiKey: string): EldProvider {
  return {
    name: 'Motive',
    async hoursFor(driverExternalId: string): Promise<HoursResult> {
      if (!apiKey) {
        return { state: 'unavailable', reason: 'No Motive API key is configured.' }
      }
      try {
        const res = await fetch(
          `${BASE}/hours_of_service?driver_ids=${encodeURIComponent(driverExternalId)}`,
          {
            headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
            signal: AbortSignal.timeout(6000),
          },
        )
        if (!res.ok) return { state: 'error', message: `Motive returned ${res.status}` }

        const body = (await res.json()) as Record<string, unknown>
        // UNVERIFIED shape. Every field is probed rather than assumed, and a
        // miss produces `error` — never a snapshot with zeros in it, which
        // would read as "this driver is out of hours".
        const row = Array.isArray(body.hours_of_service)
          ? (body.hours_of_service[0] as Record<string, unknown> | undefined)
          : undefined
        if (!row) return { state: 'error', message: 'Motive response had no HOS record' }

        const drive = minutes(row.drive_time_remaining)
        const shift = minutes(row.shift_time_remaining)
        const cycle = minutes(row.cycle_time_remaining)
        if (drive === null || shift === null || cycle === null) {
          return {
            state: 'error',
            message: 'Motive response did not carry the three clocks in the expected form',
          }
        }

        return {
          state: 'ok',
          snapshot: {
            driverId: driverExternalId,
            driveMinutesRemaining: drive,
            shiftMinutesRemaining: shift,
            cycleMinutesRemaining: cycle,
            minutesUntilBreak: minutes(row.time_until_break),
            status: toDutyStatus(row.duty_status),
            observedAt: row.updated_at ? new Date(String(row.updated_at)) : new Date(),
          },
        }
      } catch (e) {
        return { state: 'error', message: e instanceof Error ? e.message : 'Motive unreachable' }
      }
    },
  }
}
