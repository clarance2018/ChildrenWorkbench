/* 服务端领域层：任务/草稿/备注/习惯/周期/课表/统计
 * 同时被 REST /api/v1 与 MCP 工具复用，保证两条通道行为一致
 */
const { parseHomeworkText, validatePublish } = require("./parser");

const STATUS = {
  TODO: "未开始", DOING: "进行中", DONE: "孩子已完成", REVIEW: "待复核",
  REJECTED: "已退回", OVERTIME: "超时", EXPIRED: "已过期"
};
const WEEKDAY_CN = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const SUBJECTS = ["语文", "数学", "英语", "音乐", "体育", "美术", "科学", "品德", "习惯", "其他"];
const CATEGORIES = ["学业", "习惯"];
const TIMER_MODES = ["stopwatch", "countdown"];

let seq = 0;
function uid(prefix) { return (prefix || "id") + "_" + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6); }
function pad(n) { return String(n).padStart(2, "0"); }
function fmtDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function todayStr() { return fmtDate(new Date()); }
function addDays(dateStr, n) { const d = new Date(dateStr + "T12:00:00"); d.setDate(d.getDate() + n); return fmtDate(d); }
function weekdayOf(dateStr) { const w = new Date(dateStr + "T12:00:00").getDay(); return w === 0 ? 7 : w; }
function isDateStr(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(new Date(s + "T12:00:00").getTime()); }

function normalizeTask(input, opts) {
  const o = opts || {};
  const date = isDateStr(input.date) ? input.date : (o.date || todayStr());
  const category = CATEGORIES.includes(input.category) ? input.category : "学业";
  const timer_mode = TIMER_MODES.includes(input.timer_mode) ? input.timer_mode : "stopwatch";
  const type = (input.type || (category === "习惯" ? "习惯" : "作业")).toString().slice(0, 12);
  const recDefault = /说|背|读|口述|朗读|背诵/.test(type);
  return {
    id: uid("t"),
    date,
    title: String(input.title || "").trim().slice(0, 80),
    subject: SUBJECTS.includes(input.subject) ? input.subject : (category === "习惯" ? "习惯" : "其他"),
    category,
    type,
    source: input.source || "AI",
    note: String(input.note || "").slice(0, 2000),
    estimated_minutes: input.estimated_minutes != null && input.estimated_minutes !== "" ? clampInt(input.estimated_minutes, 1, 240) : null,
    timer_mode,
    limit_minutes: timer_mode === "countdown" ? clampInt(input.limit_minutes, 1, 180) : null,
    overtime_remind: input.overtime_remind != null ? clampInt(input.overtime_remind, 0, 120) : 5,
    allow_continue: input.allow_continue !== false,
    need_recording: input.need_recording != null ? !!input.need_recording : recDefault,
    star_value: input.star_value != null ? clampInt(input.star_value, 0, 3) : 1,
    period_rule_id: null,
    status: STATUS.TODO,
    actual_seconds: null,
    completed_at: null,
    reviewed_by: null,
    reviewed_at: null,
    star_awarded: 0,
    parent_note: "",
    created_at: new Date().toISOString(),
    created_by: o.created_by || "AI",
    origin: o.origin || "mcp",
    token_id: o.token_id || null
  };
}
function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return null;
  return Math.min(max, Math.max(min, n));
}
function validateTask(t) {
  const errs = [];
  if (!t.title) errs.push("任务标题不能为空");
  if (t.title && t.title.length > 60) errs.push("任务标题过长（≤60 字）");
  if (t.timer_mode === "countdown" && !t.limit_minutes) errs.push("倒计时任务必须设置限时分钟");
  if (t.timer_mode === "countdown" && t.limit_minutes && t.limit_minutes < 1) errs.push("限时分钟需大于 0");
  if (!isDateStr(t.date)) errs.push("日期格式应为 YYYY-MM-DD");
  return errs;
}

