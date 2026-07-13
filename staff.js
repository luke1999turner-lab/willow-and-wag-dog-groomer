const API_BASE = 'https://willow-and-wag-api.luke1999-turner.workers.dev';
// Staff calendar: day view across all groomers, reschedule, cancel, block out time,
// waitlist, walk-in/phone bookings, and a morning brief of bookings made while the
// shop was closed.
const $ = (s) => document.querySelector(s);
let STAFF_KEY = '';
const api = (u, o = {}) => {
  o.headers = { ...(o.headers || {}), 'X-Staff-Key': STAFF_KEY };
  return fetch(API_BASE + u, o).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json() }));
};
const initials = (n) => n.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const pad = (n) => String(n).padStart(2, '0');
const fmt = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const toTs = (dateStr, min) => { const [y, m, d] = dateStr.split('-').map(Number); return Date.UTC(y, m - 1, d) / 60000 + min; };
const prettyDate = (s) => new Date(s + 'T00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
// Inverse of toTs — given an absolute minutes-since-epoch timestamp, recover the
// calendar date + minute-of-day. Used for morning-brief timestamps and the
// affected-appointments panel, which the API returns as raw minute counts.
function fromTs(ts) {
  const min = ((ts % 1440) + 1440) % 1440;
  const dayStart = ts - min;
  const date = new Date(dayStart * 60000).toISOString().slice(0, 10);
  return { date, min };
}
function fmtFromTs(ts) {
  const { date, min } = fromTs(ts);
  return `${prettyDate(date)}, ${fmt(min)}`;
}

const DAY_START = 8 * 60, DAY_END = 20 * 60, PXH = 56;   // visible window 08:00-20:00
const PXMIN = PXH / 60;
const state = { date: null, groomers: [], services: [], editing: null, affected: [], blocks: [] };

async function init() {
  state.groomers = (await api('/api/groomers')).data;
  state.services = (await api('/api/services')).data;
  const t = new Date(); state.date = t.toISOString().slice(0, 10);
  $('#date').value = state.date;
  $('#legend').innerHTML = state.groomers.map((b) =>
    `<span class="lg"><span class="sw" style="background:${b.color}"></span>${b.name}</span>`).join('') +
    `<span class="lg"><span class="sw" style="background:#8a8272"></span>Blocked / holiday</span>`;
  // Populate groomer selects
  const opts = state.groomers.map((b) => `<option value="${b.id}">${b.name}</option>`).join('');
  $('#rGroomer').innerHTML = opts;
  $('#bGroomer').innerHTML = `<option value="all">Whole shop</option>` + opts;
  $('#nbGroomer').innerHTML = `<option value="any">Any available</option>` + opts;
  $('#nbService').innerHTML = state.services.map((s) => `<option value="${s.id}">${s.name} (${s.duration_min}min)</option>`).join('');

  $('#prev').onclick = () => shiftDay(-1);
  $('#next').onclick = () => shiftDay(1);
  $('#today').onclick = () => { state.date = new Date().toISOString().slice(0, 10); $('#date').value = state.date; load(); };
  $('#date').onchange = () => { state.date = $('#date').value; load(); };
  $('#blockBtn').onclick = () => openBlock('add');
  $('#waitlistBtn').onclick = openWaitlist;
  $('#briefBtn').onclick = openBrief;
  $('#newBookingBtn').onclick = openNewBooking;
  document.querySelectorAll('[data-close]').forEach((b) => b.onclick = closeModals);
  $('#saveBlock').onclick = saveBlock;
  $('#saveAppt').onclick = saveAppt;
  $('#cancelAppt').onclick = cancelAppt;
  $('#toggleArrived').onclick = toggleArrivedFromModal;
  $('#rGroomer').onchange = $('#rDate').onchange = refreshRTimes;
  $('#nbService').onchange = $('#nbGroomer').onchange = $('#nbDate').onchange = refreshNBTimes;
  $('#saveNewBooking').onclick = saveNewBooking;
  $('#blockTabAdd').onclick = () => switchBlockTab('add');
  $('#blockTabRemove').onclick = () => switchBlockTab('remove');

  updateHero();
  setInterval(updateHero, 30000);
  setInterval(() => { if (state.date === new Date().toISOString().slice(0, 10)) load(); }, 60000);

  load();
  refreshWaitlistCount();
}

// ---------- hero greeting + live clock ----------
function updateHero() {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning, team.' : hour < 17 ? 'Good afternoon, team.' : 'Good evening, team.';
  $('#heroGreeting').textContent = greeting;
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  $('#heroSub').innerHTML = `${dateStr} &middot; <b>${timeStr}</b>`;
}

// ---------- stats bar ----------
function updateStats(appts) {
  const booked = appts.filter((a) => a.status === 'booked');
  $('#statBookings').textContent = booked.length;
  const isToday = state.date === new Date().toISOString().slice(0, 10);
  $('#statBookingsSub').textContent = isToday ? "Today's schedule" : prettyDate(state.date).split(',')[0];
  const arrived = booked.filter((a) => a.arrived_at).length;
  $('#statArrived').innerHTML = `${arrived} <span style="font-size:15px;color:var(--muted);font-weight:500">/ ${booked.length}</span>`;
  $('#statArrivedSub').textContent = booked.length ? `${booked.length - arrived} still due in` : 'No bookings today';
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const dayTs = toTs(state.date, 0);
  const upcoming = booked.filter((a) => !isToday || (a.start_ts - dayTs) >= nowMin).sort((a, b) => a.start_ts - b.start_ts)[0];
  if (upcoming) {
    $('#statNext').textContent = fmt(upcoming.start_ts - dayTs);
    $('#statNextSub').textContent = `${upcoming.client_name} · ${upcoming.service_name} · ${upcoming.groomer_name}`;
  } else {
    $('#statNext').textContent = '—';
    $('#statNextSub').textContent = isToday ? 'All done for today' : 'No bookings';
  }
  const serviceById = new Map(state.services.map((s) => [s.id, s]));
  const pence = booked.reduce((sum, a) => sum + (serviceById.get(a.service_id)?.price_pence || 0), 0);
  $('#statRevenue').textContent = `£${(pence / 100).toFixed(0)}`;
  const groomerCount = new Set(booked.map((a) => a.groomer_id)).size;
  $('#statRevenueSub').textContent = groomerCount ? `Across ${groomerCount} groomer${groomerCount === 1 ? '' : 's'}` : 'No bookings today';
}

async function refreshWaitlistCount() {
  const { data } = await api('/api/waitlist');
  $('#waitlistBtn').textContent = data.length ? `Waitlist (${data.length})` : 'Waitlist';
}

// ---------- waitlist modal ----------
async function openWaitlist() {
  const { data } = await api('/api/waitlist');
  const list = $('#waitlistList');
  if (!data.length) {
    list.innerHTML = `<p style="color:var(--muted);font-size:14px">No one on the waitlist right now.</p>`;
  } else {
    list.innerHTML = data.map((w) => `
      <div class="wl-row">
        <div>
          <b>${w.client_name}</b>
          <div style="font-size:13px;color:var(--muted)">${w.client_email} · ${w.client_phone || ''}</div>
          <div style="font-size:13px;color:var(--muted)">${w.service_name || 'Any service'} · ${w.groomer_name || 'Any groomer'} · Preferred: ${w.preferred_date || 'Any date'}</div>
        </div>
        <button class="link-danger" data-remove="${w.id}">Remove</button>
      </div>`).join('');
    list.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => {
      await api(`/api/waitlist/${b.dataset.remove}`, { method: 'DELETE' });
      openWaitlist(); refreshWaitlistCount();
    });
  }
  $('#waitlistModal').classList.remove('hidden');
}

