import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, HOUSEHOLD_TZ, VAPID_PUBLIC_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* ---------------- state ---------------- */
const S = {
  session: null,
  member: null,      // current user's household_members row
  household: null,
  members: [],
  weeks: [],         // [{id, week_start, status}]
  weekStart: null,   // selected 'YYYY-MM-DD' Monday
  recipes: [],
  presets: [],       // saved breakfasts / lunches (meal_presets)
  authMode: 'signin',
};
const appEl = document.getElementById('app');

/* ---------------- helpers ---------------- */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function mount(...nodes) { appEl.replaceChildren(...nodes); }

let toastTimer;
function toast(text, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 5000 : 2600);
}

function friendlyError(err) {
  if (!err) return 'Something went wrong.';
  const code = err.code || '';
  const msg = err.message || String(err);
  if (code === '42501' || /row-level security|permission denied/i.test(msg)) return "You don't have permission to do that. (Only the household owner may be able to change this.)";
  if (code === '55000' || /locked/i.test(msg)) return 'This week is locked, so votes can no longer change.';
  if (code === '23514') return 'One of the values is out of range or not allowed. ' + msg;
  if (code === '23505') return 'That already exists.';
  if (/Invalid login credentials/i.test(msg)) return 'Email or password is incorrect.';
  if (/Email not confirmed/i.test(msg)) return 'Please confirm your email first (check your inbox), then sign in.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return "Couldn't reach the server. Check your connection and try again.";
  return msg;
}

function safeUrl(u) {
  try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : null; } catch { return null; }
}
const listToArr = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const intOrNull = (v) => { const s = String(v ?? '').trim(); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? Math.round(n) : null; };

/* dates: all week math is done on plain YYYY-MM-DD strings, "today" is taken in the household timezone */
function todayISO() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: HOUSEHOLD_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const parseD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = parseD(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const mondayOf = (s) => addDays(s, -((parseD(s).getUTCDay() + 6) % 7));
const fmtD = (s, opts) => parseD(s).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
const fmtTs = (ts) => new Date(ts).toLocaleString('en-US', { timeZone: HOUSEHOLD_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' MT';
function weekLabel(ws) {
  const we = addDays(ws, 6);
  return `${fmtD(ws, { month: 'short', day: 'numeric' })} – ${fmtD(we, { month: 'short', day: 'numeric' })}`;
}
function defaultWeekStart() {
  const today = todayISO();
  const cur = mondayOf(today);
  const next = addDays(cur, 7);
  const has = (ws) => S.weeks.some((w) => w.week_start === ws);
  const dow = (parseD(today).getUTCDay() + 6) % 7; // 0 = Monday
  if (has(next) && (!has(cur) || dow >= 5)) return next; // weekends look ahead to the next plan
  return cur;
}

const STATUS = {
  draft: { label: 'Draft', text: 'The meal bot is still putting this week together.' },
  voting: { label: 'Voting', text: 'Plan is ready. It locks when every voter approves.' },
  needs_work: { label: 'Needs work', text: 'Someone asked for changes. The meal bot will revise the plan.' },
  locked: { label: 'Locked', text: 'Everyone approved. This plan is set.' },
};
const statusChip = (st) => h('span', { class: `chip ${st}` }, STATUS[st]?.label || st);

/* ---------------- routing ---------------- */
function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [view, arg] = hash.split('/');
  return { view: view || 'week', arg: arg ? decodeURIComponent(arg) : null };
}
window.addEventListener('hashchange', () => render());

/* ---------------- boot ---------------- */
let booted = false;
// notification links look like ./?week=2026-10-05#/week: open that week, then tidy the address bar
function takeWeekParam(href) {
  let u; try { u = new URL(href, location.href); } catch { return false; }
  const w = u.searchParams.get('week');
  if (!w || !/^\d{4}-\d{2}-\d{2}$/.test(w) || Number.isNaN(parseD(w).getTime())) return false;
  S.weekStart = mondayOf(w);
  sessionStorage.setItem('weekStart', S.weekStart);
  return true;
}
if (takeWeekParam(location.href)) history.replaceState(null, '', location.pathname + (location.hash || '#/week'));
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
  // tapping a notification while the app is already open
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'open' || !S.member) return;
    takeWeekParam(e.data.url);
    const hash = new URL(e.data.url, location.href).hash || '#/week';
    if (location.hash !== hash) location.hash = hash; else render();
  });
}
async function boot() {
  registerServiceWorker();
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  sb.auth.onAuthStateChange((event, session) => {
    const prevUser = S.session?.user?.id;
    S.session = session;
    if (!booted) return;
    if (event === 'SIGNED_OUT' || (session?.user?.id || null) !== (prevUser || null)) {
      // defer: never call supabase from inside the auth callback
      setTimeout(() => loadAll().then(render), 0);
    }
  });
  await loadAll();
  booted = true;
  render();
}

async function loadAll() {
  S.member = null; S.household = null; S.members = []; S.weeks = []; S.recipes = []; S.presets = [];
  if (!S.session) return;
  const uid = S.session.user.id;
  const { data: mem, error } = await sb.from('household_members').select('*').eq('user_id', uid).limit(1);
  if (error) { toast(friendlyError(error), true); return; }
  S.member = mem?.[0] || null;
  if (!S.member) return;
  const hid = S.member.household_id;
  const [hh, mems, wks, recs, pre] = await Promise.all([
    sb.from('households').select('*').eq('id', hid).single(),
    sb.from('household_members').select('id, display_name, role, is_voter, user_id, invite_email').eq('household_id', hid).order('created_at'),
    sb.from('weeks').select('id, week_start, status, locked_at').eq('household_id', hid).order('week_start', { ascending: false }).limit(60),
    sb.from('recipes').select('*').eq('household_id', hid).order('title'),
    sb.from('meal_presets').select('*').eq('household_id', hid).order('position').order('title'),
  ]);
  for (const r of [hh, mems, wks, recs, pre]) if (r.error) toast(friendlyError(r.error), true);
  S.household = hh.data || null;
  S.members = mems.data || [];
  S.weeks = wks.data || [];
  S.recipes = recs.data || [];
  S.presets = pre.data || [];
  if (!S.weekStart) S.weekStart = sessionStorage.getItem('weekStart') || defaultWeekStart();
}
async function refreshWeeks() {
  const { data } = await sb.from('weeks').select('id, week_start, status, locked_at').eq('household_id', S.household.id).order('week_start', { ascending: false }).limit(60);
  if (data) S.weeks = data;
}
async function refreshPresets() {
  const { data, error } = await sb.from('meal_presets').select('*').eq('household_id', S.household.id).order('position').order('title');
  if (error) toast(friendlyError(error), true); else S.presets = data;
}
async function refreshRecipes() {
  const { data, error } = await sb.from('recipes').select('*').eq('household_id', S.household.id).order('title');
  if (error) toast(friendlyError(error), true); else S.recipes = data;
}

/* ---------------- shell ---------------- */
function render() {
  if (!S.session) return renderAuth();
  if (!S.member || !S.household) return renderUnlinked();
  const { view, arg } = route();
  if (view === 'shop') return renderShop();
  if (view === 'staples') return renderStaples();
  if (view === 'recipes') return arg ? renderRecipeForm(arg) : renderRecipes();
  if (view === 'settings') return renderSettings();
  if (view === 'presets') return renderPresets(arg);
  return renderWeek();
}

/* simple line icons for the tab bar (inline SVG, built with DOM APIs) */
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  week: [['rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 3 }], ['path', { d: 'M3.5 10h17M8 3v4M16 3v4' }]],
  shop: [['path', { d: 'M3 4h2.2l2.1 10.1a2 2 0 0 0 2 1.6h7.5a2 2 0 0 0 1.9-1.4L20.5 8H6.3' }], ['circle', { cx: 10, cy: 20, r: 1.3 }], ['circle', { cx: 17, cy: 20, r: 1.3 }]],
  staples: [['path', { d: 'M3.5 9.5h17M5 9.5l1.4 9a2 2 0 0 0 2 1.7h7.2a2 2 0 0 0 2-1.7l1.4-9M8.5 9.5 12 4l3.5 5.5M10 13.5v3M14 13.5v3' }]],
  recipes: [['path', { d: 'M6 3.5h11.5a1.5 1.5 0 0 1 1.5 1.5v15.5H7a2 2 0 0 1-2-2V4.5a1 1 0 0 1 1-1z' }], ['path', { d: 'M5 18.5a2 2 0 0 1 2-2h12M9 8h6' }]],
  settings: [['path', { d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }], ['circle', { cx: 15, cy: 7, r: 2 }], ['circle', { cx: 9, cy: 17, r: 2 }]],
};
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'ico'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of ICONS[name] || []) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}

function tabbar(active) {
  const tab = (id, label) => h('a', { href: `#/${id}`, class: active === id ? 'active' : '', 'aria-current': active === id ? 'page' : null }, icon(id), label);
  return h('nav', { class: 'tabbar', 'aria-label': 'Main' }, h('div', { class: 'inner' },
    tab('week', 'This week'), tab('shop', 'Shopping'), tab('staples', 'Staples'), tab('recipes', 'Recipes'), tab('settings', 'Settings')));
}
function topbar(title, extra) {
  return h('header', { class: 'topbar' },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h1', null, title), h('div', { class: 'sub' }, S.household?.name || ''))),
    extra || null);
}
function weekPicker(onChange) {
  const ws = S.weekStart;
  const w = S.weeks.find((x) => x.week_start === ws);
  const cur = defaultWeekStart();
  const go = (d) => { S.weekStart = d; sessionStorage.setItem('weekStart', d); onChange(); };
  return h('div', { class: 'weekpick' },
    h('button', { class: 'icon', 'aria-label': 'Previous week', onclick: () => go(addDays(ws, -7)) }, '‹'),
    h('div', { class: 'label' }, `Week of ${weekLabel(ws)}`,
      h('span', { class: 'small muted' }, w ? statusChip(w.status) : 'No plan yet', ' ',
        ws !== cur ? h('button', { class: 'ghost', onclick: () => go(cur) }, 'Jump to current') : null)),
    h('button', { class: 'icon', 'aria-label': 'Next week', onclick: () => go(addDays(ws, 7)) }, '›'));
}

/* ---------------- auth ---------------- */
function renderAuth(notice) {
  const isUp = S.authMode === 'signup';
  const msg = h('div', { class: notice ? `msg ${notice.type}` : 'hidden' }, notice?.text || '');
  const email = h('input', { type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com', inputmode: 'email' });
  const pw = h('input', { type: 'password', autocomplete: isUp ? 'new-password' : 'current-password', required: true, minlength: 6, placeholder: isUp ? 'At least 6 characters' : '' });
  const btn = h('button', { type: 'submit', class: 'block' }, isUp ? 'Create account' : 'Sign in');
  const show = (type, text) => { msg.className = `msg ${type}`; msg.textContent = text; };
  const form = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      if (isUp) {
        const { data, error } = await sb.auth.signUp({ email: email.value.trim(), password: pw.value, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) return show('error', friendlyError(error));
        if (!data.session) {
          S.authMode = 'signin';
          return renderAuth({ type: 'info', text: 'Account created. If you get a confirmation email, tap the link in it; otherwise just sign in below. (If this email already had an account, sign in with that password.)' });
        }
        // signed in right away; onAuthStateChange reloads
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
        if (error) return show('error', friendlyError(error));
      }
    } catch (err) { show('error', friendlyError(err)); } finally { btn.disabled = false; }
  } },
  h('div', { class: 'seg', role: 'tablist' },
    h('button', { type: 'button', class: isUp ? '' : 'on', onclick: () => { S.authMode = 'signin'; renderAuth(); } }, 'Sign in'),
    h('button', { type: 'button', class: isUp ? 'on' : '', onclick: () => { S.authMode = 'signup'; renderAuth(); } }, 'Create account')),
  msg,
  h('label', null, 'Email', email),
  h('label', null, 'Password', pw),
  btn,
  isUp ? h('p', { class: 'small muted' }, 'Use the email address your household invite was sent to, so your account links up automatically.') : null);
  mount(h('main', { class: 'auth' },
    h('div', { class: 'hero' }, h('img', { src: 'icon.svg?v=js1', alt: '' }), h('h1', null, 'Household Meals'), h('p', { class: 'muted' }, 'Plan meals together, vote on dinners, and shop.')),
    form));
}

