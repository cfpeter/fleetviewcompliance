/**
 * The qualification ring.
 *
 * A ring is read in about a second and argued with never, so the failure this
 * whole file guards is one specific sentence: a full green circle beside a
 * driver whose printed file has a hole in it. That is a false assurance drawn
 * on the exact document somebody asks for when they are checking up on you, and
 * it is worse than drawing nothing at all.
 *
 * So the first test is the one that matters — the ring's numbers ARE the
 * binder's numbers — and the rest stop the obvious ways to break it.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  type DqRing,
  dqRing,
  driverLine,
  RING_CIRCUMFERENCE,
  ringArcs,
  ringFraction,
  rosterLine,
  rowLine,
  TONE_FOR_STATE,
} from '../src/lib/charts/dq-rings.ts'
import { assembleDqf, type DqfItem, type ItemState, summarise } from '../src/lib/proof/dqf.ts'
import { utcDate } from '../src/lib/rules/dates.ts'
import { evaluate } from '../src/lib/rules/index.ts'

const TODAY = utcDate(2026, 9, 15)
const OBSERVED = utcDate(2026, 9, 15)

const driverItems = (anchors: Record<string, Date>, context: Record<string, unknown> = {}) =>
  evaluate([{ type: 'driver', id: 'd1', label: 'A Driver', context, anchors }], TODAY).filter(
    (i) => i.subjectId === 'd1',
  )

/**
 * A driver whose office manager has done everything.
 *
 * (b)(7) and (b)(8) have no rule that can speak for them here — an SPE is a
 * document, and the National Registry note is a document — so they are handed
 * in as documents we hold, which is the same door the binder opens for them.
 */
const KEPT: Record<string, Date> = {
  hire_date: utcDate(2025, 1, 5),
  dqf_maintained: utcDate(2025, 1, 5),
  mvr_inquiry_at_hire: utcDate(2025, 1, 5),
  road_test_or_equivalent: utcDate(2025, 1, 5),
  annual_mvr_last_obtained: utcDate(2026, 7, 1),
  annual_review_last_completed: utcDate(2026, 7, 1),
  medical_certificate_expires: utcDate(2028, 1, 1),
  medical_exam_date: utcDate(2026, 1, 5),
}

const HELD = new Set(['(b)(7)', '(b)(8)'])
const NO_SPE = { holdsSpeCertificate: false }

const fileFor = (overrides: Record<string, Date> = {}, drop: string[] = []): DqfItem[] => {
  const anchors = { ...KEPT, ...overrides }
  for (const key of drop) delete anchors[key]
  return assembleDqf({ items: driverItems(anchors, NO_SPE), heldDocumentKinds: HELD })
}

const tones = (ring: DqRing) => ringArcs(ring).map((a) => a.tone)

// --- the one that matters ----------------------------------------------------

test('the ring counts what the binder counts, item for item', () => {
  // There is exactly one definition of "on file" in this product and it lives
  // in dqf.ts. If this ever fails it means a second one has been written, and
  // the roster and the printed file are about to disagree in front of a broker.
  const cases: Record<string, DqfItem[]> = {
    'nothing typed in at all': assembleDqf({ items: [] }),
    'everything typed in': fileFor(),
    'medical card expired': fileFor({ medical_certificate_expires: utcDate(2025, 4, 1) }),
    'medical card due soon': fileFor({ medical_certificate_expires: utcDate(2026, 10, 1) }),
    'medical card date never typed': fileFor({}, ['medical_certificate_expires']),
  }

  for (const [label, items] of Object.entries(cases)) {
    const summary = summarise(items, OBSERVED)
    const ring = dqRing(items, OBSERVED)

    assert.equal(ring.onFile, summary.present, `${label}: on file`)
    assert.equal(ring.dueSoon, summary.expiring, `${label}: due soon`)
    assert.equal(ring.attention, summary.attention, `${label}: needing attention`)
    assert.equal(ring.total, summary.total, `${label}: total`)

    // The fraction printed in the middle of the ring is the same pair of
    // numbers the binder's header prints, in the same order.
    assert.equal(ringFraction(ring), `${summary.present}/${summary.total}`, `${label}: fraction`)

    // And the red/grey split is a split of exactly what the binder calls a gap.
    assert.equal(ring.actNow + ring.noDate, summary.attention, `${label}: the split of the gaps`)
  }
})

