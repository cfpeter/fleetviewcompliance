/**
 * The two screens between a stranger and a carrier record.
 *
 * Everything in here is pure so it can be tested without a browser, a session
 * or the federal data service. The pages that use it — /login and /app/setup —
 * hold the words; this file holds the decisions the words depend on.
 */

import { CLAIM_POLICY, type ClaimVerdict } from './claims.ts'
import type { CensusRow } from './fmcsa.ts'

// ------------------------------------------------------------------ mode

/** Which job the visitor is doing. One screen shows exactly one of them. */
export type AuthMode = 'signin' | 'signup'

/**
 * Read `?mode=` into an intent.
 *
 * Anything unrecognised resolves to sign-in, which is the safe half: the worst
 * outcome is a new visitor seeing the sign-in screen and taking the "create an
 * account" link one click later. Defaulting the other way shows "Create your
 * account" to a returning customer, who then wonders whether we lost his.
 */
export function parseAuthMode(raw: string | null | undefined): AuthMode {
  return raw === 'signup' ? 'signup' : 'signin'
}

// -------------------------------------------------------------- passwords

/**
 * The shortest password this application will set, anywhere.
 *
 * ONE RULE, ONE NUMBER. It is enforced on the sign-up form, on the settings
 * page, and on the reset screen, and the help line under every one of those
 * boxes is written from this constant rather than typed. A minimum that is 8 on
 * one screen and 6 on another is not a policy, it is three screens disagreeing
 * — and the one a customer meets on the day they are locked out is the one that
 * decides whether they get back in.
 *
 * NOT enforced on the SIGN-IN box, deliberately: the Supabase project setting
 * has been lower, so an existing password may be shorter than this, and a form
 * that refuses to send it locks out somebody whose password is perfectly good.
 */
export const MIN_PASSWORD = 8

/**
 * What is wrong with a new password typed into two boxes, as a notice code.
 * Null means nothing is.
 *
 * TWO BOXES, ALWAYS, on every screen that sets a password without asking for
 * the old one. A typo typed once into one box is a password nobody knows, on an
 * account whose only way back is another trip through the email — and for a
 * carrier whose address on file is an old dispatcher's, there may not be one.
 *
 * Length first. A person who mistyped BOTH boxes the same way and typed
 * something too short should hear the fixable thing, and "too short" is fixable
 * without retyping both boxes from scratch.
 */
export function passwordProblem(next: string, again: string): string | null {
  if (next.length < MIN_PASSWORD) return 'password_short'
  if (next !== again) return 'password_mismatch'
  return null
}

// ---------------------------------------------------------------- notices

export type NoticeTone = 'error' | 'ok' | 'info'

export interface Notice {
  tone: NoticeTone
  text: string
}

/**
 * Every sentence these two pages can say about an outcome, by code.
 *
 * The URL used to carry the sentence itself — `/login?error=<free text>`,
 * rendered straight into the page. That let anybody write in our voice, on our
 * domain, on the screen that asks for a password: send a carrier
 * `/login?error=Your%20account%20is%20locked,%20call%20555-0100` and the page
 * says it, in our styling, above our own form. Codes mean the page can only
 * ever repeat something written here, and an unrecognised code says nothing at
 * all rather than guessing.
 *
 * It also stops a raw Postgres or Supabase message reaching a customer, which
 * is the other way that URL filled up with text nobody wrote on purpose.
 */
