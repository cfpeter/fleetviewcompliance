/**
 * Stripe, over plain `fetch`.
 *
 * WHY NOT THE NODE SDK. The `stripe` package can be made to work on Workers —
 * it ships `Stripe.createFetchHttpClient()` and a SubtleCrypto provider for
 * `constructEventAsync` — but it is not installed here, it is a large dependency
 * for the four calls this product makes, and the repo already talks to Resend
 * and Twilio over raw `fetch` in src/lib/notify/send.ts. One habit for every
 * provider is worth more than one convenience for this one. The REST API is
 * form-encoded and stable, and the two things that are genuinely easy to get
 * wrong — signature verification and the period-end field moving between API
 * versions — are handled explicitly below rather than hidden.
 *
 * NO KEYS IN THIS FILE, and none anywhere in the bundle. Every function takes
 * the secret as an argument; src/lib/billing/config.ts is the only place that
 * reads it, and it reads it from the Worker environment at request time.
 */

const API = 'https://api.stripe.com/v1'

/**
 * Every call answers in this shape. A failed call is a value, not a throw: a
 * page that cannot start a checkout must redirect with a short message, and an
 * exception escaping into an Astro page is a 500 with a stack trace on it.
 */
export type StripeCall<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Stripe takes form-encoded bodies with bracketed keys, e.g.
 * `line_items[0][price]`. Callers write the brackets out in full — a helper that
 * flattened nested objects would hide exactly the part a reader needs to check
 * against Stripe's documentation.
 *
 * `undefined` values are dropped rather than sent as the string "undefined",
 * which Stripe would take as a real value and reject.
 */
function form(params: Record<string, string | number | undefined>): string {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    body.set(k, String(v))
  }
  return body.toString()
}

async function call<T>(
  secretKey: string,
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<StripeCall<T>> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: method === 'POST' ? form(params ?? {}) : undefined,
    })
  } catch (e) {
    // A network failure, not a refusal. Named differently on purpose: "we could
    // not reach Stripe" and "Stripe said no" need different answers from the
    // person reading the screen.
    return { ok: false, error: `could not reach Stripe: ${(e as Error).message}` }
  }

  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: `Stripe returned ${res.status} and not JSON` }
  }

  if (!res.ok) {
    const message = (parsed as { error?: { message?: string } })?.error?.message
    return { ok: false, error: message ?? `Stripe returned ${res.status}` }
  }
  return { ok: true, data: parsed as T }
}

// ---------------------------------------------------------------------------
// The objects we read
// ---------------------------------------------------------------------------

export interface StripeSubscriptionItem {
  id: string
  quantity?: number | null
  /** Where the period lives on API versions from 2025 onward. */
  current_period_end?: number | null
}

export interface StripeSubscription {
  id: string
  status: string
  customer: string | { id: string }
  cancel_at_period_end?: boolean
  /** Where the period lived before 2025. Absent on newer versions. */
  current_period_end?: number | null
  trial_end?: number | null
  metadata?: Record<string, string> | null
  items?: { data: StripeSubscriptionItem[] }
}

export interface StripeCheckoutSession {
  id: string
  url?: string | null
  client_reference_id?: string | null
  customer?: string | { id: string } | null
  subscription?: string | { id: string } | null
  metadata?: Record<string, string> | null
}

/** Stripe returns an id or the expanded object depending on the call. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

function secondsToDate(seconds: number | null | undefined): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
  return new Date(seconds * 1000)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SubscriptionFacts {
  subscriptionId: string
  customerId: string | null
  status: string
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  /** The subscription item, needed to change the quantity later. */
  itemId: string | null
  quantity: number | null
  trialEnd: Date | null
  /** From `metadata.carrier_id`, and only when it is actually a UUID. */
  carrierId: string | null
}

/**
 * One reading of a subscription, whatever API version wrote it.
 *
 * THE FIELD THAT MOVED. Stripe relocated `current_period_end` from the
 * subscription onto each subscription ITEM in the 2025 API versions. Which shape
 * arrives here is decided by the account's own API version setting, not by
 * anything this code sends — so reading only one of them would work perfectly
 * against one Stripe account and silently store `null` against another. The
 * consequence of that null is a billing screen that cannot say when the next
 * charge lands, which is the single fact a customer opens it for. So both are
 * read, top level first.
 *
 * Pure, and tested against both shapes in tests/billing.test.ts.
 */
