/**
 * The Supabase Send Email Hook: signature check and message composition.
 *
 * WHY THIS EXISTS AT ALL. src/lib/notify/guard.ts is the one place every message
 * this product sends passes through, and outside production it rewrites the
 * recipient to DEV_REDIRECT_EMAIL. Three flows escaped it completely — signup
 * confirmation, password reset, email change — because Supabase Auth composes
 * and sends those from its own servers. There was nothing to intercept: our code
 * never touched them, so a dev signup mailed a real stranger.
 *
 * The Send Email Hook closes that. With the hook configured, Supabase stops
 * sending and instead POSTs the user and the generated token to an endpoint we
 * host; we compose the message and send it ourselves, through `send()`, which
 * means through the guard. One rule, one file, no second copy of it here.
 *
 * WHAT THE PAYLOAD IS, verified against Supabase's own source rather than
 * guessed (github.com/supabase/auth, `internal/mailer/mailer.go` EmailData and
 * `internal/api/mail.go` sendEmail):
 *
 *   { user: { id, email, new_email?, ... }, email_data: { token, token_hash,
 *     redirect_to, email_action_type, site_url, token_new, token_hash_new,
 *     old_email, old_phone, provider, factor_type } }
 *
 * THE HOOK IS CALLED ONCE PER EVENT, INCLUDING FOR AN EMAIL CHANGE THAT NEEDS
 * TWO MESSAGES. Supabase's own mailer sends the change confirmation to the new
 * address and, when "Secure email change" is on, a second one to the current
 * address. The hook gets a single call carrying both tokens and it is the hook's
 * job to send both — miss it and half of a security feature silently disappears.
 * Which token belongs to which address is genuinely counter-intuitive, and the
 * pairing is spelled out at `emailChangeMessages` below.
 */

export const SUPABASE_EMAIL_ACTIONS = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
  'reauthentication',
  'password_changed_notification',
  'email_changed_notification',
  'phone_changed_notification',
  'identity_linked_notification',
  'identity_unlinked_notification',
  'mfa_factor_enrolled_notification',
  'mfa_factor_unenrolled_notification',
] as const

export type EmailActionType = (typeof SUPABASE_EMAIL_ACTIONS)[number]

export interface HookUser {
  id?: string
  email?: string
  /** `email_change` on the row; present only while a change is pending. */
  new_email?: string
  phone?: string
}

export interface HookEmailData {
  /** The 6-digit code. The only thing carried by the OTP-shaped emails. */
  token?: string
  /** The link token. Carries a `pkce_` prefix when the project is on PKCE. */
  token_hash?: string
  redirect_to?: string
  email_action_type?: string
  site_url?: string
  token_new?: string
  token_hash_new?: string
  old_email?: string
  old_phone?: string
  provider?: string
  factor_type?: string
}

export interface SendEmailHookPayload {
  user?: HookUser
  email_data?: HookEmailData
}

export interface AuthMessage {
  to: string
  subject: string
  body: string
}

export type Composed =
  | { ok: true; action: string; messages: AuthMessage[] }
  | { ok: false; reason: string }

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * WHY THIS IS NOT OPTIONAL.
 *
 * This endpoint is a public URL with no session behind it. Unverified, it is a
 * machine that will send email to any address anybody names, from our verified
 * domain, carrying a link that looks exactly like a real one — a phishing kit
 * with our reputation attached. The signature is the entire access control.
 *
 * THE SCHEME IS `standard-webhooks`, not Stripe's. Read from the specification
 * (standard-webhooks/spec) and from the reference JavaScript implementation:
 *
 *   webhook-id         an opaque delivery id
 *   webhook-timestamp  INTEGER UNIX SECONDS, not ISO 8601
 *   webhook-signature  space-separated list of `v1,<base64>` entries
 *
 * signed string = `${webhook-id}.${webhook-timestamp}.${raw body}`
 * signature     = base64( HMAC-SHA256( key, signed string ) )
 *
 * AND THE KEY IS BYTES, NOT THE STRING. The dashboard hands out
 * `v1,whsec_<base64>`; the reference implementation strips the prefix and
 * BASE64-DECODES the rest into the HMAC key. Signing the literal string instead
 * — which is what Stripe does with its own secret — produces a signature that
 * never matches, and the temptation then is to "fix" it by loosening the check.
 *
 * Several signatures can appear at once: that is what a secret rotation looks
 * like in flight, so every `v1` entry is compared rather than only the first.
 *
 * Runs on WebCrypto, which both Cloudflare Workers and Node 22 provide, so
 * there is no Node `crypto` import and nothing here needs a polyfill.
 */

