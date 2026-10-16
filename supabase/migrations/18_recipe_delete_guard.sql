-- deleting a recipe that's on any week's dinner plan is refused (otherwise ON DELETE SET NULL would blank that night)
create or replace function private.recipe_delete_guard() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.week_slots s where s.recipe_id = old.id) then
    raise exception 'RECIPE_SCHEDULED: this recipe is on a dinner plan' using errcode = 'P0001';
  end if;
  return old;
end $$;
revoke all on function private.recipe_delete_guard() from public, anon, authenticated;
drop trigger if exists recipes_delete_guard on public.recipes;
create trigger recipes_delete_guard before delete on public.recipes for each row execute function private.recipe_delete_guard();
