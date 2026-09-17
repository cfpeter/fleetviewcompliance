/**
 * What counts as the equipment and the people you actually run.
 *
 * ONE DEFINITION, AND IT IS DELIBERATELY NOT INSIDE EITHER CALLER.
 *
 * Two questions used to be answered in two files. src/lib/deadlines.ts asked
 * "whose dates do I watch?" and answered `.neq('status', 'sold')`.
 * src/lib/billing/trucks.ts asked "who do I charge for?" and answered
 * `status !== 'sold'`. They agreed only because one had been copied from the
 * other, and that copy had already half-rotted: drivers were filtered
 * `.eq('status', 'active')` on the alerting side and nothing on the billing
 * side, so an inactive driver left the dashboard while an out-of-service truck
 * stayed on it AND on the invoice.
 *
 * src/lib/billing/trucks.ts had the principle right in its own header: "you pay
 * for the trucks we watch" is the only honest sentence, and it is honest only
 * while the two filters ARE one filter. So it is one filter now, in a module
 * neither of them owns, and a change here moves the bill and the alerts together
 * or not at all.
 *
 * THE RULE: ACTIVE ONLY.
 *
 *   vehicles   active | out_of_service | sold | inactive  -> only `active`
 *   drivers    active | inactive | terminated             -> only `active`
 *
 * WHY `out_of_service` IS OFF, WHICH IS THE ONLY DEBATABLE ONE. A truck on jack
 * stands is still owned and its registration still runs out, so there is a real
 * argument for keeping its dates on the dashboard. It loses to two stronger
 * ones. The owner's rule is that he pays for what he runs, and a truck in the
 * shop for a month is not what he runs. And whichever way this went, the answer
 * had to be the SAME on both sides — "we watch it for free" is the one
 * combination that can never be allowed, because a free status that still gets
 * the service is an invitation to mislabel a working truck, which corrupts the
 * compliance data this product exists to keep right.
 *
 * The cost of being wrong here is a truck whose registration quietly expires
 * because somebody parked it in the app. That is why the sentences below exist
 * and why every screen that can change a status prints one: a status that
 * silently switches off the reminders is worse than no status at all.
 */

import type { DriverStatus } from '../drivers.ts'
import type { VehicleStatus } from '../vehicles.ts'

/**
 * The one vehicle status that is watched and billed.
 *
 * A constant rather than a literal at each comparison, because the word has to
 * be said out loud on three screens ("Only Active trucks count") and the
 * arithmetic and the sentence must never drift apart.
 */
export const ACTIVE_VEHICLE_STATUS: VehicleStatus = 'active'

/** The one driver status that is watched. Drivers are never billed. */
export const ACTIVE_DRIVER_STATUS: DriverStatus = 'active'

/** A unit we watch, and — if it is a power unit — charge for. */
export function isActiveVehicle(v: { status: VehicleStatus }): boolean {
  return v.status === ACTIVE_VEHICLE_STATUS
}

/** A driver we watch. */
export function isActiveDriver(d: { status: DriverStatus }): boolean {
  return d.status === ACTIVE_DRIVER_STATUS
}

/**
 * What changing a truck's status away from Active actually does, in one
 * sentence, for the screen that offers the choice.
 *
 * Both halves, always, in this order. "It comes off your bill" on its own reads
 * as a saving with no cost attached, and an owner who parks a truck to save six
 * dollars must be told in the same breath that we stop watching its dates.
 */
export const VEHICLE_NOT_ACTIVE_MEANS =
  'Only Active trucks count. Any other status stops the reminders for this truck and takes it off your bill.'

/** The same, for a driver. Drivers are free, so there is no bill to mention. */
export const DRIVER_NOT_ACTIVE_MEANS =
  'Only Active drivers count. Any other status stops the reminders for this driver. Drivers are always free.'
