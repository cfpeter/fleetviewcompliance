/**
 * California's rule catalogue, for a carrier domiciled in California.
 *
 * Rules are DATA. compute.ts never learns the word "California" — it only knows
 * how to add months to an anchor and how to find the next entry in a calendar.
 * Every comment below records WHY a line reads the way it does, because almost
 * every one of them is a trap that otherwise produces a plausible-looking WRONG
 * date, and a confident wrong date is worse for an owner than no date at all.
 *
 * Nothing here has been reviewed by a lawyer and nothing here sets
 * verifiedBy/verifiedOn. An unverified rule must look unverified.
 *
 * ANCHORS NAME EVENTS THAT HAVE ALREADY HAPPENED.
 * compute.ts evaluates an anniversary as anchor + interval, then walks forward
 * until it passes today. Feed it a FUTURE anchor — "my IRP expires in November"
 * — and it silently skips that November and answers with the next one, which is
 * the one direction this domain refuses to be wrong in. So every anchor below is
 * named for a completed event, and the UI that collects it must store the last
 * occurrence, not the next one.
 *
 * TWO OBLIGATIONS PEOPLE EXPECT TO FIND HERE AND WILL NOT, DELIBERATELY:
 *
 *  - An annual IIPP review. 8 CCR 3203 contains no review cadence. Annual review
 *    is a consultant habit, not a codified deadline, and hanging a fake annual
 *    date off a real regulation teaches an owner to discount the real ones.
 *  - Cal/OSHA 300A ELECTRONIC SUBMISSION. NAICS 4841/4842 are in Appendix A, but
 *    the submission threshold is 20-249 employees per establishment. A twelve-
 *    employee carrier posts the summary and submits nothing.
 *
 * Reefer TRU fees, DOORS off-road reporting and AB 5 posture are real California
 * obligations and are deliberately out of this file's scope.
 */
import { registerComputed } from './compute.ts'
import { toUtcMidnight } from './dates.ts'
import type { Applicability, Outcome, RuleContext, RuleDefinition } from './types.ts'

/**
 * FMCSA's carrier operation code: 'A' is Interstate, 'B' and 'C' are the two
 * intrastate codes. `undefined` is not "no" — it is "we have not asked yet", and
 * the honest answer to an unasked question is 'unknown', which fails open.
 */
function interstate(ctx: RuleContext): Applicability {
  if (ctx.carrierOperation === undefined) return 'unknown'
  return ctx.carrierOperation === 'A'
}

function intrastate(ctx: RuleContext): Applicability {
  if (ctx.carrierOperation === undefined) return 'unknown'
  return ctx.carrierOperation !== 'A'
}

/** The rule rows' `fn` names, kept next to the functions that satisfy them. */
const CTC_VIS_FN = 'carb_ctc_vis_listing_current'
const BIT_TERMINAL_FN = 'chp_bit_terminal_selection'

/**
 * Keeping the CTC-VIS listing current is a THIRTY-DAY clock started by an event.
 *
 * Neither the unit nor the repetition fits an interval. Three calendar months is
 * 90-92 days depending on where it starts, and one month from 31 January is 28
 * days — so months cannot express 30 days without drifting, and drifting LATE is
 * the direction this domain refuses. Worse, `anniversary` and `rolling` both
 * walk forward until they pass today, which would turn a one-off "you sold a
 * truck in March and never delisted it" into a fresh chore every month forever.
 *
 * With the sale or purchase date we can give the exact date. WITHOUT it the
 * answer is a sentence, not `missing_data`: a fleet that has bought and sold
 * nothing owes nothing here, and asking every truck in the yard for a sale date
 * it does not have is a false alarm dressed as a question.
 */
