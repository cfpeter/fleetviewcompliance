# Which dates matter most

**Status:** first draft, 2026-09-18 · **Written for:** the owner, not a lawyer
**Source:** the rule rows in `src/lib/rules/federal-driver.ts`, `federal-carrier.ts` and
`california.ts`. Every item below names its rule code and its citation so you can check it.

The app tracks **51 obligations**. They are not equal. Some take one truck off the road for a
week. Some end the business. Some are a fine you pay and forget. Today the screens show them
in one flat list, sorted only by date, so a records-keeping item can sit above an expired
medical card.

This document says which ones come first and why.

**How things are ranked here.** Not by the regulation number. By this, in order:

1. Does the truck stop?
2. Does the company stop?
3. Does it cost money on a date?
4. Does it build up quietly in an audit?
5. Does a broker look at it before giving you a load?
6. How long does the fix take? A thing you can fix this afternoon needs less warning than a
   thing that needs an appointment three weeks out.

**One warning before you read.** Nothing in the rule files has been checked by a lawyer.
Every rule file says so, and `verifiedBy` is empty on all 51 rows. Read this as a ranking of
business risk, not as legal advice.

---

## 1. The short list

If you only ever look at five things, look at these. In order.

**1. Your insurance filing with FMCSA.**
`fed.387.9.liability-insurance-filing` — 49 CFR 387.9, 387.7(b)(1), 387.313T(d)
If the filing drops off, your operating authority is suspended. Not one truck — all of them.
And a broker sees it the same day, because it is on your public record.

**2. Each driver's medical certificate.**
`medical_certificate_general` — 49 CFR 391.45(b), 391.43
The day it expires the driver cannot drive. If he holds a CDL, the state also downgrades his
licence within 60 days (383.73(q), 384.235) — he loses the licence, not just the card. A DOT
physical needs an appointment, so a late warning is no warning.

**3. Each driver's CDL.**
`cdl_expiry` — 49 CFR 391.11(b)(5)
The driver cannot drive. A DMV visit is booked weeks ahead, so this needs long warning.

**4. Your MCS-150 update.**
`fed.390.19T.mcs150-biennial-update` — 49 CFR 390.19T(b)
Miss it and FMCSA deactivates your USDOT number. Every truck you own is then illegal under
392.9b. Nobody calls to tell you. The filing itself takes twenty minutes — the danger is that
you never find out you missed it.

**5. Clean Truck Check — the test and the fee.**
`ca_ctc_test`, `ca_ctc_fee` — CARB Clean Truck Check (Heavy-Duty I/M), SB 210
Fail this and DMV puts an automatic hold on that truck's registration. You cannot renew the
plate until it clears. The test needs a booked appointment, and a test done more than 90 days
early does not count — so this is the slowest fix in the whole list.

### If all your trucks stay inside California

Then numbers 1, 3 and 4 above change. You do not hold FMCSA operating authority and you do
not file BMC-91X. Your five are:

1. **California Motor Carrier Permit** — `ca_mcp_renewal`, Veh. Code 34500 et seq.
   Without it you are operating with no permit. Late fees step at 31 days (+60%), one year
   (+80%) and two years (+160%).
2. **Each driver's CDL** — `cdl_expiry`, 49 CFR 391.11(b)(5).
3. **Clean Truck Check** — `ca_ctc_test`, `ca_ctc_fee`.
4. **CVRA registration** — `ca_cvra_registration`, Commercial Vehicle Registration Act,
   DMV VIRPM 13.020. Expired plates mean a citation and the truck can be impounded.
5. **The medical card for every driver.** See section 4 — **the app does not track this for
   you if you are marked intrastate.** That is a gap in the rule catalogue, not a rule.

---

## 2. The full ranking, in tiers

### Tier 1 — the whole company stops

*What puts a rule here: one lapse and no truck can legally move, or you lose the right to
operate at all.*

| Rule code | Citation | What happens |
|---|---|---|
| `fed.387.9.liability-insurance-filing` | 49 CFR 387.9, 387.7(b)(1), 387.313T(d) | Authority suspended, then revoked. Penalties up to $21,114 a day. |
| `fed.usc.13906.operating-authority` | 49 U.S.C. 13906(a)(1) | The authority lives only while the insurance filing is good. Suspension, then revocation after a compliance order and 30 days. |
| `fed.390.19T.mcs150-biennial-update` | 49 CFR 390.19T(b) | USDOT number deactivated. Every vehicle in violation of 392.9b. $1,365–$10,269. |
| `ca_mcp_renewal` (intrastate only) | Veh. Code 34500 et seq.; CA# under 34507.5 | Operating with no permit. Late fees +60% at 31 days, +80% at one year, +160% at two years. |

