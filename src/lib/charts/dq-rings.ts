/**
 * The driver qualification ring: how much of one driver's file is on file.
 *
 * THIS FILE OWNS NO DEFINITION OF "COMPLETE".
 *
 * That definition already exists, in src/lib/proof/dqf.ts, and it is the one an
 * auditor is handed: `assembleDqf` builds the eight items of 49 CFR 391.51(b)
 * and `summarise` counts them. Everything here takes `DqfItem[]` — the binder's
 * own output — and turns counts into arc lengths. It cannot disagree with the
 * printed file, because it is not allowed to look at anything the printed file
 * did not already decide.
 *
 * That is the whole reason it is written this way. A ring reading 8/8 beside a
 * binder listing a gap is worse than no ring at all: it is a false assurance
 * printed on the exact document somebody asks for when they are checking up on
 * you. A second implementation of "complete" is how that happens, so there is
 * only one, and it lives in dqf.ts.
 *
 * The colours are borrowed, not invented — same vocabulary as `standingPill`
 * and as the badges on the binder page, because red already means overdue
 * everywhere in this app.
 */
import { type DqfItem, type ItemState, summarise } from '../proof/dqf.ts'

/**
 * Four tones and no fifth.
 *
 * red    — act now: it expired, or we hold nothing at all
 * amber  — due soon
 * green  — on file and not near its date
 * grey   — we have no date, so we cannot say anything
 *
 * GREY IS NEVER GREEN AND IS NEVER DROPPED. A driver whose medical card date
 * nobody typed must not draw a full green ring. An auditor reads an absent
 * record as a failure; so does this.
 */
export type RingTone = 'act' | 'soon' | 'ok' | 'nodate'

export interface RingToneStyle {
  /** The arc itself. */
  stroke: string
  /** Text that has to match the arc. */
  text: string
  /** Legend dot. */
  swatch: string
}

/**
 * Defined here rather than in tones.ts on purpose: a ring strokes an SVG path,
 * and every tone in tones.ts is a background utility for a rectangular bar.
 */
export const RING_TONES: Record<RingTone, RingToneStyle> = {
  act: { stroke: 'stroke-red-500', text: 'text-red-700', swatch: 'bg-red-500' },
  soon: { stroke: 'stroke-amber-500', text: 'text-amber-800', swatch: 'bg-amber-500' },
  ok: { stroke: 'stroke-emerald-500', text: 'text-emerald-800', swatch: 'bg-emerald-500' },
  nodate: { stroke: 'stroke-ink-300', text: 'text-ink-500', swatch: 'bg-ink-300' },
}

/** The faint circle behind the arcs, so the denominator is always visible. */
export const RING_TRACK = 'stroke-ink-100'

/**
 * Which tone each of the binder's five states draws in.
 *
 * These are the binder's OWN colours, item for item — see STATE_CLASS in
 * src/pages/app/drivers/[id]/file.astro. `missing` is red there because "we
 * hold nothing" needs acting on today, and `unknown` is grey because a date
 * nobody entered is an absence of evidence rather than a finding. A ring that
 * coloured them differently from the page it links to would teach the owner
 * that one of the two screens is lying, and he would be right.
 */
export const TONE_FOR_STATE: Record<ItemState, RingTone> = {
  expired: 'act',
  missing: 'act',
  expiring: 'soon',
  present: 'ok',
  unknown: 'nodate',
}

export interface RingSlice {
  tone: RingTone
  count: number
  /** Plain words. The legend prints `${count} ${label}`. */
  label: string
}

export interface DqRing {
  /** Items on file and not near a date. Exactly `summarise().present`. */
  onFile: number
  /** Exactly `summarise().expiring`. */
  dueSoon: number
  /** Exactly `summarise().attention` — expired, not held, or undated. */
  attention: number
  /** Expired or not held at all: the red arc. */
  actNow: number
  /** No date to judge by: the grey arc. */
  noDate: number
  /** The eight items of 391.51(b). */
  total: number
  /** A ring is a statement about a moment, and carries the moment. */
  observedAt: Date
  /** Draw order, worst first from twelve o'clock. Always sums to `total`. */
  slices: readonly RingSlice[]
}

/**
 * Build a ring from the binder's items.
 *
 * `onFile`, `dueSoon`, `attention` and `total` are taken straight off
 * `summarise` rather than recounted, so the ring and the printed header cannot
 * drift. Only the red/grey SPLIT of `attention` is computed here, and it is a
 * split of the same three states `gaps()` collects.
 */
export function dqRing(items: readonly DqfItem[], observedAt: Date): DqRing {
  const s = summarise(items, observedAt)
  const inTone = (tone: RingTone) => items.filter((i) => TONE_FOR_STATE[i.state] === tone).length

  const actNow = inTone('act')
  const noDate = inTone('nodate')

  return {
    onFile: s.present,
    dueSoon: s.expiring,
    attention: s.attention,
    actNow,
    noDate,
    total: s.total,
    observedAt: s.observedAt,
    slices: [
      { tone: 'act', count: actNow, label: 'to fix' },
      { tone: 'soon', count: s.expiring, label: 'due soon' },
      { tone: 'nodate', count: noDate, label: 'no date' },
      { tone: 'ok', count: s.present, label: 'on file' },
    ],
  }
}

