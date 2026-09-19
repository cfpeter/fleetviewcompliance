/**
 * One registry for every date the engine can ask the owner for.
 *
 * `Status.answerKey` (./compute.ts) names the `compliance_records.anchor_key` a
 * typed date must be filed under, and it can be ANY of three things: a driver
 * anchor, a vehicle anchor, a carrier anchor, or — when the schedule is known
 * and only the last completion is not — a rule code. A screen that renders those
 * rows needs four more facts about each one: what to call it, what sentence goes
 * under the box, which way the date points, and whether it may be typed at all.
 *
 * None of that existed in one place. `DRIVER_ANCHORS` covers twelve driver keys,
 * `VEHICLE_ANCHORS` six vehicle ones with no direction on them at all, and there
 * was no carrier catalogue whatsoever — thirteen carrier questions with no label
 * anywhere in the codebase. A key with no entry does not throw: it renders as a
 * date box with no question above it, or silently disappears from a list whose
 * whole promise is that it gets shorter.
 *
 * DELIBERATELY IMPORTS NEITHER EXISTING CATALOGUE. The driver and vehicle
 * entries below are restatements, not re-exports, because the re-wiring — making
 * `DRIVER_ANCHORS` and `VEHICLE_ANCHORS` derive from here — is a separate change
 * by somebody else. Until it lands, tests/anchors-registry.test.ts compares the
 * two copies field by field, so the restatement cannot drift from the original.
 * The wording in those entries was argued over once already; every sentence is
 * reproduced verbatim rather than improved.
 */
import { ruleByCode } from './index.ts'

/**
 * Which way the date points, which decides the `min`/`max` on the input and is
 * not a formatting detail.
 *
 * `last_done` names an event that has ALREADY happened. compute.ts walks a
 * rolling or anniversary schedule forward from the anchor until it passes today,
 * so a FUTURE date makes it step straight past the occurrence the owner just
 * reported and answer with the one after: the deadline moves LATER, the single
 * direction this domain refuses to be wrong in.
 *
 * `expires` is the opposite — the anchor IS the due date, read off the face of a
 * document, and it is supposed to be ahead of us. It takes no lower bound at
 * today either: a medical card that lapsed last month is a real and urgent fact,
 * and refusing to record it would make the most enforcement-visible document in
 * the industry un-typeable at the moment it matters most.
 *
 * Read from HERE and never derived from `rule.recurrence.type`. A `computed`
 * rule that reads an `expires` anchor — `once_on_spe_certificate_expiry` is one —
 * would be stamped `max={today}` by that derivation, making a future SPE expiry
 * impossible to type.
 */
export type AnchorKind = 'last_done' | 'expires'

/**
 * Whether a normal carrier is expected to have this date.
 *
 * A UI hint about NOISE, not a statement of law. Real applicability lives on the
 * rule rows in `applies`, where it is three-valued, cites a regulation and can be
 * audited. Here it only decides whether a blank counts toward "dates not
 * recorded yet" — because a list of outstanding items containing rows that
 * structurally cannot clear teaches the owner to stop believing the count.
 */
export type AnchorExpectation = 'always' | 'only_if_it_applies'

/**
 * Where the real answer lives, for a key that must never become a date input.
 *
 * Carried as data rather than left to the page, because the page that renders
 * the row is the one place with no way to know. See `UNWRITABLE_ANCHOR_KEYS`.
 */
export interface AnswerLivesElsewhere {
  /** In the owner's words, for the link text. */
  where: string
  /** The column or context field that actually feeds the engine. */
  source: string
  /** Path to link to. `:id` stands for the subject's id. */
  href: string
}

export interface AnchorEntry {
  /** Written verbatim into `compliance_records.anchor_key`. Never edit casually. */
  key: string
  label: string
  /** One sentence under the input, in the owner's language, not the CFR's. */
  help: string
  kind: AnchorKind
  expected: AnchorExpectation
  /** False when a date typed under this key would do damage or nothing. */
  writable: boolean
  /** Present exactly when `writable` is false. */
  answeredElsewhere?: AnswerLivesElsewhere
}

/** The hand-written half of an entry; `writable` is derived, never typed. */
type AnchorSpec = Omit<AnchorEntry, 'writable'>

