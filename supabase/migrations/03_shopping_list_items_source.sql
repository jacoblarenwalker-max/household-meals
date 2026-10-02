-- Tag shopping items with where they came from. Existing rows stay untouched (source NULL = dinner / unspecified).
alter table public.shopping_list_items
  add column source text check (source is null or source in ('dinner','breakfast','lunch','staple','manual')),
  add column meal_plan_item_id uuid references public.meal_plan_items(id) on delete set null,
  add column staple_id uuid references public.staples(id) on delete set null;

create index shopping_list_items_meal_plan_item_id_idx on public.shopping_list_items (meal_plan_item_id);
create index shopping_list_items_staple_id_idx on public.shopping_list_items (staple_id);
-- a staple can only be on a given week's list once
create unique index shopping_list_items_week_staple_key on public.shopping_list_items (week_id, staple_id) where staple_id is not null;

-- links must point inside the same week / household
create or replace function private.shopping_list_items_check_links()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if new.meal_plan_item_id is not null and not exists (
    select 1 from public.meal_plan_items p where p.id = new.meal_plan_item_id and p.week_id = new.week_id
  ) then
    raise exception 'Meal plan item % is not in this week', new.meal_plan_item_id using errcode = '23514';
  end if;
  if new.staple_id is not null and not exists (
    select 1 from public.staples s join public.weeks w on w.household_id = s.household_id
    where s.id = new.staple_id and w.id = new.week_id
  ) then
    raise exception 'Staple % is not in this household', new.staple_id using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.shopping_list_items_check_links() from public, anon, authenticated;

create trigger shopping_list_items_check_links
  before insert or update of week_id, meal_plan_item_id, staple_id on public.shopping_list_items
  for each row when (new.meal_plan_item_id is not null or new.staple_id is not null)
  execute function private.shopping_list_items_check_links();
