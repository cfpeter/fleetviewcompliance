/**
 * Getting the link to the driver, instead of to the owner's clipboard.
 *
 * WHAT WAS WRONG, in the owner's words: "right now we have a manual link that
 * we copy and paste but that's not the whole purpose... that should be
 * automatically sent if there is a phone number, if there is no phone number
 * then it's just a link generated."
 *
 * A TEXT FIRST, ALWAYS. A driver reads a text at a fuel stop; he may not have
 * an email address at all, and if he has one he has not opened it this month.
 * Email is the fallback, not the default — which is the opposite of how the
 * rest of this product talks to people, and right for the one person in it who
 * does not sit at a desk.
 *
 * NOTHING HERE DECIDES WHETHER A MESSAGE MAY GO OUT. `send()` runs `guard()`
 * first, and outside production every message is redirected to the developer
 * and never reaches a real carrier or a real driver. That is the whole reason
 * this calls `send()` rather than a provider directly.
 *
 * THE BODY CARRIES A LIVE CREDENTIAL. The link in it is a bearer token for an
 * unauthenticated write, so it is never written to `notification_log` and never
 * put in an error message. What IS recorded is on the `driver_links` row —
 * which channel, which address, and whether it was ever opened — and none of
 * that is the token.
 */
import { send, smsBody } from '../notify/send.ts'
import { formatPhone, toE164 } from '../phone.ts'
import { driverLinkMessage, driverLinkSubject } from './link.ts'

export type Channel = 'sms' | 'email' | 'copied'

export interface Reach {
  channel: Channel
  /** E.164 for a text, the address for an email, null when there is nowhere. */
  to: string | null
}

/**
 * How we would reach this driver, or that we cannot.
 *
 * Pure, and separate from the sending, because it is also the answer to a
 * question the OWNER'S screen asks before he presses anything: is there any
 * point offering to send this, or should the button say "copy the link"?
 *
 * A number `toE164` refuses is treated as no number at all. A phone field with
 * "call the office" in it is not a failure to report, it is simply not a way to
 * reach anybody, and the fallback below is the honest answer to it.
 */
export function reachFor(driver: {
  phone?: string | null
  email?: string | null
}): Reach {
  const phone = toE164(driver.phone ?? '')
  if (phone) return { channel: 'sms', to: phone }

  // Deliberately shallow. This is not validation — the address was already
  // accepted when the driver was saved, and refusing to try a slightly odd one
  // helps nobody. It only rules out the empty and the obviously-not-an-address.
  const email = String(driver.email ?? '').trim()
  if (email.length > 3 && email.includes('@') && !email.includes(' ')) {
    return { channel: 'email', to: email }
  }

  return { channel: 'copied', to: null }
}

export interface DeliverResult extends Reach {
  sent: boolean
  /**
   * What the owner reads. In his words, never a provider's — "twilio 21610" is
   * not a sentence anybody can act on.
   */
  message: string
}

/**
 * The environment, read the same way every other sending page reads it.
 *
 * `cloudflare:workers` does not exist under plain Node, which is where the
 * tests run, so the import is guarded and `process.env` is the whole story
 * there. Same shape as src/pages/app/setup.astro.
 */
async function providers() {
  let workerEnv: Record<string, string> = {}
  try {
    workerEnv = (await import('cloudflare:workers')).env as unknown as Record<string, string>
  } catch {
    // Not the Worker runtime.
  }
  const processEnv: Record<string, string | undefined> =
    typeof process !== 'undefined' && process.env ? process.env : {}
  const env = (k: string) => workerEnv[k] ?? processEnv[k]
  return {
    config: {
      mode: env('DEPLOY_ENV'),
      redirectEmail: env('DEV_REDIRECT_EMAIL'),
      redirectPhone: env('DEV_REDIRECT_PHONE'),
    },
    keys: {
      resendApiKey: env('RESEND_API_KEY'),
      fromEmail: env('DIGEST_FROM_EMAIL'),
      twilioSid: env('TWILIO_ACCOUNT_SID'),
      twilioToken: env('TWILIO_AUTH_TOKEN'),
      twilioFrom: env('TWILIO_FROM_NUMBER'),
    },
  }
}

/** The copy the owner reads when there was nowhere to send it. */
export const NO_WAY_TO_REACH =
  'No mobile number and no email for them. Copy the link below and send it however you already reach them.'

/**
 * The copy when the channel exists and the message did not go.
 *
 * THIS IS THE STATE THE PRODUCT IS IN TODAY FOR TEXTS, and it must never be
 * silent. `TWILIO_*` is deliberately unset until the 10DLC campaign is live
 * (docs/OPERATIONS.md), so `send()` answers "not configured" and the link has
 * to fall back to something the owner can actually use. A button that looks
 * like it sent a text and did not is worse than a button that says copy this.
 */
export const COULD_NOT_SEND = 'We could not send it just now. Copy the link below and send it yourself.'

export async function deliverDriverLink(args: {
  driver: { first_name: string | null; phone?: string | null; email?: string | null }
  carrierName: string
  url: string
}): Promise<DeliverResult> {
  const reach = reachFor(args.driver)
  if (reach.channel === 'copied' || !reach.to) {
    return { ...reach, sent: false, message: NO_WAY_TO_REACH }
  }

  const body = driverLinkMessage({
    carrierName: args.carrierName,
    firstName: args.driver.first_name,
    url: args.url,
  })

  const { config, keys } = await providers()
  const result = await send(
    {
      channel: reach.channel,
      to: reach.to,
      subject: driverLinkSubject(args.carrierName),
      // `smsBody` caps the length and, deliberately, prints no "Reply STOP":
      // promising an opt-out with no inbound route to honour it is a promise
      // the system cannot keep, and it blocks A2P registration. See send.ts.
      body: reach.channel === 'sms' ? smsBody([body]) : body,
    },
    config,
    keys,
  )

  if (result.status !== 'sent') {
    /*
     * THE TEXT DID NOT GO, SO TRY THE ADDRESS WE ALSO HAVE.
     *
     * This is not belt-and-braces, it is the state the product is in today:
     * `TWILIO_*` is deliberately unset until the 10DLC campaign is live
     * (docs/OPERATIONS.md), so every text reports "not configured". Giving up
     * there would hand the owner a copy-paste link for a driver whose email
     * address is sitting in the row we just read.
     *
     * Only ever this way round. A driver who can be texted is texted, because
     * that is the message he will actually read.
     */
    const fallback = reach.channel === 'sms' ? reachFor({ email: args.driver.email }) : null
    if (fallback?.channel === 'email' && fallback.to) {
      const second = await send(
        { channel: 'email', to: fallback.to, subject: driverLinkSubject(args.carrierName), body },
        config,
        keys,
      )
      if (second.status === 'sent') {
        return { ...fallback, sent: true, message: `Sent by email to ${fallback.to}.` }
      }
    }
    return { ...reach, sent: false, message: COULD_NOT_SEND }
  }

  return {
    ...reach,
    sent: true,
    message:
      reach.channel === 'sms'
        ? `Sent by text to ${formatPhone(reach.to) || reach.to}.`
        : `Sent by email to ${reach.to}.`,
  }
}
