# 儿童作业与习惯工作台（Children Workbench）

一个跑在家庭局域网里的**小学生作业与习惯管理 PWA**：家长在手机/电脑上发布与复核任务，孩子在平板上打卡完成；同时内置 **MCP 服务**，让 Claude / WorkBuddy 等 AI 助手直接读取进度、解析老师发的作业原文并创建任务。

零第三方依赖：Node 24 内置 `node:sqlite` 存储 + 原生 HTTP 服务 + 纯手写前端，单进程即可运行。

## ✨ 功能一览

**孩子端（平板，全屏大按钮）**
- 任务计时（正计时/倒计时、超时提醒、20 分钟护眼自动暂停）
- 朗读/背诵录音打卡、习惯打卡清单、拍照上传
- 口算练习器：逐题作答、自动判分、错题自动进错题本
- 星星奖励、兑换商城、连续打卡、家长语音鼓励信箱 📮

**家长端（手机/电脑，PIN 保护）**
- 今日任务发布（单条/复制昨日/**常用模板**/模板批量发布一周/文本导入）
- 老师原文导入：粘贴群消息 → 自动拆成「当天备注 + 任务草稿 + 不确定段落」
- 复核与退回（可勾选入错题本）、周报（5 项指标 + 热力图 + AI 总结复制）
- 错题本（周末重练，做对 2 次自动归档）、奖励与兑换审批、课程表、语音录入
- AI 接入管理：Token 签发/吊销、审计日志、存储与备份看板

**AI / MCP**
- 无状态 Streamable HTTP MCP：`POST /mcp` + Bearer Token
- 14 个领域工具（建任务、解析原文、写备注、习惯、周期任务、课表、进度、周报、退回）+ 27 个 REST 桥接操作
- Token 作用域裁剪（只读/家长助手/完全管理），**草稿模式**：AI 创建的内容先进家长待确认队列
- 老师原文解析器双端一致（浏览器与 Node 同规则）

**工程能力**
- 双端实时同步：LWW 合并 + 墓碑防复活 + 孩子端字段净化（孩子无法伪造"已兑现/已审批"）
- SQLite WAL 存储，每日 03:00 `VACUUM INTO` 在线备份，滚动保留 14 份
- 自签 TLS（平板走 https）、Service Worker 离线可用、Windows 开机自启脚本

## 🚀 快速开始

要求：**Node.js ≥ 22.5**（推荐 24，使用内置 `node:sqlite`，无需 npm install）

```bash
cd app
node server.js
```

启动后：

| 入口 | 地址 |
|---|---|
| 家长端 | http://127.0.0.1:8900/#/parent |
| 孩子端（平板，首次需信任自签证书） | https://\<电脑局域网 IP\>:8443 |
| 健康检查 | http://127.0.0.1:8900/api/health |
| MCP 端点 | http://127.0.0.1:8900/mcp（平板侧用 https://\<IP\>:8443/mcp） |

首次使用：在家长端设置 PIN → 孩子端通过配对码绑定 → 开始发布任务。Windows 开机自启执行 `app/register-autostart.ps1`。

## 📁 项目结构

```
app/
├── server.js            # 入口：HTTP/HTTPS 服务、路由、静态资源
├── server/
│   ├── service.js       # 领域层：任务/草稿/备注/习惯/周期/课表/统计（REST 与 MCP 共用）
│   ├── mcp.js           # MCP 无状态服务端：14 个工具 + JSON-RPC 2.0
│   ├── auth.js          # API Token、作用域、限流、审计
│   ├── session.js       # 家长 PIN 会话、孩子配对码
│   ├── storage.js       # 统一存储层（node:sqlite，WAL，幂等迁移旧 JSON）
│   ├── merge.js         # 双端状态合并：LWW + 墓碑 + 孩子端净化
│   ├── backup.js        # 每日 VACUUM INTO 在线备份
│   └── parser.js        # 老师原文解析器（与 js/parser.js 规则一致）
├── js/
│   ├── child.js / parent.js / ai.js   # 三端页面
│   ├── store.js         # 客户端状态 + 同步推送（离线待传队列）
│   └── parser.js / pinyin.js / sound.js / remind.js
├── mcp-stdio.js         # stdio 桥（给只支持 stdio 的 MCP 客户端）
├── sw.js                # Service Worker（网络优先，离线回退）
└── data/                # 运行数据（不入库）：hwbench.db、备份、证书、录音、照片
```

## 🔌 MCP 客户端接入

家长端「AI 接入」页可一键生成 Token（密文只显示一次），配置示例：

```json
{
  "mcpServers": {
    "hwbench": {
      "type": "http",
      "url": "https://<你的IP>:8443/mcp",
      "headers": { "Authorization": "Bearer hwb_xxxxxxxx" }
    }
  }
}
```

> 注意：8443 是纯 TLS 端口，URL 必须写 `https://`；8900 是 HTTP 端口。自签证书场景下客户端需允许不安全连接。

**Token 预设**

| 预设 | 能力 |
|---|---|
| 只读查询 | 查任务/课表/完成情况/周报/商城/错题（`tasks/habits/timetable/notes/report:read`） |
| 家长助手 | + 创建任务/习惯、写备注、解析原文（默认进**草稿队列**，家长确认后下发） |
| 完全管理 | 全部权限（含退回任务、改课表、直接发布模式） |

## 🔒 安全设计

- 家长端 PIN 登录（错误尝试锁定 15 分钟），孩子端配对码绑定
- Token 只存 SHA-256 哈希，密文创建时仅展示一次；按模块裁剪作用域，越权返回 `-32003`
- 孩子端提交在服务端合并层净化：只允许更新自己的任务状态与新增兑换申请，无法伪造审批结果
- 所有 AI 调用落审计表（工具、Token、耗时、成败）

## 📚 文档

- [PRD](儿童作业与习惯工作台_PRD.md)
- [功能迭代方案 v4](儿童作业与习惯工作台_功能迭代方案_v4.md)
- [部署与平板接入](部署与平板接入.md)
- [AI 接入说明](AI接入说明.md)

## License

MIT
