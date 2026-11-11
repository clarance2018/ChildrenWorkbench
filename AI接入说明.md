# AI 接入说明（MCP / API Token）

> 面向家长管理员：把工作台授权给 Claude 等大模型客户端，用自然语言建任务、导入老师原文、查完成情况。

---

## 1. 设计参照

参照 Yuvomi 的 MCP 实现方式：

| 维度 | Yuvomi 做法 | 本项目的做法 |
|---|---|---|
| 端点 | `POST /mcp`，无状态 Streamable HTTP | 同：`POST /mcp`，单端点、无需 SSE、无会话 |
| 认证 | `Authorization: Bearer` / `X-API-Key` / `API-Key` | 同（额外支持 `?token=` 兜底） |
| 工具 | 6 个高频领域工具 + 3 个 OpenAPI 桥接工具 | 11 个领域工具 + 3 个桥接工具 |
| 权限 | Token 按模块 `read/write` 裁剪，越权拒绝 | 同；`tools/list` 隐藏无权工具，`tools/call` 返回 -32003 |
| 写入安全 | 直接写入，无确认 | **默认写草稿**，家长在后台确认后才下发（可显式改为直接发布） |
| 密钥 | Token 可重复查看 | 只在创建时显示一次，服务端仅存 SHA-256 |

---

## 2. 三步接入

1. 家长后台 → 顶部导航 **「AI 接入」** → **+ 新建 Token**
   - 用途名称：如「Claude 建任务」
   - 权限预设：家长助手（推荐）/ 完全管理 / 只读查询
   - 写入方式：**草稿模式（推荐）** 或 直接发布
   - 有效期：30 天 / 90 天 / 1 年 / 长期
2. 复制生成的配置（密钥只显示这一次）
3. 在客户端对话里说：「帮我建今天的三项作业」，AI 建的任务会回到「AI 接入」页的**待确认队列**，确认后孩子端才会出现

---

## 3. 客户端配置

端点：`http://127.0.0.1:8900/mcp`（局域网访问时替换为电脑 IP）

### Claude Code

```bash
claude mcp add --transport http hwbench http://127.0.0.1:8900/mcp \
  --header "Authorization: Bearer hwb_xxx"
```

### Claude Desktop / Cursor / Cherry Studio（JSON 配置）

```json
{
  "mcpServers": {
    "hwbench": {
      "type": "http",
      "url": "http://127.0.0.1:8900/mcp",
      "headers": { "Authorization": "Bearer hwb_xxx" }
    }
  }
}
```

### 只支持 stdio 的客户端

```bash
HWBENCH_URL=http://127.0.0.1:8900/mcp \
HWBENCH_TOKEN=hwb_xxx \
node mcp-stdio.js
```

客户端里把启动命令配成上面的形式即可，桥接进程会把 stdio 的 JSON-RPC 转发到 `/mcp`。

---

## 4. 工具清单

| 工具 | 作用 | 所需权限 |
|---|---|---|
| `list_today_tasks` | 查某天任务（状态/类别过滤） | tasks:read |
| `create_task` | 建一条作业/习惯任务 | tasks:write |
| `create_tasks_batch` | 批量建任务（≤20 条） | tasks:write |
| `import_homework_text` | 粘贴老师原文 → 备注 + 任务 + 不确定段落 | import:write |
| `set_daily_note` | 写当天备注（学习内容/重点） | notes:write |
| `create_habit` | 新建习惯（提醒时间、清单、明日课表） | habits:write |
| `create_period_rule` | 建周期任务（每天/每周几） | tasks:write |
| `get_timetable` | 查当天与次日课表 | timetable:read |
| `get_progress` | 当天完成率/用时/超时 | report:read |
| `get_weekly_report` | 近 7 天汇总 | report:read |
| `reject_task` | 退回任务并撤销星星（需原因） | review:write |
| `list_api_operations` | 列出可调用的 REST 操作 | tasks:read |
| `get_api_operation` | 查看某操作参数 | tasks:read |
| `call_api_operation` | 调用任意已登记操作（继承 Token 权限） | 按目标操作 |

REST 侧共 23 个操作，全部登记在 `GET /api/v1/openapi.json`，桥接工具与 REST 共用同一套权限与审计。

---

## 5. 权限预设

| 预设 | 范围 | 适用 |
|---|---|---|
| 家长助手（推荐） | 任务读写、习惯读写、备注读写、导入、课表只读、统计只读 | 日常建任务、导作业 |
| 完全管理 | `*` | 可信客户端，可退回任务、改课表 |
| 只读查询 | 各类 read | 做总结、问答 |

`write` 隐含 `read`。例如 `tasks:write` 同时允许查询任务。

---

## 6. 草稿模式 vs 直接发布

| | 草稿（默认） | 直接发布 |
|---|---|---|
| AI 建任务后的位置 | 后台「待确认队列」 | 直接进入孩子端今日任务 |
| 家长是否需确认 | 是（可逐条或整批） | 否 |
| 风险 | 低，AI 理解偏差不会打扰孩子 | 高，错误任务会立即出现 |
| 建议 | 首次接入、复杂原文导入 | 固定模板、每天重复的简单任务 |

即使直接发布，服务端对旧客户端整包覆盖也做了保护：MCP 新建且 7 天内的任务/周期/习惯，不会被未及时同步的页面覆盖掉。

---

## 7. 安全设计

- Token 明文只在创建时返回一次；服务端存 SHA-256，日志与列表只显示前缀 `hwb_xxxxxxxx…`
- 支持吊销，吊销后下一次调用立即 401
- 有效期可设，过期自动拒绝
- 限流：每 Token 每分钟 120 次
- Origin 校验：拒绝跨站来源，降低 DNS rebinding 风险
- 审计：每次 MCP / REST 调用写入 `data/audit.jsonl`，后台展示最近 100 条
- 越权：`tools/list` 不返回无权工具；直接按名字调用返回 `-32003`

---

## 8. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 401 `missing_token` | 没有带 Authorization | 检查客户端配置的 headers |
| 401 `revoked` / `expired` | Token 已吊销或过期 | 重新生成 |
| 403 `forbidden` | Token 缺少该模块权限 | 换预设或新建 Token |
| `-32003` | 调用了无权工具 | 同上 |
| 429 | 触发限流 | 检查客户端是否疯狂重试 |
| 连不上 `/mcp` | 服务未启动或端口不同 | `node server.js`，确认 8900 端口 |
| 任务没出现在孩子端 | 用的是草稿模式 | 去「AI 接入」页确认 |

---

## 9. 尚未完成（与 P0 方案的关系）

- **Web 会话级鉴权**：目前 `/api/state`、`/api/ai/*` 仍与本机 UI 同级信任，仅靠前端 PIN 拦截；Token 相关接口也未校验管理员身份。P0-4 落地后改为服务端 Session + 角色校验。
- **HTTPS 与局域网访问**：服务默认只监听 `127.0.0.1`；平板或另一台设备上的 MCP 客户端需先用 `HOST=0.0.0.0` 暴露，并配置 HTTPS（否则麦克风/PWA 不可用）。
- **第三方客户端托管授权（OAuth 2.1）**：当前使用静态 Token，适合自建与本地客户端；若要接入云端 MCP 目录，需要补 OAuth 授权服务器。
