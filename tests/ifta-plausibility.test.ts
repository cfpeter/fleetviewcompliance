/**
 * The per-receipt sanity check.
 *
 * Found by entering real data: a row reading 1,332 gallons for $787 sat in the
 * list with no comment and dragged the quarter's fleet MPG to 0.48, which would
 * have priced every jurisdiction wrong.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { implausible } from '../src/lib/ifta/input.ts'

test('an ordinary fill says nothing', () => {
  // 125.4 gal at $4.37 — a normal receipt must not be nagged about.
  assert.deepEqual(implausible(125_400, 54_825), [])
})

test('the gallons and cost boxes swapped is caught', () => {
  // The real row that prompted this: 1,332 gallons for $787.
  const flags = implausible(1_332_000, 78_700)
  assert.ok(flags.length > 0)
  assert.ok(flags.some((f) => f.what === 'gallons'))
  assert.match(flags.find((f) => f.what === 'gallons')!.message, /tractor holds/)
})

test('an impossible price per gallon is caught from either direction', () => {
  // Too cheap: gallons far too large.
  assert.ok(implausible(1_000_000, 50_000).some((f) => f.what === 'price'))
  // Too dear: gallons far too small.
  assert.ok(implausible(1_000, 50_000).some((f) => f.what === 'price'))
})

test('a big but possible fill is not flagged', () => {
  // 300 gallons is a large tractor filling both saddle tanks from empty.
  assert.deepEqual(implausible(300_000, 131_100), [])
})

test('no cost recorded means no price check, and no false alarm', () => {
  // The cost box is optional — it is a cross-check, not an input to the return.
  assert.deepEqual(implausible(125_400, null), [])
  assert.deepEqual(implausible(125_400, undefined), [])
})

test('the checks are advisory and never claim the row is invalid', () => {
  // A reefer fill or a yard-tank delivery is real. The row says so; it does not
  // refuse to exist.
  for (const f of implausible(1_332_000, 78_700)) {
    assert.doesNotMatch(f.message, /invalid|error|refus/i)
  }
})
