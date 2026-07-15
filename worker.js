// Willow & Wag — Dog Grooming booking API (Cloudflare Worker, D1-backed).
// Binding expected: env.DB (D1 database).
// Plain fetch-handler Worker (paste directly into the dashboard's Quick Edit).

const SLOT_STEP = 15;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Staff-Key',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function isStaff(request, env) {
  const key = request.headers.get('X-Staff-Key');
  return !!env.STAFF_PIN && key === env.STAFF_PIN;
}

// All timestamps are "minutes since Unix epoch, UTC" — toTs/fromTs are inverses.
function toTs(dateStr, minuteOfDay) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 60000 + minuteOfDay;
}
function fromTs(ts) {
  const min = ((ts % 1440) + 1440) % 1440;
  const dayStart = ts - min;
  const date = new Date(dayStart * 60000).toISOString().slice(0, 10);
  return { date, min };
}
const dayStartTs = (dateStr) => toTs(dateStr, 0);
const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;
const fmtMin = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const fmtDate = (dateStr) => new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-GB', {
  weekday: 'long', day: 'numeric', month: 'long',
});
const fmtMoney = (pence) => `£${(pence / 100).toFixed(2)}`;
const SHOP_NAME = 'Willow & Wag';
const SHOP_PHONE = '0114 496 0192';

// Booking reference: 6 chars, uppercase, no ambiguous characters (0/O, 1/I/L).
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genRef() {
  let s = '';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  return s;
}
async function uniqueRef(DB) {
  for (let i = 0; i < 8; i++) {
    const ref = genRef();
    const clash = await DB.prepare('SELECT 1 FROM appointments WHERE ref = ?').bind(ref).first();
    if (!clash) return ref;
  }
  return genRef() + Date.now().toString(36).slice(-3).toUpperCase();
}

async function busyFor(DB, groomerId, dateStr) {
  const from = dayStartTs(dateStr), to = from + 1440;
  const appts = await DB.prepare(
    `SELECT start_ts, end_ts FROM appointments
     WHERE groomer_id = ? AND status = 'booked' AND start_ts < ? AND end_ts > ?`
  ).bind(groomerId, to, from).all();
  const blocks = await DB.prepare(
    `SELECT start_ts, end_ts FROM blocks
     WHERE (groomer_id = ? OR groomer_id IS NULL) AND start_ts < ? AND end_ts > ?`
  ).bind(groomerId, to, from).all();
  return [...appts.results, ...blocks.results];
}

async function slotsFor(DB, groomerId, dateStr, duration) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const hours = await DB.prepare('SELECT open_min, close_min FROM opening_hours WHERE dow = ?').bind(dow).first();
  if (!hours || hours.open_min == null) return [];
  const busy = await busyFor(DB, groomerId, dateStr);
  const nowTs = Date.now() / 60000;
  const out = [];
  for (let min = hours.open_min; min + duration <= hours.close_min; min += SLOT_STEP) {
    const s = toTs(dateStr, min), e = s + duration;
    if (s < nowTs) continue;
    if (busy.some((b) => overlaps(s, e, b.start_ts, b.end_ts))) continue;
    out.push({ min, label: fmtMin(min) });
  }
  return out;
}

// Fetch a single day's opening hours (or null if the shop is closed all day).
async function hoursFor(DB, dow) {
  const hours = await DB.prepare('SELECT open_min, close_min FROM opening_hours WHERE dow = ?').bind(dow).first();
  return (hours && hours.open_min != null && hours.close_min != null) ? hours : null;
}

