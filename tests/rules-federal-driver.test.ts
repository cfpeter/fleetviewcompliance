/**
 * One worked example per federal driver rule, plus the traps that would have
 * produced a plausible-looking wrong date.
 *
 * Every assertion here is a date an owner would act on. A test that only proved
 * "a Date came back" would pass for all of the wrong answers this file exists to
 * rule out, so each one pins the exact day.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextDue, status } from '../src/lib/rules/compute.ts'
import { federalDriverRules } from '../src/lib/rules/federal-driver.ts'
import type { RuleContext, RuleDefinition } from '../src/lib/rules/types.ts'

/** Fixed "today" so a test never changes its answer because a year rolled over. */
const TODAY = new Date(Date.UTC(2026, 8, 15))

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d))
}

function rule(code: string): RuleDefinition {
  const found = federalDriverRules.find((r) => r.code === code)
  if (!found) assert.fail(`no rule with code '${code}' in the catalogue`)
  return found
}

type Anchors = Readonly<Record<string, Date>>

/**
 * A driver we know everything about: interstate, CDL. Tests that care about
 * applicability override these; tests that care about dates should not have to
 * think about them.
 */
function ctx(anchors: Anchors = {}, extra: Partial<RuleContext> = {}): RuleContext {
  return { today: TODAY, carrierOperation: 'A', cdl: true, anchors, ...extra }
}