function renderUnlinked() {
  const email = S.session.user.email;
  mount(h('main', { class: 'auth' },
    h('div', { class: 'hero' }, h('img', { src: 'icon.svg?v=js1', alt: '' }), h('h1', null, 'Almost there')),
    h('div', { class: 'card stack' },
      h('p', null, 'You’re signed in as ', h('strong', null, email), ', but this account isn’t linked to a household yet.'),
      h('p', { class: 'muted small' }, 'Accounts link automatically when the email matches a household invite. Ask the household owner to add this exact email address as a member, then tap “Check again”.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'secondary', onclick: async () => { await loadAll(); render(); if (!S.member) toast('Still not linked yet.'); } }, 'Check again'),
        h('button', { onclick: () => sb.auth.signOut() }, 'Sign out')))));
}

/* ---------------- this week ---------------- */
async function loadWeekData(ws) {
  const { data: week, error } = await sb.from('weeks').select('*').eq('household_id', S.household.id).eq('week_start', ws).maybeSingle();
  if (error) throw error;
  if (!week) return { week: null, slots: [], votes: [], meals: [], items: [] };
  const [slots, votes, meals, items] = await Promise.all([
    sb.from('week_slots').select('*, recipe:recipes(id, title, description, source_url, source_name)').eq('week_id', week.id).order('date').order('position'),
    sb.from('votes').select('*').eq('week_id', week.id),
    sb.from('meal_plan_items').select('*').eq('week_id', week.id).order('date'),
    sb.from('shopping_list_items').select('id, name, quantity, unit, category, source, position, checked, meal_plan_item_id, staple_id, preset_generated, price_cents, price_source').eq('week_id', week.id),
  ]);
  for (const r of [slots, votes, meals, items]) if (r.error) throw r.error;
  return { week, slots: slots.data, votes: votes.data, meals: meals.data || [], items: items.data || [] };
}

async function renderWeek() {
  const content = h('div', { class: 'content' }, h('div', { class: 'card muted center' }, 'Loading this week…'));
  mount(topbar('This week', weekPicker(renderWeek)), content, tabbar('week'));
  const ws = S.weekStart;
  let d;
  try { d = await loadWeekData(ws); } catch (err) { content.replaceChildren(h('div', { class: 'msg error' }, friendlyError(err))); return; }
  if (ws !== S.weekStart || route().view !== 'week') return; // user navigated away
  // keep picker chip in sync
  const known = S.weeks.find((w) => w.week_start === ws);
  if (d.week && (!known || known.status !== d.week.status)) {
    if (known) known.status = d.week.status;
    else S.weeks.push({ id: d.week.id, week_start: d.week.week_start, status: d.week.status, locked_at: d.week.locked_at });
    const picker = appEl.querySelector('.weekpick');
    if (picker) picker.replaceWith(weekPicker(renderWeek));
  }

  const parts = [];
  const budgetSlot = h('div', { class: 'budget-slot' });
  parts.push(budgetSlot);
  budgetSummary(ws).then((sum) => { if (sum) budgetSlot.replaceChildren(budgetBar(sum)); });
  if (!d.week) {
    parts.push(h('div', { class: 'card stack center' },
      h('h2', null, 'No plan for this week yet'),
      h('p', { class: 'muted' }, 'The meal bot hasn’t drafted dinners for this week. Tap “Check now” to ask it to sync, or start planning breakfast and lunch below.')));
  } else {
    const st = d.week.status;
    parts.push(h('div', { class: `status-banner ${st}` },
      h('strong', null, STATUS[st]?.label || st),
      h('div', { class: 'small' }, STATUS[st]?.text || ''),
      st === 'locked' && d.week.locked_at ? h('div', { class: 'small muted' }, `Locked ${fmtTs(d.week.locked_at)}`) : null));
    parts.push(nightsCard(ws, d));
    parts.push(votesCard(d));
  }
  parts.push(smallMealsCard(ws, d));
  parts.push(checkNowCard(d.week));
  content.replaceChildren(...parts);
}

// colored weekday badge: Mon..Sun each get their own soft tint
function dayBadge(date) {
  const wd = (parseD(date).getUTCDay() + 6) % 7; // 0 = Monday
  return h('div', { class: `day wd${wd}` }, h('div', { class: 'dow' }, fmtD(date, { weekday: 'short' })), h('div', { class: 'dom' }, fmtD(date, { day: 'numeric' })));
}

function nightsCard(ws, d) {
  const slots = d.slots;
  const today = todayISO();
  const card = h('section', { class: 'card tint-dinner', id: 'dinners' });
  const head = h('div', { class: 'card-head' }, h('h2', null, 'Dinners'));
  let picking = null; // slot id with the favorites picker open
  let detail = null;  // slot id with the cooking-notes panel open
  const draw = () => {
    const byId = Object.fromEntries(slots.map((s) => [s.id, s]));
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(ws, i);
      const daySlots = slots.filter((s) => s.date === date);
      const dayCol = dayBadge(date);
      let pickerEl = null;
      const swaps = [];
      if (!daySlots.length) {
        rows.push(h('div', { class: `night empty${date === today ? ' today' : ''}` }, dayCol, h('div', null, h('div', { class: 'title' }, 'Nothing planned'))));
        continue;
      }
      const body = daySlots.map((s) => {
        const from = s.leftover_from_slot_id ? byId[s.leftover_from_slot_id] : null;
        const recipe = s.recipe || from?.recipe || null;
        const name = recipe ? recipe.title : (s.is_leftover_night ? 'Leftovers' : 'Dinner TBD');
        const showing = detail === s.id;
        const hasDetail = !!(recipe || s.notes);
        // tap the meal name for cooking notes and recipe links (kept off the main list so it stays short)
        const title = hasDetail ? h('button', {
          type: 'button', class: `title-btn${showing ? ' on' : ''}`, 'aria-expanded': showing ? 'true' : 'false',
          onclick: () => { detail = showing ? null : s.id; picking = null; draw(); },
        }, name) : name;
        // one short line about the meal itself; leftover nights skip it
        const desc = !s.is_leftover_night && recipe?.description ? h('div', { class: 'desc' }, recipe.description) : null;
        // one clean secondary line: a single solid pill when it matters, then the plate count
        const pill = s.is_leftover_night ? h('span', { class: 'chip left' }, from ? `Leftovers from ${fmtD(from.date, { weekday: 'long' })}` : 'Leftover night')
          : s.makes_leftovers ? h('span', { class: 'chip makes' }, 'Makes leftovers') : null;
        const open = picking === s.id;
        const swap = h('button', {
          type: 'button', class: `ghost swap${open ? ' on' : ''}`, 'aria-expanded': open ? 'true' : 'false',
          'aria-label': `Swap ${fmtD(s.date, { weekday: 'long' })}’s dinner for a favorite`,
          onclick: () => { picking = open ? null : s.id; detail = null; draw(); if (!open) card.querySelector('.dpicker input, .dpicker button')?.focus(); },
        }, 'Swap');
        swaps.push(swap);
        if (open) pickerEl = dinnerPicker(d, s, recipe, () => { picking = null; draw(); });
        else if (showing) pickerEl = dinnerDetail(s, recipe, () => { detail = null; draw(); });
        return h('div', { class: 'stack' },
          h('div', { class: 'title' }, title),
          desc,
          h('div', { class: 'meta' }, pill, h('span', { class: 'plates' }, `${s.plates} plate${s.plates === 1 ? '' : 's'}`)));
      });
      rows.push(h('div', { class: `night${date === today ? ' today' : ''}` }, h('div', { class: 'daycol' }, dayCol, swaps), h('div', { class: 'stack' }, body), pickerEl));
      pickerEl = null;
    }
    card.replaceChildren(head, ...rows);
  };
  draw();
  return card;
}

// inline panel under a dinner: the bot's cooking notes plus links to the recipe
function dinnerDetail(slot, recipe, close) {
  const dayName = fmtD(slot.date, { weekday: 'long' });
  const url = recipe?.source_url ? safeUrl(recipe.source_url) : null;
  const panel = h('div', { class: 'picker dinner ddetail', role: 'group', 'aria-label': `${dayName} dinner details` },
    h('div', { class: 'row spread' }, h('div', { class: 'mlabel' }, `${dayName} · ${recipe ? recipe.title : 'Dinner'}`), h('button', { type: 'button', class: 'ghost', onclick: close, 'aria-label': 'Close details' }, '✕')),
    recipe?.description ? h('p', { class: 'small muted' }, recipe.description) : null,
    h('div', { class: 'mlabel sub' }, 'Cooking notes'),
    slot.notes ? h('div', { class: 'cooknotes' }, slot.notes) : h('p', { class: 'small muted' }, 'No cooking notes for this night.'),
    recipe ? h('div', { class: 'row links' },
      url ? h('a', { class: 'btn small-btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, `Open recipe${recipe.source_name ? ` on ${recipe.source_name}` : ''} ↗`) : null,
      h('a', { class: 'btn secondary small-btn', href: `#/recipes/${encodeURIComponent(recipe.id)}` }, 'Recipe details')) : null);
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return panel;
}

/* ---------------- favorites (go-to dinners) ---------------- */
async function toggleFavorite(r, btn) {
  const rec = S.recipes.find((x) => x.id === r.id) || r;
  const next = !rec.is_favorite;
  if (btn) btn.disabled = true;
  const { data, error } = await sb.from('recipes').update({ is_favorite: next }).eq('id', rec.id).select('id, is_favorite');
  if (btn) btn.disabled = false;
  if (error) { toast(friendlyError(error), true); return false; }
  if (!data?.length) { toast('Couldn’t update favorites. You may not have access to this recipe.', true); return false; }
  rec.is_favorite = next; r.is_favorite = next;
  toast(next ? `★ ${rec.title} is now a favorite.` : `${rec.title} removed from favorites.`);
  return true;
}
function starButton(r, onChange) {
  const label = () => (r.is_favorite ? `Remove ${r.title} from favorites` : `Add ${r.title} to favorites`);
  const btn = h('button', { type: 'button', class: `star${r.is_favorite ? ' on' : ''}`, 'aria-pressed': r.is_favorite ? 'true' : 'false', 'aria-label': label(), title: r.is_favorite ? 'Favorite' : 'Add to favorites' }, r.is_favorite ? '★' : '☆');
  btn.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!(await toggleFavorite(r, btn))) return;
    btn.className = `star${r.is_favorite ? ' on' : ''}`; btn.textContent = r.is_favorite ? '★' : '☆';
    btn.setAttribute('aria-pressed', r.is_favorite ? 'true' : 'false'); btn.setAttribute('aria-label', label());
    btn.title = r.is_favorite ? 'Favorite' : 'Add to favorites';
    onChange?.();
  });
  return btn;
}
// how often / how recently each recipe was planned (RLS limits this to the household's own weeks)
async function recipeUsage(ids) {
  if (!ids.length) return {};
  const { data, error } = await sb.from('week_slots').select('recipe_id, date').in('recipe_id', ids).lte('date', todayISO());
  if (error || !data) return {};
  const u = {};
  for (const r of data) { const x = (u[r.recipe_id] ||= { n: 0, last: '' }); x.n++; if (r.date > x.last) x.last = r.date; }
  return u;
}