// Work out the most recently completed "closed" window: from the last time
// the shop shut its doors, up to the next time it opens (or right now, if
// that point hasn't arrived yet). Powers the staff morning brief, which
// surfaces bookings made overnight or over the weekend while nobody was in.
async function lastClosedWindow(DB) {
  const nowTs = Date.now() / 60000;

  let closeTs = null, closeDateStr = null;
  for (let offset = 0; offset < 14; offset++) {
    const d = new Date(Date.now() - offset * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const hours = await hoursFor(DB, d.getUTCDay());
    if (hours) {
      const close = toTs(dateStr, hours.close_min);
      if (close <= nowTs) { closeTs = close; closeDateStr = dateStr; break; }
    }
  }
  if (closeTs == null) return null;

  let openTs = null;
  for (let offset = 1; offset <= 14; offset++) {
    const d = new Date(toTs(closeDateStr, 0) * 60000 + offset * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const hours = await hoursFor(DB, d.getUTCDay());
    if (hours) { openTs = toTs(dateStr, hours.open_min); break; }
  }

  const windowEnd = openTs == null ? nowTs : Math.min(nowTs, openTs);
  return { windowStart: closeTs, windowEnd };
}

async function findByRefEmail(DB, ref, email) {
  if (!ref || !email) return null;
  const cleanRef = String(ref).trim().toUpperCase();
  const cleanEmail = String(email).trim().toLowerCase();
  return DB.prepare(
    `SELECT a.*, b.name AS groomer_name, s.name AS service_name, s.duration_min
     FROM appointments a
     JOIN groomers b ON b.id = a.groomer_id
     JOIN services s ON s.id = a.service_id
     WHERE a.ref = ? AND lower(a.client_email) = ? AND a.status = 'booked'`
  ).bind(cleanRef, cleanEmail).first();
}

function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

/* ======================================================================
   NOTIFICATIONS — Resend (email). Best-effort: a missing/invalid API key
   never breaks a booking, cancellation, or reassignment — it just logs.
   ====================================================================== */
async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) { console.log('[email skipped] RESEND_API_KEY not set'); return; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || `${SHOP_NAME} <onboarding@resend.dev>`,
        to: [to], subject, html,
      }),
    });
    if (!res.ok) console.log('[email failed]', res.status, await res.text());
  } catch (err) {
    console.log('[email error]', err && err.message);
  }
}

function confirmationEmailHtml({ name, serviceName, groomerName, when, ref, price }) {
  return `<p>Hi ${name},</p>
<p>You're booked in at ${SHOP_NAME}:</p>
<p><b>${serviceName}</b> with ${groomerName}<br>${when}</p>
<p>Ref <b>${ref}</b>${price ? ` · ${price}` : ''}. Need to change it? Call ${SHOP_PHONE} or manage your booking online.</p>
<p>See you then!<br>${SHOP_NAME}</p>`;
}

function reassignEmailHtml({ name, serviceName, groomerName, when, ref }) {
  return `<p>Hi ${name},</p>
<p>A quick update about your appointment at ${SHOP_NAME} — we've had to move it slightly:</p>
<p><b>${serviceName}</b> with ${groomerName}<br>${when}</p>
<p>Ref <b>${ref}</b>. Sorry for the shuffle — call ${SHOP_PHONE} if this new time doesn't work.</p>
<p>${SHOP_NAME}</p>`;
}

