# Charts

The owner should not have to read forty rows to see a shape. But a chart is a
far more dangerous way to be wrong than a table is: a wrong number in a table is
a wrong number, while a wrong chart is a wrong *conclusion*, reached in about a
second, with nothing on screen to argue with. These are the rules that keep the
charts as honest as the rest of the app, and the components enforce most of them
for you.

## The five rules

1. **`null` is not zero, ever.** Every value is `number | null`. `null` means we
   have no figure, and it renders as a dashed empty slot that says so. A missing
   month drawn as a zero column tells the owner he hauled nothing in March; the
   truth is nobody entered anything for March. Those are different claims and we
   only ever have evidence for the second.

2. **A real value never draws as an invisible sliver.** `widthPercent` floors
   non-zero values at `MIN_VISIBLE_PERCENT`. Three miles against a 40,000-mile
   ceiling is sub-pixel, and "a little" vs "none" is the entire question an IFTA
   auditor is asking.

3. **The axis is built from consecutive periods, never from the data.** Use
   `monthBuckets` / `weekBuckets`. An axis assembled from the months that appear
   in the rows deletes the quiet ones and shows three good months and two dead
   ones as five good months.

4. **Every chart declares what it does not cover.** `Figure`'s `coverage` prop.
   A chart is read as a complete picture of its subject unless it says
   otherwise, and here it usually is not one — the mileage chart is drawn from
   the trucks whose odometers somebody actually entered, and the truck nobody
   entered is invisible rather than short. A footnote lower down the page does
   not fix it; the shape is taken in before any prose is read.

5. **Colour is never the only carrier, and the takeaway is always written out.**
   Every bar prints its own number; every chart is followed by a sentence
   derived from the same figures. Roughly one man in twelve cannot separate the
   red bar from the amber one, and this is read on a phone, in a yard, in the
   sun.

## What exists

`src/lib/charts/scale.ts` — the arithmetic, all pure and all tested in
`tests/charts.test.ts`. `niceCeiling`, `widthPercent`, `ceilingFor`,
`divergingRows`, `monthBuckets`, `weekBuckets`, `bucketValues`, `compactMoney`,
`compactNumber`.

`src/lib/charts/tones.ts` — the palette. It borrows meaning from
`standingPill`: red already means overdue everywhere in this app, so a chart
that uses red for "biggest bar" teaches the owner to distrust the colour he has
learned to trust.

`src/lib/charts/runway.ts` — the dashboard's 13-week deadline runway.

### Components (`src/components/charts/`)

| Component | For | Notes |
|---|---|---|
| `Figure` | The frame around every chart | Title, subtitle, `coverage`, an optional link out to the table |
| `Bars` | Ranked categories — miles by state, revenue by customer | Horizontal, because the labels are words. `limit` + `moreHref` for long lists |
| `Columns` | A quantity over consecutive periods | Value labels hidden under 640px on purpose; the table below carries them |
| `Proportion` | One bar split by category | The legend is not optional — a thin red segment looks like a small problem even when it is two expired medical cards |
| `Diverging` | Signed values either side of a centre line | Built for the IFTA return. Both halves share one scale |
| `Runway` | The dashboard's next-quarter timeline | See below |

## Why the runway has a block on the left

A timeline of upcoming dates can only plot items that *have* a date. An overdue
medical card has no future date, and neither does one whose expiry nobody has
entered — which on day one is most of them. Draw only the future and a carrier
with eleven expired documents and thirty undated ones gets a calm, nearly empty
runway: the most reassuring screen in the app, shown to the most exposed carrier
on it.

So the unplaceable items are counted and rendered at the left of the same strip,
behind the "today" rule. They are text rather than a bar, because drawn as a
column they would sit on an axis scaled to weekly counts and invite the reading
that the two are measured in the same thing. One is a rate; the other is a debt.

## Rules of thumb when adding one

- **Charts go on the page that owns the data.** No dashboard of dashboards, and
  no eleventh nav item — the nav was measured at 80px of visible width on a
  phone before it was fixed, and it does not have room to spare.
- **A chart never replaces the table.** It sits next to one, and links to it.
- **A summary page leads with the chart. A work surface leads with the table.**
  This one is measured, not a preference. Above the table on `/app/loads`, the
  charts put the first load at 1,146px on a phone — a screen and a half down, on
  the page a dispatcher opens twenty times a day with a rate confirmation in her
  hand. Settlements was worse: 1,932px. Both now sit below the rows. The
  dashboard keeps its chart on top because a summary is what that page is; the
  IFTA net chart stays above the return because it answers a question the table
  cannot, while the mileage ranking moved below it because it only re-sorts a
  column the table already has.
- **Never on a filtered view.** Pushing the rows somebody just filtered for back
  down the page undoes the reason the filter exists. Derive it away rather than
  hiding it, so the query cost goes too.
- **Derive in `src/lib/charts/*.ts`, not in the page frontmatter,** so the
  derivation can be tested. The components stay dumb.
- **Under ~14 columns.** Beyond that they are stripes on a phone.
- **Two data points minimum.** `Columns` refuses a single known period on its
  own and prints a sentence instead: one bar beside eleven dashed slots reads as
  a broken widget, and the only shape it suggests — a lone column at full
  height — is the most alarming thing the component can draw.
- **Mark the period you are standing in** with `inProgress`. A monthly axis
  ending on the current month draws a short final column on every page load, all
  month, and a run of full bars falling off a cliff at the right edge is wrong
  every time: the month is a third done, not a third as good.
