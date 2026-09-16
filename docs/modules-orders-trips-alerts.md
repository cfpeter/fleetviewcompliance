# Operational modules — Orders, Trips, Alerts

Drawn from the market research. Compliance is specified separately once the CA rule
catalogue lands.

---

## Orders / Loads

### The one modelling decision that matters

A load carries **two independent state machines**, not one status field:

- **Operational:** `quoted → booked → assigned → dispatched → at_shipper → loaded →
  in_transit → at_consignee → delivered → pod_received`
  Exceptions (set alongside, not instead of): `detained`, `breakdown`, `late`,
  `cancelled`, `tonu`
- **Financial:** `ready_to_invoice → invoiced → submitted_to_factor → funded → paid →
  closed`, plus `short_paid`, `in_dispute`, `written_off`

A load can be delivered and unbilled; forcing one linear status is the documented cause
of "the reports don't match" complaints across this category. Two columns, two enums.

### Stops are a list, never origin/destination columns

Multi-stop is the normal case. Per stop: sequence, type (pickup/delivery/drop/hook/
fuel/scale), company, address + geocode, contact, **appointment type (hard vs FCFS)**,
window start/end, actual arrive/depart, reference numbers (PO/pickup/delivery/BOL/seal),
instructions, lumper required.

Hard-appointment vs FCFS is not cosmetic: a missed hard appointment means a refused load
or detention, while FCFS is a window. The detention clock and the "running late" alert
both key off this field.

### Detention terms are structured fields, not prose

Free hours at pickup, free hours at delivery, detention rate/hour, and
**`detention_requires_preapproval` (boolean)**. That last one is where small carriers
lose money, and it is the reason to store the rate con's terms rather than just file
the PDF.

### Reference numbers

Store **both** the internal load number and the **broker's** load/reference number, and
make search hit both. Carriers search by the broker's number because that is what is
printed on the paperwork in front of them.

### Rate confirmations arrive as email PDFs

The realistic intake pipeline, in build order:
1. **Manual entry first.** A carrier who cannot type a load in by hand will not trust the
   automatic path. This is not a fallback, it is the foundation.
2. Per-tenant inbound address; dispatcher forwards, or gives it to the broker directly.
3. Classify the attachment (rate con / BOL / POD / invoice / lumper receipt).
4. Extract fields. **Never auto-commit** — a review screen with per-field confidence that
   takes ten seconds to confirm. The competitor failure here is not extraction accuracy,
   it is the absence of a fast confirmation step.
5. The original PDF stays attached to the load permanently.

Steps 2–4 are **not v1**. v1 is step 1 plus "upload the PDF and attach it."

### Invoicing / factoring

Factors want a *package* — invoice + BOL + POD + rate con + lumper receipts as one PDF.
Most factors in this segment accept a monitored intake email rather than an API, so email
submission with status tracking is 80% of the value at 5% of the effort. The part
carriers actually value is pulling **funded / not-funded** status back. QuickBooks Online
sync is table stakes but Phase 2.

---

## Trips / Dispatch

### Three assignments, not one

Driver (plus co-driver for teams), tractor, and trailer are assigned **independently** —
trailers get dropped and swapped, and power-only loads have no owned trailer.

### The feature that fuses the two halves of this product

**Hard-block dispatch when the driver has an expired medical certificate or CDL.**

This is the whole thesis in one screen. Compliance is not a separate tab the owner visits
when he remembers; it is a precondition on the dispatch action he takes twenty times a
week. No competitor in this price tier connects the two.

Conflict detection also covers: driver already assigned in the window, equipment already
committed.

### Mileage

Brokers settle mileage disputes on PC*MILER practical miles. If our number disagrees with
theirs, the carrier loses the argument. So: **label the mileage source in the UI**, start
with a truck-profile routing API, and treat PC*MILER as a paid upgrade for carriers who
need broker-matching numbers.

Track **deadhead separately and always**. Revenue per loaded mile flatters; revenue per
total mile is the truth. Show both, default to total.

### HOS

Do not build an ELD. Integrate, and pull exactly four things per driver: available drive
hours, current duty status, time to next required break, and 70/60-hour cycle remaining.
Use them for one question — *can this driver legally finish this run before we commit to
the shipper?*

Vendor priority by installed base: Motive, Samsara, Geotab, then the long tail. **Support
multiple ELD vendors per tenant** — mixed fleets are normal when trucks are bought used
with devices already fitted. (TruckX is common among immigrant-owned fleets specifically,
and ships Spanish and Punjabi UIs — a useful signal about who buys it.)

### Settlement

