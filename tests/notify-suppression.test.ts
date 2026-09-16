/**
 * The silent delivery failure.
 *
 * Resend answers HTTP 200 with a message id for an address it has suppressed,
 * and then drops the mail. Every test here guards one of the derivations that
 * turn that into something a person finds out about — and NONE of them touch the
 * live API: the behaviour was measured once, written down in
 * src/lib/notify/suppression.ts, and a test that re-measured it would be a test
 * that fails when Resend is having a bad afternoon.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { send } from '../src/lib/notify/send.ts'
import {
  deliveryStateFor,
  fetchSuppressions,
  isSuppressed,
  normalizeAddress,
  parseSuppressionList,
} from '../src/lib/notify/suppression.ts'

const PRODUCTION = { mode: 'production' }
const PROVIDERS = { resendApiKey: 'test-key-never-used', fromEmail: 'info@fleetview.test' }

/** A fetch that fails the test if it is ever reached. */
const noNetwork: typeof fetch = () => {
  throw new Error('a test must never call the live provider')
}

// ------------------------------------------------------ reading the list

test('the list is read out of the envelope the API actually returns', () => {
  const payload = {
    object: 'list',
    data: [
      { id: '1', email: 'bounced@carrier.example', origin: 'bounce', created_at: 'x' },
      { id: '2', email: 'gone@carrier.example', origin: 'bounce', created_at: 'x' },
    ],
  }
  assert.deepEqual([...parseSuppressionList(payload)].sort(), [
    'bounced@carrier.example',
    'gone@carrier.example',
  ])
})

test('a bare array parses too, because the wrong guess returns an EMPTY set', () => {
  // And an empty set is indistinguishable from "nothing is suppressed", which
  // silently re-opens the hole with no error anywhere.
  assert.deepEqual([...parseSuppressionList([{ email: 'a@b.test' }])], ['a@b.test'])
  assert.equal(parseSuppressionList(null).size, 0)
  assert.equal(parseSuppressionList({ data: 'nonsense' }).size, 0)
  assert.equal(parseSuppressionList({ data: [{ id: 'no email here' }] }).size, 0)
})

// ------------------------------------------------------ case insensitivity

test('an address list is not case-sensitive', () => {
  // RFC 5321 permits a case-sensitive local part; no mail provider implements
  // one. A suppression is a fact about a mailbox, not about a spelling — and
  // without this, Bob@X.com sails straight past a suppression recorded as
  // bob@x.com and the message is silently dropped all over again.
  const list = parseSuppressionList({ data: [{ email: 'bob@x.com' }] })
  assert.equal(isSuppressed(list, 'Bob@X.com'), true)
  assert.equal(isSuppressed(list, 'BOB@X.COM'), true)
  assert.equal(isSuppressed(list, '  bob@x.com  '), true, 'stray whitespace is not a new address')
  assert.equal(isSuppressed(list, 'bobby@x.com'), false)
})

test('a list stored in mixed case still matches a lowercase send', () => {
  // The other direction of the same bug: the API is the one holding the odd
  // spelling, and our profile row is lowercase.
  const list = parseSuppressionList({ data: [{ email: 'Owner@Carrier.Example' }] })
  assert.equal(isSuppressed(list, 'owner@carrier.example'), true)
})

test('normalizeAddress is the single definition of that comparison', () => {
  assert.equal(normalizeAddress('  Bob@X.com '), 'bob@x.com')
})

test('a list we could not read means SEND, never hold', () => {
  // One provider blip must not be able to silence every deadline warning in the
  // product. The reconciliation pass is the backstop for whatever this misses.
  assert.equal(isSuppressed(null, 'anyone@carrier.example'), false)
  assert.equal(isSuppressed(undefined, 'anyone@carrier.example'), false)
})

test('an unreachable suppressions endpoint reports null, and never the key', async () => {
  const boom: typeof fetch = () => Promise.reject(new Error('ECONNRESET'))
  const result = await fetchSuppressions('re_super_secret_key', boom)
  assert.equal(result.list, null)
  assert.ok(!String(result.error).includes('re_super_secret_key'), 'the key must never be logged')
})

test('a non-2xx suppressions response reports null, and never the key', async () => {
  const unauthorized: typeof fetch = () => Promise.resolve(new Response('nope', { status: 401 }))
  const result = await fetchSuppressions('re_super_secret_key', unauthorized)
  assert.equal(result.list, null)
  assert.match(String(result.error), /401/)
  assert.ok(!String(result.error).includes('re_super_secret_key'))
})

