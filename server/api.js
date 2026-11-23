// The app's /api/* endpoints, for Cloudflare. Mirrors app.py in the Mac version.
import { Store, stableJson } from "./db.js";
import { parseRoute, cityNames } from "./cities.js";
import { getProvider, ProviderError, addDays } from "./providers.js";
import { loadBagTable, saveBagTable } from "./pricing.js";
import * as tracker from "./tracker.js";

const FREE_SEARCHES_PER_MONTH = 250;
const CHUNK_DAYS = 1; // free calendar: days fetched per request (keeps each request light)

class BadRequest extends Error {}

const today = () => new Date().toISOString().slice(0, 10);
function int(v, def, lo, hi) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
}
function date(v, field) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) {
    throw new BadRequest(`${field} should be a date like 2026-12-20`);
  }
  return v;
}

function flightParams(b) {
  const o = b.origin, d = b.dest;
  if (!o || !d) throw new BadRequest("Missing origin or destination");
  const p = {
    origin: typeof o === "object" ? o.codes : String(o),
    dest: typeof d === "object" ? d.codes : String(d),
    out_date: date(b.out_date, "Departure date"),
    ret_date: b.ret_date ? date(b.ret_date, "Return date") : null,
    adults: int(b.adults, 1, 1, 9), bags: int(b.bags, 1, 0, 3), route_label: b.route_label || null,
  };
  if (p.out_date < addDays(today(), -1)) throw new BadRequest("That departure date is in the past");
  if (p.ret_date && p.ret_date < p.out_date) throw new BadRequest("Return date is before the departure date");
  return p;
}

const H = {};

H["GET /api/status"] = async ({ store, settings, prov }) => ({
  mode: prov.name, has_key: !!settings.api_key, calls_this_month: await store.apiCallsThisMonth(),
  free_limit: FREE_SEARCHES_PER_MONTH, currency: settings.currency || "JPY", budget: Number(settings.budget || 0),
  home: settings.home_city || "Tokyo", cities: cityNames(), recent: await store.recentSearches(8),
});

H["POST /api/settings"] = async (ctx) => {
  const { store, body: b } = ctx;
  if ("api_key" in b) { await store.setSetting("api_key", (b.api_key || "").trim()); await store.clearCache(); }
  if ("currency" in b) {
    await store.setSetting("currency", String(b.currency || "JPY").trim().toUpperCase().slice(0, 3));
    await store.clearCache();
  }
  if ("budget" in b) await store.setSetting("budget", String(Number(b.budget || 0)));
  if ("home_city" in b) await store.setSetting("home_city", String(b.home_city));
  if ("bag_table" in b) {
    if (!b.bag_table || typeof b.bag_table !== "object" || !("airlines" in b.bag_table)) {
      throw new BadRequest("Bag table should keep its airlines section");
    }
    await saveBagTable(store, b.bag_table);
  }
  ctx.settings = await store.settings();
  ctx.prov = getProvider(ctx.settings, store);
  return H["GET /api/status"](ctx);
};

H["GET /api/bag-table"] = ({ store }) => loadBagTable(store);

H["POST /api/route"] = ({ body }) => {
  const [o, d, err] = parseRoute(body.q || "");
  if (err) throw new BadRequest(err);
  return { origin: o, dest: d };
};

H["POST /api/calendar"] = async ({ store, prov, body: b }) => {
  const [o, d, err] = parseRoute(b.q || "");
  if (err) throw new BadRequest(err);
  const nights = int(b.nights, 0, 0, 30);
  const p = { origin: o.codes, dest: d.codes, adults: int(b.adults, 1, 1, 9) };
  const tomorrow = addDays(today(), 1);
  const start = b.start && b.start > tomorrow ? date(b.start, "Start date") : tomorrow;
  const end = addDays(start, int(b.days, 60, 7, 120));

  if (prov.name === "free") {
    if (!b.chunk) {
      // Too many lookups for one request here: the page asks for the dates a few at a time.
      await store.saveSearch({ q: b.q, nights, adults: p.adults, bags: int(b.bags, 1, 0, 3) });
      return { origin: o, dest: d, nights, start, end, chunk_days: CHUNK_DAYS, chunks: true, prices: [], cheapest: [] };
    }
    const cs = date(b.chunk, "Chunk date");
    const ce = [addDays(cs, CHUNK_DAYS - 1), end].sort()[0];
    const key = "cal:free:" + stableJson([p, nights, cs, ce]);
    const [prices] = await store.cached(key, () => prov.calendar(p, cs, ce, nights));
    return { prices };
  }

  const key = "cal:" + prov.name + ":" + stableJson([p, nights, start, end]);
  const [all, fromCache] = await store.cached(key, () => prov.calendar(p, start, end, nights));
  await store.saveSearch({ q: b.q, nights, adults: p.adults, bags: int(b.bags, 1, 0, 3) });
  const prices = all.filter((x) => x.out_date);
  const cheapest = [...prices].sort((x, y) => x.price - y.price).slice(0, 5);
  return { origin: o, dest: d, nights, prices, cheapest, cached: fromCache };
};

