# Household Meals

A small, phone-first web app for a two-person household to plan dinners, vote on each week's plan,
plan simple breakfasts and lunches,
keep a list of staples, manage recipes, and work through the Walmart shopping list. It is a plain static site
(HTML/CSS/JS, [supabase-js](https://github.com/supabase/supabase-js) loaded from jsDelivr) hosted on GitHub Pages and
backed by a Supabase project.

## Screens

- **This week**: pick a week (weeks start Monday, America/Denver). Shows each night's dinner with a link to the
  recipe source, plates, and leftover badges, plus the week's status (draft / voting / needs work / locked), each
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
  and the monthly budget bar.
- **Staples**: snacks, drinks, breakfast basics and household items bought outside of meals (table `staples`), grouped by
  category. Add / edit / remove, check the ones you want, then **Add N checked to list** (or **Add** per item). Adds go
  to the selected week's list (Walmart) with `source = 'staple'`, copying the staple's price fields if it has them; a
  staple is never added twice to the same week.
- **Recipes**: search, add and edit household recipes. Tap the ☆ star on a recipe (or **Add to favorites** on its
  page or in the Swap picker) to make it a go-to dinner.
- **Settings**: dinners per week, leftover nights, default plates, approval mode, dietary exclusions, preferred
  stores, **monthly grocery budget** (`households.monthly_budget_cents`, default $350), and a link to
  **Breakfast & lunch presets** (`#/presets`: add/edit/delete presets with per-day ingredients). Also lists members
  and lets you sign out.
- **Check now** (This week and Shopping screens): inserts an `app_events` row (`check_now`) asking the meal bot to sync.
  The browser never calls any other service.

Schema changes are in `supabase/migrations/` (applied to the project as `add_staples`, `add_meal_plan_items`,
`shopping_list_items_source`, `budget_and_prices`, `meal_presets`, `favorites_and_dinner_swaps`).

Icons: `icon.svg` (any), `icon-maskable.svg`, PNG exports `icon-192.png`, `icon-512.png`, `icon-maskable-192.png`,
`icon-maskable-512.png` and `apple-touch-icon.png` (180×180), wired into `index.html` and `manifest.webmanifest`.

Design: bold baby blue + clean white, with warm beige as an accent. Flat, solid fills only (no tints, gradients or
translucency). Tokens live at the top of `styles.css`: baby blue `#4BA3E3` for header bands (top bar, card and aisle
headers), primary buttons, the active tab, today's date block and the Makes-leftovers pill, always with navy
`#0F2747` text (5.5:1); deeper blue `#1B5E96` for links and blue text on white; page `#FAFAF8`, white cards
`#FFFFFF`, borders `#D8D3CA`; beige `#EADFCC` / tan `#DCC9A8` for other date blocks, Leftover pills, price tags and
dividers; ink `#1C2A3F`, slate `#505B6B`. Green `#2D7D5C` = locked/success, brick `#A8432F` = needs work / over
budget. Icon: white bowl with a beige mound and white steam on solid baby blue.

## Security

- `config.js` only has the Supabase URL and the **publishable** key, which is meant to be public.
  All access is enforced by Row Level Security: signed-in members only see their own household.
- No analytics, trackers, or third-party requests except the Supabase API and the supabase-js module from jsDelivr
  (pinned version, restricted by a Content-Security-Policy).

## Local development

Serve the folder with any static server, e.g. `python3 -m http.server`, then open `http://localhost:8000/`.