test('no key configured is not an empty list', async () => {
  // An empty Set would read as "checked, nothing suppressed". Null is the truth.
  assert.equal((await fetchSuppressions(undefined, noNetwork)).list, null)
})

// ------------------------------------------------------ last_event mapping

test('last_event maps to the state the reconciliation stores', () => {
  // `suppressed` is the measured one: queued at +0s, suppressed at +2s and +6s.
  assert.equal(deliveryStateFor('suppressed'), 'undelivered')
  assert.equal(deliveryStateFor('bounced'), 'undelivered')
  assert.equal(deliveryStateFor('canceled'), 'undelivered')
  assert.equal(deliveryStateFor('failed'), 'undelivered')
  assert.equal(deliveryStateFor('delivered'), 'delivered')
})

test('a complaint is NOT an undelivered message', () => {
  // It arrived and the reader pressed "spam". Folding it into `undelivered`
  // would re-send to somebody who already has it and marked us as junk, which is
  // how a sending domain is burned.
  assert.equal(deliveryStateFor('complained'), 'complained')
})

test('an in-flight event is unknown, not a delivery and not a failure', () => {
  // The whole reason this is a later pass: an immediate check after the POST
  // reads `queued` every time. Reading that as delivered would spend the dedup
  // key on a message whose fate nobody knows yet.
  for (const event of ['queued', 'scheduled', 'sent', 'delivery_delayed']) {
    assert.equal(deliveryStateFor(event), 'unknown', event)
  }
})

test('an event we do not recognise is unknown, never a guess', () => {
  // Guessing `delivered` burns the key on a message we cannot prove arrived.
  // Guessing `undelivered` re-sends to somebody who already got it.
  for (const event of ['some_new_resend_event', '', null, undefined, '   ']) {
    assert.equal(deliveryStateFor(event), 'unknown', String(event))
  }
})

test('the mapping does not care about the provider shouting', () => {
  assert.equal(deliveryStateFor('Suppressed'), 'undelivered')
  assert.equal(deliveryStateFor(' DELIVERED '), 'delivered')
})

// ------------------------------------------------------ send() refuses

test('a suppressed recipient is NOT recorded as sent', async () => {
  // The bug in one line. Before this, send() posted to Resend, got its 200 with
  // an id, and returned `sent` for a message nobody would ever read.
  const list = parseSuppressionList({ data: [{ email: 'gone@carrier.example' }] })
  const result = await send(
    { channel: 'email', to: 'gone@carrier.example', subject: 's', body: 'b' },
    PRODUCTION,
    PROVIDERS,
    { suppressedEmails: list },
  )
  assert.equal(result.status, 'suppressed')
  assert.notEqual(result.status, 'sent')
  assert.equal(result.providerMessageId, undefined, 'nothing was sent, so there is no id')
})

test('a suppressed recipient never reaches the provider at all', async () => {
  // Not merely reported differently — the POST does not happen. A send that goes
  // out and is then dropped still costs reputation on a suppressed address.
  const globalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (() => {
    calls++
    return Promise.resolve(new Response('{"id":"should-not-happen"}', { status: 200 }))
  }) as typeof fetch
  try {
    const list = parseSuppressionList({ data: [{ email: 'gone@carrier.example' }] })
    await send({ channel: 'email', to: 'GONE@carrier.example', body: 'b' }, PRODUCTION, PROVIDERS, {
      suppressedEmails: list,
    })
  } finally {
    globalThis.fetch = globalFetch
  }
  assert.equal(calls, 0)
})

test('THE ADDRESS CHECKED IS THE ADDRESS IT WOULD ACTUALLY GO TO', async () => {
  // The dev trap. Outside production the guard rewrites every recipient to the
  // developer. A check against `message.to` would examine the carrier's address
  // and then send to the developer's — so the one address whose suppression
  // matters would never be looked at, and a developer whose own inbox had
  // bounced would keep seeing clean runs forever.
  const dev = { mode: 'development', redirectEmail: 'dev@local.test' }
  const carrierSuppressed = parseSuppressionList({ data: [{ email: 'owner@carrier.example' }] })
  const devSuppressed = parseSuppressionList({ data: [{ email: 'dev@local.test' }] })

  const whenDevIsSuppressed = await send(
    { channel: 'email', to: 'owner@carrier.example', body: 'b' },
    dev,
    {},
    { suppressedEmails: devSuppressed },
  )
  assert.equal(whenDevIsSuppressed.status, 'suppressed', 'the redirect target is what is checked')

  // And the mirror: the carrier's suppression is irrelevant on dev, because the
  // carrier is not who the message is going to.
  const whenCarrierIsSuppressed = await send(
    { channel: 'email', to: 'owner@carrier.example', body: 'b' },
    dev,
    {},
    { suppressedEmails: carrierSuppressed },
  )
  assert.notEqual(whenCarrierIsSuppressed.status, 'suppressed')
})

