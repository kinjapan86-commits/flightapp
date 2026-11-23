// Turn each site's fare into an all-in total. Bags: use the site's own bag price
// when it gives one, otherwise the editable bag-fee table (marked as an estimate).
import { BAG_DEFAULT } from "./data.js";

export async function loadBagTable(store) {
  const s = await store.one("SELECT value FROM settings WHERE key='bag_table'");
  if (s && s.value) { try { return JSON.parse(s.value); } catch { /* fall through */ } }
  return BAG_DEFAULT;
}

export async function saveBagTable(store, table) {
  await store.setSetting("bag_table", JSON.stringify(table));
}

function parseBagText(lines) {
  for (const line of lines || []) {
    const l = line.toLowerCase();
    if (!l.includes("checked")) continue;
    if (l.includes("free") || l.includes("included")) return 0;
    const m = line.split(":").pop().match(/(\d[\d,]*(?:\.\d+)?)/);
    if (m) return parseFloat(m[1].replace(/,/g, ""));
  }
  return null;
}

function tableFee(airline, table) {
  if (!airline) return Number(table.unknown_airline || 0);
  const a = airline.toLowerCase();
  for (const name of table.full_service_included || []) if (a.includes(name.toLowerCase())) return 0;
  for (const [name, fee] of Object.entries(table.airlines || {})) if (a.includes(name.toLowerCase())) return Number(fee);
  return Number(table.unknown_airline || 0);
}

function one(site, fare, bagLines, airline, bags, adults, legs, table, isAirline, extras) {
  let perBag = parseBagText(bagLines), source = "site";
  if (perBag === null) { perBag = tableFee(airline, table); source = "table"; }
  const bagFee = bags ? perBag * bags * adults * legs : 0;
  if (!bags) source = "none";
  const notes = [];
  if (bags) {
    if (source === "site") notes.push(perBag ? `bag price from ${site}` : "checked bag included");
    else notes.push(perBag ? "bag fee estimated" : "bag usually included");
  }
  notes.push(...extras);
  return {
    site, fare, bag_fee: bagFee, bag_source: source,
    total: fare != null ? (fare || 0) + bagFee : null,
    notes: notes.join("; "), is_airline: isAirline ? 1 : 0, bag_lines: bagLines || [],
  };
}

export function allInPrices(options, airline, bags, adults, roundTrip, table) {
  const legs = roundTrip ? 2 : 1;
  let rows = [];
  for (const opt of options || []) {
    if (opt.together) {
      const t = opt.together;
      const extras = (t.extensions || []).filter((e) => typeof e === "string").slice(0, 2);
      rows.push(one(t.book_with || "?", t.price, t.baggage_prices, airline, bags, adults, legs, table, t.airline, extras));
    } else if (opt.separate_tickets || opt.departing) {
      const dep = opt.departing || {}, ret = opt.returning || {};
      if (dep.price == null || ret.price == null) continue;
      const lines = (dep.baggage_prices && dep.baggage_prices.length ? dep.baggage_prices : ret.baggage_prices) || [];
      rows.push(one(`${dep.book_with || "?"} + ${ret.book_with || "?"}`, dep.price + ret.price, lines,
        airline, bags, adults, legs, table, false, ["two separate tickets"]));
    }
  }
  rows = rows.filter((r) => r.fare != null);
  rows.sort((a, b) => a.total - b.total);
  return rows;
}
