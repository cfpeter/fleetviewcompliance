/**
 * The brand and the four status colours, held apart by measurement.
 *
 * The brand is Emerald Ink (#064E3B) on Champagne (#F8E7C9). The product's
 * whole visual language is four fixed status colours — red is overdue, amber is
 * due inside 45 days, green is on track, grey is a date we do not have — and a
 * brand that is itself a dark green sits one careless token away from a Save
 * button that reads as "everything is fine". So this file pins three things:
 *
 *   1. THE NUMBERS. Every text/tint pair the rebrand introduced is measured
 *      here against the app's floors: 4.5:1 for text on white, 7:1 for text on
 *      a tint, 3:1 for the focus ring on every surface it can land on.
 *
 *   2. THE SEPARATION. Two dark greens can never be told apart by contrast
 *      ratio under a 7:1 floor, so what keeps the status green away from Ink is
 *      hue and chroma, and what keeps the warning tint away from Champagne is
 *      chroma. Both are measured in OKLCH and asserted.
 *
 *   3. THE RULE. No status element uses a brand token and no chrome element
 *      uses a status token — in global.css, in the chart tone tables, in the
 *      email palette, and in the two layouts. Grep-able, and grepped.
 *
 * The maths is inlined rather than imported so the test cannot drift from the
 * stylesheet through a helper somebody edits for another reason.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { RING_TONES } from '../src/lib/charts/dq-rings.ts'
import { CHECK_TONES } from '../src/lib/charts/driver-status.ts'
import { DONUT_STROKE } from '../src/lib/charts/health.ts'
import { TONES as CHART_TONES } from '../src/lib/charts/tones.ts'
import { TONES as EMAIL_TONES, PALETTE } from '../src/lib/notify/email-layout.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

// --- colour arithmetic -------------------------------------------------------

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  assert.match(h, /^[0-9a-f]{6}$/i, `not a six-digit hex colour: ${hex}`)
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map(lin)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio, to two decimals like the comments in global.css. */
function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

/** OKLCH: perceptual lightness, chroma and hue, for the separation tests. */
function oklch(hex: string): { L: number; C: number; H: number } {
  const [r, g, b] = rgb(hex).map(lin)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  let H = (Math.atan2(B, A) * 180) / Math.PI
  if (H < 0) H += 360
  return { L, C: Math.hypot(A, B), H }
}

const hueGap = (a: string, b: string) => {
  const d = Math.abs(oklch(a).H - oklch(b).H)
  return Math.min(d, 360 - d)
}

// --- the tokens, read from the stylesheet itself -----------------------------

const css = read('../src/styles/global.css')
const themeBlock = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1]
assert.ok(themeBlock, 'global.css has no @theme block')

const token: Record<string, string> = {}
for (const m of themeBlock.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
  token[m[1]] = m[2].toLowerCase()
}
const t = (name: string): string => {
  const v = token[name]
  assert.ok(v, `no --color-${name} in @theme`)
  return v
}
const WHITE = '#ffffff'

/** The first `{ ... }` body that follows `.name` used as a whole selector. */
function ruleBody(name: string): string {
  const re = new RegExp(`\\.${name.replace(/-/g, '\\-')}(?:[,:\\s][^{]*)?\\{([^}]*)\\}`)
  const m = re.exec(css)
  assert.ok(m, `global.css has no .${name} rule`)
  return m[1]
}

const STATUS_TOKEN = /\b(emerald|amber|red|blue|sky|green|yellow|orange)-\d{2,3}\b/
const BRAND_TOKEN = /\b(brand-\d{3}|champagne(?:-\d{2,3})?)\b/

// ---------------------------------------------------------------------------
// The owner's two colours are the tokens, exactly
// ---------------------------------------------------------------------------

test('Emerald Ink is brand-700 and Champagne is the surface token', () => {
  assert.equal(t('brand-700'), '#064e3b')
  assert.equal(t('champagne'), '#f8e7c9')
  // The other brand steps are the same hue as Ink, so they read as one family.
  for (const step of ['brand-500', 'brand-600', 'brand-800']) {
    assert.ok(hueGap(t(step), t('brand-700')) <= 6, `${step} has drifted off Ink's hue`)
  }
  assert.ok(hueGap(t('champagne-50'), t('champagne')) <= 6, 'champagne-50 is not Champagne')
  // The email carries copies. Same numbers, or the login email and the site
  // stop looking like one company.
  assert.equal(PALETTE.brand500, t('brand-500'))
  assert.equal(PALETTE.brand600, t('brand-600'))
  assert.equal(PALETTE.brand700, t('brand-700'))
  assert.equal(PALETTE.brand800, t('brand-800'))
  assert.equal(PALETTE.champagne, t('champagne'))
})

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

test('the focus ring is at least 3:1 on every surface a control can sit on', () => {
  assert.match(css, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--color-brand-500\)/)
  for (const surface of ['white', 'ink-50', 'ink-100', 'champagne', 'champagne-50']) {
    const bg = surface === 'white' ? WHITE : t(surface)
    const c = contrast(t('brand-500'), bg)
    assert.ok(c >= 3, `brand-500 ring on ${surface} is ${c}:1`)
  }
})

