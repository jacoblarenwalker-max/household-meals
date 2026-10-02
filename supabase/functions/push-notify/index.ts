// push-notify: sends Web Push notifications to household members.
// Callers:
//   * the database (pg_net trigger on app_events) with header x-push-secret -> { event_id }
//     (swap / needs_work / week_locked, and the Sunday 8 PM vote_reminder written by pg_cron)
//   * a signed-in app user (Authorization: Bearer <user JWT>) -> { action: 'test' } sends to their own devices only
// Secrets (VAPID private key, webhook secret) live in Supabase Vault; nothing secret is in the repo.
import postgres from 'npm:postgres@3.4.5';
import { generateVapidKeys, sendWebPush } from './webpush.js';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 2, idle_timeout: 20 });
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://voydoxmxdnjnewxlwzse.supabase.co';
const PUBLIC_API_KEY = Deno.env.get('SUPABASE_ANON_KEY') || 'sb_publishable_FO-tgfKuBTb19W8GaX1qZw_dtZRRdqY';
const SUBJECT = 'mailto:jacoblarenwalker-max@users.noreply.github.com';
const ALLOWED_ORIGINS = ['https://jacoblarenwalker-max.github.io', 'http://127.0.0.1:8765', 'http://localhost:8000'];

const corsFor = (req: Request) => {
  const o = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
};
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsFor(req), 'Content-Type': 'application/json' } });

async function vaultSecret(name: string): Promise<string | null> {
  const r = await sql`select decrypted_secret from vault.decrypted_secrets where name = ${name} limit 1`;
  return r[0]?.decrypted_secret ?? null;
}
function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

let vapidCache: { privateJwk: JsonWebKey; publicKey: string; subject: string } | null = null;
async function vapid() {
  if (vapidCache) return vapidCache;
  const [jwk, pub] = await Promise.all([vaultSecret('push_vapid_private_jwk'), vaultSecret('push_vapid_public_key')]);
  if (!jwk || !pub) throw new Error('VAPID keys not initialised');
  vapidCache = { privateJwk: JSON.parse(jwk), publicKey: pub, subject: SUBJECT };
  return vapidCache;
}
// one-time: create the VAPID key pair inside Supabase so the private key never leaves Vault
async function initVapid() {
  const existing = await vaultSecret('push_vapid_public_key');
  if (existing) return { created: false, publicKey: existing };
  const k = await generateVapidKeys();
  await sql`select vault.create_secret(${JSON.stringify(k.privateJwk)}, 'push_vapid_private_jwk', 'Web Push VAPID private key (JWK) for push-notify')`;
  await sql`select vault.create_secret(${k.publicKey}, 'push_vapid_public_key', 'Web Push VAPID public key')`;
  return { created: true, publicKey: k.publicKey };
}

type Sub = { id: string; endpoint: string; keys: { p256dh: string; auth: string } };
async function deliver(subs: Sub[], message: Record<string, unknown>, topic?: string) {
  const v = await vapid();
  const payload = JSON.stringify(message);
  let sent = 0, failed = 0, removed = 0;
  const results: unknown[] = [];
  for (const s of subs) {
    try {
      const r = await sendWebPush(s, payload, v, { topic });
      results.push({ id: s.id, status: r.status });
      if (r.ok) { sent++; await sql`update public.push_subscriptions set last_success_at = now() where id = ${s.id}`; }
      else if (r.gone) { removed++; await sql`delete from public.push_subscriptions where id = ${s.id}`; }
      else { failed++; console.warn('push failed', r.status, r.text); }
    } catch (e) {
      failed++; results.push({ id: s.id, error: String(e) }); console.warn('push error', String(e));
    }
  }
  return { sent, failed, removed, results };
}

const weekday = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
const shortDate = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

