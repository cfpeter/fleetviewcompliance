/**
 * USDOT ownership verification, tested as the attack.
 *
 * Almost nothing here is a happy path, because the happy path was never the
 * risk. The risk is that a six-digit code with a million possibilities, sent to
 * a phone number anybody can read off a public federal file, becomes the thing
 * that hands over a carrier's compliance record. Every test below is one of the
 * ways that happens:
 *
 *   an expired code still works
 *   a used code works twice
 *   a wrong code costs nothing
 *   guesses are unlimited
 *   the mask gives back the value it was hiding
 *   somebody else finishes your claim
 *
 * The database enforces the same rules in 0021_carrier_claims.sql. These run
 * against the pure mirror of that logic, which is why they need no connection
 * and run everywhere.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  attemptsLeft,
  CLAIM_POLICY,
  type ClaimRecord,
  claimExpiry,
  claimMessage,
  claimOptions,
  hashClaimCode,
  hashesMatch,
  isClaimCode,
  maskEmail,
  maskPhone,
  newClaimCode,
  normalizeClaimCode,
  pickOption,
  rateVerdict,
  toE164,
  usableEmail,
  verifyClaim,
} from '../src/lib/claims.ts'

const PEPPER = 'a'.repeat(48)
const ALICE = '11111111-1111-1111-1111-111111111111'
const BOB = '22222222-2222-2222-2222-222222222222'
const DOT = '1234567'

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + minutes * 60_000)
const NOW = at(0)

/** A live claim with a known code already hashed into it. */
async function liveClaim(over: Partial<ClaimRecord> = {}, code = '123456'): Promise<ClaimRecord> {
  return {
    userId: ALICE,
    dotNumber: DOT,
    channel: 'phone',
    codeHash: await hashClaimCode({ pepper: PEPPER, dotNumber: DOT, userId: ALICE, code }),
    expiresAt: claimExpiry(NOW),
    attempts: 0,
    verifiedAt: null,
    voidedAt: null,
    ...over,
  }
}

const hashFor = (code: string, userId = ALICE, dotNumber = DOT) =>
  hashClaimCode({ pepper: PEPPER, dotNumber, userId, code })

// =================================================================== codes

test('a code is six digits and keeps its leading zeros', () => {
  for (let i = 0; i < 500; i++) {
    const code = newClaimCode()
    assert.match(code, /^\d{6}$/, `${code} is not six digits`)
    assert.equal(isClaimCode(code), true)
  }
})

test('codes are drawn from the whole space, not a corner of it', () => {
  // Not a randomness test — a smoke alarm for a generator that folded a 32-bit
  // draw into too small a range, which shows up here as a suspiciously narrow
  // spread. (A generator that lost its leading zeros is caught by the six-digit
  // test above, not by this one — a short code still spreads fine.)
  //
  // A repeat is not the alarm; a pile of them is. Any 4000 draws from 10^6 collide
  // about 8 times by the birthday paradox alone, which is why the older form of
  // this test — 400 draws, no repeat allowed — went red on 8% of clean runs. The
  // threshold below sits far above that noise (a clean generator trips it about
  // once in two billion runs) and far below a real fault: a space even ten times
  // too small averages 80 repeats at this draw count, and fails here every time.
  const DRAWS = 4000
  const seen = new Set<string>()
  let low = 0
  for (let i = 0; i < DRAWS; i++) {
    const code = newClaimCode()
    seen.add(code)
    if (Number(code) < 500_000) low++
  }
  const repeats = DRAWS - seen.size
  assert.ok(
    repeats <= 30,
    `${repeats} repeats in ${DRAWS} draws means the space is far smaller than 10^6`,
  )
  assert.ok(
    low > 1750 && low < 2250,
    `half the space should get roughly half the draws, got ${low}`,
  )
})

test('anything that is not six digits is not a code', () => {
  assert.equal(isClaimCode('12345'), false)
  assert.equal(isClaimCode('1234567'), false)
  assert.equal(isClaimCode('12345a'), false)
  assert.equal(isClaimCode(123456), false)
  assert.equal(isClaimCode(null), false)
  assert.equal(isClaimCode(''), false)
})

