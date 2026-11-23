// Free Google Flights lookups: builds the same search link the Google Flights
// website uses, downloads the page, and reads the flight list embedded in it.
// Same method as googleflights.py in the Mac version.

const URL_BASE = "https://www.google.com/travel/flights/search";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  // Skips Google's cookie-consent page.
  "Cookie": "CONSENT=YES+cb.20230810-00-p0.en+FX+874; SOCS=CAISHAgCEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiA_LyaBg",
};
const PRICE_LEVELS = { 1: "low", 2: "typical", 3: "high" };

export class GoogleFlightsError extends Error {}

// ---- the "tfs" search link (a small protobuf message, base64-encoded)
const enc = new TextEncoder();
function varint(n) {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) out.push(b | 0x80); else { out.push(b); return out; }
  }
}
const field = (num, wire) => varint(num * 8 + wire);
const bytes = (num, arr) => [...field(num, 2), ...varint(arr.length), ...arr];
const int = (num, n) => [...field(num, 0), ...varint(n)];

function leg(day, origin, dest) {
  let b = bytes(2, [...enc.encode(day)]);
  for (const c of origin.split(",")) b = b.concat(bytes(13, bytes(2, [...enc.encode(c.trim().toUpperCase())])));
  for (const c of dest.split(",")) b = b.concat(bytes(14, bytes(2, [...enc.encode(c.trim().toUpperCase())])));
  return b;
}

export function tfs(legs, adults = 1, seat = 1) {
  let body = [];
  for (const l of legs) body = body.concat(bytes(3, leg(...l)));
  const pax = [];
  for (let i = 0; i < adults; i++) pax.push(...varint(1));
  body = body.concat(bytes(8, pax), int(9, seat), int(19, legs.length === 2 ? 1 : 2));
  return btoa(String.fromCharCode(...body));
}

export function searchUrl(legs, adults = 1, currency = "JPY") {
  const q = new URLSearchParams({ tfs: tfs(legs, adults), hl: "en", curr: currency });
  return URL_BASE + "?" + q.toString();
}

// ---- fetching: read the page only until the flight data has arrived
async function fetchData(url) {
  let res;
  try {
    res = await fetch(url, { headers: HEADERS });
  } catch (e) {
    throw new GoogleFlightsError("Could not reach Google Flights: " + e.message);
  }
  if (res.status === 429) throw new GoogleFlightsError("Google Flights is limiting requests right now. Try again in a few minutes.");
  if (!res.ok) throw new GoogleFlightsError("Google Flights answered with error " + res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const MARK = 'class="ds:1"';
  let tail = "", found = null, sawConsent = false;
  for (;;) {
    const { done, value } = await reader.read();
    const piece = value ? dec.decode(value, { stream: !done }) : "";
    if (found === null) {
      const look = tail + piece;
      if (!sawConsent && (look.includes("consent.google") || look.includes("Before you continue"))) sawConsent = true;
      const i = look.indexOf(MARK);
      if (i >= 0) found = look.slice(i); else tail = look.slice(-MARK.length);
    } else {
      found += piece;
    }
    if (found !== null) {
      const end = found.indexOf("</script>");
      if (end >= 0) { reader.cancel().catch(() => {}); return found.slice(found.indexOf(">") + 1, end); }
    }
    if (done) break;
  }
  const text = sawConsent ? "consent.google" : "";
  if (text.includes("consent.google") || text.includes("Before you continue")) {
    throw new GoogleFlightsError("Google asked for cookie consent, so no flights came back.");
  }
  throw new GoogleFlightsError("Google Flights changed its page, so free search can't read it right now.");
}

function payload(js) {
  if (!js.includes("data:")) throw new GoogleFlightsError("Google Flights returned no data for this search.");
  let data = js.split("data:").slice(1).join("data:");
  data = data.slice(0, data.lastIndexOf(","));
  if (data.trimEnd().endsWith("errorHasStatus: true")) return null;
  try { return JSON.parse(data); } catch {
    throw new GoogleFlightsError("Google Flights changed its page, so free search can't read it right now.");
  }
}

function g(node, ...path) {
  for (const i of path) {
    if (!Array.isArray(node) || i >= node.length) return null;
    node = node[i];
  }
  return node ?? null;
}

const pad = (n) => String(n || 0).padStart(2, "0");
function when(day, hm) {
  if (!day) return "";
  const t = [...(hm || []), null, null];
  return `${day[0]}-${pad(day[1])}-${pad(day[2])} ${pad(t[0])}:${pad(t[1])}`;
}

function segment(s) {
  const num = g(s, 22) || [];
  return {
    departure_airport: { id: g(s, 3), name: g(s, 4), time: when(g(s, 20), g(s, 8)) },
    arrival_airport: { id: g(s, 6), name: g(s, 5), time: when(g(s, 21), g(s, 10)) },
    duration: g(s, 11),
    airline: num[3] || null,
    flight_number: `${num[0] || ""} ${num[1] || ""}`.trim(),
    airplane: g(s, 17),
    travel_class: "Economy",
  };
}

function itinerary(item) {
  const f = g(item, 0) || [];
  const segs = (g(f, 2) || []).map(segment);
  if (!segs.length) return null;
  const names = g(f, 1) || [];
  for (const s of segs) if (!s.airline) s.airline = names[0] || g(f, 0);
  let total = g(f, 9);
  if (typeof total !== "number") total = segs.reduce((a, s) => a + (s.duration || 0), 0);
  return { flights: segs, total_duration: total, price: g(item, 1, 0, 1), source: "google" };
}

function insights(p) {
  const pi = g(p, 5);
  if (!Array.isArray(pi)) return null;
  const out = {};
  const level = g(pi, 0);
  if (PRICE_LEVELS[level]) out.price_level = PRICE_LEVELS[level];
  const lo = g(pi, 4, 1), hi = g(pi, 5, 1);
  if (typeof lo === "number" && typeof hi === "number") out.typical_price_range = [lo, hi];
  const hist = g(pi, 10, 0);
  if (Array.isArray(hist)) {
    out.price_history = hist.filter((h) => Array.isArray(h) && h.length === 2 && h[1]).map(([t, v]) => [Math.floor(t / 1000), v]);
  }
  return Object.keys(out).length ? out : null;
}

export const flightSig = (it) => (it.flights || []).map((l) =>
  `${(l.flight_number || "").replace(/ /g, "")}@${(l.departure_airport || {}).time || ""}`).join("|");

// Returns {flights, price_insights}. For a round trip the prices are round-trip totals.
export async function search(legs, adults = 1, currency = "JPY") {
  const p = payload(await fetchData(searchUrl(legs, adults, currency)));
  if (!p) return { flights: [], price_insights: null };
  const seen = new Set(), flights = [];
  for (const group of [g(p, 2, 0) || [], g(p, 3, 0) || []]) {
    for (const item of group) {
      const it = itinerary(item);
      if (!it || !it.price) continue;
      const sig = flightSig(it);
      if (seen.has(sig)) continue;
      seen.add(sig);
      flights.push(it);
    }
  }
  return { flights, price_insights: insights(p) };
}
