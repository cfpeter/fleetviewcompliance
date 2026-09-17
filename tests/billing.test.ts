import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { canCheckout, canReceiveWebhooks, readStripeConfig } from '../src/lib/billing/config.ts'
import { isEntitled, planState, trialDaysLeft, trialEndsAt } from '../src/lib/billing/plan.ts'
import {
  FLOOR_TRUCK_CEILING,
  formatMoney,
  monthlyCents,
  STRIPE_VOLUME_TIERS,
  tieredMonthlyCents,
} from '../src/lib/billing/price.ts'
import {
  createCheckoutSession,
  STRIPE_MIN_TRIAL_MS,
  subscriptionFacts,
  verifyStripeSignature,
} from '../src/lib/billing/stripe.ts'
import {
  billingBreakdown,
  countBillableTrucks,
  isBillableTruck,
} from '../src/lib/billing/trucks.ts'
import { isActiveVehicle } from '../src/lib/fleet/active.ts'
import { monthlyPrice, site } from '../src/lib/site.ts'
import type { VehicleKind, VehicleStatus } from '../src/lib/vehicles.ts'

// ---------------------------------------------------------------------------
// What counts as a billable truck
// ---------------------------------------------------------------------------

const unit = (kind: VehicleKind, status: VehicleStatus) => ({ kind, status })

test('a billable truck is a power unit that is ACTIVE', () => {
  assert.equal(isBillableTruck(unit('power_unit', 'active')), true)
  assert.equal(isBillableTruck(unit('power_unit', 'sold')), false)
})

test('trailers are never billed, whatever their status', () => {
  // /pricing answers "What counts as a truck?" with "A power unit... Trailers
  // are free". Billing a trailer would make the invoice disagree with the page
  // the customer bought from, which is the one billing defect that cannot be
  // explained away.
  for (const status of ['active', 'out_of_service', 'sold', 'inactive'] as VehicleStatus[]) {
    assert.equal(isBillableTruck(unit('trailer', status)), false, `trailer ${status} billed`)
  }
})

test('a truck marked sold drops off the bill', () => {
  // The promise on /pricing: "What happens when I add or sell a truck? Your bill
  // goes up or down by $6." Charging for a truck the owner sold last month is
  // the fastest way to lose the customer who noticed.
  const fleet = [
    unit('power_unit', 'active'),
    unit('power_unit', 'active'),
    unit('power_unit', 'sold'),
  ]
  assert.equal(countBillableTrucks(fleet), 2)
})

test('a parked or out-of-service truck is NOT billed, because it is not watched', () => {
  // This assertion used to say the opposite, and the comment under it argued
  // for that from `loadDeadlines()` reading `.neq('status', 'sold')`. The
  // premise was the bug: the loader was watching trucks the owner does not run.
  // Both sides now read src/lib/fleet/active.ts, so the sentence "you pay for
  // the trucks we watch" holds in the direction he asked for — active only.
  const fleet = [unit('power_unit', 'out_of_service'), unit('power_unit', 'inactive')]
  assert.equal(countBillableTrucks(fleet), 0)
})

test('the bill and the alerts cannot disagree, because they ask the same function', () => {
  // The whole point of the shared module. If this ever fails, one of the two has
  // been given its own opinion again — and the failure mode is either an invoice
  // for a truck nobody is watching or a truck watched for free.
  for (const status of ['active', 'out_of_service', 'sold', 'inactive'] as VehicleStatus[]) {
    assert.equal(
      isBillableTruck(unit('power_unit', status)),
      isActiveVehicle({ status }),
      `billing and alerting disagree about a ${status} power unit`,
    )
  }
})

