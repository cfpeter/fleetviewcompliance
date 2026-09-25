/**
 * WHO THE DASHBOARD CAN ACT ON, and the defect that made it the wrong people.
 *
 * The card actions were built on `buildDateEditor`, which is
 * `items.filter(i => i.status.standing === 'unknown')`. So the SERVER believed
 * "can be texted" meant "is missing a date": a driver whose medical card
 * EXPIRED EIGHT DAYS AGO was not in the index, and every intent answered "that
 * driver is not on this list any more".
 *
 * That is backwards. An expired card is the thing that stops a man driving
 * today, and it is also exactly what he can fix from his own phone in a minute
 * — the two non-conditional asks in the catalogue are the medical card and the
 * licence, which is precisely what `eligibility()` blocks on. The ask list was
 * built for the overdue case while the button shipped on the unknown one.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { blockedDriverIds, buildActionIndex } from '../src/lib/dashboard-actions.ts'
import { asksForAnswerKeys } from '../src/lib/driver-link/asks.ts'
import type { Standing } from '../src/lib/rules/compute.ts'
import type { DeadlineItem } from '../src/lib/rules/index.ts'
import type { RuleDefinition } from '../src/lib/rules/types.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const CARRIER = '00000000-0000-4000-8000-000000000000'

const rule = (code: string, anchor: string, title: string): RuleDefinition =>
  ({
    code,
    title,
    jurisdiction: 'federal',
    subject: 'driver',
    citation: 'x',
    sourceUrl: '#',
    recurrence: { type: 'interval', anchor, months: 12 },
    warningDays: [],
    evidence: '',
    consequence: '',
    impact: 'driver',
  }) as unknown as RuleDefinition

const item = (
  over: {
    code?: string
    anchor?: string
    title?: string
    subjectType?: DeadlineItem['subjectType']
    subjectId?: string | null
    subjectLabel?: string
    standing?: Standing
  } = {},
): DeadlineItem =>
  ({
    rule: rule(
      over.code ?? 'r1',
      over.anchor ?? 'medical_certificate_expires',
      over.title ?? 'Medical certificate',
    ),
    subjectType: over.subjectType ?? 'driver',
    subjectId: over.subjectId === undefined ? 'd1' : over.subjectId,
    subjectLabel: over.subjectLabel ?? 'Marco Villanueva',
    status: { standing: over.standing ?? 'overdue' },
  }) as unknown as DeadlineItem

// ---------------------------------------------------------------------------

test('the index holds every standing, not only the dates nobody knows', () => {
  const index = buildActionIndex(
    [
      item({ standing: 'overdue' }),
      item({ code: 'r2', anchor: 'cdl_expires', title: 'Licence', standing: 'current' }),
      item({ code: 'r3', anchor: 'annual_mvr_last_obtained', title: 'MVR', standing: 'unknown' }),
    ],
    CARRIER,
  )

  const marco = index.get('d1')
  assert.ok(marco, 'the overdue driver is in the index — this is the whole defect')
  assert.equal(marco.type, 'driver')
  assert.equal(marco.recordSubject, 'driver')
  assert.equal(marco.rowCount, 3)
  assert.deepEqual(marco.answerKeys, [
    'medical_certificate_expires',
    'cdl_expires',
    'annual_mvr_last_obtained',
  ])
})

test('he is asked for what he still owes, never for a card already on file', () => {
  const index = buildActionIndex(
    [
      item({ standing: 'overdue' }), // medical — expired, ask for it
      item({ code: 'r2', anchor: 'cdl_expires', title: 'Licence', standing: 'current' }), // fine
    ],
    CARRIER,
  )
  const marco = index.get('d1')
  assert.ok(marco)

  // `needKeys` is overdue + unknown only.
  assert.deepEqual(marco.needKeys, ['medical_certificate_expires'])
  assert.deepEqual(asksForAnswerKeys(marco.needKeys), ['medical'])

  // Asking off `answerKeys` instead would ask him to photograph a licence that
  // is on file and current — and spend the one message he reliably reads on it.
  assert.deepEqual(asksForAnswerKeys(marco.answerKeys), ['medical', 'cdl'])
})

test('one anchor answering two rules is one question, not two', () => {
  // A medical certificate expiry settles the federal rule and its California
  // twin. The rows are two; the thing to ask him for is one.
  const index = buildActionIndex(
    [
      item({ code: 'fed', title: 'Medical certificate' }),
      item({ code: 'ca', title: 'Medical certificate (California)' }),
    ],
    CARRIER,
  )
  const marco = index.get('d1')
  assert.ok(marco)
  assert.equal(marco.rowCount, 2)
  assert.equal(marco.questionCount, 1)
  assert.deepEqual(marco.answerKeys, ['medical_certificate_expires'])
})

test('a carrier row with no subject id is filed under the carrier', () => {
  // The carrier's own rows carry a null subjectId. Dropping them would make the
  // company record the one subject nothing can be done about.
  const index = buildActionIndex(
    [item({ subjectType: 'carrier', subjectId: null, subjectLabel: 'LS LOGISTICS' })],
    CARRIER,
  )
  assert.ok(index.get(CARRIER))
  assert.equal(index.get(CARRIER)?.recordSubject, 'carrier')

  // A driver row with no id is a row we cannot act on, and is dropped.
  assert.equal(buildActionIndex([item({ subjectId: null })], CARRIER).size, 0)
})

// ---------------------------------------------------------------------------
// Who cannot be dispatched
// ---------------------------------------------------------------------------

test('the banner names and texts the same people', () => {
  const items = [
    item({ subjectId: 'd1', subjectLabel: 'Marco' }),
    item({ subjectId: 'd2', subjectLabel: 'Ana' }),
    item({ subjectType: 'power_unit', subjectId: 'v1', subjectLabel: 'Unit 14' }),
  ]
  // Two copies of "who is blocked" is how a button comes to act on a different
  // set of people than the sentence above it names, so there is one function.
  const ids = blockedDriverIds(items, (d) => d.label === 'Marco')
  assert.deepEqual(ids, ['d1'])

  // Trucks are never in it — a truck cannot answer a text.
  assert.deepEqual(
    blockedDriverIds(items, () => true),
    ['d1', 'd2'],
  )
  assert.deepEqual(
    blockedDriverIds([], () => true),
    [],
  )
})

test('the blocked banner carries the action, not a signpost to one', () => {
  const page = read('../src/pages/app/index.astro')

  // It counted the blocked drivers and threw the ids away, keeping a link to a
  // board that shows him the same problem a second time.
  assert.match(
    page,
    /const blocked = blockedDriverIds\(items, \(d\) => isBlocked\(eligibility\(d\)\)\)/,
  )
  assert.match(page, /const blockedDrivers = blocked\.length/)
  assert.match(page, /blockedDrivers === 1 \? 'Text them' : `Text all \$\{blockedDrivers\}`/)
  assert.match(page, /value="ask_blocked_drivers"/)

  // The set is computed on the server from `items`, never posted — a list of
  // driver ids in the body would be an owner choosing who counts as blocked.
  assert.match(page, /const targets = askTargetsFor\(\s*blocked\.map/)
  assert.doesNotMatch(page, /form\.getAll\('driver_ids'\)/)
})

test('a press comes back to the view it was pressed from', () => {
  const page = read('../src/pages/app/index.astro')

  // `here()` hard-coded `show=unknown`, which was right while every action was
  // on that screen and wrong the moment one was not: pressing "Text Marco" in
  // the Overdue list threw him into a filtered view he never asked for — and
  // then said nothing, because every receipt was gated on that same view.
  assert.match(page, /const base = view === 'all' \? '' : `show=\$\{view\}`/)
  assert.doesNotMatch(page, /`show=unknown\$\{focus/)

  // And the four receipts render on whatever view produced them.
  for (const flag of ['bulkResult', 'askedLine', 'reminded', 'retiredId']) {
    assert.match(page, new RegExp(`\\n    ${flag} && \\(`), `${flag} is no longer view-gated`)
    assert.doesNotMatch(page, new RegExp(`view === 'unknown' && ${flag}`))
  }
})
