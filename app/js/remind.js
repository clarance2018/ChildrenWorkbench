/* ========== 提醒调度：页面播报 → 系统通知 → Kiosk 常亮 → 家长汇总 ========== */
const Remind = {
  KEY: "hw_remind_fired_v1",
  KIOSK_KEY: "hw_kiosk",
  fired: {},
  _timer: null,
  _perm: "default",
  kiosk: false,
  _wake: null,
  _speaking: false,
  _bannerTimer: null,

  /* ---------- 初始化 ---------- */
  init(){
    try{ this.fired = JSON.parse(localStorage.getItem(this.KEY) || "{}") || {}; }catch(e){ this.fired = {}; }
    this._prune();
    if(typeof Notification !== "undefined") this._perm = Notification.permission;
    if(!this._timer) this._timer = setInterval(()=>this.tick(), 20000);
    document.addEventListener("visibilitychange", ()=>{
      if(!document.hidden){ this.tick(); if(this.kiosk) this._acquireWake(); }
    });
    this.tick();
  },

  _prune(){
    const today = todayStr();
    Object.keys(this.fired).forEach(k=>{ if(!k.startsWith(today)) delete this.fired[k]; });
  },
  _save(){ try{ localStorage.setItem(this.KEY, JSON.stringify(this.fired)); }catch(e){} },
  _once(key){
    if(this.fired[key]) return false;
    this.fired[key] = Date.now();
    this._save();
    return true;
  },

  /* ---------- 权限 ---------- */
  async askPermission(){
    if(typeof Notification === "undefined"){ toast("当前浏览器不支持系统通知"); return false; }
    try{
      const p = await Notification.requestPermission();
      this._perm = p;
      if(p === "granted"){ toast("已开启系统通知"); this._sys("测试通知","提醒会像这样出现在通知栏 ✅"); }
      else toast("未开启通知，仅页面内提醒");
      return p === "granted";
    }catch(e){ return false; }
  },
  permLabel(){
    if(typeof Notification === "undefined") return "不支持";
    if(this._perm === "granted") return "已开启";
    if(this._perm === "denied") return "已被拒绝（需在浏览器设置中恢复）";
    return "未开启";
  },

  /* ---------- 主循环 ---------- */
  tick(){
    if(!Store.db || !Store.db.settings) return;
    const hash = location.hash || "";
    const isChild = hash.indexOf("#/child") === 0;
    const isParent = hash.indexOf("#/parent") === 0;
    if(!isChild && !isParent) return;
    const now = new Date();
    const hm = now.getHours()*60 + now.getMinutes();
    const today = todayStr();

    if(isChild) this._childTick(today, hm);
    if(isParent) this._parentTick(today, hm);
  },

  _childTick(today, hm){
    const tasks = Store.getTodayTasks().filter(t=>t.category==="习惯" && t.status!==STATUS.DONE);
    tasks.forEach(t=>{
      const h = Store.db.habits.find(x=>x.id===t.habit_id);
      if(!h || !h.remind_time) return;
      const [hh,mm] = h.remind_time.split(":").map(Number);
      const target = hh*60 + mm;
      const diff = hm - target;
      // 到点后 0~15 分钟内提醒一次（避免晚上才打开平板时补播一串旧提醒）
      if(diff >= 0 && diff <= 15 && this._once(`${today}:habit:${t.id}`)){
        this.fire("habit", `该${h.name}啦`, `${h.icon||"🧩"} ${t.title}${h.checklist&&h.checklist.length?"：先做 "+h.checklist[0]:""}`, t.id);
      }
    });

    // 未完成汇总：20:30 与 21:00 各一次
    const undone = Store.getTodayTasks().filter(t=>t.status!==STATUS.DONE);
    if(undone.length){
      if(hm >= 20*60+30 && hm <= 21*60+30 && this._once(`${today}:nag:2030`)){
        this.fire("nag", "还有任务没完成哦", `今天还剩 ${undone.length} 项，加油收个尾 💪`, undone[0].id);
      }
      if(hm >= 21*60 && hm <= 22*60 && this._once(`${today}:nag:2100`)){
        this.fire("nag", "快 21 点了", `还有 ${undone.length} 项没完成，做不完也没关系，明天继续`, undone[0].id);
      }
    }
  },

  _parentTick(today, hm){
    const undone = Store.getTodayTasks().filter(t=>t.status!==STATUS.DONE);
    if(!undone.length) return;
    if(hm >= 20*60+30 && hm <= 21*60+30 && this._once(`${today}:parent:2030`)){
      this.fire("parent", "今天还有任务没完成", `共 ${undone.length} 项未完成：${undone.slice(0,3).map(t=>t.title).join("、")}${undone.length>3?"…":""}`, null);
    }
    if(hm >= 21*60 && hm <= 22*60 && this._once(`${today}:parent:2100`)){
      this.fire("parent", "21:00 未完成提醒", `仍有 ${undone.length} 项未完成，可考虑退回或明天补`, null);
    }
  },

  /* ---------- 触发多级提醒 ---------- */
  fire(kind, title, body, taskId){
    const icons = { habit:"⏰", nag:"🌙", parent:"📋", done:"🎉" };
    this.banner(icons[kind]||"🔔", title, body, taskId);
    if(kind === "habit" || kind === "nag"){
      Sound.reminder();
      this.speak(title);
    }else{
      Sound.pop();
    }
    if(document.hidden || kind === "parent") this._sys(title, body);
  },

  banner(icon, title, body, taskId){
    let root = document.getElementById("remind-root");
    if(!root){ root = document.createElement("div"); root.id = "remind-root"; document.body.appendChild(root); }
    root.innerHTML = "";
    const el = document.createElement("div");
    el.className = "remind-banner";
    el.innerHTML = `<div class="rb-icon">${icon}</div>
      <div class="rb-main"><div class="rb-title">${esc(title)}</div><div class="rb-body">${esc(body)}</div></div>
      ${taskId?`<button class="btn btn-primary btn-sm">去做</button>`:""}
      <button class="btn btn-ghost btn-sm rb-close">×</button>`;
    const go = el.querySelector(".btn-primary");
    if(go) go.onclick = ()=>{ location.hash = "#/child/task/" + taskId; this.closeBanner(); };
    el.querySelector(".rb-close").onclick = ()=>this.closeBanner();
    root.appendChild(el);
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(()=>this.closeBanner(), 25000);
  },
  closeBanner(){
    const root = document.getElementById("remind-root");
    if(root) root.innerHTML = "";
  },

  _sys(title, body){
    if(typeof Notification === "undefined") return;
    if(this._perm !== "granted") return;
    try{
      if(navigator.serviceWorker && navigator.serviceWorker.ready){
        navigator.serviceWorker.ready.then(reg=>{
          reg.showNotification(title, { body, icon:"./icons/icon.svg", tag:"hwbench", renotify:true, vibrate:[120,60,120], data:{url:"./#/child"} });
        }).catch(()=>{});
      }else{
        new Notification(title, { body, icon:"./icons/icon.svg" });
      }
    }catch(e){}
  },

  speak(text){
    if(!("speechSynthesis" in window)) return;
    if(!Sound.enabled()) return;
    try{
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN"; u.rate = 0.95; u.pitch = 1.05; u.volume = 1;
      window.speechSynthesis.speak(u);
    }catch(e){}
  },

  /* ---------- 完成庆祝 ---------- */
  celebrate(){
    const key = `${todayStr()}:celebrate`;
    if(!this._once(key)) return false;
    Sound.celebrate();
    setTimeout(()=>this.speak("今天的任务全部完成，太棒了"), 700);
    return true;
  },

  /* ---------- Kiosk 专注模式 ---------- */
  async enterKiosk(){
    this.kiosk = true;
    try{ localStorage.setItem(this.KIOSK_KEY, "1"); }catch(e){}
    document.body.classList.add("kiosk-on");
    try{ if(document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); }catch(e){}
    await this._acquireWake();
    toast("已进入专注模式 · 长按左上角可退出");
  },
  async exitKiosk(){
    this.kiosk = false;
    try{ localStorage.removeItem(this.KIOSK_KEY); }catch(e){}
    document.body.classList.remove("kiosk-on");
    try{ if(document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen(); }catch(e){}
    this._releaseWake();
    toast("已退出专注模式");
  },
  toggleKiosk(){ this.kiosk ? this.exitKiosk() : this.enterKiosk(); },
  async _acquireWake(){
    try{
      if(!navigator.wakeLock || !navigator.wakeLock.request) return;
      this._releaseWake();
      this._wake = await navigator.wakeLock.request("screen");
    }catch(e){}
  },
  _releaseWake(){
    try{ if(this._wake){ this._wake.release(); this._wake = null; } }catch(e){}
  },
  resumeKiosk(){
    try{ if(localStorage.getItem(this.KIOSK_KEY) === "1"){ document.body.classList.add("kiosk-on"); this.kiosk = true; this._acquireWake(); } }catch(e){}
  }
};
