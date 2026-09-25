-- The paper behind a shared driver file.
--
-- WHAT IT IS FOR. src/lib/proof/dqf.ts scores each paragraph of 49 CFR
-- 391.51(b) and then asks a second question about it: is there a DOCUMENT
-- behind the date, or only a date? The owner's own binder has always answered
-- it — it reads `documents` directly — and prints "Date recorded, no document"
-- where a date was typed in and nothing was ever scanned.
--
-- The shared link could not answer it at all. `anon` has no grant on
-- `documents` (0003 revokes it, correctly), and the functions 0014 added return
-- a carrier, a driver, anchors and counts. So the broker's page printed "On
-- file" for a medical card nobody holds a copy of — on the one document a
-- carrier hands to somebody checking up on him. The page that overstates was
-- the page that gets sent out, which is the wrong way round.
--
-- WHAT IT RETURNS, AND WHAT IT DELIBERATELY DOES NOT. `kind`, and nothing else.
-- Not `storage_key`: that is the R2 object, and the private bucket is the whole
-- point of it. Not `file_name`, which in practice carries a driver's name and
-- often his licence number. Not `issued_on`, which is a date the anchors
-- already give. A set of kinds is the least that can answer "is there paper
-- behind (b)(6)", and the least is what a stranger gets.
--
-- IT CAN ONLY EVER MAKE THE PAGE SAY LESS. A kind that is present turns nothing
-- green; it only stops "Date recorded, no document" being printed where paper
-- does exist. Absent kinds downgrade "On file". There is no arrangement of this
-- data that makes a carrier look better than his own binder says he is.
--
-- Same shape as everything else in 0014 and 0026: THE TOKEN AND NOTHING ELSE,
-- `s.scope = 'driver_file'` as the load-bearing line, and the scope enforced
-- here rather than in the page. A function taking (token, driver_id) could be
-- pointed at any driver by guessing ids; this one cannot be pointed anywhere
-- its own link does not already reach.

create or replace function share_documents(p_token text)
returns table (kind text)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select distinct d.kind
    from share_links s
    join documents d
      on d.carrier_id = s.carrier_id
     and d.subject_type = 'driver'
     and d.subject_id = s.subject_id
   where s.token_hash = share_token_hash(p_token)
     and s.scope = 'driver_file'
     and s.revoked_at is null
     and s.expires_at > now()
     -- A superseded upload is not evidence of anything current. The owner's
     -- binder filters on exactly this line; two screens, one definition of
     -- what counts as paper we hold.
     and d.superseded_at is null
$$;

comment on function share_documents(text) is
  'Document KINDS held against the driver named by a driver_file token, un-superseded. Never storage keys, file names or dates. Feeds the paper-backing check in src/lib/proof/dqf.ts so the shared link and the owner''s printed binder say the same thing.';

-- Stated rather than inherited. CREATE OR REPLACE on a new name starts from the
-- schema default, which grants EXECUTE to public — and public includes anon
-- whether or not anybody meant it to. The revoke is what makes the grant below
-- the whole of the access, the same way 0014 and 0026 write it.
revoke all on function share_documents(text) from public;
grant execute on function share_documents(text) to anon, authenticated;
