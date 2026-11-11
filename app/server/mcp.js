/* MCP 服务端：/mcp 无状态 Streamable HTTP + JSON-RPC 2.0
 * 参照 Yuvomi：POST /mcp + Bearer Token + 领域工具 + OpenAPI 桥接工具
 * 相对 Yuvomi 的增强：AI 写入默认进"待确认草稿"，Token 密文只展示一次
 */
const { hasScope } = require("./auth");

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "hwbench", title: "儿童作业与习惯工作台", version: "1.0.0" };

function createMcp({ service, auth, audit, send, readBody, publicBase }) {
  const tools = buildTools();

  function originOk(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const u = new URL(origin);
      const host = req.headers.host || "";
      return u.host === host || u.hostname === "localhost" || u.hostname === "127.0.0.1";
    } catch (e) { return false; }
  }

  async function handle(req, res, url) {
    if (url.pathname !== "/mcp") return false;
    if (req.method === "GET") {
      return send(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "本服务不提供 SSE 推送流，请使用 POST 调用工具" } });
    }
    if (req.method === "DELETE") return send(res, 405, { error: "session_not_supported" });
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
    if (!originOk(req)) return send(res, 403, { error: "origin_not_allowed" });

    const c = auth.authenticate(req, url);
    if (!c.ok) {
      res.writeHead(c.code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="hwbench"'
      });
      return res.end(JSON.stringify({
        jsonrpc: "2.0", id: null,
        error: { code: -32001, message: c.message, data: { error: c.error, hint: "在请求头加入 Authorization: Bearer <API Token>" } }
      }));
    }

    let payload;
    try {
      const raw = await readBody(req, 2 * 1024 * 1024);
      payload = JSON.parse(raw.toString("utf8"));
    } catch (e) {
      return send(res, 400, rpcError(null, -32700, "JSON 解析失败"));
    }

    const isBatch = Array.isArray(payload);
    const messages = isBatch ? payload : [payload];
    const responses = [];
    for (const msg of messages) {
      const out = await handleOne(msg, c.token);
      if (out) responses.push(out);
    }
    if (!responses.length) {
      res.writeHead(202); return res.end();
    }
    return send(res, 200, isBatch ? responses : responses[0]);
  }

  async function handleOne(msg, token) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return rpcError(msg && msg.id != null ? msg.id : null, -32600, "无效的 JSON-RPC 请求");
    }
    const isNotification = msg.id === undefined || msg.id === null;
    const id = msg.id;

    if (isNotification) {
      // notifications/initialized、notifications/cancelled 等直接确认
      return null;
    }

    switch (msg.method) {
      case "initialize": {
        const asked = msg.params && msg.params.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: [
            "这是家庭的儿童作业与习惯工作台，服务对象是小学生与家长。",
            "你可以创建作业/习惯任务、导入老师原文、写当天备注、查询课表与完成情况。",
            "重要：当前 Token 为「" + (token.mode === "direct" ? "直接发布" : "草稿模式") + "」。",
            token.mode === "direct"
              ? "创建的任务会立即下发到孩子平板，请先与家长确认内容再调用写入类工具。"
              : "创建的任务只进入家长后台的待确认队列，家长确认后才下发；请如实告知家长需要去确认。",
            "时间一律使用 YYYY-MM-DD；星期用 1-7（1=周一）。",
            "需要回答“星星能换什么奖品”“错题本还有什么没过关”时，用 list_api_operations 发现 rewards/redemptions/mistakes/templates 等只读接口。",
            "不确定老师原文含义时，使用 import_homework_text，它会返回 uncertain 段落供家长处理，不要自行编造任务。"
          ].join("\n")
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: visibleTools(token) });
      case "tools/call":
        return await callTool(id, msg.params || {}, token);
      case "resources/list":
        return rpcResult(id, { resources: [] });
      case "prompts/list":
        return rpcResult(id, { prompts: [] });
      default:
        return rpcError(id, -32601, `不支持的方法：${msg.method}`);
    }
  }

  function visibleTools(token) {
    return tools.filter(t => hasScope(token, t.scope)).map(t => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.readOnly === true, destructiveHint: t.destructive === true, openWorldHint: false }
    }));
  }

  async function callTool(id, params, token) {
    const name = params.name;
    const args = params.arguments || {};
    const tool = tools.find(t => t.name === name);
    if (!tool) return rpcError(id, -32602, `未知工具：${name}`);
    if (!hasScope(token, tool.scope)) {
      return rpcError(id, -32003, `Token 缺少 ${tool.scope} 权限，无法调用 ${name}`);
    }
    const missing = (tool.required || []).filter(k => args[k] === undefined || args[k] === null || args[k] === "");
    if (missing.length) {
      return rpcResult(id, toolError(`缺少必填参数：${missing.join("、")}`));
    }

    const started = Date.now();
    let result;
    try {
      result = await tool.run(args, token);
    } catch (e) {
      result = { ok: false, error: "internal_error", message: e.message };
    }
    audit.append({
      ts: new Date().toISOString(), channel: "mcp", action: name,
      token_id: token.id, token_name: token.name,
      ok: !!result.ok, ms: Date.now() - started,
      error: result.ok ? null : (result.error || null),
      summary: summarize(name, args)
    });
    if (!result.ok) return rpcResult(id, toolError(result.message || result.error || "调用失败", result));
    return rpcResult(id, toolOk(result));
  }

  function summarize(name, args) {
    if (name === "import_homework_text") return `text ${String(args.text || "").length} 字`;
    if (name === "create_task") return String(args.title || "").slice(0, 40);
    if (args.date) return args.date;
    return "";
  }

  /* ---------- 工具实现 ---------- */
  function buildTools() {
    const publishOf = token => token.mode === "direct";
    const who = token => ({ token_id: token.id, created_by: "AI（" + token.name + "）", origin: "mcp" });

    return [
      {
        name: "list_today_tasks", title: "查看任务", scope: "tasks:read", readOnly: true,
        description: "查询某天的作业与习惯任务，默认今天。返回状态、计时模式、星星与退回原因，可用于回答“今天还有什么没做”。",
        inputSchema: {
          type: "object",
          properties: {
            date: { type: "string", description: "日期 YYYY-MM-DD，缺省今天" },
            status: { type: "string", description: "未开始/进行中/孩子已完成/已退回/超时/已过期" },
            category: { type: "string", description: "学业 或 习惯" }
          }
        },
        run: (a) => {
          const list = service.listTasks(a);
          return { ok: true, date: a.date || "全部", count: list.length, tasks: list.map(brief) };
        }
      },
      {
        name: "create_task", title: "创建任务", scope: "tasks:write",
        description: "创建一条作业或习惯任务。草稿模式的 Token 会进入家长待确认队列；直接发布模式的 Token 会立即下发到孩子端。标题需具体（如“口算 20 题”“背 10 的分与合”），不要写“作业”这种笼统标题。",
        required: ["title"],
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "任务标题，≤60 字" },
            subject: { type: "string", description: "语文/数学/英语/音乐/体育/美术/科学/品德" },
            category: { type: "string", enum: ["学业", "习惯"], description: "默认学业" },
            type: { type: "string", description: "口述/背诵/朗读/书写/计算/练习/习惯" },
            date: { type: "string", description: "YYYY-MM-DD，缺省今天" },
            note: { type: "string", description: "给孩子看的具体说明" },
            estimated_minutes: { type: "integer", description: "预计时长（分钟）" },
            timer_mode: { type: "string", enum: ["stopwatch", "countdown"], description: "正计时或倒计时" },
            limit_minutes: { type: "integer", description: "倒计时分钟，倒计时模式必填" },
            need_recording: { type: "boolean", description: "朗读/口述/背诵类应为 true" },
            star_value: { type: "integer", description: "完成可得星星 0-3，默认 1" }
          }
        },
        run: (a, token) => service.createTask(a, Object.assign({ publish: publishOf(token) }, who(token)))
      },
      {
        name: "create_tasks_batch", title: "批量创建任务", scope: "tasks:write",
        description: "一次创建多条任务（最多 20 条），适合家长口述“今天语文三项、数学两项”。行为与 create_task 一致（草稿或直接发布）。",
        required: ["tasks"],
        inputSchema: {
          type: "object",
          properties: {
            tasks: {
              type: "array", description: "任务数组，字段同 create_task",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" }, subject: { type: "string" }, category: { type: "string" },
                  type: { type: "string" }, date: { type: "string" }, note: { type: "string" },
                  estimated_minutes: { type: "integer" }, timer_mode: { type: "string" },
                  limit_minutes: { type: "integer" }, need_recording: { type: "boolean" }, star_value: { type: "integer" }
                },
                required: ["title"]
              }
            }
          }
        },
        run: (a, token) => {
          if (!Array.isArray(a.tasks) || !a.tasks.length) return { ok: false, error: "tasks_required", message: "tasks 不能为空" };
          if (a.tasks.length > 20) return { ok: false, error: "too_many", message: "单次最多 20 条" };
          const results = a.tasks.map(t => service.createTask(t, Object.assign({ publish: publishOf(token) }, who(token))));
          return {
            ok: true, mode: publishOf(token) ? "direct" : "draft",
            created: results.filter(r => r.ok).length,
            failed: results.filter(r => !r.ok),
            results
          };
        }
      },
      {
        name: "import_homework_text", title: "解析老师原文", scope: "import:write",
        description: "把老师在群里发的作业原文整段粘贴进来，自动拆成“当天备注 + 任务清单 + 不确定段落”。识别【说一说】【背一背】【读一读】【写一写】【算一算】等关键词。无法判断的段落会放在 uncertain 里，请让家长处理，不要猜。",
        required: ["text"],
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "老师原文，可含换行" },
            date: { type: "string", description: "作业日期 YYYY-MM-DD，缺省今天" },
            pinyin_enabled: { type: "boolean", description: "一年级模式是否注音，默认 true" }
          }
        },
        run: (a, token) => service.importText(a, {
          publish: publishOf(token), token_id: token.id, token_name: token.name, created_by: "AI（" + token.name + "）"
        })
      },
      {
        name: "set_daily_note", title: "写当天备注", scope: "notes:write",
        description: "设置某天的备注（学习内容、学习重点）。备注只作展示，不生成任务。会显示在孩子端首页，可控制是否给孩子看。",
        required: ["note"],
        inputSchema: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD，缺省今天" },
            note: { type: "string", description: "备注正文，如“学习内容：10 的加减法（P56）”" },
            show_to_child: { type: "boolean", description: "是否显示给孩子，默认 true" },
            pinyin_enabled: { type: "boolean", description: "一年级注音，默认 true" }
          }
        },
        run: (a) => service.setNote(a.date || today(), a)
      },
      {
        name: "create_habit", title: "新建习惯任务", scope: "habits:write",
        description: "新建一个每日/每周习惯，如整理书包、刷牙洗脸、收拾玩具。到提醒时间会在孩子端置顶。整理书包类可开启 linked_timetable 以显示明日课表。",
        required: ["name"],
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "习惯名称，如“整理明天书包”" },
            icon: { type: "string", description: "一个 emoji" },
            remind_time: { type: "string", description: "提醒时间 HH:MM，如 20:00" },
            weekdays: { type: "array", items: { type: "integer" }, description: "1-7，默认每天" },
            checklist: { type: "array", items: { type: "string" }, description: "检查清单，如 [“课本按课表放好”,“水杯装好”]" },
            linked_timetable: { type: "boolean", description: "是否显示明日课表" },
            need_photo: { type: "boolean", description: "是否需要拍照打卡" }
          }
        },
        run: (a) => service.createHabit(a)
      },
      {
        name: "create_period_rule", title: "创建周期任务", scope: "tasks:write",
        description: "创建重复任务（每天口算、每周一三朗读）。规则按日生成实例，不会重复创建。",
        required: ["title"],
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "任务标题" },
            subject: { type: "string" }, type: { type: "string" },
            estimated_minutes: { type: "integer" },
            timer_mode: { type: "string", enum: ["stopwatch", "countdown"] },
            limit_minutes: { type: "integer" },
            need_recording: { type: "boolean" },
            freq: { type: "string", enum: ["daily", "weekly", "once"], description: "默认 daily" },
            weekdays: { type: "array", items: { type: "integer" }, description: "weekly 时必填，1-7" },
            start_date: { type: "string", description: "生效日期，缺省今天" },
            end_date: { type: "string", description: "结束日期，可空" }
          }
        },
        run: (a) => service.createPeriodRule(a)
      },
      {
        name: "get_timetable", title: "查课表", scope: "timetable:read", readOnly: true,
        description: "查询某天的课程与备注，同时返回次日课表。整理书包时用来提醒“明天有美术，要带彩笔”。",
        inputSchema: {
          type: "object",
          properties: { date: { type: "string", description: "YYYY-MM-DD，缺省今天" } }
        },
        run: (a) => service.getTimetable(a.date || today())
      },
      {
        name: "get_progress", title: "查完成情况", scope: "report:read", readOnly: true,
        description: "查询某天的完成率、用时、星星、超时次数与逐条任务状态。可回答“今天完成得怎么样”。",
        inputSchema: {
          type: "object",
          properties: { date: { type: "string", description: "YYYY-MM-DD，缺省今天" } }
        },
        run: (a) => service.getProgress(a.date || today())
      },
      {
        name: "get_weekly_report", title: "查周报", scope: "report:read", readOnly: true,
        description: "近 7 天完成率、总用时、超时次数与每日明细，用于周总结。",
        inputSchema: {
          type: "object",
          properties: { start: { type: "string", description: "开始日期，缺省 6 天前" } }
        },
        run: (a) => service.getWeeklyReport(a.start)
      },
      {
        name: "reject_task", title: "退回任务", scope: "review:write", destructive: true,
        description: "把已完成的任务退回给孩子重做，会撤销该任务星星并保留录音（标记已退回）。必须给出具体原因，原因会显示给孩子。仅在家长明确要求时使用。",
        required: ["task_id", "reason"],
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "任务 ID，可从 list_today_tasks 获取" },
            reason: { type: "string", description: "具体原因，如“第 3 题写错了，改完再交”" }
          }
        },
        run: (a, token) => service.rejectTask(a.task_id, a.reason, token.name)
      },
      {
        name: "list_api_operations", title: "列出可用接口", scope: "tasks:read", readOnly: true,
        description: "列出当前 Token 有权调用的全部 REST 操作（含参数说明）。当领域工具不够用时，用它发现能力，再用 call_api_operation 调用。",
        inputSchema: { type: "object", properties: {} },
        run: (a, token) => {
          const list = service.ops.filter(o => hasScope(token, o.scope)).map(o => ({
            operation_id: o.id, method: o.method, path: o.path, summary: o.summary, scope: o.scope,
            params: o.params
          }));
          return { ok: true, count: list.length, operations: list };
        }
      },
      {
        name: "get_api_operation", title: "查看接口参数", scope: "tasks:read", readOnly: true,
        description: "查看某个 REST 操作的完整参数定义。",
        required: ["operation_id"],
        inputSchema: {
          type: "object",
          properties: { operation_id: { type: "string", description: "如 tasks.create" } }
        },
        run: (a, token) => {
          const op = service.ops.find(o => o.id === a.operation_id);
          if (!op) return { ok: false, error: "operation_not_found", message: "没有这个操作，请先调用 list_api_operations" };
          if (!hasScope(token, op.scope)) return { ok: false, error: "forbidden", message: `缺少 ${op.scope}` };
          return { ok: true, operation_id: op.id, method: op.method, path: op.path, summary: op.summary, scope: op.scope, params: op.params };
        }
      },
      {
        name: "call_api_operation", title: "调用任意接口", scope: "tasks:read", destructive: true,
        description: "调用已登记的 REST 操作，权限完全继承当前 Token：越权会被拒绝。参数放在 params 对象里，例如 {operation_id:'notes.set', params:{date:'2026-11-11', note:'...'}}。",
        required: ["operation_id"],
        inputSchema: {
          type: "object",
          properties: {
            operation_id: { type: "string", description: "操作 ID，如 tasks.list" },
            params: { type: "object", description: "该操作的参数对象" }
          }
        },
        run: async (a, token) => {
          const op = service.ops.find(o => o.id === a.operation_id);
          if (!op) return { ok: false, error: "operation_not_found", message: "没有这个操作" };
          if (!hasScope(token, op.scope)) return { ok: false, error: "forbidden", message: `Token 缺少 ${op.scope} 权限` };
          const params = a.params || {};
          const missing = op.params.filter(p => p.required && (params[p.name] === undefined || params[p.name] === ""));
          if (missing.length) return { ok: false, error: "missing_params", message: "缺少参数：" + missing.map(p => p.name).join("、") };
          return await op.run(Object.assign({}, params), { token });
        }
      }
    ];
  }

  function today() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function brief(t) {
    return {
      id: t.id, title: t.title, subject: t.subject, category: t.category, type: t.type,
      date: t.date, status: t.status, timer_mode: t.timer_mode, limit_minutes: t.limit_minutes,
      need_recording: t.need_recording, star_value: t.star_value,
      actual_minutes: t.actual_seconds ? Math.round(t.actual_seconds / 60) : null,
      parent_note: t.parent_note || undefined
    };
  }

  return { handle };
}

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message, data) { return { jsonrpc: "2.0", id, error: { code, message, data } }; }
function toolOk(data) { return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }; }
function toolError(message, data) {
  return {
    content: [{ type: "text", text: JSON.stringify(Object.assign({ ok: false, message }, data || {}), null, 2) }],
    isError: true
  };
}

module.exports = { createMcp, SERVER_INFO, PROTOCOLS };
