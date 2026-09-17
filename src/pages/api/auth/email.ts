/**
 * The one door every Supabase Auth email now goes through.
 *
 * THE PROBLEM THIS SOLVES. `src/lib/notify/guard.ts` is the single place that
 * decides who may receive a message, and outside production it redirects every
 * one of them to DEV_REDIRECT_EMAIL. Three flows escaped it entirely — the
 * signup confirmation in src/pages/login.astro, the reset in
 * src/pages/auth/forgot-password.astro, the address change in
 * src/pages/app/settings.astro — because Supabase Auth composed and sent those
 * from its own servers. Our code never touched them, so there was nothing to
 * intercept, and a signup typed into the dev site mailed a real stranger.
 *
 * With the Send Email Hook configured, Supabase stops sending and POSTs here
 * instead. This endpoint composes the message and hands it to `send()`, so the
 * guard applies to auth email exactly as it applies to the digest. NONE of the
 * three pages changed: the interception happens on Supabase's side of the wire.
 *
 * IT IS A PUBLIC URL WITH NO SESSION BEHIND IT. `src/middleware.ts` exempts
 * `/api/auth/` from the session check, for the same reason it exempts /api/cron
 * and /api/stripe — Supabase has no signed-in user to present, and behind the
 * guard it would receive a 401 forever, which reads as "no email ever arrives".
 * The signature check below is therefore the ENTIRE access control. Unverified,
 * this endpoint is a machine that sends mail from our verified domain, carrying
 * a real-looking link, to any address a stranger names.
 *
 * FAIL CLOSED, BOTH WAYS. No signing secret means every request is refused
 * rather than trusted. A guard refusal or a provider failure is answered with an
 * error Supabase can see — which surfaces to the person as "we could not send
 * the email" — because the alternative is a customer waiting forever for mail
 * that a 200 claimed we had sent.
 */

import type { APIRoute } from 'astro'
import {
  composeAuthEmails,
  hookSecretBytes,
  type SendEmailHookPayload,
  verifyWebhookSignature,
} from '../../../lib/auth/email-hook.ts'
import { runtimeEnv } from '../../../lib/billing/config.ts'
import { send } from '../../../lib/notify/send.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * The error shape Supabase's hook documentation specifies. It reads `message`
 * and shows it in the project's hook logs, so this is the only channel through
 * which an operator ever learns why an email did not go out — worth a sentence
 * of real English rather than a code.
 */
function fail(status: number, message: string): Response {
  return json({ error: { http_code: status, message } }, status)
}

export const POST: APIRoute = async ({ request }) => {
  const get = await runtimeEnv()

  // `cloudflare:workers` first, `process.env` second, and NEVER
  // `import.meta.env` under a computed key — Vite inlines the whole env object
  // and bakes every secret into dist/. tests/env-inlining.test.ts enforces it.
  const secret = hookSecretBytes(get('SEND_EMAIL_HOOK_SECRET'))
  if (!secret) {
    // Deliberately before the body is even read. An endpoint with no signing
    // secret must refuse everything rather than send unverified mail.
    return fail(500, 'SEND_EMAIL_HOOK_SECRET is not configured; refusing to send unverified mail')
  }

  // THE RAW BODY MATTERS. Read once, verified, and only then parsed. Parsing
  // first and re-serialising would change whitespace and key order and every
  // signature would fail.
  const payload = await request.text()
  const check = await verifyWebhookSignature({
    payload,
    headers: {
      id: request.headers.get('webhook-id'),
      timestamp: request.headers.get('webhook-timestamp'),
      signature: request.headers.get('webhook-signature'),
    },
    secret,
  })
  if (!check.ok) {
    return fail(401, `webhook signature check failed: ${check.reason}`)
  }

  let body: SendEmailHookPayload
  try {
    body = JSON.parse(payload) as SendEmailHookPayload
  } catch {
    return fail(400, 'body is not JSON')
  }

  const supabaseUrl = get('PUBLIC_SUPABASE_URL') ?? import.meta.env.PUBLIC_SUPABASE_URL ?? ''
  const composed = composeAuthEmails(body, { supabaseUrl })
  if (!composed.ok) {
    return fail(500, `could not compose the email: ${composed.reason}`)
  }

  const guardConfig = {
    // 'production' is the ONLY value that permits a real recipient. Everything
    // else redirects to DEV_REDIRECT_EMAIL, and an unset redirect is a refusal.
    mode: get('DEPLOY_ENV'),
    redirectEmail: get('DEV_REDIRECT_EMAIL'),
    redirectPhone: get('DEV_REDIRECT_PHONE'),
  }
  const providers = {
    resendApiKey: get('RESEND_API_KEY'),
    // The same from-address the digest uses. One verified sender, one variable.
    fromEmail: get('DIGEST_FROM_EMAIL'),
  }

  const notes: string[] = []
  const problems: string[] = []

  // Sequentially, not in parallel. An email change produces two messages and
  // the second one is a security notice to the address being moved away from;
  // sending them one at a time keeps the order in the Resend log readable and
  // keeps a rate-limit rejection attributable to a message.
  for (const message of composed.messages) {
    const result = await send(
      { channel: 'email', to: message.to, subject: message.subject, body: message.body },
      guardConfig,
      providers,
    )
    if (result.status === 'sent') {
      if (result.detail) notes.push(result.detail)
      continue
    }
    // `skipped` covers both a guard refusal and an unconfigured provider, and
    // both must be loud. A 200 here would tell Supabase the mail was sent and
    // leave somebody staring at an empty inbox with no trace anywhere.
    problems.push(`${result.status}: ${result.detail ?? 'no detail'}`)
  }

  if (problems.length > 0) {
    return fail(500, `${composed.action}: ${problems.join('; ')}`)
  }

  // Supabase wants a 2xx and does not read the body on success. The note is the
  // guard's own "redirected from …", present only outside production, and it is
  // worth returning: it is what makes a dev hook log say out loud that the
  // carrier's address was not the address that received the mail.
  return json(notes.length > 0 ? { notes } : {})
}

/** A GET would let a browser preload or a link prefetch reach this endpoint. */
export const GET: APIRoute = () => fail(405, 'use POST')
