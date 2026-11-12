/* ========== 孩子端（Android 平板 Web） ========== */
const Child = {
  filter:"all",
  /* 执行页运行时状态（不持久化） */
  rt: { taskId:null, elapsed:0, running:false, paused:false, timer:null, startAt:0,
        mediaRecorder:null, recChunks:[], recStartAt:0, recording:false, warned:false },

  subjectIcon(s){
    return {"语文":"📖","数学":"📐","英语":"🔤","音乐":"🎵","体育":"🏃","美术":"🎨","科学":"🔬","习惯":"🧩","其他":"📌"}[s]||"📌";
  },
  subjectBg(s){
    return {"语文":"#fee2e2","数学":"#dbeafe","英语":"#ede9fe","音乐":"#fce7f3","体育":"#dcfce7","美术":"#fef3c7","科学":"#ccfbf1","习惯":"#ffedd5","其他":"#f3f4f6"}[s]||"#f3f4f6";
  },
  habitOf(t){ return t.habit_id ? Store.db.habits.find(h=>h.id===t.habit_id) : null; },

  nav(active){
    return `<div class="topbar">
      <div class="brand">🧒 孩子端 · ${esc(Store.db.child.name)}</div>
      <nav>
        <a href="#/child" class="${active==="home"?"active":""}">今日工作台</a>
        <a href="#/child/rewards" class="${active==="rewards"?"active":""}">🎁 奖励</a>
        <a href="#/child/badges" class="${active==="badges"?"active":""}">🏅 徽章</a>
      </nav>
      <a href="#/" class="muted small">返回入口</a>
    </div>`;
  },

  render(sub, param){
    // 仅在离开执行页时停表；执行页内部重绘（超时、录音保存）必须保留计时器
    if(sub!=="task") this.stopTimer();
    let html;
    switch(sub){
      case "task": html = this.nav("") + this.renderExec(param); break;
      case "rewards": html = this.nav("rewards") + this.renderRewards(); break;
      case "badges": html = this.nav("badges") + this.renderBadges(); break;
      default: html = this.nav("home") + this.renderHome();
    }
    // 专注模式下每页都保留唯一的退出入口（长按 1.5 秒）
    if(typeof Remind !== "undefined" && Remind.kiosk){
      html += `<div class="kiosk-dot" id="kiosk-dot" onpointerdown="Child.kioskPress(event)">退出</div>`;
    }
    return html;
  },

  /* ---------- K1 今日工作台（作业 / 任务分组） ---------- */
  renderHome(){
    const tasks = Store.getTodayTasks();
    const done = tasks.filter(t=>t.status===STATUS.DONE).length;
    const pct = tasks.length? Math.round(done/tasks.length*100):0;

    const now=new Date(); const hm=now.getHours()*60+now.getMinutes();
    const isPinned = t=>{
      const h=this.habitOf(t);
      if(!h || t.status===STATUS.DONE) return false;
      const rt=Store.habitRemindTime(h)||"23:59";
      const [hh,mm]=rt.split(":").map(Number);
      return hm >= hh*60+mm;
    };
    const sortFn = (a,b)=>{
      const pa=isPinned(a)?0:1, pb=isPinned(b)?0:1;
      if(pa!==pb) return pa-pb;
      return (a.status===STATUS.DONE?1:0)-(b.status===STATUS.DONE?1:0);
    };

    const homework = tasks.filter(t=>t.category!=="习惯").sort(sortFn);
    const habits  = tasks.filter(t=>t.category==="习惯").sort(sortFn);
    const filter = this.filter||"all";

    const group = (title, sub, list, kind)=>{
      if(!list.length) return "";
      return `<div class="group-head"><div class="g-title">${title}<span class="g-sub">${sub}</span></div></div>
        ${list.map(t=>this.taskCard(t, isPinned(t), kind)).join("")}`;
    };
    const cards =
      (filter==="habit" ? "" : group("📘 今日作业", `已完成 ${homework.filter(t=>t.status===STATUS.DONE).length}/${homework.length}`, homework, "homework")) +
      (filter==="homework" ? "" : group("🧩 习惯任务", `已完成 ${habits.filter(t=>t.status===STATUS.DONE).length}/${habits.length}`, habits, "habit"));

    const note = Store.db.notes[todayStr()];
    const usePinyin = Store.db.settings.gradeMode===1 && Store.db.settings.pinyin;
    const noteHtml = (note && note.show_to_child && note.note) ? `
      <div class="note-card">
        <div class="note-head" onclick="document.getElementById('note-body').classList.toggle('hidden')">
          <span>📌 今日备注</span><span class="muted small">点击展开/收起</span>
        </div>
        <div class="note-body" id="note-body">${(usePinyin && note.pinyin_enabled) ? toRuby(note.note) : esc(note.note).replace(/\n/g,"<br>")}</div>
      </div>`:"";

    const expired = Store.expiredYesterday();
    const allDone = tasks.length>0 && done===tasks.length;
    /* 首次全部完成：庆祝一次（当天只播一次） */
    const celeKey = `hw_cele_${todayStr()}`;
    if(allDone && !localStorage.getItem(celeKey)){
      localStorage.setItem(celeKey,"1");
      setTimeout(()=>{ starBurst(16); Remind.celebrate(); }, 260);
    }

    const kioskOn = (typeof Remind !== "undefined") && Remind.kiosk;
    const notifyState = (typeof Remind !== "undefined") ? Remind.permLabel() : "不支持";
    const unplayedEnc = (typeof Store !== "undefined" && Store.unplayedEncouragements) ? Store.unplayedEncouragements() : [];
    const modeTag = Store.db.settings.scheduleMode==="vacation" ? " · 🏖 假期模式" : "";

    return `<div class="child-shell">
      <div class="child-header">
        <div class="child-date">${dateCn(todayStr())}${modeTag}</div>
        <button class="kiosk-fab" onclick="Child.toggleKiosk()">${kioskOn?"🔓 退出专注":"🖥 专注模式"}</button>
      </div>
      ${noteHtml}
      ${allDone?`<div class="celebrate-card">
        <div class="cc-confetti">✨ ⭐ 🎉 ⭐ ✨</div>
        <div class="cc-emoji">🎉</div>
        <div class="cc-title">今天的任务全部完成！</div>
        <div class="cc-sub">已连续完成 ${Store.db.streak.days} 天 · 今天获得 ${tasks.reduce((s,t)=>s+(t.star_awarded||0),0)} ⭐<br>去「奖励」看看可以兑换什么吧</div>
      </div>`:""}
      ${expired.length?`<div class="note-card" style="background:#f8fafc;border-color:#e5e7eb">
        <div class="small muted">昨天有 ${expired.length} 项没完成，已自动归档。今天继续加油 💪</div></div>`:""}
      <div class="child-hero">
        <div class="hero-ring" style="background:conic-gradient(#3b82f6 ${pct}%, #e6ebf3 0)">
          <div class="hero-ring-in">
            <b>${pct}<i>%</i></b>
            <span>今日进度</span>
          </div>
        </div>
        <div class="hero-stats">
          <div class="hero-stat"><b>⭐ ${Store.db.points.total}</b><span>我的星星</span></div>
          <div class="hero-stat"><b>🔥 ${Store.db.streak.days}<i>天</i></b><span>连续完成</span></div>
          ${unplayedEnc.length?`<button class="hero-stat hero-mail" onclick="Child.openMailbox()"><b>📮 ${unplayedEnc.length}</b><span>爸妈的话</span></button>`:""}
        </div>
      </div>
      <div class="small muted" style="text-align:center;margin:-6px 0 12px">已完成 ${done} / ${tasks.length}${tasks.length-done?` · 还差 ${tasks.length-done} 项，加油！`:" · 太棒了！"}</div>
      <div class="filter-chips">
        <button class="${filter==="all"?"on":""}" onclick="Child.setFilter('all')">全部 ${tasks.length}</button>
        <button class="${filter==="homework"?"on":""}" onclick="Child.setFilter('homework')">📘 作业 ${homework.length}</button>
        <button class="${filter==="habit"?"on":""}" onclick="Child.setFilter('habit')">🧩 任务 ${habits.length}</button>
      </div>
      ${cards || `<div class="card"><div class="empty-tip">这里还没有内容，等爸爸妈妈发布哦～</div></div>`}
      <div class="small muted" style="text-align:center;margin-top:18px;line-height:1.9">
        🔔 到点提醒：${notifyState}${/未开启|不支持/.test(notifyState)?` · <a href="javascript:Remind.askPermission()">开启通知</a>`:""}
        ${kioskOn?" · 专注模式已开启（长按左上角 1.5 秒退出）":""}
      </div>
    </div>`;
  },
  setFilter(f){ this.filter=f; Sound.pop(); route(); },
  toggleKiosk(){
    const r = Remind.toggleKiosk();
    if(r && r.then) r.then(()=>route()); else route();
  },
  kioskPress(e){
    const el = document.getElementById("kiosk-dot"); if(!el) return;
    el.classList.add("pressing");
    el._t = setTimeout(()=>{
      el.classList.remove("pressing");
      const r = Remind.exitKiosk(); if(r && r.then) r.then(()=>route()); else route();
    }, 1500);
    const cancel = ()=>{ clearTimeout(el._t); el.classList.remove("pressing"); el.removeEventListener("pointerup",cancel); el.removeEventListener("pointerleave",cancel); };
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointerleave", cancel);
  },

  taskCard(t, pinned, kind){
    const stTag = STATUS_TAG[t.status]||"tag-gray";
    let btn="";
    if(t.status===STATUS.TODO) btn=`<button class="btn btn-primary" onclick="Child.openTask('${t.id}')">开 始</button>`;
    else if(t.status===STATUS.DOING||t.status===STATUS.OVERTIME) btn=`<button class="btn btn-green" onclick="Child.openTask('${t.id}')">继 续</button>`;
    else if(t.status===STATUS.REJECTED) btn=`<button class="btn btn-primary" onclick="Child.restart('${t.id}')">重新完成</button>`;
    else btn=`<span class="tag tag-green">✅ 完成 +${t.star_awarded||t.star_value||1}⭐</span>`;

    const h=this.habitOf(t);
    let ttStrip="";
    if(h && h.linked_timetable){
      const tmw=Store.getTimetable(tomorrowStr());
      ttStrip=`<div class="timetable-strip">📅 明日课表：${(tmw.subjects||[]).join(" / ")||"无"}${tmw.notes?`　备注：${esc(tmw.notes)}`:""}</div>`;
    }
    const isHabit = t.category==="习惯";
    const kindPill = `<span class="kind-pill ${isHabit?"kind-task":"kind-hw"}">${isHabit?"任务":"作业"}</span>`;
    const starPill = (t.star_value||1)>1 ? `<span class="star-value">+${t.star_value}⭐</span>` : "";
    const meta = [
      `<span class="tag tag-teal">${esc(t.type)}</span>`,
      t.estimated_minutes?`<span class="tag tag-gray">约 ${t.estimated_minutes} 分钟</span>`:"",
      t.need_recording?`<span class="tag tag-purple">🎙 需录音</span>`:"",
      t.co_parent && t.status!==STATUS.DONE?`<span class="tag tag-purple">👨‍👩‍👧 和${esc(t.co_parent)}一起</span>`:"",
      t.timer_mode==="countdown"?`<span class="tag tag-orange">⏳ 倒计时 ${t.limit_minutes} 分钟</span>`:`<span class="tag tag-gray">⏱ 正计时</span>`,
      `<span class="tag ${stTag}">${t.status}</span>`
    ].join("");
    const cls = t.status===STATUS.DONE?"done":t.status===STATUS.REJECTED?"rejected":pinned?"pinned":"";
    return `<div class="task-card ${cls}">
      <div class="task-icon" style="background:${this.subjectBg(t.subject)}">${h?h.icon:this.subjectIcon(t.subject)}</div>
      <div class="task-main">
        <div class="task-title">${kindPill}${pinned?"⏰ ":""}${this.maybeRuby(t.title)} ${starPill}</div>
        <div class="task-meta">${meta}</div>
        ${t.status===STATUS.REJECTED&&t.parent_note?`<div class="small mt8" style="color:var(--red)">家长退回：${esc(t.parent_note)}</div>`:""}
        ${ttStrip}
      </div>
      <div>${btn}</div>
    </div>`;
  },
  maybeRuby(text){
    return (Store.db.settings.gradeMode===1 && Store.db.settings.pinyin) ? toRuby(text) : esc(text);
  },
  openTask(id){
    const t=Store.getTask(id);
    if(t && t.status===STATUS.TODO) Store.updateTask(id,{status:STATUS.DOING});
    Sound.pop();
    location.hash="#/child/task/"+id;
  },
  restart(id){ Store.restartTask(id); this.openTask(id); },

  /* ---------- K2/K3/K4 执行页 ---------- */
  renderExec(id){
    const t=Store.getTask(id);
    if(!t) return `<div class="exec-shell"><div class="card">任务不存在</div></div>`;
    if(t.status===STATUS.DONE) return this.nav("") + `<div class="exec-shell"><div class="exec-card">
      <div style="font-size:52px">🎉</div><h2 class="mt8">已完成！+${t.star_awarded||t.star_value||1}⭐</h2>
      <div class="muted mt8">用时 ${fmtSec(t.actual_seconds||0)}</div>
      <div class="exec-actions"><button class="btn btn-primary" onclick="location.hash='#/child'">返回工作台</button></div></div></div>`;

    if(this.rt.taskId!==id){ this.resetRt(id); }
    else if(this.rt.running && !this.rt.paused && !this.rt.timer){ this.rt.timer=setInterval(()=>this.tick(),500); }

    const isHabit = t.category==="习惯";
    const isRec = t.need_recording;
    const noteHtml = (t.note?`<div class="exec-note">${this.maybeRuby(t.note)}</div>`:"")
      + (t.co_parent && t.status!==STATUS.DONE?`<div class="eye-banner" style="background:#f5f3ff;border-color:#ddd6fe;color:#4c1d95">👨‍👩‍👧 这一关需要<b>${esc(t.co_parent)}</b>陪你一起完成，叫上 ${esc(t.co_parent==="任一家长"?"爸爸或妈妈":t.co_parent)} 吧！</div>`:"");
    const kindPill = `<span class="kind-pill ${isHabit?"kind-task":"kind-hw"}">${isHabit?"任务":"作业"}</span>`;
    let body="";
    if(isHabit) body=this.execHabitBody(t);
    else if(t.drill) body=this.execDrillBody(t);
    else if(isRec) body=this.execRecBody(t);
    else body=this.execNormalBody(t);

    return `<div class="exec-shell">
      <button class="exec-back" onclick="Child.leaveExec()">← 返回工作台</button>
      <div class="exec-card">
        <div class="flex" style="justify-content:center;gap:8px">
          <span class="task-icon" style="background:${this.subjectBg(t.subject)}">${this.subjectIcon(t.subject)}</span>
          <div style="text-align:left"><b style="font-size:17px">${kindPill}${this.maybeRuby(t.title)}</b>
          <div class="small muted">${esc(t.subject)} · ${esc(t.type)} · 完成 +${t.star_value||1}⭐</div></div>
        </div>
        ${noteHtml}
        ${body}
      </div>
    </div>`;
  },

  execNormalBody(t){
    return `
      <div class="timer-label">${t.timer_mode==="countdown"?"倒计时（限时 "+t.limit_minutes+" 分钟）":"正计时"}</div>
      <div class="timer" id="tm">00:00</div>
      <div id="overtime-slot"></div>
      <div id="eye-slot"></div>
      <div class="exec-actions">
        <button class="btn btn-outline" id="btn-pause" onclick="Child.togglePause('${t.id}')">暂 停</button>
        <button class="btn btn-ghost" onclick="Child.finishTiming()">结束计时</button>
      </div>
      ${this.completeBtn(t)}`;
  },

  /* 口算练习作答：全部答对才可完成，错题自动入本 */
  execDrillBody(t){
    const qs=(t.drill&&t.drill.questions)||[];
    const inputs=qs.map((q,i)=>`
      <div class="drill-row">
        <span class="drill-q">${esc(q.q)} =</span>
        <input class="drill-input" id="drill-${i}" inputmode="numeric" autocomplete="off" maxlength="4">
      </div>`).join("");
    return `
      <div class="timer-label">✏️ 口算练习 · 共 ${qs.length} 题</div>
      <div class="drill-grid">${inputs}</div>
      <div class="small muted mt12">做完点「我已完成」——全部答对才算完成，错题会记进错题本等周末重练</div>
      <div class="mt16">
        <button class="btn btn-green btn-big" onclick="Child.confirmComplete('${t.id}')">✅ 我做完了</button>
      </div>`;
  },

  execRecBody(t){
    const recs=Store.getRecordings(t.id);
    const list = recs.map((r,i)=>`
      <div class="rec-item ${r.rejected?"rejected":""}">
        <span class="small muted" style="width:90px">#${i+1} ${fmtSec(r.duration)}${r.rejected?" 已退回":""}</span>
        <audio controls preload="none" src="${r.url||r.dataUrl}"></audio>
        <button class="btn btn-outline btn-sm" onclick="Child.rerecord('${t.id}','${r.id}')">🔁 重录</button>
        <button class="btn btn-red btn-sm" onclick="Child.delRec('${t.id}','${r.id}')">🗑</button>
      </div>`).join("");
    return `
      <div class="timer-label">正计时 + 录音</div>
      <div class="timer" id="tm">00:00</div>
      <div id="eye-slot"></div>
      <div class="exec-actions">
        <button class="btn ${this.rt.recording?"btn-red":"btn-primary"}" id="btn-rec" onclick="Child.toggleRecord('${t.id}')">
          ${this.rt.recording?"⏹ 停止录音":"⏺ 开始录音"}</button>
        <button class="btn btn-outline" id="btn-pause" onclick="Child.togglePause('${t.id}')">暂 停</button>
      </div>
      <div id="rec-state" class="small muted">${this.rt.recording?'<span class="rec-dot"></span> 录音中…':""}</div>
      <div class="rec-list">${list || '<div class="empty-tip" style="padding:16px">还没有录音，点击"开始录音"</div>'}</div>
      ${this.completeBtn(t)}`;
  },

  execHabitBody(t){
    const h=this.habitOf(t)||{};
    if(!Array.isArray(t.checks)) t.checks=(h.checklist||[]).map(()=>false);
    const tmw = h.linked_timetable ? Store.getTimetable(tomorrowStr()) : null;
    const cl = (h.checklist||[]).map((c,i)=>`
      <label class="check-row ${t.checks[i]?"done-row":""}">
        <input type="checkbox" ${t.checks[i]?"checked":""} onchange="Child.toggleCheck('${t.id}',${i},this.checked)">
        <span>${this.maybeRuby(c)}</span>
      </label>`).join("");
    return `
      ${Store.habitRemindTime(h)?`<div class="tag tag-orange">⏰ 提醒时间 ${Store.habitRemindTime(h)}</div>`:""}
      ${tmw?`<div class="timetable-strip mt12" style="text-align:left">📅 明日课表：${(tmw.subjects||[]).join(" / ")||"无"}${tmw.notes?`　备注：${esc(tmw.notes)}`:""}</div>`:""}
      <div class="checklist mt12">${cl||'<div class="empty-tip" style="padding:12px">无检查清单</div>'}</div>
        ${h.need_photo?`<div class="mt12"><label class="btn btn-outline">📷 ${Store.getPhoto(t.id)?"重新拍照":"拍照上传"}<input type="file" accept="image/*" capture="environment" class="hidden" onchange="Child.uploadPhoto('${t.id}',this)"></label>
        ${Store.getPhoto(t.id)?`<div class="mt8"><img src="${esc(Store.getPhoto(t.id))}" alt="任务照片" style="max-width:160px;border-radius:10px"><div class="small tag tag-green mt8">已上传照片 ✓</div></div>`:""}</div>`:""}
      ${this.completeBtn(t)}`;
  },

  completeBtn(t){
    let disabled=false, tip="";
    if(t.need_recording){
      const valid=Store.getRecordings(t.id).filter(r=>!r.rejected).length;
      if(valid<1){ disabled=true; tip="需要先录至少一段录音才能点哦"; }
    }
    if(t.status===STATUS.OVERTIME && !t.allow_continue){ disabled=true; tip="已超时且不允许继续，请找家长处理"; }
    return `<div class="mt16">
      <button class="btn btn-green btn-big" ${disabled?"disabled":""} onclick="Child.confirmComplete('${t.id}')">✅ 我已完成</button>
      ${tip?`<div class="small muted mt8">${tip}</div>`:""}
    </div>`;
  },

  /* ---------- 计时 ---------- */
  resetRt(id){
    this.stopTimer();
    this.rt={taskId:id, elapsed:0, running:true, paused:false, timer:null, startAt:Date.now(),
      mediaRecorder:null, recChunks:[], recStartAt:0, recording:false, warned:false,
      eyeSeconds:0, eyeRested:false};
    this.rt.timer=setInterval(()=>this.tick(),500);
  },
  tick(){
    const r=this.rt; if(!r.running||r.paused) return;
    r.elapsed=(Date.now()-r.startAt)/1000;
    const t=Store.getTask(r.taskId); if(!t) return;
    const el=document.getElementById("tm"); if(!el) return;
    /* 护眼节奏：连续专注 20 分钟自动暂停一次（设置可关） */
    if(Store.db.settings.eyeCare!==false){
      r.eyeSeconds=(r.eyeSeconds||0)+0.5;
      if(r.eyeSeconds>=1200 && !r.eyeRested) this.eyeRestNow();
    }
    if(t.timer_mode==="countdown"){
      const total=(t.limit_minutes||0)*60, remain=total-r.elapsed;
      const slot=document.getElementById("overtime-slot");
      if(remain<=0 && t.status!==STATUS.OVERTIME){
        Store.updateTask(t.id,{status:STATUS.OVERTIME});
        Sound.overtime();
        if(!t.allow_continue) this.stopTimer();
        route(); return;
      }
      if(t.status===STATUS.OVERTIME){
        el.textContent="+"+fmtSec(-remain); el.classList.add("over");
      }else{
        el.textContent=fmtSec(remain);
        // 超时提醒：到阈值提示一次（音效 + 横幅）
        if(t.overtime_remind!=null && remain<=t.overtime_remind*60 && remain>0){
          if(slot) slot.innerHTML=`<div class="overtime-banner">⏰ 还剩 ${fmtSec(remain)}，抓紧时间！</div>`;
          if(!r.warned){ Sound.tickWarn(); r.warned=true; }
        }
      }
    }else{
      el.textContent=fmtSec(r.elapsed);
    }
  },
  togglePause(id){
    const r=this.rt;
    if(r.paused){ r.paused=false; r.startAt=Date.now()-r.elapsed*1000; }
    else { r.paused=true; }
    const b=document.getElementById("btn-pause"); if(b) b.textContent=r.paused?"继 续":"暂 停";
    Sound.pop();
  },
  finishTiming(){ toast(`已计时 ${fmtSec(this.rt.elapsed)}，完成后记得点"我已完成"`); },
  /* ---------- 护眼 20 分钟节奏 ---------- */
  eyeRestNow(){
    const r=this.rt; if(!r) return;
    r.eyeRested=true; r.paused=true;           // 计时暂停（elapsed 冻结）
    Sound.eyeRest();
    const slot=document.getElementById("eye-slot");
    if(slot) slot.innerHTML=`<div class="eye-banner">👀 连续用眼 20 分钟啦！<b>看看远处休息 1 分钟</b>～
      <button class="btn btn-outline btn-sm" style="margin-left:8px" onclick="Child.eyeResume()">我休息好了</button></div>`;
    const b=document.getElementById("btn-pause"); if(b) b.textContent="休息中…";
  },
  eyeResume(){
    const r=this.rt; if(!r) return;
    r.paused=false; r.startAt=Date.now()-r.elapsed*1000;
    r.eyeSeconds=0; r.eyeRested=false;
    const slot=document.getElementById("eye-slot"); if(slot) slot.innerHTML="";
    const b=document.getElementById("btn-pause"); if(b) b.textContent="暂 停";
    Sound.pop();
  },
  stopTimer(){
    if(this.rt.timer){ clearInterval(this.rt.timer); this.rt.timer=null; }
    if(this.rt.mediaRecorder && this.rt.recording){ try{this.rt.mediaRecorder.stop();}catch(e){} this.rt.recording=false; }
  },
  leaveExec(){ this.stopTimer(); this.rt.taskId=null; location.hash="#/child"; },

  /* ---------- 录音 ---------- */
  async toggleRecord(id){
    const r=this.rt;
    if(r.recording){ r.mediaRecorder.stop(); r.recording=false; return; }
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const mime = ["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/ogg"].find(m=>window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
      const mr = mime ? new MediaRecorder(stream,{mimeType:mime}) : new MediaRecorder(stream);
      r.mediaRecorder=mr; r.recChunks=[]; r.recStartAt=Date.now(); r.recording=true;
      mr.ondataavailable=e=>{ if(e.data.size>0) r.recChunks.push(e.data); };
      mr.onstop=()=>{
        stream.getTracks().forEach(tr=>tr.stop());
        const blob=new Blob(r.recChunks,{type:mr.mimeType||"audio/webm"});
        const dur=Math.round((Date.now()-r.recStartAt)/1000);
        const fr=new FileReader();
        fr.onload=async()=>{
          toast("录音上传中…");
          const rec=await Store.addRecording(id,{dataUrl:fr.result,duration:dur,mime:mr.mimeType});
          route(); Sound.star(); toast(`录音已保存 🎙 ${fmtSec(rec.duration)}`);
        };
        fr.readAsDataURL(blob);
      };
      mr.start();
      const btn=document.getElementById("btn-rec"); if(btn){btn.textContent="⏹ 停止录音";btn.className="btn btn-red";}
      const st=document.getElementById("rec-state"); if(st) st.innerHTML='<span class="rec-dot"></span> 录音中…';
      Sound.pop();
    }catch(e){
      toast("无法使用麦克风，请在平板浏览器中允许麦克风权限");
    }
  },
  delRec(id,recId){ Store.deleteRecording(id,recId); route(); },
  rerecord(id,recId){ Store.deleteRecording(id,recId); route(); setTimeout(()=>this.toggleRecord(id),120); },
  toggleCheck(id,i,v){ const t=Store.getTask(id); t.checks[i]=v; Store.save(); Sound.pop(); route(); },
  async uploadPhoto(id,input){
    const f=input.files&&input.files[0]; if(!f) return;
    toast("正在上传照片…");
    try{
      const dataUrl=await this.shrinkImage(f);
      await Store.addPhoto(id,{dataUrl,mime:"image/jpeg"});
      route(); toast("照片已上传 📷");
    }catch(e){ toast("照片上传失败，请重试"); }
  },
  /* 平板拍的照片动辄 5MB，先压到最长边 1280 再上传 */
  shrinkImage(file,max=1280){
    return new Promise((resolve)=>{
      const fr=new FileReader();
      fr.onerror=()=>resolve(null);
      fr.onload=()=>{
        const img=new Image();
        img.onerror=()=>resolve(fr.result);
        img.onload=()=>{
          try{
            const scale=Math.min(1,max/Math.max(img.width,img.height));
            const c=document.createElement("canvas");
            c.width=Math.round(img.width*scale); c.height=Math.round(img.height*scale);
            c.getContext("2d").drawImage(img,0,0,c.width,c.height);
            resolve(c.toDataURL("image/jpeg",0.82));
          }catch(e){ resolve(fr.result); }
        };
        img.src=fr.result;
      };
      fr.readAsDataURL(file);
    });
  },

  /* ---------- 完成（二次确认 + 5 秒撤销 + 动效音效；口算先判分） ---------- */
  drillCheck(t){
    const qs=(t.drill&&t.drill.questions)||[];
    let filled=0, wrong=[];
    qs.forEach((q,i)=>{
      const el=document.getElementById("drill-"+i);
      const v=el?String(el.value||"").trim():"";
      if(v==="") return;
      filled++;
      if(parseInt(v,10)!==q.a){
        wrong.push(i);
        if(el) el.classList.add("wrong");
      }else if(el) el.classList.remove("wrong");
    });
    return {total:qs.length, filled, wrong};
  },
  confirmComplete(id){
    const t=Store.getTask(id); if(!t) return;

    /* 口算练习：全部答对才算完成，错题入本 */
    if(t.drill){
      const r=this.drillCheck(t);
      if(r.filled<r.total){
        Sound.overtime();
        return toast(`还有 ${r.total-r.filled} 题没做哦，做完再交`);
      }
      if(r.wrong.length){
        Sound.reject();
        r.wrong.forEach(i=>{
          const q=t.drill.questions[i];
          Store.addMistake({ title:`${q.q}=?`, subject:t.subject||"数学", reason:"口算错题" });
        });
        modal("再检查一下", `答对了 <b style="color:var(--green)">${r.total-r.wrong.length}</b> / ${r.total} 题。<br>
          红色的 ${r.wrong.length} 题算错了，已经记到错题本，周末再练一遍。<br>现在改对它们，也可以直接得 ⭐！`,[
          {label:"我再改改",cls:"btn-primary",fn:()=>route()}
        ]);
        route();
        return;
      }
    }

    const star=t.star_value||1;
    modal("完成任务", `确定完成「${esc(t.title)}」吗？<br>完成后立即得 <b style="color:var(--orange)">+${star} ⭐</b>`,[
      {label:"再检查一下",cls:"btn-ghost",fn:null},
      {label:"确定完成",cls:"btn-green",fn:()=>{
        this.stopTimer();
        const prevElapsed = this.rt.taskId===id ? this.rt.elapsed : 0;
        const delta = Store.completeTask(id, prevElapsed);
        location.hash="#/child";
        Sound.complete(); setTimeout(()=>Sound.star(),260); starBurst(Math.min(10,delta+5));
        toast(`🎉 +${delta} ⭐ 太棒了！`, {label:"撤销（5秒内）", fn:()=>{
          if(Store.undoComplete(id)){ route(); toast("已撤销完成"); } else { toast("超过 5 秒，不能撤销了"); }
        }}, 5200);
        route();
        /* 星星音效之后，若有未播放的家长鼓励则播一段（语音 + 文字气泡） */
        setTimeout(()=>this.playEncouragement(id), 1100);
      }}
    ], true);
  },

  /* ---------- 家长语音鼓励：完成后播一段；播放成功才标记已播（审计 G4） ---------- */
  playEncouragement(taskId){
    if(Store.db.settings.encouragement===false) return;
    const list=Store.unplayedEncouragements();
    if(!list.length) return;
    /* 优先：关联当前任务的 → 通用（未关联）的 → 最早的 */
    const e=list.find(x=>x.task_id===taskId) || list.find(x=>!x.task_id) || list[list.length-1];
    Sound.encourage();
    toast(e.text?`💌 ${e.text}`:"💌 爸爸妈妈有句悄悄话给你，点开听听～", {label:"▶ 播放", fn:()=>this._playEnc(e)}, 9000);
    this._playEnc(e);   // 大多数平板在用户刚点击后允许自动播放
  },
  _playEnc(e){
    try{
      const a=new Audio(e.url||e.dataUrl); a.volume=0.95;
      a.play().then(()=>Store.markEncouragementPlayed(e.id))
        .catch(()=>{ /* 自动播放被拦截：不标记，首页 📮 信箱常驻直至成功播放 */ });
    }catch(err){}
  },
  /* 首页 📮 信箱：集中播放所有未听的鼓励 */
  openMailbox(){
    const list=Store.unplayedEncouragements();
    if(!list.length) return toast("没有新的悄悄话，完成任务就会有啦～");
    modal("📮 爸爸妈妈的悄悄话", list.map(e=>`
      <div class="enc-item">
        <div class="small" style="flex-basis:100%">${e.text?"💌 "+this.maybeRuby(e.text):"点开听听"}</div>
        <audio controls preload="metadata" src="${e.url||e.dataUrl}"
          onended="Store.markEncouragementPlayed('${e.id}')"></audio>
      </div>`).join(""), [{label:"知道了",cls:"btn-primary",fn:()=>route()}], true);
  },

  /* ---------- K5 奖励商城（余额 / 愿望 / 兑换 / 明细） ---------- */
  renderRewards(){
    const total=Store.db.points.total;
    const earned=Store.db.points.earned_total!=null?Store.db.points.earned_total:total;
    const goal=Store.db.settings.goals;

    const goalCard = goal ? `
      <div class="exec-card mb12 goal-card">
        <div class="flex-between"><b>🎯 ${this.maybeRuby(goal.name)}</b>
          <button class="btn btn-ghost btn-sm" onclick="Child.goalModal()">改目标</button></div>
        <div class="progress-bar mt12"><i style="width:${Math.min(100,Math.round(total/goal.target*100))}%"></i></div>
        <div class="small muted mt8">已存 ${total} / ${goal.target} ⭐，还差 ${Math.max(0,goal.target-total)} 颗</div>
      </div>` : `
      <div class="exec-card mb12 goal-card">
        <b>🎯 我的存星目标</b>
        <div class="small muted mt8">定一个小愿望，看着星星慢慢攒满它</div>
        <button class="btn btn-primary mt12" onclick="Child.goalModal()">设一个目标</button>
      </div>`;

    const rewards=Store.getRewards();
    const cards=rewards.map(r=>{
      const can=total>=r.cost && r.active!==false;
      return `<div class="reward-card ${can?"":"short"}">
        <div class="rc-icon">${r.icon||"🎁"}</div>
        <div class="rc-main"><b>${this.maybeRuby(r.name)}</b>
          ${r.desc?`<div class="small muted">${this.maybeRuby(r.desc)}</div>`:""}</div>
        <div class="rc-cost">${r.cost}⭐</div>
        <div>${can?`<button class="btn btn-primary" onclick="Child.redeem('${r.id}')">兑换</button>`
          :`<span class="tag tag-gray">还差 ${r.cost-total}⭐</span>`}</div>
      </div>`;
    }).join("");

    const mine=Store.getRedemptions().slice(0,10).map(r=>`<tr>
      <td>${r.reward_icon||"🎁"} ${esc(r.reward_name)}</td><td>${r.cost}⭐</td>
      <td>${r.status==="pending"?'<span class="tag tag-orange">等家长确认</span>':r.status==="fulfilled"?'<span class="tag tag-green">已兑现 🎉</span>':`<span class="tag tag-red">未通过</span>${r.note?`<div class="small muted">${esc(r.note)}</div>`:""}`}</td>
      <td class="muted small">${(r.requested_at||"").slice(5,16).replace("T"," ")}</td></tr>`).join("");

    const log=[...Store.db.points.log].reverse().slice(0,15);
    const rows=log.map(l=>{
      const t=Store.getTask(l.task_id);
      return `<tr><td>${l.delta>0?`+${l.delta} ⭐`:`${l.delta} ⭐`}</td>
        <td>${esc(t?t.title:(l.reason==="redeem"?"兑换奖励":"（任务已删除）"))}</td>
        <td>${{complete:"完成任务",undo:"撤销完成",revoke_reject:"家长退回",redeem:"兑换奖励"}[l.reason]||l.reason}</td>
        <td class="muted small">${(l.created_at||"").slice(5,16).replace("T"," ")}</td></tr>`;
    }).join("");

    return `<div class="child-shell">
      <div class="exec-card mb12"><div style="font-size:44px">⭐</div>
        <div style="font-size:40px;font-weight:800">${total}</div>
        <div class="muted">可以用的星星 · 累计挣到 ${earned} ⭐</div></div>
      ${goalCard}
      ${cards?`<div class="mall-grid">${cards}</div>`:`<div class="card mb12"><div class="empty-tip">爸爸妈妈还没上架奖励，先攒星星吧～</div></div>`}
      ${mine?`<div class="card"><h3>我的兑换</h3>
        <table class="grid"><thead><tr><th>奖励</th><th>花费</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>${mine}</tbody></table></div>`:""}
      <div class="card"><h3>星星明细</h3>
        <table class="grid"><thead><tr><th>变化</th><th>任务</th><th>原因</th><th>时间</th></tr></thead>
        <tbody>${rows||`<tr><td colspan="4"><div class="empty-tip">完成任务就能获得星星，加油！</div></td></tr>`}</tbody></table></div>
    </div>`;
  },
  redeem(id){
    const r=Store.getRewards().find(x=>x.id===id); if(!r) return;
    modal("兑换奖励", `用 <b style="color:var(--orange)">${r.cost} ⭐</b> 兑换「${esc(r.name)}」吗？<br>
      兑换后要等爸爸妈妈确认才算成功哦`,[
      {label:"再想想",cls:"btn-ghost",fn:null},
      {label:"确定兑换",cls:"btn-primary",fn:()=>{
        const res=Store.requestRedemption(id);
        if(res.ok){ Sound.star(); route(); toast("兑换申请已发送，等爸爸妈妈确认 🎁"); }
        else toast(res.message||"暂时不能兑换");
      }}
    ], true);
  },
  goalModal(){
    const g=Store.db.settings.goals||{name:"",target:50};
    modal("我的存星目标", `<div class="form-row"><label>愿望是什么？</label>
      <input id="goal-name" maxlength="30" value="${esc(g.name||"")}" placeholder="如：买一套乐高"></div>
      <div class="form-row mt12"><label>需要多少颗星星？</label>
      <input id="goal-target" type="number" min="1" max="9999" value="${g.target||50}"></div>`,[
      {label:"取消",cls:"btn-ghost",fn:null},
      ...(Store.db.settings.goals?[{label:"删除目标",cls:"btn-red",fn:()=>{ Store.clearGoal(); route(); }}]:[]),
      {label:"保存",cls:"btn-primary",fn:()=>{
        const name=(document.getElementById("goal-name")||{}).value||"我的愿望";
        const target=parseInt((document.getElementById("goal-target")||{}).value,10)||50;
        Store.setGoal(name,target); route(); Sound.pop(); toast("目标已保存，加油攒星星！");
      }}
    ], true);
  },

  /* ---------- K6 徽章 ---------- */
  renderBadges(){
    const items=Store.badges().map(b=>`
      <div class="badge-item ${b.got?"":"locked"}">
        <div class="b-icon">${b.icon}</div>
        <div class="bold">${esc(b.name)}</div>
        <div class="small muted mt8">${esc(b.desc)}</div>
        <div class="badge-progress"><i style="width:${b.pct}%"></i></div>
        <div class="mt8">${b.got?'<span class="tag tag-green">已获得</span>':`<span class="tag tag-gray">${b.pct}%</span>`}</div>
      </div>`).join("");
    return `<div class="child-shell">
      <div class="page-title mb12">🏅 我的徽章 <span class="small muted">（连续 ${Store.db.streak.days} 天 · 累计 ${Store.db.points.total} ⭐）</span></div>
      <div class="badge-grid">${items}</div>
    </div>`;
  }
};
