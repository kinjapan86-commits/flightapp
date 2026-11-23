// Saved flights and their price history. Prices are only looked up when you
// search (or press "Check now"); nothing runs in the background.
import { nowIso, stableJson } from "./db.js";
import { allInPrices, loadBagTable } from "./pricing.js";
import { flightSig, getProvider, FreeProvider, ProviderError } from "./providers.js";

const airlineOf = (it) => ((it && it.flights) || [])[0]?.airline || null;

function summary(it) {
  const legs = (it && it.flights) || [];
  if (!legs.length) return {};
  return {
    airline: legs[0].airline, airline_logo: it.airline_logo || legs[0].airline_logo || null,
    flight_numbers: legs.map((l) => l.flight_number), from: legs[0].departure_airport.id,
    to: legs[legs.length - 1].arrival_airport.id, depart: legs[0].departure_airport.time,
    arrive: legs[legs.length - 1].arrival_airport.time, stops: legs.length - 1, duration: it.total_duration,
  };
}

const KEYS = ["origin", "dest", "out_date", "ret_date", "adults", "bags"];
const paramsKey = (p) => stableJson(Object.fromEntries(KEYS.map((k) => [k, p[k] ?? null])));

async function rowsFor(store, params, options, airline) {
  const table = await loadBagTable(store);
  return allInPrices(options, airline, Number(params.bags || 0), Number(params.adults || 1), !!params.ret_date, table);
}

async function snapshot(store, tid, headline, rows) {
  const c = rows[0] || null;
  const meta = await store.run("INSERT INTO snapshots(tracked_id, checked_at, headline_price, cheapest_total, cheapest_site) " +
    "VALUES(?,?,?,?,?)", [tid, nowIso(), headline ?? null, c ? c.total : null, c ? c.site : null]);
  const sid = meta.last_row_id;
  if (rows.length) {
    await store.d1.batch(rows.map((r) => store.d1.prepare(
      "INSERT INTO site_prices(snapshot_id, site, fare, bag_fee, bag_source, total, notes, is_airline) VALUES(?,?,?,?,?,?,?,?)")
      .bind(sid, r.site, r.fare, r.bag_fee, r.bag_source, r.total, r.notes, r.is_airline)));
  }
  await store.run("UPDATE tracked SET last_checked=?, last_error=NULL WHERE id=?", [nowIso(), tid]);
}

export async function record(store, params, outbound, inbound, options, headline) {
  const pkey = paramsKey(params), outSig = flightSig(outbound), retSig = inbound ? flightSig(inbound) : "";
  const row = await store.one("SELECT id FROM tracked WHERE params=? AND out_sig=? AND ret_sig=?", [pkey, outSig, retSig]);
  let tid;
  if (row) {
    tid = row.id;
    await store.run("UPDATE tracked SET active=1 WHERE id=?", [tid]);
  } else {
    const sum = { out: summary(outbound), ret: inbound ? summary(inbound) : null, route_label: params.route_label || null };
    tid = (await store.run("INSERT INTO tracked(created_at, params, out_sig, ret_sig, summary) VALUES(?,?,?,?,?)",
      [nowIso(), pkey, outSig, retSig, JSON.stringify(sum)])).last_row_id;
  }
  const rows = await rowsFor(store, params, options, airlineOf(outbound));
  await snapshot(store, tid, headline, rows);
  return [tid, rows];
}