test('every unit on the account lands in exactly one line of the breakdown', () => {
  // The screen prints all three, so they have to add up to the fleet. A missing
  // unit reads as us hiding something from an owner counting his own yard.
  const fleet = [
    unit('power_unit', 'active'),
    unit('power_unit', 'inactive'),
    unit('power_unit', 'sold'),
    unit('trailer', 'active'),
    unit('trailer', 'sold'),
  ]
  const b = billingBreakdown(fleet)
  assert.deepEqual(b, { billable: 1, notActive: 2, trailers: 2 })
  assert.equal(b.billable + b.notActive + b.trailers, fleet.length)
  assert.equal(b.billable, countBillableTrucks(fleet))
})

test('an empty fleet is billed as an empty fleet, not as an error', () => {
  assert.equal(countBillableTrucks([]), 0)
  assert.deepEqual(billingBreakdown([]), { billable: 0, notActive: 0, trailers: 0 })
})

// ---------------------------------------------------------------------------
// The money
// ---------------------------------------------------------------------------

test('the bill is the site price, in integer cents', () => {
  // One implementation of the price, and it is monthlyPrice(). A second one is
  // how the invoice and the marketing page come to disagree.
  for (let n = 0; n <= 120; n++) {
    assert.equal(monthlyCents(n), monthlyPrice(n) * 100, `disagreement at ${n} trucks`)
    assert.ok(Number.isInteger(monthlyCents(n)), `${n} trucks produced a fraction of a cent`)
  }
})

test('the floor is the floor, in cents too', () => {
  assert.equal(monthlyCents(1), 2900)
  assert.equal(monthlyCents(4), 2900)
  assert.equal(monthlyCents(5), 3000)
  assert.equal(monthlyCents(10), 6000)
})

test('money prints the way the pricing page prints it', () => {
  assert.equal(formatMoney(2900), '$29')
  assert.equal(formatMoney(6000), '$60')
  // Not a price this product charges today, but proration and a future rate
  // both produce one, and "$34.5" would look like a bug in the bill.
  assert.equal(formatMoney(3450), '$34.50')
  assert.equal(formatMoney(120000), '$1,200')
})

test('the Stripe tiers charge exactly what this product charges', () => {
  // THE TEST THAT KEEPS STRIPE HONEST. Stripe does not run monthlyPrice(); it
  // bills from a Price object created by hand in the dashboard from the
  // instructions these constants print. If the tier arithmetic and the site
  // price ever disagree, every invoice is wrong and nothing else would catch it.
  for (let n = 1; n <= 200; n++) {
    assert.equal(tieredMonthlyCents(n), monthlyCents(n), `tiers disagree at ${n} trucks`)
  }
})

test('the tiers are volume tiers, and the boundary is where the floor stops binding', () => {
  // Graduated tiers would charge $29 + $6 for five trucks. Volume tiers price
  // every unit in the tier the total lands in, which is $30 — the number the
  // estimator shows. Getting this wrong overcharges every fleet above four
  // trucks by exactly the floor.
  assert.equal(FLOOR_TRUCK_CEILING, 4)
  assert.equal(STRIPE_VOLUME_TIERS.length, 2)
  assert.equal(STRIPE_VOLUME_TIERS[0].upTo, 4)
  assert.equal(STRIPE_VOLUME_TIERS[0].flatAmountCents, site.pricing.floor * 100)
  assert.equal(STRIPE_VOLUME_TIERS[0].unitAmountCents, undefined)
  assert.equal(STRIPE_VOLUME_TIERS[1].upTo, 'inf')
  assert.equal(STRIPE_VOLUME_TIERS[1].unitAmountCents, site.pricing.perTruck * 100)
  assert.equal(STRIPE_VOLUME_TIERS[1].flatAmountCents, undefined)
})

// ---------------------------------------------------------------------------
// The plan state machine
// ---------------------------------------------------------------------------

const DAY = 86_400_000
const SIGNUP = new Date('2026-01-01T00:00:00Z')

/** A billing row with a live subscription, overridable field by field. */
function row(over: Partial<import('../src/lib/billing/plan.ts').BillingRow> = {}) {
  return {
    stripe_customer_id: 'cus_test',
    stripe_subscription_id: 'sub_test',
    status: 'active',
    current_period_end: '2026-03-01T00:00:00Z',
    cancel_at_period_end: false,
    billable_trucks: 9,
    trial_ends_at: null,
    ...over,
  }
}

