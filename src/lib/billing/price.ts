/**
 * The bill, in cents, and the Stripe price that has to produce the same number.
 *
 * NOTHING HERE INVENTS A PRICE. Every figure is `monthlyPrice()` from
 * src/lib/site.ts, which is what /pricing quotes and what a customer holds us
 * to. A second implementation of the arithmetic is how the invoice and the
 * marketing page come to disagree, and the customer only ever finds out by being
 * charged the wrong amount.
 *
 * CENTS, ALWAYS INTEGERS. Money never touches a float: `0.1 + 0.2` is famously
 * not `0.3`, and a rounding error in a subscription repeats every month.
 */

import { monthlyPrice, site } from '../site.ts'

/**
 * The monthly bill for a fleet of this size, in integer cents.
 *
 * `Math.round` rather than a bare multiply: `29 * 100` is exact today because
 * both pricing numbers are whole dollars, and the round is what keeps it exact
 * the day somebody sets perTruck to 6.50.
 */
export function monthlyCents(trucks: number): number {
  return Math.round(monthlyPrice(trucks) * 100)
}

/**
 * Cents as money for a screen. `$29`, or `$34.50` if it ever has cents in it.
 *
 * Whole dollars print without the `.00` because that is how /pricing prints
 * them, and two spellings of the same price on two pages of one product reads
 * as two prices.
 */
export function formatMoney(cents: number): string {
  const whole = cents % 100 === 0
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

// ---------------------------------------------------------------------------
// The Stripe price
// ---------------------------------------------------------------------------
//
// Stripe does not bill by running our function. It bills from a Price object
// configured in the dashboard, and that object has to reproduce
// `max(trucks × $6, $29)` exactly, for every fleet size, or the invoice and this
// application disagree — which is the one failure this whole file exists to
// prevent.
//
// The shape that does it is a TIERED price with `tiers_mode = volume`:
//
//   tier 1   up_to = 4     flat_amount = 2900     (and no unit amount)
//   tier 2   up_to = inf   unit_amount = 600      (and no flat amount)
//
// VOLUME, NOT GRADUATED, and the difference is the whole thing. Graduated
// charges each tier for the units that fall inside it, so five trucks would cost
// $29 + $6 = $35. Volume picks the single tier the total quantity lands in and
// prices every unit there, so five trucks cost 5 × $6 = $30 — which is what
// `monthlyPrice(5)` says and what the estimator shows.
//
// The numbers below are DERIVED from site.pricing rather than typed, and
// tests/billing.test.ts walks every fleet size comparing the tier arithmetic
// against monthlyPrice(). That test is the thing that catches a price created in
// the Stripe dashboard from the wrong instructions, because the instructions in
// docs/OPERATIONS.md are printed from these constants.

export interface StripeTier {
  /** Quantity ceiling for this tier. `'inf'` is Stripe's literal for the last. */
  upTo: number | 'inf'
  /** Charged once for the whole subscription when the quantity lands here. */
  flatAmountCents?: number
  /** Charged per unit, for every unit, when the quantity lands here. */
  unitAmountCents?: number
}

/**
 * The last fleet size the minimum still covers.
 *
 * `ceil(29 / 6) - 1` = 4. At five trucks the per-truck rate has caught up with
 * the floor and takes over. Computed, not typed: with a $30 floor the answer is
 * still 4 (five trucks bill $30 either way), and with a $35 floor it is 5 —
 * neither of which anybody would remember to edit by hand.
 */
export const FLOOR_TRUCK_CEILING = Math.ceil(site.pricing.floor / site.pricing.perTruck) - 1

/** The two tiers, exactly as they must be entered in the Stripe dashboard. */
export const STRIPE_VOLUME_TIERS: readonly StripeTier[] = [
  { upTo: FLOOR_TRUCK_CEILING, flatAmountCents: site.pricing.floor * 100 },
  { upTo: 'inf', unitAmountCents: site.pricing.perTruck * 100 },
]

/**
 * What Stripe would charge for this quantity, computed from the tiers above.
 *
 * Exists to be compared against `monthlyCents()` in the tests. If the two ever
 * disagree, the Stripe price we are telling the owner to create is wrong and the
 * invoice will not match the pricing page.
 */
export function tieredMonthlyCents(trucks: number): number {
  const tier =
    STRIPE_VOLUME_TIERS.find((t) => t.upTo === 'inf' || trucks <= t.upTo) ??
    STRIPE_VOLUME_TIERS[STRIPE_VOLUME_TIERS.length - 1]
  return (tier.flatAmountCents ?? 0) + (tier.unitAmountCents ?? 0) * trucks
}
