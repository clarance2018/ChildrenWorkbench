/* ========== 数据层：后端 API + 本地缓存（服务不可用时自动降级为纯本地模式） ========== */
const DB_KEY = "hwbench_cache_v2";
const API_BASE = "/api";

const STATUS = {
  TODO:"未开始", DOING:"进行中", DONE:"孩子已完成", REVIEW:"待复核",
  REJECTED:"已退回", OVERTIME:"超时", EXPIRED:"已过期"
};
const STATUS_TAG = {
  "未开始":"tag-gray","进行中":"tag-blue","孩子已完成":"tag-green","待复核":"tag-green",
  "已退回":"tag-red","超时":"tag-orange","已过期":"tag-gray"
};

/* A：科目 → 要带的物品（家长可在「设置 · 科目物品清单」里改） */
const DEFAULT_SUBJECT_KIT = {
  "语文":["语文课本","生字本"], "数学":["数学课本","口算本"], "英语":["英语课本"],
  "体育":["运动鞋","跳绳"], "美术":["水彩笔","图画本"], "音乐":["口风琴"],
  "科学":["科学课本"], "阅读":["课外书"]
};
const SLOT_LABEL = { morning:"🌅 早晨", after:"🏫 放学后", night:"🌙 睡前" };

/* 标准课表网格：课段 / 节次 × 星期一~星期日（对齐学校发的《学生课程表》）
 * rows[i].cells[w-1] = 科目；rows[i].metas[w-1] = 老师 / 教室（选填，不参与书包清单）
 * timetable[w].subjects 仍是下游唯一权威（MCP、周报、语音、书包清单都读它），
 * 网格每次编辑即时派生 subjects，避免两套数据各写各的。 */
const DEFAULT_GRID_ROWS = [
  { period:"morning",   label:"第1节" }, { period:"morning",   label:"第2节" },
  { period:"morning",   label:"第3节" }, { period:"morning",   label:"第4节" },
  { period:"afternoon", label:"第1节" }, { period:"afternoon", label:"第2节" }
];
const PERIOD_LABEL = { morning:"上午", afternoon:"下午" };
/* 小学常见科目全称：家长填课表时给建议，避免「体育与健康」被写成「体育课」导致清单匹配不上 */
const COMMON_SUBJECTS = ["语文","数学","英语","体育与健康","艺术(美术)","艺术(音乐)",
  "道德与法治","科学","书法","劳动","综合实践活动","阅读拓展","数学拓展","地方(英语)",
  "体育","美术","音乐","阅读","写字","班会","信息技术","体育活动"];

