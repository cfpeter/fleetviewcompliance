/**
 * Password reset: the screens a locked-out carrier meets.
 *
 * Three properties are worth more than the rest, and they are what this file is
 * written around:
 *
 *   1. The reset form answers every address identically. A form that says "no
 *      account for that address" is a lookup service for who our customers are.
 *   2. Every outcome any of this can produce is a sentence we wrote. A code the
 *      notice map does not know renders an empty page, which on this screen
 *      means a person is told nothing at all on the morning they cannot get in.
 *   3. /auth/new-password is exempt from the middleware's stray-code rescue.
 *      Without that, every reset link in the world is swallowed and turned into
 *      a silent sign-in, and the feature fails by appearing to work.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MIN_PASSWORD, notice, passwordProblem, resetOutcome } from '../src/lib/onboarding.ts'
import { handlesAuthCode } from '../src/lib/redirect.ts'

// ------------------------------------------------------------- enumeration

test('a successful send and an address with no account say the same thing', () => {
  // Supabase answers an unknown address with success and sends nothing, so the
  // neutral case is the no-error case.
  assert.equal(resetOutcome(null), 'reset_sent')
  assert.equal(resetOutcome(undefined), 'reset_sent')

  // And if a future Supabase release ever starts reporting the missing user,
  // the page must keep saying the same sentence rather than becoming an oracle.
  assert.equal(resetOutcome({ code: 'user_not_found' }), 'reset_sent')
  assert.equal(resetOutcome({ message: 'User not found' }), 'reset_sent')
  assert.equal(resetOutcome({ message: 'no user found with that email' }), 'reset_sent')
})

test('the sentence for a sent link is true even when nothing was sent', () => {
  // The whole anti-enumeration design rests on this wording. "We sent you a
  // link" would be a lie for an address with no account — and a promise the
  // customer waits on.
  const text = notice('reset_sent')?.text ?? ''
  assert.match(text, /^If that email has an account here/)
  assert.equal(notice('reset_sent')?.tone, 'ok')
})

test('facts about the request are still reported', () => {
  // These reveal nothing about who has an account — they are about what was
  // just typed and how often — and silence on them strands the person.
  assert.equal(resetOutcome({ status: 429 }), 'rate_limited')
  assert.equal(resetOutcome({ code: 'over_email_send_rate_limit' }), 'rate_limited')
  assert.equal(resetOutcome({ message: 'Email rate limit exceeded' }), 'rate_limited')
  assert.equal(resetOutcome({ code: 'email_address_invalid' }), 'bad_email')
  assert.equal(resetOutcome({ message: 'Invalid email address' }), 'bad_email')
})

test('an unrecognised failure is reported as a failure, not as a send', () => {
  // The one direction that must never flip: telling somebody a link is coming
  // when the call failed leaves them waiting on an email nobody sent.
  assert.equal(resetOutcome({ message: 'database is on fire' }), 'reset_failed')
  assert.equal(resetOutcome({ status: 500 }), 'reset_failed')
  assert.equal(resetOutcome({}), 'reset_failed')
})

// ------------------------------------------------------------- the two boxes

test('a password shorter than the rule is refused', () => {
  assert.equal(passwordProblem('short', 'short'), 'password_short')
  assert.equal(passwordProblem('', ''), 'password_short')
  assert.equal(passwordProblem('1234567', '1234567'), 'password_short')
})

test('the minimum is the same number the sign-up form uses', () => {
  assert.equal(MIN_PASSWORD, 8)
  // Exactly at the minimum is allowed — an off-by-one here refuses a password
  // the sign-up form would have accepted.
  assert.equal(passwordProblem('12345678', '12345678'), null)
})

test('two boxes that disagree are refused', () => {
  // There is no old password to fall back on here, so a typo typed once is a
  // password nobody knows on an account whose only way back is another email.
  assert.equal(passwordProblem('correct horse', 'correct hors'), 'password_mismatch')
  assert.equal(passwordProblem('correct horse', ''), 'password_mismatch')
})

test('length is reported before a mismatch', () => {
  // Both wrong: say the thing that can be fixed without retyping both boxes.
  assert.equal(passwordProblem('abc', 'xyz'), 'password_short')
})

test('a good password passes', () => {
  assert.equal(passwordProblem('a sensible one', 'a sensible one'), null)
  // Spaces are part of the password, never trimmed. Trimming would save a
  // password different from the one that was typed.
  assert.equal(passwordProblem(' padded pass ', ' padded pass '), null)
  assert.equal(passwordProblem(' padded pass ', 'padded pass'), 'password_mismatch')
})

// ------------------------------------------------------- nothing says nothing

test('every code these screens can produce is a sentence we wrote', () => {
  // An unknown code renders an empty page. On the reset screens that means a
  // person who cannot sign in presses a button and is told nothing at all.
  const produced = [
    resetOutcome(null),
    resetOutcome({ status: 429 }),
    resetOutcome({ code: 'email_address_invalid' }),
    resetOutcome({}),
    passwordProblem('x', 'x'),
    passwordProblem('12345678', 'nope'),
    // Written by the pages themselves rather than by a function.
    'email_needed',
    'reset_link_unusable',
    'reset_link_missing',
    'password_not_saved',
  ]
  for (const code of produced) {
    assert.ok(code, 'a screen produced an empty code')
    assert.ok(notice(code)?.text, `no sentence for ${code}`)
  }
})

test('the refusals read as instructions, not as dead ends', () => {
  // Every one of these is read by somebody who is locked out. Each has to end
  // with what to do next, and all three point at the same next step.
  for (const code of ['reset_link_unusable', 'reset_link_missing', 'password_not_saved']) {
    const text = notice(code)?.text ?? ''
    assert.equal(notice(code)?.tone, 'error')
    assert.match(text, /ask for a new link/i, `${code} does not say what to do next`)
  }
})

// --------------------------------------------------------- the rescue's blind spot

test('the routes that read their own auth code are exempt from the rescue', () => {
  // The middleware forwards a stray UUID `?code=` to /auth/callback. A Supabase
  // auth code IS a UUID, so without this exemption a good reset link is taken
  // off /auth/new-password, exchanged at the callback, and the person is signed
  // in at the dashboard having never seen a password box.
  assert.equal(handlesAuthCode('/auth/new-password'), true)
  assert.equal(handlesAuthCode('/auth/callback'), true)
  // Astro serves both spellings and Supabase returns whatever redirectTo said.
  assert.equal(handlesAuthCode('/auth/new-password/'), true)
  assert.equal(handlesAuthCode('/auth/callback/'), true)
})

test('everywhere else still gets rescued', () => {
  // The Site-URL fallback this rescue exists for lands on '/', and a page that
  // merely happens to take a `?code=` must not be mistaken for an auth route.
  assert.equal(handlesAuthCode('/'), false)
  assert.equal(handlesAuthCode('/app'), false)
  assert.equal(handlesAuthCode('/login'), false)
  assert.equal(handlesAuthCode('/check'), false)
  assert.equal(handlesAuthCode('/auth/new-password/extra'), false)
  assert.equal(handlesAuthCode('/auth'), false)
})
