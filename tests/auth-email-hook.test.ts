/**
 * The Supabase Send Email Hook endpoint.
 *
 * TWO THINGS ARE BEING PROVED HERE, and the second one is the reason the first
 * one matters.
 *
 * 1. THE SIGNATURE IS REAL. /api/auth/email is a public URL with no session in
 *    front of it — src/middleware.ts exempts it deliberately, because Supabase
 *    has no signed-in user to present. If the signature check were decorative,
 *    anyone on the internet could make this product send email, from our
 *    verified domain, carrying a real-looking confirmation link, to any address
 *    they liked. So a forged signature, a stale timestamp and a tampered body
 *    are each driven through the REAL route handler and must be refused, and a
 *    genuine one must be accepted.
 *
 * 2. THE GUARD APPLIES TO AUTH EMAIL NOW. The whole point of the hook is that
 *    Supabase stops sending these itself and hands them to us, so that
 *    src/lib/notify/guard.ts — the one place — gets to rewrite the recipient.
 *    The test asserts on the actual outbound Resend request: on dev the address
 *    in it is the developer's, and the carrier's own address appears nowhere.
 *
 * `PUBLIC_SUPABASE_URL` is set on every path below and must stay that way. The
 * route falls back to `import.meta.env.PUBLIC_SUPABASE_URL`, which Vite replaces
 * with a literal in the Worker build but which is simply `undefined` under
 * `node --test`; the `??` only short-circuits past it while the process.env
 * value is present.
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import type { APIContext } from 'astro'
import {
  actionLink,
  composeAuthEmails,
  HOOK_TOLERANCE_SECONDS,
  type HookEmailData,
  type HookUser,
  hookSecretBytes,
  SUPABASE_EMAIL_ACTIONS,
  signWebhook,
} from '../src/lib/auth/email-hook.ts'
import { GET, POST } from '../src/pages/api/auth/email.ts'

const SECRET_B64 = btoa('fleetview-send-email-hook-test-secret')
const SECRET = `v1,whsec_${SECRET_B64}`
const OTHER_SECRET = `v1,whsec_${btoa('a-completely-different-secret-value')}`

const CARRIER = 'owner@realcarrier.example'
const DEVELOPER = 'cfbedo@yahoo.example'
const SUPABASE_URL = 'https://abcdefghij.supabase.co'
const CALLBACK = 'https://dev.fleetviewcompliance.com/auth/callback'

function bytes(secret: string): Uint8Array {
  const out = hookSecretBytes(secret)
  if (!out) throw new Error('the test secret does not decode')
  return out
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Captured {
  url: string
  body: { to?: string[]; subject?: string; text?: string; from?: string }
}

let captured: Captured[] = []
const realFetch = globalThis.fetch

const ENV_KEYS = [
  'SEND_EMAIL_HOOK_SECRET',
  'DEPLOY_ENV',
  'DEV_REDIRECT_EMAIL',
  'DEV_REDIRECT_PHONE',
  'RESEND_API_KEY',
  'DIGEST_FROM_EMAIL',
  'PUBLIC_SUPABASE_URL',
] as const
const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  captured = []
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key]

  // A non-production environment with a redirect configured: the normal dev
  // deployment, and the case the owner asked to see proved.
  process.env.SEND_EMAIL_HOOK_SECRET = SECRET
  process.env.DEPLOY_ENV = 'development'
  process.env.DEV_REDIRECT_EMAIL = DEVELOPER
  process.env.RESEND_API_KEY = 're_test_key'
  process.env.DIGEST_FROM_EMAIL = 'info@fleetviewcompliance.com'
  process.env.PUBLIC_SUPABASE_URL = SUPABASE_URL

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Captured['body'],
    })
    return new Response(JSON.stringify({ id: 'resend-message-id' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

function payloadFor(
  action: string,
  data: Partial<HookEmailData> = {},
  user: Partial<HookUser> = {},
): string {
  return JSON.stringify({
    user: {
      id: '4f8b2e3a-1c9d-4f6a-8b2e-3a1c9d4f6a8b',
      email: CARRIER,
      ...user,
    },
    email_data: {
      token: '123456',
      token_hash: 'pkce_9f1c2d3e4a5b6c7d',
      redirect_to: CALLBACK,
      email_action_type: action,
      site_url: SUPABASE_URL,
      ...data,
    },
  })
}

/** POST the payload at the real handler, signed the way Supabase signs it. */
async function post(
  payload: string,
  opts: {
    /** Sign this instead, to model a body tampered with after signing. */
    signedPayload?: string
    secret?: string
    id?: string
    timestampSeconds?: number
    signature?: string
    headers?: Record<string, string>
  } = {},
): Promise<Response> {
  const id = opts.id ?? 'msg_2f6Q8vZ1'
  const timestamp = opts.timestampSeconds ?? Math.floor(Date.now() / 1000)
  const signature =
    opts.signature ??
    `v1,${await signWebhook({
      payload: opts.signedPayload ?? payload,
      id,
      timestamp,
      secret: bytes(opts.secret ?? SECRET),
    })}`

  const request = new Request('https://dev.fleetviewcompliance.com/api/auth/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': signature,
      ...(opts.headers ?? {}),
    },
    body: payload,
  })
  return POST({ request } as unknown as APIContext) as Promise<Response>
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { message?: string } }
  return body.error?.message ?? ''
}

