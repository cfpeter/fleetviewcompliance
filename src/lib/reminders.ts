/**
 * The owner's own reminders: the half of his week no regulation covers.
 *
 * Everything in src/lib/rules/ is somebody else's rule, computed from a schedule
 * and printed with a citation. Nothing here is. A reminder is a line the owner
 * typed — the insurance renewal, the truck payment, the appointment at the DMV —
 * and it carries no legal authority at all.
 *
 * That difference is the reason this file exists instead of a `custom` rule
 * inside the engine. A RuleDefinition has a `citation` and a `sourceUrl`, and a
 * synthetic rule would need something in those fields; whatever went in would be
 * a sentence this product cannot stand behind, sitting in the exact column an
 * owner reads to find out what the law says. So owner reminders are a separate
 * shape all the way through, and the dashboard prints the words "Your reminder"
 * where a regulation prints its citation.
 *
 * What IS shared: the `Status` vocabulary. A reminder is overdue or it is
 * current, on the same UTC-midnight day boundary as every other date in this
 * product, so `standingPill` and `dueLine` render it without a single new token.
 * Time is time whoever set the clock; only authority differs.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { type Channel, dedupKey } from './notify/guard.ts'
import { type Preference, reachedWindow } from './notify/select.ts'
import type { Status } from './rules/compute.ts'
import { addMonthsClamped, daysBetween, toUtcMidnight } from './rules/dates.ts'

// ---------------------------------------------------------------- the shapes

/** One row of `reminders`, exactly as Postgres hands it back. */
export interface ReminderRow {
  id: string
  title: string
  note: string | null
  /** 'YYYY-MM-DD'. A date column, never a timestamp — see the migration. */
  due_on: string
  repeat_months: number
  lead_days: number
  driver_id: string | null
  vehicle_id: string | null
  /** 'all_drivers' | 'all_vehicles', or NULL for the original three cases. */
  subject_scope: string | null
  completed_at: string | null
  last_done_on: string | null
}

/**
 * What the reminder is about.
 *
 * FIVE ANSWERS, not three. `carrier` is the whole company; `driver` and
 * `vehicle` name one record; `all_drivers` and `all_vehicles` are one reminder
 * that belongs to every one of them (0032). The last two carry no id — there is
 * no single record to open — and that is why `id` is nullable rather than the
 * kind being folded into it.
 */
export interface ReminderSubject {
  kind: 'carrier' | 'driver' | 'vehicle' | 'all_drivers' | 'all_vehicles'
  id: string | null
  label: string
  /** The record's own page, when there is one to open. */
  href: string | null
}

/** One reminder, dated and ranked, ready for a screen or an email. */
export interface ReminderItem {
  id: string
  title: string
  note: string | null
  dueOn: Date
  repeatMonths: number
  leadDays: number
  subject: ReminderSubject
  /** The same type the rule engine produces, so the same pill renders it. */
  status: Status
  /** Negative when overdue. Always present: a reminder cannot exist undated. */
  daysUntil: number
  lastDoneOn: Date | null
  completedAt: Date | null
}

// ---------------------------------------------------------------- repeating

/**
 * The repeat choices, as whole months.
 *
 * WHAT WAS DECIDED AND WHY. Repeating reminders are in v1, because leaving them
 * out makes the single most valuable case — the annual insurance renewal — a
 * chore the owner has to re-type every year, and the year he forgets to re-type
 * it is the year it lapses. What is NOT in v1 is a recurrence engine: no
 * "second Tuesday", no end date, no exceptions. The whole feature is one integer
 * and one advance rule (`nextCycle`), which is a dozen lines of pure, tested
 * arithmetic rather than a calendar library and a table of exceptions.
 *
 * Months, not days, because these are calendar facts. "Every year on the 15th"
 * stays on the 15th; 365 days drifts a day every leap year and eventually says
 * the 14th, which is the kind of quiet wrongness this product cannot afford.
 *
 * The labels are the words an owner says. No "annually", no "biannual" — that
 * word means both twice a year and every two years, and half the readers of this
 * screen do not read English as a first language.
 */
