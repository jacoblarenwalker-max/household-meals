-- Recipe from photo (free tier: one private Storage bucket + two columns + a view).
-- The app downsizes the photo (max ~1600 px, JPEG ~0.8), uploads it to recipe-photos/<household_id>/<uuid>.jpg,
-- inserts a placeholder recipe (status 'pending_photo', photo_path) and one app_events row 'recipe_photo'.
-- The meal bot reads the photo, fills the recipe in, sets status 'ready' and marks the event processed.

-- 1) recipes: status + where the photo lives
alter table public.recipes add column if not exists status text not null default 'ready';
alter table public.recipes drop constraint if exists recipes_status_check;
alter table public.recipes add constraint recipes_status_check check (status in ('ready', 'pending_photo', 'photo_failed'));
alter table public.recipes add column if not exists photo_path text;
alter table public.recipes drop constraint if exists recipes_photo_path_check;
alter table public.recipes add constraint recipes_photo_path_check check (
  photo_path is null or (photo_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$' and split_part(photo_path, '/', 1) = household_id::text));
comment on column public.recipes.status is 'ready | pending_photo (waiting for the meal bot to read photo_path) | photo_failed (bot could not read it)';
comment on column public.recipes.photo_path is 'object name in the private Storage bucket recipe-photos: <household_id>/<uuid>.jpg';

-- 2) private bucket, JPEG only, 3 MB cap (a 1600 px JPEG at 0.8 is usually 200-700 KB)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recipe-photos', 'recipe-photos', false, 3145728, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- object name "<household_id>/<uuid>.jpg" -> is the signed-in user a member of that household?
create or replace function private.recipe_photo_ok(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_name is null or p_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$' then
    return false;
  end if;
  return private.is_household_member(split_part(p_name, '/', 1)::uuid);
exception when others then
  return false;
end;
$$;
revoke all on function private.recipe_photo_ok(text) from public, anon;
grant execute on function private.recipe_photo_ok(text) to authenticated;

drop policy if exists recipe_photos_select on storage.objects;
drop policy if exists recipe_photos_insert on storage.objects;
drop policy if exists recipe_photos_update on storage.objects;
drop policy if exists recipe_photos_delete on storage.objects;
create policy recipe_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'recipe-photos' and (select private.recipe_photo_ok(name)));
create policy recipe_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'recipe-photos' and (select private.recipe_photo_ok(name)));
create policy recipe_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'recipe-photos' and (select private.recipe_photo_ok(name)))
  with check (bucket_id = 'recipe-photos' and (select private.recipe_photo_ok(name)));
create policy recipe_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'recipe-photos' and (select private.recipe_photo_ok(name)));

-- 3) what batch jobs / the wake routine pick up
create or replace view public.pending_photo_recipes
with (security_invoker = true) as
select r.id as recipe_id, r.household_id, r.title, r.photo_path, 'recipe-photos'::text as bucket, r.created_at,
       e.id as event_id, e.created_at as requested_at, e.payload->>'requested_by' as requested_by
from public.recipes r
left join lateral (
  select ev.id, ev.created_at, ev.payload from public.app_events ev
  where ev.household_id = r.household_id and ev.event_type = 'recipe_photo' and ev.processed_at is null
    and ev.payload->>'recipe_id' = r.id::text
  order by ev.created_at desc limit 1) e on true
where r.status = 'pending_photo';
revoke all on public.pending_photo_recipes from anon;
grant select on public.pending_photo_recipes to authenticated;

comment on column public.app_events.event_type is 'check_now | needs_price (payload.items = [{table, id, index?, name}]) | week_locked | needs_work | vote_reminder | recipe_photo (payload: recipe_id, photo_path, bucket) | ...';
