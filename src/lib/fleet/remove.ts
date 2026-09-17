/**
 * Deleting a truck or a driver, and the reason it is usually refused.
 *
 * THE NEED IS REAL. A unit number typed twice, a VIN that turned out to belong
 * to the tractor already on the list, a row somebody made while learning the
 * screen. Those have no history worth keeping and leaving them on the fleet
 * forever means an owner who cannot trust his own count — and, after
 * src/lib/fleet/active.ts, a bill with a phantom truck on it.
 *
 * THE TRAP IS ALSO REAL, AND IT IS BIGGER. A driver row is the spine of a
 * qualification file, and 49 CFR 391.51(c) requires that file be kept for as
 * long as the driver is employed plus three years. 0003_documents.sql is
 * append-only for exactly that reason and 0005_compliance_records.sql supersedes
 * rather than overwrites for the same one. Neither table has a DELETE grant at
 * all. A delete button that quietly emptied them would be the one feature in
 * this product that creates liability instead of removing it.
 *
 * WHAT THE DATABASE ACTUALLY DOES IF YOU DELETE A ROW, which is why this check
 * has to exist in front of it:
 *
 *   documents, compliance_records   NO foreign key at all. They point at a
 *                                   subject through (subject_type, subject_id),
 *                                   so the delete SUCCEEDS and leaves evidence
 *                                   pointing at a driver who no longer has a
 *                                   name. Worse than a cascade, because nothing
 *                                   errors and the loss is invisible.
 *   load_assignments                ON DELETE SET NULL. The load survives; who
 *                                   drove it and what pulled it become blank.
 *   fuel_purchases, jurisdiction_miles
 *                                   ON DELETE SET NULL. IFTA receipts are kept
 *                                   four years and the return is computed per
 *                                   unit; a null vehicle cannot be reconstructed.
 *   pay_agreements                  ON DELETE CASCADE. The rate the driver was
 *                                   promised, gone.
 *   settlements                     ON DELETE RESTRICT since 0018, which caught
 *                                   this exact bug once already — a cascade
 *                                   destroyed a paid settlement and the lock
 *                                   trigger fell through because the parent row
 *                                   was already gone.
 *   reminders                       ON DELETE CASCADE, and that one is correct.
 *                                   See `remindersLine` below.
 *
 * So: DELETE IS ALLOWED ONLY WHEN THERE IS NOTHING TO PRESERVE, and the refusal
 * has to end in the thing the owner actually wanted. Marking the row not-active
 * takes it off the reminders and off the bill, which is what "remove it" meant
 * every time except the mistyped row. A dead end that does not say the way out
 * is just a broken button.
 *
 * 0028_fleet_delete_guard.sql enforces the same list in the database, because
 * this check runs before a DELETE that PostgREST would otherwise accept on its
 * own.
 *
 * COPY RULE. Every sentence here is read by small-fleet owners in Los Angeles,
 * many of whom read English as a second language. Short. Direct. Say what to do.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** The two things this module knows how to refuse to delete. */
export type FleetSubject = 'vehicle' | 'driver'

/**
 * One kind of history a row can be carrying, and the words for it.
 *
 * The words live next to the query that counts them so the refusal can never
 * name something we did not actually look for.
 */
export interface HistoryKind {
  key: string
  /** Reads after a number: "1 compliance date". */
  one: string
  many: string
}

export interface HistoryCount {
  kind: HistoryKind
  count: number
}

/** What a row is holding, as read out of the database. */
export interface HistoryReport {
  counts: HistoryCount[]
  /**
   * Reminders about this row. NOT a blocker, and named in the confirmation
   * instead. 0023_custom_reminders.sql settled this: a reminder is the owner's
   * private to-do list, nobody will ever ask him to prove when he called his
   * insurance broker, and the migration chose CASCADE on purpose so a reminder
   * about a truck that is gone does not silently re-label itself as a
   * company-wide one. Losing it is the honest outcome — but he is told first.
   */
  reminders: number
  /**
   * A count we could not read is not a count of zero.
   *
   * One failed query used to be the difference between "nothing on file" and
   * "we could not look", and only one of those is safe to delete on.
   */
  unreadable: boolean
}

// ---------------------------------------------------------------- the kinds

