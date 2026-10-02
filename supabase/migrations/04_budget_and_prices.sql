-- Monthly grocery budget + Walmart product links for verified prices.
alter table public.households
  add column monthly_budget_cents integer not null default 35000
  check (monthly_budget_cents >= 0 and monthly_budget_cents <= 10000000);

alter table public.shopping_list_items
  add column walmart_product_url text
  check (walmart_product_url is null or walmart_product_url ~* '^https://www\.walmart\.com/');

-- staples can carry a verified price that is copied onto the list when the staple is added
alter table public.staples
  add column price_cents integer check (price_cents is null or price_cents >= 0),
  add column price_source text check (price_source is null or length(price_source) <= 1000),
  add column price_verified_at timestamptz,
  add column walmart_product_url text
  check (walmart_product_url is null or walmart_product_url ~* '^https://www\.walmart\.com/');