test('the free trial is counted from the day the carrier signed up', () => {
  assert.equal(trialEndsAt(SIGNUP).toISOString(), '2026-01-31T00:00:00.000Z')
  assert.equal(trialDaysLeft(SIGNUP, new Date('2026-01-01T00:00:00Z')), site.pricing.trialDays)
  assert.equal(trialDaysLeft(SIGNUP, new Date('2026-01-30T00:00:00Z')), 1)
})

test('a trial with hours left still says one day, never zero', () => {
  // Zero days left on an account that still works reads as "it has stopped".
  // Rounded up so the last day of the trial is a day, not a rounding error.
  assert.equal(trialDaysLeft(SIGNUP, new Date('2026-01-30T20:00:00Z')), 1)
  assert.equal(trialDaysLeft(SIGNUP, new Date('2026-01-31T00:00:00Z')), 0)
  assert.equal(trialDaysLeft(SIGNUP, new Date('2026-06-01T00:00:00Z')), 0)
})

test('no billing row at all is the free trial, not an error', () => {
  // Every carrier lives here for their first 30 days, so this is the common
  // case and it has to be the friendly one.
  const s = planState({
    row: null,
    carrierCreatedAt: SIGNUP,
    now: new Date(SIGNUP.getTime() + DAY),
  })
  assert.equal(s.state, 'trial')
  if (s.state === 'trial') assert.equal(s.daysLeft, 29)
  assert.equal(isEntitled(s), true)
})

test('when the free days run out the page says so, and nothing pretends otherwise', () => {
  const s = planState({
    row: null,
    carrierCreatedAt: SIGNUP,
    now: new Date('2026-03-01T00:00:00Z'),
  })
  assert.equal(s.state, 'trial_over')
  assert.equal(isEntitled(s), false)
})

test('a customer row with no subscription falls back to the trial', () => {
  // Reachable twice: between checkout and the first subscription event, and
  // after Stripe has finished with a cancelled subscription.
  const s = planState({
    row: row({ stripe_subscription_id: null }),
    carrierCreatedAt: SIGNUP,
    now: new Date(SIGNUP.getTime() + DAY),
  })
  assert.equal(s.state, 'trial')
})

test('a live subscription beats the trial dates', () => {
  // Stripe holds the card and the invoices. Where it has an opinion, the
  // derived trial must not override it — a paying customer told his trial is
  // over would go looking for a second charge.
  const s = planState({
    row: row(),
    carrierCreatedAt: SIGNUP,
    now: new Date('2026-06-01T00:00:00Z'),
  })
  assert.equal(s.state, 'paying')
  if (s.state === 'paying') {
    assert.equal(s.renewsOn?.toISOString(), '2026-03-01T00:00:00.000Z')
    assert.equal(s.endsOn, null)
    assert.equal(s.billedTrucks, 9)
    assert.equal(s.onStripeTrial, false)
  }
  assert.equal(isEntitled(s), true)
})

test('a customer who cancelled is told when it stops, never when it renews', () => {
  // `status` is still `active` inside the month they already paid for, so
  // without cancel_at_period_end the screen would promise a renewal to somebody
  // who has already told us to stop.
  const s = planState({
    row: row({ cancel_at_period_end: true }),
    carrierCreatedAt: SIGNUP,
    now: new Date('2026-02-15T00:00:00Z'),
  })
  assert.equal(s.state, 'paying')
  if (s.state === 'paying') {
    assert.equal(s.renewsOn, null)
    assert.equal(s.endsOn?.toISOString(), '2026-03-01T00:00:00.000Z')
  }
})

test('a Stripe-side trial is paying, and says nothing is charged yet', () => {
  const s = planState({
    row: row({ status: 'trialing' }),
    carrierCreatedAt: SIGNUP,
    now: new Date('2026-01-10T00:00:00Z'),
  })
  assert.equal(s.state, 'paying')
  if (s.state === 'paying') assert.equal(s.onStripeTrial, true)
})