const NOTICES: Record<string, Notice> = {
  // ---- /login
  credentials: { tone: 'error', text: 'That email and password do not match.' },
  missing: { tone: 'error', text: 'Enter an email address and a password.' },
  terms_required: {
    tone: 'error',
    // Says what to do, in the fewest common words that still name both
    // documents. No "you must", no "in order to proceed": a refusal a customer
    // cannot read is a customer who leaves rather than one who ticks the box.
    text: 'Tick the box to agree to the Terms and the Privacy Policy.',
  },
  weak_password: { tone: 'error', text: 'Use a password of at least 8 characters.' },
  bad_email: { tone: 'error', text: 'That does not look like an email address.' },
  // NOT "wait a minute". This code covers two different limits and one of them
  // is measured in HOURS: Supabase caps how many emails a project may send, and
  // a signup that trips that cap is not retryable in sixty seconds. Telling
  // somebody to wait a minute sends them straight back into the same refusal,
  // twice, and the third time they decide the product is broken.
  //
  // So the wording promises no number it cannot keep, and names the one thing
  // that actually helps: come back later, and say something if it persists —
  // because a real carrier hitting this on a first signup means the cap is set
  // wrong, and that is our problem to fix, not theirs to wait out.
  rate_limited: {
    tone: 'error',
    text: 'Too many tries. Wait a few minutes and try again. If it keeps happening, write to us.',
  },
  signup_failed: {
    tone: 'error',
    text: 'We could not create that account just now. Try again in a moment.',
  },
  check_email: {
    tone: 'ok',
    text: 'If that address can have an account here, a confirmation link is on its way. Open it, then sign in below.',
  },
  link_expired: {
    tone: 'error',
    text: 'That confirmation link has expired or has already been used. Sign in below, or sign up again to get a new one.',
  },
  link_invalid: {
    tone: 'error',
    text: 'That confirmation link is not one we can read. Sign up again to get a fresh one.',
  },

  // ---- /auth/forgot-password and /auth/new-password
  //
  // THE SAME SENTENCE FOR EVERY ADDRESS. The sign-in form refuses to
  // distinguish "no such account" from "wrong password", and a reset form that
  // said "we have no account for that address" would hand back the fact the
  // sign-in form is protecting — ask it about a competitor's dispatcher and it
  // answers. So `reset_sent` is worded to be true whether or not there is an
  // account, and resetOutcome() below sends every account-shaped failure here.
  reset_sent: {
    tone: 'ok',
    text:
      'If that email has an account here, we just sent it a link. Open the email and pick a new ' +
      'password. The link works one time only.',
  },
  reset_failed: {
    tone: 'error',
    text: 'We could not send that link just now. Try again in a moment.',
  },
  email_needed: { tone: 'error', text: 'Enter your email address.' },
  reset_link_unusable: {
    tone: 'error',
    // Three causes, one sentence, because the person cannot act on the
    // difference and we must not say which it was: an expired link and an
    // already-used one are different facts about a link somebody may be holding
    // without owning it.
    text:
      'That link did not work. It may be old, it may have been used already, or it may have been ' +
      'opened on a different phone or computer. Ask for a new link below.',
  },
  reset_link_missing: {
    tone: 'error',
    text: 'That link is not complete. Ask for a new link below.',
  },
  password_not_saved: {
    tone: 'error',
    text: 'We could not save that password. Ask for a new link below and try again.',
  },
  password_short: {
    tone: 'error',
    text: `Your new password is too short. Use ${MIN_PASSWORD} letters or numbers or more.`,
  },
  password_mismatch: {
    tone: 'error',
    text: 'The two passwords are not the same. Type the same one in both boxes.',
  },

  // ---- /app/setup
  dot_invalid: { tone: 'error', text: 'A USDOT number is between one and eight digits.' },
  dot_taken: {
    tone: 'error',
    // Reached only AFTER a correct code, which is the one place the database is
    // willing to admit that a number is already set up here. The old wording
    // told people to ask for an invite; there is no invite mechanism and no
    // transfer path, so it was advice nobody could act on.
    text:
      'That USDOT number is already set up under another account. You have proved you control ' +
      'the contact on the federal record and we have kept that proof, which is what a transfer ' +
      'is decided on — ask for a manual review and a person will pick it up.',
  },
  name_needed: {
    tone: 'error',
    // The legal name is read from the census and never typed, so this is now a
    // statement about the federal record rather than about the form.
    text:
      'The federal record for that number carries no legal name, so there is nothing to file the ' +
      'carrier under. Ask for a manual review below.',
  },
  create_failed: {
    tone: 'error',
    text: 'We could not set that carrier up just now. Try again in a moment.',
  },

  // ---- /app/setup, USDOT ownership verification
  //
  // Every refusal below is its own sentence, with one deliberate exception
  // documented at CLAIM_NOTICES.
  claim_unconfigured: {
    tone: 'error',
    // Operator-facing on purpose. A customer who sees it can do nothing about
    // it, so it says so plainly rather than asking them to try again — and it
    // points at the one path that still works without the secret.
    text:
      'Verification is not configured on this deployment — CLAIM_CODE_PEPPER is unset — so no ' +
      'code can be sent. Nothing you did caused this. A manual review still works.',
  },
  claim_census_down: {
    tone: 'error',
    text:
      'The federal data service did not answer just now, so we could not read your record. That ' +
      'is their end, not yours. Wait a moment and try again.',
  },
  claim_channel_gone: {
    tone: 'error',
    text: 'The federal record no longer lists that contact. Pick from what is on it now.',
  },
  claim_failed: {
    tone: 'error',
    text: 'We could not start that verification just now. Try again in a moment.',
  },
  claim_sent: { tone: 'ok', text: 'The code is on its way. Enter it below.' },
  claim_send_blocked: {
    tone: 'error',
    // 'skipped' from send(). Either no provider is configured or the guard
    // refused because this is not production and no redirect is set. Both are
    // operator problems, and neither sent anything.
    text:
      'Nothing was sent: this deployment has no way to send on that channel. No code is on its ' +
      'way. Try the other contact on your federal record, or ask for a manual review.',
  },
  claim_send_failed: {
    tone: 'error',
    // The measured failure this exists for: a census phone is often the office
    // landline the carrier filed, and SMS to it goes nowhere.
    text:
      'The message was refused, so no code went out. The phone on a federal record is often a ' +
      'landline, which cannot receive a text. Try the other contact on your record, or ask for a ' +
      'manual review.',
  },
  claim_cooldown: {
    tone: 'error',
    text: `Wait ${CLAIM_POLICY.resendCooldownSeconds} seconds between codes. The last one may still be arriving.`,
  },
  claim_dot_hour: {
    tone: 'error',
    // Worded about the NUMBER rather than about you, because the limit counts
    // everybody's attempts against it — the person whose phone rings never
    // asked to be involved, and this cap is what protects them.
    text: `That USDOT number has had the ${CLAIM_POLICY.sendsPerDotHour} codes it can take this hour. Try again in an hour, or ask for a manual review.`,
  },
  claim_dot_day: {
    tone: 'error',
    text: `That USDOT number has had the ${CLAIM_POLICY.sendsPerDotDay} codes it can take today. Try again tomorrow, or ask for a manual review.`,
  },
  claim_user_hour: {
    tone: 'error',
    text: `You have sent the ${CLAIM_POLICY.sendsPerUserHour} codes we allow in an hour. Try again in an hour.`,
  },
  claim_user_day: {
    tone: 'error',
    text: `You have sent the ${CLAIM_POLICY.sendsPerUserDay} codes we allow in a day. Try again tomorrow, or ask for a manual review.`,
  },
  claim_code_shape: {
    tone: 'error',
    text: `Enter the ${CLAIM_POLICY.codeDigits} digits from the message. Spaces and dashes are fine.`,
  },
  claim_wrong: {
    tone: 'error',
    // How many guesses are left is NOT in here. It is a fact about one claim,
    // it changes on every attempt, and the screen reads it back from the
    // database — a number baked into a static sentence would go stale the
    // moment somebody opened a second tab.
    text: 'That code does not match.',
  },
  claim_expired: {
    tone: 'error',
    text: `That code has expired. They last ${CLAIM_POLICY.ttlMinutes} minutes — send yourself a new one.`,
  },
  claim_exhausted: {
    tone: 'error',
    text: `That code is finished: ${CLAIM_POLICY.maxAttempts} wrong guesses and it stops working. Send a new one and the count starts over.`,
  },
  claim_none: {
    tone: 'error',
    text: 'There is no code waiting on that number. Start again below.',
  },
  manual_queued: {
    tone: 'ok',
    text: 'Your request is recorded. A person reads these by hand.',
  },
  manual_limit: {
    tone: 'error',
    text: `You have asked for the ${CLAIM_POLICY.manualPerUserDay} manual reviews we take in a day. Try again tomorrow.`,
  },
  manual_failed: {
    tone: 'error',
    text: 'We could not record that request just now. Try again in a moment.',
  },
  // The request IS saved. What failed is us telling ourselves about it, and
  // that is worth its own words rather than a cheerful "recorded".
  //
  // The screen this lands on says "Your request is with a person". If the
  // notification did not go out, nobody has it — it is a row in a table waiting
  // for somebody to happen to look. Saying "recorded" there would be true and
  // useless: the carrier would wait thirty days on a queue nobody is watching.
  // So he is told plainly, and pointed at the one control on that page that
  // reaches a human without us in the middle.
  manual_unannounced: {
    // 'error' and not 'info', even though the request itself saved. The half
    // that failed is the half the carrier needs, and a quiet blue note would be
    // read as "fine" by somebody who then waits a month.
    tone: 'error',
    text: 'We saved your request, but our own alert did not go out. Use the email button below so somebody sees it today.',
  },
}

