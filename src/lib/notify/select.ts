/**
 * Deciding what to send. The hard part of an alerting product is not sending —
 * it is not sending.
 */
import type { Standing } from '../rules/compute.ts'
import type { DeadlineItem } from '../rules/index.ts'
import type { Subject } from '../rules/types.ts'
import { type Channel, dedupKey, withinQuietHours } from './guard.ts'
import { DEFAULT_LEAD_DAYS, type NotifyCategory } from './preferences.ts'

export interface Recipient {
  userId: string
  email?: string
  phone?: string
  timezone: string
}

/**
 * One cell of the settings matrix: may we use this wire for this kind of news.
 *
 * `leadDays` and `digest` used to live here too, mirroring a schema that hung
 * them off (category, CHANNEL). They are facts about the DEADLINE — nobody has
 * ever wanted to be emailed 30 days out and texted 7 days out about the same
 * item — so one category stored three copies free to disagree. 0010_cleanup.sql
 * moved them to their own table and this type follows, so the disagreement is
 * no longer even expressible in memory.
 */
export interface Preference {
  category: NotifyCategory
  channel: Channel | 'in_app'
  enabled: boolean
}

/** One row per (carrier, user, category). See notification_category_preferences. */
export interface CategoryPreference {
  category: NotifyCategory
  leadDays: number[]
  /** Stored, and still read by nothing: the job batches unconditionally. */
  digest: boolean
}

export interface Snooze {
  ruleCode: string
  /**
   * The rule engine's vocabulary — 'power_unit', not 'vehicle'.
   *
   * Required, because the column behind it is NOT NULL and because an optional
   * field here is how this ended up decorative the first time: the type was
   * stored, never compared, and therefore never noticed to be from the wrong
   * enum entirely.
   */
  subjectType: Subject
  subjectId: string | null
  /** Inclusive: nothing fires on or before this date. */
  until: Date
}

