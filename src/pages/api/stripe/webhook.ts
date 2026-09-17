/**
 * The Stripe webhook: the only writer of `billing_subscriptions`.
 *
 * Everything the application believes about who is paying arrives here. It is a
 * public URL with no session behind it, so the signature check below is not a
 * formality — it is the entire access control for the billing table. See
 * verifyStripeSignature(): real HMAC-SHA256 over the raw body, on WebCrypto,
 * with the replay window Stripe specifies.
 *
 * THE RAW BODY MATTERS. `request.text()` is read once, verified, and only then
 * parsed. Parsing first and re-serialising would change whitespace and key
 * order, and every signature would fail — or, worse, tempt somebody into
 * "fixing" it by skipping the check.
 *
 * IT IS SAFE TO RECEIVE THE SAME EVENT TWICE. Stripe retries on any non-2xx and
 * delivers out of order under load, so every write is an idempotent replace
 * guarded by `stripe_event_at`: an event older than the one already applied is
 * dropped rather than allowed to undo a newer fact. The row is state, not a log.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { APIRoute } from 'astro'
import { canReceiveWebhooks, readStripeConfig, runtimeEnv } from '../../../lib/billing/config.ts'
import {
  retrieveSubscription,
  type StripeCheckoutSession,
  type StripeSubscription,
  type SubscriptionFacts,
  subscriptionFacts,
  verifyStripeSignature,
} from '../../../lib/billing/stripe.ts'

interface StripeEvent {
  id: string
  type: string
  /** Unix seconds. The ordering key — see the guard in `applyFacts`. */
  created: number
  data: { object: unknown }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

/**
 * Write what Stripe says, unless we already know something newer.
 *
 * THE ORDERING GUARD. Stripe does not promise event order, and retries make
 * reordering ordinary rather than exotic: a `customer.subscription.updated`
 * saying "cancelled" can be delivered after a later one saying "reactivated".
 * Last-delivery-wins would leave the row describing a state the subscription has
 * already left — and since nothing else ever writes this table, it would stay
 * wrong until the next event happened to arrive.
 *
 * Expressed as an UPDATE with the guard in its WHERE clause, then an INSERT for
 * the first event of a carrier's life. A unique violation on that insert means a
 * row appeared in between carrying something newer, which is precisely the case
 * the guard exists for — so it is a success, not an error.
 */
async function applyFacts(
  db: SupabaseClient,
  carrierId: string,
  facts: SubscriptionFacts,
  event: StripeEvent,
): Promise<{ ok: true; applied: boolean } | { ok: false; error: string }> {
  if (!facts.customerId) return { ok: false, error: 'event carried no customer id' }

  const eventAt = new Date(event.created * 1000).toISOString()
  const row = {
    carrier_id: carrierId,
    stripe_customer_id: facts.customerId,
    stripe_subscription_id: facts.subscriptionId,
    status: facts.status,
    current_period_end: facts.currentPeriodEnd?.toISOString() ?? null,
    cancel_at_period_end: facts.cancelAtPeriodEnd,
    // What Stripe is billing, not what the fleet holds today. The billing screen
    // compares the two and that comparison is the point of storing it.
    billable_trucks: facts.quantity,
    trial_ends_at: facts.trialEnd?.toISOString() ?? null,
    stripe_event_id: event.id,
    stripe_event_at: eventAt,
  }

  const updated = await db
    .from('billing_subscriptions')
    .update(row)
    .eq('carrier_id', carrierId)
    .or(`stripe_event_at.is.null,stripe_event_at.lte.${eventAt}`)
    .select('carrier_id')

  if (updated.error) return { ok: false, error: updated.error.message }
  if (updated.data && updated.data.length > 0) return { ok: true, applied: true }

  const inserted = await db.from('billing_subscriptions').insert(row).select('carrier_id')
  if (!inserted.error) return { ok: true, applied: true }
  // 23505: a row for this carrier already exists and the UPDATE above declined
  // it as stale. Nothing to do and nothing wrong.
  if (inserted.error.code === '23505') return { ok: true, applied: false }
  return { ok: false, error: inserted.error.message }
}

