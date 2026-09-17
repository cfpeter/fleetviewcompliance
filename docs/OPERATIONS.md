# Running it

## The daily digest

`POST /api/cron/digest` with the shared secret. It is idempotent: every message
carries a dedup key and `notification_log` has a unique index on it, so running
the job twice sends nothing twice.

```bash
curl -X POST https://fleetviewcompliance.com/api/cron/digest \
  -H "x-cron-secret: $CRON_SECRET"
```

It returns a summary:
`{ carriers, considered, sent, held, skipped, suppressed, failed }`, plus
`reconciled`, `complaints` and `suppressionList`.

`held` is its own number and not a kind of `skipped`. A held message is one the
recipient's quiet hours caught: nothing was sent, **and nothing was written to
`notification_log`**, because the dedup key a log row would take is the same key
that would then suppress the message forever. Held messages are re-derived from
scratch on the next run and go out once the window has passed.

A standing `held` count that never falls to zero means the job only ever runs
inside somebody's quiet window. Run it more than once a day, or at an hour
outside it — the message is waiting, not lost.

### The silent delivery failure, and the two halves that close it

**Resend answers `POST /emails` with HTTP 200 and a message id for an address it
has SUPPRESSED, and then drops the mail.** Checking `res.ok` therefore records
`sent` about a message nobody will ever read: a carrier stops receiving deadline
warnings and neither he nor we ever find out. Every other failure in this system
at least announces itself. This one is the reason the product's promise fails
quietly, so it gets two defences rather than one.

Measured against the live API, and the measurements are what the design is built
on:

| | what it gives | the catch |
|---|---|---|
| `POST /emails` | `{"id": "..."}` | **no delivery signal at all** |
| `GET /emails/{id}` | `last_event` | `queued` at +0s, `suppressed` at +2s — knowable in seconds, not synchronously |
| `GET /suppressions` | `id, email, origin, source_id, created_at` | **incomplete** — a reliably-suppressed address was absent from it |

1. **Pre-send.** One `GET /suppressions` per run (never per message), matched
   case-insensitively, checked **after `guard.ts` has resolved the destination**
   — so on dev it tests the developer's address, which is where the message is
   actually going. A recipient on the list is counted as `suppressed` and
   **writes no `notification_log` row**, exactly as `held` does and for the
   identical reason: the dedup key must survive so the message can go out once
   the address is fixed.
2. **Reconciliation.** `send()` records the provider's message id on the row.
   The *next* digest run, before it derives anything, reads `last_event` for
   recent unresolved rows and writes `notification_log.delivery_state`. That
   column is deliberately separate from `status`: `status` stays true to what the
   send attempt returned, and `delivery_state` carries the later fact. The
   `alreadySent` read excludes `delivery_state = 'undelivered'`, which is what
   un-spends the key.

The pass is bounded on every axis — email only, `delivery_state = 'unknown'`, a
message id present, `sent_at` inside 48 hours, newest first, at most
`DIGEST_RECONCILE_LIMIT` (default 50) lookups — and backed by a partial index, so
it cannot grow into a scan as the log grows. The ceiling exists because every
lookup is a Cloudflare subrequest and exhausting that budget would take the whole
digest down: trading a silent delivery failure for a silent digest is the worse
of the two.

`suppressionList: unavailable` means the pre-send half could not be read this
run. That is a warning, not a failure — refusing to send whenever Resend blips
would silence every warning in the product — but the run leaned entirely on
reconciliation, which catches a dead address one run late.

`complaints` counts messages that DID arrive and were marked as spam. Not in
`suppressed`, and never re-sent: nothing is owed, and re-sending to somebody who
pressed "spam" is how a sending domain is burned.

### ⚠️ `0022_notification_delivery.sql` is NOT APPLIED

The migration adding `provider_message_id`, `delivery_state`, `delivery_detail`
and `delivery_checked_at` is written and **has not been run against any
database**. Until it is, the digest's log writes and its `alreadySent` read both
reference columns that do not exist and will fail. Apply it before deploying:

```bash
node scripts/migrate.mjs --dry   # 0022 should be the only pending file
node scripts/migrate.mjs
```

### SMS: what Twilio does and does not share

Twilio's equivalent of a suppression — a number that replied STOP — is refused
**synchronously**: HTTP 400, error 21610. `!res.ok` already turns that into
`failed`, which is already logged and already red, so the silent half does not
exist on that side and nothing was built for it.

