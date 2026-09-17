/**
 * What counts as a truck on the bill.
 *
 * This is the only file that answers that question, and it is the question the
 * whole subscription rests on: the price is per truck, so a wrong answer here is
 * a wrong invoice every month, forever, to every customer.
 *
 * THE RULE: a billable truck is a POWER UNIT that is not marked SOLD.
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
 * NOT SOLD. The same page: "What happens when I add or sell a truck? Your bill
 * goes up or down by $6." A truck marked `sold` is gone, and charging for it is
 * the fastest way to lose the customer who noticed.
 *
 * WHY `out_of_service` AND `inactive` ARE STILL BILLED. Because they are still
 * worked on. loadDeadlines() reads `.neq('status', 'sold')` — every vehicle
 * except a sold one has its inspection, registration, HVUT and Clean Truck Check
 * dates computed, and generates reminders and emails. Billing on the same filter
 * makes one honest sentence possible: you pay for the trucks we are watching,
 * and the day you mark one sold we stop doing both. Any other line here would
 * either charge for trucks we ignore or watch trucks for free — and a free
 * status that still gets the service is an invitation to mislabel a working
 * truck, which corrupts the compliance data this product exists to keep right.
 *
 * Kept as pure functions over plain rows so the count can be tested without a
 * database and so the screen, the checkout and the Stripe quantity all derive
 * from one implementation.
 */

import type { VehicleKind, VehicleStatus } from '../vehicles.ts'

/** The two columns billing looks at. Anything with these can be counted. */
export interface BillableVehicle {
  kind: VehicleKind
  status: VehicleStatus
}

/**
 * The one status that takes a unit off the bill.
 *
 * A constant rather than a literal at the comparison, because this value also
 * has to be said out loud on the billing screen ("mark it Sold") and the screen
 * and the arithmetic must never drift apart.
 */
export const UNBILLED_STATUS: VehicleStatus = 'sold'

export function isBillableTruck(v: BillableVehicle): boolean {
  return v.kind === 'power_unit' && v.status !== UNBILLED_STATUS
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
  /** Power units that are not sold. The quantity Stripe is sent. */
  billable: number
  /** Power units marked sold. Free, and no longer watched. */
  sold: number
  /** Trailers, whatever their status. Always free. */
  trailers: number
}

export function billingBreakdown(rows: readonly BillableVehicle[]): FleetBilling {
  let billable = 0
  let sold = 0
  let trailers = 0
  for (const v of rows) {
    if (v.kind === 'trailer') trailers++
    else if (v.status === UNBILLED_STATUS) sold++
    else billable++
  }
  return { billable, sold, trailers }
}
