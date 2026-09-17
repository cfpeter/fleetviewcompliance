/**
 * Vehicles: the anchor keys, the words, and the form parsing.
 *
 * Power units and trailers are ONE table split by `kind` (0002_fleet.sql). They
 * are separate `Subject`s to the rule engine because § 396.17(a) inspects each
 * unit of a combination separately — tractor, semitrailer, full trailer and
 * converter dolly each carry their own clock and their own paperwork. So `kind`
 * is not a label on a truck: it decides which obligations the record ever gets,
 * which is why it is the one field the add form insists on.
 *
 * Driver anchors belong in a sibling module, not here. Mixing them would make
 * "which dates does this screen collect?" a question you answer by reading a
 * filter instead of reading a list.
 */

export type VehicleKind = 'power_unit' | 'trailer'
export type VehicleStatus = 'active' | 'out_of_service' | 'sold' | 'inactive'

/**
 * The columns the vehicles screens read. Written out rather than `any`, because
 * `select('*')` off an untyped client hands back `any` and a typo in a column
 * name then renders as `undefined` — a blank cell that looks like missing data
 * instead of a bug.
 */
export interface VehicleRow {
  id: string
  kind: VehicleKind
  unit_number: string | null
  vin: string | null
  make: string | null
  model: string | null
  model_year: number | null
  /** NULL means UNKNOWN, never exempt. See `gvwrReading` below. */
  gvwr_lbs: number | null
  plate: string | null
  plate_state: string | null
  status: VehicleStatus
  notes: string | null
}

// ---------------------------------------------------------------------------
// Anchor keys
// ---------------------------------------------------------------------------
//
// These strings are written into compliance_records.anchor_key and read back
// out by the rule engine as `ctx.anchors[key]`. A typo is not a crash: the rule
// simply never finds its date and reports `missing_data` forever, which on the
// dashboard reads as "we need a date from you" about a date the owner already
// typed. That failure is silent and permanent, so nothing below may be typed
// inline at a call site — import the constant.
//
// Each one is copied from the `anchor` on a power_unit- or trailer-subject rule
// in src/lib/rules/. tests/vehicle-anchors.test.ts fails if the two drift.

/** § 396.17 periodic inspection. The only anchor a TRAILER also owns. */
export const PERIODIC_INSPECTION_DATE = 'periodic_inspection_date'

/** Month this power unit first ran on public highways — Form 2290's clock. */
export const HVUT_FIRST_USE_DATE = 'hvut_first_use_date'

/** First CARB Clean Truck Check deadline of a compliance year that has passed. */
export const CARB_CTC_FIRST_DEADLINE = 'carb_ctc_first_deadline'

/** The purchase or sale that starts the 30-day CTC-VIS listing clock. */
export const CTC_VIS_REPORTABLE_EVENT = 'ctc_vis_reportable_event'

/** Last systematic inspection under the CHP BIT 90-day cycle. */
export const BIT_LAST_INSPECTION = 'bit_last_inspection'

/** Last CVRA commercial registration issue or renewal. */
export const CVRA_LAST_REGISTERED = 'cvra_last_registered'

export interface VehicleAnchor {
  key: string
  jurisdiction: 'federal' | 'CA'
  label: string
  /**
   * The sentence under the field.
   *
   * Every one of these names an event that has ALREADY HAPPENED, and says so.
   * compute.ts evaluates an anniversary as anchor + interval and then walks
   * forward until it passes today, so a FUTURE date — "my registration expires
   * in November" — makes it skip that November and answer with the next one.
   * A form that invites the next date instead of the last one is how that
   * happens, so the wording here is load-bearing, not decoration.
   */
  help: string
  /** Which kinds own this date. */
  kinds: readonly VehicleKind[]
  /** The obligations this date drives, in the owner's words. */
  drives: string
  /**
   * What GVWR does to the rules behind this date — present only where weight is
   * part of the test.
   *
   * Deliberately a sentence and not a number. A threshold in a variable invites
   * a call site to compare it against `gvwr_lbs` and render "not applicable"
   * when the column is NULL, and NULL here means UNKNOWN. Every one of these
   * sentences is written so that not knowing the weight leaves the rule ON.
   */
  weightNote?: string
}

