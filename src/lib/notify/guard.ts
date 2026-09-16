/**
 * The last thing every outbound message passes through.
 *
 * The bug this exists to prevent has a specific shape: a developer runs the
 * digest job against a copy of production data, and forty real carriers get a
 * 6am text about a deadline they do not have. That is not a bug you apologise
 * for — it is the end of the relationship, because the one thing this product
 * sells is that when it texts you, it is right.
 *
 * So the rule is inverted from the usual. Sending is DENIED unless something
 * explicitly permits it, and an unconfigured environment sends nothing at all
 * rather than sending to whoever happens to be in the database.
 */

export type Channel = 'email' | 'sms'

export interface Outbound {
  channel: Channel
  to: string
  subject?: string
  body: string
}

export type Verdict = { allow: true; to: string; note?: string } | { allow: false; reason: string }

export interface GuardConfig {
  /** 'production' is the only value that permits sending to a real recipient. */
  mode: string | undefined
  /** In any other mode, everything is redirected here. Unset means send nothing. */
  redirectEmail?: string
  redirectPhone?: string
}

export function guard(message: Outbound, config: GuardConfig): Verdict {
  if (!message.to || !message.to.trim()) {
    return { allow: false, reason: 'no destination' }
  }

  if (config.mode === 'production') {
    return { allow: true, to: message.to }
  }

  // Outside production every message is redirected, never suppressed silently —
  // a developer needs to SEE what would have gone out, and to whom it was
  // originally addressed.
  const redirect = message.channel === 'email' ? config.redirectEmail : config.redirectPhone

  if (!redirect) {
    // Deliberately a refusal, not a pass-through. An unset redirect in a
    // non-production environment means somebody has not finished configuring it,
    // and the safe reading of that is "do not send", not "send to the customer".
    return {
      allow: false,
      reason:
        `not production and no ${message.channel} redirect configured — ` +
        'refusing to send to a real recipient',
    }
  }

  return {
    allow: true,
    to: redirect,
    note: `redirected from ${message.to}`,
  }
}

/**
 * One item, one recipient, one lead window, one send. Ever.
 *
 * Without a stable key an overdue item messages the owner every morning until
 * he fixes it — which is exactly how a product earns a mute. The lead window is
 * part of the key so the 30-day and 7-day warnings are genuinely different
 * messages, and the due date is in it so next year's cycle sends again.
 */
export function dedupKey(parts: {
  userId: string
  ruleCode: string
  subjectId: string | null
  dueOn: string
  leadDays: number
  channel: Channel
}): string {
  return [
    parts.userId,
    parts.ruleCode,
    parts.subjectId ?? 'carrier',
    parts.dueOn,
    String(parts.leadDays),
    parts.channel,
  ].join('|')
}

/**
 * Whether a message may be delivered right now, given the recipient's quiet
 * hours.
 *
 * Returns the reason rather than a bare boolean so the caller can log why a
 * message was held — "we sent nothing" is a support question nobody can answer
 * without it.
 */
export function withinQuietHours(
  nowLocalMinutes: number,
  quietFromMinutes: number | null,
  quietToMinutes: number | null,
): boolean {
  if (quietFromMinutes === null || quietToMinutes === null) return false
  // A window that wraps midnight (22:00 to 07:00) is the normal case, not the
  // edge case — so handle it first rather than as an afterthought.
  if (quietFromMinutes > quietToMinutes) {
    return nowLocalMinutes >= quietFromMinutes || nowLocalMinutes < quietToMinutes
  }
  return nowLocalMinutes >= quietFromMinutes && nowLocalMinutes < quietToMinutes
}

/**
 * A Postgres `time` value as minutes past midnight.
 *
 * `time` comes back over PostgREST as 'HH:MM:SS', and the settings page's
 * `<input type="time">` round-trips it as 'HH:MM'. Both must parse to the same
 * number, or a quiet window would mean two different things depending on which
 * side of the round trip it was read from.
 *
 * Anything unparseable returns null, which `withinQuietHours` reads as NO quiet
 * hours — that is, "send it". Deliberately that way round: a value we cannot
 * read must not be allowed to silence somebody's alerts, because a held message
 * is a deadline they were not told about and a sent one is at worst badly timed.
 */
export function parseClockTime(value: string | null | undefined): number | null {
  if (!value) return null
  const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim())
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (minutes > 59) return null
  // Postgres genuinely accepts '24:00:00' as the end of a day, and it is the
  // only way to say "quiet until midnight" in that type. 1440 makes the
  // same-day branch above cover 22:00 → end of day correctly.
  if (hours > 24 || (hours === 24 && minutes !== 0)) return null
  return hours * 60 + minutes
}

/**
 * The recipient's own clock, as minutes past midnight.
 *
 * Quiet hours are meaningless without this: the job runs on one server clock and
 * "do not wake me before 7" is a statement about the hour where the person is
 * standing. `Intl` is the only thing in the runtime that knows a zone's current
 * offset including whatever daylight saving is doing this week.
 *
 * Null when the zone cannot be resolved. The caller must read that as "we do not
 * know, so send" rather than "hold" — a profile holding a junk zone string must
 * not quietly become a person who is never told anything.
 */
export function minutesOfDayInZone(at: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at)

    const hour = Number(parts.find((p) => p.type === 'hour')?.value)
    const minute = Number(parts.find((p) => p.type === 'minute')?.value)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null

    // `hour12: false` renders midnight as '24' in some ICU versions and '00' in
    // others. Un-modded, that makes 00:30 read as 1470 minutes — past the end of
    // the day — and a 22:00-to-07:00 quiet window would stop covering the exact
    // hours it exists for.
    return (hour % 24) * 60 + minute
  } catch {
    // Intl throws RangeError on a zone it cannot resolve — 'Pacific' and
    // 'Pacific Standard Time' are both real things people type into a timezone
    // field. What it does NOT throw on is the legacy three-letter zones, and
    // that is the more dangerous case: 'EST' resolves to a FIXED UTC-5 zone that
    // never observes daylight saving, so it is silently an hour out for eight
    // months of the year. Nothing here can catch that; `isKnownTimezone` in
    // preferences.ts is what keeps such a string out of the column at all.
    return null
  }
}
