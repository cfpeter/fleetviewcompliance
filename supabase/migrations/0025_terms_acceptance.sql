-- Proof that a customer agreed to the Terms and the Privacy Policy.
--
-- WHAT WAS THERE BEFORE: nothing. /login never mentioned either document, no
-- column recorded an agreement, and no code wrote one. Every term on those two
-- pages — the liability cap, the fee section, the cancellation rule, the
-- disclaimer that this is not legal advice — was unenforceable, because the
-- first question in any dispute is "show me that he agreed" and there was no
-- answer. This table is that answer. It is a launch blocker for taking money.
--
-- THIS TABLE IS EVIDENCE, NOT APPLICATION STATE, and every decision below falls
-- out of that one sentence:
--
--   * It is append-only, and unusually strictly so. `compliance_records` is
--     append-only in the sense that an UPDATE may only set `superseded_at` —
--     the fact stays, a newer fact sits beside it. Here there is no such thing
--     as a correction. An acceptance either happened or it did not, so UPDATE is
--     refused outright and so is DELETE, by a trigger rather than by a grant.
--     Grants are about who; a trigger is about what, and it fires for the table
--     owner and for a SECURITY DEFINER function too. "The user cannot change it"
--     is the weak version of this rule; "nobody can" is the one worth having.
--
--   * The row is written by a SECURITY DEFINER function that takes NO user id
--     and NO timestamp. Both are read from the server. A parameter you do not
--     have is a parameter a caller cannot lie about.
--
--   * A value we do not have is stored as NULL. In local development there is
--     no Cloudflare in front of the Worker and therefore no client IP; the
--     honest record of that is an empty column. An invented one — 127.0.0.1,
--     '0.0.0.0', 'unknown' — is a fabricated exhibit, which is worse than a gap
--     in exactly the setting this table exists for.
--
-- SCOPED TO THE USER, NOT TO A CARRIER, and this is the one structural thing to
-- understand about the table. Acceptance happens on the signup screen, before
-- the USDOT claim, so at that instant there is no carrier and there is no
-- membership — `current_user_carriers()`, which every other policy in this
-- schema is built on, returns nothing at all. Writing this against a carrier id
-- would mean either inventing one or deferring the record until after
-- onboarding, and a record of agreement written twenty minutes after the
-- agreement is not a record of the agreement.
--
-- So the tenancy predicate here is `user_id = auth.uid()`, the same shape
-- `profiles_select_self` (0001) and `carrier_claims_select_self` (0021) use, and
-- for the same reason those two use it: both describe a PERSON at a moment when
-- no carrier exists yet. It is also the right scope on the merits — the
-- agreement binds the human being who ticked the box. Staff invited to a
-- carrier later accept for themselves; an owner who runs two carriers has
-- accepted once, as himself.

create table terms_acceptances (
  id          uuid primary key default gen_random_uuid(),

  -- The person. Never a cookie, never an email address typed into the form,
  -- never a value in the request body: all three are chosen by the person whose
  -- agreement we are trying to prove. The only acceptable source is a session
  -- the auth service issued, which is what auth.uid() is.
  user_id     uuid not null references profiles (id) on delete cascade,

  -- WHICH DOCUMENTS. '2026-09-16', derived in src/lib/terms.ts from
  -- EFFECTIVE_DATE in src/lib/legal.ts — the same constant the /terms and
  -- /privacy pages print at the top. That is deliberate and it is the whole
  -- versioning scheme: the documents carry one effective date, the date is the
  -- version, and the exact text bearing that date is in git.
  --
  -- Text with a loose shape check rather than a closed value list, for the
  -- reason 0024 gives about Stripe statuses: a check constraint listing the
  -- versions we have published today makes the FIRST revision fail to record,
  -- and a revision that silently records nothing is the failure this whole file
  -- exists to prevent.
  document_version text not null,

  -- THE MOMENT. Server clock, always, and there is no parameter anywhere in
  -- this file that can set it. See record_terms_acceptance() below.
  accepted_at timestamptz not null default now(),

  -- Where from. `inet` rather than text so a malformed value cannot be stored
  -- at all, and NULLABLE because it genuinely is unknown sometimes. The source
  -- is the CF-Connecting-IP header, which Cloudflare sets and a client cannot
  -- forge; X-Forwarded-For is deliberately not consulted, there or here.
  ip          inet,

  -- What they were using. Weak evidence on its own and good corroboration
  -- beside the rest — two acceptances from the same account minutes apart on
  -- different browsers is the sort of thing a dispute turns on.
  user_agent  text,

  -- WHAT THE CLICK SAID, as a hash. See the long note below the table.
  assent_digest text,

  -- Printable ASCII, non-blank, short. Enough to stop an empty string or a
  -- paragraph of prose; not so much that the next version format is a migration.
  constraint terms_acceptances_version_shape
    check (document_version ~ '^[ -~]{1,64}$' and btrim(document_version) <> ''),

  -- Hex SHA-256 or nothing, the same constraint shape 0021 puts on code_hash,
  -- and for the same reason: it makes the one rule that matters structurally
  -- impossible to break by accident in application code.
  constraint terms_acceptances_digest_shape
    check (assent_digest is null or assent_digest ~ '^[0-9a-f]{64}$'),

  constraint terms_acceptances_user_agent_length
    check (user_agent is null or length(user_agent) <= 1000)
);

