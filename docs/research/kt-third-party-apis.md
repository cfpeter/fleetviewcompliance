# FleetView — Third-Party API Knowledge Transfer

**Source repository:** `fleetview-legacy` (Next.js 16 App Router, React 19, Supabase Postgres)
**Prepared:** 2026-09-14
**Purpose:** everything another application needs to re-implement these integrations without reading the original codebase.

---

## What this document is

FleetView is a compliance-deadline tracker for small California trucking carriers. Its entire value
proposition rests on pulling a carrier's federal record from public FMCSA sources using nothing but a
USDOT number, and then turning that record into deadlines, alerts, and a fleet roster.

Five external systems are involved:

| # | System | Role | Auth | Live? |
|---|--------|------|------|-------|
| 1 | **FMCSA Socrata** (`data.transportation.gov`) | Bulk open data: census, inspections, crashes, authority, insurance filings | None / optional app token | Yes |
| 2 | **FMCSA QCMobile** (`mobile.fmcsa.dot.gov`) | Per-carrier snapshot: safety rating, ISS, out-of-service rates | `webKey` query param | Yes |
| 3 | **Stripe** (`api.stripe.com`) | Subscriptions, per-truck quantity, trials | Bearer secret key | Yes |
| 4 | **Resend** (`api.resend.com`) | Transactional email: verification, digests, alerts | Bearer API key | Yes |
| 5 | **SMS provider** | Deadline alerts by text | — | **Not built** (interface only) |

Plus **Supabase** as the persistence layer, which is not a third-party *API* so much as the database,
but its PostgREST constraints shaped several of the design decisions below and are documented for that reason.

---

## Read this first: the four rules that cost us the most

These are not style preferences. Each one is a bug we shipped and then had to find.

**1. Empty is not an error.** A federal query that returns zero rows means "this carrier has no
inspections" — a fact worth storing and showing. A query that fails means "we don't know." Conflating
them makes the app confidently assert a clean record for a carrier whose data simply failed to load.
Every federal call returns a three-state result (`ROWS` / `EMPTY` / `ERROR`) for this reason.

**2. Zero is a fact, not a blank.** `$0` of liability insurance on file is the single most alarming thing
you can learn about a carrier. Any `value || fallback` idiom in this domain will silently swallow it.

**3. The same USDOT number is formatted differently per dataset.** Some Socrata datasets key on the raw
digits; two of them key on an 8-character zero-padded string. Getting this wrong returns an empty result
set, not an error — so it looks exactly like a carrier with no record.

**4. Socrata truncates at 1000 rows without telling you.** No flag, no warning, no error. A carrier with
1,400 inspections silently becomes a carrier with 1,000. Page explicitly, always.

---

## What is deliberately NOT an API

A re-implementer will waste days looking for these. They do not exist as machine-readable endpoints, and
we verified each one:

| Source | Why there is no API | What we do instead |
|--------|---------------------|--------------------|
| **UCR** (Unified Carrier Registration) | `fux9-ij6p` on Socrata is a *link* to a page, not data. The ucr.gov lookup form returns HTTP 500 to programmatic requests. | Owner self-reports the last registration year; we compute the next deadline. |
| **Liability insurance expiry** | Does not exist in the federal record. BMC-91X filings are *continuous until cancelled* — there is no expiry date to read. | We surface the filing's existence and dollar amount, and flag `$0` / cancelled. |
| **Any driver-level data** | No public FMCSA source exposes drivers. Medical certificates, CDLs, and Clearinghouse queries are all private to the carrier. | Owner enters drivers; we track the intervals. |
| **CA DMV, CDTFA, CARB Clean Truck Check** | No public APIs. | `lib/compliance/portals.ts` holds curated deep links so the owner lands on the right page, plus a comment warning that these URLs move. |
| **eCFR** | An API exists but we do not call it — regulation text is stable and versioned. | `sourceUrl` citations on each rule in `lib/regulations/rules/*.ts` link to the exact CFR section. |

Every URL in `lib/compliance/portals.ts` and every `sourceUrl` in `lib/regulations/` is an **outbound
hyperlink for a human**, not a fetch target. Do not mistake them for integration points.

---

## Contents