export const REPEAT_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'One time only' },
  { value: 1, label: 'Every month' },
  { value: 3, label: 'Every 3 months' },
  { value: 6, label: 'Every 6 months' },
  { value: 12, label: 'Every year' },
  // YEARS, added with 0033. The research behind the suggestion list turned up
  // several dates a small carrier actually keeps that no month-sized repeat can
  // express — a TWIC card and a hazmat background check both run five years, a
  // forklift re-evaluation three, an LLC's Statement of Information two. Each
  // of those used to ship as a reminder that fires once and never again, from a
  // product whose job is to tell him again.
  //
  // The words are "2 years", not "every 24 months". Nobody says 24 months.
  { value: 24, label: 'Every 2 years' },
  { value: 36, label: 'Every 3 years' },
  { value: 60, label: 'Every 5 years' },
]

export function isRepeatMonths(value: number): boolean {
  return REPEAT_OPTIONS.some((o) => o.value === value)
}

/** How a repeat reads in a sentence. '' for a one-time reminder. */
export function repeatLabel(months: number): string {
  if (months === 0) return ''
  return REPEAT_OPTIONS.find((o) => o.value === months)?.label ?? `Every ${months} months`
}

/**
 * Where a repeating reminder goes when Done is pressed.
 *
 * Steps a whole interval at a time from the date it was due, and keeps stepping
 * until it lands strictly after today. Two things that follow from that:
 *
 *   * A reminder done LATE does not schedule the next one from today. A yearly
 *     insurance renewal due 1 March and paid on 20 March is next due 1 March, not
 *     20 March — the renewal date belongs to the policy, not to when he got to it.
 *   * A reminder three cycles behind does not produce three reminders. It walks
 *     forward to the next real occurrence, the same way the rules engine walks an
 *     anniversary schedule past a carrier who is years behind.
 *
 * STRICTLY after today, not on or after: a monthly reminder due today and marked
 * done today must move to next month. Landing on today would leave it open, due
 * now, one press after he cleared it.
 *
 * The guard is the same shape as the engine's: a clamped interval always moves
 * forward, so this cannot spin, but a corrupted `repeat_months` of 0 reaching
 * here would — and a loop in a request handler is worse than a wrong date.
 */
export function nextCycle(dueOn: Date, repeatMonths: number, today: Date): Date {
  const from = toUtcMidnight(dueOn)
  if (repeatMonths <= 0) return from

  const day0 = toUtcMidnight(today)
  let on = addMonthsClamped(from, repeatMonths)
  let guard = 0
  while (on <= day0 && guard++ < 400) on = addMonthsClamped(on, repeatMonths)
  return on
}

// ---------------------------------------------------------------- the status

/**
 * Overdue, or current. There is no third answer.
 *
 * A regulation can be `unknown` — we know the schedule and not whether the last
 * cycle was done — and that is why `unknown` ranks with `overdue` on the
 * dashboard. A reminder has none of that ambiguity: the owner typed a date, so
 * the date is known, and either it has passed or it has not. Reusing the engine's
 * `Status` rather than inventing a parallel one is what lets `standingPill` and
 * `dueLine` render these rows with no new vocabulary at all.
 *
 * `lastDue` is set to the same date on an overdue reminder because `dueLine`
 * prints "was due {lastDue ?? nextDue}" — for a regulation those are two
 * different dates (the cycle missed, and the next one); for a reminder there is
 * only ever the one.
 */
export function reminderStatus(dueOn: Date, today: Date): Status {
  const due = toUtcMidnight(dueOn)
  const day0 = toUtcMidnight(today)
  if (due < day0) return { standing: 'overdue', nextDue: due, lastDue: due }
  return { standing: 'current', nextDue: due }
}

/** 'YYYY-MM-DD' from Postgres -> a UTC midnight Date. */
export function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null
  const [y, m, d] = value.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return null
  const parsed = new Date(Date.UTC(y, m - 1, d))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** A UTC midnight back into the 'YYYY-MM-DD' a date column and a date input want. */
export const toDateOnly = (d: Date): string => d.toISOString().slice(0, 10)

// ---------------------------------------------------------------- what to save

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * The longest a title may be, matching the check constraint in 0023.
 *
 * Short on purpose. This string is read on a phone, in a table, next to federal
 * deadlines; a paragraph typed into it wraps to six lines and pushes the actual
 * deadlines off the screen. The note field is where the detail goes.
 */
export const MAX_TITLE = 120
export const MAX_NOTE = 2000

