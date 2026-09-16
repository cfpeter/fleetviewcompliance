/**
 * The engine, independent of any particular rule.
 *
 * These tests are about the SHAPE of an answer, not about trucking: that we
 * never invent a date, that "we don't know" survives all the way to the caller,
 * and that month arithmetic clamps in the safe direction.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextDue, registerComputed, status } from '../src/lib/rules/compute.ts'
import { addMonthsClamped, utcDate } from '../src/lib/rules/dates.ts'
import type { RuleDefinition } from '../src/lib/rules/types.ts'

const base = {
  title: 'Test rule',
  jurisdiction: 'federal',
  subject: 'carrier',
  citation: '49 CFR 000.0',
  sourceUrl: 'https://example.invalid',
  warningDays: [30, 7],
  evidence: 'a document',
  consequence: 'a penalty',
} satisfies Omit<RuleDefinition, 'code' | 'recurrence'>

const iso = (d: Date) => d.toISOString().slice(0, 10)

// ---------------------------------------------------------------- dates

test('adding a month clamps backward, never forward', () => {
  // 31 Jan + 1 month must be 28 Feb. A library that rolls to 3 March moves a
  // deadline LATER, which is the one direction this domain refuses.
  assert.equal(iso(addMonthsClamped(utcDate(2026, 1, 31), 1)), '2026-02-28')
  assert.equal(iso(addMonthsClamped(utcDate(2024, 1, 31), 1)), '2024-02-29') // leap year
  assert.equal(iso(addMonthsClamped(utcDate(2026, 8, 31), 1)), '2026-09-30')
})

test('going backward clamps too', () => {
  assert.equal(iso(addMonthsClamped(utcDate(2026, 3, 31), -1)), '2026-02-28')
})

// ---------------------------------------------------------------- fixed calendar

test('fixed calendar finds the next occurrence, and rolls into next year', () => {
  const rule: RuleDefinition = {
    ...base,
    code: 'quarterly',
    recurrence: { type: 'fixed_calendar', months: [4, 7, 10, 1], day: 'last' },
  }
  const may = nextDue(rule, { today: utcDate(2026, 5, 15) })
  assert.equal(may.kind, 'due')
  assert.equal(iso((may as { on: Date }).on), '2026-07-31')

  // After the last quarter of the year, the answer is next January.
  const dec = nextDue(rule, { today: utcDate(2026, 12, 1) })
  assert.equal(iso((dec as { on: Date }).on), '2027-01-31')
})

test('a due date falling exactly today is still due today, not next cycle', () => {
  const rule: RuleDefinition = {
    ...base,
    code: 'q',
    recurrence: { type: 'fixed_calendar', months: [7], day: 'last' },
  }
  const r = nextDue(rule, { today: utcDate(2026, 7, 31) })
  assert.equal(iso((r as { on: Date }).on), '2026-07-31')
})

// ---------------------------------------------------------------- rolling

test('a rolling interval measures from the last completion, not the calendar', () => {
  const rule: RuleDefinition = {
    ...base,
    code: 'annual_mvr',
    recurrence: { type: 'rolling', intervalMonths: 12, anchor: 'last_mvr' },
  }
  // Done in March, so due the following March — NOT 1 January.
  const r = nextDue(rule, {
    today: utcDate(2026, 6, 1),
    anchors: { last_mvr: utcDate(2026, 3, 10) },
  })
  assert.equal(iso((r as { on: Date }).on), '2027-03-10')
})

test('a long-overdue anchor still yields a FUTURE next date', () => {
  const rule: RuleDefinition = {
    ...base,
    code: 'annual_mvr',
    recurrence: { type: 'rolling', intervalMonths: 12, anchor: 'last_mvr' },
  }
  const r = nextDue(rule, {
    today: utcDate(2026, 6, 1),
    anchors: { last_mvr: utcDate(2020, 3, 10) },
  })
  assert.equal(iso((r as { on: Date }).on), '2027-03-10')
})

// ---------------------------------------------------------------- honesty

test('a missing anchor yields missing_data, never a guessed date', () => {
  const rule: RuleDefinition = {
    ...base,
    code: 'needs_anchor',
    recurrence: { type: 'rolling', intervalMonths: 12, anchor: 'last_inspection' },
  }
  const r = nextDue(rule, { today: utcDate(2026, 6, 1) })
  assert.equal(r.kind, 'missing_data')
  assert.deepEqual([...(r as { needs: readonly string[] }).needs], ['last_inspection'])
})

test('an unregistered computed function is unsupported, not a crash and not a date', () => {
  const rule: RuleDefinition = {
    ...base,
    code: 'mystery',
    recurrence: { type: 'computed', fn: 'not_registered' },
  }
  assert.equal(nextDue(rule, { today: utcDate(2026, 6, 1) }).kind, 'unsupported')
})

test('a registered computed function is used', () => {
  registerComputed('always_july', () => ({ kind: 'due', on: utcDate(2026, 7, 4) }))
  const rule: RuleDefinition = {
    ...base,
    code: 'c',
    recurrence: { type: 'computed', fn: 'always_july' },
  }
  const r = nextDue(rule, { today: utcDate(2026, 1, 1) })
  assert.equal(iso((r as { on: Date }).on), '2026-07-04')
})

// ---------------------------------------------------------------- applicability

test('applies:false makes a rule not_applicable', () => {
  const rule: RuleDefinition = {
    ...base,
    code: 'hazmat_only',
    recurrence: { type: 'fixed_calendar', months: [6], day: 1 },
    applies: (ctx) => ctx.hazmat === true,
  }
  assert.equal(nextDue(rule, { today: utcDate(2026, 1, 1), hazmat: false }).kind, 'not_applicable')
})

test("applies:'unknown' FAILS OPEN and still produces a date", () => {
  // A truck of unknown weight is treated as regulated. One unnecessary reminder
  // costs a moment; one missed inspection costs the truck.
  const rule: RuleDefinition = {
    ...base,
    code: 'heavy_only',
    recurrence: { type: 'fixed_calendar', months: [6], day: 1 },
    applies: (ctx) => (ctx.gvwrLbs === undefined ? 'unknown' : ctx.gvwrLbs >= 26001),
  }
  assert.equal(nextDue(rule, { today: utcDate(2026, 1, 1) }).kind, 'due')
})

// ---------------------------------------------------------------- standing

test('standing distinguishes current from overdue from unknown', () => {
  const rule: RuleDefinition = {
    ...base,
    code: 'biennial',
    recurrence: { type: 'rolling', intervalMonths: 24, anchor: 'last_filed' },
  }
  const ctx = { today: utcDate(2026, 9, 14), anchors: { last_filed: utcDate(2025, 5, 1) } }

  const current = status(rule, ctx, utcDate(2025, 5, 1))
  assert.equal(current.standing, 'current')

  const stale = status(
    rule,
    { today: utcDate(2026, 9, 14), anchors: { last_filed: utcDate(2020, 5, 1) } },
    utcDate(2020, 5, 1),
  )
  assert.equal(stale.standing, 'overdue', 'a filing three cycles old is overdue, not "due later"')

  const never = status(rule, ctx, null)
  assert.equal(never.standing, 'unknown', 'no completion date is unknown, never current')
})

test('a rule we cannot evaluate never reports as current', () => {
  const rule: RuleDefinition = {
    ...base,
    code: 'nope',
    recurrence: { type: 'computed', fn: 'missing' },
  }
  const s = status(rule, { today: utcDate(2026, 1, 1) }, utcDate(2026, 1, 1))
  assert.notEqual(s.standing, 'current')
  assert.equal(s.standing, 'unsupported')
})

// ---------------------------------------------------------------- expiry

test('expiry treats the anchor AS the due date, not as a starting point', () => {
  // The bug this type exists to prevent. Asked "when does your IRP expire?" an
  // owner gives a FUTURE date; an interval rule stepped straight past it and
  // answered a year later, hiding the imminent deadline completely.
  const rule: RuleDefinition = {
    ...base,
    code: 'irp',
    recurrence: { type: 'expiry', anchor: 'irp_expires', intervalMonths: 12 },
  }
  const r = nextDue(rule, {
    today: utcDate(2026, 9, 15),
    anchors: { irp_expires: utcDate(2026, 11, 30) },
  })
  assert.equal(iso((r as { on: Date }).on), '2026-11-30')
})

test('expiry rolls forward once the date has passed', () => {
  const rule: RuleDefinition = {
    ...base,
    code: 'irp',
    recurrence: { type: 'expiry', anchor: 'irp_expires', intervalMonths: 12 },
  }
  const r = nextDue(rule, {
    today: utcDate(2026, 9, 15),
    anchors: { irp_expires: utcDate(2026, 3, 31) },
  })
  assert.equal(iso((r as { on: Date }).on), '2027-03-31')
})

test('an expiry with no interval is used exactly as given', () => {
  // A medical certificate carries whatever date the examiner printed on it —
  // 3 months, 1 year, 2 years. There is no cycle to step; the next one is read
  // off the next certificate.
  const rule: RuleDefinition = {
    ...base,
    code: 'med_cert',
    subject: 'driver',
    recurrence: { type: 'expiry', anchor: 'medical_certificate_expires' },
  }
  const r = nextDue(rule, {
    today: utcDate(2026, 9, 15),
    anchors: { medical_certificate_expires: utcDate(2026, 11, 2) },
  })
  assert.equal(iso((r as { on: Date }).on), '2026-11-02')

  // And an expired one stays in the past rather than being rolled forward into
  // a reassuring future date.
  const past = nextDue(rule, {
    today: utcDate(2026, 9, 15),
    anchors: { medical_certificate_expires: utcDate(2025, 4, 1) },
  })
  assert.equal(iso((past as { on: Date }).on), '2025-04-01')
})

test('a short-dated medical certificate is not treated as a 24-month one', () => {
  // An examiner may certify for any period up to 24 months, and 3 months is
  // routine. A fixed intervalMonths on the rule row would make the engine up to
  // 21 months too generous on the most enforcement-visible document there is.
  const rule: RuleDefinition = {
    ...base,
    code: 'med_cert',
    subject: 'driver',
    recurrence: { type: 'expiry', anchor: 'medical_certificate_expires' },
  }
  const issued = utcDate(2026, 8, 1)
  const threeMonth = nextDue(rule, {
    today: utcDate(2026, 9, 15),
    anchors: { medical_certificate_expires: addMonthsClamped(issued, 3) },
  })
  assert.equal(iso((threeMonth as { on: Date }).on), '2026-11-01')
})

// ---------------------------------------------------------------- day intervals

test('90 days means 90 days, not three months', () => {
  // California's terminal inspection cycle is 90 days. Three months from
  // 1 January is 92 days — two days LATE, and late is the direction this
  // codebase refuses.
  const days: RuleDefinition = {
    ...base,
    code: 'bit',
    recurrence: { type: 'rolling', anchor: 'last_inspection', intervalDays: 90 },
  }
  const months: RuleDefinition = {
    ...base,
    code: 'bit_months',
    recurrence: { type: 'rolling', anchor: 'last_inspection', intervalMonths: 3 },
  }
  const ctx = { today: utcDate(2026, 1, 2), anchors: { last_inspection: utcDate(2026, 1, 1) } }

  assert.equal(iso((nextDue(days, ctx) as { on: Date }).on), '2026-04-01')
  assert.equal(iso((nextDue(months, ctx) as { on: Date }).on), '2026-04-01')

  // The two diverge where it matters — starting in a long-month run.
  const ctx2 = { today: utcDate(2026, 5, 2), anchors: { last_inspection: utcDate(2026, 5, 1) } }
  assert.equal(iso((nextDue(days, ctx2) as { on: Date }).on), '2026-07-30')
  assert.equal(
    iso((nextDue(months, ctx2) as { on: Date }).on),
    '2026-08-01',
    'three months is two days later than ninety days here',
  )
})

test('standing works for day intervals too', () => {
  const rule: RuleDefinition = {
    ...base,
    code: 'bit',
    recurrence: { type: 'rolling', anchor: 'last_inspection', intervalDays: 90 },
  }
  const ctx = { today: utcDate(2026, 9, 15), anchors: { last_inspection: utcDate(2026, 1, 1) } }
  assert.equal(status(rule, ctx, utcDate(2026, 1, 1)).standing, 'overdue')
})
