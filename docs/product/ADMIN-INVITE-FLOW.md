# The sales-led invite, and the admin console around it

**Status:** specification. Nothing here is built. A UX agent and a development
agent build from this document.

**What this is for.** The owner sells in person. He sits with a carrier at a
truck stop, a yard or an office, opens a laptop, shows the application, and asks
for a USDOT number. He looks it up on the spot, reads the fleet's own federal
record back to them, quotes a price from the truck count, and sends an
invitation. The carrier clicks the link, signs up, and pays.

The self-serve door at `/login` does not change and does not go away. The invite
is a **second door**, and the two doors have to end in the same place: a carrier
row, a membership, a recorded terms acceptance, and a subscription that bills
what was quoted.

---

## 0. The one-paragraph version

An operator opens `/app/admin/carriers`, types a USDOT number, and gets one
screen holding the federal record, whether that carrier is already a customer,
and a price. He agrees a truck count out loud, types the email address the
person in front of him gives him, types one line saying where they met, and
sends. The carrier gets an email naming their own company and the monthly
figure. The link opens `/invite/<token>`, which shows the same company and the
same figure, takes an email and a password and a ticked box, creates the account
and the carrier through the **existing claim machinery** with a new
`channel = 'invite'`, walks them through entering their trucks, and then asks for
a card with the free days already on the clock.

---

## 1. The demo conversation, screen by screen

What follows is the whole flow with the operator's words beside it, because this
is a sales tool and the screen has to hold up the conversation rather than
interrupt it.

### Screen 1 — the search box. `/app/admin/carriers`

> "What's your DOT number?"

One field, one button. Nothing else on the page except the most recent searches
this operator made (so he can go back to a carrier without retyping). The field
accepts what a person actually says: `1234567`, `USDOT 1234567`, `1,234,567` —
`normalizeDot()` already handles all of it.

Submit is a **form POST that 303s to `/app/admin/carriers?dot=1234567`**, so the
result screen is linkable, refreshable and back-buttonable. Same rule
`/app/setup` follows.

### Screen 2 — the carrier. `/app/admin/carriers?dot=1234567`

He turns the laptop around.

> "That's you, right? Rodriguez Trucking, Bell Gardens. Nine trucks, six drivers.
> Your MCS-150 was last filed in March 2023 — that's why the federal file says
> Inactive. That's not a violation, it just means the two-year update wasn't
> done. That's one of the things we watch."

The screen is **read-only federal record plus one of four platform states** (see
§2.3). Everything on it comes from the census and authority datasets or is
computed from the DOT number. Nothing is estimated and nothing is stored yet.

### Screen 3 — the quote. Same page, a section below.

> "Nine trucks. It's six dollars a truck, so fifty-four a month. First thirty
> days are free. You pay for the trucks you're running — park one, it comes off
> the bill."

A number box, pre-filled with the federal power-unit count. He changes it if the
carrier says a different number. The price under it is `monthlyPrice(n)` and
**nothing else ever computes it**.

### Screen 4 — the invitation. Same page, a `<details>` below the quote.

> "What's the best email? … And I'll put down that we met at the TA on Alameda
> today."

Three fields: the email address, **typed by hand**; the truck count, carried
down from the quote; and one line saying where and when they spoke. Then one
button: **Send the invitation**.

He reads the confirmation line out loud:

> "Sent. Check your phone — it's from FleetView Compliance. The link is good for
> two weeks."

### Screen 5 — the carrier's email

Subject: **Set up FleetView Compliance for Rodriguez Trucking**. Body names the
company, the USDOT number, the agreed count and the monthly figure, says who
sent it, says it can be ignored, and carries one link. Full wording in §4.3.

### Screen 6 — acceptance. `/invite/<token>`

The carrier sees their own company name, their USDOT number, and the same
monthly figure. Email address is already filled in and cannot be changed. They
choose a password and tick the terms box. One button: **Create my account**.

### Screen 7 — the trucks. `/app/setup`, roster step

> (on the phone, later) "Put your trucks in. Plate and VIN. It's the same list
> we quoted you off."

The roster step already exists and already shows progress against a target. For
an invited carrier the target is the **quoted count**, not the federal count, and
the screen says which.

### Screen 8 — the card. `/app/billing`

"Nothing is charged until 18 October." One button. Skippable — see §6.

---

## 2. The USDOT search screen

### 2.1 Exactly which federal fields are shown

Two lookups, both already built, run in parallel — the same pair `/check` makes.
Two subrequests.

**From `lookupCarrier(dot)` → `CensusRow` (`src/lib/fmcsa.ts`):**

| Field | Shown as | Notes |
|---|---|---|
| `legal_name` | The heading | If absent, show the DOT number as the heading and say the file carries no legal name. Never invent one. |
| `dba_name` | Under the heading, "doing business as …" | Omit the line entirely when absent. |
| `phy_street`, `phy_city`, `phy_state`, `phy_zip` | One line, via `addressLine()` | Already built. Returns null when there is nothing. |
| `status_code` | Pill, via `statusLabel()` | **Must carry the sentence.** `'I'` prints "Inactive" and the operator needs the explanation beside it: this means the biennial MCS-150 update was not completed (49 CFR 390.19(b)(4)). Owners read "Inactive" as an accusation. |
| `carrier_operation` | "Interstate" / "Intrastate" / "Not stated", via `operationLabel()` | A blank stays a blank. It decides which half of the rule catalogue applies. |
| `mcs150_date` | Date, via `parseCensusDate()`, plus `mcs150Status(dot, lastFiled)` | This is the best line in the demo. It is a real, checkable finding about their business. |
| `power_units` | The number, via `censusCount()` | **`null` is not `0`.** Prints "not on file", never "0 trucks". Pre-fills the quote box only when it is a real number. |
| `total_drivers`, `total_cdl` | Numbers, via `censusCount()` | Same null rule. |
| `safety_rating`, `safety_rating_date` | Pill + note, via `safetyRating()` | Blank is the common case and prints "Not rated — most carriers have never had a compliance review." |
| `hm_ind` | "Hazmat on file: yes / no / not stated" | One line, no emphasis. It changes what the app watches; it does not change the sale. |
| `phone` | **Masked**, via `maskPhone()` → `(•••) •••-0168` | See §2.2. |
| `email_address` | **Masked**, via `maskEmail()` → `d•••@gmail.com` | See §2.2. |

**From `lookupAuthority(dot)` → `AuthorityRow[]`:**

| Field | Shown as |
|---|---|
| `op_auth_type`, `op_auth_status` | One row per authority held. |
| `min_cov_amount` vs `bipd_file` | The required minimum and what is actually on file. When on-file is below required, say so plainly. |

`lookupAuthority` returns a three-state `FederalResult`. All three must render
differently and the screen must never collapse them:

