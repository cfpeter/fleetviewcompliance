-- Four things that were wrong, and the schema changes that make them right.
--
-- Nothing here is a feature. Each block below removes a specific way the
-- database could disagree with itself or with the code that reads it.
--
-- A NOTE ON RLS AND THIS FILE, because it is not obvious and it is load-bearing:
-- three of these tables carry FORCE row level security, which applies policies
-- to the table OWNER too — and every policy in this schema is granted
-- `TO authenticated`, a role this migration does not run as. A backfill UPDATE
-- under FORCE that matches no policy does not raise; it silently touches ZERO
-- rows. What saves the backfills below is that Supabase's `postgres` role
-- carries the BYPASSRLS attribute, so the migration genuinely sees every row.
-- If this project is ever migrated by a role without BYPASSRLS, every backfill
-- in this file becomes a silent no-op and the data does not move. Check
-- `select rolbypassrls from pg_roles where rolname = current_user` first.

-- =====================================================================
-- ITEM 1 — lead_days and digest were hanging off the wrong table.
-- =====================================================================
--
-- `notification_preferences` is keyed (carrier_id, user_id, category, channel),
-- because "email yes, text no" is genuinely a per-channel choice. But
-- `lead_days` and `digest` are not: "warn me 30 days out" is a fact about the
-- DEADLINE, not about the wire the message travels down. Nobody has ever wanted
-- to be emailed 30 days out and texted 7 days out about the same item.
--
-- Hanging them off the wider key meant one category stored THREE copies of each,
-- free to disagree. The settings page papered over it — writing the same array
-- to all three rows on save, and reading whichever it found first on load — so
-- a disagreement was invisible on screen and permanent in the data. That is a
-- workaround for a schema bug, and this is the schema bug.

create table notification_category_preferences (
  -- The composite key IS the identity. A surrogate `id` plus a unique
  -- constraint would say the same thing twice, and the bug being fixed here is
  -- precisely a key that was one column too wide — so the narrow key is the
  -- structure, not a constraint bolted onto something wider.
  carrier_id  uuid not null references carriers (id) on delete cascade,
  user_id     uuid not null references profiles (id) on delete cascade,
  category    notify_category not null,

  -- Same meaning and same default as the column it replaces: how far ahead to
  -- warn, in days, largest first, negatives being nudges AFTER the due date.
  -- The default is repeated from 0008 deliberately rather than inherited,
  -- because DEFAULT_LEAD_DAYS in src/lib/notify/preferences.ts is the third
  -- copy of this list and tests/notify-preferences.test.ts pins it.
  lead_days   int[] not null default '{30,7,1,-1}',

  -- Digest beats immediate for anything that is not on fire. Still stored, and
  -- still read by nothing: the digest job already batches unconditionally. The
  -- settings page says so in words next to the box.
  digest      boolean not null default true,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (carrier_id, user_id, category)
);

-- Move the existing values across before the old columns go. Two aggregates,
-- because the two columns disagree in different ways:
--
--   lead_days  the LONGEST array wins. Not a union of all three: a union would
--              invent a lead window nobody ever chose, and inventing alerts is
--              the exact failure this product dies of. The longest array is one
--              a person actually typed, and the tie-break is deterministic
--              rather than whatever order the planner felt like.
--   digest     bool_or, so a single `true` survives. `true` means "roll it into
--              one daily message", which is the QUIETER reading of a
--              disagreement — and when the three rows disagree we would rather
--              send one message than three.
with winner as (
  select distinct on (carrier_id, user_id, category)
         carrier_id, user_id, category, lead_days, created_at
    from notification_preferences
   order by carrier_id, user_id, category,
            -- array_length is NULL for '{}', which would sort ahead of a real
            -- array under `desc` and hand the empty one the win. `[]` means
            -- "warn me never" — the single most dangerous value this column can
            -- hold, and the one parseLeadDays refuses to save.
            coalesce(array_length(lead_days, 1), 0) desc,
            updated_at desc,
            channel
),
digests as (
  select carrier_id, user_id, category, bool_or(digest) as digest
    from notification_preferences
   group by carrier_id, user_id, category
)
insert into notification_category_preferences
  (carrier_id, user_id, category, lead_days, digest, created_at)
select w.carrier_id, w.user_id, w.category, w.lead_days, d.digest, w.created_at
  from winner w
  join digests d using (carrier_id, user_id, category);

-- The old columns go. They are NOT kept: both readers — src/pages/app/settings.astro
-- and src/pages/api/cron/digest.ts — are updated in the same change, and leaving
-- the columns behind would leave the three-copies bug reachable by any future
-- writer that had not read this comment.
alter table notification_preferences drop column lead_days;
alter table notification_preferences drop column digest;

comment on table notification_preferences is
  'Per-CHANNEL choices only. Lead times and digest live in notification_category_preferences: they are facts about the deadline, not about the wire.';

alter table notification_category_preferences enable row level security;
alter table notification_category_preferences force  row level security;

revoke all on notification_category_preferences from public, anon, authenticated;
-- No DELETE. The settings page upserts the full set of categories on every save,
-- so there is nothing for a delete to do — and a privilege that is not granted
-- cannot be reached by a later mistake.
grant select, insert, update on notification_category_preferences to authenticated;

create policy notification_category_preferences_rw on notification_category_preferences
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create trigger notification_category_preferences_touch
  before update on notification_category_preferences
  for each row execute function touch_updated_at();

