/**
 * What counts as a truck on the bill.
 *
 * This is the only file that answers that question, and it is the question the
 * whole subscription rests on: the price is per truck, so a wrong answer here is
 * a wrong invoice every month, forever, to every customer.
 *
 * THE RULE: a billable truck is a POWER UNIT that is ACTIVE.
 *
 * Both halves were decided by promises already made in public, not by taste.
 *
 * POWER UNITS ONLY. /pricing answers "What counts as a truck?" with "A power
 * unit: a tractor or a straight truck. Trailers are free and drivers are free.
 * Count the ones with an engine." That sentence is on the page the customer
 * bought from, so it is the specification. Billing trailers would roughly double
 * a real fleet's bill against the estimator they used before signing up — a
 * ten-truck carrier running twelve trailers would be quoted $60 and charged
 * $132 — and a bill that disagrees with the price page is the one billing defect
 * you cannot explain your way out of.
 *
 * ACTIVE ONLY, AND THAT WORD IS NOT DEFINED HERE. It is defined once, in
 * src/lib/fleet/active.ts, and src/lib/deadlines.ts reads the same definition to
 * decide whose dates it watches. That shared module is the whole point: this
 * file used to say `status !== 'sold'` because the deadline loader said
 * `.neq('status', 'sold')`, which made "you pay for the trucks we watch" true by
 * coincidence rather than by construction. Two expressions that agree by
 * coincidence are two expressions that drift, and the drift shows up as an
 * invoice for a truck nobody is watching, or a truck watched for free.
 *
 * So the rule now reads in one sentence and it is the same sentence on both
 * sides: WE WATCH THE TRUCKS YOU RUN AND WE CHARGE FOR THE TRUCKS YOU RUN. Mark
 * a unit Sold, Out of service or Inactive and both stop on the same day. The
 * screens say that out loud rather than leaving the owner to discover it.
 *
 * Kept as pure functions over plain rows so the count can be tested without a
 * database and so the screen, the checkout and the Stripe quantity all derive
 * from one implementation.
 */

import { ACTIVE_VEHICLE_STATUS, isActiveVehicle } from '../fleet/active.ts'
import type { VehicleKind, VehicleStatus } from '../vehicles.ts'

/** The two columns billing looks at. Anything with these can be counted. */
export interface BillableVehicle {
  kind: VehicleKind
  status: VehicleStatus
}

/**
 * The one status that keeps a power unit on the bill.
 *
 * Re-exported from src/lib/fleet/active.ts rather than restated, so a screen
 * that needs the word can take it from billing without opening a second module,
 * and so there is still exactly one place it is written down.
 */
export const BILLED_STATUS: VehicleStatus = ACTIVE_VEHICLE_STATUS

export function isBillableTruck(v: BillableVehicle): boolean {
  return v.kind === 'power_unit' && isActiveVehicle(v)
}

export function countBillableTrucks(rows: readonly BillableVehicle[]): number {
  return rows.filter(isBillableTruck).length
}

/**
 * The three numbers the billing screen shows.
 *
 * Every unit on the account lands in exactly one of them, and the page prints
 * all three. A bare "you are billed for 9 trucks" invites the owner to count his
 * own yard, reach 14, and conclude we are hiding something; showing the five
 * that are free — and why — answers the question before he asks it.
 */
export interface FleetBilling {
  /** Active power units. The quantity Stripe is sent. */
  billable: number
  /** Power units that are not active: sold, out of service, parked. Free, and not watched. */
  notActive: number
  /** Trailers, whatever their status. Always free. */
  trailers: number
}

export function billingBreakdown(rows: readonly BillableVehicle[]): FleetBilling {
  let billable = 0
  let notActive = 0
  let trailers = 0
  for (const v of rows) {
    if (v.kind === 'trailer') trailers++
    else if (isActiveVehicle(v)) billable++
    else notActive++
  }
  return { billable, notActive, trailers }
}