Two of these four carry **no date at all**. Insurance and operating authority are ongoing
duties, not renewals — the app returns "check this yourself" for both, on purpose, because
a BMC-91X filing has no expiry and inventing a date would teach you to watch the wrong thing.
That is honest. It is also why they are currently at the bottom of your dashboard. See
section 3.

### Tier 2 — one driver or one truck stops

*What separates tier 2 from tier 1: the rest of the fleet keeps earning. One truck sits, or
one driver sits, and the other trucks roll.*

| Rule code | Citation | What happens | Fix speed |
|---|---|---|---|
| `medical_certificate_general` | 49 CFR 391.45(b), 391.43 | Driver out of service. CDL downgraded within 60 days. | Slow — needs a booked physical |
| `medical_certificate_by_exam_date` | 49 CFR 391.45(b) | Same. This is the backup rule used when you recorded the exam date but not the printed expiry. | Slow |
| `medical_certificate_intracity_zone` | 49 CFR 391.45(c), 391.62 | Same, on a 12-month card. | Slow |
| `medical_certificate_insulin_treated` | 49 CFR 391.45(e), 391.46 | Same, on a 12-month card. Needs form MCSA-5870 from the treating clinician, dated within 45 days of the exam. | Slower — two appointments |
| `medical_certificate_alternative_vision` | 49 CFR 391.45(f), 391.44 | Same, on a 12-month card. Needs form MCSA-5871 from an eye doctor. | Slower — two appointments |
| `cdl_expiry` | 49 CFR 391.11(b)(5) | Driver not qualified. Up to $19,246 per violation. Automatic failure in a new-entrant audit. | Slow — DMV appointment |
| `ca_ctc_test` | CARB Clean Truck Check, SB 210 | DMV registration hold, placed automatically. Roadside and port enforcement. | Slow — test appointment, and no earlier than 90 days before |
| `ca_ctc_fee` | CARB CTC compliance fee | Truck reads non-compliant. DMV hold. Certificate denied. | Fast — pay online |
| `ca_irp_renewal` | IRP; CA DMV IRP Handbook ch. 6; Veh. Code 8057 | Apportioned plates expire. Balance due 20 days from invoice. | Very slow — Schedule B mileage for 1 July–30 June must be built first |
| `ca_cvra_registration` | CVRA; DMV VIRPM 13.020; weight on REG 4008 | Expired plates, citation, impound risk. A PYR does not fix a lapse. | Fast — unless a CTC or 2290 hold blocks it |
| `fed.irs.2290.heavy-vehicle-use-tax` | IRC 4481; IRS Form 2290 | The state will not register the truck without the stamped Schedule 1. | Fast to file, slow to get the stamp back |
| `fed.396.17.periodic-inspection.power-unit` | 49 CFR 396.17 | Truck out of service at roadside. | Fast — a shop can do it the same day |
| `fed.396.17.periodic-inspection.trailer` | 49 CFR 396.17 | Trailer out of service at roadside. | Fast |
| `ca_ctc_vis_listing` | CARB CTC-VIS, 30 days from purchase or sale | A truck you bought and never listed cannot pass Clean Truck Check, so it cannot be registered. A truck you sold keeps running up fees. | Fast — but only 30 days to notice |
| `spe_certificate_renewal` | 49 CFR 391.49(h) | Without a current SPE the limb impairment disqualifies the driver under 391.41(b)(1)-(2). | Very slow — a federal application |
| `return_to_duty_follow_up_testing` | 49 CFR 382.309, 40.307 | Using a prohibited driver. The app cannot date this — the SAP sets the number of tests and you pick the days. | Depends on the SAP plan |
| `clearinghouse_query_pre_employment` | 49 CFR 382.701(a) | The driver may not do safety-sensitive work until it is run. $7,155 per violation. | Needs the driver to give consent inside the Clearinghouse — not always same day |

**The registration chain.** Four of these are one chain, not four separate chores, and the
order matters:

> Form 2290 stamped Schedule 1 → Clean Truck Check test + fee → CVRA or IRP plate renewal

A missed 2290 or a failed Clean Truck Check does not hurt on its own day. It hurts on the day
you try to renew the plate and DMV refuses. Fix the upstream ones first.

### Tier 3 — it costs money on a date, or a broker sees it

*What separates tier 3 from tier 2: the truck keeps rolling. You pay, or you carry a mark
that somebody checks later.*