test('every brand text and button pair clears the floor', () => {
  const floor = (fg: string, bg: string, min: number, why: string) => {
    const c = contrast(fg, bg)
    assert.ok(c >= min, `${why}: ${c}:1, floor ${min}:1`)
  }
  // Text on white: 4.5:1.
  floor(t('brand-600'), WHITE, 4.5, '.link, brand-600 on white')
  floor(t('brand-700'), WHITE, 4.5, 'brand-700 on white')
  // Text on a tint: ink-700-equivalent, and ink-700 on ink-100 is 8.72:1.
  // 7:1 is the AAA line every tinted pair in the product is held to.
  floor(t('brand-700'), t('champagne'), 7, '.is-current, Ink on Champagne')
  floor(t('brand-700'), t('champagne-50'), 7, 'hint boxes, Ink on champagne-50')
  floor(t('ink-700'), t('champagne'), 7, 'ink-700 on Champagne')
  floor(t('ink-700'), t('champagne-50'), 7, 'ink-700 on champagne-50')
  // White on a filled button, and on the brand-500 dot.
  floor(WHITE, t('brand-700'), 4.5, '.btn-primary, white on Ink')
  floor(WHITE, t('brand-800'), 4.5, '.btn-primary pressed, white on brand-800')
  floor(WHITE, t('brand-500'), 4.5, 'white on brand-500')
  // ink-500 is NOT a text colour on Champagne, and the pages say so.
  assert.ok(contrast(t('ink-500'), t('champagne')) < 4.5)
})

test('every status text and tint pair clears the floor', () => {
  const floor = (fg: string, bg: string, min: number, why: string) => {
    const c = contrast(fg, bg)
    assert.ok(c >= min, `${why}: ${c}:1, floor ${min}:1`)
  }
  floor(t('emerald-800'), t('emerald-100'), 7, '.badge-success')
  floor(t('emerald-800'), t('emerald-50'), 7, 'success panel')
  floor(t('emerald-900'), t('emerald-100'), 7, 'success heading on tint')
  floor(t('emerald-700'), WHITE, 4.5, 'emerald-700 text on white')
  floor(t('emerald-800'), WHITE, 4.5, 'emerald-800 text on white')
  floor(t('amber-800'), t('amber-100'), 7, '.badge-warning')
  floor(t('amber-900'), t('amber-100'), 7, 'warning heading on tint')
  floor(t('amber-900'), t('amber-50'), 7, 'warning panel')
  floor(t('amber-800'), t('amber-50'), 7, 'warning small print on panel')
  floor(t('amber-700'), WHITE, 4.5, 'amber-700 text on white')
  floor(t('amber-800'), WHITE, 4.5, 'amber-800 text on white')
  // The email's copies of the same pairs.
  floor(EMAIL_TONES.ontrack.ink, EMAIL_TONES.ontrack.tint, 7, 'email On track')
  floor(EMAIL_TONES.soon.ink, EMAIL_TONES.soon.tint, 7, 'email Due soon')
  floor(EMAIL_TONES.own.ink, EMAIL_TONES.own.tint, 7, 'email Your own reminders')
  assert.equal(EMAIL_TONES.ontrack.tint, t('emerald-100'))
  assert.equal(EMAIL_TONES.ontrack.ink, t('emerald-800'))
  assert.equal(EMAIL_TONES.ontrack.bar, t('emerald-700'))
  assert.equal(EMAIL_TONES.soon.tint, t('amber-100'))
  assert.equal(EMAIL_TONES.soon.ink, t('amber-800'))
  assert.equal(EMAIL_TONES.soon.bar, t('amber-700'))
})

// ---------------------------------------------------------------------------
// The separation
// ---------------------------------------------------------------------------

test('the status green is not the brand green', () => {
  // Bars, rings and swatches: a lighter, far more saturated grass green. These
  // two can be separated by luminance as well as hue, so both are asserted.
  assert.ok(contrast(t('emerald-500'), t('brand-500')) >= 1.5, 'emerald-500 vs brand-500')
  assert.ok(contrast(t('emerald-500'), t('brand-700')) >= 3, 'emerald-500 vs Ink')
  assert.ok(hueGap(t('emerald-500'), t('brand-500')) >= 15, 'emerald-500 hue')
  // Text: both are dark by necessity, so hue and chroma carry the difference.
  for (const step of ['emerald-700', 'emerald-800', 'emerald-900']) {
    assert.ok(hueGap(t(step), t('brand-700')) >= 15, `${step} sits on Ink's hue`)
    assert.ok(
      oklch(t(step)).C >= 1.4 * oklch(t('brand-700')).C,
      `${step} is as dull as Ink and will read as Ink`,
    )
  }
  // And the tint is a green, not a cream: the brand never sits on a green.
  assert.ok(hueGap(t('emerald-100'), t('champagne')) >= 40)
  assert.ok(hueGap(t('emerald-50'), t('champagne')) >= 40)
})

