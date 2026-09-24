# Backlog

Features the owner has asked for that are not yet scheduled. One entry per feature, in the
shape `DATE-PRIORITY.md` §6 already uses: an imperative title, the problem it solves, what
exists today, and the decisions somebody has to make before writing code.

**This file is the home for feature requests.** Two older lists exist and stay where they
are — neither is superseded, both are narrower than this one:

- `DATE-PRIORITY.md` §6 (B1–B16) — work inside the compliance-dates engine.
- `REVIEW-2026-09-18.md` §4 — gaps found in one review of the owner-facing app.

Items here are prefixed by area (`L` = loads and the driver surface, `P` = penalties, money at
risk and the dashboard that shows them) so the numbers never collide with those lists. When an item is scheduled it **moves** into `REQUIREMENTS.md` and
`modules-orders-trips-alerts.md` — it is not copied. A second copy of a decision is the
failure this repo has already had once: live code cites `docs/product/SCOPE.md`, which does
not exist.

---

## L1. Split a load's freight across its stops, and let the driver confirm each drop on his phone.

*Problem:* the owner's example is a hundred barrels of Bud Light where eighty go to LA Live
and twenty go somewhere else. **Nothing in the product can express that.** `loads` carries
`commodity`, `weight_lbs` and `pieces` as three single columns for the whole load
(`0009_loads.sql:73-75`), and `load_stops` carries no quantity, no commodity and no delivery
outcome at all — only `arrived_at`, `departed_at` and a free-text `reference_numbers`
(`0009_loads.sql:109-138`). The driver finds out what goes where by reading the paper in his
hand, and the office finds out it went by him phoning in. This is a schema change, not a
screen.

### What exists to build on

- **The driver surface is already there and is the right shape.** `driver_links`
  (`0034_driver_links.sql`) is a no-account, no-password link: only a sha256 digest is
  stored, it names one driver by real foreign key, the `asks` array is constrained in the
  database because it is the scope of an unauthenticated write, and there is a 30-day
  expiry ceiling. The page is `/u/[token]`, the shell is `Driver.astro`.
- **Nothing signature-shaped exists anywhere.** `pod_received` is only the last value of the
  `load_status` enum, with UI help text saying the signed receipt is in hand.
- **A document cannot be attached to a load or a stop.** `document_subject` is
  `enum ('carrier','driver','vehicle','terminal')` (`0003_documents.sql:9`) and the same enum
  is shared with `compliance_records` and the notifications table.

### Decide before building

1. **Who signs — the driver, or the receiver?** The request says the driver signs that he saw
   and delivered the items. That is an internal attestation, and it is not what gets the
   carrier paid: factors and brokers fund against a receipt signed by the consignee with a
   printed name. Worth knowing that **49 CFR 373.101 requires no signature at all** — it
   requires the consignor and consignee names, origin and destination, number of packages, a
   description of the freight, and weight or volume where it affects the rating. The
   signature requirement comes from the broker contract and the factor, not the regulation.
   Build both artifacts and label them differently, or pick one knowingly.
2. **Where does the quantity live?** The industry's own encoding is EDI 204: a stop loop with
   nested order-detail lines carrying quantity and weight per PO per stop, summing to the
   stop total. That argues for `load_line_items` plus per-stop **allocations**, not a
   `stop_id` column on the line — one pickup can split to many deliveries. Whatever it is,
   key it to `stop_id`, never to `sequence`: `src/lib/stops.ts` exists almost entirely to
   plan reorders as non-colliding writes, and rows keyed to `sequence` scramble on every
   reorder.
3. **What is the unit?** "100 barrels" is not `pieces`, and `loads.pieces` is a bare int with
   no unit beside it. Handling units and inner count are two different numbers — the driver
   counts pallets, the receiver counts kegs.
4. **Must the stops sum to the load?** A hard refusal blocks the dispatcher at 6am; silence
   ships a POD that disagrees with the BOL. Pick one, and say what the screen does when
   80 + 25 is typed.
5. **Who types the split, and when?** The rate con often does not carry the per-stop
   breakdown — it is on the BOL the driver is holding. Every field is a tax on the office
   manager (`REQUIREMENTS.md:44-48`), so consider dispatcher-plans / driver-confirms rather
   than making her key it twice.