- `rows` → show them.
- `empty` → "No operating authority record found. Intrastate-only carriers never
  had one, and the federal authority file does not cover every USDOT number.
  This is not a finding."
- `error` → "We could not read the authority file just now."

### 2.2 The phone and the email, and what condition they are in

This matters because the owner will want to click them.

The census file's contact coverage, measured over California registrations and
recorded in `src/lib/claims.ts`:

| DOT band | has email | has phone | has neither |
|---|---|---|---|
| oldest | 10% | 62% | 37% |
| > 1,000,000 | 39% | 99% | 1% |
| > 2,000,000 | 52% | 98% | 0% |
| > 3,000,000 | 99% | 100% | 0% |

So: a phone is nearly always there on anything registered this century, an email
often is, and roughly a third of the oldest records have neither. The values are
**dirty** — `toE164()` and `usableEmail()` exist precisely to decide whether a
given cell is something we are willing to send to, and they reject plenty.

**The screen shows both, masked, and offers no way to send to either.** Under
them, one line of plain status:

- "Phone on file: (•••) •••-0168" — or "No usable phone on file."
- "Email on file: d•••@gmail.com" — or "No usable email on file."

This is the single strongest consented-outreach control and it costs one design
decision. See §7.

### 2.3 The four platform states, and the one he will hit constantly

The console reads across every carrier with the service key. It must answer, at
the top of the result, which of these is true:

**A. Not here.** No carrier row for this DOT, no live invitation, no open claim.
The invite form is available.

**B. Already a customer.** A `carriers` row exists for this DOT.

> **Give this the most prominent treatment on the page.** He will hit it at
> every third table, because the person he is talking to has a partner, a
> dispatcher or a brother who already signed up.

Show: the company name as **we** hold it, when the account was created, the
account email of the membership holder, and the plan state from
`planState({ row, carrierCreatedAt, now })` — trial with N days left, paying,
payment problem, or ended. **No invite form.** One line of copy:

> "This USDOT number already has an account here. Do not send an invitation.
> Ask them to sign in at fleetviewcompliance.com/login, or to use *Forgot your
> password* if they cannot get in."

The invite acceptance also refuses this case server-side (§5.4); the screen
refusing it is the courtesy, not the control.

**C. An invitation is already outstanding.** A live, unexpired, unrevoked
invitation for this DOT. Show who it went to (the full address — the operator
typed it, it is his own record), when, by which operator, the quoted count, and
how many sends it has had. Offer **Resend** and **Revoke**. Do not offer a
second invitation.

**D. A manual claim is open.** A `carrier_claims` row with `channel = 'manual'`,
unresolved. Show it and link to `/app/admin/claims`. The invite form stays
available — an invite is a legitimate resolution to a manual request from
somebody the operator has actually met — but the screen says the claim exists so
he does not answer it twice.

### 2.4 Lookup failures, not-found, and stale records

Four outcomes, all different, none collapsed into each other. This is the rule
`FederalResult` already encodes and the screen has to honour it.

**Not a USDOT number.** `normalizeDot()` returned null. "That is not a USDOT
number. It is 1 to 8 digits." The box keeps what was typed.

**Number valid, no census row.** `lookupCarrier()` returned `null`. "The federal
file has no carrier at USDOT 1234567. Check the number." Do **not** say the
carrier does not exist — it says the file has no row, which is what we know. The
invite form is **not** offered: we cannot name the company in the email and we
cannot price the fleet.

**The lookup threw.** Socrata down, timed out (8s), rate-limited, or returned an
error object. "We could not reach the federal file just now. Try again." **No
partial screen.** A page that shows a blank fleet count because a fetch failed is
the exact failure `FederalResult` was built to prevent, and on this screen it
would produce a quote for a fleet we never read.

**The record is stale.** This is not an error and it is the best thing on the
page. `mcs150Status(dot, lastFiled)` already returns `current | overdue |
unknown`. When it is `overdue`, say so in the carrier's own language:

> "Last MCS-150 filed 4 March 2023. The update is due every two years. This one
> is late, and that is why the file says Inactive."

And carry it into the quote: a stale MCS-150 means the power-unit count on that
record is at least as old as the filing. §3.2.

---

## 3. The quote

### 3.1 "Plans" versus the price that exists

The owner said: *"an option to choose our plan. Like, if it's five fleets, that's
a different plan, two fleets, different plan."*

**Verdict: this is the existing price described differently, not a new pricing
model. Build no tiers.**

What the product has is one function:

```
monthlyPrice(trucks) = max(trucks × $6, $29)
```

Two trucks is $29. Five trucks is $30. Nine is $54. Those *are* different
amounts for different fleet sizes, which is what he is describing when he says
"a different plan". What he is not asking for — and what must not be built — is
**bands with edges**.

If it were built as real bands, here is precisely what breaks:

1. **`tests/pricing.test.ts` goes red, by design.** The test
   `'adding a truck never makes the bill jump'` walks 1→100 and asserts every
   step is between $0 and $6. Any band boundary fails it. That test exists to
   stop a cliff.
2. **The business reason the test exists.** A cliff gives an owner a reason to
   under-report his fleet size — to a *compliance* product. The moment a
   ten-truck carrier types nine to stay under a boundary, the tenth truck's
   registration and inspection dates are not being watched, and the product has
   paid for a few dollars of margin with the one thing it sells. It is the same
   argument `src/lib/fleet/active.ts` makes about mislabelling a truck as
   parked: a status that silently switches off the reminders is worse than no
   status at all.
3. **The Stripe price would have to be rebuilt.** `STRIPE_VOLUME_TIERS` and
   `tieredMonthlyCents()` in `src/lib/billing/price.ts` are derived from
   `site.pricing`, and `tests/billing.test.ts` walks every fleet size comparing
   the tier arithmetic against `monthlyPrice()`. The instructions in
   `docs/OPERATIONS.md` are printed from those constants. Bands mean a new
   Stripe price object, a migration of every existing subscription onto it, and
   a new table in the operations doc.

**What the operator gets instead**, which answers what he actually wants at the
table: the quote box prints the number and the *shape* of it, so he can say it
out loud —

> "Nine trucks. Fifty-four a month. That's six a truck. Under five trucks there
> is a twenty-nine dollar minimum, so a two-truck outfit pays twenty-nine."

`estimatePrice()` already returns `onFloor` and `effectivePerTruck` for exactly
this sentence.

**The one real lever that is not a plan, and is an open question.** He may mean
*"I want to be able to do it for this guy at a lower number."* That is a
**discount**, not a plan, and the right shape is a Stripe coupon or promotion
code recorded on the invitation and applied at checkout — list price stays
`monthlyPrice()`, the discount is visible as a discount on the invoice, and
"quoted equals billed" survives because the bill is the quote minus a named
discount. **Not in stage 1.** Ask him before building it. See §11.

### 3.2 How the truck count is chosen

