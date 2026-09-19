/**
 * The California catalogue.
 *
 * These tests are not here to prove that adding months works — compute.ts does
 * that. They are here to pin down the half-dozen places where the OBVIOUS
 * encoding produces a wrong date or a harmful reminder: BIT as biennial, IFTA as
 * one deadline, an MCP renewal nag sent to an interstate carrier, an IRP date
 * guessed rather than refused.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eligibility } from '../src/lib/dispatch/eligibility.ts'
import { returnDueOn } from '../src/lib/ifta/compute.ts'
import { californiaRules } from '../src/lib/rules/california.ts'
import { nextDue, status } from '../src/lib/rules/compute.ts'
import { evaluate } from '../src/lib/rules/index.ts'
import type { Outcome, RuleContext, RuleDefinition } from '../src/lib/rules/types.ts'

/**
 * Every rule in the catalogue that reports on a driver's medical certificate,
 * federal or Californian. The B13 tests at the bottom of this file assert that
 * exactly one of them reaches any given driver.
 */
const MEDICAL_RULE_CODES = new Set([
  'medical_certificate_general',
  'medical_certificate_by_exam_date',
  'medical_certificate_intracity_zone',
  'medical_certificate_insulin_treated',
  'medical_certificate_alternative_vision',
  'ca_intrastate_medical_certificate',
])

/** The day this catalogue was written; every expected date below is read from it. */
const TODAY = new Date(Date.UTC(2026, 8, 15))

function rule(code: string): RuleDefinition {
  const found = californiaRules.find((r) => r.code === code)
  if (!found) throw new Error(`no California rule with code '${code}'`)
  return found
}

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return { today: TODAY, registrationState: 'CA', ...over }
}

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d))
}

/** The ISO day of a rule that must resolve to a date, or a failure naming what it did instead. */
function dueOn(code: string, c: RuleContext): string {
  const out = nextDue(rule(code), c)
  if (out.kind !== 'due') throw new Error(`${code}: expected a due date, got '${out.kind}'`)
  return out.on.toISOString().slice(0, 10)
}

function outcome(code: string, c: RuleContext): Outcome {
  return nextDue(rule(code), c)
}

// -----------------------------------------------------------------------------
// Catalogue-wide invariants
// -----------------------------------------------------------------------------

test('every rule code is unique and every rule is a California rule', () => {
  const codes = californiaRules.map((r) => r.code)
  assert.equal(new Set(codes).size, codes.length, 'duplicate rule code')
  for (const r of californiaRules) assert.equal(r.jurisdiction, 'CA', r.code)
})

test('nothing in the catalogue claims to have been verified by anyone', () => {
  // An unverified rule must look unverified. These fields are for a person with
  // the qualification to sign off, not for the agent that wrote the row.
  for (const r of californiaRules) {
    assert.equal(r.verifiedBy, undefined, r.code)
    assert.equal(r.verifiedOn, undefined, r.code)
  }
})

test('the word "biennial" appears nowhere — BIT is BASIC Inspection of Terminals', () => {
  // The rename is the whole point of AB 529. A catalogue that says "biennial"
  // is telling a carrier to inspect every 25 months instead of every 90 days.
  for (const r of californiaRules) {
    const text = `${r.code} ${r.title} ${r.citation} ${r.evidence} ${r.consequence}`
    assert.ok(!/biennial/i.test(text), `${r.code} says "biennial"`)
  }
})

// -----------------------------------------------------------------------------
// CARB Clean Truck Check
// -----------------------------------------------------------------------------

test('Clean Truck Check testing is semi-annual from the vehicle’s own deadline month', () => {
  // First deadline of a past compliance year was 31 Jan. July 2026 has gone, so
  // the next one is January 2027 — not "six months from today".
  const c = ctx({ gvwrLbs: 33_000, anchors: { carb_ctc_first_deadline: utc(2026, 1, 31) } })
  assert.equal(dueOn('ca_ctc_test', c), '2027-01-31')
})

test('a Clean Truck Check date is never invented from thin air', () => {
  const c = ctx({ gvwrLbs: 33_000 })
  const out = outcome('ca_ctc_test', c)
  assert.equal(out.kind, 'missing_data')
})

test('an unknown-weight truck still gets a Clean Truck Check date', () => {
  // Fail open: no GVWR is not "under 14,000 lb".
  const c = ctx({ anchors: { carb_ctc_first_deadline: utc(2026, 1, 31) } })
  assert.equal(dueOn('ca_ctc_test', c), '2027-01-31')
})

