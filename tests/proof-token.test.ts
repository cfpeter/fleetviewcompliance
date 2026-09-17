/**
 * The proof-link token is the only thing standing between an anonymous request
 * and a carrier's driver files, so these tests are about the credential, not
 * about a string format.
 *
 * Every assertion below names the failure it is there to catch. A token test
 * that only checks `typeof token === 'string'` passes happily against
 * `Math.random().toString(36)`, which is the bug worth being afraid of.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { isProofToken, newProofToken, TOKEN_BYTES, TOKEN_LENGTH } from '../src/lib/proof/token.ts'

test('a token is 43 characters, which is 256 bits rendered', () => {
  // The constant and the arithmetic are checked separately, because the failure
  // that matters is someone "tidying" TOKEN_BYTES down to 16 and the length
  // constant following along quietly.
  assert.equal(TOKEN_BYTES, 32, '32 bytes is the floor; anything less is a shorter guess')
  assert.equal(TOKEN_LENGTH, 43, 'ceil(32 * 8 / 6)')
  assert.equal(newProofToken().length, TOKEN_LENGTH)
})

test('every character is URL-safe, with no padding', () => {
  // base64 (not -url) emits `+` and `/`. In a path segment `/` invents a route
  // boundary and `+` is rewritten to a space by some proxies, so the broker gets
  // a 404 on a link that is perfectly valid in the database.
  for (let i = 0; i < 2000; i++) {
    const token = newProofToken()
    assert.match(token, /^[A-Za-z0-9_-]+$/, `not URL-safe: ${token}`)
    assert.ok(!token.includes('='), `padding leaked into the URL: ${token}`)
  }
})

test('no duplicates across a large sample', () => {
  // A collision here does not mean bad luck — at 256 bits it would take more
  // tokens than there are atoms available. It means the generator is seeded,
  // counter-based, or has fallen back to something that is not a CSPRNG.
  const count = 50_000
  const seen = new Set<string>()
  for (let i = 0; i < count; i++) seen.add(newProofToken())
  assert.equal(seen.size, count, 'two tokens came out the same; the generator is not random')
})

test('two tokens minted in the same instant differ', () => {
  // The specific bug: a token derived from Date.now(), a counter, or a uuid v7.
  // Those all look random in a list and are trivially predictable in a loop.
  // Generating in a tight loop means the clock does not tick between them.
  const burst = Array.from({ length: 200 }, () => newProofToken())
  assert.equal(new Set(burst).size, burst.length, 'the token tracks the clock or a counter')

  // And nothing in it should be a stable prefix — a derived token usually shares
  // its leading characters with its neighbours.
  const firstChars = new Set(burst.map((t) => t.slice(0, 4)))
  assert.ok(firstChars.size > 190, 'tokens share a prefix, so they encode something in common')
})

test('the whole alphabet is reachable', () => {
  // An encoder bug — a wrong shift, an off-by-one in the table — usually shows up
  // as characters that can never be emitted. That is silently lost entropy: the
  // token still looks fine and the search space is a fraction of what it claims.
  const seen = new Set<string>()
  for (let i = 0; i < 5000; i++) for (const ch of newProofToken()) seen.add(ch)
  assert.equal(seen.size, 64, `only ${seen.size} of the 64 base64url characters ever appear`)
})

test('the hand-written encoder agrees with a reference implementation', () => {
  // The encoder is written out by hand because the Worker runtime has no Buffer.
  // Node does, so the test runner can hold it to the standard: if this ever
  // disagrees, the tokens are not the bytes we think they are.
  //
  // Round-tripping also proves the rendering is lossless, i.e. that all 32 bytes
  // survive into the string rather than 24 of them.
  for (let i = 0; i < 500; i++) {
    const token = newProofToken()
    const bytes = Buffer.from(token, 'base64url')
    assert.equal(bytes.length, TOKEN_BYTES, 'the token does not carry 32 bytes')
    assert.equal(bytes.toString('base64url'), token, 'encoder disagrees with Buffer')
  }
})

test('a missing CSPRNG throws instead of quietly degrading', () => {
  // The failure mode this guards is a silent fallback to Math.random in a
  // runtime that lacks the global. A thrown error is a link that visibly fails
  // to create; a weak token is a link that works perfectly for the attacker too.
  const real = globalThis.crypto
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
    assert.throws(() => newProofToken(), /CSPRNG|getRandomValues/)
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true })
  }
  // And the restore actually worked, so a later test is not running blind.
  assert.equal(newProofToken().length, TOKEN_LENGTH)
})

test('the link the owner copies is built from the request origin, not from build-time config', () => {
  // A perfect token on the wrong host is still a 404, and this is the half of the
  // link no other test can see: the page renders, the token validates, and the
  // broker who was sent the address gets nothing.
  //
  // FAILURE PINNED: `import.meta.env.PUBLIC_SITE_URL || Astro.url.origin`, which
  // shipped. Vite inlines that value when the bundle is built, so the dev
  // deployment printed the production domain under every link it minted — an
  // address where the same token does not exist. There is no secret or variable
  // that can correct it afterwards; the string is already in the bundle.
  //
  // Asserted against the source because the mistake is a source-level one: any
  // build made from a file containing that expression is already wrong.
  const page = readFileSync(new URL('../src/pages/app/proof.astro', import.meta.url), 'utf8')

  assert.match(
    page,
    /^const base = Astro\.url\.origin$/m,
    'the copyable link must start from the origin of the request the owner is looking at',
  )
  assert.ok(
    !page.includes('import.meta.env.PUBLIC_SITE_URL'),
    'PUBLIC_SITE_URL is inlined at build time; one build serves dev and production both',
  )
  assert.match(
    page,
    /\$\{base\}\/proof\/\$\{token\}/,
    'the displayed address no longer uses `base`; check what it is built from instead',
  )

  // Since 0026_share_token_hash.sql the address is assembled ONCE, in the POST
  // that mints the token, because the database keeps sha256(token) and the page
  // cannot rebuild a link afterwards. `${base}/proof/${l.token}` — a row from
  // the list — is therefore not merely a different spelling of the same thing:
  // it cannot compile, and if it ever comes back it means the plaintext token
  // is being stored again.
  assert.ok(
    !page.includes('l.token'),
    'the list is printing a token from the database; the column should only hold a hash',
  )
})

test('isProofToken accepts our own output and rejects near-misses', () => {
  assert.ok(isProofToken(newProofToken()))

  // Everything below is something a hand-edited URL or an old link can produce,
  // and each must be turned away before it reaches the database.
  assert.ok(!isProofToken(''), 'an empty token is not a token')
  assert.ok(!isProofToken(newProofToken().slice(0, 42)), 'one character short is not ours')
  assert.ok(!isProofToken(`${newProofToken()}a`), 'one character long is not ours')
  assert.ok(!isProofToken(`${newProofToken().slice(0, 42)}/`), 'a slash never appears in base64url')
  assert.ok(!isProofToken(`${newProofToken().slice(0, 42)}+`), 'a plus never appears in base64url')
  assert.ok(!isProofToken(null), 'null is not a string')
  assert.ok(!isProofToken(undefined), 'undefined is not a string')
  // A uuid is the shape of a mistaken paste: the row id instead of the token.
  assert.ok(!isProofToken('3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'))
})
