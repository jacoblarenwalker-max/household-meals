-- Live check-offs / deletes / adds between phones on Shopping (and Staples on-list chips).
-- Filter by week_id needs the column in REPLICA IDENTITY for UPDATE/DELETE payloads.
alter table public.shopping_list_items replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shopping_list_items'
  ) then
    alter publication supabase_realtime add table public.shopping_list_items;
  end if;
end $$;
