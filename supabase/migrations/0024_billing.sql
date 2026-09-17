-- Billing: what Stripe says about this carrier's subscription.
--
-- WHAT THIS TABLE IS. A cache of Stripe's answer, one row per carrier, written
-- by the webhook and by nothing else. It is NOT the billing record — Stripe
-- holds the invoices, the card and the history, and a disagreement between this
-- table and Stripe is always resolved in Stripe's favour. What lives here is
-- only the handful of facts a screen has to show without making an API call on
-- every page load: are they paying, until when, and for how many trucks.
--
-- WHO MAY WRITE IT, AND WHY THE ANSWER IS "NOBODY WITH A BROWSER". The row
-- decides whether a carrier is a paying customer. A user who can write it can
-- grant himself a subscription, so `authenticated` gets SELECT and nothing else
-- — no INSERT, no UPDATE, no DELETE, no definer function either.
--
-- THAT LAST PART IS THE 0021 LESSON, APPLIED BY NOT DOING IT. 0021 needed a
-- SECURITY DEFINER function because a claim has to be written by the person
-- being verified. Nothing here does: every write comes from a Stripe webhook,
-- which has no signed-in user and uses the service key exactly as the digest
-- job does. And a definer function here would be worse than useless — PostgREST
-- publishes every function in this schema and the publishable key is in the
-- browser bundle, so `record_billing_customer(carrier, 'cus_someone_else')`
-- would be one curl away from pointing a carrier's billing portal at a stranger's
-- Stripe customer: their cards, their invoices, their address. The safe shape is
-- no write path at all, and the customer id arriving only from Stripe's own
-- signed webhook.
--
-- NO MONEY COLUMN, DELIBERATELY. The price is `monthlyPrice()` in
-- src/lib/site.ts and it must stay the only implementation of it. A dollar
-- amount stored here would be a second one, free to disagree with the pricing
-- page the customer was sold on. What is stored is the COUNT Stripe is billing;
-- the money is computed from it at read time, by the same function the marketing
-- page uses.
--
-- The matching TypeScript is src/lib/billing/, and the only writer is
-- src/pages/api/stripe/webhook.ts.

create table billing_subscriptions (
  -- One row per carrier, and the carrier id IS the key. A carrier who cancels
  -- and comes back later overwrites this row rather than adding a second: this
  -- is current state, not history, and Stripe keeps the history.
  carrier_id  uuid primary key references carriers (id) on delete cascade,

  -- Stripe's customer. Not null because a row with no customer is a row that
  -- can answer no question — the portal, the invoices and every later
  -- subscription all hang off it.
  stripe_customer_id text not null,

  -- Null between `checkout.session.completed` and the subscription event that
  -- follows it, and after a cancellation that Stripe has finished. A customer
  -- with no live subscription is a normal, expected state.
  stripe_subscription_id text,

  -- Stripe's own word, stored as Stripe spells it: trialing, active, past_due,
  -- canceled, unpaid, incomplete, incomplete_expired, paused.
  --
  -- TEXT WITH A SHAPE CHECK, NOT AN ENUM AND NOT A VALUE LIST, and the reason is
  -- which way each choice fails. Stripe adds subscription statuses on its own
  -- schedule (`paused` arrived years after the first six). Against an enum or a
  -- closed `check ... in (...)`, the first event carrying a new one makes the
  -- webhook write fail — Stripe retries, the retries fail too, and this row
  -- keeps saying `active` about a subscription that is not. Stale-but-generous
  -- is the wrong direction to be wrong in, and it is silent. So an unexpected
  -- status is STORED, and src/lib/billing/plan.ts decides what an unrecognised
  -- one means on screen.
  status      text not null,

  -- When the paid period Stripe has already charged for runs out. This is the
  -- date the screen shows as "next charge", so it is the one number on this
  -- table a customer will hold us to.
  --
  -- Nullable: a subscription that never completed payment has no period.
  current_period_end timestamptz,

  -- Set when they have pressed cancel and are running out the month they paid
  -- for. `status` is still `active` in that window — which is correct, they are
  -- still owed the service — so without this column the screen cannot tell a
  -- customer who is leaving from one who is staying, and would print "renews on
  -- the 4th" at somebody who cancelled.
  cancel_at_period_end boolean not null default false,

  -- The quantity Stripe is billing, as at the last event. NOT the number of
  -- trucks on the account right now: those two drift the moment a truck is added,
  -- and the whole point of storing this is to be able to SHOW the drift. See
  -- countBillableTrucks() for what a billable truck is.
  billable_trucks int,

  -- Stripe's trial end, when the subscription carries one.
  --
  -- It is NOT where the free trial lives. The product gives 30 days from signup
  -- with no card (site.pricing.trialDays), which is a fact about the carrier and
  -- is derived from carriers.created_at — it exists for every carrier, including
  -- every carrier who has never opened Stripe and therefore has no row here. A
  -- column that only exists for the minority would be the wrong home for it.
  -- This column holds the other thing: what Stripe was told when the
  -- subscription was created, so the two can be compared when they disagree.
  trial_ends_at timestamptz,

  -- The last event applied, and when Stripe created it.
  --
  -- WEBHOOKS ARRIVE OUT OF ORDER. Stripe says so plainly, and it is not rare
  -- under retries: `customer.subscription.updated` (cancelled) can land after a
  -- later `updated` (reactivated) that was generated after it. Without a
  -- comparison to refuse on, the LAST DELIVERY wins rather than the LATEST
  -- FACT, and the row ends up describing a state the subscription passed
  -- through rather than the one it is in. The writer only applies an event whose
  -- `created` is at or after this value.
  --
  -- stripe_event_id is kept beside it for support: "which event wrote this" is
  -- the first question asked when a row looks wrong, and it is answerable in the
  -- Stripe dashboard by id.
  stripe_event_id text,
  stripe_event_at timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Shapes, not contents. These catch a value that came from the wrong place —
  -- a subscription id written into the customer column, a publishable key, an
  -- empty string — at the moment it is written rather than as a 404 from Stripe
  -- three weeks later on a page that matters.
  constraint billing_customer_shape
    check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  constraint billing_subscription_shape
    check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  constraint billing_status_shape
    check (status ~ '^[a-z_]{1,40}$'),
  constraint billing_trucks_sane
    check (billable_trucks is null or billable_trucks >= 0)
);

