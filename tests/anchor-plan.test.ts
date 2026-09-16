/**
 * The write path for a date the owner types, and the four ways it goes wrong.
 *
 * This logic used to live inside one page's POST handler. It is out here now
 * because a second screen collects the same dates, and every one of these tests
 * is a bug that a second, hand-copied implementation would have reintroduced.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AnswerEntry,
  anchorSlot,
  type CurrentAnchor,
  isStorableDate,
  planAnchorWrites,
  recordSubjectFor,
} from '../src/lib/anchors/plan.ts'
import { answerDirectionFor, answerKeyFor } from '../src/lib/rules/answer.ts'
import { DRIVER_ANCHORS } from '../src/lib/rules/driver-anchors.ts'
import { allRules, evaluate } from '../src/lib/rules/index.ts'
import { VEHICLE_ANCHORS } from '../src/lib/vehicles.ts'

const plan = (entries: readonly AnswerEntry[], current: [string, CurrentAnchor][] = []) =>
  planAnchorWrites({
    entries,
    current: new Map(current),
    carrierId: 'carrier-1',
    userId: 'user-1',
    recordedAt: '2026-09-15T10:00:00.000Z',
  })

const driver = (anchorKey: string, on: string, id = 'driver-1'): AnswerEntry => ({
  subject: 'driver',
  subjectId: id,
  anchorKey,
  on,
})

// ------------------------------------------------------------- the supersede

test('a correction to an EARLIER date supersedes the row it corrects', () => {
  // Without this the fix does nothing visible. current_compliance_anchors picks
  // the latest occurred_on, not the latest typed, so a 2027 typo outranks the
  // 2026 that corrects it — she types it again, and the table fills with
  // corrections that never take.
  const p = plan(
    [driver('annual_mvr_last_obtained', '2026-03-01')],
    [
      [
        anchorSlot('driver', 'driver-1', 'annual_mvr_last_obtained'),
        { id: 'row-typo', occurred_on: '2027-03-01' },
      ],
    ],
  )
  assert.deepEqual(p.supersede, ['row-typo'])
  assert.equal(p.inserts.length, 1)
})

test('a LATER date leaves the old row alone — it is a new occurrence, not a fix', () => {
  // This year's MVR does not invalidate last year's. The old row is the evidence
  // the driver was qualified during the period it covered, and 49 CFR 391.51(c)
  // says we keep it.
  const p = plan(
    [driver('annual_mvr_last_obtained', '2026-03-01')],
    [
      [
        anchorSlot('driver', 'driver-1', 'annual_mvr_last_obtained'),
        { id: 'row-last-year', occurred_on: '2025-03-01' },
      ],
    ],
  )
  assert.deepEqual(p.supersede, [])
  assert.equal(p.inserts.length, 1)
})

test('retyping the date already on file writes nothing at all', () => {
  const p = plan(
    [driver('annual_mvr_last_obtained', '2026-03-01')],
    [
      [
        anchorSlot('driver', 'driver-1', 'annual_mvr_last_obtained'),
        { id: 'row-same', occurred_on: '2026-03-01' },
      ],
    ],
  )
  assert.equal(p.inserts.length, 0)
  assert.deepEqual(p.supersede, [])
  assert.equal(p.unchanged, 1)
})

test('a blank is skipped, never stored and never read as a deletion', () => {
  // These rows are the evidence a driver was qualified during the period they
  // cover. An accidental tab through an empty box must not remove one.
  const p = plan([driver('annual_mvr_last_obtained', '')])
  assert.equal(p.inserts.length, 0)
})

// ------------------------------------------------------------------ the slot

test('two trucks do not share one inspection date', () => {
  // Keyed on the anchor alone — which was enough when this form lived on one
  // driver's page — every unit in the fleet collapses into a single slot, and
  // truck 2's date supersedes truck 1's.
  const p = plan([
    {
      subject: 'vehicle',
      subjectId: 'truck-1',
      anchorKey: 'periodic_inspection_date',
      on: '2026-01-05',
    },
    {
      subject: 'vehicle',
      subjectId: 'truck-2',
      anchorKey: 'periodic_inspection_date',
      on: '2026-02-09',
    },
  ])
  assert.equal(p.inserts.length, 2)
  assert.deepEqual(
    p.inserts.map((i) => i.subject_id),
    ['truck-1', 'truck-2'],
  )
})

test('a tractor and a trailer are two subjects to the rules and one table to the database', () => {
  assert.equal(recordSubjectFor('power_unit'), 'vehicle')
  assert.equal(recordSubjectFor('trailer'), 'vehicle')
  assert.equal(recordSubjectFor('driver'), 'driver')
  assert.equal(recordSubjectFor('carrier'), 'carrier')
})

test('a subject with no table refuses rather than falling back to the carrier', () => {
  // `employee` rules are real and in the catalogue — harassment training, the SB
  // 553 plan — and nothing can be recorded against them yet. Coercing one to
  // 'carrier' would file one person's training date against the whole company
  // and mark the obligation satisfied for everybody.
  assert.equal(recordSubjectFor('employee'), null)
  assert.equal(recordSubjectFor('terminal'), null)
})

// -------------------------------------------------------------- the conflict

test('two different dates for one question write neither of them', () => {
  // One submit now spans the whole fleet, so the same question can appear twice
  // if a future edit renders a row per RULE rather than per question. Picking
  // one is picking at random; picking silently means he watches one answer land
  // and never learns the other was dropped.
  const p = plan([
    driver('clearinghouse_query_last_run', '2026-03-01'),
    driver('clearinghouse_query_last_run', '2026-04-02'),
  ])
  assert.equal(p.inserts.length, 0)
  assert.equal(p.supersede.length, 0)
  assert.equal(p.conflicts.length, 1)
})

test('one conflict does not discard the answers that were fine', () => {
  // It does today, and that is the deliberate choice: the whole submit is
  // refused so the page can say WHICH question disagreed with itself and show
  // every typed value back. A partial save would leave him re-deriving what
  // landed from a changed row count.
  const p = plan([
    driver('clearinghouse_query_last_run', '2026-03-01'),
    driver('clearinghouse_query_last_run', '2026-04-02'),
    driver('annual_mvr_last_obtained', '2026-05-05'),
  ])
  assert.equal(p.conflicts.length, 1)
  assert.equal(p.inserts.length, 0, 'the whole submit is refused, not silently half-applied')
})

test('the same date typed twice for one question is not a conflict', () => {
  const p = plan([
    driver('clearinghouse_query_last_run', '2026-03-01'),
    driver('clearinghouse_query_last_run', '2026-03-01'),
  ])
  assert.deepEqual(p.conflicts, [])
  assert.equal(p.inserts.length, 1)
})

// --------------------------------------------------------------- the payload

test('every insert carries the carrier, the recorder and the moment', () => {
  const p = plan([driver('annual_mvr_last_obtained', '2026-03-01')])
  assert.deepEqual(p.inserts[0], {
    carrier_id: 'carrier-1',
    subject_type: 'driver',
    subject_id: 'driver-1',
    anchor_key: 'annual_mvr_last_obtained',
    occurred_on: '2026-03-01',
    recorded_by: 'user-1',
    recorded_at: '2026-09-15T10:00:00.000Z',
  })
})

// ------------------------------------------------------------ the date value

test('a date that cannot exist is refused before Postgres sees it', () => {
  // 31 February parses in JavaScript and arrives as 3 March. Stored, it is a
  // date the owner never typed, attached to a document he has to produce.
  assert.equal(isStorableDate('2026-02-31'), false)
  assert.equal(isStorableDate('2026-13-01'), false)
  assert.equal(isStorableDate('2026-00-10'), false)
  assert.equal(isStorableDate('03/01/2026'), false)
  assert.equal(isStorableDate(''), false)
  assert.equal(isStorableDate('2026-02-28'), true)
  assert.equal(isStorableDate('2028-02-29'), true, '2028 is a leap year')
  assert.equal(isStorableDate('2027-02-29'), false, '2027 is not')
})

// -------------------------------------------- the read path and the write path

test('every rule names the anchor its own completion is read from', () => {
  // `evaluate()` resolves a completion as anchors[answerKeyFor(rule)]. If a
  // screen writes under any other key the date is stored perfectly, shown back
  // on every visit, and the rule reports missing data forever. Nothing throws,
  // nothing looks broken. This asserts the function both sides call is total.
  for (const rule of allRules) {
    const key = answerKeyFor(rule)
    assert.ok(key && key.length > 0, `${rule.code} has no answer key`)
    if ('anchor' in rule.recurrence) {
      assert.equal(key, rule.recurrence.anchor)
    } else {
      // No anchor to fall back on, so the completion is filed under the code.
      assert.equal(key, rule.code)
    }
  }
})

test('every unknown row says where its date should be filed', () => {
  // The gap this closes: the first version of this file asserted `answerKeyFor`
  // against the anchor catalogues and SKIPPED any key the catalogues did not
  // hold — which is precisely the set of rules that get it wrong. A `computed`
  // rule names no anchor on itself; it reads one inside its function. Derived
  // from the recurrence, an SPE certificate's expiry would be filed under the
  // rule code, where nothing ever reads it: stored perfectly, shown back on
  // every visit, and reported as missing forever.
  //
  // Run against subjects with NO anchors at all, so every rule in the catalogue
  // reports unknown and every key the editor can ever be asked to render is
  // exercised at once.
  const today = new Date(Date.UTC(2026, 8, 15))
  const items = evaluate(
    [
      { type: 'carrier', id: 'c1', label: 'C', context: {}, anchors: {} },
      { type: 'driver', id: 'd1', label: 'D', context: { cdl: true }, anchors: {} },
      { type: 'power_unit', id: 'v1', label: 'T', context: {}, anchors: {} },
      { type: 'trailer', id: 'v2', label: 'R', context: {}, anchors: {} },
    ],
    today,
  )

  const unknown = items.filter((i) => i.status.standing === 'unknown')
  assert.ok(unknown.length > 20, `expected a full catalogue of unknowns, got ${unknown.length}`)

  for (const item of unknown) {
    assert.ok(
      item.status.answerKey,
      `${item.rule.code} is unknown but says nothing about where its date goes`,
    )
  }

  // A row asking for a specific anchor asks for THAT anchor, whatever shape of
  // schedule wanted it.
  for (const item of unknown) {
    const needs = item.status.needs ?? []
    if (needs.length === 1 && needs[0] !== 'last completion date') {
      assert.equal(item.status.answerKey, needs[0], `${item.rule.code}`)
    }
  }
})

test('a rule whose schedule is an algorithm files its completion under its own code', () => {
  // The other branch. The schedule is known — the DQF was due the day he was
  // hired — and what is missing is whether anybody opened the file. That fact
  // has no anchor of its own, so it goes under the rule code, which is where
  // `evaluate` reads it back. Filed under `hire_date` instead it would overwrite
  // the hire date itself.
  const today = new Date(Date.UTC(2026, 8, 15))
  const [item] = evaluate(
    [
      {
        type: 'driver',
        id: 'd1',
        label: 'D',
        context: { cdl: true },
        anchors: { hire_date: new Date(Date.UTC(2026, 7, 1)) },
      },
    ],
    today,
  ).filter((i) => i.rule.code === 'dqf_maintained')

  assert.ok(item, 'the DQF rule should be evaluated')
  assert.equal(item.status.standing, 'unknown')
  assert.deepEqual(item.status.needs, ['last completion date'])
  assert.equal(item.status.answerKey, 'dqf_maintained')
})

test('the derived direction agrees with every hand-written anchor catalogue', () => {
  // `answerDirectionFor` reads the recurrence because the catalogues are
  // incomplete — there is no carrier catalogue at all. This pins the derivation
  // against the two catalogues that DO carry a hand-written `kind`, so the
  // cheap rule cannot quietly diverge from the considered one.
  const byKey = new Map<string, string>()
  for (const a of DRIVER_ANCHORS) byKey.set(a.key, a.kind)
  // `VehicleAnchor` carries no `kind` because the catalogue states the
  // invariant in prose instead: "every one of these names an event that has
  // ALREADY HAPPENED, and says so", and the help text is written around it. A
  // future `expiry` rule anchored on one of these keys would silently break
  // that promise and every one of those help sentences with it.
  for (const a of VEHICLE_ANCHORS) byKey.set(a.key, 'last_done')

  let checked = 0
  for (const rule of allRules) {
    const kind = byKey.get(answerKeyFor(rule))
    if (!kind) continue
    checked++
    assert.equal(
      answerDirectionFor(rule),
      kind,
      `${rule.code} -> ${answerKeyFor(rule)}: derived ${answerDirectionFor(rule)}, catalogue says ${kind}`,
    )
  }
  assert.ok(checked > 5, `expected to check several anchors, checked ${checked}`)
})
