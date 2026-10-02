-- Saved breakfasts / lunches with structured ingredients, chosen per day in one tap.
create table public.meal_presets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  meal_type text not null check (meal_type in ('breakfast','lunch')),
  title text not null check (length(btrim(title)) between 1 and 200),
  ingredients jsonb not null default '[]'::jsonb
    check (jsonb_typeof(ingredients) = 'array' and jsonb_array_length(ingredients) <= 50),
  notes text check (notes is null or length(notes) <= 2000),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index meal_presets_household_type_title_key on public.meal_presets (household_id, meal_type, lower(btrim(title)));
create index meal_presets_household_id_idx on public.meal_presets (household_id, meal_type, position);

create trigger meal_presets_set_updated_at before update on public.meal_presets
  for each row execute function private.set_updated_at();

alter table public.meal_presets enable row level security;
revoke all on public.meal_presets from anon, authenticated;
grant select, insert, update, delete on public.meal_presets to authenticated;

create policy meal_presets_select on public.meal_presets for select to authenticated
  using ((select private.is_household_member(household_id)));
create policy meal_presets_insert on public.meal_presets for insert to authenticated
  with check ((select private.is_household_member(household_id)));
create policy meal_presets_update on public.meal_presets for update to authenticated
  using ((select private.is_household_member(household_id)))
  with check ((select private.is_household_member(household_id)));
create policy meal_presets_delete on public.meal_presets for delete to authenticated
  using ((select private.is_household_member(household_id)));

-- a day's breakfast/lunch remembers which preset it came from plus a snapshot of its ingredients
alter table public.meal_plan_items
  add column preset_id uuid references public.meal_presets(id) on delete set null,
  add column ingredients jsonb not null default '[]'::jsonb
    check (jsonb_typeof(ingredients) = 'array' and jsonb_array_length(ingredients) <= 50);
create index meal_plan_items_preset_id_idx on public.meal_plan_items (preset_id);

-- shopping rows generated from presets (consolidated per week, name and unit); only these are rewritten by the app
alter table public.shopping_list_items
  add column preset_generated boolean not null default false;
create unique index shopping_list_items_week_preset_key on public.shopping_list_items
  (week_id, lower(btrim(name)), lower(coalesce(btrim(unit), ''))) where preset_generated;

-- extend the meal_plan_items guard: a linked preset must belong to the same household
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
  if new.preset_id is not null and not exists (
    select 1 from public.meal_presets p where p.id = new.preset_id and p.household_id = v_household
  ) then
    raise exception 'Preset % does not belong to this household', new.preset_id using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.meal_plan_items_before_write() from public, anon, authenticated;
