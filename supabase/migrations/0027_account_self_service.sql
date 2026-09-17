-- The two database facts an owner managing his own account needs, and neither
-- of which the schema could answer before today.
--
-- Nothing here is a new column. `profiles` has held full_name, email, phone and
-- timezone since 0001 — the gap was always UI. What genuinely could not be done
-- from application code is below.

-- ------------------------------------------- 1. profiles.email is a MIRROR

-- THE TRAP THIS CLOSES. There are two email addresses for one person:
-- `auth.users.email`, which is what they actually sign in with, and
-- `profiles.email`, which is the copy the public schema can join against and —
-- this is the part with teeth — the address the morning digest sends to
-- (src/pages/api/cron/digest.ts reads `profiles(email)`).
--
-- Supabase changes the first one and knows nothing about the second. So an
-- owner who changes his sign-in address gets a settings page showing the new
-- one, signs in with the new one, and has every compliance alert delivered to
-- the old one, silently, forever. That is this product's single worst failure:
-- a deadline we correctly detected and sent somewhere he stopped reading.
--
-- Doing it here rather than in the app is not tidiness. The confirmation link
-- can be opened on a phone, in another browser, or weeks later — the write that
-- flips `auth.users.email` may never pass through a request this application
-- serves. A trigger is the only place that sees all of them.
--
-- `handle_new_user` already establishes the precedent: the profile row is the
-- database's job, never the app's.
create or replace function handle_user_email_change()
returns trigger
language plpgsql
security definer
-- Pinned, for the same reason as every other definer function in this schema:
-- without it a caller could put their own `profiles` earlier on the search_path
-- and this function would write to it as the owner.
set search_path = public, pg_temp
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

-- `of email` and the WHEN clause both matter: auth.users is updated on every
-- token refresh, and a trigger firing on all of those would rewrite one row of
-- `profiles` per signed-in request for no reason at all.
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (new.email is distinct from old.email)
  execute function handle_user_email_change();

-- Existing rows, once. Any account that changed its address before this
-- migration is sitting on exactly the stale value described above, and a trigger
-- only fixes the next change.
update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and p.email is distinct from u.email;

-- ------------------------------------------- 2. who else is on this carrier

-- `memberships_select_self` (0001) scopes memberships to `user_id = auth.uid()`
-- and `profiles_select_self` does the same for profiles, so a signed-in person
-- can see exactly one membership and one profile: their own. Correct as a
-- default, and it makes "who else can sign in to my account?" unanswerable —
-- which is why the settings page has never shown it.
--
-- Widening either policy is the wrong fix. `profiles_select_self` protects a
-- table that will hold more than a name, and a policy relaxed to "anyone sharing
-- a carrier" is relaxed for every future column too. A function discloses four
-- named fields and nothing else, and the disclosure is visible in one place.
--
-- The guard is the first statement, not a WHERE clause bolted onto the select:
-- this runs as the owner with RLS bypassed, so the membership check IS the
-- security boundary and it should be impossible to read the body and miss it.
create or replace function carrier_members(p_carrier_id uuid)
returns table (
  user_id    uuid,
  full_name  text,
  email      text,
  role       membership_role,
  joined_at  timestamptz
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if p_carrier_id is null or p_carrier_id not in (select current_user_carriers()) then
    -- 42501 is insufficient_privilege. Raising rather than returning zero rows
    -- keeps "you are not a member" distinct from "this carrier has no members",
    -- which is a state that cannot happen and would otherwise render as an
    -- empty list on somebody else's account.
    raise exception 'not a member of that carrier' using errcode = '42501';
  end if;

  return query
    select m.user_id, p.full_name, p.email, m.role, m.created_at
      from memberships m
      join profiles p on p.id = m.user_id
     where m.carrier_id = p_carrier_id
     -- Oldest first: the first membership on a carrier is the person who
     -- claimed it, and a list that opens with anyone else reads wrong.
     order by m.created_at, p.email;
end;
$$;

revoke all on function carrier_members(uuid) from public, anon;
grant execute on function carrier_members(uuid) to authenticated;

comment on function carrier_members(uuid) is
  'Members of one carrier the caller belongs to. SECURITY DEFINER: the membership check at the top of the body is the only thing standing between a caller and another carrier''s email addresses.';
