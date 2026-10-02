-- Staples: things the household buys outside of planned meals (snacks, drinks, basics)
create table public.staples (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  category text not null default 'Other' check (length(btrim(category)) between 1 and 60),
  quantity numeric check (quantity is null or quantity >= 0),
  unit text check (unit is null or length(unit) <= 40),
  active boolean not null default true,   -- "checked" = included in "Add all checked to list"
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index staples_household_name_key on public.staples (household_id, lower(btrim(name)));
create index staples_household_category_idx on public.staples (household_id, category, position);

create trigger staples_set_updated_at before update on public.staples
  for each row execute function private.set_updated_at();

alter table public.staples enable row level security;
revoke all on public.staples from anon, authenticated;
grant select, insert, update, delete on public.staples to authenticated;

create policy staples_select on public.staples for select to authenticated
  using ((select private.is_household_member(household_id)));
create policy staples_insert on public.staples for insert to authenticated
  with check ((select private.is_household_member(household_id)));
create policy staples_update on public.staples for update to authenticated
  using ((select private.is_household_member(household_id)))
  with check ((select private.is_household_member(household_id)));
create policy staples_delete on public.staples for delete to authenticated
  using ((select private.is_household_member(household_id)));
