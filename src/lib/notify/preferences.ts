/**
 * The settings screen's vocabulary, and the one piece of real logic on it.
 *
 * Lives here rather than in the page because a page cannot be imported by the
 * test runner, and `parseLeadDays` is the function that decides how often a
 * carrier hears from us. A silent mistake in it is either a deadline nobody was
 * warned about or a product that gets muted — both of which are the whole
 * business, so it gets tests.
 *
 * Nothing in this file talks to Postgres. `select.ts` reads the values it
 * produces; keeping the two apart is what stops the screen offering a setting
 * the engine has no idea about.
 */

// ---------------------------------------------------------------- lead times

/**
 * The array the database column already defaults to. Written out here so the
 * screen, the fallback in the digest job and the column default cannot drift:
 * 30 days out, a week, the day before, and once more the day AFTER it lapsed.
 */
export const DEFAULT_LEAD_DAYS: readonly number[] = [30, 7, 1, -1]

/**
 * Whether an array is still the shipped default — nobody has moved it.
 *
 * This is the whole precedence question between a rule's own warning window and
 * the owner's settings, and it has to be answered from the VALUE, because the
 * row's existence answers nothing. The alerts form upserts a lead-time row for
 * every category on every save, so a person who ticked an SMS box and pressed
 * save owns a row holding 30, 7, 1, -1 that he never typed. Reading that row as
 * a choice would freeze him on the flat ladder forever.
 *
 * Order-insensitive. `parseLeadDays` sorts largest-first and so does the column
 * default, but a row written by hand or by a future migration need not, and a
 * sort order is not a preference.
 *
 * An absent array is the same answer: somebody who has never opened the screen
 * has not chosen anything either.
 */
export function isDefaultLeadDays(days: readonly number[] | null | undefined): boolean {
  if (!days) return true
  if (days.length !== DEFAULT_LEAD_DAYS.length) return false
  const mine = [...days].sort((a, b) => a - b)
  const theirs = [...DEFAULT_LEAD_DAYS].sort((a, b) => a - b)
  return mine.every((v, i) => v === theirs[i])
}

/**
 * A warning further out than a year is not a warning.
 *
 * `reachedWindow` fires as soon as `daysUntil <= lead`, so a lead time longer
 * than the obligation's own cycle is permanently reached — an annual medical
 * card with a 400-day window alerts the morning it is renewed and every cycle
 * after. A fat-fingered "300" for "30" turns the whole fleet into one
 * everything-at-once email, which is indistinguishable from spam.
 */
export const MAX_LEAD_DAY = 365

/**
 * Ten separate warnings about one item is past the point of usefulness, and an
 * unbounded array is a paste of a whole spreadsheet column into an int[].
 * The cap keeps the MOST URGENT ten, because the windows worth losing are the
 * distant ones — dropping "-1" (tell me again after it lapsed) would throw away
 * the only warning that arrives while it is actually costing money.
 */
export const MAX_LEAD_WINDOWS = 10

/**
 * Turn what somebody typed into the array the engine reads.
 *
 * Defensive on purpose. This box is free text, it is filled in once and then
 * trusted for years, and every failure mode below has already been typed by a
 * real person into a real form:
 *
 *   "30, 7, 1, -1"     the happy path
 *   "30 days, 7 days"  units left in, because the label said days
 *   "30;7;1"           semicolons, from a spreadsheet
 *   "–1"               an en dash, pasted out of a document. THIS is the
 *                      dangerous one: a naive parse reads it as +1 and silently
 *                      converts "tell me the day after it lapsed" into "tell me
 *                      the day before it is due" — the opposite instruction,
 *                      with nothing on screen to show it happened.
 *   "1.5"              a decimal. Scanning the string for every run of digits
 *                      would read that as TWO windows, 1 and 5, inventing an
 *                      alert nobody asked for — so each comma-separated chunk
 *                      yields at most one number.
 *   ""                 an emptied box. Never saved as an empty array: `[]`
 *                      means "warn me never", which is a setting no one has
 *                      ever actually wanted and which fails silently forever.
 */
