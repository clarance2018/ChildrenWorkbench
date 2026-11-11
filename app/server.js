/* 儿童作业与习惯工作台 · 轻量后端（Node 原生，无第三方依赖）
 * ① 状态同步（按实体合并，避免两端互相覆盖） ② 录音/照片文件存储
 * ③ 服务端会话鉴权（PIN → HttpOnly Cookie，家长/孩子不同作用域）
 * ④ REST /api/v1 ⑤ MCP /mcp ⑥ 静态托管
 * ⑦ 持久化：SQLite（node:sqlite，WAL）统一存储层，首启自动迁移旧 JSON
 * 启动：node server.js
 *   本机：http://127.0.0.1:8900
 *   平板：https://<局域网IP>:8443（自签名证书，首次需信任）
 *   可用 DATA_DIR 环境变量指定数据目录（默认 app/data，测试用）
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { Auth, Audit } = require("./server/auth");
const { createService } = require("./server/service");
const { createApi } = require("./server/api");
const { createMcp } = require("./server/mcp");
const { Sessions, cookieHeader, clearCookie } = require("./server/session");
const { mergeStates } = require("./server/merge");
const { ensureCert, lanIPs, displayIPs } = require("./server/tls");
const { scheduleDaily, listBackups } = require("./server/backup");

const PORT = parseInt(process.env.PORT || "8900", 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || "8443", 10);
const HOST = process.env.HOST || "0.0.0.0";
const TLS_ON = process.env.TLS !== "0";
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const REC_DIR = path.join(DATA_DIR, "recordings");
const PHOTO_DIR = path.join(DATA_DIR, "photos");
const TMP_DIR = path.join(DATA_DIR, "tmp");

[REC_DIR, PHOTO_DIR, TMP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

/* ---------- 统一存储层：SQLite（WAL），旧 JSON 首启自动迁移 ---------- */
const { Storage } = require("./server/storage");
const storage = new Storage(DATA_DIR);

let state = null, version = 0;
{
  const saved = storage.get("state");
  if (saved && saved.state) { state = saved.state; version = saved.version || 0; }
}

function persist() {
  if (!state) state = EMPTY_STATE;
  version += 1;
  storage.set("state", { version, state });   // SQLite WAL：原子提交，崩溃不留半截状态
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon",
  ".webm": "audio/webm", ".mp4": "audio/mp4", ".ogg": "audio/ogg", ".m4a": "audio/mp4"
};
const AUDIO_EXT = { "audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/wav": "wav" };
const IMAGE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function send(res, code, body, type, extra) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, Object.assign({
    "Content-Type": type || "application/json; charset=utf-8",
    "Content-Length": buf.length, "Cache-Control": "no-store"
  }, extra || {}));
  res.end(buf);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("payload_too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJSON(req, limit) {
  try {
    const raw = await readBody(req, limit || 64 * 1024);
    return raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch (e) { return null; }
}
const clientIP = req => String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");

const auth = new Auth(DATA_DIR, { storage });
const audit = new Audit(DATA_DIR, { storage });
/* 服务端首次启动、Web 端尚未写入种子时，给 MCP 一个可用的空状态，避免读写报错 */
const EMPTY_STATE = {
  schema_version: 2,
  settings: { gradeMode: 1, pinyin: true, role: "admin", parent_pin: "1234", sound: true },
  child: { id: "child_1", name: "小宝" },
  tasks: [], periodRules: [], templates: [], habits: [], deleted: [],
  timetable: { 1:{subjects:[],notes:""},2:{subjects:[],notes:""},3:{subjects:[],notes:""},4:{subjects:[],notes:""},5:{subjects:[],notes:""},6:{subjects:[],notes:""},7:{subjects:[],notes:""} },
  timetableOverrides: {}, notes: {}, recordings: {},
  points: { total: 0, log: [] }, streak: { days: 0, lastDate: null }
};
const getState = () => state || EMPTY_STATE;
const save = () => { if (!state) state = EMPTY_STATE; persist(); };   // persist() 内含 version+1

const sessions = new Sessions(DATA_DIR, { pinProvider: () => (getState().settings || {}).parent_pin, storage });

const service = createService({ getState, save, dataDir: DATA_DIR, storage });

let currentHost = "";
const publicBase = () => process.env.PUBLIC_BASE || ("http://" + (currentHost || `127.0.0.1:${PORT}`));

const api = createApi({ service, auth, audit, send, readBody, getState, save, publicBase });
const mcp = createMcp({ service, auth, audit, send, readBody, publicBase });

/* ---------- 鉴权 ---------- */
const isSecure = req => !!req.socket.encrypted;
const isLocalHost = host => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(host || ""));