test('a pasted code survives the spaces and dashes people type', () => {
  assert.equal(normalizeClaimCode('123 456'), '123456')
  assert.equal(normalizeClaimCode('123-456'), '123456')
  assert.equal(normalizeClaimCode(' 012345 '), '012345')
  assert.equal(normalizeClaimCode('12345'), null)
  assert.equal(normalizeClaimCode('abcdef'), null)
  assert.equal(normalizeClaimCode(null), null)
})

// =================================================================== hashing

test('the stored value is a hash, and nothing in it resembles the code', async () => {
  const hash = await hashFor('123456')
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(hash.includes('123456'), false)
})

test('the same code hashes differently for a different user or a different DOT', async () => {
  const mine = await hashFor('123456', ALICE, DOT)
  const theirs = await hashFor('123456', BOB, DOT)
  const other = await hashFor('123456', ALICE, '7654321')
  assert.notEqual(mine, theirs, 'a hash must not be replayable against another user')
  assert.notEqual(mine, other, 'a hash must not be replayable against another carrier')
})

test('a different pepper produces a different hash, so a leaked table is useless alone', async () => {
  const a = await hashClaimCode({ pepper: PEPPER, dotNumber: DOT, userId: ALICE, code: '123456' })
  const b = await hashClaimCode({
    pepper: 'b'.repeat(48),
    dotNumber: DOT,
    userId: ALICE,
    code: '123456',
  })
  assert.notEqual(a, b)
})

test('hashing refuses to run without a real pepper', async () => {
  // The alternative is a plain digest of six digits, which is one million
  // SHA-256 operations away from plaintext. Refusing is the same inversion the
  // notification guard uses: an unconfigured environment does nothing.
  await assert.rejects(
    () => hashClaimCode({ pepper: undefined, dotNumber: DOT, userId: ALICE, code: '123456' }),
    /CLAIM_CODE_PEPPER/,
  )
  await assert.rejects(
    () => hashClaimCode({ pepper: 'short', dotNumber: DOT, userId: ALICE, code: '123456' }),
    /CLAIM_CODE_PEPPER/,
  )
})

test('comparison is by value and rejects the empty and the mistyped', () => {
  assert.equal(hashesMatch('abc', 'abc'), true)
  assert.equal(hashesMatch('abc', 'abd'), false)
  assert.equal(hashesMatch('abc', 'abcd'), false)
  assert.equal(hashesMatch('', ''), false, 'two empty strings are not a match')
  assert.equal(hashesMatch(null, null), false)
  assert.equal(hashesMatch('abc', undefined), false)
})

// =================================================================== masking

test('a masked phone shows four digits and cannot be turned back', () => {
  assert.equal(maskPhone('(818) 334-0168'), '(•••) •••-0168')
  assert.equal(maskPhone('8183340168'), '(•••) •••-0168')
  assert.equal(maskPhone('1-818-334-0168'), '(•••) •••-0168')

  const masked = maskPhone('8183340168') ?? ''
  // The six digits that identify the line are gone, and nothing in the output
  // reveals them: no area code, no exchange, no count of hidden characters
  // beyond the fixed bullets.
  assert.equal(masked.includes('818'), false)
  assert.equal(masked.includes('334'), false)
  assert.equal(masked.replace(/\D/g, ''), '0168')
})

test('a phone we cannot send to is not a channel at all', () => {
  // Every one of these is in the real census file. A mask over a five-digit
  // field would reveal almost all of it, and Twilio would reject the send
  // afterwards anyway — so they are refused before a claim is ever created.
  assert.equal(toE164('12345'), null)
  assert.equal(toE164('1111111111'), null, 'area codes do not start with 1')
  assert.equal(toE164('0123456789'), null)
  assert.equal(toE164('9999999999'), null, 'ten identical digits is placeholder data')
  assert.equal(toE164(''), null)
  assert.equal(toE164(null), null)
  assert.equal(maskPhone('12345'), null)
  assert.equal(toE164('818-334-0168 ext 2'), null, 'an extension makes the digits unusable')
})