**Pre-filled from the federal record, confirmed out loud, typed if wrong.**

- The box is pre-filled with `censusCount(row.power_units)` when that is a real
  number. When it is `null`, the box is **empty** and the label says "The federal
  file does not list a power-unit count. Ask them."
- The operator can change it. Whatever is in the box is what is priced.
- Bounds: minimum 1 (`MIN_TRUCKS` — a $0 quote is the one output that must never
  be produced), maximum `FLEET_CEILING` (10,000).
- Above `site.pricing.maxQuotedTrucks` (50), `/pricing` deliberately refuses to
  quote and says "talk to us". **The operator is "us."** The admin screen prices
  it with `monthlyPrice(n)` and prints a note: *"Above the published segment.
  The rate is still $6 a truck. You are quoting this one yourself."* The public
  page's refusal is unchanged.

### 3.3 When the federal count and reality disagree — which is common

This is the normal case, not the edge case. The federal number is what the
carrier last self-reported on an MCS-150, and the product exists partly because
those filings go stale.

**Store both numbers on the invitation.** `federal_power_units` (what the file
said, or null) and `quoted_trucks` (what was agreed). When the first invoice is
questioned six weeks later, the row says which number was used and what the file
claimed at the time.

**Show the disagreement on screen, in one line, when they differ:**

> "The federal file says 6. You are quoting 9. Their MCS-150 is 2 years old —
> the file is behind the yard."

And say the follow-on out loud, because it is a real thing the product does for
them: an out-of-date MCS-150 is itself one of the tracked deadlines.

### 3.4 The sentence that keeps the quote honest

A quote is a price **at a stated count**. The bill is a price at the count of
**Active power units in the account**, from `billingBreakdown(vehicles).billable`.
Those are the same function of the same kind of number, and they agree only if
the carrier enters the fleet he described.

So every place the quote is shown — the admin screen, the invite email, the
acceptance screen — carries the same sentence, in these words:

> "This is the price for 9 trucks. You pay for the Active trucks in your
> account. Add one and it goes up $6. Park one and it goes down $6. Trailers and
> drivers are free."

That sentence is already the promise on `/pricing` and already the rule in
`src/lib/billing/trucks.ts`. Repeating it verbatim is what makes the first
invoice a confirmation rather than a surprise.

---

## 4. The invitation itself

### 4.1 What is stored when it is sent

A new table. **Intent and constraints only — the development agent writes the
SQL.**

**`carrier_invitations`** — one row per invitation.

| Column | Intent |
|---|---|
| `id` | uuid primary key. |
| `dot_number` | text. Same shape constraint as `carrier_claims`: `^[1-9][0-9]{0,7}$`. No foreign key to `carriers` — the whole point is that the carrier does not exist yet, exactly as in 0021. |
| `email` | text. **Typed by the operator.** Lower-cased, trimmed, and refused unless `usableEmail()` accepts it. This is the destination and there is no other. |
| `invited_by` | uuid → `profiles`. The operator. Not nullable. |
| `quoted_trucks` | int, ≥ 1, ≤ 10000. |
| `federal_power_units` | int, nullable. What the census said at send time. **Null is a real value** and must never be written as 0. |
| `legal_name`, `dba_name` | text snapshots from the census at send time. See §4.6 for why these are snapshots and not looked up again. |
| `reason` | text, **not null, not blank**, ≤ 500 chars. Where and when the operator spoke to this person. See §7.2. |
| `token_hash` | text. `sha256(token)`, hex, 64 chars — the same constraint shape `share_links` uses after 0026. **Never the token.** See §4.2. |
| `expires_at` | timestamptz. Not null. |
| `sends` | int, default 0. Incremented on every handoff to the provider, including failed ones. No refunds — the doctrine `void_carrier_claim` documents. |
| `last_sent_at` | timestamptz, nullable. |
| `accepted_at`, `accepted_by` | timestamptz / uuid → `profiles`. Both null until acceptance. |
| `revoked_at`, `revoked_by`, `revoked_reason` | Set by the operator. |
| `created_at` | timestamptz default now(). |

Indexes: `(dot_number, created_at desc)` and `(invited_by, created_at desc)` for
the rate limits and the console lists. A **partial unique index on
`dot_number` where the invitation is live** (not accepted, not revoked, not
expired) — one open invitation per USDOT number at a time, which is what makes
state C in §2.3 a single row rather than a pile.

**RLS: `ENABLE` and `FORCE`. `revoke all` from `public`, `anon`, `authenticated`.
No grant to `authenticated` at all** — not even select. A carrier has no business
reading invitations, including their own: the row names the operator, the reason
and the quote. The only readers are the admin console (service key, behind the
operator gate) and the definer function in §5.3.

### 4.2 The token

**32 CSPRNG bytes, base64url, 43 characters.** Exactly `src/lib/proof/token.ts`
— reuse it rather than writing a second generator. Random bytes or an exception,
never a `Math.random()` fallback.

**Stored as a plain SHA-256, hashed inside the database function, not in the
application.** This is the 0026 shape and the reasoning transfers exactly:

- **No pepper, and that is not laziness.** The pepper in `claims.ts` exists
  because a six-digit code has a million possible values and an attacker holding
  the table computes all of them in under a second. A 256-bit random token has
  no dictionary, no rainbow table and no hardware that walks the space. The
  entropy is the control.
- **The hashing happens inside the function** so that the stored value is not
  itself a working credential. If the application hashed the token and passed the
  digest, a leak of the table would be a leak of every live invitation.

**What it does not protect against, said plainly:** anybody holding the link.
That is what a link is. The token reaches our access logs, the recipient's
browser history, and every proxy in between. See §5.5 for what that costs and
what limits it.

### 4.3 What the email says

Sent through `send()` (`src/lib/notify/send.ts`), which means it passes
`guard.ts`: **outside production every invitation redirects to
`DEV_REDIRECT_EMAIL`, and an unset redirect is a refusal, not a pass-through.**
A demo on the dev deployment cannot mail a carrier. That is already true and must
stay true.

It is **not** sent through Supabase's `inviteUserByEmail`. See §5.6.

Copy rule for this message specifically: it is the first thing this product ever
sends this person, they may not read English comfortably, and they are reading it
on a phone. Short sentences, ordinary words, the action first.

> **Subject:** Set up FleetView Compliance for Rodriguez Trucking
>
> Rodriguez Trucking — USDOT 1234567
>
> Garabed from FleetView Compliance sent you this. You talked today.
>
> FleetView Compliance watches the dates that stop a truck: registration, annual
> inspection, driver medical cards, your IFTA filing, your MCS-150.
>
> For 9 trucks it is $54 a month. The first 30 days are free. You pay for the
> Active trucks in your account. Add one and it goes up $6. Park one and it goes
> down $6. Trailers and drivers are free.
>
> Open this link to set up your account:
>
> https://fleetviewcompliance.com/invite/<token>
>
> The link works for 14 days. It is for this email address only.
>
> If you were not expecting this, ignore this email or write to
> info@fleetviewcompliance.com.
>
> FleetView Compliance · <legal entity> · <street address, city, state, zip>

