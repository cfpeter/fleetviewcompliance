/**
 * The date box that sits on the deadline row itself.
 *
 * WHAT THESE PIN. The row knows two things — a rule and a record — and a date
 * typed on it has to reach the one place `evaluate` will read it back from.
 * There are two ways that goes wrong and neither raises anything:
 *
 *   1. THE WRONG KEY. A date filed under an anchor the rule does not read is
 *      stored perfectly, shown back on every visit, and the row goes on saying
 *      "we need a date from you" forever. src/lib/rules/index.ts reads it with
 *      `answerKeyFor`, so this module has to write it with `answerKeyFor`.
 *   2. THE WRONG TABLE. A CDL expiry filed as a compliance record SILENTLY
 *      OUTRANKS `drivers.cdl_expires_on`: the driver's own page keeps showing
 *      the right date while five federal rules run off the wrong one. That is
 *      what `UNWRITABLE_ANCHOR_KEYS` is for, and the box is still offered —
 *      it just lands in the column instead.
 *
 * And one that is not an accident: a posted field name is trusted for a rule
 * code and a record id, and for nothing else. Every key, table and column is
 * decided on the server from this carrier's own rows.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type RowAnswer,
  readRowDates,
  rowAnswer,
  rowAnswers,
  rowField,
  rowMax,
  rowPrompt,
} from '../src/lib/dashboard-rows.ts'
import { UNWRITABLE_ANCHOR_KEYS } from '../src/lib/rules/anchors.ts'
import { answerKeyFor } from '../src/lib/rules/answer.ts'
import type { DeadlineItem } from '../src/lib/rules/index.ts'
import { allRules } from '../src/lib/rules/index.ts'
import type { RuleDefinition, Subject } from '../src/lib/rules/types.ts'

const TODAY = '2026-09-18'
const CARRIER = '11111111-1111-4111-8111-111111111111'
const DRIVER = '22222222-2222-4222-8222-222222222222'

const ruleOf = (code: string): RuleDefinition => {
  const rule = allRules.find((r) => r.code === code)
  assert.ok(rule, `${code} is in the catalogue`)
  return rule
}

const itemOf = (
  code: string,
  subjectId: string | null,
  extra: Partial<DeadlineItem> = {},
): DeadlineItem => {
  const rule = ruleOf(code)
  return {
    rule,
    subjectType: rule.subject,
    subjectId,
    subjectLabel: 'A record',
    status: { standing: 'overdue' },
    ...extra,
  } as DeadlineItem
}

// ---------------------------------------------------------------- the target

test('the anchor key comes from the rule, the same way evaluate reads it back', () => {
  for (const rule of allRules) {
    if (rule.subject !== 'driver') continue
    const answer = rowAnswer(itemOf(rule.code, DRIVER), CARRIER)
    if (!answer || answer.target.via !== 'anchor') continue
    assert.equal(
      answer.target.anchorKey,
      answerKeyFor(rule),
      `${rule.code} must be filed where the engine looks for it`,
    )
  }
})

test('an unknown row files under the key the ENGINE named, not the rule default', () => {
  // The two kinds of unknown want different keys and the difference is
  // invisible from outside — a `computed` rule that cannot compute wants the
  // anchor its function reads, not its own code. `status.answerKey` is the
  // engine saying which, so it wins.
  const rule = allRules.find((r) => r.subject === 'driver' && r.recurrence.type !== 'expiry')
  assert.ok(rule)
  const answer = rowAnswer(
    itemOf(rule.code, DRIVER, {
      status: { standing: 'unknown', answerKey: 'annual_mvr_last_obtained' },
    }),
    CARRIER,
  )
  assert.ok(answer)
  assert.equal(answer.target.via, 'anchor')
  assert.equal(
    answer.target.via === 'anchor' && answer.target.anchorKey,
    'annual_mvr_last_obtained',
  )
})

test('the CDL expiry goes to the driver column and never to a compliance record', () => {
  // The whole reason this module has two kinds of target.
  const cdl = allRules.find((r) => answerKeyFor(r) === 'cdl_expires')
  assert.ok(cdl, 'a rule is answered by the CDL expiry')
  const answer = rowAnswer(itemOf(cdl.code, DRIVER), CARRIER)
  assert.ok(answer, 'and it still gets a box')
  assert.deepEqual(answer.target, {
    via: 'column',
    table: 'drivers',
    column: 'cdl_expires_on',
    id: DRIVER,
  })
})

test('every unwritable key a rule uses has a column, or it has no box', () => {
  // The guard against a future rule quietly losing its box, or worse, gaining
  // one that writes a compliance record over a column.
  const unwritable = allRules.map(answerKeyFor).filter((k) => UNWRITABLE_ANCHOR_KEYS.has(k))
  assert.deepEqual(
    [...new Set(unwritable)],
    ['cdl_expires'],
    'a new unwritable answer key needs a COLUMN_TARGETS entry and a test here',
  )
})

test('a subject with no table behind it gets no box at all', () => {
  // `employee` and `terminal` rules exist and nothing can be recorded against
  // them. A box there would be a date typed, accepted and dropped.
  for (const rule of allRules) {
    if (rule.subject === 'carrier' || rule.subject === 'driver') continue
    if (rule.subject === 'power_unit' || rule.subject === 'trailer') continue
    assert.equal(
      rowAnswer(itemOf(rule.code, 'anything'), CARRIER),
      null,
      `${rule.subject} cannot hold a date yet`,
    )
  }
})

test('a carrier row uses the carrier id, and without one it gets no box', () => {
  const rule = allRules.find((r) => r.subject === 'carrier')
  assert.ok(rule)
  const withId = rowAnswer(itemOf(rule.code, null), CARRIER)
  assert.ok(withId)
  assert.equal(withId.target.via === 'anchor' && withId.target.subjectId, CARRIER)
  assert.equal(rowAnswer(itemOf(rule.code, null), null), null, 'no id, no box')
})

// ----------------------------------------------------------------- the field

test('the field name survives rule codes with dots and dashes in them', () => {
  const rule = allRules.find((r) => r.code.includes('.') && r.subject === 'power_unit')
  assert.ok(rule, 'the catalogue has a dotted code')
  const answer = rowAnswer(itemOf(rule.code, DRIVER), CARRIER)
  assert.ok(answer)
  assert.equal(answer.field, rowField(rule.code, DRIVER))
  // The page builds the same name from the same two facts to find the box
  // again. If these ever disagree, every row silently loses its input.
  assert.ok(answer.field.includes(rule.code))
  assert.ok(answer.field.endsWith(DRIVER))
})

test('two rules sharing one anchor get two boxes aimed at one slot', () => {
  // A periodic inspection settles two rules, and both rows are on screen, so
  // both need a box — one <input> cannot stand in two table rows. The field is
  // keyed on the RULE, so they are two distinct names; the target is keyed on
  // the anchor, so they are one slot.
  //
  // What happens when both are typed is `planAnchorWrites`' business and it is
  // already right: the same date twice is one write, two different dates is a
  // conflict and NEITHER is written — so the answer can never depend on which
  // row happened to be higher up the page.
  const byKey = new Map<string, string[]>()
  for (const r of allRules) {
    if (r.subject !== 'power_unit') continue
    const k = answerKeyFor(r)
    byKey.set(k, [...(byKey.get(k) ?? []), r.code])
  }
  const [key, codes] = [...byKey.entries()].find(([, c]) => c.length > 1) ?? []
  assert.ok(key && codes, 'the vehicle rules still share an anchor')

  const map = rowAnswers(
    codes.map((code) => itemOf(code, DRIVER)),
    CARRIER,
  )
  assert.equal(map.size, codes.length, 'one box per row on screen')
  for (const answer of map.values()) {
    assert.equal(answer.target.via === 'anchor' && answer.target.anchorKey, key)
  }
})

// ------------------------------------------------------------------ the read

const answerFor = (code: string, id: string) => {
  const a = rowAnswer(itemOf(code, id), CARRIER)
  assert.ok(a)
  return a
}

const mapOf = (...answers: RowAnswer[]) => new Map(answers.map((a) => [a.field, a]))

test('a field nobody put on the page is never looked at', () => {
  // Not rejected — never read. The only version of that defence with no list to
  // keep up to date. A posted `hire_date` is the attack: a record under that
  // key outranks the driver's own column forever.
  const rule = allRules.find((r) => r.subject === 'driver')
  assert.ok(rule)
  const answers = mapOf(answerFor(rule.code, DRIVER))
  const read = readRowDates(
    answers,
    (field) => (field === rowField('hire_date', DRIVER) ? '2020-01-01' : ''),
    TODAY,
  )
  assert.ok(read.ok)
  assert.equal(read.typed.length, 0)
})

test('a blank box changes nothing and a bad one refuses the whole submit', () => {
  const rule = allRules.find((r) => r.subject === 'power_unit' && answerKeyFor(r) !== 'cdl_expires')
  assert.ok(rule)
  const a = answerFor(rule.code, DRIVER)
  const answers = mapOf(a)

  const blank = readRowDates(answers, () => '  ', TODAY)
  assert.ok(blank.ok)
  assert.equal(blank.typed.length, 0, 'blank is "not this one", never "clear it"')

  const junk = readRowDates(answers, () => 'banana', TODAY)
  assert.equal(junk.ok, false)

  const ancient = readRowDates(answers, () => '1899-12-31', TODAY)
  assert.equal(ancient.ok, false)

  const good = readRowDates(answers, () => '2026-01-04', TODAY)
  assert.ok(good.ok)
  assert.deepEqual(
    good.typed.map((t) => t.on),
    ['2026-01-04'],
  )
})

test('the future is refused for a date that already happened, and allowed for an expiry', () => {
  // The `max` attribute is a browser's promise. This is the server's.
  const lastDone = allRules.find((r) => r.recurrence.type !== 'expiry' && r.subject === 'driver')
  const expiry = allRules.find((r) => r.recurrence.type === 'expiry' && r.subject === 'driver')
  assert.ok(lastDone && expiry)

  const past = answerFor(lastDone.code, DRIVER)
  assert.equal(past.kind, 'last_done')
  assert.equal(rowMax(past, TODAY), TODAY)
  assert.equal(rowPrompt(past), 'Date it was done')
  assert.equal(readRowDates(mapOf(past), () => '2027-01-01', TODAY).ok, false)

  const ahead = answerFor(expiry.code, DRIVER)
  assert.equal(ahead.kind, 'expires')
  assert.equal(rowMax(ahead, TODAY), undefined, 'a new card expires in the future, always')
  assert.equal(rowPrompt(ahead), 'New expiry date')
  assert.ok(readRowDates(mapOf(ahead), () => '2028-06-30', TODAY).ok)
})
