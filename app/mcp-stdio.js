#!/usr/bin/env node
/* MCP stdio 桥：给只支持 stdio 的客户端使用
 * 用法：
 *   HWBENCH_URL=http://127.0.0.1:8900/mcp HWBENCH_TOKEN=hwb_xxx node mcp-stdio.js
 * 作用：把 stdin 的 JSON-RPC 行转发到 /mcp，再把响应写回 stdout（每行一条，禁止多余输出）
 */
const readline = require("readline");

const URL_BASE = process.env.HWBENCH_URL || "http://127.0.0.1:8900/mcp";
const TOKEN = process.env.HWBENCH_TOKEN || "";

if (!TOKEN) {
  process.stderr.write("[hwbench-mcp] 缺少 HWBENCH_TOKEN，请先在家长后台「AI 接入」生成 Token\n");
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch (e) {
    return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
  }
  try {
    const res = await fetch(URL_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN },
      body: JSON.stringify(msg)
    });
    if (res.status === 202) return; // 通知类消息无需响应
    const data = await res.json();
    write(data);
  } catch (e) {
    process.stderr.write("[hwbench-mcp] 转发失败：" + e.message + "\n");
    if (msg && msg.id != null) {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "无法连接工作台：" + e.message } });
    }
  }
});