/**
 * A code from the query string, or null when it is not one of ours.
 *
 * `Object.hasOwn`, not a plain lookup: `NOTICES['toString']` finds a function on
 * Object.prototype, which is truthy, so `?? null` would hand the page something
 * to render for `?notice=constructor`. An allow-list that answers to inherited
 * keys is not an allow-list.
 */
export function notice(code: string | null | undefined): Notice | null {
  if (!code) return null
  return Object.hasOwn(NOTICES, code) ? NOTICES[code] : null
}

// ------------------------------------------------------- claim notice codes

/**
 * Everything `complete_carrier_claim` can answer, in the vocabulary of
 * `verifyClaim`.
 *
 * `already_claimed` is the one outcome the pure mirror has no word for, because
 * it is not a verdict on the code at all — the code was right, and the number
 * turned out to be taken.
 */
export type ClaimOutcome = ClaimVerdict['state'] | 'already_claimed'

/**
 * The SQL status, as an outcome. Null when it is not a status we know.
 *
 * THE DATABASE IS COARSER THAN THE MIRROR, ON PURPOSE. `complete_carrier_claim`
 * looks up the claim filtered by `user_id = auth.uid()`, `verified_at is null`
 * and `voided_at is null` — so "somebody else holds a live claim on that
 * number", "you already finished yours", "we killed it after a failed send" and
 * "you never started one" all come back as the single word `no_claim`. That
 * collapse is the anti-enumeration property: if this flow answered differently
 * for a number another account is mid-claim on, it would be a free API for
 * finding out which carriers are worth squatting. So the mapping goes the other
 * way — `no_claim` becomes `not_yours`, and CLAIM_NOTICES gives `not_yours`,
 * `used` and `voided` one shared sentence.
 */
