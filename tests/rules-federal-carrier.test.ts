/**
 * The federal catalogue, worked one rule at a time.
 *
 * Every test below is a WORKED EXAMPLE with real numbers, because the only
 * thing that makes a compliance date trustworthy is that somebody can check it
 * by hand. A test that asserts "returns a Date" proves nothing an owner cares
 * about.
 *
 * Two behaviours are load-bearing and get their own tests everywhere they
 * apply:
 *   - a stale filing resolves to `overdue`, never to "due in two years"
 *   - a missing anchor resolves to `missing_data`, never to a plausible guess
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextDue, type Status, status } from '../src/lib/rules/compute.ts'
import { federalCarrierRules } from '../src/lib/rules/federal-carrier.ts'
import type { RuleContext, RuleDefinition } from '../src/lib/rules/types.ts'

/** Every undated test runs "today". Fixed, so the suite cannot rot into green. */
const TODAY = new Date(Date.UTC(2026, 8, 14)) // 2026-09-14

function ctx(over: Partial<RuleContext> = {}): RuleContext {
  return { today: TODAY, ...over }
}

function rule(code: string): RuleDefinition {
  const found = federalCarrierRules.find((r) => r.code === code)
  if (!found) throw new Error(`no rule with code '${code}'`)
  return found
}

/** Asserts the outcome is a date and returns it as YYYY-MM-DD. */
function due(code: string, c: RuleContext): string {
  const outcome = nextDue(rule(code), c)
  assert.equal(outcome.kind, 'due', `expected a date, got ${JSON.stringify(outcome)}`)
  return outcome.kind === 'due' ? outcome.on.toISOString().slice(0, 10) : ''
}

/** Asserts the outcome is `missing_data` and returns what it asked for. */
function needs(code: string, c: RuleContext): readonly string[] {
  const outcome = nextDue(rule(code), c)
  assert.equal(outcome.kind, 'missing_data', `expected missing_data, got ${outcome.kind}`)
  return outcome.kind === 'missing_data' ? outcome.needs : []
}

/** Asserts the outcome is an honest refusal and returns the reason. */
function refusal(code: string, c: RuleContext): string {
  const outcome = nextDue(rule(code), c)
  assert.equal(outcome.kind, 'unsupported', `expected unsupported, got ${outcome.kind}`)
  return outcome.kind === 'unsupported' ? outcome.reason : ''
}

function standing(code: string, c: RuleContext, lastDone: Date | null): Status {
  return status(rule(code), c, lastDone)
}

function iso(d: Date | undefined): string {
  return d ? d.toISOString().slice(0, 10) : ''
}

// ---------------------------------------------------------------------------
// Catalogue-wide guards
// ---------------------------------------------------------------------------

test('rule codes are unique', () => {
  const codes = federalCarrierRules.map((r) => r.code)
  assert.equal(new Set(codes).size, codes.length)
})

test('nothing claims to have been verified by a person', () => {
  // These fields mean a qualified human signed off. Nobody has.
  for (const r of federalCarrierRules) {
    assert.equal(r.verifiedBy, undefined, r.code)
    assert.equal(r.verifiedOn, undefined, r.code)
  }
})

test('every rule carries a citation and a clickable primary source', () => {
  for (const r of federalCarrierRules) {
    assert.ok(r.citation.length > 0, r.code)
    assert.ok(r.sourceUrl.startsWith('https://'), r.code)
    assert.ok(r.consequence.length > 0, r.code)
    assert.ok(r.evidence.length > 0, r.code)
  }
})

test('every computed schedule named by a rule is actually registered', () => {
  // A typo in a `fn` name degrades to `unsupported` at runtime with a reason
  // that reads like a legal position. Catch it here instead.
  const full = ctx({
    dotNumber: '21800',
    carrierOperation: 'A',
    hazmat: true,
    gvwrLbs: 80_000,
    anchors: {
      periodic_inspection_date: new Date(Date.UTC(2026, 0, 5)),
      hvut_first_use_date: new Date(Date.UTC(2026, 6, 5)),
      accident_date: new Date(Date.UTC(2026, 0, 5)),
    },
  })
  for (const r of federalCarrierRules) {
    if (r.recurrence.type !== 'computed') continue
    const outcome = nextDue(r, full)
    if (outcome.kind === 'unsupported') {
      assert.ok(!outcome.reason.includes('no implementation registered'), r.code)
    }
  }
})