test('a masked email shows one character and the domain, never the length', () => {
  assert.equal(maskEmail('dispatch@swifttrans.com'), 'd•••@swifttrans.com')
  assert.equal(maskEmail('  Owner@Example.co.uk  '), 'O•••@Example.co.uk')

  // Fixed bullets: the mask for a 2-character local part and a 20-character one
  // are the same width, so the mask never says how long the address is.
  assert.equal(maskEmail('ab@x.com'), 'a•••@x.com')
  assert.equal(maskEmail('abcdefghijklmnopqrst@x.com'), 'a•••@x.com')
})

test('a one-character local part gets no character at all', () => {
  // Showing "the first character" of a one-character local part is showing the
  // local part. The rule is that the mask must not reconstruct the value, not
  // that it must always print a letter.
  assert.equal(maskEmail('j@example.com'), '•••@example.com')
})

test('rubbish in the email column is not a channel', () => {
  assert.equal(usableEmail('not-an-email'), null)
  assert.equal(usableEmail('two@at@example.com'), null)
  assert.equal(usableEmail('@example.com'), null)
  assert.equal(usableEmail('owner@localhost'), null)
  assert.equal(usableEmail('owner@exa mple.com'), null)
  assert.equal(usableEmail(''), null)
  assert.equal(usableEmail(null), null)
  assert.equal(maskEmail('not-an-email'), null)
})

// ================================================================= channels

test('phone leads, because the federal file has one for nearly everybody', () => {
  const options = claimOptions({ phone: '8183340168', email_address: 'owner@example.com' })
  assert.deepEqual(
    options.map((o) => o.channel),
    ['phone', 'email'],
  )
  assert.equal(options[0].destination, '+18183340168')
  assert.equal(options[1].destination, 'owner@example.com')
})

test('an older record with only a phone offers only the phone', () => {
  const options = claimOptions({ phone: '(818) 334-0168' })
  assert.deepEqual(
    options.map((o) => o.channel),
    ['phone'],
  )
})

test('a record with neither is an empty list, which is an answer and not a failure', () => {
  // 37% of the oldest California registrations. They cannot self-verify, ever,
  // and the page owes them a manual-review path rather than a form that refuses.
  assert.deepEqual(claimOptions({ legal_name: 'OLD TIMER TRUCKING' }), [])
  assert.deepEqual(claimOptions({ phone: '00000', email_address: 'none' }), [])
  assert.deepEqual(claimOptions(null), [])
})

test('the channel comes off a form, so it is looked up rather than trusted', () => {
  const options = claimOptions({ phone: '8183340168' })
  assert.equal(pickOption(options, 'phone')?.destination, '+18183340168')
  // The attack this refuses: posting `channel=email` for a carrier with no
  // email on file, or any other value, to see what the server does with it.
  assert.equal(pickOption(options, 'email'), null)
  assert.equal(pickOption(options, 'manual'), null)
  assert.equal(pickOption(options, '__proto__'), null)
  assert.equal(pickOption(options, null), null)
})

// ============================================================ verification

test('the right code completes the claim', async () => {
  const claim = await liveClaim()
  const verdict = verifyClaim(claim, {
    userId: ALICE,
    codeHash: await hashFor('123456'),
    now: at(5),
  })
  assert.deepEqual(verdict, { state: 'ok' })
})

test('an expired code is refused even when it is the right code', async () => {
  const claim = await liveClaim()
  const verdict = verifyClaim(claim, {
    userId: ALICE,
    codeHash: await hashFor('123456'),
    now: at(CLAIM_POLICY.ttlMinutes + 1),
  })
  assert.deepEqual(verdict, { state: 'expired' })
})

test('expiry is exact at the boundary, not a minute either side', async () => {
  const claim = await liveClaim()
  const codeHash = await hashFor('123456')
  assert.deepEqual(verifyClaim(claim, { userId: ALICE, codeHash, now: at(14.9) }), { state: 'ok' })
  assert.deepEqual(verifyClaim(claim, { userId: ALICE, codeHash, now: at(15) }), {
    state: 'expired',
  })
})