6. **Is the signature a claim or a fact?** Everything a driver sends today lands in
   `driver_submissions` and waits for the owner to accept it, and that staging table is the
   reason the anonymous write path is safe (`0035_driver_submissions.sql:11-15`). A POD
   sitting in a review queue is worthless to a broker at 4pm. If this one writes straight
   through, name what replaces the staging table as the safety — and note that
   `driver_submissions` grants no INSERT to `authenticated` precisely so a signed-in user
   cannot forge "the driver sent this". A POD is evidence someone gets paid on.
7. **The link is single use, and a five-stop day breaks that immediately.** `used_at` is
   stamped on first submit and every lookup requires it null (`0034:20-22`) — that is the
   security property, not an implementation detail. Either it gains a multi-use variety
   scoped to one assignment, or a link is minted per stop, or the driver gets a session.
   Three different products.
8. **Where is a signature stored?** Widening the shared `document_subject` enum touches three
   tables, and `0010_cleanup.sql:127-164` records that a previous enum was deliberately
   *split* rather than widened — "that is the filing vocabulary, this is the obligation
   vocabulary." Read it first. Also: SVG upload is refused, so a vector signature has no
   storage path today.
9. **Does a signed stop move the operational status,** and what sets `pod_received` — the
   signature or the BOL image? `REVIEW-2026-09-18.md` §3.7 already complains that status
   jumps straight from assigned to delivered with nothing recorded.
10. **Zero client JavaScript is a hard convention** (`stack.md:90`, `Driver.astro:34`) and a
    drawn signature is a canvas. Either this is the first deliberate exception, or the
    signature is a typed name plus a timestamp plus a photo of the signed paper.

### Traps

- **Clean must never be the default tap.** A POD signed clean is evidence the freight arrived
  in good order, and the product would be manufacturing it against its own customer every
  day. Count confirmed, *then* clean.
- **"Shipper load and count" is a real outcome.** On a sealed trailer the driver often cannot
  count. Forcing a number he did not verify destroys the evidentiary value of every real
  exception he files. It needs to be a first-class answer, visible to the office as a weaker
  POD.
- **An exception is not a claim.** 49 CFR 370.3(c) says notations of shortage or damage on a
  delivery receipt, standing alone, do not meet the minimum claim-filing requirements.
  Anything that tells the owner "a claim is open" because the driver noted two damaged kegs
  is wrong and will teach him it is handled when nobody has filed anything. Separately,
  49 CFR 370.5(b) requires the carrier to produce tally sheets when a claim arrives — the
  per-stop count *is* the tally sheet the regulation names.
- **Retention outlives the load.** 49 U.S.C. 14706(e)(1) bars contracting for less than nine
  months to file a claim and two years to sue, so a concealed-damage claim can land long
  after the driver's tap and the stop photos are the only defence. (49 CFR part 379 App. A
  sets one year for bills of lading; that is a floor, not the planning horizon.)
- **Electronic is permitted, not compelled.** 49 CFR 390.32 permits electronic documents and
  signatures across the parts that include 373, provided the record is accurate, retainable,
  reproducible and there is proof of consent. But nobody has to accept one — 15 U.S.C.
  7001(b)(2) preserves the right to refuse, a broker contract can demand paper, and a
  receiver can decline to sign a stranger's phone. **A photo of the signed or stamped paper
  BOL must be a POD of equal rank.** At large DCs the driver hands the BOL through a window
  and gets it back an hour later; if the only road to "delivered" is an in-app signature,
  drivers will sign it themselves.
- **Hazmat is carved out.** 15 U.S.C. 7003(b)(4) excludes documents that must accompany
  hazardous materials, and 49 CFR 177.817 still wants the shipping paper within the driver's
  reach in the cab.
- **The dock is the worst RF in the building.** Capture has to complete with zero bytes on the
  wire and queue, and sync has to be idempotent against a client-generated id — the driver
  will submit, see nothing, and press it again.
- **Indoor GPS lies.** Store the accuracy radius and the age of the fix, and never render a
  low-confidence fix as "confirmed at the consignee". Same rule the product already applies
  to dates: never show a confidently wrong answer.
- **The phone's clock is user-settable.** Record device time and server receive time
  separately; when the driver was offline for three hours, that gap is the interesting part.
- **Multi-stop destroys the seal.** A single seal number on the load is wrong from stop 2
  onward. Model seal-found-on-arrival and seal-applied-on-departure per stop, including
  "broken by inspection, resealed with X".
- **A freight split is not a money split.** Detention keys off stop type against two free-hour
  clocks on the load, and stop pay is a separate pay-agreement line. `src/lib/stops.ts:80-90`
  warns that billing a scale stop as detention is the fastest way to get a claim thrown out.
