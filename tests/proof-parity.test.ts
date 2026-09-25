/**
 * One driver, two audiences, one answer.
 *
 * The owner prints his binder at src/pages/app/drivers/[id]/file.astro. A
 * broker opens the same driver at src/pages/proof/[token].astro under the
 * `driver_file` scope. The two used to disagree, and they disagreed in the
 * worst available direction: the page a carrier SENDS OUT reported more gaps
 * than the page he read himself. He tells the broker the record is clean, the
 * broker's own link says five of eight items need attention, and the carrier
 * looks either careless or dishonest.
 *
 * Three corrections had grown inside the owner's page and stayed there:
 *
 *   1. AN APPLICABILITY FILTER. (b)(8) is a non-CDL requirement and (b)(7)
 *      exists only where an SPE does. The binder dropped them; the shared link
 *      listed both as "Not on file" and counted them as gaps.
 *
 *   2. THE hired_on -> hire_date PROJECTION. Five federal rules hang off the
 *      hire date, which is not a compliance anchor — it is a column on the
 *      driver row. `share_driver` returns it and the broker page never used it,
 *      so (b)(1), (b)(2) and (b)(3) came back "Not known".
 *
 *   3. THE PAPER-BACKING CHECK. A typed date with no document behind it reads
 *      "Date recorded, no document", not "On file".
 *
 * All three live in src/lib/proof/dqf.ts now, and the two halves below are the
 * two pages' frontmatter transcribed against it. They are handed the same facts
 * and they are asserted to produce the same document, word for word.
 *
 * The third correction needed a database change as well as a lift. The shared
 * link could not see the documents table at all — `anon` has no grant on it —
 * so 0041_share_documents.sql added the one function that answers "is there
 * paper behind this paragraph", returning kinds and nothing else.
 * tests/share-scope.test.ts proves what that function opens onto, as the real
 * `anon` role. The last test here covers what is left: the page still has to
 * survive that call FAILING, and a database hiccup must not turn a shared
 * record into an accusation.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assembleDqf,
  type DqfItem,
  driverFileAnchors,
  gaps,
  holdsSpe,
  stateWord,
  summarise,
} from '../src/lib/proof/dqf.ts'
import { utcDate } from '../src/lib/rules/dates.ts'
import { type DeadlineItem, type EvaluationSubject, evaluate } from '../src/lib/rules/index.ts'

const TODAY = utcDate(2026, 9, 15)

/**
 * ONE DRIVER, WRITTEN DOWN ONCE.
 *
 * Both halves read these same constants, so nothing below can differ because it
 * was handed different facts. The columns are the ones `share_driver` actually
 * returns, `hired_on` included: the broker's page can see the hire date, and
 * the bug was that it did not use it.
 */
const DRIVER = {
  id: 'd-parity',
  first_name: 'Miguel',
  last_name: 'Santos',
  cdl_number: 'C0148822',
  cdl_state: 'CA',
  cdl_expires_on: '2028-04-30',
  hired_on: '2025-03-10',
}

/** The three facts that decide which half of the catalogue applies, plus state. */
const CARRIER = {
  phy_state: 'CA',
  carrier_operation: 'A',
  for_hire: true,
  hazmat: false,
}

/**
 * What the office manager typed in, as `current_compliance_anchors` holds it
 * and as `share_anchors` hands it over — the same rows on both sides.
 *
 * This is a WELL-KEPT file on purpose. The divergence has to be caught on a
 * driver with nothing wrong with him, because that is the driver whose record
 * gets shared with a broker.
 *
 * `hire_date` is deliberately absent. It is not a compliance anchor and never
 * has been — see src/lib/rules/driver-anchors.ts — which is exactly why the
 * projection in `driverFileAnchors` is load-bearing.
 */
const RECORDED: Record<string, string> = {
  dqf_maintained: '2025-03-10',
  mvr_inquiry_at_hire: '2025-03-20',
  road_test_or_equivalent: '2025-03-12',
  annual_mvr_last_obtained: '2026-02-01',
  annual_review_last_completed: '2026-02-01',
  medical_certificate_expires: '2027-08-15',
  medical_exam_date: '2025-08-15',
}

