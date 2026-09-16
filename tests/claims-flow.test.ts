/**
 * The wiring between src/lib/claims.ts and the screen that uses it.
 *
 * tests/claims.test.ts already attacks the library. This file guards the seam,
 * which is where the two failures that survive a well-tested library live:
 *
 *   A CODE THE PAGE EMITS THAT THE ALLOW-LIST DOES NOT HOLD. `notice()` answers
 *   null for anything it does not recognise — which is the right behaviour for a
 *   URL a stranger wrote, and a silent blank bar when it is our own typo. So
 *   every code /app/setup can put in a redirect is read back out of the page
 *   source here and resolved. A refusal nobody can read is a refusal that reads
 *   as nothing having happened.
 *
 *   A REFUSAL THAT SAYS TOO MUCH. `not_yours` must be indistinguishable from the
 *   other dead-claim answers, or the flow becomes a way to find out that
 *   somebody else is mid-claim on a USDOT number — which is precisely the fact
 *   that tells a squatter which numbers are worth taking.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { RateReason } from '../src/lib/claims.ts'
import {
  type ClaimOutcome,
  claimNotice,
  claimStartNotice,
  claimStatusOutcome,
  notice,
} from '../src/lib/onboarding.ts'

const SETUP = readFileSync(
  fileURLToPath(new URL('../src/pages/app/setup.astro', import.meta.url)),
  'utf8',
)

// ------------------------------------------------------------- the outcomes

/**
 * Written out rather than derived, so that adding a state to `ClaimVerdict`
 * without deciding what it says to a person is a compile error here.
 */
const OUTCOMES = [
  'ok',
  'not_yours',
  'used',
  'voided',
  'expired',
  'attempts_exhausted',
  'wrong_code',
  'already_claimed',
] as const satisfies readonly ClaimOutcome[]

test('every claim outcome except success has a sentence a person can read', () => {
  for (const outcome of OUTCOMES) {
    const code = claimNotice(outcome)
    if (outcome === 'ok') {
      // Success is a redirect into the next state, not a message.
      assert.equal(code, null)
      continue
    }
    assert.ok(code, `${outcome} has no notice code`)
    assert.ok(notice(code), `${outcome} maps to ${code}, which the allow-list does not hold`)
  }
})

test('a claim held by somebody else is indistinguishable from a dead one', () => {
  // THE ANTI-ENUMERATION PROPERTY. If `not_yours` read differently from `used`
  // or `voided`, typing a code against a number somebody else is mid-claim on
  // would confirm that they are — and a squatter walking the census file would
  // learn which numbers are live. The database collapses all three into
  // `no_claim` for the same reason; this keeps the page from un-collapsing them.
  const texts = (['not_yours', 'used', 'voided'] as const).map((s) => notice(claimNotice(s))?.text)
  assert.equal(texts[0], texts[1])
  assert.equal(texts[1], texts[2])
  assert.ok(texts[0])
})

test('the outcomes a claimant can act on do say which one happened', () => {
  // The other half of the rule above. These three are facts about the
  // claimant's OWN claim and reveal nothing about anybody else, so collapsing
  // them would only make somebody retype a dead code five times.
  const wrong = notice(claimNotice('wrong_code'))?.text
  const expired = notice(claimNotice('expired'))?.text
  const exhausted = notice(claimNotice('attempts_exhausted'))?.text
  assert.notEqual(wrong, expired)
  assert.notEqual(expired, exhausted)
  assert.notEqual(wrong, exhausted)
})

test('how many guesses are left is never baked into the sentence', () => {
  // It is a fact about one claim that changes on every attempt. The screen
  // reads it back from `attempts` on the row; a number frozen into this string
  // would be wrong the moment somebody opened a second tab.
  assert.doesNotMatch(notice(claimNotice('wrong_code'))?.text ?? '', /\d/)
})

// --------------------------------------------------------- the SQL statuses

