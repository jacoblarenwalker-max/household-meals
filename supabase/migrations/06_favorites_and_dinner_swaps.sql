-- Favorites ("go-to dinners") + member dinner swaps on This week.
-- RLS is unchanged: recipes_update already lets any household member update their own household's recipes,
-- and week_slots_update lets week members update their week's slots.

alter table public.recipes add column if not exists is_favorite boolean not null default false;

-- When a signed-in member changes a week's dinners, the plan needs fresh approvals and a fresh shopping list:
--  * a locked week goes back to voting; all approve votes for the week are cleared (needs_work comments stay),
--    so in multi mode it locks again only once every voter approves the new plan;
--  * unchecked dinner rows (source null/'dinner') tied to a recipe that is no longer planned that week are removed;
--    breakfast / lunch / staple / manual / preset rows are never touched;
--  * a check_now app_event asks the meal bot to rebuild the dinner part of the shopping list.
create or replace function private.reopen_week_after_dinner_change(p_week_id uuid, p_old_recipe uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_week public.weeks%rowtype;
  v_removed integer := 0;
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

  if p_old_recipe is not null and not exists (
    select 1 from public.week_slots s where s.week_id = p_week_id and s.recipe_id = p_old_recipe
  ) then
    delete from public.shopping_list_items i
     where i.week_id = p_week_id
       and i.recipe_id = p_old_recipe
       and (i.source is null or i.source = 'dinner')
       and i.meal_plan_item_id is null
       and i.staple_id is null
       and not coalesce(i.preset_generated, false)
       and not i.checked;
    get diagnostics v_removed = row_count;
  end if;

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

revoke all on function private.reopen_week_after_dinner_change(uuid, uuid, jsonb) from public, anon;
grant execute on function private.reopen_week_after_dinner_change(uuid, uuid, jsonb) to authenticated, service_role;

-- Fires only for signed-in app users (the meal bot writes with its own role and is not affected).
create or replace function private.week_slots_after_user_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- skip non-app roles, and cascaded/nested changes (e.g. a whole week being deleted)
  if current_user <> 'authenticated' or pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and new.recipe_id is not distinct from old.recipe_id
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
                       'new_recipe_id', case when tg_op = 'DELETE' then null else new.recipe_id end));
  return null;
end;
$$;

drop trigger if exists week_slots_after_user_change on public.week_slots;
create trigger week_slots_after_user_change
  after insert or update or delete on public.week_slots
  for each row execute function private.week_slots_after_user_change();