/**
 * Every anchor a vehicle owns, in the order the screen asks for them: federal
 * first because it reaches every carrier, then California.
 */
export const VEHICLE_ANCHORS: readonly VehicleAnchor[] = [
  {
    key: PERIODIC_INSPECTION_DATE,
    jurisdiction: 'federal',
    label: 'Last annual DOT inspection',
    help:
      'The date of the last PASSING § 396.17 inspection on this unit — not when the next one ' +
      'is due. Each unit of a combination has its own, so a tractor and its trailer are two ' +
      'dates, not one.',
    kinds: ['power_unit', 'trailer'],
    drives: 'The annual DOT inspection, and the 14 months you have to keep the report.',
    weightNote:
      'Applies at 10,001 lb GVWR and above, and to a placarded hazmat load at any weight.',
  },
  {
    key: HVUT_FIRST_USE_DATE,
    jurisdiction: 'federal',
    label: 'First used on public highways',
    help:
      'Any date inside the month this unit first ran on public roads. Form 2290 is counted ' +
      'from that month, which is why a truck bought in March has its own deadline rather than ' +
      "sharing the fleet's.",
    kinds: ['power_unit'],
    drives: 'Form 2290 heavy vehicle use tax, and the stamped Schedule 1 the DMV asks for.',
    weightNote:
      'A GVWR of 55,000 lb and above puts a unit in for certain. A lighter GVWR never rules ' +
      'one out: the IRS threshold is taxable gross weight, which includes the trailer and the ' +
      'load.',
  },
  {
    key: CARB_CTC_FIRST_DEADLINE,
    jurisdiction: 'CA',
    label: 'Clean Truck Check — first deadline of the compliance year',
    help:
      'The first CTC deadline of a compliance year that has ALREADY passed: your DMV ' +
      'registration month, or, on out-of-state plates, the month CARB derives from the VIN. ' +
      'Not the next one — we step forward from this.',
    kinds: ['power_unit'],
    drives: 'The semi-annual CTC emissions test and the annual per-vehicle compliance fee.',
    weightNote: 'Applies above 14,000 lb GVWR to anything that is not gasoline-powered.',
  },
  {
    key: CTC_VIS_REPORTABLE_EVENT,
    jurisdiction: 'CA',
    label: 'Bought or sold this vehicle on',
    help:
      'The date of the purchase or sale that has to show up in your CTC-VIS listing. The ' +
      '30-day clock runs from the deal, not from the calendar. Leave it blank if this unit has ' +
      'not changed hands — a fleet that has bought and sold nothing owes nothing here.',
    kinds: ['power_unit'],
    drives: 'Keeping the CTC-VIS vehicle listing current within 30 days.',
    weightNote: 'Applies above 14,000 lb GVWR to anything that is not gasoline-powered.',
  },
  {
    key: BIT_LAST_INSPECTION,
    jurisdiction: 'CA',
    label: 'Last 90-day BIT inspection',
    help:
      'The date you last inspected this unit under your own BIT cycle. This is your ' +
      'inspection, not a CHP visit to the terminal — CHP picks terminals from performance ' +
      'data and there is no cycle to predict for that.',
    kinds: ['power_unit'],
    drives: 'The 90-day BIT vehicle inspection cycle, and your terminal rating.',
    weightNote:
      'The 90-day cycle is certain at 26,001 lb and above. Under that is NOT a safe exemption ' +
      'to claim — CVC 34500 also reaches lighter trucks pulling trailers and placarded hazmat.',
  },
  {
    key: CVRA_LAST_REGISTERED,
    jurisdiction: 'CA',
    label: 'Last CVRA registration renewal',
    help:
      'The date registration was last issued or renewed for this unit — not the date on the ' +
      'card saying when it expires.',
    kinds: ['power_unit'],
    drives: 'CVRA registration renewal and the weight decal fee.',
    weightNote: 'CVRA fees replace ordinary weight fees at 10,001 lb GVW/CGW and above.',
  },
]

