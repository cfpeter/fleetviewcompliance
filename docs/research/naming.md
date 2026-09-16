# Naming Research — CA Small-Fleet Compliance + Dispatch SaaS

Date: 2026-09-14

**Product recap:** web app for CA fleet owners (5–50 trucks). Compliance deadlines (DOT/CARB/CHP/IFTA),
orders/loads, trips/dispatch, email + SMS alerts incl. custom alerts, auto-pull carrier record from USDOT #.
Audience: heavily immigrant-owned family businesses, Glendale / Burbank / Sun Valley. Name must survive being
said over the phone and spelled aloud by a non-native English speaker.

---

## 0. Method + honest limits on verification

Read this before trusting any cell in the tables.

| Check | How it was done | Confidence |
|---|---|---|
| Domain availability | **Registry-direct WHOIS** (`whois.verisign-grs.com` for .com, `whois.nic.google` for .app, `whois.nic.io` for .io), every "AVAILABLE" re-run a second time | **HIGH — verified** |
| Live site / squatter check | `curl` HTTP status + `<title>` on each taken domain | **HIGH — verified** |
| Existing company in trucking/logistics/fleet | Web search. **Budget exhausted after 4 queries** (200/200 session cap) | **MIXED — see per-name notes** |
| USPTO trademark register | Attempted `tmsearch.uspto.gov` API, `trademarks.justia.com`, `uspto.report` — all returned 403 / Cloudflare or CAPTCHA challenges. **I did not attempt to bypass any CAPTCHA.** | **UNVERIFIED for every name** |
| Armenian / Russian / Spanish meaning | Linguistic reasoning, not native-speaker review | **MEDIUM — treat as a flag list, not a clearance** |

Two consequences you should act on:

1. **No name here is trademark-cleared.** Every trademark cell reads UNVERIFIED. Before you spend money on
   a name, run it yourself at <https://tmsearch.uspto.gov> in classes **009** (downloadable/recorded software)
   and **042** (SaaS) — those are the two that matter for this product — and ideally have a TM attorney do a
   knockout search.
2. **The .com market for this vocabulary is effectively closed.** I ran ~150 candidate .coms registry-direct.
   **Five** were available. That's the single most important finding below and it drove the ranking.

---

## 1. The 20 candidates

### Plain-descriptive
1. **CarrierDesk**
2. **TruckDesk**
3. **ComplyFleet**
4. **FleetRenew**
5. **HaulDesk**

### Compound-word
6. **RigDesk**
7. **RoadBook**
8. **MileMark**
9. **LaneKeeper**
10. **TruckLane**

### Short-invented
11. **Kamion**
12. **Camino**
13. **Tramo**
14. **Vialo**
15. **Haulo**

### Metaphor-from-trucking
16. **Milepost**
17. **TripSheet**
18. **Kingpin**
19. **Blacktop**
20. **Backhaul**

Two late additions surfaced by the availability sweep (they were not in the original 20 but outperformed most
of it, so they are carried into the shortlist): **CarrierYard**, **CarrierNote**, plus **TruckClock**,
**RigRenew**, **CarrierRoom**.

---

## 2. Verification detail on the 10 strongest

### Domain results (registry-direct WHOIS, 2026-09-14)

| Name | .com | .app | .io | Live site at the .com? |
|---|---|---|---|---|
| CarrierDesk | TAKEN | **AVAILABLE** | **AVAILABLE** | HTTP 200 but **blank page, no title, no business** |
| RigDesk | TAKEN | **AVAILABLE** | **AVAILABLE** | HTTP 000 — **dead, no site** (Wild West Domains = GoDaddy reseller; parked) |
| TruckDesk | TAKEN | AVAILABLE | AVAILABLE | **HTTP 200 — live site titled "Truck Desk"** |
| TruckLane | TAKEN | AVAILABLE | AVAILABLE | **HTTP 200 — live "Truck Lane Logistics"** |
| ComplyFleet | TAKEN | AVAILABLE | AVAILABLE | HTTP 200 — **blank default WordPress install** ("Hello World", Mar 2026) |
| FleetRenew | TAKEN | **AVAILABLE** | **AVAILABLE** | HTTP 000 — dead |
| RoadBook | TAKEN | AVAILABLE | TAKEN | **HTTP 200 — "ROADBOOK: city guides, travel, photography"** |
| Milepost | TAKEN | AVAILABLE | TAKEN | HTTP 000 — dead |
| Tramo | TAKEN | AVAILABLE | TAKEN | HTTP 200 — **"BrandPortal" domain-for-sale page** |
| Vialo | TAKEN | AVAILABLE | TAKEN | HTTP 200 — placeholder |
| **CarrierYard** | **AVAILABLE** | **AVAILABLE** | **AVAILABLE** | — |
| **CarrierNote** | **AVAILABLE** | **AVAILABLE** | **AVAILABLE** | — |
| **TruckClock** | **AVAILABLE** | **AVAILABLE** | **AVAILABLE** | — |
| **RigRenew** | **AVAILABLE** | **AVAILABLE** | **AVAILABLE** | — |
| **CarrierRoom** | **AVAILABLE** | **AVAILABLE** | **AVAILABLE** | — |

