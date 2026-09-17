/**
 * The ordering of the dashboard, which is the product in one function.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextDue } from '../src/lib/rules/compute.ts'
import { utcDate } from '../src/lib/rules/dates.ts'
import { allRules, compareDeadlines, type DeadlineItem, evaluate } from '../src/lib/rules/index.ts'

const TODAY = utcDate(2026, 9, 15)

test('the catalogue is internally consistent', () => {
  const codes = new Set<string>()
  for (const r of allRules) {
    assert.ok(!codes.has(r.code), `duplicate rule code: ${r.code}`)
    codes.add(r.code)
    assert.ok(r.citation.length > 0, `${r.code} has no citation`)
    assert.ok(r.sourceUrl.startsWith('http'), `${r.code} has no source URL`)
    assert.ok(r.consequence.length > 0, `${r.code} does not say what happens if missed`)

    // A rule with no warning windows can never alert, which is correct ONLY for
    // obligations that are continuous rather than dated — a DVIR is owed every
    // trip, so there is no "30 days before" to warn at. The invariant is that
    // such a rule must also refuse to produce a date, rather than quietly
    // producing one nobody will ever be warned about.
    if (r.warningDays.length === 0) {
      const out = nextDue(r, { today: TODAY, anchors: {} })
      assert.notEqual(
        out.kind,
        'due',
        `${r.code} produces a date but has no warning windows, so nobody is ever told`,
      )
    }
  }
  assert.ok(allRules.length >= 40, 'catalogue looks unexpectedly small')
})

test('no rule claims to have been verified by a person', () => {
  // Nobody qualified has reviewed these yet. The day that changes, this test
  // should be updated deliberately — not discovered to have been silently true.
  assert.equal(allRules.filter((r) => r.verifiedBy).length, 0)
})

const item = (standing: string, days: number | undefined, label = 'x'): DeadlineItem =>
  ({
    rule: { code: 'r', title: 't' },
    subjectType: 'driver',
    subjectId: null,
    subjectLabel: label,
    status: { standing },
    daysUntil: days,
  }) as unknown as DeadlineItem

test('unknown sorts WITH overdue, above current — never at the bottom', () => {
  // The single most important line of ordering in the product. A driver whose
  // medical card date we have never been given is not "fine"; his exposure is
  // identical to the card having expired. Sorting unknown below current would
  // bury exactly the rows the owner needs, and would reward never typing.
  const sorted = [item('current', 5), item('unknown', undefined), item('overdue', -3)].sort(
    compareDeadlines,
  )
  assert.deepEqual(
    sorted.map((i) => i.status.standing),
    ['overdue', 'unknown', 'current'],
  )
})

test('within a standing, soonest first', () => {
  const sorted = [item('current', 90), item('current', 3), item('current', 30)].sort(
    compareDeadlines,
  )
  assert.deepEqual(
    sorted.map((i) => i.daysUntil),
    [3, 30, 90],
  )
})

test('an undated row sorts last among its peers, not first', () => {
  const sorted = [item('unknown', undefined), item('unknown', 10)].sort(compareDeadlines)
  assert.deepEqual(
    sorted.map((i) => i.daysUntil),
    [10, undefined],
  )
})

test('a driver with no dates at all produces rows, and none of them say "current"', () => {
  // The failure this guards: an empty database rendering as a clean bill of
  // health. A carrier who has typed nothing must not be told he is compliant.
  const items = evaluate(
    [{ type: 'driver', id: 'd1', label: 'A Driver', context: {}, anchors: {} }],
    TODAY,
  )
  assert.ok(items.length > 0, 'driver rules should produce rows')
  assert.equal(
    items.filter((i) => i.status.standing === 'current').length,
    0,
    'nothing is "current" when nothing is known',
  )
})

test('not_applicable rows are dropped, not rendered greyed out', () => {
  const items = evaluate(
    [{ type: 'driver', id: 'd1', label: 'A Driver', context: {}, anchors: {} }],
    TODAY,
  )
  assert.equal(items.filter((i) => i.status.standing === 'not_applicable').length, 0)
})

test('a real anchor produces a real, dated row', () => {
  const items = evaluate(
    [
      {
        type: 'driver',
        id: 'd1',
        label: 'A Driver',
        context: {},
        anchors: { medical_certificate_expires: utcDate(2027, 3, 1) },
      },
    ],
    TODAY,
  )
  const med = items.find((i) => i.rule.code === 'medical_certificate_general')
  assert.ok(med, 'the medical certificate rule should be present')
  assert.equal(med.status.standing, 'current')
  assert.equal(med.status.nextDue?.toISOString().slice(0, 10), '2027-03-01')
})

test('an expired card is overdue, with a negative day count', () => {
  const items = evaluate(
    [
      {
        type: 'driver',
        id: 'd1',
        label: 'A Driver',
        context: {},
        anchors: { medical_certificate_expires: utcDate(2026, 4, 1) },
      },
    ],
    TODAY,
  )
  const med = items.find((i) => i.rule.code === 'medical_certificate_general')
  assert.ok(med)
  assert.ok((med.daysUntil ?? 0) < 0, 'an expired card must report negative days')
})

test('a hire date on the driver row gives the hire-time rules a real deadline', () => {
  // The projection bug this guards: `hire_date` is read by five federal rules,
  // but the fact lives in drivers.hired_on, not in compliance_records. Without
  // projecting it they cannot produce a date at all — while the hire date sits
  // on the driver's own page looking perfectly well answered.
  //
  // Note what does NOT change: the standing stays `unknown` either way, and
  // that is right. Knowing when the MVR was DUE is not knowing whether it was
  // DONE. What changes is that we stop asking for a date we already have, and
  // start showing the deadline it implies.
  const HIRE_RULES = [
    'dqf_maintained',
    'mvr_inquiry_at_hire',
    'safety_performance_history_investigation',
    'road_test_or_equivalent',
    'clearinghouse_query_pre_employment',
  ]
  const run = (anchors: Record<string, Date>) =>
    evaluate([{ type: 'driver', id: 'd1', label: 'D', context: {}, anchors }], TODAY).filter((i) =>
      HIRE_RULES.includes(i.rule.code),
    )

  const without = run({})
  assert.equal(without.length, HIRE_RULES.length, 'all five should appear')
  for (const i of without) {
    assert.equal(
      i.status.nextDue,
      undefined,
      `${i.rule.code} should have no date without a hire date`,
    )
    assert.deepEqual([...(i.status.needs ?? [])], ['hire_date'])
  }

  const withHire = run({ hire_date: utcDate(2026, 8, 1) })
  for (const i of withHire) {
    assert.ok(
      i.status.nextDue,
      `${i.rule.code} should produce a deadline once we know the hire date`,
    )
    assert.ok(
      !(i.status.needs ?? []).includes('hire_date'),
      `${i.rule.code} must stop asking for a date it already has`,
    )
  }
  // The 30-day rules land exactly 30 days after hire, not one calendar month.
  const mvr = withHire.find((i) => i.rule.code === 'mvr_inquiry_at_hire')
  assert.equal(mvr?.status.nextDue?.toISOString().slice(0, 10), '2026-08-31')
})

test('a satisfied one-time obligation reports no next date at all', () => {
  /**
   * WHERE A FINISHED ONE-TIME OBLIGATION BELONGS, decided once, here, because
   * deciding it in each consumer is what produced four copies of one bug.
   *
   * A one-time obligation anchored to employment — the road test, the hire-time
   * MVR, the pre-employment Clearinghouse query — was due on a day that is in
   * the past for everybody who already works here, and can never have a future
   * occurrence. `status` used to return that past day as `nextDue`, which is a
   * field whose own comment promises the next occurrence IN THE FUTURE.
   *
   * `evaluate` turned it into `daysUntil` ≈ -2040, and the past passes every
   * window anybody compares it to. That one invented date put twenty finished
   * items in the amber "Due in 45 days" arc, printed "Expires soon" forever on
   * a clean qualification binder, drew completed paperwork as OVERDUE on the
   * runway, and queued a text message about a road test passed five years ago.
   *
   * The standing stays `current` — it is done, and green is the bucket with
   * nothing in it for the owner to do. What goes is the date, because there
   * isn't one. A consumer that skips undated rows, or defaults a missing
   * `daysUntil` to +Infinity, is now correct without knowing this case exists.
   */
  const run = (lastDone: Record<string, Date> | undefined) =>
    evaluate(
      [
        {
          type: 'driver',
          id: 'd1',
          label: 'Miguel Arellano',
          context: { carrierOperation: 'A', cdl: true },
          anchors: { hire_date: utcDate(2021, 2, 15) },
          lastDone,
        },
      ],
      TODAY,
    )

  const ONE_TIME = [
    'road_test_or_equivalent',
    'clearinghouse_query_pre_employment',
    'mvr_inquiry_at_hire',
    'dqf_maintained',
  ]
  const done = Object.fromEntries(ONE_TIME.map((c) => [c, utcDate(2021, 2, 15)]))

  for (const code of ONE_TIME) {
    const i = run(done).find((x) => x.rule.code === code)
    assert.ok(i, `${code} must still appear — it is evidence the file is complete`)
    assert.equal(i.status.standing, 'current', `${code} is done`)
    assert.equal(i.status.nextDue, undefined, `${code} invented a due date in the past`)
    assert.equal(i.daysUntil, undefined, `${code} produced a countdown that runs backwards`)
  }

  // NOT a blanket rule about one-time obligations: it is about SATISFIED ones.
  // With no completion on file the same rule is a real gap, keeps the deadline
  // it was owed by, and goes on saying so. If this ever starts returning
  // `current` the fix above has swallowed the question instead of answering it.
  for (const code of ONE_TIME) {
    const i = run(undefined).find((x) => x.rule.code === code)
    assert.ok(i)
    assert.equal(i.status.standing, 'unknown', `${code} must still be a gap when never done`)
    assert.ok(i.status.nextDue, `${code} must keep the deadline it was owed by`)
  }
})

test('a recurring rule still gets a real future date, however long it has been running', () => {
  // The guard on the fix above is `lastDue === undefined`, which is the shape
  // only a one-time schedule has. An interval rule always derives a previous
  // occurrence, so it must be untouched — dropping ITS date would delete the
  // renewal that is actually coming up.
  const items = evaluate(
    [
      {
        type: 'driver',
        id: 'd1',
        label: 'A Driver',
        context: { carrierOperation: 'A', cdl: true },
        anchors: { hire_date: utcDate(2021, 2, 15), annual_mvr_last_obtained: utcDate(2026, 6, 1) },
        lastDone: { mvr_inquiry_annual: utcDate(2026, 6, 1) },
      },
    ],
    TODAY,
  )

  const annual = items.find((i) => i.rule.code === 'mvr_inquiry_annual')
  assert.ok(annual?.status.nextDue, 'an annual MVR must keep its next date')
  assert.ok((annual.daysUntil ?? -1) > 0, 'and it must be ahead of us')
})
