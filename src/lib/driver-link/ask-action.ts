/**
 * "Ask the driver" — the whole errand, in one place, for every screen that
 * offers it.
 *
 * WHY THIS IS NOT A PAGE HANDLER. It started as one, on /app/drivers/[id],
 * and then the dashboard needed the same button: the "dates we are missing"
 * screen already knows exactly which dates a driver is short of, so asking him
 * for them from there is one press instead of a page, a scroll and six
 * checkboxes. Two copies of a handler that mints a bearer credential and sends
 * it to a person is two places to get the expiry, the supersede, the source of
 * the phone number or the failure message wrong. There is one.
 *
 * WHAT IT DOES NOT DO. It does not decide WHAT to ask for. The page does that,
 * because the whitelist — six keys, and never 49 CFR 40.307(g)'s return-to-duty
 * date — belongs to `asks.ts` and is enforced again in SQL. It also does not
 * write a single compliance fact: the link mints a queue, and the owner accepts
 * or rejects what comes back.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AskKey } from './asks.ts'
import { type Channel, deliverDriverLink, reachFor } from './deliver.ts'
import { driverLinkUrl, mintDriverLink } from './link.ts'

export interface AskDriverArgs {
  supabase: SupabaseClient
  carrierId: string
  driverId: string
  asks: AskKey[]
  /** The owner's own reminders this link also asks about. See 0038. */
  reminderIds?: string[]
  hours: number
  userId: string | null
  /** `Astro.url.origin`. The link has to be absolute — it is going to a phone. */
  origin: string
}

/** What the page puts in the address bar. A CODE, never the sentence: `sent=`
 *  must not be able to carry a driver's phone number into browser history. */
export type SendOutcome = Channel | 'none' | 'failed'

export type AskDriverResult =
  | { ok: false; message: string }
  | {
      ok: true
      token: string
      url: string
      outcome: SendOutcome
      /** What the owner reads about the send, in his words. */
      message: string
      firstName: string | null
    }

export async function askDriver(args: AskDriverArgs): Promise<AskDriverResult> {
  const reminderIds = args.reminderIds ?? []
  if (args.asks.length + reminderIds.length === 0) {
    return { ok: false, message: 'Pick at least one thing to ask for.' }
  }

  /*
   * WHO WE ARE SENDING TO, read here rather than taken from the form.
   *
   * A number posted from a page is a number an owner could edit in the
   * browser, and this one addresses a message. Both reads go through the
   * caller's own client, so RLS still decides whether this carrier may see
   * this driver at all.
   */
  const [{ data: who }, { data: co }] = await Promise.all([
    args.supabase
      .from('drivers')
      .select('first_name, phone, email')
      .eq('id', args.driverId)
      .maybeSingle(),
    args.supabase.from('carriers').select('legal_name').eq('id', args.carrierId).maybeSingle(),
  ])
  const reach = reachFor(who ?? {})

  const minted = await mintDriverLink({
    supabase: args.supabase,
    carrierId: args.carrierId,
    driverId: args.driverId,
    asks: args.asks,
    reminderIds,
    hours: args.hours,
    userId: args.userId,
    // Recorded as INTENT. If the send fails the row still says where it was
    // meant to go, which with `opened_at` is what answers "did he ever get it"
    // months later when a card has lapsed and nobody agrees whose fault it is.
    // The owner is told separately, and plainly, that it did not go.
    sentTo: reach.to,
    channel: reach.channel,
  })
  if (!minted.ok) return { ok: false, message: minted.message }

  const url = driverLinkUrl(args.origin, minted.token)

  /*
   * THE SEND, AND WHY A FAILURE IS NOT A REFUSAL.
   *
   * The link is already minted and already valid. If the text does not leave
   * the building — no number, or `TWILIO_*` not configured until the 10DLC
   * campaign is live — the right answer is not to throw the link away and show
   * an error. It is to hand the owner the link and say so. He has a phone in
   * his hand either way.
   *
   * Outside production `guard()` inside `send()` redirects every message to the
   * developer, so nothing here can reach a real driver from dev.
   */
  const delivery = await deliverDriverLink({
    driver: who ?? { first_name: null },
    carrierName: co?.legal_name ?? 'Your carrier',
    url,
  })

  return {
    ok: true,
    token: minted.token,
    url,
    outcome: delivery.sent ? delivery.channel : reach.channel === 'copied' ? 'none' : 'failed',
    message: delivery.message,
    firstName: who?.first_name ?? null,
  }
}