-- ONE ROW PER PERSON PER VERSION, and this index is also the re-acceptance
-- mechanism. A new effective date is a new version string is a new row; the old
-- row stays exactly as it was, which is the point — it is the evidence for
-- everything that happened while that version was current. Nothing about a
-- future revision needs a schema change.
--
-- It also makes the recording call idempotent, so a page that calls it twice
-- keeps the FIRST acceptance rather than moving the timestamp forward.
create unique index terms_acceptances_one_per_version
  on terms_acceptances (user_id, document_version);

-- Reading the evidence for one person, newest first.
create index terms_acceptances_user_idx
  on terms_acceptances (user_id, accepted_at desc);

comment on table terms_acceptances is
  'Clickwrap evidence: who agreed to which version of the Terms and Privacy Policy, when, from where. Append-only, by trigger.';

comment on column terms_acceptances.assent_digest is
  'SHA-256 of the exact sentence beside the checkbox plus the version and both document URLs. See src/lib/terms.ts.';

-- ------------------------------------------------- what the hash is, and is not
--
-- THE DECISION: store a hash of the ASSENT — the sentence the customer actually
-- ticked, the two links beside it and the version — and do NOT store a hash or
-- a copy of the documents themselves.
--
-- Why not the documents. /terms and /privacy are Astro components. Hashing
-- their source would hash Tailwind class names and code comments, so a comment
-- fix would read as a new version of the contract while a real change to the
-- fee section buried in a shared constant might not. Hashing the RENDERED page
-- means an HTTP fetch from the Worker to its own site on every signup: a
-- network call on the one request that must not fail, which when it does fail
-- leaves the column null anyway. Neither produces better evidence than
-- "version 2026-09-16, and here is the repository at that date".
--
-- Why the assent, then. In a clickwrap dispute the document is rarely what is
-- argued about — the argument is about the interface. Was the agreement
-- conspicuous, was it linked, did the wording amount to assent at all. That is
-- exactly what this digest pins, it is computed from constants rather than
-- fetched, it never fails, and if somebody rewords the checkbox next year every
-- row from before that day still proves what the old wording said.
--
-- It is corroboration, not the contract. The contract is the text at that
-- version, in git. The upgrade, when there is a build step that renders both
-- documents to a stable archived artifact, is to hash THAT and add a column
-- beside this one — an append-only table takes a new nullable column fine,
-- because rows written before the archive existed would honestly have no
-- archive digest either way.

-- ---------------------------------------------------------------- append-only

-- UPDATE is refused unconditionally. DELETE is refused while the person still
-- has an account.
--
-- The delete exception is not a loophole, it is the only sane answer to a
-- deletion request. The foreign key above cascades, so closing an account takes
-- the acceptance with it; without the exception the cascade would raise and
-- account deletion would be impossible forever, which is a worse promise to
-- make than "we keep this while you are a customer". The check is `is the parent
-- gone`, so the ONLY thing that can remove a row is the profile itself being
-- deleted — which no signed-in user can do (0001 grants profiles no DELETE to
-- `authenticated`) and which is a deliberate act by an operator.
--
-- SECURITY DEFINER on a trigger function, which is unusual and is load-bearing
-- here: the existence check reads `profiles`, `profiles` has RLS on, and under
-- some other role a hidden parent row would look like a deleted one and the
-- delete would be allowed. Running as the owner makes the check answer the
-- question it is actually asking. search_path is pinned for the reason 0001
-- gives at current_user_carriers().
create or replace function terms_acceptances_are_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception
      'terms acceptances are evidence and cannot be changed: a wrong one is corrected by recording a new acceptance, not by editing this row';
  end if;

  if exists (select 1 from profiles where id = old.user_id) then
    raise exception
      'terms acceptances are evidence and cannot be deleted while the account exists';
  end if;

  return old;
end;
$$;

create trigger terms_acceptances_immutable
  before update or delete on terms_acceptances
  for each row execute function terms_acceptances_are_immutable();

-- ---------------------------------------------------------------- RLS

-- ENABLE and FORCE.
--
-- 0001 and 0021 both chose ENABLE without FORCE, and both give the same reason:
-- under FORCE the table owner is subject to the policies, and a SECURITY DEFINER
-- function running as that owner matches no policy granted `TO authenticated`,
-- so every write in the file would be denied. That reasoning does not apply on
-- this project, and it was checked rather than assumed: the owner role here is
-- `postgres`, which carries BYPASSRLS, and BYPASSRLS beats FORCE — a role with
-- it is never subject to row security at all. So the definer function below
-- writes normally and FORCE costs nothing.
--
-- What FORCE buys is the next mistake. There is no INSERT, UPDATE or DELETE
-- policy on this table for anybody. If some later migration grants
-- `authenticated` INSERT on it — the single change that would turn this from
-- evidence into a field a customer can fill in — the write is still refused,
-- because a granted command with no applicable policy is denied, not allowed.
alter table terms_acceptances enable row level security;
alter table terms_acceptances force  row level security;