test('the four buckets account for every item, with none counted twice', () => {
  const ring = dqRing(fileFor({ medical_certificate_expires: utcDate(2026, 10, 1) }), OBSERVED)
  const summed = ring.slices.reduce((n, s) => n + s.count, 0)
  assert.equal(summed, ring.total, 'the slices are the whole file or the ring is a lie')
  assert.equal(ring.onFile + ring.dueSoon + ring.actNow + ring.noDate, ring.total)
})

// --- missing is not passing --------------------------------------------------

test('a missing medical card date never draws a full ring', () => {
  // The failure in one line: a driver nobody has a medical card date for, shown
  // as a complete file. An auditor reads an absent record as a failure.
  const items = fileFor({}, ['medical_certificate_expires'])
  const ring = dqRing(items, OBSERVED)

  assert.ok(ring.noDate > 0, 'the undated medical item has to land in the grey bucket')
  assert.ok(ring.onFile < ring.total, 'an undated item can never be counted as on file')
  assert.ok(tones(ring).includes('nodate'), 'the grey arc must actually be drawn')

  const green = ringArcs(ring).find((a) => a.tone === 'ok')
  assert.ok(
    !green || green.dash < RING_CIRCUMFERENCE,
    'no green arc may close the circle while something is undated',
  )
})

test('grey is a bucket of its own, and it is never the green one', () => {
  assert.equal(TONE_FOR_STATE.unknown, 'nodate')
  assert.equal(TONE_FOR_STATE.missing, 'act')
  assert.equal(TONE_FOR_STATE.expired, 'act')
  assert.equal(TONE_FOR_STATE.expiring, 'soon')
  assert.equal(TONE_FOR_STATE.present, 'ok')

  // Every state the binder can produce has a tone. A state added to dqf.ts with
  // no tone here would render as no arc at all — an item silently deleted from
  // the circle, which is the quietest possible way for this to go wrong.
  const states: ItemState[] = ['present', 'expiring', 'expired', 'missing', 'unknown']
  for (const s of states) assert.ok(TONE_FOR_STATE[s], `${s} has no tone`)
})

test('a driver with no dates at all is eight gaps, not an empty ring', () => {
  const ring = dqRing(assembleDqf({ items: [] }), OBSERVED)

  assert.equal(ring.total, 8)
  assert.equal(ring.onFile, 0, 'nothing is on file when nothing is known')
  assert.equal(ring.attention, 8)
  assert.ok(!tones(ring).includes('ok'), 'not one green arc on a file nobody has typed into')

  for (const a of ringArcs(ring)) {
    assert.ok(Number.isFinite(a.dash) && Number.isFinite(a.offset), 'no NaN reached the markup')
  }
})

test('a file with every item on file draws one full green ring', () => {
  const ring = dqRing(fileFor(), OBSERVED)

  assert.equal(ring.onFile, ring.total, `expected all ${ring.total} on file, got ${ring.onFile}`)
  assert.equal(ring.attention, 0)
  assert.deepEqual(tones(ring), ['ok'])
  assert.equal(ringArcs(ring)[0].dash, RING_CIRCUMFERENCE)
  assert.equal(ringFraction(ring), '8/8')
})

// --- the arithmetic the markup reads off -------------------------------------

test('the arcs fill the circle exactly and meet without a seam', () => {
  const ring = dqRing(
    fileFor({ medical_certificate_expires: utcDate(2025, 4, 1) }, ['hire_date']),
    OBSERVED,
  )
  const arcs = ringArcs(ring)
  assert.ok(arcs.length > 1, 'this fixture is meant to produce several tones')

  const drawn = arcs.reduce((n, a) => n + a.dash, 0)
  assert.ok(Math.abs(drawn - RING_CIRCUMFERENCE) < 0.01, `arcs drew ${drawn}, not a whole circle`)

  // Each arc starts where the one before it ended, or the ring has a hairline
  // gap in it that reads as a ninth, invisible item.
  let expected = 0
  for (const a of arcs) {
    assert.equal(a.offset, -expected, 'an arc did not start where the last one finished')
    assert.ok(Math.abs(a.dash + a.gap - RING_CIRCUMFERENCE) < 0.01, 'dash + gap is the circle')
    expected = Math.round((expected + a.dash) * 1000) / 1000
  }
})

