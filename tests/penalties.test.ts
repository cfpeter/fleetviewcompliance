/**
 * The money, and the two ways it goes wrong.
 *
 * FIRST: THE FIGURE DRIFTS FROM THE RESEARCH. docs/research/compliance-penalties.md
 * is the verified record — amounts read off 49 CFR 386 Appendix B as adjusted by
 * 89 FR 106282, checked against eCFR. If a number here stops matching that
 * table, nothing throws and nothing looks wrong: the app simply starts telling
 * carriers a figure no regulation supports. So the table is PARSED, not
 * restated, and every encoded amount is held against it.
 *
 * SECOND: AN AMOUNT WITHOUT A DATE. The research is explicit that DOT appears to
 * have skipped the January 2026 adjustment cycle, so these are simultaneously
 * the current amounts and the stalest they have ever been. An amount whose
 * effective date nobody recorded is an amount nobody can tell is out of date —
 * which is precisely the state the prose constants were in before this existed.
 *
 * And one thing this file refuses on principle: the "$10,000 per day" claim.
 * It is in competitor copy, it is checkable, it is wrong, and the audience
 * includes people who have actually been fined.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { allRules } from '../src/lib/rules/index.ts'
import {
  effectiveLabel,
  money,
  PENALTIES,
  type Penalty,
  penaltyAmount,
  penaltyPhrase,
} from '../src/lib/rules/penalties.ts'

const RESEARCH = readFileSync(
  new URL('../docs/research/compliance-penalties.md', import.meta.url),
  'utf8',
)

/**
 * The research table, keyed by its Appendix B subsection.
 *
 * Parsed out of the markdown rather than retyped, for the same reason the anchor
 * registry reads the migrations: a copy made here would keep agreeing with
 * itself long after it stopped agreeing with the source.
 */
function researchRows(): Map<string, string> {
  const rows = new Map<string, string>()
  for (const line of RESEARCH.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    // | violation | amount | appendix B | -> cells[1..3], plus empty ends.
    const section = cells[3]
    if (!section || !/^\([a-z]\)\(\d+\)$|^\(b\)$/.test(section)) continue
    rows.set(section, cells[2] ?? '')
  }
  return rows
}

/** '49 CFR 386 App. B(a)(1)' -> '(a)(1)'. */
const subsection = (p: Penalty) => p.citation.replace('49 CFR 386 App. B', '')

