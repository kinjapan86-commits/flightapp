"""Flight tracker: a small website that runs on your own computer.

Start it with:   python3 app.py
Then open:       http://localhost:8765

No installs needed beyond Python 3.9+. Flight prices come free from Google
Flights. Add a free SerpApi key in Settings to also compare every site selling
a flight, and for real hotel prices.
"""
import json
import math
import mimetypes
import os
import statistics
import sys
import threading
import traceback
import webbrowser
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import cache
import cities
import db
import pricing
import providers
import tracker

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
PORT = int(os.environ.get("PORT", "8765"))
FREE_SEARCHES_PER_MONTH = 250


class BadRequest(Exception):
    pass


def _int(v, default, lo, hi):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def _date(v, field):
    try:
        return datetime.strptime(v, "%Y-%m-%d").date().isoformat()
    except (TypeError, ValueError):
        raise BadRequest("%s should be a date like 2026-12-20" % field)


def flight_params(body):
    """Validate the trip details the page sends."""
    o, d = body.get("origin"), body.get("dest")
    if not (o and d):
        raise BadRequest("Missing origin or destination")
    p = {
        "origin": o["codes"] if isinstance(o, dict) else str(o),
        "dest": d["codes"] if isinstance(d, dict) else str(d),
        "out_date": _date(body.get("out_date"), "Departure date"),
        "ret_date": _date(body["ret_date"], "Return date") if body.get("ret_date") else None,
        "adults": _int(body.get("adults"), 1, 1, 9),
        "bags": _int(body.get("bags"), 1, 0, 3),
        "route_label": body.get("route_label"),
    }
    if p["out_date"] < date.today().isoformat():
        raise BadRequest("That departure date is in the past")
    if p["ret_date"] and p["ret_date"] < p["out_date"]:
        raise BadRequest("Return date is before the departure date")
    return p


def _mode():
    return providers.get_provider().name


# ---- API handlers ----------------------------------------------------------

def api_status(_):
    s = db.get_settings()
    return {
        "mode": _mode(),
        "has_key": bool(s.get("api_key")),
        "calls_this_month": db.api_calls_this_month(),
        "free_limit": FREE_SEARCHES_PER_MONTH,
        "currency": s.get("currency", "JPY"),
        "budget": float(s.get("budget") or 0),
        "home": s.get("home_city", "Tokyo"),
        "cities": cities.city_names(),
        "recent": db.recent_searches(8),
    }


def api_settings(body):
    if "api_key" in body:
        db.set_setting("api_key", (body["api_key"] or "").strip())
        cache.clear_all()
    if "currency" in body:
        cur = (body["currency"] or "JPY").strip().upper()[:3]
        db.set_setting("currency", cur)
        cache.clear_all()
    if "budget" in body:
        db.set_setting("budget", str(float(body["budget"] or 0)))
    if "home_city" in body:
        db.set_setting("home_city", body["home_city"])
    if "bag_table" in body:
        table = body["bag_table"]
        if not isinstance(table, dict) or "airlines" not in table:
            raise BadRequest("Bag table should keep its airlines section")
        pricing.save_bag_table(table)
    return api_status(None)


def api_bag_table(_):
    return pricing.load_bag_table()


def api_route(body):
    o, d, err = cities.parse_route(body.get("q", ""))
    if err:
        raise BadRequest(err)
    return {"origin": o, "dest": d}


def api_calendar(body):
    """Cheapest dates over a range. trip_nights=0 means one way."""
    o, d, err = cities.parse_route(body.get("q", ""))
    if err:
        raise BadRequest(err)
    nights = _int(body.get("nights"), 0, 0, 30)
    start = max(date.today() + timedelta(days=1),
                datetime.strptime(body.get("start") or date.today().isoformat(), "%Y-%m-%d").date())
    end = start + timedelta(days=_int(body.get("days"), 60, 7, 120))
    p = {"origin": o["codes"], "dest": d["codes"], "adults": _int(body.get("adults"), 1, 1, 9)}
    prov = providers.get_provider()
    key = "cal:%s:%s" % (prov.name, json.dumps([p, nights, start.isoformat(), end.isoformat()]))
    prices, from_cache = cache.cached(
        key, lambda: prov.calendar(p, start.isoformat(), end.isoformat(), nights))
    db.save_search({"q": body.get("q"), "nights": nights, "adults": p["adults"],
                    "bags": _int(body.get("bags"), 1, 0, 3)})
    prices = [x for x in prices if x.get("out_date")]
    cheapest = sorted(prices, key=lambda x: x["price"])[:5]
    return {"origin": o, "dest": d, "nights": nights, "prices": prices, "cheapest": cheapest,
            "cached": from_cache}


def api_search(body):
    p = flight_params(body)
    prov = providers.get_provider()
    key = "search:%s:%s" % (prov.name, json.dumps(p, sort_keys=True))
    res, from_cache = cache.cached(key, lambda: prov.search(p))
    res["cached"] = from_cache
    if not from_cache:
        tracker.update_from_search(p, res["flights"])
    return res