H["POST /api/search"] = async ({ store, prov, body }) => {
  const p = flightParams(body);
  const key = "search:" + prov.name + ":" + stableJson(p);
  const [res, fromCache] = await store.cached(key, () => prov.search(p));
  res.cached = fromCache;
  if (!fromCache) await tracker.updateFromSearch(store, p, res.flights);
  return res;
};

H["POST /api/returns"] = async ({ store, prov, body }) => {
  const p = flightParams(body);
  if (!body.departure_token) throw new BadRequest("Missing departure_token");
  const [res] = await store.cached("ret:" + prov.name + ":" + body.departure_token, () => prov.returns(p, body.departure_token));
  return res;
};

H["POST /api/open"] = async ({ store, prov, body }) => {
  const p = flightParams(body);
  const { outbound, inbound, booking_token: token } = body;
  if (!outbound || !token) throw new BadRequest("Missing flight");
  let opts;
  try { opts = await prov.bookingOptions(p, token); } catch (e) {
    await store.clearCache("search:");
    throw new BadRequest(`${e.message}. The listing may have expired, so search again.`);
  }
  const headline = (inbound || outbound).price;
  const [tid, rows] = await tracker.record(store, p, outbound, inbound, opts, headline);
  return { tracked_id: tid, sites: rows, headline };
};

H["POST /api/hotels"] = async ({ store, prov, body: b }) => {
  if (!b.city) throw new BadRequest("Missing city");
  const checkIn = date(b.check_in, "Check-in");
  const nights = int(b.nights, 3, 1, 30);
  const checkOut = addDays(checkIn, nights);
  const adults = int(b.adults, 1, 1, 9);
  const o = { area: String(b.area || "").trim().slice(0, 60), min_stars: int(b.min_stars, 3, 3, 5),
    max_price: int(b.max_price, 0, 0, 1e9) || null, sort: b.sort === "rating" ? "rating" : "price" };
  const key = "hotel:" + prov.name + ":" + stableJson([b.city, checkIn, checkOut, adults, o]);
  const [hotels, fromCache] = await store.cached(key, () => prov.hotels(b.city, checkIn, checkOut, adults, o));
  const rooms = Math.max(1, Math.ceil(adults / 2));
  const nightly = hotels.map((h) => h.nightly).sort((x, y) => x - y);
  const mid = nightly.length ? (nightly.length % 2 ? nightly[(nightly.length - 1) / 2]
    : (nightly[nightly.length / 2 - 1] + nightly[nightly.length / 2]) / 2) : null;
  return { hotels: hotels.slice(0, 15), options: o, examples: prov.name === "free", nights, rooms,
    typical_nightly: mid, low_nightly: nightly[0] ?? null, estimate: mid ? mid * nights * rooms : null, cached: fromCache };
};

H["GET /api/tracked"] = async ({ store }) => ({ tracked: await tracker.listTracked(store) });

H["POST /api/tracked/detail"] = async ({ store, body }) => {
  const d = await tracker.detail(store, int(body.id, 0, 0, 1e9));
  if (!d) throw new BadRequest("No such saved flight");
  return d;
};

H["POST /api/tracked/refresh"] = async ({ store, settings, body }) => {
  const tid = int(body.id, 0, 0, 1e9);
  await tracker.refresh(store, settings, tid);
  return tracker.detail(store, tid);
};

H["POST /api/tracked/remove"] = async ({ store, body }) => {
  await tracker.remove(store, int(body.id, 0, 0, 1e9));
  return { ok: true };
};

H["POST /api/tracked/frequency"] = () => ({ ok: true });

export async function handle(request, env) {
  const url = new URL(request.url);
  const fn = H[`${request.method} ${url.pathname.replace(/\/$/, "")}`];
  if (!fn) return Response.json({ error: "Not found" }, { status: 404 });
  try {
    // Use the D1 database bound to this site, whatever name it was given.
    const d1 = env.DB || env.flightapp || Object.values(env).find((v) => v && typeof v.prepare === "function" && typeof v.batch === "function");
    const store = new Store(d1);
    await store.init();
    let body = {};
    if (request.method === "POST") {
      try { body = await request.json(); } catch { return Response.json({ error: "Bad JSON" }, { status: 400 }); }
    }
    const settings = await store.settings();
    const ctx = { store, settings, prov: getProvider(settings, store), body };
    return Response.json(await fn(ctx), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof BadRequest || e instanceof ProviderError) return Response.json({ error: e.message }, { status: 400 });
    console.error(e);
    return Response.json({ error: "Something broke: " + e.message }, { status: 500 });
  }
}