// ---------- morning brief modal ----------
// Shows every appointment booked while the shop was closed (overnight, or over
// the weekend), so staff can catch up first thing each morning.
async function openBrief() {
  const { data } = await api('/api/staff/morning-brief');
  const list = $('#briefList');
  const sub = $('#briefSub');
  if (data.windowStart == null) {
    sub.textContent = "The shop hasn't been closed yet, so there's nothing to catch up on.";
    list.innerHTML = '';
  } else {
    sub.textContent = `Booked between ${fmtFromTs(data.windowStart)} and ${fmtFromTs(data.windowEnd)}.`;
    if (!data.appointments.length) {
      list.innerHTML = `<p style="color:var(--muted);font-size:14px">No bookings came in while the shop was closed.</p>`;
    } else {
      list.innerHTML = data.appointments.map((a) => `
        <div class="wl-row">
          <div>
            <b>${a.client_name}</b>
            <div style="font-size:13px;color:var(--muted)">${a.client_email} · ${a.client_phone || ''}</div>
            <div style="font-size:13px;color:var(--muted)">${a.service_name} with ${a.groomer_name} · ${fmtFromTs(a.start_ts)}</div>
            <div style="font-size:12px;color:var(--muted)">Ref ${a.ref} · booked ${fmtFromTs(a.created_at)}</div>
          </div>
        </div>`).join('');
    }
  }
  $('#briefModal').classList.remove('hidden');
}

