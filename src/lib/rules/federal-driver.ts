/**
 * Federal DRIVER-side obligations — 49 CFR Part 391 (driver qualification) and
 * 49 CFR Parts 382 / 40 (controlled substances and alcohol).
 *
 * Every row below is DATA. The only executable code in this file is the small
 * set of named `computed` schedules the Recurrence algebra cannot yet express
 * (see ONE_TIME_SCHEDULES) — each is registered under a string name, so a rule
 * row still reads as data and a new jurisdiction still costs rows, not code.
 *
 * NOTHING HERE HAS BEEN CHECKED BY A LAWYER. `verifiedBy` / `verifiedOn` are
 * deliberately absent on every row. An unset field is an honest "nobody has
 * looked at this"; a set one would be a lie that nothing would ever catch.
 *
 * Sources, all verified against the eCFR Title 49 snapshot of 2026-09-11:
 *   docs/research/compliance-federal-rules.md
 *   docs/research/compliance-part40.md
 *   docs/research/compliance-traps.md
 *   docs/research/compliance-penalties.md
 *
 * NOT here, on purpose:
 *   § 391.27 (driver's annual list of violations) — REPEALED by 87 FR 13209,
 *   effective 2022-05-09, and the section is now [Reserved]. Its content was
 *   absorbed into the § 391.25 annual review. Every compliance checklist on the
 *   internet still lists it; adding it back would put a deadline on an owner's
 *   screen for a certificate that no longer legally exists (trap T4).
 */
import { registerComputed } from './compute.ts'
import { toUtcMidnight } from './dates.ts'
import type { Applicability, Outcome, RuleContext, RuleDefinition } from './types.ts'

// ---------------------------------------------------------------------------
// Penalties
// ---------------------------------------------------------------------------

/**
 * 49 CFR 386 Appendix B, as adjusted by 89 FR 106282 (the *2025* adjustment).
 *
 * DOT appears to have skipped the January 2026 cycle, so these are simultaneously
 * the current amounts and the stalest they have ever been — a catch-up rule can
 * land at any time. The year is written into the string because `consequence` is
 * a bare string with nowhere to put an effective date.
 *
 * The figure that is NOT here is "$10,000 per day for failing to implement a
 * drug and alcohol testing program". There is no such line item in Appendix B.
 * $10,000 is the unadjusted statutory maximum in 49 U.S.C. 521(b)(2)(A); adjusted
 * it is $19,246, and it is stated per violation, not per day. Only the
 * recordkeeping entry carries an express daily multiplier.
 */
const RECORDKEEPING =
  'Recordkeeping penalty $1,584/day up to $15,846 (49 CFR 386 App. B(a)(1), 2025 amounts)'
const PART382_EMPLOYER = '$19,246 per violation (49 CFR 386 App. B(a)(3), 2025 amounts)'
const CLEARINGHOUSE_PENALTY = '$7,155 per violation (49 CFR 386 App. B(b), 2025 amounts)'

// ---------------------------------------------------------------------------
// Three-valued applicability helpers
// ---------------------------------------------------------------------------

/**
 * Kleene AND. One definite `false` settles the question; otherwise a single
 * `unknown` keeps the rule in play, because a rule we cannot rule out is a rule
 * we track. There is no `or` helper because no rule in this file needs one —
 * it gets written when something needs it, not in advance.
 */
function and(...parts: readonly Applicability[]): Applicability {
  if (parts.includes(false)) return false
  if (parts.includes('unknown')) return 'unknown'
  return true
}

/**
 * Part 391 is an interstate regulation (the research states this explicitly only
 * for the medical certificate, § 391.45, so this gate is used only there).
 *
 * 'A' is interstate; 'B' and 'C' are intrastate. Returning `false` for an
 * intrastate carrier is only safe because the CA ruleset is expected to carry
 * the intrastate analogue of the medical card — if that ruleset is ever not
 * loaded for a state we sell into, this predicate hides the single most
 * enforcement-visible document in the industry. Absent data is 'unknown',
 * never 'no'.
 */
function interstateDriver(ctx: RuleContext): Applicability {
  if (ctx.carrierOperation === undefined) return 'unknown'
  return ctx.carrierOperation === 'A'
}

/**
 * Part 382 hangs off the Part 383 CDL requirement, NOT off interstate commerce:
 * § 382.103 reaches every driver required to hold a CDL, so an *intrastate* CDL
 * driver is fully inside Part 382 and the Clearinghouse. Gating these rules on
 * `carrierOperation` instead of `cdl` would switch the Clearinghouse off for
 * exactly the carriers least likely to know it applies to them.
 */
function part382Driver(ctx: RuleContext): Applicability {
  if (ctx.cdl === undefined) return 'unknown'
  return ctx.cdl
}

