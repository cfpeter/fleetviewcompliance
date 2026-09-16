# FleetView — Market & Product Research

**Prepared:** 2026-09-14
**Scope:** Competitive landscape, user pain points, module requirements, SMS/email infrastructure, marketing site strategy
**Target user:** Small trucking fleet owners, 5–50 trucks, LA/Glendale CA area, many immigrant-owned family carriers

---

## Verification legend

- **[V]** — figure taken from the vendor's own published page (fetched directly)
- **[T]** — third-party review site / analyst (Capterra, G2, SelectHub, trade press) — directionally reliable, not authoritative
- **[UNVERIFIED]** — competitor-comparison blog, SEO content farm, or a single secondhand claim. **Do not quote in marketing material.** Much of the "pricing guide" content in this vertical is adversarial SEO written by competing TMS vendors.

A note on research quality in this vertical: searches for TMS pricing return an unusually high proportion of vendor-authored comparison pages ("X vs Y: honest comparison") designed to rank against competitors. I have flagged these. The genuinely published prices are a small minority — which is itself the single most actionable competitive finding in this report (see §E).

---

# A. Competitive landscape

## A.1 Market shape

- ~580,000 active FMCSA-registered carriers; **91.5% operate 10 or fewer trucks**, 99.3% operate fewer than 100 power units; roughly two-thirds operate two trucks or fewer. [T] ([Small Fleet HQ](https://smallfleethq.com/owner-operator/trucking-statistics), [AtoB](https://atob.com/blog/owner-operator-statistics))
- FMCSA A&I registration statistics are the primary source and can be queried directly: [ai.fmcsa.dot.gov/RegistrationStatistics](https://ai.fmcsa.dot.gov/RegistrationStatistics)
- Average operating cost hit a record **$2.336/mile in 2025** (up 3.4%); **$1.854/mile excluding fuel** (up 4.2%). Largest increases: tolls +13.2%, repair & maintenance +8.6%, driver benefits +6.6%, tires +6.4%. Fuel $0.48/mi, R&M $0.215/mi. Non-driver (office/admin) staffing was cut 7.8% industry-wide. [T] ([ATRI 2026 via Heavy Duty Trucking](https://www.truckinginfo.com/news/trucking-fleets-faced-record-operating-costs-during-third-year-of-freight-recession), [FleetOwner](https://www.fleetowner.com/news/news/55391195/atri-releases-2026-trucking-operational-cost-report-for-fleet-benchmarking))

**Strategic read:** carriers cut back-office headcount 7.8% in a single year while costs hit records. That is the wedge — software that removes an admin seat, not software that requires one.

---

## A.2 Compliance-focused products

### J.J. Keller Encompass
- **What it does:** DQ file management, drug & alcohol program administration, ELD/HOS, vehicle maintenance & inspection records, training, CSA/BASIC monitoring. The incumbent brand — J.J. Keller has sold DOT compliance forms and binders since long before software.
- **Pricing:** ~**$25.50/vehicle/month** base; up to **$59/truck/month** with their tablet; **+$3.50/month per driver** when drivers exceed vehicles. DQ Managed Service, drug & alcohol program, and training are all quoted separately on top. [UNVERIFIED — figures come from a competitor comparison page ([Dockex](https://dockex.io/vs/jj-keller)); J.J. Keller does not publish list pricing on [jjkeller.com](https://www.jjkeller.com/shop/j-j-keller-encompass-fleet-management-system)]
- **Target:** mid-size to large fleets with a dedicated safety manager.
- **Weaknesses (reported):** "clunky," dated UI, steep learning curve, slowness, and complexity that grows with the org. Note: many of the harshest Capterra "Encompass" reviews are for **Encompass360 / ICE Mortgage's Encompass** — a different product with the same name. Treat aggregated review scores for "Encompass" with suspicion. The recurring J.J. Keller-specific complaint in trade discussion is **module-by-module upsell**: base platform, then DQ managed service, then drug/alcohol, then training, each a separate line item.

### Foley (foleyservices.com / foley.io)
- **What it does:** DQ files, DOT drug & alcohol program + consortium/C-TPA, Clearinghouse pre-employment and annual queries, MVR/PSP monitoring, background screening, compliance alerts, "Navigator AI" guidance, audit support.
- **Pricing:** three tiers — **Essential** (small fleets/owner-operators), **Professional** (adds CSA monitor with email alerts, MVR & PSP ongoing monitoring, audit support), **Power** (adds document review service, HCM integrations). **No dollar figures published**; demo/sales-contact gated. [V — fetched [foley.io/pricing](https://www.foley.io/pricing), confirmed prices absent]
- **Weakness:** the entire purchase is gated behind a sales call. For a price-sensitive 8-truck carrier this is friction, and it is the clearest opening for a self-serve competitor.

### DOT Compliance Group / the outsourced-compliance category
This is a fragmented category of service bureaus rather than software. Published per-driver/month rates across the category:
| Provider | Price | Source |
|---|---|---|
| DOTDriverFiles Pro | **$5/driver/mo** (or $50/driver/yr) | [T] [dotdriverfiles.com/pricing](https://dotdriverfiles.com/pricing/) |
| DOTDriverFiles Pro+ | **$5/driver + $2/vehicle per month** | [T] |
| DotFleet Compliance | **$30/driver/mo** (outsourced DQ file mgmt) | [T] [dotfleetcompliance.com](https://www.dotfleetcompliance.com/) |
| My Safety Manager | **$49/driver/mo** (full service) | [T] [mysafetymanager.com](https://www.mysafetymanager.com/) |
| Category: "basic packages" | $50–$100/driver/mo | [UNVERIFIED] |
| Category: "full service" (audits, training, records) | $100–$250/driver/mo | [UNVERIFIED] |
| Driver compliance software generally | $150–$1,200/mo ($1,800–$14,000/yr) | [T] [AvatarFleet](https://www.avatarfleet.com/blog/how-much-does-driver-compliance-software-cost) |

**This is the key pricing corridor for FleetView.** A pure software play at $5–$30/driver/month is a credible, already-validated price point. The $100–$250/driver/month tier is service labor, not software — don't compete there.

### Simplex Group
- **What it does:** full-service outsourced back office for small carriers — DOT compliance, authority setup, IFTA, permits, drug testing, dispatch services. **Explicitly targets the LA market** (dedicated [Los Angeles page](https://simplexgroup.net/los-angeles/), plus Houston, Dallas) and is well known among immigrant-owned carriers.
- **Pricing:** not published. Claims "no hidden fees and no monthly minimums." [V — fetched, no numbers]
- **Why they matter to you:** Simplex is likely your *actual* competitor in Glendale, not McLeod. Their product is a human who handles it. Your pitch is not "cheaper than Simplex" — it is "see what Simplex is doing for you, and catch what they miss."

### Tenstreet
- **What it does:** driver recruiting and onboarding — IntelliApp application, applicant tracking, onboarding paperwork, DQ file, ongoing driver management. Dominant in driver recruiting.
- **Pricing:** **not published.** "Tenstreet's pricing is not rigid… depends on the number of products and services used, the size of your fleet." Annual contract not required. [V — fetched [tenstreet.com/pricing](https://www.tenstreet.com/pricing)]
- Third-party estimate: **$300–$2,500+/month** depending on power units. [UNVERIFIED]
- They have a pay-as-you-go "Tenstreet On-Demand" aimed at smaller fleets. [T]
- **Adjacent, not competitive.** A 10-truck family carrier is not running a recruiting funnel. Ignore.

### Luma Brighter Learning
- **What it does:** mobile-first LMS for driver training — safety training, ELDT (entry-level driver training), compliance-driven microlearning.
- **Pricing:** **not published anywhere.** Sales contact only (sales@learnwithluma.com). [V]
- **Adjacent, not competitive.** Training content is a different business. At most, a future "training completion" deadline type in your tracker.

---

## A.3 TMS for small fleets

### Truckbase — *your closest competitor, study this one*
- **What it does:** dispatch, AI rate-confirmation PDF importer ("zero data entry"), document management, invoicing, driver settlements, truck tracking with 30+ ELD integrations, EDI, QuickBooks sync. Explicitly positions for **5–50 truck carriers** — the identical segment.
- **Pricing:** **not published on their site.** Minimum **$290/month billed annually**, typical ~**$490/month**; modeled at $250–$375/mo for 10 trucks / 3 users and $500–$625/mo for 25 trucks / 5 users. **Per-user, not per-truck** — cost rises as you add office staff. [T/UNVERIFIED — Capterra + competitor comparison pages]
- **Weaknesses (Capterra, verified reviews):** AI rate-con import misses fields and every load still needs checking; duplicate and incorrect addresses that users can't delete; **reporting called "weak" by a verified CEO reviewer**; filters don't persist between sessions; **no monthly billing option — annual only**; no native payroll; thin self-serve training (live sessions only, no video library); no rate-con/BOL thumbnails on the order screen; slow bulk downloads; **no free trial — demo-only sales with a money-back guarantee**. [T] ([Capterra](https://www.capterra.com/p/10002334/Truckbase/reviews/))

> Every one of those weaknesses is a product decision you can make differently on day one: publish the price, bill monthly, offer a trial, persist filters, and build reporting as a first-class module rather than an afterthought.

### TruckingOffice — *the price floor*
- **What it does:** dispatch, invoicing, driver pay, IFTA, maintenance logs, expense tracking. Old-school but honest.
- **Pricing [V — fetched [truckingoffice.com pricing](https://www.truckingoffice.com/tms/transportation-management-system-pricing/)]:**

| Plan | 1–2 trucks | 3–7 trucks | 8+ trucks | Broker |
|---|---|---|---|---|
| Basic (FTL) | $25/mo | $55/mo | $90/mo | $45/mo |
| Pro (FTL + LTL) | $35/mo | $75/mo | $130/mo | — |

  PC*MILER routing add-on: +$5/mo (≤2 trucks), +$15/mo (≤7), +$25/mo (≤15, then $2/truck). **30-day free trial, no credit card.**
- **This is the number your prospects will anchor on.** A 10-truck carrier's mental price for "trucking software" is $90–$130/month, not $490.

### Axon Software
- **What it does:** fully integrated trucking ERP — dispatch, accounting, payroll/settlements, IFTA, maintenance. Real-time accounting is the differentiator (a dispatch entry immediately hits the books).
- **Pricing:** **not published.** Analyst estimates ~$65/user/month entry, custom quotes, with **implementation quotes above $25,000** reported by buyers. [UNVERIFIED]
- **Weakness:** implementation cost and length. Wrong fit below ~25 trucks.

### McLeod (LoadMaster / PowerBroker)
- **What it does:** the enterprise standard. LoadMaster for carriers (500–5,000 trucks), PowerBroker for brokerages.
- **Pricing:** LoadMaster **$200,000–$500,000/year**; PowerBroker **$50,000–$150,000/year**; implementation **$100,000–$500,000**. [UNVERIFIED — vendor-competitor blogs; McLeod publishes nothing]
- **Explicitly not a competitor**, but it is *culturally* relevant: Truckbase's best testimonial is a customer saying they'd pick Truckbase "10/10 times over a system like McLeod." McLeod is the boogeyman small carriers cite when they say software is too much.

### Rose Rocket
- **Pricing [V — fetched [roserocket.com/pricing](https://www.roserocket.com/pricing)]:** **Full Service Platform from $2,080/month** flat, unlimited users, unlimited custom fields/objects/boards/automations, 3 AI agents (TED/Rosie/Rocky), order+quote+load mgmt, dispatch, track & trace, invoicing/freight audit, HOS/DOT/FMCSA compliance monitoring, 40+ integrations, mobile apps, SOC 2 Type II, white-glove implementation with 90-day go-live guarantee. Enterprise = custom.
- **Priced per load, not per truck.** [T]
- **Target:** small-to-mid carriers and brokers with real ops complexity, plus enterprise. **$2,080/month is ~10–20× what your buyer will pay.** Not a competitor for 5–50 trucks despite the marketing claim; it is a competitor for 50–500.
- **Weakness:** onboarding can be lengthy for complex operations; limited 24/7 support in some regions. [T]

### Alvys
- **Pricing:** **not published.** "Transparent pricing — pay by the month or save with annual plans," no setup fees, unlimited users, no long-term contracts, 120+ integrations. [V — fetched [alvys.com/pricing-info](https://alvys.com/pricing-info), confirmed no numbers despite the page being titled "pricing"]
- Third-party figures: starts at **$514** (one source), **$183/month** (another), billed **by monthly load volume**. [UNVERIFIED — mutually inconsistent]
- **Weaknesses:** complexity, slow onboarding, impersonal support cited as switching reasons; data discrepancies between reports; one Capterra user reported a **26-day wait** for an IFTA fix; reporting not customizable enough; can't search multiple loads. Support is *also* frequently praised — quality appears inconsistent. [T] ([Capterra](https://capterra.com/p/249961/Alvys-TMS/reviews/))

### Tailwind TMS
- **Pricing:** **Pro $99/user/mo** (25 loads/mo), **Enterprise $149/user/mo** (50 loads/mo, API, carrier portal), **Unlimited $199/user/mo** (unlimited loads, Power BI reporting). No contracts, free trial. [T — Capterra/GetApp; not verified on vendor site]
- **Weakness:** **double-metered — per user AND load-capped.** Reviewers say extra users are costly and it gets expensive for small companies. A 3-person office on Pro is $297/month for 25 loads.

### ProTransport
- **Pricing:** from **$5,000 per installation**; ~**$800/month** for a mid-sized company; serves 1–500 trucks. [UNVERIFIED]
- ("EnVue" did not surface in any search — I could not confirm that product name exists.)

### LoadOps (Optym, formerly Axele)
- **Pricing:** from **$75/driver/month**, billed annually. [T — SelectHub/SoftwareConnect]
- Built around owner-operators and small carriers; Motive/Samsara ELD integration with basic HOS visibility, though less tightly woven into dispatch than competitors. [T]
- At 10 drivers that's $750/month — **above Truckbase**. Per-driver pricing punishes exactly your segment.

### Super Dispatch (auto haulers)
- **Pricing:** **free tier** (Driver App + Carrier TMS + Super Loadboard access) for owner-operators and small carriers; **Carrier Pro from $55/month for one user**, priced **per seat** — every driver, dispatcher, and admin is a seat. 3 drivers + 1 dispatcher = 4 seats. [T — could not fetch superdispatch.com directly (403); figures from [superdispatch.com/blog/tms-software-cost](https://superdispatch.com/blog/tms-software-cost/) summary and G2]
- **The free tier is strategically instructive:** they give away the TMS to own the marketplace. Worth noting there is significant auto-hauler presence in the LA/Glendale Armenian and Russian-speaking carrier community — if that is your network, Super Dispatch is an entrenched incumbent there specifically.

### Truckin Digital
- Marketed as a blockchain-flavored TMS with ERP ambitions. Negligible presence in small-carrier discussion; no reliable pricing surfaced. [UNVERIFIED] Low priority.

---

## A.4 Fleet maintenance / asset

### Fleetio
- **Pricing:** **Essential $4/vehicle/mo** (annual) or $5 (monthly); **Professional $7/vehicle/mo** (annual only, adds outsourced maintenance, parts, API); **Premium $10/vehicle/mo** (annual only, adds POs, service tasks, tire management). Unlimited users on all plans. Tools add-on ~$0.50/asset/mo. [T — [fleetio.com/pricing](https://www.fleetio.com/pricing) returned 403 to direct fetch; figures consistent across Capterra, G2, TrustRadius]
- **Weaknesses:** customer support accessibility (one user reported no support after full integration), billing disputes, contract-cancellation friction, dated interface vs. Samsara/Motive, promotional-pricing cliffs. Still rates 4.7/5 on Capterra across 211 reviews. [T]
- **$4–$10/vehicle/month with unlimited users is the benchmark a modern per-vehicle SaaS can hit.** That's $40–$100/month at 10 trucks.

### Whip Around
- **Pricing:** **Basic free** (1 vehicle, 1 user); **Standard $5–6/asset/mo** (inspections, defects, compliance, fuel); **Pro $10–11/asset/mo** (adds maintenance, work orders, documents, inventory); **FixedUnlimited** for unlimited assets at a flat price. Unlimited users on all plans; no contracts; monthly. [T — sources give $5/$10 and $6/$11; vendor page [whiparound.com/pricing](https://whiparound.com/pricing/)]
- DVIR/inspection-first. Strong free tier for the true owner-operator.

### Samsara / Motive (telematics + fleet modules)
| | Motive | Samsara |
|---|---|---|
| Software | ~$25/vehicle/mo base; $35–45 with AI dashcam | ~$27–33/vehicle/mo; **$33–45/truck/mo** for ELD-capable tier |
| Hardware | — | $99–$148/vehicle one-time |
| Minimum contract | **12 months** | **36 months** |
All [UNVERIFIED] — neither vendor publishes pricing; figures are customer-reported via third parties. ([tech.co](https://tech.co/fleet-management/samsara-vs-motive), [Airpinpoint](https://airpinpoint.com/compare/samsara-pricing))

- **Samsara's contract terms are the loudest complaint in the entire category:** 36-month commitment with auto-renewal, no flexibility to downsize the fleet, and written cancellation required ≥30 days before expiry. BBB complaints include a **$10,000 auto-renewal charge** appearing on a card from a three-year-old contract with no notice, and a customer who tried to cancel for ~2 years but was auto-renewed for 3 more because the notice "didn't include the right information." Trustpilot average 3.2/5. [T] ([BBB](https://www.bbb.org/us/ca/san-francisco/profile/electronics-and-technology/samsara-1116-881058/complaints), [Airpinpoint](https://airpinpoint.com/blog/samsara-lawsuit-contract-trap), [Trustpilot](https://ca.trustpilot.com/review/www.samsara.com?page=4))

> **This is your single best marketing asset.** "Month to month. Cancel anytime. No 36-month contract." lands hard with anyone who has been through a Samsara renewal.

---

## A.5 What small carriers actually use (the real competitor)

**Google Sheets.** Repeatedly and unambiguously. Fleets have reached **20+ trucks** on spreadsheets before they break. FreightWaves has published guides on running 90% of a trucking business from a single spreadsheet. [T] ([FreightWaves](https://www.freightwaves.com/news/how-to-use-a-single-spreadsheet-to-manage-90-percent-of-your-trucking-business))

Others in the "dispatch-lite" bucket:
- **AscendTMS** — free tier, widely tried by startups; the TruckersReport thread has a 5-truck owner saying it "doesn't meet my expectation." [T]
- **ITS Dispatch** (Truckstop) — ~$100/mo; the same owner rated it *worse* than a $37/mo alternative. [T]
- **WhatsApp + phone calls + a filing cabinet** — Truckbase's own homepage names "Spreadsheets & WhatsApp" as the competitor to beat. [V]

**Implication:** your onboarding must beat a spreadsheet on minute one, not on month three. If the first session doesn't produce something better than the sheet they already have, they go back to the sheet.

---

## A.6 Comparison table

| Product | Category | Published price? | Real pricing | Basis | Contract | Free trial |
|---|---|---|---|---|---|---|
| **TruckingOffice** | TMS | ✅ **Yes** | $25–$130/mo by truck band | Truck band, flat | Monthly | ✅ 30 days, no CC |
| **Fleetio** | Maintenance | ✅ Yes | $4 / $7 / $10 per vehicle/mo | Per vehicle, unlimited users | Annual for Pro/Premium | Yes |
| **Whip Around** | Inspections | ✅ Yes | Free / ~$5–6 / ~$10–11 per asset/mo | Per asset, unlimited users | None | Free tier |
| **Super Dispatch** | TMS (auto) | ✅ Partial | Free tier; Carrier Pro from $55/mo | **Per seat** (drivers count) | Monthly | Free tier |
| **Tailwind TMS** | TMS | ✅ (3rd-party) | $99 / $149 / $199 per **user**/mo | Per user **+ load caps** | None | Yes |
| **LoadOps (Optym)** | TMS | ❌ | ~$75/driver/mo | Per driver | Annual | — |
| **Rose Rocket** | TMS | ✅ **Yes** | **From $2,080/mo** | Per load, flat platform fee | Monthly | — |
| **Truckbase** | TMS | ❌ | ~$290 min → ~$490/mo typical | **Per user** | **Annual only** | ❌ Demo only |
| **Alvys** | TMS | ❌ | ~$183–$514/mo (conflicting) | Monthly load volume | None claimed | — |
| **Axon** | TMS/ERP | ❌ | ~$65/user/mo + **$25k+ implementation** | Per user | Custom | — |
| **ProTransport** | TMS | ❌ | ~$800/mo + $5,000 install | Custom | Custom | — |
| **McLeod LoadMaster** | TMS | ❌ | $200k–$500k/yr + $100k–$500k impl. | Enterprise | Multi-year | ❌ |
| **J.J. Keller Encompass** | Compliance | ❌ | ~$25.50–$59/truck/mo + $3.50/driver | Per vehicle + per driver | — | — |
| **Foley** | Compliance | ❌ (tiers only) | Not disclosed | Per driver | — | ❌ |
| **DOTDriverFiles** | Compliance | ✅ Yes | $5/driver/mo (+$2/vehicle on Pro+) | Per driver | Monthly/annual | — |
| **DotFleet** | Compliance | ✅ Yes | $30/driver/mo | Per driver | — | — |
| **My Safety Manager** | Compliance svc | ✅ Yes | $49/driver/mo | Per driver | — | — |
| **Simplex Group** | Compliance svc | ❌ | Not disclosed | Custom | "No minimums" | — |
| **Tenstreet** | Recruiting | ❌ | ~$300–$2,500+/mo | Custom | Optional annual | — |
| **Motive** | Telematics | ❌ | ~$25–$45/vehicle/mo | Per vehicle | **12 mo min** | — |
| **Samsara** | Telematics | ❌ | ~$27–$45/vehicle/mo + $99–148 hw | Per vehicle | **36 mo min, auto-renew** | — |
| **Google Sheets** | 🏆 incumbent | ✅ | **$0** | — | None | ∞ |

**The pattern:** of 21 products, **6 publish a real price**. Of those 6, four are the cheapest in their category. Publishing your price is both a differentiator and a qualification gate.

---

# B. What small fleet owners actually complain about

Themes, with the sourced sentiment behind each. (Paraphrased — quotes kept short.)

### 1. Price shock and per-seat pricing
A 5-truck owner in Irvine, CA posted a quote of **"$700 startup and $585 per month for just one user,"** with more per additional user, and said flatly: *"I was expecting like $250 per month."* He questioned whether $600/month for an advanced TMS made any sense for a small fleet. His budget alternatives at the time: a $37/month system he called a cheap web-based TMS, and ITS Dispatch at $100/month which he rated **worse** than the $37 one. ([TruckersReport](https://www.thetruckersreport.com/truckingindustryforum/threads/transportation-management-system-tms.1293749/))

This is the canonical small-carrier software experience: the affordable options are bad, and the good options are priced for a 200-truck fleet.

**Per-seat pricing is uniquely hostile to this segment.** A family carrier has the owner, his wife doing invoices, a cousin dispatching, and a bookkeeper. That's 4 seats before a single truck moves. Tailwind at $99/user = $396/month. Super Dispatch counts *drivers* as seats. Truckbase's cost rises with office staff, not trucks.

### 2. Contract lock-in
Samsara's 36-month auto-renewing contract is the most-complained-about term in the industry. Documented BBB complaints: a **$10,000 auto-renewal** on a three-year-old contract with no prior notification; a customer who tried to cancel for two years and was auto-renewed for three more because the cancellation notice "didn't include the right information"; customers placed into auto-renewing terms without authorization. Fleetio draws similar complaints about contract-cancellation friction and billing disputes. Truckbase is **annual-billing only with no monthly option**. ([BBB](https://www.bbb.org/us/ca/san-francisco/profile/electronics-and-technology/samsara-1116-881058/complaints), [Capterra – Truckbase](https://www.capterra.com/p/10002334/Truckbase/reviews/))

### 3. Data entry burden — the thing they hate most
Truckbase's entire homepage is built on "Zero Data Entry," which tells you what the segment complains about. And yet their own reviewers say the **AI rate-con importer misses fields and every load still has to be double-checked**. Manual IFTA filing alone runs **4–8 hours per quarter**. ([Capterra](https://www.capterra.com/p/10002334/Truckbase/reviews/), [FleetCollect](https://fleetcollect.net/blog/how-to-file-ifta))

### 4. Software that requires a full-time admin
> Small fleets report entry price points high enough that it's hard to justify **without a dedicated onboarding team** to get full use out of it. Fleets of 1–20 trucks need tooling in the **$30–$150/month** range to stay compliant **without an in-house compliance officer**. ([hrforge](https://www.hrforge.co/blog/dot-compliance-software-small-fleets-compared-b6f12), [Oculus](https://www.oculusreviews.com/blog/best-dot-compliance-software-small-fleets-2026))

Axon's $25,000+ implementation quotes and McLeod's $100k+ implementations are the extreme version. But the same dynamic operates at the small end: a product with 40 configurable screens is a product nobody configures.

### 5. Onboarding friction and no trial
Truckbase: **no free trial, demo-only sales cycle**, money-back guarantee instead. Foley, Tenstreet, Alvys, Axon, J.J. Keller: all sales-gated. Alvys users cite **slow onboarding** and complexity as reasons for switching away. Rose Rocket's onboarding "can be lengthy for complex operations." ([Capterra](https://capterra.com/p/249961/Alvys-TMS/reviews/), [SelectHub](https://www.selecthub.com/tms-software/alvys-vs-rose-rocket/))

### 6. Weak reporting and inability to answer basic questions
A verified CEO reviewer of Truckbase called reporting **"weak."** Alvys reviewers report **data discrepancies between different reports in the same system**, reporting that isn't customizable enough for real analysis, and an inability to search multiple loads at once. This is the gap between "the software stores my data" and "the software tells me whether I made money."

### 7. Support that varies wildly
One Alvys user waited **26 days** for an IFTA issue to be fixed — while other reviewers call Alvys support a genuine differentiator. Fleetio support is described as **agent-dependent: some tickets excellent, others drag for weeks**; one user reported having no support at all after integration was complete. ([Capterra](https://www.capterra.com/p/120855/Fleetio/reviews/))

### 8. Being sold modules they don't need
J.J. Keller's structure — base platform, then DQ managed service, then drug & alcohol, then training, each separately quoted — is the archetype. Truckbase reviewers note no native payroll despite settlements. Tailwind gates API access and the carrier portal behind a higher tier and *still* caps loads.

### 9. Fragility and trust
Reviewers report duplicate and incorrect addresses in Truckbase that **users cannot delete**, filters that don't persist between sessions, and no document thumbnails on the order screen. Small things, but they're the things that make a dispatcher reopen the spreadsheet.

### 10. Language — the underserved axis
This is real and quantified:
- A large share of US trucking is run by **Russian-speaking dispatchers** managing small fleets in Chicago, Sacramento, Philadelphia, Spokane — *"the back office runs in two languages at once: Russian with the driver and English with the broker,"* which slows operations and causes expensive mistakes. ([Numeo](https://numeo.ai/blog/russian-speaking-dispatchers-and-ai-how-multilingual-freight-workflows-change))
- **TruckX** shipped its ELD and fleet apps in **Spanish and Punjabi** specifically so non-English-speaking drivers don't misunderstand the device. ([TruckX](https://truckx.com/eld-in-two-new-languages/))
- **AsyncCraft** markets an AI dispatcher that texts drivers in **Punjabi, Hindi, Spanish, or English**. ([AsyncCraft](https://dispatch.asynccraft.com/))
- ~3.3 million Hispanic-owned businesses in the US; many owners prefer to research B2B solutions in Spanish. ([Digital Commerce 360](https://www.digitalcommerce360.com/2018/07/11/to-win-over-hispanic-b2b-buyers-speak-their-language-online/), [MediaPost](https://www.mediapost.com/publications/article/316301/got-a-b2b-website-localize-it-for-spanish-speakin.html))

No incumbent TMS or compliance platform in section A ships a non-English UI. For Glendale specifically — Armenian, Spanish, Russian — this is an open flank.

### 11. Compliance specifically: "if it's not documented, it didn't happen"
> Almost every violation a small carrier receives is a **documentation failure, not a driving failure.** Auditors check the DQ file for every driver and one missing document is a violation. They look for missing signatures, expired documents, and gaps in testing or inspection records. **Missing annual Clearinghouse queries have become one of the most common audit findings** because the requirement is new enough that carriers still overlook it. ([FreightWaves](https://www.freightwaves.com/news/what-every-small-carrier-should-know-before-their-first-dot-audit), [LogRock](https://www.logrock.com/uncategorized/trucking-paperwork/))

The same TruckersReport thread that complained about pricing also complained about **lost inspection papers causing audit failures**. That is your product in one sentence.

---

# C. Feature requirements by module

Opinionated. Where I recommend cutting something, I say so.

## C.1 Compliance / deadline tracker — *this is the wedge, build it first*

### Entity types (the compliance subject)
1. **Carrier (the company)** — one per USDOT. Attributes auto-pulled from FMCSA (see below).
2. **Vehicle (power unit)** — VIN, unit #, plate + state, GVWR, year/make/model, fuel type, IRP apportioned or not, terminal assignment.
3. **Trailer** — separate entity; has its own annual inspection and registration.
4. **Driver** — CDL #, state, class, endorsements, DOB, hire date, terminal.
5. **Terminal / location** — matters in California specifically (BIT program enrollment is per terminal).
6. **Policy / account** — insurance policies, IFTA license, IRP account, UCR filing, permits.

### Deadline types — a concrete seed catalog

**Carrier-level (federal)**
| Deadline | Cadence | Notes |
|---|---|---|
| MCS-150 biennial update | Every 24 months, month determined by **USDOT # last two digits** | Last digit → month, 2nd-to-last → odd/even year. Deterministic — you can compute it from the DOT number with zero user input. ([FleetCollect](https://fleetcollect.net/blog/mcs-150-biennial-update-guide)) |
| UCR registration | Annual, opens ~Oct 1, due Dec 31 | Fee tiered by fleet size |
| Form 2290 (HVUT) | Annual, due Aug 31 (tax year Jul 1–Jun 30) | Proof needed for IRP renewal |
| IFTA license renewal | Annual (Dec 31) | Plus decals per truck |
| IFTA quarterly return | **Apr 30, Jul 31, Oct 31, Jan 31** | File even at zero tax |
| IRP renewal | Annual, varies by base state | CA has its own schedule |
| Insurance (auto liability, cargo, physical damage) | Annual, policy-specific | Also MCS-90 filing on record with FMCSA |
| Drug & alcohol random pool selections | Quarterly | Percentages set annually by FMCSA |
| MIS report (drug/alcohol) | Annual, due Mar 15 if selected | |
| Clearinghouse annual query | Annual per CDL driver | **Most common new audit finding** |
| New entrant safety audit | Within **18 months** of registration | Timeline now runs from USDOT authority activation, not MC issuance |

**Registration system change worth building for:** as of **Oct 1, 2025**, MC/MX/FF docket numbers are no longer active federal identifiers — FMCSA uses the **USDOT number exclusively**, and pre-existing authority was auto-migrated. New carriers no longer file OP-1 or pay the $300 MC fee. FMCSA's legacy registration systems yield to the new **Motus** USDOT Registration System starting **May 14, 2026**. ([FleetCollect](https://fleetcollect.net/blog/fmcsa-no-more-mc-numbers-2026), [FMCSA](https://www.fmcsa.dot.gov/registration)) — *Verify this against primary FMCSA sources before shipping any UI copy that depends on it; it came from a secondary source.*

**Vehicle-level**
| Deadline | Cadence |
|---|---|
| Annual DOT inspection (49 CFR 396.17) | Every 12 months |
| **CA BIT** — terminal inspection program | **90-day cycle** for GVWR ≥26,001 lb, hazmat placarded, 10+ passenger, and combination vehicles, effective **Jan 1, 2026**; below 26,001 lb reverts to federal annual only ([US Made Supply](https://usmadesupply.com/resources/building-codes-standards/safety-compliance/california-bit-inspection)) |
| **CARB Clean Truck Check** | GVWR >14,000 lb operating in CA. **Semi-annual testing in 2025–2026**; moving to **quarterly from Oct 1, 2027** for OBD vehicles (2013+ diesel, 2018+ alt-fuel). Tests submittable up to **90 days before** the compliance deadline. Annual fee **$32.13/vehicle in 2026** ($31.18 in 2025). Missed deadline → DMV registration hold; penalties up to $10,000/vehicle/day. ([CARB](https://ww2.arb.ca.gov/clean-truck-check-overview-fact-sheet), [CARB fee update](https://ww2.arb.ca.gov/resources/fact-sheets/clean-truck-check-compliance-fee-update-effective-112026)) |
| Registration / apportioned plate | Annual |
| Preventive maintenance service | By miles or days, whichever first |
| DVIR defect → repair closure | Event-driven, not calendar |

> **The California pair (BIT 90-day + Clean Truck Check semi-annual→quarterly) is your highest-value local differentiator.** No national TMS models these. Every carrier in Glendale has to deal with both, both changed recently, and both carry registration holds or five-figure penalties. Build them as first-class deadline types with the correct cadence math, not as a generic custom reminder.

**Driver-level**
| Document | Cadence |
|---|---|
| CDL | 4–8 years by state |
| Medical examiner's certificate (DOT physical) | Up to 24 months, often shorter with conditions |
| MVR annual review + reviewer's signed note | Every 12 months |
| Annual violation certification (391.27) | Every 12 months |
| Clearinghouse limited query | Every 12 months |
| Random drug/alcohol pool participation | Continuous |
| HazMat endorsement / TWIC | Per-endorsement |
| Entry-level driver training (ELDT) | One-time |

### Recurrence model — build it properly
Do not store a single `due_date`. Store a **rule** that generates occurrences:
- `FIXED_INTERVAL` — every N months from last completion (annual inspection, medical card)
- `FIXED_CALENDAR` — same date every year regardless of completion (UCR Dec 31, 2290 Aug 31)
- `COMPUTED` — derived from an identifier (MCS-150 from USDOT digits); implement as a pure function, no user input
- `CYCLE_FROM_ANCHOR` — every 90 days from an anchor date (CA BIT)
- `N_PER_PERIOD` — semi-annual/quarterly with a compliance-deadline anchor and a lead window (Clean Truck Check's 90-day early-submission window is a real, useful UI affordance)
- `EVENT_DRIVEN` — triggered by an event, due N days later (post-accident test, DVIR defect repair, new-hire DQ file completion)
- `ONE_TIME` — new entrant audit, ELDT

Each occurrence needs: `due_date`, `lead_days[]` (multiple reminders), `grace_days`, `status` (upcoming / due / overdue / completed / waived / N-A), `completed_at`, `completed_by`, `evidence_document_id`, `notes`.

**Waived/N-A is not optional.** Intrastate-only carriers, non-CDL drivers, trailers without annual inspections — if the user can't turn a deadline off with a recorded reason, they will ignore the whole dashboard.

### Escalation
Three-level default, per deadline type:
1. **T-30 / T-14 / T-7 / T-1** → email digest to the assigned owner
2. **Overdue day 1** → SMS to the owner
3. **Overdue day 3+** → SMS to the account owner (escalation contact), daily until resolved or snoozed

Let the user edit the lead-day array per deadline type, and let them assign an **owner** per deadline (the wife who does DQ files vs. the cousin who does trucks). Escalation with no named owner is just noise.

### Document storage
- Attach 1..n files per deadline occurrence; the file **is** the proof.
- Capture from phone camera as first-class input — a photo of a medical card at the kitchen table is the actual workflow.
- OCR the expiry date where you can (medical card, CDL, registration, insurance dec page) and **pre-fill the next due date**, with the user confirming. Do not silently trust OCR; Truckbase's reviewers are explicit that unchecked AI extraction erodes trust.
- Immutable audit trail: who uploaded, when, and no hard delete (soft-delete with reason). An auditor asking "when did you obtain this?" is the use case.
- Retention: DQ files kept 3 years after termination; IFTA records 4 years; fuel receipts 4 years. Don't auto-purge.

### Proof-of-compliance output — *the killer feature*
Generate an **audit binder PDF** on demand:
- Cover page: carrier name, USDOT, date generated, scope
- Table of contents with a compliance status column
- Per-driver DQ file section, in 391.51 order, with each required document and a "present / missing / expired" marker
- Per-vehicle section: annual inspection certificate, BIT records, Clean Truck Check pass, registration, maintenance history
- Carrier-level filings: MCS-150 confirmation, UCR receipt, 2290 stamped Schedule 1, IFTA returns, insurance certs
- **A gap report at the front** listing exactly what's missing

Nobody in the small-fleet tier ships this well. It is the thing a carrier will pay for the morning they get an audit letter, and it converts your database into a deliverable.

### FMCSA auto-pull (the "enter your USDOT and we fill it in" feature)
The **QCMobile API** is the right source. [V — fetched [mobile.fmcsa.dot.gov/QCDevsite/docs/qcApi](https://mobile.fmcsa.dot.gov/QCDevsite/docs/qcApi)]
- Endpoints: `/carriers/:dotNumber`, `/carriers/name/:name`, `/carriers/docket-number/:docketNumber`, `/carriers/:dotNumber/basics`, `/carriers/:dotNumber/cargo-carried`, `/carriers/:dotNumber/operation-classification`, plus authority and out-of-service status.
- Returns registration, licensing, insurance, authorization, and safety records. JSON. **Requires an API key** as a query param ([API access docs](https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess)).
- Multi-carrier responses capped at 50 records; paginate with `start=`.
- **What you get for free at signup:** legal name, DBA, address, USDOT, power units, driver count, operation classification, cargo carried, safety rating, OOS status, and authority status.
- **What you should do with it:** pre-populate the carrier profile, seed the truck count, **compute the MCS-150 due date from the USDOT number**, and flag anything already out of compliance in the first 30 seconds of the session. That is your activation moment — the user types 7 digits and immediately sees their own real deadlines.
- Cache aggressively (data changes monthly at most) and re-poll weekly for authority/OOS/safety-rating changes — a change there is itself an alert-worthy event.

---

## C.2 Orders / loads

### Fields a load actually needs

**Identity & commercial**
- Internal load # (your sequence) + **broker's load/reference # (theirs)** — carriers search by the broker's number, because that's what's on the paperwork
- Customer/broker: name, MC/USDOT, contact name, phone, email, billing address, remit-to
- **Broker credit / days-to-pay** — small carriers care intensely about who pays slow
- Linehaul rate, fuel surcharge (amount or $/mi), accessorials (itemized), total
- Payment terms; whether the load is **factored**, and to whom

**Stops** — model as an ordered list, not fixed origin/destination. Multi-stop is normal.
Per stop: sequence #, type (pickup / delivery / drop / hook / fuel / scale), company name, full address + geocode, contact + phone, **appointment type (hard appointment vs. FCFS window)**, appointment start/end, actual arrive/depart timestamps, reference numbers (PO #, pickup #, delivery #, BOL #, seal #), instructions, lumper required?

Appointment type matters more than it looks: a hard appointment missed can mean a refused load or detention charges, while FCFS is a window. ([Truckercalc](https://truckercalc.com/rate-confirmation-trucking/), [Laneproof](https://www.laneproof.com/blog/rate-confirmation-template-free))

**Freight**
- Commodity description, piece count, packaging type, weight, dimensions, **temperature range** (reefer), hazmat class/UN#/placards, value, equipment type required (53' dry van, reefer, flatbed, step deck, power only)

**Detention & accessorial terms** — pull these from the rate con and store them structured:
- Free hours at pickup and at delivery
- Detention rate per hour
- Whether detention requires **broker pre-approval** (it usually does, and this is where small carriers lose money)
- TONU, layover, driver assist, tarping, lumper, extra stop rates

**Documents**
- Rate confirmation PDF (the source of truth for the whole record)
- BOL(s), POD(s), lumper receipts, scale tickets, photos, accessorial approvals
- Signed/unsigned rate con distinction

**Financial rollup**
- Total revenue, total miles (loaded + deadhead), **revenue per total mile** and **per loaded mile**, driver pay, fuel cost, estimated margin

### Load lifecycle statuses

Two parallel tracks — operational and financial — because a load can be delivered but unbilled. This is how established systems model it. ([Loadsmart CarrierTMS](https://community.loadsmart.com/hc/en-us/articles/15128407074195--CarrierTMS-Load-Statuses), [EZ Loader TMS](https://ez-loader-tms.helpscoutdocs.com/article/158-2-2-2-status-driven))

**Operational:** `Quoted` → `Booked / Covered` → `Assigned` (driver + equipment) → `Dispatched` (en route to pickup) → `At Shipper` → `Loaded` → `In Transit` → `At Consignee` → `Delivered` → `POD Received`
Plus exceptions: `Detained`, `Breakdown`, `Late`, `Cancelled`, `TONU`

**Financial:** `Ready to Invoice` → `Invoiced` → `Submitted to Factor` → `Funded` → `Paid` → `Closed`
Plus: `Short Paid`, `In Dispute`, `Write-off`

Keep these as two independent state machines on one record. Do not force a single linear status — it's the most common modeling mistake and it's why "the report doesn't match" complaints exist.

### How rate cons actually arrive
**Email, as a PDF attachment, from the broker, all day.** Sometimes a portal, sometimes EDI 204 for larger shippers, but for a 5–50 truck carrier it is overwhelmingly email PDF.

The realistic pipeline:
1. Dedicated inbound address per tenant (`loads+{tenant}@fleetview.app`) — the dispatcher forwards or the broker is given it directly
2. Detect and classify attachments (rate con vs. BOL vs. POD vs. invoice vs. lumper receipt)
3. Extract fields — LLM extraction now outperforms classic OCR templates on varied broker layouts. Reported field-level accuracy on standard freight documents: **94–98%** ([US Tech Automations](https://ustechautomations.com/resources/blog/reconcile-freight-invoices-against-rate-confirmations-comparison-2026))
4. **Present a review screen with confidence indicators, never auto-commit.** Truckbase's own users complain that the AI importer misses fields and everything must be double-checked — the failure isn't the extraction, it's the absence of a fast confirmation UI. Make the review screen take 10 seconds.
5. Attach the original PDF to the load permanently

Also support: paste rate con text, upload from phone, and plain manual entry. A carrier who can't type a load in manually will not trust the automatic path.

### Invoicing & factoring
- Generate invoice = rate con terms + POD + accessorial docs, bundled into one PDF package. Factors want **invoice + BOL + POD + rate con + lumper receipts**, not just the invoice line. ([Vektor TMS](https://vektortms.com/carriers/billing))
- Major factors in this segment: **Apex Capital, RTS Financial, OTR Solutions, TBS, Triumph Business Capital, Bobtail, eCapital, TAFS**. ([BestCarrierTMS](https://bestcarriertms.com/integrations/factoring.php))
- Integration reality: a few have APIs; most work via a **monitored intake email address**. Email submission with status tracking gets you 80% of the value at 5% of the effort. **Start there.** Pull-back of funded/not-funded status is the part carriers actually value.
- QuickBooks Online sync is table stakes — Truckbase leads with it. Consider it a Phase 2 must, not a Phase 1.

---

## C.3 Trips / dispatch

### Assignment
- **Driver** (with co-driver for team), **tractor**, **trailer** — three separate assignments, because trailers get dropped and swapped independently. Power-only loads have no owned trailer.
- Conflict detection: driver already assigned in the window, equipment already committed, driver's compliance blocker (expired medical card, positive Clearinghouse result, license expired).
  - **Hard-block dispatch on an expired medical certificate or CDL.** This is where your compliance module earns its keep — it isn't a separate product, it's a precondition on the dispatch screen. No competitor in this tier connects the two.

### Multi-stop routing
- Ordered stop list with drag-to-reorder
- Practical truck routing, not car routing — PC*MILER is the industry standard for mileage (TruckingOffice sells it as a $5–$25/mo add-on, which tells you it costs real money). Cheaper starting point: a routing API with truck profiles, with PC*MILER as a paid upgrade for carriers who need broker-matching mileage.
- **Mileage disputes with brokers are settled on PC*MILER practical miles.** If your miles don't match theirs, the carrier loses the argument. Label your mileage source explicitly in the UI.

### HOS awareness
Don't build an ELD. Integrate. Pull per-driver: **available drive hours, current duty status, time until next required break, 70/60-hour cycle remaining**. Use it for one thing: *can this driver legally complete this run before you commit to the shipper?* ([Truckpedia](https://truckpedia.io/resources/best-tms-motive-integration), [Samsara developer docs](https://developers.samsara.com/docs/compliance-guide))

Integration priority by installed base in this segment: **Motive, Samsara, Geotab**, then the long tail (TruckX and similar budget ELDs are common among immigrant-owned small fleets specifically — TruckX ships Spanish and Punjabi UIs, which is a strong signal of who buys it). Support **multiple ELD vendors per tenant** — mixed fleets are normal when trucks are bought used with devices already installed.

### Deadhead vs. loaded miles
Track separately and always. It is the single most-misunderstood number in small-fleet economics:
- Loaded miles (stop 1 pickup → final delivery)
- Deadhead (previous delivery → next pickup)
- Personal conveyance / yard moves (excluded from revenue math, included in IFTA)
- **Revenue per loaded mile** flatters you; **revenue per total mile** is the truth. Show both, default to total. ATRI notes deadhead remained elevated in 2025.

### Trip settlement / driver pay
Support all four models plus mixes — real carriers use several at once:
| Model | Typical 2026 range | Notes |
|---|---|---|
| Per mile (CPM) | $0.58–$0.78/mi solo OTR; $0.45–$0.52 entry, $0.52–$0.65 mid, $0.65–$0.80 senior | Flatbed/tanker +5–10¢. **Specify the mileage basis**: practical, shortest, HHG, or hub |
| Percentage of linehaul | Owner-operators leased on: **65–75%** of load pay | Is FSC included? Accessorials? Define it |
| Hourly | Local/drayage | |
| Flat per trip / per stop | Dedicated runs | |
[T] ([Fintruck](https://www.fintruck.io/blog/truck-driver-pay-per-mile:-how-carriers-structure-pay-to-attract-and-keep-drivers), [CDLScan](https://cdlscan.com/articles/truck-driver-pay-structures-explained), [Datatruck](https://www.datatruck.io/blog/how-much-do-truck-drivers-make-salary-by-type-2026))

Settlement statement must handle: per-load earnings, stop pay, detention pay, layover, accessorial splits, reimbursements (tolls, scales, lumpers), **advances**, and **recurring deductions** (escrow, insurance, ELD fee, truck lease/loan, fuel card). Revisions must be tracked — Truckbase lists settlement revision tracking as a feature, which means disputes happen.

Do **not** run payroll. Produce the settlement, export to the payroll system. Truckbase doesn't run payroll either and reviewers accept that.

### Fuel & IFTA
- Fuel stops: date, location (state matters), gallons, price/gal, total, vehicle, card used, receipt image. IFTA requires date, location, gallons, and vehicle identification, and receipts must be kept **4 years**.
- **IFTA mileage by state** is the highest-drudgery item in the segment: **4–8 hours per quarter manually**, reducible to under 30 minutes with automation. Derive jurisdictional miles from ELD GPS breadcrumbs where available; fall back to routing-engine state splits; allow manual override with an audit note.
- Quarterly returns due **Apr 30 / Jul 31 / Oct 31 / Jan 31**, even with zero tax owed. Wire these into the compliance module as auto-generated deadlines.
- Fuel card integrations (WEX, Comdata, EFS, Fleet One, AtoB) eliminate receipt entry entirely — high value, moderate effort, good Phase 2 candidate.

---

## C.4 Alerts

### Taxonomy

**A. Compliance / expiry** — deadline approaching, deadline overdue, document missing, document expiring, new FMCSA finding (safety rating change, OOS order, authority revocation, new inspection or crash on the DOT record)
**B. Operational / load** — load booked, driver assigned, stop appointment in N hours, driver arrived/departed, load delivered, **POD still missing N hours after delivery**, detention clock started (free hours exceeded), load running late vs. appointment
**C. Financial** — invoice ready, invoice sent, invoice past due at 30/45/60 days, factor funded, short pay detected, rate con vs. invoice mismatch
**D. Maintenance / asset** — PM due by miles or date, DVIR defect reported, defect unresolved N days, inspection due, registration expiring
**E. Driver** — HOS clock nearly exhausted, driver unassigned tomorrow, medical card expiring, MVR review due
**F. System** — rate con parsed and awaiting review, integration failed (ELD disconnected, factoring submission bounced), sync error

**Special: FMCSA change-detection alerts.** Because you re-poll QCMobile weekly, you can alert on *"a new roadside inspection appeared on your DOT record"* or *"your authority status changed."* No small-fleet competitor does this and it's nearly free once you're already polling. It is also the most viscerally valuable alert you can send a small carrier.

### Delivery channels
| Channel | Use for | Notes |
|---|---|---|
| **Email** | Digests, documents, anything with detail or attachments | Cheap, unlimited length, attachable PDFs. Default channel. |
| **SMS** | Urgent + overdue only | ~$0.01/message all-in. Requires 10DLC registration (§D). Ration it. |
| **In-app / web push** | Everything, as the always-on record | Free. |
| **WhatsApp** | **Strongly consider for this audience** | Truckbase names WhatsApp as a competitor for a reason — immigrant-owned carriers and their drivers live in it. Requires Meta Business verification + approved message templates; higher setup cost than SMS but far better received by Spanish/Armenian/Russian-speaking users. Phase 2. |

Do **not** build a native mobile app for alerts in v1. SMS + email + a mobile web app covers it.

### Timing, escalation, quiet hours
- **Lead times as an array, per rule:** `[-30d, -14d, -7d, -1d, +1d, +3d, +7d]`
- **Escalation chain:** primary owner → account owner → (optional) external contact, with a delay and a channel per step. Escalation is the one thing that justifies interrupting someone outside the product, so it needs the clearest severity logic. ([Timothy Graf](https://timgraf.com/ux-design/notification-and-alert-design-patterns-a-comprehensive-ux-framework-for-designing-feedback-systems-that-respect-user-attention-drive-meaningful-engagement-and-prevent-notification-fatigue/), [OneUptime](https://oneuptime.com/blog/post/2026-01-30-alert-rule-design/view))
- **Quiet hours:** per-user, with timezone. Non-critical alerts queue until the window opens; critical alerts (overdue compliance with a registration hold at stake, driver OOS) break through — and the user must be able to see which categories are allowed to break through.
- **Digest vs. immediate, per category:** default compliance to a **daily 7am digest** plus immediate SMS only on overdue. A carrier who gets 14 separate emails about 14 expiring items will mute you permanently and then miss the one that mattered.
- **Deduplication and snooze:** one overdue item should not generate a message every day forever. Snooze until date, with the snooze recorded.
- **Per-category, per-channel matrix** in settings. This is the single most-recommended pattern in notification UX literature, and the advice is consistent: *start with coarse on/off per type and channel; add digesting and quiet hours once real usage demands it.* ([Foundey](https://foundey.com/blog/notification-ux), [SaaSUI](https://www.saasui.design/blog/saas-notification-toast-ux-patterns))

### Modeling "custom alerts" — the rule builder

Three tiers, shipped in this order:

**Tier 1 — Templates (ship first, covers 90%).** Pre-built rules the user toggles on and tunes: "Alert me 30 days before any driver's medical card expires." Prefilled, editable lead times and channels. **Most users will never leave this tier**, and that is fine.

**Tier 2 — Simple custom reminder.** A named one-off or recurring reminder attached to any entity: subject, due date, recurrence, lead times, channel, assignee. This is the "my insurance broker wants a call every March" use case. Cheap to build, high perceived value.

**Tier 3 — Condition builder.** The classic `WHEN <trigger> IF <conditions> THEN <actions>` form:
- **Trigger:** an entity event (`load.status_changed`, `document.expiring`, `inspection.created`) or a **schedule** (evaluate daily at 06:00)
- **Conditions:** AND/OR groups of `field / operator / value` over the trigger entity and its relations. Operators: `is`, `is not`, `contains`, `>`, `<`, `in`, `is empty`, `changed to`, `older than N days`
- **Actions:** notify (channel + recipient + template), escalate after N, create a task, change a field, call a webhook
- **Guards:** cooldown period, max fires per day, active date range, quiet-hours honor flag

UI pattern to copy: **Zapier/Airtable-style stacked condition rows** with plain-language preview ("This will notify Ana by SMS when a load has been delivered 24 hours ago and no POD is attached"), plus a **"test on last 30 days" button** showing how many times it would have fired. The preview-and-backtest is what makes non-technical users trust a rule builder. Without it, they build one rule, get spammed, and turn everything off.

**Critical for this audience:** put the rule builder behind an "Advanced" disclosure. A family carrier does not want to see a boolean expression editor on day one. Tier 1 must feel complete on its own.

---

## C.5 Driver / vehicle records

### Driver documents and cadences
| Document | Expiry / cadence | Reg. cite |
|---|---|---|
| Employment application | Retained, one-time | 391.21 |
| MVR from each state — pre-employment | At hire | 391.23 |
| **MVR — annual inquiry** | **Every 12 months** | 391.25 |
| **Annual review note** (reviewer name + date) | **Every 12 months** | 391.25 |
| **Annual violation certification** | **Every 12 months** | 391.27 |
| Road test certificate or equivalent | One-time | 391.31 / 391.33 |
| **Medical examiner's certificate** | **Up to 24 months**, often 3/6/12 with conditions | 391.43 / 391.45 |
| Medical examiner National Registry verification | At each new cert | |
| CDL copy + endorsements | **4–8 yrs, state-specific** | |
| Previous employer safety performance history (3 yrs) | At hire, within 30 days | 391.23 |
| **Clearinghouse pre-employment query** | At hire | 382.701 |
| **Clearinghouse limited query** | **Every 12 months** — top current audit finding | 382.701(b) |
| Pre-employment drug test | At hire | 382.301 |
| Random pool membership | Continuous | 382.305 |
| ELDT certification | One-time | |
| HazMat endorsement / TWIC | Per credential | |
Sources: [eCFR 391.51](https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-391/subpart-F/section-391.51), [FMCSA CSA Safety Planner](https://csa.fmcsa.dot.gov/safetyplanner/MyFiles/SubSections.aspx?ch=23&sec=66&sub=152), [Foley DQ guide](https://www.foleyservices.com/driver-qualification-file-requirements/)

Note: Clearinghouse query **results** don't have to live in the DQ file, but evidence that the query was run does. Model "query performed" as a compliance event separate from the document.

**DQ file completeness score per driver (0–100 with the missing items listed) is a feature worth building.** It's the number the owner will check, and it makes the abstract concrete.

### Vehicle documents and cadences
| Document | Cadence |
|---|---|
| Annual DOT inspection certificate (396.17) | 12 months |
| **CA BIT inspection** | **90 days** if ≥26,001 lb GVWR / hazmat / 10+ pax / combination (from Jan 1, 2026) |
| **CARB Clean Truck Check pass** | **Semi-annual** 2025–26 → **quarterly** from Oct 1, 2027 (OBD vehicles); fee $32.13/vehicle in 2026 |
| Cab card / apportioned registration (IRP) | Annual |
| License plate registration | Annual |
| Form 2290 stamped Schedule 1 | Annual (Aug 31) |
| Insurance — auto liability, cargo, physical damage | Per policy, typically annual |
| IFTA decals | Annual |
| Preventive maintenance (A/B/C service) | Mileage or time, whichever first |
| DVIRs | Daily; defects tracked to closure |
| Maintenance & repair records | Retained 12 months + 6 after disposal (396.3) |
| Tire, brake, emissions records | Per service |
| Lease agreement (if leased-on) | Per term |

Trailers need their own annual inspection, registration, and (in CA) BIT participation. Model trailers as first-class assets.

---

## C.6 Reporting — what a small carrier owner *actually* opens

Ruthless prioritization. A 12-truck owner will look at maybe five numbers, weekly, probably on a phone.

**Tier 1 — build these, they justify the subscription**
1. **Revenue per total mile** and **revenue per loaded mile**, by truck and by driver, this week / month / YTD. Benchmark against ATRI's $2.336/mi all-in cost — a carrier whose RPM is below $2.34 is losing money and mostly doesn't know it at the per-truck level.
2. **Profit per load** — revenue minus driver pay, fuel, and an allocated fixed cost per mile. The question every owner asks and almost no small-fleet TMS answers cleanly. Rank best and worst 10 loads. **Rank best and worst brokers and lanes** — this is the report that changes behavior.
3. **Cost per mile**, actual, with the ATRI line-item structure so it's comparable: fuel, R&M, tires, insurance, permits/licenses, tolls, driver wages, driver benefits, truck payment.
4. **Driver settlement statement** — per driver, per period, itemized. Required operationally, not just informationally.
5. **A/R aging** — who owes me, how old, which broker pays slowest. With days-to-pay by broker computed from history.

**Tier 2**
6. **IFTA quarterly worksheet** — miles and gallons by jurisdiction, ready to transcribe or file.
7. **Compliance status dashboard** — overdue / due-30 / due-90 counts, and the audit binder PDF.
8. Deadhead percentage by truck and by driver. Elevated deadhead is where margin quietly dies.
9. Empty/idle truck days — utilization.
10. Fuel efficiency (MPG) by truck and driver, with fuel cost per mile.

**Tier 3 — skip in v1**
Anything requiring a report builder. Alvys and Truckbase both get criticized for reporting; the lesson is not "build a more configurable report builder," it's "build five reports that are correct and answer the actual question." Add CSV export and let power users take it from there.

**Design constraint:** every Tier 1 report must render legibly on a phone and be exportable as a PDF that can be forwarded to an accountant or a banker. Loan applications and factoring approvals are a real, recurring use.

---

# D. SMS / email delivery

## D.1 SMS pricing (US, per segment, 2026)

| Provider | Outbound (long code) | Inbound | Toll-free out | Number rental | Verified? |
|---|---|---|---|---|---|
| **Twilio** | **$0.0083** | $0.0083 | $0.0083 | $1.15/mo (TF $2.15) | [V] [twilio.com/sms/pricing/us](https://www.twilio.com/en-us/sms/pricing/us) |
| **Telnyx** | **$0.004** | $0.004 | $0.0055 | $1.00/mo | [V] [telnyx.com/pricing/messaging](https://telnyx.com/pricing/messaging) |
| **AWS SNS** | **$0.00645** | n/a (SNS is send-only; use AWS End User Messaging for 2-way) | + $0.0025 TF carrier fee | via origination identity lease | [T] [aws.amazon.com/sns/sms-pricing](https://aws.amazon.com/sns/sms-pricing/) — first 100 US SMS/mo free |
| **Bird (MessageBird)** | ~$0.0033–$0.0083 (sources conflict) | ~$0.003 | — | — | [UNVERIFIED] |

**Carrier pass-through fees are added on top and are the same regardless of provider** (they go to the carrier, not the CPaaS). Twilio's published US long-code fees: AT&T $0.0035 out, T-Mobile $0.0045 out, Verizon $0.0045 out ($0.007 **in**), US Cellular $0.005, others $0.004. [V]

**Realistic all-in cost per outbound SMS segment:**
- Telnyx: $0.004 + ~$0.004 carrier ≈ **$0.008**
- Twilio: $0.0083 + ~$0.004 carrier ≈ **$0.0123**
- AWS SNS: $0.00645 + carrier ≈ **$0.010**

**At FleetView's scale this difference is noise.** 50 tenants × 40 SMS/month = 2,000 segments = **$16/mo on Telnyx vs. $25/mo on Twilio**. Choose on developer experience, deliverability, and 10DLC handling — not on $9/month.

**Recommendation: Twilio.** Best documentation, best 10DLC registration tooling (they walk you through TCR submission), largest community, and the price delta is irrelevant until you're sending six figures of messages. Revisit Telnyx (~35% cheaper all-in) at scale. Avoid AWS SNS for this use case — no native 2-way, no 10DLC hand-holding, and STOP handling is more DIY.

Watch **segment counting**: 160 GSM-7 chars per segment, **70 chars if the message contains any Unicode**. Emoji, curly quotes, and — critically — **accented Spanish characters (á, é, í, ñ, ¿) force UCS-2 and cut your segment to 70 characters**, more than doubling cost and often splitting a message. For a Spanish-language SMS product this is a real budget and UX line item: normalize where meaning permits, or budget 2× for Spanish messages.

## D.2 10DLC / A2P registration — required, do it early

**Non-negotiable.** Unregistered A2P traffic over US long codes gets filtered or blocked outright.

**Fees (Twilio, 2026):**
| Item | Cost | Source |
|---|---|---|
| Standard brand registration | **$44–$46 one-time** (includes secondary vetting) | [T] ([Twilio support](https://support.twilio.com/hc/en-us/articles/1260803965530-What-pricing-and-fees-are-associated-with-the-A2P-10DLC-service) — direct fetch 403'd) |
| **Low-volume** standard brand | **$4 one-time** | [T] |
| Campaign vetting | **$15 one-time per campaign** | [T] |
| Monthly campaign fee | **$1.50–$10/campaign/month** by use case | [T] |
| Sole proprietor path (no EIN) | **$4 brand + ~$2/mo campaign**, lower throughput, requires phone-based 2FA | [T] ([Telnyx](https://support.telnyx.com/en/articles/13545282-guide-to-sole-proprietor-10dlc-brand-and-campaign-registration)) |

**Total realistic startup cost: under $100. Ongoing: $2–$10/month.** This is not a barrier; the timeline is.

**Timeline (plan for it):**
- Brand registration: **2–5 business days**
- Campaign approval: **24–72 hours** when the submission is clean and consistent, but **1–4 weeks** is commonly reported due to downstream carrier backlogs. [T] ([TextBolt](https://textbolt.com/blog/10dlc-compliance/), [JustCall](https://justcall.io/blog/10dlc-compliance-guide.html))

> **Start 10DLC registration the week you decide SMS is in scope — before the feature is built.** It is the longest-lead-time dependency in the entire product and it is pure waiting.

**Register as a company with an EIN, not a sole proprietor.** Sole-proprietor campaigns have materially lower throughput caps and get filtered more aggressively.

**Use case to register:** "Mixed" or "Low Volume Mixed" fits a compliance-alerts product sending notifications to account holders. Describe it accurately — inconsistency between your brand, campaign description, sample messages, and website is the #1 rejection cause.

## D.3 What you must actually do to be compliant

The environment tightened materially in 2026: the CTIA Messaging Principles were updated **October 2025** (stricter on URL handling, sender identification, and opt-in language specificity), and the **FCC one-to-one consent rule took effect January 2026**. Carrier compliance with CTIA principles is now an effective prerequisite for network access, not a voluntary best practice. ([Holland & Knight](https://www.hklaw.com/en/insights/publications/2026/05/beyond-tcpa-compliance-why-ctia-messaging-principles), [MessageIQ](https://messageiq.io/blogs/ctia-messaging-principles-and-best-practices/))

**Checklist:**

1. **Brand + campaign registered with TCR** via your provider, before sending.
2. **Documented opt-in.** At signup and in phone-number settings, an unchecked checkbox with explicit language:
   > "Yes, send me SMS alerts about my fleet's compliance deadlines and loads. Message frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe, HELP for help."
   Store the **timestamp, IP, and exact consent text version** with every phone number. This record is your TCPA defense and carriers may ask for it during campaign vetting.
3. **Opt-in must be on a publicly reachable page.** Carrier vetting reviewers visit your website and look for it. Put the opt-in language and a link to your SMS terms on the public marketing site, not only behind the login.
4. **Honor STOP, CANCEL, UNSUBSCRIBE, END, QUIT, UNSTOP** — all of them, not just STOP. Twilio/Telnyx handle this at the platform level by default, **but you must mirror the opt-out into your own database** or you'll keep queueing messages that silently die, and your delivery metrics will rot.
5. **HELP must return support contact info** including the business name.
6. **Include your business name in the first message of any conversation.** ("FleetView: Your 2024 Freightliner annual inspection expires in 7 days.")
7. **Quiet hours.** TCPA restricts marketing calls/texts to 8am–9pm local. Transactional alerts to opted-in account holders are on much safer ground, but **respect quiet hours anyway** — it's both compliant and correct product design, and you need the timezone field regardless.
8. **No SHAFT content** (Sex, Hate, Alcohol, Firearms, Tobacco) — irrelevant here but worth knowing the acronym since vetting asks.
9. **Don't put bare shortened URLs in messages.** Public URL shorteners (bit.ly) are a major filtering trigger. Use a branded link domain on your own domain.
10. Add a **`/sms-terms`** page to the marketing site. Cheap, and vetting reviewers look for it.

## D.4 Transactional email

| Provider | Entry price | Included volume | Overage | Verified? |
|---|---|---|---|---|
| **Resend** | Free $0 | 3,000/mo (100/day cap) | — | [V] [resend.com/pricing](https://resend.com/pricing) |
| | **Pro $20/mo** | 50,000/mo | $0.90/1,000 | [V] |
| | Pro $35/mo | 100,000/mo | $0.90/1,000 | [V] |
| | Scale $90–$1,150/mo | 100K–2.5M | $0.90→$0.46/1,000 | [V] |
| **Postmark** | Free $0 | 100/mo | none allowed | [V] [postmarkapp.com/pricing](https://postmarkapp.com/pricing) |
| | **Basic $15/mo** | 10,000/mo | $1.80/1,000 | [V] |
| | Pro $16.50/mo | 10,000/mo | $1.30/1,000 | [V] |
| | Platform $18/mo | 10,000/mo | $1.20/1,000 | [V] |
| **AWS SES** | À la carte | — | **$0.10/1,000** + $0.12/GB attachments | [V] [aws.amazon.com/ses/pricing](https://aws.amazon.com/ses/pricing/) |
| | Essentials | 0–10M | $0.16/1,000, no fixed fee | [V] |
| | Pro | $105/account/region/mo | $0.22/1,000, includes 1 managed dedicated IP | [V] |

**Recommendation: Resend.** For a solo founder the Pro plan at **$20/month for 50,000 emails** is dramatically more headroom than Postmark's $15 for 10,000, with a far better DX (React Email templates, clean API, good webhooks). Postmark's edge is reputation for transactional inbox placement and superior bounce/complaint tooling — genuinely excellent, but at 10K/month you'll outgrow the included tier fast if you're sending daily digests.

Volume math: 50 tenants × 3 users × 1 daily digest = **4,500 emails/month**. Even with load/invoice notifications you're comfortably inside Resend Pro for a long time. SES at $0.10/1,000 is 10–20× cheaper but you own deliverability, warmup, suppression lists, and bounce handling yourself — wrong trade for a solo founder's first year.

**Deliverability setup — do all of it on day one:**
1. **Dedicated sending subdomain**: `mail.fleetview.app` or `notify.fleetview.app`. Never send from the apex domain — a deliverability problem should never be able to poison your corporate email.
2. **SPF**: `v=spf1 include:<provider> -all` on the sending subdomain.
3. **DKIM**: provider-issued CNAMEs, 2048-bit. Verify it's actually signing before launch.
4. **DMARC**: start at `v=DMARC1; p=none; rua=mailto:dmarc@fleetview.app;` to collect reports, then move to `p=quarantine` and finally `p=reject` after 2–4 weeks of clean reports. **Google and Yahoo require DMARC for bulk senders** — p=none satisfies the minimum, but publish it.
5. **Return-Path / custom MAIL FROM** aligned to your subdomain for SPF alignment.
6. **BIMI** — optional, needs a VMC, skip for now.
7. **Reverse DNS / PTR** — provider's job on shared IPs.
8. **Warm up gradually.** Don't blast 5,000 emails on launch day from a cold domain.
9. **Handle bounces and complaints via webhook.** Hard bounce → suppress immediately. Complaint → suppress and flag. A rising bounce rate is a deliverability death spiral.
10. **Plain-text alternative on every email** and a real physical address in the footer (CAN-SPAM).
11. **Separate streams**: transactional (alerts) vs. marketing (newsletters) on **different subdomains**. Postmark enforces this with Message Streams; Resend supports it via separate domains. Do it either way — one marketing complaint spike must not take down compliance alerts.

---

# E. Marketing site

## E.1 What the evidence says

**Publishing your price is the highest-leverage decision.** Of 21 products surveyed, only 6 publish real pricing. The evidence on what that costs:
- Pricing transparency is critical to engagement for **86% of B2B buyers** (LinkedIn research).
- One A/B test of "Talk to Sales" vs. a transparent pricing table lifted **lead-to-opportunity conversion 21.4%**.
- Median B2B SaaS landing page converts **3.8%**; top quartile **11.6%+**. Self-serve SMB products on free-trial CTAs reach **8–15%**; enterprise sales-gated pages run **1–3%**.
- *"Write the pricing page for the skeptic, not the optimist — every number you publish is an objection you never have to handle on a call."*
([SaaSHero](https://www.saashero.net/strategy/b2b-saas-conversion-rate-benchmarks/), [BayLeaf Digital](https://www.bayleafdigital.com/saas-pricing-page-best-practices/), [Genesys Growth](https://genesysgrowth.com/blog/designing-b2b-saas-landing-pages))

For **this** audience the case is stronger still. A Glendale fleet owner who has been quoted $585/month for one seat, sold a 36-month Samsara contract, and asked to "book a demo" by four vendors in a row does not want a form. He wants a number. Publishing $X/truck/month with no contract is simultaneously your differentiator, your qualification filter, and your trust signal.

**Truckbase's homepage is the structural model to study** (and then beat on transparency). Their sequence: hero → award badges + testimonial → problem framing **segmented by role** → six feature blocks → three-way competitive comparison (spreadsheets/legacy/enterprise) → testimonial carousel → 8-question FAQ → six benefit callouts → closing CTA. [V — fetched]

Two things they do especially well:
- **Problem framing by role**, not by feature: separate paragraphs for Fleet Owners, Dispatchers, Operations Managers, Bookkeepers. In a family carrier these are four different people who will all look at the site.
- **Naming the real alternatives out loud**: "Spreadsheets & WhatsApp," "Legacy Software," "Enterprise Solutions." Honest, and it validates the visitor's actual situation instead of pretending they're evaluating McLeod.

Their FAQ answers exactly the objections this buyer has: setup time (**"~1 hour with a dedicated account manager"**), is it mobile, how does factoring work, is there a driver app, **do drivers need an app or can I just text them**, is it cloud-based, can you migrate my history.

## E.2 Recommended page structure

### 1. Hero
- **Headline — concrete outcome, not category.** "Never miss a DOT deadline again." or "Your trucks, your loads, your deadlines — in one place." Avoid "AI-powered transportation management platform." Avoid "revolutionize." The buyer does not want a revolution, he wants to not fail an audit.
- **Subhead — the segment, the mechanism, the price, in one sentence.** "Built for fleets with 5 to 50 trucks. Enter your USDOT number and see every deadline you're facing in 60 seconds. From $X/truck/month, cancel anytime."
- **Primary CTA:** a **USDOT number input field, right in the hero.** Not "Book a demo." The user types 7 digits and immediately sees their own carrier name, truck count, and next MCS-150 due date pulled from FMCSA. This is the single strongest conversion mechanic available to you and no competitor has it — it turns the hero into an instant, personalized demo with zero friction and zero sales call.
- Secondary CTA: "See pricing" (anchor link, not a form).
- **Language switcher visible in the header**, not buried in the footer.
- Product screenshot or a 30-second silent loop of the deadline dashboard. Real UI, real-looking data.

### 2. Trust strip (immediately under hero)
Small, quiet, honest. As a new product you don't have logos yet — so use what you do have:
- "Reads your data straight from FMCSA"
- "No contract. Cancel anytime."
- "Your data is yours — export everything, any time."
- Security/privacy one-liner.

**Do not fake customer logos or invent review badges.** This audience is small, networked, and will ask around. One discovered fake kills you in a community where carriers refer each other.

### 3. Problem — segmented by role
Follow Truckbase's structure, adapted:
- **The owner:** "You're carrying the whole compliance calendar in your head — and it wakes you up at 3am."
- **The person who does the paperwork (often the owner's spouse):** "Medical cards, annual inspections, BIT, Clean Truck Check, UCR, 2290, IFTA. Different dates, different agencies, all on sticky notes."
- **The dispatcher:** "Rate cons in email, loads in a spreadsheet, drivers on WhatsApp, and nothing talks to anything."
- **The reality:** "Almost every violation a small carrier gets is a documentation failure, not a driving failure." Cite the source.

Then the local hook, prominently:
> **"California changed BIT inspections on January 1, 2026. Clean Truck Check goes quarterly in 2027. Do you know which of your trucks are affected?"**

This paragraph will sell more subscriptions in Glendale than any feature list. It proves you actually operate here.

### 4. How it works — three steps, with numbers
1. **Enter your USDOT number.** We pull your carrier profile, trucks, and drivers from FMCSA automatically. *(~60 seconds)*
2. **Confirm what we found and add your documents.** Photograph medical cards and inspection certs with your phone. *(~20 minutes)*
3. **We watch the calendar.** Email and text alerts before anything expires — and an audit-ready PDF binder any time you need it. *(ongoing)*

Put a **time estimate on every step.** The unstated fear is "this will take a week I don't have." Answer it with numbers.

### 5. Features — outcome-first, four to six blocks max
Each: outcome headline, one sentence, one real screenshot.
1. **Compliance calendar that knows the rules** — federal *and* California. MCS-150, UCR, 2290, IFTA, BIT, Clean Truck Check, medical cards, annual inspections.
2. **Loads without the retyping** — forward the broker's rate confirmation, we read it, you confirm in 10 seconds.
3. **Dispatch that checks compliance first** — the system won't let you assign a driver whose medical card expired yesterday.
4. **Alerts the way you want them** — email, text, daily digest or instant. Set your own reminders for anything.
5. **Know what each load actually made you** — revenue per mile, profit per load, worst-paying brokers.
6. **Audit binder, one click** — every document an auditor asks for, in order, as a PDF.

Resist listing 20 features. Feature-count competition is how you end up "sold things I don't need."

### 6. Comparison / honest positioning
Copy Truckbase's three-way frame, because it works and it's true:

| | Spreadsheets & WhatsApp | Enterprise TMS | FleetView |
|---|---|---|---|
| Cost | Free, until you miss a deadline | $500–$2,000+/mo | $X/truck/mo |
| Setup | Already done | Weeks to months | Under an hour |
| Contract | — | 1–3 years | **Month to month** |
| Keeps compliance dates | No | Sometimes, as an add-on | **Built in, incl. California** |
| Needs a full-time admin | You *are* the admin | Usually | No |
| Language | — | English only | **English, Spanish, Armenian, Russian** |

### 7. Pricing — published, on the homepage, above the fold of its own section
- **Two or three tiers. Per truck, per month. Nothing per seat.** Per-seat pricing is the #1 documented complaint in this segment — make "unlimited users" an explicit, bolded line item. Your users are a family; charging per family member is offensive and they will say so.
- Show the **actual monthly total** for 5, 10, 25 trucks. Don't make people multiply.
- State plainly: **no setup fee, no contract, cancel anytime, no auto-renewal trap.** Then say the quiet part: "We don't do 36-month contracts."
- Free tier or free trial with **no credit card**. TruckingOffice's 30-day-no-CC trial is the standard in the segment; Truckbase's demo-only approach is a documented weakness — don't copy it.
- Annual discount offered, never required.

### 8. Social proof
Honest ladder as you grow:
- **Now:** a founder's note with a real name, face, and the Glendale connection. For an immigrant-owned-business audience, *who you are* is a trust signal that no badge replaces. "I built this because…" with a photo outperforms a testimonial carousel you don't have yet.
- **Soon:** 3–5 named testimonials with company name, city, truck count, and photo. Specific and small beats vague and big: "Sarkis M., 9 trucks, Sun Valley" is more persuasive here than a Fortune 500 logo.
- **Later:** review-site badges once earned, and a short case study with a number ("caught 3 expired medical cards in the first week").

Put testimonials **in the customer's own language** where applicable, with translation available.

### 9. FAQ — write it against the real objections
Steal Truckbase's list and add the ones specific to you:
- How long does setup take? *(answer with a number)*
- Do I need to enter all my trucks and drivers by hand? *(no — USDOT pull)*
- Do my drivers need to download an app? *(no — we text them)*
- Is my data safe, and can I get it out if I leave? *(yes, full export, any time)*
- Does this replace my ELD? *(no — it connects to Motive/Samsara/Geotab)*
- Is there a contract? *(no)*
- What happens if I add or sell a truck mid-month? *(prorated — say it plainly)*
- Do you handle California BIT and Clean Truck Check? *(yes — spell out how)*
- ¿Está disponible en español? *(answer in Spanish)*
- Will you file my paperwork for me? *(be honest: no, we track it and prepare it — you or your service files it. Don't let people believe you're Simplex.)*

### 10. Closing CTA
Repeat the USDOT input field. Same offer, no new information. Add a phone number — this audience calls, and a real phone number on the site is a disproportionately strong trust signal for small business buyers.

### 11. Footer
Pricing, FAQ, contact with a real phone number and email, **SMS terms** (needed for 10DLC vetting, §D.3), privacy, terms, language switcher, physical address.

## E.3 Language strategy — specific to your market

- **Ship English and Spanish at launch.** Add **Armenian** and **Russian** for Glendale specifically — that's your actual neighborhood and nobody serves it.
- Translate the **whole funnel**, not just the marketing site: emails, SMS templates, error messages, the onboarding flow. A Spanish landing page leading to an English-only app is worse than no Spanish page — it's a bait-and-switch the user discovers after signing up.
- **Hire a native speaker who knows trucking** for the translations. Direct translation fails in B2B: *"dialectal variations and technical terminology can make the difference between appearing like an expert or an outsider."* Terms like "rate confirmation," "deadhead," "detention," "BIT inspection" have established colloquial forms among Spanish-speaking carriers — often the English term used as-is inside a Spanish sentence. Getting this wrong marks you as an outsider instantly.
- **hreflang tags** and separate indexed URLs per language for SEO. Spanish-speaking professionals search with different phrasing, not translated keywords.
- Remember the **SMS Unicode cost**: accented Spanish characters drop the segment limit from 160 to 70 characters. Design Spanish SMS templates short.

## E.4 What to AVOID

1. **"Book a demo" as the only CTA.** For a $100–300/month product sold to an owner who works 70-hour weeks, a mandatory sales call is the conversion killer. He will close the tab.
2. **Hiding pricing.** 15 of 21 competitors hide it. That is your differentiator — don't throw it away. Hidden pricing to this buyer reads as "expensive and they know it."
3. **Per-seat pricing, and any mention of "seats."** It is the most-complained-about model in the segment and it is structurally wrong for family businesses.
4. **Enterprise vocabulary.** "Leverage," "end-to-end visibility," "digital transformation," "unlock synergies," "operational excellence." Also avoid "revolutionize" and "game-changer." Write at an 8th-grade reading level in short sentences — good for non-native speakers, good for everyone, and it makes you sound like a trucking person rather than a software person.
5. **AI as the headline.** "AI-powered" is now noise, and in this segment it actively raises suspicion — Truckbase's own users complain the AI importer misses fields. Lead with the *outcome* ("no retyping rate cons"), mention the mechanism second, and always show the human confirmation step.
6. **Feature-count competition.** Being sold features they don't need is a documented top complaint. A shorter feature list reads as more focused, not less capable.
7. **Stock photography of clean smiling truckers by a spotless white semi.** This audience knows what a real truck yard looks like. Use product screenshots. If you use photos, use real ones.
8. **Fake urgency, fake scarcity, fake logos, fake review badges.** This is a small, tight, referral-driven community. One discovered fake ends you.
9. **Long forms.** Name, email, USDOT. That's it. Every extra field costs you.
10. **Auto-playing video with sound**, chat widgets that pop open aggressively, exit-intent modals. Annoying everywhere, worse for a skeptical buyer.
11. **Claiming to file paperwork you don't file.** Be precise about the boundary between tracking and filing. Getting this wrong generates refund requests and — worse in this community — word of mouth that you overpromise.
12. **A gated PDF whitepaper.** Nobody in this segment is downloading "The 2026 Guide to Fleet Compliance Transformation." Put the guide on the page, ungated, and let it rank in search.

---

## Summary recommendations

1. **Lead with compliance, not TMS.** The TMS space is crowded, and the small-fleet TMS price ceiling is real ($90–$490/mo). The compliance corridor is $5–$30/driver/month for software, and the incumbents there (J.J. Keller, Foley, Simplex) are all sales-gated, module-upsold, and English-only. Loads and dispatch are the expansion, not the entry.
2. **The USDOT-number instant-value hero is your best single asset.** Type 7 digits → see your own carrier profile and real deadlines in 60 seconds, before signup. FMCSA QCMobile makes it nearly free to build. Nobody does it.
3. **California BIT (90-day, changed Jan 2026) and CARB Clean Truck Check (semi-annual → quarterly Oct 2027, $32.13/vehicle, up to $10k/day penalties) are your local moat.** No national competitor models them correctly.
4. **Price per truck, publish it, unlimited users, month-to-month.** Every one of those four is a direct answer to a documented, sourced complaint about a named competitor.
5. **Start 10DLC registration immediately** — it's under $100 and up to 4 weeks of pure waiting. It is the longest-lead-time item in the plan.
6. **Ship Spanish at launch; Armenian and Russian for Glendale.** Whole funnel, native-speaker translation, or don't bother.