// ---------------------------------------------------------------------------
// The secret
// ---------------------------------------------------------------------------

test('the signing secret is decoded to BYTES, in every spelling the dashboard uses', () => {
  // standard-webhooks base64-decodes the secret into the HMAC key. Signing with
  // the literal string — which is what Stripe does with its own secret — would
  // produce a signature that never matches anything Supabase sends.
  const expected = new TextEncoder().encode('fleetview-send-email-hook-test-secret')
  for (const spelling of [SECRET, `whsec_${SECRET_B64}`, SECRET_B64]) {
    assert.deepEqual(hookSecretBytes(spelling), expected, spelling.slice(0, 12))
  }
})

test('an absent or unusable secret yields no key at all', () => {
  for (const junk of [undefined, null, '', '   ', 'v1,whsec_', 'not base 64 at all!!']) {
    assert.equal(hookSecretBytes(junk), null, String(junk))
  }
})

// ---------------------------------------------------------------------------
// Signature verification, through the real route handler
// ---------------------------------------------------------------------------

test('a genuine signature is accepted and the email is sent', async () => {
  const res = await post(payloadFor('signup'))
  assert.equal(res.status, 200)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].url, 'https://api.resend.com/emails')
})

test('a signature made with the wrong secret is refused, and nothing is sent', async () => {
  const res = await post(payloadFor('signup'), { secret: OTHER_SECRET })
  assert.equal(res.status, 401)
  assert.match(await errorMessage(res), /signature mismatch/)
  assert.equal(captured.length, 0)
})

test('a stale timestamp is refused even with a perfect signature', async () => {
  // Signed correctly for a timestamp outside the window: this is a captured
  // request being replayed, which is exactly what the window exists to stop.
  const old = Math.floor(Date.now() / 1000) - (HOOK_TOLERANCE_SECONDS + 60)
  const res = await post(payloadFor('signup'), { timestampSeconds: old })
  assert.equal(res.status, 401)
  assert.match(await errorMessage(res), /timestamp outside tolerance/)
  assert.equal(captured.length, 0)
})

test('a timestamp from the future is refused too', async () => {
  const ahead = Math.floor(Date.now() / 1000) + (HOOK_TOLERANCE_SECONDS + 60)
  const res = await post(payloadFor('signup'), { timestampSeconds: ahead })
  assert.equal(res.status, 401)
  assert.equal(captured.length, 0)
})

test('a body edited after signing is refused', async () => {
  // The attack this stops: a real signed request is intercepted and the
  // recipient swapped for somebody else's address. The signature covers the raw
  // body, so the edit breaks it.
  const genuine = payloadFor('signup')
  const tampered = payloadFor('signup', {}, { email: 'attacker@example.com' })
  const res = await post(tampered, { signedPayload: genuine })
  assert.equal(res.status, 401)
  assert.match(await errorMessage(res), /signature mismatch/)
  assert.equal(captured.length, 0)
})

