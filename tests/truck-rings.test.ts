/**
 * The per-truck ring.
 *
 * Two sentences this file exists to stop being drawn.
 *
 * The first is the driver ring's: a full green circle beside a unit whose
 * annual inspection date nobody has typed in. An absent record is a failure,
 * not a pass, and drawn as a pass it is a false assurance on the screen an
 * owner checks fastest.
 *
 * The second is new to trucks: a red circle beside a TRAILER, because it was
 * scored against a power unit's list. A trailer has no engine — no Clean Truck
 * Check, no Form 2290, no fuel tax — so equipment that is entirely in order
 * would read as permanently broken, and the first thing that teaches is to
 * ignore the colour on the trucks where it is real.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RING_CIRCUMFERENCE, ringArcs, ringFraction } from '../src/lib/charts/dq-rings.ts'
import { RING_TONES as DRIVER_TONES } from '../src/lib/charts/dq-rings.ts'
import { buildHealth, type HealthKey } from '../src/lib/charts/health.ts'
import {
  COVERAGE_NOTE,
  fleetLine,
  noScheduleNote,
  RING_TONES,
  ringSubtitle,
  rowLine,
  TONE_FOR_BUCKET,
  TRAILER_NOTE,
  truckLine,
  truckRing,
  type TruckKind,
  type TruckRing,
} from '../src/lib/charts/truck-rings.ts'
import { utcDate } from '../src/lib/rules/dates.ts'
import { type DeadlineItem, evaluate } from '../src/lib/rules/index.ts'

const TODAY = utcDate(2026, 9, 15)
const OBSERVED = utcDate(2026, 9, 15)

/**
 * A California carrier's unit, evaluated exactly the way `loadDeadlines` does
 * it: same subject type, same context keys, same anchors map.
 */
function unitItems(
  kind: TruckKind,
  anchors: Record<string, Date>,
  context: Record<string, unknown> = {},
): DeadlineItem[] {
  return evaluate(
    [
      {
        type: kind,
        id: kind,
        label: kind === 'trailer' ? 'T-1' : '101',
        context: { registrationState: 'CA', gvwrLbs: 33_000, carrierOperation: 'A', ...context },
        anchors,
      },
    ],
    TODAY,
  )
}

/**
 * A power unit whose office manager has answered everything.
 *
 * The last two are keyed by RULE CODE rather than by an anchor name, which is
 * what `answerKeyFor` does for a `computed` schedule — the dashboard's inline
 * answer boxes write them there. Without them those two rows stay `unknown`
 * forever, which is correct and is what a real fleet looks like; this fixture
 * is the fully-answered case, and there is a fixture below for the other one.
 */
const KEPT: Record<string, Date> = {
  periodic_inspection_date: utcDate(2026, 6, 1),
  hvut_first_use_date: utcDate(2026, 1, 10),
  carb_ctc_first_deadline: utcDate(2026, 5, 1),
  bit_last_inspection: utcDate(2026, 9, 1),
  cvra_last_registered: utcDate(2026, 5, 20),
  'fed.396.21.inspection-report-retention.power-unit': utcDate(2026, 6, 1),
  'fed.irs.2290.heavy-vehicle-use-tax': utcDate(2026, 9, 10),
}

const truckFor = (overrides: Record<string, Date> = {}, drop: string[] = []): DeadlineItem[] => {
  const anchors = { ...KEPT, ...overrides }
  for (const key of drop) delete anchors[key]
  return unitItems('power_unit', anchors)
}

/** The trailer's whole world: one inspection, and the report kept from it. */
const TRAILER_KEPT: Record<string, Date> = {
  periodic_inspection_date: utcDate(2026, 6, 1),
  'fed.396.21.inspection-report-retention.trailer': utcDate(2026, 6, 1),
}

const trailerFor = (overrides: Record<string, Date> = {}, drop: string[] = []): DeadlineItem[] => {
  const anchors = { ...TRAILER_KEPT, ...overrides }
  for (const key of drop) delete anchors[key]
  return unitItems('trailer', anchors)
}

const ring = (items: DeadlineItem[], kind: TruckKind = 'power_unit') =>
  truckRing(items, kind, OBSERVED)

const tones = (r: TruckRing) => ringArcs(r).map((a) => a.tone)

