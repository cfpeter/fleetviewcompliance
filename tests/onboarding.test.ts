/**
 * Signup and first-run derivations.
 *
 * Two of these guard security properties rather than formatting — the notice
 * whitelist and `signupOutcome` — so they are written as the attack, not as the
 * happy path.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CensusRow } from '../src/lib/fmcsa.ts'
import {
  addressLine,
  censusAddress,
  censusCount,
  fleetTarget,
  notice,
  operationLabel,
  parseAuthMode,
  rosterProgress,
  safetyRating,
  signupOutcome,
} from '../src/lib/onboarding.ts'

// ------------------------------------------------------------------- mode

test('only "signup" switches the screen; everything else is sign in', () => {
  assert.equal(parseAuthMode('signup'), 'signup')
  assert.equal(parseAuthMode('signin'), 'signin')
  assert.equal(parseAuthMode(null), 'signin')
  assert.equal(parseAuthMode(''), 'signin')
  assert.equal(parseAuthMode('SIGNUP'), 'signin')
  assert.equal(parseAuthMode('register'), 'signin')
})

// ---------------------------------------------------------------- notices

test('an unknown notice code says nothing at all', () => {
  // The bug this prevents: the page used to render `?error=<free text>`, so a
  // link could make our own login screen say "Your account is locked, call
  // 555-0100" in our styling, above our own password box.
  assert.equal(notice('Your account is locked, call 555-0100'), null)
  assert.equal(notice('<script>alert(1)</script>'), null)
  assert.equal(notice('toString'), null)
  assert.equal(notice('constructor'), null)
  assert.equal(notice(null), null)
  assert.equal(notice(''), null)
})

test('known codes carry a tone and a sentence', () => {
  const bad = notice('credentials')
  assert.equal(bad?.tone, 'error')
  assert.match(bad?.text ?? '', /do not match/)

  const ok = notice('check_email')
  assert.equal(ok?.tone, 'ok')

  assert.equal(notice('dot_taken')?.tone, 'error')
  assert.equal(notice('dot_invalid')?.tone, 'error')
})

test('the sign-in failure notice names neither the account nor the password', () => {
  // It must not be readable as "that account exists but the password is wrong"
  // or as "no such account" — either one answers a question we do not answer.
  const text = notice('credentials')?.text ?? ''
  assert.doesNotMatch(text, /account|registered|exists|unknown|found/i)
})

// ---------------------------------------------------------- signup errors

test('an already-registered address gets the same answer as a new one', () => {
  // Enumeration, reached from the sign-up button instead of the sign-in button.
  // Supabase says "User already registered" when email confirmation is off.
  assert.equal(signupOutcome({ message: 'User already registered', status: 422 }), 'check_email')
  assert.equal(signupOutcome({ code: 'user_already_exists' }), 'check_email')
  assert.equal(signupOutcome({ message: 'Email address already exists' }), 'check_email')
  // And the outcome a genuinely new address gets, so the two are identical.
  assert.equal(signupOutcome(null), 'check_email')
  assert.equal(signupOutcome(undefined), 'check_email')
})

test('the shared outcome is worded so it is true for both cases', () => {
  // "Account created" would itself be the leak: it is false for an address that
  // already had one, and a customer who reads it and then cannot sign in has
  // been told something wrong at the worst possible moment.
  const text = notice(signupOutcome(null))?.text ?? ''
  assert.doesNotMatch(text, /account created|we created|welcome/i)
  assert.match(text, /if that address/i)
})

test('problems with what was typed are still reported', () => {
  assert.equal(signupOutcome({ code: 'weak_password' }), 'weak_password')
  assert.equal(
    signupOutcome({ message: 'Password should be at least 8 characters.' }),
    'weak_password',
  )
  assert.equal(signupOutcome({ code: 'email_address_invalid' }), 'bad_email')
  assert.equal(
    signupOutcome({ message: 'Unable to validate email address: invalid format' }),
    'bad_email',
  )
})

test('rate limiting is its own answer, not a generic failure', () => {
  assert.equal(signupOutcome({ status: 429 }), 'rate_limited')
  assert.equal(signupOutcome({ code: 'over_email_send_rate_limit' }), 'rate_limited')
  assert.equal(signupOutcome({ message: 'email rate limit exceeded' }), 'rate_limited')
})

test('anything unrecognised is generic, never the raw message', () => {
  const out = signupOutcome({ message: 'duplicate key value violates unique constraint "x"' })
  assert.equal(out, 'signup_failed')
  assert.doesNotMatch(notice(out)?.text ?? '', /duplicate|constraint/)
})

test('every outcome signupOutcome can return is a code the page can render', () => {
  const samples: Parameters<typeof signupOutcome>[0][] = [
    null,
    { code: 'user_already_exists' },
    { status: 429 },
    { code: 'weak_password' },
    { code: 'email_address_invalid' },
    { message: 'something nobody has seen before' },
  ]
  for (const s of samples) {
    assert.notEqual(notice(signupOutcome(s)), null, `no notice for ${JSON.stringify(s)}`)
  }
})

// ----------------------------------------------------------------- counts

test('a missing count is unknown, never zero', () => {
  // Socrata omits null columns, and Number('') is 0 — which would print
  // "FMCSA has you at 0 power units" for a carrier whose count is simply
  // not on file.
  assert.equal(censusCount(undefined), null)
  assert.equal(censusCount(null), null)
  assert.equal(censusCount(''), null)
  assert.equal(censusCount('   '), null)
  assert.equal(censusCount('n/a'), null)
  assert.equal(censusCount('-3'), null)
  assert.equal(censusCount('12.5'), null)
})

test('a real zero survives as a zero', () => {
  assert.equal(censusCount('0'), 0)
  assert.equal(censusCount(' 9 '), 9)
  assert.equal(censusCount('12'), 12)
})

test('fleetTarget reads the three counts the census actually publishes', () => {
  const row: CensusRow = { power_units: '12', total_drivers: '9', total_cdl: '8' }
  assert.deepEqual(fleetTarget(row), { powerUnits: 12, drivers: 9, cdl: 8 })
})

test('a census row with no counts is three unknowns', () => {
  assert.deepEqual(fleetTarget({}), { powerUnits: null, drivers: null, cdl: null })
  assert.deepEqual(fleetTarget(null), { powerUnits: null, drivers: null, cdl: null })
})

// --------------------------------------------------------------- progress

test('nothing added against a known count is a target, not an error', () => {
  assert.deepEqual(rosterProgress(0, 12), {
    state: 'partial',
    added: 0,
    target: 12,
    remaining: 12,
  })
})

test('part of the way through counts down', () => {
  assert.deepEqual(rosterProgress(5, 12), {
    state: 'partial',
    added: 5,
    target: 12,
    remaining: 7,
  })
})

test('matching the federal count is its own state', () => {
  assert.deepEqual(rosterProgress(12, 12), { state: 'met', added: 12, target: 12 })
  assert.deepEqual(rosterProgress(0, 0), { state: 'met', added: 0, target: 0 })
})

test('more trucks than FMCSA has on file is over, not negative remaining', () => {
  // A carrier who bought two trucks since his last MCS-150. "-2 to go" would be
  // nonsense; his federal filing being behind his yard is the real finding.
  assert.deepEqual(rosterProgress(14, 12), { state: 'over', added: 14, target: 12 })
})

test('no federal count means we compare against nothing', () => {
  assert.deepEqual(rosterProgress(3, null), { state: 'unknown', added: 3 })
  assert.deepEqual(rosterProgress(0, null), { state: 'unknown', added: 0 })
})

// ---------------------------------------------------------------- address

test('the census address is copied field by field, blanks dropped', () => {
  const row: CensusRow = {
    phy_street: ' 1200 W Colorado St ',
    phy_city: 'Glendale',
    phy_state: 'CA',
    phy_zip: '  ',
    phone: '8185550100',
  }
  assert.deepEqual(censusAddress(row), {
    phy_street: '1200 W Colorado St',
    phy_city: 'Glendale',
    phy_state: 'CA',
    phy_zip: null,
    phone: '8185550100',
  })
})

test('a census row with no address at all writes nothing', () => {
  // So the caller can skip the UPDATE rather than stamping five NULLs over a
  // carrier row that might already have something in it.
  assert.equal(censusAddress({}), null)
  assert.equal(censusAddress({ phy_city: '   ' }), null)
  assert.equal(censusAddress(null), null)
})

test('addressLine joins what exists and returns null for nothing', () => {
  assert.equal(
    addressLine({
      phy_street: '1 Main St',
      phy_city: 'Glendale',
      phy_state: 'CA',
      phy_zip: '91204',
    }),
    '1 Main St · Glendale, CA · 91204',
  )
  assert.equal(addressLine({ phy_city: 'Glendale', phy_state: 'CA' }), 'Glendale, CA')
  // A phone alone is not an address, so there is nothing to put on the line.
  assert.equal(addressLine({ phone: '8185550100' }), null)
  assert.equal(addressLine({}), null)
})

// -------------------------------------------------------------- operation

test('a blank operation code is not a claim that the carrier is intrastate', () => {
  // /check renders `=== 'A' ? 'Interstate' : 'Intrastate'`, which asserts
  // intrastate-only for a carrier the file says nothing about — and that
  // answer decides which half of the rule catalogue applies to him.
  assert.equal(operationLabel(undefined), 'Not stated')
  assert.equal(operationLabel(''), 'Not stated')
  assert.equal(operationLabel('X'), 'Not stated')
})

test('the codes the census does use are named', () => {
  assert.equal(operationLabel('A'), 'Interstate')
  assert.equal(operationLabel('B'), 'Intrastate')
  assert.equal(operationLabel('C'), 'Intrastate')
  assert.equal(operationLabel(' a '), 'Interstate')
})

// ---------------------------------------------------------- safety rating

test('an unrated carrier is told that is normal, not that something is wrong', () => {
  const r = safetyRating('')
  assert.equal(r.label, 'Not rated')
  assert.match(r.note, /never had a compliance review/i)
  // Not on the red-to-amber urgency scale: nothing is running out.
  assert.doesNotMatch(r.tone, /red|amber/)
})

test('the three real ratings keep their severity apart', () => {
  assert.equal(safetyRating('S').label, 'Satisfactory')
  assert.match(safetyRating('S').tone, /emerald/)
  assert.equal(safetyRating('C').label, 'Conditional')
  assert.match(safetyRating('C').tone, /amber/)
  assert.equal(safetyRating('U').label, 'Unsatisfactory')
  assert.match(safetyRating('U').tone, /red/)
})

test('every rating carries a sentence, because a code alone means nothing', () => {
  for (const code of ['S', 'C', 'U', '', 'Z']) {
    assert.ok(safetyRating(code).note.length > 20, `no note for ${code}`)
  }
})