test('the warning tint is not Champagne', () => {
  // Two light tints cannot be separated by contrast ratio. What separates
  // these is saturation: the yellow has to be a yellow, not a second cream.
  const champagne = oklch(t('champagne'))
  for (const step of ['amber-50', 'amber-100', 'amber-200']) {
    const tint = oklch(t(step))
    assert.ok(tint.C >= 1.6 * champagne.C, `${step} is as pale as Champagne`)
    assert.ok(hueGap(t(step), t('champagne')) >= 10, `${step} sits on Champagne's hue`)
  }
})

// ---------------------------------------------------------------------------
// The rule: status never wears brand, chrome never wears status
// ---------------------------------------------------------------------------

test('no status class in global.css uses a brand token', () => {
  for (const name of [
    'badge-neutral',
    'badge-info',
    'badge-success',
    'badge-warning',
    'badge-danger',
    'error-summary',
    'field-error',
  ]) {
    const body = ruleBody(name)
    assert.doesNotMatch(body, BRAND_TOKEN, `.${name} wears the brand`)
  }
  // Info is a status. It borrowed brand-700 while the brand was blue; it may
  // not borrow it now.
  assert.match(ruleBody('badge-info'), /text-blue-\d{3}/)
})

test('no chrome class in global.css uses a status token', () => {
  for (const name of [
    'btn-primary',
    'btn-secondary',
    'btn-tertiary',
    'btn-dark',
    'link',
    'link-row',
    'link-back',
    'nav-item',
    'filter-tab',
    'is-current',
    'field-input',
    'field-affix',
    'check-row',
  ]) {
    const body = ruleBody(name)
    assert.doesNotMatch(body, STATUS_TOKEN, `.${name} wears a status colour`)
  }
  // The selected pill is Champagne under Ink, the brand's own pair.
  assert.match(ruleBody('is-current'), /bg-champagne\b/)
  assert.match(ruleBody('is-current'), /text-brand-700\b/)
  // The primary button and the marketing button are both Ink: one action colour.
  assert.match(ruleBody('btn-primary'), /bg-brand-700\b/)
  assert.match(ruleBody('btn-dark'), /bg-brand-700\b/)
})

test('the chart tone tables keep status and brand apart', () => {
  const statusTones = ['overdue', 'soon', 'good', 'neutral'] as const
  for (const tone of statusTones) {
    for (const cls of Object.values(CHART_TONES[tone])) {
      assert.doesNotMatch(cls, BRAND_TOKEN, `tones.ts ${tone} wears the brand: ${cls}`)
    }
    assert.doesNotMatch(DONUT_STROKE[tone], BRAND_TOKEN, `DONUT_STROKE ${tone}`)
  }
  for (const cls of Object.values(CHART_TONES.brand)) {
    assert.doesNotMatch(cls, STATUS_TOKEN, `tones.ts brand wears a status colour: ${cls}`)
  }
  assert.doesNotMatch(DONUT_STROKE.brand, STATUS_TOKEN)
  for (const [tone, style] of Object.entries(RING_TONES)) {
    for (const cls of Object.values(style)) {
      assert.doesNotMatch(cls, BRAND_TOKEN, `RING_TONES ${tone}: ${cls}`)
    }
  }
  for (const [tone, style] of Object.entries(CHECK_TONES)) {
    for (const cls of Object.values(style)) {
      assert.doesNotMatch(cls, BRAND_TOKEN, `CHECK_TONES ${tone}: ${cls}`)
    }
  }
  // The green the charts draw is the retuned one, not Tailwind's emerald.
  assert.equal(CHART_TONES.good.bar, 'bg-emerald-500')
  assert.equal(RING_TONES.ok.stroke, 'stroke-emerald-500')
})

test('the email keeps status and brand apart', () => {
  const brand: string[] = [
    PALETTE.brand500,
    PALETTE.brand600,
    PALETTE.brand700,
    PALETTE.brand800,
    PALETTE.champagne,
  ]
  for (const tone of ['overdue', 'nodate', 'soon', 'ontrack'] as const) {
    for (const hex of [EMAIL_TONES[tone].tint, EMAIL_TONES[tone].ink, EMAIL_TONES[tone].bar]) {
      assert.ok(!brand.includes(hex), `email ${tone} wears the brand: ${hex}`)
    }
  }
  // "Your own reminders" is the one group that IS the brand talking.
  assert.equal(EMAIL_TONES.own.tint, PALETTE.champagne)
  assert.equal(EMAIL_TONES.own.ink, PALETTE.brand700)
  assert.equal(EMAIL_TONES.own.bar, PALETTE.brand500)
})

test('the two layouts carry no status token in their chrome', () => {
  for (const rel of ['../src/layouts/App.astro', '../src/layouts/Public.astro']) {
    const source = read(rel)
    const hit =
      /\b(?:bg|text|border|ring|stroke|fill)-(?:emerald|amber|red|blue|sky|green|yellow|orange)-\d{2,3}\b/.exec(
        source,
      )
    assert.equal(hit, null, `${rel} wears a status colour: ${hit?.[0]}`)
  }
})
