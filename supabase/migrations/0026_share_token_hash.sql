-- The proof-link token, stored as a hash of itself.
--
-- WHAT WAS WRONG WITH 0013. `share_links.token` held the credential in plain
-- text. The table's own comment said the token IS the credential and that "its
-- only defence is being unguessable" — true against a stranger guessing, and
-- worth nothing against anyone who can READ the table: a leaked backup, a
-- leaked service-role key (which bypasses RLS entirely), one SQL injection, a
-- stray SELECT pasted into a support thread. Every row was a working,
-- login-free link into a carrier's compliance file, good until it expired.
--
-- After this, the row holds sha256(token) and the token itself exists in two
-- places only: the URL the owner copied, and the request that arrives when
-- somebody opens it.
--
-- WHY A PLAIN SHA-256 AND NOT THE PEPPERED DIGEST src/lib/claims.ts USES.
-- Two reasons, and both are about WHERE the hashing happens.
--
--   1. THE KEYSPACE. The pepper in claims.ts exists because a six-digit code
--      has a million possible values: an attacker holding that table computes
--      all one million digests in under a second, so the stored hash has to
--      depend on a secret that is not in the database. A proof token is 32
--      CSPRNG bytes — 256 bits, see src/lib/proof/token.ts. There is no
--      dictionary of 2^256 values, no rainbow table of random base64url
--      strings, and no hardware that walks that space. The pepper would buy
--      nothing here that the entropy has not already bought.
--
--   2. WHERE THE DIGEST IS COMPUTED IS THE WHOLE PROPERTY. The reader is
--      anonymous, so the lookup functions are reachable by `anon` through
--      PostgREST with the publishable key that ships inside the browser bundle.
--      If the application hashed the token and passed the DIGEST to
--      resolve_share_token, then the value stored in this table would itself be
--      a working credential and a leak of the table would be exactly as bad as
--      it is now. So the raw token goes to the database and the HASHING HAPPENS
--      INSIDE THE FUNCTION, on the far side of the trust boundary. That is what
--      rules out an application pepper — SQL cannot have one — and it is also
--      what lets this migration compute every existing hash in place, so that
--      no link a carrier has already handed to a broker stops working.
--
-- WHAT THIS DOES NOT PROTECT AGAINST, plainly:
--   - Anybody holding the link. That is what a link is for.
--   - The token in transit. It is a URL path segment, so it reaches our access
--     logs, the recipient's browser history, and any proxy in between. Hashing
--     a column does not touch any of that.
--   - A leaked service-role key. It can no longer read a working link OUT of
--     this table, but it can still INSERT one for any carrier. Bypassing RLS is
--     bypassing RLS; this narrows the damage, it does not end it.
--   - Confirming a guess. Anyone with the table can test a candidate token
--     offline. Against 256 bits there are no candidates.
--
-- ONE MORE CONSEQUENCE, AND IT IS USER-FACING: the server can no longer recover
-- a token from the database, so /app/proof can only show a link once, at the
-- moment it is created. That page now says so in plain words. A list of links
-- whose addresses could be re-read on demand would be this vulnerability again
-- with a login in front of it.

-- --------------------------------------------------------------- the digest

/**
 * sha256(token), lowercase hex.
 *
 * One definition, used by the backfill and by all six lookups below, because
 * two spellings of "the hash" is one spelling too many. The matching TypeScript
 * is hashProofToken() in src/lib/proof/token.ts, which the creating page uses to
 * write the column; tests/share-scope.test.ts asserts the two agree byte for
 * byte, since a drift between them is every link breaking at once.
 *
 * pg_catalog.sha256(bytea) is CORE POSTGRES (11+), deliberately not pgcrypto's
 * digest(): on Supabase pgcrypto is installed into the `extensions` schema, and
 * every function below pins `search_path = public, pg_temp`, so digest() would
 * not resolve inside them. sha256() and convert_to() are pg_catalog, which is
 * always on the path.
 *
 * NOT granted to anon or authenticated. Nothing secret happens in here — SHA-256
 * is public arithmetic — but PostgREST publishes every function in this schema,
 * and an RPC with no caller is surface for no reason.
 */
