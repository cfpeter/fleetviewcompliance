/**
 * Which plan a carrier is on, decided in one place.
 *
 * The screen has to answer three questions without hedging: are you paying, what
 * happens next, and when. That is a state machine, and it is here rather than in
 * the page so it can be tested — a billing screen that tells a paying customer
 * his trial is over, or tells a lapsed one that everything is fine, is worse
 * than no billing screen at all.
 *
 * TWO SOURCES OF TRUTH, IN A FIXED ORDER, and the order is the whole design:
 *
 *   1. A Stripe subscription, if there is one. Stripe holds the card and the
 *      invoices; when it has an opinion, that opinion wins.
 *   2. Otherwise the free trial, derived from `carriers.created_at`.
 *
 * The trial is derived and not stored because it is a fact about every carrier,
 * including the ones who have never opened Stripe and so have no billing row at
 * all. Storing it on a row that may not exist would need a default written
 * somewhere else, and then there would be two answers to "when do my free days
 * end" with nothing to arbitrate between them.
 */

import { site } from '../site.ts'

const DAY_MS = 86_400_000

/**
 * The billing row as the screen reads it. Column names, not camelCase, because
 * this is what PostgREST hands back and renaming it in six places is six chances
 * to rename it wrongly.
 */
export interface BillingRow {
  stripe_customer_id: string
  stripe_subscription_id: string | null
  status: string
  current_period_end: string | null
  cancel_at_period_end: boolean
  billable_trucks: number | null
  trial_ends_at: string | null
}

/**
 * Stripe's statuses that mean the service is paid for right now.
 *
 * `trialing` is in here: a Stripe-side trial is a live subscription with a card
 * attached and a date it starts charging.
 */
export const PAID_STATUSES = ['active', 'trialing'] as const

/**
 * Statuses that mean Stripe tried to take money and could not.
 *
 * `incomplete` belongs with them rather than with the dead ones: it is a
 * subscription whose first payment needs the customer to do something (3D
 * Secure, usually), and it becomes `active` the moment he does.
 */
export const PROBLEM_STATUSES = ['past_due', 'unpaid', 'incomplete'] as const

/** Statuses that mean there is nothing live left. */
export const ENDED_STATUSES = ['canceled', 'incomplete_expired'] as const

export type PlanState =
  /** No subscription, still inside the free days. */
  | { state: 'trial'; trialEndsOn: Date; daysLeft: number }
  /** No subscription, free days used up. */
  | { state: 'trial_over'; trialEndedOn: Date }
  /** Paying, or on a Stripe trial with a card on file. */
  | {
      state: 'paying'
      /** Next charge. Null when they have cancelled, or when Stripe gave no date. */
      renewsOn: Date | null
      /** Set only when they pressed cancel: the day the service stops. */
      endsOn: Date | null
      /** The quantity Stripe is billing, which may not be today's fleet. */
      billedTrucks: number | null
      /** True while Stripe's own trial is running — nothing charged yet. */
      onStripeTrial: boolean
    }
  /** Stripe could not take the money. */
  | { state: 'payment_problem'; status: string; billedTrucks: number | null }
  /** Cancelled or expired. They can start again. */
  | { state: 'ended'; status: string }
  /**
   * A status this build does not recognise.
   *
   * Stripe adds statuses on its own schedule, and guessing at one would mean
   * either telling a paused customer his account has ended or telling an ended
   * one it is fine. The screen prints the word Stripe used and sends him to the
   * portal, which is the only place that can actually be right.
   */
  | { state: 'unknown'; status: string }

/** When the free days run out for a carrier that signed up at this moment. */
export function trialEndsAt(carrierCreatedAt: Date): Date {
  return new Date(carrierCreatedAt.getTime() + site.pricing.trialDays * DAY_MS)
}

/**
 * Whole days from now until the trial ends, never negative.
 *
 * Rounded UP, so a trial with four hours left says "1 day left" rather than "0
 * days left" on an account that still works. Zero means it is over.
 */
export function trialDaysLeft(carrierCreatedAt: Date, now: Date): number {
  const ms = trialEndsAt(carrierCreatedAt).getTime() - now.getTime()
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS)
}

/** `null` for a null/blank column, so a missing date never becomes 1970. */
function date(value: string | null): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function planState(input: {
  row: BillingRow | null
  carrierCreatedAt: Date
  now: Date
}): PlanState {
  const { row, carrierCreatedAt, now } = input

  // No subscription is the common case and it is not an error state: every
  // carrier lives here for the first 30 days, and a carrier whose subscription
  // Stripe has finished with lands back here too.
  if (!row?.stripe_subscription_id) {
    const endsOn = trialEndsAt(carrierCreatedAt)
    const daysLeft = trialDaysLeft(carrierCreatedAt, now)
    return daysLeft > 0
      ? { state: 'trial', trialEndsOn: endsOn, daysLeft }
      : { state: 'trial_over', trialEndedOn: endsOn }
  }

  const status = row.status
  if ((PAID_STATUSES as readonly string[]).includes(status)) {
    const periodEnd = date(row.current_period_end)
    return {
      state: 'paying',
      // Exactly one of these is ever set. A customer who has cancelled is still
      // paid up to the same date, and printing "renews on the 4th" at him would
      // be a promise we have already been told not to keep.
      renewsOn: row.cancel_at_period_end ? null : periodEnd,
      endsOn: row.cancel_at_period_end ? periodEnd : null,
      billedTrucks: row.billable_trucks,
      onStripeTrial: status === 'trialing',
    }
  }
  if ((PROBLEM_STATUSES as readonly string[]).includes(status)) {
    return { state: 'payment_problem', status, billedTrucks: row.billable_trucks }
  }
  if ((ENDED_STATUSES as readonly string[]).includes(status)) {
    return { state: 'ended', status }
  }
  return { state: 'unknown', status }
}

/**
 * True when the carrier is paid up or inside their free days.
 *
 * NOTHING IS GATED ON THIS TODAY — no page checks it and no feature is switched
 * off by it. It exists so that the day somebody does add a paywall, the question
 * "is this carrier entitled" has one answer, computed from the same state
 * machine the screen prints. A second definition written inline at a gate is how
 * a paying customer gets locked out.
 */
export function isEntitled(state: PlanState): boolean {
  return state.state === 'trial' || state.state === 'paying'
}
