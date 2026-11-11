/* 统一持久化层：SQLite（node:sqlite，零外部依赖）
 *
 * 为什么要换掉 JSON 文件：
 *  1) 崩溃安全：WAL 模式下写入原子提交，不会出现 tmp 文件写到一半的半截状态
 *  2) 并发友好：读写不互斥，家长端 / 孩子端 / MCP 同时写不再排队重写整份文件
 *  3) 审计可查询：audit 落表，tail 不用整文件读入
 *
 * 兼容设计：
 *  - 首次启动自动把旧 JSON（state/sessions/pin/auth/drafts/audit.jsonl）导入 DB，旧文件原地保留不删
 *  - 极旧 Node 没有 node:sqlite 时，自动降级为单文件 JSON 后端（storage.json + audit.jsonl），行为不变
 *
 * 对外接口（均为同步，调用方沿用原来的同步写模式）：
 *  get(key) / set(key, value) / del(key)   —— value 为任意可 JSON 化对象
 *  appendAudit(entry) / tailAudit(limit)
 *  backend 名称："sqlite" | "json"
 */
const fs = require("fs");
const path = require("path");

/* ---------- SQLite 后端 ---------- */
function createSqliteBackend(dbFile) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 4000;
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT, json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
  `);
  const getStmt = db.prepare("SELECT v FROM kv WHERE k = ?");
  const setStmt = db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)");
  const delStmt = db.prepare("DELETE FROM kv WHERE k = ?");
  const auditIns = db.prepare("INSERT INTO audit (ts, json) VALUES (?, ?)");
  const auditTail = db.prepare("SELECT json FROM audit ORDER BY id DESC LIMIT ?");
  return {
    name: "sqlite",
    get(k) {
      const row = getStmt.get(k);
      if (!row || row.v == null) return null;
      try { return JSON.parse(row.v); } catch (e) { return null; }
    },
    set(k, v) { setStmt.run(k, JSON.stringify(v)); },
    del(k) { delStmt.run(k); },
    appendAudit(entry) {
      try { auditIns.run(entry.ts || new Date().toISOString(), JSON.stringify(entry)); } catch (e) { /* 审计失败不阻断 */ }
    },
    tailAudit(limit) {
      try {
        return auditTail.all(Math.max(1, limit || 80)).map(r => { try { return JSON.parse(r.json); } catch (e) { return null; } }).filter(Boolean);
      } catch (e) { return []; }
    },
    close() { try { db.close(); } catch (e) {} }
  };
}

/* ---------- JSON 文件后端（降级用：极旧 Node 无 node:sqlite） ---------- */
function createJsonBackend(dataDir) {
  const file = path.join(dataDir, "storage.json");
  const auditFile = path.join(dataDir, "audit.jsonl");
  const loadAll = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return {}; } };
  return {
    name: "json",
    get(k) { return loadAll()[k] != null ? loadAll()[k] : null; },
    set(k, v) {
      const all = loadAll(); all[k] = v;
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(all));
      fs.renameSync(tmp, file);
    },
    del(k) { const all = loadAll(); delete all[k]; const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(all)); fs.renameSync(tmp, file); },
    appendAudit(entry) {
      try { fs.appendFileSync(auditFile, JSON.stringify(entry) + "\n"); } catch (e) { }
    },
    tailAudit(limit) {
      try {
        const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean);
        return lines.slice(-Math.max(1, limit || 80)).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      } catch (e) { return []; }
    },
    close() { }
  };
}

/* ---------- 旧 JSON 数据迁移（只在对应 key 不存在时执行，幂等） ---------- */
function migrateLegacy(backend, dataDir) {
  const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8")); } catch (e) { return null; } };
  const imported = [];

  if (backend.get("state") == null) {
    const raw = readJson("state.json");
    if (raw && raw.state) {
      backend.set("state", { version: raw.version || 0, state: raw.state });
      imported.push("state");
    }
  }
  if (backend.get("sessions") == null) {
    const raw = readJson("sessions.json");
    if (raw) {
      if (Array.isArray(raw.sessions)) backend.set("sessions", raw.sessions);
      if (raw.attempts) backend.set("attempts", raw.attempts);
      if (raw.pairing) backend.set("pairing", raw.pairing);
      imported.push("sessions");
    }
  }
  if (backend.get("pin") == null) {
    const raw = readJson("pin.json");
    if (raw && raw.hash) { backend.set("pin", raw); imported.push("pin"); }
  }
  if (backend.get("tokens") == null) {
    const raw = readJson("auth.json");
    if (raw && Array.isArray(raw.tokens)) { backend.set("tokens", raw.tokens); imported.push("tokens"); }
  }
  if (backend.get("drafts") == null) {
    const raw = readJson("drafts.json");
    if (raw) { backend.set("drafts", raw); imported.push("drafts"); }
  }
  /* 审计：仅在表为空时导入，避免重复 */
  if (backend.tailAudit(1).length === 0) {
    try {
      const lines = fs.readFileSync(path.join(dataDir, "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean);
      if (lines.length) {
        lines.forEach(l => { try { backend.appendAudit(JSON.parse(l)); } catch (e) { } });
        imported.push("audit(" + lines.length + ")");
      }
    } catch (e) { }
  }
  return imported;
}

class Storage {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbFile = path.join(dataDir, "hwbench.db");
    try {
      this.backend = createSqliteBackend(this.dbFile);
    } catch (e) {
      /* Node 过旧（无 node:sqlite）时降级为 JSON 后端，功能不受影响 */
      this.backend = createJsonBackend(dataDir);
    }
    this.imported = migrateLegacy(this.backend, dataDir);
  }
  get name() { return this.backend.name; }
  get(key) { return this.backend.get(key); }
  set(key, value) { this.backend.set(key, value); }
  del(key) { this.backend.del(key); }
  appendAudit(entry) { this.backend.appendAudit(entry); }
  tailAudit(limit) { return this.backend.tailAudit(limit); }
  close() { this.backend.close(); }
}

module.exports = { Storage };