/**
 * "The only evidence we have that this driver is in this situation is that
 * somebody typed a date that only exists for drivers in this situation."
 *
 * This NEVER returns false, and that is not an oversight. RuleContext carries no
 * boolean for "insulin-treated under § 391.46", "exempt intracity zone",
 * "certified under the § 391.44 alternative vision standard" or "holds an SPE",
 * so the absence of the date is indistinguishable from nobody having been asked.
 * The cost is noise — every driver carries these rows in `missing_data` until
 * someone answers. The cost of the other choice is telling an insulin-treated
 * driver his 12-month card is good for 24 months.
 */
function signalledByAnchor(ctx: RuleContext, anchor: string): Applicability {
  return ctx.anchors?.[anchor] ? true : 'unknown'
}

/**
 * Applicability for a REFINEMENT of a rule that already covers everyone.
 *
 * The three 12-month medical variants and the SPE certificate touch well under
 * 1% of drivers, and `RuleContext` originally had no way to say "this driver is
 * not insulin-treated". `signalledByAnchor` therefore answered `'unknown'` for
 * every ordinary driver, and fail-open turned that into four permanent
 * unresolvable rows on every single driver — noise that made the dashboard
 * useless and dragged the audit binder's medical item to `unknown` for a driver
 * whose certificate was perfectly valid.
 *
 * Failing open is right when failing closed would DROP an obligation. That is
 * not the situation here: `medical_certificate_general` applies to every driver
 * regardless, so the certificate is tracked either way. These rules only decide
 * WHICH ceiling applies, and defaulting an absent signal to "not this one" loses
 * no coverage at all.
 *
 * So: an explicit boolean wins; otherwise the anchor's presence is the signal;
 * otherwise the refinement does not apply.
 */
function refinement(ctx: RuleContext, fact: boolean | undefined, anchor: string): Applicability {
  if (fact === true) return true
  if (fact === false) return false
  return ctx.anchors?.[anchor] ? true : false
}

// ---------------------------------------------------------------------------
// Named `computed` schedules
// ---------------------------------------------------------------------------

interface OneTimeSchedule {
  /** The string a rule row carries in `recurrence.fn`. */
  fn: string
  /** Key into RuleContext.anchors. Also what `missing_data.needs` reports. */
  anchor: string
  offsetDays: number
}

/**
 * Obligations that come due ONCE, a whole number of days after a date.
 *
 * These have to be `computed` because `Recurrence` offers only `fixed_calendar`,
 * `anniversary` and `rolling`, and all three are wrong here in two separate ways:
 *
 *  1. THE UNIT. § 391.23 gives a hard THIRTY DAYS from the date employment
 *     begins. Thirty days is not one month. A driver hired on 31 January is due
 *     on 2 March; `addMonthsClamped(+1)` would say 28 February, which is early
 *     (safe) — but a driver hired on 1 February would get 1 March, which is 28
 *     days, and one hired on 1 July would get 1 August, which is 31 days, i.e.
 *     one day LATE. A deadline that drifts later is the one direction this
 *     domain refuses.
 *
 *  2. THE REPETITION. `anniversary` and `rolling` both walk forward until they
 *     pass today. A pre-employment MVR that was never done in 2019 would come
 *     out as "due next month, every month, forever" — a recurring deadline for a
 *     one-time act, which reads as a routine chore rather than a six-year-old
 *     hole in the file.
 */
const ONE_TIME_SCHEDULES: readonly OneTimeSchedule[] = [
  // Due the day the driver starts: the obligation is "before the driver performs
  // the function", so the last safe moment is the first day of employment.
  { fn: 'once_on_hire_date', anchor: 'hire_date', offsetDays: 0 },
  // § 391.23(b) and (c)(1): "within 30 days of the date the driver's employment
  // begins" — the same clock for both the MVR and the investigation.
  { fn: 'once_30_days_after_hire', anchor: 'hire_date', offsetDays: 30 },
  // § 382.603 states no deadline at all. Treating the designation date itself as
  // the deadline is our own conservative reading, not a citable due date: a
  // supervisor who has not had the 120 minutes cannot lawfully make the
  // reasonable-suspicion determination he has just been designated to make.
  { fn: 'once_on_supervisor_designation', anchor: 'supervisor_designated_date', offsetDays: 0 },
  // The SPE certificate states its own term; the research gives no fixed
  // interval ("per the certificate's own term"), so we read the date off the
  // certificate rather than inventing a renewal cycle.
  { fn: 'once_on_spe_certificate_expiry', anchor: 'spe_certificate_expiry', offsetDays: 0 },
]

/**
 * Registered as a bare `next` function with NO `previous` hook, deliberately.
 *
 * `ComputedSchedule.previous` exists so `status` can say `overdue` for an
 * algorithmic schedule, and these schedules genuinely have no earlier
 * occurrence: a road test happens once. Supplying the deadline itself as a
 * "previous cycle" would mark a driver whose MVR arrived on day 45 as overdue
 * for the rest of his employment, long after the hole was closed.
 */