test('a failed payment is its own state, and the account is not called closed', () => {
  for (const status of ['past_due', 'unpaid', 'incomplete']) {
    const s = planState({ row: row({ status }), carrierCreatedAt: SIGNUP, now: new Date() })
    assert.equal(s.state, 'payment_problem', `${status} should be a payment problem`)
  }
})

test('cancelled and expired are ended', () => {
  for (const status of ['canceled', 'incomplete_expired']) {
    const s = planState({ row: row({ status }), carrierCreatedAt: SIGNUP, now: new Date() })
    assert.equal(s.state, 'ended', `${status} should be ended`)
  }
})

test('a status this build has never seen is shown, not guessed at', () => {
  // Stripe adds statuses on its own schedule. Guessing would mean telling a
  // paused customer his account has ended, or telling an ended one it is fine.
  const s = planState({ row: row({ status: 'paused' }), carrierCreatedAt: SIGNUP, now: new Date() })
  assert.equal(s.state, 'unknown')
  if (s.state === 'unknown') assert.equal(s.status, 'paused')
})

test('a missing period end never becomes 1970', () => {
  const s = planState({
    row: row({ current_period_end: null }),
    carrierCreatedAt: SIGNUP,
    now: new Date(),
  })
  assert.equal(s.state, 'paying')
  if (s.state === 'paying') assert.equal(s.renewsOn, null)
})

// ---------------------------------------------------------------------------
// Reading a Stripe subscription
// ---------------------------------------------------------------------------

test('the period end is read whether Stripe puts it on the subscription or the item', () => {
  // Stripe MOVED current_period_end onto the subscription item in the 2025 API
  // versions. Which shape arrives is decided by the account's own API version,
  // not by anything we send — so reading only one of them works perfectly
  // against one Stripe account and silently stores null against another. That
  // null is a billing screen that cannot say when the next charge lands.
  const old = subscriptionFacts({
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    current_period_end: 1_800_000_000,
    items: { data: [{ id: 'si_1', quantity: 7 }] },
  })
  assert.equal(old.currentPeriodEnd?.getTime(), 1_800_000_000_000)

  const modern = subscriptionFacts({
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    items: { data: [{ id: 'si_1', quantity: 7, current_period_end: 1_800_000_000 }] },
  })
  assert.equal(modern.currentPeriodEnd?.getTime(), 1_800_000_000_000)
})

test('a subscription carries its quantity, its item and its carrier', () => {
  const facts = subscriptionFacts({
    id: 'sub_1',
    status: 'past_due',
    customer: { id: 'cus_1' },
    cancel_at_period_end: true,
    trial_end: 1_700_000_000,
    metadata: { carrier_id: '0f3e1b2c-1111-4222-8333-444455556666' },
    items: { data: [{ id: 'si_1', quantity: 12 }] },
  })
  assert.equal(facts.customerId, 'cus_1')
  assert.equal(facts.itemId, 'si_1')
  assert.equal(facts.quantity, 12)
  assert.equal(facts.cancelAtPeriodEnd, true)
  assert.equal(facts.trialEnd?.getTime(), 1_700_000_000_000)
  assert.equal(facts.carrierId, '0f3e1b2c-1111-4222-8333-444455556666')
})

test('metadata that is not a carrier id is ignored rather than trusted', () => {
  // The webhook looks a carrier up by this value. Anything that is not a UUID
  // came from somewhere we did not write, and a lookup on it is a lookup on
  // whatever a stranger typed into the Stripe dashboard.
  const facts = subscriptionFacts({
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    metadata: { carrier_id: 'all' },
  })
  assert.equal(facts.carrierId, null)
})

