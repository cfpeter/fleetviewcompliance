/**
 * The guard is the only thing standing between a test run and forty carriers
 * getting a 6am text about a deadline they do not have, so it is tested harder
 * than its size suggests.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dedupKey,
  guard,
  minutesOfDayInZone,
  parseClockTime,
  withinQuietHours,
} from '../src/lib/notify/guard.ts'

const email = { channel: 'email' as const, to: 'owner@carrier.example', body: 'x' }
const sms = { channel: 'sms' as const, to: '+13105550101', body: 'x' }

test('production sends to the real recipient', () => {
  const v = guard(email, { mode: 'production' })
  assert.equal(v.allow, true)
  assert.equal(v.allow && v.to, 'owner@carrier.example')
})

test('outside production everything is redirected', () => {
  const v = guard(email, { mode: 'development', redirectEmail: 'dev@local.test' })
  assert.equal(v.allow, true)
  assert.equal(v.allow && v.to, 'dev@local.test')
  assert.match(String(v.allow && v.note), /owner@carrier\.example/)
})

test('an unconfigured non-production environment REFUSES rather than passing through', () => {
  // The whole point. A missing redirect means somebody has not finished
  // configuring this, and the safe reading of that is "send nothing" — never
  // "send it to the customer".
  const v = guard(email, { mode: 'development' })
  assert.equal(v.allow, false)
  assert.match(String(!v.allow && v.reason), /refusing to send/)
})

test('an undefined mode is treated as not-production', () => {
  // The dangerous default would be the other way round: a missing NODE_ENV
  // silently behaving like production.
  assert.equal(guard(email, { mode: undefined }).allow, false)
})

test('sms and email redirects are separate', () => {
  // Configuring only the email redirect must not let texts through.
  const config = { mode: 'development', redirectEmail: 'dev@local.test' }
  assert.equal(guard(email, config).allow, true)
  assert.equal(guard(sms, config).allow, false)
})

test('an empty destination is refused in every mode', () => {
  assert.equal(guard({ ...email, to: '' }, { mode: 'production' }).allow, false)
  assert.equal(guard({ ...email, to: '   ' }, { mode: 'production' }).allow, false)
})

// ---------------------------------------------------------------- dedup

test('the same warning cannot be sent twice', () => {
  const p = {
    userId: 'u1',
    ruleCode: 'r',
    subjectId: 'd1',
    dueOn: '2026-11-01',
    leadDays: 30,
    channel: 'email' as const,
  }
  assert.equal(dedupKey(p), dedupKey({ ...p }))
})

test('different lead windows are different messages', () => {
  const p = {
    userId: 'u1',
    ruleCode: 'r',
    subjectId: 'd1',
    dueOn: '2026-11-01',
    leadDays: 30,
    channel: 'email' as const,
  }
  assert.notEqual(dedupKey(p), dedupKey({ ...p, leadDays: 7 }))
})

test('next cycle sends again', () => {
  // The due date is in the key precisely so that an annual obligation warns
  // again next year rather than being deduped against last year's message.
  const p = {
    userId: 'u1',
    ruleCode: 'r',
    subjectId: 'd1',
    dueOn: '2026-11-01',
    leadDays: 30,
    channel: 'email' as const,
  }
  assert.notEqual(dedupKey(p), dedupKey({ ...p, dueOn: '2027-11-01' }))
})

test('two drivers with the same deadline are two messages', () => {
  const p = {
    userId: 'u1',
    ruleCode: 'r',
    subjectId: 'd1',
    dueOn: '2026-11-01',
    leadDays: 30,
    channel: 'email' as const,
  }
  assert.notEqual(dedupKey(p), dedupKey({ ...p, subjectId: 'd2' }))
})

// ---------------------------------------------------------------- quiet hours

test('a quiet window that wraps midnight is the normal case', () => {
  const from = 22 * 60 // 22:00
  const to = 7 * 60 // 07:00
  assert.equal(withinQuietHours(23 * 60, from, to), true, '23:00 is quiet')
  assert.equal(withinQuietHours(2 * 60, from, to), true, '02:00 is quiet')
  assert.equal(withinQuietHours(9 * 60, from, to), false, '09:00 is not')
  assert.equal(withinQuietHours(7 * 60, from, to), false, '07:00 exactly is the end')
})

test('a same-day quiet window works too', () => {
  const from = 13 * 60
  const to = 14 * 60
  assert.equal(withinQuietHours(13 * 60 + 30, from, to), true)
  assert.equal(withinQuietHours(12 * 60, from, to), false)
})

test('no quiet hours set means never quiet', () => {
  assert.equal(withinQuietHours(3 * 60, null, null), false)
})

// ------------------------------------------------- reading the stored time

test('both shapes of a stored time parse to the same minute', () => {
  // Postgres `time` comes back as 'HH:MM:SS'; the settings page's
  // <input type="time"> round-trips it as 'HH:MM'. If the two parsed
  // differently, a quiet window would mean two different things depending on
  // which side of a save it was read from.
  assert.equal(parseClockTime('22:00:00'), 22 * 60)
  assert.equal(parseClockTime('22:00'), 22 * 60)
  assert.equal(parseClockTime('07:15:00'), 7 * 60 + 15)
  assert.equal(parseClockTime('00:00:00'), 0, 'midnight is 0, not falsy-absent')
})

test('an unset or unreadable time means NO quiet hours, which means send', () => {
  // The safe direction. A value we cannot read must not be allowed to silence
  // somebody's alerts — withinQuietHours treats null as "not quiet".
  for (const junk of [null, undefined, '', 'evening', '9pm', '25:00:00', '07:99']) {
    assert.equal(parseClockTime(junk), null, String(junk))
  }
  assert.equal(withinQuietHours(3 * 60, parseClockTime(null), parseClockTime('07:00')), false)
})

test("24:00:00 is the only way to say 'quiet until midnight' and it is honoured", () => {
  // Postgres accepts it in a `time` column, so a hand-written row can hold it.
  assert.equal(parseClockTime('24:00:00'), 24 * 60)
  assert.equal(withinQuietHours(23 * 60, 22 * 60, 24 * 60), true)
  assert.equal(withinQuietHours(21 * 60, 22 * 60, 24 * 60), false)
})

// ------------------------------------------------- the recipient's own clock

test("the recipient's local time is read from their zone, not the server's", () => {
  // 2026-07-15T08:30:00Z is 01:30 in Los Angeles (PDT), 09:30 in London (BST)
  // and 08:30 in UTC. Quiet hours are a statement about the hour where the
  // person is standing — "do not wake me before 7" is meaningless measured on
  // whichever clock the job's host happens to be keeping.
  const at = new Date('2026-07-15T08:30:00Z')
  assert.equal(minutesOfDayInZone(at, 'America/Los_Angeles'), 1 * 60 + 30)
  assert.equal(minutesOfDayInZone(at, 'Europe/London'), 9 * 60 + 30)
  assert.equal(minutesOfDayInZone(at, 'UTC'), 8 * 60 + 30)
})

test('daylight saving is followed, because Intl knows and a stored offset would not', () => {
  // Phoenix does not observe it and Los Angeles does. At the same instant the
  // two are an hour apart in January and identical in July — so a quiet window
  // stored as an offset rather than a zone would be an hour wrong for half the
  // year. Both zones are in the list the settings page offers.
  const january = new Date('2026-01-15T16:00:00Z')
  const july = new Date('2026-07-15T16:00:00Z')
  assert.equal(minutesOfDayInZone(january, 'America/Phoenix'), 9 * 60)
  assert.equal(minutesOfDayInZone(january, 'America/Los_Angeles'), 8 * 60)
  assert.equal(minutesOfDayInZone(july, 'America/Phoenix'), 9 * 60)
  assert.equal(minutesOfDayInZone(july, 'America/Los_Angeles'), 9 * 60)
})

test('midnight is zero minutes, never 1440', () => {
  // `hour12: false` renders midnight as '24' in some ICU versions. Un-modded
  // that makes 00:30 read as 1470 — past the end of the day — and a
  // 22:00-to-07:00 window stops covering the exact hours it exists for.
  const midnightUtc = new Date('2026-06-01T00:00:00Z')
  assert.equal(minutesOfDayInZone(midnightUtc, 'UTC'), 0)
  assert.equal(minutesOfDayInZone(new Date('2026-06-01T00:30:00Z'), 'UTC'), 30)
  assert.equal(
    withinQuietHours(minutesOfDayInZone(midnightUtc, 'UTC') ?? -1, 22 * 60, 7 * 60),
    true,
  )
})

test('a zone we cannot resolve returns null, which the caller reads as SEND', () => {
  // 'Pacific' and 'Pacific Standard Time' are both things people type into a
  // timezone field, and Intl throws RangeError on them. A profile holding junk
  // must not become a person who is never told anything.
  for (const junk of ['Pacific', 'Pacific Standard Time', 'Not/AZone', '']) {
    assert.equal(minutesOfDayInZone(new Date(), junk), null, junk)
  }
})

test('a legacy abbreviation RESOLVES, and that is worse than it failing', () => {
  // Discovered writing this file, and it is the reason the settings page gates
  // what may be stored rather than trusting Intl to reject nonsense.
  //
  // ICU accepts the old three-letter zones. 'PST' resolves to a zone that DOES
  // follow US daylight saving, so it is harmless — but 'EST' resolves to a FIXED
  // UTC-5 zone that does NOT, so a profile holding 'EST' is an hour off for the
  // eight months of the year New York is on EDT. Nothing throws, nothing logs,
  // and quiet hours silently cover the wrong hour. `isKnownTimezone` is what
  // keeps either string out of the column in the first place.
  const summer = new Date('2026-07-15T08:30:00Z')
  assert.equal(minutesOfDayInZone(summer, 'PST'), 1 * 60 + 30, 'PST tracks DST')
  assert.equal(minutesOfDayInZone(summer, 'America/New_York'), 4 * 60 + 30, 'EDT, UTC-4')
  assert.equal(minutesOfDayInZone(summer, 'EST'), 3 * 60 + 30, 'fixed UTC-5, an hour out')
})
