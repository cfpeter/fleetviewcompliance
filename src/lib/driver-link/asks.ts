/**
 * What a driver can be asked for, and — far more importantly — what he cannot.
 *
 * THE RULE THAT DECIDES WHAT IS IN HERE: a field is offered only if the answer
 * is printed on a document the driver is holding. That is not a UX preference,
 * it is the difference between a question he can answer and a question that
 * wastes a text message:
 *
 *   - His medical card carries its own expiry date. He can read it to you.
 *   - His annual MVR does not exist in his pocket. The CARRIER pulls it from the
 *     state, records the date, and the driver has no way to know it. Texting him
 *     a link asking for it is asking for a number he would have to invent.
 *
 * So `annual_mvr_last_obtained`, `annual_review_last_completed` and
 * `clearinghouse_query_last_run` are absent, and their absence is the feature.
 *
 * AND ONE ABSENCE THAT IS THE LAW. `return_to_duty_test_date` is not here and
 * must never be. 49 CFR 40.307(g) forbids the employer, the SAP and any service
 * agent from showing a driver his follow-up testing schedule or hinting at its
 * frequency. This repo says so in four places — docs/REQUIREMENTS.md:280,
 * docs/research/compliance-part40.md:64, src/lib/rules/driver-anchors.ts:136 and
 * src/lib/rules/federal-driver.ts:226 — and every one of them says the same
 * thing: enforce it in the policy, not the UI.
 *
 * It is enforced in three places, on purpose:
 *   1. `driver_links_asks_known` in 0034 refuses to STORE an ask outside this
 *      list, so a forbidden key cannot get into a link.
 *   2. `driver_link_view` in 0036 reads nothing but the asks, so there is no
 *      branch that could return it.
 *   3. tests/driver-link.test.ts asserts it, and that test must never be
 *      deleted.
 *
 * The predecessor app never met this rule at all — zero mentions of 40.307,
 * return-to-duty or SAP anywhere in it. It was safe by accident of scope.
 */
import { DRIVER_ANCHORS } from '../rules/driver-anchors.ts'

/** The closed set. Same six strings as the CHECK constraint in 0034. */
/**
 * THE SEVENTH, AND IT IS NOT A DATE.
 *
 * "Send the office whatever they asked you for." It names no anchor, carries no
 * date box, and writes nothing on acceptance — all it does is let a link exist
 * for a driver who owes none of the six dated papers, so that the owner can
 * always text him and the ungated "Anything else to send?" box on the driver's
 * page is the whole question.
 *
 * Deliberately absent from `DRIVER_ASKS` below. Everything downstream — the
 * driver's page, `accept.ts` — builds its work by filtering that catalogue, so
 * a key that is not in it contributes no question and no write, which is
 * exactly the behaviour wanted. See 0042.
 */
export const ANYTHING_ASK = 'anything' as const

export const ASK_KEYS = [
  'medical',
  'cdl',
  'spe',
  'intracity',
  'diabetes',
  'vision',
  ANYTHING_ASK,
] as const
export type AskKey = (typeof ASK_KEYS)[number]

/**
 * Where an accepted answer lands.
 *
 * Two shapes because the answers live in two places, exactly as they do on the
 * dashboard's row editor: most are compliance anchors, and a CDL expiry is a
 * column on the driver, because a compliance record written under `cdl_expires`
 * would silently outrank that column forever.
 */
export type AskTarget =
  | { via: 'anchor'; anchorKey: string }
  | { via: 'column'; column: 'cdl_expires_on' }

export interface DriverAsk {
  key: AskKey
  /** What the OWNER reads when ticking what to ask for. */
  label: string
  /** What the DRIVER reads above the box. Shorter, and about the paper. */
  driverLabel: string
  /**
   * WHICH WAY THE DATE POINTS, and it is not the same for all six.
   *
   * A medical card and an SPE certificate carry an EXPIRY. A zone exemption, a
   * diabetes assessment and a vision evaluation carry the date the thing
   * HAPPENED — `kind: 'last_done'` on their anchors in src/lib/rules/anchors.ts.
   * The form asked "Expiry date" for all six, which is a wrong question on
   * three of them: a man reading "expiry" off an assessment form either types
   * the wrong date or gives up and rings the office.
   */
  dateIs: 'expires' | 'issued'
  /** The label above the box. Follows `dateIs`, never guessed by the page. */
  dateLabel: string
  /** One line under the box, in his words. Says which date, not which rule. */
  hint: string
  /** The label on the file input for this ask. */
  photoLabel: string
  target: AskTarget
  /** What an accepted photo is filed as. A key from DRIVER_DOCUMENT_KINDS. */
  documentKind: string
  /**
   * True when it only applies to some drivers. The owner's picker says so, so
   * he does not tick "SPE certificate" for a driver who has never had one.
   */
  conditional: boolean
}

/**
 * The catalogue.
 *
 * The driver-facing words are deliberately about the PAPER and never about the
 * regulation. "The date printed on the examiner's certificate" is something a
 * man can check while holding the card; "49 CFR 391.45" is not. These are read
 * on a phone, in a yard, often by somebody who does not read English first.
 */
