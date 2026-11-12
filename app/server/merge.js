/* 状态合并：把"整包覆盖"改成"按实体合并"
 * 规则：
 *  1) 每个实体带 updated_at，同一实体取更新时间较新的一份（LWW）
 *  2) 一处新增、另一处没有 → 保留（不会因快照陈旧而丢任务）
 *  3) 删除写入墓碑 state.deleted，墓碑优先于实体，防止旧快照把任务"复活"
 *  4) points.total 由积分流水重算，避免两端各自累加造成重复计分
 */

const COLLECTIONS = ["tasks", "periodRules", "habits", "templates", "encouragements", "rewards", "mistakes"];
/* redemptions 单独处理：孩子端允许新增 pending 申请，但不允许孩子伪造"已兑现/已拒绝" */
const TOMB_TTL = 45 * 86400000;

const ts = x => {
  const t = Date.parse((x && (x.updated_at || x.created_at)) || 0);
  return isNaN(t) ? 0 : t;
};
const byId = list => new Map((list || []).filter(x => x && x.id).map(x => [x.id, x]));

function mergeTombs(prev, next) {
  const m = new Map();
  [...(prev || []), ...(next || [])].forEach(d => {
    if (!d || !d.id) return;
    const at = Date.parse(d.at || 0) || 0;
    if (m.get(d.id) == null || at > m.get(d.id)) m.set(d.id, at);
  });
  const cutoff = Date.now() - TOMB_TTL;
  return [...m.entries()].filter(([, at]) => at > cutoff).map(([id, at]) => ({ id, at: new Date(at).toISOString() }));
}

function mergeList(prevList, nextList, tombMap, allowFromNext = true) {
  const prev = byId(prevList), next = byId(nextList);
  const out = [];
  const ids = new Set([...prev.keys(), ...next.keys()]);
  ids.forEach(id => {
    const p = prev.get(id), n = next.get(id);
    const tombAt = tombMap.get(id) || 0;
    const candidate = !n ? p : !p ? (allowFromNext ? n : null) : (ts(n) >= ts(p) ? n : p);
    if (!candidate) return;
    /* 墓碑比实体更新 → 视为已删除 */
    if (tombAt && tombAt >= ts(candidate)) return;
    out.push(candidate);
  });
  return out;
}

function mergeRecordings(prevMap, nextMap, tombMap) {
  const out = {};
  const keys = new Set([...Object.keys(prevMap || {}), ...Object.keys(nextMap || {})]);
  keys.forEach(k => {
    if (tombMap.has(k)) return;
    const p = (prevMap && prevMap[k]) || [], n = (nextMap && nextMap[k]) || [];
    const m = new Map();
    p.forEach(r => r && r.id && m.set(r.id, r));
    n.forEach(r => {
      if (!r || !r.id) return;
      const old = m.get(r.id);
      if (!old) return void m.set(r.id, r);
      /* 退回标记只增不减，避免一端不知道退回而把标记擦掉 */
      m.set(r.id, Object.assign({}, old, r, { rejected: !!(old.rejected || r.rejected) }));
    });
    const list = [...m.values()].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    if (list.length) out[k] = list;
  });
  return out;
}

function mergePoints(prev, next, scope) {
  const p = prev || {}, n = next || {};
  const log = new Map();
  [...(p.log || []), ...(n.log || [])].forEach(e => { if (e && e.id) log.set(e.id, e); });
  const isPenalty = e => e && (e.kind === "penalty" || e.reason === "penalty");
  if (scope === "child") {
    /* 孩子端不允许新增/篡改扣分记录（防止自行抹掉原因或伪造扣分）；
     * 唯一放行的写入是「标记已读」seen_at，其余字段一律以服务端为准 */
    const prevById = byId(p.log);
    [...log.entries()].forEach(([id, e]) => {
      if (!isPenalty(e)) return;
      const base = prevById.get(id);
      if (!base) return void log.delete(id);
      log.set(id, Object.assign({}, base, { seen_at: e.seen_at || base.seen_at || null }));
    });
  }
  const entries = [...log.values()].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  const sum = entries.reduce((s, e) => s + (Number(e.delta) || 0), 0);
  /* 累计获得按正向流水重算：扣分/兑换均为负 delta，不影响徽章等级 */
  const earned = entries.reduce((s, e) => s + Math.max(0, Number(e.delta) || 0), 0);
  return { total: Math.max(0, sum), earned_total: earned, log: entries };
}