export function anchorsForKind(kind: VehicleKind): readonly VehicleAnchor[] {
  return VEHICLE_ANCHORS.filter((a) => a.kinds.includes(kind))
}

export function anchorByKey(key: string): VehicleAnchor | undefined {
  return VEHICLE_ANCHORS.find((a) => a.key === key)
}

// ---------------------------------------------------------------------------
// Words and colours
// ---------------------------------------------------------------------------

export const VEHICLE_KINDS: readonly { value: VehicleKind; label: string; hint: string }[] = [
  {
    value: 'power_unit',
    label: 'Power unit',
    hint: 'Tractor, straight truck, bobtail — anything with an engine.',
  },
  {
    value: 'trailer',
    label: 'Trailer',
    hint: 'Semitrailer, full trailer or converter dolly.',
  },
]

export function kindLabel(kind: VehicleKind): string {
  return kind === 'trailer' ? 'Trailer' : 'Power unit'
}

export const VEHICLE_STATUSES: readonly { value: VehicleStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'out_of_service', label: 'Out of service' },
  { value: 'sold', label: 'Sold' },
  { value: 'inactive', label: 'Inactive' },
]

export function statusLabel(status: VehicleStatus): string {
  return VEHICLE_STATUSES.find((s) => s.value === status)?.label ?? status
}

/** Colours only; the caller supplies the pill shape. Matches docs/stack.md. */
export function statusPillClass(status: VehicleStatus): string {
  switch (status) {
    case 'active':
      return 'bg-emerald-100 text-emerald-800'
    case 'out_of_service':
      return 'bg-red-100 text-red-700'
    case 'sold':
      return 'bg-blue-100 text-blue-800'
    default:
      return 'bg-ink-100 text-ink-500'
  }
}

/**
 * What to call a unit. Matches the label src/lib/deadlines.ts hands the engine,
 * so a row on the dashboard and the same row on this list read the same — two
 * different names for one truck is how an owner concludes there are two trucks.
 */
export function vehicleLabel(v: Pick<VehicleRow, 'unit_number' | 'vin'>): string {
  return v.unit_number?.trim() || v.vin?.trim() || 'Unnumbered unit'
}

/**
 * How to render a GVWR, and the single most important function in this file.
 *
 * NULL is UNKNOWN, not exempt: the rule engine treats an unknown-weight truck as
 * fully regulated, because one needless reminder costs a minute and one missed
 * inspection costs the truck. So the empty case returns the word "Unknown" and
 * an amber class — never an em-dash, never "n/a", never a blank cell. A dash in
 * a weight column reads as "this does not apply to me", which is the exact
 * opposite of what the number not being there means.
 */
export function gvwrReading(gvwr: number | null): { text: string; className: string } {
  if (gvwr === null || gvwr === undefined) {
    return { text: 'Unknown', className: 'text-amber-700' }
  }
  return { text: `${gvwr.toLocaleString('en-US')} lb`, className: '' }
}

/**
 * 'YYYY-MM-DD' as a human date.
 *
 * `timeZone: 'UTC'` is not tidiness. A date column parses to UTC midnight, and
 * formatting that in America/Los_Angeles renders the DAY BEFORE — an inspection
 * recorded on the 1st would display as the 31st, every time, for every user
 * west of Greenwich.
 */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

// ---------------------------------------------------------------------------
// Reading what the owner typed
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * Trimmed text, or NULL.
 *
 * '' and '   ' both mean "he did not say", and they must reach Postgres as NULL
 * rather than as an empty string. An empty string is a VALUE: it satisfies the
 * partial unique index on VIN, so two trucks saved with the VIN box untouched
 * would collide with each other over a VIN neither of them has.
 */
export function textOrNull(raw: FormDataEntryValue | null): string | null {
  const s = String(raw ?? '').trim()
  return s === '' ? null : s
}

/** Uppercased, or NULL. VINs and plates are read off metal and typed either way. */
export function upperOrNull(raw: FormDataEntryValue | null): string | null {
  return textOrNull(raw)?.toUpperCase() ?? null
}

