"""Small cache so repeating a search doesn't spend free API searches."""
import json
import time

import db

db.execute("""CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY, saved_at REAL NOT NULL, value TEXT NOT NULL)""")

TTL = 6 * 3600  # six hours


def get(key):
    row = db.query_one("SELECT saved_at, value FROM cache WHERE key=?", (key,))
    if row and time.time() - row["saved_at"] < TTL:
        return json.loads(row["value"])
    return None


def put(key, value):
    db.execute("INSERT INTO cache(key, saved_at, value) VALUES(?,?,?) "
               "ON CONFLICT(key) DO UPDATE SET saved_at=excluded.saved_at, value=excluded.value",
               (key, time.time(), json.dumps(value)))


def clear_prefix(prefix):
    db.execute("DELETE FROM cache WHERE key LIKE ?", (prefix + "%",))


def clear_all():
    db.execute("DELETE FROM cache")


def cached(key, fn):
    v = get(key)
    if v is not None:
        return v, True
    v = fn()
    put(key, v)
    return v, False
