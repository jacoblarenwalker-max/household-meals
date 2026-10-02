-- 11_staples_weekly: staples the household buys (almost) every week.
-- Staples > "Add weekly staples (N)" adds every is_weekly staple to the selected week's
-- shopping list in one tap (source = 'staple', skipping ones already on it).
-- Row-level access is unchanged: the existing staples_* policies (household members only)
-- cover the new column, and anon still has no access to staples.
alter table public.staples add column if not exists is_weekly boolean not null default false;
comment on column public.staples.is_weekly is
  'Bought almost every week: included by the Staples "Add weekly staples" button. Independent of active (the per-item "include when adding checked" box).';
create index if not exists staples_weekly_idx on public.staples (household_id) where is_weekly;

-- Milk and eggs are the household's existing staples: weekly by default.
update public.staples set is_weekly = true
where household_id = '733cd381-babb-490c-863f-ee16ee942ad4'
  and id in ('d8442b72-37fe-435c-b2f9-7107166f4100',  -- Milk
             'e693b7e1-c685-41b6-900e-e8755b395395'); -- Eggs- 16 count
