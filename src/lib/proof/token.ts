/**
 * The credential behind a proof link.
 *
 * A proof link is opened by a broker or an underwriter who has no account, no
 * password and no session. There is no second factor behind the token — the
 * token IS the authentication — so guessing one is an unauthenticated read of
 * another carrier's driver qualification file. Everything in this file exists to
 * make that guess impossible rather than merely difficult.
 *
 * Three rules, and every one of them has been broken in shipped software:
 *
 *   1. CSPRNG ONLY. `Math.random()` is a fast non-cryptographic PRNG (V8 uses
 *      xorshift128+). Its internal state is 128 bits and it is recoverable from
 *      a handful of consecutive outputs, after which every future AND past value
 *      is computable. A `Math.random()` token is therefore not a secret: it is a
 *      counter with extra steps, and one leaked link hands over the rest.
 *   2. ENOUGH OF IT. 32 bytes / 256 bits. The table's only defence against
 *      enumeration is the size of the space, since an anonymous reader can hit
 *      `resolve_share_token` as often as they like.
 *   3. DERIVED FROM NOTHING. No carrier id, no driver id, no timestamp, no
 *      counter, not even a hash of them. A token that encodes something leaks
 *      that something to anyone holding the token, and it makes neighbouring
 *      tokens guessable from one sample. The bytes here come from the operating
 *      system's entropy pool and nowhere else.
 *
 * Rendering is base64url — the RFC 4648 §5 alphabet, `A-Za-z0-9-_`, unpadded.
 * Every character in it is an unreserved URL character, so the token drops into
 * a path segment with no escaping: nothing here can be mangled by a copy-paste
 * through a mail client, and `%2F` never appears in a link a broker has to click.
 * (Plain base64 would put `+` and `/` in the path, which is exactly that bug.)
 */

/**
 * RFC 4648 §5. Order matters — this is a positional table, not a set — and the
 * last two entries are the whole difference from standard base64.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** 256 bits. See rule 2 above. */
export const TOKEN_BYTES = 32

/**
 * 43 characters: ceil(32 * 8 / 6). Exported so the page and any validator agree
 * on the shape without re-deriving the arithmetic and getting it wrong by one.
 */
export const TOKEN_LENGTH = Math.ceil((TOKEN_BYTES * 8) / 6)

/** Built from the constant rather than typed out, so the two cannot drift apart. */
const TOKEN_SHAPE = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`)

/**
 * Random bytes, or an exception — never a fallback.
 *
 * The tempting shape here is `crypto?.getRandomValues(...) ?? mathRandomBytes()`
 * so the module "works everywhere". That fallback is the vulnerability: it fires
 * silently, in whichever runtime happens to lack the global, and the resulting
 * links look identical to good ones. A thrown error surfaces as a failed link
 * creation the owner can see and report. A weak token surfaces as nothing at all
 * until somebody else is reading the files.
 *
 * Both runtimes this ships to have it: Web Crypto is a global in the Cloudflare
 * Worker runtime and has been a global in Node since 19.
 */
function randomBytes(count: number): Uint8Array {
  const source = globalThis.crypto
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error(
      'crypto.getRandomValues is unavailable; refusing to mint a proof-link token without a CSPRNG.',
    )
  }
  return source.getRandomValues(new Uint8Array(count))
}

/**
 * base64url, unpadded, written out by hand.
 *
 * Not `Buffer.from(bytes).toString('base64url')`: Buffer does not exist in the
 * Worker runtime, and a token generator that throws in production but passes in
 * the test runner is worse than no generator. Not `btoa` either — it takes a
 * latin1 STRING, so it needs a byte-to-string dance first, and every variant of
 * that dance has a documented way of corrupting bytes above 0x7f.
 *
 * The `=` padding is dropped because it is not information — the length already
 * says how many bytes there were — and `=` in a URL path is noise that some
 * link-scanners escape.
 */
function base64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    // How many real bytes this group has. Compared against the length rather
    // than testing `bytes[i + 1] === undefined`: without noUncheckedIndexedAccess
    // TypeScript types an out-of-range index as `number`, so that comparison is
    // both a compile error and — if it were allowed — a lie.
    const remaining = bytes.length - i
    const b0 = bytes[i]
    const b1 = remaining > 1 ? bytes[i + 1] : 0
    const b2 = remaining > 2 ? bytes[i + 2] : 0

    out += ALPHABET[b0 >> 2]
    out += ALPHABET[((b0 & 0b11) << 4) | (b1 >> 4)]
    if (remaining === 1) break
    out += ALPHABET[((b1 & 0b1111) << 2) | (b2 >> 6)]
    if (remaining === 2) break
    out += ALPHABET[b2 & 0b111111]
  }
  return out
}

/**
 * A fresh proof-link token.
 *
 * Takes no arguments, deliberately. A signature like
 * `newProofToken(carrierId, driverId)` invites exactly the derivation rule 3
 * forbids, and reviewers stop asking what the arguments are used for.
 */
export function newProofToken(): string {
  return base64url(randomBytes(TOKEN_BYTES))
}

/**
 * Shape check only — it says "this could be one of ours", never "this is valid".
 *
 * Validity lives in the database (`resolve_share_token` refuses revoked and
 * expired links), and it must stay there. This is for rejecting obvious
 * rubbish early, so a hand-typed URL is a clean 404 instead of a round trip.
 */
export function isProofToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value)
}