/** Which carrier a subscription belongs to: its metadata, or the customer we know. */
async function resolveCarrier(
  db: SupabaseClient,
  facts: SubscriptionFacts,
): Promise<string | null> {
  // Set by createCheckoutSession as `subscription_data[metadata][carrier_id]`,
  // so it rides on every event this subscription will ever raise.
  if (facts.carrierId) return facts.carrierId
  if (!facts.customerId) return null
  // The fallback: a subscription created by hand in the Stripe dashboard has no
  // metadata, but its customer is one we have seen before.
  const { data } = await db
    .from('billing_subscriptions')
    .select('carrier_id')
    .eq('stripe_customer_id', facts.customerId)
    .maybeSingle()
  return (data?.carrier_id as string | undefined) ?? null
}

export const POST: APIRoute = async ({ request }) => {
  const get = await runtimeEnv()
  const config = readStripeConfig(get)

  if (!canReceiveWebhooks(config)) {
    // Refuses rather than accepting unsigned events. An endpoint with no signing
    // secret is an endpoint anybody can use to give themselves a subscription.
    return json({ error: 'stripe webhooks are not configured' }, 503)
  }

  const payload = await request.text()
  const check = await verifyStripeSignature({
    payload,
    header: request.headers.get('stripe-signature'),
    secret: config.webhookSecret,
  })
  if (!check.ok) {
    // 400, not 401: Stripe treats both as a failure and retries either way, and
    // the reason is ours to read in the dashboard rather than the caller's.
    return json({ error: 'signature check failed', reason: check.reason }, 400)
  }

  let event: StripeEvent
  try {
    event = JSON.parse(payload) as StripeEvent
  } catch {
    return json({ error: 'body is not JSON' }, 400)
  }
  if (!event?.id || !event.type || typeof event.created !== 'number') {
    return json({ error: 'not a Stripe event' }, 400)
  }

  const url = get('PUBLIC_SUPABASE_URL')
  const key = get('SUPABASE_SECRET_KEY')
  if (!url || !key) {
    // The same exception the digest job documents: a webhook has no signed-in
    // user to act as and must write a table no user may write. The key is read
    // here, inside the endpoint, and never imported by a page.
    return json({ error: 'billing webhooks need SUPABASE_SECRET_KEY configured' }, 503)
  }
  const db = createClient(url, key, { auth: { persistSession: false } })

  // ---------------------------------------------------------------- dispatch

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as StripeCheckoutSession
    const carrierId = session.client_reference_id ?? session.metadata?.carrier_id ?? null
    const subscriptionId = idOf(session.subscription)
    if (!carrierId || !UUID.test(carrierId)) {
      return json({ received: true, ignored: 'checkout session carried no carrier id' })
    }
    if (!subscriptionId) {
      return json({ received: true, ignored: 'checkout session carried no subscription' })
    }
    // The session says a subscription exists; it does not say what state it is
    // in or when the period ends. One extra call rather than storing a row that
    // cannot answer the question the billing screen is opened to ask.
    const sub = await retrieveSubscription(config.secretKey, subscriptionId)
    if (!sub.ok) return json({ error: 'could not read the subscription', detail: sub.error }, 500)

    const result = await applyFacts(db, carrierId, subscriptionFacts(sub.data), event)
    if (!result.ok) return json({ error: 'could not save', detail: result.error }, 500)
    return json({ received: true, applied: result.applied, carrier: carrierId })
  }

  if (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  ) {
    const facts = subscriptionFacts(event.data.object as StripeSubscription)
    const carrierId = await resolveCarrier(db, facts)
    if (!carrierId) {
      // A subscription we have never seen, for a customer we have never seen.
      // 200 so Stripe stops retrying: retrying will not make it ours.
      return json({ received: true, ignored: 'no carrier for this subscription' })
    }
    const result = await applyFacts(db, carrierId, facts, event)
    if (!result.ok) return json({ error: 'could not save', detail: result.error }, 500)
    return json({ received: true, applied: result.applied, carrier: carrierId })
  }

  // Everything else, acknowledged and dropped. Stripe sends far more than this
  // endpoint subscribes to, and a non-2xx on an event we do not want would put
  // the endpoint into Stripe's failing state and eventually disable it — taking
  // the three types above down with it.
  return json({ received: true, ignored: event.type })
}

/** A GET would let a browser preload or a link prefetch hit this endpoint. */
export const GET: APIRoute = () => json({ error: 'use POST' }, 405)