test('every status complete_carrier_claim returns is understood', () => {
  const expected: Record<string, ClaimOutcome> = {
    created: 'ok',
    already_claimed: 'already_claimed',
    wrong_code: 'wrong_code',
    expired: 'expired',
    attempts_exhausted: 'attempts_exhausted',
    // The collapse, arriving from the database rather than from the mirror.
    no_claim: 'not_yours',
  }
  for (const [status, outcome] of Object.entries(expected)) {
    assert.equal(claimStatusOutcome(status), outcome, status)
  }
})

test('a status we do not recognise is not guessed at', () => {
  // Null, so the page can say "we could not set that up" rather than picking
  // whichever refusal happens to be first. A future migration that returns a
  // new word must not silently inherit somebody else's sentence.
  assert.equal(claimStatusOutcome('something_new'), null)
  assert.equal(claimStatusOutcome(null), null)
  assert.equal(claimStatusOutcome(''), null)
  // An allow-list that answers to Object.prototype is not an allow-list.
  assert.equal(claimStatusOutcome('constructor'), null)
  assert.equal(claimStatusOutcome('toString'), null)
})

// ----------------------------------------------------------- the rate limits

test('every rate limit start_carrier_claim can refuse on has its own advice', () => {
  // `satisfies` ties this list to the union in claims.ts: a new reason there
  // without a sentence here stops compiling rather than printing nothing.
  const reasons = [
    'cooldown',
    'dot_hour',
    'dot_day',
    'user_hour',
    'user_day',
  ] as const satisfies readonly RateReason[]

  const seen = new Set<string>()
  for (const reason of reasons) {
    const code = claimStartNotice(reason)
    assert.ok(code, `${reason} has no notice code`)
    assert.ok(notice(code), `${reason} maps to ${code}, which the allow-list does not hold`)
    seen.add(notice(code)?.text ?? '')
  }
  // Five limits, five different pieces of advice. "Try again in an hour" and
  // "try again tomorrow" are the whole value of telling somebody which one bit.
  assert.equal(seen.size, reasons.length)
})

test('the manual queue has its own daily ceiling and its own sentence', () => {
  const code = claimStartNotice('manual_day')
  assert.ok(code)
  assert.ok(notice(code))
  assert.notEqual(notice(code)?.text, notice(claimStartNotice('user_day'))?.text)
})

test('a started claim is not a refusal', () => {
  assert.equal(claimStartNotice('started'), null)
  assert.equal(claimStartNotice(null), null)
})

test('an unknown start status still produces something readable', () => {
  // Unlike complete_carrier_claim, there is no "carry on anyway" branch here:
  // the caller is about to send a message, so an answer we cannot read has to
  // stop the flow with a sentence rather than fall through.
  const code = claimStartNotice('a_status_from_the_future')
  assert.ok(notice(code))
  assert.equal(typeof claimStartNotice('constructor'), 'string')
  assert.ok(notice(claimStartNotice('constructor')))
})

// ------------------------------------------------- what the page actually emits

/**
 * Every notice code /app/setup puts into a redirect, read out of the page.
 *
 * Scanned rather than listed, because a hand-kept list is a list that stops
 * matching the page the first time somebody adds a branch — and the failure
 * mode of that drift is invisible: the redirect happens, the bar renders empty,
 * and the customer sees a screen that looks like their click did nothing.
 */