What Twilio *does* share is the asynchronous half: a 201 carries
`status: queued`/`accepted`, which is acceptance and not delivery, and a message
can still end `undelivered` at the carrier. That is **not** reconciled, on
purpose — SMS cannot send at all until 10DLC registration is live, and none of
Twilio's behaviour has been measured the way Resend's has. The `sid` is recorded
on the row now so that the handle exists when the channel is switched on.

### Why not a Cloudflare cron trigger

Cloudflare cron triggers deliver a `scheduled` event. The Astro Cloudflare
adapter generates a worker exporting only `fetch`, so a declared trigger would
fire every morning, find no handler, and fail **silently** — the worst possible
failure mode for a job whose whole purpose is to be noticed when it stops.

Drive it externally instead (GitHub Actions scheduled workflow, or any cron
host). If a Cloudflare trigger is wanted later it needs a small wrapper worker
whose `scheduled` handler fetches this endpoint — at which point the trigger
belongs in that worker's config, not this one.

**Whatever runs it must alert when it fails.** A silent digest job is
indistinguishable from a quiet week, and this product's entire promise is that
we tell you before it bites.

### The GitHub Actions workflow

`.github/workflows/digest.yml`. Three runs a day, `workflow_dispatch` for
running it by hand, and it goes red on anything that is not a clean send.

Two repository settings before it can work:

| Where | Name | Value |
|---|---|---|
| Settings → Secrets and variables → Actions → **Secrets** | `CRON_SECRET` | the same value the Worker has |
| Settings → Secrets and variables → Actions → **Variables** | `DIGEST_URL` | optional; defaults to the production URL |

`CRON_SECRET` is a secret and not a variable because a variable is readable by
anyone who can see the repository, and it is the only thing between the open
internet and the send path.

**It fails on `failed > 0` and on `suppressed > 0`, not only on a bad status
code.** The endpoint returns HTTP 200 while reporting that it reached a provider
and the provider refused — so a workflow that checks the status code alone
reports a green tick on the morning nothing went out. `held` is the opposite case
and is only a notice: the message was caught by a quiet window, nothing was
logged, and it is re-derived on the next run. That is what the 23:00 run is for.

The two red counters are kept apart because their fixes are:

| counter | what happened | who fixes it |
|---|---|---|
| `failed` | we reached the provider and it refused | check the provider |
| `suppressed` | the address is dead — bounced, or suppressed at Resend | check the recipient, then `notification_log.delivery_state` |

**THE FAILURE MODE THIS FILE CANNOT CATCH:** GitHub disables scheduled workflows
in a repository with no commits for 60 days. It emails first, but if that mail is
missed the digest stops — and stops *quietly*, which is the one thing the rule
above forbids. Either touch the repo inside 60 days or put an external
dead-man's-switch on it (a healthcheck ping the job hits on success, alerting
when the ping stops). GitHub's own notification only fires when a run FAILS;
nothing fires when a run never happens.

## Nothing in dev may reach a real person

Two separate systems send mail from this product, and only one of them obeys our
guard. Both have to be closed or dev can email a stranger.

### What the guard covers — every message this codebase sends

`src/lib/notify/guard.ts` sits in front of `send()`, and `DEPLOY_ENV` is not
`production` on the dev Worker, so:

| channel | dev behaviour |
|---|---|
| email | redirected to `DEV_REDIRECT_EMAIL` (`cfbedo@yahoo.com`), original recipient noted on the message |
| SMS | redirected to `DEV_REDIRECT_PHONE` (`+18183340168`) |

E.164 format, with the `+1`. Twilio rejects anything else, and the rejection
arrives as a `failed` count in the digest summary rather than as an obvious
formatting error.

An unset redirect is a refusal, never a pass-through: an unconfigured
environment means somebody has not finished setting it up, and the safe reading
of that is "send nothing", not "send to the customer". That is why both values
are set explicitly rather than left blank and assumed harmless.

**Neither channel can actually send yet.** `RESEND_API_KEY` and the three
`TWILIO_*` values are not configured on the dev Worker, and `send()` reports
`skipped` when a provider is missing. The redirects above are what will happen
once those keys exist — they are set now so that the first time sending is
switched on, it cannot reach a carrier.

### Sharing the production email setup with dev — one yes, one no

There are two senders in this product and they need opposite answers.

