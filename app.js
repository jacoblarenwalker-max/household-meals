import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, HOUSEHOLD_TZ } from './config.js';

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
async function boot() {
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
  S.member = null; S.household = null; S.members = []; S.weeks = []; S.recipes = [];
  if (!S.session) return;
  const uid = S.session.user.id;
  const { data: mem, error } = await sb.from('household_members').select('*').eq('user_id', uid).limit(1);
  if (error) { toast(friendlyError(error), true); return; }
  S.member = mem?.[0] || null;
  if (!S.member) return;
  const hid = S.member.household_id;
  const [hh, mems, wks, recs] = await Promise.all([
    sb.from('households').select('*').eq('id', hid).single(),
    sb.from('household_members').select('id, display_name, role, is_voter, user_id, invite_email').eq('household_id', hid).order('created_at'),
    sb.from('weeks').select('id, week_start, status, locked_at').eq('household_id', hid).order('week_start', { ascending: false }).limit(60),
    sb.from('recipes').select('*').eq('household_id', hid).order('title'),
  ]);
  for (const r of [hh, mems, wks, recs]) if (r.error) toast(friendlyError(r.error), true);
  S.household = hh.data || null;
  S.members = mems.data || [];
  S.weeks = wks.data || [];
  S.recipes = recs.data || [];
  if (!S.weekStart) S.weekStart = sessionStorage.getItem('weekStart') || defaultWeekStart();
}
async function refreshWeeks() {
  const { data } = await sb.from('weeks').select('id, week_start, status, locked_at').eq('household_id', S.household.id).order('week_start', { ascending: false }).limit(60);
  if (data) S.weeks = data;
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
  if (view === 'recipes') return arg ? renderRecipeForm(arg) : renderRecipes();
  if (view === 'settings') return renderSettings();
  return renderWeek();
}

/* simple line icons for the tab bar (inline SVG, built with DOM APIs) */
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  week: [['rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 3 }], ['path', { d: 'M3.5 10h17M8 3v4M16 3v4' }]],
  shop: [['path', { d: 'M3 4h2.2l2.1 10.1a2 2 0 0 0 2 1.6h7.5a2 2 0 0 0 1.9-1.4L20.5 8H6.3' }], ['circle', { cx: 10, cy: 20, r: 1.3 }], ['circle', { cx: 17, cy: 20, r: 1.3 }]],
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
    tab('week', 'This week'), tab('shop', 'Shopping'), tab('recipes', 'Recipes'), tab('settings', 'Settings')));
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
    h('div', { class: 'hero' }, h('img', { src: 'icon.svg', alt: '' }), h('h1', null, 'Household Meals'), h('p', { class: 'muted' }, 'Plan dinners together, vote, and shop.')),
    form));
}