// inline picker on a dinner slot: favorites only, most used first, one tap to swap
function dinnerPicker(d, slot, current, close) {
  const dayName = fmtD(slot.date, { weekday: 'long' });
  const cur = current ? S.recipes.find((r) => r.id === current.id) || null : null;
  const q = h('input', { type: 'search', placeholder: 'Search favorites', 'aria-label': 'Search favorite dinners', enterkeyhint: 'search' });
  const list = h('div', { class: 'dlist' });
  const curRow = h('div', { class: 'dcur' });
  let usage = {};
  const busy = (on) => wrap.querySelectorAll('button').forEach((b) => { b.disabled = on; });
  const pick = async (r) => {
    if (cur && r.id === cur.id && !slot.is_leftover_night) { close(); return; }
    if (d.week.status === 'locked' && !confirm(`This week is locked. Swapping ${dayName}’s dinner reopens voting, so everyone has to approve the plan again. Swap to “${r.title}”?`)) return;
    busy(true);
    const { data, error } = await sb.from('week_slots').update({ recipe_id: r.id, is_leftover_night: false, leftover_from_slot_id: null }).eq('id', slot.id).select('id');
    if (error) { busy(false); return toast(friendlyError(error), true); }
    if (!data?.length) { busy(false); return toast('Couldn’t swap that dinner. You may not have access to this week.', true); }
    toast(`${dayName}: ${r.title}. ${d.week.status === 'draft' ? '' : 'Approvals were reset. '}The shopping list updates when the meal bot checks.`);
    await refreshWeeks();
    renderWeek();
  };
  const drawCur = () => {
    curRow.replaceChildren();
    if (!cur) return;
    curRow.append(h('span', { class: 'small muted grow' }, 'Now: ', h('strong', null, cur.title)),
      h('button', { type: 'button', class: `ghost fav-toggle${cur.is_favorite ? ' on' : ''}`, onclick: async (e) => { if (await toggleFavorite(cur, e.currentTarget)) { drawCur(); drawList(); } } },
        cur.is_favorite ? '★ Favorite' : '☆ Add to favorites'));
  };
  const usageText = (r) => { const u = usage[r.id]; return u ? `Made ${u.n} time${u.n === 1 ? '' : 's'}, last ${fmtD(u.last, { month: 'short', day: 'numeric' })}` : 'Not planned yet'; };
  const drawList = () => {
    const favs = S.recipes.filter((r) => r.is_favorite);
    q.parentElement && (q.parentElement.hidden = favs.length < 2);
    if (!favs.length) {
      list.replaceChildren(h('div', { class: 'empty-presets' },
        h('p', { class: 'small muted' }, `No favorites yet. Tap the ☆ star on a recipe in the Recipes tab${cur ? ' (or “Add to favorites” above)' : ''} and your go-to dinners show up here for one-tap swaps.`),
        h('a', { class: 'btn small-btn', href: '#/recipes' }, 'Go to Recipes')));
      return;
    }
    const term = q.value.trim().toLowerCase();
    const rs = favs.filter((r) => !term || [r.title, ...(r.tags || [])].join(' ').toLowerCase().includes(term))
      .sort((a, b) => (usage[b.id]?.n || 0) - (usage[a.id]?.n || 0) || (usage[b.id]?.last || '').localeCompare(usage[a.id]?.last || '') || a.title.localeCompare(b.title));
    list.replaceChildren(...(rs.length ? rs.map((r) => {
      const on = cur?.id === r.id && !slot.is_leftover_night;
      return h('button', { type: 'button', class: `pchip drow${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => pick(r) },
        h('span', { class: 'pt' }, r.title), h('span', { class: 'pm' }, usageText(r)));
    }) : [h('p', { class: 'small muted' }, 'No favorites match.')]));
  };
  q.addEventListener('input', drawList);
  const wrap = h('div', { class: 'picker dinner dpicker', role: 'group', 'aria-label': `Pick a favorite dinner for ${dayName}` },
    h('div', { class: 'row spread' }, h('div', { class: 'mlabel' }, `Favorite dinners · ${dayName}`), h('button', { type: 'button', class: 'ghost', onclick: close, 'aria-label': 'Close picker' }, '✕')),
    curRow,
    h('div', { class: 'dsearch' }, q),
    list,
    d.week.status === 'locked' ? h('p', { class: 'small muted' }, 'This week is locked. A swap reopens voting.') : d.week.status !== 'draft' ? h('p', { class: 'small muted' }, 'A swap resets approvals, so everyone approves the new plan.') : null);
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  drawCur(); drawList();
  recipeUsage(S.recipes.filter((r) => r.is_favorite).map((r) => r.id)).then((u) => { usage = u; if (wrap.isConnected) drawList(); });
  return wrap;
}

function votesCard({ week, slots, votes }) {
  const voters = S.members.filter((m) => m.is_voter);
  const voteBy = Object.fromEntries(votes.map((v) => [v.member_id, v]));
  const waiting = voters.filter((m) => !voteBy[m.id]);
  const locked = week.status === 'locked';
  const me = S.member;
  const myVote = voteBy[me.id];

  const list = voters.map((m) => {
    const v = voteBy[m.id];
    return h('div', { class: 'voter' },
      h('div', { class: `dot ${v?.decision || ''}` }, v?.decision === 'approve' ? '✓' : v?.decision === 'needs_work' ? '!' : (m.display_name[0] || '?')),
      h('div', { class: 'grow' },
        h('div', null, h('strong', null, m.display_name), m.id === me.id ? h('span', { class: 'muted small' }, ' (you)') : null),
        h('div', { class: 'small muted' }, v ? (v.decision === 'approve' ? 'Approved' : 'Needs work') + ` · ${fmtTs(v.updated_at || v.created_at)}` : 'Hasn’t voted yet'),
        v?.comment ? h('div', { class: 'comment' }, v.comment) : null));
  });

  const area = h('div', { class: 'stack' });
  let actions = null;
  if (!me.is_voter) {
    actions = h('p', { class: 'small muted' }, 'You’re not a voter in this household.');
  } else if (locked) {
    actions = h('p', { class: 'small muted' }, 'Voting is closed because this week is locked.');
  } else if (!slots.length) {
    actions = h('p', { class: 'small muted' }, 'Nothing to vote on yet. Voting opens once dinners are planned.');
  } else {
    const comment = h('textarea', { placeholder: 'What should change? e.g. “Swap Thursday for something quicker”', maxlength: 2000 }, myVote?.decision === 'needs_work' ? myVote.comment || '' : '');
    const nwForm = h('div', { class: 'stack hidden' }, h('label', null, 'Comment for the meal bot', comment));
    const approveBtn = h('button', { class: 'approve' }, myVote?.decision === 'approve' ? '✓ Approved' : 'Approve');
    const nwBtn = h('button', { class: 'secondary' }, 'Needs work');
    const sendBtn = h('button', { class: 'secondary block' }, 'Send “needs work”');
    const cast = async (decision, text, btn) => {
      btn.disabled = true;
      const { error } = await sb.from('votes').upsert({ week_id: week.id, member_id: me.id, decision, comment: text || null }, { onConflict: 'week_id,member_id' });
      btn.disabled = false;
      if (error) return toast(friendlyError(error), true);
      toast(decision === 'approve' ? 'Approved!' : 'Sent. The meal bot will revise.');
      await refreshWeeks();
      renderWeek();
    };
    approveBtn.addEventListener('click', () => cast('approve', null, approveBtn));
    nwBtn.addEventListener('click', () => { nwForm.classList.toggle('hidden'); if (!nwForm.classList.contains('hidden')) comment.focus(); });
    sendBtn.addEventListener('click', () => {
      if (!comment.value.trim()) { toast('Add a quick note about what to change.', true); comment.focus(); return; }
      cast('needs_work', comment.value.trim(), sendBtn);
    });
    nwForm.append(sendBtn);
    actions = h('div', { class: 'stack' }, h('div', { class: 'btn-row' }, approveBtn, nwBtn), nwForm,
      myVote ? h('p', { class: 'small muted' }, 'You can change your vote until the week locks.') : null);
  }
  area.append(actions);

  return h('section', { class: 'card stack' },
    h('div', { class: 'row spread' }, h('h2', null, 'Votes'),
      h('span', { class: 'small muted' }, S.household.approval_mode === 'solo' ? 'One approval locks' : 'All voters must approve')),
    h('div', null, list),
    !locked && waiting.length ? h('div', { class: 'msg info' }, `Still need to vote: ${waiting.map((m) => m.display_name).join(', ')}`) : null,
    area);
}

function checkNowCard(week) {
  const status = h('div', { class: 'small muted' }, '');
  const btn = h('button', { class: 'secondary block' }, 'Check now');
  const showLast = async () => {
    const { data } = await sb.from('app_events').select('created_at, processed_at').eq('household_id', S.household.id).eq('event_type', 'check_now').order('created_at', { ascending: false }).limit(1);
    const e = data?.[0];
    status.textContent = e ? `Last check requested ${fmtTs(e.created_at)} · ${e.processed_at ? 'picked up ' + fmtTs(e.processed_at) : 'waiting for the meal bot'}` : 'Asks the meal bot to sync plans, recipes and the shopping list.';
  };
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const { error } = await sb.from('app_events').insert({
      household_id: S.household.id,
      week_id: week?.id || null,
      event_type: 'check_now',
      payload: { week_start: S.weekStart, requested_by_member_id: S.member.id, requested_by: S.member.display_name, source: 'web_app' },
    });
    btn.disabled = false;
    if (error) return toast(friendlyError(error), true);
    toast('Asked the meal bot to check.');
    showLast();
  });
  showLast();
  return h('section', { class: 'card stack' }, btn, status);
}

/* ---------------- shopping ---------------- */
const CATEGORIES = ['Produce', 'Meat', 'Dairy', 'Bakery', 'Pantry', 'Spices', 'Frozen', 'Breakfast basics', 'Snacks', 'Drinks', 'Household', 'Other'];
let hideChecked = sessionStorage.getItem('hideChecked') === '1';

async function renderShop() {
  const content = h('div', { class: 'content' }, h('div', { class: 'card muted center' }, 'Loading shopping list…'));
  mount(topbar('Shopping', weekPicker(renderShop)), content, tabbar('shop'));
  const ws = S.weekStart;
  const { data: week, error } = await sb.from('weeks').select('id, status').eq('household_id', S.household.id).eq('week_start', ws).maybeSingle();
  if (route().view !== 'shop' || ws !== S.weekStart) return;
  if (error) return content.replaceChildren(h('div', { class: 'msg error' }, friendlyError(error)));
  if (!week) {
    return content.replaceChildren(h('div', { class: 'card stack center' }, h('h2', null, 'No list for this week'),
      h('p', { class: 'muted' }, 'A shopping list appears once the meal bot plans this week.')), checkNowCard(null));
  }
  const [{ data: items, error: e2 }, { data: meals }] = await Promise.all([
    sb.from('shopping_list_items').select('*').eq('week_id', week.id).order('position').order('name'),
    sb.from('meal_plan_items').select('id, date, meal_type, title, ingredients').eq('week_id', week.id),
  ]);
  if (e2) return content.replaceChildren(h('div', { class: 'msg error' }, friendlyError(e2)));
  const mealById = Object.fromEntries((meals || []).map((m) => [m.id, m]));
  if (route().view !== 'shop' || ws !== S.weekStart) return;
  const recipeTitle = Object.fromEntries(S.recipes.map((r) => [r.id, r.title]));
  const store = storeName();

  const listWrap = h('div', { class: 'stack' });
  const counter = h('span', { class: 'small muted' });
  const budgetSlot = h('div', { class: 'budget-slot' });
  const weekTotal = h('div', { class: 'week-total small' });
  const drawTotals = () => {
    const priced = items.filter(hasPrice);
    const spent = priced.reduce((t, i) => t + i.price_cents, 0);
    const unpriced = items.length - priced.length;
    weekTotal.replaceChildren(h('span', null, 'This week’s list: ', h('strong', null, money(spent))),
      h('span', { class: 'muted' }, unpriced ? ` · ${unpriced} of ${items.length} unpriced` : items.length ? ' · every item priced' : ''));
    budgetSummary(ws).then((sum) => { if (sum && route().view === 'shop' && ws === S.weekStart) budgetSlot.replaceChildren(budgetBar(sum)); });
  };
  const draw = () => {
    const done = items.filter((i) => i.checked).length;
    counter.textContent = `${done} of ${items.length} checked`;
    const groups = new Map();
    for (const it of items) {
      const key = (it.aisle && it.aisle.trim()) || (it.category && it.category.trim()) || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b, undefined, { numeric: true }));
    const cards = [];
    for (const k of keys) {
      const its = groups.get(k).filter((i) => !(hideChecked && i.checked));
      if (!its.length) continue;
      cards.push(h('section', { class: `card aisle ${catClass(k)}` }, h('h3', null, h('span', { class: 'aisle-pill' }, k), h('span', { class: 'aisle-count' }, String(its.length))), its.map(itemRow)));
    }
    if (!items.length) cards.push(h('div', { class: 'card muted center' }, 'No items yet. Add one below, or tap Check now.'));
    else if (!cards.length) cards.push(h('div', { class: 'card muted center' }, 'Everything is checked off. Nice work!'));
    listWrap.replaceChildren(...cards);
  };
  const itemRow = (it) => {
    const qty = [it.quantity != null ? fmtQty(it.quantity) : null, it.unit].filter(Boolean).join(' ');
    const priced = hasPrice(it);
    const cb = h('input', { type: 'checkbox', 'aria-label': `Got ${it.name}` });
    cb.checked = !!it.checked;
    const link = priced && it.walmart_product_url ? safeUrl(it.walmart_product_url) : null;
    const product = priced ? productName(it.price_source) : null;
    const row = h('div', { class: `item${it.checked ? ' done' : ''}` }, cb,
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, it.name, qty ? h('span', { class: 'muted small' }, ` · ${qty}`) : null),
        sourceLabel(it, recipeTitle, mealById),
        priced ? h('div', { class: 'pricesrc', title: it.price_source + (it.price_verified_at ? ` · checked ${fmtTs(it.price_verified_at)}` : '') },
          link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, product) : product) : null),
      priced ? h('span', { class: 'price', 'aria-label': `Price ${money(it.price_cents)}` }, money(it.price_cents)) : null,
      h('button', { class: 'ghost', 'aria-label': `Remove ${it.name}`, onclick: async () => {
        if (!confirm(`Remove “${it.name}” from the list?`)) return;
        const { error } = await sb.from('shopping_list_items').delete().eq('id', it.id);
        if (error) return toast(friendlyError(error), true);
        items.splice(items.indexOf(it), 1); draw(); drawTotals();
      } }, '✕'));
    cb.addEventListener('change', async () => {
      const val = cb.checked;
      it.checked = val; row.classList.toggle('done', val);
      const { error } = await sb.from('shopping_list_items').update({ checked: val }).eq('id', it.id);
      if (error) { it.checked = !val; cb.checked = !val; row.classList.toggle('done', !val); toast(friendlyError(error), true); return; }
      draw();
    });
    return row;
  };

  // add form
  const name = h('input', { placeholder: 'e.g. Paper towels', required: true, maxlength: 200 });
  const qty = h('input', { type: 'number', min: 0, step: 'any', inputmode: 'decimal', placeholder: 'Qty' });
  const unit = h('input', { placeholder: 'Unit (lb, can…)', maxlength: 40 });
  const cat = h('input', { placeholder: 'Category', list: 'catlist', maxlength: 60 });
  const catList = h('datalist', { id: 'catlist' }, [...new Set([...CATEGORIES, ...items.map((i) => i.category).filter(Boolean)])].map((c) => h('option', { value: c })));
  const addBtn = h('button', { type: 'submit', class: 'block' }, 'Add to list');
  const addForm = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    if (!name.value.trim()) return;
    addBtn.disabled = true;
    const maxPos = items.reduce((m, i) => Math.max(m, i.position || 0), 0);
    const { data, error } = await sb.from('shopping_list_items').insert({
      week_id: week.id, name: name.value.trim(), quantity: qty.value === '' ? null : Number(qty.value),
      unit: unit.value.trim() || null, category: cat.value.trim() || 'Other', store, position: maxPos + 1, source: 'manual',
    }).select().single();
    addBtn.disabled = false;
    if (error) return toast(friendlyError(error), true);
    items.push(data); name.value = ''; qty.value = ''; unit.value = '';
    draw(); drawTotals(); toast('Added.');
  } },
  h('h2', null, 'Add an item'), h('label', null, 'Item', name), h('div', { class: 'grid2' }, qty, unit), cat, catList, addBtn,
  h('p', { class: 'small muted' }, 'Snacks, drinks and basics live in the Staples tab, so you can add them every week in one tap.'));

  const hideBtn = h('button', { class: 'ghost' }, hideChecked ? 'Show checked' : 'Hide checked');
  hideBtn.addEventListener('click', () => { hideChecked = !hideChecked; sessionStorage.setItem('hideChecked', hideChecked ? '1' : '0'); hideBtn.textContent = hideChecked ? 'Show checked' : 'Hide checked'; draw(); });

  draw(); drawTotals();
  content.replaceChildren(
    h('div', { class: 'shop-head' }, budgetSlot, weekTotal),
    h('div', { class: 'row spread' }, h('div', null, h('strong', null, store), ' ', counter), hideBtn),
    listWrap, addForm, checkNowCard(week),
    h('p', { class: 'small muted center' }, 'Only items with a verified price and source count toward the budget. Prices are walmart.com online prices (no store selected), so the Rexburg store’s shelf price may differ a little.'));
}

/* ---------------- shared list helpers ---------------- */
const storeName = () => S.household?.preferred_stores?.[0] || 'Walmart';
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const MEAL_TYPES = [['breakfast', 'Breakfast'], ['lunch', 'Lunch']];
const MEAL_LABEL = Object.fromEntries(MEAL_TYPES);

// rough aisle guess for free-text breakfast/lunch lines; anything unknown lands in "Other"
const CATEGORY_HINTS = [
  ['Frozen', /\bfrozen\b|waffles?\b|ice cream/],
  ['Dairy', /\b(milk|eggs?|yogh?urts?|cheese|butter|cream cheese|sour cream|half and half|creamer|cottage)\b/],
  ['Meat', /\b(ham|turkey|bacon|sausages?|chicken|beef|salami|pepperoni|deli meat|lunch meat|hot dogs?)\b/],
  ['Bakery', /\b(bread|bagels?|tortillas?|buns?|rolls?|english muffins?|muffins?|croissants?|pitas?|naan)\b/],
  ['Produce', /\b(bananas?|apples?|berr(y|ies)|strawberr(y|ies)|blueberr(y|ies)|grapes?|oranges?|lettuce|spinach|tomato(es)?|avocados?|cucumbers?|carrots?|celery|peppers?|onions?|lemons?|limes?|potato(es)?|fruit|salad mix)\b/],
  ['Breakfast basics', /\b(cereal|oats|oatmeal|granola|pancake mix|syrup)\b/],
  ['Pantry', /\b(peanut butter|jam|jelly|honey|mayo(nnaise)?|mustard|ketchup|rice|pasta|noodles|beans|soup|tuna|crackers|chips|salsa|sauce)\b/],
  ['Drinks', /\b(juice|coffee|tea|soda|sparkling|water)\b/],
];
function guessCategory(name) {
  const n = norm(name);
  for (const [cat, re] of CATEGORY_HINTS) if (re.test(n)) return cat;
  return 'Other';
}

// insert rows into the week's shopping list, skipping anything already on it (same name or same staple)
async function addToList(weekId, rows, existing) {
  const haveName = new Set(existing.map((i) => norm(i.name)));
  const haveStaple = new Set(existing.filter((i) => i.staple_id).map((i) => i.staple_id));
  const fresh = []; const skipped = [];
  for (const r of rows) {
    const k = norm(r.name);
    if (!k) continue;
    if (haveName.has(k) || (r.staple_id && haveStaple.has(r.staple_id))) { skipped.push(r.name); continue; }
    haveName.add(k); if (r.staple_id) haveStaple.add(r.staple_id);
    fresh.push(r);
  }
  if (!fresh.length) return { added: [], skipped };
  let pos = existing.reduce((m, i) => Math.max(m, i.position || 0), 0);
  const payload = fresh.map((r) => ({ week_id: weekId, store: storeName(), position: ++pos, quantity: null, unit: null, ...r }));
  const { data, error } = await sb.from('shopping_list_items').insert(payload).select();
  if (error) throw error;
  existing.push(...(data || []));
  return { added: data || [], skipped };
}
function listResultText({ added, skipped }) {
  const parts = [];
  if (added.length) parts.push(`Added ${added.length} item${added.length === 1 ? '' : 's'} to the list`);
  if (skipped.length) parts.push(`${skipped.length} already on it`);
  return parts.join(' · ') || 'Nothing to add.';
}

// category → color class for aisle headers and chips
const CAT_CLASS = { produce: 'produce', meat: 'meat', dairy: 'dairy', bakery: 'bakery', pantry: 'pantry', spices: 'spices', frozen: 'frozen', 'breakfast basics': 'breakfast', snacks: 'snacks', drinks: 'drinks', household: 'household' };
const catClass = (k) => `cat-${CAT_CLASS[norm(k)] || 'other'}`;
// "walmart.com online price, <product>, <url>, checked …" → "<product>"
function productName(src) {
  const s = String(src || '');
  const m = s.match(/^walmart\.com online price,\s*(.+?),\s*https?:\/\//i);
  return m ? m[1] : s;
}

function sourceLabel(it, recipeTitle, mealById) {
  let text = null;
  if (it.recipe_id && recipeTitle[it.recipe_id]) text = `For ${recipeTitle[it.recipe_id]}`;
  else if (it.preset_generated) {
    const k = ingKey(it.name, it.unit);
    const uses = Object.values(mealById).filter((m) => ingList(m.ingredients).some((i) => ingKey(i.name, i.unit) === k));
    const titles = [...new Set(uses.map((m) => m.title))];
    const types = [...new Set(uses.map((m) => MEAL_LABEL[m.meal_type]))];
    text = [types.join(' & ') || MEAL_LABEL[it.source] || 'Saved meal', titles.length ? titles.join(', ') : null, uses.length ? `${uses.length} day${uses.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
  } else if (it.source === 'breakfast' || it.source === 'lunch') {
    const m = it.meal_plan_item_id ? mealById[it.meal_plan_item_id] : null;
    text = [MEAL_LABEL[it.source], m ? fmtD(m.date, { weekday: 'short' }) : null, m?.title].filter(Boolean).join(' · ');
  } else if (it.source === 'staple') text = 'Staple';
  return text ? h('div', { class: 'src' }, text) : null;
}

/* ---------------- breakfast & lunch (no voting, editable even when locked) ---------------- */
const presetsOf = (type) => S.presets.filter((p) => p.meal_type === type).sort((a, b) => (a.position || 0) - (b.position || 0) || a.title.localeCompare(b.title));
const ingList = (x) => (Array.isArray(x) ? x : []).filter((i) => i && String(i.name || '').trim());
const fmtQty = (q) => (q == null || q === '' ? '' : String(Math.round(Number(q) * 100) / 100));
const ingText = (i) => [fmtQty(i.quantity), i.unit, i.name].filter(Boolean).join(' ');

async function createWeek(ws) {
  const { error } = await sb.from('weeks').insert({ household_id: S.household.id, week_start: ws, status: 'draft' });
  if (error && error.code !== '23505') throw error; // 23505: someone else just created it
  await refreshWeeks();
}

function smallMealsCard(ws, d) {
  const card = h('section', { class: 'card tint-meals', id: 'meals' });
  const head = h('div', { class: 'card-head' }, h('h2', null, 'Breakfast & lunch'),
    h('p', { class: 'small muted' }, 'Tap a day to pick a saved breakfast or lunch. Ingredients go straight to the shopping list. No voting needed.'));
  if (!d.week) {
    const start = h('button', { class: 'block' }, 'Start planning this week');
    start.addEventListener('click', async () => {
      start.disabled = true;
      try { await createWeek(ws); toast('Week started.'); renderWeek(); } catch (err) { toast(friendlyError(err), true); start.disabled = false; }
    });
    card.append(head, h('p', { class: 'small muted' }, `No plan exists for ${weekLabel(ws)} yet. Start one to plan breakfast and lunch now; dinners stay with the meal bot.`), start);
    return card;
  }
  const today = todayISO();
  let editing = null; // 'date|type' → free-text editor
  let picking = null; // 'date|type' → preset picker
  const draw = () => {
    const byKey = new Map(d.meals.map((m) => [`${m.date}|${m.meal_type}`, m]));
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(ws, i);
      const lines = h('div', { class: 'meals' });
      for (const [type, label] of MEAL_TYPES) {
        const key = `${date}|${type}`;
        const item = byKey.get(key) || null;
        const close = () => { editing = null; picking = null; draw(); };
        if (editing === key) { lines.append(mealEditor(d, date, type, label, item, close)); continue; }
        if (picking === key) { lines.append(presetPicker(d, ws, date, type, label, item, close, () => { picking = null; editing = key; draw(); card.querySelector('.meal-edit input')?.focus(); })); continue; }
        const nIng = ingList(item?.ingredients).length;
        const onList = item ? d.items.filter((x) => x.meal_plan_item_id === item.id).length : 0;
        const recipe = item?.recipe_id ? S.recipes.find((r) => r.id === item.recipe_id) : null;
        const meta = item ? [item.preset_id || nIng ? 'Saved' : null, recipe ? (norm(recipe.title) === norm(item.title) ? 'Recipe linked' : `Recipe: ${recipe.title}`) : null,
          nIng ? `${nIng} ingredient${nIng === 1 ? '' : 's'}` : null, onList ? `${onList} on list` : null].filter(Boolean).join(' · ') : '';
        lines.append(h('button', {
          type: 'button', class: `mealline ${type}${item ? '' : ' empty'}`,
          'aria-label': item ? `${label} ${fmtD(date, { weekday: 'long' })}: ${item.title}. Change` : `Add ${label.toLowerCase()} for ${fmtD(date, { weekday: 'long' })}`,
          onclick: () => { editing = null; picking = key; draw(); card.querySelector('.picker .pchip, .picker button')?.focus(); },
        },
        h('span', { class: 'mlabel' }, label),
        h('span', { class: 'mtitle' }, item ? item.title : '+ Add', meta ? h('span', { class: 'mmeta' }, meta) : null)));
      }
      rows.push(h('div', { class: `night${date === today ? ' today' : ''}` }, dayBadge(date), lines));
    }
    card.replaceChildren(head, ...rows);
  };
  draw();
  return card;
}

// one-tap picker of saved breakfasts / lunches for a day (optionally the whole week)
function presetPicker(d, ws, date, type, label, item, close, freeText) {
  const list = presetsOf(type);
  const dayName = fmtD(date, { weekday: 'long' });
  const allDays = h('input', { type: 'checkbox', 'aria-label': `Fill the whole week with this ${label.toLowerCase()}` });
  const busy = (on) => wrap.querySelectorAll('button').forEach((b) => { b.disabled = on; });
  const apply = async (p) => {
    busy(true);
    try {
      const dates = allDays.checked ? Array.from({ length: 7 }, (_, i) => addDays(ws, i)) : [date];
      const rows = dates.map((dt) => ({ week_id: d.week.id, household_id: S.household.id, date: dt, meal_type: type, title: p.title, preset_id: p.id, ingredients: ingList(p.ingredients), recipe_id: null }));
      const { data, error } = await sb.from('meal_plan_items').upsert(rows, { onConflict: 'week_id,date,meal_type' }).select();
      if (error) throw error;
      for (const m of data || []) { const i = d.meals.findIndex((x) => x.id === m.id || (x.date === m.date && x.meal_type === m.meal_type)); if (i >= 0) d.meals[i] = m; else d.meals.push(m); }
      const res = await syncPresetItems(d.week, d.meals, d.items);
      toast(`${p.title} · ${dates.length === 7 ? 'all 7 days' : dayName}. ${syncText(res)}`);
      close();
    } catch (err) { toast(friendlyError(err), true); busy(false); }
  };
  const clear = async () => {
    busy(true);
    const { error } = await sb.from('meal_plan_items').delete().eq('id', item.id);
    if (error) { busy(false); return toast(friendlyError(error), true); }
    d.meals.splice(d.meals.findIndex((m) => m.id === item.id), 1);
    try { const res = await syncPresetItems(d.week, d.meals, d.items); toast(`Cleared. ${syncText(res)}`); } catch (err) { toast(friendlyError(err), true); }
    close();
  };
  const goPresets = (hash) => { sessionStorage.setItem('presetsBack', '#/week'); location.hash = hash; };
  const wrap = h('div', { class: `picker ${type}`, role: 'group', 'aria-label': `${label} for ${dayName}` },
    h('div', { class: 'row spread' }, h('div', { class: 'mlabel' }, `${label} · ${dayName}`), h('button', { type: 'button', class: 'ghost', onclick: close, 'aria-label': 'Close picker' }, '✕')),
    list.length
      ? h('div', { class: 'pchips' }, list.map((p) => {
        const on = item?.preset_id === p.id;
        const n = ingList(p.ingredients).length;
        return h('button', { type: 'button', class: `pchip${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => apply(p) },
          h('span', { class: 'pt' }, p.title), h('span', { class: 'pm' }, n ? `${n} ingredient${n === 1 ? '' : 's'}` : 'no ingredients'));
      }))
      : h('div', { class: 'empty-presets' },
        h('p', { class: 'small muted' }, `No saved ${label.toLowerCase()}s yet. Save the ones you have most weeks, then pick them here in one tap.`),
        h('button', { type: 'button', onclick: () => goPresets(`#/presets/new-${type}`) }, `Add your first ${label.toLowerCase()}`)),
    list.length ? h('label', { class: 'fillweek' }, allDays, h('span', null, 'Fill whole week ', h('span', { class: 'hint' }, 'apply my pick to all 7 days'))) : null,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'secondary', onclick: freeText }, 'Type something else'),
      list.length ? h('button', { type: 'button', class: 'ghost', onclick: () => goPresets('#/presets') }, 'Edit presets') : null,
      h('span', { class: 'grow' }),
      item ? h('button', { type: 'button', class: 'ghost danger', onclick: clear }, 'Clear') : null));
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return wrap;
}

// Rebuild the shopping rows that come from preset ingredients for one week.
// Only rows with preset_generated = true are inserted / updated / deleted here; everything else is left alone.
const ingKey = (name, unit) => `${norm(name)}|${norm(unit)}`;
async function syncPresetItems(week, meals, items) {
  const want = new Map();
  for (const m of meals) {
    for (const ing of ingList(m.ingredients)) {
      const name = String(ing.name).trim();
      const unit = String(ing.unit || '').trim() || null;
      const k = ingKey(name, unit);
      const q = ing.quantity === '' || ing.quantity == null ? null : Number(ing.quantity);
      let w = want.get(k);
      if (!w) { w = { name, unit, category: ing.category || guessCategory(name), quantity: null, source: m.meal_type }; want.set(k, w); }
      if (Number.isFinite(q)) w.quantity = Math.round(((w.quantity || 0) + q) * 100) / 100;
      if (m.meal_type === 'breakfast') w.source = 'breakfast';
    }
  }
  const presetRows = items.filter((i) => i.preset_generated);
  const otherNames = new Set(items.filter((i) => !i.preset_generated).map((i) => norm(i.name)));
  const byKey = new Map(presetRows.map((r) => [ingKey(r.name, r.unit), r]));
  const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9);
  const inserts = []; const updates = []; const skipped = [];
  for (const [k, w] of want) {
    const row = byKey.get(k);
    if (row) {
      byKey.delete(k);
      const patch = {};
      if (!same(row.quantity, w.quantity)) patch.quantity = w.quantity;
      if (row.source !== w.source) patch.source = w.source;
      if (Object.keys(patch).length) updates.push([row, patch]);
      continue;
    }
    if (otherNames.has(norm(w.name))) { skipped.push(w.name); continue; } // already on the list from a dinner, staple or by hand
    inserts.push(w);
  }
  const deletes = [...byKey.values()];
  if (deletes.length) {
    const { error } = await sb.from('shopping_list_items').delete().in('id', deletes.map((r) => r.id));
    if (error) throw error;
    for (const r of deletes) items.splice(items.indexOf(r), 1);
  }
  for (const [row, patch] of updates) {
    const { error } = await sb.from('shopping_list_items').update(patch).eq('id', row.id);
    if (error) throw error;
    Object.assign(row, patch);
  }
  let added = [];
  if (inserts.length) {
    let pos = items.reduce((m, i) => Math.max(m, i.position || 0), 0);
    const payload = inserts.map((w) => ({ week_id: week.id, name: w.name, quantity: w.quantity, unit: w.unit, category: w.category, store: storeName(), position: ++pos, source: w.source, preset_generated: true }));
    const { data, error } = await sb.from('shopping_list_items').insert(payload).select();
    if (error) throw error;
    added = data || [];
    items.push(...added);
  }
  return { added: added.length, updated: updates.length, removed: deletes.length, skipped };
}
function syncText({ added, updated, removed, skipped }) {
  const parts = [];
  if (added) parts.push(`${added} added to the list`);
  if (updated) parts.push(`${updated} quantit${updated === 1 ? 'y' : 'ies'} updated`);
  if (removed) parts.push(`${removed} removed`);
  if (skipped.length) parts.push(`${skipped.length} already on the list`);
  return parts.length ? parts.join(' · ') + '.' : 'Shopping list already up to date.';
}

function mealEditor(d, date, type, label, item, close) {
  const title = h('input', { maxlength: 200, 'aria-label': `${label} for ${fmtD(date, { weekday: 'long' })}`, placeholder: type === 'breakfast' ? 'e.g. Oatmeal & berries' : 'e.g. Turkey sandwiches', value: item?.title || '' });
  const recipe = h('select', { 'aria-label': 'Link a recipe (optional)' }, h('option', { value: '' }, 'No recipe link'), S.recipes.map((r) => h('option', { value: r.id }, r.title)));
  recipe.value = item?.recipe_id || '';
  const ing = h('textarea', { rows: 3, maxlength: 2000, placeholder: 'Ingredients to add to the shopping list, one per line\nRolled oats\nBlueberries' });
  const save = h('button', { type: 'submit' }, 'Save');
  const wasPreset = !!(item && (item.preset_id || ingList(item.ingredients).length));
  const form = h('form', { class: `meal-edit ${type}`, onsubmit: async (e) => {
    e.preventDefault();
    const t = title.value.trim();
    const lines = ing.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!t) { toast(`Give ${label.toLowerCase()} a name first.`, true); title.focus(); return; }
    save.disabled = true;
    try {
      const row = { week_id: d.week.id, household_id: S.household.id, date, meal_type: type, title: t, recipe_id: recipe.value || null };
      const q = item ? sb.from('meal_plan_items').update({ title: row.title, recipe_id: row.recipe_id, preset_id: null, ingredients: [] }).eq('id', item.id) : sb.from('meal_plan_items').insert(row);
      const { data, error } = await q.select().single();
      if (error) throw error;
      const i = d.meals.findIndex((m) => m.id === data.id);
      if (i >= 0) d.meals[i] = data; else d.meals.push(data);
      let msg = 'Saved.';
      if (wasPreset) msg = `Saved. ${syncText(await syncPresetItems(d.week, d.meals, d.items))}`;
      if (lines.length) {
        const res = await addToList(d.week.id, lines.map((name) => ({ name, category: guessCategory(name), source: type, meal_plan_item_id: data.id })), d.items);
        msg = `${msg} ${listResultText(res)}.`;
      }
      toast(msg);
      close();
    } catch (err) { toast(friendlyError(err), true); } finally { save.disabled = false; }
  } },
  h('div', { class: 'mlabel' }, `${label} · ${fmtD(date, { weekday: 'long' })}`),
  title, recipe, ing,
  wasPreset ? h('p', { class: 'small muted' }, 'Saving free text replaces the saved pick; its ingredients come off the list.') : null,
  h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'secondary', onclick: close }, 'Cancel'), h('span', { class: 'grow' }),
    item ? h('button', { type: 'button', class: 'ghost danger', onclick: async () => {
      if (!confirm(`Remove ${label.toLowerCase()} on ${fmtD(date, { weekday: 'long' })}? Items you typed in stay on the list; saved-preset items come off.`)) return;
      const { error } = await sb.from('meal_plan_items').delete().eq('id', item.id);
      if (error) return toast(friendlyError(error), true);
      d.meals.splice(d.meals.findIndex((m) => m.id === item.id), 1);
      try { toast(wasPreset ? `Removed. ${syncText(await syncPresetItems(d.week, d.meals, d.items))}` : 'Removed.'); } catch (err) { toast(friendlyError(err), true); }
      close();
    } }, 'Remove') : null));
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return form;
}

/* ---------------- budget (subtle, verified prices only) ---------------- */
const money = (c) => `$${(c / 100).toFixed(2)}`;
const moneyShort = (c) => (c % 100 === 0 ? `$${c / 100}` : money(c));
const hasPrice = (it) => it.price_cents != null && it.price_source && String(it.price_source).trim();
async function budgetSummary(ws) {
  const month = ws.slice(0, 7);
  const budget = S.household?.monthly_budget_cents ?? 35000;
  const weeks = S.weeks.filter((w) => w.week_start.slice(0, 7) === month);
  const sum = { month, label: fmtD(ws, { month: 'short' }), budget, spent: 0, unpriced: 0, items: 0, week: { spent: 0, unpriced: 0, items: 0 } };
  if (!weeks.length) return sum;
  const { data, error } = await sb.from('shopping_list_items').select('week_id, price_cents, price_source').in('week_id', weeks.map((w) => w.id));
  if (error) return null;
  const cur = weeks.find((w) => w.week_start === ws)?.id;
  for (const it of data || []) {
    const priced = hasPrice(it);
    sum.items++; if (priced) sum.spent += it.price_cents; else sum.unpriced++;
    if (it.week_id === cur) { sum.week.items++; if (priced) sum.week.spent += it.price_cents; else sum.week.unpriced++; }
  }
  return sum;
}
function budgetBar(sum) {
  const pct = sum.budget > 0 ? sum.spent / sum.budget : 0;
  const tone = pct > 1 ? 'over' : pct >= 0.9 ? 'near' : 'ok';
  const fill = h('span', { class: 'budget-fill' });
  fill.style.width = `${Math.min(100, Math.round(pct * 1000) / 10)}%`; // CSSOM, allowed by the CSP
  return h('div', { class: `budget ${tone}`, role: 'group', 'aria-label': 'Monthly grocery budget' },
    h('div', { class: 'budget-text' },
      h('span', null, `${sum.label}: `, h('strong', null, money(sum.spent)), ` of ${moneyShort(sum.budget)}`),
      sum.unpriced ? h('span', { class: 'muted' }, ` · ${sum.unpriced} item${sum.unpriced === 1 ? '' : 's'} unpriced`) : null,
      tone === 'over' ? h('span', { class: 'budget-flag' }, ` · ${money(sum.spent - sum.budget)} over`) : null),
    h('span', { class: 'budget-track', 'aria-hidden': 'true' }, fill));
}

/* ---------------- staples ---------------- */
const STAPLE_CATS = ['Snacks', 'Drinks', 'Breakfast basics', 'Household', 'Other'];

async function renderStaples() {
  const content = h('div', { class: 'content' }, h('div', { class: 'card muted center' }, 'Loading staples…'));
  mount(topbar('Staples', weekPicker(renderStaples)), content, tabbar('staples'));
  const ws = S.weekStart;
  const hid = S.household.id;
  const [st, wk] = await Promise.all([
    sb.from('staples').select('*').eq('household_id', hid).order('position').order('name'),
    sb.from('weeks').select('id, status').eq('household_id', hid).eq('week_start', ws).maybeSingle(),
  ]);
  if (route().view !== 'staples' || ws !== S.weekStart) return;
  if (st.error || wk.error) return content.replaceChildren(h('div', { class: 'msg error' }, friendlyError(st.error || wk.error)));
  const staples = st.data || [];
  const week = wk.data;
  let items = [];
  if (week) {
    const r = await sb.from('shopping_list_items').select('id, name, position, staple_id').eq('week_id', week.id);
    if (r.error) return content.replaceChildren(h('div', { class: 'msg error' }, friendlyError(r.error)));
    items = r.data || [];
  }
  if (route().view !== 'staples' || ws !== S.weekStart) return;

  let editingId = null;
  const onList = (s) => items.some((i) => i.staple_id === s.id || norm(i.name) === norm(s.name));
  // a staple's verified Walmart price (if any) travels with it onto the list so it counts toward the budget
  const toRow = (s) => ({ name: s.name, quantity: s.quantity ?? null, unit: s.unit || null, category: s.category || 'Other', source: 'staple', staple_id: s.id,
    ...(hasPrice(s) ? { price_cents: s.price_cents, price_source: s.price_source, price_verified_at: s.price_verified_at || null, walmart_product_url: s.walmart_product_url || null } : {}) });
  const addStaples = async (list, btn) => {
    if (!week) return;
    btn.disabled = true;
    try { toast(listResultText(await addToList(week.id, list.map(toRow), items))); } catch (err) { toast(friendlyError(err), true); }
    btn.disabled = false; draw();
  };

  const bulkBtn = h('button', { class: 'block' });
  bulkBtn.addEventListener('click', () => addStaples(staples.filter((s) => s.active && !onList(s)), bulkBtn));
  const bulkNote = h('p', { class: 'small muted center' });
  const listWrap = h('div', { class: 'stack' });

  const staplesForm = (s, onDone) => {
    const f = {
      name: h('input', { required: true, maxlength: 200, placeholder: 'e.g. Sparkling water', value: s?.name || '', 'aria-label': 'Item' }),
      category: h('select', { 'aria-label': 'Category' }, [...new Set([...STAPLE_CATS, s?.category].filter(Boolean))].map((c) => h('option', { value: c }, c))),
      quantity: h('input', { type: 'number', min: 0, step: 'any', inputmode: 'decimal', placeholder: 'Qty', value: s?.quantity ?? '', 'aria-label': 'Quantity' }),
      unit: h('input', { maxlength: 40, placeholder: 'Unit (pack, box…)', value: s?.unit || '', 'aria-label': 'Unit' }),
    };
    f.category.value = s?.category || 'Snacks';
    const save = h('button', { type: 'submit' }, s ? 'Save' : 'Add staple');
    const form = h('form', { class: s ? 'meal-edit' : 'stack', onsubmit: async (e) => {
      e.preventDefault();
      const row = { name: f.name.value.trim(), category: f.category.value, quantity: f.quantity.value === '' ? null : Number(f.quantity.value), unit: f.unit.value.trim() || null };
      if (!row.name) return;
      save.disabled = true;
      const q = s ? sb.from('staples').update(row).eq('id', s.id)
        : sb.from('staples').insert({ ...row, household_id: hid, active: true, position: staples.reduce((m, x) => Math.max(m, x.position || 0), 0) + 1 });
      const { data, error } = await q.select().single();
      save.disabled = false;
      if (error) return toast(error.code === '23505' ? 'That staple is already on your list.' : friendlyError(error), true);
      if (s) Object.assign(s, data); else staples.push(data);
      toast(s ? 'Saved.' : 'Staple added.');
      onDone();
    } },
    s ? h('div', { class: 'mlabel' }, 'Edit staple') : h('h2', null, 'Add a staple'),
    s ? f.name : h('label', null, 'Item', f.name),
    s ? f.category : h('label', null, 'Category', f.category),
    h('div', { class: 'grid2' }, f.quantity, f.unit),
    s ? h('div', { class: 'actions' }, save, h('button', { type: 'button', class: 'secondary', onclick: onDone }, 'Cancel'), h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'ghost danger', onclick: async () => {
        if (!confirm(`Remove “${s.name}” from staples? It stays on any shopping list it’s already on.`)) return;
        const { error } = await sb.from('staples').delete().eq('id', s.id);
        if (error) return toast(friendlyError(error), true);
        staples.splice(staples.indexOf(s), 1); toast('Removed.'); onDone();
      } }, 'Remove'))
      : save);
    return form;
  };

  const stapleRow = (s) => {
    if (editingId === s.id) return staplesForm(s, () => { editingId = null; draw(); });
    const qty = [s.quantity != null ? Number(s.quantity).toString() : null, s.unit].filter(Boolean).join(' ');
    const cb = h('input', { type: 'checkbox', 'aria-label': `Include ${s.name} when adding checked items` });
    cb.checked = !!s.active;
    cb.addEventListener('change', async () => {
      const val = cb.checked; s.active = val;
      const { error } = await sb.from('staples').update({ active: val }).eq('id', s.id);
      if (error) { s.active = !val; toast(friendlyError(error), true); }
      draw();
    });
    const there = week && onList(s);
    const addBtn = week && !there ? h('button', { class: 'ghost add', 'aria-label': `Add ${s.name} to this week’s list` }, 'Add') : null;
    if (addBtn) addBtn.addEventListener('click', () => addStaples([s], addBtn));
    return h('div', { class: `item${s.active ? '' : ' inactive'}` }, cb,
      h('div', { class: 'grow' }, h('div', { class: 'name' }, s.name),
        qty || hasPrice(s) ? h('div', { class: 'small muted' }, [qty, hasPrice(s) ? `${money(s.price_cents)} at Walmart` : null].filter(Boolean).join(' · ')) : null),
      h('div', { class: 'side' },
        there ? h('span', { class: 'chip on' }, '✓ On list') : addBtn,
        h('button', { class: 'ghost', 'aria-label': `Edit ${s.name}`, onclick: () => { editingId = s.id; draw(); } }, 'Edit')));
  };

  const draw = () => {
    const pending = staples.filter((s) => s.active && !onList(s));
    if (!week) { bulkBtn.disabled = true; bulkBtn.textContent = 'Add checked to list'; bulkNote.textContent = 'No shopping list for this week yet. It appears once the meal bot plans the week.'; }
    else if (!staples.length) { bulkBtn.disabled = true; bulkBtn.textContent = 'Add checked to list'; bulkNote.textContent = 'Add a few staples below to get started.'; }
    else if (!pending.length) { bulkBtn.disabled = true; bulkBtn.textContent = 'All checked items are on the list'; bulkNote.textContent = `Adding to the ${weekLabel(ws)} list.`; }
    else { bulkBtn.disabled = false; bulkBtn.textContent = `Add ${pending.length} checked to list`; bulkNote.textContent = `Adding to the ${weekLabel(ws)} list · ${storeName()}.`; }
    const groups = new Map();
    for (const s of staples) { const k = s.category || 'Other'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    const order = (k) => { const i = STAPLE_CATS.indexOf(k); return i < 0 ? STAPLE_CATS.length - 1.5 : i; }; // custom categories sit just before Other
    const keys = [...groups.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    const cards = keys.map((k) => h('section', { class: `card aisle ${catClass(k)}` }, h('h3', null, h('span', { class: 'aisle-pill' }, k)),
      groups.get(k).sort((a, b) => (a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name)).map(stapleRow)));
    if (!staples.length) cards.push(h('div', { class: 'card muted center' }, 'No staples yet. Add snacks, drinks and household basics you buy most weeks.'));
    listWrap.replaceChildren(...cards);
  };
  const addCard = h('section', { class: 'card' });
  const resetAdd = () => addCard.replaceChildren(staplesForm(null, () => { resetAdd(); draw(); }));
  resetAdd();
  draw();
  content.replaceChildren(
    h('p', { class: 'small muted' }, 'Snacks, drinks and basics outside of meals. Check the ones you want this week, then add them to the list.'),
    h('div', { class: 'toolbar' }, bulkBtn, bulkNote),
    listWrap,
    addCard);
}

/* ---------------- recipes ---------------- */
function ingredientLine(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'object') {
    if (x.text || x.original || x.line) return String(x.text || x.original || x.line);
    const parts = [x.quantity ?? x.qty ?? x.amount, x.unit, x.name ?? x.item ?? x.ingredient].filter((p) => p != null && p !== '');
    if (parts.length) return parts.join(' ') + (x.note ? `, ${x.note}` : '');
    return JSON.stringify(x);
  }
  return String(x);
}

function renderRecipes() {
  const q = h('input', { type: 'search', placeholder: 'Search recipes or tags', value: sessionStorage.getItem('recipeQ') || '' });
  const list = h('div', { class: 'stack' });
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    sessionStorage.setItem('recipeQ', q.value);
    const rs = S.recipes.filter((r) => !term || [r.title, r.description, r.source_name, ...(r.tags || [])].join(' ').toLowerCase().includes(term));
    list.replaceChildren(...(rs.length ? rs.map((r) => {
      const mins = (r.prep_minutes || 0) + (r.cook_minutes || 0);
      return h('div', { class: 'recipe-item' },
        h('a', { class: 'card recipe-card', href: `#/recipes/${encodeURIComponent(r.id)}` },
          h('div', { class: 'title' }, r.title),
          r.description ? h('div', { class: 'desc' }, r.description) : null,
          h('div', { class: 'small muted' }, [r.source_name, mins ? `${mins} min` : null, r.servings ? `serves ${r.servings}` : null].filter(Boolean).join(' · ')),
          r.tags?.length ? h('div', { class: 'row wrap', style: null }, r.tags.map((t) => h('span', { class: 'chip tag' }, t))) : null),
        starButton(r));
    }) : [h('div', { class: 'card muted center' }, S.recipes.length ? 'No recipes match.' : 'No recipes yet. Add your favorites!')]));
  };
  q.addEventListener('input', draw);
  draw();
  mount(topbar('Recipes', h('div', { class: 'row', style: null }, q)),
    h('div', { class: 'content' },
      h('a', { class: 'btn block', href: '#/recipes/new' }, '+ Add a recipe'),
      list),
    tabbar('recipes'));
  // keep fresh in the background
  refreshRecipes().then(() => { if (route().view === 'recipes' && !route().arg) draw(); });
}

function renderRecipeForm(id) {
  const isNew = id === 'new';
  const r = isNew ? {} : S.recipes.find((x) => x.id === id);
  if (!isNew && !r) {
    mount(topbar('Recipe'), h('div', { class: 'content' }, h('div', { class: 'card stack' }, h('p', null, 'Recipe not found.'), h('a', { href: '#/recipes' }, '← Back to recipes'))), tabbar('recipes'));
    return;
  }
  const originalIngText = (r.ingredients || []).map(ingredientLine).join('\n');
  const f = {
    title: h('input', { required: true, maxlength: 200, value: r.title || '' }),
    description: h('input', { maxlength: 80, placeholder: 'e.g. Cheesy baked spaghetti made in one skillet', value: r.description || '' }),
    source_name: h('input', { maxlength: 120, placeholder: 'e.g. Mel’s Kitchen Cafe', value: r.source_name || '' }),
    source_url: h('input', { type: 'url', inputmode: 'url', placeholder: 'https://…', value: r.source_url || '' }),
    servings: h('input', { type: 'number', min: 1, inputmode: 'numeric', value: r.servings ?? '' }),
    prep_minutes: h('input', { type: 'number', min: 0, inputmode: 'numeric', value: r.prep_minutes ?? '' }),
    cook_minutes: h('input', { type: 'number', min: 0, inputmode: 'numeric', value: r.cook_minutes ?? '' }),
    tags: h('input', { placeholder: 'chicken, crockpot, kid-friendly', value: (r.tags || []).join(', ') }),
    ingredients: h('textarea', { rows: 8, placeholder: 'One ingredient per line\n1 lb ground beef\n1 can black beans' }, originalIngText),
    instructions: h('textarea', { rows: 8 }, r.instructions || ''),
    notes: h('textarea', { rows: 3 }, r.notes || ''),
  };
  const msg = h('div', { class: 'hidden' });
  const save = h('button', { type: 'submit', class: 'block' }, isNew ? 'Add recipe' : 'Save changes');
  const url = safeUrl(r.source_url || '');
  const favText = () => (r.is_favorite ? '★ Favorite' : '☆ Add to favorites');
  const favToggle = h('button', { type: 'button', class: `ghost fav-toggle${r.is_favorite ? ' on' : ''}`, 'aria-pressed': r.is_favorite ? 'true' : 'false' }, favText());
  favToggle.addEventListener('click', async () => {
    if (!(await toggleFavorite(r, favToggle))) return;
    favToggle.textContent = favText(); favToggle.className = `ghost fav-toggle${r.is_favorite ? ' on' : ''}`; favToggle.setAttribute('aria-pressed', r.is_favorite ? 'true' : 'false');
  });
  const form = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    const srcUrl = f.source_url.value.trim();
    if (srcUrl && !safeUrl(srcUrl)) { msg.className = 'msg error'; msg.textContent = 'Source URL must start with http:// or https://'; return; }
    const ingText = f.ingredients.value.replace(/\r/g, '');
    const row = {
      title: f.title.value.trim(),
      description: f.description.value.trim() || null,
      source_name: f.source_name.value.trim() || null,
      source_url: srcUrl || null,
      servings: intOrNull(f.servings.value),
      prep_minutes: intOrNull(f.prep_minutes.value),
      cook_minutes: intOrNull(f.cook_minutes.value),
      tags: listToArr(f.tags.value),
      instructions: f.instructions.value.trim() || null,
      notes: f.notes.value.trim() || null,
    };
    // keep structured ingredients from the meal bot untouched unless the text was edited
    if (isNew || ingText.trim() !== originalIngText.trim()) row.ingredients = ingText.split('\n').map((l) => l.trim()).filter(Boolean);
    save.disabled = true;
    const q = isNew ? sb.from('recipes').insert({ ...row, household_id: S.household.id }) : sb.from('recipes').update(row).eq('id', r.id);
    const { data, error } = await q.select().single();
    save.disabled = false;
    if (error) { msg.className = 'msg error'; msg.textContent = friendlyError(error); return; }
    await refreshRecipes();
    toast(isNew ? 'Recipe added.' : 'Saved.');
    location.hash = `#/recipes/${encodeURIComponent(data.id)}`;
    if (!isNew) renderRecipeForm(data.id);
  } },
  msg,
  h('label', null, 'Title *', f.title),
  h('label', null, h('span', null, 'Short description ', h('span', { class: 'hint' }, 'one line, shown on This week')), f.description),
  h('div', { class: 'grid2' }, h('label', null, 'Source', f.source_name), h('label', null, 'Servings', f.servings)),
  h('label', null, 'Source URL', f.source_url),
  h('div', { class: 'grid2' }, h('label', null, 'Prep minutes', f.prep_minutes), h('label', null, 'Cook minutes', f.cook_minutes)),
  h('label', null, h('span', null, 'Tags ', h('span', { class: 'hint' }, 'comma separated')), f.tags),
  h('label', null, h('span', null, 'Ingredients ', h('span', { class: 'hint' }, 'one per line')), f.ingredients),
  h('label', null, 'Instructions', f.instructions),
  h('label', null, 'Notes', f.notes),
  save);
  mount(topbar(isNew ? 'New recipe' : 'Edit recipe'),
    h('div', { class: 'content' },
      h('div', { class: 'row spread' }, h('a', { href: '#/recipes' }, '← All recipes'),
        h('div', { class: 'row' }, !isNew ? favToggle : null, url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open original ↗') : null)),
      form),
    tabbar('recipes'));
}

/* ---------------- breakfast & lunch presets ---------------- */
function renderPresets(arg) {
  const back = sessionStorage.getItem('presetsBack') || '#/settings';
  const backLink = h('a', { href: back }, back === '#/week' ? '← Back to This week' : '← Back to Settings');
  if (arg) return renderPresetForm(arg, back);
  const section = (type, label) => {
    const list = presetsOf(type);
    return h('section', { class: `card stack preset-group ${type}` },
      h('div', { class: 'row spread' }, h('h2', null, `${label}s`),
        list.length ? h('a', { class: 'btn small-btn', href: `#/presets/new-${type}` }, `+ Add ${label.toLowerCase()}`) : null),
      list.length
        ? list.map((p) => {
          const ings = ingList(p.ingredients);
          return h('a', { class: 'preset-row', href: `#/presets/${encodeURIComponent(p.id)}`, 'aria-label': `Edit ${p.title}` },
            h('div', { class: 'grow' }, h('div', { class: 'name' }, p.title),
              h('div', { class: 'small muted' }, ings.length ? ings.map(ingText).join(', ') : 'No ingredients yet')),
            h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'));
        })
        : h('div', { class: 'empty-presets' },
          h('p', { class: 'small muted' }, type === 'breakfast' ? 'No breakfasts saved yet. Add the ones you eat most weeks, like oatmeal or eggs and toast.' : 'No lunches saved yet. Add your go-to lunches, like sandwiches or leftovers.'),
          h('a', { class: 'btn block', href: `#/presets/new-${type}` }, `Add your first ${label.toLowerCase()}`)));
  };
  mount(topbar('Presets'),
    h('div', { class: 'content' },
      h('div', { class: 'row spread' }, backLink),
      h('p', { class: 'small muted' }, 'Saved breakfasts and lunches. Pick one for a day (or the whole week) on This week, and its ingredients are added to the shopping list, combined across days.'),
      section('breakfast', 'Breakfast'), section('lunch', 'Lunch')),
    tabbar('settings'));
}

function renderPresetForm(arg, back) {
  const isNew = arg.startsWith('new');
  const p = isNew ? { meal_type: arg === 'new-lunch' ? 'lunch' : 'breakfast', ingredients: [] } : S.presets.find((x) => x.id === arg);
  if (!p) {
    mount(topbar('Preset'), h('div', { class: 'content' }, h('div', { class: 'card stack' }, h('p', null, 'Preset not found.'), h('a', { href: '#/presets' }, '← All presets'))), tabbar('settings'));
    return;
  }
  const title = h('input', { required: true, maxlength: 200, value: p.title || '', placeholder: p.meal_type === 'lunch' ? 'e.g. Turkey sandwiches' : 'e.g. Oatmeal & berries' });
  const type = h('select', { 'aria-label': 'Meal' }, h('option', { value: 'breakfast' }, 'Breakfast'), h('option', { value: 'lunch' }, 'Lunch'));
  type.value = p.meal_type;
  const notes = h('textarea', { rows: 2, maxlength: 2000, placeholder: 'Optional notes' }, p.notes || '');
  const rowsWrap = h('div', { class: 'ing-rows' });
  const ingRow = (ing = {}) => {
    const name = h('input', { maxlength: 200, placeholder: 'Ingredient, e.g. Rolled oats', value: ing.name || '', 'aria-label': 'Ingredient name' });
    const qty = h('input', { type: 'number', min: 0, step: 'any', inputmode: 'decimal', placeholder: 'Qty per day', value: ing.quantity ?? '', 'aria-label': 'Quantity per day' });
    const unit = h('input', { maxlength: 40, placeholder: 'Unit', value: ing.unit || '', 'aria-label': 'Unit' });
    const cat = h('select', { 'aria-label': 'Aisle / category' }, [...new Set([...CATEGORIES, ing.category].filter(Boolean))].map((c) => h('option', { value: c }, c)));
    cat.value = ing.category || 'Other';
    name.addEventListener('change', () => { if (!ing.category && cat.value === 'Other') cat.value = guessCategory(name.value); });
    const el = h('div', { class: 'ing-row' }, name, h('div', { class: 'ing-grid' }, qty, unit, cat,
      h('button', { type: 'button', class: 'ghost', 'aria-label': 'Remove ingredient', onclick: () => { el.remove(); if (!rowsWrap.children.length) rowsWrap.append(ingRow()); } }, '✕')));
    el._read = () => ({ name: name.value.trim(), quantity: qty.value === '' ? null : Number(qty.value), unit: unit.value.trim() || null, category: cat.value });
    return el;
  };
  const ings = ingList(p.ingredients);
  rowsWrap.append(...(ings.length ? ings.map(ingRow) : [ingRow(), ingRow()]));
  const msg = h('div', { class: 'hidden' });
  const save = h('button', { type: 'submit', class: 'block' }, isNew ? 'Save preset' : 'Save changes');
  const form = h('form', { class: `card stack preset-form ${p.meal_type}`, onsubmit: async (e) => {
    e.preventDefault();
    const row = {
      title: title.value.trim(), meal_type: type.value, notes: notes.value.trim() || null,
      ingredients: [...rowsWrap.children].map((el) => el._read()).filter((i) => i.name),
    };
    if (!row.title) { msg.className = 'msg error'; msg.textContent = 'Give it a name.'; title.focus(); return; }
    if (row.ingredients.some((i) => i.quantity != null && !(i.quantity >= 0))) { msg.className = 'msg error'; msg.textContent = 'Quantities must be zero or more.'; return; }
    save.disabled = true;
    const q = isNew
      ? sb.from('meal_presets').insert({ ...row, household_id: S.household.id, position: S.presets.reduce((m, x) => Math.max(m, x.position || 0), 0) + 1 })
      : sb.from('meal_presets').update(row).eq('id', p.id);
    const { error } = await q.select().single();
    save.disabled = false;
    if (error) { msg.className = 'msg error'; msg.textContent = error.code === '23505' ? 'You already have a preset with that name.' : friendlyError(error); return; }
    await refreshPresets();
    toast(isNew ? 'Preset saved.' : 'Saved.');
    location.hash = back === '#/week' && isNew ? '#/week' : '#/presets';
  } },
  msg,
  h('label', null, 'Name', title),
  h('label', null, 'Meal', type),
  h('div', { class: 'stack' }, h('div', { class: 'label-like' }, 'Ingredients ', h('span', { class: 'hint' }, 'amount for one day; picking several days adds them up')), rowsWrap,
    h('button', { type: 'button', class: 'secondary', onclick: () => { const r = ingRow(); rowsWrap.append(r); r.querySelector('input').focus(); } }, '+ Add ingredient')),
  h('label', null, 'Notes', notes),
  !isNew ? h('p', { class: 'small muted' }, 'Days you already picked keep the ingredients they had. Pick the preset again to use these changes.') : null,
  save,
  !isNew ? h('button', { type: 'button', class: 'ghost danger block', onclick: async () => {
    if (!confirm(`Delete “${p.title}”? Days already planned with it, and their shopping items, stay as they are.`)) return;
    const { error } = await sb.from('meal_presets').delete().eq('id', p.id);
    if (error) return toast(friendlyError(error), true);
    await refreshPresets(); toast('Preset deleted.'); location.hash = '#/presets';
  } }, 'Delete preset') : null);
  mount(topbar(isNew ? `New ${p.meal_type}` : 'Edit preset'),
    h('div', { class: 'content' }, h('div', { class: 'row spread' }, h('a', { href: '#/presets' }, '← All presets')), form),
    tabbar('settings'));
  if (isNew) title.focus();
}

/* ---------------- push notifications ---------------- */
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function b64urlToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function swRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('sw.js'));
  return reg;
}
async function currentPushSub() {
  try { const reg = await swRegistration(); return reg ? await reg.pushManager.getSubscription() : null; } catch { return null; }
}
async function savePushSub(sub) {
  const j = sub.toJSON();
  const row = { user_id: S.session.user.id, household_id: S.household.id, endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, user_agent: navigator.userAgent.slice(0, 300) };
  const { error } = await sb.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' });
  if (error) throw error;
}
// best effort: this device stops getting this account's notifications (used on sign out)
async function forgetPushSub() {
  const sub = await currentPushSub();
  if (!sub) return;
  try { await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); } catch { /* ignore */ }
  try { await sub.unsubscribe(); } catch { /* ignore */ }
}
function notificationsCard() {
  const body = h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Checking this device…'));
  const card = h('section', { class: 'card stack', id: 'notifications' }, h('h2', null, 'Notifications'),
    h('p', { class: 'small muted' }, 'Get a notification on this device when someone swaps a dinner, asks for changes, or everyone approves the week.'),
    body);
  const note = (text, cls = 'small muted') => h('p', { class: cls }, text);
  const draw = async () => {
    if (isIOS() && !isStandalone()) {
      body.replaceChildren(h('div', { class: 'msg info' },
        h('strong', null, 'On iPhone, add Meals to your Home Screen first.'),
        h('ol', { class: 'steps' },
          h('li', null, 'In Safari, tap the Share button (the square with an arrow).'),
          h('li', null, 'Tap “Add to Home Screen”, then “Add”.'),
          h('li', null, 'Open Meals from your Home Screen, sign in, and come back here.')),
        h('div', { class: 'small' }, 'Needs iOS 16.4 or newer.')));
      return;
    }
    if (!pushSupported()) { body.replaceChildren(note('This browser doesn’t support notifications. Try Chrome, Edge, Firefox, or Safari (on iPhone, from the Home Screen app).')); return; }
    if (Notification.permission === 'denied') {
      body.replaceChildren(note(isIOS() ? 'Notifications are blocked for Meals. Turn them on in the iPhone Settings app → Notifications → Meals, then come back.'
        : 'Notifications are blocked for this site. Allow them in your browser’s site settings, then reload.', 'msg error'));
      return;
    }
    const sub = Notification.permission === 'granted' ? await currentPushSub() : null;
    if (sub) {
      savePushSub(sub).catch(() => {}); // keep the server copy in sync (it is removed if the push service drops it)
      const test = h('button', { type: 'button', class: 'secondary' }, 'Send a test notification');
      const off = h('button', { type: 'button', class: 'ghost danger' }, 'Turn off on this device');
      test.addEventListener('click', async () => {
        test.disabled = true;
        try {
          const { data, error } = await sb.functions.invoke('push-notify', { body: { action: 'test' } });
          if (error) throw error;
          toast(data?.sent ? 'Test sent. It should arrive in a few seconds.' : 'Couldn’t reach this device. Try turning notifications off and on again.', !data?.sent);
          if (!data?.sent) draw();
        } catch (err) { toast(friendlyError(err), true); }
        test.disabled = false;
      });
      off.addEventListener('click', async () => {
        off.disabled = true;
        const { error } = await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        if (error) { off.disabled = false; return toast(friendlyError(error), true); }
        try { await sub.unsubscribe(); } catch { /* ignore */ }
        toast('Notifications are off on this device.');
        draw();
      });
      body.replaceChildren(h('div', { class: 'row notif-on' }, h('span', { class: 'chip makes' }, 'On'), h('span', { class: 'small' }, 'This device gets notifications.')),
        h('div', { class: 'row wrap' }, test, off));
      return;
    }
    const on = h('button', { type: 'button', class: 'block' }, 'Turn on notifications');
    on.addEventListener('click', async () => {
      on.disabled = true;
      try {
        const perm = await Notification.requestPermission(); // must come straight from the tap
        if (perm !== 'granted') { toast(perm === 'denied' ? 'Notifications were blocked.' : 'Notifications weren’t allowed.', true); return draw(); }
        const reg = await swRegistration();
        await navigator.serviceWorker.ready;
        const s2 = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(VAPID_PUBLIC_KEY) }));
        await savePushSub(s2);
        toast('Notifications are on for this device.');
      } catch (err) {
        console.warn('push subscribe', err);
        toast(err?.code && /^\d|^[A-Z]{2}\d/.test(err.code) ? friendlyError(err) : `Couldn’t turn on notifications on this device.${err?.message ? ' ' + err.message : ''}`, true);
      }
      on.disabled = false;
      draw();
    });
    body.replaceChildren(on, note('You can turn them off here anytime. Each phone or computer is set up separately.'));
  };
  draw();
  return card;
}