-- Revoke first: RLS restricts rows, it does not grant table access, and a table
-- left with the default PUBLIC grant is reachable before a policy is consulted.
revoke all on terms_acceptances from public, anon, authenticated;

-- SELECT and nothing else, ever. A person may read what they agreed to and
-- when — that is reasonable, and a customer who cannot see his own agreement is
-- being asked to take our word for it. Writing one is not reasonable, and
-- neither is amending one, so those go through the function below or nowhere.
grant select on terms_acceptances to authenticated;

create policy terms_acceptances_select_self on terms_acceptances
  for select to authenticated
  using (user_id = auth.uid());

-- ------------------------------------------------------------- recording one

/**
 * Record that the signed-in user accepted a version of the documents.
 *
 * Returns the acceptance instant. Idempotent per (user, version): calling it
 * again returns the ORIGINAL timestamp and changes nothing, because the first
 * acceptance is the one that happened.
 *
 * TAKES NO USER ID AND NO TIMESTAMP, and that is the security design rather
 * than an omission. The caller cannot name somebody else, and the caller cannot
 * name a time — auth.uid() and now() are the only sources, and the app has no
 * way to override either. A parameter that does not exist cannot be forged.
 *
 * SECURITY DEFINER because `authenticated` holds no INSERT on the table and
 * must not: a grant is a rule anybody can exercise, a function is a rule with a
 * body. Same reasoning 0021 gives for start_carrier_claim().
 *
 * WHY `authenticated` AND NOT `anon`. With email confirmation switched off,
 * supabase.auth.signUp() returns a session, so the signup request that ticked
 * the box is already authenticated by the time this is called and auth.uid() is
 * the person who ticked it. An anon-callable version would have to take a user
 * id as a parameter, at which point anybody holding the publishable key — which
 * is in the browser bundle — could POST an acceptance in a stranger's name.
 * Evidence that anybody can write is not evidence.
 *
 * With confirmation switched ON there is no session at signup, and the call
 * moves to the moment there first is one (/auth/callback). The tick itself is
 * still mandatory and still refused server-side before the account is created;
 * what shifts is the recorded instant, by the minutes between ticking the box
 * and opening the email. That direction is the safe one — it never claims an
 * acceptance happened earlier than it did.
 *
 * A signed-in user CAN call this directly with a version string of their
 * choosing. It does not weaken anything: they can only ever write a row about
 * themselves, they cannot change or remove one, and the worst they achieve is
 * volunteering more evidence against themselves. The version we rely on in a
 * dispute is the version we published.
 */
create or replace function record_terms_acceptance(
  p_document_version text,
  p_assent_digest    text default null,
  p_ip               text default null,
  p_user_agent       text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_version text := btrim(coalesce(p_document_version, ''));
  v_digest  text := nullif(btrim(lower(coalesce(p_assent_digest, ''))), '');
  v_ua      text := nullif(btrim(coalesce(p_user_agent, '')), '');
  v_ip      inet;
  v_at      timestamptz;
begin
  if v_user_id is null then
    raise exception 'not signed in';
  end if;

  if v_version = '' then
    raise exception 'a terms acceptance must name the version that was accepted';
  end if;

  -- `inet` has no try-cast. An unparseable address becomes NULL rather than
  -- aborting the signup that is trying to record it — refusing to create the
  -- account because a header was malformed is the wrong way round, and storing
  -- the malformed string would defeat the column type.
  begin
    v_ip := nullif(btrim(coalesce(p_ip, '')), '')::inet;
  exception
    when others then v_ip := null;
  end;

  -- Same idea: a digest that is not a hex SHA-256 is dropped, not stored and
  -- not raised on. The table constraint would refuse it anyway; this makes the
  -- refusal cost a null column instead of a failed signup.
  if v_digest is not null and v_digest !~ '^[0-9a-f]{64}$' then
    v_digest := null;
  end if;

  -- accepted_at is left to the column default on purpose: it is not mentioned
  -- here either, so there is no line in this function that could be changed to
  -- write a supplied time.
  insert into terms_acceptances (user_id, document_version, ip, user_agent, assent_digest)
  values (v_user_id, v_version, v_ip, v_ua, v_digest)
  on conflict (user_id, document_version) do nothing
  returning accepted_at into v_at;

  if v_at is null then
    select ta.accepted_at into v_at
      from terms_acceptances ta
     where ta.user_id = v_user_id
       and ta.document_version = v_version;
  end if;

  return v_at;
end;
$$;

revoke all on function record_terms_acceptance(text, text, text, text) from public, anon;
grant execute on function record_terms_acceptance(text, text, text, text) to authenticated;
