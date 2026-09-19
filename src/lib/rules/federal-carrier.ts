/**
 * The federal catalogue: what a carrier and its vehicles owe Washington.
 *
 * Everything here is a ROW. The only code in the file is a handful of named
 * schedules registered with the engine, and each of those exists because the
 * cadence is genuinely an algorithm rather than an interval — never because a
 * rule was inconvenient to express as data.
 *
 * Three house rules, all earned from docs/research/compliance-traps.md:
 *
 *   1. Cite the section that is actually in force. § 390.19 is suspended and
 *      Mexico-only; § 390.19T is the live one (T1). This is the single most
 *      repeated error in the industry's own paperwork, and it is checkable,
 *      which is exactly why we must not repeat it.
 *   2. Never invent a date. Where an obligation truly has no schedule — a
 *      liability filing that runs until cancelled, a DVIR that happens when a
 *      driver finds a defect — the honest answer is `unsupported`, carrying the
 *      period or the trigger in its reason so the owner knows what to go and
 *      look at. A plausible-looking wrong date is worse than no date.
 *   3. `applies` fails OPEN. It returns `false` only where every deciding fact
 *      is known and negative. Anything less is `'unknown'`, which the engine
 *      tracks. One needless reminder costs a minute; one missed inspection
 *      costs the truck.
 *
 * Verified against docs/research/compliance-federal-rules.md (eCFR Title 49
 * snapshot 2026-09-11). `verifiedBy`/`verifiedOn` are deliberately NOT set on
 * any row here: those fields mean a qualified human signed off, and nobody has.
 */
import { mcs150Schedule, mcs150Status } from '../mcs150.ts'
import type { ComputedFn } from './compute.ts'
import { registerComputed } from './compute.ts'
import { addMonthsClamped, lastDayOfMonth, toUtcMidnight, utcDate } from './dates.ts'
import type { Applicability, Outcome, RuleContext, RuleDefinition } from './types.ts'

// ---------------------------------------------------------------------------
// Anchor names
// ---------------------------------------------------------------------------
//
// An anchor name is DATA: it keys `ctx.anchors` and it comes straight back out
// of `missing_data.needs`, so it is also the thing the UI has to turn into a
// question for the owner. Keep them stable — they end up on stored rows.

/** Date of the last passing § 396.17 periodic inspection for this unit. */
const PERIODIC_INSPECTION = 'periodic_inspection_date'

/**
 * The 31 December ending the last UCR registration year the carrier has paid
 * for. The owner self-reports a YEAR; we store the last day of it. See the UCR
 * rule below for why this is an anchor and not a fixed calendar date.
 */
const UCR_PAID_THROUGH = 'ucr_paid_through'

/** A date inside the month this power unit was first used on public highways. */
const HVUT_FIRST_USE = 'hvut_first_use_date'

/** Date of the accident this register entry records (§ 390.5 definition). */
const ACCIDENT_DATE = 'accident_date'

/** Date of this hazmat employee's last § 172.704 training. */
const HAZMAT_TRAINING = 'hazmat_training_date'

// ---------------------------------------------------------------------------
// Applicability predicates
// ---------------------------------------------------------------------------

/**
 * Is this unit a commercial motor vehicle at all? (§ 390.5T)
 *
 * The definition is "GVWR, GCWR, GVW or GCW, **whichever is greater**, of
 * 10,001 pounds or more", OR placarded hazmat at any weight, OR the passenger
 * thresholds. `RuleContext` carries only `gvwrLbs`, which is the weakest of the
 * four weight figures.
 *
 * So: placarded hazmat settles it yes; a GVWR at or over the line settles it
 * yes; and we return `false` only when weight AND hazmat are both known and
 * both negative. Even that last branch carries residual risk — a 9,000 lb unit
 * coupled into a heavier combination IS a CMV and we have no GCWR to see it
 * with. That is a known gap, not an oversight.
 */
function isCmv(ctx: RuleContext): Applicability {
  if (ctx.hazmat === true) return true
  if (ctx.gvwrLbs === undefined) return 'unknown'
  if (ctx.gvwrLbs >= 10_001) return true
  if (ctx.hazmat === undefined) return 'unknown'
  return false
}

/**
 * Does this carrier haul hazardous materials?
 *
 * One boolean stands in for a family of distinctions (placarded vs not, the six
 * quantity triggers in § 107.601(a), the sixteen in § 172.800(b)). Where that
 * matters, the rule says so in its own comment.
 */
function isHazmat(ctx: RuleContext): Applicability {
  return ctx.hazmat === undefined ? 'unknown' : ctx.hazmat
}

/**
 * Does the carrier owe the biennial MCS-150 update?
 *
 * § 390.19T(a) reaches carriers operating in interstate commerce, and intrastate
 * carriers hauling quantities of hazmat requiring placarding. It does NOT reach
 * a plain intrastate carrier by its own terms — but every state that issues
 * USDOT numbers requires the update through its own rules, and we have not
 * verified California's. `'unknown'`, not `false`: we are not going to tell an
 * intrastate carrier they are clear of a filing whose failure deactivates their
 * number.
 *
 * Also unverified and deliberately ignored: § 390.19T(i) exempts carriers
 * registering vehicles in a PRISM state that file everything with the State.
 * Relying on it would require per-state verification we do not have.
 */