export async function refresh(store, settings, tid) {
  const t = await store.one("SELECT * FROM tracked WHERE id=?", [tid]);
  if (!t) throw new ProviderError("No such saved flight");
  const params = JSON.parse(t.params);
  const prov = getProvider(settings, store);
  await store.clearCache("search:");
  try {
    const res = await prov.search(params);
    const match = res.flights.find((f) => flightSig(f) === t.out_sig);
    if (!match) throw new ProviderError("This flight isn't listed any more (sold out or schedule change).");
    let token = match.booking_token, headline = match.price;
    if (t.ret_sig && prov.name === "free") {
      token = match.departure_token; // Google's round-trip price for this outbound
    } else if (t.ret_sig) {
      const rets = (await prov.returns(params, match.departure_token)).flights;
      const inbound = rets.find((f) => flightSig(f) === t.ret_sig);
      if (!inbound) throw new ProviderError("The return flight isn't listed any more.");
      token = inbound.booking_token;
      headline = inbound.price ?? headline;
    }
    const opts = await prov.bookingOptions(params, token);
    await snapshot(store, tid, headline, await rowsFor(store, params, opts, airlineOf(match)));
  } catch (e) {
    await store.run("UPDATE tracked SET last_checked=?, last_error=? WHERE id=?", [nowIso(), e.message, tid]);
    throw e;
  }
}

// A search just ran: add today's price to any saved flight it covers. Costs nothing extra.
export async function updateFromSearch(store, params, flights) {
  const keys = ["origin", "dest", "out_date", "ret_date", "adults"];
  for (const t of await store.query("SELECT * FROM tracked WHERE active=1")) {
    const tp = JSON.parse(t.params);
    if (keys.some((k) => (tp[k] ?? null) !== (params[k] ?? null))) continue;
    const m = flights.find((f) => flightSig(f) === t.out_sig);
    if (!m || !m.price) continue;
    const opts = [{ together: { book_with: "Google Flights (lowest price)", price: m.price, baggage_prices: [],
      extensions: ["from your search"] } }];
    await snapshot(store, t.id, m.price, await rowsFor(store, tp, opts, airlineOf(m)));
  }
}

function shape(t, snaps) {
  const params = JSON.parse(t.params);
  const first = snaps.length ? snaps[0].cheapest_total : null;
  const last = snaps.length ? snaps[snaps.length - 1].cheapest_total : null;
  const totals = snaps.map((s) => s.cheapest_total).filter((v) => v != null);
  return {
    id: t.id, params, summary: JSON.parse(t.summary), check_every_days: t.check_every_days,
    last_checked: t.last_checked, last_error: t.last_error, latest_total: last,
    latest_site: snaps.length ? snaps[snaps.length - 1].cheapest_site : null,
    change: first != null && last != null ? last - first : null,
    low: totals.length ? Math.min(...totals) : null, high: totals.length ? Math.max(...totals) : null,
    history: snaps, departed: (params.out_date || "9999") < new Date().toISOString().slice(0, 10),
  };
}

export async function listTracked(store) {
  const out = [];
  for (const t of await store.query("SELECT * FROM tracked WHERE active=1 ORDER BY id DESC")) {
    const snaps = await store.query("SELECT checked_at, headline_price, cheapest_total, cheapest_site FROM snapshots " +
      "WHERE tracked_id=? ORDER BY id", [t.id]);
    out.push(shape(t, snaps));
  }
  return out;
}

export async function detail(store, tid) {
  const t = await store.one("SELECT * FROM tracked WHERE id=?", [tid]);
  if (!t) return null;
  const snaps = await store.query("SELECT * FROM snapshots WHERE tracked_id=? ORDER BY id", [tid]);
  const out = shape(t, snaps);
  const latest = snaps.length ? snaps[snaps.length - 1].id : null;
  out.latest_sites = latest ? await store.query("SELECT site, fare, bag_fee, bag_source, total, notes, is_airline " +
    "FROM site_prices WHERE snapshot_id=? ORDER BY total", [latest]) : [];
  const series = {};
  const all = await store.query("SELECT sp.snapshot_id, sp.site, sp.total FROM site_prices sp " +
    "JOIN snapshots s ON s.id = sp.snapshot_id WHERE s.tracked_id=? ORDER BY sp.snapshot_id", [tid]);
  const at = Object.fromEntries(snaps.map((s) => [s.id, s.checked_at]));
  for (const sp of all) (series[sp.site] = series[sp.site] || []).push([at[sp.snapshot_id], sp.total]);
  out.site_history = series;
  return out;
}

export async function remove(store, tid) {
  await store.run("UPDATE tracked SET active=0 WHERE id=?", [tid]);
}

export { FreeProvider };