export function claimStatusOutcome(status: string | null | undefined): ClaimOutcome | null {
  switch (status) {
    case 'created':
      return 'ok'
    case 'already_claimed':
      return 'already_claimed'
    case 'wrong_code':
      return 'wrong_code'
    case 'expired':
      return 'expired'
    case 'attempts_exhausted':
      return 'attempts_exhausted'
    case 'no_claim':
      return 'not_yours'
    default:
      return null
  }
}

/**
 * One notice code per outcome, and `null` for the one that is not a refusal.
 *
 * THE THREE THAT SHARE A CODE SHARE IT DELIBERATELY. `not_yours`, `used` and
 * `voided` all print `claim_none`, so a claim held by another account is
 * indistinguishable on screen from one of your own that is finished or dead.
 * Giving `not_yours` its own sentence would confirm to a stranger that somebody
 * else is mid-claim on that USDOT number, which is exactly the fact the
 * database refuses to reveal. The other three are facts about the claimant's
 * own claim and reveal nothing, so they say what actually happened.
 */
const CLAIM_NOTICES: Record<ClaimOutcome, string | null> = {
  ok: null,
  wrong_code: 'claim_wrong',
  expired: 'claim_expired',
  attempts_exhausted: 'claim_exhausted',
  not_yours: 'claim_none',
  used: 'claim_none',
  voided: 'claim_none',
  already_claimed: 'dot_taken',
}

