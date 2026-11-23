"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  status: null,
  route: null,        // {origin, dest}
  nights: 3,
  adults: 1,
  bags: 1,
  outDate: null,
  retDate: null,
  outbound: null,
  flightTotal: null,  // best known price for the chosen trip
  flightTotalKind: "", // "all-in" or "from"
  hotel: null,
};

/* ---------- helpers ---------- */

async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({ error: "Bad response" }));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function cur() { return (state.status && state.status.currency) || "JPY"; }

function money(n) {
  if (n === null || n === undefined || isNaN(n)) return "–";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur(), maximumFractionDigits: 0 }).format(n);
  } catch { return Math.round(n).toLocaleString(); }
}

function short(n) {
  if (n === null || n === undefined) return "";
  const sym = money(0).replace(/[\d.,\s]/g, "");
  if (n >= 1e6) return sym + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return sym + Math.round(n / 1000) + "k";
  if (n >= 1e3) return sym + (n / 1000).toFixed(1) + "k";
  return sym + Math.round(n);
}

function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function niceDate(s, opts = { weekday: "short", day: "numeric", month: "short" }) {
  if (!s) return "";
  return new Date(s.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
}
function hm(s) { return s ? s.slice(11, 16) : ""; }
function dur(m) { if (!m) return ""; return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0"); }
function loading(el, text) { el.innerHTML = `<div class="loading">${esc(text)}</div>`; }

function tripParams() {
  return {
    origin: state.route.origin, dest: state.route.dest,
    out_date: state.outDate, ret_date: state.nights ? state.retDate : null,
    adults: state.adults, bags: state.bags,
    route_label: `${state.route.origin.city} > ${state.route.dest.city}`,
  };
}

/* ---------- tabs ---------- */

function showTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + name));
  $$(".top nav a").forEach((a) => a.classList.toggle("on", a.dataset.tab === name));
  if (name === "saved") loadSaved();
  if (name === "settings") loadSettings();
  if (name === "search" && map) setTimeout(() => map.invalidateSize(), 50);
}
$$("[data-tab]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); showTab(a.dataset.tab); }));

/* ---------- status ---------- */

async function loadStatus() {
  const s = await api("/api/status");
  state.status = s;
  const mode = $("#mode");
  if (s.mode === "free") {
    mode.innerHTML = `Live flight prices from Google Flights (free) · hotel prices are examples · add a SerpApi key in Settings to compare sites`;
  } else {
    mode.innerHTML = `Live · <span class="num">${s.calls_this_month}</span> of ~${s.free_limit} SerpApi searches used this month · flight lists are free`;
  }
  const pick = $("#currency-pick");
  if (![...pick.options].some((o) => o.value === s.currency)) pick.insertAdjacentHTML("beforeend", `<option>${esc(s.currency)}</option>`);
  pick.value = s.currency;
  $("#city-list").innerHTML = s.cities.map((c) => `<option value="${esc(c)}">`).join("");
  if (s.budget && !$("#budget").value) $("#budget").value = s.budget;
  const seen = new Set();
  const rec = s.recent.filter((r) => {
    if (!r.params.q) return false;
    const k = r.params.q.toUpperCase().replace(/\s+/g, " ") + "|" + r.params.nights;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, 6);
  $("#recent").innerHTML = rec.length ? `<span class="sub">Recent:</span>` + rec.map((r) =>
    `<button type="button" data-q="${esc(r.params.q)}" data-n="${r.params.nights}">${esc(r.params.q)}${r.params.nights ? " · " + r.params.nights + "n" : " · one way"}</button>`).join("") : "";
  $$("#recent button").forEach((b) => b.addEventListener("click", () => {
    const [a, z] = splitRoute(b.dataset.q);
    $("#from").value = a; $("#to").value = z; $("#nights").value = b.dataset.n; $("#search-form").requestSubmit();
  }));
  refreshSavedCount();
}

async function refreshSavedCount() {
  const t = await api("/api/tracked");
  $("#saved-count").textContent = t.tracked.length ? `(${t.tracked.length})` : "";
}

/* ---------- search ---------- */

$("#start").value = addDays(iso(new Date()), 7);

function routeQuery() { return `${$("#from").value.trim()} > ${$("#to").value.trim()}`; }
function splitRoute(q) {
  const parts = String(q || "").split(/\s*(?:>|→|\bto\b)\s*/i);
  return [parts[0] || "", parts[1] || ""];
}

$("#currency-pick").addEventListener("change", async (e) => {
  await api("/api/settings", { currency: e.target.value });
  await loadStatus();
  if (state.route && $("#from").value && $("#to").value) $("#search-form").requestSubmit();
});

$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#search-msg").textContent = "";
  state.nights = +$("#nights").value;
  state.adults = +$("#adults").value || 1;
  state.bags = +$("#bags").value || 0;
  const budget = +$("#budget").value || 0;
  api("/api/settings", { budget }).catch(() => {});
  if (state.status) state.status.budget = budget;

  let cal;
  try {
    $("#results").classList.remove("hidden");
    $("#flights-block").hidden = true;
    $("#sites-block").hidden = true;
    $("#hotels-block").hidden = true;
    loading($("#calendar"), "Finding the cheapest dates");
    $("#cheapest").innerHTML = "";
    cal = await api("/api/calendar", {
      q: routeQuery(), nights: state.nights, start: $("#start").value, days: 60,
      adults: state.adults, bags: state.bags,
    });
  } catch (err) {
    $("#search-msg").textContent = err.message;
    $("#calendar").innerHTML = "";
    return;
  }
  state.route = { origin: cal.origin, dest: cal.dest };
  state.flightTotal = null; state.hotel = null;
  $("#from").value = cal.origin.city.toUpperCase();
  $("#to").value = cal.dest.city.toUpperCase();
  drawRoute();
  renderCalendar(cal);
  renderBudget();
  loadStatus();
  if (cal.cheapest.length) pickDate(cal.cheapest[0].out_date, cal.cheapest[0].ret_date);
  else $("#search-msg").textContent = "No prices came back for these dates. Try another month or a nearby airport.";
});