/**
 * An optional whole number.
 *
 * Blank has to come back as NULL and never as 0. `Number('')` is 0 in
 * JavaScript, and a 0 in gvwr_lbs is far worse than a NULL: NULL means unknown
 * and keeps every weight-conditional rule switched on, while 0 sits under every
 * threshold in the catalogue and quietly exempts the truck from all of them.
 * That is why `min` is enforced here and why the empty check comes first.
 *
 * Commas are stripped because an owner types 80,000 and `Number('80,000')` is
 * NaN — rejecting a perfectly clear answer teaches him the form is broken.
 */
export function parseOptionalInt(
  raw: FormDataEntryValue | null,
  opts: { label: string; min: number; max: number },
): Parsed<number | null> {
  const s = String(raw ?? '')
    .trim()
    .replaceAll(',', '')
  if (s === '') return { ok: true, value: null }
  if (!/^\d+$/.test(s)) {
    return { ok: false, message: `${opts.label} should be digits only, or left blank.` }
  }
  const n = Number(s)
  if (n < opts.min || n > opts.max) {
    return {
      ok: false,
      message: `${opts.label} should be between ${opts.min.toLocaleString('en-US')} and ${opts.max.toLocaleString('en-US')}, or left blank.`,
    }
  }
  return { ok: true, value: n }
}

/**
 * A two-letter state, or NULL.
 *
 * 'CA', 'ca', 'Cali' and 'California ' are four values for one state, and every
 * one of them gets typed. Nothing breaks today — it breaks the first time
 * anything groups by plate_state, and then it breaks quietly, as a fleet that
 * appears to be registered in four places.
 */
export function parseStateCode(raw: FormDataEntryValue | null): Parsed<string | null> {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
  if (s === '') return { ok: true, value: null }
  if (!/^[A-Z]{2}$/.test(s)) {
    return { ok: false, message: 'Plate state should be the two-letter code, like CA or AZ.' }
  }
  return { ok: true, value: s }
}

// ---------------------------------------------------------------------------
// VIN
// ---------------------------------------------------------------------------
//
// The VIN is the join key for the two promises this product is sold on. CARB
// matches a Clean Truck Check record on the VIN, and a roadside or § 396.17
// inspection report is filed against it. A VIN that is wrong by one character
// is not a cosmetic defect: it is a truck whose federal and state records this
// product will never find, reported on a dashboard that looks complete.
//
// It is also the column under the `vehicles_vin_unique` partial index, which is
// what stops the same truck being added twice. That index compares STRINGS, so
// whatever the owner types has to be reduced to one spelling before it reaches
// Postgres or the guard is defeated by a space — see `normalizeVin`.

/** Characters excluded from the 17-character standard, so they can never be typed into one. */
const VIN_FORBIDDEN_LETTERS = ['I', 'O', 'Q'] as const

/** 49 CFR 565: seventeen characters on anything built for US sale since 1981. */
export const VIN_MODERN_LENGTH = 17

/**
 * The shortest string we are willing to call a VIN.
 *
 * Eight, and the number is a judgement rather than a standard — there was no
 * standard before 1981, which is the whole reason a floor is needed. Pre-1981
 * serials on equipment a small fleet still runs bottom out around here: a 1978
 * trailer or a converter dolly carries an eight-to-thirteen character serial and
 * nothing longer. Every typo the audit turned up sits far below it.
 *
 * Chosen permissive on purpose. A record refused the VIN still gets every
 * deadline it is owed — a trailer's only rule is § 396.17 and that runs off a
 * date, not a VIN — so the cost of turning away a genuine oddity is one empty
 * box, while the cost of storing a three-character stub is a field that reads as
 * answered and matches nothing, forever.
 */
export const VIN_MIN_LENGTH = 8

