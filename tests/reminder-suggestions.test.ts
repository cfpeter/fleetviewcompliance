/**
 * The starter list of reminders we put in front of an owner.
 *
 * THE ONE THING THAT MUST NEVER HAPPEN. Every suggestion here is the owner's
 * own note, and not one of them may be something the rule catalogue already
 * tracks. A suggestion for "annual DOT inspection" would put TWO rows on his
 * dashboard for one deadline — one from the law carrying a citation, one from
 * him carrying none — on different dates, with different lead times, and the
 * day they disagree is the day he stops believing either. The catalogue has 52
 * rules and grows; this file is what stops the two lists drifting into each
 * other.
 *
 * THE SECOND THING. A suggested repeat is a claim about the world. "Every 3
 * months" for an oil change is not true — it depends on the miles and the
 * engine — so a repeat is only ever suggested where the interval is a calendar
 * fact somebody else already set: a truck payment is monthly because he signed
 * monthly. Anything driven by wear carries no repeat at all, and the note says
 * whose decision it is.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  REMINDER_SUGGESTIONS,
  suggestionByKey,
  suggestionsFor,
} from '../src/lib/reminder-suggestions.ts'
import { REPEAT_OPTIONS } from '../src/lib/reminders.ts'
import { allRules } from '../src/lib/rules/index.ts'

/**
 * Words that belong to the catalogue and to nothing else.
 *
 * A title match alone is too weak a guard — "Annual inspection" and "Annual DOT
 * inspection — power unit" are the same deadline and share no whole string. So
 * the check is on the NAMES the regulations are known by, which is what an
 * owner would type and what a suggestion would have to contain to collide.
 */
const TRACKED_TERMS = [
  'dot inspection',
  'annual inspection',
  'periodic inspection',
  'bit ',
  'clean truck check',
  'carb',
  'ifta',
  'irp',
  'ucr',
  'mcs-150',
  '2290',
  'cvra',
  'motor carrier permit',
  'clearinghouse',
  'medical examiner',
  'medical certificate',
  'cdl',
  'drug test',
  'alcohol test',
  'random testing',
  'driver qualification',
  'driving record',
  'mvr',
  'road test',
  'hazmat registration',
  'phmsa',
  'cal/osha',
  '300a',
  'dvir',
  'vehicle inspection report',
  'bmc-91',
  'operating authority',
  'harassment prevention',
  'workplace violence',
]

test('no suggestion is something the catalogue already tracks', () => {
  for (const s of REMINDER_SUGGESTIONS) {
    const title = s.title.toLowerCase()
    for (const term of TRACKED_TERMS) {
      assert.ok(
        !title.includes(term),
        `"${s.title}" reads like the tracked rule "${term}" — two rows for one deadline`,
      )
    }
  }
})

test('no suggestion repeats a rule title outright', () => {
  const ruleTitles = new Set(allRules.map((r) => r.title.toLowerCase().trim()))
  for (const s of REMINDER_SUGGESTIONS) {
    assert.ok(!ruleTitles.has(s.title.toLowerCase().trim()), `"${s.title}" is a rule title`)
  }
})

test('a suggested repeat is one the form can actually offer', () => {
  // A repeat the <select> has no option for silently falls back to "Does not
  // repeat", so the suggestion would quietly not do what it says.
  const offered = new Set(REPEAT_OPTIONS.map((o) => o.value))
  for (const s of REMINDER_SUGGESTIONS) {
    assert.ok(
      offered.has(s.repeatMonths),
      `${s.key} suggests ${s.repeatMonths} months, which the repeat list does not offer`,
    )
  }
})