// ---------------------------------------------------------------------------
// Vehicle — annual DOT inspection, 396.17
// ---------------------------------------------------------------------------

const PU_INSPECTION = 'fed.396.17.periodic-inspection.power-unit'
const TR_INSPECTION = 'fed.396.17.periodic-inspection.trailer'

test('annual inspection rolls 12 months from the last one, not to a fixed month', () => {
  // Inspected 1 March 2026; asked on 14 September 2026. Due 1 March 2027.
  const c = ctx({
    gvwrLbs: 33_000,
    anchors: { periodic_inspection_date: new Date(Date.UTC(2026, 2, 1)) },
  })
  assert.equal(due(PU_INSPECTION, c), '2027-03-01')
  assert.equal(standing(PU_INSPECTION, c, new Date(Date.UTC(2026, 2, 1))).standing, 'current')
})

test('a truck inspected 15 months ago is overdue, not "due next June"', () => {
  // Inspected 10 June 2025. The 10 June 2026 deadline came and went.
  const last = new Date(Date.UTC(2025, 5, 10))
  const c = ctx({ gvwrLbs: 33_000, anchors: { periodic_inspection_date: last } })
  const s = standing(PU_INSPECTION, c, last)
  assert.equal(s.standing, 'overdue')
  assert.equal(iso(s.lastDue), '2026-06-10')
  assert.equal(iso(s.nextDue), '2027-06-10')
})

test('no inspection date means missing_data, not an invented deadline', () => {
  assert.deepEqual(needs(PU_INSPECTION, ctx({ gvwrLbs: 33_000 })), ['periodic_inspection_date'])
})

test('a known-light, known-non-hazmat unit is not a CMV and the rule says so', () => {
  const outcome = nextDue(rule(PU_INSPECTION), ctx({ gvwrLbs: 8_600, hazmat: false }))
  assert.equal(outcome.kind, 'not_applicable')
})

test('a light unit of unknown hazmat status is still tracked — applicability fails open', () => {
  // 8,600 lb but we have not been told whether it is placarded. Under 390.5T
  // placarded hazmat is a CMV at any weight, so we do not clear it.
  assert.deepEqual(needs(PU_INSPECTION, ctx({ gvwrLbs: 8_600 })), ['periodic_inspection_date'])
})

test('a trailer carries its own inspection clock — each unit is inspected separately', () => {
  assert.equal(rule(TR_INSPECTION).subject, 'trailer')
  // Inspected 31 January 2026, so due 31 January 2027 — and the month-end must
  // not roll forward into February.
  const c = ctx({
    gvwrLbs: 65_000,
    anchors: { periodic_inspection_date: new Date(Date.UTC(2026, 0, 31)) },
  })
  assert.equal(due(TR_INSPECTION, c), '2027-01-31')
})

// ---------------------------------------------------------------------------
// Vehicle — 14-month report retention, 396.21
// ---------------------------------------------------------------------------

const PU_RETENTION = 'fed.396.21.inspection-report-retention.power-unit'
const TR_RETENTION = 'fed.396.21.inspection-report-retention.trailer'

test('the inspection report must be kept 14 months from the inspection', () => {
  // Inspected 1 March 2026 → keep until 1 May 2027.
  const c = ctx({
    gvwrLbs: 33_000,
    anchors: { periodic_inspection_date: new Date(Date.UTC(2026, 2, 1)) },
  })
  assert.equal(due(PU_RETENTION, c), '2027-05-01')
})

test('retention clamps backward into a short month rather than drifting later', () => {
  // Trailer inspected 31 December 2025; 14 months lands in February 2027,
  // which has 28 days. It must be 28 February, never 3 March.
  const c = ctx({
    gvwrLbs: 65_000,
    anchors: { periodic_inspection_date: new Date(Date.UTC(2025, 11, 31)) },
  })
  assert.equal(due(TR_RETENTION, c), '2027-02-28')
})

test('retention with no inspection date returns missing_data', () => {
  assert.deepEqual(needs(PU_RETENTION, ctx({ gvwrLbs: 33_000 })), ['periodic_inspection_date'])
})