/* 会话鉴权：返回 {ok, session} */
function requireSession(req, scope) {
  const s = sessions.fromRequest(req);
  if (!s) return { ok: false, code: 401, error: "auth_required", message: "需要先登录" };
  if (scope === "parent" && s.scope !== "parent") {
    return { ok: false, code: 403, error: "forbidden", message: "该设备为孩子端，无家长权限" };
  }
  return { ok: true, session: s };
}

function setSession(res, token, ttlMs, secure) {
  res.setHeader("Set-Cookie", cookieHeader(token, { ttlMs, secure }));
}

/* ---------- 会话接口 ---------- */
async function handleAuth(req, res, url) {
  const p = url.pathname;
  const ip = clientIP(req);

  if (p === "/api/auth/me" && req.method === "GET") {
    const s = sessions.fromRequest(req);
    if (!s) return send(res, 200, { ok: false, auth_required: true, secure: isSecure(req) });
    return send(res, 200, {
      ok: true, scope: s.scope, label: s.label, session_id: s.id,
      expires_at: s.expires_at, secure: isSecure(req)
    });
  }

  if (p === "/api/auth/pin" && req.method === "POST") {
    const lock = sessions.locked(ip);
    if (lock) return send(res, 429, { ok: false, error: "locked", message: `尝试过多，请 ${lock} 分钟后再试` });
    const body = await readJSON(req, 4096);
    if (!body) return send(res, 400, { ok: false, error: "bad_json" });
    if (!sessions.verifyPin(body.pin)) {
      const left = sessions.fail(ip);
      audit.append({ ts: new Date().toISOString(), ip, channel: "ui", action: "auth.pin_fail", ok: false });
      return send(res, 401, { ok: false, error: "pin_wrong", message: left ? `PIN 不正确，还可尝试 ${left} 次` : "尝试过多，已锁定 15 分钟" });
    }
    sessions.ok(ip);
    const created = sessions.create({ scope: "parent", label: body.label || "家长设备", ip });
    setSession(res, created.token, created.ttlMs, isSecure(req));
    audit.append({ ts: new Date().toISOString(), ip, channel: "ui", action: "auth.login", ok: true });
    return send(res, 200, { ok: true, scope: "parent", expires_at: created.session.expires_at });
  }

  if (p === "/api/auth/logout" && req.method === "POST") {
    const s = sessions.fromRequest(req);
    if (s) sessions.revoke(s.id);
    res.setHeader("Set-Cookie", clearCookie());
    return send(res, 200, { ok: true });
  }

  /* 家长生成配对码 */
  if (p === "/api/auth/pairing" && req.method === "POST") {
    const g = requireSession(req, "parent");
    if (!g.ok) return send(res, g.code, { ok: false, error: g.error, message: g.message });
    const pr = sessions.createPairing();
    audit.append({ ts: new Date().toISOString(), ip, channel: "ui", action: "auth.pairing_create", ok: true });
    return send(res, 200, { ok: true, code: pr.code, expires_at: pr.expires_at });
  }

  /* 孩子平板用配对码换取长期会话 */
  if (p === "/api/auth/pair" && req.method === "POST") {
    const body = await readJSON(req, 4096);
    if (!body) return send(res, 400, { ok: false, error: "bad_json" });
    const r = sessions.consumePairing(body.code, body.label, ip);
    if (!r.ok) return send(res, 400, r);
    setSession(res, r.token, r.ttlMs, isSecure(req));
    audit.append({ ts: new Date().toISOString(), ip, channel: "ui", action: "auth.pair", ok: true });
    return send(res, 200, { ok: true, scope: "child", label: r.session.label, expires_at: r.session.expires_at });
  }

  if (p === "/api/auth/pin/change" && req.method === "POST") {
    const g = requireSession(req, "parent");
    if (!g.ok) return send(res, g.code, { ok: false, error: g.error, message: g.message });
    const body = await readJSON(req, 4096);
    if (!body) return send(res, 400, { ok: false, error: "bad_json" });
    const r = sessions.changePin(body.oldPin, body.newPin);
    if (r.ok && state && state.settings) { state.settings.parent_pin = body.newPin; save(); }
    if (!r.ok) return send(res, 400, r);
    /* 改密后原会话全部失效，用当前请求重新发一个，避免把自己踢出去 */
    const fresh = sessions.create({ scope: "parent", label: g.session.label || "家长设备", ip });
    setSession(res, fresh.token, fresh.ttlMs, isSecure(req));
    return send(res, 200, { ok: true, message: "PIN 已更新，其他设备已退出登录" });
  }

  if (p === "/api/auth/sessions" && req.method === "GET") {
    const g = requireSession(req, "parent");
    if (!g.ok) return send(res, g.code, { ok: false, error: g.error, message: g.message });
    return send(res, 200, { ok: true, sessions: sessions.list(), current: g.session.id });
  }
  const del = p.match(/^\/api\/auth\/sessions\/([^/]+)$/);
  if (del && req.method === "DELETE") {
    const g = requireSession(req, "parent");
    if (!g.ok) return send(res, g.code, { ok: false, error: g.error, message: g.message });
    return send(res, 200, { ok: sessions.revoke(del[1]) });
  }

  return false;
}

