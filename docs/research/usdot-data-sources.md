# Automating carrier data intake from a USDOT number — source research

**Research date: 2026-09-14.** Everything below was checked live on this date unless marked
UNVERIFIED. Facts marked **UNVERIFIED** could not be confirmed against a primary source —
treat them as leads, not as decisions.

**Goal:** fleet owner types one USDOT number at signup (and optionally authorizes us in
FMCSA's system). We pull everything else automatically.

---

## 0. THE HEADLINE — what changed in 2026, read this first

Three things changed recently and they reshape the whole integration plan:

1. **Motus replaced URS, the FMCSA Portal's registration functions, and the 1994 Licensing
   & Insurance (L&I) system.** Phase I (supporting companies) went live **2025-12-08**;
   legacy registration systems were **permanently retired 2026-05-14 at 8:00 PM ET**; Motus
   opened to all registrants in **May 2026**.
   Primary source: Federal Register notice **2026-08334**, "Availability of Motus, FMCSA's New
   Registration System", 91 FR 23144 (2026-04-29) —
   <https://www.federalregister.gov/documents/2026/04/29/2026-08334/availability-of-motus-fmcsas-new-registration-system>
   (full text: <https://www.federalregister.gov/documents/full_text/text/2026/04/29/2026-08334.txt>).
   A correction notice followed on 2026-05-06 (docket number error only):
   <https://www.federalregister.gov/documents/2026/05/06/2026-08819/availability-of-motus-fmcsas-new-registration-system>

2. **FMCSA created an explicit third-party role: "Transportation Service Provider" (TSP).**
   This is the officially sanctioned way for a SaaS to act on a carrier's behalf. Details in
   §7 below. *This is the single most important finding for this product.*

3. **USDOT PINs are gone.** Motus uses **Login.gov** + IDEMIA identity proofing + CLEAR
   business verification. "Registrants will be required to access the new registration system
   through Login.gov, removing the need for USDOT PINs."
   Source: <https://www.fmcsa.dot.gov/registration/modernization-faqs> (Transition from Legacy
   Systems section).

Practical consequence: **do not design around the FMCSA Portal PIN, the L&I filing system, or
URS.** Design around (a) the free Socrata open-data APIs for reading, and (b) Motus TSP
designation for writing.

---

## 1. FMCSA QCMobile API — `mobile.fmcsa.dot.gov/qc/services/`

**What it is.** FMCSA's official REST/JSON carrier-lookup API, aimed at mobile/dev use.
Developer site: <https://mobile.fmcsa.dot.gov/QCDevsite/>

### Auth
- Requires a **webKey**, passed as a query parameter: `?webKey=YOUR_KEY`.
- **Free.** Getting one: create a **Login.gov** account, sign in to the developer site, choose
  *My WebKeys* → *Get a new WebKey*, and fill out a form (Application Name, Type of
  Application — **commercial / non-commercial / academic**, estimated users, description, and a
  client secret you choose).
  Steps: <https://mobile.fmcsa.dot.gov/QCDevsite/docs/getStarted> ·
  <https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess> ·
  <https://mobile.fmcsa.dot.gov/QCDevsite/logingovInfo>
- **No approval gate documented** — "If an API request has a successful WebKey authentication,
  the resource server will provide responses with no additional steps."
  (<https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiAccess>)
- The form explicitly offers a **"commercial"** application type, which is the clearest
  available signal that commercial use is contemplated and permitted.
- Legacy accounts/keys were reset when Login.gov was introduced: *"Existing accounts and API
  keys have been reset and removed."* (<https://mobile.fmcsa.dot.gov/QCDevsite/logingovInfo>)

### Verified live behavior (probed 2026-09-14)
```
GET https://mobile.fmcsa.dot.gov/qc/services/carriers/21800
→ HTTP 404  {"content":"Must provide Webkey", ...}

GET https://mobile.fmcsa.dot.gov/qc/services/carriers/21800?webKey=TESTKEY123
→ HTTP 404  {"content":"Webkey not found", ...}
```
Note the **gotcha**: auth failures return **HTTP 404**, not 401/403. Error handling must read
the `content` field, not just the status code.

### Endpoints
Base: `https://mobile.fmcsa.dot.gov/qc/services/`
(source: <https://mobile.fmcsa.dot.gov/QCDevsite/docs/qcApi>)

| Endpoint | Returns |
|---|---|
| `/carriers/{dotNumber}` | Safety performance data by USDOT number |
| `/carriers/name/{name}?start=&size=` | Search by legal or DBA name (first 50 only; paginate with `start`) |
| `/carriers/docket-number/{docketNumber}/` | Lookup by MC/FF docket number |
| `/carriers/{dotNumber}/basics` | BASIC measures |
| `/carriers/{dotNumber}/cargo-carried` | Cargo classifications |
| `/carriers/{dotNumber}/operation-classification` | Operation classification |
| `/carriers/{dotNumber}/oos` | Out-of-service information |
| `/carriers/{dotNumber}/docket-numbers` | Associated docket numbers |
| `/carriers/{dotNumber}/authority` | Operating authority details |

### Response fields
Documented at <https://mobile.fmcsa.dot.gov/QCDevsite/docs/apiElements>. Carrier object:
`allowToOperate`, `outOfService`, `outOfServiceDate`, `complaintCount`, `dotNumber`, `mcNumber`,
`legalName`, `dbaName`, `phyStreet`/`phyCity`/`phyState`/`phyZip`/`phyCountry`, `telephone`,
plus passenger-vehicle counts (`busVehicle`, `limoVehicle`, `miniBusVehicle`,
`motorCoachVehicle`, `vanVehicle`, `passengerVehicle`).
BASIC object: `basicShortDesc`, `basicId`, `basicDesc`, `percentile` (numeric, or
"inconclusive" / "no violations" / "insufficient data"), `rdDeficient`, `rdsvDeficient`,
`svDeficient`, `snapShotDate`, `totalInspectionWithViolation`, `totalViolation`.

### Gotchas / limits
- **Rate limits: UNVERIFIED.** No rate-limit, quota, or throttling policy is published anywhere
  on the QCDevsite. Assume one exists, implement backoff, and keep a cached copy locally.
- **Terms of service: effectively none published.** The Login.gov page says *"By clicking
  'Continue' or 'Sign in' you agree to our terms and conditions"* — but that link is
  `href="#"` (a dead anchor). The only binding text presented is the standard **US Government
  information system** warning banner. So: no attribution requirement, no redistribution
  restriction, and no rate policy is actually documented. See §13.
- `percentile` for **property** carriers will not give you the restricted BASICs — the FAST Act
  hides those publicly (see §4).
- Name search caps at 50 results per page.
- The QCMobile app itself: <https://mobile.fmcsa.dot.gov/app>

---

## 2. SAFER Company Snapshot — `safer.fmcsa.dot.gov`

**Front door:** <https://safer.fmcsa.dot.gov/CompanySnapshot.aspx>
FMCSA describes it as *"a concise electronic record of a company's identification, size,
commodity information, and safety record, including the safety rating (if any), a roadside
out-of-service inspection summary, and crash information"*, available *"as an ad-hoc query
(one carrier at a time) free of charge."*

### The machine-usable URL (verified working with plain `curl`, no JS, no cookies, no auth)
```
https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string={DOT}
```
Live results 2026-09-14:
- `21800` → HTTP 200, 46 KB, `<TITLE>SAFER Web - Company Snapshot UNITED PARCEL SERVICE INC</TITLE>`
- `54283` → SWIFT TRANSPORTATION COMPANY OF ARIZONA LLC
- `125550` → ATLAS VAN LINES INC
- `65931` → `RECORD INACTIVE`
- `39874` / `76830` → `RECORD NOT FOUND`
`query_param` also accepts `MC_MX` and `NAME`.

### Fields present on the snapshot (extracted from the live page)
- **USDOT INFORMATION**: Entity Type, USDOT Status (ACTIVE / INACTIVE / OUT-OF-SERVICE),
  Out of Service Date, USDOT Number, State Carrier ID Number, **MCS-150 Form Date**,
  **MCS-150 Mileage (Year)**
- **OPERATING AUTHORITY INFORMATION**: Operating Authority Status (`AUTHORIZED FOR: …` /
  `NOT AUTHORIZED` / `OUT-OF-SERVICE`), MC/MX/FF Number(s)
- **COMPANY INFORMATION**: Legal Name, DBA Name, Physical Address, Phone, Mailing Address,
  DUNS Number, **Power Units**, Non-CMV Units, **Drivers**
- **Operation Classification** (Auth. For Hire, Exempt For Hire, Private(Property), etc.),
  **Carrier Operation** (Interstate / Intrastate HM / Intrastate Non-HM), **Cargo Carried**
  (29 checkboxes)
- **US Inspections/Crashes, 24 months**: Total Inspections, Total IEP Inspections; per type
  (Vehicle / Driver / Hazmat / IEP): Inspections, Out of Service, OOS %, and the **national
  average %** with its as-of date
- **Canada Inspections/Crashes, 24 months**: same shape
- **Crashes, 24 months**: Fatal / Injury / Tow / Total
- **Safety Rating**: Rating Date, Review Date, Rating (e.g. Satisfactory), Type
- Page footer states the data currency date ("content of the FMCSA management information
  systems as of 09/13/2026")

### Machine-readable form?
**No.** There is no CSV/XML/JSON variant of the Company Snapshot. FMCSA's own dataset entry for
it points only at the HTML page:
<https://data.transportation.gov/d/4kcp-cfmm> → accessPoint `text/html`:
`http://safer.fmcsa.dot.gov/CompanySnapshot.aspx`.
**The structured equivalent is the Company Census File (§3) plus the Vehicle Inspection /
Crash files — use those instead of scraping.**

### Is scraping permitted?
- `https://safer.fmcsa.dot.gov/robots.txt` → **404** (no robots.txt at all, so no declared
  crawl restriction). Verified 2026-09-14.
- No terms-of-use page is linked from the snapshot; the footer links are Feedback, Privacy
  Policy, USA.gov, FOIA, Accessibility, OIG Hotline, Web Policies.
- **Practically**: it is public-domain federal data with no robots restriction and no ToS, but
  it is a legacy IIS app and high-volume scraping is rude and fragile. Use it for *one-off
  verification and for the two fields Socrata doesn't give you cleanly* (the national-average
  OOS comparison, and the human-readable "Operating Authority Status" string), and cache.

### New on the snapshot (2026)
The "pending insurance cancellation" link now points to **Motus**:
`http://motus.dot.gov/customer/{dotNumber}/account`. The L&I link is a bare IP
(`http://152.122.44.163/LIVIEW/pkg_registration.prc_option`) — a legacy artifact, do not use.

---

## 3. Bulk / open data — `data.transportation.gov` (Socrata) — **THE PRIMARY SOURCE**

**Official program page:** <https://www.fmcsa.dot.gov/registration/fmcsa-data-dissemination-program>
(renders as "FMCSA Open Data Program"). FMCSA states it *"shares the FMCSA regulated entity
census and safety performance information at no charge to the public"* with the goal to
*"create opportunities for economic development."* Datasets are organized as: Entities with a
USDOT Number · Entities with Operating Authority · SMS Data · New Entrant OOS Orders.

> **Important system notice on that page:** *"The FMCSA Open Data Program has fully updated its
> active data structures to align with the deployed FMCSA Registration System (MOTUS). All
> modern, daily operational datasets under the 'Entities with Operating Authority' portfolio use
> the new MOTUS schema. Concurrently, legacy historical baseline files are preserved under their
> legacy schemas as a public archive for reference."*
> (page last updated 2026-06-29)

### Access mechanics
- Socrata SODA API. Pattern: `https://data.transportation.gov/resource/{id}.json?{field}={value}`
- SoQL supported: `$select`, `$where`, `$order`, `$limit`, `$offset`, `$group`, `count(*)`.
- **No auth required.** Anonymous requests are throttled per IP; a **free Socrata app token**
  (`X-App-Token` header) removes throttling: *"we do not throttle API requests that are using an
  application token, unless those requests are determined to be abusive or malicious"* —
  <https://dev.socrata.com/docs/app-tokens.html>. Over-limit → HTTP 429.
- `robots.txt` declares `Crawl-delay: 1` and blocks only `/browse` faceting URLs — the
  `/resource/` API is unrestricted. <https://data.transportation.gov/robots.txt>
- Catalog API for discovery: `https://data.transportation.gov/api/catalog/v1?q=...`
- Metadata/schema: `https://data.transportation.gov/api/views/{id}.json`
- License metadata on every FMCSA dataset reads
  `https://project-open-data.cio.gov/unknown-license/`, `Public Access Level: public`,
  publisher `Federal Motor Carrier Safety Administration`, contact `FMCSA.CDO@dot.gov`.
  ("unknown-license" is the Project Open Data placeholder for *no explicit license* — see §13.)

### The datasets that matter (all verified live 2026-09-14)

#### 3a. Company Census File — `az4n-8mr2` ★ the single best source
<https://data.transportation.gov/d/az4n-8mr2>
- **4,502,467 rows · 147 columns · row identifier `DOT_NUMBER` · refresh `R/P1D` (daily)**
  (rowsUpdatedAt 2026-09-14T12:00:31Z when checked)
- Data dictionary attached to the dataset: *MCMIS Company Census Data Dictionary (Rev08)
  2026-01-23.pdf*
- Query: `https://data.transportation.gov/resource/az4n-8mr2.json?dot_number=21800`
- **Verified sample response for DOT 21800** returned, among others:
  `mcs150_date=20260216`, `add_date=19740601`, `status_code=A`, `carrier_operation=A`,
  `mcs150_mileage=3221711602`, `mcs150_mileage_year=2025`, `phone=4048282525`,
  `email_address=fleetcompliance@ups.com`, `company_officer_1`, `company_officer_2`,
  `business_org_desc=CORPORATION`, `power_units=112321`, `truck_units`, `total_drivers=128806`,
  `total_cdl=28807`, `legal_name`, `dba_name`, full physical + mailing address,
  `safety_rating=S`, `safety_rating_date=19990803`, `review_type`, `review_date`,
  `docket1prefix/docket1/docket1_status_code` (×3), `hm_ind`, `dun_bradstreet_no`,
  interstate/intrastate 100-mile driver splits, all 29 `crgo_*` cargo flags, and the
  `owntruck/owntract/owntrail/…` + `trmtruck/…` (term-leased) + `trptruck/…` (trip-leased)
  equipment matrix.
- **This one call replaces almost the entire signup form.**

#### 3b. Operating authority + insurance (MOTUS-schema, live)
| Dataset | ID | Rows | Refresh | Key columns |
|---|---|---|---|---|
| Motus Carrier – All With History | `inys-ebih` | 133,873 | daily | `docket_number, usdot_number, op_auth_type, op_auth_status, min_cov_amount, cargo_req, bond_req, bipd_file, cargo_file, bond_file, legal_name, dba_name, addresses` |
| Motus Insur – All With History | `c5y8-a4uz` | 118,587 | daily | `docket_number, usdot_number, ins_form_code (BMC-91/BMC-34/…), ins_type_code, ins_class_code, max_cov_amount, underl_lim_amount, policy_no, effective_date, insurance_company_name, trans_date` |
| Motus Insur (daily diff) | `x96h-evps` | — | daily | same, delta only |
| Motus InsHist – All With History | `3uet-3z4i` | 35,454 | daily | adds `filing_status_reason`, `ins_type_desc`, **`cancl_effective_date`** |
| Motus AuthHist – All With History | `yu5v-wbh6` | — | daily | authority grant/action history |
| Motus RevokeSuspend – All With History | `wb4f-neki` | — | daily | suspensions/revocations + reason |
| Motus BOC3 – All With History | `6snj-ed7q` | — | daily | process-agent (BOC-3) filings |

**Verified enumerations (queried live 2026-09-14, `inys-ebih`):**
- `op_auth_status` ∈ **Active (99,307) · Pending (21,783) · Inactive (9,522) · Withdrawn (3,261)**
- `op_auth_type` ∈ Motor Carrier of Property (Except Household Goods) *(120,675)* · Broker of
  Property · Motor Carrier of Household Goods · Motor Carrier of Passengers · Freight Forwarder
  of Property · Mexico Domiciled Motor Carrier of Property · Enterprise Motor Carrier of Property
  · Broker of Household Goods · Freight Forwarder of Household Goods · (+ Mexico/Enterprise
  variants)
- **One row per operating authority**, so a DOT number can appear multiple times. UPS (21800)
  returns two rows, `MC116200` and `MC115495`, both Active.

★ **The insurance compliance check falls straight out of this one record**: compare
`min_cov_amount` (required — e.g. `750000.00`) against `bipd_file` (actually on file — e.g.
`1000000.00`), plus `cargo_req` vs `cargo_file` and `bond_req` vs `bond_file`. Also watch
`bus_undeliverable_mail` / `mail_undeliverable_mail` = `Y` — FMCSA can't reach them by mail,
which is a leading indicator of a revocation notice the owner never saw.

**Verified census enumerations (`az4n-8mr2`):** `status_code` ∈ **A** (active, 2,237,648) ·
**I** (inactive, 2,263,625) · **P** (pending, 1,194). California-domiciled + active:
**328,552** entities (`phy_state='CA' AND status_code='A'`) — useful for market sizing.

**Legacy (pre-Motus) equivalents are FROZEN.** `Carrier - All With History` (`6eyk-hxee`),
`Insur` (`ypjt-5ydn`), `ActPendInsur` (`qh9u-swkp`), `BOC3` (`2emp-mxtb`), `AuthHist`
(`9mw4-x3tu`), `Revocation` (`sa6p-acbp`), `InsHist` (`6sqe-dvqs`). Their descriptions now say:
*"This dataset was last refreshed on 05/14/2026 and will no longer be updated."*
**Gotcha: their Socrata `rowsUpdatedAt` still ticks daily even though the content is frozen — do
not use that timestamp as a freshness signal.** Use the Motus-prefixed datasets.

#### 3c. Safety / enforcement
| Dataset | ID | Rows | Refresh | Notes |
|---|---|---|---|---|
| **Vehicle Inspection File** | `fx4q-ay7w` | 8,302,114 | daily | 63 cols; per-inspection record |
| **Crash File** | `aayw-vxb3` | 4,991,776 | daily | 59 cols, from state police crash reports |
| **OUT OF SERVICE ORDERS** | `p2mt-9ige` | 399,500 | daily | `dot_number, legal_name, dba_name, oos_date, oos_reason, status, rescind_date` (New Entrant program) |
| SMS Input – Inspection | `rbkj-cgst` | 5,834,148 | monthly | inspections used in current SMS run |
| SMS Input – Violation | `8mt8-2mdr` | 6,808,260 | monthly | per-violation with weights |
| SMS Input – Crash | `4wxs-vbns` | — | monthly | crashes used in SMS |
| SMS Input – Motor Carrier Census | `kjg3-diqy` | — | monthly | census snapshot used by SMS |
| SMS AB PassProperty | `4y6x-dmck` | 716,962 | monthly | interstate + intrastate-HM, **21 cols, no percentiles** |
| SMS C PassProperty | `h9zy-gjn8` | — | monthly | intrastate non-HM, no percentiles |
| SMS AB Pass | `m3ry-qcip` | — | monthly | **passenger carriers only — 36 cols, INCLUDES `*_pct` percentiles and `*_basic_alert`** |
| SMS C Pass | `h3zn-uid9` | — | monthly | intrastate passenger, includes percentiles |

**Verified per-carrier query performance:** counting DOT 21800's inspections
(`fx4q-ay7w.json?dot_number=21800&$select=count(*)` → 29,146) returned in **~0.5 s**.
The most recent inspection returned had `insp_date=20260911` — i.e. **3-day lag**. This is
materially fresher than SAFER's monthly-ish snapshot cadence.

Sample violation row (`8mt8-2mdr`) — has everything needed to reconstruct a BASIC measure:
```json
{"unique_id":"742527801","insp_date":"28-AUG-24","dot_number":"511440","viol_code":"3922SLLS4",
 "basic_desc":"Unsafe Driving","oos_indicator":"false","oos_weight":"0","severity_weight":"10",
 "time_weight":"1","total_severity_wght":"10",
 "section_desc":"State/Local Laws - Speeding 15 or more miles per hour over the speed limit",
 "group_desc":"Speeding 4","viol_unit":"D"}
```

#### 3d. ★★ THREE GOTCHAS THAT WILL BITE YOU (all verified by live query, 2026-09-14)

**(1) The Motus datasets are NOT yet a complete replacement — they are the post-cutover feed.**

| | distinct DOT numbers | rows |
|---|---|---|
| Legacy `Carrier - All With History` (`6eyk-hxee`) | **1,679,121** | 1,860,604 |
| Motus `Carrier - All With History` (`inys-ebih`) | **126,790** | 133,873 |

Motus covers roughly **7.5%** of the entities the legacy file covers — only those that have
transacted since the 2026-05-14 cutover. Same pattern elsewhere: legacy Insur 467,984 rows vs
Motus Insur 118,587; legacy AuthHist 4,941,925 vs Motus AuthHist 161,456; legacy BOC3 1,860,604
vs Motus BOC3 137,868.
→ **For authority/insurance you must UNION the frozen legacy baseline with the live Motus feed,
preferring Motus where both have the entity.** That is exactly what FMCSA's own system notice
describes ("legacy historical baseline files are preserved… as a public archive" alongside
"modern, daily operational datasets"), but nothing on the portal warns you that the Motus files
alone will silently miss 90%+ of carriers.

**(2) The legacy datasets zero-pad `dot_number` to 8 characters. The Census and Motus datasets
do not.**
```
6eyk-hxee.json?dot_number=1196157    → []        ← silently empty, no error
6eyk-hxee.json?dot_number=01196157   → 1 row     ← "01196157"
az4n-8mr2.json?dot_number=1196157    → 1 row     ← "1196157"
inys-ebih.json?usdot_number=21800    → 2 rows    ← "21800"
```
Always query legacy datasets with `zfill(8)`. **This fails silently — an empty array, not an
error — so it will read as "this carrier has no operating authority" rather than as a bug.**
Also note the legacy insurance dataset keys on **`prefix_docket_number`**, not `docket_number`;
passing the wrong name returns `{"error":true,"message":"Unrecognized arguments [docket_number]"}`.

**(3) ★ `docket1_status_code` in the Census File is NOT the operating-authority status.**
Worked counter-example, DOT **1196157** (RB TRUCKING, Los Angeles — a one-truck LA carrier, i.e.
exactly your customer):
- Census `az4n-8mr2`: `status_code=A`, `docket1=MC529015`, **`docket1_status_code=A`**
- Legacy L&I `6eyk-hxee`: `common_stat=N`, `contract_stat=N`, `broker_stat=N`, `bipd_file=00000`
- **SAFER Company Snapshot: `Operating Authority Status: NOT AUTHORIZED`, and the MC/MX/FF
  Number(s) field is empty**

The carrier has a historical docket record but **no active authority**. If you render
`docket1_status_code` as "authority active," you will tell a customer they are legal to haul
for hire when they are not. **Use `op_auth_status` (Motus) / `common_stat`+`contract_stat`
(legacy) / SAFER's "Operating Authority Status" string / QCMobile `allowToOperate`, and treat
`docket*_status_code` as a docket-record flag only.**

Related: the same carrier shows `mcs150_date=20100611` — **16 years stale** — yet both Census
`status_code` and SAFER report **ACTIVE**, not INACTIVE. **FMCSA does not reliably flip carriers
to INACTIVE for a missed biennial update.** Do not infer biennial compliance from
`status_code`; compute it from the USDOT number per §7 and compare against `mcs150_date`.

#### 3e. Date-format gotchas
- Census / inspection / insurance dates are **`YYYYMMDD` strings**, not dates
  (`mcs150_date: "20260216"`).
- `change_date` / `final_status_date` are `"YYYYMMDD HHMM"` strings.
- SMS Input – Violation uses **`DD-MON-YY`** (`"28-AUG-24"`). Three different formats across
  three datasets from the same agency.
- Numerics are returned as **strings** throughout.
- `interstate_within_100_miles=99999` for UPS — sentinel values exist; sanity-check ranges.

---

## 4. SMS / BASIC scores — `ai.fmcsa.dot.gov/SMS`

### Public per-carrier page (no auth) — verified live
```
https://ai.fmcsa.dot.gov/SMS/Carrier/{DOT}/Overview.aspx
```
(also reachable via `https://ai.fmcsa.dot.gov/sms/safer_xfr.aspx?DOT={DOT}&Form=SAFER`, which
302s to the above). `robots.txt` on this host sets **`Crawl-delay: 60`** for all agents —
<https://ai.fmcsa.dot.gov/robots.txt>. Respect it: **at most 1 request/minute** if you scrape.

### What is public vs. login-gated
The page renders a section literally headed **"BASIC Status (Public Property Carrier View)"**.
For a property carrier (verified on DOT 21800):
- **Unsafe Driving → "Not Public"**
- **Crash Indicator → not public**
- **Controlled Substances and Alcohol → "Not Public"**
- Hours-of-Service Compliance, Vehicle Maintenance, Hazmat Compliance, Driver Fitness → shown
- FMCSA's own tooltip: *"property carrier safety data available to the public includes
  inspection and crash data, investigation results, and measures for all public BASICs.
  Property carriers can log in to view their own complete SMS results. All safety data on
  passenger carriers remains available to the public."*
- This is the **FAST Act of 2015** restriction; the page carries the statutory disclaimer.

Publicly visible without login: most recent investigation date + type, total inspections,
inspections with/without violations used in SMS, crash counts (fatal/injury/tow), driver and
vehicle inspection OOS percentages, placardable HM inspection counts, enforcement cases
(6 years), and links to Carrier Registration Details and Threshold.

**ISS (Inspection Selection System) value is login-gated**: *"If you are a motor carrier looking
for your Inspection Selection System (ISS) value, log in to the FMCSA Portal."*

### Downloads
`https://ai.fmcsa.dot.gov/SMS/Tools/Downloads.aspx` now **403s and redirects to**
<https://www.fmcsa.dot.gov/registration/fmcsa-data-dissemination-program#collapse28721> —
i.e. **the SMS download files have been folded into the Socrata datasets in §3c.** Use those.

### Regulatory status — the SMS overhaul is APPROVED BUT NOT YET IN EFFECT
<https://csa.fmcsa.dot.gov/prioritizationpreview> states (verified 2026-09-14):
> *"FMCSA is currently updating the SMS methodology to incorporate the approved changes. Until
> the updated system is in effect, carriers should continue to use the current SMS website to
> monitor their safety performance."*

Approved changes, summarized in the **2024-11-20 Federal Register notice** and previewed on that
site:
- BASICs renamed **"compliance categories"**; Unsafe Driving absorbs Controlled
  Substances/Alcohol and *all* operating-while-OOS violations; Vehicle Maintenance splits in two.
- ~950 violation codes collapse into ~**116 violation groups**; simplified severity weights.
- **Proportionate percentiles** (better behavior for small fleets).
- Carriers preview their future results by logging in at the Prioritization Preview site.
- Public Q&A webinar series (Part 1 aired 2025-01-16).

**Design implication:** build the BASIC/compliance-category model as data, not as hardcoded
enum. The category taxonomy will change. Also: *do not* promise customers a "CSA score" —
for property carriers the two most-asked-about BASICs are not public, and only the carrier's
own login (or a Motus/Portal-authorized session) reveals them.

---

## 5. Inspection & crash data — per-carrier access

**Best path: Socrata, §3c.** `fx4q-ay7w` (inspections) and `aayw-vxb3` (crashes) are filterable
by `dot_number`, refresh daily, and returned in well under a second in testing.

**PII: already handled by FMCSA.** The Vehicle Inspection File description states:
> *"Due to privacy restrictions driver information is not included in any inspection files
> released to the public."*
So public inspection data has **no driver names/CDL numbers**. You cannot get "which driver got
this violation" from public data — that only exists on the carrier's own copy of the inspection
report (and inside the FMCSA Portal / DataQs).

**Violation detail** lives in `8mt8-2mdr` (SMS Input – Violation), which is **monthly**, so
inspection *counts* are 3 days fresh but violation *detail* can be up to a month stale. Plan the
UI around that asymmetry.

**Company Safety Profile (CSP)** — the deep per-carrier report including selected items from
inspection and crash reports and review/enforcement results. **$20.00 per request, emailed
within 72 hours**, charged by "Computing Technologies, Inc."
<https://safer.fmcsa.dot.gov/CSP_Order.asp>. **Not automatable** — no API, human latency. Useful
as a one-time audit product, not as a signup step.

**DataQs** (challenging bad data): <http://dataqs.fmcsa.dot.gov>. Login-gated, no public API.
Relevant as a workflow you might *link* to, not integrate.

---

## 6. Licensing & Insurance (L&I) — mostly superseded

**Status: the L&I filing system is retired.** The L&I home page banner reads:
> *"All current registration functionality—including new applications in URS, changes and
> filings via L&I (Public), and registration options in the FMCSA Portal—will be permanently
> retired on Thursday, May 14, at 8:00 PM ET."*
(<https://li-public.fmcsa.dot.gov/LIVIEW/pkg_menu.prc_menu>, verified live 2026-09-14)

The **read-only carrier search still responds** at
`https://li-public.fmcsa.dot.gov/LIVIEW/pkg_carrquery.prc_carrlist?n_dotno={DOT}&pv_vpath=LIVIEW`
— but the page now contains a **Google reCAPTCHA** (`g-recaptcha-response` field is posted with
the query). **L&I is no longer scrapable.** There is no robots.txt (404).

FMCSA confirms historical access survives: *"Existing L&I and FMCSA Portal records will remain
available for viewing and verification."*
(<https://www.fmcsa.dot.gov/registration/modernization-faqs>)

**Get insurance data from Socrata instead** (§3b): `c5y8-a4uz` / `3uet-3z4i` give you
BMC-91 / BMC-34 / BMC-85 filings, form code, policy number, insurer name, coverage limits,
effective date and (in InsHist) cancellation effective date — daily. `inys-ebih` gives
`op_auth_status`, `min_cov_amount`, and the `bipd_file` / `cargo_file` / `bond_file` flags —
which is exactly the "is your insurance on file and is authority active?" signal.

Insurance filing requirements reference:
<https://www.fmcsa.dot.gov/registration/insurance-filing-requirements>

---

## 7. Motus / URS — what a carrier can authorize us to do ★

This is the answer to "can a third party act on the carrier's behalf?" — **yes, formally, via
the Transportation Service Provider role.**

### Definition (FMCSA's own words)
> *"Transportation service providers assist individuals or companies applying for and/or
> maintaining their FMCSA registration (USDOT Number or operating authority registration,
> biennial updates, reinstatements, etc.)."*
> — <https://www.fmcsa.dot.gov/registration/modernization-faqs>

> *"Transportation service providers (those who assist motor carriers, brokers, freight
> forwarders, and other entities that are required to register with FMCSA) will use the new
> system to register as an individual or to register their business information, to manage their
> users (only for businesses), and to perform authorized functions on behalf of the regulated
> entity the provider represents."*
> — 91 FR 23144, 2026-04-29

### How it works (verified from the modernization FAQs)
1. You create a **Login.gov** account and a Motus **user profile**, and pass **identity
   verification** (IDEMIA: QR code → photo of government ID → selfie; needs a smartphone/tablet).
2. You create a **company account** as a supporting company / TSP. You are issued a
   **new unique filer number**.
3. **No separate FMCSA vetting of TSPs:** *"While FMCSA does not have a separate vetting process
   for transportation service providers, all service providers will be required to create user
   profiles and company accounts and complete identity verification to access the new
   registration system."*
4. **The carrier designates you**, and **you accept the designation**: *"Registrants will be
   required to designate a service provider, and the provider must accept the designation before
   receiving access to any registrant's company account."*
5. You may then *"complete actions on the registrant's behalf … including completing data entry
   for an application for registration"* — **but** *"the registrant (company official) will also
   need to review the transportation service provider's entries and submit final oaths and
   certifications."*

### What this means for the product
- **You can legitimately be the carrier's filing agent** for MCS-150 biennial updates, address
  changes, reinstatements. That is a real, sellable, FMCSA-sanctioned service.
- **You cannot fully automate a submission** — the owner must review and certify. Your job is to
  pre-fill and remind, not to sign. (Which is fine: that's the same UX as TurboTax.)
- **Access is per-carrier and consent-based**, granted inside Motus, not by collecting the
  carrier's password. **Never ask a customer for their Login.gov credentials.**
- **Onboarding friction to be aware of:** every existing registrant must pass identity +
  business verification on first Motus access (~800,000 registrants). Your customers may hit
  this wall before they can designate you.

### Motus API?
**None published.** `motus.dot.gov` is a React SPA; probing showed an internal `/api/` namespace
exists (returns `{"message":"Cannot GET:/api/customer/21800/account"}`) but **there is no
developer documentation, no key issuance, and no published contract. Treat Motus as UI-only.
UNVERIFIED whether any public API is planned.** The FR notice mentions no API.

Motus build observed 2026-09-14: Web Version 1.1.37, built 2026-08-25.
Resources hub: <https://www.fmcsa.dot.gov/registration/resources-hub>
Feedback address FMCSA gives: NewRegSys@dot.gov

### MCS-150 biennial update — fully computable, no data pull needed ★
**49 CFR 390.19T(b)(2)–(3)** (and parallel 390.19) —
<https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-390/subpart-B/section-390.19T>

- **Month = last digit of the USDOT number**: 1=January, 2=February, 3=March, 4=April, 5=May,
  6=June, 7=July, 8=August, 9=September, **0=October**.
- **Year**: *"If the next-to-last digit of its USDOT Number is odd, the motor carrier … shall
  file its update in every odd-numbered calendar year. If the next-to-last digit … is even …
  every even-numbered calendar year."*
- **Penalty**: *"A person that fails to complete biennial updates … is subject to the penalties
  prescribed in 49 U.S.C. 521(b)(2)(B) or 49 U.S.C. 14901(a), as appropriate, and
  **deactivation of its USDOT Number**."*
- Worked example: DOT **21800** → last digit 0 → **October**; next-to-last digit 0 → even →
  **even years** → due October 2026. Census shows `mcs150_date=20260216` (filed early).

**This is a zero-integration feature.** From the USDOT number alone you can compute every future
biennial deadline; from `mcs150_date` in the Census File you know whether they've filed.
Also note: `status_code` in the Census File and "INACTIVE" in SAFER mean exactly
*"biennial update of MCS-150 data not completed"* (49 CFR 390.19(b)(4)).

### FMCSA Portal — still alive, still useful, still no API
<https://portal.fmcsa.dot.gov/login> — live, **Login.gov** sign-in (plus MyAccess/PIV for
federal staff). Registration functions disabled since 2026-05-14, but the Portal is still the
door to: full (non-public) SMS results, ISS value, crash/inspection history, and the
Drug & Alcohol Clearinghouse. FMCSA says the Portal will *eventually* be eliminated.
**No public API. No documented delegated access for third parties. Do not build on it.**

---

## 8. Drug & Alcohol Clearinghouse — `clearinghouse.fmcsa.dot.gov`

### 8.1 Is there an API for employers or C/TPAs? **No, and FMCSA has said so.**
FMCSA guidance ("Guidance on Clearinghouse Webservice interface") states that on plans for an
employer web-service interface, *"At this time, there are no integration specifications
available."* The stated reasons: FMCSA security requirements, the sensitivity of violation data,
and the rule's requirement that FMCSA **record specific consent inside the Clearinghouse** before
releasing detailed violation information — so employers and C/TPAs **must access the
Clearinghouse directly**. Indexed at <https://www.fmcsa.dot.gov/taxonomy/term/14811>.
*(fmcsa.dot.gov 403s automated fetch; wording recovered via search index — high confidence,
but re-read it yourself before quoting it to a customer.)*

**The only Clearinghouse web-services program that exists is for State Driver Licensing
Agencies**, not industry: *Drug and Alcohol Clearinghouse Web Services Development Handbook for
State Driver Licensing Agencies*, v1.3, March 2023 —
<https://clearinghouse.fmcsa.dot.gov/content/resources/DACH_RuleII_State_Dev_Guide_v1.3.pdf>
(JWT/certificate auth, REST pull + push notifications). Statutory hook: 49 CFR 382.725.

**The ceiling of available automation is a manual bulk upload in the portal**: employers may
upload a file of multiple drivers; the file must be **tab-delimited, XLS, or XLSX**, and batches
are **processed nightly between 8:00 p.m. and 8:00 a.m. ET**.
<https://clearinghouse.fmcsa.dot.gov/FAQ/Topics/Queries>

### 8.2 Query rules — 49 CFR Part 382 Subpart G
<https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-382/subpart-G>

- **Pre-employment: FULL query required** (§382.701(a)). A limited query does not satisfy it.
- **Annual: at least one query per CDL driver per year** (§382.701(b)); may be a **limited
  query**. If a limited query returns "information exists," the employer **must run a full query
  within 24 hours**; miss that window and *"the employer must not allow the driver to continue to
  perform any safety-sensitive function"* until the full query clears (§382.701(b)(2)).
- **The annual requirement is a rolling 365 days, not a calendar deadline.** FMCSA FAQ:
  *"Employers must conduct an annual query on current employees at least once within a 365-day
  period based on the date the employer conducted the last query, or another 12-month period
  determined by the employer."*
  → **The "January 31 annual query deadline" repeated in vendor blogs is marketing, not
  regulation. Do not hard-code it.** This is a real differentiator: track per-driver rolling
  365-day clocks.

### 8.3 Consent — the structural blocker for automation (§382.703)
- **Limited query → general written OR electronic consent, obtained OUTSIDE the Clearinghouse.**
  Retain **3 years from the date of the last query**. FMCSA FAQ: this general consent *"is not
  required on an annual basis, it may be effective for more than one year."*
  **This is the one piece a SaaS can genuinely own end to end.**
- **Full query → the driver must consent ELECTRONICALLY, inside the Clearinghouse**, for that
  specific query, using their own Clearinghouse/Login.gov registration. Every pre-employment
  query.
- Refusal to consent (either type) → the driver may not perform safety-sensitive functions.
- <https://clearinghouse.fmcsa.dot.gov/content/resources/employer/Query-Plan-Factsheet.pdf>

### 8.4 Cost — **$1.25 flat per query**, limited or full
<https://clearinghouse.fmcsa.dot.gov/Query/Plan>. Bundles never expire.
Ladder (FMCSA factsheet FMCSA-MCE-19-010): 1=$1.25 · 5=$6.25 · 10=$12.50 · 50=$62.50 ·
100=$125 · 500=$625 · 1,000=$1,250 · 5,000=$6,250 · 7,500=$9,375.
**Unlimited plan: $24,500, expires 12 months after purchase** —
<https://clearinghouse.fmcsa.dot.gov/Query/Unlimited>. Fee authority: §382.721.

Two commercial facts that matter:
1. A limited query that escalates to a full query is **charged once, not twice**.
2. **"C/TPAs cannot purchase queries on behalf of employers."** (Query Plan Factsheet, verbatim.)
   The employer must log in to their own account and buy the plan.
   **→ You cannot resell query credits, mark them up, or front the purchase.**

### 8.5 Can a third-party SaaS act on a carrier's behalf?
**Yes, by becoming a registered C/TPA and being formally designated — but NOT by holding the
carrier's credentials.**

- **§382.715(a): "No C/TPA or other service agent may enter information into the Clearinghouse on
  an employer's behalf unless the employer designates the C/TPA or other service agent."**
- **§382.711** — every employer, MRO, SAP and C/TPA must register before access; **§382.711(d)**
  requires a C/TPA to name its authorized persons and **verify those names annually**.
- **§382.713** — registration valid 5 years; **auto-cancelled after 2 years of no activity**;
  revocable for misuse.
- Designation mechanics: <https://clearinghouse.fmcsa.dot.gov/FAQ/Topics/Service-Agents> ·
  <https://clearinghouse.fmcsa.dot.gov/content/resources/employer/Designate-CTPA.pdf>

### 8.6 ★ Scraping / credential automation is effectively PROHIBITED
Binding document: *Drug & Alcohol Clearinghouse — FMCSA IT Rules of Behavior + Terms of Use*
(Nov 2022) —
<https://clearinghouse.fmcsa.dot.gov/content/resources/Terms-Conditions-Emp-Nov2022.pdf>

- **¶9** — accounts are linked to your Login.gov profile *"solely for the use of the individual
  for whom they were created. Your login.gov passwords or any other authentication mechanisms
  should never be shared."*
- **¶10** — *"Service agents must not create a Clearinghouse or login.gov account or change
  passwords or login credentials without the express consent of the driver or motor carrier."*
- **¶11** — *"Service agents, employers, or other third parties must not access another user's
  Clearinghouse account for any reason without first obtaining their specific written consent…
  a particular, explicitly identified, person or organization… at a particular time, and for a
  particular reason. The user must provide specific written consent **each time**… **'Blanket
  consent' … is prohibited.**"*
- **¶7** — non-public Clearinghouse info may be used *only* to determine whether a prohibition
  applies to a driver performing a safety-sensitive function (also 49 CFR 382.723(b)).
- **¶6** — *"FMCSA owns the data stored in this system."*
- **¶3** — registrants must not state that a C/TPA is *"approved or endorsed by FMCSA."*
- **¶15** — CFAA warning: accessing without authorization or **exceeding authorized access** —
  fine and up to **10 years in prison** for a first offense.

> **Design consequence: a headless-browser "log in as the carrier and scrape the Clearinghouse"
> feature violates ¶9/¶10/¶11 and carries CFAA exposure. Do not build it. Do not even prototype
> it.**

### 8.7 Owner-operators — a mandatory, recurring purchase (your LA segment)
**§382.705(b)(6), verbatim:** *"An employer who employs himself/herself as a driver must
designate a C/TPA to comply with the employer requirements in paragraph (b) of this section
related to his or her own alcohol and controlled substances use."*
§382.705(c): the employer normally retains ultimate responsibility — *except* for an
owner-operator whose C/TPA is designated under (b)(6). Owner-operators must still query
themselves at least annually.
<https://clearinghouse.fmcsa.dot.gov/FAQ/Topics/Employers,Service-Agents>

### 8.8 Penalties — use the current eCFR number
**49 CFR Part 386, Appendix B ¶(b)**, current text: a violation of 49 CFR part 382 **subpart G**
is subject to a civil penalty *"not to exceed **$7,155**"* —
<https://www.ecfr.gov/current/title-49/subtitle-B/chapter-III/subchapter-B/part-386/appendix-Appendix%20B%20to%20Part%20386>
Non-subpart-G part 382: recordkeeping $1,584/day up to $15,846; knowing falsification $15,846;
other $19,246; driver $4,812. 2026 inflation multiplier **1.02735** (91 FR, 2026-01-14) —
<https://www.federalregister.gov/documents/2026/01/14/2026-00535/civil-monetary-penalties-2026-adjustment>
**The "$6,386 per missed annual query" figure circulating in 2026 vendor content is stale.**

### 8.9 Clearinghouse-II (CDL downgrade) — in force, not pending
Final rule effective **2021-11-08**; **compliance date 2024-11-18** —
<https://clearinghouse.fmcsa.dot.gov/Learn/News/Item/Clearinghouse-II-begins>
SDLAs must query before issuing/renewing/upgrading/transferring a CLP/CDL (49 CFR 383.73(a)(8),
(b)(10), (c)(10), (d)(9), (e)(8), (f)(4)). On "prohibited" status the SDLA **must initiate a
downgrade under §383.73(q)** and has **60 days** to complete it; restoration only via the RTD
process in 49 CFR part 40 subpart O.
<https://clearinghouse.fmcsa.dot.gov/FAQ/Topics/CDL-Downgrades>
Nothing pending repeals this; 2026 Federal Register activity is ICR-renewal housekeeping only.

### 8.10 Recent changes (2025–2026)
- **2026-04-27 — mandatory identity proofing for NEW Clearinghouse registrants** in the Employer
  (no portal account), **C/TPA**, MRO, SAP, and invited-assistant roles: mobile app, government ID
  scan + selfie; the verified legal name is pulled in and **cannot be edited**. Existing users
  phased in later. <https://clearinghouse.fmcsa.dot.gov/Learn/News/Item/ID-verification>
  → **Another nail in any "we create accounts for carriers" model.**
- **2026-05-13 — Waste Management exemption** allowing a limited rather than full query for
  driver transfers among affiliates —
  <https://www.federalregister.gov/documents/2026/05/13/2026-09469/>
  Precedent: full-query relief comes only by named exemption.
- **2025-07-01 — CloudTrucks exemption application** proposing to use the Clearinghouse plus
  national databases in place of the part 391 employment-application process —
  <https://www.federalregister.gov/documents/2025/07/01/2025-12205/>
  **Worth tracking — closest thing to a tech-platform precedent in this space.**
- SORN: **DOT/FMCSA 010**, 84 FR (2019-10-22) —
  <https://www.federalregister.gov/documents/2019/10/22/2019-22915/>

**UNVERIFIED and contradicted by FMCSA's own pages — do NOT build to these:**
(1) a "December 2025 portal upgrade adding CSV bulk upload" (FAQ still says tab-delimited/XLS/XLSX only);
(2) a "late-2025 clarification that paper consent no longer satisfies the limited-query
requirement" (this contradicts §382.703(a) and the FAQ, both of which still say *written or
electronic*).

### 8.11 What to build instead (the defensible wedge)
Consent capture with 3-year retention · rolling 365-day per-driver query clocks · the 24-hour
full-query escalation timer · proof-of-query filing in the DQ file · owner-operator C/TPA
designation tracking · CDL-downgrade risk monitoring. **None of this requires FMCSA
registration.** Register as a C/TPA later, if and when you want to run the queries too.

---

## 9. California state-level

### 9.0 The California automation map
| Data | Key you need | Automatable? | Endpoint |
|---|---|---|---|
| **CA# ↔ USDOT, MCP status, full BIT history** | **USDOT** | ✅ **Yes — POST, no CAPTCHA** | `carriersafety.chp.ca.gov/Home/SearchCarrier` |
| **TRUCRS / Truck & Bus / ACF certificate** | **USDOT or CA#** | ✅ **Yes — bulk CSV, hourly** | `arb.ca.gov/carbapps/onrdiesel/compliantfleetlookup.csv` |
| CARB Clean Truck Check status | **VIN** (per vehicle) | ✅ Yes — plain GET, no auth | `cleantruckcheck.arb.ca.gov/Fleet/Vehicle/VehicleComplianceStatusLookup?VIN=` |
| CTC compliance **deadlines** | VIN last digit, or DMV reg month | ✅ Pure computation | CARB Tables I/II |
| DMV registration status | plate + last-5 VIN + owner name | ⚠️ Thin scrape; real channel is a DMV CRA | `dmv.ca.gov/wasapp/rsrc/vrapplication.do` |
| UCR registration status | USDOT | ❌ **reCAPTCHA-gated** | `ucr.gov` |
| IFTA license status | — | ❌ No public lookup anywhere | manual |
| IRP / apportioned status | — | ❌ No public lookup | manual |

---

### 9.1 ★ CHP Carrier Inspection Results — the single best California endpoint
<https://carriersafety.chp.ca.gov/> · landing page
<https://www.chp.ca.gov/programs-services/programs/commercial-vehicle-section/carrier-inspection-results>
Public disclosure is **mandated by AB 529**, so this is a stable, statutorily-required service.

**INDEPENDENTLY VERIFIED FROM A SCRIPT, 2026-09-14.** ASP.NET MVC,
`POST https://carriersafety.chp.ca.gov/Home/SearchCarrier`. **No CAPTCHA, no login.**

Working two-step flow:
1. `GET https://carriersafety.chp.ca.gov/` — keep the cookie jar, scrape the hidden fields.
2. `POST /Home/SearchCarrier` echoing **every** form field back.

Form fields (complete list, scraped from the live page):
```
__RequestVerificationToken       (anti-forgery, 108 chars, from step 1)
RootDir                          (empty)
ViewName                         ("Index")
Parameters.UserIPAddress         ← SEE GOTCHA BELOW
Parameters.IdentifierType        CARRIER | DOT | CALT | PSC | TCP | DOCKET
Parameters.Identifier            the number
Parameters.IdentifierSearchType  E | C | B   (exact / containing / begins-with)
Parameters.BusinessName, Parameters.BusinessNameSearchType
Parameters.Address, Parameters.AddressSearchType, Parameters.City
Parameters.Country (US|MX|CA|OT), Parameters.State
```

> **★ GOTCHA I hit and solved: `Parameters.UserIPAddress` is NOT an IP address.** It is an opaque
> per-session token (observed value: `3032230926P291457`) rendered into the GET page. Omit it and
> the POST returns HTTP 200 with **"An Error Done Occurred." and "0 Record(s) Returned"** — a
> *successful-looking* empty result, not an error status. You must scrape and echo it, along with
> `RootDir` and `ViewName` and every empty `Parameters.*` field.

My verified result for `IdentifierType=DOT`, `Identifier=54283`:
```
1 Record(s) Returned
407641 | 54283 | Active | SWIFT TRANSPORTATION CO OF ARIZONA LLC
```
Result columns: *Inspection Details (expander) · **CA/MCP #** · **DOT #** · **Status
(Active/Inactive)** · Business Name / DBA · City · Location · Cal-T # / Docket # / PSG #.*
Expanding a row returns **CSAT results** plus, **per terminal**: terminal #, current status, city,
and a dated history of **Maintenance / Driver / Equipment / Hazmat / Terminal** ratings and
inspection category. Observed rating strings: `Satisfactory`, `Not Applicable`,
`Unsatisfactory With No Fees Due`.

**Gotchas:** >~1,900 matches returns *"Too Many Records Returned, please refine."* No documented
update frequency and no published ToS or rate limit (**UNVERIFIED** whether automated access is
permitted — the `UserIPAddress` field suggests they log requests; keep volume low and cache).

★ **This one call is the whole California signup: USDOT in → CA#/MCP#, MCP Active/Inactive,
legal name, DBA, city, MC docket, and the full BIT terminal inspection history out.**

---

### 9.2 BIT — **"Basic"**, not "Biennial", Inspection of Terminals
**AB 529 (2013) recast *Biennial* Inspection of Terminals as *Basic* Inspection of Terminals**,
CVC §34501.12. Per the DMV MCP Handbook MC 500 M (rev. 3/2016),
<https://www.dmv.ca.gov/portal/file/mcp-handbook-pdf/>:
> *"CHP will select terminals for inspection based on available carrier performance data or the
> commodity transported, rather than the prior time-based mandate of once every 25 months."*

→ **It is no longer a fixed 2-year cycle. If the product says "biennial," it is wrong.**
Corroborated empirically: observed inspection dates for one terminal were 2025-10-09, 2023-04-19,
2021-11-23, 2020-03-03, 2015-06-22 — visibly not a 25-month cadence.

- **Who:** carriers operating CVC §34500 vehicles must designate terminals and keep vehicles and
  records available there. **CHP may inspect at any time.**
- **Ratings** per CHP 800H (<https://www.chp.ca.gov/siteassets/forms/o-chp800h.pdf>) and HPM 84.1
  ch.2 (<https://www.chp.ca.gov/siteassets/policy/hpm/hpm-84.1/hpm-84.1-ch-2.pdf>): rated per
  category — regulated vehicles, maintenance program, driver records, hazmat (if applicable) —
  each Satisfactory / Unsatisfactory, plus a composite terminal rating. **Conditional** = no
  longer unsatisfactory but compliance undeterminable → re-inspection in ~6 months.
  Unsatisfactory re-inspection initiated **no sooner than 100 and no later than 120 days**. A
  CVSA Level 1 roadside report within 90 days can satisfy the vehicle-sample requirement.
  *(These PDFs are image-based and could not be text-extracted — CHP-domain primary documents,
  but not machine-verified.)*
- **Consequence of failure: CHP-initiated MCP suspension** (MCP Handbook §4.015).
- **CHP 362 Motor Carrier Profile** is how a carrier gets a **CA#** — now an online application at
  <https://canumber.chp.ca.gov> (verified live). **Requires a USDOT number first.**
  **Application only — no lookup function.**

---

### 9.3 California Motor Carrier Permit (MCP)
DMV-issued, jointly administered with CHP.
<https://www.dmv.ca.gov/portal/vehicle-industry-services/motor-carrier-services-mcs/motor-carrier-permits/>

- **Who:** motor carriers of property per CVC §34500 — property for compensation; any motor truck
  ≥2 axles with **GVWR ≥ 10,001 lb**; truck tractors; any CMV ≥26,001 lb; placarded hazmat.
  Excludes household-goods carriers (PUC) and small non-commercial pickups.
- **CA# vs USDOT:** the **CA# is issued only by CHP** (CVC §34507.5) via CHP 362, and *is* the MCP
  number. It is **not** the USDOT number. A new Secretary of State filing or new FEIN forces a
  **new CA#**; the old one must be inactivated via MC 716 M. **CA# is non-transferable.**
- **Requirements:** CA#, MC 706 M application, proof of financial responsibility (MC 65 M),
  workers' comp certificate or signed exemption, full power-unit/trailer list with plate + VIN,
  **EPN enrollment**, and — for interstate — **UCR compliance**.
- ★ **Renewal: intrastate = ANNUAL. Interstate carriers get a NON-EXPIRING MCP and pay no renewal
  fee.** Online renewal at
  <https://www.dmv.ca.gov/portal/dmv-virtual-office/motor-carrier-permit-online-renewal/>
  (CA# + exact permit name + email; 2.3% card fee; allow 30 days for mailing).
  **→ Product trap: do not nag interstate carriers to renew an MCP.**
- **Fees** (<https://www.dmv.ca.gov/portal/file/basic-inspection-of-terminals-and-carrier-inspection-fee/>,
  effective 2016-01-01; **no newer chart found — UNVERIFIED that these are still current**).
  Full-year intrastate, Base (Safety Fee + UBLT) + CIF = Total:

  | Power units | For-hire total | Private total |
  |---|---|---|
  | 1 | **$250** | **$165** |
  | 2–4 | **$352** | **$187** |
  | 5–10 | **$727** | **$287** |
  | 11–20 | **$1,283** | **$813** |
  | 21–35 | **$1,718** | **$1,068** |
  | 36–50 | **$2,271** | **$1,391** |
  | 51–100 | **$2,722** | **$1,647** |

- **Delinquency penalties: 31 days–1 yr = +60%; 1–2 yrs = +80%; >2 yrs = +160%** of fees due.
  Steep — and a strong reminder-product hook.
- **Suspension triggers** (MCP Handbook ch. 4): DMV, **CHP (BIT/safety)**, FTB/BOE tax, insurance
  cancellation, DIR stop order, **EPN non-enrollment**. Reinstatement fee applies.
- **Public status lookup: ❌ DMV has none.** The "Active Motor Carriers" page offers no download;
  an Active Carrier List requires mailing form **MC 430 M** with fees; the posted per-letter
  listings are stale (last updated 2019).
  ✅ **Use `carriersafety.chp.ca.gov` instead — its `Status` column is keyed to USDOT.**
  (⚠️ **UNVERIFIED** that CHP's `Status` is strictly the DMV MCP status rather than a CHP carrier
  record status; it behaves as MCP status in practice.)

---

### 9.4 CARB Clean Truck Check (HD I/M) and TRUCRS

#### Public VIN lookup — ✅ VERIFIED LIVE 2026-09-14
```
GET https://cleantruckcheck.arb.ca.gov/Fleet/Vehicle/VehicleComplianceStatusLookup?VIN={17-char VIN}
```
Plain GET, **no reCAPTCHA, no login**. Returns a status sentence in the *Vehicle Compliance
Status* block. Confirmed unreported-VIN response: *"This vehicle is either not currently reported
or has been deactivated by the account user/vehicle owner and there is no compliance information
available for this VIN."*

Also: `GET .../Entity/EntityManagement/EntityComplianceStatusLookup?EntityID={CARB EntityID}` —
**keyed on a CARB-issued EntityID, not USDOT or CA#**, so practically useless unless you already
hold the customer's EntityID. Tester directory (with Excel export):
`https://cleantruckcheck.arb.ca.gov/Public/PublicTester/TesterList`

**There is no VIN→DOT or DOT→vehicle-list lookup, and no API or bulk download for CTC.**
Account login is Okta-based. User guide:
<https://www.cleantruckcheck.arb.ca.gov/wiki/_site/articles/home.html>

**Gotchas:**
- ★ **A CARB-issued Five-Day Pass is NOT reflected in the public lookup** — the page says so
  explicitly. A truck with a valid pass still reads non-compliant. One pass per vehicle per
  calendar year. <https://ww2.arb.ca.gov/resources/fact-sheets/five-day-pass-request>
- Status lag 1–3 business days after compliance is met; eCheck payments up to 7 business days.
  <https://ww2.arb.ca.gov/resources/fact-sheets/clean-truck-check-faq-0>
- No published rate limits or automated-access ToS — **UNVERIFIED** whether scraping is
  permitted; only the generic CA.gov Conditions of Use apply (<https://www.ca.gov/use/>).

#### Current 2026 requirements (primary-sourced)
- **Scope:** nearly all non-gasoline vehicles **GVWR > 14,000 lb** on CA public roads,
  **including out-of-state-registered vehicles**. <https://ww2.arb.ca.gov/our-work/programs/CTC>
- **Testing frequency today: semi-annual (2×/year)** for most; **annual** for agricultural
  vehicles and CA motorhomes. **Quarterly (4×/year) for OBD-equipped vehicles begins
  October 2027.**
  <https://ww2.arb.ca.gov/clean-truck-check-requirements-vehicles-subject-semi-annual-compliance>
- **Test type:** OBD scan for 2013+ diesel / 2018+ alt-fuel engines; smoke-opacity + visual ECS
  inspection for 2012-and-older diesel. **Tests accepted no more than 90 days before the
  deadline.**
- **Fee (per vehicle, annual): $32.13** for deadlines on/after 2026-01-01
  (<https://ww2.arb.ca.gov/resources/fact-sheets/clean-truck-check-compliance-fee-update-effective-112026>);
  **$33.12** for deadlines on/after 2027-01-01
  (<https://ww2.arb.ca.gov/annual-vehicle-compliance-fee-update-2027>). CCPI-indexed; CARB posts
  next year's figure by July 1.
- ★ **Deadlines are fully computable — no data pull needed:**
  - **CA-registered:** deadline months = DMV registration expiration month **and** +6 months
    (Jan-reg → Jan & Jul). **Frozen to the original reg month even if the DMV expiration later
    changes.**
  - **Non-CA-registered (and DMV-exempt): by last digit of VIN** — 3,9→Jan&Jul · 4→Feb&Aug ·
    5→Mar&Sep · 0,6→Apr&Oct · 1,7→May&Nov · 2,8→Jun&Dec.
    <https://ww2.arb.ca.gov/clean-truck-check-requirements-vehicles-subject-semi-annual-compliance/printable/print>
- **DMV registration hold is LIVE.** The SB 210 hold is placed automatically on non-compliant
  vehicles; CARB transmits a compliant-VIN list to DMV **nightly**; the hold clears 1–3 business
  days after compliance.
  <https://ww2.arb.ca.gov/resources/fact-sheets/clean-truck-check-ca-dmv-registration-hold-sb-210>
- **Out-of-state enforcement is active**: roadside at border crossings/ports/railyards, Remote
  Emissions Monitoring Devices (REMD), ALPR, CHP authority, port/railyard denial.
- 2025 enforcement stats CARB publishes (HTML only, no CSV): 277,871 vehicles screened, 750,184
  registered in CTC-VIS, 7,183 non-compliance letters, 3,410 NOVs, 1,681 certificates denied —
  <https://ww2.arb.ca.gov/our-work/programs/enforcement-policy-reports/enforcement-data-portal/enforcement-data-clean-truck>

#### ★ TRUCRS bulk CSV — the best free bulk feed in the California stack
TRUCRS (<https://ssl.arb.ca.gov/trucrs_reporting/login.php>) now serves four regulations: Truck &
Bus, Advanced Clean Fleets, Zero-Emission Airport Shuttle, Solid Waste Vehicle.
<https://ww2.arb.ca.gov/our-work/programs/truck-bus-regulation/trucrs-reporting-information>
Truck & Bus itself remains in effect (2010-or-newer engine required since 2023-01-01;
non-compliance → **DMV registration denial**).

**INDEPENDENTLY VERIFIED 2026-09-14:**
```
GET https://www.arb.ca.gov/carbapps/onrdiesel/compliantfleetlookup.csv
→ HTTP 200 · text/csv · 3,155,626 bytes · 40,907 lines
Header: "TRUCRS ID",Name,"Carrier Number","Carrier Type",Complies,"Date Certificate Printed","ZEV Fleet"
Sample:  85,"Disneyland Resort",1025131,"USDOT Number",ACF,"2025-12-22 02:04:27",Y
```
- **`Carrier Type` is literally `CA Number` or `USDOT Number` → you can join directly on your
  customer's USDOT.** I counted **17,884 USDOT-keyed rows**.
- `Complies` values seen: `TB`, `ACF`, `ACF/TB`. **Updates hourly.**
- Interactive tool: <https://ww2.arb.ca.gov/applications/truck-and-bus-regulation-check-compliance-status>
  (app at <https://www.arb.ca.gov/carbapps/onrdiesel/tblookup.php>, POST fields `KEY`, `ZEV`,
  `Submit1`; searchable by fleet name, TRUCRS ID, or Motor Carrier Number).
- ★ **Coverage gotcha: a fleet only appears after it clicks "Click to Confirm" AND "Print
  Certificate" in TRUCRS.** With 17,884 USDOT-keyed rows against 328,552 active CA-domiciled
  entities in the FMCSA census, **absence is the normal case. Absence ≠ non-compliance; absence =
  "no printed certificate." Never render it as a red flag.**

#### Advanced Clean Fleets — repeal in progress, **final status UNVERIFIED**
- CA **withdrew** its CAA waiver request for ACF on **2025-01-13**.
- CARB board **voted 2025-09-25** to repeal the **High-Priority, Federal, and Drayage** fleet
  provisions.
- **Primary source** (<https://ww2.arb.ca.gov/rulemaking/2025/acfab1594>): *"The Final Package was
  submitted to OAL on July 29, 2026. OAL has until September 11, 2026, to make their decision."*
  The **"Final Approval / OAL Action"** section still reads **"This stage has not yet been
  reached."**
- ⚠️ **UNVERIFIED whether OAL approved on/before 2026-09-11.** The decision window closed three
  days before this research date and CARB has not posted the outcome. Trade press reported the
  repeal would take effect 2027-01-01. **Do not ship ACF High-Priority/Drayage tracking as
  authoritative — re-check that page before launch.**
- **State & local government agency fleet ACF requirements are NOT repealed.** Irrelevant to
  private LA small fleets — so for your target customer, **ACF is effectively dead weight.**

#### CARB open data
**Nothing useful.** A `data.ca.gov` package search for the Air Resources Board organization
returns **1 dataset** ("Vehicle Fuel Economy") — nothing on CTC, TRUCRS, or heavy-duty
compliance. `compliantfleetlookup.csv` is the only real bulk feed CARB publishes here.

---

### 9.5 California DMV — commercial vehicle registration
**No public VIN/plate registration API.** Three tiers:
1. **Free renewal-status check** —
   <https://www.dmv.ca.gov/portal/vehicle-registration/vehicle-registration-status/>
   (app at `https://www.dmv.ca.gov/wasapp/rsrc/vrapplication.do`). Inputs: **license plate
   (≤8 chars) + last 5 of VIN or owner/company name**. No CAPTCHA on the entry form. But it
   reports *renewal-application* status and is **not documented to expose expiration date, fees
   due, or the SB 210 hold.** ⚠️ Weak signal.
2. **$2 own-vehicle record online / $5 INF 70 by mail** —
   <https://www.dmv.ca.gov/portal/customer-service/request-vehicle-or-driver-records/online-vehicle-record-request/>
3. ✅ **The real answer: DMV Commercial Requester Account (CRA)**, VC §1810.2 (see §13.6).
   Application **INF 1106**; **$50** app fee (or $250 + $50,000 bond for confidential residence
   addresses — you don't need that). Delivery: **online (instant)**, **Secure File Transfer batch
   (overnight)**, or paper (7–14 days). **$2/electronic record, $100 per 1,000 bulk.** Requester
   code expires every **2 years**; staff must sign INF 1128; records retained 2 years. DPPA
   permissible use applies.
   **→ The only lawful automated path to registration expiration and SB 210 hold data at scale.**

**CVRA** (VIRPM 13.020,
<https://www.dmv.ca.gov/portal/handbook/vehicle-industry-registration-procedures-manual-2/commercial-vehicles/commercial-vehicle-registration-act-of-cvra/>):
vehicles at **GVW/CGW ≥ 10,001 lb** pay CVRA fees instead of weight fees; owner files **REG 4008**
declaring operating weight (required at unladen ≥6,001 lb; pickups exempt). **Weight decals are
issued once**; renewals issue only CVRA + ACTM year stickers unless the declared weight changes.
**A CVRA weight decal fee is due on every original, renewal, and weight change.** Registration
renews **annually**; Partial Year Registration (PYR) exists for seasonal operators.

**CVRA weight code → decal number** (relevant to the open weight-column decision):
A 10,000–15,000→**15** · B →**20** · C →**26** · D →**30** · E →**35** · F →**40** · G →**45** ·
H →**50** · I 50,001–54,999→**54** · J →**60** · K →**65** · L →**70** · M →**75** ·
N 75,001–80,000→**80**.

---

## 10. IFTA / IRP / UCR

### 10.1 IFTA — administered by **CDTFA** in California
<https://cdtfa.ca.gov/taxes-and-fees/fuel-tax-and-fee-guides/IFTA-and-interstate-user-diesel-fuel-tax/international-fuel-tax-agreement.htm>
- **Who:** CA-based qualified motor vehicles (3+ axles, or 2 axles >26,000 lb) traveling into
  other IFTA jurisdictions, with a physical CA place of business and records kept in CA.
- **Quarterly due dates — last day of the month following the quarter:**
  **Q1 → Apr 30 · Q2 → Jul 31 · Q3 → Oct 31 · Q4 → Jan 31.** Weekend/holiday rolls to the next
  business day; must be paid by **midnight** of the due date. **Returns must be filed online, even
  for zero travel.** <https://cdtfa.ca.gov/taxes-and-fees/ifta-ciudft-di-license-onlinefiling.htm>
- **Penalty: $50 or 10% of net tax due, whichever is greater**, plus per-jurisdiction interest.
  Failure to file → CDTFA bills using industry-average MPG, **excluding your fuel-tax credits**.
- **License/decals:** calendar year Jan 1 – Dec 31. **Renewal opens December 1.**
  **$10/year per carrier + $2 per decal set** (one set of two per qualified vehicle).
  **Grace period: prior-year decals valid through the last day of February** if renewed online by
  Dec 31 and in good standing (carry the new license + Temporary Decal Permit). **Records retained
  4 years.**
  <https://cdtfa.ca.gov/taxes-and-fees/fuel-tax-and-fee-guides/IFTA-and-interstate-user-diesel-fuel-tax/getting-started.htm>
- **Status lookup: ❌ none.** CDTFA's *Verification of Permits, Licenses, or Accounts*
  (<https://onlineservices.cdtfa.ca.gov/?Link=PermitSearch>) covers **only** seller's permits,
  cigarette/tobacco retailer licenses, and eWaste accounts — **IFTA is not included.**
- **IFTA, Inc.** (<https://www.iftach.org/Carriers/>) publishes tax-rate and exemption databases,
  manuals, and notices — **no public license-validity lookup or API found.** The **IFTA
  Clearinghouse** (on IRP, Inc. infrastructure) is **jurisdiction-to-jurisdiction only**.
  ⚠️ **UNVERIFIED** whether any commercial validity web service exists under license.
- **Automatable? Deadline reminders and fee math only.** Mileage/fuel data must come from the
  carrier's own ELD/telematics or fuel-card feed (**see §12 — Motive exposes an `IFTA` scope and
  Terminal exposes an `IFTASummary` model**), not from CDTFA. Filing cannot be automated by a
  third party without CDTFA online-services credentials.

### 10.2 IRP / apportioned plates
<https://www.dmv.ca.gov/portal/vehicle-registration/new-registration/commercial-vehicle-registration/international-registration-program/>
· Handbook <https://www.dmv.ca.gov/portal/handbook/irp/>
- Required for most CA-based commercial vehicles at **GVW/CGW ≥ 26,001 lb** operating in CA plus
  ≥1 other jurisdiction.
- **Renewal: annual, by midnight on the last day of the fleet's registration expiration month**
  (<https://www.dmv.ca.gov/portal/handbook/irp/chapter-6-irp-renewal/>). Registration periods are
  **staggered per account**. DMV mails preprinted renewal documents; the billing-invoice balance
  is due within **20 days** of the billing date. A Certificate of Non-Operation filed within
  **90 days** waives penalties only.
- Forms: MC 2117 I (Schedule A/B), MC 2118 I (Schedule C), MC 522 I record-keeping agreement,
  REG 31, MCS-150/USDOT, HVUT 2290 proof, MC 5034 I for agents. **Schedule B actual distance by
  jurisdiction** drives fee apportionment.
- **No online IRP renewal and no public status lookup. ❌ Not automatable.**
- **IRP, Inc. Clearinghouse** (<https://www.irponline.org/page/resource_center>): accounts are
  created by a **jurisdiction's Clearinghouse Jurisdiction Administrator** — a member-jurisdiction
  system for netting fees and audit research, **not open to carriers or third-party SaaS.**
- **Automatable?** Renewal-date reminders from a user-entered expiration month. Nothing else.

### 10.3 UCR — Unified Carrier Registration ★ freshest change in this report
- **Deadline:** register and pay before **January 1** of the registration year; the **2027 portal
  opens 2026-10-01** — i.e. about two weeks from this research date.
  <https://plan.ucr.gov/> · <https://plan.ucr.gov/fee-brackets/>
- ★ **2027 fees increased ~20%** by FMCSA final rule published **2026-09-01**, effective
  **2026-10-01**, codified at 49 CFR §367.50 —
  <https://www.federalregister.gov/documents/2026/09/01/2026-17893/fees-for-the-unified-carrier-registration-plan-and-agreement>
  **Update any hard-coded fee table.**

  | Vehicles | 2026 | **2027** |
  |---|---|---|
  | 0–2 (and all brokers/leasing) | $46 | **$55** |
  | 3–5 | $138 | **$167** |
  | 6–20 | $276 | **$333** |
  | 21–100 | $963 | **$1,163** |
  | 101–1,000 | $4,592 | **$5,548** |
  | 1,001+ | $44,836 | **$54,165** |

- **Status lookup: ❌ reCAPTCHA-gated.** The National Registration System at
  <https://www.ucr.gov/> takes a USDOT number with no login and shows the registration/payment
  indicator per year, **but is protected by invisible reCAPTCHA v3**
  (`https://www.google.com/recaptcha/api.js?render=6Lc5bYgUAAAAALG0NkORVD_gqpULwm16q-KyYNDx`)
  plus a mandatory terms-acceptance checkbox. **Not automatable without CAPTCHA circumvention —
  which violates the site terms. Don't.** Commercial scrapers of this endpoint exist; they are on
  the wrong side of that line.
- **Automatable?** Fee computation and Oct-1 / Dec-31 reminders: yes. Status verification:
  manual, or have the customer paste their confirmation.

---

## 11. Commercial data vendors (context / fallback)

**Bottom line: this is nearly a non-decision.** Free FMCSA sources cover authority, insurance,
safety, BASICs and OOS. Every meaningful commercial vendor here sells to **brokers and
shippers**, not to carriers, and gates its API behind an enterprise contract.

### Affordable and actually relevant (< ~$100/mo)
- **SaferWebAPI — $30/month, unlimited requests, 15-day free trial, no credit card, up to 3 API
  keys.** Endpoints `GET /v2/usdot/snapshot`, `/v2/usdot/name`, `/v2/sms`.
  <https://saferwebapi.com/> · docs <https://saferwebapi.com/documentation/snapshots-usdot>
  → The only paid vendor that is both affordable and a genuine fit. It is a wrapper over the
  same free federal data, so treat it as *insurance against SAFER/QCMobile flakiness*, not as a
  data advantage.
- **Carrier Assure** — free "Individual" tier (1 account, unlimited SuspectCarrier reports);
  Premium **"$149 USD Per month after offer period"**; **API only on Enterprise (custom)**.
  <https://www.carrierassure.com/pricing>. Broker-side carrier *scoring*, not compliance.
- **Highway for Carriers — free to carriers**, gives carriers broker verification and
  FMCSA-contact-change fraud alerts. <https://highway.com/highway-for-carriers>. **No
  carrier-facing API.** Relevant as the incumbent your customers already touch.

### Out of budget / wrong buyer
| Vendor | API? | Price | Note |
|---|---|---|---|
| **RMIS** (Truckstop) | Yes — 8 APIs (Delta, Expanded Carrier, Document, Carrier Status, Invitation, Registration Step, 2× ELD location). <https://developer.truckstop.com/reference/rmis-overview> | ~$340/mo "RMIS Lite" per a third party (<https://tekpon.com/software/truckstop-rmis/reviews/>) — **UNVERIFIED** | Access via DocuSign intake + human follow-up. Broker-facing |
| **Descartes MyCarrierPortal** (ex-MyCarrierPackets) | Not mentioned on pricing page | **$515/month** Standard — <https://www.mycarrierportal.com/features/pricing/> | Broker-facing. 5× over budget |
| **Carrier411** | No documented public API | Not published; third parties cite ~$30–50/user/mo and a $99/mo brokerage tier — **UNVERIFIED** (site 403s automated fetch) | <https://www.carrier411.com/> · FreightGuard has drawn defamation-litigation scrutiny |
| **DAT** | Portal at <http://developer.dat.com/> (account required) | Third-party claims $500–$1,000 production setup — **UNVERIFIED** | <https://www.dat.com/api-integration>. Load-board economics |
| **Truckstop.com** | Same portal as RMIS | — | Wrong buyer |
| **SaferWatch** | Yes — <https://www.saferwatch.com/helpdocs/WebServices/Integration.php?version=31> | Not published — **UNVERIFIED** | Broker/shipper-facing |
| **CarrierSource** | Yes — <https://docs.carriersource.io/reference/get_carriers-1> | Not published — **UNVERIFIED** | Shipper-side discovery/reviews |
| **Zyla "Motor Carrier Search API"** | Yes | **$99.99/mo for 1,000 requests**, overage $0.12999/req — <https://zylalabs.com/api-marketplace/data/motor+carrier+search+api/350> | 3× SaferWebAPI's price for a capped resale of free federal data. **Avoid** |

---

## 12. ELD / telematics vendor APIs — where "trips" data comes from

### Verdict table
| Vendor | Customer-consent access? | Auth | Self-serve? | Difficulty (1=easy) |
|---|---|---|---|---|
| **Motive** | Yes | `X-API-Key` **or** OAuth 2.0 | **Yes, fully** | **1–2** |
| **Samsara** | Yes | API token **or** OAuth 2.0 | Token yes; OAuth needs partner approval | **2** |
| **Geotab** | Yes | Customer's MyGeotab username/password → session token | Yes, open SDK | **2** |
| **Verizon Connect** | Yes, but gated | Base64 creds → 20-min bearer | **No** — customer must request creds from Verizon per account | **4** |
| Omnitracs/Solera | Partner-gated | n/a | No public portal | **5** |
| ISAAC | Partner-gated | n/a | Application form only | **4–5** |
| Platform Science | Partner-gated | n/a | Portal request form | **4–5** |
| Budget ELDs (Matrack, HOS247, TruckX, …) | Mostly ad hoc | varies | rarely documented | **3–5** |

### Motive (ex-KeepTruckin) — lowest friction
- Docs <https://developer-docs.gomotive.com/> · portal <https://developer.gomotive.com/> ·
  base **`https://api.gomotive.com/v1/`**
- Customer generates an **`X-API-Key`** under Admin → Developers → "+Request API Key". Multiple
  keys per org, and there is a **test mode**.
  <https://developer-docs.gomotive.com/docs/authentication>
- Or OAuth 2.0: authorize `https://gomotive.com/oauth/authorize`, token
  `https://api.gomotive.com/oauth/token`, code TTL 10 min, **17 scope groups** (HOS, Inspection
  Reports, Fault Codes, IFTA, Vehicles, Users, Locations, Driver Performance, …).
  <https://developer-docs.gomotive.com/docs/oauth-20>. App creation is **self-serve**.
- Endpoints: HOS `v1/logs`, `v2/logs`, `v1/hours_of_service`, `v1/available_time`,
  **`v1/hos_violations`**; DVIR
  <https://developer-docs.gomotive.com/reference/overview-inspection-reports.md>; locations
  v1/v2/v3; fault codes; users; vehicles.
- **Webhooks: strong.** v1 HTTP + v2 to AWS SQS/SNS. Events include duty-status change,
  **HOS violations**, **DVIR created/updated**, fault code open/close, engine on/off, geofence.
  HMAC-SHA1 in `X-KT-Webhook-Signature`, **3-second response timeout**, retries at 1 min / 1 hr /
  6 hr, max 2 active webhooks per action.
  <https://developer-docs.gomotive.com/reference/webhooks-v2.md>
- **Rate limits: UNVERIFIED — not published.** Build backoff anyway.
- Marketplace <https://marketplace.gomotive.com/>; partner terms
  <https://gomotive.com/legal/partner-program-terms-of-service/>. **Fees/rev-share UNVERIFIED.**
  You do **not** need marketplace approval to start.

### Samsara — best-documented
- Docs <https://developers.samsara.com/docs/getting-started> · base `https://api.samsara.com`
- Customer generates a scoped **API token** (Settings → API Tokens) — works day one, no partner
  approval. <https://developers.samsara.com/docs/authentication>
- OAuth 2.0 for Marketplace apps: `/oauth2/authorize`, `/oauth2/token`, `/oauth2/revoke`.
  Access token 1 hour; **refresh tokens are single-use** (rotate every refresh); scopes are
  coarse (`admin:read` / `admin:write`). <https://developers.samsara.com/docs/oauth-20>
- Endpoints: HOS logs `GET /fleet/hos/logs` (**5 req/s**)
  <https://developers.samsara.com/reference/gethoslogs>; HOS clocks `/fleet/hos/clocks`; daily
  logs `/fleet/hos/daily-logs`; vehicle stats history `GET /fleet/vehicles/stats/history`
  (odometer GPS+OBD, engine seconds, fuel, fault codes)
  <https://developers.samsara.com/reference/getvehiclestatshistory>; trips `GET /trips/stream`
  (5 req/s, ≤50 asset IDs, cursor pagination); DVIR `GET /fleet/dvirs/history`, `POST
  /fleet/dvirs`, `PATCH /fleet/dvirs/{id}`.
- **Rate limits: 150 req/s per token, 200 req/s per org**, plus per-endpoint tiers
  (100/min, 5/s, 10/s). 429 + `Retry-After`. <https://developers.samsara.com/docs/rate-limits>
- Partner program: apply at partners-samsara.com; *"Samsara will review and approve/deny
  applications on a weekly basis"*, **5–7 business days**; **no fee mentioned**.
  <https://developers.samsara.com/docs/application-process>. Marketplace certification reviews
  are quarterly. <https://developers.samsara.com/docs/marketplace-apps>. **Rev-share UNVERIFIED.**
- Webhooks: yes, HMAC-SHA256 signed, 5 delivery attempts with backoff, fixed egress IPs.
  <https://developers.samsara.com/docs/webhooks>
- ⚠️ **Biggest risk: Samsara gates endpoints by the customer's license tier.** Per the KB article
  *Required Licenses for API and Webhooks Usage*
  (<https://kb.samsara.com/hc/en-us/articles/20572537516557-Required-Licenses-for-API-and-Webhooks-Usage>):
  Telematics Essential covers vehicle stats/routes/DVIRs; **HOS/ELD endpoints require Telematics
  Essential Plus**; safety scores and compliance settings require Premier.
  **UNVERIFIED by direct fetch — kb.samsara.com returns 403 to automated fetch. Check by hand
  before promising HOS sync to a Samsara customer on a cheap plan.**
- HOS retention is customer-configurable; Samsara purges expired data nightly at 00:00 UTC
  (**UNVERIFIED**, same 403). Docs advise waiting a couple of days before querying HOS.

### Geotab — most open, but a different shape
- JSON-RPC at `https://<server>/apiv1/`, **no app registration, no API key, no partner approval**.
  You authenticate with the **customer's MyGeotab username + password + database**, get a
  session token valid ~2 weeks.
  <https://developers.geotab.com/myGeotab/guides/gettingStarted/>
  → **Trade-off: you hold dashboard credentials. No OAuth consent screen, no scoped revocation.
  For a compliance SaaS that is a real trust liability — insist the customer create a dedicated
  limited-clearance API-only user.**
- Entities (called via `Get`/`GetFeed` with a `typeName`): **`DutyStatusLog`** (HOS), `Device`,
  `User`, `Trip`, `StatusData` (odometer/engine), `FaultData`, `ExceptionEvent`, `DVIRLog`,
  `LogRecord`. <https://developers.geotab.com/myGeotab/apiReference/objects/>
- Rate limits per method+entity+user+database, tiered by fleet size (Tier 1 0–1,000 assets ×1 …
  Tier 4 ×25). `DutyStatusLog`: **Get 400/min**, Set/Add/Remove 250/min, page cap 25,000.
  Headers `X-Rate-Limit-*`; over-limit → `OverLimitException` + `Retry-After`.
  <https://developers.geotab.com/myGeotab/guides/rateLimits/index.html>
- Use **`GetFeed`** (checkpointed streaming), not polling:
  <https://developers.geotab.com/myGeotab/guides/dataFeed/index.html>. **No general webhooks.**
- Marketplace listing optional; free SDK. **Listing fees / rev-share UNVERIFIED.**

### Verizon Connect (Reveal / Fleetmatics) — hardest of the four
- Base `https://fim.api.us.fleetmatics.com`; `GET /token` with
  `Authorization: Basic base64(user:pass)` → bearer valid **20 minutes**.
  <https://fim.us.fleetmatics.com/content/home/support/guides/DeveloperQuickStartGuide.htm>
- **Two credential sets, one with a human loop per customer:** you register on the Fleetmatics
  Integration Manager portal; the *customer* separately requests "Reveal REST Integration
  credentials" from Reveal Customer Care and Verizon emails them. A per-onboarding human step.
- Coverage: vehicles, drivers, GPS history, trips, driver status & safety, **HOS logbooks**,
  places/geofences, work orders, fleet inspections, dashcam events.
  <https://reveal-help.verizonconnect.com/hc/en-us/sections/5491620930451-API-integrations>
- **No real sandbox** — the Test Client calls the customer's production account.
- Rate limits / fees **UNVERIFIED**.

### The rest
- **Omnitracs / Solera** — APIs exist (Roadnet Web Services, SOAP Event Subscription) but no open
  self-service portal; partner- and account-gated.
  <https://www.solera.com/solutions/fleet-solutions/omnitracs/>
- **ISAAC Instruments** — "Open Platform" behind a partner application form; docs not public;
  Quebec/Canada long-haul heavy, thin in LA.
  <https://www.isaacinstruments.com/platform/seamless-integration/open-platform/join-isaac-become-a-partner/>
- **Platform Science** — enterprise-only (Walmart/Schneider scale).
  <https://www.platformscience.com/for-developers>
- **Budget ELDs common in small LA fleets** — Matrack (~$19.95–24.95/truck/mo), HOS247 (~$19/mo +
  $3 GPS), TruckX ($19.95/$24.95), ELD Mandate, Switchboard, Gorilla Safety, Blue Ink Tech.
  <https://matrackinc.com/eld-devices-for-small-fleets/> ·
  <https://hos247.com/resources/eld-reviews/best-eld-for-small-fleets/> · <https://truckx.com/>
  **None publish developer API docs.** TruckX advertises integrations with Highway and Terminal,
  implying a private API. **Their API terms/pricing UNVERIFIED.**

### Aggregators ("unified telematics API")
- **Terminal** <https://www.withterminal.com/> — the category leader ("Plaid for trucking
  telematics"), YC S23, $20M Series A led by Battery Ventures ($26M total,
  <https://www.prnewswire.com/news-releases/terminal-raises-20-million-to-scale-market-leading-telematics-integration-technology-for-fortune-500-companies-across-insurance-fleet-management-and-logistics-302837250.html>),
  **290+ integrations**. Sandbox `https://api.sandbox.withterminal.com/tsp/v1`; hosted consent
  widget "Terminal Link"; `POST /public-token/exchange` → `Connection-Token` header.
  <https://docs.withterminal.com/guides/quickstart.md>. Models include **HOSLog,
  HOSAvailableTime, HOSDailyLog, IFTASummary**, Trip, VehicleStatLog, SafetyEvent, FaultCodeEvent.
  Rate limits 100 rps/connection, 400 rps/app, 20 rps/IP.
  <https://docs.withterminal.com/api-reference/rate-limits.md>
  **Pricing is NOT published — no self-serve signup, no free tier, only a discovery call.
  Assume enterprise-priced; UNVERIFIED. Non-starter at <$100/mo until there's revenue.**
- **TruckerCloud** <https://www.truckercloud.com/> (docs <https://docs.truckercloud.com>) —
  175+ integrations but positioned at commercial-auto insurance. No published pricing.
- **Axle** — commercial-auto underwriting focus; no public docs or pricing. **UNVERIFIED.**
- **Smartcar** <https://smartcar.com/pricing> — **wrong product**: OEM connected passenger cars,
  no HOS/DVIR, no Class 8. Listed only to rule out.
- FleetRabbit / OxMaint aggregator claims come from their own marketing pages, not developer
  docs — **UNVERIFIED, treat as marketing.**

**ELD recommendation:** **Motive + Samsara direct first** (both self-serve, well documented, and
together dominate small-fleet LA), **Geotab third**, revisit Terminal only when long-tail ELD
demand justifies a sales call.

---

## 13. Legal / terms-of-use constraints

### 13.1 Is FMCSA public data free to reuse commercially? **Yes — with two real traps.**
- **17 U.S.C. §105**: federal-employee works get no domestic copyright. GSA's federal guidance:
  *"Data and content created by government employees within the scope of their employment are
  not subject to domestic copyright protection… Government works are by default in the U.S.
  Public Domain."* <https://resources.data.gov/open-licenses/>
- **OPEN Government Data Act**: agencies must apply open licenses such that *"there are no
  restrictions on copying, publishing, distributing, transmitting, adapting, or otherwise using
  the information **for any purpose, commercial or non-commercial**."* (same page)
- **No explicit dataset-level license is asserted.** data.gov's SAFER record and every FMCSA
  Socrata dataset list `license: https://project-open-data.cio.gov/unknown-license/` —
  <https://catalog.data.gov/dataset/safety-and-fitness-electronic-records-safer>. Read it as
  public domain by operation of §105, not by affirmative grant. Ambiguity contact:
  `FMCSA.CDO@dot.gov`.
- **FMCSA frames the program as commercially usable**: the Open Data Program page states the
  goal is to *"create opportunities for economic development."*
  <https://www.fmcsa.dot.gov/registration/fmcsa-data-dissemination-program>

#### ★ TRAP 1 — CVSA owns the inspection terminology
FMCSA's Copyright/Attribution Notice
(<https://www.fmcsa.dot.gov/mission/copyrightattribution-notice>) warns that FMCSA sites contain
**CVSA North American Standard Inspection Program terminology that is CVSA intellectual property
licensed to FMCSA**, and that non-licensees seeking to download or copy, **for commercial
purposes**, portions of FMCSA public websites containing that terminology should seek
authorization from CVSA in advance.
**VERIFIED VERBATIM 2026-09-14** (read through a real browser; the page 403s automated fetchers):
> *"FMCSA public web sites may contain terminology from the Commercial Vehicle Safety Alliance
> (CVSA) North American Standard Inspection Program (https://www.cvsa.org/inspections/inspections/).
> Such terminology is CVSA intellectual property licensed to FMCSA. Non-licensees seeking to
> download or copy, for commercial purposes, portions of FMCSA public web sites containing this
> protected CVSA terminology should seek authorization from CVSA in advance."*
> (page last updated 2019-09-05)

→ **This is the one genuine IP exposure in the whole FMCSA stack.** The exposure is narrower than
it first reads: `section_desc` values in the SMS Violation file are largely FMCSR section
paraphrases, not CVSA text. The CVSA-owned material is the **North American Standard Inspection
Program** vocabulary — inspection *level* names and definitions, and the **out-of-service
criteria** language. Safe posture: store `viol_code` / `insp_level_id` as codes, render your own
plain-English labels, and do not reproduce CVSA OOS-criteria text. Note also that the notice
speaks to copying *from FMCSA web sites* — the Socrata bulk datasets are a separate channel, but
don't lean on that distinction.

#### ★ TRAP 2 — PSP data may not be stored, combined, or linked
See §13.4.

### 13.2 QCMobile / SAFER / Socrata terms
- **QCMobile**: no terms-of-service, acceptable-use, rate-limit, caching, or redistribution
  document exists anywhere on the developer site. I fetched `/QCDevsite/`, `/docs/apiAccess`,
  `/docs/getStarted` and `/logingovInfo` and grepped for terms/license/disclaimer/warranty/
  endorse — only the DOT footer boilerplate, and the one "terms and conditions" link is
  `href="#"`. The registration form's **commercial/non-commercial/academic** application-type
  field is the strongest available signal that commercial use is contemplated.
  → **No contractual bar on caching — but also no written permission. Treat "no published ToS"
  as risk, not as a grant.** **UNVERIFIED** whether a click-through appears inside the
  authenticated webKey-request flow.
- **SAFER**: <https://safer.fmcsa.dot.gov/about.aspx> and `/saferhelp.aspx` contain **no terms of
  use, no accuracy disclaimer, and no commercial-use or redistribution restriction.** "Ad-hoc
  query (one carrier at a time)" is a design description, not a stated prohibition — but heavy
  automated querying of a legacy IIS app invites IP blocking. **Prefer bulk + QCMobile.**
- **data.transportation.gov** footer links only to the Socrata/Tyler platform ToS and the DOT
  privacy policy; **no dataset-level license text**. **UNVERIFIED: whether the Socrata platform
  ToS imposes any reuse or rate condition on downstream consumers.** Mitigate by using an app
  token and bulk downloads for volume.

### 13.3 DOT / FMCSA seal and logo — do NOT put it in the product
- **49 CFR Part 3 contains exactly one section, §3.1 "Description."** There is **no** use
  restriction or penalty in Part 3 — anyone citing "49 CFR 3" as the seal-use prohibition is
  wrong.
- The real prohibition is **18 U.S.C. §1017** (wrongful use of a department/agency seal — fine
  and up to **5 years**) —
  <https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title18-section1017> — plus DOT's
  internal seal order
  <https://www.transportation.gov/orders/official-seal-and-signatures-department-transportation>
  (**UNVERIFIED text**, 403s automated fetch).
- FMCSA has already told you contractually: Clearinghouse Rules of Behavior **¶3** forbids any
  statement that a service agent is *"approved or endorsed by FMCSA"*; **¶4** forbids misleading
  statements about federal requirements.
- **Rule: no DOT triskelion, no FMCSA logo, no "FMCSA-approved," no seal-like blue circle.
  Neutral wording only — "helps you meet 49 CFR 382.701 requirements."**

### 13.4 Driver PII in FMCSA data
- **MCMIS publishes two file sets — one with PII (restricted) and one without (public).** Driver
  information is **not** in public inspection files. MCMIS Privacy Impact Assessment:
  <https://www.transportation.gov/sites/dot.gov/files/docs/resources/individuals/privacy/Privacy%20-%20FMCSA%20-%20MCMIS%20-%20PIA%20-%20032017.pdf>
  SORN **DOT/FMCSA 001**, 78 FR (2013-09-25) —
  <https://www.federalregister.gov/documents/2013/09/25/2013-23131/>
- Driver-level inspection/crash history lives in the **Driver Information Resource (DIR)**,
  restricted to FMCSA staff, contractors and MCSAP state agencies — and reaches industry **only**
  through **PSP**, with driver consent. PSP PIA:
  <https://www.transportation.gov/sites/dot.gov/files/2021-03/Privacy%20-%20FMCSA%20-%20PSP%20-%20PIA%20-%20032621.pdf>

#### ★ PSP Industry Service Provider Agreement — the most restrictive contract in this space
<https://www.psp.fmcsa.dot.gov/PspApi/documents/ISPAccountHolderAgreement.pdf> (verbatim):
> *"Industry Service Provider shall use each PSP record **only once, for one purpose**, and shall
> thereafter not supply the PSP record to more than one Industry Service Provider customer, nor
> supply a PSP record more than one time to any Industry Service Provider customer."*
> *"Industry Service Provider shall **not create or update any file with PSP information**
> provided to develop an internal data storage mechanism, **nor store, combine and/or link the
> information with any other information for any reason**."*

Also: no direct mail/email solicitation, advertising or surveys; no compiling or publishing any
portion of the personal information "including on the Internet"; FCRA duties flow down
(standalone FMCSA-mandated disclosure + authorization used **exactly as provided and not
combined with any other document**; furnish a copy of the report; route disputes only to
<https://dataqs.fmcsa.dot.gov>); the ISP is **liable for every action under its usernames
"whether or not such use was authorized."** Governing law: Kansas.
Pricing: **ISP subscription $100/yr, $10 per search** (null results billed). Motor-carrier
accounts: **$100/yr at 100+ power units, $25/yr at ≤99**, $10/search —
<https://www.psp.fmcsa.dot.gov/PspApi/Documents/PSPMotorCarrierEnrollment.pdf>

> **Consequence: a FleetView feature that caches PSP reports into a driver-qualification file, or
> joins PSP data to anything else, breaches the agreement outright. PSP must be
> pass-through-and-forget, or sourced through a vendor who holds the ISP relationship.**

### 13.5 DPPA — 18 U.S.C. §§2721–2725 (MVR pulling)
<https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title18-section2721>
- §2721(a) bars state DMVs from disclosing personal information from motor vehicle records except
  under an enumerated permissible use.
- **§2721(b)(9) is the use case, verbatim:** *"For use by an employer or its agent or insurer to
  obtain or verify information relating to a holder of a commercial driver's license that is
  required under chapter 313 of title 49."* Also relevant: (b)(1) government functions, (b)(2)
  motor vehicle/driver safety, (b)(3) legitimate business verification, (b)(6) insurance,
  (b)(13) written consent.
- **§2721(c) — resale/redisclosure**: an authorized recipient may redisclose only for a §(b)
  permissible use, and **must keep records for 5 years** identifying each recipient and the
  intended purpose, available to the DMV on request. **A SaaS that passes MVR content to
  employers is squarely in §2721(c) and must keep that 5-year log.**
- **§2724 creates a private right of action with liquidated damages of $2,500 minimum per
  violation** — DPPA class actions against data intermediaries are routine. This is the real
  litigation risk.

### 13.6 California DMV specifics
- **CVC §1808.21** — a residence address in a DMV record is **confidential**; disclosure limited
  to courts, law enforcement, other government agencies, or as allowed by §§1808.22/1808.23.
  <https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=VEH&sectionNum=1808.21>
- **CVC §1808.22** — the exceptions: licensed financial institutions (written waiver), licensed
  insurers (under penalty of perjury), attorneys in matters directly involving the vehicle,
  authorized insurer contractors. Contractors **must destroy the information once used, may not
  sell it, and may not store, combine, or link it**; must carry a **$50,000 surety bond**; civil
  penalties **up to $100,000** and requester-code suspension/revocation.
  **Note: §1808.22 contains no general employer exception** — employers come in through EPN.
  <https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=VEH&sectionNum=1808.22>
- **Employer Pull Notice (EPN) — CVC §1808.1** —
  <https://www.dmv.ca.gov/portal/vehicle-industry-services/motor-carrier-services-mcs/employer-pull-notice-epn-program/>
  - **Mandatory** for employers of Class A/B drivers, Class C with endorsements, charter-party
    carrier drivers (≤10 passengers), PUC-certificated passenger stage drivers — **including
    owner-operators with partners or family members, and anyone driving 30+ days in six months.**
  - **Fee: $5 per enrolled driver** on a Commercial EPN account (DMV form INF 1102 instructions,
    <https://www.dmv.ca.gov/portal/uploads/2020/04/inf1102.pdf>). Ad-hoc record request via
    INF 1119 is also **$5**.
  - Forms: **INF 1104** (account application), **INF 1100** (enroll/delete CA licensees),
    **INF 1102** (out-of-state licensees), **INF 1101** (voluntary enrollee authorization),
    **INF 1107** (program requirements), **INF 4** (account changes), **INF 2110** (agent
    authorization).
  - Output: **Driver Record Report (DL 414)** mailed within 10 business days of enrollment, then
    **on any action/activity and annually** on the enrollment anniversary.
  - Employer duties: delete drivers immediately on termination; *"DMV information may not be
    shared, and must be used in accordance with California Vehicle Code §1808.1"*; destroy
    records containing personal information when no longer needed (Civil Code §§1798.80–.82).
- **Commercial Requester Account (CRA) — CVC §1810.2** —
  <https://www.dmv.ca.gov/portal/vehicle-industry-services/motor-carrier-services-mcs/motor-carrier-services-mcs-records-and-information/commercial-requester-accounts-cra/>
  Forms INF 1106 / INF 1128 / INF 1230. **$50 standard; $250 for confidential residence-address
  access, which also requires a $50,000 surety bond.** Renewal every **2 years**.
  **Redistribution bar, quoted from DMV:** accounts *"cannot… sell, retain, distribute, provide,
  or transfer any record information or portion of the record information acquired under this
  agreement, except as authorized by DMV."*
  → **This kills any plan to become a CA MVR reseller without express DMV authorization.**
- **RECENT CHANGE: effective 2026-04-01, 13 CCR §350.47 requires all commercial requester — and
  EPN — submissions to be conducted electronically.** Cited on both DMV pages above.
  **Confirm the exact scope in 13 CCR before relying on it.**

**Realistic California path for a solo founder: do NOT open your own CRA. Enroll the carrier in
EPN under the carrier's own account and build the tracking layer, and/or integrate a vendor.**

### 13.7 Vendor / reseller path for MVRs
| Vendor | API | Notes |
|---|---|---|
| **SambaSafety** | **Yes — public developer portal** <https://developer.sambasafety.com/> (Postman: <https://www.postman.com/sambaengineering/sambasafety-api-s/collection/gp0q3ul/sambasafety-rest-api>) | People, Licenses, Enrollments, MVRs, License Validation/Search, Activity Detail/History, Webhooks. Demo/sandbox exists. Credentials provisioned via a CSM — partner-gated, not self-serve. Best fit for continuous MVR monitoring |
| **Checkr** | **Yes** <https://docs.checkr.com/> | Operates as a CRA; MVR + **continuous MVR monitoring** via API (<https://help.checkr.com/s/article/25943386361367-Continuous-motor-vehicle-record-MVR-reports-US-only>); order → webhook callback |
| **HireRight** | **Yes — HireRight Connect API** <https://www.hireright.com/services/hireright-connect-api> | 70+ integrations incl. Tenstreet and SambaSafety. Catalog includes DOT MVR, CDLIS, DOT employment verification, and **Clearinghouse Full Pre-Employment Query** as a purchasable service |
| **Tenstreet** | Yes (partner API) <https://www.tenstreet.com/integrations> | Orders CDLIS, MVR, D&A, PSP; **in-house Clearinghouse team runs limited and full queries**; SambaSafety integration pushes MVRs into DQ files. **FleetView's most direct incumbent** |
| **Foley** | **UNVERIFIED** — API not publicly documented | Registered **C/TPA**; "Dash" bundles Clearinghouse management, MVR monitoring, DQ files, drug testing. <https://www.foley.io/compliance/clearinghouse> |
| **DISA** | **UNVERIFIED** — API not publicly documented | Single-source C/TPA + screening |

**How the reseller model works:** the vendor holds the state DMV agreements (or a CRA/requester
code per state), holds the PSP ISP account, is itself the **CRA/reseller** under FCRA
§1681a(u), and exposes an ordering API. You send an identified driver plus a certification of
permissible purpose; they return a report. **You never touch the DMV — and you inherit, not
escape, the FCRA/DPPA duties that flow down by contract.**

### 13.8 FCRA — is FleetView a consumer reporting agency?
- **CRA definition, 15 U.S.C. §1681a(f)**: anyone who, for fees, **regularly** assembles or
  evaluates consumer information **for the purpose of furnishing consumer reports to third
  parties**. <https://www.law.cornell.edu/uscode/text/15/1681a>
  **Reseller, §1681a(u)**: a CRA that assembles/merges another CRA's data for a third party.
  Both are CRAs.
- Where the line falls:
  - **Pure pass-through display** of a report the employer ordered from Checkr/Samba, with
    FleetView as the employer's agent/processor, not assembling or evaluating → **most likely not
    a CRA**. Fact question, not a bright line.
  - **Assembling or scoring** — merging MVR + PSP + Clearinghouse status into a FleetView "driver
    risk score" or "fitness rating" furnished to the carrier → **very likely makes FleetView a
    CRA**, triggering §1681e(b) maximum-possible-accuracy duties, §1681i dispute/reinvestigation
    duties, §1681k public-record notice, adverse-action plumbing, and state licensing/bonding.
  - **CFPB Circular 2024-06** treats background dossiers and **algorithmic scores** used for
    hiring/promotion decisions as squarely within FCRA —
    <https://www.consumerfinance.gov/compliance/circulars/consumer-financial-protection-circular-2024-06-background-dossiers-and-algorithmic-scores-for-hiring-promotion-and-other-employment-decisions/>

> **★ This is the single biggest product-design constraint in this report: shipping a computed
> driver risk score is the step that converts FleetView from software into a regulated CRA.
> Show the underlying facts and the deadlines. Do not ship a score.**

- Employer-side duties worth automating **for your customers** (FTC, *Using Consumer Reports:
  What Employers Need to Know*,
  <https://www.ftc.gov/business-guidance/resources/using-consumer-reports-what-employers-need-know>):
  standalone written disclosure · written authorization · certification to the CRA ·
  **pre-adverse-action** notice with a copy of the report + *A Summary of Your Rights Under the
  FCRA* · post-adverse-action notice naming the CRA with 60-day free-report and dispute rights ·
  secure disposal.

### 13.9 CCPA / CPRA
- CPRA removed the employee/applicant/contractor exemption — **driver data you hold is fully in
  scope**, including HR-context data. Applies subject to the CCPA business thresholds.
- **Service provider contracts** must bar use outside the contract, bar selling/sharing, require
  deletion on instruction, require subcontractor flow-down and reasonable security, and support
  access/correction/deletion rights.
- **New regulations approved by OAL 2025-09-22, effective 2026-01-01** (ADMT, risk assessments,
  cybersecurity audits, insurance) — <https://cppa.ca.gov/regulations/ccpa_updates.html>.
  Phase-in: **ADMT obligations 2027-01-01**; existing activities risk-assessed by **2027-12-31**
  with first CPPA submissions by **2028-04-01**; cybersecurity audit certifications begin
  **2028-04-01** for businesses >$100M revenue, smaller firms phased through 2030.
  A solo founder is well below the audit thresholds near-term — **but if FleetView ever automates
  a "do not dispatch this driver" decision, that is ADMT for a significant employment decision
  and pulls in pre-use notice, opt-out, and human appeal.**
- California data-destruction duty already cited on DMV's own EPN forms: **Civil Code
  §§1798.80–1798.82**.

### 13.10 What I verified myself on FMCSA sources
- **No FMCSA API terms-of-service document exists.** The QCMobile Login.gov page shows *"you
  agree to our terms and conditions"* with `href="#"` — a dead link. The only binding text
  presented at any FMCSA data endpoint is the standard **US Government information system**
  warning banner (authorized use only; monitoring consent). Verified 2026-09-14 on
  <https://mobile.fmcsa.dot.gov/QCDevsite/logingovInfo> and
  <https://li-public.fmcsa.dot.gov/>.
- **Socrata dataset license metadata** on every FMCSA dataset reads
  `License: https://project-open-data.cio.gov/unknown-license/` with
  `Public Access Level: public` — i.e. **no explicit license asserted**, which for a US
  Government work is the default public-domain position (17 U.S.C. §105).
- **FMCSA explicitly frames the program as commercially usable**: *"The goal of this open data
  program is to increase citizen participation in government, **create opportunities for
  economic development**, and inform decision making in both the private and public sectors."*
  <https://www.fmcsa.dot.gov/registration/fmcsa-data-dissemination-program>
- **Driver PII is already stripped** from public inspection files: *"Due to privacy restrictions
  driver information is not included in any inspection files released to the public."*
  (dataset `fx4q-ay7w` description).
- **robots.txt reality check** (all verified 2026-09-14):
  - `safer.fmcsa.dot.gov/robots.txt` → **404** (no restrictions declared)
  - `ai.fmcsa.dot.gov/robots.txt` → **`User-agent: * / Crawl-delay: 60`** ← honor this
  - `data.transportation.gov/robots.txt` → `Crawl-delay: 1`, `/resource/` unrestricted
  - `li-public.fmcsa.dot.gov/robots.txt` → 404, but the app is **reCAPTCHA-protected**
- **Do not use the DOT/FMCSA seal or logo** in the product. No permission is granted anywhere,
  and implying federal endorsement is the classic failure mode for products in this space.
  (Specific seal-use regulation: **UNVERIFIED** — not run down here.)

---

## 14. RECOMMENDATION — minimum viable integration for a solo founder under $100/month

### 14.1 The punchline
**Your entire v1 data layer costs $0/month and needs no API key, no contract, and no approval.**
Everything that actually matters at signup comes from **three free, unauthenticated HTTP sources**.
Spend the budget on hosting, not on data.

### 14.2 Integrate these three, in this order

#### ① FMCSA Socrata open data — `data.transportation.gov` · **$0 · no auth · day one**
This is the backbone. One parallel fan-out on the USDOT number fills nearly the whole signup form.

**I benchmarked the real thing: 7 parallel dataset queries for one DOT number completed in
0.55 seconds** (unauthenticated, from a laptop). This is fast enough to run synchronously during
signup — no job queue needed for v1.

Concrete steps:
1. Nothing to sign up for. Start querying:
   `https://data.transportation.gov/resource/az4n-8mr2.json?dot_number={DOT}`
2. **Get a free Socrata app token** to escape IP throttling: create an account at
   <https://data.transportation.gov/signup>, then **Profile → Developer Settings**
   (`https://data.transportation.gov/profile/edit/developer_settings`). Send it as the
   `X-App-Token` header. Socrata: *"we do not throttle API requests that are using an application
   token."* <https://dev.socrata.com/docs/app-tokens.html>
3. Datasets to wire, in priority order:
   - **`az4n-8mr2`** Company Census — identity, address, contacts, fleet counts, cargo, safety
     rating, `mcs150_date`, dockets *(daily)*
   - **`inys-ebih`** Motus Carrier **UNION** **`6eyk-hxee`** legacy Carrier — authority status and
     the insurance-required-vs-on-file check *(see §3d gotcha 1: Motus alone misses ~90%)*
   - **`c5y8-a4uz`** + **`3uet-3z4i`** Motus Insur / InsHist **UNION** legacy `ypjt-5ydn` —
     policies, insurer, limits, cancellation dates *(daily)*
   - **`fx4q-ay7w`** Vehicle Inspections + **`aayw-vxb3`** Crashes *(daily, ~3-day lag)*
   - **`8mt8-2mdr`** SMS Violations — BASIC, severity and time weights *(monthly)*
   - **`p2mt-9ige`** Out-of-Service Orders *(daily)*
4. **Read §3d before writing a line of code.** The three gotchas there (Motus coverage, legacy
   zero-padding, `docket*_status_code` lying about authority) will each cost you a day and,
   worse, produce confidently wrong answers for customers.

#### ② CHP Carrier Inspection Results — `carriersafety.chp.ca.gov` · **$0 · no auth · day one**
The California half of signup, from the same USDOT number: **CA#/MCP#, MCP Active/Inactive, and
the full BIT terminal inspection history.** AB 529 requires CHP to publish it, so it's stable.
Implementation is a two-step token dance — see **§9.1**, including the `Parameters.UserIPAddress`
trap that silently returns zero records. Cache aggressively; keep volume low.

#### ③ CARB TRUCRS bulk CSV — **$0 · no auth · one nightly cron**
`https://www.arb.ca.gov/carbapps/onrdiesel/compliantfleetlookup.csv` — 3 MB, hourly-fresh, and the
`Carrier Type` column is literally `USDOT Number`, so it joins straight onto your carrier table.
Pull it nightly into a local table. **Render absence as "no certificate on file," never as
"non-compliant" (§9.4).**

### 14.3 Explicitly DEFER these
- **QCMobile API** — free and easy, but every field it returns you already have from Socrata, with
  worse freshness and an undocumented rate limit. Get a webKey anyway (it's free, 10 minutes,
  §1) and keep it as a **fallback/cross-check**, not a dependency.
- **SaferWebAPI ($30/mo)** — the only paid source worth considering, and only as insurance against
  SAFER/QCMobile flakiness. It resells the same free data. **Skip it until something breaks.**
- **ELD integrations** — real work, and not needed to onboard anyone. When you do: **Motive
  first** (self-serve API key, test mode, best webhooks), Samsara second. §12.
- **Motus TSP registration** — do it when you're ready to *file* on customers' behalf, not to
  *read* data. Reading needs nothing. §7.
- **DMV Commercial Requester Account ($50 + $50/2yr)** — only when registration expiry and SB 210
  holds become a headline feature. §9.5.
- **Everything broker-facing** (RMIS, MyCarrierPortal, Carrier411, DAT) — wrong buyer, 5–17× over
  budget. §11.

### 14.4 The three highest-leverage features that need NO integration at all
1. **MCS-150 biennial deadline** — computed purely from the USDOT number (month = last digit,
   odd/even year = next-to-last digit; §7). Compare to `mcs150_date` from the census. Penalty
   includes **USDOT deactivation**, and FMCSA does *not* reliably flip carriers to INACTIVE — so
   owners genuinely don't know. Best signup "wow" moment in the product.
2. **Clean Truck Check deadlines** — computed from the VIN's last digit or the DMV registration
   month (§9.4). Twice a year, per truck, with a live DMV registration hold behind it.
3. **Clearinghouse annual query clocks** — rolling 365 days per driver, **not** the January 31
   date every competitor's blog repeats (§8.2). Plus the 24-hour full-query escalation timer.

### 14.5 Three product traps that will embarrass you
- Calling BIT **"biennial."** It hasn't been since AB 529 — it's performance-based selection (§9.2).
- **Nagging an interstate carrier to renew their MCP.** Interstate MCPs are non-expiring and free
  to maintain (§9.3).
- Flagging a truck **non-compliant** when it's running on a valid CARB Five-Day Pass — the public
  lookup structurally cannot see passes (§9.4).

### 14.6 One legal line you must not cross
**Do not ship a computed driver risk score.** Merging MVR + PSP + Clearinghouse status into a
FleetView "driver rating" furnished to the carrier is very likely to make you a **consumer
reporting agency** under 15 U.S.C. §1681a(f), with CFPB Circular 2024-06 squarely on point
(§13.8). Show the underlying facts and the deadlines; let the human decide. Also: **never store,
combine, or link PSP data** (§13.4), and **never hold a customer's Clearinghouse credentials**
(§8.6).

---

## 15. FIELD → SOURCE MAP

**A = fully automated** from the USDOT number alone ·
**A\*** = automated once the owner supplies one extra key (VIN list, plate, ELD connection) ·
**M = manual entry** · **C = computed, no fetch needed**

### Carrier identity & registration
| Field the product wants | Best source | Auth | A/M |
|---|---|---|---|
| Legal name, DBA | Census `az4n-8mr2.legal_name/dba_name` | none | **A** |
| Physical + mailing address | Census `phy_*` / `carrier_mailing_*` | none | **A** |
| Phone, email, company officers | Census `phone`, `email_address`, `company_officer_1/2` | none | **A** |
| Entity type / business org | Census `business_org_desc` | none | **A** |
| USDOT status (A/I/P) | Census `status_code`; cross-check SAFER "USDOT Status" | none | **A** |
| DUNS number | Census `dun_bradstreet_no` | none | **A** |
| Interstate vs intrastate | Census `carrier_operation` (A/B/C) | none | **A** |
| For-hire vs private | Census `classdef` | none | **A** |
| Cargo carried (29 flags) | Census `crgo_*` | none | **A** |
| Hazmat indicator | Census `hm_ind` | none | **A** |
| **MCS-150 last filed** | Census `mcs150_date` | none | **A** |
| **MCS-150 next due date** | **USDOT number + 49 CFR 390.19T** | — | **C** |
| Annual mileage (VMT) | Census `mcs150_mileage` + `mcs150_mileage_year` | none | **A** |
| **File the MCS-150 update** | **Motus, as a designated TSP** (carrier must certify) | Login.gov + IDEMIA ID proofing + carrier designation | **M** (assisted) |

### Operating authority & insurance
| Field | Best source | Auth | A/M |
|---|---|---|---|
| MC/FF/MX docket numbers | Census `docket1/2/3` + prefix | none | **A** |
| **Operating authority status** | Motus `inys-ebih.op_auth_status` ∪ legacy `6eyk-hxee.common_stat/contract_stat` | none | **A** |
| ⚠️ *Not* authority status | ~~Census `docket*_status_code`~~ — **unreliable, see §3d(3)** | — | — |
| Authority type(s) | `inys-ebih.op_auth_type` | none | **A** |
| Insurance **required** amount | `inys-ebih.min_cov_amount`, `cargo_req`, `bond_req` | none | **A** |
| Insurance **on file** amount | `inys-ebih.bipd_file`, `cargo_file`, `bond_file` | none | **A** |
| Insurer, policy #, effective date | Motus `c5y8-a4uz` ∪ legacy `ypjt-5ydn` | none | **A** |
| Insurance cancellation date | Motus InsHist `3uet-3z4i.cancl_effective_date` | none | **A** |
| BOC-3 process agent | Motus `6snj-ed7q` ∪ legacy `2emp-mxtb` | none | **A** |
| Revocation / suspension + reason | Motus `wb4f-neki` | none | **A** |
| Undeliverable-mail flag (early warning) | `inys-ebih.bus_undeliverable_mail` | none | **A** |
| Authority history | Motus `yu5v-wbh6` ∪ legacy `9mw4-x3tu` | none | **A** |

### Safety
| Field | Best source | Auth | A/M |
|---|---|---|---|
| Safety rating + date | Census `safety_rating`, `safety_rating_date` | none | **A** |
| Last review type + date | Census `review_type`, `review_date` | none | **A** |
| Inspections (per-inspection detail) | `fx4q-ay7w` *(daily, ~3-day lag)* | none | **A** |
| Violations w/ BASIC + severity weights | `8mt8-2mdr` *(monthly)* | none | **A** |
| Crashes (fatal/injury/tow) | `aayw-vxb3` *(daily)* | none | **A** |
| OOS rates vs national average | SAFER snapshot HTML | none | **A** (scrape, cache) |
| BASIC measures, **public BASICs only** | `4y6x-dmck` / SMS carrier page | none | **A** |
| **BASIC percentiles (property carriers)** | **NOT PUBLIC — FAST Act.** Carrier's own FMCSA Portal login | carrier login | **M** |
| ISS value | FMCSA Portal | carrier login | **M** |
| New Entrant OOS order | `p2mt-9ige` | none | **A** |
| Enforcement cases | SMS carrier page *(6-yr window)* | none | **A** (scrape) |
| Full Company Safety Profile | `safer.fmcsa.dot.gov/CSP_Order.asp` | — | **M** ($20, 72 h email) |

### Drivers (§8, §13)
| Field | Best source | Auth | A/M |
|---|---|---|---|
| Driver names/CDL on inspections | **Not in public data** — FMCSA strips driver PII | — | **M** |
| Clearinghouse query results | Clearinghouse portal — **no API** | carrier's own login (never yours) | **M** |
| Clearinghouse annual-query clock | **Computed: rolling 365 days per driver** | — | **C** |
| Limited-query consent (3-yr retention) | **Your own product** — the real wedge | — | **A** (you own it) |
| Query purchase | Employer's own Clearinghouse account — **C/TPAs may not buy** | — | **M** ($1.25/query) |
| MVR | Vendor (SambaSafety / Checkr / HireRight) — never direct DMV | vendor API + permissible-purpose cert | **A\*** |
| CA Employer Pull Notice | CA DMV EPN, carrier's own account | INF 1104/1100 | **M** ($5/driver) |
| PSP report | `psp.fmcsa.dot.gov` | ISP agreement | **A\*** — ⚠️ **never cache, combine, or link** |

### Vehicles & California
| Field | Best source | Auth | A/M |
|---|---|---|---|
| Power units / trucks / tractors / trailers | Census `power_units`, `owntruck/owntract/owntrail`, `trm*`, `trp*` | none | **A** |
| Driver counts (total, CDL, interstate) | Census `total_drivers`, `total_cdl`, `driver_inter_total` | none | **A** |
| **VIN list** | **No federal or CA source maps DOT → VINs** | — | **M** or **A\*** via ELD |
| **CA# / MCP #** | **CHP `carriersafety.chp.ca.gov`, keyed by USDOT** | none | **A** |
| **MCP Active/Inactive** | Same CHP endpoint, `Status` column | none | **A** |
| **BIT terminal ratings + history** | Same CHP endpoint, row expander | none | **A** |
| MCP renewal due | **Intrastate: annual. Interstate: non-expiring** | — | **C** |
| TRUCRS / Truck & Bus / ACF certificate | **CARB `compliantfleetlookup.csv`**, join on USDOT | none | **A** |
| Clean Truck Check status | `cleantruckcheck.arb.ca.gov/...?VIN=` | none | **A\*** (needs VIN) |
| **Clean Truck Check deadlines** | **VIN last digit, or DMV reg month** | — | **C** |
| CA registration expiry / SB 210 hold | DMV Commercial Requester Account | INF 1106, $50 + $2/record | **A\*** |
| CVRA weight decal | Carrier's REG 4008 declared weight | — | **M** |

### Filings & taxes
| Field | Best source | Auth | A/M |
|---|---|---|---|
| **UCR fee owed** | **49 CFR §367.50 bracket × power units** *(2027 rates, §10.3)* | — | **C** |
| UCR registration status | `ucr.gov` — **reCAPTCHA-gated** | — | **M** |
| **IFTA quarterly deadlines** | **Apr 30 / Jul 31 / Oct 31 / Jan 31** | — | **C** |
| IFTA license/decal renewal window | **Dec 1 opens; Feb-end grace** | — | **C** |
| IFTA license status | **No public lookup anywhere** | — | **M** |
| IFTA miles-by-jurisdiction | **ELD/telematics** (Motive `IFTA` scope; Terminal `IFTASummary`) | ELD OAuth/API key | **A\*** |
| IRP renewal date | Fleet's staggered expiration month | — | **M** then **C** |
| IRP status | **No public lookup** | — | **M** |
| HVUT 2290 proof | Carrier's own IRS filing | — | **M** |

### Operations (ELD, §12)
| Field | Best source | Auth | A/M |
|---|---|---|---|
| HOS logs / violations | Motive `v1/hos_violations`, Samsara `/fleet/hos/logs`, Geotab `DutyStatusLog` | customer-issued API key or OAuth | **A\*** |
| Trips | Samsara `/trips/stream`, Geotab `Trip` | same | **A\*** |
| Odometer / engine hours | Samsara `/fleet/vehicles/stats/history`, Geotab `StatusData` | same | **A\*** |
| DVIR | Motive inspection reports, Samsara `/fleet/dvirs/history` | same | **A\*** |
| Fault codes | Motive fault codes, Geotab `FaultData` | same | **A\*** |

---

## 16. UNVERIFIED — chase these before shipping
1. **QCMobile rate limits / quotas.** Nothing published anywhere. Also whether a click-through ToS
   appears inside the authenticated webKey-request flow.
2. **Whether any public Motus API is planned.** An internal `/api/` namespace exists on
   `motus.dot.gov`; no docs, no keys, no contract.
3. **Socrata/Tyler platform ToS** conditions on downstream API consumers of
   `data.transportation.gov`.
4. **CARB ACF repeal — OAL decision.** Window closed 2026-09-11; outcome not yet posted at
   <https://ww2.arb.ca.gov/rulemaking/2025/acfab1594>. **Re-check before launch.**
5. **CA MCP fee chart currency** — newest chart found is effective 2016-01-01.
6. **Whether CHP's `Status` column is strictly the DMV MCP status** or a CHP carrier-record status.
7. **Automated-access terms / rate limits** for `carriersafety.chp.ca.gov` and
   `cleantruckcheck.arb.ca.gov`. Neither publishes any.
8. **13 CCR §350.47 scope** (CA electronic-submission mandate effective 2026-04-01).
9. **Samsara license-per-endpoint gating** (HOS behind Telematics Essential Plus) and retention
   defaults — `kb.samsara.com` 403s automated fetch. **Verify by hand before promising HOS sync.**
10. **Motive rate limits** — undocumented. **Rev-share/fees** for Samsara, Motive, Geotab.
11. **Verizon Connect** rate limits and fees.
12. **Terminal pricing** (no published tier, no free tier). **Carrier411 pricing** (site 403s).
    **RMIS Lite $340/mo** and **DAT $500–1,000 setup** are third-party claims only.
13. **DOT seal order text** at transportation.gov (403s) — though §13.3's conclusion doesn't
    depend on it.
14. **Exact wording** of FMCSA's "no Clearinghouse integration specifications available" guidance
    (recovered via search index; fmcsa.dot.gov 403s automated fetch).

**Actively debunked — do NOT build to these:**
- A "January 31" Clearinghouse annual-query deadline *(it's rolling 365 days, §8.2)*
- "$6,386" per missed annual query *(current eCFR figure is **$7,155**, §8.8)*
- A "December 2025 Clearinghouse CSV bulk upload" *(still tab-delimited/XLS/XLSX only)*
- "Paper consent no longer satisfies the limited query" *(contradicts §382.703(a))*
- BIT being **"biennial"** *(AB 529 made it performance-based, §9.2)*
