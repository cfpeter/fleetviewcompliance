/**
 * The anchor keys the driver pages write into `compliance_records.anchor_key`.
 *
 * These strings are a join between two files that never import each other. The
 * rule catalogue asks for `ctx.anchors['medical_certificate_expires']`; the
 * driver page has to have written a row spelled exactly that way. Nothing checks
 * that the two agree.
 *
 * So a page that types 'medical_cert_expires' into the insert stores the date
 * perfectly, shows it back to the office manager on every visit, and the engine
 * reports the medical card as `missing_data` forever — which sorts with overdue,
 * for a driver whose card is fine, on the one document that parks a truck. There
 * is no error, no empty screen, and nothing to notice. That is why the spellings
 * live here once instead of being typed into a form.
 *
 * Every entry names the rule codes that consume it, so `grep` walks from an
 * anchor to the rules or from a rule back to the field that feeds it.
 *
 * Sources: src/lib/rules/federal-driver.ts and src/lib/rules/california.ts —
 * every rule row in those files whose `subject` is 'driver'.
 */

/**
 * Which way the date points, which is not a formatting detail.
 *
 * `last_done` names an event that has ALREADY happened. compute.ts evaluates a
 * rolling or anniversary schedule as anchor + interval and then walks forward
 * until it passes today, so a FUTURE date there makes it step straight past the
 * occurrence the owner just told us about and answer with the one after. The
 * deadline moves later, which is the single direction this domain refuses to be
 * wrong in — hence the `max` on those inputs.
 *
 * `expires` is the opposite: the anchor IS the due date, read off the document,
 * and it is supposed to be in the future. The medical card is the reason this
 * distinction exists at all — an examiner may certify for any period up to 24
 * months, so the printed expiry governs and no interval can be assumed.
 */
export type DriverAnchorKind = 'last_done' | 'expires'

/**
 * Whether a normal driver is expected to have this date.
 *
 * This is a UI hint about NOISE, not a statement of law. Real applicability
 * lives on the rule rows in `applies`, where it is three-valued, cites a
 * regulation and can be audited. Here it only decides whether a blank counts
 * toward "dates not recorded yet" — because listing the Skill Performance
 * Evaluation expiry as an outstanding item for every driver, when well under 1%
 * of drivers hold one, teaches her to ignore the whole list.
 */
export type DriverAnchorExpectation = 'always' | 'only_if_it_applies'

export interface DriverAnchor {
  /** Written verbatim into compliance_records.anchor_key. Never edit casually. */
  key: string
  label: string
  /** One sentence under the input, in her language, not the CFR's. */
  help: string
  kind: DriverAnchorKind
  expected: DriverAnchorExpectation
  /** Heading this field sits under. Declaration order is display order. */
  group: string
  /** `RuleDefinition.code`s that read this anchor. */
  rules: readonly string[]
}

