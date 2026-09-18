/**
 * What the manual-review queue says, and what it must never say.
 *
 * The operator opens this screen to answer one question — what needs me today —
 * so the failures that matter are the ones that answer it wrongly: an open
 * request filed with the finished ones, a green badge on work nobody has done,
 * a countdown that runs the wrong way, or a date shifted by a timezone so a
 * request made at six in the evening reads as tomorrow's.
 *
 * Pure, and therefore no database: the page reads the rows, this decides what
 * they mean.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  askedPhrase,
  buildQueue,
  closesPhrase,
  countBucket,
  filterQueue,
  MANUAL_DAYS,
  type ManualClaimRow,
  onDate,
  parseShow,
  queueBadge,
  toQueueItem,
} from '../src/lib/admin/claims-queue.ts'

const NOW = new Date('2026-09-17T18:00:00Z')
const USER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const emails = new Map<string, string | null>([[USER, 'owner@sunvalleytrucking.com']])

function row(over: Partial<ManualClaimRow> = {}): ManualClaimRow {
  return {
    id: 'claim-1',
    dot_number: '1234567',
    user_id: USER,
    note: 'We have had this number since 1994. The phone on the file is disconnected.',
    created_at: '2026-09-14T10:00:00Z',
    expires_at: '2026-10-14T10:00:00Z',
    verified_at: null,
    voided_at: null,
    ...over,
  }
}

test('an open request is waiting, in words and not in letters', () => {
  const item = toQueueItem(row(), emails, NOW)

  assert.equal(item.bucket, 'waiting')
  assert.equal(item.email, 'owner@sunvalleytrucking.com')
  assert.equal(item.badge.label, 'Waiting')
  assert.equal(item.badge.className, 'badge badge-warning')

  // "3 days ago", never "3d". And the absolute date beside it, so the reader
  // never has to hold a countdown in his head to know when it came in.
  assert.equal(item.daysWaiting, 3)
  assert.equal(item.askedLine, 'Sep 14, 2026 · asked 3 days ago')
  assert.equal(item.closesLine, 'Oct 14, 2026 · closes in 26 days')
})

test('the dates are the carrier day, not UTC', () => {
  // 6pm Pacific on the 16th is already the 17th in UTC. Rendered in UTC this
  // row would say a request arrived the day after it did, and a thirty-day
  // deadline would look a day further off than it is.
  assert.equal(onDate('2026-09-17T01:30:00Z'), 'Sep 16, 2026')
  assert.equal(onDate(null), 'no date')
  assert.equal(onDate('not a date'), 'no date')
})

test('a request close to running out says act now, in red', () => {
  const item = toQueueItem(row({ expires_at: '2026-09-22T10:00:00Z' }), emails, NOW)
  assert.equal(item.bucket, 'waiting')
  assert.equal(item.daysLeft, 4)
  assert.equal(item.badge.label, 'Closes soon')
  assert.equal(item.badge.className, 'badge badge-danger')
  assert.equal(item.closesLine, 'Sep 22, 2026 · closes in 4 days')
})

test('a request nobody answered is separated from the ones still waiting', () => {
  const item = toQueueItem(row({ expires_at: '2026-09-15T10:00:00Z' }), emails, NOW)
  assert.equal(item.bucket, 'expired')
  assert.equal(item.badge.label, 'Ran out')
  assert.equal(item.badge.className, 'badge badge-neutral')
  // Two days and eight hours gone is "2 days ago". Rounding away from now would
  // print three, and a queue that overstates its own numbers is one the
  // operator stops believing.
  assert.equal(item.closesLine, 'Sep 15, 2026 · closed 2 days ago')
})

test('a deadline that went hours ago does not say it is still open', () => {
  // The half-day case: twelve hours past truncates to zero days, and zero has
  // no sign to read. The row must not print "closes today" beside a badge
  // saying it ran out.
  const item = toQueueItem(row({ expires_at: '2026-09-17T06:00:00Z' }), emails, NOW)
  assert.equal(item.bucket, 'expired')
  assert.equal(item.daysLeft, 0)
  assert.equal(item.closesLine, 'Sep 16, 2026 · closed today')
})

test('a request resolved by hand reads as resolved, even on its last day', () => {
  // verified_at and voided_at are checked before the clock. Neither is ever set
  // by the database for a manual claim — complete_carrier_claim and
  // void_carrier_claim both exclude the channel — so a value there means a
  // person did something, which is exactly the thing worth showing.
  const given = toQueueItem(
    row({ expires_at: '2026-09-15T10:00:00Z', verified_at: '2026-09-15T09:00:00Z' }),
    emails,
    NOW,
  )
  assert.equal(given.bucket, 'finished')
  assert.equal(given.badge.label, 'Given')
  assert.equal(given.badge.className, 'badge badge-success')

  const closed = toQueueItem(row({ voided_at: '2026-09-16T09:00:00Z' }), emails, NOW)
  assert.equal(closed.bucket, 'finished')
  assert.equal(closed.badge.label, 'Closed')
  assert.equal(closed.badge.className, 'badge badge-neutral')
})

test('nothing that still needs a person is ever green', () => {
  // Green means done. A waiting request is not on track — it is work nobody has
  // done yet, and a green badge on it is the screen telling the operator to
  // look away.
  for (const daysLeft of [-40, -1, 0, 1, 7, 8, 30]) {
    for (const bucket of ['waiting', 'expired'] as const) {
      const badge = queueBadge(bucket, daysLeft, false)
      assert.doesNotMatch(
        badge.className,
        /badge-success/,
        `${bucket} at ${daysLeft} days was green`,
      )
      assert.ok(badge.label.length > 0, 'a badge with no word leaves the colour saying it alone')
    }
  }
})

test('the words around the deadline read in the right tense', () => {
  assert.equal(askedPhrase(0), 'asked today')
  assert.equal(askedPhrase(1), 'asked yesterday')
  assert.equal(askedPhrase(9), 'asked 9 days ago')

  assert.equal(closesPhrase(MANUAL_DAYS), `closes in ${MANUAL_DAYS} days`)
  assert.equal(closesPhrase(2), 'closes in 2 days')
  assert.equal(closesPhrase(1), 'closes tomorrow')
  assert.equal(closesPhrase(0), 'closes today')
  assert.equal(closesPhrase(-1), 'closed yesterday')
  assert.equal(closesPhrase(-6), 'closed 6 days ago')

  // Never an abbreviation, anywhere in this vocabulary.
  for (const days of [-30, -1, 0, 1, 30]) {
    assert.doesNotMatch(closesPhrase(days), /\d+\s*d\b/)
    assert.doesNotMatch(askedPhrase(Math.abs(days)), /\d+\s*d\b/)
  }
})

test('an account with no address is shown, not hidden', () => {
  // The row that needs the most work, not the least: nobody can write back to
  // it. Grey is never a reason to drop something off the screen.
  const item = toQueueItem(row({ user_id: 'nobody' }), new Map(), NOW)
  assert.equal(item.email, null)
  assert.equal(item.bucket, 'waiting')
})

test('an empty note is nothing rather than a blank', () => {
  assert.equal(toQueueItem(row({ note: '   \n ' }), emails, NOW).note, null)
  assert.equal(toQueueItem(row({ note: null }), emails, NOW).note, null)
  assert.equal(toQueueItem(row({ note: '  it is ours  ' }), emails, NOW).note, 'it is ours')
})

test('the queue is newest first and counts each bucket once', () => {
  const rows = [
    row({ id: 'old', created_at: '2026-09-01T10:00:00Z', expires_at: '2026-10-01T10:00:00Z' }),
    row({ id: 'newest', created_at: '2026-09-16T10:00:00Z', expires_at: '2026-10-16T10:00:00Z' }),
    row({ id: 'ran-out', created_at: '2026-08-01T10:00:00Z', expires_at: '2026-08-31T10:00:00Z' }),
    row({ id: 'done', created_at: '2026-09-10T10:00:00Z', verified_at: '2026-09-11T10:00:00Z' }),
  ]
  const items = buildQueue(rows, emails, NOW)

  assert.deepEqual(
    items.map((i) => i.id),
    ['newest', 'done', 'old', 'ran-out'],
  )
  assert.equal(countBucket(items, 'waiting'), 2)
  assert.equal(countBucket(items, 'expired'), 1)
  assert.equal(countBucket(items, 'finished'), 1)

  assert.deepEqual(
    filterQueue(items, 'waiting').map((i) => i.id),
    ['newest', 'old'],
  )
  assert.equal(filterQueue(items, 'all').length, 4)
})

test('a stray filter parameter cannot hide rows from an operator', () => {
  // Anything unrecognised lands on the default view rather than on an empty
  // one, so a mistyped link never reads as "nothing is waiting".
  assert.equal(parseShow(null), 'waiting')
  assert.equal(parseShow(''), 'waiting')
  assert.equal(parseShow('nonsense'), 'waiting')
  assert.equal(parseShow('WAITING'), 'waiting')
  assert.equal(parseShow(' expired '), 'expired')
  assert.equal(parseShow('finished'), 'finished')
  assert.equal(parseShow('all'), 'all')
})
