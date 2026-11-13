// Plaid (SANDBOX ONLY) via plain fetch. Secrets: env.PLAID_CLIENT_ID / env.PLAID_SECRET.
const BASE = "https://sandbox.plaid.com";
const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TTL = 60 * 60 * 24 * 30;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PlaidError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function plaid(env, path, payload) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...payload }),
    });
  } catch { throw new PlaidError("NETWORK"); }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || !data) throw new PlaidError(String(data?.error_code || "HTTP_" + res.status));
  return data;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > 4096) return null;
  try { const b = JSON.parse(text); return b && typeof b === "object" ? b : null; } catch { return null; }
}

const kvKey = (session) => "plaid:" + session;

export async function handlePlaid(request, env, pathname) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (env.PLAID_ENV !== "sandbox") return json({ error: "Plaid is restricted to sandbox" }, 503);
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET || !env.PLAID_KV) return json({ error: "Plaid not configured" }, 503);
  const body = await readBody(request);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  const session = typeof body.session === "string" ? body.session : "";
  if (!SESSION_RE.test(session)) return json({ error: "Invalid session" }, 400);

  try {
    if (pathname === "/api/plaid/link-token") {
      const d = await plaid(env, "/link/token/create", {
        client_name: "Cortex",
        language: "en",
        country_codes: ["US"],
        products: ["transactions"],
        user: { client_user_id: (await sha256Hex(session)).slice(0, 40) },
      });
      return json({ link_token: d.link_token });
    }

    if (pathname === "/api/plaid/exchange") {
      const pt = typeof body.public_token === "string" ? body.public_token : "";
      if (!/^public-sandbox-[A-Za-z0-9-]{8,100}$/.test(pt)) return json({ error: "Invalid public_token" }, 400);
      const d = await plaid(env, "/item/public_token/exchange", { public_token: pt });
      await env.PLAID_KV.put(kvKey(session), JSON.stringify({ access_token: d.access_token }), { expirationTtl: TTL });
      return json({ ok: true });
    }

    if (pathname === "/api/plaid/transactions") {
      const rec = await env.PLAID_KV.get(kvKey(session), "json");
      if (!rec?.access_token) return json({ error: "No bank connected for this session" }, 404);
      const cutoff = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
      const out = [];
      let cursor, attempts = 0;
      for (let page = 0; page < 20; page++) {
        let d;
        try {
          d = await plaid(env, "/transactions/sync", { access_token: rec.access_token, count: 500, ...(cursor ? { cursor } : {}) });
          if (!cursor && d.transactions_update_status !== "HISTORICAL_UPDATE_COMPLETE" && !(d.added || []).length) throw new PlaidError("PRODUCT_NOT_READY");
        } catch (e) {
          if (e.code === "PRODUCT_NOT_READY" && attempts < 4) { await sleep(1000 * 2 ** attempts++); page--; continue; }
          throw e;
        }
        for (const t of d.added || []) {
          if (t.amount < 0 && !t.pending && t.date >= cutoff) {
            out.push({ date: t.date, amount: Math.round(-t.amount * 100) / 100, name: String(t.merchant_name || t.name || "").slice(0, 120) });
          }
        }
        cursor = d.next_cursor;
        if (!d.has_more) break;
      }
      return json({ transactions: out.slice(0, 500) });
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (e.code === "PRODUCT_NOT_READY") return json({ error: "Bank data is still being prepared, try again in a moment" }, 503);
    return json({ error: "Plaid request failed" }, 502);
  }
}