Support per-mile, percentage-of-linehaul, hourly, and flat-per-trip **simultaneously** —
real carriers run several at once. Must handle stop pay, detention, layover, accessorial
splits, reimbursements, **advances**, and **recurring deductions** (escrow, insurance, ELD
fee, truck lease, fuel card). Track revisions; disputes happen.

For per-mile, **the mileage basis must be explicit** (practical / shortest / HHG / hub) —
an unlabelled CPM is an argument waiting to happen.

**Do not run payroll.** Produce the settlement, export it.

### IFTA

The highest-drudgery item in the segment: 4–8 hours per quarter by hand. Derive
jurisdictional miles from ELD breadcrumbs where available, fall back to routing-engine
state splits, and always allow a manual override *with an audit note*. Fuel stops need
date, state, gallons, and vehicle identification; receipts retained 4 years.

Quarterly returns are due Apr 30 / Jul 31 / Oct 31 / Jan 31 **even at zero tax owed** —
these become auto-generated deadlines in the compliance module, which is how the two
modules pay each other back.

---

## Alerts

### Taxonomy

A. **Compliance/expiry** — approaching, overdue, document missing/expiring, new FMCSA finding
B. **Operational/load** — assigned, appointment in N hours, arrived/departed, delivered,
   **POD still missing N hours after delivery**, detention clock started, running late
C. **Financial** — invoice ready/sent/past due at 30/45/60, factor funded, short pay,
   rate con vs invoice mismatch
D. **Maintenance** — PM due by miles or date, DVIR defect reported, defect unresolved N days
E. **Driver** — HOS nearly exhausted, unassigned tomorrow, medical card expiring, MVR review due
F. **System** — document awaiting review, integration failed, sync error

### The differentiator that is nearly free

Because we re-poll the carrier's FMCSA record weekly anyway, we can alert on
**"a new roadside inspection appeared on your DOT record"** or "your authority status
changed." No competitor at this price does it, the incremental cost is one diff, and it is
the most viscerally valuable message we can send a small carrier.

### Channels

- **Email** — default. Digests, detail, attachments.
- **SMS** — urgent and overdue only. ~$0.01 all-in. Ration it.
- **In-app** — free, and the always-on record of everything.
- **WhatsApp** — strongly indicated for this audience; Phase 2 (Meta Business verification
  plus approved templates).

### Rules that prevent the product being muted

- Lead times as an **array** per rule: `[-30d, -14d, -7d, -1d, +1d, +3d, +7d]`
- **Digest by default**: compliance goes into one 7am daily digest; immediate SMS only on
  overdue. Fourteen separate emails about fourteen expiring items gets us muted, and then
  the one that mattered is missed too.
- **Quiet hours** per user with timezone; critical alerts break through, and the user can
  see which categories are allowed to.
- **Dedup + snooze** — one overdue item must not message every day forever. Record the snooze.
- Escalation chain: assignee → account owner → optional external contact, with per-step
  delay and channel.

### Custom alerts — three tiers, in this order

1. **Templates.** Toggle on, tune the lead time and channel. *Covers 90% of users, and most
   will never leave this tier — that is a success, not a limitation.*
2. **Simple custom reminder.** Named, attached to any entity, with a due date and
   recurrence. The "my insurance broker wants a call every March" case. Cheap, high value.
3. **Condition builder.** `WHEN trigger IF conditions THEN actions`, with cooldown, max
   fires/day, active range, quiet-hours flag.

Tier 3 goes **behind an "Advanced" disclosure**. A family carrier must not meet a boolean
expression editor on day one.

Two features make a rule builder trustworthy, and without them users build one rule, get
spammed, and disable everything:
- **Plain-language preview** — "This will text Ana when a load was delivered 24 hours ago
  and has no POD attached."
- **"Test on the last 30 days"** — show how many times it would have fired.

### Delivery infrastructure (verified pricing)

- **SMS: Twilio** at $0.0083/segment. Telnyx is cheaper ($0.004) but the delta is ~$9/month
  at this scale — not worth a second vendor relationship.
- **10DLC registration is mandatory**: ~$44 brand + $15 vetting + $1.50–$10/mo. Under $100,
  but **1–4 weeks to approve — start it before building the feature.** Register with an EIN,
  not as a sole proprietor.
- Watch segment maths: accented characters force UCS-2 and cut a segment from 160 to 70
  characters, roughly doubling cost. This matters the moment we localize.
- **Email: Resend** Pro $20/mo for 50k. Dedicated sending subdomain, full SPF/DKIM/DMARC,
  and transactional separated from marketing.