const SPECS: readonly AnchorSpec[] = [
  // -------------------------------------------------------------------------
  // Driver — restated from src/lib/rules/driver-anchors.ts, word for word.
  //
  // The reasoning behind each sentence is in the comments beside the original.
  // Two that are worth knowing here because they look like mistakes otherwise:
  // the medical card says "the date printed on the card" because short cards are
  // routine and assuming 24 months is up to 21 months too generous; and the
  // Clearinghouse says there is no 31 January deadline because that deadline is
  // in trade press, competitor marketing and half the checklist PDFs online, and
  // does not exist.
  // -------------------------------------------------------------------------
  {
    key: 'medical_certificate_expires',
    label: 'Medical certificate expires',
    help: 'The date printed on the card — not 24 months from the exam. Short cards are normal.',
    kind: 'expires',
    expected: 'always',
  },
  {
    key: 'medical_exam_date',
    label: 'Date of the DOT physical',
    help: 'The day the examination happened. Only used for drivers on a 12-month certificate.',
    kind: 'last_done',
    expected: 'only_if_it_applies',
  },
  {
    key: 'annual_mvr_last_obtained',
    label: 'Driving record (MVR) last obtained',
    help: 'The day the record came back, from every state that licensed him in the last 3 years.',
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'annual_review_last_completed',
    label: 'Annual review of the record last signed',
    help: 'A different piece of paper from the MVR: the dated note naming who read it.',
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'clearinghouse_query_last_run',
    label: 'Clearinghouse query last run',
    help: 'Rolling 12 months from this driver’s last query. There is no 31 January deadline.',
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'return_to_duty_test_date',
    label: 'Return-to-duty test date',
    help: 'Only for a driver who has been through a SAP. Leave blank otherwise.',
    kind: 'last_done',
    expected: 'only_if_it_applies',
  },
  {
    key: 'intracity_zone_exemption_issued',
    label: 'Intracity zone exemption issued',
    help: 'Leave blank unless he holds one. A date here means his card runs 12 months, not 24.',
    kind: 'last_done',
    expected: 'only_if_it_applies',
  },
  {
    key: 'insulin_treated_diabetes_assessment',
    label: 'Insulin-treated diabetes assessment (MCSA-5870)',
    help: 'Leave blank unless he is insulin-treated. Dated within 45 days before the exam.',
    kind: 'last_done',
    expected: 'only_if_it_applies',
  },
  {
    key: 'alternative_vision_evaluation',
    label: 'Alternative vision evaluation (MCSA-5871)',
    help: 'Leave blank unless he is certified under the alternative vision standard.',
    kind: 'last_done',
    expected: 'only_if_it_applies',
  },
  {
    key: 'spe_certificate_expiry',
    label: 'Skill Performance Evaluation certificate expires',
    help: 'Leave blank unless he holds an SPE. The certificate states its own term — read it off.',
    kind: 'expires',
    expected: 'only_if_it_applies',
  },
  {
    key: 'harassment_training_completed',
    label: 'Harassment prevention training completed',
    help: 'Every two years per person (SB 1343) — not annually, and not one date for the yard.',
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'wvpp_training_completed',
    label: 'Workplace violence prevention training completed',
    help: 'Annually per person (SB 553), and again whenever the plan changes materially.',
    kind: 'last_done',
    expected: 'always',
  },

  // -------------------------------------------------------------------------
  // Vehicle — restated from src/lib/vehicles.ts.
  //
  // VEHICLE_ANCHORS carries no `kind` field. It states the invariant in prose
  // instead — "every one of these names an event that has ALREADY HAPPENED" —
  // which is true and unenforceable. Making it `last_done` on every row turns
  // that paragraph into something a test can fail on, and the test does.
  // -------------------------------------------------------------------------
  {
    key: 'periodic_inspection_date',
    label: 'Last annual DOT inspection',
    help:
      'The date of the last PASSING § 396.17 inspection on this unit — not when the next one ' +
      'is due. Each unit of a combination has its own, so a tractor and its trailer are two ' +
      'dates, not one.',
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'hvut_first_use_date',
    label: 'First used on public highways',
    help:
      'Any date inside the month this unit first ran on public roads. Form 2290 is counted ' +
      'from that month, which is why a truck bought in March has its own deadline rather than ' +
      "sharing the fleet's.",
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'carb_ctc_first_deadline',
    label: 'Clean Truck Check — first deadline of the compliance year',
    help:
      'The first CTC deadline of a compliance year that has ALREADY passed: your DMV ' +
      'registration month, or, on out-of-state plates, the month CARB derives from the VIN. ' +
      'Not the next one — we step forward from this.',
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'ctc_vis_reportable_event',
    label: 'Bought or sold this vehicle on',
    help:
      'The date of the purchase or sale that has to show up in your CTC-VIS listing. The ' +
      '30-day clock runs from the deal, not from the calendar. Leave it blank if this unit has ' +
      'not changed hands — a fleet that has bought and sold nothing owes nothing here.',
    kind: 'last_done',
    // The help sentence says it outright: a fleet that has bought and sold
    // nothing owes nothing here. Counting this blank as an outstanding item on
    // every truck in the yard would be a false alarm dressed as a question.
    expected: 'only_if_it_applies',
  },
  {
    key: 'bit_last_inspection',
    label: 'Last 90-day BIT inspection',
    help:
      'The date you last inspected this unit under your own BIT cycle. This is your ' +
      'inspection, not a CHP visit to the terminal — CHP picks terminals from performance ' +
      'data and there is no cycle to predict for that.',
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'cvra_last_registered',
    label: 'Last CVRA registration renewal',
    help:
      'The date registration was last issued or renewed for this unit — not the date on the ' +
      'card saying when it expires.',
    kind: 'last_done',
    expected: 'always',
  },

  // -------------------------------------------------------------------------
  // Carrier, and one driver key — written here first.
  //
  // These had no label and no help anywhere: the carrier has thirteen questions
  // and no screen has ever asked one of them. Every sentence below is taken from
  // the `title`, `citation`, `evidence` and `consequence` of the rule row that
  // reads the key, and from the comments beside it. Nothing states a legal
  // requirement the catalogue does not state — where the rules are silent, so is
  // the help text.
  // -------------------------------------------------------------------------
  {
    key: 'supervisor_designated_date',
    label: 'Reasonable-suspicion supervisor designated',
    // The trap is which date this is. § 382.603 is one-time training, and the
    // rule row hangs the deadline off the DESIGNATION, not the training — so an
    // owner who types the training date reports the obligation as satisfied on
    // the day it came due. The second sentence is the rule's own warning that
    // vendors sell an annual refresher the regulation does not require.
    help:
      'The day you put someone in charge of reasonable-suspicion calls — not the day of the ' +
      'training. The 120 minutes is owed once per supervisor, never annually.',
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'ucr_paid_through',
    label: 'UCR registration paid through',
    // Two dates are in play and neither is obvious: registration opens 1 October
    // and the fee is due before 1 January of the year it COVERS, so the money
    // leaves in the autumn for a year that has not started. The anchor is the
    // 31 December ending the year paid for, and a payment date typed here is
    // wrong by up to fifteen months in the direction that hides a lapse.
    help:
      'The 31 December that ends the last registration year you paid for — not the day you ' +
      'paid. Registration opens in October for the year after.',
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'accident_date',
    label: 'Reportable accident date',
    // The § 390.5 definition, in the owner's words, because the rule's own
    // comment says carriers routinely over-report and then argue about their own
    // register in an audit. `only_if_it_applies` because a carrier with no
    // reportable accident has nothing to type and never will — leaving it
    // `always` puts a permanently unanswerable row on a shrinking list.
    help:
      'Leave blank if you have had none. It means a death, an injury treated away from the ' +
      'scene, or damage needing a tow — not every collision.',
    kind: 'last_done',
    expected: 'only_if_it_applies',
  },
  {
    key: 'mcp_issued',
    label: 'Motor Carrier Permit issued or last renewed',
    // The permit itself prints an expiration date — the rule's `evidence` says
    // so — and that is the number an owner will read off it. Typing the expiry
    // into an anniversary anchor makes compute.ts step a year past the renewal
    // it was told about and answer with the one after.
    help:
      'The day the permit was issued or last renewed — not the expiration date printed on it. ' +
      'The term runs 12 months from the month you applied.',
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'irp_last_renewed',
    label: 'IRP apportioned registration last renewed',
    // There is no shared IRP date and no public lookup: DMV assigns each account
    // a month. An owner who assumes January, or who types the next expiry, moves
    // the deadline on the one filing that takes the plates off the trucks.
    help:
      'The day you last renewed apportioned registration, not the day it next expires. DMV ' +
      'assigns your renewal month, so it is not January for everyone.',
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'wvpp_plan_reviewed',
    label: 'Workplace violence prevention plan last reviewed',
    // Reviewing the plan and training the staff are two rows in california.ts
    // precisely because a carrier can be current on one and years behind on the
    // other. This is the same trap as the MVR and its annual review: one date
    // typed into both boxes satisfies neither auditor.
    help:
      'The plan itself, not the training — a different job, and one date for the business. ' +
      'Twelve months from the last review, not every January.',
    kind: 'last_done',
    expected: 'always',
  },
  {
    key: 'hazmat_training_date',
    label: 'Hazmat recurrent training completed',
    // A driver anchor that DRIVER_ANCHORS never had, so the twelve-field driver
    // form could not collect it and the row fired for every driver forever.
    // `ctx.hazmat` now comes from `carriers.hazmat` (0031), filled from the
    // census `hm_ind` at signup and correctable on /app/settings; a carrier
    // with NULL there still fails open, and the honest answer — "we do not
    // haul hazmat" — is not a date at all. Marked `only_if_it_applies` so a
    // blank stops counting against a carrier who hauls no hazmat.
    help:
      'Leave blank unless you haul hazmat. Every three years from this driver’s last ' +
      'training — not the 90 days a new hazmat employee gets.',
    kind: 'last_done',
    expected: 'only_if_it_applies',
  },

  // -------------------------------------------------------------------------
  // The deny-list: three keys that must never be rendered as a date input.
  //
  // They are in the registry, with labels and help, precisely BECAUSE they must
  // not be typed. The engine emits all three as `answerKey`s, so a page that
  // simply skipped them would drop the row and leave the owner with a dashboard
  // count that never reaches zero and no explanation. Each one says where the
  // real answer lives so the row can be a link instead of a box.
  // -------------------------------------------------------------------------
  {
    key: 'hire_date',
    label: 'Hire date',
    // deadlines.ts projects `drivers.hired_on` into `ctx.anchors` with
    // `if (a[anchorKey]) continue` — so a compliance record SILENTLY OUTRANKS
    // the column. A typo typed here would permanently override a correct hire
    // date, move five federal rules (the DQF, the road test, the pre-employment
    // Clearinghouse query, and the 30-day MVR and previous-employer checks) to
    // the wrong dates, and leave the driver's own page still showing the right
    // one. There is no error and nothing on screen looks broken.
    help:
      'Already on the driver’s own record, and five federal deadlines count from it. Fix it ' +
      'there — a date typed here would quietly outrank it.',
    kind: 'last_done',
    expected: 'always',
    answeredElsewhere: {
      where: 'the driver’s own page',
      source: 'drivers.hired_on',
      // THE TAB IS PART OF THE ADDRESS. The driver page is four tabs now, and a
      // link that lands on the default one puts the owner in front of a
      // checklist when the sentence he just read told him to fix a box on the
      // record. `/app/settings?tab=company` below set the precedent.
      href: '/app/drivers/:id?tab=record#record',
    },
  },
  {
    key: 'cdl_expires',
    label: 'Commercial driver’s licence expires',
    // Same projection, same silent override: deadlines.ts sets `a.cdl_expires`
    // from `drivers.cdl_expires_on` only when no record already claims the key.
    // An expired licence is an ACUTE violation and a single-occurrence automatic
    // failure in a new-entrant audit, so a typo here is expensive in both
    // directions — it can hide a lapse or invent one.
    help:
      'Already on the driver’s own record. Fix it there — a date typed here would outrank the ' +
      'licence on his page, and his page would go on showing the old one.',
    kind: 'expires',
    expected: 'always',
    answeredElsewhere: {
      where: 'the driver’s own page',
      source: 'drivers.cdl_expires_on',
      href: '/app/drivers/:id?tab=record#record',
    },
  },
  {
    key: 'dot_number',
    label: 'USDOT number',
    // Not a date at all. federal-carrier.ts:157 returns `missing_data` needing
    // it when the carrier has none, and the MCS-150 schedule reads it from
    // `ctx.dotNumber` — never from `ctx.anchors`. A compliance record written
    // under this key would therefore do nothing whatsoever: the row would stay
    // exactly as it was and the owner would type it again.
    //
    // `kind` is meaningless here and is the inert default. Nothing may read it,
    // because nothing may render this key as a date input.
    help:
      'Not a date. It comes from your carrier record, so nothing typed here would clear this ' +
      'row — the MCS-150 schedule is read off the digits of the number itself.',
    kind: 'last_done',
    expected: 'always',
    answeredElsewhere: {
      where: 'your carrier details in Settings',
      source: 'carriers.dot_number',
      // The tab, not the bare page. Settings groups its sections behind
      // `?tab=`, and the USDOT box is in the company group — so a link without
      // it drops the owner on his own name and password and leaves him to find
      // the box this row sent him for.
      href: '/app/settings?tab=company',
    },
  },
]

