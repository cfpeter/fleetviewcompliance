-- What kind of carrier this is, so a rule can say "this does not apply to you".
--
-- THE DEFECT. src/lib/deadlines.ts has read `c.carrier_operation` off the
-- carrier row since the rule engine was written, and `carriers` never had the
-- column — its columns were the eleven in 0001. So `carrierOperation` was
-- undefined for every carrier, every gate that reads it answered 'unknown', and
-- 'unknown' keeps a rule on the board. An intrastate, private, non-hazmat
-- carrier was asked for IFTA, IRP, UCR, PHMSA hazmat registration and an FMCSA
-- insurance filing — on the dashboard and on the proof page a broker sees
-- (docs/product/REVIEW-2026-09-18.md § 2.1). `RuleContext.forHire` and
-- `RuleContext.hazmat` were written by nothing at all.
--
-- THREE FACTS, THREE-VALUED, NO DEFAULTS. Every column here is nullable and
-- NULL means "not known", never "no". The rules fail OPEN on NULL: a carrier
-- with nothing in these columns sees exactly the rows he saw before this
-- migration. Defaulting any of them would silently take an obligation off
-- somebody's board, which is the one direction this product must never be
-- wrong in.
--
-- WHERE THE VALUES COME FROM. All three are on the FMCSA company census row
-- (data.transportation.gov az4n-8mr2) that src/pages/app/setup.astro already
-- holds at signup:
--   carrier_operation  ← census `carrier_operation`   'A' | 'B' | 'C' | absent
--   for_hire           ← census `classdef`            "AUTHORIZED FOR HIRE",
--                                                     "PRIVATE PROPERTY", … — see
--                                                     forHireFromClassdef in
--                                                     src/lib/fmcsa.ts
--   hazmat             ← census `hm_ind`              'Y' | 'N'
-- The owner can then correct all three on /app/settings ("How your company
-- operates"), and scripts/backfill-carrier-operation.mjs fills carriers that
-- signed up before this migration.

alter table carriers
  add column carrier_operation text
    constraint carriers_carrier_operation_check
    check (carrier_operation in ('A', 'B', 'C')),
  add column for_hire boolean,
  add column hazmat boolean,
  -- Who last wrote the three columns above. `record_source` is the enum every
  -- other table uses for the same question (0002). 'fmcsa' when signup or the
  -- backfill copied the census row; 'owner' when the settings form was saved.
  -- NULL means nothing has written them yet. The backfill skips 'owner' rows,
  -- so an owner's explicit "I'm not sure" is not overwritten by a federal value
  -- he has already seen and declined.
  add column operation_source record_source;

comment on column carriers.carrier_operation is
  'FMCSA operation code: A interstate, B intrastate hazmat, C intrastate non-hazmat. NULL is unknown and every rule fails open on it.';
comment on column carriers.for_hire is
  'Hauls for other people for pay. NULL is unknown; only true/false are acted on, and false alone never removes a rule.';
comment on column carriers.hazmat is
  'Carries placarded hazardous materials. NULL is unknown and keeps every hazmat rule on the board.';
comment on column carriers.operation_source is
  'Who last wrote carrier_operation / for_hire / hazmat: fmcsa (census row) or owner (settings form). NULL: never written.';

-- RLS. The policies on carriers (carriers_select, carriers_update in 0001) are
-- TABLE-level: they decide which ROWS a user can read and write, and a new
-- column is inside every row they already cover. No new policy, and no change
-- to an existing one, is needed for these columns.

-- ------------------------------------------------------------ share_carrier
--
-- The proof page builds its rule context from this function, and it has to
-- build it from the same three facts the owner's dashboard uses or the two
-- screens will count different rows. Before this, the broker's page could not
-- see any of them (src/pages/proof/[token].astro said so in a comment).
--
-- DROP first: CREATE OR REPLACE cannot change a function's return row type.
-- The name and argument list are unchanged, so every caller keeps working;
-- the grants are restated because DROP takes the ACL with it.
--
-- These three columns are the carrier's own MCS-150 answers and are printed on
-- the public SAFER snapshot for this USDOT number, so a token that may already
-- read the legal name and state may read them too.
drop function share_carrier(text);

create function share_carrier(p_token text)
returns table (
  legal_name        text,
  dba_name          text,
  dot_number        text,
  phy_city          text,
  phy_state         text,
  carrier_operation text,
  for_hire          boolean,
  hazmat            boolean
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select c.legal_name, c.dba_name, c.dot_number, c.phy_city, c.phy_state,
         c.carrier_operation, c.for_hire, c.hazmat
    from share_links s
    join carriers c on c.id = s.carrier_id
   where s.token_hash = share_token_hash(p_token)
     and s.revoked_at is null
     and s.expires_at > now()
$$;

revoke all on function share_carrier(text) from public;
grant execute on function share_carrier(text) to anon, authenticated;
