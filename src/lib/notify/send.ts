/**
 * Actually putting a message on the wire.
 *
 * Two providers, one shape, and a sink that writes to the log when neither is
 * configured — so the whole pipeline can be exercised end to end before a
 * single credential exists.
 */
import { guard, type GuardConfig, type Outbound } from './guard.ts'

export interface SendResult {
  status: 'sent' | 'skipped' | 'failed'
  destination: string
  detail?: string
}

export interface Providers {
  resendApiKey?: string
  fromEmail?: string
  twilioSid?: string
  twilioToken?: string
  twilioFrom?: string
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
  return { status: 'sent', destination: to }
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
  return { status: 'sent', destination: to }
}

export async function send(
  message: Outbound,
  config: GuardConfig,
  providers: Providers,
): Promise<SendResult> {
  const verdict = guard(message, config)
  if (!verdict.allow) {
    return { status: 'skipped', destination: message.to, detail: verdict.reason }
  }

  const result =
    message.channel === 'email'
      ? await sendEmail(message, verdict.to, providers)
      : await sendSms(message, verdict.to, providers)

  return verdict.note ? { ...result, detail: [result.detail, verdict.note].filter(Boolean).join('; ') } : result
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
