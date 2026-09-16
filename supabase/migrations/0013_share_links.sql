-- Shareable proof.
--
-- A broker or an underwriter asks what you have. The answer is a link, and the
-- link has to work for somebody with no account — which means the token IS the
-- credential and everything about this table exists to limit what that buys.
--
-- What it deliberately does NOT buy: a verdict. A packet a carrier generates
-- about himself is structurally untrusted — anyone can produce a convincing
-- certificate of insurance in five minutes — so the page states dated
-- observations, links outward to the federal record so the reader can check us,
-- and never prints "compliant".

create type share_scope as enum (
  'carrier_summary',  -- fleet-level: authority, insurance on file, deadline counts
  'driver_file'       -- one driver's qualification file, in 391.51 order
);

create table share_links (
  id           uuid primary key default gen_random_uuid(),
  carrier_id   uuid not null references carriers (id) on delete cascade,

  -- The credential. Long and random: there is no second factor behind it, so
  -- its only defence is being unguessable. Generated in the app, never derived
  -- from anything about the carrier.
  token        text not null unique,

  scope        share_scope not null,
  -- Which driver, when scope is driver_file.
  subject_id   uuid,

  label        text,
  -- Who it was made for, so the owner can tell two links apart a month later.
  recipient    text,

  -- Everything expires. A proof link is a statement about a moment, and a
  -- statement about a moment should not still be answering questions next year.
  expires_at   timestamptz not null,
  revoked_at   timestamptz,

  created_by   uuid references profiles (id),
  created_at   timestamptz not null default now(),

  -- Cheap accountability: the owner can see whether the broker actually opened
  -- it, which is the question he will ask.
  view_count   int not null default 0,
  last_viewed_at timestamptz
);

create index share_links_token_idx on share_links (token) where revoked_at is null;
create index share_links_carrier_idx on share_links (carrier_id, created_at desc);

alter table share_links enable row level security;
alter table share_links force  row level security;

revoke all on share_links from public, anon, authenticated;
grant select, insert, update on share_links to authenticated;
-- No DELETE: a revoked link must stay visible, because "did we ever send this
-- to that broker" is the question, and a deleted row cannot answer it.

create policy share_links_rw on share_links
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

-- ---------------------------------------------------------------- resolution

/**
 * Resolve a token for an anonymous reader.
 *
 * SECURITY DEFINER because the caller has no session at all — the whole point
 * is that a broker can open it. It is the ONLY way an unauthenticated request
 * can reach carrier data, so it is deliberately narrow:
 *   - takes a token and nothing else, so there is no carrier_id to tamper with
 *   - returns ONLY the ids and the scope, never any carrier content
 *   - refuses revoked and expired links
 *
 * The caller then reads the actual content through views that take those ids.
 * Splitting it this way means a mistake in a content query cannot widen what
 * the token grants.
 */
create or replace function resolve_share_token(p_token text)
returns table (carrier_id uuid, scope share_scope, subject_id uuid, expires_at timestamptz)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select s.carrier_id, s.scope, s.subject_id, s.expires_at
    from share_links s
   where s.token = p_token
     and s.revoked_at is null
     and s.expires_at > now()
   limit 1
$$;

revoke all on function resolve_share_token(text) from public;
grant execute on function resolve_share_token(text) to anon, authenticated;

/** Records a view. Separate from resolution so a failed read cannot inflate the count. */
create or replace function record_share_view(p_token text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update share_links
     set view_count = view_count + 1,
         last_viewed_at = now()
   where token = p_token
     and revoked_at is null
     and expires_at > now()
$$;

revoke all on function record_share_view(text) from public;
grant execute on function record_share_view(text) to anon, authenticated;