// ---------------------------------------------------------------------------
// Vehicle — DVIR and brake inspector qualification
// ---------------------------------------------------------------------------

test('DVIR has no schedule, and the refusal says a no-defect report is not required', () => {
  const reason = refusal('fed.396.11.dvir', ctx({ gvwrLbs: 33_000 }))
  assert.match(reason, /only where the driver finds/i)
  assert.match(reason, /three months/i)
})

test('brake inspector qualification is one-time, with no recertification interval', () => {
  const reason = refusal('fed.396.25.brake-inspector-qualification', ctx())
  assert.match(reason, /one-time/i)
  assert.match(reason, /employment plus one year/i)
})

// ---------------------------------------------------------------------------
// Carrier — MCS-150 biennial update, 390.19T
// ---------------------------------------------------------------------------

const MCS150 = 'fed.390.19T.mcs150-biennial-update'

test('MCS-150 cites 390.19T, never the suspended Mexico-only 390.19', () => {
  const r = rule(MCS150)
  assert.match(r.citation, /390\.19T/)
  // A bare "390.19" anywhere in the citation would be the documented trap.
  assert.equal(/390\.19(?!T)/.test(r.citation), false)
  assert.match(r.sourceUrl, /section-390\.19T$/)
})

test('MCS-150: USDOT 21800 files in even Octobers — last digit 0 means October', () => {
  // Last digit 0 → October (not December). Next-to-last 0 → even → even years.
  const c = ctx({
    today: new Date(Date.UTC(2026, 0, 1)),
    dotNumber: '21800',
    carrierOperation: 'A',
  })
  assert.equal(due(MCS150, c), '2026-10-31')
})

test('MCS-150 overdue by several cycles resolves to overdue, not "due in two years"', () => {
  // USDOT 1000045 → last digit 5 = May; next-to-last 4 = even → even years.
  // Last filed 14 October 2021, so 2022, 2024 and 2026 were all missed. The next
  // future deadline is May 2028, and showing only that reads as two years of
  // slack to somebody whose USDOT number is deactivated today.
  const c = ctx({ dotNumber: '1000045', carrierOperation: 'A' })
  const s = standing(MCS150, c, new Date(Date.UTC(2021, 9, 14)))
  assert.equal(s.standing, 'overdue')
  assert.equal(iso(s.lastDue), '2026-05-31')
  assert.equal(iso(s.nextDue), '2028-05-31')
})

test('MCS-150 with no USDOT number returns missing_data', () => {
  assert.deepEqual(needs(MCS150, ctx({ carrierOperation: 'A' })), ['dot_number'])
})

test('MCS-150 is still tracked for an intrastate carrier — applicability fails open', () => {
  // 390.19T(a) does not reach a plain intrastate carrier by its own terms, but
  // states impose the update through their own rules and we have not verified
  // California's. 'unknown' means tracked, not cleared.
  const c = ctx({ dotNumber: '21800', carrierOperation: 'C', hazmat: false })
  assert.equal(due(MCS150, c), '2026-10-31')
})

test('MCS-150 is due even for a carrier who has filed nothing at all', () => {
  // No filing date is not "current" — the exposure is identical to overdue.
  const c = ctx({ dotNumber: '21800', carrierOperation: 'A' })
  assert.equal(standing(MCS150, c, null).standing, 'unknown')
})

// ---------------------------------------------------------------------------
// Carrier — UCR annual registration
// ---------------------------------------------------------------------------

const UCR = 'fed.ucr.annual-registration'

test('UCR falls due on the 31 December after the last registration year paid for', () => {
  // Paid through registration year 2025 → the 2026 fee is due before 1 January
  // 2026... which for a carrier standing in September 2026 means the 2027 year,
  // ending 31 December 2026.
  const c = ctx({
    carrierOperation: 'A',
    anchors: { ucr_paid_through: new Date(Date.UTC(2025, 11, 31)) },
  })
  assert.equal(due(UCR, c), '2026-12-31')
})

test('UCR with no self-reported registration year returns missing_data', () => {
  // There is no UCR API and no derivable status — the national lookup is
  // reCAPTCHA-gated. Asking is the only honest option.
  assert.deepEqual(needs(UCR, ctx({ carrierOperation: 'A' })), ['ucr_paid_through'])
})

