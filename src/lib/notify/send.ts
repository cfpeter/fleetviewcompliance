/**
 * Actually putting a message on the wire.
 *
 * Two providers, one shape, and a sink that writes to the log when neither is
 * configured — so the whole pipeline can be exercised end to end before a
 * single credential exists.
 */
import { type GuardConfig, guard, type Outbound } from './guard.ts'
import { isSuppressed } from './suppression.ts'

export interface SendResult {
  /**
   * `suppressed` is its own outcome and not a kind of `failed`, for the same
   * reason `held` is not a kind of `skipped` in the digest: it decides whether a
   * log row is written at all. A suppressed message must leave its dedup key
   * unspent, because that key is what silences the message forever and spending
   * it on a send that never happened means the carrier can never be told even
   * after the address is fixed.
   */
  status: 'sent' | 'skipped' | 'failed' | 'suppressed'
  destination: string
  detail?: string
  /**
   * The provider's own id for this message, when it gave one.
   *
   * Read out of a response we are already holding — no extra round trip. It is
   * the ONLY handle on a message after the fact: without it, `GET /emails/{id}`
   * cannot be asked what became of anything we sent, and the reconciliation pass
   * has nothing to reconcile.
   */
  providerMessageId?: string
}

export interface Providers {
  resendApiKey?: string
  fromEmail?: string
  twilioSid?: string
  twilioToken?: string
  twilioFrom?: string
}

export interface SendOptions {
  /**
   * Addresses the provider has suppressed, fetched ONCE for the whole run.
   *
   * Passed in rather than fetched here precisely so that a hundred messages
   * cost one lookup and not a hundred. Null or absent means we could not read
   * the list, which means send — see isSuppressed().
   */
  suppressedEmails?: ReadonlySet<string> | null
}

async function sendEmail(m: Outbound, to: string, p: Providers): Promise<SendResult> {
  if (!p.resendApiKey || !p.fromEmail) {
    return { status: 'skipped', destination: to, detail: 'email provider not configured' }
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${p.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: p.fromEmail,
      to: [to],
      subject: m.subject ?? 'FleetView Compliance',
      text: m.body,
    }),
  })
  if (!res.ok) {
    return { status: 'failed', destination: to, detail: `resend ${res.status}` }
  }
  // `res.ok` is NOT delivery. A 200 here means Resend took the message, and it
  // returns exactly that 200 for an address it has suppressed and will silently
  // drop. The id is the only thing in this response worth anything: it is what
  // the reconciliation pass later asks `GET /emails/{id}` about. Parsing the
  // body we already have costs no round trip.
  const body = (await res.json().catch(() => null)) as { id?: unknown } | null
  const id = typeof body?.id === 'string' && body.id ? body.id : undefined
  return {
    status: 'sent',
    destination: to,
    providerMessageId: id,
    // A send we cannot follow up is a send that can fail silently forever, so it
    // says so on the row rather than looking indistinguishable from a good one.
    detail: id ? undefined : 'resend returned no message id; delivery cannot be reconciled',
  }
}

async function sendSms(m: Outbound, to: string, p: Providers): Promise<SendResult> {
  if (!p.twilioSid || !p.twilioToken || !p.twilioFrom) {
    return { status: 'skipped', destination: to, detail: 'sms provider not configured' }
  }
  const body = new URLSearchParams({ To: to, From: p.twilioFrom, Body: m.body })
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${p.twilioSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        // btoa is available in Workers; Buffer is not.
        Authorization: `Basic ${btoa(`${p.twilioSid}:${p.twilioToken}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
  )
  if (!res.ok) {
    return { status: 'failed', destination: to, detail: `twilio ${res.status}` }
  }
  // WHY THERE IS NO SUPPRESSION CHECK ON THIS SIDE.
  //
  // Twilio's suppression equivalent — a number that replied STOP — is refused
  // SYNCHRONOUSLY: HTTP 400, error 21610, which `!res.ok` above already turns
  // into `failed` and the digest already counts and logs. The half that is
  // genuinely silent on Resend does not exist here.
  //
  // What Twilio DOES share is the asynchronous half: a 201 carries
  // `status: queued` or `accepted`, which is acceptance and not delivery, and a
  // message can still end `undelivered` at the carrier. Nothing reconciles that
  // here, on purpose — SMS cannot send at all until 10DLC registration is live
  // (docs/OPERATIONS.md), and none of Twilio's behaviour has been measured the
  // way Resend's has. Building an unverified reconciliation against an unusable
  // channel would be guessing dressed as a safeguard. The `sid` is captured now
  // so that when the channel is switched on, the handle to reconcile with is
  // already in the log rather than missing for every message sent before
  // somebody noticed.
  const accepted = (await res.json().catch(() => null)) as { sid?: unknown } | null
  const sid = typeof accepted?.sid === 'string' && accepted.sid ? accepted.sid : undefined
  return { status: 'sent', destination: to, providerMessageId: sid }
}

