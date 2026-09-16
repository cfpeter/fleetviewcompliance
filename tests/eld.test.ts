/**
 * Hours of service, and the three-valued answer.
 *
 * The bug every one of these guards is the same: a number on a dispatch screen
 * that is precise, plausible and wrong.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canFinish,
  type HoursResult,
  type HoursSnapshot,
  humanMinutes,
  isStale,
  notConnected,
} from '../src/lib/eld/types.ts'

const snapshot = (over: Partial<HoursSnapshot> = {}): HoursSnapshot => ({
  driverId: 'd1',
  driveMinutesRemaining: 300,
  shiftMinutesRemaining: 420,
  cycleMinutesRemaining: 1800,
  minutesUntilBreak: 120,
  status: 'on_duty_not_driving' as const,
  observedAt: new Date(),
  ...over,
})

const ok = (over: Partial<HoursSnapshot> = {}): HoursResult => ({
  state: 'ok',
  snapshot: snapshot(over),
})

test('no ELD connected is unavailable, not zero hours', async () => {
  // "0 minutes remaining" for a carrier who never connected a device would park
  // a driver who is perfectly legal.
  const r = await notConnected.hoursFor('d1')
  assert.equal(r.state, 'unavailable')
  assert.match(r.state === 'unavailable' ? r.reason : '', /No ELD/)
})

test('a run that fits the smallest clock is a yes', () => {
  const r = canFinish(ok(), 240)
  assert.equal(r.verdict, 'yes')
})

test('the binding constraint is whichever clock runs out first', () => {
  // Reporting only the drive clock is how a dispatcher gets surprised by the
  // 14-hour window.
  const r = canFinish(ok({ driveMinutesRemaining: 600, shiftMinutesRemaining: 90 }), 200)
  assert.equal(r.verdict, 'no')
  assert.match(r.because, /14-hour window/)
})

test('the cycle can be the binding constraint too', () => {
  const r = canFinish(ok({ cycleMinutesRemaining: 45 }), 120)
  assert.equal(r.verdict, 'no')
  assert.match(r.because, /60\/70-hour cycle/)
})

test('we cannot see the hours is UNKNOWN, never yes and never no', () => {
  // Collapsing this into "no" parks a legal driver. Collapsing it into "yes" is
  // the one that ends in a violation. It has to stay its own answer.
  const unavailable = canFinish({ state: 'unavailable', reason: 'not connected' }, 120)
  assert.equal(unavailable.verdict, 'unknown')

  const errored = canFinish({ state: 'error', message: 'timeout' }, 120)
  assert.equal(errored.verdict, 'unknown')
})

test('a stale reading is unknown, not a comfortable number', () => {
  // An ELD that stopped reporting four hours ago is not saying the driver has
  // four hours left. It is saying nothing.
  const old = new Date(Date.now() - 90 * 60_000)
  assert.equal(isStale(snapshot({ observedAt: old })), true)
  const r = canFinish(ok({ observedAt: old }), 60)
  assert.equal(r.verdict, 'unknown')
  assert.match(r.because, /minutes old/)
})

test('a fresh reading is not stale', () => {
  assert.equal(isStale(snapshot({ observedAt: new Date(Date.now() - 60_000) })), false)
})

test('minutes read the way a dispatcher says them', () => {
  assert.equal(humanMinutes(265), '4h 25m')
  assert.equal(humanMinutes(45), '45m')
  assert.equal(humanMinutes(0), 'none')
  assert.equal(humanMinutes(-10), 'none')
})
