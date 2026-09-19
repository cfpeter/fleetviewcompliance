/**
 * Load stops: the order, the clock, and the money that hangs off both.
 *
 * `load_stops` carries `unique (load_id, sequence)`, which is the right
 * constraint and also the one that makes every reordering operation on this
 * screen a small distributed-systems problem: PostgREST gives us one UPDATE
 * per statement and no transaction, so "shift everything down by one" is not
 * one write, it is n writes, and the obvious n writes collide with each other
 * halfway through. Every planner below exists so that no single statement we
 * send can ever land on a sequence another row still holds.
 *
 * The rest of the module is the vocabulary the stops screen needs: which free
 * hours clock a stop type reads, what a datetime-local box means in the
 * carrier's own day, and how long a truck actually sat.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Mirrors the `stop_type` enum in 0009_loads.sql, in the same order. */
export type StopType = 'pickup' | 'delivery' | 'drop' | 'hook' | 'fuel' | 'scale'

/** Mirrors the `appointment_type` enum. NULL is a third, worse state. */
export type AppointmentType = 'hard' | 'fcfs'

/**
 * The columns the stops screen reads, written out rather than `select('*')`.
 *
 * An untyped client hands back `any` for `*`, and a mistyped column then
 * renders as `undefined` — a blank field that reads as "the office never
 * entered it" instead of as the bug it is. On this screen a blank appointment
 * window is a load nobody chases.
 */
export interface StopRow {
  id: string
  sequence: number
  stop_type: StopType
  company_name: string | null
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
  contact_name: string | null
  phone: string | null
  appointment_type: AppointmentType | null
  window_start: string | null
  window_end: string | null
  arrived_at: string | null
  departed_at: string | null
  reference_numbers: string | null
  instructions: string | null
  lumper_required: boolean
}

/** The detention terms off the rate confirmation, as stored on the load. */
export interface DetentionTerms {
  free_hours_pickup: number | null
  free_hours_delivery: number | null
  detention_rate_cents: number | null
  detention_requires_preapproval: boolean | null
}

/** The minimum a row needs for the sequence planners. */
export interface Sequenced {
  id: string
  sequence: number
}

