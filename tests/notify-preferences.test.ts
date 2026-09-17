import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  DEFAULT_LEAD_DAYS,
  describeLeadDays,
  formatLeadDays,
  isKnownTimezone,
  MAX_LEAD_DAY,
  MAX_LEAD_WINDOWS,
  parseLeadDays,
  timeForInput,
  timezoneOptions,
} from '../src/lib/notify/preferences.ts'

// ---------------------------------------------------------------- the happy path

test('the documented shape survives a round trip unchanged', () => {
  assert.deepEqual(parseLeadDays('30, 7, 1, -1'), [30, 7, 1, -1])
  assert.equal(formatLeadDays(parseLeadDays('30, 7, 1, -1')), '30, 7, 1, -1')
})

test('whatever the separator, the same four numbers come out', () => {
  // Spreadsheets paste semicolons, phones paste spaces, and the label says
  // "days" so people type the word.
  for (const typed of ['30 7 1 -1', '30;7;1;-1', '30 days, 7 days, 1 day, -1 day', '30/7/1/-1']) {
    assert.deepEqual(parseLeadDays(typed), [30, 7, 1, -1], typed)
  }
})

// ---------------------------------------------------------------- the empty box

test('an empty box falls back to the default rather than saving []', () => {
  // An empty array means "warn me never". Nobody means that, and it fails
  // silently forever: the row still exists, still says enabled, and sends
  // nothing until somebody notices a deadline went past unannounced.
  assert.deepEqual(parseLeadDays(''), [...DEFAULT_LEAD_DAYS])
  assert.deepEqual(parseLeadDays('   '), [...DEFAULT_LEAD_DAYS])
  assert.deepEqual(parseLeadDays(',,, ; ,'), [...DEFAULT_LEAD_DAYS])
  assert.deepEqual(parseLeadDays('days'), [...DEFAULT_LEAD_DAYS], 'units with no number is junk')
})

test('a missing or non-string field is the same as an empty one', () => {
  // FormData.get() returns null for a field that was never posted, and a File
  // for a renamed input. Neither may throw on a settings save.
  assert.deepEqual(parseLeadDays(null), [...DEFAULT_LEAD_DAYS])
  assert.deepEqual(parseLeadDays(undefined), [...DEFAULT_LEAD_DAYS])
  assert.deepEqual(parseLeadDays(42), [...DEFAULT_LEAD_DAYS])
})

// ---------------------------------------------------------------- the sign

test('a pasted en dash still means AFTER it lapsed', () => {
  // The dangerous one. A naive parse reads "–1" as +1 and silently turns
  // "tell me again the day after it lapsed" into "tell me the day before it is
  // due" — the opposite instruction, with nothing on screen to show it.
  assert.deepEqual(parseLeadDays('30, 7, –1'), [30, 7, -1])
  assert.deepEqual(parseLeadDays('−5'), [-5], 'the real minus sign U+2212')
  assert.deepEqual(parseLeadDays('－3'), [-3], 'the fullwidth hyphen')
})

test('negative zero is stored as zero', () => {
  // -0 reaches an int[] literal as "-0" and compares unequal to "0" to anything
  // matching them as text.
  assert.deepEqual(parseLeadDays('-0'), [0])
  assert.ok(!Object.is(parseLeadDays('-0')[0], -0))
})

test('zero is a real window and is kept', () => {
  // "tell me on the day it is due" is a legitimate instruction, and dropping it
  // as falsy would lose it.
  assert.deepEqual(parseLeadDays('7, 0'), [7, 0])
})

// ---------------------------------------------------------------- junk

test('one chunk yields at most one number', () => {
  // Scanning the whole string for runs of digits would read "1.5" as TWO
  // windows, 1 and 5 — an alert nobody typed, arriving on a day nobody chose.
  assert.deepEqual(parseLeadDays('1.5'), [1])
  assert.deepEqual(parseLeadDays('30d'), [30])
})

test('duplicates collapse', () => {
  // "7, 7" is one window. Two rows at the same distance would be two messages
  // on the same morning saying the same thing, which is how we get muted.
  assert.deepEqual(parseLeadDays('7, 7, 7'), [7])
  assert.deepEqual(parseLeadDays('30, 7, 30'), [30, 7])
})

test('the list always comes back largest first', () => {
  // The column comment specifies that order, so a row read straight out of the
  // database reads the same way as one just saved.
  assert.deepEqual(parseLeadDays('-1, 1, 7, 30'), [30, 7, 1, -1])
})

// ---------------------------------------------------------------- bounds

test('a window further out than a year is dropped', () => {
  // A lead time longer than the obligation's own cycle is permanently reached:
  // `reachedWindow` fires as soon as daysUntil <= lead, so a 400-day window on
  // an annual item alerts the morning it is renewed, and every day after.
  assert.deepEqual(parseLeadDays('400, 30'), [30])
  assert.deepEqual(parseLeadDays(`${MAX_LEAD_DAY}`), [MAX_LEAD_DAY], 'exactly a year is allowed')
  assert.deepEqual(parseLeadDays(`${-MAX_LEAD_DAY - 1}`), [...DEFAULT_LEAD_DAYS])
})