/**
 * The paper uploaded against this driver, un-superseded.
 *
 * `medical_certificate` is missing on purpose: the date is typed in and the
 * card was never scanned, which is the ordinary state of a real file and the
 * case the binder prints "Date recorded, no document" for.
 */
const UPLOADED = new Set(['employment_application', 'mvr', 'annual_review', 'road_test'])

/** 'YYYY-MM-DD' -> a UTC midnight Date. Both pages carry this verbatim. */
function parseDate(v?: string): Date | undefined {
  if (!v) return undefined
  const [y, m, d] = v.split('-').map(Number)
  return y && m && d ? new Date(Date.UTC(y, m - 1, d)) : undefined
}

/** The recorded anchors as either surface receives them, before the projection. */
function recordedAnchors(): Record<string, Date | undefined> {
  const out: Record<string, Date | undefined> = {}
  for (const [key, on] of Object.entries(RECORDED)) {
    const d = parseDate(on)
    if (d) out[key] = d
  }
  return out
}

/**
 * The engine, run on this driver. Identical on both sides — same anchors, same
 * context, same day — which is the thing the projection had to be shared for.
 */
function evaluateDriver(): DeadlineItem[] {
  const subject: EvaluationSubject = {
    type: 'driver',
    id: DRIVER.id,
    label: `${DRIVER.first_name} ${DRIVER.last_name}`.trim(),
    context: {
      cdl: Boolean(DRIVER.cdl_number),
      registrationState: CARRIER.phy_state,
      carrierOperation: CARRIER.carrier_operation,
      forHire: CARRIER.for_hire,
      hazmat: CARRIER.hazmat,
    },
    anchors: driverFileAnchors(recordedAnchors(), {
      hired_on: parseDate(DRIVER.hired_on),
      cdl_expires_on: parseDate(DRIVER.cdl_expires_on),
    }),
  }
  return evaluate([subject], TODAY).filter((i) => i.subjectId === DRIVER.id)
}

/** What a reader ends up with, reduced to the part a reader can actually see. */
interface Binder {
  items: DqfItem[]
  /**
   * The word beside each paragraph, in statutory order — ALL EIGHT, including
   * the ones this driver is not expected to hold. Both pages list all eight and
   * both say "Does not apply" in place of a state, because a row reading "Not
   * on file" beside a ring that does not count it is its own kind of lie.
   */
  rows: { paragraph: string; shown: string }[]
  /** Every paragraph's state, including the two that may not be this driver's. */
  states: Record<string, string>
  /** The counts in the header, and in the ring `dqRing` builds from them. */
  headline: { present: number; expiring: number; attention: number; total: number }
  /** The gap report on page one, in the order it is printed. */
  outstanding: string[]
}

function read(items: DqfItem[]): Binder {
  const summary = summarise(items, TODAY)
  return {
    items,
    rows: items.map((i) => ({
      paragraph: i.paragraph,
      shown: i.notApplicable ? 'Does not apply' : stateWord(i),
    })),
    states: Object.fromEntries(
      items.map((i) => [i.paragraph, i.notApplicable ? 'not this driver’s to hold' : i.state]),
    ),
    headline: {
      present: summary.present,
      expiring: summary.expiring,
      attention: summary.attention,
      total: summary.total,
    },
    outstanding: gaps(items).map((i) => i.paragraph),
  }
}

/** The owner's binder: src/pages/app/drivers/[id]/file.astro. */
function ownerBinder(): Binder {
  const mine = evaluateDriver()
  return read(
    assembleDqf({
      items: mine,
      driver: { cdl: Boolean(DRIVER.cdl_number), spe: holdsSpe(mine) },
      uploadedKinds: UPLOADED,
    }),
  )
}

/**
 * The broker's link: src/pages/proof/[token].astro, the `driver_file` scope.
 *
 * The same call the owner's page makes, down to `uploadedKinds` — which is
 * `share_documents` since 0041. It is passed EXPLICITLY at every call below,
 * with no default, because the one case worth testing separately is the RPC
 * failing, and a default would quietly swallow the `undefined` that says so.
 */
