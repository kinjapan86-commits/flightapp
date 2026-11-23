"""Free Google Flights lookups, no API key and nothing to install.

Builds the same search link the Google Flights website uses, downloads the
page, and reads the flight list Google embeds in it. Works the same way as the
open-source fast-flights library, rewritten here with only the Python standard
library.

Google can change its page at any time. If that happens, searches here fail
with a clear message and the rest of the app keeps working.
"""
import base64
import json
import re
import urllib.error
import urllib.parse
import urllib.request

URL = "https://www.google.com/travel/flights/search"
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    # Skips Google's cookie-consent page.
    "Cookie": "CONSENT=YES+cb.20230810-00-p0.en+FX+874; "
              "SOCS=CAISHAgCEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiA_LyaBg",
}
PRICE_LEVELS = {1: "low", 2: "typical", 3: "high"}


class GoogleFlightsError(Exception):
    pass


# ---- the "tfs" search link (a small protobuf message, base64-encoded) -------

def _varint(n):
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def _field(num, wire):
    return _varint((num << 3) | wire)


def _bytes(num, b):
    return _field(num, 2) + _varint(len(b)) + b


def _int(num, n):
    return _field(num, 0) + _varint(n)


def _leg(day, origin, dest):
    """origin/dest can be one code or several, e.g. "HND,NRT" for all of Tokyo."""
    b = _bytes(2, day.encode())
    for code in origin.split(","):
        b += _bytes(13, _bytes(2, code.strip().upper().encode()))
    for code in dest.split(","):
        b += _bytes(14, _bytes(2, code.strip().upper().encode()))
    return b


def tfs(legs, adults=1, seat=1):
    """legs: [(date, origin, dest), ...]. One leg = one way, two = round trip."""
    body = b"".join(_bytes(3, _leg(*l)) for l in legs)
    body += _bytes(8, b"".join(_varint(1) for _ in range(adults)))  # adults
    body += _int(9, seat)                                              # 1 = economy
    body += _int(19, 1 if len(legs) == 2 else 2)                       # 1 round trip, 2 one way
    return base64.b64encode(body).decode()


def search_url(legs, adults=1, currency="JPY"):
    return URL + "?" + urllib.parse.urlencode(
        {"tfs": tfs(legs, adults), "hl": "en", "curr": currency})


# ---- fetching and reading the page ----------------------------------------

def _fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise GoogleFlightsError("Google Flights is limiting requests right now. Try again in a few minutes.")
        raise GoogleFlightsError("Google Flights answered with error %s" % e.code)
    except urllib.error.URLError as e:
        raise GoogleFlightsError("Could not reach Google Flights: %s" % e.reason)


def _payload(html):
    m = re.search(r'<script[^>]*class="ds:1"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        if "consent.google" in html or "Before you continue" in html:
            raise GoogleFlightsError("Google asked for cookie consent, so no flights came back.")
        raise GoogleFlightsError("Google Flights changed its page, so free search can't read it right now.")
    js = m.group(1)
    if "data:" not in js:
        raise GoogleFlightsError("Google Flights returned no data for this search.")
    data = js.split("data:", 1)[1].rsplit(",", 1)[0]
    if data.rstrip().endswith("errorHasStatus: true"):
        return None
    try:
        return json.loads(data)
    except ValueError:
        raise GoogleFlightsError("Google Flights changed its page, so free search can't read it right now.")


def _g(node, *path):
    for i in path:
        if not isinstance(node, list) or i >= len(node):
            return None
        node = node[i]
    return node


def _when(day, hm):
    if not day:
        return ""
    hm = list(hm or []) + [None, None]
    return "%04d-%02d-%02d %02d:%02d" % (day[0], day[1], day[2], hm[0] or 0, hm[1] or 0)


def _segment(s):
    num = _g(s, 22) or []
    code, n = (num[0] if num else ""), (num[1] if len(num) > 1 else "")
    return {
        "departure_airport": {"id": _g(s, 3), "name": _g(s, 4), "time": _when(_g(s, 20), _g(s, 8))},
        "arrival_airport": {"id": _g(s, 6), "name": _g(s, 5), "time": _when(_g(s, 21), _g(s, 10))},
        "duration": _g(s, 11),
        "airline": (num[3] if len(num) > 3 and num[3] else None),
        "flight_number": ("%s %s" % (code, n)).strip(),
        "airplane": _g(s, 17),
        "travel_class": "Economy",
    }


def _itinerary(item):
    f = _g(item, 0) or []
    segs = [_segment(s) for s in (_g(f, 2) or [])]
    if not segs:
        return None
    names = _g(f, 1) or []
    for s in segs:
        if not s["airline"]:
            s["airline"] = names[0] if names else _g(f, 0)
    total = _g(f, 9)
    if not isinstance(total, int):
        total = sum(s["duration"] or 0 for s in segs)
    return {
        "flights": segs,
        "total_duration": total,
        "price": _g(item, 1, 0, 1),
        "source": "google",
    }


def _insights(p):
    pi = _g(p, 5)
    if not isinstance(pi, list):
        return None
    out = {}
    level = _g(pi, 0)
    if level in PRICE_LEVELS:
        out["price_level"] = PRICE_LEVELS[level]
    lo, hi = _g(pi, 4, 1), _g(pi, 5, 1)
    if isinstance(lo, (int, float)) and isinstance(hi, (int, float)):
        out["typical_price_range"] = [lo, hi]
    hist = _g(pi, 10, 0)
    if isinstance(hist, list):
        out["price_history"] = [[int(t // 1000), v] for t, v in
                                (h for h in hist if isinstance(h, list) and len(h) == 2) if v]
    return out or None


def search(legs, adults=1, currency="JPY"):
    """Return {"flights": [...], "price_insights": {...}} for the first leg.

    For a round trip the prices are round-trip totals, as on Google Flights."""
    p = _payload(_fetch(search_url(legs, adults, currency)))
    if p is None:
        return {"flights": [], "price_insights": None}
    flights = []
    for group in (_g(p, 2, 0) or [], _g(p, 3, 0) or []):
        for item in group:
            it = _itinerary(item)
            if it and it["price"]:
                flights.append(it)
    seen, unique = set(), []
    for f in flights:
        sig = "|".join(s["flight_number"] + "@" + s["departure_airport"]["time"] for s in f["flights"])
        if sig not in seen:
            seen.add(sig)
            unique.append(f)
    return {"flights": unique, "price_insights": _insights(p)}