| Rule code | Citation | What happens |
|---|---|---|
| `ca_ifta_license_renewal` | IFTA licence year; CDTFA renewal | File by **31 December**. The two-month grace is for **displaying** decals, not for filing. Miss 31 December and you have no valid licence for the new year. |
| `ca_ifta_decal_display` | IFTA display grace; CDTFA Temporary Decal Permit | New decals on both doors by the **last day of February**. After that, running on last year's decals is a roadside citation. |
| `ca_ifta_quarterly_return` | IFTA, administered by CDTFA | $50 or 10% of net tax due, whichever is more, plus interest. A zero return is still a return. If you do not file, CDTFA bills you on industry-average MPG with your fuel-tax credits removed. |
| `fed.ucr.annual-registration` | 49 CFR Part 367; 49 U.S.C. 14504a | Citations and fines at roadside under state law. |
| `ca_bit_inspection` | Veh. Code 34501.12, as recast by AB 529 | Your own 90-day inspection on every truck at 26,001 lb and up. One missed inspection is not a disaster. A pattern of them is what makes a CHP terminal visit go badly. |
| `ca_bit_terminal_inspection` | Veh. Code 34501.12; CHP HPM 84.1 ch. 2; MCP Handbook MC 500 M | No date exists. CHP picks terminals from performance data and can come any time. An unsatisfactory rating means re-inspection fees and CHP starting an MCP suspension. |
| `clearinghouse_query_annual` | 49 CFR 382.701(b) | $7,155 per violation. **There is no 31 January deadline** — it is 12 months rolling from that driver's last query. |
| `fed.172.704.hazmat-recurrent-training` | 49 CFR 172.704(c)(2) | Hazmat only. One of the few with a **minimum**: not less than $617, up to $102,348. |
| `fed.107.608.hazmat-registration` | 49 CFR 107.608, 107.612, 107.620 | Hazmat only. Due 30 June. Up to $102,348 per violation. |

**If you haul hazmat, the last two move up to tier 1.** The dollar figures are ten times
anything else in this catalogue, and the certificate has to ride in every truck tractor.

### Tier 4 — it builds against you in an audit or a lawsuit

*What separates tier 4 from tier 3: nothing happens on the day. It is found later, by an
auditor, an insurer or a lawyer, and then all of it is found at once.*

| Rule code | Citation | What happens |
|---|---|---|
| `dqf_maintained` | 49 CFR 391.51(a), (b) | Recordkeeping: $1,584 a day up to $15,846. Also the basis for an unqualified-driver finding and for negligent hiring. Keep the file for employment + 3 years. |
| `mvr_inquiry_at_hire` | 49 CFR 391.23(a)(1), (b) | 30 days from the first day of work. From **every** state that licensed him in the last 3 years. |
| `safety_performance_history_investigation` | 49 CFR 391.23(a)(2), (c), (d), (e) | 30 days, same clock, different piece of paper, different file (391.53). Negligent-hiring exposure. |
| `mvr_inquiry_annual` | 49 CFR 391.25(a) | Every 12 months from the last one. A California Employer Pull Notice does not replace it. |
| `driving_record_review_annual` | 49 CFR 391.25(b), (c)(2) | A different document from the MVR: a signed, dated note naming who read it. |
| `road_test_or_equivalent` | 49 CFR 391.31, 391.33 | One time, before he drives. Not annual, whatever a checklist says. |
| `random_controlled_substances_testing_rate` | 49 CFR 382.305(b)(2), (k)(2) | 50% of driver positions per calendar year. $19,246 per violation. |
| `random_alcohol_testing_rate` | 49 CFR 382.305(b)(1), (k)(2) | 10% of driver positions per calendar year. A separate count from the drug rate. |
| `supervisor_reasonable_suspicion_training` | 49 CFR 382.603 | 120 minutes, **once**, per supervisor. Not annual. Without it you cannot lawfully act on what a supervisor sees. |
| `fed.396.11.dvir` | 49 CFR 396.11 | Only when a driver finds a defect. There is no "no-defect DVIR" requirement for freight. |
| `fed.396.25.brake-inspector-qualification` | 49 CFR 396.25 | One time per person. Up to $19,246 per violation. |
| `ca_harassment_training` | Gov. Code 12950.1 (SB 1343) | Every 2 years per person. 2h for supervisors, 1h for everyone else, at 5+ employees. |
| `ca_wvpp_annual_review` | Labor Code 6401.9 (SB 553) | Review the plan at least once a year. It is the first document asked for after an incident. |
| `ca_wvpp_annual_training` | Labor Code 6401.9 (SB 553) | Train each person at least once a year, and again when the plan changes. |
| `ca_osha_300a_posting` | 8 CCR 14300 et seq. | Post the signed 300A on the wall from 1 February to 30 April. Nothing is sent to anyone. |