- **Partial delivery is a third state machine.** A load with one stop delivered and one open
  is not `ready_to_invoice`. Per-stop delivery state belongs on `load_stops`, with the
  load-level status derived from it rather than the reverse.
- **Do not let this become a window onto driver data.** 49 CFR 40.307(g) forbids showing a
  driver his return-to-duty follow-up schedule, and the repo enforces that by keeping `asks`
  a closed set rather than by hiding it in the UI.
- **Requiring a personal phone costs money in California.** *Cochran v. Schwan's Home Service*
  reads Labor Code § 2802 to require reimbursing a reasonable percentage of the bill when an
  employee must use a personal phone for work — even on an unlimited plan. Ship an
  office-entered POD fallback so no path depends on every driver owning a smartphone.
- **The competitive bar is structure, not capability.** Per-stop ePOD is table stakes in this
  tier; reviewers of these products complain about unstructured, skippable flows and drivers
  marking loads delivered incorrectly. A per-stop checklist that cannot advance without the
  evidence is the actual product. Per-item-per-stop quantity is the rarer half, and where it
  exists it is often priced per driver — which this product cannot copy.

---

## L2. Send the driver his load the moment he is assigned, as a link he can open.

*Problem:* a driver is assigned on `/app/loads/[id]/assign.astro` and on
`/app/dispatch.astro`, and **nothing reaches him**. The owner then tells him by phone what
the screen already knows. The only driver-facing message the product has ever sent is minted
by hand on the driver's own page, and `DriverLink.astro:18` states the constraint plainly:
*"NO SERVER SEND IN V1. The button opens the owner's OWN messaging app."* This item is the
first automated outbound message to a driver in the product, which is why it costs more than
it looks.

### Decide before building

1. **Channel.** SMS is what a driver reads, and it is gated: 10DLC registration is mandatory
   and takes one to four weeks (`REQUIREMENTS.md:289-291`). Email needs an address the
   product may not hold for a driver. Decide whether v1 is SMS-only, and whether the owner's
   existing "Open in Messages" path stays as the fallback when there is no mobile number.
2. **A category that does not exist yet.** `notify_category` is
   `enum ('compliance','federal','system')` (`0008_notifications.sql:11-15`). A dispatch
   assignment is none of those, and it must not inherit the machinery built to stop
   compliance nagging — **quiet hours and digest batching must not apply.** A driver assigned
   at 5am needs to know at 5am.
3. **What counts as a re-send.** `notification_log.dedup_key` is unique and exists so one
   item messages a person once, ever (`0008:83-91`). An assignment is different: the stops or
   the appointment can change after the first text. Define which changes re-send, and make
   the driver's view always current rather than texting him a diff.
4. **What the link shows, and for how long.** Stops, appointment windows, references and
   instructions — and it should show the load, not the driver's file. It needs to survive
   being opened repeatedly across a multi-day trip, which the current single-use link does
   not (see L1, decision 7 — the two features want the same credential).
5. **Revocation.** Revoke on unassignment and on load closure, not only on a timer. A bearer
   link in a text message outlives the driver's last day and survives a screenshot; keep the
   `opened_at`, no-DELETE discipline `0034` already set so the office can answer "was it
   really him".

### Traps

- **10DLC gates this feature, so start registration before building it.** Register with an
  EIN. Sole-proprietor registration is the documented mistake.
- **No public URL shorteners.** They are a common carrier-filtering trigger on 10DLC traffic.
  Use a first-party short path.
- **Accented characters force UCS-2** and cut an SMS segment from 160 to 70 characters,
  roughly doubling cost — which lands the moment the driver-facing text is Spanish.
- **One text per load, not one per stop.** A four-stop load should not be four messages; open
  the link on the current stop instead.
- **Phones in this tier are shared, changed and cracked.** The dispatcher needs a one-click
  re-send, and paper has to stay legal as a fallback.
- **In dev, every email and SMS redirects to a test address** (`REQUIREMENTS.md:297-299`).
  Texting a real driver a test dispatch is a trust-losing bug.
- **Does the compliance hard-block extend to this?** Dispatch is already blocked on an expired
  medical card or CDL. If a card expires mid-trip, refusing to open the driver's link strands
  him at a dock; not refusing undermines the thesis. Decide deliberately.

---

## P1. Put a number on what an overdue date is about to cost him.

