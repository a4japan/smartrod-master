// SMART ROD Master — アクセスコード管理（Netlify Function v2）
// - 管理用パスワードは環境変数 SR_ADMIN_KEY に設定します（未設定なら管理画面は使えません）
// - /admin.html から呼び出し、コードの発行・一覧・回数追加・停止を行います
import { randomBytes, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

export const config = {
  path: "/api/admin",
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

function env(k) {
  try { if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(k); } catch (_) {}
  return process.env[k];
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const normCode = (c) => String(c || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 40);
// 読み間違えやすい文字（0/O, 1/I/L）を除いたコード（例: SR-K7QM-4XPA）
const ALPH = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newCode() {
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPH[b[i] % ALPH.length];
  return "SR-" + s.slice(0, 4) + "-" + s.slice(4);
}

function authorized(req) {
  const want = env("SR_ADMIN_KEY") || "";
  const got = req.headers.get("x-admin-key") || "";
  if (want.length < 8 || got.length !== want.length) return false;
  try { return timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (_) { return false; }
}

const toInt = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!env("SR_ADMIN_KEY")) return json({ error: "admin_not_configured" }, 500);
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);

  let body;
  try { body = await req.json(); } catch (_) { return json({ error: "bad_request" }, 400); }
  const store = getStore({ name: "sr-codes", consistency: "strong" });
  const action = body && body.action;

  if (action === "list") {
    const { blobs } = await store.list();
    const items = [];
    for (const b of blobs) {
      try { const v = await store.get(b.key, { type: "json" }); if (v) items.push(Object.assign({ code: b.key }, v)); } catch (_) {}
    }
    items.sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")));
    return json({ items });
  }

  if (action === "create") {
    const name = String(body.name || "").trim().slice(0, 80);
    const limit = Math.max(0, Math.min(10000, toInt(body.limit, 20)));
    if (!name) return json({ error: "name_required" }, 400);
    let code = body.code ? normCode(body.code) : "";
    if (code && code.length < 6) return json({ error: "code_too_short" }, 400);
    if (!code) {
      for (let i = 0; i < 5; i++) { code = newCode(); if (!(await store.get(code))) break; }
    } else if (await store.get(code)) {
      return json({ error: "code_exists" }, 409);
    }
    const rec = { name, limit, used: 0, active: true, note: String(body.note || "").slice(0, 200), created: new Date().toISOString() };
    await store.setJSON(code, rec);
    return json({ item: Object.assign({ code }, rec) });
  }

  if (action === "update") {
    const code = normCode(body.code);
    const cur = code ? await store.get(code, { type: "json" }) : null;
    if (!cur) return json({ error: "not_found" }, 404);
    const next = Object.assign({}, cur);
    if (body.addUses != null) next.limit = Math.max(0, Math.min(10000, (cur.limit || 0) + toInt(body.addUses, 0)));
    if (body.limit != null) next.limit = Math.max(0, Math.min(10000, toInt(body.limit, cur.limit || 0)));
    if (body.resetUsed === true) next.used = 0;
    if (typeof body.active === "boolean") next.active = body.active;
    if (body.name != null) next.name = String(body.name).trim().slice(0, 80) || cur.name;
    if (body.note != null) next.note = String(body.note).slice(0, 200);
    await store.setJSON(code, next);
    return json({ item: Object.assign({ code }, next) });
  }

  if (action === "delete") {
    const code = normCode(body.code);
    if (!code) return json({ error: "bad_request" }, 400);
    await store.delete(code);
    return json({ ok: true });
  }

  return json({ error: "bad_request" }, 400);
};