test('a subscription with no items still reads', () => {
  const facts = subscriptionFacts({ id: 'sub_1', status: 'active', customer: 'cus_1' })
  assert.equal(facts.itemId, null)
  assert.equal(facts.quantity, null)
  assert.equal(facts.currentPeriodEnd, null)
  assert.equal(facts.cancelAtPeriodEnd, false)
})

// ---------------------------------------------------------------------------
// Webhook signatures — the security boundary of the whole feature
// ---------------------------------------------------------------------------

const SECRET = 'whsec_test_0123456789abcdef'

/** Sign a payload the way Stripe signs it, so the verifier is tested and not mimicked. */
async function stripeHeader(payload: string, secret: string, tSeconds: number): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${tSeconds}.${payload}`))
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${tSeconds},v1=${hex}`
}

const NOW = new Date('2026-05-01T12:00:00Z')
const T = Math.floor(NOW.getTime() / 1000)
const BODY = '{"id":"evt_1","type":"customer.subscription.updated","created":1}'

test('a genuine Stripe signature verifies', async () => {
  const header = await stripeHeader(BODY, SECRET, T)
  const result = await verifyStripeSignature({ payload: BODY, header, secret: SECRET, now: NOW })
  assert.equal(result.ok, true)
})

test('a body changed by one character is refused', async () => {
  // The whole point. Without this check anyone who can POST JSON at the webhook
  // can grant themselves a subscription or cancel somebody else's — there is no
  // second check behind it.
  const header = await stripeHeader(BODY, SECRET, T)
  const tampered = BODY.replace('evt_1', 'evt_2')
  const result = await verifyStripeSignature({
    payload: tampered,
    header,
    secret: SECRET,
    now: NOW,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'signature mismatch')
})

test('a signature made with another secret is refused', async () => {
  const header = await stripeHeader(BODY, 'whsec_someone_elses_secret', T)
  const result = await verifyStripeSignature({ payload: BODY, header, secret: SECRET, now: NOW })
  assert.equal(result.ok, false)
})

test('an old signature is refused, so a captured request cannot be replayed', async () => {
  // The timestamp is inside the signed payload, so it cannot be edited without
  // breaking the signature. That is what makes the window a replay defence.
  const header = await stripeHeader(BODY, SECRET, T - 3600)
  const result = await verifyStripeSignature({ payload: BODY, header, secret: SECRET, now: NOW })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'timestamp outside tolerance')
})

test('a signature from the near future is accepted, because clocks drift', async () => {
  const header = await stripeHeader(BODY, SECRET, T + 60)
  const result = await verifyStripeSignature({ payload: BODY, header, secret: SECRET, now: NOW })
  assert.equal(result.ok, true)
})

test('a rotation sends two signatures and either one may be the good one', async () => {
  // Stripe sends every valid v1 during a secret roll. Comparing only the first
  // would break every webhook for the length of the rotation.
  const good = await stripeHeader(BODY, SECRET, T)
  const bad = await stripeHeader(BODY, 'whsec_old_secret', T)
  const merged = `${bad},${good.split(',')[1]}`
  const result = await verifyStripeSignature({
    payload: BODY,
    header: merged,
    secret: SECRET,
    now: NOW,
  })
  assert.equal(result.ok, true)
})

test('a missing or malformed header is refused with a reason, never accepted', async () => {
  const cases: [string | null, string][] = [
    [null, 'no signature header'],
    ['', 'no signature header'],
    ['v1=abc', 'no timestamp'],
    ['t=notanumber,v1=abc', 'no timestamp'],
    [`t=${T}`, 'no v1 signature'],
    [`t=${T},v0=abc`, 'no v1 signature'],
  ]
  for (const [header, reason] of cases) {
    const result = await verifyStripeSignature({ payload: BODY, header, secret: SECRET, now: NOW })
    assert.equal(result.ok, false, `${header} should be refused`)
    if (!result.ok) assert.equal(result.reason, reason)
  }
})

test('no signing secret means refuse, never means skip the check', async () => {
  const header = await stripeHeader(BODY, SECRET, T)
  const result = await verifyStripeSignature({ payload: BODY, header, secret: '', now: NOW })
  assert.equal(result.ok, false)
})

