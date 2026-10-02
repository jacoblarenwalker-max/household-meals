-- 10_meal_ingredient_costs: portion-based cost of each planned dinner.
-- One row per (week, recipe, ingredient): the verified package price, the
-- package size, the amount the recipe uses at the planned batch size, and the
-- resulting cost of just that amount. Lives apart from shopping_list_items so
-- it survives list rebuilds and never changes the list's own prices/totals.
create table public.meal_ingredient_costs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  week_id uuid not null references public.weeks(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  ingredient text not null,
  amount_used numeric,
  amount_unit text,
  package text,
  package_size numeric,
  package_unit text,
  package_price_cents integer check (package_price_cents is null or package_price_cents >= 0),
  price_source text,
  used_fraction numeric check (used_fraction is null or used_fraction >= 0),
  cost_cents numeric check (cost_cents is null or cost_cents >= 0),
  estimated boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (week_id, recipe_id, ingredient)
);
comment on table public.meal_ingredient_costs is
  'Portion-based dinner cost. cost_cents = package_price_cents * used_fraction, where used_fraction = amount used at the planned batch size / package size. used_fraction null = package size unknown: cost_cents is the full price (or the meal_shares split of it) and estimated = true, shown as "~" in the app. Shopping list prices are not affected.';
comment on column public.meal_ingredient_costs.used_fraction is 'Share of the package this recipe uses (amount_used / package_size, unit-converted). Null when the package size is unknown.';
comment on column public.meal_ingredient_costs.cost_cents is 'Cost of the amount used, in (fractional) cents. Null when there is no verified price.';
create index meal_ingredient_costs_week_idx on public.meal_ingredient_costs (week_id, recipe_id);
create index meal_ingredient_costs_household_idx on public.meal_ingredient_costs (household_id);
create index meal_ingredient_costs_recipe_idx on public.meal_ingredient_costs (recipe_id);
create trigger meal_ingredient_costs_set_updated_at before update on public.meal_ingredient_costs
  for each row execute function private.set_updated_at();
alter table public.meal_ingredient_costs enable row level security;
create policy meal_ingredient_costs_select on public.meal_ingredient_costs
  for select to authenticated using ((select private.is_week_member(week_id)));
revoke all on public.meal_ingredient_costs from anon, authenticated;
grant select on public.meal_ingredient_costs to authenticated;