/** Every hand-written entry, in the order declared. */
export const ANCHORS: readonly AnchorEntry[] = SPECS.map((spec) => ({
  ...spec,
  // Derived from the one fact that decides it, so the flag and the reason can
  // never disagree. Hand-typing `writable: false` next to an entry with no
  // `answeredElsewhere` would leave a page with a row it must not let the owner
  // answer and nowhere to send him instead.
  writable: spec.answeredElsewhere === undefined,
}))

const BY_KEY: ReadonlyMap<string, AnchorEntry> = new Map(ANCHORS.map((a) => [a.key, a]))

/**
 * The deny-list, in one place, as the design note asks for.
 *
 * Exported as a set so a page can ask the question without reaching into an
 * entry, and so the three keys can be asserted in a test rather than remembered.
 */
export const UNWRITABLE_ANCHOR_KEYS: ReadonlySet<string> = new Set(
  ANCHORS.filter((a) => !a.writable).map((a) => a.key),
)

/**
 * The entry for any `Status.answerKey`, including the ones nobody wrote.
 *
 * A key that equals a rule code is not a missing anchor — it is the engine
 * saying "the schedule is known, whether it was ever done is not", and that fact
 * has no anchor of its own (see `answerKeyFor` in ./answer.ts). Those questions
 * do not need a hand-written entry, because the rule row already carries better
 * words than a second catalogue would: `title` is what the obligation is called
 * and `evidence` is the piece of paper that proves it.
 *
 * `evidence` is passed through whole rather than trimmed to fit. Several run
 * past 200 characters and a form will have to clamp them, but cutting a
 * compliance sentence mid-clause is how a carrier ends up confidently holding
 * the wrong document — the page can scroll, the text cannot be half-true.
 *
 * `undefined` means the key belongs to neither, which is a bug: it is a question
 * with no words, rendered to the owner. The registry test exists to make sure
 * the engine can never produce one.
 */
