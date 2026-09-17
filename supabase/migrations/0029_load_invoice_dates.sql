-- The two dates a load has never had, and the reason every money screen in this
-- app has so far had to apologise for its own figures.
--
-- WHAT WAS MISSING. 0009_loads.sql gives a load exactly one moment in time:
-- `created_at`, the day somebody typed it into FleetView. Nothing records the
-- day the invoice went out and nothing records the day the money arrived. There
-- is no payments table either, so there is no second place to look.
--
-- The cost of that is not academic. Everything downstream that says money is
-- late has had to age from the day the load was ENTERED, which is always
-- EARLIER than the invoice behind it. An owner who reads "more than 90 days"
-- off the receivables chart and repeats it down the phone to a broker whose
-- invoice went out three weeks ago has been handed an argument he loses, by us.
-- And the question a customer page exists to answer — "do they actually pay the
-- way they promised to pay" — could not be answered at all: `days_to_pay` on
-- the customer is what was AGREED, and there was no measured number anywhere to
-- set beside it.
--
-- WHY TWO COLUMNS AND NOT A PAYMENTS TABLE. A payments table is the right shape
-- for part payments, short pays and one cheque covering four invoices, and none
-- of that is what this migration is for. This is the smallest honest fix: the
-- day the paper went out and the day the money landed, one of each, on the row
-- they belong to. A short pay is already carried by `billing = 'short_paid'`,
-- and when part payments have to be modelled properly they get their own table
-- and these two columns keep meaning exactly what they mean today.
--
-- DATE, NOT TIMESTAMPTZ. "The invoice went out on the 3rd" is not an instant.
-- Stored as a timestamp it would move for a reader in another timezone, and the
-- whole point of the column is that a person can say the date out loud. Same
-- rule `reminders.due_on`, `compliance_records.occurred_on` and
-- `settlements.paid_on` already follow.
--
-- BOTH NULLABLE, AND NULL IS A REAL ANSWER. A load that has not been invoiced
-- has no invoice date; an invoice nobody has paid has no payment date. Neither
-- is an error and neither may ever be filled in with a guess: a defaulted date
-- here would silently become the date an aging chart counts from and the date a
-- customer's measured pay speed is worked out from. Every screen that reads
-- these draws the dashed gap and the words for it when they are NULL, never a
-- figure.
--
-- TENANCY AND RLS: THERE IS NOTHING TO DO HERE, AND THAT IS THE POINT.
-- `loads` already carries, from 0009_loads.sql:
--   * `enable row level security` and `force row level security`
--   * one `for all` policy, `loads_rw`, keyed on
--     `carrier_id in (select current_user_carriers())` both USING and WITH CHECK
--   * table-level grants (select, insert, update, delete) to `authenticated`
--     and nothing at all to `public` or `anon`
--   * the `loads_touch` trigger on update
-- A Postgres policy covers every column of its table, including columns added
-- after the policy was written, and grants here are table-level rather than
-- column-level. So these two arrive inside exactly the same tenancy fence as
-- `linehaul_cents`, with no new policy, no new grant and no new trigger. Adding
-- any of those would be a SECOND answer to "whose load is this", which is how a
-- tenancy hole eventually gets opened by somebody tidying up.

alter table loads
  add column invoiced_on date,
  add column paid_on     date;

comment on column loads.invoiced_on is
  'The day the invoice for this load went out. NULL means it has not been invoiced, or that nobody recorded the date — never a default, because receivables are aged from this column and a guessed date ages money wrongly.';

comment on column loads.paid_on is
  'The day the money for this load arrived. NULL means it has not been paid, or that nobody recorded the date. With invoiced_on this is the only way to measure how long a customer really takes, against the days_to_pay they agreed to.';

-- Money does not arrive before the invoice that asks for it.
--
-- Without this, one transposed date produces a NEGATIVE wait, and a negative
-- wait averaged into a customer's measured pay speed makes a slow broker look
-- fast on the screen an owner uses to decide whether to take their next load.
-- Refusing it at the row is the only place the rule holds against psql and
-- against an import as well as against a form.
--
-- Written so that either column being NULL passes: an invoice with no payment
-- yet, and a payment recorded before anybody went back and filled in the
-- invoice date, are both ordinary states.
alter table loads
  add constraint loads_paid_on_after_invoiced_on
  check (paid_on is null or invoiced_on is null or paid_on >= invoiced_on);