function mergeStreak(prev, next) {
  const p = prev || { days: 0, lastDate: null }, n = next || { days: 0, lastDate: null };
  if (!p.lastDate) return n;
  if (!n.lastDate) return p;
  if (p.lastDate === n.lastDate) return { days: Math.max(p.days || 0, n.days || 0), lastDate: p.lastDate };
  return n.lastDate > p.lastDate ? n : p;
}

function mergeRedemptions(prevList, nextList, tombMap, scope) {
  /* 孩子端净化：只接受「新增的 pending 申请」和「仍是 pending 的字段更新」；
   * 已被家长决定的兑换（fulfilled/denied）一律以服务端为准 */
  const prev = byId(prevList);
  let next = nextList || [];
  if (scope === "child") {
    next = next.filter(r => {
      if (!r || !r.id) return false;
      const p = prev.get(r.id);
      if (!p) return r.status === "pending";
      if (p.status !== "pending") return false;
      return true;
    });
  }
  const merged = mergeList(prevList, next, tombMap, true);   // 允许新增（孩子申请）
  if (scope === "child") {
    /* 双保险：孩子提交的实体一律压回 pending，决定字段只认服务端 */
    merged.forEach(r => {
      const p = prev.get(r.id);
      if (!p) { r.status = "pending"; r.decided_at = null; r.decided_by = null; }
    });
  }
  return merged;
}

/**
 * @param prev 服务端当前状态
 * @param next 客户端提交状态
 * @param scope "parent" 全量；"child" 仅允许改任务执行相关字段
 */
function mergeStates(prev, next, scope = "parent") {
  if (!prev) return next;
  if (!next || typeof next !== "object") return prev;

  const deleted = mergeTombs(prev.deleted, next.deleted);
  const tombMap = new Map(deleted.map(d => [d.id, Date.parse(d.at)]));

  const out = Object.assign({}, prev, next);
  out.deleted = deleted;

  COLLECTIONS.forEach(k => {
    const allowNew = scope === "parent";
    out[k] = mergeList(prev[k], next[k], tombMap, allowNew);
  });
  out.redemptions = mergeRedemptions(prev.redemptions, next.redemptions, tombMap, scope);

  out.recordings = mergeRecordings(prev.recordings, next.recordings, tombMap);
  out.notes = Object.assign({}, prev.notes || {}, next.notes || {});

  if (scope === "child") {
    /* 孩子设备只允许写执行结果，班级/设置类字段一律沿用服务端；
     * 例外：settings.goals（存星愿望）是孩子自己的字段，放行 */
    const goals = next && next.settings && next.settings.goals !== undefined ? next.settings.goals : null;
    out.settings = Object.assign({}, prev.settings || {});
    if (goals !== null) out.settings.goals = goals;
    out.child = prev.child;
    out.timetable = prev.timetable;
    out.vacationTimetable = prev.vacationTimetable;
    /* 标准课表网格（课段/节次 × 7 天）属于家长配置，孩子设备不得回写覆盖 */
    out.timetableGrid = prev.timetableGrid;
    out.vacationTimetableGrid = prev.vacationTimetableGrid;
    out.timetableOverrides = prev.timetableOverrides;
    out.periodRules = prev.periodRules;
    out.habits = prev.habits;
    out.templates = prev.templates;
    out.rewards = prev.rewards;
    out.mistakes = prev.mistakes;
  } else {
    out.timetable = Object.assign({}, prev.timetable || {}, next.timetable || {});
    out.timetableOverrides = Object.assign({}, prev.timetableOverrides || {}, next.timetableOverrides || {});
    /* 网格按整体取较新的一份：客户端提交时若没带（旧版本）则保留服务端已有网格 */
    out.timetableGrid = (next.timetableGrid && next.timetableGrid.rows) ? next.timetableGrid : prev.timetableGrid;
    out.vacationTimetableGrid = (next.vacationTimetableGrid && next.vacationTimetableGrid.rows) ? next.vacationTimetableGrid : prev.vacationTimetableGrid;
    out.settings = Object.assign({}, prev.settings || {}, next.settings || {});
    out.child = Object.assign({}, prev.child || {}, next.child || {});
    /* PIN 只认服务端哈希文件，客户端提交的 parent_pin 一律不采纳 */
    if (prev.settings && "parent_pin" in prev.settings) out.settings.parent_pin = prev.settings.parent_pin;
    else if (out.settings) delete out.settings.parent_pin;
  }

  out.points = mergePoints(prev.points, next.points, scope);
  out.streak = mergeStreak(prev.streak, next.streak);
  return out;
}

module.exports = { mergeStates, COLLECTIONS };