export function resolveAnchor(key: string): AnchorEntry | undefined {
  const written = BY_KEY.get(key)
  if (written) return written

  const rule = ruleByCode(key)
  if (!rule) return undefined

  return {
    key,
    label: rule.title,
    help: rule.evidence,
    // Always a past event. The question behind a rule-code key is literally
    // "when did you last do this?", whatever shape the rule's own schedule has —
    // a fixed calendar or an algorithm has no expiry to read off a document.
    kind: 'last_done',
    // `evaluate` drops `not_applicable` rows before anything sees them, so a
    // rule-code question is only ever on screen for a rule the catalogue could
    // not rule out. Noise from a fail-open `applies` is a rule-row problem and
    // must be fixed there, not guessed at here.
    expected: 'always',
    writable: true,
  }
}

/**
 * Where to send the owner for a key he must not type, with the subject filled in.
 *
 * Here rather than on the page because `:id` substitution done in three places
 * is done two ways. Returns null when the entry is writable (there is nowhere
 * else to go) or when the link needs a subject id and there is none — a link to
 * `/app/drivers/:id` is worse than no link.
 */
export function answerLink(entry: AnchorEntry, subjectId: string | null): string | null {
  const elsewhere = entry.answeredElsewhere
  if (!elsewhere) return null
  if (!elsewhere.href.includes(':id')) return elsewhere.href
  if (!subjectId) return null
  return elsewhere.href.replace(':id', encodeURIComponent(subjectId))
}
