/* ========== 家长后台（Web） ========== */
const Parent = {
  importDraft: null,   // {raw, note, showNote, pinyin, tasks[], uncertain[]}
  SAMPLE: `学习内容：
10的加减法 (P56)
学习重点：
1.用10的分与合计算出10的加减法。
2.一图四式过渡到一图三式。(因为两道加法算式都是求总数，意义相同，得数相同，所以只写一道加法算式)
今日巩固：
1.【说一说】
请看下面两幅图，说出一图三式，并说出每个算式表示的意思。
2.如上
3.【背一背】
背10的分与合和加减法。`,

  isAdmin(){ return Store.db.settings.role==="admin"; },
  guard(){ if(!this.isAdmin()){ toast("爷爷奶奶为只读权限，不可编辑", null); return false; } return true; },

  nav(active){
    const pending = (typeof AI !== "undefined") ? AI.count() : 0;
    const revBadge = Store.db && Store.db.tasks ? Store.db.tasks.filter(t=>t.date===todayStr()&&t.status===STATUS.DONE).length : 0;
    const redBadge = (Store.db && Store.pendingRedemptions) ? Store.pendingRedemptions().length : 0;
    const items = [
      ["#/parent","今日任务"],["#/parent/import","文本导入"],["#/parent/review",`完成复核${revBadge?`<span class="nav-badge">${revBadge}</span>`:""}`],
      ["#/parent/report","周报"],
      ["#/parent/ai",`AI 接入${pending?`<span class="nav-badge">${pending}</span>`:""}`],
      ["#/parent/rewards",`奖励${redBadge?`<span class="nav-badge">${redBadge}</span>`:""}`],
      ["#/parent/mistakes","错题本"],["#/parent/tools","工具"],
      ["#/parent/habits","习惯任务"],["#/parent/timetable","课表管理"],
      ["#/parent/periods","周期任务"],["#/parent/settings","设置"]
    ];
    return `<div class="topbar">
      <div class="brand">👨‍👩‍👧 家长后台</div>
      <nav>${items.map(([h,t])=>`<a href="${h}" class="${active===h?'active':''}">${t}</a>`).join("")}</nav>
      <div class="role-switch">角色：
        <select onchange="Parent.switchRole(this.value)">
          <option value="admin" ${this.isAdmin()?"selected":""}>爸爸/妈妈（管理员）</option>
          <option value="readonly" ${!this.isAdmin()?"selected":""}>爷爷/奶奶（只读）</option>
        </select>
        <a href="#/" class="muted small" style="margin-left:8px">返回入口</a>
      </div>
    </div>`;
  },
  switchRole(r){ Store.db.settings.role=r; Store.save(); route(); toast(r==="admin"?"已切换：管理员":"已切换：只读（爷爷奶奶）"); },

  render(sub){
    switch(sub){
      case "import": return this.nav("#/parent/import") + this.renderImport();
      case "ai": return this.nav("#/parent/ai") + AI.renderPage();
      case "review": return this.nav("#/parent/review") + this.renderReview();
      case "report": return this.nav("#/parent/report") + this.renderReport();
      case "rewards": return this.nav("#/parent/rewards") + this.renderRewardsPage();
      case "mistakes": return this.nav("#/parent/mistakes") + this.renderMistakes();
      case "tools": return this.nav("#/parent/tools") + this.renderTools();
      case "habits": return this.nav("#/parent/habits") + this.renderHabits();
      case "timetable": return this.nav("#/parent/timetable") + this.renderTimetable();
      case "periods": return this.nav("#/parent/periods") + this.renderPeriods();
      case "settings": return this.nav("#/parent/settings") + this.renderSettings();
      default: return this.nav("#/parent") + this.renderToday();
    }
  },

  /* ---------- P2 今日任务 ---------- */
  renderToday(){
    const tasks = Store.getTodayTasks();
    const rows = tasks.map(t=>{
      const stTag = STATUS_TAG[t.status]||"tag-gray";
      const isHabit = t.category==="习惯";
      return `<tr>
        <td><span class="kind-pill ${isHabit?"kind-task":"kind-hw"}">${isHabit?"任务":"作业"}</span><b>${esc(t.title)}</b>
          <div class="small muted">${esc(t.subject)} · ${esc(t.type)}${t.need_recording?" · 🎙录音":""}${isHabit?" · 习惯":""}${t.co_parent?` · 👨‍👩‍👧亲子（${t.co_parent}）`:""}</div></td>
        <td>${t.timer_mode==="countdown"?`倒计时 ${t.limit_minutes||"?"}分钟`:"正计时"}</td>
        <td><span class="tag ${stTag}">${t.status}</span></td>
        <td>${t.actual_seconds!=null?fmtSec(t.actual_seconds):"-"}</td>
        <td>+${t.star_value||1}⭐</td>
        <td>${this.isAdmin() ? `${!isHabit?`<button class="btn btn-ghost btn-sm" onclick="Parent.saveTemplate('${t.id}')" title="存为常用模板">☆</button>`:""}
          <button class="btn btn-red btn-sm" onclick="Parent.delTask('${t.id}')">删除</button>`:""}</td>
      </tr>`;
    }).join("");
    const tpls = (Store.db.templates||[]);
    return `<div class="page">
      <div class="flex-between">
        <div><div class="page-title">今日任务发布 · ${dateCn(todayStr())}</div>
        <div class="page-sub">作业与习惯任务分开发布；支持复制昨日、常用模板，减少重复录入</div></div>
        ${this.isAdmin()?`<div class="flex">
          <button class="btn btn-outline" onclick="Parent.copyYesterday()">⧉ 复制昨日</button>
          <button class="btn btn-outline" onclick="Parent.batchTemplateModal()">📅 模板批量发布</button>
          <button class="btn btn-primary" onclick="Parent.newTaskModal()">+ 新建任务</button></div>`:""}
      </div>
      ${tpls.length?`<div class="card" style="padding:14px 16px">
        <div class="flex-between">
          <div class="small muted mb12">常用模板（点击直接发布到今天；「模板批量发布」可一次发布一整周）</div>
          ${this.isAdmin()?`<div class="flex">
            <button class="btn btn-ghost btn-sm" onclick="Parent.batchTemplateModal()">📅 批量发布一周</button>
            <button class="btn btn-ghost btn-sm" onclick="Parent.exportTemplates()">⬆ 导出分享</button>
            <label class="btn btn-ghost btn-sm" style="cursor:pointer">⬇ 导入模板<input type="file" accept="application/json" class="hidden" onchange="Parent.importTemplates(this)"></label>
          </div>`:""}
        </div>
        <div class="flex" style="flex-wrap:wrap">
          ${tpls.map(p=>`<span class="tpl-chip">
            <button class="btn btn-outline btn-sm" onclick="Parent.useTemplate('${p.id}')">${esc(p.title)} · ${esc(p.subject)}</button>
            ${this.isAdmin()?`<button class="tpl-del" title="删除模板" onclick="Parent.delTemplate('${p.id}')">×</button>`:""}
          </span>`).join("")}
        </div></div>`:""}
      ${this.undoneBanner(tasks)}
      <div class="card" style="padding:0;overflow:hidden">
        <table class="grid"><thead><tr><th>任务</th><th>计时</th><th>状态</th><th>用时</th><th>星星</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6"><div class="empty-tip">今天还没有任务，点击右上角新建、复制昨日或使用文本导入</div></td></tr>`}</tbody></table>
      </div>
    </div>`;
  },
  /* 未完成提示：18 点后高亮，21 点后转红 */
  undoneBanner(tasks){
    const undone = tasks.filter(t=>t.status!==STATUS.DONE && t.status!==STATUS.EXPIRED);
    if(!undone.length) return "";
    const h = new Date().getHours();
    if(h < 18) return "";
    const late = h >= 21;
    const bg = late ? "#fef2f2" : "#fffbeb", bd = late ? "#fecaca" : "#fde68a", fg = late ? "#b91c1c" : "#92400e";
    return `<div class="card" style="background:${bg};border-color:${bd};padding:14px 16px">
      <div class="flex-between" style="align-items:flex-start">
        <div>
          <b style="color:${fg}">${late?"⚠️ 已过 21:00":"🌙 今天还没完成"}：还有 ${undone.length} 项</b>
          <div class="small muted mt8">${undone.slice(0,4).map(t=>esc(t.title)).join(" · ")}${undone.length>4?" …":""}</div>
          <div class="small muted mt8">${late?"可考虑退回重做，或明天补上——不建议让孩子熬到很晚":"提醒孩子收个尾，或调整预计时长"}</div>
        </div>
        <a class="btn btn-outline btn-sm" href="#/parent/review">去复核</a>
      </div></div>`;
  },
  copyYesterday(){
    if(!this.guard())return;
    const y=yesterdayStr();
    const src=Store.db.tasks.filter(t=>t.date===y && t.category!=="习惯");
    if(!src.length) return toast("昨天没有可复制的作业");
    let n=0;
    src.forEach(t=>{
      if(Store.db.tasks.some(x=>x.date===todayStr() && x.title===t.title)) return;
      const copy=JSON.parse(JSON.stringify(t));
      Object.assign(copy,{ id:uid(), date:todayStr(), status:STATUS.TODO, actual_seconds:null,
        completed_at:null, reviewed_by:null, reviewed_at:null, star_awarded:0, parent_note:"", source:"手动" });
      delete copy.checks; delete copy.photo;
      Store.db.tasks.push(copy); n++;
    });
    Store.save(); route(); toast(`已复制 ${n} 个任务到今天`);
  },
  saveTemplate(id){
    if(!this.guard())return;
    const t=Store.getTask(id); if(!t) return;
    Store.db.templates.push({ id:uid(), title:t.title, subject:t.subject, type:t.type,
      category:t.category, note:t.note, estimated_minutes:t.estimated_minutes,
      timer_mode:t.timer_mode, limit_minutes:t.limit_minutes, overtime_remind:t.overtime_remind,
      allow_continue:t.allow_continue, need_recording:t.need_recording, star_value:t.star_value||1,
      co_parent:t.co_parent||null });
    Store.save(); route(); toast("已存为常用模板 ☆");
  },
  useTemplate(tplId){
    if(!this.guard())return;
    const p=Store.db.templates.find(x=>x.id===tplId); if(!p) return;
    Store.db.tasks.push(Object.assign({}, p, { id:uid(), date:todayStr(), source:"手动", status:STATUS.TODO,
      actual_seconds:null, completed_at:null, reviewed_by:null, reviewed_at:null, star_awarded:0, parent_note:"", created_by:"家长" }));
    Store.save(); route(); toast(`已发布「${p.title}」`);
  },
  delTemplate(tplId){
    if(!this.guard())return;
    const p=(Store.db.templates||[]).find(x=>x.id===tplId); if(!p) return;
    confirmModal("删除模板", `确定删除模板「${esc(p.title)}」？已发布的任务不受影响。`, ()=>{
      Store.remove("templates", tplId);   // 写墓碑，防止另一端旧快照同步复活
      route(); toast("已删除模板");
    });
  },

  /* ---------- 模板批量发布一周 ---------- */
  batchTemplateModal(){
    if(!this.guard())return;
    const tpls=Store.db.templates||[];
    if(!tpls.length) return toast("还没有常用模板：在今日任务列表点 ☆ 即可收藏");
    const days=[]; const d=new Date();
    for(let i=0;i<7;i++){ const x=new Date(d); x.setDate(d.getDate()+i); days.push(fmtDate(x)); }
    const tplRows=tpls.map(p=>`<label class="check-row"><input type="checkbox" class="bp-tpl" value="${p.id}" checked>
      ${esc(p.title)} · ${esc(p.subject)} · ${p.star_value||1}⭐</label>`).join("");
    const dayRows=days.map((ds,i)=>`<label class="check-row"><input type="checkbox" class="bp-day" value="${ds}" ${i===0?"checked":""}>
      ${dateCn(ds)} 周${"一二三四五六日"[(new Date(ds).getDay()+6)%7]}</label>`).join("");
    modal("模板批量发布", `<div class="small muted mb12">勾选模板与日期，一次性发布到孩子端。同一天同标题的任务会自动跳过，可放心重复发布。</div>
      <div class="form-row"><label>① 选择模板（${tpls.length} 个）</label><div class="bp-col">${tplRows}</div></div>
      <div class="form-row mt12"><label>② 选择日期（从今天起 7 天）</label><div class="bp-col">${dayRows}</div></div>
      <div id="bp-result" class="mt12"></div>`,[
      {label:"取消",cls:"btn-ghost",fn:null},
      {label:"立即发布",cls:"btn-primary",fn:()=>this.batchPublishTemplates()}
    ], true);
  },
  batchPublishTemplates(){
    const tpls=[...document.querySelectorAll(".bp-tpl:checked")].map(b=>Store.db.templates.find(x=>x.id===b.value)).filter(Boolean);
    const days=[...document.querySelectorAll(".bp-day:checked")].map(b=>b.value);
    if(!tpls.length || !days.length){
      const el=document.getElementById("bp-result");
      if(el) el.innerHTML=`<div class="overtime-banner">请至少选择一个模板和一个日期</div>`;
      return false;   // 不关闭弹窗
    }
    let added=0, skipped=0;
    days.sort().forEach(date=>{
      tpls.forEach(p=>{
        /* 去重：同日期同标题的任务不再重复发布 */
        if(Store.db.tasks.some(x=>x.date===date && x.title===p.title)){ skipped++; return; }
        Store.db.tasks.push(Object.assign({}, p, { id:uid(), date, source:"模板批量", status:STATUS.TODO,
          actual_seconds:null, completed_at:null, reviewed_by:null, reviewed_at:null,
          star_awarded:0, parent_note:"", created_by:"家长", updated_at:new Date().toISOString() }));
        added++;
      });
    });
    Store.save(); Store.generateToday();
    location.hash="#/parent";
    toast(`已发布 ${added} 个任务${skipped?`（跳过重复 ${skipped} 个）`:""} ✅`);
  },
  delTask(id){
    if(!this.guard())return;
    confirmModal("删除任务","确定删除该任务？其录音与记录将一并移除。",()=>{
      const t=Store.getTask(id);
      if(t) Store.revokeStar(id,"undo");
      delete Store.db.recordings[id];
      if(Store.db.photos) delete Store.db.photos[id];
      Store.remove("tasks", id);   // 写墓碑，避免其他设备把任务同步回来
      route(); toast("已删除");
    });
  },
  newTaskModal(){
    if(!this.guard())return;
    const html = `<div class="form-grid">
      <div class="form-row full"><label>任务标题 *</label><input id="nt-title" placeholder="如：口算练习 20 题"></div>
      <div class="form-row"><label>科目</label><select id="nt-subject">${["语文","数学","英语","音乐","体育","美术","其他"].map(s=>`<option>${s}</option>`).join("")}</select></div>
      <div class="form-row"><label>任务类型</label><select id="nt-type">${["书写","计算","练习","朗读","口述","背诵","其他"].map(s=>`<option>${s}</option>`).join("")}</select></div>
      <div class="form-row"><label>预计时长（分钟）</label><input id="nt-est" type="number" min="1" placeholder="10"></div>
      <div class="form-row"><label>计时模式</label><select id="nt-timer" onchange="document.getElementById('nt-limit-row').style.display=this.value==='countdown'?'flex':'none'">
        <option value="stopwatch">正计时（默认）</option><option value="countdown">倒计时</option></select></div>
      <div class="form-row" id="nt-limit-row" style="display:none"><label>限时分钟 *</label><input id="nt-limit" type="number" min="1"></div>
      <div class="form-row"><label>超时提醒（分钟）</label><input id="nt-remind" type="number" value="5" min="0"></div>
      <div class="form-row"><label>完成奖励星星</label><select id="nt-star">
        <option value="1">1 ⭐（默认）</option><option value="2">2 ⭐（较难任务）</option><option value="3">3 ⭐（挑战任务）</option></select></div>
      <div class="form-row full"><label class="check-row"><input id="nt-rec" type="checkbox"> 需要录音（朗读/口述/背诵类默认开启）</label></div>
      <div class="form-row full"><label class="check-row"><input id="nt-co" type="checkbox" onchange="document.getElementById('nt-co-role').style.display=this.checked?'inline-block':'none'"> 👨‍👩‍👧 亲子任务（和爸爸/妈妈一起完成）</label></div>
      <div class="form-row" id="nt-co-role" style="display:none"><label>一起完成的家长</label>
        <select id="nt-co-who"><option>爸爸</option><option>妈妈</option><option>任一家长</option></select></div>
      <div class="form-row full"><label class="check-row"><input id="nt-cont" type="checkbox" checked> 超时后允许继续</label></div>
      <div class="form-row full"><label>任务说明</label><textarea id="nt-note" rows="3"></textarea></div>
    </div>`;
    modal("新建今日任务", html, [
      {label:"取消", cls:"btn-ghost", fn:null},
      {label:"发布到孩子", cls:"btn-primary", fn:()=>{
        const title=document.getElementById("nt-title").value.trim();
        const timer=document.getElementById("nt-timer").value;
        const limit=parseInt(document.getElementById("nt-limit").value,10)||null;
        if(!title) return toast("标题不能为空"), false;
        if(timer==="countdown" && !limit) return toast("倒计时必须填写限时分钟"), false;
        const type=document.getElementById("nt-type").value;
        const recDefault = /朗读|口述|背诵/.test(type);
        const coChecked = document.getElementById("nt-co").checked;
        Store.db.tasks.push({
          id:uid(), date:todayStr(), title, subject:document.getElementById("nt-subject").value,
          category:/朗读|口述|背诵/.test(type)?"朗读口述背诵":"学业", type, source:"手动",
          co_parent: coChecked ? document.getElementById("nt-co-who").value : null,
          note:document.getElementById("nt-note").value, estimated_minutes:parseInt(document.getElementById("nt-est").value,10)||null,
          timer_mode:timer, limit_minutes:limit, overtime_remind:parseInt(document.getElementById("nt-remind").value,10),
          allow_continue:document.getElementById("nt-cont").checked,
          need_recording:document.getElementById("nt-rec").checked || recDefault,
          star_value:parseInt(document.getElementById("nt-star").value,10)||1,
          period_rule_id:null, status:STATUS.TODO, actual_seconds:null, completed_at:null,
          reviewed_by:null, reviewed_at:null, star_awarded:0, parent_note:"", created_by:"家长"
        });
        Store.save(); route(); toast("已发布到孩子端 ✅");
      }}
    ], true);
  },

  /* ---------- P3 文本导入 ---------- */
  renderImport(){
    if(!this.importDraft){
      return `<div class="page">
        <div class="page-title">文本导入</div>
        <div class="page-sub">粘贴老师发的作业通知，系统自动识别：学习内容/学习重点 → 当天备注；【说一说】【背一背】等 → 待确认任务；无法判断 → 不确定段落区</div>
        <div class="card">
          <h3>① 粘贴原文</h3>
          <textarea id="import-raw" rows="12" style="width:100%" placeholder="粘贴老师发的文本…">${esc(this.SAMPLE)}</textarea>
          <div class="mt12 flex">
            ${this.isAdmin()?`<button class="btn btn-primary" onclick="Parent.doParse()">② 智能解析</button>
            <button class="btn btn-outline" onclick="Parent.startVoiceImport()">🎤 语音输入</button>`:`<span class="tag tag-gray">只读权限不可导入</span>`}
          </div>
          <div class="small muted mt8">🎤 语音输入：点一下对着麦克风念老师发的作业（Chrome/Edge 支持），念完自动填入上方文本框再解析。</div>
        </div>
      </div>`;
    }
    const d = this.importDraft;
    // ---- 右侧：备注区 ----
    const noteHtml = `<div class="card"><h3>A. 当天备注区</h3>
      <textarea id="cf-note" rows="4" style="width:100%">${esc(d.note)}</textarea>
      <div class="flex mt8">
        <label class="check-row"><input type="checkbox" id="cf-shownote" ${d.showNote?"checked":""}> 显示给孩子</label>
        <label class="check-row"><input type="checkbox" id="cf-pinyin" ${d.pinyin?"checked":""}> 一年级注音</label>
      </div></div>`;
    // ---- 右侧：任务卡 ----
    const cardsHtml = d.tasks.map((t,i)=>this.taskEditCard(t,i)).join("") || `<div class="empty-tip">未识别到任务</div>`;
    // ---- 右侧：不确定段落 ----
    const uncHtml = d.uncertain.map(u=>`
      <div class="uncertain-item">
        <div class="orig">${esc(u.text)}</div>
        <div class="flex">
          <button class="btn btn-outline btn-sm" onclick="Parent.uncToTask('${u._key}')">转为任务</button>
          <button class="btn btn-outline btn-sm" onclick="Parent.uncMerge('${u._key}')">合并到上一任务</button>
          <button class="btn btn-ghost btn-sm" onclick="Parent.uncIgnore('${u._key}')">忽略</button>
        </div>
      </div>`).join("") || `<div class="empty-tip">没有不确定段落</div>`;
    // ---- 发布区 ----
    const pubHtml = `<div class="card"><h3>D. 发布区</h3>
      <div class="form-grid">
        <div class="form-row"><label>发布范围</label>
          <select id="pub-freq" onchange="document.getElementById('pub-weekdays').style.display=this.value==='weekly'?'flex':'none'">
            <option value="once">仅今天</option><option value="daily">每天</option><option value="weekly">每周几</option>
          </select></div>
        <div class="form-row"><label>生效日期</label><input id="pub-start" type="date" value="${todayStr()}"></div>
        <div class="form-row"><label>结束日期（可空）</label><input id="pub-end" type="date"></div>
        <div class="form-row full" id="pub-weekdays" style="display:none"><label>每周几</label>
          <div class="weekday-picks">${[1,2,3,4,5,6,7].map(w=>`<button type="button" data-w="${w}" onclick="this.classList.toggle('on')">${"一二三四五六日"[w-1]}</button>`).join("")}</div>
        </div>
      </div>
      <div class="flex mt16">
        <button class="btn btn-primary btn-lg" style="padding:12px 28px" onclick="Parent.publish()">✅ 发布到孩子</button>
        <button class="btn btn-ghost" onclick="Parent.importDraft=null;route()">重新粘贴</button>
      </div>
      <div id="pub-errors" class="mt12"></div>
    </div>`;

    return `<div class="page" style="max-width:1280px">
      <div class="page-title">文本导入 · 二次处理确认</div>
      <div class="page-sub">左侧为老师原文（只读），右侧逐项确认后发布</div>
      <div class="import-split">
        <div><div class="card"><h3>原文</h3><div class="orig-box">${esc(d.raw)}</div></div></div>
        <div>${noteHtml}<div class="card"><h3>B. 待确认任务卡片（${d.tasks.length}）</h3>${cardsHtml}</div>
             <div class="card"><h3>C. 不确定段落区（${d.uncertain.length}）</h3>${uncHtml}</div>${pubHtml}</div>
      </div>
    </div>`;
  },

  taskEditCard(t,i){
    const k = t._key;
    return `<div class="task-edit-card ${t.needConfirm?"need-confirm":""}">
      ${t.needConfirm?`<div class="tag tag-orange mb12">⚠ 需确认：请修改标题与字段</div>`:""}
      <div class="form-grid">
        <div class="form-row full"><label>任务标题 *</label><input value="${esc(t.title)}" onchange="Parent.draftSet('${k}','title',this.value)"></div>
        <div class="form-row"><label>科目</label><select onchange="Parent.draftSet('${k}','subject',this.value)">${SUBJECTS.concat(["其他"]).filter((v,i,a)=>a.indexOf(v)===i).map(s=>`<option ${t.subject===s?"selected":""}>${s}</option>`).join("")}</select></div>
        <div class="form-row"><label>任务类型</label><select onchange="Parent.draftSet('${k}','type',this.value)">${["口述","背诵","朗读","书写","计算","练习","听力","其他"].map(s=>`<option ${t.type===s?"selected":""}>${s}</option>`).join("")}</select></div>
        <div class="form-row"><label>预计时长（分钟）</label><input type="number" min="1" value="${t.estimated_minutes||""}" onchange="Parent.draftSet('${k}','estimated_minutes',this.value?parseInt(this.value):null)"></div>
        <div class="form-row"><label>计时模式</label>
          <select onchange="Parent.draftSet('${k}','timer_mode',this.value);route()">
            <option value="stopwatch" ${t.timer_mode==="stopwatch"?"selected":""}>正计时</option>
            <option value="countdown" ${t.timer_mode==="countdown"?"selected":""}>倒计时</option>
          </select></div>
        ${t.timer_mode==="countdown"?`<div class="form-row"><label>限时分钟 *</label><input type="number" min="1" value="${t.limit_minutes||""}" onchange="Parent.draftSet('${k}','limit_minutes',this.value?parseInt(this.value):null)"></div>`:""}
        <div class="form-row"><label>超时提醒（分钟）</label><input type="number" min="0" value="${t.overtime_remind??5}" onchange="Parent.draftSet('${k}','overtime_remind',parseInt(this.value))"></div>
        <div class="form-row"><label>完成奖励星星</label>
          <select onchange="Parent.draftSet('${k}','star_value',parseInt(this.value))">
            ${[1,2,3].map(n=>`<option value="${n}" ${(t.star_value||1)===n?"selected":""}>${n} ⭐</option>`).join("")}
          </select></div>
        <div class="form-row full">
          <label class="check-row"><input type="checkbox" ${t.need_recording?"checked":""} onchange="Parent.draftSet('${k}','need_recording',this.checked)"> 需要录音</label>
          <label class="check-row"><input type="checkbox" ${t.allow_continue?"checked":""} onchange="Parent.draftSet('${k}','allow_continue',this.checked)"> 超时后允许继续</label>
        </div>
        <div class="form-row full"><label>任务说明</label><textarea rows="3" onchange="Parent.draftSet('${k}','note',this.value)">${esc(t.note||"")}</textarea></div>
        <div class="form-row full"><button class="btn btn-red btn-sm" style="width:90px" onclick="Parent.draftDel('${k}')">删除卡片</button></div>
      </div>
    </div>`;
  },

  doParse(){
    if(!this.guard())return;
    const raw = document.getElementById("import-raw").value;
    if(!raw.trim()) return toast("请先粘贴文本");
    const r = parseHomeworkText(raw);
    this.importDraft = { raw, note:r.note, showNote:true, pinyin:Store.db.settings.gradeMode===1,
      tasks:r.tasks, uncertain:r.uncertain };
    route(); toast(`解析完成：${r.tasks.length} 个任务，${r.uncertain.length} 段不确定`);
  },
  /* 语音输入（F-2）：念出作业内容 → 转文字 → 走同一解析链路 */
  startVoiceImport(){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR) return toast("当前浏览器不支持语音识别，请用 Chrome/Edge，或直接粘贴文本");
    if(!this.guard()) return;
    try{
      const rec=new SR();
      rec.lang="zh-CN"; rec.interimResults=false; rec.continuous=true;
      let got="";
      /* 持续收音；静默 2.5 秒自动停止，避免 continuous 一直挂着 */
      rec.onresult=e=>{ for(let i=e.resultIndex;i<e.results.length;i++) got+=e.results[i][0].transcript;
        clearTimeout(this._vt); this._vt=setTimeout(()=>{ try{ rec.stop(); }catch(e){} }, 2500); };
      rec.onend=()=>{
        const ta=document.getElementById("import-raw");
        if(ta && got.trim()){ ta.value=(ta.value?ta.value+"\n":"")+got.trim(); toast("语音已填入，检查一遍再点「智能解析」", null, 5000); }
        else toast("没有识别到内容，再试一次");
        const b=document.getElementById("voice-btn"); if(b){ b.textContent="🎤 语音输入"; b.disabled=false; }
      };
      rec.onerror=e=>{
        toast(e.error==="not-allowed"?"请允许浏览器使用麦克风":"语音识别失败："+e.error);
        const b=document.getElementById("voice-btn"); if(b){ b.textContent="🎤 语音输入"; b.disabled=false; }
      };
      rec.start();
      const b=document.getElementById("voice-btn")||document.querySelector("[onclick*='startVoiceImport']");
      if(b){ b.id="voice-btn"; b.textContent="🔴 正在听…（说完稍等自动填入）"; b.disabled=true; }
      toast("请开始念作业内容，念完停顿 2 秒自动结束", null, 6000);
      this._vt=setTimeout(()=>{ try{ rec.stop(); }catch(e){} }, 30000);
    }catch(e){ toast("无法启动语音识别"); }
  },
  draftSet(key, field, val){
    const t = this.importDraft.tasks.find(x=>x._key===key); if(!t) return;
    t[field]=val;
    if(field==="title" && val.trim() && !val.includes("请修改")) t.needConfirm=false;
  },
  draftDel(key){
    if(!this.guard())return;
    this.importDraft.tasks = this.importDraft.tasks.filter(x=>x._key!==key); route();
  },
  uncToTask(key){
    if(!this.guard())return;
    const u = this.importDraft.uncertain.find(x=>x._key===key); if(!u) return;
    this.importDraft.uncertain = this.importDraft.uncertain.filter(x=>x._key!==key);
    this.importDraft.tasks.push({ _key:uid(), title:cleanTitle(u.text).slice(0,24)||"新任务", subject:detectSubject(u.text),
      type:"其他", need_recording:false, estimated_minutes:detectMinutes(u.text), note:u.text, needConfirm:true,
      timer_mode:"stopwatch", limit_minutes:null, overtime_remind:5, allow_continue:true });
    route(); toast("已转为任务，请完善字段");
  },
  uncMerge(key){
    if(!this.guard())return;
    const tasks=this.importDraft.tasks;
    if(!tasks.length) return toast("没有可合并的任务");
    const u = this.importDraft.uncertain.find(x=>x._key===key); if(!u) return;
    this.importDraft.uncertain = this.importDraft.uncertain.filter(x=>x._key!==key);
    const last = tasks[tasks.length-1];
    last.note = (last.note? last.note+"\n":"") + u.text;
    route(); toast(`已合并到「${last.title}」`);
  },
  uncIgnore(key){
    if(!this.guard())return;
    this.importDraft.uncertain = this.importDraft.uncertain.filter(x=>x._key!==key); route();
  },

  publish(){
    if(!this.guard())return;
    const d=this.importDraft;
    const freq=document.getElementById("pub-freq").value;
    const start=document.getElementById("pub-start").value || todayStr();
    const end=document.getElementById("pub-end").value || null;
    const weekdays=[...document.querySelectorAll("#pub-weekdays button.on")].map(b=>parseInt(b.dataset.w));
    // 校验（冻结规则：标题非空 / 倒计时必填限时 / 每周几至少一天）
    d.tasks.forEach(t=>{ t._freq=freq; t._weekdays=weekdays; });
    const errs = validatePublish(d.tasks);
    if(freq==="weekly" && !weekdays.length) errs.push("发布范围为「每周几」时至少选择一天");
    if(d.tasks.length===0) errs.push("没有可发布的任务");
    if(errs.length){
      document.getElementById("pub-errors").innerHTML =
        `<div class="overtime-banner" style="text-align:left">发布校验未通过：<br>• ${errs.join("<br>• ")}</div>`;
      return;
    }
    // 保存备注
    Store.db.notes[start] = { note:document.getElementById("cf-note").value,
      show_to_child:document.getElementById("cf-shownote").checked,
      pinyin_enabled:document.getElementById("cf-pinyin").checked, created_by:"家长" };
    // 生成周期规则（模板）→ 由 generateToday 落实例
    for(const t of d.tasks){
      const cat = /口述|背诵|朗读/.test(t.type)?"朗读口述背诵":"学业";
      Store.db.periodRules.push({
        id:uid(), freq, weekdays: freq==="weekly"?weekdays:null,
        start_date:start, end_date:end, active:true,
        template:{ title:t.title.trim(), subject:t.subject, category:cat, type:t.type, source:"文本导入",
          note:t.note||"", estimated_minutes:t.estimated_minutes||null, timer_mode:t.timer_mode,
          limit_minutes:t.limit_minutes||null, overtime_remind:t.overtime_remind??5,
          allow_continue:t.allow_continue, need_recording:t.need_recording,
          star_value:t.star_value||1, created_by:"家长" }
      });
    }
    Store.save(); Store.generateToday();
    const n=d.tasks.length;
    this.importDraft=null;
    location.hash="#/parent";
    toast(`已发布 ${n} 个任务到孩子端 ✅`);
  },

  /* ---------- P7 完成情况与复核（工作台） ---------- */
  reviewFilter:"today",
  reviewSel:{},
  reviewRecOnly:false,

  renderReview(){
    const today = todayStr();
    const all = Store.db.tasks.filter(t=>t.status===STATUS.DONE || t.status===STATUS.REJECTED);
    const cntToday = all.filter(t=>t.date===today).length;
    const cntRej = all.filter(t=>t.status===STATUS.REJECTED).length;

    let list = this.reviewFilter==="rejected" ? all.filter(t=>t.status===STATUS.REJECTED)
             : this.reviewFilter==="all" ? all
             : all.filter(t=>t.date===today);
    if(this.reviewRecOnly) list = list.filter(t=>Store.getRecordings(t.id).length>0);
    list = list.slice().sort((a,b)=>(b.completed_at||b.reviewed_at||"").localeCompare(a.completed_at||a.reviewed_at||""));

    const selIds = Object.keys(this.reviewSel).filter(id=>list.some(t=>t.id===id));
    const recTotal = list.reduce((s,t)=>s+Store.getRecordings(t.id).length,0);

    const tabs = [
      ["today",`今天 ${cntToday}`],["all",`全部 ${all.length}`],["rejected",`已退回 ${cntRej}`]
    ].map(([k,label])=>`<button class="btn btn-sm ${this.reviewFilter===k?"btn-primary":"btn-ghost"}" onclick="Parent.setReviewFilter('${k}')">${label}</button>`).join("");

    const rows = list.map(t=>{
      const recs = Store.getRecordings(t.id);
      const checked = !!this.reviewSel[t.id];
      const recHtml = recs.map((r,i)=>`
        <div class="rec-item ${r.rejected?"rejected":""}">
          <span class="small muted">#${i+1} ${fmtSec(r.duration)}${r.rejected?' <span class="tag tag-red">已退回</span>':""}</span>
          <audio controls preload="none" src="${r.url||r.dataUrl}"></audio>
        </div>`).join("");
      return `<div class="review-item ${checked?"sel":""}">
        <input type="checkbox" class="ri-check" ${checked?"checked":""} onchange="Parent.toggleReviewSel('${t.id}')">
        <div class="ri-main">
          <div class="flex-between" style="align-items:flex-start">
            <div><b style="font-size:15.5px">${esc(t.title)}</b>
              <div class="small muted mt8">
                ${t.date===today?"今天":t.date} · ${esc(t.subject)} · ${esc(t.type)}
                · 用时 ${t.actual_seconds!=null?fmtSec(t.actual_seconds):"-"} · ⭐${t.star_awarded||0}
                ${recs.length?` · 🎙${recs.length} 段`:""}
              </div>
              ${t.parent_note?`<div class="small mt8" style="color:var(--red)">退回原因：${esc(t.parent_note)}</div>`:""}
            </div>
            <div class="flex" style="flex:0 0 auto">
              <span class="tag ${t.status===STATUS.DONE?"tag-green":"tag-red"}">${t.status}</span>
              ${t.co_parent ? (t.co_done_at
                ? `<span class="tag tag-green" title="${esc(t.co_done_by||"")} ${esc((t.co_done_at||"").slice(0,10))}">👨‍👩‍👧 已一起完成</span>`
                : (this.isAdmin() && t.status===STATUS.DONE ? `<button class="btn btn-outline btn-sm" title="确认和孩子共同完成了这项亲子任务" onclick="Parent.confirmCo('${t.id}')">👨‍👩‍👧 一起做了</button>` : `<span class="tag tag-orange">👨‍👩‍👧 待确认</span>`)) : ""}
              ${this.isAdmin() && t.status===STATUS.DONE ? `<button class="btn btn-outline btn-sm" title="录一段语音鼓励，孩子下次完成任务时播放" onclick="Parent.recordEncouragement('${t.id}')">🎤</button>
                <button class="btn btn-red btn-sm" onclick="Parent.rejectModal('${t.id}')">退回重做</button>`:""}
            </div>
          </div>
          ${recHtml?`<div class="mt12">${recHtml}</div>`:`<div class="small muted mt12">无录音</div>`}
        </div>
      </div>`;
    }).join("");

    return `<div class="page page-narrow">
      <div class="page-title">完成情况与复核</div>
      <div class="page-sub">孩子勾选即完成、完成即得星；复核仅「退回」——退回撤销星星、录音保留并标记，任务回到孩子端重做</div>
      <div class="review-bar">
        ${tabs}
        <label class="small muted flex" style="gap:6px">
          <input type="checkbox" ${this.reviewRecOnly?"checked":""} onchange="Parent.toggleRecOnly()">只看有录音
        </label>
        <div style="flex:1"></div>
        <button class="btn btn-outline btn-sm" onclick="Parent.playAll()" ${recTotal?"":"disabled"}>▶ 连播录音${recTotal?`（${recTotal} 段）`:""}</button>
        ${this.isAdmin()?`<button class="btn btn-ghost btn-sm" onclick="Parent.selectAll()">${selIds.length?"取消全选":"全选"}</button>
        <button class="btn btn-red btn-sm" ${selIds.length?"":"disabled"} onclick="Parent.batchReject()">批量退回${selIds.length?`（${selIds.length}）`:""}</button>`:""}
      </div>
      ${rows || `<div class="card"><div class="empty-tip">${this.reviewRecOnly?"当前筛选下没有带录音的任务":"暂无已完成任务"}</div></div>`}
    </div>`;
  },
  setReviewFilter(f){ this.reviewFilter=f; this.reviewSel={}; route(); },
  /* D-3 亲子任务确认：不干预星星（勾选即得星的冻结规则不变），只作共同完成记录 */
  confirmCo(id){
    if(!this.guard())return;
    if(Store.confirmCoParent(id, "爸爸/妈妈")) { route(); toast("👨‍👩‍👧 已记录一次共同完成，孩子看到会很有成就感"); }
  },
  toggleRecOnly(){ this.reviewRecOnly=!this.reviewRecOnly; route(); },
  toggleReviewSel(id){
    if(this.reviewSel[id]) delete this.reviewSel[id]; else this.reviewSel[id]=true;
    route();
  },
  selectAll(){
    const today = todayStr();
    let list = this.reviewFilter==="rejected" ? Store.db.tasks.filter(t=>t.status===STATUS.REJECTED)
             : this.reviewFilter==="all" ? Store.db.tasks.filter(t=>t.status===STATUS.DONE||t.status===STATUS.REJECTED)
             : Store.db.tasks.filter(t=>t.date===today && (t.status===STATUS.DONE||t.status===STATUS.REJECTED));
    if(this.reviewRecOnly) list = list.filter(t=>Store.getRecordings(t.id).length>0);
    const has = Object.keys(this.reviewSel).length>0;
    this.reviewSel = {};
    if(!has) list.forEach(t=>{ if(t.status===STATUS.DONE) this.reviewSel[t.id]=true; });
    route();
  },
  playAll(){
    const audios = [...document.querySelectorAll(".review-item audio")];
    if(!audios.length) return toast("没有可播放的录音");
    let i = 0;
    const next = ()=>{
      if(i >= audios.length){ toast("录音已全部播放完毕"); return; }
      const a = audios[i++];
      const tip = document.createElement("div");
      a.onended = next;
      a.onerror = next;
      a.play().catch(()=>next());
    };
    toast(`开始连播 ${audios.length} 段录音`);
    next();
  },
  batchReject(){
    if(!this.guard()) return;
    const ids = Object.keys(this.reviewSel);
    if(!ids.length) return toast("请先勾选要退回的任务");
    modal("批量退回", `<div class="small muted mb12">将退回 ${ids.length} 个任务，撤销对应星星，任务回到孩子端重做，录音保留并标记「已退回」。</div>
      <div class="form-row"><label>退回原因（孩子端可见，可留空）</label>
      <textarea id="rej-batch" rows="3" placeholder="如：今天这几项请再检查一遍"></textarea></div>`,[
      {label:"取消",cls:"btn-ghost",fn:null},
      {label:`确认退回 ${ids.length} 项`,cls:"btn-red",fn:()=>{
        const reason = document.getElementById("rej-batch").value.trim() || "请再检查一遍";
        const who = Store.db.settings.role==="admin" ? "爸爸/妈妈" : "家长";
        ids.forEach(id=>Store.rejectTask(id, reason, who));
        this.reviewSel = {};
        route(); toast(`已退回 ${ids.length} 项：星星已撤销，任务回到孩子端`);
      }}
    ], true);
  },

  /* ---------- P8 家长周报 ---------- */
  renderReport(){
    const days = 7;
    const today = new Date();
    const rows = [];
    for(let i=days-1;i>=0;i--){
      const d = new Date(today); d.setDate(today.getDate()-i);
      const ds = fmtDate(d);
      const list = Store.db.tasks.filter(t=>t.date===ds && t.status!==STATUS.EXPIRED);
      const done = list.filter(t=>t.status===STATUS.DONE);
      const secs = done.reduce((s,t)=>s+(t.actual_seconds||0),0);
      rows.push({
        date: ds, label: `${d.getMonth()+1}/${d.getDate()}`, wd: "日一二三四五六"[d.getDay()],
        total: list.length, done: done.length,
        rate: list.length ? Math.round(done.length/list.length*100) : 0,
        avg: done.length ? Math.round(secs/done.length) : 0,
        stars: done.reduce((s,t)=>s+(t.star_awarded||0),0),
        recs: done.reduce((s,t)=>s+Store.getRecordings(t.id).length,0),
        rejected: Store.db.tasks.filter(t=>t.date===ds && t.status===STATUS.REJECTED).length
      });
    }
    const totalTasks = rows.reduce((s,r)=>s+r.total,0);
    const totalDone = rows.reduce((s,r)=>s+r.done,0);
    const rate = totalTasks ? Math.round(totalDone/totalTasks*100) : 0;
    const totalSecs = rows.reduce((s,r)=>s+r.avg*r.done,0);
    const avgMin = totalDone ? Math.round(totalSecs/totalDone/60) : 0;
    const stars = rows.reduce((s,r)=>s+r.stars,0);
    const recs = rows.reduce((s,r)=>s+r.recs,0);
    const rej = rows.reduce((s,r)=>s+r.rejected,0);
    const maxMin = Math.max(60, ...rows.map(r=>r.avg/60));

    const bars = rows.map(r=>{
      const h = r.total ? Math.max(4, Math.round(r.rate/100*140)) : 4;
      const cls = !r.total ? "zero" : (r.done===r.total ? "full" : "");
      return `<div class="bar-col">
        <div class="bar-num">${r.total?r.rate+"%":"-"}<div class="small" style="opacity:.6">${r.done}/${r.total}</div></div>
        <div class="bar ${cls}" style="height:${h}px"></div>
        <div class="bar-day">${r.label}<div class="small" style="opacity:.55">周${r.wd}</div></div>
      </div>`;
    }).join("");

    const subjectStats = {};
    Store.db.tasks.filter(t=>t.status!==STATUS.EXPIRED && rows.some(r=>r.date===t.date)).forEach(t=>{
      const s = subjectStats[t.subject] || (subjectStats[t.subject]={total:0,done:0,secs:0});
      s.total++; if(t.status===STATUS.DONE){ s.done++; s.secs += t.actual_seconds||0; }
    });
    const subjectRows = Object.keys(subjectStats).map(k=>{
      const s = subjectStats[k];
      const r = s.total?Math.round(s.done/s.total*100):0;
      return `<tr><td><b>${esc(k)}</b></td><td>${s.done}/${s.total}</td>
        <td><div class="progress-bar" style="height:8px"><i style="width:${r}%"></i></div></td>
        <td>${r}%</td><td>${s.done?Math.round(s.secs/s.done/60)+" 分钟":"-"}</td></tr>`;
    }).join("") || `<tr><td colspan="5"><div class="empty-tip">暂无数据</div></td></tr>`;

    const insights = [];
    if(rate >= 90) insights.push("本周完成率很高，可以适当肯定孩子的坚持 👍");
    else if(rate < 60) insights.push("完成率偏低，建议检查每日任务量是否过多，或把长任务拆成两段");
    if(rej > 0) insights.push(`本周退回 ${rej} 次，可留意同类任务是否难度偏高`);
    if(avgMin >= 40) insights.push("单任务平均用时偏长，注意是否中途注意力分散");
    if(recs >= 5) insights.push(`本周共 ${recs} 段朗读录音，建议抽时间听 1–2 段`);
    const busiest = rows.slice().sort((a,b)=>b.total-a.total)[0];
    if(busiest && busiest.total >= 5) insights.push(`${busiest.label} 任务最多（${busiest.total} 项），可考虑那天少排一点`);

    /* 错题指标（D-4） */
    const weekDates=rows.map(r=>r.date);
    const mistakeOpen=Store.getMistakes().length;
    const mistakeNew=(Store.db.mistakes||[]).filter(m=>weekDates.includes((m.created_at||"").slice(0,10))).length;
    if(mistakeOpen >= 5) insights.push(`错题本已有 ${mistakeOpen} 题未消化，建议周末安排一次重练`);
    else if(mistakeNew > 0 && mistakeOpen === 0) insights.push(`本周新错题 ${mistakeNew} 题已全部消化 👏`);
    /* 亲子任务（D-3） */
    const co=Store.coStats(weekDates);
    if(co.total > 0){
      if(co.done === co.total) insights.push(`本周 ${co.total} 个亲子任务全部共同完成，这是最有分量的陪伴 💛`);
      else insights.push(`本周亲子任务 ${co.total} 个，已共同完成 ${co.done} 个——亲子任务的星星之外，陪伴本身就是奖励`);
    }

    /* 习惯热力图（F-4）：近 8 周 习惯 × 周 完成率 */
    const heat=this.habitHeatmap(8);

    return `<div class="page page-narrow">
      <div class="flex-between">
        <div><div class="page-title">家长周报 · 近 7 天</div>
        <div class="page-sub">只统计完成率、用时与录音数量，不做自动语音评分（第一版边界）</div></div>
        <div class="flex">
          <button class="btn btn-outline" onclick="Parent.copyAiSummary()">🤖 复制给 AI 总结</button>
          <button class="btn btn-ghost" onclick="route()">刷新</button>
        </div>
      </div>
      <div class="report-grid">
        <div class="metric"><div class="m-label">完成率</div><div class="m-value">${rate}%</div><div class="m-note">${totalDone}/${totalTasks} 项</div></div>
        <div class="metric"><div class="m-label">平均单任务用时</div><div class="m-value">${avgMin}<span style="font-size:14px"> 分</span></div><div class="m-note">按已完成任务计算</div></div>
        <div class="metric"><div class="m-label">获得星星</div><div class="m-value">⭐ ${stars}</div><div class="m-note">累计 ${Store.db.points.total} ⭐ · 可兑换余额</div></div>
        <div class="metric"><div class="m-label">朗读录音</div><div class="m-value">${recs}<span style="font-size:14px"> 段</span></div><div class="m-note">退回 ${rej} 次</div></div>
        <div class="metric"><div class="m-label">错题本</div><div class="m-value">${mistakeOpen}<span style="font-size:14px"> 题未消化</span></div><div class="m-note">本周新增 ${mistakeNew} 题</div></div>
      </div>
      <div class="card mt16">
        <h3>每日完成率</h3>
        <div class="bar-chart">${bars}</div>
      </div>
      ${heat?`<div class="card mt16"><h3>习惯坚持热力图（近 8 周）</h3>
        <div class="small muted mb12">颜色越深完成率越高；一眼看出哪个习惯总在断档</div>
        <div class="heat-wrap">${heat}</div></div>`:""}
      <div class="card mt16">
        <h3>分科目表现</h3>
        <table class="grid"><thead><tr><th>科目</th><th>完成</th><th>完成率</th><th></th><th>平均用时</th></tr></thead>
        <tbody>${subjectRows}</tbody></table>
      </div>
      <div class="card mt16">
        <h3>观察建议</h3>
        ${insights.length?`<ul style="padding-left:20px;line-height:2;font-size:13.5px;color:var(--text2)">${insights.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`
          :`<div class="small muted">本周数据还不多，继续记录几天就能看到趋势。</div>`}
      </div>
    </div>`;
  },
  /* 习惯 × 周 完成率热力图（纯 CSS 表格） */
  habitHeatmap(weeks){
    const habits=Store.db.habits.filter(h=>h.active!==false);
    if(!habits.length) return "";
    const monday=d=>{ const x=new Date(d); const off=(x.getDay()+6)%7; x.setDate(x.getDate()-off); return x; };
    const thisMon=monday(new Date());
    const weekStarts=[];
    for(let i=weeks-1;i>=0;i--){ const x=new Date(thisMon); x.setDate(thisMon.getDate()-i*7); weekStarts.push(fmtDate(x)); }
    /* 任务按 (habit_id, week) 聚合 */
    const from=weekStarts[0], to=fmtDate(new Date());
    const buckets={};
    Store.db.tasks.filter(t=>t.habit_id && t.date>=from && t.date<=to && t.status!==STATUS.EXPIRED).forEach(t=>{
      const ws=fmtDate(monday(t.date));
      const key=t.habit_id+"|"+ws;
      const b=buckets[key]||(buckets[key]={total:0,done:0});
      b.total++; if(t.status===STATUS.DONE) b.done++;
    });
    const head=`<tr><th></th>${weekStarts.map((ws,i)=>`<th>${i===weeks-1?"本周":ws.slice(5).replace("-","/")}</th>`).join("")}</tr>`;
    const body=habits.map(h=>{
      const tds=weekStarts.map((ws,i)=>{
        const b=buckets[h.id+"|"+ws];
        if(!b) return `<td class="heat heat-0" title="未安排"></td>`;
        const pct=Math.round(b.done/b.total*100);
        const lv=pct===0?0:pct<50?1:pct<80?2:pct<100?3:4;
        return `<td class="heat heat-${lv}" title="${ws.slice(5)}：${b.done}/${b.total}（${pct}%）">${pct===0?"·":pct}</td>`;
      }).join("");
      return `<tr><th class="heat-h">${h.icon||"🧩"} ${esc(h.name)}</th>${tds}</tr>`;
    }).join("");
    return `<table class="heat-table">${head}${body}</table>`;
  },
  /* 一键复制结构化周报数据，粘贴给任意大模型求个体化建议（F-1） */
  copyAiSummary(){
    const days=7, today=new Date(); const weekDates=[];
    for(let i=days-1;i>=0;i--){ const d=new Date(today); d.setDate(today.getDate()-i); weekDates.push(fmtDate(d)); }
    const tasks=Store.db.tasks.filter(t=>weekDates.includes(t.date)&&t.status!==STATUS.EXPIRED);
    const done=tasks.filter(t=>t.status===STATUS.DONE);
    const rate=tasks.length?Math.round(done.length/tasks.length*100):0;
    const avg=done.length?Math.round(done.reduce((s,t)=>s+(t.actual_seconds||0),0)/done.length/60):0;
    const lines=[
      "你是一位懂儿童学习心理的家庭教育顾问。请根据我家一年级孩子最近一周的作业数据，给出 3 条具体的家长行动建议：先肯定具体进步，再给一条最值得改进的点，避免说教。",
      "",
      `【孩子】${Store.db.child.name}，一年级`,
      `【周期】${weekDates[0]} ~ ${weekDates[weekDates.length-1]}`,
      `【总体】任务 ${tasks.length} 项，完成 ${done.length} 项，完成率 ${rate}%，平均单任务 ${avg} 分钟`,
      `【星星】本周获得 ${done.reduce((s,t)=>s+(t.star_awarded||0),0)} 颗，累计获得 ${Store.db.points.earned_total!=null?Store.db.points.earned_total:Store.db.points.total} 颗，当前可用 ${Store.db.points.total} 颗`,
      `【退回】${tasks.filter(t=>t.status===STATUS.REJECTED).length} 次`,
      `【错题】未消化 ${Store.getMistakes().length} 题`,
      `【连续天数】${Store.db.streak.days} 天`
    ];
    /* 每日明细 */
    weekDates.forEach(ds=>{
      const list=tasks.filter(t=>t.date===ds);
      if(!list.length) return;
      const dn=list.filter(t=>t.status===STATUS.DONE);
      const detail=list.map(t=>`${t.title}(${t.subject}${t.status===STATUS.DONE?"✔":""}${t.status===STATUS.REJECTED?"✗退回":""} ${t.actual_seconds?Math.round(t.actual_seconds/60)+"分钟":""})`).join("、");
      lines.push(`【${ds}】${dn.length}/${list.length}：${detail}`);
    });
    const text=lines.join("\n");
    (navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(text):Promise.reject())
      .then(()=>toast("已复制周报数据，粘贴给任意 AI 助手即可获得个体化建议 🤖", null, 5000))
      .catch(()=>{
        modal("复制给 AI 总结", `<div class="small muted mb12">自动复制失败，请手动全选复制：</div>
          <textarea rows="12" style="width:100%" readonly onclick="this.select()">${esc(text)}</textarea>`,
          [{label:"关闭",cls:"btn-primary",fn:null}], true);
      });
  },
  rejectModal(id){
    if(!this.guard())return;
    const t=Store.getTask(id);
    modal("退回重做", `<div class="form-row"><label>退回原因（孩子端可见）</label>
      <textarea id="rej-reason" rows="3" placeholder="如：背诵不熟，请再练习一遍"></textarea></div>
      <label class="check-row mt12"><input type="checkbox" id="rej-mistake" ${/订正|背诵|口算|计算|听写/.test((t&&t.type)||"")?"checked":""}> 加入错题本（周末重练，做对 2 次自动归档）</label>`,[
      {label:"取消",cls:"btn-ghost",fn:null},
      {label:"确认退回",cls:"btn-red",fn:()=>{
        const reason=document.getElementById("rej-reason").value.trim();
        Store.rejectTask(id, reason, Store.db.settings.role==="admin"?"爸爸/妈妈":"家长");
        if(t && document.getElementById("rej-mistake").checked){
          Store.addMistake({ title:t.title, subject:t.subject, reason:reason||"退回任务", source_task_id:id });
          toast("已退回并记入错题本 📒");
        }else toast("已退回：星星已撤销，任务回到孩子端");
        route();
      }}
    ], true);
  },

  /* ---------- 家长语音鼓励（不评分，只连接） ---------- */
  enc: { mr:null, chunks:[], startAt:0, recording:false },
  encPending: null,   // {task_id, dataUrl, duration, mime}

  async recordEncouragement(taskId){
    if(!this.guard())return;
    if(this.enc.recording) return toast("正在录音中…");
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const mime=["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/ogg"].find(m=>window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
      const mr = mime ? new MediaRecorder(stream,{mimeType:mime}) : new MediaRecorder(stream);
      this.enc.mr=mr; this.enc.chunks=[]; this.enc.startAt=Date.now(); this.enc.recording=true;
      mr.ondataavailable=e=>{ if(e.data.size>0) this.enc.chunks.push(e.data); };
      mr.onstop=()=>{
        stream.getTracks().forEach(tr=>tr.stop());
        this.enc.recording=false;
        const blob=new Blob(this.enc.chunks,{type:mr.mimeType||"audio/webm"});
        const duration=Math.round((Date.now()-this.enc.startAt)/1000);
        if(duration<1) { toast("录音太短，再试一次"); return; }
        const fr=new FileReader();
        fr.onload=()=>{
          this.encPending={ task_id:taskId||null, dataUrl:fr.result, duration, mime:mr.mimeType||"audio/webm" };
          this.encSaveModal(taskId);
        };
        fr.readAsDataURL(blob);
      };
      mr.start();
      toast("录音中…再点一次停止 🎤", null, 8000);
      const self=this;
      /* 录音期间把页面上按钮切换为"停止"，避免整页重绘打断录音 */
      const btn=document.querySelector(".review-item [onclick*='recordEncouragement']") || document.getElementById("enc-rec-btn");
      if(btn){ btn.textContent="⏹ 停止录音"; btn.className=btn.className.replace("btn-outline","btn-red");
        btn.onclick=()=>{ if(self.enc.recording) self.enc.mr.stop(); }; }
    }catch(e){
      toast("无法使用麦克风，请在浏览器中允许麦克风权限");
    }
  },
  encSaveModal(taskId){
    const p=this.encPending; if(!p) return;
    const t=taskId?Store.getTask(taskId):null;
    modal("保存语音鼓励", `<div class="small muted mb12">孩子完成任务后会播放一次${t?`（优先跟随「${esc(t.title)}」重做完成时）`:""}。不评分、不说教，一句"辛苦啦"就够了。</div>
      <audio controls preload="metadata" src="${p.dataUrl}" style="width:100%"></audio>
      <div class="form-row mt12"><label>附言（可选，孩子端会以文字气泡显示）</label>
      <textarea id="enc-text" rows="2" maxlength="140" placeholder="如：今天口算进步很大，爸爸听到了！"></textarea></div>`,[
      {label:"放弃",cls:"btn-ghost",fn:()=>{ this.encPending=null; route(); }},
      {label:"↺ 重录",cls:"btn-outline",fn:()=>{ this.encPending=null; route(); setTimeout(()=>this.recordEncouragement(taskId),150); return false; }},
      {label:"保存",cls:"btn-primary",fn:()=>{ this.saveEncouragement(); }}
    ], true);
  },
  async saveEncouragement(){
    const p=this.encPending; if(!p) return;
    const text=(document.getElementById("enc-text")||{}).value||"";
    await Store.addEncouragement({ task_id:p.task_id, dataUrl:p.dataUrl, duration:p.duration,
      created_by:Store.db.settings.role==="admin"?"爸爸/妈妈":"家长", text:text.trim() });
    this.encPending=null;
    route(); toast("已保存 💌 孩子下次完成任务时播放");
  },
  delEnc(id){
    if(!this.guard())return;
    confirmModal("删除鼓励","删除后孩子端将不再播放这段录音。",()=>{
      Store.deleteEncouragement(id); route(); toast("已删除");
    });
  },
  setEncouragement(v){ Store.db.settings.encouragement=v; Store.save(); toast(v?"已开启：完成任务时播放鼓励":"已关闭鼓励播放"); },
  renderEncCard(){
    const s=Store.db.settings;
    const list=Store.getEncouragements();
    const items=list.map(e=>{
      const t=e.task_id?Store.getTask(e.task_id):null;
      return `<div class="enc-item">
        <span class="small muted" style="width:150px;flex:0 0 auto">${e.date} · ${fmtSec(e.duration)}${e.played_at?"<br>✅ 已播放":"<br>⏳ 待播放"}</span>
        <audio controls preload="none" src="${e.url||e.dataUrl}"></audio>
        ${this.isAdmin()?`<button class="btn btn-red btn-sm" onclick="Parent.delEnc('${e.id}')">🗑</button>`:""}
        ${e.text||t?`<div class="small muted" style="flex-basis:100%">${t?`关联任务：${esc(t.title)} · `:""}${e.text?"💌 "+esc(e.text):""}</div>`:""}
      </div>`;
    }).join("");
    return `<div class="card"><h3>🎤 语音鼓励</h3>
      <div class="small muted">不评分、不说教——孩子完成任务的瞬间，听到的是爸爸妈妈的声音。每段只播一次。</div>
      <label class="check-row mt12"><input type="checkbox" ${s.encouragement!==false?"checked":""} ${this.isAdmin()?"":"disabled"} onchange="Parent.setEncouragement(this.checked)"> 孩子完成任务时播放（可随时关闭）</label>
      ${this.isAdmin()?`<div class="flex mt12"><button class="btn btn-primary" id="enc-rec-btn" onclick="Parent.recordEncouragement()">⏺ 录一段鼓励</button></div>`:""}
      ${items?`<div class="mt12">${items}</div>`:`<div class="empty-tip" style="padding:12px">还没有鼓励录音，录一段试试</div>`}
    </div>`;
  },

  /* ---------- 奖励商城管理（D-1：孩子申请 → 家长确认扣星） ---------- */
  renderRewardsPage(){
    const pending=Store.pendingRedemptions();
    const history=Store.getRedemptions().filter(r=>r.status!=="pending").slice(0,20);
    const rewards=Store.getRewards();
    const goal=Store.db.settings.goals;
    const rows=rewards.map(r=>`<tr>
      <td><b>${r.icon||"🎁"} ${esc(r.name)}</b>${r.desc?`<div class="small muted">${esc(r.desc)}</div>`:""}</td>
      <td><b>${r.cost}⭐</b></td>
      <td>${r.active===false?'<span class="tag tag-gray">已下架</span>':'<span class="tag tag-green">上架中</span>'}</td>
      <td>${this.isAdmin()?`<button class="btn btn-outline btn-sm" onclick="Parent.rewardModal('${r.id}')">编辑</button>
        <button class="btn btn-ghost btn-sm" onclick="Parent.toggleReward('${r.id}')">${r.active===false?"上架":"下架"}</button>
        <button class="btn btn-red btn-sm" onclick="Parent.delReward('${r.id}')">删除</button>`:""}</td>
    </tr>`).join("");
    const pendHtml=pending.map(r=>`<div class="redemption-item">
      <div style="font-size:26px">${r.reward_icon||"🎁"}</div>
      <div class="ri-main"><b>${esc(r.reward_name)}</b>
        <div class="small muted mt8">${r.cost}⭐ · ${(r.requested_at||"").slice(5,16).replace("T"," ")} 孩子申请</div></div>
      ${this.isAdmin()?`<div class="flex">
        <button class="btn btn-green btn-sm" onclick="Parent.decideRedemption('${r.id}',true)">✓ 已兑现（扣 ${r.cost}⭐）</button>
        <button class="btn btn-red btn-sm" onclick="Parent.denyRedemption('${r.id}')">拒绝</button></div>`
        :'<span class="tag tag-orange">待家长确认</span>'}
    </div>`).join("");
    const histRows=history.map(r=>`<tr>
      <td>${r.reward_icon||"🎁"} ${esc(r.reward_name)}</td><td>${r.cost}⭐</td>
      <td>${r.status==="fulfilled"?'<span class="tag tag-green">已兑现</span>':'<span class="tag tag-red">未通过</span>'}${r.note?`<div class="small muted">${esc(r.note)}</div>`:""}</td>
      <td class="muted small">${(r.decided_at||"").slice(5,16).replace("T"," ")}</td></tr>`).join("");
    return `<div class="page page-narrow">
      <div class="flex-between">
        <div><div class="page-title">奖励管理</div>
        <div class="page-sub">孩子用星星申请兑换，家长在这里确认后扣星——星星从"数字"变成孩子摸得到的期待</div></div>
        ${this.isAdmin()?`<button class="btn btn-primary" onclick="Parent.rewardModal()">+ 新增奖品</button>`:""}
      </div>
      <div class="report-grid">
        <div class="metric"><div class="m-label">孩子可用星星</div><div class="m-value">⭐ ${Store.db.points.total}</div>
          <div class="m-note">累计挣得 ${Store.db.points.earned_total!=null?Store.db.points.earned_total:Store.db.points.total} ⭐（徽章按累计计）</div></div>
        <div class="metric"><div class="m-label">待确认兑换</div><div class="m-value">${pending.length}</div>
          <div class="m-note">孩子端申请后等这里确认</div></div>
        <div class="metric"><div class="m-label">孩子的存星目标</div>
          <div class="m-value" style="font-size:17px;line-height:1.5">${goal?`${esc(goal.name)}（${goal.target}⭐）`:"未设置"}</div>
          <div class="m-note">${goal?`已存 ${Store.db.points.total}/${goal.target}，还差 ${Math.max(0,goal.target-Store.db.points.total)}⭐`:"孩子可在奖励页自己设定"}</div></div>
      </div>
      ${pending.length?`<div class="card mt16"><h3>🔔 待确认兑换（${pending.length}）</h3>${pendHtml}</div>`:""}
      <div class="card mt16"><h3>奖品列表</h3>
        <table class="grid"><thead><tr><th>奖品</th><th>所需星星</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${rows||`<tr><td colspan="4"><div class="empty-tip">还没有奖品，点右上角新增（默认已预置 3 个示例）</div></td></tr>`}</tbody></table></div>
      ${histRows?`<div class="card mt16"><h3>兑换记录</h3>
        <table class="grid"><thead><tr><th>奖励</th><th>花费</th><th>结果</th><th>时间</th></tr></thead>
        <tbody>${histRows}</tbody></table></div>`:""}
    </div>`;
  },
  rewardModal(id){
    if(!this.guard())return;
    const r=id?Store.getRewards().find(x=>x.id===id):null;
    modal(r?"编辑奖品":"新增奖品", `<div class="form-grid">
      <div class="form-row"><label>奖品名称 *</label><input id="rw-name" maxlength="30" value="${esc(r?r.name:"")}" placeholder="如：看一集动画片"></div>
      <div class="form-row"><label>图标</label><select id="rw-icon">${["📺","🛝","🍦","🎁","🎮","📚","🎬","🚗","🧸"].map(i=>`<option ${r&&r.icon===i?"selected":""}>${i}</option>`).join("")}</select></div>
      <div class="form-row"><label>所需星星 *</label><input id="rw-cost" type="number" min="1" max="999" value="${r?r.cost:20}"></div>
      <div class="form-row"><label>说明</label><input id="rw-desc" maxlength="80" value="${esc(r?r.desc||"":"")}" placeholder="如：20 分钟以内的一集"></div>
      <div class="form-row full"><label class="check-row"><input id="rw-active" type="checkbox" ${!r||r.active!==false?"checked":""}> 上架（孩子端可见可兑换）</label></div>
    </div>`,[
      {label:"取消",cls:"btn-ghost",fn:null},
      {label:"保存",cls:"btn-primary",fn:()=>{
        const name=document.getElementById("rw-name").value.trim();
        const cost=parseInt(document.getElementById("rw-cost").value,10);
        if(!name) return toast("名称不能为空"), false;
        if(!cost||cost<1) return toast("所需星星至少为 1"), false;
        Store.saveReward({ id:id||null, name, icon:document.getElementById("rw-icon").value, cost,
          desc:document.getElementById("rw-desc").value.trim(), active:document.getElementById("rw-active").checked });
        route(); toast("奖品已保存");
      }}
    ], true);
  },
  toggleReward(id){
    if(!this.guard())return;
    const r=Store.getRewards().find(x=>x.id===id); if(!r) return;
    r.active=r.active===false; r.updated_at=new Date().toISOString();
    Store.save(); route(); toast(r.active===false?"已下架（孩子端不可见）":"已上架");
  },
  delReward(id){
    if(!this.guard())return;
    confirmModal("删除奖品","删除后孩子端将不再显示。历史兑换记录保留。",()=>{
      Store.removeReward(id); route(); toast("已删除");
    });
  },
  decideRedemption(id, ok){
    if(!this.guard())return;
    if(ok){
      const e=Store.getRedemptions().find(x=>x.id===id); if(!e) return;
      if(Store.db.points.total<e.cost) return toast(`星星不足（当前 ${Store.db.points.total}⭐，需要 ${e.cost}⭐）`);
      confirmModal("确认兑换",`确认已经兑现「${esc(e.reward_name)}」并扣除 <b>${e.cost}⭐</b> 吗？`,()=>{
        Store.decideRedemption(id,true);
        route(); toast("已兑现并扣星 🎁");
      });
    }else Store.decideRedemption(id,false) && (route(), toast("已拒绝，星星保留"));
  },
  denyRedemption(id){
    if(!this.guard())return;
    modal("拒绝兑换", `<div class="form-row"><label>给孩子的说明（可选）</label>
      <textarea id="deny-note" rows="2" placeholder="如：这周已经看过一集啦，攒着周末看两集吧"></textarea></div>`,[
      {label:"取消",cls:"btn-ghost",fn:null},
      {label:"确认拒绝（不扣星）",cls:"btn-red",fn:()=>{
        Store.decideRedemption(id,false,document.getElementById("deny-note").value.trim());
        route(); toast("已拒绝，星星保留");
      }}
    ], true);
  },

  /* ---------- 错题本（D-4：退回/口算错题入本，周末重练） ---------- */
  renderMistakes(){
    const active=Store.getMistakes();
    const archived=Store.getArchivedMistakes().slice(0,15);
    const d=new Date(); let add=(6-d.getDay()+7)%7; if(!add) add=7;
    d.setDate(d.getDate()+add); const nextSat=fmtDate(d);
    const rows=active.map(m=>`<tr>
      <td><label class="check-row" style="padding:0"><input type="checkbox" class="mk-check" value="${m.id}" checked>
        <b>${esc(m.title)}</b></label>${m.reason?`<div class="small muted">${esc(m.reason)}</div>`:""}</td>
      <td>${esc(m.subject)}</td>
      <td>${m.mastered_count>=1?`<span class="tag tag-green">✔ ${m.mastered_count} 次</span>`:'<span class="tag tag-gray">未重练</span>'}</td>
      <td class="muted small">${(m.created_at||"").slice(5,10)}</td>
      <td>${this.isAdmin()?`<button class="btn btn-red btn-sm" onclick="Parent.delMistake('${m.id}')">删除</button>`:""}</td>
    </tr>`).join("");
    const archRows=archived.map(m=>`<tr class="muted">
      <td>${esc(m.title)}</td><td>${esc(m.subject)}</td>
      <td><span class="tag tag-green">已掌握（2 次做对）</span></td>
      <td class="small">${(m.updated_at||"").slice(5,10)}</td><td></td></tr>`).join("");
    return `<div class="page page-narrow">
      <div class="flex-between">
        <div><div class="page-title">错题本</div>
        <div class="page-sub">退回任务勾选「加入错题本」、口算做错自动入本；重练做对 2 次自动归档</div></div>
        ${this.isAdmin()?`<div class="flex">
          <button class="btn btn-outline" onclick="Parent.mistakeModal()">+ 手动添加</button>
          <button class="btn btn-primary" ${active.length?"":"disabled"} onclick="Parent.drillModal()">📅 生成重练（${active.length}）</button></div>`:""}
      </div>
      <div class="card"><h3>待消化错题（${active.length}）</h3>
        <table class="grid"><thead><tr><th>题目</th><th>科目</th><th>掌握</th><th>入本</th><th></th></tr></thead>
        <tbody>${rows||`<tr><td colspan="5"><div class="empty-tip">还没有错题——退回任务时勾选「加入错题本」，或用「工具」生成口算练习自动判分入本</div></td></tr>`}</tbody></table>
        ${this.isAdmin()&&active.length?`<div class="small muted mt8">勾选题目后点右上角「生成重练」，默认排到 ${dateCn(nextSat)}</div>`:""}
      </div>
      ${archRows?`<div class="card mt16"><h3>已掌握（归档）</h3>
        <table class="grid"><tbody>${archRows}</tbody></table></div>`:""}
    </div>`;
  },
  mistakeModal(){
    if(!this.guard())return;
    modal("手动添加错题", `<div class="form-grid">
      <div class="form-row full"><label>题目 *</label><input id="mk-title" maxlength="60" placeholder="如：9+4=?"></div>
      <div class="form-row"><label>科目</label><select id="mk-subject">${["数学","语文","英语","拼音","其他"].map(s=>`<option>${s}</option>`).join("")}</select></div>
      <div class="form-row"><label>错误原因</label><input id="mk-reason" maxlength="80" placeholder="如：进位加法总忘加 1"></div>
    </div>`,[
      {label:"取消",cls:"btn-ghost",fn:null},
      {label:"保存",cls:"btn-primary",fn:()=>{
        const title=document.getElementById("mk-title").value.trim();
        if(!title) return toast("题目不能为空"), false;
        Store.addMistake({ title, subject:document.getElementById("mk-subject").value,
          reason:document.getElementById("mk-reason").value.trim() });
        route(); toast("已入错题本");
      }}
    ], true);
  },
  drillModal(){
    if(!this.guard())return;
    const active=Store.getMistakes();
    if(!active.length) return toast("没有待消化的错题");
    const d=new Date(); let add=(6-d.getDay()+7)%7; if(!add) add=7;
    d.setDate(d.getDate()+add); const nextSat=fmtDate(d);
    modal("生成错题重练", `<div class="small muted mb12">把勾选的错题生成为「订正」任务，孩子做完一次得 ✔，做对 2 次自动归档。</div>
      <div class="bp-col">${active.map(m=>`<label class="check-row"><input type="checkbox" class="mk-pick" value="${m.id}" checked> ${esc(m.title)}</label>`).join("")}</div>
      <div class="form-row mt12"><label>练习日期</label><input id="drill-date" type="date" value="${nextSat}"></div>`,[
      {label:"取消",cls:"btn-ghost",fn:null},
      {label:"生成任务",cls:"btn-primary",fn:()=>{
        const ids=[...document.querySelectorAll(".mk-pick:checked")].map(b=>b.value);
        if(!ids.length) return toast("请至少勾选一道错题"), false;
        const date=document.getElementById("drill-date").value||nextSat;
        const n=Store.generateDrill(date, ids);
        route(); toast(`已生成 ${n} 个订正任务（${date}）`);
      }}
    ], true);
  },
  delMistake(id){
    if(!this.guard())return;
    Store.removeMistake(id); route(); toast("已删除");
  },

  /* ---------- 工具：口算练习生成器（E-1） ---------- */
  genDraft:null,   // {rangeKey,count,date,star,questions:[{q,a}]}
  renderTools(){
    return `<div class="page page-narrow">
      <div class="page-title">工具 · 口算练习生成器</div>
      <div class="page-sub">发布到平板：孩子直接作答、自动判分、错题自动入本；或打印成纸面练习（含家长答案页）</div>
      <div class="card"><h3>① 出题设置</h3>
        <div class="form-grid">
          <div class="form-row"><label>数字范围</label>
            <select id="gen-range">
              <option value="10">10 以内加减</option>
              <option value="20" selected>20 以内加减</option>
              <option value="20c">20 以内（含进位/退位）</option>
              <option value="100">100 以内（二年级预热）</option>
            </select></div>
          <div class="form-row"><label>题目数量</label>
            <select id="gen-count">${[10,20,30,50].map(n=>`<option ${n===20?"selected":""}>${n}</option>`).join("")}</select></div>
          <div class="form-row"><label>发布日期</label><input id="gen-date" type="date" value="${todayStr()}"></div>
          <div class="form-row"><label>完成得星星</label>
            <select id="gen-star">${[1,2].map(n=>`<option value="${n}" ${n===1?"selected":""}>${n} ⭐</option>`).join("")}</select></div>
        </div>
        <div class="flex mt12">
          ${this.isAdmin()?`<button class="btn btn-primary" onclick="Parent.generateDrillPreview()">🎲 生成题目</button>`:`<span class="tag tag-gray">只读权限不可发布</span>`}
        </div>
      </div>
      ${this.genDraft?this.renderGenPreview():""}
    </div>`;
  },
  makeQuestions(rangeKey, count){
    const max=rangeKey==="10"?10:rangeKey==="100"?100:20;
    const carry=rangeKey==="20c";
    const qs=[]; const seen=new Set(); let tries=0;
    while(qs.length<count && tries<count*200){
      tries++;
      const a=1+Math.floor(Math.random()*(max-1));
      const b=1+Math.floor(Math.random()*(max-1));
      const add=Math.random()<0.5;
      let q, ans;
      if(add){
        if(a+b>max) continue;
        if(carry && (a%10)+(b%10)<10) continue;      // 只要进位加法
        q=`${a}+${b}`; ans=a+b;
      }else{
        if(b>a) continue;
        if(carry && (a%10)>=(b%10)) continue;        // 只要退位减法
        q=`${a}-${b}`; ans=a-b;
      }
      if(seen.has(q)) continue;
      seen.add(q); qs.push({q,a:ans});
    }
    return qs;
  },
  generateDrillPreview(){
    if(!this.guard())return;
    const rangeKey=document.getElementById("gen-range").value;
    const count=parseInt(document.getElementById("gen-count").value,10);
    const questions=this.makeQuestions(rangeKey,count);
    if(questions.length<count) toast(`生成了 ${questions.length} 题（范围约束下不重复题目有限）`);
    this.genDraft={ rangeKey, count:questions.length, questions,
      date:document.getElementById("gen-date").value||todayStr(),
      star:parseInt(document.getElementById("gen-star").value,10)||1 };
    route();
  },
  renderGenPreview(){
    const g=this.genDraft;
    const rangeName={10:"10 以内",20:"20 以内","20c":"20 以内进退位",100:"100 以内"}[g.rangeKey]||g.rangeKey;
    const cells=g.questions.map((x,i)=>`<div class="drill-row"><span class="drill-q">${i+1}. ${esc(x.q)} =</span>
      <span class="drill-ans">${esc(String(x.a))}</span></div>`).join("");
    return `<div class="card mt16"><h3>② 预览（${g.count} 题 · ${rangeName} · ${g.date}）</h3>
      <div class="drill-grid drill-preview">${cells}</div>
      <div class="flex mt12">
        <button class="btn btn-outline" onclick="Parent.generateDrillPreview()">🎲 换一批</button>
        <button class="btn btn-primary" onclick="Parent.publishDrill()">发布到平板作答</button>
        <button class="btn btn-outline" onclick="Parent.printDrill()">🖨 打印（含答案页）</button>
      </div>
      <div class="small muted mt8">平板作答：全部答对才得星并算完成；做错的题自动记入错题本。打印版：先做题再看答案页。</div>
    </div>`;
  },
  publishDrill(){
    if(!this.guard())return;
    const g=this.genDraft;
    if(!g||!g.questions.length) return toast("请先生成题目");
    const rangeName={10:"10以内",20:"20以内","20c":"进退位",100:"100以内"}[g.rangeKey];
    const title=`口算练习 ${g.count} 题（${rangeName}）`;
    if(Store.db.tasks.some(t=>t.date===g.date && t.title===title)) return toast("这天已有一份同名练习（先删除旧的或改日期）");
    Store.db.tasks.push({ id:uid(), date:g.date, title, subject:"数学", category:"学业", type:"口算",
      source:"口算生成器", note:"", estimated_minutes:Math.max(5,Math.ceil(g.count/2)),
      timer_mode:"stopwatch", limit_minutes:null, overtime_remind:5, allow_continue:true,
      need_recording:false, period_rule_id:null, status:STATUS.TODO, actual_seconds:null,
      completed_at:null, reviewed_by:null, reviewed_at:null, star_awarded:0,
      star_value:g.star, parent_note:"", created_by:"家长", drill:{ questions:g.questions },
      updated_at:new Date().toISOString() });
    Store.save();
    location.hash="#/parent";
    route(); toast(`已发布到 ${g.date}，孩子端作答自动判分 ✏️`);
  },
  printDrill(){
    const g=this.genDraft; if(!g) return;
    const w=window.open("", "_blank");
    if(!w) return toast("浏览器拦截了打印窗口，请允许弹窗");
    const qs=g.questions.map((x,i)=>`<div class="q"><b>${i+1}.</b> ${esc(x.q)} = ____</div>`).join("");
    const ans=g.questions.map((x,i)=>`<span><b>${i+1}.</b> ${esc(x.q)}=${x.a}</span>`).join("");
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>口算练习 ${g.date}</title>
      <style>body{font-family:"Microsoft YaHei",sans-serif;margin:24px;color:#111}
      h2{margin:0 0 4px}.sub{color:#666;font-size:13px;margin-bottom:18px}
      .qs{display:grid;grid-template-columns:repeat(4,1fr);gap:14px 20px;font-size:17px}
      .q{border-bottom:1px dashed #bbb;padding-bottom:6px}
      .ans{page-break-before:always;display:flex;flex-wrap:wrap;gap:10px 24px;font-size:14px;color:#333}
      @media print{.noprint{display:none}}</style></head><body>
      <h2>口算练习 · ${g.count} 题</h2>
      <div class="sub">日期：____ 月 ____ 日　姓名：________　用时：____ 分 ____ 秒　错 ____ 题</div>
      <div class="qs">${qs}</div>
      <div class="ans"><h2>家长答案页</h2>${ans}</div>
      <p class="noprint" style="margin-top:20px;color:#888">（此行不打印）做完后按 Ctrl+P 打印</p>
      </body></html>`);
    w.document.close();
  },

  /* ---------- P5 习惯任务管理 ---------- */
  renderHabits(){
    const rows = Store.db.habits.map(h=>`<tr>
      <td><b>${h.icon} ${esc(h.name)}</b><div class="small muted">${(h.checklist||[]).join(" / ")}</div></td>
      <td>${h.remind_time}</td>
      <td>${(h.weekdays||[]).map(w=>"一二三四五六日"[w-1]).join("、")}</td>
      <td>${h.linked_timetable?"显示明日课表":"-"}</td>
      <td>${h.star_enabled?"⭐":"-"}</td>
      <td>${this.isAdmin()?`<button class="btn btn-sm ${h.active?"btn-red":"btn-green"}" onclick="Parent.toggleHabit('${h.id}')">${h.active?"停用":"启用"}</button>`:(h.active?"启用中":"已停用")}</td>
    </tr>`).join("");
    return `<div class="page">
      <div class="flex-between">
        <div><div class="page-title">习惯任务管理</div><div class="page-sub">习惯任务单独建立，不走文本导入；到提醒时间将在孩子端置顶</div></div>
        ${this.isAdmin()?`<button class="btn btn-primary" onclick="Parent.newHabitModal()">+ 新建习惯</button>`:""}
      </div>
      <div class="card" style="padding:0;overflow:hidden"><table class="grid">
        <thead><tr><th>习惯</th><th>提醒时间</th><th>每周几</th><th>课表联动</th><th>得星</th><th>状态</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </div>`;
  },
  toggleHabit(id){
    if(!this.guard())return;
    const h=Store.db.habits.find(x=>x.id===id); h.active=!h.active; Store.save(); route();
  },
  newHabitModal(){
    if(!this.guard())return;
    modal("新建习惯任务", `<div class="form-grid">
      <div class="form-row full"><label>名称 *</label><input id="hb-name" placeholder="如：整理书桌"></div>
      <div class="form-row"><label>图标</label><select id="hb-icon">${["🎒","🪥","🧸","📚","🛏️","👟","🍎"].map(i=>`<option>${i}</option>`).join("")}</select></div>
      <div class="form-row"><label>提醒时间</label><input id="hb-time" type="time" value="20:00"></div>
      <div class="form-row"><label>假期提醒时间（可选）</label><input id="hb-vtime" type="time" placeholder="不填=沿用日常"></div>
      <div class="form-row full"><label>每周几</label><div class="weekday-picks" id="hb-weekdays">${[1,2,3,4,5,6,7].map(w=>`<button type="button" data-w="${w}" class="${w<=5?"on":""}" onclick="this.classList.toggle('on')">${"一二三四五六日"[w-1]}</button>`).join("")}</div></div>
      <div class="form-row full"><label>检查清单（每行一项）</label><textarea id="hb-check" rows="3"></textarea></div>
      <div class="form-row full">
        <label class="check-row"><input id="hb-tt" type="checkbox"> 显示明日课表（整理书包类）</label>
        <label class="check-row"><input id="hb-photo" type="checkbox"> 需要拍照</label>
        <label class="check-row"><input id="hb-star" type="checkbox" checked> 完成得星</label>
      </div></div>`,[
      {label:"取消",cls:"btn-ghost",fn:null},
      {label:"保存",cls:"btn-primary",fn:()=>{
        const name=document.getElementById("hb-name").value.trim();
        if(!name) return toast("名称不能为空"), false;
        const weekdays=[...document.querySelectorAll("#hb-weekdays button.on")].map(b=>parseInt(b.dataset.w));
        if(!weekdays.length) return toast("每周几至少选择一天"), false;
        Store.db.habits.push({ id:uid(), name, icon:document.getElementById("hb-icon").value,
          remind_time:document.getElementById("hb-time").value||"20:00",
          vacation_remind_time:document.getElementById("hb-vtime").value||null, weekdays,
          need_photo:document.getElementById("hb-photo").checked, need_review:false,
          star_enabled:document.getElementById("hb-star").checked,
          linked_timetable:document.getElementById("hb-tt").checked,
          checklist:document.getElementById("hb-check").value.split("\n").map(s=>s.trim()).filter(Boolean),
          active:true });
        Store.save(); Store.generateToday(); route(); toast("习惯已创建");
      }}], true);
  },

  /* ---------- P6 课表管理（日常 / 假期两套方案） ---------- */
  renderTimetable(){
    const vac = Store.db.settings.scheduleMode==="vacation";
    const pack = vac ? Store.db.vacationTimetable : Store.db.timetable;
    const weekRows = [1,2,3,4,5,6,7].map(w=>{
      const t=pack[w]||{subjects:[],notes:""};
      return `<tr><td><b>${weekdayCn(w)}</b></td>
        <td>${this.isAdmin()?`<input style="width:100%" value="${esc((t.subjects||[]).join(" / "))}" onchange="Parent.setTimetable(${w},this.value,null)" placeholder="用 / 分隔">`:(t.subjects||[]).join(" / ")||"-"}</td>
        <td>${this.isAdmin()?`<input style="width:100%" value="${esc(t.notes||"")}" onchange="Parent.setTimetable(${w},null,this.value)" placeholder="备注，如：美术带彩笔">`:esc(t.notes||"-")}</td></tr>`;
    }).join("");
    const tmw = tomorrowStr();
    const tmwT = Store.getTimetable(tmw);
    return `<div class="page">
      <div class="page-title">课表管理 ${vac?'<span class="tag tag-orange">🏖 正在编辑假期方案</span>':'<span class="tag tag-teal">🏠 正在编辑日常方案</span>'}</div>
      <div class="page-sub">两套方案独立保存，在「设置 · 日程方案」一键切换；临时调课仅改当天，两种方案下都生效。整理书包类习惯任务会显示「明日课表」</div>
      <div class="card"><h3>固定周课表（${vac?"假期":"日常"}）</h3>
        <table class="grid"><thead><tr><th style="width:90px">星期</th><th>科目（用 / 分隔）</th><th>备注</th></tr></thead>
        <tbody>${weekRows}</tbody></table>
        ${this.isAdmin()?`<div class="flex mt12"><button class="btn btn-outline" onclick="Parent.copyPack('${vac?"vacation":"daily"}')">⧉ 把${vac?"日常":"假期"}方案复制过来</button></div>`:""}
      </div>
      <div class="card"><h3>临时调课</h3>
        <div class="form-grid">
          <div class="form-row"><label>日期</label><input id="ov-date" type="date" value="${tmw}"></div>
          <div class="form-row"><label>科目（用 / 分隔，留空=清除调课）</label><input id="ov-subjects" placeholder="当前：${esc((tmwT.subjects||[]).join(" / ")||"无")}"></div>
          <div class="form-row full"><label>备注</label><input id="ov-notes" placeholder="当前：${esc(tmwT.notes||"无")}"></div>
        </div>
        ${this.isAdmin()?`<button class="btn btn-primary mt12" onclick="Parent.setOverride()">保存调课</button>`:""}
      </div></div>`;
  },
  setTimetable(w, subjectsStr, notes){
    if(!this.guard())return;
    const pack=(Store.db.settings.scheduleMode==="vacation")?Store.db.vacationTimetable:Store.db.timetable;
    if(!pack[w]) pack[w]={subjects:[],notes:""};
    const t=pack[w];
    if(subjectsStr!=null) t.subjects=subjectsStr.split(/[\/、,，]/).map(s=>s.trim()).filter(Boolean);
    if(notes!=null) t.notes=notes;
    Store.save(); toast(weekdayCn(w)+"课表已更新（"+(Store.db.settings.scheduleMode==="vacation"?"假期":"日常")+"方案）");
  },
  copyPack(target){
    if(!this.guard())return;
    const src = target==="vacation" ? Store.db.timetable : Store.db.vacationTimetable;
    const dst = target==="vacation" ? Store.db.vacationTimetable : Store.db.timetable;
    [1,2,3,4,5,6,7].forEach(w=>{ dst[w]=JSON.parse(JSON.stringify(src[w]||{subjects:[],notes:""})); });
    Store.save(); route(); toast("已复制整套课表");
  },
  setOverride(){
    if(!this.guard())return;
    const d=document.getElementById("ov-date").value; if(!d) return toast("请选择日期");
    const s=document.getElementById("ov-subjects").value.trim();
    const n=document.getElementById("ov-notes").value.trim();
    if(!s && !n){ delete Store.db.timetableOverrides[d]; }
    else Store.db.timetableOverrides[d]={ subjects:s?s.split(/[\/、,，]/).map(x=>x.trim()).filter(Boolean):(Store.getTimetable(d).subjects||[]), notes:n };
    Store.save(); route(); toast("调课已保存，明日课表将同步到孩子端");
  },

  /* ---------- P4 周期任务管理 ---------- */
  renderPeriods(){
    const rows = Store.db.periodRules.map(r=>{
      const freqTxt = r.freq==="once"?"仅今天":r.freq==="daily"?"每天":"每周 "+(r.weekdays||[]).map(w=>"一二三四五六日"[w-1]).join("、");
      return `<tr><td><b>${esc(r.template.title)}</b><div class="small muted">${esc(r.template.subject)} · ${esc(r.template.type)}</div></td>
      <td>${freqTxt}</td><td>${r.start_date||"-"} ~ ${r.end_date||"长期"}</td>
      <td>${this.isAdmin()?`<button class="btn btn-sm ${r.active?"btn-red":"btn-green"}" onclick="Parent.toggleRule('${r.id}')">${r.active?"停用":"启用"}</button>
        <button class="btn btn-sm btn-ghost" onclick="Parent.delRule('${r.id}')">删除</button>`:(r.active?"生效中":"已停用")}</td></tr>`;
    }).join("");
    return `<div class="page"><div class="page-title">周期任务管理</div>
      <div class="page-sub">修改规则只影响未来生成的任务，不回改历史任务</div>
      <div class="card" style="padding:0;overflow:hidden"><table class="grid">
      <thead><tr><th>任务模板</th><th>周期</th><th>生效窗口</th><th>操作</th></tr></thead>
      <tbody>${rows||`<tr><td colspan="4"><div class="empty-tip">暂无周期任务，可在文本导入发布时选择「每天 / 每周几」</div></td></tr>`}</tbody></table></div></div>`;
  },
  toggleRule(id){ if(!this.guard())return; const r=Store.db.periodRules.find(x=>x.id===id); r.active=!r.active; Store.save(); route(); },
  delRule(id){ if(!this.guard())return; Store.remove("periodRules", id); route(); toast("已删除（今日已生成实例保留）"); },

  /* ---------- P9 设置 ---------- */
  renderSettings(){
    const s=Store.db.settings;
    return `<div class="page page-narrow"><div class="page-title">设置</div>
      <div class="page-sub">一年级模式与全文注音开关仅对一年级生效</div>
      <div class="card"><h3>年级模式与注音</h3>
        <div class="form-row" style="max-width:240px"><label>孩子年级</label>
          <select id="set-grade" onchange="Parent.setGrade(this.value)">
            ${[1,2,3,4,5,6,7].map(g=>`<option value="${g}" ${s.gradeMode===g?"selected":""}>${g} 年级</option>`).join("")}
          </select></div>
        <label class="check-row mt12"><input type="checkbox" ${s.pinyin?"checked":""} ${s.gradeMode!==1?"disabled":""} onchange="Parent.setPinyin(this.checked)"> 一年级全文注音</label>
        ${s.gradeMode!==1?`<div class="small muted mt8">注音仅一年级模式可用</div>`:""}
      </div>
      <div class="card"><h3>孩子端与安全</h3>
        ${(typeof Auth!=="undefined" && Auth.required) ? `
          <div class="small muted">PIN 由服务端校验，登录凭证存放在 HttpOnly Cookie，页面脚本读不到，孩子端也无法伪造家长身份。</div>
          <div class="form-grid mt12">
            <div class="form-row"><label>原 PIN</label><input id="pin-old" type="password" inputmode="numeric" maxlength="8" ${this.isAdmin()?"":"disabled"}></div>
            <div class="form-row"><label>新 PIN（4-8 位）</label><input id="pin-new" type="password" inputmode="numeric" maxlength="8" ${this.isAdmin()?"":"disabled"}></div>
          </div>
          ${this.isAdmin()?`<button class="btn btn-outline mt12" onclick="Parent.savePinServer()">修改 PIN</button>`:""}
          <div class="small muted mt8">修改后其他设备会被强制退出，当前设备保持登录。</div>
        ` : `
          <div class="form-grid">
            <div class="form-row"><label>家长端 PIN 码（4 位）</label>
              <input id="set-pin" maxlength="4" value="${esc(s.parent_pin||"1234")}" ${this.isAdmin()?"":"disabled"}></div>
          </div>
          ${this.isAdmin()?`<button class="btn btn-outline mt12" onclick="Parent.savePin()">保存 PIN</button>`:""}
          <div class="small muted mt8">当前为本地模式：PIN 只在本浏览器校验。启动后端后自动切换为服务端鉴权。</div>
        `}
        <div class="form-row mt12" style="max-width:240px"><label>完成音效</label>
          <select id="set-sound" onchange="Parent.setSound(this.value)">
            <option value="on" ${s.sound!==false?"selected":""}>开启（推荐）</option>
            <option value="off" ${s.sound===false?"selected":""}>关闭</option></select></div>
        <label class="check-row mt12"><input type="checkbox" ${s.eyeCare!==false?"checked":""} ${this.isAdmin()?"":"disabled"} onchange="Parent.setEyeCare(this.checked)"> 护眼节奏（孩子连续专注 20 分钟自动暂停，休息 1 分钟）</label>
      </div>
      ${this.renderEncCard()}
      <div class="card"><h3>🏖 日程方案（日常 / 假期）</h3>
        <div class="small muted">切换后孩子端课表与习惯提醒时间立即按所选方案生效；「课表管理」页编辑的是当前方案的课表，习惯的假期提醒时间在新建习惯时设置（未设置则沿用日常时间）。</div>
        <div class="flex mt12">
          ${this.isAdmin()?`
          <button class="btn ${s.scheduleMode==="vacation"?"btn-outline":"btn-primary"}" onclick="Parent.setSchedule('daily')">🏠 日常</button>
          <button class="btn ${s.scheduleMode==="vacation"?"btn-primary":"btn-outline"}" onclick="Parent.setSchedule('vacation')">🏖 假期</button>`:
          `<span class="tag tag-teal">当前：${s.scheduleMode==="vacation"?"假期":"日常"}</span>`}
        </div>
      </div>
      <div id="device-card"></div>
      <div id="storage-card"></div>
      <div class="card"><h3>提醒设置</h3>
        <table class="grid"><tbody>
          <tr><td>习惯任务到点</td><td>按习惯任务的提醒时间，孩子端页面横幅 + 语音播报 + 提示音（到点后 15 分钟内补提醒一次）</td></tr>
          <tr><td>未完成汇总</td><td>孩子端 20:30 / 21:00 各提醒一次；家长端同步收到汇总</td></tr>
          <tr><td>系统通知</td><td>当前：<b>${typeof Remind!=="undefined"?Remind.permLabel():"不支持"}</b>${typeof Remind!=="undefined"&&/未开启/.test(Remind.permLabel())?` · <a href="javascript:Remind.askPermission()">去开启</a>`:""}</td></tr>
          <tr><td>专注模式</td><td>孩子端开启后全屏 + 屏幕常亮，适合把平板固定在书桌；长按左上角 1.5 秒退出</td></tr>
        </tbody></table>
        <div class="flex mt12" style="flex-wrap:wrap">
          <button class="btn btn-outline" onclick="Remind.askPermission()">开启系统通知</button>
          <button class="btn btn-ghost" onclick="Remind.fire('habit','提醒测试','这是一条测试提醒，孩子端会同时播报语音')">发送测试提醒</button>
        </div>
        <div class="small muted mt8">浏览器要求先有点击操作才允许播放声音与通知；熄屏状态下系统通知由平板系统接管，建议把 PWA 加入电池白名单。</div>
      </div>
      <div class="card"><h3>数据备份</h3>
        <div class="flex">
          <button class="btn btn-outline" onclick="Store.exportJSON()">⬇ 导出备份（JSON）</button>
          <label class="btn btn-outline">⬆ 导入备份<input type="file" accept="application/json" class="hidden" onchange="Parent.importFile(this)"></label>
          ${this.isAdmin()?`<button class="btn btn-red" onclick="Parent.resetAll()">清空全部数据</button>`:""}
        </div>
        <div class="small muted mt8">后端存储：${Store.remote?"已连接（多设备同步中）":"未连接（当前为本地模式，数据仅存本机）"}</div>
      </div>
      <div class="card"><h3>激励规则</h3>
        <table class="grid"><tbody>
          <tr><td>完成任务</td><td>按任务设置的星星数发放（1-3 ⭐，默认 1），二次确认后立即到账，5 秒内可撤销</td></tr>
          <tr><td>家长退回</td><td>撤销该任务星星，录音保留并标记「已退回」，任务回到孩子端重做；可勾选「加入错题本」</td></tr>
          <tr><td>奖励兑换</td><td>孩子在奖励页用星星申请兑换奖品（家长定义），家长确认后才扣星；拒绝不扣星</td></tr>
          <tr><td>徽章</td><td>按<b>累计获得</b>星星 / 连续天数解锁（兑换消费不影响徽章）</td></tr>
          <tr><td>连续天数</td><td>当天全部任务完成 +1，中断清零</td></tr>
          <tr><td>错题本</td><td>退回任务或口算做错自动入本，重练做对 2 次自动归档，可在「错题本」页生成周末重练</td></tr>
          <tr><td>跨天未完成</td><td>次日自动置为「已过期」并归档，不阻断当日进度</td></tr>
          <tr><td>语音鼓励</td><td>家长录音（可附言），孩子完成任务瞬间播放一次；在「设置 · 语音鼓励」或复核页 🎤 录制</td></tr>
        </tbody></table></div>
    </div>`;
  },
  savePin(){
    const v=document.getElementById("set-pin").value.trim();
    if(!/^\d{4}$/.test(v)) return toast("PIN 必须为 4 位数字");
    Store.db.settings.parent_pin=v; Store.save(); toast("PIN 已更新");
  },
  async savePinServer(){
    const oldPin=(document.getElementById("pin-old").value||"").trim();
    const newPin=(document.getElementById("pin-new").value||"").trim();
    if(!/^\d{4,8}$/.test(newPin)) return toast("新 PIN 需为 4-8 位数字");
    const r=await Auth.changePin(oldPin,newPin);
    if(r && r.ok) { document.getElementById("pin-old").value=""; document.getElementById("pin-new").value=""; }
  },
  async mountSettings(){
    this.mountStorageCard();
    if(typeof Auth==="undefined" || !Auth.required) return;
    const el=document.getElementById("device-card");
    if(!el) return;
    try{ el.innerHTML=await Auth.renderDeviceCard(); }catch(e){}
  },
  /* G-6.4 状态体积看板：从 /api/health 拉存储信息，超阈值提醒 */
  async mountStorageCard(){
    const el=document.getElementById("storage-card");
    if(!el || !Store.remote) return;
    try{
      const j=await fetch("/api/health").then(r=>r.json());
      if(!j || !j.storage) return;
      const kb=n=>n>=1048576?(n/1048576).toFixed(1)+" MB":Math.round(n/1024)+" KB";
      const big=j.storage.state_bytes>8*1024*1024;
      el.innerHTML=`<div class="card"><h3>💾 存储与备份</h3>
        <table class="grid"><tbody>
          <tr><td>存储后端</td><td>${j.storage.backend==="sqlite"?"SQLite（WAL，data/hwbench.db）":"JSON 文件（降级模式）"}</td></tr>
          <tr><td>状态体积</td><td>${kb(j.storage.state_bytes||0)} · 任务 ${j.storage.tasks||0} 项${big?` <span class="tag tag-red">偏大，建议在周报核对后清理历史任务</span>`:""}</td></tr>
          <tr><td>自动备份</td><td>${j.storage.backup_last?`最近一份 ${esc(j.storage.backup_last)}（共 ${j.storage.backup_count} 份，每日 03:00 自动滚动，保留 14 份）`:"尚未生成（服务启动后当晚 03:00 生成首份）"}</td></tr>
        </tbody></table>
        <div class="small muted mt8">备份文件在服务端 <b>data/backups/</b>；恢复方式见《部署与平板接入》文档。</div>
      </div>`;
    }catch(e){ /* 离线时静默 */ }
  },
  setSound(v){ Store.db.settings.sound=(v==="on"); Store.save(); toast(Store.db.settings.sound?"音效已开启":"音效已关闭"); },
  setEyeCare(v){ Store.db.settings.eyeCare=v; Store.save(); toast(v?"护眼节奏已开启（20 分钟自动休息）":"护眼节奏已关闭"); },
  setSchedule(mode){
    if(!this.guard())return;
    Store.setScheduleMode(mode);
    Store.generateToday();
    route(); toast(mode==="vacation"?"已切换到 🏖 假期方案：课表与提醒时间立即生效":"已切换到 🏠 日常方案");
  },
  /* 模板导入导出（E-2：同班家长分享常用作业结构） */
  exportTemplates(){
    const tpls=Store.db.templates||[];
    if(!tpls.length) return toast("还没有模板可导出");
    const payload={ type:"hwbench-templates", version:2, exported_at:new Date().toISOString(), templates:tpls };
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob); a.download=`作业模板_${todayStr()}.json`; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),2000);
    toast(`已导出 ${tpls.length} 个模板`);
  },
  importTemplates(input){
    if(!this.guard())return;
    const f=input.files&&input.files[0]; if(!f) return;
    f.text().then(txt=>{
      try{
        const d=JSON.parse(txt);
        const tpls=Array.isArray(d)?d:(d.templates||[]);
        if(!Array.isArray(tpls)||!tpls.length) throw new Error("文件里没有模板");
        let added=0, dup=0;
        tpls.forEach(t=>{
          if(!t || !t.title || !t.subject) return;
          if(Store.db.templates.some(x=>x.title===t.title)){ dup++; return; }
          Store.db.templates.push({ id:uid(), title:String(t.title).slice(0,60), subject:String(t.subject),
            type:t.type||"其他", category:t.category||"学业", note:t.note||"",
            estimated_minutes:t.estimated_minutes||null, timer_mode:t.timer_mode||"stopwatch",
            limit_minutes:t.limit_minutes||null, overtime_remind:t.overtime_remind!=null?t.overtime_remind:5,
            allow_continue:t.allow_continue!==false, need_recording:!!t.need_recording, star_value:t.star_value||1 });
          added++;
        });
        Store.save(); route();
        toast(`导入 ${added} 个模板${dup?`（同名跳过 ${dup} 个）`:""}`);
      }catch(e){ toast("导入失败：不是有效的模板文件"); }
    });
    input.value="";
  },
  async importFile(input){
    const f=input.files&&input.files[0]; if(!f) return;
    try{ await Store.importJSON(f); route(); toast("备份已导入"); }
    catch(e){ toast("导入失败："+e.message); }
  },
  setGrade(g){ Store.db.settings.gradeMode=parseInt(g); if(Store.db.settings.gradeMode!==1) Store.db.settings.pinyin=false; Store.save(); route(); },
  setPinyin(v){ Store.db.settings.pinyin=v; Store.save(); toast(v?"注音已开启":"注音已关闭"); },
  resetAll(){ if(!this.guard())return;
    confirmModal("清空数据","将清空全部任务、星星与录音，恢复初始演示状态。",async()=>{
      await Store.reset(); location.hash="#/"; route(); toast("已重置");
    });
  }
};
