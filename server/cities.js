import { CITIES, AIRPORTS } from "./data.js";

const SPLIT = /\s*(?:>|->|→|\bto\b|–|—|\s-\s)\s*/i;
const title = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function resolve(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const key = t.toLowerCase();
  if (CITIES[key]) {
    const [codes, lat, lon] = CITIES[key];
    return { label: title(t), codes, lat, lon, city: title(t) };
  }
  const codes = t.split(",").map((c) => c.trim().toUpperCase());
  if (codes.every((c) => /^[A-Z]{3}$/.test(c))) {
    for (const [name, [cc, lat, lon]] of Object.entries(CITIES)) {
      if (cc.split(",").includes(codes[0])) {
        return { label: codes.join(","), codes: codes.join(","), lat, lon, city: title(name) };
      }
    }
    const [lat, lon] = AIRPORTS[codes[0]] || [null, null];
    return { label: codes.join(","), codes: codes.join(","), lat, lon, city: codes[0] };
  }
  return null;
}

export function parseRoute(text) {
  const parts = (text || "").split(SPLIT).filter((p) => p && p.trim());
  if (parts.length !== 2) return [null, null, "Type it like: Tokyo > Seoul"];
  const o = resolve(parts[0]), d = resolve(parts[1]);
  if (!o) return [null, null, `I don't know "${parts[0].trim()}". Try a bigger city or its airport code.`];
  if (!d) return [null, null, `I don't know "${parts[1].trim()}". Try a bigger city or its airport code.`];
  return [o, d, null];
}

export const cityNames = () => Object.keys(CITIES).map(title).sort();