function uid(){ return "id_" + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function todayStr(){ return fmtDate(new Date()); }
function fmtDate(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function tomorrowStr(){ const d=new Date(); d.setDate(d.getDate()+1); return fmtDate(d); }
function yesterdayStr(){ const d=new Date(); d.setDate(d.getDate()-1); return fmtDate(d); }
function weekdayOf(dateStr){ const d=new Date(dateStr+"T12:00:00"); const w=d.getDay(); return w===0?7:w; }
function weekdayCn(w){ return ["","周一","周二","周三","周四","周五","周六","周日"][w]; }
function dateCn(dateStr){ const d=new Date(dateStr+"T12:00:00"); return `${d.getMonth()+1}月${d.getDate()}日 ${weekdayCn(weekdayOf(dateStr))}`; }
function fmtSec(s){ s=Math.max(0,Math.floor(s)); const m=Math.floor(s/60), ss=s%60, h=Math.floor(m/60);
  return h>0? `${h}:${String(m%60).padStart(2,"0")}:${String(ss).padStart(2,"0")}` : `${String(m).padStart(2,"0")}:${String(ss).padStart(2,"0")}`; }
/* UTC ISO 字符串 → 本地时间显示（GMT+8）。服务端统一存 UTC，前端直接 slice 会差 8 小时，
 * 一律走这里交给浏览器按本地时区解析。挂到 globalThis 以便测试桩 eval 加载后也能调用。 */
function fmtTime(iso){
  if(!iso) return "";
  const d=new Date(iso);
  if(isNaN(d.getTime())) return String(iso).slice(5,16).replace("T"," ") || String(iso);
  const p=n=>String(n).padStart(2,"0");
  return `${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDateOf(iso){
  if(!iso) return "";
  const d=new Date(iso);
  if(isNaN(d.getTime())) return String(iso).slice(0,10);
  return fmtDate(d);   /* 按本地时区取日期，避免 00:00~08:00 错一天 */
}
if(typeof globalThis!=="undefined"){ globalThis.fmtTime=fmtTime; globalThis.fmtDateOf=fmtDateOf; }

const Store = {
  db:null, version:0, remote:false, _timer:null, _writing:false, onRemoteSync:null,
  needAuth:false, info:null, _snap:null,

  /* ---------- 初始化 ---------- */
  async init(){
    this.db = this._readCache() || this.seed();
    this.migrate();
    await this._probe();
    if(this.remote && !this.needAuth){
      const got = await this._pull();
      if(got==="empty"){ this.db = this.seed(); this.migrate(); await this._push(); }  // 服务端首次启动写入种子
    }
    this.migrate();
    this.generateToday();
    this._writeCache();
    this._stamp();
    if(this.remote && !this.needAuth) this.flushPending();   // 恢复在线后补传离线录音
    window.addEventListener && window.addEventListener("online", ()=>this.flushPending());
  },
  async _probe(){
    try{
      const c=new AbortController(); const t=setTimeout(()=>c.abort(),1500);
      const res=await fetch(API_BASE+"/health",{signal:c.signal}); clearTimeout(t);
      if(!res.ok){ this.remote=false; return false; }
      const data=await res.json().catch(()=>null);
      this.remote = !!(data && data.ok===true);
      this.info = data;
      this.needAuth = !!(data && data.auth && data.auth.required && !data.auth.scope);
    }catch(e){ this.remote=false; }
    return this.remote;
  },
  async _pull(){
    try{
      const res=await fetch(API_BASE+"/state");
      if(res.status===401){ this.needAuth=true; return "auth"; }
      const r=await res.json();
      this.version=r.version||0;
      this.needAuth=false;
      if(r.hasState && r.state){ this.db=r.state; return "ok"; }
      return "empty";
    }catch(e){ return "error"; }
  },

  /* 给每个实体打更新时间戳：合并时按"较新者胜"处理，避免两端互相覆盖 */
  _stamp(){
    const now=new Date().toISOString();
    const prev=this._snap||{};
    const snap={};
    [["tasks"],["periodRules"],["habits"],["templates"],["encouragements"],["rewards"],["redemptions"],["mistakes"]].forEach(([k])=>{
      snap[k]={};
      (this.db[k]||[]).forEach(x=>{
        if(!x.id) return;
        const old=prev[k] && prev[k][x.id];
        const cur=JSON.stringify(x);
        if(old===undefined){ x.updated_at=x.updated_at||x.created_at||now; }
        else if(old!==cur){ x.updated_at=now; }
        snap[k][x.id]=JSON.stringify(x);
      });
    });
    this._snap=snap;
  },

  /* 删除并写墓碑，防止旧快照把已删任务同步回来 */
  remove(collection, id){
    const list=this.db[collection]||[];
    this.db[collection]=list.filter(x=>x.id!==id);
    this.db.deleted=this.db.deleted||[];
    this.db.deleted.push({id, at:new Date().toISOString()});
    if(this.db.deleted.length>800) this.db.deleted=this.db.deleted.slice(-800);
    this.save();
  },
  _readCache(){ try{ return JSON.parse(localStorage.getItem(DB_KEY)); }catch(e){ return null; } },
  _writeCache(){ try{ localStorage.setItem(DB_KEY, JSON.stringify(this.db)); }catch(e){} },

  /* ---------- 离线待传队列（审计 G3：录音 base64 不进同步状态） ---------- */
  _queuePending(entry){
    try{
      const q=JSON.parse(localStorage.getItem("hw_pending")||"[]");
      if(!q.some(x=>x.id===entry.id)){ q.push(entry); localStorage.setItem("hw_pending", JSON.stringify(q)); }
    }catch(e){}
  },
  _pendingList(){ try{ return JSON.parse(localStorage.getItem("hw_pending")||"[]"); }catch(e){ return []; } },
  /* 推送前脱敏：待传中的 data: URL 置空，避免几段录音就把 12MB 同步上限吃爆 */
  _sanitizeForPush(){
    if(!this._pendingList().length) return this.db;
    const s=JSON.parse(JSON.stringify(this.db));
    Object.values(s.recordings||{}).forEach(arr=>(arr||[]).forEach(r=>{ if(/^data:/.test(r.url||"")) r.url=""; }));
    (s.encouragements||[]).forEach(e=>{ if(/^data:/.test(e.url||"")) e.url=""; });
    (s.photos&&Object.keys(s.photos||{})).forEach(k=>{ if(/^data:/.test(s.photos[k]||"")) s.photos[k]=""; });
    return s;
  },
  /* 拉取远端后，把本地待传录音的 dataUrl 贴回对应记录，保证离线期间仍可播放 */
  _restorePendingUrls(){
    const q=this._pendingList();
    if(!q.length) return;
    q.forEach(p=>{
      if(p.kind==="recording"){
        ((this.db.recordings||{})[p.taskId]||[]).forEach(r=>{ if(r.id===p.id && !r.url) r.url=p.dataUrl; });
      }else{
        (this.db.encouragements||[]).forEach(e=>{ if(e.id===p.id && !e.url) e.url=p.dataUrl; });
      }
    });
  },
  async flushPending(){
    if(!this.remote || this.needAuth) return 0;
    const q=this._pendingList(); if(!q.length) return 0;
    let flushed=0, rest=[];
    for(const p of q){
      try{
        const r=await fetch(API_BASE+"/recordings",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({taskId:p.taskId,dataUrl:p.dataUrl,duration:p.duration,mime:p.mime})}).then(x=>x.json());
        if(r && r.url){
          if(p.kind==="recording"){
            ((this.db.recordings||{})[p.taskId]||[]).forEach(rec=>{ if(rec.id===p.id) rec.url=r.url; rec.updated_at=new Date().toISOString(); });
          }else{
            (this.db.encouragements||[]).forEach(e=>{ if(e.id===p.id) e.url=r.url; e.updated_at=new Date().toISOString(); });
          }
          flushed++;
        }else rest.push(p);
      }catch(e){ rest.push(p); break; }   // 网络仍不通，停止尝试
    }
    try{ localStorage.setItem("hw_pending", JSON.stringify(rest)); }catch(e){}
    if(flushed) this.save();
    return flushed;
  },

  save(){
    this._stamp();
    this._writeCache();
    if(!this.remote || this.needAuth) return;
    clearTimeout(this._timer);
    this._timer=setTimeout(()=>this._push(),280);
  },
  async _push(){
    if(!this.remote || this.needAuth) return;
    this._writing=true;
    try{
      const res=await fetch(API_BASE+"/state",{method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({state:this._sanitizeForPush(), writer:this.db.settings.role})});
      if(res.status===401){ this.needAuth=true; if(this.onAuthLost) this.onAuthLost(); }
      else{
        const r=await res.json();
        if(r && r.version!=null) this.version=r.version;
      }
    }catch(e){ /* 离线时依赖本地缓存，恢复后随下次写入同步 */ }
    this._writing=false;
  },
  /* 轮询拉取其他设备的修改 */
  async sync(){
    if(!this.remote || document.hidden || this._writing || this.needAuth) return false;
    try{
      const res=await fetch(API_BASE+"/state");
      if(res.status===401){ this.needAuth=true; if(this.onAuthLost) this.onAuthLost(); return false; }
      const r=await res.json();
      if(r.version!==this.version && r.state){
        this.db=r.state; this.version=r.version; this.migrate();
        this._restorePendingUrls();
        this._snap=null; this._stamp();
        if(this.onRemoteSync) this.onRemoteSync();
        return true;
      }
    }catch(e){}
    return false;
  },
  /* 登录后重新建立连接并拉取服务端状态 */
  async resume(){
    this.needAuth=false;
    await this._probe();
    if(this.remote){
      const got=await this._pull();
      if(got==="empty") await this._push();
      this.migrate(); this._snap=null; this._stamp(); this._writeCache();
    }
  },
  async reset(){
    this.db=this.seed(); this.migrate(); this._writeCache();
    if(this.remote) await this._push();
  },

  /* ---------- 种子数据 ---------- */
  seed(){
    return {
      schema_version:2,
      settings:{ gradeMode:1, pinyin:true, role:"admin", parent_pin:"1234", sound:true, encouragement:true,
                 eyeCare:true, scheduleMode:"daily", goals:null,
                 kitEnabled:true, tt_speak:true, show_timetable_card:true,
                 subjectKit:Object.assign({}, DEFAULT_SUBJECT_KIT) },
      child:{ id:"child_1", name:"小宝" },
      tasks:[], periodRules:[], templates:[],
      habits:[
        { id:"habit_bag", name:"整理明天书包", icon:"🎒", remind_time:"20:00", weekdays:[1,2,3,4,5,7],
          need_photo:false, need_review:false, star_enabled:true, linked_timetable:true,
          checklist:["按课表放好课本","文具盒装好","水杯装好"], active:true },
        { id:"habit_wash", name:"刷牙洗脸", icon:"🪥", remind_time:"21:00", weekdays:[1,2,3,4,5,6,7],
          need_photo:false, need_review:false, star_enabled:true, linked_timetable:false,
          checklist:["刷牙 2 分钟","洗脸","擦香香"], active:true },
        { id:"habit_toy", name:"收拾玩具", icon:"🧸", remind_time:"19:30", weekdays:[1,2,3,4,5,6,7],
          need_photo:false, need_review:false, star_enabled:true, linked_timetable:false,
          checklist:["玩具放回箱子","绘本放回书架"], active:true }
      ],
      timetable:{
        1:{subjects:["语文","数学","英语"],notes:""}, 2:{subjects:["语文","数学","体育"],notes:""},
        3:{subjects:["数学","语文","美术"],notes:"美术带彩笔"}, 4:{subjects:["语文","英语","音乐"],notes:""},
        5:{subjects:["数学","语文","科学"],notes:""}, 6:{subjects:[],notes:"周末"}, 7:{subjects:["阅读"],notes:"周末"}
      },
      timetableOverrides:{}, notes:{}, recordings:{}, photos:{}, encouragements:[],
      vacationTimetable:{1:{subjects:[],notes:""},2:{subjects:[],notes:""},3:{subjects:[],notes:""},
        4:{subjects:[],notes:""},5:{subjects:[],notes:""},6:{subjects:[],notes:""},7:{subjects:[],notes:""}},
      rewards:[
        { id:"reward_1", name:"看一集动画片", icon:"📺", cost:20, desc:"20 分钟以内的一集", active:true,
          created_at:new Date().toISOString(), updated_at:new Date().toISOString() },
        { id:"reward_2", name:"周末去公园", icon:"🛝", cost:50, desc:"全家一起去", active:true,
          created_at:new Date().toISOString(), updated_at:new Date().toISOString() },
        { id:"reward_3", name:"选一个冰淇淋", icon:"🍦", cost:15, desc:"放学路上自己挑", active:true,
          created_at:new Date().toISOString(), updated_at:new Date().toISOString() }
      ],
      redemptions:[], mistakes:[],
      points:{ total:0, earned_total:0, log:[] }, streak:{ days:0, lastDate:null }
    };
  },

  /* ---------- 数据迁移 ---------- */
  migrate(){
    const d=this.db; d.schema_version=2;
    d.settings=Object.assign({gradeMode:1,pinyin:true,role:"admin",parent_pin:"1234",sound:true,
      encouragement:true,eyeCare:true,scheduleMode:"daily",goals:null,
      kitEnabled:true,tt_speak:true,show_timetable_card:true,timetable_updated_at:null,
      kitMergeManual:true}, d.settings||{});
    /* 家长改过的科目保留，缺失的补默认；把某科目设为 [] 即可表示"不用带东西"。
     * subjectRemoved 是删除墓碑：被删的科目不会再被 migrate 的默认科目补回来，也不会出现在填写建议里。 */
    d.settings.subjectRemoved=Array.isArray(d.settings.subjectRemoved)?d.settings.subjectRemoved:[];
    d.settings.subjectKit=Object.assign({}, DEFAULT_SUBJECT_KIT, d.settings.subjectKit||{});
    d.settings.subjectRemoved.forEach(k=>{ delete d.settings.subjectKit[k]; });
    d.child=d.child||{id:"child_1",name:"小宝"};
    d.templates=d.templates||[]; d.notes=d.notes||{}; d.recordings=d.recordings||{}; d.photos=d.photos||{};
    d.encouragements=d.encouragements||[];
    d.periodRules=d.periodRules||[]; d.tasks=d.tasks||[];
    d.habits=d.habits||[];
    d.timetable=d.timetable||{1:{subjects:[],notes:""},2:{subjects:[],notes:""},3:{subjects:[],notes:""},
      4:{subjects:[],notes:""},5:{subjects:[],notes:""},6:{subjects:[],notes:""},7:{subjects:[],notes:""}};
    d.timetableOverrides=d.timetableOverrides||{};
    /* 标准课表网格：旧的一行式课表无损迁移成「课段/节次 × 7 天」 */
    d.timetableGrid=this.normalizeGrid(d.timetableGrid,d.timetable);
    d.vacationTimetableGrid=this.normalizeGrid(d.vacationTimetableGrid,d.vacationTimetable);
    /* REST/MCP 直接写 timetable[w] 时也会反向同步到网格，避免两端各写各的 */
    this.reconcileGridFromPack();
    d.points=d.points||{total:0,log:[]}; d.points.log=d.points.log||[]; d.streak=d.streak||{days:0,lastDate:null};
    /* 兑换商城 / 错题本 / 假期课表（Batch D/E） */
    d.rewards=d.rewards||[]; d.redemptions=d.redemptions||[]; d.mistakes=d.mistakes||[];
    d.vacationTimetable=d.vacationTimetable||{1:{subjects:[],notes:""},2:{subjects:[],notes:""},3:{subjects:[],notes:""},
      4:{subjects:[],notes:""},5:{subjects:[],notes:""},6:{subjects:[],notes:""},7:{subjects:[],notes:""}};
    /* 累计获得口径：用流水重算，保证旧数据迁移后徽章不掉级（审计 G2） */
    if(d.points.earned_total==null){
      d.points.earned_total=(d.points.log||[]).reduce((s,e)=>s+Math.max(0,Number(e.delta)||0),0);
    }
    d.deleted=d.deleted||[];
    d.tasks=(d.tasks||[]).map(t=>{
      t.star_value = t.star_value || 1;
      t.category = t.category || (t.subject==="习惯"?"习惯":"学业");
      t.updated_at = t.updated_at || t.created_at || new Date().toISOString();
      if(t.date < todayStr() && [STATUS.TODO,STATUS.DOING,STATUS.OVERTIME].includes(t.status)) t.status=STATUS.EXPIRED;
      return t;
    });
    Object.values(d.recordings).forEach(arr=>arr.forEach(r=>{ if(!r.url && r.dataUrl) r.url=r.dataUrl; }));
  },

  /* ---------- 周期 / 习惯：每日惰性生成 ---------- */
  generateToday(){
    const today=todayStr(), w=weekdayOf(today);
    let changed=false;
    for(const r of this.db.periodRules){
      if(!r.active) continue;
      if(r.start_date && today<r.start_date) continue;
      if(r.end_date && today>r.end_date) continue;
      if(r.freq==="weekly" && !(r.weekdays||[]).includes(w)) continue;
      if(r.freq==="once" && r.start_date!==today) continue;
      if(this.db.tasks.some(t=>t.period_rule_id===r.id && t.date===today)) continue;
      this.db.tasks.push(Object.assign({}, r.template, {
        id:uid(), date:today, period_rule_id:r.id, source:"周期生成", status:STATUS.TODO,
        actual_seconds:null, completed_at:null, reviewed_by:null, reviewed_at:null,
        star_awarded:0, star_value:r.template.star_value||1, parent_note:""
      }));
      changed=true;
    }
    /* 清理：今天未开始的习惯实例，若习惯已停用或今天不在重复日，则撤下（防停用后孩子端仍显示） */
    this.db.tasks.filter(t=>t.habit_id && t.date===today && t.status===STATUS.TODO).forEach(t=>{
      const h=this.db.habits.find(x=>x.id===t.habit_id);
      if(!h || !h.active || !(h.weekdays||[]).includes(w)){ this.remove("tasks",t.id); changed=true; }
    });
    for(const h of this.db.habits){
      if(!h.active || !(h.weekdays||[]).includes(w)) continue;
      if(this.db.tasks.some(t=>t.habit_id===h.id && t.date===today)) continue;
      this.db.tasks.push({
        id:uid(), date:today, title:h.name, subject:"习惯", category:"习惯", type:"习惯",
        source:"习惯模板", habit_id:h.id, note:"", estimated_minutes:null,
        timer_mode:"stopwatch", limit_minutes:null, overtime_remind:null, allow_continue:true,
        need_recording:false, period_rule_id:null, status:STATUS.TODO, actual_seconds:null,
        completed_at:null, reviewed_by:null, reviewed_at:null, star_awarded:0,
        star_value:h.star_enabled===false?0:1, parent_note:""
      });
      changed=true;
    }
    if(changed) this.save();
  },

  getTodayTasks(){ return this.db.tasks.filter(t=>t.date===todayStr() && t.status!==STATUS.EXPIRED); },
  getTodayAll(){ return this.db.tasks.filter(t=>t.date===todayStr()); },
  getTask(id){ return this.db.tasks.find(t=>t.id===id); },
  updateTask(id,patch){ const t=this.getTask(id); if(t){ Object.assign(t,patch); this.save(); } return t; },
  expiredYesterday(){
    const y=yesterdayStr();
    return this.db.tasks.filter(t=>t.date===y && t.status===STATUS.EXPIRED);
  },
  getTimetable(dateStr){
    /* 假期模式：课表切换到 vacationTimetable；临时覆盖（timetableOverrides）两种模式都生效 */
    const base=(this.db.settings||{}).scheduleMode==="vacation" ? this.db.vacationTimetable : this.db.timetable;
    return this.db.timetableOverrides[dateStr] || (base||{})[weekdayOf(dateStr)] || {subjects:[],notes:""};
  },
  setScheduleMode(mode){
    this.db.settings.scheduleMode = mode==="vacation" ? "vacation" : "daily";
    this.save();
  },

  /* ---------- 标准课表网格（课段 / 节次 × 7 天） ----------
   * grid 是家长编辑用的源数据；timetable[w].subjects 是运行时权威，编辑即派生。 */
  gridDefault(){
    return { updated_at:null, rows: DEFAULT_GRID_ROWS.map((r,i)=>({
      id:"gr_"+(i+1), period:r.period, label:r.label,
      cells:["","","","","","",""], metas:["","","","","","",""]
    })) };
  },
  gridKey(mode){ return mode==="vacation" ? "vacationTimetableGrid" : "timetableGrid"; },
  packKey(mode){ return mode==="vacation" ? "vacationTimetable" : "timetable"; },
  grid(mode){
    const key=this.gridKey(mode||(this.db.settings||{}).scheduleMode);
    return this.db[key] || this.gridDefault();
  },
  gridCellSubject(c){ return String(c==null?"":c).trim(); },
  periodLabel(p){ return PERIOD_LABEL[p]||PERIOD_LABEL.morning; },
  /* 旧的一行式课表 → 网格（无损迁移：科目依次落到第 1..N 节） */
  gridFromPack(pack){
    const g=this.gridDefault();
    for(let w=1;w<=7;w++){
      (((pack||{})[w]||{}).subjects||[]).slice(0,g.rows.length).forEach((s,i)=>{
        g.rows[i].cells[w-1]=this.gridCellSubject(s);
      });
    }
    return g;
  },
  normalizeGrid(g, pack){
    if(!g || !Array.isArray(g.rows) || !g.rows.length) return this.gridFromPack(pack);
    const base=this.gridDefault();
    const rows=g.rows.map((r,i)=>{
      const cells=(Array.isArray(r.cells)?r.cells:[]).slice(0,7);
      const metas=(Array.isArray(r.metas)?r.metas:[]).slice(0,7);
      while(cells.length<7) cells.push("");
      while(metas.length<7) metas.push("");
      return { id:r.id||("gr_"+(i+1)), period:r.period==="afternoon"?"afternoon":"morning",
        label:String(r.label||(base.rows[i]?base.rows[i].label:"第"+(i+1)+"节")),
        cells:cells.map(x=>this.gridCellSubject(x)), metas:metas.map(x=>String(x==null?"":x).trim()) };
    });
    return { updated_at:g.updated_at||null, rows };
  },
  /* 外部（REST / MCP / 另一台设备）直接改了 timetable[w].subjects 时，
   * 若它比网格更新，就把科目反向写回该列（保留老师/教室备注）。 */
  reconcileGridFromPack(){
    const apply=(gKey,pKey)=>{
      const g=this.db[gKey], pack=this.db[pKey];
      if(!g || !Array.isArray(g.rows) || !pack) return;
      const gAt=Date.parse(g.updated_at||0)||0;
      let changed=false;
      for(let w=1;w<=7;w++){
        const t=pack[w]; if(!t) continue;
        const tAt=Date.parse(t.updated_at||0)||0;
        if(!tAt || tAt<=gAt) continue;
        const list=(t.subjects||[]).map(s=>this.gridCellSubject(s)).filter(Boolean);
        while(g.rows.length<list.length){
          g.rows.push({ id:"gr_"+(g.rows.length+1)+"_ext", period:"afternoon", label:"",
            cells:["","","","","","",""], metas:["","","","","","",""] });
        }
        g.rows.forEach((r,i)=>{ if(!Array.isArray(r.cells)) r.cells=["","","","","","",""]; r.cells[w-1]=list[i]||""; });
        changed=true;
      }
      if(changed){ this.renumberGrid(g); g.updated_at=new Date().toISOString(); }
    };
    apply("timetableGrid","timetable");
    apply("vacationTimetableGrid","vacationTimetable");
  },
  /* 某天按节次顺序去重后的科目（书包清单、MCP、语音都用它） */
  gridSubjects(g,w){
    const out=[];
    (g.rows||[]).forEach(r=>{
      const s=this.gridCellSubject((r.cells||[])[w-1]);
      if(s && !out.includes(s)) out.push(s);
    });
    return out;
  },
  /* 孩子端「明天上课顺序」：按课段/节次列出；当天有临时调课时返回 null（调课只有科目没有节次） */
  timetablePeriods(dateStr){
    const d=dateStr||tomorrowStr();
    if((this.db.timetableOverrides||{})[d]) return null;
    const g=this.grid((this.db.settings||{}).scheduleMode), w=weekdayOf(d);
    return (g.rows||[]).map(r=>({
      period:r.period, label:r.label,
      subject:this.gridCellSubject((r.cells||[])[w-1]),
      meta:String((r.metas||[])[w-1]||"")
    })).filter(x=>x.subject);
  },
  renumberGrid(g){
    ["morning","afternoon"].forEach(p=>{
      let n=0;
      g.rows.forEach(r=>{ if(r.period===p){ n++; if(!r.label || /^第\d+节$/.test(r.label)) r.label="第"+n+"节"; } });
    });
  },
  syncGridToPack(mode){
    const m=mode||(this.db.settings||{}).scheduleMode;
    const g=this.grid(m), pack=this.db[this.packKey(m)];
    if(!pack) return;
    for(let w=1;w<=7;w++){
      if(!pack[w]) pack[w]={subjects:[],notes:""};
      pack[w].subjects=this.gridSubjects(g,w);
    }
    g.updated_at=new Date().toISOString();
    this.db[this.gridKey(m)]=g;
    this.db.settings.timetable_updated_at=g.updated_at;
  },
  setGridCell(mode,rowIdx,w,patch){
    const g=this.grid(mode), r=g.rows[rowIdx];
    if(!r || !(w>=1&&w<=7)) return false;
    if(patch.subject!=null) r.cells[w-1]=String(patch.subject).trim();
    if(patch.meta!=null)    r.metas[w-1]=String(patch.meta).trim();
    if(patch.label!=null)   r.label=String(patch.label).trim();
    this.db[this.gridKey(mode)]=g;
    this.syncGridToPack(mode);
    this.save();
    return true;
  },
  addGridRow(mode,period){
    const p=period==="afternoon"?"afternoon":"morning", g=this.grid(mode);
    let last=-1; g.rows.forEach((r,i)=>{ if(r.period===p) last=i; });
    const at=last<0?g.rows.length:last+1;
    g.rows.splice(at,0,{ id:"gr_"+Date.now().toString(36)+Math.random().toString(36).slice(2,5),
      period:p, label:"", cells:["","","","","","",""], metas:["","","","","","",""] });
    this.renumberGrid(g);
    this.db[this.gridKey(mode)]=g; this.syncGridToPack(mode); this.save();
    return at;
  },
  removeGridRow(mode,rowIdx){
    const g=this.grid(mode); if(!g.rows[rowIdx]) return false;
    g.rows.splice(rowIdx,1); this.renumberGrid(g);
    this.db[this.gridKey(mode)]=g; this.syncGridToPack(mode); this.save();
    return true;
  },
  /* 兼容 REST/MCP 的「按星期设置科目」：同时把该列同步回网格，保留老师/教室备注 */
  setWeekdaySubjects(mode,w,subjects,notes){
    const m=mode||(this.db.settings||{}).scheduleMode;
    const pack=this.db[this.packKey(m)]; if(!pack) return;
    if(!pack[w]) pack[w]={subjects:[],notes:""};
    pack[w].subjects=(subjects||[]).map(s=>this.gridCellSubject(s)).filter(Boolean);
    if(notes!=null) pack[w].notes=String(notes);
    const g=this.grid(m), list=pack[w].subjects;
    while(g.rows.length<list.length){
      g.rows.push({ id:"gr_"+(g.rows.length+1)+"_"+Date.now().toString(36), period:"afternoon", label:"",
        cells:["","","","","","",""], metas:["","","","","","",""] });
    }
    g.rows.forEach((r,i)=>{ r.cells[w-1]=list[i]||""; });
    this.renumberGrid(g);
    g.updated_at=new Date().toISOString();
    this.db[this.gridKey(m)]=g;
    this.db.settings.timetable_updated_at=g.updated_at;
    this.save();
  },
  habitRemindTime(h){
    /* 假期模式且习惯单独设了假期时间时用假期时间 */
    if((this.db.settings||{}).scheduleMode==="vacation" && h && h.vacation_remind_time) return h.vacation_remind_time;
    return h ? h.remind_time : null;
  },

  /* ---------- 课表粘贴导入 ----------
   * 学校系统 / Excel 复制出来的课表通常是「每行一节次、每格 科目 老师 教室」。
   * 这里统一解析成网格行，家长确认预览后一次性写入，避免逐格手抄 42 个格子。 */
  parseTimetableText(text){
    const lines=String(text||"").split(/\r?\n/).map(l=>l.trim()).filter(l=>l && !/^[#＃]/.test(l));
    const rows=[], warnings=[];
    const CN={"一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9,"十":10};
    let period="morning", seq={morning:0,afternoon:0};
    const splitCols=(line)=>{
      if(/\t/.test(line))              return line.split(/\t+/).map(s=>s.trim());
      if(/[|｜]/.test(line))           return line.split(/\s*[|｜]\s*/).map(s=>s.trim());
      if(/[,，;；]/.test(line))        return line.split(/\s*[,，;；]\s*/).map(s=>s.trim());
      return line.split(/\s{2,}/).map(s=>s.trim());
    };
    /* 每格：科目名 + 选填的老师 / 教室。空白格用 - 或留空表示 */
    const parseCell=(raw)=>{
      const s=String(raw==null?"":raw).trim();
      if(!s || /^[-—－\/·]+$/.test(s)) return {subject:"",meta:""};
      const parts=(/[\/·／]/.test(s) ? s.split(/\s*[\/·／]\s*/) : s.split(/\s+/)).filter(Boolean);
      const subject=String(parts.shift()||"").trim();
      const meta=parts.join(" / ").slice(0,60);
      return {subject,meta};
    };
    lines.forEach((line,idx)=>{
      /* 表头 / 标题行：含「星期」或「课段/课节」但不像数据 */
      if(/星期[一二三四五六日1-7]/.test(line) && /课段|课节|课程表|节次/.test(line)) return;
      if(/课程表|学年|学期课表|本周课表|下周课表/.test(line) && !/语文|数学|英语|体育|艺术|科学|道德|劳动|书法|阅读|综合|活动/.test(line)) return;
      let cols=splitCols(line);
      /* 行首的课段 / 节次标记不占周一~周日的列 */
      let label="";
      const head=cols[0]||"";
      if(/下午/.test(head)) period="afternoon";
      else if(/上午/.test(head)) period="morning";
      const m=head.match(/(?:第)?\s*([0-9一二三四五六七八九十]+)\s*节?/);
      if(m && /节|^\d|^[一二三四五六七八九十]/.test(head)){
        label="第"+(CN[m[1]]||Number(m[1])||1)+"节";
        cols=cols.slice(1);
      }else if(/^(上午|下午)$/.test(head)){
        cols=cols.slice(1);
      }
      const cells=["","","","","","",""], metas=["","","","","","",""];
      cols.slice(0,7).forEach((c,i)=>{ const p=parseCell(c); cells[i]=p.subject; metas[i]=p.meta; });
      if(cols.length>7) warnings.push(`第 ${idx+1} 行超过 7 列，只取前 7 列`);
      if(!cells.some(Boolean)){ warnings.push(`第 ${idx+1} 行没识别到科目，已跳过`); return; }
      seq[period]++;
      rows.push({id:"gr_imp_"+(idx+1),period,label:label||("第"+seq[period]+"节"),cells,metas});
    });
    if(!rows.length) warnings.push("没有识别到任何一节课程，请检查粘贴格式");
    const subjects=[];
    rows.forEach(r=>r.cells.forEach(c=>{ c=this.gridCellSubject(c); if(c && !subjects.includes(c)) subjects.push(c); }));
    return {rows,warnings,subjects};
  },
  /* 导入预览里给家长的「这一科建议带什么」：已配的直接用，没配的按关键字给建议（家长可改） */
  kitSuggestionFor(subject){
    const got=this.suggestKit(subject);
    if(got.matched) return {matched:true,key:got.key,items:got.items.slice()};
    const s=String(subject||"");
    const RULES=[
      [/美术|画画|绘画/,["水彩笔","图画本"]], [/音乐|口风琴|合唱/,["口风琴","音乐课本"]],
      /* 「活动」「实践」优先按劳动/实践类匹配，避免被「体育」规则抢走 */
      [/劳动|实践|手工|综合/,["手工材料","抹布"]],
      [/书法|写字/,["毛笔","字帖","书法本"]], [/英语|外语|地方/,["英语课本","练习册"]],
      [/体育|运动|健康/,["运动鞋","跳绳","水杯"]], [/数学|拓展|思维/,["数学课本","口算本"]],
      [/阅读|语文|识字|写字/,["语文课本","课外书","生字本"]], [/科学|自然/,["科学课本"]],
      [/道德|法治|品德|道法/,["课本","练习册"]]
    ];
    const hit=RULES.find(([re])=>re.test(s));
    return {matched:false,key:null,items:hit?hit[1].slice():[],proposal:true};
  },
  /* 一次性写入整套网格 + 科目物品；导入的科目若曾被删过会自动恢复 */
  applyImportedGrid(mode,rows,kitPatch){
    const m=mode==="vacation"?"vacation":"daily";
    const g=this.gridDefault();
    g.rows=(rows||[]).map((r,i)=>({
      id:r.id||("gr_imp_"+(i+1)), period:r.period==="afternoon"?"afternoon":"morning",
      label:String(r.label||""),
      cells:(Array.isArray(r.cells)?r.cells:[]).slice(0,7).concat(["","","","","","",""]).slice(0,7).map(x=>this.gridCellSubject(x)),
      metas:(Array.isArray(r.metas)?r.metas:[]).slice(0,7).concat(["","","","","","",""]).slice(0,7).map(x=>String(x==null?"":x).trim())
    }));
    this.renumberGrid(g);
    this.db[this.gridKey(m)]=g;
    this.syncGridToPack(m);          /* 派生 timetable[w].subjects + 打课表变更时间戳 */
    if(kitPatch && Object.keys(kitPatch).length){
      const kit=Object.assign({},this.subjectKitMap());
      Object.keys(kitPatch).forEach(k=>{ const v=kitPatch[k]; if(Array.isArray(v)) kit[k]=v; });
      this.db.settings.subjectKit=kit;
    }
    /* 导入进来的科目不该还留在删除墓碑里，否则书包清单会漏掉它 */
    const appeared=new Set();
    g.rows.forEach(r=>r.cells.forEach(c=>{ if(c) appeared.add(c); }));
    this.db.settings.subjectRemoved=(this.subjectRemoved()||[]).filter(x=>!appeared.has(x));
    this.save();
    return {rows:g.rows.length,subjects:appeared.size};
  },

  /* ---------- A：科目 → 要带的物品，按明日课表自动生成整理书包清单 ---------- */
  subjectKitMap(){ return (this.db.settings||{}).subjectKit||{}; },
  subjectRemoved(){ return (this.db.settings||{}).subjectRemoved||[]; },
  /* 误创的科目要能删干净：从物品清单移除 + 写墓碑（防 migrate 默认项、旧端快照把名字带回来），
   * subjectSuggestions / renderKitCard 都会跳过墓碑里的名字。clearCells=true 时连课表格子一起清空。 */
  subjectCellCount(name){
    const key=this.gridCellSubject(name); if(!key) return 0;
    let n=0;
    ["timetableGrid","vacationTimetableGrid"].forEach(gk=>{
      ((this.db[gk]||{}).rows||[]).forEach(r=>(r.cells||[]).forEach(c=>{ if(this.gridCellSubject(c)===key) n++; }));
    });
    return n;
  },
  removeSubject(name, clearCells){
    const key=this.gridCellSubject(name); if(!key) return {cells:0};
    const s=this.db.settings||(this.db.settings={});
    s.subjectKit=s.subjectKit||{}; delete s.subjectKit[key];
    s.subjectRemoved=Array.from(new Set([...(Array.isArray(s.subjectRemoved)?s.subjectRemoved:[]),key]));
    let cells=0;
    if(clearCells){
      ["timetableGrid","vacationTimetableGrid"].forEach(gk=>{
        const g=this.db[gk]; if(!g||!Array.isArray(g.rows)) return;
        g.rows.forEach(r=>{
          if(!Array.isArray(r.cells)) r.cells=["","","","","","",""];
          if(!Array.isArray(r.metas)) r.metas=["","","","","","",""];
          r.cells.forEach((c,i)=>{ if(this.gridCellSubject(c)===key){ r.cells[i]=""; r.metas[i]=""; cells++; } });
        });
        g.updated_at=new Date().toISOString();
      });
      ["timetable","vacationTimetable"].forEach(pk=>{
        const p=this.db[pk]; if(!p) return;
        Object.values(p).forEach(t=>{ if(t&&Array.isArray(t.subjects)) t.subjects=t.subjects.filter(x=>this.gridCellSubject(x)!==key); });
      });
      s.timetable_updated_at=new Date().toISOString();
    }
    this.save();
    return {cells};
  },
  restoreSubject(name){
    const key=this.gridCellSubject(name); if(!key) return;
    const s=this.db.settings||(this.db.settings={});
    s.subjectRemoved=(Array.isArray(s.subjectRemoved)?s.subjectRemoved:[]).filter(x=>x!==key);
    s.subjectKit=s.subjectKit||{};
    if(!(key in s.subjectKit)) s.subjectKit[key]=[];
    this.save();
  },
  kitEnabled(){
    return (this.db.settings||{}).kitEnabled!==false && Object.keys(this.subjectKitMap()).length>0;
  },
  /* 科目名 → 已配置物品的科目键。学校课表常写全称（体育与健康 / 艺术(美术) / 数学拓展），
   * 双向包含匹配让家长照抄课表也能对上清单，不用迁就系统里的短名。 */
  kitKeyFor(subject){
    const v=String(subject==null?"":subject).trim(); if(!v) return null;
    if(this.subjectRemoved().includes(v)) return null;
    const kit=this.subjectKitMap(), keys=Object.keys(kit);
    if(kit[v]) return v;
    return keys.find(k=>v.includes(k)) || keys.find(k=>k.includes(v)) || null;
  },
  suggestKit(subject){
    const key=this.kitKeyFor(subject);
    if(!key) return { matched:false, key:null, items:[] };
    return { matched:true, key, items:(this.subjectKitMap()[key]||[]).slice() };
  },
  /* 填课表时给家长的标准科目候选：已配物品的优先，再补小学常见全称。
   * 被家长删掉的科目（墓碑）不再出现在建议里，避免误创的名字永远清不掉。 */
  subjectSuggestions(){
    const removed=this.subjectRemoved();
    const out=[], add=x=>{ x=String(x==null?"":x).trim(); if(x && !removed.includes(x) && !out.includes(x)) out.push(x); };
    Object.keys(this.subjectKitMap()).forEach(add);
    COMMON_SUBJECTS.forEach(add);
    [this.db.timetableGrid,this.db.vacationTimetableGrid].forEach(g=>
      ((g||{}).rows||[]).forEach(r=>(r.cells||[]).forEach(add)));
    Object.values(this.db.timetable||{}).forEach(t=>((t||{}).subjects||[]).forEach(add));
    Object.values(this.db.vacationTimetable||{}).forEach(t=>((t||{}).subjects||[]).forEach(add));
    return out;
  },
  kitForSubjects(subjects){
    const out=[];
    const add=x=>{ x=String(x==null?"":x).trim(); if(x && !out.includes(x)) out.push(x); };
    (subjects||[]).forEach(s=>{
      const key=this.kitKeyFor(s);
      (key?(this.subjectKitMap()[key]||[]):[]).forEach(add);  /* 未配置的科目不猜，静默跳过 */
    });
    return out;
  },
  /* 完整清单 = 按明日课表实时映射的物品 +（可选）习惯里手写的固定检查项。
   * 课表一改，下次渲染立即重算；孩子端勾选按「物品名」保存，所以已勾项不会因清单变化而错位。 */
  bagChecklist(h, dateStr){
    const tm=this.getTimetable(dateStr||tomorrowStr());
    const out=[];
    const add=x=>{ x=String(x==null?"":x).trim(); if(x && !out.includes(x)) out.push(x); };
    const auto=this.kitEnabled()?this.kitForSubjects(tm.subjects||[]):[];
    auto.forEach(add);
    if(this.db.settings.kitMergeManual!==false || !auto.length) ((h&&h.checklist)||[]).forEach(add);
    return out;
  },

  /* ---------- D：习惯时段（默认按提醒时间推导，家长可手动指定） ---------- */
  habitSlot(h){
    if(!h) return "after";
    if(h.time_slot && h.time_slot!=="auto" && SLOT_LABEL[h.time_slot]) return h.time_slot;
    const rt=this.habitRemindTime(h)||"20:00";
    const hh=parseInt(String(rt).split(":")[0],10);
    if(isNaN(hh)) return "after";
    return hh<11?"morning":hh<18?"after":"night";
  },
  slotLabel(key){ return SLOT_LABEL[key]||SLOT_LABEL.after; },

  /* ---------- 录音：上传服务端，失败保留本地 dataURL ---------- */
  getRecordings(taskId){ return this.db.recordings[taskId]||[]; },
  async addRecording(taskId, {dataUrl, duration, mime}){
    let url=dataUrl, pending=false;
    if(this.remote && !this.needAuth){
      try{
        const r=await fetch(API_BASE+"/recordings",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({taskId,dataUrl,duration,mime})}).then(x=>x.json());
        if(r && r.url) url=r.url;
      }catch(e){ pending=true; /* 离线：进待传队列，不把 base64 塞进同步状态 */ }
    }else if(this.remote){ pending=true; }
    if(!this.db.recordings[taskId]) this.db.recordings[taskId]=[];
    const rec={id:uid(),url,duration:Math.round(duration||0),rejected:false,created_at:new Date().toISOString()};
    this.db.recordings[taskId].push(rec);
    if(pending) this._queuePending({kind:"recording", id:rec.id, taskId, dataUrl, duration:Math.round(duration||0), mime});
    this.save(); return rec;
  },
  deleteRecording(taskId,recId){
    this.db.recordings[taskId]=(this.db.recordings[taskId]||[]).filter(r=>r.id!==recId); this.save();
  },

  /* ---------- 语音鼓励（家长给孩子录的话，不评分，只连接） ---------- */
  getEncouragements(){ return (this.db.encouragements||[]).slice().sort((a,b)=>(b.created_at||"").localeCompare(a.created_at||"")); },
  async addEncouragement({task_id, dataUrl, duration, created_by, text}){
    let url=dataUrl, pending=false;
    if(this.remote && !this.needAuth){
      try{
        const r=await fetch(API_BASE+"/recordings",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({taskId:"enc",dataUrl,duration,mime:"audio/webm"})}).then(x=>x.json());
        if(r && r.url) url=r.url;
      }catch(e){ pending=true; /* 离线：进待传队列 */ }
    }else if(this.remote){ pending=true; }
    const rec={id:uid(), task_id:task_id||null, date:todayStr(), url, duration:Math.round(duration||0),
      created_by:created_by||"家长", created_at:new Date().toISOString(), played_at:null,
      text:(text||"").slice(0,140), updated_at:new Date().toISOString()};
    (this.db.encouragements=this.db.encouragements||[]).push(rec);
    if(pending) this._queuePending({kind:"enc", id:rec.id, taskId:"enc", dataUrl, duration:Math.round(duration||0), mime:"audio/webm"});
    this.save(); return rec;
  },
  markEncouragementPlayed(id){
    const e=(this.db.encouragements||[]).find(x=>x.id===id);
    if(e && !e.played_at){ e.played_at=new Date().toISOString(); e.updated_at=e.played_at; this.save(); }
  },
  deleteEncouragement(id){
    /* 写墓碑，防止其他设备把已删鼓励同步回来 */
    this.remove("encouragements", id);
  },
  unplayedEncouragements(){ return this.getEncouragements().filter(e=>!e.played_at); },

  /* ---------- 奖励商城（家长定义奖品，孩子申请兑换，家长确认扣星） ---------- */
  getRewards(){ return (this.db.rewards||[]).filter(r=>!r._removed); },
  saveReward({id, name, icon, cost, desc, active}){
    cost=Math.max(1,Math.round(cost||1));
    const now=new Date().toISOString();
    let r=id?(this.db.rewards||[]).find(x=>x.id===id):null;
    if(r){ Object.assign(r,{name:(name||r.name).slice(0,30),icon:icon||r.icon,cost,desc:(desc||"").slice(0,80),
      active:active!==false,updated_at:now}); }
    else{
      r={id:uid(), name:(name||"神秘奖励").slice(0,30), icon:icon||"🎁", cost, desc:(desc||"").slice(0,80),
        active:active!==false, created_at:now, updated_at:now};
      (this.db.rewards=this.db.rewards||[]).push(r);
    }
    this.save(); return r;
  },
  removeReward(id){ this.remove("rewards", id); },   // 墓碑，防复活

  getRedemptions(){ return (this.db.redemptions||[]).slice().sort((a,b)=>(b.requested_at||"").localeCompare(a.requested_at||"")); },
  pendingRedemptions(){ return this.getRedemptions().filter(r=>r.status==="pending"); },
  requestRedemption(rewardId){
    const r=this.getRewards().find(x=>x.id===rewardId);
    if(!r || r.active===false) return {ok:false,error:"reward_gone",message:"这个奖励不存在或已下架"};
    if(this.db.points.total < r.cost) return {ok:false,error:"not_enough",message:"星星还不够哦",need:r.cost-this.db.points.total};
    const rec={ id:uid(), reward_id:r.id, reward_name:r.name, reward_icon:r.icon, cost:r.cost,
      status:"pending", requested_at:new Date().toISOString(), updated_at:new Date().toISOString(),
      decided_at:null, decided_by:null, note:"" };
    (this.db.redemptions=this.db.redemptions||[]).push(rec);
    this.save(); return {ok:true, rec};
  },
  /* 仅家长调用（孩子端伪造的"已兑现"会在服务端合并层被拒） */
  decideRedemption(id, fulfilled, note){
    const e=(this.db.redemptions||[]).find(x=>x.id===id);
    if(!e || e.status!=="pending") return false;
    e.status=fulfilled?"fulfilled":"denied";
    e.decided_at=new Date().toISOString(); e.decided_by="家长";
    e.note=(note||"").slice(0,80); e.updated_at=e.decided_at;
    if(fulfilled) this.spendPoints(e.cost, e.id);
    else this.save();
    return true;
  },

  /* ---------- 错题本（退回任务/口算错题入本，周末重练，做对两次归档） ---------- */
  getMistakes(){ return (this.db.mistakes||[]).filter(m=>!m.archived).sort((a,b)=>(b.created_at||"").localeCompare(a.created_at||"")); },
  getArchivedMistakes(){ return (this.db.mistakes||[]).filter(m=>m.archived).sort((a,b)=>(b.updated_at||"").localeCompare(a.updated_at||"")); },
  addMistake({title, subject, reason, source_task_id}){
    const m={ id:uid(), title:(title||"").slice(0,60), subject:subject||"其他", reason:(reason||"").slice(0,80),
      source_task_id:source_task_id||null, mastered_count:0, archived:false,
      created_at:new Date().toISOString(), updated_at:new Date().toISOString() };
    /* 同题去重：未归档的错题里已有同标题则只更新时间 */
    const dup=(this.db.mistakes||[]).find(x=>!x.archived && x.title===m.title);
    if(dup){ dup.updated_at=m.created_at; this.save(); return dup; }
    (this.db.mistakes=this.db.mistakes||[]).push(m);
    this.save(); return m;
  },
  removeMistake(id){ this.remove("mistakes", id); },
  /* 生成错题重练任务（默认周末）：同一天同一错题不重复生成 */
  generateDrill(date, mistakeIds){
    date=date||todayStr();
    let added=0;
    (mistakeIds||[]).forEach(mid=>{
      const m=(this.db.mistakes||[]).find(x=>x.id===mid);
      if(!m || m.archived) return;
      if((this.db.tasks||[]).some(t=>t.mistake_id===mid && t.date===date)) return;
      this.db.tasks.push({ id:uid(), date, title:`订正：${m.title}`, subject:m.subject, category:"学业", type:"订正",
        source:"错题重练", mistake_id:m.id, note:m.reason||"", estimated_minutes:null,
        timer_mode:"stopwatch", limit_minutes:null, overtime_remind:null, allow_continue:true,
        need_recording:false, period_rule_id:null, status:STATUS.TODO, actual_seconds:null,
        completed_at:null, reviewed_by:null, reviewed_at:null, star_awarded:0, star_value:1,
        parent_note:"", updated_at:new Date().toISOString() });
      added++;
    });
    if(added) this.save();
    return added;
  },
  /* 孩子自己的存星目标（愿望单）：孩子端可改，家长端只读 */
  setGoal(name, target){
    target=Math.max(1,Math.round(target||1));
    this.db.settings.goals={ name:(name||"我的愿望").slice(0,30), target, updated_at:new Date().toISOString() };
    this.save();
  },
  clearGoal(){ this.db.settings.goals=null; this.save(); },

  /* ---------- 照片：走文件存储，state 里只留 URL ---------- */
  getPhoto(taskId){ return (this.db.photos||{})[taskId]||null; },
  async addPhoto(taskId, {dataUrl, mime}){
    let url=null;
    if(this.remote && !this.needAuth){
      try{
        const r=await fetch(API_BASE+"/photos",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({taskId,dataUrl,mime})}).then(x=>x.json());
        if(r && r.url) url=r.url;
      }catch(e){ /* 降级：本地暂存 dataURL */ }
    }
    this.db.photos=this.db.photos||{};
    this.db.photos[taskId]=url||dataUrl;
    this.save();
    return this.db.photos[taskId];
  },

  /* ---------- 星星（total=可用余额，earned_total=累计获得，徽章用累计口径） ---------- */
  awardStar(taskId, reason){
    const t=this.getTask(taskId);
    const delta=Math.max(1, t && t.star_value!=null ? t.star_value : 1);
    this.db.points.total += delta;
    this.db.points.earned_total=(this.db.points.earned_total||0)+delta;
    this.db.points.log.push({id:uid(), task_id:taskId, delta, reason:reason||"complete", created_at:new Date().toISOString()});
    if(t) t.star_awarded=(t.star_awarded||0)+delta;
    this.save(); return delta;
  },
  /* 兑换消费：只扣余额，不动累计（家长确认时调用） */
  spendPoints(cost, refId){
    cost=Math.max(0,Math.round(cost||0));
    this.db.points.total=Math.max(0,this.db.points.total-cost);
    this.db.points.log.push({id:uid(), task_id:null, redemption_id:refId||null, delta:-cost,
      reason:"redeem", created_at:new Date().toISOString()});
    this.save();
  },
  revokeStar(taskId, reason){
    const t=this.getTask(taskId);
    if(t && t.star_awarded>0){
      this.db.points.total=Math.max(0,this.db.points.total-t.star_awarded);
      this.db.points.log.push({id:uid(),task_id:taskId,delta:-t.star_awarded,reason:reason||"revoke_reject",created_at:new Date().toISOString()});
      t.star_awarded=0; this.save();
    }
  },

  /* ---------- 扣分（做错事时）：原因必填，写进积分流水，孩子端可见 ---------- */
  addPenalty(amount, reason, by){
    const n=Math.floor(Number(amount)||0);
    const why=String(reason==null?"":reason).trim();
    if(!why) return {ok:false,error:"reason_required",message:"请填写扣分原因，孩子端会看到"};
    if(n<1 || n>50) return {ok:false,error:"bad_amount",message:"扣分数量需在 1~50 之间"};
    const avail=Math.max(0,Math.floor(Number(this.db.points.total)||0));
    const actual=Math.min(n,avail);   /* 余额不足时扣到 0，仍保留原因记录 */
    /* 同一毫秒连续记两条时把时间往后推 1ms，保证孩子端「最新一条」顺序稳定 */
    const newest=[...(this.db.points.log||[])].filter(x=>x&&(x.kind==="penalty"||x.reason==="penalty"))
      .map(x=>x.created_at||"").sort().pop();
    let at=new Date();
    if(newest && at.toISOString()<=newest) at=new Date(Date.parse(newest)+1);
    const e={
      id:uid(), task_id:null, delta:-actual, kind:"penalty", reason:"penalty",
      note:why.slice(0,200), by:String(by||"家长").slice(0,20),
      date:todayStr(), created_at:at.toISOString(), seen_at:null
    };
    this.db.points.total=Math.max(0,avail-actual);
    this.db.points.log.push(e);
    this.save();
    return {ok:true,entry:e,amount:actual,requested:n};
  },
  penalties(){
    return (this.db.points.log||[]).filter(e=>e&&(e.kind==="penalty"||e.reason==="penalty"))
      .slice().sort((a,b)=>String(b.created_at||"").localeCompare(String(a.created_at||"")));
  },
  unreadPenalties(){ return this.penalties().filter(e=>!e.seen_at); },
  markPenaltySeen(id){
    const e=(this.db.points.log||[]).find(x=>x&&x.id===id);
    if(!e || e.seen_at) return false;
    e.seen_at=new Date().toISOString(); this.save(); return true;
  },
  markAllPenaltiesSeen(){
    const list=this.unreadPenalties();
    if(!list.length) return 0;
    list.forEach(e=>{ e.seen_at=new Date().toISOString(); });
    this.save(); return list.length;
  },

  /* ---------- 完成 / 撤销 / 退回 ---------- */
  completeTask(id, seconds){
    const t=this.getTask(id); if(!t) return 0;
    t.status=STATUS.DONE; t.actual_seconds=Math.floor(seconds||0);
    t.completed_at=new Date().toISOString();
    const delta=this.awardStar(id,"complete");
    /* 错题重练：完成一次记一次掌握，两次即归档 */
    if(t.mistake_id){
      const m=(this.db.mistakes||[]).find(x=>x.id===t.mistake_id);
      if(m && !m.archived){
        m.mastered_count=(m.mastered_count||0)+1;
        if(m.mastered_count>=2) m.archived=true;
        m.updated_at=new Date().toISOString();
      }
    }
    this.updateStreak(); this.save(); return delta;
  },
  undoComplete(id){
    const t=this.getTask(id); if(!t || t.status!==STATUS.DONE) return false;
    if(Date.now()-new Date(t.completed_at).getTime()>5000) return false;
    t.status=STATUS.DOING; t.completed_at=null;
    this.revokeStar(id,"undo"); this.updateStreak(); this.save(); return true;
  },
  rejectTask(id, reason, reviewer){
    const t=this.getTask(id); if(!t) return;
    this.revokeStar(id,"revoke_reject");
    (this.db.recordings[id]||[]).forEach(r=>r.rejected=true);
    t.status=STATUS.REJECTED; t.reviewed_by=reviewer||"家长"; t.reviewed_at=new Date().toISOString();
    t.parent_note=reason||""; t.completed_at=null;
    this.updateStreak(); this.save();
  },
  restartTask(id){ const t=this.getTask(id); if(t){ t.status=STATUS.TODO; this.save(); } },

  /* ---------- 亲子任务（D-3）：孩子勾选即完成即得星（冻结规则不变），家长确认仅为共同完成记录 ---------- */
  confirmCoParent(id, who){
    const t=this.getTask(id); if(!t || !t.co_parent || t.co_done_at) return false;
    t.co_done_at=new Date().toISOString(); t.co_done_by=who||"家长";
    this.save(); return true;
  },
  coStats(weekDates){
    const list=(this.db.tasks||[]).filter(t=>t.co_parent && (!weekDates || weekDates.includes(t.date)));
    return { total:list.length, done:list.filter(t=>t.status===STATUS.DONE && t.co_done_at).length };
  },

  /* ---------- 连续天数 ---------- */
  updateStreak(){
    const tasks=this.getTodayTasks(), today=todayStr();
    const allDone=tasks.length>0 && tasks.every(t=>t.status===STATUS.DONE);
    if(allDone && this.db.streak.lastDate!==today){
      const y=new Date(); y.setDate(y.getDate()-1);
      this.db.streak.days=(this.db.streak.lastDate===fmtDate(y))?this.db.streak.days+1:1;
      this.db.streak.lastDate=today;
    }else if(!allDone && this.db.streak.lastDate===today){
      this.db.streak.lastDate=null; this.db.streak.days=Math.max(0,this.db.streak.days-1);
    }
    this.save();
  },

  /* ---------- 徽章（带进度，用累计获得——消费星星不会掉级） ---------- */
  badges(){
    const total=this.db.points.total, streak=this.db.streak.days;
    const earned=(this.db.points.earned_total!=null?this.db.points.earned_total:total);
    const defs=[
      {icon:"🌟",name:"星星新手",metric:earned,target:5,unit:"⭐"},
      {icon:"⭐",name:"星星达人",metric:earned,target:20,unit:"⭐"},
      {icon:"💫",name:"星星大师",metric:earned,target:50,unit:"⭐"},
      {icon:"🔥",name:"坚持 3 天",metric:streak,target:3,unit:"天"},
      {icon:"🏅",name:"坚持 7 天",metric:streak,target:7,unit:"天"},
      {icon:"👑",name:"习惯小标兵",metric:streak,target:14,unit:"天"}
    ];
    return defs.map(b=>({...b, got:b.metric>=b.target,
      pct:Math.min(100,Math.round(b.metric/b.target*100)),
      desc:`${b.metric>=b.target?"已达成":`再 ${b.target-b.metric} ${b.unit}解锁`} · 目标 ${b.target} ${b.unit}`}));
  },

  /* ---------- 导出 / 导入 ---------- */
  exportJSON(){
    const blob=new Blob([JSON.stringify(this.db,null,2)],{type:"application/json"});
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob); a.download=`作业工作台备份_${todayStr()}.json`; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  },
  async importJSON(file){
    const data=JSON.parse(await file.text());
    if(!data || !Array.isArray(data.tasks)) throw new Error("文件格式不正确");
    this.db=data; this.migrate(); this.generateToday(); this.save();
  }
};
