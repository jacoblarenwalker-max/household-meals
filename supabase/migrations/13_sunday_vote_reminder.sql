-- Sunday 8 PM (America/Denver) reminder to vote on the week that starts the next day.
-- Free plan only: pg_cron (scheduler) + the existing app_events trigger -> pg_net -> push-notify Edge Function.
--
-- pg_cron runs in UTC, and 8 PM in Denver is 02:00 UTC Monday during MDT (UTC-6) and 03:00 UTC Monday during
-- MST (UTC-7). The job runs at both times; private.send_vote_reminders() only acts when the current time in
-- America/Denver is Sunday 20:xx, so exactly one of the two runs does anything. vote_reminders (one row per
-- household per Sunday) makes a second run on the same Sunday a no-op.

create extension if not exists pg_cron;

-- 1) one row per household per Sunday: the de-duplication claim and a small log
create table if not exists public.vote_reminders (
  household_id uuid not null references public.households(id) on delete cascade,
  reminder_date date not null,                 -- the Sunday, in America/Denver
  week_start date not null,                    -- the Monday it was about
  kind text not null check (kind in ('vote', 'not_planned', 'skipped')),
  reason text,
  week_id uuid references public.weeks(id) on delete set null,
  user_ids uuid[] not null default '{}',
  event_id uuid references public.app_events(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (household_id, reminder_date)
);
alter table public.vote_reminders enable row level security;
revoke all on public.vote_reminders from anon, authenticated;

-- 2) what to send (pure: reads only). p_now lets tests pretend it is another moment.
create or replace function private.vote_reminder_plan(p_household uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_local timestamp := p_now at time zone 'America/Denver';
  v_sunday date := v_local::date;
  v_start date := v_local::date + 1;
  v_end date := v_local::date + 7;
  v_range text;
  v_week_id uuid;
  v_status text;
  v_users uuid[];
  v_base jsonb;
begin
  v_range := to_char(v_start, 'Mon FMDD') || '–' ||
             case when date_trunc('month', v_end) = date_trunc('month', v_start)
                  then to_char(v_end, 'FMDD') else to_char(v_end, 'Mon FMDD') end;
  select w.id, w.status into v_week_id, v_status
    from public.weeks w where w.household_id = p_household and w.week_start = v_start;
  v_base := jsonb_build_object('household_id', p_household, 'reminder_date', v_sunday, 'week_start', v_start,
                               'week_range', v_range, 'week_id', v_week_id, 'week_status', coalesce(v_status, 'none'));

  if v_status = 'locked' then
    return v_base || jsonb_build_object('kind', 'skipped', 'reason', 'week already locked', 'user_ids', '[]'::jsonb);
  elsif v_status = 'needs_work' then
    -- someone asked for changes; the bot is revising it and needs_work already sent a notification
    return v_base || jsonb_build_object('kind', 'skipped', 'reason', 'week is in needs_work (being revised)', 'user_ids', '[]'::jsonb);
  elsif v_status = 'voting' then
    select coalesce(array_agg(m.user_id order by m.created_at), '{}') into v_users
      from public.household_members m
     where m.household_id = p_household and m.is_voter and m.user_id is not null
       and not exists (select 1 from public.votes v
                        where v.week_id = v_week_id and v.member_id = m.id and v.decision = 'approve');
    if cardinality(v_users) = 0 then
      return v_base || jsonb_build_object('kind', 'skipped', 'reason', 'every voter has approved', 'user_ids', '[]'::jsonb);
    end if;
    return v_base || jsonb_build_object('kind', 'vote', 'user_ids', to_jsonb(v_users),
      'title', 'Time to vote on next week’s dinners 🍽️',
      'body', 'Tap to review ' || v_range || '.',
      'url', './?week=' || to_char(v_start, 'YYYY-MM-DD') || '#/week');
  end if;

  -- no week yet, or still a draft: a gentle heads-up to every voter who has signed in
  select coalesce(array_agg(m.user_id order by m.created_at), '{}') into v_users
    from public.household_members m
   where m.household_id = p_household and m.is_voter and m.user_id is not null;
  if cardinality(v_users) = 0 then
    return v_base || jsonb_build_object('kind', 'skipped', 'reason', 'no signed-in voters', 'user_ids', '[]'::jsonb);
  end if;
  return v_base || jsonb_build_object('kind', 'not_planned', 'user_ids', to_jsonb(v_users),
    'title', 'Next week’s dinners aren’t planned yet',
    'body', 'The plan for ' || v_range || ' isn’t ready to vote on yet.',
    'url', './#/week');
end;
$$;
revoke all on function private.vote_reminder_plan(uuid, timestamptz) from public, anon, authenticated;

-- 3) the cron entry point.
--    p_mode 'send' (cron): claim the Sunday, write a vote_reminder app_event (-> trigger -> push-notify).
--    p_mode 'plan': return what would happen, write nothing.
--    p_mode 'push_dry_run': like 'send', but the event carries dry_run = true, so push-notify only counts devices.
create or replace function private.send_vote_reminders(p_now timestamptz default now(), p_mode text default 'send')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local timestamp := p_now at time zone 'America/Denver';
  v_out jsonb := '[]'::jsonb;
  v_plan jsonb;
  v_event uuid;
  h record;
