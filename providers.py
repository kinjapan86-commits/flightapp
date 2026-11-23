"""Flight data providers.

SerpApiProvider talks to SerpApi's Google Flights engine, which returns flight
options plus, per itinerary, the list of sites selling it (airline and online
travel agencies) with each site's price.

FreeProvider reads real prices straight from Google Flights with no key.
HybridProvider (used once a SerpApi key is saved) browses and re-checks with
the free lookup and only spends SerpApi searches on the per-site comparison,
return-flight pricing, the date calendar and hotels.

DemoProvider makes up hotel prices when there's no key.
"""
import hashlib
import json
import random
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

import cache
import db
import googleflights

SERPAPI_URL = "https://serpapi.com/search.json"


class ProviderError(Exception):
    pass


def flight_sig(itinerary):
    """Stable identity for an itinerary: flight numbers + departure times."""
    parts = []
    for leg in itinerary.get("flights", []):
        num = (leg.get("flight_number") or "").replace(" ", "")
        dep = (leg.get("departure_airport") or {}).get("time", "")
        parts.append("%s@%s" % (num, dep))
    return "|".join(parts)


class SerpApiProvider:
    name = "serpapi"

    def __init__(self, settings):
        self.settings = settings

    def _get(self, params, kind):
        base = {
            "engine": params.pop("engine", "google_flights"),
            "api_key": self.settings["api_key"],
            "currency": self.settings.get("currency", "JPY"),
            "hl": self.settings.get("language", "en"),
            "gl": self.settings.get("country", "jp"),
        }
        base.update({k: v for k, v in params.items() if v not in (None, "")})
        url = SERPAPI_URL + "?" + urllib.parse.urlencode(base)
        req = urllib.request.Request(url, headers={"User-Agent": "flight-app/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode("utf-8"))
                msg = body.get("error") or str(e)
            except Exception:
                msg = str(e)
            raise ProviderError("SerpApi: %s" % msg)
        except urllib.error.URLError as e:
            raise ProviderError("Could not reach SerpApi: %s" % e.reason)
        db.log_api_call(kind)
        if data.get("error"):
            # "Google Flights hasn't returned any results" is a normal empty answer.
            if "hasn't returned any results" in data["error"]:
                return {}
            raise ProviderError("SerpApi: %s" % data["error"])
        return data

    def _common(self, p):
        return {
            "departure_id": p["origin"].upper(),
            "arrival_id": p["dest"].upper(),
            "outbound_date": p["out_date"],
            "return_date": p.get("ret_date") or None,
            "type": 1 if p.get("ret_date") else 2,
            "adults": p.get("adults", 1),
            "travel_class": p.get("travel_class", 1),
        }

    def search(self, p):
        data = self._get(self._common(p), "search")
        return {
            "flights": data.get("best_flights", []) + data.get("other_flights", []),
            "price_insights": data.get("price_insights"),
        }

    def returns(self, p, departure_token):
        q = self._common(p)
        q["departure_token"] = departure_token
        data = self._get(q, "returns")
        return {"flights": data.get("best_flights", []) + data.get("other_flights", [])}

    def booking_options(self, p, booking_token):
        q = self._common(p)
        q["booking_token"] = booking_token
        data = self._get(q, "booking")
        return data.get("booking_options", [])

    def calendar(self, p, start, end, trip_days):
        q = {
            "engine": "google_flights_calendar",
            "departure_id": p["origin"].upper(),
            "arrival_id": p["dest"].upper(),
            "type": 1 if trip_days else 2,
            "round_trip_days": trip_days or None,
            "date_range_start": start,
            "date_range_end": end,
            "adults": p.get("adults", 1),
        }
        data = self._get(q, "calendar")
        return _find_calendar_prices(data)

    def hotels(self, city, check_in, check_out, adults, area="", min_stars=3, max_price=None, sort="price"):
        q = {
            "engine": "google_hotels",
            "q": "hotels in %s, %s" % (area, city) if area else "hotels in %s" % city,
            "check_in_date": check_in,
            "check_out_date": check_out,
            "adults": adults,
            "hotel_class": ",".join(str(s) for s in range(min_stars, 6)),
            "max_price": max_price,
            "sort_by": 8 if sort == "rating" else 3,  # 8 highest rating, 3 lowest price
        }
        data = self._get(q, "hotels")
        out = []
        for h in data.get("properties", []):
            if (h.get("type") or "hotel").lower() != "hotel" or _not_a_hotel(h.get("name")):
                continue
            stars = h.get("extracted_hotel_class") or 0
            if stars and stars < min_stars:
                continue
            nightly = (h.get("rate_per_night") or {}).get("extracted_lowest")
            if not nightly:
                continue
            gps = h.get("gps_coordinates") or {}
            out.append({
                "name": h.get("name"),
                "stars": stars,
                "rating": h.get("overall_rating"),
                "nightly": nightly,
                "lat": gps.get("latitude"),
                "lon": gps.get("longitude"),
                "link": h.get("link"),
            })
        return [h for h in out if not max_price or h["nightly"] <= max_price]


_NOT_HOTEL = ("hostel", "guesthouse", "guest house", "capsule", "dormitory", "dorm ", "backpacker",
              "bunk", "sharehouse", "share house")


def _not_a_hotel(name):
    n = (name or "").lower()
    return any(w in n for w in _NOT_HOTEL)


def _hotel_filters(hotels, min_stars, max_price, sort):
    out = [h for h in hotels if (h["stars"] or 0) >= min_stars and not _not_a_hotel(h["name"])
           and (not max_price or h["nightly"] <= max_price)]
    if sort == "rating":
        out.sort(key=lambda h: -(h["rating"] or 0))
    else:
        out.sort(key=lambda h: h["nightly"])
    return out


def _find_calendar_prices(data):
    """The calendar list's key isn't documented reliably, so find it by shape."""
    def walk(node):
        if isinstance(node, list) and node and isinstance(node[0], dict) \
                and "price" in node[0] and ("outbound_date" in node[0] or "departure" in node[0]):
            return node
        if isinstance(node, dict):
            for v in node.values():
                r = walk(v)
                if r:
                    return r
        return None
    rows = walk(data) or []
    out = []
    for r in rows:
        price = r.get("price")
        if isinstance(price, dict):
            price = price.get("extracted_price") or price.get("price")
        if price is None:
            continue
        out.append({
            "out_date": r.get("outbound_date") or r.get("departure"),
            "ret_date": r.get("return_date") or r.get("return"),
            "price": price,
        })
    return out


# ---------------------------------------------------------------------------
# Demo data
# ---------------------------------------------------------------------------

DEMO_AIRLINES = [
    ("Japan Airlines", "JL", True),
    ("ANA", "NH", True),
    ("ZIPAIR", "ZG", False),
    ("Peach", "MM", False),
    ("United", "UA", True),
    ("Korean Air", "KE", True),
]
DEMO_SITES = ["Trip.com", "Expedia", "Booking.com", "Kiwi.com", "Gotogate", "Mytrip"]


def _seed(*parts):
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(h[:12], 16)


class DemoProvider:
    name = "demo"

    def __init__(self, settings):
        self.settings = settings

    def _base_price(self, origin, dest):
        r = random.Random(_seed(origin, dest))
        return r.randint(18, 140) * 1000

    def _day_factor(self, *key):
        # Changes once per calendar day, so re-checks show movement over time.
        r = random.Random(_seed(date.today().isoformat(), *key))
        return 0.88 + r.random() * 0.24

    def _itinerary(self, r, origin, dest, day, idx, base, round_trip):
        origin, dest = origin.split(",")[0], dest.split(",")[0]
        name, code, full_service = DEMO_AIRLINES[idx % len(DEMO_AIRLINES)]
        dep_hour = 6 + (idx * 3) % 16
        dep = datetime.strptime(day, "%Y-%m-%d").replace(hour=dep_hour, minute=(idx * 25) % 60)
        dur = r.randint(90, 720)
        arr = dep + timedelta(minutes=dur)
        num = "%s %d" % (code, 100 + _seed(origin, dest, day, idx) % 900)
        price = base * (1.0 if full_service else 0.72) * (0.9 + r.random() * 0.3)
        price *= self._day_factor(origin, dest, day, idx)
        if round_trip:
            price *= 1.8
        return {
            "flights": [{
                "departure_airport": {"id": origin, "name": origin, "time": dep.strftime("%Y-%m-%d %H:%M")},
                "arrival_airport": {"id": dest, "name": dest, "time": arr.strftime("%Y-%m-%d %H:%M")},
                "duration": dur,
                "airline": name,
                "flight_number": num,
                "travel_class": "Economy",
            }],
            "total_duration": dur,
            "price": int(round(price, -2)),
            "type": "Round trip" if round_trip else "One way",
            "_full_service": full_service,
        }

    def _options(self, p, origin, dest, day, round_trip, token_kind):
        r = random.Random(_seed(origin, dest, day, token_kind))
        base = self._base_price(origin, dest)
        out = []
        for i in range(6):
            it = self._itinerary(r, origin, dest, day, i, base, round_trip)
            it["price"] = int(it["price"] * int(p.get("adults", 1)))
            token = json.dumps({"o": origin, "d": dest, "day": day, "i": i, "k": token_kind,
                                "p": it["price"]})
            if token_kind == "out" and p.get("ret_date"):
                it["departure_token"] = token
            else:
                it["booking_token"] = token
            out.append(it)
        out.sort(key=lambda x: x["price"])
        return out

    def search(self, p):
        o, d = p["origin"].upper(), p["dest"].upper()
        flights = self._options(p, o, d, p["out_date"], bool(p.get("ret_date")), "out")
        today = date.today()
        base = min(f["price"] for f in flights) * 1.1
        r = random.Random(_seed(o, d, p["out_date"], "hist"))
        history = []
        for days_ago in range(60, -1, -1):
            ts = datetime.combine(today - timedelta(days=days_ago), datetime.min.time())
            history.append([int(ts.timestamp()), int(round(base * (0.8 + r.random() * 0.4), -2))])
        lowest = min(f["price"] for f in flights)
        return {
            "flights": flights,
            "price_insights": {
                "lowest_price": lowest,
                "price_level": "typical",
                "typical_price_range": [int(base * 0.85), int(base * 1.15)],
                "price_history": history,
            },
        }

    def returns(self, p, departure_token):
        t = json.loads(departure_token)
        out = self._options(p, t["d"], t["o"], p["ret_date"], True, "ret%d" % t["i"])
        return {"flights": out}

    def booking_options(self, p, booking_token):
        t = json.loads(booking_token)
        r = random.Random(_seed(booking_token, date.today().isoformat()))
        idx = t["i"]
        airline, _, full_service = DEMO_AIRLINES[idx % len(DEMO_AIRLINES)]
        base = t["p"]
        options = []
        sellers = [airline] + r.sample(DEMO_SITES, 4)
        for n, site in enumerate(sellers):
            fare = int(round(base * (1.0 + (r.random() * 0.12 - 0.05 if n else 0.02)), -2))
            bag_text = []
            if full_service:
                bag_text = ["1 free carry-on", "1 free checked bag"]
            elif n == 0 or r.random() < 0.5:
                bag_text = ["1 free carry-on", "1st checked bag: ¥%s" % format(r.choice([3600, 4500, 5800]), ",")]
            options.append({"together": {
                "book_with": site,
                "airline": n == 0,
                "price": fare,
                "option_title": "Economy" if full_service else "Basic",
                "baggage_prices": bag_text,
                "extensions": ["Demo data"],
            }})
        return options

    def calendar(self, p, start, end, trip_days):
        o, d = p["origin"].upper(), p["dest"].upper()
        base = self._base_price(o, d) * (1.8 if trip_days else 1.0)
        day = datetime.strptime(start, "%Y-%m-%d").date()
        last = datetime.strptime(end, "%Y-%m-%d").date()
        out = []
        while day <= last:
            ret = (day + timedelta(days=trip_days)).isoformat() if trip_days else None
            q = dict(p, out_date=day.isoformat(), ret_date=ret)
            price = self._options(q, o, d, day.isoformat(), bool(trip_days), "out")[0]["price"]
            out.append({"out_date": day.isoformat(), "ret_date": ret, "price": int(round(price, -2))})
            day += timedelta(days=1)
        return out

    def hotels(self, city, check_in, check_out, adults, area="", min_stars=3, max_price=None, sort="price"):
        r = random.Random(_seed(city, area, check_in))
        lat, lon = 35.68, 139.76
        import cities
        info = cities.resolve(city)
        if info and info.get("lat") is not None:
            lat, lon = info["lat"], info["lon"]
        names = ["Grand %s Hotel", "Hotel %s Central", "%s Bay Hotel", "The %s Plaza",
                 "%s Station Hotel", "Royal %s", "%s Garden Hotel", "Park Hotel %s",
                 "%s Tower Hotel", "Hotel %s Square", "%s Riverside Hotel", "The %s Residence"]
        place = (area or city).title()
        out = []
        for i, n in enumerate(names):
            stars = 3 + (i % 3)
            out.append({
                "name": n % place,
                "stars": stars,
                "rating": round(3.6 + r.random() * 1.2, 1),
                "nightly": int(round((6000 + stars * 4000) * (0.8 + r.random() * 0.6), -2)),
                "lat": lat + (r.random() - 0.5) * 0.06,
                "lon": lon + (r.random() - 0.5) * 0.06,
                "link": None,
            })
        return _hotel_filters(out, min_stars, max_price, sort)


# ---------------------------------------------------------------------------
# Free Google Flights (no key), and the free + SerpApi mix
# ---------------------------------------------------------------------------

def _free_token(itin, kind, **extra):
    t = {"free": kind, "sig": flight_sig(itin), "price": itin.get("price")}
    t.update(extra)
    return json.dumps(t)


def _parse_free_token(token):
    try:
        t = json.loads(token)
    except (TypeError, ValueError):
        return None
    return t if isinstance(t, dict) and t.get("free") else None


class FreeProvider:
    """Real flight prices straight from Google Flights. No key, no monthly limit.

    It can't see which sites sell a flight, so opening a flight shows Google's
    lowest price as one row. Hotels fall back to example prices."""
    name = "free"

    def __init__(self, settings):
        self.settings = settings

    def _currency(self):
        return self.settings.get("currency", "JPY")

    def _run(self, legs, adults):
        try:
            return googleflights.search(legs, adults, self._currency())
        except googleflights.GoogleFlightsError as e:
            raise ProviderError(str(e))

    def search(self, p):
        o, d = p["origin"].upper(), p["dest"].upper()
        legs = [(p["out_date"], o, d)]
        if p.get("ret_date"):
            legs.append((p["ret_date"], d, o))
        res = self._run(legs, int(p.get("adults", 1)))
        for f in res["flights"]:
            if p.get("ret_date"):
                f["departure_token"] = _free_token(f, "out")
            else:
                f["booking_token"] = _free_token(f, "one")
        return res

    def returns(self, p, departure_token):
        # Google only prices the pair once you pick on its site, so list the
        # return flights and show the round-trip price of the chosen outbound.
        t = _parse_free_token(departure_token) or {}
        o, d = p["origin"].upper(), p["dest"].upper()
        res = self._run([(p["ret_date"], d, o)], int(p.get("adults", 1)))
        for f in res["flights"]:
            f["price"] = t.get("price")
            f["booking_token"] = _free_token(f, "ret", out_sig=t.get("sig"))
        return {"flights": res["flights"]}

    def booking_options(self, p, booking_token):
        t = _parse_free_token(booking_token) or {}
        return [{"together": {
            "book_with": "Google Flights (lowest price)",
            "price": t.get("price"),
            "baggage_prices": [],
            "extensions": ["add a SerpApi key to compare each site"],
        }}]

    def calendar(self, p, start, end, trip_days):
        o, d = p["origin"].upper(), p["dest"].upper()
        adults = int(p.get("adults", 1))
        first = datetime.strptime(start, "%Y-%m-%d").date()
        last = datetime.strptime(end, "%Y-%m-%d").date()
        days = [first + timedelta(days=i) for i in range((last - first).days + 1)]

        def one(day):
            legs = [(day.isoformat(), o, d)]
            ret = None
            if trip_days:
                ret = (day + timedelta(days=trip_days)).isoformat()
                legs.append((ret, d, o))
            try:
                flights = googleflights.search(legs, adults, self._currency())["flights"]
            except googleflights.GoogleFlightsError:
                return None
            if not flights:
                return None
            best = min(flights, key=lambda f: f["price"])
            names = sorted({s["airline"] for s in best["flights"] if s.get("airline")})
            return {"out_date": day.isoformat(), "ret_date": ret, "price": best["price"],
                    "airline": " + ".join(names), "stops": len(best["flights"]) - 1}

        with ThreadPoolExecutor(max_workers=6) as pool:
            out = [r for r in pool.map(one, days) if r]
        if not out and days:
            raise ProviderError("Couldn't get prices from Google Flights for these dates. Try again in a few minutes.")
        return out

    def hotels(self, city, check_in, check_out, adults, **opts):
        return DemoProvider(self.settings).hotels(city, check_in, check_out, adults, **opts)


class HybridProvider:
    """Free Google Flights for browsing and daily checks; SerpApi only for the
    per-site price comparison, return-flight pricing, the date calendar and hotels."""
    name = "hybrid"

    def __init__(self, settings):
        self.settings = settings
        self.free = FreeProvider(settings)
        self.serp = SerpApiProvider(settings)

    def search(self, p):
        try:
            return self.free.search(p)
        except ProviderError:
            return self.serp.search(p)  # free lookup failed: spend one search instead

    def _serp_search(self, p):
        key = "search:serp-internal:" + json.dumps(
            {k: p.get(k) for k in ("origin", "dest", "out_date", "ret_date", "adults")}, sort_keys=True)
        res, _ = cache.cached(key, lambda: self.serp.search(dict(p)))
        return res["flights"]

    def _serp_match(self, p, sig):
        match = next((f for f in self._serp_search(p) if flight_sig(f) == sig), None)
        if not match:
            raise ProviderError("Google Flights lists this flight, but the site comparison couldn't find it. "
                                "Try a different flight")
        return match

    def returns(self, p, departure_token):
        t = _parse_free_token(departure_token)
        if t:
            departure_token = self._serp_match(p, t["sig"])["departure_token"]
        return self.serp.returns(p, departure_token)

    def booking_options(self, p, booking_token):
        t = _parse_free_token(booking_token)
        if t:
            if t["free"] == "ret":
                raise ProviderError("Please pick the flight again")
            booking_token = self._serp_match(p, t["sig"])["booking_token"]
        return self.serp.booking_options(p, booking_token)

    def calendar(self, p, start, end, trip_days):
        return self.serp.calendar(p, start, end, trip_days)

    def hotels(self, city, check_in, check_out, adults, **opts):
        return self.serp.hotels(city, check_in, check_out, adults, **opts)


def get_provider():
    s = db.get_settings()
    if s.get("api_key"):
        return HybridProvider(s)
    return FreeProvider(s)


def get_free_provider():
    return FreeProvider(db.get_settings())
