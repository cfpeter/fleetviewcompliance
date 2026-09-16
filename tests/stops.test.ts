/**
 * The stops module — and above all the resequencing planners.
 *
 * `applyWrites` below is a model of the database constraint the planners exist
 * to survive: unique (load_id, sequence), checked at the end of every single
 * statement, with no transaction to defer it inside because each write is its
 * own PostgREST request. A plan that would take the real table down throws here
 * instead, which is the only way to test this without a database.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Sequenced, SequenceWrite } from '../src/lib/stops.ts'
import {
  formatMinutes,
  freeHoursFor,
  hasSequenceGaps,
  isoToLocalInput,
  localInputToIso,
  nextSequence,
  orderStops,
  planAfterRemoval,
  planMove,
  planRenumber,
  planResequence,
  stopClock,
} from '../src/lib/stops.ts'

function rows(...sequences: number[]): Sequenced[] {
  return sequences.map((sequence) => ({ id: `s${sequence}`, sequence }))
}

/**
 * Apply the writes one at a time, exactly as the page does, and refuse any
 * statement that would leave two stops on one sequence — which is what Postgres
 * does, with error 23505, in the middle of a renumber the user cannot retry.
 */
function applyWrites(state: readonly Sequenced[], writes: readonly SequenceWrite[]): Sequenced[] {
  const live = state.map((r) => ({ ...r }))
  for (const write of writes) {
    const row = live.find((r) => r.id === write.id)
    assert.ok(row, `write names a stop that is not on the load: ${write.id}`)
    const clash = live.find((r) => r.id !== write.id && r.sequence === write.sequence)
    assert.equal(
      clash,
      undefined,
      `unique (load_id, sequence) violated: ${write.id} -> ${write.sequence} ` +
        `while ${clash?.id} still holds it`,
    )
    row.sequence = write.sequence
  }
  return orderStops(live)
}

const idsOf = (state: readonly Sequenced[]) => state.map((r) => r.id)
const seqsOf = (state: readonly Sequenced[]) => state.map((r) => r.sequence)

// ---------------------------------------------------------------------------
// The collision the whole module exists for
// ---------------------------------------------------------------------------

test('the naive swap really does collide — this is the hazard being planned around', () => {
  // Proof the parking phase is not ceremony. Moving stop 3 up is a swap, and
  // the direct two writes put two rows on sequence 2 at the first statement.
  const state = rows(1, 2, 3)
  assert.throws(
    () =>
      applyWrites(state, [
        { id: 's3', sequence: 2 },
        { id: 's2', sequence: 3 },
      ]),
    /unique \(load_id, sequence\) violated/,
  )
})

test('moving a stop into an occupied sequence never collides mid-plan', () => {
  const state = rows(1, 2, 3, 4)
  const final = applyWrites(state, planMove(state, 's3', 'up'))
  assert.deepEqual(idsOf(final), ['s1', 's3', 's2', 's4'])
  assert.deepEqual(seqsOf(final), [1, 2, 3, 4])
})

test('moving down is the same swap from the other side', () => {
  const state = rows(1, 2, 3, 4)
  const final = applyWrites(state, planMove(state, 's2', 'down'))
  assert.deepEqual(idsOf(final), ['s1', 's3', 's2', 's4'])
  assert.deepEqual(seqsOf(final), [1, 2, 3, 4])
})

test('a move plan touches only the two stops that actually swap', () => {
  // Four writes: park two, set two. A planner that renumbered the whole list on
  // every arrow click would issue twelve statements on a six-stop load, each one
  // a round trip, on a page a dispatcher clicks repeatedly.
  const state = rows(1, 2, 3, 4, 5, 6)
  const writes = planMove(state, 's4', 'up')
  assert.equal(writes.length, 4)
  assert.deepEqual(new Set(writes.map((w) => w.id)), new Set(['s3', 's4']))
})

test('a parked sequence can never land on a stop that is staying put', () => {
  const state = rows(1, 2, 3, 4, 5)
  const writes = planMove(state, 's2', 'down')
  const parked = writes.slice(0, writes.length / 2).map((w) => w.sequence)
  // Every parked number is above every number the load currently holds, which
  // is the property that makes the first phase unconditionally safe.
  for (const p of parked) assert.ok(p > 5, `parked ${p} is inside the live range`)
})

test('moving past either end is a no-op, not an error', () => {
  const state = rows(1, 2, 3)
  assert.deepEqual(planMove(state, 's1', 'up'), [])
  assert.deepEqual(planMove(state, 's3', 'down'), [])
})

test('moving a stop that is not on the load does nothing', () => {
  assert.deepEqual(planMove(rows(1, 2), 'ghost', 'up'), [])
})

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

