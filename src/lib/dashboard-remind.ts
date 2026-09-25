/**
 * "Not now. Remind me in a week."
 *
 * THE STATE THIS FIXES. The "dates we are missing" screen offers two answers —
 * type it in, or ask the driver — and the honest third answer, which is most of
 * them, is "the paperwork is at home and I will do this on Monday". With
 * nothing for that, the card stays exactly as it is, the owner scrolls past it
 * every morning, and the list teaches him to ignore itself.
 *
 * So the card can write his own reminder, on the same list as everything else
 * he has told himself to do. The reminder is HIS row, not a rule: 0023 gives it
 * no citation and no regulation on purpose, and `REMINDER_ORIGIN_NOTE` says so
 * wherever the two lists are drawn together.
 *
 * WHY IT CARRIES THE DATE NAMES IN THE NOTE. A week later "Chase Marco" is not
 * a task — chase him for what? The missing dates are known now and may not be
 * then (he may have sent two of them), so the note says what was missing on the
 * day it was written, and the card the reminder points at is the live answer.
 */
import { MAX_NOTE, MAX_TITLE, toDateOnly } from './reminders.ts'

/**
 * The part of a subject this needs, and no more.
 *
 * Structural rather than a named import of `DateSubject`, because the caller is
 * now sometimes an `ActionSubject` (src/lib/dashboard-actions.ts) — a driver
 * whose card has EXPIRED can be reminded about, and he is not in the date
 * editor's index at all. Both shapes satisfy this; neither had to learn about
 * the other.
 */
export interface RemindableSubject {
  id: string
  label: string
  recordSubject: 'carrier' | 'driver' | 'vehicle' | null
  questionCount: number
  questions: readonly { label: string }[]
}

/** A week. Long enough to be a different day, short enough to still matter. */
export const REMIND_LATER_DAYS = 7

export interface ReminderFields {
  title: string
  note: string
  due_on: string
  repeat_months: number
  lead_days: number
  driver_id: string | null
  vehicle_id: string | null
}

/** Cut at a word if we can, and never mid-word with no ellipsis. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export function remindMeFields(subject: RemindableSubject, today: Date): ReminderFields {
  const n = subject.questionCount
  const dates = n === 1 ? 'date' : 'dates'

  const title =
    subject.recordSubject === 'driver'
      ? clamp(`Chase ${subject.label} for ${n} missing ${dates}`, MAX_TITLE)
      : subject.recordSubject === 'vehicle'
        ? clamp(`Get ${n} missing ${dates} for ${subject.label}`, MAX_TITLE)
        : clamp(`Find ${n} missing ${dates} for the company record`, MAX_TITLE)

  /**
   * Every question, not only the ones expected of everybody. A man reading
   * this next week wants the whole errand in front of him, and the disclosure
   * that hides the rare ones on screen is about not frightening him on a first
   * visit, which is not what a note he asked for is for.
   */
  const lines = subject.questions.map((q) => `· ${q.label}`)
  const note = clamp(
    [`Missing on ${toDateOnly(today)}:`, ...lines, '', 'Open the dashboard to type them in.'].join(
      '\n',
    ),
    MAX_NOTE,
  )

  const due = new Date(today.getTime())
  due.setUTCDate(due.getUTCDate() + REMIND_LATER_DAYS)

  return {
    title,
    note,
    due_on: toDateOnly(due),
    // Once. A repeating chase for a date he may type tomorrow is a reminder
    // that outlives its own reason and has to be hunted down and closed.
    repeat_months: 0,
    // The day itself, not a week before it. A seven-day lead on a seven-day
    // reminder alerts the moment it is written, which is the opposite of
    // "remind me later".
    lead_days: 0,
    driver_id: subject.recordSubject === 'driver' ? subject.id : null,
    vehicle_id: subject.recordSubject === 'vehicle' ? subject.id : null,
  }
}
