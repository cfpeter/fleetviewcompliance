-- Alerts.
--
-- The failure mode for a product like this is not missing an alert. It is
-- sending so many that the owner mutes us, and then missing the one that
-- mattered. Every table here exists to make that harder:
--   preferences  — he chooses the channel, the lead time and the person
--   snoozes      — an item he has handled stops nagging, and we record that
--   log          — we can prove what we sent, and never send it twice

create type notify_channel  as enum ('email', 'sms', 'in_app');
create type notify_category as enum (
  'compliance',  -- a deadline approaching or overdue
  'federal',     -- the carrier's FMCSA record changed under them
  'system'       -- an integration broke; we could not check something
);

-- ---------------------------------------------------------------- preferences

create table notification_preferences (
  id          uuid primary key default gen_random_uuid(),
  carrier_id  uuid not null references carriers (id) on delete cascade,
  user_id     uuid not null references profiles (id) on delete cascade,
  category    notify_category not null,
  channel     notify_channel not null,
  enabled     boolean not null default true,

  -- How far ahead to warn, in days, largest first. Negative values are nudges
  -- AFTER the due date: [-1] means "tell me again the day after it lapsed".
  -- An array rather than a single number because one warning is never enough
  -- and four is too many at the same distance.
  lead_days   int[] not null default '{30,7,1,-1}',

  -- Digest beats immediate for anything that is not on fire. Fourteen separate
  -- emails about fourteen expiring items is how we get muted.
  digest      boolean not null default true,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (carrier_id, user_id, category, channel)
);

-- ---------------------------------------------------------------- quiet hours

alter table profiles add column quiet_from time;
alter table profiles add column quiet_to   time;
-- Critical alerts break through quiet hours. The owner must be able to SEE
-- which categories are allowed to, so this is a stored choice, not a constant.
alter table profiles add column quiet_allow_critical boolean not null default true;

-- ---------------------------------------------------------------- snooze

create table notification_snoozes (
  id            uuid primary key default gen_random_uuid(),
  carrier_id    uuid not null references carriers (id) on delete cascade,
  rule_code     text not null,
  subject_type  document_subject not null,
  subject_id    uuid,
  -- Inclusive. Nothing for this item is sent on or before this date.
  until         date not null,
  reason        text,
  created_by    uuid references profiles (id),
  created_at    timestamptz not null default now()
);

create index notification_snoozes_active_idx
  on notification_snoozes (carrier_id, rule_code, subject_id, until);

-- ---------------------------------------------------------------- log

create table notification_log (
  id            uuid primary key default gen_random_uuid(),
  carrier_id    uuid not null references carriers (id) on delete cascade,
  user_id       uuid references profiles (id) on delete set null,
  channel       notify_channel not null,
  category      notify_category not null,

  -- Recorded as sent, not as "the address we currently hold". If he changes his
  -- phone number, this must still say where the message actually went.
  destination   text not null,
  subject       text,
  body          text,

  -- The idempotency key. One item, one recipient, one lead window, one send —
  -- ever. Without this an overdue item messages him every single morning until
  -- he fixes it, which is precisely how a product gets muted.
  dedup_key     text not null,

  status        text not null default 'sent',
  error         text,
  sent_at       timestamptz not null default now(),
  unique (dedup_key)
);

create index notification_log_carrier_idx on notification_log (carrier_id, sent_at desc);

-- ---------------------------------------------------------------- RLS

alter table notification_preferences enable row level security;
alter table notification_preferences force  row level security;
alter table notification_snoozes     enable row level security;
alter table notification_snoozes     force  row level security;
alter table notification_log         enable row level security;
alter table notification_log         force  row level security;

revoke all on notification_preferences, notification_snoozes, notification_log
  from public, anon, authenticated;

grant select, insert, update, delete on notification_preferences to authenticated;
grant select, insert, delete        on notification_snoozes     to authenticated;
-- The log is evidence of what we sent. Readable, never editable from the app.
grant select                        on notification_log         to authenticated;

create policy notification_preferences_rw on notification_preferences
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create policy notification_snoozes_rw on notification_snoozes
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create policy notification_log_read on notification_log
  for select to authenticated
  using (carrier_id in (select current_user_carriers()));

create trigger notification_preferences_touch
  before update on notification_preferences
  for each row execute function touch_updated_at();
