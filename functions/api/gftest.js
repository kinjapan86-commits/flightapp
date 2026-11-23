// Temporary test: can Cloudflare fetch Google Flights prices? Remove once checked.
export async function onRequestGet() {
  const url = "https://www.google.com/travel/flights/search?tfs=GhoSCjIwMjYtMTItMTVqBRIDTlJUcgUSA0lDTkIBAUgBmAEC&hl=en&curr=JPY";
  const t0 = Date.now();
  const res = await fetch(url, { headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": "CONSENT=YES+cb.20230810-00-p0.en+FX+874; SOCS=CAISHAgCEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiA_LyaBg",
  }});
  const html = await res.text();
  const m = html.match(/<script[^>]*class="ds:1"[^>]*>([\s\S]*?)<\/script>/);
  let flights = 0, first = null;
  if (m) {
    const d = m[1].split("data:")[1]; const p = JSON.parse(d.slice(0, d.lastIndexOf(",")));
    const all = [...((p[2] && p[2][0]) || []), ...((p[3] && p[3][0]) || [])];
    flights = all.length; first = all[0] ? [all[0][0][2][0][22], all[0][1][0][1]] : null;
  }
  return Response.json({ status: res.status, ms: Date.now() - t0, bytes: html.length, hasData: !!m, flights, first,
    sample: m ? null : html.slice(0, 300) });
}
