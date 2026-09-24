# FleetView Compliance — Requirements

**Status:** v1 draft, 2026-09-14 · **Domain:** fleetviewcompliance.com · **Repo folder:** `~/Work/fleets`

Research behind every claim lives in `docs/research/`. Where this document states a
regulatory fact it cites the rule; where research could not verify something it says so.

---

## 1. What this is

A web application for **small California trucking carriers** — roughly 5 to 50 trucks — that
answers one question continuously: *what expires next, and what do I do about it?*

Around that spine it carries the work the same office already does by hand: booking loads,
dispatching trips, and chasing paperwork.

**Positioning in one line:** the compliance calendar your dispatcher actually opens, because
the loads are in it too.

### Why it can win

- **91.5% of US carriers run 10 or fewer trucks**, and the software built for them is either a
  $25k-implementation TMS or a human service bureau. The real incumbent is **Google Sheets**.
- **Only 6 of 21 surveyed competitors publish pricing.** Transparency is free to us and
  expensive for them.
- **No national competitor models California properly** — Clean Truck Check, CHP BIT, the MCP,
  CVRA decals. That is the moat, and it is why launching California-only is a strength.
- **Compliance and dispatch are sold separately by everyone.** Joining them is the product.

### Launch market

California-domiciled carriers, interstate and intrastate. Built multi-state from day one at the
**data** level (§6) but seeded and sold for California only.

---

## 2. Users

| Who | Buys | Uses | Reality |
|---|---|---|---|
| **Owner** | ✅ | Reads on a phone, usually when worried | Wants one screen that says "you're fine" or "fix this" |
| **Office manager / dispatcher** | | Daily, the only person who types | **Every field is a tax on this person.** Often the owner's spouse |
| **Driver** | | Never logs in | At most opens a link texted to them |
| **Broker / underwriter / officer** | | Reads a proof page | Needs something dated and checkable |

**The design consequence:** the owner is the buyer but the office manager decides whether it
survives past week two. Optimise typing away, not feature count.

---

## 3. Scope

### In

Compliance deadlines · documents · orders/loads · trips/dispatch · alerts (email + SMS +
in-app) · custom reminders · proof output · FMCSA auto-fill · basic reporting

### Out, deliberately

| Not building | Why |
|---|---|
| **An ELD** | Regulated, capital-intensive, and every customer already has one. Integrate instead. |
| **Payroll** | Produce the settlement, export it. Competitors do the same and reviewers accept it. |
| **Clearinghouse queries on the carrier's behalf** | The Rules of Behavior forbid credential sharing and state *"'blanket consent' … is prohibited,"* with a CFAA warning. **Do not build this.** Track that the query is due; hold the proof it was run. |
| **A computed driver risk score** | Publishing one converts us into a regulated consumer reporting agency (15 U.S.C. § 1681a(f); CFPB Circular 2024-06). |
| **Caching or linking PSP data** | Its agreement forbids it outright. |
| **Filing anything** | We track and remind. We are not a law firm and must never imply otherwise. |
| **A native mobile app (v1)** | SMS + email + mobile web covers it. |

### Two things that must never be sold as included

1. **Automatic date extraction from photos of documents.** Until there is a review step that
   works, an extracted date that is silently wrong is worse than no feature.
2. **Anything that implies we file, certify, or clear a violation.**

---

## 4. Modules

### 4.1 Compliance deadlines — the wedge, build first

Subjects: **carrier · driver · power unit · trailer · terminal**.

Every deadline carries: subject, rule reference, trigger, due date, warning windows, owner,
status, evidence document, and *what happens if missed*.

**Status vocabulary** (maps onto the design tokens in `docs/stack.md`):
`current` · `due_soon` · `overdue` · `unknown` · `not_applicable`

**`unknown` is a first-class state and must never be rendered as `current`.** If we do not know
when a medical card expires, the honest answer is "we don't know" — and the exposure is
identical to overdue, so it sorts with overdue.

**Killer output — the audit binder.** A generated PDF with the DQF assembled in
49 CFR 391.51 order, each item marked present / missing / expired, and a gap report on page one.
This is what an owner hands an officer or an underwriter. Everything else is upstream of it.

The rule catalogue is in `docs/research/compliance-federal-rules.md` and
`docs/research/compliance-california-rules.md`.

### 4.2 Orders / loads

Full field spec in `docs/modules-orders-trips-alerts.md`. Three decisions that matter:

1. **Two independent state machines** — operational and financial — not one status column. A
   load can be delivered and unbilled; forcing one linear status is the documented cause of
   "the reports don't match" across this category.