test('the suppression check runs behind the guard, never in front of it', async () => {
  // A refused send stays `skipped`. If suppression were checked first, an
  // unconfigured environment could report `suppressed` — which writes no log row
  // for a different reason and would make the two indistinguishable in the
  // summary the operator reads.
  const list = parseSuppressionList({ data: [{ email: 'owner@carrier.example' }] })
  const result = await send(
    { channel: 'email', to: 'owner@carrier.example', body: 'b' },
    { mode: 'development' },
    PROVIDERS,
    { suppressedEmails: list },
  )
  assert.equal(result.status, 'skipped')
  assert.match(String(result.detail), /refusing to send/)
})

test('SMS is not measured against an email suppression list', async () => {
  // Different provider, different namespace. A phone number cannot be on
  // Resend's list, and consulting it for SMS would only be a way to match
  // something by accident.
  const list = parseSuppressionList({ data: [{ email: '+13105550101' }] })
  const result = await send(
    { channel: 'sms', to: '+13105550101', body: 'b' },
    PRODUCTION,
    {},
    { suppressedEmails: list },
  )
  assert.equal(result.status, 'skipped', 'no twilio configured — but NOT suppressed')
})

// --------------------------------------------- the dedup key is not spent

test('a suppressed message leaves its dedup key unspent', async () => {
  // THE POINT OF THE WHOLE EXERCISE, and the reason `suppressed` is its own
  // status rather than a kind of `failed`.
  //
  // The digest writes a notification_log row for every outcome EXCEPT this one
  // and `held`, and `alreadySent` matches on dedup_key. A row written here spends
  // the key on a send that never happened, and the carrier can then never be told
  // about that deadline — not even after the address is fixed. Not late. Never.
  //
  // This asserts the contract the digest branches on: `suppressed` is distinct
  // from `sent`, so the `if (result.status === 'suppressed')` arm that skips the
  // log write cannot be reached by any other outcome.
  const list = parseSuppressionList({ data: [{ email: 'gone@carrier.example' }] })
  const sentKeys = new Set<string>()
  const key = 'user-1|MEDICAL_CERT|driver-9|2026-11-01|30|email'

  const result = await send(
    { channel: 'email', to: 'gone@carrier.example', body: 'b' },
    PRODUCTION,
    PROVIDERS,
    { suppressedEmails: list },
  )
  // The digest's rule, restated: only a genuine send writes the key.
  if (result.status === 'sent') sentKeys.add(key)

  assert.equal(sentKeys.has(key), false, 'the key must survive for the next run')
})

test('a send that DID go out spends its key and carries an id to reconcile', async () => {
  // The other half of the same rule — otherwise a test suite that only ever
  // asserts the refusal would pass with send() broken to refuse everything.
  const globalFetch = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.resolve(new Response('{"id":"re_abc123"}', { status: 200 }))) as typeof fetch
  let result: Awaited<ReturnType<typeof send>>
  try {
    result = await send(
      { channel: 'email', to: 'owner@carrier.example', body: 'b' },
      PRODUCTION,
      PROVIDERS,
      { suppressedEmails: new Set<string>() },
    )
  } finally {
    globalThis.fetch = globalFetch
  }
  assert.equal(result.status, 'sent')
  // Without the id, GET /emails/{id} has nothing to ask about and the
  // reconciliation half of the defence has nothing to reconcile.
  assert.equal(result.providerMessageId, 're_abc123')
})

test('a 200 with no id is flagged rather than passed off as a clean send', async () => {
  // An unreconcilable send is a send that can fail silently forever, which is
  // the exact shape of the bug this file exists to close.
  const globalFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.resolve(new Response('{}', { status: 200 }))) as typeof fetch
  try {
    const result = await send(
      { channel: 'email', to: 'owner@carrier.example', body: 'b' },
      PRODUCTION,
      PROVIDERS,
    )
    assert.equal(result.providerMessageId, undefined)
    assert.match(String(result.detail), /reconcile/)
  } finally {
    globalThis.fetch = globalFetch
  }
})
