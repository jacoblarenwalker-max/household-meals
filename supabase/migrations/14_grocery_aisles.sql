-- Grocery aisles: the 17 aisle categories used by Shopping, Staples and presets (see categorize.js).
-- Data only (category is free text): map old names onto the new list and re-sort existing rows with the
-- same dictionary the app uses. Frozen products stay Frozen (e.g. the frozen ground turkey roll).

-- 1) staples
update public.staples set category = 'Dairy & Eggs' where id in ('d8442b72-37fe-435c-b2f9-7107166f4100', 'e693b7e1-c685-41b6-900e-e8755b395395'); -- Milk, Eggs
update public.staples set category = 'Produce' where id = '724787de-c361-4833-a1a4-c4593fcf2fb0'; -- Fruit

-- 2) shopping list rows: re-sorted by name (Oct 5-11 week)
update public.shopping_list_items set category = 'Dairy & Eggs' where week_id = '001bb4a2-49bc-4d33-9dbd-86ab07133c7c' and name in ('Shredded mozzarella', 'Milk', 'Eggs- 16 count', 'Light cream cheese', 'Sour cream');
update public.shopping_list_items set category = 'Canned Goods' where week_id = '001bb4a2-49bc-4d33-9dbd-86ab07133c7c' and name in ('Black beans', 'Crushed tomatoes', 'Great Northern beans', 'Low-sodium chicken broth', 'Tomato sauce', 'Diced green chiles', 'Chicken broth');
update public.shopping_list_items set category = 'Condiments & Spices' where week_id = '001bb4a2-49bc-4d33-9dbd-86ab07133c7c' and name in ('Low-sodium soy sauce', 'Chili powder', 'Ground cumin');
update public.shopping_list_items set category = 'Produce' where week_id = '001bb4a2-49bc-4d33-9dbd-86ab07133c7c' and name in ('Fruit');

-- 3) any other rows still using an old name (other weeks, staples, ingredient lists)
update public.staples set category = 'Dairy & Eggs' where category = 'Dairy';
update public.shopping_list_items set category = 'Dairy & Eggs' where category = 'Dairy';
update public.staples set category = 'Bakery & Bread' where category = 'Bakery';
update public.shopping_list_items set category = 'Bakery & Bread' where category = 'Bakery';
update public.staples set category = 'Condiments & Spices' where category = 'Spices';
update public.shopping_list_items set category = 'Condiments & Spices' where category = 'Spices';
update public.staples set category = 'Breakfast & Cereal' where category = 'Breakfast basics';
update public.shopping_list_items set category = 'Breakfast & Cereal' where category = 'Breakfast basics';
update public.staples set category = 'Household & Cleaning' where category = 'Household';
update public.shopping_list_items set category = 'Household & Cleaning' where category = 'Household';
update public.meal_plan_items set ingredients = (select coalesce(jsonb_agg(case when i ? 'category' and i->>'category' in ('Dairy','Bakery','Spices','Breakfast basics','Household') then jsonb_set(i, '{category}', to_jsonb(case i->>'category' when 'Dairy' then 'Dairy & Eggs' when 'Bakery' then 'Bakery & Bread' when 'Spices' then 'Condiments & Spices' when 'Breakfast basics' then 'Breakfast & Cereal' else 'Household & Cleaning' end)) else i end order by n), '[]'::jsonb) from jsonb_array_elements(ingredients) with ordinality as x(i, n)) where jsonb_typeof(ingredients) = 'array' and ingredients::text ~ '"category": "(Dairy|Bakery|Spices|Breakfast basics|Household)"';
update public.meal_presets set ingredients = (select coalesce(jsonb_agg(case when i ? 'category' and i->>'category' in ('Dairy','Bakery','Spices','Breakfast basics','Household') then jsonb_set(i, '{category}', to_jsonb(case i->>'category' when 'Dairy' then 'Dairy & Eggs' when 'Bakery' then 'Bakery & Bread' when 'Spices' then 'Condiments & Spices' when 'Breakfast basics' then 'Breakfast & Cereal' else 'Household & Cleaning' end)) else i end order by n), '[]'::jsonb) from jsonb_array_elements(ingredients) with ordinality as x(i, n)) where jsonb_typeof(ingredients) = 'array' and ingredients::text ~ '"category": "(Dairy|Bakery|Spices|Breakfast basics|Household)"';
