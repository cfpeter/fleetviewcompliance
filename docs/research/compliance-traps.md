## 6. Things commonly got wrong

Each item below was verified against the primary text on 2026-09-14, not against secondary commentary. These are the ones that would produce a *wrong date* — the failure mode that matters most for a deadline product.

### T1. Citing § 390.19 for the MCS-150 biennial update. It is suspended, and it is Mexico-only.

**Wrong:** "MCS-150 biennial update — 49 CFR 390.19."
**Right:** The operative section is **§ 390.19T**. The eCFR carries this note on § 390.19: *"At 82 FR 5316, Jan. 17, 2017, § 390.19 was suspended, effective Jan. 14, 2017. At 88 FR 80184, Nov. 17, 2023, the suspension was lifted, § 390.19 was amended, and the section was again suspended indefinitely."* The current § 390.19 is titled *"Motor carrier identification reports for certain **Mexico-domiciled** motor carriers."* § 390.201 (the URS/MCSA-1 successor) is likewise suspended indefinitely.
[§ 390.19T](https://www.ecfr.gov/current/title-49/section-390.19T) · [§ 390.19](https://www.ecfr.gov/current/title-49/section-390.19)

### T2. Getting the MCS-150 digit logic backwards.

**Wrong (common):** "the first two digits", "the last digit picks the year."
**Right, verbatim from § 390.19T(b):** the table header reads *"USDOT No. **ending in** … Must file by **last day of**"* — so the **last digit selects the MONTH** (1=Jan … 9=Sep, **0=October**; there is no November or December). Then (b)(3): *"If the **next-to-last digit** of its USDOT Number is **odd** … shall file its update in every **odd-numbered calendar year**. If the next-to-last digit … is **even** … in every **even-numbered calendar year**."*

Worked: **USDOT 1234567** → last digit 7 = July; next-to-last 6 = even → **July 31 of even years** (2026, 2028). **USDOT 2345678** → last digit 8 = August; next-to-last 7 = odd → **August 31 of odd years** (2025, 2027).

It is due **even if nothing changed and even if the carrier has stopped operating**; the rule text is unconditional. Consequence per (b)(4): penalties under 49 U.S.C. 521(b)(2)(B) or 14901(a) **and deactivation of the USDOT number**.

### T3. Asserting a 30-day federal change-of-address deadline for a US carrier.

**Wrong:** "Carriers must file an updated MCS-150 within 30 days of an address or operations change."
**Right:** That 30-day rule lives in **§ 390.201(d)(4) — suspended indefinitely** since Nov 17, 2023, and in **§ 366.6(b)–(c) — suspended** since Jan 14, 2017. The operative **§ 366.6T** contains no 30-day clock, and operative **§ 365.413T** prescribes a procedure with **no deadline**. A 30-day rule does survive for Mexico-domiciled OP-1(MX) carriers. Treat 30 days as best practice, not as a currently enforceable FMCSR deadline for a domestic carrier.

### T4. Treating § 391.27 (driver's annual list of violations) as a live requirement.

**Wrong:** "Each driver must furnish an annual list of violations; keep the certificate in the DQF."
**Right:** **§ 391.27 is [Reserved]** — verified directly against the Part 391 text. It was removed by the *Record of Violations* rule, **87 FR 13209 (Mar. 9, 2022)**. The annual MVR review under § 391.25 absorbed it. § 391.51(b) no longer lists a violations certificate among DQF contents.
[Part 391 Subpart C](https://www.ecfr.gov/current/title-49/part-391) · [87 FR 13209](https://www.federalregister.gov/documents/2022/03/09/2022-04930/record-of-violations)

### T5. Believing supervisor reasonable-suspicion training is annual.

**Wrong:** "60+60 minutes of supervisor training, refreshed every year."
**Right:** **§ 382.603** ends with the sentence *"**Recurrent training for supervisory personnel is not required.**"* It is a **one-time, 120-minute** obligation per supervisor (60 min alcohol + 60 min controlled substances). Track it as one-time-per-person, not as an annual cycle. (Note: the *record* of that training must be kept while the person performs the function **and for two years after** they stop — § 382.401(b)(4).)
[§ 382.603](https://www.ecfr.gov/current/title-49/section-382.603)

### T6. Guessing the random testing rate, or looking for a 2026 Federal Register notice.

**Wrong:** "Check FMCSA's annual notice for the 2026 rate"; "the drug rate is 25%."
**Right:** The rates are **codified in the CFR itself**, not only announced by notice. § 382.305(b)(1): *"the minimum annual percentage rate for random **alcohol** testing shall be **10 percent** of the average number of driver positions."* § 382.305(b)(2): *"the minimum annual percentage rate for random **controlled substances** testing shall be **50 percent** of the average number of driver positions."*

FMCSA's most recent annual rate notice is **84 FR 71527 (Dec. 27, 2019)**, setting 50% for CY2020. **No FMCSA rate notice has been published since.** Under § 382.305(c)/(f), a changed rate takes effect the January 1 *following* publication — so absent a notice, the rate simply persists. **For 2026: 50% drugs / 10% alcohol.**
[§ 382.305](https://www.ecfr.gov/current/title-49/section-382.305)

### T7. Enforcing "random selections must be made quarterly."

**Wrong:** "The regulation requires at least quarterly random selections."
**Right:** § 382.305(k)(2) requires only that *"the dates for administering random alcohol and controlled substances tests conducted under this part are **spread reasonably throughout the calendar year**."* The word "quarter" does not appear in Part 382. Quarterly selection is near-universal industry practice and the safe default for a product, but it must be presented as **best practice**, not as a citable deadline.

### T8. Using "2 years" for negative drug test records.

**Wrong:** "Negatives: 2 years."
**Right:** § 382.401(b)(3) — **one year** for *"[r]ecords of negative and canceled controlled substances test results … and alcohol test results with a concentration of less than 0.02."* The **two-year** bucket is § 382.401(b)(2), *"[r]ecords related to the alcohol and controlled substances **collection process**"* (excluding EBT calibration). Five years covers positives, refusals, evaluations/referrals, calibration, program-administration records, and each annual MIS summary.

### T9. Confusing the Part 40 two-year lookback with the FMCSA three-year lookback.

**Wrong:** "Part 40 requires a three-year previous-employer check."
**Right:** Two different windows, both live:
- **49 CFR 40.25(b)** — request records from DOT-regulated employers *"during any period during the **two years** before the date of the employee's application or transfer."*
- **49 CFR 391.23(e)** — FMCSA's own investigation covers *"all previous DOT regulated employers that employed the driver **within the previous three years**."*

Deadlines also differ: § 40.25(d) bars safety-sensitive work **after 30 days** absent the information or a documented good-faith effort; § 391.23(c)(1) requires the replies (or good-faith documentation) in the **driver investigation history file within 30 days** of employment start; § 391.23(g)(1) gives a *previous* employer **30 days** to respond. Retention: § 40.25(i) three years from first safety-sensitive performance; § 391.53(c) duration of employment **plus three years**.

### T10. Keeping the medical examiner's certificate in the DQF for a CDL driver.

**Wrong:** "Every driver's DQF needs a copy of the current MEC."
**Right:** Under **§ 391.51(b)(6)(ii)**, for CDL holders the DQF item is the **CDLIS motor vehicle record** obtained from the current licensing State showing medical certification status — not the paper certificate. The transition provision that let a carrier use a copy of the MEC for up to 15 days *"[a]fter January 30, 2015, **and through June 22, 2025**"* has expired: the Medical Examiner's Certification Integration compliance date was **June 23, 2025** (extended there by **86 FR 32643**, June 22, 2021). Non-CDL drivers still need the certificate itself.

**But — live, expiring exemption.** Because NRII is not fully implemented in every State, FMCSA granted CVSA an exemption letting carriers and drivers in all States rely on a **paper MEC for up to 60 days from its issue date**. The current grant runs **April 11, 2026 – October 11, 2026** (**91 FR 19255**, Apr. 14, 2026), and has already been re-issued twice (effective Oct 13, 2025 and Jan 11, 2026). **It lapses 27 days from today.** A product must treat this as a dated feature flag, not a permanent rule, and re-check before Oct 11, 2026.
[91 FR 19255](https://www.federalregister.gov/documents/2026/04/14/2026-07173/qualification-of-drivers-commercial-vehicle-safety-alliance-application-for-exemption)

### T11. Requiring a no-defect DVIR.

**Wrong:** "Drivers must submit a DVIR every day for every vehicle."
**Right:** § 396.11(a)(2)(i): *"**Drivers are not required to prepare a report if no defect or deficiency is discovered** by or reported to the driver."* For property-carrying CMVs only a defect-bearing DVIR is required (the 2014 rule). Passenger-carrying operations and intermodal equipment differ. Also § 396.11(a)(5): the section does not apply to *"any motor carrier operating only one commercial motor vehicle."* Retention is **three months** (§ 396.11(a)(4)).

### T12. Treating the annual inspection report as an office document.

**Wrong:** "File the annual inspection report at the terminal."
**Right:** Two separate obligations. § 396.17(c): a CMV may not be used unless it passed an inspection *"at least once during the preceding 12 months **and documentation of such inspection is on the vehicle**"* — the proof (report **or** a sticker/decal carrying the four required data elements) physically travels with the unit. Separately, § 396.21(b)(1) requires the original or a copy be retained **fourteen months**, *"where the vehicle is either housed or maintained."* Note also that each unit in a combination — tractor, semitrailer, full trailer, converter dolly — is inspected **separately** (§ 396.17(a)).

### T13. Applying § 396.3(b) maintenance records to every vehicle.

**Right:** § 396.3(b) requires the maintenance record file only for *"each motor vehicle they control for **30 consecutive days**"* — short-term rentals fall outside it. Retention (§ 396.3(c)): **1 year**, and **6 months after the vehicle leaves the carrier's control**, kept *"where the vehicle is either housed or maintained."*

### T14. Mixing up the two DQF retention clocks.

**Right:** § 391.51(c) — the qualification file is kept *"for as long as a driver is employed … **and for three years thereafter**."* § 391.51(d) separately allows five specific items to be **purged from the file three years after the date of execution** while the driver is still employed: the annual-inquiry MVR, the annual-review note, the medical certificate / CDLIS MVR, any FMCSA medical variance or SPE certificate, and the National Registry verification note. A product that models only one of these two clocks will either over-retain or delete something it must keep.

### T15. Assuming the 2026 civil penalty figures are newer than 2025.

**Right:** DOT's most recent civil-penalty inflation adjustment is *Revisions to Civil Penalty Amounts, 2025*, **89 FR 106282 (Dec. 30, 2024)**. **No 2026 adjustment has been published** as of 2026-09-14, so the amounts now in 49 CFR Part 386 Appendix B are the 2025-adjusted ones: recordkeeping **$1,584/day up to $15,846**; non-recordkeeping **up to $19,246**; driver non-recordkeeping **up to $4,812**; financial-responsibility **$21,114/day**; operating without authority **minimum $13,676**; operating after a final "unsatisfactory" rating **up to $34,116** (**$102,348** hazmat, **$238,809** if death/serious injury). Treat any figure elsewhere labelled "2026-adjusted" as suspect.

### T16. Quoting stale UCR fees, or missing the increase that lands in two weeks.

**Right:** Registration years 2025–2026 (49 CFR 367.50, being redesignated 367.40): B1 (0–2) **$46**, B2 (3–5) **$138**, B3 (6–20) **$276**, B4 (21–100) **$963**, B5 **$4,592**, B6 **$44,836**. **Registration year 2027 and subsequent** (new § 367.50, **91 FR 56063**, Sept. 1, 2026, **effective Oct. 1, 2026**): B1 **$55**, B2 **$167**, B3 **$333**, B4 **$1,163**, B5 **$5,548**, B6 **$54,165** — an average **+20%**, described by FMCSA as a single increase that then persists until a future rulemaking. UCR 2027 registration **opens October 1, 2026**, so a 10-truck carrier is about to owe **$333**, not $276.

Also: the power-unit count is **not** necessarily the MCS-150 figure. 49 U.S.C. 14504a(f)(3) makes it an **either/or election** — the most recently filed MCS-150 count **or** the total owned/operated for the 12 months ending **June 30** of the prior year — and CMVs used exclusively in intrastate transportation of property, waste, or recyclable material may be excluded.

### T17. Assuming the $750,000 insurance minimum has gone up.

**Right:** 49 CFR 387.9 Table 1 still reads **$750,000** for for-hire nonhazardous property (GVWR ≥ 10,001 lb); **$1,000,000** for oil and most hazmat; **$5,000,000** for bulk high-hazard commodities. The 2014 ANPRM was formally withdrawn at **82 FR 25753** (June 5, 2017) for insufficient data, and the July 2026 technical-corrections rule (91 FR 45653) touched § 387.9 without changing any amount. No rulemaking raising it exists as of today.

### T18. Modelling operating authority as something that "expires."

**Right:** Authority has no fixed expiration. **49 U.S.C. 13906(a)(1)**: *"A registration remains in effect **only as long as the registrant continues to satisfy the security requirements**."* The recurring obligation to track is therefore the **insurance policy renewal**, plus the cancellation chain: § 387.7(b)(1) requires **35 days'** notice between insurer and insured, and § 387.313T(d) makes an FMCSA filing non-cancellable until **30 days after** written notice on Form BMC-35/BMC-36 reaches FMCSA. That 30 days is a **pre-lapse notice period**, not a post-lapse grace period — a widespread misreading.

### T19. Expecting the hazmat "security awareness" and "recurrent" clocks to be the same.

**Right:** § 172.704(c)(2) — recurrent hazmat training *"at least once every **three years**."* But § 172.704(a)(4) gives new hazmat employees **90 days** from employment for security awareness training, and § 172.704(c)(1)(ii) gives **90 days** for the full initial training (they may work under direct supervision of a trained employee meanwhile). In-depth security training (only where a § 172.800 security plan is required) is every three years **or within 90 days of implementing a revised plan**, whichever comes first. Records: § 172.704(d) — current training inclusive of the preceding three years, kept for employment **plus 90 days**.

### T20. Forgetting that FMCSA's registration plumbing is changing underneath all of this.

**Right:** FMCSA announced **Motus**, its replacement registration system, at **91 FR 23144 (Apr. 29, 2026)** (corrected 91 FR 24643). Phase I went live **Dec. 8, 2025**; Phase II was planned for Q2 2026. Motus will sunset URS, the FMCSA Portal, MCMIS's registration components and the legacy L&I system, and will carry the biennial update. Elimination of MC numbers, safety registration, and BOC-3 process changes were **deferred** after stakeholder objection. FMCSA said it anticipated a **Spring 2026 rulemaking** to mandate Motus — **that NPRM has not been published**. Critically, **nothing in Motus changes the 24-month cadence or the digit-derived schedule**; it changes the filing channel only.
