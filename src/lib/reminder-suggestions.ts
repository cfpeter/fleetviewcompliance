/**
 * A starter list of the things owners actually set reminders for.
 *
 * WHY THIS EXISTS, in the owner's words: "how can we have options for my
 * reminders — things he should do but are not tracked by federal rules, like
 * tyre check." An empty title box is a blank page problem: he knows he wants
 * reminders and cannot think of them standing at the screen, so he sets one and
 * never comes back.
 *
 * THE RULE THAT DECIDES WHAT IS IN HERE: nothing may be something the catalogue
 * already tracks. All 52 rules were read against it, and a test blocks 34 of
 * their names. A suggestion for the annual DOT inspection would put a second
 * row on his dashboard for a deadline we already watch — one with a citation,
 * one without — and the day the two disagree he stops believing both.
 *
 * ---------------------------------------------------------------------------
 * THREE KINDS OF INTERVAL, AND THIS IS THE WHOLE DESIGN OF THE FILE.
 *
 * The obvious split is "we know the gap" versus "he picks". That split is
 * wrong, and getting it wrong costs the owner something either way:
 *
 *   calendar — a statute or a government cycle sets it, identically for every
 *              carrier. We can ship the number and be right.
 *   contract — a fixed interval EXISTS, but only his own paperwork says what it
 *              is: the declarations page, the factoring agreement, the lease
 *              schedule. Twelve months is the common case and six-month terms
 *              are real. So we prompt and never assert.
 *   owner    — no interval exists at all, or the date is printed on a document
 *              he is holding. Suggest nothing.
 *
 * Collapsing `contract` into `owner` asks a man to invent a number he could
 * have read off a page in his drawer. Collapsing it into `calendar` asserts
 * twelve months at every carrier whose policy renews in six. Neither is a
 * rounding error: this product's one claim is that what it tells you is true.
 *
 * WHY SO MANY ROWS CARRY NO REPEAT AT ALL. `reminders_repeat_known` in
 * 0023_custom_reminders.sql permits 0, 1, 3, 6 and 12 months and nothing else,
 * so a five-year TWIC and a three-year equipment check cannot be expressed as a
 * repeat today. Those ship as a single dated reminder off the document in his
 * hand, which is honest and works now. Widening that list needs a migration.
 */

/** Where the number comes from. See the header — this is not decoration. */
export type IntervalKind = 'calendar' | 'contract' | 'owner'

/** What a suggestion can be attached to. Mirrors `ReminderSubject.kind`. */
export type SuggestionFit = 'carrier' | 'vehicle' | 'driver'

export interface ReminderSuggestion {
  /** What `?suggest=` carries. Stable: it ends up in links people bookmark. */
  key: string
  /** Prefills the title box. The words an owner says, not a category name. */
  title: string
  interval: IntervalKind
  /**
   * Months to prefill the repeat with, or 0 for none.
   *
   * A `calendar` row may carry a real number. A `contract` row may carry the
   * common one ONLY where its note tells him to check his own paperwork. An
   * `owner` row is always 0.
   */
  repeatMonths: number
  /** One line under the suggestion: what it is, and where its date comes from. */
  note: string
  /** Where it makes sense to offer it. */
  fits: readonly SuggestionFit[]
}

/**
 * The list. Deliberately short, and every row traceable to something real.
 *
 * Thirty suggestions is a catalogue nobody reads to the bottom of. Order is
 * roughly how often it comes up for a small carrier.
 */
