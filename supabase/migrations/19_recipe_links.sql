-- Recipe from link (free tier: status values + a view; URL lives in recipes.source_url).
-- The app inserts a placeholder recipe (status 'pending_link', source_url = pasted https URL,
-- including pin.it) and one app_events row 'recipe_link'. The meal bot fetches the page
-- (resolving Pinterest pins to the destination recipe URL first), fills the recipe in,
-- sets status 'ready' and marks the event processed. Same app_events webhook path as recipe_photo.

-- 1) recipes.status: allow pending_link / link_failed
alter table public.recipes drop constraint if exists recipes_status_check;
alter table public.recipes add constraint recipes_status_check
  check (status in ('ready', 'pending_photo', 'photo_failed', 'pending_link', 'link_failed'));
comment on column public.recipes.status is
  'ready | pending_photo (waiting for bot to read photo_path) | photo_failed | pending_link (waiting for bot to fetch source_url) | link_failed (bot could not fetch/parse the URL)';

-- 2) what batch jobs / the wake routine pick up
create or replace view public.pending_link_recipes
with (security_invoker = true) as
select r.id as recipe_id, r.household_id, r.title, r.source_url as url, r.created_at,
       e.id as event_id, e.created_at as requested_at, e.payload->>'requested_by' as requested_by
from public.recipes r
left join lateral (
  select ev.id, ev.created_at, ev.payload from public.app_events ev
  where ev.household_id = r.household_id and ev.event_type = 'recipe_link' and ev.processed_at is null
    and ev.payload->>'recipe_id' = r.id::text
  order by ev.created_at desc limit 1) e on true
where r.status = 'pending_link';
revoke all on public.pending_link_recipes from anon;
grant select on public.pending_link_recipes to authenticated;

comment on column public.app_events.event_type is
  'check_now | needs_price (payload.items = [{table, id, index?, name}]) | week_locked | needs_work | vote_reminder | recipe_photo (payload: recipe_id, photo_path, bucket) | recipe_link (payload: recipe_id, url) | ...';