/* ---------- 主处理 ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  currentHost = req.headers.host || currentHost;

  try {
    /* 局域网 http 访问时引导到 https（麦克风 / PWA 需要安全上下文） */
    if (tlsOn && !isSecure(req) && !isLocalHost(req.headers.host)) {
      const h = String(req.headers.host || "").split(":")[0];
      res.writeHead(302, { Location: `https://${h}:${HTTPS_PORT}${req.url}` });
      return res.end();
    }

    if (p.startsWith("/api/auth/")) {
      const r = await handleAuth(req, res, url);
      if (r !== false) return r;
    }

    /* ---------- MCP（AI 助手接入，Token 鉴权） ---------- */
    if (p === "/mcp") return await mcp.handle(req, res, url);

    /* ---------- REST /api/v1（Token 鉴权）+ 家长后台 AI 接口（会话鉴权） ---------- */
    if (p.startsWith("/api/v1/")) {
      const handled = await api.handle(req, res, url);
      if (handled !== false) return;
    }
    if (p.startsWith("/api/ai/") || p.startsWith("/api/drafts")) {
      const g = requireSession(req, "parent");
      if (!g.ok) return send(res, g.code, { ok: false, error: g.error, message: g.message });
      const handled = await api.handle(req, res, url);
      if (handled !== false) return;
    }

    /* ---------- 状态同步 ---------- */
    if (p === "/api/state" && req.method === "GET") {
      const g = requireSession(req, "read");
      if (!g.ok) return send(res, g.code, { ok: false, error: g.error, message: g.message });
      /* 孩子端不得读到家长 PIN（PIN 已由 data/pin.json 哈希管理，状态里的是历史遗留字段） */
      let payload = state;
      if (g.session.scope === "child" && state) {
        payload = JSON.parse(JSON.stringify(state));
        if (payload.settings) { delete payload.settings.parent_pin; payload.settings.pin_set = sessions.hasPin(); }
      }
      return send(res, 200, { version, state: payload, hasState: !!state, scope: g.session.scope });
    }
    if (p === "/api/state" && req.method === "PUT") {
      const g = requireSession(req, "read");
      if (!g.ok) return send(res, g.code, { ok: false, error: g.error, message: g.message });
      const body = await readBody(req, 12 * 1024 * 1024);
      let payload;
      try { payload = JSON.parse(body.toString("utf8")); } catch (e) { return send(res, 400, { error: "bad_json" }); }
      if (!payload || typeof payload.state !== "object") return send(res, 400, { error: "bad_state" });
      if (!state) {
        state = payload.state;                       // 首次写入直接落地
      } else {
        state = mergeStates(state, payload.state, g.session.scope);
      }
      version = version + 1;
      storage.set("state", { version, state });   // persist() 会再 +1，此处直接落库避免双计
      return send(res, 200, { version, ok: true });
    }

    /* ---------- 录音上传 ---------- */
    if (p === "/api/recordings" && req.method === "POST") {
      const g = requireSession(req, "read");
      if (!g.ok) return send(res, g.code, { ok: false, error: g.error, message: g.message });
      const body = await readBody(req, 12 * 1024 * 1024);
      const { taskId, dataUrl, duration, mime } = JSON.parse(body.toString("utf8"));
      if (!taskId || !dataUrl) return send(res, 400, { error: "missing_fields" });
      const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
      if (!m) return send(res, 400, { error: "bad_data_url" });
      const type = mime || m[1];
      const ext = AUDIO_EXT[type] || "webm";
      const name = `rec_${crypto.randomBytes(8).toString("hex")}.${ext}`;
      fs.writeFileSync(path.join(REC_DIR, name), Buffer.from(m[2], "base64"));
      return send(res, 200, { url: `/media/${name}`, duration: Math.round(duration || 0), mime: type });
    }

    /* ---------- 照片上传（习惯任务凭证，不再塞进 state） ---------- */
    if (p === "/api/photos" && req.method === "POST") {
      const g = requireSession(req, "read");
      if (!g.ok) return send(res, g.code, { ok: false, error: g.error, message: g.message });
      const body = await readBody(req, 12 * 1024 * 1024);
      const { taskId, dataUrl, mime } = JSON.parse(body.toString("utf8"));
      if (!taskId || !dataUrl) return send(res, 400, { error: "missing_fields" });
      const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
      if (!m) return send(res, 400, { error: "bad_data_url" });
      const type = mime || m[1];
      const ext = IMAGE_EXT[type] || "jpg";
      const name = `photo_${crypto.randomBytes(8).toString("hex")}.${ext}`;
      fs.writeFileSync(path.join(PHOTO_DIR, name), Buffer.from(m[2], "base64"));
      return send(res, 200, { url: `/media/${name}`, mime: type });
    }

    /* ---------- 媒体回放（录音 + 照片） ---------- */
    if (p.startsWith("/media/")) {
      const g = requireSession(req, "read");
      if (!g.ok) return send(res, g.code, { ok: false, error: g.error, message: g.message });
      const name = path.basename(decodeURIComponent(p.slice(7)));
      let file = path.join(REC_DIR, name);
      if (!fs.existsSync(file)) file = path.join(PHOTO_DIR, name);
      const allowed = file.startsWith(REC_DIR) || file.startsWith(PHOTO_DIR);
      if (!allowed || !fs.existsSync(file)) return send(res, 404, { error: "not_found" });
      const ext = path.extname(file).toLowerCase();
      const buf = fs.readFileSync(file);
      const total = buf.length;
      const range = req.headers.range;
      if (range) { // 支持音频拖动
        const [s, e] = range.replace(/bytes=/, "").split("-");
        const start = parseInt(s, 10), end = e ? parseInt(e, 10) : total - 1;
        res.writeHead(206, {
          "Content-Type": MIME[ext] || "application/octet-stream",
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes", "Content-Length": end - start + 1
        });
        return res.end(buf.slice(start, end - start + 1));
      }
      return send(res, 200, buf, MIME[ext] || "application/octet-stream", { "Accept-Ranges": "bytes" });
    }

    /* ---------- 健康检查（公开，供客户端探测与配对页展示） ---------- */
    if (p === "/api/health") {
      const s = sessions.fromRequest(req);
      return send(res, 200, {
        ok: true, version, hasState: !!state, ts: Date.now(),
        https: isSecure(req), tls: tlsOn, lan: displayIPs(), lan_all: lanIPs(),
        auth: { required: true, scope: s ? s.scope : null },
        storage: {
          backend: storage.name, file: "data/hwbench.db",
          state_bytes: state ? Buffer.byteLength(JSON.stringify(state)) : 0,
          tasks: state && Array.isArray(state.tasks) ? state.tasks.length : 0,
          backup_last: listBackups(DATA_DIR)[0] || null,
          backup_count: listBackups(DATA_DIR).length
        },
        mcp: { endpoint: "/mcp", tools: 14, tokens: auth.list().filter(t => !t.revoked_at).length }
      });
    }

    /* ---------- 静态资源（白名单，不暴露 data/ 与 server/） ---------- */
    let rel = p === "/" ? "/index.html" : p;
    const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ""));
    const safe = file.startsWith(ROOT) && !file.startsWith(DATA_DIR) && !file.startsWith(path.join(ROOT, "server"));
    if (!safe || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "Not Found", "text/plain; charset=utf-8");
    const ext = path.extname(file).toLowerCase();
    return send(res, 200, fs.readFileSync(file), MIME[ext] || "application/octet-stream", { "Cache-Control": "no-cache" });
  } catch (err) {
    if (String(err.message) === "payload_too_large") return send(res, 413, { error: "too_large" });
    console.error("[err]", err.message);
    return send(res, 500, { error: "server_error", message: err.message });
  }
}