**Our own notifications (Resend, sent by our code): share it.** The digest and
every alert pass through `guard.ts`, which rewrites the recipient on dev. Same
verified domain and the same `info@fleetviewcompliance.com` from-address are
fine — what protects the carrier is the guard, not a separate domain, and dev
volume is one developer's inbox so there is no sender-reputation cost. Use a
SEPARATE Resend API key for dev against the same domain, so dev's key can be
revoked without touching production.

**Supabase Auth (confirmations, password resets): never share it.** See below —
it does not pass through our code at all. Configuring the working SMTP on the
DEV Supabase project is the single change that would turn a contained
environment into one that emails strangers from your domain.

| | dev | production |
|---|---|---|
| Resend, our alerts | same domain, own API key | same domain |
| Supabase Auth SMTP | leave on Supabase's built-in sender | configure yours |

On dev, Supabase's built-in sender reaching only project team members IS the
safety net. On production that same limit is what blocks real customers from
confirming their address, and configuring SMTP there is what unblocks signup.

### What the guard does NOT cover — Supabase Auth

`src/pages/login.astro` calls `supabase.auth.signUp()`. **Supabase sends that
confirmation email itself, directly to whatever address was typed into the
form.** It never passes through this codebase, so no guard, no redirect, no
`DEPLOY_ENV`. Anyone who reaches the dev signup form with a real address gets a
real email. The same is true of password resets and magic links.

Two things close it, and both should be on:

1. **Cloudflare Access in front of `dev.fleetviewcompliance.com`** (Zero Trust →
   Access → Applications), restricted to your own addresses. This is the real
   fix: nobody reaches the form, so nothing can be typed into it.
2. **In the dev Supabase project, leave the built-in SMTP in place.** Supabase's
   default sender only delivers to project team members, at a couple of messages
   an hour — containment by accident, but real. **Do not configure a custom SMTP
   (Resend, SendGrid) on the dev project.** The moment you do, its auth emails
   reach anybody, and nothing in this repository can stop them.

### The FMCSA / USDOT lookups

Read-only GETs against a public Socrata dataset. No account, no outbound
messaging, nothing attributable to a carrier. Safe to run in dev.

## Sending is denied by default

`src/lib/notify/guard.ts` refuses to send unless `DEPLOY_ENV=production`. In any
other environment every message is redirected to `DEV_REDIRECT_EMAIL` /
`DEV_REDIRECT_PHONE`, and if those are unset **nothing is sent at all**.

That inversion is deliberate. The bug it prevents: a developer runs the digest
against production data and forty real carriers get a 6am text about a deadline
they do not have. An unset redirect means somebody has not finished configuring
the environment, and the safe reading of that is "send nothing" — never "send it
to the customer".

## Before SMS can be switched on

1. **10DLC registration** — roughly $44 brand + $15 vetting + $1.50–10/month,
   and **1–4 weeks to approve**. Register with an EIN, not as a sole proprietor.
2. Only then set `TWILIO_*`. Until the campaign is live, `send()` reports
   `skipped: sms provider not configured` and the settings page says so.
3. **Do not add "Reply STOP" to message bodies** until the registered campaign's
   opt-out handling is verified working. The previous build shipped bodies
   promising STOP with no inbound route to honour it — a promise the system
   could not keep, and one that blocks A2P registration.
4. Watch the segment maths: 160 GSM-7 characters is one segment, but a single
   accented character forces UCS-2 and cuts that to 70. The budget roughly halves
   the moment this is localised.

## Deploying: two environments, one domain

Two Cloudflare Workers, two hostnames, two Supabase projects, two R2 buckets.
Nothing is shared between them except the code.

| | dev | production |
|---|---|---|
| Worker | `fleetview-compliance-dev` | `fleetview-compliance` |
| Host | `dev.fleetviewcompliance.com` | `fleetviewcompliance.com` |
| `DEPLOY_ENV` | `development` | `production` |
| R2 | `fleetview-documents-dev` | `fleetview-documents` |
| Supabase | the existing dev project | a new project, not yet created |
| Deploy | `npm run deploy:dev` | `npm run deploy:prod` |

There is no default environment. A bare `wrangler deploy` has no target and
fails, because a default that happens to be production is a default that
eventually gets used by accident.

### Deploys use a project token, not this machine's wrangler login

`npm run deploy:*` goes through `scripts/deploy.mjs`, which reads
`CLOUDFLARE_API_TOKEN` from `.env` and **refuses to run unless that token can see
`fleetviewcompliance.com`**.

