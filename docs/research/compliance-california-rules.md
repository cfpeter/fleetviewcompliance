# California rule catalogue

Assembled from verified sub-agent research on 2026-09-14. The parent agent hit a rate
limit before writing this section, so it is reconstructed from the sub-agents' primary-source
findings. Every item below traces to eCFR, the Federal Register, CARB, CHP, CDTFA, CA DMV,
EDD, DIR or the California codes.

**Nothing here has been reviewed by a lawyer.** Treat it as a research artefact, not advice.

---

## 🔴 The one that matters most right now

### California has NOT implemented the Medical Examiner's Certification Integration rule

FMCSA's April 2026 notice (**91 FR 19255**) states it plainly:

> "As of the date of this notice, 45 States and the District of Columbia have implemented
> NRII. The States of **Alaska, California**, Kentucky, Louisiana, and New Hampshire have not
> yet implemented NRII and are continuing to rely on the paper MEC."

A nationwide exemption lets carriers and drivers keep using a paper medical certificate
(**up to 60 days old**) as proof of medical certification. It runs
**12:00 a.m. April 11, 2026 → 11:59 p.m. October 11, 2026**. FMCSA added:

> "FMCSA does **not** anticipate granting additional, nationwide NRII waivers or exemptions
> after the six-month duration of this exemption."

**Product consequence.** Our customers are exactly the carriers this affects. The DQF must,
today, accept a ≤60-day-old paper MEC as valid proof for CDL/CLP holders — and must be ready
to flip to CDLIS-MVR-only on **October 12, 2026**, pending a check of whether California came
online. Build this as a **dated configuration flag, not a hardcoded branch.**

Elsewhere the post-June-2025 regime already applies: CDL/CLP holders no longer carry the paper
card (§ 391.41(a)(2)(i)(B)), the DQF item for them is the **CDLIS MVR** from the current
licensing State (§ 391.51(b)(6)(ii)), and where electronic and paper disagree, **the electronic
record controls** (§ 391.41(a)(2)(iv)). Medical *variance* documentation is still carried by
everyone who has one (§ 391.41(a)(2)(iii)).

---

## CARB Clean Truck Check (HD I/M) — the core California clock

| Item | Verified detail |
|---|---|
| Testing cadence 2026 | **Semi-annual** |
| From Oct 2027 | **Quarterly** for OBD-equipped vehicles |
| Annual fee | **$32.13 per vehicle**, due at the first compliance deadline of each compliance year |
| CTC-VIS listing | Must be kept current **within 30 days** of a purchase or sale |
| Enforcement | **DMV registration hold** (SB 210) |
| Deadline basis | Computable — VIN last digit, or the DMV registration month |

**The asymmetric 90-day rule makes testing early wasteful** — a test taken too far ahead of
the window does not carry forward the way owners assume. The product should actively steer
owners to test *inside* the window rather than early.

⚠️ **Absence of a CARB record means "no certificate printed", not "non-compliant."** And the
public lookup structurally **cannot see a Five-Day Pass** — so never flag a truck
non-compliant on CARB data alone.

**TRUCRS bulk CSV** is verified: 3.1 MB, 40,907 rows, refreshed hourly, and **joins directly
on USDOT** (17,884 USDOT-keyed rows).

### Reefer fleets (TRU) — three per-unit clocks, no annual date

- **$45 operating fee every 3 years per unit.** Suspended, then re-imposed by SB 153
  (signed 2025-09-17); **CARB only began invoicing in January 2026**. Invoices issue up to 60
  days before the due date, payable within 30 days.
- **Compliance labels valid 3 years from issuance**, reissued after fee payment.
- **ULETRU deadline at Dec 31 of engine model year + 7** (trailer TRUs).
- The fee anniversary is **per-unit**, keyed to each TRU's original ARBER reporting date — not
  a company-wide date.
- EPA refused to authorize the **ZETRU** truck-TRU turnover requirement (90 FR, FR doc
  2025-00253, Jan 10 2025), so truck-TRU owners are **not** required to convert to zero-emission.
