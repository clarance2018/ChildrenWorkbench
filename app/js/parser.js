/* ========== 文本导入解析器（C 方案：自动生成待确认任务 + 不确定段落人工处理） ========== */
const TYPE_MAP = {
  "说一说":{type:"口述", need_recording:true},
  "背一背":{type:"背诵", need_recording:true},
  "读一读":{type:"朗读", need_recording:true},
  "写一写":{type:"书写", need_recording:false},
  "算一算":{type:"计算", need_recording:false},
  "练一练":{type:"练习", need_recording:false},
  "做一做":{type:"练习", need_recording:false},
  "听一听":{type:"听力", need_recording:false}
};
const SUBJECTS = ["语文","数学","英语","音乐","体育","美术","科学","品德"];
const SUBJECT_HINTS = {
  "数学":["加减法","算式","口算","计算","分与合","乘法","除法","应用题","竖式","口诀"],
  "语文":["课文","古诗","拼音","生字","词语","默写","看图写话","日记"],
  "英语":["单词","字母","听力","英文","对话"]
};
const NOTE_HEADERS = ["学习内容","学习重点","教学目标","今日内容"];
const TASK_SECTION_HEADERS = ["今日巩固","今日作业","作业","今日练习","课后巩固"];

function detectSubject(text){
  for(const s of SUBJECTS){ if(text.includes(s)) return s; }
  for(const s in SUBJECT_HINTS){ if(SUBJECT_HINTS[s].some(k=>text.includes(k))) return s; }
  return "其他";
}
/* 任务标题派生：优先取首行说明中含动词的分句，与关键词去重拼接 */
function deriveTitle(kw, line){
  if(!line) return kw+"任务";
  const clauses = line.replace(/^请/,"").split(/[。；;，,]/).map(s=>s.trim()).filter(Boolean);
  const v = clauses.find(c=>/说|背|读|写|算|练|做|讲|完成/.test(c)) || clauses[0];
  if(!v) return kw+"任务";
  let title;
  if(v[0]===kw[0]){
    if(/^(说出|读出|背出|写出)/.test(v)) title = kw + v.slice(2);
    else title = v;
  } else title = kw + v;
  if(title.length>24) title=title.slice(0,24)+"…";
  return title;
}
function detectMinutes(text){
  const m = text.match(/(\d+)\s*分钟/);
  return m ? parseInt(m[1],10) : null;
}
function extractPage(text){
  const m = text.match(/[（(]\s*[PpＰp]\s*(\d+)\s*[)）]/);
  return m ? ("P"+m[1]) : null;
}
function cleanTitle(s){
  return s.replace(/^[。:：\s]+/,"").replace(/\s+/g," ").trim();
}

/**
 * 解析老师原文
 * 返回 { note, tasks:[], uncertain:[] }
 *  - note: 学习内容/学习重点 → 当天备注（不生成任务）
 *  - tasks: 待确认任务卡（needConfirm=true 表示弱信息需家长修改）
 *  - uncertain: 不确定段落 [{text}]，家长可 转为任务/合并/忽略
 */
