"""SQLite storage for searches, tracked flights and price snapshots."""
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone

DB_PATH = os.environ.get(
    "FLIGHT_APP_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "flights.db")
)

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS api_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    called_at TEXT NOT NULL,
    kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    params TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracked (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    params TEXT NOT NULL,          -- search params (origin, dest, dates, adults, bags)
    out_sig TEXT NOT NULL,         -- flight numbers of the outbound itinerary
    ret_sig TEXT,                  -- flight numbers of the return itinerary (round trip)
    summary TEXT NOT NULL,         -- JSON: legs, airline, times, for display
    check_every_days INTEGER NOT NULL DEFAULT 1,
    last_checked TEXT,
    last_error TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(params, out_sig, ret_sig)
);
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracked_id INTEGER NOT NULL REFERENCES tracked(id) ON DELETE CASCADE,
    checked_at TEXT NOT NULL,
    headline_price REAL,           -- the "from" price Google shows
    cheapest_total REAL,           -- cheapest all-in total across sites
    cheapest_site TEXT
);
CREATE TABLE IF NOT EXISTS site_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    site TEXT NOT NULL,
    fare REAL,
    bag_fee REAL,
    bag_source TEXT,               -- 'site' (reported by the site), 'table' (estimate), 'none'
    total REAL,
    notes TEXT,
    is_airline INTEGER NOT NULL DEFAULT 0
);
"""


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def connect():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


_conn = None


def db():
    global _conn
    if _conn is None:
        _conn = connect()
        _conn.executescript(SCHEMA)
        _conn.commit()
    return _conn


def execute(sql, args=()):
    with _lock:
        cur = db().execute(sql, args)
        db().commit()
        return cur


def query(sql, args=()):
    with _lock:
        return [dict(r) for r in db().execute(sql, args).fetchall()]


def query_one(sql, args=()):
    rows = query(sql, args)
    return rows[0] if rows else None


# ---- settings -------------------------------------------------------------

DEFAULT_SETTINGS = {
    "api_key": "",
    "currency": "JPY",
    "language": "en",
    "country": "jp",
    "home_airport": "HND,NRT",
}


def get_settings():
    s = dict(DEFAULT_SETTINGS)
    for row in query("SELECT key, value FROM settings"):
        s[row["key"]] = row["value"]
    if os.environ.get("SERPAPI_KEY"):
        s["api_key"] = os.environ["SERPAPI_KEY"]
    return s


def set_setting(key, value):
    execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


# ---- api usage ------------------------------------------------------------

def log_api_call(kind):
    execute("INSERT INTO api_calls(called_at, kind) VALUES(?, ?)", (now_iso(), kind))


def api_calls_this_month():
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    row = query_one("SELECT COUNT(*) AS n FROM api_calls WHERE called_at LIKE ?", (month + "%",))
    return row["n"] if row else 0


# ---- searches -------------------------------------------------------------

def save_search(params):
    p = json.dumps(params, sort_keys=True)
    execute("DELETE FROM searches WHERE params = ?", (p,))
    execute("INSERT INTO searches(created_at, params) VALUES(?, ?)", (now_iso(), p))


def recent_searches(limit=10):
    rows = query("SELECT * FROM searches ORDER BY id DESC LIMIT ?", (limit,))
    for r in rows:
        r["params"] = json.loads(r["params"])
    return rows