This is not ceremony. `wrangler login` is global and per-machine: this laptop was
logged in to a different product's Cloudflare account, and a deploy would have
created a `fleetview-compliance-dev` Worker and an R2 bucket over there with no
error and no warning — a working deployment on the wrong account, found weeks
later. Same reasoning as the per-repo SSH keys already in `~/.ssh/config`: one
credential per project, no shared global state another project can change
underneath you. It also means you never have to log wrangler in and out to move
between products.

Create the token on the account that owns the domain — dashboard → My Profile →
API Tokens → Create Token → Custom:

| Scope | Permission | Level |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | Workers R2 Storage | Edit |
| Zone | Zone | Read |

`Zone:Read` is what the guard checks with. A token without it lists no zones and
is refused — which reads identically to the wrong account, so grant it.

Put it in `.env` (gitignored) as `CLOUDFLARE_API_TOKEN=`. For one-off `wrangler`
commands outside the npm scripts, prefix them:
`CLOUDFLARE_API_TOKEN=$(grep ^CLOUDFLARE_API_TOKEN= .env | cut -d= -f2-) npx wrangler ...`

### Do the subdomain first. Do not touch the apex.

`fleetviewcompliance.com` currently resolves to the OLD app on Vercel. Adding
`dev.` is purely additive and cannot affect it. Cutting the apex over to a
Worker that has never served a request is how a working site becomes a broken
one at 6pm on a Friday.

1. **Cloudflare → Workers → `fleetview-compliance-dev` → Settings → Domains &
   Routes → Add → Custom Domain → `dev.fleetviewcompliance.com`.** Cloudflare
   creates the DNS record itself; do not add one by hand first, or the custom
   domain will collide with it.
2. **Put Cloudflare Access in front of it** (Zero Trust → Access → Applications),
   restricted to your own email. Two problems, one control: it keeps
   `dev.` out of Google as duplicate content competing with the real marketing
   site, and it stops anyone who finds the hostname from signing up on a
   database full of test carriers. Free at this size.
3. `npm run secrets:dev` — the dev Supabase keys, `CRON_SECRET`,
   `DEV_REDIRECT_EMAIL`. **`DEPLOY_ENV` is NOT a secret and must not be set
   here**; it lives in `wrangler.jsonc` where a change to it shows up in a diff.
4. `npm run deploy:dev`.

### The apex cutover, when production is ready and proven

Not before there is a production Supabase project, its data, and a dev
deployment you have actually used.

1. Create the production Supabase project; run the migrations against it.
2. `npm run secrets:prod`, then `npm run deploy:prod`. The Worker is live but no
   domain points at it yet — verify on its `*.workers.dev` URL.
3. **In Vercel, remove the custom domain `fleetviewcompliance.com` from the old
   project.** Do this before touching DNS: a domain claimed by two platforms
   fails in ways that look like a DNS problem and are not.
4. In Cloudflare DNS, delete the records pointing at Vercel (the apex `A`/`CNAME`
   and `www`).
5. Add `fleetviewcompliance.com` as a Custom Domain on the `fleetview-compliance`
   Worker, and decide what `www` should do — redirect to apex, most likely.
6. Only then point the digest at production: set the repo variable `DIGEST_URL`
   to the apex. Until that moment it should point at `dev.`, or every scheduled
   run posts to the old Vercel app, 404s, and goes red every morning for reasons
   that have nothing to do with the digest.

**While disconnecting Vercel, rotate `RESEND_API_KEY`.** The old project's
`vercel-env.credentials.local` had it in plaintext and it has been read aloud
once already. Rotate it at Resend, set the new value on the production Worker,
and never put it back in a file.

### What goes wrong if this is done carelessly

- **`DEPLOY_ENV=production` on the dev Worker.** `src/lib/notify/guard.ts` treats
  that value as permission to send to real recipients. The dev Worker points at
  the dev database today, but the day somebody restores a copy of production
  into it, that flag is the only thing between a test run and forty carriers
  receiving real email about deadlines that are not theirs.
- **One R2 bucket for both.** The dev deployment would read and overwrite real
  carriers' medical certificates — the documents this product exists to protect.
- **The apex cut over before production has data.** Every carrier who visits sees
  an app with no record of them.

## Environment

See `.env.example`. Two values are only for scheduled jobs and must never be
read by request-handling code:

- `CRON_SECRET` — without it `/api/cron/digest` refuses to run rather than
  defaulting to unauthenticated.
