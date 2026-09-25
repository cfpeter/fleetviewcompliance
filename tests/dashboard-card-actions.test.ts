/**
 * The other three things a "dates we are missing" card can do, and the one
 * thing it now says before he presses any of them.
 *
 *   chase       "you asked him on Tuesday and he never opened it"
 *   remind      "not now — put it on my own list for next week"
 *   retire      "he does not work here any more"
 *   ask all     the same errand for the whole roster, in one press
 *
 * WHAT THESE PIN. Each of the four can be wrong in a way that costs something
 * real: a chase line that says "asked" about a link nobody sent; a reminder
 * that alerts the instant it is written; a retire that reaches for 'terminated'
 * or a delete and takes a medical card with it; a bulk send with no ceiling,
 * which blows a Worker's subrequest budget halfway through and leaves nobody
 * able to say which drivers were texted.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { DateSubject } from '../src/lib/dashboard-dates.ts'
import { REMIND_LATER_DAYS, remindMeFields } from '../src/lib/dashboard-remind.ts'
import { BULK_ASK_CAP, bulkAskLine } from '../src/lib/driver-link/ask-action.ts'
import {
  agoPhrase,
  chaseState,
  daysAgo,
  newestPerDriver,
  type OutstandingLink,
} from '../src/lib/driver-link/outstanding.ts'
import { MAX_NOTE, MAX_TITLE } from '../src/lib/reminders.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const NOW = new Date('2026-09-24T17:00:00Z')
const at = (iso: string) => new Date(iso)

const link = (over: Partial<OutstandingLink> = {}): OutstandingLink => ({
  driverId: 'd1',
  createdAt: at('2026-09-20T09:00:00Z'),
  openedAt: null,
  expiresAt: at('2026-09-27T09:00:00Z'),
  channel: 'sms',
  ...over,
})

// ---------------------------------------------------------------------------
// Chase
// ---------------------------------------------------------------------------

test('"asked" counts whole elapsed days, not midnights crossed', () => {
  // 90 minutes ago, over midnight, is not "1 day ago". Calendar days here read
  // as neglect that has not happened yet, and this line exists to tell him
  // whether to chase.
  assert.equal(daysAgo(at('2026-09-23T23:30:00Z'), at('2026-09-24T01:00:00Z')), 0)
  assert.equal(daysAgo(at('2026-09-23T00:30:00Z'), at('2026-09-24T01:00:00Z')), 1)
  assert.equal(daysAgo(at('2026-09-20T09:00:00Z'), NOW), 4)

  // A clock that has gone backwards — a device with the wrong time, a row
  // written by a server a second ahead — reads as "today", never as negative.
  assert.equal(daysAgo(at('2026-09-25T00:00:00Z'), NOW), 0)

  assert.equal(agoPhrase(0), 'today')
  assert.equal(agoPhrase(1), 'yesterday')
  assert.equal(agoPhrase(4), '4 days ago')
})

test('the four states say four different next moves', () => {
  // Sent, not opened → he may not have seen it. Send it again.
  const quiet = chaseState(link(), NOW)
  assert.equal(quiet.line, 'Asked 4 days ago. Not opened yet.')
  assert.equal(quiet.action, 'Ask again')
  assert.equal(quiet.opened, false)

  // Opened and nothing came back → he saw it. Ringing him is the next move,
  // and the line must not pretend he never got it.
  const seen = chaseState(link({ openedAt: at('2026-09-21T10:00:00Z') }), NOW)
  assert.equal(seen.line, 'Asked 4 days ago. They opened it and sent nothing back.')
  assert.equal(seen.opened, true)

  // NOBODY HAS ASKED HIM. `channel: 'copied'` means there was no number and no
  // email, so nothing left the building. Saying "asked" here is the one lie
  // this line must never tell — the owner would wait on a man who was never
  // contacted.
  const unsent = chaseState(link({ channel: 'copied' }), NOW)
  assert.equal(unsent.line, 'Link made 4 days ago. Nobody has sent it to them yet.')
  assert.equal(unsent.unsent, true)
  assert.equal(unsent.action, 'Make a new link')
  // A row with no channel at all is the same state, not a text.
  assert.equal(chaseState(link({ channel: null }), NOW).unsent, true)

  // Run out → whatever happens next has to mint a NEW link, and the button
  // says so rather than "again".
  const dead = chaseState(link({ expiresAt: at('2026-09-22T09:00:00Z') }), NOW)
  assert.equal(dead.expired, true)
  assert.equal(dead.line, 'The link you sent 4 days ago has run out.')
  assert.equal(dead.action, 'Send a new link')
  // Expiry wins over everything else: an opened, expired link still needs a
  // new one before he can answer it.
  assert.equal(
    chaseState(link({ expiresAt: at('2026-09-22T09:00:00Z'), openedAt: NOW }), NOW).action,
    'Send a new link',
  )

  // The boundary is inclusive: a link expiring exactly now is expired.
  assert.equal(chaseState(link({ expiresAt: NOW }), NOW).expired, true)
})

test('one driver holding two links is described by the newest', () => {
  // `mintDriverLink` only supersedes links asking for the SAME things, so a
  // licence link and a medical link are two live credentials for one man. The
  // card has one line and the newest is the one he is deciding about.
  const newest = newestPerDriver([
    link({ createdAt: at('2026-09-23T09:00:00Z') }),
    link({ createdAt: at('2026-09-18T09:00:00Z') }),
    link({ driverId: 'd2', createdAt: at('2026-09-01T09:00:00Z') }),
  ])
  assert.equal(newest.size, 2)
  assert.equal(newest.get('d1')?.createdAt.toISOString(), '2026-09-23T09:00:00.000Z')
  assert.equal(newest.get('d2')?.driverId, 'd2')
  assert.deepEqual(newestPerDriver([]), new Map())
})

// ---------------------------------------------------------------------------
// Remind me later
// ---------------------------------------------------------------------------

const q = (label: string) => ({ answerKey: label, field: label, label }) as never

const subject = (over: Partial<DateSubject> = {}): DateSubject =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    type: 'driver',
    recordSubject: 'driver',
    group: 'driver',
    label: 'Marco Villanueva',
    noun: 'Driver',
    href: '#',
    questions: [q('Medical certificate expires'), q('Licence expires')],
    asked: [],
    onlyIfItApplies: [],
    questionCount: 2,
    rowCount: 5,
    ...over,
  }) as DateSubject

test('the reminder lands a week out and alerts on the day, not the moment it is written', () => {
  const r = remindMeFields(subject(), new Date('2026-09-24T00:00:00Z'))
  assert.equal(r.due_on, '2026-10-01')
  assert.equal(REMIND_LATER_DAYS, 7)
  // A seven-day lead on a seven-day reminder alerts immediately, which is the
  // exact opposite of "remind me later".
  assert.equal(r.lead_days, 0)
  // Once. A repeating chase outlives the date he may type tomorrow and then
  // has to be hunted down and closed.
  assert.equal(r.repeat_months, 0)
})

test('the reminder names the subject, the errand and the dates that were missing', () => {
  const driver = remindMeFields(subject(), NOW)
  assert.equal(driver.title, 'Chase Marco Villanueva for 2 missing dates')
  assert.equal(driver.driver_id, '11111111-1111-4111-8111-111111111111')
  assert.equal(driver.vehicle_id, null)
  // A week later "Chase Marco" is not a task — chase him for what?
  assert.match(driver.note, /Medical certificate expires/)
  assert.match(driver.note, /Licence expires/)

  // Singular reads as English, because one missing date is the common case.
  const one = remindMeFields(subject({ questions: [q('Medical')], questionCount: 1 }), NOW)
  assert.match(one.title, /for 1 missing date$/)

  // A truck hangs off vehicle_id, and the words change with it: nobody
  // "chases" a trailer.
  const truck = remindMeFields(
    subject({ type: 'power_unit', recordSubject: 'vehicle', label: 'Unit 14', noun: 'Power unit' }),
    NOW,
  )
  assert.equal(truck.title, 'Get 2 missing dates for Unit 14')
  assert.equal(truck.driver_id, null)
  assert.equal(truck.vehicle_id, '11111111-1111-4111-8111-111111111111')

  // The carrier record belongs to neither column.
  const co = remindMeFields(subject({ type: 'carrier', recordSubject: 'carrier' }), NOW)
  assert.equal(co.driver_id, null)
  assert.equal(co.vehicle_id, null)
  assert.match(co.title, /company record/)
})

test('a very long name cannot break the insert on the column it is stored in', () => {
  // 0023 caps the title at 120 and the note at 2000. A driver with a long legal
  // name, or a subject with forty questions, must come back inside both — a
  // constraint violation here reads to the owner as "we could not save that"
  // for a reason he cannot see or fix.
  const long = remindMeFields(
    subject({
      label: 'X'.repeat(400),
      questions: Array.from({ length: 60 }, (_, i) => q(`Some quite long date label number ${i}`)),
      questionCount: 60,
    }),
    NOW,
  )
  assert.ok(long.title.length <= MAX_TITLE, `title ${long.title.length}`)
  assert.ok(long.note.length <= MAX_NOTE, `note ${long.note.length}`)
  assert.match(long.title, /…$/, 'a cut title says it was cut')
})

// ---------------------------------------------------------------------------
// Ask everyone
// ---------------------------------------------------------------------------

test('the bulk send has a ceiling, and says so rather than dropping the rest', () => {
  const src = read('../src/lib/driver-link/ask-action.ts')
  assert.ok(BULK_ASK_CAP > 0 && BULK_ASK_CAP <= 25)
  assert.match(src, /const reach = args\.targets\.slice\(0, BULK_ASK_CAP\)/)
  assert.match(src, /out\.overCap = args\.targets\.length - reach\.length/)

  // ONE DRIVER'S FAILURE MUST NOT TAKE THE OTHER NINETEEN. The links are
  // already minted by then; an error page would leave the owner believing
  // none of it happened while his drivers' phones buzz.
  assert.match(src, /} catch \{\s*return \{ ok: false as const, message: 'threw' \}/)

  assert.match(
    bulkAskLine({ sms: 0, email: 0, none: 0, failed: 0, refused: 0, overCap: 3 }),
    /3 left over/,
  )
})

test('the bulk receipt counts every outcome and invents none', () => {
  assert.equal(
    bulkAskLine({ sms: 4, email: 1, none: 0, failed: 0, refused: 0, overCap: 0 }),
    'Sent 4 by text and 1 by email.',
  )
  assert.equal(
    bulkAskLine({ sms: 3, email: 0, none: 0, failed: 0, refused: 0, overCap: 0 }),
    'Sent 3 by text.',
  )

  // The ones that did NOT go are the half that matters, and each says what to
  // do about it.
  const mixed = bulkAskLine({ sms: 2, email: 0, none: 2, failed: 1, refused: 0, overCap: 0 })
  assert.match(mixed, /Sent 2 by text\./)
  assert.match(mixed, /2 have no number and no email/)
  assert.match(mixed, /1 could not be sent just now\. The links are made and still good\./)

  // Singular, because "1 have no number" is how a screen loses its reader.
  assert.match(
    bulkAskLine({ sms: 0, email: 0, none: 1, failed: 0, refused: 0, overCap: 0 }),
    /1 has no number/,
  )

  // Nothing at all is a sentence, not an empty box.
  assert.equal(
    bulkAskLine({ sms: 0, email: 0, none: 0, failed: 0, refused: 0, overCap: 0 }),
    'Nobody needed asking.',
  )
})

test('the bulk button and the bulk handler count the same drivers', () => {
  const page = read('../src/pages/app/index.astro')
  // One function, used by the button's number and by the send. If they drift,
  // the counts he reads back are about a different list than the one he saw.
  assert.match(page, /const askTargetsFor = \(subjects: readonly ActionSubject\[\]\)/)
  assert.match(page, /const targets = askTargetsFor\(\[\.\.\.actionIndex\.values\(\)\]\)/)
  assert.match(page, /const bulkTargets = askTargetsFor\(\[\.\.\.actionIndex\.values\(\)\]\)/)
  assert.match(page, /Ask all \$\{bulkTargets\.length\}/)

  // ONE IS ENOUGH. It used to need two, on the reasoning that with one driver
  // the bar duplicates his own card button. That was wrong about the screen it
  // lands on: on a real roster most drivers have nothing askable — measured on
  // dev, no carrier had two — so the bar never appeared, and the fastest way to
  // ask the one driver who CAN be asked was to find his card among the ones
  // that cannot.
  assert.match(page, /bulkTargets\.length > 0/)
  assert.doesNotMatch(page, /bulkTargets\.length > 1/)

  // And the words follow the number, because "Ask all 1 of them at once" is
  // how a screen tells its reader it was written by nobody.
  assert.match(page, /bulkTargets\.length === 1 \? 'Ask them' :/)
  assert.match(page, /One of them can send their own dates in/)

  // Six small integers, no names, no addresses.
  assert.match(
    page,
    /&bulk=\$\{result\.sms\}\.\$\{result\.email\}\.\$\{result\.none\}\.\$\{result\.failed\}/,
  )
  assert.match(
    page,
    /n\.length !== 6 \|\| n\.some\(\(x\) => !Number\.isInteger\(x\) \|\| x < 0 \|\| x > 9999\)/,
  )
})

// ---------------------------------------------------------------------------
// He does not work here any more
// ---------------------------------------------------------------------------

test('retiring a driver is reversible, and is never a delete', () => {
  const page = read('../src/pages/app/index.astro')

  // INACTIVE ONLY. 'terminated' is a statement about how the employment ended
  // and is not a dashboard card's to make; a delete would take his medical
  // card and his MVR with him, which is what 0028 exists to refuse.
  assert.match(page, /\.update\(\{ status: 'inactive' \}\)/)
  assert.doesNotMatch(page, /status: 'terminated'/)
  assert.doesNotMatch(page, /from\('drivers'\)\s*\n?\s*\.delete\(\)/)

  // Only a driver who is currently active, so a second press in another tab
  // cannot report a cheerful receipt for something it did not do.
  assert.match(page, /\.eq\('status', ACTIVE_DRIVER_STATUS\)/)
  assert.match(page, /if \(!data \|\| data\.length === 0\) return to\(here\(''\)\)/)

  // The way back is IN THE RECEIPT. Taking a man off the board with no visible
  // undo is how somebody loses a driver inside the app.
  assert.match(page, /href=\{`\/app\/drivers\/\$\{retiredId\}`\}/)
  assert.match(page, /to put them back to Active/)

  // And the menu item says the consequence before he presses it.
  const menu = read('../src/components/DateSubjectActions.astro')
  assert.match(menu, /stops their reminders/)
  assert.match(menu, /records stay on file/)
})

test('the card says he was already asked without being opened', () => {
  const menu = read('../src/components/DateSubjectActions.astro')
  // On the CARD, not behind the menu: an owner who cannot see it asks the same
  // man twice.
  assert.match(
    menu,
    /\{chase && <span class="mt-1 block text-xs text-brand-700">\{chase\.line\}<\/span>\}/,
  )
  // And the button changes its verb with the state.
  assert.match(menu, /const askLabel = chase\s*\?\s*chase\.action/)

  const page = read('../src/pages/app/index.astro')
  // Answered links are finished; expired ones are kept, because an expired
  // link is exactly the thing worth telling him about.
  assert.match(page, /\.is\('used_at', null\)/)
  assert.match(page, /\.is\('revoked_at', null\)/)
  assert.doesNotMatch(page, /\.gt\('expires_at'/)
})
