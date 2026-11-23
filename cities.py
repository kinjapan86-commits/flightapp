"""City names -> airport codes and map coordinates.

Type a city ("Tokyo", "seoul") or any 3-letter airport code ("ICN").
Add more cities to CITIES as you need them: name: (airport codes, lat, lon).
"""
import re

CITIES = {
    # Japan
    "tokyo": ("HND,NRT", 35.68, 139.76),
    "osaka": ("KIX,ITM", 34.69, 135.50),
    "sapporo": ("CTS", 43.06, 141.35),
    "fukuoka": ("FUK", 33.59, 130.40),
    "okinawa": ("OKA", 26.21, 127.68),
    "naha": ("OKA", 26.21, 127.68),
    "nagoya": ("NGO", 35.18, 136.91),
    "kyoto": ("KIX,ITM", 35.01, 135.77),
    "hiroshima": ("HIJ", 34.39, 132.46),
    "sendai": ("SDJ", 38.27, 140.87),
    # Korea / China / Taiwan / HK
    "seoul": ("ICN,GMP", 37.57, 126.98),
    "busan": ("PUS", 35.18, 129.08),
    "jeju": ("CJU", 33.50, 126.53),
    "taipei": ("TPE,TSA", 25.03, 121.57),
    "kaohsiung": ("KHH", 22.63, 120.30),
    "hong kong": ("HKG", 22.32, 114.17),
    "macau": ("MFM", 22.20, 113.54),
    "shanghai": ("PVG,SHA", 31.23, 121.47),
    "beijing": ("PEK,PKX", 39.90, 116.40),
    "guangzhou": ("CAN", 23.13, 113.26),
    "shenzhen": ("SZX", 22.54, 114.06),
    # Southeast Asia
    "bangkok": ("BKK,DMK", 13.76, 100.50),
    "phuket": ("HKT", 7.88, 98.39),
    "chiang mai": ("CNX", 18.79, 98.98),
    "singapore": ("SIN", 1.35, 103.82),
    "kuala lumpur": ("KUL", 3.14, 101.69),
    "manila": ("MNL", 14.60, 120.98),
    "cebu": ("CEB", 10.32, 123.89),
    "ho chi minh city": ("SGN", 10.82, 106.63),
    "saigon": ("SGN", 10.82, 106.63),
    "hanoi": ("HAN", 21.03, 105.85),
    "da nang": ("DAD", 16.05, 108.20),
    "bali": ("DPS", -8.65, 115.22),
    "denpasar": ("DPS", -8.65, 115.22),
    "jakarta": ("CGK", -6.21, 106.85),
    "phnom penh": ("PNH", 11.56, 104.92),
    "siem reap": ("SAI", 13.36, 103.86),
    # South Asia / Middle East
    "delhi": ("DEL", 28.61, 77.21),
    "new delhi": ("DEL", 28.61, 77.21),
    "mumbai": ("BOM", 19.08, 72.88),
    "bangalore": ("BLR", 12.97, 77.59),
    "kathmandu": ("KTM", 27.72, 85.32),
    "colombo": ("CMB", 6.93, 79.86),
    "male": ("MLE", 4.18, 73.51),
    "maldives": ("MLE", 4.18, 73.51),
    "dubai": ("DXB", 25.20, 55.27),
    "abu dhabi": ("AUH", 24.45, 54.38),
    "doha": ("DOH", 25.29, 51.53),
    "istanbul": ("IST,SAW", 41.01, 28.98),
    # Oceania
    "sydney": ("SYD", -33.87, 151.21),
    "melbourne": ("MEL", -37.81, 144.96),
    "brisbane": ("BNE", -27.47, 153.03),
    "cairns": ("CNS", -16.92, 145.77),
    "perth": ("PER", -31.95, 115.86),
    "auckland": ("AKL", -36.85, 174.76),
    "guam": ("GUM", 13.44, 144.79),
    "honolulu": ("HNL", 21.31, -157.86),
    "hawaii": ("HNL", 21.31, -157.86),
    # Europe
    "london": ("LHR,LGW,STN", 51.51, -0.13),
    "paris": ("CDG,ORY", 48.86, 2.35),
    "amsterdam": ("AMS", 52.37, 4.90),
    "frankfurt": ("FRA", 50.11, 8.68),
    "munich": ("MUC", 48.14, 11.58),
    "berlin": ("BER", 52.52, 13.40),
    "zurich": ("ZRH", 47.38, 8.54),
    "vienna": ("VIE", 48.21, 16.37),
    "rome": ("FCO", 41.90, 12.50),
    "milan": ("MXP,LIN", 45.46, 9.19),
    "barcelona": ("BCN", 41.39, 2.17),
    "madrid": ("MAD", 40.42, -3.70),
    "lisbon": ("LIS", 38.72, -9.14),
    "dublin": ("DUB", 53.35, -6.26),
    "copenhagen": ("CPH", 55.68, 12.57),
    "helsinki": ("HEL", 60.17, 24.94),
    "prague": ("PRG", 50.08, 14.44),
    "athens": ("ATH", 37.98, 23.73),
    # Americas
    "new york": ("JFK,EWR,LGA", 40.71, -74.01),
    "los angeles": ("LAX", 34.05, -118.24),
    "san francisco": ("SFO", 37.77, -122.42),
    "seattle": ("SEA", 47.61, -122.33),
    "las vegas": ("LAS", 36.17, -115.14),
    "chicago": ("ORD", 41.88, -87.63),
    "boston": ("BOS", 42.36, -71.06),
    "washington": ("IAD,DCA", 38.91, -77.04),
    "dallas": ("DFW", 32.78, -96.80),
    "houston": ("IAH", 29.76, -95.37),
    "miami": ("MIA", 25.76, -80.19),
    "vancouver": ("YVR", 49.28, -123.12),
    "toronto": ("YYZ", 43.65, -79.38),
    "mexico city": ("MEX", 19.43, -99.13),
    "cancun": ("CUN", 21.16, -86.85),
    "sao paulo": ("GRU", -23.55, -46.63),
}