Also confirmed TAKEN on both .com and .io (so, dead ends): MileMark, LaneKeeper, Kamion, Camino, HaulDesk,
Haulo, TripSheet, Blacktop, Kingpin, Backhaul, MileMarker.

> Note on method: an early pass using bare `whois` produced a **false "available"** for milemarker.com
> (actually registered since 1995) because it did not follow the IANA referral. Every availability claim in
> this document was re-checked registry-direct and then confirmed a second time. Do not reuse the first-pass
> numbers.

### Company / product conflicts

| Name | Finding | Verified? |
|---|---|---|
| **Kamion** | **HARD CONFLICT — eliminate.** Three separate collisions: (a) *Kamion Software Co.*, a trucking TMS doing dispatch, driver management, accounting, safety checks and fleet visibility — i.e. **this exact product** — acquired by Loadsmart Nov 2021, now Loadsmart Carrier TMS; (b) *Kamion*, Istanbul FTL freight marketplace, founded 2020; (c) *Kamion Logistics*, North American 3PL. | **VERIFIED via search** |
| **CarrierDesk** | No trucking/logistics/fleet software product found. The .com is registered but serves a blank page. | VERIFIED via search (1 query) |
| **RigDesk** | No trucking product found. **Adjacency risk:** *Rigbooks* (rigbooks.com) is trucking software for owner-operators and small fleets — same segment, same "Rig-" prefix. | VERIFIED via search (1 query) |
| **Milepost / MileMark** | No trucking software company surfaced. | VERIFIED via search (1 query) |
| **TruckLane** | *Truck Lane Logistics* operating at trucklane.com. Logistics sector. | VERIFIED via HTTP |
| **TruckDesk** | Live site branded "Truck Desk". Nature of business not established. | VERIFIED via HTTP |
| **ComplyFleet** | Domain held with an empty WordPress install — someone has claimed the name but is not trading. Separately, "Comply" + "Fleet" is a purely descriptive phrase and would be a **weak, hard-to-defend mark**. | VERIFIED via HTTP |
| **RoadBook** | ROADBOOK is an active travel/city-guide publication. Different class, but it owns the search results. Also "roadbook" is a generic rally-raid term. | VERIFIED via HTTP |
| CarrierYard, CarrierNote, TruckClock, RigRenew, CarrierRoom | **No conflict check possible — search budget exhausted.** Domain-level evidence only (all three TLDs unregistered, which is itself weak positive evidence that no one is trading under the name). | **UNVERIFIED** |

### Trademark

**UNVERIFIED for all 10.** USPTO's TESS replacement is a JavaScript SPA whose API rejected direct requests,
and the two public mirrors (Justia Trademarks, uspto.report) both returned Cloudflare bot challenges. No
trademark conclusion in this document should be relied on.

### Say-it-aloud / spell-aloud notes

