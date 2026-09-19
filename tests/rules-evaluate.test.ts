/**
 * The ordering of the dashboard, which is the product in one function.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextDue } from '../src/lib/rules/compute.ts'
import { utcDate } from '../src/lib/rules/dates.ts'
import { allRules, compareDeadlines, type DeadlineItem, evaluate } from '../src/lib/rules/index.ts'
import { IMPACT_LABEL, type Impact } from '../src/lib/rules/types.ts'

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

const item = (
  standing: string,
  days: number | undefined,
  label = 'x',
  impact: Impact = 'audit',
): DeadlineItem =>
  ({
    rule: { code: 'r', title: 't', impact },
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

// ---------------------------------------------------------------- impact (B2)

const IMPACTS: readonly Impact[] = ['company', 'driver', 'truck', 'money', 'audit', 'record']

test('EVERY rule says what a lapse stops — no rule may be silent', () => {
  // A rule with no impact is a rule that sorts wrong, and it sorts wrong
  // silently: the row still renders, still shows the right date, and is simply
  // in the wrong place on the page. This is the test that stops a rule added
  // next year from doing that.
  const silent = allRules.filter((r) => !r.impact)
  assert.deepEqual(
    silent.map((r) => r.code),
    [],
    'these rules carry no impact and will sort wrong',
  )

  for (const r of allRules) {
    assert.ok(
      IMPACTS.includes(r.impact),
      `${r.code} has impact '${r.impact}', which is not one of the six`,
    )
  }

  // The catalogue is 51 rules. If that number moves, somebody added or removed
  // an obligation, and the ranking in docs/product/DATE-PRIORITY.md needs the
  // same edit — so this assertion is a prompt, not a lock.
  assert.equal(allRules.length, 52, 'the catalogue changed size; re-check the ranking document')
})

test('every impact value has a sentence a screen can print', () => {
  // `impact` is shown to Los Angeles fleet owners, many of whom do not read
  // English fluently. A value with no plain sentence behind it is a value that
  // reaches a page as the bare word 'record'.
  for (const i of IMPACTS) {
    assert.ok(IMPACT_LABEL[i]?.length > 0, `${i} has no printable label`)
  }
  assert.equal(Object.keys(IMPACT_LABEL).length, IMPACTS.length)
})

test('the rules the ranking document is emphatic about carry the tier it gives them', () => {
  // Spot checks, not a full re-listing: these are the rows whose placement the
  // document argues for explicitly, so a change to one of them should have to
  // argue back.
  const impactOf = (code: string) => allRules.find((r) => r.code === code)?.impact

  // Tier 1 — the whole company stops.
  assert.equal(impactOf('fed.387.9.liability-insurance-filing'), 'company')
  assert.equal(impactOf('fed.usc.13906.operating-authority'), 'company')
  assert.equal(impactOf('fed.390.19T.mcs150-biennial-update'), 'company')
  assert.equal(impactOf('ca_mcp_renewal'), 'company')

  // Tier 2 — one driver stops. All five medical rules and the CDL.
  for (const code of allRules.map((r) => r.code).filter((c) => c.startsWith('medical_'))) {
    assert.equal(impactOf(code), 'driver', `${code} stops a driver`)
  }
  assert.equal(impactOf('cdl_expiry'), 'driver')

  // Tier 5 — retention floors. These are the rows that were outranking the
  // medical card inside the Overdue section, which is the whole reason for B2.
  for (const code of [
    'fed.396.21.inspection-report-retention.power-unit',
    'fed.396.21.inspection-report-retention.trailer',
    'fed.390.15.accident-register-retention',
    'fed.395.8.rods-retention',
    'fed.395.11.supporting-documents-retention',
    'fed.395.22.eld-backup-retention',
  ]) {
    assert.equal(impactOf(code), 'record', `${code} is a retention floor, not a deadline`)
  }
})

test('where the ranking disagrees with a rule’s own consequence, the ranking wins', () => {
  const impactOf = (code: string) => allRules.find((r) => r.code === code)?.impact

  // § 5.1 — the row's sentence reads like bookkeeping; an unlisted truck
  // cannot pass Clean Truck Check and so cannot be registered.
  assert.equal(impactOf('ca_ctc_vis_listing'), 'truck')

  // § 5.3 — the rows say "drivers placed out of service"; the only citation
  // they carry is an employer penalty, so they are ranked as audit findings.
  assert.equal(impactOf('random_controlled_substances_testing_rate'), 'audit')
  assert.equal(impactOf('random_alcohol_testing_rate'), 'audit')

  // § 5.4 — the row says "CHP-initiated MCP suspension"; one missed 90-day
  // inspection suspends no permit, and the aggregate is a different problem.
  assert.equal(impactOf('ca_bit_inspection'), 'money')
})

test('inside one standing, what a lapse stops beats how late it is', () => {
  // The bug B2 exists to fix, in one line: an ELD back-up retention row 90 days
  // past sat above a medical certificate that expired yesterday, because 90 is
  // more than 1. Days late measures how long we have been wrong, not what being
  // wrong costs.
  const sorted = [
    item('overdue', -90, 'eld backup', 'record'),
    item('overdue', -1, 'medical card', 'driver'),
  ].sort(compareDeadlines)

  assert.deepEqual(
    sorted.map((i) => i.subjectLabel),
    ['medical card', 'eld backup'],
  )
})

test('impact orders the whole scale, worst first', () => {
  const sorted = [
    item('overdue', -1, 'record', 'record'),
    item('overdue', -1, 'audit', 'audit'),
    item('overdue', -1, 'money', 'money'),
    item('overdue', -1, 'truck', 'truck'),
    item('overdue', -1, 'driver', 'driver'),
    item('overdue', -1, 'company', 'company'),
  ].sort(compareDeadlines)

  assert.deepEqual(
    sorted.map((i) => i.subjectLabel),
    ['company', 'driver', 'truck', 'money', 'audit', 'record'],
  )
})

test('STANDING STAYS PRIMARY — an overdue row never sorts below a green one', () => {
  // The line impact is not allowed to cross. A current insurance filing is the
  // most consequential obligation in the catalogue and it is not wrong today;
  // an overdue retention floor is the least consequential and it IS wrong
  // today. Overdue still comes first, and the same holds for `unknown`, which
  // ranks with overdue.
  const sorted = [
    item('current', 5, 'green company row', 'company'),
    item('unknown', undefined, 'unknown company row', 'company'),
    item('overdue', -1, 'overdue record row', 'record'),
  ].sort(compareDeadlines)

  assert.deepEqual(
    sorted.map((i) => i.status.standing),
    ['overdue', 'unknown', 'current'],
  )
})

test('an overdue INTERVAL row with a POSITIVE day count still outranks a current one', () => {
  // The trap that has shipped four times here. An overdue interval rule carries
  // a positive `daysUntil` — the cycle it missed is behind it and the next one
  // is ahead — so anything that bucketed on the sign of that number would file
  // it as fine. Standing decides the bucket; impact and days only order inside
  // it. Adding a second key ahead of days must not have changed that.
  const sorted = [
    item('current', 2, 'current row', 'driver'),
    item('overdue', 300, 'overdue row', 'record'),
  ].sort(compareDeadlines)

  assert.deepEqual(
    sorted.map((i) => i.subjectLabel),
    ['overdue row', 'current row'],
  )
})

test('within one impact, soonest still first, and undated still last', () => {
  // Impact is inserted ABOVE the day count, not instead of it.
  const sorted = [
    item('overdue', -3, 'c', 'truck'),
    item('overdue', undefined, 'd', 'truck'),
    item('overdue', -90, 'a', 'truck'),
  ].sort(compareDeadlines)

  assert.deepEqual(
    sorted.map((i) => i.daysUntil),
    [-90, -3, undefined],
  )
})

test('a real evaluation buries the retention floor under the rows that stop people', () => {
  // The bug as it actually reaches a page, through `evaluate` and the real
  // catalogue rather than hand-built rows.
  //
  // This carrier's inspection-report retention floor passed 683 days ago, which
  // is the largest negative day count anywhere on his dashboard. Sorted on days
  // alone it was the FIRST thing he saw, above the expired CDL date and the
  // expired medical card — a row that means "you may now shred this" leading a
  // page whose other rows mean "this man cannot drive".
  //
  // Note the retention row's standing: `unknown`, not `overdue`. No tier-5 row
  // in this catalogue can reach `overdue` — they are computed schedules with no
  // previous occurrence — so they collect in the `unknown` bucket alongside
  // every date the owner has not typed yet, and they collect the biggest
  // numbers in it.
  const items = evaluate(
    [
      {
        type: 'driver',
        id: 'd1',
        label: 'A Driver',
        context: { carrierOperation: 'A', cdl: true },
        // Expired eleven months ago.
        anchors: { medical_certificate_expires: utcDate(2025, 10, 1) },
      },
      {
        type: 'power_unit',
        id: 'v1',
        label: 'Truck 1',
        context: { gvwrLbs: 33_000, registrationState: 'CA' },
        // Inspected two years ago, so the 14-month retention floor is long past.
        anchors: { periodic_inspection_date: utcDate(2023, 9, 1) },
      },
    ],
    TODAY,
  )

  const at = (code: string) => items.findIndex((i) => i.rule.code === code)
  const retention = items[at('fed.396.21.inspection-report-retention.power-unit')]
  assert.ok(retention, 'the retention row must be on the page')
  assert.ok(
    (retention.daysUntil ?? 0) < -300,
    'this test is only meaningful while the retention floor is the most negative row',
  )

  // Inside its own bucket it is now last, under every row the owner can act on.
  const unknown = items.filter((i) => i.status.standing === 'unknown')
  assert.equal(
    unknown[unknown.length - 1]?.rule.code,
    'fed.396.21.inspection-report-retention.power-unit',
    'the retention floor must sit at the bottom of its bucket, not the top',
  )
  assert.ok(at('cdl_expiry') < at('fed.396.21.inspection-report-retention.power-unit'))

  // And the two overdue rows still lead the page, with the driver above the
  // truck. The annual inspection here is the positive-`daysUntil` overdue case:
  // it missed last year's cycle and the next one is 351 days ahead of it.
  const annual = items[at('fed.396.17.periodic-inspection.power-unit')]
  assert.equal(annual?.status.standing, 'overdue')
  assert.ok((annual.daysUntil ?? 0) > 0, 'an overdue interval rule can carry positive days')
  assert.equal(items[0]?.rule.code, 'medical_certificate_general')
  assert.equal(items[1]?.rule.code, 'fed.396.17.periodic-inspection.power-unit')
})

// ------------------------------------------------- for-hire insurance gate (B15)

test('the insurance filing still shows when we do not know if the carrier is for-hire', () => {
  // The state of the data today, and the state this test protects. Nothing in
  // the application populates `forHire`, so every carrier reaches this rule
  // with the fact unanswered — and an unanswered question must never turn into
  // "you are private, you owe nothing". Telling a for-hire carrier it owes no
  // filing is far worse than showing a private one a row it does not owe.
  const items = evaluate(
    [{ type: 'carrier', id: 'c1', label: 'A Carrier', context: {}, anchors: {} }],
    TODAY,
  )
  assert.ok(
    items.some((i) => i.rule.code === 'fed.387.9.liability-insurance-filing'),
    'a carrier with no for-hire fact must still be shown the filing',
  )
})

test('the filing drops off only when for-hire AND hazmat are both known and negative', () => {
  const shown = (context: Record<string, unknown>) =>
    evaluate([{ type: 'carrier', id: 'c1', label: 'A Carrier', context, anchors: {} }], TODAY).some(
      (i) => i.rule.code === 'fed.387.9.liability-insurance-filing',
    )

  // Both facts known and negative: a private, non-hazmat carrier.
  assert.equal(shown({ forHire: false, hazmat: false }), false)

  // Every other combination keeps the row. `forHire: false` with hazmat
  // unknown or true is the important one: Part 387's reach over a private
  // carrier of hazardous materials is not something this catalogue has
  // verified, and an unverified exemption takes an obligation away from
  // somebody who may owe it.
  assert.equal(shown({ forHire: false }), true)
  assert.equal(shown({ forHire: false, hazmat: true }), true)
  assert.equal(shown({ forHire: true, hazmat: false }), true)
  assert.equal(shown({ hazmat: false }), true)
  assert.equal(shown({}), true)
})