**The shape of the body is load-bearing**, not presentation:
`src/lib/notify/email-layout.ts` reads it — paragraphs separated by a blank
line, and the link **alone on its own line**, which is what turns it into the
button with the address printed underneath. Keep the shape.

**The last line is a launch blocker.** `site.legalEntity` is `''` and there is no
street address anywhere in `src/lib/site.ts`. Commercial email needs a valid
physical postal address. **No invitation may be sent until those are filled in.**
See §11.

### 4.4 How long it is valid

**14 days.**

Not 15 minutes — that is the TTL for a code sent to a contact the person is
staring at, and the window is the real limit on how long an attacker has to spend
five guesses. This is different: a link handed to a busy owner who said "send it
to me, I'll do it this weekend". Two weeks covers a weekend, a vacation and a
forgotten phone. It is short enough that a link is not still live in a WhatsApp
thread six months later.

### 4.5 Never accepted, forwarded, revoked, resent

**Never accepted.** It expires. Nothing happens automatically. It moves into the
console's **Ran out** bucket — the same vocabulary the claims queue already
uses — and the operator can see it and call the person. **No automatic reminder
email.** A second unsolicited message to somebody who did not act on the first is
exactly the thing §7 exists to prevent.

**Forwarded to someone else.** The link is a bearer credential; whoever holds it
can open it. Three things limit what that costs:

1. **The account is bound to the invited address.** The acceptance form's email
   field is filled from the invitation row **server-side** and is not a form
   input the browser can change. A forwarded link can only ever create an account
   on the address the operator typed.
2. **One USDOT number, fixed.** The acceptance screen does not offer a number
   field. The invite creates *that* carrier or nothing.
3. **Single use.** Acceptance sets `accepted_at` in the same transaction that
   creates the carrier. A second open of the link finds a used invitation and
   says so.

What remains, honestly: with Supabase email confirmation **off**, a person
holding a forwarded link can create an account on an address they do not control,
and would then hold that carrier. §5.5 says what to do about it.

**Revoke.** An operator can revoke a live invitation from the console, with a
reason. It sets `revoked_at`, `revoked_by`, `revoked_reason`; the link stops
working immediately and says "This invitation was cancelled. Write to
info@fleetviewcompliance.com." **Revoking sends no email** — a "your invitation
was cancelled" message to someone who never asked for the first one is a second
unsolicited email.

**Resend.** Allowed. It **mints a new token and kills the old one** — the same
rule `start_carrier_claim` applies when it voids any earlier live claim on the
number, and for the same reason: two live links means "the link we sent you" is
ambiguous and the older email is the one still on the person's phone. Resend
increments `sends`, and the rate limits in §7.3 apply. Capped at **3 sends per
invitation** (the original plus two resends).

### 4.6 Why the company name is a snapshot

The console's "outstanding invitations" list shows a company name per row. That
name comes from `legal_name` **stored on the invitation**, never from a fresh
`lookupCarrier()`.

A list of 40 invitations that looked each one up would be 40 Cloudflare
subrequests in one invocation. A Worker has 50 on the free plan and the daily
digest already spends ~46 of its own budget; crossing it does not return an error
from `fetch`, it **throws**, escapes the handler, and Cloudflare answers with an
empty 500. That has already happened once in this project, on the digest, and
`tests/subrequest-ceiling.test.ts` exists because of it.

**Rule for every admin screen: one round trip per list, never one per row.** The
search screen is the only place a federal lookup happens, it happens for exactly
one carrier, and it costs two subrequests.

---

## 5. Acceptance and signup

### 5.1 What the carrier sees at `/invite/<token>`

A public page — no session required, `noindex`, outside `/app`.

Before the form, the three things that make it feel like the conversation they
just had:

- **Their company name and USDOT number**, from the snapshot on the invitation.
- **The price**, `monthlyPrice(quoted_trucks)`, with the same sentence from §3.4.
- **One line of federal record**, looked up live — their city and their
  MCS-150 status. One subrequest, and it is the line that proves this is really
  about them. If the lookup fails, the page still works and simply omits it.

Then the form: **email (filled, not editable)**, password, and the terms
checkbox — the identical `ASSENT` component `/login` renders, from
`src/lib/terms.ts`, with both links.

### 5.2 How this differs from ordinary signup

| | `/login?mode=signup` | `/invite/<token>` |
|---|---|---|
| Email | Typed by the person | Fixed, from the invitation |
| USDOT | Typed later, at `/app/setup` | Fixed, from the invitation |
| Proof of the number | Code to the **federal** contact, or manual review | The operator's word, recorded with his name |
| Steps to a carrier | Sign up → setup → claim → code → carrier | Sign up → carrier, in one transaction |
| Price known beforehand | No | Yes, and stated |
| Terms | Recorded at signup | Recorded at signup, identically |

### 5.3 How the claim system is satisfied

**The invite does not route around 0021. It becomes a claim.**

This is the most important structural decision in this document. `0021_carrier_claims.sql`
revoked `create_carrier` from `authenticated` and made `complete_carrier_claim`
the only door left. Writing a second path that creates carriers would re-open
exactly the hole that migration closed, and it would do it for the one actor —
an operator who can hand a carrier to a user — that the migration's own header
names as the threat.

So:

1. **A new enum value on `claim_channel`: `'invite'`.** It joins `'manual'` as a
   channel that carries **no code hash**, which means the existing
   `carrier_claims_hash_matches_channel` constraint has to be widened from
   "manual has no hash, everything else has one" to "manual and invite have no
   hash, everything else has one". That is the one schema change to
   `carrier_claims` this feature needs.

2. **A new `SECURITY DEFINER` function, `complete_carrier_invitation(p_token, …)`**,
   modelled line for line on `complete_carrier_claim`. Called by the accepting
   user's own session, after signup, so `auth.uid()` is the person. It:

   - hashes `p_token` **inside the function** and finds the invitation by hash;
   - refuses if it is accepted, revoked or expired;
   - refuses unless the signed-in user's email equals `invitation.email`;
   - inserts a `carrier_claims` row: `channel = 'invite'`, `code_hash = null`,
     `user_id = auth.uid()`, `verified_at = now()`, `destination_mask` = the
     masked invited address, `note` = a reference to the invitation id;
   - calls `create_carrier(dot, legal_name, dba_name, timezone)` as the owner —
     the same call `complete_carrier_claim` makes, so the rule about who may
     write a membership still lives in exactly one place;
   - catches `unique_violation` and returns `'already_claimed'`, **not** joining
     the user to the existing carrier, for the reason 0021 gives: its rows may
     belong to somebody else;
   - marks the invitation accepted by that user;
   - **returns a status and never raises for an outcome the user caused.** A
     raise aborts the transaction and takes the invitation's accepted stamp with
     it. Statuses: `created · already_claimed · expired · revoked · used ·
     wrong_email · no_invitation`.