| Name | Spoken | Spelling risk when read over the phone |
|---|---|---|
| CarrierDesk | 4 syllables, clean stress | **Double-R.** Spanish speakers handle "rr" natively (it's a distinct phoneme) — Armenian and Russian speakers are the ones likely to write "carier". Say "carrier, two R's". |
| CarrierYard | 3 syllables | Same double-R. "Yard" is safe — *la yarda* is everyday Spanglish in LA trucking and means exactly the truck yard. |
| RigDesk | 2 syllables, shortest, hardest consonants — best pure phone clarity | Almost none. R-I-G-D-E-S-K, no ambiguous vowels. **But:** "rig" is US trucker slang that an immigrant owner may not map to "truck", and in software naming "rig" skews oil-and-gas. |
| CarrierNote | 4 syllables | Double-R; "note" is trivial (*nota*). |
| TruckClock | 2 syllables, rhyming, memorable | **"ck" twice.** Spanish has no "ck" cluster; expect "trukclok". Moderate risk. |
| RigRenew | 3 syllables | Ends on **W** — the single hardest letter to say aloud for Spanish ("uve doble"), Armenian and Russian speakers. Also invites "renue". |
| FleetRenew | 3 syllables | Same trailing W. Plus "fleet"/"flee"/"flight" confusion for some speakers. |
| CarrierRoom | 3 syllables | Double-R twice over ("carrier" + "room"). |
| TruckDesk | 2 syllables | Clean — but the name is already in use. |
| Tramo / Vialo / Camino | 2–3 syllables, effortless for Spanish speakers | Perfect phonetics, but all three have taken .com **and** .io. |

### Armenian / Russian / Spanish meaning flags

Nothing in the shortlist is obscene or insulting in the three languages, to the limit of my ability to check.
Specific notes:

- **Kamion** — *ideal* meaning (Spanish *camión*, Western Armenian կամիոն via French, and the Slavic *kamion*
  all mean "truck"). Killed by the trademark/company conflict, not by language. A genuine loss.
- **Camino** — Spanish for "road/way", strongly positive. But it is a very common word (Camino de Santiago,
  El Camino), which makes it a weak mark, and .com + .io are both gone.
- **Tramo** — Spanish for a stretch or leg of a road/journey. Positive, on-theme, no negative reading.
- **Vialo** — reads as Spanish *vial* ("roadway/road-related"). Neutral-to-positive; minor collision with
  "vial" as a glass container in English.
- **CarrierYard** — *yarda* is a real Spanish word and "la yarda" is established LA-trucking Spanglish. Net
  positive for this audience.
- **Carrier\*** generally — mild risk that Spanish speakers hear it against *carrera* (career/race) or
  *carril* (lane). Not a misunderstanding that damages anything.
- **RigRenew / FleetRenew** — no adverse meaning; the problem is the trailing W, above.
- **TruckClock** — "truck" is a well-established loanword in all three communities. No adverse meaning.

> Caveat: this is reasoning, not native-speaker review. Given that your customers *are* the Armenian- and
> Spanish-speaking community in Glendale/Sun Valley, the cheapest possible validation is to say your final two
> names out loud to three actual customers and ask them to spell them back. That test is worth more than
> everything in this section.

---

## 3. Ranked shortlist

| # | Name | Style | .com status | Conflicts found | Say-it-aloud | One-line rationale |
|---|---|---|---|---|---|---|
| 1 | **CarrierDesk** | plain-descriptive | **TAKEN** (blank page, no business; .app + .io free) | None found in trucking software | 8/10 | "Carrier" is the exact word FMCSA and every fleet owner uses for themselves; "Desk" carries dispatch + back office, so the name covers both halves of the product. |
| 2 | **CarrierYard** | compound-word | **AVAILABLE** (+ .app + .io) | None found — *unverified* | 8/10 | Only strong name with a clean sweep of all three TLDs; "the yard" is where the trucks actually live and *la yarda* already exists in your customers' Spanglish. |
| 3 | **RigDesk** | compound-word | TAKEN but **dead/parked**; .app + .io free | None found; adjacent to *Rigbooks* (same segment) | 9/10 | Shortest and phonetically cleanest of everything tested — but "rig" is insider US slang and skews oil-and-gas. |
| 4 | **CarrierNote** | compound-word | **AVAILABLE** (+ .app + .io) | None found — *unverified* | 8/10 | Clean sweep and easy to spell, but "note" sells only the alert half and collides with "note" as a loan instrument. |
| 5 | **TruckClock** | metaphor-from-trucking | **AVAILABLE** (+ .app + .io) | None found — *unverified* | 7/10 | The rhyme makes it stick and a clock is exactly what a deadline tracker is; loses points for "ck"×2 and for sounding like an hours-of-service timeclock. |
| 6 | **RigRenew** | compound-word | **AVAILABLE** (+ .app + .io) | None found — *unverified* | 6/10 | Bullseye on the renewal job-to-be-done, but it hides dispatch entirely and ends on the letter W. |
| 7 | **FleetRenew** | plain-descriptive | TAKEN but dead; .app + .io free | None found — *unverified* | 6/10 | Perfectly clear, but "Fleet" is the most crowded word in the category and sits too close to the FleetView name you're leaving behind. |
| 8 | **CarrierRoom** | compound-word | **AVAILABLE** (+ .app + .io) | None found — *unverified* | 8/10 | Available everywhere and easy to say; the weakest semantics of the group — a "room" says nothing about trucks or deadlines. |

### Eliminated, with cause

| Name | Why it's out |
|---|---|
| **Kamion** | Direct hit: a trucking TMS of the same name (now Loadsmart Carrier TMS), plus a Turkish freight marketplace and a US 3PL. Painful, because the word means "truck" to both your Armenian and Spanish speakers. |
| **TruckLane** | *Truck Lane Logistics* is live at the .com — same industry. |
| **TruckDesk** | Live site already branded "Truck Desk". |
| **ComplyFleet** | Domain squatted with an empty WordPress site, and the phrase is too descriptive to defend as a mark. |
| **RoadBook** | ROADBOOK travel publication owns the name in search; also a generic rally term. .io gone. |
| **MileMark / Milepost / MileMarker** | .com and .io both taken across all three; MileMarker.com has been registered since 1995. |
| **LaneKeeper** | "Lane keeping" is an established ADAS/driver-assist term — invites the wrong product category. .com + .io taken. |
| **Camino / Tramo / Vialo / Haulo** | Best phonetics of the whole set for your audience, but .com *and* .io are gone on every one. Tramo.com is parked on a brand-broker page, i.e. priced for resale. |
| **TripSheet / Kingpin / Blacktop / Backhaul / HaulDesk** | Generic industry terms (weak marks) and/or .com + .io both taken. "Kingpin" additionally carries a crime-boss reading. |

---

## 4. Top 3 recommendations

### 1. CarrierDesk — best name, with a domain compromise
It is the only candidate that describes the *whole* product. "Carrier" is not marketing language, it is the
word on their USDOT paperwork and the word they use for themselves — which matters enormously when your
differentiator is auto-pulling the carrier record from a USDOT number. "Desk" then carries orders, loads and
dispatch. No trucking-software conflict surfaced. **carrierdesk.app and carrierdesk.io are both free.** The
.com is registered but serves a blank page with no business behind it, so it is plausibly purchasable — and
`getcarrierdesk.com` is the standard fallback. Ship on `.app`: it is HSTS-preloaded, unambiguous when spoken
("carrier desk dot app"), and reads as a product rather than a brochure site.

### 2. CarrierYard — pick this if owning the .com is non-negotiable
Same industry-correct "Carrier" root, and it is the only genuinely strong name in the study with **.com, .app
and .io all unregistered** — a clean, uncontested sweep you can secure today for registration cost. It also
has the best cultural fit of anything on the list: the yard is the physical center of a small fleet's day, and
*la yarda* is already how your Glendale and Sun Valley customers say it. Slightly longer to say than
CarrierDesk, and the conflict check is unverified — clear it before committing.

### 3. RigDesk — the best-sounding name, with a caveat you should weigh
Two syllables, hard consonants, zero ambiguous vowels: objectively the easiest thing here to say down a bad
phone line and spell back correctly. .app and .io are free and the .com is dead and parked. **But** the brief
asks for a name that lands with non-native English speakers, and "rig" is precisely the kind of insider
American trucker slang that an immigrant owner-operator may not connect to "truck" — while in software naming
it pulls toward oil-and-gas. Add the *Rigbooks* adjacency (trucking software, identical customer segment) and
it drops below the two "Carrier" options despite winning on pure phonetics.

**Immediate next steps, in order:**
1. Run CarrierDesk, CarrierYard and RigDesk through <https://tmsearch.uspto.gov> in classes 009 and 042
   yourself — nothing here is trademark-cleared.
2. Say the final two to three real customers and have them spell them back.
3. CarrierYard's three domains are unregistered as of today and cost little to hold while you decide.