- `CLAIM_CODE_PEPPER` — at least 32 characters, **different in every
  environment**. A USDOT verification code is six digits, so a bare SHA-256 of
  one is a million digests away from plaintext; this value is the only thing
  that makes a stolen `carrier_claims` row useless. `hashClaimCode` refuses to
  run without it rather than falling back to an unpeppered hash. Rotating it
  invalidates every claim in flight, which is an acceptable cost and worth
  knowing before you do it during business hours.
- `SUPABASE_SECRET_KEY` — the one legitimate use of a privileged key. A
  scheduled job has no signed-in user to act as and must read across every
  carrier. It is read from the environment inside the job only; no page imports
  it, so a mistake in a page cannot reach it.

## Migrations

```bash
node scripts/migrate.mjs --dry   # list pending
node scripts/migrate.mjs         # apply
```

Connects through the **session pooler on 5432**, not the transaction pooler on
6543: transaction mode does not hold session state, which the RLS tests depend on.
The direct `db.<ref>` host is IPv6-only and this network is IPv4-only.

## Dev accounts

Supabase requires email confirmation and its built-in SMTP only reaches project
team members at a couple of messages an hour, so the signup form cannot complete
a round trip locally.

```bash
ALLOW_SEED=1 node scripts/seed-dev-user.mjs owner@fleetview.test testpass123
```

## When the dev server serves `Error` on every route

Vite's SSR dependency cache goes stale after concurrent edits. It looks exactly
like broken code and is not:

```bash
rm -rf node_modules/.vite .astro dist
```

## Connecting an ELD

`src/lib/eld/` reads hours of service from whatever device the carrier already
has. We do not build an ELD — it is a regulated device and every customer
already pays for one.

We read exactly four things, because they answer the only question dispatch
needs: **can this driver legally finish this run before we commit to the
shipper?** Drive time remaining, shift time remaining, cycle time remaining, and
time until a required break.

### ⚠️ The Motive adapter is UNVERIFIED

`src/lib/eld/motive.ts` has never been run against the real API. Motive's HOS
endpoints need a partner key this project does not have, and an adapter that
*looks* tested is worse than none — the first person to connect an account would
trust numbers nobody has ever seen.

Before it goes anywhere near the dispatch screen:

1. Get a key. Motive's is self-serve with a test mode, which is why it is first
   in line; Samsara and Geotab need a partner agreement before you can see a
   response at all.
2. Run it against **one real driver**, and check every field against what the
   Motive dashboard shows for that same driver at that same moment.
3. Only then wire it into dispatch.

The adapter is written defensively in the meantime: anything it does not
recognise returns `error`, never a snapshot with zeros in it — because zeros
read as "this driver is out of hours" and would park somebody who is fine.

### The three-valued answer

`canFinish()` returns `yes` / `no` / **`unknown`**, and the third is the whole
point. Collapsing "we cannot see his hours" into `no` parks a legal driver;
collapsing it into `yes` is the one that ends in a violation. A reading older
than 30 minutes is also `unknown` — an ELD that stopped reporting four hours ago
is not telling you the driver has four hours left, it is telling you nothing,
and the number on screen would be the most dangerous kind of wrong: precise,
plausible, and stale.

## Rate confirmation intake — deliberately not built

The research is clear that rate cons arrive as **email PDFs, all day**, and that
the eventual pipeline is: per-tenant inbound address → classify the attachment →
extract fields → **a ten-second review screen that never auto-commits** → attach
the original PDF permanently.

None of that is built, and the blocker is not the extraction. It needs an
inbound email domain and a per-tenant address scheme that does not exist yet.

What IS built is the part the research says must come first: **manual entry plus
attaching the PDF**. That is not a fallback. A carrier who cannot type a load in
by hand will not trust the automatic path, and the competitor complaints in this
category are about extraction that misses fields with no fast way to correct it —
the failure is the absent review step, not the parser.

## Billing

The screen is `/app/billing`. It works with no Stripe configured: it shows the
fleet count, the price from `monthlyPrice()`, the free-trial dates, and says in
plain words that card payment is not switched on and nothing is being charged.
Turning Stripe on is four steps in the Stripe dashboard and three secrets.

**1. Create the price — and create it as VOLUME tiers.** Product: one recurring
product, monthly, USD. Price: *Usage is metered* off, *Package/tiered* →
**Graduated is wrong**, choose **Volume**:

| First unit | Last unit | Per unit | Flat fee |
|---|---|---|---|
| 1 | 4 | — | **$29.00** |
| 5 | ∞ | **$6.00** | — |

