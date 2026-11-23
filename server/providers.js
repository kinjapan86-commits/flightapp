// Where prices come from.
//  FreeProvider:   real flight prices from Google Flights, no key, no limit.
//  HybridProvider: (once a SerpApi key is saved) free lookups for browsing, SerpApi
//                  only for the per-site comparison, return pricing, calendar and hotels.
import * as gf from "./googleflights.js";
import { stableJson } from "./db.js";
import { CITIES } from "./data.js";

export class ProviderError extends Error {}
export const flightSig = gf.flightSig;

const SERPAPI_URL = "https://serpapi.com/search.json";

class SerpApiProvider {
  constructor(settings, store) { this.s = settings; this.store = store; this.name = "serpapi"; }

  async get(params, kind) {
    const base = {
      engine: params.engine || "google_flights", api_key: this.s.api_key,
      currency: this.s.currency || "JPY", hl: this.s.language || "en", gl: this.s.country || "jp",
    };
    for (const [k, v] of Object.entries(params)) if (k !== "engine" && v !== null && v !== undefined && v !== "") base[k] = v;
    let res, data;
    try {
      res = await fetch(SERPAPI_URL + "?" + new URLSearchParams(base), { headers: { "User-Agent": "flight-app/1.0" } });
      data = await res.json();
    } catch (e) {
      throw new ProviderError("Could not reach SerpApi: " + e.message);
    }
    await this.store.logApiCall(kind);
    if (data.error) {
      if (String(data.error).includes("hasn't returned any results")) return {};
      throw new ProviderError("SerpApi: " + data.error);
    }
    return data;
  }

  common(p) {
    return {
      departure_id: p.origin.toUpperCase(), arrival_id: p.dest.toUpperCase(), outbound_date: p.out_date,
      return_date: p.ret_date || null, type: p.ret_date ? 1 : 2, adults: p.adults || 1, travel_class: 1,
    };
  }

  async search(p) {
    const d = await this.get(this.common(p), "search");
    return { flights: [...(d.best_flights || []), ...(d.other_flights || [])], price_insights: d.price_insights || null };
  }

  async returns(p, token) {
    const d = await this.get({ ...this.common(p), departure_token: token }, "returns");
    return { flights: [...(d.best_flights || []), ...(d.other_flights || [])] };
  }

  async bookingOptions(p, token) {
    const d = await this.get({ ...this.common(p), booking_token: token }, "booking");
    return d.booking_options || [];
  }

  async calendar(p, start, end, tripDays) {
    const d = await this.get({
      engine: "google_flights_calendar", departure_id: p.origin.toUpperCase(), arrival_id: p.dest.toUpperCase(),
      type: tripDays ? 1 : 2, round_trip_days: tripDays || null, date_range_start: start, date_range_end: end,
      adults: p.adults || 1,
    }, "calendar");
    return findCalendarPrices(d);
  }

  async hotels(city, checkIn, checkOut, adults, o) {
    const d = await this.get({
      engine: "google_hotels", q: o.area ? `hotels in ${o.area}, ${city}` : `hotels in ${city}`,
      check_in_date: checkIn, check_out_date: checkOut, adults,
      hotel_class: [3, 4, 5].filter((s) => s >= o.min_stars).join(","), max_price: o.max_price,
      sort_by: o.sort === "rating" ? 8 : 3,
    }, "hotels");
    const out = [];
    for (const h of d.properties || []) {
      if ((h.type || "hotel").toLowerCase() !== "hotel" || notAHotel(h.name)) continue;
      const stars = h.extracted_hotel_class || 0;
      if (stars && stars < o.min_stars) continue;
      const nightly = (h.rate_per_night || {}).extracted_lowest;
      if (!nightly || (o.max_price && nightly > o.max_price)) continue;
      const gps = h.gps_coordinates || {};
      out.push({ name: h.name, stars, rating: h.overall_rating ?? null, nightly,
        lat: gps.latitude ?? null, lon: gps.longitude ?? null, link: h.link || null });
    }
    return out;
  }
}

function findCalendarPrices(data) {
  const walk = (node) => {
    if (Array.isArray(node) && node.length && node[0] && typeof node[0] === "object" &&
        "price" in node[0] && ("outbound_date" in node[0] || "departure" in node[0])) return node;
    if (node && typeof node === "object") {
      for (const v of Object.values(node)) { const r = walk(v); if (r) return r; }
    }
    return null;
  };
  const out = [];
  for (const r of walk(data) || []) {
    let price = r.price;
    if (price && typeof price === "object") price = price.extracted_price ?? price.price;
    if (price == null) continue;
    out.push({ out_date: r.outbound_date || r.departure, ret_date: r.return_date || r.return || null, price });
  }
  return out;
}

const NOT_HOTEL = ["hostel", "guesthouse", "guest house", "capsule", "dormitory", "dorm ", "backpacker", "bunk",
  "sharehouse", "share house"];
const notAHotel = (name) => { const n = (name || "").toLowerCase(); return NOT_HOTEL.some((w) => n.includes(w)); };

// ---- free tokens: remember which Google Flights result was picked
const freeToken = (it, kind, extra = {}) => JSON.stringify({ free: kind, sig: flightSig(it), price: it.price, ...extra });
function parseFreeToken(t) {
  try { const v = JSON.parse(t); return v && typeof v === "object" && v.free ? v : null; } catch { return null; }
}

export class FreeProvider {
  constructor(settings) { this.s = settings; this.name = "free"; }

  async run(legs, adults) {
    try { return await gf.search(legs, adults, this.s.currency || "JPY"); }
    catch (e) { throw new ProviderError(e.message); }
  }

