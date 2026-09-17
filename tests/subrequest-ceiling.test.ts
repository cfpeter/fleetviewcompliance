/**
 * The Worker running out of budget is not the provider refusing a message.
 *
 * WHY THIS IS ITS OWN TEST. A Worker gets a fixed number of subrequests per
 * invocation. Cross it and the next `fetch` THROWS rather than returning a bad
 * response, so it escapes `send()` and the digest's whole POST handler, and
 * Cloudflare answers the cron call with an empty 500 — no summary, no log, no
 * clue how far the run got. That is exactly the silent digest the job exists to
 * make impossible, and it is what dev did on 2026-09-17: `sent: 3` one run,
 * empty 500 the next, after a fourth carrier was added.
 *
 * The dangerous fix is the obvious one. Catching the throw and calling it
 * `failed` looks right and is the one outcome that must never happen here: the
 * digest writes a log row for `failed`, `dedup_key` is unique, and a spent key
 * means that deadline is never sent again. Not late — never. A capacity limit
 * would turn into permanent silence about a truck that cannot roll.
 *
 * So the ceiling is `held`: no row, key unspent, next run sends it. These tests
 * pin both halves — that the thing is recognised at all, and that the digest
 * routes it to `held` and stops rather than grinding the remaining carriers
 * into the same wall.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { atSubrequestCeiling, CEILING, sendOrCeiling } from '../src/lib/notify/send.ts'

const digest = readFileSync(new URL('../src/pages/api/cron/digest.ts', import.meta.url), 'utf8')

test('the real Cloudflare message is recognised', () => {
  // Verbatim from the dev Worker log, 2026-09-17. If the runtime ever reworded
  // it, this is the test that goes red instead of the digest going quiet.
  const real = new Error(
    'Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits',
  )
  assert.equal(atSubrequestCeiling(real), true)
})

test('a provider refusing is not the ceiling', () => {
  // The whole point of the distinction. These must stay `failed` — somebody has
  // to go look at the provider, and the message has genuinely been attempted.
  for (const m of [
    'Resend responded 422: invalid from address',
    'Twilio error 21610: recipient replied STOP',
    'fetch failed',
    'network timeout',
    '',
  ]) {
    assert.equal(atSubrequestCeiling(new Error(m)), false, `"${m}" must not read as the ceiling`)
  }
})

test('a non-Error throw is not silently swallowed', () => {
  // Anything that is not an Error is a bug, not a budget, and must keep
  // unwinding. Laundering it into "we'll try later" hides it forever.
  for (const junk of [
    null,
    undefined,
    'too many subrequests',
    { message: 'too many subrequests' },
  ]) {
    assert.equal(atSubrequestCeiling(junk), false)
  }
})

/** Swap the global fetch for the duration of one call, then always put it back. */
async function withFetch<T>(impl: () => never, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = impl as unknown as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

const MESSAGE = { channel: 'email', to: 'x@example.test', body: 'b' } as const
const PROVIDERS = { resendApiKey: 'k', fromEmail: 'f@example.test' }

test('the ceiling comes back as a value instead of unwinding', async () => {
  const got = await withFetch(
    () => {
      throw new Error('Too many subrequests by single Worker invocation.')
    },
    () => sendOrCeiling(MESSAGE, { mode: 'production' }, PROVIDERS),
  )
  assert.equal(got, CEILING)
})

test('every other throw still propagates', async () => {
  // A bug in here must not be laundered into "we will try later". Only the
  // budget is caught; anything else has to reach somebody.
  await assert.rejects(
    withFetch(
      () => {
        throw new Error('a real bug')
      },
      () => sendOrCeiling(MESSAGE, { mode: 'production' }, PROVIDERS),
    ),
    /a real bug/,
  )
})

// --- what the digest does with it -------------------------------------------

test('the digest routes the ceiling to held, never to failed', () => {
  // Read from source because the endpoint cannot be invoked without a Worker
  // runtime and a database, and this is a property of the code.
  const branches = digest.split('if (result === CEILING) {').slice(1)
  assert.equal(branches.length, 2, 'expected the email and SMS sends to both handle the ceiling')

  for (const b of branches) {
    const body = b.slice(0, b.indexOf('\n        }'))
    assert.match(body, /summary\.held \+=/, 'the ceiling must be counted as held')
    assert.doesNotMatch(body, /summary\.failed/, 'the ceiling must never be counted as failed')
    assert.doesNotMatch(body, /notification_log/, 'the ceiling must not write a log row')
    assert.match(body, /break carriers/, 'the run must stop rather than hit the same wall again')
  }
})

test('the carrier loop is labelled, so the break reaches it', () => {
  // `break` without the label would leave the member loop and carry on with the
  // next carrier — straight back into the wall, for every carrier remaining.
  assert.match(digest, /carriers: for \(const carrier of carriers/)
})

test('the run reports that it stopped early', () => {
  // A run that silently did half the work is the failure this whole endpoint is
  // built to prevent. The flag is what the workflow reads.
  assert.match(digest, /exhausted: false/)
  assert.match(digest, /summary\.exhausted = true/)
})

test('the workflow surfaces exhaustion', () => {
  const wf = readFileSync(new URL('../.github/workflows/digest.yml', import.meta.url), 'utf8')
  assert.match(wf, /exhausted=\$\(jq/, 'the workflow must parse the flag')
  assert.match(wf, /::warning::.*subrequest limit/, 'and say so where a person will see it')
})