3. **Rate limits do not apply to acceptance**, only to sending. The invitation is
   already one row that already cost a send.

### 5.4 What an invite proves, and what it does not

Write this paragraph into the code as a comment, because somebody will read the
`carrier_claims` table in two years and need it:

> **A `'phone'` or `'email'` claim proves control of the contact point the
> federal government holds for that USDOT number.** Nobody chose that contact
> except FMCSA, which is what makes it evidence.
>
> **An `'invite'` claim proves something different and weaker:** that a named
> operator, at a recorded time, typed this email address and this USDOT number
> and wrote down that he had spoken to this person; and that whoever accepted it
> received mail at that address. **The federal record was never consulted for the
> contact.** Our evidence is a human being's word, with his name on the row.
>
> It is not nothing. It is accountable, in a way an anonymous signup is not —
> if an operator invites a squatter, `carrier_invitations.invited_by` and
> `carrier_invitations.reason` say who did it and what he claimed at the time.
>
> This is why `channel` is a separate value rather than reusing `'email'`. The
> day two people both claim USDOT 1234567, the queue has to be able to say which
> one proved a federal contact and which one was let in by the owner.

### 5.5 The one real weakness, and the decision it needs

**With Supabase email confirmation OFF, `signUp()` returns a session
immediately** — `src/pages/login.astro` handles exactly that branch today. Which
means the email-match check in §5.3 checks an address that nobody has proved
control of. A forwarded link plus a typed password is a carrier.

Three options, in order of preference:

1. **Turn Supabase email confirmation ON before the first production invite.**
   The codebase already supports both branches: `/login` handles `check_email`,
   `src/lib/terms.ts` documents that the recorded acceptance instant shifts by
   the minutes between ticking the box and opening the email, and the Send Email
   Hook already composes a confirmation message. **This is the recommendation.**
   Cost: every self-serve signup gains an inbox round trip.
2. Keep it off and accept that an invite link is a bearer credential to a
   carrier, mitigated only by the 14-day window, the single-use rule, the
   address binding, and the operator's accountable row. **Say this out loud in
   the spec rather than discovering it.**
3. Require confirmation for invite acceptances only. **Not available** — it is a
   project-wide Supabase setting, not a per-flow one.

**This is a decision for the owner, not for the development agent.** It is
listed in §11.

### 5.6 Why not Supabase's own `inviteUserByEmail`

`src/lib/auth/email-hook.ts` already handles the `invite` action and already has
an `inviteMessage()`. It would have been the short path. It is the wrong one:

- **It creates the auth user at send time.** An invitation that is never accepted
  leaves a dangling account on that address forever, which then collides with
  that person's own signup later — and `signupOutcome()` deliberately cannot
  distinguish the collision for anti-enumeration reasons, so the failure would be
  invisible on both sides.
- **Revoking would mean deleting an auth user** through the admin API, which can
  fail, rather than setting a column.
- **The email would be generic.** `inviteMessage()` says "You have been invited
  to join FleetView Compliance" and knows nothing about Rodriguez Trucking or
  $54. The whole value of this email is that it continues a conversation.

`inviteMessage()` stays where it is and keeps serving invites issued from the
Supabase dashboard. Nothing about the hook changes.

### 5.7 Where terms acceptance is recorded

**Unchanged from `/login`, and that is the point.** After a successful `signUp()`
that returns a session, `/invite/<token>` calls `recordTermsAcceptance(supabase,
Astro.request.headers)` — the same function, the same idempotent
`record_terms_acceptance` RPC that takes no user id and no timestamp, writing to
`terms_acceptances` scoped on `user_id = auth.uid()`.

Two rules carry over verbatim and must not be softened for this door:

- **The tick is checked before `signUp()` runs**, server-side, via `ticked()`.
  An account that exists with no agreement recorded against it is the gap 0025
  closes, and the only way to be sure there is never one is to refuse before the
  account is created.
- **A failure to record is logged, never shown.** The account already exists;
  there is nothing useful to abort, and the call is idempotent per version.

If confirmation is turned on (§5.5), the recording moves to `/auth/callback`
exactly as `src/lib/terms.ts` already describes. That is the safe direction — it
never claims an acceptance happened earlier than it did.

---

## 6. Payment

### 6.1 Where it sits, and why

**Card at signup, nothing charged for 30 days — and asked immediately after the
trucks are entered, not before.** The order is:

```
accept invite → carrier created → enter the trucks → the card → dashboard
```

**Why after the trucks and not before.** This is the concrete defect the invite
flow creates if the order is wrong, and it is worth spelling out:

`/app/billing` starts checkout with `quantity: billingBreakdown(rows).billable`
— the count of **Active power units in the account**. A carrier who accepted an
invitation five minutes ago has **zero vehicles**. So checkout would be created
with `quantity: 0`, the volume price's first tier would bill the $29 flat
amount, and the carrier who was quoted $54 would see a $29 subscription — which
then jumps to $54 the first time anyone presses *Send today's count to Stripe*.
The bill would contradict the sales conversation in both directions inside one
month.

The fix is not a second truck count. It is **ordering**: the roster step already
exists at `/app/setup`, it already shows progress against a target, and for an
invited carrier the target is the quoted count. Once the trucks are in,
`billingBreakdown()` and the quote are the same number because they are the same
number, computed once, from the same definition of a truck.

**A hard requirement that falls out of this:** the checkout button must refuse
when there are zero active power units, with a sentence and not a silent
`quantity: 0`:

> "Add your trucks first. We bill for the Active trucks in your account, and
> right now there are none."

**Why skippable and not a hard gate.** The card screen is shown in the flow,
before the dashboard, with the free days already counting — but the person can
press *Not now*. Three reasons:

1. Nothing in this application is gated on payment today. `isEntitled()` exists
   in `src/lib/billing/plan.ts` and gates nothing, deliberately. A hard gate on
   the invite door only would mean the two doors diverge; a hard gate on both is
   a much larger decision (a lapsed card would lock a carrier out of his own
   driver qualification files) and belongs in its own spec.
2. `STRIPE_MIN_TRIAL_MS` — Stripe refuses a `trial_end` less than 48 hours away.
   A hard gate would have to grow a second behaviour for anyone who starts
   paying in the last two days of the trial.
3. At the end of a sales conversation, "let me get my card" is how a yes becomes
   a next week.

**What the owner actually wants from "when they sign up, the payment method" is
visibility**, and the console gives it to him: every invited carrier's row shows
**card on file: yes / no** and the days left on the trial, so he can call the
ones who skipped.

### 6.2 What Stripe objects are needed

