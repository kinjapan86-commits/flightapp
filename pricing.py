"""Turn each site's headline fare into an all-in total.

Google's booking options give each site's fare with taxes included. Bags are
the usual surprise, so:
  1. If the site lists a checked-bag price (or says one is free), use it.
  2. Otherwise use the editable table in bag_fees.json (marked as an estimate).
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
BAG_FILE = os.path.join(HERE, "bag_fees.json")

NUM = re.compile(r"(\d[\d,]*(?:\.\d+)?)")


def load_bag_table():
    with open(BAG_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_bag_table(table):
    with open(BAG_FILE, "w", encoding="utf-8") as f:
        json.dump(table, f, ensure_ascii=False, indent=2)


def _parse_bag_text(lines):
    """Return per-bag fee from a site's baggage lines, 0 if free, None if unknown."""
    for line in lines or []:
        l = line.lower()
        if "checked" not in l:
            continue
        if "free" in l or "included" in l:
            return 0.0
        m = NUM.search(line.split(":")[-1])
        if m:
            return float(m.group(1).replace(",", ""))
    return None


def table_fee(airline, table):
    if not airline:
        return float(table.get("unknown_airline", 0)), "table"
    for name in table.get("full_service_included", []):
        if name.lower() in airline.lower():
            return 0.0, "table"
    for name, fee in table.get("airlines", {}).items():
        if name.lower() in airline.lower():
            return float(fee), "table"
    return float(table.get("unknown_airline", 0)), "table"


def _one(site, fare, bag_lines, airline, bags, adults, legs, table, is_airline, extras):
    per_bag = _parse_bag_text(bag_lines)
    source = "site"
    if per_bag is None:
        per_bag, source = table_fee(airline, table)
    bag_fee = per_bag * bags * adults * legs if bags else 0.0
    if not bags:
        source = "none"
    notes = []
    if bags:
        if source == "site":
            notes.append("bag price from %s" % site if per_bag else "checked bag included")
        else:
            notes.append("bag fee estimated" if per_bag else "bag usually included")
    notes.extend(extras)
    return {
        "site": site,
        "fare": fare,
        "bag_fee": bag_fee,
        "bag_source": source,
        "total": (fare or 0) + bag_fee if fare is not None else None,
        "notes": "; ".join(notes),
        "is_airline": 1 if is_airline else 0,
        "bag_lines": bag_lines or [],
    }


def all_in_prices(booking_options, airline, bags, adults, round_trip):
    table = load_bag_table()
    legs = 2 if round_trip else 1
    rows = []
    for opt in booking_options:
        if opt.get("together"):
            t = opt["together"]
            extras = [e for e in (t.get("extensions") or []) if isinstance(e, str)][:2]
            rows.append(_one(
                t.get("book_with", "?"), t.get("price"), t.get("baggage_prices"),
                airline, bags, adults, legs, table, t.get("airline"), extras))
        elif opt.get("separate_tickets") or opt.get("departing"):
            dep, ret = opt.get("departing") or {}, opt.get("returning") or {}
            if dep.get("price") is None or ret.get("price") is None:
                continue
            site = "%s + %s" % (dep.get("book_with", "?"), ret.get("book_with", "?"))
            fare = dep["price"] + ret["price"]
            lines = (dep.get("baggage_prices") or []) or (ret.get("baggage_prices") or [])
            rows.append(_one(site, fare, lines, airline, bags, adults, legs, table, False,
                             ["two separate tickets"]))
    rows = [r for r in rows if r["fare"] is not None]
    rows.sort(key=lambda r: r["total"])
    return rows
