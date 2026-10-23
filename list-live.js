// Pure helpers for live shopping_list_items sync (unit-tested).
// The Realtime wiring and DOM redraw live in app.js.

/** Apply a postgres_changes payload to a mutable items array. Returns true if anything changed. */
export function applyListLivePayload(items, payload) {
  if (!items || !payload) return false;
  const ev = payload.eventType || payload.event;
  if (ev === 'INSERT') {
    const row = payload.new; if (!row?.id) return false;
    if (items.some((i) => i.id === row.id)) return false; // own add already pushed
    items.push(row); return true;
  }
  if (ev === 'UPDATE') {
    const row = payload.new; if (!row?.id) return false;
    const i = items.findIndex((x) => x.id === row.id);
    if (i < 0) items.push(row);
    else {
      const prev = items[i];
      if (prev.checked === row.checked && prev.name === row.name && prev.price_cents === row.price_cents
        && prev.price_source === row.price_source && prev.quantity === row.quantity && prev.unit === row.unit
        && prev.category === row.category && prev.note === row.note && prev.position === row.position) return false;
      items[i] = { ...prev, ...row };
    }
    return true;
  }
  if (ev === 'DELETE') {
    const id = payload.old?.id; if (!id) return false;
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    items.splice(i, 1); return true;
  }
  return false;
}