2. **Stops are an ordered list**, never origin/destination columns. Multi-stop is the normal case.
3. **Store both the internal load number and the broker's reference number**, and search both —
   carriers search by the number printed on the paperwork in front of them.

Rate confirmations arrive as **email PDFs**. v1 is manual entry plus "attach the PDF." The
inbound-email → classify → extract pipeline is later, and must **never auto-commit** — a
ten-second review screen with per-field confidence is the part competitors get wrong.

### 4.3 Trips / dispatch

Driver, tractor and trailer assigned **independently**. Deadhead tracked separately, always;
revenue per *total* mile is the default because per-loaded-mile flatters.

**The feature that fuses the product: hard-block dispatch on an expired medical certificate or
CDL.** Compliance stops being a tab the owner visits when he remembers and becomes a
precondition on the action he takes twenty times a week. No competitor in this tier does it.

HOS comes from the ELD (Motive first, then Samsara, then Geotab) and answers exactly one
question: *can this driver legally finish this run before we commit to the shipper?* Support
**multiple ELD vendors per tenant** — mixed fleets are normal when trucks are bought used.

### 4.4 Alerts

Six categories: compliance · load · financial · maintenance · driver · system.

**The nearly-free differentiator:** because we re-poll the carrier's FMCSA record weekly anyway,
we can alert on *"a new roadside inspection appeared on your DOT record"* or *"your authority
status changed."* No small-fleet competitor does this and it is the most viscerally valuable
message we can send.

Rules that stop us being muted:
- Lead times as an **array** per rule: `[-30d, -14d, -7d, -1d, +1d, +3d, +7d]`
- **Digest by default** — one 7am daily compliance digest; immediate SMS only on overdue
- **Quiet hours** per user with timezone; critical breaks through, and the user can see which
- **Dedup + snooze** — one overdue item must not message every day forever

**Custom alerts in three tiers:** templates (covers 90%, and most users never leaving it is a
success) → simple custom reminder → condition builder behind an "Advanced" disclosure. The
builder needs a **plain-language preview** and a **"test on the last 30 days"** backtest, or
users build one rule, get spammed, and disable everything.

### 4.5 Documents

R2-backed. Every deadline can carry evidence. Documents are **append-only** — a superseded
medical card is history, not garbage. Retention follows the rule that produced it (§6).

### 4.6 Reporting

What an owner actually opens: revenue per total mile · cost per mile · driver settlement ·
IFTA quarter · profit per load. Not a report builder.

---

## 5. FMCSA and California integrations

Verified in `docs/research/usdot-data-sources.md`. **All free, all unauthenticated.**

| Source | Dataset / endpoint | Gives us |
|---|---|---|
| FMCSA Company Census | Socrata `az4n-8mr2`, daily | Identity, address, fleet + driver counts, `mcs150_date`, status, safety rating |
| Operating authority + insurance | Socrata `inys-ebih`, daily | Authority type/status, required vs on-file coverage |
| **CHP** | `carriersafety.chp.ca.gov/Home/SearchCarrier` | CA# / MCP#, MCP status, full BIT inspection history |
| **CARB TRUCRS** | bulk CSV, hourly | Clean Truck Check status, joins on USDOT |
| MCS-150 deadline | **pure computation** | No integration at all — 49 CFR 390.19T(b) |

### Integration traps that produce silently wrong answers

1. **Do not zero-pad `dot_number`.** The frozen legacy datasets pad to 8 chars and return an
   **empty array, not an error**, when you don't match their format.
2. **`docket1_status_code` in the census is NOT authority status.** A one-truck LA carrier was
   found showing `A` while SAFER said `NOT AUTHORIZED`.
3. **CHP's `Parameters.UserIPAddress` is an opaque session token, not an IP.** Omit it and you
   get a *successful-looking zero-record response*.
4. **The MOTUS datasets cover only ~127k of ~1.68M DOT numbers.** "No authority row" ≠ "no
   authority." Distinguish *not found* from *does not exist*, in the UI as well as the code.
5. **FMCSA does not reliably flip carriers to INACTIVE** for a missed biennial update.
6. **Absence of a CARB record means "no certificate printed," not "non-compliant"** — and the
   public lookup structurally cannot see a Five-Day Pass.

### Carried over from the previous build's API knowledge transfer

`docs/research/kt-third-party-apis.md` is a 5,126-line end-to-end audit of the same five
integrations, written against a working implementation. It is the only source here backed by
production experience rather than documentation, and it contributes four rules:

