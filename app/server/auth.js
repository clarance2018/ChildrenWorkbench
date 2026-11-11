/* API Token 与权限域
 * 设计参照 Yuvomi：无状态 /mcp + Bearer Token + 按模块裁剪作用域
 * 与 Yuvomi 的差异：Token 密文只在创建时返回一次；AI 创建任务默认进草稿队列
 * 持久化：经统一存储层（SQLite，见 server/storage.js），审计落表可查询
 */
const crypto = require("crypto");

const MODULES = ["tasks", "habits", "timetable", "notes", "review", "import", "report", "settings"];
const SCOPES = [];
MODULES.forEach(m => { SCOPES.push(m + ":read", m + ":write"); });

const PRESETS = {
  assistant: {
    label: "家长助手（推荐）",
    desc: "可创建作业与习惯、写当天备注、查课表与完成情况；不能修改孩子设置",
    scopes: ["tasks:read","tasks:write","habits:read","habits:write","timetable:read","notes:read","notes:write","import:write","report:read","review:read"]
  },
  full: {
    label: "完全管理",
    desc: "包含退回任务与修改课表等全部权限，仅建议可信客户端使用",
    scopes: ["*"]
  },
  readonly: {
    label: "只读查询",
    desc: "只能查询任务、课表与完成情况，适合做总结或问答",
    scopes: ["tasks:read","habits:read","timetable:read","notes:read","report:read","review:read"]
  }
};

const RATE_LIMIT = 120;          // 每分钟每 Token 请求上限
const RATE_WINDOW = 60 * 1000;

class Auth {
  constructor(dataDir, { storage } = {}) {
    this.dataDir = dataDir;
    this.store = storage;
    this.buckets = new Map();
    this.tokens = storage.get("tokens") || [];
  }

  _persist() {
    this.store.set("tokens", this.tokens);
  }

  list() {
    return this.tokens.map(t => ({
      id: t.id, name: t.name, prefix: t.prefix, scopes: t.scopes, mode: t.mode,
      created_at: t.created_at, last_used_at: t.last_used_at || null,
      expires_at: t.expires_at || null, revoked_at: t.revoked_at || null,
      calls: t.calls || 0, preset: t.preset || "custom"
    }));
  }

  create({ name, scopes, mode, preset, ttlDays }) {
    const secret = "hwb_" + crypto.randomBytes(20).toString("hex");
    const token = {
      id: "tok_" + crypto.randomBytes(6).toString("hex"),
      name: (name || "AI 助手").slice(0, 40),
      prefix: secret.slice(0, 12),
      hash: crypto.createHash("sha256").update(secret).digest("hex"),
      scopes: normalizeScopes(scopes),
      mode: mode === "direct" ? "direct" : "draft",
      preset: preset || "custom",
      created_at: new Date().toISOString(),
      last_used_at: null,
      expires_at: ttlDays ? new Date(Date.now() + Number(ttlDays) * 86400000).toISOString() : null,
      revoked_at: null,
      calls: 0
    };
    this.tokens.push(token);
    this._persist();
    return { token: secret, meta: this.list().find(t => t.id === token.id) };
  }

  revoke(id) {
    const t = this.tokens.find(x => x.id === id);
    if (!t) return false;
    t.revoked_at = new Date().toISOString();
    this._persist();
    return true;
  }

  /* 从请求中提取明文 Token：兼容 Yuvomi 的三种头 + query 兜底 */
  static extract(req, url) {
    const h = req.headers["authorization"] || "";
    if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
    if (req.headers["x-api-key"]) return String(req.headers["x-api-key"]).trim();
    if (req.headers["api-key"]) return String(req.headers["api-key"]).trim();
    if (url && url.searchParams.get("token")) return url.searchParams.get("token").trim();
    return "";
  }

  authenticate(req, url) {
    const secret = Auth.extract(req, url);
    if (!secret) return { ok: false, code: 401, error: "missing_token", message: "缺少 API Token，请在请求头加入 Authorization: Bearer <token>" };
    const hash = crypto.createHash("sha256").update(secret).digest("hex");
    const token = this.tokens.find(t => t.hash === hash);
    if (!token) return { ok: false, code: 401, error: "invalid_token", message: "Token 无效或已删除" };
    if (token.revoked_at) return { ok: false, code: 401, error: "revoked", message: "Token 已吊销" };
    if (token.expires_at && Date.now() > new Date(token.expires_at).getTime()) {
      return { ok: false, code: 401, error: "expired", message: "Token 已过期，请在家长后台重新生成" };
    }
    if (this._limited(token.id)) return { ok: false, code: 429, error: "rate_limited", message: "请求过于频繁（每分钟上限 120 次）" };

    token.last_used_at = new Date().toISOString();
    token.calls = (token.calls || 0) + 1;
    this._persist();
    return { ok: true, token };
  }

  _limited(id) {
    const now = Date.now();
    const arr = (this.buckets.get(id) || []).filter(t => now - t < RATE_WINDOW);
    arr.push(now);
    this.buckets.set(id, arr);
    return arr.length > RATE_LIMIT;
  }
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length) return ["tasks:read"];
  if (scopes.includes("*")) return ["*"];
  return scopes.filter(s => SCOPES.includes(s));
}

/* 写权限隐含读权限 */
function hasScope(token, scope) {
  if (!token) return false;
  const list = token.scopes || [];
  if (list.includes("*")) return true;
  if (list.includes(scope)) return true;
  if (/:read$/.test(scope)) {
    return list.includes(scope.replace(":read", ":write"));
  }
  return false;
}

function scopeLabel(scope) {
  if (scope === "*") return "全部权限";
  const [m, a] = scope.split(":");
  const names = { tasks:"任务", habits:"习惯", timetable:"课表", notes:"当天备注", review:"复核", import:"文本导入", report:"统计", settings:"设置" };
  return (names[m] || m) + (a === "write" ? "（读写）" : "（只读）");
}

/* 审计日志：写入统一存储层（SQLite 表），读取最近 N 条 */
class Audit {
  constructor(dataDir, { storage } = {}) {
    this.store = storage;
  }
  append(entry) { this.store.appendAudit(entry); }
  tail(limit = 80) { return this.store.tailAudit(limit); }
}

module.exports = { Auth, Audit, hasScope, scopeLabel, SCOPES, MODULES, PRESETS };