test('a missing signature header is refused', async () => {
  const payload = payloadFor('signup')
  const request = new Request('https://dev.fleetviewcompliance.com/api/auth/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  })
  const res = (await POST({ request } as unknown as APIContext)) as Response
  assert.equal(res.status, 401)
  assert.match(await errorMessage(res), /webhook-id/)
  assert.equal(captured.length, 0)
})

test('a timestamp that is not unix seconds is refused', async () => {
  // The Supabase documentation calls this header an ISO 8601 timestamp; the
  // specification and the reference implementation both say integer seconds,
  // and an ISO string must not be quietly coerced into one.
  const res = await post(payloadFor('signup'), { headers: {}, timestampSeconds: 0 })
  assert.equal(res.status, 401)

  const payload = payloadFor('signup')
  const iso = new Date().toISOString()
  const bad = await post(payload, { headers: { 'webhook-timestamp': iso } })
  assert.equal(bad.status, 401)
  assert.match(await errorMessage(bad), /not unix seconds/)
  assert.equal(captured.length, 0)
})

test('one good signature among several is enough — a rotation in flight', async () => {
  const payload = payloadFor('signup')
  const id = 'msg_rotation'
  const timestamp = Math.floor(Date.now() / 1000)
  const stale = await signWebhook({ payload, id, timestamp, secret: bytes(OTHER_SECRET) })
  const fresh = await signWebhook({ payload, id, timestamp, secret: bytes(SECRET) })
  const res = await post(payload, {
    id,
    timestampSeconds: timestamp,
    signature: `v1,${stale} v1,${fresh}`,
  })
  assert.equal(res.status, 200)
  assert.equal(captured.length, 1)
})

test('with no secret configured the endpoint refuses before reading the body', async () => {
  process.env.SEND_EMAIL_HOOK_SECRET = ''
  const res = await post(payloadFor('signup'))
  assert.equal(res.status, 500)
  assert.match(await errorMessage(res), /SEND_EMAIL_HOOK_SECRET/)
  assert.equal(captured.length, 0)
})

test('a GET is refused — a prefetch must not reach this endpoint', async () => {
  const res = (await GET({} as unknown as APIContext)) as Response
  assert.equal(res.status, 405)
})

// ---------------------------------------------------------------------------
// The guard — the whole reason the hook exists
// ---------------------------------------------------------------------------

test('outside production an auth email goes to the developer, never to the carrier', async () => {
  const res = await post(payloadFor('signup'))
  assert.equal(res.status, 200)

  assert.equal(captured.length, 1)
  assert.deepEqual(captured[0].body.to, [DEVELOPER])
  // Not merely "the recipient was replaced": the carrier's address must not be
  // anywhere in the outbound request, subject and body included.
  assert.ok(
    !JSON.stringify(captured[0].body).includes(CARRIER),
    'the carrier address leaked into the outbound message',
  )

  // And the hook's own answer says so, which is what a dev hook log shows.
  const body = (await res.json()) as { notes?: string[] }
  assert.match(String(body.notes?.[0]), /redirected from owner@realcarrier\.example/)
})

test('in production the real address is used', async () => {
  process.env.DEPLOY_ENV = 'production'
  const res = await post(payloadFor('signup'))
  assert.equal(res.status, 200)
  assert.deepEqual(captured[0].body.to, [CARRIER])
})

test('a guard refusal is an ERROR Supabase can see, not a quiet 200', async () => {
  // Non-production with no redirect configured. The guard refuses; a 200 here
  // would tell Supabase the confirmation was sent and leave a customer waiting
  // for an email that never existed.
  delete process.env.DEV_REDIRECT_EMAIL
  const res = await post(payloadFor('signup'))
  assert.equal(res.status, 500)
  assert.match(await errorMessage(res), /refusing to send to a real recipient/)
  assert.equal(captured.length, 0)
})

test('an unconfigured email provider is an error too', async () => {
  delete process.env.RESEND_API_KEY
  const res = await post(payloadFor('signup'))
  assert.equal(res.status, 500)
  assert.match(await errorMessage(res), /provider not configured/)
  assert.equal(captured.length, 0)
})

// ---------------------------------------------------------------------------
// The messages
// ---------------------------------------------------------------------------

test('every email type Supabase can send produces a message', () => {
  for (const action of SUPABASE_EMAIL_ACTIONS) {
    const composed = composeAuthEmails(
      {
        user: { id: 'u', email: CARRIER, new_email: 'new@carrier.example' },
        email_data: {
          token: '123456',
          token_hash: 'pkce_abc',
          token_hash_new: 'pkce_def',
          redirect_to: CALLBACK,
          email_action_type: action,
          provider: 'google',
          factor_type: 'totp',
          old_email: 'old@carrier.example',
        },
      },
      { supabaseUrl: SUPABASE_URL },
    )
    assert.ok(composed.ok, `${action} composed nothing: ${composed.ok ? '' : composed.reason}`)
    assert.ok(composed.messages.length >= 1, action)
    for (const m of composed.messages) {
      assert.ok(m.to.includes('@'), `${action} has no recipient`)
      assert.ok(m.subject.length > 0 && m.subject.length < 70, `${action} subject`)
      assert.ok(m.body.trim().length > 0, `${action} body`)
    }
  }
})

test('an email change produces TWO messages, each with the right token', () => {
  // The pairing Supabase's own source calls a bug and keeps for compatibility:
  //   token_hash     → the NEW address
  //   token_hash_new → the CURRENT address
  // Swapping them sends each person a link that confirms the other's address.
  const composed = composeAuthEmails(
    {
      user: { id: 'u', email: CARRIER, new_email: 'new@carrier.example' },
      email_data: {
        email_action_type: 'email_change',
        token_hash: 'pkce_for_the_new_address',
        token_hash_new: 'pkce_for_the_current_address',
        redirect_to: CALLBACK,
      },
    },
    { supabaseUrl: SUPABASE_URL },
  )
  assert.ok(composed.ok)
  assert.equal(composed.messages.length, 2)

  const toNew = composed.messages.find((m) => m.to === 'new@carrier.example')
  const toCurrent = composed.messages.find((m) => m.to === CARRIER)
  assert.ok(toNew && toCurrent)
  assert.match(toNew.body, /pkce_for_the_new_address/)
  assert.match(toCurrent.body, /pkce_for_the_current_address/)
  // The notice to the address being moved away from must name the new one.
  assert.match(toCurrent.body, /new@carrier\.example/)
})

test('without secure email change there is one message, to the new address', () => {
  const composed = composeAuthEmails(
    {
      user: { id: 'u', email: CARRIER, new_email: 'new@carrier.example' },
      email_data: {
        email_action_type: 'email_change',
        token_hash: 'pkce_new',
        redirect_to: CALLBACK,
      },
    },
    { supabaseUrl: SUPABASE_URL },
  )
  assert.ok(composed.ok)
  assert.equal(composed.messages.length, 1)
  assert.equal(composed.messages[0].to, 'new@carrier.example')
})

test('both messages of an email change pass through the guard', async () => {
  const res = await post(
    payloadFor(
      'email_change',
      { token_hash: 'pkce_new', token_hash_new: 'pkce_current' },
      { new_email: 'new@carrier.example' },
    ),
  )
  assert.equal(res.status, 200)
  assert.equal(captured.length, 2)
  assert.deepEqual(captured[0].body.to, [DEVELOPER])
  assert.deepEqual(captured[1].body.to, [DEVELOPER])
})

test('the link is the one Supabase would have built, PKCE prefix intact', () => {
  const link = actionLink({
    supabaseUrl: `${SUPABASE_URL}/`,
    tokenHash: 'pkce_9f1c2d3e',
    type: 'recovery',
    redirectTo: 'https://dev.fleetviewcompliance.com/auth/new-password',
  })
  const url = new URL(link)
  assert.equal(url.origin + url.pathname, `${SUPABASE_URL}/auth/v1/verify`)
  assert.equal(url.searchParams.get('token'), 'pkce_9f1c2d3e')
  assert.equal(url.searchParams.get('type'), 'recovery')
  assert.equal(
    url.searchParams.get('redirect_to'),
    'https://dev.fleetviewcompliance.com/auth/new-password',
  )
})

test('a redirect_to that is not an http url is dropped rather than pasted in', () => {
  const link = actionLink({
    supabaseUrl: SUPABASE_URL,
    tokenHash: 'pkce_x',
    type: 'signup',
    redirectTo: 'javascript:alert(1)',
  })
  assert.equal(new URL(link).searchParams.get('redirect_to'), null)
})

test('the signup email says what to do, in short plain sentences', () => {
  const composed = composeAuthEmails(
    {
      user: { id: 'u', email: CARRIER },
      email_data: { email_action_type: 'signup', token_hash: 'pkce_x', redirect_to: CALLBACK },
    },
    { supabaseUrl: SUPABASE_URL },
  )
  assert.ok(composed.ok)
  const [message] = composed.messages
  assert.match(message.subject, /Confirm your email/)
  assert.match(message.body, /Open this link/)
  assert.match(message.body, /if you did not sign up/i)
  // Written for people who do not read English comfortably: no sentence in one
  // of these may run long.
  for (const sentence of message.body.split(/[.\n]/)) {
    assert.ok(sentence.trim().split(/\s+/).length <= 16, `too long: ${sentence.trim()}`)
  }
})

test('a payload with no action type is refused rather than guessed at', () => {
  const composed = composeAuthEmails(
    { user: { email: CARRIER }, email_data: {} },
    { supabaseUrl: SUPABASE_URL },
  )
  assert.equal(composed.ok, false)
})

test('an action type added by Supabase later still gets a confirmable email', () => {
  const composed = composeAuthEmails(
    {
      user: { email: CARRIER },
      email_data: {
        email_action_type: 'some_future_confirmation',
        token_hash: 'pkce_future',
        redirect_to: CALLBACK,
      },
    },
    { supabaseUrl: SUPABASE_URL },
  )
  assert.ok(composed.ok)
  assert.match(composed.messages[0].body, /pkce_future/)
})