async function notifyEvent(eventId: string) {
  const [ev] = await sql`select id, household_id, week_id, event_type, payload from public.app_events where id = ${eventId}`;
  if (!ev) return { status: 404, body: { error: 'event not found' } };
  const p = (ev.payload || {}) as Record<string, any>;
  const isSwap = ev.event_type === 'check_now' && p.source === 'dinner_swap';
  const isReminder = ev.event_type === 'vote_reminder';
  if (!isSwap && !isReminder && ev.event_type !== 'week_locked' && ev.event_type !== 'needs_work') return { status: 200, body: { skipped: 'not a notifying event' } };
  const claimed = await sql`insert into public.push_notified_events (event_id, event_type) values (${ev.id}, ${ev.event_type}) on conflict do nothing returning event_id`;
  if (!claimed.length) return { status: 200, body: { skipped: 'already notified' } };
  if (isReminder) return { status: 200, body: await notifyReminder(ev, p) };

  const weekStart: string = p.week_start || '';
  const url = weekStart ? `./?week=${weekStart}#/week` : './#/week';
  let actorUser: string | null = null;
  let title = '', body = '';
  if (isSwap) {
    actorUser = p.requested_by_user_id || null;
    const [who] = actorUser ? await sql`select display_name from public.household_members where user_id = ${actorUser} and household_id = ${ev.household_id} limit 1` : [];
    const [rec] = p.new_recipe_id ? await sql`select title from public.recipes where id = ${p.new_recipe_id}` : [];
    const name = who?.display_name || 'Someone';
    const day = p.date ? weekday(p.date) : 'a night';
    title = 'Dinner plan changed';
    body = rec ? `${name} swapped ${day} to ${rec.title}.` : `${name} changed ${day}’s dinner.`;
    body += p.previous_status === 'draft' ? '' : ' Tap to re-approve.';
  } else if (ev.event_type === 'needs_work') {
    const [m] = p.member_id ? await sql`select user_id, display_name from public.household_members where id = ${p.member_id}` : [];
    actorUser = m?.user_id || null;
    title = 'Dinner plan needs work';
    body = `${m?.display_name || p.member_name || 'Someone'} asked for changes${weekStart ? ` to the week of ${shortDate(weekStart)}` : ''}`;
    body += p.comment ? `: “${clip(String(p.comment), 90)}”` : '.';
  } else {
    // locked: skip whoever cast the final approval (they just saw it happen)
    const [last] = ev.week_id ? await sql`select m.user_id from public.votes v join public.household_members m on m.id = v.member_id where v.week_id = ${ev.week_id} and v.decision = 'approve' order by v.updated_at desc nulls last limit 1` : [];
    actorUser = last?.user_id || null;
    title = 'Dinner plan locked';
    body = `Everyone approved${weekStart ? ` the week of ${shortDate(weekStart)}` : ' this week'}. Tap to see the plan.`;
  }
  const subs = await sql`select id, endpoint, keys from public.push_subscriptions where household_id = ${ev.household_id} and (${actorUser}::uuid is null or user_id <> ${actorUser}::uuid)` as unknown as Sub[];
  const out = subs.length ? await deliver(subs, { title, body, url, tag: `week-${ev.week_id || 'x'}` }, `week-${String(ev.week_id || 'x').slice(0, 20)}`) : { sent: 0, failed: 0, removed: 0, results: [] };
  await sql`update public.push_notified_events set recipients = ${subs.length}, sent = ${out.sent}, failed = ${out.failed}, removed = ${out.removed} where event_id = ${ev.id}`;
  return { status: 200, body: { event_type: ev.event_type, title, message: body, recipients: subs.length, ...out } };
}

// Sunday vote reminder (private.send_vote_reminders): the database already chose the recipients
// (payload.user_ids) and the text; payload.dry_run = true means work out who would get it but send nothing.
async function notifyReminder(ev: Record<string, any>, p: Record<string, any>) {
  const dryRun = p.dry_run === true || p.dry_run === 'true';
  const title = String(p.title || 'Household Meals');
  const body = String(p.body || '');
  const url = typeof p.url === 'string' && p.url.startsWith('./') ? p.url : './#/week';
  const subs = await sql`select s.id, s.endpoint, s.keys from public.push_subscriptions s
    where s.household_id = ${ev.household_id}
      and s.user_id in (select (jsonb_array_elements_text(coalesce(e.payload->'user_ids', '[]'::jsonb)))::uuid
                        from public.app_events e where e.id = ${ev.id})` as unknown as Sub[];
  const none = { sent: 0, failed: 0, removed: 0, results: [] as unknown[] };
  const out = !dryRun && subs.length ? await deliver(subs, { title, body, url, tag: `vote-${p.week_start || 'x'}` }, 'vote-reminder') : none;
  await sql`update public.push_notified_events set recipients = ${subs.length}, sent = ${out.sent}, failed = ${out.failed}, removed = ${out.removed} where event_id = ${ev.id}`;
  return { event_type: ev.event_type, kind: p.kind, dry_run: dryRun, title, message: body, url, recipients: subs.length, ...(dryRun ? { would_send: subs.length } : {}), ...out };
}

async function userFromToken(token: string): Promise<string | null> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: PUBLIC_API_KEY } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u?.id || null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) });
  if (req.method !== 'POST') return json(req, 405, { error: 'POST only' });
  let input: Record<string, any> = {};
  try { input = await req.json(); } catch { return json(req, 400, { error: 'bad json' }); }
  try {
    const given = req.headers.get('x-push-secret') || '';
    if (given) {
      const expected = await vaultSecret('push_webhook_secret');
      if (!expected || !sameSecret(given, expected)) return json(req, 401, { error: 'unauthorized' });
      if (input.action === 'init') return json(req, 200, await initVapid());
      if (input.action === 'send_user' && input.user_id) {
        const subs = await sql`select id, endpoint, keys from public.push_subscriptions where user_id = ${input.user_id}::uuid` as unknown as Sub[];
        return json(req, 200, { recipients: subs.length, ...(await deliver(subs, { title: input.title || 'Household Meals', body: input.body || 'Test notification', url: './#/week', tag: 'test' })) });
      }
      if (input.event_id) { const r = await notifyEvent(String(input.event_id)); return json(req, r.status, r.body); }
      return json(req, 400, { error: 'unknown action' });
    }
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const uid = token ? await userFromToken(token) : null;
    if (!uid) return json(req, 401, { error: 'sign in first' });
    if (input.action === 'test') {
      const subs = await sql`select id, endpoint, keys from public.push_subscriptions where user_id = ${uid}::uuid` as unknown as Sub[];
      if (!subs.length) return json(req, 404, { error: 'no devices with notifications on' });
      const out = await deliver(subs, { title: 'Household Meals', body: 'Notifications are working on this device.', url: './#/settings', tag: 'test' });
      return json(req, 200, { recipients: subs.length, sent: out.sent, failed: out.failed, removed: out.removed });
    }
    return json(req, 400, { error: 'unknown action' });
  } catch (e) {
    console.error('push-notify error', String(e));
    return json(req, 500, { error: 'internal error' });
  }
});