begin
  if p_mode not in ('send', 'plan', 'push_dry_run') then
    raise exception 'unknown mode %', p_mode;
  end if;
  if extract(isodow from v_local) <> 7 or extract(hour from v_local) <> 20 then
    return jsonb_build_object('skipped', 'not Sunday 8 PM in America/Denver',
                              'denver_time', to_char(v_local, 'Dy YYYY-MM-DD HH24:MI'));
  end if;
  for h in select id from public.households order by created_at loop
    v_plan := private.vote_reminder_plan(h.id, p_now);
    if p_mode = 'plan' then
      v_out := v_out || jsonb_build_array(v_plan);
      continue;
    end if;
    insert into public.vote_reminders (household_id, reminder_date, week_start, kind, reason, week_id, user_ids)
    values (h.id, (v_plan->>'reminder_date')::date, (v_plan->>'week_start')::date, v_plan->>'kind', v_plan->>'reason',
            (v_plan->>'week_id')::uuid,
            array(select jsonb_array_elements_text(v_plan->'user_ids')::uuid))
    on conflict (household_id, reminder_date) do nothing;
    if not found then
      v_out := v_out || jsonb_build_array(jsonb_build_object('household_id', h.id, 'kind', 'skipped',
                                                             'reason', 'already handled this Sunday'));
      continue;
    end if;
    if v_plan->>'kind' in ('vote', 'not_planned') then
      -- processed_at is set right away: this event is only for push-notify, not for the meal bot's wake routine
      insert into public.app_events (household_id, week_id, event_type, payload, processed_at)
      values (h.id, (v_plan->>'week_id')::uuid, 'vote_reminder',
              jsonb_build_object('source', 'pg_cron', 'kind', v_plan->>'kind', 'week_start', v_plan->>'week_start',
                                 'user_ids', v_plan->'user_ids', 'title', v_plan->>'title', 'body', v_plan->>'body',
                                 'url', v_plan->>'url', 'dry_run', p_mode = 'push_dry_run'),
              now())
      returning id into v_event;
      update public.vote_reminders set event_id = v_event
       where household_id = h.id and reminder_date = (v_plan->>'reminder_date')::date;
      v_plan := v_plan || jsonb_build_object('event_id', v_event);
    end if;
    v_out := v_out || jsonb_build_array(v_plan);
  end loop;
  return jsonb_build_object('denver_time', to_char(v_local, 'Dy YYYY-MM-DD HH24:MI'), 'mode', p_mode, 'households', v_out);
end;
$$;
revoke all on function private.send_vote_reminders(timestamptz, text) from public, anon, authenticated;

-- 4) let the existing app_events trigger forward vote_reminder events to push-notify too
create or replace function private.app_events_push_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  if not (new.event_type in ('week_locked', 'needs_work', 'vote_reminder')
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

-- 5) schedule: Monday 02:00 and 03:00 UTC (= Sunday 8 PM in Denver in MDT / MST)
select cron.unschedule(jobid) from cron.job where jobname = 'sunday-vote-reminder';
select cron.schedule('sunday-vote-reminder', '0 2,3 * * 1', 'select private.send_vote_reminders();');