test('a carrier three registration years behind on UCR reads as overdue', () => {
  const paidThrough = new Date(Date.UTC(2023, 11, 31))
  const c = ctx({ carrierOperation: 'A', anchors: { ucr_paid_through: paidThrough } })
  const s = standing(UCR, c, new Date(Date.UTC(2023, 10, 1)))
  assert.equal(s.standing, 'overdue')
  assert.equal(iso(s.lastDue), '2025-12-31')
  assert.equal(iso(s.nextDue), '2026-12-31')
})

// ---------------------------------------------------------------------------
// Carrier — Form 2290 / HVUT
// ---------------------------------------------------------------------------

const HVUT = 'fed.irs.2290.heavy-vehicle-use-tax'

test('2290 for a truck first used in July is due 31 August', () => {
  const c = ctx({
    today: new Date(Date.UTC(2026, 6, 10)),
    gvwrLbs: 80_000,
    anchors: { hvut_first_use_date: new Date(Date.UTC(2026, 6, 5)) },
  })
  assert.equal(due(HVUT, c), '2026-08-31')
})

test('2290 is NOT one annual fleet date: a November truck owes 31 December', () => {
  // The prorated return is due the last day of the month FOLLOWING first use.
  const july = ctx({
    today: new Date(Date.UTC(2026, 10, 25)),
    gvwrLbs: 80_000,
    anchors: { hvut_first_use_date: new Date(Date.UTC(2026, 6, 5)) },
  })
  const november = ctx({
    today: new Date(Date.UTC(2026, 10, 25)),
    gvwrLbs: 80_000,
    anchors: { hvut_first_use_date: new Date(Date.UTC(2026, 10, 20)) },
  })
  assert.equal(due(HVUT, november), '2026-12-31')
  // Same fleet, same day, two different deadlines. That is the whole point.
  assert.notEqual(due(HVUT, july), due(HVUT, november))
})

test('2290 returns to the 31 August cycle once the prorated return is behind it', () => {
  // First used November 2026 → prorated return due 31 December 2026. The next
  // tax period opens 1 July 2027, so its return is due 31 August 2027.
  const c = ctx({
    today: new Date(Date.UTC(2027, 0, 15)),
    gvwrLbs: 80_000,
    anchors: { hvut_first_use_date: new Date(Date.UTC(2026, 10, 20)) },
  })
  assert.equal(due(HVUT, c), '2027-08-31')
})

test('filing the prorated 2290 does not make you current for the next tax period', () => {
  // First used 10 March 2026 → prorated return due 30 April 2026, filed 25
  // April. The 1 July 2026 period then needed its own return by 31 August 2026,
  // which was missed.
  const c = ctx({
    gvwrLbs: 80_000,
    anchors: { hvut_first_use_date: new Date(Date.UTC(2026, 2, 10)) },
  })
  const s = standing(HVUT, c, new Date(Date.UTC(2026, 3, 25)))
  assert.equal(s.standing, 'overdue')
  assert.equal(iso(s.lastDue), '2026-08-31')
  assert.equal(iso(s.nextDue), '2027-08-31')
})

test('2290 with no first-use date returns missing_data', () => {
  assert.deepEqual(needs(HVUT, ctx({ gvwrLbs: 80_000 })), ['hvut_first_use_date'])
})

test('2290 is never ruled out on GVWR — taxable gross weight is a combination figure', () => {
  // A 33,000 lb tractor pulling a loaded trailer is over 55,000 lb taxable
  // gross weight, so a sub-threshold GVWR must not clear the rule.
  assert.deepEqual(needs(HVUT, ctx({ gvwrLbs: 33_000 })), ['hvut_first_use_date'])
})

// ---------------------------------------------------------------------------
// Carrier — operating authority and insurance
// ---------------------------------------------------------------------------

test('operating authority has no renewal date and the rule refuses to invent one', () => {
  const reason = refusal('fed.usc.13906.operating-authority', ctx({ carrierOperation: 'A' }))
  assert.match(reason, /no expiry date/i)
  assert.match(reason, /never a renewal date/i)
})