*Problem:* the owner's words — *"add the total price of the unpaid compliance… what's the
penalty for medical certificate unpaid?… show how much the owner will pay if they miss their
fee"* — with a reference screenshot of a competitor dashboard (FleetCore) carrying a
**Financial Impact** band: *Cost Savings $47,800 (fines prevented)*, *Maintenance Optimization
$23,400*, *Downtime Reduction 340 hrs*, *ROI 340%*. Today every overdue row says what happens
in words and never in money. The product's whole thesis is that a missed date is expensive and
no screen in it ever says how expensive.

### What exists to build on

- **The verified amounts are already written down**, in `docs/research/compliance-penalties.md`:
  49 CFR 386 App. B as adjusted by 89 FR 106282, with per-violation figures, the ranges, and the
  one myth the industry repeats. That document already anticipates this feature — penalty
  amounts are good for severity ranking and for *"an honest 'what's at stake' line on an overdue
  item… shown with the citation and the effective date visible — the credibility comes from
  being checkable, and this audience checks."*
- **Three amounts are already in code**, as prose constants (`RECORDKEEPING`,
  `PART382_EMPLOYER`, `CLEARINGHOUSE_PENALTY`, `src/lib/rules/federal-driver.ts:49-52`) pasted
  into `consequence` sentences with the year written into the prose because, as the comment
  there says, *"`consequence` is a bare string with nowhere to put an effective date."*
- **`consequence` is the field this extends** — `RuleDefinition.consequence`, "What happens if
  it is missed — shown on overdue items" (`src/lib/rules/types.ts`).
- **`impact` already ranks severity without money** (`company`/`driver`/`truck`/`money`/`audit`/
  `record`, ranked by `DATE-PRIORITY.md` §2, protected by `compareDeadlines`).
- **Dispatch already hard-blocks on a lapsed medical card or expired CDL**
  (`src/lib/dispatch/eligibility.ts:36-40`), and the carrier's own revenue is already in the
  product (settlements, loads, `src/lib/charts/revenue.ts`). Both matter for decision 3.

### Decide before building

1. **THE COVERAGE PROBLEM, AND IT IS THE WHOLE FEATURE.** Measured, not estimated: of **52
   rules, 14 carry a dollar figure and 38 do not.** California has 16 rules and exactly one
   amount (IFTA late filing, $50 or 10%). **The owner's own example carries no amount at all** —
   all five medical-certificate rules record the consequence as a CRITICAL violation under
   391.45(b) with the unqualified-driver finding under 391.11(b)(4) being ACUTE
   (`federal-driver.ts:297-300`). Those are safety-rating classes, not fines. A total summed
   from what we hold would be mostly blank and the marquee item would contribute zero. Decide
   what an item with no known amount contributes — and it may not silently contribute zero.
2. **Is a total honest at all?** App. B amounts are **per violation**, several are ranges
   ($7,155–$39,615), and what is actually assessed turns on enforcement discretion, severity
   weighting and settlement. Summing maxima produces a headline both unfalsifiable and far above
   what a small carrier will ever be billed. Our own research doc's warning about the
   "$10,000/day" myth applies to us the moment we publish a number: *"it is checkable, it is
   wrong, and the audience includes people who have actually been fined."* If there is a total
   it is labelled a **ceiling** — the most they can fine you for these — never a prediction and
   never "you will pay".
3. **Which price does he actually care about?** For a medical card the fine is not the cost: the
   truck is parked and the driver cannot be dispatched, which this product already enforces. We
   know what his trucks earn. *"This parks a truck that grossed $8,400 last month"* is computed
   from his own data, is true, is larger than most fines, and cannot be wrong about the law.
   Decide whether the number is the statutory penalty, the lost revenue, or both side by side.
4. **Three of the screenshot's four tiles cannot be built honestly.** *Fines prevented* is a
   counterfactual — it asserts a citation that never happened and assumes every tracked item
   would have been written up. *ROI 340%* is derived from that invention and inherits it.
   *Maintenance Optimization* is not in scope at all; this product does not do maintenance.
   *Downtime Reduction* needs a before-baseline we never observed. What is real: money at risk
   right now, who cannot be dispatched today and what they earn, and **how many dates he
   recorded on time** — the last is the ROI story told with a number that is true.
5. **Where the amounts live.** The research doc is explicit: *"Store penalty amounts as data
   with an effective date, not as constants in code."* DOT appears to have skipped the January
   2026 adjustment cycle, so today's figures are simultaneously current and the stalest they
   have been, and a catch-up rule can land at any time. A penalty needs amount, unit (per
   violation / per day), cap, range, citation and effective date — and the screen shows the
   citation and the date.