export function claimNotice(outcome: ClaimOutcome): string | null {
  return CLAIM_NOTICES[outcome]
}

/**
 * What `start_carrier_claim` refused on, as a notice code. Null means it did
 * not refuse — the claim row exists and the caller now owes the recipient a
 * message.
 *
 * `Object.hasOwn` for the same reason `notice()` uses it: a plain lookup finds
 * inherited keys, and a status of `constructor` would resolve to a function.
 */
const CLAIM_START_NOTICES: Record<string, string> = {
  cooldown: 'claim_cooldown',
  dot_hour: 'claim_dot_hour',
  dot_day: 'claim_dot_day',
  user_hour: 'claim_user_hour',
  user_day: 'claim_user_day',
  manual_day: 'manual_limit',
}

export function claimStartNotice(status: string | null | undefined): string | null {
  if (!status || status === 'started') return null
  return Object.hasOwn(CLAIM_START_NOTICES, status) ? CLAIM_START_NOTICES[status] : 'claim_failed'
}

// ------------------------------------------------------------ signup errors

/** The shape of a Supabase auth error, without importing their class. */
export interface AuthFailure {
  message?: string
  code?: string
  status?: number
}

/**
 * What the sign-up branch is allowed to say.
 *
 * The sign-in branch is careful never to distinguish "no such account" from
 * "wrong password", because that turns the form into a way to find out who
 * banks here. The sign-up branch reached the same fact by the other door:
 * Supabase answers a sign-up for an address that already has an account with
 * "User already registered" when email confirmation is switched off, and the
 * old code put that message straight in the URL. Anyone could then test an
 * address — a competitor's dispatcher, an ex-employee — and be told.
 *
 * So an already-registered address produces exactly the outcome a brand-new
 * address produces, and the copy for that outcome is worded so it is true
 * either way.
 *
 * Genuine input problems — a password too short, an address that is not an
 * address — are still reported, because those are facts about what the visitor
 * just typed and reveal nothing about who else is a customer.
 */
export function signupOutcome(err: AuthFailure | null | undefined): string {
  if (!err) return 'check_email'

  const code = (err.code ?? '').toLowerCase()
  const message = (err.message ?? '').toLowerCase()

  // Checked first, because "user already registered" would otherwise fall
  // through to the generic failure and still be distinguishable by its wording.
  if (code === 'user_already_exists' || /already registered|already exists/.test(message)) {
    return 'check_email'
  }

  if (err.status === 429 || code.includes('rate_limit') || /rate limit/.test(message)) {
    return 'rate_limited'
  }

  if (code === 'weak_password' || /password.*(short|least|weak)|weak.*password/.test(message)) {
    return 'weak_password'
  }

  if (code === 'email_address_invalid' || /invalid.*email|email.*invalid/.test(message)) {
    return 'bad_email'
  }

  return 'signup_failed'
}

// ------------------------------------------------------------- reset errors

