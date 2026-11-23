"""Saved flights: record prices. Prices are only looked up when you search
(or press "Check now"); nothing runs in the background."""
import json
import threading
import time
from datetime import date, datetime, timedelta, timezone

import cache
import db
import pricing
import providers


def _airline(itin):
    legs = itin.get("flights") or []
    return legs[0].get("airline") if legs else None


def _summary(itin):
    legs = itin.get("flights") or []
    if not legs:
        return {}
    return {
        "airline": legs[0].get("airline"),
        "airline_logo": itin.get("airline_logo") or legs[0].get("airline_logo"),
        "flight_numbers": [l.get("flight_number") for l in legs],
        "from": legs[0]["departure_airport"].get("id"),
        "to": legs[-1]["arrival_airport"].get("id"),
        "depart": legs[0]["departure_airport"].get("time"),
        "arrive": legs[-1]["arrival_airport"].get("time"),
        "stops": len(legs) - 1,
        "duration": itin.get("total_duration"),
    }


def record(params, outbound, inbound, booking_options, headline_price):
    """Save (or find) the tracked flight and store a price snapshot."""
    pkey = json.dumps({k: params[k] for k in ("origin", "dest", "out_date", "ret_date", "adults", "bags")},
                      sort_keys=True)
    out_sig = providers.flight_sig(outbound)
    ret_sig = providers.flight_sig(inbound) if inbound else ""
    row = db.query_one("SELECT id FROM tracked WHERE params=? AND out_sig=? AND ret_sig=?",
                       (pkey, out_sig, ret_sig))
    if row:
        tid = row["id"]
        db.execute("UPDATE tracked SET active=1 WHERE id=?", (tid,))
    else:
        summary = {"out": _summary(outbound), "ret": _summary(inbound) if inbound else None,
                   "route_label": params.get("route_label")}
        tid = db.execute(
            "INSERT INTO tracked(created_at, params, out_sig, ret_sig, summary) VALUES(?,?,?,?,?)",
            (db.now_iso(), pkey, out_sig, ret_sig, json.dumps(summary))).lastrowid
    rows = pricing.all_in_prices(booking_options, _airline(outbound), int(params.get("bags", 0)),
                                 int(params.get("adults", 1)), bool(params.get("ret_date")))
    _snapshot(tid, headline_price, rows)
    return tid, rows


def _snapshot(tid, headline_price, rows):
    cheapest = rows[0] if rows else None
    sid = db.execute(
        "INSERT INTO snapshots(tracked_id, checked_at, headline_price, cheapest_total, cheapest_site) "
        "VALUES(?,?,?,?,?)",
        (tid, db.now_iso(), headline_price, cheapest["total"] if cheapest else None,
         cheapest["site"] if cheapest else None)).lastrowid
    for r in rows:
        db.execute(
            "INSERT INTO site_prices(snapshot_id, site, fare, bag_fee, bag_source, total, notes, is_airline) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (sid, r["site"], r["fare"], r["bag_fee"], r["bag_source"], r["total"], r["notes"],
             r["is_airline"]))
    db.execute("UPDATE tracked SET last_checked=?, last_error=NULL WHERE id=?", (db.now_iso(), tid))


def refresh(tid, full=True):
    """Look the saved flight up again and record today's prices.

    full=True compares every site (uses SerpApi searches when a key is saved).
    full=False is the free daily check: Google Flights' lowest price only."""
    t = db.query_one("SELECT * FROM tracked WHERE id=?", (tid,))
    if not t:
        raise ValueError("No such saved flight")
    params = json.loads(t["params"])
    prov = providers.get_provider() if full else providers.get_free_provider()
    if full:
        cache.clear_prefix("search:")  # make sure SerpApi is asked fresh
    try:
        res = prov.search(params)
        match = next((f for f in res["flights"] if providers.flight_sig(f) == t["out_sig"]), None)
        if not match:
            raise providers.ProviderError("This flight isn't listed any more (sold out or schedule change).")
        inbound = None
        token = match.get("booking_token")
        headline = match.get("price")
        if t["ret_sig"] and prov.name == "free":
            # Google's round-trip price for this outbound; no extra lookup needed.
            token = match["departure_token"]
        elif t["ret_sig"]:
            rets = prov.returns(params, match["departure_token"])["flights"]
            inbound = next((f for f in rets if providers.flight_sig(f) == t["ret_sig"]), None)
            if not inbound:
                raise providers.ProviderError("The return flight isn't listed any more.")
            token = inbound.get("booking_token")
            headline = inbound.get("price", headline)
        opts = prov.booking_options(params, token)
        rows = pricing.all_in_prices(opts, _airline(match), int(params.get("bags", 0)),
                                     int(params.get("adults", 1)), bool(params.get("ret_date")))
        _snapshot(tid, headline, rows)
        cache.clear_prefix("search:")
        return rows
    except providers.ProviderError as e:
        db.execute("UPDATE tracked SET last_checked=?, last_error=? WHERE id=?",
                   (db.now_iso(), str(e), tid))
        raise