test('a light truck is out of Clean Truck Check scope', () => {
  const c = ctx({ gvwrLbs: 10_000, anchors: { carb_ctc_first_deadline: utc(2026, 1, 31) } })
  assert.equal(outcome('ca_ctc_test', c).kind, 'not_applicable')
})

test('the CTC fee lands on the FIRST deadline of the year, not on every test', () => {
  // April/October vehicle. Testing is due in October; the $32.13 fee is not —
  // it was due in April and is next due the following April.
  const c = ctx({ gvwrLbs: 33_000, anchors: { carb_ctc_first_deadline: utc(2026, 4, 30) } })
  assert.equal(dueOn('ca_ctc_test', c), '2026-10-30')
  assert.equal(dueOn('ca_ctc_fee', c), '2027-04-30')
})

test('a fleet that has bought and sold nothing is not asked for a sale date', () => {
  // No event, no duty. `missing_data` here would put "we need the purchase date"
  // against every truck in the yard — a false alarm dressed up as a question.
  const out = outcome('ca_ctc_vis_listing', ctx({ gvwrLbs: 33_000 }))
  assert.equal(out.kind, 'unsupported')
  if (out.kind !== 'unsupported') return
  // And the refusal has to be a sentence an owner can act on, not an engine error.
  assert.match(out.reason, /30 days/)
  assert.ok(!/registered for/.test(out.reason), 'engine-speak leaked to the dashboard')
})

test('CTC-VIS is 30 DAYS from the sale, counted in days and not in months', () => {
  // A January sale is the case that catches a month-based encoding: +1 month
  // from 31 January is 28 February, three days short of the real date.
  const c = ctx({ gvwrLbs: 33_000, anchors: { ctc_vis_reportable_event: utc(2026, 1, 31) } })
  assert.equal(dueOn('ca_ctc_vis_listing', c), '2026-03-02')
})

test('a sale never reported stays a single blown deadline, not a monthly chore', () => {
  // The date stays put in the past. An interval recurrence would walk it forward
  // to next month, and keep doing so forever, which reads as routine housekeeping
  // rather than a truck you sold in March that CARB still bills you for.
  const c = ctx({ gvwrLbs: 33_000, anchors: { ctc_vis_reportable_event: utc(2026, 3, 1) } })
  assert.equal(dueOn('ca_ctc_vis_listing', c), '2026-03-31')
})

// -----------------------------------------------------------------------------
// CHP BIT
// -----------------------------------------------------------------------------

test('BIT vehicle inspection runs on a 90-day cycle from the last inspection', () => {
  // 20 Aug + 90 days is 18 Nov. Three calendar months would say 20 Nov, and
  // that is the wrong answer in the dangerous direction: two days the owner
  // does not have.
  const c = ctx({ gvwrLbs: 33_000, anchors: { bit_last_inspection: utc(2026, 8, 20) } })
  assert.equal(dueOn('ca_bit_inspection', c), '2026-11-18')

  // Pinned explicitly: a count of DAYS, ninety of them, never a count of months.
  const r = rule('ca_bit_inspection').recurrence
  assert.equal(r.type, 'rolling')
  if (r.type !== 'rolling') return
  assert.equal(r.intervalDays, 90)
  assert.equal(r.intervalMonths, undefined)
})

test('a truck under 26,001 lb is not declared exempt from BIT', () => {
  // CVC 34500 also reaches lighter combinations, placarded hazmat and buses, so
  // 'unknown' keeps the rule on the board rather than asserting an exemption.
  const c = ctx({ gvwrLbs: 20_000, anchors: { bit_last_inspection: utc(2026, 8, 20) } })
  assert.equal(dueOn('ca_bit_inspection', c), '2026-11-18')
})

test('the CHP terminal visit itself has no predictable cycle', () => {
  const out = outcome('ca_bit_terminal_inspection', ctx())
  assert.equal(out.kind, 'unsupported')
  if (out.kind !== 'unsupported') return
  assert.match(out.reason, /performance data/)
})

// -----------------------------------------------------------------------------
// MCP — the reminder that must never be sent
// -----------------------------------------------------------------------------