/**
 * What the "I forgot my password" form is allowed to say.
 *
 * THE WHOLE POINT OF THIS FUNCTION IS THE FIRST BRANCH. A reset form is the
 * easiest account-enumeration oracle a product ever ships: type an address,
 * read the answer, learn whether that person is a customer here. The sign-in
 * form is careful never to give that away and signupOutcome() closes the same
 * hole on the other screen; this closes the third door.
 *
 * Supabase already helps — `resetPasswordForEmail` answers an unknown address
 * with success and sends nothing — so the neutral case is the no-error case.
 * The first branch is the belt to that suspender: if a Supabase release ever
 * starts reporting a missing user, the page keeps saying the one sentence it
 * says for everybody instead of quietly becoming a lookup service.
 *
 * Rate limiting and a malformed address are still reported, for the reason
 * signupOutcome() reports them: they are facts about the request that was just
 * made, not about who else has an account here.
 */
export function resetOutcome(err: AuthFailure | null | undefined): string {
  if (!err) return 'reset_sent'

  const code = (err.code ?? '').toLowerCase()
  const message = (err.message ?? '').toLowerCase()

  // Checked first, and answered with the same sentence a real address gets.
  if (code === 'user_not_found' || /user not found|no user|not found/.test(message)) {
    return 'reset_sent'
  }

  if (err.status === 429 || code.includes('rate_limit') || /rate limit/.test(message)) {
    return 'rate_limited'
  }

  if (code === 'email_address_invalid' || /invalid.*email|email.*invalid/.test(message)) {
    return 'bad_email'
  }

  return 'reset_failed'
}

// ------------------------------------------------------------ census counts

/**
 * A count from the census file, or null when the file does not carry one.
 *
 * Socrata omits a null column entirely instead of sending null, and
 * `Number('')` is 0 — so the obvious `Number(row.power_units)` renders a
 * carrier whose count is simply not on file as a carrier with zero trucks. On
 * the setup screen that difference is the entire message: "FMCSA has you at 0
 * power units" reads as an accusation, and "FMCSA does not list a power-unit
 * count for you" reads as what it is.
 *
 * Digits only, deliberately. The counts are whole numbers; anything else is a
 * value we do not understand, and a value we do not understand is unknown, not
 * zero.
 */
export function censusCount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * What the federal record says the fleet is, as a target to fill in.
 *
 * These are the only fleet numbers FMCSA publishes. They are COUNTS — how many
 * power units and how many drivers the carrier reported on its last MCS-150.
 * There is no public dataset of VINs, plates, driver names or CDL numbers, and
 * the onboarding must never imply otherwise.
 */
export interface FleetTarget {
  /** null means "not on file". Never conflate with 0. */
  powerUnits: number | null
  drivers: number | null
  cdl: number | null
}

export function fleetTarget(row: CensusRow | null | undefined): FleetTarget {
  return {
    powerUnits: censusCount(row?.power_units),
    drivers: censusCount(row?.total_drivers),
    cdl: censusCount(row?.total_cdl),
  }
}

/**
 * Where the roster stands against the federal count.
 *
 * Four outcomes, because collapsing any two of them produces a sentence that is
 * either wrong or insulting. `over` in particular has to be its own case: a
 * carrier who bought two trucks since his last MCS-150 is not "-2 to go", he is
 * a carrier whose federal filing is behind his yard — which is itself worth
 * telling him, since the MCS-150 update is one of the things we track.
 */
export type RosterProgress =
  | { state: 'unknown'; added: number }
  | { state: 'partial'; added: number; target: number; remaining: number }
  | { state: 'met'; added: number; target: number }
  | { state: 'over'; added: number; target: number }

export function rosterProgress(added: number, target: number | null): RosterProgress {
  const have = Number.isFinite(added) && added > 0 ? Math.floor(added) : 0
  if (target === null) return { state: 'unknown', added: have }
  if (have < target) return { state: 'partial', added: have, target, remaining: target - have }
  if (have === target) return { state: 'met', added: have, target }
  return { state: 'over', added: have, target }
}

// ----------------------------------------------------------------- carrier