const health = (items: DeadlineItem[]) =>
  buildHealth(items.map((i) => ({ standing: i.status.standing, daysUntil: i.daysUntil })))

// --- the one that matters ----------------------------------------------------

test('the ring counts what the dashboard counts, bucket for bucket', () => {
  // There is one definition of "overdue", "missing a date", "due soon" and "on
  // track" in this product and it is `buildHealth`. If this ever fails it means
  // a second one has been written, and the fleet table and the dashboard are
  // about to disagree in front of the man who reads both every morning.
  const cases: Record<string, { items: DeadlineItem[]; kind: TruckKind }> = {
    'nothing typed in at all': { items: truckFor({}, Object.keys(KEPT)), kind: 'power_unit' },
    'everything typed in': { items: truckFor(), kind: 'power_unit' },
    'inspection long overdue': {
      items: truckFor({ periodic_inspection_date: utcDate(2024, 1, 5) }),
      kind: 'power_unit',
    },
    'BIT inspection coming up': {
      items: truckFor({ bit_last_inspection: utcDate(2026, 7, 15) }),
      kind: 'power_unit',
    },
    'inspection date never typed': {
      items: truckFor({}, ['periodic_inspection_date']),
      kind: 'power_unit',
    },
    'a trailer with its inspection done': { items: trailerFor(), kind: 'trailer' },
    'a trailer with nothing typed in': {
      items: trailerFor({}, ['periodic_inspection_date']),
      kind: 'trailer',
    },
  }

  for (const [label, { items, kind }] of Object.entries(cases)) {
    const h = health(items.filter((i) => i.subjectType === kind))
    const r = truckRing(items, kind, OBSERVED)

    assert.equal(r.onFile, h.onTrack, `${label}: on track`)
    assert.equal(r.total, h.total, `${label}: total`)
    assert.equal(r.noSchedule, h.unschedulable, `${label}: duties with no schedule`)

    for (const bucket of h.buckets) {
      const slice = r.slices.find((s) => s.tone === TONE_FOR_BUCKET[bucket.key])
      assert.equal(slice?.count, bucket.count, `${label}: the ${bucket.key} bucket`)
    }

    // The fraction printed in the middle is the same pair of numbers the
    // sentence beside it is made of.
    assert.equal(ringFraction(r), `${r.onFile}/${r.total}`, `${label}: fraction`)
    // And the red/grey split is a split of exactly what the words call a gap.
    assert.equal(r.actNow + r.noDate, r.attention, `${label}: the split of the gaps`)
  }
})

test('the four buckets account for every obligation, with none counted twice', () => {
  const r = ring(truckFor({ bit_last_inspection: utcDate(2026, 7, 15) }))
  const summed = r.slices.reduce((n, s) => n + s.count, 0)
  assert.equal(summed, r.total, 'the slices are the whole list or the ring is a lie')
  assert.equal(r.onFile + r.dueSoon + r.actNow + r.noDate, r.total)
})

// --- trailers are not trucks -------------------------------------------------

test('a trailer is judged only against the obligations a trailer can have', () => {
  const trailer = ring(trailerFor(), 'trailer')
  const truck = ring(truckFor())

  // The catalogue gives a trailer two rules and a power unit far more. If this
  // ever inverts, something has started scoring a trailer against an engine.
  assert.ok(trailer.total > 0, 'a trailer owes something and the ring has to show it')
  assert.ok(
    truck.total > trailer.total,
    `a power unit owes more than a trailer (${truck.total} vs ${trailer.total})`,
  )

  // The engine-only obligations, by name. None of them may reach a trailer.
  const trailerCodes = trailerFor().map((i) => i.rule.code)
  for (const code of trailerCodes) {
    assert.doesNotMatch(
      code,
      /2290|ctc|bit|cvra|ifta|dvir/i,
      `${code} needs an engine and must never be counted against a trailer`,
    )
  }

  // And the one that would have shipped the bug: a trailer whose inspection is
  // done is FULLY on file, not a red circle wearing a power unit's denominator.
  assert.equal(trailer.attention, 0, 'a trailer in order has no gaps')
  assert.equal(trailer.onFile, trailer.total)
  assert.deepEqual(tones(trailer), ['ok'])
  assert.equal(truckLine(trailer), `All ${trailer.total} items are on file.`)
})