-- Backfill Oct 5-11, 2026 (household 733cd381..., week 001bb4a2...).
-- Prices: verified walmart.com online prices checked 2026-10-02 (list rows or a
-- walmart.com search for pantry items not on the list). Sizes from the product
-- listing; garlic bulb has no listed clove count, so it is estimated (~).
with pk(k, package, package_size, package_unit, price_cents, price_source) as (values
  ('onion', 'Fresh Whole Yellow Onion, each ($0.60; list buys 2)', 1, 'onion', 60, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('garlic', 'Garlic Bulb Fresh Whole, each (cloves per bulb not listed)', null, null, 64, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('carrots', 'Fresh Produce Baby Peeled Carrots, 1 lb bag', 16, 'oz', 132, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('broccoli', 'Fresh Whole Green Broccoli Crowns, 1 each', 1, 'crown', 192, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('lemon', 'Fresh Bulk Yellow Lemons, each (juice of 1 lemon = 48 g, USDA)', 1, 'lemon', 60, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('thighs', 'Marketside Boneless Skinless Chicken Thighs, 1.33 lb at $3.87/lb', 1.33, 'lb', 515, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('turkey', 'FESTIVE Ground Turkey, frozen 1 lb roll', 1, 'lb', 198, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('corn', 'Great Value Whole Kernel Corn, 12 oz bag (frozen)', 12, 'oz', 98, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('greenbeans', 'Great Value Cut Green Beans, 12 oz bag (frozen)', 12, 'oz', 98, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('sourcream', 'Great Value Original Sour Cream, 16 oz tub', 16, 'oz', 184, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('creamcheese', 'Great Value Neufchatel Cheese Brick, 8 oz block', 8, 'oz', 156, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('mozz', 'Great Value Low-Moisture Part-Skim Mozzarella Shredded, 8 oz bag', 8, 'oz', 197, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('gnbeans', 'Great Value Great Northern Beans, 15.5 oz can x2', 2, 'cans', 184, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('blackbeans', 'Great Value Black Beans, 15 oz can', 1, 'can', 92, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('chiles', 'Great Value Medium Diced Green Chiles, 7 oz can', 7, 'oz', 147, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('tomsauce', 'Great Value Tomato Sauce, 8 oz can', 1, 'can', 53, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('crushed', 'Great Value Crushed Tomatoes, 28 oz can', 28, 'oz', 172, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('brothcan', 'Great Value Chicken Broth, 14.5 oz can (about 1.83 cups)', 1.83, 'cups', 87, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('brothcarton', 'Great Value Reduced Sodium Chicken Broth, 32 oz carton (4 cups)', 4, 'cups', 154, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('spaghetti', 'Great Value Spaghetti, 16 oz box', 16, 'oz', 100, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('rice', 'Great Value Long Grain Enriched Rice, 16 oz bag', 16, 'oz', 96, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('soy', 'Great Value Less Sodium Soy Sauce, 15 fl oz bottle', 15, 'fl oz', 182, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('honey', 'Great Value Honey, 12 oz bear', 12, 'oz', 372, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('chilipowder', 'Great Value Chili Powder, 3 oz', 3, 'oz', 108, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('cumin', 'Great Value Ground Cumin, 2.5 oz', 2.5, 'oz', 137, 'on this week''s shopping list (walmart.com online price, no store selected, checked 2026-10-02)'),
  ('vegoil', 'Great Value Vegetable Oil, 48 fl oz', 48, 'fl oz', 400, 'walmart.com online price, search "great value vegetable oil 48 fl oz", no store selected, checked 2026-10-02'),
  ('oliveoil', 'Great Value Extra Virgin Olive Oil, 17 fl oz', 17, 'fl oz', 612, 'walmart.com online price, search "great value extra virgin olive oil", no store selected, checked 2026-10-02'),
  ('salt', 'Great Value Iodized Salt, 26 oz', 26, 'oz', 94, 'walmart.com online price, search "great value iodized salt 26 oz", no store selected, checked 2026-10-02 (single from the 12-pack listing)'),
  ('pepper', 'Great Value Ground Black Pepper, 3 oz', 3, 'oz', 358, 'walmart.com online price, search "great value ground black pepper", no store selected, checked 2026-10-02'),
  ('oregano', 'Great Value Oregano Leaves, 0.87 oz', 0.87, 'oz', 108, 'walmart.com online price, search "great value dried oregano leaves", no store selected, checked 2026-10-02'),
  ('basil', 'Great Value Basil Leaves, 0.8 oz', 0.8, 'oz', 108, 'walmart.com online price, search "great value basil leaves", no store selected, checked 2026-10-02'),
  ('thyme', 'Great Value Thyme Leaves, 0.75 oz', 0.75, 'oz', 212, 'walmart.com online price, search "great value thyme leaves", no store selected, checked 2026-10-02'),
  ('garlicpowder', 'Great Value Garlic Powder, 3.4 oz', 3.4, 'oz', 108, 'walmart.com online price, search "great value garlic powder", no store selected, checked 2026-10-02'),
  ('paprika', 'Great Value Paprika, 2.5 oz', 2.5, 'oz', 108, 'walmart.com online price, search "great value paprika", no store selected, checked 2026-10-02'),
  ('onionpowder', 'Great Value Onion Powder, 3.25 oz', 3.25, 'oz', 108, 'walmart.com online price, search "great value onion powder", no store selected, checked 2026-10-02'),
  ('flour', 'Great Value All-Purpose Flour, 5 lb bag', 5, 'lb', 197, 'walmart.com online price, search "great value all purpose flour 5 lb", no store selected, checked 2026-10-02'),
  ('redpepper', 'Great Value Crushed Red Pepper, 1.75 oz', 1.75, 'oz', 144, 'walmart.com online price, search "great value crushed red pepper", no store selected, checked 2026-10-02')
), rc(k, recipe_id) as (values
  ('SP', '7fcca8a3-ebab-492d-b117-d3f5d9cca25f'::uuid),
  ('CH', '64a506fa-7f31-4421-b211-b711a2a6ab6f'::uuid),
  ('SH', '18339593-38eb-4d0d-9abe-fcb9703713b4'::uuid),
  ('HY', 'e0b33fbb-be0d-436c-befc-7cb07fd648f1'::uuid),
  ('MI', 'b4028be0-03f4-4a3f-b203-354c4f73b854'::uuid)
), u(rk, ingredient, amount_used, amount_unit, pkk, used_fraction, cost_cents, estimated, note) as (values
  ('SP', 'Ground turkey', 0.5, 'lb', 'turkey', 0.5, 99.0, false, null),
  ('SP', 'Garlic', 0.67, 'cloves', 'garlic', null, 12.16, true, 'package size unknown: full price, 19% of the bulb counted here'),
  ('SP', 'Red pepper flakes', 0.333, 'pinch', 'redpepper', 0.00076, 0.11, false, 'pinch = 1/16 tsp'),
  ('SP', 'Dried oregano', 0.17, 'tsp', 'oregano', 0.00676, 0.73, false, null),
  ('SP', 'Dried basil', 0.17, 'tsp', 'basil', 0.00514, 0.56, false, null),
  ('SP', 'Dried thyme', 0.08, 'tsp', 'thyme', 0.00392, 0.83, false, null),
  ('SP', 'Spaghetti', 4, 'oz', 'spaghetti', 0.25, 25.0, false, null),
  ('SP', 'Crushed tomatoes', 14, 'oz', 'crushed', 0.5, 86.0, false, 'half the 28 oz can'),
  ('SP', 'Salt', 0.5, 'tsp', 'salt', 0.00407, 0.38, false, null),
  ('SP', 'Black pepper', 0.17, 'tsp', 'pepper', 0.00451, 1.61, false, null),
  ('SP', 'Light cream cheese', 1.33, 'oz', 'creamcheese', 0.16625, 25.94, false, null),
  ('SP', 'Shredded mozzarella', 0.25, 'cup', 'mozz', 0.12346, 24.32, false, '1/6 cup plus a little extra instead of Parmesan'),
  ('CH', 'Vegetable oil', 0.67, 'tbsp', 'vegoil', 0.00694, 2.78, false, null),
  ('CH', 'Chicken thighs', 0.67, 'lb', 'thighs', 0.5, 257.5, false, 'half the 1.33 lb pack (thighs instead of breasts)'),
  ('CH', 'Onion', 0.33, 'cup', 'onion', 0.48485, 29.09, false, null),
  ('CH', 'Garlic powder', 1, 'tsp', 'garlicpowder', 0.03216, 3.47, false, null),
  ('CH', 'Great Northern beans', 2, 'cans', 'gnbeans', 1, 184, false, 'both cans'),
  ('CH', 'Chicken broth', 1.17, 'cups', 'brothcan', 0.63752, 55.46, false, null),
  ('CH', 'Diced green chiles', 5.33, 'oz', 'chiles', 0.76143, 111.93, false, null),
  ('CH', 'Salt', 0.67, 'tsp', 'salt', 0.00543, 0.51, false, null),
  ('CH', 'Ground cumin', 0.67, 'tsp', 'cumin', 0.01975, 2.71, false, null),
  ('CH', 'Dried oregano', 0.67, 'tsp', 'oregano', 0.02703, 2.92, false, null),
  ('CH', 'Black pepper', 0.33, 'tsp', 'pepper', 0.00901, 3.23, false, null),
  ('CH', 'Sour cream', 1, 'cup', 'sourcream', 0.50706, 93.3, false, 'includes the sour cream used instead of heavy cream'),
  ('CH', 'Shredded mozzarella (topping)', 0.125, 'cup', 'mozz', 0.06173, 12.16, false, null),
  ('SH', 'Broccoli', 1, 'crown', 'broccoli', 1, 192, false, 'whole crown, also replaces the bell pepper'),
  ('SH', 'Yellow onion', 0.333, 'onion', 'onion', 0.33333, 20.0, false, 'yellow instead of red'),
  ('SH', 'Carrots', 0.17, 'cup', 'carrots', 0.04703, 6.21, false, null),
  ('SH', 'Chicken thighs', 0.67, 'lb', 'thighs', 0.5, 257.5, false, 'rest of the 1.33 lb pack'),
  ('SH', 'Rice', 0.625, 'cup dry', 'rice', 0.25491, 24.47, false, 'half the list''s 1 1/4 cups (shared with Fri)'),
  ('SH', 'Olive oil', 1, 'tbsp', 'oliveoil', 0.02941, 18.0, false, null),
  ('SH', 'Low-sodium soy sauce', 1, 'tbsp', 'soy', 0.03333, 6.07, false, null),
  ('SH', 'Honey', 0.5, 'tbsp', 'honey', 0.03086, 11.48, false, null),
  ('SH', 'Lemon juice', 0.33, 'tsp', 'lemon', 0.03542, 2.12, false, null),
  ('SH', 'Garlic', 1.33, 'cloves', 'garlic', null, 24.32, true, 'package size unknown: full price, 38% of the bulb counted here'),
  ('SH', 'Salt', 0.08, 'tsp', 'salt', 0.00068, 0.06, false, 'table salt, half the kosher amount'),
  ('SH', 'Dried oregano', 0.08, 'tsp', 'oregano', 0.00338, 0.36, false, null),
  ('SH', 'Dried basil', 0.08, 'tsp', 'basil', 0.00257, 0.28, false, null),
  ('SH', 'Black pepper', 0.333, 'pinch', 'pepper', 0.00056, 0.2, false, 'pinch = 1/16 tsp'),
  ('HY', 'Ground turkey (cooked Monday)', 0.5, 'lb', 'turkey', 0.5, 99.0, false, null),
  ('HY', 'Salt', 0.33, 'tsp', 'salt', 0.00271, 0.26, false, null),
  ('HY', 'Black pepper', 0.17, 'tsp', 'pepper', 0.00451, 1.61, false, null),
  ('HY', 'Paprika', 0.17, 'tsp', 'paprika', 0.00541, 0.58, false, null),
  ('HY', 'Chili powder', 1, 'tsp', 'chilipowder', 0.03175, 3.43, false, null),
  ('HY', 'Ground cumin', 0.5, 'tsp', 'cumin', 0.01482, 2.03, false, null),
  ('HY', 'Onion powder', 0.17, 'tsp', 'onionpowder', 0.00434, 0.47, false, null),
  ('HY', 'Dried oregano', 0.17, 'tsp', 'oregano', 0.00676, 0.73, false, null),
  ('HY', 'Garlic powder', 0.08, 'tsp', 'garlicpowder', 0.00268, 0.29, false, null),
  ('HY', 'All-purpose flour', 0.083, 'cup', 'flour', 0.00459, 0.9, false, null),
  ('HY', 'Chicken broth', 0.67, 'cup', 'brothcan', 0.3643, 31.69, false, 'instead of beef broth'),
  ('HY', 'Tomato sauce', 0.333, 'can', 'tomsauce', 0.33333, 17.67, false, null),
  ('HY', 'Black beans', 0.333, 'can', 'blackbeans', 0.33333, 30.67, false, null),
  ('HY', 'Frozen corn', 0.33, 'cup', 'corn', 0.13326, 13.06, false, null),
  ('HY', 'Rice', 0.625, 'cup dry', 'rice', 0.25491, 24.47, false, 'half the list''s 1 1/4 cups (shared with Thu)'),
  ('HY', 'Sour cream (topping)', 0.25, 'cup', 'sourcream', 0.12677, 23.32, false, null),
  ('HY', 'Shredded mozzarella (topping)', 0.125, 'cup', 'mozz', 0.06173, 12.16, false, null),
  ('MI', 'Olive oil', 0.5, 'tbsp', 'oliveoil', 0.01471, 9.0, false, null),
  ('MI', 'Onion', 0.25, 'cup', 'onion', 0.36364, 21.82, false, null),
  ('MI', 'Carrots', 0.875, 'cup', 'carrots', 0.24692, 32.59, false, 'includes extra carrots instead of celery'),
  ('MI', 'Frozen green beans', 0.75, 'cup', 'greenbeans', 0.26676, 26.14, false, null),
  ('MI', 'Garlic', 1.5, 'cloves', 'garlic', null, 27.52, true, 'package size unknown: full price, 43% of the bulb counted here'),
  ('MI', 'Dried basil', 0.5, 'tsp', 'basil', 0.01543, 1.67, false, null),
  ('MI', 'Salt', 0.5, 'tsp', 'salt', 0.00407, 0.38, false, null),
  ('MI', 'Dried oregano', 0.25, 'tsp', 'oregano', 0.01014, 1.09, false, null),
  ('MI', 'Black pepper', 0.125, 'tsp', 'pepper', 0.00338, 1.21, false, null),
  ('MI', 'Crushed tomatoes', 14, 'oz', 'crushed', 0.5, 86.0, false, 'rest of the 28 oz can'),
  ('MI', 'Tomato sauce (left from Fri)', 0.667, 'can', 'tomsauce', 0.66667, 35.33, false, null),
  ('MI', 'Low-sodium chicken broth', 3, 'cups', 'brothcarton', 0.75, 115.5, false, null),
  ('MI', 'Black beans (left from Fri)', 0.667, 'can', 'blackbeans', 0.66667, 61.33, false, 'instead of white beans'),
  ('MI', 'Spaghetti, broken up', 2, 'oz', 'spaghetti', 0.125, 12.5, false, 'instead of small pasta')
)
insert into public.meal_ingredient_costs
  (household_id, week_id, recipe_id, ingredient, amount_used, amount_unit, package, package_size,
   package_unit, package_price_cents, price_source, used_fraction, cost_cents, estimated, note)
select '733cd381-babb-490c-863f-ee16ee942ad4'::uuid, '001bb4a2-49bc-4d33-9dbd-86ab07133c7c'::uuid,
       rc.recipe_id, u.ingredient, u.amount_used, u.amount_unit, pk.package, pk.package_size,
       pk.package_unit, pk.price_cents, pk.price_source, u.used_fraction, u.cost_cents, u.estimated, u.note
from u join rc on rc.k = u.rk join pk on pk.k = u.pkk;