export function parseLeadDays(raw: unknown): number[] {
  const text = typeof raw === 'string' ? raw : ''

  // Every dash a word processor, a phone keyboard or a PDF might have
  // substituted for a hyphen-minus, flattened before anything looks for a sign.
  // (hyphen U+2010 .. horizontal bar U+2015, minus sign, small and fullwidth forms)
  const normalised = text.replace(/[‐-―−﹘﹣－]/g, '-')

  const out: number[] = []
  for (const chunk of normalised.split(/[,;|/\s]+/)) {
    if (!chunk) continue // a trailing comma or a double space, not a value
    const found = chunk.match(/-?\d+/)
    if (!found) continue // "days", "n/a", an emoji — junk, dropped rather than guessed at

    const parsed = Number(found[0])
    if (!Number.isFinite(parsed)) continue
    // Number('-0') is -0, which stringifies into the int[] literal as -0 and
    // reads as a different value from 0 to anything comparing them by string.
    const value = parsed === 0 ? 0 : parsed

    if (Math.abs(value) > MAX_LEAD_DAY) continue
    if (out.includes(value)) continue // "7, 7" is one window, not two identical messages

    out.push(value)
  }

  // Largest first, the order the column's own comment specifies, so a row read
  // straight out of the database reads the same way as one just saved.
  out.sort((a, b) => b - a)

  const capped = out.length > MAX_LEAD_WINDOWS ? out.slice(-MAX_LEAD_WINDOWS) : out

  // The fallback, not an empty array. See the doc comment above.
  return capped.length > 0 ? capped : [...DEFAULT_LEAD_DAYS]
}

/** Back into the box, in the shape the box asks for. */
export function formatLeadDays(days: readonly number[] | null | undefined): string {
  if (!days || days.length === 0) return formatLeadDays(DEFAULT_LEAD_DAYS)
  return days.join(', ')
}

const dayWord = (n: number) => (n === 1 ? '1 day' : `${n} days`)

function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * The same array, in a sentence.
 *
 * "[30, 7, 1, -1]" is not a thing an office manager can check for correctness,
 * and a negative number in a list of days is the single most confusing part of
 * this screen. Rendering the sentence back under the box is how she sees that
 * what she typed means what she meant, before she finds out by not being told.
 */
export function describeLeadDays(days: readonly number[]): string {
  const before = days.filter((d) => d > 0).sort((a, b) => b - a)
  const onTheDay = days.some((d) => d === 0)
  const after = days
    .filter((d) => d < 0)
    .map((d) => Math.abs(d))
    .sort((a, b) => a - b)

  const parts: string[] = []
  if (before.length > 0) parts.push(`${list(before.map(dayWord))} before it is due`)
  if (onTheDay) parts.push('on the day itself')
  if (after.length > 0) parts.push(`${list(after.map(dayWord))} after it has lapsed`)

  if (parts.length === 0) return 'never'
  return parts.join(', then ')
}

// ---------------------------------------------------------------- the matrix

export type NotifyCategory = 'compliance' | 'federal' | 'system' | 'reminder'
export type NotifyChannel = 'email' | 'sms' | 'in_app'

export interface CategoryMeta {
  value: NotifyCategory
  label: string
  blurb: string
  /** Whether anything is actually sent for this category today. */
  live: boolean
  /**
   * Whether the lead time is set on each item instead of once for the category.
   *
   * True for owner reminders only, and it is here rather than in the page so the
   * settings screen cannot show a box that nothing reads. Every deadline of a
   * regulatory kind wants the same warning — one array for all medical cards —
   * but owner reminders are not alike: an insurance renewal wants a month and
   * "call the broker back" wants a day, so the number lives on the reminder row
   * and the screen says where to change it.
   */
  perItemLeadDays?: boolean
}

/**
 * The enum values in 0008_notifications.sql and 0023_custom_reminders.sql, with
 * the words an owner would use for them and — deliberately — whether we actually
 * send them yet.
 *
 * `live: false` is not a stub to fill in later and forget. The digest job skips
 * every category it has no sender for, so a screen that presented all four
 * identically would be promising two kinds of alert that no code anywhere sends.
 */