function registerCtcVisListing(): void {
  registerComputed(CTC_VIS_FN, (ctx): Outcome => {
    const event = ctx.anchors?.ctc_vis_reportable_event
    if (!event) {
      return {
        kind: 'unsupported',
        reason:
          'Update the CTC-VIS listing within 30 days of buying or selling this vehicle. The ' +
          'clock starts at the sale, not on the calendar, so there is no recurring date to show.',
      }
    }
    // Whole days added to a UTC midnight: UTC has no DST, so +30 days is exactly
    // 30 x 86,400,000 ms and cannot land on the wrong calendar day.
    return { kind: 'due', on: new Date(toUtcMidnight(event).getTime() + 30 * 86_400_000) }
  })
}

/**
 * The CHP terminal visit has no schedule at all, and saying so is the point.
 *
 * Registered rather than left unimplemented so the refusal is a sentence an
 * owner can act on: an unregistered `computed` row also resolves to
 * `unsupported`, but with the engine's own message ("no implementation
 * registered for ..."), which is developer-speak leaking onto a dashboard.
 *
 * No `previous` hook on either schedule. `ComputedSchedule.previous` exists so
 * `status` can say `overdue`, and neither of these has an earlier cycle to be
 * overdue against — inventing one would mark a carrier who delisted a sold truck
 * on day 20 as permanently behind.
 */
function registerBitTerminalSelection(): void {
  registerComputed(
    BIT_TERMINAL_FN,
    (): Outcome => ({
      kind: 'unsupported',
      reason:
        'CHP selects terminals for inspection from carrier performance data and may inspect at ' +
        'any time. There is no cycle to predict — keep the terminal, its vehicles and its ' +
        'records ready.',
    }),
  )
}

let schedulesRegistered = false

/**
 * Idempotent, and called at import below so a rule row can never reference a
 * `fn` name that nothing has registered.
 */
export function registerCaliforniaSchedules(): void {
  if (schedulesRegistered) return
  schedulesRegistered = true
  registerCtcVisListing()
  registerBitTerminalSelection()
}

registerCaliforniaSchedules()