function renderCalendar(cal) {
  const prices = {};
  cal.prices.forEach((p) => { prices[p.out_date] = p; });
  const vals = cal.prices.map((p) => p.price).sort((a, b) => a - b);
  const q1 = vals[Math.floor(vals.length * 0.25)] ?? 0;
  const q3 = vals[Math.floor(vals.length * 0.75)] ?? 0;
  const best = new Set(cal.cheapest.map((c) => c.out_date));
  const priciest = [...cal.prices].sort((a, b) => b.price - a.price).slice(0, 3);
  const top = new Set(priciest.map((c) => c.out_date));
  const start = $("#start").value;
  const end = addDays(start, 60);

  const months = [];
  let d = new Date(start.slice(0, 7) + "-01T00:00:00Z");
  while (iso(d) <= end) { months.push(new Date(d)); d.setUTCMonth(d.getUTCMonth() + 1); }

  const tip = (p) => `${niceDate(p.out_date)}: ${money(p.price)}${p.airline ? " · " + p.airline : ""}${p.stops != null ? " · " + (p.stops ? p.stops + " stop" + (p.stops > 1 ? "s" : "") : "nonstop") : ""}`;
  const grid = months.map((m) => {
    const y = m.getUTCFullYear(), mo = m.getUTCMonth();
    const first = (new Date(Date.UTC(y, mo, 1)).getUTCDay() + 6) % 7; // Monday first
    const days = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    let cells = ["M", "T", "W", "T", "F", "S", "S"].map((x) => `<div class="dow">${x}</div>`).join("");
    for (let i = 0; i < first; i++) cells += `<div class="day empty"></div>`;
    for (let day = 1; day <= days; day++) {
      const ds = iso(new Date(Date.UTC(y, mo, day)));
      const p = prices[ds];
      if (!p) { cells += `<div class="day ${ds < start || ds > end ? "empty" : "none"}"><span class="d">${ds < start || ds > end ? "" : day}</span></div>`; continue; }
      const q = p.price <= q1 ? "q0" : p.price >= q3 ? "q2" : "q1";
      cells += `<button class="day ${q} ${best.has(ds) ? "best" : ""} ${top.has(ds) ? "top" : ""}" data-out="${ds}" data-ret="${esc(p.ret_date || "")}" title="${esc(tip(p))}">
        <span class="d">${day}</span><span class="p">${short(p.price)}</span></button>`;
    }
    return `<div class="month"><h3>${m.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}</h3><div class="grid">${cells}</div></div>`;
  }).join("");
  const legend = `<div class="cal-legend"><span><i class="lg0"></i>cheap</span><span><i class="lg1"></i>average</span>
    <span><i class="lg2"></i>expensive</span><span><i class="lg1 lgb"></i>cheapest days</span><span><i class="lg1 lgt"></i>priciest days</span></div>`;
  $("#calendar").innerHTML = legend + grid;

  $$("#calendar .day[data-out]").forEach((b) => b.addEventListener("click", () => pickDate(b.dataset.out, b.dataset.ret)));
  $("#cal-note").textContent = (cal.nights ? `${cal.nights}-night round trip` : "One way") +
    ` · price per ${state.adults > 1 ? state.adults + " people" : "person"}, before bags · hover a day for the airline`;
  const btn = (c) => `<button data-out="${c.out_date}" data-ret="${esc(c.ret_date || "")}">${niceDate(c.out_date)}${c.ret_date ? " – " + niceDate(c.ret_date, { day: "numeric", month: "short" }) : ""} · ${money(c.price)}${c.airline ? ` <small>${esc(c.airline)}</small>` : ""}</button>`;
  $("#cheapest").innerHTML = (cal.cheapest.length ? `<div class="cheapest"><span class="sub">Cheapest:</span>${cal.cheapest.map(btn).join("")}</div>` : "") +
    (priciest.length > 3 || cal.prices.length > 5 ? `<div class="cheapest priciest"><span class="sub">Most expensive:</span>${priciest.map(btn).join("")}</div>` : "");
  $$("#cheapest button").forEach((b) => b.addEventListener("click", () => pickDate(b.dataset.out, b.dataset.ret)));
}