test('each kind of interval keeps its own promise', () => {
  // Checked against the MODEL rather than by matching words in the prose, which
  // is what `interval` is for. The three kinds make three different promises to
  // the owner and each one can be broken silently:
  //
  //   calendar — we claim to know the number, so there had better be one.
  //   contract — a number exists but only his paperwork holds it, so the note
  //              must send him to it. Asserting 12 months at a carrier whose
  //              policy renews in six is the failure this category exists to
  //              stop.
  //   owner    — no number exists, or the date is on a document in his hand.
  //              The note has to say which, or the row just looks unfinished.
  const OWNER_REASON =
    /you pick|your call|you decide|depends|your own|not a rule|put that in|put that date|set the date|printed on|shows its own|on the card|a habit/
  const CHECK_YOUR_PAPERS = /check your|your own|your agreement|your schedule|your lease|what you signed|read your/

  for (const s of REMINDER_SUGGESTIONS) {
    assert.ok(s.title.trim().length > 0, `${s.key} has a title`)
    assert.ok(s.note.trim().length > 20, `${s.key} explains itself`)
    assert.ok(s.fits.length > 0, `${s.key} fits somewhere`)

    if (s.interval === 'calendar') {
      assert.ok(
        s.repeatMonths > 0,
        `${s.key} claims a known interval and then does not give one`,
      )
    }
    if (s.interval === 'contract') {
      assert.match(
        s.note.toLowerCase(),
        CHECK_YOUR_PAPERS,
        `${s.key} prefills an interval off his paperwork, so the note must send him to it`,
      )
    }
    if (s.interval === 'owner') {
      assert.match(
        s.note.toLowerCase(),
        OWNER_REASON,
        `${s.key} suggests no interval and the note does not say why`,
      )
    }
  }
})

test('nothing asserts a number it has no right to', () => {
  // The whole reason the three kinds exist. Only `calendar` may state an
  // interval as a fact; `contract` prefills the common case and says so;
  // `owner` may carry a cadence only while calling it a habit.
  for (const s of REMINDER_SUGGESTIONS) {
    if (s.interval === 'owner' && s.repeatMonths > 0) {
      assert.match(
        s.note.toLowerCase(),
        /habit|you pick|your own|common/,
        `${s.key} suggests ${s.repeatMonths} months without saying it is only a habit`,
      )
    }
  }
})

test('keys are unique, stable and safe in a URL', () => {
  const keys = REMINDER_SUGGESTIONS.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length, 'a duplicate key makes one suggestion unreachable')
  for (const key of keys) {
    // They end up in links people bookmark, and in a Location header.
    assert.match(key, /^[a-z0-9_]+$/, `${key} must need no escaping`)
    assert.equal(encodeURIComponent(key), key)
  }
})

test('a key out of a URL only ever resolves to something we wrote', () => {
  assert.equal(suggestionByKey(null), null)
  assert.equal(suggestionByKey(''), null)
  assert.equal(suggestionByKey('   '), null)
  assert.equal(suggestionByKey('<script>alert(1)</script>'), null)
  assert.equal(suggestionByKey('toString'), null, 'not a lookup on the prototype')
  assert.equal(suggestionByKey('constructor'), null)
  const first = REMINDER_SUGGESTIONS[0]
  assert.equal(suggestionByKey(first.key)?.title, first.title)
  assert.equal(
    suggestionByKey(` ${first.key} `)?.title,
    first.title,
    'trimmed, like every other id',
  )
})

test('a screen is only offered the suggestions that fit it', () => {
  // A truck page offering "send the books to the accountant" is a list whose
  // first entry does not apply, and he stops reading lists like that.
  for (const fit of ['carrier', 'vehicle', 'driver'] as const) {
    const list = suggestionsFor(fit)
    assert.ok(list.length > 0, `${fit} has something to offer`)
    for (const s of list) assert.ok(s.fits.includes(fit))
  }
  const all = new Set(REMINDER_SUGGESTIONS.map((s) => s.key))
  const covered = new Set(
    (['carrier', 'vehicle', 'driver'] as const).flatMap((f) => suggestionsFor(f).map((s) => s.key)),
  )
  assert.deepEqual(covered, all, 'a suggestion that fits nowhere is one nobody can reach')
})
