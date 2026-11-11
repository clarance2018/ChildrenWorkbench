/* REST /api/v1：MCP 桥接工具的底层通道
 * 以及家长后台 AI 接入页所需的本地接口（Token / 草稿 / 审计）
 */
const { hasScope, PRESETS, SCOPES, MODULES } = require("./auth");

function createApi({ service, auth, audit, send, readBody, getState, save, publicBase }) {
  const api = {};

  function caller(req, url) {
    const r = auth.authenticate(req, url);
    if (!r.ok) return r;
    return { ok: true, token: r.token, ctx: { token: r.token } };
  }

  function auditAppend(req, entry) {
    audit.append(Object.assign({
      ts: new Date().toISOString(),
      ip: req.socket.remoteAddress || "",
      ua: String(req.headers["user-agent"] || "").slice(0, 120)
    }, entry));
  }

  async function handleV1(req, res, url) {
    const opMatch = service.findOp(req.method, url.pathname);
    if (!opMatch) return send(res, 404, { ok: false, error: "not_found", message: "接口不存在" });
    const c = caller(req, url);
    if (!c.ok) return send(res, c.code, { ok: false, error: c.error, message: c.message });
    const { op, params } = opMatch;
    if (!hasScope(c.token, op.scope)) {
      return send(res, 403, { ok: false, error: "forbidden", message: `该 Token 缺少 ${op.scope} 权限` });
    }
    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      try {
        const raw = await readBody(req, 2 * 1024 * 1024);
        body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      } catch (e) {
        return send(res, 400, { ok: false, error: "bad_json", message: "请求体不是合法 JSON" });
      }
    }
    const query = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });
    const args = Object.assign({}, query, body, params);
    const started = Date.now();
    let result;
    try {
      result = await op.run(args, c.ctx);
    } catch (e) {
      result = { ok: false, error: "internal_error", message: e.message };
    }
    auditAppend(req, {
      token_id: c.token.id, token_name: c.token.name, channel: "rest",
      action: op.id, ok: !!result.ok, ms: Date.now() - started,
      error: result.ok ? null : result.error
    });
    const code = result.ok === false ? (result.error === "task_not_found" || result.error === "draft_not_found" ? 404 : 400) : 200;
    return send(res, code, result);
  }

  /* ---------- 家长后台 AI 接入页 ---------- */
  async function handleUi(req, res, url) {
    const p = url.pathname;

    if (p === "/api/ai/meta" && req.method === "GET") {
      return send(res, 200, {
        ok: true,
        base: publicBase(),
        mcp_url: publicBase() + "/mcp",
        presets: PRESETS,
        scopes: SCOPES,
        modules: MODULES,
        docs: {
          claude_code: "claude mcp add --transport http hwbench " + publicBase() + "/mcp --header \"Authorization: Bearer <TOKEN>\"",
          json: { mcpServers: { hwbench: { type: "http", url: publicBase() + "/mcp", headers: { Authorization: "Bearer <TOKEN>" } } } }
        }
      });
    }

    if (p === "/api/ai/tokens" && req.method === "GET") {
      return send(res, 200, { ok: true, tokens: auth.list() });
    }
    if (p === "/api/ai/tokens" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}"); } catch (e) { return send(res, 400, { ok: false, error: "bad_json" }); }
      const preset = PRESETS[body.preset];
      const scopes = body.scopes || (preset ? preset.scopes : ["tasks:read"]);
      const created = auth.create({
        name: body.name, scopes, mode: body.mode, preset: body.preset || "custom",
        ttlDays: body.ttlDays
      });
      auditAppend(req, { token_id: created.meta.id, token_name: created.meta.name, channel: "ui", action: "token.create", ok: true });
      return send(res, 200, { ok: true, token: created.token, meta: created.meta });
    }
    const tokenDel = p.match(/^\/api\/ai\/tokens\/([^/]+)$/);
    if (tokenDel && req.method === "DELETE") {
      const ok = auth.revoke(tokenDel[1]);
      auditAppend(req, { token_id: tokenDel[1], channel: "ui", action: "token.revoke", ok });
      return send(res, ok ? 200 : 404, { ok, message: ok ? "已吊销，客户端下次调用即失效" : "Token 不存在" });
    }

    if (p === "/api/ai/audit" && req.method === "GET") {
      return send(res, 200, { ok: true, entries: audit.tail(100) });
    }

    /* 草稿队列（家长确认） */
    if (p === "/api/drafts" && req.method === "GET") {
      return send(res, 200, Object.assign({ ok: true }, service.listDrafts(), { pending: service.listDrafts().singles.length + service.listDrafts().batches.reduce((s, b) => s + b.items.length, 0) }));
    }
    const confirmOne = p.match(/^\/api\/drafts\/([^/]+)\/confirm$/);
    if (confirmOne && req.method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8") || "{}"); } catch (e) { body = {}; }
      const r = service.confirmDraft(confirmOne[1], body);
      auditAppend(req, { channel: "ui", action: "draft.confirm", ok: r.ok, error: r.error || null });
      return send(res, r.ok ? 200 : 400, r);
    }
    const confirmBatch = p.match(/^\/api\/drafts\/batch\/([^/]+)\/confirm$/);
    if (confirmBatch && req.method === "POST") {
      const r = service.confirmBatch(confirmBatch[1]);
      auditAppend(req, { channel: "ui", action: "draft.confirm_batch", ok: r.ok, error: r.error || null });
      return send(res, r.ok ? 200 : 400, r);
    }
    const discard = p.match(/^\/api\/drafts\/([^/]+)$/);
    if (discard && req.method === "DELETE") {
      const r = service.discardDraft(discard[1]);
      return send(res, r.ok ? 200 : 404, r);
    }

    /* OpenAPI 描述（供客户端/模型发现能力） */
    if (p === "/api/v1/openapi.json" && req.method === "GET") {
      return send(res, 200, openapi());
    }

    return false;
  }

  function openapi() {
    const paths = {};
    service.ops.forEach(op => {
      const path = op.path.replace(/:([A-Za-z]+)/g, "{$1}");
      paths[path] = paths[path] || {};
      const parameters = op.params.filter(x => x.in !== "body").map(x => ({
        name: x.name, in: x.in, required: !!x.required, description: x.desc || "",
        schema: { type: x.type === "number" ? "integer" : "string" }
      }));
      const bodyProps = {};
      op.params.filter(x => x.in === "body").forEach(x => { bodyProps[x.name] = { type: x.type === "number" ? "integer" : x.type === "boolean" ? "boolean" : x.type === "array" ? "array" : "object", description: x.desc || "" }; });
      paths[path][op.method.toLowerCase()] = {
        operationId: op.id.replace(/\./g, "_"),
        summary: op.summary,
        description: "所需权限：" + op.scope,
        parameters,
        requestBody: Object.keys(bodyProps).length ? { content: { "application/json": { schema: { type: "object", properties: bodyProps } } } } : undefined,
        responses: { 200: { description: "OK" } }
      };
    });
    return {
      openapi: "3.1.0",
      info: { title: "儿童作业与习惯工作台 API", version: "1.0.0", description: "家长端与 AI 助手共用接口。认证：Authorization: Bearer <API Token>" },
      servers: [{ url: publicBase() }],
      paths
    };
  }

  async function handle(req, res, url) {
    if (url.pathname === "/api/v1/openapi.json" && req.method === "GET") return send(res, 200, openapi());
    if (url.pathname.startsWith("/api/v1/")) return handleV1(req, res, url);
    if (url.pathname.startsWith("/api/ai/") || url.pathname.startsWith("/api/drafts")) return handleUi(req, res, url);
    return false;
  }

  return Object.assign(api, { handle, handleV1, handleUi, openapi });
}

module.exports = { createApi };