const DATES: HistoryKind = { key: 'dates', one: 'compliance date', many: 'compliance dates' }
const DOCS: HistoryKind = { key: 'documents', one: 'file', many: 'files' }
const LOADS: HistoryKind = { key: 'loads', one: 'load', many: 'loads' }
const FUEL: HistoryKind = { key: 'fuel', one: 'fuel receipt', many: 'fuel receipts' }
const MILES: HistoryKind = { key: 'miles', one: 'IFTA mileage row', many: 'IFTA mileage rows' }
const SETTLEMENTS: HistoryKind = { key: 'settlements', one: 'settlement', many: 'settlements' }
const PAY: HistoryKind = { key: 'pay', one: 'pay agreement', many: 'pay agreements' }

export const VEHICLE_HISTORY_KINDS: readonly HistoryKind[] = [DATES, DOCS, LOADS, FUEL, MILES]
export const DRIVER_HISTORY_KINDS: readonly HistoryKind[] = [DATES, DOCS, LOADS, SETTLEMENTS, PAY]

// ---------------------------------------------------------------- reading it

/** `select('id', { count: 'exact', head: true })` in one line, counted safely. */
type Counter = () => PromiseLike<{ count: number | null; error: unknown }>

async function tally(
  pairs: readonly { kind: HistoryKind; run: Counter }[],
): Promise<{ counts: HistoryCount[]; unreadable: boolean }> {
  const results = await Promise.all(pairs.map((p) => p.run()))
  let unreadable = false
  const counts: HistoryCount[] = []
  for (let i = 0; i < pairs.length; i++) {
    const r = results[i]
    if (r.error || r.count === null) unreadable = true
    counts.push({ kind: pairs[i].kind, count: r.count ?? 0 })
  }
  return { counts, unreadable }
}

/**
 * Everything a vehicle is carrying.
 *
 * No carrier_id filters: RLS scopes all of these to the signed-in user's
 * carrier, and the row itself was already proven to be his by the page that
 * loaded it. A filter here would say in code that we do not quite trust the
 * policy, which is the sentence that eventually justifies a service-role client.
 */
export async function vehicleHistory(
  supabase: SupabaseClient,
  vehicleId: string,
): Promise<HistoryReport> {
  const head = (table: string) => supabase.from(table).select('id', { count: 'exact', head: true })

  const [{ counts, unreadable }, reminders] = await Promise.all([
    tally([
      {
        kind: DATES,
        run: () =>
          head('compliance_records').eq('subject_type', 'vehicle').eq('subject_id', vehicleId),
      },
      {
        kind: DOCS,
        run: () => head('documents').eq('subject_type', 'vehicle').eq('subject_id', vehicleId),
      },
      {
        // Either end of a combination. A trailer id sitting in trailer_id is the
        // same loss as a tractor id in tractor_id: the load keeps its number and
        // forgets what was under it.
        kind: LOADS,
        run: () =>
          head('load_assignments').or(`tractor_id.eq.${vehicleId},trailer_id.eq.${vehicleId}`),
      },
      { kind: FUEL, run: () => head('fuel_purchases').eq('vehicle_id', vehicleId) },
      { kind: MILES, run: () => head('jurisdiction_miles').eq('vehicle_id', vehicleId) },
    ]),
    head('reminders').eq('vehicle_id', vehicleId),
  ])

  return { counts, reminders: reminders.count ?? 0, unreadable }
}

/** Everything a driver is carrying. Same reasoning, one different list. */
export async function driverHistory(
  supabase: SupabaseClient,
  driverId: string,
): Promise<HistoryReport> {
  const head = (table: string) => supabase.from(table).select('id', { count: 'exact', head: true })

  const [{ counts, unreadable }, reminders] = await Promise.all([
    tally([
      {
        kind: DATES,
        run: () =>
          head('compliance_records').eq('subject_type', 'driver').eq('subject_id', driverId),
      },
      {
        kind: DOCS,
        run: () => head('documents').eq('subject_type', 'driver').eq('subject_id', driverId),
      },
      {
        kind: LOADS,
        run: () =>
          head('load_assignments').or(`driver_id.eq.${driverId},co_driver_id.eq.${driverId}`),
      },
      { kind: SETTLEMENTS, run: () => head('settlements').eq('driver_id', driverId) },
      { kind: PAY, run: () => head('pay_agreements').eq('driver_id', driverId) },
    ]),
    head('reminders').eq('driver_id', driverId),
  ])

  return { counts, reminders: reminders.count ?? 0, unreadable }
}

