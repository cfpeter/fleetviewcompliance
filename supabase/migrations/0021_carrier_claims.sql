-- Proving a USDOT number belongs to the person claiming it.
--
-- THE HOLE. `carriers.dot_number` is UNIQUE and, until this migration, any
-- signed-in user could call create_carrier() with any number at all. A USDOT
-- number is public — it is painted on the door of every truck on the interstate
-- — and the numbers are SEQUENTIAL. So the entire market was claimable from a
-- script: walk 1..4,000,000 overnight, and every carrier in the country is
-- locked out of their own record with no invite mechanism and no transfer path.
-- First-claim-wins is not a policy anybody chose; it is what a UNIQUE constraint
-- does when nothing else is asked.
--
-- THE PROOF WE CAN ACTUALLY MAKE. The FMCSA census file carries the carrier's
-- own phone number and, on newer registrations, an email address. Send a code
-- there and whoever reads it is somebody the federal record already says is the
-- carrier. That is control of the contact point the government holds, which is
-- the same standard a bank uses for a password reset, and immeasurably better
-- than "typed it first".
--
-- WHAT THE DATA FORCED. Measured over California registrations: phone is on
-- 98-100% of anything registered since DOT 1,000,000, email on 39-99%. Phone is
-- therefore the primary channel and email the option when present. And 37% of
-- the OLDEST records have neither, which is not a rounding error — those
-- carriers cannot self-verify by any mechanism we can build, so 'manual' is a
-- first-class channel here rather than an error state.
--
-- The matching TypeScript is src/lib/claims.ts. This file is the ENFORCEMENT
-- POINT: PostgREST exposes every function in this schema to any signed-in user
-- holding the publishable key, so a rule that lives only in an Astro page is a
-- rule a curl command skips.

create type claim_channel as enum (
  'phone',   -- a code by SMS to the census phone. The common case.
  'email',   -- a code to the census email, when the record carries one.
  'manual'   -- no contact on file: a human has to look. Holds no code at all.
);

-- ------------------------------------------------------------- the table

-- No foreign key to `carriers`, deliberately: the whole point of a claim is
-- that it happens BEFORE the carrier row exists. The DOT number is text for the
-- same reason it is text on `carriers` — it is an identifier, never arithmetic.
create table carrier_claims (
  id            uuid primary key default gen_random_uuid(),
  dot_number    text not null,

  -- The claim binds to the authenticated user and to nothing else. Never a
  -- cookie, never a form field, never an email address typed into the page:
  -- every one of those is chosen by the person we are trying to verify.
  user_id       uuid not null references profiles (id) on delete cascade,

  channel       claim_channel not null,

  -- What we SHOWED the claimant — '(•••) •••-0168'. Stored so the "enter the
  -- code" screen can say where it went without looking the census row up again,
  -- and so support can see what the user saw. Never the real destination: this
  -- column is readable by the user and a masked value that is only masked in the
  -- page is not masked.
  destination_mask text,

  -- THE CODE IS NEVER STORED. Only a peppered SHA-256 of it, and the check
  -- constraint below makes it structurally impossible to put six digits in this
  -- column by accident. The pepper is a Worker secret that is NOT in this
  -- database — without it a leak of this table is one million digests away from
  -- every live code, because six digits is a keyspace you can exhaust in under a
  -- second. See hashClaimCode() for the full reasoning.
  code_hash     text,

  -- Fifteen minutes for a code claim; a month for a manual request, which is a
  -- support queue item rather than a live secret. Every claim gets a horizon:
  -- a request with no end date is a request nobody ever closes.
  expires_at    timestamptz not null,

  -- Guesses spent. Capped at 5 by complete_carrier_claim(). Six digits is a
  -- million possibilities, which sounds like a lot and is nothing to a script —
  -- the cap, not the length, is what makes the code worth anything.
  attempts      int not null default 0,

  verified_at   timestamptz,

  -- Set when the send did not actually go out (provider refused, or no provider
  -- configured). It kills the claim so the page does not sit there saying "we
  -- sent you a code" when nothing left the building. It does NOT refund the rate
  -- limit — see void_carrier_claim().
  voided_at     timestamptz,

  -- Whatever the claimant told us on a manual request. Free text, for a human.
  note          text,

  created_at    timestamptz not null default now(),

  -- The same shape normalizeDot() produces: digits, no leading zeros, 1-8 long.
  -- Two spellings of one number would be two separate rate-limit buckets.
  constraint carrier_claims_dot_shape check (dot_number ~ '^[1-9][0-9]{0,7}$'),

  -- Hex SHA-256 or nothing. A plaintext code cannot be written here even by a
  -- mistake in application code, which is the point: the constraint is a second
  -- pair of eyes on the one rule that matters most in this table.
  constraint carrier_claims_hash_shape check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$'),

  -- A code channel with no hash is a claim nothing can ever complete; a manual
  -- request with a hash is a code nobody was sent.
  constraint carrier_claims_hash_matches_channel check (
    (channel = 'manual' and code_hash is null) or (channel <> 'manual' and code_hash is not null)
  ),

  constraint carrier_claims_attempts_sane check (attempts >= 0),
  constraint carrier_claims_note_length check (note is null or length(note) <= 2000)
);