function brokerBinder(uploadedKinds: ReadonlySet<string> | undefined): Binder {
  const items = evaluateDriver()
  return read(
    assembleDqf({
      items,
      driver: { cdl: Boolean(DRIVER.cdl_number), spe: holdsSpe(items) },
      uploadedKinds,
    }),
  )
}

test('the owner’s binder and the broker’s link score the same driver the same way', () => {
  // The states, paragraph by paragraph, including which two are not this
  // driver's to hold. A carrier cannot send out a record that is harder on him
  // than the one he reads himself.
  assert.deepEqual(brokerBinder(UPLOADED).states, ownerBinder().states)
})

test('the two surfaces count the same number of items needing attention', () => {
  const owner = ownerBinder()
  const broker = brokerBinder(UPLOADED)

  // The number a broker quotes back down the phone. The owner's header, the
  // broker's ring and the gap report on page one all read off these four.
  assert.deepEqual(
    broker.headline,
    owner.headline,
    'the shared link counted a different file from the binder the owner printed',
  )
  assert.deepEqual(
    broker.outstanding,
    owner.outstanding,
    'the gap report on page one names different paragraphs on the two pages',
  )

  // Six, not eight: he holds a CDL, so (b)(8) is not his, and no SPE is on his
  // record, so neither is (b)(7). Pinned rather than left relative, because
  // "6 of 6" and "6 of 8" are different claims about one clean file.
  assert.deepEqual(owner.headline, { present: 6, expiring: 0, attention: 0, total: 6 })
})

test('the two surfaces print the same word beside every paragraph', () => {
  const owner = ownerBinder()
  const broker = brokerBinder(UPLOADED)

  assert.deepEqual(broker.rows, owner.rows)

  // The word this whole exercise is about. The card's expiry is typed in and
  // nobody ever scanned the card, and both pages now say which half is missing
  // rather than calling half of it "On file".
  assert.equal(
    owner.rows.find((r) => r.paragraph === '(b)(6)')?.shown,
    'Date recorded, no document',
    'a typed date with no scan behind it is half of something, and says so',
  )
})

test('a failed document read reads as “we did not look”, never as “there is none”', () => {
  // `share_documents` can fail — a dropped connection, a revoked grant, a
  // timeout — and the broker page hands `assembleDqf` undefined when it does.
  // UNDEFINED IS NOT AN EMPTY SET. An empty set means we looked and found
  // nothing, and every typed date in the file would then read "Date recorded,
  // no document": a database hiccup turning the one page a carrier sends to a
  // customer into an accusation about his paperwork.
  const blind = brokerBinder(undefined)

  for (const item of blind.items) {
    assert.equal(item.paper, 'unseen', `${item.paragraph} claimed to know about the paper`)
    assert.notEqual(
      stateWord(item),
      'Date recorded, no document',
      `${item.paragraph} reported a missing document without having looked for one`,
    )
  }

  // And it costs nothing but that word: the states and the counts are the
  // paper's business nowhere else, so the file still reads the same.
  assert.deepEqual(blind.states, ownerBinder().states)
  assert.deepEqual(blind.headline, ownerBinder().headline)
})

test('neither page prints a state for a paragraph it has stopped counting', async () => {
  // Markup, so this reads the two files as text — the same blunt instrument
  // tests/proof-binder.test.ts uses, and for the same reason: an Astro render
  // would need a build step to catch what a substring match catches for free.
  //
  // The failure it guards is the one this lift nearly shipped. `gaps` and
  // `summarise` stopped counting (b)(7) and (b)(8) for a CDL driver, and the
  // item lists went on printing "Not on file" against both — two red-looking
  // rows under a ring reading 6 of 6, on the page a broker opens.
  const pages = ['../src/pages/app/drivers/[id]/file.astro', '../src/pages/proof/[token].astro']

  for (const rel of pages) {
    const src = await readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
    assert.match(
      src,
      /notApplicable/,
      `${rel} never reads notApplicable, so it prints a state for a paragraph it does not count`,
    )
    assert.match(src, /Does not apply/, `${rel} must say so in words, not leave a blank`)
  }
})