test('removing a middle stop closes the gap without a collision', () => {
  // The other collision shape: 4->3 while the old 3 is still sitting on 3.
  const after = rows(1, 2, 3, 4).filter((r) => r.id !== 's2')
  const final = applyWrites(after, planAfterRemoval(after, 's2'))
  assert.deepEqual(idsOf(final), ['s1', 's3', 's4'])
  assert.deepEqual(seqsOf(final), [1, 2, 3])
})

test('removing the last stop renumbers nothing', () => {
  const after = rows(1, 2, 3).filter((r) => r.id !== 's3')
  assert.deepEqual(planAfterRemoval(after, 's3'), [])
})

test('removing the first stop pulls every other stop up', () => {
  const after = rows(1, 2, 3).filter((r) => r.id !== 's1')
  const final = applyWrites(after, planAfterRemoval(after, 's1'))
  assert.deepEqual(seqsOf(final), [1, 2])
  assert.deepEqual(idsOf(final), ['s2', 's3'])
})

test('removing the only stop leaves an empty plan, not a crash', () => {
  assert.deepEqual(planAfterRemoval([], 's1'), [])
})

// ---------------------------------------------------------------------------
// Renumbering and gaps
// ---------------------------------------------------------------------------

test('a healthy list plans no writes at all', () => {
  assert.deepEqual(planRenumber(rows(1, 2, 3)), [])
})

test('a list with holes in it renumbers to 1..n', () => {
  const state = rows(1, 5, 9)
  const final = applyWrites(state, planRenumber(state))
  assert.deepEqual(seqsOf(final), [1, 2, 3])
  assert.deepEqual(idsOf(final), ['s1', 's5', 's9'])
})

test('a list numbered from zero is repaired, and 0 is not mistaken for a gapless start', () => {
  const state: Sequenced[] = [
    { id: 'a', sequence: 0 },
    { id: 'b', sequence: 1 },
  ]
  assert.equal(hasSequenceGaps(state), true)
  const final = applyWrites(state, planRenumber(state))
  assert.deepEqual(seqsOf(final), [1, 2])
  assert.deepEqual(idsOf(final), ['a', 'b'])
})

test('hasSequenceGaps sees holes and clean lists for what they are', () => {
  assert.equal(hasSequenceGaps(rows(1, 2, 3)), false)
  assert.equal(hasSequenceGaps(rows(1, 3)), true)
  assert.equal(hasSequenceGaps(rows(2, 3)), true)
  assert.equal(hasSequenceGaps([]), false)
})

test('a full reversal survives, which is the worst case for parking', () => {
  const state = rows(1, 2, 3, 4)
  const final = applyWrites(state, planResequence(state, ['s4', 's3', 's2', 's1']))
  assert.deepEqual(idsOf(final), ['s4', 's3', 's2', 's1'])
  assert.deepEqual(seqsOf(final), [1, 2, 3, 4])
})

test('planResequence refuses a partial list rather than half-renumbering one', () => {
  // Leaving a stop out is how a caller silently creates the collision this
  // module prevents: the omitted row keeps its number while another moves onto
  // it. It has to be loud in code, not at 23505.
  assert.throws(() => planResequence(rows(1, 2, 3), ['s1', 's3']), /every stop of the load/)
  assert.throws(() => planResequence(rows(1, 2), ['s1', 'ghost']), /unknown stop id/)
})

test('nextSequence is one past the largest, never the count', () => {
  assert.equal(nextSequence([]), 1)
  assert.equal(nextSequence(rows(1, 2, 3)), 4)
  // The count would say 3 here, which is occupied — the insert would be
  // refused by the unique index.
  assert.equal(nextSequence(rows(1, 3, 7)), 8)
})

// ---------------------------------------------------------------------------
// Appointment times across zones
// ---------------------------------------------------------------------------

test('an appointment typed in summer is stored as Pacific daylight time, not UTC', () => {
  // The bug: new Date('2026-07-15T14:30') on a Worker resolves to 14:30Z, and
  // the 2:30pm appointment renders back as 7:30am.
  assert.equal(localInputToIso('2026-07-15T14:30'), '2026-07-15T21:30:00.000Z')
})

test('and in winter it is stored as Pacific standard time', () => {
  assert.equal(localInputToIso('2026-01-15T14:30'), '2026-01-15T22:30:00.000Z')
})

test('an appointment round-trips through the form unchanged', () => {
  for (const typed of ['2026-07-15T14:30', '2026-01-15T00:00', '2026-11-01T01:30']) {
    assert.equal(isoToLocalInput(localInputToIso(typed)), typed)
  }
})

test('the hour that does not exist on spring-forward night still produces an instant', () => {
  // 2am–3am is skipped on 8 March 2026 in California. A typed 2:30am has no
  // Pacific instant; settling on the moment the clock jumps to beats throwing
  // on a form the dispatcher cannot fix.
  const iso = localInputToIso('2026-03-08T02:30')
  assert.ok(iso)
  assert.equal(Number.isNaN(new Date(iso as string).getTime()), false)
})

