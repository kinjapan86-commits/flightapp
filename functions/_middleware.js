// Password-protects the whole site. Set APP_PASSWORD as a secret in
// Cloudflare (Settings → Variables and Secrets). Any username works.
export async function onRequest({ request, env, next }) {
  const pw = env.APP_PASSWORD;
  if (!pw) {
    return new Response("Fare Log is locked until a password is set: in Cloudflare, add a secret named " +
      "APP_PASSWORD to this Pages project, then redeploy.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Basic ")) {
    let given = "";
    try { given = new TextDecoder().decode(Uint8Array.from(atob(auth.slice(6)), (c) => c.charCodeAt(0))).split(":").slice(1).join(":"); }
    catch { /* bad header */ }
    if (given.length === pw.length && crypto.subtle.timingSafeEqual(new TextEncoder().encode(given), new TextEncoder().encode(pw))) {
      return next();
    }
  }
  return new Response("Password needed", {
    status: 401, headers: { "WWW-Authenticate": 'Basic realm="Fare Log", charset="UTF-8"' },
  });
}