function parseHomeworkText(raw){
  const lines = raw.split(/\r?\n/);
  const noteParts = [];
  const tasks = [];
  const uncertain = [];
  let section = null;        // note | task | null
  let current = null;        // 当前任务卡（用于吸收多行说明）

  const pushCurrent = ()=>{ if(current){ tasks.push(current); current=null; } };

  for(let rawLine of lines){
    const line = rawLine.trim();
    if(!line) continue;

    // ---- 段落头识别 ----
    const headMatch = line.match(/^(.{2,6})[：:]\s*(.*)$/);
    if(headMatch && NOTE_HEADERS.includes(headMatch[1])){
      section = "note"; pushCurrent();
      if(headMatch[2]) noteParts.push(headMatch[2]);
      continue;
    }
    if(headMatch && TASK_SECTION_HEADERS.includes(headMatch[1])){
      section = "task"; pushCurrent();
      if(headMatch[2]) noteParts.push(headMatch[2]); // 头部同行残余仍按备注保守处理
      continue;
    }

    // ---- 编号 + 【关键词】 → 任务卡 ----
    const taskMatch = line.match(/^(\d+)[.、．]\s*【(.+?)】\s*(.*)$/);
    if(taskMatch){
      pushCurrent();
      const kw = taskMatch[2];
      const conf = TYPE_MAP[kw] || {type:kw, need_recording:/说|背|读|讲/.test(kw)};
      let rest = cleanTitle(taskMatch[3]);
      const page = extractPage(rest);
      const minutes = detectMinutes(rest);
      let title = rest.split(/[。；;\n]/)[0] || kw;
      // 标题过长截断
      if(title.length>24) title = title.slice(0,24)+"…";
      current = {
        _key: uid(),
        _kw: kw,
        _restEmpty: !rest,
        title: rest ? title : kw+"（待补充）",
        subject: detectSubject(line + (section==="task"?"":"")),
        type: conf.type,
        need_recording: conf.need_recording,
        estimated_minutes: minutes,
        note: rest,
        page: page,
        needConfirm: false,
        timer_mode:"stopwatch", limit_minutes:null,
        overtime_remind:5, allow_continue:true
      };
      section = "task";
      continue;
    }

    // ---- 编号但无关键词（弱信息，如"2.如上"） ----
    const weakMatch = line.match(/^(\d+)[.、．]\s*(.*)$/);
    if(weakMatch && section==="task"){
      pushCurrent();
      const rest = cleanTitle(weakMatch[2]);
      if(rest.length <= 6 || /^如上|^同上|^略$/.test(rest)){
        // 按需求样例：生成任务卡但标记需确认
        tasks.push({
          _key: uid(), title: (rest||"如上")+"（请修改）", subject: detectSubject(raw),
          type:"口述", need_recording:true, estimated_minutes:null,
          note: rest, needConfirm:true,
          timer_mode:"stopwatch", limit_minutes:null, overtime_remind:5, allow_continue:true
        });
      }else{
        // 进入不确定段落区，由家长 转为任务/合并/忽略
        uncertain.push({ _key: uid(), text: line });
      }
      continue;
    }

    // ---- 备注段内容 ----
    if(section==="note"){ noteParts.push(line); continue; }

    // ---- 任务段的多行说明：吸收进当前任务 ----
    if(section==="task" && current){
      // emoji 示例行、解释行并入说明；同时尝试补时长/页码
      if(!current.estimated_minutes){ const m=detectMinutes(line); if(m) current.estimated_minutes=m; }
      if(!current.page){ const p=extractPage(line); if(p) current.page=p; }
      // 【关键词】后无内容时，用首行说明派生标题
      if(current._restEmpty){ current.title = deriveTitle(current._kw, line); current._restEmpty = false; }
      current.note += (current.note?"\n":"") + line;
      continue;
    }

    // ---- 兜底：无法判断 ----
    uncertain.push({ _key: uid(), text: line });
  }
  pushCurrent();

  // 科目兜底：以任务标题+说明整体推断，仍识别不出再参考全文
  const globalSubject = detectSubject(raw);
  tasks.forEach(t=>{
    t.subject = detectSubject((t.title||"")+"\n"+(t.note||""));
    if(t.subject==="其他") t.subject = globalSubject;
    // 页码并入说明
    if(t.page && !(t.note||"").includes(t.page)) t.note = (t.note? t.note+"\n":"") + "（"+t.page+"）";
  });

  return { note: noteParts.join("\n"), tasks, uncertain };
}

/** 发布校验：返回错误数组（空=通过） */
function validatePublish(tasks){
  const errs = [];
  tasks.forEach((t,i)=>{
    const n = i+1;
    if(!t.title || !t.title.trim()) errs.push(`第 ${n} 个任务：标题不能为空`);
    if(t.timer_mode==="countdown" && (!t.limit_minutes || t.limit_minutes<=0))
      errs.push(`「${t.title||n}」：倒计时模式必须填写限时分钟`);
    if(t._freq==="weekly" && !(t._weekdays&&t._weekdays.length))
      errs.push(`「${t.title||n}」：每周几至少选择一天`);
  });
  return errs;
}
