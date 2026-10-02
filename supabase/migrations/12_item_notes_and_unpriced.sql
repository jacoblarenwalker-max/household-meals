-- 12_item_notes_and_unpriced: short shopping names + a separate note, and one place that
-- lists everything still missing a verified Walmart price.

-- 1) shopping_list_items.note: the detail that used to be packed into the name
--    ("Sour cream (chili, incl. the heavy-cream swap, + haystacks topping)" ->
--     name "Sour cream", note "Chili (incl. the heavy-cream swap) + haystacks topping").
alter table public.shopping_list_items add column if not exists note text;
alter table public.shopping_list_items drop constraint if exists shopping_list_items_note_check;
alter table public.shopping_list_items add constraint shopping_list_items_note_check check (note is null or length(note) <= 500);
comment on column public.shopping_list_items.note is
  'Optional detail shown as small muted text under the name (which meals use it, can size, pantry check...). Keep name short, e.g. "Sour cream".';

-- 2) unpriced_items: everything the household adds that has no verified price yet.
--    "Verified" = price_cents set AND a non-blank price_source (same rule as the app/budget).
--    Ingredient rows inside meal_plan_items.ingredients / meal_presets.ingredients carry the same
--    keys (price_cents, price_source, price_verified_at, walmart_product_url) on each object.
--    security_invoker: callers only see their own household's rows (RLS of the base tables).
create or replace view public.unpriced_items with (security_invoker = true) as
select 'staple'::text as kind, s.household_id, null::uuid as week_id, null::date as week_start,
       s.id as item_id, null::integer as ingredient_index, s.name, s.quantity, s.unit, s.category,
       'staple'::text as source, null::text as note, s.created_at
from public.staples s
where s.price_cents is null or coalesce(btrim(s.price_source), '') = ''
union all
select 'shopping_list_item', w.household_id, i.week_id, w.week_start,
       i.id, null, i.name, i.quantity, i.unit, i.category,
       coalesce(i.source, 'dinner'), i.note, i.created_at
from public.shopping_list_items i
join public.weeks w on w.id = i.week_id
where i.price_cents is null or coalesce(btrim(i.price_source), '') = ''
union all
select 'meal_plan_ingredient', m.household_id, m.week_id, w.week_start,
       m.id, (e.ord - 1)::integer, e.ing->>'name',
       case when jsonb_typeof(e.ing->'quantity') = 'number' then (e.ing->>'quantity')::numeric end,
       e.ing->>'unit', e.ing->>'category', m.meal_type, m.title, m.created_at
from public.meal_plan_items m
join public.weeks w on w.id = m.week_id
cross join lateral jsonb_array_elements(case when jsonb_typeof(m.ingredients) = 'array' then m.ingredients else '[]'::jsonb end) with ordinality as e(ing, ord)
where jsonb_typeof(e.ing) = 'object' and coalesce(btrim(e.ing->>'name'), '') <> ''
  and not (jsonb_typeof(e.ing->'price_cents') = 'number' and coalesce(btrim(e.ing->>'price_source'), '') <> '')
union all
select 'preset_ingredient', p.household_id, null, null,
       p.id, (e.ord - 1)::integer, e.ing->>'name',
       case when jsonb_typeof(e.ing->'quantity') = 'number' then (e.ing->>'quantity')::numeric end,
       e.ing->>'unit', e.ing->>'category', p.meal_type, p.title, p.created_at
from public.meal_presets p
cross join lateral jsonb_array_elements(case when jsonb_typeof(p.ingredients) = 'array' then p.ingredients else '[]'::jsonb end) with ordinality as e(ing, ord)
where jsonb_typeof(e.ing) = 'object' and coalesce(btrim(e.ing->>'name'), '') <> ''
  and not (jsonb_typeof(e.ing->'price_cents') = 'number' and coalesce(btrim(e.ing->>'price_source'), '') <> '');
comment on view public.unpriced_items is
  'Everything without a verified Walmart price: staples, shopping_list_items, meal_plan_items.ingredients[ingredient_index] and meal_presets.ingredients[ingredient_index]. Used by the Sunday price check and the needs_price app_event wake routine. note = list-row note, or the meal/preset title for ingredients.';