/**
 * Every message in this file is short, plain and says what to do next.
 *
 * The people reading them run four-truck fleets in Los Angeles and many do not
 * read English fluently. "Please provide a valid value for this field" is a
 * sentence that teaches nothing; "Write what you need to do." is an instruction.
 */
export function parseTitle(raw: unknown): Parsed<string> {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { ok: false, message: 'Write what you need to do.' }
  if (text.length > MAX_TITLE) {
    return {
      ok: false,
      message: `Keep it under ${MAX_TITLE} letters. Put the details in the note.`,
    }
  }
  return { ok: true, value: text }
}

export function parseNote(raw: unknown): Parsed<string | null> {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { ok: true, value: null }
  if (text.length > MAX_NOTE) return { ok: false, message: 'The note is too long.' }
  return { ok: true, value: text }
}

/**
 * The due date.
 *
 * A past date is ACCEPTED, and that is not an oversight. "I should have paid
 * this last week" is a real thing to write down, and refusing it would send the
 * owner away to fix a date that is already correct. It shows up overdue, in red,
 * which is exactly what he meant.
 *
 * What is refused is something that is not a date at all. An `<input type=date>`
 * cannot produce one; a crafted POST can, and Postgres would answer it with
 * "invalid input syntax for type date" across the top of his screen.
 */
