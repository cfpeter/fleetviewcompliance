import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mcs150Schedule } from '../src/lib/mcs150.ts'

test('last digit 0 means October, not December', () => {
  const s = mcs150Schedule('21800', new Date(Date.UTC(2026, 0, 1)))
  assert.equal(s.month, 10)
})

test('UPS: DOT 21800 files in even Octobers', () => {
  // last digit 0 -> October; next-to-last 0 -> even -> even years.
  const s = mcs150Schedule('21800', new Date(Date.UTC(2026, 0, 1)))
  assert.equal(s.oddYears, false)
  assert.equal(s.nextDue.toISOString().slice(0, 10), '2026-10-31')
})

test('rolls to the next matching year once the month has passed', () => {
  // Same carrier asked in November 2026: October is gone, next even year is 2028.
  const s = mcs150Schedule('21800', new Date(Date.UTC(2026, 10, 15)))
  assert.equal(s.nextDue.toISOString().slice(0, 10), '2028-10-31')
})

test('odd next-to-last digit files in odd years', () => {
  // ...17 -> next-to-last 1 (odd) -> odd years; last digit 7 -> July.
  const s = mcs150Schedule('1234517', new Date(Date.UTC(2026, 0, 1)))
  assert.equal(s.oddYears, true)
  assert.equal(s.month, 7)
  assert.equal(s.nextDue.toISOString().slice(0, 10), '2027-07-31')
})

test('single-digit DOT number has no next-to-last digit and is treated as even', () => {
  const s = mcs150Schedule('3', new Date(Date.UTC(2026, 0, 1)))
  assert.equal(s.oddYears, false)
  assert.equal(s.nextDue.toISOString().slice(0, 10), '2026-03-31')
})

import { mcs150Status } from '../src/lib/mcs150.ts'

test('a carrier who filed on time is current', () => {
  // DOT 21800 -> even Octobers. Filed Feb 2026, last deadline was Oct 2024.
  const s = mcs150Status('21800', new Date(Date.UTC(2026, 1, 16)), new Date(Date.UTC(2026, 8, 14)))
  assert.equal(s.state, 'current')
})

test('a stale filing is overdue, not "due in two years"', () => {
  // DOT 1000045 -> May, even years. Filed Oct 2021; May 2026 has passed.
  const s = mcs150Status(
    '1000045',
    new Date(Date.UTC(2021, 9, 14)),
    new Date(Date.UTC(2026, 8, 14)),
  )
  assert.equal(s.state, 'overdue')
  assert.equal(s.lastDue.toISOString().slice(0, 10), '2026-05-31')
  assert.equal(s.nextDue.toISOString().slice(0, 10), '2028-05-31')
})

test('no filing date is unknown, never current', () => {
  const s = mcs150Status('21800', null, new Date(Date.UTC(2026, 8, 14)))
  assert.equal(s.state, 'unknown')
})

test('filing exactly on the deadline counts as current', () => {
  const s = mcs150Status(
    '1000045',
    new Date(Date.UTC(2026, 4, 31)),
    new Date(Date.UTC(2026, 8, 14)),
  )
  assert.equal(s.state, 'current')
})