test('an empty box is NULL, because timestamptz refuses the empty string', () => {
  assert.equal(localInputToIso(''), null)
  assert.equal(localInputToIso(null), null)
  assert.equal(localInputToIso('   '), null)
  assert.equal(localInputToIso('not a date'), null)
})

test('isoToLocalInput on nothing is an empty box, not "Invalid Date"', () => {
  assert.equal(isoToLocalInput(null), '')
  assert.equal(isoToLocalInput('wat'), '')
})

// ---------------------------------------------------------------------------
// The detention clock
// ---------------------------------------------------------------------------

const TERMS = {
  free_hours_pickup: 2,
  free_hours_delivery: 1,
  detention_rate_cents: 5000,
  detention_requires_preapproval: true,
}

test('a hook reads the pickup clock and a drop reads the delivery clock', () => {
  // The load stores two numbers for six stop types; this mapping is the whole
  // reason a drop at the consignee is not measured against shipper free time.
  assert.equal(freeHoursFor('pickup', TERMS), 2)
  assert.equal(freeHoursFor('hook', TERMS), 2)
  assert.equal(freeHoursFor('delivery', TERMS), 1)
  assert.equal(freeHoursFor('drop', TERMS), 1)
})

test('fuel and scale stops owe nobody anything', () => {
  assert.equal(freeHoursFor('fuel', TERMS), null)
  assert.equal(freeHoursFor('scale', TERMS), null)
})

test('a stop inside its free time is not detention', () => {
  const clock = stopClock(
    {
      stop_type: 'pickup',
      arrived_at: '2026-07-15T15:00:00Z',
      departed_at: '2026-07-15T16:30:00Z',
    },
    TERMS,
  )
  assert.equal(clock?.minutes, 90)
  assert.equal(clock?.over, false)
  assert.equal(clock?.overMinutes, 0)
  assert.equal(clock?.billableCents, 0)
})

test('a delivery past its one free hour is detention, billed in whole hours', () => {
  const clock = stopClock(
    {
      stop_type: 'delivery',
      arrived_at: '2026-07-15T15:00:00Z',
      departed_at: '2026-07-15T18:24:00Z',
    },
    TERMS,
  )
  assert.equal(clock?.minutes, 204)
  assert.equal(clock?.overMinutes, 144) // 2h24m past the free hour
  // 2.4 hours at $50 invoices as $100. Showing $120 puts a number on screen
  // that the broker will not pay, and the office stops trusting the page.
  assert.equal(clock?.billableCents, 10000)
})

test('unknown free hours is not zero free hours', () => {
  const clock = stopClock(
    {
      stop_type: 'pickup',
      arrived_at: '2026-07-15T15:00:00Z',
      departed_at: '2026-07-15T21:00:00Z',
    },
    { ...TERMS, free_hours_pickup: null },
  )
  assert.equal(clock?.minutes, 360)
  assert.equal(clock?.over, false)
  assert.equal(clock?.freeMinutes, null)
})

test('a fuel stop is never detention however long it took', () => {
  const clock = stopClock(
    { stop_type: 'fuel', arrived_at: '2026-07-15T15:00:00Z', departed_at: '2026-07-15T20:00:00Z' },
    TERMS,
  )
  assert.equal(clock?.over, false)
})

test('a departure before its arrival is flagged, not rendered as detention', () => {
  const clock = stopClock(
    {
      stop_type: 'pickup',
      arrived_at: '2026-07-15T18:00:00Z',
      departed_at: '2026-07-15T15:00:00Z',
    },
    TERMS,
  )
  assert.equal(clock?.backwards, true)
  assert.equal(clock?.over, false)
})

test('no clock at all until both times are recorded', () => {
  const half = {
    stop_type: 'pickup',
    arrived_at: '2026-07-15T15:00:00Z',
    departed_at: null,
  } as const
  assert.equal(stopClock(half, TERMS), null)
  assert.equal(stopClock({ ...half, arrived_at: null }, TERMS), null)
})

test('no rate on file means no dollar figure, not a free one', () => {
  const clock = stopClock(
    {
      stop_type: 'delivery',
      arrived_at: '2026-07-15T15:00:00Z',
      departed_at: '2026-07-15T19:00:00Z',
    },
    { ...TERMS, detention_rate_cents: null },
  )
  assert.equal(clock?.over, true)
  assert.equal(clock?.billableCents, null)
})

test('durations read as hours and minutes', () => {
  assert.equal(formatMinutes(45), '45m')
  assert.equal(formatMinutes(60), '1h')
  assert.equal(formatMinutes(195), '3h 15m')
  assert.equal(formatMinutes(0), '0m')
})
