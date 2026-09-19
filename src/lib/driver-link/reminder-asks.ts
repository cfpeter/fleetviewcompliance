/**
 * Asking a driver about the owner's OWN reminders.
 *
 * WHY THIS IS NOT A SEVENTH ENTRY IN `asks.ts`. That catalogue answers one
 * question — what is printed on a document the driver is holding — and every
 * entry in it maps to a federal anchor or a column on his row. A tire check
 * maps to nothing: no regulation asks for it, no rule counts it, and the words
 * are the owner's own. The two lists look alike on the screen and are different
 * kinds of thing underneath, which is exactly why they are stored in two
 * columns (0038) rather than one widened set.
 *
 * WHY A REMINDER AND NOT A FREE-TEXT BOX. The owner asked for "a reminder or
 * maybe a custom input or something". A reminder IS the custom input: he
 * already has a screen that makes one, it carries any title he likes, it scopes
 * to one driver or to every driver, and it has a due date and a repeat. A
 * second free-text question here would mean the same thing and be completable,
 * countable and reportable by nothing. A one-off errand is a reminder set to
 * "does not repeat".
 *
 * THE KEY IS `reminder:<uuid>` and it travels a long way: the checkbox the
 * owner ticks, the input name on the driver's phone, the jsonb key in
 * `driver_submissions.payload`, the narrowing in `driver_link_submit` (0039)
 * and the accept step. One spelling, in one place, because five spellings of
 * the same string is how an answer arrives and lands nowhere.
 */

export const REMINDER_ASK_PREFIX = 'reminder:'

/**
 * Six questions for the whole link, papers and reminders together.
 *
 * The same number as `driver_links_asks_something` in 0038, and it is not about
 * storage. It is how many boxes a man answers on a phone, in a yard, before he
 * sends half of them or none.
 */
export const MAX_QUESTIONS = 6

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What the page needs to draw one reminder question. */
export interface ReminderAsk {
  /** The payload key — `reminder:<uuid>`. */
  key: string
  id: string
  /** The owner's own words. The only free text the driver's page shows. */
  title: string
}

export const reminderAskKey = (id: string): string => `${REMINDER_ASK_PREFIX}${id}`

/**
 * The reminder id inside a key, or null.
 *
 * Never throws on a value out of a form, a URL or a jsonb column. The uuid
 * shape is checked here so a key like `reminder:../../etc` cannot reach a
 * query, even though every caller also goes through the database.
 */
export function reminderIdFromKey(raw: unknown): string | null {
  const key = String(raw ?? '')
  if (!key.startsWith(REMINDER_ASK_PREFIX)) return null
  const id = key.slice(REMINDER_ASK_PREFIX.length)
  return UUID.test(id) ? id : null
}

export const isReminderAskKey = (raw: unknown): boolean => reminderIdFromKey(raw) !== null

/**
 * The reminders a posted form picked.
 *
 * SHAPE AND NOTHING ELSE, deliberately. Whether an id is one the owner is
 * allowed to ask this driver about is decided by `driver_links_reminders_belong`
 * in 0038 — same carrier, still open, his or every driver's — and that check
 * runs inside the insert where it cannot be raced. Repeating it here out of a
 * list the page happened to load would be a second answer to the same question,
 * and the second answer is the one that goes stale.
 *
 * Duplicates are collapsed: the same question twice reads as a bug in the app,
 * and it would let one pick eat two of the six slots.
 */
export function readReminderIds(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const raw of values) {
    const id = String(raw ?? '').trim()
    if (UUID.test(id)) seen.add(id.toLowerCase())
  }
  return [...seen]
}

/** The questions to draw, built from what the anonymous view handed back. */
export function reminderAsks(rows: readonly { id: string; title: string }[]): ReminderAsk[] {
  return rows
    .filter((r) => UUID.test(String(r.id ?? '')))
    .map((r) => ({ key: reminderAskKey(String(r.id)), id: String(r.id), title: String(r.title ?? '') }))
    .filter((r) => r.title.trim() !== '')
}

/**
 * The words above a reminder's boxes, on the driver's phone.
 *
 * THE DATE IS THE DAY HE DID IT, never an expiry. A reminder is a job — check
 * the tires, change the oil — so there is no card with a date printed on it and
 * "expiry" would be a question about nothing. Asking for the day it was done is
 * also what makes the answer worth something to the owner: it is the date that
 * rolls the reminder to its next cycle.
 */
export const REMINDER_DATE_LABEL = 'Date you did it'
export const REMINDER_DATE_HINT = 'The day it was done. Leave it blank if you are only sending a photo.'
export const REMINDER_PHOTO_LABEL = 'Photo'
export const REMINDER_PHOTO_HINT = 'Not required. A photo is what the office files.'