function emittedCodes(): Set<string> {
  const found = new Set<string>()
  const patterns = [
    /\bfail\(\s*'([a-z0-9_]+)'/g,
    /\bbackToChannels\(\s*dot\s*,\s*'([a-z0-9_]+)'/g,
    /\bnotice:\s*'([a-z0-9_]+)'/g,
    // The one branch that chooses between two codes inline: a send that was
    // skipped and a send that was refused are different facts.
    /\bbackToChannels\(\s*dot\s*,\s*[^)]*?'([a-z0-9_]+)'\s*:\s*'([a-z0-9_]+)'/g,
  ]
  for (const pattern of patterns) {
    for (const match of SETUP.matchAll(pattern)) {
      for (const group of match.slice(1)) if (group) found.add(group)
    }
  }
  return found
}

test('every notice code the setup page emits is one the allow-list holds', () => {
  const codes = emittedCodes()
  // A broken scan that matched nothing would pass the loop below in silence.
  assert.ok(codes.size >= 10, `only found ${codes.size} codes — the scan is broken`)
  for (const code of codes) {
    assert.ok(notice(code), `/app/setup redirects with ?notice=${code}, which renders as nothing`)
  }
})

test('the setup page does not carry its own copy of a refusal', () => {
  // The URL used to carry the sentence itself, which let anybody write in our
  // voice on our domain. Codes only, and `notice=` is the only way one reaches
  // the page.
  assert.doesNotMatch(SETUP, /notice=\$\{/)
  assert.doesNotMatch(SETUP, /encodeURIComponent\(\s*(e|err|error)\b/)
})

// ------------------------------------------------------------- the flow itself

test('the setup page claims a carrier only through complete_carrier_claim', () => {
  // 0021 revokes `create_carrier` from `authenticated` precisely so that this
  // is the only door. A direct call here would be dead code after the migration
  // is applied and a bypass before it — which is the state the codebase is in
  // right now, so the test is the thing keeping the shortcut from coming back.
  assert.match(SETUP, /rpc\('complete_carrier_claim'/)
  assert.doesNotMatch(SETUP, /rpc\('create_carrier'/)
  assert.match(SETUP, /rpc\('start_carrier_claim'/)
  assert.match(SETUP, /rpc\('void_carrier_claim'/)
})

test('a failed send kills the claim instead of claiming one was delivered', () => {
  // The claim row is written before the message goes out, so a send that does
  // not land has to be voided — otherwise the next screen says "enter the code
  // we sent you" about a message that never left the building, which is
  // indistinguishable from a landline swallowing a text.
  const send = SETUP.slice(SETUP.indexOf("intent === 'send'"), SETUP.indexOf("intent === 'code'"))
  const failure = send.indexOf("result.status !== 'sent'")
  assert.ok(failure > 0, 'the send branch no longer checks whether the message went out')
  assert.ok(
    send.indexOf("rpc('void_carrier_claim'", failure) > failure,
    'a send that did not go out must void the claim it belongs to',
  )
})

test('manual review still works when CLAIM_CODE_PEPPER is missing', () => {
  // The pepper exists to make a stolen code hash useless, and a manual request
  // holds no code at all — `carrier_claims_hash_matches_channel` in 0021
  // forbids one. So an unconfigured deployment must still be able to queue a
  // human, or the population that has no automatic channel is locked out by a
  // secret that has nothing to do with them.
  const manual = SETUP.slice(
    SETUP.indexOf("intent === 'manual'"),
    SETUP.indexOf("intent === 'send'"),
  )
  assert.ok(manual.length > 0)
  assert.doesNotMatch(manual, /canSendCodes/)

  // Both code paths, by contrast, must refuse before they touch the library —
  // hashClaimCode throws below 32 characters and that throw is a 500.
  const send = SETUP.slice(SETUP.indexOf("intent === 'send'"), SETUP.indexOf("intent === 'code'"))
  const code = SETUP.slice(
    SETUP.indexOf("intent === 'code'"),
    SETUP.indexOf('const params = Astro.url.searchParams'),
  )
  assert.match(send, /if \(!canSendCodes\)/)
  assert.match(code, /if \(!canSendCodes\)/)
})

test('the destination is read from the census, never from the form', () => {
  // A destination that came off the page is a destination the claimant chose,
  // which would make this a way of mailing yourself a code for somebody else's
  // carrier. The form may name a CHANNEL and nothing else.
  const send = SETUP.slice(SETUP.indexOf("intent === 'send'"), SETUP.indexOf("intent === 'code'"))
  assert.match(send, /pickOption\(claimOptions\(census\), String\(form\.get\('channel'\)/)
  // The only form fields this branch may read.
  const fields = [...send.matchAll(/form\.get\('([a-z_]+)'\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(fields)].sort(), ['channel'])
})
