/**
 * A date box on the deadline row itself.
 *
 * WHAT THIS IS FOR, in the owner's words: "on the row itself, it says
 * 'Commercial driver's licence' for example, and a date here will be nice to
 * update that." He is looking at an Overdue row for a driver whose CDL expired
 * in January, he has the new licence in his hand, and the only way to record it
 * was to leave the dashboard, find the driver, find the field, save, and come
 * back to see whether the row had gone. Four screens to type one date he was
 * already looking at the question for.
 *
 * So the row grows a box. The row already knows the rule and the record; those
 * two facts are the whole of what a date needs to be filed correctly, and this
 * module turns them into one.
 *
 * THE KEY IS DERIVED, NEVER POSTED. A form field carries the rule code and the
 * record id and nothing else. Which `compliance_records.anchor_key` a date is
 * filed under is decided HERE, from the rule, by `answerKeyFor` — the same
 * function `evaluate` reads the date back with. A posted key would let anyone
 * file any date under any anchor on any record they can see: a date typed under
 * `hire_date` outranks the driver's own column forever, and a date under
 * another rule's anchor moves deadlines nobody was editing. src/lib/rules/index.ts
 * says it plainly at the line that reads the value back — "a screen that wants
 * to write one of these dates has to make the same decision, and reading it
 * from the same function is what stops the two from drifting."
 *
 * TWO PLACES A DATE CAN GO, and the row cannot tell them apart. Fifty-one of the
 * fifty-two rules are answered by a compliance record. One is not: a CDL expiry
 * lives on `drivers.cdl_expires_on`, and a compliance record written under
 * `cdl_expires` would SILENTLY OUTRANK that column — the driver's own page would
 * go on showing the right date while five federal rules ran off the wrong one.
 * That is why `UNWRITABLE_ANCHOR_KEYS` exists. It is a rule about which table
 * the answer belongs in, not about whether the owner may answer, so the box is
 * offered either way and `target` says where it lands.
 */
import { type RecordSubject, recordSubjectFor } from './anchors/plan.ts'
import { type AnchorKind, resolveAnchor, UNWRITABLE_ANCHOR_KEYS } from './rules/anchors.ts'
import { answerKeyFor } from './rules/answer.ts'
import type { DeadlineItem } from './rules/index.ts'

/**
 * Where a typed date is written.
 *
 * A discriminated union rather than an optional column name, so the save
 * handler cannot reach the database without having said which of the two it is
 * doing.
 */
export type RowTarget =
  | { via: 'anchor'; subject: RecordSubject; subjectId: string; anchorKey: string }
  | { via: 'column'; table: 'drivers'; column: 'cdl_expires_on'; id: string }

/**
 * The one answer key whose home is a column on the record.
 *
 * Written out rather than parsed from `answeredElsewhere.source`, which is a
 * sentence for a reader and not an address. A key that is unwritable and absent
 * from this map gets NO box — `hire_date` and `dot_number` are both in that
 * position today, and both are answered by opening the record that owns them.
 * `tests/dashboard-rows.test.ts` pins the whole set, so a rule that arrives
 * later carrying an unwritable key fails a test instead of quietly losing its
 * box on the dashboard.
 */
const COLUMN_TARGETS: Readonly<Record<string, { table: 'drivers'; column: 'cdl_expires_on' }>> = {
  cdl_expires: { table: 'drivers', column: 'cdl_expires_on' },
}

export interface RowAnswer {
  /** The form field name. Unique per row: one rule, one record. */
  field: string
  /** What the box is asking for, in the registry's words. */
  label: string
  /**
   * Which way the date points, and therefore what the box may accept.
   *
   * `last_done` cannot be in the future — it is the day something happened.
   * `expires` can be, and usually is: a new medical card is the whole point of
   * typing in this box.
   */
  kind: AnchorKind
  target: RowTarget
}

/** What a field name is built from, and all a posted one is trusted for. */
const SEPARATOR = '~'
export const ROW_FIELD_PREFIX = `on${SEPARATOR}`

/**
 * The field name for one row.
 *
 * Rule codes carry dots and dashes and record ids are UUIDs, so `~` appears in
 * neither and the split back is unambiguous. It is only ever split into those
 * two halves — never into a key, a column or a table.
 */
export function rowField(ruleCode: string, subjectId: string): string {
  return `${ROW_FIELD_PREFIX}${ruleCode}${SEPARATOR}${subjectId}`
}

/**
 * The box for one dashboard row, or null when the row has no answerable date.
 *
 * Null is the honest answer in three cases, and none of them is an error:
 *   - the subject has no table behind it (`employee`, `terminal`), so nothing
 *     can be recorded against it yet;
 *   - the row is about the carrier and we have no carrier id to hand;
 *   - the key is unwritable and has no column of its own.
 * Every one of those rows keeps the link it already had.
 */
