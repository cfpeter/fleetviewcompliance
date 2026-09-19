/**
 * Whether this driver and this equipment may be put on this load.
 *
 * This is the whole thesis of the product in one function. Compliance stops
 * being a tab the owner visits when he remembers, and becomes a precondition on
 * the action he takes twenty times a week. No competitor in this price tier
 * connects the two.
 */
import type { DeadlineItem } from '../rules/index.ts'

export type Severity = 'block' | 'warn'

export interface EligibilityIssue {
  severity: Severity
  /** Stable machine name, for tests and for the override record. */
  code: string
  /** What the dispatcher reads, in their words, not the regulation's. */
  message: string
  ruleCode?: string
  subjectLabel?: string
}

/**
 * The rules that stop a truck.
 *
 * Deliberately short. A driver with a lapsed medical card or an expired CDL is
 * not "a bit non-compliant" — he is unqualified under 49 CFR 391.11(b)(4) and
 * (b)(5), which is an ACUTE violation and a single-occurrence automatic failure
 * in a new-entrant safety audit. Everything else is a warning.
 *
 * Adding to this list is a decision about someone's ability to earn today, so it
 * is made here, visibly, rather than inferred from a severity field scattered
 * across fifty rule rows.
 */
const BLOCKING_RULE_CODES = new Set([
  'medical_certificate_general',
  'medical_certificate_by_exam_date',
  'medical_certificate_intracity_zone',
  'medical_certificate_insulin_treated',
  'medical_certificate_alternative_vision',
  // California's intrastate medical certificate, and it belongs here for the
  // same reason as the five above it: an expired card is an expired card, and
  // the driver cannot drive on it.
  //
  // Without this line the gap was silent and one-sided. All five federal
  // medical rules answer "not applicable" for a carrier marked intrastate, so
  // for those carriers this set matched NOTHING — a driver with a card that ran
  // out last year produced a row on the dashboard and no block at all on the
  // assignment screen. The rule that closes the tracking half is new; this
  // closes the dispatch half.
  'ca_intrastate_medical_certificate',
  'cdl_expiry',
])

/**
 * Serious enough to interrupt, not serious enough to stop the truck.
 *
 * The equipment entries matter as much as the driver ones. Without them
 * eligibility() returned an empty list for every power unit and trailer ever
 * passed to it — the assignment screen wired equipment through this engine and
 * would have shown nothing, forever, while looking like it had checked.
 *
 * They warn rather than block deliberately. A lapsed annual inspection is a
 * serious finding and an out-of-service risk at the scale, but unlike an expired
 * medical card it does not make the DRIVER unqualified, and a truck can be
 * inspected the same afternoon. Telling the dispatcher is the right response;
 * refusing to let him plan the week is not.
 */
const WARNING_RULE_CODES = new Set([
  // Driver
  'clearinghouse_query_annual',
  'clearinghouse_query_pre_employment',
  'mvr_inquiry_annual',
  'driving_record_review_annual',
  // Power units and trailers
  'fed.396.17.periodic-inspection.power-unit',
  'fed.396.17.periodic-inspection.trailer',
  'ca_bit_inspection',
  'ca_ctc_test',
  'ca_cvra_registration',
  'fed.irs.2290.heavy-vehicle-use-tax',
])

export interface EligibilityInput {
  /** Already filtered to this driver, or this vehicle. */
  items: readonly DeadlineItem[]
  label: string
}

/**
 * Overdue blocks. Unknown warns.
 *
 * This is the one place the product deliberately does NOT treat "we don't know"
 * the same as "it expired", and it is worth being explicit about why.
 *
 * Everywhere else, unknown carries identical exposure and is shown alongside the
 * overdue items. But a BLOCK is not a display decision — it stops a truck
 * earning. On day one every driver's dates are unknown, so blocking on unknown
 * would make the product unusable at exactly the moment a carrier is deciding
 * whether to trust it, and the certain outcome is that somebody disables the
 * check entirely. A warning that says plainly "we do not know, and not knowing
 * carries the same risk as expired" keeps the honesty and keeps the truck moving
 * while the office fills the gap.
 */
export function eligibility(input: EligibilityInput): EligibilityIssue[] {
  const issues: EligibilityIssue[] = []

  for (const item of input.items) {
    const blocking = BLOCKING_RULE_CODES.has(item.rule.code)
    const warning = WARNING_RULE_CODES.has(item.rule.code)
    if (!blocking && !warning) continue

    if (item.status.standing === 'overdue') {
      issues.push({
        severity: blocking ? 'block' : 'warn',
        code: blocking ? 'expired' : 'lapsed',
        ruleCode: item.rule.code,
        subjectLabel: input.label,
        message: blocking
          ? `${input.label}: ${item.rule.title} has expired. Not qualified to operate ` +
            'until it is renewed.'
          : `${input.label}: ${item.rule.title} is overdue.`,
      })
      continue
    }

    if (item.status.standing === 'unknown' && blocking) {
      issues.push({
        severity: 'warn',
        code: 'unknown_blocking_date',
        ruleCode: item.rule.code,
        subjectLabel: input.label,
        message:
          `${input.label}: we have no date for ${item.rule.title}. Not knowing carries ` +
          'the same risk as it having expired — but we will not stop the truck over a ' +
          'gap in our own records.',
      })
    }
  }

  return issues
}

export interface OpenLoad {
  loadId: string
  loadLabel: string
}

export interface ConflictInput {
  openDriverLoads: readonly OpenLoad[]
  openTractorLoads: readonly OpenLoad[]
  openTrailerLoads: readonly OpenLoad[]
  /** The load being assigned, so it does not conflict with itself. */
  thisLoadId: string
}

/**
 * Double-booking. A warning rather than a block: teams, relays and
 * drop-and-hook all legitimately put one driver or one trailer against two open
 * loads, and a dispatcher who knows his own operation should not be argued
 * with. He does need to be told.
 */
export function conflicts(input: ConflictInput): EligibilityIssue[] {
  const out: EligibilityIssue[] = []
  const check = (rows: readonly OpenLoad[], what: string, code: string) => {
    for (const r of rows) {
      if (r.loadId === input.thisLoadId) continue
      out.push({
        severity: 'warn',
        code,
        message: `That ${what} is already on load ${r.loadLabel} and has not been released.`,
      })
    }
  }
  check(input.openDriverLoads, 'driver', 'driver_double_booked')
  check(input.openTractorLoads, 'tractor', 'tractor_double_booked')
  check(input.openTrailerLoads, 'trailer', 'trailer_double_booked')
  return out
}

export function worstSeverity(issues: readonly EligibilityIssue[]): Severity | null {
  if (issues.some((i) => i.severity === 'block')) return 'block'
  return issues.length > 0 ? 'warn' : null
}

/** May this assignment proceed at all? A block cannot be overridden. */
export function isBlocked(issues: readonly EligibilityIssue[]): boolean {
  return issues.some((i) => i.severity === 'block')
}