### Tier 5 — keep the paper, do not throw it away

*What separates tier 5 from tier 4: there is nothing to do on the date. The date is the first
day you are allowed to destroy the record. Destroying it early is the violation.*

| Rule code | Citation | Keep for |
|---|---|---|
| `fed.396.21.inspection-report-retention.power-unit` | 49 CFR 396.21(b)(1) | 14 months, where the truck is housed or maintained |
| `fed.396.21.inspection-report-retention.trailer` | 49 CFR 396.21(b)(1) | 14 months |
| `fed.390.15.accident-register-retention` | 49 CFR 390.15(b) | 3 years from each accident |
| `fed.395.8.rods-retention` | 49 CFR 395.8(k)(1) | 6 months, rolling |
| `fed.395.11.supporting-documents-retention` | 49 CFR 395.11 | 6 months, rolling, up to 8 per driver per day |
| `fed.395.22.eld-backup-retention` | 49 CFR 395.22(i)(1) | 6 months, on a different device from the original |

These should not look like deadlines. They are floors.

---

## 3. What this should change in the product

### 3.1 The dashboard should lead with "can you get a load today?"

**The problem.** `src/pages/app/index.astro` shows sections in this order: Overdue, "We need a
date from you", "Coming up in the next 45 days", then **"You have to check these yourself"**,
then a count of everything else. The two tier-1 items with no date — insurance filing and
operating authority — land in that fourth section, at the bottom of the longest page in the
app, below a section that can run to 100+ rows. `STANDING_RANK` in `src/lib/rules/index.ts`
ranks `unsupported` at 3, which is **below** `current` at 2. The two obligations that end the
business sort below green rows.

**The change.** Add a band above the health ring on `/app` with four lines and nothing else:

- Operating authority: active / not active *(from the FMCSA record — `src/lib/fmcsa.ts`
  already reads it)*
- Insurance on file with FMCSA: yes / no
- USDOT number: active / deactivated, and the MCS-150 date
- Motor Carrier Permit: current / expired *(only when `carrierOperation` is not 'A')*

If all four are good, one green line: **"You can take a load today."** If any is not, that
line is the first thing on the page. This band does not replace the "check these yourself"
section — it is the summary of it, at the top.

### 3.2 Sort by consequence inside a bucket, never across buckets

**The problem.** `compareDeadlines` in `src/lib/rules/index.ts` sorts by standing, then by
`daysUntil`, then by label. So inside the Overdue section an ELD back-up retention row that is
90 days past sits above a medical card that expired yesterday.

**The change.** Add an `impact` field to `RuleDefinition` in `src/lib/rules/types.ts`:

```
impact: 'company' | 'truck' | 'driver' | 'money' | 'record'
```

Then make `compareDeadlines` sort on `(standing, impact, daysUntil, label)`.

**Two things this must not break**, both already written into the code's own comments:

- Nothing changes across standings. `unknown` still ranks with `overdue`. A missing date still
  carries the same exposure as an expired one.
- A filter may only hide, never re-rank (`src/lib/dashboard.ts`). `impact` is a sort key, not
  a filter.

The tiers in section 2 are the values: tier 1 → `company`, tier 2 → `truck` or `driver`,
tier 3 → `money`, tier 4 and 5 → `record`.

### 3.3 The digest email should say who cannot work today, first

**The problem.** `src/lib/notify/digest-email.ts` groups by tone only — overdue, no date,
soon, on track — and inside a group the order comes from `selectForRecipient`, which sorts by
days. And `src/lib/notify/select.ts` skips `unsupported` items outright
(`if (item.status.standing === 'unsupported') continue`), so **insurance and operating
authority never appear in the email at all.**

**The change, three parts:**

1. Above the headline, one line: *"Today: 2 drivers cannot drive. 1 truck cannot roll."*
   Built from overdue items with `impact` of `driver` or `truck`. If the number is zero, the
   line is not printed.
2. Inside the overdue group, order by `impact` before days.
3. Let `unsupported` items with `impact: 'company'` into the digest as a standing block at the
   top — not as a countdown, as a line that says "check this". Today the rule is a blanket
   skip, which is right for brake-inspector qualification and wrong for the insurance filing.

### 3.4 Use the warning windows that are already written on every rule