def api_returns(body):
    p = flight_params(body)
    prov = providers.get_provider()
    tok = body.get("departure_token")
    if not tok:
        raise BadRequest("Missing departure_token")
    key = "ret:%s:%s" % (prov.name, tok)
    res, _ = cache.cached(key, lambda: prov.returns(p, tok))
    return res


def api_open(body):
    """Open a flight: fetch every site's price, work out the all-in total, save it."""
    p = flight_params(body)
    outbound, inbound = body.get("outbound"), body.get("inbound")
    token = body.get("booking_token")
    if not (outbound and token):
        raise BadRequest("Missing flight")
    prov = providers.get_provider()
    try:
        opts = prov.booking_options(p, token)
    except providers.ProviderError as e:
        cache.clear_prefix("search:")
        raise BadRequest("%s. The listing may have expired, so search again." % e)
    headline = (inbound or outbound).get("price")
    tid, rows = tracker.record(p, outbound, inbound, opts, headline)
    return {"tracked_id": tid, "sites": rows, "headline": headline}


def api_hotels(body):
    city = body.get("city")
    if not city:
        raise BadRequest("Missing city")
    check_in = _date(body.get("check_in"), "Check-in")
    nights = _int(body.get("nights"), 3, 1, 30)
    check_out = (datetime.strptime(check_in, "%Y-%m-%d").date() + timedelta(days=nights)).isoformat()
    adults = _int(body.get("adults"), 1, 1, 9)
    prov = providers.get_provider()
    key = "hotel:%s:%s" % (prov.name, json.dumps([city, check_in, check_out, adults]))
    hotels, from_cache = cache.cached(key, lambda: prov.hotels(city, check_in, check_out, adults))
    rooms = max(1, math.ceil(adults / 2))
    nightly = [h["nightly"] for h in hotels]
    typical = statistics.median(nightly) if nightly else None
    return {
        "hotels": hotels[:8],
        "nights": nights,
        "rooms": rooms,
        "typical_nightly": typical,
        "low_nightly": min(nightly) if nightly else None,
        "estimate": typical * nights * rooms if typical else None,
        "cached": from_cache,
    }


def api_tracked(_):
    return {"tracked": tracker.list_tracked()}


def api_tracked_detail(body):
    d = tracker.detail(_int(body.get("id"), 0, 0, 10**9))
    if not d:
        raise BadRequest("No such saved flight")
    return d


def api_tracked_refresh(body):
    tid = _int(body.get("id"), 0, 0, 10**9)
    try:
        tracker.refresh(tid)
    except providers.ProviderError as e:
        raise BadRequest(str(e))
    return tracker.detail(tid)


def api_tracked_remove(body):
    tracker.remove(_int(body.get("id"), 0, 0, 10**9))
    return {"ok": True}


def api_tracked_frequency(body):
    tracker.set_frequency(_int(body.get("id"), 0, 0, 10**9), _int(body.get("days"), 1, 1, 30))
    return {"ok": True}


ROUTES = {
    ("GET", "/api/status"): api_status,
    ("GET", "/api/bag-table"): api_bag_table,
    ("GET", "/api/tracked"): api_tracked,
    ("POST", "/api/settings"): api_settings,
    ("POST", "/api/route"): api_route,
    ("POST", "/api/calendar"): api_calendar,
    ("POST", "/api/search"): api_search,
    ("POST", "/api/returns"): api_returns,
    ("POST", "/api/open"): api_open,
    ("POST", "/api/hotels"): api_hotels,
    ("POST", "/api/tracked/detail"): api_tracked_detail,
    ("POST", "/api/tracked/refresh"): api_tracked_refresh,
    ("POST", "/api/tracked/remove"): api_tracked_remove,
    ("POST", "/api/tracked/frequency"): api_tracked_frequency,
}


class Handler(BaseHTTPRequestHandler):
    server_version = "FlightApp/1.0"

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _handle(self, method):
        path = urlparse(self.path).path
        fn = ROUTES.get((method, path))
        if fn:
            body = {}
            if method == "POST":
                n = int(self.headers.get("Content-Length") or 0)
                if n:
                    try:
                        body = json.loads(self.rfile.read(n).decode("utf-8"))
                    except ValueError:
                        return self._send(400, {"error": "Bad JSON"})
            try:
                return self._send(200, fn(body))
            except (BadRequest, providers.ProviderError) as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {"error": "Something broke: %s" % e})
        if method != "GET":
            return self._send(404, {"error": "Not found"})
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC) or not os.path.isfile(full):
            return self._send(404, b"Not found", "text/plain")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")


def main():
    if sys.version_info < (3, 9):
        print("Please use Python 3.9 or newer.")
        sys.exit(1)
    db.db()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = "http://localhost:%d" % PORT
    print("Flight tracker running at %s  (mode: %s)" % (url, _mode()))
    print("Prices are only looked up when you search. Press Ctrl+C to stop.")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