// ---------------------------------------------------------------------------
// Configuration, and degrading honestly without it
// ---------------------------------------------------------------------------

const env = (values: Record<string, string>) => (k: string) => values[k]

test('nothing configured is not an error, it is a state the screen can render', () => {
  const c = readStripeConfig(env({}))
  assert.equal(c.secretKey, null)
  assert.equal(c.priceId, null)
  assert.equal(canCheckout(c), false)
  assert.equal(canReceiveWebhooks(c), false)
  // No problems reported: unset is not misconfigured, and an operator log full
  // of complaints about a feature nobody has switched on is noise.
  assert.deepEqual(c.problems, [])
})

test('a fully configured test account can check out and receive webhooks', () => {
  const c = readStripeConfig(
    env({
      STRIPE_SECRET_KEY: 'sk_test_abc',
      STRIPE_PRICE_ID: 'price_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc',
      DEPLOY_ENV: 'development',
    }),
  )
  assert.equal(c.mode, 'test')
  assert.equal(canCheckout(c), true)
  assert.equal(canReceiveWebhooks(c), true)
  assert.deepEqual(c.problems, [])
})

test('a publishable key pasted into the secret slot is caught here, not by Stripe', () => {
  // They sit next to each other in the dashboard and differ by one letter. The
  // alternative to catching it here is a 401 on the one screen where a customer
  // is trying to give us money.
  const c = readStripeConfig(env({ STRIPE_SECRET_KEY: 'pk_test_abc', STRIPE_PRICE_ID: 'price_a' }))
  assert.equal(c.secretKey, null)
  assert.equal(canCheckout(c), false)
  assert.equal(c.problems.length, 1)
})

test('a LIVE key outside production is refused, not used', () => {
  // The rule src/lib/notify/guard.ts enforces on email and SMS, applied to
  // money: without it, pressing the button on the dev Worker creates real
  // customers and real subscriptions, and the first anyone knows is a charge on
  // a card.
  const c = readStripeConfig(
    env({
      STRIPE_SECRET_KEY: 'sk_live_abc',
      STRIPE_PRICE_ID: 'price_abc',
      DEPLOY_ENV: 'development',
    }),
  )
  assert.equal(c.secretKey, null)
  assert.equal(canCheckout(c), false)
  assert.ok(c.problems[0].includes('LIVE'))
})

test('a LIVE key in production is exactly what is wanted', () => {
  const c = readStripeConfig(
    env({
      STRIPE_SECRET_KEY: 'sk_live_abc',
      STRIPE_PRICE_ID: 'price_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc',
      DEPLOY_ENV: 'production',
    }),
  )
  assert.equal(c.mode, 'live')
  assert.equal(canCheckout(c), true)
  assert.deepEqual(c.problems, [])
})

test('a price id or signing secret of the wrong shape is dropped and reported', () => {
  const c = readStripeConfig(
    env({
      STRIPE_SECRET_KEY: 'sk_test_abc',
      STRIPE_PRICE_ID: 'prod_abc',
      STRIPE_WEBHOOK_SECRET: 'sk_test_abc',
    }),
  )
  // A product id where a price id belongs is the other common paste accident.
  assert.equal(c.priceId, null)
  assert.equal(c.webhookSecret, null)
  assert.equal(canCheckout(c), false)
  assert.equal(canReceiveWebhooks(c), false)
  assert.equal(c.problems.length, 2)
})

test('a value set to an empty string is not set', () => {
  const c = readStripeConfig(env({ STRIPE_SECRET_KEY: '   ', STRIPE_PRICE_ID: '' }))
  assert.equal(c.secretKey, null)
  assert.equal(c.priceId, null)
  assert.deepEqual(c.problems, [])
})

// ---------------------------------------------------------------------------
// What the checkout call actually sends
// ---------------------------------------------------------------------------