// Shift the visible day by n days. Uses UTC date math throughout (matching how
// dates are stored/sent everywhere else in this app) so it can't drift
// depending on the browser's local timezone/DST offset.
function shiftDay(n) {
  const [y, m, d] = state.date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  state.date = dt.toISOString().slice(0, 10);
  $('#date').value = state.date;
  load();
}

async function load() {
  $('#dayLabel').textContent = prettyDate(state.date);
  const [appts, blocks] = await Promise.all([
    api(`/api/appointments?from=${state.date}&to=${state.date}`),
    api(`/api/blocks?from=${state.date}&to=${state.date}`),
  ]);
  state.blocks = blocks.data;
  updateStats(appts.data);
  render(appts.data, blocks.data);
}

function render(appts, blocks) {
  const cal = $('#cal');
  const N = state.groomers.length;
  cal.style.gridTemplateColumns = `56px repeat(${N}, 1fr)`;
  const hours = [];
  for (let h = DAY_START; h < DAY_END; h += 60) hours.push(h);
  const dayTs = toTs(state.date, 0);

  // Header row
  let html = `<div class="colhead gutterhead"></div>`;
  html += state.groomers.map((b) =>
    `<div class="colhead"><div class="who"><span class="avatar" style="width:26px;height:26px;font-size:12px;background:${b.color}">${initials(b.name)}</span>${b.name.split(' ')[0]}</div></div>`).join('');

  // Gutter column
  html += `<div class="gutter" style="grid-column:1">` +
    hours.map((h) => `<div class="hourline"><span>${fmt(h)}</span></div>`).join('') + `</div>`;

  // Day columns
  state.groomers.forEach((b) => {
    let col = `<div class="daycol">` + hours.map(() => `<div class="hourline"></div>`).join('');
    // blocks for this groomer (or shop-wide)
    blocks.filter((bl) => bl.groomer_id === b.id || bl.groomer_id == null).forEach((bl) => {
      const s = Math.max(bl.start_ts - dayTs, DAY_START), e = Math.min(bl.end_ts - dayTs, DAY_END);
      if (e <= s) return;
      col += `<div class="blk" data-id="${bl.id}" style="top:${(s - DAY_START) * PXMIN}px;height:${(e - s) * PXMIN - 2}px" title="Click to remove this block">${bl.reason}</div>`;
    });
    // appointments
    appts.filter((a) => a.groomer_id === b.id && a.status === 'booked').forEach((a) => {
      const s = a.start_ts - dayTs, dur = a.end_ts - a.start_ts;
      col += `<div class="appt" data-id="${a.id}" style="top:${(s - DAY_START) * PXMIN}px;height:${dur * PXMIN - 2}px;background:${b.color}">
        <span class="arrived-toggle ${a.arrived_at ? 'on' : ''}" data-id="${a.id}" title="${a.arrived_at ? 'Arrived - click to undo' : 'Mark arrived'}">✓</span>
        <b>${a.client_name}</b><small>${fmt(s)} · ${a.service_name}</small></div>`;
    });
    col += `</div>`;
    html += col;
  });
  cal.innerHTML = html;
  cal.querySelectorAll('.hourline').forEach((el) => { el.style.height = PXH + 'px'; });
  cal.querySelectorAll('.appt').forEach((el) => el.onclick = () => openAppt(+el.dataset.id));
  cal.querySelectorAll('.arrived-toggle').forEach((el) => el.onclick = (e) => {
    e.stopPropagation();
    toggleArrived(+el.dataset.id, !el.classList.contains('on'));
  });
  cal.querySelectorAll('.blk').forEach((el) => el.onclick = () => openBlock('remove'));

  // now-line: only draw when viewing today, within the visible hour window
  const now = new Date();
  const isToday = state.date === now.toISOString().slice(0, 10);
  if (isToday) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin >= DAY_START && nowMin <= DAY_END) {
      const top = (nowMin - DAY_START) * PXMIN;
      cal.insertAdjacentHTML('beforeend', `<div class="now-line" style="top:${top}px"></div>`);
    }
  }
}