**The problem.** All 51 rules carry a `warningDays` array — `[90, 45, 14, -1]` on the medical
card, `[90, 60, 30, 14, 7, -1]` on IRP, `[120, 60, 30, -1]` on hazmat training. **Nothing in
production reads that field.** Only the tests do. Instead:

- The dashboard uses one flat `SOON_DAYS = 45` for everything
  (`src/lib/rules/index.ts`).
- The email uses one `DEFAULT_LEAD_DAYS = [30, 7, 1, -1]` per category
  (`src/lib/notify/preferences.ts`), and `reachedWindow` in `select.ts` is given that, not the
  rule's own array.

So the deadline that needs 90 days of warning and the one that needs 7 get the same 30.

**The change.** In `selectForRecipient`, pass `item.rule.warningDays` to `reachedWindow`, and
use the carrier's category preference as an override only where the owner has set one. On the
dashboard, let a row count as "coming up" when `daysUntil <= rule.warningDays[0]` instead of
`<= 45`.

**These deserve more than 45 days, and the rule rows already say so:**

| Rule | Window on the row | Why it is long |
|---|---|---|
| `ca_irp_renewal` | 90 | Schedule B mileage for 1 July–30 June has to be built first. At 60 days it is already too late to start. |
| `medical_certificate_*` (all five) | 90 | A DOT physical is an appointment, not an errand. |
| `ca_ctc_test` | 90 | 90 days is the day the test window **opens**. Earlier is wasted money — a test more than 90 days out does not count. |
| `fed.390.19T.mcs150-biennial-update` | 90, and **-30** | Deactivation is silent. The nudge after the date matters as much as the one before. |
| `fed.172.704.hazmat-recurrent-training` | 120 | Class scheduling. |
| `ca_mcp_renewal` | 60, and **-30** | Late fees step at 31 days. |
| `cdl_expiry` | 60 today | **I would raise this to 90.** A CDL renewal in California is an appointment booked weeks out, and an expired CDL is the same severity as an expired medical card. |

### 3.5 Show the registration chain as a chain on the truck page

**The problem.** On `/app/vehicles/[id]`, Form 2290, Clean Truck Check test, Clean Truck Check
fee, CTC-VIS listing and CVRA or IRP renewal appear as five unrelated rows. They are one
sequence. A hold on any of the first four makes the fifth impossible.

**The change.** Group them under one heading — *"Getting this truck plated"* — in the order
2290 → CTC test → CTC fee → plate renewal, with a plain sentence when an upstream one is
overdue: *"You cannot renew this plate until Clean Truck Check passes."*

### 3.6 Count BIT per truck, not per row

**The problem.** `ca_bit_inspection` is a 90-day cycle on every truck at 26,001 lb and up. It
produces more rows than any other rule in the catalogue, and each one, on its own, looks
minor. The thing that matters is the total: how many trucks are behind.

**The change.** One counter on `/app/vehicles`: *"BIT: 11 of 14 trucks inspected in the last
90 days."* CHP reads the pattern, not the row, so the product should show the pattern.

### 3.7 Take the retention floors out of the deadline list

**The problem.** The six tier-5 rules use the same row shape, the same pill and the same
"overdue" vocabulary as a medical card. Worse: once you enter the inspection date, the two
`fed.396.21.*` rows ask a **second** question — a "last completion date" filed under the rule
code — and none of the rule codes exist in the anchor registry in
`src/lib/rules/anchors.ts` (28 keys, all of them anchors). So the row cannot be answered from
the date screen, and `DateEditor.unaskable` counts it and **nothing on the page prints that
count** — only `unrecordable` is shown. The row sits on the dashboard forever with no way to
clear it.

**The change.** Give the retention rules their own section — *"Paper you must keep"* — with
one line per record type and a "may be destroyed after" date. Take them out of the counts on
the ring and the tiles. And print `unaskable` on the date screen the same way `unrecordable`
is printed, so no row is silently missing.

### 3.8 Split the employment rules out

`ca_harassment_training`, `ca_wvpp_annual_review`, `ca_wvpp_annual_training` and
`ca_osha_300a_posting` are real duties and they are not trucking duties. On a phone they sit
next to an expired CDL and get the same weight. Put them under their own heading —
*"Employees"* — below the fleet.

Two of them also cannot be tracked properly today: `Subject` has no `'employee'` member in
practice for these rows, so dispatchers, mechanics and office staff — who are covered by
Gov. Code 12950.1 and Labor Code 6401.9 just as much as drivers — cannot be listed at all.
The rule rows say this themselves.