test('handing the ring the whole fleet does not let a truck’s list reach a trailer', () => {
  // The page filters by subject id. This is the second lock: even given every
  // item in the yard, a trailer ring counts trailer obligations and nothing
  // else, so a filtering mistake one screen away cannot produce the red circle.
  const mixed = [...truckFor(), ...trailerFor()]
  const fromMixed = truckRing(mixed, 'trailer', OBSERVED)
  const fromOwn = truckRing(trailerFor(), 'trailer', OBSERVED)

  assert.equal(fromMixed.total, fromOwn.total)
  assert.deepEqual(
    fromMixed.slices.map((s) => s.count),
    fromOwn.slices.map((s) => s.count),
  )
})

test('the denominator is the unit’s own, and it is printed', () => {
  const trailer = ring(trailerFor(), 'trailer')
  const truck = ring(truckFor())

  // A visible fraction, never a bare percentage — a percentage is a number a
  // broker quotes back and an owner cannot take apart.
  assert.match(ringFraction(trailer), /^\d+\/\d+$/)
  assert.match(ringSubtitle(trailer), /trailer/)
  assert.match(ringSubtitle(truck), /truck/)
  assert.doesNotMatch(ringSubtitle(trailer), /truck/, 'a trailer is never called a truck')

  // And the reason its circle is smaller is stated, not left to be guessed at.
  assert.match(TRAILER_NOTE, /no engine/i)
  assert.match(TRAILER_NOTE, /2290/)
})

// --- missing is not passing --------------------------------------------------

test('a truck with no inspection date never draws a full ring', () => {
  // The failure in one line: a truck nobody has an inspection date for, shown
  // as a complete record. An auditor reads an absent record as a failure.
  const r = ring(truckFor({}, ['periodic_inspection_date']))

  assert.ok(r.noDate > 0, 'the undated inspection has to land in the grey bucket')
  assert.ok(r.onFile < r.total, 'an undated obligation can never be counted as on track')
  assert.ok(tones(r).includes('nodate'), 'the grey arc must actually be drawn')

  const green = ringArcs(r).find((a) => a.tone === 'ok')
  assert.ok(
    !green || green.dash < RING_CIRCUMFERENCE,
    'no green arc may close the circle while something is undated',
  )
})

test('a trailer with no inspection date never draws a full ring either', () => {
  const r = ring(trailerFor({}, ['periodic_inspection_date']), 'trailer')

  assert.equal(r.onFile, 0, 'nothing is on file when nothing is known')
  assert.ok(r.noDate > 0)
  assert.ok(!tones(r).includes('ok'), 'not one green arc on a trailer nobody has typed a date for')
  assert.match(truckLine(r), /needs? work\./)
})

test('grey is a bucket of its own, and it is never the green one', () => {
  assert.equal(TONE_FOR_BUCKET.unknown, 'nodate')
  assert.equal(TONE_FOR_BUCKET.overdue, 'act')
  assert.equal(TONE_FOR_BUCKET.soon, 'soon')
  assert.equal(TONE_FOR_BUCKET.ontrack, 'ok')

  // Every bucket `buildHealth` can produce has a tone. A bucket added there
  // with no tone here would render as no arc at all — an obligation silently
  // deleted from the circle, which is the quietest way for this to go wrong.
  const keys: HealthKey[] = ['overdue', 'unknown', 'soon', 'ontrack']
  for (const k of keys) assert.ok(TONE_FOR_BUCKET[k], `${k} has no tone`)
  for (const b of buildHealth([]).buckets) assert.ok(TONE_FOR_BUCKET[b.key], `${b.key} has no tone`)
})

test('the truck ring borrows the driver ring’s palette rather than copying it', () => {
  // Identity, not equality. Two tables with the same strings today are two
  // tables that diverge the first time one of them is edited, and a driver ring
  // and a truck ring in different reds are two designs.
  assert.equal(RING_TONES, DRIVER_TONES)
})

// --- the arithmetic the markup reads off -------------------------------------