export function parseDueOn(raw: unknown): Parsed<string> {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { ok: false, message: 'Pick a date.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { ok: false, message: 'Pick a date.' }

  const parsed = parseDateOnly(text)
  // Catches 2026-02-31 and 2026-13-01, which match the pattern and are not days.
  if (!parsed || toDateOnly(parsed) !== text) return { ok: false, message: 'Pick a date.' }
  // A date four digits wrong in the year is a reminder that never fires again.
  const year = parsed.getUTCFullYear()
  if (year < 2000 || year > 2100) return { ok: false, message: 'Check the year.' }
  return { ok: true, value: text }
}

/**
 * How many days before the date to start warning.
 *
 * One number, not the comma-separated list the settings page takes for
 * categories — because this box sits on a form an owner fills in while thinking
 * about one thing, and "30, 7, 1, -1" is the single most confusing control on
 * the settings screen. Blank means the default.
 */
export const DEFAULT_REMINDER_LEAD_DAYS = 7
export const MAX_REMINDER_LEAD_DAYS = 365

export function parseReminderLeadDays(raw: unknown): Parsed<number> {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { ok: true, value: DEFAULT_REMINDER_LEAD_DAYS }

  // Digits only. A negative here would mean "warn me after it is late", which
  // this product does anyway (see `reminderWindows`) and which nobody would
  // think to type — so a minus sign is a typo, not an instruction.
  if (!/^\d{1,3}$/.test(text)) {
    return { ok: false, message: 'Days must be a number, 0 to 365.' }
  }
  const days = Number(text)
  if (days > MAX_REMINDER_LEAD_DAYS) {
    return { ok: false, message: 'Days must be a number, 0 to 365.' }
  }
  return { ok: true, value: days }
}

// ---------------------------------------------------------------- rendering

/**
 * The badge that goes where a citation would go.
 *
 * THE WHOLE POINT OF THIS CONSTANT. On the dashboard a regulation's last column
 * is a link reading "49 CFR 391.45" — a law, with the text one tap away. A
 * reminder has nothing to put there, and an empty cell would read as a rule
 * whose citation we failed to load. So it prints this instead, in the tone the
 * app already uses for "this one is yours to judge, we are not computing it for
 * you" (the `unsupported` pill, and the "You have to check these yourself"
 * block). No new colour, no new word.
 *
 * It is deliberately NOT a link. Nothing to look up is the fact being conveyed.
 */
export const REMINDER_ORIGIN = {
  label: 'Your reminder',
  className: 'bg-champagne text-brand-700',
} as const

/** The one sentence that says what the badge means, wherever the rows appear. */
export const REMINDER_ORIGIN_NOTE = 'Rows marked "Your reminder" are yours. They are not a law.'

/** What a reminder with no driver and no truck is about. */
export const WHOLE_COMPANY = 'Whole company'
/** The two fleet-wide scopes, in the words the dropdown uses. One place. */
export const ALL_DRIVERS = 'All drivers'
export const ALL_TRUCKS = 'All trucks'

// ---------------------------------------------------------------- the digest

/**
 * The lead windows for one reminder.
 *
 * His number, then the day itself, then one day late. The last two are not
 * settings: a reminder that warned him a month ago and then went silent on the
 * day it was due would be worse than no reminder at all, and the nudge after it
 * lapses is the only warning that arrives while the thing is actually costing
 * money — the same reasoning as the `-1` in DEFAULT_LEAD_DAYS.
 *
 * Deduped, largest first, which is the order `reachedWindow` expects and the
 * order the stored array in notification_category_preferences is kept in.
 */
export function reminderWindows(leadDays: number): number[] {
  const windows = new Set<number>([leadDays, 0, -1])
  return [...windows].sort((a, b) => b - a)
}

/** One message we are about to send about one reminder. */
export interface ReminderCandidate {
  item: ReminderItem
  channel: Channel
  leadDays: number
  dedupKey: string
}

export const REMINDER_CATEGORY = 'reminder'

/**
 * Whether this recipient wants reminders by email.
 *
 * A MISSING ROW MEANS YES, and that is the load-bearing line in this function.
 * Every carrier already using the product has preference rows for the three
 * categories that existed before this feature and none for this one. Reading
 * "no row" as "off" would mean the feature ships switched off for every existing
 * customer, silently, with the settings page showing a ticked box — the exact
 * shape of failure the digest's own comments call out for lead days. A category
 * nobody has ever been shown cannot have been turned off.
 *
 * SMS is not offered at all, and not because the wire is down (it is: see
 * NOTIFY_CHANNELS). Text is rationed to things that stop a truck tomorrow. A
 * reminder to call the broker is not that, and a product that texts about a
 * private to-do list is a product that gets muted before the medical card
 * expires.
 */
export function reminderEmailEnabled(preferences: readonly Preference[]): boolean {
  const mine = preferences.filter((p) => p.category === REMINDER_CATEGORY)
  if (mine.length === 0) return true
  return mine.some((p) => p.channel === 'email' && p.enabled)
}

/**
 * Which reminders should be emailed to this person today.
 *
 * Deliberately the same shape as `selectForRecipient` in notify/select.ts — same
 * inputs, same dedup discipline, same "most urgent reached window only" rule —
 * so the digest treats the two lists identically once they are built. Pure, and
 * `alreadySent` is passed in rather than queried, because what to send is the
 * decision that must never be guessed at.
 */
export function selectReminders(args: {
  items: readonly ReminderItem[]
  recipient: { userId: string; email?: string }
  preferences: readonly Preference[]
  alreadySent: ReadonlySet<string>
}): ReminderCandidate[] {
  const { items, recipient, preferences, alreadySent } = args
  if (!recipient.email) return []
  if (!reminderEmailEnabled(preferences)) return []

  const out: ReminderCandidate[] = []

  for (const item of items) {
    // Closed reminders are not loaded at all, but a caller that passes one must
    // not be told it is due. Belt and braces on the one rule that would nag
    // somebody about a job they finished.
    if (item.completedAt) continue

    // `reachedWindow`, not a second copy of it. It returns the MOST URGENT
    // window reached, so a job that has not run for a week sends ONE message
    // about a reminder that blew through two marks rather than two messages
    // about the same line — and a change to that judgement must not apply to
    // deadlines while quietly missing reminders.
    const window = reachedWindow(item.daysUntil, reminderWindows(item.leadDays))
    if (window === null) continue

    const key = dedupKey({
      userId: recipient.userId,
      // The reminder's own id goes in the SUBJECT slot, so the rule slot can say
      // plainly what kind of thing this is. The due date is in the key too, which
      // is what makes next year's cycle of a repeating reminder a new message
      // rather than one already sent.
      ruleCode: REMINDER_CATEGORY,
      subjectId: item.id,
      dueOn: toDateOnly(item.dueOn),
      leadDays: window,
      channel: 'email',
    })
    if (alreadySent.has(key)) continue

    out.push({ item, channel: 'email', leadDays: window, dedupKey: key })
  }

  return out.sort((a, b) => a.item.daysUntil - b.item.daysUntil)
}

/**
 * One reminder, broken into the four pieces the morning email prints.
 *
 * ONE SOURCE FOR BOTH PARTS OF THE EMAIL. The plain-text line below and the
 * HTML row in src/lib/notify/digest-email.ts are built from this same object,
 * so the two halves of one message cannot drift into saying different things
 * about the same reminder — which is the failure a reader on a text-only client
 * would never be able to see.
 */
export interface ReminderEmailParts {
  title: string
  /** The driver or the truck. Empty when the reminder is the whole company's. */
  about: string
  when: string
  /** What goes in the slot where a regulation prints its citation. */
  foot: string
}

export function reminderEmailParts(item: ReminderItem): ReminderEmailParts {
  return {
    title: item.title,
    about: item.subject.kind === 'carrier' ? '' : item.subject.label,
    when:
      item.status.standing === 'overdue'
        ? `LATE since ${toDateOnly(item.dueOn)}`
        : `due ${toDateOnly(item.dueOn)} (${item.daysUntil} days)`,
    // Saying what this is — in the same slot, every time — is what stops an
    // owner reading his own note as something the government sent him.
    foot: 'Your reminder, not a rule.',
  }
}

/** One reminder as a line in the morning email. */
export function reminderEmailLine(item: ReminderItem): string {
  const parts = reminderEmailParts(item)
  const about = parts.about ? ` — ${parts.about}` : ''
  return `• ${parts.title}${about} — ${parts.when}\n  ${parts.foot}`
}

// ---------------------------------------------------------------- loading

/**
 * Written out rather than `select('*')`, for the reason the stops page gives: a
 * star types every column as `any`, so a column renamed in a migration renders
 * as a blank cell rather than failing. One line, because supabase-js reads this
 * literal to type the row it hands back and a concatenated string is just
 * `string` to the compiler.
 */
const REMINDER_COLUMNS =
  'id, title, note, due_on, repeat_months, lead_days, driver_id, vehicle_id, subject_scope, completed_at, last_done_on'

/** The same columns plus the labels for whatever the reminder is about. */
const REMINDER_COLUMNS_WITH_SUBJECT = `${REMINDER_COLUMNS}, drivers(first_name, last_name), vehicles(unit_number, vin)`

interface EmbeddedDriver {
  first_name: string
  last_name: string
}
interface EmbeddedVehicle {
  unit_number: string | null
  vin: string | null
}

/** PostgREST returns a many-to-one embed as an object on some versions and a
 *  one-element array on others. Accepting both is cheaper than being broken by
 *  an upgrade — the same defence digest.ts applies to `profiles`. */
function one<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined)
}