test('there is no "insurance expires" date anywhere in the catalogue', () => {
  // A BMC-91X filing is continuous until cancelled. Any date against it would
  // be fabricated, so the rule refuses and explains the cancellation chain.
  const reason = refusal('fed.387.9.liability-insurance-filing', ctx({ carrierOperation: 'A' }))
  assert.match(reason, /continuous until\s+cancelled/i)
  assert.match(reason, /35 days/)
  assert.match(reason, /not grace after it/i)
  // And nothing else in the catalogue quietly models an expiry either.
  assert.equal(
    federalCarrierRules.some((r) => /expir/i.test(r.title)),
    false,
  )
})

// ---------------------------------------------------------------------------
// Carrier — accident register, 390.15
// ---------------------------------------------------------------------------

const ACCIDENT = 'fed.390.15.accident-register-retention'

test('an accident register entry is kept three years from that accident', () => {
  // The clock runs per accident, not per calendar year.
  const c = ctx({ anchors: { accident_date: new Date(Date.UTC(2026, 1, 10)) } })
  assert.equal(due(ACCIDENT, c), '2029-02-10')
})

test('accident register with no accident date returns missing_data', () => {
  assert.deepEqual(needs(ACCIDENT, ctx()), ['accident_date'])
})

// ---------------------------------------------------------------------------
// Carrier — hours of service and ELD records, Part 395
// ---------------------------------------------------------------------------

test('RODS retention is a rolling six-month window, not a date', () => {
  const reason = refusal('fed.395.8.rods-retention', ctx())
  assert.match(reason, /six months from receipt/i)
  assert.match(reason, /oldest record on hand/i)
})

test('supporting documents keep eight per driver per day, bracketing the day', () => {
  const reason = refusal('fed.395.11.supporting-documents-retention', ctx())
  assert.match(reason, /eight supporting/i)
  assert.match(reason, /earliest and latest time/i)
})

test('the ELD back-up must sit on a separate device from the original data', () => {
  const reason = refusal('fed.395.22.eld-backup-retention', ctx())
  assert.match(reason, /separate obligation/i)
  assert.match(reason, /device other than the one/i)
})

// ---------------------------------------------------------------------------
// Hazmat
// ---------------------------------------------------------------------------

const HM_TRAINING = 'fed.172.704.hazmat-recurrent-training'
const HM_REGISTRATION = 'fed.107.608.hazmat-registration'

test('hazmat recurrent training rolls three years from the last training', () => {
  const last = new Date(Date.UTC(2024, 4, 1))
  const c = ctx({ hazmat: true, anchors: { hazmat_training_date: last } })
  assert.equal(due(HM_TRAINING, c), '2027-05-01')
  assert.equal(standing(HM_TRAINING, c, last).standing, 'current')
})

test('hazmat training last done in 2022 is overdue, not "due in 2028"', () => {
  const last = new Date(Date.UTC(2022, 0, 10))
  const c = ctx({ hazmat: true, anchors: { hazmat_training_date: last } })
  const s = standing(HM_TRAINING, c, last)
  assert.equal(s.standing, 'overdue')
  assert.equal(iso(s.lastDue), '2025-01-10')
  assert.equal(iso(s.nextDue), '2028-01-10')
})

test('hazmat training does not apply to a carrier that hauls no hazmat', () => {
  const outcome = nextDue(rule(HM_TRAINING), ctx({ hazmat: false }))
  assert.equal(outcome.kind, 'not_applicable')
})

test('hazmat training is tracked when we do not know whether they haul hazmat', () => {
  assert.deepEqual(needs(HM_TRAINING, ctx()), ['hazmat_training_date'])
})

test('PHMSA hazmat registration is due 30 June, a real fixed calendar date', () => {
  // Asked on 14 September 2026: this year's 30 June has gone, so 2027.
  assert.equal(due(HM_REGISTRATION, ctx({ hazmat: true })), '2027-06-30')
})

test('a hazmat carrier who last registered in 2024 is overdue against 30 June 2026', () => {
  const s = standing(HM_REGISTRATION, ctx({ hazmat: true }), new Date(Date.UTC(2024, 5, 1)))
  assert.equal(s.standing, 'overdue')
  assert.equal(iso(s.lastDue), '2026-06-30')
  assert.equal(iso(s.nextDue), '2027-06-30')
})

test('hazmat registration does not apply to a non-hazmat carrier', () => {
  const outcome = nextDue(rule(HM_REGISTRATION), ctx({ hazmat: false }))
  assert.equal(outcome.kind, 'not_applicable')
})