All four already documented in `docs/OPERATIONS.md` §Billing. Nothing new:

1. **One recurring monthly USD product**, with a **VOLUME** tiered price —
   tier 1 `up_to 4`, flat $29.00; tier 2 `up_to inf`, $6.00 per unit. **Graduated
   is wrong** and would charge a five-truck fleet $35 instead of $30.
   `STRIPE_VOLUME_TIERS` in `src/lib/billing/price.ts` is the source; read the
   table off it rather than typing it.
2. **A webhook endpoint** at `https://<host>/api/stripe/webhook`.
3. **The customer portal switched on**, or the "Card, invoices and cancel" button
   fails and `/pricing`'s "cancel any month" is a promise with no mechanism.
4. **Three secrets per environment**: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`,
   `STRIPE_WEBHOOK_SECRET`. Test-mode objects on dev, live on production;
   `readStripeConfig()` refuses an `sk_live_` key anywhere `DEPLOY_ENV` is not
   `production`.

### 6.3 What the webhook must handle

**Already built and working** in `src/pages/api/stripe/webhook.ts`:

- Real HMAC-SHA256 signature verification over the **raw** body, on WebCrypto,
  with Stripe's 5-minute replay window. Refuses everything when
  `STRIPE_WEBHOOK_SECRET` is unset.
- `checkout.session.completed` — resolves the carrier from
  `client_reference_id`, then retrieves the subscription for its real state.
- `customer.subscription.created` / `.updated` / `.deleted` — resolves the
  carrier from `subscription_data[metadata][carrier_id]`, falling back to a known
  `stripe_customer_id`.
- An **out-of-order guard** on `stripe_event_at`, so a retried "cancelled" cannot
  land after a newer "reactivated" and stick.
- 200-and-drop for every other event type, so an unwanted event cannot put the
  endpoint into Stripe's failing state and take the other three down with it.

**What is missing, concretely:**

- **No Stripe account is connected at all.** All three `STRIPE_*` values are
  empty in `.dev.vars.example`. The billing screen degrades honestly to "card
  payment is not switched on" — which is correct, and is also why nobody has
  noticed.
- **Nobody is told when a payment fails.** `customer.subscription.updated` moving
  to `past_due` does reach the row, and `planState()` turns it into
  `payment_problem` on `/app/billing`. But **nothing emails the carrier and
  nothing surfaces it to the operator.** Two pieces of work: a "Payment problems"
  line on the admin console (§8), and a message to the carrier. Do not subscribe
  to new event types for the *state* — the four already cover it. Subscribe to
  `invoice.payment_failed` only if the carrier-facing message needs the invoice's
  own detail (amount, next attempt date), and say so when deciding.
- **Nothing pushes the truck count to Stripe automatically.** Documented and
  deliberate: the billing screen prints both numbers and the owner presses a
  button. The error runs in the customer's favour — a growing fleet is
  under-billed until somebody presses it, never over-billed. **This stays.** For
  an invited carrier it means the operator should watch the console's
  "quoted 9 / billing 6" line and call them.
- **Nothing is gated on payment.** `isEntitled()` gates nothing. See §6.1.

### 6.4 When payment fails later

The state machine already handles it. `PROBLEM_STATUSES` is `past_due`, `unpaid`,
`incomplete`; `planState()` returns `payment_problem` carrying Stripe's own word
and the billed truck count, and `/app/billing` sends the person to the portal,
which is the only place that can actually fix a card.

What to add:

- **One line on the admin console.** "3 carriers have a payment problem." It is
  the operator's job to call them; he cannot do it if he cannot see it.
- **One message to the carrier**, plain: what happened, that nothing has been
  switched off, and the one link to the portal. Through `send()`, so `guard.ts`
  applies.
- **Nothing is switched off.** A carrier whose card expired still gets his
  medical-card reminders. Turning off compliance alerts over a failed card is
  how a truck gets pulled over, and it would be our doing.

---

## 7. What enforces consented outreach

The FMCSA census file holds contact details for hundreds of thousands of
carriers. This feature is one CSV import away from being a machine for mailing
all of them. The controls below are structural, not policy — there is no bulk
path to disable because none is built.

### 7.1 The destination address is typed by hand

**There is no control anywhere in the console that sends to the address in the
federal file.** The census email is shown **masked** (`maskEmail()` →
`d•••@gmail.com`), which is enough for the person sitting there to say "yes,
that's the office address" and not enough to copy off the screen.

To send an invitation, the operator types an address. If the carrier says "just
use the one you've got", the carrier says it out loud. **That friction is the
control**, and it is the same doctrine `claims.ts` already applies to the code
destination: a destination that came off the page is a destination somebody else
chose.

This is the single most important control here and it costs one design decision.

### 7.2 Every invitation carries a reason

`reason` is **not null and not blank**. One line: where and when the operator
spoke to this person. "TA Alameda, today, talked to Mario." "Called back after
his voicemail Tuesday."

Two honest notes about it:

- **It is unenforceable as validation.** A lazy operator types ten characters of
  nonsense. The point is not that the string is true; the point is that (a) a
  complaint six months later has an answer with a name on it, and (b) typing a
  sentence per carrier makes sending 400 of them tedious by construction. State
  that rather than pretending a `length >= 10` check is a compliance control.
- **It is read by nobody on the happy path**, and that is fine. It is evidence,
  like `terms_acceptances`.

### 7.3 Rate limits, in the shape `CLAIM_POLICY` already uses

Enforced **in the database function**, not only in the page — a limit that lives
in an Astro page is a limit a direct PostgREST call walks past. `claims.ts`
documents this; do it the same way, with the numbers written in both places and a
comment in each pointing at the other.

| Limit | Value | What it stops |
|---|---|---|
| Sends per invitation | 3 | Endless resending to one person. |
| Sends per USDOT number, 7 days | 3 | Whoever owns that mailbox hears from us at most three times a week, from everybody. |
| Sends per USDOT number, ever | 10 | A number that has said no ten times has said no. |
| Sends per operator, per hour | 5 | The tempo of a person at a table, not a script. |
| Sends per operator, per day | 20 | Twenty conversations is a long day. |
| Cooldown between sends | 60 seconds | A double-submitted form, which would otherwise mail somebody twice. |

**Counted over sends handed to the provider, including ones that failed.** A
failed send that refunded the budget would be an unlimited-mail machine — start,
fail, repeat. This is exactly what `void_carrier_claim` refuses to do and the
reasoning transfers unchanged.

### 7.4 No bulk anything

Not built, and named here so nobody builds it:

- No CSV import, no paste-a-list, no multi-select, no "invite everyone in
  Glendale", no saved segments, no scheduled sends.
- No "invite from the federal file" button on the search results.
- No automatic reminder for an unaccepted invitation.

One USDOT number, one address, one form submit.

### 7.5 The guard still applies

Every invitation goes through `send()` and therefore `guard()`. Outside
production it is redirected to `DEV_REDIRECT_EMAIL`, and **an unset redirect is a
refusal**. Demos on dev cannot reach a carrier. This is already true; the invite
must not be given its own sending path that skips it.

### 7.6 The unsubscribe and the postal address

- **Every invitation says who sent it, and that ignoring it is safe.** The same
  rule every auth email in `src/lib/auth/email-hook.ts` follows.
- **A real reply address**: `info@fleetviewcompliance.com`, already in
  `src/lib/site.ts`, described there as monitored.
- **A physical postal address in the footer.** `site.legalEntity` is empty and no
  street address exists anywhere in the repo. **This blocks the first send.**

---

## 8. The rest of the admin console — briefly

Secondary to the invite flow. One page, `/app/admin`, with the existing
`/app/admin/claims` linked from it. All of it read-only except the invite
actions.

**Four counts at the top**, each a link to a filtered list, each answering "what
needs me today":

- **Carriers.** How many, and how many signed up this week.
- **Stuck.** Three buckets, because they need different calls: signed up but no
  carrier (claim never completed); carrier but no trucks (roster empty — and
  therefore nothing being watched, and nothing billable); trial ending in 7 days
  with no card.
- **Invitations.** Waiting / Ran out / Accepted / Revoked — **the same four-word
  vocabulary the claims queue already uses**, so an operator learns it once.
- **Payment problems.** Carriers whose `billing_subscriptions.status` is in
  `PROBLEM_STATUSES`.

**The invitations list** is the one that gets used. Columns: USDOT, company (from
the snapshot), the address it went to, quoted trucks and price, who sent it,
when, sends used, and the state badge. Actions per row: **Resend**, **Revoke**,
and a link back to `/app/admin/carriers?dot=…`.

**The claims queue stays exactly as it is.** `/app/admin/claims`, read-only, no
grant button, with the sentence it already prints: *"This page only shows
requests. Nobody is given a carrier from here."* That stays true after this
feature ships. An invitation is not a grant — it creates nothing until the person
accepts it with their own password.

**How each screen fetches.** One query per list. The counts are aggregate
queries, not row scans in a loop. No federal lookup on any list — only on
`/app/admin/carriers?dot=`, for one carrier, two subrequests. Newest 200 per
list, as `/app/admin/claims` already does, with the "older ones are in the
database" line.

**Where the RLS hole is opened, and what closes it.** The console reads
`carriers`, `memberships`, `profiles`, `billing_subscriptions`, `carrier_claims`
and `carrier_invitations` across every tenant with `SUPABASE_SECRET_KEY`, which
carries `BYPASSRLS`. Four things close it and the order matters:

1. `src/middleware.ts` guards `/^\/app\/admin(\/|$)/` — the whole subtree, so a
   new page is guarded the day it is created.
2. The gate is a **positive grant** from `ADMIN_OPERATORS` and **fails closed**.
   Unset, empty or malformed admits nobody, including the owner.
3. The refusal is a **bodyless 404**, byte-identical to a route that does not
   exist.
4. **Every admin page repeats the check at the top of its own frontmatter,
   before the secret key is so much as read from the environment.** That ordering
   is the control, exactly as `/app/admin/claims` documents. Move the check below
   the key read and the guarantee is gone.

And one rule with no exceptions: **no admin page writes a carrier's data.** The
console's only writes are to its own tables.

Cloudflare Access protects dev and will not protect production. It is not part of
this feature's defence and must never be treated as part of it.

---

## 9. Audit

Two kinds of record, in two places, for two different questions.

### 9.1 Invitation lifecycle — on `carrier_invitations`

`invited_by` + `created_at`, `sends` + `last_sent_at`, `revoked_by` +
`revoked_at` + `revoked_reason`, `accepted_by` + `accepted_at`. Answers *"who
invited this carrier, when, on what basis, and who accepted it."*

For per-send detail — three sends with three timestamps and three outcomes — a
child table **`carrier_invitation_sends`** (invitation id, at, status,
provider message id, guard note). Append-only. It is what answers "we never got
it" with something better than a shrug: `send()` already returns
`providerMessageId` for exactly this.

### 9.2 Every carrier profile opened — `admin_lookups`

**One row per USDOT search on the admin console.** Operator user id, dot number,
the instant, and the outcome (`found` / `not_found` / `lookup_failed` /
`already_customer`).

**Why it exists.** The console can read across every carrier on the platform.
The only thing that makes that acceptable is that looking is recorded. It is the
same argument `terms_acceptances` makes about evidence: a control nobody can
audit is a control nobody has.

**Constraints:**

- **Append-only by trigger, not by grant.** UPDATE and DELETE refused outright,
  the shape `terms_acceptances_are_immutable()` uses. Grants say who; a trigger
  says what, and fires for the owner and for a definer function too.
- **`ENABLE` + `FORCE` RLS, and no grant to `authenticated` at all.** Written
  with the service key from the admin page; read the same way.
- Written **after** the operator gate has passed, in the same request, before the
  federal lookup. A search that fails still writes a row — "he looked" is the
  fact being recorded, not "he found".
- A database insert, not a subrequest. Cost is negligible.

**Honest note:** it grows without bound and nothing prunes it. At this volume
that is fine for years. A retention rule is an open question, not a blocker.

### 9.3 What is deliberately *not* audited

Reads of a carrier's own compliance data by the operator — because the console
**does not read it**. There is no screen that shows an operator a carrier's
drivers, documents, medical cards or loads, and there must not be. See §10.

---

## 10. What NOT to build

Each of these is a thing somebody will propose. The reason matters more than the
refusal.

**1. No pricing tiers or a plan picker.** §3.1. `tests/pricing.test.ts` exists to
stop a cliff, and a cliff gives an owner a reason to under-report fleet size to a
compliance product.

**2. No CSV import, no bulk invite, no list building.** §7.4. The federal file is
hundreds of thousands of carriers and this is the feature that would turn it into
a mailing list. There must be no bulk path to disable, because none is built.

**3. No one-click "send to the address in the federal file".** §7.1. Typing the
address is the control.

**4. No generated-and-emailed passwords, ever.** Already decided. The link is the
credential and the person sets their own password. A password in an email is a
password in every mail server between here and them, forever.

**5. No "log in as this carrier" / impersonation.** This is the one that will be
asked for by name, because it looks like support. A support tool that can enter a
carrier's account can read his drivers' dates of birth, medical examiner
certificates and CDL numbers. If an operator needs to see a screen, the customer
shares their screen. There is no audit trail good enough to make the alternative
safe.

**6. No admin button that grants a carrier to a user.** `/app/admin/claims`
already says this out loud and the sentence must stay true. Granting a claim is
handing a stranger a federal number — the exact attack 0021 exists to prevent.
An invitation is not a grant: it creates nothing until the person accepts it with
their own password, and it records who vouched.

**7. No automatic reminder for an unaccepted invitation.** §4.5. It is a second
unsolicited email to somebody who did not act on the first.

**8. No "invitation cancelled" email on revoke.** Same reason.

**9. No SMS invitations in this iteration.** Twilio is not switched on
(`docs/OPERATIONS.md` §"Before SMS can be switched on"), a text has no headers
and no unsubscribe, and TCPA exposure on a cold text is categorically worse than
on an email. Revisit only with the owner and only after email invites have run.

**10. No demo-mode or fake-data toggle in the application.** The owner should
demo against the dev deployment and the seeded carrier that
`docs/OPERATIONS.md` §"Demo data" already documents. A fake-data switch inside
the product is how fake data reaches a real customer's screen.

**11. No editing a carrier's federal data by hand.** The file is the file. If it
is wrong, the fix is an MCS-150 update, which is a thing the product already
tells them to do.

**12. No CRM.** `reason` is one line, not a notes system, not a pipeline, not
follow-up tasks. If he needs a CRM he should buy one.

**13. No client-side JavaScript**, on any of it. Search is a form submit.
Disclosure is `<details>`. Filtering is a link with a query parameter. This is
verified on every build.

---

## 11. Open questions

These are real and they will be found in production if they are not answered
first.

1. **Supabase email confirmation: on or off?** §5.5. With it off, an invite link
   is a bearer credential to a carrier. **Recommendation: turn it on before the
   first production invite.** This is the owner's call and it affects the
   self-serve door too.
2. **`site.legalEntity` and a physical postal address.** Both missing. **Blocks
   the first send.** §4.3, §7.6.
3. **Does he want a discount lever?** §3.1. If "different plan" turns out to mean
   "I want to do this one cheaper", that is a Stripe coupon recorded on the
   invitation, not a new price model. Ask before building.
4. **Above 50 trucks.** `/pricing` refuses to quote; the admin screen is proposed
   to quote it with a warning. Confirm that is what he wants.
5. **Does an invitation ever need to name a company we cannot find in the federal
   file?** Currently no — no census row means no invite, because we cannot name
   the company or price the fleet. A brand-new DOT number can take weeks to
   appear in the census extract, so he may meet somebody who is genuinely not in
   it yet.
6. **`admin_lookups` retention.** Grows without bound. Fine for years; decide
   eventually.
7. **Multiple operators.** `ADMIN_OPERATORS` already supports a list, and the
   rate limits are per-operator. Nothing here assumes one person. But there is no
   per-operator view ("my invitations") — add only if a second operator exists.
8. **`ADMIN_OPERATORS` is not set on production.** It fails closed, which means
   the console is currently unreachable there — correctly. Setting it is a stage
   0 task and the operator will see a bare 404 until it is done, including
   himself.

---

## 12. The staged plan

### Stage 0 — configuration, before any code

No engineering. These block everything downstream.

- `ADMIN_OPERATORS` set on dev **and** production, as the owner's Supabase user
  id (the strong form) rather than his email.
- `site.legalEntity` filled in, plus a real street address for email footers.
- Decide §11.1 (email confirmation).

### Stage 1 — the demo screen. Read-only. **This is what makes the demo possible.**

`/app/admin/carriers` — search by USDOT, the federal record (§2.1), the four
platform states (§2.3), the failure cases (§2.4), and the quote (§3).

**No invitation yet.** He can already do the whole sales conversation: type the
number, turn the laptop around, read their own record back to them, say what it
costs. The invite becomes "I'll send you a link" and a note on his phone for one
more week.

Also in stage 1: `admin_lookups` (§9.2), and `/app/admin` as a shell linking to
this and to the existing claims queue.

Ships in days. No new email. No new security surface beyond the admin hole that
already exists and is already closed the same way.

### Stage 2 — the invitation

- `carrier_invitations` + `carrier_invitation_sends` (§4.1, §9.1).
- The token, reusing `src/lib/proof/token.ts` (§4.2).
- The invite form on the search screen, the rate limits in the database (§7.3),
  the email through `send()` (§4.3).
- `claim_channel` gains `'invite'`; the hash/channel constraint widens (§5.3).
- `complete_carrier_invitation()` (§5.3).
- `/invite/<token>` — acceptance, terms, account, carrier (§5.1).
- The invitations list, with Resend and Revoke (§8).

### Stage 3 — payment

- The four Stripe dashboard steps and the three secrets, per environment (§6.2).
- The ordering fix: roster before card, with the quoted count as the roster
  target (§6.1).
- The zero-truck refusal on checkout (§6.1). **This is a bug in the current
  billing page the moment an invited carrier reaches it, and it should be fixed
  whether or not the rest of stage 3 ships.**
- "Card on file: yes/no" and "quoted 9 / billing 6" on the console.

### Stage 4 — the rest of the console

- The counts and the three "stuck" buckets (§8).
- Payment problems: the console line and the message to the carrier (§6.4).

---

## Appendix — files this touches

**Read and unchanged** (the spec is built on what these already decide):
`src/lib/fmcsa.ts` · `src/lib/site.ts` · `src/lib/claims.ts` ·
`src/lib/onboarding.ts` · `src/lib/fleet/active.ts` · `src/lib/billing/*` ·
`src/lib/notify/guard.ts` · `src/lib/notify/send.ts` · `src/lib/terms.ts` ·
`src/lib/proof/token.ts` · `src/lib/admin/operators.ts` ·
`src/lib/admin/claims-queue.ts` · `src/middleware.ts` ·
`src/pages/api/stripe/webhook.ts` · `src/pages/api/auth/email.ts` ·
`supabase/migrations/0021_carrier_claims.sql` ·
`supabase/migrations/0024_billing.sql` ·
`supabase/migrations/0025_terms_acceptance.sql` ·
`supabase/migrations/0026_share_token_hash.sql`

**New pages:** `/app/admin/index.astro` · `/app/admin/carriers.astro` ·
`/invite/[token].astro`

**New library:** `src/lib/admin/invitations.ts` (pure — buckets, badges, the
invite policy constants, the email copy), mirroring the shape of
`src/lib/admin/claims-queue.ts`.

**New migrations (intent only — the development agent writes the SQL):**
`carrier_invitations` · `carrier_invitation_sends` · `admin_lookups` ·
a migration adding `'invite'` to `claim_channel` and widening
`carrier_claims_hash_matches_channel` · `complete_carrier_invitation()`.

**New tests, at minimum:** the invite policy and rate verdicts as attacks (the
shape `tests/claims.test.ts` uses) · the token shape · the invitation bucket and
badge logic · that the acceptance refuses a wrong email, an expired invite, a
revoked invite and a used one · that a quote at N trucks equals `monthlyCents(N)`
for every N · that no admin page reads the secret key before the operator check
(the shape `tests/admin-access.test.ts` uses).