export function subjectOf(
  row: ReminderRow & { drivers?: EmbeddedDriver | EmbeddedDriver[] | null } & {
    vehicles?: EmbeddedVehicle | EmbeddedVehicle[] | null
  },
): ReminderSubject {
  if (row.driver_id) {
    const d = one(row.drivers)
    return {
      kind: 'driver',
      id: row.driver_id,
      // A driver whose name did not come back is still a driver. "Driver" beats
      // an empty cell, which reads as a bug rather than as a missing join.
      label: d ? `${d.first_name} ${d.last_name}`.trim() || 'Driver' : 'Driver',
      href: `/app/drivers/${row.driver_id}`,
    }
  }
  if (row.vehicle_id) {
    const v = one(row.vehicles)
    return {
      kind: 'vehicle',
      id: row.vehicle_id,
      label: v?.unit_number || v?.vin || 'Truck',
      href: `/app/vehicles/${row.vehicle_id}`,
    }
  }
  // The fleet-wide scopes, before the whole-company fallback: a scoped row has
  // no driver_id and no vehicle_id either, so reading them in the other order
  // would label every "All drivers" reminder as the company's.
  if (row.subject_scope === 'all_drivers') {
    return { kind: 'all_drivers', id: null, label: ALL_DRIVERS, href: '/app/drivers' }
  }
  if (row.subject_scope === 'all_vehicles') {
    return { kind: 'all_vehicles', id: null, label: ALL_TRUCKS, href: '/app/vehicles' }
  }
  return { kind: 'carrier', id: null, label: WHOLE_COMPANY, href: null }
}