/* ---------- 启动 ---------- */
let tlsOn = false;
const httpServer = http.createServer(handle);

httpServer.listen(PORT, HOST, () => {
  const lan = displayIPs();
  console.log(`\n儿童作业与习惯工作台 已启动`);
  console.log(`  存储：${storage.name === "sqlite" ? "SQLite " + path.join(DATA_DIR, "hwbench.db") + "（WAL）" : "JSON 文件（降级模式）"}${storage.imported.length ? "，已从旧 JSON 迁移：" + storage.imported.join("/") : ""}`);
  console.log(`  本机：http://127.0.0.1:${PORT}`);
  if (HOST === "0.0.0.0" && lan.length) lan.forEach(ip => console.log(`  局域网：http://${ip}:${PORT}（会自动跳转 https）`));
  console.log(`  MCP：http://127.0.0.1:${PORT}/mcp（Bearer Token，家长后台「AI 接入」生成）`);
});

if (TLS_ON) {
  const cert = ensureCert(DATA_DIR);
  if (cert) {
    tlsOn = true;
    const httpsServer = https.createServer({ key: cert.key, cert: cert.cert }, handle);
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      console.log(`\nHTTPS 已开启（平板请用下面地址，首次需在浏览器信任证书）`);
      console.log(`  https://127.0.0.1:${HTTPS_PORT}`);
      displayIPs().forEach(ip => console.log(`  https://${ip}:${HTTPS_PORT}   ← 平板用这个`));
      console.log(`  证书目录：${path.join(DATA_DIR, "certs")}`);
    });
    httpsServer.on("error", e => console.log("[https] 启动失败：" + e.message));
  } else {
    console.log("[https] 未启用（证书生成失败），仅提供 http");
  }
}

setInterval(() => sessions.cleanup(), 30 * 60000).unref();
/* 每日 03:00 自动备份（VACUUM INTO，免停服），启动时缺当天备份会立即补一份 */
if (storage.name === "sqlite") {
  scheduleDaily(DATA_DIR, r => console.log(r.ok ? `[backup] ${r.file} 完成${r.skipped ? "（当天已有）" : ""}` : "[backup] 失败：" + r.error));
}