-- Rate limiting reads these two, on every send, so they are indexes and not a
-- sequential scan over every claim ever made.
create index carrier_claims_dot_idx  on carrier_claims (dot_number, created_at desc);
create index carrier_claims_user_idx on carrier_claims (user_id, created_at desc);

-- One open manual request per person per number. Without it, a support queue
-- fills with the same request from the same owner clicking twice.
create unique index carrier_claims_one_open_manual
  on carrier_claims (dot_number, user_id)
  where channel = 'manual' and verified_at is null and voided_at is null;

-- ---------------------------------------------------------------- RLS

-- ENABLE, and deliberately NOT FORCE — the rule 0001 documents at length. All
-- three functions below are SECURITY DEFINER and run as this table's owner.
-- Under FORCE the owner is subject to the policies too, and since the only
-- policy here is granted `TO authenticated`, a definer function running as the
-- owner would match NO policy, and no applicable policy means deny. Every write
-- in this file would fail.
--
-- The usual argument for FORCE does not apply here anyway: this table holds no
-- carrier records. It holds pending claims, and nothing reads it except these
-- functions and the claimant looking at their own row.
alter table carrier_claims enable row level security;

revoke all on carrier_claims from public, anon, authenticated;

-- SELECT only, and COLUMN BY COLUMN so that `code_hash` is not in the list.
-- `grant select on carrier_claims` would hand the claimant the hash of their own
-- code, which is harmless today and is exactly the sort of thing that ends up in
-- a browser cache, a screenshot or a bug report. The remaining columns are all
-- things the page has to show or filter on.
--
-- No INSERT, UPDATE or DELETE for anybody. Starting, completing and voiding a
-- claim are RULES, and a rule expressed as a table grant is a rule that can be
-- half-applied — the same reasoning 0004 gives for keeping create_carrier() the
-- only way to write a membership.
grant select (
  id, dot_number, user_id, channel, destination_mask,
  expires_at, attempts, verified_at, voided_at, note, created_at
) on carrier_claims to authenticated;

create policy carrier_claims_select_self on carrier_claims
  for select to authenticated
  using (user_id = auth.uid());

-- ----------------------------------------------------- closing the old door