async function pickDate(out, ret) {
  state.outDate = out;
  state.retDate = state.nights ? (ret || addDays(out, state.nights)) : null;
  state.outbound = null;
  $$("#calendar .day").forEach((d) => d.classList.toggle("sel", d.dataset.out === out));
  $("#flights-block").hidden = false;
  $("#sites-block").hidden = true;
  $("#flights-title").textContent = state.nights
    ? `${niceDate(out)} – ${niceDate(state.retDate)}` : niceDate(out);
  $("#flights-note").textContent = state.nights ? "Pick your outbound flight" : "Pick a flight to compare sites";
  $("#insight").innerHTML = "";
  loading($("#flights"), "Loading flights");
  loadHotels();
  try {
    const res = await api("/api/search", tripParams());
    renderFlights(res.flights, "out");
    renderInsight(res.price_insights);
    const cheapest = Math.min(...res.flights.map((f) => f.price).filter(Boolean));
    if (isFinite(cheapest)) { state.flightTotal = cheapest; state.flightTotalKind = "from"; }
    renderBudget();
    loadStatus();
  } catch (err) {
    $("#flights").innerHTML = `<p class="msg">${esc(err.message)}</p>`;
  }
}

function flightRow(f, i) {
  const legs = f.flights || [];
  if (!legs.length) return "";
  const a = legs[0], z = legs[legs.length - 1];
  const nextDay = z.arrival_airport.time.slice(0, 10) > a.departure_airport.time.slice(0, 10);
  const stops = legs.length - 1;
  const airlines = [...new Set(legs.map((l) => l.airline))].join(" + ");
  return `<div class="row" data-i="${i}">
    <div class="times">${hm(a.departure_airport.time)}–${hm(z.arrival_airport.time)}${nextDay ? "<small>+1</small>" : ""}</div>
    <div class="airline">${f.airline_logo ? `<img src="${esc(f.airline_logo)}" alt="">` : ""}
      <div>${esc(airlines)}<div class="fn">${legs.map((l) => esc(l.flight_number)).join(" · ")} · ${esc(a.departure_airport.id)}→${esc(z.arrival_airport.id)}</div></div></div>
    <div class="dur">${dur(f.total_duration)}<br>${stops ? stops + " stop" + (stops > 1 ? "s" : "") : "Nonstop"}</div>
    <div class="price">${money(f.price)}<small>${state.nights ? "round trip" : "one way"}, from</small></div>
  </div>`;
}

const filters = { out: { airline: null, nonstop: false }, ret: { airline: null, nonstop: false } };

function airlineOf(f) { return [...new Set((f.flights || []).map((l) => l.airline))].join(" + "); }

