-- Web Push notifications + short recipe descriptions.
-- Free-plan only: pg_net (async HTTP from Postgres), Vault, one Edge Function.

-- 1) one-line recipe descriptions shown on This week
alter table public.recipes add column if not exists description text;
alter table public.recipes drop constraint if exists recipes_description_len;
alter table public.recipes add constraint recipes_description_len check (description is null or length(description) <= 120);

-- 2) a device's push subscription, owned by the signed-in user
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://'),
  keys jsonb not null check (jsonb_typeof(keys) = 'object' and keys ? 'p256dh' and keys ? 'auth'),
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz
);
create index if not exists push_subscriptions_household_idx on public.push_subscriptions (household_id);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

drop policy if exists push_subscriptions_select on public.push_subscriptions;
drop policy if exists push_subscriptions_insert on public.push_subscriptions;
drop policy if exists push_subscriptions_update on public.push_subscriptions;
drop policy if exists push_subscriptions_delete on public.push_subscriptions;
create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
create policy push_subscriptions_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()) and (select private.is_household_member(household_id)));
create policy push_subscriptions_update on public.push_subscriptions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (select private.is_household_member(household_id)));
create policy push_subscriptions_delete on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

-- 3) delivery log + de-duplication (written only by the Edge Function; no client access)
create table if not exists public.push_notified_events (
  event_id uuid primary key references public.app_events(id) on delete cascade,
  event_type text not null,
  created_at timestamptz not null default now(),
  recipients integer, sent integer, failed integer, removed integer
);
alter table public.push_notified_events enable row level security;
revoke all on public.push_notified_events from anon, authenticated;

-- 4) on swap-reopened / locked / needs-work events, ask the push-notify Edge Function to send.
--    The shared secret is read from Vault (secret name push_webhook_secret), never stored in code.
create extension if not exists pg_net;

create or replace function private.app_events_push_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  if not (new.event_type in ('week_locked', 'needs_work')
          or (new.event_type = 'check_now' and new.payload->>'source' = 'dinner_swap'
              and coalesce(new.payload->>'previous_status', '') <> 'draft')) then
    return null;
  end if;
  -- no devices subscribed in this household: nothing to send, skip the HTTP call
  if not exists (select 1 from public.push_subscriptions s where s.household_id = new.household_id) then
    return null;
  end if;
  select ds.decrypted_secret into v_secret from vault.decrypted_secrets ds where ds.name = 'push_webhook_secret' limit 1;
  if v_secret is null then
    return null;
  end if;
  perform net.http_post(
    url := 'https://voydoxmxdnjnewxlwzse.supabase.co/functions/v1/push-notify',
    body := jsonb_build_object('event_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
    timeout_milliseconds := 10000);
  return null;
exception when others then
  -- notifications are best effort: never block votes, locks or swaps
  raise warning 'push notify enqueue failed: %', sqlerrm;
  return null;
end;
$$;
revoke all on function private.app_events_push_notify() from public, anon, authenticated;

drop trigger if exists app_events_push_notify on public.app_events;
create trigger app_events_push_notify
  after insert on public.app_events
  for each row execute function private.app_events_push_notify();