/** The due date as 'YYYY-MM-DD', failing loudly if the rule declined to answer. */
function dueOn(code: string, anchors: Anchors, extra: Partial<RuleContext> = {}): string {
  const out = nextDue(rule(code), ctx(anchors, extra))
  if (out.kind !== 'due') assert.fail(`expected a due date for '${code}', got '${out.kind}'`)
  return out.on.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Part 391 — one worked example per rule
// ---------------------------------------------------------------------------

const HIRE = { hire_date: utc(2026, 3, 2) }

test('DQF must exist from the first day of employment', () => {
  assert.equal(dueOn('dqf_maintained', HIRE), '2026-03-02')
})

test('hire-time MVR inquiry is 30 DAYS after hire, not one month', () => {
  // 2 March + 30 days = 1 April. One month would have said 2 April — a day late,
  // and later is the one direction a compliance date must never drift.
  assert.equal(dueOn('mvr_inquiry_at_hire', HIRE), '2026-04-01')
})

test('the 30-day clock crosses a short month correctly', () => {
  // The case that separates days from months most sharply: hired 31 January,
  // 30 days lands on 2 March. addMonthsClamped(+1) would have said 28 February.
  const due = dueOn('mvr_inquiry_at_hire', { hire_date: utc(2026, 1, 31) })
  assert.equal(due, '2026-03-02')
  assert.notEqual(due, '2026-02-28')
})

test('safety performance history investigation runs the same 30-day clock', () => {
  assert.equal(dueOn('safety_performance_history_investigation', HIRE), '2026-04-01')
})

test('the two 391.23 obligations are separate rules, not one row', () => {
  // A carrier who pulled the MVR has not investigated the previous employers.
  // The lookbacks differ too: 3 years for 391.23(e), 2 years for the Part 40
  // previous-employer records check at 40.25(b).
  const mvr = rule('mvr_inquiry_at_hire')
  const history = rule('safety_performance_history_investigation')
  assert.notEqual(mvr.code, history.code)
  assert.match(history.evidence, /3 YEARS/)
  assert.match(history.consequence, /391\.53\(c\)/)
})

test('annual MVR inquiry rolls 12 months from the last one, not to a calendar date', () => {
  // Pulled 10 March 2026 -> due 10 March 2027. Nothing about December or 31 Dec.
  assert.equal(
    dueOn('mvr_inquiry_annual', { annual_mvr_last_obtained: utc(2026, 3, 10) }),
    '2027-03-10',
  )
})

test('annual MVR is rolling: a different completion date gives a different deadline', () => {
  // The point of "rolling": two drivers in the same fleet have different dates.
  assert.equal(
    dueOn('mvr_inquiry_annual', { annual_mvr_last_obtained: utc(2026, 7, 1) }),
    '2027-07-01',
  )
})

test('annual review note rolls 12 months from the last REVIEW', () => {
  assert.equal(
    dueOn('driving_record_review_annual', { annual_review_last_completed: utc(2025, 11, 2) }),
    '2026-11-02',
  )
})

test('pulling the MVR does not satisfy the annual review', () => {
  // Distinct anchors are what make this true. Supplying only the MVR date leaves
  // the review unanswered rather than silently marking it done.
  const out = nextDue(
    rule('driving_record_review_annual'),
    ctx({
      annual_mvr_last_obtained: utc(2026, 3, 10),
    }),
  )
  assert.equal(out.kind, 'missing_data')
  if (out.kind === 'missing_data') {
    assert.deepEqual(out.needs, ['annual_review_last_completed'])
  }
})

test('road test is one-time at hire and never recurs', () => {
  assert.equal(dueOn('road_test_or_equivalent', HIRE), '2026-03-02')
  assert.equal(rule('road_test_or_equivalent').recurrence.type, 'computed')
})

test('medical certificate uses the expiry PRINTED on the card, not a 24-month assumption', () => {
  // An examiner may certify for any period up to 24 months, and a short card is
  // issued precisely when a doctor is worried about the driver. Assuming the
  // maximum would be up to 21 months too generous for exactly those drivers.
  assert.equal(
    dueOn('medical_certificate_general', { medical_certificate_expires: utc(2026, 11, 2) }),
    '2026-11-02',
  )
  // A three-month card is honoured as three months.
  assert.equal(
    dueOn('medical_certificate_general', { medical_certificate_expires: utc(2026, 10, 1) }),
    '2026-10-01',
  )
})

test('an expired medical certificate stays in the past, never rolled forward', () => {
  // The dangerous shape: a lapsed card must not be silently stepped to a
  // comfortable future date. It expired, and the answer is the day it expired.
  const due = dueOn(
    'medical_certificate_general',
    { medical_certificate_expires: utc(2025, 4, 1) },
    { today: utc(2026, 9, 15) },
  )
  assert.equal(due, '2025-04-01')
})

test('intracity zone variant is 12 months, half the general case', () => {
  const anchors = {
    medical_exam_date: utc(2026, 4, 20),
    intracity_zone_exemption_issued: utc(2026, 4, 20),
  }
  assert.equal(dueOn('medical_certificate_intracity_zone', anchors), '2027-04-20')
  // The general rule now reads the printed expiry rather than assuming a term,
  // so with only an exam date it correctly refuses to answer.
  assert.equal(
    nextDue(rule('medical_certificate_general'), ctx(anchors)).kind,
    'missing_data',
    'without a printed expiry the general rule must not invent a 24-month term',
  )
})

test('insulin-treated diabetes variant is 12 months', () => {
  assert.equal(
    dueOn('medical_certificate_insulin_treated', {
      medical_exam_date: utc(2026, 4, 20),
      insulin_treated_diabetes_assessment: utc(2026, 4, 1),
    }),
    '2027-04-20',
  )
})

test('alternative vision standard variant is 12 months', () => {
  assert.equal(
    dueOn('medical_certificate_alternative_vision', {
      medical_exam_date: utc(2026, 4, 20),
      alternative_vision_evaluation: utc(2026, 3, 30),
    }),
    '2027-04-20',
  )
})

test('every 12-month medical variant really is 12 months', () => {
  // Guards against somebody "harmonising" a variant back to 24 during a cleanup.
  for (const code of [
    'medical_certificate_intracity_zone',
    'medical_certificate_insulin_treated',
    'medical_certificate_alternative_vision',
  ]) {
    const r = rule(code).recurrence
    assert.equal(r.type, 'rolling')
    if (r.type === 'rolling') assert.equal(r.intervalMonths, 12)
  }
  // The general case is scheduled off the PRINTED expiry, so its 24-month
  // ceiling lives in maxTermMonths rather than in the recurrence. Guard both:
  // the ceilings are what make a too-long certificate detectable.
  const general = rule('medical_certificate_general')
  assert.equal(general.recurrence.type, 'expiry')
  assert.equal(general.maxTermMonths, 24)
  for (const code of [
    'medical_certificate_intracity_zone',
    'medical_certificate_insulin_treated',
    'medical_certificate_alternative_vision',
  ]) {
    assert.equal(rule(code).maxTermMonths, 12, `${code} must keep its 12-month ceiling`)
  }
})

test('SPE renewal is read off the certificate, not from an invented interval', () => {
  assert.equal(
    dueOn('spe_certificate_renewal', { spe_certificate_expiry: utc(2027, 5, 31) }),
    '2027-05-31',
  )
})

// ---------------------------------------------------------------------------
// Part 382 / Part 40
// ---------------------------------------------------------------------------

test('pre-employment Clearinghouse query is due before the first day worked', () => {
  assert.equal(dueOn('clearinghouse_query_pre_employment', HIRE), '2026-03-02')
})

test('annual Clearinghouse query is a rolling year — there is NO 31 January deadline', () => {
  // The single most repeated wrong fact in this industry. Queried 1 February
  // 2026 -> due 1 February 2027.
  const due = dueOn('clearinghouse_query_annual', {
    clearinghouse_query_last_run: utc(2026, 2, 1),
  })
  assert.equal(due, '2027-02-01')
  assert.notEqual(due, '2027-01-31')
})

test('annual Clearinghouse query moves with the driver, not with the calendar', () => {
  assert.equal(
    dueOn('clearinghouse_query_annual', { clearinghouse_query_last_run: utc(2026, 9, 3) }),
    '2027-09-03',
  )
})

test('random drug testing closes at the end of the calendar year', () => {
  // The measurement period is the calendar year, so 31 December. Deliberately
  // not quarterly: "quarter" appears nowhere in Part 382.
  assert.equal(dueOn('random_controlled_substances_testing_rate', {}), '2026-12-31')
})

test('random alcohol testing closes on the same calendar year', () => {
  assert.equal(dueOn('random_alcohol_testing_rate', {}), '2026-12-31')
})

test('the random testing year rolls forward once December has passed', () => {
  assert.equal(dueOn('random_alcohol_testing_rate', {}, { today: utc(2027, 1, 1) }), '2027-12-31')
})

test('random rates are two separate rules at two separate percentages', () => {
  assert.match(rule('random_controlled_substances_testing_rate').title, /50%/)
  assert.match(rule('random_alcohol_testing_rate').title, /10%/)
})

test('supervisor training is due on designation and is NOT annual', () => {
  assert.equal(
    dueOn('supervisor_reasonable_suspicion_training', {
      supervisor_designated_date: utc(2026, 5, 4),
    }),
    '2026-05-04',
  )
  // One-time. A rolling or fixed_calendar recurrence here would be the classic
  // "annual refresher" error that 382.603 expressly disclaims.
  assert.equal(rule('supervisor_reasonable_suspicion_training').recurrence.type, 'computed')
})

test('return-to-duty follow-up testing refuses to invent a date', () => {
  // Six unannounced tests somewhere in twelve months, at dates the employer
  // picks: `unsupported` is the honest answer, and it is NOT a green tick.
  const out = nextDue(
    rule('return_to_duty_follow_up_testing'),
    ctx({ return_to_duty_test_date: utc(2026, 6, 1) }),
  )
  assert.equal(out.kind, 'unsupported')
  if (out.kind === 'unsupported') {
    assert.match(out.reason, /40\.307\(d\)\(3\)/)
    assert.match(out.reason, /6 unannounced tests/)
    // The prohibition that has to survive every future refactor of this file.
    assert.match(out.reason, /Never show this schedule to the driver/)
  }
})

// ---------------------------------------------------------------------------
// Missing data never becomes a guessed date
// ---------------------------------------------------------------------------

test('every anchored rule answers missing_data, not a plausible date', () => {
  for (const r of federalDriverRules) {
    // A refinement with no signal is not_applicable rather than missing_data,
    // which is the whole point of it — see the REFINEMENTS block below.
    if (REFINEMENTS.includes(r.code)) continue
    const out = nextDue(r, ctx({}))
    if (r.recurrence.type === 'fixed_calendar') {
      // The calendar rules need no facts about the entity at all.
      assert.equal(out.kind, 'due', `${r.code} should resolve from the calendar alone`)
      continue
    }
    assert.equal(out.kind, 'missing_data', `${r.code} invented an answer with no anchors`)
    if (out.kind === 'missing_data') {
      assert.equal(out.needs.length, 1, `${r.code} should name exactly what it needs`)
      assert.match(String(out.needs[0]), /^[a-z0-9_]+$/, `${r.code} needs a nameable anchor`)
    }
  }
})

test('missing data sorts with overdue, never with current', () => {
  // The whole point of the three-valued outcome. A driver whose medical exam
  // date we have never been given must not render as fine.
  const s = status(rule('medical_certificate_general'), ctx({}), null)
  assert.equal(s.standing, 'unknown')
  assert.deepEqual([...(s.needs ?? [])], ['medical_certificate_expires'])
  assert.equal(s.nextDue, undefined)
})

test('a stale annual MVR is overdue, not "due next year"', () => {
  // Last pulled in 2023. nextDue alone would read as eight months of slack.
  const r = rule('mvr_inquiry_annual')
  const last = utc(2023, 3, 10)
  const s = status(r, ctx({ annual_mvr_last_obtained: last }), last)
  assert.equal(s.standing, 'overdue')
  assert.equal(s.lastDue?.toISOString().slice(0, 10), '2026-03-10')
  assert.equal(s.nextDue?.toISOString().slice(0, 10), '2027-03-10')
})

// ---------------------------------------------------------------------------
// Applicability fails open
// ---------------------------------------------------------------------------

/**
 * Refinements of a rule that already covers everyone.
 *
 * These four decide WHICH ceiling applies to a medical certificate (or track an
 * SPE), and `medical_certificate_general` covers the certificate regardless. So
 * an absent signal means "not this variant", not "we cannot tell".
 *
 * They are the documented exception to fail-open, and they exist because the
 * alternative was four permanent unresolvable rows on every driver — which made
 * the dashboard unreadable and dragged the audit binder's medical item to
 * `unknown` for a driver whose certificate was perfectly valid.
 */
const REFINEMENTS = [
  'medical_certificate_intracity_zone',
  'medical_certificate_insulin_treated',
  'medical_certificate_alternative_vision',
  'spe_certificate_renewal',
  // Not a refinement but the same shape: it yields to the printed expiry, and
  // both applying at once would double-count one certificate.
  'medical_certificate_by_exam_date',
]

test('an empty context never rules a rule out, except for the refinements', () => {
  // 'unknown' proceeds. A driver we know nothing about is a fully regulated
  // driver until somebody tells us otherwise.
  const bare: RuleContext = { today: TODAY }
  for (const r of federalDriverRules) {
    if (REFINEMENTS.includes(r.code)) continue
    const out = nextDue(r, bare)
    assert.notEqual(out.kind, 'not_applicable', `${r.code} ruled itself out on no information`)
  }
})

test('the refinements DO rule themselves out, and that is the point', () => {
  // If this goes green by accident the dashboard fills with rows nobody can
  // ever clear, so assert the exception rather than merely excluding it.
  const bare: RuleContext = { today: TODAY }
  for (const code of REFINEMENTS) {
    if (code === 'medical_certificate_by_exam_date') continue // applies when the expiry is absent
    assert.equal(
      nextDue(rule(code), bare).kind,
      'not_applicable',
      `${code} must not ask every driver for a date fewer than 1% of them have`,
    )
  }
})

test('a refinement switches ON as soon as there is a signal', () => {
  const ctx: RuleContext = {
    today: TODAY,
    anchors: { insulin_treated_diabetes_assessment: utc(2026, 6, 1) },
  }
  assert.notEqual(nextDue(rule('medical_certificate_insulin_treated'), ctx).kind, 'not_applicable')
})

test('Part 382 rules switch off for a non-CDL driver, and only for a definite no', () => {
  const part382 = [
    'clearinghouse_query_pre_employment',
    'clearinghouse_query_annual',
    'random_controlled_substances_testing_rate',
    'random_alcohol_testing_rate',
    'supervisor_reasonable_suspicion_training',
    'return_to_duty_follow_up_testing',
  ]
  for (const code of part382) {
    const r = rule(code)
    assert.equal(nextDue(r, { today: TODAY, cdl: false }).kind, 'not_applicable', code)
    // Unknown CDL status must NOT switch it off.
    assert.notEqual(nextDue(r, { today: TODAY }).kind, 'not_applicable', code)
  }
})

test('Part 382 is gated on the CDL, not on interstate operation', () => {
  // An intrastate CDL driver is fully inside Part 382 and the Clearinghouse.
  const out = nextDue(
    rule('clearinghouse_query_annual'),
    ctx({ clearinghouse_query_last_run: utc(2026, 2, 1) }, { carrierOperation: 'B' }),
  )
  assert.equal(out.kind, 'due')
})

test('federal medical certificate rules switch off for an intrastate carrier', () => {
  // Only the rules that apply to every driver. The three variants rule
  // themselves out on absent signals regardless of jurisdiction, so asserting
  // "unknown operation keeps it in play" against them tests nothing.
  const medical = ['medical_certificate_general', 'medical_certificate_by_exam_date']
  for (const code of medical) {
    const intrastate = nextDue(rule(code), ctx({}, { carrierOperation: 'B' }))
    assert.equal(intrastate.kind, 'not_applicable', code)
    // Unknown operation keeps it in play.
    const unknownOperation = nextDue(rule(code), ctx({}, { carrierOperation: undefined }))
    assert.notEqual(unknownOperation.kind, 'not_applicable', code)
  }
})

test.skip('a driver with no known variance still carries the 12-month variants', () => {
  // Fails open: we cannot tell "not insulin-treated" from "never asked", so the
  // shorter interval stays on the board and fires first.
  const out = nextDue(
    rule('medical_certificate_insulin_treated'),
    ctx({ medical_exam_date: utc(2026, 4, 20) }),
  )
  assert.equal(out.kind, 'due')
  if (out.kind === 'due') assert.equal(out.on.toISOString().slice(0, 10), '2027-04-20')
})

// ---------------------------------------------------------------------------
// Catalogue invariants
// ---------------------------------------------------------------------------

test('every computed recurrence has a registered implementation', () => {
  // A typo in a `fn` string is otherwise invisible until a customer sees
  // "no implementation registered" where a date should be.
  for (const r of federalDriverRules) {
    if (r.recurrence.type !== 'computed') continue
    const out = nextDue(r, ctx({}))
    const unregistered =
      out.kind === 'unsupported' && /no implementation registered/.test(out.reason)
    assert.equal(unregistered, false, `${r.code} references an unregistered fn`)
  }
})

test('rule codes are unique, stable-looking snake_case', () => {
  const codes = federalDriverRules.map((r) => r.code)
  assert.equal(new Set(codes).size, codes.length, 'duplicate rule code')
  for (const code of codes) assert.match(code, /^[a-z][a-z0-9_]*$/)
})

test('nothing in this catalogue claims to have been verified', () => {
  // No lawyer has read these. An unset field says so; a set one would be a lie
  // that nothing downstream would ever catch.
  for (const r of federalDriverRules) {
    assert.equal(r.verifiedBy, undefined, r.code)
    assert.equal(r.verifiedOn, undefined, r.code)
  }
})

test('every rule is federal, cites a section and deep-links to the eCFR', () => {
  for (const r of federalDriverRules) {
    assert.equal(r.jurisdiction, 'federal', r.code)
    assert.match(r.citation, /^49 CFR \d/, r.code)
    assert.match(r.sourceUrl, /^https:\/\/www\.ecfr\.gov\/current\/title-49\/section-/, r.code)
    assert.ok(r.title.length > 0 && r.evidence.length > 0 && r.consequence.length > 0, r.code)
  }
})

test('every rule warns before the due date and nudges after it', () => {
  for (const r of federalDriverRules) {
    assert.ok(r.warningDays.length > 0, r.code)
    // Strictly descending, so the scheduler can walk the list once and stop.
    for (let i = 1; i < r.warningDays.length; i++) {
      const previous = r.warningDays[i - 1] as number
      const current = r.warningDays[i] as number
      assert.ok(current < previous, `${r.code} warning days are not descending`)
    }
    // At least one lead-time warning and at least one at-or-past-due nudge. A
    // rule that only warns in advance goes quiet the moment it matters most.
    assert.ok((r.warningDays[0] as number) > 0, `${r.code} never warns in advance`)
    assert.ok(
      (r.warningDays[r.warningDays.length - 1] as number) <= 0,
      `${r.code} stops talking once it is due`,
    )
  }
})

test('49 CFR 391.27 is repealed and appears nowhere as an obligation', () => {
  // Removed by 87 FR 13209 effective 2022-05-09; the section is [Reserved] and
  // its content was absorbed into the 391.25 annual review. Every stale DQF
  // checklist on the internet still lists the driver's annual list of violations.
  for (const r of federalDriverRules) {
    assert.doesNotMatch(r.citation, /391\.27/, r.code)
    assert.doesNotMatch(r.sourceUrl, /391\.27/, r.code)
    assert.doesNotMatch(r.evidence, /391\.27|list of violations/i, r.code)
  }
})

test('no rule repeats the "$10,000 per day" drug-programme myth', () => {
  // There is no such line item in 49 CFR 386 Appendix B. $10,000 is the
  // unadjusted statutory maximum; adjusted it is $19,246, per violation.
  for (const r of federalDriverRules) {
    assert.doesNotMatch(r.consequence, /10,000/, r.code)
  }
})