-- THE MOST IMPORTANT LINE IN THIS MIGRATION.
--
-- Everything above is decoration while `create_carrier` is still callable
-- directly. PostgREST publishes every function in this schema, the publishable
-- key is in the browser bundle, and any signed-in user can POST to
-- /rest/v1/rpc/create_carrier with any DOT number they like — no page, no form,
-- no verification. The function stays (complete_carrier_claim calls it, running
-- as the owner, so the rule about who may write a membership still lives in one
-- place) but the door from the outside is closed.
--
-- WHEN THIS IS APPLIED, the test fixtures that call create_carrier() while
-- acting as `authenticated` will start failing with "permission denied for
-- function create_carrier". tests/helpers.ts has makeCarrier() for exactly this:
-- it builds the same two rows on the owner connection.
revoke execute on function create_carrier(text, text, text, text) from authenticated;

-- ------------------------------------------------------------- starting one

/**
 * Begin a claim: record the hash, hand back the deadline. The caller sends the
 * message.
 *
 * SECURITY DEFINER because the rate limits count rows this user is not allowed
 * to see. The per-DOT limit is a count over EVERYBODY's claims against that
 * number, which is the whole point of it — a limit that only counted your own
 * rows would be reset by making a second account.
 *
 * IT NEVER LOOKS AT `carriers`. That is not an oversight, it is the anti-
 * enumeration rule: if starting a claim behaved differently for a DOT number
 * that is already set up here, this flow would be a free API for discovering
 * which carriers are customers — and for a squatter, which numbers are still
 * worth taking. The difference is only ever visible AFTER a correct code.
 */
