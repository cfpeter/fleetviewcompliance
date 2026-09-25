-- The federal answer, kept where an owner's "I'm not sure" cannot erase it.
--
-- THE DEFECT. 0031 gave `carriers` three facts and two writers into the SAME
-- three columns: the census row at signup (operation_source = 'fmcsa') and the
-- settings form (operation_source = 'owner'). "I'm not sure" on the form
-- stores NULL — correctly, because being forced to pick a side is worse — but
-- it stores that NULL over the federal value that was already there, and the
-- federal answer is then gone for good. NULL reads as unknown, every gate
-- fails open, and the dashboard goes back to showing all twenty rules.
--
-- That is not a corner case. Two of the six carriers on dev are in exactly
-- this state, and the product already knows better than the board it is
-- drawing for them: /check reads the live census for anybody who types the
-- USDOT number and prints "Intrastate" for the same carrier whose own
-- dashboard is asking him for IFTA, IRP, UCR and an FMCSA insurance filing.
-- A stranger gets the right answer and the customer does not.
--
-- THE FIX. Three columns that only the census ever writes, and a PER-COLUMN
-- fallback in src/lib/fmcsa.ts (`effectiveOperation`): the owner's answer
-- where he has one, the federal answer where he has none, unknown only where
-- neither settles it.
--
-- WHY THE FEDERAL ANSWER IS ALLOWED TO REMOVE A RULE. House rule 3 in
-- src/lib/rules/federal-carrier.ts says a gate returns `false` only where the
-- deciding facts are known and negative, because `false` is the one value that
-- can take an obligation away. The census row is not a guess about the
-- carrier: it is the carrier's own MCS-150, filed with FMCSA over his
-- signature, and it is the record an investigator, a broker and an insurer all
-- read. An owner who has told Washington he runs intrastate and tells us he is
-- not sure has still told somebody. The owner's own answer always wins over
-- it, both are shown to him on /app/settings, and one radio button changes it.
--
-- THE OWNER'S COLUMNS ARE NOT TOUCHED HERE. No backfill writes them, no
-- default appears on them, and `operation_source` keeps meaning exactly what
-- 0031 says it means.

alter table carriers
  add column fmcsa_carrier_operation text
    constraint carriers_fmcsa_carrier_operation_check
    check (fmcsa_carrier_operation in ('A', 'B', 'C')),
  add column fmcsa_for_hire boolean,
  add column fmcsa_hazmat boolean,
  add column fmcsa_operation_read_at timestamptz;

comment on column carriers.fmcsa_carrier_operation is
  'Operation code as the FMCSA census prints it. Written only by signup and scripts/backfill-carrier-operation.mjs; the settings form must never write it. Read as the fallback when carrier_operation is NULL.';
comment on column carriers.fmcsa_for_hire is
  'for-hire as the FMCSA census classdef settles it. Census-only, same as fmcsa_carrier_operation.';
comment on column carriers.fmcsa_hazmat is
  'hazmat as the FMCSA census hm_ind settles it. Census-only, same as fmcsa_carrier_operation.';
comment on column carriers.fmcsa_operation_read_at is
  'When the three fmcsa_* columns were last read off the census. NULL means never — which is not the same as a census that settled nothing.';

-- Seed from the rows where the two writers have not yet diverged. Where
-- `operation_source` is 'fmcsa', the three columns ARE the census answer,
-- copied verbatim at signup and unedited since, so this is a move and not a
-- guess. Rows written by an owner are left alone: the federal answer for those
-- was never stored and has to be fetched, which is the backfill script's job.
update carriers
   set fmcsa_carrier_operation = carrier_operation,
       fmcsa_for_hire          = for_hire,
       fmcsa_hazmat            = hazmat,
       fmcsa_operation_read_at = now()
 where operation_source = 'fmcsa'
   and (carrier_operation is not null or for_hire is not null or hazmat is not null);

-- RLS. `carriers_select` and `carriers_update` (0001) are table-level and
-- already cover every column in the row, so four new columns need no policy.
-- That does mean an owner CAN write the fmcsa_* columns through PostgREST; the
-- application never does, and the columns are a convenience for him rather
-- than a control over him, so a column-level revoke would buy nothing that the
-- three columns beside them do not already concede.

-- ------------------------------------------------------------ share_carrier
--
-- The broker's proof page builds its rule context from this function and the
-- owner's dashboard builds its own from `effectiveOperation`. If only one of
-- them learns the fallback, the two screens count different rows for the same
-- carrier on the same day — which is the exact failure 0031 was written to
-- end, and the reason the coalesce lives here rather than in the page.
--
-- DROP first: CREATE OR REPLACE cannot change a function's return row type,
-- and the grants are restated because DROP takes the ACL with it. The name,
-- arguments and returned column names are unchanged, so every caller keeps
-- working untouched.
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
         coalesce(c.carrier_operation, c.fmcsa_carrier_operation),
         coalesce(c.for_hire,          c.fmcsa_for_hire),
         coalesce(c.hazmat,            c.fmcsa_hazmat)
    from share_links s
    join carriers c on c.id = s.carrier_id
   where s.token_hash = share_token_hash(p_token)
     and s.revoked_at is null
     and s.expires_at > now()
$$;

revoke all on function share_carrier(text) from public;
grant execute on function share_carrier(text) to anon, authenticated;
