-- Per-dinner cost on This week.
-- A dinner row on the shopping list already points at one recipe through recipe_id. Rows that are bought once
-- and shared by several dinners (one onion for three meals, a can split Mon/Sat) have recipe_id null, so their
-- cost had no owner. meal_shares records how such a row is split:
--   [{"recipe_id": "<uuid>", "share": 0.5}, ...]   shares are fractions of the row's price, total <= 1
-- The app adds price_cents * share to that recipe's dinner (only verified prices: price_cents + price_source).
-- Rows with recipe_id keep working as before (share 1 to that recipe). Only dinner rows use this; the meal
-- bot's dinner-list rebuild should write meal_shares on the shared rows it creates.

create or replace function private.meal_shares_ok(s jsonb)
returns boolean language sql immutable as $$
  select s is null or (
    jsonb_typeof(s) = 'array'
    and not exists (
      select 1 from jsonb_array_elements(s) e
      where jsonb_typeof(e) <> 'object'
         or coalesce(jsonb_typeof(e->'recipe_id'), '') <> 'string'
         or (e->>'recipe_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or coalesce(jsonb_typeof(e->'share'), '') <> 'number'
         or (case when jsonb_typeof(e->'share') = 'number' then (e->>'share')::numeric else -1 end) not between 0.0001 and 1
    )
    and coalesce((select sum(case when jsonb_typeof(e->'share') = 'number' then (e->>'share')::numeric else 0 end)
                  from jsonb_array_elements(s) e), 0) <= 1.001
  )
$$;
grant execute on function private.meal_shares_ok(jsonb) to authenticated, service_role;

alter table public.shopping_list_items add column if not exists meal_shares jsonb;
alter table public.shopping_list_items drop constraint if exists shopping_list_items_meal_shares_ok;
alter table public.shopping_list_items add constraint shopping_list_items_meal_shares_ok check (private.meal_shares_ok(meal_shares));
comment on column public.shopping_list_items.meal_shares is
  'Dinner rows shared by several recipes: [{"recipe_id": uuid, "share": 0-1}], fractions of price_cents per recipe (total <= 1). Null = use recipe_id.';

-- Backfill: week of Oct 5-11 2026 (001bb4a2-...). Splits follow the meal bot's own notes on each row
-- ("half Mon, half Sat", "1/3 Fri, rest into Sat") and otherwise the amounts each recipe uses at the batch
-- size planned (Mon spaghetti 1/3, Tue chili 2/3, Thu sheet pan 1/3, Fri haystacks 1/3, Sat minestrone 1/2).
-- Only rows that have no recipe and no shares yet are touched; no prices are changed.
with sp as (select '7fcca8a3-ebab-492d-b117-d3f5d9cca25f' r), ch as (select '64a506fa-7f31-4421-b211-b711a2a6ab6f' r),
     sh as (select '18339593-38eb-4d0d-9abe-fcb9703713b4' r), hy as (select 'e0b33fbb-be0d-436c-befc-7cb07fd648f1' r),
     mi as (select 'b4028be0-03f4-4a3f-b203-354c4f73b854' r),
v(id, shares) as (values
  -- "1/3 Fri, rest into Sat minestrone"
  ('b9635c10-b17d-4a21-abbb-4c7fdaa7d837', jsonb_build_array(jsonb_build_object('recipe_id', (select r from hy), 'share', 0.3333), jsonb_build_object('recipe_id', (select r from mi), 'share', 0.6667))),
  -- chicken thighs: "Tue chili ~2/3 lb + Thu sheet pan" (rest of the 1.33 lb pack)
  ('d1f853eb-7d8e-44a9-814b-94824c6fdfed', jsonb_build_array(jsonb_build_object('recipe_id', (select r from ch), 'share', 0.5), jsonb_build_object('recipe_id', (select r from sh), 'share', 0.5))),
  -- carrots: sheet pan 1/2 cup x 1/3; minestrone (1 cup + carrots for the celery) x 1/2
  ('5f83da7a-725c-4743-b732-6431d533b4d0', jsonb_build_array(jsonb_build_object('recipe_id', (select r from sh), 'share', 0.16), jsonb_build_object('recipe_id', (select r from mi), 'share', 0.84))),
  -- 14.5 oz broth: "Tue chili + Fri haystacks" = 1.17 cups + 0.67 cups
  ('de0ee56b-ab94-47d8-b6e2-b69a9e675396', jsonb_build_array(jsonb_build_object('recipe_id', (select r from ch), 'share', 0.64), jsonb_build_object('recipe_id', (select r from hy), 'share', 0.36))),
  -- crushed tomatoes: "half Mon, half Sat"
  ('81616420-3421-475d-8711-b09d888ee084', jsonb_build_array(jsonb_build_object('recipe_id', (select r from sp), 'share', 0.5), jsonb_build_object('recipe_id', (select r from mi), 'share', 0.5))),
  -- frozen green beans: minestrone only (1 1/2 cups x 1/2)
  ('3a07fa71-9923-488c-8c40-c3f27db8d1ac', jsonb_build_array(jsonb_build_object('recipe_id', (select r from mi), 'share', 1))),
  -- garlic: spaghetti 2 x 1/3, sheet pan 4 x 1/3, minestrone 3 x 1/2 cloves (chili uses garlic powder)
  ('077f01bf-458b-4a12-9143-e4a488154d99', jsonb_build_array(jsonb_build_object('recipe_id', (select r from sp), 'share', 0.19), jsonb_build_object('recipe_id', (select r from sh), 'share', 0.38), jsonb_build_object('recipe_id', (select r from mi), 'share', 0.43))),
  -- cumin: chili 1 tsp x 2/3, haystacks 1 1/2 tsp x 1/3
  ('8ba189ca-c7b8-4ee4-ae66-b383d370bc5b', jsonb_build_array(jsonb_build_object('recipe_id', (select r from ch), 'share', 0.57), jsonb_build_object('recipe_id', (select r from hy), 'share', 0.43))),
  -- ground turkey: "1/2 lb Mon + 1/2 lb Fri"
  ('859ef8bc-0ea1-47e1-831c-4ae5eece2a27', jsonb_build_array(jsonb_build_object('recipe_id', (select r from sp), 'share', 0.5), jsonb_build_object('recipe_id', (select r from hy), 'share', 0.5))),
  -- rice: served with Thu sheet pan and Fri haystacks, 2 plates each
  ('1e45adae-4f07-4037-83dd-d8b72bce9398', jsonb_build_array(jsonb_build_object('recipe_id', (select r from sh), 'share', 0.5), jsonb_build_object('recipe_id', (select r from hy), 'share', 0.5))),
  -- mozzarella: "spaghetti + toppings": 1/4 cup in the spaghetti, the other 1/4 cup topping Tue chili and Fri haystacks
  ('698c824f-cddd-4df6-8dfc-d6cc19e824d4', jsonb_build_array(jsonb_build_object('recipe_id', (select r from sp), 'share', 0.5), jsonb_build_object('recipe_id', (select r from ch), 'share', 0.25), jsonb_build_object('recipe_id', (select r from hy), 'share', 0.25))),
  -- sour cream: chili (1 cup + 1/2 cup for the cream) x 2/3 = 1 cup, haystacks topping 1/4 cup
  ('0b191d9b-9ada-4a1f-9110-8c0ef51b865c', jsonb_build_array(jsonb_build_object('recipe_id', (select r from ch), 'share', 0.8), jsonb_build_object('recipe_id', (select r from hy), 'share', 0.2))),
  -- spaghetti: 4 oz Mon, ~2 oz broken into the minestrone
  ('1c4a37e1-3ec0-40d5-8f09-6f5a4ac2c677', jsonb_build_array(jsonb_build_object('recipe_id', (select r from sp), 'share', 0.6667), jsonb_build_object('recipe_id', (select r from mi), 'share', 0.3333))),
  -- tomato sauce: 1/3 can Fri, "rest into minestrone"
  ('6aa2dfdc-4a67-46d8-b4be-3dd2059f66ec', jsonb_build_array(jsonb_build_object('recipe_id', (select r from hy), 'share', 0.3333), jsonb_build_object('recipe_id', (select r from mi), 'share', 0.6667))),
  -- yellow onion: chili 1/3 cup, sheet pan 1/3 onion (yellow for red), minestrone 1/4 cup
  ('a75b6668-0c9d-44c2-8bb9-b372a15d7831', jsonb_build_array(jsonb_build_object('recipe_id', (select r from ch), 'share', 0.36), jsonb_build_object('recipe_id', (select r from sh), 'share', 0.36), jsonb_build_object('recipe_id', (select r from mi), 'share', 0.28)))
)
update public.shopping_list_items i set meal_shares = v.shares
from v
where i.id = v.id::uuid
  and i.week_id = '001bb4a2-49bc-4d33-9dbd-86ab07133c7c'
  and i.recipe_id is null and i.meal_shares is null
  and coalesce(i.source, 'dinner') = 'dinner';