function createService({ getState, save, dataDir, storage }) {
  const store = storage;   // 统一存储层（SQLite）

  /* ---------- 草稿队列 ---------- */
  function loadDrafts() {
    const d = store.get("drafts");
    return { batches: (d && d.batches) || [], items: (d && d.items) || [] };
  }
  function saveDrafts(d) {
    store.set("drafts", d);
  }
  function addDraft(task, extra) {
    const d = loadDrafts();
    const item = Object.assign({}, task, {
      id: uid("draft"),
      draft_status: "pending",
      warnings: validateTask(task),
      batch_id: (extra && extra.batch_id) || null,
      need_confirm: !!(extra && extra.need_confirm)
    });
    d.items.push(item);
    saveDrafts(d);
    return item;
  }
  function listDrafts() {
    const d = loadDrafts();
    return {
      batches: d.batches.map(b => Object.assign({}, b, {
        items: d.items.filter(i => i.batch_id === b.id)
      })),
      singles: d.items.filter(i => !i.batch_id)
    };
  }
  function confirmDraft(id, overrides) {
    const d = loadDrafts();
    const idx = d.items.findIndex(i => i.id === id);
    if (idx < 0) return { ok: false, error: "draft_not_found", message: "草稿不存在或已确认" };
    const item = d.items[idx];
    const merged = Object.assign({}, item, overrides || {});
    delete merged.warnings; delete merged.draft_status; delete merged.batch_id; delete merged.need_confirm;
    const task = normalizeTask(merged, { date: item.date, created_by: (item.created_by || "AI") + "（已确认）", origin: "mcp", token_id: item.token_id });
    const errs = validateTask(task);
    if (errs.length) return { ok: false, error: "invalid_task", message: errs.join("；"), details: errs };
    const state = getState();
    state.tasks.push(task);
    const batch = item.batch_id ? d.batches.find(b => b.id === item.batch_id) : null;
    if (batch && batch.note && !(overrides && overrides.__skip_note)) {
      state.notes = state.notes || {};
      const existing = state.notes[batch.date];
      if (!existing || !existing.note) {
        state.notes[batch.date] = {
          note: batch.note, show_to_child: true,
          pinyin_enabled: batch.pinyin_enabled !== false
        };
      }
    }
    d.items.splice(idx, 1);
    if (batch && !d.items.some(i => i.batch_id === batch.id)) {
      d.batches = d.batches.filter(b => b.id !== batch.id);
    }
    saveDrafts(d);
    save();
    return { ok: true, task };
  }
  function confirmBatch(batchId, overrides) {
    const d = loadDrafts();
    const items = d.items.filter(i => i.batch_id === batchId);
    if (!items.length) return { ok: false, error: "batch_not_found", message: "该批次没有待确认任务" };
    const created = [];
    for (const it of items) {
      const r = confirmDraft(it.id, overrides);
      if (r.ok) created.push(r.task);
    }
    return { ok: true, created, count: created.length };
  }
  function discardDraft(id) {
    const d = loadDrafts();
    const item = d.items.find(i => i.id === id);
    if (!item) return { ok: false, error: "draft_not_found" };
    d.items = d.items.filter(i => i.id !== id);
    if (item.batch_id && !d.items.some(i => i.batch_id === item.batch_id)) {
      d.batches = d.batches.filter(b => b.id !== item.batch_id);
    }
    saveDrafts(d);
    return { ok: true };
  }

  /* ---------- 任务 ---------- */
  function listTasks(q) {
    const state = getState();
    const date = q.date && isDateStr(q.date) ? q.date : null;
    return state.tasks.filter(t => {
      if (date && t.date !== date) return false;
      if (!date && q.from && t.date < q.from) return false;
      if (!date && q.to && t.date > q.to) return false;
      if (q.status && t.status !== q.status) return false;
      if (q.category && t.category !== q.category) return false;
      if (q.subject && t.subject !== q.subject) return false;
      return true;
    }).sort((a, b) => (a.date === b.date ? (a.created_at || "").localeCompare(b.created_at || "") : a.date.localeCompare(b.date)));
  }
  function createTask(input, opts) {
    const o = opts || {};
    const task = normalizeTask(input, { date: input.date, created_by: o.created_by, origin: o.origin, token_id: o.token_id });
    const errs = validateTask(task);
    if (errs.length) return { ok: false, error: "invalid_task", message: errs.join("；"), details: errs };
    const publish = o.publish === true;
    if (!publish) {
      const draft = addDraft(task, { batch_id: o.batch_id, need_confirm: !!input.need_confirm });
      return { ok: true, mode: "draft", draft, message: "已生成待确认草稿，家长在后台确认后才会下发给孩子" };
    }
    const state = getState();
    state.tasks.push(task);
    save();
    return { ok: true, mode: "direct", task, message: "任务已发布到孩子端" };
  }
  function patchTask(id, patch) {
    const state = getState();
    const t = state.tasks.find(x => x.id === id);
    if (!t) return { ok: false, error: "task_not_found", message: "任务不存在" };
    const allowed = ["title","subject","category","type","note","estimated_minutes","timer_mode","limit_minutes","overtime_remind","allow_continue","need_recording","star_value","date"];
    for (const k of allowed) {
      if (patch[k] !== undefined) t[k] = patch[k];
    }
    if (t.timer_mode === "countdown") t.limit_minutes = clampInt(t.limit_minutes, 1, 180);
    else t.limit_minutes = null;
    const errs = validateTask(t);
    if (errs.length) return { ok: false, error: "invalid_task", message: errs.join("；") };
    save();
    return { ok: true, task: t };
  }
  function removeTask(id) {
    const state = getState();
    const before = state.tasks.length;
    state.tasks = state.tasks.filter(t => t.id !== id);
    if (state.tasks.length === before) return { ok: false, error: "task_not_found" };
    save();
    return { ok: true };
  }
  function rejectTask(id, reason, reviewer) {
    const state = getState();
    const t = state.tasks.find(x => x.id === id);
    if (!t) return { ok: false, error: "task_not_found", message: "任务不存在" };
    if (!reason || !String(reason).trim()) return { ok: false, error: "reason_required", message: "退回必须填写原因" };
    if (t.star_awarded > 0) {
      state.points.total = Math.max(0, state.points.total - t.star_awarded);
      state.points.log.push({ id: uid("pt"), task_id: id, delta: -t.star_awarded, reason: "revoke_reject", created_at: new Date().toISOString() });
      t.star_awarded = 0;
    }
    (state.recordings[id] || []).forEach(r => { r.rejected = true; });
    t.status = STATUS.REJECTED;
    t.reviewed_by = reviewer || "家长";
    t.reviewed_at = new Date().toISOString();
    t.parent_note = String(reason).slice(0, 200);
    t.completed_at = null;
    save();
    return { ok: true, task: t };
  }

  /* ---------- 备注 ---------- */
  function getNote(date) {
    const state = getState();
    return state.notes[date] || null;
  }
  function setNote(date, body) {
    if (!isDateStr(date)) return { ok: false, error: "bad_date", message: "日期格式应为 YYYY-MM-DD" };
    const state = getState();
    state.notes = state.notes || {};
    const prev = state.notes[date] || { note: "", show_to_child: true, pinyin_enabled: true };
    state.notes[date] = {
      note: body.note != null ? String(body.note).slice(0, 3000) : prev.note,
      show_to_child: body.show_to_child != null ? !!body.show_to_child : prev.show_to_child,
      pinyin_enabled: body.pinyin_enabled != null ? !!body.pinyin_enabled : prev.pinyin_enabled
    };
    save();
    return { ok: true, date, note: state.notes[date] };
  }

  /* ---------- 文本导入 ---------- */
  function importText(body, opts) {
    const o = opts || {};
    const text = String(body.text || "");
    if (text.trim().length < 5) return { ok: false, error: "text_too_short", message: "原文太短，无法解析" };
    if (text.length > 20000) return { ok: false, error: "text_too_long", message: "原文超过 20000 字，请分段导入" };
    const date = isDateStr(body.date) ? body.date : todayStr();
    const parsed = parseHomeworkText(text);
    const batchId = uid("batch");
    const created = [];
    const publish = o.publish === true;
    const state = getState();

    if (!publish) {
      const d = loadDrafts();
      d.batches.push({
        id: batchId, date, raw: text.slice(0, 8000), note: parsed.note,
        pinyin_enabled: body.pinyin_enabled !== false,
        created_at: new Date().toISOString(), token_id: o.token_id || null,
        token_name: o.token_name || "家长后台"
      });
      saveDrafts(d);
    }

    for (const t of parsed.tasks) {
      const input = Object.assign({}, t, {
        date, category: "学业", source: "AI 导入",
        need_recording: t.need_recording, note: t.note || "",
        star_value: 1
      });
      const r = createTask(input, {
        publish, batch_id: batchId, origin: "mcp", created_by: o.created_by || "AI",
        token_id: o.token_id
      });
      if (r.ok) created.push(r.mode === "draft" ? r.draft : r.task);
    }
    if (publish) {
      if (parsed.note) {
        state.notes = state.notes || {};
        if (!state.notes[date] || !state.notes[date].note) {
          state.notes[date] = { note: parsed.note, show_to_child: true, pinyin_enabled: body.pinyin_enabled !== false };
          save();
        }
      }
    }
    return {
      ok: true, mode: publish ? "direct" : "draft", batch_id: batchId, date,
      note: parsed.note,
      tasks: created.map(t => ({ id: t.id, title: t.title, subject: t.subject, type: t.type, need_recording: t.need_recording })),
      uncertain: parsed.uncertain.map(u => u.text),
      message: publish ? "已解析并直接发布" : `已解析出 ${created.length} 条待确认任务，家长确认后下发`
    };
  }

  /* ---------- 习惯 ---------- */
  function listHabits() { return getState().habits || []; }
  function createHabit(body) {
    const name = String(body.name || "").trim();
    if (!name) return { ok: false, error: "name_required", message: "习惯名称不能为空" };
    const state = getState();
    state.habits = state.habits || [];
    const habit = {
      id: uid("habit"), name: name.slice(0, 30),
      icon: String(body.icon || "🧩").slice(0, 4),
      remind_time: /^\d{1,2}:\d{2}$/.test(body.remind_time || "") ? body.remind_time : "20:00",
      weekdays: Array.isArray(body.weekdays) && body.weekdays.length ? body.weekdays.map(Number).filter(n => n >= 1 && n <= 7) : [1, 2, 3, 4, 5, 6, 7],
      need_photo: !!body.need_photo,
      need_review: false,
      star_enabled: body.star_enabled !== false,
      linked_timetable: !!body.linked_timetable,
      checklist: Array.isArray(body.checklist) ? body.checklist.map(s => String(s).slice(0, 40)).slice(0, 8) : [],
      active: true,
      created_at: new Date().toISOString(),
      origin: "mcp"
    };
    state.habits.push(habit);
    save();
    return { ok: true, habit };
  }

  /* ---------- 周期规则 ---------- */
  function listPeriodRules() { return getState().periodRules || []; }
  function createPeriodRule(body) {
    const tpl = body.template || body;
    const title = String(tpl.title || "").trim();
    if (!title) return { ok: false, error: "title_required", message: "周期任务需要标题" };
    const freq = ["daily", "weekly", "once"].includes(body.freq) ? body.freq : "daily";
    if (freq === "weekly" && !(Array.isArray(body.weekdays) && body.weekdays.length)) {
      return { ok: false, error: "weekdays_required", message: "每周模式至少选择一天" };
    }
    const state = getState();
    const rule = {
      id: uid("rule"), freq,
      weekdays: freq === "weekly" ? body.weekdays.map(Number).filter(n => n >= 1 && n <= 7) : null,
      start_date: isDateStr(body.start_date) ? body.start_date : todayStr(),
      end_date: isDateStr(body.end_date) ? body.end_date : null,
      active: true,
      template: {
        title: title.slice(0, 60),
        subject: SUBJECTS.includes(tpl.subject) ? tpl.subject : "其他",
        category: tpl.category === "习惯" ? "习惯" : "学业",
        type: String(tpl.type || "作业").slice(0, 12),
        source: "AI 周期", note: String(tpl.note || "").slice(0, 1000),
        estimated_minutes: tpl.estimated_minutes != null ? clampInt(tpl.estimated_minutes, 1, 240) : null,
        timer_mode: TIMER_MODES.includes(tpl.timer_mode) ? tpl.timer_mode : "stopwatch",
        limit_minutes: tpl.timer_mode === "countdown" ? clampInt(tpl.limit_minutes, 1, 180) : null,
        overtime_remind: tpl.overtime_remind != null ? clampInt(tpl.overtime_remind, 0, 120) : 5,
        allow_continue: tpl.allow_continue !== false,
        need_recording: !!tpl.need_recording,
        star_value: tpl.star_value != null ? clampInt(tpl.star_value, 0, 3) : 1,
        created_by: "AI"
      },
      created_at: new Date().toISOString(),
      origin: "mcp"
    };
    state.periodRules.push(rule);
    // 若规则今天生效，立即补一条实例，避免要等客户端刷新
    const today = todayStr(), w = weekdayOf(today);
    const applies = (!rule.start_date || today >= rule.start_date) && (!rule.end_date || today <= rule.end_date) &&
      (rule.freq !== "weekly" || rule.weekdays.includes(w)) && (rule.freq !== "once" || rule.start_date === today);
    if (applies && !state.tasks.some(t => t.period_rule_id === rule.id && t.date === today)) {
      const task = normalizeTask(Object.assign({}, rule.template, { date: today, source: "周期生成" }), { created_by: "AI", origin: "mcp" });
      task.period_rule_id = rule.id;
      state.tasks.push(task);
    }
    save();
    return { ok: true, rule };
  }

  /* ---------- 课表 ---------- */
  function getTimetable(date) {
    if (!isDateStr(date)) return { ok: false, error: "bad_date", message: "日期格式应为 YYYY-MM-DD" };
    const state = getState();
    const override = state.timetableOverrides[date];
    const base = state.timetable[weekdayOf(date)] || { subjects: [], notes: "" };
    return {
      ok: true, date, weekday: weekdayOf(date), weekday_cn: WEEKDAY_CN[weekdayOf(date)],
      subjects: (override || base).subjects || [], notes: (override || base).notes || "",
      is_override: !!override,
      tomorrow: (() => {
        const t = addDays(date, 1), o = state.timetableOverrides[t], b = state.timetable[weekdayOf(t)] || {};
        return { date: t, weekday_cn: WEEKDAY_CN[weekdayOf(t)], subjects: (o || b).subjects || [], notes: (o || b).notes || "" };
      })()
    };
  }
  function setTimetableWeekday(weekday, body) {
    const w = Number(weekday);
    if (!(w >= 1 && w <= 7)) return { ok: false, error: "bad_weekday", message: "星期应为 1-7" };
    const state = getState();
    state.timetable[w] = {
      subjects: Array.isArray(body.subjects) ? body.subjects.map(s => String(s).slice(0, 10)).slice(0, 10) : [],
      notes: String(body.notes || "").slice(0, 200)
    };
    save();
    return { ok: true, weekday: w, timetable: state.timetable[w] };
  }
  function setTimetableOverride(date, body) {
    if (!isDateStr(date)) return { ok: false, error: "bad_date" };
    const state = getState();
    state.timetableOverrides[date] = {
      subjects: Array.isArray(body.subjects) ? body.subjects.map(s => String(s).slice(0, 10)).slice(0, 10) : [],
      notes: String(body.notes || "").slice(0, 200)
    };
    save();
    return { ok: true, date, timetable: state.timetableOverrides[date] };
  }

  /* ---------- 统计 ---------- */
  function getProgress(date) {
    const day = isDateStr(date) ? date : todayStr();
    const state = getState();
    const tasks = state.tasks.filter(t => t.date === day && t.status !== STATUS.EXPIRED);
    const done = tasks.filter(t => t.status === STATUS.DONE);
    const minutes = tasks.reduce((s, t) => s + (t.actual_seconds || 0), 0) / 60;
    const bySubject = {};
    tasks.forEach(t => {
      const k = t.subject || "其他";
      bySubject[k] = bySubject[k] || { total: 0, done: 0, minutes: 0 };
      bySubject[k].total++;
      if (t.status === STATUS.DONE) bySubject[k].done++;
      bySubject[k].minutes += Math.round((t.actual_seconds || 0) / 60);
    });
    return {
      ok: true, date: day, weekday_cn: WEEKDAY_CN[weekdayOf(day)],
      total: tasks.length, done: done.length,
      completion_rate: tasks.length ? Math.round(done.length / tasks.length * 100) : 0,
      minutes: Math.round(minutes),
      stars: tasks.reduce((s, t) => s + (t.star_awarded || 0), 0),
      streak_days: state.streak.days || 0,
      points_total: state.points.total || 0,
      overtime: tasks.filter(t => t.timer_mode === "countdown" && t.actual_seconds && t.limit_minutes && t.actual_seconds > t.limit_minutes * 60).length,
      pending: tasks.filter(t => t.status === STATUS.DONE || t.status === STATUS.REVIEW).length,
      tasks: tasks.map(t => ({
        id: t.id, title: t.title, subject: t.subject, category: t.category, status: t.status,
        minutes: t.actual_seconds ? Math.round(t.actual_seconds / 60) : null,
        star_awarded: t.star_awarded || 0, parent_note: t.parent_note || "",
        recordings: (state.recordings[t.id] || []).length
      })),
      by_subject: bySubject,
      note: (state.notes[day] && state.notes[day].note) || ""
    };
  }
  function getWeeklyReport(start) {
    const end = todayStr();
    const startDate = isDateStr(start) ? start : addDays(end, -6);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(startDate, i);
      if (d > end) break;
      const p = getProgress(d);
      days.push({ date: d, weekday_cn: p.weekday_cn, total: p.total, done: p.done, rate: p.completion_rate, minutes: p.minutes, overtime: p.overtime });
    }
    const total = days.reduce((s, d) => s + d.total, 0);
    const done = days.reduce((s, d) => s + d.done, 0);
    const st = getState();
    const mistakes = (st.mistakes || []).filter(m => !m.archived);
    const newMistakes = (st.mistakes || []).filter(m => (m.created_at || "").slice(0, 10) >= startDate);
    return {
      ok: true, start: startDate, end,
      total, done, completion_rate: total ? Math.round(done / total * 100) : 0,
      minutes: days.reduce((s, d) => s + d.minutes, 0),
      overtime: days.reduce((s, d) => s + d.overtime, 0),
      days,
      /* 供 AI 生成个体化建议的补充上下文 */
      child: st.child || null,
      points: {
        earned_total: (st.points && st.points.earned_total) || 0,
        available: (st.points && st.points.total) || 0,
        week_stars: ((st.points && st.points.log) || []).filter(l => l.delta > 0 && (l.created_at || "").slice(0, 10) >= startDate).reduce((s, l) => s + l.delta, 0)
      },
      streak_days: (st.streak && st.streak.days) || 0,
      rejected_this_week: (st.tasks || []).filter(t => t.status === "孩子已退回" || t.status === "已退回").filter(t => t.date >= startDate && t.date <= end).length,
      mistakes: { open: mistakes.length, new_this_week: newMistakes.length, samples: mistakes.slice(0, 8).map(m => ({ title: m.title, subject: m.subject, mastered_count: m.mastered_count || 0 })) },
      redemptions: { pending: (st.redemptions || []).filter(r => r.status === "pending").length },
      goal: (st.settings && st.settings.goals) || null,
      advice_hint: "请基于以上数据给家长 3 条建议：先肯定具体进步，再指出一个最值得改进的点，语气避免说教。孩子为一年级学生。"
    };
  }

  /* ---------- 操作注册表（REST 与 MCP 桥接共用） ---------- */
  const ops = [
    { id: "tasks.list", method: "GET", path: "/api/v1/tasks", scope: "tasks:read", summary: "按日期/状态/类别查询任务",
      params: [{ name: "date", in: "query", type: "string", desc: "YYYY-MM-DD，缺省为全部" }, { name: "status", in: "query", type: "string", desc: "未开始/进行中/孩子已完成/已退回/超时/已过期" }, { name: "category", in: "query", type: "string", desc: "学业 或 习惯" }],
      run: a => ({ ok: true, tasks: listTasks(a) }) },
    { id: "tasks.get", method: "GET", path: "/api/v1/tasks/:id", scope: "tasks:read", summary: "查询单个任务",
      params: [{ name: "id", in: "path", type: "string", required: true, desc: "任务 ID" }],
      run: a => { const t = getState().tasks.find(x => x.id === a.id); return t ? { ok: true, task: t } : { ok: false, error: "task_not_found" }; } },
    { id: "tasks.create", method: "POST", path: "/api/v1/tasks", scope: "tasks:write", summary: "创建一条任务（草稿 Token 进待确认队列）",
      params: [{ name: "title", in: "body", type: "string", required: true, desc: "任务标题" }, { name: "subject", in: "body", type: "string", desc: "语文/数学/英语..." }, { name: "category", in: "body", type: "string", desc: "学业 或 习惯" }, { name: "date", in: "body", type: "string", desc: "YYYY-MM-DD，缺省今天" }, { name: "type", in: "body", type: "string", desc: "口述/背诵/朗读/书写/计算/练习" }, { name: "timer_mode", in: "body", type: "string", desc: "stopwatch 或 countdown" }, { name: "limit_minutes", in: "body", type: "number", desc: "倒计时分钟" }, { name: "need_recording", in: "body", type: "boolean", desc: "是否需要录音" }, { name: "estimated_minutes", in: "body", type: "number", desc: "预计时长" }, { name: "star_value", in: "body", type: "number", desc: "星星 0-3" }],
      run: (a, ctx) => createTask(a, { publish: canPublish(ctx), origin: "mcp", created_by: "AI", token_id: ctx.token && ctx.token.id }) },
    { id: "tasks.batch_create", method: "POST", path: "/api/v1/tasks/batch", scope: "tasks:write", summary: "批量创建任务（≤20 条）",
      params: [{ name: "tasks", in: "body", type: "array", required: true, desc: "任务对象数组，字段同 tasks.create" }],
      run: (a, ctx) => {
        if (!Array.isArray(a.tasks) || !a.tasks.length) return { ok: false, error: "tasks_required" };
        if (a.tasks.length > 20) return { ok: false, error: "too_many_tasks", message: "单次最多 20 条" };
        const results = a.tasks.map(t => createTask(t, { publish: canPublish(ctx), origin: "mcp", created_by: "AI", token_id: ctx.token && ctx.token.id }));
        return { ok: true, mode: canPublish(ctx) ? "direct" : "draft", results };
      } },
    { id: "tasks.update", method: "PATCH", path: "/api/v1/tasks/:id", scope: "tasks:write", summary: "修改任务字段",
      params: [{ name: "id", in: "path", type: "string", required: true, desc: "任务 ID" }],
      run: a => patchTask(a.id, a) },
    { id: "tasks.delete", method: "DELETE", path: "/api/v1/tasks/:id", scope: "tasks:write", summary: "删除任务",
      params: [{ name: "id", in: "path", type: "string", required: true, desc: "任务 ID" }],
      run: a => removeTask(a.id) },
    { id: "tasks.reject", method: "POST", path: "/api/v1/tasks/:id/reject", scope: "review:write", summary: "退回任务并撤销星星",
      params: [{ name: "id", in: "path", type: "string", required: true, desc: "任务 ID" }, { name: "reason", in: "body", type: "string", required: true, desc: "退回原因，会显示给孩子" }],
      run: (a, ctx) => rejectTask(a.id, a.reason, ctx.token ? ctx.token.name : "家长") },

    { id: "drafts.list", method: "GET", path: "/api/v1/drafts", scope: "tasks:read", summary: "列出待确认草稿", params: [], run: () => ({ ok: true, drafts: listDrafts() }) },
    { id: "drafts.confirm", method: "POST", path: "/api/v1/drafts/:id/confirm", scope: "tasks:write", summary: "确认单条草稿并下发",
      params: [{ name: "id", in: "path", type: "string", required: true, desc: "草稿 ID" }], run: a => confirmDraft(a.id, a) },
    { id: "drafts.confirm_batch", method: "POST", path: "/api/v1/drafts/batch/:batchId/confirm", scope: "tasks:write", summary: "整批确认草稿",
      params: [{ name: "batchId", in: "path", type: "string", required: true, desc: "批次 ID" }], run: a => confirmBatch(a.batchId) },
    { id: "drafts.discard", method: "DELETE", path: "/api/v1/drafts/:id", scope: "tasks:write", summary: "丢弃草稿",
      params: [{ name: "id", in: "path", type: "string", required: true, desc: "草稿 ID" }], run: a => discardDraft(a.id) },

    { id: "notes.get", method: "GET", path: "/api/v1/notes/:date", scope: "notes:read", summary: "查询某天备注",
      params: [{ name: "date", in: "path", type: "string", required: true, desc: "YYYY-MM-DD" }], run: a => ({ ok: true, date: a.date, note: getNote(a.date) }) },
    { id: "notes.set", method: "PUT", path: "/api/v1/notes/:date", scope: "notes:write", summary: "设置某天备注（学习内容/学习重点）",
      params: [{ name: "date", in: "path", type: "string", required: true, desc: "YYYY-MM-DD" }, { name: "note", in: "body", type: "string", required: true, desc: "备注内容" }, { name: "show_to_child", in: "body", type: "boolean", desc: "是否显示给孩子" }, { name: "pinyin_enabled", in: "body", type: "boolean", desc: "一年级注音" }],
      run: a => setNote(a.date, a) },

    { id: "habits.list", method: "GET", path: "/api/v1/habits", scope: "habits:read", summary: "列出习惯任务", params: [], run: () => ({ ok: true, habits: listHabits() }) },
    { id: "habits.create", method: "POST", path: "/api/v1/habits", scope: "habits:write", summary: "新建习惯任务",
      params: [{ name: "name", in: "body", type: "string", required: true, desc: "习惯名称" }, { name: "remind_time", in: "body", type: "string", desc: "HH:MM" }, { name: "weekdays", in: "body", type: "array", desc: "1-7" }, { name: "checklist", in: "body", type: "array", desc: "检查清单" }],
      run: a => createHabit(a) },

    { id: "periods.list", method: "GET", path: "/api/v1/period-rules", scope: "tasks:read", summary: "列出周期规则", params: [], run: () => ({ ok: true, rules: listPeriodRules() }) },
    { id: "periods.create", method: "POST", path: "/api/v1/period-rules", scope: "tasks:write", summary: "创建周期任务规则",
      params: [{ name: "freq", in: "body", type: "string", desc: "daily/weekly/once" }, { name: "weekdays", in: "body", type: "array", desc: "weekly 时的星期列表" }, { name: "template", in: "body", type: "object", desc: "任务模板字段同 tasks.create" }],
      run: a => createPeriodRule(a) },

    { id: "timetable.get", method: "GET", path: "/api/v1/timetable/:date", scope: "timetable:read", summary: "查询某天课表（含明日课表）",
      params: [{ name: "date", in: "path", type: "string", required: true, desc: "YYYY-MM-DD" }], run: a => getTimetable(a.date) },
    { id: "timetable.set_weekday", method: "PUT", path: "/api/v1/timetable/weekday/:weekday", scope: "timetable:write", summary: "设置固定周课表",
      params: [{ name: "weekday", in: "path", type: "number", required: true, desc: "1-7" }, { name: "subjects", in: "body", type: "array", desc: "科目列表" }, { name: "notes", in: "body", type: "string", desc: "备注，如 美术带彩笔" }],
      run: a => setTimetableWeekday(a.weekday, a) },
    { id: "timetable.override", method: "PUT", path: "/api/v1/timetable/override/:date", scope: "timetable:write", summary: "临时调课",
      params: [{ name: "date", in: "path", type: "string", required: true, desc: "YYYY-MM-DD" }, { name: "subjects", in: "body", type: "array", desc: "科目列表" }],
      run: a => setTimetableOverride(a.date, a) },

    { id: "progress.get", method: "GET", path: "/api/v1/progress", scope: "report:read", summary: "查询某天完成情况与用时",
      params: [{ name: "date", in: "query", type: "string", desc: "YYYY-MM-DD，缺省今天" }], run: a => getProgress(a.date) },
    { id: "report.weekly", method: "GET", path: "/api/v1/report/weekly", scope: "report:read", summary: "近 7 天完成率与用时",
      params: [{ name: "start", in: "query", type: "string", desc: "开始日期，缺省 6 天前" }], run: a => getWeeklyReport(a.start) },

    { id: "rewards.list", method: "GET", path: "/api/v1/rewards", scope: "report:read", summary: "列出兑换商城奖品（供回答“星星能换什么”）",
      params: [],
      run: () => ({ ok: true, rewards: (getState().rewards || []).filter(r => !r._removed).map(r => ({ id: r.id, name: r.name, icon: r.icon, cost: r.cost, desc: r.desc, active: r.active !== false })) }) },
    { id: "redemptions.list", method: "GET", path: "/api/v1/redemptions", scope: "report:read", summary: "列出兑换申请（ pending 待确认 / fulfilled 已兑现 / denied 已拒绝）",
      params: [{ name: "status", in: "query", type: "string", desc: "pending/fulfilled/denied，缺省全部" }],
      run: a => {
        let list = (getState().redemptions || []).slice().sort((x, y) => (y.requested_at || "").localeCompare(x.requested_at || ""));
        if (a.status) list = list.filter(r => r.status === a.status);
        return { ok: true, count: list.length, redemptions: list.slice(0, 50) };
      } },
    { id: "mistakes.list", method: "GET", path: "/api/v1/mistakes", scope: "report:read", summary: "列出错题本（做对 2 次自动归档）",
      params: [{ name: "archived", in: "query", type: "string", desc: "true 只看已归档 / false 只看未归档，缺省全部" }, { name: "subject", in: "query", type: "string", desc: "按科目筛选" }],
      run: a => {
        let list = (getState().mistakes || []).slice();
        if (a.archived === "true") list = list.filter(m => m.archived);
        else if (a.archived === "false") list = list.filter(m => !m.archived);
        if (a.subject) list = list.filter(m => m.subject === a.subject);
        list.sort((x, y) => (y.created_at || "").localeCompare(x.created_at || ""));
        return { ok: true, count: list.length, mistakes: list.slice(0, 100).map(m => ({ id: m.id, title: m.title, subject: m.subject, reason: m.reason, mastered_count: m.mastered_count || 0, archived: !!m.archived, created_at: m.created_at })) };
      } },
    { id: "templates.list", method: "GET", path: "/api/v1/templates", scope: "tasks:read", summary: "列出家长收藏的常用任务模板",
      params: [],
      run: () => ({ ok: true, templates: (getState().templates || []).map(t => ({ id: t.id, title: t.title, subject: t.subject, category: t.category, type: t.type, estimated_minutes: t.estimated_minutes, star_value: t.star_value })) }) },
    { id: "penalties.list", method: "GET", path: "/api/v1/penalties", scope: "report:read", summary: "列出做错事时的扣分记录（含必填原因、孩子是否已读）",
      params: [{ name: "unread", in: "query", type: "string", desc: "true 只看孩子未读，缺省全部" }],
      run: a => {
        let list = ((getState().points || {}).log || []).filter(e => e && (e.kind === "penalty" || e.reason === "penalty"));
        if (a.unread === "true") list = list.filter(e => !e.seen_at);
        list = list.slice().sort((x, y) => (y.created_at || "").localeCompare(x.created_at || ""));
        return { ok: true, count: list.length, penalties: list.slice(0, 100).map(e => ({ id: e.id, amount: Math.abs(Number(e.delta) || 0), reason: e.note || "", by: e.by || "", date: e.date || "", seen: !!e.seen_at, created_at: e.created_at })) };
      } },

    { id: "import.text", method: "POST", path: "/api/v1/import", scope: "import:write", summary: "解析老师原文，生成备注与待确认任务",
      params: [{ name: "text", in: "body", type: "string", required: true, desc: "老师发的原文" }, { name: "date", in: "body", type: "string", desc: "作业日期，缺省今天" }],
      run: (a, ctx) => importText(a, { publish: canPublish(ctx), token_id: ctx.token && ctx.token.id, token_name: ctx.token && ctx.token.name }) }
  ];

  function canPublish(ctx) {
    return !!(ctx && ctx.token && ctx.token.mode === "direct");
  }

  function findOp(method, pathname) {
    for (const op of ops) {
      if (op.method !== method) continue;
      const opParts = op.path.split("/");
      const pParts = pathname.split("/");
      if (opParts.length !== pParts.length) continue;
      const params = {};
      let matched = true;
      for (let i = 0; i < opParts.length; i++) {
        if (opParts[i].startsWith(":")) params[opParts[i].slice(1)] = decodeURIComponent(pParts[i]);
        else if (opParts[i] !== pParts[i]) { matched = false; break; }
      }
      if (matched) return { op, params };
    }
    return null;
  }

  return {
    STATUS, ops, findOp, canPublish,
    listTasks, createTask, patchTask, removeTask, rejectTask,
    listDrafts, confirmDraft, confirmBatch, discardDraft,
    getNote, setNote, importText,
    listHabits, createHabit, listPeriodRules, createPeriodRule,
    getTimetable, setTimetableWeekday, setTimetableOverride,
    getProgress, getWeeklyReport
  };
}

module.exports = { createService, STATUS, todayStr, weekdayOf, normalizeTask, validateTask, isDateStr };