test('the arcs fill the circle exactly and meet without a seam', () => {
  const r = ring(
    truckFor({ periodic_inspection_date: utcDate(2024, 1, 5), bit_last_inspection: utcDate(2026, 7, 15) }, [
      'cvra_last_registered',
    ]),
  )
  const arcs = ringArcs(r)
  assert.ok(arcs.length > 1, 'this fixture is meant to produce several tones')

  const drawn = arcs.reduce((n, a) => n + a.dash, 0)
  assert.ok(Math.abs(drawn - RING_CIRCUMFERENCE) < 0.01, `arcs drew ${drawn}, not a whole circle`)

  // Each arc starts where the one before it ended, or the ring has a hairline
  // gap in it that reads as one more, invisible obligation.
  let expected = 0
  for (const a of arcs) {
    assert.equal(a.offset, -expected, 'an arc did not start where the last one finished')
    assert.ok(Math.abs(a.dash + a.gap - RING_CIRCUMFERENCE) < 0.01, 'dash + gap is the circle')
    expected = Math.round((expected + a.dash) * 1000) / 1000
  }
})

test('the worst thing is drawn first, at twelve o’clock', () => {
  // Where the eye lands. An amber arc at the top of a ring whose real news is
  // an inspection two years overdue is a ring that reports the good part first.
  const r = ring(
    truckFor({ periodic_inspection_date: utcDate(2024, 1, 5), bit_last_inspection: utcDate(2026, 7, 15) }, [
      'cvra_last_registered',
    ]),
  )
  const drawn = tones(r)
  assert.equal(drawn[0], 'act')
  assert.equal(drawn[drawn.length - 1], 'ok')
})

test('a unit with no obligations at all draws nothing rather than dividing by zero', () => {
  // A sold unit is not evaluated, so it arrives here with an empty list. A
  // division by zero there is a NaN in a stroke-dasharray and a blank cell.
  const empty = truckRing([], 'power_unit', OBSERVED)
  assert.equal(empty.total, 0)
  assert.deepEqual(ringArcs(empty), [])
  assert.equal(rowLine(empty), 'Nothing on file')
  assert.match(truckLine(empty), /Nothing is tracked/)
  assert.match(ringSubtitle(empty), /No dated obligation/)
  assert.equal(fleetLine([]), '', 'an empty fleet says nothing rather than "0 of 0"')

  for (const a of ringArcs(ring(truckFor({}, Object.keys(KEPT))))) {
    assert.ok(Number.isFinite(a.dash) && Number.isFinite(a.offset), 'no NaN reached the markup')
  }
})

test('the ring carries the moment it was taken', () => {
  assert.equal(ring(truckFor()).observedAt.toISOString().slice(0, 10), '2026-09-15')
})

test('a duty with no schedule is declared, not folded into the circle', () => {
  // The CHP terminal visit and the CTC-VIS listing have no computable date.
  // Counting them as gaps would be a permanent red arc on a truck with nothing
  // wrong; dropping them silently would shrink the denominator with no notice.
  const r = ring(truckFor())
  assert.ok(r.noSchedule > 0, 'this fixture is meant to have at least one')
  assert.equal(
    r.slices.reduce((n, s) => n + s.count, 0),
    r.total,
    'the unschedulable rows are outside the circle',
  )
  assert.match(String(noScheduleNote(r)), /no date/)
  assert.equal(noScheduleNote({ ...r, noSchedule: 0 }), undefined)
})

// --- the words, which are what colour-blind readers and printers get ---------

test('the row line names every bucket that is not on file', () => {
  const r = ring(
    truckFor({ periodic_inspection_date: utcDate(2024, 1, 5) }, ['cvra_last_registered']),
  )
  const line = rowLine(r)

  assert.match(line, /^\d+\/\d+ on file/, 'the arithmetic comes first and is never hidden')
  assert.match(line, /to fix/)
  assert.match(line, /no date/, 'the grey bucket is spelled out, never left to the colour')
})

test('a unit with nothing outstanding says so in one short line and adds nothing', () => {
  const trailer = ring(trailerFor(), 'trailer')
  assert.equal(rowLine(trailer), `${trailer.total}/${trailer.total} on file`)
})

test('the unit’s figure leads with the answer, not the name of the chart', () => {
  const gap = ring(truckFor({}, ['periodic_inspection_date']))
  assert.match(truckLine(gap), /^\d+ of \d+ items? needs? work\.$/)

  const soon = ring(truckFor({ bit_last_inspection: utcDate(2026, 7, 15) }))
  assert.match(truckLine(soon), /^All \d+ items are on file\. \d+ (is|are) due soon\.$/)

  assert.match(truckLine(ring(truckFor())), /^All \d+ items are on file\.$/)
})