That reproduces `max(trucks × $6, $29)` exactly. Graduated tiers would charge a
five-truck fleet $35 instead of $30, and every invoice above four trucks would
disagree with `/pricing`. `tests/billing.test.ts` checks the tier arithmetic
against `monthlyPrice()` for every fleet size from 1 to 200 — if the price
numbers in `src/lib/site.ts` ever change, read that table off
`STRIPE_VOLUME_TIERS` again and edit the Stripe price to match.

**2. Add the webhook endpoint.** URL `https://<host>/api/stripe/webhook`, events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Copy its signing secret (`whsec_…`).

**3. Turn on the customer portal.** Stripe → Settings → Billing → Customer
portal. Without it the "Card, invoices and cancel" button fails, and `/pricing`
promises "you can cancel any month".

**4. Set the secrets**, per environment, with `npm run secrets:dev` /
`npm run secrets:prod`:

```
STRIPE_SECRET_KEY=sk_test_…   (sk_live_… only where DEPLOY_ENV=production)
STRIPE_PRICE_ID=price_…
STRIPE_WEBHOOK_SECRET=whsec_…
```

Use a **test-mode** key, price and webhook on dev and live ones on production —
they are separate objects in Stripe and the ids do not carry over.
`readStripeConfig()` refuses an `sk_live_` key anywhere `DEPLOY_ENV` is not
`production`, the same rule `src/lib/notify/guard.ts` applies to email and SMS,
so a button press on dev cannot create a real subscription against a real card.

### What is deliberately not automatic

Nothing pushes the truck count to Stripe on its own. When the fleet changes, the
billing screen prints both numbers — what Stripe is billing and what the
account holds — and the owner presses a button to send the new one. The error
runs in the customer's favour: a fleet that grows is under-billed until somebody
presses it, never over-billed.

Nothing is gated on payment either. `isEntitled()` in `src/lib/billing/plan.ts`
exists so that a future paywall has one definition to ask, but no page calls it
and no feature is switched off when a trial ends.

### Reading `import.meta.env` is not safe for secrets here

Measured on this repo's own build output: Vite replaces the whole
`import.meta.env` expression with an object literal containing every variable
the build machine's `.env` held, non-`PUBLIC_` ones included, and indexing it
with a variable does not prevent that. `dist/server/chunks/digest_*.mjs` did
contain `CRON_SECRET`, `CLAIM_CODE_PEPPER`, `SUPABASE_SECRET_KEY` and
`RESEND_API_KEY` in plain text for exactly that reason. `src/lib/billing/config.ts`
therefore reads `cloudflare:workers` and falls back to `process.env` only, so a
Stripe key is never compiled into anything.

**Fixed everywhere as of this change.** `src/pages/api/cron/digest.ts` and
`src/pages/app/setup.astro` were the two computed-key readers; both now use the
same `cloudflare:workers` → `process.env` pair, and searching the built bundle
for the real values returns nothing. A LITERAL key is still fine and still used
— `import.meta.env.PUBLIC_SUPABASE_URL` replaces exactly that one public string
— and `tests/env-inlining.test.ts` fails the build if a computed one comes back.

Two consequences worth knowing before the next deploy:

- **`.dev.vars` now holds the dev secrets and is gitignored.** `.env` no longer
  reaches the Worker in local dev, because nothing reads `import.meta.env` by a
  variable any more. Wrangler binds `.dev.vars` at runtime instead, the same way
  `wrangler secret` binds a value in a deployment, and it must keep
  `DEPLOY_ENV=development` as its first line — that is still the send guard.
  `.dev.vars.example` is the tracked copy. Do NOT pipe `.dev.vars` into
  `wrangler secret bulk`: it would upload `DEPLOY_ENV` as a secret, which is
  exactly what the dev-deploy step below forbids.
- **Anything the Worker reads must actually be in the Worker.** Values that used
  to arrive inlined are now read at runtime, so `CRON_SECRET`,
  `SUPABASE_SECRET_KEY`, `CLAIM_CODE_PEPPER`, `RESEND_API_KEY`,
  `DIGEST_FROM_EMAIL`, the three `TWILIO_*` values and the `DEV_REDIRECT_*` pair
  have to be present via `wrangler secret` (or `vars`) on each deployment. The
  two `PUBLIC_*` values the digest reads keep a literal fallback, so they need
  nothing. Check with `npx wrangler secret list` before deploying; a missing
  `CRON_SECRET` makes the digest answer 503 and a missing `CLAIM_CODE_PEPPER`
  takes the USDOT code path offline.