export async function send(
  message: Outbound,
  config: GuardConfig,
  providers: Providers,
  options: SendOptions = {},
): Promise<SendResult> {
  const verdict = guard(message, config)
  if (!verdict.allow) {
    return { status: 'skipped', destination: message.to, detail: verdict.reason }
  }

  // AFTER the guard, and against `verdict.to` — the address the message is
  // ACTUALLY going to. Checking `message.to` instead would, on dev, test the
  // carrier's address and then send to the developer's: the one address whose
  // suppression matters would never be examined, and a developer whose own
  // inbox had bounced would keep seeing green runs. Only email has a list;
  // `suppressedEmails` is meaningless for SMS and is not consulted for it.
  if (message.channel === 'email' && isSuppressed(options.suppressedEmails, verdict.to)) {
    return {
      status: 'suppressed',
      destination: verdict.to,
      detail: 'on the provider suppression list; not sent',
    }
  }

  const result =
    message.channel === 'email'
      ? await sendEmail(message, verdict.to, providers)
      : await sendSms(message, verdict.to, providers)

  return verdict.note
    ? { ...result, detail: [result.detail, verdict.note].filter(Boolean).join('; ') }
    : result
}

/**
 * SMS bodies. Deliberately short, and deliberately WITHOUT a "Reply STOP" line.
 *
 * The previous build shipped bodies promising STOP with no inbound route to
 * honour it — a promise the system could not keep, and one that blocks A2P
 * registration. Twilio's 10DLC Advanced Opt-Out handles STOP at the carrier
 * level once a campaign is registered; until that registration is live and
 * verified, we do not print the word.
 */
export function smsBody(lines: readonly string[]): string {
  // 160 GSM-7 characters is one segment. Accented characters force UCS-2 and cut
  // that to 70, so the moment this is localised the budget roughly halves.
  const text = lines.join(' ')
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`
}

/**
 * The run hitting its own ceiling, told apart from a provider saying no.
 *
 * A Worker gets a fixed number of subrequests per invocation, and every send,
 * every lookup and every query spends one. Cross the line and the next `fetch`
 * THROWS — it does not return a bad response — so it escapes `send()`, escapes
 * the caller, and Cloudflare answers with an empty 500. For the digest that is
 * the silent run its own header calls the worse of the two failures: nobody is
 * emailed, nothing is written down, and the response says nothing at all about
 * how far it got.
 *
 * It must NOT be recorded as `failed`. `failed` means we reached a provider and
 * it refused, and the digest writes a log row for it — which spends the unique
 * `dedup_key` and stops that deadline from ever being sent again. Not late.
 * Never. Burning a carrier's notification because the WORKER ran out of budget
 * would turn a capacity limit into permanent silence about a truck that cannot
 * roll tomorrow.
 *
 * So callers treat it as `held`, following the quiet-hours precedent exactly: no
 * log row, key unspent, counted in the response, re-derived from scratch and
 * sent on the next run. Matched on the message because the runtime gives this
 * no error code and no distinct class — see the Workers limits documentation.
 */
export function atSubrequestCeiling(err: unknown): boolean {
  return err instanceof Error && /too many subrequests/i.test(err.message)
}

/** The ceiling as a value, so a caller can branch on it instead of unwinding. */
export const CEILING = Symbol('subrequest ceiling')

/**
 * `send()`, with the one throw that is about US rather than about the message.
 *
 * Every other failure still throws. A bug in here must not be laundered into a
 * quiet "we'll try later" — only the budget is.
 */
export async function sendOrCeiling(
  ...args: Parameters<typeof send>
): Promise<SendResult | typeof CEILING> {
  try {
    return await send(...args)
  } catch (err) {
    if (atSubrequestCeiling(err)) return CEILING
    throw err
  }
}