- A new **trailer-TRU zero-emission rulemaking** is in development at CARB right now.

### Off-road diesel (DOORS) — the only fixed-calendar annual CARB deadline

13 CCR § 2449. If the carrier owns yard goats, loaders or large forklifts: **annual reporting
due March 1**, plus EIN labels on both sides of each vehicle and hour-meter/maintenance records.
Worth screening for; most small carriers will not have it.

⚠️ **UNVERIFIED:** the CARB Advanced Clean Fleets repeal — the OAL decision window closed
**2026-09-11** with no outcome posted. Re-check before launch.

---

## CHP — Basic Inspection of Terminals (BIT)

⚠️ **Do not call it "Biennial."** AB 529 renamed it **Basic** Inspection of Terminals and made
it **performance-based**. As of **January 1, 2026** the cycle moved to **90 days** for vehicles
≥26,001 lb.

The single best California data source is one endpoint:
`carriersafety.chp.ca.gov/Home/SearchCarrier` — keyed by USDOT, no CAPTCHA, returning the
**CA# / MCP#, MCP Active/Inactive status, and full BIT terminal inspection history**. Verified
end to end.

⚠️ **Integration trap:** `Parameters.UserIPAddress` is an opaque session token, not an IP
address. Omit it and you get a **successful-looking zero-record response** — a silent wrong
answer, the worst kind.

---

## CA Motor Carrier Permit (MCP)

- Term is **12 months from the first day of the application month** — staggered per carrier,
  not a shared calendar date.
- Renewable within one year of expiry.
- Requires workers' comp proof or a signed exemption, plus liability of **$300,000–$5,000,000**
  depending on vehicle and cargo, and a CHP-issued CA#.

⚠️ **Do not nag interstate carriers to renew an MCP — theirs is non-expiring.** Sending a
renewal reminder for a permit that never expires is exactly the kind of error that makes an
owner stop trusting every other alert we send.

---

## IFTA (administered by CDTFA in California)

| Item | Detail |
|---|---|
| Quarterly returns | **Apr 30 · Jul 31 · Oct 31 · Jan 31**, rolling to the next business day |
| Zero returns | **Required** even with no travel and no tax due |
| License year | Calendar year; decals expire Dec 31; renewal opens **Dec 1** |
| Fees | $10/year licence, $2 per decal set per vehicle |
| Record retention | **4 years** from the return due date or filing date, whichever is later |
| Late penalty | **$50 or 10% of net tax due, whichever is greater** — applies even if payment was timely |
| Interest 2026 | **9.0%/yr (0.75%/month)**, per jurisdiction |
| CA IFTA diesel rate from 2026-07-01 | **$0.979/gal** combined |

⚠️ **This is two deadlines, not one, and modelling it as one is wrong.** The renewal
application must be **FILED before December 31**. The January–February grace period is for
**displaying** the new decals, not for filing. IFTA's own memo is emphatic:

> "The two-month grace period is for **display** of renewal credentials, **not to file** your
> renewal application for those credentials."

California adds its own conditions: prior-year decals are honoured through **February 28** only
if the renewal was submitted by Dec 31, the account is in good standing, and the driver carries
the new licence plus a Temporary Decal Permit.

---

## IRP apportioned registration (CA DMV)

- **Staggered** — 12 months beginning the first day of an assigned month; renew by midnight on
  the last day of that month. Per-fleet, not a shared date.
- **Distance reporting period: July 1 – June 30 of the fiscal year preceding the registration
  year.** So a renewal filed late 2026 for registration year 2027 reports July 1 2025 – June 30 2026.
- Accountable distance is **all** movement — interstate and intrastate, loaded and empty,
  deadhead/bobtail, toll and non-toll, off-highway.
- Retention (CVC § 8057): **3 years** after the close of the registration year for distance
  records; **4 years** for vehicle cost records after the vehicle leaves the fleet.
- Records must be produced **within 30 days** of a DMV request.
- A Certificate of Non-Operation filed **within 90 days** of expiry can waive penalties.