function renderFlights(list, leg, keepFilter) {
  const el = $("#flights");
  if (!keepFilter) filters[leg] = { airline: null, nonstop: false };
  const flt = filters[leg];
  if (!list.length) { el.innerHTML = `<p class="sub">No flights listed for this date.</p>`; return; }
  const lows = {};
  list.forEach((f) => { const a = airlineOf(f); if (f.price && (!lows[a] || f.price < lows[a])) lows[a] = f.price; });
  const airlines = Object.keys(lows).sort((a, b) => lows[a] - lows[b]);
  const shown = list.map((f, i) => [f, i]).filter(([f]) =>
    (!flt.airline || airlineOf(f) === flt.airline) && (!flt.nonstop || (f.flights || []).length === 1));
  const bar = `<div class="filters"><button data-a="" class="${flt.airline ? "" : "on"}">All airlines</button>` +
    airlines.map((a) => `<button data-a="${esc(a)}" class="${flt.airline === a ? "on" : ""}">${esc(a)} · ${short(lows[a])}</button>`).join("") +
    `<label><input type="checkbox" class="nonstop" ${flt.nonstop ? "checked" : ""}> Nonstop only</label></div>`;
  const html = `<div class="leg-label">${leg === "ret" ? "Return" : state.nights ? "Outbound" : "Flights"}</div>` + bar +
    (shown.length ? shown.map(([f, i]) => flightRow(f, i)).join("") : `<p class="sub">No flights match these filters.</p>`);
  if (leg === "out") el.innerHTML = html;
  else {
    $$(".ret-wrap", el).forEach((x) => x.remove());
    el.insertAdjacentHTML("beforeend", `<div class="ret-wrap">${html}</div>`);
  }
  const scope = leg === "out" ? el : $(".ret-wrap", el);
  $$(".filters button", scope).forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation(); flt.airline = b.dataset.a || null; renderFlights(list, leg, true);
  }));
  $(".filters .nonstop", scope).addEventListener("change", (e) => { flt.nonstop = e.target.checked; renderFlights(list, leg, true); });
  $$(".row", scope).forEach((r) => r.addEventListener("click", () => {
    $$(".row", scope).forEach((x) => x.classList.remove("picked"));
    if (leg === "out") $$(".ret-wrap", el).forEach((x) => x.remove());
    r.classList.add("picked");
    const f = list[+r.dataset.i];
    if (leg === "out" && state.nights) chooseOutbound(f);
    else openFlight(leg === "out" ? f : state.outbound, leg === "out" ? null : f);
  }));
  if (leg === "ret" && !keepFilter) scope.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function chooseOutbound(f) {
  state.outbound = f;
  $("#flights-note").textContent = "Now pick your return flight";
  $("#flights").insertAdjacentHTML("beforeend", `<div class="ret-wrap"><div class="loading">Loading return flights</div></div>`);
  try {
    const res = await api("/api/returns", { ...tripParams(), departure_token: f.departure_token });
    renderFlights(res.flights, "ret");
    loadStatus();
  } catch (err) {
    $$(".ret-wrap").forEach((x) => x.remove());
    $("#flights").insertAdjacentHTML("beforeend", `<p class="msg ret-wrap">${esc(err.message)}</p>`);
  }
}

async function openFlight(outbound, inbound) {
  const token = (inbound || outbound).booking_token;
  $("#sites-block").hidden = false;
  loading($("#sites"), "Checking every site that sells this flight");
  $("#sites-block").scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const res = await api("/api/open", { ...tripParams(), outbound, inbound, booking_token: token });
    renderSites(res);
    if (res.sites.length) { state.flightTotal = res.sites[0].total; state.flightTotalKind = "all-in"; }
    renderBudget();
    loadStatus();
  } catch (err) {
    $("#sites").innerHTML = `<p class="msg">${esc(err.message)}</p>`;
  }
}