async function toggleArrived(id, arrived) {
  await api(`/api/appointments/${id}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ arrived }) });
  load();
}

// Cancel/remove a holiday or block-out entry (plans changed, or it was added by
// mistake). This only deletes the block itself; any appointments already
// reassigned to another groomer or cancelled while the block was live are left
// as-is, since auto-reverting them could double-book someone.
async function removeBlock(b) {
  if (!b) return;
  const who = b.groomer_name || 'the whole shop';
  const ok = confirm('Remove this block?\n\n"' + b.reason + '" — ' + who + '\n\nThis only deletes the block itself; it will not undo any reassignments or cancellations already made while it was active.');
  if (!ok) return;
  await api(`/api/blocks/${b.id}`, { method: 'DELETE' });
  load();
  if (!$('#blockModal').classList.contains('hidden')) loadBlockRemoveList();
}

// ---------- appointment modal ----------
async function openAppt(id) {
  const { data: list } = await api(`/api/appointments?from=${state.date}&to=${state.date}`);
  const a = list.find((x) => x.id === id); if (!a) return;
  state.editing = a;
  const dayTs = toTs(state.date, 0);
  $('#apptInfo').innerHTML = `
    <div><span class="k">Client</span><span class="v">${a.client_name}</span></div>
    <div><span class="k">Contact</span><span class="v">${a.client_email} · ${a.client_phone || ''}</span></div>
    <div><span class="k">Service</span><span class="v">${a.service_name} (${a.duration_min} min)</span></div>
    <div><span class="k">With</span><span class="v">${a.groomer_name}</span></div>
    <div><span class="k">When</span><span class="v">${fmt(a.start_ts - dayTs)}, ${prettyDate(state.date)}</span></div>
    ${a.notes ? `<div><span class="k">Notes</span><span class="v">${a.notes}</span></div>` : ''}`;
  $('#rGroomer').value = a.groomer_id;
  $('#rDate').value = state.date;
  $('#apptErr').classList.add('hidden');
  $('#toggleArrived').textContent = a.arrived_at ? 'Undo arrived' : 'Mark arrived';
  await refreshRTimes();
  $('#apptModal').classList.remove('hidden');
}

async function refreshRTimes() {
  const a = state.editing; if (!a) return;
  const groomerId = $('#rGroomer').value, date = $('#rDate').value;
  const { data } = await api(`/api/availability?date=${date}&serviceId=${a.service_id}&groomerId=${groomerId}`);
  const slots = data.slots || [];
  const cur = a.start_ts - toTs(date, 0);
  let opts = slots.map((s) => `<option value="${s.min}">${s.label}</option>`).join('');
  // Ensure the current time is selectable if it falls on this groomer/date
  if (+groomerId === a.groomer_id && date === state.date && !slots.some((s) => s.min === cur))
    opts = `<option value="${cur}">${fmt(cur)} (current)</option>` + opts;
  $('#rTime').innerHTML = opts || `<option value="">No free times</option>`;
  if (+groomerId === a.groomer_id && date === state.date) $('#rTime').value = cur;
}

async function saveAppt() {
  const a = state.editing;
  const body = { groomerId: +$('#rGroomer').value, date: $('#rDate').value, min: +$('#rTime').value };
  const { ok, data } = await api(`/api/appointments/${a.id}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!ok) { const e = $('#apptErr'); e.textContent = data.error; e.classList.remove('hidden'); return; }
  closeModals(); state.date = body.date; $('#date').value = state.date; load();
}
async function cancelAppt() {
  if (!confirm('Cancel this appointment? The slot will be freed for other clients.')) return;
  await api(`/api/appointments/${state.editing.id}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }) });
  closeModals(); load();
}
async function toggleArrivedFromModal() {
  const a = state.editing; if (!a) return;
  await toggleArrived(a.id, !a.arrived_at);
  closeModals();
}

// ---------- new booking modal (walk-in / phone) ----------
// Reuses the same public POST /api/appointments endpoint the client site uses,
// so slot-conflict checking is identical for staff-entered bookings.
function openNewBooking() {
  $('#nbDate').value = state.date;
  $('#nbName').value = ''; $('#nbEmail').value = ''; $('#nbPhone').value = ''; $('#nbNotes').value = '';
  $('#nbErr').classList.add('hidden');
  refreshNBTimes();
  $('#newBookingModal').classList.remove('hidden');
}
async function refreshNBTimes() {
  const serviceId = $('#nbService').value, groomerId = $('#nbGroomer').value, date = $('#nbDate').value;
  if (!serviceId || !date) return;
  const { data } = await api(`/api/availability?date=${date}&serviceId=${serviceId}&groomerId=${groomerId}`);
  const slots = data.slots || [];
  $('#nbTime').innerHTML = slots.length ? slots.map((s) => `<option value="${s.min}">${s.label}</option>`).join('') : `<option value="">No free times</option>`;
}
async function saveNewBooking() {
  const body = {
    serviceId: +$('#nbService').value, groomerId: $('#nbGroomer').value,
    date: $('#nbDate').value, min: +$('#nbTime').value,
    name: $('#nbName').value.trim(), email: $('#nbEmail').value.trim(),
    phone: $('#nbPhone').value.trim(), notes: $('#nbNotes').value.trim(),
  };
  if (!body.name || !body.email) {
    const e = $('#nbErr'); e.textContent = 'Client name and email are required.'; e.classList.remove('hidden'); return;
  }
  const { ok, data } = await api('/api/appointments',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!ok) { const e = $('#nbErr'); e.textContent = data.error || 'Could not book that slot.'; e.classList.remove('hidden'); return; }
  closeModals(); state.date = body.date; $('#date').value = state.date; load();
}

// ---------- block modal (Add / Remove tabs) ----------
function openBlock(tab) {
  $('#bReason').value = ''; $('#bStartDate').value = state.date; $('#bEndDate').value = state.date;
  $('#bStartTime').value = '09:00'; $('#bEndTime').value = '17:00'; $('#bAllDay').checked = false;
  $('#blockErr').classList.add('hidden');
  switchBlockTab(tab || 'add');
  $('#blockModal').classList.remove('hidden');
}
function switchBlockTab(tab) {
  const addTab = tab === 'add';
  $('#blockTabAdd').classList.toggle('active', addTab);
  $('#blockTabRemove').classList.toggle('active', !addTab);
  $('#blockAddPanel').classList.toggle('hidden', !addTab);
  $('#blockRemovePanel').classList.toggle('hidden', addTab);
  $('#saveBlock').classList.toggle('hidden', !addTab);
  if (!addTab) loadBlockRemoveList();
}
function loadBlockRemoveList() {
  const box = $('#blockRemoveList');
  const list = state.blocks || [];
  if (!list.length) {
    box.innerHTML = `<p style="color:var(--muted);font-size:14px">No blocks on ${prettyDate(state.date)}.</p>`;
    return;
  }
  box.innerHTML = list.map((bl) => `
    <div class="wl-row">
      <div>
        <b>${bl.reason}</b>
        <div style="font-size:13px;color:var(--muted)">${bl.groomer_name || 'Whole shop'} · ${fmtFromTs(bl.start_ts)} – ${fmt(fromTs(bl.end_ts).min)}</div>
      </div>
      <button class="link-danger" data-remove-block="${bl.id}">Remove</button>
    </div>`).join('');
  box.querySelectorAll('[data-remove-block]').forEach((btn) => btn.onclick = () => {
    removeBlock(list.find((bl) => bl.id === +btn.dataset.removeBlock));
  });
}
async function saveBlock() {
  const hm = (v) => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
  const allDay = $('#bAllDay').checked;
  const multiDay = $('#bStartDate').value !== $('#bEndDate').value;
  const body = {
    reason: $('#bReason').value.trim() || 'Blocked', groomerId: $('#bGroomer').value,
    startDate: $('#bStartDate').value, endDate: $('#bEndDate').value,
    startMin: (allDay || multiDay) ? 0 : hm($('#bStartTime').value),
    endMin: (allDay || multiDay) ? 1440 : hm($('#bEndTime').value),
  };
  const { ok, status, data } = await api('/api/blocks',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!ok && status !== 409) { const e = $('#blockErr'); e.textContent = data.error; e.classList.remove('hidden'); return; }
  if (status === 409 && data.affected) {
    // Safety check tripped: the block was NOT created. Show staff the affected
    // appointments so they can reassign or cancel each one, then resubmit.
    closeModals();
    openAffected(data.affected, body);
    return;
  }
  closeModals(); load();
}
function closeModals() {
  ['apptModal', 'blockModal', 'waitlistModal', 'affectedModal', 'briefModal', 'newBookingModal'].forEach((id) => $('#' + id).classList.add('hidden'));
  state.editing = null;
}

// ---------- affected-appointments safety panel ----------
// Shown when a block would swallow existing bookings. Nothing is ever
// auto-cancelled by the backend — this surfaces who needs moving and who's
// actually free to take them, then lets staff resubmit the block once clear.
let pendingBlock = null;
function openAffected(list, blockBody) {
  state.affected = list;
  pendingBlock = blockBody;
  renderAffected();
  $('#affectedModal').classList.remove('hidden');
}
function renderAffected() {
  const box = $('#affectedList');
  const list = state.affected || [];
  if (!list.length) {
    box.innerHTML = `<p style="color:var(--ok);font-size:14px;font-weight:600;margin-bottom:14px">All clear — every affected client has been reassigned or cancelled.</p>
      <button class="btn primary" id="confirmBlockNow">Confirm block now</button>`;
    const btn = document.getElementById('confirmBlockNow');
    if (btn) btn.onclick = async () => {
      if (!pendingBlock) { closeModals(); return; }
      const { ok, data } = await api('/api/blocks',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pendingBlock) });
      if (ok) { pendingBlock = null; closeModals(); load(); }
      else if (data.affected) { state.affected = data.affected; renderAffected(); }
    };
    return;
  }
  box.innerHTML = list.map((a) => `
    <div class="wl-row">
      <div>
        <b>${a.clientName}</b>
        <div style="font-size:13px;color:var(--muted)">${a.clientEmail} · ${a.clientPhone || ''}</div>
        <div style="font-size:13px;color:var(--muted)">${a.serviceName} with ${a.groomerName} · ${prettyDate(a.date)}, ${fmt(a.startMin)}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
        ${a.availableGroomers.length ? `
          <select data-swap="${a.id}" style="width:auto;padding:6px 8px">
            ${a.availableGroomers.map((b) => `<option value="${b.id}">${b.name}</option>`).join('')}
          </select>
          <button class="btn primary" style="padding:6px 12px;font-size:13px" data-reassign="${a.id}">Reassign groomer</button>
        ` : `<span style="font-size:12px;color:var(--danger);text-align:right;max-width:180px">No one else free at this time — call client to rebook</span>`}
        <button class="link-danger" style="font-size:13px" data-cancel="${a.id}">Cancel appointment</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-reassign]').forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.reassign;
    const sel = box.querySelector(`[data-swap="${id}"]`);
    const { ok } = await api(`/api/appointments/${id}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groomerId: sel.value }) });
    if (ok) { state.affected = state.affected.filter((x) => x.id != id); renderAffected(); load(); }
  });
  box.querySelectorAll('[data-cancel]').forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.cancel;
    const { ok } = await api(`/api/appointments/${id}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }) });
    if (ok) { state.affected = state.affected.filter((x) => x.id != id); renderAffected(); load(); }
  });
}