---

## 4. What I am not sure about

**This section is the important one.** A single ranking that is wrong for a third of carriers
is worse than one that says where it stops applying.

### 4.1 Interstate or intrastate changes almost everything

The app reads FMCSA's operation code: `'A'` is interstate, `'B'` and `'C'` are intrastate.

**If you are intrastate ('B' or 'C'), these drop off entirely:** IRP renewal, all three IFTA
rules, UCR registration. And FMCSA operating authority and the BMC-91X filing do not apply to
you the way tier 1 describes.

**If you are interstate ('A'), one drops off:** `ca_mcp_renewal`. An interstate carrier's MCP
does not expire and carries no renewal fee. This is the only rule in the catalogue that
deliberately answers "not applicable" on a positive fact, and the code comment explains why —
nagging an interstate carrier to renew a permit that never expires is what makes an owner stop
believing every other alert.

**A real gap you should know about.** All five medical-certificate rules are gated on
`interstateDriver`, which returns `false` for a declared intrastate carrier. `california.ts`
carries **no intrastate medical rule**. So a carrier marked 'B' or 'C' gets **no medical
certificate tracking at all** — and because `eligibility.ts` blocks dispatch on exactly those
five rule codes, the dispatch block for an expired medical card can never fire for them
either. The number two item in the short list disappears for a whole class of carrier. The
rule file's own comment flags this risk; the California catalogue has not closed it.

**And this:** the operation code is self-reported. A carrier who crosses a state line once is
interstate. The UCR rule already handles this carefully — it acts only on a positive 'A' and
treats everything else as unknown. The medical rules do not.

### 4.2 Hazmat moves two rules from tier 3 to tier 1

`fed.172.704.hazmat-recurrent-training` and `fed.107.608.hazmat-registration` carry the
largest numbers in the catalogue — up to $102,348, with a statutory **minimum** of $617 on
knowing training violations. If you haul hazmat, they belong beside your insurance filing.
If you do not, they never apply.

Two things the app cannot see:

- One `hazmat` boolean stands in for six different quantity and class triggers in
  § 107.601(a). The app over-reports for carriers hauling small quantities. It never
  under-reports.
- A "hazmat employee" includes dock staff and anyone who prepares shipments, not just drivers.
  The rule is filed against drivers because the subject list has nowhere else to put it.

### 4.3 Weight class changes which truck rules apply

Different rules use different weight lines, and they are not the same number:

| Line | What it turns on |
|---|---|
| 10,001 lb | Commercial motor vehicle (§ 390.5T), CVRA registration |
| 14,000 lb | Clean Truck Check |
| 26,001 lb | The BIT 90-day cycle is certain at or above this |
| 55,000 lb | Form 2290 — but this is **taxable gross weight**, not GVWR |

Two things I cannot resolve from the data the app holds:

- 2290's 55,000 lb is unloaded weight plus trailers plus the customary load. A 33,000 lb
  tractor pulling a loaded trailer is over the line. GVWR can put a truck **in**, and can
  never rule one **out**.
- The CMV definition uses the greater of GVWR, GCWR, GVW or GCW. The app holds only GVWR. A
  9,000 lb unit pulling a heavy trailer **is** a CMV and the app cannot see it.

Below 26,001 lb the app does not say BIT is off — it says unknown, because Veh. Code 34500
also reaches lighter trucks pulling trailers, placarded hazmat and buses.

### 4.4 CDL or not changes the whole drug and alcohol chapter

Everything in Part 382 and the Clearinghouse hangs off whether the driver must hold a CDL —
not on interstate commerce. An **intrastate** CDL driver is fully inside Part 382. A non-CDL
driver is outside it: no Clearinghouse queries, no random testing pool.

### 4.5 Ports and drayage change where Clean Truck Check sits

The Clean Truck Check consequence names "roadside and port enforcement". For a carrier running
port work, a CTC failure is a gate refusal — the load does not happen today. For a carrier who
never goes near a port, the same failure only bites at the next registration renewal, months
later. Same rule, two completely different urgencies, and the app carries no field that can
tell them apart.

### 4.6 For-hire or private changes tier 1

`fed.387.9.liability-insurance-filing` shows for every carrier because `RuleContext` has no
for-hire flag the rule reads. A private carrier hauling its own goods may owe no FMCSA filing
at all. **The number one item in the short list may not apply to you.** The rule row says this
about itself.

### 4.7 Fleet size and equipment change a few more