# Single airports, for when someone types a code. lat/lon for the map.
AIRPORTS = {
    "HND": (35.55, 139.78), "NRT": (35.77, 140.39), "KIX": (34.43, 135.24),
    "ITM": (34.79, 135.44), "ICN": (37.46, 126.44), "GMP": (37.56, 126.80),
    "TPE": (25.08, 121.23), "HKG": (22.31, 113.91), "BKK": (13.69, 100.75),
    "SIN": (1.36, 103.99), "LAX": (33.94, -118.41), "JFK": (40.64, -73.78),
    "LHR": (51.47, -0.45), "CDG": (49.01, 2.55),
}

SPLIT = re.compile(r"\s*(?:>|->|→|\bto\b|–|—|\s-\s)\s*", re.IGNORECASE)


def resolve(text):
    """'Tokyo' -> {'label': 'Tokyo', 'codes': 'HND,NRT', 'lat':..., 'lon':...}"""
    t = (text or "").strip()
    if not t:
        return None
    key = t.lower()
    if key in CITIES:
        codes, lat, lon = CITIES[key]
        return {"label": t.title(), "codes": codes, "lat": lat, "lon": lon, "city": t.title()}
    # Comma separated airport codes, e.g. "HND,NRT"
    codes = [c.strip().upper() for c in t.split(",")]
    if all(re.fullmatch(r"[A-Za-z]{3}", c) for c in codes):
        # Find the city these codes belong to, if we know it.
        for name, (cc, lat, lon) in CITIES.items():
            if codes[0] in cc.split(","):
                return {"label": codes[0] if len(codes) == 1 else ",".join(codes),
                        "codes": ",".join(codes), "lat": lat, "lon": lon, "city": name.title()}
        lat, lon = AIRPORTS.get(codes[0], (None, None))
        return {"label": ",".join(codes), "codes": ",".join(codes), "lat": lat, "lon": lon,
                "city": codes[0]}
    return None


def parse_route(text):
    """'TOKYO > SEOUL' -> (origin, dest). Returns (None, None) if not understood."""
    parts = [p for p in SPLIT.split(text or "") if p.strip()]
    if len(parts) != 2:
        return None, None, "Type it like: Tokyo > Seoul"
    o, d = resolve(parts[0]), resolve(parts[1])
    if not o:
        return None, None, "I don't know \"%s\". Try a bigger city or its airport code." % parts[0].strip()
    if not d:
        return None, None, "I don't know \"%s\". Try a bigger city or its airport code." % parts[1].strip()
    return o, d, None


def city_names():
    return sorted(n.title() for n in CITIES)