/** The reference implementation's own tolerance: five minutes either way. */
export const HOOK_TOLERANCE_SECONDS = 300

export type SignatureCheck = { ok: true } | { ok: false; reason: string }

export interface WebhookHeaders {
  id: string | null
  timestamp: string | null
  signature: string | null
}

/**
 * The signing key as bytes.
 *
 * Returns null for anything it cannot turn into a key, and null means the
 * endpoint refuses everything. A secret that is present but malformed is more
 * dangerous than one that is missing, because it looks configured.
 */
export function hookSecretBytes(raw: string | null | undefined): Uint8Array | null {
  let s = (raw ?? '').trim()
  if (!s) return null
  // Supabase stores `v1,whsec_<base64>`. Both halves of the prefix are stripped
  // so that a secret pasted in any of the three spellings works.
  if (s.startsWith('v1,')) s = s.slice(3)
  if (s.startsWith('whsec_')) s = s.slice(6)
  if (!s) return null
  try {
    const binary = atob(s)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.length > 0 ? bytes : null
  } catch {
    return null
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/**
 * Constant-time string comparison.
 *
 * The same function src/lib/billing/stripe.ts uses on the Stripe signature, and
 * for the same reason: a plain `!==` returns faster the earlier the mismatch is,
 * which hands the signature over one character at a time to anyone patient
 * enough to measure.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** The signature Supabase should have sent for this exact body. */
export async function signWebhook(opts: {
  payload: string
  id: string
  timestamp: string | number
  secret: Uint8Array
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    opts.secret as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signed = `${opts.id}.${opts.timestamp}.${opts.payload}`
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed))
  return bytesToBase64(new Uint8Array(mac))
}

/**
 * Verify a standard-webhooks signature.
 *
 * `payload` MUST be the raw request body, byte for byte. Re-serialising parsed
 * JSON changes key order and whitespace and every signature then fails.
 */
export async function verifyWebhookSignature(opts: {
  payload: string
  headers: WebhookHeaders
  secret: Uint8Array
  now?: Date
  toleranceSeconds?: number
}): Promise<SignatureCheck> {
  const { id, timestamp, signature } = opts.headers
  if (!id) return { ok: false, reason: 'no webhook-id header' }
  if (!timestamp) return { ok: false, reason: 'no webhook-timestamp header' }
  if (!signature) return { ok: false, reason: 'no webhook-signature header' }
  if (!/^\d+$/.test(timestamp.trim())) return { ok: false, reason: 'timestamp is not unix seconds' }

  // The timestamp is inside the signed string, so it cannot be edited without
  // breaking the signature — which is what makes this a replay defence and not
  // decoration. Without it, one captured request can be replayed forever.
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  const tolerance = opts.toleranceSeconds ?? HOOK_TOLERANCE_SECONDS
  if (Math.abs(nowSeconds - Number(timestamp.trim())) > tolerance) {
    return { ok: false, reason: 'timestamp outside tolerance' }
  }

  const expected = await signWebhook({
    payload: opts.payload,
    id,
    timestamp: timestamp.trim(),
    secret: opts.secret,
  })

  for (const entry of signature.trim().split(/\s+/)) {
    const comma = entry.indexOf(',')
    if (comma < 0) continue
    if (entry.slice(0, comma) !== 'v1') continue
    if (timingSafeEqual(expected, entry.slice(comma + 1))) return { ok: true }
  }
  return { ok: false, reason: 'signature mismatch' }
}

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

/**
 * The same URL Supabase's own templates build, so nothing else in the flow has
 * to change.
 *
 * `{supabase url}/auth/v1/verify?token={token_hash}&type={action}&redirect_to=…`
 *
 * TWO THINGS THAT LOOK LIKE DETAILS AND ARE NOT.
 *
 * The base is OUR configured PUBLIC_SUPABASE_URL and never `email_data.site_url`
 * from the payload. The payload is signed, so this is belt-and-braces rather
 * than a hole being closed — but the host in a link we ask a customer to click
 * should come from our own configuration, full stop.
 *
 * `token_hash` is passed through EXACTLY as received, including the `pkce_`
 * prefix it carries on a PKCE project. That prefix is what makes the verify
 * endpoint hand back a `code` for /auth/callback to exchange, which is what this
 * application's sign-up and reset flows already expect.
 */
export function actionLink(opts: {
  supabaseUrl: string
  tokenHash: string
  type: string
  redirectTo?: string
}): string {
  const url = new URL(`${opts.supabaseUrl.replace(/\/+$/, '')}/auth/v1/verify`)
  url.searchParams.set('token', opts.tokenHash)
  url.searchParams.set('type', opts.type)
  const redirect = safeRedirect(opts.redirectTo)
  if (redirect) url.searchParams.set('redirect_to', redirect)
  return url.toString()
}

/** An absolute http(s) URL, or nothing. Supabase has already matched it against
 *  the project's allow-list; this only refuses a shape that cannot be a link. */
function safeRedirect(raw: string | undefined): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

/**
 * WHO READS THESE. Los Angeles fleet owners, many of whom do not read English
 * comfortably, on a phone, while doing something else. These are the first
 * emails anybody ever gets from this product.
 *
 * So: short sentences. Ordinary words. The action first and the explanation
 * after. No marketing, no clever punctuation, nothing that needs a second read.
 * Every one of them ends by saying what to do if it was not you, because the
 * commonest reason a person stares at one of these is that they did not ask
 * for it.
 */
const SUPPORT = 'info@fleetviewcompliance.com'
const PRODUCT = 'FleetView Compliance'

function linkBody(lines: string[], link: string, closing: string): string {
  return `${lines.join('\n')}\n\n${link}\n\n${closing}\n`
}

function confirmMessage(to: string, link: string): AuthMessage {
  return {
    to,
    subject: 'Confirm your email address',
    body: linkBody(
      [`Welcome to ${PRODUCT}.`, '', 'Open this link to confirm your email address:'],
      link,
      'The link works one time only.\n\nIf you did not sign up, you can ignore this email.',
    ),
  }
}

function recoveryMessage(to: string, link: string): AuthMessage {
  return {
    to,
    subject: 'Reset your password',
    body: linkBody(
      [
        `Someone asked to reset the password for your ${PRODUCT} account.`,
        '',
        'Open this link to set a new password:',
      ],
      link,
      'The link works one time only.\n\nIf you did not ask for this, ignore this email. Your password does not change.',
    ),
  }
}

function magicLinkMessage(to: string, link: string): AuthMessage {
  return {
    to,
    subject: 'Your sign-in link',
    body: linkBody(
      [`Open this link to sign in to ${PRODUCT}:`],
      link,
      'The link works one time only.\n\nIf you did not ask for this, ignore this email.',
    ),
  }
}

function inviteMessage(to: string, link: string): AuthMessage {
  return {
    to,
    subject: `You have been invited to ${PRODUCT}`,
    body: linkBody(
      [`You have been invited to join ${PRODUCT}.`, '', 'Open this link to set up your account:'],
      link,
      `If you were not expecting this, ignore this email or write to ${SUPPORT}.`,
    ),
  }
}

function codeMessage(to: string, code: string, purpose: 'sign in' | 'confirm'): AuthMessage {
  const subject = purpose === 'sign in' ? 'Your sign-in code' : 'Your confirmation code'
  const line =
    purpose === 'sign in'
      ? `${code} is your code to sign in to ${PRODUCT}.`
      : `${code} is your code to confirm this change on ${PRODUCT}.`
  return {
    to,
    subject,
    body: `${line}\n\nDo not share this code with anyone.\n\nIf you did not ask for this, ignore this email.\n`,
  }
}

/**
 * THE PAIRING THAT IS EASY TO GET BACKWARDS.
 *
 * From `internal/api/mail.go` in Supabase's auth server:
 *
 *   email_data.token_hash     = user.email_change_token_new     → the NEW address
 *   email_data.token_hash_new = user.email_change_token_current → the CURRENT one
 *
 * Yes, `token_hash_new` is the token for the CURRENT address. Supabase's own
 * source carries a `BUG(cstockton)` comment saying the two fields were wired the
 * wrong way round and are kept that way for backwards compatibility. Swapping
 * them here would send each person a link that verifies the other person's
 * address, and the change would appear to work right up until it did not.
 *
 * `token_hash_new` is only populated when "Secure email change" is on, which is
 * exactly when the second message is wanted, so its presence is the condition.
 */
function emailChangeMessages(
  user: HookUser,
  data: HookEmailData,
  supabaseUrl: string,
): AuthMessage[] {
  const messages: AuthMessage[] = []
  const newEmail = (user.new_email ?? '').trim()
  const currentEmail = (user.email ?? '').trim()
  const redirectTo = data.redirect_to

  if (newEmail && data.token_hash) {
    messages.push({
      to: newEmail,
      subject: 'Confirm your new email address',
      body: linkBody(
        [
          `This address was given as the new email address for a ${PRODUCT} account.`,
          '',
          'Open this link to confirm it:',
        ],
        actionLink({ supabaseUrl, tokenHash: data.token_hash, type: 'email_change', redirectTo }),
        `If you did not ask for this, ignore this email or write to ${SUPPORT}.`,
      ),
    })
  }

  if (
    currentEmail &&
    data.token_hash_new &&
    currentEmail.toLowerCase() !== newEmail.toLowerCase()
  ) {
    messages.push({
      to: currentEmail,
      subject: 'Confirm the change to your email address',
      body: linkBody(
        [
          `Someone asked to change the email address on your ${PRODUCT} account${
            newEmail ? ` to ${newEmail}` : ''
          }.`,
          '',
          'Open this link to approve the change:',
        ],
        actionLink({
          supabaseUrl,
          tokenHash: data.token_hash_new,
          type: 'email_change',
          redirectTo,
        }),
        `If this was not you, do not open the link. Change your password and write to ${SUPPORT}.`,
      ),
    })
  }

  return messages
}

/** The "something changed on your account" family. No link, by design: there is
 *  nothing to click, and a link in a security notice teaches the wrong habit. */
function noticeMessage(to: string, subject: string, what: string): AuthMessage {
  return {
    to,
    subject,
    body: `${what}\n\nIf this was not you, write to ${SUPPORT} right away.\n`,
  }
}

function notification(action: string, to: string, data: HookEmailData): AuthMessage | null {
  switch (action) {
    case 'password_changed_notification':
      return noticeMessage(
        to,
        'Your password was changed',
        `The password on your ${PRODUCT} account was changed.`,
      )
    case 'email_changed_notification':
      return noticeMessage(
        to,
        'Your email address was changed',
        `The email address on your ${PRODUCT} account was changed${
          data.old_email ? ` from ${data.old_email}` : ''
        }.`,
      )
    case 'phone_changed_notification':
      return noticeMessage(
        to,
        'Your phone number was changed',
        `The phone number on your ${PRODUCT} account was changed.`,
      )
    case 'identity_linked_notification':
      return noticeMessage(
        to,
        'A new sign-in method was added',
        `A new way to sign in${data.provider ? ` (${data.provider})` : ''} was added to your ${PRODUCT} account.`,
      )
    case 'identity_unlinked_notification':
      return noticeMessage(
        to,
        'A sign-in method was removed',
        `A way to sign in${data.provider ? ` (${data.provider})` : ''} was removed from your ${PRODUCT} account.`,
      )
    case 'mfa_factor_enrolled_notification':
      return noticeMessage(
        to,
        'Two-step sign-in was turned on',
        `Two-step sign-in was turned on for your ${PRODUCT} account.`,
      )
    case 'mfa_factor_unenrolled_notification':
      return noticeMessage(
        to,
        'Two-step sign-in was turned off',
        `Two-step sign-in was turned off for your ${PRODUCT} account.`,
      )
    default:
      return null
  }
}

/**
 * Turn one hook call into the messages it should produce.
 *
 * A REFUSAL IS A VALUE, never a throw and never an empty list treated as
 * success. The endpoint turns `ok: false` into an error Supabase can see, so a
 * payload we do not understand shows up as a failed signup rather than as a
 * customer waiting for an email that was never composed.
 */
export function composeAuthEmails(
  payload: SendEmailHookPayload,
  opts: { supabaseUrl: string },
): Composed {
  const user = payload.user ?? {}
  const data = payload.email_data ?? {}
  const action = (data.email_action_type ?? '').trim()
  const supabaseUrl = opts.supabaseUrl.trim()

  if (!action) return { ok: false, reason: 'payload carried no email_action_type' }
  if (!supabaseUrl) return { ok: false, reason: 'PUBLIC_SUPABASE_URL is not configured' }

  const to = (user.email ?? '').trim()
  const redirectTo = data.redirect_to

  if (action === 'email_change') {
    const messages = emailChangeMessages(user, data, supabaseUrl)
    if (messages.length === 0) {
      return { ok: false, reason: 'email change carried no address and token to confirm' }
    }
    return { ok: true, action, messages }
  }

  const notice = notification(action, to, data)
  if (notice) {
    if (!to) return { ok: false, reason: `${action} carried no recipient` }
    return { ok: true, action, messages: [notice] }
  }

  if (!to) return { ok: false, reason: `${action} carried no recipient` }

  // The two code-only shapes. Supabase's own templates for these print the OTP
  // and no link, and a code is genuinely better here: reauthentication happens
  // in a session that is already open, so a link would send the person to a
  // second tab for no reason.
  if (action === 'reauthentication') {
    if (!data.token) return { ok: false, reason: 'reauthentication carried no token' }
    return { ok: true, action, messages: [codeMessage(to, data.token, 'confirm')] }
  }

  const tokenHash = (data.token_hash ?? '').trim()
  if (!tokenHash) {
    // `email` is the one-time-code sign-in. It may arrive with only the code.
    if (action === 'email' && data.token) {
      return { ok: true, action, messages: [codeMessage(to, data.token, 'sign in')] }
    }
    return { ok: false, reason: `${action} carried no token_hash` }
  }

  const link = actionLink({ supabaseUrl, tokenHash, type: action, redirectTo })

  switch (action) {
    case 'signup':
      return { ok: true, action, messages: [confirmMessage(to, link)] }
    case 'recovery':
      return { ok: true, action, messages: [recoveryMessage(to, link)] }
    case 'invite':
      return { ok: true, action, messages: [inviteMessage(to, link)] }
    case 'magiclink':
    case 'email':
      return { ok: true, action, messages: [magicLinkMessage(to, link)] }
    default:
      // An action type Supabase added after this was written, carrying a token
      // to confirm. Sending a plain "confirm this" beats refusing: the flow
      // still completes, and the wording promises nothing it does not know.
      return {
        ok: true,
        action,
        messages: [
          {
            to,
            subject: 'Confirm this request',
            body: linkBody(
              [
                `Someone asked for this on your ${PRODUCT} account.`,
                '',
                'Open this link to confirm it:',
              ],
              link,
              `If you did not ask for this, ignore this email or write to ${SUPPORT}.`,
            ),
          },
        ],
      }
  }
}