test('the fleet sentence counts units, because that is the question', () => {
  const clean = ring(truckFor())
  const broken = ring(truckFor({}, Object.keys(KEPT)))
  const soon = ring(truckFor({ bit_last_inspection: utcDate(2026, 7, 15) }))
  const trailer = ring(trailerFor(), 'trailer')

  assert.equal(fleetLine([]), '')
  assert.equal(fleetLine([broken, clean, clean]), '1 of 3 trucks has something overdue or missing a date.')
  assert.equal(fleetLine([broken, broken, clean]), '2 of 3 trucks have something overdue or missing a date.')
  assert.equal(fleetLine([soon, clean]), 'No gaps. 1 of 2 trucks has a date coming up.')
  assert.equal(fleetLine([clean, clean]), 'No gaps in these 2 trucks.')
})

test('a list holding trailers never calls them trucks', () => {
  // The IFTA screen once counted trailers as trucks and asked the owner for
  // miles on equipment with no engine. The sentence over the fleet table is the
  // same trap one screen along.
  const truck = ring(truckFor())
  const trailer = ring(trailerFor(), 'trailer')
  const brokenTrailer = ring(trailerFor({}, ['periodic_inspection_date']), 'trailer')

  assert.match(fleetLine([brokenTrailer, trailer]), /^1 of 2 trailers has /)
  assert.doesNotMatch(fleetLine([brokenTrailer, trailer]), /truck/)
  assert.match(fleetLine([brokenTrailer, truck]), /^1 of 2 units has /)
  assert.equal(fleetLine([trailer]), 'No gaps in this trailer.')
})

// --- the thing the binder is careful about, kept careful here ----------------

test('nothing in the truck ring says the truck may roll', async () => {
  // "Which trucks are legal to roll" is the right QUESTION and the wrong
  // ANSWER. The proof binder never prints "compliant"
  // (supabase/migrations/0013_share_links.sql), and a ring is read faster than
  // a page, so a verdict smuggled into one is read by more people, not fewer.
  const sources = await Promise.all(
    [
      '../src/lib/charts/truck-rings.ts',
      '../src/components/charts/Ring.astro',
      '../src/pages/app/vehicles/index.astro',
      '../src/pages/app/vehicles/[id].astro',
    ].map((p) => readFile(fileURLToPath(new URL(p, import.meta.url)), 'utf8')),
  )

  const banned = [
    /\bcompliant\b/i,
    /\bcompliance score\b/i,
    /\bverified\b/i,
    /\bcertified\b/i,
    /\bin good standing\b/i,
    /\broadworthy\b/i,
    /\bstreet legal\b/i,
    /\broad ?legal\b/i,
    /\blegal to (roll|drive|run|operate)\b/i,
    /\bsafe to (roll|drive|run|operate)\b/i,
    /\bok(ay)? to (roll|drive|run|operate)\b/i,
    /\bcleared to (roll|drive|run|operate)\b/i,
    /\bgood to go\b/i,
    /\bpass(?:es|ed)? (the audit|inspection)\b/i,
  ]

  for (const source of sources) {
    for (const pattern of banned) {
      const hit = source.match(pattern)
      assert.equal(hit, null, `the ring must not say "${hit?.[0]}" — it draws facts, not a verdict`)
    }
  }
})

test('no sentence the ring produces carries a bare percentage', () => {
  // "5/8" is fine because the arithmetic is visible. "63%" is a number a broker
  // quotes back and an owner cannot take apart.
  const rings = [
    ring(truckFor()),
    ring(truckFor({}, Object.keys(KEPT))),
    ring(trailerFor(), 'trailer'),
    truckRing([], 'power_unit', OBSERVED),
  ]

  const strings = [
    TRAILER_NOTE,
    COVERAGE_NOTE,
    fleetLine(rings),
    ...rings.flatMap((r) => [
      rowLine(r),
      truckLine(r),
      ringSubtitle(r),
      noScheduleNote(r) ?? '',
      ...r.slices.map((s) => s.label),
    ]),
  ]

  for (const s of strings) assert.doesNotMatch(s, /%|\bpercent\b/i, `"${s}" prints a percentage`)
})
