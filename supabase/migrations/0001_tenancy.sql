-- Tenancy: carriers, the people who can see them, and the function every other
-- policy is built on.
--
-- The security model is the DATABASE, not the application. There is no
-- service-role client anywhere in this app: every request runs as the signed-in
-- user, so a mistake in application code cannot read another carrier's data.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- carriers

create table carriers (
  id            uuid primary key default gen_random_uuid(),
  dot_number    text unique,
  legal_name    text not null,
  dba_name      text,
  phy_street    text,
  phy_city      text,
  phy_state     text,
  phy_zip       text,
  phone         text,
  -- Deadlines are dates, not instants, but "is this overdue" is asked from
  -- somewhere. Storing the carrier's zone makes that answer stable.
  timezone      text not null default 'America/Los_Angeles',
  created_at    timestamptz not null default now()
);

comment on column carriers.dot_number is
  'Text, not integer: it is an identifier, never arithmetic, and leading zeros must survive.';

-- ---------------------------------------------------------------- profiles

-- One row per auth user. Mirrors auth.users because policies and joins in the
-- public schema cannot reliably reach into auth.
create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  email       text,
  phone       text,
  -- Per-user, with a timezone, so a 7am digest is 7am where they are.
  timezone    text not null default 'America/Los_Angeles',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- memberships

create type membership_role as enum ('owner', 'staff');

create table memberships (
  user_id     uuid not null references profiles (id) on delete cascade,
  carrier_id  uuid not null references carriers (id) on delete cascade,
  role        membership_role not null default 'staff',
  created_at  timestamptz not null default now(),
  primary key (user_id, carrier_id)
);

create index memberships_carrier_idx on memberships (carrier_id);

-- ------------------------------------------------- the tenant function

-- SECURITY DEFINER for one specific reason: a policy ON memberships that had to
-- query memberships to decide access would recurse. This function runs as its
-- owner, bypassing RLS on the single table it reads, and every other policy in
-- the schema calls it.
--
-- search_path is pinned. Without it, a caller could put a malicious `memberships`
-- earlier on their own search_path and this function would read it as the owner.
create or replace function current_user_carriers()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select carrier_id from memberships where user_id = auth.uid()
$$;

revoke all on function current_user_carriers() from public, anon;
grant execute on function current_user_carriers() to authenticated;

-- ---------------------------------------------------------------- RLS

-- ENABLE turns policies on. FORCE additionally applies them to the table OWNER.
--
-- These three tables get ENABLE but deliberately NOT FORCE, and the reason is
-- exact: a SECURITY DEFINER function runs as the function's owner, which here is
-- also the tables' owner. Under FORCE that owner is subject to the policies, and
-- since every policy below is granted `TO authenticated`, a definer function
-- running as the owner matches NO policy at all — and no applicable policy means
-- deny, not allow.
--
-- Concretely, FORCE here would break three things that must work:
--   current_user_carriers()  reads memberships  -> would return nothing, so every
--                            other table in the schema would deny everything
--   create_carrier()         writes both tables -> signup would fail
--   handle_new_user()        writes profiles    -> every new account would have
--                            no profile row
--
-- The data tables that actually hold carrier records — drivers, vehicles,
-- terminals, documents — DO get FORCE, in 0002 and 0003. Nothing runs as the
-- owner against those.
alter table carriers    enable row level security;
alter table profiles    enable row level security;
alter table memberships enable row level security;

-- Revoke first. RLS restricts rows; it does not grant table access, and a table
-- left with the default PUBLIC grant is reachable before a policy is consulted.
revoke all on carriers, profiles, memberships from public, anon, authenticated;

grant select, update on carriers to authenticated;
grant select, update on profiles to authenticated;
grant select on memberships to authenticated;
-- Deliberately no INSERT or DELETE for authenticated on memberships: adding a
-- person to a carrier is not something a user may do by writing a row. It goes
-- through a definer function in a later migration, so the rule about who may
-- invite whom lives in one place.

create policy carriers_select on carriers
  for select to authenticated
  using (id in (select current_user_carriers()));

create policy carriers_update on carriers
  for update to authenticated
  using (id in (select current_user_carriers()))
  with check (id in (select current_user_carriers()));

create policy profiles_select_self on profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_update_self on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy memberships_select_self on memberships
  for select to authenticated
  using (user_id = auth.uid());

-- ------------------------------------------------- new user -> profile

-- A profile row must exist for every auth user, and the app is never the thing
-- that guarantees it: a signup that succeeded in auth but failed to write a
-- profile would leave an account that can log in and see nothing.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
