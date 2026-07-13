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
const state = { date: null, view: 'day', groomers: [], services: [], editing: null, affected: [], blocks: [], editingDate: null };

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

  $('#prev').onclick = () => shiftView(-1);
  $('#next').onclick = () => shiftView(1);
  $('#today').onclick = () => { state.date = new Date().toISOString().slice(0, 10); $('#date').value = state.date; load(); };
  $('#date').onchange = () => { state.date = $('#date').value; load(); };
  $('#weekBtn').onclick = () => { state.view = 'week'; setActiveViewBtn(); load(); };
  $('#monthBtn').onclick = () => { state.view = 'month'; setActiveViewBtn(); load(); };
  setActiveViewBtn();
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
  // Always reflects TODAY's real numbers, independent of whatever date/view
  // is currently being browsed in the calendar below.
  const today = new Date().toISOString().slice(0, 10);
  const booked = appts.filter((a) => a.status === 'booked');
  $('#statBookings').textContent = booked.length;
  $('#statBookingsSub').textContent = "Today's schedule";
  const arrived = booked.filter((a) => a.arrived_at).length;
  $('#statArrived').innerHTML = `${arrived} <span style="font-size:15px;color:var(--muted);font-weight:500">/ ${booked.length}</span>`;
  $('#statArrivedSub').textContent = booked.length ? `${booked.length - arrived} still due in` : 'No bookings today';
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const dayTs = toTs(today, 0);
  const upcoming = booked.filter((a) => (a.start_ts - dayTs) >= nowMin).sort((a, b) => a.start_ts - b.start_ts)[0];
  if (upcoming) {
    $('#statNext').textContent = fmt(upcoming.start_ts - dayTs);
    $('#statNextSub').textContent = `${upcoming.client_name} · ${upcoming.service_name} · ${upcoming.groomer_name}`;
  } else {
    $('#statNext').textContent = '—';
    $('#statNextSub').textContent = 'All done for today';
  }
  const serviceById = new Map(state.services.map((s) => [s.id, s]));
  const pence = booked.reduce((sum, a) => sum + (serviceById.get(a.service_id)?.price_pence || 0), 0);
  $('#statRevenue').textContent = `£${(pence / 100).toFixed(0)}`;
  const groomerCount = new Set(booked.map((a) => a.groomer_id)).size;
  $('#statRevenueSub').textContent = groomerCount ? `Across ${groomerCount} groomer${groomerCount === 1 ? '' : 's'}` : 'No bookings today';
}
async function refreshTodayStats() {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await api(`/api/appointments?from=${today}&to=${today}`);
  updateStats(data);
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

// ---------- date helpers ----------
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function mondayOf(dateStr) {
  const dt = new Date(dateStr + 'T00:00');
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  return addDays(dateStr, diff);
}
function firstOfMonthGridStart(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
  return mondayOf(first);
}
function weekLabel(monday, sunday) {
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  const a = new Date(monday + 'T00:00').toLocaleDateString('en-GB', opts);
  const b = new Date(sunday + 'T00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return `${a} – ${b}`;
}
function staffColorFor(a) {
  const g = state.groomers.find((x) => x.id === a.groomer_id);
  return g ? g.color : '#8a8272';
}

// Shift the visible period by n units — a day, a week, or a month, depending
// on which calendar view is currently active. Uses UTC date math throughout
// (matching how dates are stored/sent everywhere else in this app) so it
// can't drift depending on the browser's local timezone/DST offset.
function shiftView(n) {
  if (state.view === 'week') {
    state.date = addDays(state.date, 7 * n);
  } else if (state.view === 'month') {
    const [y, m, d] = state.date.split('-').map(Number);
    state.date = new Date(Date.UTC(y, m - 1 + n, Math.min(d, 28))).toISOString().slice(0, 10);
  } else {
    state.date = addDays(state.date, n);
  }
  $('#date').value = state.date;
  load();
}

function setActiveViewBtn() {
  $('#weekBtn').classList.toggle('primary', state.view === 'week');
  $('#weekBtn').classList.toggle('ghost', state.view !== 'week');
  $('#monthBtn').classList.toggle('primary', state.view === 'month');
  $('#monthBtn').classList.toggle('ghost', state.view !== 'month');
}

// Switch straight to Day view for a specific date — used when clicking a day
// header in Week view, or a day cell in Month view.
function switchToDay(d) {
  state.date = d;
  state.view = 'day';
  $('#date').value = d;
  setActiveViewBtn();
  load();
}

async function load() {
  refreshTodayStats();
  if (state.view === 'week') return loadWeek();
  if (state.view === 'month') return loadMonth();
  return loadDay();
}

async function loadDay() {
  $('#dayLabel').textContent = prettyDate(state.date);
  const [appts, blocks] = await Promise.all([
    api(`/api/appointments?from=${state.date}&to=${state.date}`),
    api(`/api/blocks?from=${state.date}&to=${state.date}`),
  ]);
  state.blocks = blocks.data;
  renderDay(appts.data, blocks.data);
}

async function loadWeek() {
  const monday = mondayOf(state.date);
  const sunday = addDays(monday, 6);
  $('#dayLabel').textContent = weekLabel(monday, sunday);
  const [appts, blocks] = await Promise.all([
    api(`/api/appointments?from=${monday}&to=${sunday}`),
    api(`/api/blocks?from=${monday}&to=${sunday}`),
  ]);
  renderWeek(monday, appts.data, blocks.data);
}

async function loadMonth() {
  const gridStart = firstOfMonthGridStart(state.date);
  const gridEnd = addDays(gridStart, 41);
  const [y, m] = state.date.split('-').map(Number);
  $('#dayLabel').textContent = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const [appts, blocks] = await Promise.all([
    api(`/api/appointments?from=${gridStart}&to=${gridEnd}`),
    api(`/api/blocks?from=${gridStart}&to=${gridEnd}`),
  ]);
  renderMonth(state.date, appts.data, blocks.data);
}

// ---------- week view ----------
// Agenda-style: each day shows its bookings as a stacked, time-ordered list
// (not absolutely time-positioned) so appointments from different groomers at
// the same time never visually collide. Click a chip to open it exactly like
// the day view; click a day's header to jump straight into Day view for it.
function renderWeek(monday, appts, blocks) {
  const cal = $('#cal');
  cal.className = 'cal';
  cal.style.gridTemplateColumns = `56px repeat(7, 1fr)`;
  const days = [...Array(7)].map((_, i) => addDays(monday, i));
  const today = new Date().toISOString().slice(0, 10);
  const hours = [];
  for (let h = DAY_START; h < DAY_END; h += 60) hours.push(h);

  let html = `<div class="colhead gutterhead"></div>`;
  html += days.map((d) => {
    const dt = new Date(d + 'T00:00');
    const dayName = dt.toLocaleDateString('en-GB', { weekday: 'short' });
    return `<div class="colhead weekcolhead ${d === today ? 'is-today' : ''}" data-date="${d}">
      <div class="wk-dayname">${dayName}</div><div class="wk-daynum">${dt.getUTCDate()}</div></div>`;
  }).join('');

  html += `<div class="gutter" style="grid-column:1">` +
    hours.map((h) => `<div class="hourline"><span>${fmt(h)}</span></div>`).join('') + `</div>`;

  days.forEach((d) => {
    const dayTs = toTs(d, 0);
    const dayAppts = appts.filter((a) => a.status === 'booked' && fromTs(a.start_ts).date === d)
      .sort((a, b) => a.start_ts - b.start_ts);
    const dayBlocks = blocks.filter((bl) => fromTs(bl.start_ts).date <= d && fromTs(bl.end_ts - 1).date >= d);
    let col = `<div class="daycol week-daycol" data-date="${d}">`;
    dayBlocks.forEach((bl) => {
      col += `<div class="wk-chip wk-block">${bl.reason}${bl.groomer_name ? ' · ' + bl.groomer_name : ''}</div>`;
    });
    if (!dayAppts.length && !dayBlocks.length) col += `<div class="wk-empty">No bookings</div>`;
    dayAppts.forEach((a) => {
      const min = a.start_ts - dayTs;
      col += `<div class="wk-chip wk-appt" data-id="${a.id}" style="border-left-color:${staffColorFor(a)}">
        <b>${fmt(min)}</b> ${a.client_name}<span class="wk-who">${a.groomer_name} · ${a.service_name}</span></div>`;
    });
    col += `</div>`;
    html += col;
  });

  cal.innerHTML = html;
  cal.querySelectorAll('.hourline').forEach((el) => { el.style.height = PXH + 'px'; });
  cal.querySelectorAll('.weekcolhead').forEach((el) => el.onclick = () => switchToDay(el.dataset.date));
  cal.querySelectorAll('.wk-appt').forEach((el) => el.onclick = () => {
    const d = el.closest('.week-daycol').dataset.date;
    openAppt(+el.dataset.id, d);
  });
}

// ---------- month view ----------
// A traditional month grid. Each cell shows up to 3 bookings as small colored
// chips (click to open), a "+N more" note if there are more, and a flag icon
// if any block/holiday covers that day. Click anywhere else on a day cell to
// jump into Day view for that date.
function renderMonth(dateStr, appts, blocks) {
  const cal = $('#cal');
  cal.className = 'cal';
  cal.style.gridTemplateColumns = `repeat(7, 1fr)`;
  const gridStart = firstOfMonthGridStart(dateStr);
  const [y, m] = dateStr.split('-').map(Number);
  const monthIdx = m - 1;
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const today = new Date().toISOString().slice(0, 10);

  const apptsByDate = new Map();
  appts.filter((a) => a.status === 'booked').forEach((a) => {
    const d = fromTs(a.start_ts).date;
    if (!apptsByDate.has(d)) apptsByDate.set(d, []);
    apptsByDate.get(d).push(a);
  });
  const blocksByDate = new Map();
  blocks.forEach((bl) => {
    let d = fromTs(bl.start_ts).date;
    const end = fromTs(bl.end_ts - 1).date;
    while (d <= end) {
      if (!blocksByDate.has(d)) blocksByDate.set(d, []);
      blocksByDate.get(d).push(bl);
      d = addDays(d, 1);
    }
  });

  let html = dayNames.map((n) => `<div class="colhead monthcolhead">${n}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    const inMonth = new Date(d + 'T00:00').getUTCMonth() === monthIdx;
    const dayAppts = (apptsByDate.get(d) || []).sort((a, b) => a.start_ts - b.start_ts);
    const dayBlocks = blocksByDate.get(d) || [];
    const dayTs = toTs(d, 0);
    let cell = `<div class="monthcell ${inMonth ? '' : 'is-outside'} ${d === today ? 'is-today' : ''}" data-date="${d}">`;
    cell += `<div class="mc-num">${new Date(d + 'T00:00').getUTCDate()}${dayBlocks.length ? ' <span class="mc-block-flag" title="' + dayBlocks.map((b) => b.reason).join(', ') + '">⛔</span>' : ''}</div>`;
    dayAppts.slice(0, 3).forEach((a) => {
      const min = a.start_ts - dayTs;
      cell += `<div class="mc-chip" data-id="${a.id}" style="background:${staffColorFor(a)}">${fmt(min)} ${a.client_name}</div>`;
    });
    if (dayAppts.length > 3) cell += `<div class="mc-more">+${dayAppts.length - 3} more</div>`;
    cell += `</div>`;
    html += cell;
  }
  cal.innerHTML = html;
  cal.querySelectorAll('.mc-chip').forEach((el) => el.onclick = (e) => {
    e.stopPropagation();
    const d = el.closest('.monthcell').dataset.date;
    openAppt(+el.dataset.id, d);
  });
  cal.querySelectorAll('.monthcell').forEach((el) => el.onclick = () => switchToDay(el.dataset.date));
}

function renderDay(appts, blocks) {
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
async function openAppt(id, forDate) {
  const d = forDate || state.date;
  const { data: list } = await api(`/api/appointments?from=${d}&to=${d}`);
  const a = list.find((x) => x.id === id); if (!a) return;
  state.editing = a;
  state.editingDate = d;
  const dayTs = toTs(d, 0);
  $('#apptInfo').innerHTML = `
    <div><span class="k">Client</span><span class="v">${a.client_name}</span></div>
    <div><span class="k">Contact</span><span class="v">${a.client_email} · ${a.client_phone || ''}</span></div>
    <div><span class="k">Service</span><span class="v">${a.service_name} (${a.duration_min} min)</span></div>
    <div><span class="k">With</span><span class="v">${a.groomer_name}</span></div>
    <div><span class="k">When</span><span class="v">${fmt(a.start_ts - dayTs)}, ${prettyDate(d)}</span></div>
    ${a.notes ? `<div><span class="k">Notes</span><span class="v">${a.notes}</span></div>` : ''}`;
  $('#rGroomer').value = a.groomer_id;
  $('#rDate').value = d;
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
  if (+groomerId === a.groomer_id && date === state.editingDate && !slots.some((s) => s.min === cur))
    opts = `<option value="${cur}">${fmt(cur)} (current)</option>` + opts;
  $('#rTime').innerHTML = opts || `<option value="">No free times</option>`;
  if (+groomerId === a.groomer_id && date === state.editingDate) $('#rTime').value = cur;
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