/**
 * One spelling of whatever was typed: trimmed, stripped of spaces and hyphens,
 * uppercased.
 *
 * THIS IS WHAT MAKES THE DUPLICATE GUARD WORK. `vehicles_vin_unique` is a
 * partial unique index on (carrier, VIN); it is a string comparison, so
 * '1FUJGLD8XLSKR1234' and '1FUJGLD8X LSKR1234' are two different trucks to
 * Postgres and the owner adds the same tractor twice with no warning. Hyphens
 * and spaces are exactly how a VIN gets typed off a door plate in chunks, so
 * they come out here rather than being argued about on the form.
 */
export function normalizeVin(raw: string): string {
  return raw.replace(/[\s-]/g, '').trim().toUpperCase()
}

/**
 * Transliteration from 49 CFR 565.15(c), as two strings read in step.
 *
 * Written this way rather than as twenty-three separate entries because the one
 * failure mode that matters is a single letter given the wrong value: the
 * checksum then disagrees with perfectly good VINs and the page nags about
 * trucks that are fine, which trains the owner to ignore it. Side by side the
 * three runs are visible at a glance — A-H is 1-8, J-N is 1-5, P and R are 7 and
 * 9, S-Z is 2-9 — and I, O and Q are simply absent. That absence IS the reason
 * the standard excludes them from a 17-character VIN.
 */
const VIN_LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ'
const VIN_LETTER_VALUES = '12345678123457923456789'

/** Positional weights, position 1 to 17. Position 9 weighs 0 because it IS the check digit. */
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]

/**
 * The check digit a 17-character VIN ought to carry at position 9, or null when
 * the string is not the shape that has one.
 *
 * Exported because the vehicle page shows it. A mismatch is a real signal —
 * position 9 is a weighted checksum over the other sixteen characters, so it
 * catches nearly every single-character slip and every transposition of two
 * adjacent ones, which is what a VIN copied by hand off a door plate actually
 * suffers from.
 */
export function vinCheckDigit(vin: string): string | null {
  const v = normalizeVin(vin)
  if (v.length !== VIN_MODERN_LENGTH) return null
  let sum = 0
  for (let i = 0; i < VIN_MODERN_LENGTH; i++) {
    const c = v[i]
    // -1 is I, O, Q or anything else with no value in the table, and it means
    // the string cannot carry a check digit at all rather than that it carries a
    // failing one. Returning null keeps those two apart for the caller.
    const at = VIN_LETTERS.indexOf(c)
    const value = c >= '0' && c <= '9' ? Number(c) : at === -1 ? -1 : Number(VIN_LETTER_VALUES[at])
    if (value < 0) return null
    sum += value * VIN_WEIGHTS[i]
  }
  const remainder = sum % 11
  return remainder === 10 ? 'X' : String(remainder)
}

/**
 * True when a stored 17-character VIN disagrees with its own check digit.
 *
 * ADVISORY, NEVER A REFUSAL, and that is the decision worth defending. A failed
 * check digit is usually a typo, but "usually" is not "always": small trailer
 * and converter-dolly builders do ship VINs that fail this arithmetic, and a
 * truck that was never built for US sale has no reason to satisfy it at all.
 * Refusing on a failed check digit would lock a real unit out of the product
 * entirely, with no override, over a rule its manufacturer broke. A false
 * refusal here costs the owner his truck; a false warning costs him ten seconds
 * at the door plate. So the page renders this beside the field and saves
 * anyway.
 *
 * False for anything that is not a 17-character VIN. A pre-1981 serial has no
 * check digit, and flagging one for failing a test that did not exist when it
 * was stamped would teach the owner to ignore the flag.
 */
export function vinCheckDigitMismatch(vin: string | null | undefined): boolean {
  const v = normalizeVin(String(vin ?? ''))
  if (v.length !== VIN_MODERN_LENGTH) return false
  const expected = vinCheckDigit(v)
  return expected !== null && expected !== v[8]
}

