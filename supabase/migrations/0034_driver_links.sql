-- A one-time link a driver opens on his phone, with no account and no password.
--
-- WHAT THIS IS FOR. docs/REQUIREMENTS.md:44 has said from the start that a
-- driver "never logs in" and "at most opens a link texted to them". Until now
-- that was aspirational: every date a driver owns — a new medical card, a
-- renewed licence — reached this system by the owner typing it off a photo on
-- his phone, which is the job he is paying us to stop doing.
--
-- THIS IS THE FIRST CREDENTIAL IN THE PRODUCT THAT LEADS TO A WRITE. Every
-- other anonymous door — the six share functions from 0013/0026 — is read-only.
-- So the whole table is built around three properties, and none of them is
-- optional:
--
--   1. IT NAMES ONE DRIVER. A link cannot be talked into touching another one.
--      `driver_id` is a real foreign key, unlike `share_links.subject_id`, which
--      is a bare uuid with nothing stopping it pointing at another carrier's
--      row. That hole is survivable there because every read function joins on
--      the carrier; it is not a hole worth repeating on a write.
--
--   2. IT IS SINGLE USE. `used_at` is stamped the moment a submission lands, and
--      every lookup requires it to be null. A link that has done its job is dead
--      even if the message it arrived in is forwarded to somebody else.
--
--   3. WHAT ARRIVES IS A CLAIM, NOT A FACT. Nothing here writes to `drivers` or
--      to `compliance_records`. The submission lands in `driver_submissions`
--      (0035) and waits for the owner. The carrier is the one who gets stopped
--      at a roadside inspection, not the person who typed the date, so a number
--      that arrived through a link must never make the dashboard say "current"
--      on its own.
--
-- THE TOKEN IS NEVER WRITTEN DOWN. Same rule and same digest as 0026: the raw
-- token exists in the link the owner sends and nowhere else. 0013 stored a proof
-- token in plain text beside its own hash, which made every row a working
-- login-free door for anyone who could read the table.

create table driver_links (
  id           uuid primary key default gen_random_uuid(),
  carrier_id   uuid not null references carriers (id) on delete cascade,
  -- NOT NULL and a real FK. See property 1 above.
  driver_id    uuid not null references drivers (id) on delete cascade,

  -- sha256(token), lowercase hex. Same shape check as share_links so the two
  -- cannot drift into different digests.
  token_hash   text not null,

  -- WHAT THIS LINK MAY ASK FOR, and therefore the entire scope of what an
  -- anonymous submit can carry. An array rather than columns because the set
  -- grows, and CONSTRAINED here rather than only in TypeScript because this
  -- column is the security boundary of an unauthenticated write. The
  -- predecessor left the equivalent column unvalidated in the database and
  -- relied on the route to only read keys it recognised; that works right up
  -- until a second writer appears.
  asks         text[] not null,

  expires_at   timestamptz not null,
  -- Stamped on a successful submit. Property 2.
  used_at      timestamptz,
  revoked_at   timestamptz,
  -- First open. Answers "did he ever get it" when a card lapses and the driver
  -- says nobody asked him.
  opened_at    timestamptz,

  -- Where it went, for the owner's own record. The address or number, not the
  -- link.
  sent_to      text,
  channel      text,

  created_by   uuid references profiles (id),
  created_at   timestamptz not null default now(),

  constraint driver_links_token_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),

  -- The ask list is closed, non-empty, and every entry is one we know.
  -- `<@` is array containment: every element of `asks` must appear on the right.
  constraint driver_links_asks_known check (
    array_length(asks, 1) between 1 and 6
    and asks <@ array['medical', 'cdl', 'spe', 'intracity', 'diabetes', 'vision']::text[]
  ),

  -- THE EXPIRY CEILING IS IN THE DATABASE, and it is on THIS row.
  --
  -- The predecessor put a 1-to-720-hour check on the carrier's DEFAULT column
  -- and left `expires_at` itself a bare timestamptz — so its own migration
  -- comment claiming "the constraint is in the DATABASE, not only in the form"
  -- was untrue of the only thing that mattered. A backfill script or a psql
  -- session could mint a ten-year bearer token for an unauthenticated write and
  -- nothing objected.
  constraint driver_links_expiry_sane check (
    expires_at > created_at and expires_at <= created_at + interval '30 days'
  ),

  constraint driver_links_channel_known check (channel is null or channel in ('email', 'sms', 'copied'))
);

create unique index driver_links_token_hash_key on driver_links (token_hash);
-- The lookup the anonymous route makes, and the only one it makes. Partial,
-- because a spent or withdrawn link is never resolved again.
create index driver_links_live_idx on driver_links (token_hash)
  where revoked_at is null and used_at is null;
create index driver_links_driver_idx on driver_links (carrier_id, driver_id, created_at desc);

comment on table driver_links is
  'Single-use expiring links letting a driver send in dates and photographs with no account. What arrives is a claim: it lands in driver_submissions and waits for the owner. Token stored only as a sha256 digest. See 0034.';
comment on column driver_links.asks is
  'Which fields this link may carry. Closed set, constrained here because it is the scope of an unauthenticated write. The catalogue in src/lib/driver-link/asks.ts is the same list and the two must change together.';
comment on column driver_links.used_at is
  'Stamped on a successful submit. Every lookup requires it to be null, so a forwarded link is dead the moment the driver has used it.';

-- ------------------------------------------------------------------- tenancy

alter table driver_links enable row level security;
alter table driver_links force row level security;

revoke all on driver_links from public, anon, authenticated;
-- No DELETE, deliberately, and for the same reason share_links has none: a link
-- that was issued and used is part of how a date got onto a compliance record.
-- `revoked_at` retires one without erasing that it existed.
grant select, insert, update on driver_links to authenticated;

create policy driver_links_rw on driver_links
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

-- NO POLICY FOR anon. The anonymous route never touches this table directly —
-- it goes through the SECURITY DEFINER functions in 0036, which are the only
-- door, exactly as tests/share-scope.test.ts asserts for the proof links.

-- A link must point at a driver inside its own carrier.
--
-- SECURITY INVOKER, not DEFINER, and that is the whole point — the same
-- reasoning documents_subject_belongs_to_carrier() spells out in 0003. Running
-- as the calling user means the SELECT below is itself subject to RLS, so a
-- driver_id belonging to another carrier is simply invisible and the check
-- fails. A DEFINER version would run as the table owner and answer a question
-- nobody asked.
create or replace function driver_links_driver_belongs_to_carrier()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from drivers where id = new.driver_id and carrier_id = new.carrier_id
  ) then
    raise exception 'driver % does not belong to carrier %', new.driver_id, new.carrier_id;
  end if;
  return new;
end;
$$;

create trigger driver_links_driver_check
  before insert or update of driver_id, carrier_id on driver_links
  for each row execute function driver_links_driver_belongs_to_carrier();