6. **Whose penalty — the carrier's or the driver's?** App. B separates them: $19,246 employer
   against $4,812 driver for the same subject matter. A total on the owner's dashboard is his
   exposure, or it is inflated by money another person would owe.
7. **Does a number appear on a green row?** "What this would cost if you let it lapse" motivates;
   it also tells a compliant owner he is in danger. Probably overdue and `missing_data` only —
   remembering that `missing_data` sorts with overdue because not knowing when a card expires is
   the same exposure as it having expired (`types.ts`).

### Traps

- **Do not invent a Part 391 amount for the medical certificate.** The verified research
  itemises Part 382, the Clearinghouse, recordkeeping, falsification and out-of-service. It
  carries **no line for Part 391**. Whether a general FMCSR civil penalty reaches a 391.45
  violation, and at what adjusted amount, must be verified against 49 CFR 386 App. B and
  49 U.S.C. 521(b)(2) before anything is displayed. Guessing here is precisely the failure this
  repo documents in competitors' copy.
- **A dollar figure must not reorder the list.** `impact` is the sort key. The most expensive
  fine is not the most urgent item — an ELD recordkeeping lapse at $1,584/day would outrank a
  medical card that parks a man tomorrow.
- **Not legal advice, and not reviewed.** `REQUIREMENTS.md` §11.3 records that no rule in this
  catalogue has been read by a lawyer. A screen that totals money an owner "will pay" is a much
  shorter step to being relied on than a screen that lists dates, and it is the screen counsel
  should see first.
- **Plain words.** These owners are not fluent English readers. "Maximum exposure" is not a
  phrase to put on a screen; "the most they can fine you for this" is.
- **Never wrong in the owner's favour.** An unknown amount renders as "we don't know", never as
  $0, and the row is still counted.

---

## P2. The risk-score table and the compliance timeline, and why only half of it can be built.

*Problem:* a second reference screenshot (FleetCore) showing **Top Risk Vehicles** — unit, driver
name, a 0–100 **Risk Score**, a CRITICAL/HIGH/MEDIUM badge and "primary factors" — above a
**Compliance Timeline** of dated upcoming items.

### The score half is already decided, and the answer is no

`REQUIREMENTS.md` §3 "Out, deliberately" lists **"A computed driver risk score"** with the
reason: *"Publishing one converts us into a regulated consumer reporting agency (15 U.S.C.
§ 1681a(f); CFPB Circular 2024-06)."* The screenshot's table is a driver score in a vehicle
table's clothing — it is keyed to a named driver and its factors are driver credentials (CDL
expiring, hazmat cert). Building it as drawn walks into the one regulatory exposure this
product named and refused before any code was written. **Do not reopen this without counsel;
record the answer here so it is not re-decided a third time.**

The neighbouring refusals travel with it: PSP data may not be cached or linked (its ISP
agreement forbids it outright), so the "violations" that would feed a real score are not ours
to hold.

### What can be built, and mostly already is

- **A per-unit and per-driver ring already exists** — `dqRing` (`src/lib/charts/dq-rings.ts`)
  and the truck ring, both showing *the fraction of this subject's own dates that are in
  order*. That is a completeness measure computed from the carrier's own records about his own
  people, shown only to him. It is not a score furnished about a person, and it is the honest
  version of the left-hand columns in that screenshot.
- **Ranking without scoring.** "Who needs attention first" is already answered by `impact` and
  `compareDeadlines` — a sort, with the reason in words next to it. A row that says *"CDL
  expires in 9 days — he cannot be dispatched after that"* tells the owner more than `68` does,
  and cannot be wrong.
- **The timeline half is uncontroversial** and is close to what the deadlines list already
  renders; it is a different arrangement of rows the product already has, not new data.

### Decide before building

1. **Do not print a number out of 100 anywhere**, even for a truck. A 0–100 figure reads as a
   score whatever it is keyed to, and the distinction we would be relying on in front of a
   regulator is not one an owner — or a plaintiff — will make from the screen.
2. **Badge words, if any, must be the ones the catalogue already uses.** CRITICAL and ACUTE are
   FMCSA's own violation classes with specific meanings (`federal-driver.ts:297-300`). Reusing
   them as a generic severity badge would put our word next to their word meaning something
   else.
3. **Never export or share a per-driver view outside the carrier.** The proof/share surfaces
   already exist; a driver-keyed completeness ring leaving the account is the step that turns
   an internal measure into a furnished report.
