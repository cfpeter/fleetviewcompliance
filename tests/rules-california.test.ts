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
import { californiaRules } from '../src/lib/rules/california.ts'
import { nextDue, status } from '../src/lib/rules/compute.ts'
import type { Outcome, RuleContext, RuleDefinition } from '../src/lib/rules/types.ts'

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
  const c = ctx({ gvwrLbs: 33_000, anchors: { bit_last_inspection: utc(2026, 8, 20) } })
  assert.equal(dueOn('ca_bit_inspection', c), '2026-11-20')

  // Pinned explicitly: three months, not twenty-five.
  const r = rule('ca_bit_inspection').recurrence
  assert.equal(r.type, 'rolling')
  if (r.type !== 'rolling') return
  assert.equal(r.intervalMonths, 3)
})

test('a truck under 26,001 lb is not declared exempt from BIT', () => {
  // CVC 34500 also reaches lighter combinations, placarded hazmat and buses, so
  // 'unknown' keeps the rule on the board rather than asserting an exemption.
  const c = ctx({ gvwrLbs: 20_000, anchors: { bit_last_inspection: utc(2026, 8, 20) } })
  assert.equal(dueOn('ca_bit_inspection', c), '2026-11-20')
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
  const c = ctx({ carrierOperation: 'A' })
  assert.equal(dueOn('ca_ifta_quarterly_return', c), '2026-10-31')

  // And the Q4 return in the new year, which is the one carriers forget because
  // it shares a month with nothing else.
  const january = ctx({ carrierOperation: 'A', today: utc(2026, 11, 1) })
  assert.equal(dueOn('ca_ifta_quarterly_return', january), '2027-01-31')
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