/** Capture the request instead of making it. Stripe is never called in tests. */
async function captureCheckout(over: Record<string, unknown> = {}) {
  const original = globalThis.fetch
  let body = ''
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = String(init.body ?? '')
    return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/x' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    await createCheckoutSession({
      secretKey: 'sk_test_abc',
      priceId: 'price_abc',
      quantity: 9,
      carrierId: '0f3e1b2c-1111-4222-8333-444455556666',
      customerId: null,
      customerEmail: 'owner@example.test',
      successUrl: 'https://x.test/app/billing?checkout=done',
      cancelUrl: 'https://x.test/app/billing?checkout=stopped',
      trialEnd: null,
      now: NOW,
      ...over,
    })
  } finally {
    globalThis.fetch = original
  }
  return new URLSearchParams(body)
}

test('checkout sends the truck count and both ways home for the webhook', async () => {
  const sent = await captureCheckout()
  assert.equal(sent.get('mode'), 'subscription')
  assert.equal(sent.get('line_items[0][price]'), 'price_abc')
  assert.equal(sent.get('line_items[0][quantity]'), '9')
  // client_reference_id arrives on checkout.session.completed; the subscription
  // metadata rides on every later subscription event, including ones raised
  // years from now by a card expiring.
  assert.equal(sent.get('client_reference_id'), '0f3e1b2c-1111-4222-8333-444455556666')
  assert.equal(
    sent.get('subscription_data[metadata][carrier_id]'),
    '0f3e1b2c-1111-4222-8333-444455556666',
  )
})

test('checkout sends the email or the customer, never both', async () => {
  // Stripe refuses the call outright when both are present, which would read on
  // screen as "we could not reach Stripe" at the moment of payment.
  const fresh = await captureCheckout()
  assert.equal(fresh.get('customer_email'), 'owner@example.test')
  assert.equal(fresh.has('customer'), false)

  const returning = await captureCheckout({ customerId: 'cus_existing' })
  assert.equal(returning.get('customer'), 'cus_existing')
  assert.equal(returning.has('customer_email'), false)
})

test('the remaining free days are carried into Stripe, unless they are nearly gone', async () => {
  // Stripe refuses a trial_end less than 48 hours out. A carrier paying on day
  // 29 of 30 therefore gets no Stripe trial — which is right, and must not be a
  // rejected checkout.
  const plenty = await captureCheckout({ trialEnd: new Date(NOW.getTime() + 10 * DAY) })
  assert.equal(
    plenty.get('subscription_data[trial_end]'),
    String(Math.floor((NOW.getTime() + 10 * DAY) / 1000)),
  )

  const nearlyGone = await captureCheckout({
    trialEnd: new Date(NOW.getTime() + STRIPE_MIN_TRIAL_MS - 1000),
  })
  assert.equal(nearlyGone.has('subscription_data[trial_end]'), false)

  const none = await captureCheckout({ trialEnd: null })
  assert.equal(none.has('subscription_data[trial_end]'), false)
})

// ---------------------------------------------------------------------------
// The address Stripe comes back to
// ---------------------------------------------------------------------------

test('the return address is built from the request, not from build-time config', () => {
  // The same failure tests/proof-token.test.ts pins on the proof page, on the
  // page where it costs money: Vite inlines the configured site URL when the
  // bundle is built, so one bundle carries one host. The dev Worker would then
  // send a customer who has just paid back to the production domain, where his
  // session does not exist — and it would be the return_url the Stripe billing
  // portal bounces off too.
  //
  // Asserted against the source because the mistake is a source-level one: any
  // build made from a file containing that expression is already wrong.
  const page = readFileSync(new URL('../src/pages/app/billing.astro', import.meta.url), 'utf8')
  assert.equal(
    /import\.meta\.env\.PUBLIC_SITE_URL/.test(page),
    false,
    'the billing page builds Stripe return URLs from build-time config again',
  )
  assert.ok(page.includes('Astro.url.origin'), 'the return address no longer uses the request')
})