test('an interstate carrier is never nagged to renew a non-expiring MCP', () => {
  // Carrier operation 'A' is Interstate. Their MCP does not expire and carries
  // no renewal fee. One wrong reminder here discredits every other alert.
  const c = ctx({ carrierOperation: 'A', anchors: { mcp_issued: utc(2026, 3, 1) } })
  assert.equal(outcome('ca_mcp_renewal', c).kind, 'not_applicable')
})

test('an intrastate carrier renews the MCP twelve months from the application month', () => {
  const c = ctx({ carrierOperation: 'C', anchors: { mcp_issued: utc(2026, 3, 1) } })
  assert.equal(dueOn('ca_mcp_renewal', c), '2027-03-01')
})

test('not knowing the operation code does not silence the MCP renewal', () => {
  // Fail open: 'unknown' is not 'interstate'. We ask for the issue date instead
  // of quietly marking an annual permit not_applicable.
  const out = outcome('ca_mcp_renewal', ctx())
  assert.equal(out.kind, 'missing_data')
  if (out.kind !== 'missing_data') return
  assert.deepEqual([...out.needs], ['mcp_issued'])
})

// -----------------------------------------------------------------------------
// CVRA registration
// -----------------------------------------------------------------------------

test('CVRA registration renews on the vehicle’s own annual date', () => {
  const c = ctx({ gvwrLbs: 33_000, anchors: { cvra_last_registered: utc(2025, 11, 30) } })
  assert.equal(dueOn('ca_cvra_registration', c), '2026-11-30')
})

test('a vehicle under 10,001 lb pays ordinary registration, not CVRA', () => {
  const c = ctx({ gvwrLbs: 9_000, anchors: { cvra_last_registered: utc(2025, 11, 30) } })
  assert.equal(outcome('ca_cvra_registration', c).kind, 'not_applicable')
})

// -----------------------------------------------------------------------------
// IFTA — two deadlines, not one
// -----------------------------------------------------------------------------

test('IFTA quarterly returns fall on the last day of the month after each quarter', () => {
  // 31 Oct 2026 is a Saturday, so the return is due Monday 2 Nov. The IFTA
  // screens already said so; the catalogue used to say 31 Oct, and one return
  // had two due dates depending on the page.
  const c = ctx({ carrierOperation: 'A' })
  assert.equal(dueOn('ca_ifta_quarterly_return', c), '2026-11-02')

  // The whole point of the roll: on Sunday 1 Nov the Q3 return is not late,
  // it is due tomorrow. Without the roll the catalogue skipped straight to
  // January here and the dashboard would have called the return overdue on a
  // day it was not.
  const sunday = ctx({ carrierOperation: 'A', today: utc(2026, 11, 1) })
  assert.equal(dueOn('ca_ifta_quarterly_return', sunday), '2026-11-02')

  // And the Q4 return in the new year, which is the one carriers forget because
  // it shares a month with nothing else. 31 Jan 2027 is a Sunday.
  const november = ctx({ carrierOperation: 'A', today: utc(2026, 11, 15) })
  assert.equal(dueOn('ca_ifta_quarterly_return', november), '2027-02-01')
})

test('the catalogue and the IFTA screen give one return one due date', () => {
  // Two implementations of the same statutory date is how the dashboard said
  // 31 Oct while /app/ifta said 2 Nov. Pinned equal for the next four quarters.
  for (const [y, m] of [[2026, 6], [2026, 9], [2027, 0], [2027, 3]] as const) {
    const quarterStart = utc(y, m + 1, 1)
    // Asked mid-way through the quarter's second month: the previous quarter's
    // return has passed even after a weekend roll, and this quarter's is the
    // next configured date.
    const today = utc(y, m + 2, 15)
    const fromRule = dueOn('ca_ifta_quarterly_return', ctx({ carrierOperation: 'A', today }))
    assert.equal(fromRule, returnDueOn(quarterStart).toISOString().slice(0, 10))
  }
})

test('an intrastate-only carrier owes no IFTA return', () => {
  assert.equal(
    outcome('ca_ifta_quarterly_return', ctx({ carrierOperation: 'B' })).kind,
    'not_applicable',
  )
})