  async search(p) {
    const o = p.origin.toUpperCase(), d = p.dest.toUpperCase();
    const legs = [[p.out_date, o, d]];
    if (p.ret_date) legs.push([p.ret_date, d, o]);
    const res = await this.run(legs, p.adults || 1);
    for (const f of res.flights) {
      if (p.ret_date) f.departure_token = freeToken(f, "out"); else f.booking_token = freeToken(f, "one");
    }
    return res;
  }

  async returns(p, token) {
    // Google only prices the pair once you pick on its site, so list the return
    // flights and show the round-trip price of the chosen outbound.
    const t = parseFreeToken(token) || {};
    const res = await this.run([[p.ret_date, p.dest.toUpperCase(), p.origin.toUpperCase()]], p.adults || 1);
    for (const f of res.flights) { f.price = t.price; f.booking_token = freeToken(f, "ret", { out_sig: t.sig }); }
    return { flights: res.flights };
  }

  async bookingOptions(p, token) {
    const t = parseFreeToken(token) || {};
    return [{ together: { book_with: "Google Flights (lowest price)", price: t.price, baggage_prices: [],
      extensions: ["add a SerpApi key to compare each site"] } }];
  }

  // A few days at a time (the page asks for the rest in separate requests).
  async calendar(p, start, end, tripDays) {
    const o = p.origin.toUpperCase(), d = p.dest.toUpperCase();
    const days = [];
    for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
    const one = async (day) => {
      const legs = [[day, o, d]];
      const ret = tripDays ? addDays(day, tripDays) : null;
      if (ret) legs.push([ret, d, o]);
      let flights;
      try { flights = (await gf.search(legs, p.adults || 1, this.s.currency || "JPY")).flights; } catch { return null; }
      if (!flights.length) return null;
      const best = flights.reduce((a, b) => (b.price < a.price ? b : a));
      const names = [...new Set(best.flights.map((s) => s.airline).filter(Boolean))].sort();
      return { out_date: day, ret_date: ret, price: best.price, airline: names.join(" + "), stops: best.flights.length - 1 };
    };
    return (await Promise.all(days.map(one))).filter(Boolean);
  }

  async hotels(city, checkIn, checkOut, adults, o) {
    return demoHotels(city, checkIn, o);
  }
}

export class HybridProvider {
  constructor(settings, store) {
    this.name = "hybrid"; this.store = store;
    this.free = new FreeProvider(settings); this.serp = new SerpApiProvider(settings, store);
  }

  async search(p) {
    try { return await this.free.search(p); } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      return this.serp.search(p); // free lookup failed: spend one search instead
    }
  }

  async serpMatch(p, sig) {
    const key = "search:serp-internal:" + stableJson(Object.fromEntries(
      ["origin", "dest", "out_date", "ret_date", "adults"].map((k) => [k, p[k] ?? null])));
    const [res] = await this.store.cached(key, () => this.serp.search(p));
    const m = res.flights.find((f) => flightSig(f) === sig);
    if (!m) throw new ProviderError("Google Flights lists this flight, but the site comparison couldn't find it. Try a different flight");
    return m;
  }

  async returns(p, token) {
    const t = parseFreeToken(token);
    if (t) token = (await this.serpMatch(p, t.sig)).departure_token;
    return this.serp.returns(p, token);
  }

  async bookingOptions(p, token) {
    const t = parseFreeToken(token);
    if (t) {
      if (t.free === "ret") throw new ProviderError("Please pick the flight again");
      token = (await this.serpMatch(p, t.sig)).booking_token;
    }
    return this.serp.bookingOptions(p, token);
  }

  calendar(p, start, end, tripDays) { return this.serp.calendar(p, start, end, tripDays); }
  hotels(city, checkIn, checkOut, adults, o) { return this.serp.hotels(city, checkIn, checkOut, adults, o); }
}

export function getProvider(settings, store) {
  return settings.api_key ? new HybridProvider(settings, store) : new FreeProvider(settings);
}

export function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---- example hotels (no SerpApi key)
function seeded(...parts) {
  let h = 2166136261;
  for (const ch of parts.join("|")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return () => { h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return h / 4294967296; };
}

function demoHotels(city, checkIn, o) {
  const r = seeded(city, o.area || "", checkIn);
  const info = CITIES[city.toLowerCase()];
  const [lat, lon] = info ? [info[1], info[2]] : [35.68, 139.76];
  const place = (o.area || city).replace(/\b\w/g, (c) => c.toUpperCase());
  const names = ["Grand %s Hotel", "Hotel %s Central", "%s Bay Hotel", "The %s Plaza", "%s Station Hotel", "Royal %s",
    "%s Garden Hotel", "Park Hotel %s", "%s Tower Hotel", "Hotel %s Square", "%s Riverside Hotel", "The %s Residence"];
  let out = names.map((n, i) => {
    const stars = 3 + (i % 3);
    return { name: n.replace("%s", place), stars, rating: Math.round((3.6 + r() * 1.2) * 10) / 10,
      nightly: Math.round(((6000 + stars * 4000) * (0.8 + r() * 0.6)) / 100) * 100,
      lat: lat + (r() - 0.5) * 0.06, lon: lon + (r() - 0.5) * 0.06, link: null };
  });
  out = out.filter((h) => h.stars >= o.min_stars && (!o.max_price || h.nightly <= o.max_price));
  out.sort(o.sort === "rating" ? (a, b) => b.rating - a.rating : (a, b) => a.nightly - b.nightly);
  return out;
}
