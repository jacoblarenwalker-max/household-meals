# Household Meals

A small, phone-first web app for a two-person household to plan dinners, vote on each week's plan,
manage recipes, and work through the Walmart shopping list. It is a plain static site
(HTML/CSS/JS, [supabase-js](https://github.com/supabase/supabase-js) loaded from jsDelivr) hosted on GitHub Pages and
backed by a Supabase project.

## Screens

- **This week**: pick a week (weeks start Monday, America/Denver). Shows each night's dinner with a link to the
  recipe source, plates, and leftover badges, plus the week's status (draft / voting / needs work / locked), each
  voter's vote and comment, and who still needs to vote. You can **Approve** or mark **Needs work** with a comment.
  Voting is disabled once the week is locked. The database decides when a week locks (every voter approves in
  `multi` mode).
- **Shopping**: the selected week's list grouped by aisle/category. Check items off, add or remove items.
  Prices only show when the row has both `price_cents` and `price_source`.
- **Recipes**: search, add and edit household recipes.
- **Settings**: dinners per week, leftover nights, default plates, approval mode, dietary exclusions, preferred
  stores. Also lists members and lets you sign out.
- **Check now** (This week and Shopping screens): inserts an `app_events` row (`check_now`) asking the meal bot to sync.
  The browser never calls any other service.

## Security

- `config.js` only has the Supabase URL and the **publishable** key, which is meant to be public.
  All access is enforced by Row Level Security: signed-in members only see their own household.
- No analytics, trackers, or third-party requests except the Supabase API and the supabase-js module from jsDelivr
  (pinned version, restricted by a Content-Security-Policy).

## Local development

Serve the folder with any static server, e.g. `python3 -m http.server`, then open `http://localhost:8000/`.
