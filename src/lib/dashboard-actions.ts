/**
 * WHO THE DASHBOARD CAN ACT ON, which is not the same as who is missing a date.
 *
 * THE DEFECT THIS EXISTS TO END. The card actions — text the driver, remind me,
 * he does not work here any more — were built on `buildDateEditor`, and that
 * index is `items.filter(i => i.status.standing === 'unknown')`. So the SERVER,
 * not the screen, believed "can be texted" meant "is missing a date". A driver
 * whose medical card EXPIRED EIGHT DAYS AGO was not in the index at all, and
 * every intent answered "that driver is not on this list any more".
 *
 * That is backwards. An expired card is a stronger reason to text a man than a
 * date nobody has ever known — it is the thing that stops him driving today.
 * The two non-conditional asks in the catalogue are the medical card and the
 * licence, which are exactly what `eligibility()` blocks on, so the ask list was
 * already built for the overdue case while the button was shipped on the
 * unknown one.
 *
 * So: one index over EVERY row the dashboard holds, whatever its standing, and
 * the intents resolve against this. `buildDateEditor` keeps its own narrower job
 * — it is a form for typing dates nobody knows, and an overdue row has a date.
 */
import { type RecordSubject, recordSubjectFor } from './anchors/plan.ts'
import { answerKeyFor } from './rules/answer.ts'
import type { DeadlineItem } from './rules/index.ts'
import type { Subject } from './rules/types.ts'

export interface ActionSubject {
  id: string
  type: Subject
  /** null for `employee` and `terminal`, which own no table. */
  recordSubject: RecordSubject | null
  label: string
  /**
   * Every anchor key this subject's rows hang on, deduped, in the order the
   * dashboard first showed them. This is what decides which of the six dated
   * papers the driver can be asked for.
   */
  answerKeys: string[]
  /**
   * The subset of `answerKeys` whose rows are OVERDUE or UNKNOWN — the things
   * actually worth asking him for today.
   *
   * Separate from `answerKeys` because a link should not ask a man to send a
   * licence that is on file and current. He would, the owner would review it,
   * and both would have spent the one message the driver reliably reads on
   * nothing.
   */
  needKeys: string[]
  /** What the rows ARE, in words, for a reminder note a week from now. */
  questions: { label: string }[]
  questionCount: number
  rowCount: number
}

/**
 * Every subject the dashboard has a row about.
 *
 * ORDER IS THE DASHBOARD'S OWN. `items` arrives sorted by how much the row
 * matters, so a subject's place here is the place of its worst row — which is
 * the order a bulk action should reach people in when it has a ceiling.
 *
 * A row with no `subjectId` — the carrier's own rows carry null — is filed
 * under `carrierId` so the carrier record can be acted on like anything else.
 */
export function buildActionIndex(
  items: readonly DeadlineItem[],
  carrierId: string,
): Map<string, ActionSubject> {
  const out = new Map<string, ActionSubject>()

  for (const i of items) {
    const id = i.subjectId ?? (i.subjectType === 'carrier' ? carrierId : null)
    if (!id) continue

    let subject = out.get(id)
    if (!subject) {
      subject = {
        id,
        type: i.subjectType,
        recordSubject: recordSubjectFor(i.subjectType),
        label: i.subjectLabel,
        answerKeys: [],
        needKeys: [],
        questions: [],
        questionCount: 0,
        rowCount: 0,
      }
      out.set(id, subject)
    }

    subject.rowCount += 1

    // One anchor answers several rules — a medical certificate expiry settles
    // the federal medical rule and its California twin — so the key list is a
    // set, and the words beside it are per QUESTION rather than per row.
    const key = answerKeyFor(i.rule)
    if (!subject.answerKeys.includes(key)) {
      subject.answerKeys.push(key)
      subject.questions.push({ label: i.rule.title })
      subject.questionCount += 1
    }
    const standing = i.status.standing
    if ((standing === 'overdue' || standing === 'unknown') && !subject.needKeys.includes(key)) {
      subject.needKeys.push(key)
    }
  }

  return out
}

/**
 * The drivers who cannot legally be dispatched today.
 *
 * Here rather than inline on the page because BOTH halves need it: the banner
 * that names them, and the POST handler that texts them. Two copies of "who is
 * blocked" is how a button comes to act on a different set of people than the
 * sentence above it names.
 *
 * `eligibility()` is the authority and is not re-implemented — it blocks on
 * overdue and warns on unknown, and the reason is written out in that file.
 */
export function blockedDriverIds(
  items: readonly DeadlineItem[],
  isBlockedFn: (arg: { items: DeadlineItem[]; label: string }) => boolean,
): string[] {
  const byDriver = new Map<string, { label: string; items: DeadlineItem[] }>()
  for (const i of items) {
    if (i.subjectType !== 'driver' || !i.subjectId) continue
    const row = byDriver.get(i.subjectId) ?? { label: i.subjectLabel, items: [] }
    row.items.push(i)
    byDriver.set(i.subjectId, row)
  }
  return [...byDriver.entries()].filter(([, d]) => isBlockedFn(d)).map(([id]) => id)
}