/** One statement: set this stop's sequence to this number. Order matters. */
export interface SequenceWrite {
  id: string
  sequence: number
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Stop types, with the free-hours clock each one reads.
 *
 * `clock` is the load-bearing column. Detention is owed against the shipper's
 * free time or the consignee's, and the load stores exactly two numbers for
 * six stop types, so something has to map one to the other. A *hook* is picking
 * a loaded trailer up, so it burns the pickup clock; a *drop* is leaving the
 * freight, so it burns the delivery clock. Fuel and scale burn neither — that
 * time is the carrier's own and no broker ever agreed to pay for it. Billing a
 * scale stop as detention is the fastest way to have a whole detention claim
 * thrown out.
 */
export const STOP_TYPES = [
  { value: 'pickup', label: 'Pickup', clock: 'pickup' },
  { value: 'delivery', label: 'Delivery', clock: 'delivery' },
  { value: 'drop', label: 'Drop trailer', clock: 'delivery' },
  { value: 'hook', label: 'Hook trailer', clock: 'pickup' },
  { value: 'fuel', label: 'Fuel', clock: null },
  { value: 'scale', label: 'Scale', clock: null },
] as const satisfies readonly {
  value: StopType
  label: string
  clock: 'pickup' | 'delivery' | null
}[]

export const APPOINTMENT_TYPES = [
  { value: 'hard', label: 'Hard appointment' },
  { value: 'fcfs', label: 'First come, first served' },
] as const satisfies readonly { value: AppointmentType; label: string }[]

/**
 * A `<select>` posts whatever the browser sends, and a hand-crafted POST posts
 * whatever it likes. Postgres would reject a bad enum value with a message
 * naming a type, so the value is checked here and the whole save is refused
 * with a sentence about stops instead.
 */
export function isStopType(value: string): value is StopType {
  return STOP_TYPES.some((t) => t.value === value)
}

export function isAppointmentType(value: string): value is AppointmentType {
  return APPOINTMENT_TYPES.some((t) => t.value === value)
}

export function stopTypeLabel(value: StopType | string): string {
  return STOP_TYPES.find((t) => t.value === value)?.label ?? String(value)
}

/**
 * Colour by which clock the stop reads, not by which word it is.
 *
 * Two shades, not six: pickup-side stops one colour, delivery-side stops
 * another, and the stops that owe nobody anything in grey. That is the only
 * distinction a dispatcher acts on at a glance, and giving `drop` and `hook`
 * their own colours would spend attention on a difference that changes nothing.
 */
export function stopTypeBadgeClass(value: StopType | string): string {
  const clock = STOP_TYPES.find((t) => t.value === value)?.clock ?? null
  if (clock === 'pickup') return 'bg-sky-50 text-sky-700 ring-sky-600/20'
  if (clock === 'delivery') return 'bg-blue-50 text-blue-700 ring-blue-600/20'
  // ink-700, not ink-500: this sits inside `.badge`, which is 12px on a tint,
  // and ink-500 there is under the text floor the rest of the app now holds to.
  return 'bg-ink-50 text-ink-700 ring-ink-300/40'
}

/**
 * The appointment badge, and the reason this screen has one at all.
 *
 * A hard appointment missed by fifteen minutes can mean a refused load, a
 * reschedule two days out, or detention the broker will not pay. FCFS is a
 * window: arriving late costs waiting, not the load. They are not two shades of
 * the same thing, so they do not get two shades of one colour.
 *
 * NOT RECORDED IS THE LOUD ONE. Blank means nobody can tell the driver whether
 * being twenty minutes behind is an inconvenience or the end of the load — and
 * blank is the default state of every stop typed in a hurry, so it has to look
 * wrong on the list or it stays blank until it costs something.
 */
export function appointmentBadgeClass(value: AppointmentType | null | undefined): string {
  if (value === 'hard') return 'bg-amber-100 text-amber-900 ring-amber-600/30'
  if (value === 'fcfs') return 'bg-ink-100 text-ink-700 ring-ink-300/50'
  return 'bg-red-50 text-red-700 ring-red-600/20'
}

export function appointmentLabel(value: AppointmentType | null | undefined): string {
  if (value === 'hard') return 'HARD appointment'
  if (value === 'fcfs') return 'FCFS window'
  return 'No appointment type'
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Sorted by sequence. Never rely on the order PostgREST happened to return:
 * without an ORDER BY, Postgres is free to hand back the rows in whatever order
 * the heap gives them, and an updated row moves to the end of the heap — so the
 * stop somebody just edited would jump to the bottom of the run sheet.
 */
export function orderStops<T extends Sequenced>(rows: readonly T[]): T[] {
  return rows.slice().sort((a, b) => a.sequence - b.sequence)
}

/**
 * The sequence for a new stop appended to the end.
 *
 * `rows.length + 1` is the tempting version and it is wrong the moment the list
 * has a gap or starts anywhere but 1 — it lands on an occupied number and the
 * insert fails on the unique constraint with a message about an index. One past
 * the largest cannot collide with anything, whatever shape the list is in.
 */
export function nextSequence(rows: readonly Sequenced[]): number {
  let max = 0
  for (const r of rows) if (r.sequence > max) max = r.sequence
  return max + 1
}

/**
 * True when the stored numbering is not exactly 1..n.
 *
 * A gap is a bug, not a style: the run sheet, the driver's "stop 3" on the
 * phone and the broker's check call all use the printed number, and once they
 * disagree the conversation stops being about freight. It is surfaced on the
 * page with a repair button rather than fixed silently on read, because a
 * screen that quietly renumbers on every render hides the write that failed.
 */
export function hasSequenceGaps(rows: readonly Sequenced[]): boolean {
  return orderStops(rows).some((row, index) => row.sequence !== index + 1)
}

/**
 * THE ONE PIECE OF REAL LOGIC ON THIS SCREEN.
 *
 * Produce the statements that renumber `rows` into `orderedIds` order as 1..n,
 * such that NO INDIVIDUAL STATEMENT can violate unique (load_id, sequence).
 *
 * Why the obvious version breaks. Moving stop 3 up is a swap with stop 2. Two
 * UPDATEs — 3→2 then 2→3 — and the first one fails, because at that instant two
 * rows would hold sequence 2. The constraint is immediate and not deferrable,
 * so it is checked at the end of each statement, and we have no transaction to
 * defer it inside anyway: every write here is its own HTTP request. Closing the
 * gap after a delete has the same shape — 4→3 collides while the old 3 is still
 * sitting there — and it only *looks* safe if you happen to issue the writes in
 * ascending order, which is a property nobody will preserve through the next
 * edit of this file.
 *
 * So: park, then set. Every row that has to move is first pushed to
 * `sequence + offset`, where offset is one past the largest sequence currently
 * in the load. That guarantees three things at once:
 *
 *   - parked numbers are above every number any row currently holds, so a park
 *     can never land on an unmoved row;
 *   - parked numbers stay distinct from each other, because they are a constant
 *     added to numbers that were already distinct;
 *   - parked numbers are above every target, because the targets are 1..n and n
 *     distinct positive integers always have a maximum of at least n.
 *
 * The cost is up to two writes per moved row on a list that is almost never
 * longer than six. The alternative — a stored procedure doing it in one
 * transaction — is the right answer at a hundred stops and the wrong one today,
 * because it moves this logic into a migration file where it cannot be tested
 * without a database.
 *
 * Rows already sitting on their target are left out entirely: a "move stop 5
 * down" on a healthy list writes four statements, not twelve.
 */
export function planResequence(
  rows: readonly Sequenced[],
  orderedIds: readonly string[],
): SequenceWrite[] {
  const current = new Map(rows.map((r) => [r.id, r.sequence]))

  // A partial list is refused rather than half-applied. If a caller leaves a
  // stop out, that stop keeps its old number while another row is renumbered
  // onto it — the exact collision this function exists to prevent, arriving
  // from the one direction the planner cannot see. Loud here beats a 409 from
  // Postgres in the middle of a four-statement renumber.
  if (orderedIds.length !== rows.length) {
    throw new Error('planResequence needs every stop of the load, in the new order')
  }
  for (const id of orderedIds) {
    if (!current.has(id)) throw new Error(`planResequence got an unknown stop id: ${id}`)
  }

  const moving = orderedIds
    .map((id, index) => ({ id, target: index + 1, from: current.get(id) as number }))
    .filter((m) => m.from !== m.target)

  if (moving.length === 0) return []

  const offset = nextSequence(rows)
  return [
    ...moving.map((m) => ({ id: m.id, sequence: m.from + offset })),
    ...moving.map((m) => ({ id: m.id, sequence: m.target })),
  ]
}

/** Renumber the list as it stands, closing any gaps. The repair button. */
export function planRenumber(rows: readonly Sequenced[]): SequenceWrite[] {
  const ordered = orderStops(rows)
  return planResequence(
    ordered,
    ordered.map((r) => r.id),
  )
}

/**
 * The writes that close the hole left by a removed stop.
 *
 * Call it with the rows as they are AFTER the delete has succeeded — the gone
 * row must not be in `rows`, or its abandoned sequence inflates the offset for
 * no reason and, worse, the planner counts a stop that no longer exists.
 */
export function planAfterRemoval(rows: readonly Sequenced[], removedId: string): SequenceWrite[] {
  return planRenumber(rows.filter((r) => r.id !== removedId))
}

/**
 * The writes that move one stop one position up or down.
 *
 * Returns [] at the ends of the list, so the buttons on the first and last rows
 * are harmless rather than hidden — a disabled-looking button that still posts
 * is worse than a button that does nothing.
 *
 * A move also renumbers everything else to 1..n as a side effect, because it
 * plans against positions rather than against the stored numbers. That is
 * deliberate: it means one click repairs a list that had drifted, instead of
 * carefully preserving the drift.
 */
export function planMove(
  rows: readonly Sequenced[],
  stopId: string,
  direction: 'up' | 'down',
): SequenceWrite[] {
  const ordered = orderStops(rows)
  const index = ordered.findIndex((r) => r.id === stopId)
  if (index === -1) return []

  const swapWith = direction === 'up' ? index - 1 : index + 1
  if (swapWith < 0 || swapWith >= ordered.length) return []

  const ids = ordered.map((r) => r.id)
  const held = ids[index]
  ids[index] = ids[swapWith]
  ids[swapWith] = held

  return planResequence(ordered, ids)
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/**
 * The carrier's own day. Copied from the drivers module for the same reason and
 * with the same expiry date: every carrier we sell to is in California and
 * `carriers.timezone` defaults to it. The first out-of-state carrier turns this
 * into a bug whose fix is to read that column, not to widen this constant.
 */
export const CARRIER_TIME_ZONE = 'America/Los_Angeles'

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** What an instant reads as on a clock hanging in `timeZone`. */
function wallClockIn(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    // hourCycle rather than hour12:false. With hour12:false some engines render
    // midnight as hour 24, and Date.UTC(y, m, d, 24) is the next day — every
    // midnight appointment silently one day late.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)

  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Belt and braces against the hour-24 engines described above.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  }
}

/** How far ahead of UTC `timeZone` was at that instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const w = wallClockIn(instant, timeZone)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - instant.getTime()
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/**
 * A `<input type="datetime-local">` value into the instant it means.
 *
 * THIS IS THE BUG THIS FUNCTION EXISTS FOR. The box posts bare wall clock —
 * "2026-09-15T14:30", no zone — and `new Date(thatString)` resolves it against
 * the *server's* local zone. On Cloudflare Workers the server's local zone is
 * UTC. So a 2:30pm appointment typed in Fontana is stored as 14:30Z, renders
 * back as 7:30am, and the detention clock reads seven hours of free time the
 * carrier never had. Appointments are the one thing on this screen that cannot
 * be off by hours, so the conversion is explicit and tested.
 *
 * The offset is applied twice on purpose. The first pass uses the offset at the
 * wrong instant (the wall clock read as if it were UTC), which is off by an
 * hour across a DST change; the second pass re-reads the offset at the instant
 * the first pass produced, which lands correctly on both sides of the change.
 * In the spring-forward hour, which does not exist on the wall clock, it settles
 * on the instant the clock jumps to — the only defensible answer available.
 */
export function localInputToIso(
  value: string | null | undefined,
  timeZone: string = CARRIER_TIME_ZONE,
): string | null {
  const raw = (value ?? '').trim()
  // Empty is NULL, never the epoch: an appointment window nobody filled in is
  // not an appointment at midnight in 1970, and Postgres rejects '' for
  // timestamptz outright, taking the rest of the form down with it.
  if (!raw) return null

  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw)
  if (!m) return null

  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  const firstPass = wall - zoneOffsetMs(new Date(wall), timeZone)
  const settled = wall - zoneOffsetMs(new Date(firstPass), timeZone)
  return new Date(settled).toISOString()
}

/** The instant back into the box's format, so an edit round-trips unchanged. */
export function isoToLocalInput(
  iso: string | null | undefined,
  timeZone: string = CARRIER_TIME_ZONE,
): string {
  if (!iso) return ''
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) return ''
  const w = wallClockIn(instant, timeZone)
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`
}

/**
 * An appointment as a dispatcher says it out loud: "Tue, Sep 15, 2:30 PM".
 *
 * The weekday is not decoration. Half the arguments about an appointment are
 * about which day it is on, and a date alone makes the reader do the lookup.
 */
export function formatStopTime(
  iso: string | null | undefined,
  timeZone: string = CARRIER_TIME_ZONE,
): string {
  if (!iso) return ''
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) return ''
  return instant.toLocaleString('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Just the clock time, for the back half of a same-day window. */
function formatClockOnly(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * The appointment window on one line.
 *
 * A same-day window collapses to "Tue, Sep 15, 8:00 AM – 3:00 PM" because
 * repeating the date is how a list of six stops stops being readable. An
 * overnight window keeps both dates, since that is exactly the case where the
 * reader would otherwise assume the wrong day.
 */
export function formatWindow(
  start: string | null | undefined,
  end: string | null | undefined,
  timeZone: string = CARRIER_TIME_ZONE,
): string {
  if (!start && !end) return ''
  if (start && !end) return formatStopTime(start, timeZone)
  if (!start && end) return `by ${formatStopTime(end, timeZone)}`

  const sameDay =
    isoToLocalInput(start, timeZone).slice(0, 10) === isoToLocalInput(end, timeZone).slice(0, 10)
  return sameDay
    ? `${formatStopTime(start, timeZone)} – ${formatClockOnly(end as string, timeZone)}`
    : `${formatStopTime(start, timeZone)} – ${formatStopTime(end, timeZone)}`
}

/** "3h 15m", "45m", "2h". Bare minutes past an hour are unreadable on a list. */
export function formatMinutes(total: number): string {
  const whole = Math.max(0, Math.round(total))
  const hours = Math.floor(whole / 60)
  const minutes = whole % 60
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

// ---------------------------------------------------------------------------
// The detention clock
// ---------------------------------------------------------------------------

/**
 * Which free-hours number this stop is measured against, or null when the stop
 * type owes nobody anything (fuel, scale) or the rate con never said.
 */
export function freeHoursFor(stopType: StopType | string, terms: DetentionTerms): number | null {
  const clock = STOP_TYPES.find((t) => t.value === stopType)?.clock ?? null
  if (clock === 'pickup') return terms.free_hours_pickup
  if (clock === 'delivery') return terms.free_hours_delivery
  return null
}

export interface StopClock {
  /** Wheels-in to wheels-out, in minutes. */
  minutes: number
  /** Departed before arrived: a typo, shown as one rather than as 0 minutes. */
  backwards: boolean
  /** Free time for this stop type, in minutes. Null when not on the rate con. */
  freeMinutes: number | null
  /** Minutes past free time. 0 when inside it, or when free time is unknown. */
  overMinutes: number
  over: boolean
  /** What the overage is worth at the rate on file. Null without a rate. */
  billableCents: number | null
}

/**
 * How long the truck sat, and whether that is now money.
 *
 * Returns null until BOTH times exist. A stop with an arrival and no departure
 * is a truck still sitting there, and the elapsed time is a number that changes
 * every minute — rendering it on a server-rendered page means showing a stale
 * number that looks live, which is worse than showing nothing. The running
 * clock is a job for the alerting side of the product, not for this list.
 */
export function stopClock(
  stop: Pick<StopRow, 'stop_type' | 'arrived_at' | 'departed_at'>,
  terms: DetentionTerms,
): StopClock | null {
  if (!stop.arrived_at || !stop.departed_at) return null

  const arrived = new Date(stop.arrived_at).getTime()
  const departed = new Date(stop.departed_at).getTime()
  if (Number.isNaN(arrived) || Number.isNaN(departed)) return null

  const rawMinutes = (departed - arrived) / 60000
  const backwards = rawMinutes < 0
  const minutes = Math.abs(rawMinutes)

  const freeHours = freeHoursFor(stop.stop_type, terms)
  const freeMinutes = freeHours === null || freeHours === undefined ? null : freeHours * 60

  // Unknown free time is NOT zero free time. Treating a missing number as zero
  // would paint every fuel stop and every load whose terms were never typed in
  // as detention, and a screen that cries detention on everything is a screen
  // nobody reads on the day it is right.
  const overMinutes =
    freeMinutes === null || backwards ? 0 : Math.max(0, Math.round(minutes - freeMinutes))

  /**
   * Whole hours only, rounded DOWN.
   *
   * Brokers settle detention in hours, and the carrier who invoices for 2.4
   * hours gets paid for 2 — after a phone call and a week. Rounding up here
   * would put a number on the screen that the invoice cannot collect, and the
   * first time that happens the office stops trusting every other number on the
   * page. Under-promising is the cheap error.
   */
  const rate = terms.detention_rate_cents
  // WHOLE HOURS, on purpose, and the test that pins it says why: 2h 24m past
  // free time at $50/h invoices as $100, and putting $120 on screen puts a
  // number there the broker will not pay. The owner who reads 1h 30m → $50 as
  // "you threw away half an hour" is not wrong either — so the screen has to
  // SAY it bills whole hours, rather than leave him to discover the rounding.
  // A per-load increment (15 or 30 minutes on some rate confirmations) is a
  // real term the load does not store yet; nothing here invents one.
  const billableCents =
    rate === null || rate === undefined ? null : Math.floor(overMinutes / 60) * rate

  return {
    minutes,
    backwards,
    freeMinutes,
    overMinutes,
    over: overMinutes > 0,
    billableCents,
  }
}

/** Integer cents as "$1,234.50". Money is never a float in this codebase. */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return ''
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

/**
 * A text box left alone posts as '', and '' in `company_name` is not the same
 * fact as "we do not have it" — it sorts as a value and reads as answered.
 * Absence is NULL. (Same reasoning, and the same function, as drivers.ts; it
 * moves into a shared module the day a third section needs it.)
 */
export function formText(form: FormData, name: string): string | null {
  const value = String(form.get(name) ?? '').trim()
  return value === '' ? null : value
}

/** An unchecked checkbox posts nothing at all, which is `false`, not NULL. */
export function formFlag(form: FormData, name: string): boolean {
  return form.get(name) !== null
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * The two-letter state on a stop address.
 *
 * Codes, not names, for the same reason the driver's licensing state is a code:
 * free text collects 'CA', 'Ca', 'Cali' and 'California' for one state, and the
 * first thing anybody wants from this column — every stop in one state, mileage
 * by state, an IFTA sanity check — reads them as four different places. A
 * separate function from the vehicles one because the sentence has to name the
 * field the dispatcher is looking at, not a plate.
 */
export function parseStopState(raw: FormDataEntryValue | null): Parsed<string | null> {
  const value = String(raw ?? '')
    .trim()
    .toUpperCase()
  if (value === '') return { ok: true, value: null }
  if (!/^[A-Z]{2}$/.test(value)) {
    return { ok: false, message: 'State should be the two-letter code, like CA or AZ.' }
  }
  return { ok: true, value }
}