/**
 * A VIN as the owner typed it, normalised — or a refusal that says why.
 *
 * Blank is still blank. The VIN box is optional and stays optional: he may have
 * to walk to the door to read it, and "put in what you know" is the whole
 * posture of the add form. NULL also has to be the empty answer rather than '',
 * because the partial unique index treats '' as a VALUE and two trucks saved
 * with the box untouched would collide over a VIN neither of them has.
 *
 * WHAT IT REFUSES, AND WHY EACH ONE:
 *
 * Anything but letters and digits. Punctuation left after the hyphens and
 * spaces come out is a paste of something that was not a VIN.
 *
 * Longer than 17. No VIN in any era has been, so this is a doubled paste or two
 * fields run together — and it would be truncated or rejected by Postgres later
 * with a message about a column.
 *
 * Shorter than eight. See VIN_MIN_LENGTH: below that it is a partial entry, and
 * a partial VIN is worse than an empty one because it looks answered and will
 * never match a Clean Truck Check or inspection record.
 *
 * I, O or Q in a 17-character VIN. The standard left those three letters out so
 * they could never be confused with 1 and 0, which means a manufacturer cannot
 * have stamped one — at seventeen characters, an I was typed by a person.
 * Below seventeen the rule is deliberately NOT applied: a 1978 trailer's serial
 * predates the standard and may legitimately contain an O, and refusing it
 * would be enforcing a rule against the one case short VINs exist for.
 */
export function parseVin(raw: FormDataEntryValue | string | null): Parsed<string | null> {
  const vin = normalizeVin(String(raw ?? ''))
  if (vin === '') return { ok: true, value: null }

  if (!/^[A-Z0-9]+$/.test(vin)) {
    return {
      ok: false,
      message: 'A VIN is letters and digits only. Leave it blank if you do not have it with you.',
    }
  }

  if (vin.length > VIN_MODERN_LENGTH) {
    return {
      ok: false,
      message: `That VIN is ${vin.length} characters. No VIN has ever been longer than ${VIN_MODERN_LENGTH}. Check that it was not pasted twice.`,
    }
  }

  if (vin.length < VIN_MIN_LENGTH) {
    return {
      ok: false,
      message: `That VIN is only ${vin.length} character${vin.length === 1 ? '' : 's'}. A VIN is ${VIN_MODERN_LENGTH} characters on anything built since 1981. Only much older units have shorter ones. Half a VIN is worse than none: it looks complete, and it will never match your Clean Truck Check or your inspection report.`,
    }
  }

  if (vin.length === VIN_MODERN_LENGTH) {
    const found = VIN_FORBIDDEN_LETTERS.filter((c) => vin.includes(c))
    if (found.length > 0) {
      return {
        ok: false,
        message: `A 17-character VIN never contains the letter ${found.join(' or ')}. Those letters were left out of the standard so nobody would confuse them with 1 and 0. Check the door plate.`,
      }
    }
  }

  return { ok: true, value: vin }
}

/**
 * A VIN on an EDIT form: the rules above, except that a value the owner did not
 * touch is let through exactly as it is already stored.
 *
 * WHY THIS EXISTS. `parseVin` arrived after the rows did. Two of the five VINs
 * in the dev database fail it — a three-character stub, and a seventeen-character
 * string with an I in it — and with the strict parser on the edit page those two
 * trucks could not be SAVED AT ALL. Not the VIN box: the whole record. An owner
 * correcting a BIT inspection date was turned away over a field he never put a
 * cursor in, told about a VIN he was not editing, with no way through short of
 * inventing one. A rule written today must not take yesterday's record hostage.
 *
 * So the question this asks is not "is that a good VIN" but "did he CHANGE it".
 * What he typed gets the full rules, because typing is the keystroke where a
 * wrong character enters the system and becomes a truck CARB never finds. What
 * he left alone gets out of his way.
 *
 * BYTE FOR BYTE, and this is the half to be careful with. The stored string goes
 * back untouched: not uppercased, not stripped of spaces, not even trimmed.
 * Re-normalising a value nobody edited is a silent rewrite of the owner's data
 * on a save that was about something else — and because `vehicles_vin_unique`
 * compares STRINGS, it would also change which rows that index thinks are the
 * same truck, quietly, as a side effect of a date entry.
 *
 * `stored` must be WHAT THE FORM DISPLAYED. On the vehicle page that is the raw
 * `vin` column — the input is `value={vehicle.vin ?? ''}` with no formatting
 * pass, so an untouched box posts those exact bytes back. If that input ever
 * grows a formatter, this argument has to follow it: comparing against the raw
 * column then reads every untouched field as edited and the lockout returns.
 */
