# Filling in the missing dates from the dashboard

The owner's words: *"the 'We need a date from you' 29 section — user has to click on
each row to open section then update. Is there a quick update from that page?"*

There was not, and for most rows there was no slow one either. **19 of the 29 have
no input anywhere in the app.** All twelve "needs last completion date" rows have
none; `hazmat_training_date` is not in `DRIVER_ANCHORS`; and there is no carrier
compliance-dates screen at all — `settings.astro` has four intents and not one of
them writes a `compliance_record`. So this editor is not a shortcut. For the
carrier's thirteen questions it **is** the only screen, and that should be a
decision somebody made on purpose.

## The shape

`?show=unknown` stops being a table and becomes a work surface on the same page:
**a list of subject cards**, and tapping one reloads
`/app?show=unknown&s=<subjectId>` with that subject's questions as a form. One
form, one intent, one 303 back to the same URL. **The default `/app` view is
untouched** — its job is triage across three sections and it leads with the
runway.

Measured at 375px on a 30-truck fleet: the `unknown` table is 683 rows ≈ 51,950px.
The card list is 81 cards ≈ 7,150px and no focused page exceeds ~2,400px.

Rejected, with the reason each died:

- **An input on each table row.** Fatal on the target device: the table is
  `min-w-[48rem]` inside `overflow-x-auto`, so at 343px of content width a fifth
  column sits ~500px off-screen. The owner in the yard would never find it. It
  also cannot carry the `help` sentence, which runs 70–200 characters.
- **A separate `/app/dates` page.** Answers "is there a quick update from that
  page?" with "no, go somewhere else", and costs a nav item the nav does not have
  (measured at 80px of visible width before it was fixed).
- **A `<details>` accordion of every subject.** A closed `<details>` still ships
  its body — ~400KB of inputs on one bar of signal — and every one of them closes
  after the 303, so the open state would have to be re-derived from the URL
  anyway. Once it is in the URL, the URL is the mechanism and a link beats a
  disclosure.
- **A progress chart on top.** `docs/charts.md`: never on a filtered view. The
  shrinking card list is the progress indicator.

## Where a typed date goes

`Status.answerKey` (src/lib/rules/compute.ts) names it. Never work it out on the
page — the two ways a row can be `unknown` want different keys and the difference
is invisible from outside:

- `missing_data` — the schedule could not be computed. The key is the anchor the
  schedule wanted, and for a `computed` rule that is whatever its function reads,
  **not** the rule's own code. `once_on_spe_certificate_expiry` is a `computed`
  rule reading `spe_certificate_expiry`.
- no last completion — the schedule is known, whether it was ever done is not.
  That fact has no anchor of its own and is filed under the rule code, which is
  where `evaluate` reads it back.

Writes go through `planAnchorWrites` (src/lib/anchors/plan.ts), which owns the
supersede-then-insert decision and is tested in `tests/anchor-plan.test.ts`.
`recordSubjectFor` maps the engine's subject to the table's: `power_unit` and
`trailer` are two subjects to the rules and one row in `vehicles`, and a writer
that passes `subjectType` straight through writes rows the engine never reads.

## Three rows that must NOT become a date input

1. **`hire_date` and `cdl_expires` are column-backed** (`drivers.hired_on`,
   `drivers.cdl_expires_on`), projected into `ctx.anchors` by deadlines.ts. The
   projection is `if (a[anchorKey]) continue` — **a compliance record silently
   outranks the column.** A typo typed here would permanently override a correct
   hire date, move five federal rules to the wrong dates, and leave the driver's
   own page still showing the right one. This is the worst bug this feature could
   ship. Render a link to the record instead.
2. **`dot_number` is not a date at all.** `federal-carrier.ts:157` returns
   `missing_data` needing it when the carrier has none. It is read from
   `ctx.dotNumber`, never from anchors, so a record written under that key would
   do nothing at all — the row would stay and he would type it again. Link to
   where the DOT number lives.

The deny-list belongs in one exported set with a test, not in a page.

## Rows that can never clear

- **`hazmat_training_date`** fires for every driver forever. `ctx.hazmat` is never
  populated, so the rule fails open by design, and the honest answer — "we do not
  haul hazmat" — is not a date, so `compliance_records` cannot express it.
- **`accident_date`**: a carrier with no reportable accident has nothing to type,
  and the rule's own comment says so.

A list whose entire promise is *this gets shorter*, containing rows that
structurally cannot, teaches him to stop believing the count. Both need
`only_if_it_applies` treatment at minimum; `hazmat` really wants a carrier
setting feeding `RuleContext`.

## Direction, and why it is not derived

Every input carries `min`/`max` from the anchor's `kind`, and the kind comes from
the **registry, keyed by anchor key** — never from `rule.recurrence.type`. A
`computed` rule reading an `expires` anchor would be stamped `max={today}` by the
derivation, making a future SPE expiry impossible to type.

- `last_done` → `max={today}`. A future date makes compute.ts step past the
  occurrence he just reported and answer with the next one: the deadline moves
  LATER, the one direction this domain refuses to be wrong in.
- `expires` → **no lower bound at today.** A medical card that expired last month
  is a real and urgent fact, and compute.ts exists to turn it into `overdue`.
  Refusing to record it would make the most enforcement-visible document in the
  industry un-typeable at the moment it matters most.

## After the save

The 303 carries `&dates=N&was=M` and the page renders a **receipt**: the rows just
written, each with the date read back in long form and a **Withdraw** button
(reusing the tested `withdraw_date` intent, which supersedes rather than deletes).
Reading `Oct 3, 2027` back in words is how he catches the 2027 he meant as 2026,
at the one moment he still remembers what he intended.

The headline reports **both** numbers — `4 dates saved — 6 items off this list.` —
because one date can clear several rules, and a tile that moves by 6 when he typed
4 makes the number he checks first look broken.

Blank boxes change nothing, and here that is structural rather than a convention:
every question on this surface is `unknown`, so every input starts empty and there
is nothing to accidentally clear. Corrections go through the subject's own page or
the receipt.