/**
 * HOW MANY DRIVERS ONE PRESS MAY REACH.
 *
 * "Ask everyone" on a roster of sixty is sixty mints and sixty sends inside one
 * HTTP request. The ceiling is not politeness: a Worker has a subrequest budget
 * per request, and blowing it fails the whole thing halfway through — some
 * drivers texted, some not, and no record on screen of which. Twenty is well
 * inside it, and a fleet larger than that presses the button twice and is told
 * so in words.
 */
export const BULK_ASK_CAP = 20

/** How many go out at once. Enough to not take ten seconds, small enough that a
 *  slow provider cannot pile sixty open sockets against the budget. */
const BULK_BATCH = 5

export interface BulkAskTarget {
  driverId: string
  asks: AskKey[]
}

export interface BulkAskResult {
  /** Reached by text. */
  sms: number
  /** Reached by email, because there was no mobile number. */
  email: number
  /** Link minted, nowhere to send it. He has to pass it on himself. */
  none: number
  /** A channel existed and the send failed. The link is still good. */
  failed: number
  /** Refused by the mint — rate cap, or nothing askable left. */
  refused: number
  /** Left for a second press because of `BULK_ASK_CAP`. */
  overCap: number
}

/**
 * Ask several drivers at once, and count what actually happened.
 *
 * NO EXCEPTION ESCAPES A DRIVER. One driver whose send throws must not take the
 * other nineteen with it — the links are already minted by then, and an error
 * page would leave the owner believing none of it happened while his drivers'
 * phones buzz. A failure is counted, not raised.
 */
export async function askDrivers(
  args: Omit<AskDriverArgs, 'driverId' | 'asks'> & { targets: readonly BulkAskTarget[] },
): Promise<BulkAskResult> {
  const out: BulkAskResult = { sms: 0, email: 0, none: 0, failed: 0, refused: 0, overCap: 0 }

  const reach = args.targets.slice(0, BULK_ASK_CAP)
  out.overCap = args.targets.length - reach.length

  for (let i = 0; i < reach.length; i += BULK_BATCH) {
    const batch = reach.slice(i, i + BULK_BATCH)
    const done = await Promise.all(
      batch.map(async (t) => {
        try {
          return await askDriver({ ...args, driverId: t.driverId, asks: t.asks })
        } catch {
          return { ok: false as const, message: 'threw' }
        }
      }),
    )
    for (const r of done) {
      if (!r.ok) out.refused += 1
      else if (r.outcome === 'sms') out.sms += 1
      else if (r.outcome === 'email') out.email += 1
      else if (r.outcome === 'none') out.none += 1
      else out.failed += 1
    }
  }

  return out
}

/** The counts as one sentence, for the flash at the top of the dashboard. */
export function bulkAskLine(r: BulkAskResult): string {
  const parts: string[] = []
  if (r.sms > 0) parts.push(`${r.sms} by text`)
  if (r.email > 0) parts.push(`${r.email} by email`)
  const sent = parts.length > 0 ? `Sent ${parts.join(' and ')}.` : ''

  const tail: string[] = []
  if (r.none > 0) {
    tail.push(
      `${r.none} ${r.none === 1 ? 'has' : 'have'} no number and no email — open their page to copy the link.`,
    )
  }
  if (r.failed > 0) {
    tail.push(`${r.failed} could not be sent just now. The links are made and still good.`)
  }
  if (r.refused > 0) tail.push(`${r.refused} could not be asked.`)
  if (r.overCap > 0) {
    tail.push(`${r.overCap} left over — press it again to do the rest.`)
  }

  const all = [sent, ...tail].filter(Boolean).join(' ')
  return all || 'Nobody needed asking.'
}