/* ---------------- settings ---------------- */
function renderSettings() {
  const hh = S.household;
  const isOwner = S.member.role === 'owner';
  const f = {
    dinners_per_week: h('input', { type: 'number', min: 0, max: 7, inputmode: 'numeric', value: hh.dinners_per_week }),
    leftover_nights_per_week: h('input', { type: 'number', min: 0, max: 7, inputmode: 'numeric', value: hh.leftover_nights_per_week }),
    default_plates: h('input', { type: 'number', min: 1, max: 20, inputmode: 'numeric', value: hh.default_plates }),
    approval_mode: h('select', null,
      h('option', { value: 'multi' }, 'Everyone approves (multi)'),
      h('option', { value: 'solo' }, 'One approval is enough (solo)')),
    dietary_exclusions: h('input', { placeholder: 'seafood, mushrooms', value: (hh.dietary_exclusions || []).join(', ') }),
    preferred_stores: h('input', { placeholder: 'Walmart', value: (hh.preferred_stores || []).join(', ') }),
    monthly_budget: h('input', { type: 'number', min: 0, max: 100000, step: 1, inputmode: 'decimal', value: ((hh.monthly_budget_cents ?? 35000) / 100).toString(), 'aria-label': 'Monthly grocery budget in dollars' }),
  };
  f.approval_mode.value = hh.approval_mode;
  const msg = h('div', { class: 'hidden' });
  const save = h('button', { type: 'submit', class: 'block' }, 'Save settings');
  const form = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    const row = {
      dinners_per_week: intOrNull(f.dinners_per_week.value),
      leftover_nights_per_week: intOrNull(f.leftover_nights_per_week.value),
      default_plates: intOrNull(f.default_plates.value),
      approval_mode: f.approval_mode.value,
      dietary_exclusions: listToArr(f.dietary_exclusions.value),
      preferred_stores: listToArr(f.preferred_stores.value),
      monthly_budget_cents: f.monthly_budget.value.trim() === '' ? null : Math.round(Number(f.monthly_budget.value) * 100),
    };
    if (row.monthly_budget_cents == null || !Number.isFinite(row.monthly_budget_cents) || row.monthly_budget_cents < 0) {
      msg.className = 'msg error'; msg.textContent = 'Monthly budget should be a dollar amount, like 350.'; return;
    }
    if ([row.dinners_per_week, row.leftover_nights_per_week, row.default_plates].some((v) => v == null)) {
      msg.className = 'msg error'; msg.textContent = 'Please fill in all the numbers.'; return;
    }
    save.disabled = true;
    const { data, error } = await sb.from('households').update(row).eq('id', hh.id).select();
    save.disabled = false;
    if (error) { msg.className = 'msg error'; msg.textContent = friendlyError(error); return; }
    if (!data?.length) { msg.className = 'msg error'; msg.textContent = "Couldn't save. You may not have permission to change household settings."; return; }
    S.household = data[0];
    msg.className = 'msg ok'; msg.textContent = 'Saved.';
    toast('Settings saved.');
  } },
  h('h2', null, 'Meal plan'),
  msg,
  h('div', { class: 'grid2' }, h('label', null, 'Dinners / week', f.dinners_per_week), h('label', null, 'Leftover nights', f.leftover_nights_per_week)),
  h('label', null, 'Default plates', f.default_plates),
  h('label', null, 'Approval mode', f.approval_mode),
  h('label', null, h('span', null, 'Dietary exclusions ', h('span', { class: 'hint' }, 'comma separated')), f.dietary_exclusions),
  h('label', null, h('span', null, 'Preferred stores ', h('span', { class: 'hint' }, 'comma separated')), f.preferred_stores),
  h('label', null, h('span', null, 'Monthly grocery budget ', h('span', { class: 'hint' }, 'dollars, shown as a slim bar on This week and Shopping')),
    h('div', { class: 'money-input' }, h('span', { 'aria-hidden': 'true' }, '$'), f.monthly_budget)),
  save);

  const nB = presetsOf('breakfast').length; const nL = presetsOf('lunch').length;
  const presetsCard = h('section', { class: 'card stack tint-meals' }, h('h2', null, 'Breakfast & lunch presets'),
    h('p', { class: 'small muted' }, nB + nL ? `${nB} breakfast${nB === 1 ? '' : 's'} and ${nL} lunch${nL === 1 ? '' : 'es'} saved. Pick them on This week in one tap; their ingredients go to the shopping list.`
      : 'Save the breakfasts and lunches you have most weeks, with their ingredients, so you never have to type them again.'),
    h('a', { class: 'btn block', href: '#/presets', onclick: () => sessionStorage.setItem('presetsBack', '#/settings') }, nB + nL ? 'Edit presets' : 'Add your first breakfast'));

  const membersCard = h('section', { class: 'card stack' }, h('h2', null, 'Members'),
    S.members.map((m) => h('div', { class: 'row spread' },
      h('div', null, h('strong', null, m.display_name), m.id === S.member.id ? h('span', { class: 'muted small' }, ' (you)') : null,
        h('div', { class: 'small muted' }, [m.role === 'owner' ? 'Owner' : 'Member', m.is_voter ? 'votes' : 'doesn’t vote', m.user_id ? 'signed up' : 'invited'].join(' · '))))));

  mount(topbar('Settings'),
    h('div', { class: 'content' },
      form,
      presetsCard,
      membersCard,
      notificationsCard(),
      h('section', { class: 'card stack' }, h('h2', null, 'Account'),
        h('div', { class: 'small' }, 'Signed in as ', h('strong', null, S.session.user.email), isOwner ? ' · household owner' : ''),
        h('div', { class: 'small muted' }, `Household timezone: ${hh.timezone || HOUSEHOLD_TZ}`),
        h('button', { class: 'secondary block', onclick: async () => { await forgetPushSub(); await sb.auth.signOut(); location.hash = '#/week'; } }, 'Sign out')),
      h('p', { class: 'small muted center' }, 'No tracking, no ads. Your data lives in your household’s Supabase project.')),
    tabbar('settings'));
}

/* refresh when the app comes back to the foreground */
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !S.member) return;
  const { view, arg } = route();
  if (view === 'recipes' && arg) return; // don't clobber an open form
  if (view === 'presets') return;
  if (appEl.querySelector('.picker')) return; // the preset picker is open
  if (view === 'settings') return;
  if (appEl.querySelector('.meal-edit')) return; // an inline editor is open
  const ae = document.activeElement;
  if (ae && appEl.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return; // mid-typing
  await refreshWeeks();
  render();
});

boot().catch((err) => mount(h('div', { class: 'boot' }, h('div', { class: 'msg error' }, friendlyError(err)))));