test('a code that already worked cannot work twice', async () => {
  // Replay. The code sits in the carrier's text messages forever; without this
  // the same six digits still complete a claim next month.
  const claim = await liveClaim({ verifiedAt: at(1) })
  const verdict = verifyClaim(claim, {
    userId: ALICE,
    codeHash: await hashFor('123456'),
    now: at(2),
  })
  assert.deepEqual(verdict, { state: 'used' })
})

test('a wrong code is refused and spends one of the five attempts', async () => {
  const claim = await liveClaim({ attempts: 0 })
  const verdict = verifyClaim(claim, {
    userId: ALICE,
    codeHash: await hashFor('999999'),
    now: at(1),
  })
  assert.deepEqual(verdict, { state: 'wrong_code', attemptsLeft: 4 })
})

test('the fifth wrong guess kills the claim and the sixth is not even considered', async () => {
  // Six digits is a million possibilities, which is nothing to a script. The cap
  // is what turns that million into a 1-in-200,000 chance per claim, and a claim
  // that must be restarted — which means another rate-limited send.
  const right = await hashFor('123456')
  const wrong = await hashFor('999999')

  const fourUsed = await liveClaim({ attempts: CLAIM_POLICY.maxAttempts - 1 })
  assert.deepEqual(verifyClaim(fourUsed, { userId: ALICE, codeHash: wrong, now: at(1) }), {
    state: 'wrong_code',
    attemptsLeft: 0,
  })

  const spent = await liveClaim({ attempts: CLAIM_POLICY.maxAttempts })
  assert.deepEqual(verifyClaim(spent, { userId: ALICE, codeHash: wrong, now: at(1) }), {
    state: 'attempts_exhausted',
  })
  // And the RIGHT code is refused too. A cap that the correct code walks past is
  // not a cap: five guesses plus a lucky sixth is still a guessing machine.
  assert.deepEqual(verifyClaim(spent, { userId: ALICE, codeHash: right, now: at(1) }), {
    state: 'attempts_exhausted',
  })
})

test("a second user cannot complete somebody else's claim", async () => {
  // The whole flow binds to the AUTHENTICATED user id. Bob knows the DOT number
  // (it is public) and — say he is standing next to the office phone — the code
  // itself. He still cannot finish Alice's claim, and he cannot start one and
  // finish it with her row either.
  const alicesClaim = await liveClaim({ userId: ALICE })

  const asBob = verifyClaim(alicesClaim, {
    userId: BOB,
    // Bob read the code off the screen. Hashed under his own id it does not even
    // match, and the ownership check refuses before that matters.
    codeHash: await hashFor('123456', BOB),
    now: at(1),
  })
  assert.deepEqual(asBob, { state: 'not_yours' })

  // Even holding Alice's exact hash — from a leak, a log, a support paste.
  const withAlicesHash = verifyClaim(alicesClaim, {
    userId: BOB,
    codeHash: await hashFor('123456', ALICE),
    now: at(1),
  })
  assert.deepEqual(withAlicesHash, { state: 'not_yours' })
})

test('ownership is checked before anything else, so no state leaks across users', async () => {
  // If "expired" and "wrong code" were distinguishable for another user's claim,
  // this flow would tell Bob whether Alice has a live claim on a DOT number —
  // which is the enumeration oracle wearing a different hat.
  const expired = await liveClaim({ userId: ALICE, expiresAt: at(-60) })
  const exhausted = await liveClaim({ userId: ALICE, attempts: 99 })
  const used = await liveClaim({ userId: ALICE, verifiedAt: at(-1) })
  const codeHash = await hashFor('123456', BOB)
  for (const claim of [expired, exhausted, used]) {
    assert.deepEqual(verifyClaim(claim, { userId: BOB, codeHash, now: at(1) }), {
      state: 'not_yours',
    })
  }
})

test('a voided claim is dead, and a manual claim can never be completed by code', async () => {
  const voided = await liveClaim({ voidedAt: at(1) })
  const codeHash = await hashFor('123456')
  assert.deepEqual(verifyClaim(voided, { userId: ALICE, codeHash, now: at(2) }), {
    state: 'voided',
  })

  // A manual-review request holds no code at all. Nothing about it is guessable,
  // because there is nothing to guess.
  const manual = await liveClaim({ channel: 'manual', codeHash: null })
  assert.deepEqual(verifyClaim(manual, { userId: ALICE, codeHash, now: at(2) }), {
    state: 'voided',
  })
})