1. **Empty is not an error.** Zero rows is a *fact* ("no such filing exists"); a failed call is
   *ignorance*. Every federal call returns `rows` / `empty` / `error`, and the UI says something
   different for each. Collapsing them makes us assert a clean record for a carrier whose data
   simply failed to load.
2. **Zero is a fact, not a blank.** `$0` of liability insurance on file is the most alarming thing
   you can learn about a carrier. Any `value || fallback` idiom silently swallows it.
3. **Socrata truncates at 1,000 rows with no flag, no warning and no error.** A carrier with 1,400
   inspections silently becomes one with 1,000. Page explicitly, always.
4. **Socrata omits null keys entirely** — a missing field is `undefined`, not `null`. And
   `Number('')` is `0`, so guard blanks explicitly rather than relying on `isFinite`.

**Three things that are deliberately not integrations** — a re-implementer loses days looking:

| Source | Why | What to do |
|---|---|---|
| **UCR** | The Socrata entry is a *link to a page*, not data, and ucr.gov returns HTTP 500 to programmatic requests | Owner self-reports the last registration year; we compute the next deadline |
| **Liability insurance expiry** | **It does not exist.** BMC-91X filings are continuous until cancelled — there is no expiry date to read | Surface the filing's existence and amount; flag `$0` or cancelled. **Never build an "insurance expires" deadline** |
| **Per-driver anything** | No public FMCSA source exposes drivers | Owner enters them; we track the intervals |

**One reconciliation.** The KT document states CARB, CA DMV and CDTFA have "no public APIs," and
that is true as written — but this project's own research verified two *automatable* sources the
previous build did not use: the CHP carrier endpoint keyed by USDOT, and the CARB TRUCRS bulk CSV
that joins on USDOT. Neither is an API; both are machine-readable. Prefer them over the curated
deep links the previous build fell back to, but keep the links as the manual path.

**Census driver counts exist but must not be trusted.** `total_drivers`, `total_cdl` and
`driver_inter_total` are real columns, contradicted the previous build's own code comment, and are
**self-reported MCS-150 figures that go stale for years**. Use them as a sanity hint — "does the
roster the owner typed look roughly right?" — never as a source of truth.

### Legal constraints on the data

- FMCSA data is **free for commercial use**. But **CVSA owns the North American Standard
  Inspection Program terminology** — store their codes, write our own descriptions.
- **Never use the DOT or FMCSA seal**, and state non-affiliation wherever we show their data.
- MVR pulling requires state DMV agreements or a vendor (DPPA). Not in v1.

---

## 6. Data model

Detail in `docs/research/compliance-data-model.md`. The load-bearing decisions:

### Multi-tenancy

Postgres RLS **ENABLE + FORCE**, a `SECURITY DEFINER` tenant function to avoid policy
recursion, and explicit `REVOKE` as a floor beneath the policies. **No service-role client
exists anywhere in the app** — every request runs as the signed-in user. Cross-tenant leakage
must be covered by executable assertions, not review.

### The rule engine — three recurrence shapes, not one `due_date`

1. **Fixed calendar** — IFTA quarters, 300A posting, DOORS March 1
2. **Per-entity anniversary** — IRP assigned month, MCP month, TRU fee date, CARB from VIN
   digit, 2290 from first-use month, harassment training per employee
3. **Rolling interval from last completion** — annual MVR "at least once every 12 months",
   medical cert ≤24 months, **Clearinghouse annual query on a rolling 365 days**

A rule definition is **data**, not code: `{subject, jurisdiction, trigger, recurrence,
predicate, warning_windows, evidence_type, citation, consequence}`.

**Adding a state = adding rule rows.** That is the whole multi-state strategy, and it is why
California-first costs us nothing later.

### Compute returns a tagged outcome, never `Date | null`

`DUE(date)` · `NOT_APPLICABLE` · `UNSUPPORTED` · `MISSING_DATA`

`UNSUPPORTED` means *"you owe this and I will not invent when."* `MISSING_DATA` buckets as
**overdue**, because the exposure is identical. **Never show a confidently wrong date** — that
is the one failure that loses a customer permanently.

### Fail open on unknown weight

A truck of unknown GVWR is treated as **fully regulated**. Safe direction, stated explicitly.

### Compliance records are append-only

Enforced by trigger, not convention. Current status is a view. The compliance fact outranks the
data-entry timestamp.

### Dates

UTC-midnight anchors. **Month arithmetic clamps backward.** A library that rolls forward moves
a deadline *later* — the one direction this domain refuses.

### A permission constraint from the regulation itself

49 CFR 40.307(g) forbids the employer, SAP **or service agent** from showing a driver their
return-to-duty follow-up testing schedule. If we ever build a driver-facing view, that data
must be invisible to it — **in the RLS policy, not just the UI.**