export const californiaRules: RuleDefinition[] = [
  // ---------------------------------------------------------------------------
  // CARB Clean Truck Check (Heavy-Duty Inspection and Maintenance)
  // ---------------------------------------------------------------------------
  {
    code: 'ca_ctc_test',
    title: 'CARB Clean Truck Check periodic emissions test',
    jurisdiction: 'CA',
    // CARB's Clean Truck Check reaches ANY vehicle operating in California,
    // wherever it is plated. We do not know where a carrier's trucks run, so
    // this stays tracked rather than ruled out.
    nexus: 'operates',
    subject: 'power_unit',
    citation: 'CARB Clean Truck Check (Heavy-Duty I/M), authorised by SB 210 (2019)',
    sourceUrl:
      'https://ww2.arb.ca.gov/clean-truck-check-requirements-vehicles-subject-semi-annual-compliance',
    /**
     * ANNIVERSARY, NOT ROLLING — and this is the whole trap.
     *
     * CARB fixes a vehicle's deadline months to its DMV registration month (and
     * that month + 6), or, for out-of-state plates, to the last digit of its VIN.
     * The schedule is frozen to the VEHICLE. A `rolling` interval would restart
     * the clock at each test and so reward testing early by pushing the next
     * deadline out — which is backwards: a test more than 90 days before the
     * deadline does not count toward it at all, and the owner has bought nothing.
     *
     * The anchor is the FIRST deadline of a compliance year that has ALREADY
     * PASSED (the registration month, or the VIN-derived month). Stepping six
     * months at a time from that lands on both of the year's deadlines.
     *
     * CADENCE CHANGE THIS TYPE CANNOT EXPRESS: `intervalMonths` is a constant.
     * From October 2027, OBD-equipped vehicles move from semi-annual to
     * QUARTERLY, and `Recurrence` has no way to say "6 until 2027-10-01, then 3".
     * What is encoded is the cadence that is correct today and stays correct
     * until 2027-10-01 — semi-annual. Agricultural vehicles and CA motorhomes are
     * ANNUAL and are also not expressible here. Both gaps are reported, not
     * silently papered over.
     */
    recurrence: { type: 'anniversary', anchor: 'carb_ctc_first_deadline', intervalMonths: 6 },
    // The first nudge is 90 days out because that is the day the testing window
    // OPENS. Warning earlier would push owners to test outside the window, where
    // the test is wasted money.
    warningDays: [90, 60, 30, 14, -1, -7],
    evidence: 'Passing OBD or smoke-opacity/ECS test report filed to the CTC account',
    consequence:
      'DMV registration hold under SB 210, placed automatically; roadside and port enforcement',
    /**
     * Scope is GVWR over 14,000 lb, non-gasoline, including out-of-state plates
     * operating in California. RuleContext carries no fuel type, so a heavy
     * gasoline truck is over-included here: one unnecessary reminder, which is
     * the cheap direction to be wrong in.
     */
    applies: (ctx) => {
      if (ctx.gvwrLbs === undefined) return 'unknown'
      return ctx.gvwrLbs > 14_000
    },
  },
  {
    code: 'ca_ctc_fee',
    title: 'CARB Clean Truck Check annual per-vehicle compliance fee',
    jurisdiction: 'CA',
    // Same reach as the test it pays for.
    nexus: 'operates',
    subject: 'power_unit',
    citation: 'CARB Clean Truck Check compliance fee (CCPI-indexed annually)',
    sourceUrl:
      'https://ww2.arb.ca.gov/resources/fact-sheets/clean-truck-check-compliance-fee-update-effective-112026',
    /**
     * The fee is $32.13 per vehicle for deadlines on or after 2026-01-01 ($33.12
     * from 2027-01-01 — CARB posts the next figure by 1 July, so the amount lives
     * in the pricing table, not in this rule).
     *
     * It is due AT THE FIRST COMPLIANCE DEADLINE OF EACH COMPLIANCE YEAR, which
     * is why this shares the test rule's anchor but steps 12 months instead of 6:
     * twelve months from the first deadline is the next year's first deadline.
     * Paying at the second deadline of the year is late.
     */
    recurrence: { type: 'anniversary', anchor: 'carb_ctc_first_deadline', intervalMonths: 12 },
    warningDays: [60, 30, 14, -1, -7],
    evidence: 'Paid fee receipt in the CARB Clean Truck Check account',
    consequence: 'Vehicle reads non-compliant; DMV registration hold; certificate denied',
    applies: (ctx) => {
      if (ctx.gvwrLbs === undefined) return 'unknown'
      return ctx.gvwrLbs > 14_000
    },
  },
  {
    code: 'ca_ctc_vis_listing',
    title: 'Keep the CTC-VIS vehicle listing current',
    jurisdiction: 'CA',
    // Same reach as the programme it lists into.
    nexus: 'operates',
    subject: 'power_unit',
    citation: 'CARB Clean Truck Check reporting (CTC-VIS), 30 days from purchase or sale',
    sourceUrl: 'https://ww2.arb.ca.gov/our-work/programs/CTC',
    /**
     * EVENT-TRIGGERED IN DAYS, AND `Recurrence` HAS NO VARIANT FOR THAT — hence
     * `computed`. See registerCtcVisListing above for why months cannot say
     * "30 days" and why a missing sale date is answered with a sentence rather
     * than a question.
     */
    recurrence: { type: 'computed', fn: CTC_VIS_FN },
    // A 30-day clock has no room for a 60-day nudge; the reminder that matters is
    // the one the moment a vehicle is added or removed, which the UI raises from
    // the event itself.
    warningDays: [14, 7, 1, -1, -7],
    evidence: 'CTC-VIS vehicle list matching the fleet, with sale/purchase dates',
    consequence:
      'Fees and deadlines keep running against a vehicle you sold; a bought vehicle sits ' +
      'unreported and non-compliant',
    applies: (ctx) => {
      if (ctx.gvwrLbs === undefined) return 'unknown'
      return ctx.gvwrLbs > 14_000
    },
  },

  // ---------------------------------------------------------------------------
  // CHP Basic Inspection of Terminals (BIT)
  // ---------------------------------------------------------------------------
  {
    code: 'ca_bit_inspection',
    title: 'BIT 90-day vehicle inspection',
    jurisdiction: 'CA',
    // The CHP's BIT programme follows operation in California, including
    // out-of-state carriers with a terminal here.
    nexus: 'operates',
    subject: 'power_unit',
    citation: 'Veh. Code 34501.12 (Basic Inspection of Terminals), as recast by AB 529',
    sourceUrl:
      'https://www.chp.ca.gov/programs-services/programs/commercial-vehicle-section/carrier-inspection-results',
    /**
     * BIT IS "BASIC" INSPECTION OF TERMINALS, NOT "BIENNIAL".
     *
     * AB 529 replaced the old once-every-25-months mandate with a performance-
     * based programme, and from 2026-01-01 the carrier's own systematic
     * inspection cycle is 90 DAYS for vehicles at 26,001 lb and above. Anything
     * in a product that says "biennial" is roughly eight times too slack.
     *
     * ROLLING, not anniversary: this one genuinely runs from the last inspection.
     *
     * PRECISION LOSS WORTH KNOWING: `intervalMonths` is months, and 3 months is
     * 90-92 days depending on where in the year it starts. From 1 May, three
     * months is 92 days — two days LATE. Day-granularity intervals are the fix
     * and are reported; until then, treat the shown date as the outside edge.
     */
    recurrence: { type: 'rolling', anchor: 'bit_last_inspection', intervalMonths: 3 },
    warningDays: [30, 14, 7, -1, -7],
    evidence: 'Dated inspection record per unit, retained and available at the terminal',
    consequence: 'Unsatisfactory terminal rating and CHP-initiated MCP suspension',
    /**
     * At or above 26,001 lb the 90-day cycle is certain. BELOW it we return
     * 'unknown' rather than false: CVC 34500 also reaches lighter trucks pulling
     * trailers, placarded hazmat and buses, so "under 26,001 lb" is not a safe
     * exemption to assert. 'unknown' keeps the rule on the dashboard.
     */
    applies: (ctx) => {
      if (ctx.gvwrLbs === undefined) return 'unknown'
      return ctx.gvwrLbs >= 26_001 ? true : 'unknown'
    },
  },
  {
    code: 'ca_bit_terminal_inspection',
    title: 'CHP terminal inspection readiness (BIT)',
    jurisdiction: 'CA',
    // A terminal in California is inspectable whoever owns it.
    nexus: 'operates',
    subject: 'terminal',
    citation: 'Veh. Code 34501.12; CHP HPM 84.1 ch. 2; MCP Handbook MC 500 M',
    sourceUrl:
      'https://www.chp.ca.gov/programs-services/programs/commercial-vehicle-section/carrier-inspection-results',
    /**
     * This rule exists to hold the ground that the previous one clears: the CHP
     * visit itself has NO cycle. CHP selects terminals from performance data and
     * may inspect at any time — observed real intervals for one terminal ran
     * 2025-10-09, 2023-04-19, 2021-11-23, 2020-03-03, 2015-06-22.
     *
     * Deleting this row is how "biennial" gets reintroduced. It answers
     * `unsupported`, which is the truth, instead of a 25-month fiction.
     * (Follow-ups do have clocks — conditional re-inspection at about 6 months,
     * unsatisfactory re-inspection no sooner than 100 and no later than 120 days
     * — but those are CHP's clocks, not deadlines the carrier can file against.)
     */
    recurrence: { type: 'computed', fn: BIT_TERMINAL_FN },
    warningDays: [],
    evidence: 'Terminal designated on the MCP, with vehicles, drivers and records available there',
    consequence: 'Unsatisfactory rating, re-inspection fees, and MCP suspension initiated by CHP',
  },

  // ---------------------------------------------------------------------------
  // California Motor Carrier Permit
  // ---------------------------------------------------------------------------
  {
    code: 'ca_mcp_renewal',
    title: 'California Motor Carrier Permit renewal',
    jurisdiction: 'CA',
    // Veh. Code 34500. A carrier based in another state does not hold a CA# and
    // cannot be late renewing one.
    nexus: 'based',
    subject: 'carrier',
    citation: 'Veh. Code 34500 et seq.; CA# issued under Veh. Code 34507.5',
    sourceUrl:
      'https://www.dmv.ca.gov/portal/vehicle-industry-services/motor-carrier-services-mcs/motor-carrier-permits/',
    /**
     * Term is 12 months from the FIRST DAY OF THE APPLICATION MONTH — staggered
     * per carrier, never a shared calendar date, so this is an anniversary and
     * the anchor is the month the permit was issued or last renewed.
     */
    recurrence: { type: 'anniversary', anchor: 'mcp_issued', intervalMonths: 12 },
    // The -30 nudge is not decoration: delinquency penalties step at 31 days
    // (+60% of fees due), one year (+80%) and two years (+160%).
    warningDays: [60, 30, 14, 7, -1, -30],
    evidence: 'Current MCP showing the CA# and the permit expiration date',
    consequence:
      'Operating without a valid MCP; delinquency penalties from +60% at 31 days to +160% ' +
      'after two years',
    /**
     * THE MOST EXPENSIVE FALSE POSITIVE IN THE CALIFORNIA SET.
     *
     * An interstate carrier's MCP DOES NOT EXPIRE and carries no renewal fee.
     * Only the intrastate permit renews annually. Nagging an interstate carrier
     * to renew a non-expiring permit is the error that makes an owner stop
     * believing every other alert we send, so this is the one place we
     * deliberately fail CLOSED on a positive fact: 'A' means not_applicable.
     *
     * Not knowing the operation code still fails open ('unknown'), because an
     * unasked question must never silence a real annual deadline.
     */
    applies: intrastate,
  },

  // ---------------------------------------------------------------------------
  // CVRA / commercial registration
  // ---------------------------------------------------------------------------
  {
    code: 'ca_cvra_registration',
    title: 'CVRA commercial registration renewal and weight decal fee',
    jurisdiction: 'CA',
    // CVRA is California vehicle registration. A truck plated in Texas is
    // registered in Texas, and no CVRA weight decal is owed on it.
    nexus: 'based',
    subject: 'power_unit',
    citation: 'Commercial Vehicle Registration Act; DMV VIRPM 13.020; weight declared on REG 4008',
    sourceUrl:
      'https://www.dmv.ca.gov/portal/handbook/vehicle-industry-registration-procedures-manual-2/commercial-vehicles/commercial-vehicle-registration-act-of-cvra/',
    /**
     * Registration renews annually on the vehicle's own date, so: anniversary
     * from the last registration, not a shared calendar date.
     *
     * ONE RULE, NOT TWO. The CVRA weight decal is issued ONCE; renewals issue
     * only the CVRA and ACTM year stickers unless the declared weight changes.
     * A separate "annual weight decal" rule would be inventing a decal that is
     * never reissued. What IS due every time is the weight decal FEE — on every
     * original, every renewal, and every weight change — so it rides here.
     */
    recurrence: { type: 'anniversary', anchor: 'cvra_last_registered', intervalMonths: 12 },
    warningDays: [60, 30, 14, 7, -1],
    evidence: 'Current registration card, CVRA and ACTM year stickers, weight decal on the unit',
    consequence: 'Expired registration, citation and impound exposure; PYR does not cure a lapse',
    /**
     * CVRA fees replace weight fees at GVW/CGW of 10,001 lb and above. Below
     * that a truck pays ordinary registration, so false here is safe to assert.
     */
    applies: (ctx) => {
      if (ctx.gvwrLbs === undefined) return 'unknown'
      return ctx.gvwrLbs >= 10_001
    },
  },

  // ---------------------------------------------------------------------------
  // IFTA — THREE rows, because it is not one deadline
  // ---------------------------------------------------------------------------
  {
    code: 'ca_ifta_quarterly_return',
    title: 'IFTA quarterly fuel tax return',
    jurisdiction: 'CA',
    // NOT a California obligation. IFTA covers 48 states and 10 Canadian
    // provinces; the CA tag names CDTFA, the authority a California-based
    // carrier files WITH. Gating this on state would delete a real filing
    // obligation, with penalties, from an out-of-state carrier.
    nexus: 'universal',
    subject: 'carrier',
    citation: 'International Fuel Tax Agreement, administered in California by CDTFA',
    sourceUrl: 'https://cdtfa.ca.gov/taxes-and-fees/ifta-ciudft-di-license-onlinefiling.htm',
    /**
     * Last day of the month following each quarter: Apr 30, Jul 31, Oct 31,
     * Jan 31. `day: 'last'` rather than four literal numbers because that is the
     * rule as written, and it cannot drift into a 31 April.
     *
     * A weekend or holiday rolls the true deadline to the next business day,
     * which the engine does not model. That is deliberate: the date shown is then
     * a day or two EARLY, and early is the safe direction.
     *
     * A ZERO RETURN IS STILL A RETURN. No travel and no tax due does not excuse
     * filing, and the penalty is $50 or 10% of net tax due, whichever is greater
     * — so it bites a carrier who owes nothing at all.
     */
    recurrence: { type: 'fixed_calendar', months: [1, 4, 7, 10], day: 'last' },
    warningDays: [30, 14, 7, 1, -1, -7],
    evidence: 'Filed quarterly return confirmation from CDTFA online services',
    consequence:
      '$50 or 10% of net tax due, whichever is greater, plus per-jurisdiction interest; CDTFA ' +
      'bills on industry-average MPG with your fuel-tax credits excluded',
    // A carrier that never leaves California cannot hold an IFTA licence and has
    // nothing to file. Unknown operation still tracks the deadline.
    applies: interstate,
  },
  {
    code: 'ca_ifta_license_renewal',
    title: 'IFTA licence and decal renewal — FILE by 31 December',
    jurisdiction: 'CA',
    // Same agreement, same reason — the authority is Californian, the
    // obligation is not.
    nexus: 'universal',
    subject: 'carrier',
    citation: 'International Fuel Tax Agreement licence year (1 Jan - 31 Dec); CDTFA renewal',
    sourceUrl:
      'https://cdtfa.ca.gov/taxes-and-fees/fuel-tax-and-fee-guides/IFTA-and-interstate-user-diesel-fuel-tax/getting-started.htm',
    /**
     * DEADLINE ONE OF TWO. Renewal opens 1 December and the APPLICATION must be
     * filed before 31 December. IFTA's own memo is blunt about the confusion this
     * rule exists to prevent: the two-month grace period is for DISPLAY of
     * renewal credentials, NOT to file the renewal application.
     *
     * Modelling IFTA as a single deadline in late February is the common error
     * and it is two months of false comfort at the exact moment the licence year
     * is running out.
     */
    recurrence: { type: 'fixed_calendar', months: [12], day: 31 },
    warningDays: [30, 21, 14, 7, 1, -1],
    evidence: 'CDTFA renewal confirmation and the new IFTA licence ($10/yr + $2 per decal set)',
    consequence:
      'No valid licence for the new year; prior-year decals stop being honoured and the ' +
      'February grace period does not apply to an unfiled renewal',
    applies: interstate,
  },
  {
    code: 'ca_ifta_decal_display',
    title: 'IFTA — display the new year decals by the end of February',
    jurisdiction: 'CA',
    // Same agreement.
    nexus: 'universal',
    subject: 'carrier',
    citation: 'IFTA two-month display grace period; CDTFA Temporary Decal Permit conditions',
    sourceUrl:
      'https://cdtfa.ca.gov/taxes-and-fees/fuel-tax-and-fee-guides/IFTA-and-interstate-user-diesel-fuel-tax/getting-started.htm',
    /**
     * DEADLINE TWO OF TWO, and a genuinely different date from the one above.
     *
     * Prior-year decals are honoured only through the LAST DAY OF FEBRUARY, and
     * only if the renewal went in by 31 December, the account is in good standing,
     * and the driver carries the new licence plus a Temporary Decal Permit. It is
     * a display deadline, not a filing deadline.
     *
     * `day: 'last'` so it is 29 February in a leap year and never 28 by accident.
     */
    recurrence: { type: 'fixed_calendar', months: [2], day: 'last' },
    warningDays: [30, 14, 7, -1],
    evidence: 'Current-year decals affixed to both cab doors; new licence carried in the cab',
    consequence: 'Roadside citation for running on expired credentials once the grace period ends',
    applies: interstate,
  },

  // ---------------------------------------------------------------------------
  // IRP apportioned registration
  // ---------------------------------------------------------------------------
  {
    code: 'ca_irp_renewal',
    title: 'IRP apportioned registration renewal',
    jurisdiction: 'CA',
    // The International Registration Plan, likewise: every US state and the
    // Canadian provinces. California DMV is only where a CA carrier applies.
    nexus: 'universal',
    subject: 'carrier',
    citation:
      'International Registration Plan; CA DMV IRP Handbook ch. 6; Veh. Code 8057 (records)',
    sourceUrl: 'https://www.dmv.ca.gov/portal/handbook/irp/chapter-6-irp-renewal/',
    /**
     * STAGGERED PER CARRIER. The registration year is 12 months beginning the
     * first day of a month DMV assigns to the account, due by midnight on the
     * last day of that month. There is no shared calendar date to fall back on,
     * and no public lookup anywhere — so the anchor comes from the carrier, and
     * when it is missing the engine must say `missing_data` rather than guess.
     * Guessing here would be a fabricated date on the one deadline that takes the
     * trucks off the road.
     *
     * The anchor is the last renewal (last day of the assigned month in the year
     * they last renewed); twelve months on is the next one.
     */
    recurrence: { type: 'anniversary', anchor: 'irp_last_renewed', intervalMonths: 12 },
    // The distance reporting period is 1 July - 30 June of the preceding fiscal
    // year, so 60 days out is already too late to start collecting it; the early
    // nudge is what makes Schedule B possible.
    warningDays: [90, 60, 30, 14, 7, -1],
    evidence: 'Cab cards for the fleet, plus Schedule B distance by jurisdiction and 2290 proof',
    consequence:
      'Apportioned plates expire; billing balance is due within 20 days of the invoice date; ' +
      'only a Certificate of Non-Operation filed within 90 days waives penalties',
    // Apportioned registration is for vehicles based in CA and operated in at
    // least one other jurisdiction. Intrastate-only carriers register normally.
    applies: interstate,
  },

  // ---------------------------------------------------------------------------
  // California employment obligations that are genuinely dated
  // ---------------------------------------------------------------------------
  {
    code: 'ca_osha_300a_posting',
    title: 'Post the Cal/OSHA Form 300A annual summary',
    jurisdiction: 'CA',
    // Cal/OSHA follows the employee, not the yard.
    nexus: 'employs',
    subject: 'carrier',
    citation: '8 CCR 14300 et seq. (Cal/OSHA recordkeeping); summary posted 1 Feb - 30 Apr',
    sourceUrl: 'https://www.dir.ca.gov/dosh/',
    /**
     * THIS IS A POSTING WINDOW, NOT A FILING DEADLINE, and `Recurrence` has no
     * window variant. The window runs 1 February to 30 April.
     *
     * We anchor on 1 FEBRUARY — the day the window OPENS — because that is the
     * date at which a violation begins. 30 April is the day the summary may come
     * down; treating it as "the deadline" would let a carrier sit uncertified
     * through the entire window and still look green.
     *
     * Nothing is sent to anyone. Electronic submission starts at 20 employees per
     * establishment, so a twelve-employee carrier posts and submits nothing — see
     * the file header for why that rule is absent rather than merely unticked.
     *
     * No `applies`: RuleContext carries no employee count, and the partial-
     * exemption threshold cannot be evaluated without one. Failing open here is
     * one poster on a wall.
     */
    recurrence: { type: 'fixed_calendar', months: [2], day: 1 },
    warningDays: [30, 14, 7, -1, -14],
    evidence: 'Signed Form 300A posted in a visible common area; the 300 log retained 5 years',
    consequence: 'Cal/OSHA citation for the posting violation, independent of the injury record',
  },
  {
    code: 'ca_harassment_training',
    title: 'Harassment prevention training (per person)',
    jurisdiction: 'CA',
    // SB 1343 follows the employee. A Texas company with a California
    // dispatcher owes this for that person.
    nexus: 'employs',
    subject: 'driver',
    citation: 'Gov. Code 12950.1 (SB 1343) — 2h supervisory, 1h non-supervisory, 5+ employees',
    sourceUrl: 'https://calcivilrights.ca.gov/shpt/',
    /**
     * EVERY TWO YEARS PER PERSON, NOT ANNUALLY AND NOT COMPANY-WIDE.
     *
     * The clock is each individual's last training date, which is why this is
     * `rolling` off a per-person anchor. A single company date would mark a
     * driver hired last month as trained, and would mark the whole yard overdue
     * because one person is.
     *
     * SUBJECT LIMITATION: `Subject` has no 'employee'. Drivers are the closest
     * available subject, so dispatchers, mechanics and office staff — who are
     * equally covered by 12950.1 — cannot be represented at all. Reported.
     */
    recurrence: { type: 'rolling', anchor: 'harassment_training_completed', intervalMonths: 24 },
    warningDays: [60, 30, 14, -1, -30],
    evidence: 'Per-person training certificate with date and duration, retained 2 years',
    consequence: 'CRD enforcement; the failure becomes evidence in any harassment claim',
  },
  {
    code: 'ca_wvpp_annual_review',
    title: 'Workplace Violence Prevention Plan annual review (SB 553)',
    jurisdiction: 'CA',
    // SB 553 follows the employee, same as the training below.
    nexus: 'employs',
    subject: 'carrier',
    citation: 'Labor Code 6401.9 (SB 553) — plan reviewed at least annually',
    sourceUrl: 'https://www.dir.ca.gov/dosh/workplace-violence-prevention-in-general-industry.html',
    /**
     * `rolling`, because the obligation is "at least annually" from the last
     * review — not "every January". A carrier who reviewed in March owes the next
     * one the following March, and a fixed January date would call them overdue
     * for ten months of a year in which they are compliant.
     *
     * This is the cleanest genuinely-annual employment item in the California set,
     * which is exactly why it must not be confused with the IIPP review that does
     * not exist (see the file header).
     */
    recurrence: { type: 'rolling', anchor: 'wvpp_plan_reviewed', intervalMonths: 12 },
    warningDays: [60, 30, 14, -1, -30],
    evidence: 'Dated plan revision with the violent-incident log and the review record',
    consequence: 'Cal/OSHA citation; the plan is the first document requested after an incident',
  },
  {
    code: 'ca_wvpp_annual_training',
    title: 'Workplace Violence Prevention Plan annual training (per person)',
    jurisdiction: 'CA',
    // SB 553 follows the employee.
    nexus: 'employs',
    subject: 'driver',
    citation: 'Labor Code 6401.9 (SB 553) — training at least annually and when the plan changes',
    sourceUrl: 'https://www.dir.ca.gov/dosh/workplace-violence-prevention-in-general-industry.html',
    /**
     * Separate from the plan review above: reviewing the plan does not train
     * anyone, and training everyone does not review the plan. Two rows, because
     * a carrier can be current on one and years behind on the other.
     *
     * Per person, so it is `rolling` off that person's own last training — and
     * subject to the same missing 'employee' subject noted on the harassment row.
     * Training is also owed whenever the plan changes materially, which is an
     * event this type system cannot express; reported.
     */
    recurrence: { type: 'rolling', anchor: 'wvpp_training_completed', intervalMonths: 12 },
    warningDays: [60, 30, 14, -1, -30],
    evidence: 'Per-person training record with date, trainer and topics covered',
    consequence: 'Cal/OSHA citation; untrained staff after an incident is the aggravating fact',
  },
]