test('attempts remaining never goes negative or exceeds the cap', () => {
  assert.equal(attemptsLeft(0), CLAIM_POLICY.maxAttempts)
  assert.equal(attemptsLeft(CLAIM_POLICY.maxAttempts), 0)
  assert.equal(attemptsLeft(CLAIM_POLICY.maxAttempts + 50), 0)
  assert.equal(attemptsLeft(-3), CLAIM_POLICY.maxAttempts)
  assert.equal(attemptsLeft(Number.NaN), CLAIM_POLICY.maxAttempts)
})

// ============================================================= rate limits

const counts = (over: Partial<Parameters<typeof rateVerdict>[0]> = {}) => ({
  dotLastHour: 0,
  dotLastDay: 0,
  userLastHour: 0,
  userLastDay: 0,
  secondsSinceUserLastSend: null,
  ...over,
})

test('a first send is allowed', () => {
  assert.deepEqual(rateVerdict(counts()), { allow: true })
})

test('a double-submitted form does not text the carrier twice', () => {
  assert.deepEqual(rateVerdict(counts({ secondsSinceUserLastSend: 3 })), {
    allow: false,
    reason: 'cooldown',
  })
  assert.deepEqual(rateVerdict(counts({ secondsSinceUserLastSend: 61 })), { allow: true })
})

test('one USDOT number cannot be made to ring all night', () => {
  // This is the limit that protects somebody who never asked to be involved.
  // Whoever owns that phone receives at most three messages an hour and ten a
  // day, from everybody, however many accounts are trying.
  assert.deepEqual(rateVerdict(counts({ dotLastHour: CLAIM_POLICY.sendsPerDotHour })), {
    allow: false,
    reason: 'dot_hour',
  })
  assert.deepEqual(rateVerdict(counts({ dotLastDay: CLAIM_POLICY.sendsPerDotDay })), {
    allow: false,
    reason: 'dot_day',
  })
})

test('one account cannot walk the census file one carrier at a time', () => {
  // The per-DOT cap alone leaves a script free to send three messages to each of
  // four million carriers. This is what makes that pointless.
  assert.deepEqual(rateVerdict(counts({ userLastHour: CLAIM_POLICY.sendsPerUserHour })), {
    allow: false,
    reason: 'user_hour',
  })
  assert.deepEqual(rateVerdict(counts({ userLastDay: CLAIM_POLICY.sendsPerUserDay })), {
    allow: false,
    reason: 'user_day',
  })
})

test('the carrier being pestered is protected before the account doing it', () => {
  // Both limits are blown at once. The per-DOT reason wins, because the message
  // on screen has to be about the number, not about the person typing.
  const both = counts({
    dotLastHour: CLAIM_POLICY.sendsPerDotHour,
    userLastHour: CLAIM_POLICY.sendsPerUserHour,
  })
  assert.deepEqual(rateVerdict(both), { allow: false, reason: 'dot_hour' })
})

// ================================================================== message

test('the message explains itself to somebody who did not ask for it', () => {
  // By design this arrives on a phone belonging to a person who may have no idea
  // what FleetView is. A bare "your code is 123456" at 9pm reads like a
  // compromise in progress.
  const { subject, body } = claimMessage('1234567', '123456')
  assert.match(subject, /1234567/)
  assert.match(body, /^123456 /)
  assert.match(body, /USDOT 1234567/)
  assert.match(body, /expires in 15 minutes/)
  assert.match(body, /did not ask for this/)
})

test('the message names the USDOT number and nothing else about the carrier', () => {
  // The DOT number is public. Who is trying to claim it is not, and naming them
  // would make this flow a way to tell a carrier that a competitor is poking at
  // their record.
  const { body } = claimMessage('1234567', '123456')
  assert.equal(/alice|@|claimed by/i.test(body), false)
})