describe('civil penalty amounts', () => {
  // FAILURE PINNED: an amount in the app that the verified research does not
  // support — the app quoting a carrier a number no regulation carries.
  test('every encoded amount matches the research document', () => {
    const rows = researchRows()
    assert.ok(rows.size >= 6, `only ${rows.size} rows parsed out of the research table`)
    assert.ok(PENALTIES.length >= 4, 'PENALTIES did not load')

    for (const p of PENALTIES) {
      const row = rows.get(subsection(p))
      assert.ok(row, `nothing in the research table for ${p.citation} — is ${p.key} verified?`)

      // The figures in that row, in the order the table writes them.
      const figures = [...row.matchAll(/\$[\d,]+/g)].map((m) => m[0])
      assert.ok(
        figures.includes(money(p.maxCents)),
        `${p.key}: ${money(p.maxCents)} not in "${row}"`,
      )
      if (p.minCents !== undefined) {
        assert.ok(figures.includes(money(p.minCents)), `${p.key}: min not in "${row}"`)
      }
      if (p.capCents !== undefined) {
        assert.ok(figures.includes(money(p.capCents)), `${p.key}: cap not in "${row}"`)
      }
    }
  })

  // FAILURE PINNED: "per day" applied to an amount Appendix B states per
  // violation. This is the $10,000/day myth's exact shape, and getting it wrong
  // inflates a figure by a factor of however many days have passed.
  test('only the recordkeeping line is charged per day', () => {
    for (const p of PENALTIES) {
      const perDay = p.unit === 'per_day'
      assert.equal(
        perDay,
        p.key === 'recordkeeping',
        `${p.key} is ${p.unit}; Appendix B says "per day" only where it says so, and (a)(1) ` +
          'is the only line that does',
      )
    }
    // A daily amount that never stops is not something this app should be able
    // to state: (a)(1) has a cap and the cap is the number that matters.
    for (const p of PENALTIES) {
      if (p.unit === 'per_day') {
        assert.ok(p.capCents, `${p.key} accrues per day with no cap`)
        assert.ok(p.capCents > p.maxCents, `${p.key}: the cap is below one day's amount`)
      }
    }
  })

  // FAILURE PINNED: an amount nobody can tell is stale.
  test('every amount carries an effective date and a citation', () => {
    for (const p of PENALTIES) {
      assert.match(p.effectiveOn, /^\d{4}-\d{2}-\d{2}$/, `${p.key} has no usable effective date`)
      assert.ok(p.citation.length > 0, `${p.key} has no citation`)
      assert.ok(p.source.length > 0, `${p.key} does not say which rule set it`)
      assert.ok(p.maxCents > 0, `${p.key} has no amount`)
      assert.ok(Number.isInteger(p.maxCents), `${p.key} is not a whole number of cents`)
    }
  })

  // FAILURE PINNED: the employer's money and the driver's money added together.
  // Appendix B sets $19,246 at (a)(3) for the employer and $4,812 at (a)(4) for
  // the driver, for the same subject matter. A dashboard total that mixed them
  // would bill the owner for a penalty another person owes.
  test('each amount says who pays it', () => {
    for (const p of PENALTIES) {
      assert.ok(
        p.payer === 'carrier' || p.payer === 'driver',
        `${p.key} does not say whose money it is`,
      )
    }
    const employer = PENALTIES.find((p) => p.key === 'part382_employer')
    const driver = PENALTIES.find((p) => p.key === 'part382_driver')
    assert.ok(employer && driver, 'the two Part 382 sides are not both present')
    assert.equal(employer.payer, 'carrier')
    assert.equal(driver.payer, 'driver')
    assert.ok(
      employer.maxCents > driver.maxCents,
      'the employer line is the larger of the two; if that has flipped, the citations are swapped',
    )
  })

  // FAILURE PINNED: the sentence on a rule and the number in a total disagreeing.
  // They cannot, because the sentence is generated — this pins that it stays so.
  test('the sentence a rule prints carries the amount, the citation and the date', () => {
    for (const p of PENALTIES) {
      const phrase = penaltyPhrase(p)
      assert.ok(phrase.includes(money(p.maxCents)), `${p.key}: the phrase drops the amount`)
      assert.ok(phrase.includes(p.citation), `${p.key}: the phrase drops the citation`)
      assert.ok(
        phrase.includes(effectiveLabel(p.effectiveOn)),
        `${p.key}: the phrase drops the effective date, which is the whole point of having one`,
      )
    }
  })

  // FAILURE PINNED: the myth, reintroduced by someone reading competitor copy.
  test('no rule anywhere says ten thousand a day', () => {
    for (const rule of allRules) {
      assert.ok(
        !/\$10,000\s*(a|per)\s*day/i.test(rule.consequence),
        `${rule.code} states the "$10,000 per day" figure, which does not exist in Appendix B`,
      )
    }
  })

  // FAILURE PINNED: a rule quoting money in prose while contributing nothing to
  // a total — the coverage gap going silent. These four are known and are
  // documented in penalties.ts; the test exists so a FIFTH cannot appear without
  // somebody deciding it should.
  test('every rule that quotes a dollar figure either carries it as data or is a known exception', () => {
    const KNOWN = new Set([
      // Different authority (49 CFR 107), no verified effective date.
      'fed.172.704.hazmat-recurrent-training',
      'fed.107.608.hazmat-registration',
      // No Appendix B cite in the prose and not in the research table.
      'fed.387.9.liability-insurance-filing',
      // App. B(g)(16), which the research pass did not check.
      'fed.390.19T.mcs150-biennial-update',
      // Both cite (a)(3), which the research records as the Part 382 line;
      // these are Part 391 and Part 396 subject matter.
      'cdl_expiry',
      'fed.396.25.brake-inspector-qualification',
      // A formula over a figure only CDTFA knows, not a fixed amount.
      'ca_ifta_quarterly_return',
    ])

    const quoting = allRules.filter((r) => /\$[\d,]+/.test(r.consequence))
    assert.ok(quoting.length >= 10, `only ${quoting.length} rules quote money — did prose change?`)

    for (const rule of quoting) {
      if (rule.penalty && rule.penalty.length > 0) continue
      assert.ok(
        KNOWN.has(rule.code),
        `${rule.code} quotes a dollar figure in prose and carries no penalty data. Either ` +
          'encode it in penalties.ts, or add it to this list with the reason it cannot be.',
      )
    }
  })

  // FAILURE PINNED: a rule carrying an amount that is not one of the four.
  // Every `penalty` entry has to be an object from penalties.ts, not a literal
  // typed inline, or the single source stops being single.
  test('every penalty on a rule is one of the defined amounts', () => {
    const known = new Set(PENALTIES.map((p) => p.key))
    let attached = 0
    for (const rule of allRules) {
      for (const p of rule.penalty ?? []) {
        attached++
        assert.ok(known.has(p.key), `${rule.code} carries an amount '${p.key}' nobody defined`)
      }
    }
    assert.ok(attached >= 15, `only ${attached} rules carry an amount — the wiring has come loose`)
  })
})

// ---------------------------------------------------- the short form, in a row

describe('the amount alone', () => {
  // FAILURE PINNED: the short form and the full sentence quoting different
  // money. They are two renderings of one figure and the table is where an
  // owner reads the short one, so a divergence here is a divergence he sees.
  test('the short form carries the same figures as the sentence', () => {
    for (const p of PENALTIES) {
      const short = penaltyAmount(p)
      const full = penaltyPhrase(p)
      assert.ok(short.length > 0, `${p.key}: no short form`)
      assert.ok(full.startsWith(short), `${p.key}: "${short}" is not the head of "${full}"`)
      assert.ok(short.includes(money(p.maxCents)), `${p.key}: the short form drops the amount`)
      if (p.capCents) {
        assert.ok(short.includes(money(p.capCents)), `${p.key}: the short form drops the cap`)
      }
    }
  })

  // The short form is only allowed to drop the citation and the date, because
  // the page carrying it shows both elsewhere. It may never drop the cap: "$1,584
  // a day" without "up to $15,846" is the unbounded figure Appendix B does not
  // state, and it is the shape of the myth this catalogue refuses to repeat.
  test('a daily amount never appears without its cap', () => {
    for (const p of PENALTIES) {
      if (p.unit !== 'per_day') continue
      assert.match(
        penaltyAmount(p),
        /a day up to \$/,
        `${p.key}: a daily rate with no ceiling beside it reads as unbounded`,
      )
    }
  })
})
