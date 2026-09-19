/**
 * Deciding what to send. The hard part of an alerting product is not sending —
 * it is not sending.
 */
import type { Standing } from '../rules/compute.ts'
import type { DeadlineItem } from '../rules/index.ts'
import type { Subject } from '../rules/types.ts'
import { type Channel, dedupKey, withinQuietHours } from './guard.ts'
import {
  DEFAULT_LEAD_DAYS,
  isDefaultLeadDays,
  MAX_LEAD_DAY,
  type NotifyCategory,
} from './preferences.ts'

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
 *
 * BOTH SIDES OF ZERO ARE GUARDED, and that guard is the load-bearing part.
 *
 * A window before the due date and a nudge after it answer two different
 * questions — "this is coming" and "this has lapsed" — so a date already behind
 * us may only be measured against the negative windows, and a date still ahead
 * only against zero and the positive ones. Without that, `daysUntil <= d` is
 * true of every window in the list for anything overdue: a date five years past
 * reaches a 90-day window and comes back as a 90-day warning, and `deservesSms`
 * then reads the same item as critical and texts it through quiet hours. That is
 * the shape of the bug src/lib/rules/compute.ts fixed at the source, and this
 * filter is what stops a per-rule window list from re-opening it here. It only
 * ever survived before because every list happened to end in -1, so the minimum
 * came out negative anyway; a rule window list is not required to end in -1.
 *
 * `daysUntil` alone does not settle whether an item is OVERDUE — an interval
 * rule's next cycle is always ahead of it, so a carrier three cycles behind
 * still shows a positive countdown. Standing decides which ladder an item is
 * measured against (see `leadDaysForItem`); the number only decides which rung.
 */
export function reachedWindow(daysUntil: number, leadDays: readonly number[]): number | null {
  const sameSide = leadDays.filter((d) => (daysUntil < 0 ? d < 0 : d >= 0))
  const reached = sameSide.filter((d) => daysUntil <= d)
  if (reached.length === 0) return null
  return Math.min(...reached)
}

/**
 * The ladder ONE item is measured against.
 *
 * Every rule in the catalogue carries a `warningDays` array chosen for how long
 * its remedy actually takes: 90 days on a medical certificate because a DOT
 * physical is an appointment, 120 on hazmat training because a class has to be
 * scheduled, 60 on a CDL because the DMV books weeks out. Nothing read it, so a
 * medical card and a fee you can pay online were both first mentioned at 30
 * days. See docs/product/DATE-PRIORITY.md section 3.4.
 *
 * PRECEDENCE, in one sentence: a rule's window is a better DEFAULT, never an
 * override of a person's choice.
 *
 *   1. The owner typed his own lead times — his array, exactly, for every rule.
 *      He may have set them wider or narrower than the catalogue thinks wise and
 *      it is not this function's business to know better. `isDefaultLeadDays`
 *      answers "did a person move this" from the value, because the alerts form
 *      writes a row on every save whether or not the box was touched.
 *   2. He has not — the rule's own window joins the default he started from.
 *   3. The rule has nothing to say — the default, unchanged, exactly as before.
 *
 * ADDED TO, NOT SWAPPED FOR. A 90-day window that then goes quiet until the
 * deadline is worse than the flat 30, because the point of the long window is an
 * EARLIER warning and not a lonelier one: a card mentioned once in February and
 * never again before it expires in May is a card that expires. So the two lists
 * are merged, and the merged list is a superset of the one in use today — no
 * item can come out of this with fewer warnings than it gets now.
 *
 * ONLY WINDOWS ABOVE ZERO ARE TAKEN FROM THE RULE, and that is what keeps this
 * change out of the SMS ration. `deservesSms` texts what is overdue or due
 * within a day; the merged list therefore still contains 1 and -1 from the
 * default, so anything at 1, 0 or below still reports the same window it reports
 * today and produces exactly the same text messages. Every window this adds is
 * above 1, and a window above 1 is only ever returned for an item more than a
 * day out, which `deservesSms` refuses. Widening the email windows must not
 * quietly widen texting, so it does not.
 *
 * AN OVERDUE ITEM KEEPS THE FLAT LADDER. A rolling obligation that is overdue
 * carries a POSITIVE countdown to its next cycle, and it is already critical by
 * standing alone — so handing it the rule's 90 would make it a candidate, and
 * therefore a text message, three months before a date it has already missed.
 * Standing first, days second.
 */
export function leadDaysForItem(
  item: { rule: { warningDays?: readonly number[] }; status: { standing: Standing } },
  settingLeadDays: readonly number[],
): readonly number[] {
  if (!isDefaultLeadDays(settingLeadDays)) return settingLeadDays
  if (item.status.standing === 'overdue') return settingLeadDays

  // `MAX_LEAD_DAY` for the same reason `parseLeadDays` applies it to what a
  // person types: a window longer than the obligation's own cycle is reached
  // permanently, so an annual item with a 400-day window alerts the morning it
  // is renewed and every morning after. The widest window in the catalogue today
  // is 120.
  const earlier = (item.rule.warningDays ?? []).filter((d) => d > 0 && d <= MAX_LEAD_DAY)
  if (earlier.length === 0) return settingLeadDays

  const merged = new Set<number>(settingLeadDays)
  for (const d of earlier) merged.add(d)
  return [...merged].sort((a, b) => b - a)
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
  /**
   * Lead times, per category. Absent for a category means the default.
   *
   * An array that is still the shipped default is treated as nobody having
   * chosen, and each rule's own warning window is merged into it — see
   * `leadDaysForItem`. An array a person actually moved is used as it stands.
   */
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
    // that by ACCIDENT — a row that has not been written yet, or one holding the
    // empty array the settings screen refuses to save — is how a deadline goes
    // past with the settings page still showing 30, 7, 1, -1.
    const stored = leadDaysByCategory.get(pref.category)
    const leadDays = stored && stored.length > 0 ? stored : [...DEFAULT_LEAD_DAYS]

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

      // The rule's own window where the owner has not chosen one of his own.
      // See `leadDaysForItem` for the precedence and for why an overdue item is
      // measured against the flat ladder instead.
      const window = reachedWindow(item.daysUntil, leadDaysForItem(item, leadDays))
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