function filesMcs150(ctx: RuleContext): Applicability {
  if (ctx.carrierOperation === 'A') return true
  if (ctx.hazmat === true) return true
  return 'unknown'
}

/**
 * Is this power unit inside the Form 2290 net?
 *
 * The threshold is a **taxable gross weight** of 55,000 lb, which the IRS
 * defines as the actual unloaded weight of the vehicle plus any trailers
 * customarily used plus the maximum customary load. That is NOT the GVWR: a
 * 33,000 lb tractor pulling a loaded trailer is comfortably over the line.
 *
 * So GVWR can put a unit IN, and can never rule one OUT. This predicate
 * therefore never returns `false`, which is deliberate: HVUT non-filing blocks
 * the DMV registration, and a missing stamped Schedule 1 is discovered at the
 * counter, on the day, with the truck parked.
 */
function maybeHvutTaxable(ctx: RuleContext): Applicability {
  if (ctx.gvwrLbs !== undefined && ctx.gvwrLbs >= 55_000) return true
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Named schedules
// ---------------------------------------------------------------------------

/**
 * MCS-150, 49 CFR 390.19T(b).
 *
 * The arithmetic stays in src/lib/mcs150.ts — tested, and already behind the
 * public USDOT lookup. Re-deriving the digit logic here would leave two
 * implementations to keep in step, and the second one is always the one that
 * drifts. This is a thin adapter and nothing more.
 *
 * `previous` matters as much as `next`. The whole point of that module's
 * doc comment is that the next date alone reads as years of slack to somebody
 * whose USDOT number is already deactivated.
 */
registerComputed('mcs150', {
  next(ctx: RuleContext): Outcome {
    const dot = ctx.dotNumber?.trim()
    if (!dot) return { kind: 'missing_data', needs: ['dot_number'] }
    if (!/^\d+$/.test(dot)) {
      // The schedule is read off the digits. Anything else is not a USDOT
      // number, and guessing a month from it would be fabrication.
      return { kind: 'unsupported', reason: `'${dot}' is not a USDOT number` }
    }
    return { kind: 'due', on: mcs150Schedule(dot, toUtcMidnight(ctx.today)).nextDue }
  },
  previous(ctx: RuleContext): Date | null {
    const dot = ctx.dotNumber?.trim()
    if (!dot || !/^\d+$/.test(dot)) return null
    // mcs150Status already derives the previous deadline from the same
    // schedule; asking it with a null filing date gets that number without
    // duplicating the biennial step.
    return mcs150Status(dot, null, toUtcMidnight(ctx.today)).lastDue
  },
})

/**
 * Form 2290's two deadlines for one truck.
 *
 * The tax period runs 1 July – 30 June. A vehicle first used in July is filed
 * for between 1 July and 31 August. Anything else is prorated and due **the
 * last day of the month following the month of first use** — so a truck bought
 * in November owes a return by 31 December, and a fleet with three mid-year
 * acquisitions has three different deadlines. Treating 2290 as one annual fleet
 * date is the error this function exists to prevent.
 */
function hvutSchedule(firstUse: Date) {
  const y = firstUse.getUTCFullYear()
  const m = firstUse.getUTCMonth() + 1
  // "the last day of the month following the month of first use" — December
  // rolls into the following January.
  const prorated = m === 12 ? lastDayOfMonth(y + 1, 1) : lastDayOfMonth(y, m + 1)
  // After that first return the truck is simply in service, so it is taxed for
  // every period thereafter and each period's return is due 31 August. A unit
  // first used in July–December was taxed for the period it is already in, so
  // its first annual 31 August falls the NEXT calendar year; one first used in
  // January–June was taxed for a period ending this 30 June, so its first
  // annual 31 August is this year.
  const firstAnnualYear = m >= 7 ? y + 1 : y
  return { prorated, firstAnnualYear }
}

registerComputed('form2290', {
  next(ctx: RuleContext): Outcome {
    const firstUse = ctx.anchors?.[HVUT_FIRST_USE]
    if (!firstUse) return { kind: 'missing_data', needs: [HVUT_FIRST_USE] }
    const today = toUtcMidnight(ctx.today)
    const { prorated, firstAnnualYear } = hvutSchedule(toUtcMidnight(firstUse))
    if (today <= prorated) return { kind: 'due', on: prorated }
    const y = Math.max(firstAnnualYear, today.getUTCFullYear())
    const august = utcDate(y, 8, 31)
    return { kind: 'due', on: august >= today ? august : utcDate(y + 1, 8, 31) }
  },
  previous(ctx: RuleContext): Date | null {
    const firstUse = ctx.anchors?.[HVUT_FIRST_USE]
    if (!firstUse) return null
    const today = toUtcMidnight(ctx.today)
    const { prorated, firstAnnualYear } = hvutSchedule(toUtcMidnight(firstUse))
    // Still inside the first window: nothing has been missed yet.
    if (today <= prorated) return null
    const thisYear = utcDate(today.getUTCFullYear(), 8, 31)
    const august = thisYear < today ? thisYear : utcDate(today.getUTCFullYear() - 1, 8, 31)
    // Before the first annual 31 August, the prorated return is the only
    // deadline that has passed.
    return august >= utcDate(firstAnnualYear, 8, 31) ? august : prorated
  },
})

/**
 * A retention window: "keep this until", not "do this by".
 *
 * The `Recurrence` algebra has no variant for a record-retention clock, and the
 * nearest fit — `anniversary` — is actively wrong, because it would step the
 * date forward another interval once the window closed and announce a 28-month
 * deadline on a 14-month obligation. So it is computed, it happens once, and it
 * offers no `previous`.
 *
 * Read the resulting date as the first day the record may be destroyed. The
 * violation here is destroying it EARLY; the date is a floor, not a ceiling.
 * The type system cannot say that, so each rule says it in `consequence`.
 *
 * Retention is modelled this way only where the record is a discrete, sparse
 * event the owner can point at — one inspection per unit per year, one entry
 * per accident. Daily, high-volume records (RODS, supporting documents, ELD
 * backups) get an `unsupported` rule instead, because a single anchor date
 * cannot stand for a rolling window over every day's paperwork.
 */
function keepUntil(anchor: string, months: number): ComputedFn {
  return (ctx: RuleContext): Outcome => {
    const from = ctx.anchors?.[anchor]
    if (!from) return { kind: 'missing_data', needs: [anchor] }
    return { kind: 'due', on: addMonthsClamped(toUtcMidnight(from), months) }
  }
}

/**
 * An obligation that is real, continuous and genuinely undated.
 *
 * `unsupported` is the vocabulary for "you owe this, and we will not invent
 * when — go and look". The reason string is the whole product value of these
 * rows, so it must carry the period or the trigger, not a shrug.
 */
function noSchedule(reason: string): ComputedFn {
  return (): Outcome => ({ kind: 'unsupported', reason })
}

registerComputed('retain.periodicInspection', keepUntil(PERIODIC_INSPECTION, 14))
registerComputed('retain.accidentRegister', keepUntil(ACCIDENT_DATE, 36))

registerComputed(
  'continuous.dvir',
  noSchedule(
    'Event-driven, not scheduled: a written report is required at the end of a ' +
      "day's work only where the driver finds or is told of a defect. The carrier " +
      'must certify the repair on that report before the vehicle is used again, and ' +
      'keep it three months.',
  ),
)

registerComputed(
  'continuous.brakeInspector',
  noSchedule(
    'One-time qualification per person, with no recertification interval. Check ' +
      'that evidence exists for everyone who inspects, maintains, services or ' +
      'repairs brakes, and keep it for their employment plus one year.',
  ),
)

registerComputed(
  'continuous.operatingAuthority',
  noSchedule(
    'Operating authority has no expiry date. It stays in effect only as long as ' +
      'the security requirements are satisfied, so the thing to watch is the ' +
      'insurance filing and any cancellation notice, never a renewal date.',
  ),
)

registerComputed(
  'continuous.insuranceFiling',
  noSchedule(
    'A BMC-91X liability filing has no expiry date; it is continuous until ' +
      'cancelled. Check that a filing is on file and that the amount meets the ' +
      'minimum for what you haul. Cancellation gives 35 days notice insurer to ' +
      'insured, and the FMCSA filing lapses 30 days after Form BMC-35/36 reaches ' +
      'FMCSA — that is notice before the lapse, not grace after it.',
  ),
)

registerComputed(
  'continuous.rodsRetention',
  noSchedule(
    'A rolling window over every record, not a single date: each record of duty ' +
      'status is kept at least six months from receipt. Check the oldest record on ' +
      'hand. Drivers submit within 13 days and carry the previous 7 consecutive days.',
  ),
)

registerComputed(
  'continuous.supportingDocuments',
  noSchedule(
    'A rolling window over every day, not a single date: up to eight supporting ' +
      'documents per driver per 24 hours, kept six months. Where more than eight ' +
      'exist, the eight retained must include the earliest and latest time ' +
      'indications of the day.',
  ),
)

registerComputed(
  'continuous.eldBackup',
  noSchedule(
    'A rolling six-month window, and a separate obligation from keeping the RODS ' +
      'themselves: the back-up copy must live on a device other than the one ' +
      'holding the original data.',
  ),
)

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * Exported so callers that seed this rule's completion date cannot mistype it.
 * A `computed` rule stores its last-done date under its own code, and a typo
 * there is an anchor nothing ever reads — the row would compute the right date
 * and still report "not sure" forever.
 */
export const MCS150_RULE_CODE = 'fed.390.19T.mcs150-biennial-update'

export const federalCarrierRules: RuleDefinition[] = [
  // -------------------------------------------------------------------------
  // Vehicle — 49 CFR Part 396
  // -------------------------------------------------------------------------

  {
    /**
     * "at least once during the preceding 12 months" — a rolling look-back from
     * the last passing inspection, evaluated at the moment of use, NOT a fixed
     * anniversary month.
     *
     * Power unit and trailer are separate rows because § 396.17(a) inspects each
     * unit of a combination separately: tractor, semitrailer, full trailer and
     * converter dolly each carry their own clock and their own paperwork.
     *
     * One deliberate conservatism: for an inspection performed under a State
     * programme, § 396.17(f) runs the 12 months from the last day of the month
     * in which it was done. Rolling from the inspection date itself lands
     * earlier in the month than that, which is the safe direction to be wrong.
     */
    code: 'fed.396.17.periodic-inspection.power-unit',
    title: 'Annual DOT inspection — power unit',
    jurisdiction: 'federal',
    subject: 'power_unit',
    citation: '49 CFR 396.17',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-396.17',
    recurrence: { type: 'rolling', intervalMonths: 12, anchor: PERIODIC_INSPECTION },
    warningDays: [60, 30, 7, -1],
    evidence:
      'The inspection report, or a sticker or decal carrying the four data ' +
      'elements in 396.17(c)(2) — and it travels ON the vehicle, not in the office.',
    consequence:
      'Vehicle placed out of service at roadside, plus 49 U.S.C. 521(b) penalties. ' +
      'A parked truck is the bill, not the fine.',
    /**
     * `truck`. docs/product/DATE-PRIORITY.md § 5.2 records a disagreement with
     * the TONE of the sentence above — it reads like a company-stopper — but
     * lands on the same tier this value comes from, and agrees with
     * src/lib/dispatch/eligibility.ts that this warns rather than blocks: an
     * expired annual inspection does not make the DRIVER unqualified, and a
     * shop can do the inspection the same afternoon. So the value is unchanged
     * by that disagreement; what the document asks for is that this row read
     * LOUDER than the other warn-level vehicle rows beside it, which is a
     * ranking within `truck` that this field cannot express.
     */
    impact: 'truck',
    applies: isCmv,
  },

  {
    // Same obligation, separate unit, separate clock. See the power-unit row.
    code: 'fed.396.17.periodic-inspection.trailer',
    title: 'Annual DOT inspection — trailer',
    jurisdiction: 'federal',
    subject: 'trailer',
    citation: '49 CFR 396.17',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-396.17',
    recurrence: { type: 'rolling', intervalMonths: 12, anchor: PERIODIC_INSPECTION },
    warningDays: [60, 30, 7, -1],
    evidence:
      'The inspection report, or a sticker or decal carrying the four data ' +
      'elements in 396.17(c)(2), on the trailer itself.',
    consequence: 'Trailer placed out of service at roadside, plus 49 U.S.C. 521(b) penalties.',
    impact: 'truck',
    applies: isCmv,
  },

  {
    /**
     * Fourteen months, and kept "where the vehicle is either housed or
     * maintained" — which is a different place from the copy § 396.17(c) makes
     * ride on the vehicle. Two obligations, one inspection.
     */
    code: 'fed.396.21.inspection-report-retention.power-unit',
    title: 'Keep the annual inspection report — power unit',
    jurisdiction: 'federal',
    subject: 'power_unit',
    citation: '49 CFR 396.21(b)(1)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-396.21',
    recurrence: { type: 'computed', fn: 'retain.periodicInspection' },
    warningDays: [30],
    evidence: 'The original or a copy of the report, where the vehicle is housed or maintained.',
    consequence:
      'Destroying it before this date is the violation: recordkeeping penalties of ' +
      '$1,584 a day up to $15,846 (49 CFR 386 App. B(a)(1), 2025 amounts). After ' +
      'this date it may be discarded.',
    impact: 'record',
    applies: isCmv,
  },

  {
    // Same 14 months, separate unit — one report per inspected unit.
    code: 'fed.396.21.inspection-report-retention.trailer',
    title: 'Keep the annual inspection report — trailer',
    jurisdiction: 'federal',
    subject: 'trailer',
    citation: '49 CFR 396.21(b)(1)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-396.21',
    recurrence: { type: 'computed', fn: 'retain.periodicInspection' },
    warningDays: [30],
    evidence: 'The original or a copy of the report, where the trailer is housed or maintained.',
    consequence:
      'Destroying it before this date is the violation: recordkeeping penalties of ' +
      '$1,584 a day up to $15,846. After this date it may be discarded.',
    impact: 'record',
    applies: isCmv,
  },

  {
    /**
     * The trap here is the opposite of the usual one: a no-defect DVIR is NOT
     * required for property-carrying operations, and selling a daily "you must
     * file a DVIR" reminder would be selling a requirement that does not exist.
     *
     * Two exemptions we cannot express: § 396.11(a)(5) exempts a carrier
     * operating only ONE commercial motor vehicle — which is a very large share
     * of the LA market — and driveaway-towaway operations are out as well.
     * `RuleContext` carries no fleet size and no operation style, so this row
     * applies to every CMV and over-reports for owner-operators. Flagged, not
     * silently guessed at.
     */
    code: 'fed.396.11.dvir',
    title: 'Driver vehicle inspection report',
    jurisdiction: 'federal',
    subject: 'power_unit',
    citation: '49 CFR 396.11',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-396.11',
    recurrence: { type: 'computed', fn: 'continuous.dvir' },
    warningDays: [],
    evidence:
      'The DVIR, the carrier certification that the defect was repaired, and the ' +
      "next driver's review signature. Electronic format is expressly permitted " +
      'since 2026-03-23.',
    consequence:
      'Vehicle out of service until repaired, plus recordkeeping penalties of ' +
      '$1,584 a day up to $15,846.',
    impact: 'audit',
    applies: isCmv,
  },

  {
    /**
     * Filed against the carrier, not the person, because `Subject` has no
     * 'employee' — and because § 396.25(a) puts the duty on the carrier to
     * ensure the inspector is qualified, which is the honest reading anyway.
     *
     * No recurrence: the qualification is a one-time determination. A person who
     * has passed the CDL air brake knowledge and skills test needs no separate
     * qualification for air brake inspections.
     */
    code: 'fed.396.25.brake-inspector-qualification',
    title: 'Brake inspector qualification',
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 CFR 396.25',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-396.25',
    recurrence: { type: 'computed', fn: 'continuous.brakeInspector' },
    warningDays: [],
    evidence:
      'Evidence of training and experience for each brake inspector, kept at the ' +
      'principal place of business or where the inspector works, for employment ' +
      'plus one year.',
    consequence: 'Non-recordkeeping penalties up to $19,246 per violation (App. B(a)(3)).',
    impact: 'audit',
  },

  // -------------------------------------------------------------------------
  // Carrier registration, filings and taxes
  // -------------------------------------------------------------------------

  {
    /**
     * § 390.19**T**. Not § 390.19, which was suspended in 2017, briefly amended
     * and re-suspended indefinitely in 2023, and whose current text is titled
     * "Motor carrier identification reports for certain Mexico-domiciled motor
     * carriers". Getting this citation right is the cheapest credibility we
     * will ever buy, because the audience can check it in one click.
     *
     * Month = the LAST digit of the USDOT number (0 means October — there is no
     * November or December filing month). Year parity = the NEXT-TO-LAST digit.
     * Due the last day of that month.
     *
     * It is due even if nothing has changed, and even if the carrier has stopped
     * operating. The rule text is unconditional, and the owners who get caught
     * are almost always the ones who assumed "no changes" meant "no filing".
     *
     * Do not infer compliance from an ACTIVE status on the federal record:
     * FMCSA does not reliably flip carriers to INACTIVE for a missed update.
     */
    code: 'fed.390.19T.mcs150-biennial-update',
    title: 'MCS-150 biennial update',
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 CFR 390.19T(b)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-390.19T',
    recurrence: { type: 'computed', fn: 'mcs150' },
    // The negative entries are product policy, not regulation: deactivation is
    // silent, so somebody who missed the date needs chasing after it, not only
    // before it.
    warningDays: [90, 45, 14, -1, -30],
    evidence: 'The MCS-150 confirmation, and the filing date on the federal record.',
    consequence:
      'Deactivation of the USDOT number — which puts every vehicle in violation of ' +
      '392.9b — plus penalties under 49 U.S.C. 521(b)(2)(B) or 14901(a) ' +
      '($1,365–$10,269 under App. B(g)(16)).',
    impact: 'company',
    applies: filesMcs150,
  },

  {
    /**
     * UCR is annual by registration year: registration opens 1 October and the
     * fee is due before 1 January of the year it covers.
     *
     * So why an anchor rather than a fixed 31 December? Because the deadline is
     * not the hard part — knowing whether they paid is. There is no UCR API and
     * no derivable status: the national lookup is reCAPTCHA-gated, and scraping
     * past that is on the wrong side of the site terms. The owner self-reports
     * the last registration year they paid for, we store the 31 December that
     * ends it, and the anniversary lands on the next 31 December. With no
     * anchor the rule reports `missing_data`, which is the truth — far better
     * than a confident date next to an unknown payment.
     *
     * Note for whoever computes the fee: the power-unit count is an either/or
     * election under 49 U.S.C. 14504a(f)(3) — the most recent MCS-150 figure OR
     * the total owned or operated for the 12 months ending 30 June of the prior
     * year — and it is not necessarily the MCS-150 number.
     */
    code: 'fed.ucr.annual-registration',
    title: 'UCR annual registration',
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 CFR Part 367; 49 U.S.C. 14504a',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/part-367',
    recurrence: { type: 'anniversary', intervalMonths: 12, anchor: UCR_PAID_THROUGH },
    warningDays: [60, 30, 7, -1],
    evidence: 'The UCR receipt for the registration year.',
    consequence:
      'Citations and fines at roadside under state law — the amounts are purely ' +
      'state law, and California is a participating state.',
    impact: 'money',
    applies(ctx: RuleContext): Applicability {
      // UCR reaches interstate carriers, brokers, freight forwarders and leasing
      // companies (49 U.S.C. 14504a(a)(1)). An intrastate-only carrier is
      // outside it, so a positive intrastate code — 'B' or 'C' — answers no,
      // the same answer the IFTA and IRP gates in ./california.ts give on the
      // same code, and the answer docs/product/DATE-PRIORITY.md § 4.1 expects.
      //
      // This gate used to answer 'unknown' for 'B'/'C' on the ground that the
      // code is self-reported. It is — but the same is true of the IFTA and IRP
      // gates, and the three disagreeing put an intrastate carrier's UCR on his
      // board while his IFTA was off it. The self-report is now something the
      // owner can correct on /app/settings, and a missing code still fails
      // open here.
      if (ctx.carrierOperation === undefined) return 'unknown'
      return ctx.carrierOperation === 'A'
    },
  },

  {
    /**
     * Form 2290 is NOT one annual fleet date. The tax period is 1 July – 30
     * June; a vehicle in use in July is filed for by 31 August, and anything
     * else is prorated and due the last day of the month FOLLOWING first use.
     * Every mid-year acquisition therefore creates its own deadline, which is
     * why this is a power-unit row and not a carrier row.
     *
     * A suspended vehicle — under 5,000 miles, or 7,500 agricultural — still has
     * to be reported on the return even though no tax is owed.
     */
    code: 'fed.irs.2290.heavy-vehicle-use-tax',
    title: 'Form 2290 heavy vehicle use tax',
    jurisdiction: 'federal',
    subject: 'power_unit',
    citation: 'IRC 4481; IRS Form 2290',
    sourceUrl: 'https://www.irs.gov/businesses/small-businesses-self-employed/trucking-tax-center',
    recurrence: { type: 'computed', fn: 'form2290' },
    warningDays: [60, 30, 7, -1],
    evidence:
      'The stamped Schedule 1. The DMV will ask for it, so it is worth more than ' + 'the receipt.',
    consequence:
      'Penalties and interest, and — the one that actually bites — the state will ' +
      'not register or re-register the vehicle without the stamped Schedule 1.',
    impact: 'truck',
    applies: maybeHvutTaxable,
  },

  {
    /**
     * Modelling authority as something that "expires" is a documented trap.
     * 49 U.S.C. 13906(a)(1): a registration "remains in effect only as long as
     * the registrant continues to satisfy the security requirements". There is
     * no renewal date to put in a calendar, and putting one there would teach
     * the owner to watch the wrong thing.
     */
    code: 'fed.usc.13906.operating-authority',
    title: 'Operating authority stays live only while insured',
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 U.S.C. 13906(a)(1)',
    sourceUrl: 'https://www.law.cornell.edu/uscode/text/49/13906',
    recurrence: { type: 'computed', fn: 'continuous.operatingAuthority' },
    warningDays: [],
    evidence:
      "FMCSA's operating authority status for the docket. The docket status code " +
      'on the census record is NOT the same field and must not be read as one.',
    consequence:
      'Suspension and then revocation — revocation only after a compliance order ' +
      'and 30 days of wilful non-compliance (49 U.S.C. 13905(e)).',
    impact: 'company',
  },

  {
    /**
     * There is deliberately NO "insurance expires" rule in this catalogue.
     * A BMC-91X filing carries no expiry date — it is continuous until
     * cancelled — so any date we put against it would be invented. The
     * underlying commercial policy does renew, but that renewal date is the
     * insurer's fact, not ours, and we have no source for it.
     *
     * What we can say honestly is whether a filing exists and whether the amount
     * on file meets the minimum: $750,000 for for-hire non-hazardous property at
     * 10,001 lb GVWR or more, $1,000,000 for oil and most hazmat, $5,000,000 for
     * bulk high-hazard commodities. Unchanged since 1985 in nominal terms; the
     * 2014 proposal to raise them was withdrawn in 2017.
     *
     * SCOPING THIS TO FOR-HIRE CARRIERS: the gate is written, and today it
     * still lets every carrier through. See `applies` below for exactly why,
     * and for the one field that would close it.
     */
    code: 'fed.387.9.liability-insurance-filing',
    title: 'Liability insurance on file with FMCSA',
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 CFR 387.9, 387.7(b)(1), 387.313T(d)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-387.9',
    recurrence: { type: 'computed', fn: 'continuous.insuranceFiling' },
    warningDays: [],
    evidence:
      'The BMC-91X on file with FMCSA and the certificate of insurance. Compare the ' +
      'amount on file against the required minimum for what you haul.',
    consequence:
      'Financial-responsibility penalties up to $21,114 per day, then suspension and ' +
      'revocation of the authority the filing supports.',
    /**
     * `company` — the top of the ranking, and the top of the whole catalogue.
     *
     * docs/product/DATE-PRIORITY.md § 5.5 disagrees with the sentence above:
     * it leads with the money, and the money is the least of it. If the filing
     * drops off, the authority is suspended, every truck stops, and a broker
     * sees it the same day because it is on the public record. The value
     * follows the document rather than the sentence.
     *
     * This row resolves to `unsupported`, so `impact` does not lift it on the
     * dashboard: `STANDING_RANK` puts `unsupported` below `current`, and
     * impact only orders WITHIN a standing. That is deliberate and it is a
     * product problem, not a sort-key problem — the document's B1 and B3 are
     * where it gets fixed.
     */
    impact: 'company',
    /**
     * THE ONLY DIRECTION THIS GATE IS ALLOWED TO BE WRONG IN.
     *
     * Showing a private carrier a filing it may not owe costs one wrong row at
     * the top of its dashboard. Hiding this row from a for-hire carrier hides
     * the single most consequential obligation in the catalogue — the one whose
     * lapse suspends the authority and stops every truck. So the gate returns
     * `false` only where BOTH deciding facts are known and negative, which is
     * house rule 3 at the top of this file.
     *
     * `hazmat` is in the test and not decoration. Part 387's reach over a
     * PRIVATE carrier hauling hazardous materials is not something this file
     * has verified, and an unverified widening of an exemption is the one kind
     * of guess that takes an obligation away from somebody who owes it. Until
     * that is checked, a hazmat or unknown-hazmat carrier keeps the row
     * whatever `forHire` says.
     *
     * WHERE THE TWO FACTS COME FROM. `carriers.for_hire` and `carriers.hazmat`
     * (supabase/migrations/0031_carrier_operation.sql) — nullable, three-valued,
     * never defaulted to either answer. Signup copies them off the FMCSA
     * census row: `for_hire` from `classdef` ("AUTHORIZED FOR HIRE", "PRIVATE
     * PROPERTY", …, mapped by `forHireFromClassdef` in src/lib/fmcsa.ts) and
     * `hazmat` from `hm_ind`. The owner can correct both on /app/settings, and
     * src/lib/deadlines.ts puts them on the context of every subject. A row
     * that predates 0031 holds NULL in both, and NULL reaches here as
     * `undefined`, which is 'unknown', which keeps the row on the board.
     */
    applies(ctx: RuleContext): Applicability {
      if (ctx.forHire === false && ctx.hazmat === false) return false
      return 'unknown'
    },
  },

  {
    /**
     * The clock runs PER ACCIDENT — three years from the date of each one — not
     * per calendar year, and not from the date of the last entry.
     *
     * "Accident" is the § 390.5 definition: a fatality, an injury needing
     * immediate treatment away from the scene, or disabling damage requiring a
     * tow. Not every collision, and the difference is worth saying out loud,
     * because carriers routinely over-report and then argue about their own
     * register in an audit.
     *
     * The subject here is really "an accident", which `Subject` cannot express,
     * so the row is filed against the carrier and is only meaningful once an
     * accident date exists. A carrier with no accidents will see it ask for one.
     */
    code: 'fed.390.15.accident-register-retention',
    title: 'Accident register entry — keep three years',
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 CFR 390.15(b)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-390.15',
    recurrence: { type: 'computed', fn: 'retain.accidentRegister' },
    warningDays: [30],
    evidence:
      'The register with the six required data elements, plus copies of every ' +
      'accident report required by a state, another governmental entity, or an insurer.',
    consequence:
      'Destroying the entry before this date is the violation: recordkeeping ' +
      'penalties of $1,584 a day up to $15,846.',
    impact: 'record',
  },

  // -------------------------------------------------------------------------
  // Hours of service and ELD records — 49 CFR Part 395
  // -------------------------------------------------------------------------

  {
    /**
     * Six months from receipt, for every record of duty status. There is no one
     * date: the obligation is a rolling window over every day's paperwork for
     * every driver, so the useful question is "what is the oldest record you
     * still have?" rather than "when is this due?".
     */
    code: 'fed.395.8.rods-retention',
    title: 'Records of duty status — keep six months',
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 CFR 395.8(k)(1)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-395.8',
    recurrence: { type: 'computed', fn: 'continuous.rodsRetention' },
    warningDays: [],
    evidence: 'The records of duty status themselves, for at least the last six months.',
    consequence: 'Recordkeeping penalties of $1,584 a day up to $15,846.',
    impact: 'record',
  },

  {
    /**
     * A separate obligation from the RODS, and the one carriers forget. Five
     * categories of document, up to eight per driver per 24 hours, six months.
     * Where more than eight exist for a day, the eight kept must include the
     * earliest and the latest time indications — the retained set has to bracket
     * the day, which is not obvious from a "keep any eight" reading.
     */
    code: 'fed.395.11.supporting-documents-retention',
    title: 'HOS supporting documents — keep six months',
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 CFR 395.11',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-395.11',
    recurrence: { type: 'computed', fn: 'continuous.supportingDocuments' },
    warningDays: [],
    evidence:
      'The documents themselves, matchable to the driver and the day. Each ' +
      'fleet-management communication record counts as one document.',
    consequence: 'Recordkeeping penalties of $1,584 a day up to $15,846.',
    impact: 'record',
  },

  {
    /**
     * Distinct from the RODS retention above: the back-up has to sit on a
     * different device from the original data. A second folder on the same ELD
     * account is not a back-up for this purpose.
     *
     * We cannot scope this to ELD users — `RuleContext` has no "uses ELD" fact —
     * so a carrier running entirely on paper under a short-haul exception will
     * still see the row.
     */
    code: 'fed.395.22.eld-backup-retention',
    title: 'ELD back-up copy — keep six months on a separate device',
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 CFR 395.22(i)(1)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-395.22',
    recurrence: { type: 'computed', fn: 'continuous.eldBackup' },
    warningDays: [],
    evidence: 'A back-up copy of the ELD records on a device separate from the original.',
    consequence: 'Recordkeeping penalties of $1,584 a day up to $15,846.',
    impact: 'record',
  },

  // -------------------------------------------------------------------------
  // Hazmat — only if applicable
  // -------------------------------------------------------------------------

  {
    /**
     * "at least once every three years" — rolling from the last training, not a
     * fixed calendar cycle.
     *
     * Two clocks that are NOT this one and are commonly confused with it: a new
     * hazmat employee has 90 days from employment for both security awareness
     * and full initial training (working under direct supervision meanwhile),
     * and in-depth security training — only where a § 172.800 security plan is
     * required — is every three years OR within 90 days of a revised plan,
     * whichever comes first.
     *
     * Subject is 'driver' because `Subject` has no 'employee'. That is wrong at
     * the edges: a hazmat employee includes dock staff, packagers and anyone who
     * prepares shipments, and none of them can be fanned out here.
     */
    code: 'fed.172.704.hazmat-recurrent-training',
    title: 'Hazmat recurrent training',
    jurisdiction: 'federal',
    subject: 'driver',
    citation: '49 CFR 172.704(c)(2)',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-172.704',
    recurrence: { type: 'rolling', intervalMonths: 36, anchor: HAZMAT_TRAINING },
    warningDays: [120, 60, 30, -1],
    evidence:
      'The training record with the five required elements, kept for employment ' +
      'plus 90 days and covering the preceding three years.',
    consequence:
      'One of the few penalties with a statutory MINIMUM: knowing training ' +
      'violations are not less than $617 and up to $102,348.',
    /**
     * `money`, from the tier-3 table in docs/product/DATE-PRIORITY.md § 2 —
     * and the caveat that document states in the same breath: for a carrier
     * who actually hauls hazmat this belongs beside the insurance filing, at
     * `company`. `impact` is static data on the rule and cannot vary with the
     * carrier, and `isHazmat` answers 'unknown' for everyone whose flag is
     * unset, so ranking the row at `company` would lift it for the majority of
     * carriers who do not haul hazmat at all. Ranked as the tier table ranks
     * it; a context-aware value is what would close this.
     */
    impact: 'money',
    applies: isHazmat,
  },

  {
    /**
     * The registration year runs 1 July – 30 June and the statement is due not
     * later than 30 June — a real fixed calendar date, so no anchor is needed.
     *
     * Caveat the type system cannot hold: one statement may cover up to THREE
     * registration years. A carrier who filed a three-year statement will be
     * shown as overdue on the intervening 30 Junes. That is the safe direction
     * to be wrong, and the alternative — treating any past filing as current —
     * is the dangerous one.
     *
     * `applies` uses one hazmat boolean where § 107.601(a) has six quantity and
     * class triggers, so this over-reports for a carrier hauling small
     * quantities. It never under-reports.
     */
    code: 'fed.107.608.hazmat-registration',
    title: 'PHMSA hazmat registration',
    jurisdiction: 'federal',
    subject: 'carrier',
    citation: '49 CFR 107.608, 107.612, 107.620',
    sourceUrl: 'https://www.ecfr.gov/current/title-49/section-107.608',
    recurrence: { type: 'fixed_calendar', months: [6], day: 'last' },
    warningDays: [90, 45, 14, -1],
    evidence:
      'The Certificate of Registration — kept three years at the principal place of ' +
      'business AND carried on board each truck and truck tractor, though not on ' +
      'trailers. Electronic form has been permitted since 2026-09-03.',
    consequence: 'Hazmat penalties up to $102,348 per violation.',
    // Same tier-3 ranking and the same caveat as the recurrent-training row
    // above: tier 1 for a carrier who really hauls hazmat, and `impact` cannot
    // say "it depends".
    impact: 'money',
    applies: isHazmat,
  },
]