export const DRIVER_ANCHORS: readonly DriverAnchor[] = [
  // ------------------------------------------------------------ medical
  {
    key: 'medical_certificate_expires',
    label: 'Medical certificate expires',
    // Says "the date printed on the card" rather than "24 months from the exam"
    // because a 3-month or 12-month card is routine where a doctor wanted to
    // keep an eye on something, and assuming the statutory maximum would make us
    // up to 21 months too generous for exactly those drivers.
    help: 'The date printed on the card — not 24 months from the exam. Short cards are normal.',
    kind: 'expires',
    expected: 'always',
    group: 'Medical certificate',
    rules: ['medical_certificate_general'],
  },
  {
    key: 'medical_exam_date',
    label: 'Date of the DOT physical',
    help: 'The day the examination happened. Only used for drivers on a 12-month certificate.',
    kind: 'last_done',
    expected: 'only_if_it_applies',
    group: 'Medical certificate',
    rules: [
      'medical_certificate_intracity_zone',
      'medical_certificate_insulin_treated',
      'medical_certificate_alternative_vision',
    ],
  },

  // ------------------------------------------------------- driving record
  {
    key: 'annual_mvr_last_obtained',
    label: 'Driving record (MVR) last obtained',
    // "Every state that licensed him" is in the help text because the single
    // most common way this item is wrong is a carrier pulling only the current
    // licensing state for a driver who moved.
    help: 'The day the record came back, from every state that licensed him in the last 3 years.',
    kind: 'last_done',
    expected: 'always',
    group: 'Driving record',
    rules: ['mvr_inquiry_annual'],
  },
  {
    key: 'annual_review_last_completed',
    label: 'Annual review of the record last signed',
    // Deliberately worded to stop her filling both boxes with the same date.
    // Pulling the MVR is § 391.25(a); reading it, judging it and signing a note
    // is § 391.25(b), and an auditor asks for the second piece of paper.
    help: 'A different piece of paper from the MVR: the dated note naming who read it.',
    kind: 'last_done',
    expected: 'always',
    group: 'Driving record',
    rules: ['driving_record_review_annual'],
  },

  // ----------------------------------------------------- drug and alcohol
  {
    key: 'clearinghouse_query_last_run',
    label: 'Clearinghouse query last run',
    // The "31 January deadline" is in trade press, competitor marketing and half
    // the checklist PDFs on the internet, and it does not exist. Saying so here
    // is cheaper than answering the support email.
    help: 'Rolling 12 months from this driver’s last query. There is no 31 January deadline.',
    kind: 'last_done',
    expected: 'always',
    group: 'Drug and alcohol',
    rules: ['clearinghouse_query_annual'],
  },
  {
    key: 'return_to_duty_test_date',
    label: 'Return-to-duty test date',
    // No hint here about how many follow-up tests there are or how long the plan
    // runs: 49 CFR 40.307(g) forbids the employer, the SAP and any service agent
    // from telling the driver either. If a driver-facing view is ever built this
    // row has to be invisible to it in the RLS policy, not merely unlinked.
    help: 'Only for a driver who has been through a SAP. Leave blank otherwise.',
    kind: 'last_done',
    expected: 'only_if_it_applies',
    group: 'Drug and alcohol',
    rules: ['return_to_duty_follow_up_testing'],
  },

  // ------------------------------------------------ exemptions and waivers
  //
  // Every field in this group is blank for almost every driver, and each one is
  // the only signal we have that the driver is in the situation it describes —
  // RuleContext has no boolean for "insulin-treated" or "holds an SPE", so the
  // date itself is what switches the shorter certificate term on.
  {
    key: 'intracity_zone_exemption_issued',
    label: 'Intracity zone exemption issued',
    help: 'Leave blank unless he holds one. A date here means his card runs 12 months, not 24.',
    kind: 'last_done',
    expected: 'only_if_it_applies',
    group: 'Exemptions and waivers',
    rules: ['medical_certificate_intracity_zone'],
  },
  {
    key: 'insulin_treated_diabetes_assessment',
    label: 'Insulin-treated diabetes assessment (MCSA-5870)',
    help: 'Leave blank unless he is insulin-treated. Dated within 45 days before the exam.',
    kind: 'last_done',
    expected: 'only_if_it_applies',
    group: 'Exemptions and waivers',
    rules: ['medical_certificate_insulin_treated'],
  },
  {
    key: 'alternative_vision_evaluation',
    label: 'Alternative vision evaluation (MCSA-5871)',
    help: 'Leave blank unless he is certified under the alternative vision standard.',
    kind: 'last_done',
    expected: 'only_if_it_applies',
    group: 'Exemptions and waivers',
    rules: ['medical_certificate_alternative_vision'],
  },
  {
    key: 'spe_certificate_expiry',
    label: 'Skill Performance Evaluation certificate expires',
    help: 'Leave blank unless he holds an SPE. The certificate states its own term — read it off.',
    kind: 'expires',
    expected: 'only_if_it_applies',
    group: 'Exemptions and waivers',
    rules: ['spe_certificate_renewal'],
  },

  // ----------------------------------------------------------- California
  //
  // These two are `subject: 'driver'` rows in california.ts, not federal-driver.ts.
  // They are here because we launch California-only: leaving them uncollectable
  // would mean two live state obligations that the engine can only ever report
  // as missing data, for every driver, with no screen anywhere to answer them on.
  //
  // Both really attach to a PERSON, not to a driver — dispatchers, mechanics and
  // the office are equally covered — and `Subject` has no 'employee' member, so
  // the rules are filed under 'driver' and the office staff cannot be tracked at
  // all. That gap is in california.ts, not something this file can fix.
  {
    key: 'harassment_training_completed',
    label: 'Harassment prevention training completed',
    help: 'Every two years per person (SB 1343) — not annually, and not one date for the yard.',
    kind: 'last_done',
    expected: 'always',
    group: 'California',
    rules: ['ca_harassment_training'],
  },
  {
    key: 'wvpp_training_completed',
    label: 'Workplace violence prevention training completed',
    help: 'Annually per person (SB 553), and again whenever the plan changes materially.',
    kind: 'last_done',
    expected: 'always',
    group: 'California',
    rules: ['ca_wvpp_annual_training'],
  },
]

/**
 * The same anchors, grouped for rendering, in declaration order.
 *
 * Derived rather than written out a second time: a hand-maintained group list is
 * how an anchor ends up in the constant, saved by the loop, and never shown on
 * the form — present in the database, absent from the screen, and blamed on the
 * engine.
 */
export const DRIVER_ANCHOR_GROUPS: readonly { name: string; anchors: DriverAnchor[] }[] =
  DRIVER_ANCHORS.reduce<{ name: string; anchors: DriverAnchor[] }[]>((groups, anchor) => {
    const existing = groups.find((g) => g.name === anchor.group)
    if (existing) existing.anchors.push(anchor)
    else groups.push({ name: anchor.group, anchors: [anchor] })
    return groups
  }, [])

/**
 * `hire_date` is a driver-subject anchor as well, and it is deliberately NOT in
 * the list above.
 *
 * Five federal rules hang off it — the DQF, the road test, the pre-employment
 * Clearinghouse query, and the 30-day MVR and previous-employer checks — but the
 * fact already exists as `drivers.hired_on`, typed once on the add-a-driver form.
 * Collecting it again under Compliance dates would ask the office manager for
 * the same thing twice and then leave us holding two answers that can disagree,
 * with nothing to say which one a deadline should be counted from.
 *
 * The bill for that decision falls on whoever builds the rule context: it must
 * project `drivers.hired_on` into `ctx.anchors.hire_date`. Skip the projection
 * and all five rules report `missing_data` for every driver in the fleet, while
 * the hire date sits on screen looking answered.
 */
export const DRIVER_ANCHORS_FROM_DRIVER_COLUMNS = {
  hire_date: 'hired_on',
} as const