// ---------------------------------------------------------------- the answer

/** True only when every count came back and every one of them is zero. */
export function canRemove(report: HistoryReport): boolean {
  return !report.unreadable && report.counts.every((c) => c.count === 0)
}

/** "3 compliance dates", "1 file" — only the ones that are actually there. */
export function heldLines(report: HistoryReport): string[] {
  return report.counts
    .filter((c) => c.count > 0)
    .map((c) => `${c.count} ${c.count === 1 ? c.kind.one : c.kind.many}`)
}

/** What the screen prints when the answer is no. */
export interface Refusal {
  title: string
  /** The things on file, one per line, so he can see what he would have lost. */
  held: string[]
  why: string
  instead: string
}

const NOUN: Record<FleetSubject, string> = { vehicle: 'truck', driver: 'driver' }

/**
 * The refusal, or null when the row really can go.
 *
 * `name` is the unit number or the driver's name, and it is in the first
 * sentence on purpose: a refusal that does not say which row it is about is a
 * refusal an owner reads twice.
 */
export function refusalFor(
  subject: FleetSubject,
  name: string,
  report: HistoryReport,
): Refusal | null {
  if (canRemove(report)) return null

  if (report.unreadable) {
    return {
      title: `We could not check ${name}.`,
      held: [],
      why: 'We could not read this record right now, so we did not delete anything.',
      instead: 'Please try again in a minute.',
    }
  }

  if (subject === 'driver') {
    return {
      title: `We cannot delete ${name}.`,
      held: heldLines(report),
      why:
        'This is his driver file. The law says keep it while he works for you and for 3 years ' +
        'after he leaves (49 CFR 391.51(c)). Deleting him would delete it.',
      instead:
        'Set his status to Terminated or Inactive instead. He comes off your reminders right ' +
        'away. His file stays. Drivers are free either way.',
    }
  }

  return {
    title: `We cannot delete ${name}.`,
    held: heldLines(report),
    why:
      'This truck has records on file. Deleting the truck would delete them too, and you may ' +
      'be asked for them later.',
    instead:
      'Set its status to Sold, Out of service or Inactive instead. We stop the reminders for ' +
      'this truck and we stop charging for it. The records above stay.',
  }
}

/**
 * The extra line on the confirmation when a to-do is riding along.
 *
 * Reminders do not block a delete — see `HistoryReport.reminders` — but they do
 * disappear with the row, and a destructive button must name everything it takes.
 */
export function remindersLine(subject: FleetSubject, report: HistoryReport): string | null {
  if (report.reminders < 1) return null
  const n = report.reminders
  return `${n} ${n === 1 ? 'reminder' : 'reminders'} you wrote about this ${NOUN[subject]} ${
    n === 1 ? 'is' : 'are'
  } deleted too.`
}

/**
 * The question above the red button. It names the row, every time.
 *
 * The name and nothing else — no "truck" or "driver" in front of it. The unit
 * number IS how the owner knows which row this is, and "Delete truck 104?" reads
 * as a category where "Delete 104?" reads as a thing.
 */
export function confirmTitle(name: string): string {
  return `Delete ${name}?`
}

export function confirmBody(subject: FleetSubject): string {
  return `Nothing is on file for this ${NOUN[subject]}, so nothing is lost. You cannot undo this.`
}

/**
 * What the list says after a delete that worked.
 *
 * NO NAME IN IT, and that is not an oversight. The name would have to travel in
 * the query string, and /app/billing already documents why this app never prints
 * query-string text back at the owner: a link anybody can craft then renders
 * whatever they like, in our styling, on our domain. The confirmation he just
 * pressed named the row; this only has to say it worked.
 *
 * The bill is mentioned only for a truck. Drivers were never on it, and saying
 * so would read as a refund.
 */
export function removedMessage(subject: FleetSubject): string {
  return subject === 'driver'
    ? 'Driver deleted.'
    : 'Truck deleted. It is off your reminders and off your bill.'
}