export function rowAnswer(
  item: DeadlineItem,
  carrierId: string | null | undefined,
): RowAnswer | null {
  // `status.answerKey` when the engine named one — an `unknown` row's key can
  // legitimately differ from the rule's own, and the engine is the only thing
  // that knows which of the two kinds of unknown this is. Otherwise the
  // completion goes where `evaluate` looks for it.
  const key = item.status.answerKey ?? answerKeyFor(item.rule)
  const entry = resolveAnchor(key)
  // A key with no entry is a question with no words. Unreachable while
  // tests/anchors-registry.test.ts passes, and skipped rather than rendered
  // raw: a box labelled `fed.396.21.inspection-report-retention.power-unit`
  // teaches the owner that this screen is not for him.
  if (!entry) return null

  const recordSubject = recordSubjectFor(item.subjectType)
  if (recordSubject === null) return null

  // A carrier row carries no subject id of its own — the carrier IS the
  // subject — so the id comes from the session. Anything else with no id is a
  // row about a record we cannot name, and a date has nowhere to go.
  const subjectId = item.subjectId ?? (recordSubject === 'carrier' ? (carrierId ?? null) : null)
  if (!subjectId) return null

  const field = rowField(item.rule.code, subjectId)
  const shared = { field, label: entry.label, kind: entry.kind }

  if (UNWRITABLE_ANCHOR_KEYS.has(key)) {
    const column = COLUMN_TARGETS[key]
    if (!column) return null
    // Only a driver row can reach a driver column. Belt and braces: the one key
    // in the map is a driver's, and a future entry pointing at the wrong table
    // would otherwise write a date onto a record of a different kind.
    if (recordSubject !== 'driver') return null
    return { ...shared, target: { via: 'column', ...column, id: subjectId } }
  }

  return {
    ...shared,
    target: { via: 'anchor', subject: recordSubject, subjectId, anchorKey: key },
  }
}

/**
 * Every answerable row on screen, by field name.
 *
 * REBUILT ON THE POST, not carried across in the body. The save handler reads
 * this map and looks up each posted field in it, so a field name that is not a
 * row currently on this dashboard is not rejected — it is never looked at,
 * which is the only version of that defence with no list to keep up to date.
 * Same doctrine as `readTypedDates` one module over.
 */
export function rowAnswers(
  items: readonly DeadlineItem[],
  carrierId: string | null | undefined,
): Map<string, RowAnswer> {
  const out = new Map<string, RowAnswer>()
  for (const item of items) {
    const answer = rowAnswer(item, carrierId)
    // First wins. Two rules on one record CAN share an anchor — a periodic
    // inspection settles two — and they are the same box with the same target,
    // so the second is a duplicate rather than a conflict.
    if (answer && !out.has(answer.field)) out.set(answer.field, answer)
  }
  return out
}

export interface TypedRowDate {
  answer: RowAnswer
  /** 'YYYY-MM-DD'. Blanks never reach here. */
  on: string
}

export type ReadRowResult = { ok: true; typed: TypedRowDate[] } | { ok: false; message: string }

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Read back the boxes that were typed in, and refuse the whole submit on a bad
 * one.
 *
 * All-or-nothing, for the reason the vehicle screen and the date editor are:
 * a partial save leaves a screen where some boxes took and some did not, with
 * one message to explain it.
 */
export function readRowDates(
  answers: ReadonlyMap<string, RowAnswer>,
  read: (field: string) => string | null | undefined,
  today: string,
): ReadRowResult {
  const typed: TypedRowDate[] = []

  for (const answer of answers.values()) {
    const raw = String(read(answer.field) ?? '').trim()
    // Blank is "not this one, not today". Every box on this surface starts
    // empty and most come back empty on every submit.
    if (raw === '') continue

    if (!DATE_SHAPE.test(raw)) {
      return { ok: false, message: `${answer.label}: pick the date from the calendar.` }
    }
    if (raw < '1900-01-01') {
      return { ok: false, message: `${answer.label}: that year looks like a typo.` }
    }
    // The `max` attribute is a browser's promise, not a server's. Re-checked
    // here against the same `kind` the attribute came from, so the one
    // direction this domain refuses to be wrong in does not depend on a
    // browser honouring an attribute.
    if (answer.kind === 'last_done' && raw > today) {
      return {
        ok: false,
        message:
          `${answer.label} is in the future. This box wants the last time it was done, ` +
          'not the next time it is due.',
      }
    }

    typed.push({ answer, on: raw })
  }

  return { ok: true, typed }
}

/** The `max` on a box: a thing that already happened cannot happen tomorrow. */
export function rowMax(answer: RowAnswer, today: string): string | undefined {
  return answer.kind === 'last_done' ? today : undefined
}

/**
 * What the box says above itself, in four words or fewer.
 *
 * Two different questions wear the same control, and an owner who reads the
 * wrong one types a date that is right for the other. `expires` wants the day
 * the new paper runs out; `last_done` wants the day the thing was done.
 */
export function rowPrompt(answer: RowAnswer): string {
  return answer.kind === 'expires' ? 'New expiry date' : 'Date it was done'
}