function registerOneTime({ fn, anchor, offsetDays }: OneTimeSchedule): void {
  registerComputed(fn, (ctx): Outcome => {
    const from = ctx.anchors?.[anchor]
    // No anchor, no guess. Naming the anchor here is what puts "we need the
    // hire date" in front of the owner instead of a plausible-looking date.
    if (!from) return { kind: 'missing_data', needs: [anchor] }
    // Whole days added to a UTC midnight. UTC has no DST, so +30 days is exactly
    // 30 × 86,400,000 ms and cannot land on the wrong calendar day.
    return { kind: 'due', on: new Date(toUtcMidnight(from).getTime() + offsetDays * 86_400_000) }
  })
}

/** The rule row's `fn` for return-to-duty follow-up testing. */
const RTD_FOLLOW_UP_FN = 'return_to_duty_follow_up_plan'

/**
 * Return-to-duty follow-up testing has no date we are entitled to compute.
 *
 * § 40.307(d): at least SIX unannounced tests in the first 12 months after the
 * return-to-duty test, and the SAP may extend the plan for up to 48 further
 * months (60 months in total). The SAP fixes the number and the frequency; the
 * EMPLOYER picks the actual dates (§ 40.307(d)(3)). "Six tests, somewhere inside
 * twelve months, at times the employer chooses" is not an interval, and
 * `Recurrence` has no way to say it — the honest answer is `unsupported`, which
 * the UI renders as "you owe this, go and look", not as a green tick.
 *
 * And a hard constraint that outlives this file: § 40.307(g) forbids the
 * employer, the SAP and any service agent from giving the employee a copy of the
 * schedule or hinting at its frequency or duration (reiterated at 91 FR 10518,
 * March 2026). If a driver-facing view is ever built, these rows must be
 * invisible to it in the RLS policy, not merely unlinked in the UI.
 */
function registerReturnToDutyFollowUp(): void {
  registerComputed(RTD_FOLLOW_UP_FN, (ctx): Outcome => {
    const rtd = ctx.anchors?.return_to_duty_test_date
    if (!rtd) return { kind: 'missing_data', needs: ['return_to_duty_test_date'] }
    return {
      kind: 'unsupported',
      reason:
        'The SAP sets the number and frequency of follow-up tests and the employer picks the ' +
        'dates (49 CFR 40.307(d)(3)); a minimum of 6 unannounced tests falls in the 12 months ' +
        'after the return-to-duty test, and the plan may run 48 months beyond that. Read the ' +
        'dates off the SAP follow-up plan. Never show this schedule to the driver (40.307(g)).',
    }
  })
}

let schedulesRegistered = false

/**
 * Idempotent, and called at import below so a rule row can never reference a
 * `fn` name that nothing has registered. The test suite asserts this holds for
 * every `computed` row in the catalogue.
 */
export function registerFederalDriverSchedules(): void {
  if (schedulesRegistered) return
  schedulesRegistered = true
  for (const schedule of ONE_TIME_SCHEDULES) registerOneTime(schedule)
  registerReturnToDutyFollowUp()
}