-- ONE CARRIER PER STRIPE CUSTOMER, BOTH WAYS. carrier_id is already the primary
-- key; this is the other direction. Two carriers sharing one Stripe customer
-- would mean one card paying two subscriptions with one portal between them —
-- open it from either account and you see the other carrier's invoices and
-- address. A unique index is a cheaper guarantee than remembering.
create unique index billing_subscriptions_customer_idx
  on billing_subscriptions (stripe_customer_id);

-- Same argument for the subscription, and the same leak if it were shared.
-- Partial because null is the normal state between checkout and the first
-- subscription event, and nulls are not equal to each other anyway — the
-- `where` clause says that out loud rather than relying on it.
create unique index billing_subscriptions_subscription_idx
  on billing_subscriptions (stripe_subscription_id)
  where stripe_subscription_id is not null;

create trigger billing_subscriptions_touch before update on billing_subscriptions
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- RLS

-- ENABLE **and** FORCE, which is the shape 0002 uses for every table that holds
-- carrier records, and the opposite of the 0001/0021 exception. That exception
-- exists only for tables a SECURITY DEFINER function has to write as the owner;
-- nothing here runs as the owner. The webhook writes with the service key, and
-- `service_role` carries BYPASSRLS, so FORCE costs it nothing and closes the
-- owner path that nothing legitimate uses.
alter table billing_subscriptions enable row level security;
alter table billing_subscriptions force row level security;

-- Revoke first. RLS restricts rows; it does not grant table access, and a table
-- left with the default PUBLIC grant is reachable before a policy is consulted.
revoke all on billing_subscriptions from public, anon, authenticated;

-- SELECT on every column, and that is a decision rather than laziness. None of
-- these are secrets FROM the carrier: `cus_…` and `sub_…` are the carrier's own
-- identifiers, shown on their own Stripe invoices, and the billing page needs
-- the customer id to open the portal. Nothing on this table is the 0021 case —
-- there is no `code_hash` here, no value that is dangerous in the hands of the
-- person the row is about.
grant select on billing_subscriptions to authenticated;

-- NO INSERT, UPDATE OR DELETE FOR ANYBODY. Not narrowed, not column-listed:
-- absent. This row is the answer to "is this carrier paying us", and the only
-- thing on earth that knows is Stripe.
create policy billing_subscriptions_read on billing_subscriptions
  for select to authenticated
  using (carrier_id in (select current_user_carriers()));

comment on table billing_subscriptions is
  'Cache of Stripe subscription state, one row per carrier. Written only by the Stripe webhook with the service key; authenticated may read its own carrier and write nothing.';

comment on column billing_subscriptions.billable_trucks is
  'Quantity Stripe is billing as at the last event, NOT the live fleet count. The difference between the two is what the billing screen exists to show.';
