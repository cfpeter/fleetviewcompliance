/**
 * "You already asked him. Four days ago. He never opened it."
 *
 * WHY THIS IS A MODULE AND NOT A TERNARY ON A CARD. `driver_links` has carried
 * `opened_at` since 0034 — the column exists precisely so that months later,
 * when a medical card has lapsed and the driver says nobody ever asked him,
 * there is an answer. Nothing read it. So the dashboard offered "Ask him" in
 * exactly the same words to a driver who was asked this morning and to one who
 * has never been asked at all, and the owner's only way to tell them apart was
 * to remember.
 *
 * The sentence has to distinguish four states that call for four different
 * next moves, and getting them wrong is worse than saying nothing:
 *
 *   sent and not opened    he may not have seen it. Send it again.
 *   sent and opened        he saw it and did not finish. Ring him.
 *   never actually sent    we had no number and no email; the link is sitting
 *                          there waiting for the owner to pass it on himself.
 *   run out                the link is dead and pressing anything that says
 *                          "again" has to mean a NEW one.
 *
 * All four are one row's worth of facts, so they are decided here, once, in a
 * pure function a test can hold still.
 */

/** One live link, as much of the row as the sentence needs. */
export interface OutstandingLink {
  driverId: string
  createdAt: Date
  openedAt: Date | null
  expiresAt: Date
  /** 'sms' | 'email' | 'copied' — what we TRIED. Never what arrived. */
  channel: string | null
}

export interface ChaseState {
  /** Has he opened it? Decides whether the next move is a resend or a call. */
  opened: boolean
  /** Past `expires_at`: whatever happens next has to mint a new link. */
  expired: boolean
  /** True when there was nowhere to send it, so nobody has asked him yet. */
  unsent: boolean
  /** One line for the card, in his words. */
  line: string
  /** What the menu item says instead of "Ask him". */
  action: string
}

const DAY = 86_400_000

/**
 * Whole days between two instants, floored.
 *
 * Deliberately NOT calendar days. "Asked 1 day ago" for something sent 90
 * minutes ago, because the clock crossed midnight, reads as neglect that has
 * not happened yet — and this line exists to tell him whether to chase.
 */
export function daysAgo(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY))
}

/** "today", "yesterday", "4 days ago" — the tail of every sentence below. */
export function agoPhrase(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

export function chaseState(link: OutstandingLink, now: Date): ChaseState {
  const days = daysAgo(link.createdAt, now)
  const when = agoPhrase(days)
  const expired = link.expiresAt.getTime() <= now.getTime()
  const opened = link.openedAt !== null
  const unsent = link.channel === 'copied' || link.channel === null

  if (expired) {
    return {
      opened,
      expired,
      unsent,
      line: `The link you sent ${when} has run out.`,
      action: 'Send a new link',
    }
  }

  if (unsent) {
    return {
      opened,
      expired,
      unsent,
      // Not "asked": nothing left the building. Saying he was asked would be
      // the one lie this line must never tell.
      line: `Link made ${when}. Nobody has sent it to them yet.`,
      action: 'Make a new link',
    }
  }

  if (opened) {
    return {
      opened,
      expired,
      unsent,
      line: `Asked ${when}. They opened it and sent nothing back.`,
      action: 'Ask again',
    }
  }

  return {
    opened,
    expired,
    unsent,
    line: `Asked ${when}. Not opened yet.`,
    action: 'Ask again',
  }
}

/**
 * The newest live link per driver.
 *
 * `mintDriverLink` supersedes a link asking for the SAME things, so a driver
 * can hold more than one at once — a licence link and a medical link are two
 * errands. The card has room for one sentence, and the newest is the one the
 * owner is deciding about, so the newest wins. Rows arrive newest first.
 */
export function newestPerDriver(rows: readonly OutstandingLink[]): Map<string, OutstandingLink> {
  const out = new Map<string, OutstandingLink>()
  for (const row of rows) {
    const held = out.get(row.driverId)
    if (!held || row.createdAt.getTime() > held.createdAt.getTime()) out.set(row.driverId, row)
  }
  return out
}
