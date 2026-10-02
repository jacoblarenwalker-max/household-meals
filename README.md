# Household Meals

A small, phone-first web app for a two-person household to plan dinners, vote on each week's plan,
plan simple breakfasts and lunches,
keep a list of staples, manage recipes, and work through the Walmart shopping list. It is a plain static site
(HTML/CSS/JS, [supabase-js](https://github.com/supabase/supabase-js) loaded from jsDelivr) hosted on GitHub Pages and
backed by a Supabase project.

## Screens

- **This week**: pick a week (weeks start Monday, America/Denver). Each night shows the dinner name, a one-line
  description in muted text (`recipes.description`, skipped on leftover nights), then a leftover pill and the plate
  count. Tap the dinner name for its **Cooking notes** (the bot's `week_slots.notes`: batch size, swaps, what to save
  for later) with **Open recipe ↗** and **Recipe details** links. Each cooked dinner also gets a small beige **cost tag** (e.g. `$7.59`): what
  the **amount that meal actually uses** costs, not the whole package (a meal that uses ½ tbsp of honey counts
  about $0.11 of the $3.72 bottle). It comes from table `meal_ingredient_costs` (one row per week, recipe and
  ingredient, every ingredient including pantry items like oil, soy sauce, honey, spices and garlic):
  `cost_cents = package_price_cents ÷ package_size × amount used at the planned batch size`, stored as
  `used_fraction` (share of the package) and `cost_cents` (fractional cents), plus `amount_used`/`amount_unit`,
  `package`/`package_size`/`package_unit`, `price_source` and `note`. Prices are verified walmart.com prices (the
  list row's `price_cents`, or a walmart.com lookup for pantry items not on the list); the package size comes from the
  product's walmart.com size or the list row and is never guessed. If the size is unknown (e.g. cloves in a garlic
  bulb) the row counts the full price (split by the list row's `meal_shares` when it's shared), sets
  `used_fraction = null` and `estimated = true`, and the tag reads `~$X`; a row with no price adds `+`. Because it's
  its own table (not columns on the list rows), it survives list rebuilds; the meal bot should write these rows
  (service role; members can only read them) whenever it plans or changes a week's dinners. A muted line under the
  dinners shows the difference: `Store total $38.98 · meals use ~$22.93` (store total = verified prices of the
  week's dinner rows, i.e. what you pay at the store; the rest stays in the pantry). Dinners with no
  `meal_ingredient_costs` rows fall back to whole-package list costs, shown as `~$X`: a dinner row with
  `recipe_id` counts fully toward that recipe, and a row shared by several dinners carries `meal_shares`
  (`[{"recipe_id": …, "share": 0.5}, …]`, fractions of its price) and is split that way; shared dinner rows not tied
  to a planned dinner are then summed in a small note. The shopping list's own prices and totals never change.
  Leftover nights show no price, so nothing is counted twice. The meal bot's dinner-list rebuild should set
  `meal_shares` on the shared rows it writes. The page also shows the week's status (draft / voting / needs work / locked), each
  voter's vote and comment, and who still needs to vote. You can **Approve** or mark **Needs work** with a comment.
  Voting is disabled once the week is locked. The database decides when a week locks (every voter approves in
  `multi` mode).
  - **Swap** (under each dinner's date): opens a searchable list of the household's **favorite** dinners
    (`recipes.is_favorite`), most often / most recently planned first, and one tap puts that recipe in the slot.
    Swapping is a member edit of `week_slots`, so a database trigger (`week_slots_after_user_change`) reopens the
    vote: a locked week goes back to voting (the app asks to confirm first), every approve vote for that week is
    cleared (needs-work comments stay), and the week locks again only when every voter approves (multi mode). The
    same trigger removes unchecked dinner rows (`source` null or `dinner`) for a recipe no longer in the week and
    writes a `check_now` app_event (`payload.source = 'dinner_swap'`) so the meal bot rebuilds the dinner part of the
    list. Breakfast, lunch, staple, manual and preset rows are never touched. Meal bot writes (non-`authenticated`
    roles) don't fire it.
  - **Breakfast & lunch**: one simple line per day for each (table `meal_plan_items`). Tap a line to pick a saved
    **preset** in one tap (optionally "Fill whole week"), or type something else (free text, optional recipe link and
    ingredient lines). No voting, and editable even when the week is locked. Preset ingredients are per day and are
    summed across the days they're picked, then written as consolidated `shopping_list_items` rows with
    `preset_generated = true` (rebuilt whenever picks change; names already on the list from other sources are skipped).
    Free-text ingredient lines land with `source = 'breakfast' | 'lunch'` and `meal_plan_item_id`.
  - If a week has no plan yet, **Start planning this week** creates a draft week so breakfasts/lunches can be added.
  - A slim **monthly budget bar** shows priced list totals for weeks starting in that month against the budget.
- **Shopping**: the selected week's list grouped by aisle/category, with dinner, breakfast/lunch and staple items
  together and a small source label. Check items off, add or remove items. Prices only show when the row has both
  `price_cents` and `price_source`; the product line links to `walmart_product_url` when set. Shows the week's total
  and the monthly budget bar. Names are short (`Sour cream`); any detail lives in `shopping_list_items.note` and shows
  as one small muted line under the name (tap it to see all of it). An item without a verified price shows a muted
  **Pricing…** tag (a `needs_price` request is waiting) or **Unpriced** where the price would be.
- **Staples**: snacks, drinks, breakfast basics and household items bought outside of meals (table `staples`), grouped by
  category. Add / edit / remove, check the ones you want, then **Add N checked to list** (or **Add** per item). Adds go
  to the selected week's list (Walmart) with `source = 'staple'`, copying the staple's price fields if it has them; a
  staple is never added twice to the same week.
  - **Weekly staples**: tap ☆ on a staple (or tick **★ Weekly** in its form) to set `staples.is_weekly`. The
    **Every week** card at the top has one big **Add weekly staples (N)** button (N = weekly staples not on the
    selected week's list yet) that adds them all at once as `source = 'staple'` rows with their prices, skipping any
    already on the list (same staple or same name), then shows "Added N staples" with **Undo** and refreshes the
    budget bar. Undo, or tapping a staple's green **✓ On list** chip, takes only that unchecked staple row back off
    the list. `is_weekly` is separate from the per-item checkbox (`active`), which still drives **Add N checked to
    list**. Milk and eggs start out weekly. Staple rows are never removed by dinner rebuilds (only `source` null or
    `dinner` rows are).
  - On **Shopping**, a beige reminder card near the top lists weekly staples that aren't on the selected week's list
    yet ("2 weekly staples aren't on the list: Milk, Eggs- 16 count") with **Add them** (same logic as Add weekly
    staples: no duplicates, toast with Undo, budget and week total update) and a **See all staples** link. Once
    they're all on the list it shrinks to a small "✓ Weekly staples added" line; with no weekly staples it's hidden.
- **Recipes**: search, add and edit household recipes, including a **Short description** (`recipes.description`, one
  plain line under ~60 characters, max 120) that This week shows under the dinner name. Tap the ☆ star on a recipe (or **Add to favorites** on its
  page or in the Swap picker) to make it a go-to dinner.
- **Settings**: dinners per week, leftover nights, default plates, approval mode, dietary exclusions, preferred
  stores, **monthly grocery budget** (`households.monthly_budget_cents`, default $350), and a link to
  **Breakfast & lunch presets** (`#/presets`: add/edit/delete presets with per-day ingredients). Also lists members,
  **Notifications** (below), and lets you sign out.
- **Notifications** (Web Push, Settings → Notifications): **Turn on notifications** asks for permission, subscribes
  this browser with the app's VAPID public key (`config.js`) and saves the subscription in `push_subscriptions`
  (RLS: each user only sees and changes their own rows). **Send a test notification** pushes to your own devices;
  **Turn off on this device** unsubscribes and deletes the row (signing out does the same). Notifications go out for:
  a dinner **swap** on a week that isn't a draft (not to the person who swapped), **needs work** (not to the voter),
  and **week locked** (not to the last approver). Tapping one opens `./?week=YYYY-MM-DD#/week`.
  - iPhone/iPad: needs iOS/iPadOS 16.4+. In Safari, Share → **Add to Home Screen**, open **Meals** from the Home
    Screen, sign in, then Settings → Turn on notifications → Allow. (Safari tabs can't receive web push.)
  - How it's wired: an AFTER INSERT trigger on `app_events` (`private.app_events_push_notify`) calls the Edge Function
    `push-notify` through `pg_net` with a shared secret from Supabase Vault (`push_webhook_secret`). The function
    (`supabase/functions/push-notify/`, plain WebCrypto, no paid services) signs VAPID JWTs and encrypts payloads
    (RFC 8291 aes128gcm) with the private key kept in Vault (`push_vapid_private_jwk`; created inside Supabase by the
    function's one-time `init`, never stored in the repo). Each event is sent once (`push_notified_events`), and
    subscriptions the push service reports as gone (404/410) are deleted. The trigger never blocks a vote or a swap.
  - `sw.js` is only a push service worker: it shows notifications and handles taps. It doesn't cache anything.
- **Check now** (This week and Shopping screens): inserts an `app_events` row (`check_now`) asking the meal bot to sync.
  Besides the Supabase API, the browser only talks to its own push service when you turn notifications on.

## For the meal bot: names, notes and prices

**Short names + a note.** Write `shopping_list_items.name` as the plain item ("Sour cream", "Chicken thighs",
"Black beans"), at most ~40 characters, with no parentheses, meal lists or can sizes. Put that detail in
`shopping_list_items.note` (≤ 500 chars), e.g. name `Sour cream`, note `Chili (incl. the heavy-cream swap) + haystacks
topping`; `Honey` + `Pantry check: skip if you have some`. Short names also let staples and preset items match
(duplicates are detected by name). The Oct 5–11 rows were cleaned up this way in migration `item_notes_and_unpriced`.

**Every item gets priced.** The household buys the lowest-cost matching option at Walmart (usually Great Value). The
browser can't fetch Walmart prices, so when someone adds an item with no verified price (a manual list item, a
staple, a breakfast/lunch line, a preset ingredient, or a preset-generated list row) the app inserts an `app_events`
row with `event_type = 'needs_price'` and `payload.items = [{"table": "shopping_list_items" | "staples" |
"meal_presets", "id": …, "index": <ingredient index, presets only>, "name": …}]` (plus `week_start`,
`requested_by`, `source: 'web_app'`). It never sends a push notification. The wake routine should handle it like
`check_now`: price each item, then set `processed_at`. "Pricing…" shows while the event is unprocessed (last 14 days).

To price an item: search walmart.com with **no store selected**, pick the cheapest matching product by unit price at a
sensible size for 2 people, and set `price_cents`, `walmart_product_url` (`https://www.walmart.com/ip/…`),
`price_verified_at = now()` and `price_source` like `walmart.com online price, no store selected, lowest-cost option:
Great Value Whole Vitamin D Milk, 1 gallon, https://www.walmart.com/ip/…, checked 2026-10-04`. Never invent a price:
if walmart.com blocks the lookup, leave it unpriced (it stays in the view below and the app shows "Unpriced").
Breakfast/lunch ingredients in `meal_presets.ingredients` / `meal_plan_items.ingredients` carry the same four keys on
each ingredient object; preset rows on the list copy them, and editing a preset keeps a price while the ingredient's
name is unchanged.

**What's still unpriced:** view `public.unpriced_items` (security invoker, so RLS applies; members can read it, anon
can't). One row per unpriced staple, shopping list row, breakfast/lunch ingredient and preset ingredient, with
`kind` (`staple` | `shopping_list_item` | `meal_plan_ingredient` | `preset_ingredient`), `household_id`, `week_id`,
`week_start`, `item_id`, `ingredient_index` (0-based, ingredients only), `name`, `quantity`, `unit`, `category`,
`source`, `note` (list note, or the meal/preset title) and `created_at`. The Sunday price check and the wake routine:

```sql
-- everything to price for the household (skip old weeks)
select * from public.unpriced_items
where household_id = '733cd381-babb-490c-863f-ee16ee942ad4'
  and (week_start is null or week_start >= date_trunc('week', now() at time zone 'America/Denver')::date)
order by kind, week_start nulls first, name;

-- price a staple or list row
update public.shopping_list_items set price_cents = 247, price_source = 'walmart.com online price, no store selected, lowest-cost option: …',
  walmart_product_url = 'https://www.walmart.com/ip/…', price_verified_at = now() where id = '…';

-- price ingredient N of a preset (same pattern for meal_plan_items)
update public.meal_presets set ingredients = jsonb_set(ingredients, '{0}', ingredients->0 || jsonb_build_object(
  'price_cents', 247, 'price_source', 'walmart.com online price, no store selected, lowest-cost option: …',
  'walmart_product_url', 'https://www.walmart.com/ip/…', 'price_verified_at', now())) where id = '…';

-- then mark the request done
update public.app_events set processed_at = now() where event_type = 'needs_price' and processed_at is null and household_id = '…';
```

Schema changes are in `supabase/migrations/` (applied to the project as `add_staples`, `add_meal_plan_items`,
`shopping_list_items_source`, `budget_and_prices`, `meal_presets`, `favorites_and_dinner_swaps`,
`push_and_descriptions`, `recipe_descriptions`, `meal_cost_shares`, `meal_ingredient_costs`, `staples_weekly`, `item_notes_and_unpriced`).

Icons: J+S (Jacob + Sophie) chef-hat lettering on solid baby blue. `icon.svg` (rounded, purpose "any"),
`icon-full.svg` (full-bleed square, source of `apple-touch-icon.png` 180×180; iOS rounds the corners itself) and
`icon-maskable.svg` (full-bleed, art inside the Android safe zone), with PNG exports `icon-192.png`, `icon-512.png`,
`icon-maskable-192.png`, `icon-maskable-512.png` and `favicon-32.png`. Letters are outlined paths (no font needed).
Every reference in `index.html`, `manifest.webmanifest`, `styles.css`, `app.js` and `sw.js` carries `?v=js1`; bump
it when the icon changes so phones fetch the new one. On iPhone, remove the old Home Screen icon and add it again.

Design: bold baby blue + clean white, with warm beige as an accent. Flat, solid fills only (no tints, gradients or
translucency). Tokens live at the top of `styles.css`: baby blue `#4BA3E3` for header bands (top bar, card and aisle
headers), primary buttons, the active tab, today's date block and the Makes-leftovers pill, always with navy
`#0F2747` text (5.5:1); deeper blue `#1B5E96` for links and blue text on white; page `#FAFAF8`, white cards
`#FFFFFF`, borders `#D8D3CA`; beige `#EADFCC` / tan `#DCC9A8` for other date blocks, Leftover pills, price tags and
dividers; ink `#1C2A3F`, slate `#505B6B`. Green `#2D7D5C` = locked/success, brick `#A8432F` = needs work / over
budget. Icon: white J+S with a beige plus and a flat navy shadow, the J wearing a white chef hat, on solid baby blue.

## Security

- `config.js` only has the Supabase URL and the **publishable** key, which is meant to be public.
  All access is enforced by Row Level Security: signed-in members only see their own household.
- No analytics, trackers, or third-party requests except the Supabase API and the supabase-js module from jsDelivr
  (pinned version, restricted by a Content-Security-Policy).

## Local development

Serve the folder with any static server, e.g. `python3 -m http.server`, then open `http://localhost:8000/`.