test('the IFTA renewal deadline and the decal display deadline are two different dates', () => {
  // THE trap. The renewal APPLICATION is due before 31 December. The January-
  // February grace period is for DISPLAYING the new decals only — it is not two
  // extra months to file in. Modelling IFTA as a single late-February deadline
  // gives a carrier two months of false comfort with an expired licence.
  const c = ctx({ carrierOperation: 'A' })
  const file = dueOn('ca_ifta_license_renewal', c)
  const display = dueOn('ca_ifta_decal_display', c)

  assert.equal(file, '2026-12-31')
  assert.equal(display, '2027-02-28')
  assert.notEqual(file, display)
  assert.ok(new Date(file) < new Date(display), 'filing must come before display')

  // They are also genuinely two rows, not one row read twice.
  assert.notEqual(rule('ca_ifta_license_renewal').code, rule('ca_ifta_decal_display').code)
})

test('the decal display deadline is the last day of February, leap year included', () => {
  const c = ctx({ carrierOperation: 'A', today: utc(2027, 3, 1) })
  assert.equal(dueOn('ca_ifta_decal_display', c), '2028-02-29')
})

// -----------------------------------------------------------------------------
// IRP
// -----------------------------------------------------------------------------

test('IRP without the carrier’s assigned month is missing_data, never a guess', () => {
  // The month is assigned by DMV per account and there is no public lookup
  // anywhere. Inventing a plausible date here takes trucks off the road.
  const out = outcome('ca_irp_renewal', ctx({ carrierOperation: 'A' }))
  assert.equal(out.kind, 'missing_data')
  if (out.kind !== 'missing_data') return
  assert.deepEqual([...out.needs], ['irp_last_renewed'])
})

test('IRP renews twelve months after the last renewal, staggered per carrier', () => {
  const c = ctx({ carrierOperation: 'A', anchors: { irp_last_renewed: utc(2025, 11, 30) } })
  assert.equal(dueOn('ca_irp_renewal', c), '2026-11-30')

  // Staggered means two carriers get two different dates from the same rule.
  const other = ctx({ carrierOperation: 'A', anchors: { irp_last_renewed: utc(2026, 4, 30) } })
  assert.equal(dueOn('ca_irp_renewal', other), '2027-04-30')
})

test('a carrier who last renewed IRP two years ago reads overdue, not "due next year"', () => {
  const c = ctx({ carrierOperation: 'A', anchors: { irp_last_renewed: utc(2025, 11, 30) } })
  assert.equal(status(rule('ca_irp_renewal'), c, utc(2024, 11, 30)).standing, 'overdue')
  assert.equal(status(rule('ca_irp_renewal'), c, utc(2025, 11, 30)).standing, 'current')
})

// -----------------------------------------------------------------------------
// Employment items
// -----------------------------------------------------------------------------

test('Form 300A is anchored to 1 February, when the posting window OPENS', () => {
  assert.equal(dueOn('ca_osha_300a_posting', ctx()), '2027-02-01')

  // 30 April is when the summary may come DOWN. Anchoring there would let a
  // carrier sit unposted through the whole window and still look compliant.
  const r = rule('ca_osha_300a_posting').recurrence
  assert.equal(r.type, 'fixed_calendar')
  if (r.type !== 'fixed_calendar') return
  assert.deepEqual([...r.months], [2])
  assert.equal(r.day, 1)
})

test('harassment training is two years per person, not one company-wide date', () => {
  const trainedJune = ctx({ anchors: { harassment_training_completed: utc(2025, 6, 10) } })
  const trainedJanuary = ctx({ anchors: { harassment_training_completed: utc(2026, 1, 5) } })

  assert.equal(dueOn('ca_harassment_training', trainedJune), '2027-06-10')
  assert.equal(dueOn('ca_harassment_training', trainedJanuary), '2028-01-05')
})

test('the WVPP review runs from the last review, not from every January', () => {
  const marchReviewer = ctx({ anchors: { wvpp_plan_reviewed: utc(2026, 3, 20) } })
  assert.equal(dueOn('ca_wvpp_annual_review', marchReviewer), '2027-03-20')
})

test('WVPP training is a separate row from the WVPP plan review', () => {
  // A carrier can be current on the plan and years behind on the training.
  const c = ctx({
    anchors: { wvpp_plan_reviewed: utc(2026, 3, 20), wvpp_training_completed: utc(2026, 5, 5) },
  })
  assert.equal(dueOn('ca_wvpp_annual_review', c), '2027-03-20')
  assert.equal(dueOn('ca_wvpp_annual_training', c), '2027-05-05')
})

test('no rule invents an annual IIPP review', () => {
  // 8 CCR 3203 has no review cadence. Annual review is a consultant habit, and
  // a fake date on a real regulation devalues the real ones next to it.
  for (const r of californiaRules) {
    assert.ok(!/iipp/i.test(`${r.code} ${r.title}`), `${r.code} invents an IIPP deadline`)
  }
})

