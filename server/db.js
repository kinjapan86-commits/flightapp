// Storage in Cloudflare D1 (bound to this site as "DB"). Same tables as the Mac version.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS api_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, called_at TEXT NOT NULL, kind TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS searches (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, params TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tracked (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, params TEXT NOT NULL,
     out_sig TEXT NOT NULL, ret_sig TEXT, summary TEXT NOT NULL, check_every_days INTEGER NOT NULL DEFAULT 1,
     last_checked TEXT, last_error TEXT, active INTEGER NOT NULL DEFAULT 1, UNIQUE(params, out_sig, ret_sig))`,
  `CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, tracked_id INTEGER NOT NULL,
     checked_at TEXT NOT NULL, headline_price REAL, cheapest_total REAL, cheapest_site TEXT)`,
  `CREATE TABLE IF NOT EXISTS site_prices (id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_id INTEGER NOT NULL,
     site TEXT NOT NULL, fare REAL, bag_fee REAL, bag_source TEXT, total REAL, notes TEXT, is_airline INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, saved_at REAL NOT NULL, value TEXT NOT NULL)`,
];

const DEFAULT_SETTINGS = { api_key: "", currency: "JPY", language: "en", country: "jp" };
const CACHE_TTL = 6 * 3600 * 1000;

export function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
}

export class Store {
  constructor(d1) {
    if (!d1) throw new Error("The database isn't connected. In Cloudflare, bind your D1 database to this site with the name DB.");
    this.d1 = d1;
  }

  async init() {
    if (Store.ready) return;
    await this.d1.batch(SCHEMA.map((s) => this.d1.prepare(s)));
    Store.ready = true;
  }

  async query(sql, args = []) {
    const r = await this.d1.prepare(sql).bind(...args).all();
    return r.results || [];
  }

  async one(sql, args = []) {
    return (await this.d1.prepare(sql).bind(...args).first()) || null;
  }

  async run(sql, args = []) {
    const r = await this.d1.prepare(sql).bind(...args).run();
    return r.meta || {};
  }

  // ---- settings
  async settings() {
    const s = { ...DEFAULT_SETTINGS };
    for (const r of await this.query("SELECT key, value FROM settings")) s[r.key] = r.value;
    return s;
  }

  async setSetting(key, value) {
    await this.run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value]);
  }

  // ---- SerpApi usage
  async logApiCall(kind) {
    await this.run("INSERT INTO api_calls(called_at, kind) VALUES(?, ?)", [nowIso(), kind]);
  }

  async apiCallsThisMonth() {
    const month = new Date().toISOString().slice(0, 7);
    const r = await this.one("SELECT COUNT(*) AS n FROM api_calls WHERE called_at LIKE ?", [month + "%"]);
    return r ? r.n : 0;
  }

  // ---- recent searches
  async saveSearch(params) {
    const p = stableJson(params);
    await this.run("DELETE FROM searches WHERE params = ?", [p]);
    await this.run("INSERT INTO searches(created_at, params) VALUES(?, ?)", [nowIso(), p]);
  }

  async recentSearches(limit = 10) {
    const rows = await this.query("SELECT * FROM searches ORDER BY id DESC LIMIT ?", [limit]);
    return rows.map((r) => ({ ...r, params: JSON.parse(r.params) }));
  }

  // ---- cache (repeat searches within 6 hours are free)
  async cached(key, fn) {
    const row = await this.one("SELECT saved_at, value FROM cache WHERE key=?", [key]);
    if (row && Date.now() - row.saved_at < CACHE_TTL) return [JSON.parse(row.value), true];
    const v = await fn();
    await this.run("INSERT INTO cache(key, saved_at, value) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET " +
      "saved_at=excluded.saved_at, value=excluded.value", [key, Date.now(), JSON.stringify(v)]);
    return [v, false];
  }

  async clearCache(prefix = "") {
    await this.run("DELETE FROM cache WHERE key LIKE ?", [prefix + "%"]);
  }
}

export function stableJson(v) {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(", ") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ": " + stableJson(v[k])).join(", ") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}
