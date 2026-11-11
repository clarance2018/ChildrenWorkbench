/* 老师原文解析器（服务端版，与 app/js/parser.js 规则保持一致）
 * 用于 MCP 工具 import_homework_text：粘贴原文 → 当天备注 + 任务草稿 + 不确定段落
 */
let seq = 0;
const uid = () => "p_" + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 5);

const TYPE_MAP = {
  "说一说": { type: "口述", need_recording: true },
  "背一背": { type: "背诵", need_recording: true },
  "读一读": { type: "朗读", need_recording: true },
  "写一写": { type: "书写", need_recording: false },
  "算一算": { type: "计算", need_recording: false },
  "练一练": { type: "练习", need_recording: false },
  "做一做": { type: "练习", need_recording: false },
  "听一听": { type: "听力", need_recording: false }
};
const SUBJECTS = ["语文", "数学", "英语", "音乐", "体育", "美术", "科学", "品德"];
const SUBJECT_HINTS = {
  "数学": ["加减法", "算式", "口算", "计算", "分与合", "乘法", "除法", "应用题", "竖式", "口诀"],
  "语文": ["课文", "古诗", "拼音", "生字", "词语", "默写", "看图写话", "日记"],
  "英语": ["单词", "字母", "听力", "英文", "对话"]
};
const NOTE_HEADERS = ["学习内容", "学习重点", "教学目标", "今日内容"];
const TASK_SECTION_HEADERS = ["今日巩固", "今日作业", "作业", "今日练习", "课后巩固"];

function detectSubject(text) {
  for (const s of SUBJECTS) { if (text.includes(s)) return s; }
  for (const s in SUBJECT_HINTS) { if (SUBJECT_HINTS[s].some(k => text.includes(k))) return s; }
  return "其他";
}
function deriveTitle(kw, line) {
  if (!line) return kw + "任务";
  const clauses = line.replace(/^请/, "").split(/[。；;，,]/).map(s => s.trim()).filter(Boolean);
  const v = clauses.find(c => /说|背|读|写|算|练|做|讲|完成/.test(c)) || clauses[0];
  if (!v) return kw + "任务";
  let title;
  if (v[0] === kw[0]) {
    if (/^(说出|读出|背出|写出)/.test(v)) title = kw + v.slice(2);
    else title = v;
  } else title = kw + v;
  if (title.length > 24) title = title.slice(0, 24) + "…";
  return title;
}
function detectMinutes(text) {
  const m = text.match(/(\d+)\s*分钟/);
  return m ? parseInt(m[1], 10) : null;
}
function extractPage(text) {
  const m = text.match(/[（(]\s*[PpＰp]\s*(\d+)\s*[)）]/);
  return m ? ("P" + m[1]) : null;
}
function cleanTitle(s) { return s.replace(/^[。:：\s]+/, "").replace(/\s+/g, " ").trim(); }

function parseHomeworkText(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const noteParts = [];
  const tasks = [];
  const uncertain = [];
  let section = null;
  let current = null;
  const pushCurrent = () => { if (current) { tasks.push(current); current = null; } };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const headMatch = line.match(/^(.{2,6})[：:]\s*(.*)$/);
    if (headMatch && NOTE_HEADERS.includes(headMatch[1])) {
      section = "note"; pushCurrent();
      if (headMatch[2]) noteParts.push(headMatch[2]);
      continue;
    }
    if (headMatch && TASK_SECTION_HEADERS.includes(headMatch[1])) {
      section = "task"; pushCurrent();
      if (headMatch[2]) noteParts.push(headMatch[2]);
      continue;
    }

    const taskMatch = line.match(/^(\d+)[.、．]\s*【(.+?)】\s*(.*)$/);
    if (taskMatch) {
      pushCurrent();
      const kw = taskMatch[2];
      const conf = TYPE_MAP[kw] || { type: kw, need_recording: /说|背|读|讲/.test(kw) };
      const rest = cleanTitle(taskMatch[3]);
      const page = extractPage(rest);
      const minutes = detectMinutes(rest);
      let title = rest.split(/[。；;\n]/)[0] || kw;
      if (title.length > 24) title = title.slice(0, 24) + "…";
      current = {
        _key: uid(), _kw: kw, _restEmpty: !rest,
        title: rest ? title : kw + "（待补充）",
        subject: detectSubject(line),
        type: conf.type, need_recording: conf.need_recording,
        estimated_minutes: minutes, note: rest, page,
        needConfirm: false, timer_mode: "stopwatch", limit_minutes: null,
        overtime_remind: 5, allow_continue: true
      };
      section = "task";
      continue;
    }

    const weakMatch = line.match(/^(\d+)[.、．]\s*(.*)$/);
    if (weakMatch && section === "task") {
      pushCurrent();
      const rest = cleanTitle(weakMatch[2]);
      if (rest.length <= 6 || /^如上|^同上|^略$/.test(rest)) {
        tasks.push({
          _key: uid(), title: (rest || "如上") + "（请修改）", subject: detectSubject(raw),
          type: "口述", need_recording: true, estimated_minutes: null,
          note: rest, needConfirm: true,
          timer_mode: "stopwatch", limit_minutes: null, overtime_remind: 5, allow_continue: true
        });
      } else {
        uncertain.push({ _key: uid(), text: line });
      }
      continue;
    }

    if (section === "note") { noteParts.push(line); continue; }

    if (section === "task" && current) {
      if (!current.estimated_minutes) { const m = detectMinutes(line); if (m) current.estimated_minutes = m; }
      if (!current.page) { const p = extractPage(line); if (p) current.page = p; }
      if (current._restEmpty) { current.title = deriveTitle(current._kw, line); current._restEmpty = false; }
      current.note += (current.note ? "\n" : "") + line;
      continue;
    }

    uncertain.push({ _key: uid(), text: line });
  }
  pushCurrent();

  const globalSubject = detectSubject(raw);
  tasks.forEach(t => {
    t.subject = detectSubject((t.title || "") + "\n" + (t.note || ""));
    if (t.subject === "其他") t.subject = globalSubject;
    if (t.page && !(t.note || "").includes(t.page)) t.note = (t.note ? t.note + "\n" : "") + "（" + t.page + "）";
  });

  return { note: noteParts.join("\n"), tasks, uncertain };
}

function validatePublish(tasks) {
  const errs = [];
  (tasks || []).forEach((t, i) => {
    const n = i + 1;
    if (!t.title || !t.title.trim()) errs.push(`第 ${n} 个任务：标题不能为空`);
    if (t.timer_mode === "countdown" && (!t.limit_minutes || t.limit_minutes <= 0))
      errs.push(`「${t.title || n}」：倒计时模式必须填写限时分钟`);
  });
  return errs;
}

module.exports = { parseHomeworkText, validatePublish, detectSubject };
