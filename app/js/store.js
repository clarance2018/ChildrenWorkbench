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
                 eyeCare:true, scheduleMode:"daily", goals:null },
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
      encouragement:true,eyeCare:true,scheduleMode:"daily",goals:null}, d.settings||{});
    d.child=d.child||{id:"child_1",name:"小宝"};
    d.templates=d.templates||[]; d.notes=d.notes||{}; d.recordings=d.recordings||{}; d.photos=d.photos||{};
    d.encouragements=d.encouragements||[];
    d.periodRules=d.periodRules||[]; d.tasks=d.tasks||[];
    d.habits=d.habits||[];
    d.timetable=d.timetable||{1:{subjects:[],notes:""},2:{subjects:[],notes:""},3:{subjects:[],notes:""},
      4:{subjects:[],notes:""},5:{subjects:[],notes:""},6:{subjects:[],notes:""},7:{subjects:[],notes:""}};
    d.timetableOverrides=d.timetableOverrides||{};
    d.points=d.points||{total:0,log:[]}; d.streak=d.streak||{days:0,lastDate:null};
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
  habitRemindTime(h){
    /* 假期模式且习惯单独设了假期时间时用假期时间 */
    if((this.db.settings||{}).scheduleMode==="vacation" && h && h.vacation_remind_time) return h.vacation_remind_time;
    return h ? h.remind_time : null;
  },

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
