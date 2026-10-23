-- When a side is removed/changed, drop unchecked dinner rows for the old side recipe too.
create or replace function private.reopen_week_after_dinner_change(p_week_id uuid, p_old_recipe uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_week public.weeks%rowtype;
  v_removed integer := 0;
  v_old_side uuid := nullif(p_payload->>'old_side_recipe_id', '')::uuid;
  v_rid uuid;
  v_n integer;
begin
  select w.* into v_week from public.weeks w where w.id = p_week_id;
  if not found then
    return;
  end if;
  if not private.is_week_member(p_week_id) then
    raise exception 'Not a member of this week' using errcode = '42501';
  end if;

  if v_week.status = 'locked' then
    update public.weeks set status = 'voting' where id = p_week_id;
  end if;
  delete from public.votes where week_id = p_week_id and decision = 'approve';
  perform private.recompute_week_status(p_week_id);

  foreach v_rid in array array[p_old_recipe, v_old_side]
  loop
    if v_rid is null then
      continue;
    end if;
    if exists (
      select 1 from public.week_slots s
      where s.week_id = p_week_id and (s.recipe_id = v_rid or s.side_recipe_id = v_rid)
    ) then
      continue;
    end if;
    delete from public.shopping_list_items i
     where i.week_id = p_week_id
       and i.recipe_id = v_rid
       and (i.source is null or i.source = 'dinner')
       and i.meal_plan_item_id is null
       and i.staple_id is null
       and not coalesce(i.preset_generated, false)
       and not i.checked;
    get diagnostics v_n = row_count;
    v_removed := v_removed + v_n;
  end loop;

  insert into public.app_events (household_id, week_id, event_type, payload)
  values (v_week.household_id, p_week_id, 'check_now',
          jsonb_build_object('week_start', v_week.week_start,
                             'source', 'dinner_swap',
                             'rebuild_shopping_list', true,
                             'only_dinner_rows', true,
                             'previous_status', v_week.status,
                             'removed_dinner_rows', v_removed,
                             'requested_by_user_id', (select auth.uid()))
          || coalesce(p_payload, '{}'::jsonb));
end;
$$;