def update_from_search(params, flights):
    """A search just ran: add today's price to any saved flight it covers. Costs nothing extra."""
    keys = ("origin", "dest", "out_date", "ret_date", "adults")
    for t in db.query("SELECT * FROM tracked WHERE active=1"):
        tp = json.loads(t["params"])
        if any(tp.get(k) != params.get(k) for k in keys):
            continue
        match = next((f for f in flights if providers.flight_sig(f) == t["out_sig"]), None)
        if not match or not match.get("price"):
            continue
        opts = [{"together": {"book_with": "Google Flights (lowest price)", "price": match["price"],
                              "baggage_prices": [], "extensions": ["from your search"]}}]
        rows = pricing.all_in_prices(opts, _airline(match), int(tp.get("bags", 0)),
                                     int(tp.get("adults", 1)), bool(tp.get("ret_date")))
        _snapshot(t["id"], match["price"], rows)


def list_tracked():
    rows = db.query("SELECT * FROM tracked WHERE active=1 ORDER BY id DESC")
    out = []
    for t in rows:
        snaps = db.query(
            "SELECT checked_at, headline_price, cheapest_total, cheapest_site FROM snapshots "
            "WHERE tracked_id=? ORDER BY id", (t["id"],))
        out.append(_shape(t, snaps))
    return out


def _shape(t, snaps):
    params = json.loads(t["params"])
    first = snaps[0]["cheapest_total"] if snaps else None
    last = snaps[-1]["cheapest_total"] if snaps else None
    totals = [s["cheapest_total"] for s in snaps if s["cheapest_total"] is not None]
    return {
        "id": t["id"],
        "params": params,
        "summary": json.loads(t["summary"]),
        "check_every_days": t["check_every_days"],
        "last_checked": t["last_checked"],
        "last_error": t["last_error"],
        "latest_total": last,
        "latest_site": snaps[-1]["cheapest_site"] if snaps else None,
        "change": (last - first) if (first is not None and last is not None) else None,
        "low": min(totals) if totals else None,
        "high": max(totals) if totals else None,
        "history": snaps,
        "departed": params.get("out_date", "9999") < date.today().isoformat(),
    }


def detail(tid):
    t = db.query_one("SELECT * FROM tracked WHERE id=?", (tid,))
    if not t:
        return None
    snaps = db.query("SELECT * FROM snapshots WHERE tracked_id=? ORDER BY id", (tid,))
    out = _shape(t, snaps)
    latest = snaps[-1]["id"] if snaps else None
    out["latest_sites"] = db.query(
        "SELECT site, fare, bag_fee, bag_source, total, notes, is_airline FROM site_prices "
        "WHERE snapshot_id=? ORDER BY total", (latest,)) if latest else []
    # Per-site history, for the chart.
    series = {}
    for s in snaps:
        for sp in db.query("SELECT site, total FROM site_prices WHERE snapshot_id=?", (s["id"],)):
            series.setdefault(sp["site"], []).append([s["checked_at"], sp["total"]])
    out["site_history"] = series
    return out


def remove(tid):
    db.execute("UPDATE tracked SET active=0 WHERE id=?", (tid,))


def set_frequency(tid, days):
    db.execute("UPDATE tracked SET check_every_days=? WHERE id=?", (max(1, int(days)), tid))


# ---- background checks ------------------------------------------------------

def due():
    now = datetime.now(timezone.utc)
    today = date.today().isoformat()
    out = []
    for t in db.query("SELECT * FROM tracked WHERE active=1"):
        params = json.loads(t["params"])
        if params.get("out_date", "9999") < today:
            continue
        if not t["last_checked"]:
            out.append(t["id"])
            continue
        last = datetime.fromisoformat(t["last_checked"])
        # Small slack so a "daily" check doesn't drift later each day.
        if now - last >= timedelta(days=t["check_every_days"]) - timedelta(minutes=30):
            out.append(t["id"])
    return out


def run_due_checks(log=print):
    for tid in due():
        try:
            refresh(tid, full=False)
            log("Checked saved flight %s (free Google Flights check)" % tid)
        except Exception as e:
            log("Saved flight %s: %s" % (tid, e))
        time.sleep(2)


def start_background(interval_seconds=1800, log=print):
    def loop():
        time.sleep(20)
        while True:
            try:
                run_due_checks(log)
            except Exception as e:
                log("Background check failed: %s" % e)
            time.sleep(interval_seconds)
    th = threading.Thread(target=loop, daemon=True)
    th.start()
    return th