- `fed.396.11.dvir` — § 396.11(a)(5) exempts a carrier operating only **one** CMV. The rule
  does not read fleet size, so it shows for everyone.
- `fed.395.22.eld-backup-retention` — a carrier running on paper under a short-haul exception
  still sees this row.
- `ca_harassment_training` is 5+ employees. `ca_osha_300a_posting` electronic submission
  starts at 20 employees per establishment, so most carriers post the summary and send
  nothing. Neither rule reads an employee count.

### 4.8 Two dates in this catalogue will go wrong later

- **Clean Truck Check cadence changes on 2027-10-01.** OBD-equipped vehicles move from every 6
  months to every 3. The rule stores one fixed interval and cannot express "6 until this date,
  then 3". Agricultural vehicles and California motorhomes are annual and also cannot be
  expressed. Those dates will be wrong from October 2027.
- **The paper medical certificate exemption expires 2026-10-11.** For a CDL holder the proof
  is the CDLIS record, not the paper card. A separate FMCSA grant lets carriers rely on paper
  for 60 days from issue, and that grant has a date on it. Re-check it, do not assume it.

### 4.9 Things I could not rank because the code carries no citation

- `random_controlled_substances_testing_rate` and `random_alcohol_testing_rate` say "drivers
  placed out of service" in their consequence. The only citation on those rows is the employer
  penalty at 49 CFR 386 App. B(a)(3). I could not find, in this codebase, a citation for a
  roadside out-of-service order caused by a missed annual random-testing rate. I ranked them
  as audit findings (tier 4) on the penalty and the audit exposure, not as truck-stoppers.
  **This is my judgement disagreeing with the code — see 5.3.**
- `ca_ifta_license_renewal`'s consequence does not say what happens at the scale beyond
  "prior-year decals stop being honoured". I ranked it on the citation risk, not on an
  out-of-service risk, because the row does not claim one.
- `fed.usc.13906.operating-authority` gives no timeline for suspension, only for revocation
  (a compliance order plus 30 days of wilful non-compliance). I assumed suspension follows an
  insurance lapse quickly, because the insurance rule says the filing lapses 30 days after
  Form BMC-35/36 reaches FMCSA. That is an inference, not something the code states.

### 4.10 Nothing here is verified

`verifiedBy` and `verifiedOn` are empty on all 51 rule rows, on purpose, in all three files.
An unverified rule must look unverified. This ranking inherits that. A qualified person has to
confirm any of it before a carrier relies on it.

---

## 5. Where I disagree with the code's own `consequence` field

Four places. Stated openly rather than quietly re-ranked.

**5.1 `ca_ctc_vis_listing` is ranked too low by its own sentence.**
The row says: *"Fees and deadlines keep running against a vehicle you sold; a bought vehicle
sits unreported and non-compliant."* That reads like bookkeeping. It is worse than that. A
truck you bought and never listed in CTC-VIS cannot pass Clean Truck Check, and a Clean Truck
Check failure is an automatic DMV registration hold. A truck you cannot register is a truck
you cannot run. I put this in tier 2, not in a fees bucket. The 30-day clock and the fact that
it starts at a sale — an event the app only learns about if somebody types it — make it worse
still.

**5.2 `fed.396.17` — I agree with `eligibility.ts`, not with the rule row's tone.**
The rule row says *"Vehicle placed out of service at roadside... A parked truck is the bill,
not the fine"* — tier 1 language. `src/lib/dispatch/eligibility.ts` puts it in
`WARNING_RULE_CODES`, not `BLOCKING_RULE_CODES`, because an expired annual inspection does not
make the **driver** unqualified and a shop can do the inspection the same afternoon. I agree
with the code's decision and would not block dispatch on it. But it should be a **louder**
warning than the four other warn-level vehicle rows next to it: an expired annual inspection
is a near-certain out-of-service at any scale or port gate, where an overdue annual MVR is
invisible at roadside. Same severity field, different real risk.

**5.3 `random_*_testing_rate` — "drivers placed out of service" overstates it.**
See 4.9. The cited penalty is an employer fine of $19,246 per violation. I ranked these as
audit findings. If somebody can produce the citation for a roadside out-of-service order
arising from a missed annual random rate, move them to tier 2 and I am wrong.

**5.4 `ca_bit_inspection` — the consequence is right about the end and wrong about the speed.**
The row says *"Unsatisfactory terminal rating and CHP-initiated MCP suspension."* That is the
worst case at the end of a chain, not what happens when you miss one 90-day inspection. One
missed inspection does not suspend a permit. A pattern of them, found at a CHP visit that can
come at any time, does. So I ranked the individual row in tier 3 — and I ranked the
**aggregate** much higher, which is why 3.6 asks for a per-truck counter rather than a louder
row.

