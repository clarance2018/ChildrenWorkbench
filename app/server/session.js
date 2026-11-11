/* 服务端会话：PIN 校验、HttpOnly Cookie、角色作用域、孩子平板配对
 * 目标：把"前端 PIN 比对"换成服务端强制鉴权，且家长/孩子拿到不同权限的会话
 *  Cookie: hw_sid=<token>; HttpOnly; SameSite=Lax; Path=/（https 时加 Secure）
 * 持久化：经统一存储层（SQLite，见 server/storage.js），不再直接写 JSON 文件
 */
const crypto = require("crypto");

const COOKIE = "hw_sid";
const SCOPE_TTL = { parent: 30 * 86400000, child: 365 * 86400000 };
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60000;

function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function rand(bytes = 32) { return crypto.randomBytes(bytes).toString("hex"); }

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) {
      const k = p.slice(0, i).trim();
      try { out[k] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) { out[k] = p.slice(i + 1).trim(); }
    }
  });
  return out;
}

function cookieHeader(token, { ttlMs, secure }) {
  const maxAge = Math.floor(ttlMs / 1000);
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (secure ? "; Secure" : "");
}
function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

class Sessions {
  constructor(dataDir, { pinProvider, storage } = {}) {
    this.dir = dataDir;
    this.store = storage;                              // 统一存储层（SQLite）
    this.pinProvider = pinProvider || (() => "1234");  // 回退：从同步状态读取旧明文 PIN
    this.db = {
      sessions: storage.get("sessions") || [],
      attempts: storage.get("attempts") || {},
      pairing: storage.get("pairing") || null
    };
  }

  persist() {
    this.store.set("sessions", this.db.sessions);
    this.store.set("attempts", this.db.attempts);
    if (this.db.pairing) this.store.set("pairing", this.db.pairing);
    else this.store.del("pairing");
  }

  /* ---------- PIN（salt+sha256，经存储层） ---------- */
  _readPin() {
    const p = this.store.get("pin");
    return (p && p.hash && p.salt) ? p : null;
  }
  _writePin(pin) {
    const salt = rand(16);
    this.store.set("pin", { salt, hash: sha256(salt + pin), updated_at: new Date().toISOString() });
  }
  hasPin() { return !!this._readPin(); }
  /* 首次登录时把状态里的明文 PIN 迁移为哈希 */
  verifyPin(pin) {
    pin = String(pin || "").trim();
    if (!/^\d{4,8}$/.test(pin)) return false;
    const stored = this._readPin();
    if (stored) return sha256(stored.salt + pin) === stored.hash;
    if (pin !== String(this.pinProvider() || "1234")) return false;
    this._writePin(pin);
    return true;
  }
  changePin(oldPin, newPin) {
    if (!this.verifyPin(oldPin)) return { ok: false, error: "pin_wrong", message: "原 PIN 不正确" };
    newPin = String(newPin || "").trim();
    if (!/^\d{4,8}$/.test(newPin)) return { ok: false, error: "pin_invalid", message: "新 PIN 需为 4-8 位数字" };
    this._writePin(newPin);
    this.revokeAll("parent");
    return { ok: true };
  }

  /* ---------- 登录限流 ---------- */
  locked(ip) {
    const a = this.db.attempts[ip];
    return a && a.locked_until && Date.now() < a.locked_until ? Math.ceil((a.locked_until - Date.now()) / 60000) : 0;
  }
  fail(ip) {
    const a = this.db.attempts[ip] || { fails: 0, first: Date.now(), locked_until: 0 };
    if (Date.now() - a.first > LOCK_MS) { a.fails = 0; a.first = Date.now(); }
    a.fails += 1;
    if (a.fails >= MAX_FAILS) { a.locked_until = Date.now() + LOCK_MS; a.fails = 0; a.first = Date.now(); }
    this.db.attempts[ip] = a;
    this.persist();
    return MAX_FAILS - a.fails > 0 ? MAX_FAILS - a.fails : 0;
  }
  ok(ip) { delete this.db.attempts[ip]; this.persist(); }

  /* ---------- 会话 ---------- */
  create({ scope = "parent", label = "", ip = "", ttlMs }) {
    const token = "hw_s_" + rand(24);
    const ttl = ttlMs || SCOPE_TTL[scope] || SCOPE_TTL.parent;
    const s = {
      id: "ses_" + rand(6), hash: sha256(token), scope, label: label || (scope === "parent" ? "家长设备" : "孩子平板"),
      created_at: new Date().toISOString(), last_seen: new Date().toISOString(),
      expires_at: new Date(Date.now() + ttl).toISOString(), ip
    };
    this.db.sessions.push(s);
    this.db.sessions = this.db.sessions.filter(x => new Date(x.expires_at) > new Date());
    this.persist();
    return { token, session: s, ttlMs: ttl };
  }

  verify(token) {
    if (!token) return null;
    const h = sha256(token);
    const s = this.db.sessions.find(x => x.hash === h);
    if (!s) return null;
    if (new Date(s.expires_at) <= new Date()) { this.revoke(s.id); return null; }
    /* last_seen 每 5 分钟落盘一次，避免频繁写文件 */
    const last = new Date(s.last_seen).getTime();
    if (Date.now() - last > 300000) { s.last_seen = new Date().toISOString(); this.persist(); }
    return s;
  }

  fromRequest(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE] ||
      (String(req.headers.authorization || "").match(/^Bearer\s+(hw_s_[A-Za-z0-9]+)$/i) || [])[1];
    return this.verify(token);
  }

  revoke(id) {
    const before = this.db.sessions.length;
    this.db.sessions = this.db.sessions.filter(s => s.id !== id);
    this.persist();
    return this.db.sessions.length < before;
  }
  revokeAll(scope) {
    this.db.sessions = this.db.sessions.filter(s => s.scope !== scope);
    this.persist();
  }
  list() {
    return this.db.sessions.map(({ hash, ...rest }) => rest);
  }

  /* ---------- 孩子平板配对 ---------- */
  createPairing(ttlMs = 10 * 60000) {
    const code = String(crypto.randomInt(100000, 1000000));
    this.db.pairing = { code_hash: sha256(code), expires_at: new Date(Date.now() + ttlMs).toISOString(), used_at: null };
    this.persist();
    return { code, expires_at: this.db.pairing.expires_at };
  }
  consumePairing(code, label, ip) {
    const p = this.db.pairing;
    if (!p || p.used_at) return { ok: false, error: "no_pairing", message: "配对码已失效，请在家长端重新生成" };
    if (new Date(p.expires_at) <= new Date()) return { ok: false, error: "pairing_expired", message: "配对码已过期" };
    if (sha256(String(code || "").trim()) !== p.code_hash) return { ok: false, error: "code_wrong", message: "配对码不正确" };
    p.used_at = new Date().toISOString();
    const created = this.create({ scope: "child", label: label || "孩子平板", ip });
    this.persist();
    return { ok: true, token: created.token, ttlMs: created.ttlMs, session: created.session };
  }

  cleanup() {
    const n = this.db.sessions.length;
    this.db.sessions = this.db.sessions.filter(s => new Date(s.expires_at) > new Date());
    if (this.db.pairing && new Date(this.db.pairing.expires_at) < new Date(Date.now() - 3600000)) this.db.pairing = null;
    if (this.db.sessions.length !== n) this.persist();
  }
}

module.exports = { Sessions, parseCookies, cookieHeader, clearCookie, COOKIE };