-- =====================================================================
-- ITEM 2 — notification_snoozes.subject_type was a decorative column.
-- =====================================================================
--
-- It was typed `document_subject` ('carrier' | 'driver' | 'vehicle' | 'terminal'),
-- which is the DOCUMENT FILING vocabulary: a medical card is filed against a
-- driver, an inspection report against a vehicle. The rule engine's subjects are
-- a different list — 'carrier' | 'driver' | 'employee' | 'power_unit' |
-- 'trailer' | 'terminal' (src/lib/rules/types.ts) — because the obligations on a
-- tractor and on a trailer are not the same obligations, and training rules
-- attach to office staff who are not drivers at all.
--
-- A snooze is a statement about a RULE, so it must speak the rule engine's
-- vocabulary. Storing 'vehicle' for a rule whose subject is 'power_unit' meant
-- the column could never be matched against anything, and `isSnoozed` duly
-- ignored it — matching on rule code and subject id alone. A column no code
-- reads is a column that is silently wrong, and it was.
--
-- CHOSEN: a NEW enum mirroring the engine's Subject union, rather than widening
-- `document_subject`. Two reasons, both concrete:
--
--   1. `document_subject` is shared with documents.subject_type and
--      compliance_records.subject_type, whose triggers switch on 'vehicle' and
--      raise on anything they do not recognise. Widening it would let a caller
--      write documents.subject_type = 'power_unit', which those triggers reject
--      at runtime — an enum value that type-checks and then fails.
--   2. `ALTER TYPE ... ADD VALUE` cannot be USED in the same transaction that
--      adds it, and scripts/migrate.mjs runs one transaction per file. Widening
--      would therefore have to span two migrations, and the backfill would sit
--      in the second one — a half-applied state this convention exists to make
--      impossible.
create type rule_subject as enum (
  'carrier',
  'driver',
  'employee',
  'power_unit',
  'trailer',
  'terminal'
);

comment on type rule_subject is
  'Mirrors Subject in src/lib/rules/types.ts exactly. Distinct from document_subject on purpose: that is the filing vocabulary, this is the obligation vocabulary.';

-- Via a new column rather than ALTER COLUMN ... TYPE ... USING, because the
-- translation for 'vehicle' has to ask the vehicles table which kind it was, and
-- a USING clause may not contain a subquery.
alter table notification_snoozes add column subject_kind rule_subject;

update notification_snoozes s
   set subject_kind = case
     -- carrier, driver and terminal mean the same thing in both vocabularies.
     when s.subject_type <> 'vehicle' then s.subject_type::text::rule_subject
     when exists (
       select 1 from vehicles v where v.id = s.subject_id and v.kind = 'trailer'
     ) then 'trailer'::rule_subject
     -- Everything else lands on 'power_unit', including a snooze whose vehicle
     -- row has since been deleted. That is the fail-SAFE direction: a snooze
     -- whose type no longer matches the item stops suppressing, so we nag about
     -- something that was set aside. The opposite error — suppressing a deadline
     -- nobody meant to silence — is the one that costs a truck.
     else 'power_unit'::rule_subject
   end;

alter table notification_snoozes alter column subject_kind set not null;
alter table notification_snoozes drop column subject_type;
alter table notification_snoozes rename column subject_kind to subject_type;

comment on column notification_snoozes.subject_type is
  'The rule engine vocabulary, and isSnoozed() in src/lib/notify/select.ts now matches on it. A row whose type disagrees with the rule''s own subject does NOT suppress.';

-- =====================================================================
-- ITEM 4 — carriers.timezone was written at signup and read by nothing.
-- =====================================================================
--
-- DECISION: keep it, and make it the real fallback for a person who has not
-- chosen their own. A carrier-wide default is genuinely useful — an outfit in
-- Phoenix hires an office manager in Phoenix, and nobody should have to open a
-- settings page to stop being woken on somebody else's clock.
--
-- But the fallback could not fire, because `profiles.timezone` was NOT NULL
-- DEFAULT 'America/Los_Angeles': every new account silently CLAIMED Pacific, so
-- "unset" was not expressible and `coalesce(profile, carrier)` would have been
-- dead code dressed up as a fix. handle_new_user() does not write the column, so
-- from here a new profile carries NULL and inherits the carrier's zone.
alter table profiles alter column timezone drop default;
alter table profiles alter column timezone drop not null;

-- DELIBERATELY NOT BACKFILLED. Every existing row holds 'America/Los_Angeles',
-- and nothing in the data distinguishes "chose Pacific" from "never chose".
-- Nulling them would make a Pacific-choosing person at a Phoenix carrier inherit
-- Phoenix — moving their morning by an hour because a migration ran. Existing
-- rows keep the value they have; only new ones inherit.
comment on column profiles.timezone is
  'NULL means "not chosen": fall back to carriers.timezone, then America/Los_Angeles. Rows written before 0010 hold an explicit America/Los_Angeles that may or may not have been a choice; they were left alone on purpose.';

-- =====================================================================
-- ITEM 3 — quiet hours are honoured in src/pages/api/cron/digest.ts.
-- =====================================================================
--
-- No schema change, and that is the finding worth recording: profiles.quiet_from,
-- quiet_to and quiet_allow_critical were already there, already collected by the
-- settings page, and already covered by withinQuietHours() in
-- src/lib/notify/guard.ts. The digest job simply never asked for them.
--
-- One consequence belongs here rather than only in the TypeScript, because it is
-- about this schema: a HELD message must not write a notification_log row.
-- `dedup_key` is UNIQUE and the job treats every key it finds in that table as
-- already handled, whatever the row's status says — so logging a hold would burn
-- the key and the message would never arrive at all. Held messages are counted in
-- the job's summary and written nowhere, which is what lets the next run send them.