/** The columns `carriers` has had since 0001 and nothing has ever written. */
export interface CarrierAddress {
  phy_street: string | null
  phy_city: string | null
  phy_state: string | null
  phy_zip: string | null
  phone: string | null
}

/**
 * The carrier's own address and phone, ready to copy onto the carrier row.
 *
 * `carriers` has held `phy_street`, `phy_city`, `phy_state`, `phy_zip` and
 * `phone` since the first migration, the settings page renders them, and
 * setting a USDOT number there says "your federal record will start filling in
 * the rest" — but no code in the application has ever written one of them. The
 * address block on the settings page has therefore always been blank. Signup is
 * the one moment the census row is already in hand.
 *
 * Returns null when the census row carries nothing usable, so the caller can
 * skip the write instead of stamping five NULLs over a row.
 */
export function censusAddress(row: CensusRow | null | undefined): CarrierAddress | null {
  if (!row) return null
  const clean = (v: string | undefined) => {
    const t = (v ?? '').trim()
    return t === '' ? null : t
  }
  const address: CarrierAddress = {
    phy_street: clean(row.phy_street),
    phy_city: clean(row.phy_city),
    phy_state: clean(row.phy_state),
    phy_zip: clean(row.phy_zip),
    phone: clean(row.phone),
  }
  return Object.values(address).some((v) => v !== null) ? address : null
}

/** One line of address for display, or null when there is nothing to show. */
export function addressLine(row: CensusRow | null | undefined): string | null {
  const a = censusAddress(row)
  if (!a) return null
  const cityState = [a.phy_city, a.phy_state].filter(Boolean).join(', ')
  const parts = [a.phy_street, cityState, a.phy_zip].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

/**
 * Interstate or intrastate, and "not stated" when the file does not say.
 *
 * /check renders this as `carrier_operation === 'A' ? 'Interstate' :
 * 'Intrastate'`, which turns a missing value into a positive claim that the
 * carrier is intrastate-only. That claim decides which half of the rule
 * catalogue applies to him — hours of service, drug and alcohol testing and the
 * driver qualification file all hang off it — so a blank has to stay a blank.
 */
export function operationLabel(code: string | null | undefined): string {
  switch ((code ?? '').trim().toUpperCase()) {
    case 'A':
      return 'Interstate'
    case 'B':
    case 'C':
      return 'Intrastate'
    default:
      return 'Not stated'
  }
}

export interface SafetyRating {
  label: string
  tone: string
  /** Shown under the pill. Never empty: a rating code means nothing on its own. */
  note: string
}

/**
 * The safety rating, with the blank case spelled out.
 *
 * Most carriers have never been rated — a rating comes out of a compliance
 * review, and the great majority of small fleets have never had one. So the
 * common case is an empty field, and rendering that as anything other than
 * "never rated, and that is normal" invents a problem on the first screen a new
 * customer sees.
 *
 * Tones follow `statusLabel` in fmcsa.ts, which already maps federal codes onto
 * this palette. Unrated takes the unknown/missing-data pill rather than a place
 * on the red-to-amber urgency scale, because nothing is running out.
 */
export function safetyRating(code: string | null | undefined): SafetyRating {
  switch ((code ?? '').trim().toUpperCase()) {
    case 'S':
      return {
        label: 'Satisfactory',
        tone: 'bg-emerald-100 text-emerald-800',
        note: 'The rating a compliance review gives a carrier it found in order.',
      }
    case 'C':
      return {
        label: 'Conditional',
        tone: 'bg-amber-100 text-amber-800',
        note: 'A compliance review found violations. You may still operate.',
      }
    case 'U':
      return {
        label: 'Unsatisfactory',
        tone: 'bg-red-100 text-red-700',
        note: 'A compliance review found serious violations. This one stops trucks.',
      }
    default:
      return {
        label: 'Not rated',
        tone: 'bg-ink-100 text-ink-500',
        note: 'Most carriers have never had a compliance review. A blank rating is not a finding.',
      }
  }
}