export interface Candidate {
  item: DeadlineItem
  channel: Channel
  leadDays: number
  dedupKey: string
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Which lead window has been reached, if any.
 *
 * Returns the MOST URGENT reached window rather than every reached one. If the
 * job does not run for a week, an item that blew through the 30-day and 7-day
 * marks sends ONE message about seven days, not two messages about both. Waking
 * somebody twice to tell them the same thing is how the mute happens.
 */
export function reachedWindow(daysUntil: number, leadDays: readonly number[]): number | null {
  const reached = leadDays.filter((d) => daysUntil <= d)
  if (reached.length === 0) return null
  return Math.min(...reached)
}

/**
 * Whether this exact item has been set aside until a date.
 *
 * The subject TYPE is part of the match, and it is worth saying why given that
 * rule code already implies it — every RuleDefinition declares exactly one
 * `subject`, so a row's type ought to be redundant.
 *
 * It is redundant when the row is right, which makes it a check on whether the
 * row is right. Before 0010 this column held `document_subject` values, so a
 * snooze on a tractor said 'vehicle' while the item it was meant to silence said
 * 'power_unit' — and the only reason nothing broke is that this function ignored
 * the column completely. Comparing it means a row from the wrong vocabulary, a
 * hand-written row, or a row left behind by a future schema change FAILS TO
 * SUPPRESS rather than suppressing something it was never about.
 *
 * That is the correct direction for the failure. A snooze that stops working
 * nags somebody about an item they had set aside; a snooze that matches too
 * widely silences a deadline nobody meant to silence, and that one costs a truck.
 */
export function isSnoozed(item: DeadlineItem, snoozes: readonly Snooze[], today: Date): boolean {
  return snoozes.some(
    (s) =>
      s.ruleCode === item.rule.code &&
      s.subjectType === item.subjectType &&
      (s.subjectId ?? null) === (item.subjectId ?? null) &&
      s.until >= today,
  )
}

/**
 * Turn a carrier's deadline list into the set of messages that should go out
 * today, for one recipient.
 *
 * `alreadySent` is the set of dedup keys already in notification_log. It is
 * passed in rather than queried here so this function stays pure and testable —
 * the decision of what to send is the part that must never be guessed at.
 */
export function selectForRecipient(args: {
  items: readonly DeadlineItem[]
  recipient: Recipient
  preferences: readonly Preference[]
  /** Lead times, per category. Absent for a category means the default. */
  categoryPreferences?: readonly CategoryPreference[]
  snoozes: readonly Snooze[]
  alreadySent: ReadonlySet<string>
  today: Date
}): Candidate[] {
  const { items, recipient, preferences, snoozes, alreadySent, today } = args
  const leadDaysByCategory = new Map(
    (args.categoryPreferences ?? []).map((c) => [c.category, c.leadDays]),
  )
  const out: Candidate[] = []

  for (const pref of preferences) {
    if (!pref.enabled) continue
    if (pref.channel === 'in_app') continue // delivered by being on the screen
    if (pref.category !== 'compliance') continue

    const destination = pref.channel === 'email' ? recipient.email : recipient.phone
    if (!destination) continue

    // A category with no row of its own gets the documented default rather than
    // nothing. An empty lead-day list means "warn me never", and arriving at
    // that by ACCIDENT — a row that has not been written yet — is how a deadline
    // goes past with the settings page still showing 30, 7, 1, -1.
    const leadDays = leadDaysByCategory.get(pref.category) ?? [...DEFAULT_LEAD_DAYS]

    for (const item of items) {
      // Nothing to warn about: we either cannot date it, or it does not apply.
      if (item.status.standing === 'not_applicable') continue
      if (item.status.standing === 'unsupported') continue

      // An item whose date we do not know cannot have a lead window — there is
      // nothing to count back from. It belongs in the digest's "we need a date"
      // summary, not in a dated alert, and sending a daily text saying "we still
      // do not know" would be the purest form of nagging.
      if (item.daysUntil === undefined || !item.status.nextDue) continue

      if (isSnoozed(item, snoozes, today)) continue

      const window = reachedWindow(item.daysUntil, leadDays)
      if (window === null) continue

      const key = dedupKey({
        userId: recipient.userId,
        ruleCode: item.rule.code,
        subjectId: item.subjectId,
        dueOn: iso(item.status.nextDue),
        leadDays: window,
        channel: pref.channel,
      })
      if (alreadySent.has(key)) continue

      out.push({ item, channel: pref.channel, leadDays: window, dedupKey: key })
    }
  }

  // Most urgent first, so a truncated SMS or a skimmed email still leads with
  // the thing that matters.
  return out.sort((a, b) => (a.item.daysUntil ?? 0) - (b.item.daysUntil ?? 0))
}

/**
 * Anything with a standing and a countdown: a regulatory deadline, or one of the
 * owner's own reminders.
 *
 * Widened from `DeadlineItem` when owner reminders arrived, so that "critical"
 * and the quiet-hours breakthrough have ONE definition covering both lists. The
 * alternative was a second copy in src/lib/reminders.ts, which is the shape of
 * drift this file's own comments warn about twice: the settings page promises
 * "anything already overdue, and anything due tomorrow", and two copies of that
 * sentence make it true of one list and a lie about the other.
 */
export interface TimedItem {
  status: { standing: Standing }
  daysUntil?: number
}

/**
 * SMS is rationed deliberately.
 *
 * Text is for things that are already costing money: overdue, or due within a
 * day. Everything else is email. A carrier who gets texted about a renewal due
 * in a month stops reading the texts, and the one about the truck that cannot
 * roll tomorrow arrives into that silence.
 */
export function deservesSms(item: TimedItem): boolean {
  if (item.status.standing === 'overdue') return true
  return (item.daysUntil ?? 999) <= 1
}

/**
 * The one definition of "critical", borrowed rather than re-stated.
 *
 * Quiet hours let critical messages through, and SMS is reserved for critical
 * messages. Those are the same judgement — already costing money, or about to by
 * tomorrow — and writing it out twice guarantees the two drift, at which point
 * the settings page's promise ("anything already overdue, and anything due
 * tomorrow") is true of one of them and a lie about the other.
 */
export const isCritical = deservesSms

/** Everything the quiet-hours decision needs, already resolved to numbers. */
export interface QuietHours {
  /** Minutes past midnight, on the recipient's own clock. Null = not set. */
  fromMinutes: number | null
  toMinutes: number | null
  /** Whether critical messages break through the window. */
  allowCritical: boolean
  /**
   * The recipient's current local time, in minutes past midnight. Null when we
   * could not work it out — see below; it means SEND, not hold.
   */
  nowLocalMinutes: number | null
}

/**
 * Split today's messages into the ones that go now and the ones that wait.
 *
 * HELD IS NOT SENT, and that distinction is the whole reason this returns two
 * lists instead of filtering one. `notification_log.dedup_key` is unique and the
 * job treats every key already in that table as handled, whatever the row's
 * status column says. So a held message that gets logged has burned its key and
 * will never arrive — not late, never. Held candidates must reach no writer at
 * all; the next run re-derives them from scratch.
 */
export function splitForQuietHours<T extends { item: TimedItem }>(
  candidates: readonly T[],
  quiet: QuietHours,
): { deliver: T[]; held: T[] } {
  const all = { deliver: [...candidates], held: [] as T[] }

  // We could not read the recipient's clock — an unresolvable zone string, most
  // likely. Send. A profile holding junk must not become a person who is never
  // told anything: a badly timed email is an annoyance, an unsent one is the
  // deadline we exist to prevent.
  if (quiet.nowLocalMinutes === null) return all

  if (!withinQuietHours(quiet.nowLocalMinutes, quiet.fromMinutes, quiet.toMinutes)) return all

  // Inside the window with the breakthrough turned off: everything waits,
  // including the overdue ones. That is the setting doing exactly what its
  // checkbox says, and the settings page spells out the consequence.
  if (!quiet.allowCritical) return { deliver: [], held: [...candidates] }

  const deliver: T[] = []
  const held: T[] = []
  for (const c of candidates) {
    // Per ITEM, not per message. One morning's email can carry a lapsed medical
    // card and a registration due in a month; the first is why the breakthrough
    // exists and the second is precisely what quiet hours are for.
    ;(isCritical(c.item) ? deliver : held).push(c)
  }
  return { deliver, held }
}
