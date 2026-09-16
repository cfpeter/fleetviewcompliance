/**
 * Everything about the business that is not a design decision.
 *
 * These are deliberately in ONE file: the marketing pages reference them, and a
 * phone number that is wrong in four places is worse than one that is wrong in
 * one. Values marked TODO must be filled before the site goes public.
 */

import { allRules } from './rules/index.ts'

export const site = {
  name: 'FleetView Compliance',
  url: 'https://fleetviewcompliance.com',

  /** TODO — the business phone customers should call or text. */
  phone: '',
  /**
   * The address customers write to. Real and monitored — the manual USDOT
   * review path is answered here, and for a carrier whose federal record
   * carries no phone or email this is the ONLY way they can ever be verified.
   * An empty value there is not a missing link, it is a dead end.
   */
  email: 'info@fleetviewcompliance.com',

  /** TODO — the registered legal entity, for the terms and privacy pages. */
  legalEntity: '',
  /** TODO — city/state is enough; a full address is not required. */
  legalLocation: 'Glendale, California',

  pricing: {
    perTruck: 6,
    floor: 29,
    trialDays: 30,
    /**
     * The largest fleet the published price answers for.
     *
     * NOT a tier and not a price change — `monthlyPrice` stays linear above it.
     * It is the top of the segment this product was built and tested for (docs/
     * REQUIREMENTS.md: "roughly 5 to 50 trucks"). A 200-truck carrier has a
     * full-time safety manager and a TMS, and quoting him $1,200 off a formula
     * nobody has ever sold at that size is a number we would have to walk back
     * on the first call. Above this the page says "talk to us" and still names
     * the $6 rate, so nobody has to wonder whether the price secretly jumps.
     */
    maxQuotedTrucks: 50,
  },
} as const

/**
 * What the product actually covers, COUNTED from the catalogue rather than typed.
 *
 * The marketing pages say "36 of 51" out loud, because a number a carrier can
 * go and check is worth more than an adjective. A hand-typed count goes stale
 * the first time someone adds a rule row, and the one thing a compliance
 * product cannot survive is being caught overstating its own catalogue.
 *
 * The per-state counts are named per state rather than lumped into one "state
 * rules" total on purpose. A single total would keep rendering happily the day
 * a second state ships, under copy that still says the word California — which
 * is the exact class of quiet wrongness this whole file is here to prevent.
 * `total` stops matching `federal + california` at that moment, which is the
 * signal that every page naming a state has to be read again. Add the next
 * state's count here as its own field and make the copy ask for it by name.
 */
export const coverage = {
  total: allRules.length,
  federal: allRules.filter((r) => r.jurisdiction === 'federal').length,
  california: allRules.filter((r) => r.jurisdiction === 'CA').length,
} as const

/** Digits only, for a tel: or sms: href. Empty when the number is unset. */
export function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return digits ? `tel:+1${digits.slice(-10)}` : ''
}

export function smsHref(phone: string, body: string): string {
  const digits = phone.replace(/\D/g, '')
  if (!digits) return ''
  // &body= is the iOS form; Android accepts it too on modern versions.
  return `sms:+1${digits.slice(-10)}&body=${encodeURIComponent(body)}`
}

/** monthly = max(trucks x perTruck, floor) */
export function monthlyPrice(trucks: number): number {
  const { perTruck, floor } = site.pricing
  return Math.max(trucks * perTruck, floor)
}

/**
 * Bigger than any fleet that exists, so a number above it is a paste accident
 * or a fat finger, not a carrier. The largest US fleet runs around 20,000 power
 * units and is not reading a $29-a-month marketing page. Without this bound
 * `?trucks=999999999` renders a straight-faced "talk to us about your
 * 999,999,999 trucks", which makes the whole estimator look like it is not
 * reading its own input.
 */
const FLEET_CEILING = 10_000

/** A fleet is at least one truck. `?trucks=0` is a URL, never a customer. */
const MIN_TRUCKS = 1

