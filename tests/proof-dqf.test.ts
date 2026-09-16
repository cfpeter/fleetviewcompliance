/**
 * The binder is what a carrier hands to an officer or an underwriter, so the
 * thing it must never do is overstate what we know.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assembleDqf, gaps, summarise } from '../src/lib/proof/dqf.ts'
import { utcDate } from '../src/lib/rules/dates.ts'
import { evaluate } from '../src/lib/rules/index.ts'

const TODAY = utcDate(2026, 9, 15)

const driverItems = (anchors: Record<string, Date>) =>
  evaluate([{ type: 'driver', id: 'd1', label: 'A Driver', context: {}, anchors }], TODAY).filter(
    (i) => i.subjectId === 'd1',
  )

test('the binder is in statutory order, because that is how it is read', () => {
  const items = assembleDqf({ items: [] })
  assert.deepEqual(
    items.map((i) => i.paragraph),
    ['(b)(1)', '(b)(2)', '(b)(3)', '(b)(4)', '(b)(5)', '(b)(6)', '(b)(7)', '(b)(8)'],
    'an auditor works down 391.51(b); any other order makes them hunt',
  )
})

test('every item carries its citation', () => {
  for (const i of assembleDqf({ items: [] })) {
    assert.match(i.citation, /49 CFR/, `${i.paragraph} must cite the rule it comes from`)
  }
})

test('an empty file reports nothing as present', () => {
  // The failure this guards: a carrier who has typed nothing being handed a
  // clean-looking binder. That document would go to a broker.
  const items = assembleDqf({ items: [] })
  assert.equal(
    items.filter((i) => i.state === 'present').length,
    0,
    'nothing is present when nothing is known',
  )
})

test('an expired medical certificate shows as expired, not missing', () => {
  // Different words for different facts: "we never had it" and "it lapsed" lead
  // to different conversations with an underwriter.
  const items = assembleDqf({
    items: driverItems({ medical_certificate_expires: utcDate(2025, 4, 1) }),
  })
  const med = items.find((i) => i.paragraph === '(b)(6)')
  assert.equal(med?.state, 'expired')
})

test('a current certificate reports present, and a soon one reports expiring', () => {
  const current = assembleDqf({
    items: driverItems({ medical_certificate_expires: utcDate(2027, 6, 1) }),
  }).find((i) => i.paragraph === '(b)(6)')
  assert.equal(current?.state, 'present')

  const soon = assembleDqf({
    items: driverItems({ medical_certificate_expires: utcDate(2026, 10, 1) }),
  }).find((i) => i.paragraph === '(b)(6)')
  assert.equal(soon?.state, 'expiring', 'due in a fortnight is not the same as fine')
})

test('the worst item wins within a paragraph', () => {
  // (b)(6) covers several medical rules at once. If any one of them is expired
  // the item is expired — a file is only as good as its weakest part.
  //
  // The driver here is insulin-treated (signalled by the assessment anchor), so
  // the 12-month variant applies ON TOP of a printed card that is still valid.
  // A card good until 2027 does not excuse an assessment from 2024.
  const items = assembleDqf({
    items: driverItems({
      medical_certificate_expires: utcDate(2027, 6, 1),
      insulin_treated_diabetes_assessment: utcDate(2024, 1, 1),
    }),
  })
  assert.notEqual(items.find((i) => i.paragraph === '(b)(6)')?.state, 'present')
})

test('a stale exam date does NOT taint a valid printed card', () => {
  // The opposite case, and the one that would make the binder cry wolf. The
  // printed expiry governs; an old examination date is simply how that card
  // came to exist, and medical_certificate_by_exam_date steps aside for it.
  const items = assembleDqf({
    items: driverItems({
      medical_certificate_expires: utcDate(2027, 6, 1),
      medical_exam_date: utcDate(2020, 1, 1),
    }),
  })
  assert.equal(items.find((i) => i.paragraph === '(b)(6)')?.state, 'present')
})

test('the gap report leads with expired, then missing, then unknown', () => {
  const items = assembleDqf({
    items: driverItems({ medical_certificate_expires: utcDate(2025, 4, 1) }),
  })
  const g = gaps(items)
  assert.ok(g.length > 0)
  assert.equal(g[0].state, 'expired', 'the worst thing goes first; page one is what gets read')
})

test('the summary never claims compliance', () => {
  // Deliberate: a packet a carrier generates about himself is structurally
  // untrusted, and a green tick makes the whole document read as marketing.
  // Counts and a date are defensible; a verdict is not.
  const s = summarise(assembleDqf({ items: [] }), TODAY)
  assert.deepEqual(Object.keys(s).sort(), [
    'attention',
    'expiring',
    'observedAt',
    'present',
    'total',
  ])
  assert.equal(
    Object.values(s).some((v) => typeof v === 'boolean'),
    false,
    'no boolean verdict may appear in the summary',
  )
})

test('the summary is stamped with when we looked', () => {
  const s = summarise(assembleDqf({ items: [] }), TODAY)
  assert.equal(s.observedAt.toISOString().slice(0, 10), '2026-09-15')
})

test('the CDL-only sunset is stated on (b)(8), so nobody chases a non-requirement', () => {
  const b8 = assembleDqf({ items: [] }).find((i) => i.paragraph === '(b)(8)')
  assert.match(String(b8?.note), /2025-06-22|non-CDL|NON-CDL/i)
})