export function parseVinEdit(
  raw: FormDataEntryValue | string | null,
  stored: string | null | undefined,
): Parsed<string | null> {
  const submitted = String(raw ?? '')
  const parsed = parseVin(submitted)

  // Blank and anything that parses are already answered above: blank is NULL —
  // the box is optional and stays optional, because "put in what you know" and a
  // VIN can follow the paperwork — and a good VIN is reduced to the one spelling
  // the duplicate guard needs. Only a REFUSAL is this function's business.
  if (parsed.ok) return parsed

  // Trimmed on both sides, and nothing else. A text input posts its value with
  // surrounding whitespace intact, so calling ' 234' a different answer from
  // '234' would refuse a field nobody touched — the exact bug this is here to
  // fix. Anything beyond the trim would start grandfathering values that do
  // genuinely differ from what he was shown, which is how a typed-in typo gets
  // in wearing the old value's clothes.
  if (typeof stored === 'string' && submitted.trim() === stored.trim()) {
    return { ok: true, value: stored }
  }

  // Changed, and still not a VIN. A person typed this, so he gets exactly the
  // sentence the add form would have given him.
  return parsed
}

/**
 * Today as 'YYYY-MM-DD', in UTC.
 *
 * Used as the ceiling for an anchor date. UTC runs AHEAD of California, so late
 * in the day this accepts a date up to one day in the future rather than
 * rejecting one the owner is entering today. Wrong in the harmless direction:
 * refusing a date that is genuinely today would look like a broken form.
 */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/**
 * A date the owner typed into an anchor field.
 *
 * Refuses FUTURE dates, and that refusal is the whole point. Every anchor names
 * an event that has already happened, and compute.ts walks forward from the
 * anchor until it passes today — so a date in the future makes it step past the
 * cycle the owner was trying to tell us about and answer with the one after,
 * silently, in the single direction this product must never be wrong in. An
 * owner reading "when was your last inspection" and typing the date on the
 * sticker (which is the NEXT one) is the most likely way that happens.
 */
export function parseAnchorDate(
  raw: FormDataEntryValue | null,
  label: string,
  today: string = todayIso(),
): Parsed<string | null> {
  const s = String(raw ?? '').trim()
  if (s === '') return { ok: true, value: null }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { ok: false, message: `${label}: that is not a date we can read.` }
  }
  if (s > today) {
    return {
      ok: false,
      message: `${label} is in the future. This field wants the last time it happened, not the next time it is due.`,
    }
  }
  if (s < '1900-01-01') {
    return { ok: false, message: `${label}: that year looks like a typo.` }
  }
  return { ok: true, value: s }
}

/**
 * Make a search term safe to drop into a PostgREST `or=` filter.
 *
 * That filter is a comma-separated string parsed as SYNTAX, so a comma or a
 * parenthesis in the search box does not fail to match — it produces a 400 and
 * an empty page. `%` and `_` are LIKE wildcards, so searching for `10_1` would
 * match `1001`, and `*` is PostgREST's own wildcard. None of these characters
 * appear in a VIN or a unit number, so stripping them costs nothing.
 */
export function likeSafe(raw: string): string {
  return raw.replace(/[,()"\\%_*]/g, ' ').trim()
}

/**
 * Sort units the way a yard does.
 *
 * Plain text ordering puts unit 10 between unit 1 and unit 2, which makes a
 * 30-truck list look shuffled. `numeric` reads the digits inside the string, so
 * 2 comes before 10 and 'T-9' before 'T-10'.
 */
export function byUnitNumber(a: VehicleRow, b: VehicleRow): number {
  return vehicleLabel(a).localeCompare(vehicleLabel(b), 'en', { numeric: true, sensitivity: 'base' })
}
