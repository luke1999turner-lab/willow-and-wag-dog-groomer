const API_BASE = 'https://willow-and-wag-api.luke1999-turner.workers.dev';
// Staff calendar: day view across all groomers, reschedule, cancel, block out time,
// waitlist, walk-in/phone bookings, and a morning brief of bookings made while the
// shop was closed. Also includes a Leads pipeline (kanban) page and a Rota page
// (shift scheduling, weekly templates, time clock) — see the matching sections
// near the bottom of this file.
const $ = (s) => document.querySelector(s); function parseDogInfo(notes){ if (!notes) return null; const m = notes.match(/^Dog:\s*([^·\n]+?)\s*·\s*Breed:\s*([^·\n]+?)\s*·\s*Size:\s*([^\n]+)/); if (!m) return null; const rest = notes.slice(m[0].length).replace(/^\n/, '').trim(); return { dog: m[1].trim(), breed: m[2].trim(), size: m[3].trim(), rest }; } function dogTileLabel(a){ const info = parseDogInfo(a.notes); if (!info) return a.client_name; const firstName = (a.client_name || '').split(' ')[0]; return `${info.dog} (${firstName})`; }
let STAFF_TOKEN = '';
const api = (u, o = {}) => {
  o.headers = { ...(o.headers || {}), Authorization: `Bearer ${STAFF_TOKEN}` };
  return fetch(API_BASE + u, o).then(async (r) => {
    if (r.status === 401 && STAFF_TOKEN) { STAFF_TOKEN = ''; sessionStorage.removeItem('staffToken'); showGate('Your session expired. Please sign in again.'); }
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  });
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

const DAY_START = 8 * 60, DAY_END = 20 * 60, PXH = 56; // visible window 08:00-20:00
const PXMIN = PXH / 60;
const state = { date: null, view: 'day', page: 'calendar', groomers: [], services: [], editing: null, affected: [], blocks: [], editingDate: null, rotaWeekDate: null, leads: [], rota: {}, timeEntries: [], timesheet: [], editingLead: null, editingShift: null };

function hoursForDow(dow) {
  const h = (state.hours || []).find((x) => x.dow === dow);
  return (h && h.open_min != null && h.close_min != null) ? h : null;
}
function dowOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
// Derive the visible day-grid window from real opening hours, rounded
// outward to whole hours. Returns null when the shop is closed all day.
function dayWindowFor(dateStr) {
  const h = hoursForDow(dowOf(dateStr));
  if (!h) return null;
  return { start: Math.floor(h.open_min / 60) * 60, end: Math.ceil(h.close_min / 60) * 60 };
}
// Week view shows all 7 days in one grid, so its window has to cover
// whichever days are open; closed days within the week just render empty.
function weekWindowFor(dateStrs) {
  let lo = null, hi = null;
  dateStrs.forEach((ds) => {
    const h = hoursForDow(dowOf(ds));
    if (!h) return;
    const s = Math.floor(h.open_min / 60) * 60, e = Math.ceil(h.close_min / 60) * 60;
    if (lo == null || s < lo) lo = s;
    if (hi == null || e > hi) hi = e;
  });
  if (lo == null) return { start: DAY_START, end: DAY_END };
  return { start: lo, end: hi };
}

async function init() {
  state.groomers = (await api('/api/groomers')).data;
  state.services = (await api('/api/services')).data;
  state.hours = (await api('/api/hours')).data;
  const t = new Date(); state.date = t.toISOString().slice(0, 10);
  state.rotaWeekDate = mondayOf(state.date);
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
  $('#shGroomer').innerHTML = opts;

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
  $('#panelToggleBtn').onclick = togglePanel;
  $('#panelCloseBtn').onclick = closePanel;
  $('#dpBrief').onclick = openBrief;
  document.querySelectorAll('[data-close]').forEach((b) => b.onclick = closeModals);
  $('#saveBlock').onclick = saveBlock;
  $('#saveAppt').onclick = saveAppt;
  $('#cancelAppt').onclick = cancelAppt;
  $('#noShowAppt').onclick = noShowAppt;
  $('#completeAppt').onclick = completeAppt;
  $('#toggleArrived').onclick = toggleArrivedFromModal;
  $('#rGroomer').onchange = $('#rDate').onchange = refreshRTimes;
  $('#nbService').onchange = $('#nbGroomer').onchange = $('#nbDate').onchange = refreshNBTimes;
  $('#saveNewBooking').onclick = saveNewBooking;
  $('#blockTabAdd').onclick = () => switchBlockTab('add');
  $('#blockTabRemove').onclick = () => switchBlockTab('remove');
  // Leads pipeline nav + modal
  $('#navCalendarBtn').onclick = () => switchPage('calendar');
  $('#navLeadsBtn').onclick = () => switchPage('leads');
  $('#newLeadBtn').onclick = openNewLead;
  $('#saveLeadBtn').onclick = saveLead;
  $('#ldStage').onchange = onLeadStageChange;
  $('#addNoteBtn').onclick = addLeadNote;
  $('#markLostBtn').onclick = markLeadLost;
  $('#convertLeadBtn').onclick = convertLead;
  // Rota nav + modals
  $('#navRotaBtn').onclick = () => switchPage('rota');
  $('#rotaPrevBtn').onclick = () => switchRotaWeek(-1);
  $('#rotaTodayBtn').onclick = () => { state.rotaWeekDate = mondayOf(new Date().toISOString().slice(0, 10)); loadRota(); };
  $('#rotaNextBtn').onclick = () => switchRotaWeek(1);
  $('#manageTemplatesBtn').onclick = openTemplatesModal;
  $('#applyTemplatesBtn').onclick = applyTemplates;
  $('#copyLastWeekBtn').onclick = copyLastWeek;
  $('#saveShiftBtn').onclick = saveShift;
  $('#deleteShiftBtn').onclick = deleteShift;
  $('#addTemplateBtn').onclick = addTemplate;

  updateHero();
  setInterval(updateHero, 30000);
  setInterval(() => { if (state.date === new Date().toISOString().slice(0, 10)) load(); }, 60000);

  load();
  refreshWaitlistCount();
  refreshMorningBrief();
  applyPanelState();
  window.addEventListener('resize', applyPanelState);
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
  const noShowCount = appts.filter((a) => a.status === 'no-show').length;
  $('#statArrivedSub').textContent = booked.length ? `${booked.length - arrived} still due in${noShowCount ? ` · ${noShowCount} no-show` : ''}` : 'No bookings today';
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const dayTs = toTs(today, 0);
  renderPanelNowNext(booked, dayTs, nowMin);
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
  renderPanelWaitlist(data);
}

async function refreshMorningBrief() {
  const { data } = await api('/api/staff/morning-brief');
  const n = (data.appointments || []).length;
  $('#briefBtn').textContent = n ? `Morning brief (${n})` : 'Morning brief';
  renderPanelBrief(n);
}

// ---------- Today panel (collapsible right-side panel) ----------
const PANEL_KEY = 'willowPanelCollapsed';
function isMobilePanel() { return window.innerWidth <= 1100; }
function applyPanelState() {
  const panel = $('#dayPanel'); if (!panel) return;
  if (isMobilePanel()) {
    panel.classList.remove('panel-collapsed');
  } else {
    panel.classList.remove('panel-open-mobile');
    const collapsed = localStorage.getItem(PANEL_KEY) === '1';
    panel.classList.toggle('panel-collapsed', collapsed);
  }
}
function togglePanel() {
  const panel = $('#dayPanel'); if (!panel) return;
  if (isMobilePanel()) {
    panel.classList.toggle('panel-open-mobile');
  } else {
    const collapsed = panel.classList.toggle('panel-collapsed');
    localStorage.setItem(PANEL_KEY, collapsed ? '1' : '0');
  }
}
function closePanel() {
  const panel = $('#dayPanel'); if (!panel) return;
  if (isMobilePanel()) {
    panel.classList.remove('panel-open-mobile');
  } else {
    panel.classList.add('panel-collapsed');
    localStorage.setItem(PANEL_KEY, '1');
  }
}
// Per-groomer Now/Next glance: what each groomer is doing right now and who's
// next, derived entirely from today's already-fetched appointments — no new
// endpoints needed. Shows the dog's name (via the existing dogTileLabel
// helper from the staff-calendar dog-info parsing) instead of just the owner.
function renderPanelNowNext(booked, dayTs, nowMin) {
  const box = $('#dpNowNext'); if (!box) return;
  box.innerHTML = state.groomers.map((b) => {
    const mine = booked.filter((a) => a.groomer_id === b.id).sort((a, c) => a.start_ts - c.start_ts);
    const nowAppt = mine.find((a) => (a.start_ts - dayTs) <= nowMin && nowMin < (a.end_ts - dayTs));
    const nextAppt = mine.find((a) => (a.start_ts - dayTs) > nowMin);
    let line;
    if (nowAppt) {
      const lateBit = nowAppt.arrived_at ? '' : ` <span class="dp-late">· due ${fmt(nowAppt.start_ts - dayTs)} — not arrived</span>`;
      line = `<div class="dp-now"><b>${dogTileLabel(nowAppt)}</b> — ${nowAppt.service_name} until ${fmt(nowAppt.end_ts - dayTs)}${lateBit}</div>`;
    } else if (nextAppt) {
      line = `<div class="dp-free">Free until ${fmt(nextAppt.start_ts - dayTs)} <span class="dp-next-who">(${dogTileLabel(nextAppt)} · ${nextAppt.service_name})</span></div>`;
    } else {
      line = `<div class="dp-free">Free until end of day</div>`;
    }
    return `<div class="dp-staff-row">
      <div class="dp-staff-name"><span class="sw" style="background:${b.color}"></span>${b.name}</div>
      ${line}
    </div>`;
  }).join('');
}
function renderPanelWaitlist(data) {
  const box = $('#dpWaitlist'); if (!box) return;
  if (!data.length) { box.innerHTML = `<div class="dp-empty">No one waiting.</div>`; return; }
  box.innerHTML = data.slice(0, 3).map((w) => `
    <div class="dp-wl-row" data-open-wl="1">
      <b>${w.client_name}</b>
      <div class="dp-wl-meta">${w.service_name || 'Any service'} · Preferred: ${w.preferred_date || 'Any date'}</div>
    </div>`).join('') + (data.length > 3 ? `<div class="dp-wl-more">+${data.length - 3} more</div>` : '');
  box.querySelectorAll('[data-open-wl]').forEach((el) => el.onclick = openWaitlist);
}
function renderPanelBrief(n) {
  const el = $('#dpBrief'); if (!el) return;
  const countEl = el.querySelector('.dp-brief-count');
  if (countEl) countEl.textContent = n ? `${n} new` : 'None';
  el.classList.toggle('has-items', n > 0);
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
  const dow = dt.getDay(); // 0=Sun..6=Sat
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
  const winW = weekWindowFor(days);
  const DAY_START = winW.start, DAY_END = winW.end;
  const today = new Date().toISOString().slice(0, 10);
  const hours = [];
  for (let h = DAY_START; h < DAY_END; h += 60) hours.push(h);

  let html = `<div class="colhead gutterhead"></div>`;
  html += days.map((d) => {
    const dt = new Date(d + 'T00:00');
    const dayName = dt.toLocaleDateString('en-GB', { weekday: 'short' });
    return `<div class="colhead weekcolhead ${d === today ? 'is-today' : ''}" data-date="${d}">
      <div class="wk-dayname">${dayName}</div><div class="wk-daynum">${dt.getDate()}</div></div>`;
  }).join('');

  html += `<div class="gutter" style="grid-column:1">` +
    hours.map((h) => `<div class="hourline"><span>${fmt(h)}</span></div>`).join('') + `</div>`;

  days.forEach((d) => {
    const dayTs = toTs(d, 0);
    const dayAppts = appts.filter((a) => (a.status === 'booked' || a.status === 'no-show' || a.status === 'completed') && fromTs(a.start_ts).date === d)
      .sort((a, b) => a.start_ts - b.start_ts);
    const dayBlocks = blocks.filter((bl) => fromTs(bl.start_ts).date <= d && fromTs(bl.end_ts - 1).date >= d);
    let col = `<div class="daycol week-daycol" data-date="${d}">`;
    dayBlocks.forEach((bl) => {
      col += `<div class="wk-chip wk-block">${bl.reason}${bl.groomer_name ? ' · ' + bl.groomer_name : ''}</div>`;
    });
    if (!dayAppts.length && !dayBlocks.length) col += `<div class="wk-empty">No bookings</div>`;
    dayAppts.forEach((a) => {
      const min = a.start_ts - dayTs;
      const dimmed = a.status === 'no-show' || a.status === 'completed';
      const label = a.status === 'no-show' ? ' · NO-SHOW' : a.status === 'completed' ? ' · DONE' : '';
      col += `<div class="wk-chip wk-appt${dimmed ? ' appt-dimmed' : ''}" data-id="${a.id}" style="border-left-color:${staffColorFor(a)}">
        <b>${fmt(min)}</b> ${dogTileLabel(a)}<span class="wk-who">${a.groomer_name} · ${a.service_name}${label}</span></div>`;
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
  appts.filter((a) => a.status === 'booked' || a.status === 'no-show' || a.status === 'completed').forEach((a) => {
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
    const inMonth = new Date(d + 'T00:00').getMonth() === monthIdx;
    const dayAppts = (apptsByDate.get(d) || []).sort((a, b) => a.start_ts - b.start_ts);
    const dayBlocks = blocksByDate.get(d) || [];
    const dayTs = toTs(d, 0);
    let cell = `<div class="monthcell ${inMonth ? '' : 'is-outside'} ${d === today ? 'is-today' : ''}" data-date="${d}">`;
    cell += `<div class="mc-num">${new Date(d + 'T00:00').getDate()}${dayBlocks.length ? ' <span class="mc-block-flag" title="' + dayBlocks.map((b) => b.reason).join(', ') + '">⛔</span>' : ''}</div>`;
    dayAppts.slice(0, 3).forEach((a) => {
      const min = a.start_ts - dayTs;
      const dimmed = a.status === 'no-show' || a.status === 'completed';
      cell += `<div class="mc-chip${dimmed ? ' appt-dimmed' : ''}" data-id="${a.id}" style="background:${staffColorFor(a)}">${fmt(min)} ${dogTileLabel(a)}</div>`;
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
  const win = dayWindowFor(state.date);
  if (!win) {
    const cal0 = $('#cal');
    cal0.className = 'cal cal-closed';
    cal0.style.gridTemplateColumns = '1fr';
    const weekday = new Date(state.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long' });
    let closedHtml = `<div class="closed-card">Closed — ${weekday}</div>`;
    const strayItems = [];
    blocks.forEach((bl) => strayItems.push({ type: 'block', bl }));
    appts.filter((a) => a.status === 'booked' || a.status === 'no-show' || a.status === 'completed').forEach((a) => strayItems.push({ type: 'appt', a }));
    if (strayItems.length) {
      closedHtml += `<div class="closed-extra">` + strayItems.map((x) => {
        if (x.type === 'block') return `<div class="wk-chip wk-block">${x.bl.reason}${x.bl.groomer_name ? ' · ' + x.bl.groomer_name : ''}</div>`;
        return `<div class="wk-chip wk-appt" data-id="${x.a.id}" style="border-left-color:${staffColorFor(x.a)}"><b>${fmt(x.a.start_ts - toTs(state.date, 0))}</b> ${dogTileLabel(x.a)}<span class="wk-who">${x.a.groomer_name} · ${x.a.service_name}</span></div>`;
      }).join('') + `</div>`;
    }
    cal0.innerHTML = closedHtml;
    cal0.querySelectorAll('.wk-appt').forEach((el) => el.onclick = () => openAppt(+el.dataset.id));
    return;
  }
  const DAY_START = win.start, DAY_END = win.end;
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
    appts.filter((a) => a.groomer_id === b.id && (a.status === 'booked' || a.status === 'no-show' || a.status === 'completed')).forEach((a) => {
      const s = a.start_ts - dayTs, dur = a.end_ts - a.start_ts;
      const dimmed = a.status === 'no-show' || a.status === 'completed';
      const label = a.status === 'no-show' ? '<span class="status-label">NO-SHOW</span>' : a.status === 'completed' ? '<span class="status-label">DONE</span>' : '';
      col += `<div class="appt${dimmed ? ' appt-dimmed' : ''}" data-id="${a.id}" style="top:${(s - DAY_START) * PXMIN}px;height:${dur * PXMIN - 2}px;background:${b.color}">
        <span class="arrived-toggle ${a.arrived_at ? 'on' : ''}" data-id="${a.id}" title="${a.arrived_at ? 'Arrived - click to undo' : 'Mark arrived'}">✓</span>
        <b>${dogTileLabel(a)}</b><small>${fmt(s)} · ${a.service_name}</small>${label}</div>`;
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
    ${(() => { const info = parseDogInfo(a.notes); if (info) { return `<div><span class="k">Dog</span><span class="v">${info.dog}</span></div><div><span class="k">Breed</span><span class="v">${info.breed}</span></div><div><span class="k">Size</span><span class="v">${info.size}</span></div>${info.rest ? `<div><span class="k">Notes</span><span class="v">${info.rest}</span></div>` : ''}`; } return a.notes ? `<div><span class="k">Notes</span><span class="v">${a.notes}</span></div>` : ''; })()}`;
  $('#rGroomer').value = a.groomer_id;
  $('#rDate').value = d;
  $('#apptErr').classList.add('hidden');
  $('#toggleArrived').textContent = a.arrived_at ? 'Undo arrived' : 'Mark arrived';
  $('#noShowAppt').style.display = (a.start_ts <= Math.floor(Date.now() / 60000)) ? '' : 'none';
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
async function noShowAppt() {
  if (!confirm('Mark this appointment as a no-show? The slot will be freed for other clients.')) return;
  await api(`/api/appointments/${state.editing.id}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'no-show' }) });
  closeModals(); load();
}
async function completeAppt() {
  await api(`/api/appointments/${state.editing.id}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) });
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
  ['apptModal', 'blockModal', 'waitlistModal', 'affectedModal', 'briefModal', 'newBookingModal', 'leadModal', 'shiftModal', 'templatesModal'].forEach((id) => $('#' + id).classList.add('hidden'));
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

// ==================== Leads pipeline (kanban) ====================
// A lightweight sales/inquiry board sitting alongside the calendar. Leads come
// in from the public chatbot (source:'chatbot') or get added here manually by
// staff (source:'manual') for a phone/walk-in inquiry that isn't ready to book
// yet. Drag a card between columns to move it through the pipeline; converting
// a lead creates (or reuses) a client record and marks the lead 'won'.
const LEAD_STATUSES = [
{ key: 'new', label: 'New' },
{ key: 'contacted', label: 'Contacted' },
{ key: 'qualified', label: 'Qualified' },
{ key: 'booked', label: 'Booked' },
{ key: 'won', label: 'Won' },
{ key: 'lost', label: 'Lost' },
];
// How long (in minutes) a lead can sit with no activity in a given stage
// before it's flagged as "needs attention". Won/lost leads never rot.
const ROT_THRESHOLD_MIN = { new: 1440, contacted: 4320, qualified: 10080, booked: 20160 };

function switchPage(page) {
state.page = page;
$('#calendarPage').classList.toggle('hidden', page !== 'calendar');
$('#leadsPage').classList.toggle('hidden', page !== 'leads');
$('#rotaPage').classList.toggle('hidden', page !== 'rota');
$('#navCalendarBtn').classList.toggle('primary', page === 'calendar');
$('#navCalendarBtn').classList.toggle('ghost', page !== 'calendar');
$('#navLeadsBtn').classList.toggle('primary', page === 'leads');
$('#navLeadsBtn').classList.toggle('ghost', page !== 'leads');
$('#navRotaBtn').classList.toggle('primary', page === 'rota');
$('#navRotaBtn').classList.toggle('ghost', page !== 'rota');
if (page === 'leads') loadLeads();
if (page === 'rota') loadRota();
}

function isRotting(lead) {
const threshold = ROT_THRESHOLD_MIN[lead.status];
if (!threshold) return false;
const nowMin = Math.floor(Date.now() / 60000);
return (nowMin - lead.last_activity_at) > threshold;
}
function leadAgeLabel(ts) {
const nowMin = Math.floor(Date.now() / 60000);
const diffMin = Math.max(0, nowMin - ts);
if (diffMin < 60) return 'just now';
if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
return `${Math.floor(diffMin / 1440)}d ago`;
}

async function loadLeads() {
const { data } = await api('/api/leads');
state.leads = data || [];
renderLeadsBoard();
$('#leadsSub').textContent = `${state.leads.length} lead${state.leads.length === 1 ? '' : 's'} in the pipeline`;
}

function leadCardHtml(l) {
const rot = isRotting(l);
const overdue = l.follow_up_date && l.follow_up_date < new Date().toISOString().slice(0, 10) && l.status !== 'won' && l.status !== 'lost';
return `<div class="lead-card${(rot || overdue) ? ' rotting' : ''}" draggable="true" data-id="${l.id}">
  <div class="lc-name">${l.contact_name}</div>
  <div class="lc-meta">${l.intent || (l.source === 'chatbot' ? 'From the chatbot' : 'Manual entry')}</div>
  <div class="lc-meta">${leadAgeLabel(l.last_activity_at)}</div>
  ${overdue ? `<div class="lc-rot">Follow-up overdue</div>` : (rot ? `<div class="lc-rot">Needs a follow-up</div>` : '')}
</div>`;
}

function renderLeadsBoard() {
const board = $('#leadsBoard'); if (!board) return;
board.innerHTML = LEAD_STATUSES.map((col) => {
const items = state.leads.filter((l) => l.status === col.key).sort((a, b) => a.pipeline_position - b.pipeline_position);
return `<div class="leads-col" data-status="${col.key}">
<div class="leads-col-head"><span class="leads-col-title">${col.label}</span><span class="leads-col-count">${items.length}</span></div>
<div class="leads-col-body">${items.length ? items.map(leadCardHtml).join('') : `<div class="leads-empty">No leads</div>`}</div>
</div>`;
}).join('');
wireLeadsDnD();
}

function wireLeadsDnD() {
const board = $('#leadsBoard');
board.querySelectorAll('.lead-card').forEach((card) => {
card.addEventListener('dragstart', (e) => {
card.classList.add('dragging');
e.dataTransfer.effectAllowed = 'move';
e.dataTransfer.setData('text/plain', card.dataset.id);
});
card.addEventListener('dragend', () => card.classList.remove('dragging'));
card.addEventListener('click', () => openLead(+card.dataset.id));
});
board.querySelectorAll('.leads-col').forEach((col) => {
col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
col.addEventListener('drop', async (e) => {
e.preventDefault();
col.classList.remove('drag-over');
const id = +e.dataTransfer.getData('text/plain');
const status = col.dataset.status;
const lead = state.leads.find((x) => x.id === id);
if (!lead || lead.status === status) return;
const position = state.leads.filter((x) => x.status === status).length;
// Optimistic UI: reflect the move immediately, then confirm with the API.
lead.status = status; lead.pipeline_position = position; lead.last_activity_at = Math.floor(Date.now() / 60000);
renderLeadsBoard();
await api(`/api/leads/${id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, position }) });
loadLeads();
});
});
}

function openNewLead() {
state.editingLead = null;
$('#leadModalTitle').textContent = 'New lead';
$('#ldName').value = ''; $('#ldEmail').value = ''; $('#ldPhone').value = ''; $('#ldIntent').value = '';
$('#leadMeta').innerHTML = '&nbsp;';
$('#leadErr').classList.add('hidden');
$('#markLostBtn').classList.add('hidden');
$('#convertLeadBtn').classList.add('hidden');
$('#saveLeadBtn').textContent = 'Add lead';
$('#leadModal').classList.remove('hidden');
  populateStageSelect('new');
  $('#ldFollowUp').value = '';
  $('#ldBookingRow').classList.add('hidden');
  $('#ldNoteText').value = '';
  $('#leadTimeline').innerHTML = 'Save the lead to start tracking activity.';
}

function openLead(id) {
const l = state.leads.find((x) => x.id === id); if (!l) return;
state.editingLead = l;
$('#leadModalTitle').textContent = 'Edit lead';
$('#ldName').value = l.contact_name;
$('#ldEmail').value = l.email || '';
$('#ldPhone').value = l.phone || '';
$('#ldIntent').value = l.intent || '';
const stageLabel = (LEAD_STATUSES.find((s) => s.key === l.status) || {}).label || l.status;
$('#leadMeta').textContent = `Stage: ${stageLabel} · Source: ${l.source === 'chatbot' ? 'Chatbot' : 'Manual'} · Last activity ${leadAgeLabel(l.last_activity_at)}`;
$('#leadErr').classList.add('hidden');
$('#markLostBtn').classList.toggle('hidden', l.status === 'lost' || l.status === 'won');
$('#convertLeadBtn').classList.toggle('hidden', l.status === 'won');
$('#saveLeadBtn').textContent = 'Save changes';
$('#leadModal').classList.remove('hidden');
  populateStageSelect(l.status);
  $('#ldFollowUp').value = l.follow_up_date || '';
  $('#ldBookingRow').classList.toggle('hidden', l.status !== 'won');
  $('#ldBookingRef').value = l.booking_ref || '';
  $('#ldNoteText').value = '';
  loadLeadTimeline(l.id);
}

async function saveLead() {
const err = $('#leadErr');
const name = $('#ldName').value.trim();
if (!name) { err.textContent = 'Name is required.'; err.classList.remove('hidden'); return; }
const body = { contactName: name, email: $('#ldEmail').value.trim(), phone: $('#ldPhone').value.trim(), intent: $('#ldIntent').value.trim() , followUpDate: $('#ldFollowUp').value || null, bookingRef: $('#ldBookingRef').value.trim() || null };
if (state.editingLead) {
const { ok, data } = await api(`/api/leads/${state.editingLead.id}`,
{ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
if (!ok) { err.textContent = data.error || 'Could not save.'; err.classList.remove('hidden'); return; }
} else {
body.source = 'manual';
const { ok, data } = await api('/api/leads',
{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
if (!ok) { err.textContent = data.error || 'Could not save.'; err.classList.remove('hidden'); return; }
}
closeModals(); loadLeads();

  function populateStageSelect(current) {
    const sel = $('#ldStage');
    sel.innerHTML = LEAD_STATUSES.map(s => `<option value="${s.key}" ${s.key===current?'selected':''}>${s.label}</option>`).join('');
  }

  async function onLeadStageChange() {
    if (!state.editingLead) return;
    const newStatus = $('#ldStage').value;
    if (newStatus === state.editingLead.status) return;
    const { ok, data } = await api(`/api/leads/${state.editingLead.id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: newStatus, position: 0 }) });
    if (!ok) { alert(data.error || 'Could not change stage.'); populateStageSelect(state.editingLead.status); return; }
    state.editingLead.status = newStatus;
    const stageLabel2 = (LEAD_STATUSES.find(s => s.key === newStatus) || {}).label || newStatus;
    $('#leadMeta').textContent = $('#leadMeta').textContent.replace(/^Stage: [^·]+/, `Stage: ${stageLabel2} `);
    $('#ldBookingRow').classList.toggle('hidden', newStatus !== 'won');
    await loadLeadTimeline(state.editingLead.id);
    await loadLeads();
  }

  async function addLeadNote() {
    if (!state.editingLead) return;
    const text = $('#ldNoteText').value.trim();
    if (!text) return;
    const { ok, data } = await api(`/api/leads/${state.editingLead.id}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text }) });
    if (!ok) { alert(data.error || 'Could not add note.'); return; }
    $('#ldNoteText').value = '';
    await loadLeadTimeline(state.editingLead.id);
  }

  function timelineEntryLabel(entry) {
    const when = new Date(entry.occurred_at * 60000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    let text = entry.verb;
    let payload = {};
    try { payload = entry.payload ? JSON.parse(entry.payload) : {}; } catch (e) {}
    if (entry.verb === 'lead.created') text = 'Lead created' + (payload.source ? ' (' + payload.source + ')' : '');
    else if (entry.verb === 'lead.stage_changed') text = 'Stage changed to ' + (payload.to || payload.status || '');
    else if (entry.verb === 'lead.note') text = payload.body || 'Note added';
    else if (entry.verb === 'lead.converted') text = 'Converted to client';
    else if (entry.verb === 'lead.booked') text = 'Booking created' + (payload.ref ? ' (' + payload.ref + ')' : '');
    else if (entry.verb === 'lead.follow_up_set') text = 'Follow-up set for ' + (payload.date || '');
    return '<div class="tl-entry"><span class="tl-when">' + when + '</span><span class="tl-text">' + text + '</span><span class="tl-actor">' + (entry.actor_label || '') + '</span></div>';
  }

  async function loadLeadTimeline(id) {
    const box = $('#leadTimeline');
    box.innerHTML = 'Loading…';
    const { ok, data } = await api(`/api/leads/${id}/timeline`);
    if (!ok || !Array.isArray(data) || !data.length) { box.innerHTML = 'No activity yet.'; return; }
    box.innerHTML = data.map(timelineEntryLabel).join('');
  }
}

async function markLeadLost() {
const l = state.editingLead; if (!l) return;
if (!confirm(`Mark ${l.contact_name} as lost?`)) return;
const position = state.leads.filter((x) => x.status === 'lost').length;
await api(`/api/leads/${l.id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'lost', position }) });
closeModals(); loadLeads();
}

async function convertLead() {
const l = state.editingLead; if (!l) return;
if (!confirm(`Convert ${l.contact_name} to a client record? This marks the lead as won.`)) return;
const { ok } = await api(`/api/leads/${l.id}/convert`, { method: 'POST' });
if (ok) { closeModals(); loadLeads(); alert('Converted — a client record has been created.'); }
}

// ==================== Rota (shifts, templates, time clock) ====================
// A weekly staff schedule sitting alongside the calendar and leads pipeline.
// Shifts are drafted directly on the grid (click an empty cell) or generated
// in bulk from a saved weekly template pattern; "published" shifts render as
// solid gold chips so staff can tell what's confirmed from what's still a
// draft. A lightweight time clock and per-week timesheet round out the page.
const WEEKDAY_LABELS = [
{ dow: 1, label: 'Mon' }, { dow: 2, label: 'Tue' }, { dow: 3, label: 'Wed' },
{ dow: 4, label: 'Thu' }, { dow: 5, label: 'Fri' }, { dow: 6, label: 'Sat' }, { dow: 0, label: 'Sun' },
];
const hmToMin = (v) => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };

function switchRotaWeek(n) {
state.rotaWeekDate = addDays(state.rotaWeekDate, 7 * n);
loadRota();
}

async function loadRota() {
if (!state.rotaWeekDate) state.rotaWeekDate = mondayOf(state.date);
const { data } = await api(`/api/rota?week=${state.rotaWeekDate}`);
state.rota = data;
renderRotaWeekLabel();
renderRotaGrid();
await refreshTimeclock();
await loadTimesheet();
}

function renderRotaWeekLabel() {
const monday = mondayOf(state.rotaWeekDate);
const sunday = addDays(monday, 6);
$('#rotaWeekLabel').textContent = weekLabel(monday, sunday);
}

function renderRotaGrid() {
const grid = $('#rotaGrid');
const monday = mondayOf(state.rotaWeekDate);
const today = new Date().toISOString().slice(0, 10);
const dayFor = (i) => addDays(monday, i);

let html = `<div class="rota-head-row"><div class="rota-head-cell"></div>` +
[...Array(7)].map((_, i) => {
const d = dayFor(i);
const dt = new Date(d + 'T00:00');
const label = dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
return `<div class="rota-head-cell${d === today ? ' is-today' : ''}">${label}</div>`;
}).join('') + `</div>`;

(state.rota.groomers || []).forEach((b) => {
html += `<div class="rota-row">`;
html += `<div class="rota-staff-cell"><span class="sw" style="width:9px;height:9px;border-radius:50%;background:${b.color};display:inline-block;flex-shrink:0"></span>${b.name}</div>`;
for (let i = 0; i < 7; i++) {
const d = dayFor(i);
const dayTs = toTs(d, 0);
const shiftsHere = (state.rota.shifts || []).filter((s) => s.groomer_id === b.id && s.starts_at >= dayTs && s.starts_at < dayTs + 1440);
html += `<div class="rota-cell" data-groomer="${b.id}" data-date="${d}">` +
shiftsHere.map((s) => shiftChipHtml(s)).join('') + `</div>`;
}
html += `</div>`;
});
grid.innerHTML = html;

grid.querySelectorAll('.rota-cell').forEach((cell) => cell.addEventListener('click', (e) => {
if (e.target.closest('.shift-chip')) return;
openNewShift(+cell.dataset.groomer, cell.dataset.date);
}));
grid.querySelectorAll('.shift-chip').forEach((chip) => chip.addEventListener('click', (e) => {
e.stopPropagation();
openEditShift(+chip.dataset.id);
}));
}

function shiftChipHtml(s) {
const dayTs = toTs(fromTs(s.starts_at).date, 0);
const startMin = s.starts_at - dayTs;
const endMin = s.ends_at - dayTs;
const cls = s.status === 'published' ? 'is-published' : 'is-draft';
return `<div class="shift-chip ${cls}" data-id="${s.id}">
<span class="sc-time">${fmt(startMin)}–${fmt(endMin)}</span>
${s.break_min ? `<span class="sc-break">${s.break_min}m break</span>` : ''}
</div>`;
}

function openNewShift(groomerId, dateStr) {
state.editingShift = null;
$('#shiftModalTitle').textContent = 'New shift';
$('#shGroomer').value = groomerId;
$('#shDate').value = dateStr;
$('#shStart').value = '09:00';
$('#shEnd').value = '17:00';
$('#shBreak').value = '0';
$('#shPublished').checked = false;
$('#shiftErr').classList.add('hidden');
$('#deleteShiftBtn').classList.add('hidden');
$('#saveShiftBtn').textContent = 'Add shift';
$('#shiftModal').classList.remove('hidden');
}

function openEditShift(id) {
const s = (state.rota.shifts || []).find((x) => x.id === id); if (!s) return;
state.editingShift = s;
$('#shiftModalTitle').textContent = 'Edit shift';
const { date, min: startMin } = fromTs(s.starts_at);
const endMin = s.ends_at - toTs(date, 0);
$('#shGroomer').value = s.groomer_id;
$('#shDate').value = date;
$('#shStart').value = fmt(startMin);
$('#shEnd').value = fmt(endMin);
$('#shBreak').value = String(s.break_min || 0);
$('#shPublished').checked = s.status === 'published';
$('#shiftErr').classList.add('hidden');
$('#deleteShiftBtn').classList.remove('hidden');
$('#saveShiftBtn').textContent = 'Save changes';
$('#shiftModal').classList.remove('hidden');
}

async function saveShift() {
const err = $('#shiftErr');
const groomerId = $('#shGroomer').value;
const dateStr = $('#shDate').value;
const startMin = hmToMin($('#shStart').value);
const endMin = hmToMin($('#shEnd').value);
if (endMin <= startMin) { err.textContent = 'End must be after start.'; err.classList.remove('hidden'); return; }
const startsAt = toTs(dateStr, startMin);
const endsAt = toTs(dateStr, endMin);
const breakMin = Math.max(0, parseInt($('#shBreak').value, 10) || 0);
const status = $('#shPublished').checked ? 'published' : 'draft';
const body = { groomerId: +groomerId, startsAt, endsAt, breakMin, status };
let res;
if (state.editingShift) {
res = await api(`/api/shifts/${state.editingShift.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
} else {
res = await api('/api/shifts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
if (!res.ok) { err.textContent = res.data.error || 'Could not save.'; err.classList.remove('hidden'); return; }
closeModals(); loadRota();
}

async function deleteShift() {
const s = state.editingShift; if (!s) return;
if (!confirm('Delete this shift?')) return;
await api(`/api/shifts/${s.id}`, { method: 'DELETE' });
closeModals(); loadRota();
}

async function applyTemplates() {
if (!confirm("Build this week's draft shifts from your saved templates? Existing shifts are left untouched.")) return;
const { data } = await api('/api/shifts/apply-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week: state.rotaWeekDate }) });
await loadRota();
alert(`${data.created || 0} shift${data.created === 1 ? '' : 's'} created.`);
}

async function copyLastWeek() {
const fromWeek = addDays(mondayOf(state.rotaWeekDate), -7);
if (!confirm("Copy last week's shifts into this week?")) return;
const { data } = await api('/api/shifts/copy-week', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromWeek, toWeek: state.rotaWeekDate }) });
await loadRota();
alert(`${data.created || 0} shift${data.created === 1 ? '' : 's'} copied.`);
}

function openTemplatesModal() {
$('#tplGroomer').innerHTML = state.groomers.map((b) => `<option value="${b.id}">${b.name}</option>`).join('');
renderTemplatesList();
$('#templateErr').classList.add('hidden');
$('#templatesModal').classList.remove('hidden');
}

function renderTemplatesList() {
const box = $('#templatesList');
const templates = state.rota.templates || [];
const dayLabel = (w) => (WEEKDAY_LABELS.find((x) => x.dow === w) || {}).label || w;
if (!templates.length) { box.innerHTML = `<p style="font-size:13px;color:var(--muted)">No templates yet — add one below.</p>`; return; }
box.innerHTML = templates.map((t) => {
const groomer = state.groomers.find((b) => b.id === t.groomer_id);
return `<div class="template-row">
<div><b>${dayLabel(t.weekday)}</b> · ${groomer ? groomer.name : 'Unassigned'}
<div class="tr-meta">${fmt(t.start_min)}–${fmt(t.end_min)}${t.break_min ? ` · ${t.break_min}m break` : ''}</div></div>
<button class="link-danger" data-del-tpl="${t.id}">Remove</button>
</div>`;
}).join('');
box.querySelectorAll('[data-del-tpl]').forEach((btn) => btn.onclick = async () => {
await api(`/api/shift-templates/${btn.dataset.delTpl}`, { method: 'DELETE' });
const { data } = await api(`/api/rota?week=${state.rotaWeekDate}`);
state.rota = data;
renderTemplatesList();
});
}

async function addTemplate() {
const err = $('#templateErr');
const startMin = hmToMin($('#tplStart').value);
const endMin = hmToMin($('#tplEnd').value);
if (endMin <= startMin) { err.textContent = 'End must be after start.'; err.classList.remove('hidden'); return; }
const body = {
groomerId: +$('#tplGroomer').value, weekday: +$('#tplWeekday').value,
startMin, endMin, breakMin: Math.max(0, parseInt($('#tplBreak').value, 10) || 0),
};
const { ok, data } = await api('/api/shift-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
if (!ok) { err.textContent = data.error || 'Could not add.'; err.classList.remove('hidden'); return; }
err.classList.add('hidden');
const r = await api(`/api/rota?week=${state.rotaWeekDate}`);
state.rota = r.data;
renderTemplatesList();
}

// ---------- time clock ----------
async function refreshTimeclock() {
const { data } = await api('/api/time-entries?status=open');
state.timeEntries = data;
renderTimeclock();
}

function renderTimeclock() {
const grid = $('#timeclockGrid');
grid.innerHTML = state.groomers.map((b) => {
const open = (state.timeEntries || []).find((te) => te.groomer_id === b.id && te.status === 'open');
return `<div class="tc-card">
<div class="tc-name"><span class="sw" style="width:9px;height:9px;border-radius:50%;background:${b.color};display:inline-block;flex-shrink:0"></span>${b.name}</div>
<div class="tc-status${open ? ' on-clock' : ''}">${open ? 'Clocked in ' + leadAgeLabel(open.clock_in) : 'Not clocked in'}</div>
${open
? `<button class="btn ghost" data-clockout="${open.id}">Clock out</button>`
: `<button class="btn primary" data-clockin="${b.id}">Clock in</button>`}
</div>`;
}).join('');
grid.querySelectorAll('[data-clockin]').forEach((btn) => btn.onclick = async () => {
await api('/api/time-entries/clock-in', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groomerId: +btn.dataset.clockin }) });
await refreshTimeclock();
});
grid.querySelectorAll('[data-clockout]').forEach((btn) => btn.onclick = async () => {
await api(`/api/time-entries/${btn.dataset.clockout}/clock-out`, { method: 'POST' });
await refreshTimeclock();
await loadTimesheet();
});
}

// ---------- timesheet ----------
async function loadTimesheet() {
const monday = mondayOf(state.rotaWeekDate);
const sunday = addDays(monday, 6);
const { data } = await api(`/api/timesheets?from=${monday}&to=${sunday}`);
state.timesheet = data;
renderTimesheet();
}

function renderTimesheet() {
const table = $('#timesheetTable');
const rows = state.timesheet || [];
const totals = {};
const rowHtml = rows.map((te) => {
const durMin = te.clock_out ? (te.clock_out - te.clock_in) : null;
if (durMin != null) totals[te.groomer_name] = (totals[te.groomer_name] || 0) + durMin;
const hrs = durMin != null ? (durMin / 60).toFixed(1) + 'h' : '—';
return `<tr>
<td>${te.groomer_name}</td>
<td>${fmtFromTs(te.clock_in)}</td>
<td>${te.clock_out ? fmtFromTs(te.clock_out) : '<span style="color:var(--ok);font-weight:600">Still clocked in</span>'}</td>
<td>${hrs}</td>
</tr>`;
}).join('');
const totalRows = Object.entries(totals).map(([name, min]) => `<tr><td colspan="3">${name} total</td><td>${(min / 60).toFixed(1)}h</td></tr>`).join('');
table.innerHTML = `<thead><tr><th>Staff</th><th>Clocked in</th><th>Clocked out</th><th>Hours</th></tr></thead>
<tbody>${rowHtml || '<tr><td colspan="4" style="color:var(--muted)">No time entries this week.</td></tr>'}</tbody>
<tfoot>${totalRows}</tfoot>`;
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
async function login(pin) {
  const r = await fetch(API_BASE + '/api/staff/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
  async function checkSession(token) {
    const r = await fetch(API_BASE + '/api/staff/session', { headers: { Authorization: `Bearer ${token}` } });
    return r.ok;
  }
  async function tryPin() {
    const pin = $('#pinInput').value.trim();
    if (!pin) return;
    const res = await login(pin);
    if (res.ok && res.data.token) {
      STAFF_TOKEN = res.data.token;
      sessionStorage.setItem('staffToken', STAFF_TOKEN);
      $('#loginGate').classList.add('hidden');
      $('#app').classList.remove('hidden');
      init();
    } else if (res.status === 429) {
      showGate(res.data.error || 'Too many failed attempts. Please try again in a few minutes.');
    } else {
      showGate('Incorrect PIN, try again.');
    }
  }
  function signOut() {
    STAFF_TOKEN = '';
    sessionStorage.removeItem('staffToken');
    $('#app').classList.add('hidden');
    showGate();
  }
  $('#pinSubmit').onclick = tryPin;
  $('#pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryPin(); });
  const signOutBtn = $('#signOutBtn');
  if (signOutBtn) signOutBtn.onclick = signOut;

  (async function boot() {
    const remembered = sessionStorage.getItem('staffToken');
    if (remembered && await checkSession(remembered)) {
      STAFF_TOKEN = remembered;
      $('#loginGate').classList.add('hidden');
      $('#app').classList.remove('hidden');
      init();
      return;
    }
    sessionStorage.removeItem('staffToken');
    showGate();
  })();