**5.5 `fed.387.9` — the sentence leads with the wrong half.**
The row says *"Financial-responsibility penalties up to $21,114 per day, then suspension and
revocation of the authority the filing supports."* The money is the least of it. The
suspension is what stops the trucks and what a broker's onboarding check reads the same day.
Lead the sentence with the suspension. This is a wording disagreement, but it has a ranking
consequence: because this rule resolves to `unsupported`, it currently sorts **below green
rows** on the dashboard and is **excluded from the digest email entirely**. That placement is
the single biggest mismatch between this ranking and the product as it stands.

---

## 6. Backlog

Discrete items somebody could pick up. Each says the problem it solves.

**B1. Add a "can you take a load today?" band to the top of `/app`.**
*Problem:* the two obligations that end the business — the FMCSA insurance filing and
operating authority — have no date, so they render in the "You have to check these yourself"
section at the bottom of the longest page in the app.

**B2. Add `impact` to `RuleDefinition` and use it as a secondary sort key.**
*Problem:* inside the Overdue section, rows are ordered only by how many days late they are,
so a record-retention row can sit above an expired medical card.

**B3. Let `impact: 'company'` items with no date into the digest email.**
*Problem:* `selectForRecipient` skips every `unsupported` item, so the insurance filing and
operating authority never appear in the only thing most owners read.

**B4. Add a "who cannot work today" line above the digest headline.**
*Problem:* the email leads with a count of overdue items, which does not tell the owner
whether a truck or a driver is actually stopped this morning.

**B5. Read `warningDays` from the rule row in `reachedWindow`.**
*Problem:* all 51 rules carry a hand-tuned warning window and nothing in production reads it.
Everything gets the same `[30, 7, 1, -1]`, so the 90-day items and the 7-day items are warned
about identically.

**B6. Make the dashboard's "coming up" window per-rule instead of a flat 45 days.**
*Problem:* `SOON_DAYS = 45` is too short for IRP, the medical card and Clean Truck Check, and
too long for the CTC-VIS 30-day clock.

**B7. Raise `cdl_expiry` warning from 60 days to 90.**
*Problem:* a CDL renewal needs a DMV appointment booked weeks out, and an expired CDL stops
the driver exactly as hard as an expired medical card, which already warns at 90.

**B8. Group the plating chain on the vehicle page.**
*Problem:* Form 2290, Clean Truck Check test, Clean Truck Check fee, CTC-VIS and the plate
renewal are one sequence shown as five unrelated rows, so the owner fixes the last one first
and finds it blocked.

**B9. Add a fleet-level BIT counter to `/app/vehicles`.**
*Problem:* the 90-day BIT inspection produces more rows than any other rule and each row looks
minor; what CHP reads is the pattern across the fleet, which no screen shows.

**B10. Move the six retention rules into a "Paper you must keep" section.**
*Problem:* a date that means "you may now destroy this" is shown with the same pill and the
same red as a date that means "this truck cannot roll".

**B11. Print `DateEditor.unaskable` on the date screen.**
*Problem:* `buildDateEditor` counts rows it cannot turn into a question, the page prints only
`unrecordable`, and the difference is a row the owner can see on the dashboard and cannot find
anywhere to answer.

**B12. Give rows whose `answerKey` is a rule code an entry in the anchor registry.**
*Problem:* the registry holds 28 keys and all of them are anchors, so any rule needing a "last
completion date" filed under its own code — the two `fed.396.21.*` retention rows among them —
can never be cleared from the dashboard.

**B13. Add an intrastate medical certificate rule to `california.ts`.**
*Problem:* all five federal medical rules return "not applicable" for a carrier marked
intrastate, California carries no replacement, so those carriers get no medical tracking and
the dispatch block for an expired medical card can never fire for them.

**B14. Split the employment rules into their own dashboard section.**
*Problem:* a Cal/OSHA posting date and an expired CDL sit next to each other on a phone and
look equally urgent.

**B15. Carry a `forHire` gate on `fed.387.9.liability-insurance-filing`.**
*Problem:* a private carrier is shown, as its highest-priority item, a filing it may not owe.

**B16. Store penalty amounts as data with an effective date.**
*Problem:* the 2025 figures are hard-coded into consequence strings, DOT appears to have
skipped the January 2026 adjustment, and a catch-up rule can land at any time — at which point
every number in the app is wrong with nothing to update in one place.