// -----------------------------------------------------------------------------
// The intrastate medical certificate (B13)
// -----------------------------------------------------------------------------

test('NO CALIFORNIA DRIVER FALLS BETWEEN THE FEDERAL AND STATE MEDICAL RULES', () => {
  // THE TEST THIS WHOLE RULE EXISTS FOR, and the one to read before changing
  // either gate.
  //
  // The five federal medical rules gate on `interstateDriver`, which returns
  // false for operation code 'B' or 'C'. California's rule gates on a POSITIVE
  // 'B' or 'C'. Between them they must cover every value the code can take,
  // with no gap and no double-count — and they live in two different files, so
  // nothing but this assertion keeps them in step.
  //
  // A gap here is not a cosmetic bug. src/lib/dispatch/eligibility.ts blocks a
  // dispatch on a medical rule code; a driver with no medical row at all cannot
  // trigger a block, and goes out with an expired card and nothing said.
  const EXPIRED = utc(2025, 10, 1)

  for (const carrierOperation of [undefined, 'A', 'B', 'C']) {
    const rows = evaluate(
      [
        {
          type: 'driver',
          id: 'd1',
          label: 'A Driver',
          context: { carrierOperation, registrationState: 'CA', cdl: true },
          anchors: { medical_certificate_expires: EXPIRED },
        },
      ],
      TODAY,
    ).filter((i) => MEDICAL_RULE_CODES.has(i.rule.code))

    assert.ok(
      rows.length >= 1,
      `operation code ${String(carrierOperation)}: NO medical rule at all — this driver ` +
        'can be dispatched with an expired card and nothing will say so',
    )
    assert.equal(
      rows.length,
      1,
      `operation code ${String(carrierOperation)}: ${rows.length} rules report on one ` +
        `certificate (${rows.map((r) => r.rule.code).join(', ')})`,
    )
    assert.equal(
      rows[0]?.status.standing,
      'overdue',
      `operation code ${String(carrierOperation)}: an expired card must read overdue`,
    )
  }
})

test('the intrastate rule takes exactly the drivers the federal rules let go', () => {
  const codeFor = (carrierOperation?: string) =>
    evaluate(
      [
        {
          type: 'driver',
          id: 'd1',
          label: 'D',
          context: { carrierOperation, registrationState: 'CA', cdl: true },
          anchors: { medical_certificate_expires: utc(2027, 1, 1) },
        },
      ],
      TODAY,
    ).find((i) => MEDICAL_RULE_CODES.has(i.rule.code))?.rule.code

  // Interstate and unknown belong to the federal rule, which fails open on a
  // missing code. Intrastate belongs to California.
  assert.equal(codeFor('A'), 'medical_certificate_general')
  assert.equal(codeFor(undefined), 'medical_certificate_general')
  assert.equal(codeFor('B'), 'ca_intrastate_medical_certificate')
  assert.equal(codeFor('C'), 'ca_intrastate_medical_certificate')
})

test('an out-of-state intrastate carrier gets no medical rule, and that is a known hole', () => {
  // A DELIBERATE, DOCUMENTED GAP — asserted so that adding a second state has
  // to look at it rather than inherit it.
  //
  // `interstateDriver` in federal-driver.ts returns false for any 'B'/'C'
  // carrier, wherever it is based, on the stated assumption that the state
  // catalogue carries the replacement. California's now does. Texas has no
  // catalogue here, and a California Vehicle Code row must not be shown to a
  // Texas carrier — so a Texas intrastate driver has NO medical row.
  //
  // This is correct for a product sold in California and wrong the day it is
  // sold anywhere else. When this test fails because Arizona was added, that is
  // the fix landing, not a regression.
  const rows = evaluate(
    [
      {
        type: 'driver',
        id: 'd1',
        label: 'D',
        context: { carrierOperation: 'B', registrationState: 'TX', cdl: true },
        anchors: { medical_certificate_expires: utc(2025, 10, 1) },
      },
    ],
    TODAY,
  ).filter((i) => MEDICAL_RULE_CODES.has(i.rule.code))

  assert.deepEqual(
    rows.map((r) => r.rule.code),
    [],
    'a state catalogue now covers this carrier — update the federal gate too',
  )
})

