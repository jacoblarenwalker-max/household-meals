-- Combine two recipes on one dinner night: main (recipe_id) + optional side (side_recipe_id).
-- Swap / Add-a-side updates still go through week_slots_after_user_change → check_now (dinner_swap).

alter table public.week_slots
  add column if not exists side_recipe_id uuid references public.recipes(id) on delete set null;

alter table public.week_slots drop constraint if exists week_slots_side_ne_main;
alter table public.week_slots add constraint week_slots_side_ne_main
  check (side_recipe_id is null or side_recipe_id is distinct from recipe_id);

create index if not exists week_slots_side_recipe_id_idx on public.week_slots (side_recipe_id)
  where side_recipe_id is not null;

comment on column public.week_slots.side_recipe_id is
  'Optional companion recipe on the same night (e.g. breadsticks with Alfredo). Shopping, meal_ingredient_costs and calories include both. Leftover nights inherit the cooked night''s side via leftover_from_slot_id.';

-- reopen / rebuild when the side changes too
create or replace function private.week_slots_after_user_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' or pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and new.recipe_id is not distinct from old.recipe_id
     and new.side_recipe_id is not distinct from old.side_recipe_id
     and new.is_leftover_night = old.is_leftover_night
     and new.leftover_from_slot_id is not distinct from old.leftover_from_slot_id
     and new.date = old.date then
    return null;
  end if;
  perform private.reopen_week_after_dinner_change(
    coalesce(new.week_id, old.week_id),
    case when tg_op = 'INSERT' then null else old.recipe_id end,
    jsonb_build_object('change', lower(tg_op),
                       'slot_id', coalesce(new.id, old.id),
                       'date', coalesce(new.date, old.date),
                       'old_recipe_id', case when tg_op = 'INSERT' then null else old.recipe_id end,
                       'new_recipe_id', case when tg_op = 'DELETE' then null else new.recipe_id end,
                       'old_side_recipe_id', case when tg_op = 'INSERT' then null else old.side_recipe_id end,
                       'new_side_recipe_id', case when tg_op = 'DELETE' then null else new.side_recipe_id end));
  return null;
end;
$$;

-- also refuse delete when the recipe is only used as a side
create or replace function private.recipe_delete_guard() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.week_slots s where s.recipe_id = old.id or s.side_recipe_id = old.id) then
    raise exception 'RECIPE_SCHEDULED: this recipe is on a dinner plan' using errcode = 'P0001';
  end if;
  return old;
end $$;