1. [FMCSA Socrata open data — data.transportation.gov](#1-fmcsa-socrata-open-data-data-transportation-gov)
2. [FMCSA QCMobile — mobile.fmcsa.dot.gov](#2-fmcsa-qcmobile-mobile-fmcsa-dot-gov)
3. [Stripe — api.stripe.com](#3-stripe-api-stripe-com)
4. [Resend email, and the SMS provider layer](#4-resend-email-and-the-sms-provider-layer)
5. [Supabase, persistence, cron and configuration](#5-supabase-persistence-cron-and-configuration)
6. [Open questions and defects this audit found](#6-open-questions-and-defects-this-audit-found)

---

## 1. FMCSA Socrata open data — data.transportation.gov

How `fleetview-legacy` talks to **data.transportation.gov**. Written for a developer
re-implementing these calls in a different application, from scratch.

Everything below is either quoted from the repo (with `path:line` citations) or was
verified by live HTTP on **2026-09-14** (the portal's own `Date` header on those
responses read `Tue, 15 Sep 2026 05:53 GMT`, i.e. the calls were made just past
midnight UTC). Four live calls were made; samples taken from them are marked
**verified live on 2026-09-14**. Everything else is sourced from code or test fixtures
and is marked as such.

Repo root for all paths: `/Users/bedopapajanian/Work/fleetview-legacy`.

---

### 1. Overview

#### What the API is

data.transportation.gov is a **Socrata** open-data portal. FMCSA publishes its
MCMIS-derived extracts there as "views" (datasets), each identified by a 4-4
character id such as `qh9u-swkp`. Rows are queried with **SoQL**, a SQL-like dialect.

This repo uses **two different Socrata endpoints**, deliberately, and the split is
documented as intentional rather than drift:

| Style | Base URL | Used by |
|---|---|---|
| **SoQL v3 query API** (POST, JSON body) | `https://data.transportation.gov/api/v3/views/{view}/query.json` | `lib/federal/query.ts:44`, `lib/fmcsa-inspections.ts:41` |
| **Legacy SODA v2 resource API** (GET, query string) | `https://data.transportation.gov/resource/{view}.json` | `lib/fmcsa-census.ts:18`, `lib/signup/contacts.ts:31` |

> "These are POSTs carrying SoQL, because the read this needs — one carrier's
> inspections, then a fan-out by inspection id — is awkward as a query string and the
> v3 endpoint takes a real WHERE clause. The census client still uses `/resource`
> because a single filtered scan is all it wants; the two styles are deliberate, not
> drift." — `lib/fmcsa-inspections.ts:22-28`

New work should use the v3 path via `federalQuery()` (`lib/federal/query.ts:78`). The
two `/resource` call sites are older code.

#### Authentication — none, and one trap

**No auth of any kind is sent to data.transportation.gov.** `federalQuery` sends
exactly two headers and no token (`lib/federal/query.ts:92`):

```ts
headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
```

`FMCSA_WEBKEY` is **not** used for Socrata. It belongs to a completely different API —
FMCSA QCMobile at `https://mobile.fmcsa.dot.gov/qc/services` — see `lib/fmcsa.ts:10-12`
and `lib/fmcsa.ts:101-107`, and `.env.example:20-27`:

```
# --- FMCSA QCMobile API ---
# Free key from https://mobile.fmcsa.dot.gov/QCDevsite -> My WebKeys.
FMCSA_WEBKEY=
```

QCMobile appends the key as a **query parameter** `?webKey=...` (`lib/fmcsa.ts:107`),
not a header. It is server-side only; a `NEXT_PUBLIC_` prefix would inline it into the
browser bundle (`lib/fmcsa.ts:11-12`).

**The Socrata app-token trap**, recorded at `docs/ROADMAP.md:813-816`:

> "An app token is optional, but a blank one is fatal. Sending `X-App-Token:` with an
> invalid or empty value returns 403 on every request. If `SOCRATA_APP_TOKEN` is ever
> added, the header must be omitted entirely when the value is unset."

There is no `SOCRATA_APP_TOKEN` in this repo today (grep of `.env.example` finds only
`FMCSA_WEBKEY`).

#### Rate limits and politeness, as reflected in code

No HTTP 429 handling exists anywhere in the repo. The limits the code actually
respects are self-imposed:

- **Six-hour read cache.** `CACHE_SECONDS = 21_600` (`lib/federal/query.ts:53`,
  `lib/fmcsa-inspections.ts:256`, `lib/fmcsa-census.ts:96`). Rationale at
  `lib/federal/query.ts:47-52`: "Every file here is regenerated at most once a day —
  most of them between 13:00 and 13:30 UTC, judging by the `:updated_at` on freshly
  pulled rows. Asking more often costs a free public service bandwidth and returns
  byte-identical bytes." The nightly sweep opts out with `revalidate: 0`
  (`lib/federal/sweep.ts:206`).
- **Timeouts.** 20 s in `federalQuery` (`lib/federal/query.ts:46`); 25 s in
  `fmcsa-inspections.ts:60` and `fmcsa-census.ts:93`; 8 s on the signup path
  (`lib/signup/contacts.ts:89`); 15 s for QCMobile (`lib/fmcsa.ts:112`).
- **Batching instead of per-carrier fan-out.** `lib/federal/sweep.ts:10-21`: 1,000
  carriers × 5 sources as individual calls would be 5,000 requests a night; an `IN`
  list of 200 makes it ~25.
- Portal freshness observed at roughly daily: `docs/FMCSA-PLAN.md:255-257` notes
  `X-SODA2-Truth-Last-Modified` sitting at 08-27 for most files, 08-28 for OOS.

---

### 2. The exact HTTP contract

#### 2.1 v3 query API — the real request

Source of truth: `lib/federal/query.ts:90-100`.

```
POST https://data.transportation.gov/api/v3/views/{view}/query.json
Content-Type: application/json
Accept: application/json
```

Request body, verbatim from `lib/federal/query.ts:93-97`:

```ts
body: JSON.stringify({
  query: soql,
  page: { pageNumber: Math.max(1, opts.page ?? 1), pageSize },
  includeSynthetic: false,
}),
```

So the wire body is exactly:

```json
{
  "query": "SELECT * WHERE dot_number = '00344554'",
  "page": { "pageNumber": 1, "pageSize": 100 },
  "includeSynthetic": false
}
```

`lib/fmcsa-inspections.ts:228-232` sends a byte-identical shape.

The response on success is a **bare JSON array of row objects** — no envelope, no
`meta`. Anything else on a 200 is treated as an error, not as empty
(`lib/federal/query.ts:146-154`).

#### 2.2 The `page` block

**Never omit it.** `lib/federal/query.ts:74-77`:

> "The page block is NEVER omitted. Without it this endpoint applies no limit at all —
> an unbounded query pulled 17,648 rows into a serverless function during testing,
> which is a memory ceiling away from taking the cron down."

Same fact at `docs/ROADMAP.md:799-801` ("~3 MB").

- `pageNumber` is 1-based, clamped to `>= 1` (`lib/federal/query.ts:95`).
- `pageSize` is clamped into `[1, 1000]`: `Math.min(Math.max(1, opts.pageSize ?? 100), MAX_PAGE)`
  where `MAX_PAGE = 1000` (`lib/federal/query.ts:56`, `:83`). Default 100.
- 1,000 is described as "Socrata's own page ceiling for this endpoint"
  (`lib/federal/query.ts:55`, `lib/fmcsa-inspections.ts:51-57`). Tests pin the clamp:
  asking for 999,999 yields 1000; asking for 0 yields 1 (`lib/federal/__tests__/query.test.ts:139-149`).

#### 2.3 Paging and `MAX_PAGES`

Only the nightly sweep pages. Logic at `lib/federal/sweep.ts:372-393`:

```ts
for (let page = 1; page <= MAX_PAGES; page += 1) {
  const result = await federalQuery(spec.view, soql, { pageSize: PAGE_SIZE, page, revalidate: NO_CACHE });
  if (result.kind === 'ERROR') { failed = result.reason; break; }
  if (result.kind === 'EMPTY') break;
  rows.push(...result.rows);
  if (result.rows.length < PAGE_SIZE) break;
  ...
}
```

Constants: `BATCH = 200` carriers per request (`sweep.ts:190`), `PAGE_SIZE = 1000`
(`sweep.ts:193`), `MAX_PAGES = 5` (`sweep.ts:203`), `NO_CACHE = 0` (`sweep.ts:206`).

The rule is **a full page means there are more** — the portal truncates silently and
the response looks identical either way (`sweep.ts:355-371`). Hitting `MAX_PAGES` is
*reported*, not swallowed: the summary gains
`"<source>: N carriers hit the 5-page cap at M rows — the stored history is partial. Reduce the batch size for this source."`
(`sweep.ts:388-391`). An error mid-page abandons the whole batch and writes nothing
(`sweep.ts:395-401`; test at `lib/federal/__tests__/sweep.test.ts:"abandons the batch on an error mid-page"`).

**Paging requires ORDER BY.** `sweep.ts:87-94`: "Paging without ORDER BY is undefined:
the portal is free to return a different slice for page 2 than the one that follows
page 1, so rows can be skipped or repeated." Only `fx4q-ay7w` sets one, on
`inspection_id` (`sweep.ts:175`).

The other clients do **not** page. `lib/fmcsa-inspections.ts` always sends
`pageNumber: 1` and reports `truncated: rows.length >= PAGE_SIZE` (e.g. `:344`).
`lib/fmcsa-census.ts:137` does the same with `$limit=1000`.

#### 2.4 Copy-pasteable curl — two datasets

**(a) `6eyk-hxee`, carrier authority + filings. Note the 8-char zero-padded USDOT.**
*Verified live on 2026-09-14.*

```bash
curl -s -X POST 'https://data.transportation.gov/api/v3/views/6eyk-hxee/query.json' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"query":"SELECT * WHERE dot_number = '"'"'00344554'"'"'","page":{"pageNumber":1,"pageSize":1},"includeSynthetic":false}'
```

**(b) `fx4q-ay7w`, roadside inspections. Raw digits, no padding.**
*Verified live on 2026-09-14.*

```bash
curl -s -X POST 'https://data.transportation.gov/api/v3/views/fx4q-ay7w/query.json' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"query":"SELECT * WHERE dot_number = '"'"'344554'"'"' ORDER BY insp_date DESC","page":{"pageNumber":1,"pageSize":1},"includeSynthetic":false}'
```

**(c) insurance filings, for completeness** — *verified live on 2026-09-14*:

```bash
curl -s -X POST 'https://data.transportation.gov/api/v3/views/qh9u-swkp/query.json' \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"query":"SELECT * WHERE dot_number = '"'"'00344554'"'"'","page":{"pageNumber":1,"pageSize":3},"includeSynthetic":false}'
```

Useful response headers observed on all three (deprecated but still served):
`X-SODA2-Fields` (JSON array of every column name in the view) and `X-SODA2-Types`
(parallel array of `text` / `number`). These are the cheapest way to get a view's full
schema — one request, no rows needed.

#### 2.5 The legacy v2 `/resource` contract

`lib/fmcsa-census.ts:82-97` — GET, everything in the query string:

```
GET https://data.transportation.gov/resource/az4n-8mr2.json
      ?$where=<url-encoded SoQL WHERE>
      &$limit=1000
      &$select=dot_number,legal_name,phy_city,phy_state,phy_zip,phy_cnty,phone,power_units,total_intrastate_drivers,mcs150_mileage
Accept: application/json
```

`lib/signup/contacts.ts:81` uses the simplest possible form — an implicit column
filter, no `$where`:

```
GET https://data.transportation.gov/resource/az4n-8mr2.json?dot_number=344554&$limit=1
```

Both return a bare JSON array, same as v3.

#### 2.6 SoQL construction and injection

SoQL **is** injectable and it was checked: `SELECT * WHERE dot_number = '1' OR '1'='1'`
returns rows (`lib/fmcsa-inspections.ts:30-33`, `docs/ROADMAP.md:819-823`).

Two layers guard it:

1. `quote()` (`lib/federal/query.ts:67-69`) — wraps in single quotes and doubles any
   embedded quote: `quote("1' OR '1'='1")` → `"'1'' OR ''1''=''1'"`
   (`lib/federal/__tests__/query.test.ts:171-173`).
2. Strict digit validators that **reject rather than strip**: `usdotDigits()`
   (`lib/federal/pad.ts:17-23`) and the identical `digitsOnly()`
   (`lib/fmcsa-inspections.ts:84-92`). The reasoning at `lib/fmcsa-inspections.ts:65-82`
   is the important part: stripping turned `"1' OR '1'='1"` into `111`, a real and
   entirely different carrier, and "the function cheerfully returned DOT 111's roadside
   inspections."

**Quote every value, including numbers.** `lib/federal/query.ts:60-65`: "an unquoted
numeric literal against a TEXT column is an HTTP 400, which is how you learn
`dot_number` is text." And `docs/ROADMAP.md:802-805`: "`inspection_id` is `number` in
`fx4q-ay7w` and `876r-jsdb` but `text` in `wt8s-2hbx`. `IN (80254196)` is a 400 on the
units dataset; it needs quotes. Quote everything."

The sweep's generated SoQL (`lib/federal/sweep.ts:349-352`):

```ts
const list  = batch.map(quote).join(', ');
const extra = spec.where ? ` AND ${spec.where(today)}` : '';
const order = spec.orderBy ? ` ORDER BY ${spec.orderBy}` : '';
const soql  = `SELECT * WHERE ${spec.column} IN (${list})${extra}${order}`;
```

`IN ()` scales well: "takes at least 2,000 ids in under a second … 1,000 DOTs in 0.70s"
(`docs/ROADMAP.md:806-812`).

---

### 3. Every dataset used

`padded` = the query value must be the **8-character zero-padded** USDOT (`pad8`,
`lib/federal/pad.ts:42-44`). Getting this wrong returns **HTTP 200 with zero rows** —
a silently empty panel, never an error.

| Socrata id | Human name | Holds | Key column | Padding | Consumed by |
|---|---|---|---|---|---|
| `6eyk-hxee` | Carrier — All With History | Current authority + required/filed insurance, **one row per docket** | `dot_number` | **pad8 (8 chars)** | `lib/federal/carrier.ts:113`; sweep source `carrier` (`sweep.ts:146`); probe (`probe.ts:283`); `/watch`, `/reports` |
| `qh9u-swkp` | Insurance filings + cancellations | Every BMC filing and any scheduled cancellation | `dot_number` | **pad8 (8 chars)** | `lib/federal/filings.ts:82`; sweep source `filings` (`sweep.ts:147`); probe |
| `az4n-8mr2` | Motor Carrier Census | The whole register: MCS-150 date, fleet counts, address, phone, email | `dot_number` | raw digits | `lib/fmcsa-census.ts:18` (prospecting, v2); `lib/signup/contacts.ts:31` (signup verification, v2); sweep source `census` (`sweep.ts:150`); probe; `refreshFleetCounts.ts:110`; `enrich.ts` phone fill |
| `fx4q-ay7w` | Roadside inspections | One row per inspection: date, place, level, weight, violation/OOS counters | `dot_number` | raw digits | `lib/fmcsa-inspections.ts:44`; sweep source `inspections` (`sweep.ts:170`); `discoverFleet`; truck profile Inspections tab |
| `wt8s-2hbx` | Inspection units | The vehicles on an inspection — **carries the VIN** | `inspection_id` | n/a (`text`, must be quoted) | `lib/fmcsa-inspections.ts:45`; `lib/inspections/discoverFleet.ts`; fleet import; `newVins.ts` |
| `876r-jsdb` | Inspection violations | `viol_code`, `viol_desc`, OOS flag, unit link | `inspection_id` | n/a | `lib/fmcsa-inspections.ts:46`; inspection detail |
| `qbt8-7vic` | Citations / court outcomes | "Not Guilty/Dismissed" etc. Rare — 28,006 rows nationally | `inspection_id` | n/a | `lib/fmcsa-inspections.ts:47`; inspection detail |
| `p2mt-9ige` | Out-of-service orders | Whether the carrier is barred from operating | `dot_number` | raw digits | sweep source `oos` (`sweep.ts:148`); probe |
| `wb4f-neki` | Revocation orders | Served date + effective date; the gap is the cure window | **`usdot_number`** | raw digits | sweep source `revocation` (`sweep.ts:149`); probe |
| `c5y8-a4uz` | Insurance history (Motus) | Insurer name; **no cancellation date** | **`usdot_number`** | raw digits | probe only (`probe.ts:380`) |
| `yu5v-wbh6` | Authority changes (Motus) | When authority was granted/suspended/reinstated | **`usdot_number`** | raw digits | probe only (`probe.ts:409`) |

Also referenced but **never called** (see §5, "datasets that look useful and are not"):
`dm5j-zc6c`, `e67p-xyd5`, `fux9-ij6p`.

Not Socrata at all, but part of the same picture: **QCMobile**,
`GET https://mobile.fmcsa.dot.gov/qc/services/carriers/{dot}?webKey=...`
(`lib/fmcsa.ts:17`, `:139`), plus `/carriers/name/{name}` (`lib/fmcsa.ts:163`). It is
the only source covering every registered carrier, and it is deliberately excluded from
the batched sweep because it answers about one carrier per call
(`lib/federal/sweep.ts:55-61`, `:137-143`).

#### The padding rule, stated once

From `lib/federal/pad.ts:25-41`:

> "TWO FILES NEED THIS AND THE REST MUST NOT HAVE IT. `qh9u-swkp` insurance filings
> `dot_number` "00344554"; `6eyk-hxee` carrier + authority `dot_number` "00344554".
> Verified: `length(dot_number)` returns exactly one distinct value across all 467,983
> rows of `qh9u-swkp`. … `az4n-8mr2` (census), `c5y8-a4uz`, `yu5v-wbh6`, `wb4f-neki`
> and `p2mt-9ige` all store it UNPADDED. Padding those returns zero rows just as
> silently."

The live test round-trips this against the files themselves rather than against a known
carrier, so an absent carrier cannot be mistaken for a padding bug
(`lib/federal/__tests__/portal.live.test.ts:51-109`), including the money assertion:

```ts
expect(withPad.kind, 'padded should find the carrier').toBe('ROWS');
expect(without.kind, 'unpadded should find nothing — silently').toBe('EMPTY');
```

---

### 4. Per-dataset response schemas

Every value in these files comes back as a **JSON string**, including counters and ids,
even where `X-SODA2-Types` declares `number`. Verified live: `fx4q-ay7w` declares
`inspection_id` and `dot_number` as `number` yet serialises `"87647815"` and `"344554"`.
`docs/ROADMAP.md:817-818`: "Counter columns are text. `sum(viol_total)` is a 400;
`sum(viol_total::number)` works."

**Null columns are omitted entirely** from v3 JSON — there is no `"key": null`. See
`lib/federal/filings.ts:36-38` and the test at
`lib/federal/__tests__/filings.test.ts:29-36`. Live confirmation below: the returned
`qh9u-swkp` row has no `cancl_effective_date` key at all.

---

#### 4.1 `6eyk-hxee` — Carrier, All With History

**The name is a misnomer: there are no date columns in it at all.**
`lib/federal/carrier.ts:23-25` — "Verified by pulling a full row: 37 fields, not one of
them a date." Confirmed live: the 43-name `X-SODA2-Fields` list contains no date column.

**One row per docket, not per carrier** (`carrier.ts:27-30`). A carrier with two MC
numbers has two rows and they can disagree.

Fields the code reads (`lib/federal/carrier.ts:93-110`, `probe.ts:296-317`,
`changes.ts`):

| Field | Type | Format / quirk |
|---|---|---|
| `dot_number` | string | **Zero-padded to 8**: `"00344554"` |
| `docket_number` | string | No hyphen here: `"MC421775"`. `wb4f-neki` writes `"MC-424836"` — normalise before comparing (`pad.ts:68-82`) |
| `common_stat`, `contract_stat`, `broker_stat` | string | `'A'` active / `'I'` inactive / `'N'` none (`carrier.ts:65-80`) |
| `common_rev_pend`, `contract_rev_pend`, `broker_rev_pend` | string | `'Y'` / `'N'`. Any `'Y'` = revocation pending |
| `common_app_pend`, `contract_app_pend`, `broker_app_pend` | string | `'Y'` / `'N'` |
| `bipd_file` | string | Liability **on file, in thousands, zero-padded to 5**: `"01000"` = $1,000,000. `"00000"` means nothing on record — **a fact, not a blank** |
| `min_cov_amount` | string | Liability **required**, same encoding: `"00750"` = $750,000 |
| `cargo_req`, `cargo_file`, `bond_req`, `bond_file` | string | `'Y'` / `'N'` |
| `legal_name`, `dba_name` | string | |
| `bus_telno` | string | Present but "carries the same value for a quarter fewer carriers" than the census `phone` (`portal.live.test.ts:144-149`) |

Sample row — **verified live on 2026-09-14**, USDOT 344554 (HULL COOPERATIVE
ASSOCIATION), trimmed to the compliance-relevant half:

```json
{
  "docket_number": "MC421775",
  "dot_number": "00344554",
  "common_stat": "N",
  "contract_stat": "A",
  "broker_stat": "N",
  "common_app_pend": "N",
  "contract_app_pend": "N",
  "broker_app_pend": "N",
  "common_rev_pend": "N",
  "contract_rev_pend": "N",
  "broker_rev_pend": "N",
  "property_chk": "Y",
  "passenger_chk": "N",
  "hhg_chk": "N",
  "min_cov_amount": "00750",
  "cargo_req": "N",
  "bond_req": "N",
  "bipd_file": "01000",
  "cargo_file": "N",
  "bond_file": "N",
  "legal_name": "HULL COOPERATIVE ASSOCIATION",
  "bus_street_po": "805 ELM ST",
  "bus_city": "HULL",
  "bus_state_code": "IA",
  "bus_zip_code": "51239",
  "bus_telno": "7124392831"
}
```

Full column list from `X-SODA2-Fields` (verified live): `docket_number`, `dot_number`,
`mx_type`, `rfc_number`, `common_stat`, `contract_stat`, `broker_stat`,
`common_app_pend`, `contract_app_pend`, `broker_app_pend`, `common_rev_pend`,
`contract_rev_pend`, `broker_rev_pend`, `property_chk`, `passenger_chk`, `hhg_chk`,
`private_auth_chk`, `enterprise_chk`, `min_cov_amount`, `cargo_req`, `bond_req`,
`bipd_file`, `cargo_file`, `bond_file`, `undeliverable_mail`, `dba_name`, `legal_name`,
`bus_street_po`, `bus_colonia`, `bus_city`, `bus_state_code`, `bus_ctry_code`,
`bus_zip_code`, `bus_telno`, `bus_fax`, `mail_street_po`, `mail_colonia`, `mail_city`,
`mail_state_code`, `mail_ctry_code`, `mail_zip_code`, `mail_telno`, `mail_fax`. All 43
typed `text`.

Scale, per `lib/federal/carrier.ts:16`: "1,860,604 rows over 1,679,121 distinct USDOTs."

---

#### 4.2 `qh9u-swkp` — Insurance filings and cancellations

The single most valuable column in the whole integration is
**`cancl_effective_date`**: it is future-dated, and absent while a filing is in force
(`lib/federal/filings.ts:10-20`, `docs/FMCSA-PLAN.md:81-88`). Coverage on the target
segment is 68%, against 16% for `c5y8-a4uz` (`filings.ts:21`).

Fields read (`lib/federal/filings.ts:64-74`):

| Field | Type | Format / quirk |
|---|---|---|
| `dot_number` | string | **Zero-padded to 8** |
| `ins_form_code` | string | `"91X"`, `"91"`, `"34"`, `"84"` — the BMC form. Note: this file writes `"91X"`; `c5y8-a4uz` writes `"BMC-91X"` (see `portal.live.test.ts:234`) |
| `name_company` | string | Insurer name. **Not** `insurance_company_name` — that is `c5y8-a4uz`'s spelling |
| `policy_no` | string | |
| `max_cov_amount` | string | Coverage **in thousands, NOT zero-padded**: `"1000"` = $1,000,000 (`pad.ts:46-53`) |
| `effective_date` | string | **`MM/DD/YYYY`** |
| `trans_date` | string | **`MM/DD/YYYY`** — when FMCSA received it; can lag effective by weeks |
| `cancl_effective_date` | string | **`MM/DD/YYYY`**, future-dated, **key absent when in force** |
| `underl_lim_amount`, `mod_col_1`, `docket_number` | string | Present in the view; `mod_col_1` carried `"BIPD/Primary"` live. Not read by this repo |

Sample row — **verified live on 2026-09-14**, USDOT 00344554. Note the *absence* of
`cancl_effective_date`, which is the in-force case:

```json
{
  "docket_number": "MC421775",
  "dot_number": "00344554",
  "ins_form_code": "91X",
  "mod_col_1": "BIPD/Primary",
  "name_company": "NATIONWIDE AGRIBUSINESS INSURANCE CO.",
  "policy_no": "CPP101046A",
  "trans_date": "01/05/2015",
  "underl_lim_amount": "0",
  "max_cov_amount": "1000",
  "effective_date": "01/01/2015"
}
```

This matches the test fixture at `lib/federal/__tests__/filings.test.ts:4-12` field for
field, which is the canonical fixture for this dataset.

Full column list (`X-SODA2-Fields`, verified live): `docket_number`, `dot_number`,
`ins_form_code`, `mod_col_1`, `name_company`, `policy_no`, `trans_date`,
`underl_lim_amount`, `max_cov_amount`, `effective_date`, `cancl_effective_date` — 11
columns, all `text`.

Scale: 467,983 rows; 107,341 of them carry a 2026 date (`pad.ts:33`, `dates.ts:50-55`).

---

#### 4.3 `az4n-8mr2` — Motor Carrier Census

The register. It is the **only** source with a telephone number and an email address
(`portal.live.test.ts:144-149`, `lib/signup/contacts.ts:9-15`,
`lib/federal/enrich.ts:120-126`).

Fields read across the repo (`probe.ts:232-254`, `fmcsa-census.ts:113-125`,
`signup/contacts.ts`, `refreshFleetCounts.ts:124-136`, `changes.ts`):

| Field | Type | Format / quirk |
|---|---|---|
| `dot_number` | string (declared `number`) | **Raw digits, unpadded** |
| `mcs150_date` | string | **`YYYYMMDD`**, sometimes with `" 0000"` appended (`dates.ts:28-38`). Live sample had no time; the report fixture `report.test.ts:27` has `'20250429 0000'` |
| `add_date` | string | `YYYYMMDD` — registered since |
| `review_date`, `safety_rating_date` | string | `YYYYMMDD` |
| `status_code` | string | `'A'` active |
| `carrier_operation` | string | Single letter: `A` interstate, `B` intrastate hazmat, `C` intrastate non-hazmat (`pad.ts:84-107`) |
| `power_units` | string | Trucks per the MCS-150. **Text**, so SoQL rejects numeric comparison (`fmcsa-census.ts:13-15`) |
| `total_intrastate_drivers` | string | Intrastate only; `0` for most interstate carriers — "must never be labelled 'drivers'" (`fmcsa-census.ts:38-42`) |
| `mcs150_mileage`, `mcs150_mileage_year` | string | |
| `legal_name`, `dba_name` | string | |
| `phy_street`, `phy_city`, `phy_state`, `phy_zip`, `phy_cnty` | string | `phy_zip` sometimes carries ZIP+4 with no hyphen — the code slices 5 (`fmcsa-census.ts:118-119`) |
| `phone`, `fax`, `cell_phone` | string | |
| `email_address` | string | Used for signup verification; never returned unmasked to the browser (`signup/contacts.ts:25-28`) |

Sample row — **verified live on 2026-09-14**, USDOT 344554, trimmed:

```json
{
  "mcs150_date": "20250429",
  "add_date": "19890221",
  "status_code": "A",
  "dot_number": "344554",
  "carrier_operation": "A",
  "mcs150_mileage": "531000",
  "mcs150_mileage_year": "2024",
  "phone": "7124392831",
  "fax": "7124392831",
  "truck_units": "29",
  "power_units": "32",
  "bus_units": "0",
  "fleetsize": "K",
  "docket1prefix": "MC",
  "docket1": "421775",
  "total_intrastate_drivers": "0",
  "hm_ind": "N",
  "total_cdl": "30",
  "total_drivers": "30",
  "classdef": "AUTHORIZED FOR HIRE",
  "legal_name": "HULL COOPERATIVE ASSOCIATION",
  "phy_street": "805 ELM ST",
  "phy_city": "HULL",
  "phy_state": "IA",
  "phy_zip": "51239",
  "phy_cnty": "167",
  "email_address": "accounting@hullcoop.com",
  "review_date": "20051219",
  "safety_rating": "S",
  "safety_rating_date": "20060103",
  "owntruck": "12",
  "owntract": "17",
  "owntrail": "17",
  "docket1_status_code": "A"
}
```

The full view is **137 columns** (from `X-SODA2-Fields`), including a large block of
`crgo_*` cargo-type flags (`"X"` when carried) and `own*`/`trm*`/`trp*` equipment
counts. Only `dot_number` is typed `number`; every other column is `text`.

> **Discrepancy worth flagging.** `lib/federal/refreshFleetCounts.ts:142-146` states:
> "The census has no total-driver column — only `total_intrastate_drivers`". The live
> view **does** expose `total_drivers` (`"30"` on this row), plus `total_cdl` and
> `driver_inter_total`. I cannot tell from the repo whether the column was added after
> that comment was written or whether it is sparsely populated across carriers — I
> checked one carrier. Do not rely on either reading without sampling more rows. The
> repo's current behaviour is to take driver counts **only** from QCMobile
> (`refreshFleetCounts.ts:147-168`).

---

#### 4.4 `fx4q-ay7w` — Roadside inspections

Treated as an event log everywhere, but five of its columns are equipment compliance
facts (`lib/federal/probe.ts:500-529`, `docs/FMCSA-PLAN.md:155-188`).

Fields read (`lib/fmcsa-inspections.ts:258-278`, `probe.ts`, `changes.ts`):

| Field | Type | Format / quirk |
|---|---|---|
| `inspection_id` | string (declared `number`) | The join key into `wt8s-2hbx` / `876r-jsdb` / `qbt8-7vic`. Quote it |
| `dot_number` | string (declared `number`) | **Raw digits, unpadded** |
| `insp_date` | string | **`YYYYMMDD`**. Fixed-width and zero-padded, so `ORDER BY` and `>` string comparison are chronologically correct here — this is why the sweep's date window can be a server-side `WHERE` (`fmcsa-inspections.ts:297-299`, `portal.live.test.ts:292-306`) |
| `report_state`, `report_number` | string | |
| `insp_level_id` | string | `"1"`–`"6"`; 1 is the full NAS inspection |
| `location_desc` | string | Free text from the officer |
| `county_code_state` | string | |
| `gross_comb_veh_wt` | string | Pounds, whole **combination** on the day. A **floor**, never a GVWR — may raise what you assume about the fleet, never lower it (`probe.ts:509-529`) |
| `viol_total`, `oos_total` | string | |
| `driver_viol_total`, `driver_oos_total` | string | |
| `vehicle_viol_total`, `vehicle_oos_total` | string | Truck-level OOS — the equipment equivalent of an OOS order |
| `hazmat_viol_total`, `hazmat_oos_total` | string | Non-zero means they haul hazmat at all |
| `insp_interstate` | string | `'Y'` / `'N'`, per trip — selects which rule set applies |
| `post_acc_ind` | string | `'Y'` when the inspection followed a crash |

Sample row — **verified live on 2026-09-14**, USDOT 344554, newest inspection, trimmed:

```json
{
  "change_date": "20260422 2139",
  "inspection_id": "87647815",
  "dot_number": "344554",
  "report_state": "SD",
  "report_number": "0470000504",
  "insp_date": "20260422",
  "insp_start_time": "0836",
  "insp_end_time": "0846",
  "location_desc": "CANTON SD",
  "county_code_state": "SD",
  "insp_level_id": "3",
  "insp_facility": "R",
  "post_acc_ind": "N",
  "gross_comb_veh_wt": "64000",
  "viol_total": "0",
  "oos_total": "0",
  "driver_viol_total": "0",
  "driver_oos_total": "0",
  "vehicle_viol_total": "0",
  "vehicle_oos_total": "0",
  "hazmat_viol_total": "0",
  "hazmat_oos_total": "0",
  "upload_dot_number": "00344554",
  "insp_carrier_name": "HULL COOPERATIVE ASSOCIATION",
  "insp_carrier_state": "IA",
  "docket_number": "0",
  "insp_interstate": "Y"
}
```

Two live observations worth carrying forward: `upload_dot_number` in this file **is**
8-char padded even though `dot_number` is not — do not key off the wrong one; and
`docket_number` here read `"0"` rather than an MC number.

The test fixture at `lib/federal/__tests__/changes.test.ts:269-279` uses the same
inspection id `'87647815'` and pins `insp_date: '20260630'`, `location_desc:
'SACRAMENTO'`, `report_state: 'CA'`, `insp_level_id: '2'`, and the four counter columns.

The view has 63 columns; the rest are MCMIS plumbing (`snet_*`, `upload_*`,
`transaction_*`, `census_search_date`, `source_office`, `mcmis_add_date`).

Scale: Werner has 17,648 inspections (`fmcsa-inspections.ts:51-56`). 55% of the target
segment have never been inspected (`docs/ROADMAP.md:723`).

---

#### 4.5 `wt8s-2hbx` — Inspection units (the VIN file)

**Not verified live** (I stopped at four network calls). Field names below come from
`lib/fmcsa-inspections.ts:345-355` and are pinned against live data by
`lib/federal/__tests__/portal.live.test.ts:185-203`, which is the authoritative source.

| Field | Type | Format / quirk |
|---|---|---|
| `inspection_id` | **`text`** in this view | Must be quoted; `IN (80254196)` is a 400 here (`docs/ROADMAP.md:802-805`) |
| `insp_unit_id` | string | Joins violations to this specific unit |
| `insp_unit_type_id` | string | `'9'` semi-trailer, `'10'` straight truck, `'11'` truck tractor. Only `'9'` is treated as a trailer (`discoverFleet.ts:87`) |
| `insp_unit_number` | string | |
| `insp_unit_make` | string | `FORD`, `FRHT`, `INTL`, `MACK`, `HINO`, `PTRB`, `KW`, `VOLVO` … |
| `insp_unit_company` | string | **The carrier's own fleet/door number, NOT a model year.** Sampled values: `'101'`, `'224'`, `'MCCZ 420778'`, `'8'`, `'2947325'`, `'SCPZ 201769'`, `'001'`, `'WHT'` (`fmcsa-inspections.ts:156-173`) |
| `insp_unit_license` | string | Plate |
| `insp_unit_license_state` | string | |
| `insp_unit_vehicle_id_number` | string | **The VIN. The column is not called `vin`.** 17 characters; 472 of 472 real units carried a valid one (`discoverFleet.ts:12-13`) |

The live test asserts the VIN column name, its 17-char length, the presence of
`insp_unit_company` and `insp_unit_type_id`, and — explicitly — that **no column in this
view ends in `year`**:

```ts
expect(Object.keys(units).some((k) => /(^|_)year$/.test(k))).toBe(false);
```
— `lib/federal/__tests__/portal.live.test.ts:202`

---

#### 4.6 `876r-jsdb` — Violations

**Not verified live.** Fields from `lib/fmcsa-inspections.ts:377-391`:

| Field | Type | Notes |
|---|---|---|
| `inspection_id` | declared `number` | |
| `insp_violation_id` | string | |
| `seq_no` | string | Position within the inspection; citations reference it as `vioseqnum` |
| `insp_unit_id` | string | Which unit; **null for a driver violation** |
| `viol_code` | string | e.g. `"396.17C"` |
| `viol_desc` | string | FMCSA's own wording |
| `part_no`, `part_no_section` | string | 49 CFR part, e.g. `"396"` |
| `out_of_service_indicator` | string | `'Y'` is the only truthy value; anything else is not an OOS order (`fmcsa-inspections.ts:386-390`) |

`docs/FMCSA-PLAN.md:15-16` also names `insp_viol_unit: "D"` for a driver violation. That
field is **not read anywhere in the code** — I did not verify it exists.

---

#### 4.7 `qbt8-7vic` — Citations

**Not verified live.** Fields from `lib/fmcsa-inspections.ts:420-425`:
`inspection_id`, `vioseqnum` (matches `876r-jsdb.seq_no`), `citation_code`,
`citation_result` (e.g. `"Not Guilty/Dismissed"`). 28,006 rows nationally
(`fmcsa-inspections.ts:398-401`).

---

#### 4.8 `p2mt-9ige` — Out-of-service orders

**Not verified live.** Fields from `lib/federal/probe.ts:469-491` and
`lib/federal/changes.ts`:

| Field | Type | Notes |
|---|---|---|
| `dot_number` | string | Raw digits |
| `oos_date` | string | **ISO `YYYY-MM-DD`**, possibly `…T00:00:00.000`. This file is the exception — `isoDate()` parses it and `compactDate()` must return null (`dates.ts:62-72`, live test at `portal.live.test.ts:269-279`) |
| `rescind_date` | string | ISO |
| `status` | string | `"ACTIVE"` — but see the gotcha: a row can be `status: 'ACTIVE'` **and** carry a rescind date (`changes.test.ts:193-196`) |
| `oos_reason` | string | e.g. `"Failure to pay civil penalty"` |

Fixture, from `lib/federal/__tests__/changes.test.ts:179-183`:

```json
{ "oos_date": "2026-01-05", "oos_reason": "Failure to pay civil penalty", "status": "ACTIVE" }
```

An order is treated as in force only when `status === 'ACTIVE'` **and** there is no
parseable `rescind_date` (`probe.ts:484`).

---

#### 4.9 `wb4f-neki` — Revocation orders

**Not verified live.** Fields from `lib/federal/probe.ts:441-464`:

| Field | Type | Notes |
|---|---|---|
| `usdot_number` | string | **Note the different column name.** Raw digits |
| `docket_number` | string | Hyphenated here: `"MC-424836"` |
| `order1_serve_date` | string | `YYYYMMDD` |
| `order1_effective_date` | string | `YYYYMMDD`. The gap served → effective is the carrier's cure window |
| `reason` | string | |

Fixture, `lib/federal/__tests__/changes.test.ts:216-221`:

```json
{ "docket_number": "MC-424836", "order1_serve_date": "20260801", "order1_effective_date": "20260920" }
```

12,771 rows total (`probe.ts:450`).

---

#### 4.10 `c5y8-a4uz` — Insurance history (Motus)

**Not verified live.** Probe-only. Fields (`probe.ts:380-404`): `usdot_number`,
`ins_form_code` (spelled `"BMC-91"` / `"BMC-91X"` here, unlike `qh9u-swkp`'s `"91X"`),
`effective_date` (**`YYYYMMDD`**), `insurance_company_name`, `policy_no`,
`max_cov_amount`.

**`max_cov_amount` in this file is in DOLLARS, not thousands** — the opposite of
`qh9u-swkp`. Pinned by `lib/federal/__tests__/portal.live.test.ts:231-240`, whose
comment records that an earlier draft of the test was fooled by a BMC-34 cargo filing at
`"5000.00"` (the cargo minimum genuinely is $5,000) and that only BMC-91/91X
discriminates. Note the repo's `probe.ts:400` nonetheless passes it through
`thousandsToDollars()` — treat that as suspect if you reuse this dataset.

Coverage: ~85,000 carriers of 2.2 million; empty for 84% of the target segment
(`probe.ts:392-393`, `carrier.ts:11-14`).

---

#### 4.11 `yu5v-wbh6` — Authority changes (Motus)

**Not verified live.** Probe-only. Fields (`probe.ts:409-430`): `usdot_number`,
`status_change_date` (**`YYYYMMDD`**), `op_auth_type`, `op_auth_status`, `reason`.
135,358 rows. It remains "the only source for WHEN authority changed"
(`carrier.ts:19-21`); `6eyk-hxee` has the status but no dates.

---

#### 4.12 QCMobile (not Socrata)

`GET https://mobile.fmcsa.dot.gov/qc/services/carriers/{dot}?webKey={FMCSA_WEBKEY}`,
`Accept: application/json`, 15 s timeout, 1 h cache (`lib/fmcsa.ts:110-116`).

Response envelope: `res.json?.content?.carrier`. **A 200 with `content: null` means the
number is not issued** (`lib/fmcsa.ts:142-144`) — that is `NOT_FOUND`, not an error.
Name search returns `content` as an array of `{ carrier }` (`lib/fmcsa.ts:166-171`).

Fields mapped (`lib/fmcsa.ts:72-95`) — camelCase, unlike every Socrata file:
`dotNumber`, `legalName`, `dbaName`, `phyStreet`, `phyCity`, `phyState`, `phyZipcode`,
`totalPowerUnits`, `totalDrivers`, `statusCode`, `allowedToOperate` (`'Y'`/`'N'`),
`mcs150Outdated` (`'Y'`/`'N'`), `crashTotal`, `fatalCrash`, `injCrash`, `vehicleOosRate`,
`vehicleOosRateNationalAverage`, `driverOosRate`, `driverOosRateNationalAverage`.

Three things to know:

- **It has no phone number and no email.** 53 fields, none of them a contact
  (`lib/signup/contacts.ts:11-15`, `portal.live.test.ts:144-149`). Use the census.
- **`mcs150Outdated` carries no information.** `docs/FMCSA-PLAN.md:74-77`: it read
  `'N'` for every carrier sampled — 0 of 20 active CA carriers whose last filing
  predated 2024 were flagged. Use `az4n-8mr2.mcs150_date` instead.
- The EIN is returned and is deliberately dropped before storage
  (`lib/federal/qcmobile.ts:24-29`, `:36`).

---

### 5. Gotchas and hard-won lessons

**1. Silent truncation at 1,000 rows.** A full page is not "all the rows", it is "at
least this many", and the response is byte-identical either way
(`lib/federal/sweep.ts:355-371`). A live test found 50 active CA carriers over a
one-year inspection window returning exactly 1,000 rows. Fix: page while
`rows.length === PAGE_SIZE`, and report hitting the cap.

**2. Padding failures are HTTP 200 + zero rows.** The worst failure mode in the whole
integration, because it looks like "this carrier has no record". `lib/federal/pad.ts:34-37`.
Two files padded (`6eyk-hxee`, `qh9u-swkp`), five not. The admin probe prints the padded
form on screen precisely because it is "the single most common cause of an empty panel"
(`app/admin/fmcsa/page.tsx:88-100`).

**3. Slash dates sort wrong, silently.** `qh9u-swkp` uses `MM/DD/YYYY`. Lexically
`"12/31/2025" > "01/15/2026"`, so `ORDER BY trans_date DESC` returns a 2025 row as
newest while 107,341 rows carry 2026 dates. The query succeeds and returns the wrong
row. **Never sort this file server-side** — parse to ISO, then sort in JS with
`byIsoDesc()` (`lib/federal/dates.ts:45-60`, `:88-98`;
`lib/federal/__tests__/dates.test.ts:"is not fooled by the ordering that ORDER BY would produce"`).
`YYYYMMDD` files (`az4n-8mr2`, `fx4q-ay7w`, `c5y8-a4uz`, `yu5v-wbh6`, `wb4f-neki`) are
fixed-width and zero-padded, so lexical order *is* chronological — `ORDER BY` there is
safe (`dates.ts:36-38`).

**4. Four date formats, no house style.** `YYYYMMDD` (optionally `" HHMM"`, always
midnight in every row sampled), `MM/DD/YYYY`, ISO `YYYY-MM-DD[T…]`. `anyFederalDate()`
exists but carries a warning: "PRODUCTION CODE SHOULD NOT USE THIS. A parser that
accepts anything cannot tell you that a file changed its format"
(`lib/federal/dates.ts:74-86`). All parsers return an ISO **string**, never a `Date`,
because these are calendar days with no zone (`dates.ts:9-13`).

**5. Zero is a fact, not a blank.** `bipd_file: "00000"` against `min_cov_amount:
"00750"` is a carrier with no liability filing against a $750,000 requirement — "the
single most valuable comparison in the whole federal record"
(`lib/federal/pad.ts:55-59`). `thousandsToDollars('00000')` returns `0`, not null
(`lib/federal/__tests__/pad.test.ts:56-59`). The mirror-image rule lives in
`refreshFleetCounts.usableCount()`, which *refuses* zero — because a zero power-unit
count would delete a working progress bar (`refreshFleetCounts.ts:54-69`).

**6. Coverage amounts are in thousands — except where they aren't.** `6eyk-hxee`
zero-pads to 5 (`"01000"`); `qh9u-swkp` does not (`"1000"`); both mean thousands.
`c5y8-a4uz` stores **dollars**. Getting it wrong is a factor of 1,000
(`pad.ts:46-53`, `portal.live.test.ts:206-240`).

**7. Column-name surprises.**
- The VIN column is **`insp_unit_vehicle_id_number`**, not `vin` (`portal.live.test.ts:194-197`).
- `insp_unit_company` is the carrier's **fleet/door number**, not a model year. Reading
  it as a year fed `vehicles.year`, which is CHECKed 1900–2100, so most imports were
  refused and any value that fit became a fake model year driving the CARB OBD cadence
  (`fmcsa-inspections.ts:156-173`, `docs/FMCSA-PLAN.md:33`). **There is no model-year
  column anywhere in `wt8s-2hbx`.**
- Insurer name is `name_company` in `qh9u-swkp` and `insurance_company_name` in
  `c5y8-a4uz`.
- The USDOT column is `dot_number` in five files and **`usdot_number`** in
  `wb4f-neki`, `c5y8-a4uz`, `yu5v-wbh6` (`sweep.ts:145-178`).
- Docket spelling differs: `"MC421775"` vs `"MC-424836"`. Normalise before matching, or
  one carrier looks like two (`pad.ts:68-82`).
- `TRAILER_TYPES` once held `'10'`. Type 10 is a **straight truck** (FORD/FRHT/INTL/
  MACK/HINO/PTRB), 2.4 million rows, and exactly the box-truck operator this product
  targets. Only `'9'` is a trailer (`discoverFleet.ts:60-87`).

**8. Datasets that look useful and are not.**
- `dm5j-zc6c` and `e67p-xyd5` are **daily deltas**, not snapshots, and were once wired in
  as if they were histories. 1,131 rows vs `yu5v-wbh6`'s 135,358; 101 rows vs
  `wb4f-neki`'s 12,771. Identical columns, so the swap is a drop-in
  (`docs/FMCSA-PLAN.md:35`, `portal.live.test.ts:243-260`). A carrier whose status had
  not changed in 48 hours was simply absent, and the Authority panel was empty for 100%
  of the target segment.
- `e67p-xyd5` was declared in a `VIEW` map and **never queried at all** — dead code
  pointing at a 101-row delta (`docs/FMCSA-PLAN.md:196-197`).
- `fux9-ij6p` (UCR) is "a link to a web form", not an API (`docs/HANDOFF.md:174`).
- The whole **Motus family** (`yu5v-wbh6`, `wb4f-neki`, `c5y8-a4uz`) covers ~85,000 of
  2.2 million carriers. Measured against 25 random active CA carriers with 5–29 power
  units: Authority panel empty for **100%**, Insurance for **84%**
  (`carrier.ts:11-14`, `docs/FMCSA-PLAN.md:37-39`).
- **There is no driver data anywhere.** 95 columns across the four inspection datasets
  contain no name, no CDL number, no licence expiry, no medical date
  (`docs/FMCSA-PLAN.md:11-18`).
- **SoQL on this deployment cannot join across views** — the four inspection datasets
  are chained client-side (`docs/ROADMAP.md:700-701`).

**9. Quarter anchoring, for any windowed query in a scheduled job.** The obvious window
— "the last 90 days", recomputed nightly — changes the row set every single day as old
rows fall off the back. The digest then changes every night for every carrier and the
job writes a row daily, which is exactly the bloat the digest exists to prevent.
Anchoring to the start of the **previous** quarter moves the window four times a year
instead of 365 (`lib/federal/sweep.ts:96-135`):

```ts
function quarterAnchor(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  const quarter = Math.floor(d.getUTCMonth() / 3);
  const previous = quarter - 1;
  const year = previous < 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  const month = ((previous + 4) % 4) * 3 + 1;
  return `${year}${String(month).padStart(2, '0')}01`;
}
```

Pinned: `'2026-08-28'` → `'20260401'`; `'2026-02-14'` → `'20251001'`
(`lib/federal/__tests__/sweep.test.ts:"looks back one quarter, not one year"`). The
first version reached back a full year and hit the 1,000-row ceiling.

**10. The order-independent digest.** Change detection hashes the rows, and two details
decide whether it works:

- **Strip Socrata's own `:`-prefixed metadata.** `:id`, `:version`, `:created_at`,
  `:updated_at` are regenerated when the *file* is rebuilt, not when the data changes.
  "Every row of `6eyk-hxee` carried `:updated_at` 2026-08-27T13:23:20 on a day nothing
  about any carrier had changed. Hashing those would mark all 1.68 million carriers as
  changed every single night" (`sweep.ts:28-37`). Stripped before hashing **and** before
  storing (`stripMeta`, `sweep.ts:232-238`). (My live calls sent
  `includeSynthetic: false` and the responses carried no `:`-prefixed keys — but
  `stripMeta` is cheap insurance and the sweep tests pin it:
  `lib/federal/__tests__/sweep.test.ts:"the digest ignores the portal's own metadata"`.)
- **Sort the per-row hashes.** SoQL guarantees no ordering without `ORDER BY`. Today's
  stable ordering is "an observed accident, not a contract" (`sweep.ts:250-261`):

```ts
export function digestOf(rows: readonly Row[]): string {
  const perRow = rows.map((r) => canonical(stripMeta(r))).sort();
  return createHash('sha256').update(perRow.join('\n')).digest('hex').slice(0, 32);
}
```

`canonical()` also sorts object keys, so serialisation order cannot move the hash
(`sweep.ts:240-248`).

**11. No DISTINCT ON downstream.** Not a Socrata limitation — a PostgREST/Supabase one,
on the table the observations land in. "PostgREST has no DISTINCT ON, and doing it in
application code is cheaper than one query per source"
(`lib/federal/observations.ts:45-48`). The idiom used in both readers is: order **oldest
first**, write into a `Map`, and let the last write win, leaving the newest per key
(`observations.ts:58-78`, `sweep.ts:311-338`).

**12. A blank `X-App-Token` header is a 403 on every request.** Omit the header entirely
when the value is unset (`docs/ROADMAP.md:813-816`).

**13. Nothing on the signup path may hang.** `lib/signup/contacts.ts:89` uses an 8 s
timeout: "Socrata is a third party on the signup path. Without a timeout a slow day
there becomes a hung signup form."

---

### 6. The result contract

#### The three-state union

`lib/federal/query.ts:39-42`:

```ts
export type FederalResult =
  | { kind: 'ROWS'; rows: Row[]; ms: number; sent: Sent }
  | { kind: 'EMPTY'; ms: number; sent: Sent }
  | { kind: 'ERROR'; reason: string; status: number | null; ms: number; sent: Sent };
```

with

```ts
export type Sent = {
  /** Dataset id as it appears in a portal URL — '6eyk-hxee'. */
  view: string;
  /** The SoQL actually sent, after quoting and padding. */
  soql: string;
  pageSize: number;
};
```

#### Why EMPTY and ERROR must never be conflated

This is the design constraint the whole module exists for
(`lib/federal/query.ts:14-22`):

> ```
>   ROWS   the portal answered and had something
>   EMPTY  the portal answered and had nothing        <- a fact
>   ERROR  we did not get an answer                   <- not a fact
> ```
> "'No insurance filing on record' is a compliance finding a carrier may act on. 'We
> could not check' is not a finding at all, and showing it as one is the worst thing
> this product can do. So it is in the type, where it cannot be dropped."

The three wrappers this replaced all collapsed both cases into one null, and the Watch
page reconstructed the difference afterwards with a hand-maintained parallel
`unavailable` array (`query.ts:6-13`).

Downstream consequences:

- The sweep **writes nothing at all** for a batch it could not reach, rather than
  recording an empty observation. "'FMCSA has no insurance on file for you' is a
  finding; recording it because a request timed out would be a lie with a date on it"
  (`sweep.ts:38-45`; test `sweep.test.ts:"writes nothing at all for a batch that could not be reached"`).
- The probe maps the three states to `FOUND` / `NOTHING` / `ERROR` panels and routes
  every panel through one function so "no source can invent a fourth state"
  (`probe.ts:132-146`). A `NOTHING` panel carries an `emptyNote` explaining why empty
  may be legitimate for that file (`probe.ts:71-79`).
- `latestObservations()` returns `null` on error rather than an empty map, for the same
  reason (`observations.ts:49-53`).
- `discoverFleet()` carries `error: string | null` separately from an empty `trucks`
  array (`discoverFleet.ts:117-118`).
- The escape hatch for callers that want a plain list preserves the distinction:
  `rowsOrNull()` returns rows / `[]` / `null` (`query.ts:160-165`).

#### How errors are classified

In `federalQuery` (`query.ts:88-157`), in order:

| Condition | Result |
|---|---|
| `fetch` throws with `name === 'TimeoutError'` | `ERROR`, `reason: "No answer within 20s."`, `status: null` |
| `fetch` throws otherwise | `ERROR`, `reason` = the error message, `status: null` |
| `!res.ok` | `ERROR`, `reason: "HTTP {status}: {first 300 chars of body}"`, `status` set |
| body is not valid JSON | `ERROR`, `reason: "Unreadable response: …"` |
| body is valid JSON but **not an array** | `ERROR`, `reason: "Portal returned a 200 that was not a row array."` |
| array, length 0 | `EMPTY` |
| array, length > 0 | `ROWS` |

Reading the 400 body matters: "The portal puts the useful part of a 400 in the body —
'Type mismatch for op$=' tells you the column is text, which the status code does not"
(`query.ts:110-115`). The non-array case is explicitly an error, not empty, so that the
day the endpoint starts wrapping results in an envelope is visible rather than silent
(`query.ts:144-145`; test at `query.test.ts:76-87`).

#### How timings and the query are recorded

Every result — **including a failed one** — carries `ms` (wall clock, started before the
fetch) and `sent` (`query.ts:84-86`, test at `query.test.ts:119-122`). The rationale:
"the admin probe's entire job is showing those, and because a query you cannot see is a
query you cannot debug" (`query.ts:23-25`).

The admin screen at `/admin/fmcsa` renders `sent` as a reproducible request
(`app/admin/fmcsa/page.tsx:154-159`):

```
POST https://data.transportation.gov/api/v3/views/{view}/query.json
{"query": "...", "page": {"pageNumber": 1, "pageSize": N}}
```

plus the per-panel `{ms}ms` and the whole fan-out's total. Panels are fetched with
`Promise.all` so one slow source does not delay the rest, and the per-panel timings are
how you find out which one it was (`probe.ts:672-679`).

At the sweep level, failures are accumulated rather than thrown:
`SweepSummary { source, asked, found, written, failedBatches, reasons[] }`
(`sweep.ts:210-221`). `sweepFederalRecord()` never throws, wraps each source in
`try/catch`, and stops starting new sources past a `budgetMs` (default 60 s) because
"the deadline alerts underneath this are what the carrier pays for; a slow portal must
cost federal freshness, never an alert" (`sweep.ts:488-531`). `written` counts what
actually landed, not what was offered — `ignoreDuplicates` silently drops rows against
the one-per-day index (`sweep.ts:456-476`).

---

### Appendix: quick reference

```
BASE (v3)      https://data.transportation.gov/api/v3/views/{view}/query.json   POST
BASE (v2)      https://data.transportation.gov/resource/{view}.json             GET
QCMobile       https://mobile.fmcsa.dot.gov/qc/services/carriers/{dot}?webKey=  GET

headers        Content-Type: application/json, Accept: application/json   (no auth)
body           {"query": <SoQL>, "page": {"pageNumber": N, "pageSize": M}, "includeSynthetic": false}
pageSize       clamped [1, 1000], default 100
timeout        20 s (federalQuery) / 25 s (inspections, census) / 8 s (signup)
cache          21600 s default; 0 for the nightly sweep
MAX_PAGES      5     BATCH 200 carriers (25 for inspections)

pad8 required  6eyk-hxee, qh9u-swkp
usdot_number   wb4f-neki, c5y8-a4uz, yu5v-wbh6        (everything else: dot_number)
MM/DD/YYYY     qh9u-swkp only   (never ORDER BY)
YYYY-MM-DD     p2mt-9ige and the QCMobile/ISO-ish sources
YYYYMMDD       everything else  (safe to ORDER BY and to compare with >)
thousands      6eyk-hxee.bipd_file, .min_cov_amount, qh9u-swkp.max_cov_amount
dollars        c5y8-a4uz.max_cov_amount
VIN column     wt8s-2hbx.insp_unit_vehicle_id_number
```


---

## 2. FMCSA QCMobile — mobile.fmcsa.dot.gov

Knowledge transfer for a developer re-implementing these calls in a different
application. Every claim below is cited to a file and line in
`/Users/bedopapajanian/Work/fleetview-legacy`.

**Provenance note.** No `.env.local` exists in this worktree (only
`.env.example`), so **no live calls were made** and **no sample below is a live
capture**. Every sample value is taken from a repo fixture or from a value a
repo document records as verified against the live endpoint; each is labelled.
Where the repo does not establish a fact, this document says so explicitly
rather than guessing.

---

### 1. Overview

#### What QCMobile is

QCMobile is FMCSA's **keyed REST API for one carrier at a time**. Give it a
USDOT number (or a name) and it returns a single JSON carrier record.

> "FMCSA QCMobile API — the only public integration available to this product."
> — `lib/fmcsa.ts:2`

#### How it differs from the Socrata open-data datasets

This codebase consumes two completely different FMCSA data channels and keeps
them deliberately separate:

| | QCMobile | DOT open data (Socrata) |
|---|---|---|
| Host | `mobile.fmcsa.dot.gov` | `data.transportation.gov` |
| Shape | REST, one carrier per call | SoQL query over a dataset id (`6eyk-hxee`, `az4n-8mr2`, `fx4q-ay7w`, …) |
| Auth | `webKey` query param, rate-limited (`.env.example:21-27`) | No key |
| Batching | **Impossible** — one carrier per call | ~200 carriers per request, keyed by `dot_number` |
| Coverage | **Every registered carrier** | `6eyk-hxee` misses ~25%; the Motus family misses most of the target segment |

The coverage asymmetry is the stated reason QCMobile is worth the per-carrier
call cost:

> "IT ALSO COVERS EVERY CARRIER, which none of the Socrata files do. 6eyk-hxee
> is better structured and still misses roughly a quarter; the Motus family
> misses most of the target segment."
> — `lib/federal/qcmobile.ts:20-23`; same argument in `db/migrations/0062_qcmobile_source.sql:11-17`

Consequence for architecture: QCMobile is **excluded from the batched sweep at
the type level** — `export type BatchSource = Exclude<SweepSource, 'qcmobile'>`
(`lib/federal/sweep.ts:143`), so `sweepSource()` cannot be handed it by mistake
(`lib/federal/sweep.ts:138-143`). It rides a per-carrier loop weekly instead
(`app/api/cron/digest/route.ts:516-523`).

#### Base URL

```
https://mobile.fmcsa.dot.gov/qc/services
```

Declared twice, identically and independently:
- `lib/fmcsa.ts:17` — `const BASE = 'https://mobile.fmcsa.dot.gov/qc/services';`
- `lib/federal/qcmobile.ts:33` — same literal

(and hardcoded a third time in `scripts/new-carrier.mjs:70`).

#### Endpoints actually used

Only two. A repo-wide grep for `qc/services` and `/carriers/` finds no others.

| Endpoint | Purpose | Call site |
|---|---|---|
| `GET /carriers/{usdot}` | One carrier by USDOT number | `lib/fmcsa.ts:139`, `lib/federal/qcmobile.ts:61`, `scripts/new-carrier.mjs:70` |
| `GET /carriers/name/{name}` | Search by legal or DBA name | `lib/fmcsa.ts:163` |

The name endpoint exists because "an owner knows his company name but not his
USDOT number off the top of his head — which, in a first meeting, is most of
them" (`lib/fmcsa.ts:154-158`). It is used only by the admin importer
(`app/admin/actions.ts:156`).

#### Authentication

A single query parameter, spelled **exactly** `webKey` (lowercase `w`, capital
`K`):

```ts
const url = `${BASE}${path}${separator}webKey=${encodeURIComponent(key)}`;
```
— `lib/fmcsa.ts:107`; same construction inline at `lib/federal/qcmobile.ts:61`.

The value comes from `process.env.FMCSA_WEBKEY` (`lib/fmcsa.ts:101`,
`lib/federal/qcmobile.ts:52`). Both call sites return a typed error rather than
calling without it:

- `lib/fmcsa.ts:103` — `{ ok: false, reason: 'FMCSA_WEBKEY is not set.' }`
- `lib/federal/qcmobile.ts:56` — `{ kind: 'ERROR', reason: 'FMCSA_WEBKEY is not set.', ms: ms() }`

No header auth, no bearer token, no cookie. The key is always in the query
string.

**Server-side only, deliberately.** The env var has no `NEXT_PUBLIC_` prefix:

> "NO NEXT_PUBLIC_ PREFIX, deliberately: that would inline the key into the
> browser bundle, where anyone could read it and exhaust your rate limit."
> — `.env.example:24-26`; same warning at `lib/fmcsa.ts:11-12`

Both modules that call the endpoint start with `import 'server-only';`
(`lib/federal/qcmobile.ts:1`, and `lib/fmcsa.ts` is only ever imported from
server actions).

#### Obtaining a key

> "Free key from https://mobile.fmcsa.dot.gov/QCDevsite -> My WebKeys."
> — `.env.example:21`

#### Documented rate limits

**The repo never states a numeric limit.** What it does state, repeatedly, is
that one exists and that it drove the architecture:

- `.env.example:24-26` — a leaked key lets "anyone … exhaust your rate limit".
- `db/migrations/0062_qcmobile_source.sql:6-9` — "it needs an API key with a
  rate limit behind it. It cannot batch, so it is fetched at signup and
  refreshed weekly".
- `lib/federal/sweep.ts:56-58` — "sits behind a rate-limited key, so it rides
  the per-carrier loop weekly instead".
- `app/api/cron/digest/route.ts:520-523` — same.
- `lib/fmcsa.ts:113-115` — a 1-hour Next.js fetch cache on the lookup path,
  because "FMCSA data changes at most daily; there is no reason to hammer them
  while an office manager retypes a USDOT number."

**Unknown:** the actual requests-per-minute/day figure. If you need it, get it
from the QCDevsite portal — it is not recorded anywhere in this codebase.

---

### 2. Exact HTTP contract

#### Common

- **Method:** `GET` (only).
- **Headers sent:** exactly one — `Accept: application/json`
  (`lib/fmcsa.ts:111`, `lib/federal/qcmobile.ts:62`). No `Authorization`, no
  `User-Agent` override, no content type.
- **Query parameters:** exactly one — `webKey`. The value is passed through
  `encodeURIComponent()` at every call site.
- **Timeout:** 15 s via `AbortSignal.timeout(15_000)`
  (`lib/fmcsa.ts:112`; `lib/federal/qcmobile.ts:34` `const TIMEOUT_MS = 15_000;`
  used at line 63). The CLI script uses 20 s (`scripts/new-carrier.mjs:71`).
- **Caching:** `lib/fmcsa.ts` adds Next.js `next: { revalidate: 3600 }`
  (`lib/fmcsa.ts:115`). `lib/federal/qcmobile.ts` does **not** — its call is
  uncached, because it runs once weekly per carrier from cron.

#### Endpoint A — carrier by USDOT

```
GET https://mobile.fmcsa.dot.gov/qc/services/carriers/{usdot}?webKey={key}
```

`{usdot}` is **digits only**. Both callers strip non-digits before building the
URL, and refuse if nothing is left:

```ts
const digits = String(usdot).replace(/\D/g, '');
if (!digits) return { kind: 'ERROR', reason: 'Not a USDOT number.', ms: ms() };
```
— `lib/federal/qcmobile.ts:57-58`; equivalent at `lib/fmcsa.ts:126-127`.

Note: **no zero-padding here.** Zero-padding to 8 (`pad8`) is a *Socrata* trap
for `6eyk-hxee` and `qh9u-swkp` (`lib/federal/carrier.ts:32-33`,
`lib/federal/sweep.ts:147-148`), not a QCMobile one. Do not pad the QCMobile
path segment.

```bash
curl -sS \
  -H 'Accept: application/json' \
  "https://mobile.fmcsa.dot.gov/qc/services/carriers/3947827?webKey=$FMCSA_WEBKEY"
```

#### Endpoint B — carrier search by name

```
GET https://mobile.fmcsa.dot.gov/qc/services/carriers/name/{name}?webKey={key}
```

`{name}` is `encodeURIComponent()`-escaped (`lib/fmcsa.ts:163`). The caller
refuses fewer than 3 characters client-side and returns `[]` without calling
(`lib/fmcsa.ts:160-161`), and truncates the response to `limit` (default 15)
**after** the response arrives (`lib/fmcsa.ts:159, 172`) — i.e. there is **no
limit/paging query parameter**; the endpoint returns what it returns.

```bash
curl -sS \
  -H 'Accept: application/json' \
  "https://mobile.fmcsa.dot.gov/qc/services/carriers/name/KRYPTON%20LOGISTICS?webKey=$FMCSA_WEBKEY"
```

---

### 3. Response schema

#### The envelope — this is the part that bites

QCMobile wraps everything in a `content` key, and **the shape of `content`
differs between the two endpoints**.

**`/carriers/{usdot}` → `content` is an object with a single `carrier` key:**

```ts
const carrier = json?.content?.carrier;
```
— `lib/federal/qcmobile.ts:69`; identical at `lib/fmcsa.ts:143` and
`scripts/new-carrier.mjs:75`.

**`/carriers/name/{name}` → `content` is an ARRAY of those same wrappers:**

```ts
const content = res.json?.content;
if (!Array.isArray(content)) return [];
return content.map((entry: any) => entry?.carrier).filter(Boolean)…
```
— `lib/fmcsa.ts:166-171`

So: `{"content": {"carrier": {…}}}` for one, `{"content": [{"carrier": {…}}, …]}`
for many. Unwrap twice in both cases.

**A USDOT nobody holds returns HTTP 200 with `content: null`** — not a 404:

> "A number nobody holds comes back as 200 with content:null."
> — `lib/federal/qcmobile.ts:68`; stated again at `lib/fmcsa.ts:142`

Both callers therefore treat "no `content.carrier`" as a distinct *found
nothing* outcome, never as an error (`lib/federal/qcmobile.ts:70` →
`kind: 'EMPTY'`; `lib/fmcsa.ts:144` → `kind: 'NOT_FOUND'`).

**Unknown:** whether the envelope carries sibling keys beside `content`
(a `retrievalDate`, `_links`, etc.). No code in this repo reads anything other
than `content`, so the repo is not evidence either way. Inspect a live response
before relying on one.

#### Record size

The comments disagree by one and you should know which is which:

- **53** — `lib/federal/qcmobile.ts:178`, `lib/federal/enrich.ts:124`,
  `lib/federal/__tests__/enrich.test.ts:96`,
  `lib/federal/__tests__/portal.live.test.ts:146`, `lib/signup/contacts.ts:11`
  ("its carrier record has 53 fields … Checked directly against the live
  endpoint rather than assumed"). Internally consistent with
  `lib/federal/qcmobile.ts:8-9` (19 mapped for signup + "Thirty-four more are
  discarded" = 53) and `app/signup/actions.ts:490` ("nineteen of its
  fifty-three fields").
- **54** — `docs/FMCSA-PLAN.md:146` ("35 of its 54 fields are discarded").

Treat ~53 as the count and verify against a live response; the one-field
discrepancy is unresolved in the repo.

#### Fields the code reads

`lib/federal/qcmobile.ts` stores the **whole record** (minus `ein`) verbatim, so
"fields read" means fields some reader later pulls out of the stored payload.

##### Identity and address

| Field | Type as sent | Meaning | Read at |
|---|---|---|---|
| `dotNumber` | **number** in the repo's fixture (`3947827`), coerced with `String(raw.dotNumber ?? '')` | USDOT number | `lib/fmcsa.ts:74`; fixture `lib/federal/__tests__/enrich.test.ts:12` |
| `legalName` | string | Legal name on file | `lib/fmcsa.ts:75`, `lib/federal/probe.ts:194` |
| `dbaName` | string, **may be null** | Trading name from the MCS-150 | `lib/fmcsa.ts:76`, `lib/federal/qcmobile.ts:200` |
| `phyStreet` | string | Physical street | `lib/fmcsa.ts:77` |
| `phyCity` | string | Physical city | `lib/fmcsa.ts:78` |
| `phyState` | string | Physical state (2-letter) | `lib/fmcsa.ts:79` |
| `phyZipcode` | string | Physical ZIP | `lib/fmcsa.ts:80` |
| `carrierOperation` | **nested object**, may be `null` | `{ carrierOperationCode, carrierOperationDesc }` | `lib/federal/qcmobile.ts:194-197` |
| `carrierOperation.carrierOperationCode` | string `'A'`/`'B'`/`'C'` | `'A'` interstate; `'B'`/`'C'` are "the two intrastate flavours" (`lib/federal/qcmobile.ts:202`) | `lib/federal/qcmobile.ts:198` |
| `carrierOperation.carrierOperationDesc` | string | FMCSA's own wording, e.g. `'Intrastate Non-Hazmat'`, `'Interstate'` | `lib/federal/qcmobile.ts:201` |

##### Counts

| Field | Type as sent | Meaning | Read at |
|---|---|---|---|
| `totalPowerUnits` | string-or-number | Trucks as last self-reported on the MCS-150 | `lib/fmcsa.ts:81` |
| `totalDrivers` | **string that looks like a number** (fixtures use `'6'`, `'2'`, and `0`) | Drivers as last self-reported. The **only** federal source for this — see §5 | `lib/fmcsa.ts:82`, `lib/federal/refreshFleetCounts.ts:160`, SQL `db/migrations/0063_fleet_counts_live.sql:113` |

##### Flags — all `'Y'` / `'N'` strings, never booleans

| Field | Meaning | Read at |
|---|---|---|
| `allowedToOperate` | FMCSA's own summary verdict | `lib/fmcsa.ts:84` (via `yn()`), `lib/federal/changes.ts:462-463` |
| `mcs150Outdated` | FMCSA's view of whether the biennial update lapsed. **Inert — see §5** | `lib/fmcsa.ts:85` |
| `isPassengerCarrier` | Passenger carrier | `lib/federal/qcmobile.ts:204` |

The `'Y'`/`'N'` convention is explicit in the parser:

```ts
function yn(value: unknown): boolean | null {
  if (value === 'Y') return true;
  if (value === 'N') return false;
  return null;
}
```
— `lib/fmcsa.ts:60-64`

`statusCode` is a **three-state string**, not a Y/N flag: `'A'` active, `'I'`
inactive (`lib/fmcsa.ts:30-31`, rendered at `lib/federal/probe.ts:198-200`).

##### Safety rating

| Field | Type | Meaning | Read at |
|---|---|---|---|
| `safetyRating` | string or **null** — `'Satisfactory'` / `'Conditional'` / `'Unsatisfactory'` | Rating after a compliance review. Null = never rated (`lib/federal/qcmobile.ts:92`) | `lib/federal/qcmobile.ts:154`, `lib/federal/changes.ts:446-447` |
| `safetyRatingDate` | string, format **unverified** | When it was rated | `lib/federal/qcmobile.ts:155` |

##### ISS score

| Field | Type | Meaning | Read at |
|---|---|---|---|
| `issScore` | number in fixtures (`62`, `42`, `77`) | Inspection Selection System score, 0-100. "How likely this carrier is to be pulled in at a scale. High is bad and compounds" (`lib/federal/qcmobile.ts:96-100`) | `lib/federal/qcmobile.ts:156` |

##### Out-of-service rates — three families, one naming pattern

Built by string concatenation over the prefixes `vehicle`, `driver`, `hazmat`:

```ts
function rateOf(row: Row, prefix: string): OosRate {
  const rate = num(row[`${prefix}OosRate`]);
  const avg = num(row[`${prefix}OosRateNationalAverage`]);
  return {
    inspections: num(row[`${prefix}Insp`]),
    outOfService: num(row[`${prefix}OosInsp`]),
    …
```
— `lib/federal/qcmobile.ts:137-149`

So twelve fields:

| Field | Type in fixtures | Meaning |
|---|---|---|
| `vehicleInsp` / `driverInsp` / `hazmatInsp` | number | **All-time** inspection count of that kind |
| `vehicleOosInsp` / `driverOosInsp` / `hazmatOosInsp` | number | How many put something out of service |
| `vehicleOosRate` / `driverOosRate` / `hazmatOosRate` | number (`50`, `0`) | **Percent**, not a fraction — see §5 |
| `vehicleOosRateNationalAverage` / `driverOosRateNationalAverage` / `hazmatOosRateNationalAverage` | **string that looks like a number** — `'20.72'`, `'5.51'`, `'4.5'` | Percent |

The fixture mixes types on purpose: the carrier's own rate is a number, the
national average is a quoted string (`lib/federal/__tests__/qcmobile.test.ts:10-19`),
and the test asserts `nationalAverage: 20.72` comes out as a number
(`lib/federal/__tests__/qcmobile.test.ts:45`). **Coerce everything.**

| Field | Type | Meaning | Read at |
|---|---|---|---|
| `oosRateNationalAverageYear` | string, e.g. `'2009-2010'` | The year range the national averages are drawn from — "FMCSA's own caveat" (`lib/federal/qcmobile.ts:112`) | `lib/federal/qcmobile.ts:166` |

##### Crashes

| Field | Meaning | Read at |
|---|---|---|
| `crashTotal` | Total crashes on record | `lib/federal/qcmobile.ts:161`, `lib/fmcsa.ts:87` |
| `fatalCrash` | Fatal | `lib/federal/qcmobile.ts:162`, `lib/fmcsa.ts:88` |
| `injCrash` | Injury — note the abbreviation, **not** `injuryCrash` | `lib/federal/qcmobile.ts:163`, `lib/fmcsa.ts:89` |
| `towawayCrash` | Tow-away | `lib/federal/qcmobile.ts:164` |

##### Authority and insurance — present, stored, deliberately not classified

Recorded in `docs/FMCSA-PLAN.md:146-153` as verified on a real carrier:

| Field | Type | Meaning |
|---|---|---|
| `commonAuthorityStatus` | string `'A'`/`'I'` | Common authority (fixture `lib/federal/__tests__/changes.test.ts:372`, `:413`) |
| `contractAuthorityStatus` | string | Contract authority |
| `brokerAuthorityStatus` | string | Broker authority |
| `bipdInsuranceOnFile` | **string, in THOUSANDS of dollars** — verified value `"0"` | Liability on file |
| `bipdRequiredAmount` | **string, in THOUSANDS of dollars** — verified value `"750"` = $750,000 | Liability required |

> "`bipdInsuranceOnFile` vs `bipdRequiredAmount`, both in **thousands**. On-file
> below required, or `"0"`, is a live failure. Verified on a real carrier:
> `bipdInsuranceOnFile: "0"` against `bipdRequiredAmount: "750"`."
> — `docs/FMCSA-PLAN.md:150-153`

These are stored in the payload but no reader in this repo parses them — the
codebase takes authority and insurance from Socrata `6eyk-hxee` instead
(`docs/FMCSA-PLAN.md:140-142`, `lib/federal/changes.ts:432-435`).

##### Dropped

| Field | Fate |
|---|---|
| `ein` | Removed before storage. See §4. |

#### Realistic sample response

**Assembled from repo fixtures — not a live capture.** Field names are real and
cited above; values come from `lib/federal/__tests__/qcmobile.test.ts:4-28`,
`lib/federal/__tests__/enrich.test.ts:11-17`,
`lib/federal/__tests__/changes.test.ts:368-373`, `docs/FMCSA-PLAN.md:150-153`,
and (address only) the made-up sandbox carrier at `lib/fmcsa-sandbox.ts:52-55`.
The record is **truncated** — a real response carries ~53 fields.

```json
{
  "content": {
    "carrier": {
      "dotNumber": 3947827,
      "legalName": "KRYPTON LOGISTICS INC",
      "dbaName": "KRYPTON EXPRESS",
      "phyStreet": "4400 San Fernando Rd",
      "phyCity": "Glendale",
      "phyState": "CA",
      "phyZipcode": "91204",
      "carrierOperation": {
        "carrierOperationCode": "C",
        "carrierOperationDesc": "Intrastate Non-Hazmat"
      },
      "statusCode": "A",
      "allowedToOperate": "Y",
      "mcs150Outdated": "N",
      "isPassengerCarrier": "N",
      "totalPowerUnits": "8",
      "totalDrivers": "6",
      "safetyRating": "Conditional",
      "safetyRatingDate": "2024-03-01",
      "issScore": 62,
      "vehicleInsp": 6,
      "vehicleOosInsp": 3,
      "vehicleOosRate": 50,
      "vehicleOosRateNationalAverage": "20.72",
      "driverInsp": 8,
      "driverOosInsp": 0,
      "driverOosRate": 0,
      "driverOosRateNationalAverage": "5.51",
      "hazmatInsp": 0,
      "hazmatOosInsp": 0,
      "hazmatOosRate": 0,
      "hazmatOosRateNationalAverage": "4.5",
      "oosRateNationalAverageYear": "2009-2010",
      "crashTotal": 2,
      "fatalCrash": 0,
      "injCrash": 1,
      "towawayCrash": 1,
      "commonAuthorityStatus": "A",
      "bipdInsuranceOnFile": "0",
      "bipdRequiredAmount": "750",
      "ein": "<returned by FMCSA; this codebase strips it before storage>"
    }
  }
}
```

Empty result:

```json
{ "content": null }
```

#### Type hazards, summarised

**Strings that look like numbers.** `totalDrivers` (fixtures `'6'`, `'2'`),
`*OosRateNationalAverage` (`'20.72'`, `'5.51'`, `'4.5'`), `bipdInsuranceOnFile`
(`"0"`), `bipdRequiredAmount` (`"750"`), and probably `totalPowerUnits`. The
defensive coercer used everywhere:

```ts
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
```
— `lib/federal/qcmobile.ts:126-130`

Note it maps `''` → `null`, not `0`. The SQL path does the same job with
`nullif(regexp_replace(q.total_drivers, '\D', '', 'g'), '')::int`
(`db/migrations/0063_fleet_counts_live.sql:122`).

**`'Y'`/`'N'` flags:** `allowedToOperate`, `mcs150Outdated`, `isPassengerCarrier`.

**Codes, not flags:** `statusCode` (`'A'`/`'I'`), `carrierOperationCode`
(`'A'`/`'B'`/`'C'`), `*AuthorityStatus` (`'A'`/`'I'`).

**Nullable or absent:** `safetyRating` (null when never rated —
`lib/federal/__tests__/enrich.test.ts:15` uses `safetyRating: null`);
`dbaName`; the whole `carrierOperation` object
(`lib/federal/__tests__/qcmobile.test.ts:85` passes `carrierOperation: null`);
`isPassengerCarrier` can be **absent entirely**, which is why the reader
distinguishes `undefined` from `'N'`:

```ts
carriesPassengers: row.isPassengerCarrier === undefined ? null : row.isPassengerCarrier === 'Y',
```
— `lib/federal/qcmobile.ts:204`; asserted at `lib/federal/__tests__/qcmobile.test.ts:88-92`

---

### 4. What we extract, and why

#### The transport layer: `qcMobileCarrier()`

`lib/federal/qcmobile.ts:51-85`. Returns a three-way discriminated union
(`lib/federal/qcmobile.ts:39-42`):

```ts
export type QcResult =
  | { kind: 'ROWS'; rows: Row[]; ms: number }
  | { kind: 'EMPTY'; ms: number }
  | { kind: 'ERROR'; reason: string; ms: number };
```

It returns the record as an **array of one**:

> "An array of one, because `fmcsa_observations.payload` is an array for every
> source and a reader that has to special-case one of them will eventually
> forget to."
> — `lib/federal/qcmobile.ts:45-49`

#### The EIN is deliberately dropped

```ts
/** Fields removed before storing. Public, and still none of our business. */
const DROP = new Set(['ein']);
```
— `lib/federal/qcmobile.ts:36-37`

Applied on the way out, before anything is stored:

```ts
const clean: Row = {};
for (const [k, v] of Object.entries(carrier as Record<string, unknown>)) {
  if (!DROP.has(k)) clean[k] = v;
}
```
— `lib/federal/qcmobile.ts:72-75`

The rationale, in full:

> "THE EIN IS DROPPED, DELIBERATELY.
>
> The endpoint returns the carrier's federal tax identifier. Nothing in this
> product uses it, it is not a compliance fact, and storing an identifier we
> have no use for turns a public lookup into a liability. It is removed before
> the payload is written, not merely left unread."
> — `lib/federal/qcmobile.ts:25-30`

Restated in the migration: "The EIN it returns is NOT stored. It is a tax
identifier, nothing in the product uses it, and holding an identifier we have no
use for is a liability rather than an asset."
(`db/migrations/0062_qcmobile_source.sql:26-28`)

Everything **else** is stored verbatim. `DROP` is the only filter.

#### Derived shape 1: `safetyProfile(row)`

`lib/federal/qcmobile.ts:151-168`. Pure function over a stored payload row.

| Output | Source field | Transform |
|---|---|---|
| `rating` | `safetyRating` | `str()` — trim, `''` → `null` |
| `ratedOn` | `safetyRatingDate` | `str()`; **rendered raw**, never parsed |
| `issScore` | `issScore` | `num()` |
| `vehicle` / `driver` / `hazmat` | `{prefix}Insp`, `{prefix}OosInsp`, `{prefix}OosRate`, `{prefix}OosRateNationalAverage` | `rateOf()` — `num()` each, plus the derived `worseThanAverage` |
| `crashes.total/fatal/injury/towaway` | `crashTotal`, `fatalCrash`, `injCrash`, `towawayCrash` | `num()` |
| `nationalAverageYears` | `oosRateNationalAverageYear` | `str()` |

`worseThanAverage` is a **conjunction, not a comparison with a default**:

```ts
worseThanAverage: rate !== null && avg !== null && rate > avg,
```
— `lib/federal/qcmobile.ts:147`, with the reasoning at `:145-146`: "Both must be
known. 'Worse than average' is a claim, and an unknown is not evidence for it."
Asserted both directions at `lib/federal/__tests__/qcmobile.test.ts:49-55`.

Lands in `FederalReport.safety` (`lib/federal/report.ts:379`), rendered at
`app/reports/FederalReport.tsx:459-535` and `app/watch/page.tsx:400-490`.

#### Derived shape 2: `qcIdentity(row)`

`lib/federal/qcmobile.ts:192-206`.

| Output | Source field | Transform |
|---|---|---|
| `dbaName` | `dbaName` | `str()` |
| `operation` | `carrierOperation.carrierOperationDesc` | `str()` |
| `interstate` | `carrierOperation.carrierOperationCode` | `code === null ? null : code === 'A'` — tri-state, never false-by-default |
| `carriesPassengers` | `isPassengerCarrier` | `undefined ? null : === 'Y'` |

Lands in `FederalReport.operation` (`lib/federal/report.ts:380`). The report
prefers QCMobile's description over the census code because it is more specific
(`app/reports/FederalReport.tsx:223-225`).

#### Derived shape 3: `toCarrier(raw)` — the signup/admin path

`lib/fmcsa.ts:72-96` maps the raw record down to 19 fields for "is this a real
carrier" (`lib/federal/qcmobile.ts:8`). Feeds signup verification
(`app/signup/actions.ts:110`), the public `/check` tool
(`app/check/actions.ts:89`), the admin importer (`app/admin/actions.ts:128, 194`)
and the admin probe (`lib/federal/probe.ts:164`).

#### The fill-only-if-blank rule

This is the load-bearing policy. `lib/federal/enrich.ts`.

**The rule:**

> "An observation may fill a field the carrier has not supplied WHEN FMCSA IS
> THE AUTHORITY FOR THAT FACT. It may never overwrite something they entered,
> and never silently satisfy an obligation they are responsible for proving."
> — `lib/federal/enrich.ts:14-16`

**Exactly three columns qualify** (`lib/federal/enrich.ts:18-24`), and "all three
are FMCSA reporting on a filing the carrier made to FMCSA":

| Column | Source |
|---|---|
| `dba` | QCMobile `dbaName`, via `qcIdentity()` |
| `mc_number` | **Not QCMobile** — Socrata `6eyk-hxee.docket_number`, in a separate function |
| `phone` | **Not QCMobile** — census `az4n-8mr2.phone` |

The implementation is literally a blank check:

```ts
// Blank only. A carrier who typed something has said what they want called.
if (!have.dba && identity?.dbaName) patch.dba = identity.dbaName;
```
— `lib/federal/enrich.ts:105-106`; enforced by
`lib/federal/__tests__/enrich.test.ts:87-93` ("never overwrites a DBA the
carrier entered" — `filled` is `[]` and no update is issued).

Nothing is written when nothing changed: `if (filled.length === 0) return …`
(`lib/federal/enrich.ts:114`).

**`mc_number` comes from a different source entirely.** QCMobile "does not
publish one at all" (`lib/federal/enrich.ts:153`), so
`fillMcNumberFromCarrierObservation()` reads the stored `carrier` (6eyk-hxee)
observation and `normaliseDocket(payload[0]?.docket_number)`
(`lib/federal/enrich.ts:155-184`). Same blank-only guard at
`lib/federal/enrich.ts:164`.

**What does NOT qualify, and why:**

- **Physical address** — "A federal address that disagrees with the carrier's
  own is evidence their MCS-150 is stale — which is a finding worth money…
  Overwriting ours with FMCSA's would leave both records agreeing on something
  out of date and destroy the only signal that anything was wrong."
  (`lib/federal/enrich.ts:27-31`)
- **Power units** — compared against the roster in
  `lib/federal/refreshFleetCounts.ts`, "never reconciled into it"
  (`lib/federal/enrich.ts:33-35`).
- **`hauls_placarded_hazmat` and `carries_passengers`** — "QCMobile knows both.
  Those two only ever ADD obligations (db/0053), so a federal 'N' must not be
  able to switch one off — and a federal 'Y' against a carrier who said no is a
  conversation, not a silent edit." (`lib/federal/enrich.ts:36-40`)
  *(The passenger field is `isPassengerCarrier`. The QCMobile field name for
  placarded hazmat is **not established anywhere in this repo** — verify against
  a live response.)*

#### The one column QCMobile owns outright: `fmcsa_drivers`

> "Drivers come from QCMobile and ONLY from QCMobile. The census has no
> total-driver column — only total_intrastate_drivers, which is 0 for most
> interstate carriers. Labelling that 'drivers' would tell a working interstate
> fleet that FMCSA has them at zero."
> — `lib/federal/refreshFleetCounts.ts:141-146`

Read from the stored observation, not from a fresh fetch
(`lib/federal/refreshFleetCounts.ts:30-32, 147-168`); the backfill does the same
in SQL (`db/migrations/0063_fleet_counts_live.sql:109-124`). A zero or missing
count is skipped, never written — "a QCMobile blip returning 0 would therefore
delete…" (`lib/federal/refreshFleetCounts.ts:60`,
`lib/federal/__tests__/refreshFleetCounts.test.ts:67`).

---

### 5. Gotchas

#### 1. There is no `phone` field. There was a bug about it. **(Verified.)**

Confirmed by reading every `.phone` access in `lib/`, `app/reports` and
`app/watch`: no code path reads `phone` off a QCMobile record today. The bug and
its fix are documented in three independent places:

> "NO PHONE HERE. The first version of this read row.phone, which does not
> exist: QCMobile returns fifty-three fields and none of them is a telephone
> number. The code was harmless and permanently dead, which is worse than
> absent — it reads as a capability. The census (az4n-8mr2) does publish
> `phone`, and that is where it is read from."
> — `lib/federal/qcmobile.ts:177-181`

The census is now the source (`lib/federal/enrich.ts:129-146`,
`phoneFromCensus()`), and there is a regression test that feeds a QCMobile row
carrying a decoy `phone: '9995550000'` and asserts the census value wins:

```ts
qcMobileCarrier.mockResolvedValue({ kind: 'ROWS', rows: [{ ...CARRIER, phone: '9995550000' }], ms: 10 });
…
expect(updates[0]).toMatchObject({ phone: '7124392831' });
```
— `lib/federal/__tests__/enrich.test.ts:100-110`

And a live test guards the census column it depends on: "The census is the ONLY
source with a telephone number. QCMobile returns fifty-three fields and none of
them is one" (`lib/federal/__tests__/portal.live.test.ts:145-149`).

Independent corroboration from a different module, checked against the live
endpoint rather than assumed: "lib/fmcsa.ts is the wrong source: its carrier
record has 53 fields and not one of them is a contact. Checked directly against
the live endpoint" (`lib/signup/contacts.ts:11-13`).

#### 2. There is no MC / docket number either

"QCMobile does not publish one at all" (`lib/federal/enrich.ts:153`). Use
Socrata `6eyk-hxee.docket_number`.

#### 3. `mcs150Outdated` is inert — do not build a cross-check on it

> "**QCMobile's `mcs150Outdated` is inert.** It reads `'N'` for every carrier
> sampled, including ones years past their window — 0 of 20. Not usable as a
> cross-check. `az4n-8mr2.mcs150_date` is the only real signal."
> — `docs/HANDOFF.md:170-173`; the same finding with two named carriers at
> `docs/FMCSA-PLAN.md:74-77`; and a warning at the point of temptation,
> `lib/regulations/mcs150.ts:108`.

It is still rendered in the admin probe and the public `/check` tool
(`lib/federal/probe.ts:205-213`, `app/check/actions.ts:111-117`) — as FMCSA's
stated verdict, not as a working signal.

#### 4. OOS rate semantics: **percent, not a fraction**

The fixture pairs `vehicleOosInsp: 3` against `vehicleInsp: 6` with
`vehicleOosRate: 50` (`lib/federal/__tests__/qcmobile.test.ts:8-10`) — 3/6 is
0.5, and the field says `50`. Every renderer appends `%` without scaling:

- `app/watch/page.tsx:76` — `const pct = (n) => n === null ? '—' : `${n.toFixed(1)}%``
- `app/reports/FederalReport.tsx:498-506` — `${r.rate.toFixed(1)}%`
- `app/check/actions.ts:145` — `` `Your vehicle out-of-service rate is ${v}%` ``

So do **not** multiply by 100.

The national averages are on the same scale — `'20.72'` vehicle, `'5.51'` driver
(`lib/federal/__tests__/qcmobile.test.ts:11, 15`), consistent with FMCSA's
published national OOS percentages.

**The comparison is the fact, not the rate.** From the test:

> "A rate on its own means nothing — 20% is unremarkable for vehicles and
> terrible for drivers. The comparison is the fact."
> — `lib/federal/__tests__/qcmobile.test.ts:39-42`

Hence `worseThanAverage` requires both operands known
(`lib/federal/qcmobile.ts:147`).

#### 5. The national averages are ancient, and FMCSA says so

`oosRateNationalAverageYear` is `'2009-2010'` in the fixture
(`lib/federal/__tests__/qcmobile.test.ts:24`). The product surfaces the caveat
rather than hiding it: "National averages are FMCSA's, drawn from
{report.safety.nationalAverageYears}" (`app/reports/FederalReport.tsx:507-511`;
type comment at `lib/federal/qcmobile.ts:112`). Carry this through to your UI.

#### 6. Inspection counts are ALL-TIME, not windowed

`vehicleInsp` / `driverInsp` are lifetime totals, and the product relies on that
to distinguish "we have not looked" from "nothing recently":

> "QCMobile settles it. It reports an ALL-TIME inspection count, so a carrier
> with inspections on record but none in the window can be told the true thing."
> — `app/watch/page.tsx:511-514`

And they are **not additive** across families — "an inspection can cover both a
vehicle and a driver, so these are not additive — the larger is the safe floor"
(`app/watch/page.tsx:520-524`).

#### 7. `safetyRatingDate` format is unverified

`str()` trims it and every consumer renders it raw
(`app/watch/page.tsx:419`, `app/reports/FederalReport.tsx:459-462`). The only
sample in the repo is a unit-test literal `'2024-03-01'`
(`lib/federal/__tests__/qcmobile.test.ts:6`), which is **not** evidence of the
wire format. Note that sibling FMCSA sources use wildly different date formats
(`az4n-8mr2.mcs150_date` is `YYYYMMDD HHMM`, `qh9u-swkp` is `MM/DD/YYYY` —
`docs/FMCSA-PLAN.md:62`, `lib/federal/__tests__/portal.live.test.ts:157-166`).
**Verify before parsing.**

#### 8. Staleness

The product never calls QCMobile to render a page. Reads come from stored
observations:

> "READ FROM OBSERVATIONS, NOT FROM FMCSA … Every section carries the date it
> was observed, and that date is rendered — an undated federal fact is
> indistinguishable from a live check, and if the sweep silently stopped running
> a stale record would look current forever."
> — `lib/federal/report.ts:34-39`

Refresh cadence: once at signup (`app/signup/actions.ts:495-503`) and weekly on
Mondays (`if (federalDay.getUTCDay() === 1)`,
`app/api/cron/digest/route.ts:525`) — "the facts it carries (safety rating, ISS
score, operation) move on the scale of a compliance review, not a day"
(`app/api/cron/digest/route.ts:521-523`).

A separate distinction the report makes: **never checked ≠ found nothing**
(`lib/federal/report.ts:340-346`, `neverChecked` at `:284` and `:347`).

#### 9. Error handling

Four outcomes, never collapsed:

| Condition | Result | Line |
|---|---|---|
| No key | `ERROR 'FMCSA_WEBKEY is not set.'` | `lib/federal/qcmobile.ts:56` |
| No digits in input | `ERROR 'Not a USDOT number.'` | `:58` |
| Non-2xx | `ERROR 'HTTP {status}.'` | `:65` |
| 200 but `content.carrier` missing/not an object | `EMPTY` | `:69-70` |
| Timeout | `ERROR 'No answer within 15s.'` | `:81` |
| Other throw | `ERROR {e.message}` | `:81` |

Every branch carries `ms` (elapsed), stamped by a closure created before the
call (`lib/federal/qcmobile.ts:53-54`).

**The critical discipline: never confuse "we could not ask" with "you do not
exist."**

> "We could not ask. Distinct from NOT_FOUND: never tell a carrier their USDOT
> does not exist because our network call failed."
> — `lib/fmcsa.ts:50-51`

This propagates all the way up: `enrichFromFederal` returns
`{ filled: [], error: res.reason }` on ERROR but `{ filled: [], error: null }` on
EMPTY (`lib/federal/enrich.ts:70-71`), and **on ERROR nothing is stored** — "so
no observation claims we checked"
(`lib/federal/__tests__/enrich.test.ts:119-126`).

Every call site wraps the whole thing in try/catch so a QCMobile outage cannot
take down the cron that sends the alerts customers pay for
(`app/signup/actions.ts:495-503`, `app/api/cron/digest/route.ts:526-536`).

#### 10. `lib/fmcsa.ts` intercepts sandbox USDOTs; `lib/federal/qcmobile.ts` does not

`lookupByUsdot()` short-circuits on fictional `999xxxxx` numbers before the
fetch (`lib/fmcsa.ts:136-137`, `lib/fmcsa-sandbox.ts`). `qcMobileCarrier()` has
no such branch — it will hit the live endpoint for any digit string. If you port
a sandbox affordance, put it at one chokepoint, not two
(`lib/fmcsa.ts:129-135`).

---

### 6. How it fits the observation/alert pipeline

Every federal source writes into one table, `fmcsa_observations`, keyed
`(company_id, source, observed_on)` with a JSON array `payload` and a `digest`.
QCMobile's source enum value is **`'qcmobile'`** — added as the seventh source by
`db/migrations/0062_qcmobile_source.sql:43` and declared in TypeScript at
`lib/federal/sweep.ts:61`. `enrichFromFederal()` upserts the record
`{ company_id, source: 'qcmobile', observed_on: today, payload: res.rows,
digest: digestOf(res.rows) }` with `onConflict: 'company_id,source,observed_on',
ignoreDuplicates: true` (`lib/federal/enrich.ts:80-91`) — and does so **before
and independently of** any column fill, because "the observation is the
evidence; the column is a convenience derived from it, and the evidence must not
depend on the convenience succeeding" (`lib/federal/enrich.ts:75-79`). Nightly,
`proposeFederalAlerts()` pulls the newest **two** observations per source and
hands the pair to `classify()` (`lib/federal/alerts.ts:87-150`); a first
observation is never a change (`lib/federal/alerts.ts:137-144`,
`lib/federal/changes.ts:29-34`). `classifyQcMobile()`
(`lib/federal/changes.ts:440-475`) emits exactly two alerts — a safety-rating
change (`alarm` when the new rating matches `/conditional|unsatisfactory|unfit/i`,
else `notice`; keys `fmcsa:safety_rating.downgraded` /
`fmcsa:safety_rating.changed`) and an `allowedToOperate` flip from `'Y'` to
`'N'` (`alarm`, key `fmcsa:operate.not_allowed`). It is deliberately **silent**
on the ISS score ("moves with every inspection … belongs on the report, where an
owner can look at it, not in an inbox" — `lib/federal/changes.ts:436-438`) and on
authority/insurance, which 6eyk-hxee already classifies — "duplicating them would
send a carrier two emails about one event" (`lib/federal/changes.ts:432-435`).
The same stored payload is read non-destructively by
`buildFederalReport()` into `report.safety` and `report.operation`
(`lib/federal/report.ts:379-380`) and by `refreshFleetCounts()` for
`fmcsa_drivers` (`lib/federal/refreshFleetCounts.ts:147-168`).

---

### Appendix: complete file map

| File | Role |
|---|---|
| `lib/fmcsa.ts` | Both endpoints; 19-field mapping for signup/admin/`/check`; 1-hour fetch cache; sandbox interception |
| `lib/federal/qcmobile.ts` | `/carriers/{dot}` only; stores the full record minus `ein`; `safetyProfile()`, `qcIdentity()` |
| `lib/federal/enrich.ts` | Stores the observation; the fill-only-if-blank rule; census phone fallback |
| `lib/federal/changes.ts:440-475` | `classifyQcMobile()` |
| `lib/federal/alerts.ts` | Newest-two-per-source pairing, alert construction, the federal email |
| `lib/federal/report.ts:379-380` | Feeds `report.safety` / `report.operation` |
| `lib/federal/refreshFleetCounts.ts:147-168` | `totalDrivers` → `companies.fmcsa_drivers` |
| `lib/federal/probe.ts:162-228` | Admin diagnostic panel |
| `lib/federal/sweep.ts:49-61, 138-143` | Source enum; the type-level exclusion from batching |
| `scripts/new-carrier.mjs:66-81` | Standalone CLI call — the smallest complete example in the repo |
| `db/migrations/0062_qcmobile_source.sql` | Source enum + the EIN rationale |
| `db/migrations/0063_fleet_counts_live.sql:109-124` | `totalDrivers` backfill in SQL |
| `.env.example:20-27` | Key provisioning and the no-`NEXT_PUBLIC_` rule |
| `lib/federal/__tests__/qcmobile.test.ts` | Best evidence of field names and wire types |
| `lib/federal/__tests__/enrich.test.ts` | Fill rules; the phone regression test |
| `lib/federal/__tests__/changes.test.ts:363-416` | Alert classification |


---

## 3. Stripe — api.stripe.com

Source repo: `/Users/bedopapajanian/Work/fleetview-legacy`. Every claim below cites
`path/file.ts:line`. Nothing here was verified against the live Stripe API — no network
calls were made. Secrets are redacted as `sk_test_...`.

---

### 1. Overview

**What Stripe does in this app.** One product, one recurring price, billed **monthly per
active truck**, sold through **hosted Checkout**, managed by the customer through the
**hosted Customer Portal**. Quantity on the subscription equals the carrier's active
vehicle count. The free trial is *owned by the application* (a `date` column), not by
Stripe — Stripe is told about it only as a `trial_end` on the subscription created at
checkout (`lib/billing/stripe.ts:200-208`).

Concretely, Stripe is used for:

| Concern | Where |
| --- | --- |
| Customer records (one per carrier) | `lib/billing/stripe.ts:150-168` |
| Hosted Checkout (subscription mode) | `lib/billing/stripe.ts:183-231` |
| Hosted Customer Portal | `lib/billing/stripe.ts:245-252` |
| Quantity sync (trucks → subscription quantity) | `lib/billing/quantitySync.ts:38-116` |
| Immediate cancellation on account deletion | `lib/billing/stripe.ts:272-292` |
| Webhook ingestion + DB mirroring | `app/api/stripe/webhook/route.ts`, `lib/billing/webhookHandler.ts` |
| Nightly drift reconciliation (both directions) | `lib/billing/reconcile.ts:112-223` |
| Price/product creation (one-off script) | `scripts/stripe-setup.mjs` |
| Lifecycle proof with a Stripe test clock | `scripts/stripe-lifecycle.mjs` |

**API version pinned:** `2026-07-29.dahlia` — `lib/billing/stripe.ts:135`, sent as the
`Stripe-Version` header on every request (`lib/billing/stripe.ts:92`). The comment there
records a real incident: the constant previously said `2025-08-27.basil` while the account
and CLI were on `2026-07-29.dahlia`, which would have made outbound calls and inbound
webhooks disagree about where `current_period_end` lives
(`lib/billing/stripe.ts:122-134`).

**Why no SDK.** Stated verbatim at `lib/billing/stripe.ts:4-26`: the repo holds a
deliberate eight-runtime-dependency budget, Resend (the other paid third party) is called
the same way, and the SDK would be "a large dependency for form encoding and a fetch
call." The one thing the SDK genuinely buys — webhook signature verification — is
hand-written in `lib/billing/stripeWebhook.ts` and tested adversarially. `package.json`
confirms it: dependencies are `@supabase/ssr`, `@supabase/supabase-js`, `drizzle-orm`,
`next`, `postgres`, `react`, `react-dom`, `server-only`. `grep -c '"stripe"'
package-lock.json` returns `0`.

---

### 2. The HTTP client

**File:** `lib/billing/stripe.ts`.

- **Base URL:** `https://api.stripe.com/v1/` + `path` (`lib/billing/stripe.ts:97`). The
  `path` argument may itself carry a query string — `reconcile.ts` passes
  `subscriptions?status=all&limit=100` (`lib/billing/reconcile.ts:79-80`).
- **Auth:** `Authorization: Bearer ${secretKey}` (`lib/billing/stripe.ts:86`), the key
  coming from `stripeEnv()`.
- **Content type:** `application/x-www-form-urlencoded` (`lib/billing/stripe.ts:87`).
- **Version:** `Stripe-Version: STRIPE_API_VERSION` on every call
  (`lib/billing/stripe.ts:92`).
- **Idempotency:** `Idempotency-Key` header, set only when a caller supplies one
  (`lib/billing/stripe.ts:94`).
- **Timeout:** `AbortSignal.timeout(20_000)` — 20 seconds (`lib/billing/stripe.ts:103`).
- **Cache:** `cache: 'no-store'` (`lib/billing/stripe.ts:104`).
- **Retry:** **none.** There is no retry loop anywhere in the client. A failed call returns
  `{ ok: false, error }`; the daily cron's reconcile pass is the de-facto retry
  (`lib/billing/reconcile.ts:5-37`).
- **Method inference:** `init.method ?? (init.body ? 'POST' : 'GET')`
  (`lib/billing/stripe.ts:84`).
- **Errors never throw**, because every caller is a server action rendering into a payment
  flow (`lib/billing/stripe.ts:54-60`). Error logging is deliberately `method`, `path`,
  status and Stripe's `error.code` only — never headers, never the request body
  (`lib/billing/stripe.ts:110-111`, rationale at `lib/billing/stripe.ts:20-25`).

#### 2.1 The encoder (verbatim)

Stripe wants PHP-style bracket notation, including for nested arrays. This is the whole
encoder — `lib/billing/stripe.ts:28-50`:

```ts
/** Stripe wants PHP-style bracket notation, including for nested arrays. */
export function formEncode(
  obj: Record<string, unknown>,
  prefix = '',
  out = new URLSearchParams(),
): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) =>
        typeof item === 'object' && item !== null
          ? formEncode(item as Record<string, unknown>, `${key}[${i}]`, out)
          : out.append(`${key}[${i}]`, String(item)),
      );
    } else if (typeof v === 'object') {
      formEncode(v as Record<string, unknown>, key, out);
    } else {
      out.append(key, String(v));
    }
  }
  return out;
}
```

Behaviour pinned by `lib/billing/__tests__/stripeClient.test.ts`:

| Input | Encoded (decoded for readability) | Test |
| --- | --- | --- |
| `{ customer: 'cus_1', quantity: 8 }` | `customer=cus_1&quantity=8` | `:11-15` |
| `{ metadata: { company_id: 'co_1', usdot: '99900001' } }` | `metadata[company_id]=co_1&metadata[usdot]=99900001` | `:17-21` |
| `{ line_items: [{ price: 'price_1', quantity: 8 }] }` | `line_items[0][price]=price_1&line_items[0][quantity]=8` | `:23-28` |
| `{ expand: ['customer','subscription'] }` | `expand[0]=customer&expand[1]=subscription` | `:30-33` |
| `{ subscription_data: { metadata: { company_id: 'co_1' } } }` | `subscription_data[metadata][company_id]=co_1` | `:35-38` |
| `{ a: 1, b: null, c: undefined, d: '' }` | `a=1&d=` (null/undefined dropped, empty string kept) | `:45-50` |
| `{ allow_promotion_codes: false, quantity: 0 }` | `allow_promotion_codes=false&quantity=0` | `:52-56` |
| tier ladder | `tiers[0][up_to]=3`, `tiers[1][up_to]=inf`, … | `:62-75` |

The `null`/`undefined`-drop matters: Stripe stores the literal string `"undefined"` if you
let it through (`lib/billing/__tests__/stripeClient.test.ts:40-44`).

#### 2.2 The helper signature (verbatim)

`lib/billing/stripe.ts:52` and `lib/billing/stripe.ts:61-74`:

```ts
export type StripeResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function stripeRequest<T>(
  path: string,
  init: {
    method?: 'GET' | 'POST' | 'DELETE';
    body?: Record<string, unknown>;
    /**
     * Stripe deduplicates POSTs carrying the same key for 24 hours. Supply one
     * for anything that creates or charges: a carrier double-clicking Subscribe
     * on a slow connection would otherwise open two checkout sessions, and a
     * retried quantity change would otherwise apply twice.
     */
    idempotencyKey?: string;
  } = {},
): Promise<StripeResult<T>> {
```

Error path: if `stripeEnv()` throws (misconfiguration) the message is returned verbatim as
`{ ok: false, error }` rather than surfacing as a Stripe failure
(`lib/billing/stripe.ts:75-82`).

---

### 3. Every Stripe endpoint called

#### 3.1 Endpoint table — application code (`lib/billing/`)

| # | Method | Path | Purpose | Exact parameters sent | Idempotency-Key |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/v1/customers` | Create the carrier's Stripe customer, once | `email`, `name`, `metadata[company_id]`, `metadata[usdot]` | `customer:${companyId}` |
| 2 | POST | `/v1/checkout/sessions` | Hosted subscription checkout | `mode=subscription`, `customer`, `line_items[0][price]`, `line_items[0][quantity]`, `success_url`, `cancel_url`, `subscription_data[metadata][company_id]`, optional `subscription_data[trial_end]`, `metadata[company_id]`, `allow_promotion_codes=false` | none |
| 3 | POST | `/v1/billing_portal/sessions` | Cancel / change card / invoices | `customer`, `return_url` | none |
| 4 | GET | `/v1/subscriptions/{id}` | Read status, quantity, item id | none (path only) | n/a |
| 5 | POST | `/v1/subscriptions/{id}` | Change billed quantity | `items[0][id]`, `items[0][quantity]`, `proration_behavior=none` | `qty:${subscriptionId}:${quantity}` |
| 6 | DELETE | `/v1/subscriptions/{id}` | Cancel immediately (account deletion) | none | none |
| 7 | GET | `/v1/subscriptions?status=all&limit=100[&starting_after=…]` | List every subscription, for orphan detection | query string in the path | n/a |

Sources: 1 `lib/billing/stripe.ts:150-168`; 2 `lib/billing/stripe.ts:183-231`;
3 `lib/billing/stripe.ts:245-252`; 4 `lib/billing/stripe.ts:306-308`;
5 `lib/billing/stripe.ts:317-334`; 6 `lib/billing/stripe.ts:272-292`;
7 `lib/billing/reconcile.ts:74-83`.

#### 3.2 Endpoint table — operational scripts

These are separate hand-rolled clients, not `stripeRequest`.

| Method | Path | Purpose | Parameters | Source |
| --- | --- | --- | --- | --- |
| POST | `/v1/products` | Create the FleetView product | `name`, `description` | `scripts/stripe-setup.mjs:70-74,155` |
| POST | `/v1/prices` | Create the 10-tier volume price | `product`, `currency=usd`, `recurring[interval]=month`, `billing_scheme=tiered`, `tiers_mode=volume`, `lookup_key=fleetview_monthly_per_truck`, `tiers[n][up_to|unit_amount|flat_amount]` | `scripts/stripe-setup.mjs:158-166` |
| POST | `/v1/test_helpers/test_clocks` | Create a test clock | `frozen_time`, `name` | `scripts/stripe-lifecycle.mjs:162-165` |
| GET | `/v1/test_helpers/test_clocks/{id}` | Poll until `status === 'ready'` | none | `scripts/stripe-lifecycle.mjs:140` |
| POST | `/v1/test_helpers/test_clocks/{id}/advance` | Advance time | `frozen_time` | `scripts/stripe-lifecycle.mjs:136` |
| DELETE | `/v1/test_helpers/test_clocks/{id}` | Cleanup | none | `scripts/stripe-lifecycle.mjs:252` |
| POST | `/v1/customers` | Test customer bound to the clock | `test_clock`, `email`, `name`, `metadata[company_id]` | `scripts/stripe-lifecycle.mjs:170-175` |
| POST | `/v1/payment_methods` | Test card | `type=card`, `card[token]=tok_visa` | `scripts/stripe-lifecycle.mjs:178` |
| POST | `/v1/payment_methods/{id}/attach` | Attach card | `customer` | `scripts/stripe-lifecycle.mjs:179`, `:214-216` |
| POST | `/v1/customers/{id}` | Set default payment method | `invoice_settings[default_payment_method]` | `scripts/stripe-lifecycle.mjs:180,220,228` |
| POST | `/v1/subscriptions` | Create a trialing subscription directly | `customer`, `items[0][price]`, `items[0][quantity]`, `trial_end`, `metadata[company_id]` | `scripts/stripe-lifecycle.mjs:182-187` |
| GET | `/v1/invoices?customer=…&status=open&limit=1` | Find the open invoice | query only | `scripts/stripe-lifecycle.mjs:231` |
| POST | `/v1/invoices/{id}/pay` | Force payment | `{}` | `scripts/stripe-lifecycle.mjs:232` |
| DELETE | `/v1/subscriptions/{id}` | Cleanup | none | `scripts/stripe-lifecycle.mjs:236` |

#### 3.3 curl + sample responses

All curls use `$STRIPE_SECRET_KEY` and the pinned version. Responses show **only the
fields the code reads** plus enough context to be realistic; they are illustrative, not
captured from a live call.

##### (1) Create customer

```bash
curl https://api.stripe.com/v1/customers \
  -u "$STRIPE_SECRET_KEY:" \
  -H "Stripe-Version: 2026-07-29.dahlia" \
  -H "Idempotency-Key: customer:0f1c9e9a-1111-4a2b-8c33-aaaaaaaaaaaa" \
  -d email="owner@ararattrucking.com" \
  -d name="ARARAT TRUCKING LLC" \
  -d "metadata[company_id]=0f1c9e9a-1111-4a2b-8c33-aaaaaaaaaaaa" \
  -d "metadata[usdot]=99900001"
```

The app sends `Authorization: Bearer …` rather than `-u` — equivalent for Stripe.

```json
{
  "id": "cus_QxAbC123DeFgHi",
  "object": "customer",
  "email": "owner@ararattrucking.com",
  "name": "ARARAT TRUCKING LLC",
  "metadata": { "company_id": "0f1c9e9a-1111-4a2b-8c33-aaaaaaaaaaaa", "usdot": "99900001" }
}
```

Code reads **`id` only** — `StripeCustomer = { id: string }`
(`lib/billing/stripe.ts:141`), stored into `companies.stripe_customer_id`
(`app/settings/billing/actions.ts:75-78`).

##### (2) Create checkout session

```bash
curl https://api.stripe.com/v1/checkout/sessions \
  -u "$STRIPE_SECRET_KEY:" \
  -H "Stripe-Version: 2026-07-29.dahlia" \
  -d mode=subscription \
  -d customer=cus_QxAbC123DeFgHi \
  -d "line_items[0][price]=price_1U7LnlBWxY0en8Re5SYNmjyw" \
  -d "line_items[0][quantity]=8" \
  -d success_url="https://fleetview.app/settings/billing?paid=1" \
  -d cancel_url="https://fleetview.app/settings/billing?cancelled=1" \
  -d "subscription_data[metadata][company_id]=0f1c9e9a-1111-4a2b-8c33-aaaaaaaaaaaa" \
  -d "subscription_data[trial_end]=1789430399" \
  -d "metadata[company_id]=0f1c9e9a-1111-4a2b-8c33-aaaaaaaaaaaa" \
  -d allow_promotion_codes=false
```

`trial_end` is omitted entirely when the trial is absent or ends within 48 hours —
`const minimum = Math.floor(Date.now() / 1000) + 48 * 3600;` and
`args.trialEndsAt && args.trialEndsAt > minimum ? args.trialEndsAt : null`
(`lib/billing/stripe.ts:207-208`, spread at `:221`). The value passed in is the trial's
calendar date at `T23:59:59Z` (`app/settings/billing/actions.ts:146-148`).

```json
{
  "id": "cs_test_a1B2c3D4e5F6g7",
  "object": "checkout.session",
  "url": "https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4e5F6g7#fidkd…",
  "mode": "subscription",
  "customer": "cus_QxAbC123DeFgHi"
}
```

Code reads **`url`** (and types `id`) — `CheckoutSession = { id: string; url: string | null }`
(`lib/billing/stripe.ts:174`); a null `url` is treated as an error
(`app/settings/billing/actions.ts:154`).

##### (3) Create portal session

```bash
curl https://api.stripe.com/v1/billing_portal/sessions \
  -u "$STRIPE_SECRET_KEY:" \
  -H "Stripe-Version: 2026-07-29.dahlia" \
  -d customer=cus_QxAbC123DeFgHi \
  -d return_url="https://fleetview.app/settings/billing"
```

```json
{
  "id": "bps_1QabcdEFGHijkl",
  "object": "billing_portal.session",
  "url": "https://billing.stripe.com/p/session/test_YWNjdF8xUj…",
  "return_url": "https://fleetview.app/settings/billing"
}
```

Code reads **`url`** — `PortalSession = { url: string }` (`lib/billing/stripe.ts:237`),
redirected to at `app/settings/billing/actions.ts:188`.

##### (4) Retrieve subscription

```bash
curl -G "https://api.stripe.com/v1/subscriptions/sub_1QabcXYZ" \
  -u "$STRIPE_SECRET_KEY:" \
  -H "Stripe-Version: 2026-07-29.dahlia"
```

```json
{
  "id": "sub_1QabcXYZ",
  "object": "subscription",
  "status": "active",
  "cancel_at_period_end": false,
  "cancel_at": null,
  "items": {
    "object": "list",
    "data": [
      {
        "id": "si_QxYz001",
        "quantity": 8,
        "current_period_end": 1792108799,
        "price": { "id": "price_1U7LnlBWxY0en8Re5SYNmjyw" }
      }
    ]
  }
}
```

Declared shape — `lib/billing/stripe.ts:298-304`:

```ts
export type StripeSubscription = {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: number;
  items: { data: { id: string; quantity: number }[] };
};
```

Actually read: `status` and `items.data[0].quantity` in reconcile
(`lib/billing/reconcile.ts:167,178`); `items.data[0].id` and `.quantity` in the quantity
sync (`lib/billing/quantitySync.ts:98-101`). Note the type declares a top-level
`current_period_end` that this API version may not populate — see Gotchas.

##### (5) Update quantity

```bash
curl https://api.stripe.com/v1/subscriptions/sub_1QabcXYZ \
  -u "$STRIPE_SECRET_KEY:" \
  -H "Stripe-Version: 2026-07-29.dahlia" \
  -H "Idempotency-Key: qty:sub_1QabcXYZ:9" \
  -d "items[0][id]=si_QxYz001" \
  -d "items[0][quantity]=9" \
  -d proration_behavior=none
```

Response: same `subscription` shape as (4) with `items.data[0].quantity` now `9`. The
caller checks only `ok` and then mirrors the number locally
(`lib/billing/quantitySync.ts:107-115`).

##### (6) Cancel immediately

```bash
curl -X DELETE https://api.stripe.com/v1/subscriptions/sub_1QabcXYZ \
  -u "$STRIPE_SECRET_KEY:" \
  -H "Stripe-Version: 2026-07-29.dahlia"
```

```json
{ "id": "sub_1QabcXYZ", "object": "subscription", "status": "canceled" }
```

Code reads `{ id, status }`. **"Already gone is success":** an error matching
`/No such subscription|resource_missing/i` is converted into
`{ ok: true, data: { id: subscriptionId, status: 'canceled' } }`
(`lib/billing/stripe.ts:288-290`). This is *not* `cancel_at_period_end` — the docstring is
explicit that it is used only when the account is being deleted, and that the Stripe
**customer is deliberately left in place** so invoice history survives
(`lib/billing/stripe.ts:258-271`).

##### (7) List subscriptions (orphan sweep)

```bash
curl -G "https://api.stripe.com/v1/subscriptions?status=all&limit=100" \
  -u "$STRIPE_SECRET_KEY:" \
  -H "Stripe-Version: 2026-07-29.dahlia"
# next page:
curl -G "https://api.stripe.com/v1/subscriptions?status=all&limit=100&starting_after=sub_1QabcXYZ" \
  -u "$STRIPE_SECRET_KEY:" -H "Stripe-Version: 2026-07-29.dahlia"
```

```json
{
  "object": "list",
  "has_more": false,
  "data": [
    { "id": "sub_1QabcXYZ", "status": "active",   "customer": "cus_QxAbC123DeFgHi" },
    { "id": "sub_1Qorphan", "status": "past_due", "customer": "cus_Ghost0001" }
  ]
}
```

Code reads `data[].id`, `data[].status`, `data[].customer`, and `has_more`
(`lib/billing/reconcile.ts:68-71, 102-104`). Pagination is **bounded at 10 pages
(1000 subscriptions)** on purpose (`lib/billing/reconcile.ts:96-106`).

##### Setup script: create the tiered price

```bash
curl https://api.stripe.com/v1/prices \
  -u "$STRIPE_SECRET_KEY:" \
  -d product=prod_QxFleetView \
  -d currency=usd \
  -d "recurring[interval]=month" \
  -d billing_scheme=tiered \
  -d tiers_mode=volume \
  -d lookup_key=fleetview_monthly_per_truck \
  -d "tiers[0][up_to]=3"   -d "tiers[0][unit_amount]=0"   -d "tiers[0][flat_amount]=1900" \
  -d "tiers[1][up_to]=5"   -d "tiers[1][unit_amount]=599" -d "tiers[1][flat_amount]=0" \
  -d "tiers[2][up_to]=6"   -d "tiers[2][unit_amount]=0"   -d "tiers[2][flat_amount]=3400" \
  -d "tiers[3][up_to]=15"  -d "tiers[3][unit_amount]=499" -d "tiers[3][flat_amount]=0" \
  -d "tiers[4][up_to]=17"  -d "tiers[4][unit_amount]=0"   -d "tiers[4][flat_amount]=7900" \
  -d "tiers[5][up_to]=30"  -d "tiers[5][unit_amount]=449" -d "tiers[5][flat_amount]=0" \
  -d "tiers[6][up_to]=31"  -d "tiers[6][unit_amount]=0"   -d "tiers[6][flat_amount]=13500" \
  -d "tiers[7][up_to]=60"  -d "tiers[7][unit_amount]=425" -d "tiers[7][flat_amount]=0" \
  -d "tiers[8][up_to]=64"  -d "tiers[8][unit_amount]=0"   -d "tiers[8][flat_amount]=25900" \
  -d "tiers[9][up_to]=inf" -d "tiers[9][unit_amount]=399" -d "tiers[9][flat_amount]=0"
```

The ten `up_to` boundaries `[3, 5, 6, 15, 17, 30, 31, 60, 64, 'inf']` are asserted at
`lib/billing/__tests__/stripeTiers.test.ts:46`; tier 0 and tier 1 are asserted exactly at
`:49-51`. The remaining eight rows above are derived by applying
`stripeTiersFor()` (`lib/billing/stripeTiers.ts:67-89`) to `TIERS`
(`app/pricing/tiers.ts:117-228`) — the arithmetic is pinned by the parity test, but I did
not see the literal eight-row list printed anywhere in the repo.

```json
{
  "id": "price_1U7LnlBWxY0en8Re5SYNmjyw",
  "object": "price",
  "lookup_key": "fleetview_monthly_per_truck",
  "billing_scheme": "tiered",
  "tiers_mode": "volume",
  "recurring": { "interval": "month" }
}
```

The script reads `product.id` and `price.id` only (`scripts/stripe-setup.mjs:156,167`).

---

### 4. Webhooks

#### 4.1 Endpoint

`POST /api/stripe/webhook` — `app/api/stripe/webhook/route.ts:37`.
`export const dynamic = 'force-dynamic'` and `export const runtime = 'nodejs'`
(`:33-35`) — Node is required because verification uses `node:crypto` and the handler uses
the Supabase service-role client. `GET` returns **405** (`:88-90`).

The route must be reachable while signed out: `'/api/stripe'` is entry in `PUBLIC_PATHS`
(`utils/supabase/middleware.ts:84`). `docs/BILLING.md` (§7) records that this allowlist has
silently swallowed a new route five times, and that a missing entry gives Stripe a `307`
which it counts as delivered.

**Raw body first, always** — `const rawBody = await request.text();`
(`app/api/stripe/webhook/route.ts:39`, rationale `:9-14`).

#### 4.2 Signature verification algorithm

`lib/billing/stripeWebhook.ts`. The scheme, quoted from `:19-25`:

```
 *   Stripe-Signature: t=1699999999,v1=abc...,v1=def...
 *
 * The signed payload is `${t}.${rawBody}` and each v1 is its HMAC-SHA256 under
 * the endpoint secret, hex encoded. More than one v1 appears while a secret is
 * being rotated, so any match counts.
```

**Header parsing** — `lib/billing/stripeWebhook.ts:55-79`:

```ts
export function parseSignatureHeader(header: string): {
  timestamp: number | null;
  signatures: string[];
} {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      const n = Number(value);
      // Not `if (n)` — a timestamp of 0 is invalid but so is NaN, and only one
      // of those is a number.
      timestamp = Number.isFinite(n) && n > 0 ? n : null;
    } else if (key === 'v1') {
      signatures.push(value);
    }
    // v0 is Stripe's test-mode-only scheme for Connect; deliberately ignored.
  }

  return { timestamp, signatures };
}
```

**Tolerance window:** `export const DEFAULT_TOLERANCE_SECONDS = 300;`
(`lib/billing/stripeWebhook.ts:42`), compared **in both directions**
(`:118-125`):

```ts
  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: `Timestamp outside the ${tolerance}s tolerance.` };
  }
```

A far-future timestamp is refused for the same reason as a stale one — it is what an
attacker sends to extend a captured request's life (`:118-122`).

**Signed payload and comparison** — `lib/billing/stripeWebhook.ts:127-135`:

```ts
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

  // Every candidate is checked even after a match, so the number of comparisons
  // does not depend on which one succeeded.
  let matched = false;
  for (const candidate of signatures) {
    if (hexEquals(candidate, expected)) matched = true;
  }
  if (!matched) return { ok: false, reason: 'Signature does not match.' };
```

**Constant-time compare** — `lib/billing/stripeWebhook.ts:81-92`:

```ts
/** Constant-time hex compare that cannot throw on a length mismatch. */
function hexEquals(a: string, b: string): boolean {
  // timingSafeEqual throws if the buffers differ in length, and that throw is
  // itself a timing signal. Length is not secret; compare it first and plainly.
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    // Non-hex input from a forged header.
    return false;
  }
}
```

**Rejection reasons, in order** (`lib/billing/stripeWebhook.ts:111-147`):
`STRIPE_WEBHOOK_SECRET is not set.` → `No Stripe-Signature header.` →
`No timestamp in the signature header.` → `No v1 signature in the header.` →
`Timestamp outside the {n}s tolerance.` → `Signature does not match.` →
`Body is not JSON.` → `Body is not a Stripe event.` (the last requires both `event.id`
and `event.type`).

Only after verification is `JSON.parse(rawBody)` called (`:139`). The parsed event type is
minimal by design (`:47-52`):

```ts
/** Only the fields the handler actually reads. */
export type StripeEvent = {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
};
```

The adversarial suite (`lib/billing/__tests__/stripeWebhook.test.ts`) covers: forged
signature (`:68-72`), tampered body (`:74-78`), re-serialised-but-equivalent JSON
(`:85-89`), wrong secret (`:91-93`), replay outside the window (`:96-100`), future
timestamp (`:103-105`), malformed/missing header (`:107-113`), non-numeric and zero `t`
(`:115-118`), non-hex `v1` not throwing (`:121-124`), missing secret (`:126-130`),
multi-`v1` rotation (`:46-50`), and `v0` being ignored (`:57-60`).

#### 4.3 Status codes returned to Stripe

Chosen for what Stripe should *do* (`app/api/stripe/webhook/route.ts:16-30`):

| Code | When | Source |
| --- | --- | --- |
| 400 | signature did not verify — the only outright refusal | `:47-53` |
| 500 | handler returned `{ ok: false, retry: true }`, or threw | `:60-63`, `:74-79` |
| 200 | handled, duplicate, unattributable, unhandled type, or `{ ok: false, retry: false }` | `:65-73` |

Body on success: `{ received: true, duplicate: <boolean> }` (`:73`). The unverified request
body is deliberately never logged (`:49-51`).

#### 4.4 Events handled

Declared list — `lib/billing/stripeWebhook.ts:158-177`:

```ts
export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
] as const;
```

`customer.subscription.created` is there because a subscription made outside Checkout (the
dashboard, the Portal, a script) fires *only* that event — found by the test clock, which
showed `subscription_status` sitting at `null` for an entire 30-day trial
(`lib/billing/stripeWebhook.ts:159-171`).

What each one writes to `companies` — `lib/billing/webhookHandler.ts:216-280`:

| Event | Columns written |
| --- | --- |
| `checkout.session.completed` | `stripe_customer_id = obj.customer`, `stripe_subscription_id = obj.subscription`, `subscription_status = 'incomplete'` (hardcoded, **not** `'active'` — Stripe says that in the `subscription.updated` that follows) — `:217-225` |
| `customer.subscription.created` / `.updated` / `.deleted` | `stripe_subscription_id = obj.id`, `stripe_quantity = obj.items.data[0].quantity` (only when finite), `subscription_status = obj.status`, `current_period_end = periodEnd(obj)`, `cancel_at_period_end = cancelsAtPeriodEnd(obj)` — `:227-244` |
| `invoice.payment_succeeded` | `subscription_status = 'active'`, `current_period_end = obj.lines.data[0].period.end` (when present), `over_limit_notified_at = null` — `:246-256` |
| `invoice.payment_failed` | `subscription_status = 'past_due'`, plus a payment-failed email to every owner — `:258-274`, sent at `:288-299` |
| anything else | `markProcessed` and return `stored, not acted on (${event.type})` — `:276-279` |

Two compatibility helpers, both there because this API version moved fields:

- `periodEnd(sub)` (`lib/billing/webhookHandler.ts:69-79`) reads top-level
  `current_period_end`, then falls back to each `items.data[].current_period_end`. Null in
  this column is indistinguishable from "never paid", which is what the gate keys off
  (`:56-68`).
- `cancelsAtPeriodEnd(sub)` (`:97-101`) returns true if `cancel_at_period_end === true`
  **or** `cancel_at` is a positive finite number. On `2026-07-29.dahlia` a Portal
  cancellation arrives as `status=active, cancel_at_period_end=false, cancel_at=<period
  end>` (`:81-96`).

Carrier attribution — `findCompanyId` (`lib/billing/webhookHandler.ts:111-128`):
`metadata.company_id` on the object, else `subscription.metadata.company_id`
(`companyIdFrom`, `:38-48`), else a lookup of `companies.stripe_customer_id = obj.customer`.

The payment-failed email is wrapped in try/catch and never rethrown, because a 500 would
make Stripe retry the whole event and re-send the email
(`lib/billing/webhookHandler.ts:288-299`). `emailOwners` silently no-ops when
`NEXT_PUBLIC_SITE_URL` is unset (`:153-154`).

#### 4.5 Idempotency / replay protection

Stated as the whole design at `lib/billing/webhookHandler.ts:14-27`. Mechanism:

1. **Claim before work.** The first DB operation is an insert into `billing_events` keyed
   on Stripe's own `event.id`, storing `type`, `company_id` and the full `payload`
   (`lib/billing/webhookHandler.ts:187-192`). `billing_events.id` is the primary key
   (`db/migrations/0054_billing.sql:109`).
2. **Conflict = already done.** `if (/duplicate key|23505/i.test(claimError.message))` →
   `{ ok: true, duplicate: true, note: 'already processed' }`
   (`lib/billing/webhookHandler.ts:194-197`). Route returns 200.
3. **Ledger unavailable = retry.** Any other insert error returns
   `{ ok: false, retry: true }`, because without the ledger idempotency cannot be promised
   (`:198-201`).
4. **`processed_at` is the "done" marker**, set on *every* terminal path including the
   deliberate no-ops (`markProcessed`, `:143-145`; called at `:208`, `:278`, `:301`).
   `processed_at IS NULL` therefore means "arrived and then something threw", and there is
   a partial index on exactly that for alerting
   (`db/migrations/0054_billing.sql:125-126`). The docstring records that seven events from
   one `stripe trigger` run once sat there looking like failures
   (`lib/billing/webhookHandler.ts:130-142`).
5. A failed `companies` update leaves `processed_at` null **on purpose**, so the failure is
   findable, and returns retry (`:282-286`).

Outbound idempotency keys (the other direction) are `customer:${companyId}`
(`lib/billing/stripe.ts:166`) and `qty:${subscriptionId}:${quantity}`
(`lib/billing/stripe.ts:331`). Checkout and portal sessions send **no** idempotency key.

---

### 5. Configuration

#### 5.1 Environment variables (names verbatim)

| Variable | Read at | Required? | Notes |
| --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | `lib/billing/stripeEnv.ts:57` | yes, for any API call | `.trim()`ed; must start `sk_test_` or `sk_live_` |
| `STRIPE_PRICE_ID` | `lib/billing/stripeEnv.ts:58` | yes | mode-bound; also carries lookup key `fleetview_monthly_per_truck` (`.env.example:126-127`) |
| `STRIPE_WEBHOOK_SECRET` | `app/api/stripe/webhook/route.ts:44` | yes, for the webhook | **not** read by `stripeEnv()`; defaults to `''`, which verification rejects |
| `VERCEL_ENV` | `lib/outbound/guard.ts:44` via `isProductionSite` | platform-set | `'production'` is the only value that means the real site |
| `NEXT_PUBLIC_SITE_URL` | `app/settings/billing/actions.ts:20`, `lib/billing/webhookHandler.ts:153` | effectively yes | falls back to `http://localhost:3000` for checkout URLs; emails silently skip if unset |

`.env.example:117-133` documents the three Stripe variables and nothing else Stripe-related.

#### 5.2 Price / product id handling

- The price id is an **env var**, not hardcoded. Product and price are created by
  `scripts/stripe-setup.mjs`, which prints the ids and tells you to paste the price id into
  `.env.local` (`scripts/stripe-setup.mjs:167-169`).
- The price also carries the mode-independent lookup key `fleetview_monthly_per_truck`
  (`scripts/stripe-setup.mjs:77,164`) so the live cutover can in principle be "the secret
  key alone" (`.env.example:126-127`). **Nothing in the app resolves a price by lookup
  key** — `STRIPE_PRICE_ID` is the only path (`lib/billing/stripeEnv.ts:58`,
  `app/settings/billing/actions.ts:110-115,135`).
- `scripts/stripe-setup.mjs` refuses a live key unless `--live` is also passed
  (`:150-153`), and `--dry` prints the ladder with no API call (`:132-135`).

#### 5.3 Test-vs-live detection — the rule

`stripeEnv()` (`lib/billing/stripeEnv.ts:54-112`), in order:

1. **`assertNotPublic`** — throws if any env key matches
   `startsWith('NEXT_PUBLIC_') && /STRIPE/i && /SECRET|KEY|TOKEN/i`
   (`lib/billing/stripeEnv.ts:41-52`). `NEXT_PUBLIC_STRIPE_PRICE_ID` is *not* flagged
   (no SECRET/KEY/TOKEN token) — asserted at
   `lib/billing/__tests__/stripeEnv.test.ts:92-102`.
2. **Missing vars named together**, not one per attempt
   (`lib/billing/stripeEnv.ts:60-69`; test `:63-65`).
3. **Key shape**: must start `sk_test_` or `sk_live_`. `pk_`, `rk_`, `whsec_` all throw
   `does not look like a Stripe secret key` (`:71-80`; test `:67-73`).
4. **`production = isProductionSite(env)` ⇔ `env.VERCEL_ENV === 'production'`**
   (`lib/outbound/guard.ts:43-45`). Deliberately **not** `NODE_ENV`, which is
   `'production'` on Vercel *preview* deployments too
   (`lib/billing/stripeEnv.ts:17-23`; test `:50-61`).
5. **production + test key → throw** (`:82-88`). This is the *silent* failure the module
   exists for: everything appears to succeed and no money moves
   (`lib/billing/stripeEnv.ts:8-15`).
6. **non-production + live key → throw** (`:90-95`).
7. **live key + a price id not starting `price_` → throw** (`:105-110`) — catches a lookup
   key pasted where an id belongs, which would otherwise surface as "No such price" at the
   moment a real customer pays (`:97-104`; test `:104-114`).

Returns `{ secretKey, priceId, live: isLiveKey }` (`:112`).

#### 5.4 What breaks if a variable is missing

| Missing | Symptom |
| --- | --- |
| `STRIPE_SECRET_KEY` and/or `STRIPE_PRICE_ID` | `stripeRequest` returns `{ ok: false, error: '<the stripeEnv message>' }` before any network call (`lib/billing/stripe.ts:75-82`); the message names the missing vars and where to set them (`lib/billing/stripeEnv.ts:64-68`). The billing page surfaces it verbatim (`app/settings/billing/actions.ts:110-115`). Nothing throws a 500. |
| `STRIPE_WEBHOOK_SECRET` | Every webhook is rejected with reason `STRIPE_WEBHOOK_SECRET is not set.` and HTTP **400** (`lib/billing/stripeWebhook.ts:111`, route `:47-53`). Stripe does not retry a 400, so those events are lost — the nightly reconcile is the only recovery. |
| `NEXT_PUBLIC_SITE_URL` | Checkout success/cancel URLs silently become `http://localhost:3000/...` (`app/settings/billing/actions.ts:20`); payment-failed emails are silently not sent (`lib/billing/webhookHandler.ts:153-154`). |
| `/api/stripe` dropped from `PUBLIC_PATHS` | Webhook 307s to `/login`; Stripe counts it delivered and the DB never learns anyone paid (`docs/BILLING.md` §7; `utils/supabase/middleware.ts:78-84`). |

---

### 6. Data model touchpoints

#### 6.1 `companies` (migrations 0054, 0056)

| Column | Type | Written by |
| --- | --- | --- |
| `stripe_customer_id` | text, unique-when-not-null (`0054_billing.sql:74-75`) | `ensureCustomer` via service role (`app/settings/billing/actions.ts:75-78`); webhook `checkout.session.completed` (`webhookHandler.ts:218`) |
| `stripe_subscription_id` | text, unique-when-not-null (`0054:77-78`) | webhook (`webhookHandler.ts:219, 230`) |
| `subscription_status` | text, mirrors Stripe verbatim, **not an enum** (`0054:42-46`) | webhook (`webhookHandler.ts:223, 240, 247, 259`); reconcile (`reconcile.ts:175`); admin cancel (`app/admin/actions.ts:490-493`) |
| `current_period_end` | timestamptz (`0054:51`) | webhook (`webhookHandler.ts:241, 253`) |
| `trial_ends_on` | date (`0054:56`) | signup (`lib/billing/trial.ts`); read by checkout (`actions.ts:146`) |
| `cancel_at_period_end` | boolean not null default false (`0054:60`) | webhook (`webhookHandler.ts:242`); admin cancel (`app/admin/actions.ts:492`) |
| `over_limit_notified_at` | timestamptz (`0054:65`) | cleared to null on `invoice.payment_succeeded` (`webhookHandler.ts:254`) |
| `stripe_quantity` | integer, null until first sync (`0056_billed_quantity.sql:27-31`) | webhook (`webhookHandler.ts:237-239`); quantity sync (`quantitySync.ts:103, 114`); reconcile (`reconcile.ts:187`) |
| `plan_tier` | text, CHECK widened to the five band ids (`0054:91-98`) | admin only |

#### 6.2 `billing_events` (`db/migrations/0054_billing.sql:107-133`)

`id text primary key` (Stripe's `evt_…`), `type text not null`,
`company_id uuid references companies(id) on delete set null`,
`payload jsonb not null default '{}'`, `received_at timestamptz default now()`,
`processed_at timestamptz`. RLS enabled **and forced with no policies** — the service-role
webhook is the only writer (`:128-133`).

#### 6.3 `usdot_trials` (`db/migrations/0054_billing.sql:138-159`)

`usdot text primary key`, `started_on date`, `ends_on date`,
`company_id uuid references companies(id) on delete set null`, `created_at`. Keyed on the
USDOT rather than the company row so deleting an account cannot mint a second free trial
(`lib/billing/trial.ts:11-24`). Written by `recordTrialClaim`
(`lib/billing/trial.ts:139-159`); read by `resolveTrial` (`:98-120`).

#### 6.4 `vehicles`

Read-only from billing: `count(*) where company_id = ? and is_active = true`
(`lib/billing/quantitySync.ts:72-76`, `app/settings/billing/actions.ts:39-44`).

#### 6.5 Write protection

`app.block_plan_change()` (`db/migrations/0054_billing.sql:184-219`) raises `42501` when
`current_user in ('authenticated','anon')` and any of `plan_tier`, `stripe_customer_id`,
`stripe_subscription_id`, `subscription_status`, `current_period_end`, `trial_ends_on`,
`cancel_at_period_end`, `over_limit_notified_at` changes. `service_role` is deliberately
*not* blocked — the webhook and the admin plan picker both run as it
(`0054:164-181`). This is why `ensureCustomer` uses the service-role client
(`app/settings/billing/actions.ts:47-55`).

`app.company_is_lapsed(uuid)` (`db/migrations/0055_billing_gate.sql:39-60`) is folded into
`app.can_write()` (`:70-78`), and mirrors `lib/billing/access.ts` — both resolve every
ambiguous case to *not lapsed*.

#### 6.6 The quantity-sync rule

`syncQuantityForCompany` — `lib/billing/quantitySync.ts:38-116`, run once per carrier per
day inside the digest cron (`app/api/cron/digest/route.ts:376-397`), never from the
add-a-truck action (`lib/billing/quantitySync.ts:9-19`).

```
quantity = max(count(vehicles where company_id = c and is_active = true), 1)
```

(`lib/billing/quantitySync.ts:72-80`; the same floor-at-1 is applied at checkout,
`app/settings/billing/actions.ts:44`.)

Decision order:

1. No `stripe_subscription_id` → `{ kind: 'skipped', why: 'no subscription' }` (`:48`).
2. `subscription_status` in `['canceled','unpaid']` → skipped (`:55-57`).
3. `cancel_at_period_end === true` → `skipped: 'cancelling at period end'` (`:68-70`) —
   because such a subscription stays `active` right up to the day, so step 2 misses it.
4. `trucks > 100` (`MAX_BILLABLE_TRUCKS`, `:29`) **or** `!priceForTruckCount(trucks)` →
   `{ kind: 'needs-quote', trucks }`. **Refused, not clamped** — billing a 140-truck
   carrier at the 100-truck rate would invent a discount (`:82-89`).
5. `company.stripe_quantity === trucks` → `in-sync`, no API call (`:91`).
6. `GET /v1/subscriptions/{id}`, take `items.data[0]` — the item id is never stored, it is
   read, because a subscription can have more than one item (`:93-99`).
7. If Stripe's item quantity already equals `trucks`, only the local mirror was stale:
   update `companies.stripe_quantity` and report `in-sync` (`:101-105`).
8. Otherwise `POST /v1/subscriptions/{id}` with `proration_behavior: 'none'`, then mirror
   the new value locally (`:107-115`).

`proration_behavior: 'none'` is set in `updateQuantity` (`lib/billing/stripe.ts:328`)
because the UI promises the change lands *next* billing period
(`lib/billing/stripe.ts:310-316`, `docs/BILLING.md` §6).

The nightly reconcile runs **before** the per-carrier loop so the read-only gate never acts
on a stale cache (`app/api/cron/digest/route.ts:206-232`), and it repairs `subscription_status`
and `stripe_quantity` from Stripe, reports `missing` and `orphan` findings without writing
(`lib/billing/reconcile.ts:145-220`).

---

### 7. Gotchas, surprises, and known gaps

**Client / encoding**

1. **No retries and no backoff** in `stripeRequest`. A 20-second timeout
   (`lib/billing/stripe.ts:103`) and then a returned error. Recovery is the daily
   reconcile, not the request.
2. **`formEncode` keeps the empty string** (`d: '' → d=`) while dropping `null`/`undefined`
   (`lib/billing/__tests__/stripeClient.test.ts:45-50`). `createCustomer` relies on this:
   it sends `metadata[usdot]=''` when the USDOT is null (`lib/billing/stripe.ts:163`).
3. **`scripts/stripe-setup.mjs` has a subtly different encoder.** Its `form()` recurses
   into *every* array element regardless of type (`:83`), so an array of scalars would be
   spread character-by-character (`Object.entries('abc')`). It never bites today because the
   only array it sends is `tiers` (objects). `lib/billing/stripe.ts:38-42` and
   `scripts/stripe-lifecycle.mjs:88-93` both branch on `typeof item === 'object'` and are
   correct.
4. **`scripts/stripe-setup.mjs` sends no `Stripe-Version` header** (`:91-97`), so product
   and price creation run against the account's default version while the app pins
   `2026-07-29.dahlia`. `scripts/stripe-lifecycle.mjs` does pin it (`:57`, `:76`).
5. **Idempotency-key collision on a quantity flip-flop.** The key is
   `qty:${subscriptionId}:${quantity}` (`lib/billing/stripe.ts:331`) and Stripe dedupes for
   24 hours. If the quantity goes 8 → 9 → 8 → 9 within one day, the second `…:9` request is
   answered from Stripe's cache without being applied, leaving Stripe at 8 while the local
   mirror says 9. The daily reconcile repairs the mirror, not the subscription. *This is my
   reading of the two mechanisms combined; I found no test or comment covering it.*
6. **Checkout and portal sessions carry no idempotency key** (`lib/billing/stripe.ts:210`,
   `:249`), despite the helper's docstring calling out double-clicked Subscribe as the
   motivating case (`:66-71`).
7. **A stale comment in `createCheckoutSession`.** The block at
   `lib/billing/stripe.ts:224-227` talks about proration and "next billing period", then the
   parameter it precedes is `allow_promotion_codes: false`. The comment belongs to
   `updateQuantity`; the parameter is unrelated.

**API-version drift (the recurring theme)**

8. `current_period_end` moved from the subscription onto each subscription **item**. The
   webhook reads both (`lib/billing/webhookHandler.ts:69-79`) — but the outbound
   `StripeSubscription` type still declares a top-level `current_period_end: number`
   (`lib/billing/stripe.ts:302`) with no item-level fallback. No caller reads it today
   (reconcile uses `status` and `items.data[0].quantity` only), so it is latent, not broken.
9. `cancel_at_period_end` is no longer where a Portal cancellation shows up; `cancel_at` is
   (`lib/billing/webhookHandler.ts:81-101`). The billing page read this wrong before the fix.

**Behavioural surprises**

10. **`checkout.session.completed` writes `'incomplete'`, never `'active'`**
    (`lib/billing/webhookHandler.ts:220-223`). `'active'` is Stripe's word to say, in the
    `subscription.updated` that follows.
11. **`'incomplete'` counts as good standing for access purposes.** `RETRYING` includes
    `past_due`, `incomplete`, `incomplete_expired` and grants FULL access
    (`lib/billing/access.ts:45, 130`), mirrored in SQL
    (`db/migrations/0055_billing_gate.sql:52`). A null `trial_ends_on` also fails **open**
    (`access.ts:141`, `0055:54`).
12. **Cancelling a subscription never deletes the Stripe customer** — invoice history is the
    carrier's receipts and the business's tax records (`lib/billing/stripe.ts:265-270`).
13. **Orphan subscriptions are reported, not cancelled**, unless `cancelOrphans: true` is
    passed (`lib/billing/reconcile.ts:31-37, 215-219`). The cron never passes it
    (`app/api/cron/digest/route.ts:220`), so orphans only ever produce a `console.error`
    line — there is no alert channel wired up. Motivating incident recorded at
    `lib/billing/reconcile.ts:21-31`: a hard delete skipped the cancel and left
    $39.92/month charging a deleted account, found by a human reading the dashboard.
14. **Reconcile's subscription list is capped at 10 pages / 1000 subscriptions**
    (`lib/billing/reconcile.ts:96-106`). Beyond that, orphan detection is silently
    incomplete.
15. **`volume`, not `graduated`.** Getting this wrong overcharges every fleet above five
    trucks — a 20-truck fleet would pay $102.30 against a published $89.80
    (`lib/billing/stripeTiers.ts:6-22`, asserted at
    `lib/billing/__tests__/stripeTiers.test.ts:36-42`). `docs/BILLING.md` said "graduated"
    until 2026-08-22.
16. **The unbounded final tier is meant to be unreachable.** Stripe requires it; the
    quantity sync's 100-truck refusal is what actually keeps a large carrier off it
    (`lib/billing/stripeTiers.ts:57-66`). Removing that guard silently re-enables it.
17. **The price ladder is duplicated in `scripts/stripe-setup.mjs`** (plain node cannot
    import the TS module). The only thing preventing drift is
    `expect(buildTiers()).toEqual(stripeTiersFor())`
    (`lib/billing/__tests__/stripeTiers.test.ts:82-84`).
18. **`HANDLED_EVENTS` / `isHandled` are not used by the handler.** `webhookHandler.ts`
    switches on `event.type` with a `default` branch; `isHandled` is referenced only by its
    own test. The two lists can drift without any test failing.

**Known gaps / TODOs**

19. **`scripts/stripe-reconcile.mjs` does not exist.** `db/migrations/0055_billing_gate.sql:33`
    points at it; the functionality lives in `lib/billing/reconcile.ts` called from the cron.
20. **One-time data-load fees are not implemented in Stripe.** `docs/BILLING.md` §2.4 says
    they must be a separate one-time Price added as a Checkout line item and must never land
    on the subscription — but `createCheckoutSession` sends exactly one line item
    (`lib/billing/stripe.ts:214`) and `lib/billing/dataLoad.ts` only *quotes* a fee for the
    UI. The test "the one-time load fee never lands on the recurring subscription"
    (`docs/BILLING.md` §10) does not exist.
21. **`docs/BILLING.md` §2.4's fee table disagrees with the code.** The doc lists Large $749
    and Fleet $999; `app/pricing/tiers.ts:202, 221` both set `loadFee: 549`.
22. **`docs/BILLING.md` §7's event list omits `customer.subscription.created`**, which the
    code handles, and §9 Step 2 calls the migration `0048_billing.sql` when it shipped as
    `0054_billing.sql`.
23. **`STRIPE_WEBHOOK_SECRET` bypasses `stripeEnv()`** — it is read straight from
    `process.env` in the route (`app/api/stripe/webhook/route.ts:44`), so none of the
    prefix/shape/mode guards apply to it, and a missing one produces 400s rather than a
    startup error.
24. **Secret-key rotation has no code path.** Verification accepts multiple `v1` signatures
    for webhook-secret rotation (`lib/billing/stripeWebhook.ts:132-134`), but only one
    `STRIPE_WEBHOOK_SECRET` is ever supplied to it (`route.ts:44`), so the rotation window
    the algorithm supports cannot actually be used without a code change.
25. **Per `docs/BILLING.md` §9, Step 11 (go live) is not done** and there were zero paying
    customers as of 2026-08-16 (§2.2). Steps 0, 1, 3 and 10 are marked done; Steps 2, 4–9
    are not explicitly ticked in the doc even though the code for them exists.

---

### What I could not determine

- Whether the live Stripe account's product/price were actually created with the ten tiers
  above — `STRIPE_PRICE_ID` is not committed and no live call was made.
- The eight middle rows of the tier ladder in §3.3 are computed from
  `stripeTiersFor()` + `TIERS`; only the ten `up_to` boundaries and tiers 0–1 are literally
  asserted in the repo (`lib/billing/__tests__/stripeTiers.test.ts:46-51`).
- Sample JSON responses are reconstructions of the shapes the code reads, not captured
  fixtures. No response fixture files exist under `lib/billing/__tests__/`.


---

## 4. Resend email, and the SMS provider layer

Source: `/Users/bedopapajanian/Work/fleetview-legacy` (FleetView, Next.js 16 + Supabase).
Audience: a developer re-implementing these integrations in a different application.

Two facts that shape everything below:

1. **There is no `resend` npm package.** `package.json` dependencies are exactly
   `@supabase/ssr`, `@supabase/supabase-js`, `drizzle-orm`, `next`, `postgres`, `react`,
   `react-dom`, `server-only`. Email is a hand-rolled `fetch` POST to `https://api.resend.com/emails`
   in one function (`lib/notify/digest.ts:351`). There is no `twilio` package either.
2. **Both channels funnel through one guard** (`lib/outbound/guard.ts`) that makes it
   impossible to message a real person outside production. Re-implement that first.

---

### Part A — Resend email

### A1. Overview

#### What the app sends

| Category | Where built |
|---|---|
| Signup verification code | `lib/signup/send.ts:35` (`body()`) |
| Weekly compliance digest | `lib/notify/digest.ts:79` (`buildDigest`) |
| Deadline alerts (daily, rung-based) | `lib/notify/alerts.ts:275` (`buildAlertEmail`) |
| Federal (FMCSA) record-change alerts | `lib/federal/alerts.ts:205` (`buildFederalEmail`) |
| Lifecycle / billing: invite, welcome, trial ending, trial ended, payment failed | `lib/billing/emails.ts` |
| Public contact-form relay | `app/contact/actions.ts:151` |
| FMCSA "check your record" lead email | `app/check/actions.ts:306` |
| Staff → carrier ad-hoc email (admin console) | `app/admin/actions.ts:807` |

All of them go through the single exported sender **`sendEmail`** in
`lib/notify/digest.ts:297`. Its own docstring calls it "THE ONLY PLACE THIS APPLICATION SENDS
EMAIL" (`lib/notify/digest.ts:229`).

#### Sending-domain setup implied by the From addresses

From `.env.example:47-57`:

```
RESEND_API_KEY=
DIGEST_FROM_EMAIL=FleetView <alerts@fleetviewcompliance.com>
VERIFY_FROM_EMAIL=FleetView <verify@fleetviewcompliance.com>
```

plus a third literal sender in code: `` `FleetView <${CONTACT_EMAIL}>` `` where
`CONTACT_EMAIL = 'info@fleetviewcompliance.com'` (`app/legal/constants.ts:34`).

So: **one verified domain, `fleetviewcompliance.com`, with three sender mailboxes** —
`alerts@` (machine/bulk), `verify@` (time-critical codes), `info@` (human correspondence).
The split is deliberate: `alerts@` is the kind of address people filter into a weekly folder,
and a code with a ten-minute life cannot sit there (`lib/signup/send.ts:12-15`).

`docs/ROADMAP.md:252-254` states the out-of-code requirement: the sending domain must be
verified in Resend with SPF/DKIM DNS records on `fleetviewcompliance.com`. `app/legal/constants.ts:72-76`
lists Resend as a subprocessor receiving "the recipient address and the message content".

`NEXT_PUBLIC_SITE_URL` is a hard dependency for *any* link-bearing mail: the cron skips sending
entirely when it is unset (`app/api/cron/digest/route.ts:117-124`), and the unsubscribe
header/footer are suppressed when it is unset (`lib/notify/digest.ts:273`, `:372`).

### A2. Exact HTTP contract

Built at `lib/notify/digest.ts:351-397`.

- **Base URL / path**: `https://api.resend.com/emails`
- **Method**: `POST`
- **Timeout**: `signal: AbortSignal.timeout(10_000)` — 10 s. (Rationale at `:393-395`: a hung
  provider must not hold the whole cron run open and starve later carriers.)
- **Headers**:
  - `Authorization: Bearer ${process.env.RESEND_API_KEY}`
  - `Content-Type: application/json`

#### Complete JSON request body

Every field the code can emit, in the order the object literal builds them:

```jsonc
{
  // 1. Always present. params.from ?? process.env.DIGEST_FROM_EMAIL
  //    Format "Display Name <mailbox@domain>".
  "from": "FleetView <alerts@fleetviewcompliance.com>",

  // 2. CONDITIONAL — only when params.unsubscribeToken is truthy AND siteUrl() is non-empty.
  //    Both headers or neither. See digest.ts:359-379.
  "headers": {
    "List-Unsubscribe": "<https://www.fleetviewcompliance.com/api/unsubscribe?t=<token>>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
  },

  // 3. CONDITIONAL — omitted entirely (not null) when params.replyTo is absent.
  //    Comment at digest.ts:380: "Omitted rather than sent as undefined — Resend rejects a null."
  "reply_to": "info@fleetviewcompliance.com",

  // 4. Always present. route.to, NEVER params.to — see the guard, A4.
  "to": "owner@carrier.example",

  // 5. Always present. Prefixed "[dev] " when the guard redirected.
  "subject": "Acme Trucking LLC: 2 compliance deadlines overdue",

  // 6. Always present. Dev notice prepended (when redirected) + unsubscribe footer appended.
  "text": "...",

  // 7. Always present. Same treatment as text, with an HTML notice banner.
  "html": "<!doctype html>..."
}
```

Field-by-field notes:

- **`to`** is a bare string here, not an array. The code never passes an array; every call site
  loops over recipients and sends one message each (e.g. `app/api/cron/digest/route.ts:477`,
  `:585`, `:633`). No `cc`, `bcc`, `attachments`, `tags` or `scheduled_at` are ever sent.
- **`reply_to`** uses Resend's snake_case spelling; the TS parameter is `replyTo`
  (`lib/notify/digest.ts:322`).
- **`headers`** is `undefined` (key absent from the JSON) for transactional mail. This is asserted:
  `expect(sentBody().headers).toBeUndefined()` (`lib/notify/__tests__/unsubscribeHeader.test.ts:96`, `:101`, `:114`).

#### The List-Unsubscribe work — exact names and values

Header names and values, quoted from `lib/notify/digest.ts:374-376`:

```ts
headers: {
  'List-Unsubscribe': `<${siteUrl()}/api/unsubscribe?t=${params.unsubscribeToken}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
}
```

Pinned verbatim by `lib/notify/__tests__/unsubscribeHeader.test.ts:60-69`:

```ts
expect(headers['List-Unsubscribe']).toBe(
  `<https://fleetviewcompliance.com/api/unsubscribe?t=${TOKEN}>`,
);
expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
```

Rules encoded in the code and its tests:

1. **Both headers or neither** (RFC 8058 one-click). `List-Unsubscribe` alone gets a link;
   `List-Unsubscribe-Post` is what makes Gmail/Yahoo render their own button and POST without the
   reader (`digest.ts:360-368`).
2. **Angle brackets are mandatory** (RFC 2369) — test at `unsubscribeHeader.test.ts:72-78`.
3. **https only, no `mailto:`** — stated at `digest.ts:369-370`.
4. **No site URL ⇒ no headers.** A `List-Unsubscribe` pointing at a relative `/api/unsubscribe` is
   a dead link, and a dead unsubscribe is worse than none (`unsubscribeHeader.test.ts:106-115`).
5. **No trailing-slash doubling**: `siteUrl()` strips trailing slashes with
   `.replace(/\/+$/, '')` (`digest.ts:243`); test at `unsubscribeHeader.test.ts:80-85`.
6. **A visible in-body footer accompanies the header, always**, generated from the *same* token in
   the *same* function — `unsubscribeFooterText` (`digest.ts:272`) and `unsubscribeFooterHtml`
   (`digest.ts:281`). Rationale at `digest.ts:246-271`: Outlook desktop, Apple Mail and most phone
   clients render nothing from the header, and the reader's fallback is the spam button. The test
   "agrees with the header — one token, one place, cannot drift" (`unsubscribeHeader.test.ts:143-150`)
   asserts the header URL (brackets stripped) appears in both `text` and `html`.

   Text footer, verbatim (`digest.ts:275-277`):
   ```
   \n\n—\nYou are getting this because you asked FleetView to watch your deadlines.
   Stop these emails: <siteUrl>/api/unsubscribe?t=<token>
   Deadlines stay tracked either way — you just stop hearing about them.
   ```
7. **The token is what makes a message "bulk."** Supply it for digest, deadline alerts, federal
   alerts and trial reminders; omit it for verification codes, invites and payment-failure notices
   (`digest.ts:325-331`).

The receiving endpoint is `app/api/unsubscribe/route.ts` — `POST` and `GET`, both setting
`users.notify_email = false` keyed on `users.unsubscribe_token` (a UUID column, `db/migrations/0057_unsubscribe_token.sql:31`).
POST returns 200 even for an unknown token, deliberately (`app/api/unsubscribe/route.ts:66-75`).

#### Copy-pasteable curl

Bulk mail (with one-click unsubscribe):

```bash
curl -sS -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "FleetView <alerts@fleetviewcompliance.com>",
    "headers": {
      "List-Unsubscribe": "<https://www.fleetviewcompliance.com/api/unsubscribe?t=c5bb25e7-4993-4e1e-8a18-1e557fd68a4e>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
    },
    "reply_to": "info@fleetviewcompliance.com",
    "to": "owner@carrier.example",
    "subject": "Acme Trucking LLC: 2 compliance deadlines overdue",
    "text": "Acme Trucking LLC — compliance as at 14 Sep 2026\n...",
    "html": "<!doctype html><html><body>...</body></html>"
  }'
```

Transactional (no `headers`, no `reply_to`) — the verification-code shape:

```bash
curl -sS -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "FleetView <verify@fleetviewcompliance.com>",
    "to": "dispatch@carrier.example",
    "subject": "482913 is your FleetView verification code",
    "text": "482913 is your FleetView verification code....",
    "html": "<!doctype html>..."
  }'
```

(`$RESEND_API_KEY` is a `re_...`-prefixed token. No real key is reproduced anywhere in this
document; `.env.example:47` ships it empty and the test suites use the literal string
`'fake-key-must-never-be-used'`.)

### A3. Response schema and how the code handles it

The code does **not** parse the success body at all. `lib/notify/digest.ts:399-405`:

```ts
if (!res.ok) {
  return { ok: false, error: `Resend returned ${res.status}: ${await res.text()}` };
}
return { ok: true };
```

- **Success discrimination** is purely `Response.ok` (HTTP 2xx). Resend's success payload is
  `{"id": "<uuid>"}` — the tests stub exactly that (`new Response('{"id":"x"}', { status: 200 })`,
  `chokepoint.test.ts:30`, `unsubscribeHeader.test.ts:32`) — but **the id is never read**.
- **Error shape** is not parsed as JSON either. The whole response body is captured as raw text and
  interpolated into a message string: `Resend returned 422: {"statusCode":422,"message":"...","name":"..."}`.
- **Transport failures** (timeout via `AbortSignal.timeout(10_000)`, DNS, TLS) are caught and
  returned as `{ ok: false, error: (err as Error).message }` (`digest.ts:403-405`). `sendEmail`
  never throws — deliberately, so one bad address does not abort the cron run for everyone after
  it (`digest.ts:226-228`).
- **Return type**: `Promise<{ ok: boolean; error?: string }>`.

**Consequence for a re-implementer:** because the Resend message id is discarded,
`notification_log.provider_ref` is always `null` for scheduled email
(`app/api/cron/digest/route.ts` passes `null` as the `providerRef` argument to `recordSent`,
e.g. `:604`) and is omitted for staff email (`app/admin/actions.ts:826-835`). Only the SMS stub
supplies a `providerRef` (its fake `sid`). If you want a provider reference to quote in support
tickets, parse `res.json().id` — this codebase does not.

### A4. The outbound guard — `lib/outbound/guard.ts`

**This is the most important piece to get right.** Its own header comment (`guard.ts:1-30`) explains
why it exists: the signup flow sends a verification code to the contact FMCSA has on file for
whatever USDOT was typed, and *only real USDOTs pass the FMCSA lookup*. "Three such rows already
exist from testing, aimed at a carrier picked at random out of the federal register"
(`guard.ts:9-11`). Sending to the real contact **is** the feature, so it cannot be prevented by
being careful at each call site.

#### The type

```ts
export type OutboundKind = 'email' | 'sms';

export type OutboundRoute =
  /** Production. Deliver to the person it is addressed to. */
  | { mode: 'live'; to: string; notice: null }
  /** Not production, redirect configured. Deliver to the developer instead. */
  | { mode: 'redirect'; to: string; notice: string }
  /** Not production, no redirect. Send nothing. */
  | { mode: 'blocked'; to: null; notice: string };
```

Note `mode: 'blocked'` has `to: null` at the type level — the type system itself refuses to hand
you a destination when blocked.

#### Environment variables

| Variable | Read at | Meaning |
|---|---|---|
| `VERCEL_ENV` | `guard.ts:44` | The **only** input to "is this production". Must equal the string `'production'`. |
| `DEV_REDIRECT_EMAIL` | `guard.ts:69` | Non-production email destination. `.trim()`ed; whitespace-only counts as unset. |
| `DEV_REDIRECT_PHONE` | `guard.ts:69` | Non-production SMS destination. Same trimming. |

`.env.example:75-76` ships both empty, under a header that reads
`--- Outbound safety rail — READ THIS BEFORE ADDING RESEND OR TWILIO KEYS ---`.

#### The production test

```ts
export function isProductionSite(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL_ENV === 'production';
}
```

**Why not `NODE_ENV`** (`guard.ts:23-29`): `NODE_ENV` is `'production'` on Vercel **preview**
deployments too, so a branch deploy would consider itself live and send for real. `VERCEL_ENV` is
`'production' | 'preview' | 'development'`, and is *unset locally*, which correctly reads as
not-production. Pinned three ways in `lib/outbound/__tests__/guard.test.ts:15-30`:

```ts
expect(isProductionSite(env({ VERCEL_ENV: 'preview', NODE_ENV: 'production' }))).toBe(false);
expect(isProductionSite(env({ NODE_ENV: 'production' }))).toBe(false);
expect(isProductionSite(env({}))).toBe(false);
```

On a non-Vercel host you must supply an equivalent variable that is set *only* on the real
production deployment. Do not reuse `NODE_ENV`.

#### The redirect rules (`routeOutbound`, `guard.ts:54-88`)

```
if VERCEL_ENV === 'production'        -> { mode: 'live',     to: intended,       notice: null }
else if redirect-for-this-kind is set -> { mode: 'redirect', to: <the redirect>, notice: "[dev] This would have gone to <mask> in production." }
else                                  -> { mode: 'blocked',  to: null,           notice: "Blocked: not production and no DEV_REDIRECT_EMAIL|DEV_REDIRECT_PHONE set. Would have gone to <mask>." }
```

Five properties a re-implementation must preserve:

1. **Default is REFUSE, not deliver.** With no redirect configured outside production, messages are
   blocked. "A missing environment variable must never be the difference between 'went nowhere' and
   'went to a stranger's phone'" (`guard.ts:17-21`).
2. **Channels are separate.** Email uses `DEV_REDIRECT_EMAIL`; SMS uses `DEV_REDIRECT_PHONE`. An
   email redirect does not unlock SMS — `guard.test.ts:74-82` and `chokepoint.test.ts:103-107`.
3. **A stray redirect in production is ignored.** `VERCEL_ENV=production` short-circuits before the
   redirect is even read, so a `DEV_REDIRECT_EMAIL` accidentally left in Vercel production does not
   divert every customer's mail to one inbox (`guard.test.ts:118-127`).
4. **The notice carries the MASKED recipient, never the real one.** `intendedMask` is passed in by
   the caller; the fallback when absent is the literal string `'(recipient hidden)'`
   (`guard.ts:71`). The notice ends up in logs *and* in the redirected message body, so printing
   a stranger's full address there would leak exactly what the mask protects
   (`guard.test.ts:91-103`). Masks come from `lib/signup/mask.ts`: `maskPhone` →
   `••• ••• •413` (last **three** digits, not four — `mask.ts:16-29`), `maskEmail` →
   `ek•••@•••.com` (two leading chars + TLD only; the domain is hidden because for a small carrier
   the domain is the company name — `mask.ts:31-55`).
5. **The notice names the missing variable** so the fix is obvious (`guard.test.ts:84-89`).

The single invariant, asserted as a loop over six environment permutations
(`guard.test.ts:57-72`):

> "never returns the intended recipient as the destination" — whatever the configuration, outside
> production `to` is either the developer or nothing.

#### How the two senders consult it

**Email** — `lib/notify/digest.ts:334-342`, at the very top of `sendEmail`, *before* the API key is
even read:

```ts
const route = routeOutbound({
  kind: 'email',
  intended: params.to,
  intendedMask: params.toMask ?? null,
});
if (route.mode === 'blocked') {
  console.info('[sendEmail]', route.notice);
  return { ok: false, error: route.notice };
}
```

and then, in the body (`digest.ts:382-391`):

- `to: route.to` with the comment "route.to, never params.to. Outside production this is the developer."
- `subject: route.mode === 'redirect' ? \`[dev] ${params.subject}\` : params.subject`
- `text`: the notice prepended as `${route.notice}\n\n${params.text}`
- `html`: the notice prepended as an amber banner
  `<p style="background:#fff4e5;padding:8px 12px;border-radius:6px;font-family:system-ui">${route.notice}</p>`

**SMS** — `lib/sms/provider.ts:79-98`, a `guarded()` wrapper applied by the factory so no adapter
can be reached raw (see Part B).

#### What the "chokepoint" test asserts

`lib/outbound/__tests__/chokepoint.test.ts`. Its purpose (`:5-15`): `guard.test.ts` proves
`routeOutbound` *decides* correctly; this proves the decision is actually **wired** — that
`sendEmail` and the SMS provider consult it before transmitting, with API keys present and
everything else looking live. "A correct rule nobody calls is the failure mode that unit tests
miss."

Setup (`:22-33`) deliberately makes sending look possible: `RESEND_API_KEY` and
`DIGEST_FROM_EMAIL` are both set, `VERCEL_ENV` / `DEV_REDIRECT_EMAIL` / `DEV_REDIRECT_PHONE` are
deleted, and `global.fetch` is stubbed with a spy — "Any call reaching this is a message that left
the building." Comment at `:13-14`: "the dangerous moment is not today — it is the afternoon those
keys get pasted in."

The six assertions, with `STRANGER = 'dispatch@somerealcarrier.com'`:

| # | Case | Assertion |
|---|---|---|
| 1 | No redirect set | `res.ok === false` **and `fetchSpy` was never called** — Resend was not contacted despite a key being present (`:45-51`) |
| 2 | `DEV_REDIRECT_EMAIL` set | exactly one fetch; parsed body `to === 'me@example.com'`; `JSON.stringify(body)` **does not contain** the stranger's address anywhere; `body.subject` contains `'[dev]'`; `body.text` contains the mask `'di•••@•••.com'` (`:53-70`) |
| 3 | `NODE_ENV=production` + `VERCEL_ENV=preview` | `res.ok === false`, `fetchSpy` never called — "not fooled by a preview deployment claiming to be production" (`:72-80`) |
| 4 | `VERCEL_ENV=production` | body `to === STRANGER`; subject does **not** contain `'[dev]'` (`:82-88`) |
| 5 | SMS, no redirect | `getSmsProvider().send(...)` returns `ok: false` (`:92-95`); with `DEV_REDIRECT_PHONE` set, `ok: true` (`:97-101`) |
| 6 | SMS with only `DEV_REDIRECT_EMAIL` set | `ok: false` — "an email redirect does not unlock sms" (`:103-107`) |

Assertion #2's `expect(JSON.stringify(body)).not.toContain(STRANGER)` is the strongest one: it
checks the *entire serialised payload*, not just the `to` field, so a leak through the subject, the
body text or a header would fail it.

#### Related: the FMCSA sandbox

`lib/fmcsa-sandbox.ts:154-155` reuses the same two variables to synthesise a *contact* for sandbox
lookups (`email: env.DEV_REDIRECT_EMAIL?.trim() || null`, `phone: env.DEV_REDIRECT_PHONE?.trim() || null`),
so the lookup itself returns the developer rather than a real carrier. A second layer, not a
replacement for the guard.

#### `SITE_LAUNCHED` — not part of this

Worth stating explicitly because the name suggests otherwise: **`SITE_LAUNCHED` has nothing to do
with outbound messaging.** It is read in exactly one place, `app/layout.tsx:27`
(`const LAUNCHED = process.env.SITE_LAUNCHED === 'true';`), and controls only search-engine
indexing — unset emits `noindex/nofollow` on every page (`.env.example:108-115`). No sender, guard
or cron reads it.

#### `LIVE_EMAIL_TO` — a test-only escape hatch

Read only by `lib/federal/__tests__/email.live.test.ts` (run via `npm run test:live` /
`vitest.live.config.ts`). The whole suite is skipped unless it is set (`:28`), and the way it works
is worth noting: it **does not bypass the guard** — it sets the guard's own variable
(`if (TO) process.env.DEV_REDIRECT_EMAIL = TO;`, `:33`), so the send is a *redirect*, not a live
send. That is the right pattern to copy: give your live-fire test a redirect target rather than a
guard override.

### A5. Every distinct email the app sends

`sendEmail` params legend: `from` = which env var / literal supplies the sender;
`unsub` = whether `unsubscribeToken` is passed (⇒ List-Unsubscribe headers + visible footer).

| # | Email | Trigger | Template | From | Subject pattern | `reply_to` | unsub |
|---|---|---|---|---|---|---|---|
| 1 | Verification code | Signup, visitor picks the email channel | `lib/signup/send.ts:35` | `VERIFY_FROM_EMAIL` ?? `DIGEST_FROM_EMAIL` (`send.ts:79`) | `` `${code} is your FleetView verification code` `` (`send.ts:100`) | — | No |
| 2 | Welcome | Account created (`verifyAndCreate`) | `welcomeEmail`, `lib/billing/emails.ts:114` | default (`DIGEST_FROM_EMAIL`) | `` `${legalName} is set up on FleetView` `` (`emails.ts:161`) | — | No |
| 3 | Invite / set password | Admin imports a carrier | `inviteEmail`, `emails.ts:79` | default | `` `Set your password for ${legalName} on FleetView` `` (`emails.ts:96`) | — | No |
| 4 | Weekly digest | Cron `?send=1`, Mondays 14:00 UTC | `buildDigest`, `digest.ts:79` | default | One of four, most-urgent-first (`digest.ts:92-101`): `` `${legalName}: N compliance deadline(s) overdue` `` / `` `…: N record(s) missing a date` `` / `` `…: N deadline(s) in the next few weeks` `` / `` `…: nothing due — all N items current` `` | `CONTACT_EMAIL` | **Yes** |
| 5 | Deadline alert | Cron daily, items crossing a ladder rung | `buildAlertEmail`, `alerts.ts:275` | default | `` `${title} — ${rungLabel(rung)}` `` when one; `` `${n} overdue, ${m} coming up` `` when any overdue; else `` `${n} deadlines need booking` `` (`alerts.ts:284-289`) | `CONTACT_EMAIL` | **Yes** |
| 6 | Federal record change | Cron daily, FMCSA sweep found a change | `buildFederalEmail`, `lib/federal/alerts.ts:205` | default | `worst.title` when one alarm; `` `${n} changes to your FMCSA record need attention` ``; else `` `FMCSA updated your record` `` (`federal/alerts.ts:222-228`) | `CONTACT_EMAIL` | **Yes** |
| 7 | Trial ending | Cron `?send=1`, days-remaining ∈ `[7, 3, 1]` | `trialEndingEmail`, `emails.ts:184` | default | `` `${days} left in your FleetView trial` `` (`emails.ts:202`) | `CONTACT_EMAIL` | **Yes** |
| 8 | Trial ended | Cron `?send=1`, days-remaining === `-1` | `trialEndedEmail`, `emails.ts:220` | default | `Your FleetView trial has ended` (`emails.ts:231`) | `CONTACT_EMAIL` | **Yes** |
| 9 | Payment failed | Stripe webhook, `notify === 'payment_failed'` (`webhookHandler.ts:288`) | `paymentFailedEmail`, `emails.ts:250` | default | `Your FleetView payment did not go through` (`emails.ts:262`) | — | No |
| 10 | Contact-form relay | Public contact form submit | `app/contact/actions.ts:50` / `:63` | literal `` `FleetView <${CONTACT_EMAIL}>` `` | `` `FleetView enquiry — ${name}${' · N trucks'}` `` (`lib/contact/validate.ts:105-108`) | **the sender's address** (`v.email`) | No |
| 11 | FMCSA-check lead | Public /check form submit | inline, `app/check/actions.ts:306` | default | `` `Your FMCSA record — USDOT ${usdot}` `` (`check/actions.ts:307`) | — | No |
| 12 | Staff → carrier | Admin console composes a message | `buildStaffEmail`, `app/admin/actions.ts:857` | literal `` `FleetView <${CONTACT_EMAIL}>` `` | operator-supplied, ≤200 chars (`admin/actions.ts:780`) | `CONTACT_EMAIL` | No |
| 13 | Test alert (self) | Owner presses "send me a test" in Settings | `buildDigest` | default | same as #4 | `CONTACT_EMAIL` | **Yes** |

Notes on the table:

- **Which get the unsubscribe**: exactly the recurring ones — digest, deadline alerts, federal
  alerts, trial reminders (and the self-test, which reuses the digest). The rule, from
  `digest.ts:325-331`: "Offering to unsubscribe from a login code would be offering to switch off
  the thing they need to get in." The unsubscribe endpoint's own docstring confirms the coverage
  (`app/api/unsubscribe/route.ts:25-30`).
- **The `from` parameter is a parameter, not an env write.** `lib/signup/send.ts:89-97` and
  `digest.ts:306-316` both document the bug this fixed: `send.ts` used to *assign*
  `process.env.DIGEST_FROM_EMAIL`, call `sendEmail`, and restore it in a `finally`. `process.env` is
  global to the Node process and Next.js serves concurrent requests in one, so a signup in flight
  during the cron would have sent that carrier's deadline alerts from `verify@`, and two overlapping
  signups could leave the variable wrong until the next deploy. A regression test greps the source
  for the assignment: `expect(src).not.toMatch(/process\.env\.VERIFY_FROM_EMAIL\s*=/)`
  (`app/admin/__tests__/carrierEmail.test.ts:90-91`).
- **The contact form is the one place an unauthenticated stranger can make the verified domain
  send** (`app/contact/actions.ts:14-17` calls it "an open relay wearing our name" unless the rules
  hold). The mitigations: `to` is the compile-time constant `CONTACT_EMAIL`, never a form value
  (asserted by `lib/contact/__tests__/validate.test.ts:98-99`); the stranger's address is used
  **only** as `reply_to`; the row is inserted into `contact_messages` *before* the send (ordering
  asserted at `validate.test.ts:120`); and there is an hourly rate cap that fails closed.
- **Dev fallback for #1**: with no `RESEND_API_KEY`/from address, `sendVerificationEmail` logs the
  code to the console and returns `ok` — but only when `NODE_ENV !== 'production'`. In production an
  unconfigured sender is an error (`lib/signup/send.ts:80-86`). That fence matters: the fallback
  writes a credential into a log file.
- **Cron schedule** (`vercel.json`): `0 13 * * *` daily writes score snapshots and sends deadline +
  federal alerts; `0 14 * * 1` (Mondays) adds `?send=1`, which is what gates the weekly digest and
  the trial emails. Auth is `Authorization: Bearer $CRON_SECRET`, and an unauthorised caller gets
  **404, not 401**, so it does not learn the route exists (`app/api/cron/digest/route.ts:107-111`).
- **Billing gate**: nothing goes out for a lapsed carrier (`route.ts:282-292`) — except the trial
  emails, which are evaluated *before* the gate on purpose, since "your trial has ended" is for
  exactly the carrier whose `canSendAlerts` is already false (`route.ts:300-311`).
- **Per-user opt-out** is applied at every alert/digest call site by filtering
  `r.notify_email !== false` (`route.ts:465-467`, `:534-536`, `:627`).

### A6. Logging — what is recorded per send

**Table: `notification_log`** (`db/migrations/0041_notification_log.sql`). One row per alert
actually sent. It is not just a record — the unique index on it *is* the send-deduplication key.

Columns:

| Column | Type | Meaning |
|---|---|---|
| `id` | `uuid pk default gen_random_uuid()` | |
| `company_id` | `uuid not null references companies(id) on delete cascade` | tenant |
| `item_key` | `text not null` | what it was about: a regulation id, or `reminder:<uuid>`, or `staff:email` |
| `subject_type` | `subject_type not null` | enum `driver \| vehicle \| company \| federal` (`federal` added by `0061`) |
| `subject_id` | `uuid` | null for company-level rules; for `federal`, the `fmcsa_observations` row id |
| `threshold_days` | `integer` (nullable since `0042`) | the ladder rung: 60/30/14/7/1/0, negative for weekly overdue repeats; **null for manual sends** |
| `channel` | `text not null` | CHECK `in ('email','sms')` |
| `recipient` | `text not null` | the address or number it actually went to |
| `status` | `text not null default 'sent'` | CHECK `in ('sent','failed','skipped')` |
| `provider_ref` | `text` | provider's message id — **always null for email**, see A3 |
| `sent_at` | `timestamptz not null default now()` | |
| `trigger` | `text not null default 'auto'` (added `0042`) | CHECK `in ('auto','manual')` |

Constraints and indexes:

- `notification_log_rung_shape`: `check ((trigger = 'auto') = (threshold_days is not null))` — a
  scheduled alert must name its rung; a manual send never has one (`0042`).
- `notification_log_once` — the idempotency guarantee, **partial and six-column** after `0058`:
  ```sql
  create unique index notification_log_once
    on notification_log (company_id, item_key, subject_id, threshold_days, channel, recipient)
    nulls not distinct
    where trigger = 'auto';
  ```
  `nulls not distinct` is required so company-level rules (null `subject_id`) deduplicate at all.
- RLS is enabled and forced; there is a SELECT policy scoped to `app.current_company_id()` and
  **deliberately no INSERT policy** — rows are written by the cron under the service role, because a
  user who could insert here could fabricate "we were warned on the 3rd" (`0041:78-86`).

Two writers, deliberately not unified:

1. **`recordSent`** (`lib/notify/alerts.ts:208`) — scheduled alerts. Writes `trigger: 'auto'`,
   one row per alert **per recipient**, plus one `status: 'skipped'` row for each `passedOver` rung
   so an outage does not produce a burst of stale alerts when the job comes back. Uses
   `.upsert(rows, { ignoreDuplicates: true })` with **no `onConflict`** — naming the columns makes
   Postgres try to infer the *partial* index and fail with 42P10, silently, which is documented at
   length at `alerts.ts:249-266` as a bug that caused the email to send and nothing to be recorded,
   forever.
2. **`logOutbound`** (`lib/notify/log.ts:43`) — manual sends. Writes `trigger: 'manual'`,
   `threshold_days: null` explicitly (never `0`, which is a real rung — `log.ts:55-57`), and
   **never throws**: a logging failure is `console.error`'d because the message has already gone and
   reporting it as a send failure would have an owner press send again (`log.ts:34-42`).

Reading it safely: **`readLoggedRungs`** (`lib/notify/logRead.ts:64`). Required reading for a
re-implementation — PostgREST silently caps every select at ~1000 rows with nothing in the response
to say so, and a short read here means already-sent rungs get proposed again *every run, forever*
(`logRead.ts:6-27`). The fix is both narrowing (chunk `item_key` in groups of `CHUNK = 100`) and
paging (`PAGE = 500`, ordered by `id` ascending, loop until a short page), and it returns `null` on
error so callers can **fail closed** — `filterAlreadySent` logs and sends nothing rather than risk
replaying the whole ladder (`alerts.ts:168-174`).

Other records written alongside a send:

- **`contact_messages`** (`0048`) — the contact form inserts `status: 'queued'` first, then updates
  to `'sent'` or `'failed'` with the error text (`app/contact/actions.ts:132-170`). The user is told
  success either way, because the row is saved and the message will be seen.
- **`check_leads`** — same queued→sent/failed pattern (`app/check/actions.ts:295-330`).
- **Audit rows** via `audit(...)` for staff email and test alerts. Subject only, never the body:
  "an audit log is not the place to keep a second copy of it" (`app/admin/actions.ts:845-847`).

What is deliberately **not** logged, at either level: the message body and the recipient address in
platform logs. `app/api/cron/digest/route.ts:640-643` — "A digest names every driver whose medical
card has expired, and that does not belong in a platform log." The recipient *is* stored in
`notification_log`, scoped to the carrier's tenant by RLS, which is where it is accountable.

---

### Part B — SMS

### B1. This is a stub, not a live integration

**Verified. No SMS has ever left this application.** The evidence:

1. `lib/sms/messages.ts:22` — `export const SMS_SENDING_LIVE = false;`
2. `lib/sms/provider.ts:100-104`:
   ```ts
   export function getSmsProvider(): SmsProvider {
     // Real Twilio adapter lands in phase 2. Until then always stub — and even
     // then it arrives wrapped, not returned raw.
     return guarded(stubSmsProvider);
   }
   ```
   There is **no env switch** and **no code reads `SMS_PROVIDER`** — confirmed by grep. That is
   deliberate: "a live adapter that can be turned on by setting one variable would be reachable
   before driver consent capture and STOP handling exist, and the first thing it would do is text
   real people who never agreed to it. The switch lands with the adapter, in the same change as the
   consent gate" (`provider.ts:7-12`).
3. `stubSmsProvider.send` makes no network call at all — it mints a fake id
   `` `stub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` ``, logs
   `'[sms:stub] send suppressed'` and returns `{ ok: true, provider: 'stub', sid }`
   (`provider.ts:54-65`).
4. No `twilio` package in `package.json`. The only Twilio code in the repo is
   `scripts/test-sms.mjs`, a standalone CLI probe: "This is a probe, not a feature… deliberately not
   wired into the app, the cron, or the notification preferences. Nothing imports it"
   (`test-sms.mjs:7-13`). `.env.example:86-107` says the same: "TWILIO (SMS) — NOT WIRED INTO THE
   APP YET… Setting them turns on no behaviour."
5. Callers report honestly rather than pretending. `sendVerificationSms` inspects
   `result.provider === 'stub'` and returns `{ ok: false, reason: 'Text messages are not switched
   on yet. Use the email option.' }` in production (`lib/signup/send.ts:121-130`). The UI gates on
   the constant: `const canSms = Boolean(masked.phoneMask) && SMS_SENDING_LIVE;`
   (`app/signup/SignupFlow.tsx:106`).
6. `lib/notify/reach.ts` exists specifically because of this. `alertReach()` answers "will anything
   actually reach this person", not "what did they tick" — because `SMS_SENDING_LIVE` is false, "a
   carrier with email off and texts ticked is receiving NOTHING" (`reach.ts:16-18`). It returns
   `{ silent, smsPendingLaunch }` so a banner can say so:
   ```ts
   const smsReaches = prefs.notifySms && SMS_SENDING_LIVE;
   return { silent: !emailReaches && !smsReaches, smsPendingLaunch: prefs.notifySms && !SMS_SENDING_LIVE };
   ```

Everything else in `lib/sms/` — message bodies, phone normalisation, the audit rows, the owner-facing
previews — is fully built and exercised; only the wire is missing.

### B2. The `SmsProvider` interface, verbatim

`lib/sms/provider.ts:25-41`:

```ts
export type SendSmsInput = {
  toE164: string;
  body: string;
  /** Correlation for logs / future message table. */
  meta?: {
    companyId?: string;
    driverId?: string;
    regulationId?: string;
  };
};

export type SendSmsResult =
  { ok: true; provider: 'stub' | 'twilio'; sid: string } | { ok: false; error: string };

export interface SmsProvider {
  send(input: SendSmsInput): Promise<SendSmsResult>;
}
```

#### What a real adapter must implement

- **One method**, `send(input): Promise<SendSmsResult>`. It must **never throw** — every caller
  branches on `result.ok` and expects a reason string on failure
  (`app/deadlines/actions.ts:466-468`, `app/reminders/textActions.ts:177-178`).
- **`toE164` is already normalised** by the caller via `toE164()` (Part B3). The adapter should not
  re-parse it.
- **`sid` is load-bearing on success** — it is written to `notification_log.provider_ref`
  (`app/reminders/textActions.ts:187`). The discriminated union means `sid` is only reachable after
  narrowing on `ok: true`.
- **The `provider` discriminant matters to callers.** `lib/signup/send.ts:124` branches on
  `result.provider === 'stub'` to avoid telling a visitor a message was sent when it was not. A real
  adapter returns `'twilio'`; the union would need widening for any third provider.
- **It must be registered through `getSmsProvider()`, wrapped, never returned raw.** The wrapper
  (`provider.ts:79-98`):
  ```ts
  function guarded(provider: SmsProvider): SmsProvider {
    return {
      async send(input) {
        const route = routeOutbound({
          kind: 'sms',
          intended: input.toE164,
          intendedMask: maskPhone(input.toE164),
        });
        if (route.mode === 'blocked') {
          console.info('[sms] ' + route.notice);
          return { ok: false, error: route.notice };
        }
        return provider.send({
          ...input,
          toE164: route.to,
          body: route.notice ? `${route.notice}\n${input.body}` : input.body,
        });
      },
    };
  }
  ```
  Note the asymmetry with email: SMS prepends the notice to the **body** with a single `\n` and has
  no subject line to prefix.
- **Logging discipline**: the stub logs `sid`, `chars: input.body.length`, `companyId` and
  `regulationId` — "never the number and never the body", because a body names a driver and says
  which document has lapsed, and the number is the driver's personal one (`provider.ts:43-53`). A
  real adapter must hold the same line.
- **Reference for the wire format** (not currently wired) — `scripts/test-sms.mjs:117-129` shows the
  shape a Twilio adapter would use, also a bare fetch:
  ```
  POST https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json
  Authorization: Basic base64(`${sid}:${token}`)
  Content-Type: application/x-www-form-urlencoded
  body: URLSearchParams({ To, From, Body })
  signal: AbortSignal.timeout(15_000)
  ```
  Env vars `TWILIO_ACCOUNT_SID` (must start with `AC`), `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
  (E.164) — none with a `NEXT_PUBLIC_` prefix, which would inline credentials into the browser
  bundle (`.env.example:99-102`).

### B3. `lib/sms/messages.ts` — the message bodies

Split out of `provider.ts` specifically so a **client component** can import it: `provider.ts` pulls
in the outbound guard and the phone masker, neither of which belongs in a browser bundle, but the
owner must see the exact message before pressing send — and "exact" has to mean the same function
the server calls (`messages.ts:1-13`). A test enforces the non-duplication:
`expect(viaProvider).toBe(buildDriverUploadRequestBody)` (`messages.test.ts:25-28`).
`provider.ts:23` re-exports rather than redefining.

Exports:

**`SMS_SENDING_LIVE = false`** (`:22`) — the kill switch, in the client-importable module so UI can
read it.

**`publicSiteUrl()`** (`:30-32`) —
`(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000').replace(/\/$/, '')`. Note it differs
from the server's `siteUrl()` in `digest.ts:243` on two points: it has a localhost default (the
server's returns `''`), and it strips only **one** trailing slash (`/\/$/` vs `/\/+$/`).

**`buildDriverUploadRequestBody(args)`** (`:34-73`) — "we need your document" for a specific
expiring item. Args: `companyName`, `documentLabel`, `driverFirstName?`, `updateUrl?`,
`aboutSubject?`. Composition is `${head} ${middle} ${tail}`:

- head, when `aboutSubject` is given (a truck's document texted to its usual driver):
  `` `FleetView: ${who}${companyName} needs the ${documentLabel} for ${aboutSubject}.` ``
- head, otherwise: `` `FleetView: ${who}${companyName} needs your ${documentLabel} for compliance.` ``
- `who` is `` `${driverFirstName}, ` `` or `''` — the empty case is tested so it never prints
  `undefined` (`messages.test.ts:44-48`)
- middle: `` `Update it here (link expires): ${updateUrl}` `` when a link exists, else
  `` `Please send it to the office.` ``. No link is invented for rules the carrier performs itself
  (MVR, Clearinghouse query) — the driver cannot know that date (`messages.ts:38-46`)
- tail, **always**: `` `Reply STOP to opt out. Msg&data rates may apply.` `` — "The opt-out is not
  optional. An A2P message without one is a violation regardless of how few are sent, so it is
  appended in one place rather than left to each branch to remember" (`:63-66`)

**`buildDriverLinkMessage(args)`** (`:82-93`) — the general "check your details" ask from a driver
profile. Args `companyName`, `driverFirstName?`, `url`:

```
FleetView: {who}{companyName} needs you to check your driver details. Update them here (link expires): {url} Reply STOP to opt out. Msg&data rates may apply.
```

**`buildReminderMessage(args)`** (`:103-114`) — one driver, one carrier-authored reminder. Args
`companyName`, `driverFirstName?`, `title`, `dueLabel`:

```
FleetView: {who}{companyName} — {title}, due {dueLabel}. Reply STOP to opt out. Msg&data rates may apply.
```

Only the title and the date travel — never the private note attached to the reminder, which "may say
something the office would not want quoted" (`:98-101`).

The `Reply STOP` string is asserted on every branch of every builder
(`messages.test.ts:38-39, 54, 67, 105, 136`; `vehicleAsk.test.ts:35-38`). There is **no** character
limit / segment-count check anywhere, and no truncation.

### B4. `lib/sms/phone.ts` — normalisation rules

Explicitly *not* libphonenumber: "the gate only needs 'is there something we can send to?' before
Twilio is wired" (`phone.ts:1-7`).

**`digitsOnly(raw)`** (`:10-12`) — `raw.replace(/\D/g, '')`.

**`toE164(raw): string | null`** (`:38-53`) — the single source of truth. In order:

1. `null`/`undefined`/empty/whitespace-only → `null`
2. exactly **10 digits** → `+1` + digits (US/CA assumed)
3. exactly **11 digits starting with `1`** → `+` + digits
4. original string **starts with `+`** and digit count is **11–15 inclusive** → `+` + digits
   (passed through as-is for international numbers)
5. anything else → `null`

What it therefore **rejects**: fewer than 10 digits (`'555-1234'`, `'123'`); 11 digits not starting
with `1` and without a leading `+`; 12–15 digits without a leading `+`; more than 15 digits; empty
and whitespace. Note the asymmetry — a leading `+` is required for the 11–15 branch but *not* for
the 10- and 11-digit US branches, and the `+` check is on the raw trimmed string while the length
check is on the extracted digits.

**`hasUsablePhone(raw)`** (`:30-32`) — defined as `toE164(raw) !== null`, deliberately, "because the
two used to disagree and the disagreement was visible to owners": `hasUsablePhone` accepted only
10/11-digit US shapes while `toE164` also accepted an international `+`, so a driver with an
Armenian mobile was shown "Phone missing" beside a number that was present and valid
(`phone.ts:14-32`). A test loops both over the same inputs asserting they agree
(`phone.test.ts:19-37`).

**`formatPhoneDisplay(raw)`** (`:56-65`) — UI only. `+1` + 12 chars → `(818) 555-1234`; otherwise the
E.164 form; unparseable input falls back to `raw.trim()`.

Distinct from these: **`maskPhone`** in `lib/signup/mask.ts:23-29` — `••• ••• •413`, the **last three**
digits (not four: the last four of a US number is the subscriber line, and with a known area code
that narrows a number far more than three digits does). Returns `null` for fewer than 7 digits,
since showing 3 of 4 is not masking.

### B5. What is NOT built

Confirmed absent by grep across `lib/`, `app/` and `db/migrations/`:

- **Consent capture.** There is no consent column, table, timestamp or UI anywhere. Named as a
  blocker in `provider.ts:9-12`: a live adapter "would be reachable before driver consent capture
  and STOP handling exist". `users.notify_sms` (`db/schema.ts:87`, default `false`) is a *preference*
  toggle, not consent — nothing records that a driver ever agreed, and drivers are not users.
- **Suppression / opt-out list.** No table, no check before send. The `guarded()` wrapper consults
  only `routeOutbound`; no suppression lookup exists. (The word "suppress" in this codebase refers to
  `rungsToSuppress` / `suppressPassedRungs` in `lib/notify/schedules.ts:271` and
  `lib/notify/scheduleStore.ts:226` — alert-ladder bookkeeping, unrelated to SMS opt-outs.)
- **STOP / HELP inbound webhook.** `app/api/` contains only `cron`, `search`, `stripe` and
  `unsubscribe`. There is no inbound SMS route at all. Every outgoing body *promises* "Reply STOP to
  opt out", and **nothing would process that reply.** This is the single largest compliance gap: the
  messages make an A2P promise the system cannot currently keep. (Today it is harmless only because
  the stub sends nothing.)
- **Quiet hours / time-of-day windows.** No such logic exists in `lib/sms/`, the guard, or the cron.
  `companies.timezone` (`db/schema.ts:52`, default `America/Los_Angeles`) is used for
  billing/trial day boundaries (`todayInZone(row.timezone)`, `app/api/cron/digest/route.ts:294`),
  not for send windows. TCPA-style 8am–9pm local windows would need building from scratch.
- **Rate limiting / queueing.** `app/reminders/textActions.ts:157-163` sends sequentially in a loop
  with a `MAX_RECIPIENTS` cap and a comment saying "a real queue replaces this when volume justifies
  one".
- **A2P 10DLC registration.** Called out repeatedly as an external, weeks-long prerequisite
  (`.env.example:103-107`, `lib/signup/send.ts:19-23`, `scripts/test-sms.mjs:14-20`) — an
  unregistered number can reach your own handset and still be silently filtered en route to a
  customer's.

#### `users.phone` vs `companies.phone` — which one is for SMS

There are **three** `phone` columns in `db/schema.ts`:

| Column | Line | Used for SMS? |
|---|---|---|
| `companies.phone` | `db/schema.ts:50` | **No.** Carrier office line — company record data. No SMS path reads it. |
| `users.phone` | `db/schema.ts:88` | **No current sender reads it.** This is the login-account holder's number and sits next to the `notify_sms` preference, so it is the column the *alert* channel would use if SMS notifications ever ship. |
| `drivers.phone` | `db/schema.ts:108` | **Yes — this is the one every built SMS path actually uses.** |

Every existing `getSmsProvider().send()` call targets a **driver**, not a user or a company:

- `app/deadlines/actions.ts:456` — document request to a driver, `meta: { companyId, driverId, regulationId }`
- `app/reminders/textActions.ts:151-175` — reminder fan-out over driver targets, `meta: { companyId, driverId }`
- `lib/signup/send.ts:114` — verification code, where `to` is neither a DB column nor a user: it is
  the phone on the **FMCSA census record** for the typed USDOT. This is precisely the send the
  outbound guard exists to stop.

So the answer, stated plainly: **`drivers.phone` is the intended SMS destination for the messaging
features that exist**, normalised through `toE164()` at each call site. `users.phone` is the
intended destination for the not-yet-built *user alert* channel gated by `users.notify_sms`.
`companies.phone` is not a messaging column at all. A re-implementation should keep the recipient
of an operational text (the driver) distinct from the recipient of an account notification (the
user) — they are different people with different consent, and consent is per-person.

---

### Re-implementation checklist

1. Build the guard **first**, with a production predicate that is not `NODE_ENV`, separate redirect
   variables per channel, and default-deny. Write both test files before wiring any provider.
2. Route every channel through exactly one send function, and put the guard, the unsubscribe header
   and the unsubscribe footer inside it — not at call sites. A future fifth email inherits all three
   by existing.
3. Never write `process.env` at runtime to vary a sender; pass it as a parameter.
4. Ship `List-Unsubscribe` and `List-Unsubscribe-Post` together, or neither, and always with a
   visible body link generated from the same token.
5. Log one row per recipient per message, including failures, with the recipient address stored in a
   tenant-scoped table and kept out of platform logs.
6. Keep the SMS provider behind an interface and a wrapper, with no env switch, until consent
   capture and a STOP webhook exist.

---

### Could not determine / open questions

- **Whether the Resend domain is actually verified**, and whether the production Vercel project has
  `RESEND_API_KEY` set. `.env.example` ships it empty and no live call was made. `docs/ROADMAP.md:243`
  lists it under "Blocked only on configuration".
- **Resend's exact error-body schema** is not documented anywhere in this repo, because the code
  never parses it — it captures `await res.text()` raw. The shape above
  (`{statusCode, message, name}`) is from Resend's published API, not from this codebase.
- **Whether `DIGEST_FROM_EMAIL` and `VERIFY_FROM_EMAIL` resolve to real mailboxes or send-only
  aliases.** `app/legal/constants.ts:67-70` names Cloudflare for "DNS and email routing for our
  domain", which suggests routing exists for `info@`, but nothing in code confirms it. Several
  comments describe `alerts@` as an address that "exists only to send" and which "nobody reads".
- **`lib/federal/alerts.ts`** was read only around `buildFederalEmail` (it was outside the assigned
  reading list). The subject/trigger rows for email #6 are accurate; I did not audit the rest of that
  module.
- **No live `.env` / `.env.local` was opened**, so no real key value was seen or could be leaked.


---

## 5. Supabase, persistence, cron and configuration

Repo: `/Users/bedopapajanian/Work/fleetview-legacy` (git worktree, `bfc65bb Checkpoint the Apple redesign before the rewrite`).
Stack: Next.js 16 App Router, Supabase (Postgres + Auth + Storage), Vercel Cron, Stripe, Resend, FMCSA (two distinct APIs).
Audience: a developer re-implementing this in a different application. Everything below is quoted from the repo; nothing is inferred DDL.

---

### 1. Supabase

#### 1.1 Dependencies and what is actually used

`package.json:22-31` declares both `@supabase/ssr ^0.12.4` and `@supabase/supabase-js ^2.111.0`, plus `drizzle-orm ^0.45.2` and `postgres ^3.4.9`.

**The real query path is the Supabase JS client (PostgREST) everywhere in `app/` and `lib/`. Drizzle is not used at runtime at all.**

- `db/schema.ts` (346 lines) is a typed Drizzle mirror and is **imported by nothing** — a repo-wide grep for `db/schema` and for `drizzle-orm` outside that file returns zero hits in `app/`, `lib/`, `utils/`, `scripts/`.
- `drizzle.config.ts:3-11` says so explicitly: *"the handwritten SQL in db/migrations/ is the source of truth … db/schema.ts is a typed mirror for querying, not a generator input. So: use drizzle-kit for `studio` and `introspect`. Do NOT run `drizzle-kit generate`."*
- The `postgres` driver is used only by `scripts/*.mjs` (migrate, seed, make-admin, test-rls, …) and by the three `*.live.test.ts` files — never by application code.

So: **PostgREST via supabase-js for the app; raw SQL over `DATABASE_URL` for migrations and operational scripts.**

#### 1.2 The four client constructions

| Where | Factory | Key used | Runs as |
|---|---|---|---|
| Browser | `utils/supabase/client.ts:12` `createClient()` | publishable | `authenticated` (user JWT) |
| Server Component / Server Action / route handler | `utils/supabase/server.ts:14` `createClient()` | publishable | `authenticated` (user JWT from cookies) |
| Middleware | `utils/supabase/middleware.ts:148` `updateSession()` | publishable | `authenticated` |
| Elevated | `lib/auth/service.ts:29` `serviceRoleClient()` | **service role** | `service_role`, bypasses all RLS |

**Browser client** — `utils/supabase/client.ts:12-15`:

```ts
export function createClient() {
  const { url, publishableKey } = supabaseEnv();
  return createBrowserClient(url, publishableKey);
}
```

Note: this factory has **zero call sites** in the current tree (grep for `createBrowserClient` / `utils/supabase/client` finds only the file itself). Every read in this app is a server read. Worth knowing if you port it — you may not need a browser client at all.

**Server client** — `utils/supabase/server.ts:14-39`, deliberately *not* service role (`utils/supabase/server.ts:8-13`):

```ts
export async function createClient() {
  const cookieStore = await cookies();
  const { url, publishableKey } = supabaseEnv();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch (err) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[supabase] could not set auth cookies:', (err as Error).message);
          }
        }
      },
    },
  });
}
```

42 files import it (`grep -rl "utils/supabase/server" app lib` → 42).

**Service-role client** — `lib/auth/service.ts:29-43`:

```ts
export function serviceRoleClient(): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set. It is required to create or remove ' +
        'logins, because Supabase auth tables are not reachable through RLS. Add it ' +
        'to .env.local and to Vercel — server-side only, never NEXT_PUBLIC_.',
    );
  }

  const { url } = supabaseEnv();
  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
```

The stated rules (`lib/auth/service.ts:13-27`): establish the caller first, use it only for the auth-schema write, never take `company_id` from a form. In practice it is used more widely than that doc comment claims — 25 call sites, including every path with no session: the cron (`app/api/cron/digest/route.ts:126`), the Stripe webhook (`app/api/stripe/webhook/route.ts:58`), unsubscribe (`app/api/unsubscribe/route.ts:39`), signed proof pages (`app/proof/[token]/page.tsx:63`), driver links (`app/u/[token]/page.tsx:36`), signup (`app/signup/actions.ts:190,268`), the public USDOT check (`app/check/actions.ts:66,276`), the login throttle (`app/login/actions.ts:30,46`), and error capture (`lib/errors/record.ts:31`).

The admin area builds its own service-role client inline *after* a two-step caller check — `lib/admin/guard.ts:55-84` (scoped read of `users.is_platform_admin` first, elevated client only at step 3).

**Env resolution** — `utils/supabase/env.ts:14-33` throws rather than degrading, because a no-op client would read as "everyone is signed out but pages still render" (`utils/supabase/env.ts:5-9`). It reads exactly two variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

#### 1.3 Middleware: session refresh and the public-path list

`middleware.ts:4-6` delegates everything to `updateSession`. The matcher (`middleware.ts:27`) excludes static assets, media and PWA assets:

```
'/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|apple-icon|icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|mp4|webm|ogg|woff2?|webmanifest)$).*)'
```

`utils/supabase/middleware.ts:148-185`:

```ts
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  const { url: supabaseUrl, publishableKey } = supabaseEnv();

  const supabase = createServerClient(supabaseUrl, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  // Do not put any logic between createServerClient and getUser().
  const { data: { user } } = await supabase.auth.getUser();

  if (!user && !isPublicPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
```

Three invariants worth carrying over verbatim:

1. **`getUser()`, never `getSession()`** — `getSession()` reads the cookie without verifying it (`utils/supabase/middleware.ts:143-146`).
2. **No logic between `createServerClient` and `getUser()`** — an early return leaves the session unrefreshed (`utils/supabase/middleware.ts:169-171`).
3. **Return `supabaseResponse` itself, unmodified** — copying it into a new response drops the refreshed cookies (`utils/supabase/middleware.ts:182-184`).

`PUBLIC_PATHS` (`utils/supabase/middleware.ts:9-108`) is an exported const so tests can assert every public nav link resolves. Its comments record **seven** production incidents where a missing entry silently 307'd a machine caller to `/login` — a redirect is a 2xx-shaped success to Vercel Cron, Stripe and Gmail, so the failure is invisible. Current list: `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/auth`, `/proof`, `/u`, `/privacy`, `/terms`, `/pricing`, `/how-it-works`, `/about`, `/docs`, `/api/cron`, `/api/stripe`, `/api/unsubscribe`, `/contact`, `/demo`, `/worksheet`, `/check`.

Matching is **segment-based, not prefix** (`utils/supabase/middleware.ts:134-137`):

```ts
export function isPublicPath(pathname: string): boolean {
  if (pathname === '/') return true;
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
```

Reason given (`utils/supabase/middleware.ts:116-132`): an omission fails *closed* (annoying, noticed); a prefix collision fails *open* (`/u` would open `/upload`, `/users`, `/usage`; `/check` would open `/checkout`).

Listing a path here does **not** make the endpoint public — the cron route still checks `CRON_SECRET`, the webhook still verifies the HMAC. It only lets the request reach that check.

#### 1.4 The per-request profile read

`lib/auth/session.ts:100-131` — `requireProfile()`, wrapped in React `cache()`, is the gate on every signed-in page. Two hard-won rules are encoded in the one `select`:

- **The FK is named explicitly**: `companies!users_company_id_fkey(...)`. PostgREST resolves an embed by searching relationships and fails with PGRST201/HTTP 300 the moment a second one exists. Migration 0030 added `companies.data_load_requested_by_user_id` → `public.users` and every signed-in page broke at once; 0031 moved that column to `auth.users` (`lib/auth/session.ts:113-121`).
- **Nothing optional goes in this select.** PostgREST answers an unknown column with a 400 for the whole query, so a column that exists in the repo but not yet in the database *logs everybody out* (`lib/auth/session.ts:122-127`).

#### 1.5 RLS posture

**`ENABLE` + `FORCE` on every table.** `db/migrations/0001_rls.sql:61-73`:

```sql
do $$
declare t text;
begin
  foreach t in array array[
    'companies','users','drivers','vehicles','compliance_events','documents',
    'custom_deadlines','regulation_verifications','share_links','import_batches','audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end$$;
```

Comment at `db/migrations/0001_rls.sql:59-60`: *"FORCE matters: without it the table owner (migration role, and anything that connects as it) silently bypasses every policy below."*

Later migrations FORCE RLS on 16 more tables individually: `alert_schedules`, `billing_events`, `check_leads`, `compliance_snapshots`, `contact_messages`, `custom_reminder_events`, `custom_reminders`, `driver_link_uploads`, `driver_links`, `error_reports`, `fmcsa_observations`, `notification_log`, `public_lookup_attempts`, `signup_verifications`, `tracking_preferences`, `usdot_trials`.

**Tenant resolution** — `db/migrations/0001_rls.sql:18-27`, `SECURITY DEFINER` to avoid policy recursion:

```sql
create or replace function app.current_company_id() returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'company_id', '')::uuid,
    (select u.company_id from public.users u where u.id = auth.uid())
  );
$$;
```

`app.current_role_name()` is the same shape (`0001_rls.sql:29-40`). `app.can_write()` started as a role check (`0001_rls.sql:43-45`) and was widened by `0055_billing_gate.sql:32-41`:

```sql
create or replace function app.can_write()
returns boolean
language sql
stable
as $$
  select app.current_role_name() in ('owner', 'office')
     and not app.current_company_is_demo()
     and not coalesce(app.company_is_lapsed(app.current_company_id()), false);
$$;
```

`app.company_is_lapsed(uuid)` (`0055_billing_gate.sql:6-21`) mirrors `lib/billing/access.ts` and resolves ambiguity to NOT lapsed, deliberately.

**Append-only enforcement** — policies restrict *who* may update; triggers restrict *what* may change (`db/migrations/0002_append_only.sql:7-8`). `0002` defines `app.enforce_event_append_only()`, `app.enforce_document_append_only()` and:

```sql
create or replace function app.block_delete() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only; deletion is not permitted', tg_table_name
    using errcode = 'restrict_violation';
end$$;
```
(`db/migrations/0002_append_only.sql:54-59`; triggers on `compliance_events`, `audit_log` delete+update, `documents`.)

`0060_block_write_message.sql:19-25` adds the operation-aware successor — **quote this one, it is the current recommended function**:

```sql
create or replace function app.block_write() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only; % is not permitted', tg_table_name, lower(tg_op)
    using errcode = 'restrict_violation',
          hint = 'Write a new row. Rows in this table are evidence of what was true on a date.';
end$$;
```

and re-points the `fmcsa_observations` triggers at it (`0060:27-36`):

```sql
drop trigger if exists fmcsa_observations_no_update on fmcsa_observations;
drop trigger if exists fmcsa_observations_no_delete on fmcsa_observations;

create trigger fmcsa_observations_no_update
  before update on fmcsa_observations
  for each row execute function app.block_write();

create trigger fmcsa_observations_no_delete
  before delete on fmcsa_observations
  for each row execute function app.block_write();
```

`app.block_delete()` is deliberately left in place for the three DELETE triggers that still use it (`0060:14-17`).

**The key design point**: these triggers are the only thing that constrains the *service role*. RLS does not apply to it, and the sweep writer holds that key (`0059_fmcsa_observations.sql:96-107`).

**Other database-side guards worth knowing**

- `app.guard_user_self_edit()` (`0001_rls.sql:104-…`): a non-owner cannot change their own `role` or `company_id`.
- `app.block_plan_change()` (`0054_billing.sql:49-77`): if `current_user in ('authenticated','anon')`, any change to `plan_tier`, `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `current_period_end`, `trial_ends_on`, `cancel_at_period_end`, `over_limit_notified_at` raises `42501`.
- `compliance_snapshots` has a SELECT policy and then `revoke insert, update, delete on public.compliance_snapshots from authenticated` (`0009:23`).
- `signup_verifications` has **no policies at all**, which makes it unreachable through PostgREST (`0032:20-22`).
- **Storage** is fenced by the same tenant function — `0001_rls.sql:224-239`:

```sql
insert into storage.buckets (id, name, public)
  values ('compliance-documents', 'compliance-documents', false)
  on conflict (id) do nothing;

create policy documents_storage_read on storage.objects for select to authenticated
  using (
    bucket_id = 'compliance-documents'
    and (storage.foldername(name))[1] = app.current_company_id()::text
  );

create policy documents_storage_write on storage.objects for insert to authenticated
  with check (
    bucket_id = 'compliance-documents'
    and (storage.foldername(name))[1] = app.current_company_id()::text
    and app.can_write()
  );
```

The first path segment **is** the tenant boundary, which is why path construction is a separately tested pure function (`lib/documents/upload.ts:1-9`).

**Uncertain / not in this repo:** `0001_rls.sql:15` refers to *"the custom access token hook"* that would put `company_id` into the JWT. No migration defines one; grep finds only that comment. It is presumably configured in the Supabase dashboard, or the `coalesce` fallback (a `public.users` lookup per statement) is what actually runs. Verify before relying on the claim path.

---

### 2. PostgREST constraints that shaped the code

These are not stylistic — each one has a named incident behind it.

#### 2.1 No `DISTINCT ON`

Cited in four places, all solved the same way: **order oldest-first and let the last write into a `Map` win.**

- `lib/federal/observations.ts:45-52` — *"PostgREST has no DISTINCT ON, and doing it in application code is cheaper than one query per source."*
  ```ts
  .select('source, observed_on, payload')
  .eq('company_id', companyId)
  .order('observed_on', { ascending: true });
  ```
- `lib/federal/sweep.ts:311-325` — same trick for "the newest digest we already hold, per carrier, for this source", one read for the whole sweep.
- `lib/federal/report.ts:302-305` — *"Oldest first from the query, so the last write into the map is the newest — a DISTINCT ON done in application code, because PostgREST has none."*
- The one place `DISTINCT ON` *is* used is raw SQL inside a migration backfill: `0063_fleet_counts_live.sql:86-95` and `:110-117`.

#### 2.2 No window functions

`lib/federal/alerts.ts:78-86` — "the newest two observations per source" cannot be one query:

> *"Two reads, because one cannot express 'the newest two per source'. PostgREST has no DISTINCT ON and no window functions, so the first read takes metadata only — id, source, date, no payload — which is small enough to take a lot of. The newest two ids per source are picked here, and only those payloads are fetched."*

Implementation: `select('id, source, observed_on')` ordered desc, limited to `METADATA_ROWS = 400` (`alerts.ts:55`); group in memory keeping the first two per source; then `select('id, source, observed_on, payload').in('id', ids)`.

#### 2.3 The `.upsert(...).select('id')` trick to count what landed

`lib/federal/sweep.ts:446-476`. With `ignoreDuplicates: true`, PostgREST emits `ON CONFLICT DO NOTHING`, so the number of rows *offered* is not the number *stored*:

```ts
const { data: inserted, error } = await db
  .from('fmcsa_observations')
  .upsert(pending, { onConflict: 'company_id,source,observed_on', ignoreDuplicates: true })
  .select('id');
...
summary.written = Array.isArray(inserted) ? inserted.length : 0;
if (summary.written < pending.length) {
  summary.reasons.push(
    `${pending.length - summary.written} observation(s) already recorded for ${today}; ` +
      'the change will be stored on the next run.',
  );
}
```

The comment at `:456-469` records why: reporting `pending.length` meant a second sweep in the same day reported "1 written" while writing nothing. Caught by a live test asserting the second run of the day is a no-op.

Same shape elsewhere: `app/api/unsubscribe/route.ts:46-59` (`.update(...).select('id').maybeSingle()` — a zero-row update is not an error to PostgREST, so a bad token lands as `data === null`), and `lib/fleet/adoptDiscoveredFleet.ts` (`.insert(rows).select('id')`).

The "zero-row write is not an error" trap is annotated at ~12 further call sites (`app/fleet/actions.ts:128`, `app/deadlines/actions.ts:219,577`, `app/settings/actions.ts:547`, `app/admin/actions.ts:409`, `app/fleet/dataLoad.ts:180`, `app/fleet/update/actions.ts:113`, …).

#### 2.4 `onConflict` cannot infer a partial index

`lib/notify/alerts.ts:250-267` (in `recordSent`) and the identical note at `lib/notify/scheduleStore.ts:322-340`:

> *"NO onConflict. That is not an omission — naming the columns is what broke this. 0042 made `notification_log_once` a PARTIAL index (`where trigger = 'auto'`). Postgres cannot infer a partial index from a bare column list, so `on conflict (company_id, item_key, subject_id, threshold_days, channel)` fails with 42P10 — every time, for every row. And it failed SILENTLY: the write is logged, not thrown, so the email went out and nothing was recorded… Dropping onConflict makes PostgREST emit a bare ON CONFLICT DO NOTHING, which needs no inference and therefore honours the partial index."*

So: `.upsert(rows, { ignoreDuplicates: true })` with **no** `onConflict` when the target index is partial.

#### 2.5 The server-side row cap (default 1000)

`lib/notify/logRead.ts:6-35`:

> *"PostgREST applies a server-side row cap to every select — Supabase ships it at 1000 by default (Settings → API → Max rows). A query that matches more rows than the cap does NOT error. It returns the first page and reports success, and there is nothing in the response to say anything was left out."*

Failure path described: a 12-truck carrier tracks ~140 obligations × six rungs, plus an unbounded overdue-repeat row per week — first real customer crosses 1000 rows within a year, the dedupe read comes back short, and alerts re-send forever.

The fix needs **both** narrowing and paging (`logRead.ts:29-35`). Page size is `const PAGE = 500` (`logRead.ts:47`), deliberately well under the cap so a short page means "that is all there is" rather than "the server truncated us"; the loop uses `.range(from, from + PAGE - 1)` (`logRead.ts:104`).

#### 2.6 Related non-PostgREST row limits

- Socrata page ceiling is 1000 and the portal **truncates silently** (`lib/federal/query.ts:55-56`, `lib/federal/sweep.ts:354-371`). The page block is never omitted — an unbounded query pulled 17,648 rows into a serverless function during testing (`lib/federal/query.ts:71-77`).
- `MAX_PAGES = 5` per batch as a runaway backstop; hitting it is reported because the stored history is then partial (`lib/federal/sweep.ts:195-203`, `:387-392`).
- No cross-statement transactions through PostgREST: *"Not a transaction. PostgREST has no cross-statement transaction"* (`app/fleet/update/actions.ts:105`), *"PostgREST gives one statement at a time"* (`lib/notify/scheduleStore.ts:81`).
- PostgREST only exposes the `public` schema — hence the `public.*` wrapper functions over `app.*` in `0006`, `0015`, `0016`, `0024`, `0025`.
- A to-one embed comes back as an object *or* an array depending on whether cardinality can be proven; accept both (`lib/auth/session.ts:147-150`, `lib/compliance/load.ts:495`, `lib/notifications/feed.ts:69`).

---

### 3. Schema of every table that stores third-party API data

#### 3.1 `fmcsa_observations` — the primary third-party store

Created by `db/migrations/0059_fmcsa_observations.sql:39-70`:

```sql
create table if not exists fmcsa_observations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,

  -- Which federal source, in our words rather than the portal's dataset id.
  source       text not null,

  -- The carrier's own calendar day, not the server's UTC one.
  observed_on  date not null,

  -- What the source actually said, parsed into our shape but not interpreted.
  payload      jsonb not null,

  -- Hash of payload. Compared against the newest row for this (company, source)
  -- to decide whether anything moved. Not unique on its own — see above.
  digest       text not null,

  created_at   timestamptz not null default now(),

  constraint fmcsa_observations_source_valid check (source in (
    'carrier',      -- 6eyk-hxee: authority per type, liability on file
    'filings',      -- qh9u-swkp: filings and scheduled cancellations
    'insurance',    -- c5y8-a4uz: filings with the insurer's name
    'authority',    -- yu5v-wbh6: when authority changed
    'revocation',   -- wb4f-neki: served date and effective date
    'oos',          -- p2mt-9ige: out-of-service orders
    'census',       -- az4n-8mr2: MCS-150 filing date, power units
    'inspections'   -- fx4q-ay7w: roadside history
  ))
);
```

Indexes (`0059:74-80`):

```sql
create unique index if not exists fmcsa_observations_per_day
  on fmcsa_observations (company_id, source, observed_on);

create index if not exists fmcsa_observations_latest_idx
  on fmcsa_observations (company_id, source, observed_on desc);
```

RLS and the append-only triggers (`0059:82-114`, superseded for the triggers by `0060`):

```sql
alter table fmcsa_observations enable row level security;
alter table fmcsa_observations force row level security;

create policy fmcsa_observations_select on fmcsa_observations for select
  using (company_id = app.current_company_id());
```

There is **no INSERT policy, on purpose** — rows are written by the cron under the service role; a signed-in user able to insert could fabricate "FMCSA said my authority was active on the 3rd" (`0059:86-92`).

`0062_qcmobile_source.sql:30-44` replaces the check constraint to add a ninth value:

```sql
alter table fmcsa_observations
  drop constraint if exists fmcsa_observations_source_valid;

alter table fmcsa_observations
  add constraint fmcsa_observations_source_valid check (source in (
    'carrier',      -- 6eyk-hxee: authority per type, liability on file
    'filings',      -- qh9u-swkp: filings and scheduled cancellations
    'insurance',    -- c5y8-a4uz: filings with the insurer's name
    'authority',    -- yu5v-wbh6: when authority changed
    'revocation',   -- wb4f-neki: served date and effective date
    'oos',          -- p2mt-9ige: out-of-service orders
    'census',       -- az4n-8mr2: MCS-150 filing date, power units
    'inspections',  -- fx4q-ay7w: roadside history
    'qcmobile'      -- QCMobile: safety rating, ISS score, operation, OOS rates
  ));
```

**Note the mismatch to carry forward:** the DB constraint allows nine values; the TypeScript `SweepSource` union (`lib/federal/sweep.ts:48-61`) has only seven — `'carrier' | 'filings' | 'oos' | 'revocation' | 'census' | 'inspections' | 'qcmobile'`. `'insurance'` (c5y8-a4uz) and `'authority'` (yu5v-wbh6) are permitted by the constraint but are **not** written by any code in this tree.

**Two design decisions to inherit:**

1. *Why not `unique (company_id, source, digest)`* — `0059:19-37`. Insurance goes on file, lapses, is refiled with identical terms: A → B → A. The third state hashes the same as the first, so the insert would be discarded and the history would claim cover never came back. "Is this different from what it was **last** time" is a comparison against the newest row, which no unique index expresses — so that check lives in application code (`lib/federal/sweep.ts:426`) and the index does the smaller job of one observation per source per carrier per day.
2. *Why this is not `compliance_events`* — `0059:3-17`. `compliance_events` means "the carrier did this thing" (an assertion an auditor may rely on); an observation means "the public record said this on this date". Merging them would let a government observation masquerade as the carrier's own compliance record.

**Alert identity for federal changes** — `0061_subject_type_federal.sql:35`:

```sql
alter type subject_type add value if not exists 'federal';
```

Rationale (`0061:3-30`): `notification_log` dedupes on `(company_id, item_key, subject_id, threshold_days, channel, recipient)`. A federal change has no countdown (every rung is 0) and no driver/truck subject, so every out-of-service order a carrier ever received would collide with the first and be silently discarded. The fix is to put the **observation id** in `subject_id`; the enum value exists so a reader does not conclude `subject_id` points at a vehicle. `item_key` stays a stable rule id (`'fmcsa:oos.ordered'`). Rejected alternative: putting the digest in `item_key` — unbounded cardinality breaks every read that groups by it. `ADD VALUE` runs inside the migration runner's per-file transaction (Postgres 12+); what is forbidden is *using* the new value in the same transaction, which nothing here does.

#### 3.2 `companies` columns populated from FMCSA

Base table: `db/migrations/0000_init.sql:16-35`.

```sql
create table companies (
  id              uuid primary key default gen_random_uuid(),
  legal_name      text        not null,
  dba             text,
  usdot           text,
  mc_number       text,
  ifta_account    text,
  address         jsonb       not null default '{}'::jsonb,
  phone           text,
  pm_interval_days integer    not null default 90
                    check (pm_interval_days between 1 and 3650),
  locale          text        not null default 'en',
  timezone        text        not null default 'America/Los_Angeles',
  jurisdictions   text[]      not null default array['FEDERAL','CA'],
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
```

FMCSA count columns — `0029_fmcsa_fleet_counts.sql:28-31` and `0063_fleet_counts_live.sql:50-51`:

```sql
alter table companies
  add column if not exists fmcsa_drivers integer,
  add column if not exists fmcsa_power_units integer,
  add column if not exists fmcsa_counts_at timestamptz;

alter table companies
  add column if not exists fmcsa_mcs150_filed_on date;
```

**Field → column map.** Two distinct APIs feed these.

| Column | API field | Source | Written by |
|---|---|---|---|
| `legal_name` | `legalName` | QCMobile `/carriers/{dot}` | `app/signup/actions.ts:384`, `app/admin/actions.ts:260` (insert only) |
| `dba` | `dbaName` | QCMobile | signup/admin insert; later **blank-fill only** via `lib/federal/enrich.ts:106` |
| `usdot` | typed by the user, validated against the lookup | — | signup |
| `mc_number` | `docket_number` | Socrata `6eyk-hxee` (`source='carrier'` observation) | `lib/federal/enrich.ts:155-184`, blank-fill only |
| `phone` | `phone` | Socrata `az4n-8mr2` census observation — **not** QCMobile, which has no phone field (`lib/federal/qcmobile.ts:176-181`) | `lib/federal/enrich.ts:108-111,129-146`, blank-fill only |
| `address` (jsonb `{street, city, state, zip}`) | `phyStreet`, `phyCity`, `phyState`, `phyZipcode` | QCMobile | insert only — **never refreshed**, see below |
| `jurisdictions` | derived from `phyState` (`state === 'CA' ? ['FEDERAL','CA'] : ['FEDERAL']`) | QCMobile | `app/signup/actions.ts:391` |
| `plan_tier` | derived from `totalPowerUnits` via `defaultTierForImport` | QCMobile | `app/signup/actions.ts:387-389` |
| `fmcsa_drivers` | `totalDrivers` | QCMobile (signup) / stored `qcmobile` observation (nightly) | `app/signup/actions.ts:392`, `lib/federal/refreshFleetCounts.ts:160-163` |
| `fmcsa_power_units` | `totalPowerUnits` (signup) / `power_units` (census) | QCMobile / `az4n-8mr2` | `app/signup/actions.ts:393`, `lib/federal/refreshFleetCounts.ts:124-128` |
| `fmcsa_counts_at` | signup timestamp (originally) / census `observed_on` (now) | — | `app/signup/actions.ts:394`, `refreshFleetCounts.ts:127,166` |
| `fmcsa_mcs150_filed_on` | `mcs150_date` | census `az4n-8mr2` | `lib/federal/refreshFleetCounts.ts:135-136` |

Column comments, rewritten by `0063:53-60`:

```sql
comment on column companies.fmcsa_drivers is
  'totalDrivers from QCMobile, refreshed nightly from the stored qcmobile observation. The federal half of the roster comparison — never a record count. Null until a federal read lands.';
comment on column companies.fmcsa_power_units is
  'power_units from the carrier''s MCS-150, refreshed nightly from the stored census observation. See fmcsa_drivers.';
comment on column companies.fmcsa_counts_at is
  'The observed_on of the federal observation the two counts above came from. Advances only when FMCSA''s numbers actually change, so it doubles as the re-arm signal for a dismissed roster prompt.';
comment on column companies.fmcsa_mcs150_filed_on is
  'mcs150_date from the census — when the carrier last filed, as opposed to when we last read it. The UI said "filed N months ago" off fmcsa_counts_at, which was the signup date.';
```

**The overwrite rule** (`lib/federal/enrich.ts:9-41`) is the single most transferable idea here:

- An observation may fill a field the carrier has **not** supplied, when FMCSA is the authority for that fact. Three qualify: `dba`, `mc_number`, `phone` — all three are FMCSA reporting on a filing the carrier made *to* FMCSA.
- It may never overwrite something they entered, and never silently satisfy an obligation they must prove.
- **The physical address deliberately does not qualify.** A federal address that disagrees with the carrier's own is *evidence their MCS-150 is stale* — a finding worth money. Overwriting ours would leave both records agreeing on something out of date and destroy the only signal.
- `hauls_placarded_hazmat` / `carries_passengers` are not filled either: those only ever ADD obligations (`0053`), so a federal `'N'` must not switch one off.
- `fmcsa_*` columns are exempt from the rule because they are the *federal half of a comparison*, prefixed and uneditable by any human in the app (`0063:18-22`, `refreshFleetCounts.ts:18-25`).

**Zero and null are refused** when refreshing counts (`lib/federal/refreshFleetCounts.ts:56-69`) because `fleetTarget` reads a non-positive expected count as "no target at all" and removes the progress bar entirely.

Also note `0063:24-31`: refreshed counts can move a published price tier with no action by the carrier (`lib/billing/dataLoad.ts` quotes off `fmcsa_power_units` when the roster is empty). Accepted knowingly and recorded so a future reader does not treat it as a bug.

#### 3.3 `vehicles` columns populated from FMCSA

Base table — `0000_init.sql:95-123`:

```sql
create table vehicles (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references companies(id) on delete cascade,
  unit_number          text not null,
  vin                  text,
  plate                text,
  plate_state          char(2),
  year                 integer check (year between 1900 and 2100),
  make                 text,
  gvwr                 integer check (gvwr > 0),
  registration_expires date,
  fuel_type            fuel_type,
  has_obd              boolean,
  is_agricultural      boolean     not null default false,
  is_motorhome         boolean     not null default false,
  is_active            boolean     not null default true,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index vehicles_company_active_idx on vehicles (company_id, is_active);
create unique index vehicles_active_unit_uniq
  on vehicles (company_id, unit_number) where is_active;
create unique index vehicles_active_vin_uniq
  on vehicles (company_id, vin) where is_active and vin is not null;
```

At signup only, `lib/fleet/adoptDiscoveredFleet.ts:136-147` inserts trucks discovered from the roadside-inspection chain:

| Column | API field | Dataset |
|---|---|---|
| `vin` | `insp_unit_vehicle_id_number` | `wt8s-2hbx` (`lib/fmcsa-inspections.ts:354`) |
| `make` | `insp_unit_make` | `wt8s-2hbx` (`:350`) |
| `plate` | `insp_unit_license` | `wt8s-2hbx` (`:352`) |
| `plate_state` | `insp_unit_license_state` | `wt8s-2hbx` (`:353`) |
| `unit_number` | `insp_unit_company`, validated, else last 6 of VIN | `wt8s-2hbx` (`:351`, gate at `adoptDiscoveredFleet.ts:94-112`) |

`year` and `gvwr` are **deliberately left null** (`adoptDiscoveredFleet.ts:30-43`): FMCSA publishes neither; `applicability.ts` treats a null GVWR as fully regulated (the conservative direction), and `insp_unit_company` is a unit number, not a model year — reading it as one was a real bug.

`unit_number` is validated against `PLAUSIBLE_UNIT = /^[A-Za-z0-9][A-Za-z0-9-]*$/` with `MAX_FLEET_NUMBER = 10` (`adoptDiscoveredFleet.ts:94-95`) because the roadside field also contains trailer reporting marks (`MCCZ 420778`) and configuration codes (`3X/WHI`).

After signup, new VINs are a **notice, never an automatic import** (`lib/federal/newVins.ts:22-30`): a roadside VIN might be rented, an owner-operator's, or sold last month.

#### 3.4 Other tables holding third-party-derived data

**`public_lookup_attempts`** — the public USDOT check (`0014_public_lookup_throttle.sql:1-7`, extended by `0016:1-6`):

```sql
create table if not exists public_lookup_attempts (
  id         bigserial primary key,
  ip_hash    text        not null,
  created_at timestamptz not null default now()
);
create index if not exists public_lookup_attempts_ip_time
  on public_lookup_attempts (ip_hash, created_at desc);

alter table public_lookup_attempts
  add column if not exists usdot text,
  add column if not exists found boolean;
create index if not exists public_lookup_attempts_usdot
  on public_lookup_attempts (usdot, created_at desc)
  where usdot is not null;
```

`found` = "whether FMCSA returned a carrier. Null until the lookup completes." (`0016:9-10`). Reached only through `public.record_public_lookup(text, text)` / `public.mark_public_lookup(bigint, boolean)`, both `security definer`, both granted to `service_role` only (`0016:50-70`). Default limit 12 per hour; rows are pruned after 90 days inside the function (`0016:26`).

**`check_leads`** — visitors who asked for their public check by email (`0052_check_leads.sql:1-13`); `snapshot jsonb` holds the FMCSA-derived result:

```sql
create table if not exists check_leads (
  id          uuid primary key default gen_random_uuid(),
  usdot       text        not null,
  email       text        not null,
  snapshot    jsonb       not null default '{}'::jsonb,
  ip_hash     text        not null,
  status      text        not null default 'queued'
                check (status in ('queued', 'sent', 'failed')),
  error       text,
  created_at  timestamptz not null default now()
);
```

**`signup_verifications`** — codes mailed to the contact FMCSA has on file (`0032:1-12`):

```sql
create table if not exists signup_verifications (
  id            uuid primary key default gen_random_uuid(),
  usdot         text not null,
  channel       text not null,
  code_hash     text not null,
  sent_to_mask  text,
  expires_at    timestamptz not null,
  attempts      integer not null default 0,
  consumed_at   timestamptz,
  ip_hash       text,
  created_at    timestamptz not null default now()
);
```

**`billing_events`** — the Stripe webhook ledger (`0054_billing.sql:25-35`):

```sql
create table if not exists billing_events (
  id            text        primary key,
  type          text        not null,
  company_id    uuid        references companies (id) on delete set null,
  payload       jsonb       not null default '{}'::jsonb,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);
create index if not exists billing_events_company on billing_events (company_id, received_at desc);
create index if not exists billing_events_unprocessed
  on billing_events (received_at) where processed_at is null;
```

The primary key is Stripe's own event id — that is the idempotency guarantee.

**`usdot_trials`** (`0054:38-44`) — one trial per USDOT, outliving the company row so deleting an account cannot reset it:

```sql
create table if not exists usdot_trials (
  usdot          text        primary key,
  started_on     date        not null default current_date,
  ends_on        date        not null,
  company_id     uuid        references companies (id) on delete set null,
  created_at     timestamptz not null default now()
);
```

**Stripe mirror columns on `companies`** (`0054:39-65`, `0056:28`):

```sql
alter table companies
  add column if not exists stripe_customer_id      text,
  add column if not exists stripe_subscription_id  text,
  add column if not exists subscription_status     text,
  add column if not exists current_period_end      timestamptz,
  add column if not exists trial_ends_on           date,
  add column if not exists cancel_at_period_end    boolean not null default false,
  add column if not exists over_limit_notified_at  timestamptz;

create unique index if not exists companies_stripe_customer_uniq
  on companies (stripe_customer_id) where stripe_customer_id is not null;
create unique index if not exists companies_stripe_subscription_uniq
  on companies (stripe_subscription_id) where stripe_subscription_id is not null;
create index if not exists companies_trial_ends_on
  on companies (trial_ends_on) where trial_ends_on is not null;

alter table companies
  add column if not exists stripe_quantity integer;
```

#### 3.5 First-party tables the cron reads and writes (for completeness)

**`users`** (`0000_init.sql:43-58`), plus `is_platform_admin` (`0004:20`), `unsubscribe_token` (`0057:31`), `fleet_prompt_dismissed_at` (`0063:73-74`):

```sql
create table users (
  id           uuid primary key references auth.users(id) on delete cascade,
  company_id   uuid        not null references companies(id) on delete restrict,
  email        citext      not null,
  full_name    text,
  role         user_role   not null default 'office',
  locale       text        not null default 'en',
  notify_email boolean     not null default true,
  notify_sms   boolean     not null default false,
  phone        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, email)
);

alter table users
  add column if not exists unsubscribe_token uuid not null default gen_random_uuid();
create unique index if not exists users_unsubscribe_token_uniq
  on users (unsubscribe_token);
```

**`notification_log`** (`0041:1-25`, amended by `0042` and `0058`):

```sql
create table if not exists notification_log (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  item_key       text not null,
  subject_type   subject_type not null,
  subject_id     uuid,
  threshold_days integer not null,     -- 0042 drops NOT NULL
  channel        text not null,
  recipient      text not null,
  status         text not null default 'sent',
  provider_ref   text,
  sent_at        timestamptz not null default now(),
  constraint notification_log_channel_valid check (channel in ('email', 'sms')),
  constraint notification_log_status_valid  check (status in ('sent', 'failed', 'skipped'))
);
```

`0042:22,27` adds `trigger text not null default 'auto'` (check: `'auto' | 'manual'`), makes `threshold_days` nullable with `check ((trigger = 'auto') = (threshold_days is not null))`, and makes the unique index partial. Final form, `0058:2-5`:

```sql
create unique index if not exists notification_log_once
  on notification_log (company_id, item_key, subject_id, threshold_days, channel, recipient)
  nulls not distinct
  where trigger = 'auto';
```

`nulls not distinct` matters: without it every null `subject_id` differs from every other, and company-level rules would alert every single day (`0041:26-33`).

**`compliance_snapshots`** (`0009:1-16`) — written by the cron, one row per carrier-day, `unique (company_id, taken_on)`.

---

### 4. Cron / scheduled jobs

#### 4.1 Declaration

`vercel.json` in full — schedules quoted verbatim:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    {
      "path": "/api/cron/digest",
      "schedule": "0 13 * * *"
    },
    {
      "path": "/api/cron/digest?send=1",
      "schedule": "0 14 * * 1"
    }
  ]
}
```

Vercel Cron schedules are UTC. `docs/BILLING.md:349` notes this lands "anywhere between 06:00 and 07:00 Pacific".

#### 4.2 The complete API-route inventory

`app/api/**` contains exactly four routes:

| Path | Methods | Caller | Auth | `maxDuration` | `runtime` |
|---|---|---|---|---|---|
| `/api/cron/digest` | GET | Vercel Cron | `CRON_SECRET` bearer, timing-safe, **404** on failure | `300` (`route.ts:53`) | default |
| `/api/stripe/webhook` | POST (GET → 405) | Stripe | HMAC over the raw body, `STRIPE_WEBHOOK_SECRET` | default | `nodejs` |
| `/api/unsubscribe` | GET + POST | Gmail/Yahoo one-click, humans | the `?t=` UUID token **is** the authorisation | default | `nodejs` |
| `/api/search` | GET | the signed-in app | session + RLS (`requireCarrierProfile()`) | default | `nodejs` |

(The only other `maxDuration` in the tree is `app/admin/fmcsa/page.tsx:11` — `60` — the staff-only live FMCSA probe page. It is not scheduled.)

#### 4.3 The cron job in detail

| | |
|---|---|
| **Route** | `app/api/cron/digest/route.ts` |
| **Schedules** | `0 13 * * *` (daily) and `0 14 * * 1` (Mondays, with `?send=1`) |
| **Auth** | `CRON_SECRET`, constant-time (`route.ts:82-93`), returns **404** not 401 (`route.ts:107-111`) |
| **Time budget** | `export const maxDuration = 300` (`route.ts:53`); self-imposed `TIME_BUDGET_MS = 240_000` (`route.ts:170`) |
| **Federal sub-budget** | `sweepFederalRecord(..., budgetMs = 60_000)` (`lib/federal/sweep.ts:499`) |
| **Return** | always 200, even with errors in the list (`route.ts:686-690`) — a non-200 makes Vercel retry the whole sweep and re-send every email that already went out |
| **`dynamic`** | `'force-dynamic'` |

Auth check, quoted (`route.ts:82-93`):

```ts
function authorised(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
```

**What one run does, in order** (`route.ts:106-690`):

| # | Stage | External API | Notes |
|---|---|---|---|
| 0 | Auth, resolve `siteUrlOrNull()`. `send` is false unless `?send=1` **and** `NEXT_PUBLIC_SITE_URL` is set | — | `route.ts:113-125` |
| 1 | List companies: `is_internal = false`, `deleted_at is null`, ordered `created_at` | — | `route.ts:128-140` |
| 2 | `reconcileBilling(db)` — repair drift against Stripe before anything trusts `subscription_status` | **Stripe** `api.stripe.com/v1` | never fatal (`route.ts:219-233`) |
| 3 | `sweepFederalRecord(...)` — batched Socrata sweep, **before** the per-carrier loop so tonight's alerts see tonight's observations | **`data.transportation.gov/api/v3/views`** | never fatal, 60s budget (`route.ts:249-268`) |
| 4 | Per carrier: trial reminder emails (before the paid gate, deliberately) | **Resend** | `route.ts:312-358` |
| 5 | Per carrier: skip if `!access.canSendAlerts` | — | `route.ts:360-363` |
| 6 | Per carrier: `syncQuantityForCompany` if `stripe_subscription_id` | **Stripe** | never fatal (`route.ts:376-397`) |
| 7 | Per carrier: `buildDashboard` + `scoreCompliance`, upsert `compliance_snapshots` on `(company_id, taken_on)`; skipped while `score.settingUp` | — | `route.ts:399-439` |
| 8 | Per carrier: threshold alerts — `loadSchedules` → `proposeAlerts` → `filterAlreadySent` → send → `recordSent` per recipient with the real outcome | **Resend** | every run, not only digest day (`route.ts:452-514`) |
| 9 | Per carrier, **Mondays only** (`federalDay.getUTCDay() === 1`): `enrichFromFederal` + `fillMcNumberFromCarrierObservation` | **FMCSA QCMobile** `mobile.fmcsa.dot.gov/qc/services` | `route.ts:526-539` |
| 10 | Per carrier: federal-change alerts as a **separate** email from deadline alerts | **Resend** (+ Socrata for the new-VIN check) | `route.ts:554-617` |
| 11 | Per carrier, `?send=1` only: the weekly digest | **Resend** | `route.ts:620-650` |
| 12 | After the loop, outside all its gates: `refreshFleetCounts(db, federalToday)` | — (reads today's stored observations) | `route.ts:673-682` |

**Cadence inside the sweep** (`lib/federal/sweep.ts:145-178`, `:481-486`):

```ts
const SOURCES: Record<BatchSource, SourceSpec> = {
  carrier:     { view: '6eyk-hxee', column: 'dot_number',   padded: true,  cadence: 'daily' },
  filings:     { view: 'qh9u-swkp', column: 'dot_number',   padded: true,  cadence: 'daily' },
  oos:         { view: 'p2mt-9ige', column: 'dot_number',   padded: false, cadence: 'daily' },
  revocation:  { view: 'wb4f-neki', column: 'usdot_number', padded: false, cadence: 'daily' },
  census:      { view: 'az4n-8mr2', column: 'dot_number',   padded: false, cadence: 'weekly' },
  inspections: {
    view: 'fx4q-ay7w', column: 'dot_number', padded: false, cadence: 'daily',
    batch: 25, orderBy: 'inspection_id',
    where: (today) => `insp_date > '${quarterAnchor(today)}'`,
  },
};

export function sourcesDue(today: string): BatchSource[] {
  const isMonday = new Date(`${today}T00:00:00Z`).getUTCDay() === 1;
  return (Object.keys(SOURCES) as BatchSource[]).filter(
    (s) => SOURCES[s].cadence === 'daily' || isMonday,
  );
}
```

`BATCH = 200` carriers per SoQL `IN` list; `PAGE_SIZE = 1000`; `MAX_PAGES = 5`; `NO_CACHE = 0` for the sweep (`sweep.ts:189-206`). Two of the seven files store `dot_number` **zero-padded to 8** — hence `padded` and `lib/federal/pad.ts`.

Deliberately **not** swept: `wt8s-2hbx` and `876r-jsdb`, keyed by `inspection_id` not by carrier, so they cannot batch across carriers (`sweep.ts:180-187`). And QCMobile, which answers about one carrier per call behind a rate-limited key (`0062:3-9`, `sweep.ts:55-61`).

**Time-budget behaviour worth copying** (`route.ts:146-167`, `:271-279`): the loop stops *on purpose* with a loud error rather than being killed mid-carrier, because the company list is ordered `created_at` ascending and stable — so the carriers dropped are always the same ones, the newest, i.e. exactly the cohort inside a 30-day trial. The error line names the shortfall and says "shard the sweep".

**Digest hash stability** (`sweep.ts:232-265`): Socrata's `:id`, `:version`, `:created_at`, `:updated_at` are regenerated on file *rebuild*, not on data change — every row of `6eyk-hxee` carried the same `:updated_at` on a day nothing changed. They are stripped before hashing *and* before storing (`stripMeta`), and per-row hashes are sorted before the final SHA-256 so row order cannot mark every carrier changed.

**Failure posture, stated as a rule** (`sweep.ts:37-45`): a source that could not be reached writes **nothing** rather than an empty observation. *"'FMCSA has no insurance on file for you' is a finding; recording it because a request timed out would be a lie with a date on it."* The same distinction is in the result type (`lib/federal/query.ts:16-22`): `ROWS` / `EMPTY` (a fact) / `ERROR` (not a fact).

#### 4.4 Known pending change to a schedule

`docs/HANDOFF.md:91-95`, §3.3 "Move the cron":

> `vercel.json` has `0 13 * * *`. `6eyk-hxee` and `qh9u-swkp` rebuild at 13:16–13:23 UTC, so the sweep reads yesterday's file by about sixteen minutes, every night. Not harmful — changes land a day late. One line.

So the intended fix is to move the daily cron to **after ~13:25 UTC**. It has not been made; `vercel.json` still reads `0 13 * * *`. Corroborating note in `lib/federal/query.ts:47-53`: the portal files are regenerated "most of them between 13:00 and 13:30 UTC, judging by the `:updated_at` on freshly pulled rows".

`docs/HANDOFF.md:104-113` also lists the four summary counters to watch on the first live runs: `federalWritten`, `federalAlertItems`, `federalAlertsSent`, `federalFilled` — "`federalAlertsSent` being anything but small is the failure mode worth catching early."

---

### 5. Complete environment-variable inventory

Every variable the code reads, grouped by integration. "Read at" cites the first non-test site.

#### Supabase

| Var | Purpose | Required | Read at | Failure without it |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL for all three clients | **Yes** | `utils/supabase/env.ts:15` | `supabaseEnv()` throws → middleware `MIDDLEWARE_INVOCATION_FAILED`; nothing renders |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…`; safe in the browser only because RLS is FORCEd | **Yes** | `utils/supabase/env.ts:16` | same |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS. Needed for auth-schema writes and every session-less path | **Yes in practice** | `lib/auth/service.ts:30`, `lib/admin/guard.ts:70` | `serviceRoleClient()` throws → signup, login throttle, cron, Stripe webhook, unsubscribe, proof pages, driver links and error capture all fail |
| `DATABASE_URL` | Session-pooler URI (port **5432**) | Tooling only | `scripts/migrate.mjs:51`, `drizzle.config.ts:17`, the three `*.live.test.ts` | `npm run db:migrate` exits 1. **Not read by the app at runtime.** |

`.env.example:15-18` is emphatic about which pooler: session pooler on 5432 — direct (`db.<ref>.supabase.co`) is IPv6-only and most home ISPs cannot reach it; the transaction pooler (6543) does not support the DDL these migrations need.

#### FMCSA

| Var | Purpose | Required | Read at | Failure without it |
|---|---|---|---|---|
| `FMCSA_WEBKEY` | QCMobile web key. **Never** `NEXT_PUBLIC_` | Yes for signup / `/check` / weekly enrich | `lib/fmcsa.ts:101`, `lib/federal/qcmobile.ts:52` | `lookupByUsdot` returns `{kind:'ERROR', reason:'FMCSA_WEBKEY is not set.'}`; signup and the public check cannot verify a USDOT; `enrichFromFederal` returns an error and stores no `qcmobile` observation |

The Socrata portal (`data.transportation.gov`) needs **no key** — `lib/federal/query.ts:44` and `lib/fmcsa-census.ts:10`. That is why the nightly sweep works with `FMCSA_WEBKEY` unset, but the Monday enrich step does not.

#### Site identity

| Var | Purpose | Required | Read at | Failure without it |
|---|---|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | Absolute base for proof links, driver links, email buttons, Stripe return URLs, `List-Unsubscribe` | Yes in production | `lib/site.ts:35` (+ `app/signup/actions.ts:20`, `app/settings/billing/actions.ts:20`, `lib/billing/webhookHandler.ts:153`, `lib/driverLink/mint.ts:26`, `lib/sms/messages.ts:31`, `lib/net/ip.ts:19`, `lib/notify/digest.ts:243`) | The cron logs `NEXT_PUBLIC_SITE_URL is not set; writing snapshots but sending no email` and `send` is forced false (`route.ts:118-125`); **all alert and digest sending is skipped** (`route.ts:452`) |
| `SITE_LAUNCHED` | `"true"` turns off `noindex/nofollow` | Optional | `app/layout.tsx:27` | Every page emits `noindex` |

`.env.example:37-39`: the base URL is deliberately **not** derived from the request `Host` header, because these links are pasted into emails to brokers and underwriters.

#### Email — Resend

| Var | Purpose | Required | Read at | Failure without it |
|---|---|---|---|---|
| `RESEND_API_KEY` | Bearer for `https://api.resend.com/emails` | Yes to send anything | `lib/notify/digest.ts:344`, `lib/signup/send.ts:80` | `sendEmail` returns `{ok:false, error:'RESEND_API_KEY or DIGEST_FROM_EMAIL is not set.'}`; snapshots still written, nothing mailed |
| `DIGEST_FROM_EMAIL` | Default `From:` (e.g. `FleetView <alerts@…>`) | Yes to send | `lib/notify/digest.ts:310,345`, `lib/signup/send.ts:79,92` | same |
| `VERIFY_FROM_EMAIL` | Separate `From:` for signup codes | Recommended | `lib/signup/send.ts:79` | Falls back to `DIGEST_FROM_EMAIL`; signup logs the code in dev and refuses in production (`.env.example:55-56`) |

Historical note worth carrying (`lib/notify/digest.ts:305-316`): the `from` address is a **parameter**, not an env read per call site. `lib/signup/send.ts` used to assign `process.env.DIGEST_FROM_EMAIL`, call, then restore in a `finally` — `process.env` is global to the Node process and Next serves concurrent requests in one, so an overlapping signup and cron run would have sent deadline alerts from `verify@`.

#### Outbound safety rail

| Var | Purpose | Required | Read at | Failure without it |
|---|---|---|---|---|
| `DEV_REDIRECT_EMAIL` | Non-production email recipient | Only outside production | `lib/outbound/guard.ts:69` | Every outbound email is **blocked** (`mode:'blocked'`), not delivered |
| `DEV_REDIRECT_PHONE` | Non-production SMS recipient | Only outside production | `lib/outbound/guard.ts:69` | Every outbound SMS is blocked |
| `VERCEL_ENV` | Platform-set: `production` / `preview` / `development`; unset locally | Set by Vercel | `lib/outbound/guard.ts:44`, `lib/billing/stripeEnv.ts:73` (via `isProductionSite`), `lib/fmcsa-sandbox.ts:122` | Treated as not-production: outbound is redirected or blocked, live Stripe keys are refused, FMCSA sandbox USDOTs are honoured |
| `NODE_ENV` | Standard | Platform | `utils/supabase/server.ts:33`, `lib/signup/send.ts:81,125` | — |

`lib/outbound/guard.ts:17-29` states the rule: **default is refuse.** *"A missing environment variable must never be the difference between 'went nowhere' and 'went to a stranger's phone'."* And `VERCEL_ENV`, not `NODE_ENV`, because `NODE_ENV` is `'production'` on preview deployments too.

This matters more here than in most apps: signup mails a verification code to the contact **FMCSA has on file for whatever USDOT was typed**, and only real USDOTs pass the lookup — so testing without a rail messages a stranger from the federal register. Three such rows already exist from testing (`lib/outbound/guard.ts:5-11`).

#### Scheduled job

| Var | Purpose | Required | Read at | Failure without it |
|---|---|---|---|---|
| `CRON_SECRET` | Bearer Vercel Cron sends automatically | **Yes** | `app/api/cron/digest/route.ts:83` | `authorised()` returns false unconditionally → every cron run gets a 404 and does nothing. Silently. |

Generate with `openssl rand -base64 32` (`.env.example:82`).

#### Stripe

| Var | Purpose | Required | Read at | Failure without it |
|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_` locally, `sk_live_` in production | Yes for billing | `lib/billing/stripeEnv.ts:57` | `stripeEnv()` throws "Stripe is not configured" at the first billing call |
| `STRIPE_PRICE_ID` | Monthly per-truck price; mode-bound. Lookup key `fleetview_monthly_per_truck` is the same in both modes | Yes for billing | `lib/billing/stripeEnv.ts:58` | same |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` for HMAC verification | Yes | `app/api/stripe/webhook/route.ts:44` | Every event fails signature verification → 400; subscriptions never mirror into `companies` |

`stripeEnv()` also **refuses wrong-mode keys in both directions** (`stripeEnv.ts:82-95`): a test key in production is the worse case because it is silent — Checkout appears to succeed and no money ever moves. And `assertNotPublic()` (`stripeEnv.ts:41-52`) throws if any `NEXT_PUBLIC_*STRIPE*` variable with `SECRET|KEY|TOKEN` in the name exists at all.

#### Twilio — declared, not wired

| Var | Purpose | Required | Read at |
|---|---|---|---|
| `TWILIO_ACCOUNT_SID` | — | No | `scripts/test-sms.mjs:86` only |
| `TWILIO_AUTH_TOKEN` | — | No | `scripts/test-sms.mjs:87` only |
| `TWILIO_FROM_NUMBER` | E.164 | No | `scripts/test-sms.mjs:88` only |

Nothing in `app/` or `lib/` reads these; setting them turns on no behaviour (`.env.example:85-89`). `lib/sms/provider.ts:1-12` returns a stub unconditionally and **no code reads `SMS_PROVIDER`** — deliberate, because a live adapter switchable by one variable would be reachable before driver consent capture and STOP handling exist.

#### Script-only / test-only

| Var | Read at | Notes |
|---|---|---|
| `DEMO_PASSWORD` | `scripts/seed-demo.mjs:38` | seeds the public demo carrier |
| `FV_BASE`, `FV_EMAIL`, `FV_PASSWORD` | `scripts/demo-capture.mjs:5-7` | screenshot capture |
| `LIVE_EMAIL_TO` | `lib/federal/__tests__/email.live.test.ts:28` | live-suite only; **not** in `.env.example` |

#### `.env.example` (copy-pasteable, placeholders only)

No `.env.local` exists in this worktree, so there are no real secret values to redact.

```dotenv
# --- Supabase: Project Settings -> Data API ---
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_XXXXXXXXXXXXXXXXXXXX

# service_role bypasses RLS completely. Server-side only, never NEXT_PUBLIC_.
SUPABASE_SERVICE_ROLE_KEY=sb_secret_XXXXXXXXXXXXXXXXXXXX

# --- Supabase: Connect -> SESSION pooler -> URI (port 5432, not 6543) ---
# Tooling only: scripts/migrate.mjs, drizzle-kit, the live test suite.
DATABASE_URL=postgresql://postgres.YOUR-PROJECT-REF:PASSWORD@aws-0-us-west-1.pooler.supabase.com:5432/postgres

# --- FMCSA QCMobile (https://mobile.fmcsa.dot.gov/QCDevsite -> My WebKeys) ---
# NO NEXT_PUBLIC_ PREFIX. The Socrata portal needs no key at all.
FMCSA_WEBKEY=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# --- Site URL (never derived from the Host header) ---
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# --- Email (Resend) ---
RESEND_API_KEY=re_XXXXXXXXXXXXXXXXXXXX
DIGEST_FROM_EMAIL=FleetView <alerts@example.com>
VERIFY_FROM_EMAIL=FleetView <verify@example.com>

# --- Outbound safety rail. UNSET = every message is BLOCKED outside production.
DEV_REDIRECT_EMAIL=you@example.com
DEV_REDIRECT_PHONE=+15550000000

# --- Scheduled job auth: openssl rand -base64 32 ---
CRON_SECRET=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# --- Stripe (sk_test_ locally; a live key outside production is refused) ---
STRIPE_SECRET_KEY=sk_test_XXXXXXXXXXXXXXXXXXXX
STRIPE_PRICE_ID=price_XXXXXXXXXXXXXXXXXXXX
STRIPE_WEBHOOK_SECRET=whsec_XXXXXXXXXXXXXXXXXXXX

# --- Twilio: NOT wired into the app. scripts/test-sms.mjs only. ---
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=

# --- Search indexing: anything but "true" emits noindex on every page ---
SITE_LAUNCHED=

# --- Local scripts only ---
DEMO_PASSWORD=
FV_BASE=
FV_EMAIL=
FV_PASSWORD=
```

---

### 6. Local dev setup

#### 6.1 Minimum to boot

From `README.md:26-33`:

```bash
cp .env.example .env.local        # fill in from the Supabase dashboard
npm run db:migrate:dry            # show pending migrations, apply none
npm run db:migrate                # apply them
npm run dev
```

Scripts (`package.json:6-21`): `dev`, `build`, `start`, `typecheck`, `test`, `test:live`, `test:watch`, `db:seed`, `db:migrate`, `db:migrate:dry`, `db:test-rls`, `test:unsubscribe`, `format`, `format:check`.

**Absolute minimum to render a signed-in page:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (login throttle and error capture both use it), plus `DATABASE_URL` once to run the migrations.

`scripts/migrate.mjs` loads `.env.local` itself (`:29-48`), uses the `postgres` package rather than `psql`, applies each file in filename order inside its own transaction, and records applied files with a checksum in `schema_migrations` (`:1-16`, `:62-78`). `npm run db:test-rls` is the cross-tenant isolation proof and **does** need real `psql` (`:5-7`, `README.md:44`). The dev server runs on port 3000 (`.claude/launch.json`).

Note `migrate.mjs:58-59`: TLS is `'require'` unless the URL is localhost.

#### 6.2 Running against real third-party APIs

| Integration | To exercise for real | Can it be stubbed? |
|---|---|---|
| **Socrata / DOT open data** (`data.transportation.gov`, sources `carrier`, `filings`, `oos`, `revocation`, `census`, `inspections`) | Nothing. **No key required.** | Not stubbed anywhere. It is free and public — the live tests deliberately hit it (`vitest.live.config.ts:10-19`). |
| **FMCSA QCMobile** (`mobile.fmcsa.dot.gov/qc/services`) | `FMCSA_WEBKEY` | **Yes, partially.** `lib/fmcsa-sandbox.ts` intercepts fixed 8-digit USDOTs beginning `999` inside `lookupByUsdot` (`lib/fmcsa.ts:136-137`) so the whole signup flow runs against a made-up carrier. **Local only** — `sandboxEnabled()` requires `VERCEL_ENV` unset or `'development'` (`fmcsa-sandbox.ts:120-124`), stricter than the outbound guard because preview deploys share the production database. Note the sandbox does **not** cover `qcMobileCarrier()` in `lib/federal/qcmobile.ts`, so the weekly enrich path still needs a real key. |
| **Resend** | `RESEND_API_KEY` + `DIGEST_FROM_EMAIL` | **Effectively yes.** With no `DEV_REDIRECT_EMAIL`, every send is blocked and logged with "would have gone to …". With one set, mail is redirected to you with a `[dev]` subject prefix and a banner. Both behaviours are the outbound chokepoint, not a mock. |
| **Stripe** | `sk_test_` + a test `STRIPE_PRICE_ID` + `STRIPE_WEBHOOK_SECRET` from the Stripe CLI | Partly: `scripts/stripe-setup.mjs` provisions the test product/price; a live key outside production is refused outright. Webhooks need `stripe listen --forward-to localhost:3000/api/stripe/webhook` (inferred from the secret's description at `.env.example:130-133`; the CLI command itself is not written down in the repo). |
| **Twilio** | `scripts/test-sms.mjs` only | Always stubbed in-app: `getSmsProvider()` returns the stub unconditionally (`lib/sms/provider.ts:6-12`). |
| **The cron** | `curl -H "Authorization: Bearer $CRON_SECRET" 'http://localhost:3000/api/cron/digest'` (add `?send=1` for the digest) | It is a plain GET; no Vercel needed. Without `NEXT_PUBLIC_SITE_URL` it writes snapshots and sends nothing — a useful half-dry-run. |

#### 6.3 What you can leave unset locally

- `SITE_LAUNCHED` — leave unset; every page emits `noindex`, which is what you want.
- `TWILIO_*` — no behaviour at all.
- `VERIFY_FROM_EMAIL` — falls back to `DIGEST_FROM_EMAIL`.
- `NEXT_PUBLIC_SITE_URL` — safe to omit while you are not testing links or email; the cron degrades loudly rather than silently.
- `STRIPE_*` — only the billing pages and the webhook throw.

#### 6.4 Live test suite

`npm run test:live` (`vitest.live.config.ts`) runs only `**/__tests__/**/*.live.test.ts`, loads `.env.local` itself (Vitest does not, Next does), uses a 120s timeout and `fileParallelism: false`. It needs `DATABASE_URL` and, for `email.live.test.ts`, `DEV_REDIRECT_EMAIL` / `LIVE_EMAIL_TO`. The rationale at `vitest.live.config.ts:8-19` is worth keeping: *"Every trap in lib/federal was found by querying the live portal and comparing what came back against what the column name implied — dot_number padded to 8 in two files of seven, MM/DD/YYYY in one, coverage in thousands here and dollars there, :updated_at changing on every rebuild. A mocked test can only assert what we already believe."*

---

### Appendix A — Full migration list

`db/migrations/` holds **65 files** (note two share the `0024` prefix: `0024_company_delete.sql` and `0024_document_delete.sql` — filename sort still gives a deterministic order, `company` before `document`).

```
0000_init                       0022_share_link_access_token    0044_alert_schedules_empty_ladder
0001_rls                        0023_share_link_attestation     0045_vehicle_usual_driver
0002_append_only                0024_company_delete             0046_usual_driver_delete_fix
0003_grant_app_schema_usage     0024_document_delete            0047_alert_schedules_updated_at
0004_platform_admin             0025_delete_document_rpc        0048_contact_messages
0005_login_throttle             0026_document_file_removal      0049_demo_company
0006_login_throttle_rpc         0027_document_removed_by_fk     0050_demo_owner_paths
0007_fix_review_findings        0028_hard_delete_documents_...  0051_insurance
0008_close_admin_escalation     0029_fmcsa_fleet_counts         0052_check_leads
0009_compliance_snapshots       0030_data_load_request          0053_operation_profile
0010_admin_guard_runs_as_caller 0031_data_load_by_auth_user     0054_billing
0011_plan_tier                  0032_signup_verification        0055_billing_gate
0012_plan_tier_admin_writable   0033_tracking_preferences       0056_billed_quantity
0013_admin_carrier_summary      0034_driver_links               0057_unsubscribe_token
0014_public_lookup_throttle     0035_driver_link_phone          0058_notification_log_recipient
0015_public_lookup_rpc          0036_link_review_outcome        0059_fmcsa_observations
0016_lookup_records_usdot       0037_driver_link_expiry_default 0060_block_write_message
0017_error_reports              0038_driver_link_photos         0061_subject_type_federal
0018_error_path_strips_query    0039_custom_reminders           0062_qcmobile_source
0019_internal_company           0040_reminders_all_subjects     0063_fleet_counts_live
0020_group_client_errors        0041_notification_log
0021_share_link_scope           0042_notification_log_manual
                                0043_alert_schedules
```

Third-party-data migrations: **0029** (fleet counts), **0059** (observations table), **0060** (`app.block_write()`), **0061** (`subject_type` += `federal`), **0062** (`qcmobile` source), **0063** (live counts + `fmcsa_mcs150_filed_on` + backfill). Supporting: **0014/0015/0016** (public lookups), **0032** (signup codes), **0052** (check leads), **0054/0055/0056** (Stripe).

### Appendix B — External endpoints called

| Base URL | Auth | Called from | Cache |
|---|---|---|---|
| `https://data.transportation.gov/api/v3/views/{view}/query.json` | none | `lib/federal/query.ts:44,90` (POST, SoQL body), `lib/fmcsa-inspections.ts:40` | `next.revalidate` default 21600s (6h); the sweep passes `0` |
| `https://data.transportation.gov/resource/az4n-8mr2.json` | none | `lib/fmcsa-census.ts:18` | — |
| `https://mobile.fmcsa.dot.gov/qc/services/carriers/{dot}?webKey=` | `FMCSA_WEBKEY` | `lib/fmcsa.ts:17,107`; `lib/federal/qcmobile.ts:33,61` | `revalidate: 3600` in `fmcsa.ts`; none in `qcmobile.ts` |
| `https://mobile.fmcsa.dot.gov/qc/services/carriers/name/{name}` | `FMCSA_WEBKEY` | `lib/fmcsa.ts:163` | `revalidate: 3600` |
| `https://api.resend.com/emails` | `RESEND_API_KEY` bearer | `lib/notify/digest.ts:351` | 10s timeout |
| `https://api.stripe.com/v1/{path}` | `STRIPE_SECRET_KEY` bearer, form-encoded | `lib/billing/stripe.ts:97` | — |

Timeouts: Socrata 20s (`query.ts:46`) / 25s (`fmcsa-inspections.ts:59`); QCMobile 15s (`fmcsa.ts:112`, `qcmobile.ts:34`); Resend 10s (`digest.ts:396`).

### Appendix C — Things I could not determine from the repo

1. **The custom access token hook.** `0001_rls.sql:15` says the JWT `company_id` claim is "preferred (no per-statement table hit)" with the `public.users` lookup as a fallback, but no migration creates the hook. It is either configured in the Supabase dashboard or never shipped — in which case every RLS check pays for a `users` lookup.
2. **Whether `'insurance'` (c5y8-a4uz) and `'authority'` (yu5v-wbh6) observations were ever written.** The DB constraint allows both (`0062:34-44`); the `SweepSource` union (`sweep.ts:48-61`) and the `SOURCES` map (`sweep.ts:145-178`) do not include them, and no other writer exists. Possibly historical, possibly planned.
3. **The Stripe CLI command for local webhooks.** Implied by `.env.example:130-131` but not written down.
4. **Supabase project-level settings** — the actual `max-rows` value, Auth email templates, redirect allow-list, storage limits. `logRead.ts:9` assumes the 1000 default.
5. **`docs/FMCSA-PLAN.md` phase status.** It describes a six-phase plan; I read only the cron-relevant lines (`:235-282`) and did not verify which phases the current code corresponds to.
6. **Why `lib/notify/alerts.ts` is detected by `file(1)` as binary `data`** rather than text — it contains a byte sequence that makes plain `grep` skip it (use `grep -a`). Could be a stray control character; I did not modify the file to find out.


---
## 6. Open questions and defects this audit found

Writing this document meant reading every integration end to end, which surfaced things nobody was
looking for. They are recorded here rather than silently fixed, because this is a knowledge-transfer
document and the receiving developer needs to know which ground is solid.

### 6.1 Defects in the current codebase

None of these are fixed. Each one is real and each one was verified.

| # | Where | What is wrong | Impact |
|---|-------|---------------|--------|
| 1 | `lib/federal/refreshFleetCounts.ts:142-146` | Comment claims the census has no total-driver column. It does: `total_drivers`, `total_cdl`, `driver_inter_total`. **Verified live 2026-09-14.** | A usable sanity-check signal is left on the table for a stated reason that is false. See 6.2. |
| 2 | Checkout, `lib/billing/stripe.ts` | The one-time data-load fee that `docs/BILLING.md` section 2.4 specifies as a separate line item **is not implemented**. Checkout sends one line item; `lib/billing/dataLoad.ts` only quotes a price. | Revenue specified but never charged. |
| 3 | `lib/billing/quantitySync.ts` | Idempotency key is `qty:${sub}:${quantity}`. A same-day quantity flip-flop (5 to 6 and back to 5) replays a key Stripe has already seen, so Stripe returns the **cached** response without applying the change. | Subscription quantity silently diverges from truck count. |
| 4 | Migration 0055 | References `scripts/stripe-reconcile.mjs`, which **does not exist**. | A documented recovery path that cannot be run. |
| 5 | `scripts/stripe-setup.mjs` | Sends no `Stripe-Version` header, so it floats on the account default while everything else is pinned; its local `form()` helper would also mis-encode an array of scalars. | Setup script can drift from the pinned API version. |
| 6 | `lib/federal/probe.ts:400` | Passes `c5y8-a4uz.max_cov_amount` through `thousandsToDollars()`, but the live test at `portal.live.test.ts:231-240` establishes that this dataset already stores **dollars**. | Insurance amounts on that path come out 1000x too small. |
| 7 | `lib/notify/alerts.ts:184` | Two **raw NUL bytes** sit in a template literal as a key separator. | The file is classified as binary, so plain `grep` skips it silently, as do many diff and review tools. Runtime behaviour is fine. Write the separator as the escape `\u0000` instead of an actual control byte. |
| 8 | SMS message bodies, `lib/sms/messages.ts` | Every body promises "Reply STOP", but **no inbound route exists** anywhere in the app. | Ships a promise the system cannot keep, and blocks A2P registration. |

Items 2, 3 and 8 are the ones that cost money or credibility. Item 7 is a five-character fix that makes
the file greppable again.

To see item 7 for yourself, note that this is the only file in the repo where the first command prints
nothing and the second prints a match:

```bash
grep -n 'subjectId' lib/notify/alerts.ts        # silent: grep treats the file as binary
grep -an 'subjectId' lib/notify/alerts.ts       # matches
```

### 6.2 Correction to a long-standing assumption

#### Correction: the census DOES expose driver counts (but sparsely)

`lib/federal/refreshFleetCounts.ts:142-146` states the census has no total-driver column. That is wrong.
Verified live on 2026-09-14 against `az4n-8mr2`:

| USDOT | legal_name | total_drivers | total_cdl | driver_inter_total |
|-------|-----------|---------------|-----------|--------------------|
| 344554 | HULL COOPERATIVE ASSOCIATION | `30` | `30` | `30` |
| 1234567 | ARTHUR J KENYON | `2` | `0` | `0` |
| 2194444 | DAVID RODRIGUEZ | *absent* | *absent* | `0` |

Three things a re-implementer must know:

1. **The columns exist**: `total_drivers`, `total_cdl`, `driver_inter_total`.
2. **They are sparse, and Socrata omits null keys entirely** — the field is not `null`, it is *missing from
   the JSON object*. `row.total_drivers` is `undefined`, not `null`. Any code doing `row.total_drivers ?? 0`
   will quietly report zero drivers for a carrier that simply never filed the number.
3. **They disagree with each other.** USDOT 1234567 reports 2 total drivers and 0 CDL holders. These are
   self-reported MCS-150 figures, not verified counts, and they go stale for years between biennial filings.

So the practical caution behind the original comment is sound — you cannot build a driver roster from this —
but the stated reason is inaccurate. Use it as a *hint* for "does the roster the owner entered look
roughly right", never as a source of truth. This remains distinct from **per-driver** data, which genuinely
does not exist in any public FMCSA source.

### 6.3 Unresolved questions

Answer these before relying on the affected area. Each is a genuine gap, not a caveat.

**FMCSA Socrata**

- Seven datasets were documented from code and test assertions but **not verified live** within the call
  budget: `wt8s-2hbx`, `876r-jsdb`, `qbt8-7vic`, `p2mt-9ige`, `wb4f-neki`, `c5y8-a4uz`, `yu5v-wbh6`.
  Each is labelled as such in section 1. Probe them before trusting a field name.
- `insp_viol_unit`, named in `docs/FMCSA-PLAN.md:15-16`, is read nowhere in code. Existence unverified.
- Whether a blank `X-App-Token` header really 403s on every request (recorded at `docs/ROADMAP.md:813-816`)
  was not re-tested. The safe behaviour, omitting the header entirely when unset, is what the code does.

**QCMobile**

- **Field count disagrees with itself**: five code and comment sites say the carrier record has 53 fields;
  `docs/FMCSA-PLAN.md:146` says 54. Both agree 19 are mapped. Count a live response before quoting either.
- `safetyRatingDate` wire format is unverified. The only evidence is a unit-test literal `'2024-03-01'`;
  the code never parses it, only renders it. Sibling FMCSA sources use `YYYYMMDD HHMM` and `MM/DD/YYYY`,
  so **parse defensively**.
- The placarded-hazmat field name is unestablished. `lib/federal/enrich.ts:38` says QCMobile knows both
  hazmat and passengers, but only `isPassengerCarrier` appears anywhere in the repo.
- Whether the response envelope carries sibling keys beside `content` (retrieval date, links) is unknown,
  because no code reads anything else.
- The numeric rate limit is unknown. The repo asserts one exists and it drove the no-batching architecture
  and the weekly cadence, but never states requests per minute or per day.

**Stripe**

- Whether the live account's price was actually created with the ten documented tiers. `STRIPE_PRICE_ID`
  is not committed, and the eight middle tier rows are computed by `stripeTiersFor()` rather than asserted.
- Every sample JSON response in section 3 is a **reconstruction** of the shape the code reads. There are no
  captured response fixtures in the repo. Verify against a real test-mode response before depending on a field.
- The Stripe CLI command for local webhook forwarding is implied by `.env.example:130-131` but written
  down nowhere.

**Supabase and platform**

- The **custom access token hook** referenced at `0001_rls.sql:15` is defined in no migration. It is either
  configured in the Supabase dashboard, or it never shipped, in which case every RLS check pays for a
  `public.users` lookup instead of reading a JWT claim. **Check the dashboard.** This has performance and
  correctness implications for every query in the app.
- Whether `'insurance'` (`c5y8-a4uz`) and `'authority'` (`yu5v-wbh6`) observations were **ever written**.
  Both are permitted by the DB check constraint but absent from the `SweepSource` union and the `SOURCES`
  map, and no other writer exists. They may be dead enum values.
- Project-level Supabase settings (the real `max-rows`, auth templates, redirect allow-list) were not
  inspected. `lib/notify/logRead.ts` assumes the 1000 default.

**Email and SMS**

- Whether the Resend sending domain is verified and the production key set. Not checked; no live call made.
- Resend's exact error-body schema, because the code stores `await res.text()` raw rather than parsing it.
- Whether the three From addresses are real mailboxes or send-only aliases. This matters: `reply_to` is set
  on some mail, and a customer replying to a send-only alias vanishes into nothing.

### 6.4 How this document was produced

Five parallel agents each read one integration end to end, with instructions to quote real identifiers,
cite `file:line` for every non-obvious claim, and state uncertainty rather than guess. Four live calls were
made to `data.transportation.gov` (no key required); those rows are marked "verified live on 2026-09-14".
No live call was made to QCMobile, Stripe or Resend, and no secret value was read or printed.

Where an agent's finding contradicted a repo comment or one of my own earlier statements, the contradiction
is recorded above rather than resolved by preference. Two are worth restating because they contradict things
said elsewhere in the project's own docs:

- `SITE_LAUNCHED` is **not** part of the outbound guard. Its single reader is `app/layout.tsx:27`, and it
  controls search-engine indexing only. Do not rely on it to stop mail.
- `drivers.phone` is what every built SMS path targets. `users.phone` is for the unbuilt user-alert channel
  gated by `users.notify_sms`, and `companies.phone` is not a messaging column at all.