test('a pasted spreadsheet column cannot become forty windows', () => {
  const typed = Array.from({ length: 40 }, (_, i) => String(i + 1)).join(', ')
  const parsed = parseLeadDays(typed)
  assert.equal(parsed.length, MAX_LEAD_WINDOWS)
  // The ten kept are the most URGENT ten. The windows worth losing are the
  // distant ones — dropping the day-of and day-after warnings would throw away
  // the only ones that arrive while the thing is actually costing money.
  assert.deepEqual(parsed, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
})

test('the cap keeps the negative windows', () => {
  const typed = [300, 200, 180, 120, 90, 60, 45, 30, 14, 7, 1, -1, -7].join(', ')
  const parsed = parseLeadDays(typed)
  assert.ok(parsed.includes(-1), 'the nudge after it lapses must survive the cap')
  assert.ok(parsed.includes(-7))
})

// ---------------------------------------------------------------- the sentence

test('the array is rendered back as a sentence a person can check', () => {
  // "[30, 7, 1, -1]" is not something an office manager can proofread, and a
  // negative number in a list of days is the most confusing thing on the page.
  assert.equal(
    describeLeadDays([30, 7, 1, -1]),
    '30 days, 7 days and 1 day before it is due, then 1 day after it has lapsed',
  )
  assert.equal(describeLeadDays([7]), '7 days before it is due')
  assert.equal(describeLeadDays([0]), 'on the day itself')
  assert.equal(describeLeadDays([-1]), '1 day after it has lapsed')
  assert.equal(describeLeadDays([]), 'never')
})

test('formatting an empty array shows the default, never a blank box', () => {
  // A blank box invites somebody to save it, and saving it means "never".
  assert.equal(formatLeadDays([]), '30, 7, 1, -1')
  assert.equal(formatLeadDays(null), '30, 7, 1, -1')
})

// ---------------------------------------------------------------- timezone

test('a stored zone we do not offer is kept, not silently reset', () => {
  // Rendering the select without it would show the first option as selected,
  // and the next save would write that — moving somebody's morning by three
  // hours because they opened a page.
  const opts = timezoneOptions('America/Juneau')
  assert.equal(opts[0].value, 'America/Juneau')
  assert.ok(isKnownTimezone('America/Juneau', 'America/Juneau'))
  assert.ok(!isKnownTimezone('America/Juneau', 'America/Los_Angeles'))
  assert.ok(!isKnownTimezone('PST', null), 'a free-text zone Intl cannot resolve is refused')
  assert.ok(isKnownTimezone('America/Los_Angeles', null))
})

test('a known zone is not duplicated in the list', () => {
  const opts = timezoneOptions('America/Denver')
  assert.equal(opts.filter((o) => o.value === 'America/Denver').length, 1)
})

// ---------------------------------------------------------------- quiet times

test('a time column is trimmed to what a time input round-trips', () => {
  // Postgres hands back 'HH:MM:SS'; the input posts 'HH:MM'. Comparing the two
  // reports a change on every save.
  assert.equal(timeForInput('22:00:00'), '22:00')
  assert.equal(timeForInput(null), '')
  assert.equal(timeForInput(''), '')
})

// ---------------------------------------------------------------- the digest column

/**
 * The one way the digest column can go wrong, pinned against the page itself.
 *
 * "Roll into one daily message" shipped as a live checkbox over a column the
 * digest job reads nowhere — a control that accepted input and changed nothing,
 * which teaches an owner that this whole screen is decorative. The fix disables
 * it, the way the SMS box is disabled.
 *
 * That fix has a trapdoor. A disabled checkbox posts NOTHING, exactly as an
 * unticked one does, and the save is an upsert that replaces the whole row. So
 * the obvious `digest: form.has('digest_' + category)` would read false for
 * every category and wipe every stored preference the first time anybody saved
 * — silently, on the page whose entire promise is that it does not do that.
 * The column is kept because it is meant to be honoured later; a save that
 * empties it on the way past makes the keeping worthless.
 *
 * Read from source because that is where the mistake would reappear: there is
 * no unit to call here, only a page whose handler must not ask the form.
 */
test('the settings save cannot take the digest preference from the form', () => {
  const page = readFileSync(new URL('../src/pages/app/settings.astro', import.meta.url), 'utf8')

  // The control is not live, so nothing can arrive for it.
  assert.match(
    page,
    /<input\s+type="checkbox"\s+disabled\s+checked\s+aria-label=\{`Daily digest/,
    'the digest box must be disabled, not a live control over a column nothing reads',
  )
  assert.ok(
    !/name=\{`digest_/.test(page),
    'a disabled box with a name still posts nothing — it must not claim to post at all',
  )

  // And therefore the save must not derive the value from what was posted.
  assert.ok(
    !/form\.(has|get)\(`digest_/.test(page),
    'reading the form for digest turns every save into a silent wipe of the stored value',
  )
  assert.match(
    page,
    /digest: storedDigest\.get\(category\.value\) \?\? true/,
    'the saved value must be the one already stored, defaulting to the column default',
  )
})