test('the worst thing is drawn first, at twelve o’clock', () => {
  // Where the eye lands. An amber arc at the top of a ring whose real news is
  // two expired items is a ring that reports the good part first.
  const ring = dqRing(
    fileFor({ medical_certificate_expires: utcDate(2025, 4, 1) }, ['hire_date']),
    OBSERVED,
  )
  const drawn = tones(ring)
  assert.equal(drawn[0], 'act')
  assert.equal(drawn[drawn.length - 1], 'ok')
})

test('a file with no items at all draws nothing rather than dividing by zero', () => {
  // Not reachable through assembleDqf, which always returns the eight. It is
  // reachable the day somebody hands this a filtered list, and a division by
  // zero there is a NaN in a stroke-dasharray and a blank card on the page.
  const empty = dqRing([], OBSERVED)
  assert.equal(empty.total, 0)
  assert.deepEqual(ringArcs(empty), [])
  assert.equal(rowLine(empty), 'Nothing on file')
  assert.match(driverLine(empty), /Nothing is tracked/)
})

test('the ring carries the moment it was taken', () => {
  const ring = dqRing(assembleDqf({ items: [] }), OBSERVED)
  assert.equal(ring.observedAt.toISOString().slice(0, 10), '2026-09-15')
})

// --- the words, which are what colour-blind readers and printers get ---------

test('the roster line names every bucket that is not on file', () => {
  const ring = dqRing(
    fileFor({ medical_certificate_expires: utcDate(2025, 4, 1) }, ['hire_date']),
    OBSERVED,
  )
  const line = rowLine(ring)

  assert.match(line, /^\d+\/8 on file/, 'the arithmetic comes first and is never hidden')
  assert.match(line, /to fix/)
  assert.match(line, /no date/, 'the grey bucket is spelled out, never left to the colour')
})

test('a clean file says so in one short line and adds nothing', () => {
  assert.equal(rowLine(dqRing(fileFor(), OBSERVED)), '8/8 on file')
})

test('the driver’s figure leads with the answer, not the name of the chart', () => {
  const gap = dqRing(fileFor({}, ['medical_certificate_expires']), OBSERVED)
  assert.match(driverLine(gap), /^1 of 8 item needs work\.$/)

  const two = dqRing(
    fileFor({}, ['medical_certificate_expires', 'annual_mvr_last_obtained']),
    OBSERVED,
  )
  assert.match(driverLine(two), /^2 of 8 items need work\.$/)

  const soon = dqRing(fileFor({ medical_certificate_expires: utcDate(2026, 10, 1) }), OBSERVED)
  assert.match(driverLine(soon), /All 8 items are on file\. 1 expires soon\./)

  assert.equal(driverLine(dqRing(fileFor(), OBSERVED)), 'All 8 items are on file.')
})

test('the roster sentence counts drivers, because that is the question', () => {
  const clean = dqRing(fileFor(), OBSERVED)
  const broken = dqRing(assembleDqf({ items: [] }), OBSERVED)
  const soon = dqRing(fileFor({ medical_certificate_expires: utcDate(2026, 10, 1) }), OBSERVED)

  assert.equal(rosterLine([]), '')
  assert.equal(rosterLine([broken, clean, clean]), '1 of 3 drivers has a gap in the file.')
  assert.equal(rosterLine([broken, broken, clean]), '2 of 3 drivers have gaps in the file.')
  assert.equal(rosterLine([soon, clean]), 'No gaps. 1 of 2 drivers has a date coming up.')
  assert.equal(rosterLine([clean, clean]), 'No gaps in these 2 files.')
})

// --- the thing the binder is careful about, kept careful here ----------------

test('nothing in the ring grades the driver', async () => {
  // Same ban the binder lives under, applied to the two files that now draw a
  // picture of the same facts. A ring is read faster than a page, so a verdict
  // smuggled into one is read by more people, not fewer.
  const sources = await Promise.all(
    ['../src/lib/charts/dq-rings.ts', '../src/components/charts/Ring.astro'].map((p) =>
      readFile(fileURLToPath(new URL(p, import.meta.url)), 'utf8'),
    ),
  )

  const banned = [
    /\bcompliant\b/i,
    /\bcompliance score\b/i,
    /\bverified\b/i,
    /\bcertified\b/i,
    /\bin good standing\b/i,
    /\bfully qualified\b/i,
    /\bpass(?:es|ed)? the audit\b/i,
  ]

  for (const source of sources) {
    for (const pattern of banned) {
      const hit = source.match(pattern)
      assert.equal(hit, null, `the ring must not say "${hit?.[0]}" — it draws facts, not a verdict`)
    }
  }
})
