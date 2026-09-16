/**
 * Turning "the owner typed some dates" into the exact rows to write.
 *
 * This logic already existed, once, inside the `save_dates` handler on the
 * driver page. It is being lifted out because a second screen now collects the
 * same kind of date, and the part that is easy to get wrong is not the insert —
 * it is the supersede that has to happen first.
 *
 * WHY A CORRECTION NEEDS A SUPERSEDE. `current_compliance_anchors` picks the row
 * with the latest `occurred_on`, not the row typed most recently. So fixing a
 * fat-fingered 2027 down to 2026 inserts a perfectly good row that the view then
 * ignores: the screen still shows the wrong date, she types it again, and the
 * table fills with corrections that never take. Marking the visible row
 * superseded is what makes the correction land.
 *
 * A LATER date is left alone on purpose. That is this year's MVR or a new
 * medical card — a genuine new occurrence — and the old row is the evidence the
 * driver was qualified before it.
 *
 * Everything here is pure. The caller does the two writes.
 */
import type { Subject } from '../rules/types.ts'

/** What `compliance_records.subject_type` accepts. */
export type RecordSubject = 'carrier' | 'driver' | 'vehicle'

/**
 * The engine's subject vocabulary is finer than the table's.
 *
 * A tractor and a trailer are different subjects to the rules — they carry
 * different obligations — and the same row in `vehicles`. Returning `null` for
 * the two subjects with no table behind them is deliberate: `employee` and
 * `terminal` rules exist in the catalogue and nothing can be recorded against
 * them yet, and a silent coercion to 'carrier' would file one person's
 * harassment-training date against the whole company.
 */
export function recordSubjectFor(subject: Subject): RecordSubject | null {
  switch (subject) {
    case 'carrier':
      return 'carrier'
    case 'driver':
      return 'driver'
    case 'power_unit':
    case 'trailer':
      return 'vehicle'
    default:
      return null
  }
}

/**
 * The identity of one answerable question: this date, about this record.
 *
 * Keyed on all three parts because a single submit now spans subjects. Keyed on
 * anchor alone — which was enough when the form lived on one driver's page —
 * every truck in the fleet would share one slot, and the second truck's
 * inspection date would supersede the first's.
 */
export function anchorSlot(subject: RecordSubject, subjectId: string, anchorKey: string): string {
  return `${subject}:${subjectId}:${anchorKey}`
}

export interface CurrentAnchor {
  id: string
  /** 'YYYY-MM-DD'. Compared as a string, which is only safe because it is ISO. */
  occurred_on: string
}

export interface AnswerEntry {
  subject: RecordSubject
  subjectId: string
  anchorKey: string
  /**
   * 'YYYY-MM-DD', or empty/null for a box left blank.
   *
   * Blank is a first-class input, not a missing one: a form that renders every
   * question hands back mostly blanks on every submit, and treating one as
   * "delete this date" would make an accidental tab through an empty field
   * destroy the evidence a driver was qualified during the period it covered.
   * The planner skips them.
   */
  on: string | null
}

export interface AnchorWritePlan {
  /** Ids of visible rows to mark superseded, before the inserts. */
  supersede: string[]
  inserts: Record<string, unknown>[]
  /** Typed, but identical to what is already on file. Nothing to do. */
  unchanged: number
  /**
   * Two different dates typed for the same question in one submit.
   *
   * Reported rather than resolved. Picking one is picking at random — there is
   * no basis in the submission for preferring either — and picking silently
   * means the owner sees one of his two answers land and never learns the other
   * was discarded.
   */
  conflicts: string[]
}

/**
 * Plan the writes for a batch of typed dates.
 *
 * `current` holds what `current_compliance_anchors` shows right now, keyed by
 * `anchorSlot`. A slot missing from it is a first answer.
 */
export function planAnchorWrites(args: {
  entries: readonly AnswerEntry[]
  current: ReadonlyMap<string, CurrentAnchor>
  carrierId: string
  userId: string | null
  recordedAt: string
}): AnchorWritePlan {
  const { entries, current, carrierId, userId, recordedAt } = args

  const supersede: string[] = []
  const inserts: Record<string, unknown>[] = []
  const conflicts: string[] = []
  const seen = new Map<string, string>()
  let unchanged = 0

  for (const entry of entries) {
    // A blank never reaches here — see `readAnswers`. Defended anyway, because
    // an empty string would insert a row with no date rather than skipping.
    if (!entry.on) continue

    const slot = anchorSlot(entry.subject, entry.subjectId, entry.anchorKey)

    const already = seen.get(slot)
    if (already !== undefined) {
      if (already !== entry.on && !conflicts.includes(slot)) conflicts.push(slot)
      continue
    }
    seen.set(slot, entry.on)

    const existing = current.get(slot)
    if (existing?.occurred_on === entry.on) {
      unchanged++
      continue
    }

    if (existing && entry.on < existing.occurred_on) supersede.push(existing.id)

    inserts.push({
      // Supplied, never filtered on: RLS checks carrier_id but does not fill it
      // in, and a separate trigger refuses a subject_id belonging to another
      // carrier — so a tampered id fails at the database rather than on our
      // trust in the form.
      carrier_id: carrierId,
      subject_type: entry.subject,
      subject_id: entry.subjectId,
      anchor_key: entry.anchorKey,
      occurred_on: entry.on,
      recorded_by: userId,
      recorded_at: recordedAt,
    })
  }

  // A conflicted slot must not write EITHER date. Reaching this point with one
  // of them already planned would mean the first-typed answer wins by position
  // on the page, which is not a rule anybody could predict or check.
  if (conflicts.length > 0) {
    const bad = new Set(conflicts)
    return {
      supersede: [],
      inserts: [],
      unchanged: 0,
      conflicts: [...bad],
    }
  }

  return { supersede, inserts, unchanged, conflicts }
}

/**
 * Is this a date string we are willing to store?
 *
 * `<input type="date">` gives back 'YYYY-MM-DD' or an empty string, but the form
 * is a POST body and nothing stops a crafted one. A malformed value reaching
 * Postgres is a 500; a plausible-but-wrong one ('2026-02-31') is worse.
 */
export function isStorableDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1) return false
  // Round-tripping catches the impossible days that regex and range checks miss:
  // 31 February parses, and arrives as 3 March.
  const asDate = new Date(Date.UTC(y, m - 1, d))
  return (
    asDate.getUTCFullYear() === y && asDate.getUTCMonth() === m - 1 && asDate.getUTCDate() === d
  )
}