/**
 * What the pricing page should show for a given `?trucks=`.
 *
 * Four outcomes, because collapsing any two of them produces a lie: `none` is
 * nobody having asked yet, `unreadable` is us refusing to guess, `oversize` is
 * a real fleet we will not quote unseen, and only `priced` carries a number.
 */
export type PriceEstimate =
  | { state: 'none' }
  | { state: 'unreadable' }
  | {
      state: 'priced'
      trucks: number
      monthly: number
      /** monthly ÷ trucks — high on the floor, settling at `perTruck` above it. */
      effectivePerTruck: number
      /** True when the minimum is what they pay, not the per-truck rate. */
      onFloor: boolean
    }
  | { state: 'oversize'; trucks: number }

/**
 * Read `?trucks=` into an estimate.
 *
 * Every degenerate input lands somewhere sensible, because this is a price and
 * the failure mode of a price is not a blank section — it is a wrong number a
 * visitor screenshots and quotes back at us:
 *
 * - absent or blank → `none`, the resting page, same doctrine as an unknown
 *   `?show=` on the dashboard meaning "everything" rather than an empty screen.
 * - not a whole number ('abc', '12.5', '1e3') → `unreadable`. We say we could
 *   not read it instead of silently pricing some number we made up.
 * - zero or negative → clamped to one truck. A $0 quote is the one output this
 *   function must never produce, and the form box echoes the 1 back so the
 *   clamp is visible rather than sneaky.
 * - above `maxQuotedTrucks` → `oversize`, carrying the count so the page can
 *   still address a real 80-truck fleet by its size.
 *
 * The number itself always comes from `monthlyPrice`. A second copy of the
 * arithmetic here would be a second price, and the one on the marketing page is
 * the one the customer holds us to.
 */
export function estimatePrice(raw: string | null | undefined): PriceEstimate {
  const text = (raw ?? '').trim()
  if (text === '') return { state: 'none' }
  // Whole numbers only. Number() would happily take '12.5' and ' 1e3 ', and a
  // fleet of 12.5 trucks priced to the half-truck reads as a bug in the price.
  if (!/^[+-]?\d+$/.test(text)) return { state: 'unreadable' }

  const parsed = Number(text)
  if (!Number.isFinite(parsed) || parsed > FLEET_CEILING) return { state: 'unreadable' }

  const trucks = Math.max(MIN_TRUCKS, parsed)
  if (trucks > site.pricing.maxQuotedTrucks) return { state: 'oversize', trucks }

  const monthly = monthlyPrice(trucks)
  return {
    state: 'priced',
    trucks,
    monthly,
    effectivePerTruck: monthly / trucks,
    onFloor: trucks * site.pricing.perTruck < site.pricing.floor,
  }
}

/**
 * A link that opens the estimator with an answer already on it.
 *
 * The fragment is load-bearing. Every one of these is a jump into the middle of
 * a long marketing page, and landing back at the hero with the answer a scroll
 * below the fold reads as the tap having done nothing.
 */
export function pricingHref(trucks: number, opts?: { fromBelow?: boolean }): string {
  // NO FRAGMENT BY DEFAULT, and that is the whole point of the option.
  //
  // Every one of these links is a real page load. With `#estimate` on it the
  // browser paints the page at the top and THEN jumps down to the anchor, and
  // the estimator sits about 430px into a 812px screen — already visible. So
  // the jump travelled ~390px to reach something the reader could see without
  // moving, once per tap, and stepping the truck count up and down read as the
  // page lurching rather than as a number changing.
  //
  // The exception is a link that genuinely IS far away: the "what that works
  // out to" ladder sits ~2,500px down, and tapping a row there without the
  // anchor would drop the reader at the top of the page wondering where the
  // answer went.
  const anchor = opts?.fromBelow ? '#estimate' : ''
  return `/pricing?trucks=${trucks}${anchor}`
}