export const NOTIFY_CATEGORIES: readonly CategoryMeta[] = [
  {
    value: 'compliance',
    label: 'Deadlines',
    blurb:
      'A medical card, an inspection, a registration — anything with a date that stops a truck when it passes.',
    live: true,
  },
  {
    value: 'federal',
    label: 'Changes to your federal record',
    blurb:
      'Your FMCSA record changing under you: an operating status, an address, a new out-of-service order.',
    live: false,
  },
  {
    value: 'system',
    label: 'When we could not check something',
    blurb:
      'A lookup that failed or a feed that went quiet. Us telling on ourselves, so silence never reads as "all clear".',
    live: false,
  },
  {
    /**
     * The only category added to this list with its sender already written.
     *
     * Kept apart from 'compliance' on purpose: a federal deadline missed costs a
     * truck, a reminder he typed is his own business, and he must be able to
     * stop hearing about his own list without silencing the warnings that keep
     * him legal. Folded into one category the only way to quieten one would be
     * to mute both — the muting failure this whole table exists to prevent.
     *
     * Plain words, and no metaphor: this row is read by owners who do not read
     * English as a first language, on the screen where they decide whether to
     * keep hearing from us at all.
     */
    value: 'reminder',
    label: 'My reminders',
    blurb: 'Reminders you write yourself: insurance, payments, appointments. These are not laws.',
    live: true,
    perItemLeadDays: true,
  },
]

export interface ChannelMeta {
  value: NotifyChannel
  label: string
  /** Whether a message on this channel can physically be delivered today. */
  live: boolean
  /** The plain-English caveat printed under the column head. Null when none. */
  note: string | null
}

/**
 * Three columns, and only one of them sends anything today.
 *
 * SMS is not a matter of flipping a flag: A2P 10DLC registration does not
 * exist for this brand yet, so a text handed to Twilio is rejected by the
 * carrier, not delivered. A ticked box that produced nothing would be worse
 * than no box at all — this product's entire claim is that when it tells you
 * something, it is true.
 *
 * `in_app` is skipped by `selectForRecipient` by design ("delivered by being on
 * the screen"): the dashboard already lists everything, whatever this says.
 */
export const NOTIFY_CHANNELS: readonly ChannelMeta[] = [
  { value: 'email', label: 'Email', live: true, note: null },
  { value: 'sms', label: 'Text message', live: false, note: 'not switched on yet' },
  { value: 'in_app', label: 'In the app', live: true, note: 'the dashboard list, always there' },
]

// ---------------------------------------------------------------- timezones

export interface TimezoneOption {
  value: string
  label: string
}

/**
 * A list, not a text box.
 *
 * `profiles.timezone` is what turns "7am" into 7am where the person actually
 * is. Typed free-hand it collects "PST", "Pacific" and "pst" for one zone, none
 * of which `Intl` can resolve — and an unresolvable zone does not raise here, it
 * quietly makes every "is this overdue yet" answer wrong by up to a day on a
 * screen whose entire job is dates.
 *
 * Short on purpose: these are the zones a carrier running out of California
 * plausibly sits in. The list grows when a customer is in a zone it lacks.
 */
export const TIMEZONES: readonly TimezoneOption[] = [
  { value: 'America/Los_Angeles', label: 'Pacific — Los Angeles' },
  { value: 'America/Phoenix', label: 'Arizona — Phoenix (no daylight saving)' },
  { value: 'America/Denver', label: 'Mountain — Denver' },
  { value: 'America/Chicago', label: 'Central — Chicago' },
  { value: 'America/New_York', label: 'Eastern — New York' },
  { value: 'America/Anchorage', label: 'Alaska — Anchorage' },
  { value: 'Pacific/Honolulu', label: 'Hawaii — Honolulu' },
]

/**
 * A stored zone we do not offer is kept rather than silently reset.
 *
 * Somebody's row can hold a zone this list has not got — seeded by hand, or
 * left behind when the list is trimmed. Rendering the select without it would
 * show the first option as selected, and the next save would write that, moving
 * their morning by three hours because they opened a page.
 */
export function timezoneOptions(current: string | null | undefined): TimezoneOption[] {
  const zone = (current ?? '').trim()
  if (!zone || TIMEZONES.some((t) => t.value === zone)) return [...TIMEZONES]
  return [{ value: zone, label: zone }, ...TIMEZONES]
}

/** Whether a posted zone is one we are prepared to store. */
export function isKnownTimezone(value: string, current: string | null | undefined): boolean {
  return timezoneOptions(current).some((t) => t.value === value)
}

// ---------------------------------------------------------------- quiet hours

/**
 * A `time` column comes back as 'HH:MM:SS'. An `<input type="time">` renders
 * that, but round-trips it as 'HH:MM' — so comparing the two to decide whether
 * anything changed reports a change on every save. Trimmed once, here.
 */
export function timeForInput(value: string | null | undefined): string {
  if (!value) return ''
  return value.slice(0, 5)
}