function renderSites(res) {
  const rows = res.sites;
  const people = state.adults > 1 ? `${state.adults} people` : "1 person";
  $("#sites-note").textContent = `${people}, ${state.bags} checked bag${state.bags === 1 ? "" : "s"} each, ${state.nights ? "both ways" : "one way"}`;
  if (!rows.length) {
    $("#sites").innerHTML = `<p class="sub">No sites returned a price for this flight. Try another one.</p>`;
    return;
  }
  const gap = rows.length > 1 ? rows[rows.length - 1].total - rows[0].total : 0;
  $("#sites").innerHTML = `<table>
    <thead><tr><th>Site</th><th class="r">Fare</th><th class="r">Bags</th><th class="r">Full price</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr class="${i === 0 ? "top-pick" : ""}">
      <td>${esc(r.site)}${r.is_airline ? `<span class="tag">airline</span>` : ""}
        <div class="note">${esc(r.notes)}</div></td>
      <td class="r num">${money(r.fare)}</td>
      <td class="r num">${r.bag_source === "none" ? "–" : money(r.bag_fee)}${r.bag_source === "table" && r.bag_fee ? `<span class="tag est">est.</span>` : ""}</td>
      <td class="r total">${money(r.total)}</td></tr>`).join("")}</tbody></table>
    <p class="note">Fare includes taxes and booking fees as the site reports them. Card or payment fees aren't included.
      ${gap > 0 ? `The same flight costs ${money(gap)} more on the priciest site.` : ""}</p>
    <div class="saved-note">Saved to <a href="#" data-goto="saved">Saved flights</a>. Its price is updated whenever you search this date again or press Check now.</div>`;
  $("[data-goto=saved]").addEventListener("click", (e) => { e.preventDefault(); showTab("saved"); });
  refreshSavedCount();
}

function renderInsight(pi) {
  if (!pi) return;
  const bits = [];
  if (pi.price_level) bits.push(`Prices for this date are <b>${esc(pi.price_level)}</b>`);
  if (pi.typical_price_range) bits.push(`usually ${money(pi.typical_price_range[0])}–${money(pi.typical_price_range[1])}`);
  let chart = "";
  if (pi.price_history && pi.price_history.length > 2) {
    chart = lineChart([{ color: "#16150f", points: pi.price_history.map(([t, v]) => [t * 1000, v]) }],
      { w: 640, h: 90, band: pi.typical_price_range });
    bits.push("last 60 days below");
  }
  $("#insight").innerHTML = bits.join(", ") + "." + chart;
}

/* ---------- hotels + budget ---------- */

async function loadHotels() {
  const nights = state.nights || 3;
  $("#hotels-block").hidden = false;
  loading($("#hotels"), "Loading hotels");
  try {
    const h = await api("/api/hotels", {
      city: state.route.dest.city, check_in: state.outDate, nights, adults: state.adults,
    });
    state.hotel = h;
    $("#hotels").innerHTML = (state.nights ? "" : `<p class="note">One-way trip, so this assumes 3 nights.</p>`) +
      (h.hotels.length ? h.hotels.map((x) => `<div class="hotel"><div>${x.link ? `<a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.name)}</a>` : esc(x.name)}
        <div class="stars">${x.stars ? x.stars + "★" : ""}${x.rating ? " · rated " + x.rating : ""}</div></div>
        <div class="n">${money(x.nightly)}<span class="sub"> /night</span></div></div>`).join("") : `<p class="sub">No hotels found.</p>`);
    drawHotels(h.hotels);
    renderBudget();
    loadStatus();
  } catch (err) {
    $("#hotels").innerHTML = `<p class="msg">${esc(err.message)}</p>`;
  }
}

function renderBudget() {
  const el = $("#budget-card");
  const budget = (state.status && state.status.budget) || 0;
  const f = state.flightTotal;
  const h = state.hotel && state.hotel.estimate;
  if (f == null && h == null) { el.innerHTML = `<p class="sub">Pick a date to see the trip cost.</p>`; return; }
  const total = (f || 0) + (h || 0);
  const hn = state.hotel ? `${state.hotel.nights} night${state.hotel.nights > 1 ? "s" : ""}${state.hotel.rooms > 1 ? " × " + state.hotel.rooms + " rooms" : ""} at ~${money(state.hotel.typical_nightly)}` : "";
  let html = `
    <div class="bud-line"><span>Flights${state.flightTotalKind === "from" ? " (from, before bags)" : " (full price)"}</span><span>${money(f)}</span></div>
    <div class="bud-line"><span>Hotel <span class="sub">${esc(hn)}</span></span><span>${h ? money(h) : "–"}</span></div>
    <div class="bud-line total"><span>Trip</span><span>${money(total)}</span></div>`;
  if (budget) {
    const pct = Math.min(100, (total / budget) * 100);
    const over = total > budget;
    html += `<div class="bud-bar"><i class="${over ? "over" : ""}" style="width:${pct}%"></i></div>
      <div class="bud-verdict ${over ? "over" : "ok"}">${over ? money(total - budget) + " over" : money(budget - total) + " left"} of ${money(budget)}</div>`;
  } else {
    html += `<p class="note">Add a budget in the search bar to see what's left.</p>`;
  }
  if (state.flightTotalKind === "from") html += `<p class="note">Open a flight to swap in its full price with bags.</p>`;
  el.innerHTML = html;
}