⚠️ **UNVERIFIED:** the IRP Plan's own section number for the reporting period — irponline.org
returned HTTP 403 to every request. The substance is confirmed via CA DMV.

---

## Form 2290 / HVUT

- Threshold **55,000 lb** taxable gross weight; tax period **July 1 – June 30**.
- Due **the last day of the month following the month of first use** — so a vehicle in service
  on July 1 is due **August 31**. Each mid-year acquisition generates **its own** deadline; this
  is not one fixed annual date for the fleet.
- Max tax **$550** (over 75,000 lb); logging rate is 75% of standard.
- e-file mandatory at 25+ vehicles.
- The stamped **Schedule 1 is proof of payment** — CA DMV will not issue IRP cab cards without it.

---

## California employment obligations

| Obligation | Cadence | Note |
|---|---|---|
| Workers' comp (Lab. Code § 3700) | continuous | 1+ employee. **Penalties up to $100,000 are § 3722, NOT § 3700.5** — § 3700.5 is the misdemeanour ($10k/$50k minimums) |
| EDD DE 9 / DE 9C | quarterly | Delinquent after Apr 30 · Jul 31 · Oct 31 · Jan 31 |
| EDD DE 34 (new hire) | per hire, **20 days** | $24 penalty; $490 if intentional |
| EDD DE 542 (contractor) | per contractor, **20 days** | Directly documents a classification position |
| Cal/OSHA Form 300A | post **Feb 1 – Apr 30** | Logs retained 5 years |
| Harassment prevention training | **every 2 years**, per employee | 2h supervisory / 1h non-supervisory, 5+ employees |
| Workplace Violence Prevention Plan (SB 553) | **annual** review + **annual** training | The cleanest genuinely-annual employment obligation in the set |

⚠️ **Two premises to stop repeating:**
- **There is no annual IIPP review requirement** in 8 CCR § 3203. It is a common best practice,
  not a codified deadline. Do not show it as one.
- **300A electronic submission does not apply to a 12-employee carrier.** NAICS 4841/4842 are in
  Appendix A, but the threshold is **20–249 employees** per establishment. They must still post.

---

## AB 5 / owner-operator classification

⚠️ **Legal-advice-adjacent. Route through counsel before surfacing any of it as guidance.**

**The litigation is over and it went against the industry.** *CTA v. Bonta*: district judgment
for the State **2024-03-15**; CTA's appeal dismissed for failure to prosecute **2024-08-28**;
Ninth Circuit **AFFIRMED 2025-05-16** (No. 24-2341); mandate issued **2025-07-10**. The court
rejected the dormant Commerce Clause and Equal Protection theories outright.

**How to model it:** AB 5 produces **no filing, no renewal, no periodic certification**. It is a
standing status risk. A product that models everything as "next due date" has no slot for it —
so give it one: a **posture / attestation item** on a review cadence the carrier chooses, in a
risk register, explicitly labelled "consult counsel" rather than shown with a green/red status.

⚠️ **Two more premises corrected:** there is **no 30-day minimum lease** in 49 CFR § 376.12 (the
15-day figure people remember is the *payment* deadline, § 376.12(f)), and there is **no 1-year
post-expiration lease retention** in Part 376 — the real schedule is **49 CFR Part 379 App. A:
expiration or termination plus 3 years**.

---

## What this means for the data model

Three distinct recurrence shapes appear here, and a single `due_date` column expresses none of
them properly:

1. **Fixed calendar** — IFTA quarters, 300A posting, DOORS March 1.
2. **Per-entity anniversary** — IRP assigned month, MCP application month, TRU fee date,
   CARB deadline from VIN digit, 2290 from first-use month, harassment training per employee.
3. **Rolling interval from last completion** — annual MVR "at least once every 12 months",
   medical certificate ≤24 months, Clearinghouse annual query on a **rolling 365 days**.

⚠️ The Clearinghouse annual query is the one most often got wrong: **it is a rolling 365 days,
not a January 31 deadline.** There is no fixed annual date.