function cancellationEmailHtml({ name, serviceName, when, ref }) {
  return `<p>Hi ${name},</p>
<p>Your appointment at ${SHOP_NAME} has been cancelled, as requested:</p>
<p><b>${serviceName}</b><br>${when}</p>
<p>Ref <b>${ref}</b>. Want to rebook? Call ${SHOP_PHONE} or book online any time.</p>
<p>${SHOP_NAME}</p>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const DB = env.DB;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (!url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);
    const segments = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);

    try {
      // ---- POST /api/staff/verify ----
      if (segments.length === 2 && segments[0] === 'staff' && segments[1] === 'verify' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        if (env.STAFF_PIN && b.pin === env.STAFF_PIN) return json({ ok: true });
        return json({ error: 'Incorrect PIN.' }, 401);
      }

      // ---- GET /api/services ----
      if (segments.length === 1 && segments[0] === 'services' && method === 'GET') {
        const rows = await DB.prepare('SELECT * FROM services ORDER BY id').all();
        return json(rows.results);
      }

      // ---- GET /api/groomers ----
      if (segments.length === 1 && segments[0] === 'groomers' && method === 'GET') {
        const rows = await DB.prepare('SELECT * FROM groomers ORDER BY id').all();
        return json(rows.results);
      }

      // ---- GET /api/hours ---- (public — lets the calendar derive its day/week
      // grid window from real opening hours instead of a hardcoded window)
      if (segments.length === 1 && segments[0] === 'hours' && method === 'GET') {
        const rows = await DB.prepare('SELECT dow, open_min, close_min FROM opening_hours ORDER BY dow').all();
        return json(rows.results);
      }

      // ---- GET /api/availability?date=&serviceId=&groomerId=(optional|any) ----
      if (segments.length === 1 && segments[0] === 'availability' && method === 'GET') {
        const q = url.searchParams;
        const date = q.get('date');
        const serviceId = Number(q.get('serviceId'));
        const service = await DB.prepare('SELECT * FROM services WHERE id = ?').bind(serviceId).first();
        if (!date || !service) return json({ error: 'date and serviceId required' }, 400);
        const groomerReq = q.get('groomerId');
        let groomers;
        if (groomerReq && groomerReq !== 'any') {
          const b = await DB.prepare('SELECT * FROM groomers WHERE id = ?').bind(Number(groomerReq)).first();
          groomers = b ? [b] : [];
        } else {
          groomers = (await DB.prepare('SELECT * FROM groomers ORDER BY id').all()).results;
        }
        const byMin = new Map();
        for (const bar of groomers) {
          const slots = await slotsFor(DB, bar.id, date, service.duration_min);
          for (const s of slots) {
            if (!byMin.has(s.min)) byMin.set(s.min, { min: s.min, label: s.label, groomerIds: [] });
            byMin.get(s.min).groomerIds.push(bar.id);
          }
        }
        const slots = [...byMin.values()].sort((a, b) => a.min - b.min);
        return json({ date, duration: service.duration_min, slots });
      }

      // ---- GET /api/day-counts?serviceId=&groomerId=&from=&to= (YYYY-MM-DD) ----
      if (segments.length === 1 && segments[0] === 'day-counts' && method === 'GET') {
        const q = url.searchParams;
        const serviceId = Number(q.get('serviceId'));
        const groomerReq = q.get('groomerId');
        const from = q.get('from'), to = q.get('to');
        const service = await DB.prepare('SELECT * FROM services WHERE id = ?').bind(serviceId).first();
        if (!service || !from || !to) return json({ error: 'serviceId, from, to required' }, 400);
        let groomers;
        if (groomerReq && groomerReq !== 'any') {
          const b = await DB.prepare('SELECT * FROM groomers WHERE id = ?').bind(Number(groomerReq)).first();
          groomers = b ? [b] : [];
        } else {
          groomers = (await DB.prepare('SELECT * FROM groomers ORDER BY id').all()).results;
        }
        const out = {};
        let cursor = new Date(from + 'T00:00:00Z');
        const end = new Date(to + 'T00:00:00Z');
        while (cursor <= end) {
          const dateStr = cursor.toISOString().slice(0, 10);
          let count = 0;
          for (const bar of groomers) count += (await slotsFor(DB, bar.id, dateStr, service.duration_min)).length;
          out[dateStr] = count;
          cursor = new Date(cursor.getTime() + 86400000);
        }
        return json(out);
      }

      // ---- GET /api/appointments/lookup?ref=&email= ---- (public — manage booking) ----
      if (segments.length === 2 && segments[0] === 'appointments' && segments[1] === 'lookup' && method === 'GET') {
        const q = url.searchParams;
        const appt = await findByRefEmail(DB, q.get('ref'), q.get('email'));
        if (!appt) return json({ error: 'No live booking found for that reference and email.' }, 404);
        const { date, min } = fromTs(appt.start_ts);
        return json({ ref: appt.ref, serviceName: appt.service_name, groomerName: appt.groomer_name, date, startMin: min, email: appt.client_email, when: `${fmtDate(date)} at ${fmtMin(min)}`, serviceId: appt.service_id, groomerId: appt.groomer_id, });
      }

      // ---- PATCH /api/appointments/lookup ---- (public — cancel via ref+email) ----
      if (segments.length === 2 && segments[0] === 'appointments' && segments[1] === 'lookup' && method === 'PATCH') {
        const b = await request.json().catch(() => ({}));
        const appt = await findByRefEmail(DB, b.ref, b.email);
        if (!appt) return json({ error: 'No live booking found for that reference and email.' }, 404);
        if (b.status === 'cancelled') {
          await DB.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").bind(appt.id).run();
          const { date: pDate, min: pMin } = fromTs(appt.start_ts);
          await sendEmail(env, {
            to: appt.client_email,
            subject: `Your appointment has been cancelled — ${appt.service_name}`,
            html: cancellationEmailHtml({
              name: appt.client_name, serviceName: appt.service_name,
              when: `${fmtDate(pDate)} at ${fmtMin(pMin)}`, ref: appt.ref,
            }),
          });
          return json({ ok: true }); } if (b.date != null && b.min != null) { const start = toTs(b.date, Number(b.min)); const end = start + appt.duration_min; const result = await DB.prepare( `UPDATE appointments SET start_ts = ?, end_ts = ? WHERE id = ? AND NOT EXISTS ( SELECT 1 FROM appointments WHERE groomer_id = ? AND status = 'booked' AND id != ? AND start_ts < ? AND end_ts > ? ) AND NOT EXISTS ( SELECT 1 FROM blocks WHERE (groomer_id = ? OR groomer_id IS NULL) AND start_ts < ? AND end_ts > ? )` ).bind( start, end, appt.id, appt.groomer_id, appt.id, end, start, appt.groomer_id, end, start ).run(); if (!result.meta.changes) return json({ error: 'That new time conflicts with another appointment or block.' }, 409); const { date: rDate, min: rMin } = fromTs(start); await sendEmail(env, { to: appt.client_email, subject: `Your appointment time has changed — ${appt.service_name}`, html: reassignEmailHtml({ name: appt.client_name, serviceName: appt.service_name, groomerName: appt.groomer_name, when: `${fmtDate(rDate)} at ${fmtMin(rMin)}`, ref: appt.ref, }), }); return json({ ok: true, date: rDate, startMin: rMin, when: `${fmtDate(rDate)} at ${fmtMin(rMin)}` }); } return json({ error: 'Unsupported update.' }, 400); }

      // ---- GET /api/appointments ---- (staff only)
      if (segments.length === 1 && segments[0] === 'appointments' && method === 'GET') {
        if (!isStaff(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const q = url.searchParams;
        const from = q.get('from'), to = q.get('to');
        const r = await DB.prepare(
          `SELECT a.*, b.name AS groomer_name, b.color AS groomer_color,
                  s.name AS service_name, s.duration_min
           FROM appointments a
           JOIN groomers b ON b.id = a.groomer_id
           JOIN services s ON s.id = a.service_id
           WHERE a.start_ts >= ? AND a.start_ts < ?
           ORDER BY a.start_ts`
        ).bind(dayStartTs(from), dayStartTs(to) + 1440).all();
        return json(r.results);
      }

      // ---- POST /api/appointments ---- (public — create booking) ----
      if (segments.length === 1 && segments[0] === 'appointments' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const service = await DB.prepare('SELECT * FROM services WHERE id = ?').bind(Number(b.serviceId)).first();
        if (!service || !b.date || b.min == null) return json({ error: 'Missing booking details.' }, 400);
        for (const f of ['name', 'email']) {
          if (!b[f] || !String(b[f]).trim()) return json({ error: 'Please complete all contact fields.' }, 400);
        }
        if (!validEmail(b.email)) return json({ error: 'Invalid email address.' }, 400);

        let groomerId = (b.groomerId && b.groomerId !== 'any') ? Number(b.groomerId) : null;
        if (!groomerId) {
          const groomers = (await DB.prepare('SELECT * FROM groomers ORDER BY id').all()).results;
          for (const bar of groomers) {
            const slots = await slotsFor(DB, bar.id, b.date, service.duration_min);
            if (slots.some((s) => s.min === Number(b.min))) { groomerId = bar.id; break; }
          }
          if (!groomerId) return json({ error: 'Sorry, that slot was just taken. Please pick another time.' }, 409);
        }

        const start = toTs(b.date, Number(b.min));
        const end = start + service.duration_min;
        if (start < Date.now() / 60000) return json({ error: 'That time is in the past.' }, 400);

        const ref = await uniqueRef(DB);
        const createdAt = Math.floor(Date.now() / 60000);
        const result = await DB.prepare(
          `INSERT INTO appointments
             (groomer_id,service_id,client_name,client_email,client_phone,notes,start_ts,end_ts,status,created_at,ref)
           SELECT ?,?,?,?,?,?,?,?, 'booked', ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM appointments WHERE groomer_id = ? AND status = 'booked' AND start_ts < ? AND end_ts > ?
           ) AND NOT EXISTS (
             SELECT 1 FROM blocks WHERE (groomer_id = ? OR groomer_id IS NULL) AND start_ts < ? AND end_ts > ?
           )`
        ).bind(
          groomerId, service.id, String(b.name).trim(), String(b.email).trim().toLowerCase(), (b.phone || '').trim(),
          (b.notes || '').trim(), start, end, createdAt, ref,
          groomerId, end, start,
          groomerId, end, start
        ).run();

        if (!result.meta.changes) return json({ error: 'Sorry, that slot was just taken. Please pick another time.' }, 409);
        const groomer = await DB.prepare('SELECT * FROM groomers WHERE id = ?').bind(groomerId).first();
        const when = `${fmtDate(b.date)} at ${fmtMin(Number(b.min))}`;
        await sendEmail(env, {
          to: String(b.email).trim(),
          subject: `You're booked in — ${service.name}`,
          html: confirmationEmailHtml({
            name: String(b.name).trim(), serviceName: service.name, groomerName: groomer.name,
            when, ref, price: fmtMoney(service.price_pence),
          }),
        });
        return json({
          id: result.meta.last_row_id, ref, groomerId, groomerName: groomer.name,
          serviceName: service.name, date: b.date, startMin: Number(b.min),
          when,
          price: fmtMoney(service.price_pence),
        }, 201);
      }

      // ---- PATCH /api/appointments/:id ---- (staff only)
      if (segments.length === 2 && segments[0] === 'appointments' && method === 'PATCH') {
        if (!isStaff(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const id = Number(segments[1]);
        const b = await request.json().catch(() => ({}));
        const appt = await DB.prepare('SELECT * FROM appointments WHERE id = ?').bind(id).first();
        if (!appt) return json({ error: 'Not found.' }, 404);

        if (b.status === 'cancelled') {
          await DB.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").bind(id).run();
          const svc = await DB.prepare('SELECT * FROM services WHERE id = ?').bind(appt.service_id).first();
          const { date: cDate, min: cMin } = fromTs(appt.start_ts);
          await sendEmail(env, {
            to: appt.client_email,
            subject: `Your appointment has been cancelled — ${svc ? svc.name : ''}`,
            html: cancellationEmailHtml({
              name: appt.client_name, serviceName: svc ? svc.name : '',
              when: `${fmtDate(cDate)} at ${fmtMin(cMin)}`, ref: appt.ref,
            }),
          });
          return json({ ok: true });
        }
        if (b.status === 'no-show' || b.status === 'completed') {
          await DB.prepare('UPDATE appointments SET status = ? WHERE id = ?').bind(b.status, id).run();
          return json({ ok: true });
        }
        if (typeof b.arrived === 'boolean') {
          await DB.prepare('UPDATE appointments SET arrived_at = ? WHERE id = ?')
            .bind(b.arrived ? new Date().toISOString() : null, id).run();
          return json({ ok: true });
        }

        const service = await DB.prepare('SELECT * FROM services WHERE id = ?').bind(appt.service_id).first();
        const groomerId = b.groomerId != null ? Number(b.groomerId) : appt.groomer_id;
        const start = (b.date != null && b.min != null) ? toTs(b.date, Number(b.min)) : appt.start_ts;
        const end = start + service.duration_min;

        const result = await DB.prepare(
          `UPDATE appointments SET groomer_id = ?, start_ts = ?, end_ts = ?
           WHERE id = ? AND NOT EXISTS (
             SELECT 1 FROM appointments WHERE groomer_id = ? AND status = 'booked' AND id != ? AND start_ts < ? AND end_ts > ?
           ) AND NOT EXISTS (
             SELECT 1 FROM blocks WHERE (groomer_id = ? OR groomer_id IS NULL) AND start_ts < ? AND end_ts > ?
           )`
        ).bind(
          groomerId, start, end,
          id,
          groomerId, id, end, start,
          groomerId, end, start
        ).run();

        if (!result.meta.changes) return json({ error: 'That new time conflicts with another appointment or block.' }, 409);
        const newGroomer = await DB.prepare('SELECT * FROM groomers WHERE id = ?').bind(groomerId).first();
        const { date: rDate, min: rMin } = fromTs(start);
        await sendEmail(env, {
          to: appt.client_email,
          subject: `Your appointment has moved — ${service.name}`,
          html: reassignEmailHtml({
            name: appt.client_name, serviceName: service.name, groomerName: newGroomer ? newGroomer.name : '',
            when: `${fmtDate(rDate)} at ${fmtMin(rMin)}`, ref: appt.ref,
          }),
        });
        return json({ ok: true });
      }

      // ---- GET /api/blocks ---- (staff only)
      if (segments.length === 1 && segments[0] === 'blocks' && method === 'GET') {
        if (!isStaff(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const q = url.searchParams;
        const from = q.get('from'), to = q.get('to');
        const r = await DB.prepare(
          `SELECT bl.*, b.name AS groomer_name FROM blocks bl LEFT JOIN groomers b ON b.id = bl.groomer_id
           WHERE bl.start_ts < ? AND bl.end_ts > ? ORDER BY bl.start_ts`
        ).bind(dayStartTs(to) + 1440, dayStartTs(from)).all();
        return json(r.results);
      }

      // ---- POST /api/blocks ---- (staff only)
      // Safety check: if this block would swallow existing live bookings, don't
      // silently orphan them. Instead return the affected appointments — each
      // annotated with which other groomers are free at that exact time — so
      // staff can reassign or cancel them first. Resubmit with confirm:true
      // (once resolved) to actually create the block.
      if (segments.length === 1 && segments[0] === 'blocks' && method === 'POST') {
        if (!isStaff(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const b = await request.json().catch(() => ({}));
        if (!b.reason || !b.startDate || b.startMin == null || !b.endDate || b.endMin == null)
          return json({ error: 'Missing block details.' }, 400);
        const start = toTs(b.startDate, Number(b.startMin));
        const end = toTs(b.endDate, Number(b.endMin));
        if (end <= start) return json({ error: 'End must be after start.' }, 400);
        const groomerId = (b.groomerId && b.groomerId !== 'all') ? Number(b.groomerId) : null;

        const affectedRows = await DB.prepare(
          `SELECT a.*, bar.name AS groomer_name, s.name AS service_name, s.duration_min
           FROM appointments a
           JOIN groomers bar ON bar.id = a.groomer_id
           JOIN services s ON s.id = a.service_id
           WHERE a.status = 'booked' AND a.start_ts < ? AND a.end_ts > ?
             AND (? IS NULL OR a.groomer_id = ?)
           ORDER BY a.start_ts`
        ).bind(end, start, groomerId, groomerId).all();

        if (affectedRows.results.length && !b.confirm) {
          const allGroomers = (await DB.prepare('SELECT * FROM groomers ORDER BY id').all()).results;
          const affected = [];
          for (const appt of affectedRows.results) {
            const availableGroomers = [];
            for (const bar of allGroomers) {
              if (bar.id === appt.groomer_id) continue;
              const busy = await busyFor(DB, bar.id, fromTs(appt.start_ts).date);
              const free = !busy.some((x) => overlaps(appt.start_ts, appt.end_ts, x.start_ts, x.end_ts));
              if (free) availableGroomers.push({ id: bar.id, name: bar.name });
            }
            affected.push({
              id: appt.id, ref: appt.ref,
              clientName: appt.client_name, clientEmail: appt.client_email, clientPhone: appt.client_phone,
              groomerId: appt.groomer_id, groomerName: appt.groomer_name,
              serviceName: appt.service_name,
              date: fromTs(appt.start_ts).date, startMin: fromTs(appt.start_ts).min,
              availableGroomers,
            });
          }
          return json({ affected }, 409);
        }

        const result = await DB.prepare('INSERT INTO blocks (groomer_id,reason,start_ts,end_ts) VALUES (?,?,?,?)')
          .bind(groomerId, b.reason, start, end).run();
        return json({ id: result.meta.last_row_id }, 201);
      }

      // ---- DELETE /api/blocks/:id ---- (staff only)
      if (segments.length === 2 && segments[0] === 'blocks' && method === 'DELETE') {
        if (!isStaff(request, env)) return json({ error: 'Unauthorized.' }, 401);
        await DB.prepare('DELETE FROM blocks WHERE id = ?').bind(Number(segments[1])).run();
        return json({ ok: true });
      }

      // ---- POST /api/waitlist ---- (public — join waitlist) ----
      if (segments.length === 1 && segments[0] === 'waitlist' && method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const service = b.serviceId ? await DB.prepare('SELECT * FROM services WHERE id = ?').bind(Number(b.serviceId)).first() : null;
        for (const f of ['name', 'email']) {
          if (!b[f] || !String(b[f]).trim()) return json({ error: 'Please complete all contact fields.' }, 400);
        }
        if (!validEmail(b.email)) return json({ error: 'Invalid email address.' }, 400);
        const groomerId = (b.groomerId && b.groomerId !== 'any') ? Number(b.groomerId) : null;
        const result = await DB.prepare(
          `INSERT INTO waitlist (service_id,groomer_id,client_name,client_email,client_phone,preferred_date,created_at)
           VALUES (?,?,?,?,?,?,?)`
        ).bind(
          service ? service.id : null, groomerId, String(b.name).trim(), String(b.email).trim().toLowerCase(),
          (b.phone || '').trim(), b.date || null, Math.floor(Date.now() / 60000)
        ).run();
        return json({ id: result.meta.last_row_id }, 201);
      }

      // ---- GET /api/waitlist ---- (staff only) ----
      if (segments.length === 1 && segments[0] === 'waitlist' && method === 'GET') {
        if (!isStaff(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const r = await DB.prepare(
          `SELECT w.*, s.name AS service_name, b.name AS groomer_name
           FROM waitlist w
           LEFT JOIN services s ON s.id = w.service_id
           LEFT JOIN groomers b ON b.id = w.groomer_id
           ORDER BY w.preferred_date, w.created_at`
        ).all();
        return json(r.results);
      }

      // ---- DELETE /api/waitlist/:id ---- (staff only) ----
      if (segments.length === 2 && segments[0] === 'waitlist' && method === 'DELETE') {
        if (!isStaff(request, env)) return json({ error: 'Unauthorized.' }, 401);
        await DB.prepare('DELETE FROM waitlist WHERE id = ?').bind(Number(segments[1])).run();
        return json({ ok: true });
      }

      // ---- GET /api/staff/morning-brief ---- (staff only)
      // Shows every appointment booked while the shop was closed (overnight,
      // or over the weekend), so staff can catch up each morning.
      if (segments.length === 2 && segments[0] === 'staff' && segments[1] === 'morning-brief' && method === 'GET') {
        if (!isStaff(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const win = await lastClosedWindow(DB);
        if (!win) return json({ windowStart: null, windowEnd: null, appointments: [] });
        const rows = await DB.prepare(
          `SELECT a.id, a.client_name, a.client_email, a.client_phone, a.start_ts, a.created_at, a.ref,
                  b.name AS groomer_name, s.name AS service_name
           FROM appointments a
           JOIN groomers b ON b.id = a.groomer_id
           JOIN services s ON s.id = a.service_id
           WHERE a.created_at >= ? AND a.created_at <= ? AND a.status = 'booked'
           ORDER BY a.created_at ASC`
        ).bind(Math.round(win.windowStart), Math.round(win.windowEnd)).all();
        return json({ windowStart: Math.round(win.windowStart), windowEnd: Math.round(win.windowEnd), appointments: rows.results });
      }

      return json({ error: 'Unknown endpoint.' }, 404);
    } catch (err) {
      return json({ error: 'Server error: ' + (err && err.message ? err.message : String(err)) }, 500);
    }
  },
};
