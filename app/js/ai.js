/* ========== 家长后台 · AI 接入（MCP / API Token） ========== */
const AI = {
  loaded: false, loading: false, error: null,
  meta: null, tokens: [], drafts: { batches: [], singles: [] }, audit: [], fresh: null,

  count() {
    const d = this.drafts || { batches: [], singles: [] };
    return (d.singles || []).length + (d.batches || []).reduce((s, b) => s + (b.items || []).length, 0);
  },

  async api(path, opts) {
    /* 8 秒超时兜底：后端挂起时不让页面永远停在"读取中" */
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    let r;
    try {
      r = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" }, signal: c.signal }, opts || {}));
    } catch (e) {
      clearTimeout(t);
      throw new Error(c.signal.aborted ? "后端响应超时（8 秒），请检查服务是否正常" : "无法连接后端服务——请确认已在电脑上运行 node server.js");
    }
    clearTimeout(t);
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error("登录已失效，请返回首页重新验证家长身份");
    if (!r.ok) throw new Error(data.message || data.error || ("HTTP " + r.status));
    return data;
  },

  async load() {
    if (this.loading) return;
    this.loading = true; this.error = null;
    try {
      const [meta, tokens, drafts, audit] = await Promise.all([
        this.api("/api/ai/meta"), this.api("/api/ai/tokens"),
        this.api("/api/drafts"), this.api("/api/ai/audit")
      ]);
      this.meta = meta; this.tokens = tokens.tokens || [];
      this.drafts = { batches: drafts.batches || [], singles: drafts.singles || [] };
      this.audit = audit.entries || [];
      this.loaded = true;
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false;
      if (location.hash.startsWith("#/parent/ai")) route();
    }
  },

  async refresh() { this.loaded = false; await this.load(); },

  /* ---------- Token ---------- */
  newTokenModal() {
    if (!Parent.isAdmin()) return toast("只有爸爸/妈妈可以创建 API Token");
    const presets = this.meta ? this.meta.presets : {};
    modal("新建 API Token", `
      <div class="small muted mb12">给大模型客户端发一把"钥匙"。建议先用「家长助手 + 草稿模式」，确认效果后再考虑直接发布。</div>
      <div class="form-row"><label>用途名称</label><input id="tk-name" placeholder="如：Claude 建任务"></div>
      <div class="form-row"><label>权限预设</label>
        <select id="tk-preset">
          ${Object.keys(presets).map(k => `<option value="${k}" ${k === "assistant" ? "selected" : ""}>${esc(presets[k].label)} — ${esc(presets[k].desc)}</option>`).join("")}
        </select>
      </div>
      <div class="form-row"><label>写入方式</label>
        <div class="radio-col">
          <label class="check-row"><input type="radio" name="tk-mode" value="draft" checked> 草稿模式（推荐）：AI 建的任务先进待确认队列</label>
          <label class="check-row"><input type="radio" name="tk-mode" value="direct"> 直接发布：AI 建的任务立即下发到孩子平板</label>
        </div>
      </div>
      <div class="form-row"><label>有效期</label>
        <select id="tk-ttl">
          <option value="30">30 天</option><option value="90" selected>90 天</option>
          <option value="365">1 年</option><option value="">长期有效</option>
        </select>
      </div>`, [
      { label: "取消", cls: "btn-ghost", fn: null },
      {
        label: "生成 Token", cls: "btn-primary", fn: () => {
          const name = document.getElementById("tk-name").value.trim();
          if (!name) { toast("请填写用途名称"); return false; }
          const preset = document.getElementById("tk-preset").value;
          const mode = document.querySelector('input[name="tk-mode"]:checked').value;
          const ttl = document.getElementById("tk-ttl").value;
          AI.createToken({ name, preset, mode, ttlDays: ttl || null });
          return false; // 由异步结果关闭
        }
      }
    ], true);
  },

  async createToken(body) {
    try {
      const r = await this.api("/api/ai/tokens", { method: "POST", body: JSON.stringify(body) });
      this.fresh = r;
      closeModal();
      toast("Token 已生成，密钥只显示这一次");
      await this.refresh();
    } catch (e) { toast("生成失败：" + e.message); }
  },

  revoke(id) {
    if (!Parent.isAdmin()) return;
    const t = this.tokens.find(x => x.id === id);
    const name = t ? t.name : "该 Token";
    confirmModal("吊销 Token", `吊销「${esc(name)}」后，使用该 Token 的 AI 客户端会立即失去访问权限，且无法恢复。`, async () => {
      try { await this.api("/api/ai/tokens/" + id, { method: "DELETE" }); toast("已吊销"); await this.refresh(); }
      catch (e) { toast("失败：" + e.message); }
    });
  },

  configJSON() {
    const url = (this.meta && this.meta.mcp_url) || (location.origin + "/mcp");
    const token = this.fresh ? this.fresh.token : "<你的 Token>";
    return JSON.stringify({
      mcpServers: {
        hwbench: { type: "http", url, headers: { Authorization: "Bearer " + token } }
      }
    }, null, 2);
  },

  copy(text, tip) {
    const done = () => toast(tip || "已复制");
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => this.fallbackCopy(text, done));
    } else this.fallbackCopy(text, done);
  },
  fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("复制失败，请手动选择"); }
    ta.remove();
  },

  /* ---------- 草稿确认 ---------- */
  async confirmDraft(id) {
    try { const r = await this.api("/api/drafts/" + id + "/confirm", { method: "POST", body: "{}" });
      toast("已下发到孩子端"); await this.refresh(); if (Store.sync) Store.sync(); route();
    } catch (e) { toast("确认失败：" + e.message); }
  },
  async confirmBatch(id, n) {
    try { await this.api("/api/drafts/batch/" + id + "/confirm", { method: "POST", body: "{}" });
      toast(`已下发 ${n} 条任务`); await this.refresh(); if (Store.sync) Store.sync(); route();
    } catch (e) { toast("确认失败：" + e.message); }
  },
  async discard(id) {
    try { await this.api("/api/drafts/" + id, { method: "DELETE" }); toast("已丢弃"); await this.refresh(); }
    catch (e) { toast("失败：" + e.message); }
  },

  /* ---------- 渲染 ---------- */
  renderPage() {
    if (!this.loaded) {
      /* 关键：error 状态下不再自动重试，否则会形成 渲染→失败→route→渲染 的死循环把页面卡死 */
      if (!this.loading && !this.error) this.load();
      return `<div class="page"><div class="card"><div class="empty-tip">${this.error
        ? `⚠️ 读取 AI 接入信息失败<div class="mt8" style="color:var(--red)">${esc(this.error)}</div><button class="btn btn-outline btn-sm mt12" onclick="AI.refresh()">重试</button>`
        : `正在读取 AI 接入信息…`}</div></div></div>`;
    }
    const pending = this.count();
    return `<div class="page">
      <div class="flex-between">
        <div><div class="page-title">AI 接入 · 让大模型帮你建任务</div>
        <div class="page-sub">通过 MCP 协议把工作台授权给 Claude 等客户端；AI 写入默认先进入待确认队列</div></div>
        <div class="flex">
          <button class="btn btn-outline" onclick="AI.refresh()">刷新</button>
          ${Parent.isAdmin() ? `<button class="btn btn-primary" onclick="AI.newTokenModal()">+ 新建 Token</button>` : ""}
        </div>
      </div>

      ${this.renderFresh()}
      ${this.renderSteps()}
      ${this.renderDrafts(pending)}
      ${this.renderTokens()}
      ${this.renderAudit()}
    </div>`;
  },

  renderFresh() {
    if (!this.fresh) return "";
    return `<div class="card fresh-token">
      <h3>🔑 新 Token 已生成，只显示这一次</h3>
      <div class="code-line"><code>${esc(this.fresh.token)}</code>
        <button class="btn btn-outline btn-sm" onclick="AI.copy('${esc(this.fresh.token)}','Token 已复制')">复制</button></div>
      <div class="small muted mt12">把下面这段放到 MCP 客户端的配置里（Claude Desktop / Cursor / Cherry Studio 等）：</div>
      <pre class="code-block">${esc(this.configJSON())}</pre>
      <div class="flex mt8" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="AI.copy(AI.configJSON(),'配置已复制')">复制配置</button>
        <button class="btn btn-ghost btn-sm" onclick="AI.fresh=null;route()">我已保存，收起</button>
      </div>
      <div class="small muted mt12">Claude Code 命令行：<code>claude mcp add --transport http hwbench ${esc((this.meta && this.meta.mcp_url) || (location.origin + "/mcp"))} --header "Authorization: Bearer ${esc(this.fresh.token)}"</code></div>
    </div>`;
  },

  renderSteps() {
    return `<div class="card">
      <h3>三步接入</h3>
      <div class="step-grid">
        <div class="step"><b>1</b><div>新建 Token 并选择权限预设</div><div class="small muted">建议「家长助手 + 草稿模式」</div></div>
        <div class="step"><b>2</b><div>复制配置到 MCP 客户端</div><div class="small muted">端点 <code>${esc((this.meta && this.meta.mcp_url) || "/mcp")}</code></div></div>
        <div class="step"><b>3</b><div>在对话里说"帮我建今天的作业"</div><div class="small muted">AI 建的任务回到本页确认</div></div>
      </div>
      <div class="small muted mt12">可用工具：创建/批量创建任务、解析老师原文、写当天备注、建习惯与周期任务、查课表与完成情况；越权调用会被服务端拒绝。</div>
    </div>`;
  },

  renderDrafts(pending) {
    const d = this.drafts;
    const batchHtml = (d.batches || []).map(b => `
      <div class="draft-batch">
        <div class="flex-between">
          <div><b>${esc(b.date)}</b> <span class="tag tag-blue">${esc(b.token_name || "AI")}</span>
            <span class="small muted">${(b.items || []).length} 条待确认</span></div>
          ${Parent.isAdmin() ? `<button class="btn btn-green btn-sm" onclick="AI.confirmBatch('${b.id}',${(b.items || []).length})">整批确认并下发</button>` : ""}
        </div>
        ${b.note ? `<div class="draft-note small"><b>当天备注：</b>${esc(b.note).replace(/\n/g, "<br>")}</div>` : ""}
        ${(b.items || []).map(i => this.draftRow(i)).join("")}
      </div>`).join("");
    const singleHtml = (d.singles || []).length ? `
      <div class="draft-batch">
        <div class="flex-between"><div><b>零散任务</b> <span class="small muted">${d.singles.length} 条</span></div></div>
        ${d.singles.map(i => this.draftRow(i)).join("")}
      </div>` : "";
    return `<div class="card">
      <h3>📥 待确认任务 ${pending ? `<span class="badge-dot">${pending}</span>` : ""}</h3>
      ${pending ? batchHtml + singleHtml : `<div class="empty-tip">暂无待确认任务。AI 创建的任务会先出现在这里，确认后才下发给孩子。</div>`}
    </div>`;
  },

  draftRow(i) {
    const warn = (i.warnings || []);
    return `<div class="draft-item">
      <div class="flex-between">
        <div>
          <span class="kind-pill ${i.category === "习惯" ? "kind-task" : "kind-hw"}">${i.category === "习惯" ? "任务" : "作业"}</span>
          <b>${esc(i.title || "（无标题）")}</b>
          <div class="small muted mt8">${esc(i.subject || "其他")} · ${esc(i.type || "")}${i.need_recording ? " · 🎙录音" : ""}${i.estimated_minutes ? " · " + i.estimated_minutes + " 分钟" : ""}${i.timer_mode === "countdown" ? " · 倒计时" : ""}</div>
          ${warn.length ? `<div class="small warn-text mt8">⚠ ${warn.map(esc).join("；")}</div>` : ""}
        </div>
        ${Parent.isAdmin() ? `<div class="flex" style="gap:6px">
          <button class="btn btn-green btn-sm" onclick="AI.confirmDraft('${i.id}')">确认</button>
          <button class="btn btn-ghost btn-sm" onclick="AI.discard('${i.id}')">丢弃</button>
        </div>` : ""}
      </div>
    </div>`;
  },

  renderTokens() {
    const rows = this.tokens.map(t => {
      const revoked = !!t.revoked_at;
      return `<tr class="${revoked ? "row-muted" : ""}">
        <td><b>${esc(t.name)}</b><div class="small muted"><code>${esc(t.prefix)}…</code></div></td>
        <td>${(t.scopes || []).slice(0, 4).map(s => `<span class="scope-chip">${esc(this.scopeLabel(s))}</span>`).join("")}${(t.scopes || []).length > 4 ? `<span class="small muted">+${t.scopes.length - 4}</span>` : ""}</td>
        <td>${t.mode === "direct" ? `<span class="tag tag-orange">直接发布</span>` : `<span class="tag tag-blue">草稿</span>`}</td>
        <td class="small">${t.last_used_at ? t.last_used_at.slice(5, 16).replace("T", " ") : "未使用"}<div class="muted">${t.calls || 0} 次调用</div></td>
        <td class="small">${t.expires_at ? t.expires_at.slice(0, 10) : "长期"}</td>
        <td>${revoked ? `<span class="tag tag-gray">已吊销</span>` : (Parent.isAdmin() ? `<button class="btn btn-red btn-sm" onclick="AI.revoke('${t.id}')">吊销</button>` : "")}</td>
      </tr>`;
    }).join("");
    return `<div class="card" style="padding:0;overflow:hidden">
      <div style="padding:20px 20px 0"><h3>已授权的客户端</h3></div>
      <table class="grid"><thead><tr><th>名称</th><th>权限</th><th>写入方式</th><th>最近使用</th><th>有效期</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6"><div class="empty-tip">还没有 Token。新建一个，就能让 AI 帮你建任务。</div></td></tr>`}</tbody></table>
    </div>`;
  },

  renderAudit() {
    const rows = this.audit.slice(0, 12).map(e => `<tr>
      <td class="small">${(e.ts || "").slice(5, 16).replace("T", " ")}</td>
      <td class="small">${e.channel === "mcp" ? "MCP" : "后台"}</td>
      <td class="small"><b>${esc(e.action || "")}</b>${e.summary ? `<div class="muted">${esc(e.summary)}</div>` : ""}</td>
      <td class="small">${esc(e.token_name || "-")}</td>
      <td class="small">${e.ok ? `<span class="tag tag-green">成功</span>` : `<span class="tag tag-red">${esc(e.error || "失败")}</span>`}</td>
    </tr>`).join("");
    return `<div class="card" style="padding:0;overflow:hidden">
      <div style="padding:20px 20px 0"><h3>调用记录</h3><div class="small muted">最近 12 条，含 MCP 与后台操作</div></div>
      <table class="grid"><thead><tr><th>时间</th><th>通道</th><th>动作</th><th>Token</th><th>结果</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5"><div class="empty-tip">还没有调用记录</div></td></tr>`}</tbody></table>
    </div>`;
  },

  scopeLabel(s) {
    if (s === "*") return "全部权限";
    const map = { tasks: "任务", habits: "习惯", timetable: "课表", notes: "备注", review: "复核", import: "导入", report: "统计", settings: "设置" };
    const [m, a] = String(s).split(":");
    return (map[m] || m) + (a === "write" ? "读写" : "只读");
  }
};