create or replace function share_token_hash(p_token text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

revoke all on function share_token_hash(text) from public, anon, authenticated;

-- ------------------------------------------------------------- the column

alter table share_links add column token_hash text;

-- THE LINE THAT KEEPS LIVE LINKS ALIVE. The plaintext is still here at this
-- point in the transaction, so every existing token is hashed in place. A
-- carrier who gave a broker a link last week does not have to send a new one —
-- and this is only possible because the digest needs no secret from outside the
-- database. It is also why this must be one migration and not two: a two-phase
-- plan leaves the plaintext column sitting there between the phases.
update share_links set token_hash = share_token_hash(token);

alter table share_links alter column token_hash set not null;

-- Hex SHA-256 or nothing, the same guard 0021 puts on carrier_claims.code_hash.
-- A 43-character base64url token cannot satisfy this, so a mistake in
-- application code cannot put a plaintext token back into this table.
alter table share_links
  add constraint share_links_token_hash_shape check (token_hash ~ '^[0-9a-f]{64}$');

comment on column share_links.token_hash is
  'sha256(token) in hex. The token itself is never stored: it is shown to the '
  'owner once, at creation, and after that exists only in the link he copied.';

-- Both indexes 0013 had, moved onto the hash. The unique one still means "no
-- two links share a token"; the partial one is the one the lookups ride.
create unique index share_links_token_hash_key on share_links (token_hash);
create index share_links_token_hash_idx on share_links (token_hash) where revoked_at is null;

drop index share_links_token_idx;

-- ------------------------------------------------------------- the lookups
--
-- Six functions took the raw token and compared it to a column. They still take
-- the raw token and nothing else — no carrier_id, no driver_id, nothing a
-- caller could tamper with, which is the property 0013 and 0014 were built
-- around — and they now hash it and compare digests. The comparison is an
-- indexed equality on a 64-character hex string, so there is no byte-by-byte
-- compare in application code to reason about.
--
-- Their bodies are string literals, so Postgres records no dependency on the
-- dropped column: they must be replaced HERE, in the same transaction, or they
-- would fail at runtime the moment `token` goes.

/**
 * Resolve a token for an anonymous reader. See 0013 for the full reasoning.
 * Unchanged except for the WHERE clause: still SECURITY DEFINER, still returns
 * ids and scope only, still refuses revoked and expired links.
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
   where s.token_hash = share_token_hash(p_token)
     and s.revoked_at is null
     and s.expires_at > now()
   limit 1
$$;

/** Records a view. Separate from resolution so a failed read cannot inflate it. */
create or replace function record_share_view(p_token text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update share_links
     set view_count = view_count + 1,
         last_viewed_at = now()
   where token_hash = share_token_hash(p_token)
     and revoked_at is null
     and expires_at > now()
$$;

/** Carrier identity. Safe for both scopes — it is on the public federal record. */
create or replace function share_carrier(p_token text)
returns table (legal_name text, dba_name text, dot_number text, phy_city text, phy_state text)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select c.legal_name, c.dba_name, c.dot_number, c.phy_city, c.phy_state
    from share_links s
    join carriers c on c.id = s.carrier_id
   where s.token_hash = share_token_hash(p_token)
     and s.revoked_at is null
     and s.expires_at > now()
$$;

/** The driver named by a driver_file token. `s.scope` is still the load-bearing line. */
create or replace function share_driver(p_token text)
returns table (id uuid, first_name text, last_name text, cdl_number text, cdl_state text,
               cdl_expires_on date, hired_on date)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select d.id, d.first_name, d.last_name, d.cdl_number, d.cdl_state,
         d.cdl_expires_on, d.hired_on
    from share_links s
    join drivers d on d.id = s.subject_id and d.carrier_id = s.carrier_id
   where s.token_hash = share_token_hash(p_token)
     and s.scope = 'driver_file'
     and s.revoked_at is null
     and s.expires_at > now()
$$;

/** Compliance anchors, scoped in the WHERE clause exactly as 0014 wrote them. */
create or replace function share_anchors(p_token text)
returns table (subject_type document_subject, subject_id uuid, anchor_key text, occurred_on date)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select a.subject_type, a.subject_id, a.anchor_key, a.occurred_on
    from share_links s
    join current_compliance_anchors a on a.carrier_id = s.carrier_id
   where s.token_hash = share_token_hash(p_token)
     and s.revoked_at is null
     and s.expires_at > now()
     and (
       (s.scope = 'driver_file'
          and a.subject_type = 'driver'
          and a.subject_id = s.subject_id)
       or
       (s.scope = 'carrier_summary'
          and a.subject_type = 'carrier')
     )
$$;

/** Fleet size for a carrier_summary. Counts only — never names. */
create or replace function share_fleet_counts(p_token text)
returns table (active_drivers int, power_units int, trailers int)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    (select count(*)::int from drivers d
      where d.carrier_id = s.carrier_id and d.status = 'active'),
    (select count(*)::int from vehicles v
      where v.carrier_id = s.carrier_id and v.kind = 'power_unit' and v.status <> 'sold'),
    (select count(*)::int from vehicles v
      where v.carrier_id = s.carrier_id and v.kind = 'trailer' and v.status <> 'sold')
  from share_links s
  where s.token_hash = share_token_hash(p_token)
    and s.scope = 'carrier_summary'
    and s.revoked_at is null
    and s.expires_at > now()
$$;

-- ------------------------------------------------------------ the plaintext
--
-- LAST, so that everything above has already been rewritten to read the hash.
-- The UNIQUE constraint on the column goes with it. A column that is merely
-- unused is still a column in every backup taken from here on, so this is the
-- line that actually fixes the thing this migration is about.
alter table share_links drop column token;

-- Grants restated rather than assumed. CREATE OR REPLACE keeps the existing ACL
-- — none of these functions changed name or signature — but "the grants did not
-- change" is a claim worth writing down next to a security fix.
revoke all on function resolve_share_token(text) from public;
revoke all on function record_share_view(text)   from public;
revoke all on function share_carrier(text)       from public;
revoke all on function share_driver(text)        from public;
revoke all on function share_anchors(text)       from public;
revoke all on function share_fleet_counts(text)  from public;

grant execute on function resolve_share_token(text) to anon, authenticated;
grant execute on function record_share_view(text)   to anon, authenticated;
grant execute on function share_carrier(text)       to anon, authenticated;
grant execute on function share_driver(text)        to anon, authenticated;
grant execute on function share_anchors(text)       to anon, authenticated;
grant execute on function share_fleet_counts(text)  to anon, authenticated;
