-- Breakfast & lunch planner. Independent of dinner voting: no votes, no lock checks.
create table public.meal_plan_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  week_id uuid not null references public.weeks(id) on delete cascade,
  date date not null,
  meal_type text not null check (meal_type in ('breakfast','lunch')),
  title text not null check (length(btrim(title)) between 1 and 200),
  recipe_id uuid references public.recipes(id) on delete set null,
  plates integer check (plates is null or (plates >= 0 and plates <= 20)),
  notes text check (notes is null or length(notes) <= 2000),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meal_plan_items_week_date_meal_key unique (week_id, date, meal_type)
);
create index meal_plan_items_household_id_idx on public.meal_plan_items (household_id);
create index meal_plan_items_recipe_id_idx on public.meal_plan_items (recipe_id);

-- keep household_id consistent with the week, date inside the week, recipe in the same household
create or replace function private.meal_plan_items_before_write()
returns trigger
language plpgsql
set search_path to ''
as $$
declare
  v_household uuid;
  v_week_start date;
begin
  select w.household_id, w.week_start into v_household, v_week_start
  from public.weeks w where w.id = new.week_id;
  if not found then
    raise exception 'Week % not found', new.week_id using errcode = '23503';
  end if;
  new.household_id := v_household;
  if new.date < v_week_start or new.date > v_week_start + 6 then
    raise exception 'Date % is outside the week starting %', new.date, v_week_start using errcode = '23514';
  end if;
  if new.recipe_id is not null and not exists (
    select 1 from public.recipes r where r.id = new.recipe_id and r.household_id = v_household
  ) then
    raise exception 'Recipe % does not belong to this household', new.recipe_id using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.meal_plan_items_before_write() from public, anon, authenticated;

create trigger meal_plan_items_before_write before insert or update on public.meal_plan_items
  for each row execute function private.meal_plan_items_before_write();
create trigger meal_plan_items_set_updated_at before update on public.meal_plan_items
  for each row execute function private.set_updated_at();

alter table public.meal_plan_items enable row level security;
revoke all on public.meal_plan_items from anon, authenticated;
grant select, insert, update, delete on public.meal_plan_items to authenticated;

create policy meal_plan_items_select on public.meal_plan_items for select to authenticated
  using ((select private.is_household_member(household_id)));
create policy meal_plan_items_insert on public.meal_plan_items for insert to authenticated
  with check ((select private.is_household_member(household_id)) and (select private.is_week_member(week_id)));
create policy meal_plan_items_update on public.meal_plan_items for update to authenticated
  using ((select private.is_household_member(household_id)))
  with check ((select private.is_household_member(household_id)) and (select private.is_week_member(week_id)));
create policy meal_plan_items_delete on public.meal_plan_items for delete to authenticated
  using ((select private.is_household_member(household_id)));