export const REMINDER_SUGGESTIONS: readonly ReminderSuggestion[] = [
  // ------------------------------------------------------------- the company
  {
    key: 'insurance_renewal',
    title: 'Truck insurance renewal',
    interval: 'contract',
    repeatMonths: 12,
    note: 'Your policy date with your broker — NOT the FMCSA filing, which is already on your board. Most run a year, some run six months: check your declarations page. Start 60 days out.',
    fits: ['carrier'],
  },
  {
    key: 'workers_comp',
    title: 'Workers comp renewal',
    interval: 'contract',
    repeatMonths: 12,
    note: 'A different policy, a different company and a different date from your truck insurance. Check your paperwork — this is the one owners find out about when the bill lands.',
    fits: ['carrier'],
  },
  {
    key: 'business_licence',
    title: 'City business licence renewal',
    interval: 'calendar',
    repeatMonths: 12,
    note: 'Your city, not the state or federal ones — every city sets its own date, so put the one on your licence. Late filing can cost you a small-business exemption even in a year you owe nothing.',
    fits: ['carrier'],
  },
  {
    key: 'factoring_notice',
    title: 'Factoring contract — last day to give notice',
    interval: 'contract',
    repeatMonths: 12,
    note: 'Most factoring deals renew themselves unless you write to them first, often 30 to 60 days before. The date that matters is the last day to send that letter, not the renewal day. Read your agreement.',
    fits: ['carrier'],
  },
  {
    key: 'truck_payment',
    title: 'Truck payment',
    interval: 'contract',
    repeatMonths: 1,
    note: 'Monthly because that is what you signed. Change it if yours is not monthly.',
    fits: ['vehicle', 'carrier'],
  },
  {
    key: 'lease_end',
    title: 'Lease end or balloon payment',
    interval: 'contract',
    repeatMonths: 0,
    note: 'The date is on your schedule — put that in. Not the monthly payment: the day the balloon lands or the truck goes back, which takes 60 to 90 days to arrange.',
    fits: ['vehicle', 'carrier'],
  },
  {
    key: 'yard_rent',
    title: 'Yard or parking rent',
    interval: 'contract',
    repeatMonths: 1,
    note: 'Monthly by default. Change it if your lease says otherwise.',
    fits: ['carrier'],
  },
  {
    key: 'port_concession',
    title: 'Port concession or registration',
    interval: 'owner',
    repeatMonths: 0,
    note: 'Only if you pull containers. The ports set the term and it is years, not months — put the date from your own agreement, and ask the port if you are not sure.',
    fits: ['carrier'],
  },
  {
    key: 'subscriptions',
    title: 'Check the ELD and software bills',
    interval: 'owner',
    repeatMonths: 12,
    note: 'ELD, dashcams, TMS. They renew themselves and the price moves. You pick when to look — a lapsed ELD account is trucks running with no logs.',
    fits: ['carrier'],
  },
  {
    key: 'accountant',
    title: 'Send the books to the accountant',
    interval: 'owner',
    repeatMonths: 3,
    note: 'Your own rhythm — you pick it. Your tax and IFTA deadlines are tracked separately.',
    fits: ['carrier'],
  },

  // -------------------------------------------------------------- the trucks
  {
    key: 'oil_change',
    title: 'Oil and filter change',
    interval: 'owner',
    repeatMonths: 0,
    note: 'You pick the gap. It depends on the miles and the engine, so we do not guess one for you.',
    fits: ['vehicle'],
  },
  {
    key: 'tyre_check',
    title: 'Tyre check',
    interval: 'owner',
    repeatMonths: 0,
    note: 'Tread and pressure. How often is your call — it depends on the load and the miles.',
    fits: ['vehicle', 'carrier'],
  },
  {
    key: 'brake_service',
    title: 'Brake service',
    interval: 'owner',
    repeatMonths: 0,
    note: 'Your own service interval, and you pick it. This is not the annual inspection — that one is already on your board.',
    fits: ['vehicle'],
  },

  {
    key: 'grease_job',
    title: 'Grease the fifth wheel and chassis',
    interval: 'calendar',
    repeatMonths: 3,
    note: 'A time job, not a miles job — it has to be done through all four seasons. The fifth wheel makers say every 3 months; some truck makers say every month. Check your truck book.',
    fits: ['vehicle'],
  },
  {
    key: 'coolant_test',
    title: 'Test the coolant',
    interval: 'calendar',
    repeatMonths: 6,
    note: 'A test strip and five minutes — you can do it yourself. Every 6 months suits hard city work; on an easier run some engine makers say once a year. Check your engine book.',
    fits: ['vehicle'],
  },
  {
    key: 'fire_extinguisher',
    title: 'Fire extinguisher service',
    interval: 'calendar',
    repeatMonths: 12,
    note: 'Once a year, and the tag on it has to show the month, the year and who did it. There is a bigger check at 6 years and a pressure test at 12.',
    fits: ['vehicle', 'carrier'],
  },
  {
    key: 'air_dryer',
    title: 'Air dryer cartridge',
    interval: 'calendar',
    repeatMonths: 12,
    note: 'The truck makers do not agree: some say every 6 months, some once a year, some up to 2 years. It depends on your truck and which dryer is on it, so check your truck book. A year is the middle.',
    fits: ['vehicle'],
  },
  {
    key: 'alignment',
    title: 'Wheel alignment check',
    interval: 'calendar',
    repeatMonths: 12,
    note: 'Once a year for most work. If your trucks run in town all day, every 6 months is the usual advice — bad alignment eats tyres.',
    fits: ['vehicle'],
  },
  {
    key: 'battery_check',
    title: 'Battery test and clean',
    interval: 'owner',
    repeatMonths: 12,
    note: 'A habit, not a rule — you pick it. Worth doing: a truck that will not start does not go, whatever else is right.',
    fits: ['vehicle'],
  },

  // ------------------------------------------------------------- the drivers
  //
  // EVERY DRIVER ROW CARRIES ITS CONDITION IN THE FIRST SIX WORDS OF THE NOTE.
  // "TWIC card" offered to every driver on a dry-van fleet is four suggestions
  // that do not apply before he reaches one that does, and a list like that is
  // a list he stops reading.
  {
    key: 'twic_expiry',
    title: 'TWIC card expires',
    interval: 'owner',
    repeatMonths: 0,
    note: 'For drivers going into the ports. The card shows its own expiry date — put that in. You can renew online up to a year early, and a year late before starting over.',
    fits: ['driver'],
  },
  {
    key: 'hazmat_endorsement',
    title: 'Hazmat endorsement background check',
    interval: 'owner',
    repeatMonths: 0,
    note: 'Hazmat drivers only. Its own clock, separate from the CDL and from hazmat training. The DMV writes before it runs out — put that date in, and start early.',
    fits: ['driver'],
  },
  {
    key: 'yard_equipment_check',
    title: 'Forklift or yard equipment check',
    interval: 'owner',
    repeatMonths: 0,
    note: 'Only for drivers who run a forklift, yard goat or loader. Cal/OSHA wants this at least every 3 years — set the date you plan to do it.',
    fits: ['driver'],
  },
  {
    key: 'work_permit',
    title: 'Work permit expires',
    interval: 'owner',
    repeatMonths: 0,
    note: 'Only for drivers who are not citizens or green card holders. The date is printed on the document — put that in.',
    fits: ['driver'],
  },
  {
    key: 'safety_meeting',
    title: 'Safety meeting',
    interval: 'owner',
    repeatMonths: 3,
    note: 'Every 3 months is a common habit, not a rule. You pick what you will actually do.',
    fits: ['carrier', 'driver'],
  },
  {
    key: 'ride_along',
    title: 'Ride along with this driver',
    interval: 'owner',
    repeatMonths: 0,
    note: 'Your own practice — you pick the gap. The road test with a legal clock is already on your board.',
    fits: ['driver'],
  },
]

/** One suggestion by key, or null. Never throws on a value out of a URL. */
export function suggestionByKey(raw: string | null | undefined): ReminderSuggestion | null {
  const key = String(raw ?? '').trim()
  if (!key) return null
  return REMINDER_SUGGESTIONS.find((s) => s.key === key) ?? null
}

/**
 * The ones worth offering on a given screen.
 *
 * A truck page must not offer "send the books to the accountant", and a driver
 * page must not offer a truck payment — a list whose first two entries do not
 * apply is a list he stops reading.
 */
export function suggestionsFor(fit: SuggestionFit): readonly ReminderSuggestion[] {
  return REMINDER_SUGGESTIONS.filter((s) => s.fits.includes(fit))
}