// ---------- staff PIN gate ----------
function showGate(msg) {
  $('#loginGate').classList.remove('hidden');
  $('#app').classList.add('hidden');
  const err = $('#pinErr');
  if (msg) { err.textContent = msg; err.classList.remove('hidden'); } else { err.classList.add('hidden'); }
  $('#pinInput').value = '';
  $('#pinInput').focus();
}
async function verifyPin(pin) {
  const r = await fetch(API_BASE + '/api/staff/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
  });
  return r.ok;
}
async function tryPin() {
  const pin = $('#pinInput').value.trim();
  if (!pin) return;
  if (await verifyPin(pin)) {
    STAFF_KEY = pin;
    sessionStorage.setItem('staffKey', pin);
    $('#loginGate').classList.add('hidden');
    $('#app').classList.remove('hidden');
    init();
  } else {
    showGate('Incorrect PIN, try again.');
  }
}
$('#pinSubmit').onclick = tryPin;
$('#pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryPin(); });

(async function boot() {
  const remembered = sessionStorage.getItem('staffKey');
  if (remembered && await verifyPin(remembered)) {
    STAFF_KEY = remembered;
    $('#loginGate').classList.add('hidden');
    $('#app').classList.remove('hidden');
    init();
    return;
  }
  sessionStorage.removeItem('staffKey');
  showGate();
})();