registerFederalDriverSchedules()

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export const federalDriverRules: RuleDefinition[] = [
  {
    /**
     * The fallback when we have the examination date but not the printed expiry.
     *
     * The general rule reads the date off the card, which is correct — an
     * examiner may certify for any period up to 24 months. But an office that
     * recorded only "he had his physical in June" would otherwise be tracked by
     * nothing at all, because the variants are refinements that do not apply to
     * an ordinary driver and the general rule has no date to work from.
     *
     * 391.45(b) is a LOOKBACK: a driver may not drive unless examined within the
     * preceding 24 months. So the exam date gives us the LATEST the certificate
     * can possibly run to. That is a ceiling, not the real expiry — a 3-month
     * card examined on the same day expired 21 months earlier — so this rule is
     * deliberately the weaker evidence and yields to the printed date whenever
     * we have it.
     */
    code: 'medical_certificate_by_exam_date',
    title: "Medical examiner's certificate — 24-month ceiling from the examination",
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.45(b)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.45',
    recurrence: { type: 'rolling', intervalMonths: 24, anchor: 'medical_exam_date' },
    maxTermMonths: 24,
    warningDays: [90, 45, 14, -1],
    evidence:
      'The certificate itself for a non-CDL driver; the CDLIS motor vehicle record for a ' +
      'CDL holder. Record the printed expiry where you have it — it governs, and this ' +
      'rule steps aside when you do.',
    consequence:
      'Using a driver not medically examined and certified within the preceding 24 months ' +
      'is a CRITICAL violation (391.45(b)), and the underlying unqualified-driver finding ' +
      'under 391.11(b)(4) is ACUTE.',
    // Two gates. The interstate one matches the general rule it stands in for —
    // shipping to a state without its own intrastate medical rule would
    // otherwise make the certificate vanish from that state's drivers.
    // The second: only when the better evidence is absent, because two rules
    // reporting on one certificate would double-count it in the binder.
    applies: (ctx) =>
      and(interstateDriver(ctx), ctx.anchors?.medical_certificate_expires ? false : true),
  },

  {
    /**
     * The other half of the dispatch block, and it was missing.
     *
     * § 391.11(b)(5) makes a currently valid CDL a qualification requirement in
     * exactly the same breath as § 391.11(b)(4) makes physical qualification one.
     * Both are ACUTE violations. The dispatch engine listed `cdl_expiry` among
     * the codes that stop a truck, `deadlines.ts` was already projecting the
     * `cdl_expires` anchor off the driver row — and no rule carried the code, so
     * the two halves never met and an expired licence dispatched silently.
     *
     * An `expiry` rule, for the same reason the medical certificate is one: the
     * date is printed on the licence and issued per-driver, not derived from an
     * interval. States issue 4-, 5- and 8-year CDLs, so any constant would be
     * wrong for most drivers.
     */
    code: 'cdl_expiry',
    title: "Commercial driver's licence",
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.11(b)(5)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.11',
    recurrence: { type: 'expiry', anchor: 'cdl_expires' },
    // 60 days because renewing a CDL means a visit to the DMV, and in California
    // that is an appointment booked weeks out, not an errand.
    warningDays: [60, 30, 14, 1, -1],
    evidence:
      'The licence itself, and the CDLIS motor vehicle record from the current ' +
      'licensing state. Only one state may licence a driver at a time (391.11(b)(5)).',
    consequence:
      'The driver is not qualified under 391.11(b)(5). Using an unqualified driver is ' +
      'an ACUTE violation and a single-occurrence automatic failure in a new-entrant ' +
      'safety audit. Employer penalty up to $19,246 per violation (2025 amounts).',
  },

  // -------------------------------------------------------------------------
  // 49 CFR Part 391 — driver qualification
  // -------------------------------------------------------------------------

  {
    code: 'dqf_maintained',
    title: 'Driver qualification file opened for this driver',
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.51(a), (b)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.51',
    // The file has to exist from the day the driver starts. Not a recurring
    // obligation and not a 30-day one: § 391.51 has no grace period in it.
    recurrence: { type: 'computed', fn: 'once_on_hire_date' },
    warningDays: [14, 7, 0, -7],
    evidence:
      'A file per driver holding the § 391.51(b) contents: employment application (391.21), ' +
      'the hire-time MVR, the safety performance history investigation, the road test ' +
      'certificate or accepted equivalent, the annual MVR and annual review note, and the ' +
      'medical certificate — or, for a CDL holder, the CDLIS MVR showing certification status.',
    // Two retention clocks, and a product that models only one of them will
    // either over-retain or delete something it must keep (trap T14).
    // § 391.51(c): the file is kept for as long as the driver is employed AND
    // three years after. § 391.51(d) separately permits five items to be PURGED
    // three years after execution while the driver is still employed. Neither
    // clock is expressible in `Recurrence` today, so they live in this text.
    consequence:
      `${RECORDKEEPING}; an incomplete file is also the evidentiary basis for an ` +
      'unqualified-driver finding and for negligent-hiring exposure. Keep the file for ' +
      'employment + 3 years (391.51(c)).',
  },

  {
    code: 'mvr_inquiry_at_hire',
    title: 'Driving record requested from every state that licensed this driver',
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.23(a)(1), (b)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.23',
    // THIRTY DAYS from the date employment begins, not one month — see the note
    // on ONE_TIME_SCHEDULES for why a month-based recurrence lands late.
    recurrence: { type: 'computed', fn: 'once_30_days_after_hire' },
    // The research expresses this window as 20 / 25 / 30 days AFTER hire.
    // Converted to days-before-due against a hire+30 deadline that is 10 / 5 / 0,
    // and a nudge the day after, because there is no grace beyond day 30.
    warningDays: [10, 5, 0, -1],
    evidence:
      'The MVR itself, in the DQF, from EVERY state in which the driver held a licence or ' +
      'permit in the preceding 3 years — not just the current licensing state. Where a state ' +
      'does not respond, documentation of the good-faith effort.',
    consequence: `${RECORDKEEPING}; operating an unqualified driver.`,
  },

  {
    code: 'safety_performance_history_investigation',
    title: 'Previous employers investigated (3 years) for this driver',
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.23(a)(2), (c), (d), (e)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.23',
    // The same hard 30-day clock as the MVR, from the same anchor — but a
    // separate act, a separate lookback and a separate FILE. Merging the two
    // into one row would let a carrier who pulled the MVR believe it is done.
    recurrence: { type: 'computed', fn: 'once_30_days_after_hire' },
    warningDays: [10, 5, 0, -1],
    evidence:
      'Replies (or documented good-faith efforts) in the DRIVER INVESTIGATION HISTORY FILE — ' +
      'a separate, access-controlled file under § 391.53, NOT the DQF. Covers all DOT-regulated ' +
      'employers of the previous 3 YEARS: accidents per the § 390.15(b)(1) data elements, plus ' +
      'drug and alcohol violations, SAP non-completion and post-SAP testing violations. Since ' +
      '2023-01-06 the FMCSA-employer portion is done through the Clearinghouse (391.23(e)(4)).',
    // Two lookbacks live in the same hiring workflow and are not interchangeable
    // (trap T9). This rule is the FMCSA one: THREE years, § 391.23(e). The Part
    // 40 previous-employer drug and alcohol records check is TWO years,
    // § 40.25(b), and it carries its own 30-day bar on safety-sensitive work
    // under § 40.25(d). Do not let a reviewer "harmonise" these numbers.
    consequence:
      `${RECORDKEEPING}; negligent-hiring exposure. A previous employer has 30 days to ` +
      'reply (391.23(g)(1)); retain the file for employment + 3 years in a secure location ' +
      'with controlled access (391.53(c)).',
  },

  {
    code: 'mvr_inquiry_annual',
    title: 'Annual driving record inquiry for this driver',
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.25(a)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.25',
    // "At least once every 12 months" — a ROLLING interval measured from the last
    // time it was actually done. NOT a calendar year and NOT an anniversary of
    // the hire date. A carrier who pulls MVRs every December is not compliant by
    // virtue of the calendar; a carrier who pulled one on 3 August is due on the
    // following 3 August whatever the calendar says.
    recurrence: { type: 'rolling', intervalMonths: 12, anchor: 'annual_mvr_last_obtained' },
    warningDays: [60, 30, 7, -1],
    evidence:
      'The MVR in the DQF (391.51(b)(4)), requested from every state in which the driver held ' +
      'a licence or permit during the period. A state automatic-monitoring subscription such ' +
      'as the California Employer Pull Notice does not by itself satisfy the INQUIRY.',
    consequence:
      `${RECORDKEEPING}; operating an unqualified driver. Purgeable from the DQF 3 years ` +
      'after execution (391.51(d)).',
  },

  {
    code: 'driving_record_review_annual',
    title: 'Annual review of this driving record, signed and dated',
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.25(b), (c)(2)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.25',
    // A SEPARATE obligation on the same 12-month rolling clock, with its own
    // anchor. Pulling the MVR is § 391.25(a); reading it, judging it and signing
    // a note saying who read it is § 391.25(b). Carriers routinely do the first
    // and not the second, and an auditor asking for the review note is asking
    // for a different piece of paper. Sharing an anchor with the MVR row would
    // mark the review done the moment the MVR arrived.
    recurrence: { type: 'rolling', intervalMonths: 12, anchor: 'annual_review_last_completed' },
    warningDays: [60, 30, 7, -1],
    evidence:
      'A signed, dated note in the DQF NAMING THE REVIEWER. The review must consider the ' +
      "driver's FMCSR and HMR violations and accident record, giving great weight to " +
      'speeding, reckless driving and driving under the influence.',
    consequence:
      `${RECORDKEEPING}; operating an unqualified driver. Purgeable from the DQF 3 years ` +
      'after execution (391.51(d)).',
  },

  {
    code: 'road_test_or_equivalent',
    title: 'Road test passed, or an accepted equivalent on file',
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.31, 391.33',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.31',
    // One-time and NOT recurring. There is no such thing as an annual road test,
    // however many "DQF checklist" products imply one by listing it beside the
    // annual MVR. The driver must be qualified before he drives, so the deadline
    // is the first day of employment.
    recurrence: { type: 'computed', fn: 'once_on_hire_date' },
    warningDays: [14, 7, 0, -7],
    evidence:
      'The road test certificate in the DQF (391.51(b)(3)), or — under § 391.33 — a copy of ' +
      "the valid CDL, or of another carrier's road test certificate issued within the " +
      'preceding 3 years, accepted in lieu of the test.',
    consequence: `${RECORDKEEPING}; operating an unqualified driver.`,
  },

  {
    code: 'medical_certificate_general',
    title: "Medical examiner's certificate — 24-month maximum",
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.45(b), 391.43',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.45',
    // § 391.45(b) is written as a LOOKBACK: a driver may not drive unless he has
    // been examined and certified within the preceding 24 months. The anchor is
    // therefore the EXAMINATION date, not the date the card was handed over or
    // filed.
    //
    // 24 months is a CEILING, not a term. An examiner may certify for any shorter
    // period — three months is routine where a condition needs monitoring — and
    // the printed expiry then governs, not the statutory maximum.
    //
    // So this is an `expiry` rule, anchored on the date printed on the
    // certificate. Encoding `intervalMonths: 24` against the examination date
    // would have made the engine up to 21 months too generous for exactly the
    // drivers whose certificates are short BECAUSE a doctor was worried about
    // them — the wrong answer, for the wrong people, in the forbidden direction.
    //
    // No interval is supplied: there is no cycle to step. The next expiry is
    // read off the next certificate, and until one exists the honest answer is
    // `missing_data`.
    recurrence: { type: 'expiry', anchor: 'medical_certificate_expires' },
    // The ceiling the printed date must respect. Not a schedule — a validity test.
    maxTermMonths: 24,
    // 90 days because the remediation itself takes time: a DOT physical has to
    // be booked, and a driver who discovers the problem on the expiry date is
    // parked.
    warningDays: [90, 45, 14, -1],
    evidence:
      'Non-CDL driver: the certificate itself in the DQF. CDL DRIVER: the CDLIS motor vehicle ' +
      'record from the current licensing state showing medical certification status ' +
      '(391.51(b)(6)(ii)) — NOT the paper card. The transition that allowed the paper copy ran ' +
      'out at the Medical Examiner Certification Integration compliance date of 2025-06-23. A ' +
      'separate FMCSA exemption granted to CVSA lets carriers rely on a paper certificate for ' +
      'up to 60 days from issue while NRII finishes rolling out; that grant expires 2026-10-11 ' +
      'and must be re-checked, not assumed.',
    consequence:
      'Driver placed out of service; operating an unqualified driver. For a CDL holder an ' +
      'expired certification is posted to the CDLIS record and the state must DOWNGRADE THE ' +
      'CDL within 60 days (383.73(q), 384.235) — the loss of the licence privilege, not a ' +
      'paperwork fine.',
    applies: interstateDriver,
  },

  {
    code: 'medical_certificate_intracity_zone',
    title: "Medical examiner's certificate — 12 months (intracity zone exemption)",
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.45(c), 391.62',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.45',
    // A real 12-month variant, modelled separately from the general case rather
    // than as a flag on it, because a rule row is the unit of both explanation
    // and audit: an owner seeing "12 months" needs to see WHICH exemption made
    // it 12 and be able to click the citation.
    recurrence: { type: 'rolling', intervalMonths: 12, anchor: 'medical_exam_date' },
    maxTermMonths: 12,
    warningDays: [90, 45, 14, -1],
    evidence: 'As the general case, plus the intracity zone exemption documentation in the DQF.',
    consequence: 'Driver placed out of service; operating an unqualified driver.',
    // Fails OPEN: without a date proving the exemption we return 'unknown', so an
    // interstate driver carries both this row and the 24-month row. The 12-month
    // one fires first, which is the direction that costs a reminder rather than
    // a driver.
    applies: (ctx) =>
      and(
        interstateDriver(ctx),
        refinement(ctx, ctx.intracityZoneOnly, 'intracity_zone_exemption_issued'),
      ),
  },

  {
    code: 'medical_certificate_insulin_treated',
    title: "Medical examiner's certificate — 12 months (insulin-treated diabetes)",
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.45(e), 391.46',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.46',
    recurrence: { type: 'rolling', intervalMonths: 12, anchor: 'medical_exam_date' },
    maxTermMonths: 12,
    warningDays: [90, 45, 14, -1],
    evidence:
      'As the general case, plus the § 391.46 Insulin-Treated Diabetes Mellitus Assessment ' +
      'Form (MCSA-5870) completed by the treating clinician, dated within the preceding 45 ' +
      'days of the examination, retained in the DQF.',
    consequence: 'Driver placed out of service; operating an unqualified driver.',
    applies: (ctx) =>
      and(
        interstateDriver(ctx),
        refinement(ctx, ctx.insulinTreated, 'insulin_treated_diabetes_assessment'),
      ),
  },

  {
    code: 'medical_certificate_alternative_vision',
    title: "Medical examiner's certificate — 12 months (alternative vision standard)",
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.45(f), 391.44',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.44',
    recurrence: { type: 'rolling', intervalMonths: 12, anchor: 'medical_exam_date' },
    maxTermMonths: 12,
    warningDays: [90, 45, 14, -1],
    evidence:
      'As the general case, plus the § 391.44 Vision Evaluation Report (MCSA-5871) from an ' +
      'ophthalmologist or optometrist, retained in the DQF. This replaced the old federal ' +
      'vision exemption programme — a driver on the alternative standard does not hold a ' +
      'vision exemption letter to renew.',
    consequence: 'Driver placed out of service; operating an unqualified driver.',
    applies: (ctx) =>
      and(
        interstateDriver(ctx),
        refinement(ctx, ctx.alternativeVisionStandard, 'alternative_vision_evaluation'),
      ),
  },

  {
    code: 'spe_certificate_renewal',
    title: 'Skill Performance Evaluation certificate renewal',
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 391.49(h)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-391.49',
    // The research gives no fixed interval for an SPE — "per the certificate's
    // own term". So we read the expiry off the certificate rather than inventing
    // a renewal cycle and being confidently wrong for every driver who holds one.
    recurrence: { type: 'computed', fn: 'once_on_spe_certificate_expiry' },
    warningDays: [90, 45, 14, -1],
    evidence:
      'A copy of the SPE certificate in the DQF (391.51(b)(7)). Purgeable from the file 3 ' +
      'years after execution while the driver is still employed (391.51(d)).',
    consequence:
      'Operating an unqualified driver: without a current SPE the underlying limb impairment ' +
      'disqualifies the driver under § 391.41(b)(1)-(2).',
    // Never returns false, because RuleContext has no "holds an SPE" boolean.
    // Every driver therefore carries this row in `missing_data` until somebody
    // answers, which is noisy for a rule that touches well under 1% of drivers.
    // This is the clearest case for adding boolean driver facts to RuleContext.
    applies: (ctx) => refinement(ctx, ctx.holdsSpeCertificate, 'spe_certificate_expiry'),
  },

  // -------------------------------------------------------------------------
  // 49 CFR Part 382 / Part 40 — controlled substances and alcohol
  // -------------------------------------------------------------------------

  {
    code: 'clearinghouse_query_pre_employment',
    title: 'Pre-employment full Clearinghouse query',
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 382.701(a)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-382.701',
    // Before the driver performs ANY safety-sensitive function — so the last safe
    // moment is the first day of employment, and there is no 30-day allowance
    // here of the kind § 391.23 gives the MVR.
    recurrence: { type: 'computed', fn: 'once_on_hire_date' },
    warningDays: [14, 7, 0, -1],
    evidence:
      "The full query record, retained 3 years (382.701(e)). Requires the driver's specific " +
      'ELECTRONIC consent given in the Clearinghouse — a signed paper form does not work for a ' +
      'full query. Note that § 40.25(a)(2) cites "49 CFR 382.71(a)", a section that does not ' +
      'exist; the correct cite is 382.701(a) and DOT has acknowledged the typo without fixing it.',
    consequence:
      `Using a prohibited driver; ${CLEARINGHOUSE_PENALTY}. Separately, § 40.25(d) bars the ` +
      'driver from safety-sensitive functions after 30 days unless the previous-employer ' +
      'information (the 2-YEAR lookback of 40.25(b), not the 3-year one of 391.23(e)) was ' +
      'obtained or a good-faith effort documented.',
    applies: part382Driver,
  },

  {
    code: 'clearinghouse_query_annual',
    title: 'Annual Clearinghouse query for this driver',
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 382.701(b)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-382.701',
    // ⚠️ THERE IS NO 31 JANUARY DEADLINE. The claim is everywhere — in trade
    // press, in competitor marketing, in half the "Clearinghouse checklist" PDFs
    // on the internet — and it is wrong. § 382.701(b) says "at least once per
    // year" per driver, which is a ROLLING 365 days from that driver's last
    // query. A carrier who queried a driver on 3 August 2026 is due on 3 August
    // 2027, not on the following 31 January. Encoding a January date would make
    // every driver queried after February look compliant for up to eleven months
    // he is not.
    recurrence: { type: 'rolling', intervalMonths: 12, anchor: 'clearinghouse_query_last_run' },
    warningDays: [60, 30, 7, -1],
    evidence:
      'The query record, retained 3 years (382.701(e)). A LIMITED query suffices where the ' +
      'driver has given written consent, and that consent may be drafted to cover more than ' +
      'one year. If a limited query shows information exists, a FULL query must follow within ' +
      '24 hours, and until it does the driver may not perform safety-sensitive functions.',
    consequence:
      `Using a prohibited driver; ${CLEARINGHOUSE_PENALTY}. Clearinghouse recordkeeping sits ` +
      'under App. B(b), not under the (a)(1) recordkeeping line, because (a)(1) covers Part ' +
      '382 subparts A-F and excludes subpart G.',
    applies: part382Driver,
  },

  {
    code: 'random_controlled_substances_testing_rate',
    title: 'Random drug testing — 50% of driver positions for the calendar year',
    // Pool-level, not per-driver. It reaches the catalogue through the driver
    // chapter, but the obligation is "50% of the AVERAGE NUMBER OF DRIVER
    // POSITIONS", which is a property of the carrier. Fanning it out to every
    // driver would produce N identical rows saying the same thing about one pool.
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 CFR 382.305(b)(2), (k)(2)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-382.305',
    // The measurement period is the CALENDAR YEAR, so it closes on 31 December.
    //
    // ⚠️ This is deliberately NOT quarterly. § 382.305(k)(2) requires only that
    // test dates be "spread reasonably throughout the calendar year"; the word
    // "quarter" does not appear anywhere in Part 382. Quarterly selection is
    // near-universal practice and a sensible default for a consortium, but it is
    // best practice, not a citable deadline, and must never be presented as one.
    recurrence: { type: 'fixed_calendar', months: [12], day: 'last' },
    // 90 days out is roughly the 75%-of-the-year mark, which is the last point
    // at which a carrier who is behind can still catch up without the catching-up
    // itself being unreasonably bunched.
    warningDays: [90, 60, 30, -1],
    evidence:
      'Selection records and results for the year, retained 5 years (382.401(b)(1)), showing ' +
      'the completed test count against 50% of the average number of driver positions. ' +
      'Selections must be made by a scientifically valid method and be UNANNOUNCED.',
    // The rate is codified in the CFR itself, not merely announced. FMCSA's most
    // recent annual rate notice is 84 FR 71527 (2019-12-27); no notice has been
    // published since, and under § 382.305(c)/(f) a changed rate takes effect the
    // January 1 AFTER publication, so the rate simply persists. Do not go looking
    // for a 2026 notice, and do not let anyone "update" this to 25%.
    consequence: `${PART382_EMPLOYER}; drivers placed out of service.`,
    applies: part382Driver,
  },

  {
    code: 'random_alcohol_testing_rate',
    title: 'Random alcohol testing — 10% of driver positions for the calendar year',
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 CFR 382.305(b)(1), (k)(2)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-382.305',
    // Same calendar-year close as the drug rate, but a DIFFERENT rate in a
    // different subsection. Kept as its own row because a carrier can satisfy one
    // and miss the other, and a single merged row could not say which.
    recurrence: { type: 'fixed_calendar', months: [12], day: 'last' },
    warningDays: [90, 60, 30, -1],
    evidence:
      'Selection records and results for the year, retained 5 years for results at or above ' +
      '0.02 (382.401(b)(1)) and 1 year for results below 0.02 (382.401(b)(3)) — the "2 years" ' +
      'bucket is the collection-process records at 382.401(b)(2), not negatives.',
    consequence: `${PART382_EMPLOYER}; drivers placed out of service.`,
    applies: part382Driver,
  },

  {
    code: 'supervisor_reasonable_suspicion_training',
    title: 'Supervisor reasonable-suspicion training — 120 minutes, once',
    // The subject is really a non-driver employee. `Subject` has no 'employee'
    // member, so this sits on the carrier: a supervisor is not a driver, and
    // filing it under 'driver' would fan one person's training out across the
    // whole roster.
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 CFR 382.603',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-382.603',
    // ⚠️ NOT ANNUAL. § 382.603 ends with the sentence "Recurrent training for
    // supervisory personnel is not required." It is one-time per supervisor:
    // 60 minutes on alcohol misuse plus 60 minutes on controlled substances.
    // Training vendors sell an annual refresher, which is a fine thing to buy and
    // not a thing to put a deadline on.
    recurrence: { type: 'computed', fn: 'once_on_supervisor_designation' },
    // The -30 nudge is the point the research treats as actionable: 30 days after
    // designation with no training recorded. It is a product judgement, not a
    // regulatory grace period — the regulation states no deadline at all.
    warningDays: [14, 7, 0, -30],
    evidence:
      'The training record for the individual. Retention is the odd one: kept for as long as ' +
      'the person performs the function AND FOR TWO YEARS AFTER they stop (382.401(b)(4)) — ' +
      'so a supervisor who moves on takes a live retention clock with them.',
    consequence:
      `${PART382_EMPLOYER}. Without a trained supervisor the carrier cannot lawfully make a ` +
      'reasonable-suspicion determination at all, which turns an observed impairment into an ' +
      'unusable observation.',
    applies: part382Driver,
  },

  {
    code: 'return_to_duty_follow_up_testing',
    title: 'Return-to-duty follow-up testing plan',
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 382.309, 40.307',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-40.307',
    // Resolves to `unsupported`, on purpose — see registerReturnToDutyFollowUp.
    // Six unannounced tests somewhere inside twelve months, at dates the employer
    // chooses, is not an interval and we will not invent one.
    recurrence: { type: 'computed', fn: RTD_FOLLOW_UP_FN },
    warningDays: [30, 14, 7, -1],
    evidence:
      'The SAP report, the written follow-up testing plan and the test results, retained 5 ' +
      'years. The return-to-duty test itself comes first and must be directly observed ' +
      '(40.67(b)). A CANCELLED follow-up test does not count and must be recollected (40.309). ' +
      'The plan FOLLOWS THE EMPLOYEE to later employers and through breaks in service ' +
      '(40.307(e)) — a new hire can arrive already carrying one.',
    consequence:
      'Using a prohibited driver. Never give the driver the schedule, a copy of it, or any ' +
      'hint of its frequency or duration (40.307(g)) — that prohibition binds the employer, ' +
      'the SAP and any service agent.',
    applies: part382Driver,
  },
]