/* ---------- map ---------- */

let map = null, routeLayer = null, hotelLayer = null;

function ensureMap() {
  if (map || !window.L) return map;
  map = L.map("map", { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([30, 135], 3);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 18,
  }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  hotelLayer = L.layerGroup().addTo(map);
  return map;
}

function arc(a, b) {
  // A gentle curve between two points (fine for a picture, not navigation).
  let [lat1, lon1] = a, [lat2, lon2] = b;
  if (Math.abs(lon2 - lon1) > 180) lon2 += lon2 < lon1 ? 360 : -360;
  const mx = (lat1 + lat2) / 2, my = (lon1 + lon2) / 2;
  const dx = lat2 - lat1, dy = lon2 - lon1;
  const cx = mx + dy * 0.18, cy = my - dx * 0.18;
  const pts = [];
  for (let t = 0; t <= 1.0001; t += 0.04) {
    pts.push([(1 - t) ** 2 * lat1 + 2 * (1 - t) * t * cx + t * t * lat2,
              (1 - t) ** 2 * lon1 + 2 * (1 - t) * t * cy + t * t * lon2]);
  }
  return pts;
}

function drawRoute() {
  if (!ensureMap()) return;
  map.invalidateSize();
  routeLayer.clearLayers(); hotelLayer.clearLayers();
  const { origin: o, dest: d } = state.route;
  if (o.lat == null || d.lat == null) return;
  const pts = arc([o.lat, o.lon], [d.lat, d.lon]);
  L.polyline(pts, { color: "#c8401a", weight: 2, dashArray: "6 6" }).addTo(routeLayer);
  for (const c of [o, d]) {
    const ll = c === d ? pts[pts.length - 1] : [c.lat, c.lon];
    L.circleMarker(ll, { radius: 5, color: "#16150f", fillColor: "#16150f", fillOpacity: 1, weight: 1 })
      .bindTooltip(c.city.toUpperCase(), { permanent: true, direction: "top", className: "city-label", offset: [0, -6] })
      .addTo(routeLayer);
  }
  map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
}

function drawHotels(hotels) {
  if (!ensureMap()) return;
  hotelLayer.clearLayers();
  hotels.filter((h) => h.lat != null).forEach((h) => {
    L.circleMarker([h.lat, h.lon], { radius: 4, color: "#2f6b3a", fillColor: "#2f6b3a", fillOpacity: 0.8, weight: 1 })
      .bindTooltip(`${h.name} · ${money(h.nightly)}/night`).addTo(hotelLayer);
  });
}

/* ---------- charts ---------- */

const PALETTE = ["#16150f", "#c8401a", "#2f6b3a", "#3d5a99", "#8a5a14", "#7a3e7a", "#5d5a50", "#1f7a7a"];

function lineChart(series, { w = 640, h = 180, band = null } = {}) {
  const all = series.flatMap((s) => s.points).filter((p) => p[1] != null);
  if (!all.length) return "";
  const pad = { l: 58, r: 10, t: 8, b: 20 };
  const xs = all.map((p) => +p[0]), ys = all.map((p) => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x0 === x1) { x0 -= 864e5; x1 += 864e5; }
  let y0 = Math.min(...ys, ...(band || [])), y1 = Math.max(...ys, ...(band || []));
  if (y0 === y1) { y0 *= 0.9; y1 *= 1.1; }
  const yr = y1 - y0; y0 -= yr * 0.08; y1 += yr * 0.08;
  const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * (w - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * (h - pad.t - pad.b);
  let svg = `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px" role="img">`;
  if (band) svg += `<rect x="${pad.l}" y="${Y(band[1])}" width="${w - pad.l - pad.r}" height="${Y(band[0]) - Y(band[1])}" fill="#e6efe1"/>`;
  for (const v of [y0 + (y1 - y0) * 0.15, (y0 + y1) / 2, y1 - (y1 - y0) * 0.15]) {
    svg += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#d9d4c6" stroke-width="1"/>
      <text x="${pad.l - 6}" y="${Y(v) + 4}" text-anchor="end" font-family="IBM Plex Mono" font-size="10" fill="#8f8b7e">${short(v)}</text>`;
  }
  const fmtD = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  svg += `<text x="${pad.l}" y="${h - 4}" font-family="IBM Plex Mono" font-size="10" fill="#8f8b7e">${fmtD(x0)}</text>
    <text x="${w - pad.r}" y="${h - 4}" text-anchor="end" font-family="IBM Plex Mono" font-size="10" fill="#8f8b7e">${fmtD(x1)}</text>`;
  series.forEach((s, i) => {
    const pts = s.points.filter((p) => p[1] != null);
    const color = s.color || PALETTE[i % PALETTE.length];
    if (pts.length > 1) svg += `<polyline fill="none" stroke="${color}" stroke-width="${s.width || 1.6}" points="${pts.map((p) => X(+p[0]) + "," + Y(p[1])).join(" ")}"/>`;
    const last = pts[pts.length - 1];
    if (last) svg += `<circle cx="${X(+last[0])}" cy="${Y(last[1])}" r="2.6" fill="${color}"/>`;
  });
  return svg + "</svg>";
}

function sparkline(points, w = 150, h = 34) {
  const pts = points.filter((p) => p[1] != null);
  if (pts.length < 2) return `<span class="sub">${pts.length ? "1 check so far" : ""}</span>`;
  const ys = pts.map((p) => p[1]); const y0 = Math.min(...ys), y1 = Math.max(...ys) || 1;
  const X = (i) => 2 + (i / (pts.length - 1)) * (w - 4);
  const Y = (y) => (y1 === y0 ? h / 2 : 3 + (1 - (y - y0) / (y1 - y0)) * (h - 6));
  return `<svg width="${w}" height="${h}"><polyline fill="none" stroke="#16150f" stroke-width="1.4" points="${pts.map((p, i) => X(i) + "," + Y(p[1])).join(" ")}"/></svg>`;
}

/* ---------- saved flights ---------- */

let openSavedId = null;

function legText(s) {
  if (!s) return "";
  return `${esc(s.from)}→${esc(s.to)} ${niceDate(s.depart)} ${hm(s.depart)} · ${esc(s.airline)} ${esc((s.flight_numbers || []).join(" · "))}`;
}

async function loadSaved() {
  const el = $("#saved-list");
  loading(el, "Loading");
  const { tracked } = await api("/api/tracked");
  if (!tracked.length) {
    el.innerHTML = `<div class="empty-state">Nothing saved yet. Search a route and open a flight, and it lands here.</div>`;
    $("#saved-detail").innerHTML = "";
    return;
  }
  el.innerHTML = tracked.map((t) => {
    const p = t.params;
    const ch = t.change;
    return `<div class="saved-row ${t.id === openSavedId ? "on" : ""}" data-id="${t.id}">
      <div><div class="route">${esc((t.summary.route_label || p.origin + " > " + p.dest).toUpperCase())}</div>
        <div class="when">${niceDate(p.out_date)}${p.ret_date ? " – " + niceDate(p.ret_date) : " · one way"} · ${p.adults} pax, ${p.bags} bag${p.bags === 1 ? "" : "s"}</div>
        ${t.last_error ? `<div class="err">${esc(t.last_error)}</div>` : ""}${t.departed ? `<div class="sub">Departed, no longer checked</div>` : ""}</div>
      <div class="when">${legText(t.summary.out)}${t.summary.ret ? "<br>" + legText(t.summary.ret) : ""}</div>
      <div>${sparkline(t.history.map((h) => [h.checked_at, h.cheapest_total]))}</div>
      <div><div class="total">${money(t.latest_total)}</div><div class="sub">${esc(t.latest_site || "")}</div></div>
      <div class="chg ${ch < 0 ? "down" : ch > 0 ? "up" : ""} num">${ch ? (ch < 0 ? "▼ " : "▲ ") + money(Math.abs(ch)) : "no change"}</div>
    </div>`;
  }).join("");
  $$(".saved-row", el).forEach((r) => r.addEventListener("click", () => showSaved(+r.dataset.id)));
  if (openSavedId) showSaved(openSavedId);
}

async function showSaved(id) {
  openSavedId = id;
  $$(".saved-row").forEach((r) => r.classList.toggle("on", +r.dataset.id === id));
  const el = $("#saved-detail");
  loading(el, "Loading");
  let d;
  try { d = await api("/api/tracked/detail", { id }); } catch (err) { el.innerHTML = `<p class="msg">${esc(err.message)}</p>`; return; }
  const names = Object.keys(d.site_history);
  const series = names.map((n, i) => ({ name: n, color: PALETTE[i % PALETTE.length],
    points: d.site_history[n].map(([t, v]) => [Date.parse(t), v]) }));
  el.innerHTML = `<div class="block detail">
    <div class="block-head"><h2>Full price by site over time</h2>
      <span class="sub">${d.history.length} check${d.history.length === 1 ? "" : "s"} · low ${money(d.low)} · high ${money(d.high)}</span></div>
    ${d.history.length > 1 ? lineChart(series, { w: 900, h: 220 }) : `<p class="sub">One check so far. The chart fills in each time you search this date again or press Check now.</p>`}
    <div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>
    <div class="actions">
      <button class="btn" id="d-refresh">${state.status && state.status.mode === "hybrid" ? "Compare all sites now" : "Check now"}</button>
      <span class="sub">Last checked ${d.last_checked ? new Date(d.last_checked).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "never"}</span>
      <button class="btn danger" id="d-remove" style="margin-left:auto">Stop tracking</button>
    </div>
    <p id="d-msg" class="msg"></p>
    <table><thead><tr><th>Site</th><th class="r">Fare</th><th class="r">Bags</th><th class="r">Full price</th></tr></thead>
      <tbody>${d.latest_sites.map((r, i) => `<tr class="${i === 0 ? "top-pick" : ""}"><td>${esc(r.site)}${r.is_airline ? `<span class="tag">airline</span>` : ""}<div class="note">${esc(r.notes)}</div></td>
        <td class="r num">${money(r.fare)}</td><td class="r num">${r.bag_source === "none" ? "–" : money(r.bag_fee)}${r.bag_source === "table" && r.bag_fee ? `<span class="tag est">est.</span>` : ""}</td>
        <td class="r total">${money(r.total)}</td></tr>`).join("")}</tbody></table>
  </div>`;
  $("#d-refresh").addEventListener("click", async () => {
    $("#d-msg").className = "msg"; $("#d-msg").textContent = "Checking…";
    try { await api("/api/tracked/refresh", { id }); loadSaved(); loadStatus(); }
    catch (err) { $("#d-msg").textContent = err.message; }
  });
  $("#d-remove").addEventListener("click", async () => {
    await api("/api/tracked/remove", { id }); openSavedId = null; $("#saved-detail").innerHTML = ""; loadSaved(); refreshSavedCount();
  });
}

/* ---------- settings ---------- */

async function loadSettings() {
  $("#currency").value = cur();
  $("#api-key").placeholder = state.status && state.status.has_key ? "Key saved. Paste a new one to replace it" : "Paste key";
  $("#bag-table").value = JSON.stringify(await api("/api/bag-table"), null, 2);
}

$("#save-settings").addEventListener("click", async () => {
  const body = { currency: $("#currency").value };
  if ($("#api-key").value.trim()) body.api_key = $("#api-key").value.trim();
  try {
    await api("/api/settings", body);
    $("#api-key").value = "";
    $("#settings-msg").className = "msg ok"; $("#settings-msg").textContent = "Saved.";
    await loadStatus(); loadSettings();
  } catch (err) { $("#settings-msg").className = "msg"; $("#settings-msg").textContent = err.message; }
});

$("#save-bags").addEventListener("click", async () => {
  try {
    await api("/api/settings", { bag_table: JSON.parse($("#bag-table").value) });
    $("#bags-msg").className = "msg ok"; $("#bags-msg").textContent = "Saved. New searches use these fees.";
  } catch (err) {
    $("#bags-msg").className = "msg";
    $("#bags-msg").textContent = err instanceof SyntaxError ? "That isn't valid JSON. Check for a missing comma or quote." : err.message;
  }
});

/* ---------- go ---------- */

loadStatus().catch((e) => { $("#mode").textContent = "Can't reach the app: " + e.message; });
ensureMap();