---

## 7. Notifications

- **SMS: Twilio** ($0.0083/segment). **10DLC registration is mandatory**: ~$44 brand + $15
  vetting + $1.50–10/mo, but **1–4 weeks to approve — start before building the feature.**
  Register with an **EIN**, not as a sole proprietor.
- **Email: Resend** ($20/mo, 50k). Dedicated sending subdomain, full SPF/DKIM/DMARC,
  transactional separated from marketing.
- Accented characters force UCS-2 and cut an SMS segment from 160 to 70 characters, roughly
  doubling cost. Matters the moment we localise.
- **In dev, every email and SMS redirects to a test address.** Sending a real carrier a test
  alert about a deadline they do not have is a trust-losing bug.

---

## 8. Marketing site

Structure: hero → trust strip → problem → how it works → features → pricing → FAQ → CTA.

**The hero is a USDOT lookup, not "Book a demo."** A visitor sees their own real deadlines
before giving us anything. Built and working.

**Avoid:** demo-only CTAs · hidden pricing · the word "seats" · AI as the headline · fake logos
or badges · claiming to file paperwork we only track · **any penalty figure we have not
verified** (see the "$10,000/day" myth in `docs/research/compliance-penalties.md`).

---

## 9. Pricing

**$6 per truck per month, $29 minimum. Unlimited users. 30-day trial, no card. No contract.**

| Fleet | Monthly |
|---|---|
| 1–4 trucks | $29 (floor) |
| 5 | $30 |
| 10 | $60 |
| 20 | $120 |
| 40 | $240 |

**Why linear-with-a-floor, not bands:** a band boundary makes the bill jump (5→6 trucks would
go $29→$79 under typical banding), which creates a direct incentive to **under-report fleet
size to the compliance product**. Corrosive for a product whose value is accurate records.

**Why unlimited users:** per-seat is the most-cited complaint in this segment, and our two
essential users — owner and office manager — are exactly who a per-seat model taxes.

**Anchor:** owners already pay $25–40/truck/month for ELDs. $6 is under a fifth of a bill they
have already accepted.

Same product on every plan. No feature unlocks by size.

---

## 10. Build order

| Phase | Contents | Gate |
|---|---|---|
| **0 — done** | Scaffold, design tokens, marketing home, `/check` live against FMCSA | ✅ builds, tests pass |
| **1** | Supabase schema + RLS + auth + app shell | Cross-tenant assertions pass as `anon` |
| **2** | Rule engine + seeded federal/CA rules, a test per rule | Every rule has a test and a citation |
| **3** | Drivers, vehicles, documents, the one-screen dashboard | An owner can see real deadlines |
| **4** | Alerts: digest, SMS, quiet hours, templates | 10DLC approved |
| **5** | Loads + trips + dispatch compliance block | The block actually fires |
| **6** | Proof / audit binder PDF | |
| **7** | IFTA, settlements, ELD integration, rate-con intake | |

**Start 10DLC registration now** — it gates phase 4 and takes up to 4 weeks.

Feature requests the owner has made that are not yet scheduled live in
`docs/product/BACKLOG.md`. That file is the only place they are written down; when one is
scheduled it moves into this document and into `docs/modules-orders-trips-alerts.md` rather
than being copied.

---

## 11. Open decisions

1. **Dev/prod separation.** Toma shares one Supabase project and one R2 bucket between local dev
   and production. **Not acceptable here** — this database holds other carriers' driver medical
   certificates. Two projects, two buckets, from day one.
2. **Localisation.** No incumbent TMS ships a non-English UI, and that is an open flank. Not v1,
   but do not hardcode English strings in a way that makes it expensive later.
3. **Legal review.** No rule in this catalogue has been read by a lawyer. Three to put in front
   of counsel first: the § 396.17 annual-inspection reading, whether the CARB fee is per-vehicle,
   and the AB 5 posture language.
4. **CARB Advanced Clean Fleets repeal** — the OAL decision window closed 2026-09-11 with no
   outcome posted. **UNVERIFIED. Re-check before launch.**
5. **The NRII exemption expires 2026-10-11** and California had not implemented as of April 2026.
   Built as a dated config flag; needs a human check on that date.

---

## 12. What would make this fail

- **Showing a confidently wrong date.** One is enough.
- **Alert fatigue.** Fourteen emails about fourteen expiring items gets us muted, and then the
  one that mattered is missed too.
- **Making the office manager type more than the spreadsheet did.**
- **Publishing a penalty figure someone can check and disprove.**
