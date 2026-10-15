-- calories per serving for breakfasts / lunches: saved presets and week items (same columns as recipes)
alter table public.meal_presets add column if not exists calories_per_serving integer check (calories_per_serving is null or calories_per_serving between 1 and 5000),
  add column if not exists calories_approx boolean not null default false,
  add column if not exists calories_basis text check (calories_basis is null or length(calories_basis) <= 600),
  add column if not exists calories_note text check (calories_note is null or length(calories_note) <= 300),
  add column if not exists calories_checked_at timestamptz;
alter table public.meal_plan_items add column if not exists calories_per_serving integer check (calories_per_serving is null or calories_per_serving between 1 and 5000),
  add column if not exists calories_approx boolean not null default false,
  add column if not exists calories_basis text check (calories_basis is null or length(calories_basis) <= 600),
  add column if not exists calories_note text check (calories_note is null or length(calories_note) <= 300),
  add column if not exists calories_checked_at timestamptz;

-- everything the meal bot still needs to count (security invoker: RLS applies, members only)
create or replace view public.uncounted_calories with (security_invoker = true) as
  select 'recipe'::text as kind, r.id, r.household_id, null::uuid as week_id, r.title, null::text as meal_type, r.created_at
    from public.recipes r where r.calories_per_serving is null and coalesce(r.status, 'ready') = 'ready'
  union all
  select 'preset', p.id, p.household_id, null, p.title, p.meal_type, p.created_at
    from public.meal_presets p where p.calories_per_serving is null
  union all
  select 'meal_plan_item', m.id, m.household_id, m.week_id, m.title, m.meal_type, m.created_at
    from public.meal_plan_items m
    where m.calories_per_serving is null and m.recipe_id is null
      and not exists (select 1 from public.meal_presets p where p.id = m.preset_id and p.calories_per_serving is not null);
revoke all on public.uncounted_calories from anon;
grant select on public.uncounted_calories to authenticated;
