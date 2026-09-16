/**
 * Knowing whether an email actually landed.
 *
 * `POST /emails` returns `{"id": "..."}` and NOTHING ELSE — no delivery signal
 * at all. A send to an address Resend has suppressed comes back HTTP 200 with an
 * id and is then dropped silently, so a `res.ok` check records `sent` about a
 * message nobody will ever read. That is the worst failure this system can have:
 * a carrier stops receiving deadline warnings, and neither he nor we ever find
 * out. Every other failure at least announces itself.
 *
 * TWO HALVES, because neither one closes it alone. Both were measured against
 * the live API; nothing here is inferred from documentation.
 *
 *  1. `GET /suppressions` lists account-level suppressions. Fetched ONCE per
 *     digest run and consulted before sending. **The list is INCOMPLETE** — an
 *     address that reliably reports `suppressed` from `GET /emails/{id}` does
 *     NOT appear on it. So this is a cheap first pass and can never be the only
 *     defence; anything built on the assumption that the list is authoritative
 *     is built on sand.
 *
 *  2. `GET /emails/{id}` carries `last_event`. Measured on a known-suppressed
 *     address: `queued` at +0s, `suppressed` at +2s, `suppressed` at +6s. So the
 *     truth is knowable within seconds but NOT synchronously — a check fired
 *     immediately after the POST reads `queued` and learns nothing. That is why
 *     this is a later pass over recorded message ids rather than a second call
 *     inside send().
 *
 * Nothing in this file may put the API key into a returned string. Every error
 * message here carries a status code and no headers, because those strings end
 * up in `notification_log.error`, which the carrier can read on the settings
 * page.
 */

const API = 'https://api.resend.com'

/**
 * What the provider says became of a message, kept deliberately separate from
 * `notification_log.status`.
 *
 * `status` is what the send ATTEMPT returned and must stay true to that — Resend
 * did accept the message, and rewriting that column later would destroy the one
 * record of what we actually observed at the time. This is the second, later
 * fact: whether the thing it accepted was ever delivered.
 */
export type DeliveryState = 'unknown' | 'delivered' | 'undelivered' | 'complained'

/**
 * Terminal events meaning the message did NOT reach the person.
 *
 * `canceled` cannot happen today (we never schedule) and is listed anyway: an
 * event we do not recognise falls through to `unknown` and is retried forever
 * inside the window, which is a worse silence than naming one extra word.
 */
const UNDELIVERED = new Set([
  'bounced',
  'suppressed',
  'canceled',
  'cancelled',
  'failed',
  'rejected',
])

/** Still in flight. Not an answer yet — ask again on a later run. */
const IN_FLIGHT = new Set(['queued', 'scheduled', 'sent', 'delivery_delayed', 'delivery-delayed'])

/**
 * An address list is not case-sensitive.
 *
 * RFC 5321 permits a case-sensitive local part and no mail provider on earth
 * implements one; a suppression list is an account-level fact about a mailbox,
 * not about a spelling. Without this, `Bob@X.com` sails straight past a
 * suppression recorded as `bob@x.com` and we are back to the silent drop this
 * whole file exists to prevent.
 */
export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * The email addresses out of a `GET /suppressions` payload.
 *
 * Shape-tolerant on purpose: the measured response is a list envelope
 * (`{ data: [...] }`) and a bare array is the other plausible spelling. A parser
 * that only understood one of them would return an EMPTY set on the other, which
 * reads exactly like "nothing is suppressed" and would re-open the hole without
 * a single error anywhere.
 */
export function parseSuppressionList(payload: unknown): Set<string> {
  const envelope = (payload ?? {}) as { data?: unknown }
  const rows = Array.isArray(payload) ? payload : Array.isArray(envelope.data) ? envelope.data : []
  const out = new Set<string>()
  for (const row of rows) {
    const email = (row as { email?: unknown } | null)?.email
    if (typeof email === 'string' && email.trim()) out.add(normalizeAddress(email))
  }
  return out
}

/**
 * Whether this exact destination is on the list we fetched.
 *
 * A NULL list means we could not read it, and that must mean SEND. Refusing to
 * send whenever Resend's suppressions endpoint is unreachable would let one
 * provider blip silence every deadline warning in the product — the precise
 * failure this codebase refuses everywhere else. The reconciliation pass is the
 * backstop for whatever the missing list would have caught.
 */
export function isSuppressed(
  list: ReadonlySet<string> | null | undefined,
  address: string,
): boolean {
  if (!list) return false
  return list.has(normalizeAddress(address))
}

/**
 * `last_event` to a state we store.
 *
 * An event we do not recognise maps to `unknown`, never to a guess. Guessing
 * `delivered` burns the dedup key on a message we cannot prove arrived — not
 * late, never. Guessing `undelivered` re-sends to somebody who already has it.
 * `unknown` is simply the truth, and the row is re-read on a later run.
 */
export function deliveryStateFor(lastEvent: string | null | undefined): DeliveryState {
  const event = (lastEvent ?? '').trim().toLowerCase()
  if (!event) return 'unknown'
  if (event === 'delivered') return 'delivered'
  // A complaint means it DID arrive and the reader pressed "spam". Kept apart
  // from `undelivered` because the two demand opposite responses: one is retried
  // once the address is fixed, the other must never be retried at all.
  if (event === 'complained') return 'complained'
  if (UNDELIVERED.has(event)) return 'undelivered'
  if (IN_FLIGHT.has(event)) return 'unknown'
  return 'unknown'
}

export interface SuppressionFetch {
  /** Null means we could not read the list — which means SEND, see isSuppressed. */
  list: Set<string> | null
  error?: string
}

/**
 * The account's suppression list. ONE call per digest run, never per message.
 *
 * A per-message round trip would add a full network hop to every recipient in
 * the fleet, which is how a job that must finish inside a Worker's time budget
 * stops finishing.
 */
export async function fetchSuppressions(
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SuppressionFetch> {
  if (!apiKey) return { list: null, error: 'no resend key' }
  try {
    const res = await fetchImpl(`${API}/suppressions`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) return { list: null, error: `resend suppressions ${res.status}` }
    return { list: parseSuppressionList(await res.json()) }
  } catch (err) {
    // The message, never the request: an error object from fetch can carry the
    // URL and headers we sent, and those headers hold the API key.
    return { list: null, error: `resend suppressions unreachable: ${(err as Error).message}` }
  }
}

export interface DeliveryLookup {
  state: DeliveryState
  /** The provider's own word — `bounced` and `suppressed` have different fixes. */
  event: string | null
  error?: string
}

/**
 * What became of one already-sent message.
 *
 * Deliberately NOT called from send(): measured, `last_event` is `queued` at +0s
 * and only settles a couple of seconds later, so an immediate check reads
 * `queued` every time and learns nothing while costing a round trip per message.
 */
export async function fetchDeliveryEvent(
  apiKey: string,
  messageId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryLookup> {
  try {
    const res = await fetchImpl(`${API}/emails/${encodeURIComponent(messageId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) return { state: 'unknown', event: null, error: `resend lookup ${res.status}` }
    const body = (await res.json()) as { last_event?: unknown }
    const event = typeof body?.last_event === 'string' ? body.last_event : null
    return { state: deliveryStateFor(event), event }
  } catch (err) {
    return {
      state: 'unknown',
      event: null,
      error: `resend lookup failed: ${(err as Error).message}`,
    }
  }
}