revoke all on public.unpriced_items from anon, authenticated;
grant select on public.unpriced_items to authenticated;

-- 3) needs_price app_events (written by the app when an unpriced item is added) are processed
--    by the meal bot like check_now; they never trigger a push notification
--    (private.app_events_push_notify only fires for week_locked / needs_work / dinner swaps).
comment on column public.app_events.event_type is
  'check_now | needs_price (payload.items = [{table, id, index?, name}]) | week_locked | needs_work | ...';

-- 4) Oct 5-11, 2026: short names, detail moved to note (prices untouched).
update public.shopping_list_items i
set name = v.name, note = v.note
from (values
  ('ec85c665-24ab-40ce-8588-0bc76668234b'::uuid, 'Light cream cheese', 'Neufchatel'),
  ('698c824f-cddd-4df6-8dfc-d6cc19e824d4'::uuid, 'Shredded mozzarella', 'Spaghetti + toppings'),
  ('0b191d9b-9ada-4a1f-9110-8c0ef51b865c'::uuid, 'Sour cream', 'Chili (incl. the heavy-cream swap) + haystacks topping'),
  ('859ef8bc-0ea1-47e1-831c-4ae5eece2a27'::uuid, 'Ground turkey', 'Frozen 1-lb roll · ½ lb Mon + ½ lb Fri'),
  ('d1f853eb-7d8e-44a9-814b-94824c6fdfed'::uuid, 'Chicken thighs', 'Boneless skinless · Tue chili ~⅔ lb + Thu sheet pan ~½–⅔ lb'),
  ('b9635c10-b17d-4a21-abbb-4c7fdaa7d837'::uuid, 'Black beans', '15 oz can · ⅓ Fri, rest into Sat minestrone'),
  ('de0ee56b-ab94-47d8-b6e2-b69a9e675396'::uuid, 'Chicken broth', '14.5 oz can · Tue chili + Fri haystacks'),
  ('81616420-3421-475d-8711-b09d888ee084'::uuid, 'Crushed tomatoes', '28 oz can · half Mon, half Sat'),
  ('d8466c71-c501-409a-90e7-53a26cb4629e'::uuid, 'Great Northern beans', '15.5 oz cans'),
  ('5784c28a-37bf-496f-adcc-a5a98e840ce6'::uuid, 'Honey', 'Pantry check: skip if you have some'),
  ('f5827c0f-961f-4134-b46e-33b3fc8515fd'::uuid, 'Low-sodium chicken broth', '32 oz carton · Sat minestrone + reheating'),
  ('7167df75-50b0-4fe1-bec7-819fc206a396'::uuid, 'Low-sodium soy sauce', 'Pantry check: skip if you have some'),
  ('1c4a37e1-3ec0-40d5-8f09-6f5a4ac2c677'::uuid, 'Spaghetti', 'Mon; a little broken up for the minestrone'),
  ('6aa2dfdc-4a67-46d8-b4be-3dd2059f66ec'::uuid, 'Tomato sauce', '8 oz can · rest into minestrone'),
  ('12c74c04-1815-4459-854a-cae567d3cca4'::uuid, 'Broccoli', 'Sheet-pan chicken; also stands in for the bell pepper'),
  ('5f83da7a-725c-4743-b732-6431d533b4d0'::uuid, 'Carrots', 'Baby carrots are fine, chopped'),
  ('f815e7cc-da1f-4315-b86a-b29f8de9dd75'::uuid, 'Lemon', 'For the sheet-pan sauce'),
  ('2629cb7e-1602-49f7-a7bd-c72441a835ee'::uuid, 'Chili powder', 'Pantry check: skip if you have some'),
  ('8ba189ca-c7b8-4ee4-ae66-b383d370bc5b'::uuid, 'Ground cumin', 'Pantry check: skip if you have some')
) as v(id, name, note)
where i.id = v.id and i.week_id = '001bb4a2-49bc-4d33-9dbd-86ab07133c7c';