create or replace function start_carrier_claim(
  p_dot_number       text,
  p_channel          claim_channel,
  p_code_hash        text default null,
  p_destination_mask text default null,
  p_note             text default null
)
returns table (status text, claim_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_dot     text := nullif(trim(p_dot_number), '');
  v_now     timestamptz := now();
  v_count   int;
  v_last    timestamptz;
  v_id      uuid;
  v_expires timestamptz;

  -- These numbers are CLAIM_POLICY in src/lib/claims.ts, written out again
  -- because SQL cannot import TypeScript. This copy is the one that is enforced;
  -- the other exists so the page can say what the limits are. Change one, change
  -- the other.
  c_ttl_minutes     constant int := 15;
  c_cooldown_secs   constant int := 60;
  c_dot_hour        constant int := 3;
  c_dot_day         constant int := 10;
  c_user_hour       constant int := 5;
  c_user_day        constant int := 20;
  c_manual_day      constant int := 5;
  c_manual_days     constant int := 30;
begin
  if v_user_id is null then
    raise exception 'not signed in';
  end if;
  if v_dot is null or v_dot !~ '^[1-9][0-9]{0,7}$' then
    raise exception 'not a USDOT number';
  end if;

  -- The constraint would catch these; raising here makes the failure a sentence
  -- rather than a constraint name in a log.
  if p_channel = 'manual' and p_code_hash is not null then
    raise exception 'a manual review request carries no code';
  end if;
  if p_channel <> 'manual' and p_code_hash is null then
    raise exception 'a code claim needs a code hash';
  end if;

  -- ---------------------------------------------------------- manual path
  if p_channel = 'manual' then
    -- Already asked? Hand back the existing request rather than queueing a
    -- second one. Clicking twice is not two problems.
    select c.id, c.expires_at into v_id, v_expires
      from carrier_claims c
     where c.dot_number = v_dot
       and c.user_id = v_user_id
       and c.channel = 'manual'
       and c.verified_at is null
       and c.voided_at is null
     limit 1;

    if v_id is not null then
      return query select 'started'::text, v_id, v_expires;
      return;
    end if;

    select count(*) into v_count
      from carrier_claims c
     where c.user_id = v_user_id
       and c.channel = 'manual'
       and c.created_at > v_now - interval '1 day';

    if v_count >= c_manual_day then
      return query select 'manual_day'::text, null::uuid, null::timestamptz;
      return;
    end if;

    insert into carrier_claims (dot_number, user_id, channel, expires_at, note)
    values (v_dot, v_user_id, 'manual', v_now + make_interval(days => c_manual_days), p_note)
    returning carrier_claims.id, carrier_claims.expires_at into v_id, v_expires;

    return query select 'started'::text, v_id, v_expires;
    return;
  end if;

  -- ------------------------------------------------------------ the limits
  --
  -- Counted over every claim on the channel, INCLUDING voided ones. A void means
  -- "the send did not land", not "that one was free" — see void_carrier_claim().
  --
  -- The per-DOT limits come first because they protect a person who never asked
  -- to be involved: whoever owns that phone receives at most three messages an
  -- hour and ten a day, from every account put together.

  select max(c.created_at) into v_last
    from carrier_claims c
   where c.user_id = v_user_id and c.channel <> 'manual';

  if v_last is not null and v_last > v_now - make_interval(secs => c_cooldown_secs) then
    return query select 'cooldown'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select count(*) into v_count
    from carrier_claims c
   where c.dot_number = v_dot
     and c.channel <> 'manual'
     and c.created_at > v_now - interval '1 hour';
  if v_count >= c_dot_hour then
    return query select 'dot_hour'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select count(*) into v_count
    from carrier_claims c
   where c.dot_number = v_dot
     and c.channel <> 'manual'
     and c.created_at > v_now - interval '1 day';
  if v_count >= c_dot_day then
    return query select 'dot_day'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select count(*) into v_count
    from carrier_claims c
   where c.user_id = v_user_id
     and c.channel <> 'manual'
     and c.created_at > v_now - interval '1 hour';
  if v_count >= c_user_hour then
    return query select 'user_hour'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select count(*) into v_count
    from carrier_claims c
   where c.user_id = v_user_id
     and c.channel <> 'manual'
     and c.created_at > v_now - interval '1 day';
  if v_count >= c_user_day then
    return query select 'user_day'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- Any earlier live claim of this user's on this number is finished. Two live
  -- codes for one number means "the code we sent you" is ambiguous, and the
  -- older text message is the one still sitting on the owner's phone.
  update carrier_claims c
     set voided_at = v_now
   where c.dot_number = v_dot
     and c.user_id = v_user_id
     and c.channel <> 'manual'
     and c.verified_at is null
     and c.voided_at is null;

  insert into carrier_claims (
    dot_number, user_id, channel, destination_mask, code_hash, expires_at
  )
  values (
    v_dot, v_user_id, p_channel, p_destination_mask, p_code_hash,
    v_now + make_interval(mins => c_ttl_minutes)
  )
  returning carrier_claims.id, carrier_claims.expires_at into v_id, v_expires;

  return query select 'started'::text, v_id, v_expires;
end;
$$;

revoke all on function start_carrier_claim(text, claim_channel, text, text, text)
  from public, anon;
grant execute on function start_carrier_claim(text, claim_channel, text, text, text)
  to authenticated;

-- ----------------------------------------------------------- completing one

/**
 * Spend a guess. On a correct one, create the carrier and the membership in the
 * same transaction that marks the claim verified.
 *
 * IT RETURNS A STATUS AND NEVER RAISES for an outcome the user caused, and that
 * is not a style choice. `raise` aborts the transaction — which would roll back
 * the attempts increment, so every wrong guess would be free and the cap that
 * makes a six-digit code safe would never bite. A refusal that undoes its own
 * side effect is not a refusal.
 *
 * Statuses: created · already_claimed · wrong_code · expired · attempts_exhausted
 *           · no_claim
 */
create or replace function complete_carrier_claim(
  p_dot_number text,
  p_code_hash  text,
  p_legal_name text,
  p_dba_name   text default null,
  p_timezone   text default 'America/Los_Angeles'
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_dot     text := nullif(trim(p_dot_number), '');
  v_claim   carrier_claims%rowtype;
  c_max_attempts constant int := 5;   -- CLAIM_POLICY.maxAttempts
begin
  if v_user_id is null then
    raise exception 'not signed in';
  end if;
  if v_dot is null or p_code_hash is null then
    return 'no_claim';
  end if;

  -- Checked BEFORE the claim is touched. create_carrier() refuses a blank legal
  -- name by raising, and a raise from down there would abort this transaction —
  -- taking the attempts increment and the verified_at stamp with it, so a
  -- correct code would look like nothing happened at all.
  if coalesce(trim(p_legal_name), '') = '' then
    raise exception 'legal_name is required';
  end if;

  -- `for update` is load-bearing. Two requests arriving together would otherwise
  -- both read attempts = 4, both find room for one more guess, and the cap would
  -- quietly become "5 plus however many you can send in parallel". The row lock
  -- makes the guesses serial.
  --
  -- user_id = auth.uid() is the binding. Everything else about this call comes
  -- off a form.
  select * into v_claim
    from carrier_claims c
   where c.dot_number = v_dot
     and c.user_id = v_user_id
     and c.channel <> 'manual'
     and c.verified_at is null
     and c.voided_at is null
   order by c.created_at desc
   limit 1
   for update;

  if not found then
    return 'no_claim';
  end if;
  if v_claim.expires_at <= now() then
    return 'expired';
  end if;
  if v_claim.attempts >= c_max_attempts then
    return 'attempts_exhausted';
  end if;

  -- Spend the attempt BEFORE deciding, so that a connection dropped between the
  -- check and the answer costs the guesser a try rather than costing us one.
  update carrier_claims set attempts = attempts + 1 where id = v_claim.id;

  if v_claim.code_hash is distinct from p_code_hash then
    return 'wrong_code';
  end if;

  -- Verified either way: this person proved control of the contact the federal
  -- record holds, and that fact is what a transfer request is later argued from.
  update carrier_claims set verified_at = now() where id = v_claim.id;

  begin
    -- create_carrier() is still the only place a carrier and its first
    -- membership are written together. This call runs as the owner, so the
    -- REVOKE above does not stand in its way.
    perform create_carrier(v_dot, p_legal_name, p_dba_name, p_timezone);
    return 'created';
  exception
    when unique_violation then
      -- The number is already set up here — by a squatter, by a colleague who
      -- signed up first, or by this same person in another account. We do NOT
      -- hand over the existing carrier: its rows may belong to somebody else and
      -- joining this user to them would leak whatever they have uploaded. The
      -- verified claim above is the audit trail support needs to move it.
      --
      -- This is also the ONLY point in the whole flow where "already claimed"
      -- becomes visible, and it is behind a correct code — which is what stops
      -- it being an oracle for which carriers are customers.
      return 'already_claimed';
  end;
end;
$$;

revoke all on function complete_carrier_claim(text, text, text, text, text) from public, anon;
grant execute on function complete_carrier_claim(text, text, text, text, text) to authenticated;

-- -------------------------------------------------------------- killing one

/**
 * Kill this user's live code claim for a number.
 *
 * Called when the send did not go out — the provider refused, or none is
 * configured. Without it the page would sit on "enter the code we sent you"
 * when nothing was sent, which is the single most infuriating state this flow
 * could have: a landline that cannot receive SMS looks exactly like a code that
 * has not arrived yet.
 *
 * IT DOES NOT REFUND THE RATE LIMIT, and that is the whole design of it. A void
 * that gave the send budget back would be an unlimited-SMS machine: start a
 * claim, void it, repeat, and a stranger's phone rings all night on our Twilio
 * bill. The counters in start_carrier_claim() count voided rows on purpose.
 */
create or replace function void_carrier_claim(p_dot_number text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update carrier_claims
     set voided_at = now()
   where dot_number = nullif(trim(p_dot_number), '')
     and user_id = auth.uid()
     and channel <> 'manual'
     and verified_at is null
     and voided_at is null
$$;

revoke all on function void_carrier_claim(text) from public, anon;
grant execute on function void_carrier_claim(text) to authenticated;