export function subscriptionFacts(sub: StripeSubscription): SubscriptionFacts {
  const item = sub.items?.data?.[0]
  const carrierId = sub.metadata?.carrier_id
  return {
    subscriptionId: sub.id,
    customerId: idOf(sub.customer),
    status: sub.status,
    currentPeriodEnd: secondsToDate(sub.current_period_end ?? item?.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    itemId: item?.id ?? null,
    quantity: typeof item?.quantity === 'number' ? item.quantity : null,
    trialEnd: secondsToDate(sub.trial_end),
    carrierId: carrierId && UUID.test(carrierId) ? carrierId : null,
  }
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

/**
 * Stripe refuses a `trial_end` less than 48 hours away. A carrier who starts
 * paying on day 29 of a 30-day trial therefore gets no Stripe trial at all —
 * which is correct and worth one line of copy, not a rejected checkout.
 */
export const STRIPE_MIN_TRIAL_MS = 48 * 60 * 60 * 1000

export async function createCheckoutSession(opts: {
  secretKey: string
  priceId: string
  quantity: number
  carrierId: string
  /** Reuse the customer we already have, so a second checkout is not a second customer. */
  customerId: string | null
  customerEmail: string | null
  successUrl: string
  cancelUrl: string
  /** End of the free days. Passed to Stripe only when far enough away. */
  trialEnd: Date | null
  now: Date
}): Promise<StripeCall<StripeCheckoutSession>> {
  const trialUsable =
    opts.trialEnd !== null && opts.trialEnd.getTime() - opts.now.getTime() >= STRIPE_MIN_TRIAL_MS

  return call<StripeCheckoutSession>(opts.secretKey, 'POST', '/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': opts.priceId,
    'line_items[0][quantity]': opts.quantity,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    // Two ways home for the webhook, because they fail differently.
    // `client_reference_id` arrives on checkout.session.completed;
    // `subscription_data[metadata]` is copied onto the subscription itself and
    // so arrives on every later customer.subscription.* event, including ones
    // raised years from now by a card expiring.
    client_reference_id: opts.carrierId,
    'subscription_data[metadata][carrier_id]': opts.carrierId,
    // Exactly one of these. Stripe refuses the call if both are present.
    customer: opts.customerId ?? undefined,
    customer_email: opts.customerId ? undefined : (opts.customerEmail ?? undefined),
    'subscription_data[trial_end]': trialUsable
      ? Math.floor((opts.trialEnd as Date).getTime() / 1000)
      : undefined,
  })
}

export async function createPortalSession(opts: {
  secretKey: string
  customerId: string
  returnUrl: string
}): Promise<StripeCall<{ id: string; url: string }>> {
  return call<{ id: string; url: string }>(opts.secretKey, 'POST', '/billing_portal/sessions', {
    customer: opts.customerId,
    return_url: opts.returnUrl,
  })
}

export async function retrieveSubscription(
  secretKey: string,
  subscriptionId: string,
): Promise<StripeCall<StripeSubscription>> {
  return call<StripeSubscription>(secretKey, 'GET', `/subscriptions/${subscriptionId}`)
}

/**
 * Change how many trucks Stripe is billing for.
 *
 * `create_prorations` is Stripe's default for a quantity change and is the
 * behaviour /pricing already promises: "Your bill goes up or down by $6." The
 * difference for the days left in the current month lands on the next invoice
 * rather than as a charge today, so adding a truck never produces a surprise
 * card charge on a Tuesday.
 */
export async function setSubscriptionQuantity(opts: {
  secretKey: string
  subscriptionId: string
  itemId: string
  quantity: number
}): Promise<StripeCall<StripeSubscription>> {
  return call<StripeSubscription>(opts.secretKey, 'POST', `/subscriptions/${opts.subscriptionId}`, {
    'items[0][id]': opts.itemId,
    'items[0][quantity]': opts.quantity,
    proration_behavior: 'create_prorations',
  })
}

// ---------------------------------------------------------------------------
// Webhook signatures
// ---------------------------------------------------------------------------
//
// THE SECURITY BOUNDARY OF THE WHOLE FEATURE. The webhook is the only writer of
// billing_subscriptions, and it is a public URL. Without a verified signature,
// anybody who can POST JSON can hand themselves a subscription — or cancel
// somebody else's. There is no second check behind it.
//
// Stripe signs `${timestamp}.${raw body}` with HMAC-SHA256 under the endpoint's
// signing secret and sends the result hex-encoded in the `Stripe-Signature`
// header, alongside the timestamp:
//
//   Stripe-Signature: t=1492774577,v1=5257a869e7…,v1=…
//
// Several `v1` values can appear at once: that is what a secret rotation looks
// like in flight, so every one of them is compared rather than only the first.
//
// This runs on WebCrypto — `crypto.subtle`, which Cloudflare Workers and Node 22
// both provide — so there is no Node `crypto` import and nothing here needs a
// polyfill. It is real verification, not a shape check.

/** How far out of date a signature may be. Stripe's own default. */
export const SIGNATURE_TOLERANCE_SECONDS = 300

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Constant-time string comparison.
 *
 * The same function digest.ts uses on the cron secret, and for the same reason:
 * a plain `!==` returns faster the earlier the mismatch is, which leaks the
 * signature one character at a time to anyone patient enough to measure.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export type SignatureCheck = { ok: true } | { ok: false; reason: string }

/**
 * Verify a Stripe webhook signature.
 *
 * `payload` MUST be the raw request body, byte for byte. Re-serialising the
 * parsed JSON changes key order and whitespace, and every signature then fails
 * — or worse, a lenient implementation starts accepting things it should not.
 */
export async function verifyStripeSignature(opts: {
  payload: string
  header: string | null
  secret: string
  now?: Date
  toleranceSeconds?: number
}): Promise<SignatureCheck> {
  const { payload, header, secret } = opts
  if (!header) return { ok: false, reason: 'no signature header' }
  if (!secret) return { ok: false, reason: 'no signing secret configured' }

  let timestamp: string | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k === 't') timestamp = v
    else if (k === 'v1') signatures.push(v)
  }

  if (!timestamp || !/^\d+$/.test(timestamp)) return { ok: false, reason: 'no timestamp' }
  if (signatures.length === 0) return { ok: false, reason: 'no v1 signature' }

  // The timestamp is inside the signed payload, so it cannot be edited without
  // breaking the signature — which is what makes this a replay defence and not
  // decoration. Without it, a signed request captured once can be replayed
  // forever.
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  const tolerance = opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS
  if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) {
    return { ok: false, reason: 'timestamp outside tolerance' }
  }

  const expected = await hmacHex(secret, `${timestamp}.${payload}`)
  for (const candidate of signatures) {
    if (timingSafeEqual(expected, candidate)) return { ok: true }
  }
  return { ok: false, reason: 'signature mismatch' }
}