/** One database row, dated against today. */
export function toReminderItem(
  row: ReminderRow & {
    drivers?: EmbeddedDriver | EmbeddedDriver[] | null
    vehicles?: EmbeddedVehicle | EmbeddedVehicle[] | null
  },
  today: Date,
): ReminderItem | null {
  const dueOn = parseDateOnly(row.due_on)
  // A row with no readable date cannot be ranked, and putting it on the
  // dashboard undated would give it the one standing this list does not have.
  // Dropped rather than guessed at; the constraint makes it unreachable anyway.
  if (!dueOn) return null

  const day0 = toUtcMidnight(today)
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    dueOn,
    repeatMonths: row.repeat_months,
    leadDays: row.lead_days,
    subject: subjectOf(row),
    status: reminderStatus(dueOn, day0),
    daysUntil: daysBetween(day0, dueOn),
    lastDoneOn: parseDateOnly(row.last_done_on),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
  }
}

/** Soonest first, and a late one before a due one — the same order the engine
 *  sorts deadlines in, so the two lists interleave sensibly on one screen. */
export function compareReminders(a: ReminderItem, b: ReminderItem): number {
  if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil
  return a.title.localeCompare(b.title)
}

/**
 * Every open reminder for a carrier, dated.
 *
 * No `.eq('carrier_id', …)`: RLS scopes this to the caller's carrier, and
 * repeating the filter would say in code that we do not quite trust the policy.
 * The digest calls this with the service key, which has no RLS, so it passes the
 * carrier explicitly — hence the parameter being used in exactly one place.
 */
export interface ReminderScope {
  kind: 'driver' | 'vehicle'
  id: string
}

/**
 * The subject filter is built as a PostgREST `or(...)` STRING, and a string
 * filter is a place a value can break out of.
 *
 * `,` separates the two conditions and `.` separates column from operator, so
 * an id carrying either would not error — it would quietly become a different
 * query, and a query on this table returns another carrier's reminders. RLS
 * still stands behind it, which is why this is a second lock rather than the
 * only one; but a filter built by hand has to check its own inputs.
 *
 * Fails CLOSED: an id that is not a uuid selects nothing. Every caller passes a
 * route parameter, and a route parameter that is not a uuid is not a record.
 */
const SUBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function loadReminders(
  supabase: SupabaseClient,
  carrierId: string | null,
  today = new Date(),
  /**
   * One record's reminders instead of the whole carrier's.
   *
   * The truck and driver pages ask for this. It is a FILTER and never a second
   * meaning of the function: the whole-company reminders (both ids null) are
   * deliberately left out of a record's list, because a reminder about the
   * company is not a fact about this truck, and printing it on every truck page
   * would be the same note repeated across the yard.
   */
  scope?: ReminderScope,
): Promise<ReminderItem[]> {
  // Before any query is built, and before any string is interpolated.
  if (scope && !SUBJECT_ID.test(scope.id)) return []

  const build = (columns: string) => {
    let query = supabase.from('reminders').select(columns).is('completed_at', null)
    if (carrierId) query = query.eq('carrier_id', carrierId)
    if (scope) {
      const idColumn = scope.kind === 'driver' ? 'driver_id' : 'vehicle_id'
      const fleetWide = scope.kind === 'driver' ? 'all_drivers' : 'all_vehicles'
      // THIS RECORD, PLUS THE ONES THAT BELONG TO EVERY RECORD OF ITS KIND.
      //
      // "Safety meeting · All drivers" is a reminder about this driver as much
      // as one naming him, and the whole point of the scope (0032) — in the
      // owner's words, "when the user chooses all drivers we show it to all
      // drivers". Filtering on the id alone would store it and then show it
      // nowhere but the reminders page.
      //
      // Whole-company reminders still stay off a record's page: one is not a
      // fact about this truck, and it would read identically on every one.
      query = query.or(`${idColumn}.eq.${scope.id},subject_scope.eq.${fleetWide}`)
    }
    return query
  }

  let result = await build(REMINDER_COLUMNS_WITH_SUBJECT)
  if (result.error) {
    // Embedded relations are a PostgREST feature a project can have switched
    // off. Losing the driver's NAME is a shrug; losing his reminders because of
    // a decorative join is not, so the fallback re-asks without them and the
    // labels fall back to "Driver" and "Truck".
    result = await build(REMINDER_COLUMNS)
  }
  if (result.error) return []

  const rows = (result.data ?? []) as unknown as ReminderRow[]
  const items: ReminderItem[] = []
  for (const row of rows) {
    const item = toReminderItem(row, today)
    if (item) items.push(item)
  }
  return items.sort(compareReminders)
}