export const DRIVER_ASKS: readonly DriverAsk[] = [
  {
    key: 'medical',
    label: 'Medical certificate expiry',
    driverLabel: 'Medical card',
    dateIs: 'expires',
    dateLabel: 'Expiry date',
    hint: 'The date printed on the examiner’s certificate. Not the date of the exam.',
    photoLabel: 'Photo of the card',
    target: { via: 'anchor', anchorKey: 'medical_certificate_expires' },
    documentKind: 'medical_certificate',
    conditional: false,
  },
  {
    key: 'cdl',
    label: 'Licence (CDL) expiry',
    driverLabel: 'Driver licence',
    dateIs: 'expires',
    dateLabel: 'Expiry date',
    hint: 'The expiry date on the front of your licence.',
    photoLabel: 'Photo of the licence',
    // NOT an anchor. `cdl_expires` is on the unwritable list in
    // src/lib/rules/anchors.ts because a compliance record under that key
    // outranks the driver's own column and nothing on screen would show it.
    target: { via: 'column', column: 'cdl_expires_on' },
    documentKind: 'cdl',
    conditional: false,
  },
  {
    key: 'spe',
    label: 'SPE certificate expiry',
    driverLabel: 'SPE certificate',
    dateIs: 'expires',
    dateLabel: 'Expiry date',
    hint: 'The expiry date on the certificate.',
    photoLabel: 'Photo of the certificate',
    target: { via: 'anchor', anchorKey: 'spe_certificate_expiry' },
    documentKind: 'spe_certificate',
    conditional: true,
  },
  {
    key: 'intracity',
    label: 'Intracity zone exemption',
    driverLabel: 'Zone exemption paper',
    dateIs: 'issued',
    dateLabel: 'Date on the paper',
    hint: 'The date the exemption was given to you, not an expiry.',
    photoLabel: 'Photo of the paper',
    target: { via: 'anchor', anchorKey: 'intracity_zone_exemption_issued' },
    documentKind: 'intracity_exemption',
    conditional: true,
  },
  {
    key: 'diabetes',
    label: 'Diabetes assessment date',
    driverLabel: 'Diabetes assessment',
    dateIs: 'issued',
    dateLabel: 'Date of the assessment',
    hint: 'The day the assessment was done.',
    photoLabel: 'Photo of the form',
    target: { via: 'anchor', anchorKey: 'insulin_treated_diabetes_assessment' },
    documentKind: 'medical_assessment',
    conditional: true,
  },
  {
    key: 'vision',
    label: 'Vision evaluation date',
    driverLabel: 'Vision evaluation',
    dateIs: 'issued',
    dateLabel: 'Date of the evaluation',
    hint: 'The day the evaluation was done.',
    photoLabel: 'Photo of the form',
    target: { via: 'anchor', anchorKey: 'alternative_vision_evaluation' },
    documentKind: 'medical_assessment',
    conditional: true,
  },
]

/** One ask, or null. Never throws on a value out of a form or a URL. */
export function askByKey(raw: unknown): DriverAsk | null {
  const key = String(raw ?? '').trim()
  if (!key) return null
  return DRIVER_ASKS.find((a) => a.key === key) ?? null
}

/**
 * The asks a posted form actually selected.
 *
 * Unrecognised entries are DROPPED, not refused — the same doctrine
 * `parseOperators` and `readTypedDates` use. A crafted POST naming a seventh
 * field is not an error to report, it is a field nobody looks at. Returns them
 * in catalogue order so two links asking for the same things store the same
 * array and `sameAsk` below can compare them.
 */
export function readAsks(values: readonly string[]): AskKey[] {
  const picked = new Set(values.map((v) => String(v ?? '').trim()))
  // Over ASK_KEYS rather than DRIVER_ASKS, so the dateless seventh is readable
  // off a form too. The order is the constant's own, which is what makes two
  // links asking the same things store the same array for `sameAsk`.
  return ASK_KEYS.filter((k) => picked.has(k))
}

/** Two links ask the same thing. Used to retire a live link when a new one is minted. */
export function sameAsk(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i])
}

/**
 * THE DASHBOARD'S NAME for the same fact.
 *
 * `DateQuestion.answerKey` on the "dates we are missing" screen is the anchor
 * key — except for the licence, which is a column on the driver and reaches the
 * engine as the projected anchor `cdl_expires` (src/lib/deadlines.ts). Without
 * that one line, a driver whose only missing date is his licence would offer no
 * ask at all, which is the most common missing date there is.
 */
export function answerKeyForAsk(ask: DriverAsk): string {
  return ask.target.via === 'anchor' ? ask.target.anchorKey : 'cdl_expires'
}

/**
 * Missing dates → the things we can ask the driver himself for.
 *
 * The dashboard knows exactly which dates a driver is short of. Making the
 * owner re-tick them on another screen is asking him to copy a list he is
 * already looking at, so the action menu on that card asks for precisely
 * these — and for nothing else, because the whitelist in this file is what
 * keeps 49 CFR 40.307(g) off a driver's phone.
 *
 * Order follows the catalogue, not the dashboard, so the message a driver gets
 * reads the same way whichever screen sent it.
 */
export function asksForAnswerKeys(keys: Iterable<string>): AskKey[] {
  const want = new Set(keys)
  return DRIVER_ASKS.filter((a) => want.has(answerKeyForAsk(a))).map((a) => a.key)
}

/**
 * Every anchor key this module can ever write.
 *
 * Exported so the test can hold it against DRIVER_ANCHORS and prove the
 * forbidden one is absent, rather than proving it about a list written twice.
 */
export const ASK_ANCHOR_KEYS: readonly string[] = DRIVER_ASKS.filter(
  (a) => a.target.via === 'anchor',
).map((a) => (a.target as { anchorKey: string }).anchorKey)

/**
 * The driver anchors this catalogue deliberately leaves alone.
 *
 * Derived rather than typed out, so a new anchor in the registry shows up here
 * the moment it is added and somebody has to decide which side it belongs on.
 */
export const NOT_ASKABLE: readonly string[] = DRIVER_ANCHORS.map((a) => a.key).filter(
  (k) => !ASK_ANCHOR_KEYS.includes(k),
)
