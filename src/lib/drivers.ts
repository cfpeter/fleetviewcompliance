/**
 * Shared bits for the drivers section.
 *
 * `formatDate`, `formText` and `formDate` are not driver-specific and will move
 * out the moment the vehicles pages need them. Creating that module today, with
 * one caller, would be a guess about what the second caller wants.
 */

/**
 * A `date` column comes back as 'YYYY-MM-DD'. `new Date('2026-09-15')` is parsed
 * as UTC midnight, and formatting that in California time renders 14 September —
 * every date in the product one day early, on screens whose entire job is dates.
 * Pinning the formatter to UTC is what stops it, and it is why no code here ever
 * hands a bare date string to the default Date formatting.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Today, in the carrier's own day, as 'YYYY-MM-DD' for a date input's `max`.
 *
 * UTC would be wrong in the expensive direction: after 5pm Pacific it is already
 * tomorrow in UTC, so `max` would accept a future date, and a "last done" anchor
 * dated in the future makes the engine walk past the occurrence she just entered
 * and report the one after — a deadline silently moved later.
 *
 * The zone is hard-coded because every carrier we sell to is in California and
 * `carriers.timezone` defaults to it. The first out-of-state carrier turns this
 * into a bug, and the fix is to read that column rather than to widen this.
 */
export function todayInCalifornia(): string {
  // 'en-CA' formats as YYYY-MM-DD, which is what an <input type="date"> wants.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
}

export function fullName(d: { first_name: string; last_name: string }): string {
  return `${d.first_name} ${d.last_name}`.trim()
}

/**
 * A text input that was left alone posts as '', and '' in `cdl_number` is not
 * the same fact as "we do not have it" — it sorts as a value, matches a search
 * for nothing, and reads as answered. Absence is stored as NULL, once, here.
 */
export function formText(form: FormData, name: string): string | null {
  const value = String(form.get(name) ?? '').trim()
  return value === '' ? null : value
}

/**
 * The same for dates, and here it is not a nicety: Postgres rejects '' for a
 * `date` column outright, so one untouched optional field made the whole save
 * fail with "invalid input syntax for type date" — an error naming a type, about
 * a field she left blank on purpose, that loses everything else she typed.
 */
export function formDate(form: FormData, name: string): string | null {
  const value = String(form.get(name) ?? '').trim()
  return value === '' ? null : value
}

/**
 * The `driver_status` enum from 0002_fleet.sql, written out.
 *
 * Named so src/lib/fleet/active.ts can state the one rule about who is watched
 * without either importing a page or widening to `string` — which is what it had
 * to do before, and `string` is how 'Terminated' and 'terminated' end up being
 * two different answers to one question.
 */
export type DriverStatus = 'active' | 'inactive' | 'terminated'

export const DRIVER_STATUSES: readonly { value: DriverStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'terminated', label: 'Terminated' },
]

export function isDriverStatus(value: string): value is DriverStatus {
  return DRIVER_STATUSES.some((s) => s.value === value)
}

/**
 * Terminated is grey, not red.
 *
 * Red is the loudest colour on the page and this product spends it on overdue
 * compliance. A driver who left is the most ordinary event in a fleet; painting
 * it as an alarm is how the colour stops meaning anything by the second week.
 */
export function statusPillClass(status: string): string {
  switch (status) {
    case 'active':
      return 'badge badge-success'
    case 'inactive':
      return 'badge badge-neutral'
    default:
      return 'badge badge-neutral'
  }
}

/**
 * Codes, not names, because that is what is printed on the licence in front of
 * her. A free-text box here collects 'CA', 'Ca', 'Cali' and 'California' for the
 * same state, and every one of them breaks the MVR-per-licensing-state rule the
 * day we start using this field for anything.
 */
export const US_STATE_CODES: readonly string[] = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DC',
  'DE',
  'FL',
  'GA',
  'HI',
  'IA',
  'ID',
  'IL',
  'IN',
  'KS',
  'KY',
  'LA',
  'MA',
  'MD',
  'ME',
  'MI',
  'MN',
  'MO',
  'MS',
  'MT',
  'NC',
  'ND',
  'NE',
  'NH',
  'NJ',
  'NM',
  'NV',
  'NY',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VA',
  'VT',
  'WA',
  'WI',
  'WV',
  'WY',
]