/**
 * A radius chosen so the circumference is exactly 100.
 *
 * 2 x PI x 15.9155 = 100.0000…, which makes every dash length a percentage and
 * keeps the arithmetic readable in a test failure. The viewBox is 36 square.
 */
export const RING_RADIUS = 15.9155
export const RING_CIRCUMFERENCE = 100
export const RING_VIEWBOX = 36
export const RING_CENTRE = 18

export interface RingArc {
  tone: RingTone
  count: number
  /** Drawn length, out of `RING_CIRCUMFERENCE`. */
  dash: number
  /** The rest of the circle, left blank. */
  gap: number
  /** Negative: SVG rotates a dash pattern forward for a negative offset. */
  offset: number
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * The arcs, in draw order, abutting exactly.
 *
 * A file with no items at all returns an empty list rather than dividing by
 * zero — the component then draws the bare track, which is the honest picture
 * of a driver we know nothing about.
 *
 * There is deliberately no minimum-arc floor here, unlike `widthPercent` in
 * scale.ts. The denominator is the eight statutory items, so the smallest
 * possible arc is an eighth of the circle and cannot go sub-pixel. A floor
 * would have to steal its length from a neighbouring arc, and the sum of the
 * arcs is the only thing making the ring's arithmetic true.
 */
export function ringArcs(ring: DqRing): RingArc[] {
  if (!(ring.total > 0)) return []

  const arcs: RingArc[] = []
  let used = 0

  for (const slice of ring.slices) {
    if (slice.count <= 0) continue
    // Rounded before it is accumulated, so consecutive arcs meet on the same
    // number the previous one ended at instead of leaving a hairline seam.
    const dash = round3((slice.count / ring.total) * RING_CIRCUMFERENCE)
    arcs.push({
      tone: slice.tone,
      count: slice.count,
      dash,
      gap: round3(RING_CIRCUMFERENCE - dash),
      offset: round3(-used),
    })
    used = round3(used + dash)
  }

  return arcs
}

/** `5/8`, for the middle of a ring big enough to carry it. */
export function ringFraction(ring: DqRing): string {
  return `${ring.onFile}/${ring.total}`
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/**
 * The line beside a driver's name on the roster.
 *
 * The fraction first, then every bucket that is NOT on file. Colour carries
 * nothing here that the words do not also carry, which is the point: this is
 * read on a phone, in a yard, in the sun, by somebody who may be reading it in
 * his second language.
 */
export function rowLine(ring: DqRing): string {
  if (!(ring.total > 0)) return 'Nothing on file'

  const trouble = ring.slices
    .filter((s) => s.tone !== 'ok' && s.count > 0)
    .map((s) => `${s.count} ${s.label}`)

  const head = `${ring.onFile}/${ring.total} on file`
  return trouble.length === 0 ? head : `${head} · ${trouble.join(' · ')}`
}

/**
 * The sentence the driver's figure leads with.
 *
 * It labels the answer, not the chart. "3 items need work" is what he came for;
 * "qualification completeness" is what the chart is called, and nobody needs
 * that. It never grades the driver and never uses a word that could be read as
 * one — the file says what is held and what is not, and stops there.
 */
export function driverLine(ring: DqRing): string {
  if (!(ring.total > 0)) return 'Nothing is tracked for this driver yet.'

  if (ring.attention > 0) {
    const what = plural(ring.attention, 'item needs', 'items need')
    return `${ring.attention} of ${ring.total} ${what} work.`
  }
  if (ring.dueSoon > 0) {
    const what = plural(ring.dueSoon, 'expires', 'expire')
    return `All ${ring.total} items are on file. ${ring.dueSoon} ${what} soon.`
  }
  return `All ${ring.total} items are on file.`
}

/**
 * The sentence above the roster. The owner's example, near enough word for
 * word: "3 drivers have gaps" beats "qualification completeness".
 */
export function rosterLine(rings: readonly DqRing[]): string {
  const n = rings.length
  if (n === 0) return ''

  const withGaps = rings.filter((r) => r.attention > 0).length
  if (withGaps > 0) {
    const has = plural(withGaps, 'has a gap', 'have gaps')
    return `${withGaps} of ${n} ${plural(n, 'driver', 'drivers')} ${has} in the file.`
  }

  const soon = rings.filter((r) => r.dueSoon > 0).length
  if (soon > 0) {
    const has = plural(soon, 'has a date', 'have dates')
    return `No gaps. ${soon} of ${n} ${plural(n, 'driver', 'drivers')} ${has} coming up.`
  }

  return `No gaps in ${n === 1 ? 'this file' : `these ${n} files`}.`
}