function renderUnlinked() {
  const email = S.session.user.email;
  mount(h('main', { class: 'auth' },
    h('div', { class: 'hero' }, h('img', { src: 'icon.svg', alt: '' }), h('h1', null, 'Almost there')),
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
  if (!week) return { week: null, slots: [], votes: [] };
  const [slots, votes] = await Promise.all([
    sb.from('week_slots').select('*, recipe:recipes(id, title, source_url, source_name)').eq('week_id', week.id).order('date').order('position'),
    sb.from('votes').select('*').eq('week_id', week.id),
  ]);
  if (slots.error) throw slots.error;
  if (votes.error) throw votes.error;
  return { week, slots: slots.data, votes: votes.data };
}

async function renderWeek() {
  const content = h('div', { class: 'content' }, h('div', { class: 'card muted center' }, 'Loading this week…'));
  mount(topbar('Dinners', weekPicker(renderWeek)), content, tabbar('week'));
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
  if (!d.week) {
    parts.push(h('div', { class: 'card stack center' },
      h('h2', null, 'No plan for this week yet'),
      h('p', { class: 'muted' }, 'The meal bot hasn’t drafted dinners for this week. Tap “Check now” to ask it to sync.')));
  } else {
    const st = d.week.status;
    parts.push(h('div', { class: `status-banner ${st}` },
      h('strong', null, STATUS[st]?.label || st),
      h('div', { class: 'small' }, STATUS[st]?.text || ''),
      st === 'locked' && d.week.locked_at ? h('div', { class: 'small muted' }, `Locked ${fmtTs(d.week.locked_at)}`) : null));
    parts.push(nightsCard(ws, d.slots));
    parts.push(votesCard(d));
  }
  parts.push(checkNowCard(d.week));
  content.replaceChildren(...parts);
}

function nightsCard(ws, slots) {
  const byId = Object.fromEntries(slots.map((s) => [s.id, s]));
  const today = todayISO();
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(ws, i);
    const daySlots = slots.filter((s) => s.date === date);
    const dayCol = h('div', { class: 'day' }, h('div', { class: 'dow' }, fmtD(date, { weekday: 'short' })), h('div', { class: 'dom' }, fmtD(date, { day: 'numeric' })));
    if (!daySlots.length) {
      rows.push(h('div', { class: `night empty${date === today ? ' today' : ''}` }, dayCol, h('div', null, h('div', { class: 'title' }, 'Nothing planned'))));
      continue;
    }
    const body = daySlots.map((s) => {
      const from = s.leftover_from_slot_id ? byId[s.leftover_from_slot_id] : null;
      const recipe = s.recipe || from?.recipe || null;
      const url = recipe?.source_url ? safeUrl(recipe.source_url) : null;
      const title = recipe ? (url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, recipe.title) : recipe.title)
        : (s.is_leftover_night ? 'Leftovers' : 'Dinner TBD');
      return h('div', { class: 'stack', style: null },
        h('div', { class: 'title' }, title),
        h('div', { class: 'meta' },
          s.is_leftover_night ? h('span', { class: 'chip left' }, 'Leftover night') : null,
          s.makes_leftovers ? h('span', { class: 'chip makes' }, 'Makes leftovers') : null,
          h('span', { class: 'small muted' }, `${s.plates} plate${s.plates === 1 ? '' : 's'}`),
          recipe?.source_name ? h('span', { class: 'small muted' }, `· ${recipe.source_name}`) : null,
          from ? h('span', { class: 'small muted' }, `· from ${fmtD(from.date, { weekday: 'long' })}`) : null),
        s.notes ? h('div', { class: 'small muted' }, s.notes) : null);
    });
    rows.push(h('div', { class: `night${date === today ? ' today' : ''}` }, dayCol, h('div', { class: 'stack' }, body)));
  }
  return h('section', { class: 'card' }, rows);
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
const CATEGORIES = ['Produce', 'Meat', 'Dairy & Eggs', 'Bakery', 'Pantry', 'Canned Goods', 'Spices & Baking', 'Frozen', 'Snacks', 'Beverages', 'Household', 'Other'];
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
  const { data: items, error: e2 } = await sb.from('shopping_list_items').select('*').eq('week_id', week.id).order('position').order('name');
  if (e2) return content.replaceChildren(h('div', { class: 'msg error' }, friendlyError(e2)));
  if (route().view !== 'shop' || ws !== S.weekStart) return;
  const recipeTitle = Object.fromEntries(S.recipes.map((r) => [r.id, r.title]));
  const store = S.household.preferred_stores?.[0] || 'Walmart';

  const listWrap = h('div', { class: 'stack' });
  const counter = h('span', { class: 'small muted' });
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
      cards.push(h('section', { class: 'card aisle' }, h('h3', null, k), its.map(itemRow)));
    }
    if (!items.length) cards.push(h('div', { class: 'card muted center' }, 'No items yet. Add one below, or tap Check now.'));
    else if (!cards.length) cards.push(h('div', { class: 'card muted center' }, 'Everything is checked off. Nice work!'));
    listWrap.replaceChildren(...cards);
  };
  const itemRow = (it) => {
    const qty = [it.quantity != null ? Number(it.quantity).toString() : null, it.unit].filter(Boolean).join(' ');
    const hasPrice = it.price_cents != null && it.price_source && String(it.price_source).trim();
    const cb = h('input', { type: 'checkbox', 'aria-label': `Got ${it.name}` });
    cb.checked = !!it.checked;
    const row = h('div', { class: `item${it.checked ? ' done' : ''}` }, cb,
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, it.name, qty ? h('span', { class: 'muted small' }, ` · ${qty}`) : null),
        it.recipe_id && recipeTitle[it.recipe_id] ? h('div', { class: 'small muted' }, `For ${recipeTitle[it.recipe_id]}`) : null,
        hasPrice ? h('div', { class: 'price' }, `$${(it.price_cents / 100).toFixed(2)} · ${it.price_source}${it.price_verified_at ? ' · checked ' + fmtTs(it.price_verified_at) : ''}`) : null),
      h('button', { class: 'ghost', 'aria-label': `Remove ${it.name}`, onclick: async () => {
        if (!confirm(`Remove “${it.name}” from the list?`)) return;
        const { error } = await sb.from('shopping_list_items').delete().eq('id', it.id);
        if (error) return toast(friendlyError(error), true);
        items.splice(items.indexOf(it), 1); draw();
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
      unit: unit.value.trim() || null, category: cat.value.trim() || 'Other', store, position: maxPos + 1,
    }).select().single();
    addBtn.disabled = false;
    if (error) return toast(friendlyError(error), true);
    items.push(data); name.value = ''; qty.value = ''; unit.value = '';
    draw(); toast('Added.');
  } },
  h('h2', null, 'Add an item'), h('label', null, 'Item', name), h('div', { class: 'grid2' }, qty, unit), cat, catList, addBtn);

  const hideBtn = h('button', { class: 'ghost' }, hideChecked ? 'Show checked' : 'Hide checked');
  hideBtn.addEventListener('click', () => { hideChecked = !hideChecked; sessionStorage.setItem('hideChecked', hideChecked ? '1' : '0'); hideBtn.textContent = hideChecked ? 'Show checked' : 'Hide checked'; draw(); });

  draw();
  content.replaceChildren(
    h('div', { class: 'row spread' }, h('div', null, h('strong', null, store), ' ', counter), hideBtn),
    listWrap, addForm, checkNowCard(week),
    h('p', { class: 'small muted center' }, 'Prices only show when the meal bot has a verified price with a source.'));
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
    const rs = S.recipes.filter((r) => !term || [r.title, r.source_name, ...(r.tags || [])].join(' ').toLowerCase().includes(term));
    list.replaceChildren(...(rs.length ? rs.map((r) => {
      const mins = (r.prep_minutes || 0) + (r.cook_minutes || 0);
      return h('a', { class: 'card recipe-card', href: `#/recipes/${encodeURIComponent(r.id)}` },
        h('div', { class: 'title' }, r.title),
        h('div', { class: 'small muted' }, [r.source_name, mins ? `${mins} min` : null, r.servings ? `serves ${r.servings}` : null].filter(Boolean).join(' · ')),
        r.tags?.length ? h('div', { class: 'row wrap', style: null }, r.tags.map((t) => h('span', { class: 'chip tag' }, t))) : null);
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
  const form = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    const srcUrl = f.source_url.value.trim();
    if (srcUrl && !safeUrl(srcUrl)) { msg.className = 'msg error'; msg.textContent = 'Source URL must start with http:// or https://'; return; }
    const ingText = f.ingredients.value.replace(/\r/g, '');
    const row = {
      title: f.title.value.trim(),
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
      h('div', { class: 'row spread' }, h('a', { href: '#/recipes' }, '← All recipes'), url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open original ↗') : null),
      form),
    tabbar('recipes'));
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
    };
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
  save);

  const membersCard = h('section', { class: 'card stack' }, h('h2', null, 'Members'),
    S.members.map((m) => h('div', { class: 'row spread' },
      h('div', null, h('strong', null, m.display_name), m.id === S.member.id ? h('span', { class: 'muted small' }, ' (you)') : null,
        h('div', { class: 'small muted' }, [m.role === 'owner' ? 'Owner' : 'Member', m.is_voter ? 'votes' : 'doesn’t vote', m.user_id ? 'signed up' : 'invited'].join(' · '))))));

  mount(topbar('Settings'),
    h('div', { class: 'content' },
      form,
      membersCard,
      h('section', { class: 'card stack' }, h('h2', null, 'Account'),
        h('div', { class: 'small' }, 'Signed in as ', h('strong', null, S.session.user.email), isOwner ? ' · household owner' : ''),
        h('div', { class: 'small muted' }, `Household timezone: ${hh.timezone || HOUSEHOLD_TZ}`),
        h('button', { class: 'secondary block', onclick: async () => { await sb.auth.signOut(); location.hash = '#/week'; } }, 'Sign out')),
      h('p', { class: 'small muted center' }, 'No tracking, no ads. Your data lives in your household’s Supabase project.')),
    tabbar('settings'));
}

/* refresh when the app comes back to the foreground */
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !S.member) return;
  const { view, arg } = route();
  if (view === 'recipes' && arg) return; // don't clobber an open form
  if (view === 'settings') return;
  await refreshWeeks();
  render();
});

boot().catch((err) => mount(h('div', { class: 'boot' }, h('div', { class: 'msg error' }, friendlyError(err)))));
