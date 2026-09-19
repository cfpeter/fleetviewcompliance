/**
 * The chart palette.
 *
 * Same vocabulary as `standingPill` in src/lib/rules/index.ts, and for the same
 * reason: red already means overdue everywhere in this app, so a chart that
 * reaches for red to mean "the biggest bar" teaches the owner to distrust the
 * colour he has learned to trust. Charts borrow meaning, they do not invent it.
 *
 * Two rules the components enforce:
 *
 * 1. Colour is never the only carrier. Every tone ships a `mark` — a short
 *    word or symbol printed in the label — because roughly one man in twelve
 *    cannot separate the red bar from the amber one, and this product is sold
 *    almost entirely to men, in a yard, in the sun.
 *
 * 2. `unknown` is not a colour, it is an absence, and it renders as a hatched
 *    outline rather than a filled bar. A grey bar still looks like a
 *    measurement; the whole point is that it is not one.
 *
 * The `emerald-*` classes are not Tailwind's emerald: src/styles/global.css
 * pins them to a grass green, because the brand (Emerald Ink, brand-700) is a
 * dark blue-green and Tailwind's emerald-800 measured 1.28:1 against it. The
 * `good` bar is emerald-500, 1.93:1 against the `brand` bar and on a hue 22°
 * away from it. `brand` is the only tone that may use a brand token, and the
 * four status tones may not — tests/brand-tokens.test.ts holds both.
 */
export type Tone = 'brand' | 'overdue' | 'soon' | 'good' | 'neutral'

export interface ToneStyle {
  /** The filled bar. */
  bar: string
  /** A faint version, for the track behind the bar. */
  track: string
  /** Text that has to match the bar. */
  text: string
  /** Legend swatch. */
  swatch: string
}

export const TONES: Record<Tone, ToneStyle> = {
  brand: {
    bar: 'bg-brand-500',
    track: 'bg-brand-500/10',
    text: 'text-brand-700',
    swatch: 'bg-brand-500',
  },
  overdue: {
    bar: 'bg-red-500',
    track: 'bg-red-500/10',
    text: 'text-red-700',
    swatch: 'bg-red-500',
  },
  soon: {
    bar: 'bg-amber-500',
    track: 'bg-amber-500/10',
    text: 'text-amber-800',
    swatch: 'bg-amber-500',
  },
  good: {
    bar: 'bg-emerald-500',
    track: 'bg-emerald-500/10',
    text: 'text-emerald-800',
    swatch: 'bg-emerald-500',
  },
  neutral: {
    bar: 'bg-ink-300',
    track: 'bg-ink-100',
    text: 'text-ink-500',
    swatch: 'bg-ink-300',
  },
}

/**
 * The treatment for a value we do not have.
 *
 * A dashed, unfilled slot. It occupies the same footprint as a bar so the axis
 * stays honest about how many periods there are, and it is visibly not a
 * measurement so it can never be read off as one.
 */
export const UNKNOWN_SLOT = 'border border-dashed border-ink-200 bg-ink-50/50'
