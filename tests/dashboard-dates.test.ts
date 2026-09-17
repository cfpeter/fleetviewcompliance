/**
 * The dashboard's date editor, and the ways it could quietly lie or do damage.
 *
 * This surface is the only place in the product where most of these dates can be
 * entered at all — nineteen of the twenty-nine rows it was built for had no
 * input anywhere in the app — so a question it drops is an obligation that
 * becomes permanently unanswerable, and a question it renders wrongly writes a
 * record that outranks a correct one.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildDateEditor,
  findSubject,
  maxFor,
  readTypedDates,
  rowsSettledBy,
  savedHeadline,
  type UnknownRow,
} from '../src/lib/dashboard-dates.ts'

const TODAY = '2026-09-15'

const row = (
  answerKey: string,
  over: Partial<UnknownRow> & { code?: string; title?: string } = {},
): UnknownRow => ({
  rule: {
    code: over.code ?? `rule_${answerKey}`,
    title: over.title ?? `Rule about ${answerKey}`,
    citation: '49 CFR 1.1',
    sourceUrl: 'https://example.invalid',
  },
  subjectType: over.subjectType ?? 'driver',
  subjectId: over.subjectId ?? 'driver-1',
  subjectLabel: over.subjectLabel ?? 'Mike Ruiz',
  status: { answerKey },
})

const questionFor = (editor: ReturnType<typeof buildDateEditor>, key: string) =>
  editor.subjects.flatMap((s) => s.questions).find((q) => q.answerKey === key)

// ----------------------------------------------------------------- dedupe

test('two rules needing the same date ask for it once', () => {
  // `periodic_inspection_date` settles both the annual DOT inspection and the
  // duty to keep the report. Two inputs is two chances to type two different
  // dates for one event in a single submit — and the planner would then refuse
  // the whole save, so the owner would be blocked by a screen we built.
  const editor = buildDateEditor([
    row('periodic_inspection_date', {
      subjectType: 'power_unit',
      subjectId: 'truck-1',
      subjectLabel: 'Unit 11',
      code: 'inspection',
      title: 'Annual DOT inspection',
    }),
    row('periodic_inspection_date', {
      subjectType: 'power_unit',
      subjectId: 'truck-1',
      subjectLabel: 'Unit 11',
      code: 'report',
      title: 'Keep the annual inspection report',
    }),
  ])

  const q = questionFor(editor, 'periodic_inspection_date')
  assert.ok(q)
  assert.equal(editor.questionCount, 1)
  // Both rows stay visible under the one box. A row he saw on the dashboard and
  // cannot find here is a list he stops believing.
  assert.equal(q.settles.length, 2)
  assert.equal(editor.rowCount, 2)
})

test('the same date on two trucks stays two questions', () => {
  // A tractor and its trailer each have their own inspection, and the anchor
  // catalogue says so in as many words. Merged on the key alone, one date would
  // be filed against both units.
  const editor = buildDateEditor([
    row('periodic_inspection_date', {
      subjectType: 'power_unit',
      subjectId: 'truck-1',
      subjectLabel: 'Unit 11',
    }),
    row('periodic_inspection_date', {
      subjectType: 'trailer',
      subjectId: 'trailer-9',
      subjectLabel: 'Trailer 9',
    }),
  ])
  assert.equal(editor.subjectCount, 2)
  assert.equal(editor.questionCount, 2)
})

// ------------------------------------------------------------ the deny-list

test('a column-backed date is never given an input', () => {
  // THE WORST BUG THIS FEATURE COULD SHIP. deadlines.ts projects
  // `drivers.hired_on` into ctx.anchors with `if (a[anchorKey]) continue`, so a
  // compliance record SILENTLY OUTRANKS the column. A typo typed here would
  // override a correct hire date forever, move five federal rules onto wrong
  // dates, and leave the driver's own page still showing the right one.
  const editor = buildDateEditor([row('hire_date'), row('cdl_expires'), row('dot_number')])

  for (const key of ['hire_date', 'cdl_expires', 'dot_number']) {
    const q = questionFor(editor, key)
    assert.ok(q, `${key} must still be shown, just not as a box`)
    assert.equal(q.writable, false, `${key} must not be writable`)
    assert.ok(q.elsewhere, `${key} must say where the real answer lives`)
  }
})

test('an unwritable question is never read back from the form, even if posted', () => {
  // The defence with no list to keep up to date: the handler loops over derived
  // questions, so a hand-posted `date_hire_date` is not rejected — it is never
  // looked at.
  const editor = buildDateEditor([row('hire_date'), row('clearinghouse_query_last_run')])
  const subject = editor.subjects[0]
  const result = readTypedDates(subject, () => '2020-01-01', TODAY)
  assert.equal(result.ok, true)
  assert.ok(result.ok)
  assert.deepEqual(
    result.typed.map((t) => t.question.answerKey),
    ['clearinghouse_query_last_run'],
  )
})

// ------------------------------------------------------------- direction

test('a completion cannot be dated in the future, on the server', () => {
  // compute.ts walks a rolling schedule forward from the anchor until it passes
  // today, so a future date makes it step past the occurrence he just reported
  // and answer with the NEXT one. The deadline moves later — the single
  // direction this domain refuses to be wrong in — and `max` on the input is a
  // browser's promise, not a server's.
  const editor = buildDateEditor([row('clearinghouse_query_last_run')])
  const subject = editor.subjects[0]
  const result = readTypedDates(subject, () => '2027-01-01', TODAY)
  assert.equal(result.ok, false)
  assert.ok(!result.ok && /future/i.test(result.message))
})

test('an expiry already in the past is accepted, because that is the urgent case', () => {
  // A medical card that expired last month is a real and urgent fact, and
  // compute.ts exists to turn it into `overdue`. Refusing it would make the most
  // enforcement-visible document in the industry un-typeable at the one moment
  // it matters most.
  const editor = buildDateEditor([row('medical_certificate_expires')])
  const subject = editor.subjects[0]
  const q = subject.questions[0]
  assert.equal(q.kind, 'expires')
  assert.equal(maxFor(q, TODAY), undefined, 'an expiry takes no upper bound')
  const result = readTypedDates(subject, () => '2026-08-01', TODAY)
  assert.equal(result.ok, true)
})

test('a blank is skipped and an impossible date is refused outright', () => {
  const editor = buildDateEditor([row('clearinghouse_query_last_run')])
  const subject = editor.subjects[0]
  assert.deepEqual(
    readTypedDates(subject, () => '', TODAY),
    { ok: true, typed: [] },
  )
  assert.equal(readTypedDates(subject, () => '2026-02-31', TODAY).ok, false)
})

// --------------------------------------------------------------- ordering

test('subjects appear in the order the ranked list already put them in', () => {
  // src/lib/dashboard.ts forbids a filter from re-ranking anything. The editor
  // is a view of the same array, so it may regroup but never reorder.
  const editor = buildDateEditor([
    row('clearinghouse_query_last_run', { subjectId: 'driver-2', subjectLabel: 'Zoe' }),
    row('annual_mvr_last_obtained', { subjectId: 'driver-1', subjectLabel: 'Adam' }),
  ])
  assert.deepEqual(
    editor.subjects.map((s) => s.label),
    ['Zoe', 'Adam'],
    'alphabetical here would be a re-rank',
  )
})

// --------------------------------------------------------------- lookups

test('an unknown or absent ?s= resolves to nothing rather than to someone', () => {
  // "No such subject" and "not your subject" must be the same answer — the
  // difference is exactly what an id-guesser is looking for.
  const editor = buildDateEditor([row('clearinghouse_query_last_run')])
  assert.equal(findSubject(editor, 'driver-999'), null)
  assert.equal(findSubject(editor, ''), null)
  assert.equal(findSubject(editor, null), null)
  assert.ok(findSubject(editor, 'driver-1'))
})

// ----------------------------------------------------------------- counts

test('the headline reports dates typed AND rows cleared, because they differ', () => {
  // One date settles two rules, so four dates can clear six rows. A tile that
  // moves by six when he typed four makes the number he checks first look broken.
  const editor = buildDateEditor([
    row('periodic_inspection_date', {
      subjectType: 'power_unit',
      subjectId: 'truck-1',
      code: 'a',
      title: 'A',
    }),
    row('periodic_inspection_date', {
      subjectType: 'power_unit',
      subjectId: 'truck-1',
      code: 'b',
      title: 'B',
    }),
  ])
  assert.equal(rowsSettledBy(editor.subjects[0], ['periodic_inspection_date']), 2)
  // Two short sentences rather than one joined by an em dash. Both numbers are
  // still reported — that is the invariant — but the readers of this screen are
  // mostly not fluent in English, and a dash mid-sentence is a join they have to
  // work out before they can read either half.
  assert.equal(savedHeadline(1, 2), '1 date saved. 2 items off this list.')
  assert.equal(savedHeadline(1, 1), '1 date saved. 1 item off this list.')
  assert.equal(savedHeadline(0, 0), 'Nothing saved. Every box was left blank.')
})

test('a subject with no table to file against is counted, never silently dropped', () => {
  // `employee` rules are real and in the catalogue. Coercing one to 'carrier'
  // would file one person's harassment training against the whole company and
  // mark the obligation satisfied for everybody.
  const editor = buildDateEditor([
    row('harassment_training_completed', { subjectType: 'employee', subjectId: 'e1' }),
    row('clearinghouse_query_last_run'),
  ])
  assert.equal(editor.unrecordable, 1)
  assert.equal(editor.subjectCount, 1)
})