test('the California rule is not the federal rule with the word changed', () => {
  const ca = rule('ca_intrastate_medical_certificate')

  // The authority is the licence statute, not the CHP motor-carrier statute.
  // Veh. Code 34501(a)(1) does not list driver medical qualification among what
  // CHP may regulate, and 34501.12 is the terminal-inspection section.
  assert.match(ca.citation, /12804\.9/)
  assert.doesNotMatch(ca.citation, /34501/)
  assert.doesNotMatch(ca.citation, /391\.45/)
  assert.ok(ca.sourceUrl.startsWith('https://leginfo.legislature.ca.gov/'))

  // Two years, and it is the printed date that governs — not 24 months assumed
  // from the examination.
  assert.equal(ca.maxTermMonths, 24)
  assert.equal(ca.recurrence.type, 'expiry')

  // It must NOT gate on holding a CDL. Veh. Code 12804.9(a)(2)(A) reaches "a
  // class A or class B driver's license, or class C driver's license with a
  // commercial endorsement", which takes in non-commercial class A and B
  // holders. Gating on `cdl` would drop them.
  const withoutCdl = nextDue(ca, ctx({ carrierOperation: 'B', cdl: false }))
  assert.notEqual(withoutCdl.kind, 'not_applicable', 'a non-CDL class A driver still owes this')

  // The California-specific fact an owner will otherwise miss: the certificate
  // has to reach the DMV, not just the driver's folder.
  assert.match(ca.evidence, /DMV/)

  // And no invented instrument. DL 51 and DL 51B could not be confirmed against
  // any primary source, so they must not appear anywhere in the row.
  const text = `${ca.title} ${ca.citation} ${ca.evidence} ${ca.consequence}`
  assert.doesNotMatch(text, /DL\s*51/i, 'an unconfirmed form number reached the rule row')
  // No downgrade timeline either: 12804.9(c) states no grace period and no
  // notice, and the federal 60-day CDL downgrade is a different mechanism.
  assert.doesNotMatch(text, /60 days/i)
})

test('an expired intrastate certificate is overdue, so a dispatch block can see it', () => {
  const expired = status(
    rule('ca_intrastate_medical_certificate'),
    ctx({ carrierOperation: 'B', anchors: { medical_certificate_expires: utc(2026, 8, 1) } }),
    utc(2026, 8, 1),
  )
  assert.equal(expired.standing, 'overdue')

  // And with no date at all it is a gap, never green.
  const blank = status(
    rule('ca_intrastate_medical_certificate'),
    ctx({ carrierOperation: 'B' }),
    null,
  )
  assert.equal(blank.standing, 'unknown')
  assert.deepEqual([...(blank.needs ?? [])], ['medical_certificate_expires'])
})

test('the dispatch block does NOT yet stop a truck on the intrastate certificate', () => {
  // A TRIPWIRE, NOT AN ENDORSEMENT. Written the way the "no rule claims to have
  // been verified" test is written: it pins a state that is wrong, so that
  // fixing it is a deliberate act rather than something discovered later.
  //
  // `BLOCKING_RULE_CODES` in src/lib/dispatch/eligibility.ts is a hand-written
  // set of the five FEDERAL medical codes plus the CDL. Those five all answer
  // "not applicable" for a carrier marked intrastate, so before this rule the
  // set matched NOTHING for them: an expired certificate produced a row on the
  // dashboard and no block at all on the assignment screen.
  //
  // THAT FIX HAS LANDED: the code is in BLOCKING_RULE_CODES, and the two
  // assertions below now pin the block rather than its absence. They are what
  // stops somebody tidying the set and quietly making an intrastate driver
  // dispatchable on an expired card again.
  const items = evaluate(
    [
      {
        type: 'driver',
        id: 'd1',
        label: 'A Driver',
        context: { carrierOperation: 'B', registrationState: 'CA', cdl: true },
        anchors: { medical_certificate_expires: utc(2025, 10, 1) },
      },
    ],
    TODAY,
  )
  const issues = eligibility({ items, label: 'A Driver' })

  assert.equal(
    issues.some((i) => i.ruleCode === 'ca_intrastate_medical_certificate'),
    true,
    'eligibility.ts must know this rule, or an intrastate driver is never blocked',
  )
  assert.equal(
    issues.some((i) => i.severity === 'block'),
    true,
    'an intrastate driver with an expired medical card must not be dispatchable',
  )
})
